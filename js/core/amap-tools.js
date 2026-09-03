import * as db from './db.js';

export const AMAP_CONFIG_KEY = 'amapWebServiceConfig';

export const DEFAULT_AMAP_CONFIG = {
  enabled: false,
  apiKey: '',
  jsApiKey: '',
  securityJsCode: '',
  jsMapEnabled: true,
  maxResults: 6,
  radius: 1500,
  autoGrowEnabled: true,
  autoGrowCooldownHours: 12,
  autoGrowDailyLimit: 20,
};

const POI_BUCKET_ORDER = ['food', 'shopping', 'commute', 'leisure', 'service', 'other'];

function mergeConfig(value = {}) {
  return {
    ...DEFAULT_AMAP_CONFIG,
    ...(value || {}),
    jsMapEnabled: value?.jsMapEnabled !== false,
    maxResults: Math.max(1, Math.min(20, Number(value?.maxResults || DEFAULT_AMAP_CONFIG.maxResults) || DEFAULT_AMAP_CONFIG.maxResults)),
    radius: Math.max(100, Math.min(50000, Number(value?.radius || DEFAULT_AMAP_CONFIG.radius) || DEFAULT_AMAP_CONFIG.radius)),
    autoGrowEnabled: value?.autoGrowEnabled !== false,
    autoGrowCooldownHours: Math.max(1, Math.min(168, Number(value?.autoGrowCooldownHours || DEFAULT_AMAP_CONFIG.autoGrowCooldownHours) || DEFAULT_AMAP_CONFIG.autoGrowCooldownHours)),
    autoGrowDailyLimit: Math.max(0, Math.min(500, Number(value?.autoGrowDailyLimit ?? DEFAULT_AMAP_CONFIG.autoGrowDailyLimit) || DEFAULT_AMAP_CONFIG.autoGrowDailyLimit)),
  };
}

export async function loadAmapConfig() {
  const row = await db.get('settings', AMAP_CONFIG_KEY);
  return mergeConfig(row?.value || {});
}

export async function saveAmapConfig(config = {}) {
  const next = mergeConfig(config);
  await db.put('settings', { key: AMAP_CONFIG_KEY, value: next });
  return next;
}

export function isAmapLocation(value = '') {
  return /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(String(value || '').trim());
}

function parseAmapPoint(value = '') {
  const text = String(value || '').trim();
  if (!isAmapLocation(text)) return null;
  const [lng, lat] = text.split(',').map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat, text };
}

export function parseAmapLocation(value = '') {
  return parseAmapPoint(value);
}

export function averageAmapLocation(locations = []) {
  const points = (Array.isArray(locations) ? locations : [])
    .map(parseAmapPoint)
    .filter(Boolean);
  if (!points.length) return '';
  const lng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  return `${lng.toFixed(6)},${lat.toFixed(6)}`;
}

function markerColor(index = 0) {
  return ['0x3a7cff', '0xff6b35', '0x22a06b', '0xd946ef', '0x0891b2', '0xf59e0b'][index % 6];
}

export function buildAmapStaticMapUrl({ key, center = '', zoom = 15, size = '520*210', markers = [], labels = [], paths = [], traffic = false } = {}) {
  const apiKey = String(key || '').trim();
  if (!apiKey) return '';
  const params = {
    key: apiKey,
    size,
    zoom: Math.max(3, Math.min(18, Number(zoom || 15) || 15)),
    scale: 2,
  };
  if (center && isAmapLocation(center)) params.location = center;
  if (traffic) params.traffic = 1;
  const cleanMarkers = (Array.isArray(markers) ? markers : [])
    .filter((item) => isAmapLocation(item?.location))
    .slice(0, 8)
    .map((item, idx) => {
      const label = String(item.label || idx + 1).trim().slice(0, 2);
      return `mid,${markerColor(idx)},${label}:${item.location}`;
    });
  if (cleanMarkers.length) params.markers = cleanMarkers.join('|');
  const cleanLabels = (Array.isArray(labels) ? labels : [])
    .filter((item) => isAmapLocation(item?.location) && item.text)
    .slice(0, 6)
    .map((item) => `${String(item.text).slice(0, 10)},2,0,16,0x333333,0xFFFFFF:${item.location}`);
  if (cleanLabels.length) params.labels = cleanLabels.join('|');
  const cleanPaths = (Array.isArray(paths) ? paths : [])
    .map((path) => (Array.isArray(path) ? path : path?.points))
    .map((path) => (Array.isArray(path) ? path.filter(isAmapLocation).slice(0, 20) : []))
    .filter((path) => path.length >= 2)
    .map((path) => `5,0x3a7cff,0.75,,,:${path.join(';')}`);
  if (cleanPaths.length) params.paths = cleanPaths.join('|');
  return buildUrl('/v3/staticmap', params);
}

