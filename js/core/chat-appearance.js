/**
 * 会话级消息界面美化（角色独立）
 * - 数据落在 chat.groupSettings：customCss / userBubbleCss / charBubbleCss /
 *   wallpaperOpacity / bubbleSelf / bubbleOther …
 * - customCss：整页（顶栏/输入区等）；userBubbleCss / charBubbleCss：我方/对方气泡，注入时排在最后以便盖过主题
 * - 美化预设是全局资源库；每个 user 可在「本身份装扮」保存自己的默认选择快照
 * - CSS 直接以纯文本导入/导出；此外提供格式参考文档，以及向页面注入本会话 CSS 的运行时方法
 */
import { get, put, getRecord } from './db.js';
import {
  appendChatChromeSafeAreaGuards,
  boostCssPriority,
  expandAnonymousBubbleCompatibility,
  expandChatAppearanceRootSelectors,
  mapCssRuleSelectors,
  needsChatComposerFlowGuard,
  needsChatComposerSafePadding,
  needsChatNavbarSafeMargin,
  prepareChatVisualCssPriority,
  scopeCssToPage,
} from './css-priority.js';
import { clampChatBubbleFontSize } from './appearance-prefs.js';

export {
  expandAnonymousBubbleCompatibility,
  expandChatAppearanceRootSelectors,
  needsChatComposerFlowGuard,
  needsChatComposerSafePadding,
  needsChatNavbarSafeMargin,
};
import { CHAT_APPEARANCE_CLASSES, CHAT_APPEARANCE_VARS } from '../data/appearance-theme-contract.js';
import { BUILTIN_CHAT_APPEARANCE_PRESETS } from '../data/builtin-chat-css.js';
import { getChat, listChatsForUser, saveChat } from './chat-store.js';

const CHAT_APPEARANCE_PRESETS_KEY = 'chatAppearancePresets';
export const DEFAULT_WALLPAPER_OPACITY = 100;
export const DEFAULT_CHAT_AVATAR_SIZE = 36;
export const MIN_CHAT_AVATAR_SIZE = 24;
export const MAX_CHAT_AVATAR_SIZE = 56;
const CHAT_CSS_STYLE_ID = 'marshmallow-chat-thread-css';
const CHAT_CSS_UPDATED_EVENT = 'marshmallow-chat-appearance-style-updated';
const PAPER_RGB = '251,246,240';
const CHAT_MESSAGE_LAYOUT_REPAIR_START = '/* 消息左右布局修复：开始 */';
const CHAT_MESSAGE_LAYOUT_REPAIR_END = '/* 消息左右布局修复：结束 */';

// 自定义气泡常用 ::before / ::after 做尾巴、贴纸和高光。若作者给这些装饰层
// 写了 fixed/absolute + 大 inset，它们会盖住整页点击区；装饰伪元素不承载真实交互，
// 因此始终关闭命中测试。放在会话 CSS 最末尾，保证用户样式无法意外覆盖。
const CHAT_CUSTOM_CSS_INTERACTION_GUARD = `
.chat-thread-page .chat-thread-messages {
  overflow-anchor: none !important;
  scroll-behavior: auto !important;
}
.chat-thread-page .chat-bubble-row::before,
.chat-thread-page .chat-bubble-row::after,
.chat-thread-page .chat-msg-bubble::before,
.chat-thread-page .chat-msg-bubble::after,
.chat-thread-page .scrapbook-bubble::before,
.chat-thread-page .scrapbook-bubble::after,
.chat-thread-page .chat-bubble-col::before,
.chat-thread-page .chat-bubble-col::after {
  pointer-events: none !important;
}
.chat-thread-page .chat-thread-wallpaper-layer {
  pointer-events: none !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-media {
  display: flex !important;
  flex-direction: row !important;
  align-items: flex-start !important;
  width: 100% !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-user:not(.is-system) {
  justify-content: var(--chat-user-row-justify, flex-end) !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-user:not(.is-system) > .chat-bubble-col {
  order: var(--chat-user-col-order, 0) !important;
  align-items: var(--chat-user-content-align, flex-end) !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-user:not(.is-system) > .chat-bubble-avatar {
  order: var(--chat-user-avatar-order, 1) !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-user.is-media {
  justify-content: var(--chat-user-row-justify, flex-end) !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-them.is-media {
  justify-content: flex-start !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-media > .chat-bubble-col,
#page-container .chat-thread-page .chat-bubble-row.is-media .chat-bubble-media,
#page-container .chat-thread-page .chat-bubble-row.is-media .chat-bubble-body,
#page-container .chat-thread-page .chat-bubble-row.is-media .chat-sticker-slot,
#page-container .chat-thread-page .chat-bubble-row.is-media .chat-sticker {
  width: fit-content !important;
  min-width: 0 !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-media > .chat-bubble-col {
  flex: 0 1 auto !important;
  position: relative !important;
  inset: auto !important;
  float: none !important;
  max-width: min(78%, calc(100% - 96px)) !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-stack-group .chat-msg-media,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group .chat-msg-media > .chat-bubble-media,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group .chat-msg-media > .chat-bubble-media > .chat-bubble-body {
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-user.is-media > .chat-bubble-col {
  order: var(--chat-user-col-order, 0) !important;
  align-items: var(--chat-user-content-align, flex-end) !important;
  margin-left: var(--chat-user-content-margin-left, auto) !important;
  margin-right: var(--chat-user-content-margin-right, 0) !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-user.is-media > .chat-bubble-avatar {
  order: var(--chat-user-avatar-order, 1) !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-user.is-media .chat-bubble-media,
#page-container .chat-thread-page .chat-bubble-row.is-user.is-media .chat-bubble-body,
#page-container .chat-thread-page .chat-bubble-row.is-user.is-media .chat-sticker-slot,
#page-container .chat-thread-page .chat-bubble-row.is-user.is-media .chat-sticker,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group.is-user .chat-msg-media,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group.is-user .chat-msg-media > .chat-bubble-media,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group.is-user .chat-msg-media > .chat-bubble-media > .chat-bubble-body,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group.is-user .chat-msg-media .chat-sticker-slot,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group.is-user .chat-msg-media .chat-sticker {
  width: fit-content !important;
  min-width: 0 !important;
  align-self: var(--chat-user-content-align, flex-end) !important;
  margin-left: var(--chat-user-content-margin-left, auto) !important;
  margin-right: var(--chat-user-content-margin-right, 0) !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-them.is-media > .chat-bubble-col {
  order: 1 !important;
  align-items: flex-start !important;
  margin-left: 0 !important;
  margin-right: auto !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-them.is-media > .chat-bubble-avatar {
  order: 0 !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-them.is-media .chat-bubble-media,
#page-container .chat-thread-page .chat-bubble-row.is-them.is-media .chat-bubble-body,
#page-container .chat-thread-page .chat-bubble-row.is-them.is-media .chat-sticker-slot,
#page-container .chat-thread-page .chat-bubble-row.is-them.is-media .chat-sticker,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group.is-them .chat-msg-media,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group.is-them .chat-msg-media > .chat-bubble-media,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group.is-them .chat-msg-media > .chat-bubble-media > .chat-bubble-body,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group.is-them .chat-msg-media .chat-sticker-slot,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group.is-them .chat-msg-media .chat-sticker {
  width: fit-content !important;
  min-width: 0 !important;
  align-self: flex-start !important;
  margin-left: 0 !important;
  margin-right: auto !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-media .chat-sticker-slot .chat-sticker img,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group .chat-msg-media .chat-sticker img {
  width: auto !important;
  height: auto !important;
}
#page-container .chat-thread-page .chat-bubble-row.is-media .chat-sticker-slot,
#page-container .chat-thread-page .chat-bubble-row.is-media .chat-sticker,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group .chat-msg-media .chat-sticker-slot,
#page-container .chat-thread-page .chat-bubble-row.is-stack-group .chat-msg-media .chat-sticker {
  max-width: min(100%, 200px) !important;
}
@media (max-width: 480px) {
  #page-container .chat-thread-page .chat-bubble-row.is-media .chat-sticker-slot,
  #page-container .chat-thread-page .chat-bubble-row.is-media .chat-sticker,
  #page-container .chat-thread-page .chat-bubble-row.is-stack-group .chat-msg-media .chat-sticker-slot,
  #page-container .chat-thread-page .chat-bubble-row.is-stack-group .chat-msg-media .chat-sticker {
    max-width: min(100%, 132px) !important;
  }
}`;

