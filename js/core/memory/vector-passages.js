export const CHAT_ORIGINAL_RECENT_WINDOW = 100;
export const CHAT_ORIGINAL_PASSAGE_SIZE = 6;
export const OFFLINE_ORIGINAL_PASSAGE_SIZE = 3;
export const RADIO_ORIGINAL_PASSAGE_CHARS = 980;

const LEXICAL_STOP_TERMS = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些', '什么', '怎么',
  '现在', '今天', '昨天', '明天', '上次', '之前', '后来', '当时', '时候', '已经',
  '还是', '然后', '可以', '一个', '不是', '就是', '真的', '觉得', '知道', '记得',
  '这里', '那里', '聊天', '消息', '事情', '一下', '这样', '那样', '如果', '因为',
  '所以', '但是', '而且', '没有', '还有', '自己', '对方', '用户', '角色', '当时原',
  '时原文', '原文', '开场', '现场', '变化', '选择',
]);

function cleanLine(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clipOriginal(value = '', limit = 520) {
  const text = cleanLine(value);
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.68);
  return `${text.slice(0, head)}…（原文过长，中段略）…${text.slice(-(limit - head))}`;
}

function lexicalNormalized(value = '') {
  return String(value || '')
    .toLocaleLowerCase()
    .replace(/https?:\/\/\S+|data:\S+|blob:\S+/gi, ' ')
    .replace(/\[[^\]]{0,40}\]/g, ' ')
    .replace(/[0-9０-９]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lexicalTerms(value = '') {
  const text = lexicalNormalized(value);
  const terms = new Set();
  const chunks = text.match(/[a-z][a-z0-9_-]{1,31}|[\u3400-\u9fff]{2,}/giu) || [];
  for (const chunk of chunks) {
    if (/^[a-z]/i.test(chunk)) {
      if (!LEXICAL_STOP_TERMS.has(chunk)) terms.add(chunk);
      continue;
    }
    for (let size = 2; size <= Math.min(4, chunk.length); size += 1) {
      for (let index = 0; index <= chunk.length - size; index += 1) {
        const term = chunk.slice(index, index + size);
        if (!LEXICAL_STOP_TERMS.has(term)) terms.add(term);
      }
    }
  }
  return [...terms];
}

function clipPassage(value = '', limit = 1100) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  const marker = '\n…（选段中部略）…\n';
  const available = Math.max(40, limit - marker.length);
  const head = Math.floor(available * 0.72);
  return `${text.slice(0, head).trim()}${marker}${text.slice(-(available - head)).trim()}`;
}

function clipPassageAroundTerms(value = '', terms = [], limit = 1100) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  const normalizedText = text.toLocaleLowerCase();
  const hits = (Array.isArray(terms) ? terms : [])
    .map((term) => {
      const needle = String(term || '').toLocaleLowerCase();
      return { needle, index: needle ? normalizedText.indexOf(needle) : -1 };
    })
    .filter((hit) => hit.index >= 0)
    .sort((left, right) => left.index - right.index);
  if (!hits.length) return clipPassage(text, limit);

  const first = hits[0];
  const prefixMarker = '…（前文略）…\n';
  const suffixMarker = '\n…（后文略）…';
  const rawBudget = Math.max(80, limit - prefixMarker.length - suffixMarker.length);
  let start = Math.max(0, first.index - Math.floor(rawBudget * 0.38));
  let end = Math.min(text.length, start + rawBudget);
  if (end >= text.length) start = Math.max(0, text.length - rawBudget);
  end = Math.min(text.length, start + rawBudget);
  return [
    start > 0 ? prefixMarker : '',
    text.slice(start, end).trim(),
    end < text.length ? suffixMarker : '',
  ].join('');
}

/**
 * 无向量 API 时的本地轻量召回。使用稀有词面 n-gram + 文档频率，
 * 只负责找回明确同词细节，不尝试冒充语义理解。
 */
