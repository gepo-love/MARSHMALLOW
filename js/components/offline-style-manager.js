import { icon } from './svg-icons.js';
import { showToast } from './toast.js';
import {
  OFFLINE_STYLE_DEFAULTS,
  normalizeOfflineStylePrefs,
} from '../core/offline-appearance.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 底图上传：压缩到 1600px 内并保存为 JPEG data URL。 */
function readBackgroundImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('图片格式不支持'));
      image.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      };
      image.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 线下叙事共用的页内美化管理。调用方负责实时应用和持久化，关闭时会恢复原偏好。
 */
export async function openOfflineStyleManager({
  container,
  prefs,
  defaults = OFFLINE_STYLE_DEFAULTS,
  onPreview,
  onSave,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host || !container) return;
  const original = normalizeOfflineStylePrefs(prefs);
  const draft = { ...original };
  const preview = () => onPreview?.(normalizeOfflineStylePrefs(draft));

  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-style-overlay>
      <div class="modal-sheet scrapbook-card text-editor-sheet os-style-sheet" role="dialog" aria-modal="true" aria-label="美化管理">
        <header class="modal-header">
          <h3>美化管理</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-style-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="modal-body os-style-body">
          <div class="os-style-row">
            <span class="os-style-label">底色</span>
            <div class="os-style-seg" role="radiogroup" aria-label="底色">
              ${[['white', '纯白'], ['paper', '暖纸'], ['dusk', '暮色']].map(([value, label]) => `
                <button type="button" class="os-style-seg-btn ${draft.bg === value ? 'is-on' : ''}" data-style-bg="${value}">${label}</button>`).join('')}
            </div>
          </div>
          <div class="os-style-row">
            <span class="os-style-label">底图</span>
            <div class="os-style-seg">
              <button type="button" class="os-style-seg-btn" data-style-bg-upload>${draft.bgImage ? '换一张底图' : '上传底图'}</button>
              <button type="button" class="os-style-seg-btn" data-style-bg-clear ${draft.bgImage ? '' : 'hidden'}>移除底图</button>
            </div>
            <input type="file" accept="image/*" data-style-bg-file hidden />
          </div>
          <label class="os-style-row" data-style-veil-row ${draft.bgImage ? '' : 'hidden'}>
            <span class="os-style-label">蒙版浓度 <em class="os-style-val" data-style-veil-val>${Math.round(draft.veil * 100)}%</em></span>
            <input type="range" class="os-style-range" data-style-veil min="0.4" max="0.96" step="0.02" value="${draft.veil}" />
          </label>
          <div class="os-style-row">
            <span class="os-style-label">正文字体</span>
            <div class="os-style-seg" role="radiogroup" aria-label="正文字体">
              ${[['serif', '衬线'], ['sans', '黑体']].map(([value, label]) => `
                <button type="button" class="os-style-seg-btn ${draft.font === value ? 'is-on' : ''}" data-style-font="${value}">${label}</button>`).join('')}
            </div>
          </div>
          <label class="os-style-row">
            <span class="os-style-label">正文颜色</span>
            <div class="os-style-color-row">
              <input type="color" data-style-text-color value="${esc(draft.textColor || (draft.bg === 'dusk' ? '#e8e4dc' : '#3f3832'))}" aria-label="选择正文颜色" />
              <input type="text" class="form-input" data-style-text-color-input value="${esc(draft.textColor)}" placeholder="跟随底色" />
              <button type="button" class="btn btn-soft btn-sm" data-style-text-color-clear>恢复默认</button>
            </div>
          </label>
          <label class="os-style-row">
            <span class="os-style-label">字号 <em class="os-style-val" data-style-size-val>${draft.size}px</em></span>
            <input type="range" class="os-style-range" data-style-size min="14" max="20" step="1" value="${draft.size}" />
          </label>
          <label class="os-style-row">
            <span class="os-style-label">行距 <em class="os-style-val" data-style-leading-val>${draft.leading.toFixed(2)}</em></span>
            <input type="range" class="os-style-range" data-style-leading min="1.5" max="2.3" step="0.05" value="${draft.leading}" />
          </label>
          <div class="os-style-row">
            <span class="os-style-label">正文宽度</span>
            <div class="os-style-seg" role="radiogroup" aria-label="正文宽度">
              ${[['cozy', '舒适'], ['wide', '铺满']].map(([value, label]) => `
                <button type="button" class="os-style-seg-btn ${draft.measure === value ? 'is-on' : ''}" data-style-measure="${value}">${label}</button>`).join('')}
            </div>
          </div>
          <label class="os-style-row os-style-row--check">
            <input type="checkbox" data-style-anchor ${draft.anchor ? 'checked' : ''} />
            <span>显示时空锚与装饰</span>
          </label>
          <label class="os-style-row os-style-row--check">
            <input type="checkbox" data-style-timeline-nav ${draft.timelineNav ? 'checked' : ''} />
            <span>显示右侧楼层导航</span>
          </label>
          <label class="os-style-row os-style-row--check">
            <input type="checkbox" data-style-reasoning ${draft.showReasoning ? 'checked' : ''} />
            <span>显示思维链</span>
          </label>
          <label class="os-style-row">
            <span class="os-style-label">自定义 CSS</span>
            <textarea class="form-input os-style-css" data-style-css rows="4" spellcheck="false" placeholder=".offline-beat--narration { ... }">${esc(draft.css)}</textarea>
          </label>
          <div class="os-style-foot">
            <button type="button" class="btn btn-outline" data-style-reset>恢复默认</button>
            <button type="button" class="btn btn-primary" data-style-save>保存</button>
          </div>
        </div>
      </div>
    </div>`;

  const close = ({ restore = true } = {}) => {
    if (restore) onPreview?.(original);
    host.classList.remove('active');
    host.innerHTML = '';
  };
  const syncSegment = (name, value) => {
    host.querySelectorAll(`button[data-style-${name}]`).forEach((button) => {
      button.classList.toggle('is-on', button.getAttribute(`data-style-${name}`) === value);
    });
  };
  const syncBackgroundControls = () => {
    const upload = host.querySelector('[data-style-bg-upload]');
    if (upload) upload.textContent = draft.bgImage ? '换一张底图' : '上传底图';
    const clear = host.querySelector('[data-style-bg-clear]');
    if (clear) clear.hidden = !draft.bgImage;
    const veil = host.querySelector('[data-style-veil-row]');
    if (veil) veil.hidden = !draft.bgImage;
  };
  const syncControls = () => {
    syncSegment('bg', draft.bg);
    syncSegment('font', draft.font);
    syncSegment('measure', draft.measure);
    const values = {
      '[data-style-size]': draft.size,
      '[data-style-leading]': draft.leading,
      '[data-style-veil]': draft.veil,
      '[data-style-css]': draft.css,
      '[data-style-text-color-input]': draft.textColor,
    };
    Object.entries(values).forEach(([selector, value]) => {
      const input = host.querySelector(selector);
      if (input) input.value = String(value ?? '');
    });
    const sizeValue = host.querySelector('[data-style-size-val]');
    if (sizeValue) sizeValue.textContent = `${draft.size}px`;
    const leadingValue = host.querySelector('[data-style-leading-val]');
    if (leadingValue) leadingValue.textContent = Number(draft.leading).toFixed(2);
    const veilValue = host.querySelector('[data-style-veil-val]');
    if (veilValue) veilValue.textContent = `${Math.round(draft.veil * 100)}%`;
    const color = host.querySelector('[data-style-text-color]');
    if (color) color.value = draft.textColor || (draft.bg === 'dusk' ? '#e8e4dc' : '#3f3832');
    for (const [selector, value] of [
      ['[data-style-anchor]', draft.anchor],
      ['[data-style-timeline-nav]', draft.timelineNav],
      ['[data-style-reasoning]', draft.showReasoning],
    ]) {
      const input = host.querySelector(selector);
      if (input) input.checked = !!value;
    }
    syncBackgroundControls();
    preview();
  };

  host.querySelector('[data-style-overlay]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) close();
  });
  host.querySelector('[data-style-close]')?.addEventListener('click', () => close());
  for (const name of ['bg', 'font', 'measure']) {
    host.querySelectorAll(`button[data-style-${name}]`).forEach((button) => button.addEventListener('click', () => {
      draft[name] = button.getAttribute(`data-style-${name}`);
      syncSegment(name, draft[name]);
      preview();
    }));
  }
  host.querySelector('[data-style-size]')?.addEventListener('input', (event) => {
    draft.size = Number(event.target.value) || defaults.size;
    host.querySelector('[data-style-size-val]').textContent = `${draft.size}px`;
    preview();
  });
  host.querySelector('[data-style-leading]')?.addEventListener('input', (event) => {
    draft.leading = Number(event.target.value) || defaults.leading;
    host.querySelector('[data-style-leading-val]').textContent = draft.leading.toFixed(2);
    preview();
  });
  for (const [selector, key] of [
    ['[data-style-anchor]', 'anchor'],
    ['[data-style-reasoning]', 'showReasoning'],
  ]) {
    host.querySelector(selector)?.addEventListener('change', (event) => {
      draft[key] = !!event.target.checked;
      preview();
    });
  }
  host.querySelector('[data-style-timeline-nav]')?.addEventListener('change', (event) => {
    draft.timelineNav = !!event.target.checked;
    draft.timelineNavConfigured = true;
    preview();
  });

  const backgroundFile = host.querySelector('[data-style-bg-file]');
  host.querySelector('[data-style-bg-upload]')?.addEventListener('click', () => backgroundFile?.click());
  backgroundFile?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      draft.bgImage = await readBackgroundImage(file);
      syncBackgroundControls();
      preview();
    } catch (error) {
      showToast(error?.message || '读取图片失败');
    }
  });
  host.querySelector('[data-style-bg-clear]')?.addEventListener('click', () => {
    draft.bgImage = '';
    syncBackgroundControls();
    preview();
  });
  host.querySelector('[data-style-veil]')?.addEventListener('input', (event) => {
    draft.veil = Number(event.target.value) || defaults.veil;
    host.querySelector('[data-style-veil-val]').textContent = `${Math.round(draft.veil * 100)}%`;
    preview();
  });

  const color = host.querySelector('[data-style-text-color]');
  const colorText = host.querySelector('[data-style-text-color-input]');
  color?.addEventListener('input', () => {
    draft.textColor = color.value;
    if (colorText) colorText.value = draft.textColor;
    preview();
  });
  colorText?.addEventListener('change', () => {
    const value = String(colorText.value || '').trim();
    if (value && !/^#[0-9a-f]{6}$/i.test(value)) {
      showToast('请填 #RRGGBB 或留空');
      colorText.value = draft.textColor;
      return;
    }
    draft.textColor = value;
    if (value && color) color.value = value;
    preview();
  });
  host.querySelector('[data-style-text-color-clear]')?.addEventListener('click', () => {
    draft.textColor = '';
    syncControls();
  });
  host.querySelector('[data-style-css]')?.addEventListener('input', (event) => {
    draft.css = String(event.target.value || '');
    preview();
  });
  host.querySelector('[data-style-reset]')?.addEventListener('click', () => {
    Object.assign(draft, defaults);
    syncControls();
  });
  host.querySelector('[data-style-save]')?.addEventListener('click', async () => {
    const button = host.querySelector('[data-style-save]');
    if (button) button.disabled = true;
    try {
      await onSave?.(normalizeOfflineStylePrefs(draft));
      close({ restore: false });
      showToast('已保存美化偏好');
    } catch (error) {
      showToast(`保存失败：${error?.message || error}`);
      if (button) button.disabled = false;
    }
  });
}
