import { icon } from './svg-icons.js';
import { listScenePresets } from '../core/image-style-presets.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const DEFAULT_MOMENTS_IMAGE_OPTIONS = {
  allowLifePhoto: true,
  allowPersonPhoto: false,
  allowTextImage: true,
  allowStickers: true,
  imageStyleId: '',
};

function normalizeCachedImageOptions(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    allowLifePhoto: source.allowLifePhoto !== false,
    allowPersonPhoto: source.allowPersonPhoto === true,
    allowTextImage: source.allowTextImage !== false,
    allowStickers: source.allowStickers !== false,
    imageStyleId: typeof source.imageStyleId === 'string' ? source.imageStyleId : '',
  };
}

export function loadCachedMomentsImageOptions(cacheKey = '') {
  const key = String(cacheKey || '').trim();
  if (!key) return { ...DEFAULT_MOMENTS_IMAGE_OPTIONS };
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw
      ? normalizeCachedImageOptions(JSON.parse(raw))
      : { ...DEFAULT_MOMENTS_IMAGE_OPTIONS };
  } catch (_) {
    return { ...DEFAULT_MOMENTS_IMAGE_OPTIONS };
  }
}

export function saveCachedMomentsImageOptions(cacheKey = '', value = {}) {
  const key = String(cacheKey || '').trim();
  const normalized = normalizeCachedImageOptions(value);
  if (!key) return normalized;
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(normalized));
  } catch (_) {
    // 隐私模式或存储配额不足时，仍允许本轮正常生成。
  }
  return normalized;
}

/**
 * 朋友圈 / 手机相册 AI 生成前选项（多选并列）。
 * @param {{ genEnabled?: boolean, title?: string, mode?: 'moments'|'album', cacheKey?: string }} [opts]
 * @returns {Promise<{ allowLifePhoto: boolean, allowPersonPhoto: boolean, allowTextImage: boolean, allowStickers: boolean, imageStyleId: string }|null>}
 */
