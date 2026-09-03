import { resolveGenerationMaxTokens } from './api.js';
import { normalizeTranslationProfile } from '../models/character.js';
import {
  chatJsonGeneration,
  composeContextualGenerationMessages,
} from './chat-json-generation.js';
import { getCharacter, listCharacters } from './character-store.js';
import { ensurePrivateChat, listChatsForUser, listMessagesForChat } from './chat-store.js';
import { listSocialVisibleCharacters } from './social-character-scope.js';
import { generateAnonymousNpcProfiles, persistAnonymousNpcs } from './anonymous-npc.js';
import { buildChatContext } from './context/build-chat-context.js';
import { get as dbGet, put as dbPut } from './db.js';
import {
  createMailboxMessage,
  getMailboxMessage,
  listMailboxThread,
  loadMailbox,
  patchMailboxMessage,
} from './mailbox-store.js';
import {
  isAutonomyMuteHourActive,
  loadResolvedCharacterAutonomyPolicy,
} from './character-autonomy-settings.js';
import {
  reserveProactiveDelivery,
  settleProactiveDelivery,
} from './character-proactive-usage.js';
import { resolveCharacterScheduleTimezone } from './chat/chat-timezone.js';
import {
  loadMailboxPreset,
  normalizeMailboxType,
  saveMailboxPreset,
} from './mailbox-presets.js';
import {
  sanitizeAiTranslation,
  translationProfileBrief,
} from './translation-utils.js';

export const MAILBOX_PROACTIVE_CHECK_MS = 60 * 60 * 1000;
export const MAILBOX_CHAT_HISTORY_LOAD_LIMIT = 160;
const PROACTIVE_RETRY_GUARD_MS = 6 * 60 * 60 * 1000;
const replyLocks = new Set();
const mailboxRoundLocks = new Set();

