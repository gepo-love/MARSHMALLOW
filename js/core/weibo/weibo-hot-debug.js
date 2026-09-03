import * as db from '../db.js';
import {
  WEIBO_HOT_TOPICS_CACHE_KEY,
  WEIBO_HOT_MODULE_QUOTA_PER_DAY,
  maybeRefreshWeiboHotTopics,
  getWeiboHotDebugSnapshot,
  diagnoseWeiboHotSources,
  resetWeiboHotModuleDailyUsage,
} from './weibo-hot-topics.js';
import { showToast } from '../../components/toast.js';

function formatDateTimeLabel(ts) {
  const n = Number(ts || 0);
  if (!n) return '未抓取';
  return new Date(n).toLocaleString('zh-CN');
}

function countWithSummary(items) {
  return Array.isArray(items) ? items.filter((x) => String(x?.summary || '').trim()).length : 0;
}

export function buildWeiboHotDebugText(summary = {}) {
  const cat = summary.categories || {};
  const sumCat = summary.categoriesWithSummary || {};
  const fmt = (key, label) => {
    const total = cat[key] || 0;
    const withSum = sumCat[key];
    if (typeof withSum === 'number') return `${label}: ${total}（含背景 ${withSum}）`;
    return `${label}: ${total}`;
  };
  return [
    '[微博热搜调试快照]',
    `缓存更新时间: ${summary.updatedAtLabel || '未抓取'}`,
    `今日抓取配额: ${summary.dailyUsed || 0}/${summary.dailyLimit || WEIBO_HOT_MODULE_QUOTA_PER_DAY}（含拉榜+按需取摘要）`,
    `总条目数: ${summary.totalCount || 0}${typeof summary.totalWithSummary === 'number' ? `（含事件背景 ${summary.totalWithSummary}）` : ''}`,
    fmt('general', '综合'),
    fmt('entertainment', '文娱'),
    fmt('life', '生活'),
    fmt('social', '社会'),
  ].join('\n');
}

export async function loadWeiboHotDebugSummary() {
  const cache = (await db.get('settings', WEIBO_HOT_TOPICS_CACHE_KEY).catch(() => null))?.value || null;
  const daily = (await db.get('settings', 'weiboHotTopicsDailyUsage').catch(() => null))?.value || null;
  const categories = {
    general: Array.isArray(cache?.byCategory?.general?.items) ? cache.byCategory.general.items.length : 0,
    entertainment: Array.isArray(cache?.byCategory?.entertainment?.items) ? cache.byCategory.entertainment.items.length : 0,
    life: Array.isArray(cache?.byCategory?.life?.items) ? cache.byCategory.life.items.length : 0,
    social: Array.isArray(cache?.byCategory?.social?.items) ? cache.byCategory.social.items.length : 0,
  };
  const categoriesWithSummary = {
    general: countWithSummary(cache?.byCategory?.general?.items),
    entertainment: countWithSummary(cache?.byCategory?.entertainment?.items),
    life: countWithSummary(cache?.byCategory?.life?.items),
    social: countWithSummary(cache?.byCategory?.social?.items),
  };
  const totalCount = Object.values(categories).reduce((a, b) => a + b, 0);
  const totalWithSummary = Object.values(categoriesWithSummary).reduce((a, b) => a + b, 0);
  return {
    updatedAtLabel: formatDateTimeLabel(cache?.updatedAt || 0),
    dailyUsed: Number(daily?.used || 0),
    dailyLimit: WEIBO_HOT_MODULE_QUOTA_PER_DAY,
    totalCount,
    totalWithSummary,
    categories,
    categoriesWithSummary,
  };
}

export function renderWeiboHotDebugPanel(summaryText = '加载中…') {
  return `
    <section class="api-panel api-weibo-hot-panel">
      <header class="api-panel-header"><h3>微博热搜调试</h3></header>
      <div class="text-hint setting-weibo-hot-debug-summary" style="font-size:11px;line-height:1.55;white-space:pre-wrap;background:var(--surface-card,#fffdf8);padding:8px 10px;border-radius:10px;border:1px solid var(--surface-card-border,rgba(140,115,98,0.14));">${summaryText}</div>
      <div class="api-actions" style="justify-content:flex-start;flex-wrap:wrap;">
        <button type="button" class="btn btn-sm btn-outline setting-weibo-hot-refresh">立即刷新热搜</button>
        <button type="button" class="btn btn-sm btn-outline setting-weibo-hot-diagnose">抓取诊断</button>
        <button type="button" class="btn btn-sm btn-outline setting-weibo-hot-copy">复制调试信息</button>
        <button type="button" class="btn btn-sm btn-outline setting-weibo-hot-copy-json">复制完整JSON</button>
        <button type="button" class="btn btn-sm btn-outline setting-weibo-hot-reset-quota">重置模块配额</button>
      </div>
      <p class="text-hint" style="font-size:11px;line-height:1.45;margin:0;">抓取策略：聊天触发懒刷新（8小时），此处可手动强刷并复制快照用于排查。依赖 Tavily API Key（搜索 Tab 上方配置）。</p>
    </section>
  `;
}

