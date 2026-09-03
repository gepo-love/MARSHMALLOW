/**
 * 全局美化契约：固定入口与槽位不变，样式与资源可替换。
 * 供美化设置 UI 与 #/tutorial?section=appearance 文档共用。
 */

export const MAX_CUSTOM_CSS_BYTES = 80 * 1024;

/** 主屏字色 token（仅作用于桌面主屏壳，不写入 :root） */
export const HOME_THEME_TEXT_VARS_BY_TEMPLATE = {
  scrapbook: [
    { key: '--ink-brown', label: '用户标题', default: '#8c7362' },
    { key: '--ink-blue', label: '状态小字', default: '#5c7b8f' },
    { key: '--tape-orange', label: '组件标题', default: '#f1b98f' },
  ],
  sea: [
    { key: '--sea-ink', label: '主文字', default: '#36586a' },
    { key: '--sea-ink-soft', label: '次要文字', default: '#6b8fa4' },
    { key: '--sea-gold', label: '点缀色', default: '#d29a3f' },
  ],
  window: [
    { key: '--mw-ink', label: '主文字', default: '#58666e' },
    { key: '--mw-ink-soft', label: '次要文字', default: 'rgba(88, 102, 110, 0.62)' },
  ],
  album: [
    { key: '--album-ink', label: '主文字', default: '#343735' },
    { key: '--album-muted', label: '次要文字', default: '#7b817d' },
    { key: '--album-accent', label: '低饱和点缀', default: '#8b968c' },
  ],
};

export const HOME_SHELL_SELECTORS = {
  scrapbook: '.home-shell-page',
  sea: '.home-sea-shell',
  window: '.home-window-shell',
  album: '.home-album-shell',
};

/** @deprecated 旧版全局配色；仅用于迁移读取，不再在美化设置展示 */
export const THEME_CSS_VARS = Object.values(HOME_THEME_TEXT_VARS_BY_TEMPLATE)
  .flat()
  .map((item, index, arr) => arr.findIndex((x) => x.key === item.key) === index ? item : null)
  .filter(Boolean);

/** 主屏装饰组件（App 网格与 Dock 固定；false = 从主屏删除） */
export const HOME_WIDGET_SLOTS = [
  { id: 'userHeader', label: '用户卡片', hook: 'data-widget="user-header"' },
  { id: 'polaroidP1', label: '拍立得（第一页）', hook: 'data-widget="polaroid-p1"' },
  { id: 'noteMemo', label: '备忘录', hook: 'data-widget="note-memo"' },
  { id: 'filmWidget', label: '胶片装饰', hook: 'data-widget="film-widget"' },
  { id: 'calendarWidget', label: '日历', hook: 'data-widget="calendar-widget"' },
  { id: 'polaroidP3', label: '拍立得（第三页）', hook: 'data-widget="polaroid-p3"' },
];

export const THEME_EXPORT_TYPE = 'marshmallow-appearance-theme';
export const THEME_EXPORT_VERSION = 1;

/** 跨页面常见组件类名（AI 写 CSS 时参考） */
export const APPEARANCE_COMPONENT_CLASSES = [
  { cls: '.scrapbook-card', label: '通用手账卡片' },
  { cls: '.widget-card', label: '主屏 widget 纸张（手账主题）' },
  { cls: '.app-icon', label: 'App 图标按钮' },
  { cls: '.home-wallpaper-layer / .home-wallpaper-overlay', label: '手账主屏壁纸层 / 壁纸颜色遮罩；遮罩颜色由运行时写入，直接改 background 时需要 !important' },
  { cls: '.home-bottom-chrome / .home-dock', label: '手账主屏底部区域 / Dock（真实 Dock 同时带 .dock 与 .home-dock）' },
  { cls: '.navbar', label: '顶栏' },
  { cls: '.dialer-row', label: '通讯录列表行' },
  { cls: '.cphone-block', label: '他的手机卡片块' },
  { cls: '.scrapbook-list-item', label: '设置/列表行' },
  { cls: '.form-input', label: '通用输入框、文本域与下拉框（请配合页面根类限定作用域）' },
  { cls: '.btn', label: '通用按钮基类' },
  { cls: '.btn-primary', label: '主按钮' },
  { cls: '.btn-outline', label: '描边按钮' },
  { cls: '.btn-soft', label: '弱操作按钮' },
  { cls: '.btn-sm / .btn-xs', label: '小尺寸 / 紧凑尺寸按钮修饰类' },
];

