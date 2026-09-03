/**
 * 群聊线下邀约：用户赴约/婉拒后，单次 AI 调用推断其他群友反应，并决定是否生成小剧场卡。
 */
import { resolveGenerationMaxTokens } from '../api.js';
import { chatJsonGeneration } from '../chat-json-generation.js';
import { resolveSceneApiConfig } from '../api-presets.js';
import { buildChatContext } from '../context/build-chat-context.js';
import { saveMessage } from '../chat-store.js';
import { createMessage } from '../../models/chat.js';
import { getRecord, putRecord } from '../db.js';
import { getCharacterAiContextName } from '../../models/character.js';
import { getNowForUser } from '../time-mode.js';
import { createEventMemory } from '../../models/event-memory.js';
import { createSharedKnowledgeFromStoryCard } from '../memory/shared-event-knowledge.js';
import { archiveNarration } from '../narration-archive.js';
import { stripLeakedReasoning } from '../narration-sanitize.js';

async function loadParticipantNames(chat = {}, user = null) {
  const ids = (chat?.participants || []).filter((id) => id && id !== 'user');
  const names = { user: String(user?.displayName || user?.name || '我').trim() || '我' };
  for (const id of ids) {
    const row = await getRecord('characters', id).catch(() => null);
    names[id] = getCharacterAiContextName(row, id);
  }
  return names;
}

