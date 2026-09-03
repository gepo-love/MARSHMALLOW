import { loadChatOutputPrefs } from './chat/chat-output-prefs.js';
import {
  isValidUserFacingTranslation,
  looksLikeChineseTranslation,
} from './translation-utils.js';

const TOGGLE_SELECTOR = '[data-translation-toggle]';
const CHAT_SCROLLER_SELECTOR = '.chat-thread-messages';
const AUTO_EXPANDED_ATTR = 'data-auto-expanded-translation';
const PREFS_CHANGED_EVENT = 'chat-output-prefs-changed';
const NEAR_BOTTOM_THRESHOLD = 160;

let initialized = false;
let autoExpandEnabled = false;

function collectTranslationButtons(root) {
  if (!root) return [];
  const buttons = [];
  if (typeof root.matches === 'function' && root.matches(TOGGLE_SELECTOR)) buttons.push(root);
  if (typeof root.querySelectorAll === 'function') buttons.push(...root.querySelectorAll(TOGGLE_SELECTOR));
  return buttons;
}

function resolveTranslationWrap(button) {
  const wrap = button?.nextElementSibling;
  if (!wrap) return null;
  if (!wrap.classList?.contains('chat-bubble-translation') && !wrap.classList?.contains('narration-translation')) {
    return null;
  }
  return wrap;
}

function hasExistingValidTranslation(button, wrap) {
  const source = String(button?.getAttribute?.('data-translation-source') || '').trim();
  const textNode = wrap?.querySelector?.('.chat-bubble-translation-text, .voice-msg-translation');
  const translation = String(textNode?.textContent || wrap?.textContent || '').trim();
  if (!translation) return false;
  return source
    ? isValidUserFacingTranslation(source, translation)
    : looksLikeChineseTranslation(translation);
}

/**
 * 将容器中已有的有效译文切到默认展开态。
 * 只读现有 DOM，不会触发翻译补全；用户手动点击后仍由原按钮逻辑正常收起。
 */
export function applyAutoExpandTranslations(root, enabled = true) {
  const buttons = collectTranslationButtons(root);
  let changed = 0;

  for (const button of buttons) {
    const wrap = resolveTranslationWrap(button);
    if (!wrap) continue;

    if (!enabled) {
      if (button.getAttribute?.(AUTO_EXPANDED_ATTR) !== 'true') continue;
      if (!wrap.hidden) {
        wrap.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        changed += 1;
      }
      button.removeAttribute?.(AUTO_EXPANDED_ATTR);
      continue;
    }

    if (!wrap.hidden || !hasExistingValidTranslation(button, wrap)) continue;
    wrap.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute(AUTO_EXPANDED_ATTR, 'true');
    changed += 1;
  }

  return changed;
}

/**
 * 聊天列表先按折叠译文的高度完成增量追加和置底，MutationObserver 随后才展开译文。
 * 若展开前本来就在底部，需按展开后的最终高度重新置底；用户在看历史时则不抢位置。
 */
export function applyAutoExpandTranslationsPreservingBottom(roots, enabled = true) {
  const list = Array.isArray(roots) ? roots : [roots];
  const buttons = [...new Set(list.flatMap((root) => collectTranslationButtons(root)))];
  const scrollers = new Map();

  for (const button of buttons) {
    const scroller = button?.closest?.(CHAT_SCROLLER_SELECTOR);
    if (!scroller || scrollers.has(scroller)) continue;
    const bottomGap = Math.max(
      0,
      Number(scroller.scrollHeight || 0)
        - Number(scroller.scrollTop || 0)
        - Number(scroller.clientHeight || 0),
    );
    scrollers.set(scroller, bottomGap <= NEAR_BOTTOM_THRESHOLD);
  }

  const changed = applyAutoExpandTranslations({
    querySelectorAll: () => buttons,
  }, enabled);

  if (changed > 0) {
    for (const [scroller, wasNearBottom] of scrollers) {
      if (wasNearBottom) scroller.scrollTop = scroller.scrollHeight;
    }
  }

  return changed;
}

/** 全局监听后续页面渲染出来的翻译按钮，并按显示偏好设置初始展开态。 */
export async function initializeAutoExpandTranslations() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;

  const prefs = await loadChatOutputPrefs().catch(() => ({ autoExpandTranslations: false }));
  autoExpandEnabled = prefs.autoExpandTranslations === true;
  applyAutoExpandTranslations(document, autoExpandEnabled);

  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.(TOGGLE_SELECTOR);
    if (button) button.removeAttribute(AUTO_EXPANDED_ATTR);
  }, true);

  if (typeof MutationObserver === 'function' && document.documentElement) {
    const observer = new MutationObserver((mutations) => {
      if (!autoExpandEnabled) return;
      const addedRoots = [];
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes || []) {
          if (node?.nodeType === 1) addedRoots.push(node);
        }
      }
      if (addedRoots.length) applyAutoExpandTranslationsPreservingBottom(addedRoots, true);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(PREFS_CHANGED_EVENT, (event) => {
      autoExpandEnabled = event.detail?.autoExpandTranslations === true;
      applyAutoExpandTranslations(document, autoExpandEnabled);
    });
  }
}
