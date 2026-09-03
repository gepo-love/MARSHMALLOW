/**
 * Chat 提示词分层注册表（棉花糖机 · 去荣耀化）
 * 从旧项目迁 context 时只启用此处 listed 的层；GLORY_EXCLUDED 永不出现在商业版。
 */

/** 禁止迁入商业版的层 / hooks（含荣耀、赛季、战队、竞技场等） */
export const GLORY_EXCLUDED_LAYER_IDS = [
  'gloryHoliday',
  'seasonWorldBook',
  'teamRoster',
  'debutSeason',
  'arena',
  'scheduleHubSeason',
  'characterTimelineStates',
  'accountCard',
  'gloryMapAnchors',
  'competitionArc',
  'legacyRpImport',
];

/** V1 计划启用的层（骨架阶段仅注册，逐步 implement） */
export const CHAT_CONTEXT_LAYERS = [
  { id: 'worldbook', label: '设定库', defaultOn: true, phase: 2, gating: 'selective' },
  { id: 'characterCards', label: '角色卡', defaultOn: true, phase: 3, gating: 'constant' },
  { id: 'userCard', label: '用户卡', defaultOn: true, phase: 3, gating: 'constant' },
  { id: 'chatDirectives', label: '会话描述/剧情', defaultOn: true, phase: 3, gating: 'constant' },
  { id: 'memories', label: '记忆摘要', defaultOn: true, phase: 3, gating: 'selective' },
  { id: 'memoryFacts', label: '结构化事实', defaultOn: true, phase: 3, gating: 'selective' },
  { id: 'timePrompt', label: '时间提示', defaultOn: true, phase: 3, gating: 'constant' },
  { id: 'presetFragments', label: '预设片段', defaultOn: true, phase: 2, gating: 'constant' },
  { id: 'recentMessages', label: '最近消息', defaultOn: false, phase: 3 },
  { id: 'socialLinkage', label: '跨窗联动', defaultOn: false, phase: 4 },
  { id: 'eventSlot', label: '灵感事件', defaultOn: false, phase: 4 },
];

export const CHAT_CONTEXT_DEPTH_DEFAULT = 100;
export const CHAT_CONTEXT_DEPTH_MIN = 4;
export const CHAT_CONTEXT_DEPTH_MAX = 500;

export function normalizeChatContextDepth(value, fallback = CHAT_CONTEXT_DEPTH_DEFAULT) {
  const raw = Number(value);
  const fb = Number(fallback);
  const picked = Number.isFinite(raw) && raw > 0
    ? raw
    : (Number.isFinite(fb) && fb > 0 ? fb : CHAT_CONTEXT_DEPTH_DEFAULT);
  return Math.max(CHAT_CONTEXT_DEPTH_MIN, Math.min(CHAT_CONTEXT_DEPTH_MAX, Math.floor(picked)));
}

export function isLayerAllowed(layerId) {
  const id = String(layerId || '').trim();
  if (!id) return false;
  if (GLORY_EXCLUDED_LAYER_IDS.includes(id)) return false;
  return CHAT_CONTEXT_LAYERS.some((layer) => layer.id === id);
}

export function getDefaultEnabledLayers() {
  return CHAT_CONTEXT_LAYERS.filter((layer) => layer.defaultOn).map((layer) => layer.id);
}

export function filterEnabledLayers(requested = []) {
  const allowed = new Set(CHAT_CONTEXT_LAYERS.map((layer) => layer.id));
  return (Array.isArray(requested) ? requested : [])
    .map((id) => String(id || '').trim())
    .filter((id) => allowed.has(id) && isLayerAllowed(id));
}
