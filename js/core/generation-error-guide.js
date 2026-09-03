import {
  isMarshmallowChatLikelyInProgress,
  MARSHMALLOW_CHAT_START,
  stripThinkingBlocks,
} from './marshmallow-protocol.js';
import { normalizeDiagnosticEnvelope } from './support/diagnostic-envelope.js';
import { saveSupportIncident } from './support/support-context.js';

const SESSION_KEY = '__mm_gen_error_detail__';
const LAST_ERROR_KEY = '__mm_gen_error_last__';

// Latest captured error for quick rescue and feedback-copy actions.
// Keep it separate from SESSION_KEY so detail-page fallback text cannot replace it.
let lastGenerationError = null;

export function isModelFormatFailure(payload = {}) {
  const reason = String(payload.reason || payload.guideKey || '').trim();
  const kind = String(payload.jsonFailureKind || '').trim();
  return ['missing-json', 'syntax-invalid', 'schema-invalid'].includes(kind)
    || /^(json-parse-failed|protocol-plain-text|protocol-format-error|protocol-no-events|no-marshmallow-protocol|validation-failed)$/u.test(reason);
}

export const GENERATION_ERROR_GUIDES = {
  'character-deleted-during-generation': {
    title: '会话角色在生成期间已不存在',
    summary: '模型已经返回内容，但保存前发现会话中的角色已被删除或移出，因此没有写入本轮回复。',
    causes: [
      '生成过程中删除了当前会话角色，或从会话成员中移除了该角色。',
      '旧会话残留了已经失效的角色 ID。',
    ],
    fixes: [
      '返回会话列表后重新进入；若角色仍存在，再点一次推进。',
      '若没有删除或移除任何角色，请复制错误详情反馈；详情会列出未找到的角色 ID。',
    ],
  },
  'chat-deleted-during-generation': {
    title: '会话在生成期间已不存在',
    summary: '模型已经返回内容，但保存前发现当前会话已被删除，因此没有写入本轮回复。',
    causes: [
      '生成过程中删除了当前会话。',
      '其它页面、设备或数据恢复操作替换了当前会话记录。',
    ],
    fixes: [
      '返回会话列表确认该会话是否仍存在。',
      '若会话仍在，请重新进入后再试；连续出现时复制错误详情反馈。',
    ],
  },
  'local-storage-error': {
    title: '本地聊天库连接中断',
    summary: '接口回复阶段没有被判定为空回；是 iOS 暂时断开了本页与本地聊天数据库的连接。',
    causes: [
      'iOS 在内存压力、切换前后台或系统存储进程重启时关闭了 IndexedDB 连接。',
      '设备可用存储空间过低，或 Safari 同源页面同时占用数据库。',
    ],
    fixes: [
      '保持当前页面在前台，稍候后再点一次推进或重 roll；应用会自动重连本地聊天库。',
      '关闭同一站点的其它 Safari 标签页，并检查设备剩余存储空间。',
      '若连续出现，导出数据后重启 Safari 或设备；不要反复清除网站数据。',
    ],
  },
  'empty-api-response': {
    title: '未抽到可用正文',
    summary: '请求已发出，但上游没有返回可用的聊天正文（content），或把正文放在了当前协议无法识别的字段里。',
    causes: [
      '推理模型只返回了 thinking / reasoning_content，正文 content 仍为空；后台 token 统计常把推理也算进去。',
      '中转把结果写在非标准字段，客户端认不到。',
      '部分中转在「长 system + 短 user」的非流式请求下会空回 content。',
      '模型不支持当前上下文长度，或余额/线路异常，只返回了空 body。',
    ],
    fixes: [
      '先看本页「传输证据」：若已收到 [DONE] / finish_reason，这不是后台断流，而是接口结束后没有正文。',
      '若显示「仅返回原生推理」，确认中转会把最终答案写进 content，或换非纯推理模型/兼容线路。',
      '可手动切换流式/非流式请求，或在 API 设置开启“将 system 合并到首条 user”后再试；应用不会自动重发可能计费的请求。',
      '也可更换模型或 API 渠道；若频繁空回，请携带请求编号与 finish_reason 联系当前 API 渠道服务商排查。',
    ],
  },
  'upstream-content-refusal': {
    title: '上游拒绝了本次请求',
    summary: '上游模型或渠道返回了安全拦截 / 拒绝说明，没有生成可进入聊天的角色回复。',
    causes: [
      '提示词或上下文触发了模型供应商、API 渠道或中转的内容安全策略。',
      '渠道把拒绝说明当作普通正文返回，因此 HTTP 状态可能仍然是成功。',
      '不同供应商的拒绝措辞不一致，可能表现为英文道歉、无法协助或内容违规提示。',
    ],
    fixes: [
      '查看「上游原文」确认具体拦截原因；这不是棉花糖协议掉格式。',
      '调整本轮输入或上下文中可能触发拦截的内容后再试。',
      '若内容本身合规但同一渠道持续误拦截，可更换模型或 API 渠道。',
    ],
  },
  'protocol-plain-text': {
    title: '输出是普通文字，不是协议',
    summary: '模型回了内容，但没有按棉花糖协议格式输出（缺少协议块或 JSONL 事件）。',
    causes: [
      '模型忽略了协议指令，直接写了对白或 Markdown 解释。',
      '上下文过长，模型退化成自由文本续写。',
      '部分小模型对结构化 JSONL 不稳定。',
    ],
    fixes: [
      '点「重 roll」再试；有时第二次会回到协议格式。',
      '换更强或更新版本的模型。',
      '检查是否误开了「非协议续写」类预设；群聊人数过多时可先减成员试。',
      '在下方「模型原文」里确认是否只有解释性文字。',
    ],
  },
  'protocol-format-error': {
    title: '协议块 JSON 格式错误',
    summary: '找到了协议块或 JSON 行，但其中有行无法按 JSON 解析。',
    causes: [
      '模型在 JSON 里写了未转义的引号、换行或尾逗号。',
      '流式传输中断，最后一行 JSON 被截断。',
      '模型把注释、Markdown 或中文说明混进了协议块。',
    ],
    fixes: [
      '查看「模型原文」定位报错行；常见是最后一行不完整。',
      '流传输中断时可点「重 roll」；若经常截断，提高 Max Tokens 或换线路。',
      '换 JSON 更稳的模型。',
    ],
  },
  'protocol-no-events': {
    title: '协议块里没有有效事件',
    summary: '解析到了协议结构，但没有产出任何可落库的 msg / state 等事件。',
    causes: [
      '协议块为空，或只有 THINKING 隐藏块。',
      '每行 JSON 都缺少必填字段（如 state、msg 的 from）。',
      '事件类型拼写错误，未被识别。',
    ],
    fixes: [
      '在原文里搜索 <<<MARSHMALLOW_CHAT_V2>>> 是否成对出现。',
      '确认是否有 {"t":"state",...} 与至少一条可见事件。',
      '重 roll 或换模型。',
    ],
  },
  'no-marshmallow-protocol': {
    title: '未能识别棉花糖协议',
    summary: '输出既不像协议块，也无法提取有效 JSONL 事件（兜底分类）。',
    causes: [
      '模型完全偏离协议格式。',
      '返回了工具调用、函数参数等非文本 completion。',
      '内容被思考块包裹且外显部分为空。',
    ],
    fixes: [
      '先查看「模型原文」确认实际返回内容。',
      '尝试重 roll、换模型或缩短上下文。',
      '到设置 → 错误日志复制反馈包发给维护者。',
    ],
  },
  'validation-failed': {
    title: '协议校验未通过',
    summary: 'JSON 事件已解析，但角色 id、目标消息或字段规则校验失败，本轮未落库。',
    causes: [
      'from 使用了不在本群的 id 或真名，未映射到 participant。',
      'react / reply 指向了不存在或已撤回的消息。',
      '红包、转账等字段不符合规则。',
    ],
    fixes: [
      '查看报错详情里的 rejected 列表，确认是哪个事件、哪条规则失败。',
      '群聊时检查成员 id 是否与通讯录一致；匿名群用匿名 id。',
      '重 roll 通常可恢复；反复失败时换模型。',
    ],
  },
  'client-timeout': {
    title: '等待超时',
    summary: '在本地超时上限内没有等到接口响应，本轮已中断等待。',
    causes: [
      '中转排队或模型冷启动，长时间无首字节。',
      '上游已卡死但连接未断开，只能靠本地超时解除。',
      '网络劫持/防火墙导致请求发出后石沉大海。',
    ],
    fixes: [
      '稍等片刻后点「重 roll」重试。',
      '若同一线路频繁超时，换中转或换模型。',
      '检查当前网络能否直连该接口（可到 API 管理做连通性测试）。',
    ],
  },
  'relay-unreachable': {
    title: '无法连接云端中继',
    summary: 'App 没有连上中继地址；这一步发生在手机与中继之间，还没有请求模型。',
    causes: [
      '当前网络访问 workers.dev 不稳定或被拦截。',
      '中继地址填错、Worker 未部署成功或自定义域名解析异常。',
      '代理、Wi‑Fi 或蜂窝网络临时断开。',
    ],
    fixes: [
      '先在浏览器打开「中继地址/health」；打不开就不是模型问题。',
      'workers.dev 在当前网络不稳定时，可给 Worker 绑定自定义域名，或改用境内自建中继。',
      '切换 Wi‑Fi / 蜂窝网络后再试。',
    ],
  },
  'relay-crypto-error': {
    title: '中继令牌无法解密',
    summary: 'App 能连上中继，但当前访问令牌无法解开中继返回的数据。',
    causes: [
      'App 里的访问令牌与 Cloudflare ADMIN_TOKEN 不是同一串。',
      '修改令牌前创建的旧任务仍在返回。',
    ],
    fixes: [
      '把 App 令牌与 Cloudflare ADMIN_TOKEN 改成完全相同的值。',
      '打开中继 /setup 重新导入配置，再点「测试连接」。',
    ],
  },
  'relay-upstream-timeout': {
    title: '云端等待模型超时',
    summary: 'App 与云端中继连接正常，但中继等待当前模型 API 时超时。',
    causes: [
      '模型线路排队、冷启动或响应过慢。',
      '模型 API 对 Cloudflare 出口不稳定。',
    ],
    fixes: [
      '点「测试完整线路」复测当前 API。',
      '换模型或换一条允许 Cloudflare 访问的中转线路。',
      '手机代理无法改善 Cloudflare 到模型 API 这一段。',
    ],
  },
  'relay-upstream-unavailable': {
    title: '云端连不上模型线路',
    summary: '中继本身正常，但 Cloudflare 无法连接当前模型 API；手机是否挂代理不会改变这一段。',
    causes: [
      '模型中转拒绝或限制 Cloudflare 数据中心出口。',
      '上游域名、TLS、网关或线路临时异常。',
      '模型服务只对部分地区或 IP 开放。',
    ],
    fixes: [
      '在后台任务中继里点「测试完整线路」。',
      '换一条 Cloudflare 能访问的 API 线路，或使用境内自建中继。',
      '若必须使用当前中转，向线路提供方确认是否允许 Cloudflare 出口。',
    ],
  },
  'stream-error': {
    title: '回复没有接收完整',
    summary: '这次回复在传输途中断开，没有拿到可显示的完整内容。断点在网络、中转或系统后台策略一侧，不代表本机保活配置有问题；可以重新生成一次。',
    causes: [
      '切后台或锁屏时，系统暂停了网页的网络。这是系统行为，iOS 主屏幕 PWA 即使开了「后台活跃」也可能发生；中转侧常显示客户端断开。',
      '网络切换、代理波动，或接口线路提前关闭连接；模型一侧可能已经生成过内容。',
    ],
    fixes: [
      '点「重 roll」；部分线路中断后重试可拿到完整输出。',
      '常在切后台时发生：开「后台活跃」可降低概率；接自部署中继等声明幂等的线路后，切后台会自动改非流式接收，基本不再断。',
      '前台也频繁断开时，检查代理、换 Wi‑Fi / 蜂窝网络，或在 API 设置尝试非流式 / 换中转。',
      'Android App 请更新到最新版；App 有原生前台任务护网，后台比网页/PWA 更稳。',
    ],
  },
  aborted: {
    title: '已手动停止',
    summary: '本轮生成被你主动中止。',
    causes: ['点击了停止按钮或切换页面触发了 abort。'],
    fixes: ['无需处理；需要时点「推进」或「重 roll」重新生成。'],
  },
  exception: {
    title: '程序异常',
    summary: '客户端在处理请求或结果时抛出了未捕获错误。',
    causes: [
      '本地存储读写失败。',
      '网络层返回了无法解析的异常结构。',
      '版本 bug。',
    ],
    fixes: [
      '刷新页面后重试。',
      '到设置 → 错误日志复制反馈包。',
      '若伴随 IndexedDB 报错，按提示尝试重新加载或导出备份。',
    ],
  },
  'novelai-config-error': {
    title: 'NovelAI 配置还没填完整',
    summary: '测试尚未发到 NovelAI；本地检查发现 Key、模型或必要配置缺失。正负提示词、画风和自定义描述都可以留空。',
    causes: [
      'NovelAI Key 为空，或输入框仍显示旧 Key 的掩码但草稿没有可用密钥。',
      '模型字段被清空；正常情况下会自动使用内置默认模型。',
    ],
    fixes: [
      '只需填写有效 NovelAI Key；地址留空会走本站内置代理，模型和尺寸可保留默认值。',
      '正向前缀、负面词、模板、画风等均为可选项，不需要为了测试随便填写。',
      '“测试 NovelAI”不要求先正式启用；测试成功后，再决定是否将人物图 Provider 切到 NovelAI。',
    ],
  },
  'novelai-response-error': {
    title: 'NovelAI 返回的图片无法使用',
    summary: '请求可能已经到达 NovelAI 或中转，但返回内容里没有可显示的图片，或图片链接无法下载/预览。',
    causes: [
      '中转返回了不兼容的 JSON、Markdown 或过期图片链接。',
      '返回的是损坏的压缩包，或响应成功但没有图片数据。',
      '中转需要鉴权下载图片，但没有按原请求授权方式提供可访问链接。',
    ],
    fixes: [
      '打开报错详情查看实际响应与请求地址。',
      '官方 Key 建议地址留空；OpenAI 兼容 NovelAI 中转通常填站点根加 /v1。',
      '若接口已扣点却没有图片，不要连续快速重试，先向线路方核对响应格式。',
    ],
  },
  'api-http-error': {
    title: '接口报错',
    summary: '中转/模型接口返回了 HTTP 错误（接口侧），不是 App 本地故障。请优先看状态码与下方接口原文。',
    causes: [
      'API Key 无效、额度不足、权限不够或模型名错误（常见 401 / 403 / 429）。',
      '中转过载、网关超时或上游异常（常见 502 / 503 / 504）。',
      '当前线路不接受这次请求体或参数。',
    ],
    fixes: [
      '先读报错卡片里的接口原文与 HTTP 状态码（以中转返回为准）。',
      '到 API 管理核对地址、Key、模型名与余额。',
      '429 / 503 可稍后重试或换线路；401 / 403 先查密钥与权限。',
      '配置无误仍持续返回 400 / 429 / 5xx 时，把状态码、接口原文与 request id 交给中转站排查。',
    ],
  },
  'api-file-download-failed': {
    title: '接口暂时无法读取图片或文件',
    summary: '接口线路处理请求时，没能下载其中的图片或文件。这不是 App 本地运行故障；可能是线路临时波动，也可能是图片链接已过期或限制外部访问。',
    causes: [
      '中转或上游下载请求里的图片、头像、链接配图或合并聊天记录配图时收到了 404。',
      '线路的文件转换服务短暂异常；这种情况稍后重试可能自行恢复。',
      '同一聊天反复失败时，最近使用的远程图片链接可能已经失效或禁止第三方下载。',
    ],
    fixes: [
      '先稍后重试一次；若自行恢复，通常是接口线路的临时文件下载故障。',
      '只有当前聊天反复失败时，再检查最近发送的图片、链接、合并聊天记录或刚更换的头像。',
      '持续失败可换一条接口线路；下方接口原文和 request id 可交给线路维护者查询。',
    ],
  },
  generic: {
    title: '生成失败',
    summary: '没有拿到可用回复，原因未归入已知分类。若下方有接口/模型原文，请以原文为准。',
    causes: [
      '接口返回了未识别的错误结构。',
      '上游返回了非 JSON 错误页。',
      '业务层自定义错误。',
    ],
    fixes: [
      '优先查看卡片/详情中的原文。',
      '检查 API 设置里的地址、Key、模型名。',
      '复制反馈包以便排查。',
    ],
  },
  'json-parse-failed': {
    title: 'JSON 解析失败',
    summary: '模型回了内容，但不是可解析的 JSON 对象。',
    causes: [
      '模型输出了 Markdown 解释、前后缀废话或截断的 JSON。',
      'Max Tokens 过小导致 JSON 写到一半被截断。',
      '部分中转站在长上下文下更容易空回或乱格式。',
    ],
    fixes: [
      '点「查看详情排查」查看模型原文，确认是否被截断或只有解释文字。',
      '若微博、朋友圈、论坛等结构化功能反复出现，可在聊天模型设置开启「结构强化」。',
      '适当提高 Max Tokens 后重试。',
      '换 JSON 更稳的模型或另一条线路。',
    ],
  },
  'api-html-response': {
    title: '接口返回了网页，不是模型响应',
    summary: '这次请求拿到的是 HTML 网页，不是聊天接口应返回的 JSON 或流式数据；因此不能作为模型正文读取。',
    causes: [
      'API 地址填成了网站首页、登录页或控制台地址，而不是模型接口根地址。',
      '鉴权或路径异常后，中转把请求重定向到了登录页或站点首页。',
      '中转/网关的反向代理把未知 API 路径回退成了 index.html，即使 HTTP 状态仍可能是 200。',
    ],
    fixes: [
      '到「API 管理」核对接口根地址与协议类型，不要填写网站首页、控制台页、登录页或电脑上的 localhost。',
      '重新测试连接，并按渠道文档确认路径是否应由应用自动拼接；避免重复填写 /v1 或 /chat/completions。',
      '地址无误仍返回网页时，请把接口原文、请求编号和实际请求地址交给当前 API 渠道服务商排查路由、重定向或反向代理配置。',
    ],
  },
  'network-cors': {
    title: '已确认的跨域限制',
    summary: '只有接口或运行环境提供明确跨域证据时才使用此分类；普通 Failed to fetch 不足以证明是 CORS。',
    causes: [
      'App 用 WebView 直连中转时触发 CORS（旧版本常见）。',
      '局域网中转填了电脑的 localhost，手机访问的是自己而不是电脑。',
      'http 局域网地址被系统禁止明文流量（需较新 APK）。',
      '中转域名在当前网络下 DNS / 连通失败，有时被误报成拦截。',
    ],
    fixes: [
      '更新 App 热更：聊天会走原生 HTTP，不再吃 https://localhost 的 CORS。',
      '局域网中转请填电脑的局域网 IP（如 http://192.168.1.8:3000），手机与电脑同一 Wi‑Fi。',
      '公网中转优先用 https；仍不通再试换线路或短暂开 VPN 测是否为运营商/DNS 问题。',
      '设置里打开「后台活跃」，生成中尽量保持 App 在前台，减少后台被系统掐断。',
    ],
  },
  'network-unknown': {
    title: '网络层失败，原因不可判定',
    summary: '浏览器只返回了笼统的网络失败，没有暴露足够证据区分跨域、DNS/证书、代理拦截、断网或响应中途断开。',
    causes: [
      '当前网络、DNS、TLS 证书或代理线路临时异常。',
      '浏览器扩展、系统安全策略或接口跨域策略阻止访问。',
      '请求已经到达服务端，但生成完成前后连接断开。',
    ],
    fixes: [
      '先确认设备联网，再用 API 管理的连接测试检查同一线路。',
      '若只在浏览器直连失败，改用预先配置好的同源代理；不要依赖失败后的自动重放。',
      '长生成反复失败时开启流式输出，或换稳定线路。',
      '这类错误不会自动重放可能计费的请求；是否重试由你决定。',
    ],
  },
  'upstream-finish-length': {
    title: '上游输出未完成',
    summary: '上游 API 返回 finish_reason=length，协议块写到一半就停了。这属于上游异常信号，不是本地 Max Tokens 设太小。',
    causes: [
      '中转/网关不稳定，流式传输或网关超时导致提前结束。',
      '上游 bug 或负载过高，在输出远未达模型上限时就返回 length。',
      '部分线路对长 system / 群聊上下文处理异常，偶发截断。',
      '模型原文里能看到协议开头但无闭合结尾，说明是上游截断而非解析器误判。',
    ],
    fixes: [
      '查看「上游返回」里的 finish_reason、completion_tokens 等字段，确认是 API 侧结束信号。',
      '点「重 roll」或换一条中转/模型试一轮；这类问题通常重试可恢复。',
      '若同一线路频繁出现，优先换线路，而不是继续调本地参数。',
      '到设置 → 错误日志可看到 api_finish_length 记录，便于对照反馈。',
    ],
  },
};

