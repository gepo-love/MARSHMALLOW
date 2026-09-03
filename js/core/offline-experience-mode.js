export const OFFLINE_EXPERIENCE_NORMAL = 'normal';
export const OFFLINE_EXPERIENCE_AUDIO = 'audio';

export function normalizeOfflineExperienceMode(value = '', { legacyAudio = false } = {}) {
  if (String(value || '').trim() === OFFLINE_EXPERIENCE_AUDIO || legacyAudio) {
    return OFFLINE_EXPERIENCE_AUDIO;
  }
  return OFFLINE_EXPERIENCE_NORMAL;
}

export function offlineExperienceModeOf(scene = {}) {
  return normalizeOfflineExperienceMode(scene?.experienceMode, {
    legacyAudio: !scene?.experienceMode && scene?.audioSceneEnabled === true,
  });
}

export function isOfflineAudioExperience(scene = {}) {
  return offlineExperienceModeOf(scene) === OFFLINE_EXPERIENCE_AUDIO;
}
