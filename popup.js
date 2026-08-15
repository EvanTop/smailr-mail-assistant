const app = document.querySelector('#app');
const developerUrl = 'https://smailr.com/app/manage/developer';

const state = {
  configured: false,
  settings: {},
  accounts: [],
  cache: { mailboxes: [], totalUnread: 0, pendingUnread: 0, lastUpdated: null, lastError: '' },
  pollIntervals: [1, 2, 5, 10, 15],
  selectedMailboxId: '',
  mails: [],
  selectedMail: null,
  view: 'list',
  loading: false,
  toast: '',
  toastTimer: null,
  draftNotes: {},
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[character]);
}

function getIcon() { return document.querySelector('#icon-mail').innerHTML; }
function send(message) { return chrome.runtime.sendMessage(message); }

function relativeTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return '尚未同步';
  const diff = Math.max(0, Date.now() - value);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚同步';
  if (minutes < 60) return `${minutes} 分钟前同步`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前同步`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function fullTime(input) {
  const timestamp = Date.parse(input || '');
  return Number.isNaN(timestamp) ? String(input || '未知时间') : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

function normalizeMail(mail) {
  return {
    id: mail.id || mail.messageId || '', subject: mail.subject || '(无主题)',
    from: mail.from_name || mail.fromName || mail.from_addr || mail.fromAddress || mail.from || mail.sender || '',
    to: mail.to_addrs || mail.toAddrs || mail.to_addr || mail.toAddress || '',
    timestamp: mail.received_at || mail.receivedAt || mail.sent_at || mail.sentAt || '',
    isRead: Boolean(mail.is_read ?? mail.isRead ?? false),
    bodyText: mail.body_text || mail.bodyText || '', bodyHtml: mail.body_html || mail.bodyHtml || '',
  };
}

function mailBody(mail) {
  const data = normalizeMail(mail || {});
  if (String(data.bodyText).trim()) return String(data.bodyText).trim();
  if (!data.bodyHtml) return '该邮件没有可显示的正文。';
  const body = new DOMParser().parseFromString(data.bodyHtml, 'text/html').body;
  return String(body?.innerText || body?.textContent || '').trim() || '该邮件没有可显示的正文。';
}

function currentMailbox() { return state.cache.mailboxes.find((mailbox) => mailbox.id === state.selectedMailboxId) || state.cache.mailboxes[0] || null; }
function activeAccount() { return state.accounts.find((account) => account.id === state.settings.activeAccountId) || null; }

function pendingForMailbox(mailboxId) {
  const mailbox = state.cache.mailboxes.find((item) => item.id === mailboxId);
  if (!mailbox) return 0;
  const confirmed = Number(state.cache.acknowledgedUnread?.[mailboxId] || 0);
  return Math.max(0, Number(mailbox.unreadCount || 0) - confirmed);
}

function isLocallyUnread(raw, mailboxId = state.selectedMailboxId, confirmedIds = null) {
  const mail = normalizeMail(raw);
  if (mail.isRead) return false;
  const knownIds = confirmedIds || new Set(state.cache.acknowledgedMailIds?.[mailboxId] || []);
  return !knownIds.has(String(mail.id));
}

function seedDraftNotes() { state.draftNotes = Object.fromEntries((state.cache.mailboxes || []).map((mailbox) => [mailbox.id, mailbox.note || ''])); }
function mailboxLabel(mailbox) { const note = String(mailbox?.note || '').trim(); return note ? `${mailbox.address} · ${note}` : (mailbox?.address || mailbox?.displayName || '未命名邮箱'); }

function needsTooltip(label) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.font = '720 12px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Microsoft YaHei, sans-serif';
  return context.measureText(String(label || '')).width > 255;
}

function showToast(message) {
  state.toast = message;
  clearTimeout(state.toastTimer);
  render();
  state.toastTimer = setTimeout(() => { state.toast = ''; render(); }, 2300);
}

function applyResult(result) {
  if (!result) return;
  state.cache = result.cache || state.cache;
  state.settings = result.settings || state.settings;
  state.accounts = result.accounts || state.settings.accounts || state.accounts;
  state.configured = Boolean(result.configured ?? state.settings.apiKey);
  state.pollIntervals = result.pollIntervals || state.pollIntervals;
  if (!state.selectedMailboxId || !state.cache.mailboxes.some((mailbox) => mailbox.id === state.selectedMailboxId)) {
    state.selectedMailboxId = state.cache.mailboxes[0]?.id || '';
  }
}

function renderHeader(title, subtitle, actions = '') {
  return `<header class="header"><span class="brand">${getIcon()}</span><div class="headline"><h1>${escapeHtml(title)}</h1><span class="status">${escapeHtml(subtitle)}</span></div>${actions}</header>`;
}

function footer() {
  return `<footer class="footer"><button class="text-link" data-action="open-webmail" title="使用浏览器当前登录的 Smailr 网页账户打开">打开浏览器网页邮箱</button><span class="status">${relativeTime(state.cache.lastUpdated)}</span></footer>`;
}

function renderSetup() {
  const error = state.cache.lastError ? `<div class="error">${escapeHtml(state.cache.lastError)}</div>` : '';
  return `<section class="shell">${renderHeader('Smailr 邮件助手', '在任何网页中检查新邮件')}<div class="setup"><div class="setup-mark">${getIcon()}</div><h2>连接你的 Smailr 邮箱</h2><p>扩展使用仅限邮箱读取的 API 密钥，在浏览器本地保存。密钥不会上传到任何第三方服务。</p><ol class="steps"><li>打开 Smailr 开发者页面。</li><li>创建名为“浏览器邮件助手”的 API 密钥。</li><li>只勾选 <strong>mailbox:read</strong> 和 <strong>mail:read</strong>。</li><li>复制一次性显示的密钥，并粘贴在下方。</li></ol><input id="api-key-input" class="api-input" type="password" autocomplete="off" placeholder="粘贴 nm_ 开头的 API 密钥"><button class="primary" data-action="save-key">保存并开始同步</button>${error}<p class="setup-note">密钥只在创建时显示一次。你可随时在 Smailr 开发者页面禁用或删除该密钥。</p></div><footer class="footer"><button class="text-link" data-action="open-smailr" data-url="${developerUrl}">打开开发者页面</button><span class="status">需要 API 密钥</span></footer></section>`;
}

function renderMailRows() {
  if (state.loading) return '<div class="spinner">正在读取邮件…</div>';
  if (!state.mails.length) {
    const detail = state.settings.pollingEnabled === false ? '自动检查已关闭，请点击右上角刷新读取邮件' : '新邮件会自动显示在这里';
    return `<div class="empty"><div><strong>收件箱没有邮件</strong>${detail}</div></div>`;
  }
  const confirmedIds = new Set(state.cache.acknowledgedMailIds?.[state.selectedMailboxId] || []);
  return `<ul class="mail-list">${state.mails.map((raw) => {
    const mail = normalizeMail(raw);
    const localUnread = isLocallyUnread(raw, state.selectedMailboxId, confirmedIds);
    const fullSubject = escapeHtml(mail.subject);
    return `<li class="mail-item"><button class="mail-row ${localUnread ? 'unread' : ''}" data-action="open-mail" data-mail-id="${escapeHtml(mail.id)}"><span class="mail-top">${localUnread ? '<i class="dot"></i>' : ''}<span class="sender">${escapeHtml(mail.from || '未知发件人')}</span><time class="time">${escapeHtml(relativeMailTime(mail.timestamp))}</time></span><span class="subject" title="${fullSubject}">${fullSubject}</span></button><button class="mail-delete" data-action="hide-mail" data-mail-id="${escapeHtml(mail.id)}" title="仅从插件列表删除，不影响原邮箱" aria-label="仅从插件列表删除此邮件"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7l1-2h4l1 2m-9 0 1 13h10l1-13"/></svg></button></li>`;
  }).join('')}</ul>`;
}

function relativeMailTime(input) {
  const timestamp = Date.parse(input || '');
  if (Number.isNaN(timestamp)) return '';
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(timestamp));
}

function renderList() {
  const mailbox = currentMailbox();
  const totalUnread = Number(state.cache.totalUnread || 0);
  const pendingUnread = Number(state.cache.pendingUnread || 0);
  const subtitle = pendingUnread > 0 ? `${pendingUnread} 封未读` : (totalUnread > 0 ? '提醒已清除' : '所有邮箱已读');
  const selectedLabel = mailboxLabel(mailbox);
  const selectTitle = needsTooltip(selectedLabel) ? ` title="${escapeHtml(selectedLabel)}"` : '';
  const options = state.cache.mailboxes.map((item) => {
    const label = mailboxLabel(item);
    const optionTitle = needsTooltip(label) ? ` title="${escapeHtml(label)}"` : '';
    const mailboxPending = pendingForMailbox(item.id);
    return `<option value="${escapeHtml(item.id)}"${optionTitle} ${item.id === mailbox?.id ? 'selected' : ''}>${escapeHtml(label)}${mailboxPending ? ` · ${mailboxPending} 未读` : ''}</option>`;
  }).join('');
  const headerActions = `<button class="icon-button" data-action="refresh" title="立即同步" aria-label="立即同步">↻</button><button class="icon-button" data-action="settings" title="设置" aria-label="设置">⚙</button>`;
  const badge = pendingUnread ? `<button class="badge badge-button" data-action="clear-alerts" title="清除本机新邮件提醒；不会改变服务器未读状态">${pendingUnread > 99 ? '99+' : pendingUnread}</button>` : '';
  return `<section class="shell">${renderHeader('Smailr 邮件助手', subtitle, headerActions)}<div class="content"><div class="mailbox-toolbar"><select class="mailbox-select" data-action="select-mailbox" aria-label="选择邮箱"${selectTitle}>${options}</select>${badge}</div>${renderMailRows()}</div>${footer()}</section>`;
}

function renderDetail() {
  const mail = normalizeMail(state.selectedMail || {});
  const title = state.loading ? '正在加载邮件' : '邮件详情';
  const content = state.loading ? '<div class="spinner">正在读取邮件正文…</div>' : `<article class="detail"><div class="detail-meta"><h2 class="detail-subject">${escapeHtml(mail.subject)}</h2><div class="meta-line"><span>发件人</span><strong>${escapeHtml(mail.from || '未知发件人')}</strong></div><div class="meta-line"><span>收件人</span><strong>${escapeHtml(Array.isArray(mail.to) ? mail.to.join(', ') : mail.to || '—')}</strong></div><div class="meta-line"><span>时间</span><strong>${escapeHtml(fullTime(mail.timestamp))}</strong></div></div><div class="body">${escapeHtml(mailBody(state.selectedMail))}</div></article>`;
  const actions = '<button class="icon-button" data-action="back" title="返回邮件列表" aria-label="返回邮件列表">←</button>';
  return `<section class="shell">${renderHeader(title, '正文内容只在本机显示', actions)}<div class="content">${content}</div><footer class="footer"><button class="copy-button" data-action="copy-mail" ${state.loading ? 'disabled' : ''}>复制正文</button><button class="text-link" data-action="back">返回列表</button></footer></section>`;
}

function switchMarkup(on, action, disabled = false) { return `<button class="switch ${on ? 'on' : ''}" data-action="${action}" aria-pressed="${on}" ${disabled ? 'disabled' : ''}></button>`; }
function pollLabel(minutes) { return `${minutes} 分钟${Number(minutes) === 1 ? '（默认）' : ''}`; }

function renderNotes() {
  const boxes = state.cache.mailboxes || [];
  if (!boxes.length) return '';
  return `<section class="notes-section"><h3 class="section-title">邮件地址备注</h3><p class="section-help">备注仅保存在本机，显示在前面的邮箱下拉菜单中。</p><div class="note-stack">${boxes.map((mailbox) => `<label class="note-card"><span class="note-address" title="${escapeHtml(mailbox.address)}">${escapeHtml(mailbox.address)}</span><span class="note-divider"></span><input class="note-input" data-mailbox-id="${escapeHtml(mailbox.id)}" maxlength="64" value="${escapeHtml(state.draftNotes[mailbox.id] ?? mailbox.note ?? '')}" placeholder="添加备注"></label>`).join('')}</div><div class="notes-savebar"><button class="notes-save" data-action="save-notes">保存</button></div></section>`;
}

function renderAccountSection() {
  const rows = state.accounts.map((account) => {
    const status = account.active ? '当前账户' : (account.pollingEnabled ? `每 ${account.pollIntervalMinutes} 分钟检查` : '仅手动刷新');
    return `<div class="account-row ${account.active ? 'active' : ''}"><button class="account-main" data-action="switch-account" data-account-id="${escapeHtml(account.id)}" ${account.active ? 'disabled' : ''}><strong title="${escapeHtml(account.name)}">${escapeHtml(account.name)}</strong><span class="account-status">${escapeHtml(status)}</span></button><button class="account-edit" data-action="rename-account" data-account-id="${escapeHtml(account.id)}" title="修改账户名称" aria-label="修改账户名称"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16.7V20h3.3L18.6 8.7l-3.3-3.3L4 16.7Zm13.5-10.1 1.1-1.1a1.55 1.55 0 0 1 2.2 0l.7.7a1.55 1.55 0 0 1 0 2.2l-1.1 1.1-2.9-2.9Z"/></svg></button><button class="account-remove" data-action="remove-account" data-account-id="${escapeHtml(account.id)}" title="从本机移除此账户" aria-label="从本机移除此账户">×</button></div>`;
  }).join('');
  return `<section class="account-section"><h3 class="section-title">账户管理</h3><p class="section-help">各账户的邮件、备注、提醒和本地删除记录均独立保存。</p><div class="account-stack">${rows}</div><button class="account-add" data-action="show-add-account">＋ 添加账户</button></section>`;
}

