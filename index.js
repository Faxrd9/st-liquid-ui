const EXTENSION_TAG = '[liquid-recent-chat-transition]';
const ANIMATION_DURATION_MS = 340;
const CLICK_REPLAY_DELAY_MS = 170;
const POST_ANIMATION_SETTLE_MS = 90;
const CHAT_READY_TIMEOUT_MS = 1200;
const SCROLL_MAX_DURATION_MS = 520;
const CONTENT_REVEAL_DURATION_MS = 240;
const IDENTITY_FOCUS_TOP_OFFSET_PX = 18;
const IDENTITY_ENTER_DURATION_MS = 360;
const EMPTY_EXIT_DURATION_MS = 280;
const MINUTE_MS = 60 * 1000;
const DEFAULT_EYE_CARE_INTERVAL_MS = 20 * MINUTE_MS;
const DEFAULT_POSTURE_INTERVAL_MS = 30 * MINUTE_MS;
const ACTIVE_IDLE_TIMEOUT_MS = 60 * 1000;
const REMINDER_TICK_MS = 1000;
const REMINDER_AUTO_HIDE_MS = 18000;
const DEFAULT_REMINDER_SNOOZE_MS = 5 * MINUTE_MS;
const WEATHER_CACHE_MS = 90 * MINUTE_MS;
const HOLIDAY_API_TIMEOUT_MS = 8000;
const WELCOME_CHECK_INTERVAL_MS = 500;
const WELCOME_CHECK_TIMEOUT_MS = 12000;
const DISABLED_DAY_STORAGE_KEY = 'st-liquid-ui-reminder-disabled-day-v4';
const REMINDER_SNOOZE_STORAGE_KEY = 'st-liquid-ui-reminder-snooze-until-v2';
const REMINDER_STORAGE_KEYS = [
    'st-liquid-ui-reminder-disabled-day',
    'st-liquid-ui-reminder-disabled-day-v2',
    'st-liquid-ui-reminder-disabled-day-v3',
    'st-liquid-ui-reminder-snooze-until',
    'st-liquid-ui-reminder-snooze-until-v2',
    'st-liquid-ui-reminder-disabled-day-v4',
];

const SOLAR_HOLIDAY_GREETINGS = new Map([
    ['1-1', '元旦快乐'],
    ['10-1', '国庆快乐'],
]);

const HOLIDAY_GREETING_WHITELIST = new Map([
    ['元旦节', '元旦快乐'],
    ['元旦', '元旦快乐'],
    ['春节', '春节快乐'],
    ['元宵节', '元宵节快乐'],
    ['端午节', '端午安康'],
    ['中秋节', '中秋快乐'],
    ['国庆节', '国庆快乐'],
]);

const SUNNY_WEATHER_CODES = new Set([0, 1, 2]);
const RAINY_WEATHER_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]);
const SNOWY_WEATHER_CODES = new Set([71, 73, 75, 77, 85, 86]);
const STORM_WEATHER_CODES = new Set([95, 96, 99]);

const BODY_CHAT_PREPARING_CLASS = 'liquid-recent-chat-preparing';

let isInstalled = false;
let isTransitioning = false;
/** @type {HTMLElement | null} */
let bypassCard = null;
let reminderIsland = null;
let reminderTitle = null;
let reminderMessage = null;
let reminderMeta = null;
let reminderTimerId = 0;
let reminderHideTimer = 0;
let activeUsageMs = 0;
let dailyUsageMs = 0;
let usageDayStamp = new Date().toDateString();
let lastTickAt = Date.now();
let lastActivityAt = Date.now();
let nextEyeReminderAt = DEFAULT_EYE_CARE_INTERVAL_MS;
let nextPostureReminderAt = DEFAULT_POSTURE_INTERVAL_MS;
let snoozeUntil = Number.parseInt(localStorage.getItem(REMINDER_SNOOZE_STORAGE_KEY) || '0', 10) || 0;
let remindersDisabledForToday = localStorage.getItem(DISABLED_DAY_STORAGE_KEY) === usageDayStamp;
let weatherPromise = null;
let cachedWeather = null;
let hasShownWelcomeIsland = false;
let holidayPromise = null;
let welcomeCheckTimerId = 0;
let welcomeCheckStartedAt = 0;

function emptyTransition() {
    return {
        done: Promise.resolve(),
        cleanup: () => { },
    };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function clearReminderHideTimer() {
    if (reminderHideTimer) {
        window.clearTimeout(reminderHideTimer);
        reminderHideTimer = 0;
    }
}

function cleanupReminderStorage() {
    try {
        REMINDER_STORAGE_KEYS.forEach(key => {
            if (key !== DISABLED_DAY_STORAGE_KEY && key !== REMINDER_SNOOZE_STORAGE_KEY) {
                localStorage.removeItem(key);
            }
        });

        const storedDisabledDay = localStorage.getItem(DISABLED_DAY_STORAGE_KEY);
        if (storedDisabledDay && storedDisabledDay !== new Date().toDateString()) {
            localStorage.removeItem(DISABLED_DAY_STORAGE_KEY);
        }

        const storedSnoozeUntil = Number.parseInt(localStorage.getItem(REMINDER_SNOOZE_STORAGE_KEY) || '0', 10) || 0;
        if (storedSnoozeUntil > 0 && storedSnoozeUntil <= Date.now()) {
            localStorage.removeItem(REMINDER_SNOOZE_STORAGE_KEY);
        }
    } catch {
        // Ignore storage cleanup failures.
    }
}

function syncUsageDay() {
    const today = new Date().toDateString();
    if (usageDayStamp === today) {
        return;
    }

    usageDayStamp = today;
    dailyUsageMs = 0;
    remindersDisabledForToday = localStorage.getItem(DISABLED_DAY_STORAGE_KEY) === today;
}

function isReminderDisabledToday() {
    syncUsageDay();
    return remindersDisabledForToday;
}

function setReminderDisabledToday() {
    remindersDisabledForToday = true;
    try {
        localStorage.setItem(DISABLED_DAY_STORAGE_KEY, usageDayStamp);
    } catch {
        // Ignore storage write failures.
    }
    hideReminderIsland();
}

function persistSnoozeUntil(value) {
    snoozeUntil = value;

    try {
        if (value > 0) {
            localStorage.setItem(REMINDER_SNOOZE_STORAGE_KEY, String(value));
        } else {
            localStorage.removeItem(REMINDER_SNOOZE_STORAGE_KEY);
        }
    } catch {
        // Ignore storage write failures.
    }
}

function markUserActivity() {
    lastActivityAt = Date.now();
}

function formatDuration(ms) {
    const totalMinutes = Math.max(1, Math.floor(ms / MINUTE_MS));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours <= 0) {
        return `${totalMinutes} 分钟`;
    }

    if (minutes <= 0) {
        return `${hours} 小时`;
    }

    return `${hours} 小时 ${minutes} 分钟`;
}

function getTimeGreeting(date = new Date()) {
    const hour = date.getHours();

    if (hour >= 5 && hour < 11) {
        return '早上好';
    }

    if (hour >= 11 && hour < 14) {
        return '中午好';
    }

    if (hour >= 14 && hour < 18) {
        return '下午好';
    }

    if (hour >= 18 && hour < 23) {
        return '晚上好';
    }

    return '夜深了';
}

function getPositiveHolidayGreeting(date = new Date()) {
    const monthDay = `${date.getMonth() + 1}-${date.getDate()}`;
    return SOLAR_HOLIDAY_GREETINGS.get(monthDay) || '';
}

