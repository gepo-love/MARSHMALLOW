import { resolveGenerationMaxTokens } from './api.js';
import { chatJsonGeneration } from './chat-json-generation.js';
import { getCharacter } from './character-store.js';
import { listMessagesForChat } from './chat-store.js';
import { listAliasAccounts } from './alias-account-store.js';
import { createMailboxMessage, loadMailbox } from './mailbox-store.js';
import { persistAliasContactEvent } from './chat/marshmallow-alias-contact.js';

function clean(value = '', max = 0) {
  const text = String(value ?? '').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function safeAddress(value = '', fallbackLocal = 'letter') {
  const raw = clean(value, 160).toLowerCase();
  if (/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) return raw;
  const local = clean(fallbackLocal).toLowerCase().replace(/[^a-z0-9._-]+/g, '').slice(0, 32) || 'letter';
  return `${local}@postbox.me`;
}

function characterSnapshot(character = {}) {
  return {
    id: clean(character.id, 180),
    name: clean(character.realName || character.name || character.customNickname, 80),
    personality: clean(character.personality, 1600),
    speechStyle: clean(character.speechStyle, 1200),
    background: clean(character.background || character.backstory, 1800),
    relationship: clean(character.userRelationStatus || character.relationshipToUser, 800),
    status: clean(character.currentStatus, 500),
  };
}

function recentConversation(messages = []) {
  return messages
    .filter((row) => row && !row.deleted && row.type !== 'system')
    .slice(-18)
    .map((row) => ({
      speaker: row.senderId === 'user' ? 'user' : 'character',
      text: clean(row.content || row.metadata?.text, 260),
      rejected: row.metadata?.deliveryStatus === 'rejected',
    }))
    .filter((row) => row.text);
}

/**
 * 拉黑后的替代联系只发起一次模型请求：由角色选择邮件或小号，并直接落到独立模块。
 * 之后是否再次尝试仍由会话的用户频率、主动总开关与每日配额决定。
 */
export async function deliverBlockedContactAttempt({
  user,
  chat,
  characterId,
  blockReason = '',
  failedRounds = 2,
  lastRoute = '',
  reason = '',
} = {}) {
  const userId = clean(user?.id, 180);
  const cid = clean(characterId, 180);
  if (!userId || !chat?.id || !cid) return { ok: false, reason: 'missing-context' };

  const [character, messages, mailbox, aliases] = await Promise.all([
    getCharacter(cid, { userId }).catch(() => null),
    listMessagesForChat(chat.id, 24).catch(() => []),
    loadMailbox(userId).catch(() => null),
    listAliasAccounts('character', cid, { userId }).catch(() => []),
  ]);
  if (!character) return { ok: false, reason: 'missing-character' };
  const reusableAlias = aliases.find((row) => row.status === 'active') || null;
  const characterMails = (mailbox?.messages || [])
    .filter((row) => clean(row.characterId || row.from?.actorId || row.to?.[0]?.actorId) === cid);
  const latestCharacterMail = characterMails[0] || null;
  const payload = {
    character: characterSnapshot(character),
    user: {
      name: clean(user.name || user.nickname, 80),
      mailbox: clean(mailbox?.accountAddress, 160),
    },
    recentChat: recentConversation(messages),
    recentMailbox: characterMails
      .slice(0, 8)
      .reverse()
      .map((row) => ({
        direction: row.direction,
        subject: clean(row.subject, 180),
        body: clean(row.body, 1000),
        timestamp: Number(row.timestamp || 0) || 0,
      })),
    blocked: true,
    blockReason: clean(blockReason, 240),
    failedRounds: Math.max(2, Number(failedRounds) || 2),
    previousOutsideRoute: clean(lastRoute, 20),
    reusableAlias: reusableAlias ? {
      id: reusableAlias.id,
      handle: reusableAlias.handle,
      displayName: reusableAlias.displayName,
      bio: reusableAlias.bio,
      windowLabel: reusableAlias.windowLabel,
    } : null,
  };
  const maxTokens = await resolveGenerationMaxTokens();
  const { data } = await chatJsonGeneration({
    scope: 'blocked-contact-alternative',
    messages: [{
      role: 'system',
      content: `背景 JSON：\n${JSON.stringify(payload)}\n\n任务：角色在主聊天账号被拉黑且至少两轮发送失败后，决定这一次是否改用电子邮件或社交小号联系用户。必须符合人物性格、关系和最近冲突；可以继续愤怒、道歉、试探、冷静说明或故作不在意，但不要替用户回应。previousOutsideRoute 只用于避免机械重复，不是禁止再次使用同一渠道。若 recentMailbox 最后一封是用户发来的邮件，应优先继续用邮件自然回复它；不要无视用户来信突然换小号。若 reusableAlias 存在，可以继续使用它，不要每次新建小号。\n\n只输出 JSON，二选一：\n1. 邮件：{"route":"email","email":{"senderAddress":"","subject":"","body":""}}\n2. 小号：{"route":"alias","alias":{"reuseAccountId":"","handle":"","displayName":"","bio":"","avatarPrompt":"","windowLabel":"","motive":"","messages":[{"body":""}]}}\n\n要求：邮件正文像真实邮件，可比聊天更完整，但不要写系统提示或“因为规则所以”；小号公开资料不得直接暴露角色真名，messages 是发给用户的第一人称消息。已有 reusableAlias 时优先在 reuseAccountId 填它的 id，并保持其它公开资料与原账号一致。`,
    }, {
      role: 'user',
      content: '请按上述完整关系背景决定本次联系渠道，并输出对应 JSON。',
    }],
    temperature: 0.9,
    maxTokens,
    preferStream: true,
    validate: (value) => ['email', 'alias'].includes(clean(value?.route).toLowerCase()),
    auditContext: {
      operation: 'blocked-contact-alternative',
      initiator: 'background',
      trigger: 'blocked-contact-alternative',
      actorId: cid,
      sourceChatId: chat.id,
      backgroundReason: clean(reason, 80),
    },
  });

  const route = clean(data?.route).toLowerCase();
  if (route === 'alias') {
    const alias = data?.alias && typeof data.alias === 'object' ? data.alias : {};
    const reuseAccountId = reusableAlias && clean(alias.reuseAccountId) === reusableAlias.id
      ? reusableAlias.id
      : '';
    const event = {
      t: 'alias_contact',
      from: cid,
      reuseAccountId,
      windowLabel: clean(alias.windowLabel, 40) || '拉黑后绕回',
      motive: clean(alias.motive, 4000),
      account: reuseAccountId ? null : {
        handle: clean(alias.handle, 60).replace(/^@+/, ''),
        displayName: clean(alias.displayName, 60),
        bio: clean(alias.bio, 300),
        avatarPrompt: clean(alias.avatarPrompt, 800) || '一张不易辨认身份的真实社交账号头像',
      },
      messages: (Array.isArray(alias.messages) ? alias.messages : [])
        .map((row) => ({ body: clean(row?.body || row?.text, 500) }))
        .filter((row) => row.body)
        .slice(0, 8),
    };
    if (event.messages.length) {
      const delivered = await persistAliasContactEvent(event, {
        userId,
        sourceChatId: chat.id,
        sourceChat: chat,
        reuseAccountId,
        aiRoundId: `blocked_contact_${Date.now()}`,
      });
      if (delivered) return { ok: true, route: 'alias', ...delivered };
    }
  }

  // 邮件分支直接使用同一次响应，不追加修复或兼容重试。
  const email = data?.email && typeof data.email === 'object' ? data.email : {};
  const body = clean(email.body, 12000);
  if (!body) return { ok: false, reason: route === 'alias' ? 'invalid-alias-output' : 'empty-email' };
  const characterName = clean(character.realName || character.name || character.customNickname, 80) || 'TA';
  const senderAddress = safeAddress(email.senderAddress, characterName);
  const mail = await createMailboxMessage(userId, {
    direction: 'inbound',
    from: { name: characterName, address: senderAddress, actorId: cid },
    to: [{ name: clean(user.name || user.nickname, 80) || '我', address: mailbox?.accountAddress }],
    subject: clean(email.subject, 180) || '还是想把话说完',
    body,
    threadId: latestCharacterMail?.threadId || '',
    inReplyTo: latestCharacterMail?.direction === 'outbound' ? latestCharacterMail.id : '',
    source: 'blocked-contact',
    sourceChatId: chat.id,
    characterId: cid,
  });
  return { ok: true, route: 'email', mailId: mail.id, characterId: cid };
}
