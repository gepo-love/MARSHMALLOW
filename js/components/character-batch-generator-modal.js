import { icon } from './svg-icons.js';

function esc(value = '') {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function checkedValues(host, selector) {
  return [...host.querySelectorAll(selector)].filter((el) => el.checked).map((el) => el.value);
}

export function openCharacterBatchGeneratorModal({
  groups = [],
  worldBooks = [],
  characters = [],
  defaultGroupId = 'default',
  onGenerate,
  onSave,
  onError,
  onClosed,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  let drafts = [];
  let generating = false;
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-batch-overlay>
      <section class="modal-sheet scrapbook-card character-batch-sheet" role="dialog" aria-modal="true">
        <header class="modal-header"><h3>批量生成角色</h3><button type="button" class="navbar-btn modal-close-btn" data-batch-close aria-label="关闭">${icon('back')}</button></header>
        <div class="modal-body character-batch-body">
          <label class="api-field"><span class="api-field-label">需要什么角色</span><textarea class="form-input" data-batch-description rows="4" placeholder="例如：同一所大学的三位朋友；一位和指定角色认识的邻居"></textarea></label>
          <div class="character-batch-grid">
            <label class="api-field"><span class="api-field-label">人数</span><input class="form-input" data-batch-count type="number" min="1" max="12" value="3"></label>
            <label class="api-field"><span class="api-field-label">保存到分组</span><select class="form-input" data-batch-group>${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === defaultGroupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
          </div>
          <label class="api-field"><span class="api-field-label">或新建分组</span><input class="form-input" data-batch-new-group placeholder="留空则使用上方分组"></label>
          <details class="character-batch-options"><summary>绑定世界书</summary><div class="character-batch-checks">${worldBooks.length ? worldBooks.map((book) => `<label><input type="checkbox" data-batch-world value="${esc(book.id)}"><span>${esc(book.name)}</span></label>`).join('') : '<span class="text-hint">暂无世界书</span>'}</div></details>
          <details class="character-batch-options"><summary>指定相关角色</summary><div class="character-batch-checks">${characters.length ? characters.map((char) => `<label><input type="checkbox" data-batch-related value="${esc(char.id)}"><span>${esc(char.name || char.realName)}</span></label>`).join('') : '<span class="text-hint">通讯录暂无角色</span>'}</div></details>
          <div class="character-batch-results" data-batch-results hidden></div>
        </div>
        <footer class="modal-footer character-batch-footer"><button type="button" class="btn btn-outline" data-batch-close>取消</button><button type="button" class="btn btn-primary" data-batch-generate>${icon('sparkle')}生成草稿</button><button type="button" class="btn btn-primary" data-batch-save hidden>保存所选角色</button></footer>
      </section>
    </div>`;
  const sheet = host.querySelector('.character-batch-sheet');
  const results = host.querySelector('[data-batch-results]');
  const generateBtn = host.querySelector('[data-batch-generate]');
  const saveBtn = host.querySelector('[data-batch-save]');
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
    onClosed?.();
  };
  host.querySelector('[data-batch-overlay]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget && !generating) close();
  });
  sheet?.addEventListener('click', (event) => event.stopPropagation());
  host.querySelectorAll('[data-batch-close]').forEach((button) => button.addEventListener('click', () => {
    if (!generating) close();
  }));

  const paintDrafts = () => {
    if (!results) return;
    results.hidden = false;
    results.innerHTML = `<div class="character-batch-result-head"><strong>生成结果</strong><span>可修改后再保存</span></div>${drafts.map((draft, index) => `
      <article class="character-batch-card" data-batch-card="${index}">
        <label class="character-batch-card-check"><input type="checkbox" data-batch-keep checked><span>保留这位</span></label>
        <input class="form-input" data-batch-field="name" value="${esc(draft.name)}" placeholder="角色名">
        <input class="form-input" data-batch-field="currentRole" value="${esc(draft.currentRole)}" placeholder="身份 / 职业">
        <textarea class="form-input" data-batch-field="personality" rows="3" placeholder="性格">${esc(draft.personality)}</textarea>
        <textarea class="form-input" data-batch-field="userRelationStatus" rows="2" placeholder="与 User 的关系">${esc(draft.userRelationStatus)}</textarea>
        <textarea class="form-input" data-batch-field="promptCorpus" rows="4" placeholder="完整人设">${esc(draft.promptCorpus)}</textarea>
      </article>`).join('')}`;
    generateBtn.hidden = true;
    saveBtn.hidden = false;
  };

  generateBtn?.addEventListener('click', async () => {
    if (generating) return;
    generating = true;
    generateBtn.disabled = true;
    generateBtn.textContent = '生成中…';
    try {
      drafts = await onGenerate?.({
        description: host.querySelector('[data-batch-description]')?.value || '',
        count: host.querySelector('[data-batch-count]')?.value || 3,
        groupId: host.querySelector('[data-batch-group]')?.value || 'default',
        newGroupName: host.querySelector('[data-batch-new-group]')?.value || '',
        worldBookIds: checkedValues(host, '[data-batch-world]'),
        relatedCharacterIds: checkedValues(host, '[data-batch-related]'),
      }) || [];
      paintDrafts();
    } catch (error) {
      generateBtn.textContent = '重新生成';
      onError?.(error);
    } finally {
      generating = false;
      if (generateBtn?.isConnected) generateBtn.disabled = false;
    }
  });

  saveBtn?.addEventListener('click', async () => {
    if (generating) return;
    const selected = [...host.querySelectorAll('[data-batch-card]')].flatMap((card) => {
      if (!card.querySelector('[data-batch-keep]')?.checked) return [];
      const index = Number(card.getAttribute('data-batch-card'));
      const base = drafts[index];
      if (!base) return [];
      const read = (key) => card.querySelector(`[data-batch-field="${key}"]`)?.value?.trim() || '';
      return [{ ...base, name: read('name'), currentRole: read('currentRole'), personality: read('personality'), userRelationStatus: read('userRelationStatus'), promptCorpus: read('promptCorpus') }];
    }).filter((row) => row.name);
    if (!selected.length) return;
    generating = true;
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      const saved = await onSave?.(selected, {
        groupId: host.querySelector('[data-batch-group]')?.value || 'default',
        newGroupName: host.querySelector('[data-batch-new-group]')?.value || '',
      });
      if (saved === false) return;
      close();
    } catch (error) {
      saveBtn.textContent = '重新保存';
      onError?.(error);
    } finally {
      generating = false;
      if (saveBtn?.isConnected) saveBtn.disabled = false;
    }
  });
}
