/**
 * 内置世界书种子 · 中性通用，无 IP / 赛季内容
 */

import { createWorldBookEntry } from '../models/worldbook.js';

export const DEFAULT_BOOK_ID = 'wb_book_default';

export const WORLD_BOOKS = [
  createWorldBookEntry({
    id: DEFAULT_BOOK_ID,
    kind: 'group',
    isBookRoot: true,
    name: '默认设定库',
    category: 'basics',
    position: 0,
    depth: 0,
    enabled: true,
  }),
  createWorldBookEntry({
    id: 'wb_grp_basics',
    kind: 'group',
    name: '基础规则',
    category: 'basics',
    bookId: DEFAULT_BOOK_ID,
    parentGroupId: DEFAULT_BOOK_ID,
    groupId: DEFAULT_BOOK_ID,
    position: 10,
    enabled: true,
  }),
  createWorldBookEntry({
    id: 'wb_tone_realistic',
    kind: 'item',
    name: '对话活人感',
    category: 'basics',
    bookId: DEFAULT_BOOK_ID,
    groupId: 'wb_grp_basics',
    constant: true,
    selective: false,
    priority: 'core',
    position: 20,
    content: `[对话基调]
- 像真人聊天：口语、短句、可省略，不要客服腔或作文腔；这里的“短句”指单条按自然气口断开，不代表整轮只说一两条，消息总量交给【回复节奏 · 错落】
- 先反应再补内容；允许停顿、改口和按真实表达欲连续追发
- 角色活在具体关系与生活里，不要 24 小时贴标签
- 不确定的事先问细节，不要审判对方的普通选择`,
  }),
  createWorldBookEntry({
    id: 'wb_selective_mood',
    kind: 'item',
    name: '情绪关键词触发',
    category: 'relationship',
    bookId: DEFAULT_BOOK_ID,
    groupId: 'wb_grp_basics',
    constant: false,
    selective: true,
    keys: ['生气', '难过', '吵架', '冷战', '道歉', '安慰'],
    position: 30,
    content: `[情绪场景]
- 冲突时保留人物性格：有人嘴硬、有人先沉默、有人会转移话题
- 安慰不要变成说教；道歉要带具体原因或行动，不要空泛「对不起」
- 和好后允许余波：语气变短、还在别扭、或故意找茬缓和`,
  }),
];

export function getWorldBooksByCategory(category) {
  return WORLD_BOOKS.filter((e) => e.category === category);
}
