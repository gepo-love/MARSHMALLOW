/**
 * 小知识库 / 梗百科：轻量卡片式列表，不用世界书那套 book→group→item 树。
 * 条目存在同一个 worldBooks store 里（system: 'miniwiki'），注入时单独一个【小知识 / 梗】块。
 * 分组（kind: 'group' 的 worldBooks 行 + 条目的 groupId）只用来给列表分类、方便批量操作，
 * 不参与注入判断——注入仍然只看 scope/characterIds/关键词。
 */
import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { emptyIllustration } from '../components/scrapbook-illustrations.js';
import { bindSwipeActions } from '../components/swipe-actions.js';
import { showToast } from '../components/toast.js';
import {
  listAllWorldBookRows,
  saveWorldBookEntry,
  deleteWorldBookEntry,
  truncateWorldBookPreview,
} from '../core/world-book-store.js';
import { createWorldBookEntry } from '../models/worldbook.js';
import { listCharacters } from '../core/character-store.js';
import { loadContactGroupsConfig } from '../core/contact-groups.js';
import { loadRelationshipNetwork } from '../core/relationship-network.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scopeBadge(entry, characterNameById) {
  if (entry.scope === 'character') {
    const names = (entry.characterIds || [])
      .map((id) => characterNameById.get(id) || '')
      .filter(Boolean);
    if (!names.length) return '角色绑定';
    return names.length > 2 ? `${names.slice(0, 2).join('、')} 等${names.length}人` : names.join('、');
  }
  if (entry.scope === 'group') return '分组绑定';
  return '全局';
}

