export function createMemory(overrides = {}) {
  const now = Date.now();
  return {
    id: overrides.id || `mem_${now}_${Math.random().toString(36).slice(2, 6)}`,
    chatId: String(overrides.chatId || ''),
    characterId: String(overrides.characterId || ''),
    userId: String(overrides.userId || ''),
    type: String(overrides.type || 'event'),
    category: String(overrides.category || 'general'),
    content: String(overrides.content || ''),
    importance: String(overrides.importance || 'normal'),
    timestamp: Number(overrides.timestamp || now) || now,
    source: String(overrides.source || 'manual'),
  };
}

export const MEMORY_TYPES = {
  event: '事件',
  relationship: '关系变化',
  preference: '喜好/习惯',
  secret: '秘密',
  promise: '约定',
  summary: '摘要',
  guidance: '扮演指导',
};
