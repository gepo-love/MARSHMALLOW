export const MEMORY_FACT_SCOPES = {
  normal_chat: 'normal_chat',
  anonymous_room: 'anonymous_room',
  anonymous_private: 'anonymous_private',
  confession_case: 'confession_case',
  account_alias: 'account_alias',
};

export const MEMORY_FACT_TYPES = {
  group_meme: '群梗',
  relationship_impression: '关系印象',
  preference: '偏好/习惯',
  secret: '秘密',
  promise: '约定',
  topic_affinity: '话题倾向',
  boundary: '边界',
  status: '状态',
  character_evolution_signal: '角色演化信号',
  alias_awareness: '马甲知情',
  alias_window_digest: '马甲窗口摘要',
};

const MEMORY_FACT_TYPE_ALIASES = Object.freeze({
  群梗: 'group_meme',
  关系印象: 'relationship_impression',
  关系: 'relationship_impression',
  印象: 'relationship_impression',
  偏好: 'preference',
  习惯: 'preference',
  '偏好/习惯': 'preference',
  '喜好/习惯': 'preference',
  喜好: 'preference',
  秘密: 'secret',
  私密: 'secret',
  约定: 'promise',
  承诺: 'promise',
  待办: 'promise',
  话题倾向: 'topic_affinity',
  兴趣倾向: 'topic_affinity',
  边界: 'boundary',
  禁区: 'boundary',
  状态: 'status',
  角色演化信号: 'character_evolution_signal',
  人物演化: 'character_evolution_signal',
  长期变化: 'character_evolution_signal',
  马甲知情: 'alias_awareness',
  马甲窗口摘要: 'alias_window_digest',
});

export function normalizeMemoryFactType(raw) {
  const value = String(raw || '').trim();
  if (!value) return 'status';
  if (Object.prototype.hasOwnProperty.call(MEMORY_FACT_TYPES, value)) return value;
  return MEMORY_FACT_TYPE_ALIASES[value] || value;
}

/**
 * 记忆/事件/日程/地图统一时间状态规范（见 docs/temporal-memory-plan.md）：
 * - planned：未来约定，还没发生
 * - ongoing：进行时，还没收尾，可以继续推进
 * - completed：已发生/已结束，只能当背景引用
 * - evergreen：常态化事实（偏好/关系印象/秘密等），不参与过期判断
 */
export const MEMORY_FACT_TEMPORAL_STATES = {
  planned: 'planned',
  ongoing: 'ongoing',
  completed: 'completed',
  evergreen: 'evergreen',
};

const TEMPORAL_STATE_SET = new Set(Object.values(MEMORY_FACT_TEMPORAL_STATES));

export const MEMORY_FACT_CONTENT_MAX_LENGTH = 420;

function semanticCutIndex(text, maxLength) {
  const floor = Math.max(1, Math.floor(maxLength * 0.45));
  const window = text.slice(0, maxLength);
  const boundaryGroups = [
    /[\r\n]+/g,
    /[。！？!?；;]/g,
    /[，,、：:]/g,
    /\s+/g,
  ];
  for (const re of boundaryGroups) {
    let match;
    let last = null;
    while ((match = re.exec(window)) !== null) last = match;
    if (last && last.index >= floor) {
      return last.index + last[0].length;
    }
  }
  return maxLength;
}

/**
 * 长事实优先按段落、句子、分句边界拆开；只有找不到合适语义边界时才硬切。
 * 每段独立落库，避免模型协议、手动输入或其它调用方在 420 字处静默丢失尾部。
 */
