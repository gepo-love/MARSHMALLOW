/**
 * 路由意图预取：主屏图标 / 聊天列表在 pointerdown 时提前加载模块与首屏数据，
 * 把点击后的等待藏进手指按下到抬起的间隙里。
 */
let _loadPage = null;

const _prefetchInflight = new Map();
const _prefetchData = new Map();
const PREFETCH_DATA_TTL_MS = 5000;
// 角色手机即使拆掉了多条重依赖，页面模块本身仍很大。pointerdown 后立刻解析会占住
// 主线程并把随后 click 事件推迟；让路由先建立 loading 容器，再按正常路径加载它。
// 空闲 recent-route 预热仍走 loadPage，不受这里影响。
const POINTERDOWN_MODULE_PREFETCH_SKIP_ROUTES = new Set(['character-phone']);

/**
 * 页面模块缓存只能保留成功结果。网络瞬断、旧 SW 响应或一次解析失败若把 rejected
 * Promise 永久留在 Map 里，之后每次点击都会立即复用同一个失败，直到整个 App 重启。
 * 身份判断同时避免较早的失败请求误删后来主动放入的新版 Promise。
 */
export function getOrCreateRetryablePageModule(cache, key, loader) {
  if (!(cache instanceof Map)) throw new TypeError('page module cache must be a Map');
  if (cache.has(key)) return cache.get(key);
  if (typeof loader !== 'function') return Promise.reject(new TypeError('page module loader is required'));

  let request;
  request = Promise.resolve()
    .then(() => loader())
    .then((renderFn) => {
      if (typeof renderFn !== 'function') {
        throw new TypeError(`页面模块 ${String(key || '')} 缺少默认渲染函数`);
      }
      return renderFn;
    })
    .catch((error) => {
      if (cache.get(key) === request) cache.delete(key);
      throw error;
    });
  cache.set(key, request);
  return request;
}

export function bindRoutePrefetch(loadPageFn) {
  _loadPage = typeof loadPageFn === 'function' ? loadPageFn : null;
}

function prefetchKey(path, params = {}) {
  const p = String(path || '').trim();
  if (p === 'chat/thread' || p === 'chat/details') {
    const chatId = String(params.chatId || '').trim();
    return chatId ? `${p}:${chatId}` : p;
  }
  return p;
}

export function prefetchRoute(path, params = {}) {
  const routePath = String(path || '').trim();
  if (!routePath) return;
  const key = prefetchKey(routePath, params);
  if (_prefetchInflight.has(key)) return;
  // 模块和数据同时启动，但数据消费者不应再被大页面的解析绑住。
  // 正式路由本来就会等模块；若 consume 拿到的是 Promise.all 的结果，
  // chat/thread 内部会把剩余的模块时间误记到 userChat 数据阶段。
  const dataJob = Promise.resolve().then(() => prefetchRouteData(routePath, params));
  const consumableDataJob = dataJob.catch(() => null);
  const moduleJob = POINTERDOWN_MODULE_PREFETCH_SKIP_ROUTES.has(routePath)
    ? Promise.resolve(null)
    : Promise.resolve().then(() => (
      _loadPage ? _loadPage(routePath) : null
    ));
  const job = Promise.all([moduleJob, dataJob])
    .then(([, data]) => data)
    .catch(() => null)
    .finally(() => {
      _prefetchInflight.delete(key);
    });
  _prefetchInflight.set(key, job);
  _prefetchData.set(key, {
    promise: consumableDataJob,
    expiresAt: Date.now() + PREFETCH_DATA_TTL_MS,
  });
  globalThis.setTimeout(() => {
    const entry = _prefetchData.get(key);
    if (entry?.promise === consumableDataJob && entry.expiresAt <= Date.now()) _prefetchData.delete(key);
  }, PREFETCH_DATA_TTL_MS + 100);
}

/**
 * 消费 pointerdown 阶段已经启动的数据读取，避免正式路由再开一轮相同 IndexedDB 查询。
 * 数据只保留几秒且只允许消费一次，防止旧会话快照长期覆盖新写入。
 */
