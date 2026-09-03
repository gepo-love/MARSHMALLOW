import { get as dbGet, put as dbPut } from './db.js';
import { sanitizeWidgetHtml } from './custom-widget.js';

const STORE_KEY = 'htmlExtensions';
const VALID_TARGETS = new Set(['chat', 'offline']);
const MAX_ITEMS = 80;
const MAX_PROMPT_LEN = 2000;
const MAX_CUSTOM_FIELDS = 60;
const MAX_CUSTOM_FIELD_KEY_LEN = 80;
const MAX_CUSTOM_FIELD_VALUE_LEN = 12000;
const SAFE_HTML_TAGS = new Set([
  'style', 'div', 'span', 'p', 'small', 'strong', 'em', 'b', 'i', 'u', 'br', 'hr',
  'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4',
  'ul', 'ol', 'li', 'details', 'summary', 'button', 'a', 'img',
]);
const SAFE_CSS_PROPERTIES = new Set([
  'color', 'background', 'background-color', 'background-image', 'background-size', 'background-position',
  'border', 'border-color', 'border-style', 'border-width', 'border-radius',
  'border-top', 'border-right', 'border-bottom', 'border-left',
  'box-shadow', 'box-sizing', 'display', 'gap', 'row-gap', 'column-gap',
  'grid', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'align-items', 'align-content', 'align-self', 'justify-content', 'justify-items', 'justify-self',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'aspect-ratio',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'font', 'font-family', 'font-size', 'font-style', 'font-weight', 'line-height', 'letter-spacing',
  'text-align', 'text-decoration', 'text-transform', 'text-overflow', 'white-space', 'word-break',
  'overflow', 'overflow-x', 'overflow-y', 'opacity', 'transform', 'transform-origin',
  'transition', 'transition-property', 'transition-duration', 'transition-timing-function',
  'cursor', 'list-style', 'list-style-type', 'object-fit', 'object-position', 'visibility',
]);

export const OFFLINE_HTML_EXTENSIONS_START = '<<<OFFLINE_HTML_EXTENSIONS>>>';
export const OFFLINE_HTML_EXTENSIONS_END = '<<<END_OFFLINE_HTML_EXTENSIONS>>>';
export const DEFAULT_HTML_EXTENSION_TEMPLATE = `<style>
.mini{font:14px/1.65 system-ui,sans-serif;color:#2d3135;background:#fff;border:1px solid #e7e8ea;border-radius:14px;padding:12px}
.mini summary{cursor:pointer;font-weight:650;list-style:none}
.mini summary::-webkit-details-marker{display:none}
.mini .body{padding-top:9px;white-space:pre-wrap}
</style>
<details class="mini">
  <summary>{{title}}</summary>
  <div class="body">{{content}}</div>
</details>`;

function clean(value = '') {
  return String(value ?? '').trim();
}

function clip(value, max) {
  return clean(value).slice(0, max);
}

