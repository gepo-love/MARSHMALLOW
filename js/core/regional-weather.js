import * as db from './db.js';

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

const memoryCache = new Map();

const CITY_COORDS = {
  北京: { name: '北京', latitude: 39.9042, longitude: 116.4074, country: '中国', timezone: 'Asia/Shanghai' },
  广州: { name: '广州', latitude: 23.1291, longitude: 113.2644, country: '中国', timezone: 'Asia/Shanghai' },
  杭州: { name: '杭州', latitude: 30.2741, longitude: 120.1551, country: '中国', timezone: 'Asia/Shanghai' },
  青岛: { name: '青岛', latitude: 36.0671, longitude: 120.3826, country: '中国', timezone: 'Asia/Shanghai' },
  昆明: { name: '昆明', latitude: 25.0389, longitude: 102.7183, country: '中国', timezone: 'Asia/Shanghai' },
  南京: { name: '南京', latitude: 32.0603, longitude: 118.7969, country: '中国', timezone: 'Asia/Shanghai' },
  西安: { name: '西安', latitude: 34.3416, longitude: 108.9398, country: '中国', timezone: 'Asia/Shanghai' },
  上海: { name: '上海', latitude: 31.2304, longitude: 121.4737, country: '中国', timezone: 'Asia/Shanghai' },
  苏州: { name: '苏州', latitude: 31.2989, longitude: 120.5853, country: '中国', timezone: 'Asia/Shanghai' },
  武汉: { name: '武汉', latitude: 30.5928, longitude: 114.3055, country: '中国', timezone: 'Asia/Shanghai' },
  天津: { name: '天津', latitude: 39.3434, longitude: 117.3616, country: '中国', timezone: 'Asia/Shanghai' },
  成都: { name: '成都', latitude: 30.5728, longitude: 104.0668, country: '中国', timezone: 'Asia/Shanghai' },
  绵阳: { name: '绵阳', latitude: 31.4675, longitude: 104.6796, country: '中国', timezone: 'Asia/Shanghai' },
};

const CITY_ALIASES = {
  b: '北京',
  bj: '北京',
  beijing: '北京',
  北京市: '北京',
  g: '广州',
  gz: '广州',
  guangzhou: '广州',
  广州市: '广州',
  h: '杭州',
  hz: '杭州',
  hangzhou: '杭州',
  杭州市: '杭州',
  q: '青岛',
  qd: '青岛',
  qingdao: '青岛',
  青岛市: '青岛',
  k: '昆明',
  km: '昆明',
  kunming: '昆明',
  昆明市: '昆明',
  n: '南京',
  nj: '南京',
  nanjing: '南京',
  南京市: '南京',
  x: '西安',
  xa: '西安',
  xian: '西安',
  "xi'an": '西安',
  西安市: '西安',
  s: '上海',
  sh: '上海',
  shanghai: '上海',
  上海市: '上海',
  sz: '苏州',
  suzhou: '苏州',
  苏州市: '苏州',
  wh: '武汉',
  wuhan: '武汉',
  武汉市: '武汉',
  tj: '天津',
  tianjin: '天津',
  天津市: '天津',
  cd: '成都',
  chengdu: '成都',
  成都市: '成都',
  my: '绵阳',
  mianyang: '绵阳',
  绵阳市: '绵阳',
};

const LETTER_CITY = {
  B: '北京',
  G: '广州',
  H: '杭州',
  Q: '青岛',
  K: '昆明',
  N: '南京',
  X: '西安',
  S: '上海',
  M: '绵阳',
};

