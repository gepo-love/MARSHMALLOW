export function captureElementScrollState(root, selector, threshold = 80) {
  const scroller = root?.querySelector?.(selector);
  if (!scroller) return null;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const top = scroller.scrollTop;
  // 仅在用户确实滚离顶部且接近底部时贴底；短列表/在顶部时 max-top 也会 < threshold，不能误判
  return {
    top,
    nearBottom: max > 0 && top > 0 && max - top < threshold,
  };
}

export function restoreElementScrollState(root, selector, state) {
  if (!state) return;
  requestAnimationFrame(() => {
    const scroller = root?.querySelector?.(selector);
    if (!scroller) return;
    if (state.nearBottom) {
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      return;
    }
    scroller.scrollTop = Math.max(0, state.top);
  });
}

/** 同步读取滚动容器当前位置（整页 innerHTML 重绘前调用）。 */
export function captureScrollerTop(root, selector) {
  return root?.querySelector?.(selector)?.scrollTop || 0;
}

/** 整页重绘后立刻写回 scrollTop，避免开关/保存后弹回顶部。 */
export function restoreScrollerTop(root, selector, top) {
  const scroller = root?.querySelector?.(selector);
  if (!scroller) return;
  scroller.scrollTop = Math.max(0, Number(top) || 0);
}

/**
 * 纵向表单长按输入框时，部分 Android 浏览器会为了展示选区菜单而修改父容器 scrollLeft。
 * CSS 隐藏横向溢出仍可能被这种程序性滚动绕过，因此同步钉回横向起点。
 */
export function lockScrollerToVerticalAxis(root, selector) {
  const scroller = root?.querySelector?.(selector);
  if (!scroller) return;

  const resetHorizontalOffset = () => {
    if (scroller.scrollLeft !== 0) scroller.scrollLeft = 0;
  };

  resetHorizontalOffset();
  scroller.addEventListener('scroll', resetHorizontalOffset, { passive: true });
}
