import {
  registerGenerationTaskStatusQuery,
} from './chat/generation-task-store.js';
import {
  getNativeHttpRequestState,
  readNativeHttpRequestChunk,
} from './native-http.js';
import { normalizeDiagnosticEnvelope } from './support/diagnostic-envelope.js';

const PREFS_KEY = 'marshmallowGenerationRelayV1';
const RELAY_DISPATCH_JOURNAL_KEY = 'mm_generation_relay_dispatch_v1';
const RELAY_DISPATCH_JOURNAL_MAX = 60;
const RELAY_DISPATCH_JOURNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PREFS = Object.freeze({
  enabled: false,
  baseUrl: '',
  token: '',
  kind: '',
  capabilities: null,
  capabilityCheckedAt: 0,
  requestTtlSeconds: 900,
  resultTtlSeconds: 3600,
  pollIntervalMs: 1500,
  pushEnabled: false,
});

const CLOUD_SCHEDULE_TASK_TYPES = Object.freeze([
  'chat-auto',
  'idle-continue',
  'delayed-reply',
]);
const RELAY_EVENT_ACK_MODES = new Set(['none', 'job-patch']);

/** Deploy to Cloudflare：使用独立公开模板，不暴露主项目仓库。 */
export const CF_RELAY_DEPLOY_URL = 'https://deploy.workers.cloudflare.com/?url=https://github.com/zznnll588546-wq/marshmallow-cloudflare-relay';

function storage() {
  try { return globalThis.localStorage; } catch (_) { return null; }
}

