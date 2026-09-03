/**
 * 为移动端列表绑定左滑操作；桌面端通过显式「更多」按钮展开同一组操作。
 * 行结构需包含 [data-swipe-content] 与 [data-swipe-actions]。
 */
export function bindSwipeActions(root, {
  rowSelector = '[data-swipe-row]',
  openClass = 'is-swipe-open',
  threshold = 42,
} = {}) {
  if (!root) return () => {};
  let opened = null;
  const cleanups = [];

  const close = (row = opened) => {
    if (!row) return;
    row.classList.remove(openClass);
    row.querySelector('[data-swipe-more]')?.setAttribute('aria-expanded', 'false');
    if (opened === row) opened = null;
  };
  const open = (row) => {
    if (!row) return;
    if (opened && opened !== row) close(opened);
    row.classList.add(openClass);
    row.querySelector('[data-swipe-more]')?.setAttribute('aria-expanded', 'true');
    opened = row;
  };

  root.querySelectorAll(rowSelector).forEach((row) => {
    const content = row.querySelector('[data-swipe-content]');
    const more = row.querySelector('[data-swipe-more]');
    let startX = 0;
    let startY = 0;
    let startOffset = 0;
    let currentOffset = 0;
    let tracking = false;
    let horizontal = false;
    let suppressClickUntil = 0;

    const actionWidth = () => {
      const actions = row.querySelector('[data-swipe-actions]');
      return Math.max(1, Math.round(actions?.getBoundingClientRect().width || 0));
    };
    const setDragOffset = (value) => {
      currentOffset = value;
      row.style.setProperty('--swipe-offset', `${value}px`);
    };
    const finishDrag = (shouldOpen) => {
      row.classList.remove('is-swipe-dragging');
      row.style.removeProperty('--swipe-offset');
      if (shouldOpen) open(row);
      else close(row);
    };

    const onStart = (event) => {
      const touch = event.touches?.[0];
      if (!touch || event.target.closest('[data-swipe-actions]')) return;
      startX = touch.clientX;
      startY = touch.clientY;
      startOffset = row.classList.contains(openClass) ? -actionWidth() : 0;
      currentOffset = startOffset;
      tracking = true;
      horizontal = false;
    };
    const onMove = (event) => {
      if (!tracking) return;
      const touch = event.touches?.[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (!horizontal) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        if (Math.abs(dx) <= Math.abs(dy) * 1.12) {
          tracking = false;
          return;
        }
        horizontal = true;
        row.classList.add('is-swipe-dragging');
      }
      event.preventDefault();
      const width = actionWidth();
      setDragOffset(Math.max(-width, Math.min(0, startOffset + dx)));
    };
    const onEnd = (event) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches?.[0];
      if (!touch || !horizontal) return;
      const dx = touch.clientX - startX;
      const width = actionWidth();
      const decisive = Math.abs(dx) >= threshold;
      const shouldOpen = decisive ? dx < 0 : currentOffset <= -width / 2;
      suppressClickUntil = Date.now() + 360;
      finishDrag(shouldOpen);
    };
    const onCancel = () => {
      if (!tracking && !horizontal) return;
      const wasOpen = startOffset < 0;
      tracking = false;
      horizontal = false;
      finishDrag(wasOpen);
    };
    const onContentClick = (event) => {
      if (Date.now() > suppressClickUntil) return;
      suppressClickUntil = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onMore = (event) => {
      event.stopPropagation();
      if (row.classList.contains(openClass)) close(row);
      else open(row);
    };

    content?.addEventListener('touchstart', onStart, { passive: true });
    content?.addEventListener('touchmove', onMove, { passive: false });
    content?.addEventListener('touchend', onEnd, { passive: true });
    content?.addEventListener('touchcancel', onCancel, { passive: true });
    content?.addEventListener('click', onContentClick, true);
    more?.addEventListener('click', onMore);
    cleanups.push(() => {
      content?.removeEventListener('touchstart', onStart);
      content?.removeEventListener('touchmove', onMove);
      content?.removeEventListener('touchend', onEnd);
      content?.removeEventListener('touchcancel', onCancel);
      content?.removeEventListener('click', onContentClick, true);
      more?.removeEventListener('click', onMore);
      row.classList.remove('is-swipe-dragging');
      row.style.removeProperty('--swipe-offset');
    });
  });

  const onRootClick = (event) => {
    if (opened && !event.target.closest(rowSelector)) close(opened);
  };
  root.addEventListener('click', onRootClick);
  return () => {
    root.removeEventListener('click', onRootClick);
    cleanups.forEach((fn) => fn());
    close();
  };
}