export function consumeRoutePrefetchData(path, params = {}) {
  const key = prefetchKey(path, params);
  const entry = _prefetchData.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    _prefetchData.delete(key);
    return null;
  }
  _prefetchData.delete(key);
  return entry.promise;
}

async function prefetchRouteData(path, params = {}) {
  const routePath = String(path || '').trim();
  if (routePath === 'chat') {
    const { ensureDefaultUser } = await import('./user-slot.js');
    const { listInboxChatsForUser } = await import('./chat-store.js');
    const user = await ensureDefaultUser();
    const inboxChats = await listInboxChatsForUser(user.id);
    return { user, inboxChats };
  }
  if (routePath === 'chat/thread') {
    const chatId = String(params.chatId || '').trim();
    if (!chatId) return;
    const [
      { ensureDefaultUser },
      { chatBelongsToUserSlot, getChat, listMessagesPageForChat },
      { primeDisplayRegex },
      { loadChatPrefsWithExpiredStatus },
    ] = await Promise.all([
      import('./user-slot.js'),
      import('./chat-store.js'),
      import('./display-regex.js'),
      import('./status-ttl.js'),
    ]);
    const prefetchTasks = {};
    const timed = (name, promise) => {
      const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return Promise.resolve(promise).finally(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        prefetchTasks[name] = Math.max(0, Math.round(now - startedAt));
      });
    };
    const [user, , chat, messagesPage, chatPrefs] = await Promise.all([
      timed('user', ensureDefaultUser()),
      timed('displayRegex', primeDisplayRegex()),
      timed('chat', getChat(chatId)),
      timed('messages', listMessagesPageForChat(chatId, { limit: 100, deferHeavyImages: true })),
      timed('chatPrefs', loadChatPrefsWithExpiredStatus(chatId)),
    ]);
    if (!chatBelongsToUserSlot(chat, user.id, { allowLegacyUnscoped: false })) {
      return { user, chat: null, messagesPage: null };
    }
    return { user, chat, messagesPage, chatPrefs, prefetchTasks };
  }
  if (routePath === 'chat/details') {
    const chatId = String(params.chatId || '').trim();
    if (!chatId) return;
    const [
      { ensureDefaultUser },
      { chatBelongsToUserSlot, getChat },
      { loadChatPrefs },
    ] = await Promise.all([
      import('./user-slot.js'),
      import('./chat-store.js'),
      import('./chat-block-state.js'),
    ]);
    const [user, chat, chatPrefs] = await Promise.all([
      ensureDefaultUser(),
      getChat(chatId),
      loadChatPrefs(chatId),
    ]);
    if (!chatBelongsToUserSlot(chat, user.id, { allowLegacyUnscoped: false })) {
      return { user, chat: null, chatPrefs: null };
    }
    return { user, chat, chatPrefs };
  }
  if (routePath === 'home') {
    await import('./appearance-prefs.js').then((m) => m.loadAppearancePrefs?.());
    return;
  }
  if (routePath === 'presets') {
    await import('./preset-store.js').then((m) => m.loadPresetsPageSnapshot?.());
    return;
  }
  if (routePath === 'travel-char') {
    const { ensureDefaultUser } = await import('./user-slot.js');
    const { listCharacters } = await import('./character-store.js');
    const { listTravelCharTrips } = await import('./travel-char.js');
    const user = await ensureDefaultUser();
    await Promise.all([
      listCharacters({ excludeAnonNpc: true }),
      listTravelCharTrips(user.id),
    ]);
    return;
  }
  if (routePath === 'contacts') {
    const { listCharacters } = await import('./character-store.js');
    await Promise.all([
      import('./user-slot.js').then((m) => m.ensureDefaultUser?.()),
      listCharacters({ excludeAnonNpc: true }),
      import('./contact-groups.js').then((m) => m.loadContactGroupsConfig?.()),
    ]);
  }
}
