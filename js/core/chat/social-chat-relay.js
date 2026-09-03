/**
 * 微博/论坛等「生成后转发进聊天」共用：按 AI 输出的 chatShares 落库，
 * 避免角色在其不在的群内以第一人称发言。
 */
import { createMessage } from '../../models/chat.js';
import { listCharacters, getCharacter } from '../character-store.js';
import { getNowForUser } from '../time-mode.js';
import {
  saveMessage,
  updateChatPreview,
  ensurePrivateChat,
  listChatsForUser,
} from '../chat-store.js';
import { normalizeSocialShares, executeSendOps } from './send-ops.js';
import { looksLikeRawParticipantId, resolveActorDisplayLabel } from './character-code-fallback.js';

let _characterLookup = null;
let _characterLookupAt = 0;
let _characterLookupUserId = '';

async function getCharacterLookup(userId = '') {
  const uid = String(userId || '').trim();
  const now = Date.now();
  if (_characterLookup && _characterLookupUserId === uid && now - _characterLookupAt < 5000) {
    return _characterLookup;
  }
  const list = await listCharacters({
    excludeAnonNpc: true,
    userId: uid,
    identityScoped: !!uid,
  });
  _characterLookup = { list };
  _characterLookupAt = now;
  _characterLookupUserId = uid;
  return _characterLookup;
}

export async function resolveChatParticipantName(id, options = {}) {
  const fallback = String(options.fallback || '').trim() || '对方';
  const key = String(id || '').trim();
  if (!key || key === 'user') return fallback;
  const userId = String(options.userId || '').trim();
  const { list } = await getCharacterLookup(userId);
  const hit = list.find((c) => c.id === key);
  if (hit) {
    const name = String(hit.name || hit.customNickname || hit.realName || '').trim();
    if (name) return name;
  }
  const stored = userId ? null : await getCharacter(key);
  const storedName = String(stored?.name || stored?.customNickname || stored?.realName || '').trim();
  if (storedName) return storedName;
  if (looksLikeRawParticipantId(key)) return fallback;
  return resolveActorDisplayLabel(key, { ...options, fallback });
}

export async function getUserChatsForRelay(userId) {
  if (!userId) return [];
  return (await listChatsForUser(userId))
    .filter((c) => c.groupSettings?.allowSocialLinkage === true);
}

export async function normalizeAuthorIdentity(authorIdRaw, authorNameRaw, options = {}) {
  const idRaw = String(authorIdRaw || '').trim();
  const nameRaw = String(authorNameRaw || '').trim();
  const { list } = await getCharacterLookup(options.userId);
  const byId = list.find((c) => c?.id && c.id === idRaw);
  if (byId) return { id: byId.id, name: byId.name || nameRaw || byId.id, isKnown: true };
  const byName = list.find((c) =>
    c?.name === nameRaw || c?.realName === nameRaw || c?.customNickname === nameRaw || (c?.aliases || []).includes(nameRaw),
  );
  if (byName) return { id: byName.id, name: byName.name || nameRaw || byName.id, isKnown: true };
  const fallbackName = nameRaw || idRaw;
  return {
    id: '',
    name: looksLikeRawParticipantId(fallbackName) ? '匿名用户' : (fallbackName || '匿名用户'),
    isKnown: false,
  };
}

export async function findOrCreatePrivateChat(userId, actorId) {
  if (!userId || !actorId) return null;
  const { list } = await getCharacterLookup(userId);
  const known = list.some((c) => c.id === actorId);
  if (!known) return null;
  return ensurePrivateChat(userId, actorId);
}

export function findGroupChatByNameHint(chats, nameHint, requireForwarderId) {
  const hint = String(nameHint || '').trim();
  if (!hint) return null;
  const groups = chats.filter((c) => c.type === 'group' && (c.participants || []).includes('user'));
  const ok = (c) => !requireForwarderId || (c.participants || []).includes(requireForwarderId);
  const exact = groups.find((c) => (c.groupSettings?.name || '') === hint);
  if (exact && ok(exact)) return exact;
  const partial = groups.find(
    (c) =>
      ok(c)
      && ((c.groupSettings?.name || '').includes(hint) || hint.includes(c.groupSettings?.name || '')),
  );
  return partial || null;
}

export function findGroupChatByNameHintUserOnly(chats, nameHint) {
  const hint = String(nameHint || '').trim();
  if (!hint) return null;
  const groups = chats.filter((c) => c.type === 'group' && (c.participants || []).includes('user'));
  return (
    groups.find((c) => (c.groupSettings?.name || '') === hint)
    || groups.find(
      (c) => (c.groupSettings?.name || '').includes(hint) || hint.includes(c.groupSettings?.name || ''),
    )
    || null
  );
}

