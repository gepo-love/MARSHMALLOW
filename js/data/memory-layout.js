/**
 * 记忆馆 · 便当格子布局与物件 SVG（扁平多色，对齐 home-layout 的设计语言）
 * 每个物件 = viewBox 0 0 100 100 的扁平 SVG，颜色取项目 token。
 */

const ICONS = {
  // 剧情长卷：信封与四角星 (暖黄)
  journal: '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M 15 25 Q 20 25 20 20 Q 20 25 25 25 Q 20 25 20 30 Q 20 25 15 25 Z" fill="#ffd166"/><path d="M 80 75 Q 83 75 83 72 Q 83 75 86 75 Q 83 75 83 78 Q 83 75 80 75 Z" fill="#ffd166"/><g transform="translate(65, 45) rotate(12) scale(1.1)"><rect x="-22" y="-16" width="44" height="32" rx="4" fill="#fef08a"/><path d="M -22 -16 L 0 4 L 22 -16" fill="#fde047" stroke="#fef08a" stroke-width="2" stroke-linejoin="round"/><circle cx="0" cy="4" r="4" fill="#ff9980"/></g><circle cx="30" cy="70" r="2.5" fill="#fde047"/><circle cx="70" cy="15" r="1.5" fill="#fde047"/></svg>',

  // 共同回忆：散落的蜜桃色爱心
  shared: '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M 20 35 A 7 7 0 0 1 34 35 A 7 7 0 0 1 48 35 Q 48 47 34 58 Q 20 47 20 35 Z" fill="#ffc2b3" transform="rotate(-15 34 46)"/><path d="M 75 25 A 4 4 0 0 1 83 25 A 4 4 0 0 1 91 25 Q 91 32 83 39 Q 75 32 75 25 Z" fill="#ff9980" transform="rotate(20 83 32)"/><path d="M 45 65 A 11 11 0 0 1 67 65 A 11 11 0 0 1 89 65 Q 89 83 67 100 Q 45 83 45 65 Z" fill="#ff7755" transform="rotate(-10 67 82)"/><circle cx="25" cy="75" r="2" fill="#ffc2b3"/><circle cx="60" cy="20" r="1.5" fill="#ff9980"/></svg>',

  // 收藏：书签与星光
  favorite: '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M30 18h40a6 6 0 0 1 6 6v62L50 70 24 86V24a6 6 0 0 1 6-6Z" fill="#f3c8d8"/><path d="m50 31 5 10 11 2-8 8 2 11-10-5-10 5 2-11-8-8 11-2Z" fill="#fff8ef"/><circle cx="80" cy="20" r="5" fill="#ffd166"/></svg>',

  // 过去碎片：弯月与星星 (柔蓝)
  fragments: '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M 55 45 A 22 22 0 1 0 85 75 A 26 26 0 1 1 55 45 Z" fill="#a7c8f2"/><path d="M 25 20 L 28 28 L 36 28 L 30 33 L 32 41 L 25 36 L 18 41 L 20 33 L 14 28 L 22 28 Z" fill="#8cb3e6" transform="rotate(15 25 30)"/><circle cx="75" cy="25" r="2.5" fill="#cce0ff"/><circle cx="30" cy="75" r="2" fill="#8cb3e6"/><circle cx="15" cy="55" r="1.5" fill="#cce0ff"/><path d="M 80 40 Q 82 40 82 38 Q 82 40 84 40 Q 82 40 82 42 Q 82 40 80 40 Z" fill="#a7c8f2"/></svg>',

  // 与你有关：小镜子 (蜜桃)
  aboutYou: '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><ellipse cx="50" cy="52" rx="28" ry="34" fill="#ffc2b3"/><ellipse cx="50" cy="52" rx="22" ry="27" fill="#fff5f0"/><circle cx="50" cy="48" r="8" fill="#ff9980" opacity="0.35"/><rect x="44" y="78" width="12" height="10" rx="4" fill="#e6ccb3"/></svg>',

  // TA 的偏好习惯：茶杯 (抹茶)
  characterTraits: '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M 28 42 Q 28 28 50 28 Q 72 28 72 42 L 70 68 Q 70 78 50 78 Q 30 78 30 68 Z" fill="#d9e8c4"/><path d="M 72 46 Q 86 46 86 56 Q 86 64 72 64" fill="none" stroke="#99cc66" stroke-width="4" stroke-linecap="round"/><ellipse cx="50" cy="42" rx="20" ry="6" fill="#eef6e6"/></svg>',

  // 匿名往事：半遮面具 (薰衣草紫)
  anonymous: '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M 22 40 Q 50 30 78 40 Q 80 58 64 70 Q 50 78 36 70 Q 20 58 22 40 Z" fill="#c9b8ec"/><ellipse cx="38" cy="50" rx="6" ry="4.5" fill="#fff5f0"/><ellipse cx="62" cy="50" rx="6" ry="4.5" fill="#fff5f0"/><circle cx="38" cy="50" r="2" fill="#7a5bc7"/><circle cx="62" cy="50" r="2" fill="#7a5bc7"/><path d="M 78 40 Q 90 36 94 28" fill="none" stroke="#b39ddb" stroke-width="3" stroke-linecap="round"/><circle cx="20" cy="28" r="2" fill="#d6c8f2"/><circle cx="84" cy="62" r="2.5" fill="#c9b8ec"/></svg>',

  // 线下约会：门与脚印 (蜜桃橘)
  offline: '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect x="30" y="22" width="40" height="56" rx="6" fill="#ffd9b3"/><rect x="36" y="28" width="28" height="44" rx="4" fill="#fff1e0"/><circle cx="58" cy="50" r="3" fill="#ff9980"/><ellipse cx="22" cy="80" rx="5" ry="7" fill="#ffb38a" transform="rotate(-12 22 80)"/><ellipse cx="34" cy="86" rx="5" ry="7" fill="#ff9980" transform="rotate(-12 34 86)"/><circle cx="80" cy="30" r="2.5" fill="#ffd9b3"/><circle cx="84" cy="70" r="2" fill="#ffb38a"/></svg>',

  // 感情事件：半片橙子与绿叶 (橘色)
  events: '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g transform="translate(70, 60) rotate(-20) scale(1.3)"><path d="M -20 0 A 20 20 0 0 0 20 0 Z" fill="#ff9933"/><path d="M -16 0 A 16 16 0 0 0 16 0 Z" fill="#ffcc80"/><path d="M -13 0 A 13 13 0 0 0 13 0 Z" fill="#ffaa00"/><g stroke="#ffcc80" stroke-width="2" stroke-linecap="round"><line x1="0" y1="0" x2="0" y2="13"/><line x1="0" y1="0" x2="-10" y2="8"/><line x1="0" y1="0" x2="10" y2="8"/></g></g><path d="M 35 35 C 25 35, 20 25, 30 20 C 40 20, 45 30, 35 35 Z" fill="#99cc66" transform="rotate(15 30 25)"/><circle cx="85" cy="25" r="2" fill="#ffcc80"/><circle cx="20" cy="75" r="2.5" fill="#ffaa00"/><circle cx="45" cy="70" r="1.5" fill="#ffcc80"/></svg>',

  // 角色档案：奶茶色小熊与圆点 (抹茶/奶茶)
  archive: '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g transform="translate(65, 60) scale(1.3)"><circle cx="-16" cy="-14" r="7" fill="#d9b38c"/><circle cx="16" cy="-14" r="7" fill="#d9b38c"/><rect x="-20" y="-12" width="40" height="28" rx="14" fill="#e6ccb3"/><ellipse cx="-11" cy="4" rx="3.5" ry="2" fill="#ff9980" opacity="0.5"/><ellipse cx="11" cy="4" rx="3.5" ry="2" fill="#ff9980" opacity="0.5"/><circle cx="-7" cy="-2" r="2" fill="#594033"/><circle cx="7" cy="-2" r="2" fill="#594033"/><path d="M -3 5 Q 0 8 3 5" stroke="#594033" stroke-width="1.5" fill="none" stroke-linecap="round"/></g><circle cx="25" cy="30" r="3" fill="#d9b38c"/><circle cx="80" cy="20" r="2" fill="#e6ccb3"/><circle cx="20" cy="70" r="2.5" fill="#e6ccb3"/><circle cx="45" cy="15" r="1.5" fill="#d9b38c"/></svg>',

  // 向量记忆：蓝黄小行星与碎星
  vector: '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g transform="translate(65, 55) rotate(-18) scale(1.15)"><ellipse cx="0" cy="0" rx="26" ry="7" fill="none" stroke="#ffd166" stroke-width="3.5"/><circle cx="0" cy="0" r="14" fill="#7eb8f0"/><path d="M -26 0 A 26 7 0 0 0 26 0" fill="none" stroke="#a7c8f2" stroke-width="3.5" stroke-linecap="round"/><path d="M -11 -4 Q 0 -8 11 -4" stroke="#fff8cc" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.7"/><path d="M -12 5 Q 0 9 12 5" stroke="#fff8cc" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.7"/></g><path d="M 22 22 L 24 27 L 29 27 L 25 30 L 27 35 L 22 32 L 17 35 L 19 30 L 15 27 L 20 27 Z" fill="#ffd166" transform="rotate(12 22 28)"/><path d="M 78 18 L 79 21 L 82 21 L 80 23 L 81 26 L 78 24 L 75 26 L 76 23 L 74 21 L 77 21 Z" fill="#7eb8f0" transform="rotate(-8 78 22)"/><circle cx="28" cy="72" r="2" fill="#a7c8f2"/><circle cx="82" cy="68" r="1.5" fill="#ffd166"/><circle cx="18" cy="48" r="1.2" fill="#ffd166"/><circle cx="48" cy="82" r="1.8" fill="#7eb8f0"/><path d="M 38 18 Q 40 18 40 16 Q 40 18 42 18 Q 40 18 40 20 Q 40 18 38 18 Z" fill="#ffd166"/><path d="M 88 42 Q 90 42 90 40 Q 90 42 92 42 Q 90 42 90 44 Q 90 42 88 42 Z" fill="#a7c8f2"/></svg>',
};