function getWeatherLabel(weatherCode) {
    const tone = getWeatherTone(weatherCode);

    if (tone === 'sunny') {
        return '晴';
    }

    if (tone === 'rainy') {
        return '雨';
    }

    if (tone === 'snowy') {
        return '雪';
    }

    if (tone === 'stormy') {
        return '强对流';
    }

    return '阴';
}

function getWeatherActivitySuggestion(weather) {
    if (!weather) {
        return '今天也别忘了适时活动和补水。';
    }

    const tone = getWeatherTone(weather.weatherCode);
    const isDaytime = Boolean(weather.isDay);

    if (tone === 'sunny') {
        if (isDaytime) {
            return '今天天气舒服，适合出去散散步，顺便晒晒太阳。';
        }

        return '今晚天气还算舒服，适合短暂透透气，也别忘了早点休息。';
    }

    if (tone === 'cloudy') {
        if (isDaytime) {
            return '阴天也适合慢走几步，透透气，活动一下肩颈。';
        }

        return '今晚更适合放松一下，做些轻度活动，舒缓肩颈和眼睛。';
    }

    if (tone === 'rainy') {
        if (isDaytime) {
            return '下雨天记得带伞，适合做些室内活动，顺便喝口热水。';
        }

        return '夜里下雨更适合待在室内，记得保暖，也可以喝点热饮放松一下。';
    }

    if (tone === 'snowy') {
        if (isDaytime) {
            return '下雪天注意保暖和防滑，出门记得放慢脚步。';
        }

        return '雪夜路滑，今晚更适合待在温暖的室内，好好休息。';
    }

    if (isDaytime) {
        return '外面天气不太稳定，今天更适合在室内活动、补水和适时休息。';
    }

    return '今晚天气不太稳定，尽量减少外出，放松一下，早点休息。';
}

function getWeatherMeta(weather) {
    if (!weather) {
        return '欢迎来到酒馆';
    }

    const temperature = typeof weather.temperature === 'number' ? `${Math.round(weather.temperature)}°C` : '--';
    const windSpeed = typeof weather.windSpeed === 'number' ? `${weather.windSpeed.toFixed(1)} m/s` : '--';
    return `${temperature} · ${getWeatherLabel(weather.weatherCode)} · 风速 ${windSpeed}`;
}

function getWelcomePayload(weather) {
    const holidayGreeting = '';
    const title = holidayGreeting ? `${getTimeGreeting()} · ${holidayGreeting}` : getTimeGreeting();

    return {
        mode: 'welcome',
        title,
        message: `愿好运与你常在。${getWeatherActivitySuggestion(weather)}`,
        meta: getWeatherMeta(weather),
    };
}

function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('timeout')), timeoutMs);
        promise
            .then(value => {
                window.clearTimeout(timer);
                resolve(value);
            })
            .catch(error => {
                window.clearTimeout(timer);
                reject(error);
            });
    });
}

async function fetchHolidayGreeting(date = new Date()) {
    const fallbackGreeting = getPositiveHolidayGreeting(date);
    const dateStamp = date.toISOString().slice(0, 10);

    try {
        const response = await withTimeout(fetch(`https://timor.tech/api/holiday/info/${dateStamp}`, { method: 'GET' }), HOLIDAY_API_TIMEOUT_MS);
        if (!response.ok) {
            throw new Error(`holiday request failed: ${response.status}`);
        }

        const data = await response.json();
        const holidayName = data?.holiday?.name;
        if (typeof holidayName === 'string' && HOLIDAY_GREETING_WHITELIST.has(holidayName)) {
            return HOLIDAY_GREETING_WHITELIST.get(holidayName) || '';
        }
    } catch (error) {
        console.debug(`${EXTENSION_TAG} holiday unavailable`, error);
    }

    return fallbackGreeting;
}

async function getHolidayGreetingOnce() {
    if (holidayPromise) {
        return holidayPromise;
    }

    holidayPromise = fetchHolidayGreeting().finally(() => {
        holidayPromise = null;
    });

    return holidayPromise;
}

function isOnHomepage() {
    const welcomePanel = document.querySelector('.welcomePanel');
    if (!(welcomePanel instanceof HTMLElement)) {
        return false;
    }

    const style = window.getComputedStyle(welcomePanel);
    if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
    }

    const rect = welcomePanel.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function getWeatherTone(weatherCode) {
    if (SUNNY_WEATHER_CODES.has(weatherCode)) {
        return 'sunny';
    }

    if (RAINY_WEATHER_CODES.has(weatherCode)) {
        return 'rainy';
    }

    if (SNOWY_WEATHER_CODES.has(weatherCode)) {
        return 'snowy';
    }

    if (STORM_WEATHER_CODES.has(weatherCode)) {
        return 'stormy';
    }

    return 'cloudy';
}

function getWeatherMessage(weather) {
    const duration = formatDuration(activeUsageMs);
    const dailyTotal = formatDuration(dailyUsageMs);

    if (!weather) {
        return `你已经连续使用 ${duration} 了，今天累计使用 ${dailyTotal}，建议起来活动一下，顺便喝口水。`;
    }

    return `你已经连续使用 ${duration} 了，今天累计使用 ${dailyTotal}，${getWeatherActivitySuggestion(weather)}`;
}

function getReminderPayload(type, weather) {
    const duration = formatDuration(activeUsageMs);

    if (type === 'combined') {
        return {
            mode: 'combined',
            title: '休息一下',
            message: `${getWeatherMessage(weather)} 也别忘了做一次 20-20-20 护眼：看向 20 英尺外 20 秒。`,
            meta: `已连续活跃 ${duration} · 今日累计 ${formatDuration(dailyUsageMs)}`,
        };
    }

    if (type === 'eye') {
        return {
            mode: 'eye',
            title: '20-20-20 护眼提醒',
            message: `你已经连续看屏幕 ${duration} 了，今天累计使用 ${formatDuration(dailyUsageMs)}，看看 20 英尺外至少 20 秒，让眼睛放松一下。`,
            meta: `每 20 分钟循环提醒 · 今日累计 ${formatDuration(dailyUsageMs)}`,
        };
    }

    return {
        mode: 'posture',
        title: '起身走走',
        message: getWeatherMessage(weather),
        meta: `已连续活跃 ${duration} · 今日累计 ${formatDuration(dailyUsageMs)}`,
    };
}

function hideReminderIsland(immediate = false) {
    if (!(reminderIsland instanceof HTMLElement)) {
        return;
    }

    clearReminderHideTimer();
    reminderIsland.classList.toggle('liquid-reminder-visible', false);
    reminderIsland.classList.toggle('liquid-reminder-hiding', !immediate);

    if (immediate) {
        reminderIsland.classList.remove('liquid-reminder-hiding');
    }
}

function showReminderIsland(payload) {
    if (!(reminderIsland instanceof HTMLElement) || !(reminderTitle instanceof HTMLElement) || !(reminderMessage instanceof HTMLElement) || !(reminderMeta instanceof HTMLElement)) {
        return;
    }

    reminderTitle.textContent = payload.title;
    reminderMessage.textContent = payload.message;
    reminderMeta.textContent = payload.meta;
    reminderIsland.dataset.mode = payload.mode || 'default';
    reminderIsland.classList.remove('liquid-reminder-hiding');
    reminderIsland.classList.remove('liquid-reminder-visible');
    void reminderIsland.offsetWidth;
    reminderIsland.classList.add('liquid-reminder-visible');

    clearReminderHideTimer();
    reminderHideTimer = window.setTimeout(() => {
        hideReminderIsland();
    }, REMINDER_AUTO_HIDE_MS);
}