/** chatShares.lines 已是目标会话内气泡；模型若误套群聊私聊标签前缀则剥除 */
function stripRelayLinePmArtifact(line) {
  const s = String(line || '').trim();
  const m = s.match(/^\[\[PM:[^\]]+\]\]\s*/);
  return m ? s.slice(m[0].length).trim() : s;
}

export function normalizeChatShareFromAi(raw = {}) {
  const lines = Array.isArray(raw.lines)
    ? raw.lines
      .map((x) => stripRelayLinePmArtifact(x))
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .slice(0, 6)
    : [];
  return {
    postIndex: Math.max(0, Math.floor(Number(raw.postIndex ?? 0))),
    forwarderId: String(raw.forwarderId || '').trim(),
    forwarderName: String(raw.forwarderName || '').trim(),
    targetType: String(raw.targetType || 'private_user').toLowerCase().replace(/\s+/g, '_'),
    targetId: String(raw.targetId || raw.receiverId || raw.recipientId || '').trim(),
    targetName: String(raw.targetName || raw.receiverName || raw.recipientName || '').trim(),
    groupName: String(raw.groupName || '').trim(),
    wrongGroupName: String(raw.wrongGroupName || '').trim(),
    wrongSend: !!raw.wrongSend,
    recallLink: !!raw.recallLink,
    lines,
  };
}

export function buildResolvedSocialSharePayload(
  share = {},
  identity = {},
  isGroupTarget = false,
  privateTargetId = '',
) {
  const fid = String(identity.id || '').trim();
  const fname = String(identity.name || '').trim();
  return {
    forwarderId: fid,
    forwarderName: fname,
    action: share.targetType,
    groupName: isGroupTarget ? share.groupName : (String(privateTargetId || '').trim() || fid),
    lines: Array.isArray(share.lines) ? share.lines : [],
    postIndex: share.postIndex,
  };
}

