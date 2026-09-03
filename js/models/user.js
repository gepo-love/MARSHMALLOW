/** 用户档位（存档槽） */

import { normalizeImageLock } from './character.js';
import { upgradeMixedContentMediaUrl } from '../core/media-url.js';

// 用户名兜底：绝不能用裸「我」。角色扮演时第一人称也是「我」，一旦把 user 标成「我」
// 注入进纯 system 上下文/记忆，AI 就会把 user 当成自己、把 user 的事写成角色的。
// 统一回落「用户」。判断「未设名」时把历史占位「我」也视为未设。
export const FALLBACK_USER_NAME = '用户';

function isUnsetUserName(value) {
  const v = String(value || '').trim();
  return !v || v === '我' || v === '我自己' || v === FALLBACK_USER_NAME;
}

function normalizeIdentityAppearance(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const appearance = source.chatAppearance && typeof source.chatAppearance === 'object'
    ? source.chatAppearance
    : {};
  const wallpaperOpacity = Number(appearance.wallpaperOpacity);
  const hubBackgroundOpacity = Number(source.chatHubBackgroundOpacity);
  const sidebarBackgroundOpacity = Number(source.chatSidebarBackgroundOpacity);
  return {
    chatPresetId: String(source.chatPresetId || '').trim(),
    chatPresetName: String(source.chatPresetName || '').trim().slice(0, 40),
    wallpaperAssetId: String(source.wallpaperAssetId || '').trim(),
    chatHubBackgroundAssetId: String(source.chatHubBackgroundAssetId || '').trim(),
    chatHubBackgroundOpacity: Number.isFinite(hubBackgroundOpacity)
      ? Math.min(100, Math.max(0, Math.round(hubBackgroundOpacity)))
      : 40,
    chatSidebarBackgroundAssetId: String(source.chatSidebarBackgroundAssetId || '').trim(),
    chatSidebarBackgroundOpacity: Number.isFinite(sidebarBackgroundOpacity)
      ? Math.min(100, Math.max(0, Math.round(sidebarBackgroundOpacity)))
      : 40,
    chatAppearance: {
      customCss: String(appearance.customCss || ''),
      userBubbleCss: String(appearance.userBubbleCss || ''),
      charBubbleCss: String(appearance.charBubbleCss || ''),
      wallpaperOpacity: Number.isFinite(wallpaperOpacity)
        ? Math.min(100, Math.max(10, Math.round(wallpaperOpacity)))
        : 100,
      bubbleSelf: String(appearance.bubbleSelf || '').trim(),
      bubbleOther: String(appearance.bubbleOther || '').trim(),
      bubbleTextSelf: String(appearance.bubbleTextSelf || '').trim(),
      bubbleTextOther: String(appearance.bubbleTextOther || '').trim(),
      bubbleFontSize: Math.max(0, Number(appearance.bubbleFontSize || 0) || 0),
      avatarSize: Math.max(0, Number(appearance.avatarSize || 0) || 0),
      narrationFontSize: Math.max(0, Number(appearance.narrationFontSize || 0) || 0),
      narrationTextColor: String(appearance.narrationTextColor || '').trim(),
      bubbleGrouping: appearance.bubbleGrouping === true,
    },
  };
}

function normalizeCharacterOverrides(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result = {};
  for (const [characterId, patch] of Object.entries(raw).slice(0, 240)) {
    const id = String(characterId || '').trim();
    if (!id || !patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
    result[id] = { ...patch };
  }
  return result;
}

function cleanIdentityIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
}

export function normalizeIdentityBinding(raw = {}) {
  const binding = raw && typeof raw === 'object' ? raw : {};
  const legacyType = binding.type === 'character' || binding.type === 'group'
    ? binding.type : '';
  const groupIds = cleanIdentityIds([
    ...(Array.isArray(binding.groupIds) ? binding.groupIds : []),
    ...(legacyType === 'group' ? [
      ...(Array.isArray(binding.targetIds) ? binding.targetIds : []),
      binding.targetId,
    ] : []),
  ]);
  const characterIds = cleanIdentityIds([
    ...(Array.isArray(binding.characterIds) ? binding.characterIds : []),
    ...(legacyType === 'character' ? [
      ...(Array.isArray(binding.targetIds) ? binding.targetIds : []),
      binding.targetId,
    ] : []),
  ]);
  const excludedCharacterIds = cleanIdentityIds(binding.excludedCharacterIds)
    .filter((id) => !characterIds.includes(id));
  const type = groupIds.length ? 'group' : (characterIds.length ? 'character' : '');
  return {
    type,
    targetId: type === 'group' ? groupIds[0] : (characterIds[0] || ''),
    targetIds: type === 'group' ? groupIds : [],
    groupIds,
    characterIds,
    excludedCharacterIds: groupIds.length ? excludedCharacterIds : [],
  };
}

