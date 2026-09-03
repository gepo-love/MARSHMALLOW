import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { characterAvatarHtml, emptyIllustration } from '../components/scrapbook-illustrations.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { captureElementScrollState, restoreElementScrollState } from '../core/scroll-state.js';
import { listCharacters, getCharacter } from '../core/character-store.js';
import { openOptionPicker } from '../components/option-picker.js';
import { openChatRowSheet } from '../components/chat-row-sheet.js';
import { openTravelReelViewer } from '../components/travel-reel-viewer.js';
import { bindCommitSearch } from '../components/search-field.js';
import {
  TRAVEL_THEME_PRESETS,
  TRAVEL_THEME_CATEGORIES,
  cancelTravelCharTrip,
  deleteTravelCharTrip,
  getCharacterTravelCity,
  listTravelCharTrips,
  listTravelCharNotifications,
  listPostcardStyleOptions,
  markTravelCharNotificationRead,
  scanTravelCharNotifications,
  syncTravelCharTrips,
} from '../core/travel-char.js';
import { getRoleTierLabel } from '../models/character.js';
import { getUserDisplayName } from '../models/user.js';

const SHOWCASE_INTERVAL_MS = 4200;
const SHOWCASE_MAX_SHOTS = 12;

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function themeCategoryGroups() {
  const allIds = Object.keys(TRAVEL_THEME_PRESETS);
  return TRAVEL_THEME_CATEGORIES
    .map((cat) => ({ ...cat, themeIds: allIds.filter((id) => TRAVEL_THEME_PRESETS[id]?.category === cat.id && !TRAVEL_THEME_PRESETS[id]?.hidden) }))
    .filter((cat) => cat.themeIds.length);
}

// 每个分组默认只露前 2 个主题，剩下的收进「更多主题」，避免一次性铺 15 个按钮。
const THEME_GROUP_PREVIEW_COUNT = 2;

function charSub(char) {
  return [getRoleTierLabel(char.roleTier), char.customNickname || char.currentRole]
    .filter(Boolean)
    .join(' · ');
}

function tripMeta(trip) {
  const preset = TRAVEL_THEME_PRESETS[trip.theme] || {};
  const names = Array.isArray(trip.characterNames) ? trip.characterNames.join('、') : '';
  const status = trip.status === 'away'
    ? (trip.decision?.statusText || `${preset.label || '旅行'}中`)
    : trip.status === 'returned'
      ? '已带回'
      : trip.status === 'terminated'
        ? '已终止'
        : trip.status === 'cancelled'
          ? '未出发'
          : '准备中';
  return [names, status].filter(Boolean).join(' · ');
}

// 首页展示台的胶片素材：跨所有旅行汇总明信片 + 途中实拍照，按时间从新到旧排列。
function showcaseImages(trips = []) {
  const items = [];
  trips
    .slice()
    .sort((a, b) => Number(b.returnedAt || b.departAt || b.createdAt || 0) - Number(a.returnedAt || a.departAt || a.createdAt || 0))
    .forEach((trip) => {
      const preset = TRAVEL_THEME_PRESETS[trip.theme] || {};
      if (trip.postcard?.image) {
        items.push({
          src: trip.postcard.image,
          caption: trip.postcard.title || preset.label || trip.title || '旅行',
          sub: '归来明信片',
        });
      }
      (trip.checkpoints || []).slice().reverse().forEach((cp) => {
        if (cp.capturedPhoto?.image) {
          items.push({
            src: cp.capturedPhoto.image,
            caption: cp.placeName || cp.title || preset.label || trip.title || '旅行',
            sub: Number(cp.dayIndex) > 0 ? `第 ${Number(cp.dayIndex) + 1} 天` : '',
          });
        }
      });
    });
  return items.slice(0, SHOWCASE_MAX_SHOTS);
}

function latestCheckpointText(trip) {
  if (trip.status === 'returned') return trip.postcard?.summary || trip.returnSummary || '带回了一点今天的痕迹';
  if (trip.status === 'terminated') return '这趟旅行被中途叫停了';
  if (trip.status === 'cancelled') return trip.decision?.reason || 'TA 这次没有出发';
  const now = Date.now();
  const depart = Number(trip.departAt || trip.createdAt || now) || now;
  const unlocked = (trip.checkpoints || [])
    .filter((cp) => depart + Number(cp.offsetMinutes || 0) * 60000 <= now)
    .slice(-1)[0];
  return unlocked?.body || trip.decision?.reply || '正在路上';
}

