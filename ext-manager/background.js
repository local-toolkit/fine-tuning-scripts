// Core Automation Engine - Commercial Grade (v2)

// Preset Rules Configuration
const PRESET_RULES = {
  version: "1.0.0",
  description: "预设规则配置文件 - 用于首次安装时自动加载",
  lastUpdated: "2026-02-08",
  whitelist: [
    "jcehmiopmjjbdakjgjjlfjipbjfcablj",
    "dhdgffkkebhmkfjojejmpbldmpobfkfo"
  ],
  rules: {
    "cmedhionkhpnakcndndgjdbohmhepckk": ["/^https?:\\/\\/(?:[a-z0-9-]+\\.)*(?:youtube\\.com|youtube-nocookie\\.com|youtu\\.be)(?::\\d+)?(?:[/?#]|$)/i"],
    "pjebbdjhagepdcagkacbpccagmnjomoj": ["chrome://bookmarks/"],
    "cieikaeocafmceoapfogpffaalkncpkc": ["github.com"],
    "ghbmnnjooekpmoecnnnilnnbdlolhkhi": ["docs.google.com"],
    "ldipcbpaocekfooobnbcddclnhejkcpn": ["scholar.google.com"],
    "fkepacicchenbjecpbpbclokcabebhah": ["bookmarks.icloud.com"],
    "pejdijmoenmkgeppbflobdenhhabjlaj": ["*"],
    "bapgbgfcjpeakbjcidibdcndbmdngkdf": ["youtube.com", "bilibili.com", "youku.com", "v.qq.com", "iqiyi.com", "tv.sohu.com", "v.163.com"],
    "jgddbbpaobnapjkdalbdmpognmepgpog": ["/^https?:\\/\\/.+/"]
  },
  aliases: {
    "cmedhionkhpnakcndndgjdbohmhepckk": [
      "adblock for youtube",
      "ad block for youtube",
      "adblocker for youtube",
      "ad blocker for youtube",
      "adblock youtube",
      "youtube adblock",
      "youtube ad blocker"
    ]
  }
};

// Configuration
// rules structure: { "extensionId": ["google.com", "/^https:\/\/.*\.github\.com/"] }
let rules = {};
// whitelist: Extensions that should NEVER be auto-disabled
let whitelist = new Set();
let selfId = chrome.runtime.id;
const ALWAYS_ON_EXTENSION_IDS = new Set([
    "dhdgffkkebhmkfjojejmpbldmpobfkfo" // Tampermonkey: permission-sensitive; do not auto-disable/enable.
]);

function parseRegexRule(ruleStr) {
    if (typeof ruleStr !== 'string' || !ruleStr.startsWith('/')) {
        return null;
    }

    const lastSlash = ruleStr.lastIndexOf('/');
    if (lastSlash <= 0) {
        return null;
    }

    const pattern = ruleStr.slice(1, lastSlash);
    const flags = ruleStr.slice(lastSlash + 1) || 'i';
    return new RegExp(pattern, flags);
}

function ruleMatchesUrl(ruleStr, url) {
    if (typeof ruleStr !== 'string' || !ruleStr.trim()) {
        return false;
    }

    const rule = ruleStr.trim();
    if (rule === '*') {
        return true;
    }

    const regex = parseRegexRule(rule);
    if (regex) {
        return regex.test(url);
    }

    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.toLowerCase();
        const normalizedRule = rule.toLowerCase();
        return hostname === normalizedRule ||
            hostname.endsWith(`.${normalizedRule}`) ||
            url.toLowerCase().includes(normalizedRule);
    } catch (e) {
        return url.toLowerCase().includes(rule.toLowerCase());
    }
}

function normalizeExtensionName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function extensionMatchesAlias(extensionName, alias) {
    const normalizedName = normalizeExtensionName(extensionName);
    const normalizedAlias = normalizeExtensionName(alias);
    return normalizedName === normalizedAlias || normalizedName.includes(normalizedAlias);
}

function getManagedPresetExtensionIds(extensions) {
    const managedPresetIds = new Set(Object.keys(PRESET_RULES.aliases || {}));

    Object.entries(PRESET_RULES.aliases || {}).forEach(([presetId, aliases]) => {
        const matchedExtension = extensions.find(ext =>
            ext.id === presetId || aliases.some(alias => extensionMatchesAlias(ext.name, alias))
        );

        if (matchedExtension) {
            managedPresetIds.add(matchedExtension.id);
        }
    });

    return managedPresetIds;
}

