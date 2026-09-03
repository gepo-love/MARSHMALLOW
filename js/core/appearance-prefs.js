import * as db from './db.js';
import { HOME_THEME_TEXT_VARS_BY_TEMPLATE } from '../data/appearance-theme-contract.js';
import {
  appendChatChromeSafeAreaGuards,
  BEAUTIFY_PAGE_ROOTS,
  boostCssPriority,
  buildChatChromeSafeAreaGuardCss,
  expandAnonymousBubbleCompatibility,
  expandChatAppearanceRootSelectors,
  prepareChatBubblePriorityOverride,
  prepareChatVisualCssPriority,
  scopeCssToPage,
} from './css-priority.js';

export const APPEARANCE_PREFS_KEY = 'appearancePrefs';
export const CHAT_PLATFORMS = Object.freeze(['current', 'wechat', 'qq']);
export const DEFAULT_CHAT_PLATFORM = 'current';
export const DEFAULT_THEME_ID = 'marshmallow-scrapbook';
export const PLACEHOLDER_THEME_ID = 'glass-ins';
export const WINDOW_THEME_ID = 'glass-window';
export const ALBUM_THEME_ID = 'marshmallow-album';
export const HOME_TEMPLATE_SCRAPBOOK = 'scrapbook';
export const HOME_TEMPLATE_SEA = 'sea';
export const HOME_TEMPLATE_WINDOW = 'window';
export const HOME_TEMPLATE_ALBUM = 'album';
export const COLOR_MODE_STORAGE_KEY = 'marshmallow-color-mode';
export const APPEARANCE_COLOR_MODES = Object.freeze(['light', 'dark', 'system']);

/* 「棉花糖之海」皮肤：毛玻璃 ins 风 + 浅蓝海面 + 碎金点睛 + 仿微信 chat。
   仅覆盖现有 DOM 的样式（不改结构），作用域收在 home / chat 等页面根类内。 */
// 仅用于识别并清理旧存档中“原样未编辑”的内联内置样式。
// 新内置主题样式由 home-sea.css / chat.css 提供；不能删除这份快照，否则无法无损区分
// 用户自己改过的 CSS 与历史内置 CSS。
const LEGACY_SEA_THEME_CSS = `
/* ── 雾蒙蒙遮罩：压暗壁纸、底部更重；内容层（卡片/图标/dock）保持清晰 ── */
.home-shell-page::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background: linear-gradient(180deg,
    rgba(238,246,251,0.22) 0%,
    rgba(228,241,249,0.52) 48%,
    rgba(216,234,246,0.74) 78%,
    rgba(210,231,244,0.9) 100%);
}
.home-shell-page .home-pages-container { position: relative; z-index: 1; }

/* ── 主屏：卡片淡透明融壁纸 ── */
.home-shell-page .widget-card {
  background: rgba(255,255,255,0.22) !important;
  -webkit-backdrop-filter: blur(18px) saturate(118%);
  backdrop-filter: blur(18px) saturate(118%);
  border: 1px solid rgba(255,255,255,0.42) !important;
  box-shadow: 0 8px 26px rgba(40,74,92,0.12) !important;
  border-radius: 22px !important;
}
.home-shell-page .grid-paper {
  background-image: none !important;
  transform: none !important;
}
.home-shell-page .torn-paper { filter: none !important; border-radius: 22px !important; }
.home-shell-page .torn-paper::after { display: none !important; }
.home-shell-page .calendar-widget,
.home-shell-page .film-widget { background: rgba(255,255,255,0.22) !important; }

/* ── 页1：圆形头像 + 文字主视觉，图标在下 ── */
.home-shell-page .page-one .user-header {
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
  transform: none !important;
  padding: 26px 16px 20px;
}
.home-shell-page .page-one .avatar-placeholder {
  width: 96px; height: 96px;
  border: 4px solid rgba(255,255,255,0.8);
  box-shadow: 0 8px 20px rgba(40,74,92,0.18);
}
.home-shell-page .page-one .user-info .greeting { font-size: 21px; letter-spacing: 1px; }
.home-shell-page .page-one .user-header .deco-tape { display: none; }

/* ── App 图标：玻璃贴片（保留柔色 svg），dock 同款 ── */
.home-shell-page .app-icon {
  background: rgba(255,255,255,0.26) !important;
  -webkit-backdrop-filter: blur(18px) saturate(118%);
  backdrop-filter: blur(18px) saturate(118%);
  border: 1px solid rgba(255,255,255,0.42) !important;
  box-shadow: 0 5px 16px rgba(40,74,92,0.10) !important;
}
.home-shell-page .app-label { color: #3a5c6e; text-shadow: 0 1px 2px rgba(255,255,255,0.5); }
.home-shell-page .dock {
  background: rgba(255,255,255,0.30) !important;
  border: 1px solid rgba(255,255,255,0.42) !important;
  box-shadow: 0 8px 26px rgba(40,74,92,0.12) !important;
}

/* ── 碎金点睛：日历高亮 / 备忘标题 / 指示点 ── */
.home-shell-page .cal-grid .marked::before {
  background: linear-gradient(135deg, #f6d68a, #d9ab52) !important;
}
.home-shell-page .cal-header,
.home-shell-page .note-title { color: #c9a14a !important; }
.home-shell-page .page-indicators .dot.active { background: #d9ab52 !important; }
.home-shell-page .deco-tape { opacity: 0.75; }

/* ── 仿微信 chat 结构（仅奶油底栏；气泡底色改由 chat.css 变量链负责，避免写进主题存档锁死取色）── */
.chat-thread-page:not(.chat-thread-page--anon):not(.chat-thread-page--ins) { background: #ededed !important; }
.chat-thread-page.has-chat-wallpaper.has-chat-wallpaper { background: transparent !important; background-image: none !important; }
.chat-thread-page.has-chat-wallpaper .chat-thread-messages { background: transparent !important; background-image: none !important; }
.chat-thread-page:not(.chat-thread-page--anon):not(.chat-thread-page--ins) .scrapbook-bubble {
  border-radius: 6px !important;
  box-shadow: none !important;
  border: none !important;
}
.chat-thread-page:not(.chat-thread-page--anon):not(.chat-thread-page--ins) .chat-thread-composer {
  background: #f5f5f5 !important;
  border-top: 1px solid #e3e3e3 !important;
}

/* ── 主按钮 / 选中态：暖金 ── */
.appearance-theme-chip.is-active,
.tm-chip.is-active {
  background: linear-gradient(135deg, rgba(246,214,138,0.85), rgba(217,171,82,0.9)) !important;
  color: #fff !important;
  border: none !important;
}
`;

