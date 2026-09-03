import * as db from '../db.js';
import { buildFeedbackBundle } from '../debug-log.js';
import { FEEDBACK_SERVICE_URL, FEEDBACK_SERVICE_URLS } from '../../data/service-endpoints.js';
import { sanitizeDiagnosticValue } from './diagnostic-envelope.js';

const QUEUE_KEY = 'supportFeedbackQueue';
const RECEIPTS_KEY = 'supportFeedbackReceipts';
const INSTALL_ID_KEY = 'marshmallowFeedbackInstallId';
const SERVICE_URL_KEY = 'marshmallowFeedbackServiceUrl';

function randomId(prefix = '') {
  if (globalThis.crypto?.randomUUID) return `${prefix}${crypto.randomUUID()}`;
  return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

let activeFeedbackServiceUrl = '';

function serviceUrls() {
  const isLocalDevelopment = (() => {
    try {
      return /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
    } catch (_) {
      return false;
    }
  })();
  const override = String(globalThis.__MARSHMALLOW_FEEDBACK_URL__ || '').trim().replace(/\/+$/, '');
  const localOverride = isLocalDevelopment
    ? String(localStorage.getItem(SERVICE_URL_KEY) || '').trim().replace(/\/+$/, '')
    : '';
  const configured = override || localOverride;
  if (configured) return [configured];
  const roots = [...new Set([
    ...(Array.isArray(FEEDBACK_SERVICE_URLS) ? FEEDBACK_SERVICE_URLS : []),
    FEEDBACK_SERVICE_URL,
  ].map((value) => String(value || '').trim().replace(/\/+$/, '')).filter(Boolean))];
  return [...new Set([activeFeedbackServiceUrl, ...roots].filter(Boolean))];
}

function serviceUrl() {
  return serviceUrls()[0] || '';
}

export function getFeedbackServiceUrl() {
  return serviceUrl();
}

export function setFeedbackServiceUrl(value = '') {
  const url = String(value || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) throw new Error('反馈后台地址需以 http:// 或 https:// 开头');
  if (url) localStorage.setItem(SERVICE_URL_KEY, url);
  else localStorage.removeItem(SERVICE_URL_KEY);
  return url;
}

export function getFeedbackInstallId() {
  let id = localStorage.getItem(INSTALL_ID_KEY);
  if (!id) {
    id = randomId('install_');
    localStorage.setItem(INSTALL_ID_KEY, id);
  }
  return id;
}

async function getSettingList(key) {
  const row = await db.get('settings', key).catch(() => null);
  return Array.isArray(row?.value) ? row.value : [];
}

async function saveSettingList(key, value) {
  await db.put('settings', { key, value });
}

export async function buildSafeFeedbackPayload({
  description = '',
  reproduction = '',
  diagnostic = null,
} = {}) {
  const bundle = JSON.parse(await buildFeedbackBundle({ diagnostic }));
  return {
    schemaVersion: 2,
    description: String(sanitizeDiagnosticValue(description || '') || '').trim().slice(0, 3000),
    reproduction: String(sanitizeDiagnosticValue(reproduction || '') || '').trim().slice(0, 3000),
    installId: getFeedbackInstallId(),
    diagnostic: sanitizeDiagnosticValue(diagnostic || bundle.latestDiagnostic || {}),
    environment: sanitizeDiagnosticValue(bundle.meta || {}),
    apiStats: sanitizeDiagnosticValue((bundle.apiStats || []).slice(0, 10)),
    events: sanitizeDiagnosticValue((bundle.events || []).slice(0, 15)),
    highlights: (Array.isArray(bundle.highlights) ? bundle.highlights : []).slice(0, 8).map((item = {}) => ({
      type: String(sanitizeDiagnosticValue(item.type || '') || '').slice(0, 100),
      message: String(sanitizeDiagnosticValue(item.message || '') || '').slice(0, 600),
      rejectedCount: Number(item.context?.rejectedCount || 0) || 0,
      reason: String(sanitizeDiagnosticValue(item.context?.reason || '') || '').slice(0, 160),
    })),
    submissionId: randomId('submit_'),
    receiptToken: randomId('receipt_'),
    createdAt: Date.now(),
  };
}

function validateScreenshot(file) {
  if (!file) return null;
  if (!(file instanceof Blob)) throw new Error('截图文件无效');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('截图仅支持 PNG、JPEG 或 WebP');
  }
  if (file.size > 2 * 1024 * 1024) throw new Error('截图不能超过 2MB');
  return file;
}

function isNetworkFailure(error) {
  return error instanceof TypeError
    || /failed to fetch|load failed|networkerror|network request failed|连接.*失败/i.test(String(error?.message || error || ''));
}

