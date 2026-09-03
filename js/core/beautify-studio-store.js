import * as db from './db.js';
import {
  applyAppearanceTheme,
  getActiveTheme,
  loadAppearancePrefs,
  saveAppearancePrefs,
} from './appearance-prefs.js';
import { localizeBeautifyRemoteCssImages, resolveBeautifyCssAssets } from './beautify-assets.js';
import {
  appendChatChromeSafeAreaGuards,
  BEAUTIFY_PAGE_ROOTS,
  boostCssPriority,
  expandChatAppearanceRootSelectors,
  prepareChatVisualCssPriority,
  scopeCssToPage,
} from './css-priority.js';
import {
  loadOfflineStylePrefs,
  prepareOfflineStyleCss,
  saveOfflineStylePrefs,
} from './offline-appearance.js';
import { ensureDefaultUser } from './user-slot.js';
import { normalizeInnerVoiceCard } from './chat/inner-voice-style.js';

const STUDIO_KEY = 'beautifyStudio';
const PREVIEW_STYLE_ID = 'marshmallow-beautify-preview';

function cleanCss(value) {
  const withoutStyleTags = String(value || '')
    .replace(/<\/?\s*style[^>]*>/gi, '');
  const trimmed = withoutStyleTags.trim();
  // 兼容用户直接把 AI 返回的整段 Markdown 代码块粘进 CSS 编辑器。
  // 只拆“整段恰好是一个围栏”的情况，避免误伤 CSS 字符串里的反引号。
  const fenced = trimmed.match(/^```(?:css)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i);
  return fenced ? fenced[1] : withoutStyleTags;
}

function normalizePreset(value = {}) {
  return {
    id: String(value.id || `beautify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    name: String(value.name || '未命名美化').trim().slice(0, 40) || '未命名美化',
    target: String(value.target || 'chat-thread'),
    variant: value.variant === 'dark' ? 'dark' : 'light',
    css: cleanCss(value.css),
    assets: Array.isArray(value.assets) ? value.assets.slice(0, 40) : [],
    updatedAt: Number(value.updatedAt || Date.now()),
  };
}

const MAX_CHAT_MESSAGES = 60;

function normalizeChatMessage(value = {}) {
  const role = value.role === 'assistant' ? 'assistant' : 'user';
  const content = String(value.content || '');
  if (!content) return null;
  return {
    role,
    content,
    ts: Number(value.ts || Date.now()),
    ...(role === 'assistant' && value.finishReason === 'length'
      ? { finishReason: 'length' }
      : {}),
  };
}

function normalizeState(raw = {}) {
  const drafts = {};
  Object.entries(raw.drafts || {}).forEach(([key, value]) => {
    drafts[String(key)] = cleanCss(value);
  });
  const darkDrafts = {};
  Object.entries(raw.darkDrafts || {}).forEach(([key, value]) => {
    darkDrafts[String(key)] = cleanCss(value);
  });
  const chats = {};
  Object.entries(raw.chats || {}).forEach(([key, list]) => {
    chats[String(key)] = (Array.isArray(list) ? list : [])
      .map(normalizeChatMessage)
      .filter(Boolean)
      .slice(-MAX_CHAT_MESSAGES);
  });
  return {
    version: 1,
    disabled: !!raw.disabled,
    drafts,
    darkDrafts,
    chats,
    presets: (Array.isArray(raw.presets) ? raw.presets : []).map(normalizePreset),
    assistantMode: raw.assistantMode === 'character' ? 'character' : 'designer',
    innerVoiceDraft: normalizeInnerVoiceCard(raw.innerVoiceDraft, 'ins'),
  };
}

export async function loadBeautifyStudioState() {
  const row = await db.get(STUDIO_KEY);
  return normalizeState(row?.value || {});
}

export async function saveBeautifyStudioState(state) {
  const normalized = normalizeState(state);
  await db.put({ key: STUDIO_KEY, value: normalized });
  return normalized;
}

export async function saveBeautifyDraft(target, css, options = {}) {
  const state = await loadBeautifyStudioState();
  const slot = options.variant === 'dark' ? state.darkDrafts : state.drafts;
  slot[String(target || 'chat-thread')] = cleanCss(css);
  return saveBeautifyStudioState(state);
}

export async function loadBeautifyChat(target) {
  const state = await loadBeautifyStudioState();
  return state.chats[String(target || 'chat-thread')] || [];
}

