const MINUTE_MS = 60 * 1000;
const MAX_ACTIVE_LOOKBACK_MS = 12 * 60 * 60 * 1000;
const MAX_DURATION_MINUTES = 24 * 60;

function clean(value = '', max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function messageText(message = {}) {
  if (typeof message.content === 'string') return clean(message.content);
  if (message.content && typeof message.content === 'object') {
    return clean(
      message.content.text
      || message.content.body
      || message.content.caption
      || message.content.title
      || '',
    );
  }
  return clean(message.text || message.body || '');
}

function chineseInteger(value = '') {
  const text = clean(value);
  if (/^\d+$/.test(text)) return Number(text);
  const digits = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    俩: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (text === '十') return 10;
  const tenIndex = text.indexOf('十');
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[text[tenIndex - 1]];
    const ones = tenIndex === text.length - 1 ? 0 : digits[text[tenIndex + 1]];
    if (Number.isFinite(tens) && Number.isFinite(ones)) return tens * 10 + ones;
  }
  return digits[text] ?? 0;
}

function durationMinutesFromMatch(match = []) {
  const raw = clean(match[0]);
  if (/^半(?:个)?(?:小时|钟头)$/.test(raw)) return 30;
  const number = chineseInteger(match[1] || '');
  if (!number) return 0;
  if (/个?半(?:小时|钟头)$/.test(raw)) return number * 60 + 30;
  if (/(?:小时|钟头)$/.test(raw)) return number * 60;
  return number;
}

function isFutureDurationContext(text = '', start = 0, end = 0) {
  const left = text.slice(Math.max(0, start - 22), start);
  const right = text.slice(end, Math.min(text.length, end + 28));
  const around = `${left}${text.slice(start, end)}${right}`;
  if (/(?:前|以前|之前|以前就|之前就)/.test(right.slice(0, 4))) return false;
  if (/(?:已经|刚才|刚刚|总共|一共|花了|用了|耗时|过去了|等了)\s*$/.test(left)) return false;
  return /(?:还(?:得|要|需)?|大概|估计|预计|至少|差不多|最快|要|得|需要|需|再|过|之后|以后|才能|才会|才到|就到|到达|赶到|回来|回去|完成|做完|忙完|弄完|搞定|结束|收拾完|走完|开完|下课)/.test(around);
}

/**
 * 从自然聊天里提取“还要多久才能完成/抵达”的承诺。
 * 只处理有明确数字的短期时长；模糊的“一会儿/很久”仍交给模型结合语境判断。
 */
export function extractFutureDurationCommitment(text = '') {
  const source = clean(text);
  if (!source) return null;
  const pattern = /([一二两俩三四五六七八九十\d]+)个?半(?:小时|钟头)|半(?:个)?(?:小时|钟头)|([一二两俩三四五六七八九十\d]+)(?:个)?(?:小时|钟头)|([一二两俩三四五六七八九十\d]+)分钟/g;
  for (const match of source.matchAll(pattern)) {
    const numericMatch = [
      match[0],
      match[1] || match[2] || match[3] || '',
    ];
    const minutes = durationMinutesFromMatch(numericMatch);
    if (minutes < 2 || minutes > MAX_DURATION_MINUTES) continue;
    const start = Number(match.index || 0);
    const end = start + match[0].length;
    if (!isFutureDurationContext(source, start, end)) continue;
    return {
      minutes,
      excerpt: clean(source.slice(Math.max(0, start - 32), Math.min(source.length, end + 42)), 110),
    };
  }
  return null;
}

function formatMinutes(minutes = 0) {
  const value = Math.max(1, Math.ceil(Number(minutes) || 0));
  if (value < 60) return `${value} 分钟`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return `${hours} 小时${rest ? ` ${rest} 分钟` : ''}`;
}

function actorLabel(message = {}, characters = {}) {
  const id = clean(message.senderId);
  return clean(
    characters?.[id]?.realName
    || characters?.[id]?.name
    || message.senderName
    || id
    || '角色',
    40,
  );
}

export function findActiveDurationCommitments(messages = [], options = {}) {
  const now = Number(options.now || Date.now()) || Date.now();
  const characters = options.characters || {};
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((message) => (
      message
      && !message.deleted
      && !message.recalled
      && message.senderId
      && message.senderId !== 'user'
      && message.senderId !== 'system'
      && Number(message.timestamp || 0) > 0
    ))
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    .slice(-24);
  const seenActors = new Set();
  const active = [];
  for (let index = rows.length - 1; index >= 0 && active.length < 2; index -= 1) {
    const message = rows[index];
    const actorId = clean(message.senderId);
    if (!actorId || seenActors.has(actorId)) continue;
    const startedAt = Number(message.timestamp || 0);
    const elapsedMs = now - startedAt;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > MAX_ACTIVE_LOOKBACK_MS) continue;
    const commitment = extractFutureDurationCommitment(messageText(message));
    if (!commitment) continue;
    const dueAt = startedAt + commitment.minutes * MINUTE_MS;
    if (dueAt <= now) continue;
    seenActors.add(actorId);
    active.push({
      actorId,
      actorName: actorLabel(message, characters),
      startedAt,
      dueAt,
      durationMinutes: commitment.minutes,
      elapsedMinutes: Math.max(0, Math.floor(elapsedMs / MINUTE_MS)),
      remainingMinutes: Math.max(1, Math.ceil((dueAt - now) / MINUTE_MS)),
      excerpt: commitment.excerpt,
    });
  }
  return active;
}

export function buildActiveDurationContinuityBlock(messages = [], options = {}) {
  const active = findActiveDurationCommitments(messages, options);
  if (!active.length) return '';
  return [
    '【进行中耗时承诺 · 硬性时间约束】',
    ...active.map((item) => (
      `- ${item.actorName} 约 ${formatMinutes(item.elapsedMinutes || 1)}前说「${item.excerpt}」，`
      + `当时明确预计 ${formatMinutes(item.durationMinutes)}；按当前世界时钟，至少还需约 ${formatMinutes(item.remainingMinutes)}。`
    )),
    '时间算术是当前事实：预计时长尚未走完时，相关移动、工作、洗漱、做饭、会议或其它过程默认仍在进行；不得无依据宣称已经到了、回来了、忙完了、做完了或结束了。',
    '角色主动追发、用户普通闲聊、模型新开一轮，都不会让世界时间自动快进。只有最新消息明确提供了取消、改道、提前完成的具体依据，或产品的世界时钟确实推进到预计完成点之后，才能结束该过程。',
    '世界书与人设可以规定做事方式和速度，但不能抹掉已经明确说出的时长与实际已流逝时间；若设定确实存在瞬移、时间加速等机制，也必须在本轮上下文中有明确触发依据，不能临时拿来圆场。',
  ].join('\n');
}