/**
 * 区块定义。area 对应 css grid-template-areas；tint 是冰格拼色底；size: wide(宽格主菜) / square(方格)。
 */
export const MEMORY_REGIONS = [
  {
    id: 'journal',
    name: '剧情长卷',
    hint: '一页页翻看你们聊过的故事',
    icon: 'journal',
    area: 'journal',
    tint: 'tint-yellow',
    size: 'wide',
    kind: 'summary',
  },
  {
    id: 'shared',
    name: '共同回忆',
    hint: '一起经历、彼此记得的事',
    icon: 'shared',
    area: 'flower',
    tint: 'tint-peach',
    size: 'square',
    kind: 'memory',
  },
  {
    id: 'favorites',
    name: '收藏',
    hint: '喜欢的对白与线下片段',
    icon: 'favorite',
    area: 'favorites',
    tint: 'tint-lavender',
    size: 'wide',
    kind: 'favorite',
    scope: 'character',
  },
  {
    id: 'fragments',
    name: '过去碎片',
    hint: '时光机里收下来的过往',
    icon: 'fragments',
    area: 'candy',
    tint: 'tint-blue',
    size: 'square',
    kind: 'fragment',
  },
  {
    id: 'events',
    name: '感情事件',
    hint: '心动、争执、未解开的结',
    icon: 'events',
    area: 'rings',
    tint: 'tint-orange',
    size: 'square',
    kind: 'event',
  },
  {
    id: 'archive',
    name: '与你有关',
    hint: '你在 TA 眼中的样子',
    icon: 'aboutYou',
    area: 'id',
    tint: 'tint-peach',
    size: 'square',
    kind: 'aboutYou',
  },
  {
    id: 'characterTraits',
    name: 'TA 的偏好习惯',
    hint: 'TA 自己的状态与习惯',
    icon: 'characterTraits',
    area: 'habits',
    tint: 'tint-cream',
    size: 'square',
    kind: 'characterTrait',
  },
  {
    id: 'anonymous',
    name: '匿名往事',
    hint: '匿名身份下发生的事',
    icon: 'anonymous',
    area: 'anon',
    tint: 'tint-lavender',
    size: 'square',
    kind: 'anonymous',
  },
  {
    id: 'offline',
    name: '线下约会',
    hint: '每一次线下相处的小档案',
    icon: 'offline',
    area: 'offline',
    tint: 'tint-peach',
    size: 'square',
    kind: 'offlineArchive',
    scope: 'character',
  },
  {
    id: 'vector',
    name: '向量记忆',
    hint: '语义搜索与索引状态',
    icon: 'vector',
    area: 'jar',
    tint: 'tint-sky',
    size: 'wide',
    kind: 'vector',
  },
];

export function getMemoryIconSvg(name) {
  return ICONS[name] || ICONS.journal;
}

export function getMemoryRegion(id) {
  return MEMORY_REGIONS.find((r) => r.id === String(id || '').trim()) || null;
}
