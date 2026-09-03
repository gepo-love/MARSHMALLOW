import { clampWordRange } from './narration-settings.js';
import { normalizePersonForPerspective } from './narration-perspective.js';
import {
  OFFLINE_EXPERIENCE_AUDIO,
  normalizeOfflineExperienceMode,
} from './offline-experience-mode.js';
import {
  OFFLINE_SCENE_STYLES,
  DEFAULT_OFFLINE_SCENE_STYLE_ID,
  normalizeOfflineSceneImageGenMode,
} from './offline-scene-image-config.js';

export const OFFLINE_PERSPECTIVES = ['user', 'character', 'omniscient'];
export const OFFLINE_PERSONS = ['second', 'first', 'third'];
export const OFFLINE_ACTIVITY_KINDS = ['stay', 'outing', 'trip'];

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeWorldBookIds(partial = {}) {
  const raw = Array.isArray(partial.worldBookIds)
    ? partial.worldBookIds
    : (partial.worldBookId ? [partial.worldBookId] : []);
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

function normalizePresetStyleIds(partial = {}) {
  const raw = Array.isArray(partial.presetStyleIds)
    ? partial.presetStyleIds
    : (partial.presetStyleId ? [partial.presetStyleId] : []);
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

/** 纯数据归一化；保持建场页不必提前加载完整线下生成引擎。 */
export function createSceneDraft(partial = {}) {
  const { wordMin, wordMax } = clampWordRange(partial, 200, 500);
  const experienceMode = normalizeOfflineExperienceMode(partial.experienceMode, {
    legacyAudio: !partial.experienceMode && partial.audioSceneEnabled === true,
  });
  const audioSceneEnabled = experienceMode === OFFLINE_EXPERIENCE_AUDIO;
  const innerVoicePreferenceTouched = partial.innerVoicePreferenceTouched === true;
  const perspective = audioSceneEnabled
    ? 'user'
    : (OFFLINE_PERSPECTIVES.includes(partial.perspective) ? partial.perspective : 'user');
  const person = normalizePersonForPerspective(
    perspective,
    audioSceneEnabled
      ? 'second'
      : (OFFLINE_PERSONS.includes(partial.person) ? partial.person : 'second'),
  );
  return {
    place: String(partial.place || '').trim(),
    weather: String(partial.weather || '').trim(),
    companions: String(partial.companions || '').trim(),
    goal: String(partial.goal || '').trim(),
    tone: String(partial.tone || '').trim() || '日常推进',
    openingLine: String(partial.openingLine || '').trim(),
    experienceMode,
    perspective,
    person,
    wordMin,
    wordMax,
    rounds: clampNum(partial.rounds, 1, 500, 6),
    optionCards: audioSceneEnabled || partial.optionCards === true,
    innerVoiceEnabled: !audioSceneEnabled && (!innerVoicePreferenceTouched || partial.innerVoiceEnabled !== false),
    innerVoicePreferenceTouched,
    innerVoiceDefaultVersion: 1,
    naturalEnsemble: !audioSceneEnabled && partial.naturalEnsemble === true,
    retainRerollVersions: partial.retainRerollVersions === true,
    dialogueMode: audioSceneEnabled || partial.dialogueMode === true,
    noParaphrase: audioSceneEnabled || partial.noParaphrase !== false,
    directorMode: partial.directorMode === true,
    blockUserSpeech: audioSceneEnabled || partial.blockUserSpeech !== false,
    audioSceneEnabled,
    audioSceneLayout: partial.audioSceneLayout === 'landscape' ? 'landscape' : 'portrait',
    audioStageSoundEnabled: partial.audioStageSoundEnabled !== false,
    audioStageActionVolume: clampNum(partial.audioStageActionVolume, 0, 100, 58),
    audioStageBackgroundVolume: clampNum(partial.audioStageBackgroundVolume, 0, 100, 20),
    audioSceneBackground: String(partial.audioSceneBackground || '').trim(),
    audioSceneBackgroundName: String(partial.audioSceneBackgroundName || '').trim().slice(0, 100),
    audioSceneBackgroundUpdatedAt: Math.max(0, Number(partial.audioSceneBackgroundUpdatedAt || 0) || 0),
    phoneMessagesEnabled: partial.phoneMessagesEnabled !== false,
    imageGenMode: normalizeOfflineSceneImageGenMode(partial.imageGenMode),
    imageStyleId: OFFLINE_SCENE_STYLES[partial.imageStyleId] ? partial.imageStyleId : DEFAULT_OFFLINE_SCENE_STYLE_ID,
    autoImagePerBeat: partial.autoImagePerBeat === true,
    imagePromptTemplate: String(partial.imagePromptTemplate || '').trim(),
    placeKeywords: String(partial.placeKeywords || '').trim(),
    placeMaterial: String(partial.placeMaterial || '').trim(),
    ttsEnabled: audioSceneEnabled ? partial.ttsEnabled !== false : partial.ttsEnabled === true,
    contextDepth: clampNum(partial.contextDepth, 2, 60, 12),
    autoSummaryEvery: clampNum(partial.autoSummaryEvery, 0, 100, 6),
    perBeatDigestEnabled: partial.perBeatDigestEnabled === true,
    worldBookIds: normalizeWorldBookIds(partial),
    presetStyleIds: normalizePresetStyleIds(partial),
    guidancePrompt: String(partial.guidancePrompt || '').trim(),
    activityKind: OFFLINE_ACTIVITY_KINDS.includes(partial.activityKind) ? partial.activityKind : 'stay',
    durationDays: clampNum(partial.durationDays, 1, 7, 3),
    dayIndex: clampNum(partial.dayIndex, 0, 400, 0),
    itinerary: (partial.itinerary && typeof partial.itinerary === 'object' && Array.isArray(partial.itinerary.days))
      ? partial.itinerary
      : null,
  };
}
