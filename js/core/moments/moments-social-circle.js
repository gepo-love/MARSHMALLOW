import { listSocialVisibleCharacters } from '../social-character-scope.js';
import { loadContactGroupsConfig } from '../contact-groups.js';
import { loadRelationshipNetwork } from '../relationship-network.js';
import { canPhoneCharactersKnowEachOther } from '../phone-social-eligibility.js';
import { loadAcquaintanceLedger } from '../acquaintance-ledger.js';
import {
  buildPhoneLightContactCharacter,
  loadCharacterPhoneContacts,
} from '../character-phone-contacts.js';

export const MOMENTS_NO_REACTION_CANDIDATES_MESSAGE =
  '暂无认识的人可互动：可先补全该角色「他的手机」通讯录，或在关系网/分组互识里建立熟人';

const MAX_LIGHT_REACTORS_PER_AUTHOR = 12;
export const MAX_MOMENTS_REACTION_CANDIDATES_PER_AUTHOR = 8;
export const MAX_MOMENTS_CONTEXT_ACTORS = 16;

/**
 * 朋友圈互动圈上下文（分组互识开关 + 关系网 + 角色卡关系 + 剧情认识账本）。
 * 与秘密基地候选名册规则对齐：没有认识依据的角色默认不混评。
 */
export async function buildMomentsSocialCircleContext(userId = '') {
  const [characters, relationshipNet, contactGroupsConfig, acquaintanceLedger] = await Promise.all([
    listSocialVisibleCharacters(null, { excludeAnonNpc: true, userId }),
    loadRelationshipNetwork(userId).catch(() => ({ circles: [] })),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
    loadAcquaintanceLedger().catch(() => ({ entries: [] })),
  ]);
  const charMap = new Map(characters.map((c) => [c.id, c]));
  return { charMap, relationshipNet, contactGroupsConfig, acquaintanceLedger };
}

export function isPhoneLightContactId(id = '') {
  return /^phone-contact:/i.test(String(id || '').trim());
}

function cleanId(value = '') {
  return String(value || '').trim();
}

