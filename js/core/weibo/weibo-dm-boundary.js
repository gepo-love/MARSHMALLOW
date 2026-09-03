function clean(value = '', max = 80) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export const WEIBO_DM_RELATIONSHIP_BOUNDARY = [
  '【微博私信关系边界 · 硬规则】',
  '微博关注、粉丝身份、看过主页或在评论区见过，不等于现实中认识，更不等于已有私交。',
  '主页角色与当前用户之间的关系、记忆和称呼只属于他们两人；普通私信发送者不得继承、冒用或知道这些关系内容。',
  '同行、商务联系人只代表可能有公开职业话题；没有明确记录时，也不能自动写成熟人、旧友、暧昧对象或线下联系人。',
  '只有当前这条私信会话中已经给出的消息，才能证明双方聊过什么；不得虚构未展示的旧私信、线下来往、共同回忆、欠回复或亲昵称呼。',
].join('\n');

/** 普通微博私信发送者只能看到主页公开人设，不能读取角色与用户的私有关系字段。 */
export function buildWeiboDmPublicCharacter(character = null, userId = '') {
  if (!character || typeof character !== 'object') return null;
  const privateIds = new Set(['user', clean(userId, 120)].filter(Boolean));
  return {
    ...character,
    relationship: '',
    relationshipToUser: '',
    userRelationship: '',
    userRelationStatus: '',
    relationships: Object.fromEntries(Object.entries(character.relationships || {})
      .filter(([targetId]) => !privateIds.has(clean(targetId, 120)))),
  };
}

/**
 * 给微博私信生成统一的身份边界。existingThreads 只用于告诉模型哪些昵称确实有站内历史；
 * 是否熟悉、熟到什么程度仍只能由随附的同一 thread 消息证明。
 */
export function buildWeiboDmRelationshipBoundary({
  existingThreads = [],
  messages = [],
  currentCounterpartName = '',
} = {}) {
  const existingNames = [...new Set((Array.isArray(existingThreads) ? existingThreads : [])
    .map((thread) => clean(thread?.counterpartName))
    .filter(Boolean))];
  const historyCount = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && !message.deletedAt)
    .length;
  const counterpartName = clean(currentCounterpartName);
  const lines = [WEIBO_DM_RELATIONSHIP_BOUNDARY];

  if (counterpartName) {
    lines.push(historyCount
      ? `当前会话对方是「${counterpartName}」；只可承接下方给出的 ${historyCount} 条本会话消息，不得补造更早的关系。`
      : `当前会话对方是「${counterpartName}」，且没有任何既有消息；这是第一次站内接触，必须按陌生人开场。`);
  } else if (existingNames.length) {
    lines.push(`只有这些昵称有可延续的既有站内会话：${existingNames.join('、')}。生成同名账号时只能承接随附的对应历史；其他昵称一律是第一次联系。`);
  } else {
    lines.push('本次没有提供任何既有私信会话；所有新生成的发送者一律按第一次联系处理。');
  }

  return lines.join('\n');
}
