// Dashboard Controller

let extensions = [];
let rules = {};
let whitelist = [];
let pinned = [];
let currentEditId = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
    await refreshData();
    setupNavigation();
    setupSearch();
    setupModal();
    setupLogActions();
    setupRuleActions();
}

async function refreshData() {
    const data = await chrome.runtime.sendMessage({ action: 'getData' });
    extensions = data.extensions;
    rules = data.rules;
    whitelist = data.whitelist;
    pinned = data.pinned || [];
    
    updateStats();
    renderCurrentView();
}

function renderCurrentView() {
    const activeNav = document.querySelector('.nav-item.active');
    const viewId = activeNav ? activeNav.dataset.view : 'dashboard';
    
    renderExtensions(); // Always render extension grid in background? Or just when needed.
    
    if (viewId === 'dashboard') {
        renderLogsPreview();
    } else if (viewId === 'extensions') {
        // extensions already rendered by renderExtensions
    } else if (viewId === 'rules') {
        renderRulesView();
    } else if (viewId === 'logs') {
        renderFullLogs();
    }
}

// --- Navigation ---
function setupNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            // nav state
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            item.classList.add('active');
            
            // view state
            const viewId = item.dataset.view;
            document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active'));
            const viewEl = document.getElementById(`view-${viewId}`);
            if (viewEl) viewEl.classList.add('active');
            
            // title
            document.getElementById('pageTitle').textContent = item.textContent.trim();

            renderCurrentView();
        });
    });
}

// --- Stats ---
function updateStats() {
    const total = extensions.length;
    const active = extensions.filter(e => e.enabled).length;
    const managed = Object.keys(rules).length;

    document.getElementById('statTotal').textContent = total;
    document.getElementById('statActive').textContent = active;
    document.getElementById('statManaged').textContent = managed;
}

// --- Extension Grid ---
function renderExtensions(filter = 'all', searchTerm = '') {
    const grid = document.getElementById('extGrid');
    if (!grid) return;
    grid.innerHTML = '';

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

    sortedExtensions.forEach(ext => {
        // Filters
        if (filter === 'enabled' && !ext.enabled) return;
        if (filter === 'disabled' && ext.enabled) return;
        const search = document.getElementById('globalSearch') ? document.getElementById('globalSearch').value : '';
        if (search && !ext.name.toLowerCase().includes(search.toLowerCase())) return;

        const isManaged = !!rules[ext.id];
        const isPinned = pinned.includes(ext.id);
        const card = document.createElement('div');
        card.className = 'ext-card';
        card.style.position = 'relative';
        
        // Icon
        const iconUrl = ext.icons ? ext.icons[ext.icons.length - 1].url : 'icon48.png';
        
        card.innerHTML = `
            <button class="pin-btn ${isPinned ? 'pinned' : ''}" title="Pin to top">📌</button>
            <img src="${iconUrl}" class="ext-icon" alt="icon">
            <div class="ext-info">
                <div class="ext-name" title="${ext.name}">${ext.name}</div>
                <div class="ext-status ${ext.enabled ? 'enabled' : 'disabled'}">
                    ${ext.enabled ? 'Active' : 'Inactive'}
                </div>
                ${isManaged ? '<span style="font-size:10px; color:#3699ff; background:#e1f0ff; padding:2px 4px; border-radius:4px;">AUTO</span>' : ''}
                <div class="ext-actions">
                    <button class="btn-sm toggle-btn" data-id="${ext.id}">
                        ${ext.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button class="btn-sm btn-rule" data-id="${ext.id}">
                        ${isManaged ? 'Edit Rules' : 'Add Rule'}
                    </button>
                </div>
            </div>
        `;

        card.querySelector('.pin-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            togglePin(ext.id);
        });
        card.querySelector('.toggle-btn').addEventListener('click', () => toggleExtension(ext.id, !ext.enabled));
        card.querySelector('.btn-rule').addEventListener('click', () => openRuleEditor(ext.id));
        
        grid.appendChild(card);
    });
}

async function togglePin(id) {
    if (pinned.includes(id)) {
        pinned = pinned.filter(p => p !== id);
    } else {
        pinned.push(id);
    }
    await chrome.runtime.sendMessage({ action: 'savePinned', pinned });
    renderExtensions();
}

// --- Searching ---
function setupSearch() {
    const input = document.getElementById('globalSearch');
    input.addEventListener('input', (e) => {
        renderExtensions('all', e.target.value);
    });
}

// --- Actions ---
async function toggleExtension(id, enabled) {
    await chrome.runtime.sendMessage({ action: 'toggleExt', id, enabled });
    await refreshData();
}

// --- Rule Modal & Regex Logic ---
const modal = document.getElementById('ruleModal');
let tempRules = []; // Temporary rules for the currently open modal

function isRegexRule(rule) {
    return typeof rule === 'string' && rule.startsWith('/') && rule.lastIndexOf('/') > 0;
}

function setupModal() {
    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('cancelModal').addEventListener('click', closeModal);
    
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
                const lastSlash = value.lastIndexOf('/');
                if (lastSlash <= 0) throw new Error('Missing closing slash');
                new RegExp(value.slice(1, lastSlash), value.slice(lastSlash + 1));
            } catch(e) {
                alert('Invalid Regex Pattern');
                return;
            }
        }

        tempRules.push(value);
        renderModalRules();
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
            
            await chrome.runtime.sendMessage({ action: 'saveRules', rules });
            closeModal();
            refreshData();
        }
    });
}

