import { getRegionalWeatherByCity, normalizeCityInput } from './regional-weather.js';

export function getEffectiveWeatherCityForUser(user = {}) {
  const virtualCity = String(user?.virtualCity || '').trim();
  const realCityMap = String(user?.realCityMap || '').trim();
  const weatherCity = normalizeCityInput(realCityMap || virtualCity);
  return {
    virtualCity,
    realCityMap,
    weatherCity,
    source: realCityMap ? '映射现实城市' : virtualCity ? '所在城市' : '',
  };
}

export function getEffectiveWeatherCityForCharacter(character = {}) {
  const anchor = character?.residenceAnchor && typeof character.residenceAnchor === 'object'
    ? character.residenceAnchor
    : {};
  const profile = character?.locationProfile && typeof character.locationProfile === 'object'
    ? character.locationProfile
    : {};
  const profileCity = typeof profile.city === 'object'
    ? String(profile.city?.name || '').trim()
    : String(profile.city || '').trim();
  const virtualCity = String(anchor.city || profileCity || '').trim();
  const realCityMap = String(anchor.realCityMap || '').trim();
  const weatherCity = normalizeCityInput(realCityMap || profileCity || virtualCity);
  return {
    virtualCity,
    realCityMap,
    weatherCity,
    source: realCityMap ? '映射现实城市' : virtualCity ? '所在城市' : '',
  };
}

export function formatWeatherLifeIndex(weather = {}) {
  if (!weather || weather.source === 'seasonal-fallback') return '';
  const lines = Array.isArray(weather.lifeIndexLines) ? weather.lifeIndexLines : [];
  return lines.length ? `\n生活指数提示：${lines.join('；')}` : '';
}

export function summarizeWeatherDisplay(weather = {}) {
  if (!weather) return '';
  return String(weather.displayLine || weather.promptLine || weather.summary || '').trim();
}

export function weatherSourceLabel(weather = {}) {
  const source = String(weather?.source || '').trim();
  if (source === 'open-meteo') return '实时天气';
  if (source === 'seasonal-fallback') return '季节气候兜底';
  return source || '天气信息';
}

export function summarizeWeatherForHint(weather = {}) {
  if (!weather) return '';
  const line = summarizeWeatherDisplay(weather);
  return line
    .replace(/。天气只作生活背景；.*$/u, '')
    .replace(/；只把天气当轻背景，不要编造成具体实时数据。?$/u, '')
    .trim();
}

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatWeatherPromptContext(line = '', cityInfo = {}, {
  ownerLabel = '角色',
  weather = null,
} = {}) {
  const raw = String(line || '').trim();
  if (!raw) return '';
  const virtualCity = String(cityInfo?.virtualCity || '').trim();
  const weatherCity = String(
    cityInfo?.weatherCity || cityInfo?.realCityMap || weather?.city || '',
  ).trim();
  if (
    !virtualCity
    || !weatherCity
    || normalizeCityInput(virtualCity) === normalizeCityInput(weatherCity)
  ) return raw;

  const possiblePrefixes = [weather?.city, weatherCity]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const prefixPattern = possiblePrefixes.length
    ? new RegExp(`^(?:${possiblePrefixes.map(escapeRegExp).join('|')})\\s*(?:：|:|·)\\s*`, 'u')
    : null;
  const weatherBody = (prefixPattern ? raw.replace(prefixPattern, '') : raw).trim() || raw;
  return `${weatherBody}（天气数据参考现实映射城市“${weatherCity}”，只用于体感；${ownerLabel}的故事城市仍是“${virtualCity}”，不得把映射城市写成所在地或剧情地点。）`;
}

export async function fetchWeatherForCity(cityInput = '', options = {}) {
  const city = normalizeCityInput(cityInput);
  if (!city) return null;
  return getRegionalWeatherByCity(city, options).catch(() => null);
}

const backgroundWeatherRefreshes = new Map();

/** 不阻塞聊天请求地刷新天气缓存；同一城市同时只保留一笔网络请求。 */
export function refreshWeatherForCityInBackground(cityInput = '', options = {}) {
  const city = normalizeCityInput(cityInput);
  if (!city) return Promise.resolve(null);
  const existing = backgroundWeatherRefreshes.get(city);
  if (existing) return existing;
  const refresh = fetchWeatherForCity(city, {
    ...options,
    cacheOnly: false,
    allowNetwork: true,
  }).finally(() => {
    if (backgroundWeatherRefreshes.get(city) === refresh) {
      backgroundWeatherRefreshes.delete(city);
    }
  });
  backgroundWeatherRefreshes.set(city, refresh);
  return refresh;
}

export async function refreshUserWeatherHint(user = {}, options = {}) {
  const info = getEffectiveWeatherCityForUser(user);
  if (!info.weatherCity) return { user, weather: null, info };
  const weather = await fetchWeatherForCity(info.weatherCity, options);
  const hint = summarizeWeatherForHint(weather);
  const next = hint ? { ...user, weatherHint: hint.slice(0, 120) } : user;
  return { user: next, weather, info };
}

export async function refreshCharacterWeatherHint(character = {}, options = {}) {
  const info = getEffectiveWeatherCityForCharacter(character);
  if (!info.weatherCity) return { character, weather: null, info };
  const weather = await fetchWeatherForCity(info.weatherCity, options);
  const hint = summarizeWeatherForHint(weather);
  const anchor = {
    ...(character.residenceAnchor && typeof character.residenceAnchor === 'object' ? character.residenceAnchor : {}),
  };
  if (hint) anchor.weatherHint = hint.slice(0, 120);
  return {
    character: { ...character, residenceAnchor: anchor },
    weather,
    info,
  };
}
