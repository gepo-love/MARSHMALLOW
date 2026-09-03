import { icon } from './svg-icons.js';
import { showToast } from './toast.js';
import { downloadBlob } from '../core/native-download.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cleanFilePart(value = '') {
  return String(value || 'share-card')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'share-card';
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapTextLines(ctx, text, maxWidth, maxLines = Infinity) {
  const lines = [];
  const source = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!source) return { lines, truncated: false };

  let truncated = false;
  const pushLine = (line) => {
    if (lines.length >= maxLines) {
      truncated = true;
      return false;
    }
    lines.push(line);
    return true;
  };

  const blocks = source.split('\n');
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex].replace(/[ \t]+/g, ' ').trim();
    if (!block) {
      if (!pushLine('')) break;
      continue;
    }

    let line = '';
    const chars = [...block];
    for (const ch of chars) {
      const test = `${line}${ch}`;
      if (ctx.measureText(test).width > maxWidth && line) {
        if (!pushLine(line)) break;
        line = ch;
      } else {
        line = test;
      }
    }
    if (truncated) break;
    if (line && !pushLine(line)) break;
  }
  return { lines, truncated };
}

function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines = Infinity) {
  const { lines, truncated } = wrapTextLines(ctx, text, maxWidth, maxLines);
  let lastTextIndex = -1;
  lines.forEach((row, idx) => {
    if (row) lastTextIndex = idx;
  });
  lines.forEach((row, idx) => {
    if (!row) return;
    const suffix = Number.isFinite(maxLines) && idx === lastTextIndex && truncated ? '...' : '';
    ctx.fillText(`${row}${suffix}`, x, y + idx * lineHeight);
  });
  return y + lines.length * lineHeight;
}