function readRelayDispatchJournal() {
  try {
    const raw = storage()?.getItem(RELAY_DISPATCH_JOURNAL_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function rememberRelayDispatch({ taskId = '', idempotencyKey = '', remoteJobId = '' } = {}) {
  const task = String(taskId || '').trim();
  const idem = String(idempotencyKey || '').trim();
  const remote = String(remoteJobId || '').trim();
  if ((!task && !idem) || !remote) return false;
  try {
    const target = storage();
    if (!target) return false;
    const now = Date.now();
    const journal = readRelayDispatchJournal();
    const rows = Object.values(journal)
      .filter((row) => row && now - Number(row.savedAt || 0) <= RELAY_DISPATCH_JOURNAL_TTL_MS)
      .sort((left, right) => Number(right.savedAt || 0) - Number(left.savedAt || 0))
      .slice(0, RELAY_DISPATCH_JOURNAL_MAX - 1);
    const next = {};
    for (const row of rows) {
      const key = String(row.taskId || row.idempotencyKey || '').trim();
      if (key && key !== task && key !== idem) next[key] = row;
    }
    const entry = { taskId: task, idempotencyKey: idem, remoteJobId: remote, savedAt: now };
    next[task || idem] = entry;
    target.setItem(RELAY_DISPATCH_JOURNAL_KEY, JSON.stringify(next));
    return true;
  } catch (_) {
    return false;
  }
}

function findRelayDispatch(task = {}) {
  const taskId = String(task?.taskId || '').trim();
  const idempotencyKey = String(task?.idempotencyKey || '').trim();
  const journal = readRelayDispatchJournal();
  const direct = journal[taskId] || journal[idempotencyKey] || null;
  const row = direct || Object.values(journal).find((entry) => (
    (taskId && String(entry?.taskId || '') === taskId)
    || (idempotencyKey && String(entry?.idempotencyKey || '') === idempotencyKey)
  ));
  if (!row || Date.now() - Number(row.savedAt || 0) > RELAY_DISPATCH_JOURNAL_TTL_MS) return null;
  return row;
}

function deliverRelayJobCallback(onJob, job) {
  if (typeof onJob !== 'function') return Promise.resolve();
  try {
    return Promise.resolve(onJob(job));
  } catch (error) {
    return Promise.reject(error);
  }
}

function normalizeBaseUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) throw new Error('中继地址需以 http:// 或 https:// 开头');
  return url;
}

/**
 * /health 能力协商必须保守：旧自建中继没有 capabilities 时只确认即时生成，
 * 不能凭产品名猜测它实现了 schedules / events / ACK。旧 Cloudflare Worker 的
 * 顶层字段只用于兼容已发布版本，并且必须同时给出对应的明确旧特征。
 */
export function normalizeGenerationRelayCapabilities(health = {}) {
  const envelope = health && typeof health === 'object' ? health : {};
  const explicit = envelope.capabilities && typeof envelope.capabilities === 'object'
    ? envelope.capabilities
    : null;
  const source = explicit || {};
  const kind = String(envelope.kind || '').trim();
  const legacyCloudflare = !explicit
    && kind === 'cloudflare-workers'
    && envelope.singlePendingScheduleResult === true;
  const protocolVersion = Math.max(0, Math.min(
    100,
    Math.trunc(Number(source.protocolVersion ?? envelope.protocolVersion) || 0),
  ));
  const supportedTaskTypes = [...new Set(
    (Array.isArray(source.supportedTaskTypes)
      ? source.supportedTaskTypes
      : (legacyCloudflare ? CLOUD_SCHEDULE_TASK_TYPES : []))
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .slice(0, 32),
  )];
  const eventAcknowledgement = RELAY_EVENT_ACK_MODES.has(String(source.eventAcknowledgement || ''))
    ? String(source.eventAcknowledgement)
    : (legacyCloudflare ? 'job-patch' : 'none');
  return {
    protocolVersion,
    // 能通过 /health 的旧中继至少支持现有 /jobs 即时生成；其它能力一律需明示。
    immediateGeneration: explicit ? source.immediateGeneration === true : envelope.ok !== false,
    oneShotSchedules: source.oneShotSchedules === true || legacyCloudflare,
    eventCursor: source.eventCursor === true || legacyCloudflare,
    eventAcknowledgement,
    resultDurability: source.resultDurability === 'ttl' || legacyCloudflare ? 'ttl' : 'none',
    webPush: source.webPush === true || (!explicit && envelope.supportsPush === true),
    encryptedTaskEnvelope: source.encryptedTaskEnvelope === true
      || source.encryptedEnvelope === true
      || (!explicit && envelope.supportsCryptoCheck === true),
    cancelRevision: source.cancelRevision === true,
    supportedTaskTypes,
  };
}

function normalizePrefs(value = {}) {
  const capabilities = value.capabilities && typeof value.capabilities === 'object'
    ? normalizeGenerationRelayCapabilities({ kind: value.kind, capabilities: value.capabilities })
    : null;
  return {
    enabled: value.enabled === true,
    baseUrl: String(value.baseUrl || '').trim().replace(/\/+$/, ''),
    token: String(value.token || ''),
    kind: String(value.kind || '').trim(),
    capabilities,
    capabilityCheckedAt: Math.max(0, Math.trunc(Number(value.capabilityCheckedAt) || 0)),
    requestTtlSeconds: Math.max(30, Math.min(86400, Number(value.requestTtlSeconds) || 900)),
    resultTtlSeconds: Math.max(30, Math.min(604800, Number(value.resultTtlSeconds) || 3600)),
    pollIntervalMs: Math.max(800, Math.min(10000, Number(value.pollIntervalMs) || 1500)),
    pushEnabled: value.pushEnabled === true,
  };
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (padded.length % 4 || 4)) % 4);
  const binary = atob(padded + pad);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function deriveEnvelopeKey(token) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持中继加密');
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(token || '')),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('marshmallow-relay-v1'),
    info: new TextEncoder().encode('task-envelope'),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function envelopeAad(purpose, binding = '') {
  return new TextEncoder().encode(`mmrelay:v1:${purpose}:${String(binding || '')}`);
}

