import * as db from '../db.js';
import { createCharacterProfile } from '../../models/character.js';
import { getCharacter, saveCharacter } from '../character-store.js';
import { getActiveWorldBookItems, listAllWorldBookRows } from '../world-book-store.js';
import { loadAuConfigForUser } from '../au-config.js';
import { listMemoryFactsForContext } from '../memory/memory-facts.js';
import { listSharedKnowledgeForCharacters } from '../memory/shared-event-knowledge.js';
import { ensureAnonNpcGroup, isAnonymousNpcCharacter } from '../anonymous-npc.js';
import { createAnonymousPrivateFromRandomMatch } from '../anonymous-private-chat.js';
import { buildAnonymousContactEntry } from '../anonymous-contacts.js';
import { acceptAnonymousReveal } from '../anonymous-reveal.js';
import { listChatsForUser, listMessagesForChat, saveChat } from '../chat-store.js';
import { saveAliasAccount } from '../alias-account-store.js';
import { ensureStrangerThread } from '../stranger-thread-store.js';
import { getVirtualNow } from '../virtual-time-shim.js';
import {
  generatedForumAuthorClaimsCurrentUser,
  resolveForumAuthorSource,
  sanitizeGeneratedForumAuthor,
  sanitizeGeneratedForumReplyAuthor,
} from '../forum-identity.js';
import { chatForTask } from '../api.js';
import { sanitizeAiTranslation } from '../translation-utils.js';
import { buildCharacterGenderRuleLine } from '../social-helpers.js';
import {
  recordForumRelationshipEvent,
  syncForumRelationshipsFromThreads,
} from './forum-relationships.js';
import { loadForumMetaCompat, saveForumMetaCompat } from './forum-meta-store.js';

const REGISTRY_VERSION = 1;
const MAX_PASSERBY_ROWS = 120;
const DOSSIER_VERSION = 2;

function clean(value = '', max = 0) {
  const text = String(value ?? '').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function registryKey(userId = '') {
  return `forumActorRegistry_${clean(userId) || 'guest'}`;
}

function dossierSettingsKey(userId = '') {
  return `forumActorDossiers_${clean(userId) || 'guest'}`;
}

function actorMixStateKey(userId = '') {
  return `forumActorMixState_${clean(userId) || 'guest'}`;
}

function characterAliasPoolKey(userId = '') {
  return `forumCharacterAliases_${clean(userId) || 'guest'}`;
}

function dossierIdentityKey(actorId = '', displayName = '') {
  return `${clean(actorId, 180)}::${nameKey(displayName)}`;
}

function stableTraceId(prefix = 'trace', parts = []) {
  const text = (Array.isArray(parts) ? parts : [parts]).map((value) => clean(value, 240)).join('|');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${(hash >>> 0).toString(36)}`;
}

function normalizeDossierSection(raw = {}, index = 0) {
  const name = clean(raw.name || raw.sectionName, 80);
  if (!name) return null;
  return {
    id: clean(raw.id, 120) || stableTraceId('section', [name, raw.type]),
    name,
    type: clean(raw.type || raw.sectionType, 40) || '闲聊',
    clue: clean(raw.clue || raw.evidence || raw.reason, 180),
    source: raw.source === 'observed' ? 'observed' : 'inferred',
    sectionId: clean(raw.sectionId, 180),
    threadId: clean(raw.threadId, 180),
    materializedAt: Number(raw.materializedAt || 0) || 0,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
  };
}

function normalizeFootprintKind(value = '') {
  const kind = clean(value).toLowerCase();
  if (['post', 'reply', 'comment', 'repost', 'visit', 'favorite'].includes(kind)) return kind;
  return 'visit';
}

function normalizeDossierFootprint(raw = {}, index = 0) {
  const sectionName = clean(raw.sectionName || raw.section, 80);
  const title = clean(raw.title || raw.threadTitle, 120);
  const excerpt = clean(raw.excerpt || raw.content || raw.text, 360);
  if (!sectionName && !title && !excerpt) return null;
  const kind = normalizeFootprintKind(raw.kind || raw.action);
  const draftSource = raw.threadDraft && typeof raw.threadDraft === 'object'
    ? raw.threadDraft
    : raw.originalPost && typeof raw.originalPost === 'object'
      ? raw.originalPost
      : null;
  const threadDraft = draftSource ? {
    title: clean(draftSource.title, 120),
    content: clean(draftSource.content, 4000),
    contentTranslation: clean(draftSource.contentTranslation || draftSource.zh || draftSource.translation, 4000),
    originalAuthor: clean(draftSource.originalAuthor, 80),
    originalAuthorPersonality: clean(draftSource.originalAuthorPersonality, 700),
    originalAuthorSpeechStyle: clean(draftSource.originalAuthorSpeechStyle, 500),
    actorReply: clean(draftSource.actorReply, 800),
    actorReplyTranslation: clean(draftSource.actorReplyTranslation || draftSource.actorReplyZh, 800),
    replies: (Array.isArray(draftSource.replies) ? draftSource.replies : []).slice(0, 3).map((reply) => ({
      author: clean(reply?.author || reply?.authorName, 80),
      content: clean(reply?.content || reply?.text, 800),
      translation: clean(reply?.translation || reply?.zh, 800),
    })).filter((reply) => reply.content),
  } : null;
  return {
    id: clean(raw.id, 120) || stableTraceId('footprint', [kind, sectionName, title, excerpt]),
    kind,
    sectionName: sectionName || '社区广场',
    sectionType: clean(raw.sectionType || raw.type, 40) || '闲聊',
    title: title || '一条没有标题的讨论',
    excerpt,
    actionLabel: clean(raw.actionLabel, 32),
    evidence: clean(raw.evidence || raw.clue || raw.reason, 160),
    timestampHint: clean(raw.timestampHint || raw.time, 40),
    source: raw.source === 'observed' ? 'observed' : 'inferred',
    sectionId: clean(raw.sectionId, 180),
    threadId: clean(raw.threadId, 180),
    materializedAt: Number(raw.materializedAt || 0) || 0,
    ...(threadDraft ? { threadDraft } : {}),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
  };
}

function normalizeDossier(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const sections = (Array.isArray(source.sections) ? source.sections : source.sectionTrails || [])
    .map(normalizeDossierSection).filter(Boolean).slice(0, 24);
  const footprints = (Array.isArray(source.footprints) ? source.footprints : source.traces || [])
    .map(normalizeDossierFootprint).filter(Boolean).slice(0, 40);
  return {
    version: sections.length || footprints.length ? DOSSIER_VERSION : Number(source.version || 1),
    sections,
    footprints,
    rounds: Math.max(0, Number(source.rounds) || 0),
    generatedAt: Number(source.generatedAt || 0) || 0,
  };
}

function extractJsonObject(raw = '') {
  const text = clean(raw);
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(text ? '主页生成结果不是有效 JSON' : '主页生成接口返回为空');
  return JSON.parse(body.slice(start, end + 1));
}

async function loadDossierMap(userId = '') {
  const row = await db.get('settings', dossierSettingsKey(userId)).catch(() => null);
  return row?.value && typeof row.value === 'object' ? row.value : {};
}

export async function loadForumActorDossier(userId = '', actorId = '', displayName = '') {
  const rows = await loadDossierMap(userId);
  const raw = rows[dossierIdentityKey(actorId, displayName)];
  if (!raw) return null;
  const dossier = normalizeDossier(raw);
  return dossier.generatedAt && (dossier.sections.length || dossier.footprints.length) ? dossier : null;
}

function forumDossierChatBelongsToActor(chat = {}, actorId = '') {
  const aid = clean(actorId, 180);
  if (!aid) return false;
  if (clean(chat.characterId, 180) === aid) return true;
  if ((Array.isArray(chat.participants) ? chat.participants : []).some((id) => clean(id, 180) === aid)) return true;
  if (clean(chat.metadata?.sourceForumActorId, 180) === aid) return true;
  const identityMap = chat.metadata?.accountIdentityMap;
  return !!identityMap && JSON.stringify(identityMap).includes(aid);
}

function actorCardDossierBlock(actor = {}, passerby = false) {
  const draft = actor?.anonymousPrivateDraft && typeof actor.anonymousPrivateDraft === 'object'
    ? actor.anonymousPrivateDraft
    : {};
  const life = actor?.lifeProfile && typeof actor.lifeProfile === 'object' ? actor.lifeProfile : {};
  return [
    `身份类型：${passerby ? '论坛原生路人' : '已有角色的论坛马甲号'}`,
    `性别与代词（硬性）：${buildCharacterGenderRuleLine(actor).replace(/^[-]\s*/, '')}`,
    clean(actor.realName || actor.name, 80) ? `本体/真实身份：${clean(actor.realName || actor.name, 80)}` : '',
    clean(actor.currentRole || draft.currentRole) ? `身份或职业：${clean(actor.currentRole || draft.currentRole)}` : '',
    clean(actor.currentStatus) ? `当前状态：${clean(actor.currentStatus)}` : '',
    clean(actor.personality) ? `性格人设：${clean(actor.personality)}` : '',
    clean(actor.speechStyle) ? `说话方式：${clean(actor.speechStyle)}` : '',
    clean(actor.promptCorpus) ? `整段设定（完整）：${clean(actor.promptCorpus)}` : '',
    clean(actor.notes) ? `角色备注：${clean(actor.notes)}` : '',
    clean(actor.userRelationStatus) ? `与用户关系：${clean(actor.userRelationStatus)}` : '',
    clean(actor.speechCorpus) ? `语言样本（完整）：${clean(actor.speechCorpus)}` : '',
    actor.relationships && typeof actor.relationships === 'object' && Object.keys(actor.relationships).length
      ? `关系网（完整）：${JSON.stringify(actor.relationships)}`
      : '',
    clean(draft.realName, 80) ? `匿名身份背后的姓名：${clean(draft.realName, 80)}` : '',
    clean(draft.background, 600) ? `匿名身份背景：${clean(draft.background, 600)}` : '',
    Array.isArray(draft.interests) && draft.interests.length
      ? `兴趣：${draft.interests.map((value) => clean(value, 40)).filter(Boolean).slice(0, 8).join('、')}`
      : '',
    clean(life.habits, 300) ? `生活习惯：${clean(life.habits, 300)}` : '',
    clean(life.activitySeeds, 300) ? `日常兴趣线索：${clean(life.activitySeeds, 300)}` : '',
  ].filter(Boolean).join('\n');
}

async function actorPrivateChatDossierBlock(userId = '', actorId = '') {
  const chats = (await listChatsForUser(userId).catch(() => []))
    .filter((chat) => forumDossierChatBelongsToActor(chat, actorId))
    .slice(0, 6);
  const blocks = [];
  for (const chat of chats) {
    const messages = await listMessagesForChat(chat.id, 30).catch(() => []);
    const lines = messages.slice(-24).map((message) => {
      const content = clean(message?.content || message?.text, 240).replace(/\s+/g, ' ');
      if (!content) return '';
      const sender = clean(message?.senderName, 60)
        || (clean(message?.senderId, 180) === clean(actorId, 180) ? '角色' : '用户');
      return `${sender}：${content}`;
    }).filter(Boolean);
    if (lines.length) blocks.push(`窗口「${clean(chat.name || chat.title, 80) || '私聊'}」：\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n');
}

function normalizeBindingIds(value) {
  const rows = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(rows.map((id) => clean(id, 180)).filter(Boolean))];
}