function createReminderIsland() {
    if (reminderIsland instanceof HTMLElement) {
        return reminderIsland;
    }

    const island = document.createElement('section');
    island.className = 'liquid-reminder-island';
    island.setAttribute('role', 'status');
    island.setAttribute('aria-live', 'polite');

    island.innerHTML = `
        <div class="liquid-reminder-body">
            <div class="liquid-reminder-copy">
                <div class="liquid-reminder-title"></div>
                <div class="liquid-reminder-message"></div>
                <div class="liquid-reminder-meta"></div>
            </div>
            <div class="liquid-reminder-actions">
                <button type="button" class="menu_button liquid-reminder-action" data-action="snooze">5 分钟后</button>
                <button type="button" class="menu_button liquid-reminder-action" data-action="disable">今天不再提醒</button>
                <button type="button" class="menu_button liquid-reminder-close" data-action="close" aria-label="关闭提醒">×</button>
            </div>
        </div>
    `;

    island.addEventListener('pointerenter', clearReminderHideTimer);
    island.addEventListener('pointerleave', () => {
        clearReminderHideTimer();
        reminderHideTimer = window.setTimeout(() => hideReminderIsland(), REMINDER_AUTO_HIDE_MS / 2);
    });
    island.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const action = target.closest('[data-action]')?.getAttribute('data-action');

        if (action === 'snooze') {
            persistSnoozeUntil(Date.now() + getReminderSnoozeMs());
            hideReminderIsland();
            return;
        }

        if (action === 'disable') {
            setReminderDisabledToday();
            return;
        }

        if (action === 'close') {
            hideReminderIsland();
        }
    });

    document.body.appendChild(island);
    reminderIsland = island;
    reminderTitle = island.querySelector('.liquid-reminder-title');
    reminderMessage = island.querySelector('.liquid-reminder-message');
    reminderMeta = island.querySelector('.liquid-reminder-meta');
    return island;
}

function getCurrentPosition() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('geolocation unavailable'));
            return;
        }

        navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: false,
            timeout: 10000,
            maximumAge: WEATHER_CACHE_MS,
        });
    });
}

async function fetchWeatherContext() {
    const now = Date.now();
    if (cachedWeather && now - cachedWeather.fetchedAt < WEATHER_CACHE_MS) {
        return cachedWeather;
    }

    const position = await getCurrentPosition();
    const latitude = position.coords.latitude;
    const longitude = position.coords.longitude;
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(latitude));
    url.searchParams.set('longitude', String(longitude));
    url.searchParams.set('current', 'weather_code,temperature_2m,is_day,wind_speed_10m');
    url.searchParams.set('timezone', 'auto');

    const response = await fetch(url.toString(), { method: 'GET' });
    if (!response.ok) {
        throw new Error(`weather request failed: ${response.status}`);
    }

    const data = await response.json();
    const current = data?.current;

    if (!current || typeof current.weather_code !== 'number') {
        throw new Error('weather payload missing current data');
    }

    cachedWeather = {
        weatherCode: current.weather_code,
        temperature: current.temperature_2m,
        windSpeed: current.wind_speed_10m,
        isDay: current.is_day,
        fetchedAt: now,
    };

    return cachedWeather;
}

async function getWeatherContextOnce() {
    if (cachedWeather && Date.now() - cachedWeather.fetchedAt < WEATHER_CACHE_MS) {
        return cachedWeather;
    }

    if (weatherPromise) {
        return weatherPromise;
    }

    weatherPromise = fetchWeatherContext()
        .catch(error => {
            console.debug(`${EXTENSION_TAG} weather unavailable`, error);
            return null;
        })
        .finally(() => {
            weatherPromise = null;
        });

    return weatherPromise;
}

async function triggerReminder(type) {
    createReminderIsland();

    const needsWeather = type === 'posture' || type === 'combined';
    const weather = needsWeather ? await getWeatherContextOnce() : null;
    const payload = getReminderPayload(type, weather);
    showReminderIsland(payload);
}

async function maybeShowWelcomeIsland() {
    if (hasShownWelcomeIsland || !isOnHomepage()) {
        return;
    }

    hasShownWelcomeIsland = true;
    createReminderIsland();

    const [weather, holidayGreeting] = await Promise.all([
        getWeatherContextOnce().catch(() => null),
        getHolidayGreetingOnce().catch(() => ''),
    ]);

    const payload = getWelcomePayload(weather);
    if (holidayGreeting) {
        payload.title = `${payload.title} · ${holidayGreeting}`;
    }

    showReminderIsland(payload);
}

function clearWelcomeIslandCheck() {
    if (welcomeCheckTimerId) {
        window.clearInterval(welcomeCheckTimerId);
        welcomeCheckTimerId = 0;
    }
}

function scheduleWelcomeIslandCheck() {
    if (hasShownWelcomeIsland || welcomeCheckTimerId) {
        return;
    }

    welcomeCheckStartedAt = Date.now();
    welcomeCheckTimerId = window.setInterval(() => {
        if (hasShownWelcomeIsland) {
            clearWelcomeIslandCheck();
            return;
        }

        if (Date.now() - welcomeCheckStartedAt >= WELCOME_CHECK_TIMEOUT_MS) {
            clearWelcomeIslandCheck();
            return;
        }

        if (!isOnHomepage()) {
            return;
        }

        clearWelcomeIslandCheck();
        maybeShowWelcomeIsland().catch(error => {
            console.debug(`${EXTENSION_TAG} welcome island failed`, error);
        });
    }, WELCOME_CHECK_INTERVAL_MS);
}

function advanceReminderThresholds(nowMs) {
    while (nextEyeReminderAt <= nowMs) {
        nextEyeReminderAt += DEFAULT_EYE_CARE_INTERVAL_MS;
    }

    while (nextPostureReminderAt <= nowMs) {
        nextPostureReminderAt += DEFAULT_POSTURE_INTERVAL_MS;
    }
}

async function evaluateReminders() {
    if (isReminderDisabledToday()) {
        hideReminderIsland(true);
        return;
    }

    if (snoozeUntil > Date.now()) {
        return;
    }

    if (snoozeUntil > 0) {
        persistSnoozeUntil(0);
    }

    const dueEye = activeUsageMs >= nextEyeReminderAt;
    const duePosture = activeUsageMs >= nextPostureReminderAt;

    if (!dueEye && !duePosture) {
        return;
    }

    const type = dueEye && duePosture ? 'combined' : duePosture ? 'posture' : 'eye';
    advanceReminderThresholds(activeUsageMs);
    await triggerReminder(type);
}

async function reminderTick() {
    syncUsageDay();
    const now = Date.now();
    const delta = Math.max(0, now - lastTickAt);
    lastTickAt = now;

    const isVisible = !document.hidden;
    const isActive = isVisible && now - lastActivityAt <= ACTIVE_IDLE_TIMEOUT_MS;

    if (isActive) {
        activeUsageMs += delta;
        dailyUsageMs += delta;
        await evaluateReminders();
    }
}

function installReminderIsland() {
    cleanupReminderStorage();
    createReminderIsland();
    markUserActivity();

    ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'].forEach(eventName => {
        document.addEventListener(eventName, markUserActivity, { passive: true });
    });

    document.addEventListener('visibilitychange', () => {
        lastTickAt = Date.now();
        if (!document.hidden) {
            markUserActivity();
        }
    });

    if (!reminderTimerId) {
        reminderTimerId = window.setInterval(() => {
            reminderTick().catch(error => {
                console.debug(`${EXTENSION_TAG} reminder tick failed`, error);
            });
        }, REMINDER_TICK_MS);
    }

    scheduleWelcomeIslandCheck();
}