function renderSettings() {
  const settings = state.settings;
  const soundDisabled = !settings.notificationsEnabled || !settings.soundEnabled;
  const actions = '<button class="icon-button" data-action="back" title="返回邮件列表" aria-label="返回邮件列表">←</button>';
  const intervals = state.pollIntervals.map((minutes) => `<option value="${minutes}" ${Number(settings.pollIntervalMinutes) === Number(minutes) ? 'selected' : ''}>${pollLabel(minutes)}</option>`).join('');
  const pollHelp = settings.pollingEnabled ? '按所选间隔在后台检查新邮件' : '已关闭；只能点击右上角刷新更新邮件';
  return `<section class="shell">${renderHeader('提醒设置', activeAccount()?.name || '当前账户', actions)}<div class="content"><div class="settings">${renderAccountSection()}<p class="setting-intro">存在待提示新邮件时，工具栏角标会规律闪动；已读同步、打开邮件或点击角标都会清除本机新邮件提醒。</p><div class="setting-row"><div><span class="setting-name">邮件刷新轮询</span><span class="setting-help">默认每 1 分钟检查一次</span></div><select class="setting-select" data-action="poll-interval" aria-label="邮件刷新轮询间隔" ${settings.pollingEnabled ? '' : 'disabled'}>${intervals}</select></div><div class="setting-row"><div><span class="setting-name">后台检查新邮件</span><span class="setting-help">${pollHelp}</span></div>${switchMarkup(settings.pollingEnabled, 'toggle-polling')}</div><div class="setting-row"><div><span class="setting-name">新邮件通知</span><span class="setting-help">显示系统通知、工具栏角标与规律闪动</span></div>${switchMarkup(settings.notificationsEnabled, 'toggle-notifications')}</div><div class="setting-row"><div><span class="setting-name">声音提醒</span><span class="setting-help">开启时立即播放一次测试音</span></div>${switchMarkup(settings.soundEnabled, 'toggle-sound', !settings.notificationsEnabled)}</div><div class="setting-row"><div><span class="setting-name">声音测试</span><span class="setting-help">确认浏览器标签页和系统未静音</span></div><button class="choice" data-action="test-sound" ${soundDisabled ? 'disabled' : ''}>播放测试</button></div><div class="setting-row"><div><span class="setting-name">未读角标颜色</span><span class="setting-help">浏览器工具栏数字颜色</span></div><div class="choice-group"><button class="choice ${settings.badgeColor === 'red' ? 'selected' : ''}" data-action="set-color" data-color="red"><i class="swatch" style="background:#ef4444"></i>红色</button><button class="choice ${settings.badgeColor === 'green' ? 'selected' : ''}" data-action="set-color" data-color="green"><i class="swatch" style="background:#16a34a"></i>绿色</button></div></div>${renderNotes()}<p class="author">Design by <a href="https://evan.xin" target="_blank" rel="noopener noreferrer">Evan</a></p></div></div>${footer()}</section>`;
}

