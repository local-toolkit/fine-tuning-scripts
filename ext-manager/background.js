// Core Automation Engine - Commercial Grade (v2)

// Configuration
// rules structure: { "extensionId": ["google.com", "/^https:\/\/.*\.github\.com/"] }
let rules = {};
// whitelist: Extensions that should NEVER be auto-disabled
let whitelist = new Set();
let selfId = chrome.runtime.id;
let rulesLoaded = false;
let presetRulesConfig = null;
const CURRENT_PRESET_VERSION = "1.0.0";
const ALIASED_PRESET_IDS = new Set([
    "cmedhionkhpnakcndndgjdbohmhepckk"
]);
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

function setToArray(set) {
    const items = [];
    for (const item of set) {
        items.push(item);
    }
    return items;
}

async function getPresetRulesConfig() {
    if (presetRulesConfig) {
        return presetRulesConfig;
    }

    const response = await fetch(chrome.runtime.getURL('preset-rules.json'));
    presetRulesConfig = await response.json();
    return presetRulesConfig;
}

function getManagedPresetExtensionIds(extensions, presetRules) {
    const aliasesByPresetId = presetRules.aliases || {};
    const managedPresetIds = new Set(Object.keys(aliasesByPresetId));

    for (const presetId in aliasesByPresetId) {
        const aliases = aliasesByPresetId[presetId];
        const matchedExtension = extensions.find(ext =>
            ext.id === presetId || aliases.some(alias => extensionMatchesAlias(ext.name, alias))
        );

        if (matchedExtension) {
            managedPresetIds.add(matchedExtension.id);
        }
    }

    return managedPresetIds;
}

async function resolvePresetRules() {
    const presetRules = await getPresetRulesConfig();
    const extensions = await chrome.management.getAll();
    const installedById = new Map();
    const resolvedRules = {};

    for (const ext of extensions) {
        installedById.set(ext.id, ext);
    }

    for (const presetId in presetRules.rules) {
        const presetRuleList = presetRules.rules[presetId];
        const aliases = presetRules.aliases?.[presetId] || [];
        const matchedExtension = installedById.get(presetId) ||
            extensions.find(ext => aliases.some(alias => extensionMatchesAlias(ext.name, alias)));

        resolvedRules[matchedExtension ? matchedExtension.id : presetId] = presetRuleList;
    }

    return resolvedRules;
}

async function migratePresetRuleAliases() {
    const presetRules = await getPresetRulesConfig();
    const extensions = await chrome.management.getAll();
    const installedById = new Map();
    let changed = false;

    for (const ext of extensions) {
        installedById.set(ext.id, ext);
    }

    for (const presetId in presetRules.aliases || {}) {
        if (!rules[presetId] || installedById.has(presetId)) {
            continue;
        }

        const aliases = presetRules.aliases[presetId];
        const matchedExtension = extensions.find(ext =>
            aliases.some(alias => extensionMatchesAlias(ext.name, alias))
        );

        if (!matchedExtension) {
            continue;
        }

        const mergedRules = [];
        for (const rule of rules[matchedExtension.id] || []) {
            mergedRules.push(rule);
        }
        for (const rule of rules[presetId]) {
            if (!mergedRules.includes(rule)) {
                mergedRules.push(rule);
            }
        }
        rules[matchedExtension.id] = mergedRules;
        delete rules[presetId];
        changed = true;
    }

    if (changed) {
        await chrome.storage.local.set({ rules });
    }
}

async function ensureAliasedPresetRules() {
    const presetRules = await getPresetRulesConfig();
    const extensions = await chrome.management.getAll();
    let changed = false;

    for (const presetId in presetRules.aliases || {}) {
        const aliases = presetRules.aliases[presetId];
        const matchedExtension = extensions.find(ext =>
            ext.id === presetId || aliases.some(alias => extensionMatchesAlias(ext.name, alias))
        );

        if (!matchedExtension) {
            continue;
        }

        const presetRuleList = presetRules.rules[presetId] || [];
        const existingRules = rules[matchedExtension.id] || [];
        const nextRules = [...presetRuleList];

        if (JSON.stringify(existingRules) !== JSON.stringify(nextRules)) {
            rules[matchedExtension.id] = nextRules;
            changed = true;
        }

        if (presetId !== matchedExtension.id && rules[presetId]) {
            delete rules[presetId];
            changed = true;
        }
    }

    if (changed) {
        await chrome.storage.local.set({ rules });
    }
}