/** 消息界面（聊天对话页）专用类名 —— 真实 DOM，供「消息界面 CSS / 气泡」参考 */
export const CHAT_APPEARANCE_CLASSES = [
  { cls: '.chat-thread-page', label: '聊天对话页根节点（建议所有规则加这个前缀）；不要给页面或消息区写不透明背景遮住独立壁纸层' },
  { cls: '.chat-thread-page--ins / --sea / --window / --anon', label: '当前聊天主题修饰类；只在确实需要区分主题时使用，通用美化优先写公开变量' },
  { cls: '.has-chat-wallpaper', label: '当前会话已设置壁纸；顶栏/输入区会使用 --chat-chrome-bg 作为遮罩底色' },
  { cls: '.chat-thread-navbar', label: '顶部导航栏整条（换背景/毛玻璃/圆角在这层改；系统安全区由页面独立保留，不要用负位移侵入）' },
  { cls: '.chat-thread-title-btn', label: '顶栏标题按钮（点开是聊天设定，包含下面两行）' },
  { cls: '.chat-title-duo', label: '顶栏可选头像容器（仅单聊渲染两个图片槽，默认隐藏）；不要默认开启，可保持无头像、隐藏其中一枚做单大头像，或明确需要时显示双头像' },
  { cls: '.chat-title-duo-avatar', label: '可选头像里的单个头像框（.is-them 对方 / .is-user 我）；可隐藏、重排，尺寸/重叠/圆角优先使用 --chat-title-duo-* 变量' },
  { cls: '.chat-title-duo-img', label: '双头像里的头像图片；已有 width/height:100% 与 object-fit:cover 基线' },
  { cls: '.chat-thread-title-stack', label: '顶栏角色名、在线状态与时区提示的纵向文字容器' },
  { cls: '.navbar-title', label: '顶栏角色名那一行' },
  { cls: '.chat-header-status', label: '顶栏角色名下面的状态行（在线/自定义状态文案）' },
  { cls: '.chat-header-presence-dot', label: '在线/离线状态行前的小圆点' },
  { cls: '.chat-header-timezone-hint', label: '顶栏时区与本地时间提示' },
  { cls: '.navbar-btn', label: '顶栏图标按钮（返回 / 设置）' },
  { cls: '.chat-thread-messages', label: '消息滚动区（这里和 .chat-thread-page 本身都别写不透明 background——会话壁纸画在更底层，盖上不透明色会导致上传的壁纸显示不出来；真要在这层加底色，用半透明色如 rgba(255,255,255,.3)）' },
  { cls: '.chat-thread-wallpaper-layer', label: '会话壁纸独立底层；位于聊天页直属子节点，不要改变层级或用不透明背景盖住图片' },
  { cls: '.chat-thread-wallpaper-img', label: '会话壁纸图片，可调整 object-fit / object-position' },
  { cls: '.chat-thread-wallpaper-overlay', label: '壁纸蒙版层；透明度由会话壁纸设置控制' },
  { cls: '.chat-bubble-row.is-user', label: '我发的那一行；默认头像和内容在右。用户明确要求整套移到左边时，不要改成 column/grid：在 .chat-thread-page 设置 --chat-user-row-justify:flex-start、--chat-user-col-order:1、--chat-user-avatar-order:0、--chat-user-content-align:flex-start、--chat-user-content-margin-left:0、--chat-user-content-margin-right:auto；这些变量也会让我方图片与表情包越过末尾保护并靠左' },
  { cls: '.chat-bubble-row.is-them', label: '对方发的那一行；横向 flex，DOM 顺序是头像在前、气泡列在后，所以头像自然位于左侧。除非明确换边，不要改行方向或颠倒直属元素 order' },
  { cls: '.chat-bubble-row.is-system', label: '系统提示行' },
  { cls: '.chat-bubble-row.is-stack-group', label: '开启「连续气泡」后，同一发送者的连续消息合并成的一整行（头像/称呼只在这一行出现一次）；组内每条气泡是 .chat-msg-bubble（文字/贴纸）/ .chat-msg-card（红包转账等卡片）/ .chat-msg-media（图片）之一，时间只出现一次、用 .chat-bubble-stack-time' },
  { cls: '.chat-msg-bubble / .chat-msg-card / .chat-msg-media', label: '连续气泡组内的文字气泡 / 卡片 / 图片媒体子项；我方纯图片与表情包的方向跟随 --chat-user-content-align 和两项 --chat-user-content-margin-* 变量' },
  { cls: '.chat-bubble-stack-time', label: '连续气泡组共用的时间戳' },
  { cls: '.scrapbook-bubble', label: '单个气泡（真实气泡元素，文字消息用）；可改 background（支持 rgba 透明度）、color、圆角、边框、box-shadow，以及 ::before/::after 小装饰' },
  { cls: '.chat-msg-group.is-user', label: '匿名区：我发的那一组（匿名壳不用 .chat-bubble-row）' },
  { cls: '.chat-msg-group.is-them', label: '匿名区：对方发的那一组' },
  { cls: '.chat-bubble-avatar', label: '头像容器（可点，双击/长按有菜单）；默认是圆角方形、overflow:hidden、带兜底底色 #f1e4d4，头像图用 object-fit:cover 铺满。改大小/形状优先写变量：--chat-bubble-avatar-size（通用）、--chat-user-avatar-size（我）、--chat-role-avatar-size（对方/角色）、--chat-bubble-avatar-radius（圆角，50% 即圆形）；主题内置规则权重较高，不要直接写 width/height 容易被盖回' },
  { cls: '.chat-bubble-avatar-img', label: '头像图片' },
  { cls: '.chat-bubble-avatar-letter', label: '没设头像时的兜底字母' },
  { cls: '.chat-bubble-sender', label: '气泡上方昵称 / 身份文字' },
  { cls: '.chat-bubble-identity.is-beautify-identity', label: '私聊里默认隐藏的装饰身份槽；在 .chat-thread-page 设置 --chat-private-id-display:block 即可显示。真实显示名在 data-sender-label；若要纯视觉“假 ID”，可分别对 .is-user / .is-them 下的槽用 ::before 写 content，并把槽本身字号设为 0' },
  { cls: '.chat-bubble-time', label: '气泡时间戳' },
  { cls: '.chat-bubble-stack-time', label: '连续气泡组的共用时间戳' },
  { cls: '.chat-time-divider / .date-divider', label: '消息流中的时间分隔条 / 日期分隔条' },
  { cls: '.chat-narration-row', label: '旁白模式的整行容器；默认小字居中，两侧带浅细横线' },
  { cls: '.chat-narration-row.is-flow', label: '旁白行；可调整正文宽度、留白以及两侧横线' },
  { cls: '.chat-narration-card', label: '透明的旁白内容容器，不继承系统提示或双方气泡样式' },
  { cls: '.chat-narration-rule / .chat-narration-rule-line', label: '旁白正文上方的独立装饰行与左右细线' },
  { cls: '.chat-narration-rule-label', label: '两侧细线之间的可选微标；默认隐藏，内置纸片名卡显示 scene' },
  { cls: '.chat-narration-body', label: '旁白正文；保留自然分段，可改字号、行高、字距与文字颜色' },
  { cls: '.chat-bubble-reply', label: '气泡内部的引用消息摘要' },
  { cls: '.chat-bubble-translate-btn', label: '气泡内「翻译」折叠按钮（点开才展开译文；外语/方言气泡才有）' },
  { cls: '.chat-bubble-translation', label: '译文容器（展开后可见）' },
  { cls: '.chat-bubble-translation-divider', label: '原文与译文之间的分隔线' },
  { cls: '.chat-bubble-translation-text', label: '译文正文' },
  { cls: '.voice-msg', label: '语音消息整体；展开时带 .voice-msg--expanded，收起时带 .voice-msg--collapsed' },
  { cls: '.voice-msg-bar', label: '语音条的播放区外壳' },
  { cls: '.voice-msg-play', label: '语音播放按钮' },
  { cls: '.voice-msg-wave / .voice-msg-dur', label: '语音波形 / 时长文字' },
  { cls: '.voice-msg-transcript', label: '点开语音后出现的转写区域外壳；可改背景、边框、圆角和间距' },
  { cls: '.voice-msg-text / .voice-msg-text--full', label: '语音转写正文' },
  { cls: '.voice-msg-translation', label: '语音条转写展开后的译文' },
  { cls: '.voice-msg-translation-divider', label: '语音原文与译文的分隔线' },
  { cls: '.chat-speech-play-btn', label: '语音演绎的小播放键；连续播放本轮时同时带 .is-round-play' },
  { cls: '.chat-speech-play-btn.is-round-play', label: '本轮连续播放按钮' },
  { cls: '.chat-speech-play-btn.is-playing / .chat-speech-play-btn.is-loading', label: '连续播放按钮的播放中 / 加载中状态' },
  { cls: '.chat-speech-play-btn .svg-icon', label: '连续播放按钮内部的播放图标圆片' },
  { cls: '.chat-speech-play-btn .voice-msg-loading-dot', label: '连续播放按钮加载中的圆点' },
  { cls: '.narration-translation', label: '线下/叙事文中的括注译文（点「译」展开；也可写在全局 CSS）' },
  { cls: '#char-state-popover .char-state-translate-btn', label: '心声弹层里的翻译按钮' },
  { cls: '.chat-card', label: '非文字消息卡片的通用标记（红包/转账/位置/骰子/通话/购物分享/分享链接等都带这个）' },
  { cls: '.transfer-card', label: '转账类卡片的统一外壳（发起转账与已收款回执共用，建议一起美化）' },
  { cls: '.transfer-receipt-card', label: '已收款回执卡；只用于覆盖状态色等差异，不要另做一套尺寸与排版' },
  { cls: '.transfer-main', label: '转账类卡片的金额主面；发起转账与已收款回执共用' },
  { cls: '.transfer-mark', label: '转账类卡片的圆形货币标；保持 flex/grid 居中与固定 line-height，避免图标位移' },
  { cls: '.transfer-foot', label: '转账类卡片的平台名与状态底栏；发起转账与已收款回执共用' },
  { cls: '.red-packet-card', label: '红包卡片' },
  { cls: '.share-link-card', label: '分享链接卡片' },
  { cls: '.location-card', label: '位置卡片' },
  { cls: '.dice-card', label: '骰子卡片' },
  { cls: '.voice-call-card', label: '语音/视频通话卡片' },
  { cls: '.order-share-card', label: '购物分享卡片' },
  { cls: '.textimg-sheet-card', label: '文字图卡片' },
  { cls: '.offline-invite-card / .chat-card[data-card-type="offline-invite"]', label: '线下邀约卡外壳；只改这一层通常不会改变内部纸片颜色，推荐优先使用 --offline-invite-* 变量' },
  { cls: '.offline-invite-card-ribbon', label: '邀约卡顶部“线下邀约 / 群聚邀约”标签' },
  { cls: '.offline-invite-card-paper', label: '邀约卡真正可见的纸片主体；底色、边框、圆角和阴影主要改这里' },
  { cls: '.offline-invite-card-paper::before', label: '纸片底部按钮上方的虚线分隔' },
  { cls: '.offline-invite-card-head / .offline-invite-card-act', label: '邀约标题 / 活动名称主文字' },
  { cls: '.offline-invite-card-meta / .offline-invite-card-note / .offline-invite-card-route', label: '时间地点强调字 / 备注 / 路线说明' },
  { cls: '.offline-invite-card-actions', label: '邀约卡按钮组' },
  { cls: '.offline-invite-accept / .offline-invite-enter', label: '接受、赴约、进入线下的主按钮' },
  { cls: '.offline-invite-decline / .offline-invite-shelve', label: '婉拒、暂时搁置的次按钮' },
  { cls: '.offline-invite-card-status', label: '已接受、已婉拒、已完成等状态文字' },
  { cls: '.offline-invite-invitee-chip', label: '群聚邀约中的受邀角色标签' },
  { cls: '.offline-invite-response / .offline-invite-response-avatar / .offline-invite-response-body', label: '群聚邀约中其他角色的回应行 / 头像圆片 / 回应文字' },
  { cls: '.offline-invite-card--pending / .offline-invite-card--accepted / .offline-invite-card--declined / .offline-invite-card--shelved / .offline-invite-card--fulfilled', label: '邀约状态修饰类，可定点修改待回应、接受、婉拒、搁置、完成状态' },
  { cls: '.offline-invite-card--group', label: '群聚邀约修饰类' },
  { cls: '.story-card', label: '剧情/事件提示卡片' },
  { cls: '.chat-thread-composer', label: '底部输入区整条容器' },
  { cls: '.chat-composer-input', label: '输入框（打字的地方）' },
  { cls: '.chat-thread-composer--wechat', label: '微信平台的单行输入区；仍可直接使用通用输入区变量与组件类覆盖' },
  { cls: '.wechat-composer-input-shell', label: '微信输入框的白色胶囊外壳' },
  { cls: '.wechat-composer-btn / .wechat-composer-send', label: '微信输入栏的语音、表情、加号按钮 / 发送键' },
  { cls: '.chat-composer-btn', label: '两行输入区的图标按钮' },
  { cls: '.chat-composer-send', label: '发送键三态共用：有字是"发送"；没字是"推进"（带 .is-advance-mode）；生成中变红色"停止"（带 .is-stop-mode）' },
  { cls: '.chat-composer-input-row / .chat-composer-strip', label: '两行结构的输入上行与下行图标条；QQ 的 --qq 类只在 QQ 平台生效' },
  { cls: '.chat-thread-composer--anon', label: '海/窗/匿名聊天使用的单行紧凑输入区；普通海/窗仍使用下方 4×2 分页工具面板' },
  { cls: '.chat-anon-input-shell', label: '海/窗/匿名聊天的输入胶囊外壳' },
  { cls: '.chat-anon-icon-btn / .chat-anon-inline-btn / .chat-anon-send', label: '紧凑输入栏的加号、胶囊内工具与圆形发送/推进按钮' },
  { cls: '.chat-reply-bar', label: '输入区上方的引用回复条' },
  { cls: '.chat-reply-cancel', label: '引用回复条右侧的取消按钮' },
  { cls: '.chat-selection-bar', label: '多选消息时显示的操作条' },
  { cls: '.chat-tools-sheet', label: '点「+」展开的工具面板整体底图/底色（展开时带 .is-open）；4×2 横向翻页按顺序连续填满，内部结构仍是 .chat-tools-pager > .chat-tools-page，翻页圆点仍是 .chat-tools-dots，排序入口是独立的 .chat-tools-order-trigger' },
  { cls: '.chat-tool-item', label: '工具面板里的单个工具：图标本体（.svg-icon）是白色圆角磁贴、文字标签在磁贴外面；磁贴底色走 --chat-toolbar-item-bg' },
  { cls: '.chat-tools-sheet--anon / .chat-anon-tools-grid / .chat-anon-tool', label: '匿名聊天紧凑工具面板、网格与工具按钮（旧 Ins 类名保留兼容）' },
  { cls: '.chat-thread-composer.is-observer-input-locked', label: '旁观/用户不在场会话复用统一底栏；文字输入锁定，推进/停止走主操作键，其他操作收进「+」工具面板' },
];

