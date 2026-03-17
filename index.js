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
    '.modal', '.drawer-content', '#past_chats_modal',
    '.dialog', '.st-modal', '.st-dialog',
    '#WorldInfo', '#char_settings'
].join(', ');

// 排除选择器 - 避免匹配扩展管理面板等官方界面
const EXCLUDE_SEL = '.extensions-menu, .extension-settings, [data-extension], [class*="extension-"]:not([class*="third-party"]), #extensions-panel, .extensions-panel';

const G = /** @type {any} */ (globalThis);
const idle = G.requestIdleCallback || ((cb, opts = {}) => setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), opts.timeout ?? 1));
const cancelIdle = G.cancelIdleCallback || (id => clearTimeout(id));
const defer = G.queueMicrotask ? cb => G.queueMicrotask(cb) : cb => Promise.resolve().then(cb);
const ROOT = document.documentElement;
const OPEN_PANEL_CLS = ['open', 'active', 'show', 'is-open', 'drawer-open'];
const MES_SEL = `.mes, ${LAST_MES_SEL}`;
const REVEAL_TAGS = new Set(['SPAN', 'EM', 'STRONG', 'CODE', 'A', 'B', 'I', 'U', 'S', 'MARK', 'SUB', 'SUP']);
const CLOSING_CLS = new Set(['is-closing', 'is-switching-out']);

// 高性能节流函数 - 使用 RAF 代替 setTimeout
function throttle(fn, limit) {
    let inThrottle = false, lastArgs = null, rafId = null;
    return function (...args) {
        if (!inThrottle) {
            fn.apply(this, args);
            inThrottle = true;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                setTimeout(() => {
                    inThrottle = false;
                    if (lastArgs) { fn.apply(this, lastArgs); lastArgs = null; }
                }, limit);
            });
        } else { lastArgs = args; }
    };
}

// 高性能防抖函数
function debounce(fn, wait, immediate = false) {
    let timeout, rafId;
    return function (...args) {
        const later = () => {
            timeout = null;
            if (!immediate) fn.apply(this, args);
        };
        const callNow = immediate && !timeout;
        clearTimeout(timeout);
        cancelAnimationFrame(rafId);
        timeout = setTimeout(later, wait);
        if (callNow) fn.apply(this, args);
    };
}

// 性能优化：批处理器 - 使用 RAF 优化
class BatchProcessor {
    constructor(processFn, delay = 16) {
        this.queue = new Set();
        this.rafId = null;
        this.timer = null;
        this.processFn = processFn;
        this.delay = delay;
        this._boundFlush = this.flush.bind(this);
    }
    add(item) {
        this.queue.add(item);
        if (!this.rafId && !this.timer) {
            this.rafId = requestAnimationFrame(() => {
                this.rafId = null;
                this.timer = setTimeout(this._boundFlush, this.delay);
            });
        }
    }
    flush() {
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (!this.queue.size) return;
        const items = Array.from(this.queue);
        this.queue.clear();
        this.processFn(items);
    }
    clear() {
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.queue.clear();
    }
}

// 缓存 querySelector 结果
const queryCache = new Map();
function cachedQuery(sel, root = document) {
    const key = sel + (root === document ? '' : root.id || root.className);
    if (queryCache.has(key)) return queryCache.get(key);
    const el = root.querySelector(sel);
    if (el) queryCache.set(key, el);
    return el;
}

function qFirst(sels, root = document) {
    for (const s of sels) {
        try {
            const e = cachedQuery(s, root);
            if (e) return e;
        } catch { }
    }
    return null;
}

function qAll(sels, root = document) {
    const r = [], seen = new Set();
    for (const s of sels) {
        try {
            root.querySelectorAll(s).forEach(e => {
                if (!seen.has(e)) { seen.add(e); r.push(e); }
            });
        } catch { }
    }
    return r;
}

