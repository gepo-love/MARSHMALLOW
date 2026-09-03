import { normalizeCharacterPromptTags } from '../data/character-prompt-tags.js';
import { upgradeMixedContentMediaUrl } from '../core/media-url.js';

export const ROLE_TIERS = [
  { id: 'main', label: '主陪伴', hint: '长期私聊、深度互动' },
  { id: 'supporting', label: '常驻角色', hint: '群像常驻、可私聊，不是路人' },
  { id: 'npc', label: 'NPC', hint: '群聊、社交、偶尔出场' },
  { id: 'background', label: '背景', hint: '关系网提及、不常发言' },
];

export function normalizeRoleTier(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'main' || v === 'supporting' || v === 'npc' || v === 'background') return v;
  if (v === 'primary') return 'main';
  if (v === 'support' || v === 'secondary') return 'supporting';
  return 'npc';
}

export function createEmptyLifeProfile() {
  return {
    homeDetails: '',
    familyThreads: '',
    socialAnchors: '',
    habits: '',
    activitySeeds: '',
  };
}

export function createEmptyResidenceAnchor() {
  return {
    city: '',
    realCityMap: '',
    weatherHint: '',
    area: '',
    label: '',
    mapQuery: '',
    note: '',
  };
}

/**
 * 外语/方言翻译：
 * - 'full'：角色在聊天/语音/心声里主要讲外语（language 留空则由 AI 按人设自行判断语种），
 *   AI 输出整句外语正文 + 一个中文翻译字段，气泡上折叠展示。
 * - 'mixed'：角色日常讲中文，偶尔蹦几句外语或方言词（dialectNote 描述蹦的是什么，可留空由 AI 判断），
 *   正文照常写（该中文中文、蹦词直接写原文），只在这条真出现非中文时才额外加中文翻译字段；
 *   聊天气泡上和 'full' 用同一套折叠展示；叙事类大段正文（线下时光机/旅行 char）里用〔〕就地标记，
 *   渲染时转成「译」按钮 + 可展开译文，同样默认收起。
 * 两种模式都在同一次生成里顺带给出，不额外调用翻译 API。
 * - forceForeignInVoice：与 mode 独立的开关。日常文字仍按 mode 走（可以是 'off'/'mixed'），
 *   但通话/视频通话/语音条/直播间台词这类会被朗读出声的场景一律强制整句外语（同上 language）+ 中文翻译，
 *   朗读只读外语，中文仅供前台点按查看。mode='full' 时本身已覆盖语音场景，这个开关是多余的。
 */
export function createEmptyTranslationProfile() {
  return {
    mode: 'off',
    language: '',
    dialectNote: '',
    forceForeignInVoice: false,
  };
}

const TRANSLATION_PROFILE_MODES = ['off', 'full', 'mixed'];

export function normalizeTranslationProfile(value) {
  const base = createEmptyTranslationProfile();
  if (!value || typeof value !== 'object') return base;
  let mode = String(value.mode || '').trim();
  if (!TRANSLATION_PROFILE_MODES.includes(mode)) {
    // 兼容旧版 { enabled: boolean } 数据
    mode = value.enabled ? 'full' : 'off';
  }
  return {
    mode,
    language: String(value.language || '').trim(),
    dialectNote: String(value.dialectNote || '').trim(),
    forceForeignInVoice: value.forceForeignInVoice === true,
  };
}

export function isTranslationProfileActive(profile) {
  const mode = normalizeTranslationProfile(profile).mode;
  return mode === 'full' || mode === 'mixed';
}

/** 语音场景（通话/视频通话/语音条/直播间台词）是否要强制整句外语 + 翻译：mode='full' 或单独开了 forceForeignInVoice 都算。 */
export function resolveVoiceTranslationProfile(profile) {
  const tp = normalizeTranslationProfile(profile);
  return {
    active: tp.mode === 'full' || tp.forceForeignInVoice,
    language: tp.language,
  };
}

