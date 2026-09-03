/**
 * 常识词汇池（taste pool）：角色「常去的店 / 常点的单品」这类具体到能直接说出口的生活细节。
 * 来源两条：staple 频道兴趣搜索的轻量提取（source: 'search'）、地图生长读到的真实 POI
 * （source: 'amap'，见 character-phone-map-grower.js 阶段 6 接线）。
 *
 * 只做具体分类目 → 具体条目的扁平存储，不做语义理解；语义判断（该往哪个类目塞、要不要注入）
 * 交给调用方（interest-search-orchestrator.js 写入时定类目名；build-chat-context.js 读取时
 * 按聊天内容 selective 命中）。
 */
import * as db from './db.js';

const MAX_ITEMS_PER_CATEGORY = 8;
const MAX_TOTAL_ITEMS = 40;

function storeKey(userId, characterId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const cid = encodeURIComponent(String(characterId || '').trim());
  return `characterTastePool_${uid}_${cid}`;
}

function clean(value = '', max = 60) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizePool(raw) {
  const categories = {};
  const rawCategories = raw && typeof raw === 'object' && raw.categories && typeof raw.categories === 'object'
    ? raw.categories
    : {};
  for (const [key, val] of Object.entries(rawCategories)) {
    const cat = clean(key, 30);
    if (!cat) continue;
    const items = (Array.isArray(val?.items) ? val.items : [])
      .map((it) => ({
        name: clean(it?.name, 60),
        kind: it?.kind === 'shop' ? 'shop' : 'item',
        source: it?.source === 'amap' ? 'amap' : 'search',
        addedAt: Number(it?.addedAt) || Date.now(),
      }))
      .filter((it) => it.name)
      .slice(-MAX_ITEMS_PER_CATEGORY);
    if (items.length) categories[cat] = { items, updatedAt: Number(val?.updatedAt) || Date.now() };
  }
  return { categories };
}

export async function loadTastePool(userId, characterId) {
  const row = await db.get('settings', storeKey(userId, characterId)).catch(() => null);
  return normalizePool(row?.value);
}

async function persist(userId, characterId, pool) {
  await db.put('settings', { key: storeKey(userId, characterId), value: pool });
  return pool;
}

function totalItemCount(categories) {
  return Object.values(categories).reduce((sum, c) => sum + (Array.isArray(c?.items) ? c.items.length : 0), 0);
}

/** 总量超限时，从最旧的一条开始跨类目淘汰，直到回到上限内。 */
function enforceTotalCap(categories) {
  while (totalItemCount(categories) > MAX_TOTAL_ITEMS) {
    let oldestCat = null;
    let oldestTs = Infinity;
    for (const [key, val] of Object.entries(categories)) {
      const first = (val.items || [])[0];
      if (first && first.addedAt < oldestTs) {
        oldestTs = first.addedAt;
        oldestCat = key;
      }
    }
    if (!oldestCat) break;
    const items = categories[oldestCat].items.slice(1);
    if (items.length) {
      categories[oldestCat] = { ...categories[oldestCat], items };
    } else {
      delete categories[oldestCat];
    }
  }
  return categories;
}

/**
 * 往某个类目追加条目：与类目内已有条目同名的跳过（不重复），超出单类目/总量上限时淘汰最旧的。
 * @param names string[] 具体单品名或店名
 */
export async function appendTasteItems(userId, characterId, category, names = [], { kind = 'item', source = 'search' } = {}) {
  const cat = clean(category, 30);
  const list = (Array.isArray(names) ? names : []).map((n) => clean(n, 60)).filter(Boolean);
  if (!cat || !list.length) return null;
  const pool = await loadTastePool(userId, characterId);
  const categories = { ...pool.categories };
  const existing = categories[cat]?.items || [];
  const existingNames = new Set(existing.map((it) => it.name));
  const now = Date.now();
  const added = list.filter((n) => !existingNames.has(n)).map((n) => ({ name: n, kind, source, addedAt: now }));
  if (!added.length) return pool;
  categories[cat] = { items: [...existing, ...added].slice(-MAX_ITEMS_PER_CATEGORY), updatedAt: now };
  const next = { categories: enforceTotalCap(categories) };
  await persist(userId, characterId, next);
  return next;
}

/** 命中检测用：把整个池摊平成 [{category, name, kind, source}] 供关键词匹配。 */
export function flattenTastePool(pool) {
  const categories = pool?.categories || {};
  const rows = [];
  for (const [cat, val] of Object.entries(categories)) {
    for (const item of Array.isArray(val?.items) ? val.items : []) {
      rows.push({ category: cat, name: item.name, kind: item.kind, source: item.source });
    }
  }
  return rows;
}
