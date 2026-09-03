import { GENERATION_ERROR_GUIDES } from '../generation-error-guide.js';
import {
  renderTutorialSection,
  SUPPORT_FAQ_ENTRIES,
  TUTORIAL_NAV,
} from '../../data/tutorial-sections.js';
import { normalizeSupportActionIds } from './support-actions.js';

const ARTICLES = [
  {
    id: 'mixed-build-cache',
    keywords: ['importing binding name', 'does not provide an export', 'is not found', '页面加载失败', '新旧缓存', '旧版本缓存'],
    title: '页面脚本来自不同版本',
    answer: '这是新版页面模块没有完整安装造成的，不是本地数据损坏。请打开急救诊断，使用“修复更新并重启”；应用会保留当前可用版本，完整校验新版后才切换，不会删除聊天或角色数据。',
    actions: ['open-cache-recovery', 'open-debug-log'],
  },
  {
    id: 'api-key',
    keywords: ['401', '403', 'api key', 'apikey', '密钥', 'key无效', '未授权'],
    title: 'API 密钥或权限异常',
    answer: '先核对 API 地址与密钥是否属于同一家服务，再确认密钥没有多余空格、账号仍有模型权限。401 通常是密钥无效，403 更常见于权限或地区限制。',
    actions: ['focus-main-key', 'focus-main-model'],
  },
  {
    id: 'rate-limit',
    keywords: ['429', '限流', '额度', '余额', '频率'],
    title: '额度或请求频率受限',
    answer: '429 通常来自额度耗尽、并发过高或服务商限流。先查看接口原文和余额，稍后重试；持续出现时换可用线路。',
    actions: ['open-main-api'],
  },
  {
    id: 'model',
    keywords: ['模型不存在', 'model not found', '模型名', '404'],
    title: '模型名或接口地址不匹配',
    answer: '模型名必须使用当前线路实际提供的标识。建议在 API 管理里重新拉取模型，并确认地址填的是接口根地址而不是网站首页。',
    actions: ['focus-main-model', 'open-main-api'],
  },
  {
    id: 'empty',
    keywords: ['空回', '没有正文', 'thinking', 'reasoning', '未抽到'],
    title: '接口返回了空正文',
    answer: '部分推理模型只返回 reasoning，或中转不兼容长 system 请求。可尝试开启“将 system 合并到首条 user”，它会保留原有多轮对话。',
    actions: ['focus-single-user', 'focus-stream-mode'],
  },
  {
    id: 'stream',
    keywords: ['断流', 'stream', '切后台', '锁屏', '连接中断'],
    title: '回复传输途中断开',
    answer: '切后台、锁屏、网络切换或线路提前关流都会造成断流。可改用一次性输出，并检查后台活跃设置。',
    actions: ['focus-stream-mode', 'open-keepalive'],
  },
  {
    id: 'network',
    keywords: ['failed to fetch', 'cors', '网络', 'dns', '证书', '无法连接'],
    title: '网络层无法确定具体原因',
    answer: '浏览器的 Failed to fetch 不能单独证明是跨域，也可能是 DNS、证书、代理或断网。先用 API 管理的连接测试确认同一线路是否可达。',
    actions: ['open-main-api', 'open-debug-log'],
  },
  {
    id: 'storage',
    keywords: ['indexeddb', '数据库', '存储', '数据丢失', '空间不足', 'quota'],
    title: '本地存储异常',
    answer: '先不要清除站点数据。刷新后仍失败时，优先导出可用备份并打开错误日志；iOS 还应开启本地存储保护。',
    actions: ['open-debug-log'],
  },
];

