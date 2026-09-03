/**
 * 右滑气泡快捷引用回复（微信式手感）
 */
export function bindBubbleSwipeReply(container, options = {}) {
  if (!container || container.__bubbleSwipeReplyBound) return;
  container.__bubbleSwipeReplyBound = true;

  const onReply = typeof options.onReply === 'function' ? options.onReply : () => {};
  const threshold = Math.max(40, Number(options.threshold) || 52);
  const maxShift = Math.max(threshold, Number(options.maxShift) || 76);
  const isDisabled = typeof options.isDisabled === 'function' ? options.isDisabled : () => false;

  let active = null;

  function resetRow(row) {
    if (!row) return;
    row.classList.remove('is-swipe-reply-active');
    row.style.transform = '';
    row.style.transition = '';
  }

  function applyShift(row, dx) {
    const shift = Math.min(maxShift, Math.max(0, dx * 0.88));
    row.classList.add('is-swipe-reply-active');
    row.style.transition = 'none';
    row.style.transform = `translate3d(${shift}px, 0, 0)`;
    return shift;
  }

  function startTracking(clientX, clientY, row) {
    if (isDisabled()) return;
    if (!row || row.classList.contains('is-system')) return;
    active = {
      row,
      startX: clientX,
      startY: clientY,
      tracking: true,
      pointerId: null,
    };
  }

  function finishTracking(clientX, commit = true) {
    if (!active) return;
    const row = active.row;
    const dx = clientX - active.startX;
    const shouldReply = commit && active.tracking && dx >= threshold;
    active = null;
    row.style.transition = 'transform 0.22s cubic-bezier(.2,.8,.2,1)';
    row.style.transform = '';
    window.setTimeout(() => resetRow(row), 230);
    if (shouldReply) {
      const msgId = row.getAttribute('data-msg-id');
      if (msgId) onReply(msgId, row);
    }
  }

  const itemSelector = [
    '.chat-msg-bubble[data-msg-id]:not(.is-system)',
    '.chat-msg-card[data-msg-id]:not(.is-system)',
    '.chat-msg-media[data-msg-id]:not(.is-system)',
  ].join(', ');
  const rowSelector = '.chat-bubble-row[data-msg-id]:not(.is-system):not(.is-stack-group)';

  function resolveSwipeTarget(node) {
    if (!node) return null;
    const item = node.closest(itemSelector);
    if (item) return item;
    return node.closest(rowSelector);
  }

  container.addEventListener('touchstart', (e) => {
    if (isDisabled()) return;
    const row = resolveSwipeTarget(e.target);
    if (!row || !container.contains(row)) return;
    if (e.target.closest('.chat-bubble-select, button, a, input, textarea, .chat-user-image-wrap')) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    startTracking(t.clientX, t.clientY, row);
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!active?.tracking) return;
    const t = e.touches[0];
    const dx = t.clientX - active.startX;
    const dy = t.clientY - active.startY;
    if (Math.abs(dy) > Math.abs(dx) * 1.2 && Math.abs(dx) < 14) {
      resetRow(active.row);
      active = null;
      return;
    }
    if (dx <= 2) {
      resetRow(active.row);
      return;
    }
    e.preventDefault();
    applyShift(active.row, dx);
  }, { passive: false });

  container.addEventListener('touchend', (e) => {
    if (!active) return;
    const t = e.changedTouches[0];
    finishTracking(t.clientX, true);
  }, { passive: true });

  container.addEventListener('touchcancel', () => {
    if (!active) return;
    resetRow(active.row);
    active = null;
  }, { passive: true });

  container.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    if (isDisabled() || e.button !== 0) return;
    const row = resolveSwipeTarget(e.target);
    if (!row || !container.contains(row)) return;
    if (e.target.closest('.chat-bubble-select, button, a, input, textarea, .chat-user-image-wrap')) return;
    active = {
      row,
      startX: e.clientX,
      startY: e.clientY,
      tracking: true,
      pointerId: e.pointerId,
    };
    try { row.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });

  container.addEventListener('pointermove', (e) => {
    if (!active || active.pointerId !== e.pointerId) return;
    const dx = e.clientX - active.startX;
    const dy = e.clientY - active.startY;
    if (Math.abs(dy) > Math.abs(dx) * 1.2 && Math.abs(dx) < 14) {
      resetRow(active.row);
      active.tracking = false;
      return;
    }
    if (dx <= 2) {
      resetRow(active.row);
      return;
    }
    active.tracking = true;
    applyShift(active.row, dx);
  });

  container.addEventListener('pointerup', (e) => {
    if (!active || active.pointerId !== e.pointerId) return;
    const row = active.row;
    const shouldReply = active.tracking && (e.clientX - active.startX) >= threshold;
    active = null;
    try { row.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    row.style.transition = 'transform 0.22s cubic-bezier(.2,.8,.2,1)';
    row.style.transform = '';
    window.setTimeout(() => resetRow(row), 230);
    if (shouldReply) {
      const msgId = row.getAttribute('data-msg-id');
      if (msgId) onReply(msgId, row);
    }
  });

  container.addEventListener('pointercancel', (e) => {
    if (!active || active.pointerId !== e.pointerId) return;
    resetRow(active.row);
    active = null;
  });
}
