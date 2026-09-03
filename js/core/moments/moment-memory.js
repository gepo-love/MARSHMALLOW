import { createMemory } from '../../models/memory.js';
import { saveMemory } from '../chat-store.js';
import { upsertMemoryFact } from '../memory/memory-facts.js';
import { listSocialVisibleCharacters } from '../social-character-scope.js';
import { canCharacterSeeMomentPost } from './moments-visibility.js';
import * as db from '../db.js';
import { deleteVectorSources } from '../memory/memory-vectors.js';

function clip(text = '', max = 280) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function memoryIdForPost(postId = '') {
  return `mem_moment_${String(postId || '').trim()}`;
}

function factIdForPost(postId = '') {
  return `mf_moment_${String(postId || '').trim()}`;
}

function canonicalMomentActorId(value = '', userId = '') {
  const id = String(value || '').trim();
  const uid = String(userId || '').trim();
  if (!id) return '';
  return id === 'user' || (uid && id === uid) ? 'user' : id;
}

/**
 * 朋友圈的「当事人」只能来自明确结构化来源：
 * 作者、@ 角色、或发布链路写入的来源会话参与者。
 * 正文里的“你 / 他 / 我们”不能用于猜测，否则每个可见角色都会把自己代入。
 */
export function resolveMomentInvolvedActorIds(post = {}, userId = '') {
  const raw = [
    post.authorId,
    ...(Array.isArray(post.mentionIds) ? post.mentionIds : []),
    ...(Array.isArray(post?.metadata?.involvedActorIds) ? post.metadata.involvedActorIds : []),
  ];
  return [...new Set(raw
    .map((id) => canonicalMomentActorId(id, userId))
    .filter(Boolean))];
}

export function buildMomentKnownByLedger(post = {}, userId = '', visibleCharacterIds = []) {
  const involved = new Set(resolveMomentInvolvedActorIds(post, userId));
  const knownBy = {};
  if (String(userId || '').trim()) {
    knownBy.user = involved.has('user') ? 'involved' : 'known';
  }
  for (const rawId of visibleCharacterIds || []) {
    const cid = canonicalMomentActorId(rawId, userId);
    if (!cid || cid === 'user') continue;
    knownBy[cid] = involved.has(cid) ? 'involved' : 'known';
  }
  return knownBy;
}

function buildMomentSummary(post = {}) {
  const authorName = clip(post.authorName || '好友', 40);
  const imageCount = Array.isArray(post.images) ? post.images.filter(Boolean).length : 0;
  const imageHint = imageCount ? `（配图${imageCount}张）` : '';
  // Past tense on purpose: posting is a finished event, not an ongoing status.
  if (post.postKind === 'chat_share' && Array.isArray(post.chatShare?.lines) && post.chatShare.lines.length) {
    const title = clip(post.chatShare?.title || '聊天记录', 40);
    const excerpt = clip(post.chatShare.lines.slice(0, 3).map((line) => (
      typeof line === 'object' ? String(line?.text || line?.content || '') : String(line || '')
    )).filter(Boolean).join(' / '), 180);
    return `「${authorName}」曾在朋友圈晒过聊天「${title}」：${excerpt}${imageHint}`;
  }
  const body = clip(post.content || '', 220);
  if (body) return `「${authorName}」曾发过朋友圈：${body}${imageHint}`;
  if (imageCount) return `「${authorName}」曾发过朋友圈：纯配图${imageCount}张`;
  return '';
}

async function buildKnowledgeStateForPost(post = {}, userId = '') {
  const chars = await listSocialVisibleCharacters(null, {
    excludeAnonNpc: true,
    userId,
  }).catch(() => []);
  const charMap = new Map(chars.map((c) => [String(c?.id || '').trim(), c]).filter(([id]) => id));
  const visibleCharacterIds = [];
  for (const c of chars) {
    const cid = String(c?.id || '').trim();
    if (!cid) continue;
    if (!canCharacterSeeMomentPost(post, cid, charMap)) continue;
    visibleCharacterIds.push(cid);
  }
  return {
    chars,
    knownBy: buildMomentKnownByLedger(post, userId, visibleCharacterIds),
    involvedActorIds: resolveMomentInvolvedActorIds(post, userId),
  };
}

