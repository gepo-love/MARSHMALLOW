/**
 * need_search 逃生口（用户可开关）：
 * 角色聊天中遇到确实需要联网查证的具体词条（新活动/新梗/赛事时效信息等）时，
 * 在本轮回复末尾输出一行 {"t":"need_search","q":"..."} 事件。客户端拦截后：
 *
 *   本地小知识库命中 → 免费直接注入重跑
 *   未命中 → ①联网粗搜 → ②小 LLM 提炼摘要（可给出一个更具体的追查词）
 *          → ③需要时二段细搜 → 摘要注入上下文重跑本轮 → 沉淀为小知识卡（下次免费）
 *
 * 成本上限：每次查证 ≤2 次搜索 + ≤2 次小 LLM 调用；独立每日额度 needSearchDailyLimit。
 * 注意：本文件不做任何静态业务 import（ai-round.js 会静态引入本模块，重依赖全部动态加载避免环）。
 */

const NEED_SEARCH_USAGE_KEY = 'needSearchDailyUsage';
const CACHE_FRESH_DAYS = 14;

function clean(value = '', max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[\s\u3000·・\-—_/]+/g, '');
}

/** 字符级 2-gram Dice 相似度：同一件事换个说法查（如「某游戏联动」vs「某游戏暑期联动」）
 * 精确/子串匹配抓不住，靠这个兜底，避免同一个话题反复沉淀出好几张几乎一样的知识卡。 */
function charBigrams(s) {
  const chars = Array.from(String(s || ''));
  if (chars.length < 2) return new Set(chars);
  const grams = new Set();
  for (let i = 0; i < chars.length - 1; i += 1) grams.add(chars[i] + chars[i + 1]);
  return grams;
}

function titleSimilarity(a, b) {
  const ga = charBigrams(a);
  const gb = charBigrams(b);
  if (!ga.size || !gb.size) return a === b ? 1 : 0;
  let overlap = 0;
  for (const g of ga) if (gb.has(g)) overlap += 1;
  return (2 * overlap) / (ga.size + gb.size);
}

const WIKI_DUP_SIMILARITY = 0.5;

function dayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 从模型原文里提取 need_search 申请（协议块内的一行 JSON，容忍轻微格式问题） */
export function extractNeedSearchRequest(rawText = '') {
  const text = String(rawText || '');
  if (!/"t"\s*:\s*"need_search"/.test(text)) return null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('need_search')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (String(obj.t || obj.type || '').toLowerCase() !== 'need_search') continue;
      const query = clean(obj.q || obj.query || obj.keyword, 80);
      if (query) return { query, from: clean(obj.from || obj.actor, 60) };
    } catch (_) { /* 继续扫下一行 */ }
  }
  const m = text.match(/"t"\s*:\s*"need_search"[^\n]*?"q"\s*:\s*"([^"]{1,80})"/)
    || text.match(/"q"\s*:\s*"([^"]{1,80})"[^\n]*?"t"\s*:\s*"need_search"/);
  return m ? { query: clean(m[1], 80), from: '' } : null;
}

/** need_search 事件行不属于可落库事件，持久化前一律剥掉 */
export function stripNeedSearchEvents(rawText = '') {
  const text = String(rawText || '');
  if (!text.includes('need_search')) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => !/"t"\s*:\s*"need_search"/.test(line))
    .join('\n');
}

/** 注入 system prompt 的使用说明（调用方负责判断开关是否打开） */
export function buildNeedSearchPromptBlock() {
  return [
    '【联网查证工具｜need_search】',
    '- 这是一条由客户端单独拦截的查证申请，不属于棉花糖 Tier 1 事件目录。遇到具体、可验证且可能随时间变化的事实（新活动/新作品/新梗/赛事进展、版本、日期、规则、公开人物近况等），只要你对关键事实拿不准、现有资料不足或不确定是否仍然有效，就应优先申请真实联网查证，不要靠印象猜。',
    '- 申请时先按当前对话自然说明要查证（比如「等下，我查一眼」），然后在协议块内的最后单独输出一行 {"t":"need_search","q":"要查的词","from":"你的id"}。查证前不要编造尚未获得的结果；过渡消息的数量与形状仍服从【回复节奏 · 错落】。',
    '- q 必须是具体可搜的关键词（如「明日方舟 危机合约 最新一期」），不要写成抽象问题或整句话。',
    '- 每轮最多一次。纯情绪陪伴、关系交流、日常寒暄或不需要外部事实的聊天不要搜索；只为接梗也不要滥用。',
  ].join('\n');
}

