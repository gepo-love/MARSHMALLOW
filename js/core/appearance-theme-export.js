import {
  getActiveTheme,
  normalizePrefs,
  saveAppearancePrefs,
  applyAppearanceTheme,
  createDefaultPrefs,
  isSeaHomeTheme,
  isWindowHomeTheme,
  mergeTheme,
  clampChatBubbleFontSize,
  buildThemeSnapshot,
  getThemeDisplayName,
  getHomeWidgetSlotsForTheme,
  getThemeResetDefaults,
  mergeHomeWidgetLibraryItems,
} from './appearance-prefs.js';
import { downloadText } from './native-download.js';
import {
  beginNativeChunkedTextSave,
  supportsChunkedNativeSave,
} from './native-file-export.js';
import { appendJsonValueToWriter } from './backup-json-stream.js';
import { localizeBeautifyRemoteCssImages } from './beautify-assets.js';
import {
  HOME_THEME_TEXT_VARS_BY_TEMPLATE,
  HOME_WIDGET_SLOTS,
  APPEARANCE_PAGE_CLASSES,
  APPEARANCE_COMPONENT_CLASSES,
  CHAT_APPEARANCE_CLASSES,
  CHAT_APPEARANCE_VARS,
  SEA_HOME_CLASSES,
  WINDOW_HOME_CLASSES,
  THEME_EXPORT_TYPE,
  THEME_EXPORT_VERSION,
} from '../data/appearance-theme-contract.js';

export { THEME_EXPORT_TYPE, THEME_EXPORT_VERSION, buildThemeSnapshot };

/** 从 AI 回复 / 粘贴文本中解析主题包 JSON */
export function parseThemeImportText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('没有可导入的内容');

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
      const parsed = JSON.parse(candidate);
      return normalizeThemeImportPayload(parsed);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`JSON 解析失败：${String(lastError?.message || lastError || '格式不正确').slice(0, 80)}`);
}

export function normalizeThemeImportPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('不是有效的主题数据');
  }
  if (payload.type === THEME_EXPORT_TYPE && payload.theme) {
    return payload;
  }
  if (payload.theme && typeof payload.theme === 'object' && !payload.type) {
    return {
      type: THEME_EXPORT_TYPE,
      version: THEME_EXPORT_VERSION,
      theme: payload.theme,
    };
  }
  if (payload.customTheme || payload.wallpaper != null || payload.appIcons || payload.widgetVisibility) {
    return {
      type: THEME_EXPORT_TYPE,
      version: THEME_EXPORT_VERSION,
      theme: payload,
    };
  }
  throw new Error('不是棉花糖机主题包（需含 type 或 theme 字段）');
}

export function buildThemeExportPayload(prefs) {
  // 设置页持有的 prefs 本身已经过 normalizePrefs。这里若再规范化一次，
  // 会把所有主题（包括 Base64 壁纸、图标和字体）都复制一遍，而实际只导出当前主题。
  // 仅对非法/未初始化输入走旧的完整归一化兜底。
  const hasStoredThemes = !!(prefs && prefs.themes && typeof prefs.themes === 'object');
  const active = hasStoredThemes ? getActiveTheme(prefs) : null;
  const normalized = active?.theme && active.theme.ready !== false
    ? prefs
    : normalizePrefs(prefs);
  const { id, theme } = getActiveTheme(normalized);
  const activeName = getThemeDisplayName(id, theme);
  // 字体是设备级个人资源，体积通常远大于主题本身，也可能带有不可转授权的字体文件。
  // 导出主题时保留接收方现有字体，不把 customFont 写进可分享包。
  const { customFont: _customFont, ...portableTheme } = buildThemeSnapshot(theme);
  return {
    type: THEME_EXPORT_TYPE,
    version: THEME_EXPORT_VERSION,
    exportedAt: Date.now(),
    themeId: id,
    themeName: activeName,
    theme: portableTheme,
  };
}

