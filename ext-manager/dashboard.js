// Dashboard Controller

let extensions = [];
let rules = {};
let pinned = [];
let currentEditId = null;
let devRuntimeState = null;

function getDevRuntimeState() {
    if (devRuntimeState) return devRuntimeState;

    const devIcon = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"%3E%3Crect width="48" height="48" rx="10" fill="%232563eb"/%3E%3Cpath fill="white" d="M15 14h18v4H20v4h11v4H20v4h13v4H15z"/%3E%3C/svg%3E';
    devRuntimeState = {
        extensions: [
            { id: 'reader', name: 'Reader View Assistant', enabled: true, iconUrl: devIcon },
            { id: 'speed', name: 'QuickSpeed Video Controller', enabled: true, iconUrl: devIcon },
            { id: 'clipper', name: 'Research Clipper for Long Articles', enabled: false, iconUrl: devIcon },
            { id: 'translate', name: 'Context Translator', enabled: false, iconUrl: devIcon },
            { id: 'focus', name: 'Focus Tab Cleaner', enabled: true, iconUrl: devIcon }
        ],
        rules: {
            reader: ['wikipedia.org', '/^https?:\\/\\/(?:[a-z0-9-]+\\.)*github\\.com/i'],
            speed: ['youtube.com', 'bilibili.com']
        },
        pinned: ['speed']
    };

    return devRuntimeState;
}

async function sendRuntimeMessage(message) {
    if (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage) {
        return chrome.runtime.sendMessage(message);
    }

    const devState = getDevRuntimeState();
    switch (message.action) {
        case 'getData':
            return {
                extensions: devState.extensions,
                rules: devState.rules,
                pinned: devState.pinned
            };
        case 'savePinned':
            devState.pinned = message.pinned;
            return { success: true };
        case 'toggleExt':
            for (const ext of devState.extensions) {
                if (ext.id === message.id) {
                    ext.enabled = message.enabled;
                    break;
                }
            }
            return { success: true };
        case 'saveRules':
            devState.rules = message.rules;
            return { success: true };
        case 'importPresetRules':
            return { success: true };
        case 'exportRules':
            return { success: true, data: devState.rules };
        default:
            return {};
    }
}

document.addEventListener('DOMContentLoaded', init);

async function init() {
    await refreshData();
    setupNavigation();
    setupSearch();
    setupModal();
    setupRuleActions();
    setupExtensionGridActions();
    setupRulesTableActions();
    setupModalRuleActions();
}

async function refreshData() {
    const data = await sendRuntimeMessage({ action: 'getData' });
    extensions = data.extensions;
    rules = data.rules;
    pinned = data.pinned || [];
    
    updateStats();
    renderCurrentView();
}

function renderCurrentView() {
    const activeNav = document.querySelector('.nav-item.active');
    const viewId = activeNav ? activeNav.dataset.view : 'dashboard';

    if (viewId === 'extensions') {
        renderExtensions();
    } else if (viewId === 'rules') {
        renderRulesView();
    }
}

// --- Navigation ---
function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const viewSections = document.querySelectorAll('.view-section');

    for (const item of navItems) {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            // nav state
            for (const navItem of navItems) {
                navItem.classList.remove('active');
            }
            item.classList.add('active');
            
            // view state
            const viewId = item.dataset.view;
            for (const view of viewSections) {
                view.classList.remove('active');
            }
            const viewEl = document.getElementById(`view-${viewId}`);
            if (viewEl) viewEl.classList.add('active');
            
            // title
            document.getElementById('pageTitle').textContent = item.textContent.trim();

            renderCurrentView();
        });
    }
}

// --- Stats ---
function updateStats() {
    const total = extensions.length;
    let active = 0;
    let managed = 0;

    for (const ext of extensions) {
        if (ext.enabled) active += 1;
    }

    for (const id in rules) {
        if (rules[id]) managed += 1;
    }

    document.getElementById('statTotal').textContent = total;
    document.getElementById('statActive').textContent = active;
    document.getElementById('statManaged').textContent = managed;
}

