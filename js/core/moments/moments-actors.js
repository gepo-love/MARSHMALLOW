import { getCharacter } from '../character-store.js';
import { listSocialVisibleCharacters } from '../social-character-scope.js';
import { listChatsForUser, listMessagesForChat } from '../chat-store.js';
import { getMessageCopyText, isAnonymousChat } from '../chat-helpers.js';
import { getUserDisplayName } from '../../models/user.js';
import { filterNonGuidanceMessages } from '../guidance-memory.js';
import { isStrangerInterceptChat } from '../stranger-thread-model.js';
import { loadChatPrefs } from '../chat-block-state.js';
import {
  collectSocialStoryCharacterIds,
  loadSocialStoryContinuitySnapshot,
} from '../memory/social-story-continuity.js';

export function isEligibleMomentsChatSource(chat) {
  return !!chat && !isAnonymousChat(chat) && !isStrangerInterceptChat(chat);
}

export function buildMomentChatMediumRule(dialoguePresentation = false) {
  if (!dialoguePresentation) return '';
  return '[媒介边界] 本会话开启对话表现模式：气泡本身不证明双方在用手机，也不证明双方正在现场。只有素材明确写到已经见面、同处一地或一起做事，才按当面说话理解；只有素材明确写到双方分开、正在网聊或真实使用手机，才按手机沟通理解。两边都没有证据时保持媒介中立，只写「刚才说过/聊到」，禁止擅自补「当面」「手机上」「隔着屏幕」「拿着或放下手机」。';
}

export async function buildMomentsActors(user) {
  const userId = String(user?.id || '').trim();
  const [chars, chats, storySnapshot] = await Promise.all([
    listSocialVisibleCharacters(user, { excludeAnonNpc: true, userId }),
    userId ? listChatsForUser(userId).catch(() => []) : [],
    userId ? loadSocialStoryContinuitySnapshot(userId).catch(() => ({ events: [], sharedKnowledge: [] })) : null,
  ]);
  // characters 是全局通讯录；朋友圈属于用户档位。只把当前档位真实出现过的
  // 主角色放进作者/互动池，否则档位 2 的角色会在档位 1 被生成并落库。
  const characterById = new Map(chars.map((c) => [String(c?.id || '').trim(), c]));
  const slotCharacterIds = new Set();
  for (const chat of chats) {
    if (!isEligibleMomentsChatSource(chat)) continue;
    for (const participantId of Array.isArray(chat.participants) ? chat.participants : []) {
      const id = String(participantId || '').trim();
      if (id && id !== 'user' && characterById.has(id)) slotCharacterIds.add(id);
    }
  }
  // 角色可能只在主线小剧场/统一事件时间线里出场，而没有自己的活跃私聊。
  // 只纳入时间线中有明确知情记录、且当前档案确实存在角色卡的人，不把公开事件扩成全通讯录作者池。
  for (const id of collectSocialStoryCharacterIds(storySnapshot || {})) {
    if (characterById.has(id)) slotCharacterIds.add(id);
  }
  const slotChars = chars.filter((c) => slotCharacterIds.has(String(c?.id || '').trim()));
  const userName = getUserDisplayName(user);
  const actors = [
    {
      id: userId,
      name: userName,
      kind: 'user',
      avatar: String(user?.avatar || '').trim(),
    },
    ...slotChars.map((c) => ({
      id: c.id,
      name: String(c.customNickname || c.name || c.id).trim() || c.id,
      kind: 'character',
      avatar: String(c.avatar || '').trim(),
    })),
  ].filter((a) => a.id);
  const nameMap = new Map(actors.map((a) => [a.id, a.name]));
  const avatarMap = new Map(actors.map((a) => [a.id, a.avatar || '']));
  return { actors, nameMap, avatarMap, characterIds: slotChars.map((c) => c.id), characters: slotChars };
}

export function buildActorOptionsHtml(actors = [], selectedId = '') {
  return actors
    .filter((a) => a?.id && a?.name)
    .map((a) => {
      const sel = a.id === selectedId ? ' selected' : '';
      return `<option value="${escAttr(a.id)}"${sel}>${escHtml(a.name)}</option>`;
    })
    .join('');
}

function escHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value = '') {
  return escHtml(value);
}

export function sampleActorIds(ids = [], count = 8) {
  const pool = [...new Set((ids || []).filter(Boolean))];
  const shuffled = pool.slice().sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.max(1, Math.min(count, pool.length)));
}

export async function resolveActorName(actorId, nameMap, userId = '') {
  const id = String(actorId || '').trim();
  if (nameMap?.has(id)) return nameMap.get(id);
  const c = await getCharacter(id, { userId });
  return String(c?.customNickname || c?.name || id || 'TA').trim() || 'TA';
}

