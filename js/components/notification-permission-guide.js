import { icon } from './svg-icons.js';
import { isIOSDevice } from '../core/native-download.js';
import { isStandalonePwa } from '../core/pwa-install.js';
import {
  hasMessageNotificationPermission,
  requestMessageNotificationPermission,
} from '../core/native-notifications.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function siteHost() {
  try {
    return String(window.location?.host || '').trim() || '当前站点';
  } catch (_) {
    return '当前站点';
  }
}

export function getWebNotificationPermissionState() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  const p = String(Notification.permission || '');
  if (p === 'granted' || p === 'denied' || p === 'default') return p;
  return 'unsupported';
}

export function isIosWebPushVersionUnsupported(userAgent = '') {
  const ua = String(userAgent || (
    typeof navigator !== 'undefined' ? navigator.userAgent : ''
  ));
  const match = ua.match(/(?:CPU(?: iPhone)? OS|iPhone OS)\s+(\d+)[._](\d+)/i);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major < 16 || (major === 16 && minor < 4);
}

export function isLegacyIosWebPushUnsupported() {
  return isIOSDevice() && isIosWebPushVersionUnsupported();
}

function buildGuideCopy(state = 'denied', reason = '') {
  const host = siteHost();
  if (state === 'unsupported') {
    if (isLegacyIosWebPushUnsupported()) {
      return {
        title: '当前 iOS 版本不支持通知',
        body: '主屏幕网页通知需要 iOS 16.4 或更高版本。升级系统后，再从主屏幕打开应用并开启通知。',
        canRetry: false,
      };
    }
    return {
      title: '当前浏览器不支持通知',
      body: '这台浏览器没有网页通知能力，后台消息推送用不了。可换 Chrome / Edge，或使用安装版 App。',
      canRetry: false,
    };
  }
  if (isIOSDevice()) {
    if (!isStandalonePwa()) {
      return {
        title: '请从主屏幕打开',
        body: 'iPhone 需要先用 Safari「分享 → 添加到主屏幕」，再从主屏幕图标打开并开启通知。',
        canRetry: true,
      };
    }
    if (state === 'denied') {
      return {
        title: '通知已被 iPhone 关闭',
        body: '系统授权框不会重复出现。请到「设置 → 通知 → 棉花糖机」开启通知，再回来重试。',
        canRetry: true,
      };
    }
    if (state === 'granted' && reason === 'delivery-verification') {
      return {
        title: '测试通知已发出',
        body: '更新会保留原有权限，所以不会重复弹系统授权框。若没有看到测试通知，请检查「设置 → 通知 → 棉花糖机」，或完全关闭后从主屏幕重新打开。',
        canRetry: true,
        retryLabel: '再发一条',
      };
    }
    if (state === 'granted' && reason) {
      const repairing = reason === 'service-worker-repair-cooldown';
      return {
        title: '通知通道需要恢复',
        body: repairing
          ? '权限仍在，但兼容启动暂时停用了通知通道。请打开急救页清理静态缓存，再从主屏幕重新打开。'
          : '权限仍在，但通知没有成功送出。请完全关闭后从主屏幕重新打开；仍无通知时，检查「设置 → 通知 → 棉花糖机」。',
        canRetry: true,
      };
    }
    return {
      title: '需要开启通知权限',
      body: '请在系统授权框选择「允许」。若没有弹窗，到「设置 → 通知 → 棉花糖机」开启，再回来重试。',
      canRetry: true,
    };
  }
  if (state === 'denied') {
    return {
      title: '通知已被浏览器禁止',
      body: [
        `「${host}」已在浏览器里被标成不允许（含自动禁止）。`,
        '此时网页无法再弹出系统授权框，只能手动改站点权限：',
        '',
        '1. 浏览器设置 → 通知（或站点权限 → 通知）',
        `2. 在「不允许」里找到 ${host}`,
        '3. 改为允许，或先删除该条',
        '4. 回到本页，点「我已允许，再试一次」',
      ].join('\n'),
      canRetry: true,
    };
  }
  return {
    title: '未获得通知权限',
    body: [
      '请在浏览器弹出的授权框里选「允许」。',
      '若没有弹窗，到 设置 → 通知，确认本站未被禁止，再点「我已允许，再试一次」。',
    ].join('\n'),
    canRetry: true,
  };
}