export const CHAT_MESSAGE_LAYOUT_REPAIR_CSS = `${CHAT_MESSAGE_LAYOUT_REPAIR_START}
.chat-thread-page .chat-bubble-row:not(.is-system) {
  display: flex !important;
  flex-direction: row !important;
  align-items: flex-start !important;
  width: 100% !important;
}
.chat-thread-page .chat-bubble-row.is-user {
  justify-content: var(--chat-user-row-justify, flex-end) !important;
}
.chat-thread-page .chat-bubble-row.is-them {
  justify-content: flex-start !important;
}
.chat-thread-page .chat-bubble-row.is-user > .chat-bubble-col {
  order: var(--chat-user-col-order, 0) !important;
}
.chat-thread-page .chat-bubble-row.is-user > .chat-bubble-avatar {
  order: var(--chat-user-avatar-order, 1) !important;
}
.chat-thread-page .chat-bubble-row.is-them > .chat-bubble-avatar {
  order: 0 !important;
}
.chat-thread-page .chat-bubble-row.is-them > .chat-bubble-col {
  order: 1 !important;
}
.chat-thread-page .chat-bubble-row:not(.is-system) > .chat-bubble-col,
.chat-thread-page .chat-bubble-row:not(.is-system) > .chat-bubble-avatar {
  position: relative !important;
  inset: auto !important;
  float: none !important;
}
.chat-thread-page .chat-bubble-row:not(.is-system) > .chat-bubble-avatar {
  flex: 0 0 auto !important;
  margin-inline: 0 !important;
}
${CHAT_MESSAGE_LAYOUT_REPAIR_END}`;

export function withChatMessageLayoutRepair(cssText = '') {
  let css = cleanCss(cssText);
  let start = css.indexOf(CHAT_MESSAGE_LAYOUT_REPAIR_START);
  while (start >= 0) {
    const end = css.indexOf(CHAT_MESSAGE_LAYOUT_REPAIR_END, start);
    css = end >= 0
      ? `${css.slice(0, start)}${css.slice(end + CHAT_MESSAGE_LAYOUT_REPAIR_END.length)}`
      : css.slice(0, start);
    start = css.indexOf(CHAT_MESSAGE_LAYOUT_REPAIR_START);
  }
  return [css.trim(), CHAT_MESSAGE_LAYOUT_REPAIR_CSS].filter(Boolean).join('\n\n');
}

export function clampWallpaperOpacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WALLPAPER_OPACITY;
  return Math.max(10, Math.min(100, Math.round(n)));
}

function cleanHex(value) {
  const s = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : '';
}

function cleanCss(value) {
  let s = String(value == null ? '' : value);
  // 本应用导出的文本文件带 UTF-8 BOM；Safari 从“文件”重新导入时不会替我们移除，
  // BOM 会黏在首个选择器前，导致 WebKit 丢掉第一条（有包装规则时可能整段失效）。
  s = s.replace(/^\uFEFF/, '').replace(/^\s*@charset\s+["'][^"']+["']\s*;/i, '');
  // 防止把 </style> 写进注入的 <style> 里破坏页面
  s = s.replace(/<\/?\s*style[^>]*>/gi, '');
  // 统一改写成公开变量：浏览器 / iOS PWA 下变量读取 env()；APK 中变量为 0，
  // 因为原生层已经用真实系统栏 inset 给 WebView 父容器做了物理避让，不能再加一遍。
  return s.replace(/env\(\s*(safe-area-inset-(?:top|right|bottom|left))/gi, 'var(--$1');
}

// 用户气泡专用 CSS 的契约是“覆盖主题默认值”。主题里部分规则有更高选择器权重，
// 仅靠样式表插入顺序仍可能输掉，因此给声明补上 !important（已有的保持不变）。
function promoteBubbleCss(cssText = '') {
  const src = String(cssText || '');
  return src.replace(/([\w-]+\s*:\s*)(?![^;{}]*!important)([^;{}]*)(;|(?=\}))/g, '$1$2 !important$3');
}

const DIRECTIONAL_BUBBLE_PATTERN = /\.(?:scrapbook-bubble|chat-anon-bubble|chat-bubble(?:-[\w-]+)?|chat-msg-(?:group|stack|bubble)(?:-[\w-]+)?|voice-msg(?:-[\w-]+)?|chat-speech-play-btn)(?![\w-])/;
const DIRECTIONAL_LAYOUT_LEAK_PATTERN = /\.(?:chat-thread-composer|chat-thread-input|chat-composer|chat-thread-navbar|chat-thread-messages)(?![\w-])|#(?:app|page-container)(?![\w-])/;
const PLATFORM_BUBBLE_BEAUTIFY_PATTERN = /\.(?:scrapbook-bubble|chat-bubble(?:-[\w-]+)?|chat-msg-(?:group|stack|bubble)(?:-[\w-]+)?|chat-anon-bubble)(?![\w-])/;

/**
 * 旧气泡美化是在微信 / QQ 平台壳发布前编写的，通常不知道平台作用域。
 * 命中时只停用平台自带的气泡几何与尾巴，顶栏、底栏和功能卡仍保留平台皮肤。
 * 显式写出 .chat-platform-wechat / .chat-platform-qq 的 CSS 视为作者已适配平台。
 */
export function shouldUsePlatformBubbleCssCompat(platform, appearance = {}, globalCss = []) {
  const target = String(platform || '').trim().toLowerCase();
  if (target !== 'wechat' && target !== 'qq') return false;
  const directionalCss = [appearance?.userBubbleCss, appearance?.charBubbleCss]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const platformScope = target === 'wechat'
    ? /\.chat-platform-wechat(?![\w-])/
    : /\.chat-platform-qq(?![\w-])/;
  const directionalSet = new Set(directionalCss);
  const sources = [
    appearance?.customCss,
    ...directionalCss,
    ...(Array.isArray(globalCss) ? globalCss : [globalCss]),
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const bubbleSources = sources.filter((source) => (
    directionalSet.has(source) || PLATFORM_BUBBLE_BEAUTIFY_PATTERN.test(source)
  ));
  return bubbleSources.some((source) => !platformScope.test(source));
}

function selectorHasClassToken(selector = '', className = '') {
  const src = String(selector || '');
  const target = String(className || '');
  if (!src || !target) return false;
  let quote = '';
  let squareDepth = 0;
  let functionDepth = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') squareDepth += 1;
    else if (ch === ']') squareDepth = Math.max(0, squareDepth - 1);
    else if (ch === '(') functionDepth += 1;
    else if (ch === ')') functionDepth = Math.max(0, functionDepth - 1);
    else if (ch === '.' && squareDepth === 0 && functionDepth === 0) {
      const token = src.slice(i + 1).match(/^[\w-]+/)?.[0] || '';
      if (token === target) return true;
    }
  }
  return false;
}