export function rankLexicalPassages(queryText = '', rows = [], {
  limit = 2,
  budgetChars = 2200,
  maxItemChars = 1100,
  minScore = 1.25,
} = {}) {
  const queryTerms = lexicalTerms(queryText);
  const candidates = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const excerpt = String(row?.excerpt || row?.content || '').trim();
      return excerpt ? { row, excerpt, normalized: lexicalNormalized(excerpt) } : null;
    })
    .filter(Boolean);
  if (!queryTerms.length || !candidates.length) return [];

  const documentFrequency = new Map();
  for (const term of queryTerms) {
    let count = 0;
    for (const candidate of candidates) {
      if (candidate.normalized.includes(term)) count += 1;
    }
    documentFrequency.set(term, count);
  }

  const total = candidates.length;
  const scored = [];
  for (const candidate of candidates) {
    const matched = queryTerms.filter((term) => candidate.normalized.includes(term));
    if (!matched.length) continue;
    const longest = Math.max(...matched.map((term) => term.length));
    const rareSingle = matched.length === 1
      && (documentFrequency.get(matched[0]) || total) <= Math.max(1, Math.floor(total * 0.1));
    if (longest < 3 && matched.length < 2 && !rareSingle) continue;
    const score = matched.reduce((sum, term) => {
      const df = Math.max(1, documentFrequency.get(term) || 1);
      const idf = Math.log((total + 1) / (df + 0.5)) + 0.2;
      const lengthWeight = term.length >= 4 ? 2.8 : term.length === 3 ? 1.9 : 1;
      return sum + idf * lengthWeight;
    }, 0) + Math.min(1.5, matched.length / Math.max(2, queryTerms.length) * 4);
    if (score < minScore) continue;
    scored.push({
      ...candidate.row,
      excerpt: clipPassageAroundTerms(candidate.excerpt, matched, maxItemChars),
      lexicalScore: score,
      lexicalMatchedTerms: matched.slice(0, 12),
    });
  }

  scored.sort((left, right) => (
    Number(right.lexicalScore || 0) - Number(left.lexicalScore || 0)
    || Number(right.timestamp || right.toTimestamp || 0) - Number(left.timestamp || left.toTimestamp || 0)
  ));
  const selected = [];
  let used = 0;
  for (const row of scored) {
    const excerpt = String(row.excerpt || '').trim();
    if (!excerpt || used + excerpt.length > budgetChars) continue;
    selected.push(row);
    used += excerpt.length;
    if (selected.length >= limit) break;
  }
  return selected;
}

function messageOriginalText(message = {}) {
  const content = clipOriginal(message.content, 520);
  if (!content || /^(?:data:|blob:|https?:\/\/)\S+$/i.test(content)) return '';
  const senderId = String(message.senderId || '').trim() || 'unknown';
  const sender = cleanLine(message.senderName)
    || (senderId === 'user' ? '用户' : senderId || '角色');
  const identity = senderId === 'user' ? '用户ID:user' : `角色ID:${senderId}`;
  const ts = Number(message.timestamp || 0);
  const time = ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '';
  return `${time ? `[${time}] ` : ''}${sender}（${identity}）：${content}`;
}

export function eligibleChatOriginalMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message
      && !message.deleted
      && !message.recalled
      && message.type !== 'system'
      && message.senderId !== 'system'
      && message.metadata?.guidance !== true
      && message.metadata?.isGuidance !== true
      && messageOriginalText(message))
    .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
}

export function buildChatMessagePassageSources({
  chat = null,
  messages = [],
  recentWindow = CHAT_ORIGINAL_RECENT_WINDOW,
} = {}) {
  if (!chat?.id || !chat?.userId) return [];
  const rows = eligibleChatOriginalMessages(messages);
  const keepRecent = Math.max(1, Math.floor(Number(recentWindow) || CHAT_ORIGINAL_RECENT_WINDOW));
  const historical = rows.slice(0, Math.max(0, rows.length - keepRecent));
  const witnesses = [...new Set((chat.participants || []).map(String).filter(Boolean))];
  const sources = [];
  for (let start = 0; start < historical.length; start += CHAT_ORIGINAL_PASSAGE_SIZE) {
    const chunk = historical.slice(start, start + CHAT_ORIGINAL_PASSAGE_SIZE);
    const excerpt = chunk.map(messageOriginalText).filter(Boolean).join('\n');
    if (!excerpt) continue;
    sources.push({
      id: `${chat.id}:original:${Math.floor(start / CHAT_ORIGINAL_PASSAGE_SIZE)}`,
      userId: chat.userId,
      chatId: chat.id,
      type: 'chat_original',
      knownByActorIds: witnesses,
      messageIds: chunk.map((message) => String(message.id || '')).filter(Boolean),
      fromTimestamp: Number(chunk[0]?.timestamp || 0),
      toTimestamp: Number(chunk[chunk.length - 1]?.timestamp || 0),
      timestamp: Number(chunk[chunk.length - 1]?.timestamp || 0),
      content: excerpt,
      excerpt,
    });
  }
  return sources;
}

