/** 匿名主播 · 人气档位与直播类型预设 */

export const STREAMER_POPULARITY_TIERS = [
  {
    id: 'small',
    label: '小主播',
    hint: '在线个位数，熟人感强，弹幕稀疏',
    danmakuRange: [4, 7],
    fanGroupMemberRange: [80, 300],
    fanGroupCrowdRange: [2, 4],
  },
  {
    id: 'mid',
    label: '中腰部',
    hint: '有固定粉丝，弹幕有来有回',
    danmakuRange: [7, 11],
    fanGroupMemberRange: [300, 1200],
    fanGroupCrowdRange: [3, 6],
  },
  {
    id: 'big',
    label: '大主播',
    hint: '在线人多，弹幕密集嘈杂，路人粉丝黑粉混杂',
    danmakuRange: [12, 18],
    fanGroupMemberRange: [1200, 5000],
    fanGroupCrowdRange: [5, 9],
  },
];

export function getStreamerPopularityTierById(id) {
  const raw = String(id || '').trim();
  return STREAMER_POPULARITY_TIERS.find((t) => t.id === raw) || STREAMER_POPULARITY_TIERS[0];
}

export const STREAMER_CATEGORY_PRESETS = [
  { id: 'chat', label: '聊天唠嗑' },
  { id: 'sing', label: '唱歌电台' },
  { id: 'asmr', label: '助眠 ASMR' },
  { id: 'game', label: '游戏陪玩' },
  { id: 'study', label: '学习自习室' },
  { id: 'late_night', label: '深夜档' },
  { id: 'custom', label: '自定义' },
];

export function getStreamerCategoryById(id) {
  const raw = String(id || '').trim();
  return STREAMER_CATEGORY_PRESETS.find((c) => c.id === raw) || STREAMER_CATEGORY_PRESETS[0];
}

/** 换画面频率档位：off 也会在开播时定一次画面，之后不再变；其余数值是每轮实际触发生图的概率 */
export const STREAMER_IMAGE_SYNC_TIERS = [
  { id: 'off', label: '固定画面', hint: '开播定一次画面后就不再变，最省生图额度', chance: 0 },
  { id: 'low', label: '偶尔切换', hint: '每轮约 22% 概率换一次姿势/画面', chance: 0.22 },
  { id: 'mid', label: '常换画面', hint: '每轮约 48% 概率跟着台词切画面', chance: 0.48 },
  { id: 'high', label: '几乎每轮', hint: '每轮约 78% 概率换画面，最费生图额度', chance: 0.78 },
];

export function getStreamerImageSyncTierById(id) {
  const raw = String(id || '').trim();
  return STREAMER_IMAGE_SYNC_TIERS.find((t) => t.id === raw) || STREAMER_IMAGE_SYNC_TIERS[0];
}

/** 挂机模式下自动推进一轮的间隔：用户可自选具体秒数/分钟数，不选则按人气档位给默认值 */
export const STREAMER_IDLE_INTERVAL_TIERS = [
  { id: 'fast', label: '30秒一次', ms: 30000 },
  { id: 'normal', label: '1分钟一次', ms: 60000 },
  { id: 'slow', label: '2分钟一次', ms: 120000 },
  { id: 'slower', label: '5分钟一次', ms: 300000 },
];

export function getStreamerIdleIntervalTierById(id) {
  const raw = String(id || '').trim();
  return STREAMER_IDLE_INTERVAL_TIERS.find((t) => t.id === raw) || null;
}
