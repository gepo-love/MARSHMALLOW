import { icon } from './svg-icons.js';
import { showToast } from './toast.js';
import { createMomentPost } from '../models/moment-post.js';
import { getUserDisplayName } from '../models/user.js';
import { fileToOptimizedMomentImageDataUrl } from '../core/chat/chat-image-utils.js';
import { loadContactGroupsConfig } from '../core/contact-groups.js';
import { getChatPlatformCopy } from '../core/chat/chat-platform-copy.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isIosWebKitBrowserTab() {
  try {
    const nav = globalThis.navigator || {};
    const ios = /iPad|iPhone|iPod/i.test(String(nav.userAgent || ''))
      || (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints || 0) > 1);
    if (!ios) return false;
    if (nav.standalone === true) return false;
    return !globalThis.matchMedia?.('(display-mode: standalone)')?.matches;
  } catch (_) {
    return false;
  }
}

/**
 * iOS Safari 标签页会在默认聚焦阶段先滚动包含 textarea 的整个弹层，
 * 随后全局 IME 逻辑又会滚动 modal-body，表现为点一下输入框整页“飞上去”。
 * 在同一次用户手势的 touchend 中使用 preventScroll 聚焦，键盘仍能正常弹出；
 * 之后只交给 .modal-body 做必要的局部避让。主屏 PWA 已有 boot 级同类保护，不重复接管。
 */
function installIosComposeFocusStability(sheet) {
  if (!sheet || !isIosWebKitBrowserTab()) return;
  const editableSelector = 'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="button"]):not([type="submit"])';
  const moveThreshold = 10;
  let pending = null;
  const capturePassive = { capture: true, passive: true };

  sheet.addEventListener('touchstart', (event) => {
    const touch = event.touches?.[0];
    const field = event.target?.closest?.(editableSelector);
    if (!touch || event.touches.length !== 1 || !field || field.disabled || field.readOnly) {
      pending = null;
      return;
    }
    pending = { field, x: touch.clientX, y: touch.clientY, moved: false };
  }, capturePassive);
  sheet.addEventListener('touchmove', (event) => {
    const touch = event.touches?.[0];
    if (!pending || !touch) return;
    if (
      Math.abs(touch.clientX - pending.x) > moveThreshold
      || Math.abs(touch.clientY - pending.y) > moveThreshold
    ) pending.moved = true;
  }, capturePassive);
  sheet.addEventListener('touchend', () => {
    const current = pending;
    pending = null;
    if (!current || current.moved || !current.field?.isConnected) return;
    if (document.activeElement === current.field) return;
    try {
      current.field.focus({ preventScroll: true });
    } catch (_) {
      try { current.field.focus(); } catch (__) {}
    }
  }, capturePassive);
  sheet.addEventListener('touchcancel', () => { pending = null; }, capturePassive);
}

