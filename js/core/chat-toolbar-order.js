export const CHAT_TOOL_DEFAULT_ORDER = Object.freeze([
  'act:phone-proxy',
  'act:reroll',
  'act:plot',
  'act:interaction',
  'act:aliases',
  'tool:search',
  'tool:phone-takeover',
  'tool:image',
  'tool:draw',
  'tool:voice-call',
  'tool:video-call',
  'tool:textimg',
  'tool:location',
  'tool:link',
  'tool:redpacket',
  'tool:transfer',
  'tool:ordershare',
  'tool:vote',
  'tool:dice',
  'act:scroll-capture',
  'act:gacha',
  'act:rolesay',
  'act:narrator',
  'act:gap-fill',
  'act:guidance',
  'act:offline-ff',
  'act:enter-offline',
  'act:invite-offline',
  'act:debug-raw',
  'act:description',
]);

const KNOWN_TOOL_IDS = new Set(CHAT_TOOL_DEFAULT_ORDER);

export function normalizeChatToolOrder(rawOrder) {
  const seen = new Set();
  const normalized = [];
  (Array.isArray(rawOrder) ? rawOrder : []).forEach((value) => {
    const id = String(value || '').trim();
    if (!KNOWN_TOOL_IDS.has(id) || seen.has(id)) return;
    seen.add(id);
    normalized.push(id);
  });
  CHAT_TOOL_DEFAULT_ORDER.forEach((id) => {
    if (seen.has(id)) return;
    seen.add(id);
    normalized.push(id);
  });
  return normalized;
}

export function sortChatToolbarItems(items = [], rawOrder = []) {
  const order = normalizeChatToolOrder(rawOrder);
  const rank = new Map(order.map((id, index) => [id, index]));
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftRank = rank.get(String(left.item?.id || ''));
      const rightRank = rank.get(String(right.item?.id || ''));
      const a = Number.isInteger(leftRank) ? leftRank : Number.MAX_SAFE_INTEGER;
      const b = Number.isInteger(rightRank) ? rightRank : Number.MAX_SAFE_INTEGER;
      return a - b || left.index - right.index;
    })
    .map(({ item }) => item);
}

export function paginateChatToolbarItems(items = [], pageSize = 8) {
  const source = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(pageSize) || 8));
  const pages = [];
  for (let start = 0; start < source.length; start += size) {
    pages.push(source.slice(start, start + size));
  }
  return pages.length ? pages : [[]];
}

/** 当前会话可能隐藏群聊/线下专属项；保存时先放可见项，再接回其它已知工具。 */
export function mergeVisibleChatToolOrder(rawOrder = [], visibleOrder = []) {
  const base = normalizeChatToolOrder(rawOrder);
  const visible = [];
  const seen = new Set();
  (Array.isArray(visibleOrder) ? visibleOrder : []).forEach((value) => {
    const id = String(value || '').trim();
    if (!KNOWN_TOOL_IDS.has(id) || seen.has(id)) return;
    seen.add(id);
    visible.push(id);
  });
  return normalizeChatToolOrder([
    ...visible,
    ...base.filter((id) => !seen.has(id)),
  ]);
}
