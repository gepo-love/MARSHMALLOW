export const PROMPT_PROFILES = Object.freeze({
  FULL: 'full',
  LIGHTWEIGHT: 'lightweight',
  V2: 'v2',
});

export function normalizePromptProfile(value = '') {
  const profile = String(value || '').trim().toLowerCase();
  if (profile === PROMPT_PROFILES.FULL || profile === PROMPT_PROFILES.LIGHTWEIGHT || profile === PROMPT_PROFILES.V2) {
    return profile;
  }
  return '';
}

/**
 * preview.19 起试玩默认使用 V2。preview.18 以前只保存布尔开关：
 * false 代表用户明确切回全量；true 或缺省属于旧试玩默认，迁移到 V2。
 */
export function resolvePromptProfile(prefs = {}, { offline = false } = {}) {
  if (offline) return PROMPT_PROFILES.FULL;
  const explicit = normalizePromptProfile(prefs?.promptProfile);
  if (explicit) return explicit;
  if (prefs?.lightweightPromptEnabled === false) return PROMPT_PROFILES.FULL;
  return PROMPT_PROFILES.V2;
}

export function promptProfilePrefsPatch(profile = PROMPT_PROFILES.V2) {
  const normalized = normalizePromptProfile(profile) || PROMPT_PROFILES.V2;
  return {
    promptProfile: normalized,
    // 保留旧字段，方便旧版本读取同一份备份。
    lightweightPromptEnabled: normalized !== PROMPT_PROFILES.FULL,
  };
}
