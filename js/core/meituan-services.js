import { get, put } from './db.js';

export const MEITUAN_CONFIG_KEY = 'meituanServicesV1';
export const MEITUAN_CREDENTIALS_KEY = 'meituanCredentials';
export const MEITUAN_TRAVEL_TOKEN_URL = 'https://developer.meituan.com/zh/v2/dev/token';
export const MEITUAN_PAOTUI_SKILL_URL = 'https://github.com/meituan/MT-Paotui-For-Client';

export const MEITUAN_SERVICE_CATALOG = Object.freeze([
  Object.freeze({ id: 'travel', label: '酒店旅行', available: true, mode: 'official-api' }),
  Object.freeze({ id: 'errand', label: '跑腿', available: true, mode: 'self-host-bridge' }),
  // 保留稳定的能力 id，日后官方开放时不用迁移角色或历史数据。
  // 当前不向 UI 和模型目录暴露，避免形成一个不能用的“假外卖”入口。
  Object.freeze({ id: 'food-delivery', label: '外卖', available: false, mode: 'reserved' }),
]);

function clean(value = '', max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanBridgeUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) return '';
    if (url.username || url.password) return '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
}

function normalizeConfig(value = {}) {
  return Object.freeze({
    travel: Object.freeze({
      enabled: value.travel?.enabled === true,
      allowAutonomousUse: value.travel?.allowAutonomousUse === true,
      city: clean(value.travel?.city, 60),
    }),
    errand: Object.freeze({
      enabled: value.errand?.enabled === true,
      bridgeUrl: cleanBridgeUrl(value.errand?.bridgeUrl),
    }),
  });
}

function normalizeCredentials(value = {}) {
  return Object.freeze({
    travelToken: String(value.travelToken || '').trim().slice(0, 8000),
    errandToken: String(value.errandToken || '').trim().slice(0, 8000),
  });
}

export async function getMeituanServiceConfig() {
  const row = await get('settings', MEITUAN_CONFIG_KEY).catch(() => null);
  return normalizeConfig(row?.value);
}

export async function getMeituanCredentials() {
  const row = await get('settings', MEITUAN_CREDENTIALS_KEY).catch(() => null);
  return normalizeCredentials(row?.value);
}

export async function getMeituanServiceState() {
  const [config, credentials] = await Promise.all([
    getMeituanServiceConfig(),
    getMeituanCredentials(),
  ]);
  return {
    config,
    credentials,
    travelReady: config.travel.enabled && !!credentials.travelToken,
    errandReady: config.errand.enabled && !!config.errand.bridgeUrl && !!credentials.errandToken,
  };
}

export async function saveMeituanServiceState(value = {}) {
  const config = normalizeConfig(value);
  const credentials = normalizeCredentials(value.credentials || value);
  if (value.errand?.enabled === true && value.errand?.bridgeUrl && !config.errand.bridgeUrl) {
    throw new TypeError('跑腿桥地址需要使用 HTTPS，或本机 localhost/127.0.0.1 HTTP');
  }
  await Promise.all([
    put('settings', { key: MEITUAN_CONFIG_KEY, value: config }),
    put('settings', { key: MEITUAN_CREDENTIALS_KEY, value: credentials }),
  ]);
  globalThis.window?.dispatchEvent?.(new CustomEvent('meituan-services-changed'));
  return { config, credentials };
}

async function responseJson(response) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}
  if (!response.ok) {
    const message = clean(data?.error?.message || data?.error || data?.message || text, 400);
    throw new Error(message || `美团服务返回 ${response.status}`);
  }
  return data ?? { text };
}

export async function queryMeituanTravel(argumentsValue = {}, options = {}) {
  const state = await getMeituanServiceState();
  if (!state.travelReady) throw new Error('请先在 MCP 连接美团酒店旅行');
  const city = clean(argumentsValue.city || state.config.travel.city, 60);
  const query = clean(argumentsValue.query, 1600);
  if (!city || !query) throw new TypeError('酒旅查询需要城市和具体需求');
  const response = await fetch('/api/meituan/travel', {
    method: 'POST',
    credentials: 'same-origin',
    signal: options.signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Meituan-Token': state.credentials.travelToken,
    },
    body: JSON.stringify({
      city,
      query,
      originQuery: clean(argumentsValue.originQuery || query, 1600),
      channel: clean(argumentsValue.channel || 'marshmallow-phone', 80),
    }),
  });
  const result = await responseJson(response);
  return result?.data ?? result;
}

export async function callMeituanErrandBridge(command = '', argumentsValue = {}, options = {}) {
  const state = await getMeituanServiceState();
  if (!state.errandReady) throw new Error('请先在 MCP 连接美团跑腿');
  const response = await fetch(`${state.config.errand.bridgeUrl}/meituan/paotui/${encodeURIComponent(command)}`, {
    method: command === 'health' ? 'GET' : 'POST',
    mode: 'cors',
    credentials: 'omit',
    signal: options.signal,
    headers: {
      Authorization: `Bearer ${state.credentials.errandToken}`,
      'Content-Type': 'application/json',
    },
    ...(command === 'health' ? {} : { body: JSON.stringify(argumentsValue || {}) }),
  });
  return responseJson(response);
}