async function loadNeedSearchUsage() {
  const db = await import('../db.js');
  const row = await db.get('settings', NEED_SEARCH_USAGE_KEY).catch(() => null);
  const value = row?.value || {};
  const today = dayKey();
  if (value.day !== today) return { day: today, used: 0 };
  return { day: today, used: Math.max(0, Number(value.used || 0) || 0) };
}

async function bumpNeedSearchUsage() {
  const db = await import('../db.js');
  const usage = await loadNeedSearchUsage();
  await db.put('settings', { key: NEED_SEARCH_USAGE_KEY, value: { day: usage.day, used: usage.used + 1 } });
}

function isWikiEntryStale(entry) {
  if (entry.origin !== 'ai_grown') return false;
  // 条目没有时间戳字段，从 id（wb_<创建毫秒>_xxxx）里取创建时间做保鲜判断
  const stamp = Number(entry.updatedAt || entry.createdAt || String(entry.id || '').match(/^wb_(\d{10,})_/)?.[1] || 0);
  return !!stamp && Date.now() - stamp > CACHE_FRESH_DAYS * 86400000;
}

function wikiEntryKeys(entry) {
  return [entry.name, ...(Array.isArray(entry.keys) ? entry.keys : [])].map(normKey).filter((k) => k.length >= 2);
}

/** 本地小知识库命中则免费复用；AI 沉淀的卡超过保鲜期就当没有（时效词条会重新查证）
 * 精确/子串没命中时再退一步用标题相似度兜底，同一个话题换个说法查也能复用同一张卡。 */