function genId() {
  return `hex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeKeywords(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || '').split(/[\n,，、]+/);
  return [...new Set(list.map((item) => clip(item, 60)).filter(Boolean))].slice(0, 30);
}

function normalizeTargets(value) {
  const targets = (Array.isArray(value) ? value : [value])
    .map((item) => clean(item))
    .filter((item) => VALID_TARGETS.has(item));
  return targets.length ? [...new Set(targets)] : ['chat'];
}

function normalizeTriggerMode(value = '') {
  if (value === 'required') return 'required';
  if (value === 'always') return 'always';
  return 'keywords';
}

function displayFieldValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, MAX_CUSTOM_FIELD_VALUE_LEN);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value).slice(0, MAX_CUSTOM_FIELD_VALUE_LEN);
  } catch (_) {
    return String(value).slice(0, MAX_CUSTOM_FIELD_VALUE_LEN);
  }
}

export function normalizeHtmlExtensionFields(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const fields = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, MAX_CUSTOM_FIELDS)) {
    const key = clean(rawKey).slice(0, MAX_CUSTOM_FIELD_KEY_LEN);
    if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    fields[key] = displayFieldValue(rawValue);
  }
  return fields;
}

export function htmlExtensionTemplateFields(templateHtml = '') {
  const fields = [];
  const seen = new Set();
  String(templateHtml || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, rawKey) => {
    const key = clean(rawKey).slice(0, MAX_CUSTOM_FIELD_KEY_LEN);
    if (key && !seen.has(key)) {
      seen.add(key);
      fields.push(key);
    }
    return _;
  });
  return fields.slice(0, MAX_CUSTOM_FIELDS);
}

function sanitizeCssDeclarations(cssText = '') {
  return String(cssText || '').split(';').map((entry) => {
    const splitAt = entry.indexOf(':');
    if (splitAt < 1) return '';
    const property = entry.slice(0, splitAt).trim().toLowerCase();
    let value = entry.slice(splitAt + 1).trim();
    if ((!SAFE_CSS_PROPERTIES.has(property) && !property.startsWith('--')) || !value) return '';
    value = value
      .replace(/url\s*\([^)]*\)/gi, 'none')
      .replace(/(?:expression|javascript|vbscript|data)\s*[:(]/gi, '');
    return value ? `${property}:${value}` : '';
  }).filter(Boolean).join(';');
}

export function sanitizeHtmlExtensionCss(cssText = '') {
  const source = String(cssText || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/@font-face\s*\{[\s\S]*?\}/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none');
  return source.replace(/\{([^{}]*)\}/g, (_, declarations) => {
    const safe = sanitizeCssDeclarations(declarations);
    return safe ? `{${safe}}` : '{}';
  });
}

export function sanitizeHtmlExtensionTemplate(templateHtml = '') {
  const raw = String(templateHtml || '');
  if (typeof document === 'undefined') return raw;
  // 用户经常直接粘贴完整 HTML 文档。DOMParser 会把其中的 <head>/<style>
  // 移出 body；若直接取 body.innerHTML，样式会在保存预览时无声消失。
  let renderSource = raw;
  if (/<(?:html|head|body)\b/i.test(raw)) {
    try {
      const sourceDocument = new DOMParser().parseFromString(raw, 'text/html');
      const headStyles = [...sourceDocument.head.querySelectorAll('style')]
        .map((style) => style.outerHTML)
        .join('');
      renderSource = `${headStyles}${sourceDocument.body.innerHTML}`;
    } catch (_) {
      renderSource = raw;
    }
  }
  const firstPass = sanitizeWidgetHtml(renderSource);
  let doc;
  try {
    doc = new DOMParser().parseFromString(`<body>${firstPass}</body>`, 'text/html');
  } catch (_) {
    return '';
  }
  const body = doc.body;
  if (!body) return '';
  body.querySelectorAll('*').forEach((element) => {
    const tag = String(element.tagName || '').toLowerCase();
    if (!SAFE_HTML_TAGS.has(tag)) {
      element.replaceWith(...element.childNodes);
      return;
    }
    Array.from(element.attributes).forEach((attribute) => {
      const name = String(attribute.name || '').toLowerCase();
      const allowed = name === 'class'
        || name === 'id'
        || name === 'title'
        || name === 'alt'
        || name === 'hidden'
        || name === 'role'
        || name === 'href'
        || name === 'src'
        || name === 'target'
        || name === 'style'
        || name.startsWith('aria-')
        || ['data-action', 'data-target', 'data-title', 'data-content', 'data-url'].includes(name);
      if (!allowed) {
        element.removeAttribute(attribute.name);
      } else if (name === 'style') {
        const safeStyle = sanitizeCssDeclarations(attribute.value);
        if (safeStyle) element.setAttribute('style', safeStyle);
        else element.removeAttribute('style');
      }
    });
  });
  body.querySelectorAll('style').forEach((style) => {
    style.textContent = sanitizeHtmlExtensionCss(style.textContent || '');
  });
  return body.innerHTML;
}

export function normalizeHtmlExtension(input = {}) {
  const rawTemplate = String(
    input.sourceTemplateHtml
    ?? input.templateHtml
    ?? input.html
    ?? DEFAULT_HTML_EXTENSION_TEMPLATE,
  ) || DEFAULT_HTML_EXTENSION_TEMPLATE;
  const templateHtml = typeof document === 'undefined'
    ? rawTemplate
    : (sanitizeHtmlExtensionTemplate(rawTemplate) || DEFAULT_HTML_EXTENSION_TEMPLATE);
  return {
    id: clean(input.id) || genId(),
    name: clip(input.name || '未命名组件', 50) || '未命名组件',
    enabled: input.enabled !== false,
    targets: normalizeTargets(input.targets),
    triggerMode: normalizeTriggerMode(input.triggerMode),
    keywords: normalizeKeywords(input.keywords),
    prompt: clip(input.prompt, MAX_PROMPT_LEN),
    // 编辑源码与运行模板分开保存：源码不按长度裁切，也不因安全净化静默丢失；
    // 真正注水时只使用上方生成的 templateHtml 安全版本。
    sourceTemplateHtml: rawTemplate,
    templateHtml,
    createdAt: Number(input.createdAt || Date.now()) || Date.now(),
    updatedAt: Number(input.updatedAt || Date.now()) || Date.now(),
  };
}

export async function listHtmlExtensions() {
  const row = await dbGet(STORE_KEY).catch(() => null);
  const list = Array.isArray(row?.value) ? row.value : [];
  return list.map(normalizeHtmlExtension).slice(0, MAX_ITEMS);
}

export async function saveHtmlExtensions(items = []) {
  const next = (Array.isArray(items) ? items : [])
    .slice(0, MAX_ITEMS)
    .map((item) => normalizeHtmlExtension(item));
  await dbPut({ key: STORE_KEY, value: next });
  return next;
}

export async function upsertHtmlExtension(input = {}) {
  const item = normalizeHtmlExtension({ ...input, updatedAt: Date.now() });
  const list = await listHtmlExtensions();
  const index = list.findIndex((row) => row.id === item.id);
  if (index >= 0) list[index] = item;
  else list.unshift(item);
  await saveHtmlExtensions(list);
  return item;
}

export async function deleteHtmlExtension(id = '') {
  const target = clean(id);
  const list = (await listHtmlExtensions()).filter((item) => item.id !== target);
  await saveHtmlExtensions(list);
  return list;
}

export function buildHtmlExtensionsExport(items = []) {
  return {
    format: 'marshmallow-html-extensions',
    version: 1,
    exportedAt: new Date().toISOString(),
    items: (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS).map((item) => {
      const normalized = normalizeHtmlExtension(item);
      return {
        id: normalized.id,
        name: normalized.name,
        enabled: normalized.enabled,
        targets: normalized.targets,
        triggerMode: normalized.triggerMode,
        keywords: normalized.keywords,
        prompt: normalized.prompt,
        sourceTemplateHtml: normalized.sourceTemplateHtml,
        templateHtml: normalized.templateHtml,
        createdAt: normalized.createdAt,
        updatedAt: normalized.updatedAt,
      };
    }),
  };
}

export function parseHtmlExtensionsImport(raw = '') {
  let payload;
  try {
    payload = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  } catch (_) {
    throw new Error('文件不是有效的 JSON');
  }
  const candidates = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.items) ? payload.items : [payload]);
  const valid = candidates.filter((item) => item
    && typeof item === 'object'
    && !Array.isArray(item)
    && (typeof item.sourceTemplateHtml === 'string'
      || typeof item.templateHtml === 'string'
      || typeof item.html === 'string'));
  if (!valid.length) throw new Error('文件中没有可导入的 HTML 组件');
  return valid.slice(0, MAX_ITEMS).map((item) => normalizeHtmlExtension(item));
}

export function matchHtmlExtension(item = {}, queryText = '', surface = 'chat') {
  const normalized = normalizeHtmlExtension(item);
  if (!normalized.enabled || !normalized.targets.includes(surface)) return false;
  if (normalized.triggerMode === 'always' || normalized.triggerMode === 'required') return true;
  const haystack = String(queryText || '').toLocaleLowerCase();
  if (!haystack || !normalized.keywords.length) return false;
  return normalized.keywords.some((keyword) => haystack.includes(keyword.toLocaleLowerCase()));
}

export async function resolveTriggeredHtmlExtensions(queryText = '', surface = 'chat') {
  const list = await listHtmlExtensions();
  return list.filter((item) => matchHtmlExtension(item, queryText, surface));
}

export function buildHtmlExtensionPromptBlock(items = [], options = {}) {
  const list = (Array.isArray(items) ? items : []).map(normalizeHtmlExtension);
  if (!list.length) return '';
  const offline = options.surface === 'offline';
  const rows = list.map((item) => [
    `- id=${item.id}；名称=${item.name}；${item.triggerMode === 'required' ? '【每轮必须输出】' : '按内容判断是否输出'}`,
    `；模板字段=${JSON.stringify(htmlExtensionTemplateFields(item.templateHtml).filter((key) => key !== 'name'))}`,
    item.prompt ? `；触发后内容要求：${item.prompt}` : '',
  ].join(''));
  const requiredIds = list.filter((item) => item.triggerMode === 'required').map((item) => item.id);
  return [
    '[本轮可用扩展组件]',
    requiredIds.length
      ? `id=${requiredIds.join('、')} 是用户明确设置的“每轮输出”组件，本轮无论正文内容为何都必须各输出一次；不得自行省略。其余组件只有内容确实适合时才输出。`
      : '这些组件已由用户设置的关键词命中；只有本轮内容确实适合时才输出，普通对话不必强行使用。',
    'AI 只填写纯文本数据，绝不能输出 HTML、CSS、脚本或事件属性；视觉模板由客户端安全渲染。除 name 由客户端填写角色名外，模板字段必须放进 fields 对象，字段名与模板占位符完全一致；允许字符串、数值、布尔值、数组或对象。',
    ...rows,
    offline
      ? `使用时在所有可见叙事正文之后追加：\n${OFFLINE_HTML_EXTENSIONS_START}\n{"id":"上方某个 id","fields":{"title":"简短标题","content":"组件正文","模板里的其它字段":"对应值"}}\n${OFFLINE_HTML_EXTENSIONS_END}`
      : '使用时输出棉花糖事件：{"t":"html_widget","from":"角色 id","id":"上方某个 id","fields":{"title":"简短标题","content":"组件正文","模板里的其它字段":"对应值"}}。组件内容不要再重复写进 msg.body。',
    `每个 id 本轮最多使用一次。${requiredIds.length ? `结束前核对必须存在这些 id：${requiredIds.join('、')}。` : '不适合使用时不要输出空组件。'}`,
  ].join('\n');
}

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createHtmlExtensionSnapshot(item = {}, payload = {}) {
  const normalized = normalizeHtmlExtension(item);
  const customFields = normalizeHtmlExtensionFields(payload.fields || payload.data);
  const reservedKeys = new Set(['id', 'extensionId', 't', 'type', 'from', 'senderName', 'templateName', 'characterName', 'name', 'fields', 'data']);
  const topLevelFields = normalizeHtmlExtensionFields(Object.fromEntries(
    Object.entries(payload || {}).filter(([key]) => !reservedKeys.has(key)),
  ));
  const fields = { ...topLevelFields, ...customFields };
  const title = clip(fields.title || payload.title || normalized.name, 120) || normalized.name;
  const content = clean(fields.content || payload.content || payload.body || payload.text);
  const requiredTemplateFields = htmlExtensionTemplateFields(normalized.templateHtml).filter((key) => key !== 'name');
  const hasTemplateValue = requiredTemplateFields.some((key) => clean(fields[key]));
  if (!content && !hasTemplateValue) return null;
  const actorName = clip(payload.templateName || payload.senderName || payload.characterName || payload.name, 50);
  return {
    extensionId: normalized.id,
    name: actorName || normalized.name,
    componentName: normalized.name,
    title,
    content,
    fields: { ...fields, title, content },
    templateHtml: normalized.templateHtml,
  };
}

export function renderHtmlExtensionSnapshot(snapshot = {}) {
  const template = sanitizeHtmlExtensionTemplate(
    String(snapshot.templateHtml || DEFAULT_HTML_EXTENSION_TEMPLATE),
  );
  const values = {
    ...normalizeHtmlExtensionFields(snapshot.fields),
    title: clip(snapshot.title || snapshot.name || '展开查看', 120),
    content: clean(snapshot.content),
    name: clip(snapshot.name, 50),
  };
  Object.keys(values).forEach((key) => { values[key] = esc(values[key]); });
  const filled = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, rawKey) => {
    const key = clean(rawKey);
    return values[key] || values[key.toLowerCase()] || '';
  });
  return sanitizeHtmlExtensionTemplate(filled);
}

function parseJsonLine(line = '') {
  const text = clean(line).replace(/,\s*$/, '');
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function extractOfflineHtmlExtensions(rawText = '', matchedItems = [], values = {}) {
  const raw = String(rawText || '');
  const start = raw.indexOf(OFFLINE_HTML_EXTENSIONS_START);
  if (start < 0) return { body: raw, widgets: [], found: false };
  const contentStart = start + OFFLINE_HTML_EXTENSIONS_START.length;
  const end = raw.indexOf(OFFLINE_HTML_EXTENSIONS_END, contentStart);
  const block = end >= 0 ? raw.slice(contentStart, end) : raw.slice(contentStart);
  const body = `${raw.slice(0, start)}${end >= 0 ? raw.slice(end + OFFLINE_HTML_EXTENSIONS_END.length) : ''}`.trim();
  const byId = new Map((Array.isArray(matchedItems) ? matchedItems : [])
    .map(normalizeHtmlExtension)
    .map((item) => [item.id, item]));
  const used = new Set();
  const widgets = [];
  for (const payload of parseStateItemsCompat(block)) {
    const id = clean(payload?.id || payload?.extensionId);
    const item = byId.get(id);
    if (!item || used.has(id)) continue;
    const snapshot = createHtmlExtensionSnapshot(item, { ...payload, ...values });
    if (!snapshot) continue;
    used.add(id);
    widgets.push(snapshot);
  }
  return { body, widgets, found: true };
}

function parseStateItemsCompat(block = '') {
  const text = clean(block);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((item) => item && typeof item === 'object');
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch (_) {}
  return text.split(/\r?\n/).map(parseJsonLine).filter(Boolean);
}

const HOST_CSS = ':host{display:block;width:100%;box-sizing:border-box;}';
const DIALOG_CSS = `
:host{all:initial;font-family:system-ui,-apple-system,sans-serif;color:var(--text,#202124)}
.dialog{width:min(82vw,360px);max-width:min(88vw,520px);max-height:min(76vh,620px);box-sizing:border-box;padding:18px;border-radius:16px;background:var(--surface,#fff);box-shadow:0 18px 54px rgba(20,30,36,.2);overflow:auto}
.head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}
.head strong{font-size:16px}.close{border:0;background:transparent;font:22px/1 system-ui;cursor:pointer}
.body{font-size:14px;line-height:1.7;white-space:pre-wrap}
`;
const hydratedActionRoots = new WeakSet();

function openExtensionDialog(title = '', content = '') {
  if (typeof document === 'undefined') return;
  const dialog = document.createElement('dialog');
  dialog.className = 'html-extension-dialog';
  dialog.setAttribute('aria-label', clean(title || '展开内容'));
  Object.assign(dialog.style, {
    position: 'fixed',
    inset: '0',
    margin: 'auto',
    padding: '0',
    border: '0',
    width: 'fit-content',
    maxWidth: 'none',
    maxHeight: 'none',
    background: 'transparent',
    color: 'inherit',
  });
  const host = document.createElement('div');
  const shadow = host.attachShadow?.({ mode: 'closed' });
  const safeTitle = esc(clip(title || '展开内容', 120));
  const safeContent = esc(clean(content));
  const html = `<style>${DIALOG_CSS}</style><section class="dialog"><header class="head"><strong>${safeTitle}</strong><button type="button" class="close" aria-label="关闭">×</button></header><div class="body">${safeContent}</div></section>`;
  if (shadow) shadow.innerHTML = html;
  else host.textContent = `${title}\n${content}`;
  dialog.appendChild(host);
  document.body.appendChild(dialog);
  const close = () => {
    try { dialog.close(); } catch (_) { /* already closed */ }
    dialog.remove();
  };
  shadow?.querySelector('.close')?.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function bindExtensionHostActions(shadow, options = {}) {
  if (!shadow || hydratedActionRoots.has(shadow)) return;
  hydratedActionRoots.add(shadow);
  shadow.addEventListener('click', (event) => {
    const source = event.target instanceof Element
      ? event.target.closest('a,button,[data-action]')
      : null;
    if (!source) return;
    const action = clean(source.getAttribute('data-action')).toLowerCase();
    if (action === 'toggle') {
      event.preventDefault();
      const selector = clean(source.getAttribute('data-target'));
      if (!selector) return;
      let target;
      try { target = shadow.querySelector(selector); } catch (_) { target = null; }
      if (!target) return;
      target.hidden = !target.hidden;
      source.setAttribute('aria-expanded', target.hidden ? 'false' : 'true');
      return;
    }
    if (action === 'dialog') {
      event.preventDefault();
      openExtensionDialog(
        source.getAttribute('data-title') || source.textContent || '展开内容',
        source.getAttribute('data-content') || '',
      );
      return;
    }
    if (action === 'link' || source.tagName === 'A') {
      const url = clean(source.getAttribute('data-url') || source.getAttribute('href'));
      if (!/^(?:https?:|mailto:|tel:)/i.test(url)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      if (typeof options.onOpenLink === 'function') {
        options.onOpenLink(url, {
          title: clean(source.getAttribute('data-title') || source.textContent || '链接预览'),
        });
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    }
  });
}

export function hydrateHtmlExtensionHosts(root, snapshotsByKey = {}, options = {}) {
  if (!root?.querySelectorAll || typeof document === 'undefined') return;
  root.querySelectorAll('[data-html-extension-host]').forEach((host) => {
    const key = String(host.getAttribute('data-html-extension-host') || '');
    const snapshot = snapshotsByKey[key];
    if (!snapshot) return;
    let shadow = host.shadowRoot;
    if (!shadow) {
      try {
        shadow = host.attachShadow({ mode: 'open' });
      } catch (_) {
        shadow = null;
      }
    }
    const html = renderHtmlExtensionSnapshot(snapshot);
    if (shadow) {
      shadow.innerHTML = `<style>${HOST_CSS}</style>${html}`;
      bindExtensionHostActions(shadow, options);
    } else {
      // 老旧 WebView 无 Shadow DOM 时宁可退化成纯文本，也不把用户模板注入主页面。
      host.textContent = `${snapshot.title || snapshot.name || '组件'}\n${snapshot.content || ''}`.trim();
    }
  });
}
export function openHtmlExtensionSnapshotDialog(snapshot = {}, options = {}) {
  if (typeof document === 'undefined' || !snapshot || typeof snapshot !== 'object') return null;
  const overlay = document.createElement('div');
  overlay.className = 'html-extension-preview-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', clean(snapshot.title || snapshot.name || 'HTML 小卡片'));
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '10020',
    display: 'grid',
    placeItems: 'center',
    padding: 'max(18px, env(safe-area-inset-top)) 16px max(18px, env(safe-area-inset-bottom))',
    background: 'rgba(17, 24, 28, .48)',
  });
  const sheet = document.createElement('section');
  Object.assign(sheet.style, {
    width: 'min(92vw, 560px)',
    maxHeight: '86vh',
    overflow: 'auto',
    border: '1px solid rgba(255,255,255,.55)',
    borderRadius: '20px',
    background: 'var(--surface-card, #fff)',
    boxShadow: '0 24px 70px rgba(12, 20, 24, .24)',
  });
  const header = document.createElement('header');
  Object.assign(header.style, {
    position: 'sticky',
    top: '0',
    zIndex: '1',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '12px 14px',
    borderBottom: '1px solid rgba(31,32,34,.08)',
    background: 'var(--surface-card, #fff)',
  });
  const title = document.createElement('strong');
  title.textContent = clean(snapshot.title || snapshot.name || 'HTML 小卡片');
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', '关闭');
  Object.assign(closeButton.style, {
    width: '34px',
    height: '34px',
    border: '0',
    borderRadius: '50%',
    background: 'rgba(31,32,34,.06)',
    color: 'inherit',
    font: '22px/1 system-ui',
    cursor: 'pointer',
  });
  const body = document.createElement('div');
  body.style.padding = '16px';
  const host = document.createElement('div');
  host.setAttribute('data-html-extension-host', 'preview');
  body.appendChild(host);
  header.append(title, closeButton);
  sheet.append(header, body);
  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
  hydrateHtmlExtensionHosts(sheet, { preview: snapshot }, options);
  const close = () => {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape') close();
  };
  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeydown);
  closeButton.focus();
  return { close, overlay };
}