export async function saveBeautifyChat(target, messages) {
  const state = await loadBeautifyStudioState();
  state.chats[String(target || 'chat-thread')] = (Array.isArray(messages) ? messages : [])
    .map(normalizeChatMessage)
    .filter(Boolean)
    .slice(-MAX_CHAT_MESSAGES);
  return saveBeautifyStudioState(state);
}

export async function saveBeautifyInnerVoiceDraft(card) {
  const state = await loadBeautifyStudioState();
  state.innerVoiceDraft = normalizeInnerVoiceCard(card, 'ins');
  return saveBeautifyStudioState(state);
}

export async function saveBeautifyPreset(preset) {
  const state = await loadBeautifyStudioState();
  const next = normalizePreset(preset);
  const index = state.presets.findIndex((item) => item.id === next.id);
  if (index >= 0) state.presets[index] = next;
  else state.presets.unshift(next);
  await saveBeautifyStudioState(state);
  return next;
}

export async function deleteBeautifyPreset(id) {
  const state = await loadBeautifyStudioState();
  state.presets = state.presets.filter((item) => item.id !== id);
  return saveBeautifyStudioState(state);
}

const previewRevisions = new WeakMap();

function isIOSWebKitDocument(doc) {
  const nav = doc?.defaultView?.navigator;
  const ua = String(nav?.userAgent || '');
  const platform = String(nav?.platform || '');
  return /iPad|iPhone|iPod/i.test(ua)
    || (platform === 'MacIntel' && Number(nav?.maxTouchPoints || 0) > 1);
}

export async function applyBeautifyPreviewCssToDocument(doc, css, targetId) {
  if (!doc || !doc.head) return { applied: false, unavailable: true, ruleCount: 0 };
  const revision = (previewRevisions.get(doc) || 0) + 1;
  previewRevisions.set(doc, revision);
  const resolvedCss = await resolveBeautifyCssAssets(cleanCss(css));
  if (previewRevisions.get(doc) !== revision) return { applied: false, stale: true, ruleCount: 0 };
  let style = doc.getElementById(PREVIEW_STYLE_ID);
  if (!style) {
    style = doc.createElement('style');
    style.id = PREVIEW_STYLE_ID;
  }
  // 与发布注入同一套权重处理，预览所见即发布所得：
  // 先把裸选择器圈进本页作用域，聊天对话页再扩主题根类，最后只定向提权气泡视觉。
  const key = String(targetId || '');
  const scoped = scopeCssToPage(resolvedCss, BEAUTIFY_PAGE_ROOTS[key] || []);
  const preparedCss = key === 'chat-thread'
    ? appendChatChromeSafeAreaGuards(
        prepareChatVisualCssPriority(expandChatAppearanceRootSelectors(scoped)),
      )
    : key === 'offline'
      ? prepareOfflineStyleCss(resolvedCss)
      : boostCssPriority(scoped);
  // iOS WebKit 偶尔不会重新绘制已挂载 <style> 的 textContent 变更，
  // 表现为草稿已写入但要返回一次才看到。替换节点可强制 CSSOM 立即更新，
  // 与正式主题注入的 iOS 策略保持一致。
  if (style.isConnected && isIOSWebKitDocument(doc)) {
    const replacement = style.cloneNode(false);
    replacement.textContent = preparedCss;
    style.replaceWith(replacement);
    style = replacement;
  } else {
    style.textContent = preparedCss;
  }
  // 始终排在 head 末尾：预览 iframe 里主题样式在 app 启动时才追加，
  // 若草稿样式排在前面会被同权重的主题规则盖掉，表现成「应用了没变化」。
  if (doc.head.lastElementChild !== style) doc.head.appendChild(style);
  let ruleCount = null;
  try {
    ruleCount = style.sheet?.cssRules?.length ?? null;
  } catch (_) {
    // 极少数浏览器不允许读取 CSSOM；样式节点仍已正常注入。
  }
  return {
    applied: true,
    ruleCount,
    cssText: style.textContent,
  };
}

export async function applyBeautifyPreviewCss(css, targetId) {
  if (typeof document === 'undefined') return;
  return applyBeautifyPreviewCssToDocument(document, css, targetId);
}

export function clearBeautifyPreviewCss() {
  if (typeof document === 'undefined') return;
  document.getElementById(PREVIEW_STYLE_ID)?.remove();
}

