/**
 * 角色手机 · 拦截箱（陌生人过滤 / 黑名单）
 *
 * 独立「生成一轮」：轻量 NPC 骚扰、广告、爱而不得、粉丝纠缠、死敌仇人等。
 * 消息一律带红色感叹号（deliveryStatus rejected）；会话打 phoneChannel=intercept，
 * 不进消息 Tab，日常不进角色记忆。
 */
import * as db from './db.js';
import { getUserDisplayName } from '../models/user.js';
import { getCharacterAiContextName } from '../models/character.js';
import { getCharacter, listCharacters } from './character-store.js';
import { resolveGenerationMaxTokens } from './api.js';
import { chatJsonGeneration } from './chat-json-generation.js';
import { getNowForUser } from './time-mode.js';
import { buildWorldBookContextBlock } from './world-book-store.js';
import {
  loadRelationshipNetwork,
  collectGlobalRelationshipNetworkLines,
  collectCoNetworkMemberIds,
} from './relationship-network.js';
import { isLightweightNpcDismissed } from './lightweight-npc.js';
import { loadContactGroupsConfig } from './contact-groups.js';
import { canPhoneCharactersKnowEachOther } from './phone-social-eligibility.js';
import { loadAcquaintanceLedger } from './acquaintance-ledger.js';
import {
  loadCharacterPhoneContacts,
  upsertPhoneContact,
  isPhoneUserIdentityRef,
} from './character-phone-contacts.js';
import {
  buildCompletePhoneCharacterProfile,
  ensurePhonePeerChat,
  listCharacterPhoneInterceptChats,
  purgePhoneUserImpersonators,
  resolvePhoneChatTitle,
} from './character-phone-messages.js';
import {
  saveMessage,
  updateChatPreview,
} from './chat-store.js';
import {
  repairTranslationEntries,
  sanitizeAiTranslation,
} from './translation-utils.js';

const BATCH_KEY_PREFIX = 'characterPhoneInterceptBatch:';

const INTERCEPT_KINDS = Object.freeze([
  'harass',
  'ad',
  'unrequited',
  'fan',
  'ex',
  'scam',
  'enemy',
]);

function cleanId(value = '') {
  return String(value || '').trim();
}

