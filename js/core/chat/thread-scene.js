import { createMessage, isAllMutedGroup } from '../../models/chat.js';
import { getNowForUser } from '../time-mode.js';
import { filterNonGuidanceMessages } from '../guidance-memory.js';

/**
 * 取最近几条可见消息拼成一句简短小结，用来告诉模型"上一拍已经发生过什么"——
 * 秘密基地/群聊这类靠人工点「推进」驱动的场景，最容易在连续两次推进之间
 * 因为指令一字不差而被模型原样复述上一轮内容，这里给推进指令补上差异化锚点。
 */
export function buildRecentBeatSummary(messages = [], { maxLines = 12, maxChars = 420 } = {}) {
  const visible = filterNonGuidanceMessages(Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.deleted && !m.recalled && m.senderId !== 'system' && m.type !== 'system')
    .slice(-maxLines);
  if (!visible.length) return '';
  const line = visible
    .map((m) => {
      const who = String(m.senderName || m.senderId || '').trim();
      const body = String(m.content || '').replace(/\s+/g, ' ').trim();
      if (!who || !body) return '';
      return `${who}：${body}`;
    })
    .filter(Boolean)
    .join(' / ')
    .slice(0, maxChars);
  return line;
}

export function buildManualTurnTimeAnchor(options = {}) {
  const mode = String(options.mode || 'advance').trim();
  const nowTs = Number(options.nowTs || 0);
  const lastMessage = options.lastMessage || null;
  const lastTs = Number(lastMessage?.timestamp || 0);
  const originalRoundTs = Number(options.originalRoundTs || 0);
  const effectiveGap = nowTs > 0 && lastTs > 0 ? nowTs - lastTs : 0;
  if (mode !== 'reroll' && effectiveGap < 5 * 60 * 1000) return '';

  const formatTime = (ts) => new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const formatGap = (ms) => {
    const minutes = Math.max(1, Math.floor(ms / 60000));
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`;
    const days = Math.floor(hours / 24);
    return `${days} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}`;
  };

  if (mode === 'reroll' && originalRoundTs > 0) {
    return [
      '【手动重生成 · 历史时间锚点】',
      `用户此刻只是点击了“重生成”，没有在此刻重新发送上一条消息。你正在替换约 ${formatTime(originalRoundTs)} 发生的原 AI 回合。`,
      `替代回复必须站在原回合当时的时间点理解前文；不要用当前点击时间重解释旧消息，也不要声称用户“刚刚”发来那条旧消息。`,
    ].join('\n');
  }

  const sender = String(lastMessage?.senderName || lastMessage?.senderId || '上一位发言者').trim();
  return [
    '【手动推进 · 消息时间锚点】',
    `用户此刻只是点击了“推进”，没有发送新消息。上一条可见消息来自 ${sender}，实际发送于 ${formatTime(lastTs)}，距当前约 ${formatGap(effectiveGap)}。`,
    '本轮发生在当前时刻：必须把上一条当作较早前的消息，而不是刚收到；若要承接，应体现迟回、重新开口或时间已经过去后的自然变化，不能把旧的临时动作和计划写成仍在眼前进行。',
  ].join('\n');
}
export function buildAdvanceSceneMessage(chat, userName = '用户', options = {}) {
  const recentBeat = String(options.recentBeat || '').trim();
  const userPresent = options.userPresent !== false;
  const antiRepeat = recentBeat
    ? `\n最近已经发生过（已结束/背景）：${recentBeat}\n这轮请让场景往前走一步（进行中）——新反应、新信息、新动作、话题转向之一。禁止原样复述，也不要只换地点、措辞或 NPC 就重演同一种邀约、误会、吃醋、争执或爆料桥段。`
    : '';
  return createMessage({
    chatId: chat.id,
    senderId: 'system',
    senderName: '场景',
    type: 'text',
    content: userPresent
      ? `[场景引导] 请角色们自然推进当前对话。不要替 ${userName} 发言。${antiRepeat}`
      : `[场景引导·角色间窗口] ${userName} 不在当前窗口，也不会回复。只推进当前窗口参与角色之间的往来；禁止向 ${userName} 搭话、等待其回应，或把发给 ${userName} 的内容写成当前窗口 msg。${antiRepeat}`,
    metadata: { sceneGuide: true, storyAdvance: true },
  });
}

/**
 * 真人感自动接话轮的场景引导：替换掉「推进」语义。
 * 即时你来我往不强制剧情进展或高信息量，也不在场景模块预设低条数。
 */
export function buildRealPersonChatterSceneMessage(chat, userName = '用户', options = {}) {
  const presenceFast = options.presenceFast === true;
  const dialoguePresentation = options.dialoguePresentation === true;
  return createMessage({
    chatId: chat.id,
    senderId: 'system',
    senderName: '场景',
    type: 'text',
    content: [
      dialoguePresentation
        ? `[即时闲聊·现场演绎] 气泡只是承载台词的排版；${userName} 的话一落下，你就自然接上。双方若已见面，默认是在现场正常交谈，不要补写拿手机、看屏幕或打字。这是你来我往的闲聊，不是需要推进什么的回合。不要替 ${userName} 发言。`
        : `[即时闲聊] 你${presenceFast ? '正守着手机' : '刚好看到手机'}，对方消息一来你就接上了。这是你来我往的即时闲聊，不是需要推进什么的回合。不要替 ${userName} 发言。`,
      '- 先接对方刚说的内容，再按角色此刻的表达欲决定是否自然长出态度、联想、经历或新话头；即时闲聊不强制剧情事件、关系推进或高信息量，轻轻来回也可以成立。',
      '- 回复数量、信息密度与分条统一服从【回复节奏 · 错落】和人物语料；表情、单字、react、短语音或一句废话若就是角色此刻完整的反应，可以独立成立；角色还有话时则沿自然气口继续，不把“轻闲聊”误读成固定少回。',
      '- 别查岗、别催对方去做前面提过的事（吃饭/洗澡/睡觉/干活），除非对方自己又提起；也不要每轮汇报自己正在干什么。',
      '- 少用反问收尾：连续秒回的来回里，问句密度应该明显低于平时，不是每条都要抛回去。',
      '- 话题自然进入深谈、重大消息或认真交流时，当轮就按人物与深谈规则回应和展开，不等待对方再次确认，也不把即时闲聊当成收短理由。',
    ].join('\n'),
    metadata: { sceneGuide: true, realPersonChatter: true },
  });
}

/** 真人感追发共用：历史已送达，可见追发必须带来真实增量。 */
export function buildRealPersonChaseNoveltyDirective() {
  return [
    '【追发内容增量 · 硬约束】聊天历史里你上一轮的所有气泡都已经发送成功；先完整认出那些已说内容，不得重发、近义改写、扩写或拆分后再发。',
    '只要本轮输出可见消息，必须至少有一种真实增量：新事实、新观察/联想、有方向的情绪变化、新行动，或新决定。“更用力地表达同一情绪”不算情绪变化。',
    '加强语气、增加修饰和细节、重复承诺/观点/安慰、再问同一个问题，都不算新内容。若此刻没有真实增量，整轮不发可见消息；只有当状态或行动确实变了，才用对应事件留下变化。',
  ].join('\n');
}

/**
 * 真人感追发轮的场景引导：用户没回话，AI 主动再开口。
 * 关键是给「不发」的权利和离屏生活的颜色，而不是逼模型硬找话。
 */
export function buildRealPersonChaseSceneMessage(chat, userName = '用户', options = {}) {
  const secondChase = Number(options.chaseCount || 0) >= 1;
  const dialoguePresentation = options.dialoguePresentation === true;
  const noveltyDirective = buildRealPersonChaseNoveltyDirective();
  if (dialoguePresentation) {
    return createMessage({
      chatId: chat.id,
      senderId: 'system',
      senderName: '场景',
      type: 'text',
      content: [
        `[停顿后的续话·现场演绎] ${userName} 还没有接你上一句。气泡只是承载台词的排版；若双方已见面，默认是在现场交谈，不要补写手机媒介，也不要替 ${userName} 发言。`,
        noveltyDirective,
        `- 这只是分钟级的短暂停顿，不是 ${userName} 的状态证据。若 ${userName} 刚说在加班、工作或忙别的事，默认仍在忙；禁止无据写成睡着、昏睡、贴在桌上或倒在键盘上。`,
        '- 按人设决定是否继续：开口就交出有变化的新内容、改口或自然延展；沉默则让现场动作和情绪成立，不为了填满回合硬找无关话题。具体台词数量交给【回复节奏 · 错落】。',
        '- 若要开口，承接刚才的情绪和现场，让新一句有变化；不要复述上一句，也不要催促或指责对方没有回应。',
        '- 角色可以用一个可见的小动作承接停顿；开启旁白模式时动作交给 narration，未开启时只用台词轻带，不把动作括号塞进 msg。',
        secondChase
          ? '你已经连续补过一次了：这次应当收住，让停顿留下来，不要变成一个人的连环独白。'
          : '沉稳寡言影响开口动机与措辞，不在这里预设消息条数；想说的人顺着当下交出真实内容，不突然跳到无关剧情。',
      ].join('\n'),
      metadata: { sceneGuide: true, realPersonChase: true },
    });
  }
  return createMessage({
    chatId: chat.id,
    senderId: 'system',
    senderName: '场景',
    type: 'text',
    content: [
      `[追发] ${userName} 还没回你上一轮的消息。这轮是你自己决定要不要再开口，不要替 ${userName} 发言。可选的样子（按人设挑一种，不要全做）：`,
      noveltyDirective,
      `- 这只是分钟级的暂时没回，不是 ${userName} 睡着或失去意识的证据。若 ${userName} 刚说在加班、工作或忙别的事，默认仍在忙；禁止无据写成睡着、昏睡、贴在桌上或倒在键盘上，也不要围绕这种猜测追问。`,
      '- 轻顶一下也必须表达真实增量：可用表情包、拍一拍或短语音表达新的情绪方向/动作；若带正文，不得引用旧句只补修饰或再强调一遍。',
      '- 继续原话题只能向前走：带来沉默期间新发生的事、新想到的具体联想，或明确改变行动/决定；否则换新话头或保持安静。',
      '- 你刚才没在干等：可能顺手刷了朋友圈/微博/论坛、去别的群说了两句、给别人点了个赞——回来带一嘴刚看到的东西（上文有素材就用真的，没有就轻轻带过，不编具体可查证的细节）。',
      '- 自嘲圆场收线：「好吧你忙」，然后登记 next_reply_delay 稍后再说。',
      '- 判断此刻不该追：可以登记 next_reply_delay、用合适的 react 留下痕迹，或让角色去过自己的生活；这些选择由人物动机决定，不用空话凑消息。',
      secondChase
        ? '这已经是第二次追了：再没回音就该放下手机了——收个尾或者干脆沉默，不要变成夺命连环call。'
        : '不指责对方不回消息（除非人设和当前关系真的会这么做）；沉稳寡言影响追发意愿和措辞，不在本模块里预设消息条数。',
    ].join('\n'),
    metadata: { sceneGuide: true, realPersonChase: true },
  });
}

export function buildGapFillSceneMessage(chat, userName = '用户', options = {}) {
  const gapMs = Number(options.gapMs || 0);
  const userPresent = options.userPresent !== false;
  const extraHint = String(options.extraHint || '').trim();
  const recentBeat = String(options.recentBeat || '').trim();
  const extra = extraHint ? `\n补充：${extraHint}` : '';
  const recentBeatLine = recentBeat
    ? `\n断档前最后聊到（已结束/背景，不要在补写的消息里原样重复这段内容）：${recentBeat}`
    : '';
  return createMessage({
    chatId: chat.id,
    senderId: 'system',
    senderName: '场景',
    type: 'text',
    content: `${userPresent
    ? `[闲聊补充] ${userName} 此刻没有新发言。`
    : `[角色间窗口补充] ${userName} 不在当前窗口；只补写当前参与角色之间的消息，禁止向 ${userName} 搭话、等待其回应或把给 ${userName} 的内容写进本窗。`}这不是"当前即时续聊"，而是补写从上一条可见消息到现在这段沉默期间，角色可能发过、但还没落库的消息。
按人物在断档期间真实发生的生活与交流动机生成，并服从【回复节奏 · 错落】，本模块不另设条数档。若有多条，分散在这段沉默期间里的合理时间点，不要把它们伪装成同一时刻刚发生的连发。
写法要求：
- 每条棉花糖协议 msg/sticker 事件可以额外加一个 "timeSlot" 字段：late_night / morning / noon / afternoon / evening / night，要和正文语义一致（提早饭用 morning，提午饭用 noon，提下午用 afternoon，提晚饭/晚安用 evening 或 night，半夜失眠用 late_night），系统会据此把这条消息落到断档区间里对应的时间点；拿不准就不用写这个字段。
- 必须服从给定的断档范围与当前小时段，不要跳到想象中的早晨/白天，也不要在深夜时段写白天才会发生的事。
${userPresent
    ? `- 不要替 ${userName} 发言，也不要假装 ${userName} 中途回复过。`
    : `- ${userName} 不参与本窗口；所有 msg 发送者与对话对象都必须是当前窗口成员。`}
- 深夜、忙碌或角色设定明确不方便的时段，先判断角色真实交流动机与状态；这些因素影响内容和时间点，不在本模块里另设“少发或跳过”的数量指令。${extra}${recentBeatLine}`,
    metadata: { sceneGuide: true, gapFill: true },
  });
}

export function buildNarratorMessage(chat, text) {
  const body = String(text || '').trim();
  if (!body) return null;
  return createMessage({
    chatId: chat.id,
    senderId: 'system',
    senderName: '旁白',
    type: 'system',
    content: `【当前轮系统旁白承接】${body}`,
    metadata: { narratorBeat: true },
  });
}

export async function stampSceneMessage(message, userId) {
  if (!message) return null;
  message.timestamp = await getNowForUser(userId);
  return message;
}

export function getLastAiRoundId(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const rid = String(messages[i]?.metadata?.aiRoundId || '').trim();
    if (rid && messages[i]?.metadata?.aiGenerated) return rid;
  }
  return '';
}

export function getSpeakableMemberIds(chat) {
  if (isAllMutedGroup(chat)) return [];
  const muted = new Set(chat?.groupSettings?.muted || []);
  return (chat?.participants || [])
    .filter((id) => id && id !== 'user' && !muted.has(id));
}

export function pickGroupSpeaker(chat, turnIndex = 0) {
  const members = getSpeakableMemberIds(chat);
  if (!members.length) return '';
  const idx = Math.abs(Number(turnIndex) || 0) % members.length;
  return members[idx];
}
