function positiveInteger(value, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

export function normalizeChatBubbleRange(raw = {}) {
  // 既接受设置页存储形态，也接受上游已经归一化过的 { min, max }。
  // 尾部硬限制块会收到后一种，不能再次解析时悄悄回落成默认 1～5。
  const min = positiveInteger(raw.min ?? raw.bubbleRangeMin, 1);
  const max = Math.max(min, positiveInteger(raw.max ?? raw.bubbleRangeMax, 5));
  return { min, max };
}

/**
 * 只有“开关 + 用户实际保存的上下限”同时存在时才启用范围。
 * 旧存档里可能残留单独的 enabled=true；那不是一份完整的用户设置，
 * 不能用展示层的 1～5 回退值悄悄给提示词加限制。
 */
export function resolveEnabledChatBubbleRange(raw = {}) {
  if (!raw || raw.bubbleRangeEnabled !== true) return null;
  const min = Math.trunc(Number(raw.bubbleRangeMin));
  const max = Math.trunc(Number(raw.bubbleRangeMax));
  if (!Number.isFinite(min) || min < 1 || !Number.isFinite(max) || max < 1) return null;
  return normalizeChatBubbleRange({ bubbleRangeMin: min, bubbleRangeMax: max });
}

export function buildChatBubbleRangeHardLimitBlock(raw = {}, { isGroup = false } = {}) {
  const { min, max } = normalizeChatBubbleRange(raw);
  return [
    '【本轮可见 msg 条数 · 用户硬限制 · 最高优先级】',
    `本轮必须在这一次输出中完成 ${min}～${max} 条可见 msg；表情包、语音、图片、旁白、state 与其它隐藏事件不计入文字气泡。先决定人物真正想说的内容，再组织足够的独立气口。`,
    isGroup
      ? `这是用户主动选择的群聊展开强度。达到 ${min} 条之前不得以“少数人参与、有人潜水、没有新刺激、支线已经收住”为由提前停笔；继续检查较早消息、其他成员、追发、插楼与已有支线，让真正相关的成员形成有增量的接力。`
      : `达到 ${min} 条之前不得以“表达欲低、人物话少、已经接住、想留气口”为由提前停笔；从回答、理由、具体细节、个人经历、联想、改口、情绪落点或关系推进中组织符合人物的真实内容。`,
    `不得用同义复述、机械附和、无意义标点、空拆句子或无关新话题凑数。达到 ${min} 条后可在 ${max} 条以内自然收束，绝不能少于 ${min} 条或超过 ${max} 条；不得把缺少的条数留给下一次调用或稍后追发。`,
  ].join('\n');
}

/**
 * 主动/追发任务会作为最末一条 user 指令发送，必须在同一层重新确认会话输出偏好，
 * 否则任务里的“一条消息”“不设上限”等局部措辞会盖过 system 中的用户设置。
 */
export function buildChatBubblePreferenceTaskTail({
  shortBubble = false,
  bubbleRange = null,
} = {}, { isGroup = false } = {}) {
  const rangeBlock = bubbleRange
    ? buildChatBubbleRangeHardLimitBlock(bubbleRange, { isGroup })
    : '';
  if (!shortBubble && !rangeBlock) return '';
  return [
    '【主动消息输出偏好 · 本轮仍然生效】',
    shortBubble
      ? '本会话已开启短气泡回复：把成立的内容按自然口语气口分成 msg；短气泡只改变分句形状，不自行增加或减少整轮条数。'
      : '',
    rangeBlock,
  ].filter(Boolean).join('\n');
}
