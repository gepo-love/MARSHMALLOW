import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { escAttr } from '../components/scrapbook-illustrations.js';
import { showToast } from '../components/toast.js';
import { fileToCroppedOptimizedAvatarDataUrl, fileToCroppedCompressedDataUrl, IMAGE_CROP_PRESETS } from '../components/image-crop-modal.js';
import { loadingBtnContent, GEN_IMAGE_HINT } from '../components/generation-busy.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listCharacters, getCharacter, saveCharacter } from '../core/character-store.js';
import { isAnonymousNpcRecord } from '../models/character.js';
import { ensurePrivateChat } from '../core/chat-store.js';
import { acceptAnonymousReveal } from '../core/anonymous-reveal.js';
import {
  loadAnonymousSpaceState,
  loadAnonymousSpaceUserProfile,
  saveUserSpaceProfile,
  saveActorSpaceProfile,
  addAnonymousSpaceMessage,
  normalizeAnonymousSpaceProfile,
  syncAnonymousSpaceAvatarToChats,
  syncAnonymousSpaceIdentityToChats,
  recordAnonymousSpaceFootprint,
  appendAnonymousSpaceUnlockEvent,
  applyAnonymousSpaceUnlockResponse,
  markAnonymousSpaceUnlockPending,
  isAnonymousSpaceUnlocked,
  recordAnonymousSpaceMessageMemory,
  recordAnonymousSpaceUnlockMemory,
  recordAnonymousSpacePostCommentMemory,
  saveAnonymousSpaceState,
  setAnonymousSpacePosts,
  appendAnonymousSpacePosts,
  prependAnonymousSpacePost,
  removeAnonymousSpacePost,
  appendAnonymousSpaceFootprints,
  updateAnonymousSpacePost,
  addAnonymousSpacePostReply,
  setAnonymousSpaceGroupFootprints,
  appendAnonymousSpaceMessages,
  setAnonymousSpaceMessages,
  finalizeAnonymousSpaceFootprint,
  countAnonymousSpaceUnlockRequests,
  formatAnonymousSpaceFootprintLine,
} from '../core/anonymous-space.js';
import {
  generateActorAnonymousSpaceProfileAI,
  resolveAnonymousSpaceUnlockAI,
  supplementAnonymousSpacePostsAI,
  generateAnonymousSpaceMessagesBatchAI,
  generateAnonymousSpacePostImage,
  generateUserSpaceFootprintsAI,
} from '../core/anonymous-space-ai.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import { showGenerationErrorReport } from '../components/generation-error-report.js';
import { openImageLightbox } from '../components/image-lightbox.js';
import { resolveActorDisplayLabel, stripLeakedCharacterCodes } from '../core/chat/character-code-fallback.js';
import { getUserDisplayName } from '../models/user.js';
import { openChatCardModal } from '../components/chat-interactive-modals.js';
import { textImageBubbleHtml } from '../core/chat/card-render.js';
import { acquireNarrationGenerationLease } from '../core/narration-generation-lease.js';

function esc(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderAnonGenStatus(text, imageGen = true) {
  const hint = imageGen
    ? `<span class="social-gen-status-hint">${esc(GEN_IMAGE_HINT)}</span>`
    : '';
  return `<div class="anon-space-gen-status is-active${imageGen ? ' has-image-hint' : ''}" role="status"><span class="social-gen-status-row"><span class="btn-loading-spinner social-gen-status-spinner" aria-hidden="true"></span><span>${esc(text)}</span></span>${hint}</div>`;
}

function promptTextEditor(options = {}) {
  return new Promise((resolve) => {
    openTextEditorModal({
      ...options,
      onSave: (value) => resolve(value),
      onClosed: () => resolve(null),
    });
  });
}

function reportAnonSpaceAiError(err, scope = '匿名空间') {
  showGenerationErrorReport({
    scope,
    title: err?.reason === 'empty-api-response' ? '未抽到可用正文' : '生成失败',
    message: err?.message || '生成失败',
    rawText: err?.rawText || err?.rawResponse || '',
    reason: err?.reason || 'json-parse-failed',
    at: Date.now(),
  });
}

async function readAvatarFile(file) {
  if (!file) return '';
  if (!/^image\//.test(file.type || '')) throw new Error('请选择图片文件');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取头像失败'));
    reader.readAsDataURL(file);
  });
}

function resolveDisplayId(profile = {}) {
  return String(profile.handle || '').trim() || '匿名网友';
}

function buildAnonSpaceLabelCtx(user, characters = []) {
  return {
    user,
    userName: getUserDisplayName(user),
    characters: Object.fromEntries(characters.map((c) => [c.id, c])),
  };
}

function safeAnonSpaceLabel(value, ctx = {}, fallback = '网友') {
  return resolveActorDisplayLabel(value, { ...ctx, fallback });
}

function safeAnonSpaceText(value, ctx = {}) {
  return stripLeakedCharacterCodes(String(value || ''), { ...ctx, fallbackLabel: '某位' });
}

function renderAvatar(profile, displayId) {
  if (profile.avatar) {
    return `<img class="anon-avatar-img" src="${escAttr(profile.avatar)}" alt="">`;
  }
  return `<span>${esc(displayId.slice(0, 1))}</span>`;
}

function renderPostVisual(post = {}) {
  if (post.image) {
    return `<button type="button" class="anon-post-visual-btn" data-view-post-image="${escAttr(post.id)}" aria-label="查看配图">
      <img class="anon-post-image" src="${escAttr(post.image)}" alt="" loading="lazy" />
    </button>`;
  }
  if (post.textImage || post.imageKind === 'textimg') {
    const bubble = textImageBubbleHtml(
      { type: 'textimg', content: post.textImage },
      esc,
      { anonymous: true },
    );
    return `<button type="button" class="anon-post-visual-btn anon-post-textimg-btn" data-view-post-textimg="${escAttr(post.id)}" aria-label="查看文字图">${bubble}</button>`;
  }
  if (post.imageLoading) {
    return '<div class="anon-post-visual-pending">配图生成中…</div>';
  }
  if (post.imagePrompt) {
    return `<button type="button" class="anon-post-gen-image" data-gen-post-image="${escAttr(post.id)}">生成配图</button>`;
  }
  return '';
}

