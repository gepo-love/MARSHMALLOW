import { icon } from './svg-icons.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CATEGORY_OPTIONS = [
  { id: 'family', label: '家人' },
  { id: 'work', label: '工作' },
  { id: 'friend', label: '朋友' },
  { id: 'rival', label: '关系紧张' },
  { id: 'other', label: '其他' },
];

function openToolSheet({ title, body, submitLabel = '确认', bind }) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-container');
    if (!host) {
      resolve(null);
      return;
    }
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center cphone-contact-tool-overlay" data-cphone-tool-overlay>
        <form class="modal-sheet scrapbook-card cphone-contact-tool-sheet" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>${esc(title)}</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-cphone-tool-close aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body cphone-contact-tool-body">${body}</div>
          <footer class="modal-footer cphone-contact-tool-footer">
            <button type="button" class="btn" data-cphone-tool-cancel>取消</button>
            <button type="submit" class="btn btn-primary" data-cphone-tool-submit>${esc(submitLabel)}</button>
          </footer>
        </form>
      </div>`;

    const form = host.querySelector('.cphone-contact-tool-sheet');
    let settled = false;
    const close = (value = null) => {
      if (settled) return;
      settled = true;
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(value);
    };
    host.querySelector('[data-cphone-tool-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close(null);
    });
    host.querySelector('[data-cphone-tool-close]')?.addEventListener('click', () => close(null));
    host.querySelector('[data-cphone-tool-cancel]')?.addEventListener('click', () => close(null));
    form?.addEventListener('click', (event) => event.stopPropagation());
    bind?.({ host, form, close });
  });
}

export function openPhoneContactCreateModal() {
  return openToolSheet({
    title: '新的联系人',
    submitLabel: '添加',
    body: `
      <button type="button" class="cphone-contact-tool-directory" data-cphone-contact-directory>从通讯录选择</button>
      <label class="cphone-contact-tool-field">
        <span>姓名</span>
        <input type="text" maxlength="80" autocomplete="off" data-cphone-contact-name>
      </label>
      <label class="cphone-contact-tool-field">
        <span>备注</span>
        <input type="text" maxlength="40" autocomplete="off" placeholder="可选，显示在这部手机里" data-cphone-contact-remark>
      </label>
      <label class="cphone-contact-tool-field">
        <span>类型</span>
        <select data-cphone-contact-category>
          ${CATEGORY_OPTIONS.map((item) => `<option value="${item.id}">${item.label}</option>`).join('')}
        </select>
      </label>
      <label class="cphone-contact-tool-field">
        <span>与 TA 的关系</span>
        <input type="text" maxlength="120" autocomplete="off" data-cphone-contact-relationship>
      </label>`,
    bind: ({ host, form, close }) => {
      host.querySelector('[data-cphone-contact-directory]')?.addEventListener('click', () => {
        close({ mode: 'directory' });
      });
      form?.addEventListener('submit', (event) => {
        event.preventDefault();
        const input = host.querySelector('[data-cphone-contact-name]');
        const name = String(input?.value || '').trim();
        if (!name) {
          input?.setCustomValidity('请填写姓名');
          input?.reportValidity();
          input?.addEventListener('input', () => input.setCustomValidity(''), { once: true });
          return;
        }
        close({
          mode: 'manual',
          name,
          remark: String(host.querySelector('[data-cphone-contact-remark]')?.value || '').trim(),
          category: String(host.querySelector('[data-cphone-contact-category]')?.value || 'other'),
          relationship: String(host.querySelector('[data-cphone-contact-relationship]')?.value || '').trim(),
        });
      });
      queueMicrotask(() => host.querySelector('[data-cphone-contact-name]')?.focus?.());
    },
  });
}

export function openPhoneNpcGenerateModal() {
  return openToolSheet({
    title: '生成临时 NPC',
    submitLabel: '生成候选',
    body: `
      <label class="cphone-contact-tool-field">
        <span>生成数量</span>
        <select data-cphone-npc-count>
          ${Array.from({ length: 8 }, (_, index) => index + 1)
            .map((count) => `<option value="${count}" ${count === 4 ? 'selected' : ''}>${count} 位</option>`)
            .join('')}
        </select>
      </label>
      <fieldset class="cphone-contact-tool-types">
        <legend>NPC 类型</legend>
        <div>
          ${CATEGORY_OPTIONS.map((item) => `
            <label><input type="checkbox" value="${item.id}" data-cphone-npc-category checked><span>${item.label}</span></label>`).join('')}
        </div>
      </fieldset>
      <label class="cphone-contact-tool-field">
        <span>补充方向</span>
        <textarea rows="3" maxlength="300" placeholder="可选，例如：多一些校园同学" data-cphone-npc-direction></textarea>
      </label>`,
    bind: ({ host, form, close }) => {
      form?.addEventListener('submit', (event) => {
        event.preventDefault();
        const categories = [...host.querySelectorAll('[data-cphone-npc-category]:checked')]
          .map((input) => String(input.value || '').trim())
          .filter(Boolean);
        if (!categories.length) {
          host.querySelector('[data-cphone-npc-category]')?.focus?.();
          return;
        }
        close({
          count: Number(host.querySelector('[data-cphone-npc-count]')?.value || 4),
          categories,
          direction: String(host.querySelector('[data-cphone-npc-direction]')?.value || '').trim(),
        });
      });
    },
  });
}

export function openPhoneQuickGroupModal({ ownerName = 'TA', actors = [] } = {}) {
  const options = (Array.isArray(actors) ? actors : [])
    .map((actor) => ({
      id: String(actor?.id || '').trim(),
      name: String(actor?.name || actor?.label || actor?.id || '').trim(),
      detail: String(actor?.detail || '').trim(),
    }))
    .filter((actor) => actor.id && actor.name);
  if (!options.length) return Promise.resolve(null);
  return openToolSheet({
    title: '快捷拉群',
    submitLabel: '创建并打开',
    body: `
      <label class="cphone-contact-tool-field">
        <span>群聊名称</span>
        <input type="text" maxlength="80" placeholder="可选" data-cphone-group-name>
      </label>
      <label class="cphone-contact-tool-field">
        <span>选择成员</span>
        <input type="search" autocomplete="off" placeholder="搜索联系人" data-cphone-group-search>
      </label>
      <div class="cphone-contact-tool-owner"><span>已在群内</span><b>${esc(ownerName)}</b></div>
      <div class="cphone-contact-tool-members" data-cphone-group-members>
        ${options.map((actor) => `
          <label data-cphone-group-option data-name="${esc(actor.name.toLowerCase())}">
            <input type="checkbox" value="${esc(actor.id)}" data-cphone-group-member>
            <span><b>${esc(actor.name)}</b>${actor.detail ? `<em>${esc(actor.detail)}</em>` : ''}</span>
          </label>`).join('')}
      </div>`,
    bind: ({ host, form, close }) => {
      const submit = host.querySelector('[data-cphone-tool-submit]');
      const syncSubmit = () => {
        if (submit) submit.disabled = !host.querySelector('[data-cphone-group-member]:checked');
      };
      syncSubmit();
      host.querySelectorAll('[data-cphone-group-member]').forEach((input) => {
        input.addEventListener('change', syncSubmit);
      });
      host.querySelector('[data-cphone-group-search]')?.addEventListener('input', (event) => {
        const query = String(event.currentTarget.value || '').trim().toLowerCase();
        host.querySelectorAll('[data-cphone-group-option]').forEach((row) => {
          row.hidden = !!query && !String(row.getAttribute('data-name') || '').includes(query);
        });
      });
      form?.addEventListener('submit', (event) => {
        event.preventDefault();
        const actorIds = [...host.querySelectorAll('[data-cphone-group-member]:checked')]
          .map((input) => String(input.value || '').trim())
          .filter(Boolean);
        if (!actorIds.length) return;
        close({
          name: String(host.querySelector('[data-cphone-group-name]')?.value || '').trim(),
          actorIds,
        });
      });
    },
  });
}
