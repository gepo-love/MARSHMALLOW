import { loadAppLockSettings, verifyAppLockPin } from '../core/app-lock-store.js';

let host = null;
let clockTimer = 0;
let enteredPin = '';
let previewMode = false;

function formatClock() {
  const now = new Date();
  const time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const date = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  host?.querySelector('[data-lock-time]')?.replaceChildren(time);
  host?.querySelector('[data-lock-date]')?.replaceChildren(date);
}

function renderDots() {
  host?.querySelectorAll('[data-lock-dot]').forEach((dot, index) => {
    dot.classList.toggle('is-filled', index < enteredPin.length);
  });
  host?.querySelector('.app-lock-dots')?.setAttribute('aria-label', `已输入 ${enteredPin.length} 位密码`);
}

function closeLock() {
  if (!host) return;
  host.classList.add('is-leaving');
  globalThis.setTimeout(() => {
    host?.remove();
    host = null;
    enteredPin = '';
    previewMode = false;
    globalThis.clearInterval(clockTimer);
    document.documentElement.classList.remove('app-lock-active');
  }, 260);
}

async function submitPin() {
  if (enteredPin.length !== 4 || !host) return;
  const ok = await verifyAppLockPin(enteredPin);
  if (ok) {
    closeLock();
    return;
  }
  enteredPin = '';
  renderDots();
  const panel = host.querySelector('[data-lock-auth]');
  const status = host.querySelector('[data-lock-status]');
  status.textContent = '密码错误';
  panel.classList.remove('is-error');
  void panel.offsetWidth;
  panel.classList.add('is-error');
}

function inputDigit(value) {
  if (enteredPin.length >= 4) return;
  enteredPin += value;
  host?.querySelector('[data-lock-status]')?.replaceChildren('输入密码');
  renderDots();
  if (enteredPin.length === 4) globalThis.setTimeout(submitPin, 90);
}

function keypadHtml() {
  const letters = ['', 'ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ'];
  return [1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit, index) => `
    <button type="button" class="app-lock-key" data-lock-digit="${digit}" aria-label="数字 ${digit}">
      <span>${digit}</span><small>${letters[index]}</small>
    </button>`).join('');
}

export function showAppLock({ preview = false } = {}) {
  const settings = loadAppLockSettings();
  if (!settings.pinHash || host) return false;
  previewMode = preview;
  enteredPin = '';
  host = document.createElement('section');
  host.className = 'app-lock-screen';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-label', '应用锁屏');
  if (settings.wallpaper) host.style.setProperty('--app-lock-wallpaper', `url("${settings.wallpaper.replace(/"/g, '%22')}")`);
  host.innerHTML = `
    <div class="app-lock-shade" aria-hidden="true"></div>
    <div class="app-lock-clock">
      <div class="app-lock-date" data-lock-date></div>
      <div class="app-lock-time" data-lock-time></div>
    </div>
    <div class="app-lock-auth" data-lock-auth>
      <div class="app-lock-status" data-lock-status>输入密码</div>
      <div class="app-lock-dots" aria-label="已输入 0 位密码">
        ${Array.from({ length: 4 }, () => '<span data-lock-dot></span>').join('')}
      </div>
      <div class="app-lock-keypad">
        ${keypadHtml()}
        <span></span>
        <button type="button" class="app-lock-key" data-lock-digit="0" aria-label="数字 0"><span>0</span></button>
        <button type="button" class="app-lock-action" data-lock-delete aria-label="删除一位">删除</button>
      </div>
      ${previewMode ? '<button type="button" class="app-lock-cancel" data-lock-cancel>取消预览</button>' : ''}
    </div>`;
  document.body.appendChild(host);
  document.documentElement.classList.add('app-lock-active');
  host.querySelectorAll('[data-lock-digit]').forEach((button) => button.addEventListener('click', () => inputDigit(button.dataset.lockDigit)));
  host.querySelector('[data-lock-delete]')?.addEventListener('click', () => {
    enteredPin = enteredPin.slice(0, -1);
    renderDots();
  });
  host.querySelector('[data-lock-cancel]')?.addEventListener('click', closeLock);
  host.addEventListener('keydown', (event) => {
    if (/^\d$/.test(event.key)) inputDigit(event.key);
    if (event.key === 'Backspace') {
      enteredPin = enteredPin.slice(0, -1);
      renderDots();
    }
    if (previewMode && event.key === 'Escape') closeLock();
  });
  host.tabIndex = -1;
  host.focus({ preventScroll: true });
  formatClock();
  clockTimer = globalThis.setInterval(formatClock, 15_000);
  return true;
}

export function initializeAppLock() {
  const settings = loadAppLockSettings();
  if (settings.enabled && settings.pinHash) showAppLock();
}

globalThis.addEventListener?.('marshmallow-app-lock-now', () => showAppLock({ preview: true }));
