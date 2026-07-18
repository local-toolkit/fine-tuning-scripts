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
  const MAX_TRANSLATION_RETRIES = 5;
  const NATIVE_SUBTITLE_SELECTOR = [
    '.player-timedtext-text-container',
    '.player-timedtext',
    '[data-uia*="timedtext"]'
  ].join(',');
  const SUBTITLE_SELECTOR = [
    NATIVE_SUBTITLE_SELECTOR,
    '[data-uia*="subtitle"]',
    '[class*="subtitle"]'
  ].join(',');
  const NATIVE_SUBTITLE_STYLE_ID = 'nlds-native-subtitle-style';
  let currentSettings = { ...DEFAULT_SETTINGS };
  let currentSource = '';
  let translationRetryCount = 0;
  let retryingSource = '';
  let currentRequest = 0;
  let pendingTimer = null;
  let retryTimer = null;
  let hideTimer = null;
  let overlay = null;
  let translationLine = null;
  let sourceLine = null;
  let latestAnchor = null;
  let lastTranslation = '';
  let lastRuntimeError = '';
  let translationInFlight = false;
  let pendingTranslation = null;
  let editMode = false;
  let lastLocation = location.href;
  let lastVideo = null;
  let lastSubtitleElement = null;
  let suppressedSubtitleElement = null;
  let suppressedSubtitleStyle = null;
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

  function subtitleText(element) {
    return normalize(element?.innerText || element?.textContent);
  }

  function isNativeSubtitle(element) {
    return Boolean(element?.matches?.(NATIVE_SUBTITLE_SELECTOR));
  }

  function setNativeSubtitleVisibility(hidden) {
    const existing = document.getElementById(NATIVE_SUBTITLE_STYLE_ID);
    if (!hidden) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const style = document.createElement('style');
    style.id = NATIVE_SUBTITLE_STYLE_ID;
    style.textContent = `${NATIVE_SUBTITLE_SELECTOR} { opacity: 0 !important; }`;
    (document.head || document.documentElement).appendChild(style);
  }

  function subtitleRect(element) {
    if (!element || !element.isConnected) return null;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    // The extension hides Netflix's native subtitle after reading it. Keep
    // accepting that element as the source of truth while the custom
    // bilingual overlay is visible.
    if (Number(style.opacity) === 0 && !isNativeSubtitle(element)
      && element !== suppressedSubtitleElement) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.top < window.innerHeight
      ? rect
      : null;
  }

  function restoreNativeSubtitle() {
    if (!suppressedSubtitleElement) return;
    const element = suppressedSubtitleElement;
    if (element.isConnected && suppressedSubtitleStyle) {
      element.style.opacity = suppressedSubtitleStyle.opacity;
      element.style.visibility = suppressedSubtitleStyle.visibility;
      delete element.dataset.nldsSuppressed;
      delete element.dataset.nldsPreviousOpacity;
      delete element.dataset.nldsPreviousVisibility;
    }
    suppressedSubtitleElement = null;
    suppressedSubtitleStyle = null;
  }

  function suppressNativeSubtitle(element) {
    if (!element) return;
    if (suppressedSubtitleElement !== element) {
      restoreNativeSubtitle();
      suppressedSubtitleElement = element;
      suppressedSubtitleStyle = {
        opacity: element.style.opacity,
        visibility: element.style.visibility
      };
    }
    element.dataset.nldsSuppressed = 'true';
    element.dataset.nldsPreviousOpacity = suppressedSubtitleStyle.opacity;
    element.dataset.nldsPreviousVisibility = suppressedSubtitleStyle.visibility;
    element.style.opacity = '0';
  }

  function restorePersistedNativeSubtitles() {
    for (const element of document.querySelectorAll('[data-nlds-suppressed="true"]')) {
      element.style.opacity = element.dataset.nldsPreviousOpacity || '';
      element.style.visibility = element.dataset.nldsPreviousVisibility || '';
      delete element.dataset.nldsSuppressed;
      delete element.dataset.nldsPreviousOpacity;
      delete element.dataset.nldsPreviousVisibility;
    }
  }

  function visibleRect(element) {
    if (!element || !element.isConnected) return null;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    if (Number(style.opacity) === 0 && !isNativeSubtitle(element)) return null;
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
      const rect = subtitleRect(lastSubtitleElement);
      const text = subtitleText(lastSubtitleElement);
      if (rect && text && text.length <= 500) {
        suppressNativeSubtitle(lastSubtitleElement);
        return { text, rect };
      }
      if (lastSubtitleElement === suppressedSubtitleElement) restoreNativeSubtitle();
      lastSubtitleElement = null;
    }
    const candidate = subtitleCandidates()[0];
    if (!candidate) {
      restoreNativeSubtitle();
      return { text: '', rect: null };
    }
    // Keep the selected node cached even after its native text is hidden; this
    // lets the polling loop continue reading Netflix's live text while the
    // combined overlay replaces the native rendering.
    lastSubtitleElement = candidate.element;
    suppressNativeSubtitle(candidate.element);
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
      // Read synchronously when the mode is entered. Translation may still be
      // in flight, but the original line is already enough to drag the real
      // subtitle container instead of a placeholder message.
      const currentSubtitle = readSubtitle();
      const source = currentSubtitle.text || currentSource;
      if (source || lastTranslation) {
        showTranslation(lastTranslation, currentSubtitle.rect || latestAnchor, false, source);
      } else {
        hideTranslation();
      }
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
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '2px',
      opacity: '0',
      transition: 'opacity 100ms ease',
      whiteSpace: 'pre-line',
      wordBreak: 'break-word'
    });
    translationLine = document.createElement('div');
    translationLine.id = 'nlds-translation-line';
    translationLine.setAttribute('aria-label', '翻译字幕');
    sourceLine = document.createElement('div');
    sourceLine.id = 'nlds-source-line';
    sourceLine.setAttribute('aria-label', '原始字幕');
    for (const line of [translationLine, sourceLine]) {
      Object.assign(line.style, {
        all: 'initial',
        display: 'block',
        maxWidth: '100%',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'center',
        textShadow: 'inherit',
        whiteSpace: 'pre-line',
        wordBreak: 'break-word'
      });
    }
    sourceLine.style.opacity = '0.88';
    overlay.append(translationLine, sourceLine);
    overlay.addEventListener('pointerdown', handleOverlayPointerDown);
    root.appendChild(overlay);
    applyOverlayStyles();
    return overlay;
  }

  function resetSubtitleContext() {
    clearTimeout(retryTimer);
    retryTimer = null;
    currentSource = '';
    translationRetryCount = 0;
    retryingSource = '';
    lastSubtitleElement = null;
    currentRequest += 1;
    latestAnchor = null;
    lastTranslation = '';
    lastRuntimeError = '';
    pendingTranslation = null;
    restoreNativeSubtitle();
    hideTranslation();
    scheduleRead();
  }

  function refreshTranslationContext() {
    clearTimeout(retryTimer);
    retryTimer = null;
    currentSource = '';
    translationRetryCount = 0;
    retryingSource = '';
    currentRequest += 1;
    pendingTranslation = null;
    lastTranslation = '';
    lastRuntimeError = '';
    hideTranslation();
    scheduleRead();
  }

  function scheduleTranslationRetry() {
    if (retryTimer || translationRetryCount >= MAX_TRANSLATION_RETRIES) return false;
    const delay = Math.min(800 * (2 ** translationRetryCount), 5000);
    translationRetryCount += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!pollingActive) return;
      retryingSource = currentSource;
      currentSource = '';
      scheduleRead();
    }, delay);
    return true;
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

  function showTranslation(text, rect, remember = true, source = currentSource) {
    const target = ensureOverlay();
    placeOverlay(rect);
    if (remember) lastTranslation = text;
    translationLine.textContent = normalize(text);
    translationLine.style.display = translationLine.textContent ? 'block' : 'none';
    sourceLine.textContent = normalize(source);
    sourceLine.style.display = sourceLine.textContent ? 'block' : 'none';
    target.style.opacity = translationLine.textContent || sourceLine.textContent ? '1' : '0';
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
      if (!overlay) return;
      // Keep the original line visible after a transient translation error;
      // the native Netflix line is intentionally hidden while the combined
      // container is active.
      if (currentSource) {
        translationLine.textContent = '';
        translationLine.style.display = 'none';
        sourceLine.textContent = normalize(currentSource);
        sourceLine.style.display = sourceLine.textContent ? 'block' : 'none';
        overlay.style.opacity = sourceLine.textContent ? '1' : '0';
      } else {
        overlay.style.opacity = '0';
      }
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
        if (!pendingTranslation) scheduleTranslationRetry();
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
          if (!pendingTranslation) scheduleTranslationRetry();
        }
        continuePendingTranslation();
        return;
      }
      if (!response?.ok) {
        const error = response?.error || '本地翻译服务未返回结果。';
        console.warn('[Netflix Local Dual Subtitles]', error);
        if (isCurrent && error !== lastRuntimeError) {
          lastRuntimeError = error;
          showTranslation(`翻译服务：${error}`, rect, false);
          hideTranslation(3500);
        }
        if (isCurrent && !pendingTranslation) {
          // Keep currentSource until the backoff timer fires. Clearing it
          // here lets the 150 ms polling loop submit the same subtitle again
          // immediately, defeating the retry delay and amplifying 429s.
          scheduleTranslationRetry();
        }
        continuePendingTranslation();
        return;
      }
      const translated = normalize(response.translated);
      if (translated) {
        lastRuntimeError = '';
        if (isCurrent) translationRetryCount = 0;
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
        if (!pendingTranslation) scheduleTranslationRetry();
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
        if (!pendingTranslation) scheduleTranslationRetry();
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
        translationRetryCount = 0;
        retryingSource = '';
        pendingTranslation = null;
        lastTranslation = '';
        restoreNativeSubtitle();
        hideTranslation();
        return;
      }

      const { text, rect } = readSubtitle();
      if (!text) {
        if (currentSource || pendingTranslation || lastTranslation) currentRequest += 1;
        currentSource = '';
        translationRetryCount = 0;
        retryingSource = '';
        pendingTranslation = null;
        lastTranslation = '';
        restoreNativeSubtitle();
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
      const isRetry = retryingSource === text;
      retryingSource = '';
      if (!isRetry) translationRetryCount = 0;
      currentRequest += 1;
      latestAnchor = rect;
      lastTranslation = '';
      lastRuntimeError = '';
      hideTranslation();
      // Show the source line immediately. This keeps the combined container
      // draggable while the local model is translating the next subtitle.
      showTranslation('', rect, false, text);
      requestTranslation(text, rect, currentRequest);
    }, SUBTITLE_SETTLE_MS);
  }

  function startPolling() {
    if (pollingActive) return;
    setNativeSubtitleVisibility(currentSettings.enabled);
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
    translationRetryCount = 0;
    retryingSource = '';
    lastSubtitleElement = null;
    currentRequest += 1;
    pendingTranslation = null;
    lastTranslation = '';
    lastRuntimeError = '';
    restoreNativeSubtitle();
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
    // A previous extension context may have been torn down while a native
    // subtitle was suppressed. Restore those inline styles before scanning.
    setNativeSubtitleVisibility(false);
    restorePersistedNativeSubtitles();
    // Enable suppression immediately using the default setting so a subtitle
    // inserted while storage is loading cannot flash before the first poll.
    setNativeSubtitleVisibility(true);
    currentSettings = await chrome.storage.local.get(DEFAULT_SETTINGS);
    setNativeSubtitleVisibility(currentSettings.enabled);
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
      setNativeSubtitleVisibility(currentSettings.enabled);
      applyOverlayStyles();
      if (settingsNeedTranslationRefresh(previousSettings, currentSettings)) {
        refreshTranslationContext();
      }
    });

    chrome.runtime.onMessage.addListener(message => {
      if (message?.type !== 'settingsUpdated') return;
      const previousSettings = { ...currentSettings };
      currentSettings = { ...currentSettings, ...message.settings };
      setNativeSubtitleVisibility(currentSettings.enabled);
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
