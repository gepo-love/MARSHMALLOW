import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';

export function renderSettingsRouteSkeleton(container, {
  title,
  pageClass,
  scrollClass = 'settings-scroll scrapbook-scroll',
  tabStrip = false,
} = {}) {
  container.className = `page scrapbook-page ${pageClass || ''}`.trim();
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn settings-route-entry-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${title || '设置'}</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="${scrollClass}" aria-busy="true">
      <div class="page-skeleton" aria-hidden="true">
        ${tabStrip ? '<span class="sk-block sk-bar" style="height:38px"></span>' : ''}
        <span class="sk-block sk-bar" style="width:28%"></span>
        <span class="sk-block sk-bar" style="height:72px"></span>
        <span class="sk-block sk-bar" style="height:72px"></span>
        <span class="sk-block sk-bar" style="width:36%"></span>
        <span class="sk-block sk-bar" style="height:96px"></span>
      </div>
    </main>
  `;
  container.querySelector('.settings-route-entry-back')?.addEventListener('click', () => back());
}

export function yieldSettingsRoutePaint() {
  return new Promise((resolve) => {
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    raf(() => raf(resolve));
  });
}
