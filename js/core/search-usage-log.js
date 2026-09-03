/**
 * 联网搜索/解析调用的统一流水日志：供「兴趣页 · 今日调用」和「设置页 · 搜索调用统计」共用。
 * 只做记录与查询，不参与任何限额逻辑（限额仍由各自的 dailyLimit/XHS 额度模块负责）。
 */
import * as db from './db.js';

const LOG_KEY = 'searchCallLog';
const LOG_CAP = 500;

function clean(value = '', max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function searchLogDayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @param entry.category 调用来源（如 interest_orchestrator / interest_manual / interest_xhs /
 *   share_post_search / need_search / travel_char / offline_date / forum ...）
 * @param entry.provider 实际命中的渠道（tavily/exa/brave/serpapi/searchapi/xiaohongshu...）
 * @param entry.manual 是否是用户手动触发（不占日配额的那种）
 * @param entry.resultCount 命中条数（0 也要如实传，用来和「接口报错」区分开）
 * @param entry.reason 失败/空结果的机器可读原因：'api_error' | 'empty_result' | 'quota_exceeded'；
 *   成功时留空。用于让「今日调用」这类 UI 能展示"是真没内容，还是配额用完，还是接口挂了"。
 * @param entry.diagnostic 空结果时的脱敏响应形状摘要；不得包含 API Key 或完整响应正文。
 */
export async function logSearchCall({
  category = '', provider = '', characterId = '', ok = true, query = '', error = '', manual = false,
  resultCount = null, reason = '', diagnostic = '',
} = {}) {
  try {
    const row = await db.get('settings', LOG_KEY).catch(() => null);
    const list = Array.isArray(row?.value) ? row.value : [];
    const okFlag = ok !== false;
    const record = {
      at: Date.now(),
      category: clean(category, 40),
      provider: clean(provider, 20),
      characterId: clean(characterId, 60),
      ok: okFlag,
      query: clean(query, 80),
      error: error ? clean(error, 160) : '',
      diagnostic: diagnostic ? clean(diagnostic, 700) : '',
      manual: manual === true,
      resultCount: Number.isFinite(Number(resultCount)) ? Math.max(0, Number(resultCount)) : null,
      reason: clean(reason, 30) || (okFlag ? '' : (error ? 'api_error' : 'empty_result')),
    };
    const next = [record, ...list].slice(0, LOG_CAP);
    await db.put('settings', { key: LOG_KEY, value: next });
    return record;
  } catch (_) {
    return null;
  }
}

export async function listSearchCallLog({ characterId = '', dateKey = '', limit = 200 } = {}) {
  const row = await db.get('settings', LOG_KEY).catch(() => null);
  const list = Array.isArray(row?.value) ? row.value : [];
  return list
    .filter((e) => (!characterId || e.characterId === characterId) && (!dateKey || searchLogDayKey(e.at) === dateKey))
    .slice(0, Math.max(0, limit));
}

const REASON_LABEL = {
  api_error: '接口报错',
  empty_result: '接口返回但未识别到内容',
  quota_exceeded: '当日额度已用完',
};

export function reasonLabel(reason = '') {
  return REASON_LABEL[reason] || (reason ? reason : '');
}

export function summarizeSearchCallLog(entries = []) {
  const summary = {
    total: entries.length, actual: 0, ok: 0, fail: 0, skipped: 0, manual: 0,
    byCategory: {}, byProvider: {}, byReason: {},
  };
  for (const e of entries) {
    const skipped = e.ok === false && e.reason === 'quota_exceeded';
    if (skipped) summary.skipped += 1;
    else {
      summary.actual += 1;
      if (e.ok) summary.ok += 1; else summary.fail += 1;
    }
    if (e.manual) summary.manual += 1;
    if (e.category) summary.byCategory[e.category] = (summary.byCategory[e.category] || 0) + 1;
    if (e.provider) summary.byProvider[e.provider] = (summary.byProvider[e.provider] || 0) + 1;
    if (!e.ok && e.reason) summary.byReason[e.reason] = (summary.byReason[e.reason] || 0) + 1;
  }
  return summary;
}
