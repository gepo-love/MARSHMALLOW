import * as db from '../db.js';
import { PROMPTS } from '../../data/prompts.js';
import { buildTimeAndHolidayPromptBlock, getNowForUser } from '../time-mode.js';
import { listAllWorldBookRows } from '../world-book-store.js';
import { buildPresetFragmentContext } from '../preset-store.js';
import {
  buildSocialHardRulesPrompt,
  buildSocialNarrativeGuidancePrompt,
  buildSocialFormatGuidancePrompt,
  buildSocialCharacterCardsBlock,
} from '../social-helpers.js';
import { buildAuPromptBlock } from '../au-config.js';
import { normalizeAuConfig } from '../au-config.js';
import { listMemoryFactsForContext } from '../memory/memory-facts.js';
import {
  formatSocialStoryContinuityLine,
  loadSocialStoryContinuitySnapshot,
  selectSocialStoryContinuityRows,
} from '../memory/social-story-continuity.js';
import { collectRoleplayContextForSocialGeneration } from './build-weibo-context.js';
import {
  getUserDisplayName,
  formatUserSignatureStatusContextLines,
  formatUserWorldBackgroundContext,
} from '../../models/user.js';
import { formatMessageForContext, isAnonymousChat } from '../chat-helpers.js';
import { buildAmbientWeiboMaterialBlock } from '../social-life-material.js';
import { filterNonGuidanceMessages } from '../guidance-memory.js';
import { buildSocialAcquaintancePromptBlock } from '../social-acquaintance-context.js';
import { isStrangerInterceptChat } from '../stranger-thread-model.js';
import {
  buildForumCharacterAliasRosterBlock,
  buildForumPasserbyRosterBlock,
} from '../forum/forum-actors.js';
import { dateKeyFromTimestamp } from '../character-phone-store.js';
import { buildForumEngagementPromptBlock } from '../forum/forum-engagement.js';
import { buildForumRelationshipPromptBlock } from '../forum/forum-relationships.js';
import { listForumVisibleCharacters } from '../forum/forum-character-scope.js';
import { buildGenderPronounRuleLine } from '../identity-gender.js';

