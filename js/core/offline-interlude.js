function clean(value = '', max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function id(prefix = 'oi') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 手机插曲同时保留两种形态：
 * - text：给后续叙事与旧归档读取的完整事实；
 * - notice：前台只画成克制的消息提醒，不把聊天全文铺在线下正文里。
 */
export function buildOfflineInterludeBeat({
  id: beatId = '',
  ts = Date.now(),
  text = '',
  kind = 'message',
  chatId = '',
  chatLabel = '',
  incomingCount = 0,
  outgoingCount = 0,
  counterpartCount = 0,
  mode = '',
  proxyCharacterId = '',
  proxyName = '',
  messageIds = [],
  title = '',
  detail = '',
} = {}) {
  const safeIncoming = Math.max(0, Number(incomingCount || 0));
  const safeCounterpart = Math.max(0, Number(counterpartCount || 0));
  const label = clean(chatLabel, 60) || '一段聊天';
  return {
    id: beatId || id(),
    role: 'interlude',
    text: String(text || '').trim(),
    ts: Number(ts || Date.now()),
    notice: {
      kind: String(kind || 'message'),
      chatId: String(chatId || ''),
      chatLabel: label,
      incomingCount: safeIncoming,
      outgoingCount: Math.max(0, Number(outgoingCount || 0)),
      counterpartCount: safeCounterpart,
      mode: String(mode || ''),
      proxyCharacterId: String(proxyCharacterId || ''),
      proxyName: clean(proxyName, 60),
      messageIds: [...new Set((messageIds || []).map((x) => String(x || '')).filter(Boolean))].slice(0, 20),
      title: clean(title, 100) || `${label}发来 ${safeIncoming || safeCounterpart || 1} 条消息`,
      detail: clean(detail, 140),
    },
  };
}

export function getOfflineInterludeNotice(beat) {
  const n = beat?.notice;
  if (!n || typeof n !== 'object') {
    const text = String(beat?.text || '').trim();
    const isPhoneTrip = text.startsWith('你中途掏出手机，处理了几段线上往来：');
    const isAutoReply = text.startsWith('手机在这期间响了——');
    if (!isPhoneTrip && !isAutoReply) return null;
    const labels = [...text.matchAll(/「([^」]{1,60})」/g)].map((m) => clean(m[1], 60));
    const names = [...new Set(labels.filter(Boolean))];
    const autoName = isAutoReply ? (names[0] || '有人') : '';
    return {
      kind: 'legacy_phone',
      chatId: '',
      chatLabel: autoName || (names[0] || '手机消息'),
      incomingCount: 0,
      outgoingCount: 0,
      counterpartCount: 0,
      mode: '',
      proxyCharacterId: '',
      proxyName: '',
      messageIds: [],
      title: isAutoReply
        ? `${autoName}发来消息`
        : (names.length > 1 ? `${names.length} 个聊天有新消息` : `${names[0] || '手机里'}有新的往来`),
      detail: '这段往来已收进线下记忆',
      legacy: true,
    };
  }
  return {
    ...n,
    title: clean(n.title, 100) || `${clean(n.chatLabel, 60) || '一段聊天'}有新消息`,
    detail: clean(n.detail, 140),
  };
}