async function actorStructuredMemoryDossierBlock(userId = '', actorId = '') {
  const [facts, shared] = await Promise.all([
    listMemoryFactsForContext({ userId, characterIds: [actorId], limit: 12 }).catch(() => []),
    listSharedKnowledgeForCharacters({ userId, characterIds: [actorId], limit: 8 }).catch(() => []),
  ]);
  const factLines = (facts || []).map((item) => clean(item?.content, 220)).filter(Boolean).slice(0, 12);
  const sharedLines = (shared || [])
    .map((item) => clean(item?.summary || item?.excerpt || item?.note, 220))
    .filter(Boolean)
    .slice(0, 8);
  if (!factLines.length && !sharedLines.length) return '';
  return [
    factLines.length ? `长期事实：\n${factLines.map((line) => `- ${line}`).join('\n')}` : '',
    sharedLines.length ? `已知共享事件：\n${sharedLines.map((line) => `- ${line}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

async function actorSectionLoreDossierBlock(user = null, sectionContexts = [], {
  actorId = '',
  query = '',
} = {}) {
  const sections = (Array.isArray(sectionContexts) ? sectionContexts : []).filter((section) => section?.id).slice(0, 4);
  const worldBookIds = new Set(sections.flatMap((section) => normalizeBindingIds(
    section.worldBookIds || section.worldBookId,
  )));
  const auEntryIds = new Set(sections.flatMap((section) => normalizeBindingIds(
    section.auEntryIds || section.auEntryId,
  )));
  const aid = clean(actorId, 180);
  const worldRows = worldBookIds.size || aid ? await listAllWorldBookRows().catch(() => []) : [];
  const byId = new Map((worldRows || []).filter((row) => row?.id).map((row) => [clean(row.id), row]));
  const activeResult = worldRows.length ? await getActiveWorldBookItems(user, clean(query, 1200), {
    characterIds: aid ? [aid] : [],
    worldBookMode: 'full',
    onlyBookIds: [...worldBookIds],
  }).catch(() => null) : null;
  const activeItems = [
    ...(Array.isArray(activeResult?.constant) ? activeResult.constant : []),
    ...(Array.isArray(activeResult?.variable) ? activeResult.variable : []),
  ];
  const worldLines = (activeItems || []).filter((row) => {
    const book = byId.get(clean(row.bookId));
    const scope = clean(book?.scope || row.scope);
    return worldBookIds.has(clean(row.id))
      || worldBookIds.has(clean(row.bookId))
      || scope === 'character'
      || scope === 'group';
  }).slice(0, 12).map((row) => `《${clean(row.name || row.id, 80)}》\n${clean(row.content, 1600)}`);
  const au = await loadAuConfigForUser(user || {});
  const auLines = (au.entries || []).filter((entry) => (
    auEntryIds.has(clean(entry?.id)) && entry.enabled !== false && clean(entry.content)
  )).map((entry) => `[${clean(entry.category || 'AU', 40)}｜${clean(entry.name, 80)}]\n${clean(entry.content, 1600)}`);
  if (!worldLines.length && !auLines.length) return '';
  return [
    '这些是该角色或常去版块明确绑定的设定，只用于约束公开足迹与发言。',
    ...worldLines,
    ...auLines,
  ].join('\n\n');
}

/** 根据真实人设或路人隐性设定，补出一页可继续深挖的公开主页足迹。 */
export async function generateForumActorDossier({
  userId = '',
  actorId = '',
  displayName = '',
  publicActivity = [],
  sectionSummary = '',
  sectionContexts = [],
  interactionSummary = '',
  request = chatForTask,
} = {}) {
  const uid = clean(userId, 160);
  const aid = clean(actorId, 180);
  const label = clean(displayName, 80) || '论坛网友';
  if (!uid || !aid) throw new Error('缺少论坛身份');
  const actor = await getCharacter(aid, { userId: uid }).catch(() => null);
  if (!actor) throw new Error('找不到论坛身份资料');
  const passerby = isForumPasserbyActor(actor);
  const actorCard = actorCardDossierBlock(actor, passerby);
  const privateChats = passerby ? '' : await actorPrivateChatDossierBlock(uid, aid);
  const structuredMemory = passerby ? '' : await actorStructuredMemoryDossierBlock(uid, aid);
  const dossierUser = await db.get('users', uid).catch(() => null);
  const sectionLore = await actorSectionLoreDossierBlock(
    dossierUser,
    sectionContexts,
    { actorId: aid, query: `${label} ${sectionSummary}` },
  );
  const activityLines = (Array.isArray(publicActivity) ? publicActivity : [])
    .slice(0, 30)
    .map((row) => `- ${clean(row?.kind) === 'post' ? '主帖' : '回复'}《${clean(row?.title, 80)}》：${clean(row?.content, 180)}`)
    .filter(Boolean);
  const rows = await loadDossierMap(uid);
  const previous = normalizeDossier(rows[dossierIdentityKey(aid, label)] || {});
  const previousClues = [
    ...previous.sections.map((row) => `版块：${row.name}`),
    ...previous.footprints.map((row) => `${row.sectionName}｜${row.title}｜${row.excerpt}`),
  ].slice(-24);
  const prompt = [
    '背景：用户正在像真人一样翻看一个论坛账户的公开主页，试图从发帖、回复、转发、评论、收藏/浏览痕迹和常逛版块中“查成分”。',
    `论坛账户：${label}`,
    actorCard ? `【仅用于保持足迹合理的人设依据 · 不可直接写进公开主页】\n${actorCard}` : '',
    privateChats ? `【仅用于防止 OOC 的私下经历 · 禁止泄露原话、真名和隐私】\n${privateChats}` : '',
    structuredMemory ? `【仅用于防止 OOC 的结构化记忆 · 只能转化为合理的公开痕迹】\n${structuredMemory}` : '',
    sectionSummary ? `常去版块：${clean(sectionSummary, 240)}` : '',
    sectionLore ? `【常去版块绑定设定】\n${sectionLore}` : '',
    interactionSummary ? `公开互动对象：${clean(interactionSummary, 240)}` : '',
    activityLines.length ? `已经真实存在的公开发言（不要重复生成）：\n${activityLines.join('\n')}` : '当前公开数据很少，可以按人设谨慎推测少量主页痕迹。',
    previousClues.length ? `以前已经翻到的线索（本轮换一页，不要重复）：\n${previousClues.map((line) => `- ${line}`).join('\n')}` : '',
    passerby
      ? '这是论坛原生路人：只从其轻量人设、已有发言和所在版块延伸，不得借用其他角色的资料。'
      : '这是已有角色的论坛马甲号：足迹必须符合具体人设，但公开页面不能直接揭露本体、匿名真名或私聊秘密。',
    '任务：只生成本轮新翻到的一小页线索。给出 3-5 个可能常逛的具体版块，以及 4-6 条具体主页足迹。版块可以尚未在论坛中实际创建。',
    '每一条 footprint 都必须同时给出 originalPost，让用户查完后可以直接进入对应原帖查看；回复、评论、收藏和浏览足迹也必须有它所指向的原帖。originalPost 只生成这一篇主帖、该账户必要的一条回复，以及 0-2 条自然楼层。',
    '这里只补齐主页足迹直接指向的原帖，不要顺带生成该版块的其他帖子或完整评论生态。版块本身可以只留下名称与线索，用户以后进入版块时再自行选择是否补充内容。',
    '生成角色马甲号的足迹与 originalPost 时，必须综合上方当前用户面具下的角色卡、结构化记忆、私聊边界，以及已有常去版块绑定的世界书 / AU；这些信息只用于防止 OOC，严禁把本体、真名或私聊秘密写到公开页面。',
    '足迹必须像真的主页记录：写清在哪个版块、对哪篇标题做了什么、留下了什么具体短句或为什么留下痕迹。不要总结“兴趣、发言风格、活跃规律、性格标签”，不要写人格鉴定报告，不要使用笼统的“经常关注生活话题”。',
    'kind 只能是 post / reply / comment / repost / visit / favorite。excerpt 是主页能看到的短句或痕迹，不是分析结论；evidence 是用户能据此产生联想的一句客观线索。',
    'originalPost.replies 只能是普通网友，不得填写 roleId、authorRoleId、forumActorId，也不得冒充当前论坛账户。只有 actorReply 表示当前论坛账户的发言。',
    '若正文使用外语或方言，同时给出对应中文翻译：originalPost.contentTranslation、actorReplyTranslation、replies[].translation；纯中文留空。',
    '只输出 JSON：{"sections":[{"name":"具体版块名","type":"生活/兴趣/地区等","clue":"从哪些公开痕迹看出来"}],"footprints":[{"kind":"reply","sectionName":"具体版块名","sectionType":"版块类型","title":"原帖标题","excerpt":"TA 当时留下的具体短句或主页可见痕迹","actionLabel":"回复过","timestampHint":"两周前","evidence":"哪处蛛丝马迹","originalPost":{"title":"原帖标题","content":"主帖正文","contentTranslation":"非中文正文的中文翻译","originalAuthor":"非本人主帖时的普通网友昵称","originalAuthorPersonality":"普通网友轻人设","originalAuthorSpeechStyle":"普通网友口吻","actorReply":"该账户确实回复时才填写","actorReplyTranslation":"该回复的中文翻译","replies":[{"author":"其他网友昵称","content":"楼层回复","translation":"该回复的中文翻译"}]}}]}',
  ].filter(Boolean).join('\n\n');
  const raw = await request([
    { role: 'system', content: prompt },
    { role: 'user', content: '请按上述规则生成本轮新翻到的论坛主页线索 JSON。' },
  ], { temperature: 0.72 }, 'forumProfile');
  const payload = extractJsonObject(raw);
  const payloadFootprints = (Array.isArray(payload.footprints) ? payload.footprints : []).slice(0, 6);
  const batch = normalizeDossier({ ...payload, footprints: payloadFootprints, generatedAt: Date.now() });
  const mergedSections = [...previous.sections];
  for (const item of batch.sections) {
    if (!mergedSections.some((row) => nameKey(row.name) === nameKey(item.name))) mergedSections.push(item);
  }
  const mergedFootprints = [...previous.footprints];
  for (const item of batch.footprints) {
    if (!mergedFootprints.some((row) => row.id === item.id)) mergedFootprints.push(item);
  }
  const dossier = normalizeDossier({
    version: DOSSIER_VERSION,
    sections: mergedSections.slice(-24),
    footprints: mergedFootprints.slice(-40),
    rounds: previous.rounds + 1,
    generatedAt: Date.now(),
  });
  rows[dossierIdentityKey(aid, label)] = dossier;
  await db.put('settings', { key: dossierSettingsKey(uid), value: rows });
  return dossier;
}

function dossierActionLabel(kind = '') {
  return ({
    post: '发布过',
    reply: '回复过',
    comment: '评论过',
    repost: '转发过',
    visit: '浏览过',
    favorite: '收藏过',
  })[normalizeFootprintKind(kind)] || '浏览过';
}

async function saveMaterializedDossierFootprint(userId, actorId, displayName, footprintId, patch = {}) {
  const rows = await loadDossierMap(userId);
  const key = dossierIdentityKey(actorId, displayName);
  const dossier = normalizeDossier(rows[key] || {});
  dossier.footprints = dossier.footprints.map((row) => (
    row.id === footprintId ? normalizeDossierFootprint({ ...row, ...patch }) : row
  ));
  dossier.sections = dossier.sections.map((row) => (
    nameKey(row.name) === nameKey(patch.sectionName)
      ? normalizeDossierSection({ ...row, sectionId: patch.sectionId, threadId: patch.threadId, materializedAt: patch.materializedAt })
      : row
  ));
  rows[key] = dossier;
  await db.put('settings', { key: dossierSettingsKey(userId), value: rows });
  return dossier;
}

async function findMaterializedDossierThread(userId = '', actorId = '', footprintId = '') {
  const uid = clean(userId, 160);
  const aid = clean(actorId, 180);
  const fid = clean(footprintId, 120);
  if (!uid || !aid || !fid) return null;
  let threads = [];
  try {
    threads = await db.getAllByIndex('forumThreads', 'userId', uid);
  } catch (_) {
    threads = (await db.getAllRecords('forumThreads')).filter((thread) => clean(thread?.userId, 160) === uid);
  }
  return threads.find((thread) => (
    clean(thread?.footprintSource?.actorId, 180) === aid
    && clean(thread?.footprintSource?.footprintId, 120) === fid
  )) || null;
}

/** 点击推测版块时只建立可进入的版块壳，不替用户生成额外帖子。 */
export async function materializeForumDossierSection({
  userId = '',
  actorId = '',
  displayName = '',
  section: rawSection = null,
} = {}) {
  const uid = clean(userId, 160);
  const aid = clean(actorId, 180);
  const label = clean(displayName, 80) || '论坛网友';
  const clue = normalizeDossierSection(rawSection || {});
  if (!uid || !aid || !clue) throw new Error('这条版块线索缺少必要信息');
  const meta = await loadForumMetaCompat(uid);
  const sections = Array.isArray(meta.sections) ? [...meta.sections] : [];
  let section = sections.find((row) => clean(row.id) === clue.sectionId)
    || sections.find((row) => nameKey(row.name) === nameKey(clue.name));
  let created = false;
  if (!section) {
    section = {
      id: `forum_trace_section_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: clue.name,
      type: clue.type || '闲聊',
      desc: clue.clue || `围绕「${clue.name}」的社区讨论。`,
      worldBookIds: [],
      auEntryIds: [],
      createdFromActorFootprint: aid,
    };
    sections.push(section);
    await saveForumMetaCompat(uid, { ...meta, sections });
    created = true;
  }
  const rows = await loadDossierMap(uid);
  const key = dossierIdentityKey(aid, label);
  const dossier = normalizeDossier(rows[key] || {});
  dossier.sections = dossier.sections.map((row) => (
    row.id === clue.id || nameKey(row.name) === nameKey(clue.name)
      ? normalizeDossierSection({ ...row, sectionId: section.id, materializedAt: Date.now() })
      : row
  ));
  rows[key] = dossier;
  await db.put('settings', { key: dossierSettingsKey(uid), value: rows });
  return { sectionId: section.id, created };
}

/** 点击一条推测足迹时，只补出对应版块与一篇原帖，并把入口回写到主页。 */
export async function materializeForumDossierFootprint({
  user = null,
  actorId = '',
  displayName = '',
  footprint = null,
  threadDraft = null,
  request = chatForTask,
} = {}) {
  const uid = clean(user?.id, 160);
  const aid = clean(actorId, 180);
  const label = clean(displayName, 80) || '论坛网友';
  const clue = normalizeDossierFootprint(footprint || {});
  if (!uid || !aid || !clue) throw new Error('这条足迹缺少必要信息');
  if (clue.threadId) {
    const existing = await db.get('forumThreads', clue.threadId).catch(() => null);
    if (existing) return { thread: existing, sectionId: existing.sectionId, created: false };
  }
  const materialized = await findMaterializedDossierThread(uid, aid, clue.id);
  if (materialized) {
    await saveMaterializedDossierFootprint(uid, aid, label, clue.id, {
      sectionId: materialized.sectionId,
      threadId: materialized.id,
      materializedAt: Number(materialized.timestamp || Date.now()),
    });
    return { thread: materialized, sectionId: materialized.sectionId, created: false };
  }
  const actor = await getCharacter(aid, { userId: uid }).catch(() => null);
  if (!actor) throw new Error('找不到这个论坛身份');
  const passerby = isForumPasserbyActor(actor);
  const actorCard = actorCardDossierBlock(actor, passerby);
  const privateContext = passerby ? '' : await actorPrivateChatDossierBlock(uid, aid);
  const structuredMemory = passerby ? '' : await actorStructuredMemoryDossierBlock(uid, aid);
  const meta = await loadForumMetaCompat(uid);
  const sections = Array.isArray(meta.sections) ? [...meta.sections] : [];
  let section = sections.find((row) => clean(row.id) === clue.sectionId)
    || sections.find((row) => nameKey(row.name) === nameKey(clue.sectionName));
  let sectionCreated = false;
  if (!section) {
    section = {
      id: stableTraceId('forum_trace_section', [uid, clue.sectionName]),
      name: clue.sectionName,
      type: clue.sectionType || '闲聊',
      desc: `围绕「${clue.sectionName}」的社区讨论。`,
      worldBookIds: [],
      auEntryIds: [],
      createdFromActorFootprint: aid,
    };
    sections.push(section);
    sectionCreated = true;
  }
  const sectionLore = await actorSectionLoreDossierBlock(user, [section], {
    actorId: aid,
    query: `${label} ${clue.sectionName} ${clue.title} ${clue.excerpt}`,
  });
  const actionLabel = clue.actionLabel || dossierActionLabel(clue.kind);
  const prompt = [
    '背景：用户刚从一个论坛账户的公开主页足迹点进原帖。现在只补全这一篇帖子，让它成为可真实浏览的论坛内容。',
    `论坛账户：${label}`,
    `足迹：${actionLabel}｜版块「${clue.sectionName}」｜原帖《${clue.title}》`,
    clue.excerpt ? `主页留下的短句/痕迹：${clue.excerpt}` : '',
    clue.evidence ? `线索：${clue.evidence}` : '',
    actorCard ? `【仅用于保持人物一致，不得暴露本体】\n${actorCard}` : '',
    privateContext ? `【仅用于防止 OOC，不得照抄私聊或揭露真名】\n${privateContext}` : '',
    structuredMemory ? `【仅用于防止 OOC 的结构化记忆，只能转化为合理的公开痕迹】\n${structuredMemory}` : '',
    sectionLore ? `【这个版块绑定的世界书 / AU 设定】\n${sectionLore}` : '',
    clue.kind === 'post' || clue.kind === 'repost'
      ? `这篇主帖由 ${label} 发布；正文要自然承接主页足迹。`
      : clue.kind === 'reply' || clue.kind === 'comment'
        ? `这篇主帖由普通网友发布，${label} 在楼层中留下与主页足迹一致的具体回复。`
        : `这篇主帖由普通网友发布；${label} 只留下浏览/收藏痕迹，不强行让 TA 发言。`,
    '再生成 1-3 条自然楼层增加真实感。普通网友要有不同立场，不要写成同一种口吻。',
    'originalAuthor 与 replies[].author 不得写 user、用户、当前用户 id/显示名或用户论坛马甲名；禁止代替当前用户发帖或回复。',
    '只输出 JSON：{"title":"原帖标题","content":"主帖正文","originalAuthor":"普通网友昵称（仅非本人主帖时）","originalAuthorPersonality":"普通网友轻人设","originalAuthorSpeechStyle":"普通网友口吻","actorReply":"该账户的具体回复；没有发言则留空","replies":[{"author":"其他网友昵称","content":"楼层回复"}]}',
  ].filter(Boolean).join('\n\n');
  const cachedDraft = threadDraft && typeof threadDraft === 'object' ? threadDraft : clue.threadDraft;
  const parsed = cachedDraft && typeof cachedDraft === 'object'
    ? cachedDraft
    : extractJsonObject(await request(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: '请按上述完整论坛身份、世界书与公开足迹补全这一篇原帖 JSON。' },
      ],
      { temperature: 0.82 },
      'forumProfileTrace',
    ));
  const now = await getVirtualNow(uid, 0).catch(() => Date.now());
  const actorOwnsPost = clue.kind === 'post' || clue.kind === 'repost';
  const otherAuthor = clean(parsed.originalAuthor, 80) || '路过的人';
  const knownActors = { [aid]: actor };
  const normalizedMainAuthor = sanitizeGeneratedForumAuthor({
    authorName: actorOwnsPost ? label : otherAuthor,
    authorRoleId: actorOwnsPost ? aid : '',
    authorId: actorOwnsPost ? aid : '',
  }, knownActors, { user, userId: uid });
  const thread = {
    id: stableTraceId('forum_trace', [uid, aid, clue.id]),
    userId: uid,
    sectionId: section.id,
    title: clean(parsed.title, 120) || clue.title,
    content: clean(parsed.content, 4000) || clue.excerpt || '这条讨论没有留下更多正文。',
    contentTranslation: sanitizeAiTranslation(
      clean(parsed.content, 4000) || clue.excerpt || '这条讨论没有留下更多正文。',
      parsed.contentTranslation || parsed.zh || parsed.translation || '',
    ),
    authorName: normalizedMainAuthor.authorName,
    authorRoleId: normalizedMainAuthor.authorRoleId,
    forumActorId: normalizedMainAuthor.authorRoleId,
    forumIdentityKind: actorOwnsPost ? (passerby ? 'passerby' : 'character') : '',
    authorSource: 'generated',
    authorPersonality: actorOwnsPost ? '' : clean(parsed.originalAuthorPersonality, 700),
    authorSpeechStyle: actorOwnsPost ? '' : clean(parsed.originalAuthorSpeechStyle, 500),
    timestamp: now,
    footprintSource: { actorId: aid, footprintId: clue.id, kind: clue.kind },
    replies: [],
  };
  if (['reply', 'comment'].includes(clue.kind) && clean(parsed.actorReply, 800)) {
    thread.replies.push({
      author: label,
      authorRoleId: aid,
      forumActorId: aid,
      forumIdentityKind: passerby ? 'passerby' : 'character',
      authorSource: 'generated',
      content: clean(parsed.actorReply, 800),
      translation: sanitizeAiTranslation(
        clean(parsed.actorReply, 800),
        parsed.actorReplyTranslation || parsed.actorReplyZh || '',
      ),
      timestamp: now + 1000,
      childReplies: [],
    });
  }
  for (const [index, reply] of (Array.isArray(parsed.replies) ? parsed.replies : []).slice(0, 3).entries()) {
    const content = clean(reply?.content || reply?.text, 800);
    if (!content) continue;
    const identity = sanitizeGeneratedForumReplyAuthor({
      ...reply,
      authorRoleId: '',
      forumActorId: '',
      roleId: '',
      characterId: '',
    }, {}, {
      user,
      strictRoleScope: true,
    });
    thread.replies.push({
      author: identity.author || `网友${index + 1}`,
      authorSource: identity.authorSource,
      authorRoleId: identity.authorRoleId,
      forumActorId: identity.forumActorId,
      content,
      translation: sanitizeAiTranslation(content, reply?.translation || reply?.zh || ''),
      timestamp: now + (index + 2) * 1000,
      childReplies: [],
    });
  }
  if (sectionCreated) {
    await saveForumMetaCompat(uid, { ...meta, sections });
  }
  await db.put('forumThreads', thread);
  await materializeForumActors({ userId: uid, user, threads: [thread] });
  await saveMaterializedDossierFootprint(uid, aid, label, clue.id, {
    sectionName: section.name,
    sectionId: section.id,
    threadId: thread.id,
    materializedAt: now,
  });
  return { thread, sectionId: section.id, created: true };
}

function nameKey(value = '') {
  return clean(value, 80).toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
}

function isGenericForumName(value = '') {
  const name = clean(value);
  return !name || /^(匿名|匿名网友|匿名观众|论坛匿名|路人|网友|某网友|游客|guest)$/i.test(name);
}

function avatarUrl(sticker = null) {
  const url = clean(sticker?.url || sticker?.src || sticker?.image || sticker?.dataUrl, 900000);
  return /^(?:https?:\/\/|data:image\/|blob:)/i.test(url) ? url : '';
}

function pickRandomStickerAvatar(stickerPool = []) {
  const rows = (Array.isArray(stickerPool) ? stickerPool : []).filter((row) => avatarUrl(row));
  if (!rows.length) return '';
  return avatarUrl(rows[Math.floor(Math.random() * rows.length)]);
}

function normalizeRegistry(raw = {}) {
  const rows = Array.isArray(raw?.actors) ? raw.actors : [];
  return {
    version: REGISTRY_VERSION,
    actors: rows.map((row) => ({
      actorId: clean(row?.actorId, 180),
      displayName: clean(row?.displayName, 80),
      signature: clean(row?.signature, 180),
      createdAt: Number(row?.createdAt) || 0,
      lastSeenAt: Number(row?.lastSeenAt) || 0,
    })).filter((row) => row.actorId && row.displayName).slice(0, MAX_PASSERBY_ROWS),
  };
}

export async function loadForumActorRegistry(userId = '') {
  const row = await db.get('settings', registryKey(userId)).catch(() => null);
  return normalizeRegistry(row?.value || {});
}

async function saveForumActorRegistry(userId = '', registry = {}) {
  const value = normalizeRegistry(registry);
  await db.put('settings', { key: registryKey(userId), value });
  return value;
}

async function ensureForumPasserby({
  userId,
  displayName,
  signature = '',
  personality = '',
  speechStyle = '',
  background = '',
  interests = [],
  useStickerAvatars = false,
  stickerPool = [],
  registry,
} = {}) {
  const label = clean(displayName, 80);
  if (!label || isGenericForumName(label)) return null;
  const key = nameKey(label);
  const existingEntry = registry.actors.find((row) => nameKey(row.displayName) === key);
  if (existingEntry?.actorId) {
    const existing = await getCharacter(existingEntry.actorId).catch(() => null);
    if (existing) {
      if (Date.now() - Number(existingEntry.lastSeenAt || 0) > 6 * 3600_000) {
        existingEntry.lastSeenAt = Date.now();
      }
      const nextDraft = existing.anonymousPrivateDraft && typeof existing.anonymousPrivateDraft === 'object'
        ? { ...existing.anonymousPrivateDraft }
        : {};
      const patch = { ...existing };
      const nextPersonality = clean(personality, 700);
      const nextSpeechStyle = clean(speechStyle, 500);
      const nextBackground = clean(background, 600);
      const nextInterests = (Array.isArray(interests) ? interests : [])
        .map((value) => clean(value, 40)).filter(Boolean).slice(0, 8);
      let actorDirty = false;
      if (nextPersonality && (!clean(existing.personality) || existing.personality === '有自己的兴趣与立场，会记得在论坛里参与过的讨论。')) {
        patch.personality = nextPersonality;
        actorDirty = true;
      }
      if (nextSpeechStyle && (!clean(existing.speechStyle) || existing.speechStyle === '保持自然、简短的论坛口吻，不刻意迎合所有人。')) {
        patch.speechStyle = nextSpeechStyle;
        actorDirty = true;
      }
      if (nextBackground && (!clean(nextDraft.background) || nextDraft.background === '最初是在论坛里认识的网友。')) {
        nextDraft.background = nextBackground;
        actorDirty = true;
      }
      if (nextInterests.length && !(Array.isArray(nextDraft.interests) && nextDraft.interests.length)) {
        nextDraft.interests = nextInterests;
        actorDirty = true;
      }
      if (actorDirty) patch.anonymousPrivateDraft = nextDraft;
      if (useStickerAvatars && !clean(existing.avatar)) {
        const avatar = pickRandomStickerAvatar(stickerPool);
        if (avatar) {
          patch.avatar = avatar;
          actorDirty = true;
        }
      }
      const saved = actorDirty ? await saveCharacter(patch) : existing;
      return { actorId: existing.id, character: saved, entry: existingEntry };
    }
  }

  const avatar = useStickerAvatars ? pickRandomStickerAvatar(stickerPool) : '';
  await ensureAnonNpcGroup();
  const character = await saveCharacter(createCharacterProfile({
    name: label,
    avatar: avatar || null,
    groupId: 'anon_npc',
    roleTier: 'npc',
    currentRole: '论坛网友',
    personality: clean(personality, 700) || '有自己的兴趣与立场，会记得在论坛里参与过的讨论。',
    speechStyle: clean(speechStyle, 500) || '保持自然、简短的论坛口吻，不刻意迎合所有人。',
    notes: clean(signature, 180) || `论坛昵称：${label}`,
    anonymousLifecycle: {
      phase: 'temporary',
      retained: true,
      sourceChatIds: [],
    },
    anonymousPrivateDraft: {
      realName: '',
      currentRole: '',
      background: clean(background, 600) || '最初是在论坛里认识的网友。',
      interests: (Array.isArray(interests) ? interests : [])
        .map((value) => clean(value, 40)).filter(Boolean).slice(0, 8),
      revealNote: '',
    },
    forumIdentity: {
      kind: 'passerby',
      userId: clean(userId, 160),
      displayName: label,
      signature: clean(signature, 180),
      createdAt: Date.now(),
    },
    isCustom: true,
  }));
  const entry = {
    actorId: character.id,
    displayName: label,
    signature: clean(signature, 180),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  registry.actors.unshift(entry);
  registry.actors = registry.actors.slice(0, MAX_PASSERBY_ROWS);
  return { actorId: character.id, character, entry };
}

function actorRoleId(row = {}) {
  return clean(row.forumActorId || row.authorRoleId || row.roleId || row.characterId || row.authorId, 180);
}

function actorDisplayName(row = {}) {
  return clean(row.authorName || row.author || row.name || row.authorAlias, 80) || '论坛匿名';
}

async function materializeRow(row, context) {
  if (!row || typeof row !== 'object') return false;
  const source = resolveForumAuthorSource(row, context.user || {});
  if (source === 'user') {
    if (row.forumIdentityKind !== 'user') {
      row.forumIdentityKind = 'user';
      return true;
    }
    return false;
  }
  const sanitized = sanitizeGeneratedForumReplyAuthor(row, {}, {
    user: context.user || {},
    forbiddenNames: [context.userId, ...(context.forbiddenNames || [])],
  });
  let identityChanged = false;
  if (generatedActorName(row) !== sanitized.author) {
    setGeneratedActorName(row, sanitized.author);
    identityChanged = true;
  }
  if (row.authorRoleId !== sanitized.authorRoleId) {
    row.authorRoleId = sanitized.authorRoleId;
    identityChanged = true;
  }
  if (row.forumActorId !== sanitized.forumActorId) {
    row.forumActorId = sanitized.forumActorId;
    identityChanged = true;
  }
  const stableActorId = clean(row.forumActorId, 180);
  if (stableActorId && row.forumIdentityKind === 'character') return identityChanged;
  if (stableActorId && row.forumIdentityKind === 'passerby' && context.useStickerAvatars !== true) {
    return identityChanged;
  }
  const roleId = actorRoleId(row);
  if (roleId && !String(roleId).startsWith('forum_')) {
    const knownActor = await getCharacter(roleId).catch(() => null);
    if (knownActor) {
      const knownPasserby = isForumPasserbyActor(knownActor);
      let changed = false;
      if (row.forumActorId !== roleId) { row.forumActorId = roleId; changed = true; }
      const kind = knownPasserby ? 'passerby' : 'character';
      if (row.forumIdentityKind !== kind) { row.forumIdentityKind = kind; changed = true; }
      return changed || identityChanged;
    }
    if (row.authorRoleId) row.authorRoleId = '';
    if (row.forumActorId) row.forumActorId = '';
  }
  const profile = row.authorProfile && typeof row.authorProfile === 'object' ? row.authorProfile : {};
  const passerby = await ensureForumPasserby({
    ...context,
    displayName: actorDisplayName(row),
    signature: row.authorSignature || row.signature || '',
    personality: row.authorPersonality || profile.personality || row.personality || '',
    speechStyle: row.authorSpeechStyle || profile.speechStyle || row.speechStyle || '',
    background: row.authorBackground || profile.background || '',
    interests: row.authorInterests || profile.interests || [],
  });
  if (!passerby?.actorId) return identityChanged;
  let changed = identityChanged;
  if (row.forumActorId !== passerby.actorId) { row.forumActorId = passerby.actorId; changed = true; }
  if (row.forumIdentityKind !== 'passerby') { row.forumIdentityKind = 'passerby'; changed = true; }
  return changed;
}

async function walkReplyRows(rows = [], context) {
  let changed = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (await materializeRow(row, context)) changed = true;
    if (await walkReplyRows(row.childReplies, context)) changed = true;
  }
  return changed;
}

/**
 * 为旧帖和新生成内容补稳定 forumActorId。普通路人会落成隐藏 anon_npc，
 * 后续主页、私聊和转正都沿用同一个 actorId。
 */
export async function materializeForumActors({
  userId = '',
  user = {},
  forbiddenNames = [],
  threads = [],
  useStickerAvatars = false,
  stickerPool = [],
} = {}) {
  const registry = await loadForumActorRegistry(userId);
  const previousSnapshot = JSON.stringify(registry);
  registry.actors = registry.actors.filter((entry) => !generatedForumAuthorClaimsCurrentUser({
    authorName: entry.displayName,
  }, user, { forbiddenNames: [userId, ...forbiddenNames] }));
  let registryDirty = false;
  for (const thread of Array.isArray(threads) ? threads : []) {
    let changed = await materializeRow(thread, {
      userId,
      user,
      forbiddenNames,
      useStickerAvatars,
      stickerPool,
      registry,
    });
    if (await walkReplyRows(thread.replies, {
      userId,
      user,
      forbiddenNames,
      useStickerAvatars,
      stickerPool,
      registry,
    })) changed = true;
    if (changed && thread.id) await db.put('forumThreads', thread);
  }
  registryDirty = previousSnapshot !== JSON.stringify(registry);
  if (registryDirty) await saveForumActorRegistry(userId, registry);
  await syncForumRelationshipsFromThreads({ userId, user, threads }).catch(() => null);
  return { threads, registry, changed: registryDirty };
}

export async function buildForumPasserbyRosterBlock(userId = '') {
  const registry = await loadForumActorRegistry(userId);
  if (!registry.actors.length) {
    return [
      '【论坛路人池 · 首次建立】',
      '当前没有常驻路人。需要普通路人时创建少量有辨识度的新网友，并为每个新路人输出 authorPersonality、authorSpeechStyle、authorBackground、authorInterests，供主页与后续回归使用。',
      '新路人的性格与兴趣要从本次发言和所在版块自然生长，彼此有差异；不要生成一批只换昵称的同质账号。',
    ].join('\n');
  }
  const rows = [];
  for (const entry of registry.actors.slice(0, 24)) {
    const actor = await getCharacter(entry.actorId).catch(() => null);
    if (!actor) continue;
    const interests = Array.isArray(actor.anonymousPrivateDraft?.interests)
      ? actor.anonymousPrivateDraft.interests.map((value) => clean(value, 24)).filter(Boolean).slice(0, 4).join('、')
      : '';
    rows.push(`- forumActorId=${entry.actorId}；论坛名=${entry.displayName}；性格=${clean(actor.personality, 80) || '未注明'}；口吻=${clean(actor.speechStyle, 60) || '自然'}${interests ? `；兴趣=${interests}` : ''}`);
  }
  if (!rows.length) return '';
  return [
    '【论坛常驻路人池】',
    '这些是以前出现过的普通论坛网友。需要路人时按长期约 65% 常驻路人、35% 新路人的比例安排：有 3 个以上路人席位时优先约 2 旧 1 新；只有 1 个席位时通常复用合适旧人，但不要每轮固定同一位。',
    '复用旧人必须填写池中真实 forumActorId，并保持昵称、人设和口吻；禁止编造 forumActorId。新路人不填 forumActorId，同时输出 authorPersonality、authorSpeechStyle、authorBackground、authorInterests，供系统建立稳定身份。',
    '比例按多轮整体维持，不要求每一小轮硬塞新人；新路人要有版块相关的出现理由，常驻路人也不要每轮全部出场。',
    rows.join('\n'),
  ].join('\n');
}

function generatedActorRoleId(row = {}) {
  return clean(row.authorRoleId || row.roleId || row.characterId || row.authorId, 180);
}

function generatedActorName(row = {}) {
  return clean(row.authorName || row.author || row.authorAlias || row.name, 80);
}

function setGeneratedActorName(row = {}, name = '') {
  const label = clean(name, 80) || '论坛网友';
  if (Object.prototype.hasOwnProperty.call(row, 'author') && !Object.prototype.hasOwnProperty.call(row, 'authorName')) {
    row.author = label;
  } else {
    row.authorName = label;
  }
  if (row.authorAlias != null) row.authorAlias = label;
}

function walkGeneratedActorRows(roots = []) {
  const out = [];
  const walk = (rows) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== 'object') continue;
      out.push(row);
      walk(row.replies || row.comments);
      walk(row.childReplies);
    }
  };
  walk(roots);
  return out;
}

async function loadActorMixState(userId = '') {
  const row = await db.get('settings', actorMixStateKey(userId)).catch(() => null);
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  const usage = value.actorUsage && typeof value.actorUsage === 'object' ? value.actorUsage : {};
  return {
    returningAppearances: Math.max(0, Number(value.returningAppearances) || 0),
    newAppearances: Math.max(0, Number(value.newAppearances) || 0),
    actorUsage: usage,
    updatedAt: Number(value.updatedAt) || 0,
  };
}

async function loadCharacterAliasPool(userId = '') {
  const row = await db.get('settings', characterAliasPoolKey(userId)).catch(() => null);
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return value.accounts && typeof value.accounts === 'object' ? value : { version: 1, accounts: {} };
}

function normalizeAliasAccount(raw = {}) {
  return {
    displayName: clean(raw.displayName || raw.name, 80),
    signature: clean(raw.signature, 180),
    useCount: Math.max(0, Number(raw.useCount) || 0),
    lastUsedAt: Number(raw.lastUsedAt) || 0,
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

/**
 * 对一次生成结果做确定性身份规划：长期维持约 65% 常驻路人，并为角色复用固定马甲池。
 * roots 可同时包含主帖、回复或 replyUpdates[].replies。
 */
export async function applyForumGenerationActorPlan({
  userId = '',
  user = {},
  forbiddenNames = [],
  roots = [],
  knownCharacterIds = [],
  signal = null,
} = {}) {
  const uid = clean(userId, 160);
  if (!uid || signal?.aborted) return { returning: 0, newcomers: 0, characters: 0, skipped: !!signal?.aborted };
  const rows = walkGeneratedActorRows(roots);
  if (!rows.length) return { returning: 0, newcomers: 0, characters: 0 };
  const knownIds = new Set((Array.isArray(knownCharacterIds) ? knownCharacterIds : [])
    .map((value) => clean(value, 180)).filter(Boolean));
  const [registry, mixState, aliasPool] = await Promise.all([
    loadForumActorRegistry(uid),
    loadActorMixState(uid),
    loadCharacterAliasPool(uid),
  ]);
  registry.actors = registry.actors.filter((entry) => !generatedForumAuthorClaimsCurrentUser({
    authorName: entry.displayName,
  }, user, { forbiddenNames: [uid, ...forbiddenNames] }));
  // 本步骤只是论坛身份连续性的增强，不能反过来卡住已经成功返回的帖子正文。
  // 调用方超时放行后，等待中的 IndexedDB 若晚到这里，应立即停止，不再修改 rows。
  if (signal?.aborted) return { returning: 0, newcomers: 0, characters: 0, skipped: true };
  const registryById = new Map(registry.actors.map((entry) => [entry.actorId, entry]));
  const passerbyRows = [];
  let characterCount = 0;
  let aliasDirty = false;
  const now = Date.now();

  for (const row of rows) {
    const roleId = generatedActorRoleId(row);
    if (roleId && knownIds.has(roleId)) {
      const rawName = generatedActorName(row) || '论坛小号';
      const accounts = (Array.isArray(aliasPool.accounts[roleId]) ? aliasPool.accounts[roleId] : [])
        .map(normalizeAliasAccount)
        .filter((account) => account.displayName)
        .filter((account) => !generatedForumAuthorClaimsCurrentUser({
          authorName: account.displayName,
        }, user, { forbiddenNames: [uid, ...forbiddenNames] }));
      let account = accounts.find((item) => nameKey(item.displayName) === nameKey(rawName));
      if (!account && accounts.length < 2) {
        account = normalizeAliasAccount({ displayName: rawName, createdAt: now });
        accounts.push(account);
      }
      if (!account) {
        account = accounts.slice().sort((a, b) => a.useCount - b.useCount || a.lastUsedAt - b.lastUsedAt)[0];
      }
      if (account) {
        setGeneratedActorName(row, account.displayName);
        row.authorAlias = account.displayName;
        row.authorRoleId = roleId;
        row.forumActorId = roleId;
        account.useCount += 1;
        account.lastUsedAt = now;
        aliasPool.accounts[roleId] = accounts;
        aliasDirty = true;
      }
      characterCount += 1;
      continue;
    }
    if (roleId && !knownIds.has(roleId)) {
      row.authorRoleId = '';
      if (!registryById.has(clean(row.forumActorId, 180))) row.forumActorId = '';
    }
    passerbyRows.push(row);
  }

  let returning = 0;
  const usedThisBatch = new Set();
  const batchUsage = {};
  for (const row of passerbyRows) {
    const actorId = clean(row.forumActorId, 180);
    const entry = registryById.get(actorId);
    if (!entry) {
      row.forumActorId = '';
      continue;
    }
    setGeneratedActorName(row, entry.displayName);
    row.authorRoleId = '';
    usedThisBatch.add(actorId);
    batchUsage[actorId] = (batchUsage[actorId] || 0) + 1;
    returning += 1;
  }

  const previousTotal = mixState.returningAppearances + mixState.newAppearances;
  const targetReturningTotal = Math.round((previousTotal + passerbyRows.length) * 0.65);
  const targetReturningThisBatch = registry.actors.length
    ? Math.max(0, Math.min(passerbyRows.length, targetReturningTotal - mixState.returningAppearances))
    : 0;
  let needReturning = Math.max(0, targetReturningThisBatch - returning);
  const candidates = registry.actors.filter((entry) => registryById.has(entry.actorId));

  for (const row of passerbyRows) {
    if (!needReturning || clean(row.forumActorId, 180) || !candidates.length) continue;
    const entry = candidates.slice().sort((a, b) => {
      const aUsage = mixState.actorUsage[a.actorId] || {};
      const bUsage = mixState.actorUsage[b.actorId] || {};
      const aBatchPenalty = (batchUsage[a.actorId] || 0) * 1_000_000;
      const bBatchPenalty = (batchUsage[b.actorId] || 0) * 1_000_000;
      return aBatchPenalty - bBatchPenalty
        || (Number(aUsage.count) || 0) - (Number(bUsage.count) || 0)
        || (Number(aUsage.lastUsedAt) || 0) - (Number(bUsage.lastUsedAt) || 0);
    })[0];
    if (!entry) continue;
    row.forumActorId = entry.actorId;
    row.authorRoleId = '';
    setGeneratedActorName(row, entry.displayName);
    usedThisBatch.add(entry.actorId);
    batchUsage[entry.actorId] = (batchUsage[entry.actorId] || 0) + 1;
    returning += 1;
    needReturning -= 1;
  }

  for (const actorId of usedThisBatch) {
    const usage = mixState.actorUsage[actorId] || {};
    mixState.actorUsage[actorId] = {
      count: Math.max(0, Number(usage.count) || 0) + (batchUsage[actorId] || 0),
      lastUsedAt: now,
    };
  }
  const newcomers = Math.max(0, passerbyRows.length - returning);
  mixState.returningAppearances += returning;
  mixState.newAppearances += newcomers;
  mixState.updatedAt = now;
  if (signal?.aborted) return { returning, newcomers, characters: characterCount, skipped: true };
  await db.put('settings', { key: actorMixStateKey(uid), value: mixState });
  if (aliasDirty) {
    if (signal?.aborted) return { returning, newcomers, characters: characterCount, skipped: true };
    aliasPool.version = 1;
    aliasPool.updatedAt = now;
    await db.put('settings', { key: characterAliasPoolKey(uid), value: aliasPool });
  }
  return { returning, newcomers, characters: characterCount };
}

/**
 * 身份规划是可选增强。模型正文已经成功返回后，即使本地身份索引暂时卡住，
 * 也必须按时把帖子/楼层写入主库，不能让页面永久停在“正在生成”。
 */
export async function applyForumGenerationActorPlanBestEffort(options = {}, {
  timeoutMs = 12_000,
  planner = applyForumGenerationActorPlan,
} = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const limit = Math.max(25, Number(timeoutMs) || 12_000);
  let timer = 0;
  const task = Promise.resolve()
    .then(() => planner({
      ...options,
      signal: controller?.signal || null,
    }))
    .then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      try { controller?.abort(); } catch (_) {}
      resolve({ ok: false, timedOut: true });
    }, limit);
  });
  const result = await Promise.race([task, deadline]);
  if (timer) clearTimeout(timer);
  return result;
}

export async function buildForumCharacterAliasRosterBlock(userId = '', characters = [], user = {}) {
  const pool = await loadCharacterAliasPool(userId);
  const allowedIds = new Set((Array.isArray(characters) ? characters : [])
    .map((character) => clean(character?.id, 180)).filter(Boolean));
  const rows = Object.entries(pool.accounts || {}).flatMap(([actorId, accounts]) => {
    if (allowedIds.size && !allowedIds.has(actorId)) return [];
    const labels = (Array.isArray(accounts) ? accounts : [])
      .map((account) => clean(account?.displayName, 80))
      .filter(Boolean)
      .filter((displayName) => !generatedForumAuthorClaimsCurrentUser({ authorName: displayName }, user, {
        forbiddenNames: [userId],
      }))
      .slice(0, 2);
    return labels.length ? [`- authorRoleId=${actorId}；固定论坛马甲=${labels.join(' / ')}`] : [];
  });
  if (!rows.length) return '';
  return [
    '【角色论坛马甲池】',
    '角色发帖或回复时优先复用自己已有的固定马甲名；同一马甲保持口吻与身份连续。需要新马甲时最多为同一角色保留两个，系统会在落库前统一。',
    rows.join('\n'),
  ].join('\n');
}

export async function resolveForumActor(actorId = '') {
  const id = clean(actorId, 180);
  return id ? getCharacter(id).catch(() => null) : null;
}

export function isForumPasserbyActor(actor = null) {
  return isAnonymousNpcCharacter(actor) && actor?.forumIdentity?.kind === 'passerby';
}

function tinyHash(value = '') {
  let hash = 2166136261;
  for (const ch of String(value || '')) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function ensureForumAliasAccount({ userId, ownerType, ownerId, identity = {}, personaOverlay = '' } = {}) {
  const accountId = `forum_alias_${tinyHash(`${userId}:${ownerType}:${ownerId}:${identity.displayName || ''}`)}`;
  return saveAliasAccount({
    id: accountId,
    ownerType,
    ownerId,
    userId,
    displayName: clean(identity.displayName, 60) || '论坛用户',
    handle: clean(identity.handle || identity.displayName, 60) || 'forum_user',
    avatar: clean(identity.avatar, 900000),
    bio: clean(identity.signature || identity.bio, 300),
    windowLabel: '论坛私信',
    personaOverlay: clean(personaOverlay, 4000),
    createdBy: 'user',
    status: 'active',
  });
}

/** 根据论坛前台身份打开私聊。路人走匿名私聊；已有角色论坛号走马甲陌生窗。 */
export async function openForumActorPrivateChat({
  user,
  actor,
  actorDisplayName = '',
  actorAvatar = '',
  actorSignature = '',
  userForumProfile = {},
} = {}) {
  const userId = clean(user?.id, 160);
  const actorId = clean(actor?.id, 180);
  if (!userId || !actorId) throw new Error('缺少论坛私聊对象');
  const forumName = clean(actorDisplayName, 80) || clean(actor?.forumIdentity?.displayName, 80) || clean(actor?.name, 80) || '论坛网友';
  const userForumName = clean(userForumProfile?.displayName, 80) || clean(user?.nickname || user?.name, 80) || '我';

  if (isForumPasserbyActor(actor)) {
    const chats = await listChatsForUser(userId);
    const existing = chats.find((chat) => (
      chat?.type === 'private'
      && chat?.metadata?.sourceForumActorId === actorId
      && chat?.metadata?.anonymousRoomKind === 'private'
    ));
    if (existing) {
      await recordForumRelationshipEvent(userId, {
        actorId,
        displayName: forumName,
        eventKey: `private:${existing.id}`,
        kind: 'private_open',
        timestamp: existing.createdAt || Date.now(),
      });
      return existing;
    }
    const chat = await createAnonymousPrivateFromRandomMatch({
      userId,
      userRow: user,
      counterpartActorId: actorId,
      counterpartIdentity: {
        currentId: forumName,
        signature: clean(actorSignature || actor?.notes, 180),
        avatar: clean(actorAvatar || actor?.avatar, 900000),
        profileId: `forum_profile_${actorId}`,
      },
      userIdentity: {
        currentId: userForumName,
        signature: clean(userForumProfile?.signature, 180),
        avatar: clean(userForumProfile?.avatar, 900000),
        profileId: `forum_user_${userId}`,
      },
      purpose: { id: 'forum_dm', label: '论坛私信', vibePrompt: '从论坛主页进入私聊，双方最初只知道论坛前台资料。' },
      counterpartSource: 'forum',
      seedOpening: true,
    });
    chat.metadata = { ...(chat.metadata || {}), sourceForumActorId: actorId, sourceForumDisplayName: forumName };
    await saveChat(chat);
    await buildAnonymousContactEntry({ userId, chat, actorId, privateChatId: chat.id });
    await recordForumRelationshipEvent(userId, {
      actorId,
      displayName: forumName,
      eventKey: `private:${chat.id}`,
      kind: 'private_open',
      timestamp: Date.now(),
    });
    return chat;
  }

  const characterAccount = await ensureForumAliasAccount({
    userId,
    ownerType: 'character',
    ownerId: actorId,
    identity: {
      displayName: forumName,
      avatar: actorAvatar || actor?.avatar || '',
      signature: actorSignature,
    },
    personaOverlay: `这是角色在论坛使用的账户“${forumName}”。私信中维持论坛前台身份；除非明确掉马，不得直接承认真名。`,
  });
  const realUserName = clean(user?.nickname || user?.name, 80);
  const userUsesForumAlias = nameKey(userForumName) !== nameKey(realUserName)
    || (!!clean(userForumProfile?.avatar) && clean(userForumProfile.avatar) !== clean(user?.avatar));
  const userAccount = userUsesForumAlias
    ? await ensureForumAliasAccount({
      userId,
      ownerType: 'user',
      ownerId: userId,
      identity: {
        displayName: userForumName,
        avatar: userForumProfile?.avatar || '',
        signature: userForumProfile?.signature || '',
      },
      personaOverlay: `这是用户在论坛使用的账户“${userForumName}”，与用户本体资料隔离。`,
    })
    : null;
  const chat = await ensureStrangerThread({
    userId,
    characterId: actorId,
    characterAccountId: characterAccount.id,
    userAccountId: userAccount?.id || '',
    initiatorType: 'user',
    friendshipState: 'intercepted',
  });
  chat.metadata = { ...(chat.metadata || {}), sourceForumActorId: actorId, sourceForumDisplayName: forumName };
  await saveChat(chat);
  await recordForumRelationshipEvent(userId, {
    actorId,
    displayName: forumName,
    eventKey: `private:${chat.id}`,
    kind: 'private_open',
    timestamp: Date.now(),
  });
  return chat;
}

export async function promoteForumPasserby({ userId, actorId, sourceChatId = '' } = {}) {
  const actor = await resolveForumActor(actorId);
  if (!isForumPasserbyActor(actor)) throw new Error('这不是可转正的论坛路人');
  return acceptAnonymousReveal({ userId, actorId, sourceChatId });
}
