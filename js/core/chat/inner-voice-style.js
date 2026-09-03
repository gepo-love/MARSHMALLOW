/**
 * 心声弹层样式（会话独立）
 * - 数据落在 chat.groupSettings.innerVoiceCard：template / position / css / inlineEnabled / inlineCss / labels
 * - 预设独立存全局 settings 键 innerVoiceCardPresets，不跟用户档位切换
 * - 与 core/chat-appearance.js（消息界面美化）结构对称
 */
import { get, put } from '../db.js';
import { BUILTIN_INNER_VOICE_CARD_PRESETS } from '../../data/builtin-inner-voice-card.js';
import { sanitizeHtmlExtensionTemplate } from '../html-extensions.js';

const INNER_VOICE_CARD_PRESETS_KEY = 'innerVoiceCardPresets';
export const INNER_VOICE_CARD_CHANGED_EVENT = 'marshmallow-inner-voice-card-changed';
export const MAX_INNER_VOICE_PROMPT_LENGTH = 4000;
export const MAX_INNER_VOICE_TEMPLATE_LENGTH = 12000;
export const INNER_VOICE_CARD_EXPORT_TYPE = 'marshmallow-inner-voice-card';
export const INNER_VOICE_CARD_EXPORT_VERSION = 1;
const INNER_VOICE_TEMPLATE_TAGS = new Set([
  'div', 'span', 'p', 'small', 'strong', 'em', 'b', 'i', 'u', 'br', 'hr',
  'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4',
  'ul', 'ol', 'li', 'details', 'summary', 'img',
]);

export const INNER_VOICE_CARD_TEMPLATES = ['diary', 'ins'];
export const INNER_VOICE_CARD_POSITIONS = ['center', 'top', 'bottom'];

/** 标签留空＝跟随默认文案；这里只是给 UI 展示默认值用 */
export const INNER_VOICE_LABEL_DEFAULTS = {
  titleSuffix: '心声',
  fieldInner: '心声',
  fieldIntent: '心思',
  fieldStatus: '当前状态',
  fieldMood: '心情',
  fieldMoodBar: '情绪波动',
  tabCurrent: '当前',
  tabHistory: '往期',
  closeButton: '关闭',
};

const LABEL_KEYS = Object.keys(INNER_VOICE_LABEL_DEFAULTS);
const LABEL_MAX_LEN = 10;