function plainTutorialText(html = '') {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const TUTORIAL_KEYWORDS = Object.freeze({
  backup: ['备份', '导出', '导入', '恢复'],
  api: ['API 地址', '密钥', '模型'],
  search: ['搜索 API', '联网搜索'],
  image: ['生图', '图片生成'],
  voice: ['语音', '麦克风', '听写'],
  support: ['芥末棉花糖', '答疑', '反馈'],
  troubleshooting: ['常见问题', '为什么', '不显示', '不回复', '掉格式'],
  music: ['音乐', '歌曲'],
  moments: ['朋友圈', '动态'],
  anonymous: ['匿名区', '匿名墙'],
});

const TUTORIAL_ARTICLES = TUTORIAL_NAV
  .filter((section) => section.id !== 'troubleshooting')
  .map((section) => {
  const content = plainTutorialText(renderTutorialSection(section.id));
  return {
    id: `tutorial-${section.id}`,
    kind: 'tutorial',
    sectionId: section.id,
    keywords: [section.id, section.label, ...(TUTORIAL_KEYWORDS[section.id] || [])],
    searchText: `${section.label} ${content}`.toLowerCase(),
    title: `${section.label}教程`,
    answer: content.length > 420 ? `${content.slice(0, 420)}…` : content,
    actions: [`open-tutorial-${section.id}`],
  };
  });

const FAQ_ARTICLES = SUPPORT_FAQ_ENTRIES.map((entry) => ({
  ...entry,
  kind: 'faq',
  sectionId: 'troubleshooting',
  searchText: [entry.title, entry.answer, ...(entry.steps || [])].join(' ').toLowerCase(),
  actions: [...(entry.actions || []), 'open-tutorial-troubleshooting'],
}));

const ALL_ARTICLES = [...ARTICLES, ...FAQ_ARTICLES, ...TUTORIAL_ARTICLES];

function meaningfulTokens(question = '') {
  const stop = new Set(['什么', '怎么', '如何', '可以', '这个', '那个', '为什么', '是否', '一下', '问题']);
  const value = String(question || '').toLowerCase();
  const words = value.split(/[\s，。！？、：；,.!?/:;（）()\[\]{}]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && !stop.has(item));
  const grams = [];
  for (const run of value.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (const size of [2, 3, 4]) {
      for (let index = 0; index <= run.length - size; index += 1) {
        const token = run.slice(index, index + size);
        if (!stop.has(token)) grams.push(token);
      }
    }
  }
  return [...new Set([...words, ...grams])].slice(0, 40);
}

function scoreArticle(article, question) {
  const value = String(question || '').toLowerCase();
  let keywordScore = article.keywords.reduce((score, keyword) => (
    value.includes(String(keyword).toLowerCase())
      ? score + Math.max(article.kind === 'tutorial' ? 12 : (article.kind === 'faq' ? 20 : 2), String(keyword).length)
      : score
  ), 0);
  const faqKeywordMatch = article.kind === 'faq' && keywordScore > 0;
  if (faqKeywordMatch) keywordScore += 100;
  if (!article.searchText) return keywordScore;
  const score = meaningfulTokens(value).reduce((total, token) => (
    article.searchText.includes(token) ? total + Math.min(8, token.length + 1) : total
  ), keywordScore);
  return article.kind === 'faq' && !faqKeywordMatch && score >= 16 ? score + 40 : score;
}

export function findSupportKnowledge(question = '', diagnostic = null, limit = 3) {
  const genericEntry = diagnostic?.code === 'support-opened' || diagnostic?.code === 'support-context';
  const joined = [
    question,
    genericEntry ? '' : diagnostic?.code,
    genericEntry ? '' : diagnostic?.message,
    genericEntry ? '' : diagnostic?.status,
    genericEntry ? '' : diagnostic?.apiKind,
    genericEntry ? '' : diagnostic?.operation,
  ].filter(Boolean).join(' ');
  return ALL_ARTICLES
    .map((article) => ({ ...article, score: scoreArticle(article, joined) }))
    .filter((article) => article.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function buildLocalSupportAnswer(question = '', diagnostic = null) {
  const matches = findSupportKnowledge(question, diagnostic, 2);
  const apiAction = {
    search: 'open-search-api',
    voice: 'open-voice-api',
    image: 'open-image-api',
    support: 'open-support-api',
    chat: 'open-main-api',
    tool: 'open-main-api',
    scene: 'open-main-api',
  }[diagnostic?.apiKind] || '';
  const guide = diagnostic?.code && GENERATION_ERROR_GUIDES[diagnostic.code]
    ? GENERATION_ERROR_GUIDES[diagnostic.code]
    : null;
  if (!matches.length && !guide) {
    return {
      title: '需要更多信息',
      answer: '请描述在哪个页面、点了什么以及看到的原文；如果刚发生过报错，也可以带入最近报错继续分析。',
      steps: ['保留报错原文或错误码', '说明是否能稳定复现', '必要时提交脱敏反馈'],
      actions: normalizeSupportActionIds([apiAction, 'open-debug-log']),
      source: 'local',
    };
  }
  const primary = matches[0];
  const relatedMatches = primary?.kind === 'faq' ? [] : matches.slice(1);
  return {
    title: primary?.title || guide?.title || '排查建议',
    answer: primary?.answer || guide?.summary || '',
    steps: [
      ...(primary?.steps || []),
      ...(guide?.fixes || []),
      ...(relatedMatches.map((item) => item.answer)),
    ].slice(0, 4),
    actions: normalizeSupportActionIds([
      apiAction,
      ...(primary?.actions || []),
      ...(relatedMatches[0]?.actions || []),
    ]),
    source: ['tutorial', 'faq'].includes(primary?.kind) ? 'tutorial' : 'local',
    tutorialSection: primary?.sectionId || '',
  };
}

export function buildSupportKnowledgeContext(question = '', diagnostic = null) {
  return findSupportKnowledge(question, diagnostic, 3).map((article) => ({
    id: article.id,
    title: article.title,
    answer: article.answer,
    actions: article.actions,
    tutorialSection: article.sectionId || '',
  }));
}