/** 聊天日程相对「今天」的日历日差；无法解析时返回 null。 */
export function calendarDayOffset(fromKey = '', toKey = '') {
  const from = String(fromKey || '').trim();
  const to = String(toKey || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const a = Date.parse(`${from}T12:00:00`);
  const b = Date.parse(`${to}T12:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * 论坛素材新鲜度：今日可轻量取材；昨近日程降权；更早只作背景。
 * @returns {'fresh'|'stale'|'old'|'unknown'}
 */
export function forumChatFreshness(timestamp = 0, now = Date.now()) {
  const ts = Number(timestamp) || 0;
  if (!ts) return 'unknown';
  const ageMs = Number(now) - ts;
  if (!Number.isFinite(ageMs)) return 'unknown';
  const dayOffset = calendarDayOffset(dateKeyFromTimestamp(ts), dateKeyFromTimestamp(now));
  if (dayOffset === 0 || (dayOffset == null && ageMs <= 18 * 3600_000)) return 'fresh';
  if (dayOffset === 1 || (dayOffset == null && ageMs <= 42 * 3600_000)) return 'stale';
  return 'old';
}

export function forumChatFreshnessLabel(kind = 'unknown') {
  if (kind === 'fresh') return '今日新鲜';
  if (kind === 'stale') return '昨日·已过期（勿当今天新帖主话题）';
  if (kind === 'old') return '更早·仅背景';
  return '时间未知';
}

function buildUserCardBlock(user) {
  if (!user) return '';
  const parts = [`【${getUserDisplayName(user)}】`];
  const worldBackground = formatUserWorldBackgroundContext(user, { maxLength: 3000 });
  if (worldBackground) parts.push(worldBackground);
  parts.push(`性别与代词硬约束：${buildGenderPronounRuleLine(user, `用户「${getUserDisplayName(user)}」`)}`);
  parts.push(...formatUserSignatureStatusContextLines(user, {
    clean: (value) => String(value || '').trim(),
    signatureMax: 200,
    statusMax: 120,
  }));
  if (user.persona) parts.push(`人物设定：${String(user.persona).trim()}`);
  if (user.hobbies) parts.push(`兴趣：${String(user.hobbies).trim()}`);
  return parts.join('\n');
}

function cleanLine(value = '', limit = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function chatLabel(chat = {}, characters = {}) {
  if (chat.type === 'group') return chat.groupSettings?.name || '未命名群聊';
  const partnerId = (chat.participants || []).find((id) => id && id !== 'user');
  const ch = partnerId ? characters[partnerId] : null;
  return ch?.name || ch?.realName || ch?.customNickname || chat.metadata?.partnerName || '私聊';
}

async function isPrivateIdentityChatId(chatId = '') {
  const id = String(chatId || '').trim();
  if (!id) return false;
  const chat = await db.getRecord('chats', id).catch(() => null);
  return !!(chat && (isAnonymousChat(chat) || isStrangerInterceptChat(chat)));
}

async function buildForumChatMemoryContextBlock(user, characterRows = []) {
  const uid = String(user?.id || '').trim();
  if (!uid) return '';
  const allowedCharacterIds = new Set((Array.isArray(characterRows) ? characterRows : [])
    .map((row) => String(row?.id || '').trim())
    .filter(Boolean));
  if (!allowedCharacterIds.size) return '';
  const now = await getNowForUser(uid).catch(() => Date.now());
  const [chatsRaw, charactersRaw] = await Promise.all([
    db.getAllByIndex('chats', 'userId', uid).catch(() => []),
    listForumVisibleCharacters(user, { excludeAnonNpc: true }).catch(() => []),
  ]);
  const characters = {};
  for (const ch of charactersRaw || []) {
    if (ch?.id) characters[ch.id] = ch;
  }
  const chats = (Array.isArray(chatsRaw) ? chatsRaw : [])
    .filter((chat) => chat && Array.isArray(chat.participants) && chat.participants.includes('user'))
    .filter((chat) => !isAnonymousChat(chat) && !isStrangerInterceptChat(chat))
    .filter((chat) => chat.participants.some((id) => allowedCharacterIds.has(String(id || '').trim())))
    .sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0))
    .slice(0, 8);
  const blocks = [];
  let hasFreshChat = false;
  let hasExpiredChat = false;
  for (const chat of chats) {
    const audienceIds = [...new Set((chat.participants || [])
      .map((id) => String(id || '').trim())
      .filter((id) => allowedCharacterIds.has(id)))];
    if (!audienceIds.length) continue;
    const [messagesRaw, memoriesRaw] = await Promise.all([
      db.getAllByIndex('messages', 'chatId', chat.id).catch(() => []),
      db.getAllByIndex('memories', 'chatId', chat.id).catch(() => []),
    ]);
    const recentMessages = filterNonGuidanceMessages(Array.isArray(messagesRaw) ? messagesRaw : [])
      .filter((m) => m && !m.deleted && !m.recalled && m.senderId !== 'system' && m.type !== 'system')
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
      .slice(-10);
    const freshLines = [];
    const expiredLines = [];
    for (const m of recentMessages) {
      const line = cleanLine(formatMessageForContext(m, getUserDisplayName(user), { characters }), 220);
      if (line.length <= 2) continue;
      const kind = forumChatFreshness(m.timestamp, now);
      const tagged = `- [${forumChatFreshnessLabel(kind)}] ${line}`;
      if (kind === 'fresh') {
        freshLines.push(tagged);
        hasFreshChat = true;
      } else {
        expiredLines.push(tagged);
        hasExpiredChat = true;
      }
    }
    // 过期对话只留少量作口吻/关系背景，避免昨天具体日程占满上下文
    const messageLines = [...freshLines.slice(-8), ...expiredLines.slice(-3)];
    const memories = (Array.isArray(memoriesRaw) ? memoriesRaw : [])
      .filter((m) => m && String(m.content || '').trim())
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, 4)
      .map((m) => {
        const kind = forumChatFreshness(m.timestamp, now);
        return `- [${forumChatFreshnessLabel(kind === 'fresh' ? 'fresh' : (kind === 'unknown' ? 'old' : kind))}] ${cleanLine(m.content, 180)}`;
      });
    if (!messageLines.length && !memories.length) continue;
    const windowFreshness = freshLines.length
      ? '含今日新鲜对话'
      : (expiredLines.length ? '仅过期近况（降权）' : '仅沉淀记忆');
    blocks.push([
      `【私有聊天素材｜仅 ownerIds=${audienceIds.join(',')} 可用｜窗口：${chatLabel(chat, characters)}｜${windowFreshness}】`,
      messageLines.length ? `对话摘录：\n${messageLines.join('\n')}` : '',
      memories.length ? `沉淀记忆（长期背景，不是今天新闻）：\n${memories.join('\n')}` : '',
    ].filter(Boolean).join('\n'));
  }
  if (!blocks.length) return '';
  const freshnessHint = hasFreshChat
    ? '有标注「今日新鲜」的条目时可轻量取材并改写口吻。'
    : '当前没有今日新鲜聊天：禁止把昨近日程事件再炒成今天新帖主话题，改从兴趣/职业碎片/路人舆论/生活流水账另开新题。';
  const expiredHint = hasExpiredChat
    ? '标注「昨日·已过期 / 更早·仅背景」的具体日程（接人、做饭、出门等）只作关系与口吻背景，不得反复写成新帖主事件。'
    : '';
  return [
    '【论坛生成参考 · 分角色私有聊天】',
    '以下按当前虚拟时间标注了新鲜度。每个块只允许 ownerIds 中的角色本人作为作者时读取；其他角色、小号背后的其他主人、匿名路人与论坛网友均不可见。被聊天内容提到不等于知道该聊天，也不等于亲历。',
    freshnessHint,
    expiredHint,
    ...blocks,
  ].filter(Boolean).join('\n\n');
}

function isWorldBookGroupLike(row = {}) {
  return row?.kind === 'group' || !!row?.isBookRoot || !!row?.isCollection;
}

/**
 * 论坛板块按整本世界书绑定：
 * - 空数组就是明确不注入世界书；
 * - 选中书根 ID 后展开其中所有启用的具体条目；
 * - 旧版已保存的具体条目 ID 会映射到所属整本，与新选择器语义保持一致；
 * - 条目自身、所属条目分组或所属集合关闭时必须停止注入；
 * - 整本全局关闭不影响用户为当前板块显式绑定该书。
 */
export function resolveBoundForumWorldBookItems(ids = [], rows = []) {
  const picked = normalizeBoundIds(ids);
  if (!picked.length) return [];
  const all = Array.isArray(rows) ? rows : [];
  const byId = new Map(all.filter((row) => row?.id).map((row) => [String(row.id), row]));
  const pickedBookIds = new Set();
  const pickedOrphanItemIds = new Set();
  for (const id of picked) {
    const row = byId.get(id);
    if (row?.isBookRoot && !row?.isCollection) pickedBookIds.add(String(row.id));
    else if (row?.id && !isWorldBookGroupLike(row) && row.bookId) pickedBookIds.add(String(row.bookId));
    else if (row?.id && !isWorldBookGroupLike(row)) pickedOrphanItemIds.add(String(row.id));
  }
  const out = [];
  const seen = new Set();
  for (const row of all) {
    if (!row?.id || isWorldBookGroupLike(row) || row.enabled === false || seen.has(String(row.id))) continue;
    if (!pickedOrphanItemIds.has(String(row.id)) && !pickedBookIds.has(String(row.bookId || ''))) continue;
    const group = row.groupId ? byId.get(String(row.groupId)) : null;
    if (group?.enabled === false) continue;
    const book = row.bookId ? byId.get(String(row.bookId)) : null;
    const collection = book?.collectionId ? byId.get(String(book.collectionId)) : null;
    if (collection?.enabled === false) continue;
    seen.add(String(row.id));
    out.push(row);
  }
  return out;
}

async function resolveBoundWorldBookItems(ids = []) {
  const picked = normalizeBoundIds(ids);
  if (!picked.length) return [];
  const all = await listAllWorldBookRows().catch(() => []);
  return resolveBoundForumWorldBookItems(picked, all);
}

function normalizeBoundIds(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(list.map((x) => String(x || '').trim()).filter(Boolean))];
}

function buildSelectedAuBlock(user, auEntryIds = []) {
  if (!user) return '';
  const ids = new Set(normalizeBoundIds(auEntryIds));
  if (!ids.size) return '';
  const cfg = normalizeAuConfig(user);
  const picked = (cfg.entries || [])
    .filter((entry) => ids.has(entry.id) && entry.enabled !== false && entry.content)
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));
  if (!picked.length) return '';
  return [
    '【论坛版块绑定 AU】以下 AU/特殊设定仅用于当前论坛版块生成；与角色默认身份冲突时，以本版块绑定 AU 为准，但保留角色性格、关系、口吻底色。',
    ...picked.map((entry) => `[${entry.category || 'AU'}｜${entry.name}]\n${entry.content}`),
  ].join('\n\n');
}

export function formatForumPrivateFactLine(item = {}, ownerId = '') {
  const cid = String(ownerId || '').trim();
  const subject = String(item.subjectName || '').trim()
    || (item.subjectId === 'user' ? '用户' : String(item.subjectId || '').trim());
  const object = String(item.objectName || '').trim()
    || (item.objectId === 'user' ? '用户' : String(item.objectId || '').trim());
  const knownBy = item.knownBy && typeof item.knownBy === 'object' ? item.knownBy : {};
  const rawLevel = knownBy[cid];
  const involved = item.subjectId === cid
    || item.objectId === cid
    || rawLevel === true
    || ['involved', 'shared'].includes(String(rawLevel || ''));
  const knowledge = involved ? '当事/亲历' : '仅知情/听说，禁止写成自己的经历';
  const entities = [
    subject ? `主体=${subject}` : '',
    object ? `对象=${object}` : '',
  ].filter(Boolean).join('｜');
  const content = String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!content || !cid) return '';
  return `- [ownerId=${cid}｜${knowledge}${entities ? `｜${entities}` : ''}] ${content}`;
}

async function buildForumMemoryBridgeBlock(user, characterRows = []) {
  const uid = String(user?.id || '').trim();
  if (!uid) return '';
  const rows = (Array.isArray(characterRows) ? characterRows : [])
    .filter((row) => row?.id)
    .slice(0, 18);
  if (!rows.length) return '';
  // 同一批论坛生成只读一次事件/共享知情快照，避免按角色重复全表扫描。
  const storySnapshot = await loadSocialStoryContinuitySnapshot(uid)
    .catch(() => ({ userId: uid, events: [], sharedKnowledge: [], blockedChatIds: new Set() }));
  const packets = (await Promise.all(rows.map(async (row) => {
    const cid = String(row.id || '').trim();
    if (!cid) return '';
    const facts = await listMemoryFactsForContext({
      userId: uid,
      characterIds: [cid],
      limit: 8,
    }).catch(() => []);
    const factCandidates = (facts || []).filter((item) => {
      if (!item?.content) return false;
      const scope = String(item.scope || '').toLowerCase();
      return !(scope.includes('anonymous')
        || scope === 'account_alias'
        || scope === 'public_feed'
        || String(item.anonymousRoomId || '').trim());
    });
    const safeFactFlags = await Promise.all(factCandidates.map(async (item) => !(
      await isPrivateIdentityChatId(item.chatId)
      || await isPrivateIdentityChatId(item.sourceChatId)
    )));
    const factLines = factCandidates
      .filter((_item, index) => safeFactFlags[index])
      .map((item) => formatForumPrivateFactLine(item, cid))
      .filter(Boolean);
    const storyLines = selectSocialStoryContinuityRows(storySnapshot, cid, { limit: 6 })
      .slice().reverse()
      .map(formatSocialStoryContinuityLine)
      .filter(Boolean);
    if (!factLines.length && !storyLines.length) return '';
    const name = String(row.name || row.realName || row.customNickname || cid).trim();
    return [
      `【私有记忆包｜ownerId=${cid}｜${name}】`,
      '只有该 ownerId 对应角色本人作为帖子作者或楼层发言者时可读取；匿名路人和其他角色不得借用。',
      storyLines.length ? `本人最新剧情时间线（从旧到新，末行最新；优先于旧关系状态）：\n${storyLines.join('\n')}` : '',
      factLines.length ? `本人可用事实：\n${factLines.join('\n')}` : '',
    ].filter(Boolean).join('\n');
  }))).filter(Boolean);
  if (!packets.length) return '';
  return [
    '【跨聊天记忆 · 分角色隔离】这些是各角色自己的长期背景，不是论坛公共知识，也不是「今天刚发生」的新闻。',
    '帖子或楼层的作者只能读取 ownerId 与自己真实角色 id 相同的记忆包。伪装论坛 ID 不改变 ownerId；匿名路人没有任何私有记忆包。涉及同一个用户也不能把 A 的包共享给 B。',
    ...packets,
  ].join('\n\n');
}

export async function buildForumAiSystemPrompt(user, options = {}) {
  const {
    worldBookId = null,
    worldBookIds = null,
    auEntryIds = [],
    referenceNotes = '',
    section = null,
    webMaterials = '',
    characters = null,
    publicAliasIsolation = false,
    passerbyIsolation = false,
  } = options;
  // 公开账号本体未知时必须完全隔离私人上下文；混合路人批次则不能一刀切，
  // 否则同批角色小号也会失去自己的人设与主线记忆。混合批次改用 ownerId/authorRoleId 分包。
  const privateContextIsolated = publicAliasIsolation;
  const parts = [];
  const characterRows = Array.isArray(characters)
    ? characters.filter((row) => row?.id)
    : (user ? await listForumVisibleCharacters(user, { excludeAnonNpc: true }).catch(() => []) : []);
  const hasScopedCharacters = characterRows.length > 0;
  if (user) {
    if (!privateContextIsolated && !passerbyIsolation) parts.push(buildUserCardBlock(user));
    if (!privateContextIsolated && hasScopedCharacters) {
      const characterCardsBlock = buildSocialCharacterCardsBlock(characterRows, { mode: 'full', maxCount: 80 });
      if (characterCardsBlock) {
        parts.push([
          '【角色专属人设包｜按 authorRoleId 隔离】',
          '只有帖子或楼层输出的 authorRoleId 与角色 id 完全一致时，才可读取对应角色卡；普通路人、无 authorRoleId 的作者和其他角色不得借用。',
          characterCardsBlock,
        ].join('\n'));
      }
    }
    if (!privateContextIsolated && !passerbyIsolation) {
      const acquaintanceBlock = await buildSocialAcquaintancePromptBlock(characterRows, user.id);
      if (acquaintanceBlock) parts.push(acquaintanceBlock);
    }
    const auBlock = buildAuPromptBlock(user);
    if (auBlock) parts.push(auBlock);
    const selectedAuBlock = buildSelectedAuBlock(user, auEntryIds);
    if (selectedAuBlock) parts.push(selectedAuBlock);
    if (!privateContextIsolated && hasScopedCharacters) {
      const memoryBlock = await buildForumMemoryBridgeBlock(user, characterRows);
      if (memoryBlock) parts.push(memoryBlock);
      const chatMemoryBlock = await buildForumChatMemoryContextBlock(user, characterRows);
      if (chatMemoryBlock) parts.push(chatMemoryBlock);
    }
    // 论坛反哺虚拟微博：站内生成的半真半假微博热搜/简讯（48h 内）作为同世界舆论背景
    const ambientWeiboBlock = await buildAmbientWeiboMaterialBlock(user.id, { audience: 'forum' }).catch(() => '');
    if (ambientWeiboBlock) parts.push(ambientWeiboBlock);
    const passerbyRosterBlock = await buildForumPasserbyRosterBlock(user.id).catch(() => '');
    if (passerbyRosterBlock) parts.push(passerbyRosterBlock);
    const characterAliasRosterBlock = await buildForumCharacterAliasRosterBlock(user.id, characterRows, user).catch(() => '');
    if (characterAliasRosterBlock) parts.push(characterAliasRosterBlock);
    if (!privateContextIsolated && !passerbyIsolation) {
      const engagementBlock = await buildForumEngagementPromptBlock(user.id).catch(() => '');
      if (engagementBlock) parts.push(engagementBlock);
      const relationshipBlock = await buildForumRelationshipPromptBlock(user.id).catch(() => '');
      if (relationshipBlock) parts.push(relationshipBlock);
    }
    parts.push([
      '【论坛与私人日程边界】',
      '论坛网友不能直接读取任何角色的私人日程、实时状态、手机记录或线下会面。只有角色已经公开发布到微博/朋友圈、并进入上方公共舆情素材的内容，论坛才可以转述、截图或讨论；不得为了制造话题补写尚未公开的地点、同行人、未来安排或私聊细节。',
      '论坛批量生成时，角色卡可以决定口吻，私有记忆包只能由 ownerId 相同的作者读取。作者使用伪装 ID、匿名小号或忘切号，都不会获得其他角色的记忆；普通路人只能使用公共舆情与版块素材。',
      '只有输出中带可核对 authorRoleId/authorId 的角色主帖才能引用对应 ownerId 的私有记忆包；只有作者昵称、没有结构化角色 id 的普通楼层或路人帖一律不得引用私有记忆。',
    ].join('\n'));
  } else {
    parts.push('（未选择用户档案：无个人用户卡）');
  }
  const presetBlock = await buildPresetFragmentContext('online');
  if (presetBlock) parts.push(presetBlock);
  const forumPreset = await db.get('settings', 'preset_forum_feed');
  if (forumPreset?.value?.content) {
    parts.push(forumPreset.value.content);
  } else if (PROMPTS.forum_feed?.content) {
    parts.push(PROMPTS.forum_feed.content);
  } else if (PROMPTS.social_feed_generic?.content) {
    parts.push(PROMPTS.social_feed_generic.content);
  }
  const boundWorldBookIds = normalizeBoundIds(
    Array.isArray(worldBookIds) || worldBookIds ? worldBookIds : worldBookId,
  );
  const boundWorldBookItems = await resolveBoundWorldBookItems(boundWorldBookIds);
  for (const wb of boundWorldBookItems) {
    if (wb) {
      parts.push(`[论坛专用世界书绑定]\n《${wb.name || wb.id}》\n${String(wb.content || '').trim()}`);
    }
  }
  if (section) {
    const sectionDesc = String(section.desc || '').replace(
      /\{\{user\}\}/g,
      privateContextIsolated ? '某位论坛用户' : getUserDisplayName(user),
    );
    const secParts = [
      `版块名：${section.name || ''}`,
      `版块类型：${section.type || '综合'}`,
      sectionDesc ? `描述要求：${sectionDesc}` : '',
    ].filter(Boolean);
    if (secParts.length) parts.push(`[当前论坛版块]\n${secParts.join('\n')}`);
  }
  if (String(webMaterials || '').trim()) {
    parts.push(`[联网素材参考]\n${String(webMaterials).trim()}`);
  }
  if (String(referenceNotes || '').trim()) {
    parts.push(`[论坛生成补充参考]\n${String(referenceNotes).trim()}`);
  }
  const timeBlock = user?.id ? await buildTimeAndHolidayPromptBlock(user.id) : '';
  if (timeBlock) parts.push(timeBlock);
  parts.push(
    '[论坛生成·时间表达]\n'
    + '一切「何时发生」以上方当前时间为准。发帖与楼层回复中的「刚、昨晚、几小时前、本周」等都必须按该虚拟/现实时间理解；禁止随意编造与上下文矛盾的日期节点。',
  );
  parts.push(
    '[论坛生成·新鲜度与去重]\n'
    + '- 聊天记录里标注「昨日·已过期 / 更早·仅背景」的具体日程事件，只能作关系与口吻背景，禁止再写成今天新帖的主事件反复刷。\n'
    + '- 若任务里给了同版块/近期历史帖摘要，本轮新帖禁止复述、改写或换皮那些已经写过的同一件具体事；必须开新话题、新切口或新近况。\n'
    + '- 没有今日新鲜聊天素材时，优先从角色兴趣、职业碎片、路人舆论、天气通勤等生活流水账另开新题，不要把昨天的事再炒一遍。\n'
    + '- 一批新帖内部也不要互相换皮同题；允许隔空呼应旧梗，但主事件必须不同。',
  );
  parts.push(
    '[论坛生成·角色口吻优先]\n'
    + '论坛发帖与楼层回复可以有社区口语和匿名感，但不能为了像论坛而让角色 OOC。凡是可识别角色、熟人、小号、粉丝或旁观者发言，都必须尊重人设、关系张力、说话风格和当前 AU/世界书设定；不要把所有楼层写成同一种互联网吐槽腔。',
  );
  parts.push(
    '[论坛生成·匿名隔离]\n'
    + '公开论坛不得引用、提及或暗示匿名聊天室、匿名匹配、随机房、匿名私聊、匿名语音房里的具体内容、房间名、匿名身份、匹配机制或“在匿名房见过谁”。论坛生成只能使用普通聊天、角色卡、世界书、AU 和非匿名记忆；如果上下文中出现匿名相关残留，一律视为不可见。',
  );
  if (publicAliasIsolation) {
    parts.push(
      '[论坛公开账号隔离 · 最高优先级]\n'
      + '当前任务涉及本体未知的公开论坛账号。角色卡只用于回复者自身的人设与口吻；即使上文 AU 或角色资料提到用户，也不得把用户身份、私聊、记忆或关系经历绑定到当前公开账号。只根据帖子与楼层公开写出的内容回复。',
    );
  }
  if (passerbyIsolation) {
    parts.push(
      '[论坛路人隔离 · 最高优先级]\n'
      + '本轮允许普通论坛路人出场。路人只知道帖子、楼层、公开版块资料和上方明确标为公共舆情的素材；不知道用户与任何通讯录角色的关系、昵称对应的本体、私聊、记忆、日程或线下经历。即使上下文出现角色卡或世界设定，路人也不得据此说“你们在一起”“我知道你和某角色的关系”或把猜测写成事实。除非该关系已在当前帖子/楼层的公开文字中明确写出，否则必须当作未知。',
    );
  }
  parts.push(buildSocialHardRulesPrompt(privateContextIsolated || passerbyIsolation ? null : user));
  parts.push(buildSocialFormatGuidancePrompt('forum'));
  parts.push(await buildSocialNarrativeGuidancePrompt({
    allowStickers: options.allowStickers !== false,
    stickerPackIds: options.stickerPackIds,
  }));
  return parts.filter(Boolean).join('\n\n---\n\n');
}

export async function collectForumRoleplayHints(userId, options = {}) {
  const ctx = await collectRoleplayContextForSocialGeneration(userId, null, {
    ...options,
    excludeAnonymous: true,
  });
  return {
    snippets: ctx.snippets || [],
    relation: ctx.relationLines || [],
    relayGroupNames: ctx.relayGroupNames || [],
  };
}
