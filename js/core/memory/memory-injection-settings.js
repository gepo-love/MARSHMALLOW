export const MEMORY_INJECTION_LIMIT_MAX = 100;
export const RELATED_MEMORY_CHAT_MAX = 12;

function limit(value, fallback, max = MEMORY_INJECTION_LIMIT_MAX) {
  const raw = Number(value);
  const picked = Number.isFinite(raw) ? raw : fallback;
  return Math.max(0, Math.min(max, Math.floor(picked)));
}

function retentionHours(value, fallback) {
  const raw = Number(value);
  const picked = Number.isFinite(raw) ? raw : fallback;
  return Math.max(1, Math.floor(picked));
}

export function normalizeMemoryInjectionSettings(prefs = {}) {
  const raw = prefs && typeof prefs === 'object' ? prefs : {};
  const legacyRelatedMemoryLimit = Number.isFinite(Number(raw.relatedWindowMemoryLimit))
    ? raw.relatedWindowMemoryLimit
    : null;
  const legacyRelatedRecentLimit = Number.isFinite(Number(raw.relatedWindowRecentMessageLimit))
    ? raw.relatedWindowRecentMessageLimit
    : null;
  return {
    allowAsCrossWindowSource: raw.allowAsCrossWindowMemorySource !== false,
    relatedMemoryEnabled: raw.relatedWindowMemoryEnabled !== false,
    vectorTokenSavingEnabled: raw.vectorTokenSavingEnabled === true,
    memoryDecayEnabled: raw.memoryDecayEnabled === true,
    memoryDecayCoreHours: retentionHours(raw.memoryDecayCoreHours, 48),
    memoryDecayGroupHours: retentionHours(raw.memoryDecayGroupHours, 24),
    memoryDecaySocialHours: retentionHours(raw.memoryDecaySocialHours, 24),
    memoryDecayAmbientHours: retentionHours(raw.memoryDecayAmbientHours, 24),
    currentMemoryLimit: limit(raw.currentWindowMemoryLimit, 28),
    characterMemoryLimit: limit(raw.characterMemoryLimit, 20),
    relatedChatLimit: limit(raw.relatedMemoryChatLimit, 6, RELATED_MEMORY_CHAT_MAX),
    relatedPrivateMemoryLimit: limit(raw.relatedPrivateMemoryLimit, legacyRelatedMemoryLimit ?? 16),
    relatedGroupMemoryLimit: limit(raw.relatedGroupMemoryLimit, legacyRelatedMemoryLimit ?? 20),
    relatedPrivateRecentMessageLimit: limit(raw.relatedPrivateRecentMessageLimit, legacyRelatedRecentLimit ?? 40, 120),
    relatedGroupRecentMessageLimit: limit(raw.relatedGroupRecentMessageLimit, legacyRelatedRecentLimit ?? 80, 120),
    memoryFactsLimit: limit(raw.memoryFactsLimit, 8, 30),
    eventTimelineLimit: limit(raw.eventTimelineLimit, 36, 80),
    offlineMemoryLimit: limit(raw.offlineMemoryLimit, 20),
    explicitSharedChatIds: [...new Set(
      (Array.isArray(raw.explicitSharedMemoryChatIds) ? raw.explicitSharedMemoryChatIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    )].slice(0, RELATED_MEMORY_CHAT_MAX),
  };
}

export function memoryInjectionSettingsPatch(settings = {}) {
  const value = normalizeMemoryInjectionSettings({
    allowAsCrossWindowMemorySource: settings.allowAsCrossWindowSource,
    relatedWindowMemoryEnabled: settings.relatedMemoryEnabled,
    vectorTokenSavingEnabled: settings.vectorTokenSavingEnabled,
    memoryDecayEnabled: settings.memoryDecayEnabled,
    memoryDecayCoreHours: settings.memoryDecayCoreHours,
    memoryDecayGroupHours: settings.memoryDecayGroupHours,
    memoryDecaySocialHours: settings.memoryDecaySocialHours,
    memoryDecayAmbientHours: settings.memoryDecayAmbientHours,
    currentWindowMemoryLimit: settings.currentMemoryLimit,
    characterMemoryLimit: settings.characterMemoryLimit,
    relatedMemoryChatLimit: settings.relatedChatLimit,
    relatedPrivateMemoryLimit: settings.relatedPrivateMemoryLimit,
    relatedGroupMemoryLimit: settings.relatedGroupMemoryLimit,
    relatedPrivateRecentMessageLimit: settings.relatedPrivateRecentMessageLimit,
    relatedGroupRecentMessageLimit: settings.relatedGroupRecentMessageLimit,
    memoryFactsLimit: settings.memoryFactsLimit,
    eventTimelineLimit: settings.eventTimelineLimit,
    offlineMemoryLimit: settings.offlineMemoryLimit,
    explicitSharedMemoryChatIds: settings.explicitSharedChatIds,
  });
  return {
    allowAsCrossWindowMemorySource: value.allowAsCrossWindowSource,
    relatedWindowMemoryEnabled: value.relatedMemoryEnabled,
    vectorTokenSavingEnabled: value.vectorTokenSavingEnabled,
    memoryDecayEnabled: value.memoryDecayEnabled,
    memoryDecayCoreHours: value.memoryDecayCoreHours,
    memoryDecayGroupHours: value.memoryDecayGroupHours,
    memoryDecaySocialHours: value.memoryDecaySocialHours,
    memoryDecayAmbientHours: value.memoryDecayAmbientHours,
    currentWindowMemoryLimit: value.currentMemoryLimit,
    characterMemoryLimit: value.characterMemoryLimit,
    relatedMemoryChatLimit: value.relatedChatLimit,
    relatedPrivateMemoryLimit: value.relatedPrivateMemoryLimit,
    relatedGroupMemoryLimit: value.relatedGroupMemoryLimit,
    relatedPrivateRecentMessageLimit: value.relatedPrivateRecentMessageLimit,
    relatedGroupRecentMessageLimit: value.relatedGroupRecentMessageLimit,
    memoryFactsLimit: value.memoryFactsLimit,
    eventTimelineLimit: value.eventTimelineLimit,
    offlineMemoryLimit: value.offlineMemoryLimit,
    explicitSharedMemoryChatIds: value.explicitSharedChatIds,
  };
}
