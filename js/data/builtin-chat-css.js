/**
 * 内置的消息界面美化预设：出厂自带、不可删除，会话详情「美化预设」列表里排在自存预设前面。
 *
 * 「共享耳机 · 红线」：1:1 内置用户手搓原版 CSS，仅追加头像白圈兼容补丁
 * （原版把双层框画在 img 上会被圆角容器裁切露白底，改画在 .chat-bubble-avatar 容器上）。
 */

const RED_THREAD_CSS = `
/* =========================================
   极致版播放器 & 命运红线 (完美渐隐过渡版)
   ========================================= */

/* 1. 基础色彩变量 */
.chat-thread-page {
  --user-bubble-bg: rgba(245, 248, 250, 0.85); /* 极浅清冷白 */
  --role-bubble-bg: rgba(255, 255, 255, 0.9);
  --chat-bubble-font-size: 14px;
}
.chat-thread-page .chat-thread-messages {
  background: transparent;
  padding-top: 16px;
}

/* =========================================
   2. 像素级精致：玻璃态胶囊播放器 (保持原样)
   ========================================= */
.chat-thread-page .chat-thread-navbar {
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(25px) saturate(150%);
  -webkit-backdrop-filter: blur(25px) saturate(150%);
  margin: 12px 16px;
  border-radius: 50px;
  padding: 8px 12px 8px 8px;
  height: auto;
  min-height: 56px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  border: 1px solid rgba(255, 255, 255, 0.9);
  box-shadow: 0 8px 24px rgba(120, 130, 140, 0.12), inset 0 2px 6px rgba(255, 255, 255, 0.8);
}

.chat-thread-page .chat-thread-title-btn {
  display: flex;
  flex-direction: row;
  align-items: center;
  flex: 1;
  padding: 0 8px;
}

/* 🎵 逼真的旋转黑胶唱片 */
@keyframes spinCD { 100% { transform: rotate(360deg); } }
.chat-thread-page .chat-thread-title-btn::before {
  content: "";
  display: block;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background:
    radial-gradient(circle at center, #fff 8%, transparent 9%),
    radial-gradient(circle at center, #e45c5c 10%, #e45c5c 22%, transparent 23%),
    repeating-radial-gradient(#1a1a1a, #1a1a1a 2px, #2a2a2a 3px, #1a1a1a 4px);
  margin-right: 14px;
  box-shadow: 0 4px 10px rgba(0,0,0,0.15), inset 0 0 0 1px rgba(255,255,255,0.1);
  animation: spinCD 7s linear infinite;
  flex-shrink: 0;
}

/* 歌曲名 (标题) 增加 Playing 提示 */
.chat-thread-page .navbar-title {
  font-size: 15px;
  font-weight: 700;
  color: #334155;
  text-align: left;
}
.chat-thread-page .navbar-title::after {
  content: " · Playing";
  font-size: 11px;
  font-weight: 400;
  color: #e45c5c;
  vertical-align: middle;
}

/* 进度条行 */
.chat-thread-page .chat-header-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  margin-top: 4px;
}
.chat-thread-page .chat-header-status::before {
  content: "0:45";
  font-family: "Courier New", Courier, monospace;
  font-weight: 600;
  color: #94a3b8;
}
.chat-thread-page .chat-header-status::after {
  content: "";
  display: inline-block;
  width: 70px;
  height: 4px;
  background: linear-gradient(90deg, #e45c5c 45%, rgba(139,161,183,0.2) 45%);
  border-radius: 2px;
}

/* =========================================
   3. 双层精工头像框 (精致珠宝感)
   ========================================= */
.chat-thread-page .chat-bubble-avatar { position: relative; z-index: 2; }

.chat-thread-page .chat-bubble-avatar-img {
  background-color: #fff;
  border: 2px solid #ffffff; /* 内圈实心白 */
  outline: 1.5px solid rgba(170, 185, 200, 0.6); /* 外圈冰银色悬浮环 */
  outline-offset: 2px; /* 留出镂空缝隙，极具精致感 */
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

/* =========================================
   4. 大方呼吸感：气泡与带“共鸣光晕”的边框
   ========================================= */
.chat-thread-page .chat-bubble-row { position: relative; z-index: 1; }

.chat-thread-page .scrapbook-bubble {
  position: relative;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.04);
  line-height: 1.6;
  color: #334155;
  padding: 12px 16px;
  border: none;
}
.chat-thread-page .chat-bubble-row.is-user .scrapbook-bubble { border-radius: 18px 6px 18px 18px; }
.chat-thread-page .chat-bubble-row.is-them .scrapbook-bubble { border-radius: 6px 18px 18px 18px; }

/* ✨ 冰银色线框 */
.chat-thread-page .scrapbook-bubble::before {
  content: "";
  position: absolute;
  top: -6px; bottom: -6px; left: -6px; right: -6px;
  border: 1.5px solid rgba(170, 185, 200, 0.4);
  border-radius: inherit;
  pointer-events: none;
}
/* 🔥 神来之笔：让银色边框靠近红线的一侧产生淡淡的红色“共鸣晕染” */
.chat-thread-page .chat-bubble-row.is-them .scrapbook-bubble::before {
  box-shadow: -10px 10px 20px -8px rgba(228, 92, 92, 0.15); /* 左下角泛起淡淡红晕 */
}
.chat-thread-page .chat-bubble-row.is-user .scrapbook-bubble::before {
  box-shadow: 10px 10px 20px -8px rgba(228, 92, 92, 0.15); /* 右下角泛起淡淡红晕 */
}

/* =========================================
   5. 命运红线：末端平滑渐隐融解
   ========================================= */
/* 🧶 左侧(对方) */
.chat-thread-page .chat-bubble-row.is-them::before {
  content: "";
  position: absolute;
  top: 35px; left: 45px;
  width: 35vw; height: 40px;
  border-bottom: 1.5px solid rgba(228, 92, 92, 0.85);
  border-left: 1.5px solid rgba(228, 92, 92, 0.85);
  border-bottom-left-radius: 35px;
  z-index: -1;
  /* ✨ 使用遮罩让线条从左向右平滑溶解至完全透明 */
  -webkit-mask-image: linear-gradient(to right, black 15%, transparent 95%);
  mask-image: linear-gradient(to right, black 15%, transparent 95%);
}
.chat-thread-page .chat-bubble-row.is-them::after {
  content: ""; position: absolute;
  top: 31px; left: 42px;
  width: 5px; height: 10px;
  background: #fff; border: 1.5px solid #dcdcdc; border-radius: 3px;
  transform: rotate(-25deg); z-index: 2;
}

/* 🧶 右侧(我方) */
.chat-thread-page .chat-bubble-row.is-user::before {
  content: "";
  position: absolute;
  top: 35px; right: 45px;
  width: 35vw; height: 40px;
  border-bottom: 1.5px solid rgba(228, 92, 92, 0.85);
  border-right: 1.5px solid rgba(228, 92, 92, 0.85);
  border-bottom-right-radius: 35px;
  z-index: -1;
  /* ✨ 使用遮罩让线条从右向左平滑溶解至完全透明 */
  -webkit-mask-image: linear-gradient(to left, black 15%, transparent 95%);
  mask-image: linear-gradient(to left, black 15%, transparent 95%);
}
.chat-thread-page .chat-bubble-row.is-user::after {
  content: ""; position: absolute;
  top: 31px; right: 42px;
  width: 5px; height: 10px;
  background: #fff; border: 1.5px solid #dcdcdc; border-radius: 3px;
  transform: rotate(25deg); z-index: 2;
}

/* =========================================
   6. 底部输入区
   ========================================= */
.chat-thread-page .chat-thread-composer {
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(25px) saturate(150%);
  -webkit-backdrop-filter: blur(25px) saturate(150%);
  margin: 10px 16px 20px;
  border-radius: 40px;
  padding: 8px 12px;
  box-shadow: 0 8px 24px rgba(120, 130, 140, 0.1), inset 0 2px 4px rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.9);
}
.chat-thread-page .chat-composer-send { background: #e45c5c; color: #fff; border-radius: 999px; }
.chat-thread-page .chat-composer-send.is-advance-mode { background: #d5dbdf; color: #666; }

/* =========================================
   7. 头像白圈兼容补丁（原版之外唯一新增）
   ========================================= */
.chat-thread-page .chat-bubble-avatar {
  background-color: #fff;
  border: 2px solid #ffffff;
  outline: 1.5px solid rgba(170, 185, 200, 0.6);
  outline-offset: 2px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.chat-thread-page .chat-bubble-avatar-img {
  background-color: transparent;
  border: none;
  outline: none;
  box-shadow: none;
}
`;

