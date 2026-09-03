import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import {
  downloadAssetBackup,
  downloadMigrationPackage,
  downloadRegionBackup,
  formatExportOmissionHint,
  importFullBackupFiles,
  importBeautifyAssetsSupplement,
  previewRegionBackup,
} from '../core/backup.js';
import {
  ANDROID_EMERGENCY_REGION_PART_TARGET_BYTES,
  ANDROID_REGION_PART_TARGET_BYTES,
  getCoreBackupRegions,
  summarizeRegionBackupPlan,
} from '../core/backup-regions.js';
import { isOpfsCapabilityError } from '../core/opfs-temp.js';
import {
  describeDownloadResult,
  isAndroidDevice,
  isIOSDevice,
  isNativeShell,
} from '../core/native-download.js';
import { triggerFileInput } from '../core/open-file-picker.js';
import { formatStorageBytes } from '../core/storage-persistence.js';
import {
  backupImportResumeCheckpoint,
  failBackupImportSession,
  fingerprintBackupImportFile,
  finishBackupImportSession,
  finishBeautifySupplementSession,
  getBeautifySupplementSession,
  getBackupImportSession,
  matchesBeautifySupplementFile,
  matchesBackupImportSessionFile,
  saveBeautifySupplementSession,
  saveBackupImportSkippedNotice,
  startBackupImportSession,
  updateBackupImportSession,
} from '../core/backup-import-session.js';

const ADVANCED_PART_BYTES = 256 * 1024 * 1024;

function esc(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setBusy(button, busy, label = '') {
  if (!button) return;
  button.disabled = busy;
  button.toggleAttribute('aria-busy', busy);
  const strong = button.querySelector('strong');
  if (strong && label) strong.textContent = label;
}

function confirmThenPick(fileInput, title, message) {
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
    <div class="modal-overlay modal-sheet-center" data-pick-overlay>
      <div class="modal-sheet scrapbook-card" role="alertdialog" aria-modal="true" data-pick-sheet>
        <div class="modal-header"><h3>${esc(title)}</h3></div>
        <div class="modal-body" style="font-size:14px;line-height:1.65;color:var(--text-secondary);">${esc(message)}</div>
        <div class="modal-body" style="display:flex;gap:8px;padding-top:0;">
          <button type="button" class="btn btn-outline" data-pick-cancel style="flex:1;">取消</button>
          <button type="button" class="btn btn-primary" data-pick-confirm style="flex:1;">继续选择文件</button>
        </div>
      </div>
    </div>`;
  host.querySelector('[data-pick-sheet]')?.addEventListener('click', (event) => event.stopPropagation());
  host.querySelector('[data-pick-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-pick-cancel]')?.addEventListener('click', close);
  host.querySelector('[data-pick-confirm]')?.addEventListener('click', () => {
    try { triggerFileInput(fileInput); } finally { close(); }
  });
}

function openDeferredSave(result, title, summary) {
  const save = result?.saved;
  if (!save?.requiresSaveGesture || typeof save.save !== 'function') return false;
  const host = document.getElementById('modal-container');
  if (!host) return false;
  const close = (discard = true) => {
    host.classList.remove('active');
    host.innerHTML = '';
    if (discard) void save.discard?.();
  };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center" data-save-overlay>
      <div class="modal-sheet scrapbook-card" role="dialog" aria-modal="true" data-save-sheet>
        <div class="modal-header"><h3>${esc(title)}</h3></div>
        <div class="modal-body" style="font-size:14px;line-height:1.65;color:var(--text-secondary);">${esc(summary)}</div>
        <div class="modal-body" style="display:flex;gap:8px;padding-top:0;">
          <button type="button" class="btn btn-outline" data-save-cancel style="flex:1;">取消</button>
          <button type="button" class="btn btn-primary" data-save-confirm style="flex:1;">保存到文件</button>
        </div>
      </div>
    </div>`;
  host.querySelector('[data-save-sheet]')?.addEventListener('click', (event) => event.stopPropagation());
  host.querySelector('[data-save-overlay]')?.addEventListener('click', () => close());
  host.querySelector('[data-save-cancel]')?.addEventListener('click', () => close());
  host.querySelector('[data-save-confirm]')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '正在打开…';
    Promise.resolve(save.save()).then((saved) => {
      close(false);
      showToast(`${describeDownloadResult(saved)} · ${summary}`, 9000);
    }).catch((error) => {
      button.disabled = false;
      button.textContent = '重新保存';
      showToast(String(error?.message || error), 6000);
    });
  });
  return true;
}