export function hasActiveIdentityBinding(raw = {}) {
  const binding = normalizeIdentityBinding(raw);
  return binding.groupIds.length > 0 || binding.characterIds.length > 0;
}

export function identityBindingSelectsCharacter(raw = {}, character = {}) {
  const binding = normalizeIdentityBinding(raw);
  const id = String(character?.id || '').trim();
  if (!id || binding.excludedCharacterIds.includes(id)) return false;
  if (binding.characterIds.includes(id)) return true;
  const groupId = String(character?.groupId || 'default').trim() || 'default';
  return binding.groupIds.includes(groupId);
}

/** 判断是否为系统占位称呼（用户 / user / 我 / 空）。 */
export function isUserPlaceholderLabel(label = '') {
  const s = String(label || '').trim();
  if (!s) return true;
  if (/^user$/i.test(s)) return true;
  return isUnsetUserName(s);
}

/** 把占位称呼还原成当前用户对话名；fallback 优先昵称，否则姓名。 */
export function coerceUserFacingLabel(label = '', displayName = '') {
  const live = String(displayName || '').trim();
  const fb = !isUnsetUserName(live) ? live : FALLBACK_USER_NAME;
  return normalizeUserFacingLabel(label, fb);
}

/** 把「用户 / user / 我」这类系统占位称呼还原成当前用户实际对话名（昵称优先，否则姓名）。 */
export function normalizeUserFacingLabel(label = '', fallback = FALLBACK_USER_NAME) {
  const s = String(label || '').trim();
  const fb = String(fallback || '').trim() || FALLBACK_USER_NAME;
  if (!s || s === 'user' || isUnsetUserName(s)) return fb;
  return s;
}

export function createUser(overrides = {}) {
  const now = Date.now();
  const id = String(overrides.id || `user_${now}`).trim();
  // slotGroupId 是最早就存在、也是档位管理 UI 实际使用的容器边界。旧版复制、导入或
  // 恢复数据若留下了“新档位 slotGroupId 已变化、worldId 仍指向源档”的不一致记录，
  // 必须以容器边界为准；反过来会把两个独立档位重新并组，编辑背景时一起被同步。
  const worldId = String(overrides.slotGroupId || overrides.worldId || id).trim() || id;
  const identityBinding = normalizeIdentityBinding(overrides.identityBinding);
  return {
    id,
    // 同一档位内的多个 user 身份生活在同一个世界。旧数据以 slotGroupId 回填，
    // 没有分组字段的历史档位则以自身 id 为独立世界，避免跨档误合并。
    worldId,
    // 兼容旧备份与现有档位 UI；新数据与 worldId 保持同值。
    slotGroupId: worldId,
    slotName: String(overrides.slotName || overrides.archiveNote || '').trim(),
    // 整个档位共享的故事世界前提；与单个身份的人设、经历分开。
    worldBackground: String(overrides.worldBackground || '').trim().slice(0, 12000),
    name: isUnsetUserName(overrides.name) ? FALLBACK_USER_NAME : String(overrides.name).trim(),
    nickname: String(overrides.nickname || '').trim(),
    // 角色在普通聊天、心声和记忆里对用户使用的现实称呼；与社交平台展示昵称分开。
    preferredCallName: String(overrides.preferredCallName || overrides.conversationName || '').trim(),
    gender: String(overrides.gender || '').trim().slice(0, 24),
    pronouns: String(overrides.pronouns || '').trim().slice(0, 24),
    avatar: upgradeMixedContentMediaUrl(overrides.avatar || '') || String(overrides.avatar || ''),
    videoAvatar: upgradeMixedContentMediaUrl(overrides.videoAvatar || overrides.videoProfileImage || '')
      || String(overrides.videoAvatar || overrides.videoProfileImage || ''),
    videoAppearancePrompt: String(overrides.videoAppearancePrompt || overrides.videoProfileDescription || '').trim(),
    signature: String(overrides.signature || '').trim(),
    statusText: String(overrides.statusText || '').trim(),
    // When signature/status were last edited; missing = long-settled background for prompts.
    signatureUpdatedAt: Number(overrides.signatureUpdatedAt || 0) || 0,
    statusUpdatedAt: Number(overrides.statusUpdatedAt || 0) || 0,
    birthday: String(overrides.birthday || '').trim(),
    virtualCity: String(overrides.virtualCity || '').trim(),
    realCityMap: String(overrides.realCityMap || '').trim(),
    // 日程表里显式选择的 IANA 时区；空值表示跟随设备。
    timezone: String(overrides.timezone || '').trim(),
    weatherHint: String(overrides.weatherHint || '').trim(),
    // TA 出门找用户本人时用来规划路程；自选文本即可，选了高德地点会额外存坐标/地址。
    myPlaceLabel: String(overrides.myPlaceLabel || '').trim(),
    myPlaceAddress: String(overrides.myPlaceAddress || '').trim(),
    myPlaceLocation: String(overrides.myPlaceLocation || '').trim(),
    hobbies: String(overrides.hobbies || '').trim(),
    dislikes: String(overrides.dislikes || '').trim(),
    persona: String(overrides.persona || overrides.bio || '').trim(),
    // 填了才用于「转发链接是不是本人发的」核对，默认不填就都当转发/分享处理。
    xiaohongshuId: String(overrides.xiaohongshuId || '').trim(),
    weiboId: String(overrides.weiboId || '').trim(),
    // 微博主页显示名；空则回落个人昵称。与 weiboId / nickname 互不绑定。
    weiboNickname: String(overrides.weiboNickname || '').trim(),
    // 微博主页展示（粉丝数 / 简介）；null = 未固定粉丝数
    weiboFans: overrides.weiboFans == null || overrides.weiboFans === ''
      ? null
      : (Number.isFinite(Number(overrides.weiboFans)) ? Math.max(0, Number(overrides.weiboFans)) : null),
    weiboBio: String(overrides.weiboBio || '').trim(),
    appearancePrompt: String(overrides.appearancePrompt || '').trim(),
    // 用户人物图专属画风；空 = 跟随全局默认
    imageStyleId: String(overrides.imageStyleId || '').trim().slice(0, 40),
    // 与角色 imageLock 同结构：none / prompt / seed / reference
    imageLock: normalizeImageLock(overrides.imageLock),
    // 当前 user 对应的主关系入口。动态数据仍由 userId 硬隔离；
    // 这里仅记录侧栏、通讯录等页面默认聚焦的主 char / 通讯录分组。
    identityBinding,
    // 全局角色卡是通用模板；绑定身份可在此保存稀疏覆写，不改模板本身。
    // 档位复制会随 user 记录带走这些覆写。
    characterOverrides: normalizeCharacterOverrides(overrides.characterOverrides),
    // 预设、壁纸与聊天首页背景素材仍是通用资源库；这里只保存当前身份选择的默认快照。
    // 新会话会继承，已有会话需由用户在「本身份装扮」里显式同步。
    identityAppearance: normalizeIdentityAppearance(overrides.identityAppearance),
    // 空值表示跟随当前聊天主题；旧档位已有的合法显式颜色继续保留。
    bubbleColor: /^#[0-9a-f]{6}$/i.test(String(overrides.bubbleColor || '').trim())
      ? String(overrides.bubbleColor).trim()
      : '',
    createdAt: Number(overrides.createdAt || now) || now,
    updatedAt: Number(overrides.updatedAt || now) || now,
  };
}

