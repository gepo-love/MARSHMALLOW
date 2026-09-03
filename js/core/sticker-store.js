import * as db from './db.js';
import { upgradeMixedContentMediaUrl } from './media-url.js';

const COLLAPSED_KEY = 'stickerPackCollapsedIds';
const STICKER_PACK_SUMMARY_KEY = 'stickerPackSummaryIndexV1';
let stickerPackSummaryCache = null;
let stickerPackSummaryWriteChain = Promise.resolve();

function stickerPackSummary(pack = {}) {
  return {
    id: String(pack.id || '').trim(),
    name: String(pack.name || '未命名').trim() || '未命名',
    count: Array.isArray(pack.stickers) ? pack.stickers.length : Math.max(0, Number(pack.count || 0) || 0),
    createdAt: Number(pack.createdAt || 0) || 0,
  };
}

function normalizeStickerPackSummaries(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map(stickerPackSummary)
    .filter((row) => row.id)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
}

function persistStickerPackSummaries(rows = []) {
  const value = normalizeStickerPackSummaries(rows);
  stickerPackSummaryCache = value;
  stickerPackSummaryWriteChain = stickerPackSummaryWriteChain
    .then(() => db.put({ key: STICKER_PACK_SUMMARY_KEY, value }))
    .catch(() => {});
  return stickerPackSummaryWriteChain;
}

export function sanitizeStickerDisplayName(raw) {
  let n = String(raw || '').trim();
  if (!n) return '表情';
  n = n.replace(/[：:]\s*https?:\/\/\S*$/i, '').trim();
  n = n.replace(/[：:]\s*https?$/i, '').trim();
  return n || '表情';
}

/** 用户重命名：保留原意，仅做空白与长度收敛。 */
export function normalizeStickerItemName(raw) {
  const name = sanitizeStickerDisplayName(raw);
  if (!name || name === '表情') throw new Error('请输入表情名称');
  return name.slice(0, 48);
}

export function isStickerImageUrl(value = '') {
  const url = String(value || '').trim();
  return /^(https?:\/\/|data:image\/)/i.test(url);
}

/** 表情包图床 URL 升级（APK mixed-content）；实现见 media-url.js */
export function upgradeStickerImageUrl(value = '') {
  return upgradeMixedContentMediaUrl(value);
}

const STICKER_URL_PROBE_DEFAULT_TIMEOUT_MS = 5000;

/** 用与聊天相同的 <img> 方式探测 URL 是否真能显示为图片 */
export function probeStickerImageUrl(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : STICKER_URL_PROBE_DEFAULT_TIMEOUT_MS;
  const src = String(url || '').trim();
  if (!isStickerImageUrl(src)) {
    return Promise.resolve({ ok: false, reason: 'invalid_format' });
  }
  if (typeof Image === 'undefined') {
    if (/^data:image\//i.test(src)) {
      const ok = /^data:image\/[^;]+;base64,[A-Za-z0-9+/=]{8,}/i.test(src);
      return Promise.resolve({ ok, reason: ok ? '' : 'load_failed' });
    }
    return Promise.resolve({ ok: false, reason: 'load_failed' });
  }
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (ok, reason = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      if (!ok) {
        // 超时图片仍可能继续占用下载连接；主动清空，给队列里的后续 URL 让路。
        try { img.src = ''; } catch (_) {}
      }
      resolve({ ok, reason: ok ? '' : reason });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    img.onload = () => finish(true);
    img.onerror = () => finish(false, 'load_failed');
    img.decoding = 'async';
    img.src = src;
  });
}

export function stickerUrlProbeFailHint(reason = '') {
  switch (String(reason || '').trim()) {
    case 'invalid_format':
      return '地址格式不对';
    case 'timeout':
      return '加载超时';
    case 'load_failed':
    default:
      return '图片无法加载（需直链，部分图床会拦截）';
  }
}

/** 批量 URL 导入：解析 + 探测，仅返回可加载的行 */
export async function filterImportableStickerLines(lines = [], options = {}) {
  const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 8));
  const parsed = [];
  let invalidLines = 0;
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;
    const row = parseStickerImportLine(trimmed);
    if (row) parsed.push(row);
    else invalidLines += 1;
  }
  if (!parsed.length) {
    return { importable: [], failed: [], invalidLines };
  }

  const results = new Array(parsed.length);
  const probeCache = new Map();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  let cursor = 0;
  let completed = 0;
  const runWorker = async () => {
    while (cursor < parsed.length) {
      const index = cursor;
      cursor += 1;
      const row = parsed[index];
      const displayUrl = upgradeStickerImageUrl(row.url);
      let probeTask = probeCache.get(displayUrl);
      if (!probeTask) {
        probeTask = probeStickerImageUrl(displayUrl, options);
        probeCache.set(displayUrl, probeTask);
      }
      const probe = await probeTask;
      results[index] = { row: { ...row, url: displayUrl }, probe };
      completed += 1;
      try { onProgress?.({ completed, total: parsed.length }); } catch (_) {}
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, parsed.length) }, () => runWorker()),
  );

  const importable = [];
  const failed = [];
  for (const { row, probe } of results) {
    if (probe.ok) importable.push({ name: row.name, url: row.url });
    else {
      failed.push({
        name: row.name,
        url: row.url,
        reason: probe.reason,
        hint: stickerUrlProbeFailHint(probe.reason),
      });
    }
  }
  return { importable, failed, invalidLines };
}