export const CHAT_APPEARANCE_VARS = [
  { key: '--user-bubble-bg', label: '我的气泡底色（自定义 CSS 专用公开变量；高于本会话取色与档案色）' },
  { key: '--role-bubble-bg', label: '对方气泡底色（自定义 CSS 专用公开变量；高于本会话取色与角色色）' },
  { key: '--user-bubble-ink', label: '我的气泡字色（自定义 CSS 专用；海/窗/匿名主题也读取）' },
  { key: '--role-bubble-ink', label: '对方气泡字色（自定义 CSS 专用；海/窗/匿名主题也读取）' },
  { key: '--chat-bubble-font-size', label: '聊天字号' },
  { key: '--chat-translation-ink', label: '译文文字颜色（气泡译文、语音译文共用）' },
  { key: '--chat-translation-font-size', label: '译文字号（气泡默认约 13px；设了变量后气泡/语音译文一起跟）' },
  { key: '--chat-translate-btn-ink', label: '「翻译」按钮文字颜色' },
  { key: '--chat-translate-btn-font-size', label: '「翻译」按钮字号（默认 11px）' },
  { key: '--chat-translation-divider', label: '原文与译文之间分隔线颜色' },
  { key: '--chat-voice-transcript-bg', label: '语音转写区域底色' },
  { key: '--chat-voice-transcript-ink', label: '语音转写正文颜色' },
  { key: '--chat-voice-transcript-border', label: '语音转写区域边框（可写完整 border）' },
  { key: '--chat-voice-transcript-radius', label: '语音转写区域圆角' },
  { key: '--chat-voice-transcript-font-size', label: '语音转写正文字号' },
  { key: '--chat-speech-play-size', label: '语音演绎 / 连续播放按钮尺寸' },
  { key: '--chat-speech-play-icon-size', label: '播放图标圆片尺寸' },
  { key: '--chat-speech-play-ink', label: '语音演绎 / 连续播放按钮颜色' },
  { key: '--chat-speech-play-bg', label: '语音演绎 / 连续播放按钮外层底色' },
  { key: '--chat-speech-play-icon-bg', label: '播放图标圆片底色' },
  { key: '--chat-speech-play-icon-border', label: '播放图标圆片边框（可写完整 border）' },
  { key: '--chat-speech-play-active-ink', label: '播放中的按钮颜色' },
  { key: '--chat-speech-play-active-icon-bg', label: '播放中的图标圆片底色' },
  { key: '--chat-speech-play-active-icon-border', label: '播放中的图标圆片边框（可写完整 border）' },
  { key: '--offline-invite-outer-bg', label: '线下邀约卡外壳底色；设为 transparent 可去掉平台主题附加的白底' },
  { key: '--offline-invite-outer-shadow', label: '线下邀约卡外壳阴影（主要用于微信 / QQ / ins 平台壳）' },
  { key: '--offline-invite-paper', label: '线下邀约卡纸片主体底色' },
  { key: '--offline-invite-border', label: '线下邀约卡主体与回应行边框色' },
  { key: '--offline-invite-shadow', label: '线下邀约卡主体阴影（可写完整 box-shadow）' },
  { key: '--offline-invite-ink', label: '线下邀约卡主文字颜色' },
  { key: '--offline-invite-accent', label: '线下邀约卡时间地点等强调文字颜色' },
  { key: '--offline-invite-muted', label: '线下邀约卡备注、路线和状态等次文字颜色' },
  { key: '--offline-invite-divider', label: '线下邀约卡纸片内虚线分隔颜色' },
  { key: '--offline-invite-ribbon-bg', label: '线下邀约顶部标签背景（可写颜色或渐变）' },
  { key: '--offline-invite-group-ribbon-bg', label: '群聚邀约顶部标签背景（可写颜色或渐变）' },
  { key: '--offline-invite-primary-bg', label: '接受 / 赴约 / 进入线下主按钮背景（可写颜色或渐变）' },
  { key: '--offline-invite-primary-ink', label: '邀约卡主按钮文字颜色' },
  { key: '--offline-invite-secondary-bg', label: '婉拒 / 暂时搁置次按钮底色' },
  { key: '--offline-invite-secondary-ink', label: '邀约卡次按钮文字颜色' },
  { key: '--offline-invite-chip-bg', label: '群聚邀约受邀角色标签底色' },
  { key: '--offline-invite-response-bg', label: '群聚邀约角色回应行底色' },
  { key: '--chat-narration-flow-width', label: '旁白正文宽度，默认 72%' },
  { key: '--chat-narration-flow-padding', label: '旁白正文留白，如 2px 0' },
  { key: '--chat-narration-flow-ink', label: '默认轻叙述文字颜色' },
  { key: '--chat-narration-flow-font-size', label: '默认轻叙述字号' },
  { key: '--chat-narration-flow-line-height', label: '默认轻叙述行高' },
  { key: '--chat-narration-flow-letter-spacing', label: '默认轻叙述字距' },
  { key: '--chat-narration-flow-line-color', label: '旁白两侧细横线颜色' },
  { key: '--chat-narration-flow-line-length', label: '旁白两侧细横线最大长度，默认 36px' },
  { key: '--chat-narration-flow-line-opacity', label: '旁白两侧细横线透明度' },
  { key: '--chat-wallpaper-overlay-bg', label: '壁纸清晰度蒙版的实际底色；不设时跟随清晰度滑杆。设为 transparent 可去掉洗白，设 rgba(...) 可自行控制壁纸色罩' },
  { key: '--chat-chrome-bg', label: '顶栏、输入区、回复条这些组件的统一底色；设 transparent 可只保留模糊，设 rgba(...) 可换成自己的玻璃颜色' },
  { key: '--chat-chrome-filter', label: '顶栏与输入区的统一毛玻璃滤镜，如 blur(14px) saturate(115%)；设 none 可彻底关闭主题自带模糊' },
  { key: '--chat-navbar-top-gap', label: '顶栏在系统安全区之外额外保留的上内边距（默认 6px）；状态栏安全区本身会被强制保留，不要用负 margin/transform 把顶栏推回去' },
  { key: '--chat-bubble-avatar-size', label: '消息旁头像边长（默认 44px；窗主题 46px）。写在我/对方专用变量未设置时的兜底' },
  { key: '--chat-user-avatar-size', label: '我发消息那一侧的头像边长（不设则跟随 --chat-bubble-avatar-size）' },
  { key: '--chat-role-avatar-size', label: '对方/角色发消息那一侧的头像边长（不设则跟随 --chat-bubble-avatar-size）' },
  { key: '--chat-bubble-avatar-radius', label: '消息旁头像圆角（默认 12px；50% 即圆形）' },
  { key: '--chat-title-duo-size', label: '顶栏双头像边长（默认 32px，仅单聊且打开 .chat-title-duo 后可见）' },
  { key: '--chat-title-duo-overlap', label: '顶栏两枚头像的重叠量（默认 10px；0px 为不重叠）' },
  { key: '--chat-title-duo-radius', label: '顶栏双头像圆角（默认 50%）' },
  { key: '--chat-title-duo-gap', label: '顶栏双头像整体与标题文字之间的距离（默认 10px）' },
  { key: '--chat-title-duo-border', label: '顶栏单枚头像边框完整值，如 2px solid rgba(255,255,255,.8)' },
  { key: '--chat-title-duo-shadow', label: '顶栏单枚头像阴影' },
  { key: '--chat-composer-bg', label: '底部输入区整条容器底色；不设时继续跟随 --chat-chrome-bg / 当前主题' },
  { key: '--chat-composer-border', label: '底部输入区顶部分隔线完整值' },
  { key: '--chat-composer-input-bg', label: '输入框底色；海/窗主题对应输入胶囊外壳，手账主题对应 textarea 本身' },
  { key: '--chat-composer-input-ink', label: '输入文字颜色' },
  { key: '--chat-composer-placeholder-ink', label: '输入框占位文字颜色' },
  { key: '--chat-composer-input-border', label: '输入框/输入胶囊边框完整值，如 1px solid rgba(255,255,255,.3)' },
  { key: '--chat-composer-input-radius', label: '输入框/输入胶囊圆角' },
  { key: '--chat-composer-input-shadow', label: '输入框/输入胶囊阴影' },
  { key: '--chat-composer-input-height', label: '海/窗与匿名聊天输入胶囊的最小高度（默认 40px）' },
  { key: '--chat-composer-button-bg', label: '手账主题普通输入按钮底色' },
  { key: '--chat-composer-icon-ink', label: '输入区普通图标颜色' },
  { key: '--chat-composer-send-bg', label: '发送/推进按钮底色；停止态仍可用 .is-stop-mode 单独覆盖' },
  { key: '--chat-composer-send-ink', label: '发送/推进按钮图标颜色' },
  { key: '--chat-composer-send-radius', label: '发送/推进按钮圆角（海/窗默认 50%）' },
  { key: '--chat-toolbar-bg', label: '工具面板整体底色' },
  { key: '--chat-toolbar-item-bg', label: '工具面板按钮底色' },
  { key: '--chat-toolbar-ink', label: '工具面板文字与图标颜色' },
  { key: '--chat-toolbar-border', label: '工具面板顶部分隔线完整值' },
  { key: '--chat-reply-bg', label: '输入区引用条与气泡引用摘要底色' },
  { key: '--chat-reply-ink', label: '输入区引用条、取消按钮与气泡引用摘要字色' },
  { key: '--chat-reply-border', label: '输入区引用条顶部分隔线完整值' },
  { key: '--chat-reply-quote-border', label: '气泡内部引用摘要左侧边线完整值' },
  { key: '--chat-time-ink', label: '气泡、连续气泡组与时间分隔条字色' },
  { key: '--chat-time-bg', label: '时间戳与时间分隔条底色' },
  { key: '--chat-time-font-size', label: '气泡与时间分隔条字号' },
];

