export const SOCIAL_RELATIONSHIP_TONE_RULES = [
  '[社交互动关系语气 · 硬约束]',
  '角色之间的关系是评论、点赞、回复与转发语气的前置条件，不能因为同在角色池就默认互相友好。',
  '关系描述有方向时，以互动发起者自己的视角为准；不得把另一方的好感、敌意或称呼习惯反向套用。',
  '明确写有讨厌、敌对、情敌、竞争、疏远、冷战、戒备或关系恶劣时，不得无缘无故热情夸赞、亲昵称呼、默契起哄、维护对方或像好友一样点赞评论。符合人物时可以不互动、克制客套、阴阳怪气、质疑、拆台或保持距离。',
  '负面关系不等于每次必须公开攻击；沉默和划走同样成立。没有关系证据时也不要擅自写成好友、闺蜜、兄弟或亲密熟人。',
  '只有近期剧情明确显示关系缓和、和解或立场改变时，才允许覆盖旧关系；过往敌意不能仅因本轮需要热闹就自动消失。',
].join('\n');

const NEGATIVE_RELATIONSHIP_RE = /讨厌|反感|敌对|死敌|仇人|宿敌|情敌|竞争|疏远|冷战|戒备|提防|不信任|关系恶劣|看不顺眼|针锋相对|水火不容/;

function relationshipText(from = null, to = null) {
  const toId = String(to?.id || '').trim();
  if (!toId || !from?.relationships || typeof from.relationships !== 'object') return '';
  return String(from.relationships[toId] || '').trim();
}

/** 点赞是明确友好信号；任一方向仍记录负面关系时不自动点赞。 */
export function hasNegativeSocialRelationship(left = null, right = null) {
  return NEGATIVE_RELATIONSHIP_RE.test(relationshipText(left, right))
    || NEGATIVE_RELATIONSHIP_RE.test(relationshipText(right, left));
}
