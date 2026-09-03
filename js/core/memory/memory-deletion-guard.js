import * as db from '../db.js';

const KEY_PREFIX = 'deletedMemorySemantics_';
const MAX_TOMBSTONES = 180;
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const DELETED_MEMORY_SIMILARITY_THRESHOLD = 0.62;
const SEMANTIC_CONCEPTS = [
  ['alias', /马甲|小号|另一个?账号|匿名账号|假身份/u],
  ['secret', /偷偷|暗中|私下|隐瞒|秘密|不让.+知道/u],
  ['probe', /试探|测试|确认|探口风|旁敲侧击/u],
  // 不用负向 lookbehind：Safari < 16.4 会在加载本模块时直接 parseModule 失败。
  // 这里只做布尔概念命中，(?:^|[^不]) 与原「喜欢前一字不是不」语义等价。
  ['affection', /(?:^|[^不])喜欢|爱意|感情|心意|暗恋|在乎/u],
  ['dislike', /不喜欢|讨厌|反感|排斥|不能接受/u],
  ['promise', /答应|约定|承诺|说好/u],
  ['conflict', /吵架|争执|冲突|冷战|闹矛盾/u],
  ['gift', /礼物|赠送|送给|纪念品/u],
  ['meeting', /见面|相遇|碰面|约会/u],
  ['offline', /线下|现实中|当面|面对面/u],
  ['travel', /旅行|旅游|出游|度假/u],
  ['family', /家人|父母|爸爸|妈妈|兄弟|姐妹/u],
  ['work', /工作|上班|公司|同事|加班/u],
  ['school', /学校|上课|老师|同学|考试/u],
  ['health', /生病|身体|健康|医院|吃药|受伤/u],
];

function cleanText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 1000);
}

function memoryText(row = {}) {
  return [
    row.content,
    row.summary,
    row.digest,
    row.title,
    row.evidence,
  ].filter(Boolean).join(' ');
}

function ngrams(text, size = 2) {
  const normalized = cleanText(text)
    .replace(/用户|角色|对方|自己|曾经|已经|记得|这件事|不喜欢|喜欢|讨厌|觉得|认为|发生过/gu, '');
  if (!normalized) return new Set();
  if (normalized.length <= size) return new Set([normalized]);
  const out = new Set();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    out.add(normalized.slice(index, index + size));
  }
  return out;
}

function semanticConcepts(text = '') {
  const raw = String(text || '').toLowerCase();
  return new Set(SEMANTIC_CONCEPTS
    .filter(([, pattern]) => pattern.test(raw))
    .map(([key]) => key));
}

export function deletedMemorySimilarity(left = '', right = '') {
  const a = cleanText(left);
  const b = cleanText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a))) return 0.92;
  const aa = ngrams(a);
  const bb = ngrams(b);
  let overlap = 0;
  for (const gram of aa) {
    if (bb.has(gram)) overlap += 1;
  }
  const lexical = (2 * overlap) / Math.max(1, aa.size + bb.size);
  const leftConcepts = semanticConcepts(left);
  const rightConcepts = semanticConcepts(right);
  let conceptOverlap = 0;
  for (const key of leftConcepts) {
    if (rightConcepts.has(key)) conceptOverlap += 1;
  }
  const conceptScore = conceptOverlap >= 2
    ? 0.48 + Math.min(0.42, (conceptOverlap - 2) * 0.14)
    : 0;
  return Math.max(lexical, conceptScore);
}

function entityKeys(row = {}) {
  const out = new Set();
  [
    row.characterId,
    row.subjectId,
    row.objectId,
    row.principalId,
    row.ownerId,
    ...(Array.isArray(row.characterIds) ? row.characterIds : []),
    ...Object.keys(row.knownBy || {}),
  ].forEach((value) => {
    const key = String(value || '').trim();
    if (key && key !== 'user' && key !== 'system') out.add(key);
  });
  return [...out].sort();
}

function isManualWrite(row = {}) {
  const source = String(row.source || row.evidence || '').toLowerCase();
  const tags = Array.isArray(row.tags) ? row.tags.map((tag) => String(tag).toLowerCase()) : [];
  return source.includes('manual') || source.includes('手动') || tags.includes('manual');
}

function scopesOverlap(left = [], right = []) {
  if (!left.length || !right.length) return true;
  const rightSet = new Set(right);
  return left.some((key) => rightSet.has(key));
}

async function loadTombstones(userId = '') {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const row = await db.getRecord('settings', `${KEY_PREFIX}${uid}`).catch(() => null);
  const now = Date.now();
  return (Array.isArray(row?.value) ? row.value : [])
    .filter((item) => item?.text && now - Number(item.deletedAt || 0) <= MAX_AGE_MS)
    .slice(-MAX_TOMBSTONES);
}

export async function buildDeletedMemoryGuardBlock({
  userId = '',
  characterIds = [],
  limit = 8,
} = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return '';
  const wanted = new Set((Array.isArray(characterIds) ? characterIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  const rows = (await loadTombstones(uid))
    .filter((item) => !wanted.size || !item.entityKeys?.length
      || item.entityKeys.some((key) => wanted.has(String(key || '').trim())))
    .slice(-Math.max(1, Math.min(12, Number(limit) || 8)));
  if (!rows.length) return '';
  return [
    '【用户已删除的记忆·硬边界】',
    '以下内容是用户明确要求遗忘的旧记录。不得把它们作为已知事实使用、暗示、续写，也不得换一种说法重新输出 memory_fact 或摘要；只有用户今后明确重新告知时才能重新记录。',
    ...rows.map((item) => `- ${String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 260)}`),
  ].join('\n');
}

export async function recordDeletedMemoryTombstone(store, row = {}) {
  const userId = String(row.userId || '').trim();
  const text = memoryText(row);
  if (!userId || !cleanText(text)) return false;
  const key = `${KEY_PREFIX}${userId}`;
  const list = await loadTombstones(userId);
  list.push({
    id: String(row.id || '').trim(),
    store: String(store || '').trim(),
    factType: String(row.factType || row.type || row.category || '').trim(),
    text: String(text).slice(0, 1200),
    entityKeys: entityKeys(row),
    deletedAt: Date.now(),
  });
  await db.putRecord('settings', {
    key,
    value: list.slice(-MAX_TOMBSTONES),
    updatedAt: Date.now(),
  });
  return true;
}

export async function shouldSuppressDeletedMemory(store, row = {}) {
  const userId = String(row.userId || '').trim();
  if (!userId || isManualWrite(row)) return false;
  const text = memoryText(row);
  if (!cleanText(text)) return false;
  const keys = entityKeys(row);
  const tombstones = await loadTombstones(userId);
  return tombstones.some((item) => (
    scopesOverlap(keys, Array.isArray(item.entityKeys) ? item.entityKeys : [])
    // 0.48 只代表同时命中两个宽泛概念（例如“工作”和“约定”）。摘要通常很长，
    // 很容易仅因主题相同而误杀整段新记忆；提高门槛后仍会拦截原文、近似改写，
    // 以及同时命中三个以上关键语义概念的复述。
    && deletedMemorySimilarity(text, item.text) >= DELETED_MEMORY_SIMILARITY_THRESHOLD
  ));
}
