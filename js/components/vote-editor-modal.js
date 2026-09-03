import { icon } from './svg-icons.js';
import { showToast } from './toast.js';

const MIN_VOTE_OPTIONS = 2;
const MAX_VOTE_OPTIONS = 8;

function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function normalizeVoteOptionValues(options = []) {
  const values = (Array.isArray(options) ? options : [])
    .map((option) => String(option ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_VOTE_OPTIONS);
  while (values.length < MIN_VOTE_OPTIONS) values.push('');
  return values;
}

function voteOptionRowHtml(value = '', index = 0) {
  const number = index + 1;
  return `
    <div class="vote-option-row" data-vote-option-row>
      <span class="vote-option-index" aria-hidden="true">${number}</span>
      <input
        type="text"
        class="form-input vote-option-input"
        value="${escapeHtml(value)}"
        placeholder="选项 ${number}"
        maxlength="80"
        aria-label="投票选项 ${number}"
      />
      <button type="button" class="vote-option-remove" data-vote-option-remove aria-label="删除选项 ${number}">
        ${icon('trash')}
      </button>
    </div>
  `;
}

export function voteOptionEditorHtml(options = []) {
  const values = normalizeVoteOptionValues(options);
  return `
    <div class="vote-option-editor" data-vote-option-editor>
      <div class="vote-option-list" data-vote-option-list>
        ${values.map((value, index) => voteOptionRowHtml(value, index)).join('')}
      </div>
      <button type="button" class="vote-option-add" data-vote-option-add>
        ${icon('plus')}<span>添加选项</span>
      </button>
    </div>
  `;
}

export function bindVoteOptionEditor(root) {
  const editor = root?.querySelector?.('[data-vote-option-editor]');
  const list = editor?.querySelector?.('[data-vote-option-list]');
  const addButton = editor?.querySelector?.('[data-vote-option-add]');
  if (!editor || !list || !addButton) return null;

  const rows = () => Array.from(list.querySelectorAll('[data-vote-option-row]'));
  const syncRows = () => {
    const currentRows = rows();
    currentRows.forEach((row, index) => {
      const number = index + 1;
      const badge = row.querySelector('.vote-option-index');
      const input = row.querySelector('.vote-option-input');
      const remove = row.querySelector('[data-vote-option-remove]');
      if (badge) badge.textContent = String(number);
      if (input) {
        input.placeholder = `选项 ${number}`;
        input.setAttribute('aria-label', `投票选项 ${number}`);
      }
      if (remove) {
        remove.setAttribute('aria-label', `删除选项 ${number}`);
        remove.disabled = currentRows.length <= MIN_VOTE_OPTIONS;
      }
    });
    addButton.disabled = currentRows.length >= MAX_VOTE_OPTIONS;
    addButton.hidden = currentRows.length >= MAX_VOTE_OPTIONS;
  };

  list.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-vote-option-remove]');
    if (!remove || remove.disabled) return;
    remove.closest('[data-vote-option-row]')?.remove();
    syncRows();
  });

  addButton.addEventListener('click', () => {
    const index = rows().length;
    if (index >= MAX_VOTE_OPTIONS) return;
    list.insertAdjacentHTML('beforeend', voteOptionRowHtml('', index));
    syncRows();
    rows().at(-1)?.querySelector('.vote-option-input')?.focus();
  });

  syncRows();
  return {
    values() {
      return rows()
        .map((row) => String(row.querySelector('.vote-option-input')?.value || '').trim())
        .filter(Boolean)
        .slice(0, MAX_VOTE_OPTIONS);
    },
  };
}

export function openVoteEditorModal({
  title = '',
  options = [],
  variant = '',
  confirmLabel = '发送',
  onSave,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const isAnon = variant === 'anon';
  const sheetClass = isAnon
    ? 'modal-sheet anon-modal-sheet vote-editor-sheet vote-editor-sheet--anon'
    : 'modal-sheet scrapbook-card vote-editor-sheet';
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-vote-editor-overlay>
      <div class="${sheetClass}" role="dialog" aria-modal="true" aria-labelledby="vote-editor-title">
        <header class="modal-header">
          <h3 id="vote-editor-title">发起投票</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-vote-editor-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body">
          <label class="form-label" for="vote-editor-title-input">投票标题</label>
          <input
            id="vote-editor-title-input"
            type="text"
            class="form-input vote-editor-title-input"
            value="${escapeHtml(title)}"
            placeholder="输入投票标题"
            maxlength="120"
          />
          <div class="form-label vote-option-heading">选项</div>
          ${voteOptionEditorHtml(options)}
          <button type="button" class="btn btn-primary vote-editor-save">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    </div>
  `;

  const titleInput = host.querySelector('.vote-editor-title-input');
  const saveButton = host.querySelector('.vote-editor-save');
  const optionEditor = bindVoteOptionEditor(host);
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };

  host.querySelector('[data-vote-editor-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-vote-editor-close]')?.addEventListener('click', close);
  host.querySelector('.vote-editor-sheet')?.addEventListener('click', (event) => event.stopPropagation());
  saveButton?.addEventListener('click', async () => {
    const nextTitle = String(titleInput?.value || '').trim();
    const nextOptions = optionEditor?.values() || [];
    if (!nextTitle) {
      showToast('请输入投票标题');
      titleInput?.focus();
      return;
    }
    if (nextOptions.length < MIN_VOTE_OPTIONS) {
      showToast('请填写至少两个选项');
      Array.from(host.querySelectorAll('.vote-option-input'))
        .find((input) => !String(input.value || '').trim())
        ?.focus();
      return;
    }
    saveButton.disabled = true;
    try {
      await onSave?.({ title: nextTitle, options: nextOptions });
      close();
    } catch (error) {
      saveButton.disabled = false;
      showToast(error?.message || '投票发送失败');
    }
  });
  titleInput?.focus();
}
