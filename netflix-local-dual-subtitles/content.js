(() => {
  if (globalThis.__netflixLocalDualSubtitlesLoaded) return;
  globalThis.__netflixLocalDualSubtitlesLoaded = true;

  const DEFAULT_SETTINGS = {
    enabled: true,
    sourceLanguage: 'auto',
    overlayX: 50,
    overlayY: 76,
    fontSize: 24,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: 600,
    textColor: '#f6f6f6',
    backgroundColor: '#000000',
    backgroundOpacity: 64
  };
  const cache = new Map();
  const MAX_CACHE_SIZE = 300;
  const SUBTITLE_SETTLE_MS = 40;
  const SUBTITLE_POLL_MS = 150;
  const TRANSLATION_TIMEOUT_MS = 40000;
  const SUBTITLE_SELECTOR = [
    '.player-timedtext-text-container',
    '.player-timedtext',
    '[data-uia*="timedtext"]',
    '[data-uia*="subtitle"]',
    '[class*="subtitle"]'
  ].join(',');
  let currentSettings = { ...DEFAULT_SETTINGS };
  let currentSource = '';
  let currentRequest = 0;
  let pendingTimer = null;
  let retryTimer = null;
  let hideTimer = null;
  let overlay = null;
  let latestAnchor = null;
  let lastTranslation = '';
  let lastRuntimeError = '';
  let translationInFlight = false;
  let pendingTranslation = null;
  let editMode = false;
  let lastLocation = location.href;
  let lastVideo = null;
  let lastSubtitleElement = null;
  let dragFrame = 0;
  let readInterval = null;
  let contextInterval = null;
  let pollingActive = false;

  function normalize(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function visibleRect(element) {
    if (!element || !element.isConnected) return null;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.top < window.innerHeight
      ? rect
      : null;
  }

  function subtitleCandidates() {
    const candidates = [];
    for (const element of document.querySelectorAll(SUBTITLE_SELECTOR)) {
      const rect = visibleRect(element);
      if (!rect) continue;
      // Netflix may place subtitles above the video midpoint (especially
      // when the player is avoiding faces or other on-screen content). Only
      // apply the lower-half filter to the generic fallback selector, not to
      // Netflix's own timed-text elements.
      const isTimedText = element.matches(
        '.player-timedtext-text-container, .player-timedtext, [data-uia*="timedtext"]'
      );
      if (!isTimedText && rect.top < window.innerHeight * 0.45) continue;
      const text = normalize(element.innerText || element.textContent);
      if (!text || text.length > 500) continue;
      const priority = element.matches('.player-timedtext-text-container') ? 0
        : element.matches('.player-timedtext') ? 1
          : element.matches('[data-uia*="timedtext"]') ? 2 : 3;
      candidates.push({ element, rect, text, priority });
    }

    const unique = new Map();
    for (const candidate of candidates) {
      const old = unique.get(candidate.text);
      if (!old || candidate.priority < old.priority
        || (candidate.priority === old.priority && candidate.text.length <= old.text.length)) {
        unique.set(candidate.text, candidate);
      }
    }
    return [...unique.values()].sort((a, b) => {
      return a.priority - b.priority || a.text.length - b.text.length;
    });
  }

  function readSubtitle() {
    if (lastSubtitleElement?.isConnected) {
      const rect = visibleRect(lastSubtitleElement);
      const text = normalize(lastSubtitleElement.innerText || lastSubtitleElement.textContent);
      if (rect && text && text.length <= 500) return { text, rect };
      lastSubtitleElement = null;
    }
    const candidate = subtitleCandidates()[0];
    if (!candidate) return { text: '', rect: null };
    // Cache only Netflix's own timed-text nodes. Generic fallback matches can
    // also be static player UI and would otherwise hide a later real subtitle.
    lastSubtitleElement = candidate.priority < 3 ? candidate.element : null;
    return { text: candidate.text, rect: candidate.rect };
  }

  function guessLanguage(text) {
    if (/[가-힯]/u.test(text)) return 'ko';
    if (/[\u3040-\u30ff]/u.test(text)) return 'ja';
    return 'en';
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, Number(value) || minimum));
  }

  function rgba(hex, opacity) {
    const value = String(hex || '#000000').replace('#', '');
    const normalized = value.length === 3 ? value.split('').map(char => char + char).join('') : value;
    if (!/^[0-9a-f]{6}$/i.test(normalized)) return `rgba(0, 0, 0, ${clamp(opacity, 0, 100) / 100})`;
    const number = Number.parseInt(normalized, 16);
    return `rgba(${number >> 16}, ${(number >> 8) & 255}, ${number & 255}, ${clamp(opacity, 0, 100) / 100})`;
  }

  function applyOverlayPosition() {
    if (!overlay) return;
    const x = (clamp(currentSettings.overlayX, 5, 95) / 100) * window.innerWidth;
    const y = (clamp(currentSettings.overlayY, 5, 95) / 100) * window.innerHeight;
    // Keep the moving part on the compositor. Updating left/top for every
    // pointer event forces layout and is noticeably expensive over Netflix.
    overlay.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
  }

  function applyOverlayStyles() {
    if (!overlay) return;
    applyOverlayPosition();
    Object.assign(overlay.style, {
      color: currentSettings.textColor || '#f6f6f6',
      background: rgba(currentSettings.backgroundColor, currentSettings.backgroundOpacity),
      fontSize: `${clamp(currentSettings.fontSize, 12, 56)}px`,
      fontFamily: currentSettings.fontFamily || 'sans-serif',
      fontWeight: String(currentSettings.fontWeight || 600),
      pointerEvents: editMode ? 'auto' : 'none',
      cursor: editMode ? 'grab' : 'default'
    });
  }

  function handleOverlayPointerDown(event) {
    if (!editMode || event.button !== 0) return;
    event.preventDefault();
    const bounds = overlay.getBoundingClientRect();
    const grabOffsetX = event.clientX - (bounds.left + bounds.width / 2);
    const grabOffsetY = event.clientY - (bounds.top + bounds.height / 2);
    const pointerId = event.pointerId;
    overlay.setPointerCapture?.(pointerId);
    overlay.style.cursor = 'grabbing';
    overlay.style.willChange = 'transform';
    const move = moveEvent => {
      currentSettings.overlayX = clamp(((moveEvent.clientX - grabOffsetX) / window.innerWidth) * 100, 5, 95);
      currentSettings.overlayY = clamp(((moveEvent.clientY - grabOffsetY) / window.innerHeight) * 100, 5, 95);
      if (dragFrame) return;
      dragFrame = requestAnimationFrame(() => {
        dragFrame = 0;
        applyOverlayPosition();
      });
    };
    const finish = () => {
      if (dragFrame) {
        cancelAnimationFrame(dragFrame);
        dragFrame = 0;
      }
      applyOverlayPosition();
      overlay.style.cursor = 'grab';
      if (overlay.hasPointerCapture?.(pointerId)) overlay.releasePointerCapture(pointerId);
      overlay.style.willChange = 'auto';
      overlay.removeEventListener('pointermove', move, true);
      overlay.removeEventListener('pointerup', finish, true);
      overlay.removeEventListener('pointercancel', finish, true);
      chrome.storage.local.set({
        overlayX: currentSettings.overlayX,
        overlayY: currentSettings.overlayY
      });
    };
    overlay.addEventListener('pointermove', move, true);
    overlay.addEventListener('pointerup', finish, true);
    overlay.addEventListener('pointercancel', finish, true);
  }

  function setEditMode(enabled) {
    editMode = Boolean(enabled);
    const target = ensureOverlay();
    applyOverlayStyles();
    if (editMode) {
      showTranslation(lastTranslation || '拖动这里调整中文字幕位置', latestAnchor, false);
    } else if (lastTranslation) {
      showTranslation(lastTranslation, latestAnchor, false);
    } else {
      hideTranslation();
    }
    target.setAttribute('data-nlds-editing', editMode ? 'true' : 'false');
  }

  function ensureOverlay() {
    const root = document.fullscreenElement || document.body || document.documentElement;
    if (overlay?.isConnected) {
      if (overlay.parentElement !== root) root.appendChild(overlay);
      return overlay;
    }
    overlay = document.createElement('div');
    overlay.id = 'nlds-translation-overlay';
    overlay.setAttribute('aria-live', 'polite');
    Object.assign(overlay.style, {
      all: 'initial',
      position: 'fixed',
      zIndex: '2147483647',
      left: '0px',
      top: '0px',
      transform: 'translate3d(50vw, 76vh, 0) translate(-50%, -50%)',
      maxWidth: '82vw',
      padding: '3px 12px 5px',
      borderRadius: '4px',
      background: 'rgba(0, 0, 0, 0.64)',
      color: '#f6f6f6',
      font: '600 24px/1.24 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      textAlign: 'center',
      textShadow: '0 1px 3px rgba(0, 0, 0, .75)',
      pointerEvents: 'none',
      touchAction: 'none',
      userSelect: 'none',
      willChange: 'auto',
      opacity: '0',
      transition: 'opacity 100ms ease',
      whiteSpace: 'pre-line',
      wordBreak: 'break-word'
    });
    overlay.addEventListener('pointerdown', handleOverlayPointerDown);
    root.appendChild(overlay);
    applyOverlayStyles();
    return overlay;
  }

  function resetSubtitleContext() {
    clearTimeout(retryTimer);
    retryTimer = null;
    currentSource = '';
    lastSubtitleElement = null;
    currentRequest += 1;
    latestAnchor = null;
    lastTranslation = '';
    lastRuntimeError = '';
    pendingTranslation = null;
    hideTranslation();
    scheduleRead();
  }

  function refreshTranslationContext() {
    clearTimeout(retryTimer);
    retryTimer = null;
    currentSource = '';
    currentRequest += 1;
    pendingTranslation = null;
    lastTranslation = '';
    lastRuntimeError = '';
    hideTranslation();
    scheduleRead();
  }

  function scheduleTranslationRetry(delay = 800) {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!pollingActive) return;
      currentSource = '';
      scheduleRead();
    }, delay);
  }

  function settingsNeedTranslationRefresh(previous, next) {
    return previous.enabled !== next.enabled || previous.sourceLanguage !== next.sourceLanguage;
  }

  function detectNetflixContextChange() {
    const currentLocation = location.href;
    const currentVideo = document.querySelector('video');
    if (currentLocation !== lastLocation || currentVideo !== lastVideo) {
      lastLocation = currentLocation;
      lastVideo = currentVideo;
      resetSubtitleContext();
    }
  }

  function placeOverlay() {
    ensureOverlay();
    applyOverlayStyles();
  }

  function showTranslation(text, rect, remember = true) {
    const target = ensureOverlay();
    placeOverlay(rect);
    if (remember) lastTranslation = text;
    target.textContent = text;
    target.style.opacity = '1';
    clearTimeout(hideTimer);
  }

  function hideTranslation(delay = 0) {
    clearTimeout(hideTimer);
    if (!overlay) return;
    if (delay <= 0) {
      overlay.style.opacity = '0';
      return;
    }
    hideTimer = setTimeout(() => {
      if (overlay) overlay.style.opacity = '0';
    }, delay);
  }

  function putCache(key, value) {
    cache.set(key, value);
    while (cache.size > MAX_CACHE_SIZE) cache.delete(cache.keys().next().value);
  }

  function continuePendingTranslation() {
    const next = pendingTranslation;
    pendingTranslation = null;
    if (!next || next.generation !== currentRequest || next.source !== currentSource) return;
    requestTranslation(next.source, next.rect, next.generation);
  }

  function requestTranslation(source, rect, generation = currentRequest) {
    const language = currentSettings.sourceLanguage === 'auto'
      ? guessLanguage(source)
      : currentSettings.sourceLanguage;
    const cacheKey = `${language}|zh-CN|${source}`;
    latestAnchor = rect;
    if (cache.has(cacheKey)) {
      pendingTranslation = null;
      if (generation === currentRequest && source === currentSource) {
        showTranslation(cache.get(cacheKey), rect);
      }
      return;
    }

    if (translationInFlight) {
      // Ollama is much faster when it receives one subtitle at a time. Keep
      // only the newest subtitle while the previous request is finishing.
      pendingTranslation = { source, rect, generation };
      return;
    }

    translationInFlight = true;
    const requestId = generation;
    let settled = false;
    const requestTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      translationInFlight = false;
      const isCurrent = requestId === currentRequest && source === currentSource;
      if (isCurrent) {
        const error = '本地翻译请求超时，请检查 Ollama 是否仍在运行。';
        console.warn('[Netflix Local Dual Subtitles]', error);
        lastRuntimeError = error;
        showTranslation(`翻译服务：${error}`, rect, false);
        hideTranslation(3500);
      }
      continuePendingTranslation();
    }, TRANSLATION_TIMEOUT_MS);

    const messageResult = chrome.runtime.sendMessage({
      type: 'translate',
      text: source,
      sourceLanguage: language
    }, response => {
      if (settled) return;
      settled = true;
      clearTimeout(requestTimer);
      translationInFlight = false;
      const isCurrent = requestId === currentRequest && source === currentSource;
      if (chrome.runtime.lastError) {
        if (isCurrent) {
          const error = chrome.runtime.lastError.message || '翻译消息通道已断开。';
          console.warn('[Netflix Local Dual Subtitles]', error);
          lastRuntimeError = error;
          showTranslation(`翻译服务：${error}`, rect, false);
          hideTranslation(3500);
        }
        continuePendingTranslation();
        return;
      }
      if (!response?.ok) {
        const error = response?.error || '本地翻译服务未返回结果。';
        console.warn('[Netflix Local Dual Subtitles]', error);
        const modelBusy = /本地模型正忙|HTTP 429/i.test(error);
        if (isCurrent && modelBusy && !pendingTranslation) {
          currentSource = '';
          scheduleTranslationRetry();
        }
        if (isCurrent && error !== lastRuntimeError) {
          lastRuntimeError = error;
          showTranslation(`翻译服务：${error}`, rect, false);
          hideTranslation(3500);
        }
        continuePendingTranslation();
        return;
      }
      const translated = normalize(response.translated);
      if (translated) {
        lastRuntimeError = '';
        putCache(cacheKey, translated);
        if (isCurrent) {
          const anchor = readSubtitle().rect || latestAnchor;
          showTranslation(translated, anchor);
        }
      } else if (isCurrent) {
        const error = '本地翻译服务返回了空结果。';
        lastRuntimeError = error;
        showTranslation(`翻译服务：${error}`, rect, false);
        hideTranslation(3500);
      }
      continuePendingTranslation();
    });

    // Some MV3 implementations return a Promise even when a callback is
    // supplied. The callback handles runtime.lastError; this handles the
    // equivalent rejected Promise path.
    messageResult?.catch?.(error => {
      if (settled) return;
      settled = true;
      clearTimeout(requestTimer);
      translationInFlight = false;
      const isCurrent = requestId === currentRequest && source === currentSource;
      if (isCurrent) {
        const detail = error?.message || '翻译消息通道已断开。';
        console.warn('[Netflix Local Dual Subtitles]', detail);
        lastRuntimeError = detail;
        showTranslation(`翻译服务：${detail}`, rect, false);
        hideTranslation(3500);
      }
      continuePendingTranslation();
    });
  }

  function scheduleRead() {
    if (!pollingActive) return;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (!pollingActive) return;
      if (!currentSettings.enabled) {
        if (currentSource || pendingTranslation || lastTranslation) currentRequest += 1;
        currentSource = '';
        pendingTranslation = null;
        lastTranslation = '';
        hideTranslation();
        return;
      }

      const { text, rect } = readSubtitle();
      if (!text) {
        if (currentSource || pendingTranslation || lastTranslation) currentRequest += 1;
        currentSource = '';
        pendingTranslation = null;
        lastTranslation = '';
        hideTranslation();
        return;
      }
      if (text === currentSource) {
        if (overlay?.style.opacity !== '1') placeOverlay(rect);
        return;
      }

      clearTimeout(retryTimer);
      retryTimer = null;
      currentSource = text;
      currentRequest += 1;
      latestAnchor = rect;
      lastTranslation = '';
      lastRuntimeError = '';
      hideTranslation();
      requestTranslation(text, rect, currentRequest);
    }, SUBTITLE_SETTLE_MS);
  }

  function startPolling() {
    if (pollingActive) return;
    pollingActive = true;
    readInterval = setInterval(scheduleRead, SUBTITLE_POLL_MS);
    contextInterval = setInterval(detectNetflixContextChange, 500);
    scheduleRead();
  }

  function stopPolling() {
    pollingActive = false;
    clearInterval(readInterval);
    clearInterval(contextInterval);
    readInterval = null;
    contextInterval = null;
    clearTimeout(pendingTimer);
    pendingTimer = null;
    clearTimeout(retryTimer);
    retryTimer = null;
    currentSource = '';
    lastSubtitleElement = null;
    currentRequest += 1;
    pendingTranslation = null;
    lastTranslation = '';
    lastRuntimeError = '';
    hideTranslation();
    if (dragFrame) {
      cancelAnimationFrame(dragFrame);
      dragFrame = 0;
    }
  }

  function notifyRuntime(message) {
    try {
      const result = chrome.runtime.sendMessage(message, () => {
        // Reading lastError prevents an expected disconnect from being logged
        // when the service worker is restarting or the tab is closing.
        void chrome.runtime.lastError;
      });
      result?.catch?.(() => {});
    } catch (_) {
      // The extension may be reloading while the page is being torn down.
    }
  }

  async function init() {
    currentSettings = await chrome.storage.local.get(DEFAULT_SETTINGS);
    notifyRuntime({ type: 'netflixOpened' });
    if (document.hidden) stopPolling();
    else startPolling();
    window.addEventListener('resize', () => {
      applyOverlayPosition();
      scheduleRead();
    }, { passive: true });
    document.addEventListener('fullscreenchange', scheduleRead);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPolling();
      else startPolling();
    });
    window.addEventListener('pagehide', () => {
      stopPolling();
      notifyRuntime({ type: 'netflixClosed' });
    });
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      lastLocation = location.href;
      lastVideo = null;
      notifyRuntime({ type: 'netflixOpened' });
      startPolling();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const previousSettings = { ...currentSettings };
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (changes[key]) currentSettings[key] = changes[key].newValue;
      }
      applyOverlayStyles();
      if (settingsNeedTranslationRefresh(previousSettings, currentSettings)) {
        refreshTranslationContext();
      }
    });

    chrome.runtime.onMessage.addListener(message => {
      if (message?.type !== 'settingsUpdated') return;
      const previousSettings = { ...currentSettings };
      currentSettings = { ...currentSettings, ...message.settings };
      applyOverlayStyles();
      if (settingsNeedTranslationRefresh(previousSettings, currentSettings)) {
        refreshTranslationContext();
      }
    });

    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === 'toggleEditMode') setEditMode(message.enabled);
      if (message?.type === 'runtimeReady') {
        // If a subtitle request is already waiting for native startup, do not
        // invalidate it and send the same subtitle a second time.
        if (!translationInFlight) {
          currentSource = '';
          currentRequest += 1;
          pendingTranslation = null;
          lastTranslation = '';
        }
        lastRuntimeError = '';
        hideTranslation();
        scheduleRead();
      }
    });
  }

  init();
})();