function deriveOfflineIntervals(rounds = [], characterId = '') {
  const id = String(characterId || '');
  const events = rounds
    .map((round, index) => ({ round, index }))
    .filter(({ round }) => String(round?.attendanceEvent?.characterId || '') === id);
  const intervals = [];
  const firstStatus = String(events[0]?.round?.attendanceEvent?.status || '');
  let start = events.length ? (firstStatus === 'left' ? 0 : null) : 0;
  for (const { round, index } of events) {
    const status = String(round.attendanceEvent?.status || '');
    if (status === 'active') {
      if (start == null) start = index;
    } else if (status === 'left') {
      if (start != null) intervals.push({ startIndex: start, endIndex: index });
      start = null;
    }
  }
  if (start != null && rounds.length) intervals.push({ startIndex: start, endIndex: rounds.length - 1 });
  return intervals;
}

function offlineRoundLine(round = {}) {
  const text = clipOriginal(round.text, 900);
  if (!text) return '';
  if (round.attendanceEvent) return `现场变化：${text}`;
  if (round.role === 'opening') return `开场：${text}`;
  if (round.role === 'directive') return `用户当时的选择：${text}`;
  if (round.role === 'interlude') return `现场插曲：${text}`;
  return `当时原文：${text}`;
}

export function buildOfflineArchivePassageSources(archive = {}) {
  const rounds = Array.isArray(archive?.rounds) ? archive.rounds.filter((round) => round?.text) : [];
  const participantIds = [...new Set([
    ...(archive.participantIds || []),
    archive.characterId,
  ].map(String).filter(Boolean))];
  if (!archive?.id || !archive?.userId || !rounds.length || !participantIds.length) return [];
  const visibility = new Map(
    participantIds.map((id) => [id, deriveOfflineIntervals(rounds, id)]),
  );
  const sources = [];
  for (let start = 0; start < rounds.length; start += OFFLINE_ORIGINAL_PASSAGE_SIZE) {
    const chunk = rounds.slice(start, start + OFFLINE_ORIGINAL_PASSAGE_SIZE);
    const end = start + chunk.length - 1;
    const witnesses = participantIds.filter((id) => (
      visibility.get(id)?.some((range) => start >= range.startIndex && end <= range.endIndex)
    ));
    if (!witnesses.length) continue;
    const body = chunk.map(offlineRoundLine).filter(Boolean).join('\n');
    if (!body) continue;
    const excerpt = [cleanLine(archive.title), body].filter(Boolean).join('\n');
    sources.push({
      id: `${archive.id}:original:${Math.floor(start / OFFLINE_ORIGINAL_PASSAGE_SIZE)}`,
      userId: archive.userId,
      chatId: archive.chatId,
      characterId: archive.characterId,
      type: 'offline_original',
      knownByActorIds: witnesses,
      fromTimestamp: Number(chunk[0]?.ts || archive.startedAt || 0),
      toTimestamp: Number(chunk[chunk.length - 1]?.ts || archive.endedAt || 0),
      timestamp: Number(chunk[chunk.length - 1]?.ts || archive.endedAt || 0),
      title: archive.title,
      content: excerpt,
      excerpt,
    });
  }
  return sources;
}

function splitRadioChapterPassages(value = '', maxChars = RADIO_ORIGINAL_PASSAGE_CHARS) {
  const source = String(value || '').trim();
  if (!source) return [];
  const units = source
    .split(/\n\s*\n+/u)
    .flatMap((block) => block.match(/[^。！？!?]+[。！？!?]?/gu) || [block])
    .map((item) => item.trim())
    .filter(Boolean);
  const passages = [];
  let current = '';
  for (const unit of units) {
    if (current && current.length + unit.length > maxChars) {
      passages.push(current);
      current = '';
    }
    if (unit.length > maxChars) {
      if (current) passages.push(current);
      for (let index = 0; index < unit.length; index += maxChars) {
        passages.push(unit.slice(index, index + maxChars));
      }
      current = '';
      continue;
    }
    current += unit;
  }
  if (current) passages.push(current);
  return passages;
}

/** 电台正文不常驻聊天上下文；只建立按章小段，供关键词或向量命中后取回。 */
export function buildRadioEpisodePassageSources(episode = {}) {
  const episodeId = String(episode?.id || '').trim();
  const userId = String(episode?.userId || '').trim();
  const characterId = String(episode?.characterId || '').trim();
  if (!episodeId || !userId || !characterId) return [];
  const witnesses = [...new Set((episode.characterIds || [characterId]).map(String).filter(Boolean))];
  return (Array.isArray(episode.chapters) ? episode.chapters : []).flatMap((chapter, chapterIndex) => (
    splitRadioChapterPassages(chapter?.text).map((body, passageIndex) => {
      const heading = [
        episode.title ? `电台《${cleanLine(episode.title)}》` : '角色电台',
        chapter?.title ? cleanLine(chapter.title) : `第 ${chapterIndex + 1} 章`,
      ].join(' · ');
      const excerpt = `${heading}\n${body}`;
      return {
        id: `${episodeId}:original:${chapterIndex}:${passageIndex}`,
        userId,
        chatId: String(episode.chatId || '').trim(),
        characterId,
        type: 'radio_original',
        knownByActorIds: witnesses,
        fromTimestamp: Number(episode.createdAt || 0),
        toTimestamp: Number(episode.createdAt || 0),
        timestamp: Number(episode.createdAt || 0),
        title: episode.title,
        content: excerpt,
        excerpt,
      };
    })
  ));
}