function cleanScopedCss(value, scope) {
  let s = String(value == null ? '' : value);
  s = s.replace(/<\/?\s*style[^>]*>/gi, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@(?:import|font-face|keyframes|media|supports)[^{;]*(?:;|\{[\s\S]*?\})/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none')
    .replace(/(?:expression|javascript|vbscript)\s*[:(]/gi, '');
  return s.replace(/([^{}]+)\{([^{}]*)\}/g, (_, rawSelectors, declarations) => {
    const selectors = String(rawSelectors || '').split(',').map((selector) => {
      const clean = selector.trim();
      if (!clean || clean.startsWith('@')) return '';
      return clean.startsWith(scope) ? clean : `${scope} ${clean}`;
    }).filter(Boolean);
    return selectors.length ? `${selectors.join(',')}{${declarations}}` : '';
  });
}

function cleanCss(value) {
  return cleanScopedCss(value, '#char-state-popover');
}

export function cleanInlineInnerVoiceCss(value) {
  return cleanScopedCss(value, '.chat-inline-inner-voice-host');
}

function isSafeInnerVoiceImageUrl(value = '') {
  const url = String(value || '').trim();
  if (!url) return false;
  if (url.startsWith('/')) return true;
  if (/^https?:\/\//i.test(url)) return true;
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(url);
}

export function cleanInnerVoicePrompt(value = '') {
  return String(value || '')
    .replace(/<<<\/?(?:THINKING|END_THINKING|MARSHMALLOW_CHAT_V2|END_MARSHMALLOW_CHAT_V2)>>>/gi, '')
    .trim()
    .slice(0, MAX_INNER_VOICE_PROMPT_LENGTH);
}

export function sanitizeInnerVoiceTemplate(value = '') {
  const raw = String(value || '')
    .slice(0, MAX_INNER_VOICE_TEMPLATE_LENGTH)
    .replace(/<\s*(?:script|iframe|object|embed|form|input|textarea|select)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|iframe|object|embed|form|input|textarea|select)\s*>/gi, '')
    .replace(/<\s*(?:script|iframe|object|embed|form|input|textarea|select)\b[^>]*\/?\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  if (!raw.trim()) return '';
  const restricted = raw.replace(/<\s*(\/?)\s*([a-z][\w-]*)\b([^>]*)>/gi, (full, closing, rawTag, attrs) => {
    const tag = String(rawTag || '').toLowerCase();
    if (!INNER_VOICE_TEMPLATE_TAGS.has(tag)) return '';
    if (closing) return `</${tag}>`;
    const kept = [];
    String(attrs || '').replace(/([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (_, rawName, quoted, doubleValue, singleValue) => {
      const name = String(rawName || '').toLowerCase();
      const attrValue = String(doubleValue ?? singleValue ?? '').replace(/[<>]/g, '');
      const isImageAttribute = tag === 'img' && (
        name === 'alt' || (name === 'src' && isSafeInnerVoiceImageUrl(attrValue))
      );
      if (!(name === 'class' || name === 'id' || name === 'title' || name === 'role' || name === 'hidden' || name.startsWith('aria-') || isImageAttribute)) return '';
      kept.push(`${name}="${attrValue.replace(/"/g, '&quot;')}"`);
      return '';
    });
    if (tag === 'img' && !kept.some((attr) => attr.startsWith('src='))) return '';
    return `<${tag}${kept.length ? ` ${kept.join(' ')}` : ''}>`;
  });
  const sanitized = sanitizeHtmlExtensionTemplate(restricted);
  if (typeof document === 'undefined' || !sanitized) return sanitized;
  try {
    const doc = new DOMParser().parseFromString(`<body>${sanitized}</body>`, 'text/html');
    doc.body.querySelectorAll('a,button,style').forEach((node) => node.replaceWith(...node.childNodes));
    doc.body.querySelectorAll('*').forEach((node) => {
      Array.from(node.attributes).forEach((attr) => {
        const name = String(attr.name || '').toLowerCase();
        const isImageAttribute = node.tagName === 'IMG' && (name === 'src' || name === 'alt');
        if (name === 'class' || name === 'id' || name === 'title' || name === 'hidden' || name === 'role' || name.startsWith('aria-') || isImageAttribute) return;
        node.removeAttribute(attr.name);
      });
    });
    doc.body.querySelectorAll('img').forEach((img) => {
      if (!String(img.getAttribute('src') || '').trim()) {
        img.remove();
        return;
      }
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      img.setAttribute('referrerpolicy', 'no-referrer');
    });
    return doc.body.innerHTML;
  } catch (_) {
    return '';
  }
}

export function normalizeInnerVoiceLabels(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  LABEL_KEYS.forEach((key) => {
    const v = String(src[key] || '').trim().slice(0, LABEL_MAX_LEN);
    if (v) out[key] = v;
  });
  return out;
}

/** 取某个 label 的最终展示文案：有自定义用自定义，否则用默认词 */
export function resolveInnerVoiceLabel(labels, key) {
  const v = labels && typeof labels === 'object' ? String(labels[key] || '').trim() : '';
  return v || INNER_VOICE_LABEL_DEFAULTS[key] || '';
}

/**
 * defaultTemplate：会话没有自己选过骨架时兜底用哪个——棉花糖之窗/之海主题下
 * 由调用方传 'ins'，让心声卡片默认跟随 ins 系视觉，而不是奶油手账的默认值。
 */
export function normalizeInnerVoiceCard(raw, defaultTemplate = 'diary') {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fallback = INNER_VOICE_CARD_TEMPLATES.includes(defaultTemplate) ? defaultTemplate : 'diary';
  return {
    template: INNER_VOICE_CARD_TEMPLATES.includes(src.template) ? src.template : fallback,
    position: INNER_VOICE_CARD_POSITIONS.includes(src.position) ? src.position : 'center',
    css: cleanCss(src.css),
    inlineEnabled: src.inlineEnabled === true,
    inlineCss: cleanInlineInnerVoiceCss(src.inlineCss),
    labels: normalizeInnerVoiceLabels(src.labels),
    generationMode: src.generationMode === 'custom' ? 'custom' : 'default',
    generationPrompt: cleanInnerVoicePrompt(src.generationPrompt),
    templateHtml: sanitizeInnerVoiceTemplate(src.templateHtml),
  };
}

export function buildInnerVoiceCardExportPayload(card, defaultTemplate = 'diary') {
  return {
    type: INNER_VOICE_CARD_EXPORT_TYPE,
    version: INNER_VOICE_CARD_EXPORT_VERSION,
    exportedAt: Date.now(),
    formatName: '棉花糖机心声方案',
    formatNote: '棉花糖机自用 JSON 格式，与酒馆角色卡无关，不兼容酒馆导入格式。',
    card: normalizeInnerVoiceCard(card, defaultTemplate),
  };
}

export function parseInnerVoiceCardImportText(text = '', defaultTemplate = 'diary') {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('文件里没有可导入的心声方案');

  const candidates = [raw];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = fenceRe.exec(raw);
  while (match) {
    const block = String(match[1] || '').trim();
    if (block) candidates.unshift(block);
    match = fenceRe.exec(raw);
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(candidate);
      if (!payload || typeof payload !== 'object') continue;
      if (payload.type === INNER_VOICE_CARD_EXPORT_TYPE && payload.card) {
        return normalizeInnerVoiceCard(payload.card, defaultTemplate);
      }
      if (payload.card && typeof payload.card === 'object' && !payload.type) {
        return normalizeInnerVoiceCard(payload.card, defaultTemplate);
      }
      if (
        'template' in payload
        || 'position' in payload
        || 'css' in payload
        || 'inlineEnabled' in payload
        || 'inlineCss' in payload
        || 'labels' in payload
        || 'generationPrompt' in payload
        || 'templateHtml' in payload
      ) {
        return normalizeInnerVoiceCard(payload, defaultTemplate);
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`心声方案 JSON 解析失败：${String(lastError?.message || '格式不正确').slice(0, 80)}`);
}

export function getInnerVoiceCard(chat, defaultTemplate = 'diary') {
  const gs = (chat && chat.groupSettings) || {};
  return normalizeInnerVoiceCard(gs.innerVoiceCard, defaultTemplate);
}

export function isInnerVoiceCardDefault(card) {
  const c = normalizeInnerVoiceCard(card);
  return c.template === 'diary'
    && c.position === 'center'
    && !c.css.trim()
    && !c.inlineEnabled
    && !c.inlineCss.trim()
    && Object.keys(c.labels).length === 0
    && c.generationMode === 'default'
    && !c.generationPrompt
    && !c.templateHtml;
}

function cardsEqual(a, b) {
  const ca = normalizeInnerVoiceCard(a);
  const cb = normalizeInnerVoiceCard(b);
  return ca.template === cb.template
    && ca.position === cb.position
    && ca.css === cb.css
    && ca.inlineEnabled === cb.inlineEnabled
    && ca.inlineCss === cb.inlineCss
    && JSON.stringify(ca.labels) === JSON.stringify(cb.labels)
    && ca.generationMode === cb.generationMode
    && ca.generationPrompt === cb.generationPrompt
    && ca.templateHtml === cb.templateHtml;
}

/* ── 预设（全局，不跟用户档位） ── */

function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const card = normalizeInnerVoiceCard(raw);
  const now = Date.now();
  return {
    id: String(raw.id || '').trim() || `ivc_${now}_${Math.random().toString(36).slice(2, 6)}`,
    name: String(raw.name || '').trim().slice(0, 40) || '未命名预设',
    template: card.template,
    position: card.position,
    css: card.css,
    inlineEnabled: card.inlineEnabled,
    inlineCss: card.inlineCss,
    labels: card.labels,
    generationMode: card.generationMode,
    generationPrompt: card.generationPrompt,
    templateHtml: card.templateHtml,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
  };
}

function builtinPresets() {
  return BUILTIN_INNER_VOICE_CARD_PRESETS
    .map((p) => normalizePreset({ ...p, createdAt: 0, updatedAt: 0 }))
    .filter(Boolean)
    .map((p) => ({ ...p, builtin: true }));
}

async function loadSavedPresets() {
  const row = await get(INNER_VOICE_CARD_PRESETS_KEY);
  const list = Array.isArray(row && row.value && row.value.presets) ? row.value.presets : [];
  return list.map(normalizePreset).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function savePresetList(list) {
  await put({ key: INNER_VOICE_CARD_PRESETS_KEY, value: { presets: list } });
}

export async function loadInnerVoiceCardPresets() {
  const saved = await loadSavedPresets();
  return [...builtinPresets(), ...saved];
}

export async function saveInnerVoiceCardPreset(name, card) {
  const label = String(name || '').trim();
  if (!label) throw new Error('请填写预设名称');
  const list = await loadSavedPresets();
  const c = normalizeInnerVoiceCard(card);
  const now = Date.now();
  const preset = normalizePreset({
    id: `ivc_${now}_${Math.random().toString(36).slice(2, 6)}`,
    name: label,
    template: c.template,
    position: c.position,
    css: c.css,
    inlineEnabled: c.inlineEnabled,
    inlineCss: c.inlineCss,
    labels: c.labels,
    generationMode: c.generationMode,
    generationPrompt: c.generationPrompt,
    templateHtml: c.templateHtml,
    createdAt: now,
    updatedAt: now,
  });
  await savePresetList([preset, ...list]);
  return preset;
}

export async function deleteInnerVoiceCardPreset(id) {
  const target = String(id || '').trim();
  if (!target) return;
  const list = await loadSavedPresets();
  await savePresetList(list.filter((p) => p.id !== target));
}

export function presetToCard(preset) {
  return normalizeInnerVoiceCard(preset);
}

export function findMatchingPresetId(presets, card) {
  const found = (presets || []).find((p) => cardsEqual(p, card));
  return found ? found.id : '';
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

/** 给用户 / AI 用的 CSS 参考文档（可下载）：弹层与消息内心声的稳定类名 */
export function buildInnerVoiceCardReferenceMarkdown() {
  const classRows = [
    ['#char-state-popover', '弹层最外层（背景遮罩）'],
    ['#char-state-popover.csp-pos-center / .csp-pos-top / .csp-pos-bottom', '居中 / 顶部 / 底部弹出位置'],
    ['#char-state-popover.csp-skin-diary / .csp-skin-ins', '手账 / ins 遮罩皮肤'],
    ['.char-state-card', '卡片容器'],
    ['.char-state-card.csp-diary / .char-state-card.csp-ins', '手账卡 / ins 小白卡骨架'],
    ['.char-state-avatar', '头像圆框（仅 ins 小白卡骨架有）'],
    ['.char-state-avatar img / .char-state-avatar-fallback', '头像图片 / 未设置头像时的字母底'],
    ['.char-state-header / .char-state-divider', '卡片标题区 / ins 骨架分隔线'],
    ['.char-state-header-title', '标题（名字 + 后缀词）'],
    ['.char-state-tabs / .char-state-tab', '「当前 / 往期」切换条外壳 / 单个按钮；白边或色带可能由两层共同产生'],
    ['.char-state-tab.is-active', '选中的 tab；ins 骨架默认另有白底与阴影'],
    ['.char-state-popover-body', '当前内容或往期列表的主体容器'],
    ['.char-state-row / .char-state-intent-row', '普通字段行 / 可展开查看的心思字段行'],
    ['.char-state-custom-template', '自定义内容 HTML 的容器'],
    ['.char-state-custom-row[data-state-key]', '模型生成的任意自定义字段；可按 data-state-key 精确选择'],
    ['.char-state-row-label / .char-state-row-value', '字段名 / 字段值一行'],
    ['.char-state-translate-btn', '心思/译文的展开按钮'],
    ['.char-state-mood-row / .char-state-mood-label', '情绪波动整行 / 标签'],
    ['.char-state-mood-track / .char-state-mood-fill / .char-state-mood-value', '情绪波动轨道 / 填充 / 数值；填充宽度由当前数值以内联 style 写入'],
    ['.char-state-close-btn / .char-state-close-x', '关闭按钮（底部条 / 右上角 ×）'],
    ['.char-state-history-card', '往期记录单条卡片'],
    ['.char-state-history-head / .char-state-history-time', '往期记录头部 / 时间'],
    ['.char-state-del-btn / .char-state-clear-all-btn', '删除单条 / 清空全部'],
    ['.char-state-pager / .char-state-pager-btn / .char-state-pager-count', '往期分页栏 / 翻页按钮 / 页码'],
    ['.char-state-pager-total / .char-state-empty-hint', '往期总数 / 空状态与加载状态'],
    ['.chat-inline-inner-voice-host', '消息内心声作用域与外层容器'],
    ['.chat-inline-inner-voice', '消息内心声内容容器'],
    ['.chat-inline-inner-voice-head / .chat-inline-inner-voice-name / .chat-inline-inner-voice-label', '消息内心声标题区 / 角色名 / 心声标签'],
    ['.chat-inline-inner-voice-body / .chat-inline-inner-voice-text', '消息内心声正文区 / 默认心声文字'],
    ['.chat-inline-inner-voice-open', '打开完整心声弹层的按钮'],
  ].map(([cls, label]) => [`\`${cls}\``, label]);
  const basicExample = [
    '#char-state-popover .char-state-card{',
    '  background:#fff;',
    '  border-radius:28px;',
    '}',
    '#char-state-popover .char-state-mood-fill{',
    '  background:#c9a6ff;',
    '}',
  ].join('\n');
  const tabsExample = [
    '/* 同时覆盖两套骨架；去掉切换条外壳与选中按钮的白边/阴影 */',
    '#char-state-popover .char-state-tabs {',
    '  background: transparent !important;',
    '  border: 0 !important;',
    '  box-shadow: none !important;',
    '  padding: 0 !important;',
    '}',
    '#char-state-popover .char-state-tab,',
    '#char-state-popover .char-state-tab.is-active {',
    '  border: 0 !important;',
    '  outline: 0 !important;',
    '  box-shadow: none !important;',
    '}',
  ].join('\n');
  return [
    '# 棉花糖机 · 心声方案参考文档',
    '',
    '把选择器抄给 AI 说明想要的风格，或自己对照着写。弹层 CSS 写在 `#char-state-popover` 之下；消息内心声 CSS 写在 `.chat-inline-inner-voice-host` 之下。两种 CSS 都只作用于当前会话。',
    '',
    '线下楼层点「角色 · 心声」打开的也是同一套弹层，会沿用关联会话的骨架、位置、文案与 CSS；楼层上的入口按钮 `.os-beat-thought` 则在线下美化文档中设置。',
    '',
    '## 覆盖规则与常见“不生效”原因',
    '',
    '- 心声 CSS 会在内置骨架之后注入，但不会像美化工作室那样自动提升选择器权重。建议所有规则都以 `#char-state-popover` 开头。',
    '- 内置骨架使用 `.csp-diary …` 和 `.csp-ins …`。只写 `.char-state-tab` 等裸类名时，可能被骨架规则盖回；用 `#char-state-popover .char-state-tab`，或需要区分时写 `#char-state-popover .csp-ins …` / `#char-state-popover .csp-diary …`。',
    '- 视觉可能来自多层：弹层遮罩与卡片、切换条外壳与选中按钮、头像外框与图片都要分别检查。只改子元素不会自动清掉父元素的背景、padding、边框或阴影。',
    '- ins 骨架才有 `.char-state-avatar`、`.char-state-divider`、`.char-state-close-x`；手账骨架使用底部 `.char-state-close-btn`。元素在当前骨架中不存在时，对应 CSS 不会显示效果。',
    '- `.char-state-mood-fill` 的 `width` 是当前情绪数值写入的内联样式。通常只改颜色；若确实要接管宽度，需要对 `width` 局部使用 `!important`。',
    '- 不要给卡片或遮罩设置 `pointer-events:none`，也不要把关闭按钮、编辑按钮和分页按钮移出可点击区域。',
    '- 消息内心声按生成轮次挂在该角色当轮最后一条消息下方；关闭或隐藏心声时不会渲染。',
    '',
    '## 自定义内容 HTML',
    '',
    '可用占位符：`{{name}}`、`{{inner}}`、`{{intent}}`、`{{status}}`、`{{moodValue}}`、`{{customRows}}`。其中 `{{customRows}}` 会自动渲染模型按「生成要求」给出的任意字段。',
    '',
    '- 支持在内容 HTML 中使用 `<img src="https://…" alt="">`；也支持站内路径与图片 Data URL。外链图床需允许浏览器直接访问，禁止脚本协议、事件属性与 `srcset`。',
    '',
    '## 可用的选择器',
    '',
    classRows.length ? mdTable(['选择器', '含义'], classRows) : '',
    '',
    '## 基础示例',
    '',
    '```css',
    basicExample,
    '```',
    '',
    '## 去掉“当前 / 往期”外围白色',
    '',
    '```css',
    tabsExample,
    '```',
    '',
  ].join('\n');
}
