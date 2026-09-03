import * as db from '../db.js';

/**
 * 朋友圈场景抽签器。
 * 「发什么戏」不交给模型自由发挥（自由发挥的结果就是千篇一律的生活分享），
 * 由 JS 按占比设置加权抽样，把「发生了什么、涉及谁」作为事实性指令喂给模型；
 * 「怎么写」仍完全归人设。含历史降权（连续批次不重复同一场景/同一对人）与逃生门。
 */

export const MOMENTS_MIX_LEVELS = [
  { id: 'off', label: '关闭' },
  { id: 'low', label: '少量' },
  { id: 'mid', label: '适中' },
  { id: 'high', label: '偏多' },
];

const LEVEL_PROB = { off: 0, low: 0.22, mid: 0.5, high: 0.82 };

export const DEFAULT_MOMENTS_MIX = {
  userRelated: 'mid',
  drama: 'mid',
  share: 'low',
};

export function normalizeMomentsMix(raw = {}) {
  const pick = (v, fallback) => (LEVEL_PROB[v] !== undefined ? v : fallback);
  return {
    userRelated: pick(raw?.userRelated, DEFAULT_MOMENTS_MIX.userRelated),
    drama: pick(raw?.drama, DEFAULT_MOMENTS_MIX.drama),
    share: pick(raw?.share, DEFAULT_MOMENTS_MIX.share),
  };
}

// ---------- 历史降权 ----------

const HISTORY_LIMIT = 10;

function historyKey(userId) {
  return `momentsScenarioHistory_${String(userId || 'guest').trim()}`;
}

export async function loadScenarioHistory(userId) {
  const row = await db.get(historyKey(userId)).catch(() => null);
  const list = Array.isArray(row?.value) ? row.value : [];
  return list.filter((x) => x && typeof x === 'object');
}

export async function recordScenarioHistory(userId, { types = [], pairs = [] } = {}) {
  if (!types.length && !pairs.length) return;
  const prev = await loadScenarioHistory(userId);
  const next = [{ at: Date.now(), types, pairs }, ...prev].slice(0, HISTORY_LIMIT);
  await db.put({ key: historyKey(userId), value: next }).catch(() => {});
}

function recentTypes(history, batches = 2) {
  return new Set(history.slice(0, batches).flatMap((h) => h.types || []));
}

function recentPairs(history, batches = 3) {
  return new Set(history.slice(0, batches).flatMap((h) => h.pairs || []));
}

// ---------- 关系素材 ----------

function pairKey(a, b) {
  return [String(a), String(b)].sort().join('~');
}

/**
 * 收集可用于修罗场/呼应的角色两两关系边（角色卡登记 + 关系网连线，均排除 user）。
 * 只要有标签就算——标签语义（情敌/死对头/暗恋/闺蜜）由模型自己解读，JS 不做分类。
 */
export function collectDramaEdges({ charMap, relationshipNet, poolIds = [] }) {
  const pool = new Set((poolIds || []).map((x) => String(x || '').trim()).filter(Boolean));
  const edges = [];
  const seen = new Set();
  const push = (a, b, label) => {
    if (!a || !b || a === b || a === 'user' || b === 'user') return;
    if (!pool.has(a) && !pool.has(b)) return;
    if (!charMap?.get?.(a) || !charMap?.get?.(b)) return;
    const key = pairKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a, b, label: String(label || '').trim() || '认识', key });
  };
  for (const [cid, ch] of (charMap?.entries?.() || [])) {
    if (!ch?.relationships || typeof ch.relationships !== 'object') continue;
    for (const [rid, rel] of Object.entries(ch.relationships)) push(cid, rid, rel);
  }
  for (const circle of relationshipNet?.circles || []) {
    for (const edge of circle.edges || []) push(edge?.a, edge?.b, edge?.label);
  }
  return edges;
}

// ---------- 抽签 ----------

function weightedPick(items) {
  const alive = items.filter((x) => x.weight > 0);
  if (!alive.length) return null;
  const total = alive.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const item of alive) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return alive[alive.length - 1];
}

function shuffle(list) {
  return list.slice().sort(() => Math.random() - 0.5);
}

function nameOf(names, id, fallback = 'TA') {
  return String(names?.get?.(id) || '').trim() || fallback;
}

