import { icon } from './svg-icons.js';

function esc(value = '') {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function openUserProfileAiModal({ worldBooks = [], onGenerate, onGenerated, onError } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  let generating = false;
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-user-ai-overlay>
      <form class="modal-sheet scrapbook-card user-profile-ai-sheet" role="dialog" aria-modal="true" data-user-ai-form>
        <header class="modal-header"><h3>AI 补全 User</h3><button type="button" class="navbar-btn modal-close-btn" data-user-ai-close aria-label="关闭">${icon('back')}</button></header>
        <div class="modal-body user-profile-ai-body">
          <label class="api-field"><span class="api-field-label">简单描述</span><textarea class="form-input" data-user-ai-description rows="5" placeholder="例如：海滨小城的独立摄影师，慢热，喜欢夜晚散步"></textarea></label>
          <fieldset class="user-profile-ai-worldbooks">
            <legend>绑定世界书（可不选）</legend>
            <div class="user-profile-ai-checks">${worldBooks.length
              ? worldBooks.map((book) => `<label><input type="checkbox" data-user-ai-world value="${esc(book.id)}"><span>${esc(book.name)}</span></label>`).join('')
              : '<span class="text-hint">暂无世界书</span>'}</div>
          </fieldset>
        </div>
        <footer class="modal-footer user-profile-ai-footer"><button type="button" class="btn btn-outline" data-user-ai-close>取消</button><button type="submit" class="btn btn-primary" data-user-ai-submit>${icon('sparkle')}生成补全</button></footer>
      </form>
    </div>`;
  const form = host.querySelector('[data-user-ai-form]');
  const submit = host.querySelector('[data-user-ai-submit]');
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-user-ai-overlay]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget && !generating) close();
  });
  form?.addEventListener('click', (event) => event.stopPropagation());
  host.querySelectorAll('[data-user-ai-close]').forEach((button) => button.addEventListener('click', () => {
    if (!generating) close();
  }));
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (generating) return;
    const description = String(host.querySelector('[data-user-ai-description]')?.value || '').trim();
    const worldBookIds = [...host.querySelectorAll('[data-user-ai-world]:checked')].map((input) => input.value);
    generating = true;
    if (submit) {
      submit.disabled = true;
      submit.textContent = '生成中…';
    }
    try {
      const result = await onGenerate?.({ description, worldBookIds });
      close();
      onGenerated?.(result);
    } catch (error) {
      onError?.(error);
      if (submit?.isConnected) {
        submit.disabled = false;
        submit.textContent = '重新生成';
      }
    } finally {
      generating = false;
    }
  });
}