function renderAddAccount() {
  const actions = '<button class="icon-button" data-action="settings" title="返回设置" aria-label="返回设置">←</button>';
  return `<section class="shell">${renderHeader('添加账户', '最多可管理 8 个账户', actions)}<div class="setup account-setup"><div class="setup-mark">${getIcon()}</div><h2>添加 Smailr 账户</h2><p>新账户会独立保存邮件提醒、邮箱备注和本地删除记录。API 密钥仅保存在当前浏览器扩展中。</p><input id="account-name-input" class="api-input" type="text" maxlength="32" autocomplete="off" placeholder="账户名称（可选）"><input id="account-key-input" class="api-input account-key" type="password" autocomplete="off" placeholder="粘贴 nm_ 开头的 API 密钥"><button class="primary" data-action="add-account">保存并切换到账户</button></div>${footer()}</section>`;
}

function render() {
  const content = state.configured ? (state.view === 'settings' ? renderSettings() : (state.view === 'detail' ? renderDetail() : (state.view === 'account-add' ? renderAddAccount() : renderList()))) : renderSetup();
  app.innerHTML = `${content}${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ''}`;
}

async function refresh({ silent = false } = {}) {
  state.loading = !silent;
  render();
  const result = await send({ type: 'refresh', silent });
  applyResult(result);
  state.loading = false;
  if (!result.ok) {
    render();
    showToast(result.error || '同步失败');
    return result;
  }
  if (state.view === 'list' && state.selectedMailboxId) await loadMails({ showLoading: !silent, force: true });
  else render();
  return result;
}

