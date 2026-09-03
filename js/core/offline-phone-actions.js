import { getCharacterAiContextName } from '../models/character.js';
import { listCharacters } from './character-store.js';
import { getRecord } from './db.js';
import {
  deleteMessage,
  ensurePrivateChat,
  listChatsForUser,
  previewFromMessage,
  saveMessage,
  updateChatPreview,
} from './chat-store.js';
import { normalizeMessageForUi } from './chat-helpers.js';
import {
  ensurePhonePeerChat,
  listCharacterPhoneChats,
} from './character-phone-messages.js';
import {
  loadCharacterPhoneContacts,
  canPhoneAutoContactLinkedPeer,
} from './character-phone-contacts.js';
import { phoneContactCanonicalActorId } from './phone-social-actor-directory.js';
import { loadRelationshipNetwork } from './relationship-network.js';
import { loadContactGroupsConfig } from './contact-groups.js';
import { loadAcquaintanceLedger } from './acquaintance-ledger.js';
import {
  canPhoneCharacterIdsKnowEachOther,
  canPhoneCharactersKnowEachOther,
} from './phone-social-eligibility.js';
import { buildBackstageCandidateContinuityBlock } from './memory/offscene-character-continuity.js';

export const OFFLINE_PHONE_ACTIONS_START = '<<<OFFLINE_PHONE_ACTIONS>>>';
export const OFFLINE_PHONE_ACTIONS_END = '<<<END_OFFLINE_PHONE_ACTIONS>>>';

function cleanId(value = '') {
  return String(value || '').trim();
}