async function migrateManagedPresetWhitelist() {
    const presetRules = await getPresetRulesConfig();
    const extensions = await chrome.management.getAll();
    const managedPresetIds = getManagedPresetExtensionIds(extensions, presetRules);
    const nextWhitelist = [];

    for (const id of whitelist) {
        if (!managedPresetIds.has(id)) {
            nextWhitelist.push(id);
        }
    }

    if (nextWhitelist.length !== whitelist.size) {
        whitelist = new Set([...nextWhitelist, selfId]);
        await chrome.storage.local.set({ whitelist: setToArray(whitelist) });
    }
}

async function migrateAlwaysOnExtensions() {
    let changedRules = false;
    let changedWhitelist = false;

    for (const id of ALWAYS_ON_EXTENSION_IDS) {
        if (rules[id]) {
            delete rules[id];
            changedRules = true;
        }

        if (!whitelist.has(id)) {
            whitelist.add(id);
            changedWhitelist = true;
        }
    }

    if (changedRules || changedWhitelist) {
        await chrome.storage.local.set({
            rules,
            whitelist: setToArray(whitelist)
        });
    }
}

chrome.runtime.onInstalled.addListener(async () => {
    await loadRules();
    whitelist.add(selfId);
    checkTabsAndApplyState();
});

chrome.runtime.onStartup.addListener(() => {
    checkTabsAndApplyState();
});

// Load rules from storage
async function loadRules() {
    const data = await chrome.storage.local.get(['rules', 'whitelist', 'presetLoaded', 'presetVersion']);
    rules = data.rules || {};
    const storedWhitelist = data.whitelist || [];
    whitelist = new Set([...storedWhitelist, selfId]);

    // Load preset rules only for truly empty installs. Existing users may already
    // have custom rules from before the presetLoaded flag existed.
    if (!data.presetLoaded && Object.keys(rules).length === 0) {
        await loadPresetRules();
    } else {
        const needsPresetMigration =
            data.presetVersion !== CURRENT_PRESET_VERSION ||
            Object.keys(rules).some(id => ALIASED_PRESET_IDS.has(id)) ||
            storedWhitelist.some(id => ALIASED_PRESET_IDS.has(id));

        if (needsPresetMigration) {
            await migratePresetRuleAliases();
            await ensureAliasedPresetRules();
            await migrateManagedPresetWhitelist();
            await chrome.storage.local.set({ presetVersion: CURRENT_PRESET_VERSION });
        }

        await migrateAlwaysOnExtensions();
    }

    rulesLoaded = true;
}

// Load preset rules only when needed; keep them out of the worker hot path.
async function loadPresetRules() {
    const presetRules = await getPresetRulesConfig();
    rules = await resolvePresetRules();
    const whitelistWithSelf = [...presetRules.whitelist, selfId];
    whitelist = new Set(whitelistWithSelf);
    rulesLoaded = true;

    await chrome.storage.local.set({
        rules: rules,
        whitelist: whitelistWithSelf,
        presetLoaded: true,
        presetVersion: CURRENT_PRESET_VERSION
    });

}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
        scheduleStateCheck();
    }
});

chrome.tabs.onRemoved.addListener(() => {
    scheduleStateCheck();
});

chrome.tabs.onReplaced.addListener(() => {
    scheduleStateCheck();
});

// Main Logic: The Decision Engine
const manualEnableRequired = new Set();
let manualEnableRequiredLoaded = false;
let checkInProgress = false;
let checkQueued = false;
let checkTimer = null;

async function loadManualEnableRequired() {
    if (manualEnableRequiredLoaded) return;

    const data = await chrome.storage.local.get(['manualEnableRequired']);
    manualEnableRequired.clear();
    for (const id of data.manualEnableRequired || []) {
        manualEnableRequired.add(id);
    }
    manualEnableRequiredLoaded = true;
}

async function saveManualEnableRequired() {
    manualEnableRequiredLoaded = true;
    await chrome.storage.local.set({ manualEnableRequired: setToArray(manualEnableRequired) });
}

async function getExtensionById(id) {
    try {
        return await chrome.management.get(id);
    } catch (error) {
        return null;
    }
}