/**
 * 通知权限失败时的引导弹窗。
 * denied/自动禁止时系统不会再弹授权框，只能引导用户去浏览器设置手动允许。
 * @returns {Promise<{ granted: boolean, askSupport?: boolean }>}
 */
export function openNotificationPermissionGuide({
  state = '',
  reason = '',
  retryCheck = null,
} = {}) {
  const hostEl = document.getElementById('modal-container');
  const resolvedState = state || getWebNotificationPermissionState();
  if (!hostEl) {
    return Promise.resolve({ granted: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (granted, askSupport = false) => {
      if (settled) return;
      settled = true;
      hostEl.classList.remove('active');
      hostEl.innerHTML = '';
      resolve({ granted: !!granted, askSupport: askSupport === true });
    };

    const paint = (statusText = '') => {
      const copy = buildGuideCopy(resolvedState, reason);
      hostEl.classList.add('active');
      hostEl.innerHTML = `
        <div class="modal-overlay modal-sheet-center" data-notify-perm-overlay>
          <div class="modal-sheet scrapbook-card" role="alertdialog" aria-modal="true" data-notify-perm-sheet>
            <header class="modal-header">
              <h3>${esc(copy.title)}</h3>
              <button type="button" class="navbar-btn modal-close-btn" data-notify-perm-close aria-label="关闭">${icon('close')}</button>
            </header>
            <div class="modal-body" style="font-size:14px;line-height:1.65;color:var(--text-secondary);white-space:pre-wrap;">${esc(copy.body)}</div>
            ${statusText ? `<p class="text-hint" data-notify-perm-status style="margin:0 16px 12px;line-height:1.5;">${esc(statusText)}</p>` : '<p class="text-hint" data-notify-perm-status hidden style="margin:0 16px 12px;line-height:1.5;"></p>'}
            <div style="padding:0 16px 12px;">
              <button type="button" class="btn btn-soft" data-notify-perm-support style="width:100%;">还是没有弹窗？让芥末检查</button>
            </div>
            <footer class="modal-footer" style="gap:8px;">
              <button type="button" class="btn btn-outline" data-notify-perm-close style="flex:1;">知道了</button>
              ${copy.canRetry ? `<button type="button" class="btn btn-primary" data-notify-perm-retry style="flex:1;">${esc(copy.retryLabel || '我已允许，再试一次')}</button>` : ''}
            </footer>
          </div>
        </div>
      `;

      hostEl.querySelector('[data-notify-perm-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
      hostEl.querySelector('[data-notify-perm-overlay]')?.addEventListener('click', () => finish(false));
      hostEl.querySelectorAll('[data-notify-perm-close]').forEach((btn) => {
        btn.addEventListener('click', () => finish(false));
      });
      hostEl.querySelector('[data-notify-perm-support]')?.addEventListener('click', () => {
        finish(false, true);
      });
      hostEl.querySelector('[data-notify-perm-retry]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn) btn.disabled = true;
        const status = hostEl.querySelector('[data-notify-perm-status]');
        if (status) {
          status.hidden = false;
          status.textContent = '正在重新检测…';
        }
        let ok = false;
        if (typeof retryCheck === 'function') {
          const retryResult = await retryCheck().catch(() => false);
          ok = retryResult === true || retryResult?.ok === true;
        } else {
          ok = await hasMessageNotificationPermission()
            || await requestMessageNotificationPermission().catch(() => false);
        }
        if (ok) {
          finish(true);
          return;
        }
        if (status) {
          const currentState = getWebNotificationPermissionState();
          status.textContent = currentState === 'denied'
            ? '仍是禁止状态。请先在系统或浏览器设置里改成允许。'
            : (currentState === 'granted'
              ? '权限已允许，但通知通道仍未恢复。请重新打开应用后再试。'
              : '还没拿到权限。请先允许通知。');
        }
        if (btn) btn.disabled = false;
      });
    };

    paint();
  });
}
