import { navigate, back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { getCharacter } from '../core/character-store.js';
import {
  loadMemoryWorkspace,
  countsForScope,
  pickMemoriesForScope,
  GLOBAL_SCOPE_ID,
} from '../core/memory/memory-scope.js';
import { memoryRegionUnseenState } from '../core/memory/memory-region-indicator.js';
import { listCollectiblesForCharacter } from '../core/collectibles.js';
import { listOfflineDateArchives } from '../core/offline-date-archive.js';
import { repairMissingTravelCollectibles } from '../core/travel-char.js';
import { listMessageFavorites } from '../core/message-favorites.js';
import { MEMORY_REGIONS, getMemoryIconSvg } from '../data/memory-layout.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bubbleText(count) {
  if (count == null) return '∞';
  if (count > 99) return '99+';
  return String(count);
}

export default async function render(container, params = {}) {
  const scopeId = String(params.character || '').trim();
  if (!scopeId) {
    navigate('memory', {}, true);
    return;
  }
  const user = await ensureDefaultUser();
  const isGlobal = scopeId === GLOBAL_SCOPE_ID;
  const ws = await loadMemoryWorkspace(user.id);
  const counts = countsForScope(ws, scopeId);
  const offlineArchives = isGlobal
    ? []
    : await listOfflineDateArchives(user.id, { characterId: scopeId }).catch(() => []);
  counts.offline = offlineArchives.length;
  counts.favorites = isGlobal
    ? 0
    : (await listMessageFavorites(user.id, scopeId).catch(() => [])).length;
  if (!isGlobal) await repairMissingTravelCollectibles(user.id, scopeId).catch(() => null);
  const travelCollectibles = isGlobal
    ? []
    : (await listCollectiblesForCharacter(user.id, scopeId).catch(() => []))
      .filter((item) => item.source === 'travel_char');
  const regions = MEMORY_REGIONS.filter((region) => {
    if (region.scope === 'character') return !isGlobal;
    if (region.scope === 'global') return isGlobal;
    return true;
  });
  const unseen = memoryRegionUnseenState({
    userId: user.id,
    scopeId,
    picked: pickMemoriesForScope(ws, scopeId),
    regionIds: [...regions.map((region) => region.id), 'travel'],
    offlineArchives,
    travelCollectibles,
  });

  let title = '全局 · 共享';
  if (scopeId !== GLOBAL_SCOPE_ID) {
    const ch = await getCharacter(scopeId).catch(() => null);
    const name = (ch && (ch.name || ch.customNickname)) || scopeId;
    title = `${name} 的记忆馆`;
  }

  container.className = 'page memory-hall';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${esc(title)}</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="memory-hall-scroll">
      <div class="memory-hall-grid ${scopeId !== GLOBAL_SCOPE_ID ? 'has-travel-album' : ''}">
        ${scopeId !== GLOBAL_SCOPE_ID ? `
          <button type="button" class="mh-cell tint-peach mh-wide mh-travel-album-cell" data-area="travel" data-travel-album aria-label="旅行相册${unseen.travel ? '，有新记忆' : ''}">
            <span class="mh-icon">${getMemoryIconSvg('journal')}</span>
            <span class="mh-text">
              <span class="mh-name">旅行相册</span>
              <span class="mh-hint">${travelCollectibles.length ? `${travelCollectibles.length} 张照片` : '等待第一张照片'}</span>
            </span>
            <span class="mh-bubble ${travelCollectibles.length ? '' : 'is-empty'}">${bubbleText(travelCollectibles.length)}</span>
            ${unseen.travel ? '<span class="mh-new-dot" aria-hidden="true"></span>' : ''}
          </button>
        ` : ''}
        ${regions.map((region) => {
          const count = counts[region.id];
          return `
            <button type="button" class="mh-cell ${region.tint} mh-${region.size}" data-area="${region.area}" data-region="${region.id}" aria-label="${region.name}${unseen[region.id] ? '，有新记忆' : ''}">
              <span class="mh-icon">${getMemoryIconSvg(region.icon)}</span>
              <span class="mh-text">
                <span class="mh-name">${region.name}</span>
                <span class="mh-hint">${region.hint}</span>
              </span>
              ${unseen[region.id] ? '<span class="mh-new-dot" aria-hidden="true"></span>' : ''}
            </button>
          `;
        }).join('')}
      </div>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  container.querySelector('[data-travel-album]')?.addEventListener('click', () => navigate('memory/travel-album', { character: scopeId }));
  container.querySelectorAll('[data-region]').forEach((cell) => {
    cell.addEventListener('click', () => {
      const region = cell.getAttribute('data-region');
      if (region) navigate('memory/region', { character: scopeId, region });
    });
  });
}
