import { icon } from './svg-icons.js';
import { showToast } from './toast.js';
import { openTextEditorModal } from './text-editor-modal.js';
import {
  distillGuidanceMemories,
  estimateGuidanceTokens,
  guidanceMemoryStatus,
  GUIDANCE_STATUS_ACTIVE,
  GUIDANCE_STATUS_ARCHIVED,
  GUIDANCE_STATUS_DISABLED,
  listGuidanceMemoriesForCharacter,
  saveDistilledGuidanceMemory,
  setGuidanceMemoryPinned,
  setGuidanceMemoryStatus,
  updateGuidanceMemory,
  deleteGuidanceMemory,
} from '../core/guidance-memory.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(ts = 0) {
  const n = Number(ts || 0);
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${m}-${day} ${hh}:${mm}`;
}

/**
 * 指导模式入口小窗：进入/退出 + 管理记忆。
 * 计入记忆改在退出流程里勾选保存，此处不再提供单独入库入口。
 */
export function openGuidanceModeSheet({
  guidanceMode = false,
  characterName = '对方',
  variant = '',
  onToggleMode,
  onManageMemories,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  host.classList.add('active');
  const isAnon = variant === 'anon';
  const sheetClass = isAnon
    ? 'modal-sheet anon-modal-sheet guidance-mode-sheet'
    : 'modal-sheet scrapbook-card guidance-mode-sheet';
  const status = guidanceMode ? '当前：指导模式中' : '当前：普通扮演';
  host.innerHTML = `
    <div class="modal-overlay" data-guidance-sheet-overlay>
      <div class="${sheetClass}" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h3>指导</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-guidance-sheet-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body guidance-mode-sheet-body">
          <p class="guidance-mode-sheet-status">${esc(status)} · ${esc(characterName)}</p>
          <button type="button" class="btn btn-primary guidance-mode-sheet-btn" data-guidance-toggle>
            ${guidanceMode ? '退出指导模式' : '进入指导模式'}
          </button>
          <button type="button" class="btn btn-outline guidance-mode-sheet-btn" data-guidance-manage>
            管理指导记忆
          </button>
        </div>
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-guidance-sheet-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-guidance-sheet-close]')?.addEventListener('click', close);
  host.querySelector('.guidance-mode-sheet')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-guidance-toggle]')?.addEventListener('click', async () => {
    close();
    await onToggleMode?.(!guidanceMode);
  });
  host.querySelector('[data-guidance-manage]')?.addEventListener('click', async () => {
    close();
    await onManageMemories?.();
  });
}

