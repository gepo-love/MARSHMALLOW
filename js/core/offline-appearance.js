import { get, put } from './db.js';
import { getInnerVoiceCard, normalizeInnerVoiceCard } from './chat/inner-voice-style.js';
import { scopeCssToPage } from './css-priority.js';

// 当前外观仍按用户档位保存；可复用的美化预设与线上聊天一致，属于全局资源库。

export const OFFLINE_STYLE_CHANGED_EVENT = 'marshmallow-offline-style-changed';
const OFFLINE_STYLE_SYNC_KEY = 'marshmallow-offline-style-sync';
export const OFFLINE_STYLE_PRESETS_KEY = 'offlineStylePresets';

export const OFFLINE_STYLE_DEFAULTS = Object.freeze({
  bg: 'white',
  font: 'serif',
  textColor: '',
  size: 16,
  leading: 1.9,
  measure: 'cozy',
  anchor: true,
  timelineNav: false,
  timelineNavConfigured: false,
  showReasoning: true,
  bgImage: '',
  veil: 0.86,
  css: '',
  darkCss: '',
  innerVoiceCardSource: 'chat',
  innerVoiceCardName: '',
  innerVoiceCard: null,
});

function styleKey(userId) {
  return `offlineStylePrefs_${String(userId || '').trim()}`;
}

function presetKey(userId) {
  return `offlineStylePresets_${String(userId || '').trim()}`;
}

function cleanCss(value) {
  return String(value == null ? '' : value)
    .replace(/<\/?\s*style[^>]*>/gi, '');
}

export function prepareOfflineStyleCss(value) {
  const text = cleanCss(value).trim();
  if (!text) return '';
  // 线下页真实根节点同时带 offline-page / offline-session-page，番外接入后也沿用这套外观。
  // 旧预设常以 .offline-page 开头；先统一为可跨线下与番外命中的共享根，避免作用域处理后
  // 变成永远匹配不到的 `.offline-session-page .offline-page`。
  const compatibleText = text.replace(/\.offline-page(?![\w-])/g, '.offline-session-page');
  const withoutLeadingComments = compatibleText.replace(/^(?:\s*\/\*[\s\S]*?\*\/)*/g, '').trimStart();
  const usesLegacyRootDeclarations = !withoutLeadingComments.includes('{')
    || /^&/u.test(withoutLeadingComments)
    || /^(?:--[\w-]+|[a-z-]+)\s*:[^;{}]+;/iu.test(withoutLeadingComments);
  if (usesLegacyRootDeclarations) {
    return `.offline-session-page {\n${compatibleText}\n}`;
  }
  return scopeCssToPage(compatibleText, ['.offline-session-page']);
}

function cleanHex(value) {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : '';
}

export function normalizeOfflineStylePrefs(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const timelineNavConfigured = src.timelineNavConfigured === true;
  const num = (value, min, max, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  return {
    bg: ['paper', 'white', 'dusk'].includes(src.bg) ? src.bg : OFFLINE_STYLE_DEFAULTS.bg,
    font: ['serif', 'sans'].includes(src.font) ? src.font : OFFLINE_STYLE_DEFAULTS.font,
    textColor: cleanHex(src.textColor),
    size: num(src.size, 14, 20, OFFLINE_STYLE_DEFAULTS.size),
    leading: num(src.leading, 1.5, 2.3, OFFLINE_STYLE_DEFAULTS.leading),
    measure: ['cozy', 'wide'].includes(src.measure) ? src.measure : OFFLINE_STYLE_DEFAULTS.measure,
    anchor: src.anchor !== false,
    // 旧版本曾把导航作为隐式默认开启；只有新面板明确配置过才沿用开启值。
    timelineNav: timelineNavConfigured && src.timelineNav === true,
    timelineNavConfigured,
    showReasoning: src.showReasoning !== false,
    bgImage: typeof src.bgImage === 'string' && src.bgImage.startsWith('data:image/') ? src.bgImage : '',
    veil: num(src.veil, 0.4, 0.96, OFFLINE_STYLE_DEFAULTS.veil),
    css: cleanCss(src.css),
    darkCss: cleanCss(src.darkCss),
    innerVoiceCardSource: src.innerVoiceCardSource === 'custom' ? 'custom' : 'chat',
    innerVoiceCardName: String(src.innerVoiceCardName || '').trim().slice(0, 40),
    innerVoiceCard: src.innerVoiceCardSource === 'custom'
      ? normalizeInnerVoiceCard(src.innerVoiceCard)
      : null,
  };
}

export function resolveOfflineInnerVoiceCard(prefs, chat, defaultTemplate = 'diary') {
  const normalized = normalizeOfflineStylePrefs(prefs);
  return normalized.innerVoiceCardSource === 'custom' && normalized.innerVoiceCard
    ? normalizeInnerVoiceCard(normalized.innerVoiceCard, defaultTemplate)
    : getInnerVoiceCard(chat, defaultTemplate);
}

export async function loadOfflineStylePrefs(userId) {
  const row = await get(styleKey(userId)).catch(() => null);
  return normalizeOfflineStylePrefs(row?.value || {});
}

function broadcastOfflineStyleChange(userId, prefs, reason = 'save') {
  const detail = {
    userId: String(userId || '').trim(),
    prefs: normalizeOfflineStylePrefs(prefs),
    reason: String(reason || 'save'),
    at: Date.now(),
  };
  if (!detail.userId) return;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(OFFLINE_STYLE_CHANGED_EVENT, { detail }));
  }
  try {
    // 跨标签页只发失效通知，避免把可能很大的底图 data URL 塞爆 localStorage。
    localStorage.setItem(OFFLINE_STYLE_SYNC_KEY, JSON.stringify({
      userId: detail.userId,
      reason: detail.reason,
      at: detail.at,
    }));
  } catch (_) {}
}

