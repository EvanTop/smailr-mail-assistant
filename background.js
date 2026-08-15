const API_ORIGIN = 'https://smailr.com/api/v1';
const ALARM_NAME = 'smailr-mail-poll';
const SETTINGS_KEY = 'settings';
const CACHE_KEY = 'cache';
const BLINK_INTERVAL_MS = 850;
const POLL_INTERVALS = [1, 2, 5, 10, 15];
const MAX_HIDDEN_PER_MAILBOX = 500;
const MAX_ACCOUNTS = 8;

const DEFAULT_PROFILE = {
  id: '',
  name: '',
  apiKey: '',
  notificationsEnabled: true,
  soundEnabled: true,
  badgeColor: 'red',
  pollingEnabled: true,
  pollIntervalMinutes: 1,
  aliases: {},
  notes: {},
  accountScope: '',
};

const DEFAULT_CACHE = {
  initialized: false,
  mailboxes: [],
  previousUnread: {},
  acknowledgedUnread: {},
  acknowledgedMailIds: {},
  hiddenMailIds: {},
  accountScope: '',
  totalUnread: 0,
  pendingUnread: 0,
  lastUpdated: null,
  lastError: '',
};

let offscreenCreating;
let blinkTimer;
let blinkVisible = true;
let blinkCache = null;
let blinkSettings = null;
let blinkUpdating = false;
const refreshInFlight = new Map();

function accountId() {
  return crypto.randomUUID();
}

function normalizeProfile(value = {}, index = 0) {
  const scope = String(value.accountScope || accountId());
  return {
    ...DEFAULT_PROFILE,
    ...value,
    id: String(value.id || scope),
    name: String(value.name || `账户 ${index + 1}`).trim().slice(0, 32) || `账户 ${index + 1}`,
    apiKey: String(value.apiKey || ''),
    accountScope: scope,
    pollIntervalMinutes: POLL_INTERVALS.includes(Number(value.pollIntervalMinutes)) ? Number(value.pollIntervalMinutes) : 1,
    aliases: { ...(value.aliases || {}) },
    notes: { ...(value.notes || {}) },
  };
}

function settingsStore(activeAccountId, accounts) {
  return { activeAccountId: activeAccountId || '', accounts };
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] || {};
  let accounts = Array.isArray(raw.accounts) ? raw.accounts.filter((account) => account && account.apiKey) : [];
  let migrated = false;

  // 兼容单账户旧版本；迁移后不再在顶层保留 API Key。
  if (!accounts.length && raw.apiKey) {
    const scope = String(raw.accountScope || accountId());
    accounts = [{
      id: scope,
      name: '账户 1',
      apiKey: raw.apiKey,
      accountScope: scope,
      notificationsEnabled: raw.notificationsEnabled,
      soundEnabled: raw.soundEnabled,
      badgeColor: raw.badgeColor,
      pollingEnabled: raw.pollingEnabled,
      pollIntervalMinutes: raw.pollIntervalMinutes,
      aliases: raw.aliases,
      notes: raw.notes,
    }];
    migrated = true;
  }

  const needsProfileMigration = accounts.some((account) => !account.id || !account.accountScope);
  accounts = accounts.slice(0, MAX_ACCOUNTS).map(normalizeProfile);
  const activeAccountId = accounts.some((account) => account.id === raw.activeAccountId)
    ? raw.activeAccountId
    : (accounts[0]?.id || '');
  const active = accounts.find((account) => account.id === activeAccountId) || null;
  const normalizedStore = settingsStore(activeAccountId, accounts);
  if (migrated || needsProfileMigration || !Array.isArray(raw.accounts) || raw.activeAccountId !== activeAccountId) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: normalizedStore });
  }

  return {
    ...DEFAULT_PROFILE,
    ...(active || {}),
    activeAccountId,
    accounts,
  };
}

function publicAccount(account, activeAccountId) {
  return {
    id: account.id,
    name: account.name,
    active: account.id === activeAccountId,
    pollingEnabled: account.pollingEnabled,
    pollIntervalMinutes: account.pollIntervalMinutes,
  };
}

function publicSettings(settings) {
  return {
    ...settings,
    apiKey: settings.apiKey ? '••••••••' : '',
    accounts: settings.accounts.map((account) => publicAccount(account, settings.activeAccountId)),
  };
}

