import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { fileToOptimizedChatImageDataUrl } from '../core/chat/chat-image-utils.js';
import { loadLastGenerationError } from '../core/generation-error-guide.js';
import { askSupportAssistant } from '../core/support/support-client.js';
import { buildLocalSupportAnswer } from '../core/support/support-knowledge.js';
import { getSupportAction, runSupportAction } from '../core/support/support-actions.js';
import { loadSupportIncident } from '../core/support/support-context.js';
import {
  buildGenerationFailureSupportAnswer,
  buildRecentOperationSupportAnswer,
  buildScenarioSupportAnswer,
} from '../core/support/scenario-diagnostics.js';
import {
  getFeedbackServiceUrl,
  listFeedbackReceipts,
  replyToFeedback,
  retryFeedbackQueue,
  submitFeedback,
} from '../core/support/feedback-client.js';

function feedbackSubmitMessage(result = {}) {
  if (!result.queued) return `工单已提交：${result.id}`;
  return result.queuedReason === 'service'
    ? '反馈服务暂时不可用，工单已保存，稍后自动重试'
    : '当前连接失败，工单已保存，稍后自动重试';
}

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderActions(actionIds = []) {
  const actions = actionIds.map((id) => ({ id, action: getSupportAction(id) })).filter((item) => item.action);
  if (!actions.length) return '';
  return `<div class="support-answer-actions">${actions.map(({ id, action }) => `
    <button type="button" class="btn btn-outline btn-sm" data-support-action="${esc(id)}">${esc(action.label)}</button>
  `).join('')}</div>`;
}

