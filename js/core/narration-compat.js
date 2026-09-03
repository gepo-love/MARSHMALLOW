/**
 * 叙事请求兼容工具。
 *
 * 线下 / 番外请求默认保留真实的 system / user / assistant 层级。
 * chatWithEmptyFallback 是历史兼容入口；现在只请求一次，不再因空回静默重试。
 */

/**
 * 历史兼容入口：只调用一次 apiChat。
 *
 * 旧版会在空回后把消息折叠为单 user 再请求一次。第三方线路可能按次收费，
 * 用户一次操作不应静默扩张成多次模型调用，因此这里不再自动重发。
 * @param {Function} apiChat - core/api.js 的 chat 函数
 * @param {Array} messages
 * @param {object} options - 原样传给 apiChat 的选项
 */
export async function chatWithEmptyFallback(apiChat, messages, options = {}) {
  return apiChat(messages, options);
}

/**
 * 双方视角结构化短块（聊天 / 线下共用口径）。
 * 身份归属、防代写、动作进 status、心理进 inner；群聊再钉「每人只写自己」。
 */
export function buildDualPerspectiveBlock({
  offline = false,
  isGroup = false,
  userPresent = true,
} = {}) {
  if (!userPresent) {
    return [
      '【当前窗口参与者边界 · 最高优先】',
      '1. user 不在当前窗口、看不到这里的消息，也不会在这里回复。',
      '2. 只允许当前窗口中的角色彼此发言；每条 msg 的发送者和实际对话对象都必须属于当前窗口。',
      '3. 可以在符合知情边界时谈到 user，但只能作为不在场的第三人；禁止向 user 搭话、等待 user 回应，或把本应发给 user 的话写进当前窗口。',
      '4. 每名角色只写自己的言行与 state，禁止互换身份、记忆、动作或内心。',
    ].join('\n');
  }
  const lines = [
    '【双方视角 · 结构化】',
    '1. 用户与角色是两个独立主体：用户侧台词/动作/内心只来自用户消息与【用户档案】，禁止由 AI 代写、替用户做决定或替用户接话。',
    '2. 角色只输出自己的可见言行（msg 等）与自己的 state；禁止用旁白调度用户，禁止把用户做过的事写成角色做的，也禁止把角色动作写成用户做的。',
    '3. 角色心理只进 state.inner（禁止动作/表情/场景）；角色当下动作与场景只进 state.status；二者禁止混写。',
    '4. 外貌与经历：用户只取【用户档案】，角色只取【角色 ·】卡，禁止互换、合并或串人。',
  ];
  if (isGroup) {
    lines.push('5. 群聊/多角色：每人只写自己的动作与心声；临时 NPC 也可写极简 state；禁止一人旁白指挥全场或代写用户。');
  } else if (offline) {
    lines.push('5. 线下叙事：可见正文写场景与角色侧反应；用户侧留白等用户自己推进（导演模式另有说明时从其说明）。');
  } else {
    lines.push('5. 聊天续写：从角色本人出发接话；用户说了什么以最近用户气泡为准，不要脑补用户没做过的事。');
  }
  return lines.join('\n');
}

/**
 * 叙事模式三开关的规则文案：防抢话 / 防转述 / 导演模式。
 * 唯一实现，各叙事管线（主聊天 buildChatSystemPrompt、番外剧场 au-theater 等）共用同一份文案，
 * 存储/读取各自走自己的 prefs 来源（chatPrefs 等），这里只负责「按 prefs 拼规则文本」。
 * 时光机-旁观回顾等「用户不在场」的场景传 skip:true 跳过整段注入。
 * 主聊天已改用 buildDualPerspectiveBlock 覆盖防抢话口径时，可不再单独注入 antiInterruption。
 */
export function buildNarrativeModeDirectivesBlock(prefs = {}, { skip = false } = {}) {
  if (skip) return '';
  const lines = [];
  if (prefs.antiInterruption !== false) {
    lines.push([
      '【防抢话 · 硬限制】禁止扮演或代写用户这一侧的任何内容：不写用户的台词、动作、内心独白、表情，不替用户做决定、接话或完成选择。',
      '角色只负责自己这一侧的反应和推进；该由用户说什么、做什么，留白等用户自己发出来，不要因为"接得上"就顺手替对方写了。',
    ].join('\n'));
  }
  if (prefs.noParaphrase !== false) {
    lines.push('【防转述】正文开头不要复述、总结或回忆上一轮已经发生的剧情——上一轮结尾就是这一轮起点，直接从时间线继续往下写或用一个新细节切入，不要"先重复一遍刚才的事"再接着说。');
  }
  if (prefs.directorMode === true) {
    lines.push([
      '【导演模式】用户很可能只给一句简单的剧情指令（去哪、做什么、发生了什么），不是完整台词或细节描写。',
      '把它当剧情大纲而不是待复述的台本：按角色人设和当前场景把动作、环境、心理活动、对话都扩写完整，输出一段有血有肉的正文，不要原样把用户那句话搬进正文里当成台词。',
    ].join('\n'));
  }
  return lines.join('\n\n');
}
