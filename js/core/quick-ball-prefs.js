// Quick ball preferences: master switch and per-action switches.
// Stored in IndexedDB settings under quickBallPrefs; saving broadcasts an immediate UI update.
import * as db from './db.js';

export const QUICK_BALL_PREFS_KEY = 'quickBallPrefs';
export const QUICK_BALL_PREFS_EVENT = 'quick-ball-prefs-changed';
export const QUICK_BALL_POSITION_KEY = 'quickBallPos';
export const QUICK_BALL_POSITION_RESET_EVENT = 'quick-ball-position-reset';

export function getDefaultQuickBallPosition() {
  return { side: 'left', topRatio: 0.42 };
}

export function resetQuickBallPosition() {
  try {
    localStorage.removeItem(QUICK_BALL_POSITION_KEY);
  } catch (_) {}
  const position = getDefaultQuickBallPosition();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(QUICK_BALL_POSITION_RESET_EVENT, { detail: position }));
  }
  return position;
}

/** Shared action metadata for the quick ball and its settings controls. */
export const QUICK_BALL_ACTION_DEFS = [
  { id: 'support', label: '问芥末棉花糖', hint: '带上当前页面与运行状态进行判断', icon: 'help' },
  { id: 'feedback', label: '问题反馈', hint: '写一句现象并附带脱敏错误信息', icon: 'message' },
  { id: 'rescue', label: '快捷自救', hint: '打开最近报错的排查页', icon: 'zap' },
  { id: 'apiSwitch', label: '主 API 切换', hint: '点选已保存的聊天模型预设', icon: 'cloud' },
  { id: 'offlineApiSwitch', label: '线下 API 切换', hint: '点选已保存的场景叙事预设', icon: 'pin' },
  { id: 'worldTime', label: '剧情时间', hint: '暂停、续接或快速推进世界时间', icon: 'time' },
  { id: 'copyFeedback', label: '复制反馈包', hint: '复制最近报错的反馈文本', icon: 'clipboard' },
  { id: 'reload', label: '重新载入', hint: '刷新页面（卡死自救）', icon: 'refresh' },
];

const DEFAULT_PREFS = () => ({
  enabled: true,
  actions: Object.fromEntries(QUICK_BALL_ACTION_DEFS.map((a) => [a.id, true])),
});

function normalizePrefs(raw) {
  const base = DEFAULT_PREFS();
  if (!raw || typeof raw !== 'object') return base;
  const actions = { ...base.actions };
  if (raw.actions && typeof raw.actions === 'object') {
    for (const def of QUICK_BALL_ACTION_DEFS) {
      if (raw.actions[def.id] === false) actions[def.id] = false;
    }
  }
  // 旧备份或早期版本可能只保存 actions，没有 enabled。缺字段应沿用默认开启，
  // 只有明确写入 false 才关闭，避免导入/升级后悬浮球无故消失。
  return { enabled: raw.enabled !== false, actions };
}

export async function loadQuickBallPrefs() {
  const row = await db.get('settings', QUICK_BALL_PREFS_KEY).catch(() => null);
  return normalizePrefs(row?.value);
}

export async function saveQuickBallPrefs(patch = {}) {
  const current = await loadQuickBallPrefs();
  const next = normalizePrefs({
    ...current,
    ...patch,
    actions: { ...current.actions, ...(patch.actions || {}) },
  });
  await db.put({ key: QUICK_BALL_PREFS_KEY, value: next });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(QUICK_BALL_PREFS_EVENT, { detail: next }));
  }
  return next;
}