export async function publishBeautifyCss(target, css, options = {}) {
  const targetKey = String(target || 'chat-thread');
  const variant = options.variant === 'dark' ? 'dark' : 'light';
  if (targetKey === 'offline') {
    const user = await ensureDefaultUser();
    const prefs = await loadOfflineStylePrefs(user.id);
    const resolvedCss = await resolveBeautifyCssAssets(css);
    const portableCss = await localizeBeautifyRemoteCssImages(resolvedCss);
    return saveOfflineStylePrefs(user.id, {
      ...prefs,
      [variant === 'dark' ? 'darkCss' : 'css']: cleanCss(portableCss),
    }, { reason: 'beautify-studio-publish' });
  }
  const resolvedCss = await resolveBeautifyCssAssets(css);
  const portableCss = await localizeBeautifyRemoteCssImages(resolvedCss);
  const prefs = await loadAppearancePrefs();
  const active = getActiveTheme(prefs);
  if (!active.theme) throw new Error('当前主题不可用');
  // 每个页面独立一个发布槽：发布主屏不会覆盖聊天首页，反之亦然。
  // 旧版共用 css/chatCss 两个键，发布任何一页都会互相覆盖。
  const theme = {
    ...active.theme,
    customTheme: {
      ...(active.theme.customTheme || {}),
      // 聊天页从旧 chatCss 迁到独立 pageCss 槽后，发布新版必须同时卸掉旧槽。
      // 否则两份 CSS 会一起注入，而工作室只能看到/清理新版这一份。
      ...(targetKey === 'chat-thread' && variant === 'light' ? { chatCss: '' } : {}),
      pageCss: {
        ...(active.theme.customTheme?.pageCss || {}),
        ...(variant === 'light' ? { [targetKey]: cleanCss(portableCss) } : {}),
      },
      pageDarkCss: {
        ...(active.theme.customTheme?.pageDarkCss || {}),
        ...(variant === 'dark' ? { [targetKey]: cleanCss(portableCss) } : {}),
      },
    },
  };
  prefs.themes[active.id] = theme;
  const saved = await saveAppearancePrefs(prefs);
  applyAppearanceTheme(getActiveTheme(saved).theme);
  return saved;
}

/** 读取当前主题里已发布的自定义 CSS（供「导入已发布」把线上样式拉回编辑器继续改）。 */
export async function getPublishedBeautifyCss(target, options = {}) {
  const targetKey = String(target || 'chat-thread');
  const variant = options.variant === 'dark' ? 'dark' : 'light';
  if (targetKey === 'offline') {
    const user = await ensureDefaultUser();
    const prefs = await loadOfflineStylePrefs(user.id);
    return cleanCss(variant === 'dark' ? prefs.darkCss : prefs.css);
  }
  const prefs = await loadAppearancePrefs();
  const active = getActiveTheme(prefs);
  const pageCss = active.theme?.customTheme?.[variant === 'dark' ? 'pageDarkCss' : 'pageCss']?.[targetKey];
  if (String(pageCss || '').trim()) return cleanCss(pageCss);
  if (variant === 'dark') return '';
  // 旧发布落在共享键里，作为回退继续可导入
  const legacyKey = targetKey === 'chat-thread' || targetKey === 'chat-hub' ? 'chatCss' : 'css';
  return cleanCss(active.theme?.customTheme?.[legacyKey] || '');
}

/** 清除某一页已发布的自定义 CSS（真正从主题里删掉，不是临时停用）。 */
export async function clearPublishedBeautifyCss(target, options = {}) {
  const targetKey = String(target || 'chat-thread');
  const variant = options.variant === 'dark' ? 'dark' : 'light';
  if (targetKey === 'offline') {
    const user = await ensureDefaultUser();
    const prefs = await loadOfflineStylePrefs(user.id);
    const key = variant === 'dark' ? 'darkCss' : 'css';
    return saveOfflineStylePrefs(user.id, { ...prefs, [key]: '' }, { reason: `clear-${variant}-css` });
  }
  const prefs = await loadAppearancePrefs();
  const active = getActiveTheme(prefs);
  if (!active.theme) throw new Error('当前主题不可用');
  const prev = active.theme.customTheme || {};
  const nextPageCss = { ...(prev.pageCss || {}) };
  const nextPageDarkCss = { ...(prev.pageDarkCss || {}) };
  if (variant === 'dark') delete nextPageDarkCss[targetKey];
  else delete nextPageCss[targetKey];
  const customTheme = {
    ...prev,
    pageCss: nextPageCss,
    pageDarkCss: nextPageDarkCss,
  };
  // 旧版共享槽：清聊天时顺带清 chatCss；清主屏时顺带清全局 css
  if (variant === 'light' && (targetKey === 'chat-thread' || targetKey === 'chat-hub')) {
    customTheme.chatCss = '';
  }
  if (variant === 'light' && targetKey === 'home') {
    customTheme.css = '';
  }
  const theme = {
    ...active.theme,
    customTheme,
  };
  prefs.themes[active.id] = theme;
  const saved = await saveAppearancePrefs(prefs);
  applyAppearanceTheme(getActiveTheme(saved).theme);
  return saved;
}