async function encryptRelayEnvelope(value, token, purpose, binding = '') {
  const key = await deriveEnvelopeKey(token);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: envelopeAad(purpose, binding),
  }, key, new TextEncoder().encode(JSON.stringify(value)));
  return {
    v: 1,
    alg: 'A256GCM',
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

async function decryptRelayEnvelope(envelope, token, purpose, binding = '') {
  if (!envelope || envelope.v !== 1 || envelope.alg !== 'A256GCM') {
    throw new Error('中继返回了无法识别的加密结果');
  }
  const key = await deriveEnvelopeKey(token);
  const plain = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: base64UrlToBytes(envelope.iv),
    additionalData: envelopeAad(purpose, binding),
  }, key, base64UrlToBytes(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function relayPayloadHash(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** 解析部署页 /setup 复制出的 mmrelay1.xxx 配置串，或 JSON。 */
export function parseGenerationRelayImportText(raw = '') {
  const text = String(raw || '').trim();
  if (!text) throw new Error('请粘贴中继配置');
  let payload = null;
  if (/^mmrelay1\./i.test(text)) {
    const encoded = text.slice('mmrelay1.'.length);
    try {
      payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
    } catch (_) {
      throw new Error('配置串无法解析');
    }
  } else if (text.startsWith('{')) {
    try { payload = JSON.parse(text); } catch (_) {
      throw new Error('配置 JSON 无法解析');
    }
  } else {
    throw new Error('无法识别的配置格式');
  }
  const baseUrl = normalizeBaseUrl(payload?.baseUrl || '');
  const token = String(payload?.token || '').trim();
  if (!baseUrl || !token) throw new Error('配置缺少中继地址或访问令牌');
  return normalizePrefs({
    ...DEFAULT_PREFS,
    ...payload,
    baseUrl,
    token,
    enabled: payload?.enabled !== false,
    // 导入串只能提供连接材料；能力必须由目标 /health 亲自证明。
    capabilities: null,
    capabilityCheckedAt: 0,
  });
}

export function importGenerationRelayConfig(raw = '') {
  const next = parseGenerationRelayImportText(raw);
  return saveGenerationRelayPrefs(next);
}

export function exportGenerationRelayConfigText(prefs = getGenerationRelayPrefs()) {
  const payload = {
    v: 1,
    kind: prefs.kind || 'manual',
    baseUrl: prefs.baseUrl,
    token: prefs.token,
    requestTtlSeconds: prefs.requestTtlSeconds,
    resultTtlSeconds: prefs.resultTtlSeconds,
    enabled: prefs.enabled === true,
  };
  return `mmrelay1.${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`;
}

/**
 * 生成中继访问令牌（ADMIN_TOKEN）。
 * 默认 24 字节随机数 → base64url，约 32 字符，无需用户手搓。
 */
export function generateRelayAdminToken(byteLength = 24) {
  const size = Math.max(16, Math.min(64, Number(byteLength) || 24));
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('当前环境无法生成安全随机令牌');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return bytesToBase64Url(bytes);
}

/** 生成令牌并写入本地中继配置（不改地址与开关）。 */
export function createAndRememberRelayAdminToken(byteLength = 24) {
  const token = generateRelayAdminToken(byteLength);
  saveGenerationRelayPrefs({ token });
  return token;
}

export function openCloudflareRelayDeploy() {
  if (typeof window === 'undefined') return { ok: false, reason: 'no-window' };
  window.open(CF_RELAY_DEPLOY_URL, '_blank', 'noopener,noreferrer');
  return { ok: true, url: CF_RELAY_DEPLOY_URL };
}

export function getGenerationRelayPrefs() {
  try {
    return normalizePrefs({
      ...DEFAULT_PREFS,
      ...JSON.parse(storage()?.getItem(PREFS_KEY) || '{}'),
    });
  } catch (_) {
    return normalizePrefs(DEFAULT_PREFS);
  }
}

export function saveGenerationRelayPrefs(patch = {}) {
  const next = normalizePrefs({ ...getGenerationRelayPrefs(), ...patch });
  if (next.baseUrl) normalizeBaseUrl(next.baseUrl);
  storage()?.setItem(PREFS_KEY, JSON.stringify(next));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('generation-relay-config-changed', {
      detail: { ...next, token: next.token ? '[set]' : '' },
    }));
  }
  return next;
}

export function isGenerationRelayEnabled(prefs = getGenerationRelayPrefs()) {
  return prefs.enabled === true && !!prefs.baseUrl && !!prefs.token;
}

export function isCloudScheduledBackgroundEnabled(prefs = getGenerationRelayPrefs()) {
  if (!isGenerationRelayEnabled(prefs) || prefs.kind !== 'cloudflare-workers') return false;
  if (!prefs.capabilities) return true; // 兼容尚未重新测试连接的旧配置。
  const taskTypes = new Set(prefs.capabilities.supportedTaskTypes || []);
  return prefs.capabilities.oneShotSchedules === true
    && prefs.capabilities.eventCursor === true
    && prefs.capabilities.eventAcknowledgement === 'job-patch'
    && prefs.capabilities.resultDurability === 'ttl'
    && CLOUD_SCHEDULE_TASK_TYPES.every((type) => taskTypes.has(type));
}

export function hasCloudScheduledTask(taskKey) {
  try {
    const map = JSON.parse(localStorage.getItem('mmCloudBackgroundScheduleRevisionsV1') || '{}');
    return Number(map?.[String(taskKey || '')] || 0) > 0;
  } catch (_) {
    return false;
  }
}

function relayHeaders(prefs, extra = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${prefs.token}`,
    ...extra,
  };
}

async function relayFetch(path, options = {}, prefs = getGenerationRelayPrefs()) {
  const baseUrl = normalizeBaseUrl(prefs.baseUrl);
  if (!baseUrl || !prefs.token) throw new Error('后台任务中继尚未配置');
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: relayHeaders(prefs, options.headers),
      cache: 'no-store',
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const wrapped = new Error('无法连接后台任务中继');
    wrapped.code = 'RELAY_UNREACHABLE';
    wrapped.cause = error;
    throw wrapped;
  }
  let body = null;
  try { body = await response.json(); } catch (_) {}
  if (!response.ok) {
    const message = body?.error?.message || `中继请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    error.code = body?.error?.code || '';
    throw error;
  }
  return body;
}

