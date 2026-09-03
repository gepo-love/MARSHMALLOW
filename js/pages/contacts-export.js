import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import { listCharacters } from '../core/character-store.js';
import { loadContactGroupsConfig, resolveCharacterGroupId } from '../core/contact-groups.js';
import {
  buildCharactersExportPayload,
  downloadCharactersExport,
  downloadSingleCharacterExport,
} from '../core/character-export.js';
import { shareToCommunityStore } from '../core/community-share-draft.js';
import {
  loadAppearancePrefs,
  getActiveTheme,
  isWindowHomeTheme,
  isSeaHomeTheme,
} from '../core/appearance-prefs.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sortByName(a, b) {
  return String(a?.name || '').localeCompare(String(b?.name || ''), 'zh');
}

export default async function render(container) {
  const [characters, groupConfig, prefs] = await Promise.all([
    listCharacters({ excludeAnonNpc: true }),
    loadContactGroupsConfig(),
    loadAppearancePrefs().catch(() => null),
  ]);
  const selectedIds = new Set();
  const byId = new Map(characters.map((character) => [character.id, character]));
  const knownGroupIds = new Set((groupConfig.groups || []).map((group) => group.id));
  const groups = (groupConfig.groups || []).map((group) => ({
    id: group.id,
    name: group.name,
    members: characters
      .filter((character) => resolveCharacterGroupId(character) === group.id)
      .sort(sortByName),
  })).filter((group) => group.members.length);
  const ungrouped = characters
    .filter((character) => !knownGroupIds.has(resolveCharacterGroupId(character)))
    .sort(sortByName);
  if (ungrouped.length) groups.push({ id: '__other__', name: '其他', members: ungrouped });

  let glassTheme = false;
  try {
    const active = getActiveTheme(prefs);
    glassTheme = isWindowHomeTheme(active.id, active.theme) || isSeaHomeTheme(active.id, active.theme);
  } catch (_) {
    glassTheme = false;
  }
  container.className = `page contacts-export-page${glassTheme ? ' contacts-export-page--glass' : ''}`;

  function groupSelectionState(members) {
    const count = members.reduce((sum, character) => sum + (selectedIds.has(character.id) ? 1 : 0), 0);
    if (!count) return 'none';
    if (count === members.length) return 'all';
    return 'some';
  }

  function renderGroup(group) {
    const selectionState = groupSelectionState(group.members);
    return `
      <section class="contact-export-group" data-export-group="${esc(group.id)}">
        <button type="button" class="contact-export-group-head" data-toggle-group="${esc(group.id)}" aria-pressed="${selectionState === 'all' ? 'true' : 'false'}">
          <span class="contact-export-check is-${selectionState}" aria-hidden="true">${selectionState === 'none' ? '' : (selectionState === 'all' ? icon('check') : '–')}</span>
          <span class="contact-export-group-name">${esc(group.name)}</span>
          <span class="contact-export-group-count">${group.members.length}</span>
          <span class="contact-export-group-action">${selectionState === 'all' ? '取消全选' : '全选'}</span>
        </button>
        <div class="contact-export-list">
          ${group.members.map((character) => {
            const selected = selectedIds.has(character.id);
            return `
              <button type="button" class="contact-export-row${selected ? ' is-selected' : ''}" data-toggle-character="${esc(character.id)}" aria-pressed="${selected ? 'true' : 'false'}">
                <span class="contact-export-avatar">${characterAvatarHtml(character, { className: 'dialer-avatar-img' })}</span>
                <span class="contact-export-name">${esc(character.name || '未命名')}</span>
                <span class="contact-export-check${selected ? ' is-all' : ' is-none'}" aria-hidden="true">${selected ? icon('check') : ''}</span>
              </button>
            `;
          }).join('')}
        </div>
      </section>
    `;
  }

  function paint({ preserveScroll = false } = {}) {
    const oldScroll = preserveScroll ? container.querySelector('.contacts-export-scroll')?.scrollTop || 0 : 0;
    const selectedCount = selectedIds.size;
    container.innerHTML = `
      <header class="navbar contacts-export-navbar">
        <button type="button" class="navbar-btn contact-export-back" aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">导出角色</h1>
        <span class="contact-export-nav-count">${selectedCount}/${characters.length}</span>
      </header>
      <main class="contacts-export-scroll">
        ${characters.length ? `
          <div class="contact-export-tools">
            <button type="button" class="contact-export-tool" data-select-all>全部选择</button>
            <button type="button" class="contact-export-tool" data-clear-all${selectedCount ? '' : ' disabled'}>清空</button>
          </div>
          <div class="contact-export-groups">${groups.map(renderGroup).join('')}</div>
        ` : `
          <div class="contact-export-empty">暂无可导出的角色</div>
        `}
      </main>
      <footer class="contact-export-footer">
        <button type="button" class="contact-export-share"${selectedCount ? '' : ' disabled'}>
          分享到应用商店
        </button>
        <button type="button" class="contact-export-submit"${selectedCount ? '' : ' disabled'}>
          ${selectedCount ? `导出 ${selectedCount} 位角色` : '选择要导出的角色'}
        </button>
      </footer>
    `;
    bindEvents();
    if (preserveScroll) {
      const scroll = container.querySelector('.contacts-export-scroll');
      if (scroll) scroll.scrollTop = oldScroll;
    }
  }

  function bindEvents() {
    container.querySelector('.contact-export-back')?.addEventListener('click', () => back());
    container.querySelector('[data-select-all]')?.addEventListener('click', () => {
      characters.forEach((character) => selectedIds.add(character.id));
      paint({ preserveScroll: true });
    });
    container.querySelector('[data-clear-all]')?.addEventListener('click', () => {
      selectedIds.clear();
      paint({ preserveScroll: true });
    });
    container.querySelectorAll('[data-toggle-group]').forEach((button) => {
      button.addEventListener('click', () => {
        const group = groups.find((item) => item.id === button.dataset.toggleGroup);
        if (!group) return;
        const allSelected = group.members.every((character) => selectedIds.has(character.id));
        group.members.forEach((character) => {
          if (allSelected) selectedIds.delete(character.id);
          else selectedIds.add(character.id);
        });
        paint({ preserveScroll: true });
      });
    });
    container.querySelectorAll('[data-toggle-character]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.dataset.toggleCharacter;
        if (!id) return;
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        paint({ preserveScroll: true });
      });
    });
    container.querySelector('.contact-export-submit')?.addEventListener('click', async () => {
      const selected = [...selectedIds].map((id) => byId.get(id)).filter(Boolean);
      if (!selected.length) return;
      const submit = container.querySelector('.contact-export-submit');
      if (submit) submit.disabled = true;
      try {
        if (selected.length === 1) await downloadSingleCharacterExport(selected[0]);
        else {
          const exportingAll = selected.length === characters.length;
          await downloadCharactersExport({
            characters: selected,
            includeGroups: true,
            groupIds: exportingAll
              ? undefined
              : [...new Set(selected.map((character) => resolveCharacterGroupId(character)))],
          });
        }
        showToast(`已导出 ${selected.length} 位角色`);
      } catch (error) {
        showToast(`导出失败：${error?.message || error}`);
      } finally {
        if (submit?.isConnected) submit.disabled = false;
      }
    });
    container.querySelector('.contact-export-share')?.addEventListener('click', async () => {
      const selected = [...selectedIds].map((id) => byId.get(id)).filter(Boolean);
      if (!selected.length) return;
      try {
        const payload = await buildCharactersExportPayload({
          characters: selected,
          includeGroups: true,
          groupIds: [...new Set(selected.map((character) => resolveCharacterGroupId(character)))],
        });
        shareToCommunityStore({
          source: payload,
          fileName: 'marshmallow-characters.json',
          resourceType: 'character-card',
          title: selected.length === 1 ? (selected[0].name || '角色卡') : `角色合集（${selected.length}位）`,
          originLabel: '角色导出',
        });
      } catch (error) {
        showToast(`无法分享：${error?.message || error}`);
      }
    });
  }

  paint();
}