/** 仅命中聊天页根节点本身（可写 --user-bubble-bg 等公开变量），不含后代布局节点 */
function isChatPageRootOnlySelector(selector = '') {
  const src = String(selector || '').trim();
  if (!src || !/\.chat-thread-page(?![\w-])/.test(src)) return false;
  let quote = '';
  let round = 0;
  let square = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') round += 1;
    else if (ch === ')') round = Math.max(0, round - 1);
    else if (ch === '[') square += 1;
    else if (ch === ']') square = Math.max(0, square - 1);
    else if ((ch === ' ' || ch === '>' || ch === '+' || ch === '~') && round === 0 && square === 0) {
      return false;
    }
  }
  return true;
}

function rewriteDirectionalBubbleSelector(selector = '', rowClass = 'is-user', oppositeClass = 'is-them') {
  const src = String(selector || '').trim();
  if (!src) return src;
  const hasOwn = selectorHasClassToken(src, rowClass);
  const hasOpposite = selectorHasClassToken(src, oppositeClass);
  if (hasOpposite && !hasOwn) return ':not(*)';
  if (DIRECTIONAL_LAYOUT_LEAK_PATTERN.test(src) && !DIRECTIONAL_BUBBLE_PATTERN.test(src) && !hasOwn) {
    return ':not(*)';
  }
  if (hasOwn) return src;
  if (isChatPageRootOnlySelector(src)) return src;
  if (/\.chat-bubble-row(?![\w-])/.test(src)) {
    return src.replace(/\.chat-bubble-row(?![\w-])/g, `.chat-bubble-row.${rowClass}`);
  }
  if (DIRECTIONAL_BUBBLE_PATTERN.test(src)) {
    return src.replace(DIRECTIONAL_BUBBLE_PATTERN, `.chat-bubble-row.${rowClass} $&`);
  }
  return ':not(*)';
}

/**
 * 气泡专用字段只能影响对应方向。允许：
 * - 已带 `.is-user` / `.is-them` 的规则
 * - 页根公开变量（如 `--user-bubble-bg`）
 * - 未写方向的 `.scrapbook-bubble`（自动补上本方向行类）
 * 输入栏 / 消息区 / 顶栏等越界布局仍改写为 :not(*)。
 */
export function prepareDirectionalBubbleCss(cssText = '', direction = 'user') {
  const rowClass = direction === 'them' ? 'is-them' : 'is-user';
  const oppositeClass = direction === 'them' ? 'is-user' : 'is-them';
  const scoped = scopeCssToPage(String(cssText || '').trim(), ['.chat-thread-page']);
  const constrained = mapCssRuleSelectors(scoped, (selector) => (
    rewriteDirectionalBubbleSelector(selector, rowClass, oppositeClass)
  ));
  const compatible = expandAnonymousBubbleCompatibility(constrained);
  return promoteBubbleCss(boostCssPriority(expandChatAppearanceRootSelectors(compatible)));
}

/** 从源会话拷贝可复用的美化字段（不含联动开关等业务项）。 */
export function pickChatAppearanceGroupSettings(sourceChat = null) {
  const gs = (sourceChat && sourceChat.groupSettings) || {};
  const appr = normalizeChatAppearance(gs);
  if (isChatAppearanceEmpty(appr)
    && !String(gs.wallpaper || '').trim()
    && !String(gs.wallpaperAssetId || '').trim()) return {};
  return {
    customCss: appr.customCss,
    userBubbleCss: appr.userBubbleCss,
    charBubbleCss: appr.charBubbleCss,
    wallpaperOpacity: appr.wallpaperOpacity,
    bubbleSelf: appr.bubbleSelf,
    bubbleOther: appr.bubbleOther,
    bubbleTextSelf: appr.bubbleTextSelf,
    bubbleTextOther: appr.bubbleTextOther,
    bubbleFontSize: appr.bubbleFontSize,
    avatarSize: appr.avatarSize,
    narrationFontSize: appr.narrationFontSize,
    narrationTextColor: appr.narrationTextColor,
    bubbleGrouping: appr.bubbleGrouping,
    ...(String(gs.wallpaperAssetId || '').trim()
      ? { wallpaperAssetId: String(gs.wallpaperAssetId).trim() }
      : (String(gs.wallpaper || '').trim() ? { wallpaper: String(gs.wallpaper).trim() } : {})),
  };
}

/** 0 = 跟随全局字号；其余取 12–19 的合法值 */
function cleanBubbleFontSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return clampChatBubbleFontSize(n);
}

/** 0 = 用主题默认旁白字号；其余取 11–18 */
function cleanNarrationFontSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(11, Math.min(18, Math.round(n)));
}

/** 0 = 跟随主题默认值；其余限制在适合手机消息行的 24–56px。 */
export function clampChatAvatarSize(value, { allowDefault = false } = {}) {
  const n = Number(value);
  if (allowDefault && (!Number.isFinite(n) || n <= 0)) return 0;
  if (!Number.isFinite(n)) return DEFAULT_CHAT_AVATAR_SIZE;
  return Math.max(MIN_CHAT_AVATAR_SIZE, Math.min(MAX_CHAT_AVATAR_SIZE, Math.round(n)));
}

export function normalizeChatAppearance(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    customCss: cleanCss(src.customCss),
    userBubbleCss: cleanCss(src.userBubbleCss),
    charBubbleCss: cleanCss(src.charBubbleCss),
    wallpaperOpacity: clampWallpaperOpacity(src.wallpaperOpacity == null ? DEFAULT_WALLPAPER_OPACITY : src.wallpaperOpacity),
    bubbleSelf: cleanHex(src.bubbleSelf),
    bubbleOther: cleanHex(src.bubbleOther),
    bubbleTextSelf: cleanHex(src.bubbleTextSelf),
    bubbleTextOther: cleanHex(src.bubbleTextOther),
    bubbleFontSize: cleanBubbleFontSize(src.bubbleFontSize),
    avatarSize: clampChatAvatarSize(src.avatarSize, { allowDefault: true }),
    narrationFontSize: cleanNarrationFontSize(src.narrationFontSize),
    narrationTextColor: cleanHex(src.narrationTextColor),
    bubbleGrouping: !!src.bubbleGrouping,
  };
}

export function getChatAppearance(chat) {
  const gs = (chat && chat.groupSettings) || {};
  return normalizeChatAppearance({
    customCss: gs.customCss,
    userBubbleCss: gs.userBubbleCss,
    charBubbleCss: gs.charBubbleCss,
    wallpaperOpacity: gs.wallpaperOpacity,
    bubbleSelf: gs.bubbleSelf,
    bubbleOther: gs.bubbleOther,
    bubbleTextSelf: gs.bubbleTextSelf,
    bubbleTextOther: gs.bubbleTextOther,
    bubbleFontSize: gs.bubbleFontSize,
    avatarSize: gs.avatarSize,
    narrationFontSize: gs.narrationFontSize,
    narrationTextColor: gs.narrationTextColor,
    bubbleGrouping: gs.bubbleGrouping,
  });
}