export function subscribeOfflineStyleChanges(userId, callback) {
  const expectedUserId = String(userId || '').trim();
  if (!expectedUserId || typeof window === 'undefined' || typeof callback !== 'function') {
    return () => {};
  }
  const deliver = (detail) => {
    if (String(detail?.userId || '').trim() !== expectedUserId) return;
    callback(normalizeOfflineStylePrefs(detail?.prefs || {}), {
      reason: String(detail?.reason || 'save'),
      at: Number(detail?.at || Date.now()),
    });
  };
  const onLocalChange = (event) => deliver(event.detail);
  const onStorage = async (event) => {
    if (event.key !== OFFLINE_STYLE_SYNC_KEY || !event.newValue) return;
    let detail;
    try {
      detail = JSON.parse(event.newValue);
    } catch (_) {
      return;
    }
    if (String(detail?.userId || '').trim() !== expectedUserId) return;
    try {
      const row = await get(styleKey(expectedUserId));
      deliver({ ...detail, prefs: row?.value || {} });
    } catch (err) {
      console.warn('[offline-appearance] cross-tab style sync failed', err);
    }
  };
  window.addEventListener(OFFLINE_STYLE_CHANGED_EVENT, onLocalChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(OFFLINE_STYLE_CHANGED_EVENT, onLocalChange);
    window.removeEventListener('storage', onStorage);
  };
}

export async function saveOfflineStylePrefs(userId, prefs, options = {}) {
  const normalized = normalizeOfflineStylePrefs(prefs);
  await put({ key: styleKey(userId), value: normalized });
  broadcastOfflineStyleChange(userId, normalized, options.reason);
  return normalized;
}

/** 只清线下自定义 CSS（保留底色/底图/字号等），供写坏布局后的急救入口使用 */
export async function clearOfflineStyleCss(userId) {
  const key = styleKey(userId);
  const row = await get(key);
  const prefs = normalizeOfflineStylePrefs(row?.value || {});
  const had = Boolean(String(prefs.css || '').trim() || String(prefs.darkCss || '').trim());
  const next = await saveOfflineStylePrefs(userId, { ...prefs, css: '', darkCss: '' }, { reason: 'clear-css' });
  const verifiedRow = await get(key);
  const verified = normalizeOfflineStylePrefs(verifiedRow?.value || {});
  if (String(verified.css || '').trim() || String(verified.darkCss || '').trim()) {
    throw new Error('写入后校验失败，CSS 仍未清空');
  }
  return { cleared: had, prefs: verified, verified: true };
}

function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const now = Date.now();
  const style = normalizeOfflineStylePrefs(raw.style || raw);
  const createdAt = Number(raw.createdAt);
  const updatedAt = Number(raw.updatedAt);
  return {
    id: String(raw.id || '').trim() || `osp_${now}_${Math.random().toString(36).slice(2, 7)}`,
    name: String(raw.name || '').trim().slice(0, 24) || '未命名预设',
    style,
    createdAt: Number.isFinite(createdAt) ? createdAt : now,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
  };
}