function drawNotebookLines(ctx, x, y, w, h, lineHeight) {
  const top = Math.max(0, y);
  const bottom = Math.max(top, y + h);
  ctx.save();
  ctx.strokeStyle = 'rgba(225, 199, 177, 0.62)';
  ctx.lineWidth = 2;
  for (let yy = top; yy <= bottom; yy += lineHeight) {
    ctx.beginPath();
    ctx.moveTo(x, yy);
    ctx.lineTo(x + w, yy);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(245, 188, 178, 0.55)';
  ctx.beginPath();
  ctx.moveTo(x + 34, top - 12);
  ctx.lineTo(x + 34, bottom + 8);
  ctx.stroke();
  ctx.restore();
}

function loadImage(src = '') {
  let url = String(src || '').trim();
  if (!url) return Promise.resolve(null);
  if (url.startsWith('//')) url = `https:${url}`;
  else if (/^http:\/\//i.test(url)) url = `https://${url.slice(7)}`;
  return new Promise((resolve) => {
    const img = new Image();
    if (/^https?:\/\//i.test(url)) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function drawImageCover(ctx, img, x, y, w, h, radius) {
  if (!img) return false;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return false;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (iw - sw) / 2;
  const sy = (ih - sh) / 2;
  ctx.save();
  roundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
  return true;
}

const SHARE_CARD_WIDTH = 1080;
const SHARE_CARD_DPR = 2;
const SHARE_CARD_LINE_H = 58;
// iOS Safari 对 canvas 总面积有上限（约 1600 万像素），超长单图会渲染空白。
// 据此把每页正文行数限制在安全高度内，超出则自动分页。
const SHARE_CARD_MAX_CSS_HEIGHT = Math.floor(16000000 / (SHARE_CARD_WIDTH * SHARE_CARD_DPR * SHARE_CARD_DPR));
// 首页带插图占位较高，续页纯文字可容纳更多行。
const SHARE_CARD_LINES_PAGE_1 = 42;
const SHARE_CARD_LINES_PAGE_N = 50;

// 按容量把整段已折行的正文切成多页（保留段落空行，续页去掉开头空行）。
function splitIntoPages(allLines) {
  if (allLines.length <= SHARE_CARD_LINES_PAGE_1) return [allLines];
  const pages = [allLines.slice(0, SHARE_CARD_LINES_PAGE_1)];
  let cursor = SHARE_CARD_LINES_PAGE_1;
  while (cursor < allLines.length) {
    let slice = allLines.slice(cursor, cursor + SHARE_CARD_LINES_PAGE_N);
    let consumed = slice.length;
    // 续页去掉开头空行（视觉上不留白）
    while (slice.length && !slice[0]) slice = slice.slice(1);
    pages.push(slice);
    cursor += consumed;
  }
  return pages;
}

async function drawShareCardPage(canvas, data = {}, pageInfo = {}) {
  const { lines = [], pageIndex = 0, pageCount = 1 } = pageInfo;
  const withImage = pageIndex === 0;
  const dpr = SHARE_CARD_DPR;
  const width = SHARE_CARD_WIDTH;
  const lineH = SHARE_CARD_LINE_H;

  const measure = document.createElement('canvas').getContext('2d');
  const titleText = data.title || '小卡片';
  measure.font = '700 56px "Microsoft YaHei", sans-serif';
  const titleLines = Math.max(1, wrapTextLines(measure, titleText, width - 236, 2).lines.length);

  const subtitleText = pageCount > 1
    ? [data.subtitle, `第 ${pageIndex + 1}/${pageCount} 页`].filter(Boolean).join(' · ')
    : String(data.subtitle || '');
  measure.font = '30px "Microsoft YaHei", sans-serif';
  const subtitleLines = subtitleText ? wrapTextLines(measure, subtitleText, width - 240, 2).lines.length : 0;

  const titleBaseline = withImage ? 650 : 200;
  const bodyStartY = titleBaseline + titleLines * 68 + 20 + subtitleLines * 42 + 34;
  const footerSpace = 210;
  const minHeight = withImage ? 1440 : 900;
  const height = Math.max(
    minHeight,
    Math.min(SHARE_CARD_MAX_CSS_HEIGHT, bodyStartY + lines.length * lineH + footerSpace),
  );

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = '270px';
  canvas.style.height = `${Math.round(270 * height / width)}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = '#f8efe2';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
  for (let y = 44; y < height; y += 44) ctx.fillRect(0, y, width, 2);
  for (let x = 44; x < width; x += 44) ctx.fillRect(x, 0, 2, height);

  ctx.save();
  ctx.translate(0, 0);
  roundRect(ctx, 72, 70, width - 144, height - 140, 42);
  ctx.fillStyle = '#fffdf8';
  ctx.fill();
  ctx.strokeStyle = '#ead9c8';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();

  if (withImage) {
    const image = await loadImage(data.image);
    if (image) {
      drawImageCover(ctx, image, 112, 118, width - 224, 430, 28);
    } else {
      const grad = ctx.createLinearGradient(112, 118, width - 112, 548);
      grad.addColorStop(0, '#d9e8ee');
      grad.addColorStop(1, '#ffd8c8');
      roundRect(ctx, 112, 118, width - 224, 430, 28);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.74)';
      roundRect(ctx, 410, 282, 260, 84, 42);
      ctx.fill();
      ctx.fillStyle = '#7f8f96';
      ctx.font = '34px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(data.imageHint || '一小段回忆', width / 2, 335);
      ctx.textAlign = 'left';
    }
    ctx.save();
    ctx.translate(782, 546);
    ctx.rotate(-0.04);
    ctx.fillStyle = '#f6d98f';
    roundRect(ctx, 0, 0, 170, 34, 6);
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = '#f1b98f';
  roundRect(ctx, 128, 94, 170, 34, 6);
  ctx.fill();

  ctx.fillStyle = '#5d4636';
  ctx.font = '700 56px "Microsoft YaHei", sans-serif';
  let y = drawWrappedText(ctx, titleText, 118, titleBaseline, width - 236, 68, 2) + 20;
  if (subtitleText) {
    ctx.fillStyle = '#9a7b64';
    ctx.font = '30px "Microsoft YaHei", sans-serif';
    y = drawWrappedText(ctx, subtitleText, 120, y, width - 240, 42, 2) + 34;
  } else {
    y += 34;
  }

  ctx.fillStyle = '#684f3f';
  ctx.font = '36px "Microsoft YaHei", sans-serif';
  drawNotebookLines(ctx, 118, y + 10, width - 236, height - y - 242, lineH);
  drawWrappedText(ctx, lines.join('\n'), 120, y, width - 240, lineH);

  ctx.fillStyle = '#b99479';
  ctx.font = '28px "Microsoft YaHei", sans-serif';
  drawWrappedText(ctx, data.footer || '棉花糖机', 120, height - 170, width - 240, 40, 2);

  ctx.fillStyle = '#f5c7b5';
  ctx.beginPath();
  ctx.arc(width - 154, height - 148, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e8c5d2';
  ctx.beginPath();
  ctx.arc(width - 112, height - 184, 14, 0, Math.PI * 2);
  ctx.fill();
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('图片生成失败'));
    }, 'image/png');
  });
}

async function downloadCanvas(canvas, filename) {
  const blob = await canvasToBlob(canvas);
  return downloadBlob(blob, filename, { mimeType: 'image/png', directory: 'pictures' });
}

export async function openShareCardModal(data = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = '36px "Microsoft YaHei", sans-serif';
  const originalText = String(data.fullText || data.body || data.summary || '').trim();
  const allLines = wrapTextLines(measure, originalText, SHARE_CARD_WIDTH - 240).lines;
  const pages = splitIntoPages(allLines.length ? allLines : ['']);
  const pageCount = pages.length;
  const multi = pageCount > 1;

  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center" data-share-card-overlay>
      <div class="modal-sheet scrapbook-card share-card-sheet" role="dialog" aria-modal="true">
        <div class="modal-header">
          <button type="button" class="navbar-btn modal-close-btn" data-share-card-close aria-label="关闭">${icon('back')}</button>
          <h3>分享小卡片${multi ? `（${pageCount} 页）` : ''}</h3>
        </div>
        <div class="share-card-preview" data-share-card-preview></div>
        <div class="share-card-actions">
          <button type="button" class="btn btn-primary" data-share-card-download>${multi ? `保存全部（${pageCount}张）` : '保存PNG'}</button>
        </div>
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };

  const preview = host.querySelector('[data-share-card-preview]');
  const canvases = [];
  for (let i = 0; i < pageCount; i += 1) {
    const wrap = document.createElement('div');
    wrap.className = 'share-card-page';
    if (multi) {
      const label = document.createElement('div');
      label.className = 'share-card-page-label';
      label.textContent = `第 ${i + 1} / ${pageCount} 页`;
      wrap.appendChild(label);
    }
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    preview.appendChild(wrap);
    // eslint-disable-next-line no-await-in-loop
    await drawShareCardPage(canvas, data, { lines: pages[i], pageIndex: i, pageCount });
    canvases.push(canvas);
  }

  host.querySelector('[data-share-card-overlay]')?.addEventListener('click', close);
  host.querySelector('.share-card-sheet')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-share-card-close]')?.addEventListener('click', close);
  host.querySelector('[data-share-card-download]')?.addEventListener('click', async () => {
    const base = cleanFilePart(data.filenameBase || data.title);
    try {
      for (let i = 0; i < canvases.length; i += 1) {
        const name = pageCount > 1 ? `${base}-${i + 1}.png` : `${base}.png`;
        // eslint-disable-next-line no-await-in-loop
        await downloadCanvas(canvases[i], name);
        // 连续触发多次下载时给浏览器一点间隔，避免被拦截。
        if (i < canvases.length - 1) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 350));
        }
      }
      showToast(pageCount > 1 ? `已保存 ${pageCount} 张小卡片` : '小卡片已保存');
    } catch (err) {
      showToast(`保存失败：${err?.message || err}`);
    }
  });
}
