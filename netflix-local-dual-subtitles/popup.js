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
const HY_MT2_MODEL = 'kaelri/hy-mt2:1.8b';
const LEGACY_MODEL_MIGRATIONS = {
  'hy-mt1.5:1.8b': HY_MT2_MODEL,
  'hf.co/tencent/Hy-MT2-1.8B-GGUF:Q4_K_M': HY_MT2_MODEL
};

const $ = id => document.getElementById(id);
let dragMode = false;
let previewFrame = 0;
let activeTabId = null;

// A tab without the Netflix content script is a normal state for this popup
// (for example, when it is opened on a new tab or while Netflix is loading).
// Keep Chrome's API quirk from surfacing that expected condition as an
// unhandled Promise error, while allowing all other errors through.
window.addEventListener('unhandledrejection', event => {
  const message = String(event.reason?.message || event.reason || '');
  if (/Could not establish connection\. Receiving end does not exist/i.test(message)) {
    event.preventDefault();
  }
});

function setStatus(text, error = false) {
  const node = $('status');
  node.textContent = text;
  node.classList.toggle('error', error);
  node.classList.toggle('success', !error);
}

function readForm() {
  return {
    enabled: $('enabled').checked,
    sourceLanguage: $('sourceLanguage').value,
    serverUrl: DEFAULT_SETTINGS.serverUrl,
    model: $('model').value.trim(),
    overlayX: Number($('overlayX').value),
    overlayY: Number($('overlayY').value),
    fontSize: Number($('fontSize').value),
    fontFamily: $('fontFamily').value,
    fontWeight: Number($('fontWeight').value),
    textColor: $('textColor').value,
    backgroundColor: $('backgroundColor').value,
    backgroundOpacity: Number($('backgroundOpacity').value)
  };
}

function updateRangeLabels() {
  $('fontSizeValue').textContent = `${$('fontSize').value}px`;
  $('backgroundOpacityValue').textContent = `${$('backgroundOpacity').value}%`;
  $('overlayXValue').textContent = `${$('overlayX').value}%`;
  $('overlayYValue').textContent = `${$('overlayY').value}%`;
}

function isNetflixUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && (parsed.hostname === 'netflix.com' || parsed.hostname.endsWith('.netflix.com'));
  } catch (_) {
    return false;
  }
}

// Use the callback form deliberately. Chrome reports a rejected Promise when
// a tab has no content-script receiver; reading runtime.lastError in the
// callback consumes that expected condition without logging an unhandled
// Promise rejection from popup.html.
function sendTabMessage(tabId, message) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const result = chrome.tabs.sendMessage(tabId, message, () => {
        const error = chrome.runtime.lastError;
        finish({ ok: !error, error: error?.message || '' });
      });

      // MV3 Chrome versions may return a Promise even when a callback is
      // supplied. Consume that rejection as well as runtime.lastError.
      result?.catch?.(error => {
        finish({ ok: false, error: error?.message || String(error) });
      });
    } catch (error) {
      finish({ ok: false, error: error?.message || String(error) });
    }
  });
}

function sendRuntimeMessage(message) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const result = chrome.runtime.sendMessage(message, response => {
        const error = chrome.runtime.lastError;
        finish({ response, error: error?.message || '' });
      });
      result?.catch?.(error => {
        finish({ response: undefined, error: error?.message || String(error) });
      });
    } catch (error) {
      finish({ response: undefined, error: error?.message || String(error) });
    }
  });
}

async function load() {
  const storedSettings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const migratedModel = LEGACY_MODEL_MIGRATIONS[storedSettings.model] || storedSettings.model;
  const settings = { ...storedSettings, model: migratedModel };
  if (settings.model !== storedSettings.model) {
    await chrome.storage.local.set({ model: settings.model });
  }
  $('enabled').checked = settings.enabled;
  $('sourceLanguage').value = settings.sourceLanguage;
  $('serverUrl').value = DEFAULT_SETTINGS.serverUrl;
  const modelSelect = $('model');
  if (![...modelSelect.options].some(option => option.value === settings.model)) {
    const customOption = document.createElement('option');
    customOption.value = settings.model;
    customOption.textContent = `${settings.model}（当前）`;
    modelSelect.appendChild(customOption);
  }
  modelSelect.value = settings.model;
  $('overlayX').value = settings.overlayX;
  $('overlayY').value = settings.overlayY;
  $('fontSize').value = settings.fontSize;
  $('fontFamily').value = settings.fontFamily;
  $('fontWeight').value = settings.fontWeight;
  $('textColor').value = settings.textColor;
  $('backgroundColor').value = settings.backgroundColor;
  $('backgroundOpacity').value = settings.backgroundOpacity;
  updateRangeLabels();
  setStatus('就绪');
}

