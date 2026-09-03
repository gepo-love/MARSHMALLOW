import { sanitizeDiagnosticValue } from './diagnostic-envelope.js';

function cleanExcerpt(value = '', max = 900) {
  const safe = String(sanitizeDiagnosticValue(String(value || '')) || '')
    .replace(/\s+/g, ' ')
    .trim();
  return safe.slice(0, max);
}

function check(label, status, detail) {
  return {
    label: String(label || '').slice(0, 80),
    status: ['pass', 'warning', 'failed'].includes(status) ? status : 'warning',
    detail: String(detail || '').slice(0, 240),
  };
}

export function buildConversationReplyScenario({
  conversationKind = 'unknown',
  viewerKind = 'user',
  participantCount = 0,
  userPresent = false,
  senderKind = 'participant',
  senderKnown = true,
  messageType = 'text',
  excerpt = '',
  excerptApproved = false,
} = {}) {
  const count = Math.max(0, Number(participantCount || 0));
  const findings = [
    check(
      '会话参与结构',
      count >= 2 ? 'pass' : 'warning',
      count >= 2 ? `已识别 ${count} 名参与者` : '参与者数量异常或尚未完整载入',
    ),
    check(
      '回复发送者映射',
      senderKnown ? 'pass' : 'failed',
      senderKnown ? '发送者能对应到当前会话参与者' : '发送者无法对应到当前会话参与者，疑似身份映射异常',
    ),
    check(
      '当前观察视角',
      viewerKind === 'character-phone' && userPresent
        ? 'warning'
        : 'pass',
      viewerKind === 'character-phone'
        ? '当前从角色手机视角查看，需要重点核对“我/对方”的归属'
        : (userPresent ? '当前会话包含用户' : '当前是用户不在场的旁观会话'),
    ),
  ];
  const failed = findings.some((item) => item.status === 'failed');
  const warning = findings.some((item) => item.status === 'warning');
  const summary = failed
    ? '本地自查发现参与者或发送者映射异常，较可能是会话身份组装问题。'
    : (warning
      ? '本地自查发现当前会话视角较复杂，需要结合选中的异常回复判断。'
      : '本地结构检查未发现硬错误；若回复认错聊天对象，更可能是模型对会话身份或指代理解偏差。');
  return {
    scenarioKind: 'conversation-reply-review',
    conversationKind: String(conversationKind || 'unknown').slice(0, 60),
    viewerKind: String(viewerKind || 'user').slice(0, 40),
    participantCount: count,
    userPresent: userPresent === true,
    selectedSenderKind: String(senderKind || 'participant').slice(0, 40),
    selectedSenderKnown: senderKnown === true,
    selectedMessageType: String(messageType || 'text').slice(0, 40),
    selfCheckStatus: failed ? 'failed' : (warning ? 'warning' : 'pass'),
    selfCheckSummary: summary,
    selfCheckFindings: findings,
    excerptConsent: excerptApproved === true,
    approvedExcerpt: excerptApproved ? cleanExcerpt(excerpt) : '',
  };
}

export function buildScenarioSupportAnswer(diagnostic = null) {
  const evidence = diagnostic?.evidence;
  if (!evidence || evidence.scenarioKind !== 'conversation-reply-review') return null;
  const findings = Array.isArray(evidence.selfCheckFindings)
    ? evidence.selfCheckFindings.slice(0, 6)
    : [];
  const reproduction = `在“${diagnostic.routeLabel || '聊天详情'}”长按一条异常 AI 回复，选择“让芥末检查”。`;
  return {
    title: '已检查这条回复所在场景',
    answer: String(evidence.selfCheckSummary || '已完成当前会话结构检查。'),
    steps: findings.map((item) => `${item.label}：${item.detail}`),
    actions: [],
    needsMoreInfo: evidence.excerptConsent !== true,
    followUp: evidence.excerptConsent === true
      ? '已获得授权，仅使用这条选中的回复继续判断；不会读取整段聊天。'
      : '未读取回复正文，只能检查会话结构。',
    feedbackRecommendation: evidence.selfCheckStatus === 'pass' ? 'if_unresolved' : 'recommended',
    feedbackSummary: `AI 回复可能认错会话对象。${evidence.selfCheckSummary || ''}`,
    feedbackReproduction: reproduction,
    source: 'diagnostic',
  };
}

export function buildGenerationFailureSupportAnswer(error = null) {
  if (!error?.diagnostic) return null;
  const diagnostic = error.diagnostic;
  const operation = String(diagnostic.operation || '').trim();
  const isReroll = /roll|重生成|重试/i.test(operation);
  const guideSteps = Array.isArray(error.guide?.fixes) ? error.guide.fixes.slice(0, 4) : [];
  const chainNote = isReroll
    ? '这次失败发生在聊天重 roll 的真实生成链路。API 设置页测试成功只代表基础连接可用，不代表长上下文、流式响应、协议解析和消息落库都成功。'
    : '已根据这次实际业务请求的错误码、传输和解析结果完成本地分类。';
  return {
    title: `已自查：${error.title || '生成失败'}`,
    answer: `${chainNote}${error.guide?.summary ? ` ${error.guide.summary}` : ''}`,
    steps: guideSteps,
    actions: Array.isArray(diagnostic.actions) ? diagnostic.actions : [],
    needsMoreInfo: false,
    followUp: '按以上步骤重试后仍失败，可直接提交这次真实业务链路的工单。',
    feedbackRecommendation: 'if_unresolved',
    feedbackSummary: `${operation || error.scope || '生成操作'}失败：${error.message || error.title || '未知错误'}`,
    feedbackReproduction: `在“${diagnostic.routeLabel || error.scope || '相关页面'}”执行“${operation || '生成'}”时失败。`,
    source: 'diagnostic',
  };
}

export function buildRecentOperationSupportAnswer(diagnostic = null) {
  const operation = diagnostic?.evidence?.latestOperation;
  if (!operation || !['started', 'failed', 'no-visible-result'].includes(operation.status)) return null;
  const label = String(operation.label || '页面操作');
  const noResult = operation.status === 'no-visible-result' || operation.status === 'started';
  return {
    title: `已检查：${label}`,
    answer: noResult
      ? `系统记录到“${label}”已经触发，但没有检测到新的可见结果。API 设置页测试成功只代表基础连接可用，实际业务链路仍可能卡在长上下文、流式响应、协议解析或消息落库阶段。`
      : `系统记录到“${label}”失败${operation.code ? `，错误分类为 ${operation.code}` : ''}。`,
    steps: [
      '先确认页面没有仍停留在“正在生成”或等待状态。',
      '重试一次；若仍无结果，直接提交下方工单，系统会附带本次操作状态和最近脱敏日志。',
    ],
    actions: [],
    needsMoreInfo: false,
    followUp: '这种情况不能只用 API 设置页测试结果判断。',
    feedbackRecommendation: 'recommended',
    feedbackSummary: `${label}${noResult ? '触发后没有可见结果' : '执行失败'}${operation.code ? `（${operation.code}）` : ''}`,
    feedbackReproduction: `在“${diagnostic.routeLabel || '当前页面'}”执行“${label}”后${noResult ? '没有出现结果' : '出现失败'}。`,
    source: 'diagnostic',
  };
}