export function selectHistoricalChatPassages(rows = [], messages = [], contextDepth = CHAT_ORIGINAL_RECENT_WINDOW, {
  limit = 3,
  budgetChars = 4200,
} = {}) {
  const current = eligibleChatOriginalMessages(messages);
  const allIds = new Set(current.map((message) => String(message.id || '')).filter(Boolean));
  const recentIds = new Set(
    current.slice(-Math.max(1, Number(contextDepth) || CHAT_ORIGINAL_RECENT_WINDOW))
      .map((message) => String(message.id || ''))
      .filter(Boolean),
  );
  const selected = [];
  let used = 0;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const messageIds = Array.isArray(row?.messageIds) ? row.messageIds.map(String).filter(Boolean) : [];
    if (!messageIds.length || messageIds.some((id) => !allIds.has(id) || recentIds.has(id))) continue;
    const excerpt = String(row.excerpt || row.content || '').trim();
    if (!excerpt || used + excerpt.length > budgetChars) continue;
    selected.push({ ...row, excerpt });
    used += excerpt.length;
    if (selected.length >= limit) break;
  }
  return selected.sort((left, right) => Number(left.fromTimestamp || 0) - Number(right.fromTimestamp || 0));
}

/**
 * “昨天 / 前天 / 今天”这类明确时间询问不能只靠语义相似度。
 * 从已经排除默认最近窗口的原文分段里，按真实时间范围回流少量原文。
 */
export function selectPassagesInTimeRange(rows = [], range = null, {
  limit = 12,
  budgetChars = 12000,
  maxItemChars = 1600,
} = {}) {
  const start = Number(range?.start || 0);
  const end = Number(range?.end || 0);
  if (!start || !end || end <= start) return [];
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  const budget = Math.max(0, Math.floor(Number(budgetChars) || 0));
  if (!cap || !budget) return [];
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      const from = Number(row?.fromTimestamp || row?.timestamp || 0);
      const to = Number(row?.toTimestamp || row?.timestamp || from);
      return from < end && to >= start;
    })
    .sort((left, right) => (
      Number(left.fromTimestamp || left.timestamp || 0)
      - Number(right.fromTimestamp || right.timestamp || 0)
    ));
  const selected = [];
  let used = 0;
  for (const row of candidates) {
    const excerpt = clipPassage(row?.excerpt || row?.content || '', maxItemChars);
    if (!excerpt || used + excerpt.length > budget) continue;
    selected.push({ ...row, excerpt, temporalRecall: true });
    used += excerpt.length;
    if (selected.length >= cap) break;
  }
  return selected;
}

/**
 * 向量命中存在时仍保留一条本地精确词面兜底。
 * 用于覆盖旧原文刚掉出最近窗口、向量尚未补嵌，以及 embedding 漏掉菜名/昵称等低频词的情况。
 */
export function selectNonOverlappingLexicalFallback(vectorRows = [], lexicalRows = [], limit = 1) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (!cap) return [];
  const usedMessageIds = new Set(
    (Array.isArray(vectorRows) ? vectorRows : [])
      .flatMap((row) => Array.isArray(row?.messageIds) ? row.messageIds : [])
      .map(String)
      .filter(Boolean),
  );
  const usedText = new Set(
    (Array.isArray(vectorRows) ? vectorRows : [])
      .map((row) => cleanLine(row?.excerpt || row?.content || '').toLowerCase())
      .filter(Boolean),
  );
  const selected = [];
  for (const row of (Array.isArray(lexicalRows) ? lexicalRows : [])) {
    const messageIds = (Array.isArray(row?.messageIds) ? row.messageIds : [])
      .map(String)
      .filter(Boolean);
    const text = cleanLine(row?.excerpt || row?.content || '').toLowerCase();
    if (!text || usedText.has(text) || messageIds.some((id) => usedMessageIds.has(id))) continue;
    selected.push(row);
    messageIds.forEach((id) => usedMessageIds.add(id));
    usedText.add(text);
    if (selected.length >= cap) break;
  }
  return selected;
}