function clip(value = '', max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function characterName(row, fallback = '') {
  return getCharacterAiContextName(row, fallback) || String(fallback || '').trim() || 'TA';
}

function batchKey(userId = '', ownerId = '') {
  return `${BATCH_KEY_PREFIX}${cleanId(userId)}:${cleanId(ownerId)}`;
}

function makeBatchId() {
  return `phint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeKind(raw = '') {
  const key = String(raw || '').trim().toLowerCase();
  if (INTERCEPT_KINDS.includes(key)) return key;
  if (/死敌|仇人|宿敌|仇家|敌对/.test(key)) return 'enemy';
  if (/骚扰|纠缠|缠/.test(key)) return 'harass';
  if (/广告|推销|营销/.test(key)) return 'ad';
  if (/爱而不得|单恋|暗恋|舔狗/.test(key)) return 'unrequited';
  if (/粉丝|饭圈|站姐/.test(key)) return 'fan';
  if (/前任|前女友|前男友|旧爱/.test(key)) return 'ex';
  if (/诈骗|骗局|钓鱼/.test(key)) return 'scam';
  return 'harass';
}

function expandBubbleTexts(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n+/).map((part) => part.trim()).filter(Boolean);
  const parts = [];
  for (const line of lines) {
    if (line.length <= 72) {
      parts.push(line);
      continue;
    }
    // 不用 lookbehind：iOS Safari < 16.4 会在 parseModule 阶段直接失败
    const sentenceChunks = String(line).split(/([。！？!?…]+)/);
    const sentences = [];
    for (let i = 0; i < sentenceChunks.length; i += 2) {
      const chunk = `${sentenceChunks[i] || ''}${sentenceChunks[i + 1] || ''}`.trim();
      if (chunk) sentences.push(chunk);
    }
    if (sentences.length > 1) parts.push(...sentences);
    else parts.push(line.slice(0, 72));
  }
  return parts.slice(0, 6);
}

function generatedContactRefs(rawContact = {}) {
  return [...new Set([
    cleanId(rawContact?.ref),
    cleanId(rawContact?.contactRef),
    clip(rawContact?.name, 40),
  ].filter(Boolean))];
}

function generatedThreadContactRef(thread = {}) {
  return cleanId(thread?.contactRef) || clip(thread?.contactName, 40);
}

function threadHasUsableMessages(thread = {}, {
  contactName = '',
  contactRefs = [],
} = {}) {
  const refs = new Set((contactRefs || []).map(cleanId).filter(Boolean));
  const name = clip(contactName, 40);
  return (Array.isArray(thread?.messages) ? thread.messages : []).some((message) => {
    const text = String(message?.text ?? message?.content ?? '').trim();
    if (!text) return false;
    const speaker = String(message?.speakerId ?? message?.speaker ?? '').trim();
    return refs.has(speaker)
      || (!!name && speaker === name);
  });
}

export async function loadLastPhoneInterceptBatch(userId = '', ownerId = '') {
  const row = await db.get('settings', batchKey(userId, ownerId)).catch(() => null);
  const value = row?.value || row;
  if (!value?.batchId) return null;
  return {
    batchId: cleanId(value.batchId),
    createdAt: Number(value.createdAt) || Date.now(),
    messageIds: [...new Set((value.messageIds || []).map(cleanId).filter(Boolean))],
    createdChatIds: [...new Set((value.createdChatIds || []).map(cleanId).filter(Boolean))],
    createdContactIds: [...new Set((value.createdContactIds || []).map(cleanId).filter(Boolean))],
  };
}

async function saveLastPhoneInterceptBatch(userId, ownerId, record) {
  await db.put('settings', {
    key: batchKey(userId, ownerId),
    value: record,
  });
}

/**
 * 生成一轮拦截箱内容：2～5 个轻量 NPC + 拒收消息。
 */
export async function generatePhoneInterceptBatch({
  user,
  ownerId,
  signal = null,
  onProgress = null,
} = {}) {
  const uid = cleanId(user?.id);
  const cid = cleanId(ownerId);
  if (!uid || !cid) throw new Error('缺少手机主人');
  await purgePhoneUserImpersonators({ user, ownerId: cid }).catch(() => {});
  onProgress?.('正在整理人设与拦截背景…');

  const [
    owner,
    allCharacters,
    contactsState,
    relationshipNet,
    existingIntercept,
    contactGroupsConfig,
    acquaintanceLedger,
  ] = await Promise.all([
    getCharacter(cid, { userId: uid }),
    listCharacters({ includeInternal: true, userId: uid, identityScoped: true }).catch(() => []),
    loadCharacterPhoneContacts(uid, cid),
    loadRelationshipNetwork(uid).catch(() => null),
    listCharacterPhoneInterceptChats(uid, cid).catch(() => []),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
    loadAcquaintanceLedger().catch(() => ({ entries: [] })),
  ]);
  if (!owner) throw new Error('找不到手机主人角色');

  const ownerName = characterName(owner, cid);
  const userName = getUserDisplayName(user) || '用户';
  const safeCharacters = allCharacters.filter((row) => (
    row?.id
    && !isPhoneUserIdentityRef(characterName(row, row.id), { userId: uid, userName })
  ));
  const charMap = new Map(safeCharacters.map((row) => [row.id, row]));
  const nameById = new Map(safeCharacters.map((row) => [row.id, characterName(row, row.id)]));
  const now = await getNowForUser(uid).catch(() => Date.now());
  const relatedSet = new Set();
  for (const row of safeCharacters) {
    if (row?.id && row.id !== cid
      && canPhoneCharactersKnowEachOther(
        owner,
        row,
        relationshipNet,
        contactGroupsConfig,
        acquaintanceLedger,
      )) relatedSet.add(row.id);
  }
  for (const id of collectCoNetworkMemberIds(relationshipNet, [cid])) {
    if (id && id !== cid && id !== 'user' && charMap.has(id)
      && canPhoneCharactersKnowEachOther(
        owner,
        charMap.get(id),
        relationshipNet,
        contactGroupsConfig,
        acquaintanceLedger,
      )) relatedSet.add(id);
  }
  const relatedIds = [...relatedSet];

  let worldBook = '';
  try {
    worldBook = await buildWorldBookContextBlock(user || null, [
      ownerName,
      owner.personality || '',
      relatedIds.map((id) => characterName(charMap.get(id), id)).join(' '),
    ].join(' '), { characterIds: [cid, ...relatedIds], worldBookMode: 'full' });
  } catch (_) {
    worldBook = '';
  }

  const relationLines = relationshipNet
    ? collectGlobalRelationshipNetworkLines(relationshipNet, {
      partnerIds: [cid, ...relatedIds],
      characters: Object.fromEntries(charMap),
      userName,
      maxEdges: 200,
      includeUser: false,
    })
    : [];

  const existingBrief = existingIntercept.slice(0, 6).map((chat) => ({
    chatId: chat.id,
    title: resolvePhoneChatTitle(chat, cid, Object.fromEntries(charMap), userName),
    lastMessage: clip(chat.lastMessage || '', 60),
    empty: !String(chat.lastMessage || '').trim(),
  }));

  const payload = {
    owner: buildCompletePhoneCharacterProfile(owner, {
      name: ownerName,
      now,
      nameById,
      userName,
      includeUserRelations: false,
    }),
    knownCharacters: relatedIds.map((id) => {
      const row = charMap.get(id);
      return buildCompletePhoneCharacterProfile(row, {
        name: characterName(row, id),
        now,
        nameById,
        userName,
        includeUserRelations: false,
      });
    }),
    worldBook,
    relationshipNetwork: relationLines,
    existingIntercept: existingBrief,
    knownBlocked: (contactsState.contacts || [])
      .filter((item) => item.blocked || item.interceptSource)
      .slice(0, 10)
      .map((item) => ({
        id: item.id,
        name: item.name || item.nickname || item.id,
        category: item.category || 'rival',
        blockReason: item.blockReason || '',
      })),
  };

  onProgress?.('正在生成拦截骚扰消息…');
  const maxTokens = await resolveGenerationMaxTokens();
  const { data: parsed } = await chatJsonGeneration({
    scope: 'character-phone-intercept',
    messages: [{
      role: 'system',
      content: `你在补全角色「${ownerName}」手机里的【拦截箱 / 陌生人过滤】内容。背景 JSON：
${JSON.stringify(payload)}

任务：一次生成 2～5 扇带实际消息内容的拦截私聊。优先续写 knownBlocked 中已有联系人；不足时最多登记 2 个新联系人，但新联系人也必须在本轮生成消息。
【身份隔离·最高优先级】本生成不提供也不允许使用用户身份、用户资料、用户关系或用户主窗内容；不得创建、猜测、影射或扮演用户，不得围绕用户设计纠缠理由。
【人设完整性硬规则】owner 与 knownCharacters 是完整语义角色卡，必须服从其中全部年龄、身份、经历、口吻、关系与生活资料；worldBook 与 relationshipNetwork 是同一世界观的既定事实。禁止忽略 birthDate/age 或把成年角色擅自改写成学生；拦截对象与纠缠缘由也必须符合这些既定资料。
内容参考（仅作多样性提示，不要写成对外标签或自我介绍口号）：骚扰纠缠、广告推销、爱而不得、狂热粉丝、前任纠缠、诈骗话术、死敌/仇人/宿敌阴阳或威胁。
输出规则：
- contacts 仅用于登记新的轻量联系人：每项给唯一临时 ref（如 new_1）和 name，不要 linkedCharacterId；category 用 rival 或 other。
- threads.contactRef：已有联系人逐字使用 knownBlocked.id；本轮新联系人逐字使用 contacts.ref。每个新联系人必须至少对应一扇非空 thread。
- 每个联系人必须给 translationProfile：明确主要使用非中文时写 {"mode":"full","language":"具体语言"}；主要说中文写 mode="off"；偶尔夹外语写 mode="mixed"。不要仅凭外文名武断判定。
- kind 仅供内部归类：harass|ad|unrequited|fan|ex|scam|enemy；不要在 text 里复述这些类型名。
- 每扇窗 2～6 条短气泡；口吻贴合该类型与手机主人人设边界（死敌要有积怨张力，广告要像真推销，粉丝要越界热情）。
- 只围绕手机主人和拦截对象本身生成；不要出现用户或用户替身。
- speakerId 只能逐字写该 thread.contactRef；拦截箱的自动生成只补对方来信，禁止替手机主人回复。
- minutesAgo 取 20～2880，同窗内从大到小。
- existingIntercept 是已有拦截会话，可以自然续写；其中 empty=true 的空窗必须优先补入消息。不要为已有会话或 knownBlocked 再创建同名新联系人。
- translationProfile.mode=full 的联系人发言必须写对应外语或中文方言原文，并在同一 messages 项给 "zh" 简体中文普通话（现代标准汉语）翻译；中文方言即使全是汉字也不能省略 zh，且不能只做繁简转换。mixed 仅在实际出现外语或方言时给 zh。
- threads 不得为空，也不得只登记联系人不写消息。

只输出 JSON：
{"contacts":[{"ref":"new_1","name":"","category":"rival|other","kind":"harass|ad|unrequited|fan|ex|scam|enemy","relationship":"和手机主人的关系","personality":"","translationProfile":{"mode":"off|full|mixed","language":"","dialectNote":""},"blocked":true}],
"threads":[{"contactRef":"knownBlocked.id 或 contacts.ref","kind":"enemy","messages":[{"speakerId":"与 contactRef 完全相同","text":"","zh":"外语气泡才需要","minutesAgo":90}]}]}`,
    }, {
      role: 'user',
      content: '请按上述完整手机主人、世界书与关系网生成本轮拦截箱 JSON。',
    }],
    temperature: 0.88,
    maxTokens,
    signal,
    preferStream: true,
    onProgress,
    validate: (value) => Array.isArray(value?.contacts) || Array.isArray(value?.threads),
  });
  const contactsRaw = Array.isArray(parsed?.contacts) ? parsed.contacts : [];
  const threadsRaw = Array.isArray(parsed?.threads) ? parsed.threads : [];
  if (!contactsRaw.length && !threadsRaw.length) {
    const error = new Error('拦截箱未返回有效 JSON');
    error.reason = 'json-parse-failed';
    throw error;
  }
  if (!threadsRaw.some((thread) => (
    Array.isArray(thread?.messages)
    && thread.messages.some((message) => String(message?.text ?? message?.content ?? '').trim())
  ))) {
    const error = new Error('拦截箱只返回了联系人，没有返回消息内容，请重试');
    error.reason = 'no-message-content';
    error.rawText = JSON.stringify(parsed || {}).slice(0, 4000);
    throw error;
  }

  onProgress?.('正在写入拦截箱…');
  const batchId = makeBatchId();
  const batchIndex = {
    batchId,
    createdAt: now,
    messageIds: [],
    createdChatIds: [],
    createdContactIds: [],
  };
  const existingContactById = new Map(
    (contactsState.contacts || [])
      .filter((contact) => contact?.id && (contact.blocked || contact.interceptSource))
      .map((contact) => [String(contact.id).trim(), contact]),
  );
  const createdContactByRef = new Map();
  const reservedContactNames = new Set(
    (contactsState.contacts || []).map((contact) => String(contact?.name || '').trim()).filter(Boolean),
  );
  let createdContacts = 0;
  let createdThreads = 0;
  let createdMessages = 0;

  for (const rawContact of contactsRaw.slice(0, 2)) {
    const name = clip(rawContact?.name, 40);
    const contactRefs = generatedContactRefs(rawContact).filter((ref) => (
      ref !== 'owner'
      && ref !== cid
      && !isPhoneUserIdentityRef(ref, { userId: uid, userName })
    ));
    const matchingThreads = threadsRaw.filter((thread) => contactRefs.includes(
      generatedThreadContactRef(thread),
    ));
    if (!name
      || name === ownerName
      || name === cid
      || isPhoneUserIdentityRef(name, { userId: uid, userName })
      || isLightweightNpcDismissed(relationshipNet, { name })
      || reservedContactNames.has(name)
      || !matchingThreads.some((thread) => threadHasUsableMessages(thread, {
        ownerId: cid,
        contactName: name,
        contactRefs,
      }))) continue;
    const kind = normalizeKind(rawContact?.kind || rawContact?.blockReason);
    const saved = await upsertPhoneContact(uid, cid, {
      name,
      category: rawContact?.category === 'other' ? 'other' : 'rival',
      interceptSource: true,
      blocked: rawContact?.blocked !== false,
      blockedAt: now,
      blockReason: kind,
      personaCapsule: {
        relationship: clip(rawContact?.relationship || '', 120),
        summary: clip(rawContact?.personality, 160),
      },
      translationProfile: rawContact?.translationProfile || rawContact?.translation,
      note: '',
    }).catch(() => null);
    if (saved?.id) {
      reservedContactNames.add(name);
      for (const ref of contactRefs) {
        if (!isPhoneUserIdentityRef(ref, { userId: uid, userName })) {
          createdContactByRef.set(ref, saved);
        }
      }
      batchIndex.createdContactIds.push(saved.id);
      createdContacts += 1;
    }
  }

  for (const thread of threadsRaw.slice(0, 5)) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const ref = generatedThreadContactRef(thread);
    if (ref === 'owner'
      || ref === cid
      || isPhoneUserIdentityRef(ref, { userId: uid, userName })) continue;
    const contact = existingContactById.get(ref) || createdContactByRef.get(ref);
    if (!contact?.id) continue;
    const peerId = contact.id;
    const chat = await ensurePhonePeerChat(uid, cid, peerId, { phoneChannel: 'intercept' }).catch(() => null);
    if (!chat?.id) continue;
    if ((chat.participants || []).includes('user')) continue;

    const bubbles = [];
    for (const m of (Array.isArray(thread?.messages) ? thread.messages : [])) {
      const speakerRaw = String(m?.speakerId ?? m?.speaker ?? '').trim();
      const isContact = speakerRaw === peerId
        || speakerRaw === ref
        || createdContactByRef.get(speakerRaw)?.id === peerId
        || (
          speakerRaw === String(contact.name || '').trim()
          && !isPhoneUserIdentityRef(speakerRaw, { userId: uid, userName })
        );
      if (!isContact) continue;
      const senderId = peerId;
      const senderName = contact.name || peerId;
      const minutesAgo = Math.max(20, Math.min(2880, Number(m?.minutesAgo) || 120));
      const source = String(m?.text ?? m?.content ?? '').trim();
      const senderTranslationProfile = contact.translationProfile || {};
      const translation = sanitizeAiTranslation(source, m?.zh || m?.translation || '', {
        languageHint: senderTranslationProfile.language || senderTranslationProfile.dialectNote || '',
      });
      const texts = translation ? [clip(source, 80)] : expandBubbleTexts(source);
      for (const text of texts) {
        if (!text) continue;
        bubbles.push({
          senderId,
          senderName,
          text: clip(text, 80),
          minutesAgo,
          translation,
        });
      }
    }
    const capped = bubbles.slice(0, 8);
    if (!capped.length) continue;
    const repaired = await repairTranslationEntries(capped.map((row, index) => ({
      id: `phone_intercept_${index}`,
      source: row.text,
      translation: row.translation,
      languageHint: contact.translationProfile?.language || contact.translationProfile?.dialectNote,
    })), { signal, automatic: true }).catch(() => new Map());
    capped.forEach((row, index) => {
      if (!row.translation && repaired.has(`phone_intercept_${index}`)) {
        row.translation = repaired.get(`phone_intercept_${index}`);
      }
    });

    if (!batchIndex.createdChatIds.includes(chat.id)) batchIndex.createdChatIds.push(chat.id);
    capped.sort((a, b) => b.minutesAgo - a.minutesAgo);
    let cursor = 0;
    for (const row of capped) {
      const ts = Math.min(now - 2 * 60 * 1000, now - row.minutesAgo * 60 * 1000);
      cursor = Math.max(cursor + 40 * 1000, ts);
      const messageId = `${batchId}_${Math.random().toString(36).slice(2, 8)}`;
      await saveMessage({
        id: messageId,
        chatId: chat.id,
        senderId: row.senderId,
        senderName: row.senderName,
        content: row.text,
        type: 'text',
        timestamp: cursor,
        metadata: {
          phoneInterceptBatch: true,
          phoneInterceptBatchId: batchId,
          aiRoundKind: 'phone-intercept',
          deliveryStatus: 'rejected',
          deliveryBlockedByUser: true,
          interceptKind: normalizeKind(thread?.kind || contact.blockReason),
          ...(row.translation ? { translation: row.translation } : {}),
        },
      });
      batchIndex.messageIds.push(messageId);
      createdMessages += 1;
    }
    await updateChatPreview(chat.id, capped[capped.length - 1].text, cursor).catch(() => {});
    createdThreads += 1;
  }

  if (!createdMessages) {
    const error = new Error('这一轮没有生成出可落库的拦截消息，请重试');
    error.reason = 'no-results';
    error.rawText = JSON.stringify(parsed || {}).slice(0, 4000);
    throw error;
  }

  await saveLastPhoneInterceptBatch(uid, cid, batchIndex);
  return {
    contacts: createdContacts,
    threads: createdThreads,
    messages: createdMessages,
    batchId,
  };
}

export {
  INTERCEPT_KINDS,
  generatedContactRefs,
  generatedThreadContactRef,
  normalizeKind,
  threadHasUsableMessages,
};