async function resolvePresetRules() {
    const extensions = await chrome.management.getAll();
    const installedById = new Map(extensions.map(ext => [ext.id, ext]));
    const resolvedRules = {};

    Object.entries(PRESET_RULES.rules).forEach(([presetId, presetRules]) => {
        const aliases = PRESET_RULES.aliases?.[presetId] || [];
        const matchedExtension = installedById.get(presetId) ||
            extensions.find(ext => aliases.some(alias => extensionMatchesAlias(ext.name, alias)));

        resolvedRules[matchedExtension ? matchedExtension.id : presetId] = presetRules;
    });

    return resolvedRules;
}

async function migratePresetRuleAliases() {
    const extensions = await chrome.management.getAll();
    const installedById = new Map(extensions.map(ext => [ext.id, ext]));
    let changed = false;

    Object.keys(PRESET_RULES.aliases || {}).forEach(presetId => {
        if (!rules[presetId] || installedById.has(presetId)) {
            return;
        }

        const aliases = PRESET_RULES.aliases[presetId];
        const matchedExtension = extensions.find(ext =>
            aliases.some(alias => extensionMatchesAlias(ext.name, alias))
        );

        if (!matchedExtension) {
            return;
        }

        const mergedRules = new Set([...(rules[matchedExtension.id] || []), ...rules[presetId]]);
        rules[matchedExtension.id] = Array.from(mergedRules);
        delete rules[presetId];
        changed = true;
    });

    if (changed) {
        await chrome.storage.local.set({ rules });
    }
}

async function ensureAliasedPresetRules() {
    const extensions = await chrome.management.getAll();
    let changed = false;

    Object.entries(PRESET_RULES.aliases || {}).forEach(([presetId, aliases]) => {
        const matchedExtension = extensions.find(ext =>
            ext.id === presetId || aliases.some(alias => extensionMatchesAlias(ext.name, alias))
        );

        if (!matchedExtension) {
            return;
        }

        const presetRules = PRESET_RULES.rules[presetId] || [];
        const existingRules = rules[matchedExtension.id] || [];
        const nextRules = [...presetRules];

        if (JSON.stringify(existingRules) !== JSON.stringify(nextRules)) {
            rules[matchedExtension.id] = nextRules;
            changed = true;
        }

        if (presetId !== matchedExtension.id && rules[presetId]) {
            delete rules[presetId];
            changed = true;
        }
    });

    if (changed) {
        await chrome.storage.local.set({ rules });
    }
}

async function migrateManagedPresetWhitelist() {
    const extensions = await chrome.management.getAll();
    const managedPresetIds = getManagedPresetExtensionIds(extensions);
    const nextWhitelist = Array.from(whitelist).filter(id => !managedPresetIds.has(id));

    if (nextWhitelist.length !== whitelist.size) {
        whitelist = new Set([...nextWhitelist, selfId]);
        await chrome.storage.local.set({ whitelist: Array.from(whitelist) });
    }
}

async function migrateAlwaysOnExtensions() {
    let changedRules = false;
    let changedWhitelist = false;

    ALWAYS_ON_EXTENSION_IDS.forEach(id => {
        if (rules[id]) {
            delete rules[id];
            changedRules = true;
        }

        if (!whitelist.has(id)) {
            whitelist.add(id);
            changedWhitelist = true;
        }
    });

    if (changedRules || changedWhitelist) {
        await chrome.storage.local.set({
            rules,
            whitelist: Array.from(whitelist)
        });
    }
}

// Initialize
function ensurePeriodicCheckAlarm() {
    chrome.alarms.create('periodic-state-check', { periodInMinutes: 1 });
}

ensurePeriodicCheckAlarm();

chrome.runtime.onInstalled.addListener(async () => {
    await loadRules();
    whitelist.add(selfId);
    ensurePeriodicCheckAlarm();
    console.log('Smart Extension Manager Initialized');
    checkTabsAndApplyState();
});

chrome.runtime.onStartup.addListener(() => {
    ensurePeriodicCheckAlarm();
    checkTabsAndApplyState();
});

// Load rules from storage
async function loadRules() {
    const data = await chrome.storage.local.get(['rules', 'whitelist', 'presetLoaded']);
    rules = data.rules || {};
    const storedWhitelist = data.whitelist || [];
    whitelist = new Set([...storedWhitelist, selfId]);

    // Load preset rules only for truly empty installs. Existing users may already
    // have custom rules from before the presetLoaded flag existed.
    if (!data.presetLoaded && Object.keys(rules).length === 0) {
        await loadPresetRules();
    } else {
        await migratePresetRuleAliases();
        await ensureAliasedPresetRules();
        await migrateManagedPresetWhitelist();
        await migrateAlwaysOnExtensions();
    }
}

// Load preset rules from PRESET_RULES constant
async function loadPresetRules() {
    rules = await resolvePresetRules();
    const whitelistWithSelf = [...PRESET_RULES.whitelist, selfId];
    whitelist = new Set(whitelistWithSelf);

    await chrome.storage.local.set({
        rules: rules,
        whitelist: whitelistWithSelf,
        presetLoaded: true,
        presetVersion: PRESET_RULES.version
    });

    console.log('Preset rules loaded:', PRESET_RULES.description);
}