function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

async function afterPaint(frameCount = 1) {
    for (let i = 0; i < frameCount; i++) {
        await nextFrame();
    }
}

function setPendingChatTransition(active) {
    document.body?.classList.toggle(BODY_CHAT_PREPARING_CLASS, active);
}

function toPx(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function rectFromEdges(left, top, right, bottom) {
    return {
        left,
        top,
        right,
        bottom,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
    };
}

function rectFromDomRect(rect) {
    return rectFromEdges(rect.left, rect.top, rect.right, rect.bottom);
}

function getElementRect(element) {
    if (!(element instanceof HTMLElement)) {
        return null;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rectFromDomRect(rect) : null;
}

function getInnerRect(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return rectFromEdges(
        rect.left + toPx(style.borderLeftWidth) + toPx(style.paddingLeft),
        rect.top + toPx(style.borderTopWidth) + toPx(style.paddingTop),
        rect.right - toPx(style.borderRightWidth) - toPx(style.paddingRight),
        rect.bottom - toPx(style.borderBottomWidth) - toPx(style.paddingBottom),
    );
}

function intersectRects(a, b) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);

    if (right <= left || bottom <= top) {
        return null;
    }

    return rectFromEdges(left, top, right, bottom);
}

function hasVisualBoundary(element, cardRect) {
    const style = getComputedStyle(element);
    const borderSum =
        toPx(style.borderTopWidth) +
        toPx(style.borderRightWidth) +
        toPx(style.borderBottomWidth) +
        toPx(style.borderLeftWidth);
    const outlineWidth = toPx(style.outlineWidth);

    if (borderSum <= 0 && outlineWidth <= 0) {
        return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width >= cardRect.width + 8 && rect.height >= cardRect.height + 8;
}

function resolveExpansionRect(card) {
    const panel = card.closest('.welcomePanel');
    const chatMessage = card.closest('.mes');
    const chatRoot = document.getElementById('chat');

    const cardRect = card.getBoundingClientRect();

    /** @type {HTMLElement[]} */
    const chain = [];
    let node = panel instanceof HTMLElement ? panel : card.parentElement;

    while (node instanceof HTMLElement) {
        chain.push(node);
        if (node.id === 'chat') {
            break;
        }
        node = node.parentElement;
    }

    let boundaryElement = null;
    for (const candidate of chain) {
        if (hasVisualBoundary(candidate, cardRect)) {
            boundaryElement = candidate;
        }
    }

    if (!(boundaryElement instanceof HTMLElement)) {
        boundaryElement = (chatMessage instanceof HTMLElement ? chatMessage : panel) || card.parentElement;
    }

    if (!(boundaryElement instanceof HTMLElement)) {
        return null;
    }

    const boundaryRect = getInnerRect(boundaryElement);
    const chatRect = chatRoot instanceof HTMLElement ? getInnerRect(chatRoot) : null;
    const viewportRect = rectFromEdges(0, 0, window.innerWidth, window.innerHeight);

    let targetRect = chatRect || boundaryRect;

    const viewportClipped = intersectRects(targetRect, viewportRect);
    if (viewportClipped) {
        targetRect = viewportClipped;
    }

    console.debug(`${EXTENSION_TAG} resolveExpansionRect`, {
        boundary: {
            tag: boundaryElement.tagName,
            id: boundaryElement.id || null,
            className: boundaryElement.className || '',
        },
        boundaryRect,
        chatRect,
        viewportRect,
        finalTargetRect: targetRect,
        showMoreExpanded: panel instanceof HTMLElement
            ? Boolean(panel.querySelector('button.showMoreChats.rotated'))
            : false,
    });

    return targetRect.width > 0 && targetRect.height > 0 ? targetRect : null;
}

function isInteractiveTarget(target) {
    return Boolean(target.closest('button, a, input, textarea, select, option, label, [contenteditable="true"], .chatActions, .mes_button'));
}

function readCssVariable(element, name) {
    const value = getComputedStyle(element).getPropertyValue(name).trim();
    return value || '';
}

function getConversationMessages(chatRoot) {
    if (!(chatRoot instanceof HTMLElement)) {
        return [];
    }

    return Array.from(chatRoot.querySelectorAll(':scope > .mes')).filter(message => {
        if (!(message instanceof HTMLElement)) {
            return false;
        }

        return message.getAttribute('is_system') !== 'true' && message.getAttribute('type') !== 'assistant_message';
    });
}

function getLatestAssistantMessage(chatRoot) {
    if (!(chatRoot instanceof HTMLElement)) {
        return null;
    }

    const messages = Array.from(chatRoot.querySelectorAll(':scope > .mes[is_user="false"]')).filter(message => {
        if (!(message instanceof HTMLElement)) {
            return false;
        }

        return message.getAttribute('is_system') !== 'true' && message.getAttribute('type') !== 'assistant_message';
    });

    return messages.at(-1) || null;
}

function getIdentityAnchorRects(message) {
    if (!(message instanceof HTMLElement)) {
        return {
            avatarElement: null,
            nameElement: null,
            anchorElement: null,
            avatarRect: null,
            nameRect: null,
            anchorRect: null,
        };
    }

    const avatarElement = message.querySelector('.mesAvatarWrapper .avatar');
    const nameElement = message.querySelector('.mes_block .ch_name .name_text');
    const headerElement = message.querySelector('.mes_block .ch_name');
    const blockElement = message.querySelector('.mes_block');
    const anchorElement = headerElement instanceof HTMLElement
        ? headerElement
        : nameElement instanceof HTMLElement
            ? nameElement
            : avatarElement instanceof HTMLElement
                ? avatarElement
                : blockElement instanceof HTMLElement
                    ? blockElement
                    : message;

    return {
        avatarElement: avatarElement instanceof HTMLElement ? avatarElement : null,
        nameElement: nameElement instanceof HTMLElement ? nameElement : null,
        anchorElement,
        avatarRect: getElementRect(avatarElement),
        nameRect: getElementRect(nameElement),
        anchorRect: getElementRect(anchorElement),
    };
}

async function waitForChatSwap(card, timeoutMs = CHAT_READY_TIMEOUT_MS, onDetected = null) {
    const notifyDetected = chatRoot => {
        if (chatRoot instanceof HTMLElement && typeof onDetected === 'function') {
            onDetected(chatRoot);
        }
    };

    const startedAt = performance.now();

    while (performance.now() - startedAt < timeoutMs) {
        const chatRoot = document.getElementById('chat');
        if (chatRoot instanceof HTMLElement && (!card.isConnected || !chatRoot.contains(card))) {
            notifyDetected(chatRoot);
            await afterPaint(2);
            return chatRoot;
        }

        await nextFrame();
    }

    const chatRoot = document.getElementById('chat');
    notifyDetected(chatRoot);
    await afterPaint(2);
    return chatRoot;
}

async function smoothScrollChatToBottom(chatRoot, animated) {
    if (!(chatRoot instanceof HTMLElement)) {
        return;
    }

    const maxScrollTop = Math.max(0, chatRoot.scrollHeight - chatRoot.clientHeight);
    const distance = maxScrollTop - chatRoot.scrollTop;

    if (distance <= 2) {
        return;
    }

    if (!animated) {
        chatRoot.scrollTop = maxScrollTop;
        await afterPaint(1);
        return;
    }

    const expectedDuration = Math.min(SCROLL_MAX_DURATION_MS, Math.max(180, Math.round(distance * 0.45)));

    try {
        chatRoot.scrollTo({
            top: maxScrollTop,
            behavior: 'smooth',
        });
    } catch {
        chatRoot.scrollTop = maxScrollTop;
        await afterPaint(1);
        return;
    }

    const startedAt = performance.now();
    while (performance.now() - startedAt < expectedDuration + 160) {
        if (Math.abs(maxScrollTop - chatRoot.scrollTop) <= 2) {
            break;
        }

        await delay(16);
    }

    chatRoot.scrollTop = Math.max(0, chatRoot.scrollHeight - chatRoot.clientHeight);
    await afterPaint(1);
}

function prepareChatForTransition(chatRoot) {
    if (!(chatRoot instanceof HTMLElement)) {
        return;
    }

    chatRoot.classList.add('liquid-recent-chat-transitioning', 'liquid-recent-chat-obscured');
    setPendingChatTransition(false);
}

function clearChatTransitionState(chatRoot) {
    setPendingChatTransition(false);

    if (!(chatRoot instanceof HTMLElement)) {
        return;
    }

    chatRoot.classList.remove('liquid-recent-chat-obscured', 'liquid-recent-chat-transitioning');
}

async function revealChatContent(chatRoot) {
    if (!(chatRoot instanceof HTMLElement)) {
        return;
    }

    chatRoot.classList.remove('liquid-recent-chat-obscured');
    await afterPaint(1);
    await delay(CONTENT_REVEAL_DURATION_MS);
    chatRoot.classList.remove('liquid-recent-chat-transitioning');
}

async function scrollChatToIdentityAnchor(chatRoot, anchorElement) {
    if (!(chatRoot instanceof HTMLElement) || !(anchorElement instanceof HTMLElement)) {
        return;
    }

    const chatRect = getInnerRect(chatRoot);
    const anchorRect = getElementRect(anchorElement);

    if (!chatRect || !anchorRect) {
        return;
    }

    const maxScrollTop = Math.max(0, chatRoot.scrollHeight - chatRoot.clientHeight);
    const desiredScrollTop = clamp(
        chatRoot.scrollTop + (anchorRect.top - chatRect.top) - IDENTITY_FOCUS_TOP_OFFSET_PX,
        0,
        maxScrollTop,
    );

    if (Math.abs(desiredScrollTop - chatRoot.scrollTop) <= 2) {
        return;
    }

    chatRoot.scrollTop = desiredScrollTop;
    await afterPaint(2);
}

function composeTransform({ x = 0, y = 0, scaleX = 1, scaleY = 1, rotate = 0 } = {}) {
    const transforms = [`translate(${x}px, ${y}px)`];

    if (scaleX !== 1 || scaleY !== 1) {
        transforms.push(`scale(${scaleX}, ${scaleY})`);
    }

    if (rotate !== 0) {
        transforms.push(`rotate(${rotate}deg)`);
    }

    return transforms.join(' ');
}

function trackAnimation(store, animation) {
    if (animation) {
        store.push(animation);
    }

    return animation;
}

function startAnimation(store, element, keyframes, options) {
    if (!(element instanceof HTMLElement) || !element.isConnected) {
        return null;
    }

    try {
        return trackAnimation(store, element.animate(keyframes, options));
    } catch {
        return null;
    }
}

function setElementRectStyles(element, rect) {
    if (!(element instanceof HTMLElement) || !rect) {
        return;
    }

    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
}

function copyComputedStyleProperties(sourceElement, targetElement, properties) {
    if (!(sourceElement instanceof HTMLElement) || !(targetElement instanceof HTMLElement)) {
        return;
    }

    const computedStyle = getComputedStyle(sourceElement);
    properties.forEach(property => {
        const value = computedStyle.getPropertyValue(property);
        if (value) {
            targetElement.style.setProperty(property, value);
        }
    });
}

function createFloatingIdentityNode(sourceElement, rect, kind) {
    if (!(sourceElement instanceof HTMLElement) || !rect) {
        return null;
    }

    const layer = document.createElement('div');
    layer.className = `liquid-recent-identity-flight liquid-recent-identity-flight-${kind}`;
    setElementRectStyles(layer, rect);

    const clone = sourceElement.cloneNode(true);
    if (!(clone instanceof HTMLElement)) {
        return null;
    }

    clone.classList.add('liquid-recent-identity-flight-inner');
    clone.style.margin = '0';
    clone.style.maxWidth = 'none';

    if (kind === 'avatar') {
        clone.style.width = '100%';
        clone.style.height = '100%';
        clone.style.display = 'block';
        copyComputedStyleProperties(sourceElement, layer, ['border-radius', 'overflow', 'background-color', 'box-shadow']);
    }

    if (kind === 'name') {
        layer.style.display = 'flex';
        layer.style.alignItems = 'center';
        layer.style.whiteSpace = 'nowrap';
        clone.style.display = 'block';
        clone.style.height = 'auto';
        copyComputedStyleProperties(sourceElement, clone, [
            'color',
            'font-family',
            'font-size',
            'font-style',
            'font-weight',
            'letter-spacing',
            'line-height',
            'text-decoration',
            'text-transform',
            'text-shadow',
            'white-space',
        ]);
    }

    layer.appendChild(clone);
    document.body.appendChild(layer);

    return {
        layer,
        clone,
        sourceRect: rect,
    };
}

function toggleIdentityTargetHidden(elements, hidden) {
    elements.forEach(element => {
        if (element instanceof HTMLElement) {
            element.classList.toggle('liquid-recent-identity-target-hidden', hidden);
        }
    });
}

function releaseIdentityTargets(transitionDom) {
    if (!transitionDom || !Array.isArray(transitionDom.hiddenTargetElements)) {
        return;
    }

    toggleIdentityTargetHidden(transitionDom.hiddenTargetElements, false);
    transitionDom.hiddenTargetElements = [];
}

function animateIdentityFlight(activeAnimations, floatingNode, targetRect, {
    delay: animationDelay = 0,
    duration = IDENTITY_ENTER_DURATION_MS,
    allowScale = true,
} = {}) {
    if (!(floatingNode?.layer instanceof HTMLElement) || !targetRect) {
        return null;
    }

    const startRect = floatingNode.sourceRect || getElementRect(floatingNode.layer);
    if (!startRect) {
        return null;
    }

    const deltaX = targetRect.left - startRect.left;
    const deltaY = targetRect.top - startRect.top;
    const scaleX = allowScale && startRect.width > 0 ? clamp(targetRect.width / startRect.width, 0.72, 1.35) : 1;
    const scaleY = allowScale && startRect.height > 0 ? clamp(targetRect.height / startRect.height, 0.72, 1.35) : 1;

    return startAnimation(activeAnimations, floatingNode.layer, [
        {
            opacity: 1,
            transform: 'translate(0px, 0px) scale(1, 1)',
            filter: 'blur(0px)',
            offset: 0,
        },
        {
            opacity: 1,
            transform: composeTransform({ x: deltaX, y: deltaY, scaleX, scaleY }),
            filter: 'blur(0px)',
            offset: 1,
        },
    ], {
        duration,
        delay: animationDelay,
        easing: 'cubic-bezier(0.18, 0.88, 0.24, 1)',
        fill: 'forwards',
    });
}

function removeFloatingIdentityNodes(transitionDom) {
    for (const floatingNode of [transitionDom?.floatingAvatar, transitionDom?.floatingName]) {
        if (floatingNode?.layer instanceof HTMLElement && floatingNode.layer.isConnected) {
            floatingNode.layer.remove();
        }
    }
}

function removeTransitionPresentation(shell, transitionDom) {
    if (shell instanceof HTMLElement && shell.isConnected) {
        shell.remove();
    }

    if (transitionDom?.content instanceof HTMLElement && transitionDom.content.isConnected) {
        transitionDom.content.remove();
    }

    removeFloatingIdentityNodes(transitionDom);
}

function animateSiblings(card, fromRect, toRect) {
    const list = card.parentElement;
    if (!(list instanceof HTMLElement)) {
        return [];
    }

    const allCards = Array.from(list.querySelectorAll(':scope > .recentChat'));
    const siblings = allCards.filter(el => el !== card && !el.classList.contains('hidden'));

    const pushUp = Math.max(0, fromRect.top - toRect.top);
    const pushDown = Math.max(0, toRect.bottom - fromRect.bottom);

    const animations = [];

    for (const sibling of siblings) {
        if (!(sibling instanceof HTMLElement)) {
            continue;
        }

        const siblingRect = sibling.getBoundingClientRect();
        let shift = 0;

        if (siblingRect.bottom <= fromRect.top + 1) {
            shift = -pushUp;
        } else if (siblingRect.top >= fromRect.bottom - 1) {
            shift = pushDown;
        }

        if (Math.abs(shift) < 1) {
            continue;
        }

        const distanceToCard = Math.abs((siblingRect.top + siblingRect.height / 2) - (fromRect.top + fromRect.height / 2));
        const attenuation = Math.max(0.72, 1 - distanceToCard / Math.max(320, toRect.height));
        const actualShift = shift * attenuation;

        const animation = sibling.animate(
            [
                { transform: 'translateY(0px)', opacity: 1, offset: 0 },
                { transform: `translateY(${actualShift}px)`, opacity: 0.84, offset: 0.82 },
                { transform: `translateY(${actualShift * 0.96}px)`, opacity: 0.8, offset: 1 },
            ],
            {
                duration: ANIMATION_DURATION_MS,
                easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)',
                fill: 'forwards',
            },
        );

        animations.push(animation);
    }

    return animations;
}

