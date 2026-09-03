/**
 * 线下关键词辅助攻略：用户主动点一次才触发的一次性检索（不进多轮 agent 循环），
 * 降低"角色出行目的性不够强、后台瞎编"的问题。写法参考 travel-char.js 的 resolveRoute() / collectTravelSearchMaterial()。
 */
import { amapExploreFromSeed, buildAmapStaticMapUrl, loadAmapConfig } from './amap-tools.js';
import { loadWebSearchConfig, runWebSearch } from './web-search-tools.js';

function clip(text = '', max = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function searchOfflinePlaceKeywords({ query, city = '' } = {}) {
  const cfg = await loadWebSearchConfig().catch(() => null);
  if (!cfg?.enabled) return '';
  const q = clip(query, 100);
  if (!q) return '';
  try {
    const result = await runWebSearch(q, { category: 'offline_date', maxResults: 5, searchDepth: 'basic', config: cfg });
    if (!result) return '';
    const rows = (Array.isArray(result.results) ? result.results : []).slice(0, 4)
      .map((item) => clip([item.title, item.content].filter(Boolean).join('：'), 200))
      .filter(Boolean);
    return clip([
      `搜索：${q}`,
      result.summary ? `摘要：${result.summary}` : '',
      rows.length ? rows.join('\n') : '',
    ].filter(Boolean).join('\n'), 900);
  } catch (err) {
    console.warn('[offline-place-material] web search failed', err);
    return '';
  }
}

/**
 * 一次性查地点攻略：有地点/关键词锚点时查高德附近候选；有关键词时额外查一次通用搜索。
 * @returns {Promise<{ material: string, mapImage: string, candidates: Array }>}
 */
export async function collectOfflinePlaceMaterial({ place = '', activity = '', keywords = '', city = '' } = {}) {
  const parts = [];
  let mapImage = '';
  let candidates = [];
  const anchorSeed = clip(place || keywords || activity, 80);

  const amapCfg = await loadAmapConfig().catch(() => null);
  if (amapCfg?.enabled && amapCfg?.apiKey && anchorSeed) {
    try {
      const explored = await amapExploreFromSeed({
        keywords: anchorSeed,
        city,
        maxResults: Math.max(4, Math.min(8, Number(amapCfg.maxResults || 6) || 6)),
      }, { config: amapCfg });
      const pois = Array.isArray(explored?.pois) ? explored.pois : [];
      candidates = pois.slice(0, 6)
        .map((poi) => ({
          id: String(poi?.id || ''),
          name: String(poi?.name || '').trim(),
          address: String(poi?.address || '').trim(),
          district: String(poi?.district || '').trim(),
          location: String(poi?.location || '').trim(),
        }))
        .filter((c) => c.name);
      if (candidates.length) {
        parts.push(`附近候选地点：${candidates.map((c) => [c.name, c.address].filter(Boolean).join(' - ')).join('；')}`);
        mapImage = buildAmapStaticMapUrl({
          key: amapCfg.apiKey,
          center: explored.center || candidates.find((c) => c.location)?.location || '',
          markers: candidates
            .filter((c) => c.location)
            .map((c, idx) => ({ label: String(idx + 1), location: c.location })),
        });
      }
    } catch (err) {
      console.warn('[offline-place-material] amap explore failed', err);
    }
  }

  const searchQuery = clip([keywords, place, activity].filter(Boolean).join(' '), 100);
  if (searchQuery) {
    const searchText = await searchOfflinePlaceKeywords({ query: searchQuery, city });
    if (searchText) parts.push(searchText);
  }

  return { material: parts.join('\n\n'), mapImage, candidates };
}
