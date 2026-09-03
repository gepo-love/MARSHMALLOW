/** 通讯录字段说明：哪些会进 AI、可留空、可 AI 补全 */

export const CHARACTER_SECTIONS = [
  {
    id: 'profile',
    title: '资料',
    subtitle: '名字 · 人物设定',
    aiInject: true,
    hint: '用户可直接粘贴整段人物设定；结构化字段只做补充。',
  },
  {
    id: 'style',
    title: '口吻与语料',
    subtitle: '性格 · 节奏 · 情境反应',
    aiInject: true,
    hint: '稳定规则写进说话风格；原话、节奏与情境反应写进语料库。',
  },
  {
    id: 'life',
    title: '生活圈',
    subtitle: '城市 · 日常 · 零碎资料',
    aiInject: 'life',
    hint: '地图、天气和日常线索放在后面，默认可不填。',
  },
  {
    id: 'relations',
    title: '关系网',
    subtitle: '与其他角色的关系',
    aiInject: 'social',
    hint: '私聊主链路不一定注入；论坛/群聊/社交生成会用到。可只写关键词。',
  },
  {
    id: 'voice',
    title: '语音',
    subtitle: 'MiniMax 声线',
    aiInject: false,
    hint: '供语音消息与通话 TTS 使用。',
  },
];

export const MAP_CITY_FIELDS = [
  {
    key: 'city',
    label: '故事城市',
    placeholder: '可虚拟，也可写真实城市',
    ai: '进 AI 角色卡 · 故事城市',
  },
  {
    key: 'realCityMap',
    label: '现实城市',
    placeholder: '如：上海、杭州、成都',
    ai: '用于天气 / 地图 / 路线',
  },
  {
    key: 'weatherHint',
    label: '天气描述',
    placeholder: '可留空；检测或聊天时自动读取',
    ai: '展示缓存；聊天优先读实时天气',
  },
];

export const SOUL_FIELDS = [
  {
    key: 'personality',
    label: '性格底色',
    rows: 4,
    placeholder: '底色、反差、弱点、行动逻辑… 写个大概就行',
    ai: '注入角色卡 personality',
  },
  {
    key: 'speechStyle',
    label: '说话风格',
    rows: 3,
    placeholder: '语速、用词、常见反应、禁忌…',
    ai: '注入角色卡 speechStyle',
  },
  {
    key: 'commonEmotes',
    label: '常用 Emoji / 颜文字',
    rows: 2,
    placeholder: '如：🥺 / 🤏 / (｡>﹏<｡) / _(:з」∠)_；按角色口吻填，别太多',
    ai: '注入角色卡 commonEmotes',
  },
  {
    key: 'appearancePrompt',
    label: '生图外观描述',
    rows: 3,
    placeholder: '外貌、发型、穿搭、气质，或角色专用生图提示词',
    ai: '生图与头像参考 appearancePrompt',
  },
  {
    key: 'speechCorpus',
    label: '语料库',
    rows: 6,
    placeholder: '示例句、口头禅、情绪触发时的反应、绝对不会说的话…',
    ai: '注入角色卡 speechCorpus（最「活」的一块）',
  },
];

export const LIFE_FIELDS = [
  { key: 'homeDetails', label: '居家细节', rows: 2, placeholder: '房间、宠物、常待的角落…' },
  { key: 'familyThreads', label: '家庭线索', rows: 2, placeholder: '家人、节日、未说出口的事…' },
  { key: 'socialAnchors', label: '社交锚点', rows: 2, placeholder: '常去的店、固定饭局、小圈子…' },
  { key: 'habits', label: '习惯与小癖', rows: 2, placeholder: '熬夜、收集、口头禅外的动作…' },
  { key: 'activitySeeds', label: '活动种子', rows: 2, placeholder: '可聊的活动，逗号或短句分隔' },
];

export const MAP_FIELDS = [
  { key: 'area', label: '活动片区', placeholder: '如：老城区、大学城、河边' },
  { key: 'label', label: '住址标签', placeholder: '如：合租公寓、工作室附近' },
  { key: 'mapQuery', label: '真实地点/地标', placeholder: '商圈、学校、车站、常去店铺等' },
  { key: 'note', label: '地图备注', rows: 2, placeholder: '出没半径、通勤偏好、常出现的路口…' },
];
