/**
 * 棉花糖机 · 群聊 / 私聊话题钩子池
 *
 * 设计铁律：
 * - 每条 hook 只写**方向类目**，不写具体细节（不写"窗外飞鸟"、"监控里偷喝"、"楼下新店"等可被批量复制的样本）。
 * - 具体内容必须由 AI 按角色当下人设/口吻自己填，否则会导致跨角色查重率高、对话同质化。
 * - 注入时强调"人设优先 / 可无视种子"，群聊只是几个人接、几个人岔开、几个人潜水。
 *
 * 群聊池（水群基调，每轮按概率 roll 一条）：覆盖较广，但每类只 1-2 条很宽的引子。
 * 私聊池：极简、只在两人对话自然冒话头时使用，注入概率非常低。
 */

export const GROUP_TOPIC_HOOKS = {
  weather_state: [
    '可以从今天的体感方向起话（天气、季节、室内冷暖、出门感受、状态在线/掉线等），由角色按本人此刻状态自行填具体内容，不预设。',
  ],
  daily_chores: [
    '可以从某件刚发生 / 没做完 / 正在做的生活小事方向起话；具体是哪件事由角色按本人此刻在干什么去填，不预设。',
  ],
  social_link: [
    '可以顺手提一句某个熟人 / 家人 / 旧友 / 远房关系，作为话头自然抛进群；具体提到谁、关于什么事，由角色按本人交际圈自由发挥。',
    '可以从最近被约 / 想约 / 被催 / 想催谁这种关系动态方向起话。',
  ],
  online_content: [
    '可以从今天刷到 / 想分享 / 想吐槽的某条网上内容方向起话；不限定平台、不预设话题，由角色按本人偏好选。',
    '可以从一段让 TA 想反应（笑、骂、看不懂、想转发）的网络内容方向起话。',
  ],
  consumption: [
    '可以从最近的购物欲、想买 / 不该买 / 在等的某样东西方向起话；具体类目由角色按本人爱好走，不预设。',
    '可以从被种草 / 拔草 / 退货 / 等到 / 错过 / 凑单这种消费情绪方向起话。',
  ],
  food_drink: [
    '可以从最近的吃喝偏好方向起话——口味、踩雷、嘴馋、不知道吃什么、想吃但没吃到，按角色饮食习惯自然展开。',
  ],
  hobby_self: [
    '可以从某个个人爱好的近期状态方向起话；不预设具体爱好，按角色本人喜欢什么自由发挥。',
  ],
  tests_label: [
    '可以从最近被人贴的标签、刚做的某个测试、星座 MBTI 这类话引发的反应方向起话——可以是认真说、可以是吐槽、可以是借题发挥。',
  ],
  entertainment: [
    '可以从最近看的影视 / 综艺 / 直播 / 短视频 / 剪辑方向起话；具体哪一部由角色按本人品味挑。',
    '可以从对某部作品 / 某段剧情 / 某个人物强烈想说几句的冲动方向起话——夸或骂均可。',
  ],
  late_night: [
    '可以从作息错乱（睡不着、刚醒、半夜状态、深夜情绪）方向起话；不预设具体动作。',
  ],
  work_school: [
    '可以从工作 / 学习 / 日程里刚发生的一件小事方向起话；不预设职业或情境。',
  ],
  internal_state: [
    '可以从角色当下的身体或情绪状态方向起话——犯困、饿、烦、热、冷、心情好 / 一般 / 不太好之类，按本人偏好自然展开。',
  ],
};

export const PRIVATE_TOPIC_HOOKS = {
  schedule_now: [
    '如果合适，可以从对方 / 自己当下手头正在做或刚做完的事方向自然起话；仅在很久没说话或都没主话题时使用。',
  ],
  social_link: [
    '如果合适，可以顺手提一句一个共同熟人 / 想起的旧人作为话头自然引入；具体提到谁由角色按本人记忆走。',
  ],
  online_content: [
    '如果合适，可以从今天想专门分享给对方的某条内容方向起话；仅在角色真有想分享的冲动时用。',
  ],
  weather_state: [
    '如果合适，可以从天气 / 状态 / 作息这种自然话头切入；仅在长时间冷场或都没主话题时使用。',
  ],
};

/**
 * 从指定池子抽一个钩子，避开最近用过的类目和文本。
 * @param {{ pool: object, recentCategories?: string[], recentSemanticKeys?: string[] }} params
 * @returns {{ category: string, hook: string, semanticKey: string } | null}
 */
export function rollTopicHook({ pool, recentCategories = [], recentSemanticKeys = [] } = {}) {
  const cats = Object.keys(pool || {});
  if (!cats.length) return null;
  const recentCats = new Set((Array.isArray(recentCategories) ? recentCategories : []).slice(-3));
  const eligibleCats = cats.filter((c) => !recentCats.has(c));
  const catPool = eligibleCats.length ? eligibleCats : cats;
  const category = catPool[Math.floor(Math.random() * catPool.length)];
  const hooks = pool[category] || [];
  if (!hooks.length) return null;
  const recentKeys = new Set((Array.isArray(recentSemanticKeys) ? recentSemanticKeys : []).slice(-6));
  const eligibleHooks = hooks.filter((h) => !recentKeys.has(`${category}::${h}`));
  const hookPool = eligibleHooks.length ? eligibleHooks : hooks;
  const hook = hookPool[Math.floor(Math.random() * hookPool.length)];
  return { category, hook, semanticKey: `${category}::${hook}` };
}