async function saveRegionBackupSequence(prepared, firstPrompt) {
  const plan = summarizeRegionBackupPlan(prepared);
  if (!window.confirm(firstPrompt(plan))) {
    await prepared.discard?.();
    return false;
  }
  while (true) {
    const saved = await prepared.next();
    if (!saved?.remaining) break;
    await prepared.prepareNext();
    if (!window.confirm(`已保存 ${saved.completed}/${saved.total}，继续保存下一个分区？`)) {
      await prepared.discard?.();
      return false;
    }
  }
  return true;
}

async function prepareEmergencyCoreBackup() {
  const regionIds = getCoreBackupRegions().map((region) => region.id);
  const preview = await previewRegionBackup({
    regionIds,
    partTargetBytes: ANDROID_EMERGENCY_REGION_PART_TARGET_BYTES,
  });
  return downloadRegionBackup({
    preview,
    regionIds,
    partTargetBytes: ANDROID_EMERGENCY_REGION_PART_TARGET_BYTES,
    allowMemoryFallback: true,
  });
}

async function runEmergencyCoreExport() {
  const prepared = await prepareEmergencyCoreBackup();
  const completed = await saveRegionBackupSequence(prepared, (plan) => (
    `当前浏览器不开放完整搬家所需的临时文件。\n\n`
    + `可改为 ${plan.fileCount} 个小型核心数据分片逐个保存，不包含图片、音频等大资源。是否继续？`
  ));
  if (completed) showToast('核心数据已应急导出，请保留同一批全部分片', 9000);
  return completed;
}

