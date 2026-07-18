const state={tree:[],bookmarks:[],folders:[],folderCounts:new Map(),descendants:new Map(),duplicateIds:new Set(),searchText:new Map(),domain:new Map(),favicon:new Map(),collapsedFolders:new Set(),folderId:null,view:'all',query:'',sort:'newest',layout:'grid',selected:new Set(),broken:new Set(),scanning:false,reloadTimer:null,renderTimer:null,reloadInFlight:null,reloadQueued:false,renderLimit:160};
const $=id=>document.getElementById(id);
const dateFormatter=new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric'});

document.addEventListener('DOMContentLoaded',()=>{void startApp()});

async function startApp(){
  try{
  bindEvents();
  const saved=await chrome.storage.local.get(['theme','layout','brokenBookmarks','sidebarCollapsed','collapsedFolders']);
  if(saved.theme==='dark')document.body.classList.add('dark');
  state.layout=saved.layout||'grid';
  if(saved.sidebarCollapsed){document.body.classList.add('sidebar-collapsed');$('collapseSidebar').textContent='›';$('collapseSidebar').title='展开侧栏';$('collapseSidebar').setAttribute('aria-label','展开侧栏')}
  state.collapsedFolders=new Set(saved.collapsedFolders||[]);
  state.broken=new Set((saved.brokenBookmarks||[]).map(x=>x.id));
  document.querySelectorAll('[data-layout]').forEach(b=>b.classList.toggle('active',b.dataset.layout===state.layout));
  await reload();
  }catch(error){reportStartupError(error)}
}
window.addEventListener('unhandledrejection',event=>{reportStartupError(event.reason);console.error(event.reason)});
window.addEventListener('error',event=>{reportStartupError(event.error||event.message);console.error(event.error||event.message)});
function reportStartupError(error){const box=$('startupError'),message=$('startupErrorText');if(!box||!message)return;message.textContent=`${error?.message||String(error)}。请在 chrome://extensions 中刷新扩展后重试。`;box.classList.remove('hidden')}
$('retryStart')?.addEventListener('click',()=>location.reload());

