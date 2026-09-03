import { get, put, remove } from './db.js';
import { buildFallbackAnonymousName } from './anonymous-chat.js';
import { listAliasAccounts } from './alias-account-store.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

function spaceKey(userId = '', actorId = 'user') {
  return `anonymousSpace_${clean(userId) || 'guest'}_${clean(actorId) || 'user'}`;
}

export function normalizeAnonymousSpaceProfile(profile = {}) {
  return {
    headline: clean(profile.headline),
    bio: clean(profile.bio),
    mood: clean(profile.mood),
    wallpaperStyle: clean(profile.wallpaperStyle),
    coverImage: clean(profile.coverImage),
    handle: clean(profile.handle),
    signature: clean(profile.signature),
    avatar: clean(profile.avatar),
    interests: Array.isArray(profile.interests)
      ? profile.interests.map(clean).filter(Boolean).slice(0, 12)
      : [],
    wallPhotos: Array.isArray(profile.wallPhotos)
      ? profile.wallPhotos.map(clean).filter(Boolean).slice(0, 8)
      : [],
    joinedGroups: Array.isArray(profile.joinedGroups)
      ? profile.joinedGroups.map(clean).filter(Boolean).slice(0, 12)
      : [],
    statusText: clean(profile.statusText),
    postsLocked: profile.postsLocked === true,
    hiddenSeed: clean(profile.hiddenSeed),
    hiddenContent: clean(profile.hiddenContent),
  };
}

export function normalizeAnonymousSpacePost(post = {}) {
  const imageKind = clean(post.imageKind);
  return {
    id: clean(post.id) || `aspost_${Date.now()}`,
    text: clean(post.text || post.content),
    mood: clean(post.mood || post.tag),
    image: clean(post.image),
    imagePrompt: clean(post.imagePrompt),
    textImage: clean(post.textImage || post.text_image),
    imageKind: imageKind === 'photo' || imageKind === 'textimg' ? imageKind : '',
    imageLoading: post.imageLoading === true,
    timestamp: Number(post.timestamp || Date.now()) || Date.now(),
    replies: Array.isArray(post.replies)
      ? post.replies.map((r) => ({
        id: clean(r.id) || `asreply_${Date.now()}`,
        from: clean(r.from),
        fromId: clean(r.fromId),
        text: clean(r.text || r.content),
        timestamp: Number(r.timestamp || Date.now()) || Date.now(),
      })).slice(0, 12)
      : [],
  };
}

export function normalizeAnonymousSpaceGroupFootprint(entry = {}) {
  return {
    id: clean(entry.id) || `asgf_${Date.now()}`,
    groupName: clean(entry.groupName || entry.group),
    action: clean(entry.action || 'joined') || 'joined',
    text: clean(entry.text || entry.note),
    timestamp: Number(entry.timestamp || Date.now()) || Date.now(),
  };
}

