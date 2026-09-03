const VISIBLE_EVENT_TYPES = new Set(['text', 'voice', 'sticker', 'image', 'link']);

function clean(value = '', max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function stableHash(value = '') {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isVisibleMessage(message = {}) {
  if (!message || message.deleted || message.recalled || message.metadata?.aiPlaceholder) return false;
  if (String(message.senderId || '') === 'system' || String(message.type || '') === 'system') return false;
  return !message.type || VISIBLE_EVENT_TYPES.has(String(message.type));
}

export function classifyRelationshipContactStyle(label = '') {
  const text = clean(label, 120);
  if (!text) return 'unknown';
  if (/(?:恋人|情侣|伴侣|夫妻|爱人|热恋|暧昧|追求|互相喜欢|对象)/u.test(text)) return 'intimate';
  if (/(?:挚友|好友|闺蜜|兄弟|姐妹|家人|亲友|青梅竹马|发小|知己|很熟|亲近)/u.test(text)) return 'close';
  if (/(?:刚认识|不熟|陌生|点头之交|网友|同事|同学|合作|客户|上下级|师生|邻居)/u.test(text)) return 'bounded';
  return 'familiar';
}

export function collectRecentProactiveRoundStats(messages = [], limit = 3) {
  const rounds = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isVisibleMessage(message)) continue;
    const senderId = String(message.senderId || '');
    const channel = clean(message.metadata?.proactiveChannel, 40);
    if (!senderId || senderId === 'user' || !channel) continue;
    const roundId = clean(message.metadata?.aiRoundId || message.id, 120);
    if (!roundId) continue;
    const previous = rounds.get(roundId) || {
      roundId,
      channel,
      motive: clean(message.metadata?.proactiveMotive || channel, 40),
      count: 0,
      timestamp: 0,
    };
    previous.count += 1;
    previous.timestamp = Math.max(previous.timestamp, Number(message.timestamp || 0));
    rounds.set(roundId, previous);
  }
  return [...rounds.values()]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, Math.max(1, Number(limit) || 3));
}

function latestVisibleSender(messages = []) {
  const list = (Array.isArray(messages) ? messages : []).filter(isVisibleMessage);
  return String(list[list.length - 1]?.senderId || '');
}

function motiveCandidates({
  latestSender = '',
  hasScheduleMaterial = false,
  allowMemoryCallback = true,
} = {}) {
  if (latestSender === 'user') return ['carry-over'];
  return [
    'ambient-ping',
    ...(allowMemoryCallback ? ['memory-callback'] : []),
    ...(hasScheduleMaterial ? ['life-fragment'] : []),
  ];
}

export function planProactiveConversation({
  character = {},
  recentMessages = [],
  slotKey = '',
  hasScheduleMaterial = false,
  allowMemoryCallback = true,
  busy = false,
  channel = 'schedule',
} = {}) {
  const relationshipLabel = clean(character.userRelationStatus || character.relationshipToUser || '', 120);
  const relationshipStyle = classifyRelationshipContactStyle(relationshipLabel);
  const recentRounds = collectRecentProactiveRoundStats(recentMessages, 3);
  const candidates = motiveCandidates({
    latestSender: latestVisibleSender(recentMessages),
    hasScheduleMaterial,
    allowMemoryCallback,
  });
  const seed = `${character.id || character.name || ''}|${slotKey}|${channel}`;
  let motive = candidates[stableHash(seed) % candidates.length] || 'ambient-ping';
  if (candidates.length > 1 && recentRounds[0]?.motive === motive) {
    motive = candidates[(candidates.indexOf(motive) + 1) % candidates.length];
  }

  const stuckAtOne = recentRounds.length >= 2
    && recentRounds.slice(0, 2).every((round) => round.count <= 1);
  let shape = {
    id: 'natural',
    min: 2,
    max: motive === 'carry-over' ? 5 : 4,
  };
  if (stuckAtOne && !busy) {
    shape = { id: 'rebound', min: 3, max: 5 };
  } else if (busy) {
    shape = { id: 'low-key', min: 1, max: 2 };
  }

  return {
    channel: clean(channel, 40) || 'proactive',
    motive,
    relationshipLabel,
    relationshipStyle,
    shape,
    recentRounds,
    busy: busy === true,
  };
}

export function buildProactiveConversationDirective(plan = {}) {
  const motiveLines = {
    'carry-over': '这次开口的动机是接回两人尚有余温的聊天；先承接真正没聊完的点，不为了日程强行换题。',
    'ambient-ping': '这次是低目的性的随手联系：没有大事也可以说一句刚想到的看法、眼前的小观察或单纯想找对方说话；不要把它包装成日程汇报。',
    'memory-callback': '这次可以由真实共同记忆或旧梗产生一个新的联想，但不得把已经有人回应、之后又聊过别的内容的旧消息重新当成待回复；无法确认是否仍未聊完时，立刻改成普通随手闲聊。',
    'life-fragment': '这次可以分享一个生活片段，但只挑真正值得说的细节；不是报备行踪，也不复述整段日程。',
  };
  const relationshipLines = {
    bounded: '当前关系有边界：主动联系本身正常，但不要写成恋人式报备、查岗、黏人或默认对方必须回应。可以热络、有表达欲，分寸落在普通熟人/同事/同学会自然接受的范围。',
    familiar: '主动程度按当前关系和角色性格自然发挥；主动不自动等于暧昧，也不必为了守分寸故意冷淡。',
    close: '关系允许轻松、没目的的联系和共同梗；亲近不自动等于恋爱，称呼和占有感仍以角色资料为准。',
    intimate: '可以自然表现更强的联系冲动，但不要每轮都写成想念、查岗或报备，仍要保留角色自己的生活和话题变化。',
    unknown: '关系距离没有明确信号：保持自然友好，允许主动找话题，但不擅自升级成暧昧、恋人式黏人或占有。',
  };
  const expressionLine = plan?.shape?.id === 'low-key'
    ? '当前确实忙或只想轻轻冒头：忙碌影响回复时机、媒介和语气，轻反应可以成立，有话也可以沿自然气口继续；不在这里预设少量气泡，分条交给【回复节奏 · 错落】。'
    : '主动联系不强制高信息量或剧情推进：可以只是想说话，也可以带见闻、态度或联想；按此刻表达欲自然说，再由【回复节奏 · 错落】与人物语料决定条数和气口，本模块不另设数量档位。';
  return [
    '【主动联系动机与关系边界】',
    motiveLines[plan.motive] || motiveLines['ambient-ping'],
    relationshipLines[plan.relationshipStyle] || relationshipLines.unknown,
    expressionLine,
    '只把最后一条尚未得到任何角色回应的用户消息视为待回复；已经有人回应、之后又聊过别的内容的旧消息属于已结束上下文，不得突然返回去补答或换句话重答。',
    '“想让你知道 / 想让你看到 / 想找你说话”是开口动机，不是必须解释给对方听的台词；不要说系统、触发器、日程窗口或后台。',
  ].join('\n');
}