async function runRelayCryptoCheck(baseUrl, token, signal) {
  const binding = `chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const ping = `mm-crypto-${binding}`;
  const envelope = await encryptRelayEnvelope({
    ping,
    at: Date.now(),
  }, token, 'crypto-check', binding);
  let response;
  try {
    response = await fetch(`${baseUrl}/crypto-check`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ envelope, binding, nonce: binding }),
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('加密自检超时：请检查网络后重试');
    throw new Error('无法连接后台任务中继（加密自检）');
  }
  if (response.status === 404) {
    return { ok: false, skipped: true, reason: 'unsupported' };
  }
  if (response.status === 401) {
    throw new Error('访问令牌不正确：请与 Cloudflare 的 ADMIN_TOKEN 保持一致');
  }
  let body = null;
  try { body = await response.json(); } catch (_) {}
  if (!response.ok) {
    if (body?.error?.code === 'crypto_mismatch' || /could not be opened/i.test(String(body?.error?.message || ''))) {
      throw new Error('加密自检失败：App 访问令牌与 Cloudflare ADMIN_TOKEN 不一致。请把两边改成同一串，或打开中继 /setup 用当前令牌重新导入');
    }
    throw new Error(body?.error?.message || `加密自检失败（HTTP ${response.status}）`);
  }
  let reply;
  try {
    reply = await decryptRelayEnvelope(body.envelope, token, 'crypto-check-result', binding);
  } catch (_) {
    throw new Error('加密自检失败：中继回包无法解密，请同步 ADMIN_TOKEN 后重试');
  }
  if (reply?.ok !== true || String(reply?.pong || '') !== ping) {
    throw new Error('加密自检失败：中继回包内容不匹配');
  }
  return { ok: true, skipped: false };
}

export async function testGenerationRelay(prefs = getGenerationRelayPrefs()) {
  const baseUrl = normalizeBaseUrl(prefs.baseUrl);
  if (!baseUrl) throw new Error('请填写后台任务中继地址');
  const token = String(prefs.token || '').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${baseUrl}/health`, {
      cache: 'no-store',
      signal: controller.signal,
    }).catch((error) => {
      if (error?.name === 'AbortError') throw new Error('连接超时：请检查中继地址，或确认 Worker 已部署成功');
      return null;
    });
    if (!response?.ok) throw new Error('后台任务中继连接失败：请确认地址正确且 Worker 已部署');
    const health = await response.json().catch(() => ({ ok: true }));
    const capabilities = normalizeGenerationRelayCapabilities(health);
    if (!token) {
      throw new Error('请填写访问令牌；测试连接会校验它是否与 Cloudflare ADMIN_TOKEN 一致');
    }
    // 令牌鉴权：Cloudflare 有 /setup.json；自建版可能 404，不算失败。
    const authed = await fetch(`${baseUrl}/setup.json`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: controller.signal,
    }).catch((error) => {
      if (error?.name === 'AbortError') throw new Error('令牌校验超时：请检查网络后重试');
      return null;
    });
    if (authed && authed.status === 401) {
      throw new Error('访问令牌不正确：请与 Cloudflare 的 ADMIN_TOKEN 保持一致');
    }
    // 加密往返：比单纯 Bearer 更能发现「能连上但加解密对不上」的配置。
    let cryptoCheck = { ok: false, skipped: true, reason: 'pending' };
    try {
      cryptoCheck = await runRelayCryptoCheck(baseUrl, token, controller.signal);
    } catch (error) {
      // 旧 Worker 没有该接口时 runRelayCryptoCheck 会 skipped；其它错误直接抛出。
      throw error;
    }
    saveGenerationRelayPrefs({
      ...prefs,
      kind: health?.kind ? String(health.kind) : String(prefs.kind || ''),
      token,
      capabilities,
      capabilityCheckedAt: Date.now(),
    });
    return {
      ...health,
      capabilities,
      cryptoCheck: cryptoCheck.skipped
        ? { ok: false, skipped: true, reason: cryptoCheck.reason || 'unsupported' }
        : { ok: true, skipped: false },
    };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function relayStatusError(job) {
  if (job?.status === 'cancelled') {
    const error = new DOMException('请求已取消', 'AbortError');
    error.code = 'RELAY_CANCELLED';
    return error;
  }
  const error = new Error(job?.error?.message || (
    job?.status === 'expired' ? '后台任务已过期' : '后台任务执行失败'
  ));
  error.code = job?.error?.code || `RELAY_${String(job?.status || 'FAILED').toUpperCase()}`;
  error.status = Number(job?.error?.status || 0) || undefined;
  error.upstreamHost = String(job?.error?.upstreamHost || '');
  error.relayTransport = true;
  error.diagnostic = normalizeDiagnosticEnvelope({
    code: error.code,
    source: 'api',
    scope: '后台任务中继',
    message: error.message,
    status: error.status,
    evidence: {
      relayStatus: job?.status || '',
      upstreamHost: error.upstreamHost,
    },
  });
  return error;
}