export function normalizeUserRecord(user = {}) {
  const base = createUser(user);
  const merged = { ...base, ...user, id: String(user.id || base.id) };
  const slotScopeId = String(merged.slotGroupId || merged.worldId || merged.id).trim() || merged.id;
  merged.slotGroupId = slotScopeId;
  merged.worldId = slotScopeId;
  merged.worldBackground = String(merged.worldBackground || '').trim().slice(0, 12000);
  // 历史档位的 name 占位是「我」，迁移成「用户」，避免注入时与角色第一人称撞车。
  if (isUnsetUserName(merged.name)) merged.name = FALLBACK_USER_NAME;
  merged.signature = String(merged.signature || '').trim();
  merged.statusText = String(merged.statusText || '').trim();
  merged.preferredCallName = String(merged.preferredCallName || merged.conversationName || '').trim();
  merged.gender = String(merged.gender || '').trim().slice(0, 24);
  merged.pronouns = String(merged.pronouns || '').trim().slice(0, 24);
  merged.signatureUpdatedAt = Number(merged.signatureUpdatedAt || 0) || 0;
  merged.statusUpdatedAt = Number(merged.statusUpdatedAt || 0) || 0;
  merged.imageStyleId = String(merged.imageStyleId || '').trim().slice(0, 40);
  merged.imageLock = normalizeImageLock(merged.imageLock);
  merged.identityBinding = normalizeIdentityBinding(merged.identityBinding);
  merged.characterOverrides = normalizeCharacterOverrides(merged.characterOverrides);
  merged.identityAppearance = normalizeIdentityAppearance(merged.identityAppearance);
  merged.avatar = upgradeMixedContentMediaUrl(merged.avatar || '') || String(merged.avatar || '');
  merged.videoAvatar = upgradeMixedContentMediaUrl(merged.videoAvatar || '') || String(merged.videoAvatar || '');
  merged.weiboId = String(merged.weiboId || '').trim();
  merged.weiboNickname = String(merged.weiboNickname || '').trim();
  merged.weiboBio = String(merged.weiboBio || '').trim();
  if (merged.weiboFans == null || merged.weiboFans === '') merged.weiboFans = null;
  else {
    const fans = Number(merged.weiboFans);
    merged.weiboFans = Number.isFinite(fans) ? Math.max(0, fans) : null;
  }
  return merged;
}