function clean(value = '', max = 0) {
  const text = String(value ?? '').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function hashId(value = '') {
  let hash = 2166136261;
  for (const char of String(value || 'mail')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 7);
}

export function characterMailboxAddress(character = {}) {
  const id = clean(character.id, 180) || clean(character.name, 80) || 'letter';
  const asciiName = clean(character.realName || character.name || character.customNickname, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 24);
  return `${asciiName || 'letter'}.${hashId(id)}@postbox.me`;
}

function characterName(character = {}) {
  return clean(character.realName || character.name || character.customNickname, 80) || 'TA';
}

function mailboxRecipientName(character = {}) {
  return clean(
    character.remarkName
      || character.customNickname
      || character.realName
      || character.name
      || character.forumIdentity?.displayName,
    80,
  ) || 'TA';
}

function mailboxRecipientSearchTerms(character = {}) {
  return [...new Set([
    character.remarkName,
    character.customNickname,
    character.realName,
    character.name,
    character.forumIdentity?.displayName,
  ].map((value) => clean(value, 80)).filter(Boolean))];
}

export const MAILBOX_RECIPIENT_CATEGORIES = Object.freeze({
  contact: '通讯录角色',
  forum: '论坛网友',
  stranger: '陌生消息与匿名网友',
});

function characterIdsFromChat(chat = {}) {
  const ids = new Set((Array.isArray(chat?.participants) ? chat.participants : [])
    .map((value) => clean(value, 180))
    .filter((value) => value && value !== 'user'));
  const metadata = chat?.metadata || {};
  for (const key of (Array.isArray(metadata.strangerParticipantKeys) ? metadata.strangerParticipantKeys : [])) {
    if (String(key || '').startsWith('character:')) ids.add(clean(String(key).slice('character:'.length), 180));
  }
  for (const key of Object.keys(metadata.accountIdentityMap || {})) {
    if (String(key || '').startsWith('character:')) ids.add(clean(String(key).slice('character:'.length), 180));
  }
  [
    chat?.characterId,
    metadata.sourceForumActorId,
    chat?.anonymousPrivateConfig?.counterpartActorId,
    ...(Array.isArray(metadata.anonymousNpcActorIds) ? metadata.anonymousNpcActorIds : []),
  ].forEach((value) => {
    const id = clean(value, 180);
    if (id) ids.add(id);
  });
  return ids;
}

function isMailboxForumPasserby(character = {}) {
  return character?.forumIdentity?.kind === 'passerby';
}

function isMailboxAnonymousCharacter(character = {}) {
  return clean(character?.groupId) === 'anon_npc'
    || !!clean(character?.anonymousLifecycle?.phase);
}

export function mailboxRecipientCategory(character = {}, scope = {}) {
  if (isMailboxForumPasserby(character)) return 'forum';
  if (isMailboxAnonymousCharacter(character)) return 'stranger';
  return 'contact';
}

export function mailboxCharacterBelongsToScope(character = {}, scope = {}) {
  const id = clean(character?.id, 180);
  if (!id) return false;
  const forumOwnerId = clean(character?.forumIdentity?.userId, 180);
  if (isMailboxForumPasserby(character)) {
    return forumOwnerId
      ? scope.slotUserIds?.has?.(forumOwnerId) === true
      : scope.referencedActorIds?.has?.(id) === true;
  }
  if (isMailboxAnonymousCharacter(character)) {
    return scope.referencedActorIds?.has?.(id) === true;
  }
  return scope.contactActorIds?.has?.(id) === true;
}

function characterSnapshot(character = {}) {
  const translationProfile = normalizeTranslationProfile(character.translationProfile);
  return {
    id: clean(character.id, 180),
    name: characterName(character),
    personality: clean(character.personality, 1800),
    speechStyle: clean(character.speechStyle, 1400),
    background: clean(character.background || character.backstory, 2200),
    relationship: clean(character.userRelationStatus || character.relationshipToUser, 900),
    status: clean(character.currentStatus, 600),
    translationProfile: translationProfileBrief(translationProfile) || { mode: 'off' },
  };
}

function mailHistory(rows = []) {
  return rows.slice(-12).map((row) => ({
    direction: row.direction,
    mailType: normalizeMailboxType(row.mailType, { allowAuto: row.direction === 'outbound' }),
    subject: clean(row.subject, 180),
    body: clean(row.body, 1800),
    timestamp: Number(row.timestamp || 0) || 0,
  }));
}

async function recentChatContext(userId, characterId) {
  const chats = await listChatsForUser(userId).catch(() => []);
  const chat = chats.find((row) => (
    row?.type === 'private'
    && Array.isArray(row.participants)
    && row.participants.includes('user')
    && row.participants.includes(characterId)
  ));
  if (!chat) return { chat: null, messages: [] };
  return {
    chat,
    messages: await listMessagesForChat(
      chat.id,
      MAILBOX_CHAT_HISTORY_LOAD_LIMIT,
      { deferHeavyImages: true },
    ).catch(() => []),
  };
}

function typeBiasInstruction(value = '') {
  if (value === 'personal') return '在人设允许时，更偏向日常、问候和亲密的私人邮件。';
  if (value === 'longform') return '有真实内容可写时，更愿意选择长信，但不要为了长度注水。';
  if (value === 'practical') return '更偏向克制、实际的近况、邀请或事务邮件。';
  return '根据真实写信动机自然选择类型，不要轮流打卡。';
}

async function buildMailboxContextMessages({ user, character, recent, contextDepth }) {
  if (!recent?.chat) return [];
  try {
    const built = await buildChatContext({
      chat: recent.chat,
      chatId: recent.chat.id,
      user,
      userId: user.id,
      messages: recent.messages,
      characters: { [character.id]: character },
      contextDepth,
      presetMode: 'offline',
      sceneDirective: '[邮箱上下文编译] 只整理角色卡、用户卡、世界书、记忆、当前场景与近期对话；此处不生成聊天气泡。',
    });
    return Array.isArray(built?.messages) ? built.messages : [];
  } catch (_) {
    return [];
  }
}

async function generateMailJson({
  user,
  character,
  thread = [],
  recent = null,
  mode = 'reply',
  requestedType = 'auto',
  sourceCategory = 'contact',
}) {
  const preset = await loadMailboxPreset(user.id).catch(() => ({ contextDepth: 80, typeBias: 'natural', customInstruction: '' }));
  const contextMessages = await buildMailboxContextMessages({
    user,
    character,
    recent,
    contextDepth: preset.contextDepth,
  });
  const payload = {
    character: characterSnapshot(character),
    user: { name: clean(user?.name || user?.nickname, 80) || '用户' },
    mailThread: mailHistory(thread),
    requestedType: normalizeMailboxType(requestedType),
    typeBias: preset.typeBias,
  };
  const incomingTask = sourceCategory === 'forum'
    ? '这封信来自用户在当前档位论坛里见过的网友。请以前台论坛身份自然写一封应用内邮件；只使用公开身份和论坛式关系，不得泄露匿名背后的真实身份、其它账号或私聊秘密。'
    : sourceCategory === 'stranger'
      ? '这封信来自当前档位陌生消息或匿名空间中的网友。请保持陌生或刚认识的关系边界，自然写一封有明确来意的应用内邮件；不得假装已有亲密关系，不得揭露未公开的真实身份。'
      : '角色决定此刻写一封应用内邮件给用户。邮件应有真实的写信动机，结合近期对话和已有往来，不要把普通聊天气泡换个壳。';
  const task = mode === 'reply'
    ? '角色读到了邮件串中用户最新一封信，请以角色本人身份自然回信。回信要真正回应来信，不要替用户表态，不要提到模型、模块或规则。'
    : `${incomingTask} 不要提到定时、生成、模块或规则。`;
  const maxTokens = await resolveGenerationMaxTokens();
  const outputTypes = 'personal|check_in|apology|invitation|update|long_letter|practical|playful';
  const translationProfile = normalizeTranslationProfile(character.translationProfile);
  const translationInstruction = translationProfile.mode === 'full'
    ? `角色主要使用${translationProfile.language || '设定外语或方言'}：body 必须写该语言原文，并在 bodyZh 给出完整、通顺的简体中文普通话翻译。即使方言原文全是汉字，也不能省略 bodyZh 或只做繁简转换。subject 直接使用简体中文，方便邮箱列表识别。`
    : translationProfile.mode === 'mixed'
      ? `角色会偶尔夹用${translationProfile.dialectNote || translationProfile.language || '外语或方言'}：body 按人设自然写；只要正文实际出现外语或方言表达，就在 bodyZh 给出整封正文的简体中文普通话版本，否则 bodyZh 留空。subject 直接使用简体中文。`
      : '角色未开启外语或方言翻译：subject 和 body 使用自然的简体中文，bodyZh 留空。';
  const finalPrompt = [
    `邮件背景 JSON：\n${JSON.stringify(payload)}`,
    `任务：${task}`,
    `类型规则：${payload.requestedType === 'auto'
      ? `${typeBiasInstruction(preset.typeBias)} 从 ${outputTypes} 中选择最贴合本次动机的一种。`
      : `本封指定为 ${payload.requestedType}，除非与人设或来信明显冲突，否则按该类型写。`}`,
    clean(preset.customInstruction, 4000) ? `用户的邮箱预设：\n${clean(preset.customInstruction, 4000)}` : '',
    '本次是应用内邮件任务，不是聊天气泡生成；忽略上下文中对聊天协议输出格式的要求。',
    translationInstruction,
    '只输出 JSON：{"mailType":"personal","subject":"","body":"","bodyZh":""}',
    '要求：mailType 必须是列出的一个英文枚举；subject 是邮件主题，body 是完整正文，bodyZh 只放对应中文译文。邮件可以比聊天更完整，但长度和语气必须符合人设、记忆、世界设定与当下关系。',
  ].filter(Boolean).join('\n\n');
  const incomingMode = mode !== 'reply';
  const { data } = await chatJsonGeneration({
    scope: incomingMode ? `mailbox-${mode}` : 'mailbox-reply',
    // 角色卡、世界书与记忆保持在 buildChatContext 原始 system 层；旧中转若确实
    // 不接受 system，只由 API 设置把 system 合并到首条 user，业务层不再私自降级。
    messages: composeContextualGenerationMessages({
      contextMessages,
      userContent: finalPrompt,
    }),
    temperature: incomingMode ? 0.9 : 0.82,
    maxTokens,
    preferStream: true,
    validate: (value) => clean(value?.body).length > 0,
    auditContext: {
      operation: incomingMode ? `mailbox-${mode}` : 'mailbox-reply',
      initiator: mode === 'scheduled' || mode === 'proactive' ? 'background' : 'user-action',
      trigger: mode === 'scheduled' ? 'mailbox-scheduled' : (mode === 'proactive' ? 'mailbox-interval' : (mode === 'manual' ? 'mailbox-manual-round' : 'mailbox-user-mail')),
      actorId: clean(character.id, 180),
    },
  });
  const body = clean(data?.body, 12000);
  const bodyTranslation = sanitizeAiTranslation(
    body,
    data?.bodyZh || data?.bodyTranslation || data?.zh,
    { languageHint: translationProfile.language || translationProfile.dialectNote || '' },
  );
  return {
    mailType: normalizeMailboxType(data?.mailType, { allowAuto: false }),
    subject: clean(data?.subject, 180),
    body,
    bodyTranslation,
  };
}

function chooseMailboxRoundRecipient(rows = [], mailbox = null) {
  const messages = Array.isArray(mailbox?.messages) ? mailbox.messages : [];
  return [...rows].sort((left, right) => {
    const lastFor = (candidate) => Math.max(0, ...messages
      .filter((mail) => clean(mail.characterId || mail.from?.actorId || mail.to?.[0]?.actorId) === clean(candidate.characterId))
      .map((mail) => Number(mail.timestamp || 0) || 0));
    return lastFor(left) - lastFor(right) || left.name.localeCompare(right.name, 'zh-CN');
  })[0] || null;
}

async function createMailboxStrangerRecipient(userId = '', recipients = []) {
  const profiles = await generateAnonymousNpcProfiles({
    count: 1,
    vibe: '像真实陌生网友，有具体来意但保持边界，不套近乎',
    roomTopic: '偶然得到一个应用内邮箱地址，决定写一封来意明确的陌生邮件',
    reservedHandles: recipients.map((row) => row.name).filter(Boolean),
  });
  const [saved] = await persistAnonymousNpcs(profiles, { ephemeral: false });
  const character = saved?.actorId
    ? await getCharacter(saved.actorId, { userId }).catch(() => null)
    : null;
  if (!character) return null;
  return {
    characterId: character.id,
    name: saved.anonymousId || mailboxRecipientName(character),
    address: characterMailboxAddress(character),
    category: 'stranger',
    searchTerms: [saved.anonymousId || character.name].filter(Boolean),
  };
}

export async function generateMailboxRound({
  user,
  sources = ['contact'],
  reason = 'manual',
  groupId = '',
  characterId = '',
} = {}) {
  const userId = clean(user?.id, 180);
  if (!userId) return { ok: false, reason: 'missing-user', generatedCount: 0 };
  if (mailboxRoundLocks.has(userId)) return { ok: false, reason: 'in-flight', generatedCount: 0 };
  mailboxRoundLocks.add(userId);
  try {
    const allowedSources = [...new Set((Array.isArray(sources) ? sources : [sources])
      .map((value) => clean(value, 40))
      .filter((value) => ['contact', 'forum', 'stranger'].includes(value)))];
    const selectedSources = allowedSources.length ? allowedSources : ['contact'];
    const [recipients, mailbox] = await Promise.all([
      listMailboxRecipients(userId),
      loadMailbox(userId),
    ]);
    const generated = [];
    const skippedSources = [];
    const requestedCharacterId = clean(characterId, 180);
    const requestedGroupId = clean(groupId, 180);
    const exactRecipient = requestedCharacterId
      ? recipients.find((row) => row.characterId === requestedCharacterId) || null
      : null;
    const targets = exactRecipient
      ? [{ sourceCategory: exactRecipient.category, recipient: exactRecipient }]
      : requestedGroupId
        ? [{
          sourceCategory: 'contact',
          recipient: chooseMailboxRoundRecipient(
            recipients.filter((row) => row.category === 'contact' && row.groupId === requestedGroupId),
            mailbox,
          ),
        }]
        : selectedSources.map((sourceCategory) => ({
          sourceCategory,
          recipient: chooseMailboxRoundRecipient(
            recipients.filter((row) => row.category === sourceCategory),
            mailbox,
          ),
        }));
    if (requestedCharacterId && !exactRecipient) {
      return { ok: false, reason: 'target-out-of-scope', generatedCount: 0 };
    }
    for (const target of targets) {
      const sourceCategory = target.sourceCategory;
      let recipient = target.recipient;
      if (!recipient && sourceCategory === 'stranger') {
        recipient = await createMailboxStrangerRecipient(userId, recipients);
      }
      if (!recipient) {
        skippedSources.push(sourceCategory);
        continue;
      }
      const character = await getCharacter(recipient.characterId, { userId }).catch(() => null);
      if (!character) {
        skippedSources.push(sourceCategory);
        continue;
      }
      const recent = sourceCategory === 'contact'
        ? await recentChatContext(userId, recipient.characterId)
        : null;
      const related = (mailbox?.messages || [])
        .filter((row) => clean(row.characterId || row.from?.actorId || row.to?.[0]?.actorId) === clean(recipient.characterId))
        .slice().reverse();
      const draft = await generateMailJson({
        user,
        character,
        thread: related,
        recent,
        mode: reason === 'scheduled' ? 'scheduled' : 'manual',
        sourceCategory,
      });
      if (!draft.body) continue;
      const mail = await createMailboxMessage(userId, {
        direction: 'inbound',
        from: { name: recipient.name, address: recipient.address, actorId: recipient.characterId },
        to: [{ name: clean(user.name || user.nickname, 80) || '我', address: mailbox?.accountAddress }],
        subject: draft.subject || '写给你',
        body: draft.body,
        bodyTranslation: draft.bodyTranslation,
        mailType: draft.mailType,
        source: sourceCategory === 'contact' ? 'mailbox-round-contact' : `mailbox-round-${sourceCategory}`,
        sourceChatId: recent?.chat?.id || '',
        characterId: recipient.characterId,
      });
      generated.push({ mailId: mail.id, characterId: recipient.characterId, category: sourceCategory, name: recipient.name });
    }
    return {
      ok: generated.length > 0,
      generated: generated.length > 0,
      generatedCount: generated.length,
      messages: generated,
      skippedSources,
      reason: generated.length ? reason : 'no-source-candidates',
    };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error || 'failed'), generatedCount: 0 };
  } finally {
    mailboxRoundLocks.delete(userId);
  }
}

