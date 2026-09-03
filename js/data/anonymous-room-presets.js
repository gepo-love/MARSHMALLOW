/** 匿名多人房间 · 主题与记忆档位 */

export const ANONYMOUS_MEMORY_MODES = [
  { id: 'inherit_full', label: '马甲继承', hint: '继承当前档位记忆，前台装作匿名' },
  { id: 'inherit_soft', label: '轻马甲', hint: '继承关系底色，少量跨窗背景' },
  { id: 'room_only', label: '临时房', hint: '只记本房，用于短局隔离' },
];

export function getAnonymousMemoryModeById(id) {
  const raw = String(id || '').trim();
  return ANONYMOUS_MEMORY_MODES.find((m) => m.id === raw) || ANONYMOUS_MEMORY_MODES[0];
}

/** 匿名房 → 日常主聊天：按房间决定是否带回，以及是否已确认其中的匿名 user。 */
export const ANONYMOUS_MAIN_CHAT_INJECT_MODES = [
  { id: 'off', label: '不带回主聊' },
  { id: 'separate', label: '作为匿名经历' },
  { id: 'merged', label: '视为共同经历' },
];

export function getAnonymousMainChatInjectModeById(id) {
  const raw = String(id || '').trim();
  return ANONYMOUS_MAIN_CHAT_INJECT_MODES.find((m) => m.id === raw)
    || ANONYMOUS_MAIN_CHAT_INJECT_MODES[1];
}

/** 最近 48 小时带 50 条，7 天内带 20 条，更早只带已有摘要。 */
export function resolveAnonymousMainChatMessageLimit(lastActivityTs, now = Date.now()) {
  const ts = Number(lastActivityTs || 0);
  const current = Number(now || Date.now());
  if (!ts || !current) return 0;
  const age = Math.max(0, current - ts);
  if (age <= 48 * 60 * 60 * 1000) return 50;
  if (age <= 7 * 24 * 60 * 60 * 1000) return 20;
  return 0;
}

/** 「约线下 / 时光机」叙事场景专用：是否把角色在匿名马甲房的经历带回来、按什么身份关系带回来。
 * 只影响 presetMode==='offline' 的叙事续写（约线下、时光机回忆），不影响日常聊天/通话/语音陪伴。
 * 默认关闭，用户在「约线下」发起页或线下场景设置里手动选择，避免自动注入造成身份误认。 */
export const REGULAR_ANONYMOUS_MEMORY_INJECT_MODES = [
  { id: 'off', label: '不注入', hint: '约线下/时光机里不出现马甲房经历（默认）' },
  { id: 'separate', label: '当作陌生人', hint: '带回马甲房经历，但角色不会把对方当成你本人' },
  { id: 'merged', label: '已经掉马', hint: '角色清楚马甲房那位就是你，按同一人处理' },
];

export function getRegularAnonymousMemoryInjectModeById(id) {
  const raw = String(id || '').trim();
  return REGULAR_ANONYMOUS_MEMORY_INJECT_MODES.find((m) => m.id === raw) || REGULAR_ANONYMOUS_MEMORY_INJECT_MODES[0];
}

export const ANONYMOUS_ROOM_TOPIC_TEMPLATES = [
  { id: 'lounge', label: '随便水群', topic: '日常闲聊', vibe: 'casual' },
  { id: 'vent', label: '吐槽角', topic: '今天有点烦', vibe: 'companion' },
  { id: 'night', label: '深夜树洞', topic: '凌晨睡不着', vibe: 'companion' },
  { id: 'creative', label: '脑洞分享', topic: '最近在想的事', vibe: 'playful' },
  { id: 'food', label: '吃喝安利', topic: '今天吃了什么', vibe: 'casual' },
  { id: 'custom', label: '自定义', topic: '', vibe: 'casual' },
];

export function getAnonymousRoomTopicTemplate(id) {
  const raw = String(id || '').trim();
  return ANONYMOUS_ROOM_TOPIC_TEMPLATES.find((t) => t.id === raw) || ANONYMOUS_ROOM_TOPIC_TEMPLATES[0];
}

