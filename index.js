const LOG = '[Liquid UI]';
const CHAT_SEL = '#chat';
const LAST_MES_SEL = '.last_mes';
const MES_TEXT_SEL = '.mes_text';
const STREAMING_CLS = 'liquid-streaming-active';
const OVERLAY_CLS = 'liquid-panel-overlay';
const NEW_MES_TIMEOUT = 1200;

const L_PANEL = ['#left-menu', '.side-panel.left', '[data-panel="left"]'];
const R_PANEL = ['#right-menu', '.side-panel.right', '[data-panel="right"]'];
const L_TOGGLE = ['.menu_button', '[data-panel-toggle="left"]', '.menu-button'];
const R_TOGGLE = ['.right_menu_button', '[data-panel-toggle="right"]', '.character-button'];

const STREAM_EVENTS = ['variant_stream_start', 'stream_start', 'message_stream_start', 'text_stream_start'];

const POPUP_SEL = [
    '.popup', '.wide_dialogue_popup', '#dialogue_popup', '.ui-dialog',
    '.modal', '.drawer-content', '#past_chats_modal', '.list-group',
    '.flex-container', '.dialog', '.st-modal', '.st-dialog',
    '#WorldInfo', '#char_settings'
].join(', ');

const INTERACT_SEL = [
    'button', '.menu_button', '.right_menu_button', '.list-group-item',
    'a', 'input[type="button"]', 'input[type="submit"]', 'input[type="checkbox"]',
    'input[type="radio"]', 'select', '.avatar', '.mes_text', '.ch_name',
    '[role="button"]', '.expression-item', '.drag-handle', '.liquid-pressable',
    '.extensionsMenuUpdateIndicator', '.header-button',
    '.interactable', '.recentChat'
].join(', ');

const G = /** @type {any} */ (globalThis);
const idle = G.requestIdleCallback || ((cb, opts = {}) => setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), opts.timeout ?? 1));
const cancelIdle = G.cancelIdleCallback || (id => clearTimeout(id));
const defer = G.queueMicrotask ? cb => G.queueMicrotask(cb) : cb => Promise.resolve().then(cb);
const ROOT = document.documentElement;
const OPEN_PANEL_CLS = ['open', 'active', 'show', 'is-open', 'drawer-open'];
const MES_SEL = `.mes, ${LAST_MES_SEL}`;
const REVEAL_TAGS = new Set(['SPAN', 'EM', 'STRONG', 'CODE', 'A', 'B', 'I', 'U', 'S', 'MARK', 'SUB', 'SUP']);
const CLOSING_CLS = new Set(['is-closing', 'is-switching-out']);

function qFirst(sels, root = document) {
    for (const s of sels) { try { const e = root.querySelector(s); if (e) return e; } catch { } }
    return null;
}

function qAll(sels, root = document) {
    const r = [], seen = new Set();
    for (const s of sels) { try { root.querySelectorAll(s).forEach(e => { if (!seen.has(e)) { seen.add(e); r.push(e); } }); } catch { } }
    return r;
}

function markNewMessage(el) {
    if (!(el instanceof HTMLElement)) return;
    if (el.dataset.liquidNew === '1') return;
    el.dataset.liquidNew = '1';
    el.classList.add('liquid-mes-new');
    setTimeout(() => { el.classList.remove('liquid-mes-new'); }, NEW_MES_TIMEOUT);
}


class PerformanceGuard {
    constructor() {
        this.ft = [];
        this.max = 30;
        this.last = 0;
        this.sum = 0;
        this.on = false;
        this.tier = 'full';
        this.raf = 0;
    }

    start() {
        if (this.on) return;
        this.on = true;
        this.ft.length = 0;
        this.sum = 0;
        this.last = performance.now();
        this._t();
    }

    _t() {
        if (!this.on) return;
        this.raf = requestAnimationFrame(now => {
            const delta = now - this.last;
            this.last = now;
            this.ft.push(delta);
            this.sum += delta;
            if (this.ft.length > this.max) this.sum -= this.ft.shift();
            if (this.ft.length >= this.max) {
                this._check(this.sum / this.ft.length);
            }
            this._t();
        });
    }