export async function listMailboxRecipients(userId = '') {
  const uid = clean(userId, 180);
  if (!uid) return [];
  const [allCharacters, mailbox, visibleCharacters, chats] = await Promise.all([
    listCharacters({ includeInternal: true, userId: uid }).catch(() => []),
    loadMailbox(uid).catch(() => null),
    listSocialVisibleCharacters(null, {
      userId: uid,
      excludeAnonNpc: true,
    }).catch(() => []),
    listChatsForUser(uid).catch(() => []),
  ]);
  const slotUserIds = new Set([uid]);
  const contactActorIds = new Set(visibleCharacters.map((row) => clean(row?.id, 180)).filter(Boolean));
  const referencedActorIds = new Set();
  const strangerActorIds = new Set();
  for (const chat of chats) {
    const actorIds = characterIdsFromChat(chat);
    actorIds.forEach((id) => referencedActorIds.add(id));
    if (clean(chat?.metadata?.channelKind) === 'stranger_intercept') {
      actorIds.forEach((id) => strangerActorIds.add(id));
    }
  }
  for (const mail of (mailbox?.messages || [])) {
    const actorId = clean(mail.characterId || mail.from?.actorId || mail.to?.[0]?.actorId, 180);
    if (actorId) referencedActorIds.add(actorId);
  }
  const scope = { slotUserIds, contactActorIds, referencedActorIds, strangerActorIds };
  return allCharacters.filter((character) => mailboxCharacterBelongsToScope(character, scope)).map((character) => {
    const known = (mailbox?.messages || []).find((mail) => (
      clean(mail.characterId || mail.from?.actorId || mail.to?.[0]?.actorId) === clean(character.id)
      && clean(mail.direction === 'inbound' ? mail.from?.address : mail.to?.[0]?.address)
    ));
    return {
      characterId: character.id,
      name: mailboxRecipientName(character),
      searchTerms: mailboxRecipientSearchTerms(character),
      category: mailboxRecipientCategory(character, scope),
      groupId: clean(character.groupId, 180) || 'default',
      address: clean(known
        ? (known.direction === 'inbound' ? known.from?.address : known.to?.[0]?.address)
        : characterMailboxAddress(character), 160).toLowerCase(),
    };
  }).sort((left, right) => {
    const categoryOrder = ['contact', 'forum', 'stranger'];
    const categoryDelta = categoryOrder.indexOf(left.category) - categoryOrder.indexOf(right.category);
    return categoryDelta || left.name.localeCompare(right.name, 'zh-CN');
  });
}