/** 朋友圈动态写入公共动态记忆；可见、知情、亲历三者必须分开。 */
export async function syncMomentPostMemory(post = {}, userId = '') {
  const uid = String(userId || post.userId || post.ownerUserId || '').trim();
  const postId = String(post?.id || '').trim();
  if (!uid || !postId) return null;

  const summary = buildMomentSummary(post);
  if (!summary) return null;

  const authorId = String(post.authorId || '').trim();
  const isUserPost = authorId === 'user' || authorId === uid;
  const authorName = clip(post.authorName || (isUserPost ? '用户' : '好友'), 40);
  const {
    chars,
    knownBy,
    involvedActorIds,
  } = await buildKnowledgeStateForPost(post, uid);
  const sourceChatId = clip(post?.metadata?.sourceChatId || post?.sourceChatId || '', 180);
  const subjectId = isUserPost ? 'user' : authorId;
  const objectId = involvedActorIds.find((id) => id !== subjectId) || '';
  const objectCharacter = chars.find((row) => String(row?.id || '').trim() === objectId);
  const objectName = objectId === 'user'
    ? ''
    : clip(objectCharacter?.name || objectCharacter?.realName || objectCharacter?.customNickname || '', 40);
  const ts = Number(post.timestamp || Date.now()) || Date.now();

  const mem = createMemory({
    id: memoryIdForPost(postId),
    userId: uid,
    chatId: '',
    characterId: authorId && !isUserPost ? authorId : '',
    type: 'event',
    // 不能放进 shared：用户发的圈没有 characterId，会被误归为所有角色共同经历。
    category: 'public_feed',
    content: summary,
    importance: isUserPost ? 'important' : 'normal',
    timestamp: ts,
    source: 'moments',
  });
  mem.momentPostId = postId;
  mem.momentAuthorId = subjectId;
  mem.sourceChatId = sourceChatId;
  mem.involvedActorIds = involvedActorIds;
  mem.knownBy = knownBy;
  await saveMemory(mem);

  await upsertMemoryFact({
    id: factIdForPost(postId),
    userId: uid,
    chatId: '',
    sourceChatId,
    scope: 'public_feed',
    // 缺 authorId 的旧动态只能视为未知好友，绝不能默认认领给 user。
    subjectId,
    subjectName: authorName,
    objectId,
    objectName,
    // Discrete past post — never default status→ongoing ("进行中").
    factType: 'status',
    temporalState: 'completed',
    content: summary,
    evidence: '朋友圈动态',
    confidence: 0.92,
    visibility: 'public',
    knownBy,
    provenance: {
      source: 'moments',
      sourceChatId,
      note: involvedActorIds.length
        ? `明确当事人：${involvedActorIds.join('、')}；其余可见角色仅知情`
        : '未记录明确当事人；可见角色仅知情',
    },
    tags: ['朋友圈', '知情与亲历隔离', isUserPost ? '用户动态' : '角色动态'],
    sourceMessageIds: [],
    createdAt: ts,
    updatedAt: ts,
  });

  return mem;
}

export async function removeMomentPostMemory(postId = '', userId = '') {
  const id = String(postId || '').trim();
  const uid = String(userId || '').trim();
  if (!id) return;
  const memId = memoryIdForPost(id);
  const factId = factIdForPost(id);
  try {
    await db.deleteRecord('memories', memId);
  } catch {
    /* ignore */
  }
  try {
    await db.deleteRecord('memoryFacts', factId);
  } catch {
    /* ignore */
  }
  await Promise.all([
    deleteVectorSources('memory', [memId]).catch(() => 0),
    deleteVectorSources('fact', [factId]).catch(() => 0),
  ]);
  if (uid) {
    const facts = await db.getAllByIndex('memoryFacts', 'userId', uid).catch(() => []);
    for (const row of Array.isArray(facts) ? facts : []) {
      if (row?.id === factId) await db.deleteRecord('memoryFacts', row.id).catch(() => {});
    }
  }
}
