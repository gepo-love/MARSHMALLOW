import { back, navigate, navigateDismissing, syncCurrentRoute } from '../core/router.js';
import { shareToCommunityStore } from '../core/community-share-draft.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { chatWithPreferredStream } from '../core/api.js';
import { acquireNarrationGenerationLease } from '../core/narration-generation-lease.js';
import * as db from '../core/db.js';
import {
  beautifyAssetUrl,
  deleteBeautifyAsset,
  exportBeautifyComponent,
  importBeautifyComponent,
  installBeautifyComponentOnHome,
  installWidgetTemplateOnHome,
  listBeautifyAssets,
  resolveBeautifyCssAssets,
  replaceBeautifyCssImageSelection,
  saveBeautifyComponent,
  saveBeautifyImage,
  saveBeautifyImageUrl,
  setWidgetTemplateHomeVisible,
  updateWidgetTemplateOnHome,
} from '../core/beautify-assets.js';
import {
  loadChatAppearancePresets,
  saveChatAppearancePreset,
  withChatMessageLayoutRepair,
} from '../core/chat-appearance.js';
import {
  listInboxChatsForUser,
  sortChatsForInbox,
} from '../core/chat-store.js';
import {
  buildInnerVoiceCardReferenceMarkdown,
  normalizeInnerVoiceCard,
  parseInnerVoiceCardImportText,
  saveInnerVoiceCardPreset,
} from '../core/chat/inner-voice-style.js';
import { listOfflineStylePresets } from '../core/offline-appearance.js';
import { loadOfflineSession } from '../core/offline-session-store.js';
import { getCharacter, listCharacters } from '../core/character-store.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import {
  applyBeautifyPreviewCss,
  applyBeautifyPreviewCssToDocument,
  clearBeautifyPreviewCss,
  deleteBeautifyPreset,
  getGlobalChatWallpaper,
  getPublishedBeautifyCss,
  clearPublishedBeautifyCss,
  loadBeautifyChat,
  loadBeautifyStudioState,
  publishBeautifyCss,
  saveBeautifyChat,
  saveBeautifyDraft,
  saveBeautifyInnerVoiceDraft,
  saveBeautifyPreset,
  setGlobalChatWallpaper,
  setAllCustomCssDisabled,
} from '../core/beautify-studio-store.js';
import {
  BEAUTIFY_TARGETS,
  buildComponentAiContext,
  getBeautifyTarget,
} from '../data/beautify-studio-contract.js';
import { BUILTIN_AVATAR_FRAMES } from '../data/builtin-avatar-frames.js';
import {
  BEAUTIFY_WIDGET_TEMPLATES,
  buildBeautifyWidgetReferenceMarkdown,
  getBeautifyWidgetTemplate,
} from '../data/beautify-widget-templates.js';
import { downloadText as downloadNativeText } from '../core/native-download.js';
import {
  BUILTIN_HOME_WIDGET_DEFS,
  applyAppearanceColorMode,
  getActiveTheme,
  getThemeResetDefaults,
  loadAppearancePrefs,
  normalizeHomeLayout,
  resolveHomeTemplateKey,
  saveAppearancePrefs,
  WALLPAPER_NONE,
} from '../core/appearance-prefs.js';
import {
  HTML_EXTENSION_STARTERS,
  buildHtmlExtensionAuthorPrompt,
  extractHtmlExtensionBlocks,
} from '../core/html-extension-author.js';
import {
  DEFAULT_HTML_EXTENSION_TEMPLATE,
  createHtmlExtensionSnapshot,
  hydrateHtmlExtensionHosts,
  normalizeHtmlExtension,
  upsertHtmlExtension,
} from '../core/html-extensions.js';
import { sanitizeWidgetHtml } from '../core/custom-widget.js';

const HOME_TEMPLATE_AI_LABELS = {
  scrapbook: '手账（根节点 .home-shell-page，App 图标是 .app-icon[data-app-id]）',
  sea: '海（根节点 .home-sea-shell，App 图标是 .sea-app[data-app-id]）',
  window: '窗（根节点 .home-window-shell，App 图标复用 .sea-app[data-app-id]，窗框类是 mw-*）',
  album: '相册（根节点 .home-album-shell，App 图标是 .app-icon[data-app-id]，首屏主照片、便签与副照片是三个独立组件）',
};

const HTML_EXTENSION_TARGET = Object.freeze({
  id: 'html-extension',
  label: '扩展组件',
  route: 'extensions',
  root: '',
  groups: [],
  vars: [],
});

const INNER_VOICE_TARGET = Object.freeze({
  id: 'inner-voice',
  label: '心声',
  route: 'beautify',
  root: '#char-state-popover',
  groups: [],
  vars: [],
});

function communityBeautifySubtype(targetId) {
  const id = String(targetId || '');
  if (id === 'home') return 'home-style';
  if (id === 'chat-thread') return 'chat-style';
  if (id === 'offline') return 'offline-style';
  return 'page-style';
}

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function downloadText(text, filename, type = 'text/css') {
  return downloadNativeText(`\uFEFF${String(text || '')}`, filename, {
    mimeType: `${type};charset=utf-8`,
  });
}

function safeBeautifyFilename(name, fallback = '美化方案') {
  const stem = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80);
  return stem || fallback;
}

async function copyBeautifyText(text = '') {
  const value = String(text ?? '');
  if (!value) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {}
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, area.value.length);
    return document.execCommand('copy') === true;
  } catch (_) {
    return false;
  } finally {
    area.remove();
  }
}

function extractCssBlocks(text) {
  const blocks = [];
  // 带语言标记且不是 css 的代码块（如 ```html 组件）不能当 CSS 应用
  const pattern = /```([a-z]*)[^\S\n]*\n?([\s\S]*?)```/gi;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const lang = (match[1] || '').toLowerCase();
    if (lang && lang !== 'css') continue;
    blocks.push(match[2].trim());
  }
  return blocks.filter(Boolean);
}

function extractInnerVoiceCard(text = '') {
  try {
    return parseInnerVoiceCardImportText(text);
  } catch (_) {
    return null;
  }
}

// 预览是真实页面本身（同源 iframe 跑完整 app），美化前后与用户看到的完全一致。
const PREVIEW_EMBED_STYLE_ID = 'marshmallow-beautify-embed';
const PREVIEW_EMBED_STYLE = `
#companion-dock, .companion-dock-fallback, .quick-ball { display: none !important; }
.is-beautify-selected { outline: 2px solid #e48245 !important; outline-offset: -2px !important; }
/* 缩略预览允许页面滚动，但不执行发送、跳转、表单和拖拽等真实操作。 */
a, button, input, textarea, select, option, [role="button"], [contenteditable="true"], [draggable="true"] {
  pointer-events: none !important;
}
`;

const CHAT_HUB_EFFECT_TEST_CSS = `
.chat-hub-page .chat-hub-navbar,
.chat-hub-page .chat-hub-ins-chrome,
.chat-hub-page .chat-hub-scroll {
  background: #fff3b8 !important;
}
.chat-hub-page .chat-list-row {
  margin: 7px 12px !important;
  border: 3px solid #ff4f87 !important;
  border-radius: 18px !important;
  background: #ffffff !important;
  box-shadow: 0 8px 22px rgba(255, 79, 135, .2) !important;
}
`;

function buildPreviewSrc(route) {
  const params = new URLSearchParams(route.params || {});
  const query = params.toString();
  return `${location.pathname}?beautifyPreview=1#${route.path}${query ? `?${query}` : ''}`;
}

function pickBeautifyPreviewChat(chats = [], preferredChatId = '') {
  const sorted = sortChatsForInbox(chats).filter((chat) => (
    chat?.id
    && Array.isArray(chat.participants)
    && chat.participants.includes('user')
  ));
  const preferred = String(preferredChatId || '').trim();
  if (preferred) {
    const matched = sorted.find((chat) => String(chat.id) === preferred);
    if (matched) return matched;
  }
  // 空会话即使刚创建或被置顶，也不能抢走工作室的默认预览。
  // lastMessage 是收件箱已经维护的轻量消息标记，不需要为了选预览再扫描消息表。
  return sorted.find((chat) => String(chat.lastMessage || '').trim()) || sorted[0] || null;
}

function beautifyPreviewChatLabel(chat, index = 0) {
  const name = String(
    chat?.groupSettings?.groupName
    || chat?.title
    || chat?.name
    || (chat?.type === 'group' ? '群聊' : '私聊'),
  ).trim();
  const preview = String(chat?.lastMessage || '').replace(/\s+/g, ' ').trim();
  return `${name || `会话 ${index + 1}`} · ${preview ? preview.slice(0, 24) : '暂无消息'}`;
}

function resolvePreviewViewport() {
  const viewport = window.visualViewport;
  const width = Math.round(Number(viewport?.width || window.innerWidth) || 390);
  const height = Math.round(Number(viewport?.height || window.innerHeight) || 798);
  const isPhoneViewport = width >= 320 && width <= 540;
  return {
    width: isPhoneViewport ? width : 390,
    height: isPhoneViewport ? Math.max(560, Math.min(980, height)) : 798,
  };
}

function themeScopedDraftKey(targetId, themeId = '') {
  const target = String(targetId || '').trim();
  const theme = String(themeId || '').trim();
  if (!target || target === 'offline' || target === 'html-extension' || !theme) return target;
  return `${target}::theme:${theme}`;
}

function targetCards(state, activeThemeId = '') {
  const pageCards = BEAUTIFY_TARGETS.map((target) => {
    const draftKey = themeScopedDraftKey(target.id, activeThemeId);
    const hasDraft = !!String(state.drafts?.[draftKey] || '').trim();
    return `<button class="beautify-target-card" data-open-target="${esc(target.id)}">
      <span class="beautify-target-icon">${icon(target.id === 'home' ? 'window' : target.id === 'moments' ? 'image' : ['offline', 'travel-char'].includes(target.id) ? 'pin' : 'bubble')}</span>
      <span><strong>${esc(target.label)}</strong><small>${hasDraft ? '有未发布草稿' : target.id === 'home' ? '整套外观或自定义组件' : '整页设计或局部微调'}</small></span>
      ${icon('chevron')}
    </button>`;
  });
  pageCards.push(`<button class="beautify-target-card" data-open-inner-voice>
    <span class="beautify-target-icon">${icon('sparkle')}</span>
    <span><strong>心声</strong><small>自定义字段、数值与状态卡</small></span>
    ${icon('chevron')}
  </button>`);
  return pageCards.join('');
}

function componentTree(target) {
  return target.groups.map((group, groupIndex) => `<details class="beautify-component-group" ${groupIndex === 0 ? 'open' : ''}>
    <summary>${esc(group.label)}<span>${group.components.length}</span></summary>
    <div>${group.components.map((item) => `<button data-component="${esc(item.cls)}" data-component-label="${esc(item.label)}"><code>${esc(item.cls)}</code><small>${esc(item.label)}</small></button>`).join('')}</div>
  </details>`).join('');
}

function customPropertyValue(css, key) {
  const safeKey = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...String(css || '').matchAll(new RegExp(`${safeKey}\\s*:\\s*([^;{}]+)\\s*;`, 'g'))];
  return matches.length ? String(matches[matches.length - 1][1] || '').trim() : '';
}

function propertyControls(target, css = '') {
  const vars = (target.vars || []).slice(0, target.maxVars || 18);
  if (!vars.length) return `<div class="beautify-empty-controls">选中组件后可在高级 CSS 中微调。</div>`;
  return vars.map((item) => {
    const value = customPropertyValue(css, item.key);
    const color = item.type === 'color';
    return `<label class="beautify-property-row">
      <span>${esc(item.label)}</span>
      <span class="beautify-property-input">
        ${color ? `<input type="color" value="${esc(item.defaultColor || '#7a9eb4')}" data-color-var="${esc(item.key)}" aria-label="${esc(item.label)}取色">` : ''}
        <input type="text" value="${esc(value)}" placeholder="${esc(item.placeholder || (color ? '输入颜色' : '例如 16px'))}" data-var="${esc(item.key)}" aria-label="${esc(item.label)}">
      </span>
    </label>`;
  }).join('');
}

function renderHome(container, state, globalWallpaper, activeThemeId = '') {
  container.innerHTML = `
    <header class="beautify-navbar">
      <button class="beautify-icon-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1>美化工作室</h1>
      <button class="beautify-icon-btn" data-emergency aria-label="急救模式">${icon('zap')}</button>
    </header>
    <main class="beautify-home">
      <section class="beautify-signature-card">
        <span>${icon('select')}</span>
        <div><strong>点到哪里，改到哪里</strong><small>选择页面与组件，AI 会自动读取对应规则。</small></div>
      </section>
      <section class="beautify-section"><h2>选择页面</h2><div class="beautify-target-grid">${targetCards(state, activeThemeId)}</div></section>
      <section class="beautify-section">
        <h2>扩展组件</h2>
        <button class="beautify-extension-entry" data-open-extension>
          <span class="beautify-target-icon">${icon('package')}</span>
          <span><strong>制作聊天内容卡</strong><small>描述用途，生成并预览安全 HTML</small></span>
          ${icon('chevron')}
        </button>
      </section>
      <section class="beautify-section"><h2>保存的方案</h2>
        <div class="beautify-preset-list">${state.presets.length ? state.presets.map((preset) => `<article><span><strong>${esc(preset.name)}</strong><small>${esc(getBeautifyTarget(preset.target).label)}${preset.variant === 'dark' ? ' · 夜间' : ''}</small></span><button data-load-preset="${esc(preset.id)}">打开</button><button data-share-preset="${esc(preset.id)}">分享</button><button data-delete-preset="${esc(preset.id)}">${icon('trash')}</button></article>`).join('') : '<p class="beautify-empty">尚未保存方案。</p>'}</div>
      </section>
      <section class="beautify-section">
        <h2>内置组件</h2>
        <div class="beautify-template-list">${BEAUTIFY_WIDGET_TEMPLATES.map((tpl) => `<article>
          <span><strong>${esc(tpl.name)}</strong><small>${esc(tpl.desc)}</small></span>
          <button data-install-template="${esc(tpl.id)}">添加到主屏</button>
        </article>`).join('')}</div>
      </section>
      <section class="beautify-section">
        <h2>素材与组件</h2>
        <div class="beautify-asset-actions">
          <button data-upload-asset>${icon('image')} 上传图片</button>
          <button data-add-asset-url>${icon('link')} 添加直链</button>
          <button data-import-component>${icon('upload')} 导入组件</button>
          <button data-community-import>${icon('cloud')} 社区导入</button>
          <button data-community-open>${icon('share')} 打开社区</button>
          <input type="file" accept="image/*" data-asset-file hidden>
          <input type="file" accept=".json,application/json" data-component-file hidden>
        </div>
        <div class="beautify-asset-list"><p class="beautify-empty">正在读取素材…</p></div>
      </section>
      <section class="beautify-section">
        <h2>全局聊天壁纸</h2>
        <div class="beautify-wallpaper-card">
          <div class="beautify-wallpaper-preview" ${globalWallpaper.src ? `style="background-image:url('${esc(globalWallpaper.src)}')"` : ''}></div>
          <label><span>图片地址</span><input type="url" data-global-wallpaper-url value="${esc(globalWallpaper.src)}" placeholder="https://…"></label>
          <label><span>清晰度</span><input type="range" min="10" max="100" value="${esc(globalWallpaper.opacity)}" data-global-wallpaper-opacity></label>
          <div><button data-global-wallpaper-file>${icon('upload')} 上传</button><button data-global-wallpaper-save>${icon('save')} 保存</button><button data-global-wallpaper-clear>清除</button></div>
          <input type="file" accept="image/*" data-global-wallpaper-input hidden>
        </div>
      </section>
      <button class="beautify-emergency ${state.disabled ? 'is-active' : ''}" data-emergency>${state.disabled ? '恢复自定义美化' : '临时停用全部 CSS（不删除）'}</button>
    </main>`;
}