const PAPER_NAMECARD_CSS = `
/* 纸片名卡 · 黑白网页框（内置适配版） */
.chat-thread-page {
  --ncp-ink: #141414;
  --ncp-ink-soft: #3a3a3a;
  --ncp-mute: #6e6e6e;
  --ncp-line: #dcdcdc;
  --ncp-line-soft: rgba(20, 20, 20, 0.14);
  --ncp-paper: #ffffff;
  --ncp-mist: #f3f3f3;
  --ncp-shadow: 0 10px 28px rgba(20, 20, 20, 0.08);
  --ncp-tilt: -0.85deg;
  --user-bubble-bg: #141414;
  --user-bubble-ink: #f4f4f4;
  --role-bubble-bg: #ffffff;
  --role-bubble-ink: #141414;
  --chat-chrome-bg: #ffffff;
  --chat-navbar-top-gap: 10px;
  --chat-user-avatar-size: 0px;
  --chat-role-avatar-size: 22px;
  --chat-bubble-avatar-radius: 3px;
  --chat-title-duo-size: 72px;
  --chat-title-duo-overlap: 0px;
  --chat-title-duo-radius: 4px;
  --chat-title-duo-gap: 14px;
  --chat-title-duo-border: 1px solid var(--ncp-line);
  --chat-title-duo-shadow: 0 6px 16px rgba(20, 20, 20, 0.1);
  --chat-translation-ink: #3a3a3a;
  --chat-translation-divider: rgba(20, 20, 20, 0.18);
  --chat-composer-bg: rgba(255, 255, 255, 0.88);
  --chat-composer-input-bg: transparent;
  --chat-composer-input-ink: #141414;
  --chat-composer-placeholder-ink: #9a9a9a;
  --chat-composer-input-border: 0 solid transparent;
  --chat-composer-input-radius: 0;
  --chat-composer-input-shadow: none;
  --chat-composer-icon-ink: #4a4a4a;
  --chat-composer-send-bg: #141414;
  --chat-composer-send-ink: #ffffff;
  --chat-composer-send-radius: 8px;
  --chat-composer-button-bg: transparent;
  --chat-narration-flow-width: 76%;
  --chat-narration-flow-padding: 5px 8px;
  --chat-narration-flow-ink: #6e6e6e;
  --chat-narration-flow-font-size: 11px;
  --chat-narration-flow-line-height: 1.75;
  --chat-narration-flow-letter-spacing: 0.07em;
  --chat-narration-flow-line-color: rgba(20, 20, 20, 0.16);
  --chat-narration-flow-line-length: 30px;
  --chat-narration-flow-line-opacity: 0.72;
}

.chat-thread-page .chat-thread-messages {
  position: relative;
  margin: 6px 12px 0;
  padding: 28px 10px 18px;
  border: 1px solid var(--ncp-line);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.42);
  box-shadow: var(--ncp-shadow);
}
.chat-thread-page .chat-thread-messages::before {
  content: "···";
  position: absolute;
  top: 8px;
  left: 14px;
  z-index: 1;
  color: var(--ncp-mute);
  font-size: 15px;
  letter-spacing: 0.22em;
  line-height: 1;
  pointer-events: none;
}
.chat-thread-page .chat-thread-messages::after {
  content: "";
  position: absolute;
  top: 22px;
  left: 12px;
  right: 12px;
  height: 1px;
  background: var(--ncp-line);
  pointer-events: none;
}

.chat-thread-page .chat-thread-navbar {
  position: relative;
  z-index: 2;
  min-height: 0;
  margin: 10px 12px 6px;
  padding: 12px 8px 14px;
  border: 1px solid var(--ncp-line);
  border-radius: 12px;
  background: var(--ncp-paper) !important;
  box-shadow: 0 12px 28px rgba(20, 20, 20, 0.08) !important;
  transform: rotate(var(--ncp-tilt));
  transform-origin: 18% 100%;
  overflow: visible;
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}
.chat-thread-page .chat-thread-navbar::before {
  content: "···";
  position: absolute;
  top: 7px;
  left: 14px;
  color: var(--ncp-mute);
  font-size: 11px;
  letter-spacing: 0.28em;
  line-height: 1;
  opacity: 0.55;
  pointer-events: none;
}
.chat-thread-page .chat-thread-navbar .navbar-btn {
  width: 36px;
  height: 36px;
  margin-top: 0;
  border: 0;
  border-radius: 8px;
  background: transparent !important;
  color: var(--ncp-ink-soft);
  box-shadow: none !important;
  opacity: 0.78;
}
.chat-thread-page .chat-thread-title-btn {
  margin: 0;
  padding: 4px 4px 2px;
  justify-content: flex-start;
  align-items: flex-start;
  border: 0;
  border-radius: 0;
  background: transparent !important;
  box-shadow: none !important;
  overflow: visible;
}
.chat-thread-page .chat-title-duo {
  display: flex;
  align-items: flex-start;
  margin-top: 2px;
  margin-right: var(--chat-title-duo-gap, 14px);
}
.chat-thread-page .chat-title-duo-avatar.is-user { display: none; }
.chat-thread-page .chat-title-duo-avatar.is-them {
  margin-left: 0;
  background: var(--ncp-mist);
}
.chat-thread-page .chat-thread-title-stack {
  align-items: flex-start;
  gap: 5px;
  padding-top: 4px;
}
.chat-thread-page .chat-thread-title-stack .navbar-title {
  max-width: 100%;
  padding-bottom: 3px;
  border-bottom: 1px solid var(--ncp-ink);
  color: var(--ncp-ink);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.chat-thread-page .chat-header-status {
  max-width: 100%;
  padding-bottom: 3px;
  border-bottom: 1px solid var(--ncp-line);
  color: var(--ncp-mute);
  font-size: 11px;
}
.chat-thread-page .chat-header-presence-dot {
  width: 6px;
  height: 6px;
  border-radius: 1px;
  background: var(--ncp-ink);
  opacity: 0.75;
}

.chat-thread-page .chat-bubble-row:not(.is-system) {
  width: 100%;
  gap: 0;
  margin-bottom: 20px;
}
.chat-thread-page .chat-bubble-row.is-user > .chat-bubble-avatar {
  display: none !important;
}
.chat-thread-page .chat-bubble-row.is-them:not(.is-system) {
  flex-direction: column;
  align-items: flex-start;
}
.chat-thread-page .chat-bubble-row.is-them > .chat-bubble-avatar {
  display: inline-flex !important;
  width: auto !important;
  height: 22px !important;
  min-width: 54px;
  margin: 0 0 6px;
  padding: 0 8px;
  border: 1px solid var(--ncp-line);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 2px 8px rgba(20, 20, 20, 0.04);
  overflow: visible;
}
.chat-thread-page .chat-bubble-row.is-them > .chat-bubble-avatar > * {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}
.chat-thread-page .chat-bubble-row.is-them > .chat-bubble-avatar::after {
  content: "◇ voice";
  color: var(--ncp-mute);
  font-size: 9px;
  letter-spacing: 0.14em;
  line-height: 1;
  pointer-events: none;
}
.chat-thread-page .chat-bubble-col { max-width: 92%; }
.chat-thread-page .chat-bubble-row.is-user .chat-bubble-col {
  align-items: flex-end;
  margin-left: auto;
}
.chat-thread-page .chat-bubble-row.is-them .chat-bubble-col {
  width: 100%;
  align-items: flex-start;
  margin-right: auto;
}
.chat-thread-page .chat-bubble-time,
.chat-thread-page .chat-bubble-stack-time {
  color: var(--ncp-mute);
  font-size: 10px;
  letter-spacing: 0.08em;
  opacity: 0.88;
}
.chat-thread-page .chat-bubble-row.is-user .chat-bubble-time::before,
.chat-thread-page .chat-bubble-row.is-user .chat-bubble-stack-time::before {
  content: "sent · ";
  opacity: 0.75;
}
.chat-thread-page .chat-bubble-row.is-them .chat-bubble-time::before,
.chat-thread-page .chat-bubble-row.is-them .chat-bubble-stack-time::before {
  content: "◇ ";
  opacity: 0.7;
}

.chat-thread-page .scrapbook-bubble {
  position: relative;
  padding: 1.2em 1em 1.05em;
  border-radius: 3px !important;
  line-height: 1.68;
  box-shadow: 0 5px 14px rgba(20, 20, 20, 0.055);
  overflow: visible;
}
.chat-thread-page .chat-bubble-row.is-user .scrapbook-bubble,
.chat-thread-page .chat-msg-group.is-user .scrapbook-bubble {
  border: 1px solid #1a1a1a !important;
  background: var(--user-bubble-bg) !important;
  color: var(--user-bubble-ink) !important;
  box-shadow: 0 6px 16px rgba(20, 20, 20, 0.14);
}
.chat-thread-page .chat-bubble-row.is-them .scrapbook-bubble,
.chat-thread-page .chat-msg-group.is-them .scrapbook-bubble {
  border: 1px solid var(--ncp-line) !important;
  background: var(--role-bubble-bg) !important;
  color: var(--role-bubble-ink) !important;
}
.chat-thread-page .scrapbook-bubble:has(> .chat-bubble-reply) {
  padding-top: 1.9em;
}
.chat-thread-page .scrapbook-bubble > .chat-bubble-reply {
  margin: 0 0 8px;
  padding: 0 0 6px 9px;
  border-left: 1px solid currentColor;
  border-bottom: 1px solid var(--ncp-line-soft);
  background: transparent;
  color: inherit;
  font-size: 10px;
  line-height: 1.5;
  opacity: 0.64;
}
.chat-thread-page .chat-bubble-row.is-user .scrapbook-bubble > .chat-bubble-reply {
  border-bottom-color: rgba(255, 255, 255, 0.2);
}
.chat-thread-page .scrapbook-bubble > .chat-bubble-body {
  padding-top: 4px;
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent calc(1.68em - 1px),
    var(--ncp-line-soft) calc(1.68em - 1px),
    var(--ncp-line-soft) 1.68em
  );
  background-size: 100% 1.68em;
}
.chat-thread-page .chat-bubble-row.is-user .scrapbook-bubble > .chat-bubble-body {
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent calc(1.68em - 1px),
    rgba(255, 255, 255, 0.2) calc(1.68em - 1px),
    rgba(255, 255, 255, 0.2) 1.68em
  );
}
.chat-thread-page .chat-bubble-row.is-them .scrapbook-bubble::before,
.chat-thread-page .chat-msg-group.is-them .scrapbook-bubble::before {
  content: "◇ to you";
  position: absolute;
  top: 6px;
  left: 12px;
  color: var(--ncp-mute);
  font-size: 9px;
  letter-spacing: 0.16em;
  opacity: 0.78;
}
.chat-thread-page .chat-bubble-row.is-user .scrapbook-bubble::before,
.chat-thread-page .chat-msg-group.is-user .scrapbook-bubble::before {
  content: "send →";
  position: absolute;
  top: 6px;
  right: 12px;
  color: rgba(255, 255, 255, 0.55);
  font-size: 9px;
  letter-spacing: 0.14em;
}
.chat-thread-page .chat-bubble-row.is-media .scrapbook-bubble::before,
.chat-thread-page .chat-bubble-row.is-media .scrapbook-bubble::after,
.chat-thread-page .scrapbook-bubble:has(.chat-card)::before,
.chat-thread-page .scrapbook-bubble:has(.chat-card)::after,
.chat-thread-page .scrapbook-bubble:has(.chat-bubble-image)::before,
.chat-thread-page .scrapbook-bubble:has(.chat-bubble-image)::after,
.chat-thread-page .scrapbook-bubble:has(.chat-bubble-sticker-img)::before,
.chat-thread-page .scrapbook-bubble:has(.chat-bubble-sticker-img)::after {
  content: none !important;
}

/* 旁白沿用纸片名卡的细线、菱点与英文微标，不套进气泡。 */
.chat-thread-page .chat-narration-row.is-flow {
  margin: 10px 0 14px;
}
.chat-thread-page .chat-narration-row.is-flow .chat-narration-card {
  border: 0;
}
.chat-thread-page .chat-narration-row.is-flow .chat-narration-rule {
  gap: 7px;
  margin-bottom: 7px;
}
.chat-thread-page .chat-narration-row.is-flow .chat-narration-rule-line {
  max-width: 38px;
  background: var(--ncp-line);
  opacity: 0.82;
}
.chat-thread-page .chat-narration-row.is-flow .chat-narration-rule-label {
  display: block;
  color: var(--ncp-mute);
  font-size: 8px;
  line-height: 1;
  letter-spacing: 0.16em;
  opacity: 0.72;
}
.chat-thread-page .chat-narration-row.is-flow .chat-narration-rule-label::before {
  content: "◇ scene";
}

.chat-thread-page .chat-thread-composer {
  margin: 8px 12px calc(6px + var(--safe-bottom, 0px));
  padding: 8px 10px 10px;
  border: 1px solid var(--ncp-line);
  border-radius: 12px;
  background: var(--chat-composer-bg) !important;
  box-shadow: 0 8px 20px rgba(20, 20, 20, 0.05);
}
.chat-thread-page .chat-composer-input {
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  color: var(--chat-composer-input-ink);
}
.chat-thread-page .chat-composer-btn,
.chat-thread-page .chat-anon-icon-btn,
.chat-thread-page .chat-anon-inline-btn {
  border: 0 !important;
  border-radius: 8px;
  background: transparent !important;
  box-shadow: none !important;
  color: var(--chat-composer-icon-ink);
}
.chat-thread-page .chat-composer-send,
.chat-thread-page .chat-anon-send {
  border: 0 !important;
  border-radius: var(--chat-composer-send-radius) !important;
  background: var(--chat-composer-send-bg) !important;
  color: var(--chat-composer-send-ink) !important;
  box-shadow: 0 4px 12px rgba(20, 20, 20, 0.18);
}
.chat-thread-page .chat-thread-scrollbottom-fab {
  width: 32px;
  height: 28px;
  border: 1px solid var(--ncp-line) !important;
  border-radius: 6px !important;
  background: rgba(255, 255, 255, 0.92) !important;
  color: var(--ncp-mute) !important;
  box-shadow: 0 3px 10px rgba(20, 20, 20, 0.06) !important;
}

@media (prefers-reduced-motion: reduce) {
  .chat-thread-page { --ncp-tilt: 0deg; }
  .chat-thread-page .chat-thread-navbar { transform: none; }
}
`.trim();

