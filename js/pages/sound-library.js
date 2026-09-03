import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import {
  SOUND_ASSET_CATEGORIES,
  SOUND_ASSET_LIBRARY_OWNER_ID,
  createSoundAssetPlayback,
  createSoundAssetPlaybackBlob,
  deleteSoundAssetCustomCategory,
  deleteSoundAsset,
  inferWetSoundAssetProfile,
  getSoundAsset,
  listRecentSoundAssetPlaybackTrace,
  listSoundAssetCategoryCatalog,
  listSoundAssetSummaries,
  saveSoundAsset,
  saveSoundAssetCustomCategory,
  soundAssetCategoryMode,
  soundAssetCategoryLabel,
  soundAssetCategoryFromPrefixedName,
  stripSoundAssetCategoryPrefix,
  updateSoundAssetMetadata,
} from '../core/sound-library.js';
import { readSoundAssetPackZip } from '../core/sound-pack-zip.js';
import { audioFromGestureOrNew, captureMediaGesture } from '../core/media-playback.js';

let previewAudio = null;
let previewCleanup = null;
const AUDIO_METADATA_TIMEOUT_MS = 8000;

async function requestPersistentSoundLibraryStorage() {
  try {
    const storage = globalThis.navigator?.storage;
    if (typeof storage?.persist !== 'function') return false;
    return !!(await storage.persist());
  } catch (_) {
    return false;
  }
}

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fileBaseName(file = {}) {
  const name = String(file.name || '').replace(/\.[^.]+$/, '').trim();
  return stripSoundAssetCategoryPrefix(name).trim() || '未命名音频';
}

function prefixedCategoryForFile(file = {}) {
  return soundAssetCategoryFromPrefixedName(file.name);
}