// 棉花糖之窗的视觉已迁移到 apps/web/css/home-window.css（文件化、易维护、可被 customTheme 覆盖）。
// 这里置空：避免注入的 customTheme.css 盖过文件样式；旧存档随 WINDOW_PRESET_VERSION 刷新清空。
const WINDOW_THEME_CSS = '';
// 同上：窗聊天视觉已在 chat.css 文件化，此快照只服务旧存档精确迁移。
const LEGACY_WINDOW_CHAT_CSS = `
.chat-thread-page {
  --window-chat-bg: #f8f8f7;
  --window-chat-surface: rgba(255, 255, 255, 0.88);
  --window-chat-line: rgba(41, 43, 45, 0.08);
  --window-chat-ink: #252729;
  --window-chat-muted: #85888d;
  --window-chat-user: #e2e3e3;
  --window-chat-them: rgba(255, 255, 255, 0.96);
  background: var(--window-chat-bg) !important;
  background-image: none !important;
  color: var(--window-chat-ink);
}

.chat-thread-page.has-chat-wallpaper.has-chat-wallpaper {
  background: transparent !important;
  background-image: none !important;
}

.chat-thread-page.has-chat-wallpaper .chat-thread-messages {
  background: transparent !important;
  background-image: none !important;
}

.chat-thread-page .navbar,
.chat-thread-page .chat-thread-messages,
.chat-thread-page .chat-thread-composer,
.chat-thread-page .chat-thread-action-area,
.chat-thread-page .chat-tools-sheet {
  background-image: none !important;
}

.chat-thread-page .navbar {
  background: rgba(250, 250, 249, 0.92);
  border-bottom: 0;
  box-shadow: 0 1px 0 var(--window-chat-line);
  -webkit-backdrop-filter: blur(18px) saturate(112%);
  backdrop-filter: blur(18px) saturate(112%);
}

.chat-thread-page .chat-thread-messages {
  background: linear-gradient(180deg, #fbfbfa 0%, #f4f4f2 100%) !important;
  padding: 16px 14px 18px;
}

.chat-thread-page:not(.chat-thread-page--anon) .chat-bubble-row {
  gap: 10px;
  margin-bottom: 14px;
}

.chat-thread-page:not(.chat-thread-page--anon) .chat-bubble-avatar {
  box-shadow: none;
}

.chat-thread-page:not(.chat-thread-page--anon) .scrapbook-bubble {
  border: 1px solid rgba(35, 38, 40, 0.07) !important;
  box-shadow: 0 8px 22px rgba(43, 46, 50, 0.07) !important;
  -webkit-backdrop-filter: blur(16px) saturate(110%);
  backdrop-filter: blur(16px) saturate(110%);
}

.chat-thread-page:not(.chat-thread-page--anon) .chat-bubble-row.is-user .scrapbook-bubble {
  background: var(--user-bubble-bg, var(--chat-session-bubble-self, var(--chat-user-bubble-bg-default, var(--window-chat-user, #e2e3e3))));
  color: var(--user-bubble-ink, var(--chat-session-bubble-ink-self, #1f2021));
}

.chat-thread-page:not(.chat-thread-page--anon) .chat-bubble-row.is-them .scrapbook-bubble {
  background: var(--role-bubble-bg, var(--chat-session-bubble-other, var(--chat-character-role-bubble-bg, var(--chat-role-bubble-bg-default, var(--window-chat-them, #fff)))));
  color: var(--role-bubble-ink, var(--chat-session-bubble-ink-other, #1f2021));
}

.chat-thread-page .chat-thread-action-area .scrapbook-panel,
.chat-thread-page .chat-action-dock,
.chat-thread-page .chat-more-panel.is-open,
.chat-thread-page .chat-tools-sheet,
.chat-thread-page .chat-reply-bar {
  border: 0 !important;
  box-shadow: none !important;
}

.chat-thread-page .chat-thread-action-area {
  background: var(--window-chat-surface);
  padding: 8px 10px 0;
  -webkit-backdrop-filter: blur(18px) saturate(112%);
  backdrop-filter: blur(18px) saturate(112%);
}

.chat-thread-page .chat-action-dock {
  display: flex;
  justify-content: center;
  align-items: stretch;
  gap: 12px;
  padding: 0;
  background: transparent !important;
}

.chat-thread-page .chat-action-chip {
  width: auto;
  min-width: 48px;
  min-height: 42px;
  padding: 3px 4px;
  display: inline-flex;
  flex-direction: column;
  gap: 3px;
  border: 0 !important;
  border-radius: 12px;
  background: transparent !important;
  color: #46494d;
  box-shadow: none !important;
}

.chat-thread-page .chat-action-chip::after {
  content: attr(aria-label);
  max-width: 58px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  line-height: 1.1;
  color: var(--window-chat-muted);
}

.chat-thread-page .chat-action-chip .svg-icon {
  width: 19px;
  height: 19px;
}

.chat-thread-page .chat-action-chip.is-primary,
.chat-thread-page .chat-action-chip.is-stop:not(:disabled) {
  color: #26282b;
}

.chat-thread-page:not(.chat-thread-page--ins) .chat-thread-composer {
  background: var(--window-chat-surface) !important;
  border: 0 !important;
  box-shadow: none !important;
  padding: 8px 10px calc(10px + var(--safe-bottom));
  -webkit-backdrop-filter: blur(18px) saturate(112%);
  backdrop-filter: blur(18px) saturate(112%);
}

.chat-thread-page .chat-composer-input {
  border: 0 !important;
  border-radius: 18px;
  background: rgba(244, 244, 243, 0.96) !important;
  color: var(--window-chat-ink);
  box-shadow: inset 0 0 0 1px rgba(29, 32, 34, 0.05);
}

.chat-thread-page .chat-composer-btn,
.chat-thread-page .chat-composer-send {
  border: 0 !important;
  border-radius: 14px;
  background: transparent !important;
  color: #3e4145;
  box-shadow: none !important;
}

.chat-thread-page .chat-composer-send {
  background: #2e3033 !important;
  color: #fff !important;
}

.chat-thread-page .chat-tools-sheet.is-open {
  display: flex;
  overflow-x: auto;
  overflow-y: hidden;
  gap: 14px;
  padding: 10px 14px calc(12px + var(--safe-bottom));
  background: var(--window-chat-surface) !important;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.chat-thread-page .chat-tools-sheet.is-open::-webkit-scrollbar {
  display: none;
}

.chat-thread-page .chat-tool-item {
  flex: 0 0 58px;
  min-height: 50px;
  padding: 4px 2px;
  border: 0 !important;
  border-radius: 12px;
  background: transparent !important;
  box-shadow: none !important;
  color: #4c4f53;
}

.chat-thread-page .chat-tool-item span {
  max-width: 56px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-thread-page .chat-bubble-card {
  border-radius: 12px;
  box-shadow: 0 8px 22px rgba(43, 46, 50, 0.08);
}

.chat-search-sheet {
  border: 0 !important;
  border-radius: 16px;
  background: rgba(250, 250, 249, 0.96) !important;
  box-shadow: 0 18px 50px rgba(31, 32, 34, 0.16) !important;
}

.chat-search-sheet .modal-header {
  border-bottom: 0 !important;
}

.chat-search-result {
  border: 0 !important;
  border-radius: 8px;
  background: rgba(238, 238, 236, 0.78) !important;
  box-shadow: none !important;
}

.chat-thread-page--anon {
  --window-chat-bg: #f1f1f0;
  --window-chat-surface: rgba(248, 248, 247, 0.94);
  --window-chat-user: #6f7074;
  --window-chat-them: #ffffff;
  --window-chat-line: rgba(31, 32, 34, 0.10);
  background: #f1f1f0 !important;
}

.chat-thread-page--anon .navbar {
  background: rgba(246, 246, 245, 0.94) !important;
  color: #202124 !important;
}

.chat-thread-page--anon .navbar-title,
.chat-thread-page--anon .navbar-btn,
.chat-thread-page--anon .chat-header-status {
  color: #202124 !important;
}

.chat-thread-page--anon .navbar-btn {
  background: transparent !important;
  box-shadow: none !important;
}

.chat-thread-page--anon .chat-thread-messages {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.64), rgba(238, 238, 236, 0.82)),
    repeating-linear-gradient(90deg, rgba(35, 36, 38, 0.035) 0 1px, transparent 1px 88px) !important;
  padding: 20px 14px 22px;
}

.chat-thread-page--anon .chat-bubble-row {
  gap: 12px;
  margin-bottom: 18px;
}

.chat-thread-page--anon .chat-bubble-row.is-anon-stack {
  margin-top: -8px;
  margin-bottom: 12px;
}

.chat-thread-page--anon .chat-bubble-row.is-anon-stack .chat-bubble-avatar {
  visibility: hidden;
}

.chat-thread-page--anon {
  --chat-bubble-avatar-size: 44px;
  --chat-bubble-avatar-radius: 7px;
}

.chat-thread-page--anon .chat-bubble-avatar {
  background: #d7d7d6 !important;
  color: #27282a;
  box-shadow: none !important;
}

.chat-thread-page--anon .chat-bubble-avatar.is-anon {
  background: #cfcfce !important;
}

.chat-thread-page--anon .scrapbook-bubble {
  border-radius: 5px !important;
  border: 1px solid rgba(30, 31, 33, 0.10) !important;
  box-shadow: none !important;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

.chat-thread-page--anon .chat-bubble-row.is-them .scrapbook-bubble,
.chat-thread-page--anon .chat-bubble-row.is-them .chat-bubble-body {
  background: var(--role-bubble-bg, var(--chat-session-bubble-other, var(--partner-bubble-bg, #fff)));
  color: var(--role-bubble-ink, var(--chat-session-bubble-ink-other, #222426));
}

.chat-thread-page--anon .chat-bubble-row.is-user .scrapbook-bubble,
.chat-thread-page--anon .chat-bubble-row.is-user .chat-bubble-body {
  background: var(--user-bubble-bg, var(--chat-session-bubble-self, var(--chat-user-bubble-bg-default, #747579)));
  color: var(--user-bubble-ink, var(--chat-session-bubble-ink-self, #fff));
}

.chat-thread-page--anon .chat-bubble-sender {
  margin-bottom: 5px;
  color: #606267 !important;
  font-size: 11px;
  font-weight: 700;
}

.chat-thread-page--anon .chat-bubble-time,
.chat-thread-page--anon .chat-bubble-read {
  margin-top: 4px;
  font-size: 10px;
  line-height: 1.2;
  color: #8a8c91 !important;
}

.chat-thread-page--anon .chat-bubble-row.is-user .chat-bubble-read {
  text-align: right;
}

.chat-thread-page--anon .chat-bubble-system-line,
.chat-thread-page--anon .date-divider {
  color: #777a80 !important;
}

.chat-thread-page--anon .chat-bubble-row.is-card .chat-bubble-card,
.chat-thread-page--anon .chat-bubble-row.is-media .chat-bubble-media {
  border-radius: 8px;
  overflow: hidden;
}

.chat-thread-page--anon .chat-composer-input {
  background: #ffffff !important;
  color: #222426 !important;
}

.chat-thread-page--anon .chat-composer-send {
  background: #1f2022 !important;
}

@media (max-width: 420px) {
  .chat-thread-page .chat-action-dock {
    gap: 8px;
  }
  .chat-thread-page .chat-action-chip {
    min-width: 42px;
  }
  .chat-thread-page .chat-action-chip::after {
    max-width: 48px;
  }
}
`;
// eslint-disable-next-line no-unused-vars -- 旧版内联窗样式，已废弃，保留备查
const WINDOW_THEME_CSS_LEGACY = `
.home-window-shell {
  --mw-ink: #33413f;
  --mw-ink-soft: rgba(51, 65, 63, 0.58);
  --mw-glass: rgba(250, 252, 249, 0.18);
  --mw-glass-strong: rgba(255, 255, 255, 0.48);
  --mw-glass-white: rgba(255, 255, 255, 0.74);
  --mw-frame: rgba(255, 255, 255, 0.92);
  --mw-frame-soft: rgba(255, 255, 255, 0.64);
  --mw-moss: #8f9d82;
  --mw-mist: #b3bbb8;
  position: relative;
  overflow: hidden;
  color: var(--mw-ink);
  background:
    linear-gradient(rgba(247, 248, 244, 0.10), rgba(247, 248, 244, 0.10)),
    var(--mw-panorama, url("assets/wallpapers/home-mood-default.png"));
  background-size: auto, 330% 100%;
  background-position: center, 0% center;
}

.home-window-shell::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    linear-gradient(90deg, rgba(255,255,255,0.42) 0 2.8%, transparent 2.8% 97.2%, rgba(255,255,255,0.44) 97.2% 100%),
    linear-gradient(180deg, rgba(255,255,255,0.62) 0 2.2%, transparent 2.2% 87%, rgba(255,255,255,0.50) 87% 100%);
  -webkit-backdrop-filter: blur(1.8px) saturate(112%);
  backdrop-filter: blur(1.8px) saturate(112%);
}

.home-window-shell::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: none;
  background:
    linear-gradient(100deg, transparent 0 12%, rgba(255,255,255,0.16) 22%, transparent 34%),
    linear-gradient(180deg, transparent 0 42%, rgba(255,255,255,0.62) 44%, rgba(255,255,255,0.28) 47%, transparent 50%),
    radial-gradient(circle at 12% 24%, rgba(255,255,255,0.40), transparent 23%),
    radial-gradient(circle at 70% 12%, rgba(255,255,255,0.22), transparent 24%);
  mix-blend-mode: screen;
}

.home-window-shell .mw-pages {
  position: relative;
  z-index: 2;
  height: 100%;
}

.home-window-shell .mw-page {
  min-width: 100%;
  height: 100%;
  padding: calc(30px + var(--safe-top)) 34px calc(152px + var(--safe-bottom));
  box-sizing: border-box;
  scroll-snap-align: start;
  position: relative;
  overflow: hidden;
  background:
    linear-gradient(rgba(247, 248, 244, 0.08), rgba(247, 248, 244, 0.08)),
    var(--mw-panorama, url("assets/wallpapers/home-mood-default.png"));
  background-size: auto, 330% 100%;
}

.home-window-shell .mw-page-one { background-position: center, 0% center; }
.home-window-shell .mw-page-two { background-position: center, 50% center; }
.home-window-shell .mw-page-three { background-position: center, 100% center; }

.home-window-shell .mw-weather-skin {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.home-window-shell .mw-weather-skin {
  z-index: 6;
}

.home-window-shell .mw-weather-skin.is-clear {
  background:
    radial-gradient(circle at 22% 12%, rgba(255,255,255,0.38), transparent 28%),
    linear-gradient(180deg, rgba(255,255,255,0.10), transparent 42%);
}

.home-window-shell .mw-weather-skin.is-fog {
  background: rgba(245, 250, 248, 0.42);
  -webkit-backdrop-filter: blur(8px) saturate(94%);
  backdrop-filter: blur(8px) saturate(94%);
}

.home-window-shell .mw-weather-skin.is-rain {
  background:
    radial-gradient(ellipse at 22% 18%, rgba(255,255,255,0.28), transparent 28%),
    repeating-linear-gradient(105deg, transparent 0 16px, rgba(215, 230, 232, 0.34) 16px 18px, transparent 18px 36px);
  animation: mw-rain-drift 10s linear infinite;
}

.home-window-shell .mw-weather-skin.is-rain::before,
.home-window-shell .mw-weather-skin.is-rain::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse at 18% 22%, rgba(255,255,255,0.48) 0 2px, transparent 3px),
    radial-gradient(ellipse at 62% 34%, rgba(255,255,255,0.42) 0 2px, transparent 3px),
    radial-gradient(ellipse at 76% 68%, rgba(255,255,255,0.38) 0 2px, transparent 3px);
  filter: blur(0.5px);
}

.home-window-shell .mw-weather-skin.is-rain::after {
  transform: translate(18px, 40px);
  opacity: 0.45;
}

@keyframes mw-rain-drift {
  0% { background-position: 0 0; }
  100% { background-position: 0 80px; }
}

.home-window-shell .mw-pane-frame {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
}

.home-window-shell .mw-pane-frame .rail {
  position: absolute;
  display: block;
  background: var(--mw-frame);
  box-shadow: 0 0 16px rgba(255,255,255,0.34), inset 0 0 0 1px rgba(255,255,255,0.24);
}

.home-window-shell .mw-pane-frame .rail-top { left: 0; right: 0; top: 2.6%; height: 12px; }
.home-window-shell .mw-pane-frame .rail-mid { left: 0; right: 0; top: 46.2%; height: 14px; opacity: 0.90; }
.home-window-shell .mw-pane-frame .rail-bottom { left: 0; right: 0; bottom: 10.8%; height: 20px; opacity: 0.48; }
.home-window-shell .mw-pane-frame .rail-left { left: 2.3%; top: 2.6%; bottom: 2.0%; width: 10px; }
.home-window-shell .mw-pane-frame .rail-right { right: 2.3%; top: 2.6%; bottom: 2.0%; width: 10px; }
.home-window-shell .mw-pane-frame .rail-diagonal {
  width: 13px;
  height: 70%;
  top: -9%;
  left: 65%;
  transform: rotate(-18.5deg);
  transform-origin: top center;
  opacity: 0.30;
  background: rgba(86, 95, 92, 0.46);
  box-shadow: 0 0 12px rgba(255,255,255,0.12);
}

.home-window-shell .mw-page-two .rail-diagonal { left: 10%; height: 122%; top: -20%; }
.home-window-shell .mw-page-three .rail-diagonal { left: -20%; height: 122%; top: -20%; }
.home-window-shell .mw-page-three .rail-diagonal-end { opacity: 0.22; }

.home-window-shell .mw-pane-frame .glass-block {
  position: absolute;
  display: block;
  background: rgba(255,255,255,0.38);
  -webkit-backdrop-filter: blur(8px) saturate(110%);
  backdrop-filter: blur(8px) saturate(110%);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.12);
  mix-blend-mode: screen;
}

.home-window-shell .mw-pane-frame .block-a { left: 9%; top: 10%; width: 43%; height: 30%; }
.home-window-shell .mw-pane-frame .block-b { right: 7%; top: 48%; width: 32%; height: 23%; }
.home-window-shell .mw-pane-frame .block-c { left: 8%; top: 11%; width: 84%; height: 20%; opacity: 0.36; }
.home-window-shell .mw-pane-frame .block-d { left: 8%; top: 13%; width: 40%; height: 30%; }
.home-window-shell .mw-pane-frame .block-e { right: 7%; top: 50%; width: 40%; height: 23%; opacity: 0.24; }

.home-window-shell .mw-clock-glass,
.home-window-shell .mw-side-pane,
.home-window-shell .mw-memo-glass,
.home-window-shell .mw-music-glass,
.home-window-shell .mw-calendar-glass,
.home-window-shell .mw-third-card-stack {
  background: var(--mw-glass);
  border: 1px solid rgba(255,255,255,0.30);
  -webkit-backdrop-filter: blur(16px) saturate(114%);
  backdrop-filter: blur(16px) saturate(114%);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10), 0 12px 28px rgba(32, 54, 48, 0.10);
}

.home-window-shell .mw-clock-glass,
.home-window-shell .mw-side-pane,
.home-window-shell .mw-keepsakes,
.home-window-shell .mw-portrait-window,
.home-window-shell .mw-love-stack,
.home-window-shell .mw-caption,
.home-window-shell .mw-third-layout,
.home-window-shell .mw-icon-row-top,
.home-window-shell .mw-page-three-apps,
.home-window-shell .mw-page-one-apps,
.home-window-shell .mw-icon-row-bottom {
  z-index: 4;
}

.home-window-shell .mw-clock-glass {
  width: min(72%, 270px);
  min-height: 230px;
  padding: 22px 20px 18px;
  border-radius: 4px;
  position: relative;
}

.home-window-shell .mw-clock-glass span {
  display: block;
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0;
  color: rgba(39, 51, 49, 0.78);
}

.home-window-shell .mw-clock-glass strong {
  display: block;
  margin-top: 12px;
  font-size: 58px;
  line-height: 0.95;
  font-weight: 300;
  letter-spacing: 0;
  color: rgba(35, 48, 45, 0.72);
}

.home-window-shell .mw-clock-glass i {
  position: absolute;
  left: 26px;
  bottom: 46px;
  width: 94px;
  height: 94px;
  border-radius: 50%;
  background: rgba(120, 153, 164, 0.50);
  filter: blur(0.2px);
}

.home-window-shell .mw-side-pane {
  position: absolute;
  right: 31px;
  bottom: calc(188px + var(--safe-bottom));
  width: 166px;
  min-height: 198px;
  padding: 26px 20px;
  border-radius: 4px;
}

.home-window-shell .mw-page-one-grid {
  position: absolute;
  inset: calc(26px + var(--safe-top)) 30px calc(186px + var(--safe-bottom)) 32px;
  z-index: 4;
}

.home-window-shell .mw-page-one-grid .mw-side-pane {
  right: auto;
  left: 180px;
  top: 78px;
  bottom: auto;
  width: 156px;
  min-height: 196px;
}

.home-window-shell .mw-circle-slot {
  position: absolute;
  left: 0;
  top: 50px;
  width: 106px;
  height: 106px;
  border-radius: 50%;
  padding: 0;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.34);
  background: rgba(255,255,255,0.14);
  box-shadow: 0 10px 24px rgba(35, 52, 45, 0.14);
}

.home-window-shell .mw-circle-slot img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.home-window-shell .mw-upload-fallback-circle {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: rgba(83, 108, 107, 0.66);
  font: 700 11px/1 ui-monospace, Menlo, Consolas, monospace;
}

.home-window-shell .mw-upload-fallback-circle i {
  width: 100%;
  height: 100%;
  display: block;
  background:
    radial-gradient(circle at 35% 36%, rgba(255,255,255,0.62), rgba(255,255,255,0.18) 42%, transparent 43%),
    linear-gradient(135deg, rgba(165, 189, 201, 0.52), rgba(255,255,255,0.14));
}

.home-window-shell .mw-upload-fallback-circle b {
  position: absolute;
  inset: auto 0 10px;
  text-align: center;
  letter-spacing: 1.2px;
}

.home-window-shell .mw-keepsakes {
  position: absolute;
  left: 40px;
  right: 42px;
  bottom: calc(132px + var(--safe-bottom));
  height: 54px;
}

.home-window-shell .mw-ticket {
  position: absolute;
  left: 0;
  bottom: 0;
  padding: 8px 12px;
  font: 11px/1 ui-monospace, Menlo, Consolas, monospace;
  color: rgba(255,255,255,0.74);
  background: rgba(255,255,255,0.16);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}

.home-window-shell .mw-stamp {
  position: absolute;
  width: 36px;
  height: 44px;
  background: rgba(255,255,255,0.82);
  box-shadow: 0 6px 14px rgba(32,54,48,0.10);
}

.home-window-shell .mw-stamp.one { right: 42px; bottom: 8px; transform: rotate(-10deg); }
.home-window-shell .mw-stamp.two { right: 18px; bottom: 0; transform: rotate(9deg); background: rgba(151,166,167,0.90); }

.home-window-shell .mw-portrait-window {
  position: relative;
  width: min(68vw, 286px);
  height: min(62vh, 518px);
  margin: calc(42px + var(--safe-top)) auto 0;
  padding: 10px;
  border-radius: 6px;
  background: rgba(255,255,255,0.94);
  box-shadow: 0 12px 30px rgba(32,54,48,0.18);
}

.home-window-shell .mw-portrait-photo {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: rgba(230, 244, 237, 0.42);
}

.home-window-shell .mw-portrait-upload {
  position: absolute;
  inset: 0;
  padding: 0;
  border-radius: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.home-window-shell .mw-portrait-photo::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0.34)),
    linear-gradient(100deg, transparent 0 16%, rgba(255,255,255,0.26) 35%, transparent 58%);
  -webkit-backdrop-filter: blur(0.6px);
  backdrop-filter: blur(0.6px);
}

.home-window-shell .mw-portrait-photo img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  opacity: 0.78;
  filter: saturate(0.92) contrast(0.96);
}

.home-window-shell .mw-char-empty {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font: 700 22px/1 ui-monospace, Menlo, Consolas, monospace;
  color: rgba(75, 94, 83, 0.30);
}

.home-window-shell .mw-polaroid-shine {
  position: absolute;
  left: 0;
  right: 0;
  top: 55%;
  height: 54px;
  background: rgba(255,255,255,0.40);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  pointer-events: none;
}

.home-window-shell .mw-love-stack {
  position: absolute;
  right: 34px;
  top: calc(52px + var(--safe-top) + min(47vh, 392px));
  width: 118px;
  height: 76px;
  transform: rotate(-8deg);
}

.home-window-shell .mw-love-stack i,
.home-window-shell .mw-love-stack b {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 15px;
  font-weight: 700;
  font-style: normal;
}

.home-window-shell .mw-love-stack i {
  transform: translate(-14px, -10px) rotate(-7deg);
  background: rgba(255,255,255,0.92);
}

.home-window-shell .mw-love-stack b {
  color: rgba(250,255,250,0.86);
  background: rgba(143, 159, 162, 0.92);
}

.home-window-shell .mw-caption {
  position: absolute;
  left: 36px;
  right: 36px;
  bottom: calc(228px + var(--safe-bottom));
  margin: 0;
  font: 11px/1.2 ui-monospace, Menlo, Consolas, monospace;
  color: rgba(255,255,255,0.78);
  text-shadow: 0 1px 8px rgba(29, 50, 38, 0.36);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.home-window-shell .mw-third-layout {
  position: absolute;
  inset: calc(52px + var(--safe-top)) 32px auto;
  display: grid;
  grid-template-columns: 1.08fr 0.92fr;
  gap: 14px;
  align-items: start;
}

.home-window-shell .mw-memo-glass,
.home-window-shell .mw-music-glass,
.home-window-shell .mw-calendar-glass,
.home-window-shell .mw-third-card-stack {
  border-radius: 4px;
  padding: 14px;
}

.home-window-shell .mw-memo-glass {
  min-height: 186px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.home-window-shell .mw-memo-glass span,
.home-window-shell .mw-calendar-glass span,
.home-window-shell .mw-music-copy span {
  font: 700 11px/1 ui-monospace, Menlo, Consolas, monospace;
  letter-spacing: 0;
  color: rgba(51,65,63,0.56);
}

.home-window-shell .mw-memo-glass em {
  font-style: normal;
  font-size: 13px;
  color: rgba(51,65,63,0.70);
}

.home-window-shell .mw-music-glass {
  min-height: 112px;
  display: flex;
  gap: 10px;
  align-items: center;
}

.home-window-shell .mw-music-copy {
  min-width: 0;
  flex: 1;
}

.home-window-shell .mw-music-copy strong,
.home-window-shell .mw-music-copy em {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.home-window-shell .mw-music-copy strong {
  margin-top: 7px;
  font-size: 14px;
  color: rgba(51,65,63,0.76);
}

.home-window-shell .mw-music-copy em {
  margin-top: 4px;
  font-style: normal;
  font-size: 11px;
  color: rgba(51,65,63,0.52);
}

.home-window-shell .mw-music-copy i {
  display: block;
  height: 3px;
  margin-top: 10px;
  background: rgba(255,255,255,0.42);
  overflow: hidden;
}

.home-window-shell .mw-music-copy i b {
  display: block;
  width: 100%;
  height: 100%;
  transform-origin: left center;
  background: rgba(125,144,103,0.58);
}

.home-window-shell .mw-music-disc {
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255,255,255,0.74) 0 20%, rgba(125,144,103,0.42) 22% 100%);
}

.home-window-shell .mw-music-disc.is-playing {
  animation: mw-spin 6s linear infinite;
}

@keyframes mw-spin { to { transform: rotate(360deg); } }

.home-window-shell .mw-calendar-glass {
  min-height: 116px;
}

.home-window-shell .mw-third-card-stack {
  min-height: 116px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
}

.home-window-shell .mw-third-tag {
  font: 700 11px/1 ui-monospace, Menlo, Consolas, monospace;
  letter-spacing: 1px;
  color: rgba(51,65,63,0.56);
}

.home-window-shell .mw-third-note {
  flex: 1;
  display: grid;
  place-items: center;
  border-radius: 2px;
  background: rgba(255,255,255,0.26);
  color: rgba(51,65,63,0.70);
  font-size: 14px;
  font-weight: 700;
}

.home-window-shell .mw-calendar-glass strong {
  display: block;
  margin-top: 10px;
  font-size: 52px;
  line-height: 0.9;
  font-weight: 300;
  color: rgba(51,65,63,0.70);
}

.home-window-shell .mw-generate {
  min-height: 38px;
  border: 1px solid rgba(255,255,255,0.52);
  background: rgba(255,255,255,0.24);
  color: rgba(51,65,63,0.70);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  font: 700 12px/1 ui-monospace, Menlo, Consolas, monospace;
}

.home-window-shell .mw-generate:disabled {
  opacity: 0.58;
}

.home-window-shell .mw-app-row {
  display: grid;
  gap: 22px;
}

.home-window-shell .mw-four-grid {
  grid-template-columns: repeat(2, 1fr);
  gap: 32px 30px;
}

.home-window-shell .mw-icon-row-top,
.home-window-shell .mw-page-three-apps {
  position: absolute;
  left: 35px;
  right: 35px;
  grid-template-columns: repeat(4, 1fr);
}

.home-window-shell .mw-icon-row-top { bottom: calc(144px + var(--safe-bottom)); }
.home-window-shell .mw-icon-row-bottom {
  position: absolute;
  left: 35px;
  right: 35px;
  bottom: calc(82px + var(--safe-bottom));
  grid-template-columns: repeat(4, 1fr);
}
.home-window-shell .mw-page-three-apps { bottom: calc(132px + var(--safe-bottom)); }

.home-window-shell .mw-app {
  position: relative;
  width: 58px;
  height: 58px;
  margin: 0 auto;
  padding: 0;
  border: 0;
  background: transparent;
}

.home-window-shell .mw-app-glass {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: rgba(255,255,255,0.88);
  color: rgba(84, 104, 99, 0.46);
  -webkit-backdrop-filter: blur(12px) saturate(106%);
  backdrop-filter: blur(12px) saturate(106%);
  box-shadow: 0 6px 16px rgba(31, 52, 45, 0.08), inset 0 0 0 1px rgba(255,255,255,0.32);
}

.home-window-shell .mw-side-pane .mw-app-glass {
  background: rgba(125,144,103,0.86);
  color: rgba(255,255,255,0.58);
}

.home-window-shell.is-window-page-0 .mw-dock .mw-app-glass {
  background: rgba(125,144,103,0.84);
  color: rgba(255,255,255,0.58);
}

.home-window-shell.is-window-page-1 .mw-dock .mw-app-glass,
.home-window-shell.is-window-page-2 .mw-dock .mw-app-glass {
  background: rgba(255,255,255,0.90);
  color: rgba(84,104,99,0.44);
}

.home-window-shell .mw-app svg {
  width: 28px;
  height: 28px;
  opacity: 0.76;
}

.home-window-shell .mw-app svg path,
.home-window-shell .mw-app svg rect,
.home-window-shell .mw-app svg circle {
  fill: none;
  stroke: currentColor;
  stroke-width: 3.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.home-window-shell .mw-app svg [fill="currentColor"] {
  fill: currentColor;
  stroke: none;
}

.home-window-shell .mw-icon-img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  border-radius: 6px;
}

.home-window-shell .mw-bottom {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 8;
  padding: 0 24px calc(18px + var(--safe-bottom));
  pointer-events: none;
}

.home-window-shell .mw-dock {
  height: 86px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  align-items: center;
  padding: 0 18px;
  background: rgba(255,255,255,0.34);
  border-top: 1px solid rgba(255,255,255,0.30);
  -webkit-backdrop-filter: blur(20px) saturate(110%);
  backdrop-filter: blur(20px) saturate(110%);
  pointer-events: auto;
}

.home-window-shell .mw-dock .mw-app {
  width: 52px;
  height: 52px;
}

.home-window-shell .home-indicators {
  margin: 0 auto 9px;
  pointer-events: none;
}

.home-window-shell .home-indicators .dot {
  background: rgba(255,255,255,0.56);
}

.home-window-shell .home-indicators .dot.active {
  background: rgba(125,144,103,0.78);
}

.home-window-shell .mw-upload-slot {
  position: relative;
  border: 0;
  padding: 0;
  margin: 0;
  cursor: pointer;
  overflow: hidden;
  display: block;
  background: transparent;
}

.home-window-shell .mw-upload-slot.is-empty {
  background: rgba(255,255,255,0.18);
}

.home-window-shell .mw-upload-clear {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(255,255,255,0.78);
  color: rgba(71, 87, 86, 0.74);
  font: 700 14px/1 ui-monospace, Menlo, Consolas, monospace;
  box-shadow: 0 4px 10px rgba(32, 54, 48, 0.12);
}

.home-window-shell .mw-upload-slot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.home-window-shell .mw-upload-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font: 700 11px/1 ui-monospace, Menlo, Consolas, monospace;
  letter-spacing: 1px;
  color: rgba(83,108,107,0.62);
  background: linear-gradient(135deg, rgba(255,255,255,0.28), rgba(255,255,255,0.10));
}

.home-window-shell .mw-page-one-apps {
  position: absolute;
  left: 32px;
  right: 32px;
  bottom: 18px;
  grid-template-columns: repeat(4, 1fr);
}

.home-window-shell .mw-page-one-apps .mw-app-glass {
  background: rgba(255,255,255,0.82);
}

@media (max-height: 740px) {
  .home-window-shell .mw-page {
    padding-top: calc(20px + var(--safe-top));
  }
  .home-window-shell .mw-clock-glass {
    min-height: 206px;
  }
  .home-window-shell .mw-clock-glass strong {
    font-size: 52px;
  }
  .home-window-shell .mw-portrait-window {
    height: min(60vh, 430px);
  }
  .home-window-shell .mw-love-stack {
    top: calc(426px + var(--safe-top));
  }
  .home-window-shell .mw-caption {
    top: calc(506px + var(--safe-top));
  }

  .home-window-shell .mw-page-one-grid {
    inset: calc(18px + var(--safe-top)) 24px calc(172px + var(--safe-bottom)) 24px;
  }

  .home-window-shell .mw-circle-slot {
    top: 42px;
    width: 96px;
    height: 96px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .home-window-shell .mw-weather-skin.is-rain,
  .home-window-shell .mw-music-disc.is-playing {
    animation: none;
  }
}
`;

/**
 * 海主题（内置模板）版本号。
 * 铁律：版本升级只能补默认缺项，不能全量覆盖用户已编辑字段。
 * 很多用户直接编辑内置「棉花糖之海」而不会另存预设，不能因为 bump 版本丢壁纸、图片槽、
 * 图标、CSS、字体、布局或自定义组件。
 * v8：剥离主题 CSS 里仿微信气泡底色硬编码（#95ec69 !important 等），恢复取色器与美化 CSS。
 * v9：内置视觉改由静态 CSS 提供；仅清空与历史内置快照完全相同的 CSS，保留用户编辑。
 */
const SEA_PRESET_VERSION = 9;
const WINDOW_PRESET_VERSION = 10;
const ALBUM_PRESET_VERSION = 15;

/** 旧海主题把仿微信绿/白写进 customTheme.css 且带 !important，会锁死气泡色。 */
function cssHasLegacyWechatBubbleLock(cssText) {
  const css = String(cssText || '');
  if (!css) return false;
  if (/#95ec69\s*!important/i.test(css)) return true;
  if (/\.chat-bubble-row\.is-self\b/i.test(css) && /#95ec69/i.test(css)) return true;
  if (
    /\.chat-bubble-row\.is-user\s+\.scrapbook-bubble\s*\{[^}]*background\s*:\s*#95ec69\s*!important/i.test(css)
  ) return true;
  if (
    /\.chat-bubble-row\.is-them\s+\.scrapbook-bubble\s*\{[^}]*background\s*:\s*#fff(?:fff)?\s*!important/i.test(css)
    && /#95ec69/i.test(css)
  ) return true;
  return false;
}

/**
 * 解锁主题/全局聊天 CSS 里的仿微信气泡底色硬编码，改为公开变量链；
 * 旧 .is-self/.chat-bubble 选择器一并迁到现行类名。不碰用户其它自定义规则。
 */
function migrateLegacyWechatBubbleLocks(cssText) {
  let css = String(cssText || '');
  if (!css || !cssHasLegacyWechatBubbleLock(css)) {
    return { css, changed: false };
  }
  const before = css;

  css = css.replace(/\.chat-bubble-row\.is-self\s+\.chat-bubble\b/g, '.chat-bubble-row.is-user .scrapbook-bubble');
  css = css.replace(/\.chat-bubble-row:not\(\.is-self\)\s+\.chat-bubble\b/g, '.chat-bubble-row.is-them .scrapbook-bubble');
  css = css.replace(/\.chat-bubble-row\.is-self\b/g, '.chat-bubble-row.is-user');

  // 宽选择器先收窄到奶油 chat，避免 Ins 会话被微信绿盖住
  css = css.replace(
    /\.chat-thread-page\s+\.chat-bubble-row\.is-user\s+\.scrapbook-bubble\b/g,
    '.chat-thread-page:not(.chat-thread-page--anon):not(.chat-thread-page--ins) .chat-bubble-row.is-user .scrapbook-bubble',
  );
  css = css.replace(
    /\.chat-thread-page\s+\.chat-bubble-row\.is-them\s+\.scrapbook-bubble\b/g,
    '.chat-thread-page:not(.chat-thread-page--anon):not(.chat-thread-page--ins) .chat-bubble-row.is-them .scrapbook-bubble',
  );

  // 主题存档里的气泡底色改由 chat.css 变量链负责；直接删掉仿微信色块
  css = css.replace(
    /\.chat-thread-page(?::not\([^)]+\))*\s+\.chat-bubble-row\.is-user\s+\.scrapbook-bubble\s*\{[^}]*#95ec69[^}]*\}/gi,
    '',
  );
  css = css.replace(
    /\.chat-thread-page(?::not\([^)]+\))*\s+\.chat-bubble-row\.is-them\s+\.scrapbook-bubble\s*\{[^}]*background\s*:\s*#fff(?:fff)?\s*!important[^}]*\}/gi,
    '',
  );
  // 仍残留的硬编码绿（写在别的选择器里）改为变量链，至少让取色器生效
  css = css.replace(
    /background\s*:\s*#95ec69\s*!important\s*;/gi,
    'background: var(--user-bubble-bg, var(--chat-session-bubble-self, var(--chat-user-bubble-bg-default, #95ec69)));',
  );

  return { css, changed: css !== before };
}

function migrateThemeBubbleCssFields(theme) {
  if (!theme || typeof theme !== 'object') return theme;
  const custom = theme.customTheme && typeof theme.customTheme === 'object'
    ? { ...theme.customTheme }
    : null;
  if (!custom) return theme;
  let changed = false;
  const cssMig = migrateLegacyWechatBubbleLocks(custom.css);
  if (cssMig.changed) {
    custom.css = cssMig.css;
    changed = true;
  }
  const chatMig = migrateLegacyWechatBubbleLocks(custom.chatCss);
  if (chatMig.changed) {
    custom.chatCss = chatMig.css;
    changed = true;
  }
  // 美化工作室已改用 pageCss['chat-thread'] 作为聊天页的唯一发布槽。
  // 旧版 chatCss 若同时保留，会与新版样式一起注入，用户在任一入口清空后
  // 另一层仍然存在，看起来像“两套美化叠加且无法取消”。新版槽存在时
  // 以新版为准，只移除已经被取代的旧槽；仅有旧槽的主题继续兼容。
  const publishedChatCss = String(custom.pageCss?.['chat-thread'] || '').trim();
  if (publishedChatCss && String(custom.chatCss || '').trim()) {
    custom.chatCss = '';
    changed = true;
  }
  if (!changed) return theme;
  return { ...theme, customTheme: custom };
}