function formatUpdatedAt(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const d = new Date(n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function entryBadgesHtml(entry, characterNameById, groupNameById) {
  const tags = [scopeBadge(entry, characterNameById)];
  if (entry.groupId && groupNameById.has(entry.groupId)) tags.push(groupNameById.get(entry.groupId));
  if (entry.origin === 'ai_grown') {
    const dateStr = formatUpdatedAt(entry.updatedAt || entry.createdAt);
    tags.push(dateStr ? `AI 沉淀 · ${dateStr}` : 'AI 沉淀');
  }
  if (entry.enabled === false) tags.push('已关');
  return tags.map((t) => `<span class="wb-tag">${esc(t)}</span>`).join('');
}

export default async function render(container) {
  let [rows, characters, contactGroups, network] = await Promise.all([
    listAllWorldBookRows(),
    listCharacters({ excludeAnonNpc: true }),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
    loadRelationshipNetwork().catch(() => ({ circles: [] })),
  ]);
  let editing = null;
  let sheetMode = null; // null | 'edit' | 'groups' | 'batchCharacters' | 'batchGroup'
  let groupFilter = ''; // '' 全部 | 'none' 未分组 | groupId
  let batchMode = false;
  let batchSelectedIds = new Set();
  let unbindSwipe = () => {};

  container.className = 'page scrapbook-page worldbook-page mini-wiki-page';

  const characterNameById = () => new Map(characters.map((c) => [c.id, c.name || c.realName || c.id]));

  function wikiGroups() {
    return rows
      .filter((e) => e?.system === 'miniwiki' && e.kind === 'group')
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  }

  function wikiItems() {
    return rows.filter((e) => e?.system === 'miniwiki' && e.kind !== 'group');
  }

  function groupNameById() {
    return new Map(wikiGroups().map((g) => [g.id, g.name || '未命名分组']));
  }

  function wikiEntries() {
    const items = wikiItems();
    const filtered = groupFilter === '' ? items
      : groupFilter === 'none' ? items.filter((e) => !e.groupId)
        : items.filter((e) => e.groupId === groupFilter);
    return filtered.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  }

  async function reload() {
    [rows, characters] = await Promise.all([
      listAllWorldBookRows(),
      listCharacters({ excludeAnonNpc: true }),
    ]);
    paint();
  }

  function closeSheet() {
    editing = null;
    sheetMode = null;
  }

  function groupOptionsHtml(entry) {
    const selected = `${entry?.groupType || ''}:${entry?.groupRefId || ''}`;
    const contactOpts = (contactGroups.groups || []).map((g) => {
      const val = `contact:${g.id}`;
      return `<option value="${esc(val)}" ${selected === val ? 'selected' : ''}>通讯录 · ${esc(g.name)}</option>`;
    });
    const circleOpts = (network.circles || []).map((c) => {
      const val = `relationship:${c.id}`;
      return `<option value="${esc(val)}" ${selected === val ? 'selected' : ''}>关系圈 · ${esc(c.name)}</option>`;
    });
    return [...contactOpts, ...circleOpts].join('') || '<option value="">（还没有分组或关系圈）</option>';
  }

  function sheetBodyHtml(entry) {
    const nameById = characterNameById();
    const boundIds = new Set(entry?.characterIds || []);
    const groups = wikiGroups();
    return `
      <label class="wb-field">
        <span>名称</span>
        <input type="text" class="form-input mw-input-name" value="${esc(entry?.name || '')}" maxlength="60" placeholder="例如：某个梗 / 某部作品" />
      </label>
      <label class="wb-field">
        <span>触发关键词（逗号分隔）</span>
        <input type="text" class="form-input mw-input-keys" value="${esc((entry?.keys || []).join('，'))}" placeholder="聊天里出现这些词才注入" />
      </label>
      <label class="wb-field">
        <span>内容</span>
        <textarea class="form-input mw-input-content" rows="8" placeholder="这个梗/知识是什么、圈内怎么聊它（建议 300 字以内）">${esc(entry?.content || '')}</textarea>
      </label>
      <label class="wb-field">
        <span>知识分组</span>
        <select class="form-input mw-input-group-id">
          <option value="">不分组</option>
          ${groups.map((g) => `<option value="${esc(g.id)}" ${entry?.groupId === g.id ? 'selected' : ''}>${esc(g.name || '未命名分组')}</option>`).join('')}
        </select>
      </label>
      <label class="wb-field">
        <span>生效范围</span>
        <select class="form-input mw-input-scope">
          <option value="global" ${!entry?.scope || entry.scope === 'global' ? 'selected' : ''}>全局</option>
          <option value="character" ${entry?.scope === 'character' ? 'selected' : ''}>绑定角色</option>
          <option value="group" ${entry?.scope === 'group' ? 'selected' : ''}>绑定分组 / 关系圈</option>
        </select>
      </label>
      <div class="wb-character-bindings" data-mw-character-bindings ${entry?.scope === 'character' ? '' : 'hidden'}>
        ${characters.length ? characters.map((char) => `
          <label class="wb-character-check">
            <input type="checkbox" data-mw-character-id="${esc(char.id)}" ${boundIds.has(char.id) ? 'checked' : ''} />
            <span>${esc(nameById.get(char.id) || char.id)}</span>
          </label>
        `).join('') : '<p class="wb-sheet-note">暂无角色</p>'}
      </div>
      <label class="wb-field" data-mw-group-binding ${entry?.scope === 'group' ? '' : 'hidden'}>
        <span>选择分组</span>
        <select class="form-input mw-input-group">${groupOptionsHtml(entry)}</select>
      </label>
    `;
  }

  function groupManagerBodyHtml(groups) {
    return `
      <div class="mw-group-manage-list">
        ${groups.length ? groups.map((g) => `
          <div class="library-swipe-row mw-group-manage-row" data-swipe-row>
            <div class="library-swipe-actions" data-swipe-actions>
              <button type="button" class="library-swipe-action is-danger" data-group-delete="${esc(g.id)}" aria-label="删除分组 ${esc(g.name || '未命名分组')}">删除</button>
            </div>
            <div class="library-swipe-content" data-swipe-content>
              <input type="text" class="form-input mw-group-name-input" data-group-name-id="${esc(g.id)}" value="${esc(g.name || '')}" maxlength="24" />
              <button type="button" class="mw-group-delete-btn" data-group-delete="${esc(g.id)}" aria-label="删除分组 ${esc(g.name || '未命名分组')}">删除</button>
            </div>
          </div>
        `).join('') : '<p class="wb-sheet-note">还没有分组</p>'}
      </div>
      <div class="mw-group-add-row">
        <input type="text" class="form-input mw-group-add-input" maxlength="24" placeholder="新建分组名称" />
        <button type="button" class="btn btn-primary btn-sm" data-group-add>添加</button>
      </div>
    `;
  }

  function batchCharacterBodyHtml(nameById) {
    return `
      <p class="wb-sheet-note">对已选的 ${batchSelectedIds.size} 条知识生效：勾选的角色在各自原有绑定基础上新增，不会覆盖原有角色。</p>
      <div class="wb-character-bindings">
        ${characters.length ? characters.map((char) => `
          <label class="wb-character-check">
            <input type="checkbox" data-batch-character-id="${esc(char.id)}" />
            <span>${esc(nameById.get(char.id) || char.id)}</span>
          </label>
        `).join('') : '<p class="wb-sheet-note">暂无角色</p>'}
      </div>
    `;
  }

  function batchGroupBodyHtml(groups) {
    return `
      <p class="wb-sheet-note">对已选的 ${batchSelectedIds.size} 条知识生效</p>
      <div class="mw-group-pick-list">
        <label class="mw-group-pick-row">
          <input type="radio" name="batch-group-pick" value="" checked />
          <span>不分组</span>
        </label>
        ${groups.map((g) => `
          <label class="mw-group-pick-row">
            <input type="radio" name="batch-group-pick" value="${esc(g.id)}" />
            <span>${esc(g.name || '未命名分组')}</span>
          </label>
        `).join('')}
      </div>
    `;
  }

  function paint() {
    unbindSwipe();
    unbindSwipe = () => {};
    const prevScrollTop = container.querySelector('.wb-scroll')?.scrollTop || 0;
    const list = wikiEntries();
    const nameById = characterNameById();
    const groups = wikiGroups();
    const groupNames = groupNameById();
    const ungroupedCount = wikiItems().filter((e) => !e.groupId).length;
    const persisted = !!editing?.id && rows.some((e) => e.id === editing.id);

    let sheetTitleText = '';
    let sheetBody = '';
    let sheetFoot = '';
    if (sheetMode === 'edit') {
      sheetTitleText = persisted ? '编辑条目' : '新建条目';
      sheetBody = editing ? sheetBodyHtml(editing) : '';
      sheetFoot = `
        <button type="button" class="btn btn-primary" data-save-entry>保存</button>
      `;
    } else if (sheetMode === 'groups') {
      sheetTitleText = '管理知识分组';
      sheetBody = groupManagerBodyHtml(groups);
      sheetFoot = '<button type="button" class="btn btn-primary" data-close-sheet>完成</button>';
    } else if (sheetMode === 'batchCharacters') {
      sheetTitleText = '批量绑定角色';
      sheetBody = batchCharacterBodyHtml(nameById);
      sheetFoot = `
        <button type="button" class="btn btn-soft" data-close-sheet>取消</button>
        <button type="button" class="btn btn-primary" data-batch-characters-confirm>确认绑定</button>
      `;
    } else if (sheetMode === 'batchGroup') {
      sheetTitleText = '批量移到分组';
      sheetBody = batchGroupBodyHtml(groups);
      sheetFoot = `
        <button type="button" class="btn btn-soft" data-close-sheet>取消</button>
        <button type="button" class="btn btn-primary" data-batch-group-confirm>确认移动</button>
      `;
    }
    const sheetOpen = sheetMode !== null;

    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">梗百科 · 小知识</h1>
        <button type="button" class="navbar-btn" data-add aria-label="新建">${icon('plus')}</button>
      </header>
      <div class="mw-toolbar">
        <div class="mw-group-tabs">
          <button type="button" class="mw-group-tab ${groupFilter === '' ? 'is-active' : ''}" data-group-filter="">全部</button>
          ${groups.map((g) => `<button type="button" class="mw-group-tab ${groupFilter === g.id ? 'is-active' : ''}" data-group-filter="${esc(g.id)}">${esc(g.name || '未命名分组')}</button>`).join('')}
          ${ungroupedCount ? `<button type="button" class="mw-group-tab ${groupFilter === 'none' ? 'is-active' : ''}" data-group-filter="none">未分组</button>` : ''}
        </div>
        <div class="mw-toolbar-actions">
          <button type="button" class="mw-toolbar-icon-btn" data-open-groups aria-label="管理分组" title="管理分组">${icon('folder')}</button>
          <button type="button" class="mw-toolbar-icon-btn ${batchMode ? 'is-active' : ''}" data-toggle-batch aria-label="批量选择" title="批量选择">${icon('select')}</button>
        </div>
      </div>
      ${batchMode ? `
        <div class="mw-batch-actions">
          <span class="mw-batch-count">已选 ${batchSelectedIds.size} 条</span>
          <button type="button" class="btn btn-outline btn-sm" data-batch-group ${batchSelectedIds.size ? '' : 'disabled'}>移到分组</button>
          <button type="button" class="btn btn-primary btn-sm" data-batch-characters ${batchSelectedIds.size ? '' : 'disabled'}>绑定角色</button>
          <button type="button" class="btn btn-soft btn-sm" data-batch-cancel>取消</button>
        </div>
      ` : ''}
      <main class="wb-scroll scrapbook-scroll">
        ${list.length ? list.map((entry) => `
          <section class="mw-card scrapbook-card library-swipe-row ${batchMode ? 'is-batch' : ''} ${batchSelectedIds.has(entry.id) ? 'is-selected' : ''} ${entry.enabled === false ? 'is-off' : ''}" ${batchMode ? '' : 'data-swipe-row'} data-entry-id="${esc(entry.id)}">
            ${batchMode ? '' : `<div class="library-swipe-actions" data-swipe-actions>
              <button type="button" class="library-swipe-action is-danger" data-entry-delete="${esc(entry.id)}" aria-label="删除条目 ${esc(entry.name || '未命名')}">删除</button>
            </div>`}
            <div class="${batchMode ? 'mw-card-batch-content' : 'library-swipe-content'}" ${batchMode ? '' : 'data-swipe-content'}>
            ${batchMode ? `<span class="mw-card-check-ui" aria-hidden="true">${batchSelectedIds.has(entry.id) ? icon('check') : ''}</span>` : ''}
            <button type="button" class="mw-card-main" data-card-id="${esc(entry.id)}">
              <span class="mw-card-name">${esc(entry.name || '未命名')}</span>
              ${(entry.keys || []).length ? `<span class="mw-card-keys">${esc(entry.keys.join(' · '))}</span>` : ''}
              <span class="mw-card-preview">${esc(truncateWorldBookPreview(entry.content, 90))}</span>
              <span class="wb-item-tags">${entryBadgesHtml(entry, nameById, groupNames)}</span>
            </button>
            ${batchMode ? '' : `
              <label class="wb-toggle" title="启用">
                <input type="checkbox" data-enable-id="${esc(entry.id)}" ${entry.enabled !== false ? 'checked' : ''} aria-label="启用 ${esc(entry.name || '条目')}" />
                <span class="wb-toggle-ui"></span>
              </label>
            `}
            </div>
          </section>
        `).join('') : `
          <div class="chat-empty scrapbook-empty">
            ${emptyIllustration('book')}
            <div class="chat-empty-text">${groupFilter ? '这个分组还没有条目' : '还没有小知识条目'}</div>
            ${groupFilter ? '' : '<button type="button" class="btn btn-primary" data-add>新建一条</button>'}
          </div>
        `}
      </main>
      <aside class="wb-sheet ${sheetOpen ? 'is-open' : ''}" aria-hidden="${sheetOpen ? 'false' : 'true'}">
        <div class="wb-sheet-backdrop" data-close-sheet></div>
        <div class="wb-sheet-panel scrapbook-card">
          <header class="wb-sheet-head">
            <h2>${esc(sheetTitleText)}</h2>
            <button type="button" class="navbar-btn" data-close-sheet aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="wb-sheet-body">
            ${sheetBody}
          </div>
          <footer class="wb-sheet-foot">
            ${sheetFoot}
          </footer>
        </div>
      </aside>
    `;
    bindEvents();
    if (!batchMode) {
      unbindSwipe = bindSwipeActions(container);
    }
    const scrollEl = container.querySelector('.wb-scroll');
    if (scrollEl && prevScrollTop) scrollEl.scrollTop = prevScrollTop;
    if (sheetMode === 'edit') container.querySelector('.mw-input-name')?.focus();
  }

  function bindEvents() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());

    container.querySelectorAll('[data-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editing = createWorldBookEntry({
          kind: 'item',
          system: 'miniwiki',
          selective: true,
          origin: 'user',
          groupId: groupFilter && groupFilter !== 'none' ? groupFilter : '',
        });
        sheetMode = 'edit';
        paint();
      });
    });

    container.querySelectorAll('[data-group-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        groupFilter = btn.getAttribute('data-group-filter') || '';
        paint();
      });
    });

    container.querySelector('[data-open-groups]')?.addEventListener('click', () => {
      sheetMode = 'groups';
      paint();
    });

    container.querySelector('[data-toggle-batch]')?.addEventListener('click', () => {
      batchMode = !batchMode;
      batchSelectedIds = new Set();
      paint();
    });

    container.querySelector('[data-batch-cancel]')?.addEventListener('click', () => {
      batchMode = false;
      batchSelectedIds = new Set();
      paint();
    });

    container.querySelector('[data-batch-group]')?.addEventListener('click', () => {
      if (!batchSelectedIds.size) return;
      sheetMode = 'batchGroup';
      paint();
    });

    container.querySelector('[data-batch-characters]')?.addEventListener('click', () => {
      if (!batchSelectedIds.size) return;
      sheetMode = 'batchCharacters';
      paint();
    });

    container.querySelectorAll('[data-card-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-card-id');
        if (batchMode) {
          if (batchSelectedIds.has(id)) batchSelectedIds.delete(id);
          else batchSelectedIds.add(id);
          paint();
          return;
        }
        const entry = rows.find((e) => e.id === id);
        if (entry) {
          editing = { ...entry };
          sheetMode = 'edit';
          paint();
        }
      });
    });

    container.querySelectorAll('[data-enable-id]').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.getAttribute('data-enable-id');
        const entry = rows.find((e) => e.id === id);
        if (!entry) return;
        await saveWorldBookEntry({ ...entry, enabled: input.checked });
        await reload();
      });
    });

    container.querySelector('.mw-input-scope')?.addEventListener('change', (ev) => {
      const scope = ev.target.value;
      const charBind = container.querySelector('[data-mw-character-bindings]');
      const groupBind = container.querySelector('[data-mw-group-binding]');
      if (charBind) charBind.hidden = scope !== 'character';
      if (groupBind) groupBind.hidden = scope !== 'group';
    });

    container.querySelectorAll('[data-close-sheet]').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeSheet();
        paint();
      });
    });

    container.querySelector('[data-save-entry]')?.addEventListener('click', async () => {
      if (!editing) return;
      const name = String(container.querySelector('.mw-input-name')?.value || '').trim();
      const content = String(container.querySelector('.mw-input-content')?.value || '').trim();
      if (!name) { showToast('请填写名称'); return; }
      if (!content) { showToast('请填写内容'); return; }
      const keys = String(container.querySelector('.mw-input-keys')?.value || '')
        .split(/[,，]/).map((k) => k.trim()).filter(Boolean);
      const groupId = String(container.querySelector('.mw-input-group-id')?.value || '').trim();
      const scope = String(container.querySelector('.mw-input-scope')?.value || 'global');
      const characterIds = scope === 'character'
        ? [...container.querySelectorAll('[data-mw-character-id]:checked')]
          .map((el) => String(el.getAttribute('data-mw-character-id') || '').trim())
          .filter(Boolean)
        : [];
      let groupType = '';
      let groupRefId = '';
      if (scope === 'group') {
        const [type, ...rest] = String(container.querySelector('.mw-input-group')?.value || '').split(':');
        groupType = ['contact', 'relationship'].includes(type) ? type : '';
        groupRefId = rest.join(':');
        if (!groupType || !groupRefId) { showToast('请选择一个分组'); return; }
      }
      await saveWorldBookEntry({
        ...editing,
        name,
        content,
        keys,
        groupId,
        scope: ['character', 'group'].includes(scope) ? scope : 'global',
        characterIds,
        groupType,
        groupRefId,
        selective: keys.length > 0,
        constant: false,
        kind: 'item',
        system: 'miniwiki',
      });
      closeSheet();
      showToast('已保存');
      await reload();
    });

    container.querySelectorAll('[data-entry-delete]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-entry-delete');
      const entry = rows.find((row) => row.id === id);
      if (!entry) return;
      if (!window.confirm('确定删除该条目？此操作不可恢复。')) return;
      await deleteWorldBookEntry(entry.id);
      showToast('已删除');
      await reload();
    }));

    container.querySelectorAll('[data-group-name-id]').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.getAttribute('data-group-name-id');
        const group = rows.find((e) => e.id === id);
        const name = String(input.value || '').trim();
        if (!name) { showToast('分组名称不能为空'); input.value = group?.name || ''; return; }
        if (!group) return;
        await saveWorldBookEntry({ ...group, name });
        await reload();
      });
    });

    container.querySelectorAll('[data-group-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-group-delete');
        if (!window.confirm('确定删除该分组？分组下的条目会变成未分组，不会被删除。')) return;
        const members = rows.filter((e) => e?.system === 'miniwiki' && e.groupId === id);
        await Promise.all(members.map((e) => saveWorldBookEntry({ ...e, groupId: '' })));
        await deleteWorldBookEntry(id);
        if (groupFilter === id) groupFilter = '';
        showToast('已删除分组');
        await reload();
      });
    });

    container.querySelector('[data-group-add]')?.addEventListener('click', async () => {
      const input = container.querySelector('.mw-group-add-input');
      const name = String(input?.value || '').trim();
      if (!name) { showToast('请输入分组名称'); return; }
      await saveWorldBookEntry(createWorldBookEntry({ kind: 'group', system: 'miniwiki', name, selective: false, constant: false }));
      showToast('已添加分组');
      await reload();
    });

    container.querySelector('[data-batch-characters-confirm]')?.addEventListener('click', async () => {
      const pickedIds = [...container.querySelectorAll('[data-batch-character-id]:checked')]
        .map((el) => String(el.getAttribute('data-batch-character-id') || '').trim())
        .filter(Boolean);
      if (!pickedIds.length) { showToast('请至少选一个角色'); return; }
      const targets = rows.filter((e) => batchSelectedIds.has(e.id));
      await Promise.all(targets.map((entry) => {
        const existingIds = entry.scope === 'character' ? (entry.characterIds || []) : [];
        const merged = [...new Set([...existingIds, ...pickedIds])];
        return saveWorldBookEntry({ ...entry, scope: 'character', characterIds: merged, groupType: '', groupRefId: '' });
      }));
      showToast(`已为 ${targets.length} 条知识绑定角色`);
      closeSheet();
      batchMode = false;
      batchSelectedIds = new Set();
      await reload();
    });

    container.querySelector('[data-batch-group-confirm]')?.addEventListener('click', async () => {
      const picked = container.querySelector('input[name="batch-group-pick"]:checked')?.value || '';
      const targets = rows.filter((e) => batchSelectedIds.has(e.id));
      await Promise.all(targets.map((entry) => saveWorldBookEntry({ ...entry, groupId: picked })));
      showToast(`已移动 ${targets.length} 条知识`);
      closeSheet();
      batchMode = false;
      batchSelectedIds = new Set();
      await reload();
    });
  }

  paint();
}
