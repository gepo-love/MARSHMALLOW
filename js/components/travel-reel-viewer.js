/**
 * 旅行char回忆胶卷 · 全屏查看器
 *
 * 参考语境：手机相册里点开一张照片的样子——深色背景、顶部「第 X / 共 Y 张」计数、
 * 底部一行手写体批注（地点 · 第几天）。图片本身来自旅行途中拍到的实景照 + 归来明信片。
 */
import { saveImageSrc } from './image-lightbox.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function openTravelReelViewer({ images = [], startIndex = 0 } = {}) {
  const list = Array.isArray(images) ? images.filter((item) => item && item.src) : [];
  if (!list.length) return null;
  let index = Math.max(0, Math.min(list.length - 1, Number(startIndex) || 0));
  const prevOverflow = document.body.style.overflow;

  const overlay = document.createElement('div');
  overlay.className = 'travel-reel-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '旅行回忆胶卷');

  overlay.innerHTML = `
    <div class="travel-reel-backdrop"></div>
    <header class="travel-reel-head">
      <span class="travel-reel-count"></span>
      <button type="button" class="travel-reel-save" aria-label="保存">保存</button>
      <button type="button" class="travel-reel-close" aria-label="关闭">${'\u00d7'}</button>
    </header>
    <div class="travel-reel-stage">
      <button type="button" class="travel-reel-nav is-prev" aria-label="上一张">${'\u2039'}</button>
      <figure class="travel-reel-frame">
        <img class="travel-reel-img" alt="旅行照片">
        <div class="travel-reel-broken" hidden>这张照片已经失效</div>
        <figcaption class="travel-reel-caption"></figcaption>
      </figure>
      <button type="button" class="travel-reel-nav is-next" aria-label="下一张">${'\u203a'}</button>
    </div>
    <div class="travel-reel-strip" role="tablist"></div>
  `;

  const countEl = overlay.querySelector('.travel-reel-count');
  const imgEl = overlay.querySelector('.travel-reel-img');
  const brokenEl = overlay.querySelector('.travel-reel-broken');
  const captionEl = overlay.querySelector('.travel-reel-caption');
  const stripEl = overlay.querySelector('.travel-reel-strip');
  const prevBtn = overlay.querySelector('.travel-reel-nav.is-prev');
  const nextBtn = overlay.querySelector('.travel-reel-nav.is-next');
  const saveBtn = overlay.querySelector('.travel-reel-save');

  imgEl.addEventListener('error', () => {
    imgEl.style.display = 'none';
    brokenEl.hidden = false;
  });

  stripEl.innerHTML = list.map((item, i) => `
    <button type="button" class="travel-reel-thumb" data-idx="${i}" role="tab" aria-label="第 ${i + 1} 张">
      <img src="${esc(item.src)}" alt="" loading="lazy">
    </button>
  `).join('');
  const thumbs = Array.from(overlay.querySelectorAll('.travel-reel-thumb'));

  function render() {
    const item = list[index] || {};
    countEl.textContent = `${index + 1} / ${list.length}`;
    imgEl.style.display = '';
    brokenEl.hidden = true;
    imgEl.src = item.src || '';
    const caption = [item.caption, item.sub].filter(Boolean).join(' · ');
    captionEl.textContent = caption;
    captionEl.style.display = caption ? '' : 'none';
    thumbs.forEach((thumb, i) => thumb.classList.toggle('is-active', i === index));
    const activeThumb = thumbs[index];
    if (activeThumb) activeThumb.scrollIntoView({ block: 'nearest', inline: 'center' });
    prevBtn.style.visibility = list.length > 1 ? '' : 'hidden';
    nextBtn.style.visibility = list.length > 1 ? '' : 'hidden';
  }

  function goTo(next) {
    index = (next + list.length) % list.length;
    render();
  }

  function close() {
    document.body.style.overflow = prevOverflow;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(ev) {
    if (ev.key === 'Escape') close();
    else if (ev.key === 'ArrowLeft') goTo(index - 1);
    else if (ev.key === 'ArrowRight') goTo(index + 1);
  }

  overlay.querySelector('.travel-reel-backdrop').addEventListener('click', close);
  overlay.querySelector('.travel-reel-close').addEventListener('click', close);
  prevBtn.addEventListener('click', () => goTo(index - 1));
  nextBtn.addEventListener('click', () => goTo(index + 1));
  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    const oldText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      await saveImageSrc(imgEl.currentSrc || imgEl.src, { filename: `travel-photo-${Date.now()}.png` });
      saveBtn.textContent = '已保存';
    } catch (err) {
      console.warn('[travel-reel-viewer] save failed', err);
      saveBtn.textContent = '保存失败';
    } finally {
      setTimeout(() => { saveBtn.textContent = oldText; saveBtn.disabled = false; }, 1200);
    }
  });
  thumbs.forEach((thumb) => {
    thumb.addEventListener('click', () => goTo(Number(thumb.getAttribute('data-idx')) || 0));
  });

  let touchStartX = 0;
  const stage = overlay.querySelector('.travel-reel-stage');
  stage.addEventListener('touchstart', (e) => {
    touchStartX = e.touches?.[0]?.clientX || 0;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    const endX = e.changedTouches?.[0]?.clientX || 0;
    const delta = endX - touchStartX;
    if (Math.abs(delta) > 44) goTo(index + (delta < 0 ? 1 : -1));
  }, { passive: true });

  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey);
  render();
  return { close, goTo };
}
