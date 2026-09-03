/**
 * 全屏查看聊天图片（data URL 或 http URL）
 */
import { saveBlobNatively } from '../core/native-file-export.js';
function inferImageExt(src = '') {
  const raw = String(src || '');
  const m = raw.match(/^data:image\/([a-z0-9.+-]+);/i);
  const type = (m?.[1] || '').toLowerCase();
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  if (type.includes('png')) return 'png';
  return 'png';
}

async function imageSrcToBlob(src = '') {
  const raw = String(src || '').trim();
  if (!raw) throw new Error('没有图片地址');
  const res = await fetch(raw);
  if (!res.ok) throw new Error('图片读取失败');
  return res.blob();
}

export async function saveImageSrc(src = '', options = {}) {
  const raw = String(src || '').trim();
  if (!raw) throw new Error('没有图片地址');
  const filename = String(options.filename || `marshmallow-phone-image-${Date.now()}.${inferImageExt(raw)}`).trim();
  try {
    const blob = await imageSrcToBlob(raw);
    // Android 原生壳：系统 WebView 的 <a download> 对 blob: URL 基本不生效，
    // 优先走原生插件直接写入相册，比弹分享面板更省事，也比裸下载可靠。
    try {
      const nativeSaved = await saveBlobNatively(blob, { filename, mimeType: blob.type || `image/${inferImageExt(raw)}`, directory: 'pictures' });
      if (nativeSaved?.ok) return 'native';
    } catch (err) {
      console.warn('[image-lightbox] native save failed, fallback to share/download', err);
    }
    const file = new File([blob], filename, { type: blob.type || `image/${inferImageExt(raw)}` });
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return 'downloaded';
  } catch (err) {
    const a = document.createElement('a');
    a.href = raw;
    a.download = filename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (/^https?:\/\//i.test(raw)) return 'opened';
    throw err;
  }
}

export function describeImageSaveResult(result = '') {
  if (result === 'native') return '已保存到相册';
  if (result === 'shared') return '已打开系统分享';
  if (result === 'downloaded') return '已开始下载';
  if (result === 'opened') return '图片已打开，请长按保存';
  return '图片已保存';
}

export function openImageLightbox(src, options = {}) {
  if ((!src || typeof src !== 'string') && typeof options.onReroll !== 'function' && !options.statusMessage) return;
  const canReroll = typeof options.onReroll === 'function';
  const canEditPrompt = typeof options.onEditPrompt === 'function';
  const initialSrc = typeof src === 'string' ? src.trim() : '';
  const statusMessage = String(options.statusMessage || '').trim();
  const prevOverflow = document.body.style.overflow;
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const backdrop = document.createElement('div');
  backdrop.className = 'image-lightbox-backdrop';

  const img = document.createElement('img');
  img.className = 'image-lightbox-img';
  img.alt = '图片预览';
  img.decoding = 'async';
  if (initialSrc) img.src = initialSrc;

  const broken = document.createElement('div');
  broken.className = 'image-lightbox-broken';
  broken.textContent = statusMessage || (canReroll ? '图片已失效，可以重 roll' : '图片已失效');
  broken.style.display = initialSrc ? 'none' : '';
  if (!initialSrc) img.style.display = 'none';
  img.addEventListener('error', () => {
    img.style.display = 'none';
    broken.style.display = '';
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'image-lightbox-close';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.textContent = '×';

  const hint = document.createElement('div');
  hint.className = 'image-lightbox-hint';
  hint.textContent = initialSrc
    ? '点击空白处或 × 关闭 · 可保存 · Esc'
    : (canReroll ? '点击空白处关闭 · 可重 roll · Esc' : '点击空白处关闭 · Esc');

  const actions = document.createElement('div');
  actions.className = 'image-lightbox-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'image-lightbox-save';
  saveBtn.textContent = '保存';
  saveBtn.style.display = initialSrc ? '' : 'none';
  actions.appendChild(saveBtn);

  const rerollBtn = document.createElement('button');
  rerollBtn.type = 'button';
  rerollBtn.className = 'image-lightbox-reroll';
  rerollBtn.textContent = '重 roll';
  rerollBtn.style.display = canReroll ? '' : 'none';
  actions.appendChild(rerollBtn);

  const editPromptBtn = document.createElement('button');
  editPromptBtn.type = 'button';
  editPromptBtn.className = 'image-lightbox-edit-prompt';
  editPromptBtn.textContent = '改词重画';
  editPromptBtn.style.display = canEditPrompt ? '' : 'none';
  actions.appendChild(editPromptBtn);

  function close() {
    document.body.style.overflow = prevOverflow;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(ev) {
    if (ev.key === 'Escape') close();
  }

  overlay.appendChild(backdrop);
  overlay.appendChild(img);
  overlay.appendChild(broken);
  overlay.appendChild(closeBtn);
  overlay.appendChild(actions);
  overlay.appendChild(hint);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey);

  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });
  img.addEventListener('click', (e) => e.stopPropagation());
  actions.addEventListener('click', (e) => e.stopPropagation());
  saveBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (saveBtn.disabled) return;
    const oldText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      await saveImageSrc(img.currentSrc || img.src, options.save || {});
      saveBtn.textContent = '已保存';
      setTimeout(() => {
        saveBtn.textContent = oldText;
      }, 1200);
    } catch (err) {
      console.warn('[image-lightbox] save failed', err);
      saveBtn.textContent = '保存失败';
      setTimeout(() => {
        saveBtn.textContent = oldText;
      }, 1400);
    } finally {
      saveBtn.disabled = false;
    }
  });
  let longPressTimer = null;
  const clearLongPress = () => {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  };
  img.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    clearLongPress();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      saveBtn.click();
    }, 650);
  });
  img.addEventListener('pointerup', clearLongPress);
  img.addEventListener('pointercancel', clearLongPress);
  img.addEventListener('pointerleave', clearLongPress);
  editPromptBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!canEditPrompt) return;
    // 编辑提示词走独立弹窗，先关掉大图避免层级叠加
    close();
    options.onEditPrompt();
  });
  rerollBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!canReroll || rerollBtn.disabled) return;
    if (typeof options.confirmReroll === 'function') {
      const confirmed = await options.confirmReroll();
      if (!confirmed) return;
    }
    const oldText = rerollBtn.textContent;
    rerollBtn.disabled = true;
    rerollBtn.textContent = '生成中…';
    // 立刻收起旧图/失效图，换成「正在重新生成」占位，避免半透明旧图一直挂着。
    img.style.display = 'none';
    img.removeAttribute('src');
    broken.textContent = '正在重新生成…';
    broken.style.display = '';
    saveBtn.style.display = 'none';
    try {
      const nextSrc = await options.onReroll({
        currentSrc: initialSrc,
        setStatus: (text) => {
          broken.textContent = String(text || '正在重新生成…');
          broken.style.display = '';
        },
        clearImage: () => {
          img.style.display = 'none';
          img.removeAttribute('src');
        },
      });
      if (nextSrc) {
        img.style.display = '';
        broken.style.display = 'none';
        saveBtn.style.display = '';
        img.src = nextSrc;
      } else {
        broken.textContent = statusMessage || (canReroll ? '图片已失效，可以重 roll' : '图片已失效');
      }
      rerollBtn.textContent = oldText;
    } catch (err) {
      console.warn('[image-lightbox] reroll failed', err);
      broken.textContent = String(err?.message || '生成失败，可再试一次').slice(0, 80);
      broken.style.display = '';
      rerollBtn.textContent = '失败';
      setTimeout(() => {
        rerollBtn.textContent = oldText;
      }, 1200);
    } finally {
      rerollBtn.disabled = false;
    }
  });
}