export async function resolveMailboxRecipient(userId, address = '') {
  const target = clean(address, 160).toLowerCase();
  if (!target) return null;
  const recipients = await listMailboxRecipients(userId);
  return recipients.find((row) => row.address === target) || null;
}

export async function generateCharacterMailboxReply({ user, mailId } = {}) {
  const userId = clean(user?.id, 180);
  const id = clean(mailId, 180);
  if (!userId || !id || replyLocks.has(id)) return { ok: false, reason: 'in-flight' };
  replyLocks.add(id);
  try {
    const mail = await getMailboxMessage(userId, id);
    if (!mail || mail.deleted || mail.direction !== 'outbound') return { ok: false, reason: 'missing-outbound-mail' };
    const thread = await listMailboxThread(userId, mail.threadId);
    const existing = thread.find((row) => row.direction === 'inbound' && row.inReplyTo === mail.id);
    if (existing) return { ok: true, skipped: true, reason: 'already-answered', mailId: existing.id };
    const characterId = clean(mail.characterId || mail.to?.[0]?.actorId, 180);
    const allowedRecipients = await listMailboxRecipients(userId);
    if (!allowedRecipients.some((row) => row.characterId === characterId)) {
      return { ok: false, reason: 'target-out-of-scope' };
    }
    const character = await getCharacter(characterId, { userId }).catch(() => null);
    if (!character) return { ok: false, reason: 'missing-character' };
    await patchMailboxMessage(userId, mail.id, { replyStatus: 'pending', replyError: '' });
    const recent = await recentChatContext(userId, characterId);
    const generated = await generateMailJson({
      user,
      character,
      thread,
      recent,
      mode: 'reply',
      requestedType: mail.mailType || 'auto',
    });
    if (!generated.body) throw new Error('回信内容为空');
    const current = await getMailboxMessage(userId, mail.id);
    if (!current || current.deleted) return { ok: false, reason: 'source-mail-deleted' };
    const inbound = await createMailboxMessage(userId, {
      direction: 'inbound',
      from: { name: characterName(character), address: mail.to?.[0]?.address || characterMailboxAddress(character), actorId: characterId },
      to: [{ name: clean(user.name || user.nickname, 80) || '我', address: mail.from?.address }],
      subject: generated.subject || (/^回复[:：]/.test(mail.subject) ? mail.subject : `回复：${mail.subject}`),
      body: generated.body,
      bodyTranslation: generated.bodyTranslation,
      mailType: generated.mailType,
      threadId: mail.threadId,
      inReplyTo: mail.id,
      source: 'mailbox-reply',
      sourceChatId: recent.chat?.id || '',
      characterId,
    });
    await patchMailboxMessage(userId, mail.id, { replyStatus: 'answered', replyError: '', repliedAt: inbound.timestamp });
    return { ok: true, mailId: inbound.id, characterId };
  } catch (error) {
    await patchMailboxMessage(userId, id, {
      replyStatus: 'failed',
      replyError: error?.message || String(error || '生成失败'),
    }).catch(() => null);
    return { ok: false, reason: error?.message || String(error || 'failed') };
  } finally {
    replyLocks.delete(id);
  }
}

