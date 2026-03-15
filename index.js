const LOG = '[Liquid UI]';
const CHAT_SEL = '#chat';
const LAST_MES_SEL = '.last_mes';
const MES_TEXT_SEL = '.mes_text';
const STREAMING_CLS = 'liquid-streaming-active';

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
                // 创建双层结构：外层保持位置，内层做动画
                const outer = document.createElement('span');
                outer.className = 'liquid-char-reveal';
                const inner = document.createElement('span');
                inner.className = 'liquid-char-inner';
                inner.textContent = text;
                outer.appendChild(inner);
                ch.parentNode.insertBefore(outer, ch);
                ch.remove();
                spans.add(outer);
            }
        }
        for (const e of els) { if (e.parentNode && !e.classList.contains('liquid-char-reveal')) { e.classList.add('liquid-char-reveal'); spans.add(e); } }
    }

    _scroll() {
        if (!this.chat) return;
        const { scrollHeight, scrollTop, clientHeight } = this.chat;
        const d = scrollHeight - scrollTop - clientHeight;
        if (d < 150) {
            const behavior = this.reduceMotion ? 'auto' : 'smooth';
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


class PanelManager {
    constructor() {
        this.ok = false;
        this.lp = null;
        this.rp = null;
        this.chat = null;
        this.lb = [];
        this.rb = [];
        this.uiState = { lo: null, ro: null };
        this.fns = [];
        this.obs = [];
    }

    init() {
        this.chat = document.querySelector(CHAT_SEL);
        this.lp = qFirst(L_PANEL);
        this.rp = qFirst(R_PANEL);
        if (!this.lp && !this.rp) return false;
        this._enhance(this.lp, 'left');
        this._enhance(this.rp, 'right');
        this._toggles();
        this._closeBinds();
        this._observe();
        this._ui();
        this.ok = true;
        return true;
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
            setTimeout(() => oth.classList.remove('is-switching-out'), 300);
        }
        tgt.classList.remove('is-closing', 'is-switching-out');
        tgt.classList.add('is-open');
        this._ui();
    }

    close() {
        [this.lp, this.rp].forEach(p => {
            if (!this._isOpen(p)) return;
            p.classList.remove('is-open', 'open', 'active', 'show');
            p.removeAttribute('open');
            p.classList.add('is-closing');
            setTimeout(() => p.classList.remove('is-closing'), 300);
        });
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
        // 扩展触发元素选择器，适配更多 SillyTavern 卡片类型
        this.cardSel = [
            '.recentChat',
            '.character_select',
            '.character-selector .character_select',
            '.character_list .character_select',
            '[data-character-id]',
            '.char_item',
            '.char-grid-item',
            '.character-grid-item',
            '.chat-card',
            '.story-card',
            '.scenario-card'
        ].join(', ');
        // 排除点击的选择器
        this.excludeSel = '.pinChat, .renameChat, .deleteChat, .recentChatActions, .char_edit, .char_info_button, [data-action], button, .fa, .fa-solid, .fa-regular, svg';
    }

    init() {
        const fn = e => {
            const card = e.target?.closest?.(this.cardSel);
            if (!card || this.busy) return;
            if (e.target?.closest?.(this.excludeSel)) return;
            this._run(card);
        };
        document.addEventListener('click', fn, true);
        this.fns.push(() => document.removeEventListener('click', fn, true));
    }

    // 获取主题背景色
    _getThemeBg() {
        // 优先级：CSS 变量 -> computed style -> 默认值
        const root = document.documentElement;
        const body = document.body;

        // 尝试获取 SillyTavern 主题变量
        let bg = getComputedStyle(root).getPropertyValue('--SmartThemeBlurTintColor')?.trim();
        if (bg && bg !== '') return bg;

        bg = getComputedStyle(root).getPropertyValue('--body-bg-color')?.trim();
        if (bg && bg !== '') return bg;

        bg = getComputedStyle(root).getPropertyValue('--background-color')?.trim();
        if (bg && bg !== '') return bg;

        bg = getComputedStyle(root).getPropertyValue('--SmartThemeBodyColor')?.trim();
        if (bg && bg !== '') return bg;

        // 尝试 body 背景
        const bodyBg = getComputedStyle(body).backgroundColor;
        if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent') return bodyBg;

        // 深色/浅色模式检测
        const isDark = root.classList.contains('dark') ||
            window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ||
            getComputedStyle(body).colorScheme === 'dark';
        return isDark ? '#1c1c1e' : '#f5f5f7';
    }

    // 获取主题文字颜色
    _getThemeText() {
        const root = document.documentElement;

        let color = getComputedStyle(root).getPropertyValue('--SmartThemeQuoteColor')?.trim();
        if (color && color !== '') return color;

        color = getComputedStyle(root).getPropertyValue('--text-color')?.trim();
        if (color && color !== '') return color;

        color = getComputedStyle(root).getPropertyValue('--SmartThemeBodyColor')?.trim();
        if (color && color !== '') return color;

        const bodyColor = getComputedStyle(document.body).color;
        if (bodyColor && bodyColor !== '') return bodyColor;

        const isDark = root.classList.contains('dark') ||
            window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
        return isDark ? '#e8e8e8' : '#1d1d1f';
    }

    _run(card) {
        const root = ROOT;
        if (this.reduceMotion) return;
        this.busy = true;
        const cardRect = card.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // 获取主题颜色
        const themeBg = this._getThemeBg();
        const themeText = this._getThemeText();

        this.scrim = document.createElement('div');
        this.scrim.className = 'liquid-page-scrim';
        // 添加到 html 元素，避免受 body 缩放影响
        ROOT.appendChild(this.scrim);

        this.ghost = document.createElement('div');
        this.ghost.className = 'liquid-page-ghost';
        // 确保完全覆盖视口
        this.ghost.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            margin: 0;
            padding: 0;
        `;
        // 应用主题背景色
        this.ghost.style.setProperty('--liquid-theme-bg', themeBg);
        this.ghost.style.setProperty('--liquid-theme-text', themeText);

        const inner = document.createElement('div');
        inner.className = 'liquid-ghost-inner';

        // 扩展选择器，适配更多卡片类型
        const name = card.querySelector('strong, .ch_name, .recentChatName, .char_name, .name, h2, h3, .title');
        const prev = card.querySelector('.recentChatPreview, .mes_text, .char_preview, .preview, .description, div:last-child, p');

        const contentScaleInv = document.createElement('div');
        contentScaleInv.className = 'liquid-ghost-content-inv';

        // 尝试获取卡片的圆角
        const cardRadius = getComputedStyle(card).borderRadius || '12px';

        if (name) {
            const d = document.createElement('div');
            d.className = 'liquid-ghost-title';
            d.textContent = name.textContent;
            contentScaleInv.appendChild(d);
        }
        if (prev && prev !== name) {
            const d = document.createElement('div');
            d.className = 'liquid-ghost-preview';
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

        // 解析卡片圆角值
        const radiusMatch = cardRadius.match(/(\d+(?:\.\d+)?)(?:px|rem|em)?/);
        const radius = radiusMatch ? parseFloat(radiusMatch[1]) : 12;

        // 初始状态：从卡片位置开始，使用 transform-origin 确保从中心展开
        this.ghost.style.transformOrigin = 'center center';
        this.ghost.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
        this.ghost.style.borderRadius = `${radius / Math.max(sx, 0.01)}px / ${radius / Math.max(sy, 0.01)}px`;
        this.ghost.style.opacity = '1';
        // 确保初始状态可见
        this.ghost.style.overflow = 'hidden';

        contentScaleInv.style.transform = `scale(${1 / Math.max(sx, 0.01)}, ${1 / Math.max(sy, 0.01)})`;
        contentScaleInv.style.transformOrigin = 'top left';
        contentScaleInv.style.width = `${vw}px`;
        contentScaleInv.style.height = `${vh}px`;

        // 添加到 html 元素，避免受 body 缩放影响
        ROOT.appendChild(this.ghost);

        this.ghost.offsetHeight; // force reflow

        requestAnimationFrame(() => {
            root.classList.add('liquid-page-active');
            requestAnimationFrame(() => root.classList.add('liquid-page-shrunk'));
            this.scrim.classList.add('active');

            // Expand phase - 展开到全屏
            this.ghost.style.transform = 'translate(0, 0) scale(1, 1)';
            this.ghost.style.borderRadius = '0';
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
    } else {
        const msgs = node.querySelectorAll(MES_SEL);
        for (let i = 0, len = msgs.length; i < len; i++) {
            msgs[i].classList.add('apple-entrance');
        }
    }
}


// 设置管理
const SETTINGS_KEY = 'liquid-ui-settings';
const defaultSettings = {
    pressFeedback: true,      // 弹动反馈开关
    pressIntensity: 15,       // 弹动强度 (0-100，对应 scale 1.0-0.5)
    pressDuration: 100,       // 弹动持续时间 (ms)
    excludeChatText: false    // 仅对聊天文字关闭
};

// 将强度值转换为 scale 值
function intensityToScale(intensity) {
    // 0% = 1.0 (无弹动), 100% = 0.5 (最大弹动)
    return 1 - (intensity / 100) * 0.5;
}

function loadSettings() {
    try {
        const saved = localStorage.getItem(SETTINGS_KEY);
        if (saved) {
            return { ...defaultSettings, ...JSON.parse(saved) };
        }
    } catch (e) { }
    return { ...defaultSettings };
}

function saveSettings(settings) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) { }
}

function applySettings(settings) {
    const root = ROOT;
    const scale = intensityToScale(settings.pressIntensity);
    root.style.setProperty('--liquid-press-scale', scale);
    root.style.setProperty('--liquid-press-duration', `${settings.pressDuration}ms`);
    root.classList.toggle('liquid-press-disabled', !settings.pressFeedback);
    root.classList.toggle('liquid-chat-text-press-disabled', settings.excludeChatText);
}

const state = { stream: null, rubber: null, panel: null, click: null, page: null, settings: null, settingsPanel: null, on: false };


function createSettingsPanel() {
    const settings = state.settings;

    const panel = document.createElement('div');
    panel.id = 'liquid-ui-settings';
    panel.className = 'liquid-settings-panel';
    panel.innerHTML = `
        <div class="liquid-settings-header">
            <span class="liquid-settings-title">Liquid UI 设置</span>
            <button class="liquid-settings-close" title="关闭">×</button>
        </div>
        <div class="liquid-settings-content">
            <div class="liquid-settings-group">
                <label class="liquid-settings-label">
                    <input type="checkbox" id="liquid-press-feedback" ${settings.pressFeedback ? 'checked' : ''}>
                    <span>启用弹动反馈</span>
                </label>
                <p class="liquid-settings-desc">点击按钮和卡片时的缩放动画效果</p>
            </div>
            <div class="liquid-settings-group" id="liquid-press-scale-group" ${!settings.pressFeedback ? 'style="opacity:0.5;pointer-events:none"' : ''}>
                <label class="liquid-settings-label">
                    <span>弹动强度</span>
                    <div class="liquid-settings-input-wrapper" style="display:flex;align-items:center;gap:4px;">
                        <input type="number" id="liquid-press-scale-input" class="liquid-settings-input" min="0" max="100" value="${settings.pressIntensity}" style="width:60px;text-align:right;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:4px;padding:2px 6px;color:inherit;font-size:13px;">
                        <span>%</span>
                    </div>
                </label>
                <input type="range" id="liquid-press-scale" min="0" max="100" step="1" value="${settings.pressIntensity}">
            </div>
            <div class="liquid-settings-group" id="liquid-press-duration-group" ${!settings.pressFeedback ? 'style="opacity:0.5;pointer-events:none"' : ''}>
                <label class="liquid-settings-label">
                    <span>弹动时长</span>
                    <div class="liquid-settings-input-wrapper" style="display:flex;align-items:center;gap:4px;">
                        <input type="number" id="liquid-press-duration-input" class="liquid-settings-input" min="50" max="200" step="10" value="${settings.pressDuration}" style="width:60px;text-align:right;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:4px;padding:2px 6px;color:inherit;font-size:13px;">
                        <span>ms</span>
                    </div>
                </label>
                <input type="range" id="liquid-press-duration" min="50" max="200" step="10" value="${settings.pressDuration}">
            </div>
            <div class="liquid-settings-group" id="liquid-exclude-chat-group" ${!settings.pressFeedback ? 'style="opacity:0.5;pointer-events:none"' : ''}>
                <label class="liquid-settings-label">
                    <input type="checkbox" id="liquid-exclude-chat" ${settings.excludeChatText ? 'checked' : ''}>
                    <span>仅对聊天文字关闭弹动</span>
                </label>
                <p class="liquid-settings-desc">聊天消息区域不应用弹动效果</p>
            </div>
        </div>
    `;

    // 事件绑定
    const closeBtn = panel.querySelector('.liquid-settings-close');
    const pressFeedbackCb = panel.querySelector('#liquid-press-feedback');
    const pressScaleRange = panel.querySelector('#liquid-press-scale');
    const pressDurationRange = panel.querySelector('#liquid-press-duration');
    const excludeChatCb = panel.querySelector('#liquid-exclude-chat');
    const scaleGroup = panel.querySelector('#liquid-press-scale-group');
    const durationGroup = panel.querySelector('#liquid-press-duration-group');
    const excludeGroup = panel.querySelector('#liquid-exclude-chat-group');

    closeBtn.addEventListener('click', () => {
        panel.classList.remove('open');
    });

    pressFeedbackCb.addEventListener('change', (e) => {
        settings.pressFeedback = e.target.checked;
        const disabled = !settings.pressFeedback;
        scaleGroup.style.opacity = disabled ? '0.5' : '1';
        scaleGroup.style.pointerEvents = disabled ? 'none' : 'auto';
        durationGroup.style.opacity = disabled ? '0.5' : '1';
        durationGroup.style.pointerEvents = disabled ? 'none' : 'auto';
        excludeGroup.style.opacity = disabled ? '0.5' : '1';
        excludeGroup.style.pointerEvents = disabled ? 'none' : 'auto';
        saveSettings(settings);
        applySettings(settings);
    });

    const pressScaleInput = panel.querySelector('#liquid-press-scale-input');

    pressScaleRange.addEventListener('input', (e) => {
        settings.pressIntensity = parseInt(e.target.value);
        pressScaleInput.value = settings.pressIntensity;
        saveSettings(settings);
        applySettings(settings);
    });

    pressScaleInput.addEventListener('input', (e) => {
        let val = parseInt(e.target.value) || 0;
        val = Math.max(0, Math.min(100, val));
        settings.pressIntensity = val;
        pressScaleRange.value = val;
        saveSettings(settings);
        applySettings(settings);
    });

    pressScaleInput.addEventListener('blur', (e) => {
        let val = parseInt(e.target.value) || 0;
        val = Math.max(0, Math.min(100, val));
        e.target.value = val;
        settings.pressIntensity = val;
        pressScaleRange.value = val;
        saveSettings(settings);
        applySettings(settings);
    });

    const pressDurationInput = panel.querySelector('#liquid-press-duration-input');

    pressDurationRange.addEventListener('input', (e) => {
        settings.pressDuration = parseInt(e.target.value);
        pressDurationInput.value = settings.pressDuration;
        saveSettings(settings);
        applySettings(settings);
    });

    pressDurationInput.addEventListener('input', (e) => {
        let val = parseInt(e.target.value) || 50;
        val = Math.max(50, Math.min(200, val));
        settings.pressDuration = val;
        pressDurationRange.value = val;
        saveSettings(settings);
        applySettings(settings);
    });

    pressDurationInput.addEventListener('blur', (e) => {
        let val = parseInt(e.target.value) || 50;
        val = Math.max(50, Math.min(200, val));
        e.target.value = val;
        settings.pressDuration = val;
        pressDurationRange.value = val;
        saveSettings(settings);
        applySettings(settings);
    });

    excludeChatCb.addEventListener('change', (e) => {
        settings.excludeChatText = e.target.checked;
        saveSettings(settings);
        applySettings(settings);
    });

    // 点击外部关闭
    panel.addEventListener('click', (e) => {
        if (e.target === panel) {
            panel.classList.remove('open');
        }
    });

    document.body.appendChild(panel);
    return panel;
}

function toggleSettings() {
    if (!state.settingsPanel) {
        state.settingsPanel = createSettingsPanel();
    }
    state.settingsPanel.classList.toggle('open');
}

// 注册扩展设置按钮
function registerSettingsButton() {
    // 尝试在扩展设置区域添加按钮
    const addBtn = () => {
        // 尝试多个可能的容器选择器
        const selectors = [
            '#extensions_settings',
            '#extensions_settings2',
            '.extensions-settings',
            '#extension-settings',
            '.extension-settings',
            '#settings-container .extensions',
            '#right-menu .menu-content',
            '#ui-right-panel',
            '.drawer-content'
        ];
        let container = null;
        for (const sel of selectors) {
            container = document.querySelector(sel);
            if (container) break;
        }
        if (!container) return false;

        // 检查是否已经存在按钮
        if (container.querySelector('.liquid-settings-trigger')) return true;

        const btn = document.createElement('div');
        btn.className = 'liquid-settings-trigger';
        btn.innerHTML = `
            <div class="liquid-settings-trigger-inner">
                <span>💧</span>
                <span>Liquid UI 设置</span>
            </div>
        `;
        btn.title = '打开 Liquid UI 设置';
        btn.style.cursor = 'pointer';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleSettings();
        });

        container.appendChild(btn);
        return true;
    };

    if (!addBtn()) {
        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            if (addBtn() || attempts > 40) {
                clearInterval(timer);
            }
        }, 500);
    }
}

function boot() {
    if (state.on) return;

    // 加载并应用设置
    state.settings = loadSettings();
    applySettings(state.settings);

    ROOT.classList.add('liquid-ui-enabled');
    state.click = new ClickManager();
    const pm = new PanelManager();
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

    // 注册设置按钮
    registerSettingsButton();

    console.info(LOG, 'booted');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();