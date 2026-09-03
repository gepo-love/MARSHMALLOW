/** 会话与消息模型（商业版 · 无赛季 / 战队 / 荣耀字段） */

const DEFAULT_GROUP_SETTINGS = {
  name: '',
  avatar: '',
  owner: null,
  admins: [],
  announcement: '',
  todos: [],
  offlinePlans: [],
  description: '',
  plotDirective: '',
  muted: [],
  allMuted: false,
  isObserverMode: false,
  allowSocialLinkage: true,
  allowPrivateLinkage: true,
  linkageCadenceMode: 'natural',
  linkageMinIntervalTurns: 3,
  linkageNudgeEvery: 5,
  linkageRouteBias: 'balanced',
  linkageGroupPityEvery: 3,
  allowAiGroupOps: true,
  titles: {},
  wallpaper: '',
  wallpaperOpacity: 100,
  customCss: '',
  bubbleSelf: '',
  bubbleOther: '',
  bubbleTextSelf: '',
  bubbleTextOther: '',
};

const DEFAULT_CHAT_METADATA = {
  channel: 'scrapbook',
  memoryMode: 'inherit_full',
};

export const USER_TOPIC_POLICIES = Object.freeze(['normal', 'rare', 'off']);

export function isNoUserGroup(chat = {}) {
  return chat?.type === 'group'
    && !(chat?.participants || []).includes('user');
}

/**
 * 群成员表是“谁真正进了群”的事实源；观察模式是它的派生状态。
 * 旧备份曾可能同时保存 user 成员和 isObserverMode=true。遇到这种冲突时，
 * 以成员表为准修正派生标记，避免不同页面和提示词各用一套口径。
 */
export function normalizeGroupUserPresence(chat) {
  if (!chat || chat.type !== 'group') return chat;
  const sourceParticipants = Array.isArray(chat.participants) ? chat.participants : [];
  let participants = [...new Set(sourceParticipants
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  const settings = chat.groupSettings && typeof chat.groupSettings === 'object'
    ? chat.groupSettings
    : {};
  const observerMode = !participants.includes('user');

  let owner = String(settings.owner || '').trim();
  if (!owner || !participants.includes(owner)) {
    owner = participants.find((id) => id !== 'user') || (participants.includes('user') ? 'user' : '');
  }
  const admins = [...new Set((Array.isArray(settings.admins) ? settings.admins : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && participants.includes(id)))];
  const unchanged = participants.length === sourceParticipants.length
    && participants.every((id, index) => id === sourceParticipants[index])
    && settings.isObserverMode === observerMode
    && String(settings.owner || '').trim() === owner
    && admins.length === (Array.isArray(settings.admins) ? settings.admins.length : 0)
    && admins.every((id, index) => id === settings.admins[index]);
  if (unchanged) return chat;
  return {
    ...chat,
    participants,
    groupSettings: {
      ...settings,
      owner: owner || null,
      admins,
      isObserverMode: observerMode,
    },
  };
}

export function isAllMutedGroup(chat = {}) {
  return chat?.type === 'group' && chat?.groupSettings?.allMuted === true;
}

export function resolveUserTopicPolicy(chat = {}) {
  const raw = String(chat?.groupSettings?.userTopicPolicy || '').trim().toLowerCase();
  if (USER_TOPIC_POLICIES.includes(raw)) return raw;
  return isNoUserGroup(chat) ? 'rare' : 'normal';
}

export function resolveAllowUserMainChatContext(chat = {}) {
  if (!isNoUserGroup(chat)) return true;
  if (resolveUserTopicPolicy(chat) === 'off') return false;
  return chat?.groupSettings?.allowUserMainChatContext !== false;
}

export function createChat(overrides = {}) {
  const now = Date.now();
  const createdAt = Number(overrides.createdAt || now) || now;
  const type = overrides.type === 'group' ? 'group' : 'private';
  const participants = Array.isArray(overrides.participants) ? overrides.participants.filter(Boolean) : [];
  const suppliedGroupSettings = overrides.groupSettings || {};
  const observerLike = type === 'group'
    && (!participants.includes('user') || suppliedGroupSettings.isObserverMode === true);
  const groupSettings = {
    ...DEFAULT_GROUP_SETTINGS,
    ...suppliedGroupSettings,
    userTopicPolicy: USER_TOPIC_POLICIES.includes(String(suppliedGroupSettings.userTopicPolicy || '').trim().toLowerCase())
      ? String(suppliedGroupSettings.userTopicPolicy).trim().toLowerCase()
      : (observerLike ? 'rare' : 'normal'),
    allowUserMainChatContext: suppliedGroupSettings.allowUserMainChatContext !== false,
  };
  return {
    id: overrides.id || `chat_${now}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    userId: overrides.userId || null,
    participants,
    groupSettings,
    metadata: { ...DEFAULT_CHAT_METADATA, ...(overrides.metadata || {}) },
    lastMessage: String(overrides.lastMessage || ''),
    createdAt,
    lastActivity: Number(overrides.lastActivity || createdAt) || createdAt,
    unread: Math.max(0, Number(overrides.unread || 0) || 0),
    autoActive: !!overrides.autoActive,
    autoInterval: Number(overrides.autoInterval || 300000) || 300000,
    pinned: !!overrides.pinned,
    pinnedAt: Number.isFinite(Number(overrides.pinnedAt)) ? Number(overrides.pinnedAt) : 0,
    ...(overrides.anonymousPrivateConfig && typeof overrides.anonymousPrivateConfig === 'object'
      ? { anonymousPrivateConfig: { ...overrides.anonymousPrivateConfig } }
      : {}),
  };
}

export function createMessage(overrides = {}) {
  const now = Date.now();
  return {
    id: overrides.id || `msg_${now}_${Math.random().toString(36).slice(2, 6)}`,
    chatId: String(overrides.chatId || ''),
    senderId: String(overrides.senderId || 'user'),
    senderName: String(overrides.senderName || ''),
    type: String(overrides.type || 'text'),
    content: String(overrides.content ?? ''),
    timestamp: Number(overrides.timestamp || now) || now,
    createdAt: Number(overrides.createdAt || now) || now,
    replyPreview: overrides.replyPreview || null,
    metadata: overrides.metadata && typeof overrides.metadata === 'object' ? { ...overrides.metadata } : {},
    deleted: !!overrides.deleted,
    recalled: !!overrides.recalled,
  };
}

export function createPrivateChat(userId, characterId, characterName = '') {
  return createChat({
    type: 'private',
    userId,
    participants: ['user', characterId].filter(Boolean),
    metadata: { channel: 'scrapbook', partnerName: characterName },
  });
}
