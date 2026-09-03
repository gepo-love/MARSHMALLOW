import { chatJsonGeneration } from './chat-json-generation.js';
import { resolveSceneApiConfig } from './api-presets.js';

const SESSION_SCOPE_RE = /节奏|快慢|推进|进度|这场|本场|当前场景|下一轮|接下来|立刻|马上|停在|收束|转折|轮数/i;
const KNOWN_ISSUE_RE = /流水账|上帝视角|不是.*而是|没有.*也没有|负向衬托|拉踩|复述|抢话|替我说话|心理描写|场景重点|节奏|推进|视角|人称/i;

function clean(value = '') {
  return String(value || '').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripModelWrappers(value = '') {
  return clean(value)
    .replace(/^```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<<<THINKING>>>[\s\S]*?<<<END_THINKING>>>/gi, '')
    .trim();
}

export function inferOfflineGuidanceScope(issue = '') {
  return SESSION_SCOPE_RE.test(String(issue || '')) ? 'session' : 'preset';
}

export function assessOfflineGuidanceIssue(issue = '') {
  const text = clean(issue);
  if (!text) return { ready: false, question: '请写下这次最想修正的问题。' };
  if (text.length >= 6 || KNOWN_ISSUE_RE.test(text)) return { ready: true, question: '' };
  return {
    ready: false,
    question: '再具体一点：是哪种句式、视角、描写或推进方式让你不满意？',
  };
}

export function normalizeOfflineGuidanceDraft(value = {}, issue = '') {
  const source = value && typeof value === 'object' ? value : {};
  const localAssessment = assessOfflineGuidanceIssue(issue);
  if (source.ready === false || !localAssessment.ready) {
    return {
      ready: false,
      question: clean(source.question) || localAssessment.question,
      name: '',
      scope: inferOfflineGuidanceScope(issue),
      content: '',
    };
  }
  const content = stripModelWrappers(source.content);
  if (content.length < 40) {
    return {
      ready: false,
      question: '还缺少可执行的写法。请补充一个具体问题或一组“原句 / 想要的效果”。',
      name: '',
      scope: inferOfflineGuidanceScope(issue),
      content: '',
    };
  }
  const fallbackName = clean(issue).replace(/[，。！？；：\n].*$/, '').slice(0, 20) || '线下写作指导';
  return {
    ready: true,
    question: '',
    name: (clean(source.name) || fallbackName).slice(0, 30),
    scope: source.scope === 'session' || source.scope === 'preset'
      ? source.scope
      : inferOfflineGuidanceScope(issue),
    content,
  };
}

export function buildOfflineGuidanceDraftPrompt({
  issue = '',
  sampleText = '',
  scene = {},
} = {}) {
  const sceneBits = [
    scene?.place ? `地点：${clean(scene.place)}` : '',
    scene?.goal ? `本场方向：${clean(scene.goal)}` : '',
    scene?.tone ? `当前基调：${clean(scene.tone)}` : '',
    Number(scene?.rounds) > 0 ? `参考轮数：${Number(scene.rounds)}` : '',
  ].filter(Boolean).join('\n');
  return [
    '背景：用户正在修正一段角色扮演线下叙事，希望把自然语言反馈整理成可直接注入生成请求的写作指导。',
    '',
    '任务：',
    '1. 先判断反馈是否足够具体。若只有“写好点”“不喜欢”等无法执行的信息，ready=false，并只问一个最能补足写法的问题。',
    '2. 若可以执行，提炼成简洁的写作约束。正向方法必须是主体：明确遇到这种情况时应该观察什么、选择什么场景重点、具体写哪些动作/对白/环境/贴身心理，以及这一轮停在哪里。',
    '3. 不要把用户反馈机械扩写成禁词表。只有“不是……而是……”“没有……也没有……”这类高度可识别、容易复发的句式，才可保留一条精确红线和一组坏例/好例；好例必须展示替代写法。',
    '4. “禁止上帝视角总结”要改写成可执行方法：让关系、气氛和排他性由可见动作、对白、环境反应与人物当下能感知的心理呈现，信任读者自行得出结论。',
    '5. “流水账、缺乏重点和心理描写”要改写成：每轮选一个场景重心，围绕触发动作—即时感官—贴身心理—回应动作形成局部推进；心理只能来自当前视角人物，不得替其他人读心。',
    '6. 涉及本场剧情快慢、下一轮推进量或当前节点时 scope=session；可跨场景复用的文风、视角、句式和描写方法用 scope=preset。',
    '7. content 直接写给叙事模型，不要解释你如何整理，不要提“用户反馈”“提示词工程”，不要使用 Markdown 代码围栏。',
    '',
    '只输出严格 JSON：',
    '{"ready":true,"question":"","name":"30字内名称","scope":"session或preset","content":"可直接注入的中文指导，约150~1200字"}',
    '信息不足时：',
    '{"ready":false,"question":"一个具体追问","name":"","scope":"session或preset","content":""}',
    '',
    `用户反馈：\n${clean(issue)}`,
    sceneBits ? `当前场景：\n${sceneBits}` : '',
    sampleText ? `问题样本（未采用参考，不是已发生剧情）：\n${clean(sampleText)}` : '',
  ].filter(Boolean).join('\n');
}

function normalizeDiscussionTurns(turns = []) {
  return (Array.isArray(turns) ? turns : [])
    .map((turn) => {
      const role = turn?.role === 'assistant' ? 'assistant' : 'user';
      const content = clean(turn?.content);
      return content ? { role, content } : null;
    })
    .filter(Boolean);
}

export function buildOfflineGuidanceDiscussionRequest(turns = []) {
  const normalized = normalizeDiscussionTurns(turns);
  const latestIssue = [...normalized]
    .reverse()
    .find((turn) => turn.role === 'user')?.content || '用户还没有描述问题。';
  return [
    '角色扮演继续保持暂停。请只回应下面这条最新指导问题，不要续写剧情：',
    latestIssue,
    '',
    '只输出一个严格 JSON 对象，不要输出 error、解释文字或 Markdown：',
    '{"reply":"给用户看的本体回复","ready":true,"question":"","name":"30字内名称","scope":"session或preset","content":"可直接注入的中文指导"}',
    '如需追问则输出：',
    '{"reply":"回应当前判断并追问一个关键问题","ready":false,"question":"同一个关键问题","name":"","scope":"session或preset","content":""}',
  ].join('\n');
}

export function normalizeOfflineGuidanceDiscussionTurn(value = {}, issue = '') {
  const source = value && typeof value === 'object' ? value : {};
  const draft = normalizeOfflineGuidanceDraft(source, issue);
  const reply = stripModelWrappers(source.reply)
    || clean(source.question)
    || (draft.ready
      ? '我已经把这次讨论整理成一份可编辑的提示词草稿。'
      : draft.question);
  return {
    ...draft,
    reply,
  };
}

function isGuidanceResponseObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function describeOfflineGuidanceValidationError(value, { requireReply = true } = {}) {
  if (!isGuidanceResponseObject(value)) return '本体返回的 JSON 顶层必须是对象';
  if (requireReply && typeof value.reply !== 'string') return '本体返回格式不完整：缺少 reply 文本';
  if (typeof value.ready !== 'boolean') return '本体返回格式不完整：ready 必须是 true 或 false';
  if (value.ready === true && typeof value.content !== 'string') {
    return '本体返回格式不完整：ready=true 时必须提供 content 指导正文';
  }
  return '本体返回的 JSON 字段不符合指导协议';
}

function validateOfflineGuidanceResponse(value, { requireReply = true } = {}) {
  if (!isGuidanceResponseObject(value)) return false;
  if (requireReply && typeof value.reply !== 'string') return false;
  if (typeof value.ready !== 'boolean') return false;
  return value.ready === false || typeof value.content === 'string';
}

export function buildOfflineGuidanceDiscussionPrompt({
  discussion = [],
  sampleText = '',
  scene = {},
  currentGuidance = '',
  currentDraft = null,
  referenceContext = '',
} = {}) {
  const turns = normalizeDiscussionTurns(discussion);
  const sceneBits = [
    scene?.place ? `地点：${clean(scene.place)}` : '',
    scene?.goal ? `本场方向：${clean(scene.goal)}` : '',
    scene?.tone ? `当前基调：${clean(scene.tone)}` : '',
    Number(scene?.rounds) > 0 ? `参考轮数：${Number(scene.rounds)}` : '',
  ].filter(Boolean).join('\n');
  const transcript = turns
    .map((turn) => `${turn.role === 'assistant' ? '本体' : '用户'}：${turn.content}`)
    .join('\n\n');
  const draftContent = clean(currentDraft?.content);
  return [
    '背景：角色扮演已经暂停。你现在是 AI 本体，正在与用户讨论线下叙事应该怎样修改，并在条件成熟时整理出可直接注入生成请求的写作提示词。',
    '',
    '本轮任务：',
    '1. 只回应讨论记录中用户最新提出的问题，不要继续角色扮演，不要续写剧情，也不要替角色发言。',
    '2. 先准确指出问题落在场景重点、视角、动作、对白、贴身心理、推进量、句式还是角色行为模式。信息不足时只追问一个最关键的问题；信息足够时直接给出具体处理思路，不要故意增加门槛。',
    '3. reply 是给用户看的本体回复：自然、简洁、能继续讨论，不要声称读取了思维链，不要使用客服模板。',
    '4. 当要求已经足以执行时，ready=true，并同时生成 name、scope、content；用户仍可继续补充，下一轮要结合现有草稿修订，而不是另起一份无关提示词。',
    '5. content 直接写给叙事模型，正向方法必须是主体：明确遇到这种情况时应该观察什么、选择什么重点、具体写哪些动作/对白/环境/当前视角心理，以及这一轮自然停在哪里。',
    '6. 不要机械扩写禁词表。只有高度可识别、容易复发的句式才保留精确红线，并给出坏例、好例与替代方法；“禁止上帝视角总结”要落实为用可见动作、对白、环境反应和人物可感知心理呈现。',
    '7. “流水账、缺乏重点和心理描写”要落实为：每轮选择一个场景重心，围绕触发动作—即时感官—贴身心理—回应动作形成局部推进；不得替其他人物读心。',
    '8. 当前场景的剧情快慢、下一轮推进量、临时节点用 scope=session；可跨场景复用的文风、视角、句式与角色表现方法用 scope=preset。',
    '9. 不要在 content 中提“用户反馈”“本体讨论”“提示词工程”，不要使用 Markdown 代码围栏。',
    '',
    '只输出严格 JSON：',
    '{"reply":"给用户看的本体回复","ready":true,"question":"","name":"30字内名称","scope":"session或preset","content":"可直接注入的中文指导，约150~1200字"}',
    '需要继续追问时：',
    '{"reply":"回应当前判断并追问一个关键问题","ready":false,"question":"同一个关键问题","name":"","scope":"session或preset","content":""}',
    '',
    sceneBits ? `当前场景：\n${sceneBits}` : '',
    currentGuidance ? `本场当前已启用的指导：\n${clean(currentGuidance)}` : '',
    draftContent ? `当前可继续修订的提示词草稿：\n名称：${clean(currentDraft?.name).slice(0, 30)}\n范围：${currentDraft?.scope === 'session' ? 'session' : 'preset'}\n${draftContent}` : '',
    referenceContext ? `当前完整生成上下文（只用于判断写法，不要扮演或续写）：\n${clean(referenceContext)}` : '',
    sampleText ? `正在排查的上一版正文（未采用样本，不是已发生剧情）：\n${clean(sampleText)}` : '',
    transcript ? `独立指导会话：\n${transcript}` : '独立指导会话：用户还没有描述问题。',
  ].filter(Boolean).join('\n');
}

export async function discussOfflineGuidance({
  discussion = [],
  sampleText = '',
  scene = {},
  currentGuidance = '',
  currentDraft = null,
  referenceContext = '',
  signal = null,
  onProgress = null,
} = {}) {
  const turns = normalizeDiscussionTurns(discussion);
  const issue = turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.content)
    .join('\n');
  const assessment = assessOfflineGuidanceIssue(issue);
  if (!assessment.ready) {
    return normalizeOfflineGuidanceDiscussionTurn({
      ready: false,
      question: assessment.question,
      reply: assessment.question,
    }, issue);
  }
  const apiOverride = await resolveSceneApiConfig().catch(() => null);
  const result = await chatJsonGeneration({
    scope: 'offline-guidance',
    messages: [
      {
        role: 'system',
        content: buildOfflineGuidanceDiscussionPrompt({
          discussion: turns,
          sampleText,
          scene,
          currentGuidance,
          currentDraft,
          referenceContext,
        }),
      },
      { role: 'user', content: buildOfflineGuidanceDiscussionRequest(turns) },
    ],
    temperature: 0.35,
    signal,
    onProgress,
    requestOptions: {
      ...(apiOverride ? { configOverride: apiOverride } : {}),
      auditContext: { apiSection: apiOverride ? 'scene' : 'main' },
    },
    validate: (data) => validateOfflineGuidanceResponse(data),
    describeValidationError: (data) => describeOfflineGuidanceValidationError(data),
  });
  return normalizeOfflineGuidanceDiscussionTurn(result.data, issue);
}

export async function draftOfflineGuidancePrompt({
  issue = '',
  sampleText = '',
  scene = {},
  signal = null,
  onProgress = null,
} = {}) {
  const assessment = assessOfflineGuidanceIssue(issue);
  if (!assessment.ready) {
    return normalizeOfflineGuidanceDraft({
      ready: false,
      question: assessment.question,
    }, issue);
  }
  const apiOverride = await resolveSceneApiConfig().catch(() => null);
  const result = await chatJsonGeneration({
    scope: 'offline-guidance',
    messages: [
      { role: 'system', content: buildOfflineGuidanceDraftPrompt({ issue, sampleText, scene }) },
      { role: 'user', content: '请整理这份线下写作指导，并按上述 JSON 协议返回结果。' },
    ],
    temperature: 0.3,
    signal,
    onProgress,
    requestOptions: {
      ...(apiOverride ? { configOverride: apiOverride } : {}),
      auditContext: { apiSection: apiOverride ? 'scene' : 'main' },
    },
    validate: (data) => validateOfflineGuidanceResponse(data, { requireReply: false }),
    describeValidationError: (data) => describeOfflineGuidanceValidationError(data, { requireReply: false }),
  });
  return normalizeOfflineGuidanceDraft(result.data, issue);
}

export function buildOfflineSessionGuidanceBlock(scene = {}) {
  const content = stripModelWrappers(scene?.guidancePrompt);
  if (!content) return '';
  return [
    '【本场写作指导 · 高优先】',
    '以下要求只约束当前线下场景的后续叙事。先执行其中的正向写法，再用红线做末尾自检；不要在正文复述这些规则。',
    content,
  ].join('\n');
}
