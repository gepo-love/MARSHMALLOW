import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { emptyIllustration } from '../components/scrapbook-illustrations.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { getCharacter } from '../core/character-store.js';
import { openShareCardModal } from '../components/share-card-export.js';
import { openTravelReelViewer } from '../components/travel-reel-viewer.js';
import { listTravelCharTrips, repairMissingTravelCollectibles } from '../core/travel-char.js';
import { markMemoryRegionSeen } from '../core/memory/memory-region-indicator.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(ts) {
  const n = Number(ts || 0);
  if (!n) return '';
  const d = new Date(n);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function formatTime(ts) {
  const n = Number(ts || 0);
  if (!n) return '';
  const d = new Date(n);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function noteLines(text = '', max = 4) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const explicit = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (explicit.length > 1) return explicit.slice(0, max);
  // 不用 lookbehind：iOS Safari < 16.4 会在 parseModule 阶段直接失败
  const chunks = raw.split(/([。！？!?；;]+)/);
  const parts = [];
  for (let i = 0; i < chunks.length; i += 2) {
    const line = `${chunks[i] || ''}${chunks[i + 1] || ''}`.trim();
    if (line) parts.push(line);
  }
  return (parts.length ? parts : [raw]).slice(0, max);
}

function checkpointTimestamp(trip, checkpoint) {
  return Number(trip.departAt || trip.createdAt || 0) + Number(checkpoint?.offsetMinutes || 0) * 60000;
}

// 一趟旅行里能贴出来的照片：途中每个节点拍到的实景照 + 归来时的那张明信片，按时间排好。
// 照片本身只是装饰/贴纸，真正撑起这一页的是 diaryLine——角色自己写的那一句随手日记；
// 节点没有 diaryLine（比如老数据）才退回拍照配文/状态卡正文。
function collectTripShots(trip) {
  const shots = [];
  for (const cp of Array.isArray(trip.checkpoints) ? trip.checkpoints : []) {
    if (cp?.capturedPhoto?.image) {
      shots.push({
        image: cp.capturedPhoto.image,
        tag: cp.placeName || cp.title || '',
        note: cp.diaryLine || cp.capturedPhoto.caption || cp.body || cp.collectibleHint || '',
        timestamp: checkpointTimestamp(trip, cp),
        isCover: false,
      });
    }
  }
  if (trip.postcard?.image) {
    shots.push({
      image: trip.postcard.image,
      tag: trip.postcard.title || trip.title || '',
      note: trip.postcard.albumNote || trip.postcard.summary || trip.returnSummary || '',
      timestamp: Number(trip.returnedAt || trip.updatedAt || trip.departAt || 0) || Date.now(),
      isCover: true,
    });
  }
  return shots.sort((a, b) => a.timestamp - b.timestamp);
}

// 3 张一组贴一页。最后一张 shot 是归来明信片（带总结），单独落在收尾页反而正合适——
// 那一页就是"结果页"：一张明信片 + 一大段角色总结，不需要硬凑照片数。
function chunkShots(shots, size = 3) {
  const chunks = [];
  for (let i = 0; i < shots.length; i += size) chunks.push(shots.slice(i, i + size));
  return chunks;
}

function pageDateLabel(chunk) {
  const stamps = chunk.map((s) => s.timestamp).filter(Boolean);
  if (!stamps.length) return '';
  const min = formatDate(Math.min(...stamps));
  const max = formatDate(Math.max(...stamps));
  return min === max ? min : `${min} ~ ${max}`;
}

// 逐句拼接时补一个句读，避免两句诗都自带标点时被拼成"。。"这种双标点。
function joinNotes(parts) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .map((part) => (/[。！？!?；;]$/.test(part) ? part : `${part}。`))
    .join('');
}

// 分享小卡用的整页文字：把这页每张照片旁的手写备注按顺序拼起来。
function pageDiaryLines(trip, chunk) {
  const cover = chunk.find((s) => s.isCover);
  if (cover?.note) return noteLines(cover.note);
  const merged = joinNotes(chunk.map((s) => s.note));
  if (merged) return noteLines(merged);
  const tags = chunk.map((s) => s.tag).filter(Boolean).join('、');
  return noteLines(tags ? `${tags}，就这么记一笔。` : `${trip.title || '这趟旅行'}，先记这一页。`);
}

