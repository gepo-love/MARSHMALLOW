import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { TUTORIAL_NAV, renderTutorialSection } from '../data/tutorial-sections.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeSection(section = '') {
  const id = String(section || '').trim();
  if (TUTORIAL_NAV.some((item) => item.id === id)) return id;
  return TUTORIAL_NAV[0]?.id || 'appearance';
}

export default async function render(container, params = {}) {
  const activeSection = normalizeSection(params.section);

  container.className = 'page scrapbook-page settings-sub-page tutorial-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">教程</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="settings-scroll scrapbook-scroll tutorial-scroll">
      <nav class="tutorial-nav" aria-label="教程目录">
        ${TUTORIAL_NAV.map((item) => `
          <button
            type="button"
            class="tutorial-nav-item ${item.id === activeSection ? 'is-active' : ''}"
            data-tutorial-section="${esc(item.id)}"
          >${esc(item.label)}</button>
        `).join('')}
      </nav>
      <div class="tutorial-sections">
        <section class="tutorial-section is-active" data-tutorial-panel="${esc(activeSection)}">
          ${renderTutorialSection(activeSection)}
        </section>
      </div>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());

  container.querySelectorAll('[data-tutorial-section]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const section = String(btn.getAttribute('data-tutorial-section') || '').trim();
      if (!section || section === activeSection) return;
      navigate('tutorial', { section }, true);
    });
  });
}
