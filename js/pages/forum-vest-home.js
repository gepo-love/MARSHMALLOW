import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/svg-icons.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';
import {
  listForumVests,
  createForumVest,
  updateForumVest,
  deleteForumVest,
  resolveSelfDisplayName,
  FORUM_VEST_BADGE_PRESETS,
  loadForumProfile,
  saveForumProfile,
} from '../core/forum-vests.js';
import { fileToCroppedOptimizedAvatarDataUrl } from '../components/image-crop-modal.js';
import { isUserAuthoredForumThread } from '../core/forum-identity.js';
import { buildForumInboxSnapshot } from '../core/forum/forum-inbox-state.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';

function e(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(ts) {
  return new Date(ts || Date.now()).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function openGlobalModal(innerHtml) {
  const host = document.getElementById('modal-container');
  if (!host) return { close: () => {} };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet" role="dialog" aria-modal="true" data-modal-sheet>
        ${innerHtml}
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-modal-sheet]')?.addEventListener('click', (ev) => ev.stopPropagation());
  host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
  return { close, root: host };
}

async function loadThreadsForUser(userId) {
  if (!userId) return [];
  try {
    const list = await db.getAllByIndex('forumThreads', 'userId', userId);
    return list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  } catch (_) {
    const all = await db.getAllRecords('forumThreads');
    return all.filter((t) => t.userId === userId).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }
}

/** 统计每个用户身份（''=本人）发过的主帖数与楼层回复数（含子回复）。 */
function collectIdentityActivity(threads = [], user = {}) {
  const byVest = new Map();
  const ensure = (vestId) => {
    const key = vestId || '';
    if (!byVest.has(key)) byVest.set(key, { posts: [], replies: [] });
    return byVest.get(key);
  };
  for (const th of threads) {
    if (isUserAuthoredForumThread(th, user)) ensure(th.authorVestId || '').posts.push(th);
    const walk = (rows, floorBase) => {
      (Array.isArray(rows) ? rows : []).forEach((r, idx) => {
        if (isUserAuthoredForumThread(r, user)) {
          ensure(r.authorVestId || '').replies.push({
            threadId: th.id,
            threadTitle: th.title || '无标题',
            floor: floorBase != null ? floorBase : idx + 1,
            content: r.content || '',
            timestamp: r.timestamp || th.timestamp || 0,
          });
        }
        if (Array.isArray(r.childReplies) && r.childReplies.length) walk(r.childReplies, floorBase != null ? floorBase : idx + 1);
      });
    };
    walk(th.replies, null);
  }
  return byVest;
}

function renderBadgeSelect(selectedBadge = '') {
  const isPreset = FORUM_VEST_BADGE_PRESETS.some((b) => b.label === selectedBadge);
  const opts = [
    '<option value="">（不显示身份组）</option>',
    ...FORUM_VEST_BADGE_PRESETS.map((b) => `<option value="${e(b.label)}" ${selectedBadge === b.label ? 'selected' : ''}>${e(b.label)}</option>`),
    `<option value="__custom__" ${!isPreset && selectedBadge ? 'selected' : ''}>自定义…</option>`,
  ];
  return opts.join('');
}

export default async function render(container, params) {
  const user = await ensureDefaultUser();
  const userId = user?.id || null;
  const threads = await loadThreadsForUser(userId);
  const vests = userId ? await listForumVests(userId) : [];
  const profile = await loadForumProfile(userId, user);
  const inboxSnapshot = userId
    ? await buildForumInboxSnapshot({ user, threads, forumProfile: profile, vests })
    : { unreadCount: 0 };
  const selfName = profile.displayName || resolveSelfDisplayName(user);
  const activity = collectIdentityActivity(threads, { ...user, nickname: selfName });
  const detailVestId = params?.vestId != null ? String(params.vestId) : null;
  container.className = 'page forum-profile-page';

  function activityFor(vestId) {
    const bucket = activity.get(vestId || '') || { posts: [], replies: [] };
    return { postCount: bucket.posts.length, replyCount: bucket.replies.length, bucket };
  }

  function renderVestCard(vestId, displayId, badge, deletable) {
    const { postCount, replyCount } = activityFor(vestId);
    const avatar = resolveDefaultAvatar('forum');
    return `
      <div class="forum-vest-card" data-vest-card="${e(vestId)}">
        <div class="forum-vest-card-main" data-vest-open="${e(vestId)}">
          <img class="forum-vest-avatar" src="${e(avatar)}" alt="">
          <span class="forum-vest-card-copy"><span class="forum-vest-name">${e(displayId)}${badge ? `<span class="forum-author-badge">${e(badge)}</span>` : ''}</span>
          <span class="forum-vest-stats">发帖 ${postCount} · 回复 ${replyCount}</span></span>
        </div>
        <div class="forum-vest-card-actions">
          ${deletable ? `<button type="button" class="btn btn-xs btn-outline" data-vest-edit="${e(vestId)}">编辑</button>` : ''}
          ${deletable ? `<button type="button" class="btn btn-xs btn-outline is-danger" data-vest-delete="${e(vestId)}">删除</button>` : ''}
        </div>
      </div>`;
  }

  function renderDetailView(vestId) {
    const { bucket } = activityFor(vestId);
    const name = vestId ? (vests.find((v) => v.id === vestId)?.displayId || '未知马甲') : selfName;
    const postsHtml = bucket.posts.length
      ? bucket.posts.map((t) => `
        <button type="button" class="forum-vest-detail-row" data-open-thread="${e(t.id)}">
          <div class="forum-vest-detail-title">${e(t.title || '无标题')}</div>
          <div class="forum-vest-detail-meta">${e(formatTime(t.timestamp))}</div>
        </button>`).join('')
      : '<div class="text-hint">还没有以这个身份发过主帖</div>';
    const repliesHtml = bucket.replies.length
      ? bucket.replies.map((r) => `
        <button type="button" class="forum-vest-detail-row" data-open-thread="${e(r.threadId)}">
          <div class="forum-vest-detail-title">回复于《${e(r.threadTitle)}》</div>
          <div class="forum-vest-detail-body">${e(String(r.content || '').slice(0, 60))}</div>
          <div class="forum-vest-detail-meta">${e(formatTime(r.timestamp))}</div>
        </button>`).join('')
      : '<div class="text-hint">还没有以这个身份回复过楼层</div>';
    return `
      <div class="card-block">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>${e(name)} 的动态</strong>
          <button type="button" class="btn btn-xs btn-outline" data-vest-close-detail>收起</button>
        </div>
      </div>
      <div class="card-block">
        <div class="forum-vest-detail-label">主帖</div>
        ${postsHtml}
      </div>
      <div class="card-block">
        <div class="forum-vest-detail-label">楼层回复</div>
        ${repliesHtml}
      </div>`;
  }

  const prevScroll = captureScrollerTop(container, '.page-scroll');
  const selfActivity = activityFor('');
  container.innerHTML = `
    <header class="navbar forum-navbar forum-profile-navbar">
      <button type="button" class="forum-nav-icon fvh-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">论坛主页</h1>
      <button type="button" class="forum-nav-icon fvh-new" aria-label="新建马甲">${icon('plus')}</button>
    </header>
    <div class="page-scroll forum-profile-scroll">
      ${detailVestId != null
        ? renderDetailView(detailVestId)
        : `
        <section class="forum-profile-hero">
          <button type="button" class="forum-profile-avatar" data-profile-edit aria-label="编辑论坛主页">
            <img src="${e(profile.avatar || resolveDefaultAvatar('forum'))}" alt="">
          </button>
          <div class="forum-profile-copy">
            <h2>${e(selfName)}</h2>
            <p>${e(profile.signature || '还没有论坛签名')}</p>
          </div>
          <button type="button" class="forum-profile-edit" data-profile-edit>${icon('edit')}<span>编辑</span></button>
        </section>
        <section class="forum-profile-stats">
          <div><strong>${selfActivity.postCount}</strong><span>主帖</span></div>
          <div><strong>${selfActivity.replyCount}</strong><span>回复</span></div>
          <div><strong>${vests.length}</strong><span>马甲</span></div>
        </section>
        <button type="button" class="forum-profile-inbox-entry" data-forum-inbox>
          <span>${icon('message')}</span>
          <strong>论坛收件箱</strong>
          <small>私信与回复我的${inboxSnapshot.unreadCount ? `<b class="forum-inbox-unread-badge">${Math.min(99, inboxSnapshot.unreadCount)}</b>` : ''}</small>
          <span>${icon('chevron')}</span>
        </button>
        <section class="forum-profile-section">
          <div class="forum-profile-section-head"><h3>身份</h3><span>本人和马甲分开记录</span></div>
          ${renderVestCard('', selfName, '', false)}
          ${vests.length ? vests.map((v) => renderVestCard(v.id, v.displayId, v.badge, true)).join('') : '<div class="forum-profile-empty">还没有马甲</div>'}
        </section>`}
    </div>
  `;
  restoreScrollerTop(container, '.page-scroll', prevScroll);

  container.querySelector('.fvh-back')?.addEventListener('click', () => back());

  container.querySelectorAll('[data-vest-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const vestId = el.getAttribute('data-vest-open') || '';
      navigate('forum-vest-home', { vestId }, true);
    });
  });
  container.querySelector('[data-vest-close-detail]')?.addEventListener('click', () => {
    navigate('forum-vest-home', {}, true);
  });
  container.querySelectorAll('[data-open-thread]').forEach((el) => {
    el.addEventListener('click', () => {
      navigate('forum-detail', { threadId: el.getAttribute('data-open-thread') });
    });
  });

  function openProfileForm() {
    let pendingAvatar = profile.avatar || '';
    const { close, root } = openGlobalModal(`
      <div class="modal-header">
        <h3>编辑论坛主页</h3>
        <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <div class="forum-profile-edit-avatar">
          <button type="button" class="forum-profile-avatar fvh-profile-avatar-preview" aria-label="更换头像"></button>
          <button type="button" class="btn btn-sm btn-outline fvh-profile-avatar-pick">更换头像</button>
          <input type="file" accept="image/*" class="fvh-profile-avatar-file" hidden>
        </div>
        <div class="form-group">
          <label class="form-label">论坛昵称</label>
          <input type="text" class="form-input fvh-profile-name" maxlength="40" value="${e(profile.displayName)}">
        </div>
        <div class="form-group">
          <label class="form-label">论坛签名</label>
          <textarea class="form-input fvh-profile-signature" rows="3" maxlength="120">${e(profile.signature)}</textarea>
        </div>
        <button type="button" class="btn btn-primary fvh-profile-save" style="width:100%;">保存</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    const preview = root.querySelector('.fvh-profile-avatar-preview');
    const fileInput = root.querySelector('.fvh-profile-avatar-file');
    const paint = () => {
      if (!preview) return;
      preview.innerHTML = pendingAvatar
        ? `<img src="${e(pendingAvatar)}" alt="">`
        : `<img src="${e(resolveDefaultAvatar('forum'))}" alt="">`;
    };
    paint();
    preview?.addEventListener('click', () => fileInput?.click());
    root.querySelector('.fvh-profile-avatar-pick')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const result = await fileToCroppedOptimizedAvatarDataUrl(file);
        if (result?.dataUrl) pendingAvatar = result.dataUrl;
        paint();
      } catch (error) {
        showToast(String(error?.message || error || '头像处理失败'));
      } finally {
        event.target.value = '';
      }
    });
    root.querySelector('.fvh-profile-save')?.addEventListener('click', async () => {
      const displayName = String(root.querySelector('.fvh-profile-name')?.value || '').trim();
      if (!displayName) {
        showToast('请填写论坛昵称');
        return;
      }
      await saveForumProfile(userId, {
        displayName,
        signature: root.querySelector('.fvh-profile-signature')?.value || '',
        avatar: pendingAvatar,
      }, user);
      close();
      showToast('论坛主页已保存');
      await render(container, params);
    });
  }

  container.querySelectorAll('[data-profile-edit]').forEach((btn) => {
    btn.addEventListener('click', openProfileForm);
  });
  container.querySelector('[data-forum-inbox]')?.addEventListener('click', () => {
    navigate('forum-inbox', {});
  });

  function openVestForm(existing) {
    const { close, root } = openGlobalModal(`
      <div class="modal-header">
        <h3>${existing ? '编辑马甲' : '新建马甲'}</h3>
        <button type="button" class="navbar-btn modal-close-btn" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">马甲 ID / 昵称</label>
          <input type="text" class="form-input fvh-form-name" placeholder="发帖时展示的名字" value="${e(existing?.displayId || '')}" />
        </div>
        <div class="form-group">
          <label class="form-label">身份组</label>
          <select class="form-input fvh-form-badge">${renderBadgeSelect(existing?.badge || '')}</select>
        </div>
        <div class="form-group fvh-form-custom-badge-group" hidden>
          <label class="form-label">自定义身份组文案</label>
          <input type="text" class="form-input fvh-form-custom-badge" placeholder="例如：老玩家" value="${(!FORUM_VEST_BADGE_PRESETS.some((b) => b.label === existing?.badge) && existing?.badge) ? e(existing.badge) : ''}" />
        </div>
        <button type="button" class="btn btn-primary fvh-form-submit" style="width:100%;margin-top:8px;">${existing ? '保存' : '创建'}</button>
      </div>
    `);
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);
    const badgeSelect = root.querySelector('.fvh-form-badge');
    const customGroup = root.querySelector('.fvh-form-custom-badge-group');
    const syncCustomVisibility = () => {
      customGroup.hidden = badgeSelect.value !== '__custom__';
    };
    badgeSelect?.addEventListener('change', syncCustomVisibility);
    syncCustomVisibility();
    root.querySelector('.fvh-form-submit')?.addEventListener('click', async () => {
      const displayId = (root.querySelector('.fvh-form-name')?.value || '').trim();
      if (!displayId) {
        showToast('请填写马甲 ID');
        return;
      }
      const badgeValue = badgeSelect.value === '__custom__'
        ? (root.querySelector('.fvh-form-custom-badge')?.value || '').trim()
        : badgeSelect.value;
      if (existing) {
        await updateForumVest(userId, existing.id, { displayId, badge: badgeValue });
        showToast('已保存');
      } else {
        await createForumVest(userId, { displayId, badge: badgeValue });
        showToast('已创建马甲');
      }
      close();
      await render(container, params);
    });
  }

  container.querySelector('.fvh-new')?.addEventListener('click', () => {
    if (!userId) {
      showToast('请先选择用户档案');
      return;
    }
    openVestForm(null);
  });
  container.querySelectorAll('[data-vest-edit]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const vest = vests.find((v) => v.id === btn.getAttribute('data-vest-edit'));
      if (vest) openVestForm(vest);
    });
  });
  container.querySelectorAll('[data-vest-delete]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const vestId = btn.getAttribute('data-vest-delete');
      if (!window.confirm('删除这个马甲？历史帖子/回复仍会保留当时的署名与身份组标签。')) return;
      await deleteForumVest(userId, vestId);
      showToast('已删除马甲');
      await render(container, params);
    });
  });
}
