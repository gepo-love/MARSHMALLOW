const QUICK_EMOJIS = ['👍', '😂', '😭', '❤️', '🥺', '🙏', '👏', '👀', '😡', '🤔'];

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeReactionInput(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  return [...trimmed].slice(0, 8).join('');
}

export function openEmojiReactionPicker({ variant = '' } = {}) {
  const isAnon = variant === 'anon';
  const host = document.getElementById('modal-container');
  const useModalHost = !!host;
  const mount = useModalHost ? host : document.createElement('div');
  if (!useModalHost) document.body.appendChild(mount);

  return new Promise((resolve) => {
    let closed = false;
    let quickPickReady = false;
    let quickPickFrame = 0;
    let quickPickTimer = 0;
    const dialogClass = isAnon
      ? 'emoji-react-dialog emoji-react-dialog--anon'
      : 'emoji-react-dialog scrapbook-card';
    mount.innerHTML = `
      <div class="modal-overlay emoji-react-overlay" data-emoji-react-overlay>
        <div class="${dialogClass}" role="dialog" aria-modal="true" aria-label="表情回应">
          <header class="emoji-react-head">
            <h3>表情回应</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-emoji-react-close aria-label="关闭">
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <div class="emoji-react-body">
            <label class="emoji-react-field">
              <span class="emoji-react-label">输入回应</span>
              <input type="text" class="form-input emoji-react-input" maxlength="8" placeholder="emoji 或颜文字" />
            </label>
            <div class="emoji-react-quick" aria-label="常用">
              ${QUICK_EMOJIS.map((em) => `<button type="button" class="emoji-react-btn" data-emoji="${esc(em)}" title="使用 ${esc(em)}">${em}</button>`).join('')}
            </div>
          </div>
          <footer class="emoji-react-foot">
            <button type="button" class="btn btn-soft" data-emoji-react-cancel>取消</button>
            <button type="button" class="btn btn-primary" data-emoji-react-confirm>贴上去</button>
          </footer>
        </div>
      </div>
    `;
    if (useModalHost) mount.classList.add('active');

    const input = mount.querySelector('.emoji-react-input');
    const close = (emoji = null) => {
      if (closed) return;
      closed = true;
      if (quickPickFrame) window.cancelAnimationFrame(quickPickFrame);
      if (quickPickTimer) window.clearTimeout(quickPickTimer);
      if (useModalHost) {
        mount.classList.remove('active');
        mount.innerHTML = '';
      } else {
        mount.remove();
      }
      resolve(normalizeReactionInput(emoji));
    };

    mount.querySelector('[data-emoji-react-overlay]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) close(null);
    });
    mount.querySelector('[data-emoji-react-close]')?.addEventListener('click', () => close(null));
    mount.querySelector('[data-emoji-react-cancel]')?.addEventListener('click', () => close(null));
    mount.querySelector('.emoji-react-dialog')?.addEventListener('click', (e) => e.stopPropagation());

    mount.querySelector('[data-emoji-react-confirm]')?.addEventListener('click', () => {
      const value = normalizeReactionInput(input?.value);
      if (!value) {
        input?.focus();
        return;
      }
      close(value);
    });

    mount.querySelectorAll('[data-emoji]').forEach((btn) => {
      btn.addEventListener('click', () => {
        // 部分红米设备在弹层首帧与键盘/合成层切换时会延迟显示；用户补点的第二下
        // 可能正好落到刚出现的表情上。等弹层稳定一帧后再接收快捷选择。
        if (!quickPickReady) return;
        const em = btn.getAttribute('data-emoji') || '';
        if (input) input.value = em;
        close(em);
      });
    });

    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = normalizeReactionInput(input.value);
        if (value) close(value);
      }
    });

    // 快捷回应是主路径，不要打开弹层就抢焦点、拉起软键盘。需要自定义表情时
    // 用户点输入框再唤起键盘，避免 Android WebView 首帧重排和误点。
    quickPickFrame = window.requestAnimationFrame(() => {
      quickPickFrame = 0;
      quickPickTimer = window.setTimeout(() => {
        quickPickTimer = 0;
        quickPickReady = true;
      }, 180);
    });
  });
}
