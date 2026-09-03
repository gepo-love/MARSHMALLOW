import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { copyTextToClipboard } from '../core/chat-helpers.js';
import {
  GENERATION_ERROR_GUIDES,
  buildGenerationErrorCopyText,
  formatStreamDiagnostics,
  loadGenerationErrorPayload,
  normalizeGenerationError,
  isModelFormatFailure,
} from '../core/generation-error-guide.js';
import { listDebugEvents } from '../core/debug-log.js';
import { loadAppearancePrefs, getActiveTheme, applySettingsWallpaperPreview } from '../core/appearance-prefs.js';
import { getConfig, getToolConfig, saveConfig, saveToolConfig } from '../core/api.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(ts = 0) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('zh-CN');
  } catch (_) {
    return '';
  }
}

function renderGuideSection(guideKey, guide, open = false) {
  return `
    <details class="gen-error-guide-item"${open ? ' open' : ''}>
      <summary><strong>${esc(guide.title)}</strong><span>${esc(guide.summary)}</span></summary>
      <div class="gen-error-guide-body">
        <p class="gen-error-guide-label">常见原因</p>
        <ul>${(guide.causes || []).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
        <p class="gen-error-guide-label">可以怎么做</p>
        <ul>${(guide.fixes || []).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
      </div>
    </details>
  `;
}

async function loadTheme() {
  const prefs = await loadAppearancePrefs();
  return getActiveTheme(prefs).theme;
}

/** Same request (correlationId) first; otherwise api_* events within ±3 min of the error. */
async function findRelatedApiEvents(error = {}) {
  const events = await listDebugEvents(100).catch(() => []);
  const apiEvents = events.filter((ev) => /^api_/.test(String(ev?.type || '')));
  const cid = String(error.correlationId || '').trim();
  if (cid) {
    const matched = apiEvents.filter((ev) => ev.correlationId === cid);
    if (matched.length) return matched.slice(0, 5);
  }
  const at = Number(error.at || 0);
  if (!at) return [];
  const windowMs = 3 * 60000;
  return apiEvents.filter((ev) => Math.abs(Number(ev.timestamp || 0) - at) <= windowMs).slice(0, 5);
}

function renderRelatedEvent(ev = {}) {
  const meta = [
    ev.errorKind ? `[${ev.errorKind}]` : '',
    ev.status ? `HTTP ${ev.status}` : '',
    ev.model || '',
    ev.stream === true ? 'stream' : ev.stream === false ? 'non-stream' : '',
  ].filter(Boolean).join(' · ');
  return `
    <details class="gen-error-guide-item">
      <summary><strong>${esc(ev.type || 'api_event')}</strong><span>${esc(formatTime(ev.timestamp))}${meta ? ` · ${esc(meta)}` : ''}</span></summary>
      <div class="gen-error-guide-body">
        <p>${esc(ev.message || '')}</p>
        ${ev.raw ? `<pre class="gen-error-raw">${esc(String(ev.raw).slice(0, 2000))}</pre>` : ''}
      </div>
    </details>
  `;
}

