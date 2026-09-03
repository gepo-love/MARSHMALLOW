import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { loadForumProfile } from '../core/forum-vests.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';
import {
  generateForumActorDossier,
  isForumPasserbyActor,
  loadForumActorDossier,
  loadForumActorRegistry,
  materializeForumDossierFootprint,
  materializeForumDossierSection,
  openForumActorPrivateChat,
  promoteForumPasserby,
  resolveForumActor,
} from '../core/forum/forum-actors.js';
import {
  loadForumEngagement,
  toggleForumActorFollow,
} from '../core/forum/forum-engagement.js';
import { getForumRelationship } from '../core/forum/forum-relationships.js';

function e(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function t(timestamp = 0) {
  return new Date(timestamp || Date.now()).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function actorIdOf(row = {}) {
  return String(row.forumActorId || row.authorRoleId || '').trim();
}

function authorNameOf(row = {}) {
  return String(row.authorName || row.author || '论坛匿名').trim() || '论坛匿名';
}

function nameKey(value = '') {
  return String(value || '').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
}

function actionLabel(kind = '') {
  return ({
    post: '发布过',
    reply: '回复过',
    comment: '评论过',
    repost: '转发过',
    visit: '浏览过',
    favorite: '收藏过',
  })[String(kind || '').trim()] || '留下痕迹';
}

async function loadForumThreads(userId = '') {
  try {
    return await db.getAllByIndex('forumThreads', 'userId', userId);
  } catch (_) {
    return (await db.getAllRecords('forumThreads')).filter((row) => row?.userId === userId);
  }
}

function collectActivity(threads = [], actorId = '', displayName = '', sectionNames = new Map()) {
  const activities = [];
  const sectionCounts = new Map();
  const interactionCounts = new Map();
  const sameActor = (row) => actorIdOf(row) === actorId
    || (!actorIdOf(row) && displayName && authorNameOf(row) === displayName);
  const bumpSection = (thread) => {
    const sectionId = String(thread.sectionId || '').trim();
    const label = sectionNames.get(sectionId) || '社区广场';
    const current = sectionCounts.get(sectionId || label) || { sectionId, name: label, count: 0 };
    current.count += 1;
    sectionCounts.set(sectionId || label, current);
  };
  const bumpInteraction = (name) => {
    const label = String(name || '').trim();
    if (!label || label === displayName) return;
    interactionCounts.set(label, (interactionCounts.get(label) || 0) + 1);
  };

  for (const thread of threads) {
    let participated = false;
    if (sameActor(thread)) {
      participated = true;
      bumpSection(thread);
      activities.push({
        kind: 'post',
        threadId: thread.id,
        sectionId: String(thread.sectionId || '').trim(),
        sectionName: sectionNames.get(String(thread.sectionId || '').trim()) || '社区广场',
        title: thread.title || '无标题',
        content: thread.content || '',
        timestamp: thread.timestamp || 0,
      });
    }
    const walk = (rows = [], parentAuthor = '') => {
      for (const row of Array.isArray(rows) ? rows : []) {
        if (sameActor(row)) {
          participated = true;
          bumpSection(thread);
          bumpInteraction(row.replyToAuthor || parentAuthor);
          activities.push({
            kind: 'reply',
            threadId: thread.id,
            sectionId: String(thread.sectionId || '').trim(),
            sectionName: sectionNames.get(String(thread.sectionId || '').trim()) || '社区广场',
            title: thread.title || '无标题',
            content: row.content || '',
            timestamp: row.timestamp || thread.timestamp || 0,
          });
        } else if (sameActor(thread) || participated) {
          bumpInteraction(authorNameOf(row));
        }
        walk(row.childReplies, authorNameOf(row));
      }
    };
    walk(thread.replies, authorNameOf(thread));
    if (participated && !sameActor(thread)) bumpInteraction(authorNameOf(thread));
  }
  return {
    activities: activities.sort((a, b) => b.timestamp - a.timestamp),
    sections: [...sectionCounts.values()].sort((a, b) => b.count - a.count),
    interactions: [...interactionCounts.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function renderSectionTrail(row = {}, { inferred = false } = {}) {
  const sectionId = String(row.sectionId || '').trim();
  const dossierId = String(row.id || '').trim();
  const attrs = sectionId
    ? `data-open-section="${e(sectionId)}"`
    : `data-dossier-section="${e(dossierId)}"`;
  return `
    <button type="button" class="forum-trail-section${inferred ? ' is-inferred' : ''}" ${attrs}>
      <span>${e(row.name || '社区广场')}</span>
      <small>${inferred ? e(row.clue || '主页留下过痕迹') : `${Number(row.count || 0)} 条公开发言`}</small>
    </button>
  `;
}

function renderObservedFootprint(row = {}) {
  return `
    <button type="button" class="forum-footprint-row is-observed" data-open-thread="${e(row.threadId)}">
      <span class="forum-footprint-dot" aria-hidden="true"></span>
      <span class="forum-footprint-copy">
        <span class="forum-footprint-meta"><b>${actionLabel(row.kind)}</b><i>${e(row.sectionName)}</i><time>${e(t(row.timestamp))}</time></span>
        <strong>${e(row.title || '无标题')}</strong>
        <span class="forum-footprint-excerpt">${e(String(row.content || '').replace(/\s+/g, ' ').slice(0, 150))}</span>
      </span>
      <span class="forum-footprint-state">原帖 ›</span>
    </button>
  `;
}

function renderInferredFootprint(row = {}) {
  const openAttrs = row.threadId
    ? `data-open-thread="${e(row.threadId)}"`
    : `data-dossier-footprint="${e(row.id)}"`;
  return `
    <button type="button" class="forum-footprint-row is-inferred" ${openAttrs}>
      <span class="forum-footprint-dot" aria-hidden="true"></span>
      <span class="forum-footprint-copy">
        <span class="forum-footprint-meta"><b>${e(row.actionLabel || actionLabel(row.kind))}</b><i>${e(row.sectionName)}</i>${row.timestampHint ? `<time>${e(row.timestampHint)}</time>` : ''}</span>
        <strong>${e(row.title || '没有标题的讨论')}</strong>
        ${row.excerpt ? `<span class="forum-footprint-excerpt">${e(row.excerpt)}</span>` : ''}
        ${row.evidence ? `<span class="forum-footprint-evidence">${e(row.evidence)}</span>` : ''}
      </span>
      <span class="forum-footprint-state">${row.threadId ? '原帖 ›' : '补全 ›'}</span>
    </button>
  `;
}

export default async function render(container, params) {
  const user = await ensureDefaultUser();
  const userId = user?.id || '';
  const actorId = String(params?.actorId || '').trim();
  const actor = await resolveForumActor(actorId);
  if (!actor || !userId) {
    container.className = 'page';
    container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">找不到这个论坛身份</div></div>';
    return;
  }
  const forumProfile = await loadForumProfile(userId, user);
  const threads = await loadForumThreads(userId);
  const metaRow = await db.get('settings', `forumMeta_${userId}`).catch(() => null);
  const sections = Array.isArray(metaRow?.value?.sections) ? metaRow.value.sections : [];
  const sectionNames = new Map(sections.map((row) => [row.id, row.name || row.id]));
  const displayName = String(params?.displayName || actor?.forumIdentity?.displayName || actor.name || '论坛网友').trim();
  const signature = String(actor?.forumIdentity?.signature || actor.notes || '').trim();
  const avatar = String(actor.avatar || '').trim();
  const passerby = isForumPasserbyActor(actor);
  const activity = collectActivity(threads, actorId, displayName, sectionNames);
  const registry = await loadForumActorRegistry(userId);
  const belongsToForum = activity.activities.length > 0
    || registry.actors.some((row) => row.actorId === actorId);
  if (!belongsToForum) {
    container.className = 'page';
    container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">这个身份不属于当前论坛</div></div>';
    return;
  }
  const postCount = activity.activities.filter((row) => row.kind === 'post').length;
  const replyCount = activity.activities.filter((row) => row.kind === 'reply').length;
  const topInteractions = activity.interactions.slice(0, 4);
  const dossier = await loadForumActorDossier(userId, actorId, displayName);
  const engagement = await loadForumEngagement(userId);
  const followed = engagement.followedActors.some((row) => row.actorId === actorId);
  const relationship = await getForumRelationship(userId, actorId);
  const observedSectionKeys = new Set(activity.sections.map((row) => nameKey(row.name)));
  const inferredSections = (dossier?.sections || []).filter((row) => !observedSectionKeys.has(nameKey(row.name)));

  container.className = 'page forum-profile-page forum-actor-profile-page';
  container.innerHTML = `
    <header class="navbar forum-navbar forum-profile-navbar">
      <button type="button" class="forum-nav-icon" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${e(displayName)}</h1>
      <span class="forum-nav-icon" aria-hidden="true"></span>
    </header>
    <main class="page-scroll forum-profile-scroll forum-actor-profile-scroll">
      <section class="forum-profile-hero forum-actor-profile-hero">
        <div class="forum-profile-avatar" aria-hidden="true">
          <img src="${e(avatar || resolveDefaultAvatar('forum'))}" alt="">
        </div>
        <div class="forum-profile-copy">
          <h2>${e(displayName)}</h2>
          <p>${e(signature || (passerby ? '偶尔路过，偶尔认真回帖' : '这个论坛号还没有签名'))}</p>
        </div>
      </section>
      <section class="forum-profile-stats" aria-label="公开发言统计">
        <div><strong>${postCount}</strong><span>主帖</span></div>
        <div><strong>${replyCount}</strong><span>回复</span></div>
        <div><strong>${activity.sections.length}</strong><span>出现过的版块</span></div>
      </section>
      <section class="forum-actor-actions${passerby ? ' has-promote' : ''}">
        <button type="button" class="forum-profile-action is-primary" data-ingredient>${dossier ? '再翻一页' : '查查 TA'}</button>
        <button type="button" class="forum-profile-action${followed ? ' is-active' : ''}" data-follow aria-pressed="${followed}">${followed ? '已关注' : '关注'}</button>
        <button type="button" class="forum-profile-action" data-private-chat>${icon('message')}<span>私聊</span></button>
        ${passerby ? '<button type="button" class="forum-profile-action" data-promote>加入通讯录</button>' : ''}
      </section>
      <div class="forum-profile-relation">
        <strong>${e(relationship.stage.label)}</strong>
        <span>${topInteractions.length ? `常和 ${e(topInteractions.map(([name]) => name).join('、'))} 同楼` : '公开互动还不多'}${relationship.privateOpened ? ' · 已私聊' : ''}</span>
      </div>
      <section class="forum-trail-block">
        <div class="forum-profile-section-head"><h3>常逛版块</h3><span>${activity.sections.length + inferredSections.length} 个线索</span></div>
        <div class="forum-trail-sections">
          ${activity.sections.map((row) => renderSectionTrail(row)).join('')}
          ${inferredSections.map((row) => renderSectionTrail(row, { inferred: true })).join('')}
          ${!activity.sections.length && !inferredSections.length ? '<div class="forum-profile-empty">还没翻到版块痕迹</div>' : ''}
        </div>
      </section>
      <section class="forum-trail-block forum-footprints-block">
        <div class="forum-profile-section-head"><h3>主页足迹</h3><span>${activity.activities.length + (dossier?.footprints?.length || 0)} 条</span></div>
        <div class="forum-footprint-list">
          ${activity.activities.slice(0, 24).map(renderObservedFootprint).join('')}
          ${(dossier?.footprints || []).map(renderInferredFootprint).join('')}
          ${!activity.activities.length && !dossier?.footprints?.length ? '<div class="forum-profile-empty">点“查查 TA”翻一页公开足迹</div>' : ''}
        </div>
      </section>
    </main>
  `;
  const scrollRoot = container.querySelector('.forum-profile-scroll');
  if (scrollRoot) scrollRoot.scrollTop = 0;

  const materialize = async (button, footprint, destination = 'thread') => {
    if (!footprint) return;
    const previous = button.textContent;
    button.disabled = true;
    button.classList.add('is-loading');
    try {
      const result = await materializeForumDossierFootprint({
        user,
        actorId,
        displayName,
        footprint,
      });
      if (destination === 'section') navigate('forum', { sectionId: result.sectionId });
      else navigate('forum-detail', { threadId: result.thread.id });
    } catch (error) {
      showToast(String(error?.message || '这条足迹暂时补不出来'));
      button.disabled = false;
      button.classList.remove('is-loading');
      button.textContent = previous;
    }
  };

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  container.querySelector('[data-ingredient]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = '翻主页中…';
    try {
      await generateForumActorDossier({
        userId,
        actorId,
        displayName,
        publicActivity: activity.activities,
        sectionSummary: activity.sections.slice(0, 5).map((row) => `${row.name}(${row.count})`).join('、'),
        sectionContexts: activity.sections
          .map((row) => sections.find((section) => String(section?.id || '').trim() === row.sectionId))
          .filter(Boolean),
        interactionSummary: topInteractions.map(([name, count]) => `${name}(${count})`).join('、'),
      });
      showToast('又翻到一些公开足迹');
      await render(container, params);
    } catch (error) {
      showToast(String(error?.message || '暂时没翻到更多足迹'));
      button.disabled = false;
      button.textContent = previousText;
    }
  });
  container.querySelectorAll('[data-open-thread]').forEach((button) => {
    button.addEventListener('click', () => navigate('forum-detail', { threadId: button.getAttribute('data-open-thread') }));
  });
  container.querySelectorAll('[data-open-section]').forEach((button) => {
    button.addEventListener('click', () => navigate('forum', { sectionId: button.getAttribute('data-open-section') }));
  });
  container.querySelectorAll('[data-dossier-footprint]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-dossier-footprint') || '';
      const footprint = dossier?.footprints?.find((row) => row.id === id);
      void materialize(button, footprint, 'thread');
    });
  });
  container.querySelectorAll('[data-dossier-section]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-dossier-section') || '';
      const section = dossier?.sections?.find((row) => row.id === id);
      if (!section) return;
      button.disabled = true;
      button.classList.add('is-loading');
      try {
        const result = await materializeForumDossierSection({
          userId,
          actorId,
          displayName,
          section,
        });
        navigate('forum', { sectionId: result.sectionId });
      } catch (error) {
        showToast(String(error?.message || '这个版块暂时进不去'));
        button.disabled = false;
        button.classList.remove('is-loading');
      }
    });
  });
  container.querySelector('[data-follow]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await toggleForumActorFollow(userId, { actorId, displayName });
      button.classList.toggle('is-active', result.active);
      button.setAttribute('aria-pressed', String(result.active));
      button.textContent = result.active ? '已关注' : '关注';
    } catch (error) {
      showToast(String(error?.message || '操作失败'));
    } finally {
      button.disabled = false;
    }
  });
  container.querySelector('[data-private-chat]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const chat = await openForumActorPrivateChat({
        user,
        actor,
        actorDisplayName: displayName,
        actorAvatar: avatar,
        actorSignature: signature,
        userForumProfile: forumProfile,
      });
      navigate('chat/thread', { chatId: chat.id, from: 'forum' });
    } catch (error) {
      showToast(String(error?.message || '无法建立论坛私聊'));
      button.disabled = false;
    }
  });
  container.querySelector('[data-promote]')?.addEventListener('click', async (event) => {
    if (!window.confirm(`把「${displayName}」加入通讯录？论坛身份和私聊记录会继续保留。`)) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await promoteForumPasserby({ userId, actorId });
      showToast('已加入通讯录');
      navigate('chat/thread', { chatId: result.chat.id });
    } catch (error) {
      showToast(String(error?.message || '加入通讯录失败'));
      button.disabled = false;
    }
  });
}