async function save() {
  const settings = readForm();
  if (!settings.serverUrl || !settings.model) {
    setStatus('服务地址和模型不能为空。', true);
    return;
  }
  await applySettings(settings, '设置已保存');
}

async function applySettings(settings, statusText = '') {
  await chrome.storage.local.set(settings);
  // content.js already listens to storage.onChanged, so no tab message is
  // needed here. This also avoids contacting a tab without a content script.
  if (statusText) setStatus(statusText);
}

function queueLivePreview() {
  if (previewFrame) return;
  previewFrame = requestAnimationFrame(async () => {
    previewFrame = 0;
    const settings = readForm();
    if (!settings.serverUrl || !settings.model) return;
    try {
      // Preview stays in the current tab. Persist only when the user presses
      // Save; writing storage for every slider tick invalidates the subtitle
      // pipeline and makes the interaction feel stuttery.
      await sendToActiveTab({ type: 'settingsUpdated', settings });
    } catch (error) {
      setStatus(error?.message || '实时预览应用失败。', true);
    }
  });
}

function checkHealth() {
  setStatus('正在检查本地服务…');
  sendRuntimeMessage({ type: 'health' }).then(({ response, error }) => {
    if (error || !response?.ok) {
      setStatus(response?.error || error || '无法连接本地翻译服务。', true);
      return;
    }
    const modelState = response.model_ready ? '模型已就绪' : `未找到模型 ${response.model}`;
    const runtimeState = response.native_running ? '，插件已托管启动' : '';
    setStatus(`Ollama 已连接，${modelState}${runtimeState}` , !response.model_ready);
  });
}

function startLocal() {
  setStatus('正在启动 Ollama 和本地翻译服务…');
  sendRuntimeMessage({ type: 'localRuntime', action: 'start' }).then(({ response, error }) => {
    if (error || !response?.ok) {
      setStatus(response?.error || error || '启动失败。请先安装 Native Messaging 宿主。', true);
      return;
    }
    setStatus(`本地模型已启动：${response.model || $('model').value}`);
  });
}

function stopLocal() {
  setStatus('正在停止本地模型…');
  sendRuntimeMessage({ type: 'localRuntime', action: 'stop' }).then(({ response, error }) => {
    if (error || !response?.ok) {
      setStatus(response?.error || error || '停止失败。', true);
      return;
    }
    setStatus('本地模型已停止');
  });
}

async function sendToActiveTab(message) {
  try {
    if (activeTabId === null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTabId = tab?.id && isNetflixUrl(tab.url) ? tab.id : 0;
    }
    if (activeTabId) await sendTabMessage(activeTabId, message);
  } catch (_) {
    // The current tab may not have the Netflix content script.
  }
}

async function toggleDragMode() {
  dragMode = !dragMode;
  $('dragMode').textContent = dragMode ? '退出拖动模式' : '进入拖动模式';
  await sendToActiveTab({ type: 'toggleEditMode', enabled: dragMode });
  setStatus(dragMode ? '请直接拖动播放器上的中文字幕' : '已退出拖动模式');
}

async function resetPosition() {
  $('overlayX').value = 50;
  $('overlayY').value = 76;
  updateRangeLabels();
  queueLivePreview();
}

$('save').addEventListener('click', () => {
  save().catch(error => setStatus(error?.message || '保存设置失败。', true));
});
$('health').addEventListener('click', checkHealth);
$('startLocal').addEventListener('click', startLocal);
$('stopLocal').addEventListener('click', stopLocal);
$('dragMode').addEventListener('click', toggleDragMode);
$('resetPosition').addEventListener('click', resetPosition);
for (const id of ['fontSize', 'backgroundOpacity', 'overlayX', 'overlayY']) {
  $(id).addEventListener('input', updateRangeLabels);
}

for (const id of [
  'enabled',
  'sourceLanguage',
  'model',
  'fontSize',
  'fontFamily',
  'fontWeight',
  'textColor',
  'backgroundColor',
  'backgroundOpacity',
  'overlayX',
  'overlayY'
]) {
  $(id).addEventListener('input', queueLivePreview);
  $(id).addEventListener('change', queueLivePreview);
}
load().catch(error => {
  setStatus(error?.message || '读取设置失败。', true);
});
