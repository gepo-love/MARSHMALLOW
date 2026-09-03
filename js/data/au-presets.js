/** 中性 genre 预设 · 无 IP / 无势力映射 */

export const AU_PRESETS = [
  {
    id: 'au-abo',
    name: 'ABO 设定',
    icon: '🌙',
    description: '在现有世界观上叠加 Alpha/Beta/Omega 生理与社会规则',
    category: '基础规则',
    worldBookOverlay: `[特殊设定·ABO]
在现有世界观上叠加 ABO 性别分化与社会规则。保留角色原有性格与关系底色；Omega 不等于弱势，Alpha 不等于霸道。
具体分化、信息素反应、社会禁忌与配对规则由用户自行补充；若与默认身份冲突，以本设定为准。`,
    strongOverride: true,
    priority: 0,
  },
  {
    id: 'au-sentinel-guide',
    name: '哨向设定',
    icon: '🛡️',
    description: '哨兵/向导能力体系叠加',
    category: '基础规则',
    worldBookOverlay: `[特殊设定·哨向]
在现有世界观上叠加哨兵与向导设定。精神图景、结合热、塔/机构管理、匹配制度等细节可由用户补充。
能力与人格独立：不要因为角色是向导就写成被动，也不要因为角色是哨兵就写成粗暴控制型。`,
    strongOverride: true,
    priority: 0,
  },
  {
    id: 'au-university',
    name: '大学校园',
    icon: '🎓',
    description: '全员大学生/研究生，冲突围绕校园生活',
    category: '世界背景',
    worldBookOverlay: `[特殊设定·大学校园]
默认背景为现代大学校园：上课、社团、宿舍、评优、实习、论坛热帖、活动排练与校内资源竞争。
角色可映射为学生、学长学姐、老师、辅导员、社团负责人等。冲突应建立在校园制度与人际网络上，而不是职业竞技语境。
保留人物性格、关系底色与竞争结构；凡与校园 AU 冲突的默认职业/组织身份，以本设定映射为准。`,
    strongOverride: true,
    priority: 10,
  },
  {
    id: 'au-entertainment',
    name: '娱乐圈',
    icon: '🎬',
    description: '演员、歌手、偶像、经纪公司与舆论场',
    category: '世界背景',
    worldBookOverlay: `[特殊设定·娱乐圈]
默认背景为现代娱乐圈：经纪公司、通告、榜单、综艺、商务代言、粉丝舆论与同行竞争。
表面反应应更克制体面，真正的站队、 jealousy、试探与资源争夺压在暗线里。
保留人物性格与关系底色；凡与娱乐圈 AU 冲突的默认职业身份，以本设定映射为准。`,
    strongOverride: true,
    priority: 10,
  },
  {
    id: 'au-magic-academy',
    name: '魔法学院',
    icon: '🧙',
    description: '魔法学校、院系竞争与试炼',
    category: '世界背景',
    worldBookOverlay: `[特殊设定·魔法学院]
默认背景为魔法学院：分院/派系、课程、试炼、禁书研究、社团与年级首席竞争。
冲突建立在学院制度、魔法能力、禁忌研究与家系背景上。
保留人物性格与关系底色；凡与魔法学院 AU 冲突的默认现代职业身份，以本设定映射为准。`,
    strongOverride: true,
    priority: 10,
  },
  {
    id: 'au-urban-fantasy',
    name: '现代奇幻',
    icon: '✨',
    description: '现代都市 + 隐藏的超自然社会',
    category: '世界背景',
    worldBookOverlay: `[特殊设定·现代奇幻]
默认背景为现代都市，但存在隐藏的超自然社会：异能者、妖怪、秘社、猎人组织或地下交易所。
日常与异常并存；普通人大多不知情。冲突可围绕任务、契约、代价与身份保密展开。`,
    strongOverride: true,
    priority: 10,
  },
  {
    id: 'au-apocalypse',
    name: '末世生存',
    icon: '🏚️',
    description: '灾变后求生、据点与资源分配',
    category: '世界背景',
    worldBookOverlay: `[特殊设定·末世生存]
默认背景为灾变后的近未来：资源稀缺、据点管理、外出搜刮、感染/变异威胁与内部秩序。
人物仍是成年人复杂度；信任、牺牲与道德灰色地带是主要戏剧来源。`,
    strongOverride: true,
    priority: 10,
  },
  {
    id: 'au-infinite-flow',
    name: '无限流副本',
    icon: '🌀',
    description: '主神/系统空间 + 副本任务',
    category: '世界背景',
    worldBookOverlay: `[特殊设定·无限流]
默认背景存在「主神/系统/空间」机制：角色被投入副本任务，通关获得奖励与强化；副本之间可回到休整区。
保留人物性格与关系；副本内可临时切换场景，但回归后仍以本 AU 规则为准。`,
    strongOverride: true,
    priority: 10,
  },
];

export const AU_PRESET_MAP = Object.fromEntries(AU_PRESETS.map((p) => [p.id, p]));
