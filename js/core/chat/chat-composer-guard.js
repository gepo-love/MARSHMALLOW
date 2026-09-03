/**
 * 会话输入占用闸门。
 *
 * 输入框属于页面 UI，后台生成属于 core。两边读取同一份轻量状态，
 * 避免主动消息在用户正在组织回复时启动或抢先落库。
 */

const COMPOSER_STATE_KEY = 'mmIdleContinueComposerV1';
const COMPOSER_ACTIVITY_SETTLE_MS = 2500;
const COMPOSER_DRAFT_TTL_MS = 2 * 60 * 1000;

function clean(value) {
  return String(value ?? '').trim();
}

function readComposerStateMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COMPOSER_STATE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function hasLiveComposerOccupancy(chatId, row = {}) {
  if (typeof document === 'undefined') return false;
  const id = clean(chatId);
  if (!id) return false;
  let page = null;
  try {
    page = Array.from(document.querySelectorAll('.chat-thread-page[data-chat-id]'))
      .find((node) => (
        clean(node?.dataset?.chatId) === id
        && node?.isConnected !== false
        && node?.hidden !== true
      )) || null;
  } catch (_) {
    return false;
  }
  if (!page) return false;
  const input = page.querySelector?.('.chat-composer-input') || null;
  // Android 用返回键收起 Gboard 后，textarea 可能仍是 activeElement，且不会派发
  // focusout。只有键盘确实可见时才把焦点作为实时占用；收键盘后由近期活动窗口
  // 继续短暂避让，不能被残留焦点永久卡住。
  const keyboardVisible = Number(globalThis.window?.__marshmallowViewportKeyboardInset || 0) >= 80
    || document.documentElement?.classList?.contains?.('keyboard-visible') === true;
  const inputFocused = !!input && document.activeElement === input;
  return keyboardVisible && (inputFocused || row?.focused === true);
}

export function getSharedChatComposerState(chatId) {
  const id = clean(chatId);
  const row = id ? readComposerStateMap()[id] : null;
  if (!row || typeof row !== 'object') {
    return { focused: false, busy: false, updatedAt: 0, activityAt: 0, hasDraft: false };
  }
  const updatedAt = Math.max(0, Number(row.updatedAt || 0) || 0);
  // updatedAt 也会被普通 idle/状态同步刷新，不能把它误当成真实输入或键盘关闭时间。
  // 新旧写入链路都会在确有操作时提供 activityAt。
  const activityAt = Math.max(0, Number(row.activityAt || 0) || 0);
  const recentActivity = activityAt > 0
    && Date.now() - activityAt <= COMPOSER_ACTIVITY_SETTLE_MS;
  // 草稿状态来自页面持续写入；保留旧有两分钟失效兜底，避免 App 异常退出后
  // 一条已经不存在的草稿永久拦住后台结果。
  const hasDraft = row.hasDraft === true
    && updatedAt > 0
    && Date.now() - updatedAt <= COMPOSER_DRAFT_TTL_MS;
  const liveOccupancy = hasLiveComposerOccupancy(id, row);
  return {
    focused: row.focused === true,
    // 键盘关闭会把 focused 清掉，但完整的静默窗口应从关闭时刻才开始。
    busy: liveOccupancy || hasDraft || recentActivity,
    updatedAt,
    activityAt,
    hasDraft,
    liveOccupancy,
  };
}

export function isChatComposerBusy(chatId) {
  return getSharedChatComposerState(chatId).busy === true;
}