function renderEditor(container, state, target, homeMode = 'theme', cssVariant = 'light', draftKey = '', homeTemplateKey = '') {
  const css = (cssVariant === 'dark' ? state.darkDrafts : state.drafts)?.[draftKey || target.id] || '';
  const isHome = target.id === 'home';
  const isWidgetMode = isHome && homeMode === 'widget';
  container.innerHTML = `
    <header class="beautify-navbar">
      <button class="beautify-icon-btn" data-studio-home aria-label="返回">${icon('back')}</button>
      <div><h1>${esc(target.label)}</h1><small class="beautify-locator">${isWidgetMode ? '独立 HTML 组件' : '整页 CSS 外观'}</small></div>
      <button class="beautify-icon-btn" data-real-preview aria-label="整页查看效果">${icon('expand')}</button>
    </header>
    <main class="beautify-editor">
      ${isHome ? `<nav class="beautify-home-mode" aria-label="主屏创作模式">
        <button class="${isWidgetMode ? '' : 'is-active'}" data-home-mode="theme">整套外观</button>
        <button class="${isWidgetMode ? 'is-active' : ''}" data-home-mode="widget">自定义组件</button>
      </nav>` : ''}
      ${isWidgetMode ? '' : `<nav class="beautify-color-variant" aria-label="CSS 显示模式">
        <button class="${cssVariant === 'light' ? 'is-active' : ''}" data-css-variant="light">常规 CSS</button>
        <button class="${cssVariant === 'dark' ? 'is-active' : ''}" data-css-variant="dark">夜间覆盖</button>
      </nav>`}
      <section class="beautify-panel beautify-ai-panel">
        <div class="beautify-ai-head">
          <div class="beautify-ai-mode">
            <button class="${state.assistantMode !== 'character' ? 'is-active' : ''}" data-ai-mode="designer">设计助手</button>
            <button class="${state.assistantMode === 'character' ? 'is-active' : ''}" data-ai-mode="character">和角色一起装修</button>
          </div>
          <select class="beautify-character-select" aria-label="选择角色"><option value="">选择角色</option></select>
          <button class="beautify-ai-clear" data-ai-clear>清空对话</button>
        </div>
        ${isWidgetMode ? '' : `<div class="beautify-ai-base">
          <select data-ai-base aria-label="选择现有方案作为修改基础">
            <option value="">选择现有方案作为修改基础</option>
          </select>
          <button data-ai-base-load disabled>载入</button>
          <small data-ai-base-status>${css.trim() ? `当前草稿 ${css.length.toLocaleString('zh-CN')} 字，发送时自动带入` : '尚未载入基础方案'}</small>
        </div>`}
        ${!isWidgetMode && cssVariant === 'dark' ? `<button class="beautify-dark-generate" data-dark-adapt-generate>${icon('sparkle')} 生成夜间适配</button>` : ''}
        <div class="beautify-ai-messages" aria-live="polite"></div>
        <div class="beautify-ai-compose">
          <textarea placeholder="${isWidgetMode ? '描述一个新组件，例如可换照片的拍立得、时钟、票根…' : '描述想修改的细节；当前 CSS 草稿会自动作为基础，无需粘贴代码'}"></textarea>
          <div class="beautify-compose-bar">
            <button data-ai-attach aria-label="发参考图">${icon('image')}</button>
            <span class="beautify-attach-chip" hidden>已附参考图<button data-ai-attach-clear aria-label="移除参考图">×</button></span>
            <span class="beautify-compose-spacer"></span>
            <button data-ai-expand aria-label="展开输入框">${icon('expand')}</button>
            <button class="is-send" data-ai-send>${icon('send')} 发送</button>
          </div>
          <input type="file" accept="image/*" data-ai-image hidden>
        </div>
      </section>
      ${isWidgetMode ? `<section class="beautify-panel beautify-widget-workbench">
        <div class="beautify-panel-heading"><h2>组件工作台</h2><div><button data-widget-doc>${icon('download')} 参考文档</button><button data-widget-new>${icon('plus')} 新建</button></div></div>
        <input type="hidden" data-widget-id>
        <div class="beautify-widget-fields">
          <label><span>名称</span><input type="text" data-widget-name value="新组件" maxlength="40"></label>
          <label><span>放在</span><select data-widget-page></select></label>
          <label><span>宽</span><select data-widget-cols><option value="1">1 格</option><option value="2" selected>2 格</option><option value="3">3 格</option><option value="4">4 格</option></select></label>
          <label><span>高</span><select data-widget-rows><option value="1" selected>1 格</option><option value="2">2 格</option><option value="3">3 格</option><option value="4">4 格</option></select></label>
        </div>
        ${['sea', 'window'].includes(homeTemplateKey) ? `<div class="beautify-widget-colors">
          <label class="beautify-widget-color-toggle"><input type="checkbox" data-widget-colors-enabled> 快捷改色</label>
          <label><span>卡面</span><input type="color" data-widget-color-background value="#ffffff"></label>
          <label><span>文字</span><input type="color" data-widget-color-text value="#36586a"></label>
          <label><span>强调</span><input type="color" data-widget-color-accent value="#d29a3f"></label>
          <label><span>底面</span><select data-widget-surface><option value="solid">纯色</option><option value="transparent">透明</option><option value="light-glass">轻玻璃</option><option value="glass">毛玻璃</option></select></label>
          <label class="beautify-widget-opacity"><span>透明度 <output data-widget-opacity-output>100%</output></span><input type="range" min="0" max="100" value="100" data-widget-opacity></label>
        </div>` : ''}
        <p class="beautify-widget-size-hint">占格对齐主屏图标网格：拖动时可和图标互换位置。</p>
        <textarea class="beautify-widget-html" data-widget-html spellcheck="false" placeholder="AI 生成的 HTML 会填到这里，也可以直接编辑。组件内部可包含自己的 <style>。"></textarea>
        <div class="beautify-widget-draft-preview" data-widget-draft-preview>
          <div class="beautify-widget-draft-stage" data-widget-draft-stage>
            <div class="beautify-widget-draft-renderer" data-widget-draft-renderer></div>
          </div>
        </div>
        <div class="beautify-widget-actions">
          <button data-widget-clear>清空</button>
          <button class="is-primary" data-widget-save>${icon('save')} 添加到主屏</button>
        </div>
        <div class="beautify-widget-library" data-widget-library><p class="beautify-empty">正在读取自定义组件…</p></div>
      </section>` : ''}
      <section class="beautify-panel beautify-preview-panel">
        <div class="beautify-panel-heading"><h2>预览</h2><div class="beautify-preview-actions">${target.id === 'home' ? `<button data-home-clear-layout title="内置组件全部隐藏、图标收到最后一页，从零开始排主屏">${icon('trash')} 清空布局</button><button data-home-reset-layout title="布局与内置组件回到当前主题默认">${icon('refresh')} 复位布局</button>` : ''}<button data-preview-refresh>${icon('refresh')} 刷新</button><button data-real-preview title="带着当前草稿打开真实页面，可正常滑动交互，返回即回到工作室">${icon('expand')} 整页体验</button></div></div>
        ${target.id === 'chat-thread' ? `<label class="beautify-preview-chat"><span>预览会话</span><select data-preview-chat aria-label="预览会话"><option value="">正在读取…</option></select></label>` : ''}
        <div class="beautify-device is-compact"><div class="beautify-preview-root"><div class="beautify-preview-loading">正在加载真实页面…</div></div></div>
        <div class="beautify-preview-meta" data-preview-meta aria-live="polite"></div>
        ${target.id === 'home' ? `<div class="beautify-preview-pager" data-preview-pager hidden>
          <button data-preview-page-prev aria-label="上一页">${icon('back')}</button>
          <span data-preview-page-label>第 1 页</span>
          <button data-preview-page-next aria-label="下一页">${icon('chevron')}</button>
        </div>` : ''}
      </section>
      ${isHome ? '' : `<details class="beautify-panel beautify-collapse" data-collapse="tree">
        <summary>选组件微调（可选）</summary>
        <div class="beautify-tree">${componentTree(target)}</div>
      </details>`}
      ${isWidgetMode ? '' : `<details class="beautify-panel beautify-collapse" data-collapse="css">
        <summary>${cssVariant === 'dark' ? '夜间覆盖 CSS' : 'CSS 草稿与发布'}</summary>
        <div class="beautify-css-tools">
          <button data-css-insert-image>${icon('image')} 上传/替换图片</button>
          <button data-css-replace-image-url>${icon('link')} 替换为图床链接</button>
          <button data-css-import-published>${icon('download')} 导入已发布</button>
          ${target.id === 'chat-thread' ? `<button data-chat-layout-repair title="保留颜色、头像框等美化，只补回我方在右、对方在左的消息结构">${icon('refresh')} 修复消息左右布局</button>` : ''}
          ${target.id === 'chat-hub' ? `<button data-chat-hub-effect-test aria-pressed="false" title="只在预览中临时加上醒目的底色与描边，不会写进草稿或发布">${icon('zap')} 测试是否生效</button>` : ''}
          <button data-css-clear title="只清编辑器里的草稿，线上已发布的样式还在">清空草稿</button>
          <button data-css-clear-published title="${target.id === 'chat-thread' ? '清除主题里全局聊天 CSS；各会话详情里单独套用的美化不受影响' : '清除这页已发布到 App 的 CSS'}">清除已发布</button>
          <input type="file" accept="image/*" data-css-image-file hidden>
        </div>
        <textarea class="beautify-css-area" spellcheck="false" placeholder="在这里编写当前页面 CSS，改动实时进预览">${esc(css)}</textarea>
        <div class="beautify-editor-actions">
          <button data-export title="下载当前 CSS 文件">${icon('download')} 导出</button>
          <button data-share-css title="直接带到应用商店发布">${icon('share')} 分享到应用商店</button>
          <button data-save-preset title="存档到工作室首页「保存的方案」，之后可随时打开回填">${icon('package')} 保存方案</button>
          <button data-save-component title="把选中部分存成可复用组件">${icon('select')} 存为组件</button>
          ${target.id === 'chat-thread' && cssVariant === 'light' ? `
          <button data-publish title="所有会话统一套用这段 CSS；单个会话自己的美化仍优先">${icon('save')} 全局生效</button>
          <button class="is-primary" data-save-chat-preset title="存成聊天美化预设，在单个会话的「美化」里按需套用，不影响其它会话">${icon('check')} 存为聊天预设</button>
          ` : `
          <button class="is-primary" data-publish title="让这页 CSS 在整个 App 真正生效，替换这页上一次发布">${icon('save')} ${cssVariant === 'dark' ? '发布夜间覆盖' : '发布生效'}</button>
          `}
        </div>
      </details>`}
      ${(target.vars?.length || target.id === 'chat-thread') ? `
      <details class="beautify-panel beautify-collapse" data-collapse="detail">
        <summary>细节控件</summary>
        ${target.id === 'chat-thread' ? `<div class="beautify-frame-presets"><h3>头像框</h3>${BUILTIN_AVATAR_FRAMES.map((frame) => `<button data-avatar-frame="${esc(frame.id)}">${esc(frame.name)}</button>`).join('')}</div>` : ''}
        <div class="beautify-properties">${propertyControls(target, css)}</div>
      </details>` : ''}
    </main>`;
  applyBeautifyPreviewCss(css, target.id);
}

function renderExtensionEditor(container, state) {
  container.innerHTML = `
    <header class="beautify-navbar">
      <button class="beautify-icon-btn" data-studio-home aria-label="返回">${icon('back')}</button>
      <div><h1>扩展组件</h1><small>聊天与线下叙事内容卡</small></div>
      <button class="beautify-icon-btn" data-open-extension-library aria-label="打开扩展库">${icon('package')}</button>
    </header>
    <main class="beautify-editor beautify-extension-editor">
      <section class="beautify-panel beautify-ai-panel">
        <div class="beautify-ai-head">
          <div class="beautify-ai-mode">
            <button class="${state.assistantMode !== 'character' ? 'is-active' : ''}" data-ai-mode="designer">设计助手</button>
            <button class="${state.assistantMode === 'character' ? 'is-active' : ''}" data-ai-mode="character">和角色一起设计</button>
          </div>
          <select class="beautify-character-select" aria-label="选择角色"><option value="">选择角色</option></select>
          <button class="beautify-ai-clear" data-ai-clear>清空对话</button>
        </div>
        <div class="beautify-extension-starters" aria-label="示例起步">
          ${HTML_EXTENSION_STARTERS.map((item) => `<button data-extension-starter="${esc(item.id)}">${esc(item.label)}</button>`).join('')}
        </div>
        <div class="beautify-ai-messages" aria-live="polite"></div>
        <div class="beautify-ai-compose">
          <textarea placeholder="描述卡片内容、字段和感觉，例如：一张能展开配送详情的外卖订单卡"></textarea>
          <div class="beautify-compose-bar">
            <button data-ai-attach aria-label="发参考图">${icon('image')}</button>
            <span class="beautify-attach-chip" hidden>已附参考图<button data-ai-attach-clear aria-label="移除参考图">×</button></span>
            <span class="beautify-compose-spacer"></span>
            <button data-ai-expand aria-label="展开输入框">${icon('expand')}</button>
            <button class="is-send" data-ai-send>${icon('send')} 发送</button>
          </div>
          <input type="file" accept="image/*" data-ai-image hidden>
        </div>
      </section>

      <section class="beautify-panel beautify-extension-workbench">
        <div class="beautify-panel-heading">
          <h2>组件工作台</h2>
          <button data-extension-reset>${icon('plus')} 新建</button>
        </div>
        <input type="hidden" data-extension-id>
        <div class="beautify-extension-fields">
          <label class="is-name"><span>名称</span><input type="text" data-extension-name value="新扩展组件" maxlength="50"></label>
          <label><span>触发方式</span><select data-extension-trigger><option value="keywords">关键词触发</option><option value="always">始终可用</option></select></label>
          <fieldset>
            <legend>用于</legend>
            <label><input type="checkbox" value="chat" data-extension-target checked> 聊天</label>
            <label><input type="checkbox" value="offline" data-extension-target checked> 线下</label>
          </fieldset>
          <label class="is-wide" data-extension-keywords-field><span>关键词</span><input type="text" data-extension-keywords placeholder="外卖、点餐、快递"></label>
          <label class="is-wide"><span>内容规则</span><textarea data-extension-prompt rows="2" placeholder="触发后，角色应该填写哪些内容"></textarea></label>
        </div>
        <div class="beautify-extension-stage">
          <div class="beautify-extension-code">
            <label><span>HTML / CSS</span><textarea data-extension-html spellcheck="false">${esc(DEFAULT_HTML_EXTENSION_TEMPLATE)}</textarea></label>
          </div>
          <div class="beautify-extension-preview">
            <div class="beautify-extension-preview-head">
              <span>实际效果</span>
              <button data-extension-refresh>${icon('refresh')} 刷新</button>
            </div>
            <div class="beautify-extension-samples">
              <input type="text" data-extension-sample-title value="订单正在配送" aria-label="预览标题">
              <input type="text" data-extension-sample-name value="林屿" aria-label="预览角色名">
              <textarea data-extension-sample-content rows="4" aria-label="预览正文">骑手已取餐，预计 20 分钟后送达。少糖奶茶 × 1，海盐蛋糕 × 1。</textarea>
            </div>
            <div class="beautify-extension-preview-canvas">
              <div data-html-extension-host="extension-preview"></div>
            </div>
          </div>
        </div>
        <div class="beautify-widget-actions">
          <button data-open-extension-library>打开扩展库</button>
          <button class="is-primary" data-extension-save>${icon('save')} 保存到扩展库</button>
        </div>
      </section>
    </main>`;
}