function clip(value = '', max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function asText(value) {
  if (Array.isArray(value)) return '';
  return clip(value, 220);
}

function normalizeRoute(path = {}, fallback = {}) {
  const steps = Array.isArray(path.steps) ? path.steps : [];
  const firstPolyline = steps
    .flatMap((step) => String(step.polyline || '').split(';'))
    .filter(isAmapLocation)
    .slice(0, 20);
  return {
    mode: fallback.mode || '',
    origin: fallback.origin || '',
    destination: fallback.destination || '',
    originLocation: fallback.originLocation || '',
    destinationLocation: fallback.destinationLocation || '',
    distance: Number(path.distance || 0) || 0,
    duration: Number(path.duration || 0) || 0,
    taxiCost: asText(path.taxi_cost || path.cost?.taxi_cost, 20),
    strategy: fallback.strategy || '',
    summary: asText(path.strategy || path.instruction || fallback.summary || '', 120),
    polyline: firstPolyline,
    steps: steps.slice(0, 8).map((step) => ({
      instruction: asText(step.instruction, 120),
      road: asText(step.road, 60),
      distance: Number(step.distance || 0) || 0,
      duration: Number(step.duration || 0) || 0,
    })),
  };
}

export function bucketPoiCategory(poi = {}) {
  const text = [
    poi.type,
    poi.typecode,
    poi.name,
    poi.address,
    poi.businessArea,
  ].join(' ');
  if (/(餐饮|美食|餐厅|饭店|快餐|小吃|咖啡|茶馆|甜品|面馆|火锅|烧烤|酒吧|饮品|夜宵|食堂|便利店)/u.test(text)) return 'food';
  if (/(购物|商场|超市|市场|百货|书店|数码|电子|服饰|鞋|电器|专卖店|文具|珠宝)/u.test(text)) return 'shopping';
  if (/(地铁|公交|车站|机场|停车|加油|火车站|汽车站|磁浮)/u.test(text)) return 'commute';
  if (/(公园|景点|博物馆|美术馆|电影院|剧场|体育|健身|运动|KTV|游乐|展览)/u.test(text)) return 'leisure';
  if (/(医院|药店|银行|邮局|打印|洗衣|维修|美容|社区|服务)/u.test(text)) return 'service';
  return 'other';
}

export function bucketPoiLabel(bucket) {
  const key = String(bucket || 'other').trim();
  return {
    food: '吃喝',
    shopping: '购物',
    commute: '通勤',
    leisure: '休闲',
    service: '生活服务',
    other: '其他',
  }[key] || '其他';
}

export function groupPoisByBucket(pois = []) {
  const groups = {};
  for (const poi of Array.isArray(pois) ? pois : []) {
    const bucket = bucketPoiCategory(poi);
    if (!groups[bucket]) groups[bucket] = [];
    groups[bucket].push(poi);
  }
  return groups;
}

export function normalizeAmapPois(payload = {}) {
  const raw = Array.isArray(payload.pois)
    ? payload.pois
    : Array.isArray(payload.pois?.poi)
      ? payload.pois.poi
      : [];
  return raw.map((poi) => {
    const photos = Array.isArray(poi.photos) ? poi.photos : [];
    const photo = photos.find((item) => item?.url)?.url || '';
    const bucket = bucketPoiCategory({
      type: poi.type,
      typecode: poi.typecode,
      name: poi.name,
      address: poi.address,
      businessArea: poi.business_area,
    });
    return {
      id: asText(poi.id),
      name: asText(poi.name, 80),
      type: asText(poi.type, 120),
      typecode: asText(poi.typecode, 20),
      location: asText(poi.location, 40),
      city: asText(poi.cityname || poi.city, 40),
      district: asText(poi.adname, 40),
      address: asText(poi.address, 120),
      businessArea: asText(poi.business_area, 60),
      distance: Number(poi.distance || 0) || null,
      rating: asText(poi.biz_ext?.rating, 20),
      cost: asText(poi.biz_ext?.cost, 20),
      photo,
      bucket,
      bucketLabel: bucketPoiLabel(bucket),
    };
  }).filter((poi) => poi.name && poi.location);
}

function buildUrl(path, params) {
  const url = new URL(path, 'https://restapi.amap.com');
  for (const [key, value] of Object.entries(params || {})) {
    const text = String(value ?? '').trim();
    if (text) url.searchParams.set(key, text);
  }
  return url.toString();
}

let amapJsApiPromise = null;

export function getAmapJsApiKey(config = {}) {
  return String(config?.jsApiKey || config?.apiKey || '').trim();
}

export function loadAmapJsApi(config = {}, plugins = ['AMap.Scale', 'AMap.ToolBar']) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('当前环境不支持高德 JS 地图'));
  }
  if (window.AMap?.Map) return Promise.resolve(window.AMap);
  if (amapJsApiPromise) return amapJsApiPromise;
  const key = getAmapJsApiKey(config);
  if (!key) return Promise.reject(new Error('缺少高德 JS API Key'));
  const securityJsCode = String(config?.securityJsCode || '').trim();
  if (securityJsCode) {
    window._AMapSecurityConfig = {
      ...(window._AMapSecurityConfig || {}),
      securityJsCode,
    };
  }
  const url = new URL('https://webapi.amap.com/maps');
  url.searchParams.set('v', '2.0');
  url.searchParams.set('key', key);
  const cleanPlugins = Array.isArray(plugins) ? plugins.map((item) => String(item || '').trim()).filter(Boolean) : [];
  if (cleanPlugins.length) url.searchParams.set('plugin', cleanPlugins.join(','));
  amapJsApiPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const cleanup = () => {
      script.onerror = null;
      script.onload = null;
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('高德 JS 地图加载超时'));
    }, 12000);
    script.onload = () => {
      clearTimeout(timer);
      cleanup();
      if (window.AMap?.Map) resolve(window.AMap);
      else reject(new Error('高德 JS 地图初始化失败'));
    };
    script.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('高德 JS 地图加载失败'));
    };
    script.src = url.toString();
    script.async = true;
    document.head.appendChild(script);
  }).catch((err) => {
    amapJsApiPromise = null;
    throw err;
  });
  return amapJsApiPromise;
}

