import {
  normalizeGenerationError,
  openGenerationErrorDetail,
  recordLastGenerationError,
  isModelFormatFailure,
} from '../core/generation-error-guide.js';
import { navigate } from '../core/router.js';
import { showToast } from './toast.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(ts = Date.now()) {
  return new Date(Number(ts) || Date.now()).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function dismissGenerationErrorReport() {
  document.querySelector('[data-generation-error-report]')?.remove();
}

export function showGenerationErrorReport(payload = {}) {
  if (typeof document === 'undefined') return;
  const error = normalizeGenerationError(payload);
  recordLastGenerationError(error);
  const original = String(error.originalText || error.responseText || error.rawText || '').trim();
  const originalLabel = error.originalKind === 'model' ? '模型原文' : '接口原文';
  const messageIsOriginal = !!(original && original === String(error.message || '').trim());
  const reasoning = String(
    error.reasoningText
    || error.upstreamMeta?.reasoningText
    || '',
  ).trim();
  const detailCandidate = String(error.detail || '').trim();
  const detail = detailCandidate
    && detailCandidate !== String(error.message || '').trim()
    && detailCandidate !== original
    && detailCandidate !== reasoning
    ? detailCandidate
    : '';
  const modelOutputNotice = error.side === 'model' && !error.status;
  const channelRoutingIssue = error.guideKey === 'api-html-response';
  const canRecommendStructureStrengthening = isModelFormatFailure(error)
    && error.jsonFailureKind !== 'truncated'
    && error.finishReason !== 'length';

  dismissGenerationErrorReport();
  const card = document.createElement('section');
  card.className = `generation-error-report${modelOutputNotice ? ' is-model-output-notice' : ''}`;
  card.setAttribute('data-generation-error-report', '1');
  card.setAttribute('role', 'status');
  card.innerHTML = `
    <div class="generation-error-report-head">
      <div>
        <span>${esc(error.scope)}${error.sideLabel ? ` · ${esc(error.sideLabel)}` : ''}${error.status ? ` · HTTP ${esc(error.status)}` : ''}</span>
        <strong>${esc(error.title)}</strong>
      </div>
      <button type="button" data-generation-error-close aria-label="关闭">×</button>
    </div>
    ${messageIsOriginal ? '' : `<p>${esc(error.message)}</p>`}
    ${original ? `<div class="generation-error-report-original-label">${esc(originalLabel)}</div><pre>${esc(original)}</pre>` : ''}
    ${reasoning ? (modelOutputNotice
      ? `<details class="generation-model-reasoning"><summary>查看本次思维链</summary><pre>${esc(reasoning)}</pre></details>`
      : `<div class="generation-error-report-original-label">推理原文</div><pre>${esc(reasoning)}</pre>`)
      : ''}
    ${!reasoning && error.reasoningOriginalUnavailable ? '<div class="generation-error-report-original-label">推理原文</div><pre>上游仅返回了推理 token/字符计数，没有返回可读取的推理文本；前端无法从计数还原原文。</pre>' : ''}
    ${detail ? `<pre>${esc(detail)}</pre>` : ''}
    <div class="generation-error-report-foot">
      <small>${esc(formatTime(error.at))}</small>
      <div class="generation-error-report-actions">
        ${canRecommendStructureStrengthening ? '<button type="button" data-generation-error-strengthen>开启结构强化</button>' : ''}
        ${modelOutputNotice || channelRoutingIssue ? '' : '<button type="button" data-generation-error-support>让芥末分析</button>'}
        <button type="button" data-generation-error-detail>${modelOutputNotice ? '查看模型返回' : '查看报错详情'}</button>
      </div>
    </div>
  `;
  card.querySelector('[data-generation-error-close]')?.addEventListener('click', dismissGenerationErrorReport);
  card.querySelector('[data-generation-error-detail]')?.addEventListener('click', () => {
    dismissGenerationErrorReport();
    openGenerationErrorDetail(error).catch(() => {});
  });
  card.querySelector('[data-generation-error-support]')?.addEventListener('click', () => {
    dismissGenerationErrorReport();
    navigate('support', { fromError: '1' });
  });
  card.querySelector('[data-generation-error-strengthen]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const api = await import('../core/api.js');
      const useToolApi = error.structureApiSection === 'tool';
      const current = useToolApi ? await api.getToolConfig() : await api.getConfig();
      if (current.structureStrengthening === true) {
        showToast('结构强化已开启');
      } else {
        if (useToolApi) await api.saveToolConfig({ ...current, structureStrengthening: true });
        else await api.saveConfig({ ...current, structureStrengthening: true });
        showToast(`已开启${useToolApi ? '工具模型' : '聊天模型'}结构强化，下次生成生效`);
      }
      button.remove();
    } catch (_) {
      button.disabled = false;
      showToast('开启失败，请到 API 设置中操作');
    }
  });
  document.body.appendChild(card);
}