export async function buildPortableThemeExportPayload(prefs) {
  const payload = buildThemeExportPayload(prefs);
  const customTheme = payload.theme?.customTheme;
  if (!customTheme || typeof customTheme !== 'object') return payload;
  const portable = { ...customTheme };
  for (const key of ['css', 'chatCss']) {
    if (typeof portable[key] === 'string') {
      portable[key] = await localizeBeautifyRemoteCssImages(portable[key]);
    }
  }
  for (const key of ['pageCss', 'pageDarkCss']) {
    if (!portable[key] || typeof portable[key] !== 'object') continue;
    const localizedPages = {};
    // 页级 CSS 可能各自带多张大图；顺序固化可避免一次在 WebView 内存里展开整套图片。
    for (const [page, css] of Object.entries(portable[key])) {
      localizedPages[page] = await localizeBeautifyRemoteCssImages(css);
    }
    portable[key] = localizedPages;
  }
  payload.theme.customTheme = portable;
  return payload;
}

export async function importThemeExportPayload(payload, prefs) {
  const normalizedPayload = normalizeThemeImportPayload(payload);
  return applyThemeSnapshotToPrefs(normalizedPayload.theme, prefs);
}

export async function importThemeImportText(text, prefs) {
  const payload = parseThemeImportText(text);
  return importThemeExportPayload(payload, prefs);
}

export async function restoreDefaultAppearanceTheme(prefs) {
  const normalized = normalizePrefs(prefs);
  const { id, theme } = getActiveTheme(normalized);
  const defaultTheme = getThemeResetDefaults(id, theme);
  // 用户另存或导入的主题仍保留预设身份；恢复的是外观内容，不应让主题在列表里改名。
  const presetIdentity = id in createDefaultPrefs().themes
    ? {}
    : {
        name: theme?.name,
        createdAt: theme?.createdAt,
        updatedAt: Date.now(),
      };
  const next = {
    ...normalized,
    themes: {
      ...normalized.themes,
      [id]: mergeTheme(defaultTheme, { ready: true, ...presetIdentity }),
    },
  };
  const saved = await saveAppearancePrefs(next);
  applyAppearanceTheme(getActiveTheme(saved).theme);
  return saved;
}

