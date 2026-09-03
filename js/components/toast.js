const activeBasicToasts = new Map();

export function showToast(msg, duration = 2800) {
  let wrap = document.getElementById('toast-container');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-container';
    document.body.appendChild(wrap);
  }
  const text = String(msg || '');
  const active = activeBasicToasts.get(text);
  if (active?.el?.isConnected) {
    clearTimeout(active.timer);
    wrap.appendChild(active.el);
    active.timer = setTimeout(() => {
      active.el.remove();
      if (activeBasicToasts.get(text) === active) activeBasicToasts.delete(text);
    }, duration);
    return active.el;
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  wrap.appendChild(el);
  const entry = { el, timer: 0 };
  entry.timer = setTimeout(() => {
    el.remove();
    if (activeBasicToasts.get(text) === entry) activeBasicToasts.delete(text);
  }, duration);
  activeBasicToasts.set(text, entry);
  return el;
}

export function showActionToast(msg, options = {}) {
  let wrap = document.getElementById('toast-container');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-container';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast has-action';
  const copy = document.createElement('span');
  copy.textContent = String(msg || '');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toast-action';
  button.textContent = String(options.label || '撤销');
  el.append(copy, button);
  wrap.appendChild(el);

  let settled = false;
  let timer = 0;
  const close = (reason = 'timeout') => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    el.remove();
    if (reason === 'timeout') options.onExpire?.();
  };
  button.addEventListener('click', async () => {
    if (settled) return;
    button.disabled = true;
    try {
      await options.onAction?.();
      close('action');
    } catch (error) {
      button.disabled = false;
      options.onError?.(error);
    }
  });
  timer = setTimeout(() => close('timeout'), Math.max(1000, Number(options.duration) || 6500));
  return { close, element: el };
}