/** 内置默认壁纸（与 preview-home 定稿一致） */
export const DEFAULT_WALLPAPER_PATH = 'assets/wallpapers/home-mood-default.png';
/** 棉花糖之窗专属横图：作为「横图无缝铺满三页」的全景源图 */
export const WINDOW_WALLPAPER_PATH = 'assets/wallpapers/window-bg-pano.png';
export const ALBUM_WALLPAPER_PATH = 'assets/wallpapers/album-cat-wallpaper-v2.webp';
/** 棉花糖之窗默认全景：整张横图横跨三页、随滑动 1:1 平移，无缝拼接（仅窗主题） */
export const WINDOW_HOME_PANORAMA = { src: WINDOW_WALLPAPER_PATH, pages: 3 };
export const WALLPAPER_NONE = '__none__';
export const DEFAULT_WALLPAPER_OVERLAY = 0.22;
export const DEFAULT_SEA_GRADIENT_WARM = '#f6d68a';
export const DEFAULT_SEA_GRADIENT_COOL = '#aad7eb';
export const DEFAULT_SEA_GRADIENT_STRENGTH = 1;
export const DEFAULT_SEA_MUSIC_BG = '#ffffff';
export const DEFAULT_SEA_MUSIC_BG_OPACITY = 0.2;
export const DEFAULT_SEA_MUSIC_TEXT = '#36586a';
export const DEFAULT_SEA_MUSIC_ACCENT = '#d29a3f';
export const DEFAULT_CHAT_BUBBLE_FONT_SIZE = 14;
export const MIN_CHAT_BUBBLE_FONT_SIZE = 12;
export const MAX_CHAT_BUBBLE_FONT_SIZE = 19;

export const DEFAULT_FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Kaiti", "STKaiti", sans-serif';
export const CUSTOM_FONT_FAMILY = 'MarshmallowUserFont';
export const MAX_CUSTOM_FONT_BYTES = 30 * 1024 * 1024;

const SCRAPBOOK_HOME_WIDGET_DEFS = {
  userHeader: { id: 'userHeader', kind: 'widget', label: '用户卡片', placement: '第一页 · 顶部', widgetType: 'userHeader', size: { cols: 4, rows: 1 }, page: 0 },
  polaroidP1: { id: 'polaroidP1', kind: 'widget', label: '拍立得', placement: '第一页 · 右侧', widgetType: 'polaroidP1', size: { cols: 2, rows: 2 }, page: 0 },
  noteMemo: { id: 'noteMemo', kind: 'widget', label: '备忘录', placement: '第二页 · 顶部', widgetType: 'noteMemo', size: { cols: 4, rows: 2 }, page: 1 },
  filmWidget: { id: 'filmWidget', kind: 'widget', label: '胶片装饰', placement: '第二页 · 底部', widgetType: 'filmWidget', size: { cols: 4, rows: 2 }, page: 1 },
  calendarWidget: { id: 'calendarWidget', kind: 'widget', label: '日历', placement: '第三页 · 顶部', widgetType: 'calendarWidget', size: { cols: 4, rows: 2 }, page: 2 },
  polaroidP3: { id: 'polaroidP3', kind: 'widget', label: '拍立得', placement: '第三页 · 中部', widgetType: 'polaroidP3', size: { cols: 2, rows: 2 }, page: 2 },
  scrapbookFourthDecor: { id: 'scrapbookFourthDecor', kind: 'widget', label: '纸样收藏票', placement: '第四页 · 顶部', widgetType: 'scrapbookFourthDecor', size: { cols: 4, rows: 2 }, page: 3 },
};

const SEA_HOME_WIDGET_DEFS = {
  seaHero: { id: 'seaHero', kind: 'widget', label: '海面时钟', placement: '第一页 · 顶部大时钟', widgetType: 'seaHero', size: { cols: 4, rows: 2 }, page: 0 },
  seaPortrait: { id: 'seaPortrait', kind: 'widget', label: '海边头像', placement: '第一页 · 顶部头像卡', widgetType: 'seaPortrait', size: { cols: 2, rows: 2 }, page: 0 },
  seaMusicP1: { id: 'seaMusicP1', kind: 'widget', label: '音乐胶囊', placement: '第一页 · 底部播放条', widgetType: 'seaMusic', size: { cols: 4, rows: 1 }, page: 0 },
  seaCharGallery: { id: 'seaCharGallery', kind: 'widget', label: '角色立绘', placement: '第二页 · 右侧相册', widgetType: 'seaCharGallery', size: { cols: 2, rows: 3 }, page: 1 },
  seaFloatNote: { id: 'seaFloatNote', kind: 'widget', label: '海风文案', placement: '第二页 · 中部诗句区', widgetType: 'seaFloatNote', size: { cols: 4, rows: 2 }, page: 1 },
  seaMusicP2: { id: 'seaMusicP2', kind: 'widget', label: '音乐胶囊', placement: '第二页 · 底部播放条', widgetType: 'seaMusic', size: { cols: 4, rows: 1 }, page: 1 },
  seaAtmo: { id: 'seaAtmo', kind: 'widget', label: '氛围时钟卡', placement: '第三页 · 顶部', widgetType: 'seaAtmo', size: { cols: 4, rows: 1 }, page: 2 },
  seaStreaks: { id: 'seaStreaks', kind: 'widget', label: '习惯打卡条', placement: '第三页 · 中部左侧', widgetType: 'seaStreaks', size: { cols: 2, rows: 2 }, page: 2 },
  seaPolaroid: { id: 'seaPolaroid', kind: 'widget', label: '海边拍立得', placement: '第三页 · 中部右侧', widgetType: 'seaPolaroid', size: { cols: 2, rows: 2 }, page: 2 },
  seaPostcard: { id: 'seaPostcard', kind: 'widget', label: '海边明信片', placement: '第三页 · 底部', widgetType: 'seaPostcard', size: { cols: 3, rows: 2 }, page: 2 },
  seaFourthDecor: { id: 'seaFourthDecor', kind: 'widget', label: '潮汐来信', placement: '第四页 · 顶部', widgetType: 'seaFourthDecor', size: { cols: 4, rows: 2 }, page: 3 },
};

const WINDOW_HOME_WIDGET_DEFS = {
  userHeader: { id: 'userHeader', kind: 'widget', label: '窗前主卡', placement: '第一页 · 顶部时钟', widgetType: 'userHeader', size: { cols: 4, rows: 2 }, page: 0 },
  polaroidP1: { id: 'polaroidP1', kind: 'widget', label: '圆图窗格', placement: '第一页 · 左上磨砂窗', widgetType: 'polaroidP1', size: { cols: 2, rows: 2 }, page: 0 },
  noteMemo: { id: 'noteMemo', kind: 'widget', label: '窗边便签', placement: '第三页 · 便签区', widgetType: 'noteMemo', size: { cols: 4, rows: 2 }, page: 2 },
  filmWidget: { id: 'filmWidget', kind: 'widget', label: '黑胶音乐卡', placement: '第三页 · 方形播放器', widgetType: 'filmWidget', size: { cols: 4, rows: 2 }, page: 2 },
  calendarWidget: { id: 'calendarWidget', kind: 'widget', label: '窗边日历', placement: '第三页 · 日历条', widgetType: 'calendarWidget', size: { cols: 4, rows: 1 }, page: 2 },
  polaroidP3: { id: 'polaroidP3', kind: 'widget', label: '人像窗', placement: '第二页 · 大半屏人像', widgetType: 'polaroidP3', size: { cols: 2, rows: 2 }, page: 1 },
  windowFourthDecor: { id: 'windowFourthDecor', kind: 'widget', label: '光影片段', placement: '第四页 · 顶部', widgetType: 'windowFourthDecor', size: { cols: 4, rows: 2 }, page: 3 },
};

const ALBUM_HOME_WIDGET_DEFS = {
  albumLeadCard: { id: 'albumLeadCard', kind: 'widget', label: '首页动态大卡', placement: '第一页 · 顶部', widgetType: 'albumLeadCard', size: { cols: 4, rows: 3 }, page: 0 },
  albumHeroMain: { id: 'albumHeroMain', kind: 'widget', label: '相册主照片', placement: '第二页 · 左侧', widgetType: 'albumHeroMain', size: { cols: 2, rows: 3 }, page: 1 },
  albumHeroNote: { id: 'albumHeroNote', kind: 'widget', label: '相册便签', placement: '第二页 · 右下', widgetType: 'albumHeroNote', size: { cols: 2, rows: 1 }, page: 1 },
  albumHeroSmall: { id: 'albumHeroSmall', kind: 'widget', label: '相册副照片', placement: '第二页 · 右上', widgetType: 'albumHeroSmall', size: { cols: 2, rows: 2 }, page: 1 },
  calendarWidget: { id: 'calendarWidget', kind: 'widget', label: '极简日历', placement: '第四页 · 顶部', widgetType: 'calendarWidget', size: { cols: 4, rows: 2 }, page: 3 },
  polaroidP1: { id: 'polaroidP1', kind: 'widget', label: '拍立得', placement: '第四页 · 左侧', widgetType: 'polaroidP1', size: { cols: 2, rows: 2 }, page: 3 },
  polaroidP3: { id: 'polaroidP3', kind: 'widget', label: '拍立得', placement: '第四页 · 右侧', widgetType: 'polaroidP3', size: { cols: 2, rows: 2 }, page: 3 },
  albumDate: { id: 'albumDate', kind: 'widget', label: '日期照片卡', placement: '第二页 · 顶部', widgetType: 'albumDate', size: { cols: 4, rows: 1 }, page: 1 },
  albumMusic: { id: 'albumMusic', kind: 'widget', label: '音乐播放器', placement: '第三页 · 左侧', widgetType: 'albumMusic', size: { cols: 2, rows: 3 }, page: 2 },
  albumNotes: { id: 'albumNotes', kind: 'widget', label: '阅读与待办', placement: '第三页 · 右侧', widgetType: 'albumNotes', size: { cols: 2, rows: 3 }, page: 2 },
  albumStrip: { id: 'albumStrip', kind: 'widget', label: '归档短笺', placement: '第三页 · 底部', widgetType: 'albumStrip', size: { cols: 4, rows: 1 }, page: 2 },
  albumFuture: { id: 'albumFuture', kind: 'widget', label: '未来书签', placement: '第五页 · 顶部', widgetType: 'albumFuture', size: { cols: 3, rows: 1 }, page: 4 },
};

const ALBUM_ONLY_HOME_WIDGET_DEFS = Object.fromEntries(
  ['albumLeadCard', 'albumHeroMain', 'albumHeroNote', 'albumHeroSmall', 'albumDate', 'albumMusic', 'albumNotes', 'albumStrip', 'albumFuture']
    .map((id) => [id, ALBUM_HOME_WIDGET_DEFS[id]]),
);

export const DEFAULT_WIDGET_VISIBILITY = {
  userHeader: true,
  polaroidP1: true,
  polaroidP3: true,
  noteMemo: true,
  filmWidget: true,
  albumLeadCard: true,
  albumHeroMain: true,
  albumHeroNote: true,
  albumHeroSmall: true,
  calendarWidget: true,
  scrapbookFourthDecor: true,
  seaFourthDecor: true,
  windowFourthDecor: true,
  albumDate: true,
  albumMusic: true,
  albumNotes: true,
  albumStrip: true,
  albumFuture: true,
  seaHero: true,
  seaPortrait: true,
  seaMusicP1: true,
  seaMusicP2: true,
  seaCharGallery: true,
  seaFloatNote: true,
  seaAtmo: true,
  seaStreaks: true,
  seaPolaroid: true,
  seaPostcard: true,
};

export const HOME_LAYOUT_COLS = 4;
export const HOME_LAYOUT_ROWS = 5;
export const HOME_LAYOUT_PAGE_SIZE = HOME_LAYOUT_COLS * HOME_LAYOUT_ROWS;
export const HOME_EMPTY_SLOT_PREFIX = '__empty-slot:';
// 内置主题以 5 页作为初始构图；用户整理主屏后可删到只剩 1 页。
export const MIN_HOME_PAGES = 1;
export const MAX_HOME_PAGES = 6;

export const COMING_SOON_APP_IDS = [
  'live',
  'couple-space',
  'parallel-universe',
  'play-together',
  'strategy-game',
];

export const BUILTIN_HOME_WIDGET_DEFS = {
  ...SCRAPBOOK_HOME_WIDGET_DEFS,
  ...SEA_HOME_WIDGET_DEFS,
  ...WINDOW_HOME_WIDGET_DEFS,
  ...ALBUM_ONLY_HOME_WIDGET_DEFS,
};

/** 可进入图标网格拖动的主题原生组件（仅手账卡片系）。
 * 海主题构图是非网格的（左图标+右立绘+下方文案），进网格必走形；
 * 海卡片组件改走固定槽位 + 换页，不进 HOME_GRID_BUILTIN_IDS。 */
export const HOME_GRID_BUILTIN_IDS = new Set([
  ...Object.keys(SCRAPBOOK_HOME_WIDGET_DEFS),
  ...Object.keys(ALBUM_ONLY_HOME_WIDGET_DEFS),
  'windowFourthDecor',
]);

/** 海主题可换页、但不进图标网格的卡片组件 */
export const SEA_LOOSE_BUILTIN_IDS = new Set([
  'seaFloatNote',
  'seaStreaks',
  'seaPolaroid',
  'seaPostcard',
  'seaFourthDecor',
]);

export function getBuiltinHomeWidgetDef(id) {
  const key = String(id || '').trim();
  return key && BUILTIN_HOME_WIDGET_DEFS[key] ? BUILTIN_HOME_WIDGET_DEFS[key] : null;
}

export function isHomeGridBuiltinId(id) {
  return HOME_GRID_BUILTIN_IDS.has(String(id || '').trim());
}

export function isSeaLooseBuiltinId(id) {
  return SEA_LOOSE_BUILTIN_IDS.has(String(id || '').trim());
}

const DEFAULT_APP_LABELS = {
  chat: 'Chat',
  worldbook: '世界书',
  preset: '预设',
  encounter: '相遇',
  weibo: '微博',
  forum: '论坛',
  stickers: '表情包',
  au: '特殊设定',
  radio: '电台',
  memory: '记忆',
  music: '音乐',
  'travel-char': '旅行char',
  extensions: '扩展库',
  'anon-chat': '匿名聊',
  'character-phone': '他的手机',
  mailbox: '邮箱',
  appearance: '美化',
  beautify: '美化工作室',
  live: '直播',
  'couple-space': '情侣空间',
  'together-reading': '一起读',
  'parallel-universe': '平行宇宙',
  mcp: 'MCP',
  'play-together': '一起玩',
  'strategy-game': '攻略游戏',
  'my-space': '我的',
  contacts: '通讯录',
  calendar: '日程表',
  settings: '设置',
};

export const DEFAULT_APP_ICON_FRAME_OPACITY = 1;

const DEFAULT_WIDGETS = {
  polaroidCaptionP1: '今日份的开心 ☁️',
  polaroidCaptionP3: '我的小记',
  noteTitle: '备忘录',
  noteItems: ['整理设定集', '给盆栽浇水 🌱', '晚上看电影'],
  calendarHeader: '',
  albumArchiveText: '把今天想留下的，收进这一页。',
};

function createDefaultHomeLayout() {
  return {
    version: 9,
    pages: [
      ['userHeader', 'chat', 'worldbook', 'preset', 'encounter', 'polaroidP1'],
      ['noteMemo', 'weibo', 'forum', 'stickers', 'anon-chat', 'radio', 'filmWidget'],
      ['calendarWidget', 'polaroidP3', 'memory', 'music', 'mailbox', 'character-phone', 'au'],
      ['scrapbookFourthDecor', 'travel-char', 'extensions', 'mcp', 'appearance', 'beautify'],
      ['together-reading', ...COMING_SOON_APP_IDS],
    ],
    dock: ['contacts', 'calendar', 'settings', 'my-space'],
    customItems: {},
  };
}

function createSeaHomeLayout() {
  const layout = createDefaultHomeLayout();
  layout.pages[3] = ['seaFourthDecor', 'travel-char', 'extensions', 'mcp', 'appearance', 'beautify'];
  return layout;
}

// 窗主题专属分页：第 1 页 2×2、第 2 页一行 4 个（人像窗占大半），其余落到第 3 页。
// 窗组件（圆图/人像/音乐）按窗渲染器固定摆位，这里只决定 App 图标的分页归属。
function createWindowHomeLayout() {
  return {
    version: 9,
    pages: [
      ['userHeader', 'polaroidP1', 'chat', 'worldbook', 'preset', 'encounter'],
      ['polaroidP3', 'weibo', 'forum', 'stickers', 'anon-chat', 'radio'],
      ['filmWidget', 'memory', 'music', 'mailbox', 'character-phone', 'au'],
      ['windowFourthDecor', 'travel-char', 'extensions', 'mcp', 'appearance', 'beautify'],
      ['together-reading', ...COMING_SOON_APP_IDS],
    ],
    dock: ['contacts', 'calendar', 'settings', 'my-space'],
    customItems: {},
  };
}

const ALBUM_HOME_LAYOUT_V8 = {
  version: 8,
  pages: [
    ['albumHeroMain', 'albumHeroNote', 'albumHeroSmall', 'chat', 'worldbook', 'preset', 'encounter'],
    ['albumDate', 'weibo', 'forum', 'stickers', 'anon-chat', 'radio', 'memory', 'mailbox', 'character-phone'],
    ['albumMusic', 'albumNotes', 'albumStrip', 'music', 'extensions', 'mcp', 'appearance', 'beautify'],
    ['calendarWidget', 'polaroidP1', 'polaroidP3', 'au', 'travel-char'],
    ['together-reading', ...COMING_SOON_APP_IDS],
  ],
  dock: ['contacts', 'calendar', 'settings', 'my-space'],
  customItems: {},
};

// 旧「复位」按钮曾生成另一份系统默认：MCP 在第四页，且第五页包含未来书签。
// 它同样不是用户手工排版，只在内容与顺序完全吻合时升级。
const ALBUM_HOME_RESET_LAYOUT_V8 = {
  version: 8,
  pages: [
    ['albumHeroMain', 'albumHeroNote', 'albumHeroSmall', 'chat', 'worldbook', 'preset', 'encounter'],
    ['albumDate', 'weibo', 'forum', 'stickers', 'anon-chat', 'radio', 'memory', 'mailbox', 'character-phone'],
    ['albumMusic', 'albumNotes', 'albumStrip', 'music', 'extensions', 'appearance', 'beautify'],
    ['calendarWidget', 'polaroidP1', 'polaroidP3', 'au', 'travel-char', 'mcp'],
    ['albumFuture', 'together-reading', ...COMING_SOON_APP_IDS],
  ],
  dock: ['contacts', 'calendar', 'settings', 'my-space'],
  customItems: {},
};

const ALBUM_HOME_LAYOUT_V9_INTERIM = {
  version: 9,
  pages: [
    ['chat', 'character-phone', 'albumHeroSmall', 'albumHeroMain', 'encounter', 'worldbook', 'albumHeroNote', 'preset', 'beautify', 'radio'],
    ['albumDate', 'polaroidP1', 'weibo', 'forum', 'stickers', 'anon-chat', 'memory', 'mailbox'],
    ['albumMusic', 'music', 'appearance', 'albumNotes', 'mcp', 'albumStrip'],
    ['calendarWidget', 'polaroidP3', 'au', 'travel-char', 'extensions'],
    ['albumFuture', 'together-reading', ...COMING_SOON_APP_IDS],
  ],
  dock: ['contacts', 'calendar', 'settings', 'my-space'],
  customItems: {},
};

// v11 的默认布局：仅用于识别完全未整理过主屏的内置主题，升级时替换首页大卡。
const ALBUM_HOME_LAYOUT_V11 = {
  version: 9,
  pages: [
    ['chat', 'character-phone', 'albumHeroSmall', 'albumHeroMain', 'encounter', 'worldbook', 'albumHeroNote', 'preset', 'beautify', 'radio'],
    ['albumDate', 'polaroidP1', 'weibo', 'forum', 'stickers', 'anon-chat', 'memory', 'mailbox', 'albumStrip'],
    ['albumMusic', 'music', 'appearance', 'albumNotes', 'mcp'],
    ['calendarWidget', 'polaroidP3', 'au', 'travel-char', 'extensions'],
    ['albumFuture', 'together-reading', ...COMING_SOON_APP_IDS],
  ],
  dock: ['contacts', 'calendar', 'settings', 'my-space'],
  customItems: {},
};

// v12 曾只替换第一页大卡，后四页仍沿用旧混排；精确识别后升级为整套分页。
const ALBUM_HOME_LAYOUT_V12 = {
  version: 9,
  pages: [
    ['albumLeadCard', 'chat', 'character-phone', 'encounter', 'worldbook', 'preset', 'beautify', 'radio'],
    ['albumDate', 'polaroidP1', 'weibo', 'forum', 'stickers', 'anon-chat', 'memory', 'mailbox', 'albumStrip'],
    ['albumMusic', 'music', 'appearance', 'albumNotes', 'mcp'],
    ['calendarWidget', 'polaroidP3', 'au', 'travel-char', 'extensions'],
    ['albumFuture', 'together-reading', ...COMING_SOON_APP_IDS],
  ],
  dock: ['contacts', 'calendar', 'settings', 'my-space'],
  customItems: {},
};

// v13 的短暂错误布局把旧首页组件拆散到了后页；只对完全一致的系统布局纠正。
const ALBUM_HOME_LAYOUT_V13_INTERIM = {
  version: 9,
  pages: [
    ['albumLeadCard'],
    [
      'albumDate',
      'chat', 'character-phone', 'encounter', 'worldbook',
      'preset', 'beautify', 'radio',
      'weibo', 'forum', 'stickers', 'anon-chat',
      'memory', 'mailbox', 'together-reading',
    ],
    ['albumMusic', 'albumNotes', 'music', 'appearance', 'mcp', 'albumStrip'],
    ['calendarWidget', 'polaroidP1', 'polaroidP3', 'au', 'travel-char', 'extensions'],
    ['albumFuture', ...COMING_SOON_APP_IDS],
  ],
  dock: ['contacts', 'calendar', 'settings', 'my-space'],
  customItems: {},
};

// v14 的默认布局把社交入口放在第一页、核心聊天入口放在第二页；
// 只在用户仍完整保留这套系统顺序时迁移，避免覆盖手动排版。
const ALBUM_HOME_LAYOUT_V14 = {
  version: 9,
  pages: [
    [
      'albumLeadCard',
      'weibo', 'forum', 'stickers', 'anon-chat',
      'memory', 'mailbox', 'together-reading',
    ],
    [
      'chat', 'character-phone', 'albumHeroSmall',
      'albumHeroMain', 'encounter', 'worldbook', 'albumHeroNote',
      'preset', 'beautify', 'radio',
    ],
    ['albumMusic', 'albumNotes', 'music', 'appearance', 'mcp', 'albumStrip'],
    ['calendarWidget', 'polaroidP1', 'polaroidP3', 'au', 'travel-char', 'extensions'],
    ['albumFuture', ...COMING_SOON_APP_IDS],
  ],
  dock: ['contacts', 'calendar', 'settings', 'my-space'],
  customItems: {},
};

function createAlbumHomeLayout() {
  return {
    version: 9,
    pages: [
      [
        'albumLeadCard',
        'chat', 'character-phone', 'encounter',
        'memory', 'mailbox', 'appearance', 'radio',
      ],
      [
        'weibo', 'forum', 'albumHeroSmall',
        'albumHeroMain', 'stickers', 'anon-chat', 'albumHeroNote',
        'worldbook', 'preset', 'together-reading',
      ],
      ['albumMusic', 'albumNotes', 'music', 'beautify', 'mcp', 'albumStrip'],
      ['calendarWidget', 'polaroidP1', 'polaroidP3', 'au', 'travel-char', 'extensions'],
      ['albumFuture', ...COMING_SOON_APP_IDS],
    ],
    dock: ['contacts', 'calendar', 'settings', 'my-space'],
    customItems: {},
  };
}