function cleanText(value = '', max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function pairKey(from = '', to = '') {
  return `${cleanId(from)}->${cleanId(to)}`;
}

function actorName(row = {}, fallback = '') {
  return getCharacterAiContextName(row, fallback) || cleanId(fallback) || '角色';
}

function actorCapsule(row = {}, ownerId = '') {
  const relationship = row?.relationships && typeof row.relationships === 'object'
    ? cleanText(row.relationships[ownerId], 100)
    : '';
  return [
    cleanText(row.currentRole || row.identity || row.role, 70),
    cleanText(row.personality, 110),
    cleanText(row.speechStyle, 90),
    relationship ? `与手机主人：${relationship}` : '',
  ].filter(Boolean).join('；').slice(0, 260);
}

function parseJsonObject(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

function normalizeActions(parsed = null) {
  return (Array.isArray(parsed?.actions) ? parsed.actions : [])
    .map((action) => ({
      senderId: cleanId(action?.senderId || action?.from),
      recipientId: cleanId(action?.recipientId || action?.to),
      body: cleanText(action?.body || action?.text),
    }))
    .filter((action) => action.senderId && action.recipientId && action.body)
    .slice(0, 4);
}

function normalizeSocialPosts(parsed = null) {
  return (Array.isArray(parsed?.socialPosts) ? parsed.socialPosts : [])
    .map((action) => ({
      actorId: cleanId(action?.actorId || action?.senderId || action?.from),
      target: cleanId(action?.target || 'moments').toLowerCase(),
      exactContent: cleanText(action?.exactContent || action?.content || action?.text || action?.brief, 600),
      brief: cleanText(action?.brief || action?.exactContent || action?.content || action?.text, 300),
    }))
    .filter((action) => action.actorId && action.target === 'moments' && action.exactContent)
    .slice(0, 1);
}

function normalizeTakeovers(parsed = null) {
  return (Array.isArray(parsed?.takeovers) ? parsed.takeovers : [])
    .map((action) => ({
      proxyCharacterId: cleanId(action?.proxyCharacterId || action?.actorId || action?.from),
      targetCharacterId: cleanId(action?.targetCharacterId || action?.recipientId || action?.to),
    }))
    .filter((action) => action.proxyCharacterId && action.targetCharacterId
      && action.proxyCharacterId !== action.targetCharacterId)
    .slice(0, 1);
}

function balancedObjectEnd(text = '', start = -1) {
  if (start < 0 || text[start] !== '{') return -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * 部分模型会把动作 JSON 正确生成出来，却漏掉 <<<...>>> 外壳。
 * 仅识别独占一行、且顶层键为 actions 的对象，避免误吞普通叙事中的花括号。
 */
function findLooseActionBlock(raw = '', from = 0) {
  const text = String(raw || '');
  const pattern = /(^|\r?\n)[ \t]*(?:```(?:json)?[ \t]*\r?\n[ \t]*)?(\{\s*"actions"\s*:)/gim;
  pattern.lastIndex = Math.max(0, Number(from) || 0);
  const match = pattern.exec(text);
  if (!match) return null;
  const jsonStart = match.index + match[0].lastIndexOf(match[2]);
  const jsonEnd = balancedObjectEnd(text, jsonStart);
  let removeEnd = jsonEnd >= 0 ? jsonEnd : text.length;
  if (jsonEnd >= 0) {
    const closingFence = text.slice(jsonEnd).match(/^[ \t]*(?:\r?\n)?[ \t]*```/);
    if (closingFence) removeEnd += closingFence[0].length;
  }
  return {
    removeStart: match.index + match[1].length,
    jsonStart,
    jsonEnd,
    removeEnd,
  };
}

function uniqueActions(actions = []) {
  const seen = new Set();
  return actions.filter((action) => {
    const key = `${action.senderId}\u0000${action.recipientId}\u0000${action.body}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

/** 流式展示兜底：协议标记或裸 actions JSON 一出现，就不再把尾部当正文展示。 */
export function stripOfflinePhoneActionTail(raw = '') {
  const text = String(raw || '');
  const markedStart = text.indexOf(OFFLINE_PHONE_ACTIONS_START);
  const looseStart = findLooseActionBlock(text)?.removeStart ?? -1;
  const cuts = [markedStart, looseStart].filter((index) => index >= 0);
  return cuts.length ? text.slice(0, Math.min(...cuts)) : text;
}

export function extractOfflinePhoneActions(raw = '') {
  let body = String(raw || '');
  const actions = [];
  const socialPosts = [];
  const takeovers = [];

  // 先剥离所有有标记动作块；模型偶尔会重复输出同一个块。
  for (let count = 0; count < 8; count += 1) {
    const start = body.indexOf(OFFLINE_PHONE_ACTIONS_START);
    if (start < 0) break;
    const contentStart = start + OFFLINE_PHONE_ACTIONS_START.length;
    const end = body.indexOf(OFFLINE_PHONE_ACTIONS_END, contentStart);
    const contentEnd = end >= 0 ? end : body.length;
    const parsed = parseJsonObject(body.slice(contentStart, contentEnd));
    actions.push(...normalizeActions(parsed));
    socialPosts.push(...normalizeSocialPosts(parsed));
    takeovers.push(...normalizeTakeovers(parsed));
    const tailStart = end >= 0 ? end + OFFLINE_PHONE_ACTIONS_END.length : body.length;
    body = `${body.slice(0, start)}${body.slice(tailStart)}`;
  }

  // 再接住漏掉标记的裸 JSON。完整且合法时照常执行；半截或损坏时只从可见正文移除。
  for (let count = 0; count < 8; count += 1) {
    const loose = findLooseActionBlock(body);
    if (!loose) break;
    if (loose.jsonEnd >= 0) {
      const parsed = parseJsonObject(body.slice(loose.jsonStart, loose.jsonEnd));
      actions.push(...normalizeActions(parsed));
      socialPosts.push(...normalizeSocialPosts(parsed));
      takeovers.push(...normalizeTakeovers(parsed));
    }
    body = `${body.slice(0, loose.removeStart)}${body.slice(loose.removeEnd)}`;
  }

  return {
    body: body.trim(),
    actions: uniqueActions(actions),
    socialPosts: socialPosts.slice(0, 1),
    takeovers: takeovers.slice(0, 1),
  };
}

/** 本场已落库手机消息最多回灌条数，避免长场把动作指令撑爆。 */
const MAX_PHONE_ACTION_MEMORY = 16;

/**
 * 从线下 beats 收集本场已经真实发出的手机消息（按时间先后）。
 * 重修时传入截断后的 generationSession.beats，可自然排除正在改写的那一层。
 */
export function collectOfflinePhoneActionsFromBeats(beats = []) {
  const collected = [];
  for (const beat of Array.isArray(beats) ? beats : []) {
    const actions = Array.isArray(beat?.phoneActions) ? beat.phoneActions : [];
    for (const action of actions) {
      const senderId = cleanId(action?.senderId);
      const recipientId = cleanId(action?.recipientId);
      const body = cleanText(action?.body);
      if (!senderId || !recipientId || !body) continue;
      collected.push({
        senderId,
        recipientId,
        body,
        senderName: cleanText(action?.senderName || '', 60),
        recipientName: cleanText(action?.recipientName || '', 60),
      });
    }
  }
  return collected;
}

function phoneActorLabel(id = '', fallbackName = '', actors = {}) {
  const clean = cleanId(id);
  if (clean === 'user') return '用户';
  return cleanText(fallbackName || actors?.[clean]?.name || clean, 60) || clean || '角色';
}

/**
 * 把本场已发手机消息写成既定事实块，供下一轮叙事承接与反重复。
 */
export function buildOfflinePhoneActionMemoryBlock(actions = [], actors = {}) {
  const list = (Array.isArray(actions) ? actions : [])
    .map((action) => ({
      senderId: cleanId(action?.senderId),
      recipientId: cleanId(action?.recipientId),
      body: cleanText(action?.body),
      senderName: cleanText(action?.senderName || '', 60),
      recipientName: cleanText(action?.recipientName || '', 60),
    }))
    .filter((action) => action.senderId && action.recipientId && action.body)
    .slice(-MAX_PHONE_ACTION_MEMORY);
  if (!list.length) return '';
  const lines = list.map((action, index) => {
    const from = phoneActorLabel(action.senderId, action.senderName, actors);
    const to = phoneActorLabel(action.recipientId, action.recipientName, actors);
    return `${index + 1}. ${from} → ${to}：${action.body}`;
  });
  return [
    '【本场已发手机消息 · 既定事实】',
    '以下消息已在本场更早回合真实发出并写入对应聊天，属于既定事实：',
    ...lines,
    '硬规则：禁止原样重发、换皮复述或假装这些消息没发过；正文若回指须承接既有内容。只有本轮正文明确写出「又发送了一条新消息」且内容与上列明显不同时，才允许附加新动作块。',
  ].join('\n');
}

export function offlinePhoneActionsInstruction(directory = null) {
  if (!directory?.promptLines?.length) return '';
  const memoryBlock = buildOfflinePhoneActionMemoryBlock(
    directory.sentActions,
    directory.actors,
  );
  // 角色的联系人列表通常按关系强度排序；没有额外约束时，模型会长期命中第一位联系人。
  // 把本场已联系次数显式反馈给模型，并要求优先轮换到低频联系人。
  const sentCounts = new Map();
  for (const action of (Array.isArray(directory.sentActions) ? directory.sentActions : [])) {
    const senderId = cleanId(action?.senderId);
    const recipientId = cleanId(action?.recipientId);
    if (!senderId || !recipientId || recipientId === 'user') continue;
    const key = `${senderId}\u0000${recipientId}`;
    sentCounts.set(key, (sentCounts.get(key) || 0) + 1);
  }
  const rotationLines = [];
  for (const ownerId of directory.activeIds || []) {
    const peers = Object.values(directory.actors || {})
      .filter((actor) => actor?.id && actor.id !== ownerId && actor.id !== 'user')
      .map((actor) => ({
        actor,
        count: sentCounts.get(`${ownerId}\u0000${actor.id}`) || 0,
      }))
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    if (peers.length) {
      rotationLines.push(`- ${directory.actors?.[ownerId]?.name || ownerId} 本场已联系次数：${peers.map((row) => `${row.actor.name || row.actor.id} ${row.count} 次`).join('、')}。除非正文有明确理由，优先选择尚未联系或次数更少的联系人，避免连续把消息发给同一个人。`);
    }
  }
  const takeoverTargets = Array.isArray(directory.takeoverTargets)
    ? directory.takeoverTargets
    : [];
  const takeoverInstruction = directory.takeoverEnabled === true
    && directory.takeoverProxyId
    && takeoverTargets.length
    ? [
      '【接手机代答演出】',
      `当前允许接走用户手机的现场角色只有：${directory.takeoverProxyName || directory.takeoverProxyId}（${directory.takeoverProxyId}）。`,
      `可代回的场外聊天对象：${takeoverTargets.map((row) => `${row.name}（${row.id}）`).join('、')}。`,
      '若且仅若本轮可见正文明确写成：该现场角色已经从用户手里接过、拿过、抽走或摸走用户的手机，并要在上列某个场外角色的聊天中替用户实际回复，必须附一条 takeovers。程序随后会切入真实 Chat 演出代答与对方反应。',
      '只是看见手机、拿自己的手机、想拿但没拿、被拒绝、否定句、假设或尚未实际接手时，takeovers 必须为 []，正文也不得声称已经替用户发送。目标不在上列时不要编造接手机代答情节。',
    ].join('\n')
    : '';
  return [
    '【手机消息动作指令】',
    '当且仅当本轮正文明确写到某个角色已经拿手机发送、收到或看见一条新的文字消息，或明确按下朋友圈发布键时，必须在正文后附加动作块；只描写打字、想发、说稍后发但尚未提交时不要附加。',
    '动作块不会显示在正文中，而会把消息真实写进对应聊天。正文里的发送者、收件人和内容必须与动作完全一致；不得用动作替用户发言。',
    '朋友圈不是叙事魔法：角色若发布朋友圈，必须附 socialPosts，由程序另行调用真实发布；正文只能写「按下发布/提交发布」，不得提前断言动态已成功出现在朋友圈。没有动作时禁止声称发过。发布成功或失败以程序回执为准。',
    '目录中的现场角色均视为在本应用拥有可用朋友圈账号；若本轮让角色发布，不得同时声称自己“没有朋友圈/没有账号”。不想公开或人设很少发时应直接不发布，而不是编造账号不存在。',
    '仅可使用下方目录中的 id，且每条动作必须是目录允许的一对。发给 user 会进入角色与 user 的聊天；角色之间的消息会进入角色手机后台会话。',
    ...directory.promptLines,
    takeoverInstruction,
    rotationLines.length ? ['【联系人轮换】', ...rotationLines].join('\n') : '',
    directory.continuityBlock || '',
    memoryBlock,
    '格式（没有消息、发布或接手机代答动作时整个块都不要输出）：',
    OFFLINE_PHONE_ACTIONS_START,
    '{"actions":[{"senderId":"角色id","recipientId":"user或角色id","body":"实际发出的短消息"}],"socialPosts":[{"actorId":"在场角色id","target":"moments","exactContent":"角色按下发布时屏幕里的最终朋友圈正文","brief":"可选的配图与语气提示"}],"takeovers":[{"proxyCharacterId":"接手机的现场角色id","targetCharacterId":"被代回的场外角色id"}]}',
    OFFLINE_PHONE_ACTIONS_END,
    '起止标记必须原样完整保留，禁止只输出裸 JSON，也不要用 Markdown 代码块包裹。',
    '一轮最多 4 条消息、1 条朋友圈、1 条接手机代答；没有某类动作时对应数组写 []。禁止输出未在正文中发生的额外消息，禁止生成对方回复，除非正文也明确写到对方已经回复且另列一条动作。',
    memoryBlock
      ? '若本轮没有真正新发生的发送/收信、发布或接手机代答，整块动作都不要输出——不要为了「保持联系」重复已发过的话。'
      : '',
  ].filter(Boolean).join('\n');
}

export async function dispatchOfflineSocialPosts({
  posts = [],
  directory = null,
  user = null,
  userId = '',
  sessionId = '',
  beatId = '',
  recentMessages = [],
} = {}) {
  const stored = [];
  const notices = [];
  const pending = [];
  const activeIds = new Set(directory?.activeIds || []);
  for (const [index, raw] of (Array.isArray(posts) ? posts : []).slice(0, 1).entries()) {
    const actorId = cleanId(raw?.actorId);
    const target = cleanId(raw?.target || 'moments').toLowerCase();
    const exactContent = cleanText(raw?.exactContent || raw?.content || raw?.brief, 600);
    const brief = cleanText(raw?.brief || exactContent, 300);
    if (!actorId || !activeIds.has(actorId) || target !== 'moments' || !exactContent) {
      notices.push({
        kind: 'offline_social_post',
        title: '朋友圈未发布',
        detail: '发布动作无效或角色已不在场',
        status: 'error',
      });
      continue;
    }
    try {
      const { SOCIAL_POST_ADAPTERS } = await import('./chat/intent-side-effects.js');
      const actorName = directory?.actors?.[actorId]?.name || actorId;
      const privateChat = await ensurePrivateChat(userId, actorId, actorName);
      const result = await SOCIAL_POST_ADAPTERS.moments.execute({
        user,
        userId,
        actorId,
        brief,
        exactContent,
        target,
        chatId: privateChat.id,
        recentMessages,
        idempotencyKey: `offline:${cleanId(sessionId)}:${cleanId(beatId)}:${index}`,
        allowRecentReuse: false,
      });
      if (!result?.ok || !result?.post?.id) {
        pending.push({ ...raw, actorId, target, exactContent, brief });
        notices.push({
          kind: 'offline_social_post',
          title: `${actorName}的朋友圈未发布`,
          detail: cleanText(result?.reason || '生成或写入失败', 120),
          status: 'error',
        });
        continue;
      }
      const action = {
        actorId,
        actorName,
        target,
        brief,
        exactContent,
        postId: cleanId(result.post.id),
        reused: result.reused === true,
      };
      stored.push(action);
      notices.push({
        kind: 'offline_social_post',
        title: `${actorName}发布了朋友圈`,
        detail: cleanText(result.post.content || exactContent, 180),
        status: 'saved',
        postIds: [action.postId],
        actorId,
      });
    } catch (error) {
      pending.push({ ...raw, actorId, target, exactContent, brief });
      notices.push({
        kind: 'offline_social_post',
        title: '朋友圈未发布',
        detail: cleanText(error?.message || error || '生成或写入失败', 120),
        status: 'error',
      });
    }
  }
  return { actions: stored, notices, pending };
}

export async function rollbackOfflineSocialPostsForBeat(beat = {}) {
  const actions = Array.isArray(beat?.socialPostActions) ? beat.socialPostActions : [];
  let removed = 0;
  for (const action of actions) {
    const postId = cleanId(action?.postId);
    if (!postId) continue;
    const { deleteMomentPost } = await import('./moments/moments-store.js');
    await deleteMomentPost(postId, beat?.userId || '').catch(() => {});
    removed += 1;
  }
  if (beat && typeof beat === 'object') {
    beat.socialPostActions = [];
    beat.socialPostNotices = [];
    beat.socialPostOutbox = [];
  }
  return { removed };
}

export async function buildOfflinePhoneActionDirectory({
  userId = '',
  activeCharacterIds = [],
  focusCharacterIds = [],
} = {}) {
  const uid = cleanId(userId);
  const activeIds = [...new Set((activeCharacterIds || []).map(cleanId).filter(Boolean))];
  const focusIds = new Set((focusCharacterIds || []).map(cleanId).filter(Boolean));
  if (!uid || !activeIds.length) return null;
  const [characters, relationshipNetwork, contactGroups, acquaintanceLedger, userChats] = await Promise.all([
    listCharacters({ includeInternal: true, userId: uid }).catch(() => []),
    loadRelationshipNetwork(uid).catch(() => null),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
    loadAcquaintanceLedger().catch(() => ({ entries: [] })),
    listChatsForUser(uid).catch(() => []),
  ]);
  const characterById = new Map(
    (Array.isArray(characters) ? characters : []).filter((row) => row?.id).map((row) => [String(row.id), row]),
  );
  const actors = { user: { id: 'user', name: '用户' } };
  const allowedPairs = new Set();
  const promptLines = [];
  const candidateIds = [];

  for (const ownerId of activeIds) {
    const owner = characterById.get(ownerId);
    if (!owner) continue;
    actors[ownerId] = { id: ownerId, name: actorName(owner, ownerId) };
    allowedPairs.add(pairKey(ownerId, 'user'));
    const [phoneContacts, phoneChats] = await Promise.all([
      loadCharacterPhoneContacts(uid, ownerId).catch(() => ({ contacts: [] })),
      listCharacterPhoneChats(uid, ownerId, { includeIntercept: false }).catch(() => []),
    ]);
    const existingPeerIds = new Set(
      (phoneChats || []).flatMap((row) => row?.participants || [])
        .map(cleanId)
        .filter((id) => id && id !== ownerId && id !== 'user'),
    );
    const allowed = [];
    for (const candidate of characterById.values()) {
      if (!candidate?.id || candidate.id === ownerId) continue;
      if (!canPhoneAutoContactLinkedPeer(phoneContacts, candidate.id)) continue;
      if (canPhoneCharactersKnowEachOther(
        owner,
        candidate,
        relationshipNetwork,
        contactGroups,
        acquaintanceLedger,
      )) {
        allowed.push({
          id: candidate.id,
          name: actorName(candidate, candidate.id),
          capsule: actorCapsule(candidate, ownerId),
          priority: focusIds.has(candidate.id)
            ? 4
            : (activeIds.includes(candidate.id) ? 3 : (existingPeerIds.has(candidate.id) ? 2 : 1)),
        });
      }
    }
    for (const contact of phoneContacts?.contacts || []) {
      // 关系网 NPC 在手机通讯录里同时有本地 contact.id 与稳定 linkedActorId。
      // 线下动作必须沿用 canonical actor，否则会另开一扇只有同名资料、却无法回复的假私聊。
      const id = cleanId(phoneContactCanonicalActorId(contact));
      if (!id || id === ownerId || allowed.some((row) => row.id === id)) continue;
      if (contact?.linkedCharacterId && !canPhoneAutoContactLinkedPeer(phoneContacts, contact.linkedCharacterId)) continue;
      allowed.push({
        id,
        name: cleanText(contact?.name || contact?.nickname || id, 60),
        capsule: [
          cleanText(contact?.relationship || contact?.note, 100),
          cleanText(contact?.personaSummary || contact?.summary, 100),
          cleanText(contact?.speechStyle, 80),
        ].filter(Boolean).join('；').slice(0, 220),
        priority: focusIds.has(id) ? 4 : 2,
      });
    }
    const peers = allowed
      .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0)
        || left.name.localeCompare(right.name, 'zh-CN'))
      .slice(0, 24);
    for (const peer of peers) {
      actors[peer.id] ||= { id: peer.id, name: peer.name || peer.id };
      allowedPairs.add(pairKey(ownerId, peer.id));
      allowedPairs.add(pairKey(peer.id, ownerId));
      if (!candidateIds.includes(peer.id)) candidateIds.push(peer.id);
    }
    promptLines.push(
      `- ${actors[ownerId].name}（${ownerId}）可与：user（用户）${
        peers.length
          ? `、${peers.map((peer) =>
            `${peer.name}（${peer.id}${peer.capsule ? `；${peer.capsule}` : ''}）`).join('、')}`
          : ''
      } 互发消息。`,
    );
  }
  const prioritized = focusIds.size
    ? [...focusIds, ...candidateIds]
    : candidateIds.slice(0, 3);
  const priorityCandidateIds = prioritized
    .filter((id, index, rows) => id && !activeIds.includes(id) && rows.indexOf(id) === index);
  const takeoverTargets = (Array.isArray(userChats) ? userChats : [])
    .filter((row) => row?.id && row.type !== 'group')
    .sort((left, right) => Number(right?.lastActivity || 0) - Number(left?.lastActivity || 0))
    .map((row) => {
      const id = (row.participants || []).map(cleanId)
        .find((participantId) => participantId && participantId !== 'user' && !activeIds.includes(participantId));
      const character = id ? characterById.get(id) : null;
      return character ? { id, name: actorName(character, id), chatId: cleanId(row.id) } : null;
    })
    .filter((row, index, rows) => row?.id && rows.findIndex((item) => item?.id === row.id) === index)
    .slice(0, 16);
  for (const target of takeoverTargets) {
    actors[target.id] ||= { id: target.id, name: target.name || target.id };
  }
  const continuityBlock = await buildBackstageCandidateContinuityBlock({
    userId: uid,
    candidateIds: priorityCandidateIds,
    characters: Object.fromEntries(characterById),
    userName: '用户',
    maxCandidates: focusIds.size ? 8 : 3,
  }).catch(() => '');
  return {
    activeIds,
    actors,
    allowedPairs,
    promptLines,
    continuityBlock,
    takeoverTargets,
    takeoverTargetIds: new Set(takeoverTargets.map((row) => row.id)),
  };
}

function actionMessageId(sessionId, beatId, index) {
  const safe = `${cleanId(sessionId)}_${cleanId(beatId)}_${index}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `offline_phone_${safe}`;
}

function actionReceipt(action = {}, index = 0, patch = {}) {
  return {
    index: Math.max(0, Number(action?.outboxIndex ?? action?.actionIndex ?? index) || 0),
    senderId: cleanId(action?.senderId),
    recipientId: cleanId(action?.recipientId),
    body: cleanText(action?.body),
    status: 'rejected',
    reason: 'invalid_action',
    ...patch,
  };
}

/** 先随 beat 保存待派发动作；真正写消息后再把对应项标为完成。 */
export function stageOfflinePhoneActionOutbox(beat = null, actions = []) {
  if (!beat || typeof beat !== 'object') return [];
  const previous = new Map(
    (Array.isArray(beat.phoneActionOutbox) ? beat.phoneActionOutbox : [])
      .map((item) => [Number(item?.index), item]),
  );
  const outbox = (Array.isArray(actions) ? actions : []).map((action, index) => {
    const prior = previous.get(index);
    return {
      index,
      senderId: cleanId(action?.senderId),
      recipientId: cleanId(action?.recipientId),
      body: cleanText(action?.body),
      status: prior?.status === 'saved' ? 'saved' : 'pending',
      attempts: Math.max(0, Number(prior?.attempts || 0) || 0),
      ...(prior?.messageId ? { messageId: cleanId(prior.messageId) } : {}),
      ...(prior?.chatId ? { chatId: cleanId(prior.chatId) } : {}),
    };
  }).filter((item) => item.senderId && item.recipientId && item.body);
  beat.phoneActionOutbox = outbox;
  return outbox;
}

export function pendingOfflinePhoneActionOutbox(beat = null) {
  return (Array.isArray(beat?.phoneActionOutbox) ? beat.phoneActionOutbox : [])
    .filter((item) => item?.status === 'pending' || item?.status === 'error')
    .map((item) => ({ ...item, outboxIndex: Number(item.index) }));
}

export function applyOfflinePhoneActionReceipts(beat = null, result = {}) {
  if (!beat || typeof beat !== 'object') return beat;
  const receipts = Array.isArray(result?.receipts) ? result.receipts : [];
  const byIndex = new Map(receipts.map((receipt) => [Number(receipt?.index), receipt]));
  beat.phoneActionOutbox = (Array.isArray(beat.phoneActionOutbox) ? beat.phoneActionOutbox : [])
    .map((item) => {
      const receipt = byIndex.get(Number(item?.index));
      if (!receipt) return item;
      return {
        ...item,
        status: receipt.status === 'saved' ? 'saved' : (receipt.status === 'error' ? 'error' : 'rejected'),
        reason: cleanId(receipt.reason),
        attempts: Math.max(0, Number(item?.attempts || 0) || 0) + 1,
        ...(receipt.messageId ? { messageId: cleanId(receipt.messageId) } : {}),
        ...(receipt.chatId ? { chatId: cleanId(receipt.chatId) } : {}),
        updatedAt: Date.now(),
      };
    });
  beat.phoneActionReceipt = {
    status: receipts.some((row) => row.status === 'error')
      ? 'error'
      : (receipts.some((row) => row.status !== 'saved') ? 'partial' : 'saved'),
    saved: receipts.filter((row) => row.status === 'saved').length,
    skipped: receipts.filter((row) => row.status === 'rejected').length,
    errors: receipts.filter((row) => row.status === 'error').length,
    receipts,
    updatedAt: Date.now(),
  };
  return beat;
}

export async function dispatchOfflinePhoneActions({
  actions = [],
  directory = null,
  userId = '',
  sessionId = '',
  beatId = '',
  timestamp = Date.now(),
} = {}) {
  const source = Array.isArray(actions) ? actions : [];
  if (!directory || !beatId) {
    const reason = !directory ? 'directory_unavailable' : 'missing_beat_id';
    return {
      actions: [],
      notices: [],
      receipts: source.map((action, index) => actionReceipt(action, index, {
        status: !directory ? 'error' : 'rejected',
        reason,
      })),
    };
  }
  const stored = [];
  const receipts = [];
  for (const [index, action] of actions.entries()) {
    const senderId = cleanId(action?.senderId);
    const recipientId = cleanId(action?.recipientId);
    const body = cleanText(action?.body);
    const outboxIndex = Math.max(0, Number(action?.outboxIndex ?? action?.actionIndex ?? index) || 0);
    const reject = (reason) => receipts.push(actionReceipt(action, outboxIndex, { reason }));
    if (!senderId || senderId === 'user' || !recipientId || senderId === recipientId || !body) {
      reject('invalid_action');
      continue;
    }
    if (!directory.allowedPairs.has(pairKey(senderId, recipientId))) {
      reject('pair_not_allowed');
      continue;
    }
    const activeSet = new Set(directory.activeIds || []);
    if (!activeSet.has(senderId) && !activeSet.has(recipientId)) {
      reject('actor_not_present');
      continue;
    }

    const phoneOwnerId = activeSet.has(senderId) ? senderId : recipientId;
    const peerId = phoneOwnerId === senderId ? recipientId : senderId;
    try {
      let targetChat = null;
      if (recipientId === 'user') {
        const senderName = directory.actors?.[senderId]?.name || senderId;
        targetChat = await ensurePrivateChat(userId, senderId, senderName);
      } else {
        const sociallyEligible = await canPhoneCharacterIdsKnowEachOther(phoneOwnerId, peerId, userId);
        if (sociallyEligible === false) {
          reject('social_gate_rejected');
          continue;
        }
        targetChat = await ensurePhonePeerChat(userId, phoneOwnerId, peerId);
      }
      if (!targetChat?.id) {
        reject('target_chat_unavailable');
        continue;
      }

      const messageId = actionMessageId(sessionId, beatId, outboxIndex);
      const senderName = directory.actors?.[senderId]?.name || senderId;
      const recipientName = recipientId === 'user'
        ? '你'
        : (directory.actors?.[recipientId]?.name || recipientId);
      const message = normalizeMessageForUi({
        id: messageId,
        chatId: targetChat.id,
        senderId,
        senderName,
        content: body,
        type: 'text',
        timestamp: Number(timestamp || Date.now()) + outboxIndex,
        metadata: {
          offlinePhoneAction: true,
          offlineSessionId: cleanId(sessionId),
          offlineSourceBeatId: cleanId(beatId),
          offlinePhoneActionIndex: outboxIndex,
          phoneOwnerId,
          recipientId,
        },
      });
      await saveMessage(message);
      await updateChatPreview(
        targetChat.id,
        previewFromMessage(message),
        Number(timestamp || Date.now()) + outboxIndex,
      );
      const storedAction = {
        senderId,
        senderName,
        recipientId,
        recipientName,
        body,
        messageId,
        chatId: targetChat.id,
        phoneOwnerId: recipientId === 'user' ? '' : phoneOwnerId,
      };
      stored.push(storedAction);
      receipts.push(actionReceipt(action, outboxIndex, {
        status: 'saved',
        reason: '',
        messageId,
        chatId: targetChat.id,
      }));
    } catch (error) {
      receipts.push(actionReceipt(action, outboxIndex, {
        status: 'error',
        reason: 'persist_failed',
        error: cleanText(error?.message || error, 180),
      }));
    }
  }
  return {
    actions: stored,
    receipts,
    notices: stored.map((action) => ({
      kind: 'offline_phone_action',
      chatId: action.chatId,
      viewerId: action.phoneOwnerId,
      title: `${action.senderName}发消息给${action.recipientName}`,
      detail: action.body,
      messageIds: [action.messageId],
      senderId: action.senderId,
      recipientId: action.recipientId,
    })),
  };
}

export async function rollbackOfflinePhoneActionsForBeat(beat = {}, sessionId = '') {
  const actions = Array.isArray(beat?.phoneActions) ? beat.phoneActions : [];
  const outboxMessageIds = (Array.isArray(beat?.phoneActionOutbox) ? beat.phoneActionOutbox : [])
    .map((item) => cleanId(item?.messageId)
      || actionMessageId(sessionId, beat?.id, Math.max(0, Number(item?.index || 0) || 0)))
    .filter(Boolean);
  const messageIds = [...new Set([
    ...actions.map((action) => cleanId(action?.messageId)).filter(Boolean),
    ...outboxMessageIds,
  ])];
  let removed = 0;
  for (const messageId of messageIds) {
    const message = await getRecord('messages', messageId).catch(() => null);
    if (!message?.metadata?.offlinePhoneAction) continue;
    if (cleanId(sessionId) && cleanId(message.metadata.offlineSessionId) !== cleanId(sessionId)) continue;
    if (cleanId(message.metadata.offlineSourceBeatId) !== cleanId(beat.id)) continue;
    // deleteMessage 会重算对应会话预览；确定性 messageId 让重复调用保持幂等。
    await deleteMessage(messageId).catch(() => {});
    removed += 1;
  }
  if (beat && typeof beat === 'object') {
    beat.phoneActions = [];
    beat.phoneActionNotices = [];
    beat.phoneActionOutbox = [];
    delete beat.phoneActionReceipt;
  }
  const social = await rollbackOfflineSocialPostsForBeat(beat);
  return { removed, socialRemoved: social.removed, sessionId: cleanId(sessionId) };
}

export async function restoreOfflinePhoneActionsForBeat({
  beat = null,
  userId = '',
  sessionId = '',
  activeCharacterIds = [],
} = {}) {
  if (!beat?.id) return { actions: [], notices: [] };
  const previous = (Array.isArray(beat.phoneActions) ? beat.phoneActions : [])
    .map((action) => ({
      senderId: action.senderId,
      recipientId: action.recipientId,
      body: action.body,
    }));
  beat.phoneActions = [];
  beat.phoneActionNotices = [];
  if (!previous.length) return { actions: [], notices: [] };
  const directory = await buildOfflinePhoneActionDirectory({
    userId,
    activeCharacterIds,
    focusCharacterIds: previous.flatMap((action) => [action.senderId, action.recipientId]),
  });
  const result = await dispatchOfflinePhoneActions({
    actions: previous,
    directory,
    userId,
    sessionId,
    beatId: beat.id,
    timestamp: beat.ts,
  });
  beat.phoneActions = result.actions;
  beat.phoneActionNotices = result.notices;
  applyOfflinePhoneActionReceipts(beat, result);
  return result;
}