// Event Listeners: Monitor Tab Activity
const tabUrlCache = new Map();

function rememberTabUrl(tabId, tab) {
    const url = tab?.pendingUrl || tab?.url;
    if (url) {
        tabUrlCache.set(tabId, url);
    }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || tab?.url || tab?.pendingUrl) {
        rememberTabUrl(tabId, tab);
    }

    if (changeInfo.status === 'complete' || changeInfo.url) {
        checkTabsAndApplyState();
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    tabUrlCache.delete(tabId);
    checkTabsAndApplyState();
    setTimeout(checkTabsAndApplyState, 1000);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId).then(tab => {
        rememberTabUrl(activeInfo.tabId, tab);
        checkTabsAndApplyState();
    }).catch(() => {
        checkTabsAndApplyState();
    });
});

chrome.tabs.onCreated.addListener((tab) => {
    rememberTabUrl(tab.id, tab);
    checkTabsAndApplyState();
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    tabUrlCache.delete(removedTabId);
    chrome.tabs.get(addedTabId).then(tab => {
        rememberTabUrl(addedTabId, tab);
        checkTabsAndApplyState();
    }).catch(() => {
        checkTabsAndApplyState();
    });
});

chrome.windows.onRemoved.addListener(() => {
    checkTabsAndApplyState();
    setTimeout(checkTabsAndApplyState, 1000);
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'periodic-state-check') {
        checkTabsAndApplyState();
    }
});

// --- Logging System ---
async function logAction(action, target, details) {
    const logEntry = {
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        action,
        target,
        details,
        timestamp: Date.now()
    };
    
    const data = await chrome.storage.local.get(['logs']);
    const logs = data.logs || [];
    logs.unshift(logEntry);
    
    // Keep only last 100 logs
    const trimmedLogs = logs.slice(0, 100);
    await chrome.storage.local.set({ logs: trimmedLogs });
}

// Main Logic: The Decision Engine
const manualEnableRequired = new Set();
let checkInProgress = false;
let checkQueued = false;

async function loadManualEnableRequired() {
    const data = await chrome.storage.local.get(['manualEnableRequired']);
    manualEnableRequired.clear();
    (data.manualEnableRequired || []).forEach(id => manualEnableRequired.add(id));
}

async function saveManualEnableRequired() {
    await chrome.storage.local.set({ manualEnableRequired: Array.from(manualEnableRequired) });
}

function checkTabsAndApplyState() {
    if (checkInProgress) {
        checkQueued = true;
        return;
    }

    performCheck();
}