function renderPostCard(post = {}, options = {}) {
  const { unlocked = true, actorId = 'user', displayId = '匿名网友', labelCtx = {} } = options;
  const imageHtml = renderPostVisual(post);
  const repliesHtml = (post.replies || []).slice(0, 6).map((r) => `
    <div class="anon-post-reply">
      <span class="anon-post-reply-from">${esc(safeAnonSpaceLabel(r.from, labelCtx))}</span>
      <span class="anon-post-reply-text">${esc(safeAnonSpaceText(r.text, labelCtx))}</span>
    </div>
  `).join('');
  return `
    <article class="anon-feed-card anon-post-card" data-post-id="${escAttr(post.id)}">
      <div class="anon-feed-note-meta">${esc(displayId)} · ${new Date(post.timestamp || Date.now()).toLocaleString('zh-CN')}${post.mood ? ` · ${esc(post.mood)}` : ''}</div>
      <p class="anon-feed-body">${esc(safeAnonSpaceText(post.text, labelCtx))}</p>
      ${imageHtml}
      ${repliesHtml}
      ${actorId !== 'user' && unlocked ? `
        <div class="anon-post-actions">
          <button type="button" class="btn btn-sm btn-soft" data-reply-post="${escAttr(post.id)}">评论</button>
        </div>
      ` : ''}
      ${actorId === 'user' ? `
        <div class="anon-post-actions">
          <button type="button" class="btn btn-sm btn-soft" data-edit-post="${escAttr(post.id)}">编辑</button>
          <button type="button" class="btn btn-sm btn-outline" data-delete-post="${escAttr(post.id)}">删除</button>
        </div>
      ` : ''}
    </article>
  `;
}

/** 小组足迹只归在「足迹」tab 里，用时间线条目而不是动态卡片，跟说说/来访记录区分开 */
function renderGroupFootprintItem(entry = {}) {
  const actionLabel = entry.action === 'posted' ? '发帖' : (entry.action === 'commented' ? '评论' : '加入');
  return `
    <div class="anon-footprint-item">
      <span class="anon-footprint-dot" aria-hidden="true"></span>
      <div class="anon-footprint-item-body">
        <div class="anon-footprint-item-head">
          <strong>${esc(entry.groupName || '未知小组')}</strong>
          <time>${new Date(entry.timestamp || Date.now()).toLocaleString('zh-CN')}</time>
        </div>
        <p>${esc(actionLabel)}${entry.text ? `：${esc(entry.text)}` : ''}</p>
      </div>
    </div>
  `;
}

/** 「名片」页：简介/兴趣/小组这类资料信息集中在一张独立卡片里，跟动态流的卡片视觉刻意区分开 */
function renderIdCardSection({ profile = {}, displayId = '匿名网友', signatureLine = '', bioLine = '' } = {}) {
  const interests = (profile.interests || []).filter(Boolean);
  const groups = (profile.joinedGroups || []).filter(Boolean);
  return `
    <div class="anon-id-card">
      <span class="anon-id-card-badge">空间名片</span>
      <div class="anon-id-card-avatar">${renderAvatar(profile, displayId)}</div>
      <h3 class="anon-id-card-handle">${esc(displayId)}</h3>
      <p class="anon-id-card-signature">${esc(signatureLine)}</p>
      <div class="anon-id-card-divider" aria-hidden="true"></div>
      <p class="anon-id-card-bio">${esc(bioLine)}</p>
      ${interests.length ? `
        <div class="anon-id-card-section">
          <span class="anon-id-card-label">兴趣</span>
          <div class="anon-id-card-tags">${interests.map((t) => `<span class="anon-id-card-tag">${esc(t)}</span>`).join('')}</div>
        </div>
      ` : ''}
      ${groups.length ? `
        <div class="anon-id-card-section">
          <span class="anon-id-card-label">小组</span>
          <div class="anon-id-card-groups">${groups.map((g) => `<span class="anon-id-card-group">${esc(g)}</span>`).join('')}</div>
        </div>
      ` : ''}
    </div>
  `;
}
function renderUnlockEventCard(event = {}, labelCtx = {}) {
  const type = String(event.type || 'request');
  if (type === 'request') {
    return `
      <article class="anon-unlock-card is-request">
        <div class="anon-unlock-card-label">解锁请求</div>
        <p class="anon-unlock-card-text">${esc(safeAnonSpaceText(event.text, labelCtx) || '请求查看匿名空间')}</p>
        <time class="anon-unlock-card-time">${new Date(event.timestamp || Date.now()).toLocaleString('zh-CN')}</time>
      </article>
    `;
  }
  const granted = event.granted === true;
  return `
    <article class="anon-unlock-card ${granted ? 'is-granted' : 'is-denied'}">
      <div class="anon-unlock-card-label">${granted ? '已同意' : '已婉拒'}</div>
      <p class="anon-unlock-card-from">${esc(safeAnonSpaceLabel(event.from, labelCtx, '对方'))}</p>
      <p class="anon-unlock-card-text">${esc(safeAnonSpaceText(event.text, labelCtx))}</p>
      <time class="anon-unlock-card-time">${new Date(event.timestamp || Date.now()).toLocaleString('zh-CN')}</time>
    </article>
  `;
}