async function applyThemeSnapshotToPrefs(snap, prefs) {
  if (!snap || typeof snap !== 'object') {
    throw new Error('主题包缺少 theme 字段');
  }
  const normalized = normalizePrefs(prefs);
  const { id, theme } = getActiveTheme(normalized);
  const merged = {
    ...theme,
    ...snap,
    userCard: { ...(theme.userCard || {}), ...(snap.userCard || {}) },
    appLabels: { ...(theme.appLabels || {}), ...(snap.appLabels || {}) },
    appIcons: { ...(theme.appIcons || {}), ...(snap.appIcons || {}) },
    widgets: { ...(theme.widgets || {}), ...(snap.widgets || {}) },
    customFont: { ...(theme.customFont || {}), ...(snap.customFont || {}) },
    customTheme: {
      css: '',
      chatCss: '',
      cssVars: {},
      homeTextVars: {},
      ...(theme.customTheme || {}),
      ...(snap.customTheme || {}),
      homeTextVars: {
        ...((theme.customTheme && theme.customTheme.homeTextVars) || {}),
        ...((snap.customTheme && snap.customTheme.homeTextVars) || {}),
      },
    },
    widgetVisibility: {
      ...(theme.widgetVisibility || {}),
      ...(snap.widgetVisibility || {}),
    },
    homeLayout: snap.homeLayout || theme.homeLayout,
  };
  if (snap.chatBubbleFontSize != null) {
    merged.chatBubbleFontSize = clampChatBubbleFontSize(snap.chatBubbleFontSize);
  }
  const next = mergeHomeWidgetLibraryItems({
    ...normalized,
    themes: {
      ...normalized.themes,
      [id]: merged,
    },
  }, snap.homeLayout?.customItems || {});
  const saved = await saveAppearancePrefs(next);
  applyAppearanceTheme(getActiveTheme(saved).theme);
  return saved;
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

const SEA_WIDGET_SELECTORS = {
  seaHero: '.home-sea-shell .sea-top-block',
  seaPortrait: '.home-sea-shell .sea-portrait',
  seaMusicP1: '.home-sea-shell .sea-ambient .sea-music',
  seaMusicP2: '.home-sea-shell .sea-page-two .sea-music',
  seaCharGallery: '.home-sea-shell .sea-photo-tall',
  seaFloatNote: '.home-sea-shell .sea-p2-mid',
  seaAtmo: '.home-sea-shell .sea-atmo',
  seaStreaks: '.home-sea-shell .sea-streak-bars',
  seaPolaroid: '.home-sea-shell .sea-p3-polaroid',
  seaPostcard: '.home-sea-shell .sea-p3-postcard',
};

const WINDOW_WIDGET_SELECTORS = {
  userHeader: '.home-window-shell .mw-clock',
  polaroidP1: '.home-window-shell .mw-circle',
  polaroidP3: '.home-window-shell .mw-portrait',
  filmWidget: '.home-window-shell .mw-music-sq',
};

/** 供用户下载、交给 AI 改写的 CSS 参考文档：只讲类名 + 变量 + 示例，不涉及 JSON 主题包结构 */
export function buildAiThemeReferenceMarkdown(options = {}) {
  const theme = options.theme || null;
  const isSea = isSeaHomeTheme(options.themeId, theme);
  const isWindow = isWindowHomeTheme(options.themeId, theme);
  const templateId = isSea ? 'sea' : (isWindow ? 'window' : 'scrapbook');
  const homeTextDefs = HOME_THEME_TEXT_VARS_BY_TEMPLATE[templateId] || HOME_THEME_TEXT_VARS_BY_TEMPLATE.scrapbook;
  const tokenRows = homeTextDefs.map((item) => [
    `\`${item.key}\``,
    item.label,
    `\`${item.default}\``,
  ]);
  const pageRows = APPEARANCE_PAGE_CLASSES.map((item) => [`\`${item.cls}\``, item.label]);
  const activeWidgetSlots = getHomeWidgetSlotsForTheme(options.themeId || '', theme);
  const widgetRows = isSea
    ? activeWidgetSlots.map((item) => [item.label, `\`${SEA_WIDGET_SELECTORS[item.id] || '.home-sea-shell'}\``])
    : isWindow
      ? activeWidgetSlots.map((item) => [item.label, `\`${WINDOW_WIDGET_SELECTORS[item.id] || '.home-window-shell'}\``])
    : HOME_WIDGET_SLOTS.map((item) => [item.label, `\`.home-shell-page [${item.hook}]\``]);
  const componentRows = APPEARANCE_COMPONENT_CLASSES.map((item) => [`\`${item.cls}\``, item.label]);
  const chatRows = CHAT_APPEARANCE_CLASSES.map((item) => [`\`${item.cls}\``, item.label]);
  const chatVarRows = CHAT_APPEARANCE_VARS.map((item) => [`\`${item.key}\``, item.label]);
  const seaRows = SEA_HOME_CLASSES.map((item) => [`\`${item.cls}\``, item.label]);
  const windowRows = WINDOW_HOME_CLASSES.map((item) => [`\`${item.cls}\``, item.label]);
  const homeChromeRows = templateId === 'sea'
    ? [
      ['`.home-sea-shell::before`', '整屏渐变遮罩；Dock 下方色带也来自这里', '改 `background` / `opacity`'],
      ['`.home-sea-shell .sea-bottom`', '页码点与 Dock 的底部容器', '改 `padding`；保留安全区'],
      ['`.home-sea-shell .sea-dock`', 'Dock 玻璃外壳', '改背景、边框、阴影、圆角'],
    ]
    : templateId === 'window'
      ? [
        ['`.home-window-shell::before`', '整屏柔光面纱', '改 `background` / `opacity`'],
        ['`.home-window-shell .mw-bar-bottom`', 'Dock 下方固定白色窗台', '改背景、阴影或高度'],
        ['`.home-window-shell .mw-bottom`', '页码点与 Dock 的底部容器', '改 `padding`；保留安全区'],
        ['`.home-window-shell .mw-dock`', 'Dock 玻璃外壳', '改背景、边框、模糊'],
      ]
      : [
        ['`.home-shell-page .home-wallpaper-overlay`', '壁纸颜色遮罩（运行时内联背景）', '改 `background` 时加 `!important`'],
        ['`.home-shell-page .home-bottom-chrome`', '页码点与 Dock 的底部容器', '改 `padding`；保留安全区'],
        ['`.home-shell-page .home-dock`', 'Dock 外壳（同时带 `.dock`）', '改背景、边框、阴影、圆角'],
      ];
  const homeChromeExample = templateId === 'sea'
    ? `.home-sea-shell::before {
  background: none;
  opacity: 0;
}
.home-sea-shell .sea-dock {
  background: rgba(255, 255, 255, 0.24);
  border: 0;
  box-shadow: none;
}`
    : templateId === 'window'
      ? `.home-window-shell .mw-bar-bottom {
  background: transparent;
  box-shadow: none;
}
.home-window-shell::before {
  background: none;
  opacity: 0;
}
.home-window-shell .mw-dock {
  background: rgba(255, 255, 255, 0.24);
}`
      : `.home-shell-page .home-wallpaper-overlay {
  background: transparent !important;
}
.home-shell-page .home-dock {
  background: rgba(255, 255, 255, 0.24);
  border: 0;
  box-shadow: none;
}`;

  return `# 棉花糖机 · 全局美化 CSS 契约

> 本文只提供输出格式、结构选项、真实选择器与约束，不提供成品样式或当前样式。请依据用户参考图独立设计，不要自行套用固定构图。
> 生成时间：${new Date().toISOString()}

## 输出格式

- 只输出可直接导入的 CSS，不输出 HTML、JavaScript、JSON 或教程说明。
- 按“全局 token → 主屏壳 → 组件 → 内页 → 消息界面 → 响应式与减弱动效”的顺序分段。
- 每段只包含用户已选择的范围；未选择的主题、组件和头像结构不要预写备用规则。
- 页面规则使用对应根类名限定作用域，不用无范围的元素选择器污染其它页面。
- 保留导航、输入、滚动、按钮点击和键盘焦点，不以装饰覆盖交互层。

## 写在哪里与覆盖顺序

- **美化工作室 → 主屏**：发布时会自动限定到主屏并提升选择器权重，适合只改主屏；通常不需要 \`!important\`。
- **美化设置 → 自定义 CSS（主屏与全局）**：保留原始 CSS 与原始权重，适合跨页面 token 和全局组件；主屏规则请写完整主题根类（如当前的 \`${templateId === 'sea' ? '.home-sea-shell' : templateId === 'window' ? '.home-window-shell' : '.home-shell-page'}\`），被复合选择器或内联样式盖住时再局部使用 \`!important\`。
- 不要给整段 CSS 的所有声明统一加 \`!important\`。壁纸遮罩的内联背景、用户明确要接管的旧主题强制视觉可以局部加；安全区、拖拽层级、点击和滚动规则不要强压。
- 触屏设备与 Android 原生壳会主动关闭部分实时 \`backdrop-filter\`，这是滑屏性能兜底。不要为了恢复毛玻璃强行覆盖这类平台规则；可改用更实的半透明背景模拟玻璃。
- \`:root\`、\`html\`、\`body\` 是文档级选择器。页面专用 CSS 若把布局或颜色直接写在这些选择器上，可能影响其它页面；页面 token 优先写在当前主题根类上。

## 生成前必须选择

${mdTable(
    ['项目', '可选项', '规则'],
    [
      ['作用范围', '主屏 / 全部内页 / 指定页面 / 消息界面', '未明确时只改用户点名的范围'],
      ['主屏模板', '手账 / 海 / 窗', `当前模板为 ${templateId}，只使用对应 DOM`],
      ['主屏组件', '保留全部 / 隐藏指定装饰组件', 'App 网格、Dock、入口数量与路由不可改'],
      ['消息头像', '双方显示 / 仅对方 / 仅我方 / 隐藏', '不要自动开启顶栏头像'],
      ['顶栏头像', '无头像 / 单枚对方头像 / 双头像', '仅单聊提供头像槽；默认无头像'],
      ['主题适配', '全部主题通用 / 仅当前主题 / 匿名区独立', '优先公开变量，必要时才用修饰类'],
      ['资源处理', '沿用现有资源 / 用户另行上传', 'CSS 文档不虚构图片地址、字体文件或动态数据'],
    ],
  )}

## 主屏字色变量（仅作用于桌面主屏壳，不写入 :root）

${mdTable(['变量', '含义', '默认'], tokenRows)}

## 内页根类名（CSS 作用域）

${mdTable(['选择器', '页面'], pageRows)}
${isSea ? `
### 棉花糖之海 · 主屏专用类名

> 当前是「棉花糖之海」模板：主屏走独立 DOM（不是 \`.home-shell-page\`），请只用下面这套类名。

${mdTable(['选择器', '说明'], seaRows)}
` : ''}
${isWindow ? `
### 棉花糖之窗 · 主屏专用类名

> 当前是「棉花糖之窗」模板：主屏走独立 DOM（不是默认手账模板，也不是海模板），请只用下面这套类名。

${mdTable(['选择器', '说明'], windowRows)}
` : ''}
## 当前主屏的 Dock 与遮罩速查

${mdTable(['选择器', '控制内容', '建议修改'], homeChromeRows)}

下面只是“命中正确层级”的中性覆盖示例，不是成品主题；保留或删除其中每条属性应以用户目标为准。

\`\`\`css
${homeChromeExample}
\`\`\`

> Dock 下方并非三套主题共用同一个遮罩：海主题的底部色带属于整屏 \`.home-sea-shell::before\`；窗主题有独立的 \`.mw-bar-bottom\`；手账主题的壁纸遮罩是带内联背景的 \`.home-wallpaper-overlay\`。

## 消息界面（聊天对话页 · 真实类名）

> 注意是 \`.scrapbook-bubble\` + \`.is-user\`/\`.is-them\`，不是 \`.chat-bubble\`/\`.is-self\`。

${mdTable(['选择器', '含义'], chatRows)}

${mdTable(['变量', '含义'], chatVarRows)}

> 这里的「消息界面 · 全局 CSS」作用于全部会话，但单个会话自己的整页/气泡 CSS 会在它之后生效。完整优先级为：**本会话气泡 CSS > 本会话整页 CSS > 公开气泡变量 > 本会话取色 > 全局消息 CSS > 档案色 > 主题默认**。改气泡色请写：\`.chat-thread-page{--user-bubble-bg:…;--role-bubble-bg:…;--user-bubble-ink:…;--role-bubble-ink:…;}\`（必须带选择器；不要只写 \`background\`，容易被主题规则盖住并回落到用户档案色）。

> **头像大小**请写变量（\`--chat-bubble-avatar-size\` / \`--chat-user-avatar-size\` / \`--chat-role-avatar-size\` / \`--chat-bubble-avatar-radius\`），不要直接写 \`.chat-bubble-avatar{width:…}\`——窗/匿名等主题内置规则选择器权重更高，直接写宽高容易被盖回。
> **气泡密度**可写 \`--chat-bubble-row-gap\`、\`--chat-bubble-row-spacing\`、\`--chat-bubble-padding\`、\`--chat-bubble-line-height\` 与 \`--chat-bubble-stack-gap\`；原皮只提供默认值，不会用 \`!important\` 抢用户 CSS 的布局。

> **外语翻译**可写变量（\`--chat-translation-ink\` / \`--chat-translation-font-size\` / \`--chat-translate-btn-ink\` / \`--chat-translate-btn-font-size\` / \`--chat-translation-divider\`），或用 \`.chat-bubble-translate-btn\` / \`.chat-bubble-translation-text\` / \`.voice-msg-translation\` 等选择器细调。

### 顶栏结构与异形延展

\`\`\`text
div.chat-thread-safe-top（系统状态栏占位，不参与美化）
header.chat-thread-navbar
├─ button.navbar-btn（返回）
├─ button.chat-thread-title-btn
│  ├─ span.chat-title-duo（单聊可选，默认隐藏）
│  └─ div.chat-thread-title-stack（标题 / 状态 / 时区）
└─ button.navbar-btn（设置）
\`\`\`

> 系统状态栏由 \`.chat-thread-safe-top\` 独立避让，不要隐藏、定位或美化它，也不要再把 \`var(--safe-top)\` 叠进顶栏。全宽矩形顶栏的最终背景会自动延伸到状态栏区域，即使没有设置聊天壁纸也会融合；异形、顶部圆角、裁剪或横向内收的顶栏则保留独立安全区。只向下延展时，增加 \`.chat-thread-navbar\` 的 \`min-height\` / \`padding-bottom\`，再用不对称圆角、\`clip-path\` 或顶栏自身的 \`::before/::after\` 塑形。不要用负 \`margin-top\` / \`translateY\` 顶进状态栏；装饰伪元素加 \`pointer-events:none\`。
> 顶栏头像不是必选项。默认保持隐藏；单大头像可显示 \`.chat-title-duo\` 后隐藏 \`.chat-title-duo-avatar.is-user\`，双头像仅在设计明确需要时开启。

> 会话壁纸位于独立的 \`.chat-thread-wallpaper-layer\` 底层，内部是 \`.chat-thread-wallpaper-img\` 与 \`.chat-thread-wallpaper-overlay\`。如果给 \`.chat-thread-page\` 或 \`.chat-thread-messages\` 写不透明的 \`background\`，仍会把壁纸盖住；要加底色请使用半透明色（如 \`rgba(255,255,255,.3)\`）。
> 不要改变壁纸层的层级、定位或点击行为。想叠加装饰，优先使用 \`.chat-thread-navbar\`、\`.chat-thread-composer\` 等专用组件，不要覆盖壁纸图片节点。

## 常用组件类名

${mdTable(['选择器', '说明'], componentRows)}

## 主屏装饰组件选择器（当前模板：${templateId}）

${mdTable(['组件', '选择器'], widgetRows)}

> 删除/恢复组件、换壁纸、换 App 图标和文字请到「美化设置」对应区块直接操作，不需要写 CSS。

## 交付前检查

- 已按用户参考图选择结构，没有默认开启双头像、胶囊顶栏或其它现成构图。
- 没有修改固定入口、路由或依赖 JavaScript 的动态内容。
- 没有覆盖会话壁纸层，也没有侵入系统状态栏。
- 移动端宽度、键盘焦点和 \`prefers-reduced-motion\` 已处理。
- 输出中不存在未使用的备用样式、示例占位资源或解释文本。`;
}