/**
 * 真正走一遍「App → 中继 → 当前模型 API → 中继 → App」。
 * 会产生一次极小的模型请求，和仅探活/验令牌的 testGenerationRelay 分开。
 */
export async function testGenerationRelayFullPath({
  prefs = getGenerationRelayPrefs(),
  upstream = null,
  model = '',
  timeoutMs = 45_000,
} = {}) {
  const upstreamUrl = String(upstream?.url || upstream?.baseUrl || '').trim();
  const upstreamKey = String(upstream?.apiKey || '').trim();
  const requestModel = String(model || '').trim();
  if (!upstreamUrl || !upstreamKey || !requestModel) {
    throw new Error('当前聊天模型的地址、密钥或模型名未填写完整');
  }
  const id = `relay_diag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(10_000, Number(timeoutMs) || 45_000));
  try {
    const relay = await runGenerationRelayCompletion({
      model: requestModel,
      messages: [{
        role: 'user',
        content: '这是连通性测试。只回复 OK，不要添加其它内容。',
      }],
      temperature: 0,
      stream: false,
    }, {
      taskId: id,
      idempotencyKey: id,
      signal: controller.signal,
      prefs,
      upstream: {
        url: upstreamUrl,
        apiKey: upstreamKey,
        customHeaders: upstream?.customHeaders || {},
      },
    });
    const text = String(
      relay?.result?.choices?.[0]?.message?.content
      || relay?.result?.choices?.[0]?.text
      || '',
    ).trim();
    return {
      ok: true,
      model: String(relay?.result?.model || requestModel),
      text: text.slice(0, 80),
    };
  } catch (error) {
    if (controller.signal.aborted && error?.name === 'AbortError') {
      const wrapped = new Error('完整线路测试超时：中继已连接，但模型 API 45 秒内没有完成');
      wrapped.code = 'UPSTREAM_TIMEOUT';
      throw wrapped;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function runGenerationRelayCompletion(request, {
  taskId = '',
  idempotencyKey = '',
  signal = null,
  onJob = null,
  onProgress = null,
  prefs = getGenerationRelayPrefs(),
  upstream = null,
} = {}) {
  if (!isGenerationRelayEnabled(prefs)) throw new Error('后台任务中继尚未启用');
  const body = {
    request: { ...(request || {}), stream: request?.stream === true },
    requestTtlSeconds: prefs.requestTtlSeconds,
    resultTtlSeconds: prefs.resultTtlSeconds,
    clientTaskId: String(taskId || ''),
  };
  // Cloudflare 版要求每任务携带当前 App 线路；Node 自建版会忽略该字段，继续用环境变量。
  const upstreamUrl = String(upstream?.url || upstream?.baseUrl || '').trim().replace(/\/+$/, '');
  const upstreamKey = String(upstream?.apiKey || '').trim();
  if (upstreamUrl && upstreamKey) {
    body.upstream = {
      url: upstreamUrl,
      apiKey: upstreamKey,
      customHeaders: upstream?.customHeaders && typeof upstream.customHeaders === 'object'
        ? upstream.customHeaders
        : {},
    };
  } else if (prefs.kind === 'cloudflare-workers') {
    throw new Error('Cloudflare 中继需要当前 API 线路的地址与密钥');
  }
  if (prefs.kind === 'cloudflare-workers') {
    const binding = String(idempotencyKey || taskId || '');
    const encryptedPayload = {
      request: body.request,
      upstream: body.upstream,
    };
    body.requestHash = await relayPayloadHash(encryptedPayload);
    body.envelope = await encryptRelayEnvelope(
      encryptedPayload,
      prefs.token,
      'request',
      binding,
    );
    delete body.request;
    delete body.upstream;
  }
  const created = await relayFetch('/jobs', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    body: JSON.stringify(body),
    signal,
  }, prefs);
  const remoteJobId = String(created?.id || '');
  if (!remoteJobId) throw new Error('后台任务中继未返回任务编号');
  // localStorage 中的轻量任务号是同步崩溃恢复旁路：先把远端任务身份记住，再让
  // 原生主库账本异步追上。这样原生写队列繁忙时不会阻塞领取已经付费的结果；
  // 下次启动即使账本只停在 dispatching，也能凭 task/idempotency 找回 remoteJobId。
  const dispatchJournaled = rememberRelayDispatch({ taskId, idempotencyKey, remoteJobId });
  const acceptedCallback = deliverRelayJobCallback(onJob, { ...created, remoteJobId });
  if (dispatchJournaled) void acceptedCallback.catch(() => {});
  else await acceptedCallback;
  let job = created;
  try {
    while (job && (job.status === 'queued' || job.status === 'running')) {
      onProgress?.({ phase: job.status, remoteJobId });
      await sleep(prefs.pollIntervalMs, signal);
      job = await relayFetch(`/jobs/${encodeURIComponent(remoteJobId)}`, {
        method: 'GET',
        signal,
      }, prefs);
      void deliverRelayJobCallback(onJob, { ...job, remoteJobId }).catch(() => {});
    }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      relayFetch(`/jobs/${encodeURIComponent(remoteJobId)}`, { method: 'DELETE' }, prefs).catch(() => {});
    }
    throw error;
  }
  if (job?.errorEnvelope) {
    try {
      job.error = await decryptRelayEnvelope(
        job.errorEnvelope,
        prefs.token,
        'error',
        remoteJobId,
      );
    } catch (_) {
      job.error = {
        message: '中继任务失败，错误详情无法解密（多半是访问令牌与 Cloudflare ADMIN_TOKEN 不一致，请同步后点「测试连接」）',
        code: 'RELAY_ERROR_DECRYPT',
      };
    }
  }
  if (job?.status !== 'succeeded') throw relayStatusError(job);
  const result = job.resultEnvelope
    ? await decryptRelayEnvelope(job.resultEnvelope, prefs.token, 'result', remoteJobId)
    : job.result;
  if (!result) throw new Error('中继任务完成但没有可读取的结果');
  return { job, result, remoteJobId };
}

function visibleCompletionValue(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.thought === true || part?.type === 'thinking') return '';
    return String(part?.text?.value ?? part?.text ?? part?.content ?? '');
  }).join('');
}

function completionText(result) {
  const choice = result?.choices?.[0] || {};
  const direct = visibleCompletionValue(choice?.message?.content)
    || visibleCompletionValue(choice?.delta?.content)
    || String(choice?.delta?.text || choice?.text || '')
    || String(result?.output_text || '');
  if (direct) return direct;
  if (result?.type === 'response.output_text.delta') return String(result.delta || '');
  if (result?.delta?.type === 'text_delta') return String(result.delta.text || '');
  const geminiParts = result?.candidates?.[0]?.content?.parts;
  return visibleCompletionValue(geminiParts);
}

function mergeRecoveredStreamText(previous = '', piece = '') {
  const current = String(previous || '');
  const incoming = String(piece || '');
  if (!incoming) return current;
  if (current.length >= 8 && incoming.length > current.length && incoming.startsWith(current)) {
    return incoming;
  }
  return current + incoming;
}

function completionTextFromRawBody(rawBody = '') {
  const raw = String(rawBody || '').trim();
  if (!raw) return '';
  try {
    return completionText(JSON.parse(raw));
  } catch (_) {}
  let fullText = '';
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = String(line || '').trim();
    if (!trimmed || /^(event|id|retry):/i.test(trimmed) || trimmed.startsWith(':')) continue;
    const payload = /^data:/i.test(trimmed)
      ? trimmed.replace(/^data:\s*/i, '')
      : (trimmed.startsWith('{') ? trimmed : '');
    if (!payload || payload === '[DONE]') continue;
    try {
      fullText = mergeRecoveredStreamText(fullText, completionText(JSON.parse(payload)));
    } catch (_) {}
  }
  return fullText;
}

export async function queryRelayGenerationTask(task) {
  const journaledDispatch = findRelayDispatch(task);
  const remoteJobId = String(
    task?.transport?.remoteJobId || journaledDispatch?.remoteJobId || '',
  ).trim();
  const nativeRequestId = String(task?.transport?.nativeRequestId || '').trim();
  if (!remoteJobId && nativeRequestId) {
    const state = await getNativeHttpRequestState(nativeRequestId);
    if (!state) return { status: 'unknown' };
    if (state.state === 'queued' || state.state === 'running' || state.state === 'aborting') {
      return { status: state.state === 'queued' ? 'pending' : 'running', nativeRequestId };
    }
    const hasPersistedBody = Number(state.responseLength || 0) > 0;
    if (state.state === 'completed' || state.state === 'partial' || (state.state === 'failed' && hasPersistedBody)) {
      let offset = 0;
      let raw = '';
      while (offset < Number(state.responseLength || 0)) {
        const chunk = await readNativeHttpRequestChunk(nativeRequestId, offset, 256 * 1024);
        if (!chunk) break;
        raw += String(chunk.data || '');
        const nextOffset = Number(chunk.nextOffset || offset);
        if (nextOffset <= offset) break;
        offset = nextOffset;
      }
      let result = null;
      try { result = raw ? JSON.parse(raw) : null; } catch (_) {}
      const partial = completionTextFromRawBody(raw);
      return partial
        ? { status: 'completed', nativeRequestId, partial, result }
        : { status: 'failed', nativeRequestId, error: { message: state.error || '原生请求没有可恢复正文' } };
    }
    return {
      status: state.state || 'unknown',
      nativeRequestId,
      error: state.error ? { message: String(state.error) } : null,
    };
  }
  if (!remoteJobId || !isGenerationRelayEnabled()) return { status: 'unknown' };
  const job = await relayFetch(`/jobs/${encodeURIComponent(remoteJobId)}`, { method: 'GET' });
  if (job.status === 'queued' || job.status === 'running') {
    return { status: job.status === 'queued' ? 'pending' : 'running', remoteJobId };
  }
  if (job.status === 'succeeded') {
    const result = job.resultEnvelope
      ? await decryptRelayEnvelope(
        job.resultEnvelope,
        getGenerationRelayPrefs().token,
        'result',
        remoteJobId,
      )
      : job.result;
    return {
      status: 'completed',
      remoteJobId,
      partial: completionText(result),
      result,
    };
  }
  let error = job.error || null;
  if (job.errorEnvelope) {
    try {
      error = await decryptRelayEnvelope(
        job.errorEnvelope,
        getGenerationRelayPrefs().token,
        'error',
        remoteJobId,
      );
    } catch (_) {
      error = {
        message: '中继错误详情无法解密（请确认 App 令牌与 Cloudflare ADMIN_TOKEN 一致）',
        code: 'RELAY_ERROR_DECRYPT',
      };
    }
  }
  return { status: job.status || 'unknown', remoteJobId, error };
}

registerGenerationTaskStatusQuery(queryRelayGenerationTask);

export async function upsertGenerationRelaySchedule({
  taskKey,
  taskType,
  revision,
  runAt,
  intervalMs = null,
  request,
  upstream,
  requestTtlSeconds = null,
  resultTtlSeconds = null,
} = {}, prefs = getGenerationRelayPrefs()) {
  if (!isGenerationRelayEnabled(prefs) || prefs.kind !== 'cloudflare-workers') {
    return { ok: false, skipped: true, reason: 'cloudflare-relay-disabled' };
  }
  const key = String(taskKey || '').trim();
  if (!key) throw new Error('定时任务缺少 taskKey');
  const payload = {
    request: { ...(request || {}), stream: request?.stream === true },
    upstream: {
      url: String(upstream?.url || upstream?.baseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(upstream?.apiKey || '').trim(),
      customHeaders: upstream?.customHeaders && typeof upstream.customHeaders === 'object'
        ? upstream.customHeaders
        : {},
    },
  };
  const normalizedRevision = Math.max(1, Number(revision) || Date.now());
  const binding = `${key}:${normalizedRevision}`;
  const envelope = await encryptRelayEnvelope(
    payload,
    prefs.token,
    'request',
    binding,
  );
  return relayFetch('/schedules', {
    method: 'POST',
    body: JSON.stringify({
      taskKey: key,
      taskType: String(taskType || 'background'),
      revision: normalizedRevision,
      runAt: Number(runAt) || 0,
      intervalMs: intervalMs == null ? null : Number(intervalMs),
      requestTtlSeconds: requestTtlSeconds ?? prefs.requestTtlSeconds,
      resultTtlSeconds: resultTtlSeconds ?? prefs.resultTtlSeconds,
      requestHash: await relayPayloadHash(payload),
      envelope,
    }),
  }, prefs);
}

export async function cancelGenerationRelaySchedule(taskKey, prefs = getGenerationRelayPrefs()) {
  const key = String(taskKey || '').trim();
  if (!key || !isGenerationRelayEnabled(prefs)) return { ok: false, skipped: true };
  return relayFetch(`/schedules/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  }, prefs);
}