/** 棉花糖之海(Sea) 主屏专用类名 —— Sea 主题主屏走独立 DOM，与手账不同 */
export const SEA_HOME_CLASSES = [
  { cls: '.home-sea-shell', label: '海主题主屏根节点' },
  { cls: '.sea-page', label: '海主题分页' },
  { cls: '.sea-glass', label: '海主题玻璃卡片' },
  { cls: '.sea-slot', label: '海主题图片上传槽' },
  { cls: '.sea-app', label: '海主题 App 图标' },
  { cls: '.sea-drop-slot', label: '海主题编辑态可放置空格' },
  { cls: '.home-sea-shell::before', label: '海主题整屏渐变遮罩（底部色带也来自这里）' },
  { cls: '.sea-bottom / .sea-dock', label: '海主题底部区域 / Dock' },
  { cls: '.sea-clock', label: '海主题时钟' },
  { cls: '.sea-music', label: '海主题音乐胶囊' },
];

/** 棉花糖之窗(Window) 主屏专用类名 —— Window 主题主屏走独立 DOM，与海/手账不同 */
export const WINDOW_HOME_CLASSES = [
  { cls: '.home-window-shell', label: '窗主题主屏根节点' },
  { cls: '.mw-page', label: '窗主题单页（复用海引擎 .sea-page）' },
  { cls: '.mw-frame-bar', label: '跨页白色窗框横档（配 .mw-bar-top/.mw-bar-mid/.mw-bar-bottom）' },
  { cls: '.mw-frame-edge', label: '首尾页窗框左右收口（配 .mw-edge-left/.mw-edge-right）' },
  { cls: '.mw-weather-skin', label: '天气动效层（雨 / 雾）' },
  { cls: '.mw-mask', label: '毛玻璃磨砂格遮罩（第一页左上/右下、第二页窗格光）' },
  { cls: '.mw-clock', label: '第一页时间' },
  { cls: '.mw-circle', label: '第一页圆形上传槽' },
  { cls: '.mw-portrait', label: '第二页人像大窗（上传）' },
  { cls: '.mw-love-card', label: '第二页 love 叠卡' },
  { cls: '.mw-caption', label: '第二页短句' },
  { cls: '.mw-music-sq', label: '第三页方形专辑播放器音乐卡' },
  { cls: '.mw-film', label: '第三页交错挂式拍立得（上传）' },
  { cls: '.home-window-shell .sea-app .ic', label: '窗主题 App 图标玻璃方块' },
  { cls: '.home-window-shell::before', label: '窗主题整屏柔光面纱' },
  { cls: '.mw-bar-bottom', label: '窗主题 Dock 下方固定白色窗台' },
  { cls: '.mw-bottom / .mw-dock', label: '窗主题底部区域 / Dock' },
];