async function loadMails({ showLoading = true, force = false } = {}) {
  if (!state.selectedMailboxId) { state.mails = []; render(); return; }
  if (!force && state.settings.pollingEnabled === false) { state.mails = []; render(); return; }
  if (showLoading) { state.loading = true; render(); }
  const result = await send({ type: 'get-mails', mailboxId: state.selectedMailboxId });
  state.loading = false;
  if (result.ok) state.mails = result.mails || [];
  else { state.mails = []; showToast(result.error || '邮件列表加载失败'); return; }
  render();
}

async function hideMail(mailId) {
  const index = state.mails.findIndex((item) => String(normalizeMail(item).id) === String(mailId));
  if (index < 0) return;
  const removed = state.mails[index];
  const shouldAcknowledge = isLocallyUnread(removed);
  state.mails = state.mails.filter((_item, itemIndex) => itemIndex !== index);
  render();
  try {
    const result = await send({ type: 'hide-mail', mailboxId: state.selectedMailboxId, mailId });
    if (!result.ok) throw new Error(result.error || '本地删除保存失败');
    state.cache = result.cache || state.cache;
    if (shouldAcknowledge) {
      const acknowledged = await send({ type: 'acknowledge-mail', mailboxId: state.selectedMailboxId, mailId, shouldAcknowledge: true });
      if (acknowledged.ok) state.cache = acknowledged.cache || state.cache;
    }
    showToast('已从插件列表删除，不影响原邮箱');
  } catch (error) {
    state.mails.splice(index, 0, removed);
    render();
    showToast(error.message || '本地删除失败，邮件已恢复');
  }
}