function clip(value = '', max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function limitMomentsReactionCandidateIds(candidateGroups = [], max = MAX_MOMENTS_REACTION_CANDIDATES_PER_AUTHOR) {
  const limit = Math.max(1, Math.trunc(Number(max) || MAX_MOMENTS_REACTION_CANDIDATES_PER_AUTHOR));
  const queues = (Array.isArray(candidateGroups) ? candidateGroups : [])
    .map((group) => [...new Set((Array.isArray(group) ? group : [])
      .map(cleanId)
      .filter(Boolean))]);
  const result = [];
  const seen = new Set();
  let cursor = 0;
  while (result.length < limit && queues.some((queue) => cursor < queue.length)) {
    for (const queue of queues) {
      const id = queue[cursor];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
      if (result.length >= limit) break;
    }
    cursor += 1;
  }
  return result;
}

export function limitMomentsReactionMap(reactionMap = new Map(), authorIds = [], maxActors = MAX_MOMENTS_CONTEXT_ACTORS) {
  const authors = [...new Set((authorIds || []).map(cleanId).filter(Boolean))];
  const maxUnique = Math.max(authors.length, Math.trunc(Number(maxActors) || MAX_MOMENTS_CONTEXT_ACTORS));
  const selected = new Set(authors);
  const output = new Map(authors.map((id) => [id, []]));
  let cursor = 0;
  let hasMore = true;
  while (hasMore && selected.size < maxUnique) {
    hasMore = false;
    for (const authorId of authors) {
      const pool = reactionMap.get(authorId) || [];
      const candidateId = cleanId(pool[cursor]);
      if (!candidateId) continue;
      hasMore = true;
      if (!selected.has(candidateId) && selected.size >= maxUnique) continue;
      selected.add(candidateId);
      output.get(authorId).push(candidateId);
    }
    cursor += 1;
  }
  return output;
}

/**
 * 读取发圈者手机通讯录：轻量联系人 + 已链接主角色。
 * 通讯录里的人默认与主人认识，可参与主朋友圈点赞/评论。
 */
export async function loadAuthorPhoneReactionExtras(userId = '', authorId = '') {
  const uid = cleanId(userId);
  const aid = cleanId(authorId);
  if (!uid || !aid || aid === 'user') {
    return { lightActors: [], linkedIds: [] };
  }
  const state = await loadCharacterPhoneContacts(uid, aid).catch(() => null);
  const lightActors = [];
  const linkedIds = [];
  for (const contact of state?.contacts || []) {
    const linked = cleanId(contact?.linkedCharacterId);
    if (linked && linked !== aid && linked !== 'user') {
      linkedIds.push(linked);
      continue;
    }
    const id = cleanId(contact?.id);
    if (!id || linked || id === aid) continue;
    lightActors.push({
      id,
      name: clip(contact.name || contact.nickname || '联系人', 40) || '联系人',
      avatar: String(contact.avatar || '').trim(),
      category: cleanId(contact.category) || 'other',
      note: clip(contact.note || '', 100),
      persona: contact.personaCapsule && typeof contact.personaCapsule === 'object'
        ? contact.personaCapsule
        : {},
      translationProfile: contact.translationProfile || {},
      kind: 'phone-contact',
      ownerId: aid,
    });
  }
  return {
    lightActors: lightActors.slice(0, MAX_LIGHT_REACTORS_PER_AUTHOR),
    linkedIds: [...new Set(linkedIds)],
  };
}

/** 某发圈角色可收到点赞/评论的候选主角色 id（不含作者本人与 user） */
export function getMomentsReactionCandidates(authorId, allCharacterIds = [], ctx) {
  const aid = cleanId(authorId);
  if (!aid || !ctx?.charMap) return [];
  const charMap = ctx.charMap;
  const authorChar = charMap.get(aid);
  const pool = new Set((allCharacterIds || []).map(cleanId).filter(Boolean));

  return [...pool].filter((id) => {
    if (id === aid || id === 'user') return false;
    const c = charMap.get(id);
    return !!(c && canPhoneCharactersKnowEachOther(
      authorChar,
      c,
      ctx.relationshipNet,
      ctx.contactGroupsConfig,
      ctx.acquaintanceLedger,
    ));
  });
}

/**
 * 主角色社交圈 + 发圈者手机通讯录（已链接角色 + 轻量联系人）。
 */
export async function resolveMomentsReactionCandidates(
  userId,
  authorId,
  allCharacterIds = [],
  ctx,
  options = {},
) {
  const aid = cleanId(authorId);
  const base = getMomentsReactionCandidates(aid, allCharacterIds, ctx);
  const { lightActors: rawLights, linkedIds } = await loadAuthorPhoneReactionExtras(userId, aid);
  const maxLight = Math.max(0, Number(options.maxLightContacts) || MAX_LIGHT_REACTORS_PER_AUTHOR);
  const lightActors = rawLights.slice(0, maxLight);

  // 手机通讯录已链接角色：即使分组未开互识，也视为与主人认识
  const phoneLinkedIds = linkedIds.filter((id) => (
    id !== aid
    && id !== 'user'
    && !!ctx?.charMap?.get(id)
  ));

  // 一轮评论最多只会落几条，不需要把整本通讯录的人设、记忆和语料全复制进 prompt。
  // 三类候选轮流取，既控制旧 APK WebView 的峰值，也避免主角色或手机联系人独占名额。
  const candidateIds = limitMomentsReactionCandidateIds([
    base,
    phoneLinkedIds,
    lightActors.map((item) => item.id),
  ]);
  const selectedLightActors = lightActors.filter((actor) => candidateIds.includes(actor.id));

  return { candidateIds, lightActors: selectedLightActors, phoneLinkedIds, baseIds: base };
}

/** 为一批作者构建 authorId → 可互动角色 id[]（仅主角色社交圈，不含手机） */
export function buildMomentsReactionMap(authorIds = [], allCharacterIds = [], ctx) {
  const map = new Map();
  for (const authorId of authorIds) {
    map.set(authorId, getMomentsReactionCandidates(authorId, allCharacterIds, ctx));
  }
  return map;
}

/** 一批作者的互动池，含各自手机通讯录 */
export async function buildMomentsReactionMapWithPhone(
  userId,
  authorIds = [],
  allCharacterIds = [],
  ctx,
  options = {},
) {
  const reactionMap = new Map();
  const lightByAuthor = new Map();
  const lightActorsById = new Map();
  for (const authorId of authorIds || []) {
    const resolved = await resolveMomentsReactionCandidates(
      userId,
      authorId,
      allCharacterIds,
      ctx,
      options,
    );
    reactionMap.set(authorId, resolved.candidateIds);
    lightByAuthor.set(authorId, resolved.lightActors);
    for (const actor of resolved.lightActors) {
      if (actor?.id && !lightActorsById.has(actor.id)) lightActorsById.set(actor.id, actor);
    }
  }
  return {
    reactionMap,
    lightByAuthor,
    lightActors: [...lightActorsById.values()],
  };
}

export function applyPhoneLightActorsToNameMap(names = new Map(), lightActors = []) {
  for (const actor of lightActors || []) {
    if (!actor?.id) continue;
    if (!names.has(actor.id) || !names.get(actor.id)) {
      names.set(actor.id, actor.name || '好友');
    }
  }
  return names;
}

/** 把轻量联系人注入人物设定 Map，供评论口吻与翻译档案使用 */
export function mergePhoneLightActorsIntoCharacterMap(charMap, lightActors = []) {
  const map = charMap instanceof Map ? charMap : new Map();
  for (const actor of lightActors || []) {
    if (!actor?.id || map.has(actor.id)) continue;
    map.set(actor.id, buildPhoneLightContactCharacter({
      id: actor.id,
      name: actor.name,
      nickname: actor.name,
      note: actor.note,
      personaCapsule: actor.persona,
      translationProfile: actor.translationProfile,
      category: actor.category,
    }, actor.ownerId || ''));
  }
  return map;
}

export function formatPhoneLightContactsPromptBlock(lightActors = [], ownerLabel = '') {
  const list = (lightActors || []).filter((item) => item?.id);
  if (!list.length) return '';
  const lines = list.map((actor) => {
    const cap = actor.persona && typeof actor.persona === 'object' ? actor.persona : {};
    const bits = [
      `${actor.name}（id=${actor.id}）`,
      actor.category ? `类别=${actor.category}` : '',
      cap.relationship ? `与发圈者：${clip(cap.relationship, 80)}` : '',
      cap.summary ? `人设：${clip(cap.summary, 140)}` : '',
      cap.speechStyle ? `口吻：${clip(cap.speechStyle, 70)}` : '',
      ...(Array.isArray(cap.traits) ? cap.traits.slice(0, 4).map((t) => clip(t, 24)).filter(Boolean) : []),
      actor.note ? `备注：${clip(actor.note, 70)}` : '',
    ].filter(Boolean);
    return `- ${bits.join('；')}`;
  });
  return [
    '[手机通讯录 · 轻量联系人 · 可点赞/评论]',
    ownerLabel
      ? `下列人物来自发圈者「${ownerLabel}」的手机通讯录，与TA互相认识，可以点赞和写外部评论；口吻必须贴合其人设，禁止写成路人或用户。`
      : '下列为发圈者手机通讯录中的轻量联系人，可参与点赞/评论；口吻须贴合人设。',
    ...lines,
  ].join('\n');
}

export function formatMomentsReactionPoolBlock(authorIds = [], names = new Map(), reactionMap = new Map()) {
  const lines = (authorIds || []).map((id) => {
    const pool = reactionMap.get(id) || [];
    const authorLabel = `${id}:${names.get(id) || id}`;
    if (!pool.length) return `- ${authorLabel} 发圈 → 无同圈角色可互动（likes/comments 留空，贴主也无需自言自语）`;
    const reactors = pool.map((pid) => `${pid}:${names.get(pid) || pid}`).join('、');
    return `- ${authorLabel} 发圈 → 仅下列 id 可点赞/写外部评论：${reactors}；贴主 ${id} 可在 comments 中回复这些人`;
  });
  if (!lines.length) return '';
  return [
    '[互动圈 · 硬性隔离]',
    '点赞与外部评论 author 必须与发圈者已经认识：有角色卡关系、同关系网子网、剧情认识记录、所在分组开启了组内互识，或出现在发圈者「他的手机」通讯录（含轻量联系人）；禁止陌生角色互相装熟。发圈者本人只在回复楼里评论时例外。',
    ...lines,
  ].join('\n');
}