// 把每趟旅行拆成若干"拼贴页"：同一趟旅行内新的先看，翻页往后是更早的节点。
function buildAlbumPages(trips) {
  const pages = [];
  trips.forEach((trip) => {
    const shots = collectTripShots(trip);
    if (!shots.length) return;
    const chunks = chunkShots(shots, 3).slice().reverse();
    chunks.forEach((chunk, idx) => {
      pages.push({
        trip,
        photos: chunk,
        diaryLines: pageDiaryLines(trip, chunk),
        dateLabel: pageDateLabel(chunk),
        pageNoInTrip: chunks.length - idx,
        pageCountInTrip: chunks.length,
      });
    });
  });
  return pages;
}

// 给每张照片按渲染顺序分配全局下标，供点开大图查看器时前后翻整本相册用。
function buildGallery(pages) {
  const gallery = [];
  let counter = 0;
  pages.forEach((page) => {
    page.photos.forEach((photo) => {
      photo.globalIndex = counter++;
      gallery.push({ src: photo.image, caption: photo.tag || page.trip.title, sub: formatDate(photo.timestamp) });
    });
  });
  return gallery;
}

// 之字形时间线：照片一行贴左、一行贴右往下走，手写备注写在照片旁的空位上，
// 地点名落在拍立得下方的白边里；行与行之间用一根手绘粗箭头从上一张指向下一张。
const POLAROID_TILTS = [-4, 3, -3];
const NOTE_TILTS = [1.2, -1, 0.8];

function polaroidHtml(photo, i) {
  return `
    <figure class="travel-polaroid${photo.isCover ? ' is-cover' : ''}" style="--p-tilt:${POLAROID_TILTS[i % POLAROID_TILTS.length]}deg;" data-album-photo="${photo.globalIndex}">
      <span class="travel-polaroid-tape" aria-hidden="true"></span>
      <div class="travel-polaroid-frame"><img src="${esc(photo.image)}" alt="" loading="lazy"></div>
      ${photo.tag ? `<figcaption>${esc(photo.tag)}</figcaption>` : ''}
    </figure>
  `;
}

// 两个方向的路线箭头：地图航线式的点状虚线弧 + 一个小箭头收尾，指右下或左下。
function arrowHtml(toRight) {
  return `
    <svg class="travel-flow-arrow ${toRight ? 'to-right' : 'to-left'}" viewBox="0 0 120 64" aria-hidden="true">
      <path class="travel-flow-arrow-dash" d="M12 6 C 48 8, 68 20, 86 44" />
      <path class="travel-flow-arrow-head" d="M76 44 l 12 3 -4 -12" />
    </svg>
  `;
}

// 一行 = 一张照片 + 旁边的手写备注。备注上方带一个小小的时间戳（像手账里随手记的钟点），
// 归来明信片那行的备注是整段总结，字块更大、配一枚图钉。
function flowRowHtml(photo, i) {
  const left = i % 2 === 0;
  const note = String(photo.note || '').trim();
  const lines = photo.isCover ? noteLines(note, 6) : noteLines(note, 3);
  const timeLabel = photo.isCover ? '' : formatTime(photo.timestamp);
  const noteHtml = lines.length ? `
    <div class="travel-flow-note${photo.isCover ? ' is-summary' : ''}" style="--n-tilt:${NOTE_TILTS[i % NOTE_TILTS.length]}deg;">
      ${photo.isCover ? '<span class="travel-flow-note-pin" aria-hidden="true"></span>' : ''}
      ${timeLabel ? `<span class="travel-flow-note-time">${timeLabel}</span>` : ''}
      ${lines.map((line) => `<p>${esc(line)}</p>`).join('')}
    </div>
  ` : '<div class="travel-flow-note is-blank" aria-hidden="true"></div>';
  return `
    <div class="travel-flow-row ${left ? 'is-left' : 'is-right'}">
      ${polaroidHtml(photo, i)}
      ${noteHtml}
    </div>
  `;
}

function albumPageHtml(page, index) {
  const isMulti = page.pageCountInTrip > 1;
  const rows = [];
  page.photos.forEach((photo, i) => {
    // 箭头从上一张照片所在的一侧出发，指向下一张照片那一侧。
    if (i > 0) rows.push(arrowHtml(i % 2 === 1));
    rows.push(flowRowHtml(photo, i));
  });
  return `
    <article class="travel-album-page ${index === 0 ? 'is-active' : ''}" data-album-page="${index}" style="--album-tilt:${index % 2 ? '0.7deg' : '-0.7deg'};">
      <div class="travel-album-paper">
        <div class="travel-album-page-head">
          <strong>${esc(page.trip.title || '旅行记忆')}</strong>
          <span class="travel-album-page-date">${esc(page.dateLabel)}${isMulti ? ` · ${page.pageNoInTrip}/${page.pageCountInTrip}` : ''}</span>
        </div>
        <div class="travel-album-flow" data-count="${page.photos.length}">
          ${rows.join('')}
        </div>
      </div>
    </article>
  `;
}