export async function openMomentsComposeModal({
  user,
  actors = [],
  initial = {},
  onPublish,
  enableAi = false,
  onGenerate,
  onOpenAiSettings,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const platformCopy = getChatPlatformCopy();

  const initVis = String(initial.visibility || 'all');
  const initHidden = new Set((initial.hiddenFromIds || []).map(String));
  const initGroups = new Set((initial.visibleGroupIds || []).map(String));

  host.classList.add('active');

  try {
  const groupsConfig = await loadContactGroupsConfig().catch(() => ({ groups: [] }));
  const groupOptions = (groupsConfig.groups || [])
    .map((g) => {
      const checked = initGroups.has(g.id) ? ' checked' : '';
      return `<label class="moments-visibility-item"><input type="checkbox" value="${esc(g.id)}" class="moments-visible-group-check"${checked} /> ${esc(g.name)}</label>`;
    })
    .join('') || '<span class="scrapbook-hint">暂无通讯录分组</span>';

  const hiddenOptions = actors
    .filter((a) => a.kind === 'character')
    .slice(0, 24)
    .map((a) => {
      const checked = initHidden.has(a.id) ? ' checked' : '';
      return `<label class="moments-visibility-item"><input type="checkbox" value="${esc(a.id)}" class="moments-hidden-check"${checked} /> ${esc(a.name)}</label>`;
    })
    .join('') || '<span class="scrapbook-hint">暂无角色</span>';

  const actorRows = actors
    .filter((a) => a?.id && a?.name)
    .map((a) => ({ ...a, id: String(a.id), name: String(a.name) }));
  const requestedAuthorId = String(initial.authorId || user?.id || '');
  let selectedAuthorId = actorRows.some((a) => a.id === requestedAuthorId)
    ? requestedAuthorId
    : String(actorRows[0]?.id || user?.id || '');
  const selectedAuthorName = actorRows.find((a) => a.id === selectedAuthorId)?.name
    || getUserDisplayName(user);
  const actorOptions = actorRows
    .map((a) => `<button type="button" class="moments-compose-author-option${a.id === selectedAuthorId ? ' is-selected' : ''}" data-moments-author="${esc(a.id)}" role="option" aria-selected="${a.id === selectedAuthorId}">${esc(a.name)}</button>`)
    .join('');

  const mentionOptions = actors
    .filter((a) => a.kind === 'character')
    .slice(0, 24)
    .map((a) => `<label class="moments-mention-item"><input type="checkbox" value="${esc(a.id)}" class="moments-mention-check" /> @${esc(a.name)}</label>`)
    .join('') || '<span class="scrapbook-hint">通讯录暂无角色</span>';

  const chatShare = initial.chatShare || null;
  const defaultKind = chatShare ? 'chat_share' : 'text';
  let publishMode = 'manual';
  if (enableAi) {
    try {
      publishMode = globalThis.localStorage?.getItem('momentsPublishMode') === 'ai' ? 'ai' : 'manual';
    } catch (_) {
      publishMode = 'manual';
    }
  }

  host.innerHTML = `
    <div class="modal-overlay" data-moments-compose-overlay>
      <div class="modal-sheet modal-sheet-tall scrapbook-card moments-compose-sheet" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h3>发布动态</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-moments-compose-close aria-label="关闭">${icon('close')}</button>
        </header>
        ${enableAi ? `
        <div class="moments-publish-mode-tabs" role="tablist" aria-label="发布方式">
          <button type="button" class="moments-publish-mode-tab${publishMode === 'manual' ? ' is-active' : ''}" data-publish-mode="manual" role="tab" aria-selected="${publishMode === 'manual'}">自己发布</button>
          <button type="button" class="moments-publish-mode-tab${publishMode === 'ai' ? ' is-active' : ''}" data-publish-mode="ai" role="tab" aria-selected="${publishMode === 'ai'}">AI 生成</button>
        </div>
        ` : ''}
        <div class="modal-body moments-compose-body">
          <div class="moments-publish-pane${publishMode === 'manual' ? ' is-active' : ''}" data-publish-pane="manual" role="tabpanel">
          <label class="form-label">发帖身份</label>
          <button type="button" class="form-input moments-compose-author-trigger" data-moments-author-trigger aria-expanded="false">
            <span>${esc(selectedAuthorName)}</span>
            ${icon('chevronDown')}
          </button>
          <div class="moments-compose-author-picker" data-moments-author-picker data-ime-scroll-region role="listbox" aria-label="选择发帖身份" hidden>${actorOptions}</div>
          <p class="scrapbook-hint">可代通讯录角色${esc(platformCopy.postVerb)}，用于手动编辑。</p>

          <div class="moments-compose-tabs">
            <button type="button" class="moments-compose-tab ${defaultKind === 'text' ? 'is-active' : ''}" data-kind="text">文字</button>
            <button type="button" class="moments-compose-tab ${defaultKind === 'chat_share' ? 'is-active' : ''}" data-kind="chat_share">晒聊天</button>
          </div>

          <div class="moments-compose-pane is-text ${defaultKind === 'text' ? 'is-active' : ''}">
            <textarea class="form-input moments-compose-text" rows="5" placeholder="分享生活…">${esc(initial.content || '')}</textarea>
          </div>
          <div class="moments-compose-pane is-chat ${defaultKind === 'chat_share' ? 'is-active' : ''}">
            <input type="text" class="form-input moments-compose-share-title" placeholder="摘录标题" value="${esc(chatShare?.title || '聊天记录')}" />
            <textarea class="form-input moments-compose-share-lines" rows="6" placeholder="每行一条，如：我：今天吃什么">${esc((chatShare?.lines || []).join('\n'))}</textarea>
          </div>

          <label class="form-label">图片（最多 9 张）</label>
          <input type="file" class="moments-compose-files-input" accept="image/*" multiple hidden />
          <div class="moments-compose-grid"></div>

          <label class="form-label">@ 角色</label>
          <div class="moments-mention-list">${mentionOptions}</div>

          <label class="form-label">可见范围</label>
          <div class="moments-visibility-mode">
            <label class="moments-visibility-radio"><input type="radio" name="moments-vis-mode" value="all" ${initVis !== 'groups' ? 'checked' : ''} /> 全部可见</label>
            <label class="moments-visibility-radio"><input type="radio" name="moments-vis-mode" value="groups" ${initVis === 'groups' ? 'checked' : ''} /> 仅部分分组可见</label>
          </div>
          <div class="moments-visibility-groups">${groupOptions}</div>
          <label class="form-label">不可见</label>
          <div class="moments-visibility-hidden">${hiddenOptions}</div>

          <button type="button" class="btn btn-primary moments-compose-submit">发布</button>
          </div>
          ${enableAi ? `
          <div class="moments-publish-pane moments-publish-ai-pane${publishMode === 'ai' ? ' is-active' : ''}" data-publish-pane="ai" role="tabpanel">
            <div class="moments-publish-ai-mark" aria-hidden="true">${icon('sparkle')}</div>
            <strong>生成角色动态</strong>
            <button type="button" class="btn btn-primary moments-publish-ai-start" data-moments-compose-ai>开始生成</button>
            <button type="button" class="moments-publish-ai-settings" data-moments-compose-ai-settings>生成设置</button>
          </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;

  installIosComposeFocusStability(host.querySelector('.moments-compose-sheet'));

  let postKind = defaultKind;
  const pickedImages = (Array.isArray(initial.images) ? initial.images : []).slice(0, 9);
  const grid = host.querySelector('.moments-compose-grid');
  const filesInput = host.querySelector('.moments-compose-files-input');

  function renderImageGrid() {
    if (!grid) return;
    const cells = pickedImages.map((url, idx) => `
      <div class="moments-compose-cell">
        <img src="${esc(url)}" alt="" />
        <button type="button" class="moments-compose-cell-remove" data-remove-image="${idx}" aria-label="移除图片">${icon('close')}</button>
      </div>
    `).join('');
    const addTile = pickedImages.length < 9
      ? `<button type="button" class="moments-compose-cell moments-compose-cell-add" data-add-image aria-label="添加图片">${icon('plus')}</button>`
      : '';
    grid.innerHTML = cells + addTile;
    grid.querySelector('[data-add-image]')?.addEventListener('click', () => filesInput?.click());
    grid.querySelectorAll('[data-remove-image]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-remove-image'));
        pickedImages.splice(idx, 1);
        renderImageGrid();
      });
    });
  }
  renderImageGrid();

  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };

  const authorTrigger = host.querySelector('[data-moments-author-trigger]');
  const authorPicker = host.querySelector('[data-moments-author-picker]');
  const setAuthorPickerOpen = (open) => {
    if (!authorPicker || !authorTrigger) return;
    authorPicker.hidden = !open;
    authorTrigger.setAttribute('aria-expanded', String(open));
    authorTrigger.classList.toggle('is-open', open);
    if (open) {
      authorPicker.querySelector('.is-selected')?.scrollIntoView?.({ block: 'nearest' });
    }
  };
  authorTrigger?.addEventListener('click', () => {
    setAuthorPickerOpen(authorPicker?.hidden !== false);
  });
  authorPicker?.querySelectorAll('[data-moments-author]').forEach((option) => {
    option.addEventListener('click', () => {
      selectedAuthorId = String(option.getAttribute('data-moments-author') || '');
      const actor = actorRows.find((row) => row.id === selectedAuthorId);
      const label = authorTrigger?.querySelector('span');
      if (label) label.textContent = actor?.name || getUserDisplayName(user);
      authorPicker.querySelectorAll('[data-moments-author]').forEach((item) => {
        const selected = item === option;
        item.classList.toggle('is-selected', selected);
        item.setAttribute('aria-selected', String(selected));
      });
      setAuthorPickerOpen(false);
    });
  });

  // 微信页本身的 Android 边缘返回会避开 dialog；在发布动态这个全屏长表单里，
  // 从左缘右滑应先关闭弹层，不能让用户困在表单或原生下拉选择器里。
  const overlay = host.querySelector('[data-moments-compose-overlay]');
  let edgeGesture = null;
  const isIOS = /iPad|iPhone|iPod/i.test(String(globalThis.navigator?.userAgent || ''));
  overlay?.addEventListener('touchstart', (event) => {
    const touch = event.touches?.[0];
    if (isIOS || !touch || event.touches.length !== 1 || touch.clientX > 24) {
      edgeGesture = null;
      return;
    }
    edgeGesture = {
      x: touch.clientX,
      y: touch.clientY,
      latestX: touch.clientX,
      latestY: touch.clientY,
      horizontal: false,
    };
  }, { passive: true });
  overlay?.addEventListener('touchmove', (event) => {
    if (!edgeGesture || !event.touches?.length) return;
    const touch = event.touches[0];
    edgeGesture.latestX = touch.clientX;
    edgeGesture.latestY = touch.clientY;
    const dx = touch.clientX - edgeGesture.x;
    const dy = touch.clientY - edgeGesture.y;
    if (!edgeGesture.horizontal) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (dx <= 0 || Math.abs(dx) <= Math.abs(dy) * 1.2) {
        edgeGesture = null;
        return;
      }
      edgeGesture.horizontal = true;
    }
    event.preventDefault();
  }, { passive: false });
  const finishEdgeGesture = () => {
    if (!edgeGesture) return;
    const current = edgeGesture;
    edgeGesture = null;
    const dx = current.latestX - current.x;
    const dy = current.latestY - current.y;
    if (current.horizontal && dx >= 72 && Math.abs(dx) > Math.abs(dy) * 1.25) {
      if (authorPicker?.hidden === false) setAuthorPickerOpen(false);
      else close();
    }
  };
  overlay?.addEventListener('touchend', finishEdgeGesture, { passive: true });
  overlay?.addEventListener('touchcancel', () => { edgeGesture = null; }, { passive: true });

  host.querySelector('[data-moments-compose-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-moments-compose-close]')?.addEventListener('click', close);
  host.querySelector('.moments-compose-sheet')?.addEventListener('click', (e) => e.stopPropagation());

  host.querySelectorAll('[data-publish-mode]').forEach((tab) => {
    tab.addEventListener('click', () => {
      publishMode = tab.getAttribute('data-publish-mode') === 'ai' ? 'ai' : 'manual';
      host.querySelectorAll('[data-publish-mode]').forEach((item) => {
        const active = item.getAttribute('data-publish-mode') === publishMode;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', String(active));
      });
      host.querySelectorAll('[data-publish-pane]').forEach((pane) => {
        pane.classList.toggle('is-active', pane.getAttribute('data-publish-pane') === publishMode);
      });
      try {
        globalThis.localStorage?.setItem('momentsPublishMode', publishMode);
      } catch (_) {
        // 隐私模式下不记忆，不影响本次切换。
      }
    });
  });

  host.querySelector('[data-moments-compose-ai]')?.addEventListener('click', () => {
    close();
    Promise.resolve(onGenerate?.()).catch((err) => console.warn('[moments] AI generation failed', err));
  });
  host.querySelector('[data-moments-compose-ai-settings]')?.addEventListener('click', () => {
    close();
    Promise.resolve(onOpenAiSettings?.()).catch((err) => console.warn('[moments] settings failed', err));
  });

  host.querySelectorAll('.moments-compose-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      postKind = tab.getAttribute('data-kind') || 'text';
      host.querySelectorAll('.moments-compose-tab').forEach((el) => {
        el.classList.toggle('is-active', el === tab);
      });
      host.querySelectorAll('.moments-compose-pane').forEach((pane) => {
        pane.classList.toggle('is-active', pane.classList.contains(postKind === 'chat_share' ? 'is-chat' : 'is-text'));
      });
    });
  });

  filesInput?.addEventListener('change', async (e) => {
    const remaining = Math.max(0, 9 - pickedImages.length);
    const files = [...(e.target.files || [])].slice(0, remaining);
    for (const file of files) {
      let riskToken = '';
      try {
        if (Number(file?.size || 0) > 24 * 1024 * 1024) {
          throw new Error('图片文件过大，请先裁剪后再发布');
        }
        riskToken = globalThis.__mm_mark_risky_activity__?.('moments-image-compress', {
          fileName: String(file?.name || '').slice(0, 80),
          fileBytes: Number(file?.size || 0),
        }) || '';
        const optimized = await fileToOptimizedMomentImageDataUrl(file);
        if (!optimized?.dataUrl) throw new Error('图片压缩结果为空');
        pickedImages.push(optimized.dataUrl);
      } catch (error) {
        showToast(error?.message || '图片处理失败，请换一张重试');
      } finally {
        globalThis.__mm_clear_risky_activity__?.(riskToken);
      }
    }
    filesInput.value = '';
    renderImageGrid();
  });

  host.querySelector('.moments-compose-submit')?.addEventListener('click', async () => {
    const submitButton = host.querySelector('.moments-compose-submit');
    if (submitButton?.disabled) return;
    const authorId = selectedAuthorId || user?.id;
    const selectedActor = actorRows.find((a) => a.id === String(authorId || ''));
    const authorName = selectedActor?.name || getUserDisplayName(user);
    const mentionIds = [...host.querySelectorAll('.moments-mention-check:checked')].map((el) => el.value);
    let content = '';
    let chatSharePayload = null;

    if (postKind === 'chat_share') {
      const title = String(host.querySelector('.moments-compose-share-title')?.value || '').trim() || '聊天记录';
      const lines = String(host.querySelector('.moments-compose-share-lines')?.value || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 12);
      if (!lines.length) return;
      chatSharePayload = { title, lines };
      content = String(host.querySelector('.moments-compose-text')?.value || '').trim() || '分享一则聊天';
    } else {
      content = String(host.querySelector('.moments-compose-text')?.value || '').trim();
      if (!content && !pickedImages.length) return;
    }

    const visibilityMode = host.querySelector('input[name="moments-vis-mode"]:checked')?.value || 'all';
    const visibleGroupIds = visibilityMode === 'groups'
      ? [...host.querySelectorAll('.moments-visible-group-check:checked')].map((el) => el.value)
      : [];
    const hiddenFromIds = [...host.querySelectorAll('.moments-hidden-check:checked')].map((el) => el.value);

    const post = createMomentPost({
      authorId,
      authorName,
      content,
      images: pickedImages.slice(),
      postKind,
      chatShare: chatSharePayload,
      mentionIds,
      avatar: String(selectedActor?.avatar || '').trim()
        || (authorId === user?.id ? String(user?.avatar || '').trim() : ''),
      visibility: visibilityMode === 'groups' && visibleGroupIds.length ? 'groups' : 'all',
      visibleGroupIds,
      hiddenFromIds,
    });
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = '发布中…';
    }
    try {
      await onPublish?.(post);
      close();
    } catch (error) {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = '发布';
      }
      showToast(error?.name === 'QuotaExceededError'
        ? '本地存储空间不足，请清理部分图片后重试'
        : (error?.message || '发布失败，请重试'));
    }
  });
  } catch (err) {
    host.classList.remove('active');
    host.innerHTML = '';
    throw err;
  }
}