const CLIMATE_FALLBACK = {
  北京: '北方城市，换季明显，春秋风大偏干，冬天冷且干，夏天日晒强。',
  广州: '华南湿热，回南天、阵雨、台风雨和空调房温差都很常见。',
  杭州: '江南潮湿，下雨、梅雨、闷热和湿冷都容易影响体感。',
  青岛: '沿海城市，海风、潮气、早晚温差和夜里凉意很明显。',
  昆明: '春城体感，日晒明显，天气常较舒服但早晚温差大。',
  南京: '夏天闷热，梅雨明显，冬天湿冷，梧桐和老城通勤感很强。',
  西安: '西北内陆体感，天气偏干，风硬，昼夜温差和碳水日常都很明显。',
  上海: '沿海大城市体感，潮湿、下雨、通勤和商圈室内外温差常见。',
  苏州: '江南湿润，梅雨、河道水汽、湿冷和精细的季节感明显。',
  武汉: '夏天闷热，冬天湿冷，过早、江边和突然变天都很有存在感。',
  天津: '北方沿海，风大、干冷和海河边的温差都适合轻量入话。',
  成都: '盆地体感，阴天和湿闷较常见，出门吃喝和夜生活容易带出天气。',
  绵阳: '川北城市，湿润、阴雨和川系生活节奏可以作为轻背景。',
};

function clean(value = '') {
  return String(value ?? '').trim();
}

function normalizeAliasKey(value = '') {
  return clean(value).toLowerCase().replace(/\s+/g, '').replace(/市$/u, '');
}

