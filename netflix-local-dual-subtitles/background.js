const DEFAULT_SETTINGS = {
  enabled: true,
  sourceLanguage: 'auto',
  serverUrl: 'http://127.0.0.1:8765',
  model: 'translategemma:4b',
  overlayX: 50,
  overlayY: 76,
  fontSize: 24,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontWeight: 600,
  textColor: '#f6f6f6',
  backgroundColor: '#000000',
  backgroundOpacity: 64
};
const LOCAL_SERVER_URL = 'http://127.0.0.1:8765';
const TRANSLATION_TIMEOUT_MS = 35000;
const MAX_MODEL_NAME_LENGTH = 200;

const NATIVE_HOST = 'com.netflix.local_dual_subtitles';
let nativePort = null;
let nativeStartPromise = null;
let nativeStopPromise = null;
let nativeRuntimeModel = null;
let ensureRuntimePromise = null;
let nativeHeartbeatTimer = null;
let stopTimer = null;
let observedNetflixSession = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(DEFAULT_SETTINGS, current => {
    chrome.storage.local.set(current);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !nativePort) return;
  if (changes.enabled?.newValue === false) {
    void stopNative();
    return;
  }
  if (!changes.model || !nativeRuntimeModel) return;
  const nextModel = String(changes.model.newValue || '').trim();
  if (nextModel && nextModel !== nativeRuntimeModel) void stopNative();
});

async function settings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const modelValue = String(stored.model || '').trim();
  const model = modelValue && modelValue.length <= MAX_MODEL_NAME_LENGTH
    && !Array.from(modelValue).some(char => char.charCodeAt(0) < 32)
    ? modelValue
    : DEFAULT_SETTINGS.model;
  const updates = {};
  // The bridge is intentionally fixed to 8765. Older settings may contain a
  // mistyped port, which starts the server outside the extension permissions.
  if (stored.serverUrl !== LOCAL_SERVER_URL) {
    updates.serverUrl = LOCAL_SERVER_URL;
  }
  if (stored.model !== model) updates.model = model;
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  return { ...stored, ...updates, serverUrl: LOCAL_SERVER_URL, model };
}

async function fetchJson(url, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body.error || `Local service returned HTTP ${response.status}`;
      throw new Error(message);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function modelNotReadyError(model) {
  return new Error(`模型 ${model} 尚未安装，请先执行：ollama pull ${model}`);
}

async function ensureLocalService(current) {
  if (ensureRuntimePromise) return ensureRuntimePromise;
  ensureRuntimePromise = (async () => {
    // The native host warms the model before reporting ready. A subtitle can
    // arrive while the popup is still waiting for that ready message; wait
    // for the same startup promise instead of competing with warm-up in Ollama.
    if (nativeStartPromise) await nativeStartPromise;
    if (nativePort && nativeRuntimeModel && nativeRuntimeModel !== current.model) {
      await stopNative();
      await startNative(current);
    }
    let health;
    try {
      health = await fetchJson(
        `${current.serverUrl}/health?model=${encodeURIComponent(current.model)}`,
        {},
        2500
      );
    } catch (_) {
      if (nativePort) await stopNative();
      await startNative(current);
      health = await fetchJson(
        `${current.serverUrl}/health?model=${encodeURIComponent(current.model)}`,
        {},
        2500
      );
    }
    if (!health.model_ready) throw modelNotReadyError(current.model);
    return health;
  })();
  try {
    return await ensureRuntimePromise;
  } finally {
    ensureRuntimePromise = null;
  }
}

function isRecoverableRuntimeError(error) {
  const message = String(error?.message || error || '');
  return error?.name === 'AbortError'
    || /Failed to fetch|NetworkError|无法连接 Ollama|HTTP 50[234]/i.test(message);
}

async function translateWithRecovery(current, payload) {
  await ensureLocalService(current);
  try {
    return await fetchJson(`${current.serverUrl}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, TRANSLATION_TIMEOUT_MS);
  } catch (error) {
    if (!isRecoverableRuntimeError(error)) throw error;
    await stopNative();
    await ensureLocalService(current);
    return fetchJson(`${current.serverUrl}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, TRANSLATION_TIMEOUT_MS);
  }
}

async function notifyNetflixTabs(message) {
  const tabs = await chrome.tabs.query({
    url: ['https://netflix.com/*', 'https://*.netflix.com/*']
  });
  await Promise.all(tabs.map(async tab => {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (_) {
      // An unpacked extension reload does not reinject content scripts into
      // already-open Netflix tabs. Inject it once, then retry the message.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        await chrome.tabs.sendMessage(tab.id, message);
      } catch (_) {
        // The tab may be navigating or not yet be scriptable.
      }
    }
  }));
}

