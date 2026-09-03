function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pairedParticipants(participantIds = [], participantNames = []) {
  const ids = Array.isArray(participantIds) ? participantIds : [];
  const names = Array.isArray(participantNames) ? participantNames : [];
  const seen = new Set();
  return ids.map((id, index) => ({
    id: clean(id),
    name: clean(names[index] || id),
  })).filter((entry) => {
    if (!entry.id || entry.id === 'user' || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/**
 * 多人线下的档案属于共同经历，但不代表其中所有台词与行为都属于当前读取角色。
 * 同时用于新记忆落库与旧档案运行时注入，历史档案不必重新总结也能得到保护。
 */
export function buildOfflineAttributionBoundary({
  currentCharacterId = '',
  currentCharacterName = '',
  participantIds = [],
  participantNames = [],
  quotes = [],
} = {}) {
  const participants = pairedParticipants(participantIds, participantNames);
  if (participants.length < 2) return '';
  const currentId = clean(currentCharacterId);
  const current = participants.find((entry) => entry.id === currentId);
  const currentName = clean(currentCharacterName || current?.name || currentId || '当前角色');
  const roster = participants
    .map((entry) => `${entry.name}（角色ID:${entry.id}）`)
    .join('、');
  const quoteLines = (Array.isArray(quotes) ? quotes : [])
    .map((quote) => {
      const line = clean(quote?.line);
      if (!line) return '';
      const speakerId = clean(quote?.speakerId);
      const matched = participants.find((entry) => (
        (speakerId && entry.id === speakerId)
        || clean(entry.name) === clean(quote?.speaker)
      ));
      const speaker = clean(quote?.speaker || matched?.name || speakerId);
      return speaker ? `${speaker}${matched?.id ? `（角色ID:${matched.id}）` : ''}说：「${line}」` : '';
    })
    .filter(Boolean)
    .slice(0, 3);
  return [
    `【多人线下说话人归属】当前读取并回忆的是 ${currentName}${currentId ? `（角色ID:${currentId}）` : ''}；同行角色为：${roster}。`,
    `“这条记忆属于 ${currentName}”只表示 TA 亲历或知情，不表示下文所有台词、动作、观点都由 TA 说或做。“你／用户”始终指真实用户；明确写了姓名或说话人的内容只能归给对应人物。归属不清时保持“不确定是谁”，禁止把同行者的话改认成 ${currentName} 自己说过。`,
    quoteLines.length ? `已确认的原话归属：${quoteLines.join('；')}` : '',
  ].filter(Boolean).join('\n');
}