export async function listGenerationRelaySchedules(prefs = getGenerationRelayPrefs()) {
  if (!isGenerationRelayEnabled(prefs) || prefs.kind !== 'cloudflare-workers') {
    return { schedules: [] };
  }
  const page = await relayFetch('/schedules', { method: 'GET' }, prefs);
  return { schedules: Array.isArray(page?.schedules) ? page.schedules : [] };
}

export async function listGenerationRelayEvents({
  after = 0,
} = {}, prefs = getGenerationRelayPrefs()) {
  if (!isGenerationRelayEnabled(prefs) || prefs.kind !== 'cloudflare-workers') {
    return { events: [], cursor: Number(after) || 0 };
  }
  const page = await relayFetch(`/events?after=${encodeURIComponent(Number(after) || 0)}`, {
    method: 'GET',
  }, prefs);
  const events = [];
  for (const event of page?.events || []) {
    let result = null;
    let error = event?.error || null;
    if (event?.resultEnvelope) {
      try {
        result = await decryptRelayEnvelope(
          event.resultEnvelope,
          prefs.token,
          'result',
          event.id,
        );
      } catch (_) {
        result = null;
      }
    } else if (event?.result) {
      result = event.result;
    }
    if (event?.errorEnvelope) {
      try {
        error = await decryptRelayEnvelope(
          event.errorEnvelope,
          prefs.token,
          'error',
          event.id,
        );
      } catch (_) {
        error = {
        message: '中继错误详情无法解密（请确认 App 令牌与 Cloudflare ADMIN_TOKEN 一致）',
        code: 'RELAY_ERROR_DECRYPT',
      };
      }
    }
    events.push({ ...event, result, error });
  }
  return {
    events,
    cursor: Number(page?.cursor || after || 0),
  };
}