export function normalizeOfflineStylePresetList(raw) {
  const source = Array.isArray(raw) ? raw : (Array.isArray(raw?.presets) ? raw.presets : []);
  return source
    .map(normalizePreset)
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function mergeOfflineStylePresetLists(...sources) {
  const byId = new Map();
  for (const source of sources) {
    for (const preset of normalizeOfflineStylePresetList(source)) {
      const previous = byId.get(preset.id);
      if (!previous || preset.updatedAt >= previous.updatedAt) byId.set(preset.id, preset);
    }
  }
  return normalizeOfflineStylePresetList([...byId.values()]);
}

export async function listOfflineStylePresets(userId) {
  const legacyKey = presetKey(userId);
  const [sharedRow, legacyRow] = await Promise.all([
    get(OFFLINE_STYLE_PRESETS_KEY).catch(() => null),
    userId ? get(legacyKey).catch(() => null) : Promise.resolve(null),
  ]);
  const shared = normalizeOfflineStylePresetList(sharedRow?.value);
  const legacy = normalizeOfflineStylePresetList(legacyRow?.value);
  if (!legacy.length) return shared;

  // 旧版本把预设库绑在用户档位上。首次进入任一旧档位时并入全局库，随后留下迁移标记，
  // 避免用户从全局库删除预设后又被旧档位数据重新导入。
  const merged = mergeOfflineStylePresetLists(shared, legacy);
  await put({ key: OFFLINE_STYLE_PRESETS_KEY, value: { version: 2, presets: merged } });
  await put({ key: legacyKey, value: { version: 2, migratedTo: OFFLINE_STYLE_PRESETS_KEY } });
  return merged;
}

async function savePresetList(presets) {
  const normalized = normalizeOfflineStylePresetList(presets);
  await put({ key: OFFLINE_STYLE_PRESETS_KEY, value: { version: 2, presets: normalized } });
  return normalized;
}

export async function saveOfflineStylePreset(userId, name, style) {
  const label = String(name || '').trim().slice(0, 24);
  if (!label) throw new Error('请填写预设名称');
  const list = await listOfflineStylePresets(userId);
  const now = Date.now();
  const preset = normalizePreset({
    id: `osp_${now}_${Math.random().toString(36).slice(2, 7)}`,
    name: label,
    style,
    createdAt: now,
    updatedAt: now,
  });
  await savePresetList([preset, ...list]);
  return preset;
}

export async function deleteOfflineStylePreset(userId, presetId) {
  const id = String(presetId || '').trim();
  if (!id) return [];
  const list = await listOfflineStylePresets(userId);
  return savePresetList(list.filter((item) => item.id !== id));
}

export function offlineStylePresetToPrefs(preset) {
  return normalizeOfflineStylePrefs(preset?.style || preset || {});
}

export function parseOfflineStyleDocument(text, options = {}) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('文档里没有可导入的 CSS');
  const fileName = String(options.fileName || '').toLowerCase();
  const cssBlocks = [];
  const fenceRe = /```(?:css|scss)?\s*([\s\S]*?)```/gi;
  let match = fenceRe.exec(raw);
  while (match) {
    if (String(match[1] || '').trim()) cssBlocks.push(String(match[1]).trim());
    match = fenceRe.exec(raw);
  }
  if (cssBlocks.length) return cleanCss(cssBlocks.join('\n\n'));
  if (fileName.endsWith('.md') || /```/.test(raw)) {
    throw new Error('Markdown 文档里没有找到 CSS 代码块');
  }
  return cleanCss(raw);
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

export function buildOfflineAppearanceReferenceMarkdown() {
  const vars = [
    ['`--os-paper`', '页面纸面/卡片底色'],
    ['`--os-ink` / `--os-ink-2` / `--os-ink-3`', '主文字 / 次文字 / 弱文字'],
    ['`--os-accent` / `--os-accent-soft`', '强调色 / 浅强调底'],
    ['`--os-line`', '分隔线与描边'],
    ['`--os-body-ink`', '叙事正文颜色（也可直接用面板取色器）'],
    ['`--os-body-size`', '叙事正文字号（也可直接用面板滑块）'],
    ['`--os-leading`', '叙事正文行距（也可直接用面板滑块）'],
    ['`--os-measure`', '正文最大宽度（也可直接用面板选项）'],
  ];
  const selectors = [
    ['`.offline-session-page`, `.offline-scroll`', '线下沉浸页根节点 / 正文滚动区'],
    ['`.navbar`, `.navbar-btn`, `.navbar-title`', '顶栏、顶栏按钮与标题'],
    ['`.os-anchor`, `.os-anchor-mark`, `.os-anchor-text`', '地点、时间与同行者组成的时空锚'],
    ['`.offline-scene-card`, `.offline-scene-head`, `.offline-scene-body`', '场景摘要与展开编辑区'],
    ['`.offline-beats`, `.offline-beat`, `.offline-beat--narration`', '楼层列表、通用楼层、AI 叙事楼层'],
    ['`.offline-beat--opening`, `.offline-beat--directive`, `.offline-beat--interlude`', '开场、用户方向、手机插曲'],
    ['`.os-beat-footer`, `.os-beat-floor`, `.os-beat-menu`', '楼层底部信息、楼层号与操作入口'],
    ['`.os-beat-thoughts`, `.os-beat-thought`', '线下心声入口容器与角色心声按钮'],
    ['`.narration-translation`, `.narration-translate-btn`', '叙事译文与翻译按钮'],
    ['`.offline-options`, `.offline-option-chip`', '走向选项面板与单个选项'],
    ['`.offline-tools`, `.offline-tool`, `.offline-tool-state`', '加号展开的工具栏、工具按钮与状态字'],
    ['`.os-timeline-nav`, `.os-timeline-nav-button`', '普通线下右侧中下方的纵向楼层导航与四个定位按钮'],
    ['`.offline-bar`, `.offline-input-wrap`, `.offline-directive`', '底部输入区、输入外壳与文本框'],
    ['`.offline-plus`, `.offline-expand`, `.offline-advance`', '工具、展开输入与推进按钮'],
    ['`.os-manage-bar`, `.os-manage-btn`', '管理历史时的批量操作栏与按钮'],
    ['`.btn`, `.btn-primary`, `.btn-outline`, `.btn-soft`, `.btn-sm`', '通用按钮及其类型/尺寸'],
    ['`.form-input`, `.api-field`, `.api-field-label`', '输入框、字段容器与字段名'],
    ['`.offline-settings-sheet-panel`, `.os-settings-group`', '叙事设置弹层与折叠设置组'],
  ];
  return [
    '# 棉花糖机 · 线下沉浸页 CSS 契约',
    '',
    '> 本文提供真实选择器、变量与约束，不附带成品皮肤。请根据参考图独立设计。',
    '',
    '## 输出格式',
    '',
    '- 只输出 CSS，不输出 HTML、JavaScript、JSON 或教程说明。',
    '- 美化面板会自动把 CSS 限制在 `.offline-session-page` 内，因此文档中的选择器可直接书写。',
    '- 不隐藏推进、停止、返回等必要操作；装饰伪元素使用 `pointer-events:none`。',
    '- 保留移动端安全区、键盘焦点与 `prefers-reduced-motion`。',
    '- 选择器清单是结构地图，不是成品皮肤；不要从文档自行沿用配色、圆角、阴影或装饰。',
    '',
    '## 页面结构',
    '',
    '- 顶栏：`.offline-session-page > .navbar`。',
    '- 中段：`.offline-scroll` 内包含时空锚、场景卡与叙事楼层。',
    '- 底部三层按顺序是 `.offline-options`、`.offline-tools`、`.offline-bar`；前两层按交互动态显示。普通线下可在美化管理中开启右侧纵向 `.os-timeline-nav` 楼层导航。',
    '- 整页改造时统一设计这五个区域；用户只要求局部时，才收窄到对应区域。',
    '- 不覆盖顶栏与底部三层现有的 `position` / `top` / `bottom` / `inset`，不覆盖 `[hidden]` 的显示逻辑。',
    '',
    '## 可用变量',
    '',
    mdTable(['变量', '含义'], vars),
    '',
    '## 可用选择器',
    '',
    mdTable(['选择器', '含义'], selectors),
    '',
    '## 心声样式分工',
    '',
    '- `.os-beat-thought` 是楼层下方的线下心声入口，可在本页 CSS 中直接美化。',
    '- 点开后的 `#char-state-popover` 不属于 `.offline-session-page`；它由美化面板里的「心声方案」单独控制，可沿用关联会话或复用已有方案。',
    '',
    '## 交付前检查',
    '',
    '- 输入框仍可输入，推进/停止/返回/楼层菜单仍可点击。',
    '- 底图和蒙版由美化面板管理，CSS 不写虚构的本地资源地址。',
    '- 暮色、纯白、暖纸三种底色下文字均保持可读。',
    '',
  ].join('\n');
}