// 清理 query 缓存
function clearQueryCache() {
    queryCache.clear();
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
        // 性能优化
        this.revealCount = 0;
        this.lastRevealTime = 0;
        this.lastTextContent = '';
        this.scrollThrottle = throttle(() => this._scroll(), 50);
        this.growBatch = new BatchProcessor(nodes => {
            for (const n of nodes) handleGrown(n);
        }, 16);
        // 使用 IntersectionObserver 优化可见性检测
        this.visibleCache = new Map();
        this.io = null;
    }

    init() {
        this.chat = document.querySelector(CHAT_SEL);
        if (!this.chat) return;

        // 优化：只监听聊天区域，而不是整个 document.body
        this.obs = new MutationObserver(muts => {
            let cursorUpd = false, textChg = false;
            const chat = this.chat;
            const text = this.text;
            const streaming = this.streaming;

            // 批量处理 mutations
            for (let i = 0, len = muts.length; i < len; i++) {
                const m = muts[i];
                if (m.addedNodes?.length) {
                    for (let j = 0, jlen = m.addedNodes.length; j < jlen; j++) {
                        const node = m.addedNodes[j];
                        // 只处理 HTMLElement 节点
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            this.growBatch.add(node);
                        }
                    }
                }
                if (!cursorUpd && (m.type === 'characterData' || m.type === 'childList')) {
                    // 优化：使用 contains 前先检查是否是目标节点
                    const target = m.target;
                    if (target === chat || (target.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_CONTAINS)) {
                        cursorUpd = true;
                    }
                }
                if (!textChg && streaming && text && (m.type === 'characterData' || m.type === 'childList')) {
                    const target = m.target;
                    if (target === text || (target.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_CONTAINS)) {
                        textChg = true;
                    }
                }
            }
            if (cursorUpd) this._queueState();
            if (textChg) this._queueReveal();
        });

        // 优化：只监听聊天区域，大幅减少回调频率
        this.obs.observe(this.chat, {
            childList: true,
            subtree: true,
            characterData: true,
            characterDataOldValue: false
        });

        // 优化：使用 ResizeObserver 但节流
        this.resObs = new ResizeObserver(entries => {
            if (this.streaming && this.chat) {
                // 使用 requestAnimationFrame 节流
                if (this.scrollRaf) return;
                this.scrollRaf = requestAnimationFrame(() => {
                    this.scrollRaf = 0;
                    this.scrollThrottle();
                });
            }
        });
        this.resObs.observe(this.chat);

        // 初始化 IntersectionObserver 用于可见性优化
        this.io = new IntersectionObserver(entries => {
            for (const entry of entries) {
                this.visibleCache.set(entry.target, entry.isIntersecting);
            }
        }, { root: this.chat, threshold: 0 });
    }

    updateState() {
        if (!this.chat) return;
        const last = this.chat.querySelector(LAST_MES_SEL);
        if (!last) return;
        const txt = last.querySelector(MES_TEXT_SEL);
        if (!txt) return;

        // 优化：批量处理 class 操作
        if (this.mes && this.mes !== last) {
            this.mes.classList.remove('liquid-streaming');
        }
        if (this.text && this.text !== txt) {
            this.text.classList.remove('liquid-cursor');
            this._clean(this.text);
        }
        if (this.mes !== last || this.text !== txt) {
            this.prevLen = 0;
            this.revealCount = 0;
            this.lastTextContent = '';
        }

        this.mes = last;
        this.text = txt;

        // 使用 requestAnimationFrame 批量处理 DOM 操作
        requestAnimationFrame(() => {
            if (last) last.classList.add('liquid-streaming');
            if (txt) txt.classList.add('liquid-cursor');
            if (this.chat) this.chat.classList.add(STREAMING_CLS);
        });

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

    _reveal() {
        if (!this.text) return;
        const textContent = this.text.textContent || '';
        const len = textContent.length;
        if (len <= this.prevLen) {
            this.prevLen = len;
            this.lastTextContent = textContent;
            return;
        }

        const now = performance.now();
        const delta = len - this.prevLen;
        this.revealCount++;

        // 优化：如果文本内容没有实质性变化，跳过处理
        if (textContent === this.lastTextContent) {
            this.prevLen = len;
            return;
        }

        // 优化：更智能的触发条件
        const shouldProcess = !this.revealIdle && (
            this.revealCount % 5 === 0 ||  // 增加间隔
            delta > 80 ||                   // 增加阈值
            now - this.lastRevealTime > 150 // 增加时间间隔
        );

        if (shouldProcess) {
            this.lastRevealTime = now;
            this.lastTextContent = textContent;
            this.revealIdle = idle(() => {
                this.revealIdle = 0;
                if (this.text) this._wrap(this.text);
            }, { timeout: 100 }); // 增加 timeout
        }
        this.prevLen = len;
    }

    _wrap(c) {
        if (!c) return;
        const spans = this.spans;

        // 优化：使用更高效的文本节点收集
        const textNodes = [];
        const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
                // 跳过空白文本
                if (!n.textContent || !/\S/.test(n.textContent)) return NodeFilter.FILTER_SKIP;
                // 跳过已经在 reveal 容器中的
                if (n.parentElement?.classList?.contains('liquid-char-reveal')) return NodeFilter.FILTER_SKIP;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        let node;
        while ((node = walker.nextNode())) {
            textNodes.push(node);
        }

        // 优化：批量创建和插入元素
        if (textNodes.length === 0) return;

        const fragment = document.createDocumentFragment();
        const nodesToReplace = [];

        for (const textNode of textNodes) {
            const text = textNode.textContent;
            if (!text || !/\S/.test(text)) continue;

            const outer = document.createElement('span');
            outer.className = 'liquid-char-reveal';
            const inner = document.createElement('span');
            inner.className = 'liquid-char-inner';
            inner.textContent = text;
            outer.appendChild(inner);

            // 缓存到 WeakSet
            spans.add(outer);

            // 记录需要替换的节点
            nodesToReplace.push({ oldNode: textNode, newNode: outer });
        }

        // 批量替换节点
        requestAnimationFrame(() => {
            for (const { oldNode, newNode } of nodesToReplace) {
                if (oldNode.parentNode) {
                    oldNode.parentNode.replaceChild(newNode, oldNode);
                }
            }
        });
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

        // 优化：批量移除 class
        requestAnimationFrame(() => {
            if (this.mes) this.mes.classList.remove('liquid-streaming');
            if (this.text) {
                this.text.classList.remove('liquid-cursor');
                setTimeout(() => this._clean(this.text), 350);
            }
            if (this.chat) this.chat.classList.remove(STREAMING_CLS);
        });

        this.streaming = false;
        this.mes = null;
        this.text = null;
        this.prevLen = 0;
        this.revealCount = 0;
        this.lastTextContent = '';
    }

    _clean(c) {
        if (!c) return;
        idle(() => {
            const spans = c.querySelectorAll('.liquid-char-reveal');
            const len = spans.length;
            if (!len) return;

            // 优化：批量处理，每批处理 50 个
            const batchSize = 50;
            let index = 0;

            const processBatch = () => {
                const end = Math.min(index + batchSize, len);
                for (let i = index; i < end; i++) {
                    const s = spans[i];
                    const inner = s.querySelector('.liquid-char-inner');
                    if (inner && inner.textContent) {
                        const textNode = document.createTextNode(inner.textContent);
                        s.parentNode.replaceChild(textNode, s);
                    } else {
                        s.classList.remove('liquid-char-reveal');
                        s.style.animation = 'none';
                    }
                }
                index = end;
                if (index < len) {
                    requestAnimationFrame(processBatch);
                } else {
                    c.normalize();
                }
            };

            processBatch();
        }, { timeout: 200 });
    }

    destroy() {
        this.obs?.disconnect();
        this.resObs?.disconnect();
        this.io?.disconnect();
        this.growBatch.clear();
        this.visibleCache.clear();
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
        // 性能优化：缓存边界检查结果
        this._cachedAtTop = false;
        this._cachedAtBot = false;
        this._cacheValid = false;
        this._boundHandlers = {};
        // 添加滚动容器白名单
        this._scrollContainers = new Set();
        // 标记是否有展开的面板
        this._hasExpandedPanel = false;
    }

    init() {
        this.chat = document.querySelector(CHAT_SEL);
        if (!this.chat) return;

        // 绑定并缓存事件处理器
        this._boundHandlers.wheel = this._wheel.bind(this);
        this._boundHandlers.touchStart = this._touchStart.bind(this);
        this._boundHandlers.touchMove = this._touchMove.bind(this);
        this._boundHandlers.touchEnd = this._release.bind(this);

        const { wheel, touchStart, touchMove, touchEnd } = this._boundHandlers;

        // 使用 passive: true 优化滚动性能，只在需要时阻止默认行为
        // 但首先检查是否在可滚动容器内
        this.chat.addEventListener('wheel', wheel, { passive: false });
        this.chat.addEventListener('touchstart', touchStart, { passive: true });
        this.chat.addEventListener('touchmove', touchMove, { passive: false });
        this.chat.addEventListener('touchend', touchEnd, { passive: true });
        this.chat.addEventListener('touchcancel', touchEnd, { passive: true });

        // 监听滚动事件来更新缓存
        this.chat.addEventListener('scroll', () => {
            this._cacheValid = false;
        }, { passive: true });

        // 监听动态添加的可滚动容器
        this._observeScrollContainers();

        this.fns.push(() => {
            this.chat?.removeEventListener('wheel', wheel);
            this.chat?.removeEventListener('touchstart', touchStart);
            this.chat?.removeEventListener('touchmove', touchMove);
            this.chat?.removeEventListener('touchend', touchEnd);
            this.chat?.removeEventListener('touchcancel', touchEnd);
            this._scrollObserver?.disconnect();
        });
    }

    // 检查元素是否在可滚动容器内（排除聊天区域本身）
    _isInScrollContainer(target) {
        // 检查目标元素或其父元素是否是可滚动容器
        let el = target;
        while (el && el !== document.body) {
            // 如果是聊天区域本身，不视为"可滚动容器"（允许橡皮筋效果）
            if (el === this.chat) {
                return false;
            }
            // 检查是否是已知的可滚动容器
            if (this._scrollContainers.has(el)) {
                return true;
            }
            // 检查是否有滚动能力
            const style = getComputedStyle(el);
            const overflow = style.overflow + style.overflowY + style.overflowX;
            if ((overflow.includes('auto') || overflow.includes('scroll')) && el.scrollHeight > el.clientHeight) {
                this._scrollContainers.add(el);
                return true;
            }
            el = el.parentElement;
        }
        return false;
    }

    // 观察动态添加的可滚动容器
    _observeScrollContainers() {
        this._scrollObserver = new MutationObserver((muts) => {
            for (const m of muts) {
                if (m.addedNodes?.length) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // 检查新添加的节点是否包含可滚动容器
                            const scrollables = node.querySelectorAll?.('[style*="overflow"], .drawer-content, .inline-drawer-content, .scrollableInner, [class*="scroll"]');
                            if (scrollables) {
                                scrollables.forEach(el => {
                                    const style = getComputedStyle(el);
                                    const overflow = style.overflow + style.overflowY + style.overflowX;
                                    if (overflow.includes('auto') || overflow.includes('scroll')) {
                                        this._scrollContainers.add(el);
                                    }
                                });
                            }
                            // 检查节点本身
                            if (node.style?.overflow || node.classList?.contains('scrollable')) {
                                this._scrollContainers.add(node);
                            }
                        }
                    }
                }
            }
        });
        this._scrollObserver.observe(document.body, { childList: true, subtree: true });
    }

    // 检查是否有展开的列表面板
    _hasExpandedList() {
        // 检查常见的展开列表面板选择器
        const expandedSelectors = [
            '.recentChat.expanded',
            '.chat-list.expanded',
            '[class*="expanded"]',
            '.drawer-content:not(.closed)',
            '.inline-drawer-content[style*="display: block"]',
            '.inline-drawer-content:not(.hidden)',
            '[class*="open"]:not(.liquid-side-panel)',
            '.menu-open',
            '.dropdown-open'
        ];

        for (const selector of expandedSelectors) {
            try {
                const el = document.querySelector(selector);
                if (el && el.offsetHeight > 100) { // 确保是实际可见的展开内容
                    return true;
                }
            } catch (e) {
                // 忽略无效选择器
            }
        }

        // 检查是否有高度超过100px的浮动/下拉面板
        const panels = document.querySelectorAll('.drawer-content, .inline-drawer-content, [class*="dropdown"], [class*="menu"]');
        for (const panel of panels) {
            const style = getComputedStyle(panel);
            if (style.display !== 'none' && style.visibility !== 'hidden' && panel.offsetHeight > 100) {
                return true;
            }
        }

        return false;
    }

    // 检查鼠标/触摸点是否在展开的列表面板区域内
    _isMouseOverExpandedPanel() {
        // 获取鼠标位置（如果可用）
        let x, y;
        if (window.event) {
            x = window.event.clientX;
            y = window.event.clientY;
        } else {
            // 如果没有事件对象，检查当前焦点元素是否在展开面板内
            const activeEl = document.activeElement;
            if (activeEl) {
                return this._isInExpandedPanel(activeEl);
            }
            return false;
        }

        // 检查鼠标位置下的元素
        const el = document.elementFromPoint(x, y);
        if (!el) return false;

        return this._isInExpandedPanel(el);
    }

    // 检查元素是否在展开的面板内
    _isInExpandedPanel(el) {
        if (!el) return false;

        // 检查元素或其父元素是否是展开的面板
        let current = el;
        while (current && current !== document.body) {
            // 检查是否是展开的面板
            const style = getComputedStyle(current);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
                // 检查是否是可滚动的展开面板
                const overflow = style.overflow + style.overflowY + style.overflowX;
                const isScrollable = overflow.includes('auto') || overflow.includes('scroll');
                const hasContent = current.scrollHeight > current.clientHeight;

                // 检查是否是已知的展开面板类型
                const isExpandedPanel = current.classList.contains('expanded') ||
                    current.classList.contains('drawer-content') ||
                    current.classList.contains('inline-drawer-content') ||
                    current.classList.contains('open') ||
                    current.classList.contains('active') ||
                    current.hasAttribute('open');

                if (isExpandedPanel && (isScrollable || current.offsetHeight > 100)) {
                    return true;
                }
            }
            current = current.parentElement;
        }

        return false;
    }

    _touchStart(e) {
        if (e.touches.length) {
            this.touchY = e.touches[0].clientY;
            this._cacheValid = false;
        }
    }

    _atTop() {
        if (!this._cacheValid) this._updateCache();
        return this._cachedAtTop;
    }

    _atBot() {
        if (!this._cacheValid) this._updateCache();
        return this._cachedAtBot;
    }

    _updateCache() {
        if (!this.chat) return;
        const { scrollTop, scrollHeight, clientHeight } = this.chat;
        this._cachedAtTop = scrollTop <= 0;
        this._cachedAtBot = scrollTop + clientHeight >= scrollHeight - 1;
        this._cacheValid = true;
    }

    _rubber(o) {
        const absO = Math.abs(o);
        const s = o > 0 ? 1 : -1;
        // 优化：使用位运算和更简单的数学
        return s * (absO * 0.4) / (1 + absO * 0.003);
    }

    _wheel(e) {
        if (!this.chat) return;

        // 检查鼠标/焦点是否在可滚动容器内，如果是则不触发橡皮筋效果
        if (this._isInScrollContainer(e.target)) {
            return;
        }

        // 检查鼠标是否在展开的列表面板区域内，如果是则不触发橡皮筋效果
        if (this._isMouseOverExpandedPanel()) {
            return;
        }

        const deltaY = e.deltaY;
        // 优化：快速路径检查
        if (deltaY === 0) return;

        const isUp = deltaY < 0;
        const shouldRubber = (isUp && this._atTop()) || (!isUp && this._atBot());

        if (shouldRubber) {
            e.preventDefault();
            this.offset += deltaY * 0.5;
            this._queueApply();
            clearTimeout(this.wheelTimer);
            this.wheelTimer = setTimeout(() => this._release(), 100);
        }
    }

    _touchMove(e) {
        if (!this.chat || !e.touches.length) return;

        // 检查触摸点是否在可滚动容器内，如果是则不触发橡皮筋效果
        if (this._isInScrollContainer(e.target)) {
            return;
        }

        // 检查触摸点是否在展开的列表面板区域内，如果是则不触发橡皮筋效果
        if (this._isMouseOverExpandedPanel()) {
            return;
        }

        const touch = e.touches[0];
        const dy = this.touchY - touch.clientY;
        this.touchY = touch.clientY;

        const isUp = dy < 0;
        const shouldRubber = (isUp && this._atTop()) || (!isUp && this._atBot());

        if (shouldRubber) {
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
            // 优化：使用 will-change 提示浏览器
            this.chat.style.willChange = 'transform';
        }
        // 优化：使用 translate3d 触发 GPU 加速
        this.chat.style.transform = `translate3d(0, ${-this._rubber(this.offset)}px, 0)`;
    }

    _release() {
        if (!this.active) return;
        this.velocity = 0;
        if (this.raf) cancelAnimationFrame(this.raf);
        if (this.applyRaf) { cancelAnimationFrame(this.applyRaf); this.applyRaf = 0; }

        // 优化：使用更高效的动画循环
        let lastTime = performance.now();
        const tick = (now) => {
            const dt = Math.min((now - lastTime) / 16.67, 2); // 限制最大时间步长
            lastTime = now;

            const f = -0.15 * this.offset * dt;
            this.velocity = (this.velocity + f) * Math.pow(0.75, dt);
            this.offset += this.velocity * dt;

            if (Math.abs(this.offset) < 0.5 && Math.abs(this.velocity) < 0.5) {
                this.offset = 0;
                this.velocity = 0;
                this.active = false;
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
        if (this.wheelTimer) clearTimeout(this.wheelTimer);
        if (this.chat) {
            this.chat.style.willChange = '';
            this.chat.style.transform = '';
            this.chat.classList.remove('liquid-rubber-band');
        }
        this.fns.forEach(f => { try { f(); } catch { } });
        this._boundHandlers = {};
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
        // 性能优化：使用 RAF 节流代替 setTimeout
        this._uiRaf = null;
        this._boundUiImpl = this._uiImpl.bind(this);
        // 缓存 _isOpen 结果
        this._openCache = new WeakMap();
        this._cacheTs = 0;
    }

    init() {
        this.chat = document.querySelector(CHAT_SEL);
        this.lp = qFirst(L_PANEL);
        this.rp = qFirst(R_PANEL);
        if (!this.lp && !this.rp) return false;

        // 使用 requestAnimationFrame 批量处理 DOM 操作
        requestAnimationFrame(() => {
            this._enhance(this.lp, 'left');
            this._enhance(this.rp, 'right');
        });

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

            const items = qAll(['.info-row', '.card', '.ch_name', '.stat-card'], p);
            const maxItems = Math.min(items.length, 12); // 减少最大项目数
            for (let i = 0; i < maxItems; i++) {
                const item = items[i];
                if (!item.classList.contains('liquid-info-item')) {
                    item.classList.add('liquid-info-item');
                    // 减少交错延迟
                    item.style.setProperty('--liquid-stagger', `${120 + i * 25}ms`);
                }
            }
        }
    }

    _toggles() {
        this.lb = qAll(L_TOGGLE).filter(e => !(this.lp?.contains(e) || this.rp?.contains(e)));
        this.rb = qAll(R_TOGGLE).filter(e => !(this.lp?.contains(e) || this.rp?.contains(e)));

        // 绑定事件处理器
        this._boundToggleLeft = () => this.toggle('left');
        this._boundToggleRight = () => this.toggle('right');

        this.lb.forEach(b => {
            b.classList.add('liquid-panel-toggle-left');
            b.addEventListener('click', this._boundToggleLeft);
            this.fns.push(() => b.removeEventListener('click', this._boundToggleLeft));
        });
        this.rb.forEach(b => {
            b.classList.add('liquid-panel-toggle-right');
            b.addEventListener('click', this._boundToggleRight);
            this.fns.push(() => b.removeEventListener('click', this._boundToggleRight));
        });
    }

    _closeBinds() {
        if (this.chat) {
            this._boundCloseHandler = (e) => {
                if (!this._isOpen(this.lp) && !this._isOpen(this.rp)) return;
                if (!e.target || e.target.closest('a, button, input, textarea, select')) return;
                if (this.lp?.contains(e.target) || this.rp?.contains(e.target)) return;
                this.close();
            };
            this.chat.addEventListener('click', this._boundCloseHandler, { passive: true });
            this.fns.push(() => this.chat?.removeEventListener('click', this._boundCloseHandler));
        }
        this._boundEscHandler = (e) => {
            if (e.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this._boundEscHandler);
        this.fns.push(() => document.removeEventListener('keydown', this._boundEscHandler));
    }

    _observe() {
        [this.lp, this.rp].forEach(p => {
            if (!(p instanceof HTMLElement)) return;
            const o = new MutationObserver((muts) => {
                // 优化：批量处理 mutation，只在 class 变化时触发
                let shouldUpdate = false;
                for (const m of muts) {
                    if (m.type === 'attributes' && (m.attributeName === 'class' || m.attributeName === 'open')) {
                        shouldUpdate = true;
                        break;
                    }
                }
                if (shouldUpdate) {
                    this._openCache.delete(p);
                    this._ui();
                }
            });
            o.observe(p, { attributes: true, attributeFilter: ['class', 'open', 'style'] });
            this.obs.push(o);
        });
    }

    _isOpen(p) {
        if (!(p instanceof HTMLElement)) return false;

        // 检查缓存
        const now = Date.now();
        if (now - this._cacheTs > 100) {
            this._openCache = new WeakMap(); // 定期清理缓存
            this._cacheTs = now;
        }
        if (this._openCache.has(p)) return this._openCache.get(p);

        const cl = p.classList;
        for (const c of CLOSING_CLS) { if (cl.contains(c)) { this._openCache.set(p, false); return false; } }
        if (p.hasAttribute('open')) { this._openCache.set(p, true); return true; }
        for (const c of OPEN_PANEL_CLS) { if (cl.contains(c)) { this._openCache.set(p, true); return true; } }
        const parent = p.parentElement;
        if (parent) {
            for (const c of OPEN_PANEL_CLS) {
                if (parent.classList.contains(c)) { this._openCache.set(p, true); return true; }
            }
        }
        this._openCache.set(p, false);
        return false;
    }

    open(side) {
        const tgt = side === 'left' ? this.lp : this.rp;
        const oth = side === 'left' ? this.rp : this.lp;
        if (!tgt) return;

        requestAnimationFrame(() => {
            if (oth && this._isOpen(oth)) {
                oth.classList.remove('is-open', 'open', 'active', 'show');
                oth.removeAttribute('open');
                oth.classList.add('is-switching-out');
                setTimeout(() => oth.classList.remove('is-switching-out'), 280);
            }
            tgt.classList.remove('is-closing', 'is-switching-out');
            tgt.classList.add('is-open');
            this._ui();
        });
    }

    close() {
        requestAnimationFrame(() => {
            [this.lp, this.rp].forEach(p => {
                if (!this._isOpen(p)) return;
                p.classList.remove('is-open', 'open', 'active', 'show');
                p.removeAttribute('open');
                p.classList.add('is-closing');
                setTimeout(() => p.classList.remove('is-closing'), 280);
            });
            this._ui();
        });
    }

    toggle(side) {
        const t = side === 'left' ? this.lp : this.rp;
        if (!t) return;
        this._isOpen(t) ? this.close() : this.open(side);
    }

    _ui() {
        // 使用 RAF 节流
        if (this._uiRaf) return;
        this._uiRaf = requestAnimationFrame(() => {
            this._uiRaf = null;
            this._boundUiImpl();
        });
    }

    _uiImpl() {
        const r = ROOT;
        const lo = this._isOpen(this.lp), ro = this._isOpen(this.rp);
        if (this.uiState.lo === lo && this.uiState.ro === ro) return;
        this.uiState.lo = lo;
        this.uiState.ro = ro;

        // 批量处理 class 操作
        r.classList.toggle('liquid-left-open', lo && !ro);
        r.classList.toggle('liquid-right-open', ro && !lo);
        r.classList.toggle('liquid-both-open', lo && ro);

        if (this.chat) {
            const chat = this.chat;
            chat.classList.remove('when-left-open', 'when-right-open', 'when-both-open');
            if (lo && ro) chat.classList.add('when-both-open');
            else if (lo) chat.classList.add('when-left-open');
            else if (ro) chat.classList.add('when-right-open');
        }

        // 批量处理按钮状态
        const lb = this.lb, rb = this.rb;
        for (let i = 0; i < lb.length; i++) lb[i].classList.toggle('is-active', lo && !ro);
        for (let i = 0; i < rb.length; i++) rb[i].classList.toggle('is-active', ro && !lo);
    }

    destroy() {
        if (this._uiRaf) cancelAnimationFrame(this._uiRaf);
        this.fns.forEach(f => { try { f(); } catch { } });
        this.obs.forEach(o => o.disconnect());
        this._openCache = new WeakMap();
    }
}


class PageTransition {
    constructor() {
        this.scrim = null;
        this.ghost = null;
        this.busy = false;
        this.fns = [];
        this.reduceMotion = !!G.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
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
        this.excludeSel = '.pinChat, .renameChat, .deleteChat, .recentChatActions, .char_edit, .char_info_button, [data-action], button, .fa, .fa-solid, .fa-regular, svg';
        // 性能优化：缓存主题颜色
        this._cachedBg = null;
        this._cachedText = null;
        this._themeCacheTime = 0;
    }

    init() {
        const fn = e => {
            const card = e.target?.closest?.(this.cardSel);
            if (!card || this.busy) return;
            if (e.target?.closest?.(this.excludeSel)) return;
            // 排除扩展管理面板等官方界面
            if (card.matches?.(EXCLUDE_SEL) || card.closest?.(EXCLUDE_SEL)) return;
            this._run(card);
        };
        document.addEventListener('click', fn, true);
        this.fns.push(() => document.removeEventListener('click', fn, true));
    }

    _getThemeBg() {
        const now = Date.now();
        if (this._cachedBg && now - this._themeCacheTime < 5000) return this._cachedBg;

        const root = document.documentElement;
        const body = document.body;
        const style = getComputedStyle(root);

        let bg = style.getPropertyValue('--SmartThemeBlurTintColor')?.trim();
        if (bg && bg !== '') { this._cachedBg = bg; this._themeCacheTime = now; return bg; }

        bg = style.getPropertyValue('--body-bg-color')?.trim();
        if (bg && bg !== '') { this._cachedBg = bg; this._themeCacheTime = now; return bg; }

        bg = style.getPropertyValue('--background-color')?.trim();
        if (bg && bg !== '') { this._cachedBg = bg; this._themeCacheTime = now; return bg; }

        bg = style.getPropertyValue('--SmartThemeBodyColor')?.trim();
        if (bg && bg !== '') { this._cachedBg = bg; this._themeCacheTime = now; return bg; }

        const bodyBg = getComputedStyle(body).backgroundColor;
        if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent') {
            this._cachedBg = bodyBg; this._themeCacheTime = now; return bodyBg;
        }

        const isDark = root.classList.contains('dark') ||
            window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
        this._cachedBg = isDark ? '#1c1c1e' : '#f5f5f7';
        this._themeCacheTime = now;
        return this._cachedBg;
    }

    _getThemeText() {
        const now = Date.now();
        if (this._cachedText && now - this._themeCacheTime < 5000) return this._cachedText;

        const root = document.documentElement;
        const style = getComputedStyle(root);

        let color = style.getPropertyValue('--SmartThemeQuoteColor')?.trim();
        if (color && color !== '') { this._cachedText = color; this._themeCacheTime = now; return color; }

        color = style.getPropertyValue('--text-color')?.trim();
        if (color && color !== '') { this._cachedText = color; this._themeCacheTime = now; return color; }

        color = style.getPropertyValue('--SmartThemeBodyColor')?.trim();
        if (color && color !== '') { this._cachedText = color; this._themeCacheTime = now; return color; }

        const bodyColor = getComputedStyle(document.body).color;
        if (bodyColor && bodyColor !== '') { this._cachedText = bodyColor; this._themeCacheTime = now; return bodyColor; }

        const isDark = root.classList.contains('dark') ||
            window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
        this._cachedText = isDark ? '#e8e8e8' : '#1d1d1f';
        this._themeCacheTime = now;
        return this._cachedText;
    }

    _run(card) {
        const root = ROOT;
        if (this.reduceMotion) return;
        this.busy = true;

        const cardRect = card.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const themeBg = this._getThemeBg();
        const themeText = this._getThemeText();

        this.scrim = document.createElement('div');
        this.scrim.className = 'liquid-page-scrim';
        ROOT.appendChild(this.scrim);

        this.ghost = document.createElement('div');
        this.ghost.className = 'liquid-page-ghost';
        this.ghost.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            margin: 0;
            padding: 0;
        `;
        this.ghost.style.setProperty('--liquid-theme-bg', themeBg);
        this.ghost.style.setProperty('--liquid-theme-text', themeText);

        const inner = document.createElement('div');
        inner.className = 'liquid-ghost-inner';

        const name = card.querySelector('strong, .ch_name, .recentChatName, .char_name, .name, h2, h3, .title');
        const prev = card.querySelector('.recentChatPreview, .mes_text, .char_preview, .preview, .description, div:last-child, p');

        const contentScaleInv = document.createElement('div');
        contentScaleInv.className = 'liquid-ghost-content-inv';

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

        const radiusMatch = cardRadius.match(/(\d+(?:\.\d+)?)(?:px|rem|em)?/);
        const radius = radiusMatch ? parseFloat(radiusMatch[1]) : 12;

        this.ghost.style.transformOrigin = 'center center';
        this.ghost.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
        this.ghost.style.borderRadius = `${radius / Math.max(sx, 0.01)}px / ${radius / Math.max(sy, 0.01)}px`;
        this.ghost.style.opacity = '1';
        this.ghost.style.overflow = 'hidden';

        contentScaleInv.style.transform = `scale(${1 / Math.max(sx, 0.01)}, ${1 / Math.max(sy, 0.01)})`;
        contentScaleInv.style.transformOrigin = 'top left';
        contentScaleInv.style.width = `${vw}px`;
        contentScaleInv.style.height = `${vh}px`;

        ROOT.appendChild(this.ghost);

        this.ghost.offsetHeight;

        requestAnimationFrame(() => {
            root.classList.add('liquid-page-active');
            requestAnimationFrame(() => root.classList.add('liquid-page-shrunk'));
            this.scrim.classList.add('active');

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

    // 检查是否在排除列表中（扩展管理面板等官方界面）
    if (node.matches?.(EXCLUDE_SEL) || node.closest?.(EXCLUDE_SEL)) return;

    const cl = node.classList;
    if (cl.contains('liquid-popup-entrance') || cl.contains('apple-entrance')) return;

    // 检查是否为弹窗，但排除扩展管理面板
    if (node.matches?.(POPUP_SEL) && !node.matches?.(EXCLUDE_SEL)) {
        cl.add('liquid-popup-entrance');
    } else {
        const popups = node.querySelectorAll(POPUP_SEL);
        for (let i = 0, len = popups.length; i < len; i++) {
            const popup = popups[i];
            // 排除扩展管理面板相关的元素
            if (!popup.matches?.(EXCLUDE_SEL) && !popup.closest?.(EXCLUDE_SEL)) {
                popup.classList.add('liquid-popup-entrance');
            }
        }
    }

    if (node.matches?.('.mes') || node.matches?.(LAST_MES_SEL)) {
        cl.add('apple-entrance');
    } else {
        const msgs = node.querySelectorAll(MES_SEL);
        for (let i = 0, len = msgs.length; i < len; i++) msgs[i].classList.add('apple-entrance');
    }

    // 为最近聊天列表项添加交错索引
    if (node.matches?.('.recentChat')) {
        const parent = node.parentElement;
        if (parent) {
            const siblings = parent.querySelectorAll('.recentChat');
            siblings.forEach((item, index) => {
                item.style.setProperty('--item-index', index);
            });
        }
    }
}


// 扩展面板动画控制器
class ExtensionPanelAnimator {
    constructor() {
        this.panel = null;
        this.toggle = null;
        this.isOpen = false;
        this.fns = [];
    }

    init() {
        // 查找扩展面板和切换按钮
        this.panel = document.querySelector('#extensions-panel, .extensions-panel, [class*="extensions-panel"]');
        this.toggle = document.querySelector('#extensions-toggle, .extension-toggle, [class*="third-party"], [title*="扩展"], [title*="extension"]');

        if (!this.panel && !this.toggle) return false;

        // 监听切换按钮点击
        if (this.toggle) {
            this.toggle.classList.add('liquid-sanhua-btn');
            this.toggle.addEventListener('click', () => this.togglePanel(), { passive: true });
        }

        // 使用 MutationObserver 监听面板状态变化
        if (this.panel) {
            this.obs = new MutationObserver((muts) => {
                for (const m of muts) {
                    if (m.type === 'attributes' && m.attributeName === 'class') {
                        const isOpen = this.panel.classList.contains('open') ||
                            this.panel.classList.contains('active') ||
                            this.panel.classList.contains('show');
                        if (isOpen !== this.isOpen) {
                            this.isOpen = isOpen;
                            this.animatePanel(isOpen);
                        }
                    }
                }
            });
            this.obs.observe(this.panel, { attributes: true, attributeFilter: ['class'] });
        }

        return true;
    }

    togglePanel() {
        if (!this.panel) return;
        this.panel.classList.toggle('open');
    }

    animatePanel(isOpen) {
        if (!this.panel) return;

        if (isOpen) {
            this.panel.classList.remove('closing');
            this.panel.classList.add('open');
        } else {
            this.panel.classList.remove('open');
            this.panel.classList.add('closing');
            setTimeout(() => {
                this.panel.classList.remove('closing');
            }, 250);
        }
    }

    destroy() {
        this.obs?.disconnect();
        this.fns.forEach(f => { try { f(); } catch { } });
    }
}


const state = { stream: null, rubber: null, panel: null, page: null, extPanel: null, on: false };

function boot() {
    if (state.on) return;
    ROOT.classList.add('liquid-ui-enabled');
    const pm = new PanelManager();
    if (pm.init()) state.panel = pm;
    else { let r = 0; const i = setInterval(() => { r++; if (pm.init() || r > 60) { state.panel = pm; clearInterval(i); } }, 500); }
    state.stream = new StreamRevealEngine();
    state.stream.init();
    state.rubber = new RubberBandController();
    state.rubber.init();
    state.page = new PageTransition();
    state.page.init();

    // 初始化扩展面板动画控制器
    const epa = new ExtensionPanelAnimator();
    if (epa.init()) state.extPanel = epa;

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