function copyCache(cache, scope) {
  return {
    ...DEFAULT_CACHE,
    ...(cache || {}),
    accountScope: scope,
    mailboxes: [...(cache?.mailboxes || [])],
    previousUnread: { ...(cache?.previousUnread || {}) },
    acknowledgedUnread: { ...(cache?.acknowledgedUnread || {}) },
    acknowledgedMailIds: { ...(cache?.acknowledgedMailIds || {}) },
    hiddenMailIds: { ...(cache?.hiddenMailIds || {}) },
  };
}

async function getCacheStore() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const raw = stored[CACHE_KEY] || {};
  if (raw.byScope && typeof raw.byScope === 'object') return { byScope: { ...raw.byScope } };

  // 兼容旧版单缓存结构；其作用域仅作为一次性迁移来源。
  const legacyScope = String(raw.accountScope || '');
  const byScope = Object.keys(raw).length ? { [legacyScope]: raw } : {};
  return { byScope };
}

async function getAccountCache(settings) {
  const store = await getCacheStore();
  const scope = settings.apiKey ? settings.accountScope : '';
  return copyCache(store.byScope[scope], scope);
}

async function setCache(cache) {
  const store = await getCacheStore();
  const scope = String(cache.accountScope || '');
  store.byScope[scope] = copyCache(cache, scope);
  await chrome.storage.local.set({ [CACHE_KEY]: store });
}

async function deleteAccountCache(scope) {
  const store = await getCacheStore();
  delete store.byScope[String(scope || '')];
  await chrome.storage.local.set({ [CACHE_KEY]: store });
}

function unreadOf(mailbox) {
  return Math.max(0, Number(mailbox.unread_count ?? mailbox.unreadCount ?? 0) || 0);
}

function visibleMailbox(mailbox, aliases = {}, notes = {}) {
  const note = String(notes[mailbox.id] || '').trim();
  return {
    id: mailbox.id,
    address: mailbox.address || '',
    displayName: String(aliases[mailbox.id] || mailbox.display_name || mailbox.address || '未命名邮箱').trim(),
    note,
    unreadCount: unreadOf(mailbox),
    sortOrder: Number(mailbox.sort_order ?? mailbox.sortOrder ?? 0),
  };
}

function badgeColor(settings, isVisible) {
  if (!isVisible) return '#ffffff';
  return settings.badgeColor === 'green' ? '#16a34a' : '#ef4444';
}

async function updateBadge(cache, settings, isVisible = true) {
  const pending = Math.max(0, Number(cache.pendingUnread || 0));
  const text = pending > 0 ? (pending > 99 ? '99+' : String(pending)) : '';
  const color = badgeColor(settings, isVisible);
  const title = pending > 0
    ? `Smailr 邮件助手：${pending} 条待提示新邮件（共 ${cache.totalUnread || 0} 封未读）`
    : (cache.totalUnread > 0 ? `Smailr 邮件助手：${cache.totalUnread} 封未读，提醒已清除` : 'Smailr 邮件助手');
  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setBadgeTextColor({ color: isVisible ? '#ffffff' : '#6b5d78' }),
    chrome.action.setTitle({ title }),
  ]);
}

function stopBlink() {
  if (blinkTimer) clearInterval(blinkTimer);
  blinkTimer = null;
  blinkVisible = true;
  blinkCache = null;
  blinkSettings = null;
  blinkUpdating = false;
}

function startBlink(cache, settings) {
  stopBlink();
  if (!settings.notificationsEnabled || !cache.pendingUnread) {
    updateBadge(cache, settings, true);
    return;
  }
  blinkCache = cache;
  blinkSettings = settings;
  const tick = () => {
    if (!blinkCache?.pendingUnread || !blinkSettings?.notificationsEnabled || blinkUpdating) return;
    blinkUpdating = true;
    blinkVisible = !blinkVisible;
    updateBadge(blinkCache, blinkSettings, blinkVisible).finally(() => { blinkUpdating = false; });
  };
  updateBadge(cache, settings, true);
  blinkTimer = setInterval(tick, BLINK_INTERVAL_MS);
}