export function splitMemoryFactContent(value, maxLength = MEMORY_FACT_CONTENT_MAX_LENGTH) {
  const limit = Math.max(1, Math.floor(Number(maxLength) || MEMORY_FACT_CONTENT_MAX_LENGTH));
  let rest = String(value || '').trim();
  if (!rest) return [];
  const parts = [];
  while (rest.length > limit) {
    const cut = semanticCutIndex(rest, limit);
    const part = rest.slice(0, cut).trim();
    if (part) parts.push(part);
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// factType 大多是"关于这个人/关系的持续性认知"，天然常态化；只有 promise/status 这种
// "有没有收尾"是关键信息的类型才默认按 ongoing 处理、需要时效判断。
const DEFAULT_TEMPORAL_STATE_BY_FACT_TYPE = {
  promise: 'ongoing',
  status: 'ongoing',
  preference: 'evergreen',
  relationship_impression: 'evergreen',
  secret: 'evergreen',
  topic_affinity: 'evergreen',
  boundary: 'evergreen',
  group_meme: 'evergreen',
  character_evolution_signal: 'evergreen',
};

export function normalizeTemporalState(raw) {
  const val = String(raw || '').trim();
  return TEMPORAL_STATE_SET.has(val) ? val : '';
}

export function normalizeMemoryFactCanonicalKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:'"“”‘’（）()[\]{}<>《》【】\s]/g, '')
    .slice(0, 120);
}

export function defaultTemporalStateForFactType(factType) {
  return DEFAULT_TEMPORAL_STATE_BY_FACT_TYPE[normalizeMemoryFactType(factType)] || 'evergreen';
}

/**
 * 只有 ongoing 且带 expiresAt 的事实（典型是「约定」）才参与过期判断：
 * 过期还没被后续对话确认完成的，视为「自然不了了之」，读取时降级为 completed。
 * 不直接改写落库记录——避免和别处的并发写打架，由调用方决定要不要顺手回写。
 */
export function resolveEffectiveTemporalState(fact, now = Date.now()) {
  // Moments posts are finished events; heal legacy status→ongoing rows.
  if (String(fact?.scope || '').trim() === 'public_feed'
    || String(fact?.id || '').startsWith('mf_moment_')
    || String(fact?.evidence || '').includes('朋友圈')
    || (Array.isArray(fact?.tags) && fact.tags.includes('朋友圈'))) {
    return 'completed';
  }
  const state = normalizeTemporalState(fact?.temporalState) || defaultTemporalStateForFactType(fact?.factType);
  if (['ongoing', 'planned'].includes(state)
    && Number(fact?.expiresAt || 0) > 0
    && Number(fact.expiresAt) < Number(now)) {
    return 'completed';
  }
  const sourceTime = Number(fact?.updatedAt || fact?.createdAt || fact?.timestamp || 0);
  const text = String(fact?.content || '');
  const match = text.match(/(?:(20\d{2})\s*[年\/-]\s*)?(1[0-2]|0?[1-9])\s*[月\/-]\s*(3[01]|[12]\d|0?[1-9])\s*(?:日|号)?/u);
  if (match && ['ongoing', 'planned'].includes(state)
    && ['promise', 'status'].includes(normalizeMemoryFactType(fact?.factType))
    && (state === 'planned' || /(?:将于|将在|计划|预计|预定|定于|届时|正式入职|报到|到岗)/u.test(text))) {
    const sourceDate = new Date(sourceTime || Date.now());
    let year = Number(match[1] || sourceDate.getFullYear());
    const month = Number(match[2]);
    const day = Number(match[3]);
    const dayStart = (timestamp) => {
      const date = new Date(Number(timestamp || Date.now()));
      return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    };
    let target = new Date(year, month - 1, day).getTime();
    if (!match[1] && sourceTime && target < dayStart(sourceTime) - 180 * 24 * 60 * 60 * 1000) {
      year += 1;
      target = new Date(year, month - 1, day).getTime();
    }
    const parsed = new Date(target);
    if (parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
      && dayStart(now) > dayStart(target)) return 'completed';
  }
  if (state === 'ongoing'
    && ['promise', 'status'].includes(normalizeMemoryFactType(fact?.factType))
    && /(?:今天|今日|今早|今晚|今夜)/u.test(String(fact?.content || ''))
    && sourceTime > 0) {
    const sourceDate = new Date(sourceTime);
    const currentDate = new Date(Number(now || Date.now()));
    if (sourceDate.getFullYear() !== currentDate.getFullYear()
      || sourceDate.getMonth() !== currentDate.getMonth()
      || sourceDate.getDate() !== currentDate.getDate()) return 'completed';
  }
  return state;
}

export function createMemoryFact(payload = {}) {
  const now = Date.now();
  const id = String(payload.id || '').trim() || `mf_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const confidenceRaw = Number(payload.confidence ?? 0.75);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.75;
  const factType = normalizeMemoryFactType(payload.factType || 'status');
  return {
    id,
    userId: String(payload.userId || '').trim(),
    chatId: String(payload.chatId || '').trim(),
    sourceChatId: String(payload.sourceChatId || '').trim(),
    scope: String(payload.scope || MEMORY_FACT_SCOPES.normal_chat).trim(),
    subjectId: String(payload.subjectId || '').trim(),
    subjectName: String(payload.subjectName || '').trim().slice(0, 80),
    objectId: String(payload.objectId || '').trim(),
    objectName: String(payload.objectName || '').trim().slice(0, 80),
    factType,
    canonicalKey: normalizeMemoryFactCanonicalKey(payload.canonicalKey || payload.memoryKey),
    content: String(payload.content || '').trim().slice(0, MEMORY_FACT_CONTENT_MAX_LENGTH),
    evidence: String(payload.evidence || '').trim().slice(0, 240),
    confidence,
    visibility: String(payload.visibility || 'private').trim(),
    knownBy: payload.knownBy && typeof payload.knownBy === 'object' ? payload.knownBy : {},
    anonymousRoomId: String(payload.anonymousRoomId || '').trim(),
    principalType: String(payload.principalType || '').trim(),
    principalId: String(payload.principalId || '').trim(),
    accountId: String(payload.accountId || '').trim(),
    awareCharacterId: String(payload.awareCharacterId || '').trim(),
    awarenessLevel: String(payload.awarenessLevel || '').trim(),
    provenance: payload.provenance && typeof payload.provenance === 'object'
      ? {
        source: String(payload.provenance.source || '').trim(),
        sourceChatId: String(payload.provenance.sourceChatId || '').trim(),
        note: String(payload.provenance.note || '').trim().slice(0, 240),
      }
      : null,
    ownerId: String(payload.ownerId || '').trim(),
    windowLabel: String(payload.windowLabel || '').trim().slice(0, 40),
    digest: String(payload.digest || '').trim().slice(0, 600),
    revealState: String(payload.revealState || '').trim(),
    linkedPrincipalKeys: Array.isArray(payload.linkedPrincipalKeys)
      ? [...new Set(payload.linkedPrincipalKeys.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 8)
      : [],
    tags: Array.isArray(payload.tags) ? payload.tags.filter(Boolean).slice(0, 12) : [],
    sourceMessageIds: Array.isArray(payload.sourceMessageIds) ? payload.sourceMessageIds.filter(Boolean).slice(0, 20) : [],
    extractionSourceKeys: Array.isArray(payload.extractionSourceKeys)
      ? [...new Set(payload.extractionSourceKeys
        .map((value) => String(value || '').trim())
        .filter(Boolean))].slice(0, 12)
      : [],
    evidenceTimestamps: Array.isArray(payload.evidenceTimestamps)
      ? [...new Set(payload.evidenceTimestamps
        .map((value) => Number(value) || 0)
        .filter((value) => value > 0))].sort((a, b) => a - b).slice(-20)
      : [],
    evolutionEvidence: Array.isArray(payload.evolutionEvidence)
      ? payload.evolutionEvidence
        .map((item) => ({
          sourceKey: String(item?.sourceKey || '').trim().slice(0, 240),
          at: Number(item?.at || 0) || 0,
        }))
        .filter((item) => item.sourceKey && item.at > 0)
        .slice(-20)
      : [],
    temporalState: normalizeTemporalState(payload.temporalState) || defaultTemporalStateForFactType(factType),
    expiresAt: Number(payload.expiresAt || 0) || 0,
    createdAt: Number(payload.createdAt || now) || now,
    updatedAt: Number(payload.updatedAt || now) || now,
  };
}

/**
 * 记忆馆展示的是事实首次形成的时间，不是最后一次改字的时间。
 * timestamp 兼容早期记录；updatedAt 只作为没有原始时间字段时的最终兜底。
 */
export function memoryFactDisplayTimestamp(fact = {}) {
  return Number(fact.createdAt || fact.timestamp || fact.updatedAt || 0) || 0;
}
