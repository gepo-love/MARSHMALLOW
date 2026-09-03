import { get, put } from './db.js';
import {
  chatJsonGeneration,
  composeContextualGenerationMessages,
} from './chat-json-generation.js';
import { resolveChatMainApiOverride } from './api-presets.js';

export const CHAT_INTERACTION_SCHEMA_VERSION = 1;
export const CHAT_INTERACTION_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CHAT_INTERACTION_KINDS = new Set([
  'mutual',
  'deep_talk',
  'boundaries',
  'truth_dare',
  'roleplay',
  'challenge',
  'custom',
]);

const CHAT_INTERACTION_PLANNING_LAYERS = Object.freeze([
  'worldbook',
  'characterCards',
  'userCard',
  'chatDirectives',
  'memories',
  'memoryFacts',
  'timePrompt',
  'presetFragments',
]);

export const BUILTIN_CHAT_INTERACTION_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'builtin-mutual-questions',
    kind: 'mutual',
    name: '互相了解',
    summary: '双方都能问，也都要回答。',
    brief: '设计一段自然的双向问答。角色与用户都可以提问、回答和追问；问题应贴合当前关系，不默认双方已经确认关系，也不要求按顺序答完。',
    builtin: true,
  }),
  Object.freeze({
    id: 'builtin-deep-talk',
    kind: 'deep_talk',
    name: 'Deep Talk',
    summary: '从眼前的话题慢慢聊深。',
    brief: '从最近聊天里选择真正值得深入的一处，由角色自然带领。允许停顿、换话题和只聊一个问题；角色也应分享自己的看法，避免审问式连续发题。',
    builtin: true,
  }),
  Object.freeze({
    id: 'builtin-boundaries',
    kind: 'boundaries',
    name: '边界与约定',
    summary: '把在意和不能越过的线说清楚。',
    brief: '结合人设与真实关系阶段，提出一段双向边界或相处约定讨论。不要擅自认定关系已经发展到某阶段；问题可以跳过，最终约定只有用户明确确认后才成立。',
    builtin: true,
  }),
  Object.freeze({
    id: 'builtin-truth-dare',
    kind: 'truth_dare',
    name: '真心话大冒险',
    summary: '题目和任务都由角色临场挑。',
    brief: '设计轻量的真心话或小任务，由角色掌握节奏并根据用户反应临时调整。不要一次倾倒整套题库，不强迫完成全部轮次。',
    builtin: true,
  }),
  Object.freeze({
    id: 'builtin-roleplay',
    kind: 'roleplay',
    name: '情景扮演',
    summary: '先商量一个开场，再自然进入。',
    brief: '提出一个贴合双方人设与当前气氛的情景扮演构想。先用角色口吻给出简短开场和可修改的约定，用户接受后再进入；允许随时淡出，不显示后台模式术语。',
    builtin: true,
  }),
  Object.freeze({
    id: 'builtin-challenge',
    kind: 'challenge',
    name: '任务与挑战',
    summary: '由角色出题，并记得之后接回来。',
    brief: '设计一件适合当前关系和场景的小任务或挑战。任务应具体但不过度复杂，角色需要说明之后会如何自然跟进，不要机械倒计时或强迫用户完成。',
    builtin: true,
  }),
]);

