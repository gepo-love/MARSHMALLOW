import { back, navigate } from '../core/router.js';
import { loadAllActiveConfigs } from '../core/api-presets.js';
import { buildApiUrl, getConfig } from '../core/api.js';
import { loadAppearancePrefs, getActiveTheme, applySettingsWallpaperPreview } from '../core/appearance-prefs.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { downloadCharactersExport } from '../core/character-export.js';
import { downloadFullBackup, downloadAssetBackup, downloadMigrationPackage, downloadRegionBackup, previewRegionBackup, importFullBackupFiles, importAssetBackupFile, importRegionBackupFiles, shouldUseStreamingBackupImport, formatExportOmissionHint } from '../core/backup.js';
import {
  ANDROID_REGION_PART_TARGET_BYTES,
  summarizeRegionBackupPlan,
  formatRegionBackupPlanText,
} from '../core/backup-regions.js';
import {
  describeDownloadResult,
  isAndroidDevice,
  isIOSDevice,
  isNativeShell,
} from '../core/native-download.js';
import {
  getPwaInstallStatus,
  canPromptPwaInstall,
  promptPwaInstall,
  isStandalonePwa,
} from '../core/pwa-install.js';
import {
  getBackgroundKeepAliveSettings,
  setBackgroundKeepAliveEnabled,
  enableRecommendedBackgroundKeepAlive,
  setKeepAwakeEnabled,
  setSilentAudioEnabled,
  setSilentAudioMode,
  setNotifyOnAutoChatEnabled,
  getNativeKeepAliveStatus,
  openNativeBatterySettings,
  getKeepAliveRuntimeStatus,
} from '../core/background-scheduler.js';
import {
  inspectMessageNotificationDelivery,
  requestMessageNotificationPermission,
  showMessageNotification,
} from '../core/native-notifications.js';
import {
  getWebNotificationPermissionState,
  isLegacyIosWebPushUnsupported,
  openNotificationPermissionGuide,
} from '../components/notification-permission-guide.js';
import { triggerFileInput } from '../core/open-file-picker.js';
import {
  getMessageNotifySoundPrefs,
  setMessageNotifySoundEnabled,
  setMessageNotifySoundVolume,
  setMessageNotifySoundFromFile,
  clearMessageNotifySoundCustom,
  previewMessageNotifySound,
  primeMessageNotifySoundGesture,
} from '../core/message-notify-audio.js';
import {
  getStoragePersistenceStatus,
  requestStoragePersistence,
  formatStorageBytes,
  describeStorageProtectionLabel,
} from '../core/storage-persistence.js';
import {
  WEBDAV_PROVIDER_GUIDES,
  getWebDavProviderGuide,
  inferWebDavProvider,
} from '../core/webdav-provider-guide.js';
import {
  openNativeExactAlarmSettings,
  openNativeOemBackgroundSettings,
} from '../core/native-background-wake.js';
import {
  loadChatOutputPrefs,
  setAutoExpandTranslations,
  setStripTrailingPeriod,
} from '../core/chat/chat-output-prefs.js';
import {
  loadQuickBallPrefs,
  QUICK_BALL_ACTION_DEFS,
  resetQuickBallPosition,
  saveQuickBallPrefs,
} from '../core/quick-ball-prefs.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';
import {
  backupImportResumeCheckpoint,
  failBackupImportSession,
  fingerprintBackupImportFile,
  finishBeautifySupplementSession,
  finishBackupImportSession,
  getBackupImportSession,
  matchesBackupImportSessionFile,
  saveBackupImportSkippedNotice,
  saveBeautifySupplementSession,
  startBackupImportSession,
  updateBackupImportSession,
} from '../core/backup-import-session.js';
import {
  getCloudBackupPrefs,
  saveCloudBackupPrefs,
  testCloudBackupConnection,
  listCloudBackups,
  createCloudBackup,
  restoreCloudBackup,
  deleteCloudBackup,
  runAutomaticCloudBackupIfDue,
} from '../core/cloud-backup.js';
import {
  clearCloudBackupInteraction,
  clearPendingGitHubAuthorization,
  hasPendingCloudBackupInteraction,
  keepCloudBackupInteraction,
  readCloudBackupInteraction,
  readPendingGitHubAuthorization,
  savePendingGitHubAuthorization,
} from '../core/cloud-backup-interaction.js';
import {
  startGitHubDeviceAuthorization,
  pollGitHubDeviceAuthorization,
  connectGitHubBackup,
} from '../core/backup-github.js';
import {
  getGenerationRelayPrefs,
  saveGenerationRelayPrefs,
  testGenerationRelay,
  testGenerationRelayFullPath,
  subscribeGenerationRelayPush,
  unsubscribeGenerationRelayPush,
  importGenerationRelayConfig,
  openCloudflareRelayDeploy,
  createAndRememberRelayAdminToken,
} from '../core/generation-relay.js';
import { copyTextToClipboard } from '../core/chat-helpers.js';
import { loadLastGenerationError } from '../core/generation-error-guide.js';
import { captureSupportIncident } from '../core/support/support-context.js';


function openNotificationSupport({
  state = '',
  stage = 'permission-check',
  detail = '',
} = {}) {
  const permissionState = state || getWebNotificationPermissionState();
  const diagnostic = captureSupportIncident({
    source: 'permission',
    severity: 'warning',
    code: permissionState === 'unsupported'
      ? 'notification-unsupported'
      : (permissionState === 'granted'
        ? 'notification-delivery-failed'
        : 'notification-permission-blocked'),
    scope: '通知测试',
    message: permissionState === 'denied'
      ? '通知权限已被浏览器禁止，系统授权框不会再次弹出'
      : (permissionState === 'unsupported'
        ? '当前运行环境没有可用的网页通知能力'
        : (permissionState === 'granted'
          ? '通知权限已允许，但测试通知未确认显示或投递通道不可用'
          : '通知测试未获得权限或没有出现系统授权框')),
    operation: '通知权限检查',
    evidence: {
      notificationPermission: permissionState,
      notificationApiSupported: typeof window !== 'undefined' && 'Notification' in window,
      serviceWorkerSupported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
      pushManagerSupported: typeof window !== 'undefined' && 'PushManager' in window,
      standalonePwa: isStandalonePwa(),
      iosDevice: isIOSDevice(),
      testStage: String(stage || '').slice(0, 80),
      failureReason: String(detail || '').slice(0, 240),
    },
  });
  navigate('support', { incidentId: diagnostic.incidentId });
}

async function guideNotificationPermission({
  state = '',
  stage = '',
  detail = '',
  reason = '',
  retryCheck = null,
} = {}) {
  const resolvedState = state || getWebNotificationPermissionState();
  const result = await openNotificationPermissionGuide({
    state: resolvedState,
    reason,
    retryCheck,
  });
  if (result?.askSupport) {
    openNotificationSupport({
      state: resolvedState,
      stage,
      detail: detail || reason,
    });
  }
  return result;
}

async function loadSettingsWallpaper() {
  const prefs = await loadAppearancePrefs();
  const { theme } = getActiveTheme(prefs);
  return theme;
}

function applyFadedWallpaper(page, theme) {
  applySettingsWallpaperPreview(page, theme);
}

function formatClockTime(ts) {
  const d = new Date(Number(ts) || 0);
  if (Number.isNaN(d.getTime()) || !ts) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 应用内确认后再打开文件选择器。
 * 不能用 window.confirm 再 input.click()：雨见等会在系统确认框后丢掉用户手势，选文件器打不开；
 * 也不能先选文件再 window.confirm：雨见会在关选择器后静默吞掉 confirm。
 * 必须在「继续」按钮的同一次 click 里同步调用 fileInput.click()。
 */
function confirmThenPickFile(fileInput, {
  title = '确认导入',
  message = '',
  confirmLabel = '继续选择文件',
} = {}) {
  if (!fileInput) return;
  const host = document.getElementById('modal-container');
  if (!host) {
    triggerFileInput(fileInput);
    return;
  }
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center" data-backup-confirm-overlay>
      <div class="modal-sheet scrapbook-card" role="alertdialog" aria-modal="true" data-backup-confirm-sheet>
        <div class="modal-header">
          <h3>${escapeHtml(title)}</h3>
        </div>
        <div class="modal-body" style="font-size:14px;line-height:1.65;color:var(--text-secondary);white-space:pre-wrap;">${escapeHtml(message)}</div>
        <div class="modal-body" style="display:flex;gap:8px;padding-top:0;">
          <button type="button" class="btn btn-outline" data-backup-confirm-cancel style="flex:1;">取消</button>
          <button type="button" class="btn btn-primary" data-backup-confirm-ok style="flex:1;">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    </div>
  `;
  host.querySelector('[data-backup-confirm-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-backup-confirm-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-backup-confirm-cancel]')?.addEventListener('click', close);
  host.querySelector('[data-backup-confirm-ok]')?.addEventListener('click', () => {
    // 先开选文件（保留手势），再关弹层
    try { triggerFileInput(fileInput); } finally { close(); }
  });
}

function openDeferredBackupSaveModal(deferredSave, {
  title = '数据包已整理好',
  summary = '',
  onSaved = null,
} = {}) {
  if (!deferredSave?.requiresSaveGesture || typeof deferredSave.save !== 'function') return false;
  const host = document.getElementById('modal-container');
  if (!host) return false;
  let completed = false;
  const close = ({ discard = true } = {}) => {
    host.classList.remove('active');
    host.innerHTML = '';
    if (discard && !completed) void deferredSave.discard?.();
  };
  const saveHint = isAndroidDevice()
    ? (deferredSave.supportsFileShare
      ? '可直接下载；若浏览器下载停在 0 B，请改用系统分享并选择文件或网盘。'
      : '点「保存到文件」后，浏览器会下载备份文件。')
    : '点「保存到文件」后，在系统面板中选择「存储到文件」。';
  const shareButton = isAndroidDevice() && deferredSave.supportsFileShare
    ? '<button type="button" class="btn btn-outline" data-backup-share-confirm style="flex:1;">系统分享</button>'
    : '';
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center" data-backup-save-overlay>
      <div class="modal-sheet scrapbook-card" role="dialog" aria-modal="true" aria-labelledby="backup-save-title" data-backup-save-sheet>
        <div class="modal-header">
          <h3 id="backup-save-title">${escapeHtml(title)}</h3>
        </div>
        <div class="modal-body" style="font-size:14px;line-height:1.65;color:var(--text-secondary);">
          ${summary ? `<p style="margin:0 0 8px;">${escapeHtml(summary)}</p>` : ''}
          <p style="margin:0;">${saveHint}</p>
        </div>
        <div class="modal-body" style="display:flex;gap:8px;padding-top:0;">
          <button type="button" class="btn btn-outline" data-backup-save-cancel style="flex:1;">取消</button>
          ${shareButton}
          <button type="button" class="btn btn-primary" data-backup-save-confirm style="flex:1;">保存到文件</button>
        </div>
      </div>
    </div>
  `;
  host.querySelector('[data-backup-save-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-backup-save-overlay]')?.addEventListener('click', () => close());
  host.querySelector('[data-backup-save-cancel]')?.addEventListener('click', () => close());
  const runSaveAction = (event, action) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = '正在打开…';
    // 必须在这次 click 里直接调用：iOS 的文件分享不接受整理数据后的旧手势。
    const pending = action();
    Promise.resolve(pending).then((saved) => {
      completed = true;
      close({ discard: false });
      onSaved?.(saved);
    }).catch((err) => {
      button.disabled = false;
      button.textContent = '重新保存';
      showToast(String((err && err.message) || err || '未能打开系统保存'), 6000);
    });
  };
  host.querySelector('[data-backup-save-confirm]')?.addEventListener('click', (event) => {
    runSaveAction(event, () => deferredSave.save());
  });
  host.querySelector('[data-backup-share-confirm]')?.addEventListener('click', (event) => {
    runSaveAction(event, () => deferredSave.share());
  });
  return true;
}

function formatCloudBackupSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 KB';
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function openCloudBackupModal() {
  const host = document.getElementById('modal-container');
  if (!host) return;
  if (host.classList.contains('active') && host.innerHTML.trim()) return;
  const resumedInteraction = readCloudBackupInteraction();
  let prefs = {
    ...getCloudBackupPrefs(),
    ...(resumedInteraction?.draft || {}),
  };
  let pendingGitHubAuth = readPendingGitHubAuthorization();
  let authRun = 0;
  const releaseCriticalActivity = globalThis.__mm_begin_critical_activity__?.('cloud-backup-form');
  keepCloudBackupInteraction(prefs);
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center cloud-backup-overlay">
      <div class="modal-sheet scrapbook-card cloud-backup-sheet" data-cloud-provider="${escapeHtml(prefs.provider)}" role="dialog" aria-modal="true" aria-labelledby="cloud-backup-title">
        <div class="modal-header">
          <h3 id="cloud-backup-title">加密云备份</h3>
          <button type="button" class="btn btn-outline cloud-backup-close" aria-label="关闭">关闭</button>
        </div>
        <div class="modal-body cloud-backup-form">
          <div class="cloud-backup-provider-switch" role="tablist" aria-label="云备份位置">
            <button type="button" role="tab" data-cloud-provider-choice="github">GitHub</button>
            <button type="button" role="tab" data-cloud-provider-choice="webdav">WebDAV</button>
          </div>
          <section class="cloud-backup-provider-panel" data-cloud-provider-panel="github">
            <div class="cloud-backup-github-account"></div>
            <div class="cloud-backup-device" hidden></div>
          </section>
          <section class="cloud-backup-provider-panel" data-cloud-provider-panel="webdav">
            <div class="cloud-backup-webdav-providers" role="list" aria-label="WebDAV 服务商">
              ${WEBDAV_PROVIDER_GUIDES.map((provider) => `
                <button type="button" data-webdav-provider="${escapeHtml(provider.id)}">
                  <span>${escapeHtml(provider.name)}</span>
                  ${provider.badge ? `<small>${escapeHtml(provider.badge)}</small>` : ''}
                </button>
              `).join('')}
            </div>
            <div class="cloud-backup-webdav-guide"></div>
            <button type="button" class="cloud-backup-webdav-tutorial" data-open-webdav-tutorial>网页 / PWA 连接要求</button>
            <label><span>WebDAV 地址</span><input class="appearance-input" data-cloud-field="url" type="url" value="${escapeHtml(prefs.url)}" placeholder="https://dav.example.com/backups/" autocomplete="url" /></label>
            <div class="cloud-backup-fields">
              <label><span data-webdav-username-label>账号</span><input class="appearance-input" data-cloud-field="username" value="${escapeHtml(prefs.username)}" autocomplete="username" /></label>
              <label><span data-webdav-password-label>WebDAV 密码</span><input class="appearance-input" data-cloud-field="password" type="password" value="${escapeHtml(prefs.password)}" autocomplete="current-password" /></label>
            </div>
          </section>
          <label><span>加密密码</span><input class="appearance-input" data-cloud-field="encryptionPassword" type="password" value="${escapeHtml(prefs.encryptionPassword)}" autocomplete="new-password" /></label>
          <div class="cloud-backup-fields">
            <label><span>保留份数</span><input class="appearance-input" data-cloud-field="retention" type="number" min="1" max="30" value="${prefs.retention}" /></label>
            <label><span>间隔（小时）</span><input class="appearance-input" data-cloud-field="intervalHours" type="number" min="6" max="168" value="${prefs.intervalHours}" /></label>
          </div>
          <label class="cloud-backup-auto"><input data-cloud-field="autoEnabled" type="checkbox" ${prefs.autoEnabled ? 'checked' : ''} /><span>自动备份</span></label>
          <div class="cloud-backup-actions">
            <button type="button" class="btn btn-outline" data-cloud-action="test">测试连接</button>
            <button type="button" class="btn btn-outline" data-cloud-action="save">保存</button>
            <button type="button" class="btn btn-outline" data-cloud-action="refresh">刷新列表</button>
            <button type="button" class="btn btn-primary" data-cloud-action="backup">立即备份</button>
          </div>
          <div class="cloud-backup-status" role="status" aria-live="polite"></div>
          <div class="cloud-backup-progress" hidden>
            <div class="cloud-backup-progress-meta">
              <span data-cloud-progress-label></span>
              <span data-cloud-progress-value></span>
            </div>
            <div class="cloud-backup-progress-track" role="progressbar" aria-label="云备份进度" aria-valuemin="0" aria-valuemax="100">
              <span data-cloud-progress-bar></span>
            </div>
          </div>
          <div class="cloud-backup-list"></div>
        </div>
      </div>
    </div>
  `;
  const close = () => {
    authRun += 1;
    clearPendingGitHubAuthorization();
    clearCloudBackupInteraction();
    if (typeof releaseCriticalActivity === 'function') releaseCriticalActivity();
    host.classList.remove('active');
    host.innerHTML = '';
  };
  const sheet = host.querySelector('.cloud-backup-sheet');
  const status = host.querySelector('.cloud-backup-status');
  const progress = host.querySelector('.cloud-backup-progress');
  const progressLabel = host.querySelector('[data-cloud-progress-label]');
  const progressValue = host.querySelector('[data-cloud-progress-value]');
  const progressTrack = host.querySelector('.cloud-backup-progress-track');
  const progressBar = host.querySelector('[data-cloud-progress-bar]');
  const list = host.querySelector('.cloud-backup-list');
  const githubAccount = host.querySelector('.cloud-backup-github-account');
  const webDavGuide = host.querySelector('.cloud-backup-webdav-guide');
  const webDavUrl = host.querySelector('[data-cloud-field="url"]');
  const webDavUsernameLabel = host.querySelector('[data-webdav-username-label]');
  const webDavPasswordLabel = host.querySelector('[data-webdav-password-label]');
  const githubDevice = host.querySelector('.cloud-backup-device');
  let selectedWebDavProvider = inferWebDavProvider(prefs.url);
  const setStatus = (message, error = false) => {
    if (!status) return;
    status.textContent = String(message || '');
    status.classList.toggle('is-error', error);
  };
  const hideProgress = () => {
    if (progress) progress.hidden = true;
  };
  const setProgress = ({ label = '', loadedBytes, totalBytes, percent, indeterminate = false }) => {
    if (!progress || !progressTrack || !progressBar) return;
    progress.hidden = false;
    progress.classList.toggle('is-indeterminate', indeterminate);
    const total = Math.max(0, Number(totalBytes) || 0);
    const loaded = Math.max(0, Number(loadedBytes) || 0);
    const resolvedPercent = Number.isFinite(Number(percent))
      ? Number(percent)
      : (total > 0 ? (loaded / total) * 100 : 0);
    const value = Math.max(0, Math.min(100, resolvedPercent));
    if (progressLabel) progressLabel.textContent = String(label || '');
    if (progressValue) {
      progressValue.textContent = indeterminate
        ? '处理中'
        : (total > 0
          ? `${formatCloudBackupSize(loaded)} / ${formatCloudBackupSize(total)} · ${Math.round(value)}%`
          : `${Math.round(value)}%`);
    }
    progressBar.style.width = indeterminate ? '34%' : `${value}%`;
    if (indeterminate) {
      progressTrack.removeAttribute('aria-valuenow');
      progressTrack.setAttribute('aria-valuetext', `${label}，处理中`);
    } else {
      progressTrack.setAttribute('aria-valuenow', String(Math.round(value)));
      progressTrack.removeAttribute('aria-valuetext');
    }
  };
  const renderTransferProgress = ({
    phase,
    kind,
    loadedBytes,
    totalBytes,
    storeName: progressStoreName,
    rows: progressRows,
    importPhase,
    stage,
    index: progressIndex,
    total: progressTotal,
    partDeleted,
    partTotal,
    retry,
    retries,
  }) => {
    const packName = kind === 'assets' ? '资源包' : '数据包';
    if (phase === 'export') {
      setStatus(`正在整理${packName}…`);
      setProgress({ label: `整理${packName}`, indeterminate: true });
    } else if (phase === 'checksum') {
      setStatus(`正在校验${packName}…`);
      setProgress({
        label: `校验${packName}`,
        loadedBytes,
        totalBytes,
        indeterminate: !(Number(totalBytes) > 0),
      });
    } else if (phase === 'encrypt') {
      setStatus(`正在加密${packName}…`);
      setProgress({
        label: `加密${packName}`,
        loadedBytes,
        totalBytes,
        indeterminate: !(Number(totalBytes) > 0),
      });
    } else if (phase === 'upload') {
      setStatus(`正在上传${packName}…`);
      setProgress({ label: `上传${packName}`, loadedBytes, totalBytes });
    } else if (phase === 'download') {
      setStatus(`正在下载${packName}…`);
      setProgress({ label: `下载${packName}`, loadedBytes, totalBytes });
    } else if (phase === 'download-retry') {
      const retryText = `${Math.max(1, Number(retry) || 1)}/${Math.max(1, Number(retries) || 1)}`;
      setStatus(`网络波动，正在重试${packName}（${retryText}）…`);
      setProgress({ label: `重试下载${packName}`, loadedBytes, totalBytes });
    } else if (phase === 'decrypt') {
      setStatus(`正在解密并校验${packName}…`);
      setProgress({
        label: `解密${packName}`,
        loadedBytes,
        totalBytes,
        indeterminate: !(Number(totalBytes) > 0),
      });
    } else if (phase === 'restore-checksum') {
      setStatus(`正在核验${packName}完整性…`);
      setProgress({
        label: `核验${packName}`,
        loadedBytes,
        totalBytes,
        indeterminate: !(Number(totalBytes) > 0),
      });
    } else if (phase === 'import') {
      const storeName = String(progressStoreName || '');
      const rows = Number(progressRows || 0);
      const storeHint = storeName ? ` · ${storeName}${rows ? ` ${rows} 条` : ''}` : '';
      const preflight = String(importPhase || '').startsWith('preflight');
      setStatus(`${preflight ? '正在预检' : '正在写入'}${packName}${storeHint}…`);
      setProgress({
        label: `${preflight ? '预检' : '写入'}${packName}${storeHint}`,
        loadedBytes,
        totalBytes,
        indeterminate: !(Number(totalBytes) > 0) || String(importPhase || '') === 'start',
      });
    } else if (phase === 'package-complete') {
      setStatus(`${packName}已写入，正在处理下一项…`);
      setProgress({ label: `${packName}已完成`, percent: 100 });
    } else if (phase === 'delete') {
      const total = Math.max(1, Number(progressTotal) || 1);
      const index = Math.max(0, Number(progressIndex) || 0);
      if (stage === 'manifest-read') {
        setStatus('正在读取云端备份清单…');
        setProgress({ label: '准备删除', indeterminate: true });
      } else if (stage === 'part') {
        const currentPartTotal = Math.max(1, Number(partTotal) || 1);
        const partDone = Math.max(0, Number(partDeleted) || 0);
        const percent = ((index + Math.min(1, partDone / currentPartTotal)) / total) * 100;
        setStatus(`正在删除云端分片 ${partDone}/${currentPartTotal}…`);
        setProgress({ label: '删除云端备份', percent });
      } else if (stage === 'complete') {
        setStatus('云端备份已删除');
        setProgress({ label: '删除完成', percent: 100 });
      } else {
        setStatus(stage === 'manifest' ? '正在删除云端清单…' : `正在删除云端文件 ${index + 1}/${total}…`);
        setProgress({ label: '删除云端备份', percent: (index / total) * 100 });
      }
    }
  };
  const readConfig = () => ({
    ...prefs,
    provider: sheet.dataset.cloudProvider === 'webdav' ? 'webdav' : 'github',
    url: sheet.querySelector('[data-cloud-field="url"]')?.value || '',
    username: sheet.querySelector('[data-cloud-field="username"]')?.value || '',
    password: sheet.querySelector('[data-cloud-field="password"]')?.value || '',
    encryptionPassword: sheet.querySelector('[data-cloud-field="encryptionPassword"]')?.value || '',
    retention: Number(sheet.querySelector('[data-cloud-field="retention"]')?.value || 5),
    intervalHours: Number(sheet.querySelector('[data-cloud-field="intervalHours"]')?.value || 24),
    autoEnabled: !!sheet.querySelector('[data-cloud-field="autoEnabled"]')?.checked,
  });
  const preserveInteraction = () => keepCloudBackupInteraction(readConfig());
  const renderGitHubAccount = () => {
    if (!githubAccount) return;
    const connected = !!prefs.githubToken && !!prefs.githubOwner;
    githubAccount.innerHTML = connected
      ? `<div class="cloud-backup-github-identity">
          <div><strong>${escapeHtml(prefs.githubOwner)}</strong><small>${escapeHtml(prefs.githubRepo || 'marshmallow-cloud-backup')}</small></div>
          <button type="button" class="btn btn-outline" data-cloud-action="disconnect-github">断开</button>
        </div>`
      : `<button type="button" class="btn btn-primary cloud-backup-github-connect" data-cloud-action="connect-github">连接 GitHub</button>`;
  };
  const renderWebDavGuide = (providerId, { applyUrl = false } = {}) => {
    const provider = getWebDavProviderGuide(providerId);
    selectedWebDavProvider = provider.id;
    sheet.querySelectorAll('[data-webdav-provider]').forEach((button) => {
      const active = button.dataset.webdavProvider === provider.id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (applyUrl && provider.url && webDavUrl) webDavUrl.value = provider.url;
    if (webDavUsernameLabel) webDavUsernameLabel.textContent = provider.usernameLabel;
    if (webDavPasswordLabel) webDavPasswordLabel.textContent = provider.passwordLabel;
    if (!webDavGuide) return;
    webDavGuide.innerHTML = `
      <span>${escapeHtml(provider.summary)}</span>
      ${provider.officialUrl
        ? `<a href="${escapeHtml(provider.officialUrl)}" target="_blank" rel="noopener">${escapeHtml(provider.officialLabel)}</a>`
        : '<button type="button" data-open-webdav-tutorial>查看连接教程</button>'}
    `;
  };
  const selectProvider = (provider) => {
    const next = provider === 'webdav' ? 'webdav' : 'github';
    sheet.dataset.cloudProvider = next;
    sheet.querySelectorAll('[data-cloud-provider-choice]').forEach((button) => {
      const active = button.dataset.cloudProviderChoice === next;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    sheet.querySelectorAll('[data-cloud-provider-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.cloudProviderPanel !== next;
    });
    list.innerHTML = '';
    setStatus('');
    hideProgress();
    preserveInteraction();
  };
  const setBusy = (busy) => {
    sheet.querySelectorAll('button:not(.cloud-backup-close)').forEach((button) => { button.disabled = busy; });
  };
  const renderList = (backups) => {
    if (!list) return;
    if (!backups.length) {
      list.innerHTML = '<div class="cloud-backup-empty">暂无云端备份</div>';
      return;
    }
    list.innerHTML = backups.map((backup) => {
      const total = (backup.files || []).reduce((sum, file) => sum + Number(file.encryptedSize || 0), 0);
      const time = backup.createdAt ? new Date(backup.createdAt).toLocaleString() : '时间未知';
      const ready = backup.complete && backup.status === 'complete';
      const failure = String(backup.error || '').trim();
      const stateText = ready
        ? formatCloudBackupSize(total)
        : (failure || (backup.status === 'uploading' ? '上传被中断' : '备份未完成'));
      return `
        <div class="cloud-backup-item">
          <div><strong>${escapeHtml(time)}</strong><small title="${escapeHtml(stateText)}">${escapeHtml(stateText)}</small></div>
          <div class="cloud-backup-item-actions">
            <button type="button" class="btn btn-outline" data-cloud-restore="${escapeHtml(backup.id)}" ${ready ? '' : 'disabled'}>恢复</button>
            <button type="button" class="btn btn-outline" data-cloud-delete="${escapeHtml(backup.id)}">删除</button>
          </div>
        </div>
      `;
    }).join('');
  };
  const refresh = async () => {
    const config = readConfig();
    keepCloudBackupInteraction(config);
    hideProgress();
    setStatus('正在读取云端列表…');
    const backups = await listCloudBackups(config);
    renderList(backups);
    setStatus(`共 ${backups.length} 份`);
  };
  const waitForGitHubAuthorization = async (device) => {
    const run = ++authRun;
    const deadline = Number(device.expiresAt || 0)
      || Date.now() + Math.max(60, Number(device.expiresIn) || 900) * 1000;
    let interval = device.interval * 1000;
    while (run === authRun && Date.now() < deadline && host.classList.contains('active')) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      if (run !== authRun) return;
      const result = await pollGitHubDeviceAuthorization(device.deviceCode);
      if (result.slowDown) interval += 5000;
      if (!result.authorized) {
        if (result.pending) continue;
        clearPendingGitHubAuthorization();
        pendingGitHubAuth = null;
        throw new Error(result.error || 'GitHub 授权未完成');
      }
      clearPendingGitHubAuthorization();
      pendingGitHubAuth = null;
      setStatus('正在创建私有备份仓库…');
      const connected = await connectGitHubBackup(result.accessToken, prefs.githubRepo);
      prefs = saveCloudBackupPrefs({ ...readConfig(), provider: 'github', ...connected });
      renderGitHubAccount();
      if (githubDevice) {
        githubDevice.hidden = true;
        githubDevice.innerHTML = '';
      }
      setStatus('GitHub 已连接');
      await refresh();
      return;
    }
    if (run === authRun) {
      clearPendingGitHubAuthorization();
      pendingGitHubAuth = null;
      throw new Error('GitHub 授权码已过期，请重新连接');
    }
  };
  const renderPendingGitHubAuthorization = (device) => {
    if (!githubDevice || !device) return;
    githubDevice.hidden = false;
    githubDevice.innerHTML = `
      <strong class="cloud-backup-device-code">${escapeHtml(device.userCode)}</strong>
      <a class="btn btn-primary" href="${escapeHtml(device.verificationUri)}" target="_blank" rel="noopener">前往 GitHub 授权</a>
      <button type="button" class="btn btn-outline" data-cloud-copy-code="${escapeHtml(device.userCode)}">复制验证码</button>
    `;
  };
  renderGitHubAccount();
  renderWebDavGuide(selectedWebDavProvider);
  selectProvider(prefs.provider);
  if (pendingGitHubAuth && !prefs.githubToken) {
    renderPendingGitHubAuthorization(pendingGitHubAuth);
    setStatus('已恢复 GitHub 授权，正在等待完成…');
    waitForGitHubAuthorization(pendingGitHubAuth)
      .catch((error) => setStatus(error?.message || String(error), true));
  } else if (pendingGitHubAuth) {
    clearPendingGitHubAuthorization();
    pendingGitHubAuth = null;
  }
  sheet.addEventListener('click', async (event) => {
    const webDavProvider = event.target.closest('[data-webdav-provider]')?.dataset.webdavProvider;
    if (webDavProvider) {
      renderWebDavGuide(webDavProvider, { applyUrl: true });
      webDavUrl?.focus();
      return;
    }
    if (event.target.closest('[data-open-webdav-tutorial]')) {
      close();
      navigate('tutorial', { section: 'backup' });
      return;
    }
    const providerChoice = event.target.closest('[data-cloud-provider-choice]')?.dataset.cloudProviderChoice;
    if (providerChoice) {
      selectProvider(providerChoice);
      return;
    }
    const action = event.target.closest('[data-cloud-action]')?.dataset.cloudAction;
    const restoreId = event.target.closest('[data-cloud-restore]')?.dataset.cloudRestore;
    const deleteId = event.target.closest('[data-cloud-delete]')?.dataset.cloudDelete;
    if (!action && !restoreId && !deleteId) return;
    const config = readConfig();
    hideProgress();
    setBusy(true);
    try {
      if (action === 'connect-github') {
        setStatus('正在申请 GitHub 授权码…');
        const device = await startGitHubDeviceAuthorization();
        pendingGitHubAuth = savePendingGitHubAuthorization(device);
        keepCloudBackupInteraction(config);
        renderPendingGitHubAuthorization(pendingGitHubAuth || device);
        setStatus('在 GitHub 完成授权后会自动继续');
        setBusy(false);
        waitForGitHubAuthorization(pendingGitHubAuth || device).catch((error) => setStatus(error?.message || String(error), true));
      } else if (action === 'disconnect-github') {
        authRun += 1;
        if (!window.confirm('断开 GitHub？云端仓库和已有备份不会被删除。')) return;
        clearPendingGitHubAuthorization();
        pendingGitHubAuth = null;
        prefs = saveCloudBackupPrefs({
          ...config,
          githubToken: '',
          githubOwner: '',
          githubBranch: 'main',
          githubRepoUrl: '',
          autoEnabled: false,
        });
        renderGitHubAccount();
        renderList([]);
        setStatus('已断开 GitHub');
      } else if (action === 'save') {
        prefs = saveCloudBackupPrefs(config);
        setStatus('已保存');
      } else if (action === 'test') {
        await testCloudBackupConnection(config);
        setStatus('连接成功');
      } else if (action === 'refresh') {
        await refresh();
      } else if (action === 'backup') {
        prefs = saveCloudBackupPrefs(config);
        setStatus('正在整理并加密…');
        const result = await createCloudBackup(config, {
          onProgress: renderTransferProgress,
        });
        const completionMessage = result.cleanupErrors?.length ? '备份完成，旧备份清理失败' : '备份完成';
        await refresh();
        setProgress({ label: '云备份完成', percent: 100 });
        setStatus(completionMessage);
      } else if (restoreId) {
        if (!window.confirm('恢复会替换当前数据，再合并资源包。继续？')) return;
        saveCloudBackupPrefs(config);
        setStatus('正在下载并校验…');
        const restored = await restoreCloudBackup(restoreId, config, {
          onProgress: renderTransferProgress,
        });
        setProgress({ label: '恢复完成', percent: 100 });
        const missingAssets = Number(restored?.assetIntegrity?.missing || 0);
        if (missingAssets > 0) {
          setStatus(`恢复完成，但云端备份缺少 ${missingAssets} 项美化图片`);
          window.alert(`数据恢复已完成，但这份云端备份缺少 ${missingAssets} 项美化图片。\n\n缺失图片无法由当前备份重新生成；如旧设备仍保留原图，请在修复后的版本重新创建云备份。`);
        } else {
          setStatus('恢复完成，正在刷新');
        }
        clearCloudBackupInteraction();
        if (typeof releaseCriticalActivity === 'function') releaseCriticalActivity();
        setTimeout(() => window.location.reload(), 800);
      } else if (deleteId) {
        if (!window.confirm('删除这份云端备份？')) return;
        setStatus('正在准备删除云端备份…');
        setProgress({ label: '准备删除', indeterminate: true });
        await deleteCloudBackup(deleteId, config, {
          onProgress: renderTransferProgress,
        });
        await refresh();
        setProgress({ label: '删除完成', percent: 100 });
        setStatus('云端备份已删除');
      }
    } catch (error) {
      setStatus(error?.message || String(error), true);
    } finally {
      setBusy(false);
    }
  });
  sheet.addEventListener('click', async (event) => {
    const code = event.target.closest('[data-cloud-copy-code]')?.dataset.cloudCopyCode;
    if (!code) return;
    try {
      await copyTextToClipboard(code);
      setStatus('验证码已复制');
    } catch (error) {
      setStatus(error?.message || '复制失败', true);
    }
  });
  sheet.addEventListener('input', preserveInteraction);
  sheet.addEventListener('change', preserveInteraction);
  sheet.addEventListener('click', (event) => event.stopPropagation());
  host.querySelector('.cloud-backup-overlay')?.addEventListener('click', close);
  host.querySelector('.cloud-backup-close')?.addEventListener('click', close);
  const initialReady = prefs.provider === 'webdav' ? !!prefs.url : !!prefs.githubToken;
  if (initialReady) refresh().catch((error) => setStatus(error?.message || String(error), true));
}

function openGenerationRelayModal() {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const prefs = getGenerationRelayPrefs();
  const kindLabel = prefs.kind === 'cloudflare-workers'
    ? 'Cloudflare 中继已接入'
    : (prefs.enabled && prefs.baseUrl ? '已配置自建中继' : '推荐部署到自己的 Cloudflare');
  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center generation-relay-overlay">
      <div class="modal-sheet scrapbook-card cloud-backup-sheet" role="dialog" aria-modal="true" aria-labelledby="generation-relay-title">
        <div class="modal-header">
          <h3 id="generation-relay-title">后台任务中继</h3>
          <button type="button" class="btn btn-outline generation-relay-close" aria-label="关闭">关闭</button>
        </div>
        <div class="modal-body cloud-backup-form">
          <p class="settings-group-hint">${escapeHtml(kindLabel)} · 任务跑在你自己的 Cloudflare；模型 API Key 仍跟 App 当前线路走。</p>
          <p class="settings-group-hint">网络要求较高：workers.dev 在部分网络下可能无法稳定直连，可能需要开启代理；也可以为 Worker 绑定可直连的自定义域名。手机代理只改善 App 到中继这一段，Cloudflare 到模型 API 请用「测试完整线路」确认。</p>
          <ol class="settings-group-hint generation-relay-steps">
            <li>先点「生成并复制访问令牌」——不用自己编 32 位字符。</li>
            <li>再「部署到 Cloudflare」。若部署页没出现 ADMIN_TOKEN，到 Worker → Settings → Variables and Secrets 新建同名 Secret，粘贴刚才复制的令牌。</li>
            <li>打开中继网址的 <code>/setup</code>，粘贴同一令牌，复制配置回来导入并测试。测试会校验地址、令牌和加密是否对上（改过 Cloudflare ADMIN_TOKEN 后必须与 App 同一串）。</li>
            <li>需要 App 被关掉也能弹窗时，再点「开启完成通知」（浏览器 / PWA 的 Web Push）。安卓 APK 不走 Web Push：云端计划到点会用系统闹钟唤醒 App 取回结果并弹通知，需在系统设置里允许「闹钟与提醒」、并把 App 加入后台运行白名单。已部署的 Worker 需重新部署并执行最新迁移后才有推送接口。</li>
          </ol>
          <div class="cloud-backup-actions">
            <button type="button" class="btn btn-primary" data-relay-action="gen-token">生成并复制访问令牌</button>
            <button type="button" class="btn btn-outline" data-relay-action="copy-token">再复制令牌</button>
          </div>
          <div class="cloud-backup-actions">
            <button type="button" class="btn btn-primary" data-relay-action="deploy-cf">部署到 Cloudflare</button>
          </div>
          <label><span>粘贴导入配置</span><textarea class="appearance-input" data-relay-field="importText" rows="3" placeholder="部署完成后打开 /setup 页复制的 mmrelay1.… 整段配置"></textarea></label>
          <div class="cloud-backup-actions">
            <button type="button" class="btn btn-outline" data-relay-action="import">导入配置</button>
          </div>
          <label><span>中继地址</span><input class="appearance-input" data-relay-field="baseUrl" type="url" value="${escapeHtml(prefs.baseUrl)}" placeholder="https://xxx.workers.dev" autocomplete="url" /></label>
          <label><span>访问令牌</span><input class="appearance-input" data-relay-field="token" type="text" value="${escapeHtml(prefs.token)}" autocomplete="off" spellcheck="false" /></label>
          <div class="cloud-backup-fields">
            <label><span>请求保留（秒）</span><input class="appearance-input" data-relay-field="requestTtlSeconds" type="number" min="30" max="86400" value="${prefs.requestTtlSeconds}" /></label>
            <label><span>结果保留（秒）</span><input class="appearance-input" data-relay-field="resultTtlSeconds" type="number" min="30" max="604800" value="${prefs.resultTtlSeconds}" /></label>
          </div>
          <label class="cloud-backup-auto"><input data-relay-field="enabled" type="checkbox" ${prefs.enabled ? 'checked' : ''} /><span>生成时使用中继</span></label>
          <div class="cloud-backup-status" role="status" aria-live="polite"></div>
          <div class="cloud-backup-actions">
            <button type="button" class="btn btn-outline" data-relay-action="test">测试连接</button>
            <button type="button" class="btn btn-outline" data-relay-action="test-full">测试完整线路</button>
            <button type="button" class="btn btn-primary" data-relay-action="save">保存</button>
            <button type="button" class="btn btn-outline" data-relay-action="${prefs.pushEnabled ? 'unsubscribe' : 'subscribe'}">${prefs.pushEnabled ? '关闭完成通知' : '开启完成通知'}</button>
          </div>
        </div>
      </div>
    </div>
  `;
  const sheet = host.querySelector('.cloud-backup-sheet');
  host.classList.add('active');
  // 先把完整 DOM 挂载，再从 display:none 切到可见，并同步结算一次布局。
  // 部分 Android WebView 否则会保留空容器的首帧，直到下一次触摸才绘制按钮。
  host.getBoundingClientRect();
  sheet?.getBoundingClientRect();
  const status = host.querySelector('.cloud-backup-status');
  const syncFields = (next) => {
    const baseUrl = sheet.querySelector('[data-relay-field="baseUrl"]');
    const token = sheet.querySelector('[data-relay-field="token"]');
    const requestTtl = sheet.querySelector('[data-relay-field="requestTtlSeconds"]');
    const resultTtl = sheet.querySelector('[data-relay-field="resultTtlSeconds"]');
    const enabled = sheet.querySelector('[data-relay-field="enabled"]');
    if (baseUrl) baseUrl.value = next.baseUrl || '';
    if (token) token.value = next.token || '';
    if (requestTtl) requestTtl.value = String(next.requestTtlSeconds || 900);
    if (resultTtl) resultTtl.value = String(next.resultTtlSeconds || 3600);
    if (enabled) enabled.checked = next.enabled === true;
  };
  const readPrefs = () => ({
    ...getGenerationRelayPrefs(),
    baseUrl: sheet.querySelector('[data-relay-field="baseUrl"]')?.value || '',
    token: sheet.querySelector('[data-relay-field="token"]')?.value || '',
    requestTtlSeconds: Number(sheet.querySelector('[data-relay-field="requestTtlSeconds"]')?.value || 900),
    resultTtlSeconds: Number(sheet.querySelector('[data-relay-field="resultTtlSeconds"]')?.value || 3600),
    enabled: !!sheet.querySelector('[data-relay-field="enabled"]')?.checked,
  });
  const setStatus = (message, isError = false) => {
    status.textContent = String(message || '');
    status.classList.toggle('is-error', isError);
    try {
      status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (_) {}
  };
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  sheet.addEventListener('click', async (event) => {
    event.stopPropagation();
    const action = event.target.closest('[data-relay-action]')?.dataset.relayAction;
    if (!action) return;
    if (action === 'gen-token') {
      try {
        const token = createAndRememberRelayAdminToken();
        const tokenInput = sheet.querySelector('[data-relay-field="token"]');
        if (tokenInput) tokenInput.value = token;
        const copied = await copyTextToClipboard(token);
        setStatus(copied
          ? '已生成并复制访问令牌。下一步点「部署到 Cloudflare」，在 Cloudflare 里把 ADMIN_TOKEN 设成这一串。'
          : '已生成访问令牌并填入下方；复制失败时可点「再复制令牌」。');
        showToast(copied ? '访问令牌已复制' : '令牌已生成，请手动复制');
      } catch (error) {
        setStatus(error?.message || String(error), true);
      }
      return;
    }
    if (action === 'copy-token') {
      const token = String(sheet.querySelector('[data-relay-field="token"]')?.value || '').trim();
      if (!token) {
        setStatus('还没有访问令牌，请先点「生成并复制访问令牌」。', true);
        return;
      }
      const copied = await copyTextToClipboard(token);
      setStatus(copied ? '访问令牌已复制到剪贴板。' : '复制失败，请长按下方「访问令牌」手动复制。', !copied);
      if (copied) showToast('访问令牌已复制');
      return;
    }
    if (action === 'deploy-cf') {
      let token = String(sheet.querySelector('[data-relay-field="token"]')?.value || '').trim();
      if (!token) {
        token = createAndRememberRelayAdminToken();
        const tokenInput = sheet.querySelector('[data-relay-field="token"]');
        if (tokenInput) tokenInput.value = token;
        await copyTextToClipboard(token);
      }
      openCloudflareRelayDeploy();
      setStatus('已打开部署页。若未出现 ADMIN_TOKEN 输入框：Worker → Settings → Variables and Secrets → 添加 Secret 名 ADMIN_TOKEN，粘贴本页令牌。部署后打开 /setup 用同一令牌生成配置并导入。');
      return;
    }
    const buttons = [...sheet.querySelectorAll('button')];
    buttons.forEach((button) => { button.disabled = true; });
    const next = readPrefs();
    try {
      if (action === 'import') {
        const raw = sheet.querySelector('[data-relay-field="importText"]')?.value || '';
        const imported = importGenerationRelayConfig(raw);
        syncFields(imported);
        setStatus('已导入并保存，可点「测试连接」');
        showToast('配置已导入');
      } else if (action === 'test') {
        if (!String(next.baseUrl || '').trim()) {
          throw new Error('请先填写中继地址，或从 /setup 导入配置');
        }
        setStatus('正在测试连接与加密自检…');
        showToast('正在测试…');
        const health = await testGenerationRelay(next);
        saveGenerationRelayPrefs(next);
        const kind = health?.kind === 'cloudflare-workers' ? 'Cloudflare' : '自建';
        const crypto = health?.cryptoCheck;
        const cryptoText = crypto?.ok === true
          ? ' · 加密自检通过'
          : (crypto?.skipped ? ' · 加密自检跳过（中继较旧，建议重新部署模板）' : '');
        const okText = `连接成功（${kind}${health?.supportsDynamicUpstream ? ' · API 随 App 切换' : ''}${cryptoText}）`;
        setStatus(okText);
        showToast(crypto?.ok === true ? '连接成功，加密自检通过' : '连接成功');
      } else if (action === 'test-full') {
        if (!String(next.baseUrl || '').trim()) {
          throw new Error('请先填写中继地址，或从 /setup 导入配置');
        }
        setStatus('正在走完整线路：App → 中继 → 当前模型 API…');
        showToast('正在测试完整线路…');
        const config = await getConfig();
        const upstreamUrl = buildApiUrl(config.baseUrl, '/v1/chat/completions');
        if (!/^https?:\/\//i.test(upstreamUrl)) {
          throw new Error('当前聊天模型不是可供云端访问的完整 http(s) 地址');
        }
        const result = await testGenerationRelayFullPath({
          prefs: { ...next, enabled: true },
          model: config.model,
          upstream: {
            url: upstreamUrl,
            apiKey: config.apiKey,
            customHeaders: config.customHeaders || {},
          },
        });
        setStatus(`完整线路可用（${result.model || config.model} · 已收到模型响应）`);
        showToast('完整线路测试通过');
      } else if (action === 'save') {
        saveGenerationRelayPrefs(next);
        setStatus('已保存');
        showToast('已保存');
      } else if (action === 'subscribe') {
        saveGenerationRelayPrefs(next);
        await subscribeGenerationRelayPush(next);
        setStatus('完成通知已开启');
        showToast('完成通知已开启');
        event.target.textContent = '关闭完成通知';
        event.target.dataset.relayAction = 'unsubscribe';
      } else if (action === 'unsubscribe') {
        await unsubscribeGenerationRelayPush(next);
        setStatus('完成通知已关闭');
        showToast('完成通知已关闭');
        event.target.textContent = '开启完成通知';
        event.target.dataset.relayAction = 'subscribe';
      }
    } catch (error) {
      const message = error?.message || String(error);
      setStatus(message, true);
      showToast(message);
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  });
  host.querySelector('.generation-relay-overlay')?.addEventListener('click', close);
  host.querySelector('.generation-relay-close')?.addEventListener('click', close);
}

const KEEPALIVE_PANEL_KEY = 'mm_settings_keepalive_open';

function isKeepAlivePanelOpen() {
  try {
    return sessionStorage.getItem(KEEPALIVE_PANEL_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function setKeepAlivePanelOpen(open) {
  try {
    sessionStorage.setItem(KEEPALIVE_PANEL_KEY, open ? '1' : '0');
  } catch (_) { /* ignore */ }
}

/**
 * 系统媒体控制/通知栏图标在 iOS、Android 上都不保证稳定显示是否在播放静音音频，
 * 不能作为「有没有真的在保活」的判断依据。这里改成展示应用自己的确认时间戳：
 * 只要这个时间点持续往前走（尤其是切到后台一段时间再回来看仍在更新），
 * 就说明静音音频没有被系统悄悄掐断，比系统 UI 有没有出现图标更可信。
 */
function describeSilentAudioHint(keepAlive, runtime) {
  if (!keepAlive.silentAudio) return '建议开启 · 需配合后台活跃';
  if (!keepAlive.enabled) return '需同时开启「后台活跃」';
  if (runtime.silentAudioSuspended) return '音乐播放中已暂停';
  if (runtime.silentAudioActive) {
    const at = formatClockTime(runtime.silentAudioLastConfirmedAt);
    return at ? `运行中 · 已确认 ${at}` : '静音音频运行中';
  }
  if (keepAlive.silentAudioMode === 'generation' && !runtime.silentAudioArmed) {
    return '待命中 · 生成回复时自动运行';
  }
  return '已开启，点开关重试激活';
}

function describeSilentAudioModeHint(keepAlive) {
  return keepAlive.silentAudioMode === 'always'
    ? '常驻后台 · 外部音频播放时自动让路'
    : '仅生成期间 · 空闲不占系统音轨';
}

/** 折叠头摘要：一眼看出保活是否就绪、还缺哪一步 */
function describeKeepAliveSummary(keepAlive, runtime, nativeKeepAlive = {}) {
  if (!keepAlive?.enabled) return '未开启 · 自动消息切后台可能中断';
  const parts = ['后台活跃已开'];
  if (keepAlive.silentAudio) {
    if (runtime?.silentAudioActive) parts.push('静音保活中');
    else if (runtime?.silentAudioSuspended) parts.push('静音保活已暂停');
    else if (keepAlive.silentAudioMode === 'generation' && !runtime?.silentAudioArmed) parts.push('静音保活待命');
    else parts.push('静音保活待激活');
  } else {
    parts.push('建议开静音保活');
  }
  if (keepAlive.notifyOnAutoChat) parts.push('通知已开');
  if (nativeKeepAlive?.native && !nativeKeepAlive.batteryOptimizationIgnored) {
    parts.push('建议放行省电');
  }
  return parts.join(' · ');
}

async function pickRegionIdsForExport(plan = {}) {
  const allMsg = [
    formatRegionBackupPlanText(plan),
    '',
    '优先推荐「数据包 + 资源包」。区域备份为兜底。',
    `导出全部 ${plan.fileCount || 0} 个区域文件？`,
    '选「取消」可逐个勾选区域。',
  ].join('\n');
  if (window.confirm(allMsg)) return null;
  const picked = [];
  for (const region of plan.regions || []) {
    const partHint = region.parts > 1 ? `（${region.parts} 个分片）` : '';
    if (window.confirm(`导出「${region.label}」${partHint}？`)) picked.push(region.id);
  }
  return picked;
}

/** 这些厂商在电池优化之外还有独立的自启动 / 后台白名单，放行省电后仍可能被清理 */
function isAggressiveOemManufacturer(manufacturer = '') {
  return /xiaomi|redmi|huawei|honor|oppo|realme|oneplus|vivo|iqoo|meizu/i.test(String(manufacturer || ''));
}

function refreshKeepAliveHints(container, keepAlive, runtime, { native = false, nativeStatus = null } = {}) {
  const oneclick = container.querySelector('.settings-keepalive-oneclick');
  if (oneclick) oneclick.hidden = !!(keepAlive.enabled && keepAlive.silentAudio);
  const silentHint = container.querySelector('.settings-silent-audio-hint');
  if (silentHint) silentHint.textContent = describeSilentAudioHint(keepAlive, runtime);
  const silentModeHint = container.querySelector('.settings-silent-mode-hint');
  if (silentModeHint) silentModeHint.textContent = describeSilentAudioModeHint(keepAlive);
  const summary = container.querySelector('.settings-keepalive-summary');
  if (summary) {
    summary.textContent = describeKeepAliveSummary(keepAlive, runtime, nativeStatus || { native });
  }
  const keepHint = container.querySelector('.settings-keepalive-hint');
  if (!keepHint) return;
  if (!keepAlive.enabled) {
    keepHint.textContent = native ? '原生保活可用 · 自动消息与后台任务需要开启' : '浏览器保活 · 自动消息与后台任务需要开启';
    return;
  }
  const parts = [];
  parts.push('后台任务已启用');
  if (keepAlive.silentAudio && runtime.silentAudioActive) parts.push('静音音频运行中');
  keepHint.textContent = parts.join(' · ');
}

export default async function render(container, params = {}) {
  const requestedFocus = String(params.focus || '').trim();
  const shouldResumeCloudBackup = hasPendingCloudBackupInteraction();
  if (requestedFocus === 'background.keepalive') setKeepAlivePanelOpen(true);
  const storageStatePromise = getStoragePersistenceStatus()
    .catch(() => ({ supported: false, persisted: false }));
  const [
    wallpaperTheme,
    apiState,
    keepAlive,
    nativeKeepAlive,
    chatOutputPrefs,
    notifySoundPrefs,
    quickBallPrefs,
  ] = await Promise.all([
    loadSettingsWallpaper(),
    loadAllActiveConfigs(),
    getBackgroundKeepAliveSettings(),
    getNativeKeepAliveStatus().catch(() => ({ native: false })),
    loadChatOutputPrefs().catch(() => ({ stripTrailingPeriod: false, autoExpandTranslations: false })),
    getMessageNotifySoundPrefs().catch(() => ({ enabled: false, volume: 80, fileName: '', audioDataUrl: '' })),
    loadQuickBallPrefs().catch(() => ({ enabled: false, actions: {} })),
  ]);
  const storageState = { supported: false, persisted: false, pending: true };
  const runtimeStatus = getKeepAliveRuntimeStatus();
  let currentKeepAlive = keepAlive;
  const storageLabel = storageState.pending ? '正在检测' : describeStorageProtectionLabel(storageState);
  const storageDetail = storageState.pending
    ? '聊天与角色资料保存在本机'
    : (storageState.atRiskOfPeriodicEviction
    ? (storageState.usage != null && storageState.quota
      ? `已用 ${formatStorageBytes(storageState.usage)} / ${formatStorageBytes(storageState.quota)} · 标签页易被清库`
      : 'Safari 标签页易被清库，建议主屏幕 + 备份')
    : (storageState.usage != null && storageState.quota
      ? `已用 ${formatStorageBytes(storageState.usage)} / ${formatStorageBytes(storageState.quota)}`
      : '聊天与角色资料保存在本机'));
  const apiReady = !!(apiState.main && apiState.main.model);
  const recentSupportError = loadLastGenerationError();
  const pwaStatus = getPwaInstallStatus();
  const pwaCanInstall = canPromptPwaInstall();
  const pwaInstalled = isStandalonePwa();
  const webNotificationState = getWebNotificationPermissionState();
  const webNotificationUnsupported = !nativeKeepAlive.native && webNotificationState === 'unsupported';
  const legacyIosWebPushUnsupported = isLegacyIosWebPushUnsupported();
  const notificationHint = legacyIosWebPushUnsupported
    ? '需要 iOS 16.4 或更高版本'
    : (isIOSDevice() && !pwaInstalled
      ? '请从主屏幕应用开启'
      : (webNotificationUnsupported
        ? '当前环境不支持'
        : '锁屏 / 切后台时推送新消息'));
  const backupImportSession = getBackupImportSession();
  const backupImportFailed = backupImportSession
    && ['interrupted', 'failed'].includes(backupImportSession.status);
  const backupImportFailureRow = backupImportFailed ? `
    <button type="button" class="scrapbook-list-item settings-row settings-import-failure-details" data-support-target="backup-import">
      <span class="scrapbook-list-icon is-peach">${icon('help')}</span>
      <span class="scrapbook-list-body settings-row-main">
        <strong>上次导入未完成</strong>
        <small>${escapeHtml(backupImportSession.error || `停止在 ${backupImportSession.storeName || backupImportSession.phase || '未知阶段'}`)}</small>
      </span>
      <span class="scrapbook-list-meta settings-row-meta">查看</span>
    </button>` : '';

  const prevScroll = captureScrollerTop(container, '.settings-scroll');
  container.className = 'page scrapbook-page settings-hub-page';
  applyFadedWallpaper(container, wallpaperTheme);
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn settings-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">设置</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="settings-scroll scrapbook-scroll">
      <button type="button" class="settings-assistant-entry">
        <span class="settings-assistant-mark">${icon('help')}</span>
        <span class="settings-assistant-copy">
          <strong>芥末棉花糖</strong>
          <small>${recentSupportError
            ? `最近问题 · ${escapeHtml(recentSupportError.title || recentSupportError.message || '待排查')}`
            : '教程答疑、API 排查与问题反馈'}</small>
        </span>
        <span class="settings-assistant-arrow">${icon('chevron')}</span>
      </button>

      <section class="settings-group settings-connection-group">
        <div class="settings-group-title">连接</div>
        <button type="button" class="scrapbook-list-item settings-row" data-route="settings/api">
          <span class="scrapbook-list-icon">${icon('cloud')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>API 管理</strong>
          </span>
          <span class="scrapbook-list-meta settings-row-meta ${apiReady ? 'is-ready' : ''}">${apiReady ? '已配置' : '未配置'} ${icon('chevron')}</span>
        </button>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">聊天</div>
        <button type="button" class="scrapbook-list-item settings-row" data-route="sound-library">
          <span class="scrapbook-list-icon is-peach">${icon('music')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>音频库</strong>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <label class="scrapbook-list-item settings-row settings-toggle-row">
          <span class="scrapbook-list-icon is-peach">${icon('bubble')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>去掉句尾句号</strong>
            <small>自动去掉气泡结尾多余的「。」</small>
          </span>
          <input type="checkbox" class="settings-strip-period-toggle" ${chatOutputPrefs.stripTrailingPeriod ? 'checked' : ''} />
        </label>
        <label class="scrapbook-list-item settings-row settings-toggle-row">
          <span class="scrapbook-list-icon is-peach">${icon('text')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>自动展开译文</strong>
            <small>已有译文时直接显示，仍可点击按钮收起</small>
          </span>
          <input type="checkbox" class="settings-auto-expand-translations-toggle" ${chatOutputPrefs.autoExpandTranslations ? 'checked' : ''} />
        </label>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">世界</div>
        <button type="button" class="scrapbook-list-item settings-row" data-route="calendar">
          <span class="scrapbook-list-icon is-peach">${icon('calendar')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>日程表 / 世界时间</strong>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">数据</div>
        ${backupImportFailureRow}
        <button type="button" class="scrapbook-list-item settings-row settings-cloud-backup">
          <span class="scrapbook-list-icon is-cream">${icon('cloud')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>加密云备份</strong>
            <small>GitHub / WebDAV</small>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <button type="button" class="scrapbook-list-item settings-row" data-route="settings/backup">
          <span class="scrapbook-list-icon is-cream">${icon('package')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>备份与迁移</strong>
            <small>完整搬家 · 高级分区</small>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <button type="button" class="scrapbook-list-item settings-row settings-storage-persist">
          <span class="scrapbook-list-icon is-cream">${icon('database')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>本地存储保护</strong>
            <small>${storageLabel} · ${storageDetail}</small>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${storageState.persisted ? icon('check') : icon('chevron')}</span>
        </button>
        <button type="button" class="scrapbook-list-item settings-row" data-route="settings/debug-log">
          <span class="scrapbook-list-icon is-cream">${icon('fileText')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>错误日志 / 反馈包</strong>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <button type="button" class="scrapbook-list-item settings-row settings-open-recovery">
          <span class="scrapbook-list-icon is-cream">${icon('database')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>急救诊断</strong>
            <small>扫描本地数据、导出急救包</small>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <button type="button" class="scrapbook-list-item settings-row" data-route="settings/data-hygiene">
          <span class="scrapbook-list-icon is-cream">${icon('database')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>存储与数据</strong>
            <small>空间分布、媒体占用与残留清理</small>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <button type="button" class="scrapbook-list-item settings-row" data-route="extensions">
          <span class="scrapbook-list-icon is-peach">${icon('text')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>扩展库</strong>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <button type="button" class="scrapbook-list-item settings-row" data-route="mcp">
          <span class="scrapbook-list-icon is-blue">${icon('database')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>MCP 连接</strong>
            <small>实验功能 · 尚未人工实测</small>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">应用</div>
        <button type="button" class="scrapbook-list-item settings-row" data-route="settings/lock-screen">
          <span class="scrapbook-list-icon is-peach">${icon('shield')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>应用锁屏</strong>
            <small>四位密码与锁屏壁纸</small>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <button type="button" class="scrapbook-list-item settings-row settings-generation-relay">
          <span class="scrapbook-list-icon is-cream">${icon('cloud')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>后台任务中继</strong>
            <small>${(() => {
              const relay = getGenerationRelayPrefs();
              if (!relay.enabled || !relay.baseUrl) return '推荐部署到 Cloudflare';
              return relay.kind === 'cloudflare-workers' ? 'Cloudflare 定时协调已启用' : '自建中继已启用';
            })()}</small>
            <small>对网络要求较高，部分网络可能需要代理</small>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <label class="scrapbook-list-item settings-row settings-toggle-row">
          <span class="scrapbook-list-icon is-peach">${icon('zap')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>快捷悬浮球</strong>
            <small>贴边调用常用自救工具</small>
          </span>
          <input type="checkbox" class="settings-quick-ball-toggle" ${quickBallPrefs.enabled ? 'checked' : ''} />
        </label>
        <div class="settings-quick-ball-actions" ${quickBallPrefs.enabled ? '' : 'hidden'}>
          ${QUICK_BALL_ACTION_DEFS.map((action) => `
            <label class="settings-quick-ball-option">
              <input type="checkbox" data-quick-ball-action="${action.id}" ${quickBallPrefs.actions?.[action.id] !== false ? 'checked' : ''} />
              <span>
                <strong>${escapeHtml(action.label)}</strong>
                <small>${escapeHtml(action.hint)}</small>
              </span>
            </label>
          `).join('')}
          <button type="button" class="btn btn-outline settings-quick-ball-reset">重置悬浮球位置</button>
        </div>
        <button type="button" class="scrapbook-list-item settings-row settings-pwa-install" ${pwaInstalled ? 'disabled' : ''}>
          <span class="scrapbook-list-icon is-cream">${icon('smartphone')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>${pwaInstalled ? '已全屏独立运行' : (pwaCanInstall ? '安装全屏应用' : pwaStatus.title)}</strong>
            <span class="text-hint settings-pwa-detail" style="display:block;margin-top:4px;line-height:1.45;font-weight:400;">${pwaStatus.detail}</span>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${pwaInstalled ? icon('check') : icon('chevron')}</span>
        </button>
      </section>

      <section class="settings-group settings-keepalive-group" data-support-target="background.keepalive">
        <button type="button" class="settings-collapse-head" data-keepalive-panel-toggle aria-expanded="${isKeepAlivePanelOpen() ? 'true' : 'false'}">
          <span class="settings-collapse-title-row">
            <span class="settings-group-title settings-collapse-title">系统保活</span>
            <span class="settings-collapse-chevron" aria-hidden="true">${icon('chevronDown')}</span>
          </span>
          <span class="settings-keepalive-summary settings-collapse-summary">${escapeHtml(describeKeepAliveSummary(keepAlive, runtimeStatus, nativeKeepAlive))}</span>
        </button>
        <button type="button" class="scrapbook-list-item settings-row settings-keepalive-oneclick" ${keepAlive.enabled && keepAlive.silentAudio ? 'hidden' : ''}>
            <span class="scrapbook-list-icon is-peach">${icon('zap')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>一键开启保活</strong>
              <small>后台活跃 + 静音音频保活${nativeKeepAlive.native ? '，并引导放行省电' : ''}</small>
            </span>
            <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <div class="settings-collapse-body" data-keepalive-panel ${isKeepAlivePanelOpen() ? '' : 'hidden'}>
          <p class="settings-group-hint">角色自动消息、锁屏通知依赖这里。建议：后台活跃 → 静音音频保活 → 放行系统省电。</p>
          <button type="button" class="scrapbook-list-item settings-row settings-keepalive-tutorial">
            <span class="scrapbook-list-icon is-cream">${icon('book')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>保活教程</strong>
              <small>省电、自启动、iOS 静音排查</small>
            </span>
            <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
          </button>
          <label class="scrapbook-list-item settings-row settings-toggle-row">
            <span class="scrapbook-list-icon is-peach">${icon('timer')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>后台活跃</strong>
              <small class="settings-keepalive-hint">${nativeKeepAlive.native ? '原生保活可用 · 自动消息与后台任务需要开启' : '浏览器保活 · 自动消息与后台任务需要开启'}</small>
            </span>
            <input type="checkbox" class="settings-keepalive-toggle" ${keepAlive.enabled ? 'checked' : ''} />
          </label>
          <label class="scrapbook-list-item settings-row settings-toggle-row">
            <span class="scrapbook-list-icon is-cream">${icon('sun')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>屏幕唤醒锁</strong>
              <small>前台时尽量不熄屏，生成中更稳</small>
            </span>
            <input type="checkbox" class="settings-wakelock-toggle" ${keepAlive.keepAwake ? 'checked' : ''} />
          </label>
          <label class="scrapbook-list-item settings-row settings-toggle-row">
            <span class="scrapbook-list-icon is-cream">${icon('volumeX')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>静音音频保活</strong>
              <small class="settings-silent-audio-hint">${describeSilentAudioHint(keepAlive, runtimeStatus)}</small>
            </span>
            <input type="checkbox" class="settings-silent-toggle" ${keepAlive.silentAudio ? 'checked' : ''} />
          </label>
          <label class="scrapbook-list-item settings-row settings-toggle-row">
            <span class="scrapbook-list-icon is-peach">${icon('zap')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>常驻静音保活</strong>
              <small class="settings-silent-mode-hint">${describeSilentAudioModeHint(keepAlive)}</small>
            </span>
            <input type="checkbox" class="settings-silent-mode-toggle" ${keepAlive.silentAudioMode === 'always' ? 'checked' : ''} />
          </label>
          <label class="scrapbook-list-item settings-row settings-toggle-row">
            <span class="scrapbook-list-icon is-peach">${icon('bell')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>后台消息通知</strong>
              <small>${notificationHint}</small>
            </span>
            <input type="checkbox" class="settings-notify-toggle" ${keepAlive.notifyOnAutoChat && !webNotificationUnsupported ? 'checked' : ''} ${webNotificationUnsupported ? 'disabled' : ''} />
          </label>
          <label class="scrapbook-list-item settings-row settings-toggle-row">
            <span class="scrapbook-list-icon is-cream">${icon('volume2')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>消息提示音</strong>
              <small>后台推送时播放，可自定义</small>
            </span>
            <input type="checkbox" class="settings-notify-sound-toggle" ${notifySoundPrefs.enabled ? 'checked' : ''} />
          </label>
          <div class="scrapbook-list-item settings-row settings-notify-sound-volume-row is-static">
            <span class="scrapbook-list-icon is-peach">${icon('volume2')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>提示音音量</strong>
              <small class="settings-notify-sound-volume-val">${Number.isFinite(Number(notifySoundPrefs.volume)) ? Math.round(Number(notifySoundPrefs.volume)) : 80}%</small>
              <input type="range" class="settings-notify-sound-volume" min="0" max="100" step="1" value="${Number.isFinite(Number(notifySoundPrefs.volume)) ? Math.round(Number(notifySoundPrefs.volume)) : 80}" aria-label="提示音音量" />
            </span>
          </div>
          <button type="button" class="scrapbook-list-item settings-row settings-notify-sound-upload">
            <span class="scrapbook-list-icon is-peach">${icon('music')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>自定义提示音</strong>
              <small class="settings-notify-sound-file">${notifySoundPrefs.fileName ? escapeHtml(notifySoundPrefs.fileName) : '上传音频'}</small>
            </span>
            <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
          </button>
          <button type="button" class="scrapbook-list-item settings-row settings-notify-sound-preview">
            <span class="scrapbook-list-icon is-cream">${icon('volume2')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>试听提示音</strong>
            </span>
            <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
          </button>
          ${notifySoundPrefs.audioDataUrl ? `
          <button type="button" class="scrapbook-list-item settings-row settings-notify-sound-clear">
            <span class="scrapbook-list-icon is-cream">${icon('volumeX')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>清除自定义提示音</strong>
            </span>
            <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
          </button>
          ` : ''}
          <input type="file" class="settings-notify-sound-file-input" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac" hidden />
          ${nativeKeepAlive.native || webNotificationUnsupported ? '' : `
          <button type="button" class="scrapbook-list-item settings-row settings-test-notification">
            <span class="scrapbook-list-icon is-cream">${icon('megaphone')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>通知测试</strong>
              <small>浏览器 / PWA 通知测试</small>
            </span>
            <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
          </button>
          `}
          <button type="button" class="scrapbook-list-item settings-row settings-battery-settings">
            <span class="scrapbook-list-icon is-peach">${icon('battery')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>系统省电设置</strong>
              <small class="settings-battery-hint">${nativeKeepAlive.native
                ? (nativeKeepAlive.batteryOptimizationIgnored ? '已放行后台' : '建议允许无限制后台')
                : '查看安卓 / iOS 加强保活步骤'}</small>
            </span>
            <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
          </button>
          ${nativeKeepAlive.native ? `
          <button type="button" class="scrapbook-list-item settings-row settings-exact-alarm">
            <span class="scrapbook-list-icon is-cream">${icon('timer')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>定时任务权限</strong>
              <small>${nativeKeepAlive.canScheduleExactAlarms ? '已允许精确定时' : '建议允许精确定时，定时唤醒更准'}</small>
            </span>
            <span class="scrapbook-list-meta settings-row-meta">${nativeKeepAlive.canScheduleExactAlarms ? icon('check') : icon('chevron')}</span>
          </button>
          <button type="button" class="scrapbook-list-item settings-row settings-oem-background">
            <span class="scrapbook-list-icon is-peach">${icon('smartphone')}</span>
            <span class="scrapbook-list-body settings-row-main">
              <strong>自启动与后台设置</strong>
              <small>${escapeHtml(nativeKeepAlive.manufacturer || '系统设置')} · 厂商后台白名单</small>
            </span>
            <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
          </button>
          ` : ''}
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">帮助</div>
        <button type="button" class="scrapbook-list-item settings-row" data-route="tutorial">
          <span class="scrapbook-list-icon is-cream">${icon('book')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>使用教程</strong>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <button type="button" class="scrapbook-list-item settings-row settings-legal">
          <span class="scrapbook-list-icon is-peach">${icon('pin')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>使用边界</strong>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">关于</div>
        <div class="scrapbook-list-item settings-row is-static">
          <span class="scrapbook-list-icon is-cream">${icon('marshmallow')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>棉花糖机</strong>
          </span>
        </div>
      </section>
    </main>
  `;
  const connectionGroup = container.querySelector('.settings-connection-group');
  const keepAliveGroup = container.querySelector('.settings-keepalive-group');
  if (connectionGroup && keepAliveGroup) connectionGroup.after(keepAliveGroup);
  restoreScrollerTop(container, '.settings-scroll', prevScroll);
  void storageStatePromise.then((nextStorageState) => {
    if (!container.isConnected) return;
    const row = container.querySelector('.settings-storage-persist');
    const detail = row?.querySelector('small');
    const meta = row?.querySelector('.settings-row-meta');
    const label = describeStorageProtectionLabel(nextStorageState);
    const storageUsageDetail = nextStorageState.atRiskOfPeriodicEviction
      ? (nextStorageState.usage != null && nextStorageState.quota
        ? `已用 ${formatStorageBytes(nextStorageState.usage)} / ${formatStorageBytes(nextStorageState.quota)} · 标签页易被清库`
        : 'Safari 标签页易被清库，建议主屏幕 + 备份')
      : (nextStorageState.usage != null && nextStorageState.quota
        ? `已用 ${formatStorageBytes(nextStorageState.usage)} / ${formatStorageBytes(nextStorageState.quota)}`
        : '聊天与角色资料保存在本机');
    if (detail) detail.textContent = `${label} · ${storageUsageDetail}`;
    if (meta) meta.innerHTML = nextStorageState.persisted ? icon('check') : icon('chevron');
  });
  const backBtn = container.querySelector('.settings-back');
  if (backBtn) backBtn.addEventListener('click', () => back());
  container.querySelectorAll('[data-route]').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigate(String(btn.dataset.route || ''));
    });
  });
  container.querySelector('.settings-assistant-entry')?.addEventListener('click', () => {
    if (recentSupportError) {
      navigate('support', { fromError: '1' });
      return;
    }
    const diagnostic = captureSupportIncident({
      code: 'support-opened',
      scope: '设置',
      message: '用户从设置页打开芥末棉花糖',
      operation: 'settings-support-entry',
    });
    navigate('support', { incidentId: diagnostic.incidentId });
  });
  container.querySelector('.settings-legal')?.addEventListener('click', () => {
    navigate('tutorial', { section: 'legal' });
  });
  container.querySelector('.settings-cloud-backup')?.addEventListener('click', openCloudBackupModal);
  if (shouldResumeCloudBackup) {
    requestAnimationFrame(() => {
      if (container.isConnected) openCloudBackupModal();
    });
  }
  container.querySelector('.settings-generation-relay')?.addEventListener('click', openGenerationRelayModal);
  container.querySelector('.settings-open-recovery')?.addEventListener('click', () => {
    globalThis.location.assign('recovery.html');
  });
  if (!shouldResumeCloudBackup) {
    runAutomaticCloudBackupIfDue().then((result) => {
      if (result?.ran) showToast('自动云备份已完成');
    }).catch((error) => {
      showToast(`自动云备份失败：${error?.message || error}`, 6000);
    });
  }
  container.querySelector('.settings-export-contacts')?.addEventListener('click', async () => {
    try {
      const payload = await downloadCharactersExport({ includeGroups: true });
      showToast(`已导出 ${payload.characters.length} 位（含分组）`);
    } catch (err) {
      showToast(String((err && err.message) || err));
    }
  });
  const migrationBtn = container.querySelector('.settings-export-migration');
  migrationBtn?.addEventListener('click', async () => {
    if (!window.confirm('将把数据与资源写入一个搬家文件。导出期间请保持应用在前台，继续？')) return;
    const label = migrationBtn.querySelector('strong');
    const idleLabel = label?.textContent || '导出搬家包';
    migrationBtn.disabled = true;
    migrationBtn.setAttribute('aria-busy', 'true');
    let lastBytes = 0;
    let lastStore = '';
    const onExportProgress = (event) => {
      const detail = event?.detail || {};
      if (detail.phase !== 'export-store') return;
      lastStore = String(detail.storeName || '');
      if (label) label.textContent = `正在整理 ${lastStore || '数据'}…`;
    };
    window.addEventListener('marshmallow-backup-import-progress', onExportProgress);
    try {
      const result = await downloadMigrationPackage({
        onProgress: ({ phase, bytes, loadedBytes, totalBytes }) => {
          if (phase === 'write') {
            lastBytes = Number(bytes || 0);
            if (label) label.textContent = `正在写入 ${formatStorageBytes(lastBytes)}…`;
          } else if (phase === 'checksum') {
            const percent = totalBytes > 0 ? Math.round((loadedBytes / totalBytes) * 100) : 0;
            if (label) label.textContent = `正在校验 ${percent}%…`;
          }
        },
      });
      try {
        localStorage.setItem('__mm_last_migration_export__', JSON.stringify({
          filename: result.filename,
          bytes: result.bytes,
          sha256: result.sha256,
          packageId: result.packageId,
          exportedAt: result.exportedAt,
          counts: result.counts,
          assetCounts: result.assetCounts,
          assetBytes: result.assetBytes,
        }));
      } catch (_) {}
      const total = Object.values(result.counts || {}).reduce((sum, n) => sum + Number(n || 0), 0);
      const assetTotal = Object.values(result.assetCounts || {}).reduce((sum, n) => sum + Number(n || 0), 0);
      const summary = `数据 ${total} 条 · 资源 ${assetTotal} 项/${formatStorageBytes(result.assetBytes)} · 总计 ${formatStorageBytes(result.bytes)} · SHA ${result.sha256.slice(0, 12)}…`;
      if (result.saved?.requiresSaveGesture) {
        const opened = openDeferredBackupSaveModal(result.saved, {
          title: '搬家包已整理并校验',
          summary,
          onSaved: (saved) => showToast(`${describeDownloadResult(saved)} · ${summary}`, 12000),
        });
        if (!opened) {
          await result.saved.discard?.();
          throw new Error('保存面板未能打开，请重新导出');
        }
        showToast('搬家包已整理好，请点「保存到文件」', 6000);
      } else {
        showToast(`搬家包已校验保存 · ${summary}`, 12000);
      }
    } catch (error) {
      showToast(`搬家包导出失败${lastStore ? `（${lastStore}）` : ''}：${error?.message || error}`, 9000);
    } finally {
      window.removeEventListener('marshmallow-backup-import-progress', onExportProgress);
      migrationBtn.disabled = false;
      migrationBtn.removeAttribute('aria-busy');
      if (label) label.textContent = idleLabel;
    }
  });

  const fullBackupBtn = container.querySelector('.settings-export-backup');
  fullBackupBtn?.addEventListener('click', async () => {
    const label = fullBackupBtn.querySelector('strong');
    const idleLabel = label?.textContent || '导出数据包';
    fullBackupBtn.disabled = true;
    fullBackupBtn.setAttribute('aria-busy', 'true');
    if (label) label.textContent = '正在整理数据包…';
    showToast('正在整理数据包，数据较多时需要几分钟，请勿切走或锁屏', 7000);
    try {
      const payload = await downloadFullBackup({
        deferWebSave: isIOSDevice() || isAndroidDevice(),
      });
      const total = Object.values(payload.counts || {}).reduce((sum, n) => sum + Number(n || 0), 0);
      const omitHint = formatExportOmissionHint(payload.omissions);
      const assetHint = omitHint ? `${omitHint}，资源包请单独导出` : '';
      if (payload.saved?.requiresSaveGesture) {
        const opened = openDeferredBackupSaveModal(payload.saved, {
          title: '数据包已整理好',
          summary: `${total} 条 · ${formatStorageBytes(payload.bytes || 0)}`,
          onSaved: (saved) => {
            showToast(`${describeDownloadResult(saved)} · ${total} 条${assetHint ? ` · ${assetHint}` : ''}`, 9000);
          },
        });
        if (!opened) {
          await payload.saved.discard?.();
          throw new Error('保存面板未能打开，请重新导出');
        }
        showToast('数据包已整理好，请点「保存到文件」', 5000);
        return;
      }
      showToast(`${describeDownloadResult(payload.saved)} · ${total} 条${assetHint ? ` · ${assetHint}` : ''}`, 9000);
    } catch (err) {
      showToast(String((err && err.message) || err));
    } finally {
      fullBackupBtn.disabled = false;
      fullBackupBtn.removeAttribute('aria-busy');
      if (label) label.textContent = idleLabel;
    }
  });

  container.querySelector('.settings-export-region-backup')?.addEventListener('click', async () => {
    try {
      const androidWebExport = isAndroidDevice() && !isNativeShell();
      const mobileOptions = androidWebExport
        ? {
          partTargetBytes: ANDROID_REGION_PART_TARGET_BYTES,
        }
        : {};
      const preview = await previewRegionBackup(mobileOptions);
      const pickedIds = await pickRegionIdsForExport(summarizeRegionBackupPlan(preview));
      if (Array.isArray(pickedIds) && !pickedIds.length) {
        showToast('未选择任何区域');
        return;
      }
      const prepared = await downloadRegionBackup({
        ...mobileOptions,
        preview,
        ...(pickedIds ? { regionIds: pickedIds } : {}),
      });
      const plan = summarizeRegionBackupPlan(prepared);
      const startOk = window.confirm([
        `即将保存 ${plan.fileCount} 个区域备份文件。`,
        formatRegionBackupPlanText(plan),
        '',
        isIOSDevice()
          ? 'iOS 会逐个弹出保存，请把本批文件全部存入后再导入。'
          : '请保存本批全部文件后再导入。',
        '中途取消后，只能导入已保存的区域。',
        '开始？',
      ].join('\n'));
      if (!startOk) {
        await prepared.discard?.();
        return;
      }
      let savedResult = null;
      while (typeof prepared?.next === 'function') {
        if (savedResult && !savedResult.remaining) break;
        const idx = savedResult?.completed || 0;
        const nextFile = prepared.files?.[idx];
        const total = prepared.files?.length || 0;
        const remain = Math.max(0, total - idx - 1);
        const continueExport = window.confirm([
          `保存 ${idx + 1}/${total}：${nextFile?.regionLabel || nextFile?.region || '下一份'}`,
          `本批共 ${total} 个文件，需全部保存才算完整一套。`,
          remain ? `保存后还剩 ${remain} 个文件。` : '这是本批最后一个文件。',
          '现在保存这一份？',
        ].join('\n'));
        if (!continueExport) {
          await prepared.discard?.();
          const saved = savedResult?.completed || 0;
          showToast(saved
            ? `已保存 ${saved}/${total} 个；导入时需选同一批全部文件，或只导入已保存的区域`
            : '区域备份已取消', 9000);
          return;
        }
        savedResult = await prepared.next();
        if (savedResult?.remaining) await prepared.prepareNext?.();
      }
      const saved = savedResult?.saved ? describeDownloadResult(savedResult.saved) : '区域备份已导出';
      const total = Object.values(prepared.counts || {}).reduce((sum, n) => sum + Number(n || 0), 0);
      const omitHint = formatExportOmissionHint(prepared.omissions);
      const assetHint = omitHint ? ` · ${omitHint}，头像等请再导出资源包` : ' · 头像等请再导出资源包';
      showToast(total ? `${saved} · ${total} 条${assetHint}` : `${saved}${assetHint}`, 9000);
    } catch (err) {
      showToast(String((err && err.message) || err));
    }
  });

  const assetBackupBtn = container.querySelector('.settings-export-backup-assets');
  assetBackupBtn?.addEventListener('click', async () => {
    const label = assetBackupBtn.querySelector('strong');
    const idleLabel = label?.textContent || '导出资源包';
    assetBackupBtn.disabled = true;
    assetBackupBtn.setAttribute('aria-busy', 'true');
    if (label) label.textContent = '正在整理资源包…';
    try {
      showToast('正在分段整理资源包，请勿切走或锁屏', 7000);
      const result = await downloadAssetBackup({
        deferWebSave: isIOSDevice() || isAndroidDevice(),
      });
      if (result.saved?.requiresSaveGesture) {
        const opened = openDeferredBackupSaveModal(result.saved, {
          title: '资源包已整理好',
          summary: `角色图 ${result.characterAssets || 0} · 本地音乐 ${result.musicAssets || 0} · ${formatStorageBytes(result.bytes || 0)}`,
          onSaved: (saved) => {
            showToast(`${describeDownloadResult(saved)} · settings ${result.rows} · 角色图 ${result.characterAssets || 0} · 本地音乐 ${result.musicAssets || 0}`, 7000);
          },
        });
        if (!opened) {
          await result.saved.discard?.();
          throw new Error('保存面板未能打开，请重新导出');
        }
        showToast('资源包已整理好，请点「保存到文件」', 5000);
        return;
      }
      showToast(`${describeDownloadResult(result.saved)} · settings ${result.rows} · 角色图 ${result.characterAssets || 0} · 本地音乐 ${result.musicAssets || 0}`, 7000);
    } catch (err) {
      showToast(String((err && err.message) || err));
    } finally {
      assetBackupBtn.disabled = false;
      assetBackupBtn.removeAttribute('aria-busy');
      if (label) label.textContent = idleLabel;
    }
  });

  const assetInput = container.querySelector('.settings-import-backup-assets-file');
  container.querySelector('.settings-import-backup-assets')?.addEventListener('click', () => {
    triggerFileInput(assetInput);
  });
  assetInput?.addEventListener('change', async () => {
    const file = assetInput.files?.[0];
    assetInput.value = '';
    if (!file) return;
    try {
      showToast('正在导入资源包…', 3000);
      const result = await importAssetBackupFile(file);
      const nSettings = result.counts?.settings || 0;
      const nChars = result.counts?.characters || 0;
      const nMusic = result.counts?.musicTracks || 0;
      window.dispatchEvent(new CustomEvent('appearance-prefs-invalidate'));
      showToast(`资源包已合并 · settings ${nSettings} · 角色图 ${nChars} · 本地音乐 ${nMusic} · 刷新页面后生效`, 7000);
    } catch (err) {
      showToast(String((err && err.message) || err));
    }
  });

  const backupInput = container.querySelector('.settings-import-backup-file');
  container.querySelector('.settings-import-failure-details')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('marshmallow-backup-import-failed', { detail: backupImportSession }));
  });
  container.querySelector('.settings-import-backup')?.addEventListener('click', () => {
    confirmThenPickFile(backupInput, {
      title: '导入数据或搬家包',
      message: '会先识别内容并完整校验，再替换当前数据。请选择单个 JSON、ZIP、.mmmigrate 或 .bin 搬家包。',
      confirmLabel: '继续选择文件',
    });
  });
  const runFullBackupImport = async (fileList) => {
    const files = [...(fileList || [])].filter(Boolean);
    if (!files.length) {
      showToast('未选中文件，请重试', 4500);
      return;
    }
    const isParts = files.length > 1;
    const isMigration = !isParts && /\.(?:mmmigrate|bin)(?:\.json)?$/i.test(String(files[0]?.name || ''));
    const useStream = !isParts && shouldUseStreamingBackupImport(files[0]);
    const previousSession = !isParts ? getBackupImportSession() : null;
    const fileFingerprint = !isParts
      ? await fingerprintBackupImportFile(files[0]).catch(() => '')
      : '';
    const matchesPreviousSession = previousSession
      && matchesBackupImportSessionFile(previousSession, files[0], fileFingerprint);
    const resumeCheckpoint = matchesPreviousSession
      ? backupImportResumeCheckpoint(previousSession)
      : null;
    const lowMemoryBeautifyRecovery = !!matchesPreviousSession
      && ['interrupted', 'failed'].includes(String(previousSession?.status || ''))
      && String(previousSession?.storeName || '').includes('beautifyAssets');
    startBackupImportSession(files[0], resumeCheckpoint, fileFingerprint);
    const importBtn = container.querySelector('.settings-import-backup');
    if (importBtn) importBtn.setAttribute('aria-busy', 'true');
    let progressOff = null;
    let importToastEl = null;
    let lastToastAt = 0;
    const ensureToastHost = () => {
      let wrap = document.getElementById('toast-container');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'toast-container';
        document.body.appendChild(wrap);
      }
      return wrap;
    };
    const updateImportToast = (msg) => {
      const wrap = ensureToastHost();
      if (!importToastEl) {
        importToastEl = document.createElement('div');
        importToastEl.className = 'toast';
        wrap.appendChild(importToastEl);
      }
      importToastEl.textContent = String(msg || '');
    };
    const clearImportToast = () => {
      importToastEl?.remove();
      importToastEl = null;
    };
    const sizeMb = isParts
      ? files.reduce((sum, f) => sum + Number(f.size || 0), 0) / (1024 * 1024)
      : Number(files[0]?.size || 0) / (1024 * 1024);
    updateImportToast(lowMemoryBeautifyRecovery
      ? '上次停止在美化资源，本次优先恢复主数据并跳过该资源段…'
      : isParts
        ? `分片导入中（${files.length} 个文件 · 约 ${sizeMb.toFixed(0)} MB），请勿切走或锁屏`
        : `${isMigration ? '搬家包' : '数据包'}导入中（约 ${sizeMb.toFixed(1)} MB）${useStream ? ' · 流式' : ''}，请勿切走或锁屏`);
    progressOff = (e) => {
      const d = e.detail || {};
      updateBackupImportSession(d);
      const now = Date.now();
      if (now - lastToastAt < 400 && d.phase !== 'complete' && d.phase !== 'parse') return;
      lastToastAt = now;
      if (d.phase === 'read') {
        const pct = d.totalBytes ? Math.min(99, Math.round((d.bytesRead / d.totalBytes) * 100)) : 0;
        updateImportToast(`正在读取备份${d.totalBytes ? ` · ${pct}%` : ''}…`);
      } else if (d.phase === 'parse') {
        updateImportToast('正在解析备份 JSON…');
      } else if (d.phase === 'preflight') {
        updateImportToast('正在完整预检搬家包，确认无误后才会写入…');
      } else if (d.phase === 'preflight-store-start' && d.storeName) {
        updateImportToast(`正在预检 ${d.storeName}…`);
      } else if (d.phase === 'preflight-store' && d.storeName) {
        const pct = d.totalBytes
          ? Math.min(99, Math.round((d.bytesRead / d.totalBytes) * 100))
          : 0;
        updateImportToast(`正在预检 ${d.storeName} · ${d.rows || 0} 条${d.totalBytes ? ` · ${pct}%` : ''}`);
      } else if (d.phase === 'preflight-complete') {
        updateImportToast('搬家包预检通过，开始写入本地库…');
      } else if (d.phase === 'store-start' && d.storeName) {
        updateImportToast(`开始导入 ${d.storeName}…`);
      } else if (d.phase === 'store' && d.storeName) {
        const pct = d.totalBytes
          ? Math.min(99, Math.round((d.bytesRead / d.totalBytes) * 100))
          : (d.totalRows ? Math.min(99, Math.round((d.rows / d.totalRows) * 100)) : 0);
        const keyHint = d.storeName === 'settings' && d.settingsKey ? ` · ${d.settingsKey}` : '';
        const skipHint = d.skipped ? ' · 已跳过大项' : '';
        const partHint = d.part ? ` · 分片 ${d.part}/${d.partsTotal || '?'}` : '';
        const pctHint = (d.totalBytes || d.totalRows) ? ` · ${pct}%` : '';
        updateImportToast(`正在写入 ${d.storeName}${keyHint}${skipHint}${partHint} · ${d.rows || 0} 条${pctHint}`);
      } else if (d.phase === 'start') {
        updateImportToast('开始写入本地库…');
      } else if (d.phase === 'native-stage-resume') {
        updateImportToast('找到上次中断现场，正在恢复后继续写入…');
      }
    };
    window.addEventListener('marshmallow-backup-import-progress', progressOff);
    try {
      if (resumeCheckpoint) updateImportToast('正在读取上次中断现场…');
      const result = await importFullBackupFiles(files, {
        mode: 'replace',
        __resumeCheckpoint: resumeCheckpoint,
        __skipBeautifyAssets: lowMemoryBeautifyRecovery,
      });
      const skippedAssets = Array.isArray(result.skippedAssets) ? result.skippedAssets : [];
      saveBackupImportSkippedNotice(skippedAssets, files[0]);
      if (!isParts && result.beautifyResumeIndex != null) {
        saveBeautifySupplementSession(files[0], fileFingerprint, {
          nextIndex: result.beautifyResumeIndex,
          totalRows: result.assetCounts?.beautifyAssets,
          restoredRows: result.restoredAssetCounts?.beautifyAssets,
        });
      } else if (!isParts) {
        finishBeautifySupplementSession();
      }
      finishBackupImportSession();
      clearImportToast();
      const total = Object.values(result.counts || {}).reduce((sum, n) => sum + Number(n || 0), 0);
      const preserved = Array.isArray(result.preservedMissingStores)
        ? result.preservedMissingStores.length
        : 0;
      const preservedHint = preserved
        ? ` · 旧备份缺少 ${preserved} 类数据，已保留本机对应内容`
        : '';
      const oversizedSkipped = Number(result.skippedSettings?.oversized || 0);
      const oversizedHint = oversizedSkipped
        ? ` · ${oversizedSkipped} 个超大媒体项为防止内存溢出未导入`
        : '';
      const damagedHint = skippedAssets.length ? ` · ${skippedAssets.length} 类资源未恢复` : '';
      const supplementHint = result.beautifyResumeIndex != null ? ' · 美化资源可到“备份与迁移”分批补导' : '';
      showToast(`已导入${isMigration ? '搬家包' : '数据包'} · ${total} 条记录${preservedHint}${oversizedHint}${damagedHint}${supplementHint}，正在刷新`, (preserved || oversizedSkipped || skippedAssets.length || supplementHint) ? 9000 : 5000);
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      failBackupImportSession(err);
      clearImportToast();
      showToast(String((err && err.message) || err), 4500);
    } finally {
      window.removeEventListener('marshmallow-backup-import-progress', progressOff);
      if (importBtn) importBtn.removeAttribute('aria-busy');
    }
  };
  backupInput?.addEventListener('change', async () => {
    const files = [...(backupInput.files || [])];
    backupInput.value = '';
    await runFullBackupImport(files);
  });

  const regionBackupInput = container.querySelector('.settings-import-region-backup-file');
  container.querySelector('.settings-import-region-backup')?.addEventListener('click', () => {
    confirmThenPickFile(regionBackupInput, {
      title: '导入区域备份',
      message: [
        '可一次选择多个区域文件，也可只导入其中一个区域作兜底。',
        '完整还原需同一次导出的全部区域文件；头像等需再导入资源包。',
        '仅导入部分区域时，不会清空未包含的数据。',
      ].join('\n'),
      confirmLabel: '继续选择文件',
    });
  });
  regionBackupInput?.addEventListener('change', async () => {
    const files = [...(regionBackupInput.files || [])];
    regionBackupInput.value = '';
    if (!files.length) {
      showToast('未选中文件。若刚用了多选，请改一次只选一个区域文件重试', 4500);
      return;
    }
    try {
      showToast('正在导入区域备份…', 3000);
      const result = await importRegionBackupFiles(files);
      const total = Object.values(result?.counts || {}).reduce((sum, n) => sum + Number(n || 0), 0);
      const partialHint = result?.subsetReplace ? '（部分区域，其余数据保留）' : '';
      const preserved = !result?.subsetReplace && Array.isArray(result?.preservedMissingStores)
        ? result.preservedMissingStores.length
        : 0;
      const preservedHint = preserved ? ` · 旧备份缺少 ${preserved} 类数据，已保留本机对应内容` : '';
      const assetHint = ' · 头像等请再导入资源包';
      showToast(total
        ? `已导入区域备份${partialHint} · ${total} 条${preservedHint}${assetHint}，正在刷新`
        : `已导入区域备份${partialHint}${preservedHint}${assetHint}，正在刷新`, 7000);
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      showToast(String((err && err.message) || err), 6000);
    }
  });

  const refreshPwaSection = () => {
    const btn = container.querySelector('.settings-pwa-install');
    const detail = container.querySelector('.settings-pwa-detail');
    if (!btn || !detail) return;
    const status = getPwaInstallStatus();
    const installed = isStandalonePwa();
    const canInstall = canPromptPwaInstall();
    btn.disabled = installed;
    const titleEl = btn.querySelector('.settings-row-main strong');
    if (titleEl) {
      titleEl.textContent = installed ? '已全屏独立运行' : (canInstall ? '安装全屏应用' : status.title);
    }
    detail.textContent = status.detail;
  };

  container.querySelector('.settings-pwa-install')?.addEventListener('click', async () => {
    if (isStandalonePwa()) {
      showToast('已在独立窗口运行');
      return;
    }
    const status = getPwaInstallStatus();
    if (status.state === 'blocked') {
      showToast(status.detail, 4500);
      return;
    }
    if (!canPromptPwaInstall()) {
      showToast(status.detail, 4500);
      return;
    }
    const result = await promptPwaInstall();
    if (result.ok) showToast('安装成功，请从开始菜单或桌面图标打开');
    else if (result.reason === 'no-prompt') showToast(status.detail, 4500);
    else showToast('已取消安装');
    refreshPwaSection();
  });

  container.querySelector('.settings-strip-period-toggle')?.addEventListener('change', async (e) => {
    const on = !!e.target.checked;
    const next = await setStripTrailingPeriod(on);
    e.target.checked = next.stripTrailingPeriod;
    showToast(next.stripTrailingPeriod ? '已开启：AI 气泡结尾句号会被去掉' : '已关闭：保留原始句号');
  });
  container.querySelector('.settings-auto-expand-translations-toggle')?.addEventListener('change', async (e) => {
    const on = !!e.target.checked;
    const next = await setAutoExpandTranslations(on);
    e.target.checked = next.autoExpandTranslations;
    showToast(next.autoExpandTranslations ? '已开启：已有译文会自动展开' : '已关闭：译文恢复为点击展开');
  });
  const syncKeepAlivePanel = (keepAliveState, runtime = getKeepAliveRuntimeStatus()) => {
    refreshKeepAliveHints(container, keepAliveState, runtime, {
      native: nativeKeepAlive.native,
      nativeStatus: nativeKeepAlive,
    });
  };

  // 用户去系统设置里放行电池优化，回到本页时顺手复查一次状态并给反馈，
  // 不用靠用户自己再点一次才知道有没有生效。
  const confirmBatteryStatusOnReturn = ({ suggestOem = false } = {}) => {
    const onReturn = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onReturn);
      getNativeKeepAliveStatus().then((status) => {
        Object.assign(nativeKeepAlive, status || {});
        const ignored = !!status?.batteryOptimizationIgnored;
        const hintEl = container.querySelector('.settings-battery-hint');
        if (hintEl) hintEl.textContent = ignored ? '已放行后台' : '建议允许无限制后台';
        syncKeepAlivePanel(currentKeepAlive);
        if (!ignored) {
          showToast('仍受省电限制，建议重新前往设置放行', 4500);
        } else if (suggestOem && isAggressiveOemManufacturer(nativeKeepAlive.manufacturer)) {
          showToast('已放行省电；建议再点「自启动与后台设置」允许自启动，保活更稳', 6000);
        } else {
          showToast('已确认：允许无限制后台运行', 4500);
        }
      }).catch(() => {});
    };
    document.addEventListener('visibilitychange', onReturn);
  };

  container.querySelector('.settings-keepalive-oneclick')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    const head = container.querySelector('[data-keepalive-panel-toggle]');
    const panel = container.querySelector('[data-keepalive-panel]');
    if (head && panel) {
      head.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
      setKeepAlivePanelOpen(true);
    }
    try {
      const next = await enableRecommendedBackgroundKeepAlive({ event: e });
      currentKeepAlive = next;
      const keepToggle = container.querySelector('.settings-keepalive-toggle');
      if (keepToggle) keepToggle.checked = next.enabled;
      const silentToggle = container.querySelector('.settings-silent-toggle');
      if (silentToggle) silentToggle.checked = next.silentAudio;
      syncKeepAlivePanel(next);
      btn.hidden = true;
      if (nativeKeepAlive.native && !nativeKeepAlive.batteryOptimizationIgnored) {
        showToast('已开启后台活跃与静音保活；请在系统弹窗允许后台运行', 5000);
        const result = await openNativeBatterySettings().catch(() => ({ ok: false }));
        if (result?.ok) confirmBatteryStatusOnReturn({ suggestOem: true });
        return;
      }
      if (nativeKeepAlive.native) {
        showToast('已开启后台活跃与静音保活', 4000);
      } else {
        showToast('已开启后台活跃与静音保活；iOS 长回复时尽量保持前台', 5000);
      }
    } finally {
      btn.disabled = false;
    }
  });

  container.querySelector('[data-keepalive-panel-toggle]')?.addEventListener('click', () => {
    const head = container.querySelector('[data-keepalive-panel-toggle]');
    const panel = container.querySelector('[data-keepalive-panel]');
    if (!head || !panel) return;
    const open = head.getAttribute('aria-expanded') !== 'true';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.hidden = !open;
    setKeepAlivePanelOpen(open);
  });
  container.querySelector('.settings-keepalive-tutorial')?.addEventListener('click', () => {
    navigate('tutorial', { section: 'beta' });
  });

  container.querySelector('.settings-keepalive-toggle')?.addEventListener('change', async (e) => {
    const next = await setBackgroundKeepAliveEnabled(!!e.target.checked, { event: e });
    e.target.checked = next.enabled;
    const silentToggle = container.querySelector('.settings-silent-toggle');
    if (silentToggle) silentToggle.checked = next.silentAudio;
    currentKeepAlive = next;
    syncKeepAlivePanel(next);
    showToast(next.enabled ? '已开启后台活跃' : '已关闭后台活跃');
  });
  container.querySelector('.settings-wakelock-toggle')?.addEventListener('change', async (e) => {
    const next = await setKeepAwakeEnabled(!!e.target.checked);
    e.target.checked = next.keepAwake;
    showToast(next.keepAwake ? '已开启屏幕唤醒锁' : '已关闭');
  });
  container.querySelector('.settings-silent-toggle')?.addEventListener('change', async (e) => {
    const next = await setSilentAudioEnabled(!!e.target.checked, { event: e });
    e.target.checked = next.silentAudio;
    const keepToggle = container.querySelector('.settings-keepalive-toggle');
    if (keepToggle) keepToggle.checked = next.enabled;
    currentKeepAlive = next;
    const runtime = getKeepAliveRuntimeStatus();
    syncKeepAlivePanel(next, runtime);
    if (next.silentAudio) {
      if (!next.enabled) showToast('已记录偏好，请同时开启「后台活跃」');
      else if (next.silentAudioMode === 'generation' && !runtime.silentAudioActive) {
        showToast('已开启：生成回复时自动占用静音音轨', 3500);
      } else if (!runtime.silentAudioActive) showToast('偏好已保存，静音音频将自动重试', 3500);
      else showToast('已开启静音音频保活');
    } else {
      showToast('已关闭');
    }
  });
  container.querySelector('.settings-silent-mode-toggle')?.addEventListener('change', async (e) => {
    const next = await setSilentAudioMode(e.target.checked ? 'always' : 'generation', { event: e });
    e.target.checked = next.silentAudioMode === 'always';
    currentKeepAlive = next;
    syncKeepAlivePanel(next, getKeepAliveRuntimeStatus());
    showToast(next.silentAudioMode === 'always'
      ? '静音保活改为常驻后台（自动消息需要）'
      : '静音保活改为仅生成期间，空闲不占音轨', 3500);
  });
  container.querySelector('.settings-notify-toggle')?.addEventListener('change', async (e) => {
    const on = !!e.target.checked;
    if (on && webNotificationUnsupported) {
      e.target.checked = false;
      showToast(legacyIosWebPushUnsupported
        ? '后台通知需要 iOS 16.4 或更高版本'
        : '当前环境不支持后台通知');
      return;
    }
    const next = await setNotifyOnAutoChatEnabled(on);
    e.target.checked = next.notifyOnAutoChat;
    currentKeepAlive = next;
    syncKeepAlivePanel(next);
    if (on && !next.notifyOnAutoChat) {
      const state = getWebNotificationPermissionState();
      const guided = await guideNotificationPermission({
        state,
        stage: 'enable-background-notification',
      });
      if (guided?.granted) {
        const again = await setNotifyOnAutoChatEnabled(true);
        e.target.checked = again.notifyOnAutoChat;
        currentKeepAlive = again;
        syncKeepAlivePanel(again);
        if (again.notifyOnAutoChat) {
          showToast('已开启后台消息通知');
          return;
        }
      }
      showToast('通知权限未开启');
      return;
    }
    if (next.notifyOnAutoChat && isIOSDevice() && !nativeKeepAlive.native) {
      const delivery = await inspectMessageNotificationDelivery().catch(() => ({ ok: false }));
      if (!delivery?.ok) {
        await guideNotificationPermission({
          state: getWebNotificationPermissionState(),
          reason: String(delivery?.reason || 'notification-delivery-unavailable'),
          stage: 'enable-background-notification-delivery',
          detail: String(delivery?.error || ''),
          retryCheck: () => inspectMessageNotificationDelivery(),
        });
        return;
      }
    }
    showToast(next.notifyOnAutoChat ? '已开启后台消息通知' : '已关闭后台消息通知');
  });
  container.querySelector('.settings-notify-sound-toggle')?.addEventListener('change', async (e) => {
    primeMessageNotifySoundGesture(e);
    const next = await setMessageNotifySoundEnabled(!!e.target.checked);
    e.target.checked = next.enabled;
    showToast(next.enabled ? '已开启消息提示音' : '已关闭消息提示音');
  });
  const volumeInput = container.querySelector('.settings-notify-sound-volume');
  const volumeVal = container.querySelector('.settings-notify-sound-volume-val');
  let volumeSaveTimer = 0;
  volumeInput?.addEventListener('input', (e) => {
    const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
    if (volumeVal) volumeVal.textContent = `${v}%`;
  });
  volumeInput?.addEventListener('change', async (e) => {
    const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
    e.target.value = String(v);
    if (volumeVal) volumeVal.textContent = `${v}%`;
    window.clearTimeout(volumeSaveTimer);
    volumeSaveTimer = window.setTimeout(async () => {
      await setMessageNotifySoundVolume(v).catch(() => null);
    }, 120);
  });
  container.querySelector('.settings-quick-ball-toggle')?.addEventListener('change', async (e) => {
    const next = await saveQuickBallPrefs({ enabled: !!e.target.checked });
    e.target.checked = next.enabled;
    const actions = container.querySelector('.settings-quick-ball-actions');
    if (actions) actions.hidden = !next.enabled;
    showToast(next.enabled ? '已开启快捷悬浮球' : '已关闭快捷悬浮球');
  });
  container.querySelectorAll('[data-quick-ball-action]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const actionId = e.target.dataset.quickBallAction;
      const next = await saveQuickBallPrefs({ actions: { [actionId]: !!e.target.checked } });
      e.target.checked = next.actions[actionId] !== false;
    });
  });
  container.querySelector('.settings-quick-ball-reset')?.addEventListener('click', () => {
    resetQuickBallPosition();
    showToast('悬浮球已恢复到左侧安全位置');
  });
  const soundFileInput = container.querySelector('.settings-notify-sound-file-input');
  container.querySelector('.settings-notify-sound-upload')?.addEventListener('click', () => {
    triggerFileInput(soundFileInput);
  });
  soundFileInput?.addEventListener('change', async (e) => {
    primeMessageNotifySoundGesture(e);
    const file = soundFileInput.files?.[0];
    soundFileInput.value = '';
    if (!file) return;
    try {
      await setMessageNotifySoundFromFile(file);
      showToast('已保存自定义提示音');
      render(container);
    } catch (err) {
      showToast(String(err?.message || err || '上传失败'), 3500);
    }
  });
  container.querySelector('.settings-notify-sound-preview')?.addEventListener('click', async (e) => {
    primeMessageNotifySoundGesture(e);
    const result = await previewMessageNotifySound().catch(() => ({ ok: false }));
    if (!result?.ok) showToast('试听失败，请检查系统静音或换一个音频', 3500);
  });
  container.querySelector('.settings-notify-sound-clear')?.addEventListener('click', async () => {
    await clearMessageNotifySoundCustom();
    showToast('已清除自定义提示音');
    render(container);
  });
  syncKeepAlivePanel(keepAlive, runtimeStatus);
  // 系统媒体控制/通知栏图标是否显示「在播放」在 iOS、Android 上都不稳定，不能作为判断依据；
  // 这里订阅静音音频的真实运行状态变化（开始/暂停/重试/后台巡检确认），页面开着时随时更新，
  // 不用靠系统 UI。容器被路由销毁后自动摘掉监听，避免残留。
  const onKeepAliveRuntimeChanged = (e) => {
    if (!container.isConnected) {
      window.removeEventListener('marshmallow-keepalive-runtime-changed', onKeepAliveRuntimeChanged);
      return;
    }
    const runtime = e?.detail || getKeepAliveRuntimeStatus();
    syncKeepAlivePanel(currentKeepAlive, runtime);
  };
  window.addEventListener('marshmallow-keepalive-runtime-changed', onKeepAliveRuntimeChanged);
  container.querySelector('.settings-storage-persist')?.addEventListener('click', async () => {
    const result = await requestStoragePersistence().catch(() => null);
    if (!result?.supported) {
      showToast('当前浏览器不支持存储持久化申请');
      return;
    }
    if (result?.persisted || result?.ok) {
      if (result.atRiskOfPeriodicEviction) {
        showToast('已申请持久化；iPhone 请尽量用主屏幕版，并定期导出备份', 5000);
      } else {
        showToast('本地存储已标记为持久化，被系统自动清理的概率更低');
      }
    } else {
      showToast('浏览器未批准持久化，请定期导出备份', 5000);
    }
    render(container);
  });
  container.querySelector('.settings-test-notification')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    primeMessageNotifySoundGesture(e);
    try {
      const sendTestNotification = () => showMessageNotification({
        title: '棉花糖机',
        body: '这是一条测试通知。若锁屏不显示，请检查系统通知与锁屏设置。',
        tag: `marshmallow-test-${Date.now()}`,
        skipDedupe: true,
      });
      const state = getWebNotificationPermissionState();
      if (state === 'unsupported') {
        await guideNotificationPermission({ state, stage: 'notification-test-start' });
        return;
      }
      if (state === 'denied') {
        const guided = await guideNotificationPermission({
          state: 'denied',
          stage: 'notification-test-start',
        });
        if (!guided?.granted) return;
      }
      const ok = await requestMessageNotificationPermission().catch(() => false);
      if (!ok) {
        const guided = await guideNotificationPermission({
          state: getWebNotificationPermissionState(),
          stage: 'notification-permission-request',
        });
        if (!guided?.granted) return;
      }
      const result = await sendTestNotification();
      if (result?.ok) {
        if (isIOSDevice()) {
          await guideNotificationPermission({
            state: 'granted',
            reason: 'delivery-verification',
            stage: 'notification-test-delivered',
            retryCheck: sendTestNotification,
          });
          return;
        }
        const hint = result.reason === 'deduped'
          ? '测试通知已跳过（短时间内重复）'
          : (result.channel === 'service-worker' ? '已发送测试通知（PWA）' : '已发送测试通知');
        showToast(hint);
        return;
      }
      if (result?.permissionRequired || result?.needsGuide) {
        await guideNotificationPermission({
          state: getWebNotificationPermissionState(),
          reason: String(result?.reason || ''),
          stage: 'notification-send',
          detail: String(result?.error || result?.reason || ''),
          retryCheck: sendTestNotification,
        });
        return;
      }
      const detail = String(result?.error || result?.reason || '').trim();
      showToast(detail ? `测试通知发送失败：${detail}` : '测试通知发送失败', 4500);
    } catch (err) {
      showToast(`测试通知发送失败：${err?.message || err}`, 4500);
    }
  });
  container.querySelector('.settings-battery-settings')?.addEventListener('click', async () => {
    if (!nativeKeepAlive.native) {
      navigate('tutorial', { section: 'beta' });
      return;
    }
    const result = await openNativeBatterySettings().catch(() => ({ ok: false }));
    if (!result?.ok) {
      showToast('当前环境无法打开系统设置');
      return;
    }
    showToast('已打开系统省电设置，处理完成后返回本页会自动确认', 4000);
    confirmBatteryStatusOnReturn();
  });
  container.querySelector('.settings-exact-alarm')?.addEventListener('click', async () => {
    const result = await openNativeExactAlarmSettings().catch(() => ({ ok: false }));
    showToast(result?.ok ? '已打开定时任务权限设置' : '当前系统无法打开该设置');
  });
  container.querySelector('.settings-oem-background')?.addEventListener('click', async () => {
    const result = await openNativeOemBackgroundSettings().catch(() => ({ ok: false }));
    showToast(result?.ok ? '已打开自启动与后台设置' : '当前系统无法打开该设置');
  });
  window.addEventListener('marshmallow-pwa-installable', refreshPwaSection, { once: false });
  window.addEventListener('marshmallow-pwa-installed', refreshPwaSection, { once: false });
  if (requestedFocus) {
    const target = [...container.querySelectorAll('[data-support-target]')]
      .find((item) => item.getAttribute('data-support-target') === requestedFocus);
    if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
}