function startNative(current) {
  if (nativeStopPromise) return nativeStopPromise.then(() => startNative(current));
  if (nativeStartPromise) return nativeStartPromise.then(() => startNative(current));
  if (nativePort) {
    if (!nativeRuntimeModel || nativeRuntimeModel === current.model) {
      return Promise.resolve({ ok: true, running: true, model: nativeRuntimeModel || current.model });
    }
    return stopNative().then(() => startNative(current));
  }

  nativeStartPromise = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let port;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error && nativePort === port) {
        nativePort = null;
        nativeRuntimeModel = null;
        clearInterval(nativeHeartbeatTimer);
        nativeHeartbeatTimer = null;
        try { port?.disconnect(); } catch (_) { /* already disconnected */ }
      }
      if (error) reject(error);
      else resolve(result);
    };

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
      nativePort = port;
      nativeRuntimeModel = current.model;
      clearInterval(nativeHeartbeatTimer);
      nativeHeartbeatTimer = setInterval(() => {
        if (nativePort !== port) return;
        try {
          port.postMessage({ type: 'ping' });
        } catch (_) {
          clearInterval(nativeHeartbeatTimer);
          nativeHeartbeatTimer = null;
          if (nativePort === port) {
            nativePort = null;
            nativeRuntimeModel = null;
          }
          try { port.disconnect(); } catch (_) { /* already disconnected */ }
        }
      }, 10000);
    } catch (error) {
      finish(error);
      return;
    }

    port.onMessage.addListener(message => {
      if (message?.type === 'ready') {
        nativeRuntimeModel = message.model || current.model;
        finish(null, { ok: true, running: true, model: message.model });
      } else if (message?.type === 'error') {
        finish(new Error(message.error || '本地模型启动失败。'));
      }
    });

    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message || 'Native Messaging 宿主已断开。';
      nativePort = null;
      nativeRuntimeModel = null;
      clearInterval(nativeHeartbeatTimer);
      nativeHeartbeatTimer = null;
      finish(new Error(message));
    });

    timer = setTimeout(() => {
      try { port.disconnect(); } catch (_) { /* already disconnected */ }
      finish(new Error('启动本地模型超时，请确认 Native Messaging 宿主已安装。'));
    }, 60000);

    try {
      port.postMessage({
        type: 'start',
        model: current.model,
        server_url: current.serverUrl
      });
    } catch (error) {
      finish(error);
    }
  }).finally(() => {
    nativeStartPromise = null;
  });

  return nativeStartPromise;
}

function stopDetachedRuntime() {
  return new Promise(resolve => {
    let port;
    let timer;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch (_) { /* already disconnected */ }
      resolve(result);
    };
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
      port.onMessage.addListener(message => {
        if (message?.type === 'stopped') finish({ ok: true, running: false });
      });
      port.onDisconnect.addListener(() => finish({ ok: true, running: false }));
      port.postMessage({ type: 'stop_all' });
      timer = setTimeout(() => finish({ ok: true, running: false }), 5000);
    } catch (_) {
      finish({ ok: true, running: false });
    }
  });
}