export default async function render(container, params = {}) {
  const theme = await loadTheme();
  const stored = loadGenerationErrorPayload();
  const relatedEvents = await findRelatedApiEvents(stored || {}).catch(() => []);
  const error = normalizeGenerationError(stored || {
    title: '暂无报错记录',
    scope: params.scope || '生成',
    message: '请从聊天或功能页的报错卡片点「查看详情排查」进入，报错内容会临时保存在本页。',
    reason: 'generic',
    at: Date.now(),
  });
  const guide = error.guide || GENERATION_ERROR_GUIDES.generic;
  const structureApiSection = error.structureApiSection === 'tool' ? 'tool' : 'main';
  const structureApiConfig = structureApiSection === 'tool'
    ? await getToolConfig().catch(() => ({}))
    : await getConfig().catch(() => ({}));
  const recommendStructureStrengthening = isModelFormatFailure(error)
    && error.finishReason !== 'length'
    && structureApiConfig.structureStrengthening !== true;
  const isUpstreamEmpty = error.guideKey === 'empty-api-response';
  const isHtmlResponse = error.guideKey === 'api-html-response';
  const apiPreview = String(error.responseText || '').trim();
  const rawPreview = String(error.rawText || '').trim();
  const showModelRaw = rawPreview && rawPreview !== apiPreview;
  const upstreamPreview = String(error.upstreamResponse || '').trim();
  const reasoningPreview = String(
    error.reasoningText
    || error.upstreamMeta?.reasoningText
    || '',
  ).trim();
  const transportPreview = formatStreamDiagnostics(error);
  const techDetail = !apiPreview && !rawPreview && !upstreamPreview && !reasoningPreview && !transportPreview
    ? String(error.detail || '').trim()
    : '';

  container.className = 'page scrapbook-page generation-error-page';
  applySettingsWallpaperPreview(container, theme);
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn gen-error-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">报错排查</h1>
      <button type="button" class="navbar-btn gen-error-copy-nav" aria-label="复制反馈">${icon('message')}</button>
    </header>
    <main class="settings-scroll scrapbook-scroll">
      <section class="settings-group">
        <div class="settings-group-title">当前报错</div>
        <div class="gen-error-current scrapbook-panel">
          <div class="gen-error-current-head">
            <span>${esc(error.scope)}${error.sideLabel ? ` · ${esc(error.sideLabel)}` : ''}</span>
            <small>${esc(formatTime(error.at))}</small>
          </div>
          <strong class="gen-error-current-title">${esc(error.title)}</strong>
          <p>${esc(error.message)}</p>
          ${error.sideLabel ? `<div class="gen-error-reason-tag">${esc(error.sideLabel)}</div>` : ''}
          ${error.status ? `<div class="gen-error-reason-tag">HTTP ${esc(error.status)}</div>` : ''}
          ${error.reason ? `<div class="gen-error-reason-tag">${esc(error.reason)}</div>` : ''}
        </div>
      </section>

      ${recommendStructureStrengthening ? `
      <section class="settings-group gen-error-next-step">
        <div class="gen-error-support-bridge scrapbook-panel">
          <div class="gen-error-support-copy">
            <span>检测到模型掉格式</span>
            <strong>开启结构强化后再试</strong>
            <small>下次结构化生成会加强 JSON 校验，不会自动增加请求次数。</small>
          </div>
          <div class="gen-error-support-actions">
            <button type="button" class="btn btn-primary gen-error-enable-structure">开启结构强化</button>
            <button type="button" class="btn btn-outline gen-error-open-api">打开${structureApiSection === 'tool' ? '工具' : '聊天'}模型设置</button>
          </div>
        </div>
      </section>` : ''}

      ${isUpstreamEmpty || isHtmlResponse ? `
      <section class="settings-group gen-error-next-step">
        <div class="gen-error-support-bridge scrapbook-panel">
          <div class="gen-error-support-copy">
            <span>${isHtmlResponse ? '接口返回了网站页面' : '上游没有返回可用正文'}</span>
            <strong>${isHtmlResponse ? '检查接口地址与渠道路由' : '换输出方式、模型或 API 渠道'}</strong>
            <small>${isHtmlResponse
              ? '请核对接口根地址和协议路径；地址无误仍返回网页时，携带接口原文、请求编号和实际地址联系 API 渠道服务商。'
              : '可手动切换流式/非流式请求；频繁空回请携带请求编号与 finish_reason 联系当前 API 渠道服务商。'}</small>
          </div>
          <div class="gen-error-support-actions">
            <button type="button" class="btn btn-primary gen-error-open-api">打开${structureApiSection === 'tool' ? '工具' : '聊天'}模型设置</button>
          </div>
        </div>
      </section>` : `
      <section class="settings-group gen-error-next-step">
        <div class="gen-error-support-bridge scrapbook-panel">
          <div class="gen-error-support-copy">
            <span>不知道下一步怎么处理？</span>
            <strong>让芥末棉花糖分析这条报错</strong>
            <small>会自动带上当前报错与脱敏运行状态，无需复制错误正文。</small>
          </div>
          <div class="gen-error-support-actions">
            <button type="button" class="btn btn-primary gen-error-ask-support">带上报错问芥末</button>
            <button type="button" class="btn btn-outline gen-error-submit-feedback">直接提交反馈</button>
          </div>
        </div>
      </section>`}

      ${apiPreview ? `
      <section class="settings-group">
        <div class="settings-group-title">接口原文</div>
        <pre class="gen-error-raw">${esc(apiPreview)}</pre>
        <p class="gen-error-hint">中转/模型接口返回的错误正文；排查时应优先看这里。</p>
      </section>` : ''}

      ${upstreamPreview ? `
      <section class="settings-group">
        <div class="settings-group-title">上游返回</div>
        <pre class="gen-error-raw">${esc(upstreamPreview)}</pre>
        <p class="gen-error-hint">来自 API 响应的 finish_reason、usage 等字段；finish_reason=length 表示上游主动结束输出。</p>
      </section>` : ''}

      ${reasoningPreview ? `
      <section class="settings-group">
        <div class="settings-group-title">推理原文</div>
        <pre class="gen-error-raw">${esc(reasoningPreview)}</pre>
        <p class="gen-error-hint">接口在本次失败响应中实际返回的 reasoning_content / thinking；仅用于排查，不会作为聊天正文落库。</p>
      </section>` : ''}

      ${!reasoningPreview && error.reasoningOriginalUnavailable ? `
      <section class="settings-group">
        <div class="settings-group-title">推理原文</div>
        <pre class="gen-error-raw">上游未返回可读取的推理文本</pre>
        <p class="gen-error-hint">本次响应只有推理 token/字符计数。计数只能说明模型消耗了推理额度，无法据此还原推理原文。</p>
      </section>` : ''}

      ${transportPreview ? `
      <section class="settings-group">
        <div class="settings-group-title">传输证据</div>
        <pre class="gen-error-raw">${esc(transportPreview)}</pre>
      </section>` : ''}

      ${showModelRaw ? `
      <section class="settings-group">
        <div class="settings-group-title">模型原文</div>
        <pre class="gen-error-raw">${esc(rawPreview)}</pre>
        <p class="gen-error-hint">用于对照模型实际生成内容；可复制后发给维护者。</p>
      </section>` : ''}

      ${techDetail ? `
      <section class="settings-group">
        <div class="settings-group-title">技术详情</div>
        <pre class="gen-error-raw">${esc(techDetail)}</pre>
      </section>` : ''}

      ${relatedEvents.length ? `
      <section class="settings-group">
        <div class="settings-group-title">同时段 API 记录</div>
        <div class="gen-error-guide-list">
          ${relatedEvents.map(renderRelatedEvent).join('')}
        </div>
      </section>` : ''}

      <section class="settings-group">
        <div class="settings-group-title">这类报错是什么意思</div>
        <div class="gen-error-guide-list">
          ${renderGuideSection(error.guideKey, guide, true)}
        </div>
      </section>

      <section class="settings-group">
        <div class="settings-group-title">常见报错速查</div>
        <div class="gen-error-guide-list">
          ${Object.entries(GENERATION_ERROR_GUIDES)
    .filter(([key]) => key !== error.guideKey)
    .map(([key, item]) => renderGuideSection(key, item, false))
    .join('')}
        </div>
      </section>

      <section class="settings-group">
        <div class="gen-error-actions">
          <button type="button" class="btn btn-primary gen-error-copy-main">复制反馈</button>
          <button type="button" class="btn btn-outline gen-error-open-log">打开错误日志</button>
        </div>
      </section>
    </main>
  `;

  async function copyBundle() {
    const ok = await copyTextToClipboard(buildGenerationErrorCopyText(error));
    showToast(ok ? '反馈已复制' : '复制失败');
  }

  container.querySelector('.gen-error-back')?.addEventListener('click', () => back());
  container.querySelector('.gen-error-copy-nav')?.addEventListener('click', copyBundle);
  container.querySelector('.gen-error-copy-main')?.addEventListener('click', copyBundle);
  container.querySelector('.gen-error-ask-support')?.addEventListener('click', () => {
    navigate('support', { fromError: '1' });
  });
  container.querySelector('.gen-error-submit-feedback')?.addEventListener('click', () => {
    navigate('support', { fromError: '1', feedback: '1' });
  });
  container.querySelector('.gen-error-open-log')?.addEventListener('click', () => {
    navigate('settings/debug-log');
  });
  container.querySelector('.gen-error-enable-structure')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const useToolApi = error.structureApiSection === 'tool';
      const current = useToolApi ? await getToolConfig() : await getConfig();
      if (useToolApi) await saveToolConfig({ ...current, structureStrengthening: true });
      else await saveConfig({ ...current, structureStrengthening: true });
      showToast(`已开启${useToolApi ? '工具模型' : '聊天模型'}结构强化，下次生成生效`);
      button.textContent = '已开启';
    } catch (_) {
      button.disabled = false;
      showToast('开启失败，请到 API 设置中操作');
    }
  });
  container.querySelector('.gen-error-open-api')?.addEventListener('click', () => {
    const section = error.structureApiSection === 'tool' ? 'tool' : 'main';
    navigate('settings/api', { tab: 'llm', focus: `${section}.structureStrengthening` });
  });
}