function bindEvents(){
  $('searchInput').addEventListener('input',e=>{state.query=e.target.value.trim().toLowerCase();state.renderLimit=160;scheduleRender()});
  $('sortSelect').addEventListener('change',e=>{state.sort=e.target.value;state.renderLimit=160;render()});
  $('refreshBtn').addEventListener('click',()=>void reload().catch(reportStartupError));
  $('addBookmark').addEventListener('click',()=>openBookmarkDialog());
  $('emptyAdd').addEventListener('click',()=>openBookmarkDialog());
  $('addFolder').addEventListener('click',openFolderDialog);
  $('editForm').addEventListener('submit',e=>void saveBookmark(e).catch(reportStartupError));
  $('folderForm').addEventListener('submit',e=>void saveFolder(e).catch(reportStartupError));
  $('moveForm').addEventListener('submit',e=>void moveSelection(e).catch(reportStartupError));
  $('moveSelected').addEventListener('click',()=>$('moveDialog').showModal());
  $('deleteSelected').addEventListener('click',deleteSelection);
  $('clearSelected').addEventListener('click',()=>{state.selected.clear();render()});
  $('bookmarkList').addEventListener('change',e=>{if(!e.target.matches('.select-box'))return;const id=e.target.closest('.bookmark-card')?.dataset.id;if(!id)return;e.target.checked?state.selected.add(id):state.selected.delete(id);render()});
  $('bookmarkList').addEventListener('click',e=>{const button=e.target.closest('[data-action]');if(!button)return;if(button.dataset.action==='load-more'){state.renderLimit+=160;render();return}const item=state.bookmarks.find(b=>b.id===button.closest('.bookmark-card')?.dataset.id);if(!item)return;const action=button.dataset.action;if(action==='open')chrome.tabs.create({url:item.url});if(action==='edit')openBookmarkDialog(item);if(action==='delete')void deleteOne(item).catch(reportStartupError)});
  $('themeToggle').addEventListener('click',async()=>{document.body.classList.toggle('dark');await chrome.storage.local.set({theme:document.body.classList.contains('dark')?'dark':'light'})});
  $('collapseSidebar').addEventListener('click',()=>void toggleSidebar().catch(reportStartupError));
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>selectView(b.dataset.view)));
  document.querySelectorAll('[data-layout]').forEach(b=>b.addEventListener('click',async()=>{state.layout=b.dataset.layout;await chrome.storage.local.set({layout:state.layout});document.querySelectorAll('[data-layout]').forEach(x=>x.classList.toggle('active',x===b));render()}));
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('searchInput').focus()}if((e.metaKey||e.ctrlKey)&&e.key==='\\'){e.preventDefault();void toggleSidebar().catch(reportStartupError)}if(e.key==='Escape'&&document.activeElement===$('searchInput')){$('searchInput').value='';state.query='';render()}});
  const refreshAfterBookmarkChange=()=>{clearTimeout(state.reloadTimer);state.reloadTimer=setTimeout(()=>void reload().catch(reportStartupError),120)};
  chrome.bookmarks.onCreated.addListener(refreshAfterBookmarkChange);chrome.bookmarks.onRemoved.addListener(refreshAfterBookmarkChange);chrome.bookmarks.onChanged.addListener(refreshAfterBookmarkChange);chrome.bookmarks.onMoved.addListener(refreshAfterBookmarkChange);
  chrome.runtime.onMessage.addListener(msg=>{if(msg.type==='scan_started'){state.scanning=true;$('scanBar').classList.remove('hidden')}if(msg.type==='scan_progress')updateScan(msg.data);if(msg.type==='scan_complete'){state.scanning=false;$('scanBar').classList.add('hidden');void loadBroken().catch(reportStartupError)}});
}
async function toggleSidebar(){const collapsed=document.body.classList.toggle('sidebar-collapsed');const button=$('collapseSidebar');button.textContent=collapsed?'›':'‹';button.title=collapsed?'展开侧栏':'折叠侧栏';button.setAttribute('aria-label',button.title);await chrome.storage.local.set({sidebarCollapsed:collapsed})}