/** 批量导入一行：名称 + 冒号/空格 + URL，或仅 URL */
export function parseStickerImportLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  const re = /https?:\/\/[^\s]+/i;
  const m = re.exec(trimmed);
  if (!m) return null;
  const url = m[0].replace(/[)\].,;]+$/g, '').trim();
  let name = trimmed.slice(0, m.index).trim();
  name = name.replace(/[：:]\s*$/u, '').trim();
  if (/https?:/i.test(name)) {
    name = name.replace(/[：:]\s*https?:\/\/.*$/i, '').trim();
    name = name.replace(/[：:]\s*$/u, '').trim();
  }
  if (!name) name = '表情';
  return { name: sanitizeStickerDisplayName(name), url };
}

export function normalizeBoundStickerPackIdsFromRow(row) {
  if (!row) return [];
  const fromArr = Array.isArray(row.boundStickerPackIds)
    ? row.boundStickerPackIds.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const uniq = [...new Set(fromArr)];
  const legacy = String(row.boundStickerPackId || '').trim();
  if (legacy && !uniq.includes(legacy)) uniq.push(legacy);
  return uniq;
}

export function newStickerItemId(seed = Date.now()) {
  return `st_${seed}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createStickerPack(overrides = {}) {
  const now = Date.now();
  return {
    id: overrides.id || `stk_${now}_${Math.random().toString(36).slice(2, 6)}`,
    name: String(overrides.name || '新分组').trim() || '新分组',
    stickers: Array.isArray(overrides.stickers) ? overrides.stickers : [],
    createdAt: Number(overrides.createdAt || now) || now,
  };
}

export async function listStickerPacks() {
  const rows = await db.getAllRecords('stickerPacks');
  const packs = (Array.isArray(rows) ? rows : [])
    .map((p) => ({ ...p, stickers: Array.isArray(p.stickers) ? p.stickers : [] }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  void persistStickerPackSummaries(packs);
  return packs;
}

/** 只供设定页等展示分组名和数量；旧数据首次读取后会建立轻量索引。 */
export async function listStickerPackSummaries() {
  if (Array.isArray(stickerPackSummaryCache)) return stickerPackSummaryCache.map((row) => ({ ...row }));
  const stored = await db.get(STICKER_PACK_SUMMARY_KEY).catch(() => null);
  if (Array.isArray(stored?.value)) {
    stickerPackSummaryCache = normalizeStickerPackSummaries(stored.value);
    return stickerPackSummaryCache.map((row) => ({ ...row }));
  }
  const packs = await listStickerPacks();
  return normalizeStickerPackSummaries(packs);
}

export async function getStickerPack(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  const row = await db.getRecord('stickerPacks', key).catch(() => null);
  return row ? { ...row, stickers: Array.isArray(row.stickers) ? row.stickers : [] } : null;
}

export async function saveStickerPack(pack) {
  if (!pack?.id) throw new Error('sticker pack id required');
  const row = {
    ...pack,
    stickers: Array.isArray(pack.stickers) ? pack.stickers : [],
  };
  await db.putRecord('stickerPacks', row);
  const summaries = Array.isArray(stickerPackSummaryCache)
    ? stickerPackSummaryCache
    : await listStickerPackSummaries().catch(() => []);
  const next = summaries.filter((item) => item.id !== row.id);
  next.push(stickerPackSummary(row));
  await persistStickerPackSummaries(next);
  return row;
}

export async function deleteStickerPack(id) {
  const key = String(id || '').trim();
  await db.deleteRecord('stickerPacks', key);
  const summaries = Array.isArray(stickerPackSummaryCache)
    ? stickerPackSummaryCache
    : await listStickerPackSummaries().catch(() => []);
  await persistStickerPackSummaries(summaries.filter((item) => item.id !== key));
}

export async function getCollapsedPackIds() {
  const row = await db.get(COLLAPSED_KEY);
  const list = Array.isArray(row?.value) ? row.value : [];
  return new Set(list.map((x) => String(x)).filter(Boolean));
}

export async function saveCollapsedPackIds(ids = []) {
  await db.put({ key: COLLAPSED_KEY, value: [...new Set(ids.map(String))] });
}

export async function toggleCollapsedPack(id, collapsedSet) {
  const key = String(id || '').trim();
  const next = new Set(collapsedSet);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  await saveCollapsedPackIds([...next]);
  return next;
}
