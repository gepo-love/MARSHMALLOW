import { icon } from './svg-icons.js';

export function openEnsembleModeNotice() {
  const host = document.getElementById('modal-container');
  if (!host) return Promise.resolve(false);
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
      <div class="modal-overlay modal-sheet-center" data-ensemble-notice-overlay>
        <div class="modal-sheet scrapbook-card ensemble-notice-sheet" role="alertdialog" aria-modal="true" aria-labelledby="ensemble-notice-title">
          <header class="modal-header">
            <h3 id="ensemble-notice-title">群像模式 · 测试中</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-ensemble-notice-cancel aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body ensemble-notice-body">
            <p>用于统筹当前档位里的事件进度，并串联同世界观、同分组或关系网已建立联系的角色。</p>
            <p>群聊、角色间私聊、小群与动态可能沿同一事件继续发展；未建立关系的角色不会被自动拉进来。</p>
            <p>该功能仍在测试，建议先确认关系网与通讯录分组；开启后也可以在档位菜单里补充当前背景。</p>
          </div>
          <footer class="modal-footer">
            <button type="button" class="btn btn-outline" data-ensemble-notice-cancel>暂不开启</button>
            <button type="button" class="btn btn-primary" data-ensemble-notice-confirm>开启</button>
          </footer>
        </div>
      </div>
    `;
    host.querySelector('[data-ensemble-notice-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) finish(false);
    });
    host.querySelectorAll('[data-ensemble-notice-cancel]').forEach((button) => {
      button.addEventListener('click', () => finish(false));
    });
    host.querySelector('[data-ensemble-notice-confirm]')?.addEventListener('click', () => finish(true));
  });
}
