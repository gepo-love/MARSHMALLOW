export const EVENT_VISIBILITY = {
  public: 'public',
  private: 'private',
  spreading: 'spreading',
};

// 与 memoryFacts 共用同一套统一时间状态语义（见 docs/temporal-memory-plan.md）。
// eventMemories 不需要 planned/evergreen：一条事件记忆本身就是"已经发生的事"，
// 唯一要区分的是它有没有留下还没收的尾巴（pendingThreads）。
export const EVENT_TEMPORAL_STATES = {
  ongoing: 'ongoing',
  completed: 'completed',
};

/**
 * 小剧场的 followupHook 语义是“事件结束后可聊的余波”，不是剧情仍未发生。
 * 旧版本曾把它写进 pendingThreads，导致吃饭、通话等已完成流程被反复重演。
 */
export function isCompletedStoryCardEvent(event = {}) {
  const tags = Array.isArray(event?.tags) ? event.tags.map((tag) => String(tag || '').trim()) : [];
  return tags.includes('storyCard');
}

export function effectiveEventPendingThreads(event = {}) {
  if (isCompletedStoryCardEvent(event)) return [];
  return Array.isArray(event?.pendingThreads) ? event.pendingThreads.filter(Boolean).slice(0, 12) : [];
}

export function effectiveEventTemporalState(event = {}) {
  if (isCompletedStoryCardEvent(event)) return EVENT_TEMPORAL_STATES.completed;
  const requested = String(event?.temporalState || '').trim();
  if (requested === EVENT_TEMPORAL_STATES.ongoing || requested === EVENT_TEMPORAL_STATES.completed) {
    return requested;
  }
  return effectiveEventPendingThreads(event).length
    ? EVENT_TEMPORAL_STATES.ongoing
    : EVENT_TEMPORAL_STATES.completed;
}

export function createEventMemory(payload = {}) {
  const now = Date.now();
  const id = String(payload.id || '').trim() || `evm_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const userId = String(payload.userId || '').trim();
  const embRaw = Number(payload.embarrassmentLevel || 0) || 0;
  const emb = embRaw > 0 && embRaw <= 5
    ? Math.round((embRaw / 5) * 100)
    : Math.max(0, Math.min(100, embRaw));
  const pendingThreads = effectiveEventPendingThreads(payload);
  const requestedState = String(payload.temporalState || '').trim();
  const temporalState = isCompletedStoryCardEvent(payload)
    ? EVENT_TEMPORAL_STATES.completed
    : (requestedState === 'ongoing' || requestedState === 'completed'
      ? requestedState
      : (pendingThreads.length ? 'ongoing' : 'completed'));
  return {
    id,
    userId,
    sourceMessageId: String(payload.sourceMessageId || '').trim(),
    summary: String(payload.summary || '').trim().slice(0, 520),
    timestamp: Number(payload.timestamp || now) || now,
    knownBy: (payload.knownBy && typeof payload.knownBy === 'object') ? payload.knownBy : {},
    involvedChats: Array.isArray(payload.involvedChats) ? payload.involvedChats.filter(Boolean).slice(0, 20) : [],
    relationChanges: Array.isArray(payload.relationChanges) ? payload.relationChanges.slice(0, 20) : [],
    pendingThreads,
    highlight: String(payload.highlight || '').trim().slice(0, 240),
    tags: Array.isArray(payload.tags) ? payload.tags.filter(Boolean).slice(0, 16) : [],
    embarrassmentLevel: emb,
    visibility: String(payload.visibility || 'private') === 'public'
      ? 'public'
      : String(payload.visibility || 'private') === 'spreading'
        ? 'spreading'
        : 'private',
    temporalState,
    createdAt: Number(payload.createdAt || now) || now,
    updatedAt: Number(payload.updatedAt || now) || now,
  };
}
