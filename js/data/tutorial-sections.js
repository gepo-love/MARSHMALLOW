/**
 * 教程分节内容（说明性文字集中放这里，不堆在设置页 UI）
 */

import { THEME_EXPORT_TYPE } from './appearance-theme-contract.js';
import {
  ANON_ROOM_CAUTION_INTRO,
  ANON_ROOM_CAUTION_IDENTITY,
  ANON_ROOM_CAUTION_TEXT,
  ANON_ROOM_CAUTION_MATCH_TEXT,
} from './anonymous-room-notice.js';

export const TUTORIAL_NAV = [
  { id: 'overview', label: '总览' },
  { id: 'beta', label: '使用须知' },
  { id: 'support', label: '芥末棉花糖' },
  { id: 'troubleshooting', label: '常见问题' },
  { id: 'backup', label: '云备份' },
  { id: 'appearance', label: '美化' },
  { id: 'extensions', label: '扩展组件' },
  { id: 'api', label: 'API 地址' },
  { id: 'search', label: '搜索 API' },
  { id: 'image', label: '生图' },
  { id: 'voice', label: '语音' },
  { id: 'music', label: '音乐' },
  { id: 'time', label: '虚拟时间' },
  { id: 'encounter', label: '相遇线下' },
  { id: 'map', label: '高德地图' },
  { id: 'meituan', label: '美团优惠分享' },
  { id: 'interest', label: '兴趣与真实分享' },
  { id: 'moments', label: '朋友圈' },
  { id: 'anonymous', label: '匿名区' },
  { id: 'legal', label: '使用边界' },
];

export const SUPPORT_FAQ_ENTRIES = [
  {
    id: 'message-hidden-by-time',
    title: '新消息发出后为什么没显示在底部？',
    keywords: ['新消息不显示', '新消息发出去不显示', '新消息发出去为什么不显示', '消息不见了', '气泡不见了', '时间轴', '虚拟时间', '消息跑到前面'],
    answer: '会话气泡按消息时间排序。若虚拟时间被调到早于已有聊天的时间，新发送的气泡会插入前面的对应时间位置，并不是发送失败或数据丢失。',
    steps: [
      '先向上滑到调整后的时间附近寻找刚发出的气泡。',
      '把虚拟时间调到晚于会话最后一条消息后再继续发送。',
      '如果底部出现发送失败或 API 报错，再按报错原文排查，不要把两种情况混在一起。',
    ],
    actions: ['open-calendar', 'open-chat'],
  },
  {
    id: 'marshmallow-protocol-format',
    title: '“未输出正确格式”或“掉格式”是什么意思？',
    keywords: ['未输出正确格式', '掉格式', '棉花糖协议', '未识别棉花糖协议', 'protocol plain text', 'protocol format error', 'deepseek'],
    answer: '棉花糖机聊天要求模型返回带协议标记的合法 JSONL 事件，才能生成气泡和卡片。“掉格式”表示接口有返回内容，但模型回了普通文字、Markdown 或损坏的 JSON，未满足棉花糖协议；这和 API 完全没返回不是一回事。',
    steps: [
      '先点“重 roll”重试，并在“上一轮原文/模型原文”确认模型实际返回了什么。',
      '如果原文是 Google 等供应商的安全拦截、政策拒绝或标准道歉，报错卡片会单独标为“上游内容拦截”；它不属于棉花糖协议掉格式，也不能作为角色气泡落库。',
        '微博、朋友圈、论坛等结构化功能反复掉 JSON 时，可到“API 管理→聊天模型”开启「结构强化」；摘要、记忆、翻译或资料补全掉格式时，在“工具模型”单独开启。报错卡片会按本次实际使用的线路开启；两者都只加强首轮格式校验，不会自动增加一次调用。',
      '默认会保留正常的 system 与多轮 user / assistant 层级。只有当前中转不接受 system、出现稳定空回时，才尝试开启“将 system 合并到首条 user”；它不会把整段历史压成一条消息。',
      '检查 Max Tokens 是否太小；被截断的最后一行也会变成协议格式错误。',
      '只有普通文字时可选择“作为普通消息落库”；涉及卡片、回复引用等事件时仍需正确协议。',
      '当前实测 DeepSeek V4 大概率无法稳定遵守棉花糖协议，偶尔几条输出正确也不代表兼容；遇到连续掉格式时优先直接更换模型，不建议把反复重试当成解决办法。以后版本是否改善需重新实测。外语气泡缺少 zh 中文字段有时也被称为“掉格式”；可手动点翻译，或在 API 管理的工具模型中明确开启自动补译。',
    ],
    actions: ['open-main-api', 'open-debug-log'],
  },
  {
    id: 'gemini-peak-instability',
    title: 'Gemini 空回、只输出思维链、截断或 429 怎么办？',
    keywords: ['gemini', 'gemini空回', 'gemini 空回', 'gemini截断', 'gemini 429', 'gemini只输出思维链', 'gemini pvp', '只输出思维链', '429', '高峰期'],
    answer: '近期高峰期部分 Gemini 渠道容易出现线路拥堵（用户常称“PVP”），常见表现是正文空回、只返回思维链、回复中途截断或 HTTP 429。这通常属于上游模型或渠道的大环境波动，不一定是棉花糖机本地配置错误。',
    steps: [
      '先看报错详情中的模型名、HTTP 状态、finish_reason 和空回分类，确认当前实际使用的是 Gemini。',
      '后台显示的输出 token 可能包含 reasoning_tokens；只有可见正文 content 才能进入聊天或线下楼层，不能只凭计费 token 判断正文已经返回。失败时可在报错详情的“推理原文”查看接口实际传回的内容。',
      '聊天、线下、番外及角色型生成默认都保留 system 与多轮对话层级；兼容开关只把 system 并入首条 user，不增加调用次数。',
      '偶发一次可稍后重 roll；连续多次空回、截断或 429 时，不建议一直消耗次数硬试。',
      '实在不出字时暂时换其他模型，或更换另一条 API 渠道；原渠道恢复后再切回来。',
      '若换模型和渠道后仍在同一业务页面失败，再让芥末棉花糖带着当前场景自查并提交工单。',
    ],
    actions: ['open-main-api', 'open-debug-log'],
  },
  {
    id: 'notification-permission',
    title: '通知测试为什么没有弹出权限框？',
    keywords: ['通知测试', '通知权限', '通知弹不出来', '权限弹窗', '没有权限弹窗', '通知不显示', '锁屏通知', 'notification permission'],
    answer: '系统授权框只会在通知权限仍为“未决定”时弹一次。若浏览器已经记录为禁止，网页不能强行再次唤起授权框，必须到浏览器或系统的站点通知设置里手动改为允许；这不是重复点击测试按钮能解决的问题。',
    steps: [
      'Android Chrome/Edge：打开当前站点信息 → 权限/通知，确认没有处于“不允许”；改为允许后回到设置页重试。',
      'iPhone/iPad：先把棉花糖机添加到主屏幕并从主屏幕图标打开，再到系统设置 → 通知中允许；普通 Safari 标签页不具备完整的 Web Push 使用条件。',
      'Android APK 不使用网页通知测试入口；请在系统的应用通知权限中允许棉花糖机，并检查省电与后台运行限制。',
      '权限已允许但测试仍不显示时，让芥末棉花糖带入当前权限状态、PWA/浏览器环境和测试阶段继续检查。',
    ],
    actions: ['open-keepalive'],
  },
  {
    id: 'minimax-error',
    title: 'MiniMax 为什么报错？先分语音还是聊天',
    keywords: ['minimax', 'minimax报错', 'minimax 错误'],
    answer: '棉花糖机里的 MiniMax 通常指语音 TTS。先在“API 管理→语音”核对区域、API Key 和模型，再确认角色已启用语音合成并填写声线 ID；错误详情里的 HTTP 状态或 base_resp.status_msg 才是具体原因。若你把 MiniMax 中转当聊天模型使用，则按聊天 API 的地址、Key、模型名和协议格式排查。',
    steps: [
      '国内站、Global 与 US West 的区域端点不能混填；API Key 必须来自对应区域的 MiniMax 开放平台。',
      '语音文本超过 10000 字、角色未启用语音或没有声线 ID，也会被明确拒绝。',
      '如果是聊天中转报错，在 API 管理运行一次性与流式测试，并保留完整错误码。',
      '仍无法判断时，从报错卡片直接问芥末棉花糖或提交脱敏反馈。',
    ],
    actions: ['open-voice-api', 'open-main-api', 'open-debug-log'],
  },
  {
    id: 'chat-no-reply',
    title: '发消息后角色为什么没有回复？',
    keywords: ['角色没回复', '没回复', '没有回复', '不回复', '没点推进', '真人感回复', '真人模式'],
    answer: '默认聊天模式下，发送只会先保存你的气泡；输入框为空时，发送键会变成“推进”，需要再点一次才生成角色回复。开启该会话的“真人感回复”后，角色才会在你发送后按设定延迟自动接话。',
    steps: [
      '先看输入框右侧是否已变成“推进”，点它触发下一轮。',
      '想免手动推进：打开目标会话右上角详情，开启“真人感回复”。',
      '群聊没有私聊真人感主开关；需要手动推进，或在群聊详情开启“后台自动推进”。App 可运行时按设置间隔执行；被系统挂起时不会伪造离线期间的多轮历史，回到前台后会补跑当前一轮。',
      '已经点推进却仍没回复时，查看报错卡片和“上一轮原文”，再排查 API 或协议格式。',
    ],
    actions: ['open-chat', 'open-main-api'],
  },
  {
    id: 'recommended-settings',
    title: '新用户建议先打开哪些配置？',
    keywords: ['推荐配置', '建议配置', '新手配置', '真人感模式解析', '真人感模式是什么', '建议打开真人感', '怎么设置最好'],
    answer: '建议先保证主聊天 API 测试通过，再为常用私聊开启“真人感模式”，回复频率先用“适中”。自动日程是独立开关：需要角色每天拥有生活安排时再开启，不会再随真人感自动打开。',
    steps: [
      'API 管理：先完成主聊天 API 的一次性与流式测试；当前不建议使用 DeepSeek V4 承担棉花糖协议聊天。',
      '常用私聊：在会话详情或“他的手机→设置”打开真人感模式，回复频率先选“适中”；需要日程时，再单独打开紧邻的“自动生成日程”。',
      '每日主动上限默认 20，可在“他的手机→设置→主动来找你”改成任意正整数；统计面板会显示成功轮次、气泡数与失败原因。',
      '需要切后台后继续：再配置系统保活或后台中继；只在前台聊天时不必额外折腾。',
      '系统自动回复、固定间隔兜底和高频档不是必开项，先保持默认，确认确有需要再启用，避免机械回复和额外 API 调用。',
    ],
    actions: ['open-main-api', 'open-chat', 'open-contacts', 'open-keepalive'],
  },
  {
    id: 'character-not-proactive',
    title: '角色为什么不主动发消息？',
    keywords: ['不主动发消息', '没有主动消息', '角色不主动', '主动行为', '没日程', '日程不够主动'],
    answer: '先单独开启“允许主动行为”；真人感、自动日程和主动消息总开关彼此独立。角色主动来找你时仍会遵守日程、静音、线下状态、冷却与每日主动上限；“他的手机→设置”会显示最近调用和未发送原因。',
    steps: [
      '打开“他的手机→设置”，查看主动状态行和“今日主动”统计，先确认具体失败或暂缓原因。',
      '检查当前是否处于静音、线下互动或日程空档；日程空档时固定兜底可以接管。',
      '切后台后还想按时触发，需要开启系统保活；网页被系统彻底挂起时会等回前台补跑。',
    ],
    actions: ['open-calendar', 'open-keepalive', 'open-chat'],
  },
  {
    id: 'chat-css-import',
    title: '群里下载的聊天美化 CSS 在哪里导入？',
    keywords: ['群文件', '美化css', 'css主题', '主题预设', '预设在哪里导入', '聊天美化导入', '气泡css'],
    answer: '打开任意目标会话，进入右上角“详情”→“消息界面美化”。整页主题文件导入“整页 CSS”；只改气泡的文件按作者说明导入“我方气泡 CSS”或“对方气泡 CSS”，然后点“保存美化”。',
    steps: [
      '群聊详情里的“文件”目前是群应用预留入口，不是 CSS 导入位置。',
      '普通 .css 文件不是备份 JSON，不要从设置的数据导入入口导入。',
      '想在其它会话复用，填写预设名称后点“存为预设”；预设会在各会话详情的美化区共享。',
      '需要全局统一全部会话时，可在美化工作室选择“聊天对话”，发布全局聊天 CSS。',
    ],
    actions: ['open-chat', 'open-chat-beautify'],
  },
  {
    id: 'character-ai-fill',
    title: '怎样让 AI 补全角色卡？',
    keywords: ['AI补全角色卡', 'ai补全', '补全角色卡', '根据设定补全字段', '角色卡引导'],
    answer: '进入“通讯录”→打开或新建角色→“整段设定”，粘贴人物资料后点“根据设定补全字段”。它只补空白项，会先给出预览供你选择，不会直接覆盖已填写字段。',
    steps: [
      '先配置可用的主聊天 API，或启用工具模型并勾选“角色资料补全”；工具模型可用时优先使用，补全预览和失败弹层都会标明本次实际使用的模型。',
      '也可以上传 TXT/DOCX，全文会先放进“整段设定”，再交给 AI 理解。',
      '确认预览后应用，并记得保存角色；空回或格式无效时会显示模型与请求信息。工具模型失败后不会自动重复扣费，可在弹层里主动选择“改用主模型重试”。',
    ],
    actions: ['open-contacts', 'open-main-api'],
  },
  {
    id: 'character-speech-corpus',
    title: '怎样填写角色语料库？',
    keywords: ['语料库', '口吻不像', '说话节奏', '断句', '标点习惯', '行为模式', '不会玩梗', '容易生气', 'AI生成语料', '世界书'],
    answer: '进入“通讯录”→编辑角色→第二页“口吻与语料”，打开“语料工作台”。可以让 AI 依据角色资料与世界书先生成草稿，再逐项手改；“连续气泡样本”还能直接教模型一轮消息应该在哪里分条。',
    steps: [
      '直接生成时会按角色绑定与当前启用规则读取世界书；也可展开“参考世界书”，只选择口癖、断句、玩梗或文风规则相关的书。',
      '可以先写“日常一句或一个完整气口一条”，再按 TA 的真实习惯补充：是否会写长串口语、书面长句或连续分析，句号、省略号、空格和不用标点分别怎么用。',
      '要教具体断句时，在“连续气泡样本”里把同一轮发言逐行填写：一行就是一次真实发送，不同回合之间空一行。生成时会要求模型用多个 msg 复现这些边界，而不是重新挤进一个气泡。',
      '情绪与行为尽量用正向写法：比起“不会动不动生气”，更建议写“小事先确认情况；真正越界时会把问题点明，然后暂停聊天”。',
      '玩梗也写成情境：熟悉的梗怎样接、不懂时会顺着情绪接还是直接问、被调侃后会自嘲还是反击。不要把所有情况塞成一张禁词表。',
      'AI 只把草稿填进工作台，不会直接保存；修改后点“写入语料库”，再保存角色。已有的原话和手写内容会继续保留。',
    ],
    actions: ['open-contacts'],
  },
  {
    id: 'reply-rhythm',
    title: '为什么回复总是固定几条，或者断句很怪？',
    keywords: ['错落节奏', '错落有致', '固定条数', '2到4条', '气泡太少', '气泡太多', '断句', '分句', '半句话'],
    answer: '普通私聊没有默认条数或内置上限：日常先按“一句或一个完整气口一条”发送，再由角色语料决定是否保留长串口语、书面长句与自己的标点习惯。单次回应和持续追发都合法。',
    steps: [
      '“错落节奏”只在连续出现模板形状时提醒换表达方式，不会读取最近的具体条数后机械做加减，也不会照着用户的消息数量镜像回复。',
      '即时反应与随后解释、直接回答与新想到的补充、改口、追问或情绪加码通常分别发送；主谓宾、因果条件和引用内容仍保持完整，深谈与分析按逻辑段落发送。',
      '群聊会先判断话题波及面，再从被点名者和当事人的第一波回应继续推演接梗、补刀、纠正或灭火的第二波；公开热闹话题不会默认只停在两三个人。',
      '“短气泡回复”只把已有内容按自然口语拍子强制分句，不限制整轮总条数，也不会按 3～5 个字机械切片；需要固定数量时，单独开启会话详情里的“限定每轮气泡条数”。两者同时开启时，手动范围管总量，短气泡继续管单条分句。',
    ],
    actions: ['open-chat'],
  },
];

export function renderTutorialSection(sectionId) {
  switch (sectionId) {
    case 'overview':
      return renderOverviewSection();
    case 'beta':
      return renderBetaSection();
    case 'support':
      return renderSupportSection();
    case 'troubleshooting':
      return renderSupportFaqSection();
    case 'backup':
      return renderCloudBackupSection();
    case 'appearance':
      return renderAppearanceSection();
    case 'extensions':
      return renderExtensionsSection();
    case 'api':
      return renderApiSection();
    case 'search':
      return renderSearchApiSection();
    case 'image':
      return renderImageSection();
    case 'voice':
      return renderVoiceSection();
    case 'music':
      return renderMusicSection();
    case 'time':
      return renderTimeSection();
    case 'encounter':
      return renderEncounterSection();
    case 'map':
      return renderMapSection();
    case 'meituan':
      return renderMeituanSection();
    case 'interest':
      return renderInterestSection();
    case 'moments':
      return renderMomentsSection();
    case 'anonymous':
      return renderAnonymousSection();
    case 'legal':
      return renderLegalSection();
    default:
      return '';
  }
}

function renderOverviewSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-overview">
      <h2>棉花糖机能做什么</h2>
      <p>棉花糖机是一台本地存档优先的角色互动小手机。你可以把角色资料、聊天、日程、社交动态和生活记录放在同一个故事世界里慢慢养。</p>

      <h3>主要功能</h3>
      <ul class="tutorial-steps">
        <li><strong>通讯录</strong>：创建角色、分组、导入角色包，管理头像、称呼、资料与地图锚点。</li>
        <li><strong>聊天</strong>：私聊、群聊、转发、表情包、图片、语音与多种剧情事件。私聊、群聊与旁观群聊的工具栏「指导」可暂停扮演，与 AI 本体讨论纠偏；退出时可选择只用于下一次重 roll、在本段内生效或整理成长期指导，退出后指导气泡不再显示。</li>
        <li><strong>角色手机</strong>：查看角色日程、位置、相册、浏览记录、通话、音乐与生活痕迹。打开 TA 与别人的聊天时，输入框默认锁定；点「+ → 代发消息」可拿 TA 的手机代发文字。TA 会知道这次操作，收件人则可能没发现、觉得口吻不对或直接察觉；正文已经主动说明代发身份时会直接视为察觉。身份判断只影响知情边界，角色回复仍优先接消息本身。</li>
        <li><strong>社交空间</strong>：朋友圈、微博、论坛和匿名区，让角色在不同公共场景里留下动静。</li>
        <li><strong>音乐</strong>：试玩版可保存本地音乐与外链卡片；网易云后端仅在正式版开放。</li>
        <li><strong>记忆与世界书</strong>：沉淀关系进展、事件记忆、世界设定和 AU 设定。</li>
        <li><strong>外观与备份</strong>：切换主题、导入导出、完整备份和跨设备迁移。</li>
      </ul>

      <p class="tutorial-note">大部分数据保存在当前浏览器本地。换设备或清浏览器数据前，建议先导出完整备份。</p>
    </article>
  `;
}

function renderBetaSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-beta">
      <h2>使用须知</h2>
      <p>内测期功能与界面会频繁更新。遇到不懂的功能，优先打开<strong>设置 → 教程</strong>对应章节；版本变化可看<strong>设置 → 更新公告</strong>。</p>

      <h3>数据与备份</h3>
      <ul class="tutorial-steps">
        <li>聊天、角色、设置等主要保存在<strong>当前浏览器本地</strong>（IndexedDB）；只有主动启用加密云备份后才会写入用户连接的 GitHub 或 WebDAV。</li>
        <li>首次启动会尝试申请<strong>存储持久化</strong>，降低被系统自动清理的概率；可在 <strong>设置 → 本地存储保护</strong> 查看状态并手动申请。</li>
        <li><strong>iPhone</strong>：请尽量「添加到主屏幕」使用。Safari 标签页若约 7 天未打开本站，系统可能清掉本地数据（缓存与聊天会一起没）；主屏幕版不受这条限制。也请定期导出数据包，或启用加密云备份。</li>
        <li>换设备、清浏览器数据、卸载 PWA 前，务必先导出备份。数据较多或使用手机浏览器时，优先用<strong>设置 → 导出区域备份</strong>；它会逐份低内存整理，Android 通常按约 16MB 一卷保存。请把同一批文件全部保存后从「导入区域备份」一次选回。</li>
        <li>壁纸、语音、头像等资源需要时，再单独使用<strong>导出资源包 / 导入资源包</strong>；它不会混进区域备份。</li>
        <li>Android 轻量浏览器若下载一直停在 0 B，可在备份整理完成后改点<strong>系统分享</strong>，保存到系统文件或网盘；如果没有该按钮，说明当前浏览器没有开放文件分享能力，请改用 Chrome 或加密云备份。</li>
      </ul>

      <h3>后台活跃与通知</h3>
      <ul class="tutorial-steps">
        <li>网页版<strong>无法像原生 App 一样真正后台常驻</strong>。切到后台或锁屏后，浏览器会暂停或节流 JavaScript。</li>
        <li>需要角色自动发消息 / 角色手机主动推送时：打开设置，在 <strong>API 管理下方</strong>展开「系统保活」，或直接点<strong>「一键开启保活」</strong>自动展开并同时勾选后台活跃与静音音频保活；安卓 App 会接着引导放行系统省电。「后台消息通知」视情况另开。</li>
        <li>手动逐项开时建议顺序：后台活跃 → 静音音频保活 → 系统省电放行。安卓还可安装 PWA 全屏版；静音音频保活需在页面上点开，部分浏览器会拦截。</li>
        <li>生成中切后台：聊天与后台主动消息都会跟随当前会话所选 API 的<strong>流式输出</strong>开关，不再静默改成非流式。网页 / PWA 仍可能被系统冻结，普通第三方直连线路的长回复建议保持前台；自部署中继会在服务端接收流并在任务完成后取回全文。</li>
        <li>静音音频保活分两档：默认<strong>仅生成期间</strong>占用音轨，切出去时正在生成的回复尽量跑完、空闲不占系统播放器；需要角色<strong>自动发消息</strong>的请再打开「常驻静音保活」。此前已开启静音保活的用户自动保持常驻档。</li>
        <li><strong>后台任务中继</strong>（设置 → 后台任务中继）：推荐部署到<strong>自己的 Cloudflare</strong>。按弹窗顺序：①「生成并复制访问令牌」（App 自动生成，不用手编）；②「部署到 Cloudflare」；③若部署页没出现 <code>ADMIN_TOKEN</code>，到 Worker → Settings → Variables and Secrets 新建同名 Secret 并粘贴刚才的令牌；④打开中继 <code>/setup</code>，粘贴同一令牌，复制配置回 App 导入并测试。workers.dev 在部分网络下可能无法稳定直连，可能需要开启代理，或为 Worker 绑定可直连的自定义域名；手机代理只改善 App 到中继这一段。普通「测试连接」检查 Worker、令牌与加密；「测试完整线路」会再发一次极小模型请求，验证 Worker 能否访问当前 API。提示词仍由 App 提前编译加密同步，模型 API Key 跟当前线路走。固定间隔主动消息每次只预约一轮；App 取回并写入这一轮后，才会用包含新消息的上下文预约下一轮，避免离线期间重复执行同一份旧聊天。</li>
        <li>系统媒体控制 / 通知栏是否显示「正在播放」<strong>不一定准确</strong>（iOS、Android 都可能不显示），不代表保活没在运行；请以 <strong>设置 → 系统保活 → 静音音频保活</strong> 下方「已确认 HH:MM:SS」的时间是否持续更新为准。</li>
        <li>未接入 Cloudflare 中继时，回到前台会<strong>自动补跑</strong>遗漏任务；已接入时，聊天自动推进、闲置续聊和真人感延时回复都会在云端到点生成并在回前台后对账。中继可开「完成通知」（Web Push），任务完成由云端弹窗——浏览器/PWA 可用；原生 APK 被系统杀掉后通常仍收不到。云端生成中打开对应聊天会显示「正在输入」。已部署用户需重新部署 Worker 并执行最新迁移。日程、朋友圈、兴趣轮转等其它定时任务仍会补跑。</li>
      </ul>

      <h3>回复方式与主动来找你（几种机制的关系）</h3>
      <p>私聊的真人感回复在聊天设定里单独成组，紧跟在「对话相关」下方；组内也直接提供「允许 TA 主动来找你」。两项开关彼此独立：真人感只管对你消息的自动接话，主动总开关统一管理角色主动开口。角色级详细设置仍在 <strong>角色手机 → 设置</strong>：</p>
      <ul class="tutorial-steps">
        <li><strong>真人感回复（回复方式，不算主动找你）</strong>：开着它，你发完消息 TA 就会自己回，不用点推进——平时隔几秒到几十秒（回复频率低/适中/高决定快慢），你连发越多 TA 冒头越快；聊得火热时 TA 会「守着屏幕」，你一发消息几秒内就接话。这种快节奏接话是纯闲聊：TA 会少反问、不查岗、不催你去做事，表情包和一两个字的短回复都算正常发挥；想认真谈的话题 TA 会等你接了再展开。反过来 TA 说完你一直没回时，TA 也可能自己再开口（追发）：等你回应、或你们刚才聊得正热你突然不说话时，一两分钟就会顶一下（表情包、拍一拍、接着自己说，或带着刚刷到的东西回来）；问了没答，过几分钟也可能追问；就算什么扳机都没有，TA 说完话没人接，四到八分钟后也会自己看情况顶一下或选择保持沉默。追发不再只活在前台：你切后台、锁屏甚至关掉 App，TA 也会按拍子自己决定要不要再开口——同一段沉默最多三拍，一拍比一拍隔得久、情绪逐拍递进（先轻轻顶一下，再有点起伏，最后一拍多半是放下手机去过自己的日子）；哪一拍 TA 都可以选择不发消息，只留下动作痕迹：改一句顶栏状态、发条动态、给谁点赞留言、备忘录记一笔、去别的窗口跟别人吐两句槽。拍数用完也不等于从此失联：话题自然冷掉后，隔大半天到一两天 TA 还可能带着自己的新鲜事回来重新开话头（不翻旧账、不追问「怎么不理我」；同一段沉默最多两次，之后才真的等你先开口）。追发与冷场重启属于主动开口，只有「允许主动行为」开启时才会排程；两者也会遵守静音时段。TA 说了「稍后回来」时不追也不秒回，等 TA 自己到点回来；但你连发大约五条消息会把 TA 提前震回来，当场接话、原定点作废。忙碌时段的自动回复：TA 设了忙碌/离线类状态并挂了自动回复时，你来消息会先弹那条自动回复（不调 AI）；大约连发五六条并过一会儿才会被戳醒真回，之后可能抽空隔十几二十分钟再回，再回到自动回复循环，直到 TA 自己取消状态。聊天设定还可选开「允许完全下线」（默认关闭）：开启后，TA 在手机上交、睡死、断网或按人设真的决定不理人时，可自己定下线时长；期间连发多少条都不会收到回复，也不会弹系统自动回复，只有你手动点「推进」才会让 TA 重新判断。TA 也可预先决定中途是否扫一眼；扫一眼只会改状态、发动态或处理别处社交，不会回复当前私聊。你和该角色正在进行一场未收纳的线下时，追发与其它主动消息都会暂停（人就在对面），你发消息后的接话不受影响；线下总结收纳后恢复。TA 也可能故意等一会儿或忙完/睡醒才回：说「稍后回来」时顶栏状态由 TA 按人设自己定（如「去洗澡」），TA 没定时才兜底显示「稍后回来」或离线，到点恢复在线。<strong>正常接话和零 API 的忙碌系统自动回复单独开启真人感就能用</strong>；追发与闲置续聊还需要开启「允许主动行为」。你人不在（切后台、锁屏、关掉 App）时，闲置续聊链路会自动替真人感值班——本地保活、回 App 补跑、云端到点生成都走它，到点由 TA 接上；切后台错过的秒级接话，回到会话页也会自动补上。接了云端中继时通知也能到：浏览器 / PWA 开「完成通知」走 Web Push；安卓 APK 则在云端计划到点时用系统闹钟唤醒 App 取回消息并弹通知（需允许「闹钟与提醒」并开「后台消息通知」）。有日程时作参考、没有也照常工作；后台生成不再受共用的每日 API 次数封顶。</li>
        <li><strong>手动状态优先</strong>：你在聊天详情手动切到「忙碌」或「离线」后，真人感自动接话与后台补跑都会暂停；切回「在线」后恢复，手动点「推进」仍可临时回应。「允许 TA 自行完全下线」只是授予角色自主进入彻底下线的权限，不代表打开开关后已经下线。</li>
        <li><strong>闲置后自动续聊（私聊主推）</strong>：你发完消息后，从<strong>停止点输入框</strong>开始计时（还在输入时不计时）；到点且 TA 还没回，就会自动续一轮。不依赖 Cloudflare，本地保活或回 App 补跑都能用；接了中继时也会在云端到点生成。开了真人感回复的私聊会自动采用对应等待节奏，无需再开；但它属于主动开口，只有「允许主动行为」开启时才会实际生成。</li>
        <li><strong>按日程主动（主动来找你）</strong>：按角色当天日程，在合适的时间点主动来找你。次数少、更像生活事件；需要开「允许主动行为」。</li>
        <li><strong>固定间隔兜底（主动来找你）</strong>：角色手机详细设置里的老机制，同样归「允许主动行为」管；群聊详情仍保留「后台自动推进」。私聊详情已改用闲置续聊，不再用会话级固定推进。</li>
        <li><strong>应用内邮箱</strong>：写信时可从收件人里选择角色，并指定日常、问候、道歉、邀请、近况、长信、事务或玩笑类型；发给角色或回复角色来信后，TA 会结合邮件串、更长的私聊、世界书、分层记忆、用户卡与当前场景自然回信。邮箱顶部的「生成来信」可按来源、通讯录分组或指定角色手动生成一封；「邮箱预设」可设置定时来信来源、20–160 条私聊上下文（默认 80）、主动邮件类型倾向和自定义指令。聊天设定的「偶尔写邮件」默认关闭，开启后默认最短 72 小时一封，可调为 12–720 小时；它会遵守主动总开关、静音时段、每日上限和主动消息防撞。邮件仍只存在于棉花糖机内，不会发到真实邮箱。</li>
        <li><strong>主动总开关</strong>：关闭「允许主动行为」后，追发、冷场重启、闲置续聊、日程主动、到点备忘、周期关心、分享冲动、主动邮件、拉黑后的站外联系与社交跟进都会停止；已排队的主动任务和云端计划也会取消。你刚发来消息后的真人感正常接话、邮箱内对你来信的回信、明确承诺的稍后回复、忙碌系统自动回复，以及群聊自己的「后台自动推进」仍按各自开关工作。追发自身与「主动消息统一下限」都默认 20 分钟；统一下限为 0 时不额外覆盖，填正数时所有主动消息都会服从这个更严格的下限。</li>
        <li><strong>拉黑后的联系</strong>：原会话手动推进仍会显示发送失败，定时尝试也先经历两轮主账号失败；之后角色可按人设改用独立邮箱或社交小号。尝试频率继续使用聊天设定里的用户数值，不限制为最多一次；邮件只在主屏「邮箱」App 中出现，小号只进入 Chat 的陌生消息，不会混成普通聊天气泡。</li>
        <li><strong>朋友圈跟进（主动来找你）</strong>：你发朋友圈后，开了真人感且允许主动行为的角色可能稍后转进私聊回应。</li>
        <li><strong>角色手机会话托管</strong>：只处理 TA 与其他联系人之间的手机会话，不会进入你所在的主私聊或群聊；你发消息后的自动接话只由真人感回复控制。</li>
        <li><strong>自主建群</strong>：私聊的跨窗联动里可单独关闭角色自主建群，也可设置两次成功建群之间的 AI 回合冷却；默认 12 回合，填 0 表示不限制。冷却期间仍可续写已有群。</li>
        <li><strong>主动分享链接</strong>：兴趣页的真实链接分享，只决定「分享什么内容」；什么时候开口仍由上面的机制决定。</li>
        <li><strong>聊完顺手做点别的</strong>：聊天中角色可能顺势去发朋友圈/微博/论坛帖、给你或提到的角色的动态点赞留言（你在 TA 朋友圈留了言时会按楼中楼接住，并更常稍后回私聊提一句；别人动态上的安静互动则看你们熟不熟）、说一句「我去刷会儿论坛」几分钟后带着刷到的东西回来分享；已有小号的角色偶尔（至少隔一天）会用小号往陌生消息里冒个泡。这些动作各有冷却，不需要单独设置，也没有共用的每日 API 次数上限。</li>
        <li><strong>原心声连续参考</strong>：聊天设定 → 心声设定中的「原心声参考条数」决定下一轮读取多少条近期脑内话，未设置时默认 5 条。它只是近期心理细节的上下文窗口，不会删除更早心声；旧会话已显式保存的 0～8 仍使用原值。</li>
        <li><strong>表达欲与错落</strong>：角色会按人物、最新输入、当前情绪、未完话题与生活触发判断本轮表达欲，再用符合本人习惯的气口说完真实内容。表达欲高不等于固定多发几条，也不要求依次交出经历、观点和追问：可以是一段连贯表达，也可以自然追发；表达欲低时仍可一句收住。系统不会靠复述、空反问或无关话题补气泡。</li>
        <li><strong>更爱发语音</strong>：聊天设定里可为单个会话打开，TA 会更常用语音条代替打字；默认关闭时完全跟随人设。</li>
        <li><strong>表情频率</strong>：聊天设定 → 表情管理可分别调整表情包、正文 Emoji / 颜文字和消息贴表情的频率。低频只在明显合适时偶尔用，高频会更积极但不会强制每轮出现；系统会轮换候选并暂时避开最近用过的同一项。角色编辑页的「常用 Emoji / 颜文字」用于正文，聊天设定里的颜文字库用于消息贴表情，两者互不替代。</li>
        <li><strong>顶栏状态与当前场景</strong>：角色换地点、开始或结束一件事、忙闲变化或上线离线时，会同步更新在线态，并写一句符合新场景的公开心情。顶栏像个性签名，不会直接复述地点和正在做什么；真实场景仍单独维护，用来约束聊天、真人感回复、日程和群像连续性。同一场景里的微小动作不会反复刷新。顶栏放不下时，点状态短句可查看完整内容。聊天设定里可以手动选择在线、忙碌或离线，并填写公开短句；圆点依次为绿、黄、红。手动忙碌与手动离线都会暂停真人感自动接话和追发；切回在线后恢复，手动点推进仍可重新判断。「允许 AI 修改公开短句」和「允许 AI 修改在线状态」可以分别开关，例如只让角色按日程上下线，同时固定公开短句。状态小剧场会在这次转场确有值得展开的小插曲时出现。</li>
        <li><strong>静音时段</strong>：在角色手机「主动来找你」里可开关，设定几点到几点不主动找你（可跨午夜）。闲置续聊、日程主动、固定兜底、朋友圈跟进、分享冲动等都会遵守；你发消息后的真人感正常接话不受影响。</li>
        <li><strong>线下进行中</strong>：你和某角色有一场未收纳的线下时，该角色的日程主动、闲置续聊、真人感追发、固定兜底、分享冲动、延时回复等到点主动消息都会暂停；你主动发消息后的真人感接话仍可用。总结收纳后恢复。</li>
      </ul>

      <h3>加强保活：省电与自启动权限</h3>
      <ul class="tutorial-steps">
        <li><strong>安卓 · 电池优化</strong>：设置 → 电池（或应用管理 → 找到 Chrome / 已安装的独立应用）→ 把它的电量管理调成「无限制 / 不受限制」，取消系统默认的省电限制。已装 APK 的可直接在<strong>设置 → 系统保活 → 系统省电设置</strong>里一键跳转。</li>
        <li><strong>小米 / 华为 / OPPO / vivo 等机型</strong>：除电池优化外还有单独的「自启动管理」「后台运行权限」「锁屏清理白名单」，位置因机型而异（常见路径：设置 → 应用管理 → 权限管理 / 自启动管理），都建议放行，否则电池优化放开了也可能被单独清理。</li>
        <li><strong>iOS · 低电量模式</strong>：低电量模式会额外限制后台活动，保活时建议关闭（设置 → 电池 → 低电量模式）。</li>
        <li><strong>iOS · 静音/勿扰开关</strong>：部分机型在打开机身静音开关或勿扰模式时，循环播放的静音音频会在一段时间后被系统中断；如果保活总在静音模式下失效，可以先切到响铃档测试排查。</li>
        <li><strong>iOS · 灵动岛/音轨占着不放</strong>：先回 App 关掉「静音音频保活」或「后台活跃」，再划掉 PWA；若仍异常，完全关闭 Safari/PWA 后重开一次即可释放系统播放会话。</li>
      </ul>

      <h3>账号与激活码</h3>
      <ul class="tutorial-steps">
        <li>一枚激活码只能注册<strong>一个账号</strong>，注册后与该账号密码绑定，不可转赠或重复注册。</li>
        <li>请妥善保管账号密码。在新设备登录会让<strong>旧设备自动下线</strong>。</li>
      </ul>

      <h3>推荐浏览器</h3>
      <ul class="tutorial-steps">
        <li><strong>优先使用 Chrome 或 Edge</strong>（电脑 / 安卓手机均可）。</li>
        <li>iOS 可用 Safari，但部分功能以 Chrome / Edge 体验更稳。</li>
        <li><strong>不要用 QQ、微信内置浏览器</strong>打开本站——容易白屏或一直加载。若从聊天里点链接，请选「在浏览器中打开」。</li>
        <li>请关闭无痕 / 隐私模式，并允许本站保存 Cookie。</li>
      </ul>

      <h3>打不开 / 一直加载怎么办</h3>
      <ol class="tutorial-steps">
        <li>确认已用系统 Chrome、Edge 或 Safari 打开当前试玩地址。</li>
        <li>页面无法启动时打开当前域名下的 <code>/recovery</code>，清理试玩静态缓存后重开；本地聊天数据不会被删除。</li>
        <li>若急救页确认角色、聊天、消息、用户和设置均为 0，先去其他设备或其他打开方式查找备份。确认接受从空档开始后，可点「确认空库并继续」解除旧库保护；它不会删除数据库，也无法找回已经不在当前库里的数据。</li>
        <li>若浏览器标签页能打开、主屏 App / PWA 每次都打不开，也直接使用上面的「修复更新并重启」；完整校验完成后会自动从当前页面重进。</li>
        <li>若是<strong>上传自定义全局 CSS 后按钮失效 / 卡死</strong>：急救页点「清除自定义美化 CSS 后重进」（只清自定义 CSS，角色与聊天保留）。更新修复不会改动这份本地美化数据。</li>
        <li>仍失败：在首页地址后加 <code>?debug=1</code>，等几秒后把<strong>屏幕底部黑色错误日志</strong>截图发给维护者。</li>
        <li>若连急救页都打不开：换网络（Wi‑Fi / 流量）、关闭 VPN 后重试。<strong>不要</strong>用系统里的「清除本站数据 / 清除网站数据」当修复——那会删掉角色和聊天。应先想办法打开急救页导出数据包，或从其他设备的数据包 / 云备份恢复。</li>
      </ol>

      <h3>反馈 bug 或提优化建议</h3>
      <p>描述越具体，修复越快。请尽量包含以下信息：</p>
      <ul class="tutorial-steps">
        <li><strong>在哪个页面</strong>：例如「通讯录 → 编辑角色」「某条聊天 → 发送图片后」。</li>
        <li><strong>做了什么</strong>：按顺序写操作步骤，1、2、3…</li>
        <li><strong>期望 vs 实际</strong>：你本来希望发生什么，实际发生了什么。</li>
        <li><strong>截图</strong>：有报错弹窗、白屏、底部 debug 日志、recovery 诊断页，请一并附上。</li>
        <li><strong>环境</strong>：手机型号 / 系统版本 / 浏览器名称（如 Chrome 121）。</li>
      </ul>
      <p class="tutorial-note">内测功能未完全稳定，感谢耐心。更新后会写在「更新公告」，重要排障说明也会同步进本页。</p>
    </article>
  `;
}

function renderCloudBackupSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-backup">
      <h2>加密云备份</h2>
      <ol class="tutorial-steps">
        <li>在 <strong>设置 → 加密云备份</strong> 选择 GitHub，点「连接 GitHub」并在 GitHub 页面完成授权；应用会自动创建专用私有仓库。</li>
        <li>使用 WebDAV 时先选择服务商，打开对应的官方设置入口并创建应用密码；固定地址会自动填写，专属地址按服务商页面显示的内容复制。</li>
        <li>设置一个加密密码，再点「测试连接」；连接成功后可立即备份或开启自动备份。</li>
        <li>恢复前先确认选中的备份显示为完整；恢复会替换数据包内容，再合并资源包。</li>
      </ol>
      <h3>删除 GitHub 备份仓库</h3>
      <ol class="tutorial-steps">
        <li>先确认手机里的角色、聊天等本地数据仍可正常打开；如果还想留一份副本，先在设置中导出数据包。删除 GitHub 仓库只会清掉云端备份，不会删除当前设备里的本地数据。</li>
        <li>在<strong>设置 → 加密云备份</strong>记下当前 GitHub 用户名和仓库名（通常是 <code>marshmallow-cloud-backup</code>），再点「断开」。断开只会清除本机保存的 GitHub 授权，不会自动删除仓库。</li>
        <li>登录 GitHub，打开头像菜单中的 <strong>Your repositories</strong>，进入刚才记下的仓库。先核对仓库完整名称和 <strong>Private</strong> 标记，不要误删其他项目仓库。</li>
        <li>进入仓库的 <strong>Settings → General</strong>，滑到页面底部的 <strong>Danger Zone</strong>，点击 <strong>Delete this repository</strong>。</li>
        <li>按 GitHub 页面提示继续确认，并输入页面要求的仓库完整名称。最后点击红色删除按钮；完成后，这个仓库里的所有棉花糖机云备份都会一并删除。</li>
      </ol>
      <p class="tutorial-note">以后重新连接 GitHub 时，棉花糖机会自动创建一个新的同名私有仓库，但旧备份不会跟着回来。误删后可尽快前往 GitHub 个人设置的 <strong>Repositories → Deleted repositories</strong> 查看是否能恢复；GitHub 说明部分仓库可在删除后 90 天内恢复，但并非所有仓库都符合条件。详细规则以 <a href="https://docs.github.com/en/repositories/creating-and-managing-repositories/deleting-a-repository" target="_blank" rel="noopener noreferrer">GitHub 官方删除说明</a>为准。</p>
      <h3>WebDAV 服务商怎么选</h3>
      <ul class="tutorial-steps">
        <li><strong>Koofr</strong>：10 GB 免费空间、文件大小不限，连接地址固定；适合备份中包含大体积语音和图片的用户。使用注册邮箱和单独生成的应用密码。</li>
        <li><strong>InfiniCLOUD</strong>：20 GB 免费空间，支持大文件；需要从 My Page 复制每个账号专属的连接地址、Connection ID 和 Apps Password。</li>
        <li><strong>坚果云</strong>：国内访问和应用密码设置较方便，但官方 WebDAV 默认单文件上限为 500 MB；资源包可能超过该限制时不要选它。</li>
        <li><strong>Nextcloud / 其他</strong>：适合已经拥有自建网盘或兼容 WebDAV 服务的用户，填写服务端提供的个人 WebDAV 目录地址。</li>
      </ul>
      <p class="tutorial-note">服务商只会收到设备端加密后的文件。Koofr、InfiniCLOUD 等公共 WebDAV 不一定允许网页跨域直连；「测试连接」失败且提示跨域时，需要使用自己控制的同源代理，不能使用公共反代。</p>
      <h3>加密与密码</h3>
      <ul class="tutorial-steps">
        <li>数据包和资源包沿用手动导入导出格式，上传前在设备上分块加密。</li>
        <li>加密密码、GitHub 授权和 WebDAV 凭据只保存在当前设备，不会写入云端清单；清理浏览器数据前请自行记住加密密码。</li>
        <li>忘记加密密码无法恢复，服务端也不能代为找回。</li>
      </ul>
      <h3>网络与自动备份</h3>
      <ul class="tutorial-steps">
        <li>GitHub 不需要 WebDAV 反代；部分网络访问 GitHub 不稳定时，连接、备份或恢复可能需要更换网络或使用代理。</li>
        <li>浏览器直连要求 WebDAV 服务允许 CORS，并放行 PROPFIND、PUT、GET、DELETE 与 Authorization 请求头。</li>
        <li>服务不支持跨域时，可部署自己的同源 WebDAV 代理，并把地址填为代理目录；不要使用不可信的公共代理。</li>
        <li>自动备份默认关闭，达到设定间隔后会在应用运行且设置模块已加载时执行，并按保留份数清理较旧的完整备份。</li>
      </ul>
    </article>
  `;
}

function renderAppearanceSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-appearance">
      <h2>美化工作室</h2>
      <ol class="tutorial-steps">
        <li>主屏分成两个互不混用的入口：<strong>整套外观</strong>给当前主屏骨架换整套 CSS；<strong>自定义组件</strong>从零生成独立 HTML 组件，不读取海 / 手账 / 窗的旧组件清单。</li>
        <li>自定义组件生成后先放进组件工作台，可直接编辑 HTML、选择占几格（宽×高，对齐主屏 4 列图标网格）和目标页；海 / 窗主题还能选择透明、轻玻璃或毛玻璃底面。关闭快捷改色时完全使用组件自己的 HTML/CSS。真实主屏上长按可拖动；移出主屏只会收进组件库，可再次添加，只有「永久删除」才会清掉组件代码和图片。</li>
        <li>其它页面可从组件列表点中要修改的位置；当前页面、选择器、公开变量和正在编辑的 CSS 会自动作为 AI 上下文。AI 返回的 CSS 可一键应用并立即预览，也支持参考图和角色共装修。</li>
        <li>选择<strong>心声</strong>可直接描述想要的字段、数值范围和视觉风格；AI 会同时生成字段规则、内容 HTML、弹层与消息内 CSS。预览确认后保存为心声预设，再到会话详情的心声设置中套用。</li>
        <li>选择「线下沉浸」会自动预览最近一场仍在进行的线下，并按顶栏、场景与叙事、走向选项、展开工具区、底部输入区列出真实结构；发布后写入线下页面原有的 CSS 槽，与线下页「美化界面」编辑的是同一份样式。</li>
        <li>编辑器里的 CSS 是<strong>草稿</strong>，只在预览生效；点「发布生效」才会应用到整个 App（每页只保留最新一次发布）。「保存方案」是存档，收在工作室首页「保存的方案」列表里，随时可打开回填再发布。</li>
        <li>聊天对话页推荐用「<strong>存为聊天预设</strong>」：预设出现在 会话详情 → 美化 → 预设 里，想给哪个会话用就给哪个套，互不影响；「全局生效」才是所有会话统一套用（单个会话自己的美化仍优先）。</li>
        <li>图片素材上传后会得到 <code>mm-img://</code> 地址；保存发布时自动解析。方案可导出 CSS，局部样式可另存为组件并重复添加到主屏。</li>
        <li>自定义 CSS 若导致按钮点不到，使用工作室里的<strong>急救：停用全部自定义 CSS</strong>。如果页面已打不开，在地址后加 <code>?safe-mode=1</code>；连续三次启动失败也会自动进入安全模式。</li>
        <li>旧版<strong>美化设置</strong>继续保留，可管理主题、壁纸、字体、App 图标及完整主题包；图标图片、显示名称、底框开关和底框透明度统一在「图标与名称」中调整。</li>
        <li>线下进行页的自定义 CSS 写坏、按钮点不到时：到 <strong>美化设置 → 自定义 CSS → 清空线下 CSS（急救）</strong>（只清线下 CSS，保留底色/底图等）；这与全站自定义 CSS 不是同一份数据。</li>
      </ol>
      <p class="tutorial-note">壁纸、字体、App 图标请在对应区块直接上传，不用写 CSS。想整机搬家或分享完整外观（含壁纸/图标/布局），用「主题包 → 导出主题 / 导入主题」；字体属于设备级个人资源，不会写入主题包，接收方会保留自己的字体。粘贴 AI 生成的 <code>${THEME_EXPORT_TYPE}</code> JSON 也会存成新主题预设。主屏装饰组件支持删除与恢复；App 入口数量与路由固定不变。</p>
    </article>
  `;
}

function renderExtensionsSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-extensions">
      <h2>扩展组件支持范围</h2>
      <p>扩展库用于制作嵌入聊天和线下叙事的<strong>内容卡片</strong>，不是完整网页或浏览器插件。编辑器会完整保存你粘贴的源码；预览和正式显示使用安全版本，不支持的能力不会执行。直接粘贴完整 HTML 文档时，会读取 <code>body</code> 内容及 <code>head</code> 中的内联 <code>style</code>。</p>
      <h3>可以使用</h3>
      <ul class="tutorial-steps">
        <li><strong>结构标签</strong>：<code>style</code>、<code>div</code>、<code>span</code>、<code>p</code>、<code>small</code>、<code>strong</code>、<code>em</code>、<code>b</code>、<code>i</code>、<code>u</code>、<code>br</code>、<code>hr</code>、<code>section</code>、<code>article</code>、<code>header</code>、<code>footer</code>、<code>h1</code>～<code>h4</code>、列表、<code>details</code>、<code>summary</code>、<code>button</code>、<code>a</code>、<code>img</code>。</li>
        <li><strong>属性</strong>：<code>class</code>、<code>id</code>、<code>title</code>、<code>alt</code>、<code>hidden</code>、<code>role</code>、<code>href</code>、<code>src</code>、<code>target</code>、安全的内联 <code>style</code>、<code>aria-*</code>，以及下方的内置交互属性。</li>
        <li><strong>样式</strong>：颜色、背景色、边框、圆角、阴影、盒模型、Grid、Flex、宽高、间距、字体、文字排版、溢出、透明度、变换、过渡、列表、图片裁切和 CSS 自定义变量。CSS 只作用于当前卡片。</li>
        <li><strong>图片与链接</strong>：图片可用 HTTPS、站内路径或图片 Data URL；链接支持 HTTPS、<code>mailto:</code> 与 <code>tel:</code>，点击后由 App 的链接预览接管。</li>
        <li><strong>模板字段</strong>：内置 <code>{{title}}</code>、<code>{{content}}</code>、<code>{{name}}</code>，也可写 <code>{{任意字段}}</code>；内容由模型以纯文本字段填充，不把模型返回当 HTML 执行。</li>
      </ul>
      <h3>不会执行或显示</h3>
      <table class="tutorial-table">
        <thead><tr><th>不支持</th><th>原因与替代方式</th></tr></thead>
        <tbody>
          <tr><td><code>script</code> 与 <code>onclick</code> 等事件</td><td>避免读取页面数据或执行任意代码。展开、弹窗、链接请改用内置 <code>data-action</code>。</td></tr>
          <tr><td><code>iframe</code>、<code>object</code>、<code>embed</code>、<code>form</code></td><td>避免嵌入外部页面、伪造输入界面或提交本地内容。</td></tr>
          <tr><td><code>link</code>、<code>meta</code>、<code>base</code>、<code>@import</code>、<code>@font-face</code></td><td>不允许组件改变文档环境或静默加载外部样式与字体；请把 CSS 直接写进 <code>style</code>。</td></tr>
          <tr><td>SVG、Canvas、音视频、表单控件、自定义标签</td><td>当前内容卡契约没有开放这些元素；图形请使用安全图片或普通 HTML/CSS 绘制。</td></tr>
          <tr><td>CSS <code>url(...)</code></td><td>避免样式在后台发起外部请求。图片请使用 <code>&lt;img src="..."&gt;</code>。</td></tr>
          <tr><td><code>position</code>、定位边、<code>z-index</code>、<code>pointer-events</code>、动画、滤镜</td><td>避免卡片越出自己的消息区域、覆盖按钮或制造全屏点击层；请用 Grid、Flex、Transform 和 Transition 完成卡片内布局。</td></tr>
          <tr><td><code>javascript:</code>、可执行 Data URL、<code>expression()</code></td><td>属于可执行地址或旧式脚本能力，会直接移除。</td></tr>
        </tbody>
      </table>
      <h3>内置交互写法</h3>
      <ul class="tutorial-steps">
        <li><code>data-action="toggle" data-target="#detail"</code>：显示或隐藏当前卡片里的目标节点。</li>
        <li><code>data-action="dialog" data-title="标题" data-content="正文"</code>：打开 App 内的安全正文弹窗。</li>
        <li><code>data-action="link" data-url="https://…"</code>：交给 App 的链接预览打开。</li>
      </ul>
      <h3>数量与文件限制</h3>
      <p>单个 HTML / CSS 模板<strong>没有硬字符数上限</strong>，实际可用空间取决于设备存储。扩展库最多保留 80 个组件；单次 JSON 导入文件不超过 4 MB；内容规则最多 2000 字；关键词最多 30 个，每个最多 60 字。</p>
      <p class="tutorial-note">源码里即使含有不支持的片段，也会保留在编辑器和导出文件中，只是不会进入安全预览。分享到应用商店时会拒绝仍含脚本、事件、嵌入页或危险外链的源码，需要先改成上面的内置交互。</p>
    </article>
  `;
}

function renderApiSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-api">
      <h2>API 地址怎么填</h2>
      <p>使用 OpenAI 兼容协议时，聊天模型、工具模型、兼容生图等需要填「根地址」，<strong>不用手动加 <code>/v1</code></strong>。程序会自动拼接 <code>/v1/chat/completions</code>、<code>/v1/models</code> 等路径。</p>
      <div class="tutorial-example">
        <span class="tutorial-example-label">推荐写法</span>
        <code>https://api.xxx.com</code>
      </div>
      <div class="tutorial-example is-bad">
        <span class="tutorial-example-label">不必写成</span>
        <code>https://api.xxx.com/v1</code>
      </div>
      <p class="tutorial-note">若你使用中继或自建反代，只要保证根地址能访问到 OpenAI 兼容接口即可。本地调试也可用相对路径，例如 <code>/api</code>。</p>
      <h3>Google Gemini 官方接口</h3>
      <p>若使用 Google AI Studio 的 Gemini API Key，在聊天、场景或工具模型中把「接口协议」选为 <strong>Google Gemini 原生</strong>。API 地址可留空，程序会直连 <code>generativelanguage.googleapis.com/v1beta</code>，并自动使用 <code>x-goog-api-key</code>、<code>generateContent</code> 与原生流式接口。</p>
      <p class="tutorial-note">该选项面向 AI Studio API Key，不是 Vertex AI 的项目级 OAuth 接入。使用提供 OpenAI 兼容地址的 Gemini 中转时，仍应选择「OpenAI 兼容」。</p>
      <h3>Claude 官方接口</h3>
      <p>若使用 Anthropic API Key，把「接口协议」选为 <strong>Claude 官方原生</strong>。API 地址可留空，程序会直连 <code>api.anthropic.com/v1</code>，并自动使用 <code>x-api-key</code>、<code>anthropic-version</code> 与 Messages API。采样方式建议保持「自动」；若要手动调整，Temperature 与 Top P 只选其一。</p>
      <p class="tutorial-note">使用提供 OpenAI 兼容地址的 Claude 中转时，仍应选择「OpenAI 兼容」。浏览器直连会按 Anthropic 的 BYOK 方式启用跨域访问，密钥仍只保存在当前设备。</p>
      <h3>向量模型</h3>
      <p>入口在 <strong>API 管理 → 向量</strong>。选择“硅基流动”会自动填入官方根地址，也可以选“自定义”并填写任意支持 <code>/v1/embeddings</code> 的根地址；再填写 Key 与模型名后测试连接。中文记忆检索可用硅基流动的 <code>Qwen/Qwen3-Embedding-8B</code>（维度建议 1024），也可用 Voyage 的 <code>https://api.voyageai.com</code> 与 <code>voyage-4</code>；若服务不提供模型列表接口，直接手填模型名即可。不配置也不影响聊天。</p>
      <p class="tutorial-note">更换模型或维度后，旧索引会在后台渐进重建。向量请求由你填写的第三方服务计费，棉花糖机不代理、不经手账单。</p>
      <h3>记忆衰退</h3>
      <p>入口在<strong>聊天详情 → 记忆 → 高级记忆设置</strong>。此功能默认关闭，由用户按需要手动开启。开启后，旧记忆只会退出每轮常驻，不会被删除；再次聊到相关人物、事情、关键词或日期时，本地仍会把它找回来，不需要配置向量。</p>
      <ul>
        <li><strong>常驻时间可自定义</strong>：与用户相关默认 48 小时；群聊旁支、朋友圈 / 微博、论坛 / 拦截默认均为 24 小时。</li>
        <li><strong>外围内容更快安静</strong>：群聊闲聊、社交动态和论坛杂讯会更早退出每轮上下文，避免长期挤占剧情与关系进展。</li>
        <li><strong>关闭即可恢复旧逻辑</strong>：关闭「记忆逐渐退出常驻」后，聊天摘要与剧情长卷继续按原方式常驻。</li>
      </ul>
      <h3>向量记忆</h3>
      <p>启用并配置好向量模型后，聊天记忆会自动使用混合检索，不需要再到每个聊天单独打开开关。向量会增强近义表达的召回，但不是记忆衰退功能的前提，也不会删除数据库里的原始记忆。</p>
      <ul>
        <li><strong>召回本窗历史原文</strong>：默认最近 100 条消息仍按原对话直接发送；更早的同窗口消息按小段建立向量索引，当前话题命中时只召回少量真实原文，不会与最近上下文重复。</li>
        <li><strong>召回线下原文</strong>：线下档案除摘要外也会按当时在场范围索引原始过程；以后提到相关地点、约定或细节时，可补回对应选段，未在场角色不会读取。</li>
        <li><strong>手动精简归档</strong>：在记忆馆的剧情长卷或感情事件中点「精简记忆」，勾选多条记录并确认精简稿。之后只有精简结果常驻；原记录仍保留，开启向量时按话题召回，没有向量时不再自动注入。精简结果可以继续合并，也可以撤销恢复。</li>
        <li><strong>没有向量也有兜底</strong>：本地会按当前出现的具体关键词，从最近上下文之外的同窗旧消息与角色亲历的线下档案中最多补回两段原文；它能接住同词细节，但不具备向量的近义语义理解。</li>
        <li><strong>后台近重复降级</strong>：同一窗口、知情范围、可见性和状态下高度相似的普通记忆、结构化事实与事件记忆会标记为重复，不再参与后续注入。</li>
        <li><strong>查看与重试索引</strong>：记忆馆的「向量记忆」会直接列出可搜索、整理中和需重试的具体内容。失败项会显示简短原因与自动重试时间；修好向量设置后可重新尝试单条或全部失败项。</li>
      </ul>
      <p class="tutorial-note">向量只负责索引、查重和按需召回，不会自己编写摘要。索引尚未完成或接口暂时不可用时，会使用日期与本地关键词兜底。</p>
      <h3>世界书向量管理</h3>
          <p>世界书不会跟随记忆自动切换。需要时在<strong>世界书 → 向量管理</strong>单独开启；开启后包括「常驻」在内的条目都会通过关键词、向量或本地词面按需取用。超长条目会按段建立索引，命中时只读取相关段落；关闭后恢复原有常驻与关键词规则。</p>
      <h3>全局前置系统提示词</h3>
      <p>在<strong>世界书 → 添加 → 全局前置系统提示词</strong>中填写。它会用于所有内容文本生成，包括聊天、线下、番外、总结与工具 API；留空即不注入。API 连通性检测与脱敏客服诊断不会读取。</p>
      <h3>流式与失败处理</h3>
      <ul>
        <li><strong>流式输出</strong>：聊天与场景默认开，工具模型默认关、可单独开启。聊天页、角色主动消息与后台中继都会跟随当前会话实际选中的 API 预设；流式能边收边保留半截，部分中转对流式更挑，可按线路分别选择。</li>
        <li><strong>失败后不自动重试</strong>：聊天、场景和工具模型的一次请求失败后只显示错误，由你手动决定是否重试；旧备份里保存过的自动重试状态也不会继续生效。</li>
        <li><strong>缺失译文自动补全</strong>：在「工具模型 → 缺失译文」中开启，默认关闭。开启后聊天、角色手机和广播剧生成漏译时，每个生成批次最多追加一次批量补译请求；手动点“翻译”不受这个开关影响。</li>
        <li><strong>非流式</strong>：整段生成完才返回，后台长回复有时更稳，但等待期间看不到进度，中途被掐可能整段没有。</li>
        <li><strong>失败不自动重发</strong>：空回、截断、断流或 JSON 格式异常会直接显示失败；系统不会切换流式/非流式、调用修复模型或改走另一条模型线路。需要重试时由你手动决定，避免按次计费线路重复扣费。</li>
      </ul>
    </article>
  `;
}

function renderSearchApiSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-search">
      <h2>搜索 API 怎么选</h2>
      <p>入口在 <strong>API 管理 → 搜索</strong>。这里接的是通用联网搜索（角色查证、素材搜集等用），跟下方「小红书/微博深度解析」（TikHub，专门抓社媒笔记）是两套完全独立的服务，互不影响。</p>
      <p class="tutorial-note"><strong>棉花糖机本身不提供、不代理、不代销任何搜索服务</strong>，也不从中抽成或获利。下面列的都是市面上通用的第三方搜索接口服务商，你需要自己去对应官网注册账号、拿自己的 Key 填进来（BYOK）。费率、免费额度、账单都由对应厂商自己的规则决定，会随时调整，<strong>请以各官网最新定价页为准</strong>；棉花糖机与这些厂商没有合作关系，出现价格变化、服务故障、账号问题等，请直接联系对应厂商，不是本应用能处理的范围。</p>

      <h3>几家的定位差异</h3>
      <table class="tutorial-table">
        <thead>
          <tr><th>服务商</th><th>定位</th><th>免费额度（参考，会变）</th><th>大致价格（参考，会变）</th></tr>
        </thead>
        <tbody>
          <tr><td>Tavily</td><td>面向 AI/RAG 场景设计的聚合搜索，直接给整理过的摘要结果，接入最省事</td><td>每月约 1000 次，不用绑卡</td><td>超出后按量计费，之后有阶梯月付套餐</td></tr>
          <tr><td>Exa</td><td>语义/神经搜索，按「意思」找内容而不是关键词匹配，适合找相似主题的深度内容</td><td>新账号有一次性赠额，部分渠道另有小额月度赠额</td><td>按请求量计费，取内容正文另计费</td></tr>
          <tr><td>Brave</td><td>独立搜索索引（不依赖 Google/Bing），结果风格更「网页原生」</td><td>已取消无门槛免费档，现在开账号要绑卡，每月给一小笔额度抵扣</td><td>按千次请求计费；额度用完从卡里自动扣款，且需要在你的产品里挂「Powered by Brave」署名才能保留这笔月度额度</td></tr>
          <tr><td>SerpAPI</td><td>直接抓 Google 搜索结果页（SERP），结构化程度高、贴近你自己搜 Google 看到的东西</td><td>每月一小笔免费额度，不用绑卡</td><td>按月订阅套餐计费，超额需升级套餐</td></tr>
          <tr><td>SearchApi.io</td><td>同类 SERP 抓取服务，定位与 SerpAPI 接近，属于替代/备用选项</td><td>提供一小笔一次性免费测试额度，不用绑卡</td><td>按月订阅套餐计费，只有真正抓成功的请求才计费</td></tr>
        </tbody>
      </table>
      <p class="tutorial-note">没有「哪个最好」的统一答案：只是想让角色偶尔查证个新梗/新活动，Tavily 或 SerpAPI 的免费额度通常就够用；追求搜索结果风格更接近真实点开 Google 的观感，可以试 SerpAPI/SearchApi；不差预算、想要更贴合语义的搜索，可以看 Exa。</p>

      <h3>页面里几个搜索相关的设置项</h3>
      <table class="tutorial-table">
        <thead>
          <tr><th>设置项</th><th>作用</th></tr>
        </thead>
        <tbody>
          <tr><td>默认 Provider</td><td>主搜索渠道，优先用它出结果</td></tr>
          <tr><td>搜索池瀑布流</td><td>开启后，默认渠道失败或没结果时，会按「并入 Exa / 允许 Brave / 允许 SerpAPI / 允许 SearchApi」里勾选的顺序自动换下一家兜底；只想用一家就把这个关掉</td></tr>
          <tr><td>聊天联网查证</td><td>角色遇到需要确认的时效性内容时，允许现场发起一次真实联网搜索再回复；每日有独立的调用上限</td></tr>
          <tr><td>每日上限 / 缓存天数 / 单次结果数</td><td>控制搜索花费节奏：结果会按关键词缓存一段时间，同一天/同一词不会重复联网</td></tr>
        </tbody>
      </table>
      <p class="tutorial-note">只填一家 Key 也能正常用，「搜索池瀑布流」和多家 Key 只是为了在某一家没搜到或临时故障时有个备用，不是必须全部配齐。</p>
    </article>
  `;
}

function renderImageSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-image">
      <h2>生图：NovelAI 与兼容生图</h2>
      <p>入口在 <strong>API 管理 → 生图</strong>。这里有两条独立的生图引擎，可以同时配置：</p>
      <ul class="tutorial-steps">
        <li><strong>NovelAI</strong>：二次元 / 插画风，<strong>可以画人物、角色、脸、自拍</strong>，提示词用英文标签（Danbooru tag）。</li>
<li><strong>兼容生图</strong>：可选 OpenAI Images 兼容中转、Gemini 中转 Chat Completions 或 Google Gemini 原生协议；默认生活证据图<strong>无脸</strong>、偏写实质感，人物画风可选日系/韩系/2.5D 等，不强制真人。提示词用英文自然语言。</li>
      </ul>

      <h3>NovelAI 怎么填</h3>
      <ul class="tutorial-steps">
        <li><strong>地址</strong>：用<strong>本站官方部署</strong>的话，地址<strong>直接留空即可</strong>——本站自带 NovelAI 直连代理，填上官方 Key 就能出图。第三方中转分两类：①<strong>官方协议</strong>（有 <code>/ai/generate-image</code>）——只填站点根，或粘贴完整端点；②<strong>OpenAI 兼容 NovelAI</strong>（如空悲切）——填 <code>https://中转/v1</code>，程序会走 <code>/v1/chat/completions</code>，并从返回的 markdown Data URI 取图（也支持负面词 / 尺寸 / seed）。<span class="tutorial-note">注：浏览器直连官方常被跨域（CORS）拦，本站留空之所以能用，是因为请求走了本站自己的同源代理。</span></li>
        <li><strong>Key</strong>：NovelAI 订阅的持久 Token（或中转站给的 Key）。</li>
        <li><strong>模型</strong>：可从下拉选常用模型（如 <code>nai-diffusion-4-5-full</code>），也可手填。</li>
        <li><strong>尺寸</strong>：竖图 / 横图 / 方图按需选。</li>
        <li><strong>正向提示词前缀 / 质量词</strong>：每次生图都会自动拼上，建议放画风、质感、质量 tag。</li>
        <li><strong>负面提示词</strong>：留空用内置默认（去低质、坏手等）；可自行覆盖。</li>
        <li>打开「<strong>启用 NovelAI</strong>」开关，点「<strong>测试 NovelAI</strong>」会直接弹出返回的图片，确认通了再用。</li>
      </ul>
      <p class="tutorial-note">兼容生图同理：选 OpenAI Compatible，填地址、Key、模型，点「测试生图」验证。两个测试成功后都会弹图预览。兼容生图也可填<strong>负面提示词</strong>（留空不附加），每次生图会自动追加 Avoid 引导，适合写不要文字、水印、畸形手等。</p>
      <p class="tutorial-note"><strong>图片返回方式</strong>仅用于 OpenAI Compatible：默认“自动”会优先请求 Base64，兼容性最好；线路经常在等待生图或接收大响应时断开，可改成“链接优先”，让接口先返回较小的图片地址，再由 App 下载并保存到本机，可降低大段 Base64 在长连接中途断开的概率；如果中转只支持 Base64，则选“Base64（单次直传）”。链接模式只能缓解返回大图时的断线，若连接在服务端仍生成时就被代理关闭，仍需提高中转读取超时或使用异步任务线路。</p>
      <p class="tutorial-note">测试报 <strong>404 page not found</strong>：基本是「地址」填错。官方协议中转只填站点根；OpenAI 兼容 NovelAI（空悲切等）请填带 <code>/v1</code> 的根地址。如果那个中转<strong>只有</strong> OpenAI Images（<code>/v1/images/generations</code>）、没有 chat 绘图能力，也可以配到「兼容生图」一栏（此时没有负面词 / 采样器）。报 401/403 则是 Key 无效或订阅无权限。</p>
      <p class="tutorial-note">中转已经返回图片地址、但旧 APK 因跨域或原生桥版本过旧无法读取时，会由本站安全取回这张<strong>已经生成</strong>的图片；该兜底不会再次请求生图。仅支持公网 HTTPS 图片，HTTP、局域网与本机地址不会转发。</p>
      <p class="tutorial-note">提示“等待约 N 秒后失败 / 结果未知”表示生成请求已持续一段时间，连接在等待结果时被中转、反向代理或移动网络断开；这不同于刚发出就失败的跨域或证书问题。先到中转后台检查是否已有生成和计费记录，确认没有结果后再重 roll。若总在接近 150 秒时断开，需要让中转维护者提高长请求读取超时，或改用支持任务 ID 查询的异步生图线路。</p>

      <h3>聊天里角色发图用哪个引擎</h3>
      <p>在生图页的「<strong>聊天生图引擎</strong>」选择，AI 会按所选引擎自动写对应格式的提示词：</p>
      <ul class="tutorial-steps">
        <li><strong>人物用 NovelAI，其余用兼容生图</strong>（推荐）：画人/角色/自拍走 NovelAI 标签，画场景 / 食物 / 物件走兼容引擎无脸生活图。</li>
        <li><strong>全部 NovelAI</strong>：所有聊天图都走 NovelAI。</li>
        <li><strong>全部兼容生图</strong>：所有聊天图都走兼容引擎（默认无脸生活证据图；开了人物画风后可出人物照）。</li>
      </ul>
      <p class="tutorial-note">只要启用了任意一个引擎，聊天里的角色就能发图；两个都没启用则不会生图。</p>
      <p class="tutorial-note">尺寸：NovelAI 和兼容生图都可在生图页选择固定尺寸，聊天生图与重画会优先沿用该尺寸，不再被 AI 的画幅建议覆盖。对生成的图不满意时，长按气泡选「改提示词重画」或在大图页点「改词重画」，可以直接编辑这张图的提示词再重新生成。</p>

      <h3>画风预设（内置保底模板）</h3>
      <p>生图页有两个全局默认画风，角色和直播间可以各自覆盖：</p>
      <ul class="tutorial-steps">
        <li><strong>NovelAI 默认画风</strong>：内置「厚涂」「平涂」两套通用画师串，没有自配画师串时兜底；已在「正向提示词前缀」里写了自己的画师串就选「不套用」。</li>
        <li><strong>兼容人物画风</strong>：自定义 / 日系清透 / 韩式偶像 / 欧系随和 / 欧系精致 / 2.5次元。选了「自定义」或具体档位后，兼容引擎画人物可<strong>露脸</strong>（不强制真人，2.5D 等档位可走精修数字风），并自动附带颜值稳定与防噪点防扭曲守则；「自定义」不叠加任何命名风格，只按你自己写的外观描述出图；不选（关）则人物照维持无脸生活图。具体样貌以角色人设为准。</li>
        <li><strong>角色专属画风</strong>：通讯录 → 编辑角色 →「专属画风」。每个角色可以选不同画风和引擎（比如一个走兼容引擎韩系/2.5D、一个走 NovelAI 厚涂），聊天发图、朋友圈/微博配图、相册、线下场景图都会跟着走。</li>
        <li><strong>直播间画风</strong>：直播间设置 →「画面画风」，只对本直播间生效，优先级高于全局默认。</li>
      </ul>
      <p class="tutorial-note">优先级：直播间局内选择 → 角色专属画风 → 全局默认。画风词由系统自动拼接，不用写进外观描述里。</p>

      <h3>给通讯录角色 AI 描绘</h3>
      <ol class="tutorial-steps">
        <li>进 <strong>通讯录 → 编辑角色</strong>，在「生图外观描述」里写好外貌 / 发型 / 穿搭（NovelAI 下可直接写英文标签效果更稳）。</li>
        <li>点头像区的「<strong>AI 描绘</strong>」，按这段描述生成角色形象。</li>
        <li>满意后点「<strong>设为头像</strong>」，记得保存。</li>
      </ol>
      <p class="tutorial-note">角色描绘优先用 NovelAI（更适合画人物）；没启用 NovelAI 时会回退到兼容生图。</p>

      <h3>生图锁定（让角色跨场景保持同一张脸）</h3>
      <p>在「生图外观描述」下方的「生图锁定 · 锁人设」里选档位，聊天发图、朋友圈/微博配图、AI 描绘/生成预览都会自动套用：</p>
      <ul class="tutorial-steps">
        <li><strong>提示词锁定</strong>：任意引擎可用。把锁定的外观描述并入每次生图提示词，最省事但只是「文字层面像」，不保证像素级一致。</li>
        <li><strong>Seed 锁定</strong>：仅 NovelAI。固定同一个 seed，同一句提示词能复现同一张图；换场景/换动作后仍可能跑偏，建议配合提示词锁定一起用。</li>
        <li><strong>参考图锁定</strong>：可以单独上传一张图，或用「生成预览」的结果点「设为锁定参考图」，作为专属参考图（不会跟着头像变动，最准）；没设置专属参考图时才回落用当前头像。NovelAI 官方协议走 Vibe Transfer；OpenAI Chat 形态的 NAI 中转会把参考图等比补边到所选生成尺寸后再提交，避免 i2i 因尺寸不一致被拒。兼容生图走 gpt-image 编辑接口（软锁脸，效果因中转/模型而异，不是所有中转都支持 <code>/v1/images/edits</code>）。兼容人物画风关闭时，无脸规则优先于锁脸：手部、背影和身体局部只保留发型、衣着、体型等非脸部线索，不会提交正脸参考图。</li>
        <li><strong>多人形象锁定</strong>：GPT Image 2 支持一次提交 user 与多个角色的参考图。在线聊天手动生图可在「锁定画面人物」中勾选主体；线下场景会按实际在场者自动带入，最多 4 人。多人生成仍可能偶尔串脸，重 roll 会继续沿用同一组主体。</li>
      </ul>
      <p class="tutorial-note">头像可能会被换成别的东西（比如风景、表情包），不如专属参考图准；建议给要锁脸的角色单独上传或生成一张专属参考图。</p>
    </article>
  `;
}

function renderVoiceSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-voice">
      <h2>语音（角色语音消息）</h2>
      <p>入口在 <strong>API 管理 → 语音</strong>。可以选择 <strong>MiniMax</strong> 或 <strong>Fish Audio</strong> 作为语音合成（TTS）提供商，用来把角色的语音气泡或文字台词真正念出来；不配置也不影响正常聊天。</p>
      <p class="tutorial-note">棉花糖机不提供语音额度。MiniMax 需要自己的 API Key；Fish Audio 需要自己的 API Key 与声音模型 ID。网页版调用 MiniMax 或 Fish 官方 TTS 时会经本站做一次不落地的同源转发，以兼容不同浏览器的鉴权与跨域限制；Key、文本与音频不会持久保存。费率、免费额度和账单以各平台官网为准。</p>

      <h3>Fish Audio 官方入口</h3>
      <p class="tutorial-note"><strong>只认准 <code>fish.audio</code>。</strong><code>fishaudio.org</code> 由其他公司独立运营，不是 Fish Audio 官方服务，请勿在那里登录或充值。</p>
      <ol class="tutorial-steps">
        <li>从 <a href="https://fish.audio/auth/signup" target="_blank" rel="noopener noreferrer">Fish Audio 官方注册页</a>注册或登录。</li>
        <li>进入 <a href="https://fish.audio/app/api-keys/" target="_blank" rel="noopener noreferrer">官方 API Keys 页面</a>创建并复制自己的 Key。</li>
        <li>回到<strong>API 管理 → 语音</strong>填写 Key；接口地址保持默认的 <code>https://api.fish.audio</code>，无需自行搜索或修改。</li>
      </ol>

      <h3>怎么填</h3>
      <table class="tutorial-table">
        <thead>
          <tr><th>设置项</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr><td>语音提供商</td><td>MiniMax 与 Fish Audio 的配置会分别保留，切换提供商不会覆盖另一边的 Key</td></tr>
          <tr><td>MiniMax 接口区域</td><td>按 MiniMax 账号所在区域选（国内站 / Global / US West），选错会连不上或鉴权失败</td></tr>
          <tr><td>接口地址</td><td>MiniMax 会按区域自动带出；Fish 默认显示 <code>https://api.fish.audio</code>。网页版使用官方地址时会自动经本站同源转发；只有使用可信自建中转时才需要修改</td></tr>
          <tr><td>MiniMax API Key</td><td>在 MiniMax 开放平台的接口密钥页生成，并与所选接口区域保持一致</td></tr>
          <tr><td>Fish API Key / 模型</td><td>只从 <a href="https://fish.audio/app/api-keys/" target="_blank" rel="noopener noreferrer">fish.audio 官方控制台</a>生成密钥；模型推荐使用 <code>s2.1-pro-free</code></td></tr>
          <tr><td>Fish 音频格式</td><td>默认使用 44.1 kHz WAV；也可选择更省空间的 MP3，并在 64 / 128 / 192 kbps 间选择码率。切换格式后会生成独立缓存</td></tr>
          <tr><td>TTS 模型</td><td>MiniMax 可选 <code>speech-2.8-hd</code> 等模型；Fish 默认使用 S2.1 Pro Free，也可以用「自定义」手填其他模型标识</td></tr>
          <tr><td>语言增强</td><td>告诉模型这段文本大概是什么语言/方言，帮助发音更准；不确定就用「自动识别」</td></tr>
          <tr><td>默认语速 / 音量 / 音调</td><td>合成语音的基础参数，角色单独设置的语音风格可在此基础上再调。MiniMax 音量是倍率；Fish 音量是 dB，正数更响、负数更轻</td></tr>
          <tr><td>Fish 温度 / Top P</td><td>温度越高表演变化越多、越低越稳定；建议先从 0.7 / 0.7 开始实测，同一句重新生成也可能得到不同结果</td></tr>
          <tr><td>Fish 分块参数</td><td>「保持分块连续」会让同一次长文本的后续分块参考前文声音；分块长度越大通常越连贯，但首段等待也可能更久</td></tr>
          <tr><td>Fish 音质保护</td><td>调用 Fish 官方 quality-guard 检查本次合成质量；逐气泡仍是独立采样，偶发不满意的片段可在清除语音缓存后重新生成</td></tr>
          <tr><td>Fish 测试连通性</td><td>只检查模型查询接口和 API Key，不会生成音频或产生 TTS 费用；模型查询与真正的 TTS 合成不是同一条浏览器跨域链路，因此测试成功只代表 Key 可用。结果仍会标明网络通道、HTTP 状态和耗时</td></tr>
        </tbody>
      </table>

      <p>角色声线在 <strong>通讯录 → 编辑角色 → 语音 / 视频</strong> 填写。「语音提供商」可选跟随全局，也可以让某个角色固定使用 MiniMax 或 Fish Audio。两家配置分成两组：除了各自的 voice_id / reference_id，语速、音量、情绪也互不覆盖；Fish 还能为单个角色覆盖温度、Top P 和英文表演指导，留空则跟随 Fish 全局值。</p>

      <h3>语音世界书 / 自然度相关开关</h3>
      <ul class="tutorial-steps">
        <li><strong>语音世界书</strong>：MiniMax 与 Fish 各自保存一份自定义补充，并使用不同的内置指导。MiniMax 侧重精确停顿与原生声音标签；Fish 侧使用 S2 方括号自然语言提示和 direction，避免把 MiniMax 规则原样套过去。切换提供商即可编辑对应世界书。</li>
        <li><strong>旁白与语音演绎</strong>：私聊和普通群聊都可在「会话详情」单独开启。群聊旁白会按同一现场穿插成员动作，语音演绎则按实际发言成员分别使用各自声线；旁白只展示文字，不参与朗读。只有点播放时才调用当前选择的语音提供商，不会因为收到消息就在后台自动合成。</li>
        <li><strong>旁白音效</strong>：开启后，AI 会根据本机音频库实际存在的分类，在真实动作发生的旁白或角色对白上附加隐藏音效计划；它不显示也不朗读。持续纹理开始后会在本轮后续对白中保持，直到动作停止或切换；长对白会优先选择较长素材，超过约 2.2 秒的单次音效也会与随后对白并行，不会阻塞角色开口。音频库的「分类」里可以新增自己的分类，为它填写触发说明，并选择单次事件、持续纹理或背景循环；单条纹理还可设置自动、短触发或整段，并为偏小素材选择增强；「最近调用」会列出实际随机播放到的具体素材。AI 读取的是分类名与触发说明，不会试听音频；涉及非常具体的环节时，最好由用户亲自拆分并写清“什么时候才可调用”。动作音量控制单次声音与持续纹理，背景音量控制环境循环与 BGM；背景滑块使用低档更细的听感曲线，与对白同播时 BGM 还会明显让路，持续纹理只留峰值余量，滑到 0 均为彻底静音。音频库由当前浏览器、主屏 App 或 APK 内的所有用户身份共享，切换身份不会变空。正文关键词识别仍作为旧回复兜底。</li>
        <li><strong>音频包兼容</strong>：直接导入散装音频时可先选分类，也可进入管理模式后批量移动；不要求改名。自己制作 ZIP 音频包时，包内文件名写成「分类 ID<code>--</code>自定义标题」，例如 <code>kiss--轻吻01.mp3</code>；自定义分类包还可在 <code>PACK-INFO.json</code> 里携带分类名称、触发说明和混音层级，导入后会一并建立。旧版固定分类包仍可照常导入。导入时会在本机先检查每条音频能否解码，当前设备不支持的条目会跳过；iPhone / iPad 跨版本最稳妥的格式是 MP3、M4A 和 WAV，Ogg Vorbis 需要 iOS / iPadOS 17.4 或更高版本。</li>
        <li><strong>本轮连续播放</strong>：开启后每轮只保留一个播放键。MiniMax 会在适合时连贯合成；Fish 为保留短句表演会逐气泡合成，再由播放器插入真实静音。同一轮含多个角色时，会按各自选择的提供商分别生成。会话详情可将气泡间隔调为 0.2～5 秒，穿插旁白时会额外留白。</li>
        <li><strong>通话回复显示</strong>：普通通话可在每个私聊的会话详情选择“多段显示”或“整段显示”，陪伴通话可在「陪伴 → 设置 → 通话」单独选择。整段模式只合并记录显示，语音仍会在后台按安全气口逐句播放；外语或方言漏掉任一句就地译文时会提示重新生成，不会另发请求补译。</li>
        <li><strong>导出缓存语音</strong>：长按已经播放并缓存过的角色气泡，可以导出该条音频；属于完整连播轮次时还可以导出整轮。整轮多段音频会合成为带真实气泡间隔的 WAV。导出只读取本地缓存，不会重新生成或计费。</li>
        <li><strong>管理本机缓存</strong>：在「API 管理 → 语音」的缓存卡片点「管理缓存」，可以逐条试听、导出或删除，也可以一次清空当前浏览器或 APK 内的全部语音缓存。</li>
        <li><strong>自然停顿 / 轻微情绪 / 原生情绪</strong>：控制合成时是否加入停顿标记和情绪起伏；「原生情绪」调用的是模型自身情绪能力，效果因模型而异。</li>
        <li><strong>Fish 表演指导</strong>：每个气泡可带简短英文 direction；明确贴近、压低声音或只说给对方听时可使用轻柔耳语，普通亲密对话不会默认全程耳语。局部吸气、换气、呼气或轻笑仍会转换成 Fish S2 能理解的方括号自然语言提示；低吼、咆哮和舞台腔会被克制处理。Fish 不负责精确气泡秒数，跨气泡间隔由播放器执行。</li>
        <li><strong>电话、陪伴、主播与剧情</strong>：语音/视频电话、陪伴语音、主播、线下剧情和番外剧场分别使用适合该场景的内置指导。线下与番外只为角色真正说出口的直接对白生成语音，旁白、动作、心理、用户台词和翻译不会朗读；多人场景按实际发言角色分别使用其声线。</li>
        <li><strong>过滤括号动作</strong>：朗读前自动去掉台词里的「（笑）」「（叹气）」这类动作/括注，转写仍会显示、只是不念出来；与「语音世界书」开关无关，默认开启。</li>
        <li><strong>停顿力度</strong>：整体调快/调慢句子间的停顿节奏。</li>
      </ul>
      <p class="tutorial-note">语音会按内容缓存，同一句台词不会重复计费合成；像「嗯」「好」这样的自然短句也会正常合成。</p>

      <h3>语音输入（听写）</h3>
      <p>这是反方向的能力：把你说的话转成文字。APK 会把听写交给当前输入法；网页端则可在 <strong>API 管理 → 语音 → 语音输入（听写）</strong> 配置浏览器听写或转写接口。它和上面的语音合成互相独立。</p>
      <p class="tutorial-note"><strong>棉花糖机不提供、不代理这项服务</strong>：转写按音频时长/请求量计费，如果由棉花糖机统一出钱调用，成本会随所有用户的使用量线性上涨、没法控制，所以和搜索、生图一样走 BYOK（自己去对应平台注册、拿自己的 Key 填进来）。费率、免费额度以各官网最新页面为准，账号/账单问题请直接找对应平台，不是棉花糖机能处理的范围。</p>

      <h3>转写接口去哪找</h3>
      <table class="tutorial-table">
        <thead>
          <tr><th>服务商</th><th>定位</th><th>免费额度</th><th>接口地址怎么填</th></tr>
        </thead>
        <tbody>
          <tr><td>硅基流动</td><td>国内可直连，托管 SenseVoiceSmall（中文识别效果好、速度快，也是不少手机 App 用的识别模型）</td><td>SenseVoiceSmall 目前免费</td><td><code>https://api.siliconflow.cn</code>，模型填 <code>FunAudioLLM/SenseVoiceSmall</code></td></tr>
          <tr><td>Groq</td><td>托管 Whisper，识别速度很快</td><td>有免费额度，具体以官网为准</td><td><code>https://api.groq.com/openai</code>，模型填 <code>whisper-large-v3</code></td></tr>
          <tr><td>OpenAI 官方 / 中转站</td><td>标准 Whisper 接口，兼容性最好；不少你已在用的聊天中转站也顺带代理了转写接口</td><td>看服务商政策，多数按量计费</td><td>填官方或中转的根地址，模型填 <code>whisper-1</code></td></tr>
        </tbody>
      </table>
      <p class="tutorial-note">没有强制要求用哪家：只是偶尔用「按住说话」，硅基流动的免费额度通常够用；已经在用某个聊天中转站的话，先看它是否顺带支持 <code>/audio/transcriptions</code>，能用的话不用再单独注册一家。</p>

      <h3>填参数</h3>
      <table class="tutorial-table">
        <thead>
          <tr><th>设置项</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr><td>识别方式</td><td>「浏览器原生优先」用系统自带的听写能力，免费但看环境脸色；「录音 + 转写接口」走你自己配的接口，各环境表现一致</td></tr>
          <tr><td>接口地址</td><td>填 OpenAI 兼容服务的根地址即可（会自动拼 /v1/audio/transcriptions），也可以直接粘贴完整转写端点；要求该服务支持音频转写，普通聊天模型接口通常不支持</td></tr>
          <tr><td>模型</td><td>常见是 <code>whisper-1</code>，以你所用服务的文档为准</td></tr>
          <tr><td>语言</td><td>默认 <code>zh</code>（中文），说别的语言时改成对应代码</td></tr>
        </tbody>
      </table>
      <ul class="tutorial-steps">
        <li><strong>各环境差异</strong>：原生听写只有 <strong>Chrome</strong>（Android/电脑）真正可用，且<strong>走 Google 语音服务，需要 HTTPS 且能访问外网</strong>；<strong>Edge / Brave / Opera 虽然有同名接口，但没有识别服务，永远不出结果</strong>，会自动改走转写接口。iOS 上 Safari 浏览器里可用，但<strong>加到主屏幕的 App 里系统不开放原生听写</strong>，这种情况必须配转写接口才能用语音输入。</li>
        <li><strong>APK 输入法听写</strong>：聊天里打开输入法听写；语音通话直接点输入框，视频通话先点「输入」，再使用键盘自带的麦克风。录音与识别由输入法处理，棉花糖机不申请麦克风权限，只接收转换后的文字；是否提供语音键取决于当前输入法。</li>
        <li><strong>推荐做法</strong>：识别方式保持「浏览器原生优先」即可——原生不可用时会自动改走你配好的转写接口，两头都不用管。</li>
        <li>网页端配好后点「测试听写」说一句话，能看到识别结果就说明整条链路是通的。</li>
      </ul>
      <p class="tutorial-note">转写接口按音频时长计费（以服务商为准）；棉花糖机不提供、不代理这项服务，Key 只存在你自己的设备里。</p>
    </article>
  `;
}

function renderMusicSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-music">
      <h2>网易云音乐</h2>
      <p>试玩版暂未连接网易云后端；正式版可以直接扫码登录。试玩期间仍可上传本地音乐或保存音乐外链。</p>

      <h3>试玩范围</h3>
      <ul class="tutorial-steps">
        <li>试玩版不会请求网易云登录、搜索、歌单或播放代理。</li>
        <li>本地音乐和外链功能不受影响。</li>
      </ul>

      <p class="tutorial-note">正式版中的扫码登录不会要求用户填写网易云开发者 Key。</p>
    </article>
  `;
}

function renderTimeSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-time">
      <h2>虚拟时间线</h2>
      <p>默认是<strong>现实同步</strong>：故事里的「现在」跟手机真实钟点一致。想跑长线剧情、线下快进或把对话挪到假期氛围里，可切到<strong>虚拟时间</strong>。</p>

      <h3>入口</h3>
      <p>主屏 Dock「日程表」，或 <strong>设置 → 日程表 / 世界时间</strong>。快捷悬浮球里的「剧情时间」可直接暂停、续接当前聊天末条或推进常用跨度，不必退出聊天。</p>

      <h3>两种模式</h3>
      <ul class="tutorial-steps">
        <li><strong>现实同步</strong>：不维护独立故事时钟，适合日常闲聊。</li>
        <li><strong>虚拟时间</strong>：故事有自己的日期与钟点；推进、跳转后，主屏时钟与日历、聊天（含秘密基地）、微博、朋友圈、匿名墙 / 匿名空间、旅行相关生成都会按该时刻理解「今天、昨晚、假期」。</li>
      </ul>
      <p>「我的时区」默认跟随设备，也可选择常用城市对应的 IANA 时区。现实同步会按所选时区显示当前钟点，日历日期、备忘录入、到点提醒和 AI 的时间感知会一起换算；切换时区不会改变真实时间戳。</p>
      <p>虚拟时间可开启「切到后台时暂停剧情时间」：锁屏或切去别的 App 后故事钟会冻结，回来再从离开时刻继续；悬浮球里也可以随时手动暂停或继续。</p>

      <h3>推进与跳转</h3>
      <p>日程表里可 +30 分 / +1 天、选跨度推进，或跳到指定日期时间。普通聊天及角色手机内私聊、群聊的「线下小剧场」可单独写片段，也可选择让故事时间一起流逝。</p>
      <p>打开「时间与假期设置」时会先弹出注意事项：把时间轴调到已有对话之前后，继续聊天会把该窗口里晚于新时刻的消息尾段整体对齐到新的世界时间，保留气泡先后，但原先显示的日期和钟点会变化。想保留原时间线时建议另开档位；只想体验过去片段也可使用「相遇 · 时光机」。</p>

      <h3>节假日注入</h3>
      <p>开启后，若当前日期落在内置 civic 假期（元旦、春节、清明、劳动、端午、暑期、中秋、国庆等近似区间），会向角色侧 prompt 补一句假期语境，方便自然聊出行、宅家、聚会节奏。<strong>不含赛季、战队等专业设定。</strong></p>

      <h3>给 AI 的契约（摘要）</h3>
      <p>角色台词里的时间词一律按「世界内锚点」理解；消息时间戳在同一条虚拟轴上排序；若距上条消息已过 ≥10 分钟，会额外收到「时间流逝提示」，鼓励自然续接或场景推进。</p>

      <h3>日程备忘</h3>
      <p>点日历上的某一天可展开新建备忘：只填标题和时间，就是让 AI 知道你接下来有什么安排的普通备忘；如果顺手选一位角色「到点让 TA 提醒我」，到了那个时间点 TA 会主动来找你聊这件事。聊天里跟角色说「到时候提醒我」，TA 也会自己把这件事记进日程表——这类备忘会在日期下方显示为角色的白色小卡片，到点触发后自动标记完成。</p>

      <h3>经期记录</h3>
      <p>在日历选中某天点「记一天」即可登记一次开始日，系统会按记录自动估算周期；开启关心提醒后可以多选知道这件事的 TA。聊天里明确说经期来了、正在来或现在是第几天时，当前 TA 也会自动加入知情范围并在本地记下，不会再询问是否记录。当前状态会逐日更新，直到你明确告诉记录它的 TA 已经结束。预测日期不是实际记录。</p>
    </article>
  `;
}

function renderEncounterSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-encounter">
      <h2>相遇 · 线下沉浸</h2>
      <p>「相遇」里的约会探索、音声线下与一起旅行会开一段线下沉浸：不走聊天气泡，而是一轮轮推进，收纳后写进共同回忆。</p>

      <h3>进入方式</h3>
      <ul class="tutorial-steps">
        <li><strong>首页双入口</strong>：「约会探索」进入普通线下，支持多人和长叙事；「音声线下」进入单角色的第二人称音声演出，旁白静音，只朗读角色直接对白。</li>
        <li><strong>聊天跳转</strong>：从聊天的「直接进线下」或邀约卡进入时，先选择普通线下或音声线下；已有未收纳会话则直接恢复原模式，不会再次询问。</li>
        <li><strong>直接进入</strong>：约线下页所有字段可留空，点「直接进入 · 承接聊天」即可从线上聊天的语境自然落到线下，TA 会自己推断此刻在哪、为什么见面。</li>
        <li><strong>邀约直达</strong>：TA 在聊天里发来的邀约卡，点进去不用再填任何表单，地点活动都沿用聊好的内容。</li>
        <li><strong>初遇</strong>：相遇页的「初遇」入口可以选一个还没加入通讯录的角色（新建草稿或导入角色包），先见一面；这场收纳后 TA 才正式写进通讯录，卷宗成为你们的第一条共同回忆。</li>
        <li><strong>番外剧场</strong>：开场时可以多选角色，也可以切换“用户参与 / 无用户”。无用户模式只让所选角色进入故事，用户仅作为存档归属与场外导演，导演方向不会被当成台词，场景图也不会补入用户。番外始终保存在独立剧场，不写进真实记忆；手动分享时，同一份脑洞会分别发到参与角色各自的私聊。</li>
      </ul>

      <h3>线下进行中</h3>
      <ul class="tutorial-steps">
        <li>本场模式开始后固定：普通线下与音声线下不能在叙事设置里中途互切。音声正文使用短旁白与角色对白交替的脚本结构，选项是用户可以直接说出口的对白；不想消耗语音额度时，可在叙事设置里关闭「自动生成角色语音」，继续只看字幕推进。</li>
        <li>音声舞台右上角菜单的「舞台美化」可选择跟随应用、日间或夜间模式，并调整宋体/黑体/圆体/自定义字体族、正文与强调字色、字号、行距和字幕纸浓度。音声自定义 CSS 与普通线下美化互相隔离，面板内可下载专用 CSS 参考文档。</li>
        <li>左上角返回可选择<strong>暂离</strong>（保留进度，稍后再来）或<strong>删除本次线下</strong>（清除本场进度、不收纳，适合误入时直接退出）。</li>
        <li>约会对象本人的日程主动消息会暂停，收纳后自动恢复；其他角色不受影响，仍会来找你。</li>
        <li>点「掏出手机」会直接回到 Chat，不需要先选角色；这时用户带着「正在线下」状态，进入任意私聊或群聊都能看到一键「返回现场」。回来后，期间的往来会显示成可点击的消息提醒，不再把聊天摘要铺在线下正文里。</li>
        <li>其他角色发消息时可设<strong>赴约自动回复</strong>：关闭 / 固定文案 / 同行角色代答。同行代答还可分别开启「消息代答演出」与「掏手机被注意」，并为两种事件各自选择低 / 中 / 高 / 无冷却；高频档在符合条件时会直接触发，同类演出之间至少间隔约 3 分钟，单场最多 6 次。「无冷却」只在用户主动选择后生效，每次符合条件都可触发，也不限制单场次数。</li>
        <li>命中演出时，同行角色会自然地接过手机：页面切入对应 Chat，输入框逐字出现 TA 的完整代答，发送后显示对方正在输入，再落下对方的回复。代答与对方反应会在同一次生成里完整准备好；线下剧情若明确演到已接走你的手机并要替你回复，也会进入同一套 Chat 演出。掏出手机进入会话后，还可在「更多内容」里点「请 TA 代回」主动触发一次。</li>
        <li>被撞见的角色如果想赶来，会先在消息里提出加入；由你决定同意、拒绝或稍后处理。工具栏的「现场成员」可以撤回尚未到场的邀请，也可以让已到场角色先离开或再次加入。现场成员候选与剧情中提到的场外人物都只从当前档位绑定的角色中识别，不会读取其它分组的人设。</li>
        <li>多人相遇创建的小群会按地点与同行者命名。没有进行中事件、未读消息或待处理申请时，它会收进 Chat 的「相遇小群」折叠区；群聊与历史不会被删除。</li>
        <li>相遇的「叙事设置」可组合开启三种线下输入模式：<strong>对话模式</strong>把你的输入视为已经说出口的话；<strong>防转述</strong>让 AI 从角色下一拍反应开始，不复读你的原文；<strong>导演模式</strong>把简短输入当场景指导。开启「防抢话」后只推进角色与环境，不补写用户台词、心理或新动作。想让角色以第一视角说「我」、称你为「你」时，选择<strong>角色第一视角 + 称用户为「你」</strong>；“用户称呼”只决定正文怎样指代用户。线下会学习角色语料中的口吻、对白标点和情境反应，但不会读取连续气泡的发送边界。</li>
        <li>叙事设置可存成命名预设：进页会自动套用你上一次使用的那套（视角、字数、生图画风、每轮自动出图、文风绑定等机制参数都会带上）；地点、一起做什么、开场白这类当场内容不进预设，也不进进页草稿——换人或重新进入时会清空，需当场再填。普通场景默认约每六轮生成一次阶段小结；单轮字数很高或希望细节长期保留时，可另开<strong>每轮生成隐藏摘要</strong>。逐轮摘要与正文同次返回，不增加一次 API 调用；阶段小结会聚合它们，注入时按覆盖区间去重。</li>
        <li>预设页的线下内置项分为<strong>文风、写作功能、Claude 适配、Gemini 适配、思维链</strong>五组。默认开启的<strong>白描</strong>负责具体落笔与长短错落，但不会把所有人物压成相同短句：解释长度、称呼与玩笑权限仍服从人物和关系；<strong>烟火生活</strong>负责从人物真实条件里选择饮食、通勤、工作、家庭与城市生活细节。<strong>潮湿暗涌、轻喜剧</strong>可以继续叠加。<strong>比喻纠偏</strong>单独清除“小兽、棋子、猎物”以及“语气像在……”式预制比喻。直写与抗解释、人物优先、不挑刺不贬低、修罗场暗流等也按实际问题开关；可选的<strong>去主角中心化</strong>会让有 user 和无 user 的多人场景都沿角色之间已有关系、社会背景与配角生态运转，减少所有人只围着单一中心人物反应。Gemini 的<strong>活叙事</strong>补回人物的主观心理与私人联想，<strong>闲笔扩散</strong>负责城市、时代、社交、经历和物质生活侧写，并只删除堆砌型修饰与摆拍动作；Claude 的<strong>长文纠偏</strong>重点防止自动降温、全员碎句冷幽默、清贫苦难滤镜和明显超出字数上限。模型适配项默认关闭，按当前模型和实际问题选择即可。</li>
        <li><strong>思维链</strong>会在正文前返回隐藏的生成决策回执，并与接口原生推理分开记录；每轮可展开查看已执行、未返回或仅原生推理等状态。完整推演会核对新指令与核心落点、启用文风怎样具体落到用词和句长、当前关系权限、时空/私域/人际材料、元素候选与题材第一反应、时间线拍点以及镜头和感官主次；回执采用固定字段，方便确认模型实际读到了哪一步。生僻联想只负责打破“小兽、珍宝、收藏”等自动补全，不会为了冷门强塞知识，也不会把感官写成五感清单。多人场景还会划分本轮主焦点、必要陪衬和暗场人物；配合<strong>自然群像</strong>时，开场默认只启动一条关系边，其他角色可以隔几轮再入镜，隐藏心声也只保留正文有真实锚点的最多两人。用户资料较少时保留角色的不确定，不替用户补人设。固定句式反复出现时，可另开<strong>编辑审稿</strong>：模型在同一次回复中按自然段交替输出隐藏原稿、检查记录和可见定稿，下一段只承接上一段定稿。它不属于思维链，默认关闭，也会明显增加输出时间和 token 消耗；使用“补审重写”时，可以在工具模型任务中开启“线下补审重写”，交给更便宜的模型直接产出替换正文，工具线路不可用且尚未返回部分内容时会回退场景／主模型。</li>
        <li>普通线下新场景默认生成<strong>隐藏心声</strong>。心声入口会穿插在正文段落之间并可点击展开。番外若模型漏写心声，会显示手动补全入口；也可在番外叙事设置中明确开启“自动补全”，开启后每轮最多额外调用一次场景模型。音声舞台仍不生成这项隐藏内容。</li>
        <li>线下进行中收到别的角色邀约会提示「撞车」：可以婉拒，也可以把 TA 引入本场变成多人局。</li>
        <li>每条推进支持编辑 / 重 roll / 删除 / 配图。普通重 roll 会从上一层与本轮方向独立重采样，不再把未采用旧稿喂回模型；「补审重写」会读取当前旧稿、本地列出实际八股命中并强制重写，新稿仍有硬命中时保留旧稿且不自动发起第二次请求；需要自行描述人物或剧情问题时，用最后一层的「指导与重修」。进入后剧情暂停，可与 AI 本体连续讨论当前文本和人物表现；本体生成的提示词可先手改，再选择仅在本场启用，或保存为已启用的线下预设并重写当前层。指导对话不会写入剧情、摘要或角色记忆。线下生成温度跟随当前实际使用的主 API 或线下专属 API 配置。</li>
        <li><strong>专家会诊（测试中）</strong>允许选择另一个已保存的聊天或场景 API 档位。专家在一次调用中同时审阅并直接写出替代版本：线下作为新版本采用，线上留在指导对话中继续讨论。分别填写“希望保留当前稿的特点”和“希望从专家引入的特点”，还可连同专家 API 档位保存为会诊方案，下次直接选择；不会按模型品牌擅自套风味，也不会自动连环重试。</li>
        <li>楼层菜单可「存为节点」或「从这里另开路线」。路线只回滚叙事；手机消息、人员变化和时间推进等真实外部事件不能跨越回滚。当前路线作为正史收纳，其他路线可在档案中展开回看。</li>
        <li>生成中可在底部点「停止」或在工具栏点「终止 AI 输出」，已经收到的正文会尽量保留。模型请求发出后等待较久时，页面只会提醒任务仍在继续，不会自动停止或重试；等待更久会提示线路也可能失去响应，由你决定继续等还是停止本轮。主动停止后若底层线路没有及时响应，页面会在几秒后完成本地收尾并恢复操作，旧请求晚到也不会覆盖后续剧情。走向选项与正文由同一次生成完成，正文结束后会显示选项生成状态。</li>
        <li>「管理历史」可批量删除；「美化」可自定义底色、字体、正文颜色、字号、行距，上传带蒙版的底图，并把整套外观另存为预设。自定义 CSS 支持导入 <code>.css</code> / <code>.txt</code>，也能从 <code>.md</code> 的 CSS 代码块读取；面板内可下载线下专用参考文档。若自定义 CSS 写坏导致按钮点不到，可到 <strong>美化设置 → 自定义 CSS → 清空线下 CSS（急救）</strong> 只清线下 CSS，不必重装。</li>
        <li>回顶、上一条、下一条和置底组成的楼层导航默认关闭；需要时可在「美化界面」中开启「显示右侧楼层导航」，四个按钮会在右侧中下方纵向排列，并在停止滚动后淡出。</li>
        <li>线下楼层下方的心声入口可用 <code>.os-beat-thought</code> 美化；点开后的心声弹层沿用关联会话的「心声样式」，需到会话详情中调整。导入的方案不再需要时点「恢复默认」，会同时退出自定义样式、内容模板与生成规则，但不会删除历史心声。按钮、底部输入框、推进键和工具栏的真实选择器均已列入线下参考文档。</li>
      </ul>

      <h3>收纳与时间</h3>
      <ul class="tutorial-steps">
        <li>档案可以在「卷宗 / 过程 / 角色记忆」之间切换。中途加入或提前离开的角色，只会保留自己亲历区间内的记忆。</li>
        <li>现实同步与等待现实追平时，线下收纳只保存经历，不提供时间推进。只有先在日程表切到<strong>固定虚拟时间线</strong>，收纳页才会出现「推进世界时间」，用于把整个故事世界推进到本场结束时刻。</li>
        <li>曾经推进后又回到现实时间也不需要删除旧记忆：系统会按真实收纳顺序承接上一场和中间线上消息，旧剧情钟点只作为当时的日期存档。</li>
        <li>收纳生成结构化卷宗：关键台词、情感与认知变动、物品与伏笔、未完成悬念都会存档，并在后续聊天里被 TA 记得。</li>
        <li>这段线下占用的时间段会写回参与者的日程表，覆盖原本排在那的安排。</li>
      </ul>
    </article>
  `;
}

function renderMapSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-map">
      <h2>高德地图 API</h2>
      <p>接入后可用于：角色自主搜索和选择真实地点、角色手机小地图、路线与 POI 补全等。需要两类 Key——<strong>Web 服务</strong>（MCP、搜索和路线）和 <strong>JS API</strong>（页面里的小地图）。</p>

      <h3>一、申请流程</h3>
      <ol class="tutorial-steps">
        <li>打开 <a href="https://lbs.amap.com/" target="_blank" rel="noopener noreferrer">高德开放平台</a>，注册并登录。</li>
        <li>完成<strong>开发者认证</strong>（个人认证即可；未认证时很多服务配额为 0）。</li>
        <li>进入 <a href="https://console.amap.com/dev/key/app" target="_blank" rel="noopener noreferrer">控制台 → 应用管理</a>，点击「创建新应用」。</li>
        <li>在应用下<strong>添加 Key</strong>（通常要添加两次，服务平台不同）：
          <ul>
            <li>服务平台选 <strong>Web 服务</strong> → 复制 Key → 填入棉花糖机「Web 服务 Key」</li>
            <li>再添加一个 Key，服务平台选 <strong>Web 端 (JS API)</strong> → 复制 Key → 填入「JS API Key」</li>
            <li>在 JS API 的 Key 详情里查看<strong>安全密钥</strong> → 填入「JS 安全密钥」</li>
          </ul>
        </li>
        <li>回到棉花糖机 <strong>设置 → API → 地图</strong>，打开「启用」，填好上述三项后保存。</li>
      </ol>

      <h3>二、免费额度（参考）</h3>
      <p>配额以高德控制台「配额管理 / 用量详情」为准，以下为<strong>个人认证开发者</strong>常见基础额度，可能随平台政策调整：</p>
      <table class="tutorial-table">
        <thead>
          <tr><th>服务类型</th><th>个人认证月配额（约）</th><th>棉花糖机用途</th></tr>
        </thead>
        <tbody>
          <tr><td>关键字 / 周边搜索</td><td>约 5,000 次/月</td><td>角色生活选址与地图探索</td></tr>
          <tr><td>路径规划（步行/骑行等）</td><td>约 150,000 次/月</td><td>路线估算与行程补全</td></tr>
          <tr><td>JS 地图图面初始化</td><td>约 150 万次/月</td><td>角色手机里的小地图</td></tr>
          <tr><td>静态地图</td><td>与路径类同档</td><td>地图预览图</td></tr>
        </tbody>
      </table>
      <p class="tutorial-note">企业认证配额更高。超额后可能按量计费或限流，详见 <a href="https://lbs.amap.com/pages/base_service_price" target="_blank" rel="noopener noreferrer">官方计费说明</a> 与 <a href="https://developer.amap.com/api/webservice/guide/tools/flowlevel" target="_blank" rel="noopener noreferrer">流量限制说明</a>。</p>

      <h3>三、在棉花糖机里怎么填</h3>
      <table class="tutorial-table">
        <thead>
          <tr><th>设置项</th><th>填什么</th></tr>
        </thead>
        <tbody>
          <tr><td>Web 服务 Key</td><td>控制台里服务平台为「Web 服务」的 Key</td></tr>
          <tr><td>JS API Key</td><td>服务平台为「Web 端 (JS API)」的 Key；留空时会尝试复用 Web Key，但小地图往往仍需独立 JS Key</td></tr>
          <tr><td>JS 安全密钥</td><td>JS API Key 配套的安全密钥（2021-12 后新建的 Key 通常必填）</td></tr>
          <tr><td>默认搜索半径</td><td>周边搜范围，单位米；角色附近 POI 补全会参考此项</td></tr>
          <tr><td>地图默认条数</td><td>单次搜索最多返回几条结果</td></tr>
          <tr><td>启用 JS 地图</td><td>关闭后仅保留后台搜索，角色手机里不加载小地图</td></tr>
          <tr><td>角色自主选择真实地点</td><td>生成角色生活日程前通过高德 MCP 准备真实候选，由 AI 结合人设、天气、距离与近期经历选择；选中后才写入日程，日程实际经过后才记为去过</td></tr>
        </tbody>
      </table>

      <h3>四、常见问题</h3>
      <ul class="tutorial-faq">
        <li><strong>小地图白屏 / INVALID_USER_SCODE</strong>：检查 JS 安全密钥是否与 JS API Key 配对；密钥需在加载地图脚本之前生效（应用内已处理）。</li>
        <li><strong>搜索没结果</strong>：确认已开启「启用」、Web 服务 Key 正确，且账号已完成开发者认证。</li>
        <li><strong>域名白名单</strong>：若在控制台给 JS Key 配置了 referer 白名单，需加入你实际访问的域名；本地调试可暂时放宽或加入 <code>localhost</code>。</li>
        <li><strong>配额不够</strong>：可在控制台查看实时用量；关闭「角色自主选择真实地点」，或缩小搜索半径 / 条数。</li>
      </ul>
    </article>
  `;
}

function renderMeituanSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-meituan">
      <h2>美团优惠分享</h2>
      <p>在 <strong>设置 → API → 生活</strong> 开启自然分享。角色会把核验过的真实活动当作生活素材，根据你的偏好与当前话题决定是否提起。</p>
      <ul class="tutorial-steps">
        <li>系统先按优惠力度筛选，再由 AI 结合口味、品牌偏好、预算、忌口和角色性格决定；不适合时可以完全不提。</li>
        <li>只有接口核验过的品牌、力度、地区和期限可以作为事实。没有真实活动数据时保持沉默，不会自行编造。</li>
        <li>每天定时提醒是独立选项，默认关闭；开启后同一天最多一次，错过时间后最多补发三小时。</li>
        <li>不会自动登录或领取。定时提醒仍遵守主动消息总开关、静音、拉黑和线下互动状态。</li>
      </ul>
    </article>
  `;
}

function renderInterestSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-interest">
      <h2>兴趣搜索与真实分享</h2>
      <p>角色手机的「兴趣」页会按词表自动去联网了解、精搜细看，甚至把真实刷到的帖子链接分享回聊天里。这里说明背后走的是什么服务、大概花多少次调用，以及几个新设置项分别是什么意思。</p>

      <h3>一、TikHub 是什么</h3>
      <p><strong>TikHub</strong> 是一个第三方数据中转站，负责代查小红书 / 微博 / B站等平台的公开内容（搜索列表、笔记正文、评论）。棉花糖机本身不直连这些平台，走的是 TikHub 的接口。</p>
      <ul class="tutorial-steps">
        <li>去 <a href="https://tikhub.io/" target="_blank" rel="noopener noreferrer">tikhub.io</a> 注册账号，创建自己的 API Key（BYOK，自己充值自己用，费用不经过棉花糖机）。</li>
        <li>把 Key 填进 <strong>设置 → API → 小红书/微博/B站解析</strong>，开启后兴趣页的社媒精搜才能用。</li>
        <li>按调用次数计费，<strong>具体费率、余额、账单去 tikhub.io 官网自己的控制台查</strong>——项目里不经手、也查不到你的余额。</li>
      </ul>
      <p class="tutorial-note">聊天里贴<strong>小红书链接</strong>或<strong>B站视频链接</strong>都不用配 TikHub 也能解析出正文级内容，且这条免费路径优先于 TikHub——配了 Key 也会先试这条：小红书分享链接较新时（刚从 App 复制/分享出来）能拿到笔记标题、完整正文、配图和首屏热评，链接放太久失效才退回分享文案里的标题；B站视频链接更稳，只要是正常公开视频，随时都能拿到标题、简介、封面、播放/点赞等互动数和几条热评（B站没有会过期的令牌限制）。这两条免费路径都失败时，配了 Key 的情况下用 TikHub 兜底，没配 Key 就退回分享文案。微博没有这条免费全文路径，没配 Key 时走轻量抓取一般只有标题或摘要，贴整段 App 分享文案效果更好，配了 Key 就优先走 TikHub。安卓 App 另有一条备选：「小红书/微博/B站解析」设置里打开「没配 Key 时用内置浏览器截图兜底」，自动截图交给主模型识图理解（要求主模型支持识图，吃识图 token，<strong>只在安卓 App 里能用</strong>）。TikHub 主要用在：微博的深度解析、兴趣页的社媒精搜与按关键词搜帖、以及小红书/B站免费路径失效时的兜底。</p>

      <h3>二、词条上的背景故事 / 频道 / 提起方式是什么</h3>
      <p>兴趣页每个词条点开都能看到这几个分类，决定了它多久被搜一次、搜到的东西怎么用：</p>
      <ul class="tutorial-steps">
        <li><strong>背景故事</strong>：写清楚 TA 为什么喜欢这个、什么时候喜欢上的，可以自己写，也可以点一下让 AI 用角色口吻补全（会参考人设、记忆、聊天记录）。这段背景会带进搜索简报、日程、分享的措辞里，避免兴趣只是一个孤立的词。</li>
        <li><strong>深浅现在由背景故事自动判定</strong>，不用再手动选：背景写得越具体、越有记忆细节（时间地点、具体经历），越容易被判「深」；只是随口一提的，判「浅」。改写背景故事后深浅会跟着重新判一次。</li>
      </ul>
      <table class="tutorial-table">
        <thead>
          <tr><th>频道</th><th>用来标什么</th></tr>
        </thead>
        <tbody>
          <tr><td>日常</td><td>吃喝玩乐类的生活小事（奶茶、探店、日常穿搭），搜到的东西偏碎片，不追进度。</td></tr>
          <tr><td>爱好</td><td>长期投入的爱好（游戏、乐队、运动），有能力裂变出具体子话题、记录进度存档。</td></tr>
          <tr><td>种草</td><td>想买/想去但还没做决定的东西，搜到的是测评、避坑一类的参考信息。</td></tr>
          <tr><td>在追</td><td>正在追更的连载内容（剧/番/小说），带进度存档，聊天时能接上"追到哪了"。</td></tr>
          <tr><td>泛兴趣</td><td>随手关注、没那么投入的方向，搜索优先级最低。</td></tr>
        </tbody>
      </table>
      <table class="tutorial-table">
        <thead>
          <tr><th>分类</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr><td>深浅</td><td>「深」的大类词才会被拿去裂变出具体子话题（如「明日方舟」裂变出「明日方舟 新肉鸽」），子话题本身会归到深档大类词自己的世界书分组下；「浅」的词只按原样搜，不裂变。</td></tr>
          <tr><td>体量</td><td>只对深档大类词生效，标这个话题内容量多不多：「内容多」（如长期运营的游戏/剧集）搜索和裂变冷却更短，能更快跟上更新；「内容少」冷却更长，避免搜出重复内容。</td></tr>
          <tr><td>提起方式</td><td>「会分享」允许 TA 主动拿它开话题、精搜并发送真实链接；「私下成长」仍会搜索、记录进度并影响日程，只在你明确聊到时接话。用户手动添加默认会分享，AI 自然补出的兴趣默认私下成长，裂变子话题继承母兴趣。</td></tr>
        </tbody>
      </table>

      <h3>三、大概花几次调用</h3>
      <table class="tutorial-table">
        <thead>
          <tr><th>场景</th><th>大概消耗</th></tr>
        </thead>
        <tbody>
          <tr><td>常规兴趣搜索（后台每日轮转 / 手动补充）</td><td>社媒渠道 1 次列表调用；命中「网页」渠道时不占 TikHub 额度</td></tr>
          <tr><td>分享真实帖子精搜（小红书/微博/B站）</td><td>1 次列表 + 1 次详情，勾选「连带热评」再 +1 次</td></tr>
          <tr><td>网页链接精搜分享</td><td>0 次 TikHub 调用（走免费的联网搜索额度，不经过 TikHub）</td></tr>
        </tbody>
      </table>
      <p class="tutorial-note">同一个关键词如果最近已经有别的角色搜过，会直接复用那份列表结果，不会重复扣费；同一篇帖子的正文详情也是按链接缓存的，不同角色分享到同一篇不会重复计费。</p>

      <h3>四、分享相关的几个设置项</h3>
      <table class="tutorial-table">
        <thead>
          <tr><th>设置项</th><th>档位 / 范围</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr><td>自动追踪</td><td>开 / 关，<strong>默认关闭</strong></td><td>关掉时词表还在，只是不会被后台自动搜；想让某个角色持续了解兴趣词，需要自己在兴趣页手动打开。</td></tr>
          <tr><td>多久搜一次（小时）</td><td>4～72，默认 12</td><td>开启自动追踪后，后台隔多久才让这个角色轮到一次，按角色单独调。</td></tr>
          <tr><td>一轮搜几条</td><td>1～5，默认 2</td><td>每次自动轮转搜几个候选词，越多越全但越费额度。</td></tr>
          <tr><td>每天最多分享（条）</td><td>0～20，默认 1</td><td>这个角色每天最多攒/主动分享几条真实帖子；调到 0 等于暂停主动分享，但精搜、浏览记录不受影响。</td></tr>
          <tr><td>主动性</td><td>偶尔 / 正常 / 常想分享</td><td>决定「今天要不要主动提起分享」这个冲动命中的概率，越高越容易主动开口，不影响素材质量。</td></tr>
          <tr><td>渠道</td><td>通用网页 / 小红书 / 微博 / B站</td><td>「分享真实帖子精搜」下可<strong>多选「分享渠道」</strong>：AI 选词精搜与后台补货只从勾选渠道取链（可关掉网页、只留小红书等）。勾选了网页时仍会优先试免费网页，没搜到再试勾选的社媒。「后台社媒渠道」只限定兴趣自动追踪的社媒搜索范围。</td></tr>
          <tr><td>避雷 / 不避雷</td><td>按兴趣词各自设置，默认避雷</td><td>「避雷」时精选会避开拉踩对立/引战骂战、嗑 CP 同人配对倾向的内容；切成「不避雷」就都不刻意回避了。</td></tr>
          <tr><td>会分享 / 私下成长</td><td>按兴趣词各自设置</td><td>控制这个兴趣能不能进入主动简报与链接分享，不影响它在后台自然增长。</td></tr>
          <tr><td>雷点（自由文本）</td><td>角色级，选填</td><td>直接写清楚不想看到什么（如"不想看到 CP 同人""不想看到骂战"），精选时会当硬性约束。</td></tr>
        </tbody>
      </table>

      <h3>五、浏览记录和角色记忆是什么关系</h3>
      <ul class="tutorial-steps">
        <li>手机「浏览记录」页只放<strong>精搜挑出来、可能会分享</strong>的内容，会标「待分享 / 已分享」；常规兴趣搜索列表扫过的一堆标题不会往这里塞，那些只沉进兴趣页可折叠的「素材池」，角色自己心里有数但不算正经浏览记录。</li>
        <li>浏览记录不会自动写成长久记忆，但聊天聊到相关选择、偏好或看法时，会按当前话题取出少量匹配记录，连同「TA 自己的判断」一起供角色参考；无关浏览历史不会整批塞进聊天。真的分享过的链接还会通过分享记录继续保持上下文。</li>
      </ul>

      <h3>六、常见问题</h3>
      <ul class="tutorial-faq">
        <li><strong>日程已经做到下一步，兴趣页为什么还停在上一阶段</strong>：新版会按角色当地时间消费日程里的具体步骤，走到哪一步才把兴趣存档推进到哪里；未来计划不会提前算完成。旧日程也会在步骤或时段真正结束后，按下一目标做一次保守同步。</li>
        <li><strong>小红书搜索经常没结果</strong>：可能是当天社媒额度已经用完、也可能是这个词确实没搜到东西——兴趣页「今日调用」和设置页「搜索调用统计」现在都能看到具体原因（配额用完 / 接口报错 / 确实没搜到）。</li>
        <li><strong>分享的小红书链接要跳好几次才能看</strong>：精搜链路已经会把搜索阶段拿到的安全令牌带进最终链接，理论上应该能直接打开预览；如果还是要跳转，多半是小红书那边对这条内容本身有访问限制。</li>
        <li><strong>游戏活动资讯已经过期</strong>：活动排期、卡池、赛季和版本资讯会按当前月份检索并核对正文日期；待分享素材超过 7 天会自动退出分享候选，不会一直复用旧链接。</li>
        <li><strong>问角色「最近刷到什么」他编了一条没有的内容</strong>：角色只能引用真的搜到、且和当前话题对得上的素材；没有对得上的素材时应该说「没刷到什么特别的」，如果编了具体内容属于生成偏差，可以在这轮回复上反馈/重新生成。</li>
      </ul>
    </article>
  `;
}

function renderMomentsSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-moments">
      <h2>朋友圈</h2>
      <p>入口：Chat 页顶部「朋友圈」标签。AI 生成的动态不是随机生活文案——每批会读取角色卡、世界书、通讯录关系网和角色最近的真实素材（日程、聊过的事、刷到过的内容），并由系统按占比抽签决定每条「发生了什么」：普通生活切片、和你有关的动态、关系暗流（较劲/隔空喊话/分组可见手滑/晒聊天记录吐槽）、分享转发等。</p>

      <h3>生成动态</h3>
      <ul class="tutorial-steps">
        <li><strong>AI 生成</strong>（✨）：一次生成一批动态，可选是否配图、画风滤镜、表情包；评论区会按贴主性格出现本人回复，但贴主只挑值得接的一两条回，不会把楼里每条评论逐条回复。生成完成后也会顺手给缺少贴主回应或互动稀薄的旧动态补互动。</li>
        <li><strong>角色主页</strong>：点头像进入 TA 的朋友圈，可单独补 TA 的动态、设背景图和签名。</li>
        <li><strong>配图失败</strong>：卡片会保留画面提示词并显示「重 roll / 改提示词重 roll」；只有图片成功转存到本地后才会落库，不再把可能过期的临时链接当成功图片保存。</li>
      </ul>
      <p class="tutorial-note">点击某条评论后才会展开「回复 / 删除」，平时不显示编辑按钮。单条动态菜单里的「AI 补互动」会优先带入尚未出现的熟人（含该角色「他的手机」通讯录里的联系人），并让楼里的人继续互相回复；如果你已评论，也可能有人直接回复你。若提示暂无认识的人可互动，可先补全该角色手机通讯录，或在关系网/分组互识里建立熟人。</p>

      <h3>生成素材从哪里来</h3>
      <ul class="tutorial-steps">
        <li><strong>用户档案</strong>：读取当前用户的昵称、签名、状态、生日、城市、常住地点、兴趣、雷点、人物设定与外观。正文里用「某人 / 那个人」含蓄指代时，只能指这位有档案的用户，不能另造陌生人。</li>
        <li><strong>真实聊天</strong>：读取本批发帖角色参与过的私聊/群聊，每个会话最近 20 条，并标明真实称呼与 id；有可用聊天时，本批至少一条必须扎根聊天事实。</li>
        <li><strong>生活与记忆</strong>：读取角色今昨两天日程、近两周旅行/线下档案、近三天真实刷到内容、角色记忆；记忆摘要按最新优先。有生活素材且一批至少两条时，至少一条使用生活素材。</li>
        <li><strong>关系与世界</strong>：关系网、角色卡、已开启世界书决定动机、口吻和世界常识，但不能单独证明某件近期事情已经发生。</li>
        <li><strong>公共话题</strong>：48 小时内站内微博话题最多占一条；没有明确素材时不再自编新闻、链接或不存在的「某人」。涉及用户的晒聊天必须来自真实记录；不涉及用户的角色间日常聊天允许按角色卡和关系网合理虚构。</li>
      </ul>

      <h3>朋友圈设置（三点按钮）</h3>
      <ul class="tutorial-steps">
        <li><strong>内容占比</strong>：分别控制「和用户有关」「剧情 · 修罗场」「分享 · 转发」出现的频率（关闭 / 少量 / 适中 / 偏多），手动和自动生成都生效。剧情类每批最多一场，同一场景、同一对人会自动降权，不会连着刷同一出戏。</li>
        <li><strong>定时自动生成</strong>：开启后按设定频率在后台自动发圈，受「每天上限（批）」约束；「自动生成允许配图」默认关，省额度。</li>
        <li><strong>聊完天后可能发圈</strong>：和角色聊完一轮后，有一定概率触发一小批动态（刚聊过的角色更可能发），有冷却、与定时批次共享每日上限。</li>
        <li><strong>主要发帖人</strong>：勾选后只有这些角色会被自动生成选为作者；不选则全部角色轮换。</li>
      </ul>

      <p class="tutorial-note">修罗场、隔空喊话这类戏需要「素材」：在通讯录 → 关系网里给角色之间连线标注关系（情敌、前任、死对头、暗恋……），或在角色卡登记关系，戏才有得唱。</p>
    </article>
  `;
}

function renderAnonymousSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-anonymous">
      <h2>匿名区</h2>
      <p>匿名区里所有人都披着「马甲」（匿名网名），前台不显示通讯录里的真实身份。角色知道自己是谁、知道自己正披着哪个马甲，但默认把房里其他人当陌生网友——哪怕在房外彼此熟悉，进了匿名房也得靠对话重新认人。</p>

      <h3>几种玩法</h3>
      <ul class="tutorial-steps">
        <li><strong>一对一匹配</strong>：随机匹配一位角色，双方都用匿名马甲私聊，像陌生网友搭话。</li>
        <li><strong>随机群匹配</strong>：按主题拼一桌匿名群聊。可设总人数、是否掺入 AI 现场捏造的「路人网友」、以及角色马甲怎么起（见下）。</li>
        <li><strong>创建房间</strong>：自己从通讯录挑成员开匿名群，自定义房间名、主题与记忆档位；可选世界观（内置 AU 快填或绑定世界书）。</li>
        <li><strong>隔空喊话 / 匿名墙</strong>：匿名贴一句话，等角色路过回应。</li>
        <li><strong>赛博告解</strong>：树洞式的匿名告解房。</li>
        <li><strong>匿名空间</strong>：你的匿名主页，放签名、留言与足迹。</li>
        <li><strong>深夜主播</strong>：不露脸的电台/直播玩法，正在筹备中。</li>
      </ul>

      <h3>世界观 / 设定（可选）</h3>
      <ul class="tutorial-steps">
        <li>创建匿名房与随机群匹配都可设房间世界观：选内置 AU 会自动填入补充说明，也可绑定一本世界书；整房对话与路人捏人都会参考，不填则是普通现代网友局。</li>
      </ul>

      <h3>路人网友（NPC）</h3>
      <ul class="tutorial-steps">
        <li>默认不会硬塞路人。要的话在「随机群匹配」或「创建匿名房」里勾选，自己填几个、什么背景性格，匹配时 AI 会现场捏几名互不相识的陌生网友，匿名 ID 也是现场起的，不沿用任何真实身份。</li>
        <li>生成的路人会归到通讯录里隐藏的<strong>「匿名NPC」分组</strong>，日常不出现、也不参与普通匹配。勾选「保存到匿名NPC分组」就能留着复用；不勾选则用完即弃，删房间时一起清掉。</li>
      </ul>

      <h3>角色马甲</h3>
      <ul class="tutorial-steps">
        <li>默认开局让 AI 按角色人设各起一个贴合性格、又不掉马的马甲网名。</li>
        <li>想图省事可勾「用随机马甲」。角色在群里也能自己临时改名片/换头像。</li>
      </ul>

      <h3>记忆档位</h3>
      <ul class="tutorial-steps">
        <li><strong>马甲继承</strong>：继承角色本人的生活状态与普通聊天背景，但「外部的你」和「房里这个匿名网友」是两套身份——角色不会默认认出你，得靠房内铺垫。</li>
        <li><strong>轻马甲</strong>：只保留角色本体与模糊背景，外围社交记忆隔离，更不容易掉马。</li>
        <li><strong>临时房</strong>：只记本房，用完即走，适合短局隔离。</li>
      </ul>

      <h3>约线下 / 时光机里的马甲记忆</h3>
      <ul class="tutorial-steps">
        <li>默认情况下，角色在匿名马甲房里的经历<strong>不会</strong>自动带进「约线下」或「时光机」的叙事，避免无凭无据就被认出来；日常聊天/通话/语音陪伴不受此项影响，一直是原来的样子。</li>
        <li>想让马甲经历延续到约线下/时光机，在<strong>「约线下」</strong>发起页或线下场景设置里选<strong>「匿名马甲记忆」</strong>，有两档：</li>
        <li><strong>当作陌生人</strong>：带回马甲房经历，但角色仍不确认那位匿名网友是你，只当自己多经历了一段事，不会点破。</li>
        <li><strong>已经掉马</strong>：适用于你和角色在匿名房里已经互相挑明身份的情况，选这档后角色会把马甲房那位当成你本人，可以自然承接、翻旧账。</li>
        <li>这个开关按会话手动设置，不做自动识别——同一个角色可能在有的马甲房掉马、有的没掉，自己按实际剧情决定是否打开。</li>
      </ul>

      <h3>匿名聊天室使用须知</h3>
      <p class="tutorial-note">${ANON_ROOM_CAUTION_INTRO}</p>
      <p class="tutorial-note">${ANON_ROOM_CAUTION_IDENTITY}</p>
      <p class="tutorial-note">${ANON_ROOM_CAUTION_TEXT}</p>
      <p class="tutorial-note">${ANON_ROOM_CAUTION_MATCH_TEXT}</p>
    </article>
  `;
}

function renderLegalSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-legal">
      <h2>使用边界</h2>
      <p>棉花糖机包含 AI 生成内容。AI 可能生成不准确、不适当或不符合预期的文本、图片或互动内容。内置预设不包含违法或恶意内容，但用户自行输入的设定、API、模型和生成结果由用户自行管理。</p>

      <h3>工具定位</h3>
      <ul class="tutorial-steps">
        <li>棉花糖机只是一个<strong>本地前端工具</strong>，<strong>不提供、不内置、不代销任何 AI 模型</strong>。所有文本与图片均由你自行填入的第三方 API / 模型生成，账号与额度由你与对应服务商之间管理。</li>
        <li><strong>不提供任何人物设定卡</strong>（角色卡 / 人设包 / 世界书等）。通讯录与角色资料全部由用户自行创建或导入，应用本身不附带任何现成人物设定。</li>
        <li>应用<strong>内置提示词只用于约束输出格式、风格与基础安全，不含任何不良、违法或诱导性内容</strong>。生成结果取决于你接入的模型与你自己输入的设定。</li>
      </ul>

      <h3>年龄限制</h3>
      <ul class="tutorial-steps">
        <li>本应用仅面向成年人使用。</li>
        <li>未成年人不得购买、激活或使用本应用。</li>
        <li>请勿将账号、激活码或设备访问权限提供给未成年人。</li>
      </ul>

      <h3>内容责任</h3>
      <ul class="tutorial-steps">
        <li>请勿生成、保存、传播违法、侵权、骚扰、仇恨、露骨或伤害现实个人的内容。</li>
        <li>AI 输出不代表作者、开发者或发布者观点，也不构成医疗、法律、金融等专业建议。</li>
        <li>用户应自行判断生成内容是否适合保存、分享或继续使用。</li>
      </ul>

      <p class="tutorial-note">继续使用即表示你理解并同意以上边界。若不同意，请停止使用并删除本地数据。</p>
    </article>
  `;
}

function renderSupportSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-support">
      <h2>芥末棉花糖</h2>
      <p>芥末棉花糖会先查本教程与本地故障规则；需要继续追问时，可在 API 管理的「助手」标签单独配置一条 OpenAI 兼容线路。</p>

      <h3>快速定位</h3>
      <ul class="tutorial-steps">
        <li>设置页顶部、快捷悬浮球和报错卡片都可直接进入，并自动带入对应页面、运行载体、错误码与脱敏诊断。</li>
        <li>询问功能用法时会优先引用对应教程，并提供“打开对应教程”按钮。</li>
        <li>消息不显示、角色不回复、不主动发消息和协议掉格式可直接点输入框下方的常见问题。</li>
        <li>回答里的按钮只会跳到对应设置项并高亮，不会替你修改 Key、模型或开关。</li>
        <li>答疑 API 不可用时，本地错误指南、错误日志和复制反馈仍然可用。</li>
      </ul>

      <h3>提交反馈</h3>
      <ul class="tutorial-steps">
        <li>上传前可预览诊断字段；默认不发送业务提示词、聊天正文、角色资料、API Key、Token、自定义 Header 或完整页面参数。</li>
        <li>同一次提问与反馈会共用事故编号，维护者能看到发生问题的 App 构建、运行载体和页面。</li>
        <li>截图必须由你主动选择并确认，最大 2MB；没有截图也可以提交结构化反馈。</li>
        <li>提交后会得到 FB 开头的反馈编号，可在「我的反馈」查看维护者追问并补充信息。</li>
      </ul>

      <p class="tutorial-note">反馈后台未部署或暂时离线时，内容会保留在本机待发送队列，也可以继续使用「复制反馈包」。</p>
    </article>
  `;
}

function renderSupportFaqSection() {
  return `
    <article class="tutorial-article scrapbook-card" id="tutorial-troubleshooting">
      <h2>常见问题</h2>
      <p>先按看到的现象找答案。仍不一致时，把具体页面、刚点的按钮和报错原文交给芥末棉花糖，不要只写“不能用”。</p>
      ${SUPPORT_FAQ_ENTRIES.map((entry) => `
        <h3 id="tutorial-faq-${entry.id}">${entry.title}</h3>
        <p>${entry.answer}</p>
        <ul class="tutorial-steps">
          ${entry.steps.map((step) => `<li>${step}</li>`).join('')}
        </ul>
      `).join('')}
    </article>
  `;
}