function resolveChatLabel(chat, nameMap) {
  if (chat?.type === 'group') {
    const groupName = String(chat.groupSettings?.name || '').trim();
    if (groupName) return groupName;
    const others = (chat.participants || []).filter((p) => p !== 'user').slice(0, 4);
    const names = others.map((id) => nameMap.get(id) || id).filter(Boolean).join('、');
    return names || '群聊';
  }
  const partner = (chat?.participants || []).find((p) => p !== 'user');
  return nameMap.get(partner) || partner || '私聊';
}

function actorPromptLabel(actorId, fallbackName, nameMap, userName = '用户') {
  const id = actorId === 'user' ? 'user' : String(actorId || '').trim();
  const name = id === 'user'
    ? userName
    : (fallbackName || nameMap.get(id) || id || 'TA');
  return `${name}${id ? `（id=${id}）` : ''}`;
}

export function formatMomentChatLine(message, nameMap, userName = '用户', chat = null) {
  if (!message || message.deleted || message.recalled || message.type === 'system') return '';
  const senderKey = message.senderId === 'user' ? 'user' : String(message.senderId || '').trim();
  const sender = actorPromptLabel(senderKey, message.senderName, nameMap, userName);
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const replyMeta = message.replyMeta && typeof message.replyMeta === 'object' ? message.replyMeta : {};
  const replySenderId = String(metadata.replySenderId || replyMeta.replySenderId || '').trim();
  const replySenderName = String(metadata.replySenderName || replyMeta.replySenderName || '').trim();
  let addressee = '';
  if (replySenderId || replySenderName) {
    addressee = actorPromptLabel(replySenderId, replySenderName, nameMap, userName);
  } else if (chat?.type !== 'group') {
    const otherId = (chat?.participants || []).find((id) => id && id !== senderKey)
      || (senderKey === 'user' ? '' : 'user');
    addressee = actorPromptLabel(otherId, '', nameMap, userName);
  } else {
    addressee = '群聊内未指定对象';
  }
  const rawBody = getMessageCopyText(message);
  if (!rawBody) return '';
  const preview = String(message.replyPreview || metadata.replyPreview || '').replace(/\s+/g, ' ').trim();
  const body = `${preview ? `[回复 ${replySenderName || nameMap.get(replySenderId) || (replySenderId === 'user' ? userName : '对方')}：“${preview.slice(0, 60)}”] ` : ''}${rawBody}`
    .replace(/\s+/g, ' ')
    .slice(0, 200);
  return `${sender} → ${addressee}：${body}`;
}

