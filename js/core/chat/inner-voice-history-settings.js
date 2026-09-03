export const DEFAULT_INNER_VOICE_INJECT_COUNT = 5;
export const MIN_INNER_VOICE_INJECT_COUNT = 0;
export const MAX_INNER_VOICE_INJECT_COUNT = 8;

function clampInnerVoiceInjectCount(value) {
  return Math.max(
    MIN_INNER_VOICE_INJECT_COUNT,
    Math.min(MAX_INNER_VOICE_INJECT_COUNT, Math.round(value)),
  );
}

/**
 * 只有未设置或无效值才回落到新默认；旧会话显式保存的 0～8 不迁移。
 */
export function normalizeInnerVoiceInjectCount(
  value,
  fallback = DEFAULT_INNER_VOICE_INJECT_COUNT,
) {
  const parsedFallback = Number(fallback);
  const safeFallback = Number.isFinite(parsedFallback)
    ? clampInnerVoiceInjectCount(parsedFallback)
    : DEFAULT_INNER_VOICE_INJECT_COUNT;
  if (
    value === undefined
    || value === null
    || (typeof value === 'string' && !value.trim())
  ) return safeFallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampInnerVoiceInjectCount(parsed) : safeFallback;
}

export function resolveInnerVoiceInjectCount(prefs = {}) {
  if (prefs?.innerVoiceDisabled === true || prefs?.innerVoiceInjectEnabled === false) return 0;
  return normalizeInnerVoiceInjectCount(prefs?.innerVoiceInjectCount);
}