function cloneDefaultWidgets() {
  return {
    ...DEFAULT_WIDGETS,
    noteItems: DEFAULT_WIDGETS.noteItems.slice(),
  };
}

export function createDefaultPrefs() {
  return {
    version: 1,
    colorMode: 'light',
    // Chat 产品壳独立于主屏主题。旧用户默认 current，继续沿用升级前的手账/海/窗实际外观。
    chatPlatform: DEFAULT_CHAT_PLATFORM,
    // 每次主动选择内置聊天外观都递增一代；旧的单聊美化保留在存档中，但不再覆盖内置皮肤。
    chatSessionAppearanceGeneration: 0,
    chatToolOrder: [],
    // 自定义主屏组件是设备级资产，不属于某个主题。
    // 各主题的 homeLayout.pages 只记录该组件在当前主题的摆放位置。
    homeWidgetLibrary: { version: 1, items: {} },
    activeThemeId: ALBUM_THEME_ID,
    themes: {
      [DEFAULT_THEME_ID]: {
        ready: true,
        homeTemplate: HOME_TEMPLATE_SCRAPBOOK,
        wallpaper: DEFAULT_WALLPAPER_PATH,
        wallpaperOpacity: DEFAULT_WALLPAPER_OVERLAY,
        userCard: {
          greeting: '',
          statusText: '今天也要开开心心呀 ✨',
          avatarDataUrl: '',
        },
        appLabels: { ...DEFAULT_APP_LABELS },
        appIcons: {},
        appIconEdgeEnabled: true,
        appIconFrameOpacity: DEFAULT_APP_ICON_FRAME_OPACITY,
        widgets: cloneDefaultWidgets(),
        homePageWallpapers: {},
        homePanorama: null,
        customFont: {
          dataUrl: '',
          fileName: '',
        },
        chatBubbleFontSize: DEFAULT_CHAT_BUBBLE_FONT_SIZE,
        customTheme: {
          css: '',
          cssVars: {},
          chatCss: '',
          pageCss: {},
          pageDarkCss: {},
          homeTextVars: {},
        },
        widgetVisibility: { ...DEFAULT_WIDGET_VISIBILITY },
        homeLayout: createDefaultHomeLayout(),
      },
    [PLACEHOLDER_THEME_ID]: {
      ready: true,
      name: '棉花糖之海',
        presetVersion: SEA_PRESET_VERSION,
        // 主屏模板标记：另存为用户预设后仍按「海」版式渲染，而不是回退手账模板
        homeTemplate: HOME_TEMPLATE_SEA,
        homeStyle: 'sea',
        wallpaper: 'assets/wallpapers/sea-wallpaper-portrait.png',
        wallpaperOpacity: 0.2,
        seaGradientOverlayEnabled: true,
        seaGradientWarmColor: DEFAULT_SEA_GRADIENT_WARM,
        seaGradientCoolColor: DEFAULT_SEA_GRADIENT_COOL,
        seaGradientStrength: DEFAULT_SEA_GRADIENT_STRENGTH,
        seaMusicBgColor: DEFAULT_SEA_MUSIC_BG,
        seaMusicBgOpacity: DEFAULT_SEA_MUSIC_BG_OPACITY,
        seaMusicTextColor: DEFAULT_SEA_MUSIC_TEXT,
        seaMusicAccentColor: DEFAULT_SEA_MUSIC_ACCENT,
        userCard: {
          greeting: '',
          statusText: '听海浪的声音 🌊',
          avatarDataUrl: '',
        },
        appLabels: { ...DEFAULT_APP_LABELS },
        appIcons: {},
        appIconEdgeEnabled: true,
        appIconFrameOpacity: DEFAULT_APP_ICON_FRAME_OPACITY,
        widgets: cloneDefaultWidgets(),
        homePageWallpapers: {},
        homePanorama: null,
        customFont: {
          dataUrl: '',
          fileName: '',
        },
        chatBubbleFontSize: DEFAULT_CHAT_BUBBLE_FONT_SIZE,
        customTheme: {
          css: '',
          chatCss: '',
          cssVars: {},
          pageCss: {},
          pageDarkCss: {},
          homeTextVars: {
            '--sea-ink': '#36586a',
            '--sea-ink-soft': '#6b8fa4',
            '--sea-gold': '#d29a3f',
          },
        },
        widgetVisibility: { ...DEFAULT_WIDGET_VISIBILITY, polaroidP1: false },
        homeLayout: createSeaHomeLayout(),
      },
      [WINDOW_THEME_ID]: {
        ready: true,
        name: '棉花糖之窗',
        presetVersion: WINDOW_PRESET_VERSION,
        homeTemplate: HOME_TEMPLATE_WINDOW,
        homeStyle: 'window',
        wallpaper: WINDOW_WALLPAPER_PATH,
        wallpaperOpacity: 0.14,
        userCard: {
          greeting: '',
          statusText: '窗外有风，室内有光',
          avatarDataUrl: '',
        },
        appLabels: { ...DEFAULT_APP_LABELS },
        appIcons: {},
        appIconEdgeEnabled: true,
        appIconFrameOpacity: DEFAULT_APP_ICON_FRAME_OPACITY,
        windowFrameEnabled: true,
        widgets: cloneDefaultWidgets(),
        homePageWallpapers: {},
        homePanorama: { ...WINDOW_HOME_PANORAMA },
        customFont: {
          dataUrl: '',
          fileName: '',
        },
        chatBubbleFontSize: DEFAULT_CHAT_BUBBLE_FONT_SIZE,
        customTheme: {
          css: WINDOW_THEME_CSS,
          chatCss: '',
          cssVars: {},
          pageCss: {},
          pageDarkCss: {},
          homeTextVars: {
            '--mw-ink': '#58666e',
            '--mw-ink-soft': 'rgba(88, 102, 110, 0.62)',
          },
        },
        widgetVisibility: { ...DEFAULT_WIDGET_VISIBILITY },
        homeLayout: createWindowHomeLayout(),
      },
      [ALBUM_THEME_ID]: {
        ready: true,
        name: '测试优化中',
        presetVersion: ALBUM_PRESET_VERSION,
        homeTemplate: HOME_TEMPLATE_ALBUM,
        homeStyle: 'album',
        wallpaper: ALBUM_WALLPAPER_PATH,
        wallpaperOpacity: 0.12,
        userCard: {
          greeting: '',
          statusText: '把今天轻轻夹进相册',
          avatarDataUrl: '',
        },
        appLabels: { ...DEFAULT_APP_LABELS, chat: '聊天' },
        appIcons: {},
        appIconEdgeEnabled: true,
        appIconFrameOpacity: DEFAULT_APP_ICON_FRAME_OPACITY,
        albumGrayFilterEnabled: false,
        widgets: {
          ...cloneDefaultWidgets(),
          albumLeadTitle: '测试优化中',
          albumLeadSubtitle: '今天也有风',
          albumLeadStatus: 'Now',
          albumLeadBattery: '75%',
          albumLeadTime: '11:58',
          albumLeadWeather: '28°C',
          albumLeadLikes: '26',
          albumLeadComments: '8',
          noteTitle: '今天也有风',
          noteItems: ['记得吃饭。', '晚一点，一起散步。'],
          polaroidCaptionP1: 'soft light · 01',
          polaroidCaptionP3: 'our little archive',
        },
        homePageWallpapers: {},
        homePanorama: null,
        customFont: {
          dataUrl: '',
          fileName: '',
        },
        chatBubbleFontSize: DEFAULT_CHAT_BUBBLE_FONT_SIZE,
        customTheme: {
          css: '',
          chatCss: '',
          cssVars: {},
          pageCss: {},
          pageDarkCss: {},
          homeTextVars: {
            '--album-ink': '#343735',
            '--album-muted': '#7b817d',
            '--album-accent': '#8b968c',
          },
        },
        widgetVisibility: { ...DEFAULT_WIDGET_VISIBILITY, userHeader: false, noteMemo: false, filmWidget: false },
        homeLayout: createAlbumHomeLayout(),
      },
    },
  };
}

export function resolveHomeTemplateKey(theme) {
  const src = theme && typeof theme === 'object' ? theme : {};
  if (src.homeTemplate === HOME_TEMPLATE_SEA || src.homeStyle === 'sea') return HOME_TEMPLATE_SEA;
  if (src.homeTemplate === HOME_TEMPLATE_WINDOW || src.homeStyle === 'window') return HOME_TEMPLATE_WINDOW;
  if (src.homeTemplate === HOME_TEMPLATE_ALBUM || src.homeStyle === 'album') return HOME_TEMPLATE_ALBUM;
  return HOME_TEMPLATE_SCRAPBOOK;
}

/**
 * 当前主题执行“恢复默认”时应使用的内置基线。
 * 内置主题按自身 id 复位；用户另存/导入的主题没有独立出厂值，按它当前所属的
 * 主屏模板回到对应内置主题，避免海、窗、相册误混入手账组件与布局。
 */
export function getThemeResetDefaults(themeId, theme) {
  const defaults = createDefaultPrefs().themes;
  const id = String(themeId || '').trim();
  if (defaults[id]) return cloneJson(defaults[id]);
  const template = resolveHomeTemplateKey(theme);
  const builtinId = template === HOME_TEMPLATE_SEA
    ? PLACEHOLDER_THEME_ID
    : template === HOME_TEMPLATE_WINDOW
      ? WINDOW_THEME_ID
      : template === HOME_TEMPLATE_ALBUM
        ? ALBUM_THEME_ID
        : DEFAULT_THEME_ID;
  return cloneJson(defaults[builtinId]);
}

export function getHomeShellSelector(theme) {
  const key = resolveHomeTemplateKey(theme);
  if (key === HOME_TEMPLATE_SEA) return '.home-sea-shell';
  if (key === HOME_TEMPLATE_WINDOW) return '.home-window-shell';
  if (key === HOME_TEMPLATE_ALBUM) return '.home-album-shell';
  return '.home-shell-page';
}

function migrateLegacyCssVarsToHomeTextVars(theme) {
  const custom = (theme && theme.customTheme) || {};
  const homeTextVars = { ...(custom.homeTextVars && typeof custom.homeTextVars === 'object' ? custom.homeTextVars : {}) };
  const legacy = custom.cssVars && typeof custom.cssVars === 'object' ? custom.cssVars : {};
  const template = resolveHomeTemplateKey(theme);
  const defs = HOME_THEME_TEXT_VARS_BY_TEMPLATE[template] || HOME_THEME_TEXT_VARS_BY_TEMPLATE.scrapbook;
  for (const item of defs) {
    if (!homeTextVars[item.key] && legacy[item.key]) {
      homeTextVars[item.key] = legacy[item.key];
    }
  }
  if (template === HOME_TEMPLATE_SEA) {
    if (!homeTextVars['--sea-ink'] && legacy['--ink-blue']) homeTextVars['--sea-ink'] = legacy['--ink-blue'];
    if (!homeTextVars['--sea-ink-soft'] && legacy['--text-secondary']) homeTextVars['--sea-ink-soft'] = legacy['--text-secondary'];
    if (!homeTextVars['--sea-gold'] && legacy['--accent-orange']) homeTextVars['--sea-gold'] = legacy['--accent-orange'];
  }
  if (template === HOME_TEMPLATE_WINDOW) {
    if (!homeTextVars['--mw-ink'] && legacy['--ink-brown']) homeTextVars['--mw-ink'] = legacy['--ink-brown'];
    if (!homeTextVars['--mw-ink-soft'] && legacy['--text-secondary']) homeTextVars['--mw-ink-soft'] = legacy['--text-secondary'];
  }
  if (template === HOME_TEMPLATE_ALBUM) {
    if (!homeTextVars['--album-ink'] && legacy['--ink-brown']) homeTextVars['--album-ink'] = legacy['--ink-brown'];
    if (!homeTextVars['--album-muted'] && legacy['--ink-blue']) homeTextVars['--album-muted'] = legacy['--ink-blue'];
    if (!homeTextVars['--album-accent'] && legacy['--tape-orange']) homeTextVars['--album-accent'] = legacy['--tape-orange'];
  }
  return homeTextVars;
}

export function mergeTheme(base, patch) {
  const next = { ...base, ...(patch || {}) };
  next.userCard = { ...(base.userCard || {}), ...((patch && patch.userCard) || {}) };
  next.appLabels = { ...(base.appLabels || {}), ...((patch && patch.appLabels) || {}) };
  if (next.appLabels['watch-together'] === '一起看') next.appLabels['watch-together'] = '一起';
  next.appIcons = { ...(base.appIcons || {}), ...((patch && patch.appIcons) || {}) };
  next.homePageWallpapers = { ...(base.homePageWallpapers || {}), ...((patch && patch.homePageWallpapers) || {}) };
  if (patch && 'homePanorama' in patch) {
    next.homePanorama = patch.homePanorama ? { ...patch.homePanorama } : null;
  } else {
    next.homePanorama = base.homePanorama ? { ...base.homePanorama } : null;
  }
  const widgets = { ...(base.widgets || {}), ...((patch && patch.widgets) || {}) };
  if (Array.isArray(widgets.noteItems)) {
    widgets.noteItems = widgets.noteItems.slice();
  } else if (Array.isArray(base.widgets && base.widgets.noteItems)) {
    widgets.noteItems = base.widgets.noteItems.slice();
  }
  next.widgets = widgets;
  next.customFont = { ...(base.customFont || {}), ...((patch && patch.customFont) || {}) };
  const chatSize = Number(patch && patch.chatBubbleFontSize != null ? patch.chatBubbleFontSize : base.chatBubbleFontSize);
  next.chatBubbleFontSize = clampChatBubbleFontSize(chatSize);
  const patchCustom = (patch && patch.customTheme) || {};
  const mergedCustom = { ...(base.customTheme || {}), ...patchCustom };
  let homeTextVars;
  if (Object.prototype.hasOwnProperty.call(patchCustom, 'homeTextVars')) {
    homeTextVars = { ...(patchCustom.homeTextVars || {}) };
  } else {
    homeTextVars = migrateLegacyCssVarsToHomeTextVars({ ...next, customTheme: mergedCustom });
  }
  next.customTheme = {
    css: '',
    chatCss: '',
    cssVars: {},
    pageCss: {},
    pageDarkCss: {},
    homeTextVars: {},
    ...mergedCustom,
    // 按页发布的 CSS 深合并：patch 只带部分页时不丢基底其它页
    pageCss: {
      ...((base.customTheme && base.customTheme.pageCss) || {}),
      ...(patchCustom.pageCss || {}),
    },
    // 夜间覆盖与常规 CSS 分槽保存，切换显示模式不会改写用户原稿。
    pageDarkCss: {
      ...((base.customTheme && base.customTheme.pageDarkCss) || {}),
      ...(patchCustom.pageDarkCss || {}),
    },
    homeTextVars,
  };
  next.widgetVisibility = {
    ...DEFAULT_WIDGET_VISIBILITY,
    ...(base.widgetVisibility || {}),
    ...((patch && patch.widgetVisibility) || {}),
  };
  next.homeLayout = normalizeHomeLayout(
    (patch && patch.homeLayout) || base.homeLayout,
    next.widgetVisibility,
  );
  // 主屏模板标记（兼容旧 homeStyle）：让「海」版式在另存预设/导入后仍生效。
  const rawTemplate = (patch && patch.homeTemplate != null) ? patch.homeTemplate : base.homeTemplate;
  const rawStyle = (patch && patch.homeStyle != null) ? patch.homeStyle : base.homeStyle;
  const homeTemplate = rawTemplate === HOME_TEMPLATE_SEA || rawStyle === 'sea'
    ? HOME_TEMPLATE_SEA
    : rawTemplate === HOME_TEMPLATE_WINDOW || rawStyle === 'window'
      ? HOME_TEMPLATE_WINDOW
    : rawTemplate === HOME_TEMPLATE_ALBUM || rawStyle === 'album'
      ? HOME_TEMPLATE_ALBUM
    : HOME_TEMPLATE_SCRAPBOOK;
  next.homeTemplate = homeTemplate;
  if (homeTemplate === HOME_TEMPLATE_SEA) next.homeStyle = 'sea';
  else if (homeTemplate === HOME_TEMPLATE_WINDOW) next.homeStyle = 'window';
  else if (homeTemplate === HOME_TEMPLATE_ALBUM) next.homeStyle = 'album';
  else delete next.homeStyle;
  return next;
}

/** 主屏是否走「棉花糖之海」专属模板（内置海主题，或由其另存/导入的用户预设） */
export function isSeaHomeTheme(themeId, theme) {
  if (themeId === PLACEHOLDER_THEME_ID) return true;
  return !!(theme && (theme.homeTemplate === HOME_TEMPLATE_SEA || theme.homeStyle === 'sea'));
}

export function isWindowHomeTheme(themeId, theme) {
  if (themeId === WINDOW_THEME_ID) return true;
  return !!(theme && (theme.homeTemplate === HOME_TEMPLATE_WINDOW || theme.homeStyle === 'window'));
}

export function isAlbumHomeTheme(themeId, theme) {
  if (themeId === ALBUM_THEME_ID) return true;
  return !!(theme && (theme.homeTemplate === HOME_TEMPLATE_ALBUM || theme.homeStyle === 'album'));
}

export function getHomeWidgetDefsForTheme(themeId, theme) {
  if (isSeaHomeTheme(themeId, theme)) return SEA_HOME_WIDGET_DEFS;
  if (isWindowHomeTheme(themeId, theme)) return WINDOW_HOME_WIDGET_DEFS;
  if (isAlbumHomeTheme(themeId, theme)) return ALBUM_HOME_WIDGET_DEFS;
  return SCRAPBOOK_HOME_WIDGET_DEFS;
}

function formatWidgetPagePlacement(page) {
  const idx = Number(page);
  if (!Number.isFinite(idx) || idx < 0) return '';
  const names = ['一', '二', '三', '四', '五', '六'];
  return `第${names[idx] || String(idx + 1)}页`;
}

export function getHomeWidgetSlotsForTheme(themeId, theme) {
  return Object.values(getHomeWidgetDefsForTheme(themeId, theme)).map((item) => ({
    id: item.id,
    label: item.label,
    placement: String(item.placement || '').trim() || formatWidgetPagePlacement(item.page),
    hook: item.hook || '',
    page: item.page || 0,
  }));
}

export function isHomeEmptySlotId(id) {
  return String(id || '').startsWith(HOME_EMPTY_SLOT_PREFIX);
}