// --- Rules View ---
function renderRulesView() {
    const tableBody = document.getElementById('rulesTableBody');
    if (!tableBody) return;
    tableBody.innerHTML = '';

    const managedIds = Object.keys(rules);
    if (managedIds.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:40px; color:#999;">暂无自动化规则</td></tr>';
        return;
    }

    managedIds.forEach(id => {
        const ext = extensions.find(e => e.id === id);
        if (!ext) return;

        const tr = document.createElement('tr');
        const ruleTags = rules[id].map(r => {
            const isRegex = isRegexRule(r);
            return `<span class="tag ${isRegex ? 'regex' : 'domain'}">${r}</span>`;
        }).join('');

        tr.innerHTML = `
            <td>
                <div style="display:flex; align-items:center; gap:10px;">
                    <img src="${ext.icons ? ext.icons[0].url : 'icon16.png'}" style="width:24px; height:24px; border-radius:4px;">
                    <strong style="color:var(--text-primary)">${ext.name}</strong>
                </div>
            </td>
            <td><div class="rule-tags">${ruleTags}</div></td>
            <td>
                <div style="display:flex; gap:8px;">
                    <button class="btn-sm btn-rule" data-id="${id}">编辑</button>
                    <button class="btn-sm remove-rule-btn" style="color:var(--danger); border-color:rgba(246,78,96,0.2);">移除</button>
                </div>
            </td>
        `;
        
        tr.querySelector('.btn-rule').addEventListener('click', () => openRuleEditor(id));
        tr.querySelector('.remove-rule-btn').addEventListener('click', async () => {
            delete rules[id];
            await chrome.runtime.sendMessage({ action: 'saveRules', rules });
            refreshData();
        });
        tableBody.appendChild(tr);
    });
}

// --- Logs View ---
function setupLogActions() {
    const clearBtn = document.getElementById('clearLogs');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            await chrome.runtime.sendMessage({ action: 'clearLogs' });
            renderFullLogs();
            renderLogsPreview();
        });
    }
}

// --- Rule Import/Export ---
function setupRuleActions() {
    const importBtn = document.getElementById('importPresetBtn');
    if (importBtn) {
        importBtn.addEventListener('click', async () => {
            if (confirm('导入预设规则将完全覆盖当前规则，确定要继续吗？')) {
                const response = await chrome.runtime.sendMessage({ action: 'importPresetRules' });
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
            const response = await chrome.runtime.sendMessage({ action: 'exportRules' });
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

async function renderLogsPreview() {
    const container = document.getElementById('activityPreview');
    if (!container) return;
    
    const response = await chrome.runtime.sendMessage({ action: 'getLogs' });
    const logs = response.logs || [];
    
    container.innerHTML = '';
    if (logs.length === 0) {
        container.innerHTML = '<div style="color:#999; padding:20px;">暂无运行记录</div>';
        return;
    }

    logs.slice(0, 5).forEach(log => {
        const item = document.createElement('div');
        item.className = 'log-item';
        item.innerHTML = `
            <span class="time">${log.time}</span>
            <span class="action ${log.action}">${log.action}</span>
            <span class="target">${log.target}</span>
            <span class="reason">${log.details}</span>
        `;
        container.appendChild(item);
    });
}

async function renderFullLogs() {
    const list = document.getElementById('fullLogList');
    if (!list) return;

    const response = await chrome.runtime.sendMessage({ action: 'getLogs' });
    const logs = response.logs || [];

    list.innerHTML = '';
    if (logs.length === 0) {
        list.innerHTML = '<div style="text-align:center; padding:100px; color:#565674;">日志库为空</div>';
        return;
    }

    logs.forEach(log => {
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `
            <div class="log-time">${log.time}</div>
            <div class="log-action ${log.action}">${log.action}</div>
            <div class="log-target">${log.target}</div>
            <div class="log-details">${log.details}</div>
        `;
        list.appendChild(entry);
    });
}

function openRuleEditor(extId) {
    currentEditId = extId;
    const ext = extensions.find(e => e.id === extId);
    tempRules = rules[extId] ? [...rules[extId]] : [];
    
    document.getElementById('modalTitle').textContent = `Config: ${ext.name}`;
    renderModalRules();
    
    modal.classList.remove('hidden');
}

function renderModalRules() {
    const list = document.getElementById('modalRuleList');
    list.innerHTML = '';
    
    if (tempRules.length === 0) {
        list.innerHTML = '<div style="color:#999; text-align:center; padding:20px;">No rules configured. Extension runs manually.</div>';
        return;
    }

    tempRules.forEach((rule, index) => {
        const isRegex = isRegexRule(rule);
        const item = document.createElement('div');
        item.className = 'rule-item';
        
        item.innerHTML = `
            <div>
                <span class="tag ${isRegex ? 'regex' : 'domain'}">${isRegex ? 'REGEX' : 'DOMAIN'}</span>
                <code>${isRegex ? rule : rule}</code>
            </div>
            <button class="btn-sm" style="border:none; color:#f64e60" data-idx="${index}">×</button>
        `;
        
        item.querySelector('button').addEventListener('click', () => {
            tempRules.splice(index, 1);
            renderModalRules();
        });
        
        list.appendChild(item);
    });
}

function closeModal() {
    modal.classList.add('hidden');
    currentEditId = null;
    tempRules = [];
}