function waitForAnimations(animations, fallbackMs) {
    const filteredAnimations = animations.filter(Boolean);
    if (!filteredAnimations.length) {
        return delay(fallbackMs);
    }

    const finishes = filteredAnimations.map(animation => {
        try {
            return animation.finished.catch(() => undefined);
        } catch {
            return Promise.resolve();
        }
    });

    return Promise.race([
        Promise.allSettled(finishes),
        delay(fallbackMs),
    ]);
}

function createTransitionContent(card, toRect) {
    const content = document.createElement('div');
    content.className = 'liquid-recent-transition-content';
    content.style.left = `${toRect.left}px`;
    content.style.top = `${toRect.top}px`;
    content.style.width = `${toRect.width}px`;
    content.style.height = `${toRect.height}px`;

    const cardClone = card.cloneNode(true);
    if (!(cardClone instanceof HTMLElement)) {
        return null;
    }

    const sourceAvatarElement = card.querySelector('.avatar');
    const sourceNameElement = card.querySelector('.characterName') || card.querySelector('.chatName');
    const sourceAvatarRect = getElementRect(sourceAvatarElement);
    const sourceNameRect = getElementRect(sourceNameElement);

    cardClone.classList.remove('liquid-recent-origin-active');
    cardClone.classList.add('liquid-recent-transition-card');

    const actions = cardClone.querySelector('.chatActions');
    if (actions instanceof HTMLElement) {
        actions.remove();
    }

    const avatarPlaceholder = cardClone.querySelector('.avatar');
    const namePlaceholder = cardClone.querySelector('.chatName');
    const chatDate = cardClone.querySelector('.chatDate');
    const messageContainer = cardClone.querySelector('.chatMessageContainer');
    const pinned = cardClone.querySelector('.recentChatPinned');

    if (avatarPlaceholder instanceof HTMLElement) {
        avatarPlaceholder.classList.add('liquid-recent-identity-placeholder');
    }

    if (namePlaceholder instanceof HTMLElement) {
        namePlaceholder.classList.add('liquid-recent-identity-placeholder');
    }

    for (const metaElement of [chatDate, messageContainer, pinned]) {
        if (metaElement instanceof HTMLElement) {
            metaElement.classList.add('liquid-recent-meta-item');
        }
    }

    content.appendChild(cardClone);
    document.body.appendChild(content);

    return {
        content,
        cardClone,
        metaItems: [chatDate, messageContainer, pinned].filter(element => element instanceof HTMLElement),
        sourceAvatarRect,
        sourceNameRect,
        floatingAvatar: createFloatingIdentityNode(sourceAvatarElement, sourceAvatarRect, 'avatar'),
        floatingName: createFloatingIdentityNode(sourceNameElement, sourceNameRect, 'name'),
        hiddenTargetElements: [],
    };
}