async function runCompleteImport(file, button) {
  if (!file) return;
  const fingerprint = await fingerprintBackupImportFile(file).catch(() => '');
  const previous = getBackupImportSession();
  const matchesPrevious = previous && matchesBackupImportSessionFile(previous, file, fingerprint);
  const resume = matchesPrevious
    ? backupImportResumeCheckpoint(previous)
    : null;
  const lowMemoryBeautifyRecovery = !!matchesPrevious
    && ['interrupted', 'failed'].includes(String(previous?.status || ''))
    && String(previous?.storeName || '').includes('beautifyAssets');
  startBackupImportSession(file, resume, fingerprint);
  setBusy(button, true, '正在导入…');
  const onProgress = (event) => {
    const detail = event.detail || {};
    updateBackupImportSession(detail);
    const pct = detail.totalBytes
      ? Math.min(99, Math.round((Number(detail.bytesRead || 0) / detail.totalBytes) * 100))
      : 0;
    const label = detail.storeName
      ? `正在写入 ${detail.storeName}${pct ? ` ${pct}%` : ''}…`
      : (detail.phase === 'preflight' ? '正在校验…' : '正在导入…');
    setBusy(button, true, label);
  };
  window.addEventListener('marshmallow-backup-import-progress', onProgress);
  try {
    const result = await importFullBackupFiles([file], {
      mode: 'replace',
      __resumeCheckpoint: resume,
      __skipBeautifyAssets: lowMemoryBeautifyRecovery,
    });
    const skipped = Array.isArray(result.skippedAssets) ? result.skippedAssets : [];
    saveBackupImportSkippedNotice(skipped, file);
    if (result.beautifyResumeIndex != null) {
      saveBeautifySupplementSession(file, fingerprint, {
        nextIndex: result.beautifyResumeIndex,
        totalRows: result.assetCounts?.beautifyAssets,
        restoredRows: result.restoredAssetCounts?.beautifyAssets,
      });
    } else {
      finishBeautifySupplementSession();
    }
    finishBackupImportSession();
    const rows = Object.values(result.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    const supplementHint = result.beautifyResumeIndex != null ? ' · 可在本页继续补导美化资源' : '';
    showToast(`完整搬家已导入 · ${rows} 条${skipped.length ? ` · ${skipped.length} 类资源待处理` : ''}${supplementHint}`, 9000);
    setTimeout(() => window.location.reload(), 900);
  } catch (error) {
    failBackupImportSession(error);
    showToast(String(error?.message || error), 7000);
  } finally {
    window.removeEventListener('marshmallow-backup-import-progress', onProgress);
    setBusy(button, false, '导入完整搬家包');
  }
}

export default async function render(container) {
  const modules = getCoreBackupRegions();
  const beautifySupplement = getBeautifySupplementSession();
  container.className = 'page settings-page backup-migration-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn backup-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">备份与迁移</h1>
      <span class="navbar-spacer"></span>
    </header>
    <main class="settings-scroll backup-migration-scroll">
      <section class="settings-group">
        <div class="settings-group-title">完整搬家</div>
        <button type="button" class="scrapbook-list-item settings-row backup-complete-export">
          <span class="scrapbook-list-icon is-cream">${icon('upload')}</span>
          <span class="scrapbook-list-body settings-row-main"><strong>导出完整搬家包</strong><small>全部数据与资源 · 流式低内存</small></span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <button type="button" class="scrapbook-list-item settings-row backup-complete-import">
          <span class="scrapbook-list-icon is-peach">${icon('download')}</span>
          <span class="scrapbook-list-body settings-row-main"><strong>导入完整搬家包</strong><small>.mmmigrate / .bin / JSON</small></span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        ${beautifySupplement ? `
        <button type="button" class="scrapbook-list-item settings-row backup-beautify-supplement">
          <span class="scrapbook-list-icon is-peach">${icon('image')}</span>
          <span class="scrapbook-list-body settings-row-main"><strong>继续补导美化资源</strong><small>已处理 ${Number(beautifySupplement.nextIndex || 0)} / ${Number(beautifySupplement.totalRows || 0)} · 请选择原搬家包</small></span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <input type="file" class="backup-beautify-supplement-file" accept="application/json,.json,application/vnd.marshmallow.migration+json,.mmmigrate,application/octet-stream,.bin" hidden />
        ` : ''}
        <input type="file" class="backup-complete-file" accept="application/json,.json,application/vnd.marshmallow.migration+json,.mmmigrate,application/octet-stream,.bin" hidden />
      </section>

      <section class="settings-group backup-advanced-group">
        <div class="settings-group-title">高级导出 / 导入</div>
        <div class="backup-module-picker">
          ${modules.map((module) => `
            <label class="scrapbook-list-item settings-row backup-module-row">
              <span class="scrapbook-list-body settings-row-main"><strong>${esc(module.label)}</strong></span>
              <input type="checkbox" value="${esc(module.id)}" checked />
            </label>`).join('')}
          <label class="scrapbook-list-item settings-row backup-module-row">
            <span class="scrapbook-list-body settings-row-main"><strong>图片与音频资源</strong></span>
            <input type="checkbox" value="assets" checked />
          </label>
        </div>
        <button type="button" class="scrapbook-list-item settings-row backup-advanced-export">
          <span class="scrapbook-list-icon is-cream">${icon('save')}</span>
          <span class="scrapbook-list-body settings-row-main"><strong>导出选中分区</strong><small>业务分区独立保存，超大分区才自动分卷</small></span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <button type="button" class="scrapbook-list-item settings-row backup-advanced-import">
          <span class="scrapbook-list-icon is-peach">${icon('package')}</span>
          <span class="scrapbook-list-body settings-row-main"><strong>高级导入</strong><small>自动识别新分区与旧数据包、资源包</small></span>
          <span class="scrapbook-list-meta settings-row-meta">${icon('chevron')}</span>
        </button>
        <input type="file" class="backup-advanced-file" accept="application/json,.json,application/zip,.zip,application/vnd.marshmallow.migration+json,.mmmigrate,application/octet-stream,.bin" multiple hidden />
      </section>
    </main>`;

  container.querySelector('.backup-back')?.addEventListener('click', () => back());
  const completeExport = container.querySelector('.backup-complete-export');
  completeExport?.addEventListener('click', async () => {
    setBusy(completeExport, true, '正在整理…');
    try {
      const result = await downloadMigrationPackage({
        onProgress: ({ phase, bytes, loadedBytes, totalBytes }) => {
          if (phase === 'write') setBusy(completeExport, true, `正在写入 ${formatStorageBytes(bytes || 0)}…`);
          if (phase === 'checksum') {
            const pct = totalBytes ? Math.round((loadedBytes / totalBytes) * 100) : 0;
            setBusy(completeExport, true, `正在校验 ${pct}%…`);
          }
        },
      });
      const summary = `${formatStorageBytes(result.bytes)} · SHA ${result.sha256.slice(0, 12)}…`;
      if (!openDeferredSave(result, '搬家包已整理好', summary)) {
        showToast(`${describeDownloadResult(result.saved)} · ${summary}`, 10000);
      }
    } catch (error) {
      if (isOpfsCapabilityError(error)) {
        try {
          await runEmergencyCoreExport();
        } catch (rescueError) {
          showToast(`应急导出失败：${rescueError?.message || rescueError}`, 8000);
        }
      } else {
        showToast(String(error?.message || error), 7000);
      }
    } finally {
      setBusy(completeExport, false, '导出完整搬家包');
    }
  });

  const completeFile = container.querySelector('.backup-complete-file');
  const completeImport = container.querySelector('.backup-complete-import');
  completeImport?.addEventListener('click', () => confirmThenPick(
    completeFile,
    '导入完整搬家包',
    '会先校验文件，再用搬家内容替换当前数据；新架构包会在原生暂存代完成后才切换。',
  ));
  completeFile?.addEventListener('change', async () => {
    const file = completeFile.files?.[0];
    completeFile.value = '';
    await runCompleteImport(file, completeImport);
  });

  const supplementInput = container.querySelector('.backup-beautify-supplement-file');
  const supplementButton = container.querySelector('.backup-beautify-supplement');
  supplementButton?.addEventListener('click', () => triggerFileInput(supplementInput));
  supplementInput?.addEventListener('change', async () => {
    const file = supplementInput.files?.[0];
    supplementInput.value = '';
    if (!file || !beautifySupplement) return;
    const fingerprint = await fingerprintBackupImportFile(file).catch(() => '');
    if (!matchesBeautifySupplementFile(beautifySupplement, file, fingerprint)) {
      showToast('请选择主数据导入时使用的同一个搬家包', 7000);
      return;
    }
    setBusy(supplementButton, true, '正在补导美化资源…');
    const onProgress = (event) => {
      const detail = event.detail || {};
      if (detail.storeName !== 'assets/beautifyAssets') return;
      setBusy(supplementButton, true, `正在补导 ${Number(detail.rows || 0)} / ${Number(beautifySupplement.totalRows || 0)}…`);
    };
    window.addEventListener('marshmallow-backup-import-progress', onProgress);
    try {
      const result = await importBeautifyAssetsSupplement(file, {
        startIndex: beautifySupplement.nextIndex,
      });
      const restoredRows = Number(beautifySupplement.restoredRows || 0) + Number(result.restoredRows || 0);
      if (result.complete) {
        finishBeautifySupplementSession();
        showToast(`美化资源补导完成 · 本轮恢复 ${result.restoredRows || 0} 项`, 7000);
      } else {
        saveBeautifySupplementSession(file, fingerprint, {
          nextIndex: result.nextIndex,
          totalRows: result.totalRows,
          restoredRows,
        });
        showToast(`本批已恢复 ${result.restoredRows || 0} 项 · 下次从 ${result.nextIndex || 0}/${result.totalRows || 0} 继续`, 8000);
      }
      window.dispatchEvent(new CustomEvent('appearance-prefs-invalidate'));
      await render(container);
    } catch (error) {
      showToast(`美化资源补导失败：${error?.message || error}`, 7000);
    } finally {
      window.removeEventListener('marshmallow-backup-import-progress', onProgress);
      setBusy(supplementButton, false, '继续补导美化资源');
    }
  });

  const advancedExport = container.querySelector('.backup-advanced-export');
  advancedExport?.addEventListener('click', async () => {
    const selected = [...container.querySelectorAll('.backup-module-row input:checked')].map((input) => input.value);
    const regionIds = selected.filter((id) => id !== 'assets');
    const includeAssets = selected.includes('assets');
    if (!regionIds.length && !includeAssets) {
      showToast('请至少选择一个分区');
      return;
    }
    setBusy(advancedExport, true, '正在整理分区…');
    try {
      if (regionIds.length) {
        const partTargetBytes = isAndroidDevice() && !isNativeShell()
          ? ANDROID_REGION_PART_TARGET_BYTES
          : ADVANCED_PART_BYTES;
        const preview = await previewRegionBackup({ regionIds, partTargetBytes });
        let prepared;
        let emergency = false;
        try {
          prepared = await downloadRegionBackup({ preview, regionIds, partTargetBytes });
        } catch (error) {
          if (!isOpfsCapabilityError(error)) throw error;
          emergency = true;
          const rescuePreview = await previewRegionBackup({
            regionIds,
            partTargetBytes: ANDROID_EMERGENCY_REGION_PART_TARGET_BYTES,
          });
          prepared = await downloadRegionBackup({
            preview: rescuePreview,
            regionIds,
            partTargetBytes: ANDROID_EMERGENCY_REGION_PART_TARGET_BYTES,
            allowMemoryFallback: true,
          });
        }
        const completed = await saveRegionBackupSequence(prepared, (plan) => (
          emergency
            ? `当前浏览器已切换小分片应急导出，将保存 ${plan.fileCount} 个文件，继续？`
            : `选中分区将保存 ${plan.fileCount} 个文件，继续？`
        ));
        if (!completed) return;
        const omitted = formatExportOmissionHint(prepared.omissions);
        showToast(`分区数据已导出${omitted ? ` · ${omitted}` : ''}`, 7000);
      }
      if (includeAssets) {
        const assets = await downloadAssetBackup({ deferWebSave: isIOSDevice() || isAndroidDevice() });
        const summary = `${formatStorageBytes(assets.bytes || 0)} · 图片、音频与本地资源`;
        if (!openDeferredSave(assets, '资源分区已整理好', summary)) {
          showToast(`${describeDownloadResult(assets.saved)} · ${summary}`, 8000);
        }
      }
    } catch (error) {
      showToast(String(error?.message || error), 7000);
    } finally {
      setBusy(advancedExport, false, '导出选中分区');
    }
  });

  const advancedFile = container.querySelector('.backup-advanced-file');
  const advancedImport = container.querySelector('.backup-advanced-import');
  advancedImport?.addEventListener('click', () => confirmThenPick(
    advancedFile,
    '高级导入',
    '可选择一个数据包、资源包，或同一批次的多个分区文件。资源会合并写入，部分分区不会清空未选内容。',
  ));
  advancedFile?.addEventListener('change', async () => {
    const files = [...(advancedFile.files || [])];
    advancedFile.value = '';
    if (!files.length) return;
    setBusy(advancedImport, true, '正在识别…');
    try {
      const result = await importFullBackupFiles(files, { mode: 'merge' });
      const rows = Object.values(result?.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
      showToast(`高级导入完成 · ${rows} 条，正在刷新`, 7000);
      setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      showToast(String(error?.message || error), 7000);
    } finally {
      setBusy(advancedImport, false, '高级导入');
    }
  });
}