function normalizeAttendees(list = [], names = {}, initiatorId = '') {
  const out = [];
  const seen = new Set([String(initiatorId || '').trim()]);
  for (const item of (Array.isArray(list) ? list : [])) {
    const id = String(item?.id || item?.characterId || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = String(item?.name || names[id] || id).trim();
    const reaction = stripLeakedReasoning(String(item?.reaction || item?.text || '').trim());
    const attending = item?.attending !== false;
    if (!attending && !reaction) continue;
    out.push({ id, name, reaction, attending: attending !== false });
  }
  return out.slice(0, 6);
}

function normalizeStoryCard(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const title = stripLeakedReasoning(String(raw.title || '小聚').trim()) || '小聚';
  const summary = stripLeakedReasoning(String(raw.summary || '').replace(/\s+/g, ' ').trim()).slice(0, 60);
  const paragraphs = Array.isArray(raw.paragraphs)
    ? raw.paragraphs.map((p) => stripLeakedReasoning(String(p || '').trim())).filter(Boolean)
    : [];
  if (!paragraphs.length && !summary) return null;
  return {
    title,
    summary: summary || String(paragraphs[0] || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    paragraphs: paragraphs.length ? paragraphs : [summary],
    characters: Array.isArray(raw.characters)
      ? raw.characters.map((n) => String(n || '').trim()).filter(Boolean).slice(0, 6)
      : [],
    digest: String(raw.digest || summary || '').trim(),
    followupHook: String(raw.followupHook || '').trim(),
  };
}

/**
 * @returns {Promise<{ attendees: Array, storyCard: object|null, raw: string }>}
 */
export async function resolveGroupOfflineInviteResponse({
  chat,
  user,
  userId,
  inviteMessage,
  userAccepted,
  declineReason = '',
  messages = [],
}) {
  const md = inviteMessage?.metadata || {};
  const initiatorId = String(md.initiatorId || inviteMessage?.senderId || '').trim();
  const inviteeIds = (Array.isArray(md.inviteeIds) ? md.inviteeIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && id !== initiatorId);
  const names = await loadParticipantNames(chat, user);
  const initiatorName = names[initiatorId] || inviteMessage?.senderName || 'TA';
  const inviteeLabel = inviteeIds.length
    ? inviteeIds.map((id) => names[id] || id).join('、')
    : Object.entries(names).filter(([id]) => id !== 'user' && id !== initiatorId).map(([, n]) => n).join('、');

  const prompt = [
    '[群聊 · 线下邀约 · 众人反应]',
    `发起人：${initiatorName}`,
    `被点名的群友：${inviteeLabel || '（按群氛围自行判断谁会去）'}`,
    `地点：${String(md.place || '').trim() || '未写'}`,
    `一起做什么：${String(md.activity || md.note || inviteMessage?.content || '').trim()}`,
    `用户决定：${userAccepted ? '同意赴约' : `婉拒${declineReason ? `，理由：${declineReason}` : ''}`}`,
    '',
    '任务：推断除发起人外，其他群友（可含 user）谁一起去、谁不去；每人给一句很短的群聊式反应。',
    userAccepted
      ? '用户也一起去：attendees 里必须包含 {"id":"user",...}；storyCard 必须为 null。'
      : '用户不去：若仍有人跟发起人一起去，必须写 storyCard（2~3 段小剧场，写他们小聚、用户不在场）；若最终没人去则 attendees 为空且 storyCard 为 null。',
    '',
    '只输出 1 个 JSON 对象，不要 markdown，不要聊天协议：',
    '{"attendees":[{"id":"角色id或user","name":"显示名","reaction":"一句短反应","attending":true}],"storyCard":null}',
    'attendees 不要包含发起人；id 只能是本群真实角色 id 或 user。',
  ].join('\n');

  const { messages: contextMessages } = await buildChatContext({
    chat,
    chatId: chat?.id,
    user,
    userId,
    messages,
    presetMode: 'offline',
  });

  const apiOverride = await resolveSceneApiConfig().catch(() => null);
  const maxTokens = await resolveGenerationMaxTokens(apiOverride);
  let generated = null;
  let raw = '';
  try {
    generated = await chatJsonGeneration({
      scope: 'group-offline-invite-response',
      messages: [...contextMessages, { role: 'user', content: prompt }],
      temperature: 0.88,
      maxTokens,
      requestOptions: { configOverride: apiOverride || undefined },
      validate: (value) => value && typeof value === 'object' && !Array.isArray(value),
    });
    raw = generated.raw;
  } catch (error) {
    if (error?.reason === 'output-truncated') throw error;
    raw = String(error?.rawText || '');
  }
  let attendees = [];
  let storyCard = null;
  const parsed = generated?.data;
  if (parsed) {
    attendees = normalizeAttendees(parsed?.attendees, names, initiatorId);
    storyCard = userAccepted ? null : normalizeStoryCard(parsed?.storyCard);
  }

  if (!userAccepted && !storyCard && attendees.some((a) => a.attending)) {
    storyCard = {
      title: '他们去了',
      summary: `${attendees.filter((a) => a.attending).map((a) => a.name).join('、')}还是跟着${initiatorName}去了。`,
      paragraphs: [
        `${initiatorName}发起的邀约，你没能去。${attendees.filter((a) => a.attending).map((a) => a.name).join('、')}还是去了。`,
        attendees.filter((a) => a.reaction).map((a) => `${a.name}：${a.reaction}`).join('\n'),
      ].filter(Boolean),
      characters: attendees.filter((a) => a.attending).map((a) => a.name),
      digest: '',
      followupHook: '',
    };
  }

  return { attendees, storyCard, initiatorId, raw: String(raw || '') };
}

export async function saveGroupInviteStoryCard({
  chat,
  userId,
  storyCard,
  inviteMessage,
  attendeeIds = [],
}) {
  if (!storyCard || !chat?.id) return null;
  const ts = await getNowForUser(userId);
  const md = inviteMessage?.metadata || {};
  const paragraphs = Array.isArray(storyCard.paragraphs) ? storyCard.paragraphs : [];
  const msg = createMessage({
    chatId: chat.id,
    senderId: 'system',
    senderName: '系统',
    type: 'storyCard',
    content: paragraphs.join('\n\n'),
    timestamp: ts + 1,
    metadata: {
      title: storyCard.title || '小聚',
      summary: storyCard.summary || '',
      fullText: paragraphs.join('\n\n'),
      paragraphs,
      characters: storyCard.characters || [],
      digest: storyCard.digest || storyCard.summary || '',
      followupHook: storyCard.followupHook || '',
      expanded: false,
      mode: 'group-offline-decline',
      groupOfflineInviteId: inviteMessage?.id || '',
      place: md.place || '',
      activity: md.activity || '',
    },
  });
  await saveMessage(msg);

  archiveNarration({
    kind: 'storycard',
    title: msg.metadata.title,
    subtitle: md.place || '',
    text: msg.content,
    chatId: chat.id,
    characterName: storyCard.characters?.[0] || '',
  }).catch(() => {});

  const participantIds = attendeeIds.filter((id) => id && id !== 'user');
  try {
    await createSharedKnowledgeFromStoryCard({
      chatId: chat.id,
      messageId: msg.id,
      userId,
      summary: msg.metadata.digest || msg.metadata.summary,
      characterIds: participantIds,
      timestamp: msg.timestamp,
    });
  } catch (_) {}
  try {
    const knownBy = {};
    for (const id of participantIds) knownBy[id] = 'involved';
    await putRecord('eventMemories', createEventMemory({
      userId,
      summary: msg.metadata.digest || msg.metadata.summary || msg.content.slice(0, 120),
      timestamp: msg.timestamp,
      knownBy,
      involvedChats: [chat.id],
      highlight: storyCard.followupHook || '',
      pendingThreads: [],
      temporalState: 'completed',
      tags: ['storyCard', 'group-offline-invite'],
      visibility: 'private',
    }));
  } catch (_) {}

  return msg;
}