async function playEmptyIdentityExit(transitionDom, activeAnimations, fromRect) {
    if (!transitionDom) {
        return;
    }

    const directionX = fromRect.left + fromRect.width / 2 < window.innerWidth / 2 ? 136 : -136;
    const elements = [transitionDom.floatingAvatar?.layer, transitionDom.floatingName?.layer].filter(element => element instanceof HTMLElement);
    const exitAnimations = [];

    elements.forEach((element, index) => {
        const animation = startAnimation(activeAnimations, element, [
            {
                opacity: 1,
                transform: 'translate(0px, 0px) scale(1)',
                filter: 'blur(0px)',
                offset: 0,
            },
            {
                opacity: 1,
                transform: `translate(${index * 8}px, -6px) scale(1.02)`,
                filter: 'blur(0px)',
                offset: 0.28,
            },
            {
                opacity: 0,
                transform: `translate(${directionX + index * 24}px, -${72 + index * 10}px) scale(0.86) rotate(${directionX > 0 ? 10 : -10}deg)`,
                filter: 'blur(6px)',
                offset: 1,
            },
        ], {
            duration: EMPTY_EXIT_DURATION_MS,
            delay: index * 32,
            easing: 'cubic-bezier(0.24, 0.84, 0.22, 1)',
            fill: 'forwards',
        });

        if (animation) {
            exitAnimations.push(animation);
        }
    });

    await waitForAnimations(exitAnimations, EMPTY_EXIT_DURATION_MS + 120);
}