/** 退出指导时只做一次必要选择，详细内容仍由聊天里的勾选结果决定。 */
export function openGuidanceExitScopeSheet({
  characterName = '对方',
  variant = '',
  onSelect,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  host.classList.add('active');
  const sheetClass = variant === 'anon'
    ? 'modal-sheet anon-modal-sheet guidance-mode-sheet'
    : 'modal-sheet scrapbook-card guidance-mode-sheet';
  host.innerHTML = `
    <div class="modal-overlay" data-guidance-scope-overlay>
      <div class="${sheetClass}" role="dialog" aria-modal="true" aria-labelledby="guidance-scope-title">
        <header class="modal-header">
          <h3 id="guidance-scope-title">这次指导怎么用</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-guidance-scope-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body guidance-mode-sheet-body">
          <p class="guidance-mode-sheet-status">${esc(characterName)}</p>
          <button type="button" class="btn btn-primary guidance-mode-sheet-btn" data-guidance-scope="reroll">用于下一次重 roll</button>
          <button type="button" class="btn btn-outline guidance-mode-sheet-btn" data-guidance-scope="scene">本段生效</button>
          <button type="button" class="btn btn-outline guidance-mode-sheet-btn" data-guidance-scope="persistent-distilled">总结后长期记住</button>
          <button type="button" class="btn btn-outline guidance-mode-sheet-btn" data-guidance-scope="persistent-raw">按原记录长期记住</button>
          <button type="button" class="btn btn-soft guidance-mode-sheet-btn" data-guidance-scope="discard">不保存退出</button>
        </div>
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-guidance-scope-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-guidance-scope-close]')?.addEventListener('click', close);
  host.querySelector('.guidance-mode-sheet')?.addEventListener('click', (event) => event.stopPropagation());
  host.querySelectorAll('[data-guidance-scope]').forEach((button) => {
    button.addEventListener('click', async () => {
      const scope = String(button.getAttribute('data-guidance-scope') || '');
      close();
      await onSelect?.(scope);
    });
  });
}

/**
 * 管理某角色的指导专用记忆：编辑 / 删除。
 */
export async function openGuidanceMemoryManageModal({
  characterId,
  userId,
  characterName = '对方',
  characters = {},
  variant = '',
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const isAnon = variant === 'anon';
  const sheetClass = isAnon
    ? 'modal-sheet anon-modal-sheet guidance-memory-sheet'
    : 'modal-sheet scrapbook-card guidance-memory-sheet';
  const selectedIds = new Set();
  let busy = false;

  function statusLabel(row) {
    const status = guidanceMemoryStatus(row);
    if (status === GUIDANCE_STATUS_ARCHIVED) return '原记录';
    if (status === GUIDANCE_STATUS_DISABLED) return '已停用';
    return row.guidanceDistilled === true ? '已提炼' : '生效中';
  }

  async function paint() {
    const list = await listGuidanceMemoriesForCharacter(characterId, userId);
    const manageable = list.filter((row) => guidanceMemoryStatus(row) !== GUIDANCE_STATUS_ARCHIVED);
    const archived = list.filter((row) => guidanceMemoryStatus(row) === GUIDANCE_STATUS_ARCHIVED);
    const active = manageable.filter((row) => guidanceMemoryStatus(row) === GUIDANCE_STATUS_ACTIVE);
    const totalTokens = active.reduce((sum, row) => sum + estimateGuidanceTokens(row.content), 0);
    for (const id of [...selectedIds]) {
      if (!manageable.some((row) => String(row.id) === id)) selectedIds.delete(id);
    }
    host.classList.add('active');
    const cardHtml = (m, { archivedRow = false } = {}) => `
        <article class="guidance-memory-card ${guidanceMemoryStatus(m) === GUIDANCE_STATUS_DISABLED ? 'is-disabled' : ''} ${archivedRow ? 'is-archived' : ''}" data-mem-id="${esc(m.id)}">
          <div class="guidance-memory-card-top">
            ${archivedRow ? '' : `<label class="guidance-memory-select" aria-label="选择指导记忆">
              <input type="checkbox" data-select-mem="${esc(m.id)}" ${selectedIds.has(String(m.id)) ? 'checked' : ''} ${busy ? 'disabled' : ''}>
              <span></span>
            </label>`}
            <div class="guidance-memory-card-meta">
              <span>${esc(statusLabel(m))}${m.guidancePinned ? ' · 置顶' : ''}</span>
              <span>${esc(formatTime(m.timestamp))} · 约 ${estimateGuidanceTokens(m.content)} tokens</span>
            </div>
          </div>
          <div class="guidance-memory-card-body">${esc(m.content || '')}</div>
          <div class="guidance-memory-card-actions">
            ${archivedRow
              ? `<button type="button" class="btn btn-soft btn-sm" data-restore-mem="${esc(m.id)}">恢复</button>`
              : `
                <button type="button" class="btn btn-soft btn-sm" data-pin-mem="${esc(m.id)}">${m.guidancePinned ? '取消置顶' : '置顶'}</button>
                <button type="button" class="btn btn-soft btn-sm" data-toggle-mem="${esc(m.id)}">${guidanceMemoryStatus(m) === GUIDANCE_STATUS_DISABLED ? '启用' : '停用'}</button>
                <button type="button" class="btn btn-soft btn-sm" data-edit-mem="${esc(m.id)}">编辑</button>
              `}
            <button type="button" class="btn btn-sm is-danger" data-del-mem="${esc(m.id)}">删除</button>
          </div>
        </article>`;
    const rows = manageable.length
      ? manageable.map((m) => cardHtml(m)).join('')
      : '<p class="guidance-memory-empty">暂无指导记忆。退出指导模式时可勾选保存。</p>';
    const archivedRows = archived.length
      ? `<details class="guidance-memory-archive">
          <summary>原记录 · ${archived.length}</summary>
          <div class="guidance-memory-archive-list">${archived.map((m) => cardHtml(m, { archivedRow: true })).join('')}</div>
        </details>`
      : '';

    host.innerHTML = `
      <div class="modal-overlay" data-guidance-mem-overlay>
        <div class="${sheetClass}" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>指导记忆 · ${esc(characterName)}</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-guidance-mem-close aria-label="关闭">${icon('back')}</button>
          </header>
          <div class="modal-body guidance-memory-sheet-body">
            <section class="guidance-memory-overview" aria-live="polite">
              <div><strong>${active.length}</strong><span>条生效</span></div>
              <div><strong>约 ${totalTokens}</strong><span>tokens</span></div>
            </section>
            ${manageable.length ? `
              <div class="guidance-memory-toolbar">
                <label class="guidance-memory-select-all">
                  <input type="checkbox" data-select-all-guidance ${manageable.length && selectedIds.size === manageable.length ? 'checked' : ''} ${busy ? 'disabled' : ''}>
                  <span>全选</span>
                </label>
                <button type="button" class="btn btn-primary btn-sm" data-distill-guidance ${selectedIds.size >= 2 && !busy ? '' : 'disabled'}>
                  ${busy ? '正在提炼…' : `总结提炼${selectedIds.size ? ` · ${selectedIds.size}` : ''}`}
                </button>
                <button type="button" class="btn btn-soft btn-sm" data-disable-guidance ${selectedIds.size && !busy ? '' : 'disabled'}>批量停用</button>
              </div>
            ` : ''}
            ${rows}
            ${archivedRows}
          </div>
        </div>
      </div>
    `;

    const close = () => {
      host.classList.remove('active');
      host.innerHTML = '';
    };
    host.querySelector('[data-guidance-mem-overlay]')?.addEventListener('click', close);
    host.querySelector('[data-guidance-mem-close]')?.addEventListener('click', close);
    host.querySelector('.guidance-memory-sheet')?.addEventListener('click', (e) => e.stopPropagation());

    const updateToolbar = () => {
      const distill = host.querySelector('[data-distill-guidance]');
      const disable = host.querySelector('[data-disable-guidance]');
      const all = host.querySelector('[data-select-all-guidance]');
      if (distill) {
        distill.disabled = busy || selectedIds.size < 2;
        distill.textContent = busy ? '正在提炼…' : `总结提炼${selectedIds.size ? ` · ${selectedIds.size}` : ''}`;
      }
      if (disable) disable.disabled = busy || selectedIds.size < 1;
      if (all) all.checked = manageable.length > 0 && selectedIds.size === manageable.length;
    };

    host.querySelectorAll('[data-select-mem]').forEach((input) => {
      input.addEventListener('change', () => {
        const id = String(input.getAttribute('data-select-mem') || '');
        if (input.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        updateToolbar();
      });
    });
    host.querySelector('[data-select-all-guidance]')?.addEventListener('change', (event) => {
      selectedIds.clear();
      if (event.target.checked) manageable.forEach((row) => selectedIds.add(String(row.id)));
      host.querySelectorAll('[data-select-mem]').forEach((input) => { input.checked = event.target.checked; });
      updateToolbar();
    });
    host.querySelector('[data-distill-guidance]')?.addEventListener('click', async () => {
      if (selectedIds.size < 2 || busy) return;
      busy = true;
      await paint();
      try {
        const result = await distillGuidanceMemories({
          characterId,
          userId,
          memoryIds: [...selectedIds],
          characters,
        });
        busy = false;
        openTextEditorModal({
          title: '确认提炼结果',
          value: result.content,
          placeholder: '检查并修改提炼后的指导…',
          multiline: true,
          confirmLabel: '保存并归档原记录',
          variant,
          onSave: async (text) => {
            await saveDistilledGuidanceMemory({
              characterId,
              userId,
              content: text,
              sourceMemoryIds: result.sourceMemories.map((row) => row.id),
            });
            selectedIds.clear();
            showToast('已提炼，原记录已归档');
            await paint();
          },
          onClosed: () => { paint().catch(() => {}); },
        });
      } catch (error) {
        busy = false;
        showToast(error?.message || '提炼失败');
        await paint();
      }
    });
    host.querySelector('[data-disable-guidance]')?.addEventListener('click', async () => {
      if (!selectedIds.size || busy) return;
      await Promise.all([...selectedIds].map((id) => (
        setGuidanceMemoryStatus(id, GUIDANCE_STATUS_DISABLED)
      )));
      selectedIds.clear();
      showToast('已停用所选指导');
      await paint();
    });

    host.querySelectorAll('[data-edit-mem]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-edit-mem');
        const row = list.find((m) => m.id === id);
        if (!row) return;
        openTextEditorModal({
          title: '编辑指导记忆',
          value: row.content || '',
          multiline: true,
          confirmLabel: '保存',
          variant,
          onSave: async (text) => {
            try {
              await updateGuidanceMemory(id, text);
              showToast('已保存');
              await paint();
            } catch (err) {
              showToast(err?.message || '保存失败');
            }
          },
          onClosed: () => { paint().catch(() => {}); },
        });
      });
    });

    host.querySelectorAll('[data-pin-mem]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const row = list.find((item) => String(item.id) === String(btn.getAttribute('data-pin-mem')));
        if (!row) return;
        await setGuidanceMemoryPinned(row.id, row.guidancePinned !== true);
        await paint();
      });
    });
    host.querySelectorAll('[data-toggle-mem]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const row = list.find((item) => String(item.id) === String(btn.getAttribute('data-toggle-mem')));
        if (!row) return;
        await setGuidanceMemoryStatus(
          row.id,
          guidanceMemoryStatus(row) === GUIDANCE_STATUS_DISABLED
            ? GUIDANCE_STATUS_ACTIVE
            : GUIDANCE_STATUS_DISABLED,
        );
        await paint();
      });
    });
    host.querySelectorAll('[data-restore-mem]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await setGuidanceMemoryStatus(btn.getAttribute('data-restore-mem'), GUIDANCE_STATUS_ACTIVE);
        showToast('原指导已恢复并重新生效');
        await paint();
      });
    });

    host.querySelectorAll('[data-del-mem]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-del-mem');
        if (!id) return;
        try {
          await deleteGuidanceMemory(id);
          showToast('已删除');
          await paint();
        } catch (err) {
          showToast(err?.message || '删除失败');
        }
      });
    });
  }

  await paint();
}