function formatDurationLabel(ms = 0) {
  const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (totalSec < 60) return `${totalSec || 1} 秒`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min} 分 ${sec} 秒` : `${min} 分钟`;
  const hour = Math.floor(min / 60);
  const restMin = min % 60;
  return restMin ? `${hour} 小时 ${restMin} 分` : `${hour} 小时`;
}

function defaultSpaceState(actorId = 'user') {
  return {
    actorId: clean(actorId) || 'user',
    profile: {
      headline: '',
      bio: '',
      mood: '',
      wallpaperStyle: '',
      coverImage: '',
      handle: '',
      signature: '',
      avatar: '',
      interests: [],
      wallPhotos: [],
      joinedGroups: [],
      statusText: '',
      hiddenSeed: '',
      hiddenContent: '',
    },
    messages: [],
    posts: [],
    footprints: [],
    groupFootprints: [],
    unlock: {
      status: 'none',
      hiddenContent: '',
      responseText: '',
      requestNote: '',
      requestCount: 0,
      requestedAt: 0,
      respondedAt: 0,
    },
    unlockEvents: [],
    updatedAt: Date.now(),
  };
}

export function countAnonymousSpaceUnlockRequests(state = {}) {
  const events = Array.isArray(state.unlockEvents) ? state.unlockEvents : [];
  const fromEvents = events.filter((e) => String(e?.type || '') === 'request').length;
  const stored = Number(state?.unlock?.requestCount || 0) || 0;
  return Math.max(fromEvents, stored);
}

export async function loadAnonymousSpaceState(userId = '', actorId = 'user') {
  const row = await get(spaceKey(userId, actorId));
  const base = defaultSpaceState(actorId);
  if (!row?.value || typeof row.value !== 'object') return base;
  return {
    ...base,
    ...row.value,
    profile: { ...base.profile, ...(row.value.profile || {}) },
    messages: Array.isArray(row.value.messages) ? row.value.messages : [],
    posts: Array.isArray(row.value.posts)
      ? row.value.posts.map(normalizeAnonymousSpacePost).slice(0, 40)
      : [],
    footprints: Array.isArray(row.value.footprints) ? row.value.footprints : [],
    groupFootprints: Array.isArray(row.value.groupFootprints)
      ? row.value.groupFootprints.map(normalizeAnonymousSpaceGroupFootprint).slice(0, 24)
      : [],
    unlock: {
      ...base.unlock,
      ...(row.value.unlock && typeof row.value.unlock === 'object' ? row.value.unlock : {}),
    },
    unlockEvents: Array.isArray(row.value.unlockEvents) ? row.value.unlockEvents : [],
  };
}

export async function deleteAnonymousSpaceState(userId = '', actorId = '') {
  const uid = clean(userId);
  const aid = clean(actorId);
  if (!uid || !aid || aid === 'user') return false;
  await remove(spaceKey(uid, aid));
  return true;
}

export async function saveAnonymousSpaceState(userId = '', actorId = 'user', state = {}) {
  const next = {
    ...defaultSpaceState(actorId),
    ...(state && typeof state === 'object' ? state : {}),
    updatedAt: Date.now(),
  };
  await put('settings', { key: spaceKey(userId, actorId), value: next });
  return next;
}

export async function loadAnonymousSpaceUserProfile(userId = '') {
  const state = await loadAnonymousSpaceState(userId, 'user');
  return normalizeAnonymousSpaceProfile(state.profile);
}

/** 收集用户自己的匿名马甲 / 陌生消息马甲网名，建房与匹配时禁止对面占用。 */
export async function loadUserReservedAnonymousHandles(userRow = null) {
  const uid = clean(userRow?.id);
  const handles = [];
  const defaultId = clean(userRow?.anonymousProfile?.defaultId);
  if (defaultId) handles.push(defaultId);
  if (uid) {
    const space = await loadAnonymousSpaceUserProfile(uid).catch(() => null);
    if (space?.handle) handles.push(space.handle);
    const aliases = await listAliasAccounts('user', uid, { userId: uid }).catch(() => []);
    for (const account of Array.isArray(aliases) ? aliases : []) {
      if (account?.handle) handles.push(account.handle);
      if (account?.displayName) handles.push(account.displayName);
    }
  }
  return [...new Set(handles.map((h) => clean(h)).filter(Boolean))];
}

export async function loadUserReservedAnonymousAvatars(userRow = null) {
  const uid = clean(userRow?.id);
  const avatars = [];
  if (uid) {
    const space = await loadAnonymousSpaceUserProfile(uid).catch(() => null);
    if (space?.avatar) avatars.push(space.avatar);
    const aliases = await listAliasAccounts('user', uid, { userId: uid }).catch(() => []);
    for (const account of Array.isArray(aliases) ? aliases : []) {
      if (account?.avatar) avatars.push(account.avatar);
    }
  }
  return [...new Set(avatars.map((a) => clean(a)).filter(Boolean))];
}

/** 建房 / 匹配时写入会话身份的用户匿名马甲（仅读匿名空间，不读全局档案） */
export async function buildUserAnonymousIdentitySeed(userId = '', options = {}) {
  const uid = clean(userId);
  const { nonce = '' } = options;
  const profile = uid ? await loadAnonymousSpaceUserProfile(uid) : normalizeAnonymousSpaceProfile();
  let currentId = profile.handle;
  if (!currentId) {
    currentId = buildFallbackAnonymousName('user', nonce || String(Date.now()));
  }
  const signature = profile.signature || profile.bio || `${currentId}，刚上线`;
  return {
    currentId,
    signature,
    avatar: profile.avatar || '',
  };
}

export async function saveUserSpaceProfile(userId = '', profile = {}) {
  const state = await loadAnonymousSpaceState(userId, 'user');
  state.profile = { ...state.profile, ...(profile || {}) };
  return saveAnonymousSpaceState(userId, 'user', state);
}

export async function saveActorSpaceProfile(userId = '', actorId = '', profile = {}) {
  const state = await loadAnonymousSpaceState(userId, actorId);
  state.profile = { ...state.profile, ...(profile || {}) };
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function syncAnonymousSpaceAvatarToChats(userId = '', actorId = 'user', avatar = '') {
  return syncAnonymousSpaceIdentityToChats(userId, actorId, { avatar });
}

export async function syncAnonymousSpaceIdentityToChats(userId = '', actorId = 'user', patch = {}) {
  const uid = clean(userId);
  const aid = clean(actorId) || 'user';
  if (!uid || !aid) return 0;
  const row = patch && typeof patch === 'object' ? patch : {};
  const identityPatch = {};
  if (row.handle !== undefined) identityPatch.currentId = clean(row.handle);
  if (row.signature !== undefined) identityPatch.signature = clean(row.signature);
  if (row.bio !== undefined && row.signature === undefined) identityPatch.signature = clean(row.bio);
  if (row.avatar !== undefined) identityPatch.avatar = clean(row.avatar);
  const moodText = row.mood !== undefined ? clean(row.mood) : (row.statusText !== undefined ? clean(row.statusText) : '');
  if (moodText) identityPatch.statusText = moodText;
  if (!Object.keys(identityPatch).length && !moodText) return 0;
  const [{ listAnonymousChatsForUser, saveChat }, { applyAnonymousIdentityPatch }, { patchChatPrefs }] = await Promise.all([
    import('./chat-store.js'),
    import('./anonymous-chat.js'),
    import('./chat-block-state.js'),
  ]);
  const chats = await listAnonymousChatsForUser(uid);
  let count = 0;
  for (const chat of chats) {
    const participants = Array.isArray(chat?.participants) ? chat.participants.map(clean) : [];
    if (!participants.includes(aid)) continue;
    if (Object.keys(identityPatch).length) {
      applyAnonymousIdentityPatch(chat, aid, identityPatch);
    }
    if (moodText) {
      await patchChatPrefs(chat.id, {
        statusText: moodText,
        statusUpdatedAt: Date.now(),
      });
    }
    await saveChat(chat);
    if (aid !== 'user') {
      const { buildAnonymousContactEntry } = await import('./anonymous-contacts.js');
      const { getAnonymousPrivateCounterpartId } = await import('./anonymous-chat.js');
      if (chat.type === 'private' && getAnonymousPrivateCounterpartId(chat) === aid) {
        await buildAnonymousContactEntry({
          userId: uid,
          chat,
          actorId: aid,
          privateChatId: chat.id,
        });
      }
    }
    count += 1;
  }
  return count;
}

export async function addAnonymousSpaceMessage(userId = '', actorId = 'user', message = {}) {
  const state = await loadAnonymousSpaceState(userId, actorId);
  const entry = {
    id: clean(message.id) || `asmsg_${Date.now()}`,
    from: clean(message.from || 'visitor'),
    fromId: clean(message.fromId || 'visitor'),
    text: clean(message.text || message.content),
    timestamp: Number(message.timestamp || Date.now()) || Date.now(),
    read: message.read === true,
  };
  state.messages = [entry, ...(state.messages || [])].slice(0, 80);
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function appendAnonymousSpaceUnlockEvent(userId = '', actorId = 'user', event = {}) {
  const state = await loadAnonymousSpaceState(userId, actorId);
  const entry = {
    id: clean(event.id) || `asunlock_${Date.now()}`,
    type: clean(event.type || 'request'),
    from: clean(event.from),
    text: clean(event.text),
    granted: event.granted === true,
    timestamp: Number(event.timestamp || Date.now()) || Date.now(),
  };
  state.unlockEvents = [entry, ...(state.unlockEvents || [])].slice(0, 24);
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function applyAnonymousSpaceUnlockResponse(userId = '', actorId = 'user', result = {}) {
  const state = await loadAnonymousSpaceState(userId, actorId);
  const granted = result.granted === true;
  state.unlock = {
    ...(state.unlock || {}),
    status: granted ? 'granted' : 'denied',
    responseText: clean(result.reply),
    requestNote: clean(result.requestNote || state.unlock?.requestNote),
    requestedAt: Number(state.unlock?.requestedAt || Date.now()) || Date.now(),
    respondedAt: Date.now(),
  };
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function markAnonymousSpaceUnlockPending(userId = '', actorId = 'user', requestNote = '') {
  const state = await loadAnonymousSpaceState(userId, actorId);
  const requestCount = countAnonymousSpaceUnlockRequests(state) + 1;
  state.unlock = {
    ...(state.unlock || {}),
    status: 'pending',
    requestNote: clean(requestNote),
    requestCount,
    requestedAt: Date.now(),
    respondedAt: 0,
  };
  return saveAnonymousSpaceState(userId, actorId, state);
}

export function isAnonymousSpacePostsLocked(state = {}, actorId = 'user') {
  if (clean(actorId) !== 'user') return true;
  return normalizeAnonymousSpaceProfile(state.profile || {}).postsLocked === true;
}

export function isAnonymousSpaceUnlocked(state = {}, actorId = 'user', options = {}) {
  if (clean(actorId) === 'user' && options.viewerActorId !== 'user') {
    if (!isAnonymousSpacePostsLocked(state, actorId)) return true;
    return clean(state?.unlock?.status) === 'granted';
  }
  if (clean(actorId) === 'user') return true;
  return clean(state?.unlock?.status) === 'granted';
}

export async function findAnonymousPrivateChatForActor(userId = '', actorId = '') {
  const uid = clean(userId);
  const aid = clean(actorId);
  if (!uid || !aid) return null;
  const [{ listAnonymousChatsForUser }, { getAnonymousPrivateCounterpartId }] = await Promise.all([
    import('./chat-store.js'),
    import('./anonymous-chat.js'),
  ]);
  const chats = await listAnonymousChatsForUser(uid);
  return chats.find((c) => c?.type === 'private' && getAnonymousPrivateCounterpartId(c) === aid) || null;
}

export async function recordAnonymousSpacePostCommentMemory({
  userId = '',
  actorId = '',
  visitorHandle = '',
  postText = '',
  text = '',
  character = null,
} = {}) {
  const uid = clean(userId);
  const aid = clean(actorId);
  const body = clean(text);
  const handle = clean(visitorHandle) || '匿名网友';
  const post = clean(postText);
  if (!uid || !aid || !body) return null;
  const chat = await findAnonymousPrivateChatForActor(uid, aid);
  if (!chat?.id) return null;
  const { upsertMemoryFact } = await import('./memory/memory-facts.js');
  return upsertMemoryFact({
    userId: uid,
    chatId: chat.id,
    sourceChatId: chat.id,
    subjectId: aid,
    subjectName: clean(character?.name || character?.realName || aid),
    content: `匿名空间动态评论：访客「${handle}」在「${post.slice(0, 36)}」下说：${body}`,
    factType: '匿名空间',
    evidence: '匿名空间动态评论',
    confidence: 0.8,
    visibility: 'private',
    knownBy: { [aid]: true },
    tags: ['anonymous-space', 'post-comment'],
  }).catch(() => null);
}

export async function recordAnonymousSpaceMessageMemory({
  userId = '',
  actorId = '',
  visitorHandle = '',
  text = '',
  character = null,
} = {}) {
  const uid = clean(userId);
  const aid = clean(actorId);
  const body = clean(text);
  const handle = clean(visitorHandle) || '匿名网友';
  if (!uid || !aid || !body) return null;
  const chat = await findAnonymousPrivateChatForActor(uid, aid);
  if (!chat?.id) return null;
  const { upsertMemoryFact } = await import('./memory/memory-facts.js');
  return upsertMemoryFact({
    userId: uid,
    chatId: chat.id,
    sourceChatId: chat.id,
    subjectId: aid,
    subjectName: clean(character?.name || character?.realName || aid),
    content: `匿名空间留言：访客「${handle}」说：${body}`,
    factType: '匿名空间',
    evidence: '匿名空间留言板',
    confidence: 0.78,
    visibility: 'private',
    knownBy: { [aid]: true },
    tags: ['anonymous-space', 'guestbook'],
  }).catch(() => null);
}

export async function recordAnonymousSpaceFootprint(userId = '', actorId = 'user', visitor = {}) {
  const state = await loadAnonymousSpaceState(userId, actorId);
  const entry = {
    id: clean(visitor.id) || `fp_${Date.now()}`,
    visitorId: clean(visitor.visitorId || visitor.from),
    visitorName: clean(visitor.visitorName || visitor.from),
    note: clean(visitor.note || '路过空间'),
    timestamp: Number(visitor.timestamp || Date.now()) || Date.now(),
    durationMs: Number(visitor.durationMs || 0) || 0,
    leftAt: Number(visitor.leftAt || 0) || 0,
  };
  state.footprints = [entry, ...(state.footprints || [])].slice(0, 40);
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function finalizeAnonymousSpaceFootprint(userId = '', actorId = 'user', footprintId = '', durationMs = 0) {
  const fid = clean(footprintId);
  if (!fid) return null;
  const state = await loadAnonymousSpaceState(userId, actorId);
  const idx = (state.footprints || []).findIndex((f) => clean(f.id) === fid);
  if (idx < 0) return state;
  const row = state.footprints[idx];
  state.footprints[idx] = {
    ...row,
    durationMs: Math.max(Number(row.durationMs || 0) || 0, Number(durationMs || 0) || 0),
    leftAt: Date.now(),
    note: row.note || '路过空间',
  };
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function setAnonymousSpacePosts(userId = '', actorId = 'user', posts = []) {
  const state = await loadAnonymousSpaceState(userId, actorId);
  state.posts = (Array.isArray(posts) ? posts : [])
    .map(normalizeAnonymousSpacePost)
    .filter((p) => p.text)
    .slice(0, 24);
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function removeAnonymousSpacePost(userId = '', actorId = 'user', postId = '') {
  const pid = clean(postId);
  if (!pid) return null;
  const state = await loadAnonymousSpaceState(userId, actorId);
  state.posts = (state.posts || []).filter((p) => clean(p.id) !== pid);
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function prependAnonymousSpacePost(userId = '', actorId = 'user', post = {}) {
  const state = await loadAnonymousSpaceState(userId, actorId);
  const entry = normalizeAnonymousSpacePost(post);
  if (!entry.text) return state;
  state.posts = [entry, ...(state.posts || [])].slice(0, 24);
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function appendAnonymousSpaceFootprints(userId = '', actorId = 'user', footprints = []) {
  const state = await loadAnonymousSpaceState(userId, actorId);
  const incoming = (Array.isArray(footprints) ? footprints : [])
    .map((row) => ({
      id: clean(row.id) || `fp_${Date.now()}`,
      visitorId: clean(row.visitorId || row.visitorName || 'visitor'),
      visitorName: clean(row.visitorName || row.from || '路过网友'),
      note: clean(row.note || '看了看空间'),
      timestamp: Number(row.timestamp || Date.now()) || Date.now(),
      durationMs: Math.max(0, Number(row.durationMs || row.durationSec * 1000 || 0) || 0),
      leftAt: Number(row.leftAt || 0) || 0,
    }))
    .filter((f) => f.visitorName);
  state.footprints = [...incoming, ...(state.footprints || [])].slice(0, 40);
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function appendAnonymousSpacePosts(userId = '', actorId = 'user', posts = []) {
  const state = await loadAnonymousSpaceState(userId, actorId);
  const incoming = (Array.isArray(posts) ? posts : [])
    .map(normalizeAnonymousSpacePost)
    .filter((p) => p.text);
  state.posts = [...incoming, ...(state.posts || [])].slice(0, 24);
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function updateAnonymousSpacePost(userId = '', actorId = 'user', postId = '', patch = {}) {
  const pid = clean(postId);
  if (!pid) return null;
  const state = await loadAnonymousSpaceState(userId, actorId);
  const idx = (state.posts || []).findIndex((p) => clean(p.id) === pid);
  if (idx < 0) return state;
  state.posts[idx] = normalizeAnonymousSpacePost({
    ...state.posts[idx],
    ...(patch && typeof patch === 'object' ? patch : {}),
  });
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function addAnonymousSpacePostReply(userId = '', actorId = 'user', postId = '', reply = {}) {
  const pid = clean(postId);
  if (!pid) return null;
  const state = await loadAnonymousSpaceState(userId, actorId);
  const idx = (state.posts || []).findIndex((p) => clean(p.id) === pid);
  if (idx < 0) return state;
  const post = normalizeAnonymousSpacePost(state.posts[idx]);
  const entry = {
    id: clean(reply.id) || `asreply_${Date.now()}`,
    from: clean(reply.from),
    fromId: clean(reply.fromId),
    text: clean(reply.text || reply.content),
    timestamp: Number(reply.timestamp || Date.now()) || Date.now(),
  };
  post.replies = [entry, ...(post.replies || [])].slice(0, 12);
  state.posts[idx] = post;
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function setAnonymousSpaceGroupFootprints(userId = '', actorId = 'user', entries = []) {
  const state = await loadAnonymousSpaceState(userId, actorId);
  state.groupFootprints = (Array.isArray(entries) ? entries : [])
    .map(normalizeAnonymousSpaceGroupFootprint)
    .filter((e) => e.groupName || e.text)
    .slice(0, 24);
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function setAnonymousSpaceMessages(userId = '', actorId = 'user', messages = []) {
  const state = await loadAnonymousSpaceState(userId, actorId);
  state.messages = (Array.isArray(messages) ? messages : [])
    .map((m) => ({
      id: clean(m.id) || `asmsg_${Date.now()}`,
      from: clean(m.from || 'visitor'),
      fromId: clean(m.fromId || 'visitor'),
      text: clean(m.text || m.content),
      timestamp: Number(m.timestamp || Date.now()) || Date.now(),
      read: m.read === true,
    }))
    .filter((m) => m.text)
    .slice(0, 80);
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function appendAnonymousSpaceMessages(userId = '', actorId = 'user', messages = []) {
  const state = await loadAnonymousSpaceState(userId, actorId);
  const incoming = (Array.isArray(messages) ? messages : [])
    .map((m) => ({
      id: clean(m.id) || `asmsg_${Date.now()}`,
      from: clean(m.from || 'visitor'),
      fromId: clean(m.fromId || 'visitor'),
      text: clean(m.text || m.content),
      timestamp: Number(m.timestamp || Date.now()) || Date.now(),
      read: m.read === true,
    }))
    .filter((m) => m.text);
  state.messages = [...incoming, ...(state.messages || [])].slice(0, 80);
  return saveAnonymousSpaceState(userId, actorId, state);
}

export async function recordAnonymousSpaceUnlockMemory({
  userId = '',
  actorId = '',
  visitorHandle = '',
  granted = false,
  reply = '',
  hiddenContent = '',
  requestCount = 0,
  character = null,
} = {}) {
  const uid = clean(userId);
  const aid = clean(actorId);
  const handle = clean(visitorHandle) || '匿名网友';
  if (!uid || !aid) return null;
  const chat = await findAnonymousPrivateChatForActor(uid, aid);
  if (!chat?.id) return null;
  const { upsertMemoryFact } = await import('./memory/memory-facts.js');
  const count = Number(requestCount || 0) || 0;
  const lines = [
    granted
      ? `我在匿名空间给访客「${handle}」解锁了动态阅读权限${count > 1 ? `（对方第 ${count} 次申请）` : ''}。`
      : `访客「${handle}」第 ${count || 1} 次申请查看我的匿名空间动态，我婉拒了。`,
  ];
  if (reply) lines.push(`我当时回复：${clean(reply)}`);
  return upsertMemoryFact({
    userId: uid,
    chatId: chat.id,
    sourceChatId: chat.id,
    subjectId: aid,
    subjectName: clean(character?.name || character?.realName || aid),
    content: lines.join(' '),
    factType: '匿名空间',
    evidence: '匿名空间解锁',
    confidence: 0.86,
    visibility: 'private',
    knownBy: { [aid]: true },
    tags: ['anonymous-space', 'unlock'],
  }).catch(() => null);
}

export function buildUserSpaceVisitorPromptBlock(state = {}, options = {}) {
  const profile = normalizeAnonymousSpaceProfile(state.profile || {});
  if (!profile.postsLocked) return '';
  const postCount = (state.posts || []).length;
  const actorHandle = clean(options.visitorHandle) || '网友';
  const lines = [
    `【对方匿名空间 · ${profile.handle || '网友'}】`,
    '对方的动态区已上锁，你目前只能感知到简介、留言板和足迹层面的公开信息。',
    postCount ? `对方约有 ${postCount} 条未对你开放的动态。` : '对方可能还没发多少动态，或动态未公开。',
    `若你的人设会对网友生活好奇，可在聊天里自然地试探能否看看对方空间；在对方明确同意前，不要假装已经看过动态内容。`,
    profile.signature ? `对方签名：${profile.signature}` : '',
    profile.bio ? `对方简介：${profile.bio}` : '',
  ];
  const msgs = (state.messages || []).slice(0, 2);
  if (msgs.length) {
    lines.push('最近留言摘录：');
    for (const m of msgs) lines.push(`- ${m.from}：${m.text}`);
  }
  return lines.filter(Boolean).join('\n');
}

export function buildAnonymousSpaceActorPromptBlock(state = {}, options = {}) {
  const profile = normalizeAnonymousSpaceProfile(state.profile || {});
  const actorHandle = clean(profile.handle) || '匿名网友';
  const visitorHandle = clean(options.visitorHandle) || '匿名网友';
  const forActor = options.forActorPerspective !== false;
  const unlocked = isAnonymousSpaceUnlocked(state, state.actorId || options.actorId);
  const requestCount = countAnonymousSpaceUnlockRequests(state);
  const lines = [`【匿名空间 · ${actorHandle}】`];
  if (profile.signature) lines.push(`签名：${profile.signature}`);
  if (profile.bio) lines.push(`简介：${profile.bio}`);
  if (profile.mood) lines.push(`状态：${profile.mood}`);
  const posts = (state.posts || []).slice(0, 4);
  if (posts.length) {
    lines.push('近期空间动态（像没准备给别人看的小号说说）：');
    for (const p of posts) {
      lines.push(`- ${p.text}${p.mood ? `（${p.mood}）` : ''}`);
    }
  }
  if (forActor && unlocked) {
    lines.push(`你知道访客「${visitorHandle}」已获准查看你的匿名空间动态${requestCount > 1 ? `（共申请 ${requestCount} 次）` : ''}。聊天里可以自然提起，但不要重复掉马。`);
  } else if (forActor && requestCount > 0 && !unlocked) {
    lines.push(`访客「${visitorHandle}」已申请 ${requestCount} 次查看你的匿名空间，你尚未同意。`);
  }
  const msgs = (state.messages || []).slice(0, 3);
  if (msgs.length) {
    lines.push('最近留言：');
    for (const m of msgs) lines.push(`- ${m.from}：${m.text}`);
  }
  return lines.join('\n');
}

export function formatAnonymousSpaceFootprintLine(footprint = {}) {
  const when = new Date(Number(footprint.timestamp || Date.now()) || Date.now()).toLocaleString('zh-CN');
  const duration = Number(footprint.durationMs || 0) || 0;
  const durationLabel = duration > 0 ? `，停留 ${formatDurationLabel(duration)}` : '';
  return `${clean(footprint.visitorName || '访客')} · ${when}${durationLabel}`;
}

export function formatAnonymousSpaceContext(state = {}) {
  const profile = state.profile || {};
  const lines = [];
  if (profile.headline) lines.push(`标题：${profile.headline}`);
  if (profile.bio) lines.push(`简介：${profile.bio}`);
  if (profile.mood) lines.push(`心情：${profile.mood}`);
  const posts = (state.posts || []).slice(0, 6);
  if (posts.length) {
    lines.push('空间动态：');
    for (const p of posts) lines.push(`- ${p.text}`);
  }
  const msgs = (state.messages || []).slice(0, 5);
  if (msgs.length) {
    lines.push('最近留言：');
    for (const m of msgs) lines.push(`- ${m.from}：${m.text}`);
  }
  const fps = (state.footprints || []).slice(0, 5);
  if (fps.length) {
    lines.push('最近访客：');
    for (const f of fps) lines.push(`- ${formatAnonymousSpaceFootprintLine(f)}`);
  }
  return lines.join('\n');
}