    _check(avg) {
        let t = 'full';
        if (avg >= 33) t = 'critical';
        else if (avg >= 25) t = 'medium';
        else if (avg >= 20) t = 'low';
        if (t === this.tier) return;
        const root = ROOT;
        root.classList.remove('liquid-perf-low', 'liquid-perf-medium', 'liquid-perf-critical');
        if (t !== 'full') {
            root.classList.add(`liquid-perf-${t}`);
            if (t === 'medium') root.classList.add('liquid-perf-low');
            if (t === 'critical') root.classList.add('liquid-perf-low', 'liquid-perf-medium');
        }
        this.tier = t;
    }

    stop() { this.on = false; if (this.raf) cancelAnimationFrame(this.raf); }
}


class StreamRevealEngine {
    constructor() {
        this.obs = null;
        this.resObs = null;
        this.streaming = false;
        this.mes = null;
        this.text = null;
        this.timer = null;
        this.prevLen = 0;
        this.chat = null;
        this.spans = new WeakSet();
        this.growNodes = new Set();
        this.growTask = 0;
        this.stateRaf = 0;
        this.revealRaf = 0;
        this.revealIdle = 0;
        this.scrollRaf = 0;
        this.reduceMotion = !!G.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    }

    init() {
        this.chat = document.querySelector(CHAT_SEL);
        if (!this.chat) return;

        this.obs = new MutationObserver(muts => {
            let cursorUpd = false, textChg = false;
            const chat = this.chat;
            const text = this.text;
            const streaming = this.streaming;
            for (const m of muts) {
                if (m.addedNodes?.length) {
                    for (const n of m.addedNodes) this._queueGrown(n);
                }
                if (!cursorUpd && chat && (m.type === 'characterData' || m.type === 'childList')) {
                    if (m.target === chat || chat.contains(m.target)) cursorUpd = true;
                }
                if (!textChg && streaming && text && (m.type === 'characterData' || m.type === 'childList')) {
                    if (m.target === text || text.contains(m.target)) textChg = true;
                }
            }
            if (cursorUpd) this._queueState();
            if (textChg) this._queueReveal();
        });
        this.obs.observe(document.body, { childList: true, subtree: true, characterData: true });

        this.resObs = new ResizeObserver(() => {
            if (this.streaming && this.chat) this._queueScroll();
        });
        this.resObs.observe(this.chat);
    }

    _queueGrown(node) {
        if (!(node instanceof HTMLElement)) return;
        this.growNodes.add(node);
        if (this.growTask) return;
        this.growTask = 1;
        defer(() => {
            this.growTask = 0;
            if (!this.growNodes.size) return;
            const nodes = Array.from(this.growNodes);
            this.growNodes.clear();
            for (const n of nodes) handleGrown(n);
        });
    }