export function createEmptyLocationProfile() {
  return {
    mode: 'semi',
    mapEnabled: true,
    city: { name: '', adcode: '', center: null },
    region: '',
    anchors: [],
    lifestyle: { identity: '', incomeTier: '', commute: '', hobbies: [], radiusKm: 0 },
  };
}

/** 商业版不存储、不展示的旧版 IP / 赛季字段（导入时也会剥离） */
export const COMMERCIAL_LEGACY_FIELD_KEYS = [
  'timelineStates',
  'team',
  'accountCard',
  'className',
  'sourceIp',
  'ipGroup',
  'debutSeason',
  'anonymousRoleTier',
  'roleTierHint',
];

export function stripCommercialLegacyFields(record) {
  if (!record || typeof record !== 'object') return record;
  const next = { ...record };
  for (let i = 0; i < COMMERCIAL_LEGACY_FIELD_KEYS.length; i += 1) {
    delete next[COMMERCIAL_LEGACY_FIELD_KEYS[i]];
  }
  return next;
}

export function normalizeDialNumber(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 12);
}

export function isInternalAnonymousCharacterId(id = '') {
  return /^anon_npc_/i.test(String(id || '').trim());
}

/**
 * 匿名 NPC（路人马甲）判定。注意：这类角色保存时用普通随机 id，
 * 真正的标记是 groupId === 'anon_npc'（见 core/anonymous-npc.js）。
 * 这里用字面量避免与 anonymous-npc.js 形成循环依赖。
 */
export function isAnonymousNpcRecord(record = {}) {
  if (!record) return false;
  if (isInternalAnonymousCharacterId(record.id)) return true;
  return String(record.groupId || '').trim() === 'anon_npc';
}

// 用于 saveCharacter 的保存校验：仅拦 anon_npc_ 前缀的内置匿名占位，
// 不拦 groupId 路人 NPC（它们需要正常落库）。
export function isPublicContactCharacter(record = {}) {
  return !!record && !isInternalAnonymousCharacterId(record.id);
}

/**
 * 初遇草稿：角色已建档但还没正式「认识」——要先线下相遇一场，
 * 收纳后才写入通讯录。在此之前不出现在通讯录与各种角色选择列表里。
 */
export const ENCOUNTER_PENDING_GROUP_ID = 'encounter_pending';

export function isEncounterPendingCharacter(record = {}) {
  return !!record && String(record.groupId || '').trim() === ENCOUNTER_PENDING_GROUP_ID;
}

// 用于「用户可选角色列表」：在公开联系人基础上，再排除路人 NPC 马甲与初遇草稿。
export function isSelectableContactCharacter(record = {}) {
  return isPublicContactCharacter(record) && !isAnonymousNpcRecord(record) && !isEncounterPendingCharacter(record);
}

