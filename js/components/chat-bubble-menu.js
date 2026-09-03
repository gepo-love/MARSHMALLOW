let activeMenuClose = null;

export function openChatBubbleMenu({
  x,
  y,
  actions = [],
  onClosed,
} = {}) {
  const host = document.getElementById('toast-container');
  if (!host) return;
  activeMenuClose?.();

  const menu = document.createElement('div');
  menu.className = 'chat-bubble-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = (actions || []).map((action, idx) => `
    <button type="button" role="menuitem" class="chat-bubble-menu-item ${action.danger ? 'is-danger' : ''}" data-idx="${idx}">
      ${action.label}
    </button>
  `).join('');
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - rect.width / 2), window.innerWidth - rect.width - 8);
  const top = Math.min(Math.max(8, y - rect.height - 8), window.innerHeight - rect.height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    menu.remove();
    document.removeEventListener('touchstart', onDocPressStart, true);
    document.removeEventListener('mousedown', onDocPressStart, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('hashchange', close);
    window.removeEventListener('pagehide', close);
    if (activeMenuClose === close) activeMenuClose = null;
    onClosed?.();
  };
  const onDocPressStart = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') close();
  };
  activeMenuClose = close;
  // 当前长按的触摸仍未抬起；只监听下一次按下，避免同一手势收尾时 Android
  // WebView 合成 click，把菜单关掉或点穿到下层浮窗。touchstart 在菜单
  // 打开前已经派发完，因此这里监听 touchstart + mousedown 也能兼容 Pointer Events
  // 链不稳定的红米 WebView。
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('touchstart', onDocPressStart, true);
    document.addEventListener('mousedown', onDocPressStart, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('hashchange', close);
    window.addEventListener('pagehide', close);
  }, 0);
  menu.querySelectorAll('.chat-bubble-menu-item').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      const idx = Number(btn.getAttribute('data-idx'));
      const action = actions[idx];
      close();
      await action?.onClick?.(event);
    });
  });
}

export function bindLongPress(el, onLongPress, delayMs = 480) {
  if (!el || typeof onLongPress !== 'function') return () => {};
  let timer = null;
  let activeTouchId = null;
  let mouseActive = false;
  let startX = 0;
  let startY = 0;
  let longPressFiredAt = 0;
  let lastTouchAt = 0;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const clear = () => {
    clearTimer();
    activeTouchId = null;
    mouseActive = false;
  };
  const arm = (x, y) => {
    clear();
    startX = x;
    startY = y;
    timer = setTimeout(() => {
      timer = null;
      longPressFiredAt = Date.now();
      onLongPress({ x: startX, y: startY });
    }, delayMs);
  };
  const findTouch = (list, identifier) => {
    for (let i = 0; i < (list?.length || 0); i += 1) {
      if (list[i].identifier === identifier) return list[i];
    }
    return null;
  };
  const touchStart = (e) => {
    if ((e.touches?.length || 0) !== 1) {
      clear();
      return;
    }
    const point = e.touches[0];
    lastTouchAt = Date.now();
    arm(point.clientX, point.clientY);
    activeTouchId = point.identifier;
  };
  const touchMove = (e) => {
    if (activeTouchId == null) return;
    const point = findTouch(e.touches, activeTouchId);
    if (!point) {
      clear();
      return;
    }
    if (Math.abs(point.clientX - startX) > 12 || Math.abs(point.clientY - startY) > 12) clear();
  };
  const touchEnd = (e) => {
    lastTouchAt = Date.now();
    if (activeTouchId == null || findTouch(e.touches, activeTouchId)) return;
    clear();
  };
  const mouseStart = (e) => {
    // Android 会在 touchend 后补一套兼容 mouse 事件；不去重会让同一根长按
    // 再启动第二个计时器，正是旧版菜单重复、监听堆积的来源。
    if (Date.now() - lastTouchAt < 1000 || e.button !== 0) return;
    arm(e.clientX, e.clientY);
    mouseActive = true;
  };
  const mouseMove = (e) => {
    if (!mouseActive) return;
    if (Math.abs(e.clientX - startX) > 12 || Math.abs(e.clientY - startY) > 12) clear();
  };
  const mouseEnd = () => {
    if (mouseActive) clear();
  };
  const suppressNativeContextMenu = (e) => {
    if (activeTouchId == null && Date.now() - lastTouchAt > 1000) return;
    e.preventDefault();
  };
  const suppressSyntheticClick = (e) => {
    if (!longPressFiredAt || Date.now() - longPressFiredAt > 900) return;
    longPressFiredAt = 0;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
  };
  el.addEventListener('touchstart', touchStart, { passive: true });
  el.addEventListener('touchmove', touchMove, { passive: true });
  el.addEventListener('touchend', touchEnd, { passive: true });
  el.addEventListener('touchcancel', touchEnd, { passive: true });
  el.addEventListener('mousedown', mouseStart);
  el.addEventListener('mousemove', mouseMove);
  el.addEventListener('mouseup', mouseEnd);
  el.addEventListener('mouseleave', mouseEnd);
  el.addEventListener('contextmenu', suppressNativeContextMenu);
  el.addEventListener('click', suppressSyntheticClick, true);
  return () => {
    clear();
    el.removeEventListener('touchstart', touchStart);
    el.removeEventListener('touchmove', touchMove);
    el.removeEventListener('touchend', touchEnd);
    el.removeEventListener('touchcancel', touchEnd);
    el.removeEventListener('mousedown', mouseStart);
    el.removeEventListener('mousemove', mouseMove);
    el.removeEventListener('mouseup', mouseEnd);
    el.removeEventListener('mouseleave', mouseEnd);
    el.removeEventListener('contextmenu', suppressNativeContextMenu);
    el.removeEventListener('click', suppressSyntheticClick, true);
  };
}