/** 各模块页面根类名（自定义 CSS 作用域参考） */
export const APPEARANCE_PAGE_CLASSES = [
  { cls: '.home-shell-page', label: '主屏' },
  { cls: '.chat-hub-page', label: '聊天列表' },
  { cls: '.chat-thread-page', label: '聊天对话' },
  { cls: '.chat-details-page', label: '聊天详情' },
  { cls: '.moments-page', label: '朋友圈' },
  { cls: '.dialer-page', label: '通讯录列表（专属，编辑/导入页没有）' },
  { cls: '.contacts-page', label: '通讯录相关页面通用（列表/编辑/导入都带这个类）' },
  { cls: '.cphone-page', label: '他的手机' },
  { cls: '.settings-hub-page', label: '设置' },
  { cls: '.appearance-settings-page', label: '美化设置' },
  { cls: '.api-manager-page', label: 'API 设置' },
  { cls: '.encounter-page', label: '相遇' },
  { cls: '.offline-session-page', label: '线下沉浸页（进行中的线下叙事）' },
  { cls: '.worldbook-page', label: '世界书' },
  { cls: '.presets-page', label: '预设' },
  { cls: '.anon-hub-page', label: '匿名区' },
  { cls: '.scrapbook-page', label: '通用手账页（多页共用）' },
];