export function normalizeShowcaseImages(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (!raw) continue;
    const url = upgradeMixedContentMediaUrl(
      typeof raw === 'string' ? raw : String(raw.url || raw.dataUrl || raw.src || ''),
    );
    if (!url) continue;
    out.push({
      id: (raw && raw.id) ? String(raw.id) : `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      url,
      caption: raw && raw.caption ? String(raw.caption).trim().slice(0, 60) : '',
      seed: raw && raw.seed != null ? String(raw.seed).replace(/\D/g, '').slice(0, 10) : '',
    });
    if (out.length >= 12) break;
  }
  return out;
}

/** 名片展示页（用户自己装修，独立于 AI 填表字段）：个性签名 / 关于我 / 联络方式 */
export function normalizeProfileCardContacts(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (!raw) continue;
    const label = String(raw.label || '').trim().slice(0, 24);
    const value = String(raw.value || '').trim().slice(0, 80);
    if (!label && !value) continue;
    out.push({ label, value });
    if (out.length >= 8) break;
  }
  return out;
}

export function normalizeProfileCard(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    signature: String(src.signature || '').trim().slice(0, 140),
    about: String(src.about || '').trim().slice(0, 2000),
    contacts: normalizeProfileCardContacts(src.contacts),
  };
}

/** 生图锁定支持的档位：不锁 / 提示词锁 / NovelAI seed 锁 / 参考图锁（NAI Vibe Transfer 或 gpt-image 编辑） */
export const IMAGE_LOCK_MODES = ['none', 'prompt', 'seed', 'reference'];

/** NovelAI seed 上限（uint32），避免用户手填超范围数值传给接口报错 */
const NOVELAI_MAX_SEED = 4294967295;

/** 生图锁定（锁 seed / 锁人设 / 锁参考图）：none=不锁，prompt=提示词锁，seed=NovelAI seed 锁，reference=参考图锁 */
export function normalizeImageLock(input) {
  const src = input && typeof input === 'object' ? input : {};
  let mode = String(src.mode || 'none').trim();
  if (!IMAGE_LOCK_MODES.includes(mode)) mode = 'none';
  const seedDigits = String(src.seed ?? '').replace(/\D/g, '').slice(0, 10);
  const seedNum = seedDigits ? Math.min(Number(seedDigits), NOVELAI_MAX_SEED) : '';
  return {
    mode,
    seed: seedNum === '' ? '' : String(seedNum),
    prompt: String(src.prompt || '').trim().slice(0, 600),
    // 参考图来源：'avatar' 用当前头像；也可以是 showcaseImages 里某张图的 id（旧字段，已被 refImageUrl 取代但保留兼容）
    baseImageId: String(src.baseImageId || '').trim(),
    // 专属锁定参考图（上传或从「生成预览」结果里选定），不设置时才回落到当前头像；
    // 头像可能会换、也可能被设成别的东西，专属参考图更准更稳定
    refImageUrl: upgradeMixedContentMediaUrl(String(src.refImageUrl || '').trim()),
  };
}

function normalizeVoiceProfileDefaults(src = {}) {
  const raw = src && typeof src === 'object' && !Array.isArray(src) ? src : {};
  const providerValue = Object.prototype.hasOwnProperty.call(raw, 'provider')
    ? raw.provider
    : (raw.voiceProvider || raw.voice_provider || '');
  const rawProvider = String(providerValue || '').trim().toLowerCase();
  const provider = ['minimax', 'fish'].includes(rawProvider) ? rawProvider : '';
  const videoBackground = upgradeMixedContentMediaUrl(
    String(raw.videoBackground || raw.video_background || '').trim(),
  );
  const next = {
    ...raw,
    ...(provider ? { provider } : {}),
    ...(videoBackground ? { videoBackground, video_background: videoBackground } : {}),
  };
  if (raw.enabled === true || raw.enabled === false) return next;
  const voiceId = String(raw.voiceId || raw.voice_id || '').trim();
  const fishReferenceId = String(raw.fishReferenceId || raw.fish_reference_id || '').trim();
  if (voiceId || fishReferenceId) return next;
  return { enabled: false, ...next };
}

function normalizeAnonymousLifecycle(src = {}) {
  const raw = src && typeof src === 'object' ? src : {};
  const phase = ['temporary', 'private', 'revealed'].includes(String(raw.phase || '').trim())
    ? String(raw.phase).trim()
    : '';
  return {
    phase,
    sourceChatIds: Array.isArray(raw.sourceChatIds)
      ? [...new Set(raw.sourceChatIds.map((id) => String(id || '').trim()).filter(Boolean))].slice(-20)
      : [],
    retained: raw.retained === true,
    revealStatus: ['none', 'pending', 'accepted', 'declined'].includes(String(raw.revealStatus || '').trim())
      ? String(raw.revealStatus).trim()
      : 'none',
    revealedAt: Number(raw.revealedAt || 0) || 0,
  };
}

// 旧字段只用于“当前字段尚不存在”的存量数据迁移。编辑页会显式提交空字符串；
// 此时若继续用 `current || legacy`，用户刚清空的人设会被旧字段悄悄复活，
// 并再次进入 AI 补全提示词。
function readCanonicalOrLegacy(record = {}, canonicalKey = '', legacyKeys = []) {
  if (Object.prototype.hasOwnProperty.call(record, canonicalKey)) return record[canonicalKey];
  for (const key of legacyKeys) {
    if (record[key]) return record[key];
  }
  return '';
}

function normalizeForumIdentity(src = {}) {
  const raw = src && typeof src === 'object' ? src : {};
  const kind = ['passerby', 'character'].includes(String(raw.kind || '').trim())
    ? String(raw.kind).trim()
    : '';
  return {
    kind,
    userId: String(raw.userId || '').trim().slice(0, 160),
    displayName: String(raw.displayName || '').trim().slice(0, 80),
    signature: String(raw.signature || '').trim().slice(0, 180),
    createdAt: Number(raw.createdAt || 0) || 0,
  };
}

function normalizeAnonymousPrivateDraft(src = {}) {
  const raw = src && typeof src === 'object' ? src : {};
  return {
    realName: String(raw.realName || '').trim().slice(0, 40),
    currentRole: String(raw.currentRole || '').trim().slice(0, 80),
    background: String(raw.background || '').trim().slice(0, 500),
    interests: Array.isArray(raw.interests)
      ? raw.interests.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [],
    gender: String(raw.gender || '').trim().slice(0, 16),
    revealNote: String(raw.revealNote || '').trim().slice(0, 160),
  };
}

export function createCharacterProfile(overrides = {}) {
  const now = Date.now();
  const roleTier = normalizeRoleTier(
    overrides.roleTier || overrides.anonymousRoleTier || overrides.roleTierHint,
  );
  const hasPromptTags = Object.prototype.hasOwnProperty.call(overrides, 'promptTags');
  const hasArchetypeTags = Object.prototype.hasOwnProperty.call(overrides, 'archetypeTags');
  const promptTags = hasPromptTags
    ? normalizeCharacterPromptTags(overrides.promptTags)
    : (hasArchetypeTags ? normalizeCharacterPromptTags(overrides.archetypeTags) : []);
  return stripCommercialLegacyFields({
    id: overrides.id || `char_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: String(readCanonicalOrLegacy(overrides, 'name', [
      'remarkName',
      'displayName',
      'char_name',
      'customNickname',
    ]) || '').trim(),
    realName: String(overrides.realName || '').trim(),
    aliases: Array.isArray(overrides.aliases)
      ? overrides.aliases.map((a) => String(a || '').trim()).filter(Boolean)
      : [],
    avatar: (() => {
      const raw = overrides.avatar || null;
      if (typeof raw !== 'string') return raw;
      return upgradeMixedContentMediaUrl(raw) || raw;
    })(),
    showcaseImages: normalizeShowcaseImages(overrides.showcaseImages),
    card: normalizeProfileCard(overrides.card),
    imageLock: normalizeImageLock(overrides.imageLock),
    defaultEmoji: overrides.defaultEmoji || '🍥',
    roleTier,
    groupId: String(overrides.groupId || 'default').trim() || 'default',
    anonymousLifecycle: normalizeAnonymousLifecycle(overrides.anonymousLifecycle),
    anonymousPrivateDraft: normalizeAnonymousPrivateDraft(overrides.anonymousPrivateDraft),
    forumIdentity: normalizeForumIdentity(overrides.forumIdentity),
    // 旧版隐藏昵称只参与旧档迁移，不再作为第二套展示名保留。
    // 否则用户编辑当前可见的“备注名”后，仍有页面会被旧值覆盖。
    customNickname: '',
    dialNumber: normalizeDialNumber(overrides.dialNumber),
    birthDate: String(overrides.birthDate || '').trim(),
    gender: String(overrides.gender || '').trim().slice(0, 24),
    pronouns: String(overrides.pronouns || '').trim().slice(0, 24),
    notes: String(overrides.notes || '').trim(),
    appearancePrompt: String(readCanonicalOrLegacy(overrides, 'appearancePrompt', [
      'imagePrompt',
      'characterImagePrompt',
    ]) || '').trim(),
    // 角色专属画风：image-style-presets.js 预设 id；空 = 跟随全局默认
    imageStyleId: String(overrides.imageStyleId || '').trim().slice(0, 40),
    personality: String(overrides.personality || '').trim(),
    speechStyle: String(overrides.speechStyle || '').trim(),
    bubbleColor: String(overrides.bubbleColor || '').trim(),
    commonEmotes: String(readCanonicalOrLegacy(overrides, 'commonEmotes', ['favoriteEmotes']) || '').trim(),
    boundStickerPackIds: [
      ...new Set([
        ...(Array.isArray(overrides.boundStickerPackIds)
          ? overrides.boundStickerPackIds.map((id) => String(id || '').trim()).filter(Boolean)
          : []),
        ...(String(overrides.boundStickerPackId || '').trim()
          ? [String(overrides.boundStickerPackId || '').trim()]
          : []),
      ]),
    ],
    // 角色级微博偏好：默认允许；显式关闭时，发帖和评论都不使用本地表情包。
    weiboAllowStickers: overrides.weiboAllowStickers !== false,
    promptTags,
    promptCorpus: String(overrides.promptCorpus || '').trim(),
    speechCorpus: String(readCanonicalOrLegacy(overrides, 'speechCorpus', [
      'corpus',
      'roleplayCorpus',
    ]) || '').trim(),
    userRelationStatus: String(readCanonicalOrLegacy(overrides, 'userRelationStatus', [
      'userRelationship',
      'relationshipWithUser',
      'relationWithUser',
    ]) || '').trim(),
    relationships: overrides.relationships && typeof overrides.relationships === 'object'
      ? { ...overrides.relationships }
      : {},
    lifeProfile: {
      ...createEmptyLifeProfile(),
      ...(overrides.lifeProfile && typeof overrides.lifeProfile === 'object' ? overrides.lifeProfile : {}),
    },
    residenceAnchor: {
      ...createEmptyResidenceAnchor(),
      ...(overrides.residenceAnchor && typeof overrides.residenceAnchor === 'object'
        ? overrides.residenceAnchor
        : {}),
    },
    locationProfile: {
      ...createEmptyLocationProfile(),
      ...(overrides.locationProfile && typeof overrides.locationProfile === 'object'
        ? overrides.locationProfile
        : {}),
    },
    currentRole: String(readCanonicalOrLegacy(overrides, 'currentRole', ['role']) || '').trim(),
    currentStatus: String(readCanonicalOrLegacy(overrides, 'currentStatus', ['status']) || '').trim(),
    voiceProfile: normalizeVoiceProfileDefaults(overrides.voiceProfile),
    translationProfile: normalizeTranslationProfile(overrides.translationProfile),
    isCustom: overrides.isCustom !== false,
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
  });
}

export function getRoleTierLabel(roleTier) {
  const hit = ROLE_TIERS.find((t) => t.id === roleTier);
  return hit ? hit.label : '角色';
}

/** 进 AI 提示词用的角色称呼：真名优先，不含通讯录昵称/会话备注 */
export function getCharacterAiContextName(character, fallbackId = '') {
  if (!character || typeof character !== 'object') {
    return String(fallbackId || '').trim() || '对方';
  }
  const id = String(character.id || fallbackId || '').trim();
  return String(character.realName || character.name || id).trim() || id || '对方';
}

export function resolveCharacterAiContextName(id, characters = {}) {
  const pid = String(id || '').trim();
  if (!pid || pid === 'user') return '用户';
  if (pid === 'system') return '系统';
  return getCharacterAiContextName(characters[pid], pid);
}