function renderInnerVoiceEditor(container, state, card = {}) {
  const draft = normalizeInnerVoiceCard(card, 'ins');
  container.innerHTML = `
    <header class="beautify-navbar">
      <button class="beautify-icon-btn" data-studio-home aria-label="返回">${icon('back')}</button>
      <div><h1>心声</h1><small>字段、数值与状态卡</small></div>
      <button class="beautify-icon-btn" data-inner-voice-doc aria-label="下载参考文档">${icon('download')}</button>
    </header>
    <main class="beautify-editor beautify-inner-voice-editor">
      <section class="beautify-panel beautify-ai-panel">
        <div class="beautify-ai-head">
          <div class="beautify-ai-mode"><button class="is-active">AI 辅助自定义</button></div>
          <button class="beautify-ai-clear" data-ai-clear>清空对话</button>
        </div>
        <div class="beautify-ai-messages" aria-live="polite"></div>
        <div class="beautify-ai-compose">
          <textarea placeholder="描述想要的字段、数值范围和风格，例如：亲密度 0–100、戒备值 0–10、未说出口的话；做成克制的 ins 状态栏"></textarea>
          <div class="beautify-compose-bar">
            <button data-ai-attach aria-label="发参考图">${icon('image')}</button>
            <span class="beautify-attach-chip" hidden>已附参考图<button data-ai-attach-clear aria-label="移除参考图">×</button></span>
            <span class="beautify-compose-spacer"></span>
            <button data-ai-expand aria-label="展开输入框">${icon('expand')}</button>
            <button class="is-send" data-ai-send>${icon('send')} 发送</button>
          </div>
          <input type="file" accept="image/*" data-ai-image hidden>
        </div>
      </section>
      <section class="beautify-panel beautify-inner-voice-workbench">
        <div class="beautify-panel-heading"><h2>心声方案</h2><button data-inner-voice-reset>${icon('refresh')} 清空</button></div>
        <div class="beautify-inner-voice-fields">
          <label><span>方案名称</span><input type="text" data-inner-voice-name maxlength="40" value="AI 心声方案"></label>
          <label><span>卡片骨架</span><select data-inner-voice-template><option value="ins" ${draft.template === 'ins' ? 'selected' : ''}>ins 小白卡</option><option value="diary" ${draft.template === 'diary' ? 'selected' : ''}>奶油手账</option></select></label>
          <label><span>弹出位置</span><select data-inner-voice-position><option value="center" ${draft.position === 'center' ? 'selected' : ''}>居中</option><option value="top" ${draft.position === 'top' ? 'selected' : ''}>顶部</option><option value="bottom" ${draft.position === 'bottom' ? 'selected' : ''}>底部</option></select></label>
          <label class="is-wide"><span>生成要求</span><textarea data-inner-voice-prompt rows="5" maxlength="4000" placeholder="AI 应生成哪些字段、数值范围和规则">${esc(draft.generationPrompt)}</textarea></label>
          <label class="is-wide"><span>内容 HTML</span><textarea data-inner-voice-html rows="7" maxlength="12000" spellcheck="false">${esc(draft.templateHtml)}</textarea></label>
          <label class="is-wide"><span>弹层 CSS</span><textarea data-inner-voice-css rows="9" spellcheck="false">${esc(draft.css)}</textarea></label>
          <label class="is-wide"><span>消息内心声 CSS</span><textarea data-inner-voice-inline-css rows="6" spellcheck="false">${esc(draft.inlineCss)}</textarea></label>
          <label class="beautify-inner-voice-toggle"><input type="checkbox" data-inner-voice-inline-enabled ${draft.inlineEnabled ? 'checked' : ''}> 消息内显示心声</label>
        </div>
        <div class="beautify-widget-actions">
          <button data-inner-voice-import>${icon('upload')} 导入 JSON</button>
          <button class="is-primary" data-inner-voice-save>${icon('save')} 保存为心声预设</button>
          <input type="file" accept=".json,.txt,application/json,text/plain" data-inner-voice-file hidden>
        </div>
      </section>
      <section class="beautify-panel beautify-preview-panel">
        <div class="beautify-panel-heading"><h2>预览</h2><button data-inner-voice-preview-refresh>${icon('refresh')} 刷新</button></div>
        <div class="beautify-inner-voice-preview" data-inner-voice-preview></div>
      </section>
    </main>`;
}