function attemptKey(userId, characterId) {
  return `mailboxProactiveAttempt:v1:${encodeURIComponent(clean(userId))}:${encodeURIComponent(clean(characterId))}`;
}

export async function runMailboxProactiveCheck({ user, now = Date.now(), reason = '' } = {}) {
  const userId = clean(user?.id, 180);
  if (!userId) return { ok: false, reason: 'missing-user' };
  const preset = await loadMailboxPreset(userId).catch(() => null);
  if (preset?.autoFetchEnabled === true) {
    const intervalMs = Math.max(1, Number(preset.autoFetchIntervalHours) || 24) * 60 * 60 * 1000;
    const lastRunAt = Math.max(Number(preset.lastAutoGeneratedAt || 0), Number(preset.lastAutoAttemptAt || 0));
    if (!lastRunAt || now - lastRunAt >= intervalMs) {
      await saveMailboxPreset(userId, { lastAutoAttemptAt: now });
      const round = await generateMailboxRound({ user, sources: preset.autoFetchSources, reason: 'scheduled' });
      if (round.generated) {
        await saveMailboxPreset(userId, { lastAutoGeneratedAt: now });
        return round;
      }
    }
  }
  const [characters, mailbox] = await Promise.all([
    listSocialVisibleCharacters(user, { excludeAnonNpc: true }).catch(() => []),
    loadMailbox(userId).catch(() => null),
  ]);
  for (const character of characters) {
    const characterId = clean(character.id, 180);
    const policy = await loadResolvedCharacterAutonomyPolicy(userId, characterId).catch(() => null);
    if (policy?.totalEnabled !== true || policy?.mailboxProactive?.enabled !== true) continue;
    const timeZone = await resolveCharacterScheduleTimezone(userId, characterId).catch(() => '');
    if (isAutonomyMuteHourActive(policy, now, timeZone)) continue;
    const related = (mailbox?.messages || []).filter((row) => clean(row.characterId || row.from?.actorId || row.to?.[0]?.actorId) === characterId);
    // 用户刚写信后也要让出完整间隔；回信链路会单独接住这封信，
    // 主动扫描不应在旁边又起一封无关的新邮件。
    const lastContactAt = Math.max(0, ...related.map((row) => Number(row.timestamp || 0)));
    const intervalMs = Math.max(12, Number(policy.mailboxProactive.intervalHours) || 72) * 60 * 60 * 1000;
    if (lastContactAt && now - lastContactAt < intervalMs) continue;
    const stateKey = attemptKey(userId, characterId);
    const attemptRow = await dbGet(stateKey).catch(() => null);
    if (Number(attemptRow?.value?.lastAttemptAt || 0) > now - PROACTIVE_RETRY_GUARD_MS) continue;
    await dbPut({ key: stateKey, value: { lastAttemptAt: now, reason: clean(reason, 80) } });
    const chat = await ensurePrivateChat(userId, characterId, characterName(character)).catch(() => null);
    const reservation = await reserveProactiveDelivery({
      userId,
      characterId,
      chatId: chat?.id || '',
      channel: 'mailbox',
      reason,
      idempotencyKey: `${characterId}:mailbox:${Math.floor(now / intervalMs)}`,
      now,
      policy,
    }).catch((error) => ({ ok: false, reason: error?.message || 'reservation-failed' }));
    if (!reservation?.ok) continue;
    try {
      const thread = related.slice().reverse();
      const recent = {
        chat,
        messages: chat
          ? await listMessagesForChat(
            chat.id,
            MAILBOX_CHAT_HISTORY_LOAD_LIMIT,
            { deferHeavyImages: true },
          ).catch(() => [])
          : [],
      };
      const generated = await generateMailJson({ user, character, thread, recent, mode: 'proactive' });
      if (!generated.body) throw new Error('邮件内容为空');
      const address = related.find((row) => row.direction === 'inbound')?.from?.address || characterMailboxAddress(character);
      const mail = await createMailboxMessage(userId, {
        direction: 'inbound',
        from: { name: characterName(character), address, actorId: characterId },
        to: [{ name: clean(user.name || user.nickname, 80) || '我', address: mailbox?.accountAddress }],
        subject: generated.subject || '想写给你',
        body: generated.body,
        bodyTranslation: generated.bodyTranslation,
        mailType: generated.mailType,
        source: 'mailbox-proactive',
        sourceChatId: chat?.id || '',
        characterId,
      });
      await settleProactiveDelivery({ userId, characterId, reservationId: reservation.reservationId, ok: true, messageCount: 1, now });
      return { ok: true, generated: true, mailId: mail.id, characterId, characterName: characterName(character), subject: mail.subject };
    } catch (error) {
      await settleProactiveDelivery({
        userId,
        characterId,
        reservationId: reservation.reservationId,
        ok: false,
        reason: error?.message || 'generation-failed',
        error,
        now,
      }).catch(() => null);
      return { ok: false, reason: error?.message || String(error || 'failed'), characterId };
    }
  }
  return { ok: true, skipped: true, reason: 'no-due-character' };
}