export function openMomentsGenImageModal({
  genEnabled = false,
  title = '生成选项',
  mode = 'moments',
  cacheKey = '',
} = {}) {
  const albumMode = mode === 'album';
  const cached = loadCachedMomentsImageOptions(cacheKey);
  const initial = albumMode
    ? { ...DEFAULT_MOMENTS_IMAGE_OPTIONS, allowPersonPhoto: true }
    : cached;
  const host = document.getElementById('modal-container');
  if (!host) {
    return Promise.resolve({
      ...initial,
      allowLifePhoto: genEnabled && initial.allowLifePhoto,
      allowPersonPhoto: genEnabled && initial.allowLifePhoto && initial.allowPersonPhoto,
      allowTextImage: albumMode ? false : initial.allowTextImage,
      allowStickers: albumMode ? false : initial.allowStickers,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(value);
    };

    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center" data-moments-gen-overlay>
        <div class="modal-sheet scrapbook-card moments-gen-sheet" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>${esc(title)}</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-moments-gen-cancel aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body moments-gen-body">
            ${albumMode ? `
            <div class="api-field">
              <span class="api-field-label">生图选项</span>
              <div class="moments-gen-check-list">
                <label class="chat-details-row chat-details-toggle moments-gen-check-item">
                  <span>可含人物</span>
                  <input type="checkbox" class="moments-gen-person" ${genEnabled && initial.allowPersonPhoto ? 'checked' : ''} ${genEnabled ? '' : 'disabled'} />
                </label>
              </div>
            </div>` : `
            <div class="api-field">
              <span class="api-field-label">配图（可多选，不必每条都有图）</span>
              <div class="moments-gen-check-list">
                <label class="chat-details-row chat-details-toggle moments-gen-check-item">
                  <span>生活照生图</span>
                  <input type="checkbox" class="moments-gen-life" ${genEnabled && initial.allowLifePhoto ? 'checked' : ''} ${genEnabled ? '' : 'disabled'} />
                </label>
                <label class="chat-details-row chat-details-toggle moments-gen-check-item">
                  <span>可含人物</span>
                  <input type="checkbox" class="moments-gen-person" ${genEnabled && initial.allowPersonPhoto ? 'checked' : ''} ${genEnabled ? '' : 'disabled'} />
                </label>
                <label class="chat-details-row chat-details-toggle moments-gen-check-item">
                  <span>可含文字图</span>
                  <input type="checkbox" class="moments-gen-textimg" ${initial.allowTextImage ? 'checked' : ''} />
                </label>
              </div>
            </div>`}
            <label class="api-field">
              <span class="api-field-label">画风滤镜</span>
              <select class="form-input moments-gen-style" ${genEnabled ? '' : 'disabled'}>
                <option value="">跟随全局默认</option>
                ${listScenePresets().map((p) => `<option value="${esc(p.id)}">${esc(p.label)}（${esc(p.hint)}）</option>`).join('')}
              </select>
            </label>
            ${albumMode ? '' : `
            <label class="chat-details-row chat-details-toggle moments-gen-sticker-toggle">
              <span>正文可带表情包</span>
              <input type="checkbox" class="moments-gen-stickers" ${initial.allowStickers ? 'checked' : ''} />
            </label>`}
          </div>
          <footer class="modal-footer">
            <button type="button" class="btn btn-outline" data-moments-gen-cancel>取消</button>
            <button type="button" class="btn btn-primary" data-moments-gen-ok>${albumMode ? '开始补图' : '开始生成'}</button>
          </footer>
        </div>
      </div>
    `;

    const styleSelect = host.querySelector('.moments-gen-style');
    if (styleSelect && [...styleSelect.options].some((option) => option.value === initial.imageStyleId)) {
      styleSelect.value = initial.imageStyleId;
    }

    host.querySelector('[data-moments-gen-overlay]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) finish(null);
    });
    host.querySelectorAll('[data-moments-gen-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => finish(null));
    });
    host.querySelector('[data-moments-gen-ok]')?.addEventListener('click', () => {
      const imageStyleId = host.querySelector('.moments-gen-style')?.value || '';
      if (albumMode) {
        finish({
          allowLifePhoto: !!genEnabled,
          allowPersonPhoto: genEnabled && !!host.querySelector('.moments-gen-person')?.checked,
          allowTextImage: false,
          allowStickers: false,
          imageStyleId,
        });
        return;
      }
      const allowStickers = !!host.querySelector('.moments-gen-stickers')?.checked;
      const allowTextImage = !!host.querySelector('.moments-gen-textimg')?.checked;
      const allowLifePhoto = genEnabled && !!host.querySelector('.moments-gen-life')?.checked;
      const personSelected = !!host.querySelector('.moments-gen-person')?.checked;
      const allowPersonPhoto = genEnabled && allowLifePhoto
        && personSelected;
      const selected = {
        allowLifePhoto,
        allowPersonPhoto,
        allowTextImage,
        allowStickers,
        imageStyleId,
      };
      saveCachedMomentsImageOptions(cacheKey, {
        ...selected,
        allowLifePhoto: genEnabled ? allowLifePhoto : cached.allowLifePhoto,
        allowPersonPhoto: genEnabled ? personSelected : cached.allowPersonPhoto,
      });
      finish(selected);
    });
  });
}

/** 手机相册补生图 / 重 roll 前的档位选项（画风滤镜 + 可含人物） */
export function openPhoneAlbumGenImageModal({ genEnabled = false, title = '相册生图选项' } = {}) {
  return openMomentsGenImageModal({ genEnabled, title, mode: 'album' });
}

/**
 * 仅选「是否带表情包」的轻量弹层（论坛 / 微博主页等无配图选项的生成入口）。
 * @returns {Promise<{ allowStickers: boolean }|null>}
 */
export function openAllowStickersModal({
  title = '生成选项',
  defaultOn = true,
  okLabel = '开始生成',
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) {
    return Promise.resolve({ allowStickers: defaultOn !== false });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(value);
    };

    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center" data-sticker-opt-overlay>
        <div class="modal-sheet scrapbook-card moments-gen-sheet" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>${esc(title)}</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-sticker-opt-cancel aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body moments-gen-body">
            <label class="chat-details-row chat-details-toggle moments-gen-sticker-toggle">
              <span>正文可带表情包</span>
              <input type="checkbox" class="moments-gen-stickers" ${defaultOn !== false ? 'checked' : ''} />
            </label>
          </div>
          <footer class="modal-footer">
            <button type="button" class="btn btn-outline" data-sticker-opt-cancel>取消</button>
            <button type="button" class="btn btn-primary" data-sticker-opt-ok>${esc(okLabel)}</button>
          </footer>
        </div>
      </div>
    `;

    host.querySelector('[data-sticker-opt-overlay]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) finish(null);
    });
    host.querySelectorAll('[data-sticker-opt-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => finish(null));
    });
    host.querySelector('[data-sticker-opt-ok]')?.addEventListener('click', () => {
      finish({
        allowStickers: !!host.querySelector('.moments-gen-stickers')?.checked,
      });
    });
  });
}