function toDashboardExtension(ext) {
    const icons = ext.icons || [];
    const icon = icons.length > 0 ? icons[icons.length - 1].url : 'icon48.png';
    return {
        id: ext.id,
        name: ext.name,
        enabled: ext.enabled,
        iconUrl: icon
    };
}

function checkTabsAndApplyState() {
    if (checkTimer) {
        clearTimeout(checkTimer);
        checkTimer = null;
    }

    if (checkInProgress) {
        checkQueued = true;
        return;
    }

    performCheck();
}

function scheduleStateCheck(delay = 250) {
    if (checkTimer) {
        clearTimeout(checkTimer);
    }

    checkTimer = setTimeout(() => {
        checkTimer = null;
        checkTabsAndApplyState();
    }, delay);
}

async function performCheck() {
    checkInProgress = true;
    try {
        if (!rulesLoaded) {
            await loadRules();
        }

        const managedExtensionIds = [];
        for (const id in rules) {
            if (id !== selfId && Array.isArray(rules[id]) && rules[id].length > 0) {
                managedExtensionIds.push(id);
            }
        }

        if (managedExtensionIds.length === 0) {
            return;
        }

        await loadManualEnableRequired();
        
        // 1. Get all open tab URLs (Full URLs for Regex matching)
        const tabs = await chrome.tabs.query({});
        const openUrls = [];
        
        for (const tab of tabs) {
            const url = tab.pendingUrl || tab.url;
            if (url) {
                openUrls.push(url);
            }
        }

        // 2. Apply State
        for (const extId of managedExtensionIds) {
            const ext = await getExtensionById(extId);
            if (!ext) continue;

            if (ext.enabled) {
                if (manualEnableRequired.delete(ext.id)) {
                    await saveManualEnableRequired();
                }
            }

            let shouldBeEnabled = whitelist.has(ext.id);
            if (!shouldBeEnabled) {
                for (const ruleStr of rules[ext.id]) {
                    try {
                        for (const url of openUrls) {
                            if (ruleMatchesUrl(ruleStr, url)) {
                                shouldBeEnabled = true;
                                break;
                            }
                        }
                    } catch (e) {
                    }

                    if (shouldBeEnabled) {
                        break;
                    }
                }
            }

            if (shouldBeEnabled && !ext.enabled && manualEnableRequired.has(ext.id)) {
                continue;
            }

            if (ext.enabled !== shouldBeEnabled) {
                try {
                    await chrome.management.setEnabled(ext.id, shouldBeEnabled);
                } catch (error) {
                    if (shouldBeEnabled && /user gesture|permissions increase/i.test(error.message)) {
                        manualEnableRequired.add(ext.id);
                        await saveManualEnableRequired();
                    }
                }
            }
        }

    } catch (error) {
    } finally {
        checkInProgress = false;
        if (checkQueued) {
            checkQueued = false;
            scheduleStateCheck();
        }
    }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes.rules) {
        rules = changes.rules.newValue || {};
        rulesLoaded = true;
    }

    if (changes.whitelist) {
        whitelist = new Set();
        for (const id of changes.whitelist.newValue || []) {
            whitelist.add(id);
        }
        whitelist.add(selfId);
        rulesLoaded = true;
    }

    if (changes.manualEnableRequired) {
        manualEnableRequired.clear();
        for (const id of changes.manualEnableRequired.newValue || []) {
            manualEnableRequired.add(id);
        }
        manualEnableRequiredLoaded = true;
    }
});

// Interface for Dashboard
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getData') {
        Promise.all([
            chrome.management.getAll(),
            chrome.storage.local.get(['rules', 'pinned'])
        ]).then(([extensions, data]) => {
            const dashboardExtensions = [];
            for (const ext of extensions) {
                dashboardExtensions.push(toDashboardExtension(ext));
            }

            sendResponse({
                extensions: dashboardExtensions,
                rules: data.rules || {},
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
            sendResponse({ success: true, rules, whitelist: setToArray(whitelist) });
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        });
        return true;
    }
    else if (request.action === 'exportRules') {
        chrome.storage.local.get(['rules', 'whitelist', 'pinned']).then(data => {
            const exportData = {
                version: CURRENT_PRESET_VERSION,
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
        sendResponse({ success: true });
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