export const APPEARANCE_CSS_EXAMPLES = [
  {
    title: '全局纸张更暖',
    css: `:root {
  --bg-paper: #f5ebe0;
  --bg-sheet: #faf3ea;
}`,
  },
  {
    title: '聊天气泡圆角加大',
    css: `.chat-thread-page .scrapbook-bubble {
  border-radius: 20px;
}`,
  },
  {
    title: '外语翻译：字色 / 字号 / 按钮',
    css: `.chat-thread-page {
  --chat-translation-ink: #6b7c8a;
  --chat-translation-font-size: 12px;
  --chat-translate-btn-ink: #a0b4c0;
  --chat-translate-btn-font-size: 10px;
  --chat-translation-divider: rgba(160, 180, 192, 0.35);
}
/* 也可用选择器精细改，例如只改译文正文 */
.chat-thread-page .chat-bubble-translation-text {
  letter-spacing: 0.02em;
  opacity: 0.92;
}`,
  },
  {
    title: '通讯录行距更松',
    css: `.dialer-page .dialer-row {
  padding-top: 14px;
  padding-bottom: 14px;
}`,
  },
  {
    title: '他的手机卡片阴影减弱',
    css: `.cphone-page .scrapbook-card {
  box-shadow: 0 2px 8px rgba(140, 115, 98, 0.06);
}`,
  },
  {
    title: '发送键三态各自换色（发送 / 推进 / 停止）',
    css: `.chat-thread-page .chat-composer-send {
  background: #f1b98f; /* 有字时：发送 */
}
.chat-thread-page .chat-composer-send.is-advance-mode {
  background: #a8c2d8; /* 没字时：推进 */
}
.chat-thread-page .chat-composer-send.is-stop-mode {
  background: #e0645a; /* 生成中：停止，建议保留醒目的红/暖色 */
}`,
  },
  {
    title: '工具面板底图与按钮分开美化',
    css: `.chat-thread-page .chat-tools-sheet {
  background: url("面板底图地址") center / cover;
}
.chat-thread-page .chat-tool-item {
  background: transparent; /* 按钮本身透明，露出面板底图 */
}`,
  },
  {
    title: '聊天气泡旁头像变大（我/对方可分开）',
    css: `.chat-thread-page {
  --chat-bubble-avatar-size: 52px;
  --chat-bubble-avatar-radius: 50%;
  --chat-user-avatar-size: 48px;
  --chat-role-avatar-size: 56px;
}`,
  },
];
