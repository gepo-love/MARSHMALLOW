import { resolveGenerationMaxTokens } from '../api.js';
import { chatJsonGeneration } from '../chat-json-generation.js';
import { resolveSceneApiConfig } from '../api-presets.js';
import { getNowForUser } from '../time-mode.js';
import { buildChatContext } from '../context/build-chat-context.js';
import { saveMessage } from '../chat-store.js';
import { createMessage } from '../../models/chat.js';
import { getRecord, putRecord } from '../db.js';
import { getCharacterAiContextName, normalizeTranslationProfile } from '../../models/character.js';
import { createEventMemory } from '../../models/event-memory.js';
import { createSharedKnowledgeFromStoryCard } from '../memory/shared-event-knowledge.js';
import { VARIED_SEGMENTATION_HINT } from '../narration-settings.js';
import { archiveNarration } from '../narration-archive.js';
import { applyPermanentRegex, applyPromptRegex, primeRegex } from '../display-regex.js';
import { recoverStoryCardResponse } from './story-card-recovery.js';

function translationInstruction(speakers = { full: [], mixed: [] }) {
  const lines = [];
  if (speakers.full?.length) {
    const list = speakers.full.map((s) => `${s.name}（主要讲${s.language || 'TA 设定里的外语'}）`).join('、');
    lines.push(`外语人设：${list} 的直接引语台词要写外语原文（不要写成中文），紧跟着用〔〕标出中文翻译，如：「I'm home.」〔我回来了。〕；旁白与其他角色对白仍正常写中文；必须用半角方头括号〔〕，不要用普通括号（）。`);
  }
  if (speakers.mixed?.length) {
    const list = speakers.mixed.map((s) => `${s.name}（偶尔蹦${s.dialectNote || '外语/方言词句'}）`).join('、');
    lines.push(`偶尔外语/方言：${list} 对白正常写中文，只有偶尔蹦出这类词句时，直接紧跟着用〔〕标出意思，不要整句翻译，也不要没事找词硬凑，必须用〔〕而不是普通括号（）。`);
  }
  return lines.join('\n');
}

function normalizeStoryParticipantIds(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((id) => String(id || '').trim())
      .filter((id) => id && id !== 'user'),
  )].sort();
}

export function selectPreviousOfflineStoryCard(messages = [], {
  participantIds = [],
  userPresent = true,
  excludeMessageId = '',
} = {}) {
  const expectedParticipants = normalizeStoryParticipantIds(participantIds);
  const excludedId = String(excludeMessageId || '').trim();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.deleted || message.recalled) continue;
    if (excludedId && String(message.id || '') === excludedId) continue;
    if (message.type !== 'storyCard' || message.metadata?.offlineFastForward !== true) continue;
    if (message.metadata?.generationStatus === 'format-error') continue;
    const metadata = message.metadata || {};
    const actualParticipants = normalizeStoryParticipantIds(metadata.participantIds);
    if (actualParticipants.length !== expectedParticipants.length) continue;
    if (!actualParticipants.every((id, participantIndex) => id === expectedParticipants[participantIndex])) continue;
    if ((metadata.userPresent === true) !== (userPresent === true)) continue;
    return message;
  }
  return null;
}

export function buildPreviousStoryCardContinuationBlock(message) {
  if (!message) return '';
  const metadata = message.metadata || {};
  const fullText = String(
    metadata.fullText
      || (Array.isArray(metadata.paragraphs) ? metadata.paragraphs.join('\n\n') : '')
      || message.content
      || '',
  ).trim();
  const title = String(metadata.title || '').trim();
  const summary = String(metadata.summary || metadata.digest || '').trim();
  const followupHook = String(metadata.followupHook || '').trim();
  if (!fullText && !summary && !followupHook) return '';
  return [
    '【上一张同场小剧场 · 必须承接】',
    title ? `标题：${title}` : '',
    summary ? `摘要：${summary}` : '',
    fullText ? `完整正文：\n${fullText}` : '',
    followupHook ? `事件结束后的余波：${followupHook}` : '',
    '这段内容已经发生，不是待重演的提纲。本次必须从它的结尾、结果或余波之后继续；若有时间跨度，也要从其结果之后自然跨过。除非附加要求明确要求换场或另写，否则禁止另起一段互不相干的故事，也禁止重复上一张已完成的流程。',
  ].filter(Boolean).join('\n');
}