export async function getGlobalChatWallpaper() {
  const prefs = await loadAppearancePrefs();
  const active = getActiveTheme(prefs);
  return {
    src: String(active.theme?.customTheme?.chatWallpaper || ''),
    opacity: Math.max(10, Math.min(100, Number(active.theme?.customTheme?.chatWallpaperOpacity || 100))),
  };
}

export async function setGlobalChatWallpaper(src, opacity = 100) {
  const prefs = await loadAppearancePrefs();
  const active = getActiveTheme(prefs);
  const theme = {
    ...active.theme,
    customTheme: {
      ...(active.theme?.customTheme || {}),
      chatWallpaper: String(src || '').trim(),
      chatWallpaperOpacity: Math.max(10, Math.min(100, Number(opacity || 100))),
    },
  };
  prefs.themes[active.id] = theme;
  const saved = await saveAppearancePrefs(prefs);
  applyAppearanceTheme(getActiveTheme(saved).theme);
  return getGlobalChatWallpaper();
}

export async function setAllCustomCssDisabled(disabled) {
  const state = await loadBeautifyStudioState();
  state.disabled = !!disabled;
  await saveBeautifyStudioState(state);
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('beautify-safe-mode', state.disabled);
    const ids = [
      'marshmallow-user-theme',
      'marshmallow-chat-global-css',
      'marshmallow-chat-thread-css',
      'marshmallow-page-css',
      'marshmallow-page-dark-css',
      'os-custom-css',
      'os-custom-dark-css',
      PREVIEW_STYLE_ID,
    ];
    ids.forEach((id) => {
      const style = document.getElementById(id);
      if (!style) return;
      const darkOnly = id === 'marshmallow-page-dark-css' || id === 'os-custom-dark-css';
      style.media = state.disabled || (darkOnly && document.documentElement.dataset.colorMode !== 'dark')
        ? 'not all'
        : 'all';
    });
  }
  return state;
}

export async function initializeBeautifySafeMode() {
  if (typeof document === 'undefined') return false;
  const hashSafeMode = !!globalThis.__MM_BEAUTIFY_SAFE_MODE__
    || /(?:^|[#?&])safe-mode(?:=1)?(?:&|$)/.test(String(location.hash || '') + String(location.search || ''));
  const state = await loadBeautifyStudioState().catch(() => normalizeState());
  const disabled = hashSafeMode || state.disabled;
  document.documentElement.classList.toggle('beautify-safe-mode', disabled);
  if (disabled) {
    const ids = ['marshmallow-user-theme', 'marshmallow-chat-global-css', 'marshmallow-chat-thread-css', 'marshmallow-page-css', 'marshmallow-page-dark-css', 'os-custom-dark-css'];
    ids
      .forEach((id) => {
        const style = document.getElementById(id);
        if (style) style.media = 'not all';
      });
    if (!globalThis.__MM_BEAUTIFY_SAFE_OBSERVER__) {
      globalThis.__MM_BEAUTIFY_SAFE_OBSERVER__ = new MutationObserver(() => {
        if (!document.documentElement.classList.contains('beautify-safe-mode')) return;
        ids.forEach((id) => {
          const style = document.getElementById(id);
          if (style) style.media = 'not all';
        });
      });
      globalThis.__MM_BEAUTIFY_SAFE_OBSERVER__.observe(document.head, { childList: true, subtree: true });
    }
  }
  return disabled;
}

export { cleanCss as cleanBeautifyCss };