async function runIdentityChoreography(card, transitionDom, activeAnimations, fromRect, positioningDone, shell) {
    if (!transitionDom) {
        return;
    }

    /** @type {HTMLElement | null} */
    let chatRoot = null;

    try {
        await delay(CLICK_REPLAY_DELAY_MS + 24);
        await afterPaint(2);

        const hasConnectedTransitionLayer =
            (transitionDom.content instanceof HTMLElement && transitionDom.content.isConnected)
            || (transitionDom.floatingAvatar?.layer instanceof HTMLElement && transitionDom.floatingAvatar.layer.isConnected)
            || (transitionDom.floatingName?.layer instanceof HTMLElement && transitionDom.floatingName.layer.isConnected);

        if (!hasConnectedTransitionLayer) {
            return;
        }

        chatRoot = await waitForChatSwap(card, CHAT_READY_TIMEOUT_MS, prepareChatForTransition);
        const hasConnectedIdentityLayer =
            (transitionDom.content instanceof HTMLElement && transitionDom.content.isConnected)
            || (transitionDom.floatingAvatar?.layer instanceof HTMLElement && transitionDom.floatingAvatar.layer.isConnected)
            || (transitionDom.floatingName?.layer instanceof HTMLElement && transitionDom.floatingName.layer.isConnected);

        if (!(chatRoot instanceof HTMLElement) || !hasConnectedIdentityLayer) {
            return;
        }

        prepareChatForTransition(chatRoot);
        await afterPaint(1);

        let messages = getConversationMessages(chatRoot);
        if (messages.length === 0) {
            await playEmptyIdentityExit(transitionDom, activeAnimations, fromRect);
            await positioningDone;
            removeTransitionPresentation(shell, transitionDom);
            await revealChatContent(chatRoot);
            return;
        }

        let latestAssistantMessage = getLatestAssistantMessage(chatRoot);
        const { anchorElement: targetAnchorElement } = getIdentityAnchorRects(latestAssistantMessage);
        await scrollChatToIdentityAnchor(chatRoot, targetAnchorElement);
        await afterPaint(2);

        messages = getConversationMessages(chatRoot);
        latestAssistantMessage = getLatestAssistantMessage(chatRoot);
        const {
            avatarElement: targetAvatarElement,
            nameElement: targetNameElement,
            avatarRect: targetAvatarRect,
            nameRect: targetNameRect,
        } = getIdentityAnchorRects(latestAssistantMessage);

        const hiddenTargetElements = [
            targetAvatarRect && transitionDom.floatingAvatar?.layer instanceof HTMLElement ? targetAvatarElement : null,
            targetNameRect && transitionDom.floatingName?.layer instanceof HTMLElement ? targetNameElement : null,
        ].filter(element => element instanceof HTMLElement);

        transitionDom.hiddenTargetElements = hiddenTargetElements;
        toggleIdentityTargetHidden(hiddenTargetElements, true);

        try {
            const identityAnimations = [];
            const avatarAnimation = animateIdentityFlight(activeAnimations, transitionDom.floatingAvatar, targetAvatarRect, {
                allowScale: true,
            });
            const nameAnimation = animateIdentityFlight(activeAnimations, transitionDom.floatingName, targetNameRect, {
                delay: 44,
                duration: IDENTITY_ENTER_DURATION_MS + 40,
                allowScale: false,
            });

            if (avatarAnimation) {
                identityAnimations.push(avatarAnimation);
            }

            if (nameAnimation) {
                identityAnimations.push(nameAnimation);
            }

            if (identityAnimations.length) {
                await waitForAnimations(identityAnimations, IDENTITY_ENTER_DURATION_MS + 200);
            }
        } finally {
            removeFloatingIdentityNodes(transitionDom);
            releaseIdentityTargets(transitionDom);
        }

        await positioningDone;
        removeTransitionPresentation(shell, transitionDom);
        await revealChatContent(chatRoot);
        await smoothScrollChatToBottom(chatRoot, true);
    } finally {
        clearChatTransitionState(chatRoot);
    }
}

function playActivationTransition(card) {
    if (!(card instanceof HTMLElement)) {
        return emptyTransition();
    }

    const panel = card.closest('.welcomePanel');
    if (!(panel instanceof HTMLElement)) {
        return emptyTransition();
    }

    const fromRect = card.getBoundingClientRect();
    const toRect = resolveExpansionRect(card);

    if (!toRect || fromRect.width <= 0 || fromRect.height <= 0) {
        console.debug(`${EXTENSION_TAG} skip transition: invalid rect`, {
            fromRect,
            toRect,
        });

        return emptyTransition();
    }

    const cardStyle = getComputedStyle(card);
    const borderColor = cardStyle.borderColor || readCssVariable(card, '--SmartThemeBorderColor') || 'rgba(255, 255, 255, 0.35)';
    const accentColor = readCssVariable(card, '--SmartThemeQuoteColor') || borderColor;
    const shadowColor = readCssVariable(card, '--black70a') || 'rgba(0, 0, 0, 0.5)';
    const cardRadius = cardStyle.borderRadius || '10px';

    const shell = document.createElement('div');
    shell.className = 'liquid-recent-transition-shell';
    shell.style.left = `${fromRect.left}px`;
    shell.style.top = `${fromRect.top}px`;
    shell.style.width = `${fromRect.width}px`;
    shell.style.height = `${fromRect.height}px`;
    shell.style.setProperty('--liquid-recent-border', borderColor);
    shell.style.setProperty('--liquid-recent-accent', accentColor);
    shell.style.setProperty('--liquid-recent-shadow', shadowColor);
    shell.style.setProperty('--liquid-recent-bg', cardStyle.backgroundColor || 'transparent');
    shell.style.setProperty('--liquid-recent-radius', cardRadius);

    const glow = document.createElement('div');
    glow.className = 'liquid-recent-transition-glow';
    shell.appendChild(glow);

    document.body.appendChild(shell);

    const activeAnimations = [];
    const layoutPush = Math.max(0, toRect.bottom - fromRect.bottom);

    panel.classList.add('liquid-recent-animating');
    panel.style.setProperty('--liquid-recent-layout-push', `${Math.round(layoutPush)}px`);
    card.classList.add('liquid-recent-origin-active');

    const transitionDom = createTransitionContent(card, toRect);

    const siblingAnimations = animateSiblings(card, fromRect, toRect);
    activeAnimations.push(...siblingAnimations);

    const overlayAnimation = trackAnimation(activeAnimations, shell.animate(
        [
            {
                left: `${fromRect.left}px`,
                top: `${fromRect.top}px`,
                width: `${fromRect.width}px`,
                height: `${fromRect.height}px`,
                borderRadius: cardRadius,
                opacity: 0.96,
                boxShadow: `0 0 0 1px ${borderColor}`,
                offset: 0,
            },
            {
                left: `${toRect.left}px`,
                top: `${toRect.top}px`,
                width: `${toRect.width}px`,
                height: `${toRect.height}px`,
                borderRadius: `max(${cardRadius}, 12px)`,
                opacity: 1,
                boxShadow: `0 0 0 1px ${borderColor}, 0 16px 46px ${shadowColor}`,
                offset: 0.78,
            },
            {
                left: `${toRect.left}px`,
                top: `${toRect.top}px`,
                width: `${toRect.width}px`,
                height: `${toRect.height}px`,
                borderRadius: `max(${cardRadius}, 12px)`,
                opacity: 0.34,
                boxShadow: `0 0 0 1px ${borderColor}, 0 26px 56px ${shadowColor}`,
                offset: 1,
            },
        ],
        {
            duration: ANIMATION_DURATION_MS,
            easing: 'cubic-bezier(0.2, 0.86, 0.26, 1)',
            fill: 'forwards',
        },
    ));

    const glowAnimation = trackAnimation(activeAnimations, glow.animate(
        [
            { opacity: 0, transform: 'scale(0.72)' },
            { opacity: 0.42, transform: 'scale(1.04)', offset: 0.62 },
            { opacity: 0, transform: 'scale(1.22)', offset: 1 },
        ],
        {
            duration: ANIMATION_DURATION_MS,
            easing: 'cubic-bezier(0.22, 0.82, 0.3, 1)',
            fill: 'forwards',
        },
    ));

    const overlayDone = waitForAnimations([overlayAnimation, glowAnimation, ...siblingAnimations], ANIMATION_DURATION_MS + 120);
    const choreographyDone = runIdentityChoreography(card, transitionDom, activeAnimations, fromRect, overlayDone, shell).catch(error => {
        console.warn(`${EXTENSION_TAG} identity choreography failed`, error);
    });

    const done = Promise.allSettled([overlayDone, choreographyDone]);

    const cleanup = () => {
        for (const animation of activeAnimations) {
            try {
                animation.cancel();
            } catch {
                // no-op
            }
        }

        setPendingChatTransition(false);
        releaseIdentityTargets(transitionDom);
        card.classList.remove('liquid-recent-origin-active');
        panel.classList.remove('liquid-recent-animating');
        panel.style.removeProperty('--liquid-recent-layout-push');
        removeTransitionPresentation(shell, transitionDom);
    };

    return { done, cleanup };
}