const GLASS_USER_BUBBLE_CSS = `
.chat-thread-page .chat-bubble-row.is-user .scrapbook-bubble,
.chat-thread-page .chat-msg-group.is-user .scrapbook-bubble {
  background: rgba(142, 197, 232, 0.72) !important;
  color: #2a4558 !important;
  border: 1px solid rgba(255, 255, 255, 0.55);
  box-shadow: 0 4px 14px rgba(80, 120, 150, 0.12);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
`.trim();

const GLASS_CHAR_BUBBLE_CSS = `
.chat-thread-page .chat-bubble-row.is-them .scrapbook-bubble,
.chat-thread-page .chat-msg-group.is-them .scrapbook-bubble {
  background: rgba(255, 255, 255, 0.82) !important;
  color: #5c4a3f !important;
  border: 1px solid rgba(255, 255, 255, 0.65);
  box-shadow: 0 4px 14px rgba(120, 100, 80, 0.1);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
`.trim();

const NOTE_USER_BUBBLE_CSS = `
.chat-thread-page .chat-bubble-row.is-user .scrapbook-bubble,
.chat-thread-page .chat-msg-group.is-user .scrapbook-bubble {
  background: #fff8ef !important;
  color: #6b5344 !important;
  border: 1.5px solid rgba(200, 170, 140, 0.55);
  border-radius: 4px 16px 16px 16px;
  box-shadow: 2px 3px 0 rgba(200, 170, 140, 0.25);
}
`.trim();