async function reload(){
  if(state.reloadInFlight){state.reloadQueued=true;return state.reloadInFlight}
  state.reloadInFlight=(async()=>{
    state.tree=await chrome.bookmarks.getTree();state.bookmarks=[];state.folders=[];state.folderCounts.clear();state.descendants.clear();state.searchText.clear();state.domain.clear();state.favicon.clear();
    walk(state.tree[0],[]);state.tree=[];buildIndexes();for(const id of state.broken)if(!state.searchText.has(id))state.broken.delete(id);for(const id of state.selected)if(!state.searchText.has(id))state.selected.delete(id);populateFolderSelects();renderFolderTree();updateMetrics();render();
  })();
  try{return await state.reloadInFlight}finally{state.reloadInFlight=null;if(state.reloadQueued){state.reloadQueued=false;void reload().catch(reportStartupError)}}
}
function walk(node,path){
  const next=node.id==='0'?path:[...path,node.title||'书签'];
  if(node.url){const pathText=path.filter(Boolean).join('  /  ');const bookmark={...node,path:pathText};state.bookmarks.push(bookmark);state.searchText.set(node.id,`${node.title||''} ${node.url} ${pathText}`.toLowerCase());state.domain.set(node.id,domain(node.url))}
  else if(node.id!=='0'){const folder={...node,path:next.filter(Boolean)};state.folders.push(folder)}
  (node.children||[]).forEach(child=>walk(child,next));
}
function buildIndexes(){
  const children=new Map();state.folders.forEach(f=>{if(!children.has(f.parentId))children.set(f.parentId,[]);children.get(f.parentId).push(f.id)});
  state.bookmarks.forEach(b=>state.folderCounts.set(b.parentId,(state.folderCounts.get(b.parentId)||0)+1));
  const collect=id=>{if(state.descendants.has(id))return state.descendants.get(id);const ids=new Set([id]);for(const child of children.get(id)||[])for(const nested of collect(child))ids.add(nested);state.descendants.set(id,ids);return ids};
  state.folders.forEach(f=>collect(f.id));state.duplicateIds.clear();const seen=new Map();state.bookmarks.forEach(b=>{const key=normalizedUrl(b.url);if(seen.has(key)){state.duplicateIds.add(seen.get(key));state.duplicateIds.add(b.id)}else seen.set(key,b.id)});
}
function normalizedUrl(url){try{const u=new URL(url);['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid'].forEach(k=>u.searchParams.delete(k));u.hash='';u.hostname=u.hostname.replace(/^www\./,'');u.pathname=u.pathname.replace(/\/$/,'')||'/';return u.toString().toLowerCase()}catch{return url.toLowerCase()}}
function visibleBookmarks(){
  let items=[...state.bookmarks];
  if(state.folderId){const ids=state.descendants.get(state.folderId)||new Set([state.folderId]);items=items.filter(b=>ids.has(b.parentId))}
  if(state.view==='recent'){const cutoff=Date.now()-30*864e5;items=items.filter(b=>(b.dateAdded||0)>=cutoff)}
  if(state.view==='duplicates')items=items.filter(b=>state.duplicateIds.has(b.id))
  if(state.view==='broken')items=items.filter(b=>state.broken.has(b.id));
  if(state.query)items=items.filter(b=>(state.searchText.get(b.id)||'').includes(state.query));
  items.sort((a,b)=>state.sort==='oldest'?(a.dateAdded||0)-(b.dateAdded||0):state.sort==='title'?a.title.localeCompare(b.title,'zh-CN'):state.sort==='domain'?(state.domain.get(a.id)||'').localeCompare(state.domain.get(b.id)||''):(b.dateAdded||0)-(a.dateAdded||0));
  return items;
}
function render(){
  const items=visibleBookmarks(),list=$('bookmarkList');list.className=`bookmark-grid ${state.layout==='list'?'list':''}`;list.replaceChildren();
  const fragment=document.createDocumentFragment();items.slice(0,state.renderLimit).forEach(item=>fragment.appendChild(bookmarkCard(item)));list.appendChild(fragment);
  if(items.length>state.renderLimit){const more=document.createElement('button');more.className='load-more';more.dataset.action='load-more';more.textContent=`继续加载（还有 ${items.length-state.renderLimit} 项）`;list.appendChild(more)}
  $('emptyState').classList.toggle('hidden',items.length>0);$('bulkBar').classList.toggle('hidden',state.selected.size===0);$('selectedCount').textContent=state.selected.size;
}
function scheduleRender(){clearTimeout(state.renderTimer);state.renderTimer=setTimeout(render,80)}
function bookmarkCard(item){
  const card=document.createElement('article');card.className=`bookmark-card ${state.selected.has(item.id)?'selected':''}`;card.dataset.id=item.id;
  const top=document.createElement('div');top.className='card-top';
  const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.className='select-box';checkbox.checked=state.selected.has(item.id);checkbox.title='选择';
  const img=document.createElement('img');img.className='favicon';img.alt='';img.loading='lazy';img.decoding='async';img.src=getFaviconUrl(item);
  const copy=document.createElement('div');copy.className='card-copy';const link=document.createElement('a');link.href=item.url;link.target='_blank';link.rel='noreferrer';link.textContent=item.title||state.domain.get(item.id)||item.url;link.title=item.title;const host=document.createElement('span');host.className='domain';host.textContent=state.domain.get(item.id)||item.url;copy.append(link,host);top.append(checkbox,img,copy);
  const path=document.createElement('div');path.className='card-path';path.textContent=`⌑ ${item.path||'书签'}`;
  const bottom=document.createElement('div');bottom.className='card-bottom';const date=document.createElement('span');date.className='date';date.textContent=formatDate(item.dateAdded);
  const actions=document.createElement('div');actions.className='card-actions';actions.append(actionButton('↗','打开','open'),actionButton('✎','编辑','edit'),actionButton('⌫','删除','delete'));
  bottom.append(date,actions);card.append(top,path,bottom);return card;
}
function actionButton(text,title,action){const b=document.createElement('button');b.textContent=text;b.title=title;b.dataset.action=action;return b}
function getFaviconUrl(item){let cached=state.favicon.get(item.id);if(cached)return cached;const iconUrl=new URL(chrome.runtime.getURL('/_favicon/'));iconUrl.searchParams.set('pageUrl',item.url);iconUrl.searchParams.set('size','32');cached=iconUrl.href;state.favicon.set(item.id,cached);return cached}
function renderFolderTree(){
  const root=$('folderTree');root.replaceChildren();const fragment=document.createDocumentFragment();const children=new Map();state.folders.forEach(folder=>{if(!children.has(folder.parentId))children.set(folder.parentId,[]);children.get(folder.parentId).push(folder)});
  const renderFolder=(folder,depth)=>{const row=document.createElement('div');row.className='folder-row';const hasChildren=children.has(folder.id);const toggle=document.createElement('button');toggle.className='folder-toggle';if(hasChildren)toggle.dataset.folderToggle=folder.id;toggle.textContent=hasChildren?(state.collapsedFolders.has(folder.id)?'›':'⌄'):'';toggle.setAttribute('aria-label',hasChildren?(state.collapsedFolders.has(folder.id)?'展开文件夹':'收起文件夹'):'');const button=document.createElement('button');button.className=`folder-node ${state.folderId===folder.id?'active':''}`;button.style.paddingLeft=`${4+depth*13}px`;button.dataset.folderId=folder.id;button.title=folder.path.join(' / ');const name=document.createElement('span');name.textContent=folder.title||'无标题文件夹';const count=document.createElement('small');count.textContent=state.folderCounts.get(folder.id)||0;button.append(name,count);row.append(toggle,button);fragment.appendChild(row);if(hasChildren&&!state.collapsedFolders.has(folder.id))for(const child of children.get(folder.id))renderFolder(child,depth+1)};
  const folderIds=new Set(state.folders.map(folder=>folder.id));for(const folder of state.folders)if(!folderIds.has(folder.parentId))renderFolder(folder,0);
  root.appendChild(fragment);
  root.onclick=e=>{const toggle=e.target.closest('[data-folder-toggle]');if(toggle){const id=toggle.dataset.folderToggle;state.collapsedFolders.has(id)?state.collapsedFolders.delete(id):state.collapsedFolders.add(id);void chrome.storage.local.set({collapsedFolders:[...state.collapsedFolders]}).catch(reportStartupError);renderFolderTree();return}const button=e.target.closest('.folder-node');if(!button)return;state.folderId=button.dataset.folderId;state.view='folder';state.renderLimit=160;state.selected.clear();updateHeading();renderFolderTree();render()};
}
function selectView(view){state.view=view;state.folderId=null;state.renderLimit=160;state.selected.clear();document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));updateHeading();renderFolderTree();if(view==='broken'&&!state.scanning)void startScan().catch(reportStartupError);render()}
function updateHeading(){const names={all:['全部书签','集中查找、整理和维护你的收藏'],recent:['最近添加','过去 30 天新加入的书签'],duplicates:['重复书签','相同网址只保留真正需要的一份'],broken:['失效链接','检查后无法访问的网址']};if(state.folderId){const f=state.folders.find(x=>x.id===state.folderId);$('pageTitle').textContent=f?.title||'文件夹';$('pageDescription').textContent='包括此文件夹下所有子文件夹';$('breadcrumb').textContent=f?.path.join('  /  ')||'书签库'}else{const v=names[state.view]||names.all;$('pageTitle').textContent=v[0];$('pageDescription').textContent=v[1];$('breadcrumb').textContent='书签库'}}
function updateMetrics(){const dups=state.duplicateIds.size,week=state.bookmarks.filter(b=>(b.dateAdded||0)>Date.now()-7*864e5).length;$('allCount').textContent=state.bookmarks.length;$('totalMetric').textContent=state.bookmarks.length;$('weekMetric').textContent=week;$('duplicateCount').textContent=dups;$('duplicateMetric').textContent=dups;$('brokenCount').textContent=state.broken.size}
function populateFolderSelects(){const selects=[$('editFolder'),$('folderParent'),$('moveFolder')];selects.forEach(s=>{s.replaceChildren();state.folders.forEach(f=>{const o=document.createElement('option');o.value=f.id;o.textContent=`${'— '.repeat(Math.max(0,f.path.length-1))}${f.title||'无标题文件夹'}`;s.appendChild(o)})})}
function openBookmarkDialog(item=null){$('editId').value=item?.id||'';$('editTitle').value=item?.title||'';$('editUrl').value=item?.url||'';$('editFolder').value=item?.parentId||state.folderId||state.folders[0]?.id||'';$('dialogEyebrow').textContent=item?'编辑':'新建';$('dialogTitle').textContent=item?'编辑书签':'新建书签';$('editDialog').showModal();setTimeout(()=>$('editTitle').focus(),0)}
async function saveBookmark(e){e.preventDefault();const id=$('editId').value,title=$('editTitle').value.trim(),url=$('editUrl').value.trim(),parentId=$('editFolder').value;if(id){await chrome.bookmarks.update(id,{title,url});const [old]=await chrome.bookmarks.get(id);if(old.parentId!==parentId)await chrome.bookmarks.move(id,{parentId});toast('书签已更新')}else{await chrome.bookmarks.create({parentId,title,url});toast('书签已创建')}$('editDialog').close();await reload()}
function openFolderDialog(){$('folderName').value='';$('folderParent').value=state.folderId||state.folders[0]?.id||'';$('folderDialog').showModal();setTimeout(()=>$('folderName').focus(),0)}
async function saveFolder(e){e.preventDefault();await chrome.bookmarks.create({parentId:$('folderParent').value,title:$('folderName').value.trim()});$('folderDialog').close();toast('文件夹已创建');await reload()}
async function deleteOne(item){if(!confirm(`确定删除「${item.title}」吗？`))return;await chrome.bookmarks.remove(item.id);state.selected.delete(item.id);toast('书签已删除');await reload()}
async function deleteSelection(){if(!confirm(`确定删除选中的 ${state.selected.size} 个书签吗？此操作无法撤销。`))return;await Promise.all([...state.selected].map(id=>chrome.bookmarks.remove(id)));state.selected.clear();toast('已删除所选书签');await reload()}
async function moveSelection(e){e.preventDefault();const parentId=$('moveFolder').value;await Promise.all([...state.selected].map(id=>chrome.bookmarks.move(id,{parentId})));state.selected.clear();$('moveDialog').close();toast('书签已移动');await reload()}
async function startScan(){state.scanning=true;$('scanBar').classList.remove('hidden');await chrome.runtime.sendMessage({action:'startScan',folderId:state.folderId||'root'})}
function updateScan(data){const pct=data.total?Math.round(data.processed/data.total*100):100;$('scanText').textContent=`${data.processed} / ${data.total}`;$('scanProgress').value=pct}
async function loadBroken(){const r=await chrome.runtime.sendMessage({action:'getBrokenBookmarks'});state.broken=new Set((r.bookmarks||[]).map(x=>x.id));updateMetrics();render()}
function domain(url){try{return new URL(url).hostname.replace(/^www\./,'')}catch{return url}}
function formatDate(ms){if(!ms)return '';const days=Math.floor((Date.now()-ms)/864e5);if(days===0)return '今天';if(days===1)return '昨天';if(days<7)return `${days} 天前`;return dateFormatter.format(ms)}
let toastTimer;function toast(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').classList.remove('hidden');toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),2200)}