async function copyText(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', 'readonly');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

/** 绑定 API 管理 · 搜索 Tab 内的微博热搜调试区 */
export function bindWeiboHotDebugPanel(container) {
  const summaryEl = container.querySelector('.setting-weibo-hot-debug-summary');
  if (!summaryEl) return;

  let lastJson = null;

  async function refreshSummary() {
    const summary = await loadWeiboHotDebugSummary();
    summaryEl.textContent = buildWeiboHotDebugText(summary);
    lastJson = summary;
    return summary;
  }

  refreshSummary().catch(() => {
    summaryEl.textContent = '加载失败';
  });

  container.querySelector('.setting-weibo-hot-refresh')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const idleText = button.textContent;
    try {
      button.disabled = true;
      button.textContent = '刷新中…';
      showToast('正在刷新微博热搜…');
      const result = await maybeRefreshWeiboHotTopics({ force: true });
      await refreshSummary();
      const failedCount = Array.isArray(result?.failures) ? result.failures.length : 0;
      showToast(failedCount > 0
        ? `热搜已刷新 ${result.categoryCount} 类，${failedCount} 类失败`
        : `微博热搜已刷新，共 ${result?.totalCount || 0} 条`);
    } catch (e) {
      console.error('[weibo-hot-debug] refresh failed:', e);
      const message = String(e?.message || e);
      const summary = await loadWeiboHotDebugSummary().catch(() => null);
      summaryEl.textContent = summary
        ? `[刷新失败]\n${message}\n\n${buildWeiboHotDebugText(summary)}`
        : `刷新失败：${message}`;
      showToast(`刷新失败：${message}`);
    } finally {
      button.disabled = false;
      button.textContent = idleText;
    }
  });

  container.querySelector('.setting-weibo-hot-copy')?.addEventListener('click', async () => {
    try {
      const summary = await refreshSummary();
      await copyText(buildWeiboHotDebugText(summary));
      showToast('已复制调试信息');
    } catch (e) {
      console.error('[weibo-hot-debug] copy failed:', e);
      showToast('复制失败');
    }
  });

  container.querySelector('.setting-weibo-hot-diagnose')?.addEventListener('click', async () => {
    try {
      showToast('正在诊断抓取链路…');
      const snapshot = await getWeiboHotDebugSnapshot();
      const report = await diagnoseWeiboHotSources({ runExtract: true });
      lastJson = report;
      const lines = [
        '[微博热搜诊断结果]',
        `Tavily开关: ${snapshot?.config?.enabled ? '开' : '关'}`,
        `API Key: ${snapshot?.config?.hasApiKey ? '已配置' : '未配置'}`,
        `模块配额: ${snapshot?.quota?.used || 0}/${snapshot?.quota?.hardLimit || WEIBO_HOT_MODULE_QUOTA_PER_DAY}`,
      ];
      for (const c of report?.checks || []) {
        const extra = [
          typeof c.rawCharLength === 'number' ? `raw=${c.rawCharLength}字` : '',
          c.viaSearchFallback ? 'search回退' : '',
          c.searchParsedCount ? `search条=${c.searchParsedCount}` : '',
        ].filter(Boolean).join(' ');
        lines.push(
          `${c.label}: ${c.ok ? 'OK' : 'FAIL'} / ${c.reason}${c.parsedCount ? ` / 解析条数=${c.parsedCount}` : ''}${extra ? ` / ${extra}` : ''}${Array.isArray(c.sampleKeywords) && c.sampleKeywords.length ? ` / 样例=${c.sampleKeywords.join('、')}` : ''}`,
        );
      }
      summaryEl.textContent = lines.join('\n');
      showToast('诊断完成');
    } catch (e) {
      console.error('[weibo-hot-debug] diagnose failed:', e);
      showToast(`诊断失败：${String(e?.message || e)}`);
    }
  });

  container.querySelector('.setting-weibo-hot-copy-json')?.addEventListener('click', async () => {
    try {
      if (!lastJson) lastJson = await getWeiboHotDebugSnapshot();
      await copyText(JSON.stringify(lastJson, null, 2));
      showToast('已复制完整JSON');
    } catch (e) {
      console.error('[weibo-hot-debug] copy json failed:', e);
      showToast('复制JSON失败');
    }
  });

  container.querySelector('.setting-weibo-hot-reset-quota')?.addEventListener('click', async () => {
    try {
      await resetWeiboHotModuleDailyUsage();
      await refreshSummary();
      showToast('已重置微博热搜模块今日配额');
    } catch (e) {
      console.error('[weibo-hot-debug] reset quota failed:', e);
      showToast('重置失败');
    }
  });
}