/**
 * 规划一批朋友圈的作者与场景指令。
 * @returns {{
 *   authors: string[],
 *   assignments: Array<{ index:number, authorId:string, type:string, text:string }>,
 *   historyPatch: { types:string[], pairs:string[] },
 * }}
 */
export function planMomentsScenarioBatch({
  candidateIds = [],
  pickCount = 3,
  charMap,
  relationshipNet = null,
  names,
  userName = '我',
  mix = DEFAULT_MOMENTS_MIX,
  history = [],
} = {}) {
  const levels = normalizeMomentsMix(mix);
  const pool = [...new Set(candidateIds.map((x) => String(x || '').trim()).filter(Boolean))];
  const count = Math.min(Math.max(1, pickCount), pool.length);
  const usedTypes = [];
  const usedPairs = [];
  const assignments = [];
  const authors = [];
  const taken = new Set();
  const skipTypes = recentTypes(history);
  const skipPairs = recentPairs(history);

  const takeAuthor = (id) => {
    if (!id || taken.has(id)) return false;
    taken.add(id);
    authors.push(id);
    return true;
  };

  // 1) 剧情槽：一批至多一个，占 1~2 条
  if (Math.random() < LEVEL_PROB[levels.drama]) {
    const allEdges = collectDramaEdges({ charMap, relationshipNet, poolIds: pool });
    // 优先没用过的对子；全被用过就解禁
    let edges = allEdges.filter((e) => !skipPairs.has(e.key));
    if (!edges.length) edges = allEdges;
    // 两端都在候选池里的边才能做隔空呼应（两个人都得发帖）
    const echoEdges = edges.filter((e) => pool.includes(e.a) && pool.includes(e.b));

    const dramaPick = weightedPick([
      { type: 'echo_pair', weight: (echoEdges.length && count >= 2 ? 1.1 : 0) * (skipTypes.has('echo_pair') ? 0.25 : 1) },
      { type: 'rivalry', weight: (edges.length ? 1 : 0) * (skipTypes.has('rivalry') ? 0.25 : 1) },
      { type: 'visibility_slip', weight: (pool.length >= 2 ? 0.8 : 0) * (skipTypes.has('visibility_slip') ? 0.25 : 1) },
      { type: 'chat_expose', weight: 0.8 * (skipTypes.has('chat_expose') ? 0.25 : 1) },
    ]);

    if (dramaPick?.type === 'echo_pair') {
      const edge = shuffle(echoEdges)[0];
      const [first, second] = Math.random() < 0.5 ? [edge.a, edge.b] : [edge.b, edge.a];
      takeAuthor(first);
      takeAuthor(second);
      assignments.push({
        index: 0,
        authorId: first,
        type: 'echo_pair',
        text: '你先发一条动态：只能从下方明确提供的专属聊天、记忆或生活素材里挑一件事，正文埋一个只有知情人看得懂的点，不@任何人。没有可用事实素材就降级成不涉及具体事件的当下心情，禁止现编一件事。',
      });
      assignments.push({
        index: 1,
        authorId: second,
        type: 'echo_pair',
        text: `你刷到了 ${nameOf(names, first)} 刚发的那条（即上一条指令产出的动态），另发一条不@、不点名的呼应或回应——外人看是两条独立动态，知情人一看就知道你们在隔空对话。你们的关系是「${edge.label}」，回应的火药味/默契度按这层关系和你的人设来。`,
      });
      usedTypes.push('echo_pair');
      usedPairs.push(edge.key);
    } else if (dramaPick?.type === 'rivalry') {
      const usable = edges.filter((e) => pool.includes(e.a) || pool.includes(e.b));
      const edge = shuffle(usable)[0];
      const author = pool.includes(edge.a) ? edge.a : edge.b;
      const other = author === edge.a ? edge.b : edge.a;
      takeAuthor(author);
      assignments.push({
        index: assignments.length,
        authorId: author,
        type: 'rivalry',
        text: `这条围绕你和 ${nameOf(names, other)} 的关系「${edge.label}」来发：可以暗搓搓较劲、不点名内涵、故意炫耀给TA看，也可以只是被这层关系硌到的一句牢骚；明暗程度按你的人设定，禁止把关系标签当台词写出来。如果TA在这条的互动圈名单里，评论区可以安排TA接招。`,
      });
      usedTypes.push('rivalry');
      usedPairs.push(edge.key);
    } else if (dramaPick?.type === 'visibility_slip') {
      const author = shuffle(pool)[0];
      takeAuthor(author);
      assignments.push({
        index: assignments.length,
        authorId: author,
        type: 'visibility_slip',
        text: '你这条本想屏蔽某个人（从人物关系图里挑一个你最不想让TA看到的人），结果手滑没屏蔽成功。正文按「以为TA看不到」的坦率程度写；visibility 仍填 all，visibilityNote 写清你原本想屏蔽谁、为什么；如果TA在互动圈名单里，评论区让TA本人出现，当场撞见的尴尬或看戏由此展开。',
      });
      usedTypes.push('visibility_slip');
    } else if (dramaPick?.type === 'chat_expose') {
      const author = shuffle(pool)[0];
      takeAuthor(author);
      assignments.push({
        index: assignments.length,
        authorId: author,
        type: 'chat_expose',
        text: '这条可以发成 postKind=chat_share：若聊天涉及用户，只能用 chatShareSourceLineIds 选择下方「该作者专属聊天事实」里的 3～6 个真实消息编号，禁止自行编写 chatShareLines；若明确不涉及用户，可按角色卡/关系网合理虚构一段日常聊天，但不得冒充用户、影射用户或把虚构对象写成「某人」。没有适合方向就降级普通 text。',
      });
      usedTypes.push('chat_expose');
    }
  }

  // 2) 补齐作者
  for (const id of shuffle(pool)) {
    if (authors.length >= count) break;
    takeAuthor(id);
  }

  // 3) 非剧情槽分配：user 相关（至多 2 条）、分享（至多 1 条）
  const assignedAuthorIds = new Set(assignments.map((a) => a.authorId));
  let userSlots = 0;
  let shareSlots = 0;
  for (const authorId of authors) {
    if (assignedAuthorIds.has(authorId)) continue;
    if (userSlots < 2 && Math.random() < LEVEL_PROB[levels.userRelated]) {
      assignments.push({
        index: assignments.length,
        authorId,
        type: 'user_related',
        text: `这条和用户「${userName}」（固定 id=user）有关：必须依据下方用户档案、专属聊天或记忆里真实存在的内容；可以用「某人/那个人」含蓄指代该用户，但不能让它指向另一个虚构的人，也不能编造未发生的聊天或事件。没有真实互动素材就只写不带具体事件的想念/情绪，或降级普通生活切片。`,
      });
      userSlots += 1;
      usedTypes.push('user_related');
      continue;
    }
    if (shareSlots < 1 && Math.random() < LEVEL_PROB[levels.share]) {
      assignments.push({
        index: assignments.length,
        authorId,
        type: 'share',
        text: '这条是刷到内容后的转发式吐槽/安利：只能从下方已提供的「真实生活素材 / 站内微博近况」里选一条，正文写评价或吐槽；没有合适素材就降级成普通生活切片，禁止自行编造新闻、链接、标题或不存在的发布者。',
      });
      shareSlots += 1;
      usedTypes.push('share');
    }
  }

  return {
    authors: authors.slice(0, count),
    assignments,
    historyPatch: { types: usedTypes, pairs: usedPairs },
  };
}

/** 把抽签结果拼成 prompt 块；空 assignments 时返回空串（全员自由生活切片） */
export function formatScenarioDirectiveBlock(plan, names) {
  if (!plan?.assignments?.length) return '';
  const byAuthor = new Map(plan.assignments.map((a) => [a.authorId, a]));
  const lines = plan.authors.map((id, i) => {
    const a = byAuthor.get(id);
    const label = `${id}:${nameOf(names, id, id)}`;
    if (!a) return `第 ${i + 1} 条 · ${label}：普通生活切片，自由发挥（贴人设、贴TA最近真实过的日子）。`;
    return `第 ${i + 1} 条 · ${label}：${a.text}`;
  });
  return [
    '[本批场景指令 · 逐条执行]',
    '下面按条指定了每条动态的作者和「发生了什么」；表达方式、句式、语气、说多说少完全按该作者人设来，指令只给事实不给台词。',
    ...lines,
    '[逃生门] 若某条指令与该角色人设或当前处境明显冲突（比如让社恐炫耀、让绝交的人呼应），允许把那一条降级成普通生活切片，宁可平淡不失真；其余条目不受影响。',
  ].join('\n');
}