async function applyAlertVisual(cache, settings, { restartBlink = false } = {}) {
  if (cache.pendingUnread > 0 && settings.notificationsEnabled) {
    if (restartBlink || !blinkTimer) startBlink(cache, settings);
    else {
      blinkCache = cache;
      blinkSettings = settings;
      // 单封确认或一键清除后的数字必须立即反映到工具栏，不能等待下一次闪动 tick。
      await updateBadge(cache, settings, true);
    }
  } else {
    stopBlink();
    await updateBadge(cache, settings, true);
  }
}

async function apiRequest(path, apiKey) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
  });
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403 ? 'API 密钥无效或权限不足' : `Smailr 请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function ensureOffscreenDocument() {
  const path = 'offscreen.html';
  const offscreenUrl = chrome.runtime.getURL(path);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl] });
  if (contexts.length) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: path,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play the local new-mail notification sound selected by the user.',
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

async function playSound() {
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen-play-chime' });
    return true;
  } catch (error) {
    console.warn('Unable to play Smailr notification sound', error);
    return false;
  }
}

async function showNewMailNotification(newCount) {
  await chrome.notifications.create('smailr-new-mail', {
    type: 'basic', iconUrl: 'icons/icon128.png', title: 'Smailr 有新邮件',
    message: `发现 ${newCount} 封新的未读邮件。`, priority: 1,
  });
}

function deriveAlertState(mailboxes, cache) {
  const currentUnread = Object.fromEntries(mailboxes.map((mailbox) => [mailbox.id, mailbox.unreadCount]));
  if (!cache.initialized) return { currentUnread, acknowledgedUnread: { ...currentUnread }, newlyUnread: 0, pendingUnread: 0 };
  let newlyUnread = 0;
  let pendingUnread = 0;
  const acknowledgedUnread = {};
  for (const mailbox of mailboxes) {
    const current = mailbox.unreadCount;
    const previous = Number(cache.previousUnread?.[mailbox.id] ?? current);
    const acknowledged = Math.min(current, Math.max(0, Number(cache.acknowledgedUnread?.[mailbox.id] ?? previous)));
    newlyUnread += Math.max(0, current - previous);
    pendingUnread += Math.max(0, current - acknowledged);
    acknowledgedUnread[mailbox.id] = acknowledged;
  }
  return { currentUnread, acknowledgedUnread, newlyUnread, pendingUnread };
}

async function refreshMailboxState(options = {}) {
  const settings = await getSettings();
  const scope = String(settings.accountScope || '');
  // alarm、设置保存和手动刷新同时到达时仅合并同一账户的请求；切换账户不会复用旧结果。
  if (refreshInFlight.has(scope)) return refreshInFlight.get(scope);
  const task = refreshMailboxStateInternal(options, settings).finally(() => { refreshInFlight.delete(scope); });
  refreshInFlight.set(scope, task);
  return task;
}

async function refreshMailboxStateInternal({ silent = false, source = 'manual' } = {}, resolvedSettings = null) {
  const settings = resolvedSettings || await getSettings();
  const cache = await getAccountCache(settings);
  const canFetch = Boolean(settings.apiKey) && (source === 'manual' || settings.pollingEnabled);

  if (!canFetch) {
    await applyAlertVisual(cache, settings);
    return { ok: true, configured: Boolean(settings.apiKey), cache, settings: publicSettings(settings), accounts: publicSettings(settings).accounts };
  }

  try {
    const payload = await apiRequest('/mailboxes', settings.apiKey);
    const rawMailboxes = (Array.isArray(payload) ? payload : (payload.mailboxes || payload.items || []))
      .filter((mailbox) => !mailbox.is_archived && !mailbox.isArchived)
      .sort((a, b) => Number(a.sort_order ?? a.sortOrder ?? 0) - Number(b.sort_order ?? b.sortOrder ?? 0));
    const mailboxes = rawMailboxes.map((mailbox) => visibleMailbox(mailbox, settings.aliases, settings.notes));
    const alertState = deriveAlertState(mailboxes, cache);
    const totalUnread = mailboxes.reduce((total, mailbox) => total + mailbox.unreadCount, 0);
    const nextCache = {
      initialized: true,
      mailboxes,
      previousUnread: alertState.currentUnread,
      acknowledgedUnread: alertState.acknowledgedUnread,
      acknowledgedMailIds: { ...(cache.acknowledgedMailIds || {}) },
      hiddenMailIds: { ...(cache.hiddenMailIds || {}) },
      accountScope: cache.accountScope,
      totalUnread,
      pendingUnread: alertState.pendingUnread,
      lastUpdated: Date.now(),
      lastError: '',
    };
    await setCache(nextCache);
    await applyAlertVisual(nextCache, settings, { restartBlink: alertState.newlyUnread > 0 });
    if (!silent && alertState.newlyUnread > 0 && settings.notificationsEnabled) {
      await showNewMailNotification(alertState.newlyUnread);
      if (settings.soundEnabled) await playSound();
    }
    const publicState = publicSettings(settings);
    return { ok: true, configured: true, cache: nextCache, settings: publicState, accounts: publicState.accounts, newlyUnread: alertState.newlyUnread };
  } catch (error) {
    const nextCache = { ...cache, lastError: error.message, lastUpdated: Date.now() };
    await setCache(nextCache);
    await applyAlertVisual(nextCache, settings);
    const publicState = publicSettings(settings);
    return { ok: false, configured: true, error: error.message, cache: nextCache, settings: publicState, accounts: publicState.accounts };
  }
}

async function unreadMailIds(mailboxId, apiKey) {
  try {
    const mails = await getMailboxMails(mailboxId, apiKey);
    return mails.filter((mail) => !Boolean(mail.is_read ?? mail.isRead ?? false)).map((mail) => String(mail.id || mail.messageId || '')).filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function acknowledgeAllAlerts() {
  const settings = await getSettings();
  const cache = await getAccountCache(settings);
  const acknowledgedUnread = Object.fromEntries((cache.mailboxes || []).map((mailbox) => [mailbox.id, mailbox.unreadCount]));
  const acknowledgedMailIds = { ...(cache.acknowledgedMailIds || {}) };
  if (settings.apiKey) {
    await Promise.all((cache.mailboxes || []).map(async (mailbox) => {
      const ids = await unreadMailIds(mailbox.id, settings.apiKey);
      if (ids.length) acknowledgedMailIds[mailbox.id] = [...new Set([...(acknowledgedMailIds[mailbox.id] || []), ...ids])];
    }));
  }
  const nextCache = { ...cache, acknowledgedUnread, acknowledgedMailIds, pendingUnread: 0, lastUpdated: Date.now() };
  await setCache(nextCache);
  await applyAlertVisual(nextCache, settings);
  return nextCache;
}

async function acknowledgeOneAlert(mailboxId, mailId, shouldAcknowledge = true) {
  const settings = await getSettings();
  const cache = await getAccountCache(settings);
  const mailbox = cache.mailboxes.find((item) => item.id === mailboxId);
  if (!mailbox || !shouldAcknowledge) return cache;
  const acknowledgedMailIds = { ...(cache.acknowledgedMailIds || {}) };
  const knownIds = new Set(acknowledgedMailIds[mailboxId] || []);
  if (mailId && knownIds.has(String(mailId))) return cache;
  if (mailId) knownIds.add(String(mailId));
  acknowledgedMailIds[mailboxId] = [...knownIds];
  const acknowledgedUnread = { ...cache.acknowledgedUnread };
  acknowledgedUnread[mailboxId] = Math.min(mailbox.unreadCount, Math.max(0, Number(acknowledgedUnread[mailboxId] || 0)) + 1);
  const pendingUnread = (cache.mailboxes || []).reduce((total, item) => total + Math.max(0, item.unreadCount - Number(acknowledgedUnread[item.id] || 0)), 0);
  const nextCache = { ...cache, acknowledgedUnread, acknowledgedMailIds, pendingUnread, lastUpdated: Date.now() };
  await setCache(nextCache);
  await applyAlertVisual(nextCache, settings);
  return nextCache;
}

async function getMailboxMails(mailboxId, providedKey = '') {
  const settings = await getSettings();
  const apiKey = providedKey || settings.apiKey;
  if (!apiKey) throw new Error('请先在设置中保存 API 密钥');
  const payload = await apiRequest(`/mailboxes/${encodeURIComponent(mailboxId)}/mails?folder=inbox&page=1&per_page=15`, apiKey);
  return Array.isArray(payload) ? payload : (payload.mails || payload.items || []);
}

async function getVisibleMailboxMails(mailboxId) {
  const settings = await getSettings();
  const [mails, cache] = await Promise.all([getMailboxMails(mailboxId), getAccountCache(settings)]);
  const hidden = new Set(cache.hiddenMailIds?.[mailboxId] || []);
  return mails.filter((mail) => !hidden.has(String(mail.id || mail.messageId || '')));
}

async function hideMailLocally(mailboxId, mailId) {
  if (!mailboxId || !mailId) throw new Error('缺少要从插件列表移除的邮件信息');
  const settings = await getSettings();
  const cache = await getAccountCache(settings);
  const hiddenMailIds = { ...(cache.hiddenMailIds || {}) };
  const existing = hiddenMailIds[mailboxId] || [];
  if (!existing.includes(String(mailId))) hiddenMailIds[mailboxId] = [...existing, String(mailId)].slice(-MAX_HIDDEN_PER_MAILBOX);
  const nextCache = { ...cache, hiddenMailIds };
  await setCache(nextCache);
  return nextCache;
}

async function getMail(mailId) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('请先在设置中保存 API 密钥');
  return apiRequest(`/mails/${encodeURIComponent(mailId)}`, settings.apiKey);
}

async function configureAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  if (settings.apiKey && settings.pollingEnabled) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: settings.pollIntervalMinutes });
  }
}

async function saveActiveProfile(patch = {}) {
  const settings = await getSettings();
  const current = settings.accounts.find((account) => account.id === settings.activeAccountId);
  if (!current) throw new Error('没有可更新的账户');
  const nextProfile = normalizeProfile({ ...current, ...patch, id: current.id, apiKey: current.apiKey, accountScope: current.accountScope }, settings.accounts.indexOf(current));
  const accounts = settings.accounts.map((account) => account.id === current.id ? nextProfile : account);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsStore(settings.activeAccountId, accounts) });
  await configureAlarm();
  return { ...nextProfile, accounts, activeAccountId: settings.activeAccountId };
}

async function addAccount({ name, apiKey }) {
  const settings = await getSettings();
  if (!apiKey || !String(apiKey).startsWith('nm_')) throw new Error('请输入 nm_ 开头的 API 密钥');
  if (settings.accounts.length >= MAX_ACCOUNTS) throw new Error(`最多可管理 ${MAX_ACCOUNTS} 个账户，请先移除不再使用的账户`);
  const profile = normalizeProfile({
    id: accountId(),
    name: String(name || '').trim() || `账户 ${settings.accounts.length + 1}`,
    apiKey: String(apiKey).trim(),
    accountScope: accountId(),
  }, settings.accounts.length);
  const accounts = [...settings.accounts, profile];
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsStore(profile.id, accounts) });
  await configureAlarm();
  return refreshMailboxState({ silent: true, source: 'manual' });
}

async function switchAccount(accountIdToActivate) {
  const settings = await getSettings();
  const account = settings.accounts.find((item) => item.id === accountIdToActivate);
  if (!account) throw new Error('要切换的账户不存在');
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsStore(account.id, settings.accounts) });
  await configureAlarm();
  const switched = await getSettings();
  const cached = await getAccountCache(switched);
  await applyAlertVisual(cached, switched, { restartBlink: true });
  // 仅已启用自动轮询的账户在切换时同步；手动模式严格等待右上角刷新。
  return switched.pollingEnabled
    ? refreshMailboxState({ silent: true, source: 'switch' })
    : { ok: true, configured: true, cache: cached, settings: publicSettings(switched), accounts: publicSettings(switched).accounts };
}

async function renameAccount(accountIdToRename, nextName) {
  const settings = await getSettings();
  const account = settings.accounts.find((item) => item.id === accountIdToRename);
  if (!account) throw new Error('要修改的账户不存在');
  const name = String(nextName ?? '').trim().slice(0, 32);
  if (!name) throw new Error('账户名称不能为空');
  const accountIndex = settings.accounts.indexOf(account);
  const renamed = normalizeProfile({ ...account, name, id: account.id, apiKey: account.apiKey, accountScope: account.accountScope }, accountIndex);
  const accounts = settings.accounts.map((item) => item.id === account.id ? renamed : item);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsStore(settings.activeAccountId, accounts) });
  const next = await getSettings();
  const cache = await getAccountCache(next);
  const publicState = publicSettings(next);
  return { ok: true, configured: Boolean(next.apiKey), cache, settings: publicState, accounts: publicState.accounts };
}

async function removeAccount(accountIdToRemove) {
  const settings = await getSettings();
  const removed = settings.accounts.find((account) => account.id === accountIdToRemove);
  if (!removed) throw new Error('要移除的账户不存在');
  const accounts = settings.accounts.filter((account) => account.id !== accountIdToRemove);
  const activeAccountId = settings.activeAccountId === accountIdToRemove ? (accounts[0]?.id || '') : settings.activeAccountId;
  await deleteAccountCache(removed.accountScope);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsStore(activeAccountId, accounts) });
  await configureAlarm();
  const next = await getSettings();
  const cache = await getAccountCache(next);
  await applyAlertVisual(cache, next, { restartBlink: true });
  return { ok: true, configured: Boolean(next.apiKey), cache, settings: publicSettings(next), accounts: publicSettings(next).accounts };
}

chrome.runtime.onInstalled.addListener(async () => {
  await configureAlarm();
  const settings = await getSettings();
  const cache = await getAccountCache(settings);
  await applyAlertVisual(cache, settings, { restartBlink: true });
});

chrome.runtime.onStartup.addListener(async () => {
  await configureAlarm();
  const settings = await getSettings();
  if (settings.pollingEnabled) await refreshMailboxState({ silent: true, source: 'startup' });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refreshMailboxState({ source: 'alarm' });
});

chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'https://smailr.com/app/' });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === 'offscreen') return;
  (async () => {
    switch (message?.type) {
      case 'get-state': {
        const settings = await getSettings();
        const cache = await getAccountCache(settings);
        const publicState = publicSettings(settings);
        sendResponse({ ok: true, settings: publicState, configured: Boolean(settings.apiKey), cache, accounts: publicState.accounts, pollIntervals: POLL_INTERVALS });
        break;
      }
      case 'save-settings': {
        const next = await saveActiveProfile(message.settings || {});
        const cache = await getAccountCache(next);
        const publicState = publicSettings(next);
        sendResponse({ ok: true, configured: Boolean(next.apiKey), cache, settings: publicState, accounts: publicState.accounts });
        break;
      }
      case 'add-account':
        sendResponse(await addAccount(message.account || {}));
        break;
      case 'switch-account':
        sendResponse(await switchAccount(message.accountId));
        break;
      case 'rename-account':
        sendResponse(await renameAccount(message.accountId, message.name));
        break;
      case 'remove-account':
        sendResponse(await removeAccount(message.accountId));
        break;
      case 'refresh':
        sendResponse(await refreshMailboxState({ silent: Boolean(message.silent), source: 'manual' }));
        break;
      case 'clear-alerts': {
        const cache = await acknowledgeAllAlerts();
        sendResponse({ ok: true, cache });
        break;
      }
      case 'acknowledge-mail': {
        const cache = await acknowledgeOneAlert(message.mailboxId, message.mailId, message.shouldAcknowledge !== false);
        sendResponse({ ok: true, cache });
        break;
      }
      case 'get-mails': {
        const mails = await getVisibleMailboxMails(message.mailboxId);
        sendResponse({ ok: true, mails });
        break;
      }
      case 'hide-mail': {
        const cache = await hideMailLocally(message.mailboxId, message.mailId);
        sendResponse({ ok: true, cache });
        break;
      }
      case 'get-mail': {
        const mail = await getMail(message.mailId);
        sendResponse({ ok: true, mail });
        break;
      }
      case 'test-sound': {
        const played = await playSound();
        sendResponse({ ok: played, error: played ? '' : '浏览器暂时无法播放声音' });
        break;
      }
      case 'open-smailr': {
        await chrome.tabs.create({ url: message.url || 'https://smailr.com/app/' });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: '未知请求' });
    }
  })().catch((error) => sendResponse({ ok: false, error: error.message || '扩展操作失败' }));
  return true;
});

configureAlarm();