async function findLocalWikiCard(query) {
  const { listAllWorldBookRows } = await import('../world-book-store.js');
  const rows = await listAllWorldBookRows().catch(() => []);
  const q = normKey(query);
  if (!q || q.length < 2) return null;
  const candidates = rows.filter((e) => e?.system === 'miniwiki' && clean(e?.content, 10) && !isWikiEntryStale(e));
  for (const entry of candidates) {
    const keys = wikiEntryKeys(entry);
    if (keys.some((k) => k === q || q.includes(k) || k.includes(q))) return entry;
  }
  let best = null;
  let bestScore = 0;
  for (const entry of candidates) {
    const score = titleSimilarity(q, normKey(entry.name));
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  return bestScore >= WIKI_DUP_SIMILARITY ? best : null;
}

/** 沉淀前找一张已有的同话题卡（不管新鲜与否，过期的也算「同一张卡」，直接覆盖更新而不是再开一张）。 */
async function findDuplicateForSediment(query, characterId) {
  const { listAllWorldBookRows } = await import('../world-book-store.js');
  const rows = await listAllWorldBookRows().catch(() => []);
  const q = normKey(query);
  const cid = String(characterId || '').trim();
  const candidates = rows.filter((e) => e?.system === 'miniwiki' && e.origin === 'ai_grown'
    && (cid ? (e.characterIds || []).includes(cid) : !e.characterIds?.length));
  for (const entry of candidates) {
    const keys = wikiEntryKeys(entry);
    if (keys.some((k) => k === q || q.includes(k) || k.includes(q))) return entry;
  }
  let best = null;
  let bestScore = 0;
  for (const entry of candidates) {
    const score = titleSimilarity(q, normKey(entry.name));
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  return bestScore >= WIKI_DUP_SIMILARITY ? best : null;
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function formatResultsForLlm(result, max = 6) {
  return (Array.isArray(result?.results) ? result.results : []).slice(0, max).map((r) => ({
    title: clean(r.title, 90),
    content: clean(r.content || r.raw_content, 320),
    url: clean(r.url, 300),
  })).filter((r) => r.title || r.content);
}

async function consumeRealPersonSearchBudget(userId, characterId, category) {
  try {
    const [{ loadResolvedCharacterAutonomyPolicy }, { consumeCharacterApiBudget }] = await Promise.all([
      import('../character-autonomy-settings.js'),
      import('../character-api-budget.js'),
    ]);
    const policy = await loadResolvedCharacterAutonomyPolicy(userId, characterId);
    if (policy?.realPersonMode?.enabled !== true) return { ok: true, skipped: true };
    return consumeCharacterApiBudget({
      userId,
      characterId,
      category,
      policy,
    });
  } catch (_) {
    return { ok: true, skipped: true };
  }
}

/**
 * 小 LLM 提炼：第一遍可以顺带给出一个更具体的追查词（比如从「危机合约 最新」查到合约名后，
 * 追查「<合约名> 登顶 阵容」这类细节），第二遍只做合并收束。
 */
async function distillNeedSearch({
  userId,
  characterId,
  query,
  firstResults,
  secondResults = null,
  secondQuery = '',
  allowFollowup,
  signal,
}) {
  const budget = await consumeRealPersonSearchBudget(userId, characterId, 'search_distill');
  if (!budget?.ok) return null;
  const { chatForTask } = await import('../api.js');
  const payload = {
    task: 'distill_realtime_search_for_roleplay',
    query,
    searchResults: firstResults,
    ...(secondResults ? { followupQuery: secondQuery, followupResults: secondResults } : {}),
    rules: [
      `以上是关于「${query}」的真实联网搜索结果。把它们去噪、合并成一段 ≤400 字的中文摘要 digest：这是什么、最新进展/名字/日期、圈内正在聊什么、有哪些值得知道的具体细节。只写搜索结果里真实出现的信息，标注不确定的地方（如「据搜索结果」），绝不编造。`,
      allowFollowup
        ? '如果结果里出现了更具体的名字/期数/活动，而「细节层」（打法、配置、榜单、结局等）还查不到，可以额外给一个 followupQuery（≤30 字的精准搜索词）；不需要就省略该字段。'
        : '这已经是第二遍搜索，不要再给 followupQuery，把两批结果合并成最终 digest。',
      '结果全是无关噪音、撑不起摘要时输出 {"skip": true}。只输出 JSON 对象。',
    ],
    schema: { digest: '≤400字摘要', followupQuery: '可选的追查词', skip: false },
  };
  const raw = await chatForTask([
    { role: 'user', content: JSON.stringify(payload, null, 2) },
  ], { temperature: 0.3, signal }, 'searchRefine').catch(() => '');
  const parsed = extractJsonObject(raw);
  if (!parsed || parsed.skip === true) return null;
  const digest = clean(parsed.digest, 500);
  if (!digest || digest.length < 20) return null;
  return { digest, followupQuery: allowFollowup ? clean(parsed.followupQuery, 40) : '' };
}

function buildContextBlock({ query, characterName, digest, fromCache }) {
  const source = fromCache
    ? '这是你本来就了解的内容（来自你的知识卡）：'
    : '系统已经帮你真实联网查证过了，摘要如下（真实检索结果，非编造）：';
  return [
    `【联网查证结果 · ${query}】`,
    `你（${characterName || '角色'}）刚才对「${query}」拿不准。${source}`,
    digest,
    '使用规则：',
    '- 基于这份摘要自然接住刚才的话题，语气口吻完全按你的人设来' + (fromCache ? '，当作自己知道的事说。' : '，可以带一句「刚搜了眼」之类的口风。'),
    '- 摘要之外的细节不知道就模糊带过，不要编造具体数字/名字。',
    '- 本轮照常输出棉花糖协议消息，不要再输出 need_search。',
  ].join('\n');
}

/** 查证结果沉淀成角色的小知识卡，下一次同话题不再花额度；同话题已有卡（哪怕标题措辞不同）就地覆盖，不再开新卡 */
async function sedimentWikiCard({ userId, characterId, query, digest, sourceUrl }) {
  const { saveWorldBookEntry } = await import('../world-book-store.js');
  const dup = await findDuplicateForSediment(query, characterId).catch(() => null);
  const mergedKeys = new Set([...(dup?.keys || []), clean(query, 40)].filter(Boolean));
  await saveWorldBookEntry({
    ...(dup || {}),
    name: dup?.name || clean(query, 30),
    content: `${digest}（查证于 ${dayKey()}）`,
    keys: [...mergedKeys],
    selective: true,
    constant: false,
    scope: characterId ? 'character' : 'global',
    characterIds: characterId ? [characterId] : [],
    userId: String(userId || ''),
    system: 'miniwiki',
    origin: 'ai_grown',
    wikiDepth: 'deep',
    sourceUrl: clean(sourceUrl, 300) || dup?.sourceUrl || '',
  });
}

/**
 * 主入口：把一次 need_search 申请解析成可注入上下文的查证块。
 * 返回 { block, fromCache } 或 null（未开启/额度用尽/查不到——调用方按普通轮次继续）。
 */
async function executeSearchCapability({
  userId,
  characterId,
  characterName,
  query,
  category,
  signal,
  approvalHandler,
  grants,
  mode,
  userInitiated,
}) {
  const { executeAppCapability } = await import('../capabilities/runtime.js');
  const execution = await executeAppCapability({
    capabilityId: 'search.web',
    arguments: { query },
    context: {
      context: 'chat',
      mode,
      userInitiated,
      display: { actorName: characterName },
    },
  }, {
    signal,
    approvalHandler,
    grants,
    metadata: {
      category,
      characterId,
      maxResults: 6,
      searchDepth: 'advanced',
      beforeProviderAttempt: () => consumeRealPersonSearchBudget(userId, characterId, 'search'),
    },
  });
  return execution.structuredContent;
}

function isCapabilityControlError(error) {
  return error?.code === 'capability_denied' || error?.code === 'capability_approval_required';
}

export function buildNeedSearchDeclinedBlock(query = '') {
  return [
    '【本轮联网结果】',
    `- 用户没有允许这次搜索「${clean(query, 80)}」，你没有获得任何搜索结果。`,
    '- 自然回应，可以说这次先不查；不要声称已经搜索，也不要编造结果。',
    '- 本轮照常输出棉花糖协议消息，不要再输出 need_search。',
  ].join('\n');
}

export function buildNeedSearchCapabilityGrants(config = {}) {
  if (config.enabled !== true || config.needSearchEnabled !== true) return [];
  return [{
    allow: true,
    capabilityId: 'search.web',
    providerId: 'builtin.web-search',
    context: 'chat',
  }];
}

export async function resolveNeedSearchContext({
  userId,
  characterId,
  characterName,
  query,
  signal,
  approvalHandler,
  mode = 'foreground',
  userInitiated = true,
} = {}) {
  const q = clean(query, 80);
  if (!q) return null;

  const cached = await findLocalWikiCard(q).catch(() => null);
  if (cached) {
    return {
      block: buildContextBlock({ query: q, characterName, digest: clean(cached.content, 500), fromCache: true }),
      fromCache: true,
    };
  }

  const { loadWebSearchConfig } = await import('../web-search-tools.js');
  const cfg = await loadWebSearchConfig().catch(() => null);
  if (!cfg?.enabled || cfg.needSearchEnabled !== true) return null;
  const grants = buildNeedSearchCapabilityGrants(cfg);
  const limit = Math.max(0, Number(cfg.needSearchDailyLimit || 0));
  if (limit > 0) {
    const usage = await loadNeedSearchUsage();
    if (usage.used >= limit) return null;
  }
  let first = null;
  try {
    first = await executeSearchCapability({
      userId,
      characterId,
      characterName,
      query: q,
      category: 'need_search',
      signal,
      approvalHandler,
      grants,
      mode,
      userInitiated,
    });
  } catch (error) {
    if (isCapabilityControlError(error) || error?.name === 'AbortError') throw error;
    return null;
  }
  await bumpNeedSearchUsage().catch(() => {});
  const firstResults = formatResultsForLlm(first);
  if (!firstResults.length) return null;

  let distilled = await distillNeedSearch({
    userId,
    characterId,
    query: q,
    firstResults,
    allowFollowup: true,
    signal,
  });
  if (!distilled) return null;

  let sourceUrl = firstResults[0]?.url || '';
  if (distilled.followupQuery && normKey(distilled.followupQuery) !== normKey(q)) {
    let second = null;
    try {
      second = await executeSearchCapability({
        userId,
        characterId,
        characterName,
        query: distilled.followupQuery,
        category: 'need_search_followup',
        signal,
        approvalHandler,
        grants,
        mode,
        userInitiated,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (!isCapabilityControlError(error)) console.warn('[need-search] followup search failed', error);
    }
    const secondResults = formatResultsForLlm(second);
    if (secondResults.length) {
      const merged = await distillNeedSearch({
        userId,
        characterId,
        query: q,
        firstResults,
        secondResults,
        secondQuery: distilled.followupQuery,
        allowFollowup: false,
        signal,
      });
      if (merged) {
        distilled = merged;
        sourceUrl = secondResults[0]?.url || sourceUrl;
      }
    }
  }

  await sedimentWikiCard({ userId, characterId, query: q, digest: distilled.digest, sourceUrl }).catch(() => {});
  return {
    block: buildContextBlock({ query: q, characterName, digest: distilled.digest, fromCache: false }),
    fromCache: false,
  };
}
