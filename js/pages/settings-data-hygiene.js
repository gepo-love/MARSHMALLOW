import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { scanDataHygiene, fixDataHygiene } from '../core/data-hygiene.js';
import {
  scanMediaStorage,
  compactOversizedMessageImages,
  clearLocalMessageImages,
  clearLocalMediaCategory,
} from '../core/media-storage-hygiene.js';
import { loadAppearancePrefs, getActiveTheme, applySettingsWallpaperPreview } from '../core/appearance-prefs.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';
import { clearVoiceCache } from '../core/voice-tools.js';
import { exportAudioMediaArchive, exportChatImageArchive } from '../core/media-audio-archive.js';
import { getCurrentUser, listUsers, deleteUserSlots } from '../core/user-slot.js';
import {
  inspectStorageDistribution,
  cleanStorageCategory,
  factoryResetApplicationData,
} from '../core/storage-management.js';

async function loadTheme() {
  const prefs = await loadAppearancePrefs();
  return getActiveTheme(prefs).theme;
}

function row(iconName, title, hint, count) {
  return `
    <div class="scrapbook-list-item settings-row is-static">
      <span class="scrapbook-list-icon is-cream">${icon(iconName)}</span>
      <span class="scrapbook-list-body settings-row-main">
        <strong>${title}</strong>
        <small>${hint}</small>
      </span>
      <span class="scrapbook-list-meta settings-row-meta">${count}</span>
    </div>
  `;
}

function renderReport(report) {
  if (!report.total) {
    return `<div class="scrapbook-list-item settings-row is-static"><span class="scrapbook-list-icon is-cream">${icon('check')}</span><span class="settings-row-main"><strong>没有发现残留数据</strong></span></div>`;
  }
  return [
    report.orphanPrivateChats.length
      ? row('trash', '僵尸私聊', '对方角色已被删除', report.orphanPrivateChats.length) : '',
    report.groupGhostParticipants.length
      ? row('bubble', '群聊里的已删除角色', '仅摘除该成员，保留群聊记录', report.groupGhostParticipants.length) : '',
    report.ghostMemoryScopes.length
      ? row('database', '幽灵角色记忆', '记忆/事实/收藏指向已删除的角色或已失效的手机联系人', report.ghostMemoryScopes.length) : '',
    report.ghostCharacterData?.length
      ? row('database', '已删除角色的功能数据', '主动设置、角色手机或相遇记录仍有残留', report.ghostCharacterData.length) : '',
    report.orphanSlotChats.length
      ? row('trash', '孤儿档位聊天', '所属档位已被删除', report.orphanSlotChats.length) : '',
    report.orphanSlotMoments?.length
      ? row('image', '孤儿档位朋友圈', '所属档位已被删除', report.orphanSlotMoments.length) : '',
    report.orphanRelationshipActors?.length
      ? row('users', '关系网幽灵 NPC', '来源角色、聊天或手机联系人已删除，关系网仍挂着', report.orphanRelationshipActors.length) : '',
    report.unresolvableAutoChats?.length
      ? row('bubble', '失效的自动推进', '会话含已不存在的身份，将关闭后台自动推进', report.unresolvableAutoChats.length) : '',
    report.unauthorizedCrossGroupChats?.length
      ? row('bubble', '跨分组角色会话', '未在关系网建立联系，将连同错误消息清理', report.unauthorizedCrossGroupChats.length) : '',
    report.unauthorizedCrossGroupLedgerEntries?.length
      ? row('users', '跨分组认识记录', '自动产生且没有关系网授权', report.unauthorizedCrossGroupLedgerEntries.length) : '',
    report.unauthorizedCrossGroupPhoneContacts?.length
      ? row('users', '串入手机的跨组联系人', '未在关系网建立联系，将从对应手机移除', report.unauthorizedCrossGroupPhoneContacts.length) : '',
    report.duplicateLocalMusicTracks?.length
      ? row('music', '重复的本地音乐文件', '保留仍在使用的一份，清理资源包里的重复副本', report.duplicateLocalMusicTracks.length) : '',
    report.danglingMusicPlaylistRefs?.length
      ? row('music', '歌单失效歌曲引用', '歌曲已不存在，将从歌单记录中移除', report.danglingMusicPlaylistRefs.reduce((sum, item) => sum + (item.trackIds?.length || 0), 0)) : '',
    report.danglingMusicPosts?.length
      ? row('music', '失效的音乐动态', '引用的歌曲已不存在', report.danglingMusicPosts.length) : '',
  ].filter(Boolean).join('');
}

