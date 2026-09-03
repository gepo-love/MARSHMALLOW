import {
  OFFLINE_EXPERIENCE_AUDIO,
  OFFLINE_EXPERIENCE_NORMAL,
} from '../core/offline-experience-mode.js';

export function chooseOfflineExperienceMode({ allowAudio = true, title = '进入线下' } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (value) => {
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(value);
    };
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center offline-mode-overlay" data-offline-mode-overlay>
        <section class="modal-sheet scrapbook-card offline-mode-sheet" role="dialog" aria-modal="true" aria-label="选择线下模式">
          <header class="modal-header"><h3>${String(title || '进入线下')}</h3></header>
          <div class="offline-mode-choices">
            <button type="button" class="offline-mode-choice" data-offline-mode="${OFFLINE_EXPERIENCE_NORMAL}">
              <strong>普通线下</strong><small>约会探索 · 支持多人和长叙事</small>
            </button>
            <button type="button" class="offline-mode-choice" data-offline-mode="${OFFLINE_EXPERIENCE_AUDIO}" ${allowAudio ? '' : 'disabled'}>
              <strong>音声线下</strong><small>${allowAudio ? '旁白与对白 · 单角色音声演出' : '初版仅支持单角色'}</small>
            </button>
          </div>
          <button type="button" class="btn btn-soft offline-mode-cancel" data-offline-mode-cancel>取消</button>
        </section>
      </div>`;
    host.querySelector('[data-offline-mode-overlay]')?.addEventListener('click', (event) => {
      if (event.target === host.querySelector('[data-offline-mode-overlay]')) done(null);
    });
    host.querySelector('[data-offline-mode-cancel]')?.addEventListener('click', () => done(null));
    host.querySelectorAll('[data-offline-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!button.disabled) done(button.getAttribute('data-offline-mode'));
      });
    });
  });
}