// --- Extension Grid ---
function renderExtensions(filter = 'all', searchTerm = '') {
    const grid = document.getElementById('extGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const searchInput = document.getElementById('globalSearch');
    const search = (searchTerm || searchInput?.value || '').toLowerCase();
    const fragment = document.createDocumentFragment();
    const sortedExtensions = extensions.sort((a, b) => {
        // Pinned extensions first
        const aPinned = pinned.includes(a.id);
        const bPinned = pinned.includes(b.id);
        if (aPinned && !bPinned) return -1;
        if (!aPinned && bPinned) return 1;

        // Then Managed extensions
        const aManaged = !!rules[a.id];
        const bManaged = !!rules[b.id];
        if (aManaged && !bManaged) return -1;
        if (!aManaged && bManaged) return 1;

        return a.name.localeCompare(b.name);
    });

    for (const ext of sortedExtensions) {
        // Filters
        if (filter === 'enabled' && !ext.enabled) continue;
        if (filter === 'disabled' && ext.enabled) continue;
        if (search && !ext.name.toLowerCase().includes(search)) continue;

        const isManaged = !!rules[ext.id];
        const isPinned = pinned.includes(ext.id);
        const card = document.createElement('div');
        card.className = 'ext-card';
        
        // Icon
        card.innerHTML = `
            <button class="pin-btn ${isPinned ? 'pinned' : ''}" data-id="${ext.id}" title="${isPinned ? '取消置顶' : '置顶'}" aria-label="${isPinned ? '取消置顶' : '置顶'}"></button>
            <img src="${ext.iconUrl || 'icon48.png'}" class="ext-icon" alt="icon">
            <div class="ext-info">
                <div class="ext-name" title="${ext.name}">${ext.name}</div>
                <div class="ext-meta">
                    <span class="ext-status ${ext.enabled ? 'enabled' : 'disabled'}">
                        ${ext.enabled ? '运行中' : '已停用'}
                    </span>
                    ${isManaged ? '<span class="ext-badge auto">AUTO</span>' : ''}
                </div>
                <div class="ext-actions">
                    <button class="btn-sm toggle-btn ${ext.enabled ? 'is-enabled' : ''}" data-id="${ext.id}">
                        ${ext.enabled ? '停用' : '启用'}
                    </button>
                    <button class="btn-sm btn-rule" data-id="${ext.id}">
                        ${isManaged ? '编辑规则' : '添加规则'}
                    </button>
                </div>
            </div>
        `;

        fragment.appendChild(card);
    }

    grid.appendChild(fragment);
}

function setupExtensionGridActions() {
    const grid = document.getElementById('extGrid');
    if (!grid) return;

    grid.addEventListener('click', (e) => {
        const pinBtn = e.target.closest('.pin-btn');
        if (pinBtn) {
            togglePin(pinBtn.dataset.id);
            return;
        }

        const toggleBtn = e.target.closest('.toggle-btn');
        if (toggleBtn) {
            const ext = extensions.find(item => item.id === toggleBtn.dataset.id);
            if (ext) toggleExtension(ext.id, !ext.enabled);
            return;
        }

        const ruleBtn = e.target.closest('.btn-rule');
        if (ruleBtn) {
            openRuleEditor(ruleBtn.dataset.id);
        }
    });
}

async function togglePin(id) {
    const pinnedIndex = pinned.indexOf(id);
    if (pinnedIndex >= 0) {
        pinned.splice(pinnedIndex, 1);
    } else {
        pinned.push(id);
    }
    await sendRuntimeMessage({ action: 'savePinned', pinned });
    if (getCurrentViewId() === 'extensions') {
        renderExtensions();
    }
}

// --- Searching ---
function getCurrentViewId() {
    const activeNav = document.querySelector('.nav-item.active');
    return activeNav ? activeNav.dataset.view : 'dashboard';
}

function setupSearch() {
    const input = document.getElementById('globalSearch');
    input.addEventListener('input', (e) => {
        if (getCurrentViewId() === 'extensions') {
            renderExtensions('all', e.target.value);
        }
    });
}

// --- Actions ---
async function toggleExtension(id, enabled) {
    await sendRuntimeMessage({ action: 'toggleExt', id, enabled });
    await refreshData();
}

// --- Rule Modal & Regex Logic ---
const modal = document.getElementById('ruleModal');
let tempRules = []; // Temporary rules for the currently open modal
let rulePresets = null;
let presetRulesInitialized = false;

function getRulePresets() {
    if (rulePresets) return rulePresets;

    rulePresets = [
    {
        id: 'youtube',
        name: 'YouTube',
        rules: [
            '/^https?:\\/\\/(?:[a-z0-9-]+\\.)*(?:youtube\\.com|youtube-nocookie\\.com|youtu\\.be)(?::\\d+)?(?:[/?#]|$)/i'
        ]
    },
    {
        id: 'google-search',
        name: 'Google Search',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*google\\.[a-z.]+(?::\\d+)?\\/(?:search|webhp|imghp|maps|shopping|travel|flights)(?:[/?#]|$)/i']
    },
    {
        id: 'gmail',
        name: 'Gmail',
        rules: ['/^https?:\\/\\/(?:mail\\.google\\.com|inbox\\.google\\.com)(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'google-docs',
        name: 'Google Docs / Sheets / Slides',
        rules: ['/^https?:\\/\\/docs\\.google\\.com(?::\\d+)?\\/(?:document|spreadsheets|presentation|forms|drawings)(?:[/?#]|$)/i']
    },
    {
        id: 'google-drive',
        name: 'Google Drive',
        rules: ['/^https?:\\/\\/drive\\.google\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'google-scholar',
        name: 'Google Scholar',
        rules: ['/^https?:\\/\\/scholar\\.google\\.[a-z.]+(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'github',
        name: 'GitHub',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*github\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'gitlab',
        name: 'GitLab',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*gitlab\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'stackoverflow',
        name: 'Stack Overflow / Stack Exchange',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*(?:stackoverflow\\.com|stackexchange\\.com|serverfault\\.com|superuser\\.com|askubuntu\\.com)(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'reddit',
        name: 'Reddit',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*reddit\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'x-twitter',
        name: 'X / Twitter',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*(?:x\\.com|twitter\\.com|t\\.co)(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'facebook',
        name: 'Facebook / Messenger',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*(?:facebook\\.com|messenger\\.com|fb\\.com|fb\\.me)(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'instagram',
        name: 'Instagram',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*instagram\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'linkedin',
        name: 'LinkedIn',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*linkedin\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'amazon',
        name: 'Amazon',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*amazon\\.[a-z.]+(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'netflix',
        name: 'Netflix',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*netflix\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'bilibili',
        name: 'Bilibili',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*(?:bilibili\\.com|b23\\.tv)(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'zhihu',
        name: 'Zhihu',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*zhihu\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'weibo',
        name: 'Weibo',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*(?:weibo\\.com|weibo\\.cn)(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'baidu',
        name: 'Baidu',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*baidu\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'wikipedia',
        name: 'Wikipedia',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*wikipedia\\.org(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'openai-chatgpt',
        name: 'OpenAI / ChatGPT',
        rules: ['/^https?:\\/\\/(?:chatgpt\\.com|(?:[a-z0-9-]+\\.)*openai\\.com)(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'slack',
        name: 'Slack',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*slack\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'discord',
        name: 'Discord',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*discord\\.(?:com|gg)(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'notion',
        name: 'Notion',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*notion\\.(?:site|so)(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'figma',
        name: 'Figma',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*figma\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'atlassian',
        name: 'Jira / Confluence',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*atlassian\\.net(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'trello',
        name: 'Trello',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*trello\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'dropbox',
        name: 'Dropbox',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*dropbox\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'icloud',
        name: 'iCloud',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*icloud\\.com(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'microsoft-365',
        name: 'Microsoft 365 / Outlook / Teams',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*(?:office\\.com|microsoft365\\.com|live\\.com|outlook\\.com|office365\\.com|teams\\.microsoft\\.com)(?::\\d+)?(?:[/?#]|$)/i']
    },
    {
        id: 'zoom',
        name: 'Zoom',
        rules: ['/^https?:\\/\\/(?:[a-z0-9-]+\\.)*zoom\\.us(?::\\d+)?(?:[/?#]|$)/i']
    }
    ];

    return rulePresets;
}

function isRegexRule(rule) {
    return typeof rule === 'string' && rule.startsWith('/') && rule.lastIndexOf('/') > 0;
}

function validateRegexRule(rule) {
    const lastSlash = rule.lastIndexOf('/');
    if (lastSlash <= 0) throw new Error('Missing closing slash');
    new RegExp(rule.slice(1, lastSlash), rule.slice(lastSlash + 1));
}

function addRulesToModal(newRules) {
    let added = 0;
    for (const rule of newRules) {
        if (!tempRules.includes(rule)) {
            tempRules.push(rule);
            added += 1;
        }
    }
    renderModalRules();
    return added;
}

function setupPresetRules() {
    if (presetRulesInitialized) return;
    const select = document.getElementById('presetRuleSelect');
    if (!select) return;

    const fragment = document.createDocumentFragment();
    for (const preset of getRulePresets()) {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.name;
        fragment.appendChild(option);
    }
    select.appendChild(fragment);
    presetRulesInitialized = true;
}

function setupModal() {
    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('cancelModal').addEventListener('click', closeModal);

    document.getElementById('addPresetRuleBtn').addEventListener('click', () => {
        const select = document.getElementById('presetRuleSelect');
        const preset = getRulePresets().find(item => item.id === select.value);
        if (!preset) return;

        try {
            for (const rule of preset.rules) {
                validateRegexRule(rule);
            }
        } catch (e) {
            alert(`Preset Regex Invalid: ${preset.name}`);
            return;
        }

        addRulesToModal(preset.rules);
        select.value = '';
    });
    
    document.getElementById('addRuleBtn').addEventListener('click', () => {
        const input = document.getElementById('newRuleInput');
        const type = document.getElementById('ruleType').value;
        let value = input.value.trim();

        if (!value) return;

        // Auto-wrap Regex if user selected Regex but didn't wrap it
        if (type === 'regex' && !value.startsWith('/')) {
            value = `/${value}/`;
        }
        
        // Validation
        if (value.startsWith('/')) {
            try {
                validateRegexRule(value);
            } catch(e) {
                alert('Invalid Regex Pattern');
                return;
            }
        }

        addRulesToModal([value]);
        input.value = '';
    });

    document.getElementById('saveRulesBtn').addEventListener('click', async () => {
        // Save to global rules
        if (currentEditId) {
            if (tempRules.length > 0) {
                rules[currentEditId] = tempRules;
            } else {
                delete rules[currentEditId]; // Empty rules = Remove management
            }
            
            await sendRuntimeMessage({ action: 'saveRules', rules });
            closeModal();
            refreshData();
        }
    });
}

function setupModalRuleActions() {
    const list = document.getElementById('modalRuleList');
    if (!list) return;

    list.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.remove-rule-btn');
        if (!removeBtn) return;

        tempRules.splice(Number(removeBtn.dataset.idx), 1);
        renderModalRules();
    });
}

// --- Rules View ---
function renderRulesView() {
    const tableBody = document.getElementById('rulesTableBody');
    if (!tableBody) return;
    tableBody.innerHTML = '';

    const fragment = document.createDocumentFragment();
    let hasRules = false;

    for (const id in rules) {
        const ext = extensions.find(e => e.id === id);
        if (!ext) continue;

        hasRules = true;
        const tr = document.createElement('tr');
        let ruleTags = '';
        for (const rule of rules[id]) {
            const isRegex = isRegexRule(rule);
            ruleTags += `<span class="tag ${isRegex ? 'regex' : 'domain'}">${rule}</span>`;
        }

        tr.innerHTML = `
            <td>
                <div class="ext-cell">
                    <img src="${ext.iconUrl || 'icon16.png'}" alt="">
                    <strong>${ext.name}</strong>
                </div>
            </td>
            <td><div class="rule-tags">${ruleTags}</div></td>
            <td>
                <div class="row-actions">
                    <button class="btn-sm btn-rule" data-id="${id}">编辑</button>
                    <button class="btn-sm remove-rule-btn" data-id="${id}">移除</button>
                </div>
            </td>
        `;
        fragment.appendChild(tr);
    }

    if (!hasRules) {
        tableBody.innerHTML = '<tr><td colspan="3"><div class="empty-message">暂无自动化规则</div></td></tr>';
        return;
    }

    tableBody.appendChild(fragment);
}

function setupRulesTableActions() {
    const tableBody = document.getElementById('rulesTableBody');
    if (!tableBody) return;

    tableBody.addEventListener('click', async (e) => {
        const ruleBtn = e.target.closest('.btn-rule');
        if (ruleBtn) {
            openRuleEditor(ruleBtn.dataset.id);
            return;
        }

        const removeBtn = e.target.closest('.remove-rule-btn');
        if (removeBtn) {
            delete rules[removeBtn.dataset.id];
            await sendRuntimeMessage({ action: 'saveRules', rules });
            refreshData();
        }
    });
}

// --- Rule Import/Export ---
function setupRuleActions() {
    const importBtn = document.getElementById('importPresetBtn');
    if (importBtn) {
        importBtn.addEventListener('click', async () => {
            if (confirm('导入预设规则将完全覆盖当前规则，确定要继续吗？')) {
                const response = await sendRuntimeMessage({ action: 'importPresetRules' });
                if (response.success) {
                    alert('预设规则导入成功！');
                    await refreshData();
                } else {
                    alert('导入失败：' + response.error);
                }
            }
        });
    }

    const exportBtn = document.getElementById('exportRulesBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
            const response = await sendRuntimeMessage({ action: 'exportRules' });
            if (response.success) {
                const dataStr = JSON.stringify(response.data, null, 2);
                const blob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `ext-manager-rules-${new Date().toISOString().split('T')[0]}.json`;
                a.click();
                URL.revokeObjectURL(url);
            } else {
                alert('导出失败');
            }
        });
    }
}

function openRuleEditor(extId) {
    setupPresetRules();
    currentEditId = extId;
    const ext = extensions.find(e => e.id === extId);
    tempRules = rules[extId] ? [...rules[extId]] : [];
    
    document.getElementById('modalTitle').textContent = `配置规则：${ext.name}`;
    renderModalRules();
    
    modal.classList.remove('hidden');
}

function renderModalRules() {
    const list = document.getElementById('modalRuleList');
    list.innerHTML = '';
    
    if (tempRules.length === 0) {
        list.innerHTML = '<div class="empty-message">未配置规则。该扩展将保持手动管理。</div>';
        return;
    }

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < tempRules.length; index += 1) {
        const rule = tempRules[index];
        const isRegex = isRegexRule(rule);
        const item = document.createElement('div');
        item.className = 'rule-item';
        
        item.innerHTML = `
            <div>
                <span class="tag ${isRegex ? 'regex' : 'domain'}">${isRegex ? 'REGEX' : 'DOMAIN'}</span>
                <code>${isRegex ? rule : rule}</code>
            </div>
            <button class="btn-sm remove-rule-btn" data-idx="${index}">×</button>
        `;
        fragment.appendChild(item);
    }

    list.appendChild(fragment);
}

function closeModal() {
    modal.classList.add('hidden');
    currentEditId = null;
    tempRules = [];
}