function formatMomentForwardedChatLine(message, nameMap, userName = '用户') {
  if (!message || message.deleted || message.recalled || message.type === 'system') return '';
  const senderKey = message.senderId === 'user' ? 'user' : String(message.senderId || '').trim();
  const senderName = senderKey === 'user'
    ? userName
    : (String(message.senderName || '').trim() || nameMap.get(senderKey) || '角色');
  const body = String(getMessageCopyText(message) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return body ? `${senderName}：${body}` : '';
}

async function collectRecentChatLogDataForActors(userId, actorIds = [], options = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return { block: '', evidence: [] };
  const idSet = new Set((actorIds || []).map((x) => String(x || '').trim()).filter(Boolean));
  if (!idSet.size) return { block: '', evidence: [] };

  const messagesPerChat = Math.max(1, Math.min(50, Number(options.messagesPerChat || 50) || 50));
  const chats = (await listChatsForUser(uid))
    .filter((chat) => {
      if (!isEligibleMomentsChatSource(chat)) return false;
      const parts = chat?.participants || [];
      if (!parts.includes('user')) return false;
      return parts.some((p) => idSet.has(p));
    })
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  const participantIds = [...new Set(
    chats.flatMap((chat) => chat?.participants || []).filter((id) => id && id !== 'user'),
  )];
  const nameMap = await buildActorNameMap([...idSet, ...participantIds], uid);
  const userName = String(options.userName || '用户').trim() || '用户';

  const sections = [];
  const evidence = [];
  for (const chat of chats) {
    const chatPrefs = chat?.id ? await loadChatPrefs(chat.id).catch(() => ({})) : {};
    const dialoguePresentation = chatPrefs.dialoguePresentationMode === true;
    const messages = filterNonGuidanceMessages(await listMessagesForChat(chat.id, messagesPerChat))
      .slice(-messagesPerChat);
    const rows = messages
      .map((message) => ({
        promptText: formatMomentChatLine(message, nameMap, userName, chat),
        forwardText: formatMomentForwardedChatLine(message, nameMap, userName),
      }))
      .filter((row) => row.promptText && row.forwardText);
    if (!rows.length) continue;
    const kind = chat.type === 'group' ? '群聊' : '私聊';
    const title = resolveChatLabel(chat, nameMap);
    const lines = rows.map((row) => {
      const sourceId = `chat_line_${evidence.length + 1}`;
      evidence.push({
        sourceId,
        text: row.forwardText,
        chatId: String(chat.id || ''),
        dialoguePresentation,
      });
      return `[${sourceId}] ${row.promptText}`;
    });
    const mediumRuleText = buildMomentChatMediumRule(dialoguePresentation);
    const mediumRule = mediumRuleText ? `\n${mediumRuleText}` : '';
    sections.push(`[${kind} · ${title} · 近${lines.length}条 · 从旧到新，末行最新]${mediumRule}\n${lines.join('\n')}`);
  }
  return { block: sections.join('\n\n'), evidence };
}

/** 相关人员私聊/群聊：每个会话取最近 messagesPerChat 条（默认 50） */
export async function collectRecentChatLogsForActors(userId, actorIds = [], options = {}) {
  const result = await collectRecentChatLogDataForActors(userId, actorIds, options);
  return result.block;
}

/** 按角色拆分聊天片段，避免 A/B 私聊混在同一池里被串人设；每会话最多 20 条，近的优先。 */
export async function collectPerAuthorChatLogBlocks(userId, authorIds = [], options = {}) {
  const uid = String(userId || '').trim();
  const ids = [...new Set((authorIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!uid || !ids.length) return '';
  const sections = [];
  for (const authorId of ids) {
    const block = await collectRecentChatLogsForActors(uid, [authorId], {
      messagesPerChat: Math.max(1, Math.min(20, Number(options.messagesPerChat || 20) || 20)),
      userName: options.userName,
    });
    if (!block) continue;
    sections.push(
      `[${authorId} 专属聊天事实与语气 · 仅该角色参与过的会话，禁止当作其他角色的参考]\n${block}`,
    );
  }
  return sections.join('\n\n');
}

/**
 * 生成朋友圈晒聊天时同时返回可引用的真实消息。模型只选择 sourceId，
 * 最终展示文本由程序从 evidence 回填，避免模型复述时篡改用户原话。
 */
export async function collectPerAuthorChatEvidenceBlocks(userId, authorIds = [], options = {}) {
  const uid = String(userId || '').trim();
  const ids = [...new Set((authorIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!uid || !ids.length) {
    return { block: '', evidenceByAuthor: new Map(), dialoguePresentationAuthorIds: new Set() };
  }
  const sections = [];
  const evidenceByAuthor = new Map();
  const dialoguePresentationAuthorIds = new Set();
  for (let authorIndex = 0; authorIndex < ids.length; authorIndex += 1) {
    const authorId = ids[authorIndex];
    const data = await collectRecentChatLogDataForActors(uid, [authorId], {
      messagesPerChat: Math.max(1, Math.min(20, Number(options.messagesPerChat || 20) || 20)),
      userName: options.userName,
    });
    if (!data.block) continue;
    const prefix = `author_${authorIndex + 1}_`;
    const evidence = data.evidence.map((row) => ({
      ...row,
      sourceId: `${prefix}${row.sourceId}`,
    }));
    const block = data.evidence.reduce(
      (text, row) => text.split(`[${row.sourceId}]`).join(`[${prefix}${row.sourceId}]`),
      data.block,
    );
    if (evidence.some((row) => row.dialoguePresentation)) {
      dialoguePresentationAuthorIds.add(authorId);
    }
    evidenceByAuthor.set(authorId, evidence);
    sections.push(
      `[${authorId} 专属聊天事实 · 仅该角色参与过的会话]\n${block}`,
    );
  }
  return { block: sections.join('\n\n'), evidenceByAuthor, dialoguePresentationAuthorIds };
}

/** @deprecated 使用 collectRecentChatLogsForActors */
export async function collectChatSnippetsForActors(userId, actorIds = [], limit = 24) {
  const block = await collectRecentChatLogsForActors(userId, actorIds, { messagesPerChat: 50 });
  if (!block) return '';
  const lines = block.split('\n').filter((line) => line.includes('：'));
  return lines.slice(0, limit).join('\n');
}

export async function buildActorNameMap(ids = [], userId = '') {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  const map = new Map();
  await Promise.all(uniq.map(async (id) => {
    map.set(id, await resolveActorName(id, null, userId));
  }));
  return map;
}
