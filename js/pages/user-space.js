import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { openSlotNameModal } from '../components/slot-name-modal.js';
import { openOptionPicker } from '../components/option-picker.js';
import {
  getCurrentUser,
  listUsers,
  setCurrentUserId,
  createUserSlot,
  deleteUserSlot,
  duplicateUserSlot,
} from '../core/user-slot.js';
import { getUserDisplayName, buildUserLocationLine } from '../models/user.js';
import {
  getEffectiveWeatherCityForUser,
  fetchWeatherForCity,
  summarizeWeatherDisplay,
  summarizeWeatherForHint,
} from '../core/weather-location.js';
import { characterAvatarHtml, escAttr } from '../components/scrapbook-illustrations.js';
import { isOversizedAvatarDataUrl } from '../core/avatar-compaction.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderChip(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return `<span class="user-space-chip">${esc(t)}</span>`;
}

function splitTags(text = '') {
  return String(text || '')
    .split(/[,，、;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function profileTextNeedsCollapse(text = '') {
  const value = String(text || '').trim();
  return value.length > 120 || value.split(/\r?\n/).length > 6;
}

let activeRenderId = 0;

function groupUsersBySlot(users = [], currentUserId = '') {
  const groups = new Map();
  for (const user of users) {
    const slotGroupId = String(user?.worldId || user?.slotGroupId || user?.id || '').trim();
    if (!slotGroupId) continue;
    if (!groups.has(slotGroupId)) groups.set(slotGroupId, []);
    groups.get(slotGroupId).push(user);
  }
  return [...groups.entries()].map(([id, identities]) => {
    const active = identities.find((identity) => identity.id === currentUserId);
    const primary = active || identities[0];
    return { id, identities, primary };
  });
}

export default async function render(container) {
  const renderId = ++activeRenderId;
  const [user, slots] = await Promise.all([getCurrentUser(), listUsers()]);
  const slotGroups = groupUsersBySlot(slots, user?.id);
  const currentSlotGroupId = String(user?.worldId || user?.slotGroupId || user?.id || '').trim();
  const currentSlotGroup = slotGroups.find((slot) => slot.id === currentSlotGroupId) || slotGroups[0] || null;
  const currentSlotLabel = String(currentSlotGroup?.primary?.slotName || user?.slotName || user?.name || '未命名档位').trim();
  const displayName = getUserDisplayName(user);
  const cityInfo = getEffectiveWeatherCityForUser(user);
  const weatherLine = String(user?.weatherHint || '').trim();
  const locationLine = buildUserLocationLine(user, { weatherLine });
  const hobbyChips = splitTags(user?.hobbies).map(renderChip).join('');
  const dislikeChips = splitTags(user?.dislikes).map(renderChip).join('');
  const videoAvatar = String(user?.videoAvatar || '').trim();
  const videoAppearance = String(user?.videoAppearancePrompt || '').trim();

  container.className = 'page scrapbook-page user-space-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">我的空间</h1>
      <button type="button" class="navbar-btn user-space-edit-btn" aria-label="编辑资料">${icon('settings')}</button>
    </header>
    <main class="user-space-scroll scrapbook-scroll">
      <section class="user-space-card scrapbook-panel user-space-slot-switcher-card">
        <div class="user-space-slot-switcher-head">
          <span>当前档位</span>
          <button type="button" class="user-space-slot-manage" data-slot-manage>管理</button>
        </div>
        <button type="button" class="user-space-slot-switcher" data-slot-switch aria-label="切换档位">
          <strong>${esc(currentSlotLabel)}</strong>
          <span aria-hidden="true">›</span>
        </button>
      </section>

      ${user?.worldBackground ? `
        <section class="user-space-card scrapbook-panel">
          <div class="user-space-card-head user-space-profile-text-head">
            <h3>档位背景</h3>
            ${profileTextNeedsCollapse(user.worldBackground) ? '<button type="button" class="user-space-profile-text-open" data-profile-text="world-background">查看全文</button>' : ''}
          </div>
          <p class="user-space-body ${profileTextNeedsCollapse(user.worldBackground) ? 'is-collapsed' : ''}">${esc(user.worldBackground)}</p>
        </section>
      ` : ''}

      <section class="user-space-hero scrapbook-panel">
        <div class="deco-tape user-space-tape"></div>
        <div class="user-space-avatar">
          ${characterAvatarHtml(user, { className: '', fallbackClass: 'user-space-avatar-fallback' })}
        </div>
        <div class="user-space-headline">
          <h2>${esc(displayName)}</h2>
          ${user?.name && user?.nickname ? `<p class="user-space-subname">姓名 ${esc(user.name)}</p>` : ''}
          <p class="user-space-slot">${esc(user?.slotName || '默认档')}</p>
        </div>
        ${user?.signature
    ? `<blockquote class="user-space-signature">${esc(user.signature)}</blockquote>`
    : '<p class="user-space-signature is-empty">还没有个性签名</p>'}
        ${user?.statusText ? `<p class="user-space-status">${esc(user.statusText)}</p>` : ''}
      </section>

      <section class="user-space-card scrapbook-panel">
        <h3>所在与天气</h3>
        <p data-user-space-location class="${locationLine ? '' : 'text-hint'}">${esc(locationLine || '可在编辑页填写虚拟城市，并映射现实城市供 AI 读取天气')}</p>
        ${user?.birthday ? `<p class="user-space-meta">生日 ${esc(user.birthday)}</p>` : ''}
      </section>

      ${hobbyChips ? `
        <section class="user-space-card scrapbook-panel">
          <h3>兴趣爱好</h3>
          <div class="user-space-chips">${hobbyChips}</div>
        </section>
      ` : ''}

      ${dislikeChips ? `
        <section class="user-space-card scrapbook-panel">
          <h3>雷点</h3>
          <div class="user-space-chips is-dislike">${dislikeChips}</div>
        </section>
      ` : ''}

      ${user?.persona ? `
        <section class="user-space-card scrapbook-panel">
          <div class="user-space-card-head user-space-profile-text-head">
            <h3>人物设定</h3>
            ${profileTextNeedsCollapse(user.persona) ? '<button type="button" class="user-space-profile-text-open" data-profile-text="persona">查看全文</button>' : ''}
          </div>
          <p class="user-space-body ${profileTextNeedsCollapse(user.persona) ? 'is-collapsed' : ''}">${esc(user.persona)}</p>
        </section>
      ` : ''}

      ${user?.appearancePrompt ? `
        <section class="user-space-card scrapbook-panel">
          <h3>外观描述</h3>
          <p class="user-space-body">${esc(user.appearancePrompt)}</p>
        </section>
      ` : ''}

      ${(videoAvatar || videoAppearance) ? `
        <section class="user-space-card scrapbook-panel">
          <h3>我的视频形象</h3>
          <div class="user-space-video-avatar-view">
            ${videoAvatar && !isOversizedAvatarDataUrl(videoAvatar) ? `<img src="${escAttr(videoAvatar)}" alt="">` : '<span>未设置图片</span>'}
          </div>
          ${videoAppearance ? `<p class="user-space-body">${esc(videoAppearance)}</p>` : ''}
        </section>
      ` : ''}

      <section class="user-space-card scrapbook-panel">
        <h3>聊天外观</h3>
        <div class="user-space-bubble-preview">
          <span class="user-space-bubble-sample" style="background:${esc(user?.bubbleColor || '#f3e6d4')}">我的气泡</span>
        </div>
      </section>

      <div class="user-space-actions">
        <button type="button" class="btn btn-primary user-space-go-edit">编辑资料</button>
      </div>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  container.querySelector('.user-space-edit-btn')?.addEventListener('click', () => navigate('user-space/edit'));
  container.querySelector('.user-space-go-edit')?.addEventListener('click', () => navigate('user-space/edit'));

  function closeUserSpaceModal() {
    const host = document.getElementById('modal-container');
    if (!host) return;
    host.classList.remove('active');
    host.innerHTML = '';
  }

  function openProfileText(title = '', text = '') {
    const host = document.getElementById('modal-container');
    if (!host) return;
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay" data-profile-text-overlay>
        <section class="modal-sheet scrapbook-card user-space-profile-text-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <header class="modal-header">
            <h3>${esc(title)}</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-profile-text-close aria-label="关闭">${icon('back')}</button>
          </header>
          <div class="modal-body user-space-profile-text-body"><p>${esc(text)}</p></div>
        </section>
      </div>`;
    host.querySelector('[data-profile-text-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeUserSpaceModal();
    });
    host.querySelector('[data-profile-text-close]')?.addEventListener('click', closeUserSpaceModal);
  }

  async function createSlotFromSpace() {
    const name = await openSlotNameModal({ title: '新建档位' });
    if (!name) return false;
    const created = await createUserSlot(name);
    await setCurrentUserId(created.id);
    showToast(`已创建「${name}」`);
    await render(container);
    return true;
  }

  async function copySlotFromSpace() {
    if (!user?.id) return;
    const name = await openSlotNameModal({
      title: '复制当前档位',
      value: `${user.slotName || user.name || '档位'} · 副本`,
      confirmText: '开始复制',
    });
    if (!name) return false;
    showToast('正在复制档位…');
    const copy = await duplicateUserSlot(user.id, name);
    await setCurrentUserId(copy.id);
    showToast('档位已复制');
    await render(container);
    return true;
  }

  async function deleteSlotFromSpace() {
    if (!user?.id) return;
    const slotName = String(user.slotName || user.name || '当前档位').trim();
    if (!window.confirm(`删除整个「${slotName}」？其中所有关联身份、聊天、记忆和独立设置都会删除，且不可恢复。`)) return false;
    await deleteUserSlot(user.id);
    showToast('整个档位及其身份记录已删除');
    await render(container);
    return true;
  }

  function openSlotManagement() {
    const host = document.getElementById('modal-container');
    if (!host) return;
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay" data-slot-manage-overlay>
        <section class="modal-sheet scrapbook-card user-space-slot-manage-sheet" role="dialog" aria-modal="true" aria-label="管理档位">
          <header class="modal-header">
            <h3>管理档位</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-slot-manage-close aria-label="关闭">${icon('back')}</button>
          </header>
          <div class="modal-body user-space-slot-manage-body">
            <button type="button" class="user-space-slot-manage-action" data-slot-action="new"><span>新建档位</span><span aria-hidden="true">›</span></button>
            <button type="button" class="user-space-slot-manage-action" data-slot-action="copy"><span>复制当前档</span><span aria-hidden="true">›</span></button>
            <button type="button" class="user-space-slot-manage-action is-danger" data-slot-action="delete-slot"><span>删除当前档位</span><span aria-hidden="true">›</span></button>
          </div>
        </section>
      </div>`;
    host.querySelector('[data-slot-manage-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeUserSpaceModal();
    });
    host.querySelector('[data-slot-manage-close]')?.addEventListener('click', closeUserSpaceModal);
    host.querySelectorAll('[data-slot-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        const action = button.getAttribute('data-slot-action');
        closeUserSpaceModal();
        try {
          if (action === 'new') await createSlotFromSpace();
          else if (action === 'copy') await copySlotFromSpace();
          else if (action === 'delete-slot') await deleteSlotFromSpace();
        } catch (err) {
          showToast(String(err?.message || err));
        }
      });
    });
  }

  container.querySelector('[data-profile-text="persona"]')?.addEventListener('click', () => {
    openProfileText('人物设定', user.persona);
  });
  container.querySelector('[data-profile-text="world-background"]')?.addEventListener('click', () => {
    openProfileText('档位背景', user.worldBackground);
  });
  container.querySelector('[data-slot-manage]')?.addEventListener('click', openSlotManagement);
  container.querySelector('[data-slot-switch]')?.addEventListener('click', async () => {
    const picked = await openOptionPicker({
      title: '切换档位',
      currentId: currentSlotGroup?.primary?.id || user?.id || '',
      items: slotGroups.map((slot) => ({
        id: slot.primary.id,
        label: slot.primary.slotName || slot.primary.name || '未命名档位',
        description: `${slot.identities.length} 个身份`,
      })),
    });
    if (!picked || picked === user?.id) return;
    try {
      await setCurrentUserId(picked);
      showToast('已切换档位');
      await render(container);
    } catch (err) {
      showToast(String(err?.message || err));
    }
  });

  // Paint from local profile data first; weather refresh must never block page entry.
  if (cityInfo.weatherCity) {
    void fetchWeatherForCity(cityInfo.weatherCity).then((weather) => {
      if (!weather || renderId !== activeRenderId || !container.isConnected) return;
      let nextWeatherLine = summarizeWeatherDisplay(weather) || weatherLine;
      if (!user?.weatherHint) {
        const hint = summarizeWeatherForHint(weather);
        if (hint) nextWeatherLine = hint;
      }
      const nextLocationLine = buildUserLocationLine(user, { weatherLine: nextWeatherLine });
      const locationEl = container.querySelector('[data-user-space-location]');
      if (!locationEl) return;
      locationEl.textContent = nextLocationLine || '可在编辑页填写虚拟城市，并映射现实城市供 AI 读取天气';
      locationEl.classList.toggle('text-hint', !nextLocationLine);
    }).catch(() => {});
  }

  // 「我的空间」默认走 Keep-Alive 秒开，从编辑资料页返回时头像/签名等可能已经改过，
  // 恢复时整页重新取数据重绘一次，避免看到编辑前的旧资料。render() 会整页重建 DOM，
  // 这里用容器上的标记只挂一次监听，避免每次 render() 重入都叠加新的监听器。
  if (!container.dataset.userSpaceResumeBound) {
    container.dataset.userSpaceResumeBound = '1';
    window.addEventListener('marshmallow-route-activated', (ev) => {
      const detail = ev.detail || {};
      if (!detail.resumed || detail.container !== container || detail.path !== 'user-space') return;
      if (container.isConnected) void render(container);
    });
  }
}
