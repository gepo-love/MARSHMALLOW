/** 匿名一对一匹配 · 目的与关系预设（商业版 · 无战队加权） */

export const MATCH_PURPOSES_SINGLE = [
  {
    id: 'casual',
    label: '随便聊聊',
    description: '没什么特别目的，就是想找个人说话',
    vibePrompt: '这是一场无聊/想找人说话时随手促成的陌生人匹配：双方都是自己主动点开"匿名匹配"、选了"随便聊聊"，才被系统配对到对方——纯属打发时间，谁也不认识谁，不是安排好的对象，也不是误打误撞。可以从天气、最近在做什么、看到什么有趣的开始；氛围轻松，不需要戏剧性，谁先开口都行。',
  },
  {
    id: 'vent',
    label: '想找人吐槽',
    description: '今天/最近不顺心，想倒点苦水',
    vibePrompt: '双方都是自己主动选了"想找人吐槽"这个方向才被匹配到对方——是陌生网友，只是这一刻都攒着一份小怨气。可以先短句反应、互相吐两句、补类似经历，再扩到对方近况；不要急着给建议或当咨询师。',
  },
  {
    id: 'flirt',
    label: '想搞点暧昧',
    description: '想聊点心动的话题，可以暧昧',
    vibePrompt: '双方都是自己主动选了"想搞点暧昧"这个方向才被匹配到对方——图的就是暧昧氛围本身，对面是陌生网友，不是现实里认识、正在处对象的人。【开局必须像刚配上的陌生人】哪怕都选了暧昧向，头几轮也要有真实的陌生感与试探期：先破冰、互相摸底、看对方接不接得住，语气从克制到松动是逐渐的；禁止第一句就叫昵称、开黄腔、上来就熟稔调情或表现出"早就认识"的亲近——暧昧的张力恰恰来自从陌生慢慢升温。之后可以适度互相回应暧昧拉扯，但保持匿名性，不交换真实信息，不约线下。',
  },
  {
    id: 'sad',
    label: '心情不好想找人陪',
    description: '不一定要说什么，就想有人在',
    vibePrompt: '双方都是自己主动选了"心情不好想找人陪"才被匹配到对方——是陌生网友，只是这一刻都不想一个人待着。不一定要说什么，就想有人在；可以安静、有一句没一句、短句搭话，不要急着拉对方走出情绪，也不要单方倾倒。',
  },
  {
    id: 'argue',
    label: '想吵一架',
    description: '想找个不认识的人对喷一下',
    vibePrompt: '双方都是自己主动选了"想吵一架"才被匹配到对方，互为素不相识的对喷陪练——纯粹图嘴仗爽感，不是真结怨、更不是熟人拌嘴。可以接招对喷，但保持理智范围，不要恶毒到伤害真实情绪。',
  },
  {
    id: 'debate',
    label: '想找人辩论',
    description: '有个观点想找人讨论',
    vibePrompt: '双方都是自己主动选了"想找人辩论"才被匹配到对方——是找陌生人讨论观点的局，不是私下认识的辩友。可以各自亮立场、表达不同观点、提出反例，保持理性和好奇。',
  },
  {
    id: 'share',
    label: '想分享一个东西',
    description: '看到/想到了什么，想找人聊',
    vibePrompt: '双方都是自己主动选了"想分享 / 听人分享"才被匹配到对方，谁先抛话题都行——这是陌生网友之间临时凑的分享局。先听对方说完再给出真实反应，不要敷衍夸赞。',
  },
  {
    id: 'late_night',
    label: '凌晨没人陪',
    description: '深夜睡不着，想找个人',
    vibePrompt: '双方都是深夜睡不着、自己主动点了"凌晨没人陪"才被匹配到对方——纯粹是失眠时刻凑到一起的陌生网友，不是认识的人。氛围安静、缓慢，有些飘忽感，话题可能跳跃，谁先开口都行。',
  },
];

export function getMatchPurposeSingleById(id) {
  const raw = String(id || '').trim();
  return MATCH_PURPOSES_SINGLE.find((p) => p.id === raw) || MATCH_PURPOSES_SINGLE[0];
}

export const MATCH_RELATION_INTENTS = [
  {
    id: 'light',
    label: '随缘',
    description: '',
    prompt: '关系期待是轻松随缘。优先像普通网友自然接话，不要急着升温或承诺长期联系。',
  },
  {
    id: 'soft_flirt',
    label: '暧昧',
    description: '',
    prompt: '关系期待是暧昧。但开局仍是陌生人：先破冰试探、随对话逐渐升温，不要一上来就熟稔调情；可以有轻微拉扯，但不掉马、不奔现、不交换现实联系方式。',
  },
  {
    id: 'emotional_company',
    label: '陪伴',
    description: '',
    prompt: '关系期待是陪伴。先接住情绪；不要咨询腔，不要急着给结论。',
  },
  {
    id: 'same_frequency',
    label: '同频',
    description: '',
    prompt: '关系期待是寻找同频。更重视接梗、联想和聊天节奏，不要把对话写成问卷。',
  },
  {
    id: 'tentative',
    label: '试探',
    description: '',
    prompt: '关系期待是试探。可以慢慢靠近、留印象，但别推进太快，保持匿名距离感。',
  },
];

export function getMatchRelationIntentById(id) {
  const raw = String(id || '').trim();
  const alias = raw === 'slow_familiar' ? 'tentative' : raw;
  return MATCH_RELATION_INTENTS.find((item) => item.id === alias) || MATCH_RELATION_INTENTS[0];
}