export default async function render(container, params = {}) {
  container.className = 'page scrapbook-page travel-char-page';
  container.innerHTML = `
    <div class="page-skeleton travel-char-skeleton" aria-hidden="true">
      <div class="sk-row"><span class="sk-block sk-bar" style="width:32%"></span></div>
      <span class="sk-block" style="height:min(52vh,360px);border-radius:18px"></span>
      <div class="sk-row" style="margin-top:auto"><span class="sk-block sk-bar" style="width:40%"></span><span class="sk-block sk-bar" style="width:40%"></span></div>
    </div>`;

  const [user, characterRows] = await Promise.all([
    ensureDefaultUser(),
    listCharacters({ excludeAnonNpc: true }),
  ]);
  const userName = getUserDisplayName(user);
  let characters = (characterRows || []).slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));

  async function reloadCharacters() {
    const rows = await listCharacters({ excludeAnonNpc: true }).catch(() => []);
    characters = (rows || []).slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  }

  let selectedId = String(params.character || params.characterId || '').trim();
  if (selectedId && !characters.some((char) => char.id === selectedId)) selectedId = '';

  // 主题留空 = 随机（交给核心模块按人设加权抽），不再强制默认成"观鸟"。
  let selectedTheme = String(params.theme || '').trim();
  if (selectedTheme && !TRAVEL_THEME_PRESETS[selectedTheme]) selectedTheme = '';

  const state = {
    query: '',
    selectedIds: new Set(selectedId ? [selectedId] : []),
    lengthMode: 'quick',
    durationDays: 3,
    showMoreThemes: false,
    showCharacter: false,
    imageStyle: '',
    styleId: '',
    allowPeople: false,
    autoImageAllNodes: false,
    styleSuffix: '',
    destination: '',
    trips: [],
    notifications: [],
    synced: 0,
    sheet: selectedId ? 'create' : null,
    showcaseIndex: 0,
  };

  container.className = 'page scrapbook-page travel-char-page';
  let autoplayTimer = null;
  let lastSheet = null;

  function stopShowcaseAutoplay() {
    if (autoplayTimer) {
      clearTimeout(autoplayTimer);
      autoplayTimer = null;
    }
  }

  function scheduleShowcaseAutoplay(shots) {
    stopShowcaseAutoplay();
    if (state.sheet || shots.length < 2 || prefersReducedMotion()) return;
    autoplayTimer = setTimeout(() => {
      if (!container.isConnected) return;
      state.showcaseIndex = (state.showcaseIndex + 1) % shots.length;
      paint();
    }, SHOWCASE_INTERVAL_MS);
  }

  async function refreshTrips() {
    state.trips = await listTravelCharTrips(user.id).catch(() => []);
    const awayCharIds = [...new Set(
      state.trips
        .filter((trip) => trip.status === 'away')
        .flatMap((trip) => (Array.isArray(trip.characterIds) ? trip.characterIds : []))
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    )];
    let synced = 0;
    if (awayCharIds.length) {
      const targets = characters.filter((char) => awayCharIds.includes(char.id));
      const results = await Promise.all(
        targets.map((char) => syncTravelCharTrips({ userId: user.id, characterId: char.id }).catch(() => null)),
      );
      synced = results.reduce((sum, result) => sum + (Number(result?.finished || 0) || 0), 0);
    }
    await scanTravelCharNotifications({ userId: user.id, user }).catch(() => null);
    state.synced = synced;
    state.trips = await listTravelCharTrips(user.id).catch(() => []);
    state.notifications = await listTravelCharNotifications(user.id, { unreadOnly: true }).catch(() => []);
  }

  function goShowcase(delta, shots) {
    if (!shots.length) return;
    state.showcaseIndex = (state.showcaseIndex + delta + shots.length) % shots.length;
    paint();
  }

  // 展示台大图既能点按前进，也能左右滑动切图（右滑=上一张，左滑=下一张）；
  // 用同一个函数统一处理点击和滑动，避免滑动结束后触发的合成 click 事件重复前进一次。
  function bindShowcaseFrame(frame, shots) {
    if (!frame) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let swiped = false;
    frame.addEventListener('touchstart', (e) => {
      if (shots.length < 2 || !e.touches?.length) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
      swiped = false;
    }, { passive: true });
    frame.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      const touch = e.changedTouches?.[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        swiped = true;
        goShowcase(dx < 0 ? 1 : -1, shots);
      }
    });
    frame.addEventListener('click', () => {
      if (swiped) {
        swiped = false;
        return;
      }
      goShowcase(1, shots);
    });
  }

  function pickedIds() {
    return [...state.selectedIds].filter((id) => characters.some((char) => char.id === id)).slice(0, 6);
  }

  function selectedChar() {
    const id = pickedIds()[0] || '';
    return characters.find((char) => char.id === id) || null;
  }

  function filteredCharacters() {
    const q = state.query.trim().toLowerCase();
    if (!q) return characters;
    return characters.filter((char) => [
      char.name,
      char.realName,
      char.customNickname,
      char.currentRole,
      ...(Array.isArray(char.aliases) ? char.aliases : []),
    ].filter(Boolean).join(' ').toLowerCase().includes(q));
  }

  function themeButton(id) {
    const preset = TRAVEL_THEME_PRESETS[id];
    const active = id === selectedTheme ? ' is-active' : '';
    return `
      <button type="button" class="travel-theme${active}" data-theme="${esc(id)}">
        <strong>${esc(preset.label)}</strong>
        <small>${esc(preset.collectibleLabel || '收集物')}</small>
      </button>
    `;
  }

  // 不选具体主题＝随机（核心模块按人设加权抽），放在主题区最前面，跟"目的地可选/可留空"是同一个思路。
  function randomThemeButtonHtml() {
    const active = selectedTheme ? '' : ' is-active';
    return `
      <button type="button" class="travel-theme travel-theme-random${active}" data-theme="">
        <strong>随机</strong>
        <small>按TA的性子来</small>
      </button>
    `;
  }

  function characterButton(char) {
    const ids = pickedIds();
    const active = state.selectedIds.has(char.id) ? ' is-active' : '';
    const primary = ids[0] === char.id ? ' is-primary' : '';
    return `
      <button type="button" class="travel-char-pick${active}${primary}" data-char="${esc(char.id)}">
        ${characterAvatarHtml(char, { className: 'travel-char-avatar' })}
        <span>
          <strong>${esc(char.customNickname || char.name || '未命名')}</strong>
          <small>${esc(charSub(char) || '角色')}</small>
        </span>
        ${primary ? '<b>主邀请</b>' : active ? '<b>同行</b>' : ''}
      </button>
    `;
  }

  function tripCard(trip) {
    const preset = TRAVEL_THEME_PRESETS[trip.theme] || {};
    const characterId = (trip.characterIds || [])[0] || '';
    const thumbSrc = trip.postcard?.image || (trip.checkpoints || []).slice().reverse().find((cp) => cp.capturedPhoto?.image)?.capturedPhoto?.image || '';
    return `
      <div class="travel-trip-row">
        <button type="button" class="travel-trip-row-main" data-trip="${esc(trip.id)}" data-character="${esc(characterId)}">
          ${thumbSrc
    ? `<span class="travel-trip-thumb"><img src="${esc(thumbSrc)}" alt="" loading="lazy"></span>`
    : `<span class="travel-trip-stamp">${esc(preset.collectibleLabel || preset.label || '旅行')}</span>`}
          <span class="travel-trip-body">
            <strong>${esc(trip.title || preset.label || '旅行事件')}</strong>
            <small>${esc(tripMeta(trip))}</small>
            <em>${esc(latestCheckpointText(trip))}</em>
          </span>
          <span class="travel-trip-arrow">${icon('chevron')}</span>
        </button>
        <button type="button" class="travel-trip-more" data-trip-more="${esc(trip.id)}" data-character-more="${esc(characterId)}" aria-label="旅行操作">${icon('more')}</button>
      </div>
    `;
  }

  function notificationCard(item) {
    const characterId = item.characterId || '';
    return `
      <button type="button" class="travel-notice-row" data-notice="${esc(item.id)}" data-trip="${esc(item.tripId)}" data-character="${esc(characterId)}">
        <span class="travel-notice-dot"></span>
        <span class="travel-trip-body">
          <strong>${esc(item.title || '旅行char新消息')}</strong>
          <small>${esc(item.kind === 'return' ? '已带回' : '新阶段')}</small>
          <em>${esc(item.body || '')}</em>
        </span>
        <span class="travel-trip-arrow">${icon('chevron')}</span>
      </button>
    `;
  }

  function showcaseHtml(shots) {
    if (!shots.length) {
      return `
        <button type="button" class="travel-showcase-frame is-empty" data-showcase-empty>
          <span class="travel-showcase-photo is-empty"></span>
          <span class="travel-showcase-caption">
            <strong>还没有旅行照片</strong>
            <small>点"创建旅行"，带TA出门拍第一张</small>
          </span>
        </button>
      `;
    }
    const idx = Math.min(state.showcaseIndex, shots.length - 1);
    const shot = shots[idx];
    return `
      <div class="travel-showcase-progress" role="tablist" aria-label="旅行照片进度">
        ${shots.map((_, i) => `
          <button type="button" class="travel-showcase-seg${i < idx ? ' is-done' : i === idx ? ' is-active' : ''}" data-shot="${i}" role="tab" aria-label="第 ${i + 1} 张" aria-selected="${i === idx}"></button>
        `).join('')}
      </div>
      <button type="button" class="travel-showcase-frame" data-showcase-next aria-label="查看下一张">
        <span class="travel-showcase-photo"><img src="${esc(shot.src)}" alt="" key="${idx}"></span>
        <span class="travel-showcase-caption">
          <strong>${esc(shot.caption || '旅行')}</strong>
          ${shot.sub ? `<small>${esc(shot.sub)}</small>` : ''}
        </span>
      </button>
      <button type="button" class="travel-showcase-expand" data-showcase-expand aria-label="全屏查看回忆胶卷">${icon('screenshot')}</button>
    `;
  }

  // 拆出 sheet 内容体，选人/选主题等交互只替换这部分并同步恢复 scrollTop，
  // 不再整页重绘，避免借助 rAF 延迟恢复滚动位置时出现"闪一下跳回顶部"。
  function createSheetBodyHtml() {
    const ids = pickedIds();
    const rows = filteredCharacters();
    return `
      <section class="travel-panel">
        <div class="travel-section-title">主题</div>
        <div class="travel-theme-grid travel-theme-grid-random">${randomThemeButtonHtml()}</div>
        ${themeCategoryGroups().map((cat) => {
    const shown = state.showMoreThemes ? cat.themeIds : cat.themeIds.slice(0, THEME_GROUP_PREVIEW_COUNT);
    return `
              <div class="travel-theme-group-label">${esc(cat.label)}</div>
              <div class="travel-theme-grid">${shown.map(themeButton).join('')}</div>
            `;
  }).join('')}
        <button type="button" class="travel-theme-more-toggle">${state.showMoreThemes ? '收起主题' : '更多主题'}</button>
      </section>

      <section class="travel-panel travel-roster-panel">
        <div class="travel-section-head">
          <div class="travel-section-title">角色</div>
          ${ids.length ? `<span class="travel-sync-note">已选 ${ids.length}</span>` : ''}
        </div>
        <div class="travel-search">
          <button type="button" class="travel-search-icon search-icon-submit" data-search-submit aria-label="搜索">${icon('search')}</button>
          <input type="search" class="travel-search-input" value="${esc(state.query)}" placeholder="搜索角色，回车搜索" autocomplete="off">
        </div>
        <div class="travel-char-list">
          ${characters.length
    ? (rows.length ? rows.map(characterButton).join('') : '<div class="travel-empty is-compact"><span>没有匹配角色</span></div>')
    : `<div class="travel-empty">${emptyIllustration('chat')}<span>通讯录还是空的</span></div>`}
        </div>
      </section>

      <section class="travel-panel travel-options">
        <button type="button" class="travel-offline-guide-link" data-go-offline-date>
          <span>想真的带${esc(userName)}一起出门？</span>
          <span class="travel-offline-guide-cta">去一起旅行 ›</span>
        </button>
        <label class="travel-style-field">
          <span>目的地（可留空，按TA当前定位随机）</span>
          <input type="text" class="travel-destination-input" value="${esc(state.destination)}" placeholder="比如：丽江" maxlength="40">
        </label>
        <label class="travel-toggle">
          <input type="checkbox" class="travel-length-extended" ${state.lengthMode === 'extended' ? 'checked' : ''}>
          <span>长线旅行（几天到一周，覆盖角色日程）</span>
        </label>
        <label class="travel-style-field ${state.lengthMode === 'extended' ? '' : 'is-disabled'}">
          <span>旅行天数</span>
          <select class="travel-duration-days" ${state.lengthMode === 'extended' ? '' : 'disabled'}>
            ${[1, 2, 3, 5, 7].map((d) => `<option value="${d}" ${state.durationDays === d ? 'selected' : ''}>${d} 天</option>`).join('')}
          </select>
        </label>
        <label class="travel-toggle">
          <input type="checkbox" class="travel-show-char" ${state.showCharacter ? 'checked' : ''}>
          <span>${esc((TRAVEL_THEME_PRESETS[selectedTheme] || {}).category === 'home' ? '票根' : '明信片')}可出现角色形象</span>
        </label>
        <label class="travel-toggle">
          <input type="checkbox" class="travel-allow-people" ${state.allowPeople ? 'checked' : ''}>
          <span>画面允许出现路人（不强制，只是不锁死"绝不能有人"）</span>
        </label>
        <label class="travel-toggle">
          <input type="checkbox" class="travel-auto-image-nodes" ${state.autoImageAllNodes ? 'checked' : ''}>
          <span>每个节点到点自动生图（不用手动点，仍可重roll）</span>
        </label>
        <label class="travel-style-field">
          <span>${esc((TRAVEL_THEME_PRESETS[selectedTheme] || {}).category === 'home' ? '票根风格' : '明信片风格')}</span>
          <select class="travel-image-style">
            <option value="" ${!state.styleId ? 'selected' : ''}>跟随全局场景画风</option>
            ${listPostcardStyleOptions().map((opt) => `<option value="${esc(opt.id)}" ${state.styleId === opt.id ? 'selected' : ''}>${esc(opt.label)}${opt.hint ? `（${esc(opt.hint)}）` : ''}</option>`).join('')}
          </select>
        </label>
        <label class="travel-style-field">
          <span>自定义风格追加词（可留空）</span>
          <input type="text" class="travel-style-suffix-input" value="${esc(state.styleSuffix)}" placeholder="拼在风格模板之后，比如：low saturation, quiet mood" maxlength="300">
        </label>
      </section>
    `;
  }

  function createSheetHtml(entering) {
    const picked = selectedChar();
    return `
      <div class="travel-sheet-overlay${entering ? ' is-entering' : ''}" data-sheet-name="create" role="dialog" aria-modal="true" aria-label="创建旅行">
        <header class="travel-sheet-head">
          <h2>创建旅行</h2>
          <button type="button" class="travel-sheet-close" data-sheet-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="travel-sheet-scroll">${createSheetBodyHtml()}</div>
        <footer class="travel-sheet-footer">
          <button type="button" class="btn btn-primary travel-start" ${picked ? '' : 'disabled'}>${icon('send')} 发出邀请</button>
        </footer>
      </div>
    `;
  }

  function recordsSheetBodyHtml() {
    const ongoingTrips = state.trips.filter((trip) => trip.status === 'away').slice(0, 8);
    const completedTrips = state.trips
      .filter((trip) => trip.status === 'returned' || trip.status === 'cancelled' || trip.status === 'terminated')
      .slice(0, 8);
    return `
      ${state.notifications.length ? `
        <section class="travel-panel">
          <div class="travel-section-head">
            <div class="travel-section-title">新消息</div>
            <span class="travel-sync-note">${state.notifications.length} 条</span>
          </div>
          <div class="travel-trip-list travel-notice-list">
            ${state.notifications.slice(0, 5).map(notificationCard).join('')}
          </div>
        </section>
      ` : ''}
      <section class="travel-panel">
        <div class="travel-section-head">
          <div class="travel-section-title">进行中</div>
          ${state.synced ? `<span class="travel-sync-note">带回 ${state.synced} 件</span>` : ''}
        </div>
        <div class="travel-trip-list">
          ${ongoingTrips.length ? ongoingTrips.map(tripCard).join('') : `<div class="travel-empty is-compact"><span>没有进行中的旅行</span></div>`}
        </div>
      </section>
      <section class="travel-panel">
        <div class="travel-section-title">已完成</div>
        <div class="travel-trip-list">
          ${completedTrips.length ? completedTrips.map(tripCard).join('') : `<div class="travel-empty is-compact"><span>还没有完成记录</span></div>`}
        </div>
      </section>
    `;
  }

  function recordsSheetHtml(entering) {
    return `
      <div class="travel-sheet-overlay${entering ? ' is-entering' : ''}" data-sheet-name="records" role="dialog" aria-modal="true" aria-label="旅行记录">
        <header class="travel-sheet-head">
          <h2>旅行记录</h2>
          <button type="button" class="travel-sheet-close" data-sheet-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="travel-sheet-scroll">${recordsSheetBodyHtml()}</div>
      </div>
    `;
  }

  function bindSheetCommon(root) {
    root.querySelector('[data-sheet-close]')?.addEventListener('click', () => {
      state.sheet = null;
      paint();
    });
  }

  // sheet 内的选人/选主题/勾选交互只重绘 .travel-sheet-scroll 内容，
  // 同步保留 scrollTop（不经 rAF），不牵动整页 paint()，避免滚动位置闪跳。
  function refreshCreateSheetBody() {
    const root = container.querySelector('.travel-sheet-overlay[data-sheet-name="create"]');
    const scrollEl = root?.querySelector('.travel-sheet-scroll');
    if (!root || !scrollEl) return;
    const prevTop = scrollEl.scrollTop;
    scrollEl.innerHTML = createSheetBodyHtml();
    scrollEl.scrollTop = prevTop;
    bindCreateSheetBody(scrollEl);
    const startBtn = root.querySelector('.travel-start');
    if (startBtn) startBtn.disabled = !selectedChar();
  }

  function bindCreateSheetBody(scrollEl) {
    bindCommitSearch({
      input: scrollEl.querySelector('.travel-search-input'),
      trigger: scrollEl.querySelector('[data-search-submit]'),
      onCommit: (value) => {
        state.query = value;
        refreshCreateSheetBody();
      },
    });
    scrollEl.querySelectorAll('[data-char]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = String(btn.getAttribute('data-char') || '').trim();
        if (!id) return;
        if (state.selectedIds.has(id)) {
          state.selectedIds.delete(id);
        } else if (state.selectedIds.size < 6) {
          state.selectedIds.add(id);
        } else {
          showToast('一次最多邀请 6 位');
        }
        selectedId = pickedIds()[0] || '';
        refreshCreateSheetBody();
      });
    });
    scrollEl.querySelector('.travel-theme-more-toggle')?.addEventListener('click', () => {
      state.showMoreThemes = !state.showMoreThemes;
      refreshCreateSheetBody();
    });
    scrollEl.querySelectorAll('[data-theme]').forEach((btn) => {
      btn.addEventListener('click', () => {
        // data-theme="" 就是"随机"按钮，不能回落成固定主题，否则随机选项形同虚设。
        selectedTheme = String(btn.getAttribute('data-theme') ?? '').trim();
        refreshCreateSheetBody();
      });
    });
    scrollEl.querySelector('[data-go-offline-date]')?.addEventListener('click', () => {
      const ids = pickedIds();
      navigate('encounter/trip', ids.length === 1 ? { characterId: ids[0] } : {});
    });
    scrollEl.querySelector('.travel-length-extended')?.addEventListener('change', (e) => {
      state.lengthMode = e.target.checked ? 'extended' : 'quick';
      refreshCreateSheetBody();
    });
    scrollEl.querySelector('.travel-duration-days')?.addEventListener('change', (e) => {
      state.durationDays = Math.max(1, Math.min(7, Number(e.target.value) || 3));
    });
    scrollEl.querySelector('.travel-show-char')?.addEventListener('change', (e) => {
      state.showCharacter = !!e.target.checked;
    });
    scrollEl.querySelector('.travel-allow-people')?.addEventListener('change', (e) => {
      state.allowPeople = !!e.target.checked;
    });
    scrollEl.querySelector('.travel-auto-image-nodes')?.addEventListener('change', (e) => {
      state.autoImageAllNodes = !!e.target.checked;
    });
    scrollEl.querySelector('.travel-image-style')?.addEventListener('change', (e) => {
      state.styleId = String(e.target.value || '').trim();
    });
    scrollEl.querySelector('.travel-style-suffix-input')?.addEventListener('change', (e) => {
      state.styleSuffix = String(e.target.value || '').trim().slice(0, 300);
    });
    scrollEl.querySelector('.travel-destination-input')?.addEventListener('change', (e) => {
      state.destination = String(e.target.value || '').trim().slice(0, 40);
    });
  }

  function bindCreateSheet(root) {
    bindSheetCommon(root);
    const scrollEl = root.querySelector('.travel-sheet-scroll');
    if (scrollEl) bindCreateSheetBody(scrollEl);
    root.querySelector('.travel-start')?.addEventListener('click', async () => {
      const picked = selectedChar();
      const ids = pickedIds();
      if (!picked) {
        showToast('请先选择一位角色');
        return;
      }
      // Keep-Alive 恢复后 characters 可能是旧快照；出发前先拉最新档案，避免刚填过现实城市仍被误判。
      const fresh = await getCharacter(picked.id).catch(() => null);
      if (fresh) {
        const idx = characters.findIndex((char) => char.id === fresh.id);
        if (idx >= 0) characters[idx] = fresh;
      }
      const charForCheck = fresh || picked;
      if (!getCharacterTravelCity(charForCheck)) {
        const name = charForCheck.customNickname || charForCheck.name || 'TA';
        const choice = await openOptionPicker({
          title: `${name}还没填现实城市，旅行可能定位不准`,
          items: [
            { id: 'fill', label: '去通讯录填写城市' },
            { id: 'go', label: '仍然出发' },
          ],
        });
        if (choice === 'fill') {
          navigate('contacts/edit', { id: picked.id, sheet: 'life' });
          return;
        }
        if (choice !== 'go') return;
      }
      navigate('travel-char/event', {
        character: picked.id,
        theme: selectedTheme,
        destination: state.destination,
        lengthMode: state.lengthMode,
        durationDays: state.lengthMode === 'extended' ? String(state.durationDays) : '',
        companions: ids.slice(1).join(','),
        showCharacter: state.showCharacter ? '1' : '',
        allowPeople: state.allowPeople ? '1' : '',
        autoImageAllNodes: state.autoImageAllNodes ? '1' : '',
        imageStyle: state.imageStyle,
        styleId: state.styleId,
        styleSuffix: state.styleSuffix,
      });
    });
  }

  // 记录 sheet 内删除/终止旅行只重绘 .travel-sheet-scroll，同步保留 scrollTop，
  // 不牵动整页 paint()，避免和创建 sheet 一样出现滚动位置闪跳。
  function refreshRecordsSheetBody() {
    const root = container.querySelector('.travel-sheet-overlay[data-sheet-name="records"]');
    const scrollEl = root?.querySelector('.travel-sheet-scroll');
    if (!root || !scrollEl) return;
    const prevTop = scrollEl.scrollTop;
    scrollEl.innerHTML = recordsSheetBodyHtml();
    scrollEl.scrollTop = prevTop;
    bindRecordsSheetBody(scrollEl);
  }

  async function onTripMoreMenu(tripId, characterId) {
    const trip = state.trips.find((item) => item.id === tripId);
    if (!trip) return;
    const preset = TRAVEL_THEME_PRESETS[trip.theme] || {};
    const actions = [];
    if (trip.status === 'away') {
      actions.push({
        label: '终止这趟旅行',
        onClick: async () => {
          await cancelTravelCharTrip({ userId: user.id, characterId, tripId }).catch((err) => {
            showToast(err?.message || '终止失败');
            return null;
          });
          const idx = state.trips.findIndex((item) => item.id === tripId);
          if (idx >= 0) state.trips[idx] = { ...state.trips[idx], status: 'terminated', expectedReturnAt: Date.now() };
          refreshRecordsSheetBody();
          showToast('已终止这趟旅行');
        },
      });
    }
    actions.push({
      label: '删除这条记录',
      variant: 'danger',
      onClick: async () => {
        if (!window.confirm(`删除「${trip.title || preset.label || '这趟旅行'}」的记录？已经带回的收集物和共同记忆不会被删除。`)) return;
        await deleteTravelCharTrip({ userId: user.id, characterId, tripId }).catch((err) => {
          showToast(err?.message || '删除失败');
          return null;
        });
        state.trips = state.trips.filter((item) => item.id !== tripId);
        state.notifications = state.notifications.filter((item) => item.tripId !== tripId);
        refreshRecordsSheetBody();
        showToast('已删除旅行记录');
      },
    });
    openChatRowSheet({
      chatTitle: trip.title || preset.label || '旅行记录',
      actions,
    });
  }

  function bindRecordsSheetBody(scrollEl) {
    scrollEl.querySelectorAll('.travel-trip-row-main[data-trip]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('travel-char/event', {
        id: btn.getAttribute('data-trip') || '',
        character: btn.getAttribute('data-character') || '',
      }));
    });
    scrollEl.querySelectorAll('[data-trip-more]').forEach((btn) => {
      btn.addEventListener('click', () => {
        onTripMoreMenu(btn.getAttribute('data-trip-more') || '', btn.getAttribute('data-character-more') || '');
      });
    });
    scrollEl.querySelectorAll('[data-notice]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await markTravelCharNotificationRead(user.id, btn.getAttribute('data-notice') || '').catch(() => null);
        navigate('travel-char/event', {
          id: btn.getAttribute('data-trip') || '',
          character: btn.getAttribute('data-character') || '',
        });
      });
    });
  }

  function bindRecordsSheet(root) {
    bindSheetCommon(root);
    const scrollEl = root.querySelector('.travel-sheet-scroll');
    if (scrollEl) bindRecordsSheetBody(scrollEl);
  }

  function paint() {
    const scrollState = captureElementScrollState(container, '.travel-sheet-scroll');
    const shots = showcaseImages(state.trips);
    const hasUnread = state.notifications.length > 0;
    const sheetJustOpened = !!state.sheet && state.sheet !== lastSheet;
    lastSheet = state.sheet;

    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">旅行char</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <main class="travel-showcase-main">
        <div class="travel-showcase">
          ${showcaseHtml(shots)}
        </div>
      </main>
      <nav class="travel-dock">
        <button type="button" class="travel-dock-btn" data-sheet="records">
          ${icon('time')}
          <span>旅行记录</span>
          ${hasUnread ? '<b class="travel-dock-dot" aria-hidden="true"></b>' : ''}
        </button>
        <button type="button" class="travel-dock-btn travel-dock-btn--primary" data-sheet="create">
          ${icon('plus')}
          <span>创建旅行</span>
        </button>
      </nav>
      ${state.sheet === 'create' ? createSheetHtml(sheetJustOpened) : ''}
      ${state.sheet === 'records' ? recordsSheetHtml(sheetJustOpened) : ''}
    `;

    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelectorAll('[data-sheet]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.sheet = btn.getAttribute('data-sheet');
        paint();
      });
    });
    bindShowcaseFrame(container.querySelector('[data-showcase-next]'), shots);
    container.querySelector('[data-showcase-empty]')?.addEventListener('click', () => {
      state.sheet = 'create';
      paint();
    });
    container.querySelector('[data-showcase-expand]')?.addEventListener('click', () => {
      openTravelReelViewer({ images: shots, startIndex: state.showcaseIndex });
    });
    container.querySelectorAll('[data-shot]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.showcaseIndex = Number(btn.getAttribute('data-shot')) || 0;
        paint();
      });
    });

    const sheetRoot = container.querySelector('.travel-sheet-overlay');
    if (sheetRoot) {
      if (state.sheet === 'create') bindCreateSheet(sheetRoot);
      else if (state.sheet === 'records') bindRecordsSheet(sheetRoot);
    }

    restoreElementScrollState(container, '.travel-sheet-scroll', scrollState);
    scheduleShowcaseAutoplay(shots);
  }

  paint();

  void (async () => {
    await refreshTrips();
    if (!container.isConnected) return;
    if (state.synced) showToast(`旅行char带回了 ${state.synced} 个收集物`);
    paint();
  })().catch(() => {
    if (container.isConnected) paint();
  });

  window.addEventListener('marshmallow-route-activated', (ev) => {
    const detail = ev.detail || {};
    if (!detail.resumed || detail.container !== container || detail.path !== 'travel-char') return;
    void Promise.all([reloadCharacters(), refreshTrips()]).then(() => {
      if (container.isConnected) paint();
    }).catch(() => {});
  });
}