function formatBytes(bytes = 0) {
  const value = Math.max(0, Number(bytes || 0));
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function esc(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMediaReport(report) {
  const contributors = Array.isArray(report?.contributors) ? report.contributors : [];
  const categories = Object.entries(report?.categories || {})
    .map(([name, value]) => ({
      name,
      bytes: Number(value.imageBytes || 0) + Number(value.audioBytes || 0),
      items: Number(value.images || 0) + Number(value.audio || 0),
    }))
    .filter((item) => item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  if (!categories.length) return '<div class="settings-group-hint">没有发现本地图片或音频。</div>';
  return [
    ...categories.map((item) => {
      const details = contributors.filter((entry) => entry.category === item.name).slice(0, 8);
      return `
        <div class="scrapbook-list-item settings-row is-static dh-media-category-row">
          <span class="scrapbook-list-icon is-cream">${icon('database')}</span>
          <span class="scrapbook-list-body settings-row-main">
            <strong>${esc(item.name)}</strong>
            <small>${item.items} 项本地媒体</small>
          </span>
          <span class="scrapbook-list-meta settings-row-meta">${formatBytes(item.bytes)}</span>
          ${['朋友圈图片', '微博图片', '论坛图片'].includes(item.name)
            ? `<button type="button" class="dh-media-action" data-media-clear-category="${esc(item.name)}">清理</button>`
            : ''}
        </div>
        ${details.length ? `
          <details class="settings-group-hint dh-media-details">
            <summary>查看占用明细</summary>
            ${details.map((entry) => `<div><span>${esc(entry.label)}</span><span>${formatBytes(entry.bytes)}</span></div>`).join('')}
          </details>` : ''}
      `;
    }),
    report.duplicateMessageImages
      ? row('image', '重复保存的聊天图片', '同一Base64同时存在于消息正文和URL字段', `${report.duplicateMessageImages} 张`) : '',
    report.oversizedMessageImages
      ? row(
        'image',
        '可安全瘦身的聊天图片',
        '逐张处理，可中断后继续',
        `${report.oversizedMessageImages} 张 · ${formatBytes(report.oversizedMessageBytes)}`,
      ) : '',
  ].filter(Boolean).join('');
}

function storageCategories(report = {}) {
  if (report.native) {
    return [
      { key: 'web', label: '网页数据库', hint: '聊天、设置与 WebView 存储', bytes: report.webViewBytes },
      {
        key: 'vault',
        label: '原生数据保险库',
        hint: Number(report.inactiveVaultGenerationCount || 0) > 0
          ? `当前主数据与 ${Number(report.inactiveVaultGenerationCount)} 个旧恢复代`
          : '当前主数据（使用中，不可作为旧代清理）',
        bytes: report.nativeVaultBytes,
        action: report.canCleanNativeVault && Number(report.inactiveVaultGenerationCount || 0) > 0
          ? 'old_vault_generations'
          : '',
        actionLabel: '清理旧代',
      },
      {
        key: 'backups',
        label: '安全备份',
        hint: `${Number(report.safetyBackupCount || 0)} 份原生备份`,
        bytes: report.safetyBackupBytes,
        action: Number(report.safetyBackupCount || 0) > 1 ? 'old_safety_backups' : '',
        actionLabel: '只留最新',
      },
      {
        key: 'updates',
        label: '热更新资源',
        hint: '当前版本、回退版本与下载残留',
        bytes: report.updateBytes,
        action: Number(report.updateBytes || 0) > 0 ? 'old_updates' : '',
        actionLabel: '清理旧包',
      },
      {
        key: 'cache',
        label: '临时缓存',
        hint: '可重新生成的临时文件',
        bytes: report.cacheBytes,
        action: Number(report.cacheBytes || 0) > 0 ? 'cache' : '',
        actionLabel: '清理',
      },
      {
        key: 'requests',
        label: '请求恢复缓存',
        hint: '已结束请求的短期恢复文件',
        bytes: report.requestRecoveryBytes,
        action: Number(report.requestRecoveryBytes || 0) > 0 ? 'request_recovery' : '',
        actionLabel: '清理',
      },
      { key: 'external', label: '应用外部文件', hint: '应用专属导出与临时文件', bytes: report.externalBytes },
      { key: 'other', label: '其它原生数据', hint: '配置、日志与系统组件数据', bytes: report.otherBytes },
      { key: 'apk', label: '应用本体', hint: '已安装 APK', bytes: report.apkBytes },
    ];
  }
  const details = report.estimate?.usageDetails || {};
  const indexedDbBytes = Number(details.indexedDB || details.indexedDb || 0);
  const cacheBytes = Number(details.caches || details.cacheStorage || report.cacheStorage?.totalBytes || 0);
  const serviceWorkerBytes = Number(details.serviceWorkerRegistrations || 0);
  const opfsBytes = Number(report.opfs?.totalBytes || 0);
  const measured = Number(report.measuredBytes || 0);
  const known = indexedDbBytes + cacheBytes + serviceWorkerBytes + opfsBytes;
  return [
    { key: 'web', label: '网页数据库', hint: '聊天、设置与媒体记录', bytes: indexedDbBytes },
    {
      key: 'safety',
      label: '网页安全快照',
      hint: '用于网页数据意外丢失后的恢复',
      bytes: report.opfs?.safetyBackupBytes,
    },
    {
      key: 'exports',
      label: '导出临时文件',
      hint: `${Number(report.opfs?.exportTempCount || 0)} 个导出中转或中断残留`,
      bytes: report.opfs?.exportTempBytes,
      action: Number(report.opfs?.exportTempBytes || 0) > 0 ? 'opfs_export_temps' : '',
      actionLabel: '清理',
    },
    {
      key: 'audio',
      label: '离线音频',
      hint: '电台与本地播放缓存',
      bytes: report.opfs?.radioBytes,
      action: Number(report.opfs?.radioBytes || 0) > 0 ? 'radio_cache' : '',
      actionLabel: '清理',
    },
    { key: 'opfs', label: '其它本地文件', hint: '未归类的站点私有文件', bytes: report.opfs?.otherBytes },
    { key: 'cache', label: '网页缓存', hint: '离线资源与可重建文件', bytes: cacheBytes + serviceWorkerBytes },
    { key: 'other', label: '其它网页数据', hint: '浏览器未细分的占用', bytes: Math.max(0, measured - known) },
  ];
}

function renderStorageReport(report) {
  const total = Math.max(0, Number(report?.measuredBytes || 0));
  const categories = storageCategories(report)
    .map((item) => ({ ...item, bytes: Math.max(0, Number(item.bytes || 0)) }))
    .filter((item) => item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  if (!total && !categories.length) {
    return '<div class="settings-group-hint">当前环境无法读取实际存储占用。</div>';
  }
  const meterTotal = Math.max(total, categories.reduce((sum, item) => sum + item.bytes, 0), 1);
  return `
    <div class="dh-storage-total"><strong>${formatBytes(total)}</strong><span>${report.native ? '应用实际占用' : '本站实际占用'}</span></div>
    <div class="dh-storage-meter" role="img" aria-label="存储占用分布">
      ${categories.map((item) => `<span class="is-${item.key}" style="width:${Math.max(0.7, item.bytes / meterTotal * 100).toFixed(2)}%" title="${esc(item.label)} ${formatBytes(item.bytes)}"></span>`).join('')}
    </div>
    <div class="dh-storage-list">
      ${categories.map((item) => `
        <div class="dh-storage-row">
          <span class="dh-storage-dot is-${item.key}" aria-hidden="true"></span>
          <span class="dh-storage-copy"><strong>${esc(item.label)}</strong><small>${esc(item.hint)}</small></span>
          <span class="dh-storage-size">${formatBytes(item.bytes)}</span>
          ${item.action ? `<button type="button" class="dh-storage-action" data-storage-action="${item.action}">${item.actionLabel}</button>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function groupSlots(users = [], currentUserId = '') {
  const groups = new Map();
  for (const user of users) {
    const id = String(user?.slotGroupId || user?.id || '').trim();
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(user);
  }
  return [...groups.entries()].map(([id, identities]) => ({
    id,
    identities,
    primary: identities.find((identity) => identity.id === currentUserId) || identities[0],
    current: identities.some((identity) => identity.id === currentUserId),
  }));
}

async function openSlotBatchDelete(container) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const [users, currentUser] = await Promise.all([listUsers(), getCurrentUser()]);
  const slots = groupSlots(users, currentUser?.id || '');
  if (slots.length <= 1) {
    showToast('至少保留一个档位');
    return;
  }
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center" data-slot-batch-overlay>
      <section class="modal-sheet scrapbook-card dh-slot-batch-sheet" role="dialog" aria-modal="true" aria-label="批量删除档位">
        <header class="modal-header">
          <h3>批量删除档位</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-slot-batch-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="modal-body dh-slot-batch-body">
          <div class="dh-slot-batch-list">
            ${slots.map((slot) => `
              <label class="dh-slot-batch-row">
                <input type="checkbox" value="${esc(slot.id)}" data-slot-batch-check />
                <span><strong>${esc(slot.primary?.slotName || slot.primary?.name || '未命名档位')}</strong><small>${slot.identities.length} 个身份${slot.current ? ' · 当前' : ''}</small></span>
              </label>
            `).join('')}
          </div>
          <div class="dh-slot-batch-progress" data-slot-batch-progress hidden>
            <div><strong data-slot-batch-progress-label>准备删除…</strong><span data-slot-batch-progress-percent>0%</span></div>
            <progress max="100" value="0" data-slot-batch-progress-bar></progress>
            <small data-slot-batch-progress-detail></small>
          </div>
          <div class="dh-slot-batch-actions">
            <button type="button" class="btn btn-outline" data-slot-batch-others>全选其他档</button>
            <button type="button" class="btn btn-primary" data-slot-batch-delete disabled>删除所选</button>
          </div>
        </div>
      </section>
    </div>`;
  const checks = [...host.querySelectorAll('[data-slot-batch-check]')];
  const deleteBtn = host.querySelector('[data-slot-batch-delete]');
  const selectOthersBtn = host.querySelector('[data-slot-batch-others]');
  const closeBtn = host.querySelector('[data-slot-batch-close]');
  const progressWrap = host.querySelector('[data-slot-batch-progress]');
  const progressBar = host.querySelector('[data-slot-batch-progress-bar]');
  const progressLabel = host.querySelector('[data-slot-batch-progress-label]');
  const progressPercent = host.querySelector('[data-slot-batch-progress-percent]');
  const progressDetail = host.querySelector('[data-slot-batch-progress-detail]');
  let deleting = false;
  const sync = () => {
    const selected = checks.filter((input) => input.checked).length;
    if (deleteBtn) {
      deleteBtn.disabled = selected === 0 || selected >= slots.length;
      deleteBtn.textContent = selected ? `删除所选（${selected}）` : '删除所选';
    }
  };
  checks.forEach((input) => input.addEventListener('change', sync));
  selectOthersBtn?.addEventListener('click', () => {
    checks.forEach((input) => {
      const slot = slots.find((item) => item.id === input.value);
      input.checked = !slot?.current;
    });
    sync();
  });
  host.querySelector('[data-slot-batch-overlay]')?.addEventListener('click', (event) => {
    if (!deleting && event.target === event.currentTarget) close();
  });
  closeBtn?.addEventListener('click', () => {
    if (!deleting) close();
  });
  deleteBtn?.addEventListener('click', async () => {
    const selected = checks.filter((input) => input.checked).map((input) => input.value);
    const labels = slots
      .filter((slot) => selected.includes(slot.id))
      .map((slot) => slot.primary?.slotName || slot.primary?.name || '未命名档位');
    if (!selected.length || selected.length >= slots.length) return;
    if (!window.confirm(`确定删除 ${labels.join('、')} ？档位内身份与数据会一并删除，此操作不可撤销。`)) return;
    deleting = true;
    checks.forEach((input) => { input.disabled = true; });
    if (selectOthersBtn) selectOthersBtn.disabled = true;
    if (closeBtn) closeBtn.disabled = true;
    if (progressWrap) progressWrap.hidden = false;
    deleteBtn.disabled = true;
    deleteBtn.textContent = '正在删除·0%';
    try {
      const result = await deleteUserSlots(selected, {
        onProgress: ({ label, detail, percent }) => {
          const value = Math.max(0, Math.min(100, Number(percent || 0) || 0));
          if (progressLabel) progressLabel.textContent = label || '正在删除';
          if (progressDetail) progressDetail.textContent = detail || '';
          if (progressPercent) progressPercent.textContent = `${value}%`;
          if (progressBar) progressBar.value = value;
          deleteBtn.textContent = value >= 100 ? '删除完成' : `正在删除·${value}%`;
        },
      });
      close();
      showToast(`已删除 ${result.deletedSlotGroupIds.length} 个档位`);
      await render(container);
    } catch (error) {
      showToast(`删除失败：${error?.message || error}`);
      deleting = false;
      checks.forEach((input) => { input.disabled = false; });
      if (selectOthersBtn) selectOthersBtn.disabled = false;
      if (closeBtn) closeBtn.disabled = false;
      if (progressLabel) progressLabel.textContent = '删除中断';
      if (progressDetail) progressDetail.textContent = String(error?.message || error || '');
      sync();
    }
  });
}

export default async function render(container) {
  const theme = await loadTheme();
  let report = null;
  const prevScroll = captureScrollerTop(container, '.settings-scroll');
  const canFactoryReset = typeof globalThis.Capacitor?.Plugins?.MarshmallowFileExport?.resetApplicationData === 'function';
  container.className = 'page scrapbook-page settings-debug-page';
  applySettingsWallpaperPreview(container, theme);
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn dh-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">存储与数据</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="settings-scroll scrapbook-scroll">
      <section class="settings-group dh-storage-section">
        <div class="settings-group-title">存储空间</div>
        <div class="dh-storage-report"><div class="settings-group-hint">点击扫描查看应用实际占用。</div></div>
        <button type="button" class="btn btn-primary dh-storage-scan">扫描存储</button>
      </section>
      <section class="settings-group">
        <div class="settings-group-title">内容占用</div>
        <div class="dh-media-report"><div class="settings-group-hint">尚未扫描图片与音频。</div></div>
        <button type="button" class="btn btn-outline dh-media-scan">统计内容占用</button>
        <button type="button" class="btn btn-outline dh-media-backup">导出资源包</button>
        <button type="button" class="btn btn-outline dh-slot-manage">批量删除档位</button>
        <button type="button" class="btn btn-outline dh-radio-clear">清理电台缓存</button>
        <button type="button" class="btn btn-outline dh-audio-export" hidden>批量导出音频</button>
        <button type="button" class="btn btn-outline dh-image-export" hidden>批量导出聊天图片</button>
        <button type="button" class="btn btn-primary dh-media-compact" hidden>安全瘦身聊天图片</button>
        <button type="button" class="btn btn-outline dh-voice-clear">清理语音缓存</button>
        <button type="button" class="btn btn-outline dh-media-clear">紧急清除聊天图片</button>
      </section>
      <section class="settings-group">
        <div class="settings-group-title">数据残留</div>
        <div class="dh-report"><div class="settings-group-hint">正在扫描数据残留…</div></div>
        <button type="button" class="btn btn-primary dh-fix" disabled>一键清理</button>
        <button type="button" class="btn btn-outline dh-rescan" disabled>正在扫描…</button>
      </section>
      <section class="settings-group dh-reset-section" ${canFactoryReset ? '' : 'hidden'}>
        <div class="settings-group-title">重新开始</div>
        <button type="button" class="btn btn-outline dh-factory-reset">清空全部内容</button>
      </section>
    </main>
  `;
  restoreScrollerTop(container, '.settings-scroll', prevScroll);

  container.querySelector('.dh-back')?.addEventListener('click', () => back());
  const hygieneReportEl = container.querySelector('.dh-report');
  const hygieneFixBtn = container.querySelector('.dh-fix');
  const hygieneRescanBtn = container.querySelector('.dh-rescan');
  let hygieneScanSequence = 0;
  const refreshHygieneReport = async () => {
    const sequence = ++hygieneScanSequence;
    if (hygieneRescanBtn) {
      hygieneRescanBtn.disabled = true;
      hygieneRescanBtn.textContent = '正在扫描…';
    }
    if (hygieneFixBtn) hygieneFixBtn.disabled = true;
    try {
      const nextReport = await scanDataHygiene();
      if (sequence !== hygieneScanSequence || !container.isConnected) return;
      report = nextReport;
      if (hygieneReportEl) hygieneReportEl.innerHTML = renderReport(nextReport);
      if (hygieneFixBtn) hygieneFixBtn.disabled = !nextReport.total;
    } catch (error) {
      if (sequence !== hygieneScanSequence || !container.isConnected) return;
      report = null;
      if (hygieneReportEl) hygieneReportEl.innerHTML = '<div class="settings-group-hint">扫描失败，请稍后重试。</div>';
      showToast(`扫描失败：${error?.message || error}`);
    } finally {
      if (sequence === hygieneScanSequence && container.isConnected && hygieneRescanBtn) {
        hygieneRescanBtn.disabled = false;
        hygieneRescanBtn.textContent = '重新扫描';
      }
      if (sequence === hygieneScanSequence && container.isConnected && hygieneFixBtn) {
        hygieneFixBtn.textContent = '一键清理';
        hygieneFixBtn.disabled = !report?.total;
      }
    }
  };
  hygieneRescanBtn?.addEventListener('click', () => {
    void refreshHygieneReport();
  });
  container.querySelector('.dh-fix')?.addEventListener('click', async (e) => {
    if (!report?.total) return;
    if (!window.confirm(`确定清理这 ${report.total} 条残留数据？此操作不可撤销。`)) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '正在清理…';
    try {
      const { fixed } = await fixDataHygiene(report);
      showToast(`已清理 ${fixed} 条`);
      await refreshHygieneReport();
    } catch (err) {
      showToast(`清理失败：${err?.message || err}`);
      btn.disabled = false;
      btn.textContent = '一键清理';
    }
  });
  void refreshHygieneReport();
  const mediaReportEl = container.querySelector('.dh-media-report');
  const mediaScanBtn = container.querySelector('.dh-media-scan');
  const mediaCompactBtn = container.querySelector('.dh-media-compact');
  const mediaClearBtn = container.querySelector('.dh-media-clear');
  const voiceClearBtn = container.querySelector('.dh-voice-clear');
  const radioClearBtn = container.querySelector('.dh-radio-clear');
  const audioExportBtn = container.querySelector('.dh-audio-export');
  const imageExportBtn = container.querySelector('.dh-image-export');
  const storageReportEl = container.querySelector('.dh-storage-report');
  const storageScanBtn = container.querySelector('.dh-storage-scan');
  let storageReport = null;
  const scanStorage = async () => {
    if (!storageScanBtn) return;
    storageScanBtn.disabled = true;
    storageScanBtn.textContent = '正在统计…';
    try {
      storageReport = await inspectStorageDistribution();
      if (storageReportEl) storageReportEl.innerHTML = renderStorageReport(storageReport);
      const resetSection = container.querySelector('.dh-reset-section');
      if (resetSection) resetSection.hidden = !storageReport.canFactoryReset;
      const radioBytes = Number(storageReport.opfs?.radioBytes || 0)
        + Number(storageReport.cacheStorage?.radioBytes || 0);
      if (radioClearBtn) radioClearBtn.hidden = radioBytes <= 0;
    } catch (error) {
      if (storageReportEl) storageReportEl.innerHTML = '<div class="settings-group-hint">存储统计失败，请稍后重试。</div>';
      showToast(`存储统计失败：${error?.message || error}`);
    } finally {
      storageScanBtn.disabled = false;
      storageScanBtn.textContent = '重新扫描存储';
    }
  };
  storageScanBtn?.addEventListener('click', scanStorage);
  storageReportEl?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-storage-action]');
    if (!button || button.disabled) return;
    const action = String(button.dataset.storageAction || '');
    const prompts = {
      cache: '清理可重新生成的临时缓存？聊天和设置不会被删除。',
      request_recovery: '清理已经结束的网络请求恢复文件？正在生成的请求、聊天和设置不会被删除。',
      opfs_export_temps: '清理导出中转文件与中断残留？已保存到手机文件中的备份不会受影响，聊天和设置不会被删除。',
      radio_cache: '清理离线音频？聊天、设置与已导出的音频不会被删除。',
      old_safety_backups: '只保留最新一份原生安全备份，并删除更早的备份？',
      old_updates: '清理旧热更新包和下载残留？当前版本与必要回退包会保留。',
      old_vault_generations: '删除原生保险库中已停用的恢复代？当前主数据与正在导入的数据会保留。',
    };
    if (!window.confirm(prompts[action] || '确定清理这部分存储？')) return;
    button.disabled = true;
    button.textContent = '清理中…';
    try {
      const result = await cleanStorageCategory(action);
      showToast(`清理完成${result?.freedBytes ? ` · 释放约 ${formatBytes(result.freedBytes)}` : ''}`);
      await scanStorage();
    } catch (error) {
      showToast(`清理失败：${error?.message || error}`);
      button.disabled = false;
    }
  });
  container.querySelector('.dh-factory-reset')?.addEventListener('click', async (event) => {
    const answer = window.prompt('这会永久删除棉花糖机内的全部档位、聊天、设置、图片、音频、备份与缓存。\n\n如已确认不需要备份，请输入“清空”继续。');
    if (String(answer || '').trim() !== '清空') {
      if (answer !== null) showToast('输入不一致，已取消');
      return;
    }
    if (!window.confirm('最后确认：全部内容都将无法恢复。清空后应用会退出，再次打开即为初始状态。')) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '正在清空…';
    try {
      await factoryResetApplicationData();
      showToast('正在恢复初始化，应用即将退出');
    } catch (error) {
      showToast(`恢复初始化失败：${error?.message || error}`);
      button.disabled = false;
      button.textContent = '清空全部内容';
    }
  });
  container.querySelector('.dh-media-backup')?.addEventListener('click', () => navigate('settings/backup'));
  container.querySelector('.dh-slot-manage')?.addEventListener('click', () => openSlotBatchDelete(container));
  let mediaReport = null;
  let mediaScanController = null;
  mediaScanBtn?.addEventListener('click', async () => {
    if (mediaScanController) {
      mediaScanController.abort();
      return;
    }
    mediaScanController = new AbortController();
    mediaScanBtn.textContent = '正在扫描…';
    try {
      mediaReport = await scanMediaStorage({
        signal: mediaScanController.signal,
        onProgress: ({ storeName, rows, recordKey }) => {
          const rowHint = rows ? ` · ${rows} 条` : '';
          const keyHint = recordKey ? ` · ${String(recordKey).slice(0, 28)}` : '';
          mediaScanBtn.textContent = `停止扫描 · ${storeName}${rowHint}${keyHint}`;
        },
      });
      if (mediaReportEl) mediaReportEl.innerHTML = renderMediaReport(mediaReport);
      if (mediaCompactBtn) mediaCompactBtn.hidden = !(mediaReport.oversizedMessageImages || mediaReport.duplicateMessageImages);
      if (audioExportBtn) audioExportBtn.hidden = !(mediaReport.audioBytes > 0);
      if (imageExportBtn) imageExportBtn.hidden = !(mediaReport.categories?.['聊天图片']?.imageBytes > 0);
      showToast(`媒体占用约 ${formatBytes(mediaReport.totalBytes)}`);
    } catch (error) {
      if (error?.name === 'AbortError') showToast('已停止内容统计');
      else showToast(`媒体扫描失败：${error?.message || error}`);
    } finally {
      mediaScanController = null;
      mediaScanBtn.textContent = mediaReport ? '重新统计内容占用' : '统计内容占用';
    }
  });
  mediaReportEl?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-media-clear-category]');
    if (!button || button.disabled) return;
    const category = String(button.dataset.mediaClearCategory || '');
    if (!window.confirm(`确定清理${category}？动态文字、评论、时间线和外链图片会保留，本机内嵌原图将永久删除。`)) return;
    if (!window.confirm('删除后本机原图无法恢复。建议先导出资源包；确定继续？')) return;
    button.disabled = true;
    button.textContent = '清理中…';
    try {
      const result = await clearLocalMediaCategory(category, {
        onProgress: ({ changed, clearedBytes }) => {
          button.textContent = `${changed} 条 · ${formatBytes(clearedBytes)}`;
        },
      });
      showToast(
        `已清理 ${result.changed} 条内容中的 ${result.clearedPayloads} 份图片，释放约 ${formatBytes(result.clearedBytes)}`
        + (result.failed ? `；${result.failed} 条跳过` : ''),
        12000,
      );
      if (mediaReportEl) mediaReportEl.innerHTML = '<div class="settings-group-hint">清理完成；需要时可重新统计剩余占用。</div>';
    } catch (error) {
      showToast(`清理失败：${error?.message || error}`);
      button.disabled = false;
      button.textContent = '清理';
    }
  });
  radioClearBtn?.addEventListener('click', async () => {
    if (!window.confirm('清理本机缓存的电台与节目音频？需要时可重新生成。')) return;
    radioClearBtn.disabled = true;
    radioClearBtn.textContent = '正在清理…';
    try {
      await cleanStorageCategory('radio_cache');
      showToast('电台缓存已清理');
      radioClearBtn.hidden = true;
      await scanStorage();
    } catch (error) {
      showToast(`电台缓存清理失败：${error?.message || error}`);
    } finally {
      radioClearBtn.disabled = false;
      radioClearBtn.textContent = '清理电台缓存';
    }
  });
  imageExportBtn?.addEventListener('click', async () => {
    imageExportBtn.disabled = true;
    imageExportBtn.textContent = '正在整理聊天图片…';
    try {
      const result = await exportChatImageArchive({
        onProgress: ({ file, phase }) => { imageExportBtn.textContent = `${phase === 'checksum' ? '校验' : '写入'}第 ${file} 张…`; },
      });
      if (!result.saved?.requiresSaveGesture || typeof result.saved.save !== 'function') {
        showToast(`已导出 ${result.files} 张图片 · ${formatBytes(result.imageBytes)}`, 8000);
        return;
      }
      const host = document.getElementById('modal-container');
      if (!host) throw new Error('图片已整理，但无法打开系统保存');
      host.classList.add('active');
      host.innerHTML = `
        <div class="modal-overlay modal-sheet-center" data-image-save-overlay>
          <section class="modal-sheet scrapbook-card" role="dialog" aria-modal="true">
            <header class="modal-header"><h3>聊天图片已整理好</h3></header>
            <div class="modal-body"><button type="button" class="btn btn-primary" data-image-save-confirm>保存到文件</button></div>
          </section>
        </div>`;
      const close = () => { host.classList.remove('active'); host.innerHTML = ''; };
      host.querySelector('[data-image-save-overlay]')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) close();
      });
      host.querySelector('[data-image-save-confirm]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = '正在打开…';
        try {
          await result.saved.save();
          close();
          showToast(`已导出 ${result.files} 张图片 · ${formatBytes(result.imageBytes)}`, 8000);
        } catch (error) {
          button.disabled = false;
          button.textContent = '重新保存';
          showToast(String(error?.message || error));
        }
      });
    } catch (error) {
      showToast(`图片导出失败：${error?.message || error}`);
    } finally {
      imageExportBtn.disabled = false;
      imageExportBtn.textContent = '批量导出聊天图片';
    }
  });
  audioExportBtn?.addEventListener('click', async () => {
    audioExportBtn.disabled = true;
    audioExportBtn.textContent = '正在整理音频…';
    try {
      const result = await exportAudioMediaArchive({
        onProgress: ({ kind, file, totalFiles, phase }) => {
          const label = ({ voice: '语音', sounds: '音效', radio: '电台', music: '音乐' })[kind] || '音频';
          audioExportBtn.textContent = `${phase === 'checksum' ? '校验' : '写入'}${label} ${file}/${totalFiles}…`;
        },
      });
      if (!result.saved?.requiresSaveGesture || typeof result.saved.save !== 'function') {
        showToast(`已导出 ${result.files} 份音频 · ${formatBytes(result.audioBytes)}`, 8000);
      } else {
        const host = document.getElementById('modal-container');
        if (!host) throw new Error('音频已整理，但无法打开系统保存');
        host.classList.add('active');
        host.innerHTML = `
          <div class="modal-overlay modal-sheet-center" data-audio-save-overlay>
            <section class="modal-sheet scrapbook-card" role="dialog" aria-modal="true">
              <header class="modal-header"><h3>音频已整理好</h3></header>
              <div class="modal-body"><button type="button" class="btn btn-primary" data-audio-save-confirm>保存到文件</button></div>
            </section>
          </div>`;
        const close = () => { host.classList.remove('active'); host.innerHTML = ''; };
        host.querySelector('[data-audio-save-overlay]')?.addEventListener('click', (event) => {
          if (event.target === event.currentTarget) close();
        });
        host.querySelector('[data-audio-save-confirm]')?.addEventListener('click', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          button.textContent = '正在打开…';
          try {
            await result.saved.save();
            close();
            showToast(`已导出 ${result.files} 份音频 · ${formatBytes(result.audioBytes)}`, 8000);
          } catch (error) {
            button.disabled = false;
            button.textContent = '重新保存';
            showToast(String(error?.message || error));
          }
        });
      }
    } catch (error) {
      showToast(`音频导出失败：${error?.message || error}`);
    } finally {
      audioExportBtn.disabled = false;
      audioExportBtn.textContent = '批量导出音频';
    }
  });
  voiceClearBtn?.addEventListener('click', async () => {
    if (!window.confirm('语音缓存可先通过资源包或 API 管理逐条导出。确定清理本机全部语音缓存？')) return;
    voiceClearBtn.disabled = true;
    voiceClearBtn.textContent = '正在清理…';
    try {
      await clearVoiceCache();
      showToast('语音缓存已清理');
      if (mediaReportEl) mediaReportEl.innerHTML = '<div class="settings-group-hint">语音缓存已清理；需要时可重新统计剩余占用。</div>';
    } catch (error) {
      showToast(`语音缓存清理失败：${error?.message || error}`);
    } finally {
      voiceClearBtn.disabled = false;
      voiceClearBtn.textContent = '清理语音缓存';
    }
  });
  mediaCompactBtn?.addEventListener('click', async () => {
    if (!window.confirm('瘦身会逐张压缩历史聊天图片并清除重复字段。请先完成搬家包或云备份；继续？')) return;
    mediaCompactBtn.disabled = true;
    try {
      const result = await compactOversizedMessageImages({
        onProgress: ({ changed }) => { mediaCompactBtn.textContent = `已处理 ${changed} 张…`; },
      });
      showToast(`已瘦身 ${result.changed} 张，约释放 ${formatBytes(Math.max(0, result.beforeBytes - result.afterBytes))}`);
      if (mediaReportEl) mediaReportEl.innerHTML = '<div class="settings-group-hint">图片瘦身完成；需要时可重新统计剩余占用。</div>';
    } catch (error) {
      showToast(`图片瘦身失败：${error?.message || error}`);
    } finally {
      mediaCompactBtn.disabled = false;
      mediaCompactBtn.textContent = '安全瘦身聊天图片';
    }
  });
  mediaClearBtn?.addEventListener('click', async () => {
    if (!window.confirm('这会永久删除聊天记录中的本地图片，只保留消息位置、说明文字和生图提示词。请先备份；继续？')) return;
    if (!window.confirm('最后确认：删除后原图无法在本机恢复。确定紧急释放聊天图片占用？')) return;
    mediaClearBtn.disabled = true;
    try {
      const result = await clearLocalMessageImages({
        onProgress: ({ changed, clearedBytes }) => {
          mediaClearBtn.textContent = `已清理 ${changed} 条 · ${formatBytes(clearedBytes)}`;
        },
      });
      showToast(
        `已清除 ${result.clearedPayloads} 份图片数据，释放约 ${formatBytes(result.clearedBytes)}`
        + (result.failed ? `；${result.failed} 条跳过` : ''),
        12000,
      );
      if (mediaReportEl) mediaReportEl.innerHTML = '<div class="settings-group-hint">聊天图片已清理；需要时可重新统计剩余占用。</div>';
    } catch (error) {
      showToast(`聊天图片清除失败：${error?.message || error}`);
    } finally {
      mediaClearBtn.disabled = false;
      mediaClearBtn.textContent = '紧急清除聊天图片';
    }
  });
}