function fetchJsonp(url) {
  if (typeof document === 'undefined') throw new Error('当前环境不支持 JSONP');
  const callbackName = `__amap_cb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const src = new URL(url);
  src.searchParams.set('output', 'JSON');
  src.searchParams.set('callback', callbackName);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const cleanup = () => {
      delete globalThis[callbackName];
      script.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('高德地图请求超时'));
    }, 12000);
    globalThis[callbackName] = (payload) => {
      clearTimeout(timer);
      cleanup();
      resolve(payload);
    };
    script.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('高德地图请求失败'));
    };
    script.src = src.toString();
    document.head.appendChild(script);
  });
}

async function requestAmap(path, params, options = {}) {
  const cfg = { ...(await loadAmapConfig()), ...(options.config || {}) };
  if (!cfg.enabled && !options.force) throw new Error('高德地图未启用');
  if (!cfg.apiKey) throw new Error('缺少高德 Web服务 Key');
  const url = buildUrl(path, {
    ...params,
    key: cfg.apiKey,
    output: 'JSON',
  });
  let payload;
  try {
    const res = await fetch(url, { signal: options.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    payload = await fetchJsonp(url).catch(() => {
      throw err;
    });
  }
  if (String(payload?.status || '') !== '1') {
    throw new Error(`高德地图请求失败：${payload?.info || payload?.infocode || 'unknown'}`);
  }
  return payload;
}

export async function amapTextSearch({ keywords, city = '', cityLimit = true, maxResults, extensions = 'all' } = {}, options = {}) {
  const cfg = { ...(await loadAmapConfig()), ...(options.config || {}) };
  const query = clip(keywords, 80);
  if (!query) throw new Error('缺少地图搜索关键词');
  const payload = await requestAmap('/v3/place/text', {
    keywords: query,
    city,
    citylimit: cityLimit ? 'true' : 'false',
    offset: Math.max(1, Math.min(25, Number(maxResults || cfg.maxResults) || cfg.maxResults)),
    page: 1,
    extensions,
  }, { ...options, config: cfg });
  return {
    source: 'amap_text',
    query,
    city,
    total: Number(payload.count || 0) || 0,
    pois: normalizeAmapPois(payload),
    createdAt: Date.now(),
  };
}

export async function amapV5AroundSearch({ location, keywords = '', types = '', city = '', radius, maxResults, showFields = 'business,photos' } = {}, options = {}) {
  const cfg = { ...(await loadAmapConfig()), ...(options.config || {}) };
  const loc = clip(location, 40);
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(loc)) throw new Error('缺少有效中心点坐标');
  const payload = await requestAmap('/v5/place/around', {
    location: loc,
    keywords: clip(keywords, 80),
    types: clip(types, 80),
    city,
    radius: Math.max(100, Math.min(50000, Number(radius || cfg.radius) || cfg.radius)),
    sortrule: 'distance',
    page_size: Math.max(1, Math.min(25, Number(maxResults || cfg.maxResults) || cfg.maxResults)),
    page_num: 1,
    show_fields: showFields,
  }, { ...options, config: cfg });
  return {
    source: 'amap_v5_around',
    query: clip(keywords, 80),
    types: clip(types, 80),
    city,
    center: loc,
    total: Number(payload.count || 0) || 0,
    pois: normalizeAmapPois(payload),
    createdAt: Date.now(),
  };
}

export async function amapAroundSearch({ location, keywords = '', city = '', radius, maxResults, extensions = 'all' } = {}, options = {}) {
  const cfg = { ...(await loadAmapConfig()), ...(options.config || {}) };
  const loc = clip(location, 40);
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(loc)) throw new Error('缺少有效中心点坐标');
  const payload = await requestAmap('/v3/place/around', {
    location: loc,
    keywords: clip(keywords, 80),
    city,
    radius: Math.max(100, Math.min(50000, Number(radius || cfg.radius) || cfg.radius)),
    sortrule: 'distance',
    offset: Math.max(1, Math.min(25, Number(maxResults || cfg.maxResults) || cfg.maxResults)),
    page: 1,
    extensions,
  }, { ...options, config: cfg });
  return {
    source: 'amap_around',
    query: clip(keywords, 80),
    city,
    center: loc,
    total: Number(payload.count || 0) || 0,
    pois: normalizeAmapPois(payload),
    createdAt: Date.now(),
  };
}

export async function amapRoutePlan({ origin, destination, mode = 'walk', city = '', strategy = '' } = {}, options = {}) {
  const cfg = { ...(await loadAmapConfig()), ...(options.config || {}) };
  const from = clip(origin, 40);
  const to = clip(destination, 40);
  if (!isAmapLocation(from) || !isAmapLocation(to)) throw new Error('缺少有效路线起终点坐标');
  const routeMode = ['walk', 'bike', 'transit', 'drive'].includes(String(mode || '').trim()) ? String(mode || '').trim() : 'walk';
  const path = routeMode === 'drive'
    ? '/v3/direction/driving'
    : routeMode === 'transit'
      ? '/v3/direction/transit/integrated'
      : routeMode === 'bike'
        ? '/v4/direction/bicycling'
        : '/v3/direction/walking';
  const payload = await requestAmap(path, {
    ...(routeMode === 'bike'
      ? { origin: from, destination: to }
      : { origin: from, destination: to }),
    city,
    strategy: clip(strategy, 20),
  }, { ...options, config: cfg });
  const route = payload.route || payload.data || {};
  const pathList = Array.isArray(route.paths)
    ? route.paths
    : Array.isArray(route.transits)
      ? route.transits
      : Array.isArray(route.rides)
        ? route.rides
      : Array.isArray(payload.data?.paths)
        ? payload.data.paths
        : [];
  const best = pathList[0] || {};
  return {
    source: `amap_route_${routeMode}`,
    mode: routeMode,
    origin: from,
    destination: to,
    city,
    route: normalizeRoute(best, {
      mode: routeMode,
      originLocation: from,
      destinationLocation: to,
      strategy,
    }),
    createdAt: Date.now(),
  };
}

function dedupePois(list = []) {
  const seen = new Set();
  const out = [];
  for (const poi of Array.isArray(list) ? list : []) {
    const key = String(poi?.id || `${poi?.name || ''}|${poi?.location || ''}`).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(poi);
  }
  return out;
}

// 每个大类目只留一条检索词，跟 bucketPoiCategory 的桶一一对应：
// 「咖啡」「便利店」本身也会被 bucketPoiCategory 归进 food 桶，
// 旧版同时搜"餐饮+咖啡+便利店"三条 food 系检索词，等于把 food 桶的密度硬拉高到其它桶的 3 倍，
// 这正是"附近搜索出来一排咖啡店"的根因——不是咖啡店真的多，是这套默认词表本来就三倍权重在搜它。
const DEFAULT_EXPLORE_NEARBY_QUERIES = [
  { keywords: '餐饮', types: '050000' },
  { keywords: '购物 书店', types: '060000' },
  { keywords: '地铁站 公交站', types: '150500' },
  { keywords: '公园 景点 展览', types: '110000' },
  { keywords: '医院 银行 生活服务', types: '' },
];

export async function amapExploreFromSeed({ keywords, city = '', radius, maxResults, nearbyQueries } = {}, options = {}) {
  const cfg = { ...(await loadAmapConfig()), ...(options.config || {}) };
  const query = clip(keywords, 80);
  if (!query) throw new Error('缺少地图搜索关键词');
  const anchor = await amapTextSearch({
    keywords: query,
    city,
    cityLimit: !!city,
    maxResults: Math.max(4, Math.min(8, Number(maxResults || cfg.maxResults) || cfg.maxResults)),
  }, { ...options, config: cfg });
  const anchorPoi = anchor.pois[0] || null;
  if (!anchorPoi?.location) {
    return {
      ...anchor,
      source: 'amap_explore',
      anchor: anchorPoi,
      groups: groupPoisByBucket(anchor.pois),
    };
  }
  // 近邻类目搜索必须能按业务场景定制（如"喝咖啡"只搜咖啡厅），
  // 否则默认这套通用类目会把任意餐饮都当作候选，导致主题和结果毫不相干。
  const effectiveQueries = Array.isArray(nearbyQueries) && nearbyQueries.length
    ? nearbyQueries.slice(0, 8)
    : DEFAULT_EXPLORE_NEARBY_QUERIES;
  const aroundList = await Promise.all(
    effectiveQueries.map((nearby, queryGroup) => amapV5AroundSearch({
      location: anchorPoi.location,
      keywords: nearby.keywords,
      types: nearby.types,
      city,
      radius,
      maxResults: Math.max(4, Math.min(8, Number(maxResults || cfg.maxResults) || cfg.maxResults)),
    }, { ...options, config: cfg })
      // queryGroup 标记这条 POI 是哪一条近邻检索词搜出来的，供调用方做"每条检索词最多选 1 站"
      // 这类跨来源轮转，不然某条检索词（常见的是餐饮/咖啡）密度天然更高，会把结果挤成同质的一排。
      .then((res) => (Array.isArray(res?.pois) ? res.pois.map((poi) => ({ ...poi, queryGroup })) : []))
      .catch(() => []))
  );
  const merged = dedupePois([
    ...aroundList.flat(),
    ...anchor.pois.slice(0, 2).map((poi) => ({ ...poi, queryGroup: -1 })),
  ]);
  return {
    source: 'amap_explore',
    query,
    city,
    anchor: anchorPoi,
    center: anchorPoi.location,
    total: merged.length,
    pois: merged,
    groups: groupPoisByBucket(merged),
    createdAt: Date.now(),
  };
}