export function createHomeEmptySlotId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${HOME_EMPTY_SLOT_PREFIX}${Date.now().toString(36)}-${rand}`;
}

function normalizeLayoutSize(size) {
  const cols = Math.max(1, Math.min(HOME_LAYOUT_COLS, Math.round(Number(size && size.cols) || 1)));
  const rows = Math.max(1, Math.min(HOME_LAYOUT_ROWS, Math.round(Number(size && size.rows) || 1)));
  return { cols, rows };
}

function normalizeCustomHomeItem(item, id) {
  if (!item || typeof item !== 'object') return null;
  const itemId = String(item.id || id || '').trim();
  if (!itemId) return null;
  const kind = String(item.kind || 'custom-widget').trim();
  const html = String(item.html || '');
  const imageSlots = {};
  const quickColorsSource = item.quickColors && typeof item.quickColors === 'object' ? item.quickColors : {};
  const color = (value, fallback) => (/^#[0-9a-f]{6}$/i.test(String(value || '').trim()) ? String(value).trim() : fallback);
  const surface = ['solid', 'transparent', 'light-glass', 'glass'].includes(quickColorsSource.surface)
    ? quickColorsSource.surface
    : 'solid';
  if (item.imageSlots && typeof item.imageSlots === 'object') {
    Object.entries(item.imageSlots).slice(0, 12).forEach(([key, value]) => {
      const slotKey = String(key || '').trim().slice(0, 40);
      const url = String(value || '').trim();
      if (slotKey && url) imageSlots[slotKey] = url;
    });
  }
  return {
    id: itemId,
    kind,
    label: String(item.label || item.title || '自定义组件').trim() || '自定义组件',
    title: String(item.title || item.label || '').trim(),
    body: String(item.body || '').trim(),
    html,
    quickColors: {
      enabled: quickColorsSource.enabled === true,
      background: color(quickColorsSource.background, '#ffffff'),
      text: color(quickColorsSource.text, '#36586a'),
      accent: color(quickColorsSource.accent, '#d29a3f'),
      surface,
      opacity: Math.max(0, Math.min(100, Math.round(Number(quickColorsSource.opacity ?? 100) || 0))),
    },
    ...(item.storedInLibrary === true ? { storedInLibrary: true } : {}),
    hiddenFromHome: item.hiddenFromHome === true,
    imageSlots,
    imageDataUrl: String(item.imageDataUrl || item.image || '').trim(),
    route: String(item.route || '').trim(),
    iconDataUrl: String(item.iconDataUrl || '').trim(),
    size: normalizeLayoutSize(item.size || { cols: 2, rows: 1 }),
  };
}

function normalizeHomeWidgetLibraryItems(source) {
  const raw = source && typeof source === 'object'
    ? (source.items && typeof source.items === 'object' ? source.items : source)
    : {};
  const items = {};
  Object.entries(raw).forEach(([id, item]) => {
    const normalized = normalizeCustomHomeItem(item, id);
    if (!normalized) return;
    // 是否放在主屏由每个主题的 pages 决定，不污染通用组件本体。
    delete normalized.hiddenFromHome;
    delete normalized.storedInLibrary;
    items[normalized.id] = normalized;
  });
  return items;
}

export function getHomeWidgetLibraryItems(prefs) {
  return normalizeHomeWidgetLibraryItems(prefs?.homeWidgetLibrary || {});
}

export function upsertHomeWidgetLibraryItem(prefs, item) {
  const normalized = normalizeCustomHomeItem(item, item?.id);
  if (!normalized) return prefs;
  delete normalized.hiddenFromHome;
  delete normalized.storedInLibrary;
  const items = getHomeWidgetLibraryItems(prefs);
  return {
    ...prefs,
    homeWidgetLibrary: {
      version: 1,
      items: { ...items, [normalized.id]: normalized },
    },
  };
}

export function mergeHomeWidgetLibraryItems(prefs, source) {
  const incoming = normalizeHomeWidgetLibraryItems(source);
  if (!Object.keys(incoming).length) return prefs;
  return {
    ...prefs,
    homeWidgetLibrary: {
      version: 1,
      items: { ...getHomeWidgetLibraryItems(prefs), ...incoming },
    },
  };
}

export function removeHomeWidgetLibraryItem(prefs, widgetId) {
  const id = String(widgetId || '').trim();
  if (!id) return prefs;
  const items = getHomeWidgetLibraryItems(prefs);
  delete items[id];
  const themes = {};
  Object.entries(prefs?.themes || {}).forEach(([themeId, theme]) => {
    const layout = theme?.homeLayout && typeof theme.homeLayout === 'object' ? theme.homeLayout : {};
    const customItems = { ...(layout.customItems || {}) };
    delete customItems[id];
    themes[themeId] = {
      ...theme,
      homeLayout: {
        ...layout,
        pages: (Array.isArray(layout.pages) ? layout.pages : []).map((page) => (
          Array.isArray(page) ? page.filter((entry) => entry !== id) : []
        )),
        dock: (Array.isArray(layout.dock) ? layout.dock : []).filter((entry) => entry !== id),
        customItems,
      },
    };
  });
  return {
    ...prefs,
    homeWidgetLibrary: { version: 1, items },
    themes,
  };
}

function collectLegacyHomeWidgetItems(savedThemes, activeThemeId) {
  const items = {};
  const entries = Object.entries(savedThemes || {});
  entries.sort(([left]) => (left === activeThemeId ? -1 : 0));
  entries.forEach(([, theme]) => {
    const source = theme?.homeLayout?.customItems;
    Object.entries(source && typeof source === 'object' ? source : {}).forEach(([id, item]) => {
      if (items[id]) return;
      const normalized = normalizeCustomHomeItem(item, id);
      if (!normalized) return;
      delete normalized.hiddenFromHome;
      delete normalized.storedInLibrary;
      items[normalized.id] = normalized;
    });
  });
  return items;
}

function attachHomeWidgetLibrary(layout, widgetVisibility, libraryItems, placementSource) {
  const source = layout && typeof layout === 'object' ? layout : {};
  const placement = placementSource && typeof placementSource === 'object' ? placementSource : source;
  const placed = new Set((Array.isArray(placement.pages) ? placement.pages : []).flat().map((id) => String(id || '')));
  const scopedItems = {};
  Object.entries(libraryItems || {}).forEach(([id, item]) => {
    scopedItems[id] = { ...item, storedInLibrary: true, hiddenFromHome: !placed.has(id) };
  });
  return normalizeHomeLayout({
    ...source,
    ...(Array.isArray(placement.pages) ? { pages: placement.pages } : {}),
    ...(Array.isArray(placement.dock) ? { dock: placement.dock } : {}),
    customItems: scopedItems,
  }, widgetVisibility);
}

function mergeStoredWidgetPlacements(layout, storedLayout, libraryItems) {
  const source = layout && typeof layout === 'object' ? layout : {};
  const storedPages = Array.isArray(storedLayout?.pages) ? storedLayout.pages : [];
  const widgetIds = new Set(Object.keys(libraryItems || {}));
  const pages = (Array.isArray(source.pages) ? source.pages : [])
    .map((page) => (Array.isArray(page) ? page.filter((id) => !widgetIds.has(id)) : []));
  storedPages.forEach((storedPage, pageIndex) => {
    const widgets = (Array.isArray(storedPage) ? storedPage : [])
      .map((id, index) => ({ id, index }))
      .filter(({ id }) => widgetIds.has(id));
    if (!widgets.length) return;
    while (pages.length <= pageIndex && pages.length < MAX_HOME_PAGES) pages.push([]);
    if (!pages[pageIndex]) return;
    widgets.forEach(({ id, index }) => {
      const targetIndex = Math.max(0, Math.min(pages[pageIndex].length, index));
      pages[pageIndex].splice(targetIndex, 0, id);
    });
  });
  return { ...source, pages };
}

/** 落库时只保留全局组件库与各主题的摆放 ID，避免大图/HTML 在每个主题里重复一份。 */
export function compactAppearancePrefsForStorage(prefs) {
  const themes = {};
  Object.entries(prefs?.themes || {}).forEach(([id, theme]) => {
    const layout = theme?.homeLayout && typeof theme.homeLayout === 'object' ? theme.homeLayout : {};
    themes[id] = {
      ...theme,
      homeLayout: {
        version: Math.max(0, Math.round(Number(layout.version) || 0)),
        pages: (Array.isArray(layout.pages) ? layout.pages : []).map((page) => (
          Array.isArray(page) ? page.slice() : []
        )),
        dock: (Array.isArray(layout.dock) ? layout.dock : []).slice(),
      },
    };
  });
  return {
    ...prefs,
    homeWidgetLibrary: { version: 1, items: getHomeWidgetLibraryItems(prefs) },
    themes,
  };
}

function uniqueStrings(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((item) => String(item || '').trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

export function normalizeHomeLayout(layout, widgetVisibility = DEFAULT_WIDGET_VISIBILITY) {
  const defaults = createDefaultHomeLayout();
  const raw = layout && typeof layout === 'object' ? layout : defaults;
  const sourceVersion = Math.max(0, Math.round(Number(raw.version) || 0));
  const rawCustom = raw.customItems && typeof raw.customItems === 'object' ? raw.customItems : {};
  const customItems = {};
  Object.entries(rawCustom).forEach(([id, item]) => {
    const normalized = normalizeCustomHomeItem(item, id);
    if (normalized) customItems[normalized.id] = normalized;
  });

  const allowed = new Set([
    ...Object.keys(DEFAULT_APP_LABELS),
    ...Object.keys(BUILTIN_HOME_WIDGET_DEFS),
    ...Object.keys(customItems),
  ]);
  const appIds = Object.keys(DEFAULT_APP_LABELS);
  const isAppId = (id) => Object.prototype.hasOwnProperty.call(DEFAULT_APP_LABELS, id);
  const pagesSource = Array.isArray(raw.pages) ? raw.pages : defaults.pages;
  const hadInjectedSupport = pagesSource.some((page) => Array.isArray(page) && page.includes('support'));
  let pages = pagesSource.map((page) => uniqueStrings(
    (Array.isArray(page) ? page : []).map((id) => (
      String(id || '').trim() === 'watch-together' ? 'together-reading' : id
    )),
  ).filter((id) => allowed.has(id) || isHomeEmptySlotId(id)));
  if (!pages.length) pages = defaults.pages.map((page) => page.slice());
  const dock = uniqueStrings(raw.dock || defaults.dock)
    .filter((id) => allowed.has(id) && isAppId(id))
    .slice(0, 4);
  defaults.dock.forEach((id) => {
    if (dock.length < 4 && !dock.includes(id)) dock.push(id);
  });
  appIds.forEach((id) => {
    if (dock.length < 4 && !dock.includes(id)) dock.push(id);
  });
  // 主屏中的 App、内置组件和自定义组件都只能出现一次。旧逻辑只跨页去重 App，
  // 拖拽被系统中断时写入的重复组件会永久显示两份；读取时统一自愈。
  const placedItems = new Set(dock);
  pages = pages.map((page) => page.filter((id) => {
    if (placedItems.has(id)) return false;
    placedItems.add(id);
    return true;
  }));
  // BUILD 984 曾把答疑入口强插进首页；读取时移除后，还原当时为窗主题让位而挪走的「相遇」。
  if (hadInjectedSupport && pages[1]?.includes('polaroidP3') && !pages[0]?.includes('encounter')) {
    const encounterPage = pages.findIndex((page) => page.includes('encounter'));
    if (encounterPage > 0) {
      pages[encounterPage] = pages[encounterPage].filter((id) => id !== 'encounter');
      pages[0].push('encounter');
    }
  }
  // 一次性迁移：旧布局没有 'companion'（陪伴 App）时，把它插到第二页第一位，
  // 同时把 'au' 从第二页挪到第三页起始（与 home-layout.js 的新默认一致）。
  const allFlat = pages.flat();
  if (allowed.has('companion') && !allFlat.includes('companion') && pages.length >= 2) {
    const auIdx = pages.findIndex((p) => p.includes('au'));
    if (auIdx === 1) {
      pages[1] = pages[1].filter((id) => id !== 'au');
      while (pages.length < 3) pages.push([]);
      if (!pages[2].includes('au')) pages[2].unshift('au');
    }
    pages[1].unshift('companion');
  }
  // 电台作为聊天关系的延伸放在第二页；旧主题读取时自动补入，不要求用户重置主屏。
  const withCompanionFlat = pages.flat();
  if (allowed.has('radio') && !withCompanionFlat.includes('radio') && pages.length >= 2) {
    const companionIndex = pages[1].indexOf('companion');
    pages[1].splice(companionIndex >= 0 ? companionIndex + 1 : 0, 0, 'radio');
  }

  // v5：待开发入口统一收进第 5 页；系统生成的第四页补成主题组件 + 旅行角色 + 三个美化工具。
  // 若用户已在第四页放入其它内容，则只补新入口，不改动其自定义分组。
  if (sourceVersion < 5) {
    pages = pages.map((page) => page.filter((id) => !COMING_SOON_APP_IDS.includes(id)));
    while (pages.length < 5) pages.push([]);
    const toolIds = ['extensions', 'appearance', 'beautify'];
    const fourthDecorIds = ['scrapbookFourthDecor', 'seaFourthDecor', 'windowFourthDecor'];
    const generatedFourthPage = pages[3]
      .filter((id) => !isHomeEmptySlotId(id) && !fourthDecorIds.includes(id))
      .every((id) => toolIds.includes(id));
    if (generatedFourthPage) {
      const fourthPageIds = ['travel-char', ...toolIds];
      pages = pages.map((page) => page.filter((item) => !fourthPageIds.includes(item)));
      pages[3].push(...fourthPageIds);
    }
    COMING_SOON_APP_IDS.forEach((id) => {
      if (allowed.has(id)) pages[4].push(id);
    });
  }

  // v6：应用商店已正式上线，从“未来开发”页移到第四页；若用户已经主动挪到
  // 其它正式分页则尊重其布局，只迁移仍与待开发入口混排的旧默认位置。
  if (sourceVersion < 6 && allowed.has('app-store')) {
    const appStorePage = pages.findIndex((page) => page.includes('app-store'));
    const sharesFuturePage = appStorePage >= 0
      && pages[appStorePage].some((id) => COMING_SOON_APP_IDS.includes(id));
    if (appStorePage < 0 || sharesFuturePage) {
      pages = pages.map((page) => page.filter((id) => id !== 'app-store'));
      while (pages.length < 4) pages.push([]);
      pages[3].push('app-store');
    }
  }

  // v7：MCP 已开放，从未来开发页移到正式工具页；用户已主动摆放的位置保持不动。
  if (sourceVersion < 7 && allowed.has('mcp')) {
    const mcpPage = pages.findIndex((page) => page.includes('mcp'));
    const sharesFuturePage = mcpPage >= 0
      && pages[mcpPage].some((id) => COMING_SOON_APP_IDS.includes(id));
    if (mcpPage < 0 || sharesFuturePage) {
      pages = pages.map((page) => page.filter((id) => id !== 'mcp'));
      while (pages.length < 4) pages.push([]);
      pages[3].push('mcp');
    }
  }

  // v8：邮箱成为正式独立 App。旧布局放到记忆/音乐所在页，不打乱用户已有排序。
  if (sourceVersion < 8 && allowed.has('mailbox') && !pages.some((page) => page.includes('mailbox'))) {
    const preferredPage = pages.findIndex((page) => page.includes('memory') || page.includes('music'));
    const targetPage = preferredPage >= 0 ? preferredPage : Math.min(2, pages.length - 1);
    const phoneIndex = pages[targetPage].indexOf('character-phone');
    pages[targetPage].splice(phoneIndex >= 0 ? phoneIndex : pages[targetPage].length, 0, 'mailbox');
  }

  const used = new Set([...dock, ...pages.flat()]);

  appIds.forEach((id) => {
    if (!used.has(id) && allowed.has(id)) {
      pages[pages.length - 1].push(id);
      used.add(id);
    }
  });
  defaults.pages.flat().forEach((id) => {
    // 纸样收藏票只属于手账；海/窗/相册会在各自主题归一化时放入对应组件。
    if (id === 'scrapbookFourthDecor' && !pages.some((page) => page.includes(id))) return;
    if (!isAppId(id) && !used.has(id) && allowed.has(id)) {
      pages[pages.length - 1].push(id);
      used.add(id);
    }
  });

  Object.keys(customItems).forEach((id) => {
    if (!used.has(id)
      && customItems[id].hiddenFromHome !== true
      && customItems[id].storedInLibrary !== true) {
      pages[pages.length - 1].push(id);
      used.add(id);
    }
  });

  const vis = migrateLegacySeaMusicVisibility({ ...DEFAULT_WIDGET_VISIBILITY, ...(widgetVisibility || {}) });
  pages = pages.map((page) => page.filter((id) => {
    if (BUILTIN_HOME_WIDGET_DEFS[id] && vis[id] === false) return false;
    if (customItems[id]?.hiddenFromHome === true) return false;
    return !dock.includes(id);
  }));
  pages = pages.map((page) => {
    const next = page.slice();
    while (next.length && isHomeEmptySlotId(next[next.length - 1])) next.pop();
    return next;
  });

  // 分页超过上限时折叠进末页；尾部空页自动回收；至少保留 1 页。
  while (pages.length > MAX_HOME_PAGES) {
    const overflow = pages.pop();
    pages[pages.length - 1].push(...overflow);
  }
  while (pages.length > MIN_HOME_PAGES && !pages[pages.length - 1].some((id) => !isHomeEmptySlotId(id))) {
    pages.pop();
  }
  while (pages.length < MIN_HOME_PAGES) pages.push([]);

  return {
    version: 9,
    pages,
    dock: dock.length ? dock.slice(0, 4) : defaults.dock.slice(),
    customItems,
  };
}

/** 删除一页并把其中内容并入相邻页，避免 App / 组件随分页一起丢失。 */
export function removeHomeLayoutPage(layout, pageIndex) {
  const source = layout && typeof layout === 'object' ? layout : {};
  const pages = Array.isArray(source.pages)
    ? source.pages.map((page) => (Array.isArray(page) ? page.slice() : []))
    : [];
  if (pages.length <= MIN_HOME_PAGES) return { ...source, pages };
  const index = Math.max(0, Math.min(pages.length - 1, Math.round(Number(pageIndex) || 0)));
  const [removed] = pages.splice(index, 1);
  const target = Math.min(index, pages.length - 1);
  if (index >= pages.length) pages[target].push(...removed);
  else pages[target].unshift(...removed);
  return { ...source, pages };
}

/** 删除分页时同步左移按 1 开始编号的分页壁纸。 */
export function removeHomePageWallpaper(homePageWallpapers, pageIndex) {
  const source = homePageWallpapers && typeof homePageWallpapers === 'object'
    ? homePageWallpapers
    : {};
  const deletedPage = Math.max(1, Math.round(Number(pageIndex) || 0) + 1);
  const next = {};
  Object.entries(source).forEach(([key, value]) => {
    const page = Number(key);
    if (!Number.isInteger(page) || page < 1) {
      next[key] = value;
      return;
    }
    if (page === deletedPage) return;
    next[String(page > deletedPage ? page - 1 : page)] = value;
  });
  return next;
}

export function clampChatBubbleFontSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CHAT_BUBBLE_FONT_SIZE;
  return Math.max(MIN_CHAT_BUBBLE_FONT_SIZE, Math.min(MAX_CHAT_BUBBLE_FONT_SIZE, Math.round(n)));
}

export function getChatBubbleFontSize(theme) {
  return clampChatBubbleFontSize(theme && theme.chatBubbleFontSize);
}

export function resolveWallpaperUrl(theme) {
  const raw = theme && theme.wallpaper != null ? String(theme.wallpaper).trim() : '';
  if (raw === WALLPAPER_NONE) return '';
  if (raw) {
    // APK https 壳下 http 壁纸会被拦；相对路径 / data: 原样。
    if (/^http:\/\//i.test(raw)) return `https://${raw.slice(7)}`;
    if (raw.startsWith('//')) return `https:${raw}`;
    return raw;
  }
  return DEFAULT_WALLPAPER_PATH;
}

/**
 * “整屏壁纸”是主屏当前可见背景的替换操作。
 * 分页壁纸与横向全景的渲染层级都高于 theme.wallpaper；若只改底层字段，
 * 数据虽然保存成功，画面仍会继续显示旧覆盖图，让用户误以为保存失效。
 */
export function replaceThemeHomeWallpaper(theme, wallpaper) {
  return {
    ...(theme || {}),
    wallpaper: String(wallpaper == null ? '' : wallpaper),
    homePageWallpapers: {},
    homePanorama: null,
  };
}

/** 内置主题各自的默认壁纸包（全局 + 分页 + 透明度），供设置页「恢复默认」使用 */
export function getThemeBuiltinWallpaperDefaults(themeId) {
  const prefs = createDefaultPrefs();
  const theme = prefs.themes[themeId] || prefs.themes[DEFAULT_THEME_ID];
  return {
    wallpaper: theme.wallpaper || DEFAULT_WALLPAPER_PATH,
    wallpaperOpacity: theme.wallpaperOpacity != null ? theme.wallpaperOpacity : DEFAULT_WALLPAPER_OVERLAY,
    homePageWallpapers: { ...(theme.homePageWallpapers || {}) },
    homePanorama: theme.homePanorama ? { ...theme.homePanorama } : null,
  };
}