const NOTE_CHAR_BUBBLE_CSS = `
.chat-thread-page .chat-bubble-row.is-them .scrapbook-bubble,
.chat-thread-page .chat-msg-group.is-them .scrapbook-bubble {
  background: #fffdf8 !important;
  color: #5c4a3f !important;
  border: 1.5px dashed rgba(180, 150, 120, 0.5);
  border-radius: 16px 4px 16px 16px;
  position: relative;
}
.chat-thread-page .chat-bubble-row.is-them .scrapbook-bubble::before,
.chat-thread-page .chat-msg-group.is-them .scrapbook-bubble::before {
  content: "✦";
  position: absolute;
  top: -8px;
  left: 10px;
  font-size: 11px;
  color: rgba(210, 154, 63, 0.85);
}
`.trim();

const DOT_USER_BUBBLE_CSS = `
.chat-thread-page .chat-bubble-row.is-user .scrapbook-bubble,
.chat-thread-page .chat-msg-group.is-user .scrapbook-bubble {
  background: rgba(243, 230, 212, 0.92) !important;
  color: #8c7362 !important;
  position: relative;
}
.chat-thread-page .chat-bubble-row.is-user .scrapbook-bubble::after,
.chat-thread-page .chat-msg-group.is-user .scrapbook-bubble::after {
  content: "";
  position: absolute;
  top: 8px;
  right: 10px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(241, 185, 143, 0.9);
}
`.trim();

