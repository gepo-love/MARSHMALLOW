import { get, put } from './db.js';
import { scopeCssToPage } from './css-priority.js';

export const OFFLINE_AUDIO_STYLE_CHANGED_EVENT = 'marshmallow-offline-audio-style-changed';
const OFFLINE_AUDIO_STYLE_SYNC_KEY = 'marshmallow-offline-audio-style-sync';

export const OFFLINE_AUDIO_STYLE_DEFAULTS = Object.freeze({
  theme: 'auto',
  font: 'serif',
  fontFamily: '',
  textColor: '',
  mutedColor: '',
  accentColor: '',
  size: 17,
  leading: 1.72,
  paperOpacity: 0.92,
  css: '',
});

function styleKey(userId) {
  return `offlineAudioStylePrefs_${String(userId || '').trim()}`;
}

function cleanCss(value) {
  return String(value == null ? '' : value).replace(/<\/?\s*style[^>]*>/gi, '');
}

function cleanHex(value) {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : '';
}

function cleanFontFamily(value) {
  return String(value || '')
    .replace(/[;{}<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function normalizeOfflineAudioStylePrefs(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (value, min, max, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  return {
    theme: ['auto', 'day', 'night'].includes(src.theme) ? src.theme : OFFLINE_AUDIO_STYLE_DEFAULTS.theme,
    font: ['serif', 'sans', 'rounded', 'custom'].includes(src.font) ? src.font : OFFLINE_AUDIO_STYLE_DEFAULTS.font,
    fontFamily: cleanFontFamily(src.fontFamily),
    textColor: cleanHex(src.textColor),
    mutedColor: cleanHex(src.mutedColor),
    accentColor: cleanHex(src.accentColor),
    size: num(src.size, 14, 22, OFFLINE_AUDIO_STYLE_DEFAULTS.size),
    leading: num(src.leading, 1.4, 2.3, OFFLINE_AUDIO_STYLE_DEFAULTS.leading),
    paperOpacity: num(src.paperOpacity, 0.68, 1, OFFLINE_AUDIO_STYLE_DEFAULTS.paperOpacity),
    css: cleanCss(src.css),
  };
}

export function prepareOfflineAudioStyleCss(value) {
  const text = cleanCss(value).trim();
  if (!text) return '';
  const withoutLeadingComments = text.replace(/^(?:\s*\/\*[\s\S]*?\*\/)*/g, '').trimStart();
  const usesRootDeclarations = !withoutLeadingComments.includes('{')
    || /^&/u.test(withoutLeadingComments)
    || /^(?:--[\w-]+|[a-z-]+)\s*:[^;{}]+;/iu.test(withoutLeadingComments);
  if (usesRootDeclarations) {
    return `.offline-session-page.offline-audio-scene {\n${text}\n}`;
  }
  return scopeCssToPage(text, ['.offline-session-page.offline-audio-scene']);
}

export async function loadOfflineAudioStylePrefs(userId) {
  const row = await get(styleKey(userId)).catch(() => null);
  return normalizeOfflineAudioStylePrefs(row?.value || {});
}

function broadcastOfflineAudioStyleChange(userId, prefs, reason = 'save') {
  const detail = {
    userId: String(userId || '').trim(),
    prefs: normalizeOfflineAudioStylePrefs(prefs),
    reason: String(reason || 'save'),
    at: Date.now(),
  };
  if (!detail.userId) return;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(OFFLINE_AUDIO_STYLE_CHANGED_EVENT, { detail }));
  }
  try {
    localStorage.setItem(OFFLINE_AUDIO_STYLE_SYNC_KEY, JSON.stringify({
      userId: detail.userId,
      reason: detail.reason,
      at: detail.at,
    }));
  } catch (_) {}
}

export function subscribeOfflineAudioStyleChanges(userId, callback) {
  const expectedUserId = String(userId || '').trim();
  if (!expectedUserId || typeof window === 'undefined' || typeof callback !== 'function') return () => {};
  const deliver = (detail) => {
    if (String(detail?.userId || '').trim() !== expectedUserId) return;
    callback(normalizeOfflineAudioStylePrefs(detail?.prefs || {}), {
      reason: String(detail?.reason || 'save'),
      at: Number(detail?.at || Date.now()),
    });
  };
  const onLocalChange = (event) => deliver(event.detail);
  const onStorage = async (event) => {
    if (event.key !== OFFLINE_AUDIO_STYLE_SYNC_KEY || !event.newValue) return;
    let detail;
    try {
      detail = JSON.parse(event.newValue);
    } catch (_) {
      return;
    }
    if (String(detail?.userId || '').trim() !== expectedUserId) return;
    const row = await get(styleKey(expectedUserId)).catch(() => null);
    deliver({ ...detail, prefs: row?.value || {} });
  };
  window.addEventListener(OFFLINE_AUDIO_STYLE_CHANGED_EVENT, onLocalChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(OFFLINE_AUDIO_STYLE_CHANGED_EVENT, onLocalChange);
    window.removeEventListener('storage', onStorage);
  };
}

export async function saveOfflineAudioStylePrefs(userId, prefs, options = {}) {
  const normalized = normalizeOfflineAudioStylePrefs(prefs);
  await put({ key: styleKey(userId), value: normalized });
  broadcastOfflineAudioStyleChange(userId, normalized, options.reason);
  return normalized;
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

export function buildOfflineAudioAppearanceReferenceMarkdown() {
  const vars = [
    ['`--oas-paper` / `--oas-paper-opacity`', '底部字幕纸与透明度'],
    ['`--oas-ink` / `--oas-muted`', '对白主文字与次要文字'],
    ['`--oas-accent`', '角色名、选项编号和主操作强调色'],
    ['`--oas-line`', '字幕纸、输入框和菜单分隔线'],
    ['`--oas-font-family`', '旁白、对白、角色名和选项字体栈'],
    ['`--oas-font-size` / `--oas-leading`', '当前段正文的字号与行距'],
    ['`--oas-choice` / `--oas-panel` / `--oas-field`', '选项纸签、菜单/输入面板和输入框底色'],
  ];
  const selectors = [
    ['`.offline-session-page.offline-audio-scene`', '音声舞台根节点'],
    ['`.offline-audio-navbar`', '舞台顶栏'],
    ['`.offline-audio-stage`, `.offline-audio-stage-shade`', '场景图区域与画面遮罩'],
    ['`.offline-audio-dialogue`, `.offline-audio-dialogue-copy`', '底部字幕纸与当前段正文'],
    ['`.offline-audio-nameplate`, `.offline-audio-progress`', '角色名/旁白名与段落进度'],
    ['`.offline-audio-dialogue-actions`, `.offline-audio-dialogue-nav`', '自动、写回应、重听和下一段控制行'],
    ['`.offline-audio-choices`, `.offline-option-chip`', '对白选择层与选项纸签'],
    ['`.offline-audio-input`, `.offline-directive`', '自由回应面板与输入框'],
    ['`.offline-audio-menu`', '右上角舞台菜单'],
    ['`[data-oas-theme="day|night|auto"]`', '日间、夜间或跟随应用主题状态'],
  ];
  return [
    '# 棉花糖机 · 音声舞台 CSS 契约',
    '',
    '> 本文只描述音声线下舞台，不适用于普通线下长卷。',
    '',
    '## 输出要求',
    '',
    '- 只输出 CSS，不输出 HTML、JavaScript 或 JSON。',
    '- 面板会自动把 CSS 限制在 `.offline-session-page.offline-audio-scene` 内。',
    '- 不隐藏返回、自动播放、重听、下一段、写回应和发送等必要操作。',
    '- 不覆盖 `[hidden]` 的显示规则，不使用 `position:fixed`，保留安全区与横屏布局。',
    '- 夜间方案同时检查字幕纸、选项、菜单、输入框和焦点轮廓的对比度。',
    '',
    '## 可用变量',
    '',
    mdTable(['变量', '含义'], vars),
    '',
    '## 可用选择器',
    '',
    mdTable(['选择器', '含义'], selectors),
    '',
    '## 交付前检查',
    '',
    '- 320px 宽度和横屏低高度下无文字或按钮遮挡。',
    '- 日间与夜间模式都能读清旁白、对白、角色名、进度和占位文字。',
    '- 开启自动播放、弹出选项、打开自由输入和舞台菜单时均可正常操作。',
    '',
  ].join('\n');
}
