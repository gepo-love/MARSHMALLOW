import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { primeDisplayRegex, applyDisplayRegex } from '../core/display-regex.js';
import {
  listNarrationArchive,
  deleteNarrationEntry,
  clearNarrationArchive,
  narrationKindLabel,
  mergeNarrationWithOfflineArchives,
  listHiddenOfflineNarrationIds,
  hideOfflineNarrationEntries,
} from '../core/narration-archive.js';
import { listOfflineDateArchives } from '../core/offline-date-archive.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SURFACE_BY_KIND = {
  offline: 'offline',
  time_machine: 'timemachine',
  au: 'autheater',
  storycard: 'storycard',
};

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function entryHtml(entry) {
  const surface = SURFACE_BY_KIND[entry.kind] || '';
  const cleaned = applyDisplayRegex(String(entry.text || ''), surface);
  const paras = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const meta = [entry.characterName, fmtTime(entry.createdAt)]
    .filter(Boolean).map(esc).join(' · ');
  return `
    <article class="narch-entry narch-card scrapbook-card" data-id="${esc(entry.id)}">
      <div class="narch-card-head" data-toggle="${esc(entry.id)}">
        <span class="narch-kind narch-kind--${esc(entry.kind)}">${esc(narrationKindLabel(entry.kind))}</span>
        <span class="narch-card-titles">
          <strong class="narch-entry-title">${esc(entry.title || '未命名')}</strong>
          ${entry.subtitle ? `<small class="narch-entry-sub">${esc(entry.subtitle)}</small>` : ''}
          ${meta ? `<small class="narch-card-meta">${meta}</small>` : ''}
        </span>
        <span class="narch-card-caret" aria-hidden="true">展开</span>
        <button type="button" class="narch-del" data-del="${esc(entry.id)}" aria-label="删除">✕</button>
      </div>
      <div class="narch-entry-body" hidden>
        ${entry.image ? `<img class="narch-entry-image" src="${esc(entry.image)}" alt="">` : ''}
        ${paras.map((p) => `<p>${esc(p)}</p>`).join('') || `<p>${esc(cleaned)}</p>`}
      </div>
    </article>`;
}

export default async function render(container) {
  const user = await ensureDefaultUser();
  await primeDisplayRegex();
  let offlineArchives = await listOfflineDateArchives(user.id).catch(() => []);
  let hiddenOfflineArchiveIds = await listHiddenOfflineNarrationIds(user.id).catch(() => []);
  let entries = mergeNarrationWithOfflineArchives(
    await listNarrationArchive(),
    offlineArchives,
    { hiddenOfflineArchiveIds },
  );

  container.className = 'page scrapbook-page narch-page';

  function paint() {
    const prevScroll = captureScrollerTop(container, '.narch-scroll');
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">原文档案</h1>
        ${entries.length ? '<button type="button" class="navbar-btn narch-clear" aria-label="清空">清空</button>' : '<span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>'}
      </header>
      <main class="narch-scroll">
        <p class="narch-hint">线下 / 时光机 / 番外 / 小剧场生成的完整原文都会自动留底，刷新也不丢。仅本机保存，最多 300 条。</p>
        ${entries.length
          ? entries.map(entryHtml).join('')
          : '<div class="narch-empty">还没有生成记录。去线下、时光机或番外里生成一段吧。</div>'}
      </main>
    `;
    restoreScrollerTop(container, '.narch-scroll', prevScroll);
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('.narch-clear')?.addEventListener('click', async () => {
      if (!window.confirm('清空全部原文档案？此操作不可恢复。')) return;
      hiddenOfflineArchiveIds = await hideOfflineNarrationEntries(
        user.id,
        offlineArchives.map((archive) => archive.id),
      );
      await clearNarrationArchive();
      entries = [];
      paint();
      showToast('已清空');
    });
    container.querySelectorAll('[data-toggle]').forEach((head) => {
      head.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]')) return;
        const card = head.closest('.narch-card');
        const body = card?.querySelector('.narch-entry-body');
        const caret = card?.querySelector('.narch-card-caret');
        if (!body) return;
        const open = body.hidden;
        body.hidden = !open;
        if (caret) caret.textContent = open ? '收起' : '展开';
        card.classList.toggle('is-open', open);
      });
    });
    container.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-del');
        const entry = entries.find((item) => item.id === id);
        const offlineArchiveId = String(entry?.meta?.offlineDateArchiveId || '').trim();
        if (offlineArchiveId) {
          hiddenOfflineArchiveIds = await hideOfflineNarrationEntries(user.id, [offlineArchiveId]);
        } else {
          await deleteNarrationEntry(id);
        }
        entries = entries.filter((en) => en.id !== id);
        paint();
      });
    });
  }

  paint();
}