export function downloadTextFile(text, filename) {
  // 加 UTF-8 BOM：不少 Windows 文本编辑器（记事本等）没有 BOM 时会按系统编码猜测，
  // 中文会显示成乱码；浏览器读回本地文件时（File.text()）会自动去掉这个 BOM，不影响再次导入。
  const BOM = '\uFEFF';
  const extension = String(filename || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  const mimeType = {
    css: 'text/css;charset=utf-8',
    json: 'application/json;charset=utf-8',
    md: 'text/markdown;charset=utf-8',
  }[extension] || 'text/plain;charset=utf-8';
  return downloadText(BOM + String(text || ''), filename, { mimeType });
}

export async function downloadThemeExportPayload(payload) {
  const filename = `marshmallow-theme-${Date.now()}.json`;
  // Android 壳内不再把大主题先 stringify 成整段字符串，然后经 Capacitor
  // 桥一次性复制给 Java。按 96 KiB 分块直接落盘，使内存占用与主题总大小脱钩。
  if (supportsChunkedNativeSave()) {
    const writer = await beginNativeChunkedTextSave({
      filename,
      mimeType: 'application/json;charset=utf-8',
      directory: 'downloads',
    });
    try {
      writer.write('\uFEFF');
      await appendJsonValueToWriter(writer, payload);
      return await writer.finish();
    } catch (err) {
      await writer.abort().catch(() => {});
      throw err;
    }
  }
  return downloadTextFile(JSON.stringify(payload, null, 2), filename);
}

export function downloadAiThemeReference(theme, options = {}) {
  const md = buildAiThemeReferenceMarkdown({ theme, includeCurrent: true, themeId: options.themeId || '' });
  return downloadTextFile(md, `marshmallow-css-reference-${Date.now()}.md`);
}