function clean(value = '', max = 1200) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactList(value, limit = 8, max = 180) {
  return (Array.isArray(value) ? value : [])
    .map((item) => clean(item, max))
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeInteractionKind(value = '') {
  const kind = clean(value, 40).toLowerCase();
  return CHAT_INTERACTION_KINDS.has(kind) ? kind : 'custom';
}

function normalizePrivatePlan(value = {}, fallbackQuestions = [], fallbackKind = 'custom') {
  const source = asObject(value);
  const requestedKind = clean(source.kind, 40).toLowerCase();
  const seeds = (Array.isArray(source.seeds) ? source.seeds : [])
    .map((raw) => {
      const item = typeof raw === 'string' ? { text: raw } : asObject(raw);
      const text = clean(item.text || item.prompt || item.idea, 220);
      if (!text) return null;
      const intensity = ['light', 'medium', 'deep'].includes(String(item.intensity || ''))
        ? String(item.intensity)
        : 'medium';
      return {
        type: clean(item.type || 'prompt', 32) || 'prompt',
        text,
        intensity,
      };
    })
    .filter(Boolean)
    .slice(0, 10);
  if (!seeds.length) {
    compactList(fallbackQuestions, 8, 180).forEach((text) => {
      seeds.push({ type: 'prompt', text, intensity: 'medium' });
    });
  }
  return {
    kind: CHAT_INTERACTION_KINDS.has(requestedKind)
      ? requestedKind
      : normalizeInteractionKind(fallbackKind),
    seeds,
    pacing: clean(source.pacing, 320),
    adaptation: clean(source.adaptation, 420),
  };
}

export function chatInteractionTemplatesKey(userId = '') {
  return `chatInteractionTemplates:v${CHAT_INTERACTION_SCHEMA_VERSION}:${encodeURIComponent(clean(userId, 160) || 'guest')}`;
}

export function normalizeChatInteractionTemplate(value = {}, options = {}) {
  const source = asObject(value);
  const builtin = options.builtin === true || source.builtin === true;
  const id = clean(source.id, 160) || `interaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    kind: normalizeInteractionKind(source.kind),
    name: clean(source.name, 36) || '未命名互动',
    summary: clean(source.summary, 80),
    brief: clean(source.brief, 2000),
    builtin,
    createdAt: Math.max(0, Number(source.createdAt) || (builtin ? 0 : Date.now())),
    updatedAt: Math.max(0, Number(source.updatedAt) || (builtin ? 0 : Date.now())),
  };
}

function normalizeStoredTemplates(value = {}) {
  const source = asObject(value);
  const seen = new Set();
  const templates = [];
  (Array.isArray(source.templates) ? source.templates : []).forEach((raw) => {
    const template = normalizeChatInteractionTemplate(raw);
    if (template.builtin || seen.has(template.id) || !template.brief) return;
    seen.add(template.id);
    templates.push(template);
  });
  return {
    schemaVersion: CHAT_INTERACTION_SCHEMA_VERSION,
    templates: templates.slice(0, 80),
  };
}

export async function loadChatInteractionTemplates(userId = '') {
  const key = chatInteractionTemplatesKey(userId);
  const row = await get('settings', key).catch(() => null);
  const stored = normalizeStoredTemplates(row?.value);
  return [
    ...BUILTIN_CHAT_INTERACTION_TEMPLATES.map((item) => normalizeChatInteractionTemplate(item, { builtin: true })),
    ...stored.templates,
  ];
}

export async function saveChatInteractionTemplate(userId = '', value = {}) {
  const key = chatInteractionTemplatesKey(userId);
  const row = await get('settings', key).catch(() => null);
  const stored = normalizeStoredTemplates(row?.value);
  const template = normalizeChatInteractionTemplate({
    ...value,
    builtin: false,
    updatedAt: Date.now(),
    createdAt: Number(value?.createdAt) || Date.now(),
  });
  if (!template.brief) throw new Error('请写下这个互动怎么玩');
  const next = stored.templates.filter((item) => item.id !== template.id);
  next.unshift(template);
  await put('settings', { key, value: normalizeStoredTemplates({ templates: next }) });
  return template;
}

export async function deleteChatInteractionTemplate(userId = '', templateId = '') {
  const id = clean(templateId, 160);
  if (!id || id.startsWith('builtin-')) return false;
  const key = chatInteractionTemplatesKey(userId);
  const row = await get('settings', key).catch(() => null);
  const stored = normalizeStoredTemplates(row?.value);
  const next = stored.templates.filter((item) => item.id !== id);
  if (next.length === stored.templates.length) return false;
  await put('settings', { key, value: normalizeStoredTemplates({ templates: next }) });
  return true;
}

export function normalizeChatInteractionPlan(value = {}, options = {}) {
  const source = asObject(value);
  const forcePropose = options.forcePropose === true;
  const decision = forcePropose || source.decision === 'propose' ? 'propose' : 'wait';
  const kind = normalizeInteractionKind(source.kind || source.planKind || source.privatePlan?.kind);
  const questions = compactList(source.questions, 8, 180);
  const privatePlan = normalizePrivatePlan(source.privatePlan, questions, kind);
  const proposal = clean(
    source.proposal || source.sharedProposal || source.premise || source.intent,
    900,
  );
  return {
    decision,
    kind: privatePlan.kind,
    title: clean(source.title, 48),
    summary: clean(source.summary || source.publicSummary || proposal, 140),
    proposal,
    intent: clean(source.intent, 320),
    opener: clean(source.opener, 320),
    questions,
    rules: compactList(source.rules, 6, 180),
    followUp: clean(source.followUp, 240),
    privatePlan,
  };
}

export function normalizeChatInteractionSession(value = {}, now = Date.now()) {
  const source = asObject(value);
  const createdAt = Math.max(0, Number(source.createdAt) || 0);
  if (!source.id || source.status !== 'active' || !createdAt) return null;
  if (now - createdAt > CHAT_INTERACTION_SESSION_MAX_AGE_MS) return null;
  const plan = normalizeChatInteractionPlan(source.plan, { forcePropose: true });
  return {
    id: clean(source.id, 160),
    status: 'active',
    source: ['manual-arrange', 'manual-blackbox', 'template', 'proactive'].includes(source.source)
      ? source.source
      : 'template',
    templateId: clean(source.templateId, 160),
    templateName: clean(source.templateName, 48),
    title: clean(source.title || plan.title || source.templateName, 48) || '一起聊聊',
    plan,
    openingPending: source.openingPending === true,
    createdAt,
    updatedAt: Math.max(createdAt, Number(source.updatedAt) || createdAt),
  };
}

export function createChatInteractionSession(plan = {}, options = {}) {
  const now = Math.max(1, Number(options.now) || Date.now());
  const normalizedPlan = normalizeChatInteractionPlan(plan, { forcePropose: true });
  return normalizeChatInteractionSession({
    id: `interaction_session_${now}_${Math.random().toString(36).slice(2, 8)}`,
    status: 'active',
    source: options.source || 'template',
    templateId: options.template?.id || '',
    templateName: options.template?.name || '',
    title: normalizedPlan.title || options.template?.name || '一起聊聊',
    plan: normalizedPlan,
    openingPending: true,
    createdAt: now,
    updatedAt: now,
  }, now);
}

export function buildChatInteractionDirective(value = {}, options = {}) {
  const session = normalizeChatInteractionSession(value, options.now || Date.now());
  if (!session) return '';
  const opening = options.opening === true || session.openingPending === true;
  const proactiveOpening = opening && session.source === 'proactive';
  const blackboxOpening = opening && session.source === 'manual-blackbox';
  const backstageSeeds = session.plan.privatePlan.seeds.slice(0, 8);
  const questions = backstageSeeds.length
    ? backstageSeeds.map((item) => `[${item.type}/${item.intensity}] ${item.text}`)
    : session.plan.questions.slice(0, 5);
  const rules = session.plan.rules.slice(0, 4);
  return [
    `【当前互动线：${session.title}】`,
    opening
      ? proactiveOpening
        ? '这是角色获准主动发起的一次提议。本轮用符合人设的口吻自然提出玩法并带出第一个可回应的落点；不要假定对方已经答应，给对方接受、修改、转开或拒绝的空间，也不要等待用户替你主持。'
        : blackboxOpening
          ? '用户已经明确把这次互动完全交给角色决定。不要展示、复述或解释后台预案；直接以符合人设的方式在聊天里自然发起，并给用户真实回应、转开或拒绝的空间。'
          : '双方已经确认这份共同草案。本轮由角色用符合人设的口吻直接进入约定的开场，并带出第一个具体问题、任务或情境；不要重新询问是否开始，也不要等待用户替你主持。'
      : '这是一条可以随时停下、换题或自然淡出的互动线。先回应用户眼前的话，再由角色判断是否追问、分享自己的答案、换一个环节或暂时搁置。',
    '不要把它演成问卷主持、流程播报或后台功能；不要说“模式、题库、模板、进度、规划器”。不要求按顺序或全部完成。',
    session.plan.proposal
      ? `${proactiveOpening || blackboxOpening ? '角色准备采用的玩法' : '双方已确认的玩法'}：${session.plan.proposal}`
      : '',
    session.plan.intent && session.plan.intent !== session.plan.proposal
      ? `角色想推进的方向：${session.plan.intent}`
      : '',
    session.plan.opener ? `开场意图：${session.plan.opener}` : '',
    rules.length ? `可灵活采用的约定：\n${rules.map((item) => `- ${item}`).join('\n')}` : '',
    session.plan.privatePlan.pacing ? `幕后节奏：${session.plan.privatePlan.pacing}` : '',
    session.plan.privatePlan.adaptation ? `临场调整：${session.plan.privatePlan.adaptation}` : '',
    questions.length ? `后台候选内容（不向用户展示；一次只自然使用一项，允许改写）：\n${questions.map((item) => `- ${item}`).join('\n')}` : '',
    session.plan.followUp ? `后续承接：${session.plan.followUp}` : '',
  ].filter(Boolean).join('\n');
}

function compactCharacterBrief(character = {}) {
  const source = asObject(character);
  return [
    clean(source.currentRole, 180) ? `身份与关系：${clean(source.currentRole, 180)}` : '',
    clean(source.personality, 420) ? `性格：${clean(source.personality, 420)}` : '',
    clean(source.speechStyle, 260) ? `表达方式：${clean(source.speechStyle, 260)}` : '',
    clean(source.promptCorpus, 900) ? `核心设定：${clean(source.promptCorpus, 900)}` : '',
    clean(source.notes, 260) ? `角色备注：${clean(source.notes, 260)}` : '',
  ].filter(Boolean).join('\n');
}

function compactRecentConversation(messages = [], character = {}, user = {}) {
  const characterName = clean(character?.name || character?.customNickname, 40) || '角色';
  const userName = clean(user?.name, 40) || '用户';
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && !message.deleted && !message.recalled && message.type !== 'system')
    .slice(-14)
    .map((message) => {
      const sender = message.senderId === 'user' ? userName : characterName;
      const body = clean(message.metadata?.text || message.content, 260);
      return body ? `${sender}：${body}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function interactionReferenceMessageText(message = {}) {
  if (typeof message?.content === 'string') return message.content.trim();
  if (!Array.isArray(message?.content)) return String(message?.content || '').trim();
  return message.content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return typeof part.text === 'string'
        ? part.text
        : (typeof part.content === 'string' ? part.content : '');
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function interactionCharacterRecord(character = {}) {
  if (!character || typeof character !== 'object') return null;
  const record = {
    id: character.id || '',
    name: character.name || '',
    realName: character.realName || '',
    aliases: Array.isArray(character.aliases) ? character.aliases : [],
    birthDate: character.birthDate || '',
    gender: character.gender || '',
    pronouns: character.pronouns || '',
    currentRole: character.currentRole || '',
    currentStatus: character.currentStatus || '',
    userRelationStatus: character.userRelationStatus || '',
    personality: character.personality || '',
    speechStyle: character.speechStyle || '',
    speechCorpus: character.speechCorpus || '',
    promptCorpus: character.promptCorpus || '',
    notes: character.notes || '',
    promptTags: Array.isArray(character.promptTags) ? character.promptTags : [],
    commonEmotes: character.commonEmotes || '',
    appearancePrompt: character.appearancePrompt || '',
    card: character.card && typeof character.card === 'object' ? character.card : {},
    lifeProfile: character.lifeProfile && typeof character.lifeProfile === 'object' ? character.lifeProfile : {},
    residenceAnchor: character.residenceAnchor && typeof character.residenceAnchor === 'object'
      ? character.residenceAnchor
      : {},
    locationProfile: character.locationProfile && typeof character.locationProfile === 'object'
      ? character.locationProfile
      : {},
    relationships: character.relationships && typeof character.relationships === 'object'
      ? character.relationships
      : {},
    translationProfile: character.translationProfile && typeof character.translationProfile === 'object'
      ? character.translationProfile
      : {},
    forumIdentity: character.forumIdentity && typeof character.forumIdentity === 'object'
      ? character.forumIdentity
      : {},
  };
  return Object.values(record).some((value) => (
    typeof value === 'string' ? value.trim() : (Array.isArray(value) ? value.length : Object.keys(value || {}).length)
  )) ? record : null;
}

async function buildChatInteractionContextBundle({
  chat = null,
  user = null,
  messages = [],
  characters = {},
  contextDepth,
} = {}) {
  if (!chat?.id || !user?.id) return { contextMessages: [], systemParts: [], referenceContext: '' };
  const { buildChatContext } = await import('./context/build-chat-context.js');
  const built = await buildChatContext({
    chat,
    user,
    userId: user.id,
    messages,
    characters,
    contextDepth,
    guidanceMode: true,
    presetMode: 'online',
    // 互动筹划不是轻量工具任务。角色要按普通聊天真正拥有的资料来设计，
    // 因此把核心设定层显式列出，避免日后默认层调整时静默漏掉世界书或预设。
    enabledLayers: CHAT_INTERACTION_PLANNING_LAYERS,
    interactionPlanningContext: true,
    worldBookMode: 'full',
    forceFullWorldBook: true,
    disableTopicHook: true,
  });
  const participantIds = (chat.participants || []).filter((id) => id && id !== 'user');
  const fullCharacterRecords = participantIds
    .map((id) => interactionCharacterRecord(characters[id]))
    .filter(Boolean);
  const structuredMessages = Array.isArray(built.messages) ? built.messages : [];
  const fullCharacterBlock = fullCharacterRecords.length
    ? `【完整角色档案 · 未摘要】\n${JSON.stringify(fullCharacterRecords, null, 2)}`
    : '';
  const coreWorldBookReminder = structuredMessages.some((message) => (
    interactionReferenceMessageText(message).includes('[核心设定·必须遵守]')
  ))
    ? '最后提醒：本轮设定库/世界书里标「[核心设定·必须遵守]」的条目仍是角色筹划时必须服从的长期设定；只由本次 JSON 输出字段覆盖旧格式示例，不得把角色约束降级成普通参考资料。'
    : '';
  const referenceMessages = structuredMessages
    .map((message) => {
      const text = interactionReferenceMessageText(message);
      if (!text) return '';
      const label = message.role === 'assistant'
        ? '角色与既有回复'
        : (message.role === 'user' ? '用户与既有对话' : '角色设定、世界书与记忆');
      return `【${label}】\n${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
  return {
    contextMessages: structuredMessages,
    systemParts: [fullCharacterBlock, coreWorldBookReminder].filter(Boolean),
    referenceContext: [
      fullCharacterBlock,
      referenceMessages,
    ].filter(Boolean).join('\n\n'),
  };
}

export async function buildChatInteractionReferenceContext(options = {}) {
  const bundle = await buildChatInteractionContextBundle(options);
  return bundle.referenceContext;
}

function buildExplicitInteractionReferenceSystem(referenceContext = '') {
  const body = clean(referenceContext, Number.MAX_SAFE_INTEGER);
  if (!body) return '';
  return [
    '【角色完整决策资料】',
    '以下是本会话完整读取出的角色资料、全部生效世界书、记忆层、关系、日程与既有对话。角色设定与长期约束需要服从；旧任务中的临时输出格式不替代本次 JSON 格式。',
    body,
  ].filter(Boolean).join('\n\n');
}

export function buildChatInteractionPlanPrompt({
  character = {},
  user = {},
  messages = [],
  template = null,
  forcePropose = false,
  contextProvidedSeparately = false,
  currentPlan = null,
  revisionRequest = '',
} = {}) {
  const characterName = clean(character?.name || character?.customNickname, 40) || '角色';
  const userName = clean(user?.name, 40) || '用户';
  const templateBrief = template
    ? [
      `玩法类型：${normalizeInteractionKind(template.kind)}`,
      `玩法名：${clean(template.name, 48)}`,
      `玩法内容：${clean(template.brief, 1600)}`,
    ].join('\n')
    : '没有指定玩法，由角色根据自己的人设、双方关系和最近聊天自行判断。';
  const revision = clean(revisionRequest, 1200);
  const previousPlan = revision && currentPlan
    ? normalizeChatInteractionPlan(currentPlan, { forcePropose: true })
    : null;
  return [
    '背景',
    `你要从 ${characterName} 的身份与视角，为 ${characterName} 和 ${userName} 筹划一次自然的双向互动。`,
    contextProvidedSeparately
      ? '角色资料、全部生效世界书、记忆、关系、日程与既有对话已按原始 system / user / assistant 层级放在本任务之前；请直接内化后筹划，不要复述资料。'
      : [
        compactCharacterBrief(character) || '没有更多角色资料，只能依据最近对话谨慎判断。',
        '',
        '最近对话',
        compactRecentConversation(messages, character, user) || '暂无足够的最近对话。',
      ].join('\n'),
    '',
    '本次来源',
    templateBrief,
    previousPlan ? `上一版共同草案：\n${JSON.stringify({
      title: previousPlan.title,
      kind: previousPlan.kind,
      summary: previousPlan.summary,
      proposal: previousPlan.proposal,
      opener: previousPlan.opener,
      rules: previousPlan.rules,
      questions: previousPlan.questions,
      followUp: previousPlan.followUp,
      privatePlan: previousPlan.privatePlan,
    })}` : '',
    revision ? `用户想和角色继续商量，这一轮请按这条意见调整：\n${revision}` : '',
    '',
    '任务',
    forcePropose
      ? '用户已经把主动权交给角色，本次必须给出 propose。玩法要符合角色，而不是通用主持人口吻。'
      : '角色已经获得“可主动提议互动”的权限。请判断此刻主动提议是否自然；不合适就返回 wait，不要为了使用功能硬插问卷。',
    '问答必须允许双方都问、都答、都追问；允许跳过、换题、聊到一半自然转开。涉及关系、边界或控制感时必须依据实际人设和关系阶段，不要擅自升级关系。',
    'summary 是默认只给用户看到的一句话主题摘要，简短、有气氛但不剧透题目、任务、转折或开场台词。',
    'proposal 只在用户主动展开商量时显示：用 2～5 句写清双方如何参与，不要写成长篇协议、条款清单或替双方宣布已经成立的约定。rules 只能放需要共同确认的可选约定，不能把角色单方面设计写成既定边界。此时只在商量，不要假定用户已经同意，不要直接进入演出。',
    'privatePlan 是绝不默认展示给用户的幕后预案。按 kind 区分：truth_dare 要同时准备 truth 与 dare，并用 light/medium/deep 标强度；deep_talk 准备 topic 与 followup；mutual 准备 question 与 self_share；boundaries 准备 boundary_topic 与 confirm_point，但不得预设结论；roleplay 准备 scene_beat 与 choice；challenge 准备 task 与 checkin。其它类型用 prompt。seeds 写 4～8 项即可。',
    'opener、privatePlan、followUp 都是角色后台资料。opener 只写开始位置与意图，不要代写长篇最终台词；角色应根据用户真实反应临场调整，而不是机械跑完预案。',
    '',
    '只输出一个 JSON 对象，不要 Markdown 或解释：',
    '{"decision":"wait|propose","kind":"mutual|deep_talk|boundaries|truth_dare|roleplay|challenge|custom","title":"互动名","summary":"默认只显示的一句话主题","proposal":"展开商量时才显示的简短共同构想","intent":"角色为什么现在想做这件事","opener":"确认后从哪里开始","rules":["真正需要双方确认的可选约定"],"privatePlan":{"seeds":[{"type":"truth|dare|topic|followup|question|self_share|boundary_topic|confirm_point|scene_beat|choice|task|checkin|prompt","text":"幕后候选","intensity":"light|medium|deep"}],"pacing":"怎样掌握节奏","adaptation":"怎样依据用户反应调整"},"followUp":"之后如何自然接回来"}',
  ].filter((line) => line !== '').join('\n');
}

export async function planChatInteraction(options = {}) {
  const forcePropose = options.forcePropose === true;
  const explicitReferenceContext = clean(options.referenceContext, Number.MAX_SAFE_INTEGER);
  const bundle = explicitReferenceContext
    ? {
      contextMessages: [],
      systemParts: [buildExplicitInteractionReferenceSystem(explicitReferenceContext)],
    }
    : await buildChatInteractionContextBundle(options);
  const chatId = clean(options.chatId || options.chat?.id, 160);
  const mainApiOverride = await resolveChatMainApiOverride(chatId).catch(() => null);
  const result = await chatJsonGeneration({
    messages: composeContextualGenerationMessages({
      contextMessages: bundle.contextMessages,
      systemParts: bundle.systemParts,
      userContent: buildChatInteractionPlanPrompt({
        ...options,
        contextProvidedSeparately: true,
      }),
    }),
    // 这是角色本人的决策，不是摘要、补全一类工具任务：始终走当前会话的
    // 聊天模型线路，并继承该会话单独选择的主 API 档位。
    requestOptions: {
      forceMainApi: true,
      configOverride: mainApiOverride || undefined,
    },
    request: options.request,
    temperature: 0.75,
    signal: options.signal,
    scope: 'chat-interaction-plan',
    auditContext: {
      operation: 'chat-interaction-plan',
      initiator: options.initiator || (forcePropose ? 'user' : 'character-autonomy'),
      chatId,
      actorIds: [clean(options.character?.id, 160)].filter(Boolean),
      actorNames: [clean(options.character?.name || options.character?.customNickname, 80)].filter(Boolean),
    },
    validate: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      if (!['wait', 'propose'].includes(String(value.decision || ''))) return false;
      if (forcePropose && value.decision !== 'propose') return false;
      return value.decision === 'wait'
        || !!(clean(value.title, 48)
          && clean(value.summary || value.proposal || value.intent, 900)
          && ((Array.isArray(value.privatePlan?.seeds) && value.privatePlan.seeds.length)
            || compactList(value.questions, 8, 180).length
            || clean(value.opener, 320)));
    },
    describeValidationError: () => '互动筹划缺少决定、标题或可用内容',
  });
  return normalizeChatInteractionPlan(result.data, { forcePropose });
}
