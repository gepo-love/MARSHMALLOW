import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { getCharacter } from '../core/character-store.js';
import { emptyIllustration } from '../components/scrapbook-illustrations.js';
import {
  listCollectiblesForCharacter,
  listCollectiblesForUser,
  getCollectible,
} from '../core/collectibles.js';
import { COLLECTIBLE_SOURCES } from '../models/collectible.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cardHtml(item) {
  const own = item.ownership === 'shared' ? '共同' : 'TA';
  const src = COLLECTIBLE_SOURCES[item.source] || '收藏';
  const hint = item.iconAsset || item.image ? '' : (esc(item.theme) || src);
  return `
    <button type="button" class="space-card" data-id="${esc(item.id)}">
      <span class="space-card-photo">
        ${item.image ? `<img src="${esc(item.image)}" alt="">` : ''}
        ${hint ? `<span class="space-card-hint">${hint}</span>` : ''}
        <span class="space-card-own">${own}</span>
      </span>
      <span class="space-card-title">${esc(item.title)}</span>
      <span class="space-card-sub">${esc(item.summary || src)}</span>
    </button>`;
}

function openDetail(item) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const paras = String(item.body || item.summary || '')
    .split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`).join('');
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center" data-detail-overlay>
      <div class="modal-sheet scrapbook-card space-detail" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h3>${esc(item.title)}</h3>
          <button type="button" class="navbar-btn modal-close-btn space-detail-close" aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="modal-body space-detail-body">
          <div class="space-detail-meta">${esc(item.theme || (COLLECTIBLE_SOURCES[item.source] || '收藏'))} · ${item.ownership === 'shared' ? '共同回忆' : 'TA 的过往'}</div>
          ${item.image ? `<img class="space-detail-image" src="${esc(item.image)}" alt="">` : ''}
          ${paras || '<p class="text-hint">（无正文）</p>'}
        </div>
      </div>
    </div>`;
  const close = () => { host.classList.remove('active'); host.innerHTML = ''; };
  host.querySelector('[data-detail-overlay]')?.addEventListener('click', (e) => {
    if (e.target === host.querySelector('[data-detail-overlay]')) close();
  });
  host.querySelector('.space-detail-close')?.addEventListener('click', close);
}

export default async function render(container, params = {}) {
  const user = await ensureDefaultUser();
  const characterId = String(params.character || '').trim();

  let title = '收藏册';
  if (characterId) {
    const ch = await getCharacter(characterId).catch(() => null);
    const name = (ch && (ch.customNickname || ch.name)) || '角色';
    title = `${name} 的空间`;
  }

  const items = (characterId
    ? await listCollectiblesForCharacter(user.id, characterId)
    : await listCollectiblesForUser(user.id))
    .filter((item) => !['message_favorite', 'offline_favorite'].includes(String(item.source || '')));

  container.className = 'page scrapbook-page his-space-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${esc(title)}</h1>
      <button type="button" class="navbar-btn space-add" aria-label="去时光机">${icon('add') || '+'}</button>
    </header>
    <main class="space-scroll">
      <section class="space-section">
        <div class="space-section-head">
          <span class="space-section-tape" aria-hidden="true"></span>
          <div class="space-section-title">收藏册</div>
        </div>
        ${items.length ? `
          <div class="space-grid">${items.map(cardHtml).join('')}</div>
        ` : `
          <div class="space-empty">
            ${emptyIllustration('memory', 'space-empty-art')}
            <div class="space-empty-text">还没有收藏。去时光机收集 TA 的过往吧。</div>
            <button type="button" class="btn btn-primary space-empty-go">打开时光机</button>
          </div>
        `}
      </section>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  const goTm = () => navigate('encounter/time-machine', characterId ? { character: characterId } : {});
  container.querySelector('.space-add')?.addEventListener('click', goTm);
  container.querySelector('.space-empty-go')?.addEventListener('click', goTm);
  container.querySelectorAll('.space-card[data-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = await getCollectible(btn.getAttribute('data-id'));
      if (item) openDetail(item);
    });
  });
}