function cacheKey(type, key) {
  return `regionalWeather:${type}:${clean(key)}`;
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : FETCH_TIMEOUT_MS;
  if (typeof AbortController === 'undefined' || timeoutMs <= 0) return fetch(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readCache(key) {
  const mem = memoryCache.get(key);
  if (mem && Date.now() - Number(mem.savedAt || 0) < CACHE_MS) return mem.value;
  if (typeof indexedDB === 'undefined') return null;
  // 天气是可重建缓存，不进入原生业务主库写队列。兼容读取旧记录，命中后
  // 会在下次刷新时自然迁到 cache-only 设置。
  const row = await db.getCacheOnlySetting(key).catch(() => null)
    || await db.get('settings', key).catch(() => null);
  if (!row?.value) return null;
  if (Date.now() - Number(row.value.savedAt || 0) > CACHE_MS) return null;
  memoryCache.set(key, row.value);
  return row.value.value;
}

async function writeCache(key, value) {
  const wrapped = { savedAt: Date.now(), value };
  memoryCache.set(key, wrapped);
  if (typeof indexedDB !== 'undefined') {
    await db.putCacheOnlySetting(key, wrapped).catch(() => {});
  }
  return value;
}

export function normalizeCityInput(input = '') {
  const raw = clean(input);
  if (!raw) return '';
  const bracket = raw.match(/[（(]([^）)]+)[）)]/u);
  if (bracket?.[1]) return normalizeCityInput(bracket[1]);
  const letter = raw.match(/^([A-Z])市$/i);
  if (letter) return LETTER_CITY[letter[1].toUpperCase()] || raw;
  const key = normalizeAliasKey(raw);
  return CITY_ALIASES[key] || CITY_ALIASES[raw] || raw.replace(/市$/u, '');
}

function weatherCodeText(code) {
  const c = Number(code);
  if (c === 0) return '晴';
  if ([1, 2].includes(c)) return '少云';
  if (c === 3) return '阴';
  if ([45, 48].includes(c)) return '雾';
  if ([51, 53, 55, 56, 57].includes(c)) return '毛毛雨';
  if ([61, 63, 65, 66, 67].includes(c)) return '下雨';
  if ([71, 73, 75, 77].includes(c)) return '下雪';
  if ([80, 81, 82].includes(c)) return '阵雨';
  if ([85, 86].includes(c)) return '阵雪';
  if ([95, 96, 99].includes(c)) return '雷阵雨';
  return '天气变化不明';
}

function windDirectionText(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return '';
  const dirs = ['北风', '东北风', '东风', '东南风', '南风', '西南风', '西风', '西北风'];
  return dirs[Math.round((((n % 360) + 360) % 360) / 45) % 8];
}

function seasonalFallback(city = '', date = new Date()) {
  const c = normalizeCityInput(city);
  const month = date instanceof Date && Number.isFinite(date.getTime()) ? date.getMonth() + 1 : new Date().getMonth() + 1;
  const season = month <= 2 || month === 12 ? '冬季'
    : month <= 5 ? '春季'
      : month <= 8 ? '夏季'
        : '秋季';
  return {
    city: c,
    source: 'seasonal-fallback',
    summary: `${season}常见体感`,
    lifeIndexLines: [`生活指数按${season}常识低置信处理，不当作实时数据`],
    promptLine: `${c || '当地'}：未取到实时天气，按${season}城市气候处理；${CLIMATE_FALLBACK[c] || '只把天气当轻背景，不要编造成具体实时数据。'}`,
    displayLine: `${c || '当地'} · ${season}常见体感`,
    fetchedAt: Date.now(),
  };
}

function deriveLifeIndexLines({ condition = '', temp = NaN, feels = NaN, humidity = NaN, wind = NaN, rainProb = NaN, cloud = NaN, precip = NaN } = {}) {
  const lines = [];
  const wet = Number.isFinite(rainProb) && rainProb >= 45 || Number.isFinite(precip) && precip > 0 || /雨|雪|雾/u.test(condition);
  const hot = Number.isFinite(feels) ? feels >= 30 : Number.isFinite(temp) && temp >= 30;
  const cold = Number.isFinite(feels) ? feels <= 8 : Number.isFinite(temp) && temp <= 8;
  const windy = Number.isFinite(wind) && wind >= 22;
  const humid = Number.isFinite(humidity) && humidity >= 75;
  const sunny = /晴|少云/u.test(condition) && (!Number.isFinite(cloud) || cloud <= 45);
  if (wet) lines.push('出门带伞，路面湿滑');
  if (sunny || hot) lines.push(hot ? '防晒和补水优先' : '日晒明显，适合轻防晒');
  if (cold) lines.push('体感偏冷，外套别省');
  if (windy) lines.push('风感明显，骑车/户外要留意');
  if (humid && hot) lines.push('湿热闷，运动强度别太满');
  else if (!wet && !hot && !cold) lines.push('适合散步或短时户外');
  if (!wet && Number.isFinite(humidity) && humidity < 70) lines.push('衣物较容易晾干');
  if (wet || windy || hot || cold) lines.push('通勤体感可能受天气影响');
  return lines.slice(0, 5);
}

function buildDisplayLine({ cityName = '', condition = '', temp = NaN, feels = NaN } = {}) {
  const bits = [cityName, condition].filter(Boolean);
  if (Number.isFinite(feels)) bits.push(`体感${feels.toFixed(0)}°C`);
  else if (Number.isFinite(temp)) bits.push(`${temp.toFixed(0)}°C`);
  return bits.join(' · ');
}

export async function resolveCityInput(input = '', options = {}) {
  const normalized = normalizeCityInput(input);
  if (!normalized) return null;
  if (CITY_COORDS[normalized]) return CITY_COORDS[normalized];
  if (options.allowNetwork === false || typeof fetch !== 'function') return null;

  const key = cacheKey('geo', normalized.toLowerCase());
  const cached = await readCache(key);
  if (cached) return cached;

  const url = new URL(GEOCODING_URL);
  url.searchParams.set('name', normalized);
  url.searchParams.set('count', '5');
  url.searchParams.set('language', 'zh');
  url.searchParams.set('format', 'json');
  const countryCode = options.countryCode === undefined ? '' : clean(options.countryCode).toUpperCase();
  if (countryCode) url.searchParams.set('countryCode', countryCode);

  const res = await fetchWithTimeout(url.toString(), options);
  if (!res.ok) throw new Error(`城市匹配失败：${res.status}`);
  const data = await res.json();
  const first = Array.isArray(data?.results) ? data.results[0] : null;
  if (!first) return null;
  const city = {
    name: clean(first.name || normalized),
    latitude: Number(first.latitude),
    longitude: Number(first.longitude),
    country: clean(first.country || ''),
    admin1: clean(first.admin1 || ''),
    timezone: clean(first.timezone || 'Asia/Shanghai'),
  };
  if (!Number.isFinite(city.latitude) || !Number.isFinite(city.longitude)) return null;
  return writeCache(key, city);
}

export async function getRegionalWeatherByCity(cityInput = '', options = {}) {
  const cityName = normalizeCityInput(cityInput);
  if (!cityName) return null;
  const date = options.date instanceof Date ? options.date : new Date(options.date || Date.now());
  const key = cacheKey('weather', cityName);
  const cached = await readCache(key);
  if (cached) return cached;
  // 聊天提示词只读已经存在的天气快照，不能为了实时天气在发送主请求前
  // 同步等待地理编码和天气网络超时。cacheOnly 仍会复用新鲜缓存；未命中时
  // 返回低置信季节背景，天气页等显式入口继续负责联网刷新缓存。
  if (options.cacheOnly === true || options.allowNetwork === false || typeof fetch !== 'function') {
    return seasonalFallback(cityName, date);
  }

  try {
    const city = await resolveCityInput(cityName, options);
    if (!city) return seasonalFallback(cityName, date);
    const url = new URL(FORECAST_URL);
    url.searchParams.set('latitude', String(city.latitude));
    url.searchParams.set('longitude', String(city.longitude));
    url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m');
    url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
    url.searchParams.set('forecast_days', '1');
    url.searchParams.set('timezone', 'auto');
    const res = await fetchWithTimeout(url.toString(), options);
    if (!res.ok) throw new Error(`天气获取失败：${res.status}`);
    const data = await res.json();
    const cur = data?.current || {};
    const daily = data?.daily || {};
    const temp = Number(cur.temperature_2m);
    const feels = Number(cur.apparent_temperature);
    const humidity = Number(cur.relative_humidity_2m);
    const wind = Number(cur.wind_speed_10m);
    const precip = Number(cur.precipitation);
    const cloud = Number(cur.cloud_cover);
    const condition = weatherCodeText(cur.weather_code);
    const windDir = windDirectionText(cur.wind_direction_10m);
    const dailyMax = Number(Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : NaN);
    const dailyMin = Number(Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : NaN);
    const rainProb = Number(Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max[0] : NaN);
    const details = [
      Number.isFinite(temp) ? `${temp.toFixed(0)}°C` : '',
      Number.isFinite(feels) ? `体感${feels.toFixed(0)}°C` : '',
      Number.isFinite(humidity) ? `湿度${humidity}%` : '',
      Number.isFinite(wind) ? `${windDir || '风'}${wind.toFixed(0)}km/h` : '',
      Number.isFinite(precip) && precip > 0 ? `近一小时降水${precip}mm` : '',
      Number.isFinite(rainProb) ? `今日降水概率${rainProb}%` : '',
      Number.isFinite(dailyMax) && Number.isFinite(dailyMin) ? `日温${dailyMin.toFixed(0)}-${dailyMax.toFixed(0)}°C` : '',
      Number.isFinite(cloud) ? `云量${cloud}%` : '',
    ].filter(Boolean);
    const lifeIndexLines = deriveLifeIndexLines({ condition, temp, feels, humidity, wind, rainProb, cloud, precip });
    const label = city.name || cityName;
    const promptLine = `${label}：实时天气${condition}${details.length ? `，${details.join('，')}` : ''}。天气只作生活背景；提到出门、穿着、体感、窗外或冷场转场时再自然带一笔。`;
    const displayLine = buildDisplayLine({ cityName: label, condition, temp, feels });
    const weather = {
      city: label,
      source: 'open-meteo',
      condition,
      temperature: Number.isFinite(temp) ? temp : null,
      apparentTemperature: Number.isFinite(feels) ? feels : null,
      humidity: Number.isFinite(humidity) ? humidity : null,
      precipitation: Number.isFinite(precip) ? precip : null,
      windSpeed: Number.isFinite(wind) ? wind : null,
      windDirection: windDir,
      cloudCover: Number.isFinite(cloud) ? cloud : null,
      lifeIndexLines,
      promptLine,
      displayLine,
      fetchedAt: Date.now(),
    };
    return writeCache(key, weather);
  } catch (_) {
    return seasonalFallback(cityName, date);
  }
}
