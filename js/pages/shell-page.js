import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { getShellPageConfig } from '../data/shell-pages.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function render(container, path = '') {
  const cfg = getShellPageConfig(path) || {
    title: '敬请期待',
    emoji: '🍥',
    empty: '功能建设中',
  };

  container.className = 'page scrapbook-page shell-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${esc(cfg.title)}</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="settings-scroll scrapbook-scroll">
      <div class="shell-empty">
        <div class="shell-empty-icon">${esc(cfg.emoji)}</div>
        <div class="shell-empty-text">${esc(cfg.empty)}</div>
      </div>
    </main>
  `;

  const backBtn = container.querySelector('[data-back]');
  if (backBtn) backBtn.addEventListener('click', () => back());
}
