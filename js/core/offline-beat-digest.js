export const OFFLINE_BEAT_DIGEST_START = '<<<OFFLINE_BEAT_DIGEST>>>';
export const OFFLINE_BEAT_DIGEST_END = '<<<END_OFFLINE_BEAT_DIGEST>>>';

function clean(value = '', limit = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function cleanList(value, max = 3, limit = 160) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => clean(item, limit))
    .filter(Boolean))].slice(0, max);
}

export function normalizeOfflineBeatDigest(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const quoteRaw = raw.quote && typeof raw.quote === 'object' ? raw.quote : {};
  const quote = {
    speakerId: clean(quoteRaw.speakerId, 80),
    speaker: clean(quoteRaw.speaker, 40),
    line: clean(quoteRaw.line, 180),
  };
  const digest = {
    story: clean(raw.story || raw.core, 360),
    quote: quote.line ? quote : null,
    relationChanges: cleanList(raw.relationChanges || raw.shifts, 3),
    knowledgeChanges: cleanList(raw.knowledgeChanges, 3),
    items: cleanList(raw.items, 3),
    openThreads: cleanList(raw.openThreads || raw.hooks, 3),
  };
  return Object.values(digest).some((item) => Array.isArray(item) ? item.length : !!item)
    ? digest
    : null;
}

function parseDigestJson(value = '') {
  const raw = String(value || '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  if (!raw) return null;
  try {
    return normalizeOfflineBeatDigest(JSON.parse(raw));
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/u);
    if (!match) return null;
    try { return normalizeOfflineBeatDigest(JSON.parse(match[0])); } catch (_) { return null; }
  }
}

export function extractOfflineBeatDigest(rawText = '') {
  const text = String(rawText || '');
  const start = text.indexOf(OFFLINE_BEAT_DIGEST_START);
  if (start < 0) return { body: text, digest: null, status: 'missing' };
  const contentStart = start + OFFLINE_BEAT_DIGEST_START.length;
  const end = text.indexOf(OFFLINE_BEAT_DIGEST_END, contentStart);
  const content = end < 0 ? text.slice(contentStart) : text.slice(contentStart, end);
  const body = `${text.slice(0, start)}${end < 0 ? '' : text.slice(end + OFFLINE_BEAT_DIGEST_END.length)}`.trim();
  const digest = parseDigestJson(content);
  return { body, digest, status: end < 0 ? 'truncated' : (digest ? 'complete' : 'invalid') };
}

export function offlineBeatDigestInstruction({ beatNumber = 1 } = {}) {
  return [
    '【逐轮摘要 · 隐藏存档】',
    '本场已开启逐轮摘要。完成本轮可见正文后，追加下面的 JSON 存档块；它不会显示给用户，也不属于正文或思维链。',
    '只记录本轮新发生或改变的内容，不复述人物卡和旧剧情，不预测下一轮。没有对应内容时使用空数组或 null。story 用 120—220 字压缩本轮因果，保留明确人物主语；不要强行制造冲突、升华或悬念。',
    `本轮编号：${Math.max(1, Number(beatNumber) || 1)}`,
    OFFLINE_BEAT_DIGEST_START,
    '{"story":"本轮事件推进与即时结果","quote":{"speakerId":"角色id或user","speaker":"姓名","line":"本轮最有承接价值的一句原话"},"relationChanges":["谁对谁产生了什么可持续变化"],"knowledgeChanges":["谁新知道了什么"],"items":["关键物件、归属或状态变化"],"openThreads":["尚未完成的事项、约定或自然续接点"]}',
    OFFLINE_BEAT_DIGEST_END,
  ].join('\n');
}

export function mergeOfflineBeatDigests(first = null, second = null) {
  const left = normalizeOfflineBeatDigest(first) || {};
  const right = normalizeOfflineBeatDigest(second) || {};
  return normalizeOfflineBeatDigest({
    story: [left.story, right.story].filter(Boolean).join(' '),
    quote: right.quote || left.quote || null,
    relationChanges: [...(left.relationChanges || []), ...(right.relationChanges || [])],
    knowledgeChanges: [...(left.knowledgeChanges || []), ...(right.knowledgeChanges || [])],
    items: [...(left.items || []), ...(right.items || [])],
    openThreads: right.openThreads?.length ? right.openThreads : left.openThreads,
  });
}

export function formatOfflineBeatDigestForContext(digest = null, beatNumber = 0) {
  const row = normalizeOfflineBeatDigest(digest);
  if (!row) return '';
  const parts = [
    row.story,
    row.quote?.line ? `关键台词：${row.quote.speaker || row.quote.speakerId || '人物'}：“${row.quote.line}”` : '',
    row.relationChanges.length ? `关系变化：${row.relationChanges.join('；')}` : '',
    row.knowledgeChanges.length ? `认知变化：${row.knowledgeChanges.join('；')}` : '',
    row.items.length ? `物件与伏笔：${row.items.join('；')}` : '',
    row.openThreads.length ? `未完成事项：${row.openThreads.join('；')}` : '',
  ].filter(Boolean);
  return `${beatNumber ? `第 ${beatNumber} 轮逐轮摘要：` : '逐轮摘要：'}${parts.join('｜')}`;
}