async function fetchFeedback(path, options = {}) {
  const roots = serviceUrls();
  if (!roots.length) throw new Error('反馈后台尚未配置');
  const failures = [];
  for (const root of roots) {
    try {
      const response = await fetch(`${root}${path}`, options);
      activeFeedbackServiceUrl = root;
      return response;
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      failures.push({ root, message: String(error?.message || error || '网络请求失败') });
    }
  }
  const error = new Error('反馈主线路与备用线路均无法连接');
  error.code = 'FEEDBACK_UNREACHABLE';
  error.networkFailure = true;
  error.attemptedOrigins = failures.map((item) => item.root);
  throw error;
}

function feedbackHttpError(response, body = {}) {
  const error = new Error(body?.error?.message || `反馈上传失败（HTTP ${response.status}）`);
  error.status = response.status;
  error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return error;
}

async function sendPayload(payload, screenshot = null) {
  if (!payload.submissionId) payload.submissionId = randomId('submit_');
  if (!payload.receiptToken) payload.receiptToken = randomId('receipt_');
  const form = new FormData();
  const { submissionId = '', receiptToken = '', ...safePayload } = payload || {};
  form.set('payload', JSON.stringify(safePayload));
  form.set('submissionId', String(submissionId || ''));
  form.set('receiptToken', String(receiptToken || ''));
  const image = validateScreenshot(screenshot);
  if (image) form.set('screenshot', image, `feedback.${image.type.split('/')[1] || 'png'}`);
  const response = await fetchFeedback('/api/reports', {
    method: 'POST',
    body: form,
    headers: { 'X-Install-Id': payload.installId },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw feedbackHttpError(response, body);
  return body;
}

async function saveReceipt(result) {
  const receipts = await getSettingList(RECEIPTS_KEY);
  receipts.unshift({
    id: String(result.id || ''),
    receiptToken: String(result.receiptToken || ''),
    status: String(result.status || 'new'),
    createdAt: Number(result.createdAt || Date.now()),
    updatedAt: Date.now(),
  });
  await saveSettingList(RECEIPTS_KEY, receipts.filter((item) => item.id).slice(0, 50));
}

export async function submitFeedback(input = {}) {
  const payload = await buildSafeFeedbackPayload(input);
  if (!payload.description && !payload.diagnostic?.code) throw new Error('请描述问题后再提交');
  try {
    const result = await sendPayload(payload, input.screenshot || null);
    await saveReceipt(result);
    return { ...result, queued: false };
  } catch (error) {
    if (!error?.networkFailure && !error?.retryable) throw error;
    const queue = await getSettingList(QUEUE_KEY);
    queue.push({
      localId: randomId('queued_'),
      payload,
      screenshot: input.screenshot || null,
      attempts: 0,
      queuedAt: Date.now(),
      lastError: String(error?.message || error).slice(0, 300),
    });
    await saveSettingList(QUEUE_KEY, queue.slice(-20));
    return {
      queued: true,
      queuedReason: error?.networkFailure ? 'network' : 'service',
      localId: queue[queue.length - 1].localId,
    };
  }
}

export async function retryFeedbackQueue() {
  const queue = await getSettingList(QUEUE_KEY);
  const remaining = [];
  const sent = [];
  for (const item of queue) {
    try {
      const result = await sendPayload(item.payload, item.screenshot);
      await saveReceipt(result);
      sent.push(result);
    } catch (error) {
      remaining.push({
        ...item,
        attempts: Number(item.attempts || 0) + 1,
        lastError: String(error?.message || error).slice(0, 300),
      });
    }
  }
  await saveSettingList(QUEUE_KEY, remaining);
  return { sent, remaining };
}

export async function listFeedbackReceipts({ refresh = false } = {}) {
  const receipts = await getSettingList(RECEIPTS_KEY);
  if (!refresh || !serviceUrl()) return receipts;
  const updated = [];
  for (const receipt of receipts.slice(0, 20)) {
    try {
      const response = await fetchFeedback(`/api/reports/${encodeURIComponent(receipt.id)}`, {
        headers: { 'X-Receipt-Token': receipt.receiptToken },
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      updated.push(response.ok ? { ...receipt, ...body.report, receiptToken: receipt.receiptToken } : receipt);
    } catch (_) {
      updated.push(receipt);
    }
  }
  await saveSettingList(RECEIPTS_KEY, updated);
  return updated;
}

export async function replyToFeedback(id, receiptToken, message) {
  const text = String(message || '').trim().slice(0, 2000);
  if (!text) throw new Error('请输入补充内容');
  const response = await fetchFeedback(`/api/reports/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Receipt-Token': String(receiptToken || ''),
    },
    body: JSON.stringify({ message: text }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || '补充发送失败');
  return body;
}
