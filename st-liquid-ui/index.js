const LOG = '[Liquid UI]';
const CHAT_SEL = '#chat';
const LAST_MES_SEL = '.last_mes';
const MES_TEXT_SEL = '.mes_text';
const STREAMING_CLS = 'liquid-streaming-active';
const OVERLAY_CLS = 'liquid-panel-overlay';

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

function qFirst(sels, root = document) {
    for (const s of sels) { try { const e = root.querySelector(s); if (e) return e; } catch {} }
    return null;
}

function qAll(sels, root = document) {
    const r = [], seen = new Set();
    for (const s of sels) { try { root.querySelectorAll(s).forEach(e => { if (!seen.has(e)) { seen.add(e); r.push(e); } }); } catch {} }
    return r;
}


class PerformanceGuard {
    constructor() {
        this.ft = [];
        this.max = 30;
        this.last = 0;
        this.on = false;
        this.tier = 'full';
        this.raf = 0;
    }

    start() {
        if (this.on) return;
        this.on = true;
        this.last = performance.now();
        this._t();
    }

    _t() {
        if (!this.on) return;
        this.raf = requestAnimationFrame(now => {
            this.ft.push(now - this.last);
            this.last = now;
            if (this.ft.length > this.max) this.ft.shift();
            if (this.ft.length >= this.max) {
                this._check(this.ft.reduce((a, b) => a + b, 0) / this.ft.length);
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
        const root = document.documentElement;
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
    }

    init() {
        this.chat = document.querySelector(CHAT_SEL);
        if (!this.chat) return;

        this.obs = new MutationObserver(muts => {
            let cursorUpd = false, textChg = false;
            for (const m of muts) {
                for (const n of m.addedNodes) handleGrown(n);
                if (this.streaming && this.text) {
                    if (m.type === 'characterData' && this.text.contains(m.target)) textChg = true;
                    if (m.type === 'childList' && (this.text.contains(m.target) || m.target === this.text)) textChg = true;
                }
                if (m.type === 'characterData' || (m.type === 'childList' && m.target.closest?.(CHAT_SEL))) cursorUpd = true;
            }
            if (cursorUpd) this.updateState();
            if (textChg) this._reveal();
        });
        this.obs.observe(document.body, { childList: true, subtree: true, characterData: true });

        this.resObs = new ResizeObserver(() => {
            if (this.streaming && this.chat) this._scroll();
        });
        this.resObs.observe(this.chat);
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

    _reveal() {
        if (!this.text) return;
        const len = (this.text.textContent || '').length;
        if (len <= this.prevLen) { this.prevLen = len; return; }
        requestIdleCallback(() => this._wrap(this.text));
        this.prevLen = len;
    }

    _wrap(c) {
        if (!c) return;
        const walker = document.createTreeWalker(c, NodeFilter.SHOW_ELEMENT, {
            acceptNode(n) {
                if (n.classList?.contains('liquid-char-reveal')) return NodeFilter.FILTER_SKIP;
                if (n.tagName === 'BR') return NodeFilter.FILTER_SKIP;
                const tags = ['SPAN', 'EM', 'STRONG', 'CODE', 'A', 'B', 'I', 'U', 'S', 'MARK', 'SUB', 'SUP'];
                return (tags.includes(n.tagName) && !n.classList?.contains('liquid-char-reveal')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
        });
        const els = [];
        let n;
        while ((n = walker.nextNode())) { if (!this.spans.has(n) && !n.closest('.liquid-char-reveal')) els.push(n); }
        for (const ch of c.childNodes) {
            if (ch.nodeType === Node.TEXT_NODE && ch.textContent.trim().length > 0 && !this.spans.has(ch)) {
                const s = document.createElement('span');
                s.className = 'liquid-char-reveal';
                ch.parentNode.insertBefore(s, ch);
                s.appendChild(ch);
                this.spans.add(s);
            }
        }
        for (const e of els) { if (e.parentNode && !e.classList.contains('liquid-char-reveal')) { e.classList.add('liquid-char-reveal'); this.spans.add(e); } }
    }

    _scroll() {
        if (!this.chat) return;
        const d = this.chat.scrollHeight - this.chat.scrollTop - this.chat.clientHeight;
        if (d < 150) this.chat.scrollTo({ top: this.chat.scrollHeight, behavior: 'smooth' });
    }

    _end() {
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
        requestIdleCallback(() => {
            c.querySelectorAll('.liquid-char-reveal').forEach(s => { s.classList.remove('liquid-char-reveal'); s.style.animation = 'none'; });
        });
    }

    destroy() {
        this.obs?.disconnect();
        this.resObs?.disconnect();
        if (this.timer) clearTimeout(this.timer);
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
            this._apply();
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
            this._apply();
        }
    }

    _apply() {
        if (!this.active) { this.active = true; this.chat.classList.add('liquid-rubber-band'); }
        this.chat.style.transform = `translateY(${-this._rubber(this.offset)}px) translateZ(0)`;
    }

    _release() {
        if (!this.active) return;
        this.velocity = 0;
        if (this.raf) cancelAnimationFrame(this.raf);
        const tick = () => {
            const f = -0.15 * this.offset;
            this.velocity = (this.velocity + f) * 0.75;
            this.offset += this.velocity;
            if (Math.abs(this.offset) < 0.5 && Math.abs(this.velocity) < 0.5) {
                this.offset = 0; this.velocity = 0; this.active = false;
                this.chat.style.transform = '';
                this.chat.classList.remove('liquid-rubber-band');
                return;
            }
            this.chat.style.transform = `translateY(${-this._rubber(this.offset)}px) translateZ(0)`;
            this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
    }

    destroy() { if (this.raf) cancelAnimationFrame(this.raf); this.fns.forEach(f => { try { f(); } catch {} }); }
}


class BlurController {
    constructor() { this.raf = 0; this.cur = 0; this.tgt = 0; this.vel = 0; }

    set(p) { this.tgt = p; if (!this.raf) this._go(); }

    _go() {
        this.vel = (this.vel + 0.08 * (this.tgt - this.cur)) * 0.7;
        this.cur += this.vel;
        if (this.cur < 0.001) this.cur = 0;
        if (this.cur > 0.999) this.cur = 1;
        document.documentElement.style.setProperty('--liquid-blur-progress', String(this.cur));
        if (Math.abs(this.cur - this.tgt) > 0.001 || Math.abs(this.vel) > 0.001) {
            this.raf = requestAnimationFrame(() => this._go());
        } else {
            this.cur = this.tgt;
            document.documentElement.style.setProperty('--liquid-blur-progress', String(this.cur));
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
        if (cl.contains('is-closing') || cl.contains('is-switching-out')) return false;
        if (['open', 'active', 'show', 'is-open', 'drawer-open'].some(c => cl.contains(c)) || p.hasAttribute('open')) return true;
        if (window.getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().width > 0) {
            const t = window.getComputedStyle(p).transform;
            if (cl.contains('liquid-left') && t.includes('-100')) return false;
            if (['open', 'active', 'show', 'is-open', 'drawer-open'].some(c => p.parentElement?.classList.contains(c))) return true;
        }
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
        const r = document.documentElement;
        const lo = this._isOpen(this.lp), ro = this._isOpen(this.rp);
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
        this.fns.forEach(f => { try { f(); } catch {} });
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

    destroy() { this.fns.forEach(f => { try { f(); } catch {} }); }
}


class PageTransition {
    constructor() { this.scrim = null; this.ghost = null; this.busy = false; this.fns = []; }

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
        this.busy = true;
        const cardRect = card.getBoundingClientRect();
        const root = document.documentElement;
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
        if (name) {
            const d = document.createElement('div');
            d.style.cssText = 'font-weight:600;font-size:15px;margin-bottom:4px;color:#f0f0f0;';
            d.textContent = name.textContent;
            inner.appendChild(d);
        }
        if (prev && prev !== name) {
            const d = document.createElement('div');
            d.style.cssText = 'font-size:13px;color:#999;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            d.textContent = (prev.textContent || '').substring(0, 100);
            inner.appendChild(d);
        }
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
        this.ghost.style.borderRadius = `${12 / sx}px / ${12 / sy}px`;
        this.ghost.style.opacity = '1';
        document.body.appendChild(this.ghost);

        this.ghost.offsetHeight;

        requestAnimationFrame(() => {
            root.classList.add('liquid-page-active');
            requestAnimationFrame(() => root.classList.add('liquid-page-shrunk'));
            this.scrim.classList.add('active');
            this.ghost.classList.add('expanded');
        });

        setTimeout(() => this._exit(), 520);
    }

    _exit() {
        const root = document.documentElement;
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
        document.documentElement.classList.remove('liquid-page-active', 'liquid-page-shrunk');
        this.fns.forEach(f => { try { f(); } catch {} });
    }
}


function handleGrown(node) {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches?.(POPUP_SEL)) {
        if (!node.classList.contains('liquid-popup-entrance')) node.classList.add('liquid-popup-entrance');
    } else {
        node.querySelectorAll?.(POPUP_SEL)?.forEach(p => { if (!p.classList.contains('liquid-popup-entrance')) p.classList.add('liquid-popup-entrance'); });
    }
    if (node.matches?.('.mes') || node.matches?.(LAST_MES_SEL)) {
        if (!node.classList.contains('apple-entrance')) node.classList.add('apple-entrance');
    } else {
        node.querySelectorAll?.('.mes, ' + LAST_MES_SEL)?.forEach(n => { if (!n.classList.contains('apple-entrance')) n.classList.add('apple-entrance'); });
    }
}


const state = { perf: null, stream: null, rubber: null, blur: null, panel: null, click: null, page: null, on: false };

function boot() {
    if (state.on) return;
    document.documentElement.classList.add('liquid-ui-enabled');
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