const PROTOCOL_PARSE_REASONS = new Set([
  'no-marshmallow-protocol',
  'protocol-plain-text',
  'protocol-format-error',
  'protocol-no-events',
]);

export function isProtocolParseFailure(reason = '') {
  return PROTOCOL_PARSE_REASONS.has(String(reason || '').trim());
}

/**
 * 识别供应商把安全拦截 / 标准拒绝文案塞进正常正文的情况。
 * 仅匹配带有 prompt、request、policy、AI 自称等强特征的模板，避免把角色在剧情里的普通道歉误判为接口拒绝。
 */
export function classifyUpstreamContentRefusal(rawText = '') {
  const text = stripThinkingBlocks(String(rawText || ''))
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return null;

  const googlePatterns = [
    /the prompt could not be submitted/iu,
    /prompt contains sensitive words?/iu,
    /violat(?:e|es|ed|ing) google(?:'|’)?s\s+(?:generative\s+ai|policy|policies|terms)/iu,
    /(?:response|candidate|prompt) (?:was|has been|is) blocked(?: due to| for)? (?:safety|policy|prohibited content|recitation)/iu,
  ];
  if (googlePatterns.some((pattern) => pattern.test(text))) {
    return { provider: 'google', kind: 'safety-refusal' };
  }

  const genericPatterns = [
    /as an ai(?: language)? model.{0,100}(?:can(?:not|['’]t)|unable|must refuse|won['’]t)/iu,
    /(?:i(?:['’]m| am) sorry|i apologize).{0,100}(?:can(?:not|['’]t)|unable to|won['’]t)\s+(?:assist with|help with|comply with|fulfill|process|respond to|provide|continue with).{0,80}(?:request|prompt|content|policy|guidelines?|information|that|this)/iu,
    /(?:request|prompt|content).{0,80}(?:violates?|is against|conflicts with).{0,60}(?:safety|policy|policies|guidelines?|terms)/iu,
    /(?:抱歉|对不起).{0,30}(?:无法|不能|不会).{0,24}(?:协助|帮助处理|满足|遵从|响应|回应|提供).{0,50}(?:请求|提示词|内容|要求)/u,
    /(?:请求|提示词|内容).{0,50}(?:违反|不符合|触发).{0,36}(?:安全政策|内容政策|使用政策|准则|规范)/u,
    /作为(?:一个|一名)?\s*(?:AI|人工智能)(?:语言)?模型.{0,80}(?:无法|不能|不会|必须拒绝)/iu,
  ];
  if (genericPatterns.some((pattern) => pattern.test(text))) {
    return { provider: 'unknown', kind: 'policy-refusal' };
  }

  return null;
}

export function classifyMarshmallowParseFailure(rawText = '', parsed = {}) {
  const text = String(rawText || '');
  const stripped = stripThinkingBlocks(text).trim();

  if (!stripped) {
    return {
      reason: 'empty-api-response',
      error: text.trim()
        ? '上游有输出，但去掉思考块后没有可用正文。'
        : '未从 API 响应中抽到可用正文（上游可能仍有推理 token 或非标准字段）。',
      rawText: text,
    };
  }

  const upstreamRefusal = classifyUpstreamContentRefusal(stripped);
  if (upstreamRefusal) {
    return {
      reason: 'upstream-content-refusal',
      title: upstreamRefusal.provider === 'google'
        ? 'Google / Gemini 拒绝了本次请求'
        : '上游模型拒绝了本次请求',
      error: upstreamRefusal.provider === 'google'
        ? 'Google / Gemini 返回了内容安全拦截说明，本轮没有生成角色回复。请先排查本轮输入与上下文中的敏感词；若确认内容合规仍被拦截，请更换模型或 API 渠道。'
        : '上游模型或渠道返回了拒绝说明，本轮没有生成角色回复。请先排查本轮输入与上下文中的敏感词；若确认内容合规仍被拦截，请更换模型或 API 渠道。',
      rawText: text,
      refusalProvider: upstreamRefusal.provider,
      refusalKind: upstreamRefusal.kind,
    };
  }

  const hasMarker = text.includes(MARSHMALLOW_CHAT_START);
  const hasJsonAttempt = isMarshmallowChatLikelyInProgress(text);
  const jsonErrors = (parsed.errors || []).filter((e) => e?.code === 'invalid_json');
  const hasEvents = (parsed.events || []).length > 0;

  if (!parsed.found && !hasMarker && !hasJsonAttempt) {
    return {
      reason: 'protocol-plain-text',
      error: '模型输出了普通文字，未包含棉花糖协议块。',
      rawText: text,
    };
  }

  if (jsonErrors.length && !hasEvents) {
    const sample = jsonErrors.slice(0, 3).map((e) => `第 ${e.index} 行: ${e.message || 'JSON 无效'}`).join('；');
    return {
      reason: 'protocol-format-error',
      error: `协议块内 JSON 格式错误（${jsonErrors.length} 行无法解析）${sample ? `：${sample}` : ''}`,
      rawText: text,
      parseErrors: jsonErrors.slice(0, 12),
    };
  }

  if ((parsed.found || hasMarker || hasJsonAttempt) && !hasEvents) {
    return {
      reason: 'protocol-no-events',
      error: '找到了协议结构，但没有解析出任何有效事件。',
      rawText: text,
    };
  }

  return {
    reason: 'no-marshmallow-protocol',
    error: '未能从模型输出中识别棉花糖协议。',
    rawText: text,
  };
}

function normalizeText(value = '') {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value || '').trim();
  }
}

function isApiFileDownloadFailure(payload = {}) {
  const text = [
    normalizeText(payload.responseText),
    normalizeText(payload.message || payload.error),
  ].filter(Boolean).join('\n');
  return /get file data failed|failed to download file/i.test(text);
}

function looksLikeHtmlResponse(payload = {}) {
  const body = [payload.responseText, payload.rawText, payload.raw]
    .map((value) => normalizeText(value))
    .find(Boolean) || '';
  const message = normalizeText(payload.message || payload.error);
  return /^\s*<(?:!doctype\s+html\b|html\b|head\b|body\b)/iu.test(body)
    || /API 返回了网页而非 JSON|接口返回了网页|响应不是模型数据.*HTML/iu.test(message);
}

function pickGuideKey(reason = '', payload = {}) {
  const key = String(reason || '').trim();
  if (key === 'length-truncated') return 'upstream-finish-length';
  if (isApiFileDownloadFailure(payload)) return 'api-file-download-failed';
  // HTML 是强响应证据，优先于调用方预先填写的 empty-api-response 等兜底分类。
  if (looksLikeHtmlResponse(payload)) return 'api-html-response';
  if (GENERATION_ERROR_GUIDES[key]) return key;
  const status = Number(payload.status || 0);
  const msg = normalizeText(payload.message || payload.error);
  if (status >= 400 || /API错误 \(\d+\)/.test(msg)) return 'api-http-error';
  if (isProtocolParseFailure(key)) return 'no-marshmallow-protocol';
  return 'generic';
}

function extractApiHttpStatus(payload = {}) {
  const status = Number(payload.status || 0);
  if (status >= 400) return status;
  const msg = normalizeText(payload.message || payload.error);
  const m = msg.match(/API错误\s*\((\d{3})\)/i) || msg.match(/\bHTTP\s+(\d{3})\b/i);
  const fromMsg = Number(m?.[1] || 0);
  return fromMsg >= 400 ? fromMsg : 0;
}

/** 从 message / responseText 抽出接口返回正文（去掉我们加的「API错误 (xxx):」壳）。 */
function extractApiResponseBody(payload = {}) {
  const direct = normalizeText(payload.responseText);
  if (direct) return direct;
  const msg = normalizeText(payload.message || payload.error);
  const m = msg.match(/^API错误\s*\(\d{3}\)\s*:\s*([\s\S]+)$/i);
  if (m) return normalizeText(m[1]);
  return '';
}

/**
 * 报错归属侧：接口侧 / 传输侧 / 协议侧 / 本地 / 已停止。
 * 有 HTTP 错或接口原文时归接口侧，避免用户以为是 App 自己坏了。
 */
export function resolveErrorSide(guideKey = '', payload = {}) {
  const key = String(guideKey || payload.reason || '').trim();
  const status = extractApiHttpStatus(payload);
  const apiBody = extractApiResponseBody(payload);
  if (key === 'aborted') return { id: 'user', label: '已停止' };
  if (key === 'novelai-config-error') return { id: 'client', label: '配置检查' };
  if (key === 'novelai-response-error') return { id: 'api', label: 'NovelAI 响应' };
  if (status >= 400 || key === 'api-http-error' || (apiBody && /API错误 \(\d+\)/i.test(String(payload.message || '')))) {
    return { id: 'api', label: '接口侧' };
  }
  if (key === 'empty-api-response') {
    return { id: 'model', label: '上游输出' };
  }
  if (key === 'upstream-content-refusal') {
    const provider = String(payload.refusalProvider || '').trim().toLowerCase();
    return {
      id: 'api',
      label: provider === 'google' ? 'Google / Gemini 拦截' : '上游内容拦截',
    };
  }
  if (key === 'local-storage-error') {
    return { id: 'client', label: '本地存储' };
  }
  if (['character-deleted-during-generation', 'chat-deleted-during-generation'].includes(key)) {
    return { id: 'client', label: '本地数据' };
  }
  if (key === 'api-html-response') {
    return { id: 'api', label: '接口侧' };
  }
  if (key === 'upstream-finish-length') {
    return { id: 'model', label: '上游输出' };
  }
  if (key === 'stream-error' && payload.streamStats?.sawPageHidden === true) {
    // hidden 只证明请求期间页面曾不可见，不能单凭时间相关性断言系统掐网。
    return { id: 'transport', label: '后台期间断流' };
  }
  if (['stream-error', 'network-cors', 'network-unknown', 'relay-unreachable'].includes(key)) {
    return { id: 'transport', label: '传输侧' };
  }
  if (['relay-upstream-timeout', 'relay-upstream-unavailable'].includes(key)) {
    return { id: 'api', label: '接口线路侧' };
  }
  if (key === 'relay-crypto-error') {
    return { id: 'client', label: '中继配置' };
  }
  if (
    isProtocolParseFailure(key)
    || ['protocol-plain-text', 'protocol-format-error', 'protocol-no-events', 'no-marshmallow-protocol', 'validation-failed', 'json-parse-failed'].includes(key)
  ) {
    return { id: 'model', label: '模型掉格式' };
  }
  if (['client-timeout', 'exception'].includes(key)) {
    return { id: 'client', label: '本地' };
  }
  if (apiBody || normalizeText(payload.rawText || payload.raw)) {
    // 有返回原文但未归类时，默认按「接口/模型有返回」展示，不背锅到本地。
    return { id: 'api', label: '接口侧' };
  }
  return { id: 'unknown', label: '未分类' };
}

export function formatUpstreamResponseText(meta = {}) {
  meta = meta && typeof meta === 'object' ? meta : {};
  const lines = [];
  const finishReason = String(meta.finishReason || '').trim();
  if (finishReason) lines.push(`finish_reason: ${finishReason}`);
  if (meta.requestModel) lines.push(`request_model: ${meta.requestModel}`);
  if (meta.model && meta.model !== meta.requestModel) lines.push(`response_model: ${meta.model}`);
  if (meta.id) lines.push(`response_id: ${meta.id}`);
  const usage = meta.usage && typeof meta.usage === 'object' ? meta.usage : null;
  if (usage) {
    const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount;
    const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount;
    const reasoningTokens = meta.reasoningTokens
      ?? usage.reasoning_tokens
      ?? usage.thoughtsTokenCount
      ?? usage.completion_tokens_details?.reasoning_tokens
      ?? usage.output_tokens_details?.reasoning_tokens;
    const totalTokens = usage.total_tokens ?? usage.totalTokenCount;
    if (promptTokens != null) lines.push(`prompt_tokens: ${promptTokens}`);
    if (completionTokens != null) lines.push(`completion_tokens: ${completionTokens}`);
    if (reasoningTokens != null && Number(reasoningTokens) > 0) {
      lines.push(`reasoning_tokens: ${reasoningTokens}`);
    }
    if (totalTokens != null) lines.push(`total_tokens: ${totalTokens}`);
  }
  if (!lines.length) return '';
  return lines.join('\n');
}

export function formatStreamDiagnostics(payload = {}) {
  const stats = payload.streamStats && typeof payload.streamStats === 'object'
    ? payload.streamStats
    : null;
  if (!stats) return '';
  const lines = [];
  const status = Number(stats.status || payload.status || 0);
  const chunkCount = Number(stats.chunkCount || 0);
  const byteCount = Number(stats.byteCount || 0);
  const contentLength = Number(stats.contentLength || 0);
  const reasoningLength = Number(stats.reasoningLength || 0);
  const reasoningTokens = Number(stats.reasoningTokens || 0);
  const durationMs = Number(stats.durationMs || 0);
  const ttfbMs = Number(stats.ttfbMs);
  const hasTtfb = stats.ttfbMs != null && Number.isFinite(ttfbMs) && ttfbMs >= 0;
  const sawPageHidden = stats.sawPageHidden === true;
  const abortedByClient = String(payload.abortReason || '').trim() === 'user';
  const requestStream = stats.requestStream ?? payload.requestStream;
  const nativeTaskState = stats.nativeTaskState && typeof stats.nativeTaskState === 'object'
    ? stats.nativeTaskState
    : null;

  if (abortedByClient) {
    lines.push('判断：前端收到用户停止/离开指令后主动中止。');
  } else if (sawPageHidden) {
    lines.push('判断：请求期间页面进入过后台，随后传输失败；两者相关，但仅凭这条记录不能确定是系统限网。中转断连、VPN/网络切换或原生桥返回失败也可能造成相同现象。');
    lines.push('建议：回到前台重试；若 APK 上游已有输出但本机仍为 0 字，请同时核对 APK 版本、VPN/代理与下方原生任务证据。iOS/PWA 仍可能受到系统后台挂起限制。');
  } else if (requestStream === false && status >= 200 && status < 300 && contentLength === 0) {
    lines.push('判断：接口已完成非流式响应，但没有可显示正文；这不是流传输中断。');
  } else if (requestStream !== false && status >= 200 && status < 300 && chunkCount === 0) {
    lines.push('判断：前端已收到接口成功响应头，但响应体没有任何流数据；更偏向中转/上游提前关流，不是前端主动切断。');
  } else if (requestStream !== false && status >= 200 && status < 300 && chunkCount > 0 && !stats.sawDone && !stats.finishReason) {
    lines.push('判断：前端已接收部分流数据，随后连接在结束标记前关闭；更偏向中转、上游或网络链路中断。');
  }
  if (status) lines.push(`HTTP 响应：${status}`);
  lines.push(`请求方式：${requestStream === false ? '非流式' : '流式'}`);
  lines.push(`页面进入后台：${sawPageHidden ? '是' : '否'}`);
  lines.push(`前端主动中止：${abortedByClient ? '是' : '否'}`);
  if (durationMs > 0) lines.push(`持续时间：${(durationMs / 1000).toFixed(1)} 秒`);
  if (hasTtfb) lines.push(`首字节等待：${(ttfbMs / 1000).toFixed(1)} 秒`);
  if (requestStream !== false) {
    lines.push(`接收分块：${chunkCount}`);
    lines.push(`接收字节：${byteCount}`);
  }
  lines.push(`正文字符：${contentLength}`);
  if (reasoningLength > 0) lines.push(`推理字符：${reasoningLength}`);
  if (reasoningTokens > 0) lines.push(`推理 tokens：${reasoningTokens}`);
  if (requestStream !== false) lines.push(`收到 [DONE]：${stats.sawDone ? '是' : '否'}`);
  lines.push(`finish_reason：${stats.finishReason || '无'}`);
  if (stats.badSseLines > 0) lines.push(`无法解析的流行：${stats.badSseLines}`);
  if (stats.viaNativeHttp) lines.push(`传输通道：${stats.nativeHttpTransport || '原生 HTTP'}`);
  else if (stats.viaProxyFallback) lines.push('传输通道：同源代理回退');
  else lines.push(`传输通道：${requestStream === false ? '浏览器直连' : '浏览器直连流'}`);
  if (stats.nativeRequestId) lines.push(`原生请求编号：${stats.nativeRequestId}`);
  if (stats.nativeErrorCode) lines.push(`原生错误码：${stats.nativeErrorCode}`);
  if (stats.nativeErrorMessage) lines.push(`原生异常：${stats.nativeErrorMessage}`);
  if (nativeTaskState) {
    lines.push(`原生任务状态：${nativeTaskState.state || '未知'}`);
    lines.push(`原生已落盘字符：${Math.max(0, Number(nativeTaskState.responseLength || 0))}`);
    if (Number(nativeTaskState.status || 0) > 0) lines.push(`原生 HTTP：${Number(nativeTaskState.status)}`);
    if (nativeTaskState.error) lines.push(`原生任务异常：${nativeTaskState.error}`);
  }
  return lines.join('\n');
}

function buildDetailSections(payload = {}) {
  const parts = [];
  const reason = String(payload.reason || '').trim();
  if (reason) parts.push(`reason: ${reason}`);
  const jsonFailureKind = String(payload.jsonFailureKind || '').trim();
  if (jsonFailureKind) parts.push(`jsonFailureKind: ${jsonFailureKind}`);
  const status = Number(payload.status || 0);
  if (status >= 400) parts.push(`status: ${status}`);
  const responseText = normalizeText(payload.responseText);
  if (responseText) parts.push(`apiResponse:\n${responseText.slice(0, 4000)}`);
  const attempts = Array.isArray(payload.requestAttempts) ? payload.requestAttempts : [];
  if (attempts.length) {
    parts.push(`requestAttempts:\n${attempts.map((attempt, index) => {
      const target = normalizeText(attempt?.target) || '未知地址';
      const kind = normalizeText(attempt?.errorKind) || 'unknown';
      const message = normalizeText(attempt?.message) || '请求失败';
      return `${index + 1}. ${target} [${kind}]\n   ${message}`;
    }).join('\n')}`);
  }
  const upstreamResponse = normalizeText(payload.upstreamResponse || formatUpstreamResponseText(payload.upstreamMeta));
  if (upstreamResponse) parts.push(`upstream:\n${upstreamResponse}`);
  if (payload.finishReason) parts.push(`finishReason: ${payload.finishReason}`);
  if (payload.retried != null) parts.push(`retried: ${payload.retried}`);
  if (payload.transportError) parts.push('transportError: true');
  const streamDiagnostics = formatStreamDiagnostics(payload);
  if (streamDiagnostics) parts.push(`streamDiagnostics:\n${streamDiagnostics}`);
  if (payload.usedUrl) parts.push(`usedUrl: ${normalizeText(payload.usedUrl)}`);
  const message = normalizeText(payload.error || payload.message);
  if (message) parts.push(`message: ${message}`);
  if (payload.errors?.length) parts.push(`errors:\n${normalizeText(payload.errors)}`);
  if (payload.rejected?.length) parts.push(`rejected:\n${normalizeText(payload.rejected)}`);
  if (payload.parseErrors?.length) parts.push(`parseErrors:\n${normalizeText(payload.parseErrors)}`);
  return parts.join('\n\n');
}

/** 从 catch 到的 Error 提取可展示字段（含模型原文） */
export function generationErrorFromCatch(err, meta = {}) {
  const responseText = String(
    meta.responseText
    || err?.responseText
    || '',
  ).trim();
  const rawText = String(
    meta.rawText
    || err?.rawText
    || err?.rawResponse
    || responseText
    || '',
  ).trim();
  const msg = String(meta.message || err?.message || '');
  const status = Number(meta.status || err?.status || 0);
  const looksLikeApiHttp = status >= 400 || /API错误 \(\d+\)/.test(msg);
  const looksLikeHtml = looksLikeHtmlResponse({ responseText, rawText, message: msg });
  const looksLikeNetworkUnknown = err?.code === 'opaque_network_error'
    || err?.networkFailure === 'opaque'
    || /浏览器没有提供具体原因|原因不可判定|连接在等待生成或接收结果时中断|浏览器无法确认服务端最终是否完成/i.test(msg);
  const looksLikeCors = /浏览器拦截|WebView 拦截|本地拦截|明确.*CORS/i.test(msg);
  const looksLikeTimeout = !!(err?.timeoutStage || err?.abortReason === 'watchdog')
    || /超时|timeout/i.test(msg);
  const looksLikeStorage = (
    /connection to (?:the )?indexed database server lost|connection has been lost|database has been closed|database connection (?:has been )?lost/i.test(msg)
    || (String(err?.name || '') === 'UnknownError' && /indexed\s*database|database server/i.test(msg))
  );
  const looksLikeEmpty = /未生成内容|空回|empty-api-response|未抽到可用正文/i.test(msg);
  const looksLikeLength = /finish_reason.*length|length-truncated|输出未完成|被截断/i.test(msg)
    || String(err?.finishReason || meta.finishReason || '') === 'length';
  const looksLikeStream = /流式|连接.*断开|传输中断|stream|broken pipe|socket closed|connection reset|ECONNRESET/i.test(msg);
  // TypeError / 本地空引用不要误标成「未抽到可用正文」（接口侧）
  const looksLikeLocalException = err?.name === 'TypeError'
    || err?.name === 'ReferenceError'
    || /Cannot read propert|is not a function|is not defined/i.test(msg);
  // 有接口 HTTP 错时优先归到 api-http-error，避免被 CORS/stream 启发式盖掉。
  const reason = String(
    // IndexedDB 断连的原始异常证据优先于上层兜底 reason；否则调用方先填的
    // empty-api-response 会再次把明确的本地存储故障伪装成接口空回。
    (looksLikeStorage ? 'local-storage-error' : '')
    || (looksLikeHtml ? 'api-html-response' : '')
    || meta.reason
    || err?.reason
    || (looksLikeApiHttp ? 'api-http-error' : '')
    || (looksLikeNetworkUnknown ? 'network-unknown' : '')
    || (looksLikeLocalException ? 'exception' : '')
    || (looksLikeCors ? 'network-cors' : '')
    || (looksLikeTimeout ? 'client-timeout' : '')
    || (looksLikeLength ? 'length-truncated' : '')
    || (looksLikeEmpty ? 'empty-api-response' : '')
    || (looksLikeStream ? 'stream-error' : '')
    || (rawText ? 'json-parse-failed' : 'empty-api-response'),
  ).trim();
  const requestAttempts = meta.requestAttempts || err?.requestAttempts || [];
  const normalized = normalizeGenerationError({
    ...meta,
    message: meta.message || err?.message || '生成失败',
    detail: meta.detail || (requestAttempts.length ? '' : (err?.stack || err?.message || '')),
    rawText,
    responseText,
    status: status || undefined,
    reason,
    usedUrl: meta.usedUrl || err?.usedUrl || '',
    correlationId: meta.correlationId || err?.correlationId || '',
    requestAttempts,
    finishReason: meta.finishReason || err?.finishReason || '',
    jsonFailureKind: meta.jsonFailureKind || err?.jsonFailureKind || '',
    invalidData: meta.invalidData ?? err?.invalidData ?? null,
    upstreamMeta: meta.upstreamMeta || err?.upstreamMeta || null,
    upstreamResponse: meta.upstreamResponse || err?.upstreamResponse || '',
    reasoningText: meta.reasoningText
      || err?.reasoningText
      || meta.upstreamMeta?.reasoningText
      || err?.upstreamMeta?.reasoningText
      || '',
    emptyKind: meta.emptyKind || err?.emptyKind || '',
    requestModel: meta.requestModel || err?.requestModel || '',
    requestStream: meta.requestStream ?? err?.requestStream,
    abortReason: meta.abortReason || err?.abortReason || '',
    streamStats: meta.streamStats || err?.streamStats || null,
    structureApiSection: meta.structureApiSection || err?.structureApiSection || '',
    requestElapsedMs: Number(meta.requestElapsedMs || err?.requestElapsedMs || 0),
    requestMayHaveReachedServer: meta.requestMayHaveReachedServer === true
      || err?.requestMayHaveReachedServer === true,
    resultUnknown: meta.resultUnknown === true || err?.resultUnknown === true,
    targetOrigin: meta.targetOrigin || err?.targetOrigin || '',
    refusalProvider: meta.refusalProvider || err?.refusalProvider || '',
    refusalKind: meta.refusalKind || err?.refusalKind || '',
    at: meta.at || Date.now(),
  });
  recordLastGenerationError(normalized);
  return normalized;
}

export function normalizeGenerationError(payload = {}) {
  const reason = String(payload.reason || '').trim();
  const guideKey = pickGuideKey(reason, payload);
  const baseGuide = GENERATION_ERROR_GUIDES[guideKey] || GENERATION_ERROR_GUIDES.generic;
  const technicalMessage = normalizeText(payload.message || payload.error);
  const apiStatus = extractApiHttpStatus(payload);
  const apiBody = extractApiResponseBody(payload);
  const rawText = normalizeText(payload.rawText || payload.raw || '');
  const reasoningText = normalizeText(
    payload.reasoningText
    || payload.upstreamMeta?.reasoningText
    || '',
  );
  const reasoningLength = Number(payload.streamStats?.reasoningLength || 0);
  const reasoningTokens = Number(
    payload.streamStats?.reasoningTokens
    || payload.upstreamMeta?.reasoningTokens
    || 0,
  );
  const reasoningOriginalUnavailable = !reasoningText
    && (reasoningLength > 0 || reasoningTokens > 0);
  const completedEmpty = payload.emptyKind === 'completed-empty'
    || (reason === 'empty-api-response'
      && (payload.streamStats?.sawDone === true || Boolean(payload.streamStats?.finishReason || payload.finishReason)));
  const emptyKind = payload.emptyKind
    || (reason === 'empty-api-response' && (reasoningLength > 0 || reasoningTokens > 0 || reasoningText)
      ? 'reasoning-only'
      : '')
    || (completedEmpty ? 'completed-empty' : '');
  const requestModel = normalizeText(payload.requestModel);
  const geminiPeakIssue = /gemini/i.test(requestModel)
    && (
      apiStatus === 429
      || ['empty-api-response', 'stream-error', 'upstream-finish-length'].includes(guideKey)
      || ['reasoning-only', 'completed-empty'].includes(emptyKind)
    );
  const geminiPeakNote = '近期高峰期部分 Gemini 渠道容易出现线路拥堵（用户常称“PVP”），表现为空回、只返回思维链、回复截断或 429。这通常是上游模型或渠道环境波动，不一定是本机配置错误；持续不出字时建议暂时换模型，或更换其他 API 渠道。';
  const guide = geminiPeakIssue
    ? {
      ...baseGuide,
      summary: `${baseGuide.summary} ${geminiPeakNote}`,
      causes: [...(baseGuide.causes || []), geminiPeakNote],
      fixes: [...(baseGuide.fixes || []), '连续重试仍不出字时，暂时换用其他模型或更换 API 渠道。'],
    }
    : baseGuide;
  const isApiHttp = guideKey === 'api-http-error' || apiStatus >= 400;
  const side = resolveErrorSide(guideKey, {
    ...payload,
    status: apiStatus || payload.status,
    responseText: apiBody,
    message: technicalMessage,
    rawText,
  });
  // 有返回原文必须留给卡片展示：接口正文优先，其次模型原文。
  const htmlResponseBody = guideKey === 'api-html-response' ? (apiBody || rawText) : '';
  const originalText = htmlResponseBody || apiBody || rawText;
  const originalKind = guideKey === 'upstream-content-refusal'
    ? 'upstream'
    : (htmlResponseBody || apiBody ? 'api' : (rawText ? 'model' : ''));
  // 接口侧：主文案用接口原文，不改写成「App 故障」口吻。
  // 传输侧：用分类摘要；若仍有半截原文，卡片下方单独露原文。
  let message = '';
  if (guideKey === 'api-file-download-failed' || guideKey === 'api-html-response') {
    message = guide.summary;
  } else if (isApiHttp || side.id === 'api') {
    if (apiBody) message = apiBody.length > 360 ? `${apiBody.slice(0, 360)}…` : apiBody;
    else if (technicalMessage) message = technicalMessage;
    else message = guide.summary;
  } else if (guideKey === 'stream-error') {
    message = guide.summary;
  } else {
    message = technicalMessage || guide.summary;
  }
  if (guideKey === 'empty-api-response' && !message.includes('频繁空回请联系当前 API 渠道服务商')) {
    message = `${message} 本次未自动重试；可手动切换流式/非流式请求，或更换模型/API 渠道。频繁空回请联系当前 API 渠道服务商。`;
  }
  const upstreamResponse = normalizeText(payload.upstreamResponse || formatUpstreamResponseText(payload.upstreamMeta));
  const detailBody = buildDetailSections({
    ...payload,
    status: apiStatus || payload.status,
    responseText: apiBody || payload.responseText,
  });
  const streamTechnicalDetail = guideKey === 'stream-error' && technicalMessage && technicalMessage !== message
    ? technicalMessage
    : '';
  const streamDiagnostics = guideKey === 'stream-error' ? formatStreamDiagnostics(payload) : '';
  const detail = originalText
    || reasoningText
    || upstreamResponse
    || (guideKey === 'stream-error'
      ? [streamTechnicalDetail, streamDiagnostics].filter(Boolean).join('\n\n')
      : normalizeText(payload.detail || payload.reason || detailBody))
    || message;
  const title = guideKey === 'api-html-response' ? '' : normalizeText(payload.title);
  const resolvedTitle = title
    || (guideKey === 'api-file-download-failed' ? guide.title : '')
    || (guideKey === 'api-html-response' ? guide.title : '')
    || (isApiHttp && apiStatus ? `接口报错 (${apiStatus})` : '')
    || (emptyKind === 'reasoning-only'
      ? (reasoningOriginalUnavailable ? '接口只有推理计数，正文为空' : '接口只返回了推理内容')
      : '')
    || (emptyKind === 'completed-empty' ? '接口已结束，但正文为空' : '')
    || guide.title;
  const scope = normalizeText(payload.scope) || '生成';
  const diagnostic = normalizeDiagnosticEnvelope({
    ...(payload.diagnostic || {}),
    code: reason || guideKey,
    source: side.id === 'client' ? 'page' : side.id,
    severity: guideKey === 'aborted' ? 'info' : 'error',
    scope,
    message,
    status: apiStatus || payload.status,
    correlationId: payload.correlationId,
    route: typeof location !== 'undefined' ? location.hash || location.pathname : '',
    operation: payload.operation || payload.diagnostic?.operation || '',
    apiKind: payload.apiKind || payload.diagnostic?.apiKind || '',
    at: payload.at,
    evidence: {
      ...(payload.diagnostic?.evidence || {}),
      ...(payload.evidence || {}),
      incidentOrigin: 'generation-error',
      finishReason: payload.finishReason || '',
      jsonFailureKind: normalizeText(payload.jsonFailureKind || ''),
      requestModel: payload.requestModel || '',
      requestStream: payload.requestStream,
      emptyKind,
      reasoningText,
      reasoningOriginalUnavailable,
      requestElapsedMs: Number(payload.requestElapsedMs || 0),
      requestMayHaveReachedServer: payload.requestMayHaveReachedServer === true,
      resultUnknown: payload.resultUnknown === true,
      targetOrigin: normalizeText(payload.targetOrigin || ''),
      refusalProvider: normalizeText(payload.refusalProvider || ''),
      refusalKind: normalizeText(payload.refusalKind || ''),
    },
    actions: isApiHttp ? ['open-main-api'] : [],
  });
  return {
    title: resolvedTitle,
    scope,
    message,
    detail,
    rawText: rawText || apiBody,
    responseText: htmlResponseBody || apiBody,
    originalText,
    originalKind,
    reasoningText,
    reasoningOriginalUnavailable,
    status: apiStatus || undefined,
    side: side.id,
    sideLabel: side.label,
    reason: reason || guideKey,
    guideKey,
    guide,
    transportError: !!payload.transportError,
    at: Number(payload.at || Date.now()) || Date.now(),
    finishReason: payload.finishReason,
    jsonFailureKind: normalizeText(payload.jsonFailureKind),
    invalidData: payload.invalidData ?? null,
    upstreamMeta: payload.upstreamMeta,
    upstreamResponse,
    retried: payload.retried,
    errors: payload.errors,
    rejected: payload.rejected,
    parseErrors: payload.parseErrors,
    refusalProvider: normalizeText(payload.refusalProvider || ''),
    refusalKind: normalizeText(payload.refusalKind || ''),
    requestAttempts: Array.isArray(payload.requestAttempts) ? payload.requestAttempts : [],
    requestModel,
    requestStream: payload.requestStream,
    abortReason: normalizeText(payload.abortReason),
    streamStats: payload.streamStats && typeof payload.streamStats === 'object' ? payload.streamStats : null,
    usedUrl: normalizeText(payload.usedUrl),
    correlationId: String(payload.correlationId || ''),
    structureApiSection: payload.structureApiSection === 'tool' ? 'tool' : 'main',
    emptyKind,
    diagnostic,
  };
}

export function buildGenerationErrorCopyText(error = {}) {
  const normalized = normalizeGenerationError(error);
  const apiBody = normalizeText(normalized.responseText);
  const modelRaw = normalizeText(normalized.rawText);
  const reasoningText = normalizeText(normalized.reasoningText);
  const showModelRaw = modelRaw && modelRaw !== apiBody;
  return [
    `位置：${normalized.scope}`,
    `分类：${normalized.sideLabel || '未分类'}${normalized.side ? ` (${normalized.side})` : ''}`,
    `标题：${normalized.title}`,
    `时间：${new Date(normalized.at).toLocaleString('zh-CN')}`,
    normalized.reason ? `原因码：${normalized.reason}` : '',
    normalized.status ? `HTTP：${normalized.status}` : '',
    normalized.correlationId ? `请求编号：${normalized.correlationId}` : '',
    normalized.streamStats ? `传输证据：\n${formatStreamDiagnostics(normalized)}` : '',
    apiBody ? `接口原文：\n${apiBody}` : '',
    normalized.upstreamResponse ? `上游返回：\n${normalized.upstreamResponse}` : '',
    reasoningText ? `推理原文：\n${reasoningText}` : '',
    normalized.reasoningOriginalUnavailable
      ? '推理原文：上游仅返回了推理 token/字符计数，没有返回可读取的推理文本；无法由计数还原原文。'
      : '',
    normalized.finishReason ? `finishReason：${normalized.finishReason}` : '',
    normalized.retried != null ? `已自动重试：${normalized.retried ? '是' : '否'}` : '',
    `摘要：${normalized.message}`,
    showModelRaw ? `模型原文：\n${modelRaw}` : '',
    !apiBody && !showModelRaw && normalized.detail ? `详情：\n${normalized.detail}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Call only when an error is captured or shown, never from read-only display paths. */
export function recordLastGenerationError(payload = {}) {
  try {
    const normalized = normalizeGenerationError(payload);
    lastGenerationError = normalized;
    saveSupportIncident(normalized.diagnostic);
    sessionStorage.setItem(LAST_ERROR_KEY, JSON.stringify({
      ...normalized,
      rawText: normalized.rawText.slice(0, 120000),
      detail: normalized.detail.slice(0, 120000),
    }));
  } catch (_) {}
}

export function loadLastGenerationError() {
  if (lastGenerationError) return lastGenerationError;
  try {
    const raw = sessionStorage.getItem(LAST_ERROR_KEY);
    if (!raw) return null;
    lastGenerationError = normalizeGenerationError(JSON.parse(raw));
    return lastGenerationError;
  } catch (_) {
    return null;
  }
}

export function saveGenerationErrorPayload(payload = {}) {
  try {
    const normalized = normalizeGenerationError(payload);
    recordLastGenerationError(normalized);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      ...normalized,
      rawText: normalized.rawText.slice(0, 120000),
      detail: normalized.detail.slice(0, 120000),
    }));
    return true;
  } catch (_) {
    return false;
  }
}

export function loadGenerationErrorPayload() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return normalizeGenerationError(JSON.parse(raw));
  } catch (_) {
    return null;
  }
}

export async function openGenerationErrorDetail(payload = {}) {
  saveGenerationErrorPayload(payload);
  const { navigate } = await import('./router.js');
  navigate('generation-error', {}, false);
}