function normalizeAppearanceGeneration(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * 切换内置聊天外观后，旧会话美化暂停生效，但不删除原始数据。
 * 会话再次主动保存/套用美化时，会记录当前代次并恢复该会话。
 */
export function isChatSessionAppearanceActive(chat, requiredGeneration = 0) {
  const required = normalizeAppearanceGeneration(requiredGeneration);
  if (!required) return true;
  return normalizeAppearanceGeneration(chat?.groupSettings?.appearanceGeneration) >= required;
}

export function markChatSessionAppearanceActive(groupSettings, requiredGeneration = 0) {
  return {
    ...(groupSettings && typeof groupSettings === 'object' ? groupSettings : {}),
    appearanceGeneration: normalizeAppearanceGeneration(requiredGeneration),
  };
}

export function isChatAppearanceEmpty(appearance) {
  const appr = normalizeChatAppearance(appearance);
  return !appr.customCss.trim()
    && !appr.userBubbleCss.trim()
    && !appr.charBubbleCss.trim()
    && !appr.bubbleSelf
    && !appr.bubbleOther
    && !appr.bubbleTextSelf
    && !appr.bubbleTextOther
    && !appr.bubbleFontSize
    && !appr.avatarSize
    && !appr.narrationFontSize
    && !appr.narrationTextColor
    && !appr.bubbleGrouping
    && appr.wallpaperOpacity === DEFAULT_WALLPAPER_OPACITY;
}

/** 计算会话壁纸最终 background（叠一层底色做透明度；overlayRgb 为 `r,g,b`） */
export function buildChatWallpaperValue(wallpaperUrl, wallpaperOpacity, overlayRgb = PAPER_RGB) {
  const raw = String(wallpaperUrl || '').trim();
  if (!raw) return '';
  const safe = raw.replace(/"/g, '\\"');
  const visible = clampWallpaperOpacity(wallpaperOpacity) / 100;
  const overlay = 1 - visible;
  const rgb = String(overlayRgb || PAPER_RGB).replace(/[^\d,]/g, '') || PAPER_RGB;
  if (overlay <= 0.001) return `url("${safe}")`;
  const a = overlay.toFixed(3);
  return `linear-gradient(rgba(${rgb},${a}), rgba(${rgb},${a})), url("${safe}")`;
}

function chatNavbarColorAlpha(value = '') {
  const color = String(value || '').trim().toLowerCase();
  if (!color || color === 'transparent') return 0;
  const rgba = color.match(/^rgba?\(([^)]+)\)$/);
  if (!rgba) return 1;
  const parts = rgba[1].split(/[\s,\/]+/).filter(Boolean);
  if (parts.length < 4) return 1;
  const alpha = Number(parts[3]);
  return Number.isFinite(alpha) ? alpha : 1;
}

function chatNavbarCssIsNone(value = '') {
  const text = String(value || '').trim().toLowerCase();
  return !text || text === 'none';
}

/**
 * 规则矩形顶栏应把自身材质延伸到系统状态栏；圆角、裁剪、蒙版或横向内收的
 * 异形顶栏继续让独立安全区保持透明，避免重新出现“造型被撑满”的回归。
 * 参数使用 DOMRect / CSSStyleDeclaration 的同名字段，也方便无 DOM 回归测试。
 */
export function shouldFillChatNavbarSafeTop({ pageRect = {}, navbarRect = {}, style = {} } = {}) {
  const pageLeft = Number(pageRect.left);
  const pageRight = Number(pageRect.right);
  const navbarLeft = Number(navbarRect.left);
  const navbarRight = Number(navbarRect.right);
  if (![pageLeft, pageRight, navbarLeft, navbarRight].every(Number.isFinite)) return false;
  const edgeTolerance = 1.5;
  if (Math.abs(navbarLeft - pageLeft) > edgeTolerance || Math.abs(navbarRight - pageRight) > edgeTolerance) {
    return false;
  }

  const topLeftRadius = parseFloat(String(style.borderTopLeftRadius || '0')) || 0;
  const topRightRadius = parseFloat(String(style.borderTopRightRadius || '0')) || 0;
  if (topLeftRadius > 1 || topRightRadius > 1) return false;

  if (!chatNavbarCssIsNone(style.clipPath) || !chatNavbarCssIsNone(style.webkitClipPath)) return false;
  if (!chatNavbarCssIsNone(style.maskImage) || !chatNavbarCssIsNone(style.webkitMaskImage)) return false;

  const hasBackground = chatNavbarColorAlpha(style.backgroundColor) > 0.001
    || !chatNavbarCssIsNone(style.backgroundImage);
  const hasBackdrop = !chatNavbarCssIsNone(style.backdropFilter || style.webkitBackdropFilter);
  return hasBackground || hasBackdrop;
}

function ensureChatWallpaperLayer(container) {
  if (!container) return null;
  let layer = container.querySelector(':scope > .chat-thread-wallpaper-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'chat-thread-wallpaper-layer';
    layer.setAttribute('aria-hidden', 'true');
    container.insertBefore(layer, container.firstChild);
  }
  return layer;
}

/** 把会话壁纸画到真实 DOM 层：<img src> 与详情页预览同路，超长 data URL 在 Android 上比 background-image 稳 */
export function applyChatThreadWallpaper(container, wallpaperUrl, wallpaperOpacity, overlayRgb = PAPER_RGB) {
  const raw = String(wallpaperUrl || '').trim();
  if (!raw || !container) {
    clearChatThreadWallpaper(container);
    return;
  }
  container.classList.add('has-chat-wallpaper');
  // 用户聊天 CSS 可能给页面/消息区背景加了 !important（新版为兼容 Safari 会提升视觉属性）。
  // 壁纸是独立 img 层，必须由运行时 inline important 保证上面的内容层透明，否则图片
  // 已保存、也已加载，却会被实色背景完全盖住，看起来像“上传无效”。
  container.style.setProperty('background', 'transparent', 'important');
  container.style.setProperty('background-color', 'transparent', 'important');
  container.style.setProperty('background-image', 'none', 'important');
  for (const messages of container.querySelectorAll('.chat-thread-messages')) {
    messages.style.setProperty('background', 'transparent', 'important');
    messages.style.setProperty('background-color', 'transparent', 'important');
    messages.style.setProperty('background-image', 'none', 'important');
  }
  const layer = ensureChatWallpaperLayer(container);
  let img = layer.querySelector('.chat-thread-wallpaper-img');
  if (!img) {
    img = document.createElement('img');
    img.className = 'chat-thread-wallpaper-img';
    img.alt = '';
    img.decoding = 'async';
    img.setAttribute('aria-hidden', 'true');
    layer.appendChild(img);
  }
  const previousSrc = img.getAttribute('src') || '';
  if (previousSrc !== raw) {
    // Android WebView 在替换大图时可能继续绘制旧位图直到新图解码完成，视觉上像保存无效。
    // 只有确实存在旧图时才先隐藏；首次设置若 WebView 漏派 load，默认可见状态仍能直接绘制。
    if (previousSrc) img.style.opacity = '0';
    let failed = false;
    const reveal = () => {
      if (!failed && img.getAttribute('src') === raw) img.style.opacity = '1';
    };
    img.addEventListener('load', reveal, { once: true });
    img.addEventListener('error', () => {
      failed = true;
      if (img.getAttribute('src') === raw) img.style.opacity = '0';
    }, { once: true });
    img.setAttribute('src', raw);
    if (img.complete && img.naturalWidth > 0) reveal();
    // 部分 Android WebView 对 data URL 会漏派 load；decode 与短延迟共同保证不会永久停在 opacity:0。
    if (typeof img.decode === 'function') {
      img.decode().then(reveal).catch(() => {});
    }
    window.setTimeout(reveal, 240);
  } else if (img.complete && img.naturalWidth > 0) {
    img.style.opacity = '1';
  }

  let overlay = layer.querySelector('.chat-thread-wallpaper-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'chat-thread-wallpaper-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    layer.appendChild(overlay);
  }
  const visible = clampWallpaperOpacity(wallpaperOpacity) / 100;
  const cover = 1 - visible;
  const rgb = String(overlayRgb || PAPER_RGB).replace(/[^\d,]/g, '') || PAPER_RGB;
  // 清晰度仍由运行时计算，但只写“默认值”。真正用于绘制的 background 放在 CSS，
  // 用户可在聊天页根节点用 --chat-wallpaper-overlay-bg 接管，不必删除 DOM 蒙版或
  // 与 inline background 争权重。
  overlay.style.setProperty(
    '--chat-wallpaper-overlay-default',
    cover > 0.001 ? `rgba(${rgb},${cover.toFixed(3)})` : 'transparent',
  );
  overlay.style.removeProperty('background');

  layer.style.removeProperty('background-image');
  layer.style.removeProperty('background-size');
  layer.style.removeProperty('background-position');
  layer.style.removeProperty('background-repeat');
  container.style.removeProperty('--chat-thread-wallpaper');
}

export function clearChatThreadWallpaper(container) {
  if (!container) return;
  container.classList.remove('has-chat-wallpaper');
  container?.querySelector(':scope > .chat-thread-wallpaper-layer')?.remove();
  container.style.removeProperty('--chat-thread-wallpaper');
  container.style.removeProperty('background');
  container.style.removeProperty('background-color');
  container.style.removeProperty('background-image');
  for (const messages of container.querySelectorAll('.chat-thread-messages')) {
    messages.style.removeProperty('background');
    messages.style.removeProperty('background-color');
    messages.style.removeProperty('background-image');
  }
}

function buildEffectiveCss(appearance) {
  const appr = normalizeChatAppearance(appearance);
  const parts = [];
  const sessionVarBits = [];
  if (appr.bubbleFontSize) sessionVarBits.push(`--chat-bubble-font-size:${appr.bubbleFontSize}px`);
  if (appr.avatarSize) sessionVarBits.push(`--chat-bubble-avatar-size:${appr.avatarSize}px`);
  if (appr.narrationFontSize) sessionVarBits.push(`--chat-narration-flow-font-size:${appr.narrationFontSize}px`);
  if (appr.narrationTextColor) sessionVarBits.push(`--chat-notice-ink:${appr.narrationTextColor}`);
  // 本会话取色写入「会话层」变量，不占用 --user/role-bubble-bg。
  // 自定义 CSS 写公开变量时，始终高于取色器与档案色。
  if (appr.bubbleSelf) sessionVarBits.push(`--chat-session-bubble-self:${appr.bubbleSelf}`);
  if (appr.bubbleOther) sessionVarBits.push(`--chat-session-bubble-other:${appr.bubbleOther}`);
  if (appr.bubbleTextSelf) sessionVarBits.push(`--chat-session-bubble-ink-self:${appr.bubbleTextSelf}`);
  if (appr.bubbleTextOther) sessionVarBits.push(`--chat-session-bubble-ink-other:${appr.bubbleTextOther}`);
  if (sessionVarBits.length) {
    // 同时挂到海/窗 Ins 根类，避免主题高权重气泡规则读不到本会话色
    parts.push(expandChatAppearanceRootSelectors(
      `.chat-thread-page{${sessionVarBits.join(';')};}`,
    ));
  }
  // 会话内优先级：气泡专用 CSS > 整页 CSS > 公开变量 > 本会话取色 > 档案色 > 主题默认。
  // 整页 CSS 保留作用域与主题根扩展；仅视觉声明提为 important。布局声明不再凭空
  // 获得 ID 权重，恢复“静态主题 → 全局 → 会话”的正常级联，键盘规则可稳定兜底。
  const pageCss = appendChatChromeSafeAreaGuards(prepareChatVisualCssPriority(expandChatAppearanceRootSelectors(
    expandAnonymousBubbleCompatibility(
      scopeCssToPage(appr.customCss.trim(), ['.chat-thread-page']),
    ),
  )));
  if (pageCss) parts.push(pageCss);
  const userCss = prepareDirectionalBubbleCss(appr.userBubbleCss, 'user');
  if (userCss) parts.push(`/* userBubbleCss */\n${userCss}`);
  const charCss = prepareDirectionalBubbleCss(appr.charBubbleCss, 'them');
  if (charCss) parts.push(`/* charBubbleCss */\n${charCss}`);
  // 结构保护始终作为最后一层注入。全局主题 CSS 也可能改变消息布局；不能只在
  // 当前会话另存过 CSS 时才保护，否则同一条表情包切换平台后仍会漂回宽列中央。
  parts.push(CHAT_CUSTOM_CSS_INTERACTION_GUARD);
  return parts.join('\n');
}

let chatCssAssetRevision = 0;

function notifyChatAppearanceStyleUpdated() {
  const EventCtor = document?.defaultView?.Event;
  if (EventCtor) document.dispatchEvent(new EventCtor(CHAT_CSS_UPDATED_EVENT));
}

function writeChatAppearanceStyle(css, options = {}) {
  let el = document.getElementById(CHAT_CSS_STYLE_ID);
  if (!css) {
    if (el) el.remove();
    notifyChatAppearanceStyleUpdated();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = CHAT_CSS_STYLE_ID;
    document.head.appendChild(el);
  }
  const iosWebKit = document.documentElement.classList.contains('ios-webkit');
  if (options.forceStyleSheetRebuild || iosWebKit) {
    const replacement = el.cloneNode(false);
    replacement.textContent = css;
    el.replaceWith(replacement);
    el = replacement;
  } else {
    el.textContent = css;
  }
  // 会话 CSS 是聊天页最高的一层。工作室预览本来就会把草稿样式放在 head
  // 末尾；实装页也必须保持相同顺序，否则复用旧 style 节点时会被稍后注入的
  // 主题 / 全局聊天 CSS 盖回去，表现成“预览正常，套用预设不生效”。
  if (document.head.lastElementChild !== el) document.head.appendChild(el);
  notifyChatAppearanceStyleUpdated();
}

/** 把本会话美化注入页面（作用域约定为 .chat-thread-page 下，离开会话页无残留影响） */
export function applyChatThreadAppearance(appearance, options = {}) {
  if (typeof document === 'undefined') return;
  const css = buildEffectiveCss(appearance).trim();
  const revision = ++chatCssAssetRevision;
  writeChatAppearanceStyle(css, options);
  if (!css.includes('mm-img://')) return;
  // 兼容从素材库复制后直接粘进“本会话 CSS”的旧内容；先显示其它样式，
  // 素材异步读取完成后只替换当前会话仍在使用的这一次注入。
  import('./beautify-assets.js')
    .then(({ resolveBeautifyCssAssets }) => resolveBeautifyCssAssets(css))
    .then((resolved) => {
      if (revision !== chatCssAssetRevision || resolved === css) return;
      writeChatAppearanceStyle(String(resolved || '').trim(), {
        ...options,
        forceStyleSheetRebuild: true,
      });
    })
    .catch(() => {});
}

export function clearChatThreadAppearance() {
  if (typeof document === 'undefined') return;
  chatCssAssetRevision += 1;
  document.getElementById(CHAT_CSS_STYLE_ID)?.remove();
  notifyChatAppearanceStyleUpdated();
}

/** 会话是否写过自定义 CSS（整页 / 我方气泡 / 对方气泡） */
export function chatHasSessionCss(chat) {
  const appr = getChatAppearance(chat);
  return !!(appr.customCss.trim() || appr.userBubbleCss.trim() || appr.charBubbleCss.trim());
}

async function resolveEmergencyChatLabel(chat) {
  if (!chat || typeof chat !== 'object') return '会话';
  if (chat.type === 'group') {
    return String(chat.groupSettings?.name || chat.title || '群聊').trim() || '群聊';
  }
  const partnerId = (chat.participants || []).find((p) => p && p !== 'user');
  if (!partnerId) return String(chat.title || '私聊').trim() || '私聊';
  const char = await getRecord('characters', partnerId).catch(() => null);
  return String(char?.customNickname || char?.name || chat.title || partnerId).trim() || '私聊';
}

/**
 * 当前用户档位里写过会话 CSS 的聊天列表（供美化设置急救入口选择）。
 * @returns {Promise<Array<{ id: string, type: string, title: string, parts: string[] }>>}
 */
export async function listChatsWithSessionCss(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const chats = await listChatsForUser(uid);
  const rows = [];
  for (const chat of chats) {
    if (!chatHasSessionCss(chat)) continue;
    const appr = getChatAppearance(chat);
    const parts = [
      appr.customCss.trim() ? '整页' : '',
      appr.userBubbleCss.trim() ? '我方气泡' : '',
      appr.charBubbleCss.trim() ? '对方气泡' : '',
    ].filter(Boolean);
    rows.push({
      id: String(chat.id || '').trim(),
      type: chat.type === 'group' ? 'group' : 'private',
      title: await resolveEmergencyChatLabel(chat),
      parts,
    });
  }
  return rows.filter((row) => row.id);
}

/**
 * 急救：清空指定会话的自定义 CSS（保留气泡色/壁纸/字号等），并卸掉当前页已注入的会话样式。
 */
export async function clearChatSessionCss(chatId) {
  const id = String(chatId || '').trim();
  if (!id) throw new Error('缺少会话');
  const chat = await getChat(id);
  if (!chat) throw new Error('会话不存在');
  const had = chatHasSessionCss(chat);
  if (!had) {
    clearChatThreadAppearance();
    return { cleared: false, chat };
  }
  const next = await saveChat({
    ...chat,
    groupSettings: {
      ...(chat.groupSettings || {}),
      customCss: '',
      userBubbleCss: '',
      charBubbleCss: '',
    },
  });
  clearChatThreadAppearance();
  return { cleared: true, chat: next };
}

/** 急救：只在会话 CSS 末尾补回消息行/双方头像的左右顺序，保留其它美化。 */
export async function repairChatSessionMessageLayout(chatId) {
  const id = String(chatId || '').trim();
  if (!id) throw new Error('缺少会话');
  const chat = await getChat(id);
  if (!chat) throw new Error('会话不存在');
  const current = getChatAppearance(chat);
  const next = await saveChat({
    ...chat,
    groupSettings: {
      ...(chat.groupSettings || {}),
      customCss: withChatMessageLayoutRepair(current.customCss),
    },
  });
  clearChatThreadAppearance();
  return { repaired: true, chat: next };
}

/* ── 预设（全局，不跟用户档位） ── */

function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const appr = normalizeChatAppearance({
    customCss: raw.css != null ? raw.css : raw.customCss,
    userBubbleCss: raw.userBubbleCss,
    charBubbleCss: raw.charBubbleCss,
    wallpaperOpacity: raw.wallpaperOpacity,
    bubbleSelf: raw.bubbleSelf,
    bubbleOther: raw.bubbleOther,
    bubbleTextSelf: raw.bubbleTextSelf,
    bubbleTextOther: raw.bubbleTextOther,
    bubbleFontSize: raw.bubbleFontSize,
    avatarSize: raw.avatarSize,
    narrationFontSize: raw.narrationFontSize,
    narrationTextColor: raw.narrationTextColor,
    bubbleGrouping: raw.bubbleGrouping,
  });
  const now = Date.now();
  return {
    id: String(raw.id || '').trim() || `cap_${now}_${Math.random().toString(36).slice(2, 6)}`,
    name: String(raw.name || '').trim().slice(0, 40) || '未命名预设',
    css: appr.customCss,
    userBubbleCss: appr.userBubbleCss,
    charBubbleCss: appr.charBubbleCss,
    wallpaperOpacity: appr.wallpaperOpacity,
    bubbleSelf: appr.bubbleSelf,
    bubbleOther: appr.bubbleOther,
    bubbleTextSelf: appr.bubbleTextSelf,
    bubbleTextOther: appr.bubbleTextOther,
    bubbleFontSize: appr.bubbleFontSize,
    avatarSize: appr.avatarSize,
    narrationFontSize: appr.narrationFontSize,
    narrationTextColor: appr.narrationTextColor,
    bubbleGrouping: appr.bubbleGrouping,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
  };
}