function formatDuration(milliseconds = 0) {
  const total = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatSize(bytes = 0) {
  const size = Math.max(0, Number(bytes || 0));
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function inspectAudioFile(file, sourceName = '') {
  return new Promise((resolve) => {
    const blob = createSoundAssetPlaybackBlob({
      audioBlob: file,
      audioType: file?.type,
      sourceName: sourceName || file?.name || '',
    });
    if (!(blob instanceof Blob)) {
      resolve({ playable: false, durationMs: 0, blob: null, reason: 'empty' });
      return;
    }
    const audio = new Audio();
    const support = typeof audio.canPlayType === 'function' && blob.type
      ? audio.canPlayType(blob.type)
      : 'maybe';
    if (!support) {
      resolve({ playable: false, durationMs: 0, blob, reason: 'type' });
      return;
    }
    const url = URL.createObjectURL(blob);
    let timer = 0;
    let settled = false;
    const finish = (playable, value = 0, reason = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.oncanplay = null;
      audio.onerror = null;
      try {
        audio.removeAttribute('src');
        audio.load?.();
      } catch (_) {}
      try { URL.revokeObjectURL(url); } catch (_) {}
      resolve({
        playable: !!playable,
        durationMs: playable ? Math.max(0, Math.round(Number(value || 0) * 1000)) : 0,
        blob,
        reason,
      });
    };
    audio.preload = 'metadata';
    audio.setAttribute('playsinline', 'true');
    audio.onloadedmetadata = () => finish(true, audio.duration);
    audio.oncanplay = () => finish(true, audio.duration);
    audio.onerror = () => finish(false, 0, 'decode');
    timer = setTimeout(() => finish(false, 0, 'timeout'), AUDIO_METADATA_TIMEOUT_MS);
    audio.src = url;
    try { audio.load?.(); } catch (_) {}
  });
}

function categoryOptions(selected = '', catalog = SOUND_ASSET_CATEGORIES) {
  return catalog.map((item) => (
    `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(item.label)}</option>`
  )).join('');
}

function importCategoryOptions(selected = '', catalog = SOUND_ASSET_CATEGORIES) {
  return `
    <option value="__auto__" ${selected === '__auto__' ? 'selected' : ''}>按文件名前缀自动分类</option>
    ${categoryOptions(selected, catalog)}
  `;
}

function soundCategoryModeLabel(value = '') {
  if (value === 'texture') return '持续纹理';
  if (value === 'background') return '背景循环';
  return '单次声音';
}

function recentPlaybackLabel(value = 0) {
  const elapsed = Math.max(0, Date.now() - Number(value || 0));
  if (elapsed < 60_000) return '刚刚调用';
  if (elapsed < 60 * 60_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前调用`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.max(1, Math.floor(elapsed / (60 * 60_000)))} 小时前调用`;
  return `${Math.max(1, Math.floor(elapsed / (24 * 60 * 60_000)))} 天前调用`;
}

function stopPreview() {
  try {
    previewAudio?.pause?.();
    if (previewAudio) previewAudio.currentTime = 0;
  } catch (_) {}
  previewAudio = null;
  previewCleanup?.();
  previewCleanup = null;
}

export default async function render(container, params = {}) {
  const stopWhenDisposed = (event) => {
    if (event?.detail?.container !== container) return;
    stopPreview();
    window.removeEventListener('marshmallow-route-disposed', stopWhenDisposed);
  };
  window.addEventListener('marshmallow-route-disposed', stopWhenDisposed);
  let category = String(params.category || 'all').trim() || 'all';
  let assets = await listSoundAssetSummaries();
  let categoryCatalog = await listSoundAssetCategoryCatalog();
  let playbackTrace = await listRecentSoundAssetPlaybackTrace();
  let manageMode = false;
  let scanningInvalid = false;
  let editingCategoryId = '';
  let filterScrollLeft = 0;
  const selectedIds = new Set();

  const draw = () => {
    filterScrollLeft = Number(container.querySelector('.sound-library-filters')?.scrollLeft || filterScrollLeft || 0);
    const categoryDefinition = (id = '') => categoryCatalog.find((item) => item.id === id) || null;
    const recentByAssetId = new Map(playbackTrace.map((item) => [item.assetId, item]));
    const visible = category === 'all'
      ? assets
      : (category === 'recent'
        ? playbackTrace.map((trace) => assets.find((item) => item.id === trace.assetId)).filter(Boolean)
        : assets.filter((item) => item.category === category));
    container.className = 'page sound-library-page';
    container.innerHTML = `
      <header class="sound-library-nav">
        <button type="button" class="sound-library-back" aria-label="返回">${icon('back')}</button>
        <h1>音频库</h1>
        <div class="sound-library-nav-actions">
          <button type="button" class="sound-library-categories" ${manageMode ? 'hidden' : ''}>分类</button>
          <button type="button" class="sound-library-manage">${manageMode ? '完成' : '管理'}</button>
          <button type="button" class="sound-library-add" ${manageMode ? 'hidden' : ''}>导入</button>
        </div>
      </header>
      <main class="sound-library-scroll">
        <div class="sound-library-filters" role="tablist" aria-label="音频分类">
          <button type="button" data-category="all" class="${category === 'all' ? 'is-active' : ''}">全部</button>
          <button type="button" data-category="recent" class="${category === 'recent' ? 'is-active' : ''}">最近调用</button>
          ${categoryCatalog.map((item) => `
            <button type="button" data-category="${esc(item.id)}" class="${category === item.id ? 'is-active' : ''}">${esc(item.label)}</button>
          `).join('')}
        </div>
        <div class="sound-library-tools">
          ${manageMode ? `
            <button type="button" class="sound-library-select-all">${visible.length && visible.every((item) => selectedIds.has(item.id)) ? '取消全选' : '全选当前'}</button>
            <span>已选 ${selectedIds.size} 条</span>
            <select class="sound-library-move-category" aria-label="批量移动到分类" ${selectedIds.size ? '' : 'disabled'}>
              <option value="">移动到…</option>
              ${categoryOptions('', categoryCatalog)}
            </select>
            <button type="button" class="sound-library-delete-selected" ${selectedIds.size ? '' : 'disabled'}>删除</button>
          ` : `
            <span>共 ${assets.length} 条</span>
            <button type="button" class="sound-library-clear-invalid" ${scanningInvalid || !assets.length ? 'disabled' : ''}>${scanningInvalid ? '正在检查' : '清空失效音频'}</button>
          `}
        </div>
        <section class="sound-library-list">
          ${visible.length ? visible.map((item) => `
            <article class="sound-asset-row ${item.enabled === false ? 'is-disabled' : ''} ${manageMode ? 'is-managing' : ''} ${selectedIds.has(item.id) ? 'is-selected' : ''}" data-sound-id="${esc(item.id)}">
              ${manageMode ? `
                <label class="sound-asset-select" aria-label="选择 ${esc(item.name)}">
                  <input type="checkbox" ${selectedIds.has(item.id) ? 'checked' : ''} />
                  <span aria-hidden="true"></span>
                </label>
              ` : `<button type="button" class="sound-asset-play" aria-label="试听">${icon('play')}</button>`}
              <div class="sound-asset-main">
                <input type="text" class="sound-asset-name" maxlength="80" value="${esc(item.name)}" aria-label="音频名称" ${manageMode ? 'disabled' : ''} />
                <div class="sound-asset-meta">${recentByAssetId.has(item.id) ? `${esc(recentPlaybackLabel(recentByAssetId.get(item.id).playedAt))} · ` : ''}${esc(soundAssetCategoryLabel(item.category, categoryDefinition(item.category)))}${item.category === 'wet' ? ` · ${esc(inferWetSoundAssetProfile(item).label)}` : ''} · ${formatDuration(item.durationMs)} · ${formatSize(item.size)}</div>
              </div>
              <div class="sound-asset-controls" ${manageMode ? 'hidden' : ''}>
                <label class="sound-asset-enabled">
                  <input type="checkbox" ${item.enabled === false ? '' : 'checked'} />
                  <span>启用</span>
                </label>
                <select class="sound-asset-category" aria-label="音频分类">${categoryOptions(item.category, categoryCatalog)}</select>
                ${soundAssetCategoryMode(item.categoryMode || item.category) === 'texture' ? `
                  <select class="sound-asset-texture-playback" aria-label="纹理播放方式">
                    <option value="auto" ${item.texturePlayback === 'auto' || !item.texturePlayback ? 'selected' : ''}>自动</option>
                    <option value="shot" ${item.texturePlayback === 'shot' ? 'selected' : ''}>短触发</option>
                    <option value="span" ${item.texturePlayback === 'span' ? 'selected' : ''}>整段</option>
                  </select>
                  <select class="sound-asset-mix-gain" aria-label="素材响度">
                    <option value="1" ${Number(item.mixGain || 1) === 1 ? 'selected' : ''}>正常响度</option>
                    <option value="1.35" ${Number(item.mixGain || 1) === 1.35 ? 'selected' : ''}>增强</option>
                    <option value="1.8" ${Number(item.mixGain || 1) === 1.8 ? 'selected' : ''}>强增强</option>
                  </select>
                ` : ''}
              </div>
              <button type="button" class="sound-asset-delete" aria-label="删除" ${manageMode ? 'hidden' : ''}>${icon('trash')}</button>
            </article>
          `).join('') : `
            <div class="sound-library-empty">
              <div class="sound-library-empty-mark">♫</div>
              <strong>这里还没有音频</strong>
              <span>导入音频，或直接选择 ZIP 音频包</span>
            </div>
          `}
        </section>
      </main>
      <input type="file" class="sound-library-file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.zip,application/zip,application/x-zip-compressed" multiple hidden />
      <div class="sound-library-import-sheet" hidden>
        <div class="sound-library-import-card">
          <h2>这批音频属于</h2>
          <select class="form-input sound-library-import-category">${importCategoryOptions(category === 'all' ? 'kiss' : category, categoryCatalog)}</select>
          <div class="sound-library-import-actions">
            <button type="button" class="btn btn-outline sound-library-import-cancel">取消</button>
            <button type="button" class="btn btn-primary sound-library-import-confirm">导入</button>
          </div>
        </div>
      </div>
      <div class="sound-library-category-sheet" hidden>
        <div class="sound-library-category-card">
          <div class="sound-library-category-heading">
            <h2>自定义分类</h2>
            <button type="button" class="sound-library-category-close" aria-label="关闭">完成</button>
          </div>
          <div class="sound-library-custom-list">
            ${categoryCatalog.filter((item) => !item.builtIn).map((item) => `
              <div class="sound-library-custom-row" data-category-id="${esc(item.id)}">
                <button type="button" class="sound-library-custom-edit">
                  <strong>${esc(item.label)}</strong>
                  <span>${esc(soundCategoryModeLabel(item.mode))} · ${esc(item.hint)}</span>
                </button>
                <button type="button" class="sound-library-custom-delete" aria-label="删除 ${esc(item.label)}">${icon('trash')}</button>
              </div>
            `).join('') || '<div class="sound-library-custom-empty">还没有自定义分类</div>'}
          </div>
          <form class="sound-library-category-form">
            <input type="hidden" class="sound-library-category-id" value="${esc(editingCategoryId)}" />
            <label>分类名称<input class="form-input sound-library-category-name" maxlength="40" placeholder="例如：缓慢持续" required /></label>
            <label>什么时候使用<textarea class="form-input sound-library-category-hint" maxlength="180" rows="3" placeholder="例如：明确进入缓慢、连续的亲密动作后使用；接吻时不要使用" required></textarea></label>
            <label>混音方式<select class="form-input sound-library-category-mode">
              <option value="cue">单次声音</option>
              <option value="texture">持续纹理</option>
              <option value="background">背景循环</option>
            </select></label>
            <div class="sound-library-category-actions">
              <button type="button" class="btn btn-outline sound-library-category-reset">新建</button>
              <button type="submit" class="btn btn-primary">保存分类</button>
            </div>
          </form>
        </div>
      </div>
    `;

    const picker = container.querySelector('.sound-library-file');
    const sheet = container.querySelector('.sound-library-import-sheet');
    const categorySheet = container.querySelector('.sound-library-category-sheet');
    const filters = container.querySelector('.sound-library-filters');
    if (filters) filters.scrollLeft = filterScrollLeft;
    let selectedFiles = [];

    container.querySelector('.sound-library-back')?.addEventListener('click', () => {
      stopPreview();
      back();
    });
    const openCategorySheet = (id = '') => {
      const definition = categoryCatalog.find((item) => item.id === id && !item.builtIn) || null;
      editingCategoryId = definition?.id || '';
      const idInput = container.querySelector('.sound-library-category-id');
      const nameInput = container.querySelector('.sound-library-category-name');
      const hintInput = container.querySelector('.sound-library-category-hint');
      const modeSelect = container.querySelector('.sound-library-category-mode');
      if (idInput) idInput.value = editingCategoryId;
      if (nameInput) nameInput.value = definition?.label || '';
      if (hintInput) hintInput.value = definition?.hint || '';
      if (modeSelect) {
        modeSelect.value = definition?.mode || 'cue';
        modeSelect.disabled = !!definition;
      }
      if (categorySheet) categorySheet.hidden = false;
      nameInput?.focus?.();
    };
    container.querySelector('.sound-library-categories')?.addEventListener('click', () => openCategorySheet());
    container.querySelector('.sound-library-category-close')?.addEventListener('click', () => {
      if (categorySheet) categorySheet.hidden = true;
      editingCategoryId = '';
    });
    container.querySelector('.sound-library-category-reset')?.addEventListener('click', () => openCategorySheet());
    container.querySelectorAll('.sound-library-custom-edit').forEach((button) => {
      button.addEventListener('click', () => {
        openCategorySheet(button.closest('[data-category-id]')?.dataset.categoryId || '');
      });
    });
    container.querySelectorAll('.sound-library-custom-delete').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.closest('[data-category-id]')?.dataset.categoryId || '';
        const definition = categoryCatalog.find((item) => item.id === id);
        if (!definition) return;
        const assigned = assets.filter((item) => item.category === id);
        const message = assigned.length
          ? `删除「${definition.label}」并把其中 ${assigned.length} 条音频移到“其他”？`
          : `删除「${definition.label}」？`;
        if (!window.confirm(message)) return;
        for (const item of assigned) await updateSoundAssetMetadata(item.id, { category: 'other' });
        await deleteSoundAssetCustomCategory(id);
        assets = await listSoundAssetSummaries();
        categoryCatalog = await listSoundAssetCategoryCatalog();
        if (category === id) category = 'all';
        editingCategoryId = '';
        draw();
        container.querySelector('.sound-library-categories')?.click();
      });
    });
    container.querySelector('.sound-library-category-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = container.querySelector('.sound-library-category-id')?.value || '';
      const label = container.querySelector('.sound-library-category-name')?.value || '';
      const hint = container.querySelector('.sound-library-category-hint')?.value || '';
      const mode = container.querySelector('.sound-library-category-mode')?.value || 'cue';
      try {
        await saveSoundAssetCustomCategory({ id, label, hint, mode });
        categoryCatalog = await listSoundAssetCategoryCatalog();
        editingCategoryId = '';
        showToast(id ? '分类已更新' : '分类已创建');
        draw();
        container.querySelector('.sound-library-categories')?.click();
      } catch (error) {
        showToast(error?.message || '分类保存失败');
      }
    });
    container.querySelector('.sound-library-add')?.addEventListener('click', () => picker?.click());
    container.querySelector('.sound-library-manage')?.addEventListener('click', () => {
      manageMode = !manageMode;
      selectedIds.clear();
      stopPreview();
      draw();
    });
    container.querySelector('.sound-library-select-all')?.addEventListener('click', () => {
      const allSelected = visible.length > 0 && visible.every((item) => selectedIds.has(item.id));
      visible.forEach((item) => {
        if (allSelected) selectedIds.delete(item.id);
        else selectedIds.add(item.id);
      });
      draw();
    });
    container.querySelector('.sound-library-move-category')?.addEventListener('change', async (event) => {
      const nextCategory = event.currentTarget.value || '';
      const ids = [...selectedIds].filter((id) => assets.some((item) => item.id === id));
      if (!nextCategory || !ids.length) return;
      for (const id of ids) {
        const item = assets.find((entry) => entry.id === id);
        if (item) await updateSoundAssetMetadata(item.id, { category: nextCategory });
      }
      assets = await listSoundAssetSummaries();
      selectedIds.clear();
      showToast(`已移动 ${ids.length} 条音频`);
      draw();
    });
    container.querySelector('.sound-library-delete-selected')?.addEventListener('click', async () => {
      const ids = [...selectedIds].filter((id) => assets.some((item) => item.id === id));
      if (!ids.length || !window.confirm(`删除选中的 ${ids.length} 条音频？`)) return;
      stopPreview();
      for (const id of ids) await deleteSoundAsset(id);
      assets = await listSoundAssetSummaries();
      selectedIds.clear();
      showToast(`已删除 ${ids.length} 条音频`);
      draw();
    });
    container.querySelectorAll('.sound-asset-select input').forEach((input) => {
      input.addEventListener('change', () => {
        const id = input.closest('[data-sound-id]')?.dataset.soundId || '';
        if (!id) return;
        if (input.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        draw();
      });
    });
    container.querySelector('.sound-library-clear-invalid')?.addEventListener('click', async () => {
      if (scanningInvalid || !assets.length) return;
      scanningInvalid = true;
      stopPreview();
      const button = container.querySelector('.sound-library-clear-invalid');
      if (button) {
        button.disabled = true;
        button.textContent = `检查 0/${assets.length}`;
      }
      const invalidIds = [];
      let uncertainCount = 0;
      let checked = 0;
      try {
        for (let offset = 0; offset < assets.length; offset += 3) {
          const batch = assets.slice(offset, offset + 3);
          const results = await Promise.all(batch.map(async (item) => {
            const storedItem = await getSoundAsset(item.id);
            const blob = createSoundAssetPlaybackBlob(storedItem);
            if (!(blob instanceof Blob) || blob.size <= 0) return 'invalid';
            const inspection = await inspectAudioFile(blob, item.sourceName || item.name);
            if (inspection.playable) return 'playable';
            return inspection.reason === 'empty' || inspection.reason === 'decode'
              ? 'invalid'
              : 'uncertain';
          }));
          results.forEach((result, index) => {
            if (result === 'invalid') invalidIds.push(batch[index].id);
            else if (result === 'uncertain') uncertainCount += 1;
          });
          checked += batch.length;
          if (button) button.textContent = `检查 ${checked}/${assets.length}`;
        }
        if (!invalidIds.length) {
          showToast(uncertainCount
            ? `没有发现确定失效的音频；另有 ${uncertainCount} 条暂时无法完成检测`
            : '没有发现失效音频', 4200);
          return;
        }
        const suffix = uncertainCount ? `；另有 ${uncertainCount} 条未删除` : '';
        if (!window.confirm(`发现 ${invalidIds.length} 条缺少文件或已损坏的音频，确认删除？${suffix}`)) return;
        for (const id of invalidIds) await deleteSoundAsset(id);
        assets = await listSoundAssetSummaries();
        invalidIds.forEach((id) => selectedIds.delete(id));
        showToast(`已清理 ${invalidIds.length} 条失效音频`);
      } catch (error) {
        showToast(`检查失败：${error?.message || error}`);
      } finally {
        scanningInvalid = false;
        draw();
      }
    });
    picker?.addEventListener('change', async () => {
      const pickedFiles = [...(picker.files || [])];
      const zipFiles = pickedFiles.filter((file) => /\.zip$/i.test(String(file.name || '')));
      if (zipFiles.length) {
        if (pickedFiles.length !== 1 || zipFiles.length !== 1) {
          showToast('ZIP 音频包请单独选择');
          if (picker) picker.value = '';
          return;
        }
        await requestPersistentSoundLibraryStorage();
        const addButton = container.querySelector('.sound-library-add');
        if (addButton) {
          addButton.disabled = true;
          addButton.textContent = '读取中';
        }
        const savedIds = [];
        try {
          const pack = await readSoundAssetPackZip(zipFiles[0]);
          for (const definition of pack.categories || []) {
            await saveSoundAssetCustomCategory(definition);
          }
          if (pack.categories?.length) {
            categoryCatalog = await listSoundAssetCategoryCatalog();
          }
          const existingKeys = new Set(assets.map((item) => (
            `${item.category}|${item.sourceName}|${Number(item.size || 0)}`
          )));
          let imported = 0;
          let skipped = 0;
          let unsupported = 0;
          for (let index = 0; index < pack.assets.length; index += 1) {
            const entry = pack.assets[index];
            const duplicateKey = `${entry.category}|${entry.name}|${entry.blob.size}`;
            if (existingKeys.has(duplicateKey)) {
              skipped += 1;
              continue;
            }
            if (addButton) addButton.textContent = `${index + 1}/${pack.assets.length}`;
            const inspection = await inspectAudioFile(entry.blob, entry.name);
            if (!inspection.playable || !(inspection.blob instanceof Blob)) {
              unsupported += 1;
              continue;
            }
            const saved = await saveSoundAsset({
              ownerId: SOUND_ASSET_LIBRARY_OWNER_ID,
              name: fileBaseName(entry),
              category: entry.category,
              audioBlob: inspection.blob,
              audioType: inspection.blob.type,
              durationMs: inspection.durationMs,
              size: inspection.blob.size,
              sourceName: entry.name,
            });
            savedIds.push(saved.id);
            existingKeys.add(duplicateKey);
            imported += 1;
          }
          assets = await listSoundAssetSummaries();
          playbackTrace = await listRecentSoundAssetPlaybackTrace();
          stopPreview();
          if (imported) {
            const notes = [
              skipped ? `${skipped} 条重复` : '',
              unsupported ? `${unsupported} 条当前设备不支持` : '',
            ].filter(Boolean);
            showToast(notes.length
              ? `已导入 ${imported} 条，跳过${notes.join('、')}`
              : `已导入音频包，共 ${imported} 条`);
          } else if (unsupported) {
            showToast('音频包里没有当前设备可播放的音频；iPhone 建议使用 MP3、M4A 或 WAV', 5200);
          } else {
            showToast('这个音频包已经导入过了');
          }
          draw();
        } catch (error) {
          for (const id of savedIds) {
            await deleteSoundAsset(id).catch(() => {});
          }
          showToast(`音频包导入失败：${error?.message || error}`, 4200);
          if (addButton) {
            addButton.disabled = false;
            addButton.textContent = '导入';
          }
          if (picker) picker.value = '';
        }
        return;
      }
      selectedFiles = pickedFiles.filter((file) => (
        String(file.type || '').startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(file.name || '')
      ));
      if (!selectedFiles.length) {
        showToast('没有选中可用音频');
        return;
      }
      const allPrefixed = selectedFiles.every((file) => !!prefixedCategoryForFile(file));
      const categorySelect = container.querySelector('.sound-library-import-category');
      if (allPrefixed && categorySelect) categorySelect.value = '__auto__';
      if (sheet) sheet.hidden = false;
    });
    container.querySelector('.sound-library-import-cancel')?.addEventListener('click', () => {
      selectedFiles = [];
      if (picker) picker.value = '';
      if (sheet) sheet.hidden = true;
    });
    container.querySelector('.sound-library-import-confirm')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const selectedCategory = container.querySelector('.sound-library-import-category')?.value || 'other';
      button.disabled = true;
      try {
        await requestPersistentSoundLibraryStorage();
        let imported = 0;
        let unsupported = 0;
        for (const file of selectedFiles) {
          const inspection = await inspectAudioFile(file, file.name);
          if (!inspection.playable || !(inspection.blob instanceof Blob)) {
            unsupported += 1;
            continue;
          }
          const fileCategory = selectedCategory === '__auto__'
            ? prefixedCategoryForFile(file)
            : selectedCategory;
          await saveSoundAsset({
            ownerId: SOUND_ASSET_LIBRARY_OWNER_ID,
            name: fileBaseName(file),
            category: fileCategory || 'other',
            audioBlob: inspection.blob,
            audioType: inspection.blob.type,
            durationMs: inspection.durationMs,
            size: inspection.blob.size,
            sourceName: file.name,
          });
          imported += 1;
        }
        if (imported) {
          showToast(unsupported
            ? `已导入 ${imported} 条，跳过 ${unsupported} 条当前设备不支持的音频`
            : `已导入 ${imported} 条音频`);
        } else {
          showToast('所选音频当前设备无法解码；iPhone 建议使用 MP3、M4A 或 WAV', 5200);
        }
        assets = await listSoundAssetSummaries();
        playbackTrace = await listRecentSoundAssetPlaybackTrace();
        stopPreview();
        draw();
      } catch (error) {
        showToast(`导入失败：${error?.message || error}`);
        button.disabled = false;
      }
    });
    container.querySelectorAll('[data-category]').forEach((button) => {
      button.addEventListener('click', () => {
        category = button.dataset.category || 'all';
        stopPreview();
        draw();
      });
    });
    container.querySelectorAll('.sound-asset-play').forEach((button) => {
      button.addEventListener('click', async (event) => {
        const row = button.closest('[data-sound-id]');
        const item = assets.find((entry) => entry.id === row?.dataset.soundId);
        if (!item) return;
        if (previewAudio && button.classList.contains('is-playing')) {
          stopPreview();
          button.classList.remove('is-playing');
          button.innerHTML = icon('play');
          return;
        }
        stopPreview();
        const gesture = captureMediaGesture(event);
        const storedItem = await getSoundAsset(item.id);
        const playback = createSoundAssetPlayback(storedItem);
        if (!playback.url) {
          gesture?.dispose?.();
          showToast('这条音频缺少文件');
          return;
        }
        const audio = audioFromGestureOrNew(playback.url, gesture);
        if (!audio) {
          gesture?.dispose?.();
          playback.revoke?.();
          showToast('当前设备无法播放这条音频');
          return;
        }
        previewAudio = audio;
        previewCleanup = playback.revoke;
        button.classList.add('is-playing');
        button.innerHTML = icon('pause');
        let failureReported = false;
        const reportFailure = (error = null, mediaCode = 0) => {
          if (failureReported) return;
          failureReported = true;
          if (error?.name === 'NotAllowedError') {
            showToast('播放被 iOS 拦截，请再点一次试听');
          } else if (error?.name === 'NotSupportedError' || Number(mediaCode) === 4) {
            showToast('当前设备不支持这条音频的编码；iPhone 建议使用 MP3、M4A 或 WAV', 5200);
          } else {
            showToast('当前设备无法播放这条音频');
          }
        };
        const reset = () => {
          button.classList.remove('is-playing');
          button.innerHTML = icon('play');
          if (previewAudio === audio) stopPreview();
        };
        audio.addEventListener('ended', reset, { once: true });
        audio.addEventListener('error', () => {
          const mediaCode = Number(audio.error?.code || 0);
          reset();
          reportFailure(null, mediaCode);
        }, { once: true });
        audio.play().catch((error) => {
          reset();
          reportFailure(error);
        });
      });
    });
    container.querySelectorAll('.sound-asset-name').forEach((input) => {
      input.addEventListener('change', async () => {
        const item = assets.find((entry) => entry.id === input.closest('[data-sound-id]')?.dataset.soundId);
        if (!item) return;
        await updateSoundAssetMetadata(item.id, { name: input.value });
        assets = await listSoundAssetSummaries();
      });
    });
    container.querySelectorAll('.sound-asset-category').forEach((select) => {
      select.addEventListener('change', async () => {
        const item = assets.find((entry) => entry.id === select.closest('[data-sound-id]')?.dataset.soundId);
        if (!item) return;
        await updateSoundAssetMetadata(item.id, { category: select.value });
        assets = await listSoundAssetSummaries();
        draw();
      });
    });
    container.querySelectorAll('.sound-asset-enabled input').forEach((input) => {
      input.addEventListener('change', async () => {
        const row = input.closest('[data-sound-id]');
        const item = assets.find((entry) => entry.id === row?.dataset.soundId);
        if (!item) return;
        input.disabled = true;
        try {
          const saved = await updateSoundAssetMetadata(item.id, { enabled: input.checked });
          const index = assets.findIndex((entry) => entry.id === saved.id);
          if (index >= 0) assets[index] = saved;
          row?.classList.toggle('is-disabled', saved.enabled === false);
        } catch (error) {
          input.checked = item.enabled !== false;
          showToast(error?.message || '音频启用状态保存失败');
        } finally {
          input.disabled = false;
        }
      });
    });
    container.querySelectorAll('.sound-asset-texture-playback').forEach((select) => {
      select.addEventListener('change', async () => {
        const item = assets.find((entry) => entry.id === select.closest('[data-sound-id]')?.dataset.soundId);
        if (!item) return;
        const saved = await updateSoundAssetMetadata(item.id, { texturePlayback: select.value });
        const index = assets.findIndex((entry) => entry.id === saved.id);
        if (index >= 0) assets[index] = saved;
      });
    });
    container.querySelectorAll('.sound-asset-mix-gain').forEach((select) => {
      select.addEventListener('change', async () => {
        const item = assets.find((entry) => entry.id === select.closest('[data-sound-id]')?.dataset.soundId);
        if (!item) return;
        const saved = await updateSoundAssetMetadata(item.id, { mixGain: Number(select.value) });
        const index = assets.findIndex((entry) => entry.id === saved.id);
        if (index >= 0) assets[index] = saved;
      });
    });
    container.querySelectorAll('.sound-asset-delete').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.closest('[data-sound-id]')?.dataset.soundId || '';
        const item = assets.find((entry) => entry.id === id);
        if (!item || !window.confirm(`删除「${item.name}」？`)) return;
        stopPreview();
        await deleteSoundAsset(id);
        assets = await listSoundAssetSummaries();
        draw();
      });
    });
  };

  draw();
}