export function resolveHomePageWallpaperUrl(theme, pageNumber) {
  const key = String(Math.max(1, Math.round(Number(pageNumber) || 1)));
  const map = theme && theme.homePageWallpapers && typeof theme.homePageWallpapers === 'object'
    ? theme.homePageWallpapers
    : {};
  const raw = map[key] != null ? String(map[key]).trim() : '';
  if (raw === WALLPAPER_NONE) return '';
  if (raw) {
    if (/^http:\/\//i.test(raw)) return `https://${raw.slice(7)}`;
    if (raw.startsWith('//')) return `https:${raw}`;
    return raw;
  }
  return resolveWallpaperUrl(theme);
}

/**
 * 分页壁纸层的实际来源。全景只负责自己声明的页数；后来新增的分页必须回退到
 * 当前主题已经实装的整屏壁纸，不能继续保持透明而滑出全景素材范围。
 */
export function resolveHomePageWallpaperLayer(theme, pageNumber, panoramaPages = 0) {
  const page = Math.max(1, Math.round(Number(pageNumber) || 1));
  const map = theme && theme.homePageWallpapers && typeof theme.homePageWallpapers === 'object'
    ? theme.homePageWallpapers
    : {};
  const raw = map[String(page)] != null ? String(map[String(page)]).trim() : '';
  if (raw === WALLPAPER_NONE) return { mode: 'solid', url: '' };
  if (raw) return { mode: 'image', url: resolveHomePageWallpaperUrl(theme, page) };
  const panoCount = Math.max(0, Math.round(Number(panoramaPages) || 0));
  if (panoCount > 0 && page <= panoCount) return { mode: 'panorama', url: '' };
  const url = resolveWallpaperUrl(theme);
  return url ? { mode: 'image', url } : { mode: 'solid', url: '' };
}

export function getWallpaperOverlayAlpha(theme) {
  const opacity = Number(theme && theme.wallpaperOpacity);
  return Number.isFinite(opacity) ? opacity : DEFAULT_WALLPAPER_OVERLAY;
}

function parseSeaGradientHex(hex, fallback) {
  const raw = String(hex || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
}

function seaGradientRgb(hex) {
  const clean = parseSeaGradientHex(hex, '#000000').slice(1);
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

export function rgbaFromHexColor(hex, alpha = 1) {
  const { r, g, b } = seaGradientRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function resolveSeaGradientOverlay(theme) {
  const enabled = theme?.seaGradientOverlayEnabled !== false;
  const warm = parseSeaGradientHex(theme?.seaGradientWarmColor, DEFAULT_SEA_GRADIENT_WARM);
  const cool = parseSeaGradientHex(theme?.seaGradientCoolColor, DEFAULT_SEA_GRADIENT_COOL);
  let strength = Number(theme?.seaGradientStrength);
  if (!Number.isFinite(strength)) {
    const seaOpacity = Number(theme?.wallpaperOpacity);
    strength = Number.isFinite(seaOpacity) ? Math.max(0, seaOpacity / 0.2) : DEFAULT_SEA_GRADIENT_STRENGTH;
  }
  return {
    enabled,
    warm,
    cool,
    strength: Math.max(0, Math.min(1.5, strength)),
  };
}

export function applySeaGradientOverlayToElement(el, theme) {
  if (!el) return;
  const { enabled, warm, cool, strength } = resolveSeaGradientOverlay(theme);
  el.style.setProperty('--sea-overlay-strength', enabled ? String(strength) : '0');
  el.style.setProperty('--sea-overlay-warm-strong', rgbaFromHexColor(warm, 0.24));
  el.style.setProperty('--sea-overlay-warm-soft', rgbaFromHexColor(warm, 0.20));
  el.style.setProperty('--sea-overlay-cool-strong', rgbaFromHexColor(cool, 0.22));
  el.style.setProperty('--sea-overlay-cool-mid', rgbaFromHexColor(cool, 0.14));
}

export function getSeaGradientOverlayDefaults() {
  return {
    seaGradientOverlayEnabled: true,
    seaGradientWarmColor: DEFAULT_SEA_GRADIENT_WARM,
    seaGradientCoolColor: DEFAULT_SEA_GRADIENT_COOL,
    seaGradientStrength: DEFAULT_SEA_GRADIENT_STRENGTH,
  };
}

export function resolveSeaMusicColors(theme) {
  const bg = parseSeaGradientHex(theme?.seaMusicBgColor, DEFAULT_SEA_MUSIC_BG);
  const text = parseSeaGradientHex(theme?.seaMusicTextColor, DEFAULT_SEA_MUSIC_TEXT);
  const accent = parseSeaGradientHex(theme?.seaMusicAccentColor, DEFAULT_SEA_MUSIC_ACCENT);
  const rawOpacity = Number(theme?.seaMusicBgOpacity);
  const opacity = Number.isFinite(rawOpacity)
    ? Math.max(0, Math.min(1, rawOpacity))
    : DEFAULT_SEA_MUSIC_BG_OPACITY;
  return { bg, text, accent, opacity };
}

export function applySeaMusicColorsToElement(el, theme) {
  if (!el) return;
  const { bg, text, accent, opacity } = resolveSeaMusicColors(theme);
  el.style.setProperty('--sea-music-bg', rgbaFromHexColor(bg, opacity));
  el.style.setProperty('--sea-music-text', text);
  el.style.setProperty('--sea-music-text-soft', rgbaFromHexColor(text, 0.7));
  el.style.setProperty('--sea-music-accent', accent);
  el.style.setProperty('--sea-music-accent-soft', rgbaFromHexColor(accent, 0.55));
}

export function applyThemeWallpaperToElement(el, theme) {
  if (!el) return;
  const wallpaper = resolveWallpaperUrl(theme);
  if (!wallpaper || isHeavyAppearancePreviewUrl(wallpaper)) {
    el.style.removeProperty('background-image');
    el.style.removeProperty('background-size');
    el.style.removeProperty('background-position');
    return;
  }
  const alpha = getWallpaperOverlayAlpha(theme);
  const safeUrl = wallpaper.replace(/"/g, '\\"');
  el.style.backgroundImage = `linear-gradient(rgba(251,246,240,${alpha}), rgba(251,246,240,${alpha})), url("${safeUrl}")`;
  el.style.backgroundSize = 'cover';
  el.style.backgroundPosition = 'center';
}

export function applyHomePageWallpaperToElement(el, theme, pageNumber) {
  if (!el) return;
  const wallpaper = resolveHomePageWallpaperUrl(theme, pageNumber);
  if (!wallpaper || isHeavyAppearancePreviewUrl(wallpaper)) {
    el.style.removeProperty('background-image');
    el.style.removeProperty('background-size');
    el.style.removeProperty('background-position');
    return;
  }
  const alpha = getWallpaperOverlayAlpha(theme);
  const safeUrl = wallpaper.replace(/"/g, '\\"');
  el.style.backgroundImage = `linear-gradient(rgba(251,246,240,${alpha}), rgba(251,246,240,${alpha})), url("${safeUrl}")`;
  el.style.backgroundSize = 'cover';
  el.style.backgroundPosition = 'center';
}

export function applySettingsWallpaperPreview(el, theme) {
  if (!el) return;
  const wallpaper = resolveWallpaperUrl(theme);
  if (!wallpaper || isHeavyAppearancePreviewUrl(wallpaper)) {
    el.classList.remove('has-settings-wallpaper');
    el.style.removeProperty('--settings-wallpaper');
    return;
  }
  el.style.setProperty('--settings-wallpaper', `url("${wallpaper.replace(/"/g, '\\"')}")`);
  el.classList.add('has-settings-wallpaper');
}

function migrateLegacyWallpaper(themes) {
  const theme = themes[DEFAULT_THEME_ID];
  if (!theme) return;
  const raw = theme.wallpaper != null ? String(theme.wallpaper).trim() : '';
  if (!raw) {
    theme.wallpaper = DEFAULT_WALLPAPER_PATH;
  }
}

const FOURTH_DECOR_WIDGET_IDS = ['scrapbookFourthDecor', 'seaFourthDecor', 'windowFourthDecor'];
const ALBUM_HERO_SPLIT_WIDGET_IDS = ['albumHeroMain', 'albumHeroNote', 'albumHeroSmall'];

function splitAlbumHeroLayout(layout) {
  const source = layout && typeof layout === 'object' ? layout : {};
  const pages = Array.isArray(source.pages)
    ? source.pages.map((page) => (Array.isArray(page) ? page.slice() : []))
    : [];
  const alreadyPlaced = new Set(pages.flat().filter((id) => ALBUM_HERO_SPLIT_WIDGET_IDS.includes(id)));
  const inserted = new Set(alreadyPlaced);
  const nextPages = pages.map((page) => {
    const next = [];
    page.forEach((id) => {
      if (id === 'filmWidget') {
        ALBUM_HERO_SPLIT_WIDGET_IDS.forEach((splitId) => {
          if (inserted.has(splitId)) return;
          next.push(splitId);
          inserted.add(splitId);
        });
        return;
      }
      if (id === 'noteMemo') {
        if (!inserted.has('albumHeroNote')) {
          next.push('albumHeroNote');
          inserted.add('albumHeroNote');
        }
        return;
      }
      next.push(id);
    });
    return next;
  });
  return { ...source, pages: nextPages };
}

function isUntouchedAlbumV8Layout(layout) {
  const source = layout && typeof layout === 'object' ? layout : {};
  const customItems = source.customItems && typeof source.customItems === 'object' ? source.customItems : {};
  if (Object.keys(customItems).length) return false;
  const pagesJson = JSON.stringify(source.pages || []);
  const dockJson = JSON.stringify(source.dock || []);
  return dockJson === JSON.stringify(ALBUM_HOME_LAYOUT_V8.dock)
    && [
      ALBUM_HOME_LAYOUT_V8,
      ALBUM_HOME_RESET_LAYOUT_V8,
      ALBUM_HOME_LAYOUT_V9_INTERIM,
      ALBUM_HOME_LAYOUT_V11,
      ALBUM_HOME_LAYOUT_V12,
      ALBUM_HOME_LAYOUT_V13_INTERIM,
      ALBUM_HOME_LAYOUT_V14,
    ]
      .some((preset) => pagesJson === JSON.stringify(preset.pages));
}

function migrateAlbumHomeLayout(layout) {
  const splitLayout = splitAlbumHeroLayout(layout);
  return isUntouchedAlbumV8Layout(splitLayout) ? createAlbumHomeLayout() : splitLayout;
}

function splitAlbumHeroVisibility(visibility) {
  const source = visibility && typeof visibility === 'object' ? visibility : {};
  const legacyVisible = source.filmWidget !== false;
  return {
    ...source,
    filmWidget: false,
    noteMemo: false,
    albumLeadCard: source.albumLeadCard !== false,
    albumHeroMain: source.albumHeroMain == null ? legacyVisible : source.albumHeroMain !== false,
    albumHeroNote: source.albumHeroNote == null ? legacyVisible : source.albumHeroNote !== false,
    albumHeroSmall: source.albumHeroSmall == null ? legacyVisible : source.albumHeroSmall !== false,
  };
}

function withThemeFourthDecor(layout, widgetId) {
  const source = layout && typeof layout === 'object' ? layout : {};
  const pages = Array.isArray(source.pages)
    ? source.pages.map((page) => (Array.isArray(page) ? page.slice() : []))
    : [];
  while (pages.length < 4) pages.push([]);
  for (let i = 0; i < pages.length; i += 1) {
    pages[i] = pages[i].filter((id) => !FOURTH_DECOR_WIDGET_IDS.includes(id));
  }
  pages[3].unshift(widgetId);
  return { ...source, pages };
}

export function normalizePrefs(raw) {
  const defaults = createDefaultPrefs();
  if (!raw || typeof raw !== 'object') return defaults;
  const colorMode = normalizeAppearanceColorMode(raw.colorMode);
  const chatPlatform = normalizeChatPlatform(raw.chatPlatform);
  const chatSessionAppearanceGeneration = Math.max(
    0,
    Math.floor(Number(raw.chatSessionAppearanceGeneration) || 0),
  );
  const chatToolOrder = Array.isArray(raw.chatToolOrder)
    ? raw.chatToolOrder.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 80)
    : [];
  const activeThemeId = raw.activeThemeId || DEFAULT_THEME_ID;
  const themes = { ...defaults.themes };
  const savedThemes = raw.themes && typeof raw.themes === 'object' ? raw.themes : {};
  for (const [id, theme] of Object.entries(savedThemes)) {
    if (id === PLACEHOLDER_THEME_ID) {
      const saved = theme || {};
      // 海主题是内置模板，但用户可能直接编辑内置项而不另存。
      // 只能对旧占位桩初始化；真实主题存档无论 presetVersion 多旧，都必须用户字段优先。
      // v8 起仅手术剥离仿微信气泡底色硬编码，不整段覆盖用户 CSS。
      const isLegacyStub = saved.ready === false || !saved.customTheme;
      const savedCustom = saved.customTheme && typeof saved.customTheme === 'object'
        ? saved.customTheme
        : {};
      const migratedCustom = {
        ...savedCustom,
        // 只移除完全未编辑的历史内置快照；用户替换或追加过的 CSS 原样保留。
        ...(String(savedCustom.css || '').trim() === LEGACY_SEA_THEME_CSS.trim() ? { css: '' } : {}),
      };
      themes[id] = isLegacyStub
        ? cloneJson(defaults.themes[PLACEHOLDER_THEME_ID])
        : migrateThemeBubbleCssFields(mergeTheme(defaults.themes[PLACEHOLDER_THEME_ID], {
            ...saved,
            homeLayout: withThemeFourthDecor(saved.homeLayout, 'seaFourthDecor'),
            presetVersion: SEA_PRESET_VERSION,
            homeTemplate: HOME_TEMPLATE_SEA,
            homeStyle: 'sea',
            customTheme: migratedCustom,
          }));
      continue;
    }
    if (id === WINDOW_THEME_ID) {
      const saved = theme || {};
      const isLegacyStub = saved.ready === false || !saved.customTheme;
      const savedCustom = saved.customTheme && typeof saved.customTheme === 'object'
        ? saved.customTheme
        : {};
      const migratedCustom = {
        ...savedCustom,
        // 静态 chat.css 接管内置窗样式；只有原样快照才清空，避免覆盖用户改过的消息 CSS。
        ...(String(savedCustom.chatCss || '').trim() === LEGACY_WINDOW_CHAT_CSS.trim() ? { chatCss: '' } : {}),
        ...(String(savedCustom.css || '').trim() === WINDOW_THEME_CSS.trim() ? { css: '' } : {}),
      };
      themes[id] = isLegacyStub
        ? cloneJson(defaults.themes[WINDOW_THEME_ID])
        : migrateThemeBubbleCssFields(mergeTheme(defaults.themes[WINDOW_THEME_ID], {
            ...saved,
            homeLayout: withThemeFourthDecor(saved.homeLayout, 'windowFourthDecor'),
            presetVersion: WINDOW_PRESET_VERSION,
            homeTemplate: HOME_TEMPLATE_WINDOW,
            homeStyle: 'window',
            customTheme: migratedCustom,
          }));
      continue;
    }
    if (id === ALBUM_THEME_ID) {
      const saved = theme || {};
      const isLegacyStub = saved.ready === false || !saved.customTheme;
      const savedWidgets = saved.widgets && typeof saved.widgets === 'object' ? saved.widgets : {};
      const nextWidgets = {
        ...savedWidgets,
        ...(savedWidgets.noteTitle === 'FOR TODAY' ? { noteTitle: '今天也有风' } : {}),
        ...(JSON.stringify(savedWidgets.noteItems || []) === JSON.stringify(['你今天也很可爱。', '晚一点，一起去散步吧。'])
          ? { noteItems: ['记得吃饭。', '晚一点，一起散步。'] }
          : {}),
      };
      const savedLabels = saved.appLabels && typeof saved.appLabels === 'object' ? saved.appLabels : {};
      const savedLayout = saved.homeLayout && typeof saved.homeLayout === 'object' ? saved.homeLayout : null;
      const migratedLayout = savedLayout ? migrateAlbumHomeLayout(savedLayout) : createAlbumHomeLayout();
      const adoptDefaultArtwork = Number(saved.presetVersion || 0) < ALBUM_PRESET_VERSION
        && (saved.wallpaper === WALLPAPER_NONE
          || saved.wallpaper === 'assets/wallpapers/album-cat-wallpaper-v1.webp');
      themes[id] = isLegacyStub
        ? cloneJson(defaults.themes[ALBUM_THEME_ID])
        : migrateThemeBubbleCssFields(mergeTheme(defaults.themes[ALBUM_THEME_ID], {
            ...saved,
            widgets: nextWidgets,
            widgetVisibility: splitAlbumHeroVisibility(saved.widgetVisibility),
            appLabels: {
              ...savedLabels,
              ...(savedLabels.chat === 'Chat' ? { chat: '聊天' } : {}),
            },
            homeLayout: migratedLayout,
            ...(adoptDefaultArtwork ? {
              wallpaper: ALBUM_WALLPAPER_PATH,
              wallpaperOpacity: 0.12,
            } : {}),
            presetVersion: ALBUM_PRESET_VERSION,
            homeTemplate: HOME_TEMPLATE_ALBUM,
            homeStyle: 'album',
          }));
      continue;
    }
    // 用户另存的海/窗主题副本继续沿用对应第四页组件；普通手账及其副本使用纸样收藏票。
    const template = resolveHomeTemplateKey(theme);
    const fourthDecorId = template === HOME_TEMPLATE_SEA
      ? 'seaFourthDecor'
      : template === HOME_TEMPLATE_WINDOW
        ? 'windowFourthDecor'
        : 'scrapbookFourthDecor';
    const migratedHomeLayout = template === HOME_TEMPLATE_ALBUM
      ? splitAlbumHeroLayout(theme?.homeLayout)
      : withThemeFourthDecor(theme?.homeLayout, fourthDecorId);
    themes[id] = migrateThemeBubbleCssFields(mergeTheme(defaults.themes[DEFAULT_THEME_ID], {
      ...theme,
      ...(template === HOME_TEMPLATE_ALBUM ? { widgetVisibility: splitAlbumHeroVisibility(theme?.widgetVisibility) } : {}),
      homeLayout: migratedHomeLayout,
    }));
  }
  if (!themes[activeThemeId]) {
    themes[activeThemeId] = mergeTheme(defaults.themes[DEFAULT_THEME_ID], {});
  }
  migrateLegacyWallpaper(themes);
  const storedLibraryItems = normalizeHomeWidgetLibraryItems(raw.homeWidgetLibrary || {});
  const legacyLibraryItems = collectLegacyHomeWidgetItems(savedThemes, activeThemeId);
  const homeWidgetLibraryItems = { ...legacyLibraryItems, ...storedLibraryItems };
  const hasStoredLibrary = !!(raw.homeWidgetLibrary && typeof raw.homeWidgetLibrary === 'object');
  Object.entries(themes).forEach(([id, theme]) => {
    const savedLayout = savedThemes[id]?.homeLayout;
    // 新结构的 pages 是摆放事实源；首次迁移则用旧逻辑已自愈后的页面，
    // 避免遗留的“未入页但非隐藏”组件被悄悄丢掉。
    const placementSource = hasStoredLibrary && savedLayout
      ? mergeStoredWidgetPlacements(theme.homeLayout, savedLayout, homeWidgetLibraryItems)
      : theme.homeLayout;
    theme.homeLayout = attachHomeWidgetLibrary(
      theme.homeLayout,
      theme.widgetVisibility,
      homeWidgetLibraryItems,
      placementSource,
    );
  });
  return {
    version: 1,
    colorMode,
    chatPlatform,
    chatSessionAppearanceGeneration,
    chatToolOrder,
    homeWidgetLibrary: { version: 1, items: homeWidgetLibraryItems },
    activeThemeId,
    themes,
  };
}

export function getThemeFontConfig(theme) {
  const font = (theme && theme.customFont) || {};
  const fileName = String(font.fileName || '').trim();
  const styleUrl = String(font.styleUrl || '').trim();
  const family = String(font.family || '').trim();
  const dataUrl = normalizeFontDataUrl(String(font.dataUrl || '').trim(), fileName);
  return { dataUrl, fileName, styleUrl, family };
}

const FONT_FILE_URL_RE = /\.(woff2|woff|otf|ttf|ttc)(?:[?#]|$)/i;

/** 从 Google Fonts 链接的 family 参数解析字体名（无需联网）：family=Ma+Shan+Zheng:wght@400 → Ma Shan Zheng */
function familyFromGoogleFontsUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)fonts\.googleapis\.com$/i.test(u.hostname)) return '';
    const fam = u.searchParams.get('family') || '';
    const first = fam.split('|')[0].split(':')[0];
    return first.replace(/\+/g, ' ').trim();
  } catch (_) {
    return '';
  }
}

/** 拉取字体 CSS（如自建 @font-face 样式表），解析首个 font-family 名称 */
async function familyFromCssLink(url) {
  try {
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) return '';
    const css = await resp.text();
    const m = css.match(/font-family\s*:\s*['"]?([^;'"}]+)['"]?/i);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

/**
 * 把用户粘贴的字体链接解析成 customFont 配置：
 *  - 直链字体文件（.woff2/.woff/.otf/.ttf/.ttc）→ 走 @font-face；
 *  - 字体 CSS 链接（Google Fonts 等）→ 注入样式表 + 字体名，CJK 子集也能完整加载。
 * 返回 { dataUrl, fileName, styleUrl, family }。
 */
export async function resolveCustomFontUrl(input) {
  const url = String(input || '').trim();
  if (!url) throw new Error('请输入字体链接');
  if (/^http:\/\//i.test(url)) throw new Error('请使用 https 链接（http 字体会被浏览器拦截）');
  if (!/^https:\/\//i.test(url)) throw new Error('请粘贴 https:// 开头的链接');
  if (FONT_FILE_URL_RE.test(url)) {
    const path = url.split(/[?#]/)[0];
    const name = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || '链接字体';
    return { dataUrl: url, fileName: name, styleUrl: '', family: '' };
  }
  const family = familyFromGoogleFontsUrl(url) || (await familyFromCssLink(url));
  if (!family) {
    throw new Error('没识别出字体。请用字体文件直链（.woff2/.ttf），或 Google Fonts 链接。');
  }
  return { dataUrl: '', fileName: family, styleUrl: url, family };
}

/** 预检：真正尝试把字体直链当 web 字体加载，验证可跨域引用（CORS）且格式正确 */
export async function verifyFontUrlLoadable(url) {
  if (typeof FontFace === 'undefined') return true; // 环境不支持校验则放行
  try {
    const face = new FontFace('MarshmallowFontProbe', `url("${String(url).replace(/"/g, '\\"')}")`);
    await face.load();
    return true;
  } catch (_) {
    return false;
  }
}

/** 修正 FileReader 产生的 data URL MIME，避免 TTF 被标成 octet-stream 导致 @font-face 失效 */
export function normalizeFontDataUrl(dataUrl = '', fileName = '') {
  const raw = String(dataUrl || '').trim();
  if (!raw || !raw.startsWith('data:')) return raw;
  const comma = raw.indexOf(',');
  if (comma < 0) return raw;
  const payload = raw.slice(comma + 1);
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.woff2')) return `data:font/woff2;base64,${payload}`;
  if (lower.endsWith('.woff')) return `data:font/woff;base64,${payload}`;
  if (lower.endsWith('.otf')) return `data:font/otf;base64,${payload}`;
  if (lower.endsWith('.ttf') || lower.endsWith('.ttc')) return `data:font/ttf;base64,${payload}`;
  if (/font\/woff2/i.test(raw)) return `data:font/woff2;base64,${payload}`;
  if (/font\/woff/i.test(raw)) return `data:font/woff;base64,${payload}`;
  if (/font\/otf|opentype/i.test(raw)) return `data:font/otf;base64,${payload}`;
  if (/font\/ttf|x-font-ttf|sfnt/i.test(raw)) return `data:font/ttf;base64,${payload}`;
  return raw;
}

function inferFontFormat(dataUrl = '', fileName = '') {
  const lower = String(fileName || '').toLowerCase();
  // 远程直链时 fileName 可能没有后缀，再看 URL 自身的路径后缀（去掉 query/hash）
  const urlPath = String(dataUrl || '').toLowerCase().split(/[?#]/)[0];
  const ext = (s) => lower.endsWith(s) || urlPath.endsWith(s);
  if (ext('.woff2') || /font\/woff2/i.test(dataUrl)) return 'woff2';
  if (ext('.woff') || /font\/woff/i.test(dataUrl)) return 'woff';
  if (ext('.otf') || /font\/otf|opentype/i.test(dataUrl)) return 'opentype';
  if (ext('.ttf') || ext('.ttc') || /font\/ttf|x-font-ttf|sfnt/i.test(dataUrl)) return 'truetype';
  return '';
}

let activeCustomFontFace = null;
let activeCustomFontObjectUrl = '';
let customFontLoadRevision = 0;

const MONO_KEEP_SELECTORS = [
  'code', 'pre', 'kbd', 'samp',
  '.appearance-custom-css', '.rxg-import-text', '.rxg-find', '.rxg-replace', '.rxg-code-area',
];

/** 启用自定义字体时强制全局生效；排除等宽代码/导入框，避免破坏对齐 */
function injectGlobalFontForce(stack, active) {
  if (typeof document === 'undefined') return;
  let style = document.getElementById('marshmallow-custom-font-force');
  if (!active) {
    if (style) style.remove();
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = 'marshmallow-custom-font-force';
    document.head.appendChild(style);
  }
  const notMono = MONO_KEEP_SELECTORS.map((sel) => `:not(${sel})`).join('');
  style.textContent =
    `body, body *${notMono}{font-family:${stack} !important;}` +
    `${MONO_KEEP_SELECTORS.join(',')}{font-family:ui-monospace,Menlo,Consolas,monospace !important;}`;
}

function injectCustomFontStyle(family, dataUrl, format = '') {
  let style = document.getElementById('marshmallow-custom-font');
  if (!style) {
    style = document.createElement('style');
    style.id = 'marshmallow-custom-font';
    document.head.appendChild(style);
  }
  const safeUrl = dataUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const formatPart = format ? ` format("${format}")` : '';
  style.textContent = `@font-face{font-family:"${family}";src:url("${safeUrl}")${formatPart};font-weight:100 900;font-style:normal;font-display:swap;}`;
}

const CUSTOM_FONT_LINK_ID = 'marshmallow-custom-font-link';

/** 链接样式表模式（如 Google Fonts）：用 <link> 引入全部 @font-face 子集 */
function injectCustomFontLink(href) {
  let link = document.getElementById(CUSTOM_FONT_LINK_ID);
  if (!link) {
    link = document.createElement('link');
    link.id = CUSTOM_FONT_LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}
function removeCustomFontLink() {
  document.getElementById(CUSTOM_FONT_LINK_ID)?.remove();
}
function revokeActiveCustomFontObjectUrl() {
  if (!activeCustomFontObjectUrl || typeof URL === 'undefined') return;
  try { URL.revokeObjectURL(activeCustomFontObjectUrl); } catch (_) {}
  activeCustomFontObjectUrl = '';
}

function clearCustomFontFace() {
  customFontLoadRevision += 1;
  document.getElementById('marshmallow-custom-font')?.remove();
  if (activeCustomFontFace && document.fonts) {
    try { document.fonts.delete(activeCustomFontFace); } catch (_) {}
    activeCustomFontFace = null;
  }
  revokeActiveCustomFontObjectUrl();
}

/**
 * 冷启动时不要再把数十 MB 的 Base64 字体同时复制进 style.textContent 与 FontFace
 * 构造参数。Android WebView 在热更新重启后的内存峰值更高，容易直接拒绝字体并回退
 * 默认字。按块解码成 Blob 后只把很短的 blob: URL 交给 CSS 字体解析器。
 */
export function fontDataUrlToBlob(dataUrl = '') {
  const source = String(dataUrl || '');
  const comma = source.indexOf(',');
  if (comma < 0 || !source.startsWith('data:')) throw new Error('字体数据格式无效');
  const header = source.slice(5, comma);
  const mime = String(header.split(';')[0] || 'application/octet-stream');
  const payload = source.slice(comma + 1);
  if (!/;base64(?:;|$)/i.test(header)) {
    return new Blob([decodeURIComponent(payload)], { type: mime });
  }
  const chunks = [];
  // Base64 分段边界必须是 4 的倍数；192KB 字符约解出 144KB 二进制。
  const step = 192 * 1024;
  for (let offset = 0; offset < payload.length; offset += step) {
    const binary = atob(payload.slice(offset, offset + step));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    chunks.push(bytes);
  }
  return new Blob(chunks, { type: mime });
}

function loadCustomFontFace(family, dataUrl, format = '') {
  const revision = ++customFontLoadRevision;
  if (activeCustomFontFace && document.fonts) {
    try { document.fonts.delete(activeCustomFontFace); } catch (_) {}
    activeCustomFontFace = null;
  }
  revokeActiveCustomFontObjectUrl();
  if (typeof FontFace === 'undefined' || !document.fonts) {
    injectCustomFontStyle(family, dataUrl, format);
    return;
  }
  void (async () => {
    let lastError = null;
    // APK 强制更新刚重启时 WebView 的字体解析器偶尔尚未就绪；稍后重建 Blob URL 重试，
    // 避免一次瞬时失败就让已保存字体在整次会话里都退回默认字。
    const retryDelays = [0, 800, 2400];
    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      if (revision !== customFontLoadRevision) return;
      if (retryDelays[attempt]) {
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
        if (revision !== customFontLoadRevision) return;
      }
      let objectUrl = '';
      try {
        let sourceUrl = dataUrl;
        if (String(dataUrl).startsWith('data:')
          && typeof URL !== 'undefined'
          && typeof URL.createObjectURL === 'function') {
          objectUrl = URL.createObjectURL(fontDataUrlToBlob(dataUrl));
          sourceUrl = objectUrl;
        }
        const face = new FontFace(family, `url("${sourceUrl.replace(/"/g, '\\"')}")`);
        await face.load();
        if (revision !== customFontLoadRevision) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          return;
        }
        document.fonts.add(face);
        activeCustomFontFace = face;
        activeCustomFontObjectUrl = objectUrl;
        injectCustomFontStyle(family, sourceUrl, format);
        return;
      } catch (err) {
        lastError = err;
        if (objectUrl) {
          try { URL.revokeObjectURL(objectUrl); } catch (_) {}
        }
      }
    }
    if (revision !== customFontLoadRevision) return;
    // 旧内核不支持 Blob 字体时保留原 data URL 的 CSS 兜底。
    injectCustomFontStyle(family, dataUrl, format);
    console.warn('[appearance] FontFace load failed after retries, using @font-face fallback', lastError);
  })();
}

export function applyCustomFont(theme) {
  if (typeof document === 'undefined') return;
  const { dataUrl, fileName, styleUrl, family } = getThemeFontConfig(theme);
  const root = document.documentElement;
  // 模式一：链接样式表（Google Fonts 等）——注入 <link>，用其字体名做全局栈
  if (styleUrl && family) {
    clearCustomFontFace();
    injectCustomFontLink(styleUrl);
    const safeFamily = family.replace(/"/g, '\\"');
    const stack = `"${safeFamily}", ${DEFAULT_FONT_STACK}`;
    root.style.setProperty('--font-family-base', stack);
    root.style.setProperty('--sea-font-en', stack);
    injectGlobalFontForce(stack, true);
    return;
  }
  removeCustomFontLink();
  if (!dataUrl) {
    clearCustomFontFace();
    root.style.removeProperty('--font-family-base');
    root.style.removeProperty('--sea-font-en');
    injectGlobalFontForce('', false);
    return;
  }
  const normalizedUrl = normalizeFontDataUrl(dataUrl, fileName);
  const format = inferFontFormat(normalizedUrl, fileName);
  // FontFace 成功后再注入 blob: 形式的 CSS；避免冷启动把大 Base64 再复制一整份。
  loadCustomFontFace(CUSTOM_FONT_FAMILY, normalizedUrl, format);
  const stack = `"${CUSTOM_FONT_FAMILY}", ${DEFAULT_FONT_STACK}`;
  root.style.setProperty('--font-family-base', stack);
  // 让海之屿的英文/时钟等也跟随自定义字体，做到真正全局；清除时自动回退默认
  root.style.setProperty('--sea-font-en', stack);
  // 表单控件、被 font 简写重置或被次级文本规则吃掉的元素不一定继承 body 字体，
  // 启用自定义字体时强制全局覆盖（仅排除等宽代码/导入编辑框，换字会破坏对齐）。
  injectGlobalFontForce(stack, true);
}

function migrateLegacySeaMusicVisibility(widgetVisibility = {}) {
  const vis = { ...widgetVisibility };
  if (!Object.prototype.hasOwnProperty.call(vis, 'seaMusic')) return vis;
  const legacy = vis.seaMusic;
  if (!Object.prototype.hasOwnProperty.call(vis, 'seaMusicP1')) vis.seaMusicP1 = legacy;
  if (!Object.prototype.hasOwnProperty.call(vis, 'seaMusicP2')) vis.seaMusicP2 = legacy;
  delete vis.seaMusic;
  return vis;
}

export function getWidgetVisibility(theme) {
  return migrateLegacySeaMusicVisibility({
    ...DEFAULT_WIDGET_VISIBILITY,
    ...((theme && theme.widgetVisibility) || {}),
  });
}

export function isWidgetVisible(theme, key) {
  return getWidgetVisibility(theme)[key] !== false;
}

export function getCustomThemeConfig(theme) {
  const custom = (theme && theme.customTheme) || {};
  const homeTextVars = migrateLegacyCssVarsToHomeTextVars(theme);
  const pageCss = {};
  const pageDarkCss = {};
  Object.entries(custom.pageCss && typeof custom.pageCss === 'object' ? custom.pageCss : {}).forEach(([key, value]) => {
    const css = String(value || '').trim();
    if (css) pageCss[String(key)] = css;
  });
  Object.entries(custom.pageDarkCss && typeof custom.pageDarkCss === 'object' ? custom.pageDarkCss : {}).forEach(([key, value]) => {
    const css = String(value || '').trim();
    if (css) pageDarkCss[String(key)] = css;
  });
  return {
    css: String(custom.css || ''),
    chatCss: String(custom.chatCss || ''),
    pageCss,
    pageDarkCss,
    homeTextVars: { ...homeTextVars },
  };
}

const USER_THEME_STYLE_ID = 'marshmallow-user-theme';
const USER_VARS_STYLE_ID = 'marshmallow-user-css-vars';
const CHAT_GLOBAL_STYLE_ID = 'marshmallow-chat-global-css';
const PAGE_CSS_STYLE_ID = 'marshmallow-page-css';
const PAGE_DARK_CSS_STYLE_ID = 'marshmallow-page-dark-css';
const APPEARANCE_STYLE_IDS = [
  USER_THEME_STYLE_ID,
  USER_VARS_STYLE_ID,
  CHAT_GLOBAL_STYLE_ID,
  PAGE_CSS_STYLE_ID,
  PAGE_DARK_CSS_STYLE_ID,
  'marshmallow-custom-font',
  'marshmallow-custom-font-force',
];

let colorModeMedia = null;
let colorModeMediaListener = null;

export function normalizeChatPlatform(value) {
  const platform = String(value || '').trim().toLowerCase();
  return CHAT_PLATFORMS.includes(platform) ? platform : DEFAULT_CHAT_PLATFORM;
}

export function applyChatPlatform(value) {
  const platform = normalizeChatPlatform(value);
  if (typeof document === 'undefined') return platform;
  const root = document.documentElement;
  root.dataset.chatPlatform = platform;
  root.classList.toggle('chat-platform-wechat', platform === 'wechat');
  root.classList.toggle('chat-platform-qq', platform === 'qq');
  return platform;
}

export function normalizeAppearanceColorMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return APPEARANCE_COLOR_MODES.includes(mode) ? mode : 'light';
}

export function resolveAppearanceColorMode(value) {
  const mode = normalizeAppearanceColorMode(value);
  if (mode !== 'system') return mode;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function syncNightCssMedia() {
  if (typeof document === 'undefined') return;
  const disabled = document.documentElement.classList.contains('beautify-safe-mode');
  const media = !disabled && document.documentElement.dataset.colorMode === 'dark' ? 'all' : 'not all';
  [PAGE_DARK_CSS_STYLE_ID, 'os-custom-dark-css'].forEach((id) => {
    const style = document.getElementById(id);
    if (style) style.media = media;
  });
}

export function applyAppearanceColorMode(value) {
  if (typeof document === 'undefined') return resolveAppearanceColorMode(value);
  const preference = normalizeAppearanceColorMode(value);
  const previewMode = globalThis.__MM_BEAUTIFY_PREVIEW_COLOR_MODE__;
  const resolved = previewMode === 'dark' || previewMode === 'light'
    ? previewMode
    : resolveAppearanceColorMode(preference);
  const root = document.documentElement;
  const previous = root.dataset.colorMode;
  const nativeScheme = resolved === 'dark' && root.dataset.appShell === 'home'
    ? 'light'
    : resolved;
  root.dataset.colorModePreference = preference;
  root.dataset.colorMode = resolved;
  root.style.colorScheme = nativeScheme;
  root.classList.toggle('theme-dark', resolved === 'dark');
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', nativeScheme);
  syncNightCssMedia();

  if (colorModeMedia && colorModeMediaListener) {
    colorModeMedia.removeEventListener?.('change', colorModeMediaListener);
    colorModeMedia.removeListener?.(colorModeMediaListener);
  }
  colorModeMedia = null;
  colorModeMediaListener = null;
  if (preference === 'system' && typeof matchMedia === 'function') {
    colorModeMedia = matchMedia('(prefers-color-scheme: dark)');
    colorModeMediaListener = () => applyAppearanceColorMode('system');
    colorModeMedia.addEventListener?.('change', colorModeMediaListener);
    if (!colorModeMedia.addEventListener) colorModeMedia.addListener?.(colorModeMediaListener);
  }

  try { localStorage.setItem(COLOR_MODE_STORAGE_KEY, preference); } catch (_) {}
  if (previous && previous !== resolved && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('marshmallow-color-mode-changed', {
      detail: { preference, resolved },
    }));
  }
  return resolved;
}

/**
 * Keep-Alive 把整棵页面 DOM 摘下再挂回时，Android WebView 偶尔会继续复用旧的
 * stylesheet / compositing 结果。原地重写相同 textContent 在部分版本不会触发失效，
 * 用等价 style 节点就地替换，既保持级联顺序，也强制浏览器重建 CSSStyleSheet。
 */
export function rebuildAppearanceStyleSheets() {
  if (typeof document === 'undefined') return;
  for (const id of APPEARANCE_STYLE_IDS) {
    const current = document.getElementById(id);
    if (!current || current.tagName !== 'STYLE') continue;
    const replacement = current.cloneNode(true);
    current.replaceWith(replacement);
  }
}

const appearanceAssetRevisions = new Map();

function writeTextStyleEl(id, cssText) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(id);
  const trimmed = String(cssText || '').trim();
  if (!trimmed) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  if (document.documentElement.classList.contains('ios-webkit')) {
    const replacement = el.cloneNode(false);
    replacement.textContent = trimmed;
    el.replaceWith(replacement);
    return;
  }
  el.textContent = trimmed;
}

function applyTextStyleEl(id, cssText) {
  if (typeof document === 'undefined') return;
  const source = String(cssText || '');
  const revision = (appearanceAssetRevisions.get(id) || 0) + 1;
  appearanceAssetRevisions.set(id, revision);
  writeTextStyleEl(id, source);
  if (!source.includes('mm-img://')) return;
  import('./beautify-assets.js')
    .then(({ resolveBeautifyCssAssets }) => resolveBeautifyCssAssets(source))
    .then((resolved) => {
      if (appearanceAssetRevisions.get(id) !== revision || resolved === source) return;
      writeTextStyleEl(id, resolved);
    })
    .catch(() => {});
}

/**
 * 旧入口「消息界面 CSS（全局）」与美化工作室发布的聊天页 CSS 使用同一条
 * 作用域/主题根/提权链。否则海、窗主题的复合 .is-them 规则会单独盖掉
 * 对方气泡背景，表现成同一套美化里只有角色气泡退回透明或主题底色。
 */
export function prepareGlobalChatCss(cssText = '') {
  const scoped = scopeCssToPage(String(cssText || ''), BEAUTIFY_PAGE_ROOTS['chat-thread'] || []);
  return appendChatChromeSafeAreaGuards(
    prepareChatVisualCssPriority(expandChatAppearanceRootSelectors(
      expandAnonymousBubbleCompatibility(scoped),
    )),
  );
}

/** 保留全站 CSS 原稿，只为其中的聊天气泡追加定向高权重副本。 */
export function prepareGlobalThemeCss(cssText = '') {
  const src = String(cssText || '').trim();
  if (!src) return '';
  // ID 级气泡副本已足以压过主题复合选择器，这里不再扩成八套主题根，
  // 避免整份全局 CSS（常含字体与主屏组件）被无意义放大。
  const scopedChatCss = scopeCssToPage(src, BEAUTIFY_PAGE_ROOTS['chat-thread'] || []);
  const bubbleOverride = prepareChatBubblePriorityOverride(
    expandAnonymousBubbleCompatibility(scopedChatCss),
  );
  const combined = bubbleOverride
    ? `${src}\n/* global custom CSS: bubble priority */\n${bubbleOverride}`
    : src;
  const safeAreaGuard = buildChatChromeSafeAreaGuardCss(scopedChatCss);
  return safeAreaGuard ? `${combined}\n${safeAreaGuard}` : combined;
}

export function applyCustomTheme(theme) {
  if (typeof document === 'undefined') return;
  const { css, chatCss, pageCss, pageDarkCss, homeTextVars } = getCustomThemeConfig(theme);
  const trimmedCss = css.trim();
  applyTextStyleEl(CHAT_GLOBAL_STYLE_ID, prepareGlobalChatCss(chatCss));
  // 美化工作室按页面发布的 CSS：每页独立一个键，发布互不覆盖，合并注入同一个 style。
  // 非聊天页仍使用通用提权；聊天页只提升视觉声明，布局声明恢复正常级联，
  // 避免页面美化压过 iOS 键盘、安全区与壁纸骨架。
  applyTextStyleEl(PAGE_CSS_STYLE_ID, Object.entries(pageCss)
    .map(([key, value]) => {
      const scoped = scopeCssToPage(value, BEAUTIFY_PAGE_ROOTS[key] || []);
      const prepared = key === 'chat-thread'
        ? appendChatChromeSafeAreaGuards(
            prepareChatVisualCssPriority(expandChatAppearanceRootSelectors(
              expandAnonymousBubbleCompatibility(scoped),
            )),
          )
        : boostCssPriority(scoped);
      return `/* beautify-page:${key} */\n${prepared}`;
    })
    .join('\n\n'));
  applyTextStyleEl(PAGE_DARK_CSS_STYLE_ID, Object.entries(pageDarkCss)
    .map(([key, value]) => {
      const scoped = scopeCssToPage(value, BEAUTIFY_PAGE_ROOTS[key] || []);
      const prepared = key === 'chat-thread'
        ? appendChatChromeSafeAreaGuards(
            prepareChatVisualCssPriority(expandChatAppearanceRootSelectors(
              expandAnonymousBubbleCompatibility(scoped),
            )),
          )
        : boostCssPriority(scoped);
      return `/* beautify-page-dark:${key} */\n${prepared}`;
    })
    .join('\n\n'));
  syncNightCssMedia();
  // 会话级聊天美化的 style 必须排在全局发布之后（同权重时后者胜出=会话优先）
  const pageCssEl = document.getElementById(PAGE_CSS_STYLE_ID);
  const pageDarkCssEl = document.getElementById(PAGE_DARK_CSS_STYLE_ID);
  const chatThreadCssEl = document.getElementById('marshmallow-chat-thread-css');
  if (pageCssEl && pageDarkCssEl && pageCssEl.nextElementSibling !== pageDarkCssEl) {
    pageCssEl.after(pageDarkCssEl);
  }
  const latestPageCssEl = pageDarkCssEl || pageCssEl;
  if (latestPageCssEl && chatThreadCssEl
    && (chatThreadCssEl.compareDocumentPosition(latestPageCssEl) & Node.DOCUMENT_POSITION_FOLLOWING)) {
    chatThreadCssEl.before(latestPageCssEl);
  }

  let varsStyle = document.getElementById(USER_VARS_STYLE_ID);
  const shell = getHomeShellSelector(theme);
  const varEntries = Object.entries(homeTextVars)
    .filter(([key, value]) => String(key || '').trim() && String(value || '').trim());
  if (!varEntries.length) {
    varsStyle?.remove();
  } else {
    if (!varsStyle) {
      varsStyle = document.createElement('style');
      varsStyle.id = USER_VARS_STYLE_ID;
      document.head.appendChild(varsStyle);
    }
    varsStyle.textContent = `${shell}{${varEntries.map(([key, value]) => `${key}:${String(value).trim()}`).join(';')}}`;
  }

  let style = document.getElementById(USER_THEME_STYLE_ID);
  if (!trimmedCss) {
    style?.remove();
  } else {
    if (!style) {
      style = document.createElement('style');
      style.id = USER_THEME_STYLE_ID;
      document.head.appendChild(style);
    }
    // 「主屏与全局」历史上也承载整套聊天主题。否则会出现顶栏/底栏生效，
    // 气泡却被海/窗主题复合选择器盖回的半失效状态。
    style.textContent = prepareGlobalThemeCss(trimmedCss);
  }
}

export function applyChatBubbleFontSize(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--chat-bubble-font-size', `${getChatBubbleFontSize(theme)}px`);
}

/** 读取当前生效主题的全局聊天气泡字号 */
export async function getGlobalChatBubbleFontSize() {
  const prefs = await loadAppearancePrefs();
  return getChatBubbleFontSize(getActiveTheme(prefs).theme);
}

/** 设置全局聊天气泡字号（写入当前主题并立即应用），返回最终生效值 */
export async function setGlobalChatBubbleFontSize(size) {
  const next = clampChatBubbleFontSize(size);
  const prefs = await loadAppearancePrefs();
  const { id, theme } = getActiveTheme(prefs);
  const saved = await saveAppearancePrefs({
    ...prefs,
    themes: { ...prefs.themes, [id]: { ...theme, chatBubbleFontSize: next } },
  });
  applyChatBubbleFontSize(getActiveTheme(saved).theme);
  return next;
}

export function applyAppearanceTheme(theme) {
  if (typeof document !== 'undefined') {
    const homeTemplate = resolveHomeTemplateKey(theme);
    // 相册主屏保留自己的构图，但 App 内页复用「窗」的中性 Ins 皮肤。
    const skin = homeTemplate === HOME_TEMPLATE_ALBUM ? HOME_TEMPLATE_WINDOW : homeTemplate;
    document.documentElement.dataset.homeTemplate = homeTemplate;
    document.documentElement.dataset.uiSkin = skin;
    const app = document.getElementById('app');
    if (app) {
      app.dataset.homeTemplate = homeTemplate;
      app.dataset.uiSkin = skin;
    }
  }
  applyCustomFont(theme);
  applyChatBubbleFontSize(theme);
  applyCustomTheme(theme);
  applyAppIconEdge(theme);
  applyWindowFrame(theme);
  applyAlbumGrayFilter(theme);
}

/** 窗主题的白色固定窗框；旧存档没有该字段时保持原有的默认显示。 */
export function isWindowFrameEnabled(theme) {
  return theme?.windowFrameEnabled !== false;
}

export function applyWindowFrame(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('window-frame-off', !isWindowFrameEnabled(theme));
}

/** 相册主题旧版低饱和壁纸质感；默认关闭，由用户在美化页按需恢复。 */
export function isAlbumGrayFilterEnabled(theme) {
  return resolveHomeTemplateKey(theme) === HOME_TEMPLATE_ALBUM
    && theme?.albumGrayFilterEnabled === true;
}

export function applyAlbumGrayFilter(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(
    'album-gray-filter-on',
    isAlbumGrayFilterEnabled(theme),
  );
}

/** 主屏 App 图标底框（贴纸底板 / 玻璃底板）；默认开启，关闭后只保留图标内容与点击区 */
export function isAppIconEdgeEnabled(theme) {
  return theme?.appIconEdgeEnabled !== false;
}

export function clampAppIconFrameOpacity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_APP_ICON_FRAME_OPACITY;
  return Math.max(0, Math.min(1, number));
}

export function getAppIconFrameOpacity(theme) {
  return clampAppIconFrameOpacity(theme?.appIconFrameOpacity);
}

export function applyAppIconEdge(theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('app-icon-edge-off', !isAppIconEdgeEnabled(theme));
  root.style.setProperty('--app-icon-frame-opacity', String(getAppIconFrameOpacity(theme)));
}

export async function applyAppearanceThemeFromPrefs() {
  const prefs = await loadAppearancePrefs();
  applyAppearanceColorMode(prefs.colorMode);
  applyChatPlatform(prefs.chatPlatform);
  const { theme } = getActiveTheme(prefs);
  applyAppearanceTheme(theme);
}

export function isFontFile(file) {
  if (!file) return false;
  const name = String(file.name || '').toLowerCase();
  if (/\.(ttf|ttc|otf|woff2?)$/.test(name)) return true;
  const type = String(file.type || '').toLowerCase();
  return type.includes('font')
    || type === 'application/vnd.ms-fontobject'
    || type === 'application/x-font-ttf'
    || type === 'application/x-font-opentype'
    || type === 'application/octet-stream';
}

// 外观配置是全局单条记录、每个页面 render 都要读。这里缓存原始值，
// 读取时按需 normalize（返回全新对象，无就地修改风险），避免每次导航都打一次
// IndexedDB；同时消除「默认主题无壁纸时每次 load 都回写」的写放大。
let _appearancePrefsRawCache = null;
let _appearancePrefsCached = false;
let _appearancePrefsNormalizedCache = null;

export function invalidateAppearancePrefsCache() {
  _appearancePrefsRawCache = null;
  _appearancePrefsCached = false;
  _appearancePrefsNormalizedCache = null;
}

export function getCachedAppearancePrefs() {
  if (!_appearancePrefsCached) return null;
  if (!_appearancePrefsNormalizedCache) {
    _appearancePrefsNormalizedCache = normalizePrefs(_appearancePrefsRawCache);
  }
  return _appearancePrefsNormalizedCache;
}

/** 只读、同步：给 Chat 列表等页面判断海/窗 Ins 顶栏，避免每次进页都 normalize 整套主题大图。 */
export function getChatHubInsContextSync() {
  if (!_appearancePrefsCached || !_appearancePrefsRawCache) return null;
  const raw = _appearancePrefsRawCache;
  const id = (raw.activeThemeId) || DEFAULT_THEME_ID;
  const theme = (raw.themes && raw.themes[id]) || (raw.themes && raw.themes[DEFAULT_THEME_ID]);
  if (!theme) return null;
  const windowTheme = isWindowHomeTheme(id, theme);
  const seaTheme = isSeaHomeTheme(id, theme);
  const chatPlatform = normalizeChatPlatform(raw.chatPlatform);
  const hubInsChrome = chatPlatform !== DEFAULT_CHAT_PLATFORM || windowTheme || seaTheme;
  return { hubInsChrome, windowTheme, seaTheme, chatPlatform };
}

/** 同步判断海/窗主题下 Chat 三页是否走 Ins 顶栏（依赖已 warm 的外观缓存） */
export function isChatHubInsChromeActiveSync() {
  const prefs = getCachedAppearancePrefs();
  if (!prefs) return false;
  if (normalizeChatPlatform(prefs.chatPlatform) !== DEFAULT_CHAT_PLATFORM) return true;
  const active = getActiveTheme(prefs);
  return isWindowHomeTheme(active.id, active.theme) || isSeaHomeTheme(active.id, active.theme);
}

export function getChatPlatformSync() {
  const prefs = getCachedAppearancePrefs();
  return normalizeChatPlatform(prefs?.chatPlatform);
}

export async function setChatPlatform(value, options = {}) {
  const platform = normalizeChatPlatform(value);
  const prefs = await loadAppearancePrefs();
  const resetSessionAppearance = options?.resetSessionAppearance !== false;
  const currentGeneration = Math.max(
    0,
    Math.floor(Number(prefs.chatSessionAppearanceGeneration) || 0),
  );
  const saved = await saveAppearancePrefs({
    ...prefs,
    chatPlatform: platform,
    chatSessionAppearanceGeneration: resetSessionAppearance
      ? currentGeneration + 1
      : currentGeneration,
  });
  applyChatPlatform(saved.chatPlatform);
  return saved.chatPlatform;
}

/** 同步读取当前主屏模板：'sea' | 'window' | ''（依赖已 warm 的外观缓存，未 warm 时返回空） */
export function getActiveHomeStyleSync() {
  const prefs = getCachedAppearancePrefs();
  if (!prefs) return '';
  const active = getActiveTheme(prefs);
  if (isSeaHomeTheme(active.id, active.theme)) return 'sea';
  if (isWindowHomeTheme(active.id, active.theme)) return 'window';
  if (isAlbumHomeTheme(active.id, active.theme)) return 'album';
  return '';
}

export async function loadAppearancePrefs() {
  if (_appearancePrefsCached) return normalizePrefs(_appearancePrefsRawCache);
  const row = await db.get(APPEARANCE_PREFS_KEY);
  const raw = row && row.value;
  const prefs = normalizePrefs(raw);
  const legacyTheme = raw && raw.themes && raw.themes[DEFAULT_THEME_ID];
  const legacyWallpaper = legacyTheme && legacyTheme.wallpaper != null
    ? String(legacyTheme.wallpaper).trim()
    : '';
  const needsCustomCssMigrationPersist = (() => {
    const rawThemes = raw && raw.themes && typeof raw.themes === 'object' ? raw.themes : null;
    if (!rawThemes) return false;
    for (const [id, theme] of Object.entries(rawThemes)) {
      const rawCss = String(theme?.customTheme?.css || '');
      const rawChatCss = String(theme?.customTheme?.chatCss || '');
      const hasDuplicateChatPublishSlots = !!(
        rawChatCss.trim()
        && String(theme?.customTheme?.pageCss?.['chat-thread'] || '').trim()
      );
      if (!hasDuplicateChatPublishSlots
        && !cssHasLegacyWechatBubbleLock(rawCss)
        && !cssHasLegacyWechatBubbleLock(rawChatCss)) continue;
      const next = prefs.themes?.[id]?.customTheme || {};
      if (rawCss !== String(next.css || '') || rawChatCss !== String(next.chatCss || '')) return true;
    }
    return false;
  })();
  const needsHomeWidgetLibraryMigration = !!(raw
    && !raw.homeWidgetLibrary
    && Object.values(raw.themes || {}).some((theme) => (
      Object.keys(theme?.homeLayout?.customItems || {}).length > 0
    )));
  if (raw && (!legacyWallpaper || needsCustomCssMigrationPersist || needsHomeWidgetLibraryMigration)) {
    await saveAppearancePrefs(prefs);
    return normalizePrefs(_appearancePrefsRawCache);
  }
  _appearancePrefsRawCache = compactAppearancePrefsForStorage(prefs);
  _appearancePrefsCached = true;
  _appearancePrefsNormalizedCache = null;
  return prefs;
}

function notifyAppearanceChanged(detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('marshmallow-appearance-changed', {
    detail: detail && typeof detail === 'object' ? { ...detail } : {},
  }));
}

export async function saveAppearancePrefs(prefs, options = {}) {
  const normalized = normalizePrefs(prefs);
  const stored = compactAppearancePrefsForStorage(normalized);
  await db.put({ key: APPEARANCE_PREFS_KEY, value: stored });
  _appearancePrefsRawCache = stored;
  _appearancePrefsCached = true;
  _appearancePrefsNormalizedCache = null;
  applyAppearanceColorMode(normalized.colorMode);
  applyChatPlatform(normalized.chatPlatform);
  notifyAppearanceChanged({
    refreshActiveHome: options?.refreshActiveHome === true,
  });
  return normalized;
}

if (typeof window !== 'undefined') {
  // 切换用户或导入备份后，外观配置可能整体被替换，主动失效缓存。
  window.addEventListener('current-user-changed', invalidateAppearancePrefsCache);
  window.addEventListener('appearance-prefs-invalidate', invalidateAppearancePrefsCache);
}

// 早期版本上传壁纸/头像/图标不做压缩，相机直出图能把这条记录堆到几十 MB：
// boot 时要整条读出来才能应用主题，越大读取越慢；美化设置页更要把所有图片一次性拼进
// 一段 innerHTML，字符串一大就容易在低内存机型上把 WebView 渲染进程闷死。
// 这里一次性把历史遗留的超大图收敛到正常压缩后的尺寸，之后新上传统一在上传处压缩，不会再堆大。
const LEGACY_OVERSIZED_IMAGE_THRESHOLD = 500_000; // base64 字符数，约对应压缩前 ~370KB 原始图
const APP_ICON_COMPACT_MAX_CHARS = 48_000; // 240px 图标 PNG 正常远小于此；超出说明未收敛或上传链路漏压
/** Widget slots that must stay PNG even if the stored mime looks opaque (cutouts / film chrome). */
const WIDGET_FORCE_ALPHA_KEYS = new Set(['filmRingDataUrl', 'filmStickerDataUrl']);

function dataUrlIsAlphaCapable(dataUrl) {
  return /^data:image\/(png|webp|gif)/i.test(String(dataUrl || ''));
}

function isOversizedImageDataUrl(value) {
  return typeof value === 'string' && value.length > LEGACY_OVERSIZED_IMAGE_THRESHOLD && /^data:image\//i.test(value);
}

function shouldCompactAppIconDataUrl(value) {
  return typeof value === 'string' && /^data:image\//i.test(value) && value.length > APP_ICON_COMPACT_MAX_CHARS;
}

function shouldCompactWallpaperDataUrl(value) {
  return typeof value === 'string' && /^data:image\//i.test(value)
    && (isHeavyAppearancePreviewUrl(value) || isOversizedImageDataUrl(value));
}

/** 预览/缩略图用的更严上限：美化设置页滚动时若整页或缩略图挂太多大图，WebView 合成会闷死。 */
export const APPEARANCE_PREVIEW_MAX_URL_CHARS = 120_000;

export function isHeavyAppearancePreviewUrl(value) {
  return typeof value === 'string'
    && value.length > APPEARANCE_PREVIEW_MAX_URL_CHARS
    && /^data:image\//i.test(value);
}

export function isOversizedAppearanceImageUrl(value) {
  return isOversizedImageDataUrl(value);
}

/** 快速判断某个主题是否还有未收敛的历史超大图；用于触发后台压缩，不在渲染路径上阻塞等待。 */
export function themeHasOversizedImages(theme) {
  if (!theme || typeof theme !== 'object') return false;
  if (shouldCompactWallpaperDataUrl(theme.wallpaper)) return true;
  if (shouldCompactWallpaperDataUrl(theme.homePanorama?.src)) return true;
  if (shouldCompactWallpaperDataUrl(theme.userCard?.avatarDataUrl)) return true;
  if (theme.appIcons && typeof theme.appIcons === 'object') {
    for (const value of Object.values(theme.appIcons)) {
      if (shouldCompactAppIconDataUrl(value)) return true;
    }
  }
  for (const map of [theme.homePageWallpapers, theme.widgets]) {
    if (!map || typeof map !== 'object') continue;
    for (const value of Object.values(map)) {
      if (shouldCompactWallpaperDataUrl(value)) return true;
    }
  }
  return false;
}

function decodeAndResizeDataUrl(dataUrl, { maxSize = 1600, quality = 0.82, preserveAlpha = false } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const longest = Math.max(img.naturalWidth || maxSize, img.naturalHeight || maxSize);
        const scale = Math.min(1, maxSize / longest);
        const w = Math.max(1, Math.round((img.naturalWidth || maxSize) * scale));
        const h = Math.max(1, Math.round((img.naturalHeight || maxSize) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const usePng = !!preserveAlpha;
        const ctx = canvas.getContext('2d', { alpha: usePng });
        if (!ctx) throw new Error('无法压缩图片');
        // JPEG has no alpha: transparent pixels become black unless we paint a solid mat first.
        if (!usePng) {
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
        } else {
          ctx.clearRect(0, 0, w, h);
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(usePng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

async function compactImageMapIfNeeded(map, sizeFor, shouldCompact = isOversizedImageDataUrl) {
  if (!map || typeof map !== 'object') return { changed: false, map };
  const next = {};
  let changed = false;
  for (const [key, value] of Object.entries(map)) {
    if (shouldCompact(value)) {
      try {
        next[key] = await decodeAndResizeDataUrl(value, sizeFor(key, value));
        changed = true;
        continue;
      } catch (_) { /* 解码失败就保留原值，不阻断其它字段的压缩 */ }
    }
    next[key] = value;
  }
  return { changed, map: next };
}

function yieldAppearanceCompact(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeCompactedImageMap(latestMap, sourceMap, compactedMap) {
  const latest = latestMap && typeof latestMap === 'object' ? latestMap : {};
  const source = sourceMap && typeof sourceMap === 'object' ? sourceMap : {};
  const compacted = compactedMap && typeof compactedMap === 'object' ? compactedMap : {};
  let next = latest;
  let changed = false;
  for (const [key, value] of Object.entries(compacted)) {
    if (value === source[key] || latest[key] !== source[key]) continue;
    if (!changed) next = { ...latest };
    next[key] = value;
    changed = true;
  }
  return { changed, map: next };
}

/**
 * 把后台压缩结果手术式合并到最新主题：只有仍等于压缩前原图的字段才能替换。
 * 用户在压缩期间上传/清除的新图片绝不能被较早快照覆盖。
 */
export function mergeCompactedAppearanceTheme(latestTheme, sourceTheme, patch) {
  const latest = latestTheme && typeof latestTheme === 'object' ? latestTheme : {};
  const source = sourceTheme && typeof sourceTheme === 'object' ? sourceTheme : {};
  const compacted = patch && typeof patch === 'object' ? patch : {};
  let next = latest;
  let changed = false;
  const assign = (key, value) => {
    if (!changed) next = { ...latest };
    next[key] = value;
    changed = true;
  };

  if ('wallpaper' in compacted && latest.wallpaper === source.wallpaper) {
    assign('wallpaper', compacted.wallpaper);
  }
  if (
    compacted.homePanorama?.src
    && latest.homePanorama?.src === source.homePanorama?.src
  ) {
    assign('homePanorama', { ...(latest.homePanorama || {}), src: compacted.homePanorama.src });
  }
  if (
    compacted.userCard?.avatarDataUrl
    && latest.userCard?.avatarDataUrl === source.userCard?.avatarDataUrl
  ) {
    assign('userCard', { ...(latest.userCard || {}), avatarDataUrl: compacted.userCard.avatarDataUrl });
  }
  for (const key of ['homePageWallpapers', 'appIcons', 'widgets']) {
    if (!(key in compacted)) continue;
    const merged = mergeCompactedImageMap(latest[key], source[key], compacted[key]);
    if (merged.changed) assign(key, merged.map);
  }
  return { changed, theme: next };
}

/** 后台收敛历史遗留的超大图；不在任何页面渲染路径上阻塞调用。 */
export async function compactOversizedAppearanceImages(options = {}) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return { changed: false };
  const { priorityActiveTheme = false, yieldEvery = 1 } = options;
  let prefs;
  try { prefs = await loadAppearancePrefs(); } catch (_) { return { changed: false }; }
  const activeId = (prefs && prefs.activeThemeId) || DEFAULT_THEME_ID;
  const themeIds = Object.keys(prefs.themes || {});
  const orderedIds = priorityActiveTheme
    ? [activeId, ...themeIds.filter((id) => id !== activeId)]
    : themeIds;

  const sourceThemes = { ...prefs.themes };
  const themePatches = {};
  let changed = false;
  let processed = 0;

  const maybeYield = async () => {
    processed += 1;
    if (yieldEvery > 0 && processed % yieldEvery === 0) await yieldAppearanceCompact(0);
  };

  for (const themeId of orderedIds) {
    const theme = sourceThemes[themeId];
    if (!theme || typeof theme !== 'object') continue;
    const patch = {};

    if (shouldCompactWallpaperDataUrl(theme.wallpaper)) {
      try {
        patch.wallpaper = await decodeAndResizeDataUrl(theme.wallpaper, { maxSize: 1600, quality: 0.82 });
        await maybeYield();
      } catch (_) {}
    }
    if (theme.homePanorama && shouldCompactWallpaperDataUrl(theme.homePanorama.src)) {
      try {
        const src = await decodeAndResizeDataUrl(theme.homePanorama.src, { maxSize: 2200, quality: 0.82 });
        patch.homePanorama = { ...theme.homePanorama, src };
        await maybeYield();
      } catch (_) {}
    }
    if (shouldCompactWallpaperDataUrl(theme.userCard?.avatarDataUrl)) {
      try {
        const avatarDataUrl = await decodeAndResizeDataUrl(theme.userCard.avatarDataUrl, { maxSize: 640, quality: 0.85 });
        patch.userCard = { ...theme.userCard, avatarDataUrl };
        await maybeYield();
      } catch (_) {}
    }
    const pages = await compactImageMapIfNeeded(
      theme.homePageWallpapers,
      () => ({ maxSize: 1600, quality: 0.82 }),
      shouldCompactWallpaperDataUrl,
    );
    if (pages.changed) patch.homePageWallpapers = pages.map;
    await maybeYield();
    const icons = await compactImageMapIfNeeded(
      theme.appIcons,
      () => ({ maxSize: 240, preserveAlpha: true }),
      shouldCompactAppIconDataUrl,
    );
    if (icons.changed) patch.appIcons = icons.map;
    await maybeYield();
    // Keep PNG/WebP widget cutouts as PNG; only opaque JPEG/etc. get recompressed to JPEG.
    const widgets = await compactImageMapIfNeeded(theme.widgets, (key, value) => {
      const preserveAlpha = WIDGET_FORCE_ALPHA_KEYS.has(key) || dataUrlIsAlphaCapable(value);
      if (preserveAlpha) {
        return {
          maxSize: WIDGET_FORCE_ALPHA_KEYS.has(key) ? 800 : 1400,
          preserveAlpha: true,
        };
      }
      return { maxSize: 1400, quality: 0.85 };
    }, shouldCompactWallpaperDataUrl);
    if (widgets.changed) patch.widgets = widgets.map;
    await maybeYield();

    if (Object.keys(patch).length) {
      themePatches[themeId] = patch;
      changed = true;
    }
  }

  if (!changed) return { changed: false };
  // 压缩期间用户可能正在美化页保存。回读最新缓存并逐字段比较原图，只合并没有
  // 被用户改过的压缩结果；同时从“活动主题一次 + 全部主题一次”收敛为一次整包写入。
  const latest = await loadAppearancePrefs();
  const nextThemes = { ...latest.themes };
  let mergedAny = false;
  for (const [themeId, patch] of Object.entries(themePatches)) {
    const merged = mergeCompactedAppearanceTheme(
      nextThemes[themeId],
      sourceThemes[themeId],
      patch,
    );
    if (!merged.changed) continue;
    nextThemes[themeId] = merged.theme;
    mergedAny = true;
  }
  if (!mergedAny) return { changed: false };
  const saved = await saveAppearancePrefs({ ...latest, themes: nextThemes });
  return { changed: true, prefs: saved };
}

export function getActiveTheme(prefs) {
  const id = (prefs && prefs.activeThemeId) || DEFAULT_THEME_ID;
  const theme = prefs && prefs.themes && prefs.themes[id];
  if (theme && theme.ready !== false) return { id, theme };
  return { id: DEFAULT_THEME_ID, theme: prefs.themes[DEFAULT_THEME_ID] };
}

export function getAppLabel(prefs, appId, fallback) {
  const { theme } = getActiveTheme(prefs);
  const labels = (theme && theme.appLabels) || {};
  return labels[appId] || fallback || DEFAULT_APP_LABELS[appId] || appId;
}

export function getWidgetValue(prefs, key, fallback) {
  const { theme } = getActiveTheme(prefs);
  const widgets = (theme && theme.widgets) || {};
  const value = widgets[key];
  if (value == null || value === '') return fallback;
  return value;
}

export function formatCalendarHeader(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y} . ${m}`;
}

export function buildCalendarCells(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = date.getDate();
  const cells = [];
  for (let i = 0; i < firstDay; i += 1) cells.push('');
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push({ day: d, marked: d === today });
  }
  return cells;
}

export { DEFAULT_APP_LABELS };

const RESERVED_THEME_IDS = new Set([DEFAULT_THEME_ID, PLACEHOLDER_THEME_ID, WINDOW_THEME_ID, ALBUM_THEME_ID]);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

/**
 * 主题快照只需要复制容器，Base64 字符串可安全共享（字符串不可变）。
 * 避免 cloneJson 为大壁纸/字体额外制造一整份 JSON 中间字符串。
 */
function cloneThemeSnapshotValue(value) {
  if (Array.isArray(value)) return value.map((item) => cloneThemeSnapshotValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      cloneThemeSnapshotValue(item),
    ]));
  }
  return value;
}

export function buildThemeSnapshot(theme) {
  const src = theme && typeof theme === 'object' ? theme : {};
  const normalizedHomeLayout = normalizeHomeLayout(src.homeLayout, src.widgetVisibility);
  const placedCustomIds = new Set(normalizedHomeLayout.pages.flat().filter((id) => normalizedHomeLayout.customItems[id]));
  const placedCustomItems = {};
  placedCustomIds.forEach((id) => {
    const item = { ...normalizedHomeLayout.customItems[id] };
    delete item.hiddenFromHome;
    delete item.storedInLibrary;
    placedCustomItems[id] = item;
  });
  const homeTemplate = src.homeTemplate === HOME_TEMPLATE_SEA || src.homeStyle === 'sea'
    ? HOME_TEMPLATE_SEA
    : src.homeTemplate === HOME_TEMPLATE_WINDOW || src.homeStyle === 'window'
      ? HOME_TEMPLATE_WINDOW
    : src.homeTemplate === HOME_TEMPLATE_ALBUM || src.homeStyle === 'album'
      ? HOME_TEMPLATE_ALBUM
    : HOME_TEMPLATE_SCRAPBOOK;
  return {
    homeTemplate,
    ...(homeTemplate === HOME_TEMPLATE_SEA ? { homeStyle: 'sea' } : {}),
    ...(homeTemplate === HOME_TEMPLATE_WINDOW ? { homeStyle: 'window' } : {}),
    ...(homeTemplate === HOME_TEMPLATE_ALBUM ? { homeStyle: 'album' } : {}),
    wallpaper: src.wallpaper,
    wallpaperOpacity: src.wallpaperOpacity,
    seaGradientOverlayEnabled: src.seaGradientOverlayEnabled,
    seaGradientWarmColor: src.seaGradientWarmColor,
    seaGradientCoolColor: src.seaGradientCoolColor,
    seaGradientStrength: src.seaGradientStrength,
    seaMusicBgColor: src.seaMusicBgColor,
    seaMusicBgOpacity: src.seaMusicBgOpacity,
    seaMusicTextColor: src.seaMusicTextColor,
    seaMusicAccentColor: src.seaMusicAccentColor,
    chatBubbleFontSize: src.chatBubbleFontSize,
    userCard: cloneThemeSnapshotValue(src.userCard || {}),
    appLabels: cloneThemeSnapshotValue(src.appLabels || {}),
    appIcons: cloneThemeSnapshotValue(src.appIcons || {}),
    appIconEdgeEnabled: src.appIconEdgeEnabled !== false,
    appIconFrameOpacity: getAppIconFrameOpacity(src),
    albumGrayFilterEnabled: src.albumGrayFilterEnabled === true,
    homePageWallpapers: cloneThemeSnapshotValue(src.homePageWallpapers || {}),
    homePanorama: src.homePanorama ? cloneThemeSnapshotValue(src.homePanorama) : null,
    widgets: cloneThemeSnapshotValue(src.widgets || {}),
    customFont: cloneThemeSnapshotValue(src.customFont || {}),
    customTheme: cloneThemeSnapshotValue(src.customTheme || { css: '', chatCss: '', homeTextVars: {} }),
    widgetVisibility: cloneThemeSnapshotValue(src.widgetVisibility || {}),
    // 主题包只携带该主题实际用到的组件；未摆放的全局组件库不跟着主题出口。
    homeLayout: cloneThemeSnapshotValue({ ...normalizedHomeLayout, customItems: placedCustomItems }),
  };
}

function slugThemePresetId(name = '') {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '')
    .slice(0, 40);
  return `theme-${base || 'preset'}-${Date.now()}`;
}

export function getThemeDisplayName(themeId, theme) {
  const name = String(theme?.name || '').trim();
  if (name) return name;
  if (themeId === DEFAULT_THEME_ID) return '棉花糖手账';
  if (themeId === PLACEHOLDER_THEME_ID) return '棉花糖之海';
  if (themeId === WINDOW_THEME_ID) return '棉花糖之窗';
  if (themeId === ALBUM_THEME_ID) return '测试优化中';
  return String(themeId || '主题');
}

export function listThemePresets(prefs) {
  const normalized = normalizePrefs(prefs);
  const activeId = normalized.activeThemeId || DEFAULT_THEME_ID;
  return Object.entries(normalized.themes)
    .filter(([, theme]) => theme && theme.ready !== false)
    .map(([id, theme]) => ({
      id,
      name: getThemeDisplayName(id, theme),
      isActive: id === activeId,
      isBuiltin: RESERVED_THEME_IDS.has(id),
      updatedAt: Number(theme.updatedAt || theme.createdAt || 0) || 0,
    }))
    .sort((a, b) => {
      if (a.id === DEFAULT_THEME_ID) return -1;
      if (b.id === DEFAULT_THEME_ID) return 1;
      return b.updatedAt - a.updatedAt;
    });
}

export async function saveCurrentThemeAsPreset(prefs, name, sourceTheme) {
  const label = String(name || '').trim();
  if (!label) throw new Error('请填写预设名称');
  const normalized = normalizePrefs(prefs);
  const snap = buildThemeSnapshot(sourceTheme || getActiveTheme(normalized).theme);
  const id = slugThemePresetId(label);
  const now = Date.now();
  const nextTheme = mergeTheme(createDefaultPrefs().themes[DEFAULT_THEME_ID], {
    ...snap,
    ready: true,
    name: label,
    createdAt: now,
    updatedAt: now,
  });
  return saveAppearancePrefs({
    ...normalized,
    themes: {
      ...normalized.themes,
      [id]: nextTheme,
    },
  });
}

/** 把导入/快照存成一个全新的美化主题预设（不覆盖当前主题），可选直接激活应用 */
export async function createThemePresetFromSnapshot(prefs, name, snapshot, options = {}) {
  const { activate = true } = options || {};
  const label = String(name || '').trim();
  if (!label) throw new Error('请填写主题名称');
  const normalized = normalizePrefs(prefs);
  const snap = buildThemeSnapshot(snapshot || {});
  const id = slugThemePresetId(label);
  const now = Date.now();
  const nextTheme = mergeTheme(createDefaultPrefs().themes[DEFAULT_THEME_ID], {
    ...snap,
    ready: true,
    name: label,
    createdAt: now,
    updatedAt: now,
  });
  const nextPrefs = mergeHomeWidgetLibraryItems({
    ...normalized,
    themes: {
      ...normalized.themes,
      [id]: nextTheme,
    },
    ...(activate ? { activeThemeId: id } : {}),
  }, snap.homeLayout?.customItems || {});
  const saved = await saveAppearancePrefs(nextPrefs);
  if (activate) applyAppearanceTheme(getActiveTheme(saved).theme);
  return { prefs: saved, id };
}

export async function switchActiveThemePreset(prefs, themeId) {
  const id = String(themeId || '').trim();
  if (!id) throw new Error('无效主题');
  const normalized = normalizePrefs(prefs);
  const theme = normalized.themes[id];
  if (!theme || theme.ready === false) throw new Error('主题不存在');
  const saved = await saveAppearancePrefs({
    ...normalized,
    activeThemeId: id,
  });
  applyAppearanceTheme(getActiveTheme(saved).theme);
  return saved;
}

export async function deleteThemePreset(prefs, themeId) {
  const id = String(themeId || '').trim();
  if (!id || RESERVED_THEME_IDS.has(id)) throw new Error('该主题不能删除');
  const normalized = normalizePrefs(prefs);
  if (!normalized.themes[id] || normalized.themes[id].ready === false) {
    throw new Error('主题不存在');
  }
  const themes = { ...normalized.themes };
  delete themes[id];
  let activeThemeId = normalized.activeThemeId;
  if (activeThemeId === id) activeThemeId = DEFAULT_THEME_ID;
  const saved = await saveAppearancePrefs({ ...normalized, themes, activeThemeId });
  applyAppearanceTheme(getActiveTheme(saved).theme);
  return saved;
}