export function findPeerPrivateChat(chats = [], leftId = '', rightId = '') {
  const left = String(leftId || '').trim();
  const right = String(rightId || '').trim();
  if (!left || !right || left === right) return null;
  return (Array.isArray(chats) ? chats : []).find((chat) => {
    if (chat?.type !== 'private') return false;
    const participants = Array.isArray(chat.participants) ? chat.participants : [];
    return !participants.includes('user')
      && participants.includes(left)
      && participants.includes(right);
  }) || null;
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {unknown} opts.chatShares
 * @param {Array<{ id: string }>} opts.relayItems
 * @param {number} opts.virtualNow
 * @param {object} opts.relaySpec
 */
export async function applyGeneratedChatShares({
  userId,
  chatShares,
  relayItems,
  virtualNow,
  relaySpec,
}) {
  if (!userId || !relayItems.length) return;
  const list = (Array.isArray(chatShares) ? chatShares : []).slice(0, 3).map(normalizeChatShareFromAi);
  const shares = list.filter((s) => s.forwarderId || s.forwarderName);
  if (!shares.length) return;

  const {
    urlScheme,
    sourceLabel,
    lastMessagePreview,
    linkTitle,
    linkDesc,
    extraLinkMetadata,
  } = relaySpec;
  if (!urlScheme || !sourceLabel) return;

  const all = await getUserChatsForRelay(userId);
  let tick = Number(virtualNow || (await getNowForUser(userId)));

  try {
    for (const sh of shares) {
      const item = relayItems[Math.min(sh.postIndex, relayItems.length - 1)];
      if (!item?.id) continue;
      const who = await normalizeAuthorIdentity(sh.forwarderId, sh.forwarderName, { userId });
      const fid = who.id;
      if (!fid) continue;
      const fname = who.name || sh.forwarderName || '角色';

      const isGroupTarget =
        sh.targetType === 'group'
        || sh.targetType === 'group_chat'
        || sh.targetType === '群'
        || sh.targetType === '群聊';
      const isPeerPrivateTarget = [
        'private_character',
        'peer_private',
        'character_private',
        '角色私聊',
      ].includes(sh.targetType)
        || (!!sh.targetId && !['private_user', 'private', '私聊'].includes(sh.targetType));
      let intended = null;
      let privateTargetId = fid;
      if (isGroupTarget) {
        intended = findGroupChatByNameHint(all, sh.groupName, fid);
      } else if (isPeerPrivateTarget) {
        const targetWho = await normalizeAuthorIdentity(sh.targetId, sh.targetName, { userId });
        privateTargetId = targetWho.id;
        intended = privateTargetId ? findPeerPrivateChat(all, fid, privateTargetId) : null;
      } else {
        intended = await findOrCreatePrivateChat(userId, fid);
      }
      if (!intended) continue;

      let linkChat = intended;
      if (sh.wrongSend && sh.wrongGroupName) {
        const wrong = findGroupChatByNameHintUserOnly(all, sh.wrongGroupName);
        if (wrong && wrong.id !== intended.id) linkChat = wrong;
      }

      const parts = linkChat.participants || [];
      const forwarderInLink = parts.includes(fid);

      const extraMeta = typeof extraLinkMetadata === 'function' ? extraLinkMetadata(item, fname) : {};

      // From this point on only use the address-book identity resolved above.
      // A social account id / alias from model output must never become a new
      // chat participant, nor may a same-named account redirect a private send.
      // normalizeSocialShares uses groupName as the send-op target for both
      // groups and private chats, so private relays are pinned to the same id.
      const sharePayload = buildResolvedSocialSharePayload(
        sh,
        { id: fid, name: fname },
        isGroupTarget,
        privateTargetId,
      );
      const sendOps = normalizeSocialShares([sharePayload], urlScheme, item.id);
      const gsTarget = intended.groupSettings || {};
      const allowGroupRelay = gsTarget.allowGroupLinkage !== undefined
        ? gsTarget.allowGroupLinkage
        : gsTarget.allowSocialLinkage === true;
      const allowPrivateRelay = gsTarget.allowPrivateLinkage === true
        || (gsTarget.allowSocialLinkage === true && gsTarget.allowPrivateLinkage === true);

      const linkMsg = createMessage({
        chatId: linkChat.id,
        senderId: forwarderInLink ? fid : 'system',
        senderName: forwarderInLink ? fname : '',
        type: 'link',
        content: `${urlScheme}://${item.id}`,
        timestamp: tick++,
        metadata: {
          title: linkTitle(item, fname),
          desc: String(linkDesc(item) || '').slice(0, 80),
          descFull: String(linkDesc(item) || '').slice(0, 1600),
          source: sourceLabel,
          platformId: String(urlScheme || '').toLowerCase(),
          socialAuthorCharacterId: String(item.authorId || '').trim(),
          author: {
            id: String(item.authorId || '').trim(),
            name: String(item.authorName || '').trim(),
          },
          fromSocialRelay: true,
          relayForwarderId: fid,
          relayForwarderName: fname,
          ...(isPeerPrivateTarget ? { relayRecipientId: privateTargetId } : {}),
          wrongRelay: sh.wrongSend && linkChat.id !== intended.id,
          ...(forwarderInLink ? {} : { relaySystemNote: `${fname}似乎把链接发到了本群` }),
          ...extraMeta,
        },
      });
      await saveMessage(linkMsg);

      const textMeta = { fromSocialRelay: true, relaySource: sourceLabel, ...extraMeta };

      if (sh.recallLink && forwarderInLink) {
        linkMsg.recalled = true;
        linkMsg.metadata = { ...(linkMsg.metadata || {}), recalledContent: linkMsg.content };
        await saveMessage(linkMsg);
        await saveMessage(createMessage({
          chatId: linkChat.id,
          senderId: 'system',
          type: 'system',
          content: `${fname} 撤回了一条${sourceLabel}链接`,
          timestamp: tick++,
        }));
      } else {
        let sendLogs = [];
        if (sendOps.length) {
          sendLogs = await executeSendOps(sendOps, fid, {
            userId,
            userName: '',
            currentChatId: intended.id,
            sourceChat: null,
            allowGroupLinkage: allowGroupRelay,
            allowPrivateLinkage: allowPrivateRelay,
            privateLinkageIds: Array.isArray(gsTarget.privateLinkageIds) ? gsTarget.privateLinkageIds : [],
            resolveName: resolveChatParticipantName,
            relayMeta: { fromSocialRelay: true, relaySource: sourceLabel },
          });
        }
        if (forwarderInLink) {
          if (!sendOps.length || !sendLogs.length) {
            for (const line of sh.lines) {
              await saveMessage(createMessage({
                chatId: linkChat.id,
                senderId: fid,
                senderName: fname,
                type: 'text',
                content: line,
                timestamp: tick++,
                metadata: { ...textMeta },
              }));
            }
          }
        } else if (!sendOps.length || !sendLogs.length) {
          for (const line of sh.lines) {
            await saveMessage(createMessage({
              chatId: intended.id,
              senderId: fid,
              senderName: fname,
              type: 'text',
              content: line,
              timestamp: tick++,
              metadata: { ...textMeta, relaySpokenInIntendedChat: true },
            }));
          }
        }
      }

      const bump = async (chatId) => {
        if (!chatId) return;
        await updateChatPreview(chatId, lastMessagePreview, tick);
      };
      await bump(linkChat.id);
      if (intended.id !== linkChat.id) await bump(intended.id);
    }
  } catch (e) {
    console.warn('applyGeneratedChatShares', e);
  }
}
