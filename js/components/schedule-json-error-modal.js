import { icon } from './svg-icons.js';
import { showToast } from './toast.js';
import {
  openGenerationErrorDetail,
  saveGenerationErrorPayload,
  generationErrorFromCatch,
} from '../core/generation-error-guide.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function copyText(text = '') {
  const value = String(text || '');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) {}
  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

function salvageHint(partialParsed = null) {
  const daily = partialParsed?.dailyLifePlan?.blocks?.length || 0;
  const weekly = Array.isArray(partialParsed?.dailyLifePlans)
    ? partialParsed.dailyLifePlans.reduce((n, p) => n + (p?.blocks?.length || 0), 0)
    : 0;
  const note = String(partialParsed?._salvageNote || '').trim();
  if (note) return note;
  if (daily) return `检测到约 ${daily} 个时段可尝试填入`;
  if (weekly) return `检测到约 ${weekly} 个时段（跨多天）可尝试填入`;
  return '';
}

/**
 * 日程生成 JSON 解析失败时展示模型原文，并可选尝试救回填入。
 */
export function openScheduleJsonErrorModal({
  rawText = '',
  partialParsed = null,
  mode = 'daily',
  title = '日程生成 · 返回未能解析',
  onTryApply,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const raw = String(rawText || '').trim();
  if (!raw) return;
  const hint = salvageHint(partialParsed);
  const canApply = typeof onTryApply === 'function' && (!!hint || raw.length > 40);
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-schedule-json-overlay>
      <div class="modal-sheet scrapbook-card ai-fill-sheet schedule-json-sheet" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h3>${esc(title)}</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-schedule-json-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body ai-fill-body">
          <p class="ai-fill-subtitle">已收到模型返回约 ${raw.length} 字。若被 max_tokens 截断、连接中途断开或夹带说明，解析会失败；下方是收到的原文，可复制或尝试救回填入。</p>
          ${hint ? `<p class="schedule-json-hint">${esc(hint)}</p>` : ''}
          <textarea class="form-input schedule-json-raw" rows="14">${esc(raw)}</textarea>
        </div>
        <footer class="ai-fill-footer schedule-json-footer">
          <button type="button" class="btn btn-outline" data-schedule-json-copy>复制原文</button>
          <button type="button" class="btn btn-outline" data-schedule-json-detail>排查详情</button>
          ${canApply ? '<button type="button" class="btn btn-primary" data-schedule-json-apply>尝试填入可用部分</button>' : ''}
        </footer>
      </div>
    </div>
  `;
  const sheet = host.querySelector('.schedule-json-sheet');
  const textarea = host.querySelector('.schedule-json-raw');
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-schedule-json-overlay]')?.addEventListener('click', close);
  sheet?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-schedule-json-close]')?.addEventListener('click', close);
  host.querySelector('[data-schedule-json-copy]')?.addEventListener('click', async () => {
    const text = String(textarea?.value || raw).trim();
    showToast(await copyText(text) ? '已复制返回原文' : '复制失败');
  });
  host.querySelector('[data-schedule-json-detail]')?.addEventListener('click', () => {
    const text = String(textarea?.value || raw).trim();
    saveGenerationErrorPayload(generationErrorFromCatch(
      { message: title, rawText: text, reason: 'json-parse-failed' },
      { scope: '他的手机 · 日程', title: '日程 JSON 解析失败' },
    ));
    close();
    openGenerationErrorDetail();
  });
  host.querySelector('[data-schedule-json-apply]')?.addEventListener('click', async () => {
    const btn = host.querySelector('[data-schedule-json-apply]');
    const text = String(textarea?.value || raw).trim();
    if (!text) {
      showToast('原文为空');
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = '解析中…';
    }
    try {
      await onTryApply?.(text, { mode, partialParsed });
      close();
    } catch (e) {
      showToast(String(e?.message || e || '填入失败'), 6000);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '尝试填入可用部分';
      }
    }
  });
}