async function openMail(mailId) {
  state.view = 'detail';
  state.selectedMail = null;
  state.loading = true;
  render();
  const listMail = state.mails.find((item) => String(normalizeMail(item).id) === String(mailId));
  const shouldAcknowledge = listMail ? isLocallyUnread(listMail) : false;
  const mailResult = await send({ type: 'get-mail', mailId });
  if (mailResult.ok && shouldAcknowledge) {
    const acknowledgeResult = await send({ type: 'acknowledge-mail', mailboxId: state.selectedMailboxId, mailId, shouldAcknowledge: true });
    if (acknowledgeResult?.ok) {
      state.cache = acknowledgeResult.cache;
      state.mails = state.mails.map((item) => String(normalizeMail(item).id) === String(mailId) ? { ...item, is_read: true, isRead: true } : item);
    }
  }
  state.loading = false;
  if (mailResult.ok) state.selectedMail = mailResult.mail;
  else showToast(mailResult.error || '邮件详情加载失败');
  render();
}

async function persist(patch) {
  const result = await send({ type: 'save-settings', settings: patch });
  if (!result.ok) { showToast(result.error || '设置保存失败'); return false; }
  applyResult(result);
  render();
  return true;
}

app.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-action="select-mailbox"]');
  if (select) {
    state.selectedMailboxId = select.value;
    state.mails = [];
    await loadMails();
    return;
  }
  const pollSelect = event.target.closest('[data-action="poll-interval"]');
  if (pollSelect) {
    const saved = await persist({ pollIntervalMinutes: Number(pollSelect.value) });
    if (saved) showToast(`轮询已设为每 ${pollSelect.value} 分钟`);
  }
});