    updateState() {
        if (!this.chat) return;
        const last = this.chat.querySelector(LAST_MES_SEL);
        if (!last) return;
        const txt = last.querySelector(MES_TEXT_SEL);
        if (!txt) return;
        if (this.mes && this.mes !== last) this.mes.classList.remove('liquid-streaming');
        if (this.text && this.text !== txt) { this.text.classList.remove('liquid-cursor'); this._clean(this.text); }
        if (this.mes !== last || this.text !== txt) this.prevLen = 0;
        this.mes = last;
        this.text = txt;
        last.classList.add('liquid-streaming');
        txt.classList.add('liquid-cursor');
        this.chat.classList.add(STREAMING_CLS);
        this.streaming = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this._end(), 800);
    }

    _queueState() {
        if (this.stateRaf) return;
        this.stateRaf = requestAnimationFrame(() => {
            this.stateRaf = 0;
            this.updateState();
        });
    }

    _queueReveal() {
        if (this.revealRaf) return;
        this.revealRaf = requestAnimationFrame(() => {
            this.revealRaf = 0;
            this._reveal();
        });
    }

    _queueScroll() {
        if (this.scrollRaf) return;
        this.scrollRaf = requestAnimationFrame(() => {
            this.scrollRaf = 0;
            this._scroll();
        });
    }

    _reveal() {
        if (!this.text) return;
        const len = (this.text.textContent || '').length;
        if (len <= this.prevLen) { this.prevLen = len; return; }
        if (!this.revealIdle) {
            this.revealIdle = idle(() => {
                this.revealIdle = 0;
                if (this.text) this._wrap(this.text);
            }, { timeout: 120 });
        }
        this.prevLen = len;
    }

    _wrap(c) {
        if (!c) return;
        const spans = this.spans;
        const walker = document.createTreeWalker(c, NodeFilter.SHOW_ELEMENT, {
            acceptNode(n) {
                if (n.classList?.contains('liquid-char-reveal')) return NodeFilter.FILTER_SKIP;
                if (n.tagName === 'BR') return NodeFilter.FILTER_SKIP;
                return REVEAL_TAGS.has(n.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
        });
        const els = [];
        let n;
        while ((n = walker.nextNode())) { if (!spans.has(n) && !n.closest('.liquid-char-reveal')) els.push(n); }
        for (const ch of c.childNodes) {
            if (ch.nodeType === Node.TEXT_NODE) {
                const text = ch.textContent;
                if (!text || !/\S/.test(text)) continue;
                const s = document.createElement('span');
                s.className = 'liquid-char-reveal';
                ch.parentNode.insertBefore(s, ch);
                s.appendChild(ch);
                spans.add(s);
            }
        }
        for (const e of els) { if (e.parentNode && !e.classList.contains('liquid-char-reveal')) { e.classList.add('liquid-char-reveal'); spans.add(e); } }
    }

    _scroll() {
        if (!this.chat) return;
        const { scrollHeight, scrollTop, clientHeight } = this.chat;
        const d = scrollHeight - scrollTop - clientHeight;
        if (d < 150) {
            const root = ROOT;
            const cl = root.classList;
            const lowPerf = cl.contains('liquid-perf-medium') || cl.contains('liquid-perf-critical');
            const behavior = (this.reduceMotion || lowPerf) ? 'auto' : 'smooth';
            this.chat.scrollTo({ top: scrollHeight, behavior });
        }
    }

    _end() {
        if (this.revealIdle) { cancelIdle(this.revealIdle); this.revealIdle = 0; }
        if (this.revealRaf) { cancelAnimationFrame(this.revealRaf); this.revealRaf = 0; }
        if (this.mes) this.mes.classList.remove('liquid-streaming');
        if (this.text) { this.text.classList.remove('liquid-cursor'); setTimeout(() => this._clean(this.text), 350); }
        if (this.chat) this.chat.classList.remove(STREAMING_CLS);
        this.streaming = false;
        this.mes = null;
        this.text = null;
        this.prevLen = 0;
    }

    _clean(c) {
        if (!c) return;
        idle(() => {
            const spans = c.querySelectorAll('.liquid-char-reveal');
            const len = spans.length;
            if (!len) return;
            for (let i = 0; i < len; i++) {
                const s = spans[i];
                s.classList.remove('liquid-char-reveal');
                s.style.animation = 'none';
            }
        });
    }

    destroy() {
        this.obs?.disconnect();
        this.resObs?.disconnect();
        if (this.timer) clearTimeout(this.timer);
        if (this.stateRaf) cancelAnimationFrame(this.stateRaf);
        if (this.revealRaf) cancelAnimationFrame(this.revealRaf);
        if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
        if (this.revealIdle) cancelIdle(this.revealIdle);
        this.growNodes.clear();
        this.growTask = 0;
    }
}


class RubberBandController {
    constructor() {
        this.chat = null;
        this.active = false;
        this.offset = 0;
        this.touchY = 0;
        this.velocity = 0;
        this.raf = 0;
        this.wheelTimer = 0;
        this.applyRaf = 0;
        this.fns = [];
    }

    init() {
        this.chat = document.querySelector(CHAT_SEL);
        if (!this.chat) return;
        const w = e => this._wheel(e);
        const ts = e => { if (e.touches.length) this.touchY = e.touches[0].clientY; };
        const tm = e => this._touchMove(e);
        const te = () => this._release();
        this.chat.addEventListener('wheel', w, { passive: false });
        this.chat.addEventListener('touchstart', ts, { passive: true });
        this.chat.addEventListener('touchmove', tm, { passive: false });
        this.chat.addEventListener('touchend', te, { passive: true });
        this.chat.addEventListener('touchcancel', te, { passive: true });
        this.fns.push(() => { this.chat?.removeEventListener('wheel', w); this.chat?.removeEventListener('touchstart', ts); this.chat?.removeEventListener('touchmove', tm); this.chat?.removeEventListener('touchend', te); this.chat?.removeEventListener('touchcancel', te); });
    }

    _atTop() { return this.chat && this.chat.scrollTop <= 0; }
    _atBot() { return this.chat && this.chat.scrollTop + this.chat.clientHeight >= this.chat.scrollHeight - 1; }
    _rubber(o) { const s = o > 0 ? 1 : -1; return s * (Math.abs(o) * 0.4) / (1 + Math.abs(o) * 0.003); }

    _wheel(e) {
        if (!this.chat) return;
        if ((e.deltaY < 0 && this._atTop()) || (e.deltaY > 0 && this._atBot())) {
            e.preventDefault();
            this.offset += e.deltaY * 0.5;
            this._queueApply();
            clearTimeout(this.wheelTimer);
            this.wheelTimer = setTimeout(() => this._release(), 100);
        }
    }

    _touchMove(e) {
        if (!this.chat || !e.touches.length) return;
        const dy = this.touchY - e.touches[0].clientY;
        this.touchY = e.touches[0].clientY;
        if ((dy < 0 && this._atTop()) || (dy > 0 && this._atBot())) {
            e.preventDefault();
            this.offset += dy;
            this._queueApply();
        }
    }

    _queueApply() {
        if (this.applyRaf) return;
        this.applyRaf = requestAnimationFrame(() => {
            this.applyRaf = 0;
            this._apply();
        });
    }

    _apply() {
        if (!this.active) {
            this.active = true;
            this.chat.classList.add('liquid-rubber-band');
            this.chat.style.willChange = 'transform';
        }
        this.chat.style.transform = `translate3d(0, ${-this._rubber(this.offset)}px, 0)`;
    }

    _release() {
        if (!this.active) return;
        this.velocity = 0;
        if (this.raf) cancelAnimationFrame(this.raf);
        if (this.applyRaf) { cancelAnimationFrame(this.applyRaf); this.applyRaf = 0; }
        const tick = () => {
            const f = -0.15 * this.offset;
            this.velocity = (this.velocity + f) * 0.75;
            this.offset += this.velocity;
            if (Math.abs(this.offset) < 0.5 && Math.abs(this.velocity) < 0.5) {
                this.offset = 0; this.velocity = 0; this.active = false;
                this.chat.style.transform = '';
                this.chat.style.willChange = '';
                this.chat.classList.remove('liquid-rubber-band');
                return;
            }
            this.chat.style.transform = `translate3d(0, ${-this._rubber(this.offset)}px, 0)`;
            this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
    }

    destroy() {
        if (this.raf) cancelAnimationFrame(this.raf);
        if (this.applyRaf) cancelAnimationFrame(this.applyRaf);
        if (this.chat) this.chat.style.willChange = '';
        this.fns.forEach(f => { try { f(); } catch { } });
    }
}


class BlurController {
    constructor() {
        this.raf = 0;
        this.cur = 0;
        this.tgt = 0;
        this.vel = 0;
        this.reduceMotion = !!G.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    }

    set(p) {
        if (p === this.tgt && (this.raf || this.cur === p)) return;
        this.tgt = p;
        if (this.reduceMotion || ROOT.classList.contains('liquid-perf-critical')) {
            this.cur = this.tgt;
            ROOT.style.setProperty('--liquid-blur-progress', String(this.cur));
            if (this.raf) cancelAnimationFrame(this.raf);
            this.raf = 0;
            return;
        }
        if (!this.raf) this._go();
    }

    _go() {
        this.vel = (this.vel + 0.08 * (this.tgt - this.cur)) * 0.7;
        this.cur += this.vel;
        if (this.cur < 0.001) this.cur = 0;
        if (this.cur > 0.999) this.cur = 1;
        ROOT.style.setProperty('--liquid-blur-progress', String(this.cur));
        if (Math.abs(this.cur - this.tgt) > 0.001 || Math.abs(this.vel) > 0.001) {
            this.raf = requestAnimationFrame(() => this._go());
        } else {
            this.cur = this.tgt;
            ROOT.style.setProperty('--liquid-blur-progress', String(this.cur));
            this.raf = 0;
        }
    }

    destroy() { if (this.raf) cancelAnimationFrame(this.raf); }
}


class PanelManager {
    constructor(blur) {
        this.ok = false;
        this.lp = null;
        this.rp = null;
        this.chat = null;
        this.ov = null;
        this.lb = [];
        this.rb = [];
        this.uiState = { lo: null, ro: null };
        this.fns = [];
        this.obs = [];
        this.blur = blur;
    }

    init() {
        this.chat = document.querySelector(CHAT_SEL);
        this.lp = qFirst(L_PANEL);
        this.rp = qFirst(R_PANEL);
        if (!this.lp && !this.rp) return false;
        this.ov = this._overlay();
        this._enhance(this.lp, 'left');
        this._enhance(this.rp, 'right');
        this._toggles();
        this._closeBinds();
        this._observe();
        this._ui();
        this.ok = true;
        return true;
    }

    _overlay() {
        let o = document.querySelector(`.${OVERLAY_CLS}`);
        if (o) return o;
        o = document.createElement('div');
        o.className = `panel-overlay ${OVERLAY_CLS}`;
        o.dataset.liquidOwned = '1';
        document.body.appendChild(o);
        return o;
    }

    _enhance(p, side) {
        if (!(p instanceof HTMLElement)) return;
        p.classList.add('liquid-side-panel', side === 'left' ? 'liquid-left' : 'liquid-right');
        if (side === 'right') {
            const av = qFirst(['.character-avatar', '.avatar', 'img'], p);
            if (av) av.classList.add('liquid-character-avatar');
            qAll(['.info-row', '.card', '.ch_name', '.stat-card'], p).slice(0, 15).forEach((item, i) => {
                if (!item.classList.contains('liquid-info-item')) {
                    item.classList.add('liquid-info-item');
                    item.style.setProperty('--liquid-stagger', `${180 + i * 35}ms`);
                }
            });
        }
    }

    _toggles() {
        this.lb = qAll(L_TOGGLE).filter(e => !(this.lp?.contains(e) || this.rp?.contains(e)));
        this.rb = qAll(R_TOGGLE).filter(e => !(this.lp?.contains(e) || this.rp?.contains(e)));
        const hl = () => this.toggle('left');
        const hr = () => this.toggle('right');
        this.lb.forEach(b => { b.classList.add('liquid-panel-toggle-left'); b.addEventListener('click', hl); this.fns.push(() => b.removeEventListener('click', hl)); });
        this.rb.forEach(b => { b.classList.add('liquid-panel-toggle-right'); b.addEventListener('click', hr); this.fns.push(() => b.removeEventListener('click', hr)); });
    }

    _closeBinds() {
        if (this.ov) { const c = () => this.close(); this.ov.addEventListener('click', c); this.fns.push(() => this.ov?.removeEventListener('click', c)); }
        if (this.chat) {
            const c = e => {
                if (!this._isOpen(this.lp) && !this._isOpen(this.rp)) return;
                if (!e.target || e.target.closest('a, button, input, textarea, select')) return;
                if (this.lp?.contains(e.target) || this.rp?.contains(e.target)) return;
                this.close();
            };
            this.chat.addEventListener('click', c, { passive: true });
            this.fns.push(() => this.chat?.removeEventListener('click', c));
        }
        const esc = e => { if (e.key === 'Escape') this.close(); };
        document.addEventListener('keydown', esc);
        this.fns.push(() => document.removeEventListener('keydown', esc));
    }

    _observe() {
        [this.lp, this.rp].forEach(p => {
            if (!(p instanceof HTMLElement)) return;
            const o = new MutationObserver(() => this._ui());
            o.observe(p, { attributes: true, attributeFilter: ['class', 'open', 'style'] });
            this.obs.push(o);
        });
    }

    _isOpen(p) {
        if (!(p instanceof HTMLElement)) return false;
        const cl = p.classList;
        for (const c of CLOSING_CLS) { if (cl.contains(c)) return false; }
        if (p.hasAttribute('open')) return true;
        for (const c of OPEN_PANEL_CLS) { if (cl.contains(c)) return true; }
        const parent = p.parentElement;
        if (parent) { for (const c of OPEN_PANEL_CLS) { if (parent.classList.contains(c)) return true; } }
        return false;
    }

    open(side) {
        const tgt = side === 'left' ? this.lp : this.rp;
        const oth = side === 'left' ? this.rp : this.lp;
        if (!tgt) return;
        if (oth && this._isOpen(oth)) {
            oth.classList.remove('is-open', 'open', 'active', 'show');
            oth.removeAttribute('open');
            oth.classList.add('is-switching-out');
            setTimeout(() => oth.classList.remove('is-switching-out'), 280);
        }
        tgt.classList.remove('is-closing', 'is-switching-out');
        tgt.classList.add('is-open');
        this.blur.set(1);
        this._ui();
    }

    close() {
        [this.lp, this.rp].forEach(p => {
            if (!this._isOpen(p)) return;
            p.classList.remove('is-open', 'open', 'active', 'show');
            p.removeAttribute('open');
            p.classList.add('is-closing');
            setTimeout(() => p.classList.remove('is-closing'), 280);
        });
        this.blur.set(0);
        this._ui();
    }

    toggle(side) {
        const t = side === 'left' ? this.lp : this.rp;
        if (!t) return;
        this._isOpen(t) ? this.close() : this.open(side);
    }

    _ui() {
        const r = ROOT;
        const lo = this._isOpen(this.lp), ro = this._isOpen(this.rp);
        if (this.uiState.lo === lo && this.uiState.ro === ro) return;
        this.uiState.lo = lo;
        this.uiState.ro = ro;
        r.classList.toggle('liquid-left-open', lo && !ro);
        r.classList.toggle('liquid-right-open', ro && !lo);
        r.classList.toggle('liquid-both-open', lo && ro);
        if (this.ov) this.ov.classList.toggle('active', lo || ro);
        if (this.chat) {
            this.chat.classList.remove('when-left-open', 'when-right-open', 'when-both-open');
            if (lo && ro) this.chat.classList.add('when-both-open');
            else if (lo) this.chat.classList.add('when-left-open');
            else if (ro) this.chat.classList.add('when-right-open');
        }
        this.lb.forEach(b => b.classList.toggle('is-active', lo && !ro));
        this.rb.forEach(b => b.classList.toggle('is-active', ro && !lo));
    }

    destroy() {
        this.fns.forEach(f => { try { f(); } catch { } });
        this.obs.forEach(o => o.disconnect());
        if (this.ov?.dataset.liquidOwned) this.ov.remove();
    }
}


class ClickManager {
    constructor() { this.el = null; this.ty = 0; this.tx = 0; this.fns = []; this._bind(); }

    _bind() {
        const d = e => this._down(e);
        const u = () => this._up();
        const m = e => this._move(e);
        document.body.addEventListener('mousedown', d);
        document.body.addEventListener('touchstart', d, { passive: true });
        document.body.addEventListener('mouseup', u);
        document.body.addEventListener('touchend', u);
        document.body.addEventListener('touchcancel', u);
        document.body.addEventListener('touchmove', m, { passive: true });
        this.fns.push(() => { document.body.removeEventListener('mousedown', d); document.body.removeEventListener('touchstart', d); document.body.removeEventListener('mouseup', u); document.body.removeEventListener('touchend', u); document.body.removeEventListener('touchcancel', u); document.body.removeEventListener('touchmove', m); });
    }

    _target(t) { return (t instanceof Element) ? t.closest(INTERACT_SEL) : null; }

    _down(e) {
        if (e.button && e.button !== 0) return;
        const t = this._target(e.target);
        if (!t) return;
        if (e.type === 'touchstart' && e.touches?.length) { this.ty = e.touches[0].clientY; this.tx = e.touches[0].clientX; }
        if (!t.classList.contains('liquid-pressable')) t.classList.add('liquid-pressable');
        this.el = t;
        t.classList.add('liquid-pressed');
        if (t.classList.contains('recentChat') || t.closest?.('.recentChat')) {
            const card = t.classList.contains('recentChat') ? t : t.closest('.recentChat');
            this._ripple(card, e);
        }
    }

    _move(e) {
        if (!this.el || !e.touches?.length) return;
        if (Math.abs(e.touches[0].clientX - this.tx) > 10 || Math.abs(e.touches[0].clientY - this.ty) > 10) this._up();
    }

    _up() { if (this.el) { this.el.classList.remove('liquid-pressed'); this.el = null; } }

    _ripple(card, e) {
        if (!card) return;
        const r = card.getBoundingClientRect();
        const x = (e.touches?.length ? e.touches[0].clientX : e.clientX || 0) - r.left;
        const y = (e.touches?.length ? e.touches[0].clientY : e.clientY || 0) - r.top;
        const sz = Math.max(r.width, r.height) * 1.5;
        const rip = document.createElement('span');
        rip.className = 'liquid-ripple';
        rip.style.cssText = `width:${sz}px;height:${sz}px;left:${x - sz / 2}px;top:${y - sz / 2}px;`;
        card.appendChild(rip);
        rip.addEventListener('animationend', () => rip.remove(), { once: true });
    }

    destroy() { this.fns.forEach(f => { try { f(); } catch { } }); }
}


class PageTransition {
    constructor() {
        this.scrim = null;
        this.ghost = null;
        this.busy = false;
        this.fns = [];
        this.reduceMotion = !!G.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    }

    init() {
        const fn = e => {
            const card = e.target?.closest?.('.recentChat');
            if (!card || this.busy) return;
            if (e.target?.closest?.('.pinChat, .renameChat, .deleteChat, .recentChatActions')) return;
            this._run(card);
        };
        document.addEventListener('click', fn, true);
        this.fns.push(() => document.removeEventListener('click', fn, true));
    }

    _run(card) {
        const root = ROOT;
        if (this.reduceMotion || root.classList.contains('liquid-perf-critical')) return;
        this.busy = true;
        const cardRect = card.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        this.scrim = document.createElement('div');
        this.scrim.className = 'liquid-page-scrim';
        document.body.appendChild(this.scrim);

        this.ghost = document.createElement('div');
        this.ghost.className = 'liquid-page-ghost';

        const inner = document.createElement('div');
        inner.className = 'liquid-ghost-inner';
        const name = card.querySelector('strong, .ch_name, .recentChatName');
        const prev = card.querySelector('.recentChatPreview, .mes_text, div:last-child');

        const contentScaleInv = document.createElement('div');
        contentScaleInv.className = 'liquid-ghost-content-inv';

        if (name) {
            const d = document.createElement('div');
            d.style.cssText = 'font-weight:600;font-size:15px;margin-bottom:4px;color:#f0f0f0;';
            d.textContent = name.textContent;
            contentScaleInv.appendChild(d);
        }
        if (prev && prev !== name) {
            const d = document.createElement('div');
            d.style.cssText = 'font-size:13px;color:#999;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            d.textContent = (prev.textContent || '').substring(0, 100);
            contentScaleInv.appendChild(d);
        }

        inner.appendChild(contentScaleInv);
        this.ghost.appendChild(inner);

        const shine = document.createElement('div');
        shine.className = 'liquid-ghost-shine';
        this.ghost.appendChild(shine);

        const sx = cardRect.width / vw;
        const sy = cardRect.height / vh;
        const cx = cardRect.left + cardRect.width / 2;
        const cy = cardRect.top + cardRect.height / 2;
        const dx = cx - vw / 2;
        const dy = cy - vh / 2;

        this.ghost.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
        this.ghost.style.borderRadius = `${16 / sx}px / ${16 / sy}px`;
        this.ghost.style.opacity = '1';

        contentScaleInv.style.transform = `scale(${1 / sx}, ${1 / sy})`;
        contentScaleInv.style.transformOrigin = 'top left';
        contentScaleInv.style.width = `${vw}px`;
        contentScaleInv.style.height = `${vh}px`;

        document.body.appendChild(this.ghost);

        this.ghost.offsetHeight; // force reflow

        requestAnimationFrame(() => {
            root.classList.add('liquid-page-active');
            requestAnimationFrame(() => root.classList.add('liquid-page-shrunk'));
            this.scrim.classList.add('active');

            // Expand phase
            this.ghost.style.transform = 'translate(0px, 0px) scale(1, 1)';
            this.ghost.style.borderRadius = '0px';
            contentScaleInv.style.transform = 'scale(1, 1)';

            this.ghost.classList.add('expanded');
        });

        setTimeout(() => this._exit(), 430);
    }

    _exit() {
        const root = ROOT;
        if (this.ghost) this.ghost.classList.add('out');
        if (this.scrim) this.scrim.classList.add('out');
        root.classList.remove('liquid-page-shrunk');

        setTimeout(() => {
            this.scrim?.remove();
            this.ghost?.remove();
            this.scrim = null;
            this.ghost = null;
            root.classList.remove('liquid-page-active');
            this.busy = false;
        }, 350);
    }

    destroy() {
        this.scrim?.remove();
        this.ghost?.remove();
        ROOT.classList.remove('liquid-page-active', 'liquid-page-shrunk');
        this.fns.forEach(f => { try { f(); } catch { } });
    }
}


function handleGrown(node) {
    if (!(node instanceof HTMLElement)) return;
    const cl = node.classList;
    if (cl.contains('liquid-popup-entrance') || cl.contains('apple-entrance')) return;
    if (node.matches?.(POPUP_SEL)) {
        cl.add('liquid-popup-entrance');
    } else {
        const popups = node.querySelectorAll(POPUP_SEL);
        for (let i = 0, len = popups.length; i < len; i++) popups[i].classList.add('liquid-popup-entrance');
    }
    if (node.matches?.('.mes') || node.matches?.(LAST_MES_SEL)) {
        cl.add('apple-entrance');
        markNewMessage(node);
    } else {
        const msgs = node.querySelectorAll(MES_SEL);
        for (let i = 0, len = msgs.length; i < len; i++) {
            msgs[i].classList.add('apple-entrance');
            markNewMessage(msgs[i]);
        }
    }
}


const state = { perf: null, stream: null, rubber: null, blur: null, panel: null, click: null, page: null, on: false };


function boot() {
    if (state.on) return;
    ROOT.classList.add('liquid-ui-enabled');
    state.perf = new PerformanceGuard();
    state.perf.start();
    state.click = new ClickManager();
    state.blur = new BlurController();
    const pm = new PanelManager(state.blur);
    if (pm.init()) state.panel = pm;
    else { let r = 0; const i = setInterval(() => { r++; if (pm.init() || r > 60) { state.panel = pm; clearInterval(i); } }, 500); }
    state.stream = new StreamRevealEngine();
    state.stream.init();
    state.rubber = new RubberBandController();
    state.rubber.init();
    state.page = new PageTransition();
    state.page.init();
    STREAM_EVENTS.forEach(n => {
        const es = G.eventSource;
        if (es && typeof es.on === 'function') es.on(n, () => state.stream?.updateState());
        document.addEventListener(n, () => state.stream?.updateState());
    });
    state.on = true;
    console.info(LOG, 'booted');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