function buildStoryCardUserPrompt({
  mode,
  targetWords,
  wordMin,
  wordMax,
  timeLabel,
  toneLabel,
  extraPrompt,
  participantNames,
  translationSpeakers,
  userPresent,
  userName,
  previousStoryContext,
}) {
  return [
    '[线下小剧场生成任务]',
    `推进模式：${mode === 'time+story' ? '时间推进 + 小剧场' : mode === 'memory' ? '回忆补充' : '仅小剧场'}`,
    '严格区分：这不是聊天续写，不要输出聊天气泡、对话协议、发送标签、群聊格式、角色名冒号接台词，也不要代替用户发言。',
    '严格区分：这是一个单独展示的小剧场卡片，用于收纳线下过场、时间流逝后的片段、场景动作和关系变化。',
    mode === 'memory'
      ? '当前任务是回忆补充：补写过去已经发生过的一小段片段，用来补全角色之间已有的共同经历，不要写成当前时刻的新推进。'
      : '',
    timeLabel ? `时间跨度：${timeLabel}` : '时间跨度：请根据当前节奏自然决定，可轻微跳时。',
    toneLabel ? `语气：${toneLabel}` : '语气：延续当前关系氛围，自然推进。',
    Number(wordMin) > 0 && Number(wordMax) >= Number(wordMin)
      ? `篇幅：正文控制在 ${wordMin}~${wordMax} 字之间，这是用户选择的范围，请认真贴合。`
      : `目标字数：约 ${targetWords} 字，可小幅浮动，但不要明显过短。`,
    participantNames.length ? `涉及角色：${participantNames.join('、')}` : '涉及角色：围绕当前会话相关角色自然展开。',
    userPresent
      ? `在场关系：${userName || '用户'}也在现场。可以写用户已经明确给出的动作和反应，但不要替用户编造新的关键台词、决定或越过用户意愿。`
      : `在场关系：${userName || '用户'}不在现场，只是旁观这段小剧场。正文不得把用户写进场景，也不得让角色隔空向用户汇报。`,
    previousStoryContext,
    '写法：以旁白、动作、场景为主，可夹少量关键对白；重点是推进而不是复述。',
    '正文必须自然分段，至少 2 段。',
    VARIED_SEGMENTATION_HINT,
    '摘要必须是 1~2 句、总长不超过 60 字，适合折叠态展示。',
    extraPrompt ? `附加要求：${extraPrompt}` : '',
    translationInstruction(translationSpeakers),
    '必须严格输出 1 个 JSON 对象，不要添加其它说明，不要用 markdown 解释。',
    'JSON 结构：{"title":"不超过18字","summary":"1~2句且不超过60字","paragraphs":["自然段1","自然段2"],"characters":["名字1","名字2"],"digest":"80~140字的系统总结","keyDialogues":["关键对话1"],"followupHook":"事件结束后的余波或当前状态；只能从结果之后继续，禁止把正文已完成的流程写成待办"}',
  ].filter(Boolean).join('\n');
}

