import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { fileToCroppedCompressedDataUrl, IMAGE_CROP_PRESETS } from '../components/image-crop-modal.js';
import {
  hasAppLockPin,
  isValidPin,
  loadAppLockSettings,
  saveAppLockSettings,
  setAppLockPin,
} from '../core/app-lock-store.js';

function escapeAttribute(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export default async function render(container) {
  let settings = loadAppLockSettings();
  container.className = 'page settings-lock-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn settings-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">应用锁屏</h1>
      <span class="navbar-btn" aria-hidden="true"></span>
    </header>
    <main class="settings-lock-scroll">
      <section class="settings-lock-section">
        <label class="settings-lock-toggle-row">
          <span><strong>开启锁屏</strong><small>启动时输入四位密码</small></span>
          <input type="checkbox" data-lock-enabled ${settings.enabled ? 'checked' : ''}>
        </label>
      </section>

      <section class="settings-lock-section">
        <h2>四位密码</h2>
        <div class="settings-lock-pin-grid">
          <label><span>新密码</span><input type="password" inputmode="numeric" autocomplete="new-password" maxlength="4" pattern="[0-9]{4}" data-lock-pin></label>
          <label><span>确认密码</span><input type="password" inputmode="numeric" autocomplete="new-password" maxlength="4" pattern="[0-9]{4}" data-lock-pin-confirm></label>
        </div>
        <button type="button" class="settings-lock-primary" data-lock-save-pin>${hasAppLockPin(settings) ? '更换密码' : '设置密码'}</button>
      </section>

      <section class="settings-lock-section">
        <h2>锁屏壁纸</h2>
        <div class="settings-lock-wallpaper${settings.wallpaper ? ' has-image' : ''}" data-lock-wallpaper ${settings.wallpaper ? `style="background-image:url(&quot;${escapeAttribute(settings.wallpaper)}&quot;)"` : ''}></div>
        <input type="file" accept="image/*" hidden data-lock-wallpaper-input>
        <div class="settings-lock-actions">
          <button type="button" data-lock-wallpaper-pick>选择壁纸</button>
          <button type="button" data-lock-wallpaper-remove ${settings.wallpaper ? '' : 'hidden'}>移除</button>
        </div>
      </section>

      <button type="button" class="settings-lock-preview" data-lock-preview ${hasAppLockPin(settings) ? '' : 'disabled'}>立即锁定</button>
    </main>`;

  container.querySelector('.settings-back')?.addEventListener('click', () => back());
  const enabled = container.querySelector('[data-lock-enabled]');
  enabled?.addEventListener('change', () => {
    settings = loadAppLockSettings();
    if (enabled.checked && !hasAppLockPin(settings)) {
      enabled.checked = false;
      showToast('请先设置四位密码');
      container.querySelector('[data-lock-pin]')?.focus();
      return;
    }
    settings = saveAppLockSettings({ enabled: enabled.checked });
    showToast(enabled.checked ? '已开启应用锁屏' : '已关闭应用锁屏');
  });

  const savePin = container.querySelector('[data-lock-save-pin]');
  savePin?.addEventListener('click', async () => {
    const pin = container.querySelector('[data-lock-pin]')?.value || '';
    const confirmPin = container.querySelector('[data-lock-pin-confirm]')?.value || '';
    if (!isValidPin(pin)) return showToast('请输入四位数字密码');
    if (pin !== confirmPin) return showToast('两次输入的密码不一致');
    await setAppLockPin(pin);
    settings = loadAppLockSettings();
    container.querySelector('[data-lock-pin]').value = '';
    container.querySelector('[data-lock-pin-confirm]').value = '';
    savePin.textContent = '更换密码';
    container.querySelector('[data-lock-preview]').disabled = false;
    showToast('密码已保存；需要时请手动开启锁屏');
  });

  const input = container.querySelector('[data-lock-wallpaper-input]');
  container.querySelector('[data-lock-wallpaper-pick]')?.addEventListener('click', () => input?.click());
  input?.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const wallpaper = await fileToCroppedCompressedDataUrl(file, {
        ...IMAGE_CROP_PRESETS.wallpaper,
        title: '裁剪锁屏壁纸',
      });
      if (!wallpaper) return;
      settings = saveAppLockSettings({ wallpaper });
      const preview = container.querySelector('[data-lock-wallpaper]');
      preview.style.backgroundImage = `url("${wallpaper.replace(/"/g, '%22')}")`;
      preview.classList.add('has-image');
      container.querySelector('[data-lock-wallpaper-remove]').hidden = false;
    } catch (error) {
      showToast(error?.message || '壁纸读取失败');
    }
  });
  container.querySelector('[data-lock-wallpaper-remove]')?.addEventListener('click', (event) => {
    settings = saveAppLockSettings({ wallpaper: '' });
    const preview = container.querySelector('[data-lock-wallpaper]');
    preview.style.backgroundImage = '';
    preview.classList.remove('has-image');
    event.currentTarget.hidden = true;
  });
  container.querySelector('[data-lock-preview]')?.addEventListener('click', () => {
    globalThis.dispatchEvent(new CustomEvent('marshmallow-app-lock-now'));
  });
}
