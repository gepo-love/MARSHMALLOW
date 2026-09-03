/**
 * 记忆互通 / 跨窗来源的会话展示名。
 * 马甲与陌生线程的 participants 仍是角色本体 id，不能直接用真人名，否则会和大号私聊重名。
 */
import { getCharacterAiContextName, resolveCharacterAiContextName } from '../../models/character.js';
import { principalKey } from '../alias-account-model.js';
import { isStrangerInterceptChat, visibleIdentityFor } from '../stranger-thread-model.js';

function characterRow(characters, id) {
  if (!characters || !id) return null;
  if (typeof characters.get === 'function') return characters.get(id) || null;
  return characters[id] || null;
}

function characterRealName(characters, id, fallback = '对方') {
  const row = characterRow(characters, id);
  if (row) {
    return String(getCharacterAiContextName(row, id) || fallback).trim() || fallback;
  }
  const fromMap = resolveCharacterAiContextName(id, characters);
  return String(fromMap || fallback).trim() || fallback;
}

function userAliasDisplayName(chat, userId = '') {
  const uid = String(userId || '').trim();
  if (!chat || !uid) return '';
  const accountId = String(chat.metadata?.accountIdentityMap?.[principalKey('user', uid)] || '').trim();
  if (!accountId) return '';
  return String(chat.metadata?.accountSnapshots?.[accountId]?.displayName || '').trim();
}

/**
 * 双向互通勾选列表用的短标签。
 */
export function resolveMemoryShareOptionLabel(chat, characters = {}, options = {}) {
  if (!chat) return '会话';
  if (chat.type === 'group') {
    const names = (chat.participants || [])
      .filter((id) => id && id !== 'user')
      .map((id) => characterRealName(characters, id, id));
    return String(chat.groupSettings?.name || names.join('、') || '群聊').trim() || '群聊';
  }
  const peerId = (chat.participants || []).find((id) => id && id !== 'user');
  if (!peerId) return '私聊';
  const realName = characterRealName(characters, peerId, '私聊');
  if (!isStrangerInterceptChat(chat)) return realName;

  const row = characterRow(characters, peerId) || { name: realName, displayName: realName };
  const visible = visibleIdentityFor(chat.metadata, principalKey('character', peerId), row);
  const front = String(visible?.displayName || '').trim();
  const userAlias = userAliasDisplayName(chat, options.userId);

  if (visible?.kind === 'alias' && front && front !== realName) {
    return `${front}（马甲）`;
  }
  if (userAlias) {
    return `陌生「${userAlias}」· ${front || realName}`;
  }
  if (front && front !== realName) {
    return `${front}（马甲）`;
  }
  return `${realName}（陌生消息）`;
}

/**
 * 注入上下文里的「=== 来源：… ===」会话标签。
 */
export function formatMemorySourceChatLabel(chat, characters = {}, options = {}) {
  if (!chat) return '未知会话';
  const parts = chat.participants || [];
  const userPresent = parts.includes('user');
  if (chat.type === 'group') {
    const gn = String(chat.groupSettings?.name || '').trim() || '未命名群聊';
    const observerLike = !!chat.groupSettings?.isObserverMode || !userPresent;
    if (observerLike) return `群聊「${gn}」（旁观 / 无用户在场）`;
    return `群聊「${gn}」（用户在场）`;
  }
  if (chat.type === 'private' || !chat.type) {
    const peerId = parts.find((p) => p && p !== 'user');
    const realName = peerId ? characterRealName(characters, peerId, '对方') : '对方';
    if (isStrangerInterceptChat(chat) && peerId) {
      const row = characterRow(characters, peerId) || { name: realName, displayName: realName };
      const visible = visibleIdentityFor(chat.metadata, principalKey('character', peerId), row);
      const front = String(visible?.displayName || '').trim() || realName;
      const userAlias = userAliasDisplayName(chat, options.userId);
      if (visible?.kind === 'alias' && front !== realName) {
        return userPresent
          ? `马甲私聊（前台「${front}」· 本体 ${realName} ↔ 用户）`
          : `马甲私聊（前台「${front}」· 本体 ${realName}）`;
      }
      if (userAlias) {
        return `陌生私聊（用户马甲「${userAlias}」↔ ${front}）`;
      }
      return userPresent
        ? `陌生私聊（用户 ↔ ${front}）`
        : `陌生私聊（${front}）`;
    }
    return userPresent ? `私聊（用户 ↔ ${realName}）` : `私聊（无用户在场 · ${realName}）`;
  }
  return `会话「${chat.id}」`;
}

/** 同名标签后，第二个起追加 ·2 / ·3，避免勾选列表看起来像重复项。 */
export function uniquifyMemoryShareLabels(options = []) {
  const rows = Array.isArray(options) ? options : [];
  const counts = new Map();
  for (const row of rows) {
    const label = String(row?.label || '');
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const seen = new Map();
  return rows.map((row) => {
    const label = String(row?.label || '');
    if ((counts.get(label) || 0) <= 1) return row;
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    if (n === 1) return row;
    return { ...row, label: `${label} ·${n}` };
  });
}
