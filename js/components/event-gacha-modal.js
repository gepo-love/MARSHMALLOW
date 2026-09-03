import { icon } from './svg-icons.js';
import { showToast } from './toast.js';
import {
  rollAllGachaTiles,
  buildSentenceFromTiles,
  rollGachaTile,
  buildGachaActorContext,
} from '../core/chat/event-gacha-roller.js';
import { persistActiveEvent } from '../core/chat/active-event.js';
import { GACHA_TILE_TYPES } from '../data/event-gacha-pools.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function openEventGachaModal({ chatId, chat = null, userName = '我', onInjected, onClosed } = {}) {
  const host = document.getElementById('modal-container');
  if (!host || !chatId) return;
  let actorContext = null;
  let sentenceDirty = false;
  let tiles = rollAllGachaTiles({ actorContext });
  let sentence = buildSentenceFromTiles(tiles);

  const roleAValue = () => tiles.find((t) => t.typeId === 'actor')?.value || '';

  const syncSentenceFromTiles = () => {
    if (!sentenceDirty) sentence = buildSentenceFromTiles(tiles);
  };

  /** 原地刷新某个磁贴输入框的值（不重建 DOM，避免闪烁） */
  const refreshTileInput = (typeId) => {
    const input = host.querySelector(`.event-gacha-tile-input[data-tile-type="${typeId}"]`);
    const tile = tiles.find((t) => t.typeId === typeId);
    if (input && tile && input.value !== (tile.value || '')) {
      input.value = tile.value || '';
    }
  };

  const refreshAllTileInputs = () => {
    tiles.forEach((t) => refreshTileInput(t.typeId));
  };

  /** 原地刷新事件描述文本框（仅在未手动编辑时） */
  const refreshSentenceField = () => {
    if (sentenceDirty) return;
    const ta = host.querySelector('.event-gacha-text');
    if (ta && ta.value !== sentence) ta.value = sentence;
  };

  const renderTiles = () => tiles.map((tile) => `
    <div class="event-gacha-tile" data-type="${esc(tile.typeId)}">
      <div class="event-gacha-tile-head">
        <span class="event-gacha-tile-label">${esc(tile.label)}</span>
        <button type="button" class="event-gacha-tile-reroll" data-reroll-type="${esc(tile.typeId)}" aria-label="重抽${esc(tile.label)}" title="重抽">${icon('reroll')}</button>
      </div>
      <input type="text" class="form-input event-gacha-tile-input" data-tile-type="${esc(tile.typeId)}" value="${esc(tile.value || '')}" placeholder="点击右侧重抽，或直接改">
    </div>
  `).join('');

  const paint = () => {
    host.innerHTML = `
      <div class="modal-overlay" data-gacha-overlay>
        <div class="modal-sheet scrapbook-card event-gacha-sheet" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>特殊事件扭蛋机</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-gacha-close aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body event-gacha-body">
            <p class="event-gacha-hint">角色来自通讯录与 NPC；若填了关系网，可能抽到「A 的上司 / 同事 / 老师」。磁贴可直接改字，右侧按钮单独重抽。</p>
            <div class="event-gacha-tiles">${renderTiles()}</div>
            <label class="api-field">
              <span class="api-field-label">事件描述</span>
              <textarea class="form-input event-gacha-text" rows="4">${esc(sentence)}</textarea>
            </label>
            <div class="event-gacha-actions">
              <button type="button" class="btn btn-outline btn-sm" data-gacha-resync>按磁贴重拼句</button>
              <button type="button" class="btn btn-outline btn-sm" data-gacha-reroll-all>全部重抽</button>
              <button type="button" class="btn btn-primary btn-sm" data-gacha-inject>加入当前聊天</button>
            </div>
          </div>
        </div>
      </div>
    `;
    bind();
  };

  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
    onClosed?.();
  };

  function bind() {
    host.querySelector('[data-gacha-overlay]')?.addEventListener('click', close);
    host.querySelector('[data-gacha-close]')?.addEventListener('click', close);
    host.querySelector('.event-gacha-sheet')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('.event-gacha-text')?.addEventListener('input', (e) => {
      sentence = String(e.target.value || '');
      sentenceDirty = true;
    });
    host.querySelectorAll('.event-gacha-tile-input').forEach((input) => {
      input.addEventListener('input', (e) => {
        const typeId = input.getAttribute('data-tile-type');
        const val = String(e.target.value || '');
        tiles = tiles.map((t) => (t.typeId === typeId ? { ...t, value: val } : t));
        syncSentenceFromTiles();
        refreshSentenceField();
      });
    });
    host.querySelectorAll('[data-reroll-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const typeId = btn.getAttribute('data-reroll-type');
        const next = rollGachaTile(typeId, {
          actorContext,
          roleAValue: typeId === 'actor' ? '' : roleAValue(),
        });
        tiles = tiles.map((t) => (t.typeId === typeId ? next : t));
        sentenceDirty = false;
        syncSentenceFromTiles();
        refreshTileInput(typeId);
        refreshSentenceField();
      });
    });
    host.querySelector('[data-gacha-resync]')?.addEventListener('click', () => {
      sentenceDirty = false;
      syncSentenceFromTiles();
      refreshSentenceField();
    });
    host.querySelector('[data-gacha-reroll-all]')?.addEventListener('click', () => {
      tiles = rollAllGachaTiles({ actorContext });
      sentenceDirty = false;
      syncSentenceFromTiles();
      refreshAllTileInputs();
      refreshSentenceField();
    });
    host.querySelector('[data-gacha-inject]')?.addEventListener('click', async () => {
      const text = String(host.querySelector('.event-gacha-text')?.value || '').trim();
      if (!text) {
        showToast('请先填写事件描述');
        return;
      }
      try {
        await persistActiveEvent(chatId, { text, variant: 'gacha' });
        showToast('特殊事件已加入');
        onInjected?.(text);
        close();
      } catch (err) {
        showToast(String(err?.message || err));
      }
    });
  }

  host.classList.add('active');
  paint();

  buildGachaActorContext({ chat, userName })
    .then((ctx) => {
      actorContext = ctx;
      if (!host.classList.contains('active')) return;
      tiles = rollAllGachaTiles({ actorContext });
      if (!sentenceDirty) {
        sentence = buildSentenceFromTiles(tiles);
        refreshAllTileInputs();
        refreshSentenceField();
      }
    })
    .catch(() => {});
}

export { GACHA_TILE_TYPES };