app.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;

  if (action === 'save-key') {
    const key = document.querySelector('#api-key-input')?.value.trim();
    if (!key || !key.startsWith('nm_')) { showToast('请输入 nm_ 开头的 API 密钥'); return; }
    const result = await send({ type: 'add-account', account: { name: '账户 1', apiKey: key } });
    if (!result.ok) { showToast(result.error || '账户保存失败'); return; }
    applyResult(result);
    state.view = 'list';
    await refresh({ silent: true });
    showToast('密钥已保存，开始后台同步');
    return;
  }
  if (action === 'add-account') {
    const apiKey = document.querySelector('#account-key-input')?.value.trim();
    const name = document.querySelector('#account-name-input')?.value.trim();
    const result = await send({ type: 'add-account', account: { name, apiKey } });
    if (!result.ok) { showToast(result.error || '账户添加失败'); return; }
    applyResult(result);
    state.view = 'list';
    await refresh({ silent: true });
    showToast('已添加并切换到账户');
    return;
  }
  if (action === 'show-add-account') { state.view = 'account-add'; render(); return; }
  if (action === 'switch-account') {
    const result = await send({ type: 'switch-account', accountId: target.dataset.accountId });
    if (!result.ok) { showToast(result.error || '账户切换失败'); return; }
    applyResult(result);
    state.mails = [];
    state.selectedMail = null;
    state.view = 'list';
    if (state.settings.pollingEnabled) await loadMails({ showLoading: false });
    else render();
    showToast(`已切换到 ${activeAccount()?.name || '所选账户'}`);
    return;
  }
  if (action === 'rename-account') {
    const account = state.accounts.find((item) => item.id === target.dataset.accountId);
    if (!account) { showToast('要修改的账户不存在'); return; }
    const name = window.prompt('请输入新的账户名称（最多 32 个字符）', account.name);
    if (name === null) return;
    const result = await send({ type: 'rename-account', accountId: account.id, name });
    if (!result.ok) { showToast(result.error || '账户名称保存失败'); return; }
    applyResult(result);
    render();
    showToast('账户名称已更新');
    return;
  }
  if (action === 'remove-account') {
    const account = state.accounts.find((item) => item.id === target.dataset.accountId);
    if (!window.confirm(`从本机移除“${account?.name || '该账户'}”及其本地缓存？不会影响 Smailr 原账户。`)) return;
    const result = await send({ type: 'remove-account', accountId: target.dataset.accountId });
    if (!result.ok) { showToast(result.error || '账户移除失败'); return; }
    applyResult(result);
    state.mails = [];
    state.selectedMail = null;
    state.view = state.configured ? 'list' : 'list';
    render();
    showToast('账户已从本机移除');
    return;
  }
  if (action === 'refresh') { await refresh(); return; }
  if (action === 'settings') { seedDraftNotes(); state.view = 'settings'; render(); return; }
  if (action === 'back') { state.view = 'list'; state.selectedMail = null; render(); return; }
  if (action === 'hide-mail') { event.preventDefault(); event.stopPropagation(); await hideMail(target.dataset.mailId); return; }
  if (action === 'open-mail') { await openMail(target.dataset.mailId); return; }
  if (action === 'save-notes') {
    const notes = Object.fromEntries([...document.querySelectorAll('.note-input')].map((input) => [input.dataset.mailboxId, input.value.trim()]));
    const saved = await persist({ notes });
    if (saved) { state.draftNotes = notes; showToast('邮箱备注已保存'); }
    return;
  }
  if (action === 'clear-alerts') {
    const result = await send({ type: 'clear-alerts' });
    if (result.ok) { state.cache = result.cache; render(); showToast('本机新邮件提醒已清除'); }
    else showToast(result.error || '提醒清除失败');
    return;
  }
  if (action === 'copy-mail') {
    try { await navigator.clipboard.writeText(mailBody(state.selectedMail)); showToast('邮件正文已复制'); }
    catch (_) { showToast('复制失败，请在扩展中重新尝试'); }
    return;
  }
  if (action === 'open-webmail') {
    const continueOpen = window.confirm('网页端将使用浏览器当前登录的 Smailr 账户打开，不会使用本扩展保存的 API 密钥。若当前网页登录的是其他账户，请先取消并切换或退出网页账户。是否继续？');
    if (continueOpen) await send({ type: 'open-smailr', url: 'https://smailr.com/app/' });
    return;
  }
  if (action === 'open-smailr') { await send({ type: 'open-smailr', url: target.dataset.url }); return; }
  if (action === 'toggle-polling') { await persist({ pollingEnabled: !state.settings.pollingEnabled }); return; }
  if (action === 'toggle-notifications') { await persist({ notificationsEnabled: !state.settings.notificationsEnabled }); return; }
  if (action === 'toggle-sound') {
    const next = !state.settings.soundEnabled;
    const saved = await persist({ soundEnabled: next });
    if (saved && next && state.settings.notificationsEnabled) {
      const result = await send({ type: 'test-sound' });
      showToast(result.ok ? '声音提醒已开启，已播放测试音' : (result.error || '声音无法播放'));
    }
    return;
  }
  if (action === 'test-sound') {
    const result = await send({ type: 'test-sound' });
    showToast(result.ok ? '声音测试已播放' : (result.error || '声音无法播放'));
    return;
  }
  if (action === 'set-color') { await persist({ badgeColor: target.dataset.color === 'green' ? 'green' : 'red' }); }
});

async function initialize() {
  const result = await send({ type: 'get-state' });
  applyResult(result);
  state.selectedMailboxId = state.cache.mailboxes[0]?.id || '';
  seedDraftNotes();
  render();
  if (state.configured && state.settings.pollingEnabled) await refresh({ silent: true });
}

initialize();
