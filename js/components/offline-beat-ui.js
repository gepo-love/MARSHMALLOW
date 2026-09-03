/** 相遇模块 · 线下/番外 beat 列表的共用 UI 片段与手势 */

import { icon } from './svg-icons.js';

export function escBeat(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function eventTargetElement(event) {
  const target = event?.target;
  if (target?.nodeType === 1) return target;
  return target?.parentElement || null;
}

export function beatActionsHtml(beatId, {
  image = false,
  hasImage = false,
  clearImage = false,
  hidden = false,
  reroll = false,
  guidedRevision = false,
  supplementalAudit = false,
  expertConsultation = false,
  continuation = false,
  bookmark = false,
  fork = false,
  favorite = false,
} = {}) {
  return `
    <div class="offline-beat-actions" ${hidden ? 'hidden' : ''}>
      ${reroll ? `<button type="button" class="offline-beat-reroll" data-beat-reroll="${escBeat(beatId)}">重 roll</button>` : ''}
      ${guidedRevision ? `<button type="button" class="offline-beat-revise" data-beat-revise="${escBeat(beatId)}">指导重修</button>` : ''}
      ${supplementalAudit ? `<button type="button" class="offline-beat-audit-reroll" data-beat-audit-reroll="${escBeat(beatId)}">补审重写</button>` : ''}
      ${expertConsultation ? `<button type="button" class="offline-beat-expert" data-beat-expert="${escBeat(beatId)}">专家会诊 <small>测试中</small></button>` : ''}
      ${continuation ? `<button type="button" class="offline-beat-continue" data-beat-continue="${escBeat(beatId)}">续写本层</button>` : ''}
      ${bookmark ? `<button type="button" class="offline-beat-bookmark" data-beat-bookmark="${escBeat(beatId)}">存为节点</button>` : ''}
      ${fork ? `<button type="button" class="offline-beat-fork" data-beat-fork="${escBeat(beatId)}">从这里另开路线</button>` : ''}
      ${favorite ? `<button type="button" class="offline-beat-favorite" data-beat-favorite="${escBeat(beatId)}">收藏到记忆馆</button>` : ''}
      ${image ? `<button type="button" class="offline-beat-image-btn" data-beat-image="${escBeat(beatId)}">${hasImage ? '换图' : '生图'}</button>` : ''}
      ${clearImage ? `<button type="button" class="offline-beat-image-clear" data-beat-image-clear="${escBeat(beatId)}">删除图片</button>` : ''}
      <button type="button" class="offline-beat-edit" data-beat-edit="${escBeat(beatId)}">编辑</button>
      <button type="button" class="offline-beat-delete" data-beat-delete="${escBeat(beatId)}" aria-label="删除">删除</button>
    </div>`;
}

/**
 * 把楼层的隐藏操作列表放进 body 级面板，避开正文宽度、overflow 与用户 CSS。
 * 返回关闭函数，页面重绘或离开时可主动清理。
 */
export function openOfflineBeatActionLayer(trigger, actions, { themeSource = null } = {}) {
  if (!trigger || !actions) return null;

  const layer = document.createElement('div');
  layer.className = 'offline-beat-action-layer';
  layer.innerHTML = `
    <button type="button" class="offline-beat-action-backdrop" data-beat-action-close aria-label="关闭本段操作"></button>
    <section class="offline-beat-action-sheet" role="dialog" aria-modal="true" aria-label="本段操作">
      <div class="offline-beat-action-sheet-head">
        <strong>本段操作</strong>
        <button type="button" data-beat-action-close aria-label="关闭本段操作">${icon('close')}</button>
      </div>
      <div class="offline-beat-action-sheet-list"></div>
      <button type="button" class="offline-beat-action-cancel" data-beat-action-close>取消</button>
    </section>`;

  const actionList = actions.cloneNode(true);
  actionList.hidden = false;
  layer.querySelector('.offline-beat-action-sheet-list')?.appendChild(actionList);

  const source = themeSource || trigger.closest('.offline-session-page') || document.documentElement;
  const pageStyle = window.getComputedStyle(source);
  [
    '--os-paper',
    '--os-ink',
    '--os-ink-2',
    '--os-ink-3',
    '--os-line',
    '--os-accent',
    '--os-accent-soft',
    '--os-sans',
  ].forEach((name) => {
    const value = pageStyle.getPropertyValue(name);
    if (value) layer.style.setProperty(name, value);
  });

  let closed = false;
  const close = ({ restoreFocus = false } = {}) => {
    if (closed) return;
    closed = true;
    layer.remove();
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('hashchange', onRouteLeave);
    window.removeEventListener('pagehide', onRouteLeave);
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && trigger.isConnected) {
      try { trigger.focus({ preventScroll: true }); } catch (_) { trigger.focus(); }
    }
  };
  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close({ restoreFocus: true });
  };
  const onRouteLeave = () => close();

  layer.addEventListener('click', (event) => {
    const eventTarget = eventTargetElement(event);
    if (!eventTarget) return;
    if (eventTarget.closest('[data-beat-action-close]')) {
      close({ restoreFocus: true });
      return;
    }
    const actionButton = eventTarget.closest('.offline-beat-actions button');
    if (!actionButton || !layer.contains(actionButton)) return;
    const actionClass = [...actionButton.classList]
      .find((name) => name.startsWith('offline-beat-'));
    const originalButton = actionClass ? actions.querySelector(`.${actionClass}`) : null;
    close();
    originalButton?.click();
  });

  document.body.appendChild(layer);
  trigger.setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('hashchange', onRouteLeave);
  window.addEventListener('pagehide', onRouteLeave);
  window.requestAnimationFrame(() => {
    const firstAction = layer.querySelector('.offline-beat-actions button');
    if (!firstAction) return;
    try { firstAction.focus({ preventScroll: true }); } catch (_) { firstAction.focus(); }
  });
  return close;
}

/**
 * 绑定 beat 删除：点击删除按钮 + 长按 beat 卡片触发删除。
 * onDelete(beatId) 应自行 confirm 并落库。
 */
export function bindOfflineBeatDelete(container, { onDelete, isDeletable = () => true } = {}) {
  if (!container || typeof onDelete !== 'function') return () => {};
  let pressTimer = null;
  let pressBeatId = '';

  const clearPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    pressBeatId = '';
  };

  const onClick = (e) => {
    const delBtn = eventTargetElement(e)?.closest('[data-beat-delete]');
    if (delBtn && container.contains(delBtn)) {
      e.preventDefault();
      const beatId = delBtn.getAttribute('data-beat-delete');
      if (beatId && isDeletable(beatId)) onDelete(beatId);
      return;
    }
  };

  const onTouchStart = (e) => {
    const eventTarget = eventTargetElement(e);
    if (!eventTarget) return;
    const beat = eventTarget.closest('.offline-beat[data-beat-id]');
    if (!beat || !container.contains(beat)) return;
    if (eventTarget.closest('.offline-beat-actions, .offline-beat-image, .offline-beat-audio, audio, img, button, a')) return;
    const beatId = beat.getAttribute('data-beat-id');
    if (!beatId || !isDeletable(beatId)) return;
    clearPress();
    pressBeatId = beatId;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      onDelete(pressBeatId);
      pressBeatId = '';
    }, 550);
  };

  container.addEventListener('click', onClick);
  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchend', clearPress);
  container.addEventListener('touchmove', clearPress);
  container.addEventListener('touchcancel', clearPress);

  return () => {
    clearPress();
    container.removeEventListener('click', onClick);
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchend', clearPress);
    container.removeEventListener('touchmove', clearPress);
    container.removeEventListener('touchcancel', clearPress);
  };
}
