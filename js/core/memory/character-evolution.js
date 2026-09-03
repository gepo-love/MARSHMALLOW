import * as db from '../db.js';
import { normalizeMemoryFactType, resolveEffectiveTemporalState } from '../../models/memory-fact.js';

const EVOLUTION_TYPE = 'character_evolution_signal';
const DAY_MS = 24 * 60 * 60 * 1000;

function clean(value = '', max = 420) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function evidenceStats(fact = {}) {
  const mappedEvidence = (Array.isArray(fact.evolutionEvidence) ? fact.evolutionEvidence : [])
    .filter((item) => String(item?.sourceKey || '').trim() && Number(item?.at || 0) > 0);
  const timestamps = [...new Set((mappedEvidence.length
    ? mappedEvidence.map((item) => item.at)
    : (Array.isArray(fact.evidenceTimestamps) ? fact.evidenceTimestamps : []))
    .map((value) => Number(value) || 0)
    .filter((value) => value > 0))].sort((a, b) => a - b);
  const sourceCount = mappedEvidence.length || new Set((Array.isArray(fact.extractionSourceKeys) ? fact.extractionSourceKeys : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)).size;
  const count = Math.max(timestamps.length, sourceCount);
  const spanMs = timestamps.length >= 2 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
  return { count, spanMs, timestamps };
}

export function qualifiesCharacterEvolutionFact(fact = {}, now = Date.now()) {
  if (normalizeMemoryFactType(fact.factType) !== EVOLUTION_TYPE) return false;
  if (resolveEffectiveTemporalState(fact, now) !== 'evergreen') return false;
  if (!clean(fact.content) || !clean(fact.subjectId)) return false;
  const confidence = Math.max(0, Math.min(1, Number(fact.confidence) || 0));
  const tags = new Set((Array.isArray(fact.tags) ? fact.tags : []).map((tag) => String(tag || '').trim()));
  const { count, spanMs } = evidenceStats(fact);
  const explicitTurningPoint = tags.has('evolution_turning_point')
    && confidence >= 0.88
    && count >= 1
    && clean(fact.evidence, 240).length >= 8;
  const gradualChange = tags.has('evolution_gradual')
    && confidence >= 0.68
    && count >= 2
    && spanMs >= DAY_MS;
  return explicitTurningPoint || gradualChange;
}

function evolutionSortScore(fact = {}) {
  const stats = evidenceStats(fact);
  const turningPoint = Array.isArray(fact.tags) && fact.tags.includes('evolution_turning_point');
  return (turningPoint ? 1000000 : 0)
    + Math.round((Number(fact.confidence) || 0) * 100000)
    + Math.min(9999, stats.count * 1000)
    + Math.min(999, Math.floor(stats.spanMs / DAY_MS));
}

function evolutionDomain(fact = {}) {
  const tags = (Array.isArray(fact.tags) ? fact.tags : [])
    .map((tag) => String(tag || '').trim())
    .filter((tag) => tag && !tag.startsWith('evolution_'));
  if (tags.length) return clean(tags[0], 24);
  const key = String(fact.canonicalKey || '').split('|').filter(Boolean).pop();
  return clean(key || '长期变化', 24);
}

export function buildCharacterEvolutionBlockFromFacts(facts = [], {
  characterIds = [],
  characters = {},
  now = Date.now(),
  limitPerCharacter = 5,
} = {}) {
  const ids = [...new Set((characterIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return '';
  const sections = [];
  for (const characterId of ids) {
    const rows = (Array.isArray(facts) ? facts : [])
      .filter((fact) => String(fact?.subjectId || '').trim() === characterId)
      .filter((fact) => String(fact?.scope || 'normal_chat').trim() === 'normal_chat')
      .filter((fact) => qualifiesCharacterEvolutionFact(fact, now))
      .sort((left, right) => evolutionSortScore(right) - evolutionSortScore(left))
      .slice(0, Math.max(1, Number(limitPerCharacter) || 5));
    if (!rows.length) continue;
    const name = clean(characters?.[characterId]?.realName || characters?.[characterId]?.name || characterId, 60);
    sections.push([
      `【${name} · 已沉淀的软变化】`,
      ...rows.map((fact) => `- ${evolutionDomain(fact)}：${clean(fact.content)}`),
    ].join('\n'));
  }
  if (!sections.length) return '';
  return [
    '【角色长期演化 · 证据晋升层】',
    '以下变化来自跨时间重复出现的共同经历，或已有明确前后差异与关系后果的关键转折；它们已经通过记忆层的晋升门槛，不是本轮临时猜测。',
    '- 身份、世界观硬设定、能力与身体边界、核心价值、明确禁忌，以及用户后来直接修改的角色卡仍优先；本层只修正角色卡中可成长的默认习惯、关系态度、表达方式、信任与应对模式。',
    '- 在上述软范围内，本层代表“这个人物后来逐渐变成了怎样”，优先于角色卡里较早的默认倾向；近期状态可以让表现暂时偏离，但不能无故抹掉已经沉淀的变化。',
    '- 变化只属于对应角色及其真实知情范围，不推广给其他人物，也不据此替用户定义内心。出现新的反证、用户纠正或再次变化时，以后续记忆修订为准。',
    '- 不要在可见台词里宣布“我成长了”或复述本层说明；只让变化自然落在注意力、选择、措辞、主动性与关系分寸里。',
    ...sections,
  ].join('\n');
}

export async function buildCharacterEvolutionPromptBlock({
  userId = '',
  characterIds = [],
  characters = {},
  now = Date.now(),
} = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return '';
  const facts = await db.getAllByIndex('memoryFacts', 'userId', uid).catch(() => []);
  return buildCharacterEvolutionBlockFromFacts(facts, { characterIds, characters, now });
}