async function performCheck() {
    checkInProgress = true;
    try {
        await loadManualEnableRequired();
        await loadRules(); 
        
        // 1. Get all open tab URLs (Full URLs for Regex matching)
        const tabs = await chrome.tabs.query({});
        const extensions = await chrome.management.getAll();
        const managedPresetIds = getManagedPresetExtensionIds(extensions);
        const openUrls = [];
        
        tabs.forEach(tab => {
            const url = tab.pendingUrl || tab.url;
            if (url) {
                tabUrlCache.set(tab.id, url);
                openUrls.push(url);
            }
        });

        tabUrlCache.forEach((url, tabId) => {
            if (!tabs.some(tab => tab.id === tabId)) {
                tabUrlCache.delete(tabId);
                return;
            }

            if (!openUrls.includes(url)) {
                openUrls.push(url);
            }
        });

        // 2. Identify which extensions need to be ON
        const neededExtensions = new Set();
        
        // Add whitelisted items
        whitelist.forEach(id => {
            if (!managedPresetIds.has(id)) {
                neededExtensions.add(id);
            }
        });

        const managedExtensionIds = Object.keys(rules);
        const matchDetails = new Map();
        
        managedExtensionIds.forEach(extId => {
            const extRules = rules[extId]; // Array of rule strings
            if (!Array.isArray(extRules)) return;

            // Check if ANY rule matches ANY open tab
            let matchedRule = null;
            let matchedUrl = null;
            const isActive = extRules.some(ruleStr => {
                try {
                    return openUrls.some(url => {
                        const matched = ruleMatchesUrl(ruleStr, url);
                        if (matched) {
                            matchedRule = ruleStr;
                            matchedUrl = url;
                        }
                        return matched;
                    });
                } catch (e) {
                    return false;
                }
            });

            if (isActive) {
                neededExtensions.add(extId);
                matchDetails.set(extId, { rule: matchedRule, url: matchedUrl });
                console.log(`[Rule-Match] ${extId} matched "${matchedRule}" on ${matchedUrl}`);
            }
        });
        
        // 3. Apply State
        for (const ext of extensions) {
            if (ext.id === selfId) continue;
            if (ext.enabled) {
                if (manualEnableRequired.delete(ext.id)) {
                    await saveManualEnableRequired();
                }
            }

            // Only manage if it has rules (Auto Mode)
            if (rules[ext.id] && rules[ext.id].length > 0) {
                const matched = matchDetails.get(ext.id);
                const shouldBeEnabled = managedPresetIds.has(ext.id)
                    ? Boolean(matched)
                    : neededExtensions.has(ext.id);

                if (shouldBeEnabled && !ext.enabled && manualEnableRequired.has(ext.id)) {
                    continue;
                }
                
                if (ext.enabled !== shouldBeEnabled) {
                    const actionType = shouldBeEnabled ? 'WAKE' : 'SLEEP';
                    const reason = shouldBeEnabled && matched
                        ? `Matched ${matched.rule} on ${matched.url}`
                        : 'No matching active tabs';
                    await logAction(actionType, ext.name, reason);
                    console.log(`[Auto-Toggle] ${ext.name} -> ${shouldBeEnabled ? 'ON' : 'OFF'}`);
                    try {
                        await chrome.management.setEnabled(ext.id, shouldBeEnabled);
                        await logAction(`${actionType}_DONE`, ext.name, `Extension is now ${shouldBeEnabled ? 'enabled' : 'disabled'}`);
                    } catch (error) {
                        if (shouldBeEnabled && /user gesture|permissions increase/i.test(error.message)) {
                            manualEnableRequired.add(ext.id);
                            await saveManualEnableRequired();
                            await logAction('MANUAL_REQUIRED', ext.name, 'Chrome requires you to enable this extension manually after a permissions increase');
                        } else {
                            await logAction('ERROR', ext.name, `Failed to ${shouldBeEnabled ? 'enable' : 'disable'} extension: ${error.message}`);
                        }
                        console.error(`[Auto-Toggle] Failed to update ${ext.name}:`, error);
                    }
                }
            }
        }

    } catch (error) {
        console.error('Error in automation loop:', error);
    } finally {
        checkInProgress = false;
        if (checkQueued) {
            checkQueued = false;
            checkTabsAndApplyState();
        }
    }
}

// Interface for Dashboard
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getData') {
        performCheck().then(() => Promise.all([
            chrome.management.getAll(),
            chrome.storage.local.get(['rules', 'whitelist', 'pinned'])
        ])).then(([extensions, data]) => {
            sendResponse({
                extensions,
                rules: data.rules || {},
                whitelist: data.whitelist || [],
                pinned: data.pinned || []
            });
        });
        return true;
    }
    else if (request.action === 'forceCheck') {
        performCheck().then(() => {
            sendResponse({ success: true });
        }).catch(error => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }
    else if (request.action === 'saveRules') {
        rules = request.rules;
        chrome.storage.local.set({ rules });
        checkTabsAndApplyState();
        sendResponse({ success: true });
    }
    else if (request.action === 'importPresetRules') {
        loadPresetRules().then(() => {
            checkTabsAndApplyState();
            sendResponse({ success: true, rules, whitelist: Array.from(whitelist) });
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        });
        return true;
    }
    else if (request.action === 'exportRules') {
        chrome.storage.local.get(['rules', 'whitelist', 'pinned']).then(data => {
            const exportData = {
                version: PRESET_RULES.version,
                exportedAt: new Date().toISOString(),
                rules: data.rules || {},
                whitelist: data.whitelist || [],
                pinned: data.pinned || []
            };
            sendResponse({ success: true, data: exportData });
        });
        return true;
    }
    else if (request.action === 'toggleExt') {
        chrome.management.setEnabled(request.id, request.enabled);
        const actionType = 'MANUAL';
        chrome.management.get(request.id).then(ext => {
            logAction(actionType, ext.name, `User ${request.enabled ? 'enabled' : 'disabled'} extension manually`);
        });
        sendResponse({ success: true });
    }
    else if (request.action === 'getLogs') {
        chrome.storage.local.get(['logs']).then(data => {
            sendResponse({ logs: data.logs || [] });
        });
        return true;
    }
    else if (request.action === 'clearLogs') {
        chrome.storage.local.set({ logs: [] }).then(() => {
            sendResponse({ success: true });
        });
        return true;
    }
    else if (request.action === 'savePinned') {
        chrome.storage.local.set({ pinned: request.pinned }).then(() => {
            sendResponse({ success: true });
        });
        return true;
    }
    else if (request.action === 'uninstallExt') {
        chrome.management.uninstall(request.id, { showConfirmDialog: true });
        sendResponse({ success: true });
    }
});

// Click action opens dashboard
chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: 'dashboard.html' });
});