export default async function render(container, params = {}) {
  const user = await ensureDefaultUser();
  const characterId = String(params.character || '').trim();
  if (!characterId) {
    navigate('memory', {}, true);
    return;
  }
  const character = await getCharacter(characterId).catch(() => null);
  const titleName = character?.customNickname || character?.name || 'TA';
  await repairMissingTravelCollectibles(user.id, characterId).catch(() => null);
  markMemoryRegionSeen(user.id, characterId, 'travel');
  const trips = (await listTravelCharTrips(user.id, characterId).catch(() => []))
    .sort((a, b) => (
      Number(b.returnedAt || b.updatedAt || b.departAt || 0) - Number(a.returnedAt || a.updatedAt || a.departAt || 0)
    ));
  const pages = buildAlbumPages(trips);
  const galleryImages = buildGallery(pages);
  let currentPage = Math.max(0, Math.min(pages.length - 1, Number(params.page || 0) || 0));

  container.className = 'page memory-hall travel-album-page-wrap';
  function renderShell() {
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${esc(titleName)}的旅行相册</h1>
        <button type="button" class="navbar-btn" data-album-card ${pages.length ? '' : 'disabled'} aria-label="分享小卡">${icon('share')}</button>
      </header>
      <main class="memory-hall-scroll travel-album-scroll ${pages.length ? '' : 'is-empty'}">
        ${pages.length ? `
          <section class="travel-album-book" data-current-page="${currentPage}">
            <div class="travel-album-spine" aria-hidden="true"></div>
            ${pages.map(albumPageHtml).join('')}
          </section>
        ` : `
          <div class="chat-empty scrapbook-empty">
          ${emptyIllustration('memory')}
          <div class="chat-empty-text">还没有旅行照片</div>
          <div class="chat-empty-hint">旅行结束后，TA 带回的照片会放在这里</div>
          </div>
        `}
      </main>
      ${pages.length ? `
        <footer class="travel-album-controls">
          <button type="button" class="btn btn-soft" data-album-prev ${currentPage <= 0 ? 'disabled' : ''}>上一页</button>
          <span>${currentPage + 1} / ${pages.length}</span>
          <button type="button" class="btn btn-soft" data-album-next ${currentPage >= pages.length - 1 ? 'disabled' : ''}>下一页</button>
        </footer>
      ` : ''}
    `;
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelectorAll('[data-album-photo]').forEach((figureEl) => {
      figureEl.addEventListener('click', () => {
        const startIndex = Number(figureEl.getAttribute('data-album-photo')) || 0;
        openTravelReelViewer({ images: galleryImages, startIndex });
      });
    });
    const updatePage = (next) => {
      currentPage = Math.max(0, Math.min(pages.length - 1, next));
      container.querySelectorAll('[data-album-page]').forEach((page) => {
        page.classList.toggle('is-active', Number(page.getAttribute('data-album-page')) === currentPage);
      });
      const prev = container.querySelector('[data-album-prev]');
      const nextBtn = container.querySelector('[data-album-next]');
      const counter = container.querySelector('.travel-album-controls span');
      if (prev) prev.disabled = currentPage <= 0;
      if (nextBtn) nextBtn.disabled = currentPage >= pages.length - 1;
      if (counter) counter.textContent = `${currentPage + 1} / ${pages.length}`;
    };
    container.querySelector('[data-album-prev]')?.addEventListener('click', () => updatePage(currentPage - 1));
    container.querySelector('[data-album-next]')?.addEventListener('click', () => updatePage(currentPage + 1));
    container.querySelector('[data-album-card]')?.addEventListener('click', () => {
      const page = pages[currentPage];
      if (!page) return;
      const rep = page.photos.find((p) => p.isCover) || page.photos[0];
      openShareCardModal({
        title: page.trip.title || '旅行照片',
        subtitle: [titleName, page.dateLabel].filter(Boolean).join(' · '),
        fullText: page.diaryLines.join('\n'),
        image: rep?.image || '',
        imageHint: '旅行相册',
        footer: '旅行相册 · 棉花糖机',
        filenameBase: `travel-album-${page.trip.id || Date.now()}-${currentPage}`,
      });
    });
    updatePage(currentPage);
  }

  renderShell();
}
