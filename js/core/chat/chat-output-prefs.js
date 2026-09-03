/**
 * 聊天输出·显示偏好（全局）
 * - 是否自动去掉 AI 气泡结尾多余的句号；
 * - 是否自动展开已有的有效中文译文。
 */

import { get as dbGet, put as dbPut } from '../db.js';

const CHAT_OUTPUT_PREFS_KEY = 'chatOutputPrefs';

const DEFAULTS = {
  stripTrailingPeriod: true,
  autoExpandTranslations: false,
};

export function normalizeChatOutputPrefs(raw = {}) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    // Default ON: only an explicit false (user toggled off) disables it
    stripTrailingPeriod: v.stripTrailingPeriod !== false,
    // Opt-in: undefined / legacy data keeps the existing click-to-expand behavior
    autoExpandTranslations: v.autoExpandTranslations === true,
  };
}

export async function loadChatOutputPrefs() {
  try {
    const row = await dbGet(CHAT_OUTPUT_PREFS_KEY);
    return normalizeChatOutputPrefs(row && row.value);
  } catch (_) {
    return { ...DEFAULTS };
  }
}

export async function saveChatOutputPrefs(patch = {}) {
  const current = await loadChatOutputPrefs();
  const next = normalizeChatOutputPrefs({ ...current, ...patch });
  try {
    await dbPut({ key: CHAT_OUTPUT_PREFS_KEY, value: { ...next, updatedAt: Date.now() } });
  } catch (_) { /* 写入失败不阻塞主流程 */ }
  return next;
}

export async function setStripTrailingPeriod(enabled) {
  return saveChatOutputPrefs({ stripTrailingPeriod: enabled === true });
}

export async function setAutoExpandTranslations(enabled) {
  const next = await saveChatOutputPrefs({ autoExpandTranslations: enabled === true });
  if (
    typeof window !== 'undefined'
    && typeof window.dispatchEvent === 'function'
    && typeof window.CustomEvent === 'function'
  ) {
    window.dispatchEvent(new window.CustomEvent('chat-output-prefs-changed', { detail: next }));
  }
  return next;
}

/**
 * 去掉一条气泡正文结尾「唯一」的中文句号（含全角变体）。
 * 刻意保留：
 *  - 整条只有句号（「。」「。。」等纯句号留白）；
 *  - 结尾是「。。」「。。。」这类故意拖尾；
 *  - 「？」「！」「…」「……」等其它收尾标点。
 * 不使用后行断言（lookbehind），兼容旧版 iOS Safari。
 */
export function stripTrailingPeriodFromBody(text) {
  const s = String(text == null ? '' : text);
  const m = s.match(/^([\s\S]*?)([。．｡]+)[\s]*$/);
  if (!m) return s;
  const head = m[1];
  const dots = m[2];
  if (!head.trim()) return s;   // 整条都是句号 → 故意留白，保留
  if (dots.length >= 2) return s; // 。。/。。。 → 故意拖尾，保留
  return head.replace(/\s+$/, '');
}

/** 按开关条件去尾句号；enabled 为假时原样返回。 */
export function applyTrailingPeriodPref(text, enabled) {
  if (enabled !== true) return String(text == null ? '' : text);
  return stripTrailingPeriodFromBody(text);
}