/** Fresh window: newly edited status can be noticed once; after this it is settled background. */
export const USER_STATUS_FRESH_MS = 12 * 60 * 60 * 1000;
/** Fresh window for signature; past this, treat as long-term profile flavor, not a talking point. */
export const USER_SIGNATURE_FRESH_MS = 2 * 24 * 60 * 60 * 1000;

export function isUserProfileFieldFresh(updatedAt = 0, freshMs = USER_STATUS_FRESH_MS, now = Date.now()) {
  const t = Number(updatedAt || 0) || 0;
  if (!t) return false;
  return (now - t) >= 0 && (now - t) < freshMs;
}

/**
 * Prompt lines for user signature / status with freshness.
 * Aged values stay as background but must not be repeatedly mentioned.
 */
export function formatUserSignatureStatusContextLines(user, {
  clean = (value) => String(value || '').replace(/\s+/g, ' ').trim(),
  signatureMax = 160,
  statusMax = 120,
  now = Date.now(),
} = {}) {
  if (!user) return [];
  const lines = [];
  const signature = clean(user.signature).slice(0, signatureMax);
  const status = clean(user.statusText).slice(0, statusMax);
  if (signature) {
    if (isUserProfileFieldFresh(user.signatureUpdatedAt, USER_SIGNATURE_FRESH_MS, now)) {
      lines.push(`签名：${signature}`);
    } else {
      lines.push(`签名（长期默认资料，不要主动反复提及）：${signature}`);
    }
  }
  if (status) {
    if (isUserProfileFieldFresh(user.statusUpdatedAt, USER_STATUS_FRESH_MS, now)) {
      lines.push(`状态：${status}`);
    } else {
      lines.push(`状态（已是默认背景，不要主动反复提及）：${status}`);
    }
  }
  return lines;
}

/** 档位级世界背景：同一 worldId 的身份共享，供主线聊天与线下叙事读取。 */
export function formatUserWorldBackgroundContext(user, {
  clean = (value) => String(value || '').trim(),
  maxLength = 6000,
} = {}) {
  const text = clean(user?.worldBackground || '');
  if (!text) return '';
  const limit = Math.max(200, Number(maxLength) || 6000);
  const clipped = text.length > limit ? `${text.slice(0, limit)}…` : text;
  return [
    '【当前档位故事背景 · 世界线共同前提】',
    clipped,
    '这是当前档位中已经成立的世界、人物处境与主线前提；后续内容必须与它兼容。它不等于用户人物设定，也不能把其中属于角色的身份、经历或关系写到用户身上。',
  ].join('\n');
}

export function getUserDisplayName(user) {
  const nickname = String(user?.nickname || '').trim();
  if (!isUnsetUserName(nickname)) return nickname;
  const name = String(user?.name || '').trim();
  if (!isUnsetUserName(name)) return name;
  return FALLBACK_USER_NAME;
}

/**
 * 角色对用户的现实称呼：用户明确推荐的称呼优先，其次姓名；展示昵称只作旧档兜底。
 * 匿名房、论坛、微博和马甲前台仍由各自身份模块单独解析，不能直接使用本函数穿透身份墙。
 */
export function getUserConversationName(user) {
  const preferred = String(user?.preferredCallName || user?.conversationName || '').trim();
  if (!isUnsetUserName(preferred)) return preferred;
  const name = String(user?.name || '').trim();
  if (!isUnsetUserName(name)) return name;
  const nickname = String(user?.nickname || '').trim();
  if (!isUnsetUserName(nickname)) return nickname;
  return FALLBACK_USER_NAME;
}

/** 微博主页 / 发帖显示名：只用 weiboNickname，空则回落个人昵称；不读写 weiboId。 */
export function getWeiboDisplayName(user) {
  const weiboNick = String(user?.weiboNickname || '').trim();
  if (!isUnsetUserName(weiboNick)) return weiboNick;
  return getUserDisplayName(user);
}

export function buildUserLocationLine(user, options = {}) {
  const virtual = String(user?.virtualCity || '').trim();
  const mapped = String(user?.realCityMap || '').trim();
  const weather = String(options.weatherLine || user?.weatherHint || '').trim();
  const parts = [];
  if (virtual) parts.push(`所在：${virtual}`);
  if (mapped && mapped !== virtual) parts.push(`映射现实城市：${mapped}`);
  if (weather) parts.push(`天气：${weather}`);
  return parts.join(' · ');
}