function renderAnswer(answer = {}) {
  const feedbackAdvice = {
    recommended: ['建议提交反馈', '这更像程序或运行环境异常，我已整理可提交的信息。'],
    not_needed: ['通常无需提交', '先按上方说明处理；结果不一致时仍可提交。'],
    if_unresolved: ['仍未解决再提交', '按步骤排查后仍失败，我会带上当前环境整理反馈。'],
  }[answer.feedbackRecommendation || 'if_unresolved'];
  return `
    <article class="support-answer-card">
      <div class="support-answer-source">${answer.source === 'ai'
    ? '芥末棉花糖分析'
    : (answer.source === 'tutorial' ? '教程答疑' : (answer.source === 'diagnostic' ? '当前场景自查' : '本地判断'))}</div>
      <h3>${esc(answer.title || '答疑建议')}</h3>
      <p>${esc(answer.answer || '')}</p>
      ${answer.steps?.length ? `<ol>${answer.steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}
      ${answer.followUp ? `<p class="support-follow-up">${esc(answer.followUp)}</p>` : ''}
      ${answer.aiUnavailable ? `<small>${esc(answer.aiUnavailable)}，当前仍可使用本地排查。</small>` : ''}
      ${renderActions(answer.actions)}
      <div class="support-feedback-advice${answer.feedbackRecommendation === 'recommended' ? ' is-recommended' : ''}">
        <strong>${esc(feedbackAdvice[0])}</strong>
        <span>${esc(feedbackAdvice[1])}</span>
      </div>
      ${answer.feedbackRecommendation !== 'not_needed'
    ? '<button type="button" class="btn btn-primary support-oneclick-feedback">仍未解决？一键提交工单</button>'
    : ''}
    </article>
  `;
}

function buildFeedbackDraft(question = '', answer = {}, diagnostic = null) {
  const description = String(
    answer?.feedbackSummary
      || question
      || diagnostic?.message
      || '',
  ).trim().slice(0, 1200);
  const route = String(diagnostic?.routeLabel || '').trim();
  const operation = String(diagnostic?.operation || '').trim();
  const readableOperation = /[\u3400-\u9fff]/.test(operation) ? operation : '';
  const fallbackReproduction = route
    ? `在“${route}”${readableOperation ? `执行“${readableOperation}”时` : '使用相关功能时'}出现上述问题。`
    : '';
  return {
    description,
    reproduction: String(answer?.feedbackReproduction || fallbackReproduction).trim().slice(0, 1200),
  };
}

function statusLabel(status = '') {
  return {
    new: '待处理',
    needs_info: '需要补充',
    investigating: '排查中',
    known: '已知问题',
    duplicate: '重复反馈',
    deferred: '暂缓',
    resolved: '已解决',
  }[status] || status || '待处理';
}

export default async function render(container, params = {}) {
  const recentError = loadLastGenerationError();
  const diagnostic = params.fromError
    ? (recentError?.diagnostic || null)
    : loadSupportIncident(params.incidentId || '');
  const hasErrorContext = !!(params.fromError && recentError);
  const scenarioAnswer = params.fromError
    ? buildGenerationFailureSupportAnswer(recentError)
    : (buildScenarioSupportAnswer(diagnostic) || buildRecentOperationSupportAnswer(diagnostic));
  const initialQuestion = params.fromError && recentError
    ? `${recentError.title}：${recentError.message}`
    : (scenarioAnswer
      ? diagnostic?.message || '请检查当前场景'
      : (/^notification-/.test(String(diagnostic?.code || '')) ? diagnostic?.message || '请检查通知权限' : ''));
  let answer = scenarioAnswer || (initialQuestion ? buildLocalSupportAnswer(initialQuestion, diagnostic) : null);
  let questionText = initialQuestion;
  let receipts = await listFeedbackReceipts().catch(() => []);
  let supportImage = null;
  let feedbackDescription = params.feedback === '1'
    ? buildFeedbackDraft(questionText, answer, diagnostic).description
    : '';

  const draw = () => {
    container.className = 'page support-page';
    container.innerHTML = `
      <header class="navbar support-navbar">
        <button type="button" class="navbar-btn support-back" aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">芥末棉花糖</h1>
        <button type="button" class="navbar-btn support-config" aria-label="配置芥末棉花糖 API">${icon('settings')}</button>
      </header>
      <main class="support-scroll">
        <section class="support-intro">
          <span>芥末棉花糖 · 问题定位</span>
          <h2>${hasErrorContext ? esc(recentError?.title || '已带入最近报错') : '现在遇到了什么？'}</h2>
          ${hasErrorContext
            ? `<p>${esc(recentError?.message || '')}</p>`
            : (diagnostic?.routeLabel
              ? `<p>当前来源：${esc(diagnostic.routeLabel)}${diagnostic?.evidence ? ' · 已带入脱敏运行状态' : ''}</p>`
              : '')}
        </section>

        <section class="support-ask">
          <label for="support-question">描述问题</label>
          <textarea id="support-question" rows="3" placeholder="例如：为什么提示 401？Key 应该填在哪里？">${esc(questionText)}</textarea>
          <div class="support-vision-input">
            <div class="support-vision-actions">
              <label class="support-vision-pick">
                <input type="file" accept="image/png,image/jpeg,image/webp" data-support-image />
                <span>${supportImage ? '更换截图' : '添加截图问 AI'}</span>
              </label>
              ${supportImage ? '<button type="button" class="support-vision-remove">移除</button>' : ''}
            </div>
            ${supportImage ? `
              <div class="support-vision-preview">
                <img src="${esc(supportImage.dataUrl)}" alt="待分析截图预览" />
                <span>已选择截图</span>
              </div>
            ` : ''}
            <small>仅在点击“分析问题”后发送给芥末棉花糖 API；请先遮挡 Key、聊天隐私等敏感内容。不会自动随工单上传。</small>
          </div>
          <div class="support-quick-questions" aria-label="常见问题">
            <button type="button" data-support-question="新消息发出去为什么不显示？">消息不见了</button>
            <button type="button" data-support-question="发消息后角色为什么没回复？">角色没回复</button>
            <button type="button" data-support-question="角色为什么不主动发消息？">不主动发消息</button>
            <button type="button" data-support-question="未输出正确格式和掉格式是什么意思？">掉格式</button>
            <button type="button" data-support-question="新用户建议先打开哪些配置？真人感模式是什么？">推荐配置</button>
          </div>
          <div class="support-ask-actions">
            <button type="button" class="btn btn-primary support-ask-button">分析问题</button>
          </div>
        </section>

        <section class="support-feedback-entry">
          <div class="support-feedback-copy">
            <span>需要人工处理？</span>
            <strong>直接提交问题工单</strong>
            <small>写一句现象即可；会自动附带当前页面、版本与脱敏错误信息。</small>
          </div>
          <label class="support-feedback-quick-field">
            <span>简单描述</span>
            <textarea rows="2" maxlength="1200" data-feedback-quick-description placeholder="例如：点发送后一直没有回复">${esc(feedbackDescription)}</textarea>
          </label>
          <button type="button" class="btn btn-primary support-feedback-submit">一键提交工单</button>
        </section>

        <section class="support-answer-host" aria-live="polite">
          ${answer ? renderAnswer(answer) : '<div class="support-empty">我会先查教程与本地规则；配置独立 API 后可继续追问。</div>'}
        </section>

        <section class="support-receipts">
          <div class="support-section-head">
            <h2>我的反馈</h2>
            <button type="button" class="support-text-button support-refresh">刷新</button>
          </div>
          ${receipts.length ? receipts.map((item) => `
            <article class="support-receipt">
              <strong>${esc(item.id)}</strong>
              <span>${esc(statusLabel(item.status))}</span>
              ${item.operatorMessage ? `<p>${esc(item.operatorMessage)}</p>` : ''}
              ${item.status === 'needs_info' ? `
                <textarea rows="2" data-feedback-reply="${esc(item.id)}" placeholder="补充维护者需要的信息"></textarea>
                <button type="button" class="btn btn-outline btn-sm" data-feedback-reply-send="${esc(item.id)}">发送补充</button>
              ` : ''}
            </article>
          `).join('') : '<div class="support-empty">还没有提交过反馈</div>'}
        </section>
      </main>
    `;
    container.querySelector('.support-back')?.addEventListener('click', () => back());
    container.querySelector('.support-config')?.addEventListener('click', () => navigate('settings/api', { tab: 'support' }));
    container.querySelectorAll('[data-support-action]').forEach((button) => {
      button.addEventListener('click', () => runSupportAction(button.dataset.supportAction));
    });
    container.querySelectorAll('[data-support-question]').forEach((button) => {
      button.addEventListener('click', () => {
        const textarea = container.querySelector('#support-question');
        if (textarea) textarea.value = button.dataset.supportQuestion || '';
        container.querySelector('.support-ask-button')?.click();
      });
    });
    container.querySelector('[data-support-image]')?.addEventListener('change', async (event) => {
      const input = event.currentTarget;
      const file = input.files?.[0] || null;
      input.value = '';
      if (!file) return;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(file.type || '').toLowerCase())) {
        showToast('截图仅支持 PNG、JPEG 或 WebP');
        return;
      }
      if (Number(file.size || 0) > 4 * 1024 * 1024) {
        showToast('截图不能超过 4MB');
        return;
      }
      try {
        const optimized = await fileToOptimizedChatImageDataUrl(file);
        const dataUrl = String(optimized?.dataUrl || '').trim();
        if (!dataUrl) throw new Error('截图读取失败');
        const blob = await fetch(dataUrl).then((response) => response.blob());
        supportImage = { dataUrl, blob, name: String(file.name || '截图') };
        draw();
      } catch (error) {
        showToast(error?.message || '截图读取失败');
      }
    });
    container.querySelector('.support-vision-remove')?.addEventListener('click', () => {
      supportImage = null;
      draw();
    });
    container.querySelector('.support-ask-button')?.addEventListener('click', async (event) => {
      const question = container.querySelector('#support-question')?.value?.trim()
        || (supportImage ? '请分析这张截图里显示的问题，并告诉我如何处理。' : '');
      if (!question) return showToast('请先描述问题');
      questionText = question;
      const textarea = container.querySelector('#support-question');
      if (textarea && !textarea.value.trim()) textarea.value = question;
      const button = event.currentTarget;
      try {
        button.disabled = true;
        button.textContent = supportImage ? '正在读取截图…' : '分析中…';
        answer = buildLocalSupportAnswer(question, diagnostic);
        container.querySelector('.support-answer-host').innerHTML = renderAnswer(answer);
        answer = await askSupportAssistant(question, {
          diagnostic,
          imageDataUrl: supportImage?.dataUrl || '',
        });
        draw();
      } catch (error) {
        showToast(`AI 分析失败：${String(error?.message || error).slice(0, 160)}`, 5000);
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = '分析问题';
        }
      }
    });
    container.querySelector('[data-feedback-quick-description]')?.addEventListener('input', (event) => {
      feedbackDescription = event.currentTarget.value;
    });
    container.querySelector('.support-feedback-submit')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const typedDescription = container.querySelector('[data-feedback-quick-description]')?.value?.trim() || '';
      const draft = buildFeedbackDraft(typedDescription || questionText, answer, diagnostic);
      if (!draft.description) {
        showToast('请简单描述遇到的问题');
        container.querySelector('[data-feedback-quick-description]')?.focus();
        return;
      }
      try {
        button.disabled = true;
        button.textContent = '提交中…';
        const result = await submitFeedback({ ...draft, diagnostic });
        showToast(feedbackSubmitMessage(result));
        feedbackDescription = '';
        receipts = await listFeedbackReceipts().catch(() => receipts);
        draw();
      } catch (error) {
        showToast(error?.message || '工单提交失败', 5000);
        button.disabled = false;
        button.textContent = '一键提交工单';
      }
    });
    container.querySelector('.support-oneclick-feedback')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const draft = buildFeedbackDraft(questionText, answer, diagnostic);
      try {
        button.disabled = true;
        button.textContent = '提交中…';
        const result = await submitFeedback({ ...draft, diagnostic });
        showToast(feedbackSubmitMessage(result));
        receipts = await listFeedbackReceipts().catch(() => receipts);
        draw();
      } catch (error) {
        showToast(error?.message || '工单提交失败', 5000);
        button.disabled = false;
        button.textContent = '仍未解决？一键提交工单';
      }
    });
    container.querySelector('.support-refresh')?.addEventListener('click', async () => {
      if (!getFeedbackServiceUrl()) {
        showToast('反馈后台尚未配置');
        return;
      }
      await retryFeedbackQueue().catch(() => null);
      receipts = await listFeedbackReceipts({ refresh: true }).catch(() => receipts);
      draw();
    });
    container.querySelectorAll('[data-feedback-reply-send]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.getAttribute('data-feedback-reply-send');
        const receipt = receipts.find((item) => item.id === id);
        const message = container.querySelector(`[data-feedback-reply="${id}"]`)?.value || '';
        if (!receipt) return;
        try {
          await replyToFeedback(id, receipt.receiptToken, message);
          showToast('补充已发送');
          receipts = await listFeedbackReceipts({ refresh: true });
          draw();
        } catch (error) {
          showToast(error?.message || '补充发送失败');
        }
      });
    });
  };
  draw();
  if (params.feedback === '1') {
    requestAnimationFrame(() => container.querySelector('[data-feedback-quick-description]')?.focus());
  }
}
