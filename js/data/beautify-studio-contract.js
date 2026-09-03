import {
  APPEARANCE_COMPONENT_CLASSES,
  CHAT_APPEARANCE_CLASSES,
  CHAT_APPEARANCE_VARS,
  HOME_WIDGET_SLOTS,
  SEA_HOME_CLASSES,
  WINDOW_HOME_CLASSES,
} from './appearance-theme-contract.js';

const CHAT_GROUPS = [
  {
    id: 'bubble',
    label: '气泡与头像',
    match: /(bubble|avatar|msg-group|scrapbook-bubble|speech-play)/,
  },
  {
    id: 'chrome',
    label: '顶栏',
    match: /(navbar|title|header|chrome)/,
  },
  {
    id: 'composer',
    label: '输入区与工具',
    match: /(composer|tools|tool-item|reply-bar|selection-bar|action)/,
  },
  {
    id: 'detail',
    label: '时间、引用与翻译',
    match: /(time|reply|translation|translate)/,
  },
  {
    id: 'narration',
    label: '旁白模式',
    match: /narration/,
  },
  {
    id: 'card',
    label: '消息卡片',
    match: /(card|transfer|packet|location|dice|order|story|voice-msg)/,
  },
];

function uniqueItems(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item?.cls || item?.key || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupChatComponents() {
  const remaining = [...CHAT_APPEARANCE_CLASSES];
  const groups = CHAT_GROUPS.map((group) => {
    const components = remaining.filter((item) => group.match.test(String(item.cls || '')));
    components.forEach((item) => remaining.splice(remaining.indexOf(item), 1));
    return { id: group.id, label: group.label, components: uniqueItems(components) };
  });
  groups.push({ id: 'other', label: '页面与其他', components: uniqueItems(remaining) });
  return groups;
}

// 主屏 App id 全表：配合 [data-app-id] 可以精准改单个图标。
export const HOME_APP_IDS = [
  'chat', 'worldbook', 'preset', 'encounter', 'weibo', 'forum', 'stickers', 'au',
  'companion', 'radio', 'memory', 'music', 'travel-char', 'extensions', 'anon-chat',
  'character-phone', 'appearance', 'beautify', 'my-space', 'contacts', 'calendar', 'settings',
];

const HOME_ICON_COMPONENTS = [
  { cls: '.sea-app[data-app-id="chat"]', label: '单个 App 图标（海/窗主题）；把 chat 换成任意 App id 即可定点只改这一个图标' },
  { cls: '.sea-app .ic', label: 'App 图标的图形容器（海/窗主题）；可用 background-image 换图' },
  { cls: '.sea-app .lb', label: 'App 图标文字标签（海/窗主题）' },
  { cls: '.sea-dock-ic[data-app-id="contacts"]', label: 'Dock 栏单个图标（海/窗主题）；换 data-app-id 定点' },
  { cls: '.app-icon[data-app-id="chat"]', label: '单个 App 图标（手账主题）；换 data-app-id 定点' },
];

const HOME_COMPONENTS = [
  ...APPEARANCE_COMPONENT_CLASSES.filter((item) => /(home|widget|app-icon)/.test(item.cls)),
  ...HOME_WIDGET_SLOTS.map((item) => ({
    cls: `[${item.hook}]`,
    label: item.label,
  })),
  ...HOME_ICON_COMPONENTS,
  ...SEA_HOME_CLASSES,
  ...WINDOW_HOME_CLASSES,
];

const OFFLINE_COMPONENT_GROUPS = [
  {
    id: 'chrome',
    label: '01 · 顶栏',
    components: [
      { cls: '.offline-session-page > .navbar', label: '页面顶栏外壳；保留顶部安全区与现有定位' },
      { cls: '.offline-session-page > .navbar .navbar-btn', label: '返回、设置与收纳按钮' },
      { cls: '.offline-session-page > .navbar .navbar-title', label: '顶栏标题' },
      { cls: '.offline-navbar-actions', label: '顶栏右侧操作组' },
    ],
  },
  {
    id: 'story',
    label: '02 · 场景与叙事',
    components: [
      { cls: '.offline-scroll', label: '正文滚动区；位于顶栏和底部操作区之间' },
      { cls: '.os-anchor', label: '地点、时间与同行者组成的时空锚' },
      { cls: '.offline-scene-card', label: '场景摘要卡' },
      { cls: '.offline-beats', label: '全部叙事楼层的容器' },
      { cls: '.offline-beat--narration', label: '角色与环境叙事楼层' },
      { cls: '.offline-beat--opening', label: '开场楼层' },
      { cls: '.offline-beat--directive', label: '用户方向楼层' },
      { cls: '.offline-beat--interlude', label: '手机插曲楼层' },
      { cls: '.os-beat-footer', label: '楼层号、心声入口与楼层操作所在的底部行' },
      { cls: '.os-beat-thought', label: '单个角色心声入口；弹出的心声卡另由心声方案控制' },
    ],
  },
  {
    id: 'choices',
    label: '03 · 走向选项',
    components: [
      { cls: '.offline-options', label: '走向选项区域；出现时位于展开工具区上方' },
      { cls: '.offline-options-head', label: '走向选项标题与收起操作' },
      { cls: '.offline-options-list', label: '选项列表' },
      { cls: '.offline-option-chip', label: '单个走向选项' },
    ],
  },
  {
    id: 'tools',
    label: '04 · 展开工具区',
    components: [
      { cls: '.offline-tools', label: '点击底栏加号后出现的工具面板；必须继续服从 hidden 状态' },
      { cls: '.offline-tool', label: '工具按钮' },
      { cls: '.offline-tool .svg-icon', label: '工具按钮图标' },
      { cls: '.offline-tool > span', label: '工具按钮名称' },
      { cls: '.offline-tool-state', label: '工具按钮右侧状态字' },
    ],
  },
  {
    id: 'composer',
    label: '05 · 底部输入区',
    components: [
      { cls: '.offline-bar', label: '底部输入区外壳；保留底部安全区与现有定位' },
      { cls: '.offline-plus', label: '展开工具区的加号按钮' },
      { cls: '.offline-input-wrap', label: '输入框外壳' },
      { cls: '.offline-directive', label: '本轮方向输入框' },
      { cls: '.offline-expand', label: '展开大输入框按钮' },
      { cls: '.offline-advance', label: '推进按钮' },
    ],
  },
  {
    id: 'panels',
    label: '弹层与管理态',
    components: [
      { cls: '.offline-settings-sheet-panel', label: '叙事设置弹层主体' },
      { cls: '.os-settings-group', label: '设置弹层里的折叠分组' },
      { cls: '.os-manage-bar', label: '管理历史时出现的批量操作栏' },
      { cls: '.os-manage-btn', label: '批量操作按钮' },
    ],
  },
];

const OFFLINE_VARS = [
  { key: '--os-paper', label: '页面与卡片底色' },
  { key: '--os-ink', label: '主文字颜色' },
  { key: '--os-ink-2', label: '次文字颜色' },
  { key: '--os-ink-3', label: '弱文字颜色' },
  { key: '--os-accent', label: '强调色' },
  { key: '--os-accent-soft', label: '浅强调底色' },
  { key: '--os-line', label: '描边与分隔线颜色' },
  { key: '--os-body-ink', label: '叙事正文颜色' },
  { key: '--os-body-size', label: '叙事正文字号' },
  { key: '--os-leading', label: '叙事正文行距' },
  { key: '--os-measure', label: '叙事正文最大宽度' },
];

const CHAT_HUB_VARS = [
  { key: '--chat-hub-page-bg', label: '页面底色', type: 'color', defaultColor: '#ffffff' },
  { key: '--chat-hub-chrome-bg', label: '顶部区域底色', type: 'color', defaultColor: '#ffffff' },
  { key: '--chat-hub-list-bg', label: '列表区域底色', type: 'color', defaultColor: '#ffffff' },
  { key: '--chat-hub-card-bg', label: '个人卡底色', type: 'color', defaultColor: '#f4f4f5' },
  { key: '--chat-hub-row-bg', label: '消息行底色', type: 'color', defaultColor: '#ffffff' },
  { key: '--chat-hub-title-ink', label: '标题颜色', type: 'color', defaultColor: '#111111' },
  { key: '--chat-hub-muted-ink', label: '预览与时间颜色', type: 'color', defaultColor: '#a0a0a5' },
  { key: '--chat-hub-divider', label: '分隔线颜色', type: 'color', defaultColor: '#eeeeef' },
  { key: '--chat-hub-unread-bg', label: '未读角标底色', type: 'color', defaultColor: '#ff3040' },
  { key: '--chat-hub-row-radius', label: '消息行圆角', placeholder: '例如 16px' },
  { key: '--chat-hub-row-padding', label: '消息行内边距', placeholder: '例如 13px 20px' },
  { key: '--chat-hub-row-inset', label: '消息行左右留白', placeholder: '例如 14px' },
  { key: '--chat-hub-row-gap', label: '消息行纵向间距', placeholder: '例如 8px' },
  { key: '--chat-hub-row-shadow', label: '消息行阴影', placeholder: '例如 0 8px 24px rgba(0,0,0,.08)' },
  { key: '--chat-hub-avatar-size', label: '头像大小', placeholder: '例如 48px' },
  { key: '--chat-hub-avatar-radius', label: '头像圆角', placeholder: '例如 50%' },
  { key: '--chat-hub-title-size', label: '聊天名称字号', placeholder: '例如 15px' },
  { key: '--chat-hub-preview-size', label: '消息预览字号', placeholder: '例如 13px' },
  { key: '--chat-hub-time-size', label: '时间字号', placeholder: '例如 12px' },
];

const TRAVEL_COMPONENT_GROUPS = [
  {
    id: 'travel-shell',
    label: '页面与顶栏',
    components: [
      { cls: '.travel-char-page / .travel-event-page', label: '旅行首页 / 旅行事件页根节点' },
      { cls: '.navbar', label: '旅行页顶栏' },
      { cls: '.travel-showcase-main / .travel-event-scroll', label: '旅行首页 / 事件页滚动区' },
    ],
  },
  {
    id: 'travel-content',
    label: '旅行内容',
    components: [
      { cls: '.travel-stage', label: '首页旅行展示台' },
      { cls: '.travel-trip-row', label: '旅行记录卡片' },
      { cls: '.travel-theme', label: '旅行主题选项' },
      { cls: '.travel-event-board / .travel-progress-card', label: '旅行事件主卡 / 行程节点卡' },
      { cls: '.travel-dock / .travel-footer', label: '首页 Dock / 事件页底部操作区' },
    ],
  },
];

export const BEAUTIFY_TARGETS = [
  {
    id: 'chat-thread',
    label: '聊天对话',
    root: '.chat-thread-page',
    enabled: true,
    route: 'chat',
    groups: groupChatComponents(),
    vars: CHAT_APPEARANCE_VARS,
    aiNotes: [
      '转账发起卡与“已收款”回执卡共用 .transfer-card、.transfer-main、.transfer-mark、.transfer-foot 视觉骨架；美化时应统一尺寸、圆角、金额字阶和底栏排布，仅通过 .transfer-receipt-card 或状态类改变颜色与文案，不要为回执另起一套卡片。',
      '用户说“重做/大改顶栏或底栏”时，不要只换变量和颜色。必须同时重构外层轮廓与内层排布：顶栏至少处理 .chat-thread-navbar、.chat-thread-title-btn、.chat-thread-title-stack、.navbar-btn；底栏至少处理 .chat-thread-composer、当前主题对应的内部行/胶囊、输入框、发送键，并同步设计 .chat-tools-sheet。只有用户明确说“只换色”时才停留在变量层。',
      '底栏有两套输入结构，不可混写：手账体系与 QQ 默认皮肤使用 .chat-thread-composer > .chat-composer-input-row + .chat-composer-strip；海/窗/匿名使用 .chat-thread-composer.chat-thread-composer--anon > 外侧加号 + .chat-anon-input-shell + .chat-anon-send。海/窗虽带 --anon 类名，工具面板仍是 .chat-tools-pager 的 4×2 分页；只有匿名区使用 .chat-tools-sheet--anon。兼容旧会话 CSS 时以预览里的真实 DOM 为准。',
      '顶栏/底栏玻璃的正确改法：会话壁纸的清晰度白雾由 --chat-wallpaper-overlay-bg 控制，顶栏/输入区底色由 --chat-chrome-bg / --chat-composer-bg 控制，主题模糊由 --chat-chrome-filter 控制。用户要求彻底接管玻璃或颜色不再被洗灰时，在 .chat-thread-page 上同时设置这几项；不要删除 .chat-thread-wallpaper-overlay DOM。',
      '平台默认皮肤使用低权重规则，通用美化 CSS 直接写公开组件类即可覆盖。视觉属性会自动补强；display/grid/flex、padding/margin、尺寸和 position 等布局属性不要依赖平台复合根，必要时只对确实冲突的声明逐项加 !important。',
      '做毛玻璃时背景使用 rgba/透明渐变而不是不透明色；直接写属性时同时写 -webkit-backdrop-filter 与 backdrop-filter。优先使用 --chat-chrome-filter 统一接管系统玻璃，避免底层白雾、主题底色和自定义滤镜叠成三层。不要给整页和每个子元素都加模糊，只处理气泡、顶栏或输入胶囊等有限表面。',
      '不要覆盖 .chat-thread-composer / .chat-thread-navbar 现有的 position、top、bottom 定位机制，否则会破坏键盘避让和消息区高度。顶部系统安全区由页面里的独立保护槽承担，顶栏 padding / margin 只写视觉尺寸，不要再叠加 var(--safe-top)，也不要用负 margin 或 translateY 把顶栏顶进状态栏。底部区域始终保留 var(--safe-bottom)，工具面板打开时安全区由最底层面板承担。',
    ].join('\n'),
  },
  {
    id: 'offline',
    label: '线下沉浸',
    root: '.offline-session-page',
    enabled: true,
    route: 'offline',
    groups: OFFLINE_COMPONENT_GROUPS,
    vars: OFFLINE_VARS,
    aiNotes: [
      '这是进行中的线下叙事页，不是聊天气泡页。组件清单按页面从上到下列出真实结构：顶栏 → 正文滚动区 → 走向选项 → 展开工具区 → 底部输入区；它只是结构地图，不代表任何预设视觉。',
      '用户没有给参考图或明确风格时，先用一句话确认要改变的视觉关系，再按用户描述创作；不要从选择器名称自行套用奶油手账、玻璃卡、灰蓝面板或其它成品皮肤，也不要复刻文档里的颜色、圆角、阴影。',
      '整页改造时必须把顶栏、叙事正文、走向选项、展开工具区和底部输入区视为同一套系统；不能只改正文卡片后把上下操作区留成原样。用户只点选一个组件时，才收窄到该组件及必要的相邻结构。',
      '顶栏是根节点的直接子元素 .offline-session-page > .navbar；底部操作由三个相邻区域组成：.offline-options、.offline-tools、.offline-bar。工具区由底栏加号控制 hidden；禁止用 display 覆盖 [hidden]，否则关闭状态也会常驻挡住正文。',
      '可以重做背景、字体、边框、间距、按钮形状和内部排布，但不要改顶栏、工具区、底栏的 position/top/bottom/inset 定位机制，不要把它们改成 fixed 全屏层。顶部保留 var(--safe-top)，底部保留 var(--safe-bottom)，输入框、返回、设置、收纳、加号与推进必须可见可点。',
      '点开角色心声后的 #char-state-popover 在页面根之外，不属于本页 CSS；这里只改 .os-beat-thought 入口，心声弹层由线下美化里的心声方案控制。',
    ].join('\n'),
  },
  {
    id: 'home',
    label: '主屏',
    root: '.home-shell-page, .home-sea-shell, .home-window-shell',
    enabled: true,
    route: 'home',
    groups: [{ id: 'home', label: '主屏组件', components: uniqueItems(HOME_COMPONENTS) }],
    vars: [],
    aiNotes: [
      '主屏有三套主题模板，DOM 不同：手账（根 .home-shell-page，图标 .app-icon）、海（根 .home-sea-shell，图标 .sea-app）、窗（根 .home-window-shell，复用海的 .sea-app 图标结构，另有 mw-* 窗框类）。上下文里会注明用户当前主题，只写当前主题的选择器，不要混用另外两套的类名。',
      '布局是数据不是 CSS：哪些内置组件显示、图标在第几页，由主屏编辑模式（长按主屏）或工作室预览区的「清空布局」控制。CSS 可以用 display:none 隐藏个别部件、可以整体改样式，但不要试图用 CSS 挪动图标的分页归属。',
      '页面背景被壁纸层盖住：给根节点设 background 是看不见的（壁纸 <img> 在上面）。想改主屏底图/底色，改壁纸层（海/窗 .sea-wallpaper-layer 及其中的 img，手账 [data-home-wallpaper-layer]），或引导用户在主屏编辑模式「换壁纸」直接上传。',
      `App id 全表（配合 [data-app-id] 定点改单个图标）：${HOME_APP_IDS.join(', ')}`,
      '图标尺寸/形状可以整体改：海/窗改 .sea-app .ic 的宽高、圆角、阴影，标签字号在 .sea-app .lb；手账改 .app-icon 里的对应结构。也可以只对某个 [data-app-id] 单独放大。',
      '定点换某个图标的图（海/窗）：.sea-app[data-app-id="music"] .ic svg { display:none; } 然后给 .ic 设 background-image（外链 URL 或 mm-img://ID）；手账主题对 .app-icon[data-app-id="…"] 做同样处理。想直接上传图片当图标，也可以引导用户去「美化设置 → App 图标」逐个上传。',
      '自定义组件外壳统一是 .home-custom-widget（代码组件带 .home-code-widget，内部用 Shadow DOM 隔离，页面 CSS 改不到组件内部，只能改外壳大小、位置、圆角、阴影）。',
      '当前是「整套外观」CSS 模式，不生成新 HTML 组件；用户要相框、时钟、贴纸等新东西时，请让用户切到工作室的「自定义组件」模式。',
    ].join('\n'),
  },
  {
    id: 'travel-char',
    label: '旅行',
    root: '.travel-char-page, .travel-event-page',
    enabled: true,
    route: 'travel-char',
    groups: TRAVEL_COMPONENT_GROUPS,
    vars: [],
    aiNotes: [
      '同一份旅行美化同时覆盖旅行首页 .travel-char-page 与旅行事件页 .travel-event-page；通用 .page / .scrapbook-page 写法发布时会自动换成真实页面根。',
      '页面交互和滚动结构保持不变；不要把顶栏、滚动区或底部操作区改成 fixed 全屏层，也不要用不透明遮罩盖住旅行照片。',
    ].join('\n'),
  },
  {
    id: 'chat-hub',
    label: '聊天首页',
    root: '.chat-hub-page',
    enabled: true,
    route: 'chat',
    groups: [{
      id: 'hub',
      label: '列表与导航',
      components: [
        { cls: '.chat-hub-page', label: '聊天首页根节点（海/窗主题带 .chat-hub-page--ins；手账没有）' },
        { cls: '.chat-hub-ins-chrome', label: '海/窗主题的顶部区块整体（工具行 + 用户卡 + 标签栏）' },
        { cls: '.chat-hub-toolbar', label: '海/窗主题顶部工具行（返回键 + 右侧图标）' },
        { cls: '.chat-hub-user-card', label: '海/窗主题的用户名片卡（头像、签名、状态）' },
        { cls: '.chat-hub-navbar', label: '手账主题的顶部导航栏（海/窗主题没有这个节点）' },
        { cls: '.chat-hub-tabs', label: '分区标签栏（海/窗带 .chat-hub-tabs--ins）' },
        { cls: '.chat-hub-tab', label: '单个分区标签' },
        { cls: '.chat-hub-scroll', label: '列表滚动区（海/窗带 .chat-hub-scroll--ins）' },
        { cls: '.chat-list-row', label: '聊天列表行（海/窗带 .chat-list-row--ins）' },
        { cls: '.chat-list-avatar', label: '列表头像' },
        { cls: '.chat-list-title', label: '聊天名称' },
        { cls: '.chat-list-preview', label: '消息预览' },
        { cls: '.chat-list-time', label: '时间' },
        { cls: '.chat-list-unread', label: '未读角标' },
      ],
    }],
    vars: CHAT_HUB_VARS,
    maxVars: CHAT_HUB_VARS.length,
    aiNotes: [
      '聊天首页有两套 DOM：海/窗主题走 ins 版（根节点带 .chat-hub-page--ins，顶部是 .chat-hub-toolbar + 用户卡 .chat-hub-user-card，列表行带 --ins 修饰类），手账主题才有 .chat-hub-navbar。上下文会注明用户当前主题，写对应那套的选择器。',
      '页面根提供统一的 --chat-hub-* 外观变量，细节控件会把变量写在 .chat-hub-page 上，并同时驱动手账与海/窗结构。整页换色时至少一起处理 --chat-hub-page-bg、--chat-hub-chrome-bg、--chat-hub-list-bg、--chat-hub-card-bg 与 --chat-hub-row-bg，避免只改根背景却被顶部或滚动区实体底色盖住。',
      '消息行布局优先使用 --chat-hub-row-padding、--chat-hub-row-inset、--chat-hub-row-gap、--chat-hub-avatar-size 等统一变量；只有用户明确要求改列结构时，才分别覆盖 .chat-list-row 与 .chat-list-row--ins。',
    ].join('\n'),
  },
  {
    id: 'moments',
    label: '朋友圈',
    root: '.moments-page',
    enabled: true,
    route: 'chat/moments',
    groups: [{
      id: 'moments',
      label: '动态组件',
      components: [
        { cls: '.moments-page', label: '朋友圈根节点' },
        { cls: '.moments-cover', label: '封面区域' },
        { cls: '.moments-cover-avatar', label: '封面头像' },
        { cls: '.moments-cover-name', label: '封面昵称' },
        { cls: '.moments-feed', label: '动态列表' },
        { cls: '.moment-post', label: '单条动态卡片' },
        { cls: '.moment-post-avatar', label: '动态头像' },
        { cls: '.moment-post-name', label: '动态昵称' },
        { cls: '.moment-post-text', label: '动态正文' },
        { cls: '.moment-images', label: '动态图片区' },
        { cls: '.moment-likes-line', label: '点赞栏' },
        { cls: '.moment-comments', label: '评论区' },
        { cls: '.moment-comment-row', label: '单条评论' },
      ],
    }],
    vars: [],
  },
  {
    id: 'intercepts',
    label: '陌生消息',
    root: '.chat-intercepts-page',
    enabled: true,
    route: 'chat/intercepts',
    groups: [{
      id: 'intercepts',
      label: '陌生消息',
      components: [
        { cls: '.chat-intercepts-page', label: '页面根节点' },
        { cls: '.chat-hub-navbar', label: '顶部导航栏' },
        { cls: '.chat-list-row', label: '消息列表行' },
        { cls: '.chat-list-avatar', label: '消息头像' },
        { cls: '.chat-list-title', label: '消息标题' },
        { cls: '.chat-list-preview', label: '消息预览' },
      ],
    }],
    vars: [],
  },
  {
    id: 'backstage',
    label: '秘密基地',
    root: '.chat-backstage-page',
    enabled: true,
    route: 'chat/backstage',
    groups: [{
      id: 'backstage',
      label: '秘密基地',
      components: [
        { cls: '.chat-backstage-page', label: '页面根节点' },
        { cls: '.chat-hub-navbar', label: '顶部导航栏' },
        { cls: '.chat-list-row', label: '基地列表行' },
        { cls: '.chat-list-avatar', label: '基地头像' },
        { cls: '.chat-list-title', label: '基地标题' },
        { cls: '.chat-list-preview', label: '消息预览' },
      ],
    }],
    vars: [],
  },
];

export function getBeautifyTarget(id) {
  return BEAUTIFY_TARGETS.find((item) => item.id === id) || BEAUTIFY_TARGETS[0];
}

export function buildComponentAiContext(target, component) {
  const vars = (target.vars || []).map((item) => `${item.key}: ${item.label}`).join('\n');
  const lines = [
    `页面：${target.label}`,
    `页面根选择器：${target.root}`,
  ];
  if (component) {
    lines.push(`当前组件：${component.label}\n组件选择器：${component.cls}`);
  } else {
    const catalog = (target.groups || [])
      .map((group) => `【${group.label}】\n${group.components
        .map((item) => `- ${item.cls} ${String(item.label || '').split('；')[0]}`)
        .join('\n')}`)
      .join('\n');
    lines.push(`当前没有选中单个组件：按整页出一套完整、风格统一的方案。下面是这页的 DOM 索引（只说明页面里有什么、选择器叫什么，不代表原主题的设计需要保留）：\n${catalog}`);
  }
  if (target.aiNotes) lines.push(`页面补充说明：\n${target.aiNotes}`);
  if (vars) lines.push(`可用公开变量：\n${vars}`);
  return lines.join('\n\n');
}