export async function createOfflineStoryCard(ctx, options = {}) {
  await primeRegex().catch(() => null);
  const {
    mode = 'time+story',
    targetWords = 500,
    wordMin = 0,
    wordMax = 0,
    timeLabel = '',
    toneLabel = '',
    extraPrompt = '',
    participantIds: requestedParticipantIds,
    userPresent: requestedUserPresent,
    presetStyleIds = [],
    excludePreviousStoryCardId = '',
  } = options;
  const chat = ctx.chat;
  const chatId = String(ctx.chatId || chat?.id || '').trim();
  const user = ctx.user || null;
  const userId = String(user?.id || '').trim();
  const participantIds = [...new Set(
    (Array.isArray(requestedParticipantIds) ? requestedParticipantIds : (chat?.participants || []))
      .map((id) => String(id || '').trim())
      .filter((id) => id && id !== 'user'),
  )].slice(0, 6);
  const userPresent = requestedUserPresent === undefined
    ? (chat?.participants || []).includes('user')
    : requestedUserPresent === true;
  const sourceParticipantIds = (chat?.participants || [])
    .filter((id) => id && id !== 'user')
    .map(String)
    .sort();
  const contextParticipantIds = [...participantIds].sort();
  const sameRoster = sourceParticipantIds.length === contextParticipantIds.length
    && sourceParticipantIds.every((id, index) => id === contextParticipantIds[index])
    && (chat?.participants || []).includes('user') === userPresent;
  const participantNames = [];
  const translationSpeakers = { full: [], mixed: [] };
  for (const id of participantIds) {
    const row = await getRecord('characters', id);
    const name = getCharacterAiContextName(row, id);
    participantNames.push(name);
    const profile = normalizeTranslationProfile(row?.translationProfile);
    if (profile.mode === 'full') {
      translationSpeakers.full.push({ name, language: profile.language });
    } else if (profile.mode === 'mixed') {
      translationSpeakers.mixed.push({ name, dialectNote: profile.dialectNote });
    }
  }

  const contextChat = {
    ...chat,
    id: sameRoster ? chat?.id : `offline-theater:${participantIds.join(',')}:${userPresent ? 'with-user' : 'observer'}`,
    type: participantIds.length > 1 || !userPresent ? 'group' : (chat?.type || 'private'),
    participants: userPresent ? ['user', ...participantIds] : participantIds,
    groupSettings: participantIds.length > 1 || !userPresent
      ? {
        ...(chat?.groupSettings || {}),
        isObserverMode: !userPresent,
      }
      : (chat?.groupSettings || {}),
  };
  const { messages: contextMessages } = await buildChatContext({
    chat: contextChat,
    chatId: contextChat.id,
    user,
    userId,
    messages: sameRoster ? (ctx.messages || []) : [],
    sceneDirective: '',
    regexSurface: 'storycard',
    presetMode: 'offline',
    presetOnlyIds: Array.isArray(presetStyleIds) && presetStyleIds.length
      ? presetStyleIds
      : undefined,
  });

  const userName = user?.name || '用户';
  const storedExtraPrompt = applyPermanentRegex(extraPrompt, {
    surface: 'storycard',
    placement: 1,
    depth: 0,
    macros: { user: userName, char: participantNames[0] || '角色' },
  });
  const promptExtra = applyPromptRegex(storedExtraPrompt, {
    surface: 'storycard',
    placement: 1,
    depth: 0,
    macros: { user: userName, char: participantNames[0] || '角色' },
  });
  const previousStoryCard = mode === 'memory'
    ? null
    : selectPreviousOfflineStoryCard(ctx.messages || [], {
      participantIds,
      userPresent,
      excludeMessageId: excludePreviousStoryCardId,
    });
  const previousStoryContext = buildPreviousStoryCardContinuationBlock(previousStoryCard);
  const prompt = buildStoryCardUserPrompt({
    mode,
    targetWords,
    wordMin,
    wordMax,
    timeLabel,
    toneLabel,
    extraPrompt: promptExtra,
    participantNames,
    translationSpeakers,
    userPresent,
    userName,
    previousStoryContext,
  });

  const apiOverride = await resolveSceneApiConfig().catch(() => null);
  const storyMaxTokens = await resolveGenerationMaxTokens(apiOverride);
  let generated = null;
  let text = '';
  let recovery = null;
  try {
    generated = await chatJsonGeneration({
      scope: 'offline-story-card',
      messages: [...contextMessages, { role: 'user', content: prompt }],
      temperature: 0.9,
      maxTokens: storyMaxTokens,
      structureStrengthening: true,
      requestOptions: { configOverride: apiOverride || undefined },
      validate: (value) => value
        && typeof value === 'object'
        && !Array.isArray(value)
        && Array.isArray(value.paragraphs)
        && value.paragraphs.some((part) => String(part || '').trim()),
    });
    text = generated.raw.trim();
  } catch (error) {
    if (!String(error?.rawText || '').trim()) throw error;
    recovery = recoverStoryCardResponse(error.rawText, error);
    text = recovery.paragraphs.join('\n\n');
  }
  let title = '小剧场';
  let summaryText = '';
  let paragraphs = [];
  let characters = [];
  let digest = '';
  let keyDialogues = [];
  let followupHook = '';
  const parsed = generated?.data;
  if (parsed) {
      title = String(parsed?.title || '小剧场').trim() || '小剧场';
      summaryText = String(parsed?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      paragraphs = Array.isArray(parsed?.paragraphs)
        ? parsed.paragraphs.map((part) => String(part || '').trim()).filter(Boolean)
        : [];
      characters = Array.isArray(parsed?.characters)
        ? parsed.characters.map((name) => String(name || '').trim()).filter(Boolean).slice(0, 6)
        : [];
      digest = String(parsed?.digest || '').trim();
      keyDialogues = Array.isArray(parsed?.keyDialogues)
        ? parsed.keyDialogues.map((part) => String(part || '').trim()).filter(Boolean).slice(0, 6)
        : [];
      followupHook = String(parsed?.followupHook || '').trim();
  } else if (recovery) {
      title = recovery.title;
      summaryText = recovery.summary;
      paragraphs = recovery.paragraphs;
      characters = recovery.characters;
      digest = recovery.digest;
      keyDialogues = recovery.keyDialogues;
      followupHook = recovery.followupHook;
  }
  if (!paragraphs.length && !recovery) {
    paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    summaryText = String(paragraphs[0] || text).replace(/\s+/g, ' ').trim().slice(0, 60);
    digest = summaryText;
  }
  const permanentContext = {
    surface: 'storycard',
    placement: 2,
    depth: 0,
    macros: { user: userName, char: participantNames[0] || '角色' },
  };
  title = applyPermanentRegex(title, permanentContext);
  summaryText = applyPermanentRegex(summaryText, permanentContext);
  paragraphs = paragraphs.map((part) => applyPermanentRegex(part, permanentContext));
  digest = applyPermanentRegex(digest, permanentContext);
  keyDialogues = keyDialogues.map((part) => applyPermanentRegex(part, permanentContext));
  followupHook = applyPermanentRegex(followupHook, permanentContext);

  const ts = await getNowForUser(userId);
  const storyCard = createMessage({
    chatId,
    senderId: 'system',
    senderName: '系统',
    type: 'storyCard',
    content: paragraphs.join('\n\n') || text,
    timestamp: ts,
    metadata: {
      title,
      summary: summaryText || String(text).replace(/\s+/g, ' ').trim().slice(0, 60),
      fullText: paragraphs.join('\n\n') || text,
      paragraphs,
      characters,
      digest,
      keyDialogues,
      followupHook,
      timeLabel: String(timeLabel || '').trim(),
      toneLabel: String(toneLabel || '').trim(),
      extraPrompt: storedExtraPrompt,
      expanded: false,
      targetWords: Number(targetWords) || 500,
      wordMin: Number(wordMin) || 0,
      wordMax: Number(wordMax) || 0,
      mode,
      participantIds,
      userPresent,
      presetStyleIds: Array.isArray(presetStyleIds) ? presetStyleIds : [],
      offlineFastForward: true,
      continuedFromStoryCardId: String(previousStoryCard?.id || '').trim(),
      generationStatus: recovery?.status || 'complete',
      generationNotice: recovery?.notice || '',
      generationFailureReason: recovery?.failureReason || '',
      generationFailureKind: recovery?.failureKind || '',
      rawModelResponse: recovery?.rawResponse || '',
    },
  });
  await saveMessage(storyCard);

  if (paragraphs.length) {
    archiveNarration({
      kind: 'storycard',
      title: title || '小剧场',
      subtitle: [String(timeLabel || '').trim(), participantNames[0]].filter(Boolean).join(' · '),
      text: paragraphs.join('\n\n') || text,
      chatId,
      characterName: participantNames[0] || '',
    });
  }

  // 抢救卡与格式异常卡会保留在聊天中供用户查看、编辑或重 roll，但不能在用户
  // 确认前写成“已经完整发生”的共享记忆，避免半截剧情污染后续聊天。
  if (recovery) return storyCard;

  const knownBy = {};
  for (const id of participantIds) knownBy[id] = 'involved';
  const eventSummary = digest || summaryText
    || String(text).replace(/\s+/g, ' ').trim().slice(0, 220);
  try {
    await createSharedKnowledgeFromStoryCard({
      chatId,
      messageId: storyCard.id,
      userId,
      summary: digest || summaryText,
      characterIds: participantIds,
      timestamp: storyCard.timestamp,
    });
  } catch (_) { /* 共享知情写入失败不阻塞小剧场 */ }
  try {
    await putRecord('eventMemories', createEventMemory({
      userId,
      sourceMessageId: storyCard.id,
      summary: eventSummary,
      timestamp: storyCard.timestamp,
      knownBy,
      involvedChats: [chatId].filter(Boolean),
      highlight: followupHook || summaryText || '',
      pendingThreads: [],
      temporalState: 'completed',
      tags: ['storyCard', 'offline-fast-forward', String(mode || '').trim()].filter(Boolean),
      visibility: 'private',
    }));
  } catch (_) { /* 事件记忆写入失败不阻塞小剧场 */ }

  return storyCard;
}