export async function acknowledgeGenerationRelayEvent(jobId, prefs = getGenerationRelayPrefs()) {
  const id = String(jobId || '').trim();
  if (!id) return { ok: false, skipped: true };
  return relayFetch(`/jobs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: '{}',
  }, prefs);
}

function base64UrlToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function ensureGenerationRelayServiceWorker() {
  const ensureServiceWorker = globalThis.__mm_ensure_full_service_worker__;
  if (typeof ensureServiceWorker === 'function') {
    await ensureServiceWorker().catch(() => null);
  }
  return navigator.serviceWorker.ready;
}

export async function subscribeGenerationRelayPush(prefs = getGenerationRelayPrefs()) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('当前环境不支持 Web Push（Android APK 原生壳通常不可用，请用浏览器/PWA；APK 后续需接系统推送）');
  }
  if (Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('通知权限未开启');
  }
  const keyResult = await relayFetch('/push/vapid-public-key', { method: 'GET' }, prefs);
  const registration = await ensureGenerationRelayServiceWorker();
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(String(keyResult?.publicKey || '')),
    });
  }
  await relayFetch('/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify(subscription.toJSON()),
  }, prefs);
  saveGenerationRelayPrefs({ ...prefs, pushEnabled: true });
  return subscription;
}

export async function unsubscribeGenerationRelayPush(prefs = getGenerationRelayPrefs()) {
  if (!('serviceWorker' in navigator)) return false;
  const registration = await ensureGenerationRelayServiceWorker();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await relayFetch('/push/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }, prefs).catch(() => {});
    await subscription.unsubscribe();
  }
  saveGenerationRelayPrefs({ ...prefs, pushEnabled: false });
  return true;
}
