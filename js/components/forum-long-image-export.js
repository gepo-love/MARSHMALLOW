import { icon } from './svg-icons.js';
import { showToast } from './toast.js';
import { downloadBlob, describeDownloadResult } from '../core/native-download.js';

const WIDTH = 1080;
const PAD = 76;
const CONTENT_WIDTH = WIDTH - PAD * 2;
const MAX_HEIGHT = 14000;

function cleanFilePart(value = '') {
  return String(value || '论坛帖子')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || '论坛帖子';
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function wrapLines(ctx, value, maxWidth) {
  const source = String(value || '').replace(/\r\n?/g, '\n');
  const result = [];
  source.split('\n').forEach((paragraph) => {
    if (!paragraph) {
      result.push('');
      return;
    }
    let line = '';
    for (const char of [...paragraph]) {
      const next = `${line}${char}`;
      if (line && ctx.measureText(next).width > maxWidth) {
        result.push(line);
        line = char;
      } else {
        line = next;
      }
    }
    if (line) result.push(line);
  });
  return result;
}

function textHeight(ctx, value, maxWidth, lineHeight) {
  return Math.max(1, wrapLines(ctx, value, maxWidth).length) * lineHeight;
}

function drawText(ctx, value, x, y, maxWidth, lineHeight) {
  const lines = wrapLines(ctx, value, maxWidth);
  lines.forEach((line, index) => {
    if (line) ctx.fillText(line, x, y + index * lineHeight);
  });
  return y + Math.max(1, lines.length) * lineHeight;
}

function loadImage(src = '') {
  let url = String(src || '').trim();
  if (!url) return Promise.resolve(null);
  if (url.startsWith('//')) url = `https:${url}`;
  return new Promise((resolve) => {
    const image = new Image();
    if (/^https?:\/\//i.test(url)) image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function drawImageContain(ctx, image, x, y, width, height) {
  if (!image) return;
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (!iw || !ih) return;
  const scale = Math.min(width / iw, height / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(image, x + (width - dw) / 2, y + (height - dh) / 2, dw, dh);
}

function flattenReplies(replies = []) {
  const rows = [];
  replies.forEach((reply, index) => {
    const floor = index + 1;
    rows.push({ ...reply, floor, child: false });
    (reply.childReplies || []).forEach((child) => rows.push({ ...child, floor, child: true }));
  });
  return rows;
}

function measureExport(data, loadedImages) {
  const ctx = document.createElement('canvas').getContext('2d');
  let height = 80;
  ctx.font = '700 50px "PingFang SC", "Microsoft YaHei", sans-serif';
  height += textHeight(ctx, data.title, CONTENT_WIDTH, 68) + 22;
  height += 40;
  ctx.font = '34px "PingFang SC", "Microsoft YaHei", sans-serif';
  height += textHeight(ctx, data.content, CONTENT_WIDTH, 54) + 28;
  for (const image of loadedImages) {
    if (!image) continue;
    const ratio = (image.naturalHeight || image.height) / (image.naturalWidth || image.width || 1);
    height += Math.min(560, Math.max(220, CONTENT_WIDTH * ratio)) + 20;
  }
  height += 58;
  const rows = flattenReplies(data.replies);
  rows.forEach((row) => {
    const inset = row.child ? 44 : 0;
    height += row.child ? 34 : 44;
    ctx.font = '32px "PingFang SC", "Microsoft YaHei", sans-serif';
    height += textHeight(ctx, row.content, CONTENT_WIDTH - inset, 49) + 30;
  });
  return Math.max(900, height + 92);
}

async function renderForumCanvas(data = {}) {
  const loadedImages = await Promise.all((data.images || []).slice(0, 9).map(loadImage));
  const canvas = document.createElement('canvas');
  const logicalHeight = measureExport(data, loadedImages);
  // 保留完整内容；极长帖子等比缩放到 iOS Safari 的安全画布高度，避免尾部被截断或整图空白。
  const scale = Math.min(1, MAX_HEIGHT / logicalHeight);
  canvas.width = Math.max(1, Math.round(WIDTH * scale));
  canvas.height = Math.max(1, Math.round(logicalHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#f4f6f7';
  ctx.fillRect(0, 0, WIDTH, logicalHeight);

  let y = 80;
  ctx.fillStyle = '#15191c';
  ctx.font = '700 50px "PingFang SC", "Microsoft YaHei", sans-serif';
  y = drawText(ctx, data.title || '无标题', PAD, y, CONTENT_WIDTH, 68) + 18;
  ctx.fillStyle = '#75818a';
  ctx.font = '26px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText([data.author, data.time].filter(Boolean).join('  ·  '), PAD, y);
  y += 48;
  ctx.fillStyle = '#262d32';
  ctx.font = '34px "PingFang SC", "Microsoft YaHei", sans-serif';
  y = drawText(ctx, data.content, PAD, y, CONTENT_WIDTH, 54) + 24;

  loadedImages.forEach((image) => {
    if (!image) return;
    const ratio = (image.naturalHeight || image.height) / (image.naturalWidth || image.width || 1);
    const boxHeight = Math.min(560, Math.max(220, CONTENT_WIDTH * ratio));
    ctx.save();
    roundRect(ctx, PAD, y, CONTENT_WIDTH, boxHeight, 22);
    ctx.clip();
    ctx.fillStyle = '#e9edef';
    ctx.fillRect(PAD, y, CONTENT_WIDTH, boxHeight);
    drawImageContain(ctx, image, PAD, y, CONTENT_WIDTH, boxHeight);
    ctx.restore();
    y += boxHeight + 20;
  });

  ctx.strokeStyle = '#d9dfe2';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, y + 8);
  ctx.lineTo(WIDTH - PAD, y + 8);
  ctx.stroke();
  y += 48;
  ctx.fillStyle = '#53616a';
  ctx.font = '600 27px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(`楼层回复 · ${(data.replies || []).length}`, PAD, y);
  y += 42;

  for (const row of flattenReplies(data.replies)) {
    const inset = row.child ? 44 : 0;
    if (row.child) {
      ctx.strokeStyle = '#cbd5da';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(PAD + 12, y - 22);
      ctx.lineTo(PAD + 12, y + 48);
      ctx.stroke();
    }
    ctx.fillStyle = '#75818a';
    ctx.font = '25px "PingFang SC", "Microsoft YaHei", sans-serif';
    const label = row.child
      ? `${row.author || '匿名'}  回复 @${row.replyToAuthor || '匿名'}`
      : `#${row.floor}  ${row.author || '匿名'}${row.time ? `  ·  ${row.time}` : ''}`;
    ctx.fillText(label, PAD + inset, y);
    y += 38;
    ctx.fillStyle = '#242b30';
    ctx.font = '32px "PingFang SC", "Microsoft YaHei", sans-serif';
    y = drawText(ctx, row.content, PAD + inset, y, CONTENT_WIDTH - inset, 49) + 26;
  }

  ctx.fillStyle = '#8a959c';
  ctx.font = '24px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('棉花糖机 · 论坛', PAD, logicalHeight - 50);
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片生成失败')), 'image/png');
  });
}

export async function openForumLongImageExport(data = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center" data-forum-export-overlay>
      <div class="modal-sheet forum-export-sheet" role="dialog" aria-modal="true" aria-labelledby="forum-export-title">
        <div class="modal-header">
          <button type="button" class="navbar-btn modal-close-btn" data-forum-export-close aria-label="关闭">${icon('back')}</button>
          <h3 id="forum-export-title">导出长图</h3>
        </div>
        <div class="forum-export-preview" data-forum-export-preview><div class="forum-export-loading">正在排版…</div></div>
        <div class="forum-export-actions"><button type="button" class="btn btn-primary" data-forum-export-save disabled>保存图片</button></div>
      </div>
    </div>`;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-forum-export-overlay]')?.addEventListener('click', close);
  host.querySelector('.forum-export-sheet')?.addEventListener('click', (event) => event.stopPropagation());
  host.querySelector('[data-forum-export-close]')?.addEventListener('click', close);
  try {
    const canvas = await renderForumCanvas(data);
    const preview = host.querySelector('[data-forum-export-preview]');
    if (!preview) return;
    preview.innerHTML = '';
    preview.appendChild(canvas);
    const save = host.querySelector('[data-forum-export-save]');
    save.disabled = false;
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const blob = await canvasToBlob(canvas);
        const result = await downloadBlob(blob, `${cleanFilePart(data.title)}-论坛长图.png`, {
          mimeType: 'image/png',
          directory: 'pictures',
          preferShare: true,
        });
        showToast(describeDownloadResult(result));
      } catch (error) {
        showToast(`保存失败：${error?.message || error}`);
      } finally {
        save.disabled = false;
      }
    });
  } catch (error) {
    const preview = host.querySelector('[data-forum-export-preview]');
    if (preview) preview.innerHTML = `<div class="forum-export-loading">生成失败，请稍后重试</div>`;
  }
}