export default async function render(container, params = {}) {
  const user = await ensureDefaultUser();
  let actorId = String(params.actorId || 'user').trim() || 'user';
  const characters = await listCharacters({
    userId: user.id,
    identityScoped: true,
  }).catch(() => []);
  // 匿名路人是功能内部角色，不绑定任何用户身份，因此会被上面的通讯录隔离过滤。
  // 这里只按当前页面携带的精确 actorId 补载这一位路人，不能放开其它身份的普通角色。
  if (actorId !== 'user' && !characters.some((character) => character.id === actorId)) {
    const requestedActor = await getCharacter(actorId).catch(() => null);
    if (isAnonymousNpcRecord(requestedActor)) characters.push(requestedActor);
  }
  let state = await loadAnonymousSpaceState(user.id, actorId);
  let profile = normalizeAnonymousSpaceProfile(state.profile);
  const userSpaceProfile = normalizeAnonymousSpaceProfile(await loadAnonymousSpaceUserProfile(user.id));
  const visitorHandle = resolveDisplayId(userSpaceProfile);
  let feedTab = 'feed';
  let unlockBusy = false;
  let generatingSpace = false;
  let generatingKind = '';
  let contactBusy = false;
  let unlocked = isAnonymousSpaceUnlocked(state, actorId);
  let unlockStatus = '';
  let visitFootprintId = '';
  let visitStartedAt = Date.now();

  async function claimSpaceGeneration() {
    const lease = await acquireNarrationGenerationLease('anon-space', `${user.id}:${actorId}`);
    if (!lease.acquired) showToast('这个匿名空间已有生成任务正在进行');
    return lease.acquired ? lease : null;
  }

  if (actorId !== 'user') {
    visitFootprintId = `fp_${Date.now()}`;
    visitStartedAt = Date.now();
    state = await recordAnonymousSpaceFootprint(user.id, actorId, {
      id: visitFootprintId,
      visitorId: 'user',
      visitorName: visitorHandle,
      note: '正在看空间',
    });
    profile = normalizeAnonymousSpaceProfile(state.profile);
    unlocked = isAnonymousSpaceUnlocked(state, actorId);
    if (state.unlock?.status === 'denied' && state.unlock?.responseText) {
      unlockStatus = state.unlock.responseText;
    } else if (unlocked) {
      unlockStatus = '已解锁';
    }
  }

  container.className = 'page anon-page anon-space-page';

  async function endVisitFootprint() {
    if (actorId === 'user' || !visitFootprintId) return;
    const durationMs = Date.now() - visitStartedAt;
    state = await finalizeAnonymousSpaceFootprint(user.id, actorId, visitFootprintId, durationMs);
    visitFootprintId = '';
  }

  function openComposePostModal(existingPost = null) {
    const host = document.getElementById('modal-container');
    if (!host || actorId !== 'user') return;
    const editing = existingPost && typeof existingPost === 'object';
    const postId = editing ? clean(existingPost.id) : '';
    let draftImage = editing ? clean(existingPost.image) : '';
    host.innerHTML = `
      <div class="modal-overlay anon-space-edit-overlay" data-compose-overlay>
        <div class="modal-sheet anon-modal-sheet anon-space-edit-sheet" role="dialog" aria-modal="true" data-compose-sheet>
          <div class="modal-header">
            <h3>${editing ? '编辑动态' : '发动态'}</h3>
            <button type="button" class="btn btn-sm btn-soft" data-compose-close>关闭</button>
          </div>
          <div class="modal-body anon-space-edit-body">
            <label class="form-label">说说</label>
            <textarea class="form-input anon-compose-text" rows="4" maxlength="200" placeholder="写点什么…">${esc(editing ? existingPost.text : '')}</textarea>
            <label class="form-label">心情标签</label>
            <input type="text" class="form-input anon-compose-mood" value="${esc(editing ? existingPost.mood : '')}" maxlength="16" placeholder="可选" />
            <label class="form-label">配图</label>
            <div class="anon-compose-image-row">
              <button type="button" class="btn btn-outline btn-sm" data-compose-pick-image>选择图片</button>
              <button type="button" class="btn btn-soft btn-sm" data-compose-clear-image ${draftImage ? '' : 'hidden'}>移除配图</button>
              <input type="file" class="anon-compose-image-file" accept="image/*" hidden />
            </div>
            <div class="anon-compose-image-preview" ${draftImage ? '' : 'hidden'}>
              ${draftImage ? `<img src="${escAttr(draftImage)}" alt="" />` : ''}
            </div>
          </div>
          <div class="modal-footer anon-space-edit-actions">
            <button type="button" class="btn btn-primary" data-compose-save>${editing ? '保存' : '发布'}</button>
          </div>
        </div>
      </div>
    `;
    host.classList.add('active');
    const close = () => {
      host.classList.remove('active');
      host.innerHTML = '';
    };
    const previewEl = host.querySelector('.anon-compose-image-preview');
    const clearBtn = host.querySelector('[data-compose-clear-image]');
    const refreshPreview = () => {
      if (!previewEl) return;
      if (draftImage) {
        previewEl.hidden = false;
        previewEl.innerHTML = `<img src="${escAttr(draftImage)}" alt="" />`;
        clearBtn?.removeAttribute('hidden');
      } else {
        previewEl.hidden = true;
        previewEl.innerHTML = '';
        clearBtn?.setAttribute('hidden', '');
      }
    };
    host.querySelector('[data-compose-overlay]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) close();
    });
    host.querySelector('[data-compose-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-compose-close]')?.addEventListener('click', close);
    host.querySelector('[data-compose-pick-image]')?.addEventListener('click', () => {
      host.querySelector('.anon-compose-image-file')?.click();
    });
    host.querySelector('.anon-compose-image-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        draftImage = await readAvatarFile(file);
        refreshPreview();
      } catch (err) {
        showToast(err?.message || '图片读取失败');
      }
    });
    clearBtn?.addEventListener('click', () => {
      draftImage = '';
      refreshPreview();
    });
    host.querySelector('[data-compose-save]')?.addEventListener('click', async () => {
      const text = String(host.querySelector('.anon-compose-text')?.value || '').trim();
      if (!text) {
        showToast('写点内容再发布');
        return;
      }
      const mood = String(host.querySelector('.anon-compose-mood')?.value || '').trim();
      const patch = {
        text,
        mood,
        image: draftImage,
        imageKind: draftImage ? 'photo' : '',
        textImage: '',
        imagePrompt: '',
        imageLoading: false,
        timestamp: editing ? (existingPost.timestamp || Date.now()) : Date.now(),
      };
      if (editing && postId) {
        state = await updateAnonymousSpacePost(user.id, 'user', postId, patch);
      } else {
        state = await prependAnonymousSpacePost(user.id, 'user', {
          id: `aspost_${Date.now()}`,
          ...patch,
        });
      }
      close();
      showToast(editing ? '已保存' : '已发布');
      paint({ preserveScroll: true });
    });
  }

  function clean(value = '') {
    return String(value ?? '').trim();
  }

  function openEditModal() {
    const host = document.getElementById('modal-container');
    if (!host) return;
    const draftActor = actorId === 'user' ? null : characters.find((c) => c.id === actorId);
    const canEditNpcDraft = isAnonymousNpcRecord(draftActor);
    host.innerHTML = `
      <div class="modal-overlay anon-space-edit-overlay" data-space-edit-overlay>
        <div class="modal-sheet anon-modal-sheet anon-space-edit-sheet" role="dialog" aria-modal="true" data-space-edit-sheet>
          <div class="modal-header">
            <h3>编辑匿名资料</h3>
            <button type="button" class="btn btn-sm btn-soft" data-space-edit-close>关闭</button>
          </div>
          <div class="modal-body anon-space-edit-body">
            <label class="form-label">底色网名</label>
            <input type="text" class="form-input anon-field-handle" value="${esc(profile.handle)}" placeholder="留空则建房时随机生成" maxlength="24" />
            <label class="form-label">签名</label>
            <input type="text" class="form-input anon-field-signature" value="${esc(profile.signature)}" maxlength="80" />
            <label class="form-label">状态</label>
            <input type="text" class="form-input anon-field-mood" value="${esc(profile.mood || profile.statusText)}" maxlength="40" />
            <label class="form-label">兴趣圈子</label>
            <input type="text" class="form-input anon-field-interests" value="${esc((profile.interests || []).join(' / '))}" placeholder="用 / 分隔" />
            <label class="form-label">最近加入的小组</label>
            <input type="text" class="form-input anon-field-groups" value="${esc((profile.joinedGroups || []).join(' / '))}" placeholder="用 / 分隔" />
            <label class="form-label">空间简介</label>
            <textarea class="form-input anon-field-bio" rows="3">${esc(profile.bio)}</textarea>
            ${canEditNpcDraft ? `
              <div class="anon-space-persona-draft">
                <label class="form-label">人物底稿 · 身份</label>
                <input type="text" class="form-input anon-field-role" value="${esc(draftActor.currentRole)}" placeholder="不暴露在匿名前台" maxlength="80" />
                <label class="form-label">人物底稿 · 性格</label>
                <textarea class="form-input anon-field-personality" rows="3" placeholder="反差、边界和行动逻辑">${esc(draftActor.personality)}</textarea>
                <label class="form-label">人物底稿 · 口吻</label>
                <textarea class="form-input anon-field-speech" rows="2" placeholder="用词、节奏、熟人差异">${esc(draftActor.speechStyle)}</textarea>
                <label class="form-label">人物底稿 · 背景</label>
                <textarea class="form-input anon-field-background" rows="3" placeholder="只作为后续相认与聊天背景">${esc(draftActor.anonymousPrivateDraft?.background || draftActor.promptCorpus)}</textarea>
              </div>
            ` : ''}
            ${actorId === 'user' ? `
              <label class="anon-space-lock-toggle">
                <input type="checkbox" class="anon-field-posts-locked" ${profile.postsLocked ? 'checked' : ''} />
                <span>动态上锁（访客需申请解锁才能看说说）</span>
              </label>
            ` : ''}
            <label class="form-label">管理空间对象</label>
            <select class="form-input anon-field-actor">
              <option value="user"${actorId === 'user' ? ' selected' : ''}>我的匿名空间</option>
              ${characters.map((c) => `<option value="${escAttr(c.id)}"${actorId === c.id ? ' selected' : ''}>${esc(c.name || c.realName || '未命名角色')}</option>`).join('')}
            </select>
          </div>
          <div class="modal-footer anon-space-edit-actions">
            ${profile.avatar ? '<button type="button" class="btn btn-outline" data-clear-avatar>清除头像</button>' : ''}
            <button type="button" class="btn btn-primary" data-save-profile>保存</button>
          </div>
        </div>
      </div>
    `;
    host.classList.add('active');
    const close = () => {
      host.classList.remove('active');
      host.innerHTML = '';
    };
    host.querySelector('[data-space-edit-overlay]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) close();
    });
    host.querySelector('[data-space-edit-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('[data-space-edit-close]')?.addEventListener('click', close);
    host.querySelector('[data-save-profile]')?.addEventListener('click', async () => {
      const targetActorId = String(host.querySelector('.anon-field-actor')?.value || actorId).trim() || 'user';
      const next = {
        handle: String(host.querySelector('.anon-field-handle')?.value || '').trim(),
        signature: String(host.querySelector('.anon-field-signature')?.value || '').trim(),
        mood: String(host.querySelector('.anon-field-mood')?.value || '').trim(),
        statusText: String(host.querySelector('.anon-field-mood')?.value || '').trim(),
        interests: String(host.querySelector('.anon-field-interests')?.value || '').split(/[\/,，、]/).map((x) => x.trim()).filter(Boolean),
        joinedGroups: String(host.querySelector('.anon-field-groups')?.value || '').split(/[\/,，、]/).map((x) => x.trim()).filter(Boolean),
        bio: String(host.querySelector('.anon-field-bio')?.value || '').trim(),
        avatar: profile.avatar || '',
        postsLocked: targetActorId === 'user'
          ? !!host.querySelector('.anon-field-posts-locked')?.checked
          : profile.postsLocked,
      };
      state = targetActorId === 'user'
        ? await saveUserSpaceProfile(user.id, next)
        : await saveActorSpaceProfile(user.id, targetActorId, next);
      if (canEditNpcDraft && targetActorId === actorId) {
        const current = await getCharacter(actorId);
        if (current && isAnonymousNpcRecord(current)) {
          await saveCharacter({
            ...current,
            currentRole: String(host.querySelector('.anon-field-role')?.value || '').trim(),
            personality: String(host.querySelector('.anon-field-personality')?.value || '').trim(),
            speechStyle: String(host.querySelector('.anon-field-speech')?.value || '').trim(),
            anonymousPrivateDraft: {
              ...(current.anonymousPrivateDraft || {}),
              background: String(host.querySelector('.anon-field-background')?.value || '').trim(),
              interests: next.interests,
            },
            anonymousLifecycle: {
              ...(current.anonymousLifecycle || {}),
              phase: current.anonymousLifecycle?.phase === 'revealed' ? 'revealed' : 'private',
              retained: true,
            },
          });
        }
      }
      if (targetActorId !== actorId) {
        actorId = targetActorId;
        state = await loadAnonymousSpaceState(user.id, actorId);
        profile = normalizeAnonymousSpaceProfile(state.profile);
        unlocked = isAnonymousSpaceUnlocked(state, actorId);
        unlockStatus = '';
        unlockBusy = false;
      }
      profile = normalizeAnonymousSpaceProfile(state.profile);
      await syncAnonymousSpaceIdentityToChats(user.id, targetActorId, {
        handle: next.handle,
        signature: next.signature || next.bio,
        mood: next.mood || next.statusText,
        avatar: next.avatar,
      });
      showToast('匿名资料已保存');
      close();
      paint();
    });
    host.querySelector('[data-clear-avatar]')?.addEventListener('click', async () => {
      state = actorId === 'user'
        ? await saveUserSpaceProfile(user.id, { avatar: '' })
        : await saveActorSpaceProfile(user.id, actorId, { avatar: '' });
      await syncAnonymousSpaceAvatarToChats(user.id, actorId, '');
      profile = normalizeAnonymousSpaceProfile(state.profile);
      showToast('已清除匿名头像');
      close();
      paint();
    });
  }

  function paint(options = {}) {
    // 默认保持滚动；仅显式传 preserveScroll:false 时重置（例如切到全新页面态）
    const preserveScroll = options.preserveScroll !== false;
    const prevScroll = preserveScroll
      ? (container.querySelector('.anon-space-body')?.scrollTop || 0)
      : 0;
    const labelCtx = buildAnonSpaceLabelCtx(user, characters);
    const actor = actorId === 'user' ? null : characters.find((c) => c.id === actorId);
    const anonymousNpc = isAnonymousNpcRecord(actor);
    const promotedAnonymousNpc = !!actor
      && !anonymousNpc
      && actor.anonymousLifecycle?.phase === 'revealed';
    const displayId = resolveDisplayId(profile);
    const signatureLine = profile.signature || '还没有写匿名签名';
    const bioLine = profile.bio || '还没有写空间简介';
    const moodLine = profile.mood || profile.statusText || '在线潜水';
    const coverStyle = profile.coverImage
      ? ` style="background-image:linear-gradient(180deg,rgba(0,0,0,0) 30%,rgba(0,0,0,.72) 100%),url(${escAttr(profile.coverImage)});background-size:cover;background-position:center"`
      : '';
    const navTitle = actorId === 'user' ? '我的空间' : esc(displayId);
    const unlockEventsHtml = (state.unlockEvents || []).slice(0, 8).map((e) => renderUnlockEventCard(e, labelCtx)).join('');
    const unlockRequestCount = countAnonymousSpaceUnlockRequests(state);
    const postCount = (state.posts || []).length;
    const canSeePosts = actorId === 'user' || unlocked;
    const postsHtml = canSeePosts
      ? (state.posts || []).slice(0, 12).map((p) => renderPostCard(p, {
        unlocked: true,
        actorId,
        displayId,
        labelCtx,
      })).join('')
      : (postCount > 0
        ? `<div class="anon-space-locked-posts"><strong class="anon-space-locked-count">有 ${postCount} 条空间动态</strong><p>申请查看后可阅读</p></div>`
        : '');
    container.innerHTML = `
      <header class="navbar anon-space-navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${navTitle}</h1>
        <button type="button" class="navbar-btn" data-edit-profile aria-label="编辑">${icon('edit')}</button>
      </header>
      <main class="anon-space-body">
        <div class="anon-space-hero"${coverStyle}>
          <button type="button" class="anon-space-hero-edit" data-pick-cover>换封面</button>
          <input type="file" class="anon-cover-file" accept="image/*" hidden />
        </div>
        <div class="anon-space-identity">
          <button type="button" class="anon-avatar anon-space-avatar anon-avatar-btn" data-pick-avatar aria-label="更换头像">
            ${renderAvatar(profile, displayId)}
          </button>
          <input type="file" class="anon-avatar-file" accept="image/*" hidden />
          <div class="anon-space-id-block">
            <h2 class="anon-space-handle">${esc(displayId)}</h2>
            <p class="anon-space-signature">${esc(signatureLine)}</p>
            <p class="anon-space-mood">${esc(moodLine)}</p>
            <div class="anon-space-pills">
              <span class="anon-space-pill is-base">底色网名</span>
              ${actor ? `<span class="anon-space-pill">${esc(actor.name || actor.realName || '角色')} 的小号</span>` : ''}
              ${actorId === 'user' && profile.postsLocked ? '<span class="anon-space-pill is-lock">动态上锁</span>' : ''}
            </div>
          </div>
        </div>
        ${anonymousNpc ? `
          <div class="anon-space-contact-action">
            <button type="button" class="btn btn-primary btn-block${contactBusy ? ' is-loading' : ''}" data-add-anon-contact ${contactBusy ? 'disabled' : ''}>
              ${contactBusy ? loadingBtnContent('正在保存…') : '申请加入通讯录'}
            </button>
          </div>
        ` : promotedAnonymousNpc ? `
          <div class="anon-space-contact-action is-saved">
            <button type="button" class="btn btn-primary" data-open-contact-chat>发消息</button>
            <button type="button" class="btn btn-outline" data-open-contact-card>查看名片</button>
          </div>
        ` : ''}
        <nav class="anon-space-tabs" aria-label="空间内容">
          <button type="button" class="anon-space-tab ${feedTab === 'feed' ? 'is-active' : ''}" data-feed-tab="feed">动态</button>
          <button type="button" class="anon-space-tab ${feedTab === 'card' ? 'is-active' : ''}" data-feed-tab="card">名片</button>
          <button type="button" class="anon-space-tab ${feedTab === 'messages' ? 'is-active' : ''}" data-feed-tab="messages">留言</button>
          <button type="button" class="anon-space-tab ${feedTab === 'footprints' ? 'is-active' : ''}" data-feed-tab="footprints">足迹</button>
        </nav>
        <div class="anon-space-feed">
          ${generatingSpace ? renderAnonGenStatus(
            generatingKind === 'supplement-posts' ? '正在补充动态…'
              : generatingKind === 'footprints' ? '正在补充访客足迹…'
                : '正在生成匿名空间…',
            generatingKind !== 'footprints',
          ) : ''}
          ${actorId !== 'user' && unlockEventsHtml ? `<div class="anon-unlock-cards">${unlockEventsHtml}</div>` : ''}
          ${actorId !== 'user' && !unlocked ? `
            <div class="anon-space-unlock">
              <strong>申请查看对方的匿名空间</strong>
              <div class="anon-space-unlock-actions">
                <button type="button" class="btn btn-primary${unlockBusy ? ' is-loading' : ''}" data-unlock-ask ${unlockBusy ? 'disabled' : ''}>${unlockBusy ? loadingBtnContent('等待回应…') : '请求查看匿名空间'}</button>
                <button type="button" class="btn btn-outline" data-leave-msg ${unlockBusy ? 'disabled' : ''}>留言</button>
              </div>
              ${unlockRequestCount > 0 ? `<div class="anon-space-unlock-count">已申请 ${unlockRequestCount} 次</div>` : ''}
              ${unlockStatus ? `<div class="anon-space-unlock-status">${esc(unlockStatus)}</div>` : ''}
            </div>
          ` : ''}
          ${actorId !== 'user' && unlocked ? `
            <div class="anon-space-supplement-row">
              <div class="anon-space-unlock-status is-open">已可阅读空间动态</div>
              <button type="button" class="btn btn-sm btn-soft${generatingSpace && generatingKind === 'supplement-posts' ? ' is-loading' : ''}" data-supplement-posts ${unlockBusy || generatingSpace ? 'disabled' : ''}>${generatingSpace && generatingKind === 'supplement-posts' ? loadingBtnContent('补充中…') : '补充动态'}</button>
              <p class="anon-space-action-hint">解锁后追加 2–3 条说说；会顺带回复你留的评论</p>
            </div>
          ` : ''}

          ${feedTab === 'feed' ? `
            ${postsHtml || ''}
            ${actorId !== 'user' ? `
              <button type="button" class="btn btn-outline btn-block${generatingSpace && generatingKind === 'space' ? ' is-loading' : ''}" data-generate-actor-space ${unlockBusy || generatingSpace ? 'disabled' : ''}>${generatingSpace && generatingKind === 'space' ? loadingBtnContent('生成中…') : (profile.handle ? '重新生成匿名空间' : '生成角色匿名空间')}</button>
              <p class="anon-space-action-hint">整页重 roll 资料与动态；已解锁则保持解锁</p>
            ` : ''}
            ${actorId === 'user' && feedTab === 'feed' ? `
              <button type="button" class="btn btn-primary btn-block" data-compose-post ${unlockBusy || generatingSpace ? 'disabled' : ''}>发动态</button>
            ` : ''}
            ${!postsHtml && !generatingSpace && feedTab === 'feed' && actorId !== 'user' && profile.handle ? '<div class="anon-empty">还没有空间动态，可点下方重新生成</div>' : ''}
            ${!postsHtml && !generatingSpace && feedTab === 'feed' && actorId === 'user' ? '<div class="anon-empty">还没有动态，点「发动态」自己写</div>' : ''}
          ` : ''}

          ${feedTab === 'card' ? renderIdCardSection({ profile, displayId, signatureLine, bioLine }) : ''}

          ${feedTab === 'messages' ? `
            ${(state.messages || []).length ? (state.messages || []).slice(0, 12).map((m) => `
              <article class="anon-feed-card anon-feed-note">
                <span class="anon-feed-note-av">${esc(String(safeAnonSpaceLabel(m.from, labelCtx, '访').slice(0, 1)))}</span>
                <div>
                  <div class="anon-feed-note-meta">${esc(safeAnonSpaceLabel(m.from, labelCtx, '访客'))} · ${new Date(m.timestamp || Date.now()).toLocaleString('zh-CN')}</div>
                  <p class="anon-feed-note-text">${esc(safeAnonSpaceText(m.text, labelCtx))}</p>
                </div>
              </article>
            `).join('') : '<div class="anon-empty">还没有留言</div>'}
            <button type="button" class="btn btn-outline btn-block" data-leave-msg>写一条留言</button>
            <button type="button" class="btn btn-soft btn-block" data-batch-messages ${unlockBusy ? 'disabled' : ''}>批量生成留言</button>
          ` : ''}

          ${feedTab === 'footprints' ? `
            ${(state.groupFootprints || []).length ? `
              <div class="anon-footprint-section-label">小组足迹</div>
              <div class="anon-footprint-timeline">
                ${(state.groupFootprints || []).slice(0, 8).map(renderGroupFootprintItem).join('')}
              </div>
            ` : ''}
            ${(state.footprints || []).length ? `
              ${(state.groupFootprints || []).length ? '<div class="anon-footprint-section-label">来访记录</div>' : ''}
              ${(state.footprints || []).slice(0, 12).map((f) => `
                <article class="anon-feed-card">
                  <div class="anon-feed-note-meta">${esc(safeAnonSpaceLabel(f.visitorName, labelCtx, '访客'))} · ${esc(f.note || '路过')}</div>
                  <p class="anon-feed-body">${esc(formatAnonymousSpaceFootprintLine(f))}</p>
                </article>
              `).join('')}
            ` : ''}
            ${!(state.groupFootprints || []).length && !(state.footprints || []).length ? '<div class="anon-empty">还没有足迹</div>' : ''}
            ${actorId === 'user' ? `<button type="button" class="btn btn-soft btn-block${generatingSpace && generatingKind === 'footprints' ? ' is-loading' : ''}" data-supplement-footprints ${unlockBusy || generatingSpace ? 'disabled' : ''}>${generatingSpace && generatingKind === 'footprints' ? loadingBtnContent('补充中…') : '补充访客足迹'}</button>` : ''}
          ` : ''}
        </div>
      </main>
    `;

    if (preserveScroll) {
      const body = container.querySelector('.anon-space-body');
      if (body) body.scrollTop = prevScroll;
    }

    container.querySelector('[data-back]')?.addEventListener('click', async () => {
      await endVisitFootprint();
      back();
    });
    container.querySelector('[data-edit-profile]')?.addEventListener('click', openEditModal);
    container.querySelector('[data-add-anon-contact]')?.addEventListener('click', async () => {
      if (contactBusy) return;
      const current = characters.find((c) => c.id === actorId);
      if (!isAnonymousNpcRecord(current)) {
        showToast('这位角色已经在通讯录里');
        paint();
        return;
      }
      if (!window.confirm(`申请将「${displayId}」保存到通讯录？\n\n保存后会转为正式角色，并建立普通聊天。`)) return;
      contactBusy = true;
      paint({ preserveScroll: true });
      try {
        const sourceChatIds = current.anonymousLifecycle?.sourceChatIds || [];
        const result = await acceptAnonymousReveal({
          userId: user.id,
          actorId,
          sourceChatId: sourceChatIds[sourceChatIds.length - 1] || '',
        });
        const index = characters.findIndex((c) => c.id === actorId);
        if (index >= 0) characters[index] = result.character;
        showToast(`已将「${result.character.name}」加入通讯录`);
      } catch (err) {
        showToast(`保存失败：${err?.message || err}`);
      } finally {
        contactBusy = false;
        paint({ preserveScroll: true });
      }
    });
    container.querySelector('[data-open-contact-chat]')?.addEventListener('click', async () => {
      try {
        const actor = characters.find((c) => c.id === actorId);
        const chat = await ensurePrivateChat(user.id, actorId, actor?.name || '');
        navigate('chat/thread', { chatId: chat.id, entry: 'list' });
      } catch (err) {
        showToast(err?.message || '打开聊天失败');
      }
    });
    container.querySelector('[data-open-contact-card]')?.addEventListener('click', () => {
      navigate('contacts/card', { id: actorId });
    });
    container.querySelectorAll('[data-feed-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        feedTab = btn.getAttribute('data-feed-tab') || 'feed';
        paint();
      });
    });

    const avatarBtn = container.querySelector('[data-pick-avatar]');
    const avatarInput = container.querySelector('.anon-avatar-file');
    avatarBtn?.addEventListener('click', () => avatarInput?.click());
    avatarInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const result = await fileToCroppedOptimizedAvatarDataUrl(file);
        if (!result) return;
        const avatar = result.dataUrl;
        state = actorId === 'user'
          ? await saveUserSpaceProfile(user.id, { avatar })
          : await saveActorSpaceProfile(user.id, actorId, { avatar });
        await syncAnonymousSpaceAvatarToChats(user.id, actorId, avatar);
        profile = normalizeAnonymousSpaceProfile(state.profile);
        showToast('匿名头像已保存');
        paint();
      } catch (err) {
        showToast(err?.message || '头像保存失败');
      }
    });

    container.querySelector('[data-pick-cover]')?.addEventListener('click', () => {
      container.querySelector('.anon-cover-file')?.click();
    });
    container.querySelector('.anon-cover-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const coverImage = await fileToCroppedCompressedDataUrl(file, IMAGE_CROP_PRESETS.cover);
        if (!coverImage) return;
        state = actorId === 'user'
          ? await saveUserSpaceProfile(user.id, { coverImage })
          : await saveActorSpaceProfile(user.id, actorId, { coverImage });
        profile = normalizeAnonymousSpaceProfile(state.profile);
        showToast('封面已更新');
        paint();
      } catch (err) {
        showToast(err?.message || '封面上传失败');
      }
    });

    container.querySelector('[data-leave-msg]')?.addEventListener('click', async () => {
      const text = await promptTextEditor({ title: '留言', placeholder: '短句即可' });
      if (!text) return;
      const actor = characters.find((c) => c.id === actorId);
      state = await addAnonymousSpaceMessage(user.id, actorId, {
        from: visitorHandle,
        fromId: 'user',
        text,
      });
      if (actorId !== 'user') {
        await recordAnonymousSpaceMessageMemory({
          userId: user.id,
          actorId,
          visitorHandle,
          text,
          character: actor,
        });
      }
      feedTab = 'messages';
      showToast('已留言');
      paint();
    });

    container.querySelector('[data-unlock-ask]')?.addEventListener('click', async () => {
      if (unlockBusy) return;
      const actor = characters.find((c) => c.id === actorId);
      if (!actor) {
        showToast('路人资料未找到，请返回匿名匹配重新进入');
        return;
      }
      const requestNote = await promptTextEditor({
        title: '申请查看匿名空间',
        placeholder: '附言（可选）',
        value: '',
      });
      if (requestNote === null) return;
      const lease = await claimSpaceGeneration();
      if (!lease) return;
      unlockBusy = true;
      unlockStatus = '已发送请求，等待回应…';
      const requestText = `「${visitorHandle}」请求查看匿名空间${requestNote ? `：${requestNote}` : ''}`;
      state = await markAnonymousSpaceUnlockPending(user.id, actorId, requestNote || '');
      state = await appendAnonymousSpaceUnlockEvent(user.id, actorId, {
        type: 'request',
        from: visitorHandle,
        text: requestText,
      });
      feedTab = 'feed';
      paint();
      try {
        const result = await resolveAnonymousSpaceUnlockAI({
          character: actor,
          user,
          userSpaceProfile,
          actorSpaceProfile: profile,
          actorSpaceState: state,
          requestNote: requestNote || '',
        });
        state = await applyAnonymousSpaceUnlockResponse(user.id, actorId, {
          ...result,
          requestNote: requestNote || '',
        });
        state = await appendAnonymousSpaceUnlockEvent(user.id, actorId, {
          type: 'response',
          from: result.actorHandle || resolveDisplayId(profile),
          text: result.reply,
          granted: result.granted,
        });
        await recordAnonymousSpaceUnlockMemory({
          userId: user.id,
          actorId,
          visitorHandle,
          granted: result.granted,
          reply: result.reply,
          requestCount: result.requestCount || countAnonymousSpaceUnlockRequests(state),
          character: actor,
        });
        profile = normalizeAnonymousSpaceProfile(state.profile);
        unlocked = result.granted === true;
        unlockStatus = result.reply || (result.granted ? '对方已同意' : '对方婉拒了');
        showToast(result.granted ? '对方同意了' : '对方婉拒了');
      } catch (err) {
        unlockStatus = '';
        reportAnonSpaceAiError(err, '匿名空间 / 解锁');
        showToast(err?.message || '解锁请求失败');
      } finally {
        unlockBusy = false;
        await lease.release();
        paint();
      }
    });

    container.querySelector('[data-generate-actor-space]')?.addEventListener('click', async () => {
      const char = characters.find((c) => c.id === actorId);
      if (unlockBusy || generatingSpace) return;
      if (!char) {
        showToast('路人资料未找到，请返回匿名匹配重新进入');
        return;
      }
      const lease = await claimSpaceGeneration();
      if (!lease) return;
      generatingSpace = true;
      generatingKind = 'space';
      unlockBusy = true;
      paint({ preserveScroll: true });
      showToast('正在生成匿名空间…');
      try {
        const generated = await generateActorAnonymousSpaceProfileAI({
          character: char,
          user,
          userSpaceProfile,
          existingProfile: profile,
        });
        state = await saveActorSpaceProfile(user.id, actorId, {
          ...profile,
          ...generated,
          avatar: profile.avatar || '',
          coverImage: profile.coverImage || '',
        });
        state = await loadAnonymousSpaceState(user.id, actorId);
        state.posts = generated.posts || [];
        state.groupFootprints = generated.groupFootprints || [];
        state = await saveAnonymousSpaceState(user.id, actorId, state);
        profile = normalizeAnonymousSpaceProfile(state.profile);
        if (state.unlock?.status === 'granted') {
          unlocked = true;
          unlockStatus = '已解锁';
        }
        await syncAnonymousSpaceIdentityToChats(user.id, actorId, {
          handle: profile.handle,
          signature: profile.signature || profile.bio,
          mood: profile.mood || profile.statusText,
          avatar: profile.avatar,
        });
        showToast(`已生成 ${(state.posts || []).length} 条动态，签名与状态已更新`);
      } catch (err) {
        reportAnonSpaceAiError(err, '匿名空间 / 重新生成');
        showToast(err?.message || '生成失败');
      } finally {
        generatingSpace = false;
        generatingKind = '';
        unlockBusy = false;
        await lease.release();
        paint({ preserveScroll: true });
      }
    });

    container.querySelector('[data-supplement-footprints]')?.addEventListener('click', async () => {
      if (unlockBusy || generatingSpace || actorId !== 'user') return;
      const lease = await claimSpaceGeneration();
      if (!lease) return;
      generatingSpace = true;
      generatingKind = 'footprints';
      unlockBusy = true;
      paint({ preserveScroll: true });
      showToast('正在补充访客足迹…');
      try {
        const rows = await generateUserSpaceFootprintsAI({
          user,
          userSpaceProfile: profile,
          characters,
          existingFootprints: state.footprints || [],
        });
        if (rows.length) {
          state = await appendAnonymousSpaceFootprints(user.id, 'user', rows);
        }
        feedTab = 'footprints';
        showToast(`已补充 ${rows.length} 条访客足迹`);
      } catch (err) {
        reportAnonSpaceAiError(err, '匿名空间 / 访客足迹');
        showToast(err?.message || '补充失败');
      } finally {
        generatingSpace = false;
        generatingKind = '';
        unlockBusy = false;
        await lease.release();
        paint({ preserveScroll: true });
      }
    });

    container.querySelector('[data-compose-post]')?.addEventListener('click', () => openComposePostModal());

    container.querySelectorAll('[data-edit-post]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const postId = btn.getAttribute('data-edit-post');
        const post = (state.posts || []).find((p) => String(p.id) === String(postId));
        if (!post) return;
        openComposePostModal(post);
      });
    });

    container.querySelectorAll('[data-delete-post]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const postId = btn.getAttribute('data-delete-post');
        if (!postId || unlockBusy) return;
        state = await removeAnonymousSpacePost(user.id, actorId, postId);
        showToast('已删除');
        paint({ preserveScroll: true });
      });
    });

    container.querySelector('[data-supplement-posts]')?.addEventListener('click', async () => {
      if (unlockBusy || !unlocked || generatingSpace) return;
      const actor = characters.find((c) => c.id === actorId);
      if (!actor) return;
      const lease = await claimSpaceGeneration();
      if (!lease) return;
      generatingSpace = true;
      generatingKind = 'supplement-posts';
      unlockBusy = true;
      paint({ preserveScroll: true });
      showToast('正在补充动态…');
      try {
        const result = await supplementAnonymousSpacePostsAI({
          character: actor,
          user,
          userSpaceProfile,
          actorSpaceProfile: profile,
          actorSpaceState: state,
        });
        if (result.extraPosts?.length) {
          state = await appendAnonymousSpacePosts(user.id, actorId, result.extraPosts);
        }
        if (result.postReplies?.length) {
          for (const row of result.postReplies) {
            state = await addAnonymousSpacePostReply(user.id, actorId, row.postId, row);
          }
        }
        state = await loadAnonymousSpaceState(user.id, actorId);
        profile = normalizeAnonymousSpaceProfile(state.profile);
        if (result.reply) {
          await recordAnonymousSpaceUnlockMemory({
            userId: user.id,
            actorId,
            visitorHandle,
            granted: true,
            reply: result.reply,
            requestCount: countAnonymousSpaceUnlockRequests(state),
            character: actor,
          });
        }
        showToast(result.reply || `已补充 ${result.extraPosts?.length || 0} 条动态`);
      } catch (err) {
        reportAnonSpaceAiError(err, '匿名空间 / 补充动态');
        showToast(err?.message || '补充失败');
      } finally {
        generatingSpace = false;
        generatingKind = '';
        unlockBusy = false;
        await lease.release();
        paint({ preserveScroll: true });
      }
    });

    container.querySelector('[data-batch-messages]')?.addEventListener('click', async () => {
      if (unlockBusy) return;
      const lease = await claimSpaceGeneration();
      if (!lease) return;
      const actor = actorId === 'user' ? null : characters.find((c) => c.id === actorId);
      unlockBusy = true;
      paint();
      try {
        const rows = await generateAnonymousSpaceMessagesBatchAI({
          character: actor,
          user,
          userSpaceProfile,
          actorSpaceProfile: profile,
          count: 5,
        });
        state = await appendAnonymousSpaceMessages(user.id, actorId, rows);
        feedTab = 'messages';
        showToast(`已生成 ${rows.length} 条留言`);
      } catch (err) {
        reportAnonSpaceAiError(err, '匿名空间 / 留言');
        showToast(err?.message || '生成失败');
      } finally {
        unlockBusy = false;
        await lease.release();
        paint();
      }
    });

    container.querySelectorAll('[data-reply-post]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const postId = btn.getAttribute('data-reply-post');
        const post = (state.posts || []).find((p) => String(p.id) === String(postId));
        if (!post) return;
        const note = await promptTextEditor({ title: '评论动态', placeholder: '短句即可' });
        if (!note) return;
        state = await addAnonymousSpacePostReply(user.id, actorId, postId, {
          from: visitorHandle,
          fromId: 'user',
          text: note,
        });
        if (actorId !== 'user') {
          const actor = characters.find((c) => c.id === actorId);
          await recordAnonymousSpacePostCommentMemory({
            userId: user.id,
            actorId,
            visitorHandle,
            postText: post.text,
            text: note,
            character: actor,
          });
        }
        showToast('已评论');
        paint({ preserveScroll: true });
      });
    });

    container.querySelectorAll('[data-view-post-image]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const postId = btn.getAttribute('data-view-post-image');
        const post = (state.posts || []).find((p) => String(p.id) === String(postId));
        if (!post?.image) return;
        openImageLightbox(post.image);
      });
    });

    container.querySelectorAll('[data-view-post-textimg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const postId = btn.getAttribute('data-view-post-textimg');
        const post = (state.posts || []).find((p) => String(p.id) === String(postId));
        if (!post?.textImage) return;
        openChatCardModal(
          { type: 'textimg', content: post.textImage },
          { anonymous: true, variant: 'anon' },
        );
      });
    });

    container.querySelectorAll('[data-gen-post-image]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const postId = btn.getAttribute('data-gen-post-image');
        const post = (state.posts || []).find((p) => String(p.id) === String(postId));
        if (!post || unlockBusy) return;
        unlockBusy = true;
        await updateAnonymousSpacePost(user.id, actorId, postId, { imageLoading: true });
        paint();
        try {
          const result = await generateAnonymousSpacePostImage(post, { characterId: actorId });
          state = await updateAnonymousSpacePost(user.id, actorId, postId, {
            image: result.image || '',
            textImage: result.textImage || post.textImage,
            imageKind: result.imageKind || (result.image ? 'photo' : 'textimg'),
            imageLoading: false,
          });
          showToast(result.image ? '配图已生成' : '已生成文字图');
        } catch (err) {
          await updateAnonymousSpacePost(user.id, actorId, postId, { imageLoading: false });
          showToast(err?.message || '配图失败');
        } finally {
          unlockBusy = false;
          paint();
        }
      });
    });
  }

  const onPageHide = () => { endVisitFootprint().catch(() => null); };
  window.addEventListener('pagehide', onPageHide);

  paint();

  return () => {
    window.removeEventListener('pagehide', onPageHide);
    endVisitFootprint().catch(() => null);
  };
}
