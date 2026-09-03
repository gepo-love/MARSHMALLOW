function clean(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeChatMentions(value = []) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const actorId = clean(item?.actorId);
    const label = clean(item?.label).replace(/^@+/, '');
    const token = clean(item?.token) || (label ? `@${label}` : '');
    if (!actorId || !label || !token.startsWith('@')) return null;
    return { actorId, label, token };
  }).filter(Boolean);
}

export function findComposerMentionQuery(text = '', cursor = String(text || '').length) {
  const source = String(text || '');
  const end = Math.max(0, Math.min(source.length, Number(cursor) || 0));
  const beforeCursor = source.slice(0, end);
  const at = beforeCursor.lastIndexOf('@');
  if (at < 0) return null;
  const query = beforeCursor.slice(at + 1);
  if (query.length > 32 || /[@\s\n\r，。！？、：；()[\]{}]/u.test(query)) return null;
  return { start: at, end, query };
}

export function insertComposerMention(text = '', range = null, mention = {}) {
  const source = String(text || '');
  const actorId = clean(mention.actorId);
  const label = clean(mention.label).replace(/^@+/, '');
  if (!range || !actorId || !label) return null;
  const start = Math.max(0, Math.min(source.length, Number(range.start) || 0));
  const end = Math.max(start, Math.min(source.length, Number(range.end) || start));
  const token = `@${label}`;
  const suffix = source.slice(end);
  const spacer = suffix && /^\s/u.test(suffix) ? '' : ' ';
  const nextText = `${source.slice(0, start)}${token}${spacer}${suffix}`;
  return {
    text: nextText,
    cursor: start + token.length + spacer.length,
    mention: { actorId, label, token },
  };
}

export function collectPersistedChatMentions(text = '', value = []) {
  const source = String(text || '');
  const cursorByToken = new Map();
  return normalizeChatMentions(value).filter((mention) => {
    const from = cursorByToken.get(mention.token) || 0;
    const foundAt = source.indexOf(mention.token, from);
    if (foundAt < 0) return false;
    cursorByToken.set(mention.token, foundAt + mention.token.length);
    return true;
  });
}

export function resolveChatMentionLabel(mention = {}, options = {}) {
  const actorId = clean(mention.actorId);
  const groupCard = clean(options.memberCards?.[actorId]);
  if (groupCard) return groupCard;
  if (actorId === 'user') {
    const userLabel = clean(options.currentUserName || options.user?.nickname || options.user?.name);
    if (userLabel) return userLabel;
  }
  const row = options.characters?.[actorId];
  return clean(row?.name || row?.customNickname || row?.realName || mention.label || actorId) || '群成员';
}

export function renderChatMentionText(text = '', value = [], options = {}) {
  const source = String(text || '');
  const escape = typeof options.escape === 'function' ? options.escape : (value) => String(value ?? '');
  const mentions = normalizeChatMentions(value);
  if (!mentions.length) return escape(source);
  let cursor = 0;
  const chunks = [];
  for (const mention of mentions) {
    const foundAt = source.indexOf(mention.token, cursor);
    if (foundAt < 0) continue;
    chunks.push(escape(source.slice(cursor, foundAt)));
    const label = resolveChatMentionLabel(mention, options);
    chunks.push(`<span class="chat-mention" data-mention-id="${escape(mention.actorId)}">${escape(`@${label}`)}</span>`);
    cursor = foundAt + mention.token.length;
  }
  chunks.push(escape(source.slice(cursor)));
  return chunks.join('');
}

export function formatChatMentionContext(message = {}, options = {}) {
  const mentions = normalizeChatMentions(message?.metadata?.mentions);
  if (!mentions.length) return '';
  const seen = new Set();
  const rows = [];
  for (const mention of mentions) {
    const key = `${mention.actorId}\u0000${mention.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = resolveChatMentionLabel(mention, options);
    rows.push(`@${label}→角色ID:${mention.actorId}`);
  }
  return rows.length ? `[明确提及: ${rows.join('；')}]` : '';
}