async function fileToDataUrl(file) {
  if (!file || !file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) throw new Error('请选择 5MB 以内的图片');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

const BEAUTIFY_WIP_SEEN_KEY = 'mm_beautify_wip_seen_session';

function maybeShowBeautifyWipPrompt(container) {
  if (!container || window.top !== window.self) return;
  try {
    if (sessionStorage.getItem(BEAUTIFY_WIP_SEEN_KEY) === '1') return;
  } catch (_) {}
  if (document.querySelector('[data-beautify-wip-overlay]')) return;

  const host = document.createElement('div');
  host.className = 'beautify-wip-host';
  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center beautify-wip-overlay" data-beautify-wip-overlay>
      <div class="modal-sheet scrapbook-card beautify-wip-sheet" role="dialog" aria-modal="true" aria-labelledby="beautify-wip-title">
        <header class="modal-header">
          <h3 id="beautify-wip-title">美化工作室 · 预览版</h3>
        </header>
        <div class="modal-body beautify-wip-body">
          <p>当前仍是半成品，可能有 bug 和手感问题。</p>
          <p>部分页面与组件界面尚未开放，正在优化中。</p>
        </div>
        <footer class="modal-footer beautify-wip-footer">
          <button type="button" class="btn btn-primary" data-beautify-wip-ok>知道了</button>
        </footer>
      </div>
    </div>
  `;

  const close = () => {
    try { sessionStorage.setItem(BEAUTIFY_WIP_SEEN_KEY, '1'); } catch (_) {}
    host.remove();
  };
  host.querySelector('[data-beautify-wip-overlay]')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  host.querySelector('.beautify-wip-sheet')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-beautify-wip-ok]')?.addEventListener('click', close);
  document.body.appendChild(host);
}

export default async function render(container, params = {}) {
  container.className = 'page beautify-studio-page';
  if (window.top !== window.self) {
    container.innerHTML = '<div class="beautify-embed-note">预览窗口内无法再打开美化工作室，请回到外层编辑。</div>';
    return;
  }
  if (globalThis.__MM_BEAUTIFY_PREVIEW_COLOR_MODE__) {
    globalThis.__MM_BEAUTIFY_PREVIEW_COLOR_MODE__ = '';
    const restoredPrefs = await loadAppearancePrefs().catch(() => null);
    if (restoredPrefs) applyAppearanceColorMode(restoredPrefs.colorMode);
  }
  let state = await loadBeautifyStudioState();
  let globalWallpaper = await getGlobalChatWallpaper().catch(() => ({ src: '', opacity: 100 }));
  const isExtensionMode = params.mode === 'extension';
  const isInnerVoiceMode = params.mode === 'inner-voice';
  let target = isExtensionMode
    ? HTML_EXTENSION_TARGET
    : (isInnerVoiceMode ? INNER_VOICE_TARGET : (params.target ? getBeautifyTarget(params.target) : null));
  const appearanceAtOpen = await loadAppearancePrefs().catch(() => null);
  const activeThemeAtOpen = appearanceAtOpen ? getActiveTheme(appearanceAtOpen) : null;
  const activeThemeId = String(activeThemeAtOpen?.id || '').trim();
  const activeHomeTemplateKey = resolveHomeTemplateKey(activeThemeAtOpen?.theme);
  let homeMode = target?.id === 'home' && params.mode === 'widget' ? 'widget' : 'theme';
  let cssVariant = !isExtensionMode && params.variant === 'dark' ? 'dark' : 'light';
  let selectedComponent = null;
  let attachedImage = '';
  const chatStorageKey = () => (isExtensionMode
    ? 'html-extension'
    : isInnerVoiceMode
      ? 'inner-voice'
    : (target?.id === 'home' && homeMode === 'widget'
      ? 'home-widget'
      : `${target?.id || ''}${cssVariant === 'dark' ? ':dark' : ''}`));
  let chatHistory = target ? (state.chats?.[chatStorageKey()] || []) : [];
  let generating = false;
  let previewRoute = null;
  let previewChats = [];
  let selectedPreviewChatId = target?.id === 'chat-thread' ? String(params.chatId || '').trim() : '';
  let chatHubEffectTest = false;
  const aiBaseCss = new Map();
  let innerVoiceDraft = normalizeInnerVoiceCard(state.innerVoiceDraft, 'ins');

  if (globalThis.__MM_BEAUTIFY_ROUTE_CLEANUP__) {
    window.removeEventListener('marshmallow-route-activated', globalThis.__MM_BEAUTIFY_ROUTE_CLEANUP__);
  }
  globalThis.__MM_BEAUTIFY_ROUTE_CLEANUP__ = (event) => {
    if (event.detail?.path === 'beautify') return;
    if (globalThis.__MM_BEAUTIFY_REAL_PREVIEW__) {
      globalThis.__MM_BEAUTIFY_REAL_PREVIEW__ = false;
      return;
    }
    clearBeautifyPreviewCss();
    document.querySelector('.beautify-wip-host')?.remove();
  };
  window.addEventListener('marshmallow-route-activated', globalThis.__MM_BEAUTIFY_ROUTE_CLEANUP__);

  const draftStorageKey = (targetId = target?.id) => themeScopedDraftKey(targetId, activeThemeId);
  const currentDrafts = () => (cssVariant === 'dark' ? state.darkDrafts : state.drafts);
  const variantOptions = () => ({ variant: cssVariant });

  // 旧版把所有主题的同一页面混在一个 target key 里。新主题首次打开时从它自己的已发布
  // 样式建立独立草稿；旧 key 原样保留，避免为了修预览而丢掉用户尚未整理的历史 CSS。
  if (target && !isExtensionMode && !isInnerVoiceMode) {
    const key = draftStorageKey();
    const slot = currentDrafts();
    if (key && !Object.prototype.hasOwnProperty.call(slot, key)) {
      const published = await getPublishedBeautifyCss(target.id, variantOptions()).catch(() => '');
      await saveBeautifyDraft(key, published, variantOptions());
      state = await loadBeautifyStudioState();
    }
  }

  const draw = () => {
    if (isExtensionMode) renderExtensionEditor(container, state);
    else if (isInnerVoiceMode) renderInnerVoiceEditor(container, state, innerVoiceDraft);
    else if (target) renderEditor(container, state, target, homeMode, cssVariant, draftStorageKey(), activeHomeTemplateKey);
    else {
      clearBeautifyPreviewCss();
      renderHome(container, state, globalWallpaper, activeThemeId);
    }
    bind();
  };

  const currentCss = () => container.querySelector('.beautify-css-area')?.value || currentDrafts()?.[draftStorageKey()] || '';

  const updateAiBaseStatus = (label = '') => {
    const status = container.querySelector('[data-ai-base-status]');
    if (!status) return;
    const css = currentCss();
    status.textContent = css.trim()
      ? `${label || '当前草稿'} ${css.length.toLocaleString('zh-CN')} 字，发送时自动带入`
      : '尚未载入基础方案';
  };

  const chatPresetCss = (preset = {}) => [
    preset.css,
    preset.userBubbleCss,
    preset.charBubbleCss,
  ].map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');

  const populateAiBaseOptions = async () => {
    const select = container.querySelector('[data-ai-base]');
    const loadButton = container.querySelector('[data-ai-base-load]');
    if (!select || !target || homeMode === 'widget' || isExtensionMode) return;
    const entries = [];
    const published = await getPublishedBeautifyCss(target.id, variantOptions()).catch(() => '');
    if (published.trim()) entries.push({ label: '已发布样式', css: published });
    const variantDrafts = cssVariant === 'dark' ? state.darkDrafts : state.drafts;
    const legacyDraft = draftStorageKey() !== target.id
      ? String(variantDrafts?.[target.id] || '').trim()
      : '';
    if (legacyDraft) entries.push({ label: '旧版未归属草稿', css: legacyDraft });
    (state.presets || [])
      .filter((preset) => preset.target === target.id
        && (preset.variant || 'light') === cssVariant
        && String(preset.css || '').trim())
      .forEach((preset) => entries.push({ label: `工作室 · ${preset.name}`, css: preset.css }));
    if (target.id === 'chat-thread') {
      const presets = await loadChatAppearancePresets().catch(() => []);
      presets.forEach((preset) => {
        const css = chatPresetCss(preset);
        if (css) entries.push({ label: `聊天预设 · ${preset.name}`, css });
      });
    } else if (target.id === 'offline') {
      const user = await ensureDefaultUser().catch(() => null);
      const presets = user?.id ? await listOfflineStylePresets(user.id).catch(() => []) : [];
      presets.forEach((preset) => {
        const css = String(preset?.style?.css || '').trim();
        if (css) entries.push({ label: `线下预设 · ${preset.name}`, css });
      });
    }
    const seenCss = new Set();
    aiBaseCss.clear();
    const options = [];
    entries.forEach((entry) => {
      const css = String(entry.css || '');
      if (!css.trim() || seenCss.has(css)) return;
      seenCss.add(css);
      const key = `base-${options.length}`;
      aiBaseCss.set(key, { ...entry, css });
      options.push(`<option value="${key}">${esc(entry.label)}</option>`);
    });
    select.innerHTML = `<option value="">选择现有方案作为修改基础</option>${options.join('')}`;
    select.disabled = options.length === 0;
    if (loadButton) loadButton.disabled = true;
    if (!options.length && !currentCss().trim()) {
      const status = container.querySelector('[data-ai-base-status]');
      if (status) status.textContent = '还没有可载入的方案';
    }
  };

  const resetWidgetWorkbench = () => {
    const id = container.querySelector('[data-widget-id]');
    const name = container.querySelector('[data-widget-name]');
    const html = container.querySelector('[data-widget-html]');
    const cols = container.querySelector('[data-widget-cols]');
    const rows = container.querySelector('[data-widget-rows]');
    if (id) id.value = '';
    if (name) name.value = '新组件';
    if (html) html.value = '';
    if (cols) cols.value = '2';
    if (rows) rows.value = '1';
    const colorsEnabled = container.querySelector('[data-widget-colors-enabled]');
    if (colorsEnabled) colorsEnabled.checked = false;
    const surface = container.querySelector('[data-widget-surface]');
    const opacity = container.querySelector('[data-widget-opacity]');
    if (surface) surface.value = 'solid';
    if (opacity) opacity.value = '100';
    const colorDefaults = { background: '#ffffff', text: '#36586a', accent: '#d29a3f' };
    Object.entries(colorDefaults).forEach(([key, value]) => {
      const field = container.querySelector(`[data-widget-color-${key}]`);
      if (field) value && (field.value = value);
    });
    const save = container.querySelector('[data-widget-save]');
    if (save) save.innerHTML = `${icon('save')} 添加到主屏`;
    hydrateWidgetDraftPreview();
  };

  const hydrateWidgetDraftPreview = () => {
    const host = container.querySelector('[data-widget-draft-preview]');
    const stage = host?.querySelector('[data-widget-draft-stage]');
    const renderer = stage?.querySelector('[data-widget-draft-renderer]');
    if (!host || !stage || !renderer) return;
    const html = String(container.querySelector('[data-widget-html]')?.value || '').trim();
    const cols = Math.max(1, Math.min(4, Number(container.querySelector('[data-widget-cols]')?.value || 2)));
    const rows = Math.max(1, Math.min(4, Number(container.querySelector('[data-widget-rows]')?.value || 1)));
    const enabled = container.querySelector('[data-widget-colors-enabled]')?.checked === true;
    const background = container.querySelector('[data-widget-color-background]')?.value || '#ffffff';
    const text = container.querySelector('[data-widget-color-text]')?.value || '#36586a';
    const accent = container.querySelector('[data-widget-color-accent]')?.value || '#d29a3f';
    const surface = container.querySelector('[data-widget-surface]')?.value || 'solid';
    const opacity = Math.max(0, Math.min(100, Number(container.querySelector('[data-widget-opacity]')?.value ?? 100)));
    const opacityOutput = container.querySelector('[data-widget-opacity-output]');
    if (opacityOutput) opacityOutput.textContent = `${opacity}%`;
    const rgb = [1, 3, 5].map((offset) => Number.parseInt(background.slice(offset, offset + 2), 16));
    const alpha = surface === 'transparent' ? 0 : opacity / 100;
    const filter = surface === 'glass' ? 'blur(18px) saturate(120%)' : (surface === 'light-glass' ? 'blur(10px) saturate(112%)' : 'none');
    host.style.setProperty('--mm-widget-shell-bg', `rgba(${rgb.join(',')},${alpha})`);
    host.style.setProperty('--mm-widget-shell-filter', filter);
    host.style.setProperty('--mm-widget-text', text);
    host.style.setProperty('--mm-widget-accent', accent);
    stage.style.width = `${cols * 25}%`;
    stage.style.maxWidth = `${cols * 90}px`;
    stage.style.aspectRatio = `${cols} / ${rows}`;
    let shadow = renderer.shadowRoot;
    if (!shadow) shadow = renderer.attachShadow({ mode: 'open' });
    const quickCss = enabled ? `<style>:host{color:var(--mm-widget-text)}:host>:not(style){color:inherit;background:var(--mm-widget-shell-bg)!important;-webkit-backdrop-filter:var(--mm-widget-shell-filter,none);backdrop-filter:var(--mm-widget-shell-filter,none)}:host :where(p,span,small,strong,em,b,i,u,h1,h2,h3,h4,li,summary){color:var(--mm-widget-text)!important}:host :where(a,button,[data-accent]){color:var(--mm-widget-accent)!important}</style>` : '';
    const stageResetCss = '<style>:host{display:block!important;width:100%!important;height:100%!important;min-width:0!important;min-height:0!important;max-width:100%!important;max-height:100%!important;box-sizing:border-box!important;overflow:hidden!important;position:relative!important;border-radius:14px!important}:host *,:host *::before,:host *::after{box-sizing:border-box}</style>';
    shadow.innerHTML = html
      ? `${sanitizeWidgetHtml(html)}${quickCss}${stageResetCss}`
      : `${stageResetCss}<style>:host{display:grid!important;place-items:center;color:#8b969d;font:12px system-ui}</style>填写组件后预览`;
  };

  const readExtensionWorkbench = () => {
    if (!isExtensionMode) return null;
    return normalizeHtmlExtension({
      id: container.querySelector('[data-extension-id]')?.value || undefined,
      name: container.querySelector('[data-extension-name]')?.value || '新扩展组件',
      targets: [...container.querySelectorAll('[data-extension-target]:checked')].map((input) => input.value),
      triggerMode: container.querySelector('[data-extension-trigger]')?.value,
      keywords: container.querySelector('[data-extension-keywords]')?.value || '',
      prompt: container.querySelector('[data-extension-prompt]')?.value || '',
      templateHtml: container.querySelector('[data-extension-html]')?.value || DEFAULT_HTML_EXTENSION_TEMPLATE,
    });
  };

  const hydrateExtensionPreview = () => {
    const draft = readExtensionWorkbench();
    const host = container.querySelector('[data-html-extension-host="extension-preview"]');
    if (!draft || !host) return;
    const snapshot = createHtmlExtensionSnapshot(draft, {
      title: container.querySelector('[data-extension-sample-title]')?.value || draft.name,
      content: container.querySelector('[data-extension-sample-content]')?.value || '预览内容',
      name: container.querySelector('[data-extension-sample-name]')?.value || '角色名',
    });
    if (!snapshot) return;
    hydrateHtmlExtensionHosts(container, { 'extension-preview': snapshot });
  };

  const resetExtensionWorkbench = () => {
    if (!isExtensionMode) return;
    const setValue = (selector, value) => {
      const field = container.querySelector(selector);
      if (field) field.value = value;
    };
    setValue('[data-extension-id]', '');
    setValue('[data-extension-name]', '新扩展组件');
    setValue('[data-extension-trigger]', 'keywords');
    setValue('[data-extension-keywords]', '');
    setValue('[data-extension-prompt]', '');
    setValue('[data-extension-html]', DEFAULT_HTML_EXTENSION_TEMPLATE);
    container.querySelectorAll('[data-extension-target]').forEach((input) => { input.checked = true; });
    const save = container.querySelector('[data-extension-save]');
    if (save) save.innerHTML = `${icon('save')} 保存到扩展库`;
    const keywordsField = container.querySelector('[data-extension-keywords-field]');
    if (keywordsField) keywordsField.hidden = false;
    hydrateExtensionPreview();
  };

  const populateWidgetWorkbench = async () => {
    const library = container.querySelector('[data-widget-library]');
    const pageSelect = container.querySelector('[data-widget-page]');
    if (!library || !pageSelect) return;
    const prefs = await loadAppearancePrefs();
    const active = getActiveTheme(prefs);
    const layout = normalizeHomeLayout(active.theme?.homeLayout, active.theme?.widgetVisibility);
    const currentPage = Number(pageSelect.value) || 0;
    pageSelect.innerHTML = layout.pages.map((_, index) => `<option value="${index}">第 ${index + 1} 页</option>`).join('');
    pageSelect.value = String(Math.min(currentPage, layout.pages.length - 1));
    const items = Object.values(layout.customItems || {});
    library.innerHTML = items.length ? items.map((item) => {
      const pageIndex = layout.pages.findIndex((page) => page.includes(item.id));
      return `<article>
        <span><strong>${esc(item.label || item.title || '自定义组件')}</strong><small>${pageIndex >= 0 ? `当前主题·第 ${pageIndex + 1} 页` : '未放入当前主题'} · ${item.size?.cols || 2}×${item.size?.rows || 1}</small></span>
        <span class="beautify-widget-library-actions">
          <button data-widget-home="${esc(item.id)}:${pageIndex >= 0 ? 'hide' : 'show'}">${pageIndex >= 0 ? '移出当前主题' : '添加到当前主题'}</button>
          <button data-widget-edit="${esc(item.id)}">编辑</button>
        </span>
      </article>`;
    }).join('') : '<p class="beautify-empty">还没有自定义组件。让 AI 生成一个，或直接在上方写 HTML。</p>';
    library.querySelectorAll('[data-widget-home]').forEach((button) => button.addEventListener('click', async () => {
      const [itemId, action] = String(button.dataset.widgetHome || '').split(':');
      if (!itemId) return;
      try {
        await setWidgetTemplateHomeVisible(itemId, action === 'show');
        showToast(action === 'show' ? '已添加到当前主题末页' : '已移出当前主题，组件仍保留在组件库');
        await populateWidgetWorkbench();
        await mountPreview();
      } catch (error) {
        showToast(error?.message || '组件状态更新失败');
      }
    }));
    library.querySelectorAll('[data-widget-edit]').forEach((button) => button.addEventListener('click', () => {
      const item = layout.customItems[button.dataset.widgetEdit];
      if (!item) return;
      container.querySelector('[data-widget-id]').value = item.id;
      container.querySelector('[data-widget-name]').value = item.label || item.title || '自定义组件';
      container.querySelector('[data-widget-html]').value = item.html || '';
      container.querySelector('[data-widget-cols]').value = String(item.size?.cols || 2);
      container.querySelector('[data-widget-rows]').value = String(item.size?.rows || 1);
      const colorsEnabled = container.querySelector('[data-widget-colors-enabled]');
      if (colorsEnabled) colorsEnabled.checked = item.quickColors?.enabled === true;
      ['background', 'text', 'accent'].forEach((key) => {
        const field = container.querySelector(`[data-widget-color-${key}]`);
        if (field && item.quickColors?.[key]) field.value = item.quickColors[key];
      });
      const surface = container.querySelector('[data-widget-surface]');
      const opacity = container.querySelector('[data-widget-opacity]');
      if (surface) surface.value = item.quickColors?.surface || 'solid';
      if (opacity) opacity.value = String(item.quickColors?.opacity ?? 100);
      container.querySelector('[data-widget-page]').value = String(Math.max(0, layout.pages.findIndex((page) => page.includes(item.id))));
      container.querySelector('[data-widget-save]').innerHTML = `${icon('save')} 更新组件`;
      hydrateWidgetDraftPreview();
      container.querySelector('.beautify-widget-workbench')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }));
  };

  const previewDoc = () => {
    try {
      return container.querySelector('.beautify-preview-frame')?.contentDocument || null;
    } catch (_) {
      return null;
    }
  };

  // 真实 App 在原生壳里会通过桥接把状态栏 / 手势区写入 --native-safe-*。
  // 工作室 iframe 为了避免重复启动原生桥会跳过这一步，若不从外层复制最终像素值，
  // 预览的独立安全区槽就是 0，聊天顶栏会比实际页面少一截。不能直接读取自定义属性：
  // Safari 常会返回未解析的 max(env(...), …)；用临时尺寸探针取得最终布局值才可靠。
  const resolvePreviewSafeInset = (side) => {
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = `position:fixed!important;left:-9999px!important;top:-9999px!important;width:1px!important;height:var(--safe-${side})!important;visibility:hidden!important;pointer-events:none!important;`;
    document.body.appendChild(probe);
    try {
      return `${Math.max(0, Math.round(probe.getBoundingClientRect().height * 100) / 100)}px`;
    } finally {
      probe.remove();
    }
  };

  const syncPreviewSafeArea = () => {
    const root = previewDoc()?.documentElement;
    if (!root) return;
    ['top', 'right', 'bottom', 'left'].forEach((side) => {
      root.style.setProperty(`--native-safe-${side}`, resolvePreviewSafeInset(side));
    });
  };

  const previewCssFor = (css) => {
    const draft = cssVariant === 'dark'
      ? [state.drafts?.[draftStorageKey(target?.id)] || '', String(css || '')].filter((item) => item.trim()).join('\n\n')
      : String(css || '');
    return target?.id === 'chat-hub' && chatHubEffectTest
      ? `${draft}\n\n${CHAT_HUB_EFFECT_TEST_CSS}`
      : draft;
  };

  const forcePreviewColorMode = (doc) => {
    if (!doc?.documentElement) return;
    const resolved = cssVariant === 'dark' ? 'dark' : 'light';
    const root = doc.documentElement;
    if (root.dataset.colorModePreference !== resolved) root.dataset.colorModePreference = resolved;
    if (root.dataset.colorMode !== resolved) root.dataset.colorMode = resolved;
    if (root.style.colorScheme !== resolved) root.style.colorScheme = resolved;
    root.classList.toggle('theme-dark', resolved === 'dark');
    doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved);
    const darkStyle = doc.getElementById('marshmallow-page-dark-css');
    if (darkStyle) darkStyle.media = resolved === 'dark' ? 'all' : 'not all';
  };

  // 实装聊天页的层叠顺序是“主题 / 全局美化 → 当前会话 CSS”。工作室草稿
  // 过去一律占据 head 最后一层，导致装饰块在预览正常、发布后却被会话规则放大。
  // 聊天预览保持与实装相同的顺序；其它页面仍让草稿位于最后。
  const syncPreviewCssCascade = (doc = previewDoc()) => {
    if (!doc?.head) return;
    const draftStyle = doc.getElementById('marshmallow-beautify-preview');
    if (!draftStyle) return;
    const sessionStyle = target?.id === 'chat-thread'
      ? doc.getElementById('marshmallow-chat-thread-css')
      : null;
    if (!sessionStyle) {
      if (doc.head.lastElementChild !== draftStyle) doc.head.appendChild(draftStyle);
      return;
    }
    if (doc.head.lastElementChild !== sessionStyle) doc.head.appendChild(sessionStyle);
    if (draftStyle.nextElementSibling !== sessionStyle) doc.head.insertBefore(draftStyle, sessionStyle);
  };

  const pushCssToPreview = async (css) => {
    const previewCss = previewCssFor(css);
    const doc = previewDoc();
    const [, previewResult] = await Promise.all([
      applyBeautifyPreviewCss(previewCss, target?.id),
      applyBeautifyPreviewCssToDocument(doc, previewCss, target?.id),
    ]);
    syncPreviewCssCascade(doc);
    if (doc?.head && previewCss.trim() && previewResult?.applied && previewResult.ruleCount === 0) {
      throw new Error('这段 CSS 没有可解析的样式规则，请检查代码是否完整');
    }
    return previewResult;
  };

  const setCss = async (css) => {
    const value = String(css || '');
    const area = container.querySelector('.beautify-css-area');
    if (area) area.value = value;
    if (target?.id) currentDrafts()[draftStorageKey()] = value;
    updateAiBaseStatus();
    return pushCssToPreview(value);
  };

  const highlightSelected = () => {
    const doc = previewDoc();
    if (!doc) return;
    doc.querySelectorAll('.is-beautify-selected').forEach((node) => node.classList.remove('is-beautify-selected'));
    if (!selectedComponent) return;
    const selector = selectedComponent.cls.split(' / ')[0].split(',')[0].trim();
    try {
      const el = doc.querySelector(selector);
      if (el) {
        el.classList.add('is-beautify-selected');
        el.scrollIntoView({ block: 'nearest' });
      }
    } catch (_) {}
  };

  const resolvePreviewRoute = async () => {
    if (!target) return null;
    if (target.id === 'chat-thread') {
      const user = await ensureDefaultUser().catch(() => null);
      previewChats = user?.id
        ? await listInboxChatsForUser(user.id).catch(() => [])
        : [];
      const best = pickBeautifyPreviewChat(previewChats, selectedPreviewChatId);
      selectedPreviewChatId = String(best?.id || '');
      if (selectedPreviewChatId && String(params.chatId || '') !== selectedPreviewChatId) {
        params.chatId = selectedPreviewChatId;
        syncCurrentRoute('beautify', {
          ...params,
          target: target.id,
          ...(cssVariant === 'dark' ? { variant: 'dark' } : {}),
          chatId: selectedPreviewChatId,
        });
      }
      const select = container.querySelector('[data-preview-chat]');
      if (select) {
        const sorted = sortChatsForInbox(previewChats).filter((chat) => (
          chat?.id
          && Array.isArray(chat.participants)
          && chat.participants.includes('user')
        ));
        select.innerHTML = sorted.length
          ? sorted.map((chat, index) => `<option value="${esc(chat.id)}">${esc(beautifyPreviewChatLabel(chat, index))}</option>`).join('')
          : '<option value="">还没有聊天会话</option>';
        select.value = selectedPreviewChatId;
        select.disabled = !sorted.length;
      }
      return best ? {
        path: 'chat/thread',
        params: {
          chatId: best.id,
          beautifyPreview: '1',
        },
      } : null;
    }
    if (target.id === 'offline') {
      const auStoryId = params.preview === 'au' ? String(params.id || '').trim() : '';
      if (auStoryId) {
        return { path: 'encounter/au-theater', params: { id: auStoryId } };
      }
      const chats = await db.getAllRecords('chats').catch(() => []);
      const sorted = chats
        .filter((chat) => chat?.id)
        .sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0));
      for (const chat of sorted) {
        const session = await loadOfflineSession(chat.id).catch(() => null);
        if (session?.status === 'active') {
          return { path: 'offline', params: { chatId: chat.id } };
        }
      }
      return null;
    }
    return { path: target.route, params: {} };
  };

  const syncPreviewViewport = () => {
    const rootEl = container.querySelector('.beautify-preview-root');
    const deviceEl = rootEl?.closest('.beautify-device');
    if (!rootEl || !deviceEl) return;
    const viewport = resolvePreviewViewport();
    rootEl.style.width = `${viewport.width}px`;
    rootEl.style.height = `${viewport.height}px`;
    const applyScale = () => {
      const availableWidth = deviceEl.clientWidth || viewport.width;
      const scale = Math.min(1, availableWidth / viewport.width);
      rootEl.style.setProperty('--beautify-preview-scale', String(scale));
      deviceEl.style.height = `${Math.ceil(viewport.height * scale)}px`;
      const meta = container.querySelector('[data-preview-meta]');
      if (meta) meta.textContent = `本机 ${viewport.width}px · ${Math.round(scale * 100)}% 缩略 · 可滑动预览`;
    };
    applyScale();
    requestAnimationFrame(applyScale);
  };

  const mountPreview = async () => {
    const rootEl = container.querySelector('.beautify-preview-root');
    if (!rootEl || !target) return;
    syncPreviewViewport();
    previewRoute = await resolvePreviewRoute();
    if (!previewRoute) {
      rootEl.innerHTML = target.id === 'offline'
        ? '<div class="beautify-preview-empty">还没有可预览的线下或番外。开始一场后，就能在这里对照真实页面编辑。</div>'
        : '<div class="beautify-preview-empty">还没有聊天会话。先去消息页开一个聊天，再回来装修。</div>';
      return;
    }
    rootEl.innerHTML = `<div class="beautify-preview-loading">正在加载真实页面…</div><iframe class="beautify-preview-frame" title="真实页面预览" src="${esc(buildPreviewSrc(previewRoute))}"></iframe>`;
    const frame = rootEl.querySelector('iframe');
    frame?.addEventListener('load', () => {
      syncPreviewViewport();
      const doc = previewDoc();
      if (!doc?.head) return;
      const childWindow = frame.contentWindow;
      let readyTimer = 0;
      const finishPreviewLoad = () => {
        if (readyTimer) clearTimeout(readyTimer);
        rootEl.querySelector('.beautify-preview-loading')?.remove();
        setTimeout(highlightSelected, 80);
        setTimeout(initPreviewPager, 120);
      };
      if (childWindow?.__MARSHMALLOW_BOOT_OK) {
        finishPreviewLoad();
      } else {
        childWindow?.addEventListener('marshmallow-app-ready', finishPreviewLoad, { once: true });
        readyTimer = setTimeout(() => {
          const loading = rootEl.querySelector('.beautify-preview-loading');
          if (loading) loading.textContent = '预览启动较慢，可点“刷新”重试';
        }, 12_000);
      }
      let style = doc.getElementById(PREVIEW_EMBED_STYLE_ID);
      if (!style) {
        style = doc.createElement('style');
        style.id = PREVIEW_EMBED_STYLE_ID;
        doc.head.appendChild(style);
      }
      style.textContent = PREVIEW_EMBED_STYLE;
      syncPreviewSafeArea();
      forcePreviewColorMode(doc);
      applyBeautifyPreviewCssToDocument(doc, previewCssFor(currentCss()), target.id)
        .then(() => syncPreviewCssCascade(doc))
        .catch((error) => {
          const loading = rootEl.querySelector('.beautify-preview-loading');
          if (loading) loading.textContent = error?.message || 'CSS 预览加载失败，可点“刷新”重试';
        });
      // app 启动过程中仍会追加主题或会话样式，持续恢复与实装一致的层叠顺序。
      const keepPreviewCascade = new MutationObserver(() => syncPreviewCssCascade(doc));
      keepPreviewCascade.observe(doc.head, { childList: true });
      const keepColorMode = new MutationObserver(() => forcePreviewColorMode(doc));
      keepColorMode.observe(doc.documentElement, {
        attributes: true,
        attributeFilter: ['data-color-mode', 'data-color-mode-preference', 'class', 'style'],
      });
    });
  };

  // 主屏预览分页器：保留外部按钮方便精确翻页，同时缩略 iframe 也支持手势滑动。
  const initPreviewPager = () => {
    const pager = container.querySelector('[data-preview-pager]');
    if (!pager) return;
    const doc = previewDoc();
    const wrap = doc?.querySelector('[data-sea-pages], .home-pages-container');
    const pageCount = wrap ? wrap.querySelectorAll(':scope > .sea-page, :scope > .home-page').length : 0;
    if (!wrap || pageCount < 2) {
      pager.hidden = true;
      return;
    }
    pager.hidden = false;
    const label = pager.querySelector('[data-preview-page-label]');
    const pageIndex = () => Math.round(wrap.scrollLeft / Math.max(1, wrap.clientWidth));
    const sync = () => {
      if (label) label.textContent = `第 ${pageIndex() + 1} / ${pageCount} 页`;
    };
    const go = (dir) => {
      const next = Math.max(0, Math.min(pageCount - 1, pageIndex() + dir));
      wrap.scrollTo({ left: next * wrap.clientWidth, behavior: 'smooth' });
      setTimeout(sync, 400);
    };
    pager.querySelector('[data-preview-page-prev]').onclick = () => go(-1);
    pager.querySelector('[data-preview-page-next]').onclick = () => go(1);
    wrap.addEventListener('scroll', () => {
      clearTimeout(pager.__syncTimer);
      pager.__syncTimer = setTimeout(sync, 150);
    }, { passive: true });
    sync();
  };

  const openCollapse = (name) => {
    const details = container.querySelector(`[data-collapse="${name}"]`);
    if (details) details.open = true;
  };

  const populateCharacters = async () => {
    const select = container.querySelector('.beautify-character-select');
    if (!select) return;
    // 论坛路人会以隐藏匿名角色落库，不能进入用户主动选择角色的功能。
    const user = await ensureDefaultUser().catch(() => null);
    const characters = await listCharacters({
      excludeAnonNpc: true,
      userId: user?.id || '',
    }).catch(() => []);
    select.insertAdjacentHTML('beforeend', characters.slice(0, 100).map((char) => `<option value="${esc(char.id)}">${esc(char.customNickname || char.name || '未命名角色')}</option>`).join(''));
  };

  const populateAssets = async () => {
    const list = container.querySelector('.beautify-asset-list');
    if (!list) return;
    const assets = await listBeautifyAssets().catch(() => []);
    list.innerHTML = assets.length ? assets.map((asset) => `<article>
      <span class="beautify-asset-thumb">${asset.type === 'image' ? `<img src="${esc(asset.dataUrl)}" alt="">` : icon('package')}</span>
      <span><strong>${esc(asset.name)}</strong><small>${asset.type === 'image' ? beautifyAssetUrl(asset.id) : `${esc(getBeautifyTarget(asset.target).label)}组件`}</small></span>
      ${asset.type === 'image' ? `<button data-copy-asset="${esc(asset.id)}">复制 URL</button>` : `<span class="beautify-asset-buttons"><button data-install-component="${esc(asset.id)}">添加</button><button data-export-component="${esc(asset.id)}">导出</button><button data-share-component="${esc(asset.id)}" title="分享到应用商店">分享</button></span>`}
      <button data-delete-asset="${esc(asset.id)}" aria-label="删除">${icon('trash')}</button>
    </article>`).join('') : '<p class="beautify-empty">上传图片，或把选中的 CSS 保存为组件。</p>';
    list.querySelectorAll('[data-copy-asset]').forEach((button) => button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(`url("${beautifyAssetUrl(button.dataset.copyAsset)}")`);
      showToast('CSS 素材 URL 已复制');
    }));
    list.querySelectorAll('[data-export-component]').forEach((button) => button.addEventListener('click', async () => {
      try {
        const json = await exportBeautifyComponent(button.dataset.exportComponent);
        await downloadText(json, `marshmallow-component-${Date.now()}.json`, 'application/json');
        showToast('组件已导出');
      } catch (error) {
        showToast(`导出失败：${error?.message || error}`);
      }
    }));
    list.querySelectorAll('[data-share-component]').forEach((button) => button.addEventListener('click', async () => {
      try {
        const json = await exportBeautifyComponent(button.dataset.shareComponent);
        const source = JSON.parse(json);
        shareToCommunityStore({ source, fileName: 'marshmallow-component.json', resourceType: 'beautify', resourceSubtype: 'home-widget', title: source.name || source.component?.name || '主屏组件', originLabel: '美化工作室组件库' });
      } catch (error) {
        showToast(`无法分享：${error?.message || error}`);
      }
    }));
    list.querySelectorAll('[data-install-component]').forEach((button) => button.addEventListener('click', async () => {
      await installBeautifyComponentOnHome(button.dataset.installComponent);
      showToast('已添加到主屏，可在主屏编辑模式拖动');
    }));
    list.querySelectorAll('[data-delete-asset]').forEach((button) => button.addEventListener('click', async () => {
      await deleteBeautifyAsset(button.dataset.deleteAsset);
      populateAssets();
    }));
  };

  const bind = () => {
    container.querySelector('[data-back]')?.addEventListener('click', back);
    container.querySelector('[data-studio-home]')?.addEventListener('click', () => {
      clearBeautifyPreviewCss();
      // 用收栈方式回工作室首页，避免编辑器↔首页来回 push 导致返回键鬼打墙。
      navigateDismissing('beautify', {}, { dismissPaths: ['beautify'] });
    });
    container.querySelectorAll('[data-open-target]').forEach((button) => button.addEventListener('click', () => navigate('beautify', { target: button.dataset.openTarget })));
    container.querySelector('[data-open-extension]')?.addEventListener('click', () => navigate('beautify', { mode: 'extension' }));
    container.querySelector('[data-open-inner-voice]')?.addEventListener('click', () => navigate('beautify', { mode: 'inner-voice' }));
    container.querySelectorAll('[data-open-extension-library]').forEach((button) => button.addEventListener('click', () => navigate('extensions')));
    container.querySelectorAll('[data-home-mode]').forEach((button) => button.addEventListener('click', async () => {
      const nextMode = button.dataset.homeMode === 'widget' ? 'widget' : 'theme';
      if (nextMode === homeMode || generating) return;
      state = await saveBeautifyChat(chatStorageKey(), chatHistory);
      homeMode = nextMode;
      selectedComponent = null;
      chatHistory = state.chats?.[chatStorageKey()] || [];
      draw();
    }));
    container.querySelectorAll('[data-css-variant]').forEach((button) => button.addEventListener('click', async () => {
      const nextVariant = button.dataset.cssVariant === 'dark' ? 'dark' : 'light';
      if (nextVariant === cssVariant || generating || !target) return;
      await saveBeautifyDraft(draftStorageKey(), currentCss(), variantOptions());
      await saveBeautifyChat(chatStorageKey(), chatHistory);
      navigate('beautify', {
        target: target.id,
        variant: nextVariant,
        ...(selectedPreviewChatId ? { chatId: selectedPreviewChatId } : {}),
      }, true);
    }));
    container.querySelector('[data-dark-adapt-generate]')?.addEventListener('click', () => {
      const input = container.querySelector('.beautify-ai-compose textarea');
      if (!input) return;
      input.value = '基于当前常规 CSS 生成完整夜间适配：保留布局、图片和风格，只调整底色、文字、边框、阴影与控件状态，确保对比度和可读性。';
      input.focus();
      container.querySelector('[data-ai-send]')?.click();
    });
    container.querySelector('[data-widget-new]')?.addEventListener('click', resetWidgetWorkbench);
    container.querySelector('[data-widget-doc]')?.addEventListener('click', async () => {
      try {
        await downloadText(
          buildBeautifyWidgetReferenceMarkdown(),
          `marshmallow-home-widget-reference-${Date.now()}.md`,
          'text/markdown',
        );
        showToast('装饰组件参考文档已下载');
      } catch (error) {
        showToast(`下载失败：${error?.message || error}`);
      }
    });
    container.querySelector('[data-widget-clear]')?.addEventListener('click', resetWidgetWorkbench);
    container.querySelectorAll('[data-widget-html],[data-widget-cols],[data-widget-rows],[data-widget-colors-enabled],[data-widget-color-background],[data-widget-color-text],[data-widget-color-accent],[data-widget-surface],[data-widget-opacity]').forEach((field) => {
      field.addEventListener('input', hydrateWidgetDraftPreview);
      field.addEventListener('change', hydrateWidgetDraftPreview);
    });
    container.querySelector('[data-widget-surface]')?.addEventListener('change', (event) => {
      const opacity = container.querySelector('[data-widget-opacity]');
      if (!opacity) return;
      const suggested = { transparent: 0, 'light-glass': 42, glass: 24 }[event.target.value];
      if (suggested != null) opacity.value = String(suggested);
      else if (Number(opacity.value) === 0) opacity.value = '100';
      hydrateWidgetDraftPreview();
    });
    hydrateWidgetDraftPreview();
    container.querySelector('[data-widget-save]')?.addEventListener('click', async () => {
      const id = String(container.querySelector('[data-widget-id]')?.value || '').trim();
      const name = String(container.querySelector('[data-widget-name]')?.value || '').trim() || '自定义组件';
      const html = String(container.querySelector('[data-widget-html]')?.value || '').trim();
      const pageIndex = Number(container.querySelector('[data-widget-page]')?.value || 0);
      const size = {
        cols: Number(container.querySelector('[data-widget-cols]')?.value || 2),
        rows: Number(container.querySelector('[data-widget-rows]')?.value || 1),
      };
      const quickColors = {
        enabled: container.querySelector('[data-widget-colors-enabled]')?.checked === true,
        background: container.querySelector('[data-widget-color-background]')?.value || '#ffffff',
        text: container.querySelector('[data-widget-color-text]')?.value || '#36586a',
        accent: container.querySelector('[data-widget-color-accent]')?.value || '#d29a3f',
        surface: container.querySelector('[data-widget-surface]')?.value || 'solid',
        opacity: Number(container.querySelector('[data-widget-opacity]')?.value ?? 100),
      };
      if (!html) {
        showToast('先让 AI 生成组件，或在 HTML 编辑框里填写内容');
        return;
      }
      try {
        if (id) await updateWidgetTemplateOnHome(id, { name, html, pageIndex, size, quickColors });
        else await installWidgetTemplateOnHome({ name, html, pageIndex, size, quickColors });
        showToast(id ? `「${name}」已更新并移到第 ${pageIndex + 1} 页` : `「${name}」已添加到第 ${pageIndex + 1} 页`);
        resetWidgetWorkbench();
        await populateWidgetWorkbench();
        await mountPreview();
      } catch (error) {
        showToast(error.message || '组件保存失败');
      }
    });
    container.querySelector('[data-extension-reset]')?.addEventListener('click', resetExtensionWorkbench);
    container.querySelector('[data-extension-trigger]')?.addEventListener('change', (event) => {
      const field = container.querySelector('[data-extension-keywords-field]');
      if (field) field.hidden = event.target.value === 'always';
    });
    container.querySelectorAll([
      '[data-extension-name]',
      '[data-extension-keywords]',
      '[data-extension-prompt]',
      '[data-extension-html]',
      '[data-extension-sample-title]',
      '[data-extension-sample-name]',
      '[data-extension-sample-content]',
      '[data-extension-target]',
    ].join(',')).forEach((field) => field.addEventListener('input', () => {
      clearTimeout(container.__extensionPreviewTimer);
      container.__extensionPreviewTimer = setTimeout(hydrateExtensionPreview, 120);
    }));
    container.querySelector('[data-extension-refresh]')?.addEventListener('click', hydrateExtensionPreview);
    container.querySelector('[data-extension-save]')?.addEventListener('click', async () => {
      const checkedTargets = container.querySelectorAll('[data-extension-target]:checked');
      if (!checkedTargets.length) {
        showToast('至少选择聊天或线下中的一个');
        return;
      }
      const triggerMode = container.querySelector('[data-extension-trigger]')?.value;
      const keywords = String(container.querySelector('[data-extension-keywords]')?.value || '').trim();
      if (triggerMode === 'keywords' && !keywords) {
        showToast('关键词触发需要填写至少一个关键词');
        container.querySelector('[data-extension-keywords]')?.focus();
        return;
      }
      const rawHtml = String(container.querySelector('[data-extension-html]')?.value || '').trim();
      if (!rawHtml) {
        showToast('先生成或填写 HTML / CSS 模板');
        return;
      }
      try {
        const saved = await upsertHtmlExtension(readExtensionWorkbench());
        container.querySelector('[data-extension-id]').value = saved.id;
        container.querySelector('[data-extension-html]').value = saved.templateHtml;
        container.querySelector('[data-extension-save]').innerHTML = `${icon('save')} 更新扩展组件`;
        hydrateExtensionPreview();
        showToast(`「${saved.name}」已保存到扩展库`);
      } catch (error) {
        showToast(error.message || '扩展组件保存失败');
      }
    });
    container.querySelectorAll('[data-extension-starter]').forEach((button) => button.addEventListener('click', () => {
      const starter = HTML_EXTENSION_STARTERS.find((item) => item.id === button.dataset.extensionStarter);
      const input = container.querySelector('.beautify-ai-compose textarea');
      if (!starter || !input) return;
      input.value = starter.prompt;
      input.focus();
    }));
    container.querySelectorAll('[data-load-preset]').forEach((button) => button.addEventListener('click', () => {
      const preset = state.presets.find((item) => item.id === button.dataset.loadPreset);
      if (!preset) return;
      const presetVariant = preset.variant === 'dark' ? 'dark' : 'light';
      const slot = presetVariant === 'dark' ? state.darkDrafts : state.drafts;
      const presetDraftKey = themeScopedDraftKey(preset.target, activeThemeId);
      slot[presetDraftKey] = preset.css;
      saveBeautifyDraft(presetDraftKey, preset.css, { variant: presetVariant })
        .then(() => navigate('beautify', { target: preset.target, variant: presetVariant }));
    }));
    container.querySelectorAll('[data-share-preset]').forEach((button) => button.addEventListener('click', () => {
      const preset = state.presets.find((item) => item.id === button.dataset.sharePreset);
      if (!preset?.css?.trim()) { showToast('这个方案没有可分享的 CSS'); return; }
      const presetTarget = getBeautifyTarget(preset.target);
      const presetName = String(preset.name || '').trim() || `${presetTarget.label}美化`;
      shareToCommunityStore({
        source: { name: presetName, cssText: preset.css, target: preset.target },
        fileName: `${safeBeautifyFilename(presetName)}.json`,
        resourceType: 'beautify',
        resourceSubtype: communityBeautifySubtype(preset.target),
        title: presetName,
        originLabel: '美化工作室方案',
      });
    }));
    container.querySelectorAll('[data-delete-preset]').forEach((button) => button.addEventListener('click', async () => {
      state = await deleteBeautifyPreset(button.dataset.deletePreset);
      draw();
    }));
    container.querySelectorAll('[data-emergency]').forEach((button) => button.addEventListener('click', async () => {
      state = await setAllCustomCssDisabled(!state.disabled);
      showToast(state.disabled ? '已临时停用全部自定义 CSS（内容还在，可随时恢复）' : '已恢复自定义美化');
      draw();
    }));
    container.querySelectorAll('[data-install-template]').forEach((button) => button.addEventListener('click', async () => {
      const template = getBeautifyWidgetTemplate(button.dataset.installTemplate);
      if (!template) return;
      await installWidgetTemplateOnHome(template);
      showToast(`「${template.name}」已加到主屏最后一页，长按主屏可删除或换页`);
    }));
    container.querySelector('[data-upload-asset]')?.addEventListener('click', () => container.querySelector('[data-asset-file]')?.click());
    container.querySelector('[data-add-asset-url]')?.addEventListener('click', async () => {
      const url = window.prompt('粘贴 HTTPS 图片直链');
      if (url == null) return;
      try {
        const record = await saveBeautifyImageUrl(url, '外链素材');
        await navigator.clipboard.writeText(`url("${beautifyAssetUrl(record.id)}")`).catch(() => {});
        showToast(record.remote
          ? '直链已加入素材库，CSS URL 已复制'
          : '图片已固化到本地素材库，CSS URL 已复制');
        populateAssets();
      } catch (error) {
        showToast(error.message || '直链添加失败');
      }
    });
    container.querySelector('[data-asset-file]')?.addEventListener('change', async (event) => {
      try {
        const record = await saveBeautifyImage(event.target.files?.[0]);
        await navigator.clipboard.writeText(beautifyAssetUrl(record.id)).catch(() => {});
        showToast('图片已保存，素材 URL 已复制');
        populateAssets();
      } catch (error) {
        showToast(error.message || '上传失败');
      }
    });
    container.querySelector('[data-import-component]')?.addEventListener('click', () => container.querySelector('[data-component-file]')?.click());
    container.querySelector('[data-component-file]')?.addEventListener('change', async (event) => {
      try {
        const text = await event.target.files?.[0]?.text();
        await importBeautifyComponent(text);
        showToast('组件已导入');
        populateAssets();
      } catch (error) {
        showToast(error.message || '导入失败');
      }
    });
    container.querySelector('[data-community-import]')?.addEventListener('click', async () => {
      const url = window.prompt('粘贴社区资源 API 地址');
      if (!url) return;
      try {
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`下载失败（${response.status}）`);
        const payload = await response.json();
        const resource = payload.resource || payload;
        const css = String(resource.css || resource.cssText || '');
        const resourceTarget = getBeautifyTarget(resource.target || 'chat-thread').id;
        if (!css) throw new Error('资源中没有 CSS');
        await saveBeautifyPreset({ name: resource.title || resource.name || '社区美化', target: resourceTarget, css });
        await saveBeautifyDraft(themeScopedDraftKey(resourceTarget, activeThemeId), css);
        showToast('社区美化已导入');
        navigate('beautify', { target: resourceTarget });
      } catch (error) {
        showToast(error.message || '社区资源导入失败');
      }
    });
    container.querySelector('[data-community-open]')?.addEventListener('click', () => {
      const url = window.prompt('社区地址', 'https://');
      if (url && /^https:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
    });
    container.querySelector('[data-global-wallpaper-file]')?.addEventListener('click', () => container.querySelector('[data-global-wallpaper-input]')?.click());
    container.querySelector('[data-global-wallpaper-url]')?.addEventListener('input', (event) => {
      globalWallpaper.src = event.target.value.trim();
    });
    container.querySelector('[data-global-wallpaper-input]')?.addEventListener('change', async (event) => {
      try {
        globalWallpaper.src = await fileToDataUrl(event.target.files?.[0]);
        const preview = container.querySelector('.beautify-wallpaper-preview');
        if (preview) preview.style.backgroundImage = `url("${globalWallpaper.src.replace(/"/g, '\\"')}")`;
      } catch (error) {
        showToast(error.message || '图片读取失败');
      }
    });
    container.querySelector('[data-global-wallpaper-save]')?.addEventListener('click', async () => {
      const opacity = container.querySelector('[data-global-wallpaper-opacity]')?.value;
      globalWallpaper = await setGlobalChatWallpaper(globalWallpaper.src, opacity);
      showToast('全局聊天壁纸已保存');
    });
    container.querySelector('[data-global-wallpaper-clear]')?.addEventListener('click', async () => {
      globalWallpaper = await setGlobalChatWallpaper('', 100);
      showToast('已清除全局聊天壁纸');
      draw();
    });
    populateAssets();
    if (!target) return;

    populateCharacters();
    populateWidgetWorkbench();
    if (isExtensionMode) hydrateExtensionPreview();
    else if (!isInnerVoiceMode) mountPreview();
    container.querySelectorAll('[data-component]').forEach((button) => button.addEventListener('click', () => {
      const already = selectedComponent?.cls === button.dataset.component;
      selectedComponent = already ? null : { cls: button.dataset.component, label: button.dataset.componentLabel };
      container.querySelectorAll('[data-component]').forEach((item) => item.classList.toggle('is-selected', !already && item === button));
      const locator = container.querySelector('.beautify-locator');
      if (locator) locator.textContent = selectedComponent ? `局部微调：${selectedComponent.label}` : '整页模式（未选组件）';
      highlightSelected();
    }));
    container.querySelector('[data-preview-refresh]')?.addEventListener('click', () => mountPreview());
    container.querySelector('[data-preview-chat]')?.addEventListener('change', async (event) => {
      selectedPreviewChatId = String(event.target.value || '').trim();
      await mountPreview();
    });
    // 主屏布局操作放进工作室：不用回到主屏长按也能清空/复位（与主屏编辑模式共用同一份布局数据）
    const persistHomeLayout = async (mutate) => {
      const prefs = await loadAppearancePrefs();
      const active = getActiveTheme(prefs);
      const current = normalizeHomeLayout(active.theme.homeLayout, active.theme.widgetVisibility);
      const { layout, visibility, themePatch } = mutate(current, { ...(active.theme.widgetVisibility || {}) });
      await saveAppearancePrefs({
        ...prefs,
        themes: {
          ...prefs.themes,
          [active.id]: {
            ...active.theme,
            ...(themePatch || {}),
            widgetVisibility: visibility,
            homeLayout: normalizeHomeLayout(layout, visibility),
          },
        },
      });
      await mountPreview();
    };
    container.querySelector('[data-home-clear-layout]')?.addEventListener('click', async () => {
      if (!window.confirm('清空主屏布局？内置组件全部隐藏、App 图标收到最后一页（Dock 保留），适合从零开始重新排。想找回内置组件用旁边的「复位布局」或「美化设置 → 主屏组件」。')) return;
      const alsoWallpaper = window.confirm('壁纸也一起清掉吗？\n「确定」= 壁纸恢复成纯净底色；「取消」= 保留当前壁纸');
      await persistHomeLayout((current, visibility) => {
        Object.keys(BUILTIN_HOME_WIDGET_DEFS).forEach((id) => { visibility[id] = false; });
        return {
          layout: { ...current, pages: [current.pages.flat().filter((id) => current.customItems?.[id])] },
          visibility,
          themePatch: alsoWallpaper ? { wallpaper: WALLPAPER_NONE, homePageWallpapers: {}, homePanorama: null } : null,
        };
      });
      showToast('已清空，图标收在最后一页；可长按真实主屏拖动排布');
    });
    container.querySelector('[data-home-reset-layout]')?.addEventListener('click', async () => {
      if (!window.confirm('复位主屏布局？内置组件全部恢复显示，图标顺序回到当前主题默认（自定义组件保留，收在最后一页）。')) return;
      const prefs = await loadAppearancePrefs();
      const active = getActiveTheme(prefs);
      const defaultTheme = getThemeResetDefaults(active.id, active.theme);
      const defaultLayout = normalizeHomeLayout(defaultTheme.homeLayout, defaultTheme.widgetVisibility);
      await persistHomeLayout((current) => {
        const customIds = current.pages.flat().filter((id) => current.customItems?.[id]);
        const pages = defaultLayout.pages.map((page) => page.slice());
        if (customIds.length) pages[pages.length - 1].push(...customIds);
        return {
          layout: {
            ...current,
            pages,
            dock: defaultLayout.dock.slice(),
          },
          visibility: { ...(defaultTheme.widgetVisibility || {}) },
        };
      });
      showToast('布局已复位');
    });
    const setComposeExpanded = (expanded) => {
      const compose = container.querySelector('.beautify-ai-compose');
      const expandBtn = compose?.querySelector('[data-ai-expand]');
      if (!compose || !expandBtn) return;
      compose.classList.toggle('is-expanded', expanded);
      expandBtn.innerHTML = expanded ? icon('close') : icon('expand');
      expandBtn.setAttribute('aria-label', expanded ? '收起输入框' : '展开输入框');
      if (expanded) compose.querySelector('textarea')?.focus();
    };
    container.querySelector('[data-ai-expand]')?.addEventListener('click', () => {
      setComposeExpanded(!container.querySelector('.beautify-ai-compose')?.classList.contains('is-expanded'));
    });
    container.querySelector('.beautify-ai-compose textarea')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setComposeExpanded(false);
    });
    container.querySelector('[data-ai-base]')?.addEventListener('change', (event) => {
      const button = container.querySelector('[data-ai-base-load]');
      if (button) button.disabled = !aiBaseCss.has(event.target.value);
    });
    container.querySelector('[data-ai-base-load]')?.addEventListener('click', async () => {
      const key = container.querySelector('[data-ai-base]')?.value || '';
      const base = aiBaseCss.get(key);
      if (!base) return;
      const current = currentCss();
      if (current.trim() && current !== base.css
        && !window.confirm(`用「${base.label}」替换当前 CSS 草稿，作为后续修改基础？`)) return;
      await setCss(base.css);
      await saveBeautifyDraft(draftStorageKey(), base.css, variantOptions());
      openCollapse('css');
      updateAiBaseStatus(base.label);
      showToast(`已载入「${base.label}」，直接描述要改的细节即可`);
    });
    container.querySelector('.beautify-css-area')?.addEventListener('input', (event) => {
      currentDrafts()[draftStorageKey()] = event.target.value;
      pushCssToPreview(event.target.value).catch(() => {});
      updateAiBaseStatus();
      clearTimeout(container.__beautifySaveTimer);
      container.__beautifySaveTimer = setTimeout(
        () => saveBeautifyDraft(draftStorageKey(), event.target.value, variantOptions()),
        350,
      );
    });
    container.querySelector('[data-css-insert-image]')?.addEventListener('click', () => container.querySelector('[data-css-image-file]')?.click());
    const insertOrReplaceCssImage = (imageUrl) => {
      const area = container.querySelector('.beautify-css-area');
      if (!area) return false;
      const result = replaceBeautifyCssImageSelection(
        area.value,
        area.selectionStart ?? area.value.length,
        area.selectionEnd ?? area.selectionStart ?? area.value.length,
        imageUrl,
      );
      area.value = result.cssText;
      area.focus();
      area.setSelectionRange(result.selectionStart, result.selectionEnd);
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return result.replacedExistingUrl;
    };
    container.querySelector('[data-css-image-file]')?.addEventListener('change', async (event) => {
      try {
        const record = await saveBeautifyImage(event.target.files?.[0]);
        const replaced = insertOrReplaceCssImage(beautifyAssetUrl(record.id));
        showToast(replaced ? '原图片链接已完整替换' : '图片已入库并插入 CSS');
      } catch (error) {
        showToast(error.message || '上传失败');
      } finally {
        event.target.value = '';
      }
    });
    container.querySelector('[data-css-replace-image-url]')?.addEventListener('click', async () => {
      const source = window.prompt('粘贴新的 HTTPS 图片直链');
      if (source == null) return;
      try {
        const record = await saveBeautifyImageUrl(source, 'CSS 替换图片');
        const replaced = insertOrReplaceCssImage(beautifyAssetUrl(record.id));
        showToast(replaced ? '原图片链接已完整替换' : '图片链接已插入 CSS');
      } catch (error) {
        showToast(error.message || '图片链接替换失败');
      }
    });
    container.querySelector('[data-css-import-published]')?.addEventListener('click', async () => {
      const published = await getPublishedBeautifyCss(target.id, variantOptions()).catch(() => '');
      if (!published.trim()) {
        showToast('当前主题还没有已发布的这页 CSS');
        return;
      }
      if (currentCss().trim() && !window.confirm('用已发布的 CSS 替换当前草稿？')) return;
      await setCss(published);
      await saveBeautifyDraft(draftStorageKey(), published, variantOptions());
      showToast('已把线上 CSS 导入草稿');
    });
    container.querySelector('[data-css-clear]')?.addEventListener('click', async () => {
      if (!currentCss().trim()) return;
      if (!window.confirm('清空这页的 CSS 草稿？已发布的样式不受影响。')) return;
      await setCss('');
      await saveBeautifyDraft(draftStorageKey(), '', variantOptions());
      showToast('草稿已清空');
    });
    container.querySelector('[data-css-clear-published]')?.addEventListener('click', async () => {
      const published = await getPublishedBeautifyCss(target.id, variantOptions()).catch(() => '');
      const hasDraft = !!currentCss().trim();
      if (!published.trim() && !hasDraft) {
        showToast('这页没有已发布的 CSS，草稿也是空的');
        return;
      }
      const chatHint = target.id === 'chat-thread'
        ? '\n（只清主题全局聊天样式；各会话详情里单独套用的美化不会动。）'
        : '';
      if (!window.confirm(`清除「${target.label}」已发布的 CSS？这会立刻从 App 里拿掉这段样式。${chatHint}\n草稿也会一起清空。`)) return;
      await clearPublishedBeautifyCss(target.id, variantOptions());
      await setCss('');
      await saveBeautifyDraft(draftStorageKey(), '', variantOptions());
      clearBeautifyPreviewCss();
      showToast(`已清除「${target.label}」的已发布 CSS`);
    });
    container.querySelector('[data-chat-layout-repair]')?.addEventListener('click', async () => {
      const baseCss = currentCss().trim()
        ? currentCss()
        : await getPublishedBeautifyCss(target.id, variantOptions()).catch(() => '');
      const repaired = withChatMessageLayoutRepair(baseCss);
      await setCss(repaired);
      await saveBeautifyDraft(draftStorageKey(), repaired, variantOptions());
      showToast('已补回我方在右、对方在左；预览确认后再发布');
    });
    container.querySelector('[data-chat-hub-effect-test]')?.addEventListener('click', (event) => {
      chatHubEffectTest = !chatHubEffectTest;
      const button = event.currentTarget;
      button.classList.toggle('is-active', chatHubEffectTest);
      button.setAttribute('aria-pressed', String(chatHubEffectTest));
      button.innerHTML = `${icon(chatHubEffectTest ? 'close' : 'zap')} ${chatHubEffectTest ? '结束生效测试' : '测试是否生效'}`;
      pushCssToPreview(currentCss()).catch(() => {});
      showToast(chatHubEffectTest
        ? '预览应变成黄底粉色描边；测试样式不会写入草稿'
        : '已结束生效测试，恢复当前草稿预览');
    });
    container.querySelectorAll('[data-color-var]').forEach((picker) => picker.addEventListener('input', () => {
      const input = container.querySelector(`[data-var="${picker.dataset.colorVar}"]`);
      if (!input) return;
      input.value = picker.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    container.querySelectorAll('[data-var]').forEach((input) => input.addEventListener('input', () => {
      const declarations = [...container.querySelectorAll('[data-var]')]
        .map((item) => ({ key: item.dataset.var, value: String(item.value || '').trim() }))
        .filter((item) => item.value)
        .map((item) => `  ${item.key}: ${item.value};`);
      const root = target.id === 'chat-thread' ? '.chat-thread-page' : target.root.split(',')[0];
      const generated = declarations.length ? `${root} {\n${declarations.join('\n')}\n}\n` : '';
      const marker = '/* 工作室控件 */';
      const previous = currentCss().replace(/\/\* 工作室控件 \*\/[\s\S]*?\/\* 控件结束 \*\/\n?/g, '');
      setCss(`${marker}\n${generated}/* 控件结束 */\n${previous}`.trim()).catch(() => {});
    }));
    container.querySelectorAll('[data-avatar-frame]').forEach((button) => button.addEventListener('click', () => {
      const frame = BUILTIN_AVATAR_FRAMES.find((item) => item.id === button.dataset.avatarFrame);
      if (!frame) return;
      setCss(`${currentCss()}\n\n/* 头像框：${frame.name} */\n${frame.css}`.trim()).catch(() => {});
      saveBeautifyDraft(draftStorageKey(), currentCss(), variantOptions());
      showToast(`已应用「${frame.name}」`);
    }));
    container.querySelectorAll('[data-real-preview]').forEach((button) => button.addEventListener('click', async () => {
      await saveBeautifyDraft(draftStorageKey(), currentCss(), variantOptions());
      globalThis.__MM_BEAUTIFY_PREVIEW_COLOR_MODE__ = cssVariant;
      globalThis.__MM_BEAUTIFY_REAL_PREVIEW__ = true;
      if (!previewRoute) previewRoute = await resolvePreviewRoute();
      if (previewRoute) navigate(previewRoute.path, previewRoute.params || {});
      else if (target.id === 'chat-thread') {
        globalThis.__MM_BEAUTIFY_REAL_PREVIEW__ = false;
        showToast('还没有可体验的聊天会话');
      } else navigate(target.route);
    }));
    container.querySelector('[data-export]')?.addEventListener('click', async () => {
      try {
        const cssText = currentCss();
        const matchedPreset = state.presets.find((preset) => (
          preset.target === target.id
          && (preset.variant || 'light') === cssVariant
          && String(preset.css || '').trim() === cssText.trim()
        ));
        const fallbackName = `${target.label}美化-${Date.now()}`;
        const exportName = safeBeautifyFilename(matchedPreset?.name, fallbackName);
        await downloadText(cssText, `${exportName}.css`);
        showToast('CSS 已导出');
      } catch (error) {
        showToast(`导出失败：${error?.message || error}`);
      }
    });
    container.querySelector('[data-share-css]')?.addEventListener('click', () => {
      const cssText = currentCss();
      if (!cssText.trim()) { showToast('当前没有可分享的 CSS'); return; }
      const matchedPreset = state.presets.find((preset) => (
        preset.target === target.id
        && (preset.variant || 'light') === cssVariant
        && String(preset.css || '').trim() === cssText.trim()
      ));
      const shareName = String(matchedPreset?.name || '').trim() || `${target.label}美化`;
      shareToCommunityStore({
        source: { name: shareName, cssText, target: target.id },
        fileName: `${safeBeautifyFilename(shareName)}.json`,
        resourceType: 'beautify',
        resourceSubtype: communityBeautifySubtype(target.id),
        title: shareName,
        originLabel: '美化工作室',
      });
    });
    container.querySelector('[data-save-preset]')?.addEventListener('click', async () => {
      const name = window.prompt('方案名称', `${target.label}美化`);
      if (!name) return;
      await saveBeautifyPreset({
        name,
        target: target.id,
        variant: cssVariant,
        css: currentCss(),
        assets: attachedImage ? [attachedImage] : [],
      });
      state = await loadBeautifyStudioState();
      showToast('已存入工作室首页「保存的方案」');
    });
    container.querySelector('[data-save-component]')?.addEventListener('click', async () => {
      const name = window.prompt('组件名称', selectedComponent?.label || `${target.label}组件`);
      if (!name) return;
      await saveBeautifyComponent({
        name,
        target: target.id,
        selector: selectedComponent?.cls || target.root,
        css: currentCss(),
      });
      showToast('已保存为独立组件');
    });
    container.querySelector('[data-publish]')?.addEventListener('click', async () => {
      if (target.id === 'chat-thread'
        && !window.confirm('全局生效？所有聊天会话都会统一套用这段 CSS（各会话自己的美化仍优先）。只想给个别会话用的话，选「存为聊天预设」。')) return;
      await publishBeautifyCss(target.id, currentCss(), variantOptions());
      await saveBeautifyDraft(draftStorageKey(), currentCss(), variantOptions());
      showToast(cssVariant === 'dark'
        ? '夜间覆盖已发布；浅色模式下不会加载'
        : '已发布：这页 CSS 已在整个 App 生效，替换上一次发布');
    });
    // 聊天对话的推荐出口：存成会话美化预设，按会话选用而不是全局覆盖
    container.querySelector('[data-save-chat-preset]')?.addEventListener('click', async () => {
      const css = currentCss().trim();
      if (!css) { showToast('CSS 还是空的'); return; }
      const name = window.prompt('预设名称（会出现在 会话详情 → 美化 → 预设 里）', '工作室美化');
      if (name == null) return;
      try {
        const resolved = await resolveBeautifyCssAssets(css);
        await saveChatAppearancePreset(name.trim() || '工作室美化', { customCss: resolved });
        await saveBeautifyDraft(draftStorageKey(), currentCss(), variantOptions());
        showToast('已存为聊天预设：打开某个会话 → 详情 → 美化 → 预设 即可套用');
      } catch (error) {
        showToast(error.message || '预设保存失败');
      }
    });
    container.querySelectorAll('[data-ai-mode]').forEach((button) => button.addEventListener('click', async () => {
      state.assistantMode = button.dataset.aiMode;
      await db.put({ key: 'beautifyStudio', value: state });
      container.querySelectorAll('[data-ai-mode]').forEach((item) => item.classList.toggle('is-active', item === button));
    }));

    const updateAttachChip = () => {
      const chip = container.querySelector('.beautify-attach-chip');
      if (chip) chip.hidden = !attachedImage;
    };
    container.querySelector('[data-ai-attach]')?.addEventListener('click', () => container.querySelector('[data-ai-image]')?.click());
    container.querySelector('[data-ai-attach-clear]')?.addEventListener('click', () => {
      attachedImage = '';
      updateAttachChip();
    });
    container.querySelector('[data-ai-image]')?.addEventListener('change', async (event) => {
      try {
        attachedImage = await fileToDataUrl(event.target.files?.[0]);
        updateAttachChip();
        showToast('参考图已附加，随下一条消息发出');
      } catch (error) {
        showToast(error.message || '图片读取失败');
      } finally {
        event.target.value = '';
      }
    });

    const persistChat = async () => {
      const key = chatStorageKey();
      state = await saveBeautifyChat(key, chatHistory);
      chatHistory = state.chats?.[key] || [];
    };

    const readInnerVoiceWorkbench = () => normalizeInnerVoiceCard({
      template: container.querySelector('[data-inner-voice-template]')?.value,
      position: container.querySelector('[data-inner-voice-position]')?.value,
      generationMode: 'custom',
      generationPrompt: container.querySelector('[data-inner-voice-prompt]')?.value || '',
      templateHtml: container.querySelector('[data-inner-voice-html]')?.value || '',
      css: container.querySelector('[data-inner-voice-css]')?.value || '',
      inlineEnabled: container.querySelector('[data-inner-voice-inline-enabled]')?.checked === true,
      inlineCss: container.querySelector('[data-inner-voice-inline-css]')?.value || '',
      labels: innerVoiceDraft.labels || {},
    }, 'ins');

    const hydrateInnerVoicePreview = () => {
      if (!isInnerVoiceMode) return;
      innerVoiceDraft = readInnerVoiceWorkbench();
      const host = container.querySelector('[data-inner-voice-preview]');
      if (!host) return;
      const mood = 72;
      const customRows = '<div class="char-state-custom-row" data-state-key="affection"><span class="char-state-row-label">亲密度</span><span class="char-state-row-value">72 / 100</span></div>';
      const customHtml = String(innerVoiceDraft.templateHtml || '')
        .replace(/\{\{name\}\}/g, '角色')
        .replace(/\{\{inner\}\}/g, '有些话还没有说出口。')
        .replace(/\{\{intent\}\}/g, '想再靠近一点')
        .replace(/\{\{status\}\}/g, '靠在窗边，情绪渐渐安静')
        .replace(/\{\{moodValue\}\}/g, String(mood))
        .replace(/\{\{customRows\}\}/g, customRows);
      host.innerHTML = `<div id="char-state-popover" class="csp-pos-${esc(innerVoiceDraft.position)} csp-skin-${esc(innerVoiceDraft.template)}">
        <section class="char-state-card csp-${esc(innerVoiceDraft.template)}">
          <header class="char-state-header"><div class="char-state-avatar"><span class="char-state-avatar-fallback">A</span></div><strong class="char-state-header-title">角色 · 心声</strong><button class="char-state-close-x" type="button">×</button></header>
          <div class="char-state-divider"></div><nav class="char-state-tabs"><button class="char-state-tab is-active">当前</button><button class="char-state-tab">往期</button></nav>
          <div class="char-state-popover-body">
            ${customHtml || `<div class="char-state-row"><span class="char-state-row-label">心声</span><span class="char-state-row-value">有些话还没有说出口。</span></div><div class="char-state-row"><span class="char-state-row-label">当前状态</span><span class="char-state-row-value">靠在窗边，情绪渐渐安静</span></div>${customRows}`}
            <div class="char-state-mood-row"><span class="char-state-mood-label">情绪波动</span><div class="char-state-mood-track"><div class="char-state-mood-fill" style="width:${mood}%"></div></div><span class="char-state-mood-value">${mood}</span></div>
          </div>
        </section>
        <style>${innerVoiceDraft.css}</style>
      </div>`;
    };

    container.querySelectorAll('[data-inner-voice-prompt],[data-inner-voice-html],[data-inner-voice-css],[data-inner-voice-inline-css],[data-inner-voice-template],[data-inner-voice-position],[data-inner-voice-inline-enabled]').forEach((field) => {
      field.addEventListener('input', () => {
        hydrateInnerVoicePreview();
        clearTimeout(container.__innerVoiceSaveTimer);
        container.__innerVoiceSaveTimer = setTimeout(async () => {
          state = await saveBeautifyInnerVoiceDraft(innerVoiceDraft);
        }, 350);
      });
    });
    container.querySelector('[data-inner-voice-preview-refresh]')?.addEventListener('click', hydrateInnerVoicePreview);
    container.querySelector('[data-inner-voice-doc]')?.addEventListener('click', async () => {
      await downloadText(buildInnerVoiceCardReferenceMarkdown(), `marshmallow-inner-voice-reference-${Date.now()}.md`, 'text/markdown');
      showToast('心声参考文档已下载');
    });
    container.querySelector('[data-inner-voice-save]')?.addEventListener('click', async () => {
      const name = String(container.querySelector('[data-inner-voice-name]')?.value || '').trim();
      try {
        innerVoiceDraft = readInnerVoiceWorkbench();
        await saveInnerVoiceCardPreset(name, innerVoiceDraft);
        state = await saveBeautifyInnerVoiceDraft(innerVoiceDraft);
        showToast(`已保存心声预设「${name}」`);
      } catch (error) {
        showToast(error?.message || '心声预设保存失败');
      }
    });
    container.querySelector('[data-inner-voice-reset]')?.addEventListener('click', async () => {
      innerVoiceDraft = normalizeInnerVoiceCard({}, 'ins');
      state = await saveBeautifyInnerVoiceDraft(innerVoiceDraft);
      draw();
    });
    const innerVoiceFile = container.querySelector('[data-inner-voice-file]');
    container.querySelector('[data-inner-voice-import]')?.addEventListener('click', () => innerVoiceFile?.click());
    innerVoiceFile?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        innerVoiceDraft = parseInnerVoiceCardImportText(await file.text(), 'ins');
        state = await saveBeautifyInnerVoiceDraft(innerVoiceDraft);
        draw();
        showToast('心声方案已导入工作台');
      } catch (error) {
        showToast(error?.message || '心声方案导入失败');
      }
    });
    if (isInnerVoiceMode) hydrateInnerVoicePreview();

    const openMessageEditor = (index) => {
      const message = chatHistory[index];
      if (!message) return;
      container.querySelector('.beautify-message-editor')?.remove();
      const trigger = container.querySelector(`[data-msg-expand="${index}"]`);
      const editor = document.createElement('div');
      editor.className = 'beautify-message-editor';
      editor.setAttribute('role', 'dialog');
      editor.setAttribute('aria-modal', 'true');
      editor.setAttribute('aria-labelledby', 'beautify-message-editor-title');
      editor.innerHTML = `
        <section class="beautify-message-editor-sheet">
          <header>
            <strong id="beautify-message-editor-title">${message.role === 'assistant' ? 'AI 回复' : '我的消息'}</strong>
            <button data-message-editor-close aria-label="关闭">${icon('close')}</button>
          </header>
          <textarea data-message-editor-text aria-label="消息正文" spellcheck="false">${esc(message.content)}</textarea>
          <footer>
            <button data-message-editor-copy-selection>${icon('clipboard')} 复制选中</button>
            <button data-message-editor-copy-all>复制全部</button>
            <span></span>
            <button class="is-primary" data-message-editor-save>${icon('check')} 保存修改</button>
          </footer>
        </section>`;
      container.appendChild(editor);

      const area = editor.querySelector('[data-message-editor-text]');
      let selectedRange = { start: 0, end: 0 };
      const rememberSelection = () => {
        selectedRange = {
          start: area.selectionStart ?? 0,
          end: area.selectionEnd ?? 0,
        };
      };
      const closeEditor = () => {
        editor.remove();
        trigger?.focus();
      };
      area.addEventListener('select', rememberSelection);
      area.addEventListener('keyup', rememberSelection);
      area.addEventListener('pointerup', rememberSelection);
      editor.addEventListener('click', (event) => {
        if (event.target === editor) closeEditor();
      });
      editor.querySelector('[data-message-editor-close]')?.addEventListener('click', closeEditor);
      editor.querySelector('[data-message-editor-copy-selection]')?.addEventListener('click', async () => {
        rememberSelection();
        const selected = area.value.slice(selectedRange.start, selectedRange.end);
        if (!selected) {
          showToast('先在正文中选中要复制的部分');
          area.focus();
          return;
        }
        showToast(await copyBeautifyText(selected) ? '已复制选中内容' : '复制失败');
      });
      editor.querySelector('[data-message-editor-copy-all]')?.addEventListener('click', async () => {
        showToast(await copyBeautifyText(area.value) ? '已复制整段回复' : '复制失败');
      });
      editor.querySelector('[data-message-editor-save]')?.addEventListener('click', async () => {
        const content = area.value;
        if (!content.trim()) {
          showToast('回复内容不能为空');
          area.focus();
          return;
        }
        chatHistory[index] = { ...message, content };
        await persistChat();
        closeEditor();
        renderChat();
        showToast('回复修改已保存');
      });
      editor.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeEditor();
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          editor.querySelector('[data-message-editor-save]')?.click();
        }
      });
      area.focus();
      area.setSelectionRange(0, 0);
    };

    const renderChat = () => {
      const messagesEl = container.querySelector('.beautify-ai-messages');
      if (!messagesEl) return;
      if (!chatHistory.length) {
        messagesEl.innerHTML = isExtensionMode
          ? '<p class="beautify-ai-hint">描述要在聊天里出现的内容卡。生成后先放进工作台看实际效果，再保存到扩展库。</p>'
          : isInnerVoiceMode
            ? '<p class="beautify-ai-hint">告诉 AI 想显示哪些内容或数值、各自范围和视觉风格。生成后先放进工作台预览，再保存为心声预设。</p>'
          : homeMode === 'widget'
            ? '<p class="beautify-ai-hint">描述一个独立组件。AI 只会生成组件自己的 HTML 和样式，不会读取或改写海、手账、窗主题。生成后放进组件工作台，选择尺寸和页码再添加。</p>'
            : '<p class="beautify-ai-hint">描述整页风格（可发参考图），AI 会为当前页面输出一整套 CSS。对话和草稿都会自动保存。</p>';
        return;
      }
      messagesEl.innerHTML = chatHistory.map((msg, index) => {
        const blocks = msg.role === 'assistant' ? extractCssBlocks(msg.content) : [];
        const htmlBlocks = msg.role === 'assistant' ? extractHtmlExtensionBlocks(msg.content) : [];
        const innerVoiceCard = msg.role === 'assistant' && isInnerVoiceMode ? extractInnerVoiceCard(msg.content) : null;
        const actions = msg.role === 'assistant'
          ? `<button data-msg-expand="${index}">${icon('expand')} 展开编辑</button><button data-msg-copy="${index}">${icon('clipboard')} 复制</button><button data-msg-reroll="${index}">${icon('refresh')} 重写</button><button data-msg-delete="${index}">删除</button>`
          : `<button data-msg-edit="${index}">编辑</button><button data-msg-delete="${index}">删除</button>`;
        return `<article class="${msg.role === 'user' ? 'is-user' : 'is-ai'}" data-msg-index="${index}">
          <div class="beautify-msg-body">${esc(msg.content)}</div>
          ${msg.finishReason === 'length' ? '<div class="beautify-msg-status">输出达到当前 Max Tokens，代码可能未完成。调高上限后重写，或让 AI 从截断处继续。</div>' : ''}
          ${homeMode === 'widget' || isExtensionMode ? '' : blocks.map((_, blockIndex) => `<button class="beautify-apply-btn" data-apply-ai="${index}:${blockIndex}">${icon('check')} 应用这段 CSS</button>`).join('')}
          ${innerVoiceCard ? `<button class="beautify-apply-btn" data-apply-inner-voice="${index}">${icon('check')} 放进心声工作台</button>` : ''}
          ${htmlBlocks.map((_, blockIndex) => `<button class="beautify-apply-btn" data-install-widget="${index}:${blockIndex}">${icon('plus')} ${isExtensionMode || homeMode === 'widget' ? '放进组件工作台' : '作为组件添加到主屏'}</button>`).join('')}
          <div class="beautify-msg-actions">${actions}</div>
        </article>`;
      }).join('');
      messagesEl.scrollTop = messagesEl.scrollHeight;
      messagesEl.querySelectorAll('[data-apply-ai]').forEach((button) => button.addEventListener('click', async () => {
        const [msgIndex, blockIndex] = button.dataset.applyAi.split(':').map(Number);
        const block = extractCssBlocks(chatHistory[msgIndex]?.content || '')[blockIndex] || '';
        if (!block) return;
        const existing = currentCss();
        // 重 roll 后反复点应用会把整套方案一遍遍叠进草稿，这里防重复并给出替换选项
        if (existing.includes(block)) {
          showToast('这段 CSS 已经在草稿里了');
          return;
        }
        const replace = existing.trim()
          && window.confirm('草稿里已有内容：\n「确定」= 用这段 CSS 替换整份草稿\n「取消」= 追加到草稿末尾');
        button.disabled = true;
        try {
          await setCss(replace ? block : `${existing}\n\n${block}`.trim());
          await saveBeautifyDraft(draftStorageKey(), currentCss(), variantOptions());
          showToast(replace ? '已替换草稿，预览已更新' : '已追加到草稿，预览已更新');
        } catch (error) {
          await saveBeautifyDraft(draftStorageKey(), currentCss(), variantOptions()).catch(() => {});
          showToast(error?.message || 'CSS 已放入草稿，但预览应用失败');
        } finally {
          button.disabled = false;
        }
      }));
      messagesEl.querySelectorAll('[data-apply-inner-voice]').forEach((button) => button.addEventListener('click', async () => {
        const card = extractInnerVoiceCard(chatHistory[Number(button.dataset.applyInnerVoice)]?.content || '');
        if (!card) return;
        innerVoiceDraft = card;
        state = await saveBeautifyInnerVoiceDraft(card);
        draw();
        showToast('已放进心声工作台');
      }));
      messagesEl.querySelectorAll('[data-install-widget]').forEach((button) => button.addEventListener('click', async () => {
        const [msgIndex, blockIndex] = button.dataset.installWidget.split(':').map(Number);
        const html = extractHtmlExtensionBlocks(chatHistory[msgIndex]?.content || '')[blockIndex] || '';
        if (!html) return;
        if (isExtensionMode) {
          const normalized = normalizeHtmlExtension({
            ...readExtensionWorkbench(),
            templateHtml: html,
          });
          const htmlArea = container.querySelector('[data-extension-html]');
          if (htmlArea) htmlArea.value = normalized.templateHtml;
          hydrateExtensionPreview();
          container.querySelector('.beautify-extension-workbench')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          showToast(normalized.templateHtml === html ? '已放进组件工作台' : '已放进工作台，不支持的内容已安全清理');
          return;
        }
        if (homeMode === 'widget') {
          const htmlArea = container.querySelector('[data-widget-html]');
          if (htmlArea) htmlArea.value = html;
          container.querySelector('.beautify-widget-workbench')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          showToast('已放进组件工作台，可编辑、选页和调整尺寸');
          return;
        }
        try {
          const name = window.prompt('给这个组件起个名字', 'AI 小组件');
          if (name == null) return;
          await installWidgetTemplateOnHome({ name: name.trim() || 'AI 小组件', html, size: { cols: 2, rows: 1 } });
          showToast('已装到主屏最后一页，长按主屏可挪动/删除');
          if (target.id === 'home') await mountPreview();
        } catch (error) {
          showToast(error.message || '组件安装失败');
        }
      }));
      messagesEl.querySelectorAll('[data-msg-delete]').forEach((button) => button.addEventListener('click', async () => {
        chatHistory.splice(Number(button.dataset.msgDelete), 1);
        await persistChat();
        renderChat();
      }));
      messagesEl.querySelectorAll('[data-msg-edit]').forEach((button) => button.addEventListener('click', () => {
        const input = container.querySelector('.beautify-ai-compose textarea');
        if (!input) return;
        input.value = chatHistory[Number(button.dataset.msgEdit)]?.content || '';
        input.focus();
      }));
      messagesEl.querySelectorAll('[data-msg-expand]').forEach((button) => button.addEventListener('click', () => {
        openMessageEditor(Number(button.dataset.msgExpand));
      }));
      messagesEl.querySelectorAll('[data-msg-copy]').forEach((button) => button.addEventListener('click', async () => {
        const content = chatHistory[Number(button.dataset.msgCopy)]?.content || '';
        showToast(await copyBeautifyText(content) ? '已复制整段回复' : '复制失败');
      }));
      messagesEl.querySelectorAll('[data-msg-reroll]').forEach((button) => button.addEventListener('click', async () => {
        if (generating) return;
        const index = Number(button.dataset.msgReroll);
        if (chatHistory[index - 1]?.role !== 'user') {
          showToast('这条回复前面没有可重发的消息');
          return;
        }
        chatHistory.splice(index, 1);
        await persistChat();
        renderChat();
        await runGeneration(index);
      }));
    };

    /** 以 chatHistory[0..uptoIndex) 为上下文生成一条回复并插入到 uptoIndex；上下文最后一条必须是用户消息。 */
    const runGeneration = async (uptoIndex) => {
      const contextMessages = chatHistory.slice(0, uptoIndex);
      const request = contextMessages[contextMessages.length - 1];
      if (!request || request.role !== 'user' || generating) return;
      const lease = await acquireNarrationGenerationLease('beautify-studio', chatStorageKey());
      if (!lease.acquired) {
        showToast('这页已有 AI 生成任务正在进行');
        return;
      }
      generating = true;
      const messagesEl = container.querySelector('.beautify-ai-messages');
      const anchor = messagesEl?.querySelector(`[data-msg-index="${uptoIndex - 1}"]`);
      const output = document.createElement('article');
      output.className = 'is-ai is-streaming';
      output.textContent = '编写中…';
      if (anchor) anchor.after(output);
      else messagesEl?.appendChild(output);
      output.scrollIntoView({ block: 'nearest' });
      try {
        const characterId = container.querySelector('.beautify-character-select')?.value || '';
        const user = await ensureDefaultUser().catch(() => null);
        const character = characterId
          ? await getCharacter(characterId, { userId: user?.id || '' }).catch(() => null)
          : null;
        const isWidgetGeneration = target.id === 'home' && homeMode === 'widget';
        const roleContext = state.assistantMode === 'character' && character
          ? `你现在也以角色「${character.customNickname || character.name}」的审美和说话方式与用户一起装修。完整角色资料：${JSON.stringify({
            gender: character.gender || '',
            currentRole: character.currentRole || '',
            currentStatus: character.currentStatus || '',
            userRelationStatus: character.userRelationStatus || '',
            personality: character.personality || character.description || '',
            speechStyle: character.speechStyle || '',
            speechCorpus: character.speechCorpus || '',
            promptCorpus: character.promptCorpus || '',
            notes: character.notes || '',
            relationships: character.relationships || {},
          })}`
          : isInnerVoiceMode
            ? '你是心声状态栏设计师，负责同时设计模型生成字段、数值规则、卡片 HTML 和安全作用域 CSS。'
          : isExtensionMode
            ? '你是有主见的聊天扩展组件设计师，负责设计能嵌入对话与线下叙事的轻量 HTML 卡片。'
            : isWidgetGeneration
            ? '你是有主见的主屏小组件设计师，负责从零设计独立、自包含的 HTML 组件。'
            : '你是有主见的页面视觉设计师，用 CSS 重塑页面外观，敢于给出完整、风格强烈的方案。';
        // 主屏和聊天首页系页面按主题走不同 DOM，必须告诉 AI 当前生效的是哪套，避免写错另一套的选择器
        let activeThemeNote = '';
        {
          const prefs = await loadAppearancePrefs().catch(() => null);
          const templateKey = prefs ? resolveHomeTemplateKey(getActiveTheme(prefs).theme) : '';
          if (target.id === 'home' && !isWidgetGeneration && HOME_TEMPLATE_AI_LABELS[templateKey]) {
            activeThemeNote = `用户当前主屏主题：${HOME_TEMPLATE_AI_LABELS[templateKey]}。只针对这套主题的选择器写 CSS。`;
          } else if (['chat-hub', 'intercepts', 'backstage'].includes(target.id) && templateKey) {
            activeThemeNote = templateKey === 'scrapbook'
              ? '用户当前是手账主题：这页顶栏是 .chat-hub-navbar，列表行没有 --ins 修饰类。'
              : '用户当前是海/窗主题：这页走 ins 版结构（根节点带 --ins 修饰类，顶部是 .chat-hub-toolbar + 用户卡 .chat-hub-user-card），页面里没有 .chat-hub-navbar。';
          }
        }
        const layoutSafetyNote = target.id === 'chat-thread'
          ? '聊天页布局底线：底栏按当前主题选择手账两行结构或海/窗/匿名紧凑结构，并把兄弟节点 .chat-tools-sheet 一起设计。普通消息行 .chat-bubble-row 必须保持横向 flex；默认我方在右、对方在左。用户明确要求把我方整套移到左边时，不要用 absolute/fixed，也不要只改文字气泡；请在 .chat-thread-page 同时设置 --chat-user-row-justify:flex-start、--chat-user-col-order:1、--chat-user-avatar-order:0、--chat-user-content-align:flex-start、--chat-user-content-margin-left:0、--chat-user-content-margin-right:auto，这套变量会让文字、图片和表情包一起越过末尾保护规则靠左。私聊需要昵称或纯视觉假 ID 时，设置 --chat-private-id-display:block 并美化 .chat-bubble-identity.is-beautify-identity；可按 .is-user / .is-them 分别用 ::before 的 content 写假 ID，槽位 data-sender-label 保留当前显示名。除非用户明确要求换边，不要颠倒直属元素 order。用户要求“恢复/修复头像位置”时，输出能覆盖当前 CSS 的完整修复规则，不要继续保留冲突布局。不要覆盖聊天顶栏/底栏现有的 position、top、bottom 定位机制；顶部安全区由页面独立保护，顶栏视觉 padding 不叠加 var(--safe-top)，底栏仍保留 var(--safe-bottom)。'
          : target.id === 'offline'
            ? '线下页布局底线：顶栏、正文、走向选项、展开工具区、底部输入区必须形成同一套设计。不要覆盖 .navbar、.offline-options、.offline-tools、.offline-bar 现有的 position/top/bottom/inset 定位机制；不得让 [hidden] 的工具区常驻；重写 padding 时保留 var(--safe-top) / var(--safe-bottom)。'
            : '页面布局底线：保留返回、主要操作与表单的可见可点状态，不用 fixed 全屏层遮挡页面；涉及系统边缘时保留 var(--safe-top) / var(--safe-bottom)。';
        const nightAdaptNote = cssVariant === 'dark' && !isWidgetGeneration && !isExtensionMode
          ? [
            '当前任务是夜间覆盖层。常规 CSS 会先加载，下面输出的 CSS 只在夜间模式加载，不要复制或重写无关布局。',
            '保留现有图片、结构、间距和品牌风格，重点调整背景、文字、边框、阴影、图标与输入控件状态，避免纯黑糊成一片。',
            '优先使用 html[data-color-mode="dark"] 作为选择器前缀；正文与背景至少保持清晰可读，不使用 filter: invert() 反转用户图片。',
            `当前常规 CSS：\n${state.drafts?.[draftStorageKey(target.id)] || await getPublishedBeautifyCss(target.id).catch(() => '') || '（空）'}`,
            `当前夜间覆盖 CSS：\n${currentCss() || '（空）'}`,
          ].join('\n\n')
          : '';
        const prompt = isInnerVoiceMode
          ? [
            roleContext,
            buildInnerVoiceCardReferenceMarkdown(),
            '根据用户要求设计一份完整心声方案。用户提到数值时，要在 generationPrompt 中明确字段名、取值范围、整数/小数要求、语义锚点与前后轮变化规则，禁止只写视觉进度条却不告诉生成模型如何产出该值。自定义字段必须要求模型放在 custom 对象中。',
            'templateHtml 只能使用文档列出的占位符；任意自定义字段统一用 {{customRows}} 渲染。需要图片时可使用带 HTTPS、站内路径或图片 Data URL 的 <img src="..." alt="">，不得使用脚本、事件属性、iframe 或其它可执行外链资源。CSS 必须分别圈在 #char-state-popover 和 .chat-inline-inner-voice-host 作用域内，不得使用 fixed 全屏遮罩或破坏点击的 pointer-events。',
            '只输出一个 ```json 代码块，不要输出 CSS/HTML 独立代码块。JSON 结构必须是：{"template":"ins|diary","position":"center|top|bottom","generationMode":"custom","generationPrompt":"","templateHtml":"","css":"","inlineEnabled":false,"inlineCss":"","labels":{}}。所有换行、引号必须符合合法 JSON。',
            `当前工作台方案：${JSON.stringify(readInnerVoiceWorkbench())}`,
            `用户要求：${request.content}`,
          ].join('\n\n')
          : isExtensionMode
          ? buildHtmlExtensionAuthorPrompt({
            request: request.content,
            currentTemplate: container.querySelector('[data-extension-html]')?.value || '',
            characterContext: roleContext,
          })
          : isWidgetGeneration
            ? [
            roleContext,
            '当前任务与海/手账/窗主题完全无关，不要输出主屏 CSS，不要引用 .home-sea-shell、.sea-app、.app-icon、.widget-card 等现有页面选择器。',
            '输出要求：只输出必要说明和一个 ```html 代码块。代码块里是单个自包含 HTML 片段，可包含组件自己的 <style>；不要写 <html>/<head>/<body>，不要写 <script>、iframe、form 或 on* 事件。',
            '尺寸：用户会在工作台选择占几格（宽 1–4 × 高 1–4，对齐主屏 4 列图标网格）。你可在说明里建议合适占格，例如拍立得建议 2×2、横条建议 4×1、时钟建议 2×1；不要在 HTML 里写固定像素宽高撑破格子。',
            '组件运行在独立 Shadow DOM 中，外层尺寸由网格格子决定。组件根元素必须 width:100%; height:100%; box-sizing:border-box;，内部响应容器尺寸，不要使用 100vw/100vh 或 fixed。',
            '可用交互钩子：data-widget-image-slot="key"（点按上传并保存图片）、data-widget-clock（实时时间）、data-widget-clock-date（实时日期）。需要用户换图时直接设计可点击图片槽。',
            '如果用户是在修改现有组件，请基于下面的当前 HTML 输出完整替换版本；为空则从零创作。',
            `当前工作台占格：${container.querySelector('[data-widget-cols]')?.value || 2}×${container.querySelector('[data-widget-rows]')?.value || 1}`,
            `当前组件 HTML：\n${container.querySelector('[data-widget-html]')?.value || '（空）'}`,
            `用户要求：${request.content}`,
            ].join('\n\n')
            : [
            roleContext,
            buildComponentAiContext(target, selectedComponent),
            activeThemeNote,
            nightAdaptNote || `当前页面 CSS：\n${currentCss() || '（空）'}`,
            selectedComponent
              ? '任务：根据用户要求只输出必要说明和一个可直接应用的 CSS 代码块，只改选中组件相关规则。不得写 <style> 标签，不得使用会破坏页面操作的 fixed 全屏遮罩。'
              : '任务：根据用户要求为整页输出一套风格统一的完整 CSS 方案，放在一个可直接应用的代码块里，前面只写必要说明。不得写 <style> 标签，不得使用会破坏页面操作的 fixed 全屏遮罩。',
            [
              '创作自由度：组件清单只是这页 DOM 的索引（有什么元素、选择器叫什么），不是要保留的设计。用户要求重做/换风格时，原主题的配色、圆角、阴影、装饰都可以彻底抛弃：装饰性元素可以 display:none 藏掉，可以用背景、边框、::before/::after 重画外观，布局间距字体都能大改。',
              '注入机制：CSS 会自动圈定在本页作用域；颜色、背景、边框、阴影、字体等视觉属性会自动补强。display/grid/flex、padding/margin、宽高、position 等布局属性不会自动提权，以免压坏键盘和安全区规则。',
              '布局大改：使用页面根 + 具体组件的精确选择器；确实被主题覆盖时，只给必要的布局声明逐项加 !important。',
              layoutSafetyNote,
            ].join('\n'),
            '装饰素材：可以给顶栏、气泡、输入区、页面等用 background-image 或 ::before/::after 叠加图片装饰；图片地址支持外链 URL，也支持素材库占位符 mm-img://ID（应用时自动替换成真实图片）；透明底 PNG 适合做贴纸式叠层。',
            `用户要求：${request.content}`,
          ].filter(Boolean).join('\n\n');
        const content = attachedImage
          ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: attachedImage } }]
          : prompt;
        // 页面上下文（当前 CSS、组件清单）贴在最新一条里，历史消息用原文，避免上下文过期又省 token。
        const apiMessages = [
          ...contextMessages.slice(-13, -1).map((msg) => ({ role: msg.role, content: msg.content })),
          { role: 'user', content },
        ];
        let streamed = '';
        let finishReason = '';
        const result = await chatWithPreferredStream(apiMessages, (_chunk, full) => {
          streamed = String(full || _chunk || '');
          output.textContent = streamed;
          if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
        }, {
          temperature: 0.6,
          onFinishReason: (reason) => {
            finishReason = String(reason || '');
          },
        });
        const finalText = String(result || streamed);
        chatHistory.splice(uptoIndex, 0, {
          role: 'assistant',
          content: finalText,
          ts: Date.now(),
          ...(finishReason === 'length' ? { finishReason: 'length' } : {}),
        });
        attachedImage = '';
        updateAttachChip();
        await persistChat();
        renderChat();
      } catch (error) {
        output.classList.remove('is-streaming');
        output.textContent = `生成失败：${error.message || error}。可重新发送，或点上一条回复的「重写」。`;
      } finally {
        generating = false;
        await lease.release();
      }
    };

    container.querySelector('[data-ai-send]')?.addEventListener('click', async () => {
      if (generating) {
        showToast('AI 正在编写，稍等一下');
        return;
      }
      const input = container.querySelector('.beautify-ai-compose textarea');
      const request = String(input?.value || '').trim();
      if (!request) return;
      input.value = '';
      setComposeExpanded(false);
      chatHistory.push({ role: 'user', content: request, ts: Date.now() });
      await persistChat();
      renderChat();
      await runGeneration(chatHistory.length);
    });
    container.querySelector('[data-ai-clear]')?.addEventListener('click', async () => {
      if (!chatHistory.length) return;
      if (!window.confirm(isExtensionMode ? '清空扩展组件的 AI 对话历史？工作台内容不受影响。' : '清空这页的 AI 对话历史？CSS 草稿不受影响。')) return;
      chatHistory = [];
      await persistChat();
      renderChat();
    });
    void populateAiBaseOptions();
    renderChat();
  };

  draw();
  maybeShowBeautifyWipPrompt(container);
}
