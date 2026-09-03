function clean(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function latestUserMessage(messages = []) {
  return [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => (
      String(message?.senderId || '').trim() === 'user'
      && !message?.deleted
      && !message?.recalled
    )) || null;
}

export function hasExplicitUserCrossWindowForwardRequest(messages = []) {
  const text = clean(latestUserMessage(messages)?.content);
  if (!text) return false;
  const mentionsMaterial = /(?:这(?:段|些|张|条|个)|刚才|上面|聊天记录|对话记录|消息记录|原话|截图|图片|照片|链接|消息)/u.test(text);
  const directForward = /(?:转发|转给|发给|发到|发进|分享给|甩给|丢给|传给)/u.test(text)
    || /(?:把|将).{0,40}(?:发|转|分享).{0,20}(?:给|到|进)/u.test(text);
  const namesDestination = /(?:给|到|进)[^，。！？\s]{1,24}/u.test(text)
    || /(?:发|转|分享)[^，。！？]{0,12}(?:群里|群聊|朋友群|他|她|他们|她们|ta)/iu.test(text);
  const requestTone = /(?:^|[，。！？\s])(?:请|麻烦|帮我|替我|你(?:把|将|去|帮我|直接)|把|将|直接|就|记得|可以|能不能|能否|要不|去)[^，。！？]{0,32}(?:转发|转给|发给|发到|发进|分享给|甩给|丢给|传给)/u.test(text)
    || /^(?:转发|转给|发给|发到|发进|分享给|甩给|丢给|传给)/u.test(text);
  return mentionsMaterial && directForward && namesDestination && requestTone;
}

function userLabels(userName = '') {
  return new Set(['user', '用户', clean(userName)].filter(Boolean));
}

function itemBelongsToUser(item = {}, sourceById = new Map(), labels = new Set()) {
  const senderId = clean(item.senderId || item.from);
  const senderName = clean(item.senderName || item.fromName);
  if (labels.has(senderId) || labels.has(senderName)) return true;
  const selector = clean(typeof item.relay === 'string' ? item.relay : item.relay?.selector);
  if (/^last_user(?:_|$)/u.test(selector)) return true;
  const sourceId = clean(item.relayFromMessageId);
  return sourceId ? clean(sourceById.get(sourceId)?.senderId) === 'user' : false;
}

export function crossWindowEventContainsUserMaterial(event = {}, options = {}) {
  const sourceById = new Map((Array.isArray(options.sourceMessages) ? options.sourceMessages : [])
    .filter((message) => message?.id)
    .map((message) => [String(message.id), message]));
  const labels = userLabels(options.userName);
  const rows = [
    ...(Array.isArray(event.items) ? event.items : []),
    ...(Array.isArray(event.lines) ? event.lines : []),
  ];
  if (event.relay) rows.push({ relay: event.relay });
  return rows.some((item) => itemBelongsToUser(item, sourceById, labels));
}

export function shouldBlockUserMaterialCrossWindowForward(event = {}, options = {}) {
  const type = clean(event.t);
  const target = clean(event.to);
  const room = clean(event.room);
  const crossesIntoRoleOnlyWindow = type === 'peer_private'
    || type === 'backstage'
    || (type === 'chat_bundle' && ((target && target !== 'user') || room));
  if (!crossesIntoRoleOnlyWindow) return false;
  if (options.explicitUserAuthorization === true) return false;
  return crossWindowEventContainsUserMaterial(event, options);
}