function replayNativeCardClick(card) {
    if (!(card instanceof HTMLElement) || !card.isConnected) {
        return;
    }

    bypassCard = card;
    card.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
    }));
}

async function onDocumentClickCapture(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
        return;
    }

    const card = target.closest('.welcomeRecent .recentChatList .recentChat');
    if (!(card instanceof HTMLElement)) {
        return;
    }

    if (bypassCard === card) {
        bypassCard = null;
        return;
    }

    if (isInteractiveTarget(target)) {
        return;
    }

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (isTransitioning) {
        return;
    }

    isTransitioning = true;
    const transition = playActivationTransition(card);
    let replayed = false;

    try {
        await delay(CLICK_REPLAY_DELAY_MS);
        setPendingChatTransition(true);
        replayNativeCardClick(card);
        replayed = true;

        await transition.done;
        await delay(POST_ANIMATION_SETTLE_MS);
    } catch (error) {
        console.warn(`${EXTENSION_TAG} recent chat transition failed`, error);
        if (!replayed) {
            setPendingChatTransition(true);
            replayNativeCardClick(card);
        }
    } finally {
        transition.cleanup();
        isTransitioning = false;
    }
}

function install() {
    if (isInstalled) {
        return;
    }

    document.addEventListener('click', onDocumentClickCapture, true);
    document.addEventListener('click', onShowMoreChatsClick, true);
    installReminderIsland();
    isInstalled = true;
    console.debug(`${EXTENSION_TAG} installed`);
}

/**
 * @param {MouseEvent} event
 */
function onShowMoreChatsClick(event) {
    const button = event.target;
    if (!(button instanceof HTMLElement)) {
        return;
    }

    const showMoreBtn = button.closest('button.showMoreChats');
    if (!(showMoreBtn instanceof HTMLElement)) {
        return;
    }

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        return;
    }

    const list = showMoreBtn.closest('.recentChatList');
    if (!(list instanceof HTMLElement)) {
        return;
    }

    const isCollapsing = showMoreBtn.classList.contains('rotated');

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (isCollapsing) {
        collapseRecentChats(list, showMoreBtn);
    } else {
        expandRecentChats(list, showMoreBtn);
    }
}

/**
 * @param {HTMLElement} list
 * @param {HTMLElement} showMoreBtn
 */
function expandRecentChats(list, showMoreBtn) {
    const expandDuration = 660;
    const expandOffsetY = 6;
    const accordionEasing = 'cubic-bezier(0.16, 0.92, 0.24, 1)';

    const hiddenItems = Array.from(list.querySelectorAll(':scope > .recentChat.hidden'));
    if (!hiddenItems.length) {
        return;
    }

    const startHeight = list.getBoundingClientRect().height;
    list.style.height = `${startHeight}px`;
    list.style.overflow = 'hidden';

    hiddenItems.forEach(el => {
        el.classList.add('liquid-showmore-revealed');
        el.classList.remove('hidden');
        el.style.opacity = '0';
        el.style.transform = `translateY(-${expandOffsetY}px)`;
    });

    const targetHeight = list.scrollHeight;

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const animations = [];
            animations.push(list.animate(
                [
                    { height: `${startHeight}px` },
                    { height: `${targetHeight}px` },
                ],
                {
                    duration: expandDuration,
                    easing: accordionEasing,
                    fill: 'forwards',
                },
            ));

            hiddenItems.forEach((el, index) => {
                const animation = el.animate(
                    [
                        {
                            opacity: 0,
                            transform: `translateY(-${expandOffsetY}px)`,
                            offset: 0,
                        },
                        {
                            opacity: 1,
                            transform: 'translateY(0px)',
                            offset: 1,
                        },
                    ],
                    {
                        duration: expandDuration,
                        delay: index * 32,
                        easing: accordionEasing,
                        fill: 'forwards',
                    },
                );

                animations.push(animation);
            });

            showMoreBtn.classList.add('rotated');
            showMoreBtn.setAttribute('title', 'Show less recent chats');

            Promise.allSettled(animations.map(a => a.finished.catch(() => undefined))).then(() => {
                list.style.height = '';
                list.style.overflow = '';
                hiddenItems.forEach(el => {
                    el.style.opacity = '';
                    el.style.transform = '';
                });
            });
        });
    });
}

/**
 * @param {HTMLElement} list
 * @param {HTMLElement} showMoreBtn
 */
function collapseRecentChats(list, showMoreBtn) {
    const revealedItems = Array.from(list.querySelectorAll(':scope > .recentChat.liquid-showmore-revealed'));
    if (!revealedItems.length) {
        return;
    }

    const collapseDuration = 500;
    const collapseOffsetY = 6;
    const accordionEasing = 'cubic-bezier(0.16, 0.92, 0.24, 1)';
    const listGap = parseFloat(window.getComputedStyle(list).gap || '0') || 0;
    const startHeight = list.getBoundingClientRect().height;
    let removedHeight = revealedItems.length * listGap;

    revealedItems.forEach(el => {
        const currentHeight = el.scrollHeight || 200;
        removedHeight += el.getBoundingClientRect().height || currentHeight;
        el.style.opacity = '1';
        el.style.transform = 'translateY(0px)';
    });

    const targetHeight = Math.max(0, startHeight - removedHeight);
    list.style.height = `${startHeight}px`;
    list.style.overflow = 'hidden';

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const animations = [];
            animations.push(list.animate(
                [
                    { height: `${startHeight}px` },
                    { height: `${targetHeight}px` },
                ],
                {
                    duration: collapseDuration,
                    easing: accordionEasing,
                    fill: 'forwards',
                },
            ));

            revealedItems.forEach((el, index) => {
                const animation = el.animate(
                    [
                        {
                            opacity: 1,
                            transform: 'translateY(0px)',
                            offset: 0,
                        },
                        {
                            opacity: 0,
                            transform: `translateY(-${collapseOffsetY}px)`,
                            offset: 1,
                        },
                    ],
                    {
                        duration: collapseDuration,
                        delay: (revealedItems.length - 1 - index) * 16,
                        easing: accordionEasing,
                        fill: 'forwards',
                    },
                );

                animations.push(animation);
            });

            showMoreBtn.classList.remove('rotated');
            showMoreBtn.setAttribute('title', 'Show more recent chats');

            Promise.allSettled(animations.map(a => a.finished.catch(() => undefined))).then(() => {
                revealedItems.forEach(el => {
                    el.style.opacity = '0';
                    el.style.transform = `translateY(-${collapseOffsetY}px)`;
                });

                requestAnimationFrame(() => {
                    revealedItems.forEach(el => {
                        el.classList.add('hidden');
                        el.classList.remove('liquid-showmore-revealed');
                        el.style.opacity = '';
                        el.style.transform = '';
                    });

                    list.style.height = '';
                    list.style.overflow = '';
                });
            });
        });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
} else {
    install();
}