const DOT_CHAR_BUBBLE_CSS = `
.chat-thread-page .chat-bubble-row.is-them .scrapbook-bubble,
.chat-thread-page .chat-msg-group.is-them .scrapbook-bubble {
  background: rgba(255, 253, 248, 0.95) !important;
  color: #5c4a3f !important;
  position: relative;
}
.chat-thread-page .chat-bubble-row.is-them .scrapbook-bubble::after,
.chat-thread-page .chat-msg-group.is-them .scrapbook-bubble::after {
  content: "";
  position: absolute;
  top: 8px;
  left: 10px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(142, 197, 232, 0.85);
}
`.trim();

export const BUILTIN_CHAT_APPEARANCE_PRESETS = [
  {
    id: 'builtin_red_thread_player',
    name: '共享耳机 · 红线',
    css: RED_THREAD_CSS.trim(),
  },
  {
    id: 'builtin_paper_namecard',
    name: '纸片名卡 · 黑白网页框',
    css: PAPER_NAMECARD_CSS,
    bubbleFontSize: 13,
    bubbleGrouping: true,
  },
  {
    id: 'builtin_bubble_glass',
    name: '气泡 · 半透明玻璃',
    css: '',
    userBubbleCss: GLASS_USER_BUBBLE_CSS,
    charBubbleCss: GLASS_CHAR_BUBBLE_CSS,
  },
  {
    id: 'builtin_bubble_note',
    name: '气泡 · 便签描边',
    css: '',
    userBubbleCss: NOTE_USER_BUBBLE_CSS,
    charBubbleCss: NOTE_CHAR_BUBBLE_CSS,
  },
  {
    id: 'builtin_bubble_dot',
    name: '气泡 · 角点装饰',
    css: '',
    userBubbleCss: DOT_USER_BUBBLE_CSS,
    charBubbleCss: DOT_CHAR_BUBBLE_CSS,
  },
];