function stopNative() {
  if (nativeStopPromise) return nativeStopPromise;
  clearTimeout(stopTimer);
  clearInterval(nativeHeartbeatTimer);
  nativeHeartbeatTimer = null;
  const stopPromise = !nativePort ? stopDetachedRuntime() : stopAttachedRuntime();
  nativeStopPromise = stopPromise.finally(() => {
    nativeStopPromise = null;
  });
  return nativeStopPromise;
}

function stopAttachedRuntime() {
  const port = nativePort;

  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      nativePort = null;
      nativeRuntimeModel = null;
      resolve(result);
    };
    port.onMessage.addListener(message => {
      if (message?.type === 'stopped') {
        try { port.disconnect(); } catch (_) { /* already disconnected */ }
        finish({ ok: true, running: false });
      }
    });
    try {
      port.postMessage({ type: 'stop' });
    } catch (_) {
      try { port.disconnect(); } catch (_) { /* already disconnected */ }
    }
    timer = setTimeout(async () => {
      try { port.disconnect(); } catch (_) { /* already disconnected */ }
      const fallback = await stopDetachedRuntime();
      finish(fallback);
    }, 1500);
  });
}

function isNetflixUrl(url) {
  try {
    return new URL(url).hostname === 'netflix.com' || new URL(url).hostname.endsWith('.netflix.com');
  } catch (_) {
    return false;
  }
}

function stopIfNoNetflixTabs() {
  if (!observedNetflixSession) return;
  clearTimeout(stopTimer);
  stopTimer = setTimeout(async () => {
    try {
      const tabs = await chrome.tabs.query({
        url: ['https://netflix.com/*', 'https://*.netflix.com/*']
      });
      if (tabs.length === 0) {
        await stopNative();
        observedNetflixSession = false;
      }
    } catch (_) {
      // If tab inspection is unavailable, the native host still exits when Chrome closes.
    }
  }, 500);
}

chrome.tabs.onRemoved.addListener(stopIfNoNetflixTabs);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url && !isNetflixUrl(changeInfo.url)) stopIfNoNetflixTabs();
});

// MV3 may suspend the service worker when the extension is disabled, reloaded,
// or otherwise unloaded. Sending the stop command immediately gives the host
// a chance to clean up before the worker disappears; the host also cleans up
// from its stdin EOF handler if the message cannot be delivered.
chrome.runtime.onSuspend.addListener(() => {
  if (nativePort || nativeStartPromise) void stopNative();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  if (message.type === 'translate') {
    (async () => {
      try {
        const current = await settings();
        const result = await translateWithRecovery(current, {
          text: message.text,
          source_language: message.sourceLanguage || current.sourceLanguage,
          model: current.model
        });
        sendResponse({ ok: true, ...result });
      } catch (error) {
        const detail = error?.name === 'AbortError'
          ? '本地翻译超时，请确认本地模型已启动。'
          : (error?.message || String(error));
        sendResponse({ ok: false, error: detail });
      }
    })();
    return true;
  }

  if (message.type === 'health') {
    (async () => {
      try {
        const current = await settings();
        const query = encodeURIComponent(current.model);
        const result = await fetchJson(`${current.serverUrl}/health?model=${query}`, {}, 2500);
        sendResponse({ ok: true, ...result, native_running: Boolean(nativePort) });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error), native_running: Boolean(nativePort) });
      }
    })();
    return true;
  }

  if (message.type === 'localRuntime') {
    (async () => {
      try {
        if (message.action === 'start') {
          const current = await settings();
          const runtime = await startNative(current);
          const health = await ensureLocalService(current);
          await notifyNetflixTabs({ type: 'runtimeReady' });
          sendResponse({ ...runtime, model_ready: health.model_ready });
        } else if (message.action === 'stop') {
          sendResponse(await stopNative());
        } else {
          sendResponse({ ok: true, running: Boolean(nativePort) });
        }
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error), running: Boolean(nativePort) });
      }
    })();
    return true;
  }

  if (message.type === 'netflixClosed') {
    if (observedNetflixSession) stopIfNoNetflixTabs();
    return false;
  }

  if (message.type === 'netflixOpened') {
    observedNetflixSession = true;
    return false;
  }

  return undefined;
});