/** 内置预设：出厂自带、不落库、不可删；排在自存预设前面 */
function builtinPresets() {
  return BUILTIN_CHAT_APPEARANCE_PRESETS
    .map((p) => normalizePreset({ ...p, createdAt: 0, updatedAt: 0 }))
    .filter(Boolean)
    .map((p) => ({ ...p, builtin: true }));
}

export async function loadChatAppearancePresets() {
  const row = await get(CHAT_APPEARANCE_PRESETS_KEY);
  const list = Array.isArray(row && row.value && row.value.presets) ? row.value.presets : [];
  const saved = list.map(normalizePreset).filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return [...builtinPresets(), ...saved];
}

async function savePresetList(list) {
  await put({ key: CHAT_APPEARANCE_PRESETS_KEY, value: { presets: list } });
}

/** 只取用户自存的预设（增删只作用于这份，内置预设不落库） */
async function loadSavedPresets() {
  const row = await get(CHAT_APPEARANCE_PRESETS_KEY);
  const list = Array.isArray(row && row.value && row.value.presets) ? row.value.presets : [];
  return list.map(normalizePreset).filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveChatAppearancePreset(name, appearance) {
  const label = String(name || '').trim();
  if (!label) throw new Error('请填写预设名称');
  const list = await loadSavedPresets();
  const appr = normalizeChatAppearance(appearance);
  const now = Date.now();
  const preset = normalizePreset({
    id: `cap_${now}_${Math.random().toString(36).slice(2, 6)}`,
    name: label,
    css: appr.customCss,
    userBubbleCss: appr.userBubbleCss,
    charBubbleCss: appr.charBubbleCss,
    wallpaperOpacity: appr.wallpaperOpacity,
    bubbleSelf: appr.bubbleSelf,
    bubbleOther: appr.bubbleOther,
    bubbleTextSelf: appr.bubbleTextSelf,
    bubbleTextOther: appr.bubbleTextOther,
    bubbleFontSize: appr.bubbleFontSize,
    avatarSize: appr.avatarSize,
    narrationFontSize: appr.narrationFontSize,
    narrationTextColor: appr.narrationTextColor,
    bubbleGrouping: appr.bubbleGrouping,
    createdAt: now,
    updatedAt: now,
  });
  await savePresetList([preset, ...list]);
  return preset;
}

export async function deleteChatAppearancePreset(id) {
  const target = String(id || '').trim();
  if (!target) return;
  const list = await loadSavedPresets();
  await savePresetList(list.filter((p) => p.id !== target));
}

export function presetToAppearance(preset) {
  return normalizeChatAppearance({
    customCss: preset && preset.css,
    userBubbleCss: preset && preset.userBubbleCss,
    charBubbleCss: preset && preset.charBubbleCss,
    wallpaperOpacity: preset && preset.wallpaperOpacity,
    bubbleSelf: preset && preset.bubbleSelf,
    bubbleOther: preset && preset.bubbleOther,
    bubbleTextSelf: preset && preset.bubbleTextSelf,
    bubbleTextOther: preset && preset.bubbleTextOther,
    bubbleFontSize: preset && preset.bubbleFontSize,
    avatarSize: preset && preset.avatarSize,
    narrationFontSize: preset && preset.narrationFontSize,
    narrationTextColor: preset && preset.narrationTextColor,
    bubbleGrouping: preset && preset.bubbleGrouping,
  });
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

/** 给用户 / AI 用的 CSS 参考文档（可下载）：格式、选项、类名与变量；不提供成品样式示例 */
export function buildChatAppearanceReferenceMarkdown() {
  const classRows = CHAT_APPEARANCE_CLASSES.map((item) => [`\`${item.cls}\``, item.label]);
  const varRows = CHAT_APPEARANCE_VARS.map((item) => [`\`${item.key}\``, item.label]);
  return [
    '# 棉花糖机 · 消息界面 CSS 契约',
    '',
    '本文描述输出格式、可选结构、真实选择器与约束，并提供少量“如何命中组件”的修改配方；配方只演示层级和变量，不是默认成品主题。请根据用户给出的参考图或文字要求独立设计。',
    '',
    '## 输出格式',
    '',
    '- 只输出可直接导入的 CSS，不输出 HTML、JavaScript、JSON 或教程说明。',
    '- 所有规则必须以 `.chat-thread-page` 为作用域；需要区分主题时才使用主题修饰类。',
    '- 按“变量 → 页面骨架 → 顶栏 → 消息区 → 气泡 → 输入区 → 工具面板 → 响应式与减弱动效”的顺序分段。',
    '- 每段只写本次设计实际需要的规则，不为未选择的结构添加隐藏备用样式。',
    '- 保留返回、设置、发送、停止、工具面板等交互与键盘焦点，不用装饰层拦截点击。',
    '- 用户要求“重做 / 大改”顶栏或底栏时，不能只换背景色、变量或圆角：必须同时处理外层轮廓、内部排布、文字/图标层级和展开态工具面板；只有用户明确说“只换色”时才做表层调整。',
    '',
    '## 写入位置',
    '',
    '1. **整页 CSS**（`customCss`）：顶栏、输入区、工具面板、头像、旁白卡等整页装饰。',
    '2. **我方气泡 CSS**（`userBubbleCss`）：用于我发出的气泡；仍需写 `.is-user` 选择器。',
    '3. **对方气泡 CSS**（`charBubbleCss`）：用于对方气泡；仍需写 `.is-them` 选择器。',
    '4. 气泡专用 CSS 只接受对应 `.is-user` / `.is-them` 消息行下的规则；页面、消息区和输入栏布局请写在整页 CSS。',
    '',
    '固定优先级为：**本会话我方/对方气泡 CSS > 本会话整页 CSS > 公开气泡变量 > 本会话取色 > 全局消息 CSS > 主题默认**。群聊可额外使用成员档案色区分多人。',
    '',
    '整页 CSS 的视觉属性（颜色、背景、边框、阴影、字体等）会自动补强；布局属性（`display`、`grid-*`、`flex-*`、`padding`、`margin`、尺寸与定位等）不会自动提权，避免破坏键盘和安全区兜底。大改布局时请使用“当前主题复合根 + 具体组件”的精确选择器，确实被主题规则覆盖时只给必要声明加 `!important`，不要给整页布局无差别提权。',
    '',
    '改气泡色请写公开变量（不要只写 `background`，海/窗主题选择器权重更高时会盖不住）：',
    '`.chat-thread-page{--user-bubble-bg:…;--role-bubble-bg:…;--user-bubble-ink:…;--role-bubble-ink:…;}`',
    '本会话取色走更低一层，不会锁死上述公开变量。旁白、系统提示与时间分隔的统一字色使用 `--chat-notice-ink`。',
    '',
    '## 生成前必须选择',
    '',
    mdTable(
      ['项目', '可选项', '规则'],
      [
        ['顶栏头像', '无头像 / 单枚对方头像 / 双头像', '默认不启用；只有参考图或用户要求出现头像时才选择'],
        ['顶栏高度', '常规 / 在文档流中向下延展 / 覆盖消息区', '优先在文档流中延展；覆盖消息区时必须补偿首屏内容空间'],
        ['顶栏轮廓', '常规矩形 / 圆角 / 不对称圆角 / 裁剪轮廓 / 伪元素延展', '只选择一种主轮廓手法，避免叠加成模板化装饰'],
        ['消息头像', '双方显示 / 仅对方 / 仅我方 / 全部隐藏', '尺寸与圆角使用公开变量'],
        ['气泡', '跟随主题 / 变量配色 / 直接属性', '纯配色优先变量；渐变、图片或复杂状态才写直接属性'],
        ['旁白模式', '居中小字 + 两侧浅细线', '使用 `.chat-narration-row.is-flow` 与 `--chat-narration-flow-*`，写进整页 CSS；不要套用系统提示或双方气泡选择器'],
        ['输入区', '跟随主题 / 统一变量', '普通手账、海、窗共用同一 DOM；匿名区保留必要结构差异'],
        ['主题范围', '全部主题 / 当前主题 / 匿名区', '未明确时只作用于当前会话的通用结构'],
      ],
    ),
    '',
    '## 顶栏真实结构',
    '',
    '```text',
    'header.chat-thread-navbar',
    '├─ button.navbar-btn（返回）',
    '├─ button.chat-thread-title-btn',
    '│  ├─ span.chat-title-duo（单聊可选，默认隐藏）',
    '│  │  ├─ span.chat-title-duo-avatar.is-them',
    '│  │  └─ span.chat-title-duo-avatar.is-user',
    '│  └─ div.chat-thread-title-stack（标题 / 状态 / 时区）',
    '└─ button.navbar-btn（设置）',
    '```',
    '',
    '顶栏头像槽只在单聊存在。CSS 可以隐藏、放大、重排已有头像，不能增加新的真实头像或凭空生成动态资料字段。',
    '',
    '### 顶栏大改的命中范围',
    '',
    '完整重做顶栏时，至少同时检查 `.chat-thread-navbar`（外层轮廓）、`.chat-thread-title-btn`（中间可点击区）、`.chat-thread-title-stack`（标题/状态排布）和 `.navbar-btn`（两侧按钮）。只改 `.chat-thread-navbar` 的 background / border-radius 不算结构重做。',
    '',
    '顶栏定位由页面骨架负责，不要覆盖它现有的 `position`、`top` 或 `z-index` 机制。需要向下延展时增加自身高度或下内边距；需要视觉覆盖消息区时，用不拦截点击的伪元素并给消息区首屏补偿空间。不要向上侵入系统状态栏。',
    '',
    '顶部系统安全区由页面里的独立保护槽承担；`.chat-thread-navbar` 的 `padding` / `margin` 只写视觉尺寸，不要再叠加 `var(--safe-top)`，也不要用负 `margin-top` / `translateY` 把顶栏顶进状态栏。',
    '',
    '## 底栏真实结构',
    '',
    '所有普通聊天（当前 / 微信 / QQ / 手账 / 海 / 窗）共用同一套公开颜色变量、消息卡片类名和交互语义；平台修饰类只负责默认皮肤与必要结构增强。通用改色优先写公开变量或组件类，不必为每个平台复制一份 CSS。',
    '',
    '手账体系与 QQ 默认皮肤使用两行底栏：',
    '',
    '```text',
    'footer.chat-thread-composer',
    '├─ div.chat-composer-input-row',
    '│  ├─ textarea.chat-composer-input',
    '│  └─ button.chat-composer-send（发送 / 推进 / 停止）',
    '└─ div.chat-composer-strip.chat-composer-side',
    '   ├─ button.chat-composer-btn（语音 / 图片 / 表情等；平台可调整数量）',
    '   ├─ span.chat-composer-strip-spacer',
    '   └─ button.chat-composer-btn.chat-composer-more（更多）',
    '```',
    '',
    'QQ 可能附带 `.chat-thread-composer--qq` / `.chat-composer-strip--qq`，这些类只负责 QQ 自己的皮肤，不得影响其它主题。',
    '',
    '只有真正的匿名聊天使用下面的紧凑输入栏：',
    '',
    '```text',
    'footer.chat-thread-composer.chat-thread-composer--anon',
    '├─ button.chat-anon-icon-btn（更多）',
    '├─ label.chat-anon-input-shell',
    '│  ├─ button.chat-anon-inline-btn（表情）',
    '│  ├─ textarea.chat-composer-input',
    '│  └─ button.chat-anon-inline-btn（图片 / 语音）',
    '└─ button.chat-composer-send.chat-anon-send（发送 / 推进 / 停止）',
    '```',
    '',
    '引用条 `.chat-reply-bar`、多选条 `.chat-selection-bar`、工具面板 `.chat-tools-sheet` 是底栏附近的独立兄弟节点，不在 composer 内部。打开“更多”后页面根节点带 `.has-chat-tools-open`，工具面板带 `.is-open`。普通聊天（含海 / 窗）使用上面的公开 composer 结构与 `.chat-tools-pager > .chat-tools-page` 的 4×2 分页；用户排序只改变 `.chat-tool-item` 的 DOM 顺序，不改变这些类名与 data-tool/data-act，排序入口 `.chat-tools-order-trigger` 独立于分页。只有真正的匿名聊天使用 `.chat-thread-composer--anon`；只有匿名区使用 `.chat-tools-sheet--anon > .chat-anon-tools-grid`。',
    '',
    '### 底栏大改的命中范围',
    '',
    '先判断当前主题使用哪套结构，再成套修改：外层 `.chat-thread-composer` + 当前结构的内部行/胶囊 + `.chat-composer-input` + `.chat-composer-send` + `.chat-tools-sheet`。QQ / 微信皮肤只能在对应平台范围内增强；不要同时输出两套互相覆盖的布局，也不要只改 textarea 后声称完成底栏重做。',
    '',
    '底栏本来由页面网格固定在消息区下方，并由应用处理键盘高度；不要再写 `position:fixed` / `sticky`、`bottom:0` 或 `100vh`。最底层可见区域必须保留 `var(--safe-bottom)`：工具面板关闭时由 composer 承担，打开时由 `.chat-tools-sheet` 承担，不能两层重复垫安全区。',
    '',
    '## 特殊消息卡片：先选卡片，再选内部层',
    '',
    '- `.chat-card` 是红包、转账、位置、邀约、投票等卡片的共同标记；直接改它会同时改变所有卡片。只改一种卡片时，用专属类或 `[data-card-type="类型"]`。',
    '- 卡片外壳不一定是实际可见底色。比如线下邀约的外壳是 `.offline-invite-card`，真正的纸片底色在 `.offline-invite-card-paper`，顶部标签和按钮又是独立层。',
    '- 常用精确入口：`[data-card-type="transfer"]`、`[data-card-type="redpacket"]`、`[data-card-type="location"]`、`[data-card-type="link"]`、`[data-card-type="voice-call"]`、`[data-card-type="order-share"]`、`[data-card-type="vote"]`、`[data-card-type="offline-invite"]`。',
    '- 卡片状态优先使用已有修饰类或 data 属性，不用 `:nth-child` 猜状态；完整类名见下方选择器表。',
    '',
    '### 线下邀约卡只换色（可直接复制后改色值）',
    '',
    '```css',
    `.chat-thread-page {
  --offline-invite-outer-bg: transparent;
  --offline-invite-paper: #fff7fb;
  --offline-invite-border: #e9bfd2;
  --offline-invite-shadow: 0 8px 22px rgba(138, 72, 103, 0.16);
  --offline-invite-ink: #4b3040;
  --offline-invite-accent: #b85f86;
  --offline-invite-muted: #886b79;
  --offline-invite-divider: rgba(184, 95, 134, 0.28);
  --offline-invite-ribbon-bg: linear-gradient(135deg, #d989aa, #b85f86);
  --offline-invite-group-ribbon-bg: linear-gradient(135deg, #9a89d9, #7564bd);
  --offline-invite-primary-bg: linear-gradient(135deg, #d989aa, #b85f86);
  --offline-invite-primary-ink: #fff;
  --offline-invite-secondary-bg: #f8e8f0;
  --offline-invite-secondary-ink: #87546d;
  --offline-invite-chip-bg: rgba(184, 95, 134, 0.09);
  --offline-invite-response-bg: rgba(255, 255, 255, 0.62);
}`,
    '```',
    '',
    '若只想改单独一张卡的某一层，再用精确选择器：`.chat-thread-page .offline-invite-card-paper { border-radius: 20px; }`。不要只给 `.offline-invite-card` 写 `background` 后期待纸片、标签和按钮一起变色。',
    '',
    '## 预设与壁纸复用',
    '',
    '- 「消息美化预设」与「壁纸库」是通用资源库，不会因为切换 user 重复保存同一份素材。',
    '- Chat 侧栏的「本身份装扮」只保存当前 user 选择的默认预设快照和壁纸素材引用；新建会话自动继承。',
    '- 已有会话不会被切换身份默认值时静默覆盖；需要在「本身份装扮」里明确点“同步已有会话”。',
    '- 单个会话仍可在会话详情里另选预设、壁纸、透明度或 CSS；这些会话级设置优先于之后新建会话使用的身份默认。',
    '- 消息预设保存 CSS、气泡颜色、字号、提示字色和连续气泡等参数，不复制图片本体；壁纸从共用图库单独选择，可被多个身份和会话复用。',
    '',
    '## 方法映射',
    '',
    mdTable(
      ['目标', '使用位置或属性', '约束'],
      [
        ['顶栏向下延展', '`.chat-thread-navbar` 的高度与下内边距', '不要侵入系统状态栏'],
        ['异形顶栏', '顶栏自身的圆角、裁剪或伪元素', '纯装饰层不拦截点击'],
        ['单枚顶栏头像', '显示头像容器并隐藏 `.is-user`', '不要同时保留双头像重叠参数'],
        ['双头像', '显示 `.chat-title-duo` 并使用 `--chat-title-duo-*`', '只有用户明确选择时启用'],
        ['消息头像尺寸', '`--chat-bubble-avatar-*` / `--chat-user-avatar-size` / `--chat-role-avatar-size`', '不直接争抢宽高'],
        ['气泡颜色', '`.chat-thread-page{--user-bubble-bg;--role-bubble-bg;…}`', '必须带选择器写公开变量；高于本会话取色'],
        ['提示字色', '`--chat-notice-ink`', '统一控制旁白、系统提示与时间分隔文字'],
        ['壁纸清晰度白雾', '`--chat-wallpaper-overlay-bg`', '`transparent` 可取消洗白，不删除蒙版 DOM'],
        ['顶栏与输入区玻璃', '`--chat-chrome-bg` / `--chat-chrome-filter` / `--chat-composer-*`', '底色与模糊分别接管'],
        ['普通聊天输入栏布局', '`.chat-composer-input-row` + `.chat-composer-strip`', '平台主题可附加修饰类；不要依赖匿名区结构'],
        ['匿名聊天紧凑输入栏', '`.chat-thread-composer--anon` + `.chat-anon-input-shell`', '只用于真正的匿名聊天'],
        ['完整底栏轮廓', 'composer 外层 + 当前主题内部结构 + `.chat-tools-sheet`', '展开态必须与收起态属于同一视觉体系'],
        ['翻译区域', '`--chat-translation-*` / `--chat-translate-btn-*`', '保持折叠按钮可读可点'],
      ],
    ),
    '',
    '## 安全约束',
    '',
    '- 状态栏安全距离由页面强制保留；只通过 `--chat-navbar-top-gap` 调整额外留白。',
    '- 不给 `.chat-thread-page` / `.chat-thread-messages` 设置会遮住壁纸的不透明背景。',
    '- 壁纸使用独立的 `.chat-thread-wallpaper-layer`（内含图片与蒙版）；不要改变它的层级、定位或点击行为。',
    '- 顶栏或标题按钮的纯装饰伪元素必须使用 `pointer-events:none`。',
    '- 普通聊天与匿名区使用两套输入区 DOM（上文已列）；它们共享 `--chat-composer-*` / `--chat-toolbar-*` 变量和工具面板语义，但布局选择器不可混用。',
    '- 尊重 `prefers-reduced-motion`，并保留键盘焦点可见性。',
    '',
    '## 可用选择器',
    '',
    classRows.length ? mdTable(['选择器', '含义'], classRows) : '',
    '',
    '## 可用 CSS 变量',
    '',
    varRows.length ? mdTable(['变量', '含义'], varRows) : '',
  ].join('\n');
}
