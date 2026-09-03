/** 主屏横向分页：让浏览器负责 scroll-snap，JS 只在停稳后记录最终页。 */
export function installHomePagedScrollGuard(pagesEl, pageSelector, { onSettled = null } = {}) {
  if (!pagesEl) return null;

  let anchorPage = 0;
  let touching = false;
  let settleTimer = null;
  let wheelTimer = null;

  function pageWidth() {
    return Math.max(1, pagesEl.clientWidth);
  }

  function maxPage() {
    return Math.max(0, pagesEl.querySelectorAll(pageSelector).length - 1);
  }

  function readIndex() {
    const index = Math.round(pagesEl.scrollLeft / pageWidth());
    return Math.max(0, Math.min(maxPage(), index));
  }

  function isNearPage(index, width = pageWidth()) {
    const expected = index * width;
    return Math.abs(pagesEl.scrollLeft - expected) <= Math.max(3, width * 0.1);
  }

  /** Keep-Alive 挂起会 hidden + 摘树，浏览器常把 scrollLeft 清零；此时绝不能按滚动位置改锚点。 */
  function isScrollerInactive() {
    if (!pagesEl.isConnected) return true;
    const page = pagesEl.closest('.page');
    if (page?.hidden || page?.classList?.contains('page--suspended')) return true;
    return !!pagesEl.closest('.page--suspended, [hidden]');
  }

  function onGestureStart() {
    if (isScrollerInactive()) return;
    touching = true;
    clearTimeout(settleTimer);
    settleTimer = null;
  }

  function onGestureEnd() {
    touching = false;
    if (isScrollerInactive()) {
      clearTimeout(settleTimer);
      settleTimer = null;
      return;
    }
    // scrollend 不稳定的 WebView 用空闲窗口兜底；期间绝不主动 scrollTo。
    queueSettle(180);
  }

  function setAnchor(index) {
    anchorPage = Math.max(0, Math.min(maxPage(), Number(index) || 0));
    touching = false;
    clearTimeout(settleTimer);
    settleTimer = null;
    clearTimeout(wheelTimer);
    wheelTimer = null;
  }

  function settle() {
    settleTimer = null;
    // 摘树 / 挂起后 scrollLeft 常被清成 0，不能把它记成用户翻页。
    if (isScrollerInactive()) {
      touching = false;
      return;
    }

    const width = pageWidth();
    if (!width || touching) return;

    const nearest = readIndex();
    // 仍卡在两页中间说明 snap / 动量没结束，再等；不做任何纠偏。
    if (!isNearPage(nearest, width)) {
      queueSettle(160);
      return;
    }

    anchorPage = nearest;
    onSettled?.(anchorPage);
  }

  function queueSettle(delay = 180) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, delay);
  }

  anchorPage = readIndex();

  const onWheel = () => {
    if (isScrollerInactive()) return;
    if (!touching) onGestureStart();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(onGestureEnd, 120);
  };

  const onScroll = () => {
    if (isScrollerInactive()) return;
    // 每个 scroll 都重置空闲计时，只读取最终位置，永不在滚动事件里写 scrollLeft。
    if (!touching) queueSettle();
  };

  const onScrollEnd = () => {
    if (touching || isScrollerInactive()) return;
    queueSettle(0);
  };

  pagesEl.addEventListener('touchstart', onGestureStart, { passive: true });
  pagesEl.addEventListener('mousedown', onGestureStart, { passive: true });
  pagesEl.addEventListener('touchend', onGestureEnd, { passive: true });
  pagesEl.addEventListener('touchcancel', onGestureEnd, { passive: true });
  pagesEl.addEventListener('mouseup', onGestureEnd, { passive: true });
  pagesEl.addEventListener('wheel', onWheel, { passive: true });
  pagesEl.addEventListener('scroll', onScroll, { passive: true });
  if ('onscrollend' in window) pagesEl.addEventListener('scrollend', onScrollEnd, { passive: true });

  return {
    setAnchor,
    getAnchor: () => anchorPage,
    dispose() {
      clearTimeout(settleTimer);
      clearTimeout(wheelTimer);
      pagesEl.removeEventListener('touchstart', onGestureStart);
      pagesEl.removeEventListener('mousedown', onGestureStart);
      pagesEl.removeEventListener('touchend', onGestureEnd);
      pagesEl.removeEventListener('touchcancel', onGestureEnd);
      pagesEl.removeEventListener('mouseup', onGestureEnd);
      pagesEl.removeEventListener('wheel', onWheel);
      pagesEl.removeEventListener('scroll', onScroll);
      pagesEl.removeEventListener('scrollend', onScrollEnd);
    },
  };
}