export const MATCH_PURPOSES_GROUP = [
  {
    id: 'lounge',
    label: '随便水水',
    description: '没有主题，随心闲聊，谈天说地',
    minMembers: 3,
    maxMembers: 8,
    vibePrompt: '这是一桌因为都主动选了"随便水水"才被系统拼在一起的陌生网友局：每个匿名 ID 都是自己上线、自己点进来找人说话的，没人是局主或值班，也没人是被误拉进来的。可以从天气、最近做什么、看到什么开始；潜水、接梗、短句互动都行。',
  },
  {
    id: 'advisor',
    label: '军师联盟',
    description: '遇到 crush 了怎么办，网友救救孩子',
    minMembers: 3,
    maxMembers: 8,
    vibePrompt: '"感情 / crush 怎么办"主题的拼桌局，每个匿名 ID 都是自己主动选了这个方向才被拼进来的——能被分到这间房，意味着在场绝大多数匿名 ID 自己手里就攒着一份未解的感情纠结：可能在暗恋、在追、被追、纠结要不要主动、要不要放手、要不要回那条消息；偶尔混进来一个"今晚没事路过当军师"的网友也成立，但不要写成全员都在围观某一位讲故事。谁先把自己的卡点抖出来都行，剩下的人按各自人设反应：可以借题讲自己类似的事、互相骂醒、起哄、认真分析、拆台都成立。不要让任何一位（包括最先冒泡的）独自占据"求助者"位，也别把对话写成心理咨询报告。',
  },
  {
    id: 'vent_circle',
    label: '吐槽大会',
    description: '吐槽一下生活中的烦心事',
    minMembers: 3,
    maxMembers: 8,
    vibePrompt: '拼桌吐槽局：每个匿名 ID 都是自己主动选了"吐槽大会"、各自带着一肚子怨气进来的陌生网友。谁先开口都行，其他人可以一起骂、补类似经历、互相安慰，也可以反向凡尔赛。先接情绪，别上价值或当咨询师。',
  },
  {
    id: 'brainstorm',
    label: '脑洞发散',
    description: '奇怪的脑洞增加了',
    minMembers: 3,
    maxMembers: 8,
    vibePrompt: '拼桌脑洞局：每个匿名 ID 都是自己主动选了"脑洞发散"、带着各自半成品想法和荒诞联想进来的陌生网友，谁想抛就抛。可以接烂梗、可以"对对对再来一个"，可以认真分析也可以糊弄，别写成正式讨论会。',
  },
  {
    id: 'late_night',
    label: '夜深人静',
    description: '夜深了……还有谁还醒着？',
    minMembers: 3,
    maxMembers: 8,
    vibePrompt: '深夜拼桌局：每个匿名 ID 都是自己睡不着、主动点了"夜深人静"才被拼进来的网友，不是被拉来的。氛围安静、缓慢，话题跳跃，有一句没一句也行，可能突然有人 emo、也可能突然有人分享外卖刚到。',
  },
  {
    id: 'mixed_party',
    label: '随机拼桌',
    description: '不知道干什么总之拼一桌一起做点什么吧',
    minMembers: 3,
    maxMembers: 8,
    vibePrompt: '随缘拼桌局：每个匿名 ID 都是自己主动点了"随机拼桌"、带着自己的画风进来的陌生网友，没有谁是局主或主持人。可能有人提议一起干点什么（看片、文字游戏、互问问题），也可能就先互相打量。',
  },
  {
    id: 'literary',
    label: '文艺之夜',
    description: '从诗词歌赋到人生哲学',
    minMembers: 3,
    maxMembers: 8,
    vibePrompt: '文艺 / 审美 / 哲学拼桌局：每个匿名 ID 都是自己主动选了"文艺之夜"、对这些话题有兴趣才被拼进来的，各自有偏好的诗、歌、电影、书、观念。可以推荐、可以争论审美、可以引用一两句，保持网友口吻，别写成论文或朗诵会。',
  },
];

export function getMatchPurposeGroupById(id) {
  const raw = String(id || '').trim();
  const alias = {
    debate_club: 'literary',
    game_night: 'mixed_party',
    emotional_support: 'late_night',
  }[raw] || raw;
  return MATCH_PURPOSES_GROUP.find((p) => p.id === alias) || MATCH_PURPOSES_GROUP[0];
}
