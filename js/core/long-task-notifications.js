import { currentRoute } from './router.js';
import { notifyBackgroundMessageIfEnabled } from './native-notifications.js';

/**
 * 记录一个长流程开始时所在的页面。完成后仅当用户已切到别处或 App 在后台时通知，
 * 避免用户正盯着结果页时再收到一次系统通知和提示音。
 */
export function beginLongTaskNotice({
  title = '生成完成',
  body = '内容已经准备好了',
  tag = 'long-task-complete',
  isStillViewing = null,
} = {}) {
  const startedRoute = currentRoute();
  let settled = false;

  return {
    async complete(overrides = {}) {
      if (settled) return { ok: false, reason: 'settled' };
      settled = true;

      const hidden = typeof document === 'undefined' || document.hidden;
      const routeChanged = currentRoute() !== startedRoute;
      let leftRelevantView = false;
      if (typeof isStillViewing === 'function') {
        try {
          leftRelevantView = !isStillViewing();
        } catch (_) {
          leftRelevantView = true;
        }
      }
      if (!hidden && !routeChanged && !leftRelevantView) {
        return { ok: false, reason: 'still-viewing' };
      }

      return notifyBackgroundMessageIfEnabled({
        title: String(overrides.title || title),
        body: String(overrides.body || body),
        tag: String(overrides.tag || tag),
        data: overrides.data || {},
        requireHidden: false,
      });
    },
    cancel() {
      settled = true;
    },
  };
}
