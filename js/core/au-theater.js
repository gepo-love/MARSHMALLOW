/**
 * 番外剧场（相遇模块 · 异世界/AU 子模式）
 *
 * 性质：套 AU overlay 的多轮沉浸叙事，**硬隔离**——产物只存独立 `auStories`，
 * 绝不写 memories / eventMemories / sharedEventKnowledge 主线，避免污染「角色真实记得的事」。
 * 唯一出口是用户手动分享：把一段番外作为脑洞分别推进到参与角色的私聊（一次性、用户控制）。
 */

import { chat as apiChat, chatForTask, resolveChatPreferStream } from './api.js';
import { resolveSceneApiConfig } from './api-presets.js';
import { getRecord, putRecord, deleteRecord, getAllByIndex } from './db.js';
import { getCharacterAiContextName, normalizeTranslationProfile } from '../models/character.js';
import { getUserDisplayName } from '../models/user.js';
import { AU_PRESETS } from '../data/au-presets.js';
import { ensurePrivateChat, findPrivateChat, saveMessage, updateChatPreview } from './chat-store.js';
import { loadOfflineStylePrefs, resolveOfflineInnerVoiceCard } from './offline-appearance.js';
import { createMessage } from '../models/chat.js';
import { nextChatMessageTimestamp } from './virtual-time-shim.js';
import { buildPresetFragmentContext } from './preset-store.js';
import {
  buildWorldBookContextBundle,
  normalizeWorldBookIds,
} from './world-book-store.js';
import { buildFrontSystemPromptBlock } from './front-system-prompt.js';
import {
  buildOfflineCurrentDirectiveTail,
  createSceneDraft,
  detectOfflineStaleDirectiveReplay,
  joinOfflineContinuationText,
} from './offline-session.js';
import {
  loadLastOfflineScenePresetFields,
  pickOfflineScenePresetFields,
} from './offline-scene-presets.js';
import {
  buildOfflineScenePrompt,
  extractSceneImageDirective,
  maybeGenerateOfflineSceneImage,
  sceneImageDirectiveInstruction,
  SCENE_IMAGE_DIRECTIVE_START,
} from './offline-scene-image.js';
import {
  extractOfflineCharacterStates,
  latestOfflineCharacterStates,
  offlineCharacterStatesInstruction,
  OFFLINE_CHARACTER_STATES_START,
} from './offline-character-states.js';
import {
  buildVoiceSpeechProfileOverride,
  loadVoiceToolConfig,
  resolveVoiceToolConfigForProfile,
  synthesizeVoice,
} from './voice-tools.js';
import {
  buildNarrativeVoiceLinesInstruction,
  extractNarrativeVoiceLines,
  NARRATIVE_VOICE_LINES_START,
} from './narrative-voice-lines.js';
import { VOICE_WORLD_BOOK_SURFACES } from './voice-worldbook.js';
import {
  VARIED_SEGMENTATION_HINT,
  clampWordRange,
  resolveNarrationMaxTokens,
  wordRangeDirective,
} from './narration-settings.js';
import { archiveNarration } from './narration-archive.js';
import { chatWithEmptyFallback, buildNarrativeModeDirectivesBlock } from './narration-compat.js';
import {
  acquireNarrationGenerationLease,
  narrationGenerationInFlightError,
} from './narration-generation-lease.js';
import { loadChatPrefs } from './chat-block-state.js';
import {
  OPTIONS_END,
  OPTIONS_START,
  advanceOptionsInstruction,
  extractAdvanceOptions,
  stripOptionsTail,
} from './advance-options.js';
import { sanitizeNarrationOutput } from './narration-sanitize.js';
import { stripThinkingBlocks } from './marshmallow-protocol.js';
import { stripTranslationMarks } from './narration-translation.js';
import { applyPermanentRegex, applyPromptRegex, primeRegex } from './display-regex.js';
import {
  normalizePerspective,
  normalizePerson,
  normalizePersonForPerspective,
  personContinuityText,
  perspectiveText,
  personText,
} from './narration-perspective.js';

export function listAuPresets() {
  return AU_PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    icon: p.icon || '🌌',
    description: p.description || '',
    overlay: p.worldBookOverlay || '',
    strongOverride: p.strongOverride === true,
  }));
}

export function getAuPreset(id) {
  return listAuPresets().find((p) => p.id === String(id || '').trim()) || null;
}

function genId(prefix = 'au') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function listAuStories(userId) {
  const rows = await getAllByIndex('auStories', 'userId', String(userId || '').trim());
  return (rows || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getAuStory(id, userId = '') {
  const row = await getRecord('auStories', id);
  const owner = String(userId || '').trim();
  if (row && owner && String(row.userId || '').trim() !== owner) return null;
  return row;
}

function uniqueIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
}

function cloneAuValue(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function auVersionStore(session = {}) {
  if (!session.rerollVersions || typeof session.rerollVersions !== 'object' || Array.isArray(session.rerollVersions)) {
    session.rerollVersions = {};
  }
  return session.rerollVersions;
}

function recordAuRerollVersion(session = {}, beat = null, checkpoints = [], label = '') {
  if (!beat?.id || beat.role !== 'narration') return null;
  const store = auVersionStore(session);
  const beatId = String(beat.id);
  const current = store[beatId] && typeof store[beatId] === 'object' ? store[beatId] : {};
  const versions = Array.isArray(current.versions) ? current.versions.slice() : [];
  const entry = {
    id: genId('auver'),
    label: String(label || `版本 ${versions.length + 1}`).trim().slice(0, 40),
    createdAt: Date.now(),
    beat: cloneAuValue(beat, {}),
    checkpointSummaries: cloneAuValue(checkpoints, []),
  };
  versions.push(entry);
  store[beatId] = {
    beatId,
    activeVersionId: entry.id,
    versions: versions.slice(-5),
    updatedAt: Date.now(),
  };
  return entry;
}

function syncActiveAuRerollVersion(session = {}, beat = null) {
  const set = auVersionStore(session)[String(beat?.id || '')];
  if (!set || !beat) return;
  const active = (set.versions || []).find((row) => row?.id === set.activeVersionId);
  if (!active) return;
  active.beat = cloneAuValue(beat, {});
  active.checkpointSummaries = cloneAuValue(session.checkpointSummaries || [], []);
  set.updatedAt = Date.now();
}

export function listAuRerollVersions(session = {}, beatId = '') {
  const set = auVersionStore(session)[String(beatId || '')];
  return set ? cloneAuValue(set, { beatId, activeVersionId: '', versions: [] }) : {
    beatId: String(beatId || ''),
    activeVersionId: '',
    versions: [],
  };
}

export function selectAuRerollVersion(session = {}, beatId = '', versionId = '') {
  const beats = Array.isArray(session?.beats) ? session.beats : [];
  const index = beats.length - 1;
  const current = beats[index];
  if (!current || current.role !== 'narration' || String(current.id) !== String(beatId)) {
    return { ok: false, reason: 'not_last_narration' };
  }
  const set = auVersionStore(session)[String(beatId)];
  const version = (set?.versions || []).find((row) => row?.id === String(versionId || ''));
  if (!version?.beat) return { ok: false, reason: 'version_not_found' };
  beats.splice(index, 1, cloneAuValue(version.beat, current));
  session.checkpointSummaries = cloneAuValue(version.checkpointSummaries || [], []);
  set.activeVersionId = version.id;
  set.updatedAt = Date.now();
  return { ok: true, beat: beats[index], version: cloneAuValue(version, {}) };
}

export function restoreAuRevision(session = {}, revisionId = '') {
  const beats = Array.isArray(session?.beats) ? session.beats : [];
  const current = beats[beats.length - 1];
  const revision = (Array.isArray(session?.revisions) ? session.revisions : [])
    .find((row) => row?.id === String(revisionId || '') && row?.originalBeat);
  if (!current || current.role !== 'narration' || !revision || revision.beatId !== current.id) {
    return { ok: false, reason: 'not_found' };
  }
  const restored = cloneAuValue(revision.originalBeat, current);
  restored.revisionVersion = Math.max(1, Number(current.revisionVersion || 1)) + 1;
  restored.revisedAt = Date.now();
  beats.splice(beats.length - 1, 1, restored);
  session.checkpointSummaries = cloneAuValue(revision.checkpointSummariesBefore || [], []);
  session.revisions = [...session.revisions, {
    id: genId('revision'),
    beatId: restored.id,
    requirement: '恢复上一版',
    originalText: current.text,
    newText: restored.text,
    originalBeat: cloneAuValue(current, {}),
    newBeat: cloneAuValue(restored, {}),
    checkpointSummariesBefore: cloneAuValue(revision.checkpointSummariesAfter || [], []),
    checkpointSummariesAfter: cloneAuValue(session.checkpointSummaries, []),
    ts: Date.now(),
  }].slice(-40);
  return { ok: true, beat: restored };
}

export function applyAuExternalRevision(session = {}, beatId = '', text = '', requirement = '') {
  const beats = Array.isArray(session?.beats) ? session.beats : [];
  const index = beats.length - 1;
  const original = beats[index];
  const nextText = String(text || '').trim();
  if (!original || original.role !== 'narration' || String(original.id) !== String(beatId) || !nextText) {
    return { ok: false, reason: 'invalid_target' };
  }
  const checkpointsBefore = cloneAuValue(session.checkpointSummaries || [], []);
  if (!auVersionStore(session)[String(original.id)]?.versions?.length) {
    recordAuRerollVersion(session, original, checkpointsBefore, '初始版本');
  }
  const revised = cloneAuValue(original, {});
  revised.text = nextText;
  revised.revisionVersion = Math.max(1, Number(original.revisionVersion || 1)) + 1;
  revised.revisedAt = Date.now();
  revised.voiceLines = [];
  delete revised.editorialAudits;
  beats.splice(index, 1, revised);
  session.checkpointSummaries = (session.checkpointSummaries || [])
    .filter((row) => Number(row?.uptoBeatIndex || 0) < beats.filter((beat) => beat?.role === 'narration').length);
  session.revisions = [...(Array.isArray(session.revisions) ? session.revisions : []), {
    id: genId('revision'),
    beatId: revised.id,
    requirement: String(requirement || '').trim(),
    originalText: original.text,
    newText: revised.text,
    originalBeat: cloneAuValue(original, {}),
    newBeat: cloneAuValue(revised, {}),
    checkpointSummariesBefore: checkpointsBefore,
    checkpointSummariesAfter: cloneAuValue(session.checkpointSummaries || [], []),
    ts: Date.now(),
  }].slice(-40);
  recordAuRerollVersion(session, revised, session.checkpointSummaries || []);
  return { ok: true, beat: revised };
}

/** 兼容旧番外仅保存 characterId 的数据。数组首位同时是角色第一视角的主视角。 */
export function auStoryCharacterIds(session = {}) {
  const ids = uniqueIds(session?.characterIds);
  if (ids.length) return ids;
  const legacyId = String(session?.characterId || '').trim();
  return legacyId ? [legacyId] : [];
}

/** 旧番外默认包含用户；只有新会话明确写入 false 时才启用无 user 模式。 */
export function auStoryIncludesUser(session = {}) {
  return session?.userInStory !== false;
}

export function auStoryImageSubjectIds(session = {}) {
  const characterIds = auStoryCharacterIds(session);
  return auStoryIncludesUser(session) ? ['user', ...characterIds] : characterIds;
}

export function auStoryCharacterNames(session = {}) {
  const ids = auStoryCharacterIds(session);
  const stored = session?.characterNames && typeof session.characterNames === 'object'
    ? session.characterNames
    : {};
  return Object.fromEntries(ids.map((id, index) => [
    id,
    String(stored[id] || (index === 0 ? session?.characterName : '') || id).trim() || id,
  ]));
}

export function auStoryActors(session = {}, characters = []) {
  const byId = new Map((Array.isArray(characters) ? characters : [])
    .filter((character) => character?.id)
    .map((character) => [String(character.id), character]));
  const names = auStoryCharacterNames(session);
  return auStoryCharacterIds(session).map((id) => {
    const character = byId.get(id) || null;
    return {
      id,
      name: getCharacterAiContextName(character, names[id] || id),
      character,
    };
  });
}

export async function saveAuStory(session) {
  if (!session?.id) return null;
  const ids = auStoryCharacterIds(session);
  if (ids.length) {
    session.characterIds = ids;
    session.characterId = ids[0];
    session.characterNames = auStoryCharacterNames(session);
    session.characterName = session.characterNames[ids[0]] || session.characterName || ids[0];
  }
  session.userInStory = auStoryIncludesUser(session);
  session.updatedAt = Date.now();
  await putRecord('auStories', session);
  return session;
}

function legacyMechanics(session = {}) {
  return {
    tone: session.tone,
    perspective: session.perspective,
    person: session.person,
    wordMin: session.wordMin,
    wordMax: session.wordMax,
    rounds: session.rounds,
    optionCards: session.optionCards,
    blockUserSpeech: session.blockUserSpeech,
    innerVoiceEnabled: session.innerVoiceEnabled,
    autoInnerVoiceRepair: session.autoInnerVoiceRepair,
    dialogueMode: session.dialogueMode,
    noParaphrase: session.noParaphrase,
    directorMode: session.directorMode,
    imageGenMode: session.imageGenMode,
    imageStyleId: session.imageStyleId,
    autoImagePerBeat: session.autoImagePerBeat,
    imagePromptTemplate: session.imagePromptTemplate,
    ttsEnabled: session.ttsEnabled,
    contextDepth: session.contextDepth,
    autoSummaryEvery: session.autoSummaryEvery,
    worldBookIds: session.worldBookIds,
    presetStyleIds: session.presetStyleIds,
    guidancePrompt: session.guidancePrompt,
  };
}

/**
 * 番外复用普通线下的叙事机制，但只把机制参数带进独立 auStories，
 * 不创建 activitySession，也不写主线记忆。
 */
export function getAuStoryMechanics(session = {}) {
  const normalized = createSceneDraft({
    ...legacyMechanics(session),
    ...(session?.mechanics || {}),
  });
  return {
    ...pickOfflineScenePresetFields(normalized),
    autoInnerVoiceRepair: session?.mechanics?.autoInnerVoiceRepair === true
      || session?.autoInnerVoiceRepair === true,
    guidancePrompt: String(session?.mechanics?.guidancePrompt ?? session?.guidancePrompt ?? '').trim(),
  };
}

function syncLegacyMechanics(session, mechanics) {
  session.mechanics = {
    ...pickOfflineScenePresetFields(mechanics),
    autoInnerVoiceRepair: mechanics?.autoInnerVoiceRepair === true,
    guidancePrompt: String(mechanics?.guidancePrompt || '').trim(),
  };
  // 旧版页面和旧数据仍读这些顶层字段；保持镜像可平滑升级。
  session.perspective = session.mechanics.perspective;
  session.person = session.mechanics.person;
  session.wordMin = session.mechanics.wordMin;
  session.wordMax = session.mechanics.wordMax;
  session.optionCards = session.mechanics.optionCards;
  session.autoInnerVoiceRepair = session.mechanics.autoInnerVoiceRepair;
  return session.mechanics;
}

export async function updateAuStoryMechanics(session, patch = {}) {
  if (!session) throw new Error('番外会话不存在');
  const mechanics = getAuStoryMechanics({
    ...session,
    mechanics: {
      ...getAuStoryMechanics(session),
      ...(patch || {}),
    },
  });
  syncLegacyMechanics(session, mechanics);
  await saveAuStory(session);
  return mechanics;
}

export async function deleteAuStory(id) {
  await deleteRecord('auStories', id);
}

/**
 * 把主题来源归一化成 { presetId, name, overlay, strongOverride }。
 * theme 可来自：内置 preset、特殊设定里的自定义 AU 条目、用户现填的自定义主题。
 */
function resolveTheme(theme = {}) {
  if (theme && theme.presetId) {
    const preset = getAuPreset(theme.presetId);
    if (preset) {
      return {
        presetId: preset.id,
        name: preset.name,
        overlay: preset.overlay || '',
        strongOverride: preset.strongOverride === true,
      };
    }
  }
  const name = String(theme?.name || '').trim() || '自定义番外';
  return {
    presetId: '',
    name,
    overlay: String(theme?.overlay || '').trim(),
    strongOverride: theme?.strongOverride === true,
  };
}

export async function createAuStory({
  userId,
  character,
  characters = [],
  userInStory = true,
  auPresetId,
  theme,
  title = '',
  perspective = '',
  person = '',
  plot = '',
  relationships = '',
  optionCards = false,
  wordMin,
  wordMax,
  mechanics = {},
}) {
  const selectedCharacters = [];
  const seenCharacterIds = new Set();
  [...(Array.isArray(characters) ? characters : []), character]
    .filter((item) => item?.id)
    .forEach((item) => {
      const id = String(item.id).trim();
      if (!id || seenCharacterIds.has(id)) return;
      seenCharacterIds.add(id);
      selectedCharacters.push(item);
    });
  if (!selectedCharacters.length) throw new Error('至少选择一个角色');
  const characterIds = selectedCharacters.map((item) => String(item.id).trim());
  const characterNames = Object.fromEntries(selectedCharacters.map((item) => [
    String(item.id).trim(),
    getCharacterAiContextName(item, item.id),
  ]));
  const primaryCharacter = selectedCharacters[0];
  const resolved = resolveTheme(theme || { presetId: auPresetId });
  const presetFields = await loadLastOfflineScenePresetFields(userId).catch(() => ({}));
  const normalizedMechanics = createSceneDraft({
    ...presetFields,
    ...(mechanics || {}),
    ...(perspective ? { perspective } : {}),
    ...(person ? { person } : {}),
    ...(wordMin != null ? { wordMin } : {}),
    ...(wordMax != null ? { wordMax } : {}),
    ...(optionCards === true ? { optionCards: true } : {}),
  });
  const range = clampWordRange(normalizedMechanics, 200, 500);
  const session = {
    id: genId('austory'),
    userId: String(userId || '').trim(),
    userInStory: userInStory !== false,
    characterIds,
    characterNames,
    // 旧代码继续读取首位角色；多人数据以 characterIds / characterNames 为准。
    characterId: String(primaryCharacter.id).trim(),
    characterName: characterNames[String(primaryCharacter.id).trim()],
    auPresetId: resolved.presetId,
    auName: resolved.name,
    auOverlay: resolved.overlay,
    auStrongOverride: resolved.strongOverride,
    title: String(title || '').trim(),
    perspective: normalizePerspective(normalizedMechanics.perspective),
    person: normalizePersonForPerspective(
      normalizedMechanics.perspective,
      normalizePerson(normalizedMechanics.person),
    ),
    plot: String(plot || '').trim(),
    relationships: String(relationships || '').trim(),
    optionCards: normalizedMechanics.optionCards === true,
    status: 'active',
    wordMin: range.wordMin,
    wordMax: range.wordMax,
    beats: [],
    summary: '',
    sharedTo: [],
    isolated: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  normalizedMechanics.wordMin = range.wordMin;
  normalizedMechanics.wordMax = range.wordMax;
  syncLegacyMechanics(session, normalizedMechanics);
  await saveAuStory(session);
  return session;
}

/** 删除单条 beat（方向/叙事）；删叙事时会一并去掉紧邻的前一条方向。 */
export function deleteAuBeat(session = {}, beatId = '') {
  const id = String(beatId || '').trim();
  if (!session?.beats || !id) return { ok: false, reason: 'invalid' };
  const idx = session.beats.findIndex((b) => b.id === id);
  if (idx < 0) return { ok: false, reason: 'not_found' };
  const beat = session.beats[idx];
  if (!['directive', 'narration'].includes(beat.role)) return { ok: false, reason: 'protected' };
  if (beat.role === 'narration') {
    const prev = session.beats[idx - 1];
    if (prev?.role === 'directive') session.beats.splice(idx - 1, 2);
    else session.beats.splice(idx, 1);
  } else {
    session.beats.splice(idx, 1);
  }
  return { ok: true, role: beat.role };
}

/** 撤销最后一轮番外叙事（及紧邻的方向 beat），供重 roll 使用。 */
export function rollbackLastAuBeat(session = {}) {
  const beats = Array.isArray(session.beats) ? [...session.beats] : [];
  if (!beats.length || beats[beats.length - 1]?.role !== 'narration') {
    return { ok: false, directive: '', removed: 0 };
  }
  beats.pop();
  let directive = '';
  if (beats.length && beats[beats.length - 1]?.role === 'directive') {
    directive = String(beats[beats.length - 1].text || '').trim();
    beats.pop();
  }
  session.beats = beats;
  return { ok: true, directive, removed: 1 };
}

function lastRevisableAuBeat(session = {}) {
  const beats = Array.isArray(session?.beats) ? session.beats : [];
  const index = beats.length - 1;
  const beat = beats[index];
  if (!beat || beat.role !== 'narration') return null;
  const directiveBeat = beats[index - 1]?.role === 'directive' ? beats[index - 1] : null;
  const narrationNumber = beats.slice(0, index + 1).filter((row) => row?.role === 'narration').length;
  return { beat, index, directiveBeat, narrationNumber };
}

export function canReviseLastAuBeat(session = {}, beatId = '') {
  const target = lastRevisableAuBeat(session);
  if (!target) return false;
  const id = String(beatId || '').trim();
  return !id || String(target.beat.id || '') === id;
}

function auRevisionInstruction(revision = null) {
  if (!revision) return '';
  return [
    '【番外指导重修 · 硬约束】',
    '上一版是未采用的错误稿，只用于识别问题，不属于已经发生的剧情；禁止承接、复述或保留其中造成问题的写法。',
    `上一版（未采用）：\n${revision.originalText}`,
    `本次重修要求：${revision.requirement}`,
    '请从同一时间点重写这一层，严格承接更早上文，只输出完整替代正文及本场已启用的文末协议。',
  ].join('\n');
}

export function buildAuStaleDirectiveRepairTail(directive = '') {
  const current = String(directive || '').trim();
  if (!current) return '';
  return [
    '【自动纠偏重试 · 最高优先级】',
    '上一稿错误地回应了更早一轮方向，已经作废，不得复用其措辞、动作或回应对象。',
    `本轮唯一需要直接承接的最新输入：${current}`,
    '从上一段有效叙事的结尾继续，正文第一拍必须直接落实这条最新输入；历史方向均已执行完毕。',
  ].join('\n');
}

function compactProfileObject(value = {}, labels = {}) {
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value)
    .map(([key, raw]) => {
      const text = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
      return text ? `${labels[key] || key}：${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** 番外也必须拿到完整角色卡；AU 只覆盖世界身份，不覆盖人物外貌、性格与口吻。 */
export function buildAuCharacterProfileText(character, { includeUser = true } = {}) {
  if (!character || typeof character !== 'object') return '';
  const relationshipSource = character.relationships && typeof character.relationships === 'object'
    ? Object.fromEntries(Object.entries(character.relationships)
      .filter(([key]) => includeUser || String(key).toLowerCase() !== 'user'))
    : {};
  const relationships = compactProfileObject(relationshipSource, { user: '与用户关系' });
  const lifeProfile = compactProfileObject(character.lifeProfile, {
    homeDetails: '居家细节',
    familyThreads: '家庭线索',
    socialAnchors: '社交锚点',
    habits: '习惯与小癖',
    activitySeeds: '活动种子',
  });
  return [
    character.promptCorpus ? `完整人物设定：${character.promptCorpus}` : '',
    character.personality ? `性格：${character.personality}` : '',
    character.speechStyle ? `说话风格：${character.speechStyle}` : '',
    character.speechCorpus ? `角色语料：${character.speechCorpus}` : '',
    character.appearancePrompt ? `稳定外貌：${character.appearancePrompt}` : '',
    character.currentRole ? `默认世界身份（与番外映射冲突时只覆盖身份）：${character.currentRole}` : '',
    character.currentStatus ? `当前状态参考：${character.currentStatus}` : '',
    includeUser && character.userRelationStatus ? `与用户关系状态：${character.userRelationStatus}` : '',
    relationships ? `关系网：\n${relationships}` : '',
    lifeProfile ? `生活与习惯：\n${lifeProfile}` : '',
    character.notes ? `补充：${character.notes}` : '',
  ].filter(Boolean).join('\n');
}

function buildAuOverlayBlock(overlay, strongOverride) {
  if (!overlay) return '';
  const header = strongOverride
    ? '【番外·强覆盖】以下架空设定优先级高于默认世界观与角色默认身份；冲突以本设定为准，仅保留人物性格与关系底色。'
    : '【番外设定】以下为本场番外的架空背景，叙事须遵守。';
  return `${header}\n${overlay}`;
}

function buildAuWorldBookQuery(session = {}, directive = '') {
  const recentBeats = (Array.isArray(session?.beats) ? session.beats : [])
    .slice(-12)
    .map((beat) => String(beat?.text || '').trim())
    .filter(Boolean);
  return [
    session?.auName,
    session?.title,
    session?.auOverlay,
    session?.plot,
    session?.relationships,
    directive,
    ...recentBeats,
  ].map((part) => String(part || '').trim()).filter(Boolean).join('\n');
}

/** 兼容旧 session（只存了 auPresetId）：回退到内置 preset overlay。 */
function sessionOverlay(session) {
  if (session?.auOverlay) return { overlay: session.auOverlay, strongOverride: session.auStrongOverride === true };
  const preset = getAuPreset(session?.auPresetId);
  return { overlay: preset?.overlay || '', strongOverride: preset?.strongOverride === true };
}

const NARRATION_SYSTEM = '这是一个「番外/异世界」平行剧场，与角色真实经历无关，纯属脑洞。可见部分只写叙事正文（旁白、动作、场景，可夹少量关键对白）；若本轮任务要求文末结构块，必须在正文后完整追加。不要输出聊天气泡、发送标签、群聊格式或额外解释。';

function narrationSystemForSession(session = {}) {
  return auStoryIncludesUser(session)
    ? `${NARRATION_SYSTEM} 不要替用户做决定。`
    : `${NARRATION_SYSTEM} 本场为无 user 模式：用户只是场外操作者，不是故事人物；正文不得让用户、玩家、操作者或导演以任何形式出场、说话、行动、被看见、被等待或被角色感知。`;
}

function buildUserProfileText(user, userName) {
  if (!user || typeof user !== 'object') return '';
  return [
    user.persona ? `${userName}的人设：${user.persona}` : '',
    user.signature ? `${userName}的签名：${user.signature}` : '',
  ].filter(Boolean).join('\n');
}

function buildAuTranslationInstruction(character = {}, name = '', { includeUser = true } = {}) {
  const profile = normalizeTranslationProfile(character?.translationProfile);
  const who = String(name || '角色').trim() || '角色';
  if (profile.mode === 'full') {
    return [
      '[外语人设翻译]',
      `${who}（主要讲${profile.language || 'TA 设定里的外语'}）的对白台词要直接写外语原文（不要写成中文），紧跟在这句台词后面用〔〕标出中文翻译，如：「I've missed you.」〔我很想你。〕`,
      `〔〕翻译只放在这些角色的直接引语后面，不要用来翻译旁白、动作描写${includeUser ? '，也不要影响用户的对白语言' : ''}；必须用半角方头括号〔〕，不要用普通括号（）。`,
      '〔〕里必须是简体中文译文，禁止复制外语原文或日语假名进去。',
    ].join('\n');
  }
  if (profile.mode === 'mixed') {
    return [
      '[偶尔外语/方言翻译]',
      `${who}（偶尔蹦${profile.dialectNote || '外语/方言词句'}）平时对白正常写中文，只有偶尔蹦出这类词句时，直接紧跟着用〔〕标出意思，如：他挠挠头，「这方案有点anticlimactic〔虎头蛇尾〕啊」；不要整句翻译，也不要没事找词硬凑，必须用〔〕而不是普通括号（）。`,
    ].join('\n');
  }
  return '';
}

function buildBeatPrompt({
  session,
  mechanics,
  actors = [],
  userName,
  userProfile,
  directive,
  isColdStart,
  hasPriorNarration,
  wordMin,
  wordMax,
  narrativeModeBlock = '',
  translationBlock = '',
  innerVoiceBlock = '',
  voiceInstruction = '',
  worldBookRecallTail = '',
}) {
  const userInStory = auStoryIncludesUser(session);
  const actorNames = actors.map((actor) => actor.name).filter(Boolean);
  const namesText = actorNames.join('、') || '角色';
  const profile = actors.map((actor) => {
    const details = buildAuCharacterProfileText(actor.character, { includeUser: userInStory });
    return [`【角色 · ${actor.name}｜id=${actor.id}】`, details].filter(Boolean).join('\n');
  }).join('\n\n');
  const primaryActor = actors[0] || null;
  const { overlay, strongOverride } = sessionOverlay(session);
  const overlayBlock = buildAuOverlayBlock(overlay, strongOverride);
  const trimmedDirective = String(directive || '').trim();
  const perspective = normalizePerspective(session?.perspective);
  const person = normalizePersonForPerspective(perspective, session?.person);
  const emptyDirectiveHint = !trimmedDirective && hasPriorNarration
    ? `${userInStory ? '用户本轮未填写方向' : '本轮未填写导演方向'}：请从上文结尾自然续写，严禁跳回开场或重置剧情。`
    : '';
  const continuationAnchor = isColdStart ? '' : buildAuContinuationAnchor(session);
  return [
    '[番外剧场 · 沉浸推进]',
    overlayBlock,
    session?.title ? `番外标题：${session.title}` : '',
    `参与角色：${namesText}（分别保留各自性格与关系底色，身份按番外设定映射）`,
    profile ? `角色资料参考：\n${profile}` : '',
    userInStory && userProfile ? `用户（${userName}）参考：\n${userProfile}` : '',
    session?.relationships ? `人物关系：${session.relationships}` : '',
    session?.plot
      ? (isColdStart
        ? `大概剧情走向（作为参考，不要照搬复述）：${session.plot}`
        : `【全场长期路线 · 不是当前开场】${session.plot}\n这条只约束整场番外的长期方向；其中已经发生的步骤不得重新演，当前落点只认本提示末尾的【当前剧情断点】。`)
      : '',
    mechanics?.tone ? `本场语气 / 氛围：${mechanics.tone}` : '',
    userInStory
      ? `在场：${userName} 与 ${namesText} 一同身处这个番外世界。`
      : `【无 user 模式 · 硬边界】本场在场者只有 ${namesText}。用户、玩家、操作者与场外导演均不属于故事世界；不得让其出场、说话、行动、被提及、被寻找、被等待或被任何角色感知。角色资料、世界书或预设里若出现用户关系，只视为场外背景噪声，不得带入本场。`,
    actors.length > 1
      ? '【多人身份边界】每张角色卡只属于对应 id；禁止合并人设、互换经历、口吻、外貌或关系。单轮不必让所有角色轮流发言，只聚焦真正参与当前拍点的人。'
      : '',
    perspectiveText(perspective, person),
    actors.length > 1 && perspective === 'character' && primaryActor
      ? `【多人角色第一视角】唯一第一人称叙述者是 ${primaryActor.name}（id=${primaryActor.id}）；只有 ${primaryActor.name} 的叙述正文使用「我」。其余角色用名字或第三人称，禁止多人争用同一个「我」。`
      : '',
    personText(person, perspective),
    personContinuityText(perspective, person),
    isColdStart
      ? '这是番外的开场，请确立这个异世界里在场人物的处境与关系。'
      : '请自然接续上面的番外片段向前推进，不要复述，不要回到开场或重新介绍场景。',
    emptyDirectiveHint,
    trimmedDirective
      ? `${userInStory ? '本轮方向' : '本轮导演方向（仅作为场外创作指令，不是任何人物的台词或行动）'}：${trimmedDirective}`
      : '本轮方向：按当前节奏自然推进一小段。',
    '写法：旁白、动作、场景为主，可夹少量关键对白；把角色本轮动作、对白与即时后果完整写到自然形成的新局面。',
    mechanics?.rounds
      ? `节奏参考：本场计划约 ${mechanics.rounds} 轮，当前是第 ${(session?.beats || []).filter((beat) => beat?.role === 'narration').length + 1} 轮；按进度自然推进，不要机械倒计时或强行收尾。`
      : '',
    mechanics?.guidancePrompt ? `【本场写作指导】\n${mechanics.guidancePrompt}` : '',
    mechanics?.dialogueMode && userInStory
      ? '【对话模式】用户本轮输入默认是已经说出口的话；角色直接承接其含义与语气回应，不要把它改写成旁白、动作或尚未说出口的想法。'
      : '',
    wordRangeDirective(wordMin, wordMax),
    VARIED_SEGMENTATION_HINT,
    narrativeModeBlock,
    !userInStory
      ? '【无 user 输出校验】正文只能描写所选角色与环境；禁止为了互动完整而虚构用户替身、第二人称对象、镜头后的提问者或“等待回应”的空位。'
      : (mechanics?.blockUserSpeech !== false
        ? '【防抢话 · 硬限制】不得替用户补写未明确输入的台词、行动、心理或决定；从角色与环境的下一拍反应开始。用户侧留白只表示不代写用户，角色自己的动作、对白和即时后果仍须完整落地；禁止用“静静等待用户回应 / 看着用户等选择 / 把空白留给用户”收尾。'
        : '可以自然补足用户侧的即时动作与回应，但不得替用户作出会改变关系或剧情方向的重大决定。'),
    translationBlock,
    voiceInstruction,
    mechanics?.optionCards ? advanceOptionsInstruction(3) : '',
    mechanics?.autoImagePerBeat
      ? sceneImageDirectiveInstruction({
        styleId: mechanics.imageStyleId,
        anchor: mechanics.imagePromptTemplate,
        includeUser: userInStory,
        availableSubjects: [
          ...(userInStory ? [{ id: 'user', name: userName || '用户' }] : []),
          ...actors.map((actor) => ({ id: actor.id, name: actor.name })),
        ],
      })
      : '',
    innerVoiceBlock,
    worldBookRecallTail,
    continuationAnchor,
    buildOfflineCurrentDirectiveTail(trimmedDirective, { userPresent: userInStory }),
  ].filter(Boolean).join('\n');
}

function cleanText(raw) {
  return sanitizeNarrationOutput(raw);
}

function stripAuGenerationTail(raw = '') {
  // 与普通线下一致：先删 think / thinking，避免思考区预演的协议开头
  // 跨过正式正文配到文末结束标记。
  const text = stripThinkingBlocks(String(raw || ''));
  const cuts = [
    text.indexOf(OPTIONS_START),
    text.indexOf(SCENE_IMAGE_DIRECTIVE_START),
    text.indexOf(OFFLINE_CHARACTER_STATES_START),
    text.indexOf(NARRATIVE_VOICE_LINES_START),
  ].filter((index) => index !== -1);
  return cuts.length ? text.slice(0, Math.min(...cuts)) : text;
}

export function missingAuCharacterStateIds(beat = {}, characterIds = []) {
  const states = beat?.characterStates && typeof beat.characterStates === 'object'
    ? beat.characterStates
    : {};
  return uniqueIds(characterIds).filter((id) => !states[id]);
}

async function resolveAuInnerVoiceGenerationOptions(user, actors = []) {
  const prefs = await loadOfflineStylePrefs(user?.id).catch(() => ({}));
  if (prefs?.innerVoiceCardSource === 'custom') {
    const card = resolveOfflineInnerVoiceCard(prefs, null, 'diary');
    return {
      generationMode: card?.generationMode,
      generationPrompt: card?.generationPrompt,
    };
  }
  const rows = await Promise.all((Array.isArray(actors) ? actors : []).map(async (actor) => {
    const chat = await findPrivateChat(user?.id, actor.id).catch(() => null);
    const card = resolveOfflineInnerVoiceCard(prefs, chat, 'diary');
    const prompt = card?.generationMode === 'custom'
      ? String(card.generationPrompt || '').trim()
      : '';
    return [actor.id, prompt];
  }));
  return {
    actorGenerationPrompts: Object.fromEntries(rows.filter(([, prompt]) => prompt)),
  };
}

async function requestAuCharacterStateRepair({
  actors,
  narration,
  previousStates,
  userName,
  userPresent,
  generationOptions,
  apiOverride,
  narrationMaxTokens,
  signal,
}) {
  const prompt = [
    '【番外楼层 · 补全缺失心声】',
    '下面正文已经生成并保存。不要续写、改写、总结或重复正文；只补指定角色在这一刻没说出口的心声结构块。',
    `已生成正文：\n${String(narration || '').trim()}`,
    offlineCharacterStatesInstruction(actors, previousStates, {
      userName,
      userPresent,
      ...(generationOptions || {}),
    }),
    '只输出上述心声结构块，不要输出任何可见叙事正文。',
  ].filter(Boolean).join('\n\n');
  const raw = await chatWithEmptyFallback(apiChat, [
    { role: 'system', content: prompt },
    { role: 'user', content: '请仅补全指定角色在已生成正文后的心声结构块。' },
  ], {
    temperature: 0.65,
    configOverride: apiOverride || undefined,
    signal,
    stream: false,
    auditContext: { operation: 'au-inner-voice-repair' },
  });
  return extractOfflineCharacterStates(stripThinkingBlocks(raw), {
    actors,
    previousStates,
    userName,
  }).states || {};
}

/** 流式预览：截掉走向选项块，并在选项未写完时丢掉末行半截。 */
function previewAuStream(fullText = '', { optionCards = false } = {}) {
  const text = String(fullText || '');
  const bodyOnly = stripAuGenerationTail(optionCards ? stripOptionsTail(text) : text);
  const cleaned = cleanText(bodyOnly);
  if (!optionCards) return { cleaned, options: [], optionsStarted: false };
  const optionsStarted = text.includes(OPTIONS_START);
  let options = optionsStarted ? extractAdvanceOptions(text).options : [];
  if (optionsStarted && !text.includes(OPTIONS_END) && !text.endsWith('\n')) {
    options = options.slice(0, -1);
  }
  return { cleaned, options, optionsStarted };
}

function transcriptWithinDepth(session = {}, contextDepth = 12) {
  const beats = Array.isArray(session?.beats) ? session.beats : [];
  const narrationIndexes = beats
    .map((beat, index) => (beat?.role === 'narration' ? index : -1))
    .filter((index) => index >= 0);
  const keep = Math.max(2, Math.min(60, Number(contextDepth) || 12));
  const firstKeptNarrationIndex = narrationIndexes.length > keep
    ? narrationIndexes[narrationIndexes.length - keep]
    : 0;
  const start = firstKeptNarrationIndex > 0 && beats[firstKeptNarrationIndex - 1]?.role === 'directive'
    ? firstKeptNarrationIndex - 1
    : firstKeptNarrationIndex;
  return beats.slice(Math.max(0, start));
}

export function buildAuContinuationAnchor(session = {}, { maxChars = 1800 } = {}) {
  const narrations = (Array.isArray(session?.beats) ? session.beats : [])
    .filter((beat) => beat?.role === 'narration' && String(beat?.text || '').trim());
  const latest = narrations[narrations.length - 1];
  if (!latest) return '';
  const text = String(latest.text || '').trim();
  const limit = Math.max(400, Math.min(4000, Number(maxChars) || 1800));
  const clipped = text.length > limit
    ? `（本幕较早部分略）${text.slice(-limit)}`
    : text;
  return [
    `【当前剧情断点 · 第 ${narrations.length} 幕已完成】`,
    clipped,
    '上面是当前世界线最后真实发生的一幕，不是背景示例。下一幕第一拍必须承接它结尾的人物位置、动作、话题与持续状态；禁止回到相遇、入场、自我介绍或番外第一幕，除非这一幕结尾明确发生了时空回溯。',
  ].join('\n');
}

function normalizeAuReplayProbe(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/gu, '');
}

function auReplayNgrams(value = '', size = 4) {
  const normalized = normalizeAuReplayProbe(value);
  const grams = new Set();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

function auReplaySimilarity(left = '', right = '') {
  const leftGrams = auReplayNgrams(left);
  const rightGrams = auReplayNgrams(right);
  if (leftGrams.size < 8 || rightGrams.size < 8) return 0;
  let shared = 0;
  leftGrams.forEach((gram) => {
    if (rightGrams.has(gram)) shared += 1;
  });
  return shared / Math.min(leftGrams.size, rightGrams.size);
}

/** 高置信度拦截长篇番外把首幕重新演一遍；只做本地判定，不追加模型请求。 */
export function detectAuOpeningReplay({ narration = '', beats = [] } = {}) {
  const narrations = (Array.isArray(beats) ? beats : [])
    .filter((beat) => beat?.role === 'narration' && String(beat?.text || '').trim());
  if (narrations.length < 4 || !String(narration || '').trim()) {
    return { stale: false, openingSimilarity: 0, recentSimilarity: 0 };
  }
  const opening = String(narrations[0].text || '');
  const recent = narrations.slice(-2).map((beat) => String(beat.text || '')).join('\n');
  const openingSimilarity = auReplaySimilarity(narration, opening);
  const recentSimilarity = auReplaySimilarity(narration, recent);
  return {
    stale: openingSimilarity >= 0.4
      && recentSimilarity <= 0.2
      && openingSimilarity - recentSimilarity >= 0.22,
    openingSimilarity,
    recentSimilarity,
  };
}

export function buildAuHistoryTranscript(session = {}, contextDepth = 12, {
  userName = '用户',
  characterName = '角色',
} = {}) {
  const directionLabel = auStoryIncludesUser(session) ? '历史用户方向' : '历史导演方向';
  const contextBeats = transcriptWithinDepth(session, contextDepth);
  return contextBeats.map((beat, index) => {
    const text = applyPromptRegex(beat.text, {
      surface: 'autheater',
      placement: beat.role === 'narration' ? 2 : 1,
      depth: contextBeats.length - 1 - index,
      macros: { user: userName, char: characterName },
    });
    return {
      role: beat.role === 'narration' ? 'assistant' : 'user',
      content: beat.role === 'directive'
        ? `[${directionLabel}·已执行]\n${text}\n[历史边界] 后面的番外叙事已经是它的执行结果；后续轮次禁止再次回应、引用或复演它。`
        : text,
    };
  });
}

function checkpointContextBlock(session = {}) {
  const rows = Array.isArray(session?.checkpointSummaries) ? session.checkpointSummaries : [];
  if (!rows.length) return '';
  return [
    '【番外较早剧情小结】',
    ...rows.slice(-12).map((row) => `第 ${row.fromBeatIndex || '?'}-${row.uptoBeatIndex || '?'} 轮：${row.text}`),
    '以上均为本场番外已经发生的事实；只用于连续性，不要复述。',
  ].join('\n');
}

async function maybeCreateAuCheckpointSummary(session, mechanics, { signal = null } = {}) {
  const narrationBeats = (session?.beats || []).filter((beat) => beat?.role === 'narration');
  const uptoBeatIndex = narrationBeats.length;
  if (!uptoBeatIndex) return null;
  const every = Math.max(
    2,
    Math.min(100, Number(mechanics?.autoSummaryEvery) || Number(mechanics?.contextDepth) || 12),
  );
  const rows = Array.isArray(session.checkpointSummaries) ? session.checkpointSummaries : [];
  const coveredUpto = rows.length ? Math.max(...rows.map((row) => Number(row?.uptoBeatIndex) || 0)) : 0;
  if (uptoBeatIndex - coveredUpto < every) return null;
  const segmentNarrations = narrationBeats.slice(coveredUpto, uptoBeatIndex);
  const firstId = segmentNarrations[0]?.id;
  const lastId = segmentNarrations[segmentNarrations.length - 1]?.id;
  const allBeats = Array.isArray(session.beats) ? session.beats : [];
  const start = Math.max(0, allBeats.findIndex((beat) => beat?.id === firstId) - 1);
  const end = allBeats.findIndex((beat) => beat?.id === lastId);
  const source = allBeats.slice(start, end + 1).map((beat) => (
    beat.role === 'directive'
      ? `${auStoryIncludesUser(session) ? '用户方向' : '导演方向'}：${beat.text}`
      : `叙事：${beat.text}`
  )).join('\n\n');
  try {
    const raw = await chatForTask([{
      role: 'user',
      content: [
        '[番外剧场 · 分段小结]',
        '用 2-3 句中文压缩下面已经发生的番外剧情。保留关键行动与结果、关系变化、持续状态、重要物件、未完成事项；不要标题、列表、JSON 或解释。',
        source,
      ].join('\n'),
    }], { temperature: 0.45, signal }, 'chatSummary');
    const text = cleanText(raw);
    if (!text) return null;
    const row = {
      text,
      fromBeatIndex: coveredUpto + 1,
      uptoBeatIndex,
      ts: Date.now(),
    };
    session.checkpointSummaries = [...rows, row];
    return row;
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    console.warn('[au-theater] checkpoint summary failed', error);
    return null;
  }
}

async function attachAuBeatVoices(beat, actors = [], { signal = null } = {}) {
  const lines = Array.isArray(beat?.voiceLines) ? beat.voiceLines : [];
  if (!lines.length) return;
  const globalConfig = await loadVoiceToolConfig().catch(() => null);
  if (!globalConfig) return;
  const actorById = new Map(actors.map((actor) => [String(actor.id), actor]));
  const voiced = [];
  for (const line of lines) {
    const actor = actorById.get(String(line?.actorId || ''))
      || actors.find((item) => item.name === line?.actorName)
      || actors[0];
    if (!actor?.id) continue;
    const baseProfile = actor.character?.voiceProfile || {};
    const config = resolveVoiceToolConfigForProfile(globalConfig, baseProfile);
    const voiceProfileOverride = buildVoiceSpeechProfileOverride(
      baseProfile,
      line.speechPlan,
      config,
    ) || baseProfile;
    const text = stripTranslationMarks(line?.speechPlan?.text || line?.text || '');
    if (!text) continue;
    const audio = await synthesizeVoice({
      text,
      characterId: actor.id,
      config,
      voiceProfileOverride,
      signal,
    }).catch((error) => {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      return null;
    });
    if (!audio?.audioDataUrl) continue;
    voiced.push({
      ...line,
      audio: {
        dataUrl: audio.audioDataUrl,
        mimeType: audio.mimeType || audio.audioMimeType || '',
      },
    });
  }
  beat.voiceLines = voiced.length ? voiced : lines;
}

export async function runAuBeat({
  session,
  character,
  characters = [],
  user,
  directive = '',
  revision = null,
  onChunk = null,
  onBeatReady = null,
  onReasoning = null,
  signal = null,
}) {
  if (!session) throw new Error('番外会话不存在');
  const generationLease = await acquireNarrationGenerationLease('au', session.id);
  if (!generationLease.acquired) throw narrationGenerationInFlightError();
  try {
  await primeRegex().catch(() => null);
  const revisionTarget = revision ? lastRevisableAuBeat(session) : null;
  if (revision && !revisionTarget) throw new Error('只能重修当前最后一层番外');
  if (revision?.beatId && String(revision.beatId) !== String(revisionTarget?.beat?.id || '')) {
    throw new Error('只能重修当前最后一层番外');
  }
  const revisionRequirement = String(revision?.requirement || '').trim().slice(0, 500);
  if (revision && !revisionRequirement) throw new Error('请写下这次想怎么改');
  const originalDirective = String(revisionTarget?.directiveBeat?.text || '').trim();
  const generationSession = revisionTarget
    ? {
      ...session,
      beats: session.beats.slice(0, revisionTarget.directiveBeat ? revisionTarget.index - 1 : revisionTarget.index),
      checkpointSummaries: (session.checkpointSummaries || [])
        .filter((row) => Number(row?.uptoBeatIndex || 0) < revisionTarget.narrationNumber),
    }
    : session;
  const actors = auStoryActors(session, [
    ...(Array.isArray(characters) ? characters : []),
    ...(character ? [character] : []),
  ]);
  if (!actors.length) throw new Error('番外缺少参与角色');
  const actorIds = actors.map((actor) => actor.id);
  const stateActors = actors.map(({ id, name, character: actorCharacter }) => ({
    id,
    name,
    translationProfile: normalizeTranslationProfile(actorCharacter?.translationProfile),
  }));
  const name = actors.map((actor) => actor.name).join('、');
  const primaryActor = actors[0];
  const primaryCharacter = primaryActor.character || character || null;
  const userInStory = auStoryIncludesUser(session);
  const userName = userInStory ? getUserDisplayName(user) : '';
  const macroUserName = userInStory ? userName : '场外导演';
  const mechanics = getAuStoryMechanics(session);
  syncLegacyMechanics(session, mechanics);

  const transcript = buildAuHistoryTranscript(generationSession, mechanics.contextDepth, {
    userName: macroUserName,
    characterName: name,
  });
  const storedDirective = applyPermanentRegex(String(revision ? (directive || originalDirective) : directive || '').trim(), {
    surface: 'autheater',
    placement: 1,
    depth: 0,
    macros: { user: macroUserName, char: name },
  });
  const promptDirective = applyPromptRegex(storedDirective, {
    surface: 'autheater',
    placement: 1,
    depth: 0,
    macros: { user: macroUserName, char: name },
  });
  const beatIndex = generationSession.beats.filter((b) => b.role === 'narration').length;
  const narrationEver = Math.max(Number(session.narrationEver || 0), beatIndex);
  const isColdStart = beatIndex === 0 && (revision ? true : narrationEver === 0);
  const hasPriorNarration = revision ? beatIndex > 0 : narrationEver > 0;
  const range = clampWordRange(mechanics, 200, 500);
  const linkedChat = userInStory && actorIds.length === 1
    ? await findPrivateChat(user?.id, primaryActor.id).catch(() => null)
    : null;
  const chatPrefs = linkedChat ? await loadChatPrefs(linkedChat.id) : {};
  const innerVoiceGenerationOptions = mechanics.innerVoiceEnabled
    ? await resolveAuInnerVoiceGenerationOptions(user, stateActors)
    : {};
  const narrativeModeBlock = buildNarrativeModeDirectivesBlock({
    ...chatPrefs,
    antiInterruption: userInStory && mechanics.blockUserSpeech !== false,
    noParaphrase: mechanics.noParaphrase,
    directorMode: mechanics.directorMode,
  });
  const explicitWorldBookIds = normalizeWorldBookIds(mechanics);
  const selectedWorldBookIds = explicitWorldBookIds.length
    ? explicitWorldBookIds
    : normalizeWorldBookIds(chatPrefs);
  const [worldBookBundle, frontSystemPrompt] = await Promise.all([
    buildWorldBookContextBundle(
      user,
      buildAuWorldBookQuery(generationSession, promptDirective),
      {
        worldBookMode: 'selective',
        characterIds: actorIds,
        onlyBookIds: selectedWorldBookIds.length ? selectedWorldBookIds : undefined,
      },
    ).catch(() => ({ block: '', recallTail: '' })),
    buildFrontSystemPromptBlock().catch(() => ''),
  ]);
  const rawWorldBookBlock = String(worldBookBundle?.block || '');
  const worldBookBlock = applyPromptRegex(rawWorldBookBlock, {
    surface: 'autheater',
    placement: 4,
    includePermanent: true,
    macros: { user: macroUserName, char: name },
  });
  const globalVoiceConfig = mechanics.ttsEnabled
    ? await loadVoiceToolConfig().catch(() => null)
    : null;
  const voiceConfig = globalVoiceConfig
    ? resolveVoiceToolConfigForProfile(globalVoiceConfig, primaryCharacter?.voiceProfile || {})
    : null;
  const voiceInstruction = mechanics.ttsEnabled
    ? buildNarrativeVoiceLinesInstruction(
      stateActors,
      {
        surface: VOICE_WORLD_BOOK_SURFACES.AU,
        provider: voiceConfig?.provider || 'minimax',
        customText: voiceConfig?.styleBook?.text || '',
        worldBookEnabled: voiceConfig?.styleBook?.enabled === true,
      },
    )
    : '';
  const prompt = [
    buildBeatPrompt({
      session: generationSession,
      mechanics,
      actors,
      userName,
      userProfile: userInStory ? buildUserProfileText(user, userName) : '',
      directive: promptDirective,
      isColdStart,
      hasPriorNarration,
      wordMin: range.wordMin,
      wordMax: range.wordMax,
      narrativeModeBlock,
      translationBlock: actors
        .map((actor) => buildAuTranslationInstruction(
          actor.character,
          actor.name,
          { includeUser: userInStory },
        ))
        .filter(Boolean)
        .join('\n\n'),
      innerVoiceBlock: mechanics.innerVoiceEnabled
        ? offlineCharacterStatesInstruction(
          stateActors,
          latestOfflineCharacterStates(generationSession, actorIds),
          {
            userName: userInStory ? userName : '',
            userPresent: userInStory,
            ...innerVoiceGenerationOptions,
          },
        )
        : '',
      voiceInstruction,
      worldBookRecallTail: worldBookBlock ? String(worldBookBundle?.recallTail || '') : '',
    }),
    auRevisionInstruction(revision ? {
      originalText: String(revisionTarget?.beat?.text || ''),
      requirement: revisionRequirement,
    } : null),
  ].filter(Boolean).join('\n\n');

  const presetBlock = await buildPresetFragmentContext('offline', {
    onlyIds: Array.isArray(mechanics.presetStyleIds) ? mechanics.presetStyleIds : [],
  });
  const checkpointBlock = checkpointContextBlock(generationSession);
  const apiOverride = await resolveSceneApiConfig().catch(() => null);
  const narrationMaxTokens = await resolveNarrationMaxTokens(apiOverride);
  const buildMessages = (promptSuffix = '') => [
    { role: 'system', content: narrationSystemForSession(generationSession) },
    ...(frontSystemPrompt ? [{ role: 'system', content: frontSystemPrompt }] : []),
    ...(checkpointBlock ? [{ role: 'system', content: checkpointBlock }] : []),
    ...(worldBookBlock ? [{
      role: 'system',
      content: `【番外世界书使用边界】世界书用于保留人物底色、关系规则与可兼容的世界细节；若与本场番外设定或身份映射冲突，以本场番外设定为准。\n${worldBookBlock}`,
    }] : []),
    ...(presetBlock ? [{ role: 'system', content: presetBlock }] : []),
    ...transcript,
    { role: 'user', content: [prompt, promptSuffix].filter(Boolean).join('\n\n') },
  ];
  let finishReason = '';
  let upstreamMeta = {};
  let lastReasoningPreview = '';
  const requestOptions = {
    temperature: 0.95,
    maxTokens: narrationMaxTokens,
    configOverride: apiOverride || undefined,
    signal,
    auditContext: { operation: 'au-beat' },
    onFinishReason: (reason) => { finishReason = String(reason || '').trim(); },
    onCompletionMeta: (meta) => {
      upstreamMeta = { ...upstreamMeta, ...(meta || {}) };
      const reasoningText = String(upstreamMeta.reasoningText || '');
      if (typeof onReasoning === 'function' && reasoningText && reasoningText !== lastReasoningPreview) {
        lastReasoningPreview = reasoningText;
        onReasoning(reasoningText);
      }
    },
  };
  const useChunk = typeof onChunk === 'function';
  if (useChunk) {
    const preferStream = await resolveChatPreferStream(apiOverride);
    if (preferStream) {
      requestOptions.stream = true;
      requestOptions.onChunk = (_piece, fullText) => {
        const preview = previewAuStream(fullText, { optionCards: mechanics.optionCards === true });
        onChunk(preview.cleaned, {
          options: preview.options,
          optionsStarted: preview.optionsStarted,
        });
      };
    }
  }

  let raw = await chatWithEmptyFallback(apiChat, buildMessages(), requestOptions);
  const parseGenerated = (text) => {
    const visibleText = stripThinkingBlocks(text);
    const voiceResult = extractNarrativeVoiceLines(visibleText, { actors: stateActors });
    const stateResult = mechanics.innerVoiceEnabled
      ? extractOfflineCharacterStates(voiceResult.body, {
        actors: stateActors,
        previousStates: latestOfflineCharacterStates(generationSession, actorIds),
        userName: userInStory ? userName : '',
      })
      : { body: voiceResult.body, states: {} };
    const imageResult = mechanics.autoImagePerBeat
      ? extractSceneImageDirective(stateResult.body)
      : { body: stateResult.body, imagePrompt: '' };
    const optionResult = mechanics.optionCards
      ? extractAdvanceOptions(imageResult.body)
      : { body: imageResult.body, options: [] };
    const narration = applyPermanentRegex(cleanText(optionResult.body), {
      surface: 'autheater',
      placement: 2,
      depth: 0,
      macros: { user: macroUserName, char: name },
    });
    return { voiceResult, stateResult, imageResult, optionResult, narration };
  };
  let parsed = parseGenerated(raw);
  const previousDirectives = [...(generationSession.beats || [])]
    .reverse()
    .filter((beat) => beat?.role === 'directive')
    .slice(0, 3)
    .map((beat) => String(beat.text || '').trim())
    .filter(Boolean);
  const staleReplay = detectOfflineStaleDirectiveReplay({
    narration: parsed.narration,
    currentDirective: promptDirective,
    previousDirectives,
  });
  if (parsed.narration && staleReplay.stale) {
    const staleError = new Error('模型回应了更早一轮，本次错误结果未保存；请补充本轮方向后重试');
    staleError.reason = 'stale-directive-replay';
    throw staleError;
  }
  const openingReplay = detectAuOpeningReplay({
    narration: parsed.narration,
    beats: generationSession.beats,
  });
  if (beatIndex > mechanics.contextDepth && openingReplay.stale) {
    const openingError = new Error('模型疑似跳回了番外开场，本次错误结果未保存；请重 roll，或补一句当前场景方向后再推进');
    openingError.reason = 'opening-replay';
    openingError.openingSimilarity = openingReplay.openingSimilarity;
    openingError.recentSimilarity = openingReplay.recentSimilarity;
    throw openingError;
  }
  if (!parsed.narration) {
    const reasoningText = String(upstreamMeta.reasoningText || '').trim();
    const emptyError = new Error(reasoningText
      ? '上游只返回了推理内容，没有返回可显示的正文'
      : '本轮未生成可显示正文，请重试');
    emptyError.reason = finishReason === 'length' ? 'length-truncated' : 'empty-api-response';
    emptyError.rawText = String(raw || '').slice(0, 8000);
    emptyError.finishReason = finishReason;
    emptyError.upstreamMeta = upstreamMeta;
    if (reasoningText) {
      emptyError.reasoningText = reasoningText;
      emptyError.emptyKind = 'reasoning-only';
    }
    throw emptyError;
  }
  if (mechanics.innerVoiceEnabled && mechanics.autoInnerVoiceRepair === true) {
    const existingStates = parsed.stateResult.states || {};
    const missingActors = stateActors.filter((actor) => !existingStates[actor.id]);
    if (missingActors.length) {
      try {
        const repairedStates = await requestAuCharacterStateRepair({
          actors: missingActors,
          narration: parsed.narration,
          previousStates: latestOfflineCharacterStates(generationSession, actorIds),
          userName: userInStory ? userName : '',
          userPresent: userInStory,
          generationOptions: innerVoiceGenerationOptions,
          apiOverride,
          narrationMaxTokens,
          signal,
        });
        parsed.stateResult.states = { ...existingStates, ...repairedStates };
      } catch (error) {
        console.warn('[au-theater] optional inner voice repair failed', error);
      }
    }
  }
  const { voiceResult, stateResult, imageResult, optionResult, narration } = parsed;

  if (useChunk && !requestOptions.stream) {
    onChunk(narration, {
      options: optionResult.options || [],
      optionsStarted: Array.isArray(optionResult.options) && optionResult.options.length > 0,
    });
  }

  const ts = Date.now();
  const trimmed = storedDirective;
  if (trimmed && !revisionTarget) session.beats.push({ id: genId('beat'), role: 'directive', text: trimmed, ts });
  const characterStates = Object.fromEntries(
    Object.entries(stateResult.states || {}).map(([id, state]) => [
      id,
      {
        ...state,
        inner: applyPermanentRegex(state?.inner || '', {
          surface: 'autheater',
          placement: 2,
          depth: 0,
          macros: { user: macroUserName, char: name },
        }),
        intent: applyPermanentRegex(state?.intent || '', {
          surface: 'autheater',
          placement: 2,
          depth: 0,
          macros: { user: macroUserName, char: name },
        }),
      },
    ]),
  );
  const beat = {
    id: revisionTarget?.beat?.id || genId('beat'),
    role: 'narration',
    text: narration,
    ts: revisionTarget?.beat?.ts || ts,
    options: optionResult.options || [],
  };
  const reasoningText = String(upstreamMeta.reasoningText || '').trim();
  if (reasoningText) {
    const maxReasoningChars = 24000;
    beat.reasoningText = reasoningText.length > maxReasoningChars
      ? `（较早的思考内容已省略）\n${reasoningText.slice(-maxReasoningChars)}`
      : reasoningText;
  }
  if (finishReason === 'length') {
    beat.continuationPending = true;
    beat.continuationReason = 'length';
  }
  if (voiceResult.lines.length) beat.voiceLines = voiceResult.lines;
  if (Object.keys(characterStates).length) beat.characterStates = characterStates;
  if (imageResult.imagePrompt) beat.aiImagePrompt = imageResult.imagePrompt;
  if (Array.isArray(imageResult.imageSubjectIds)) beat.aiImageSubjectIds = imageResult.imageSubjectIds;
  if (revisionTarget) {
    const checkpointsBefore = cloneAuValue(session.checkpointSummaries || [], []);
    if (!auVersionStore(session)[String(revisionTarget.beat.id)]?.versions?.length) {
      recordAuRerollVersion(session, revisionTarget.beat, checkpointsBefore, '初始版本');
    }
    beat.revisionVersion = Math.max(1, Number(revisionTarget.beat.revisionVersion || 1)) + 1;
    beat.revisedAt = ts;
    session.beats.splice(revisionTarget.index, 1, beat);
    session.checkpointSummaries = (session.checkpointSummaries || [])
      .filter((row) => Number(row?.uptoBeatIndex || 0) < revisionTarget.narrationNumber);
    session.revisions = [...(Array.isArray(session.revisions) ? session.revisions : []), {
      id: genId('revision'),
      beatId: beat.id,
      requirement: revisionRequirement,
      originalText: String(revisionTarget.beat.text || ''),
      newText: narration,
      originalBeat: cloneAuValue(revisionTarget.beat, {}),
      newBeat: cloneAuValue(beat, {}),
      checkpointSummariesBefore: checkpointsBefore,
      checkpointSummariesAfter: [],
      ts,
    }].slice(-40);
    recordAuRerollVersion(session, beat, session.checkpointSummaries || []);
  } else {
    session.beats.push(beat);
  }
  session.narrationEver = Math.max(Number(session.narrationEver || 0), session.beats.filter((b) => b.role === 'narration').length);

  // 模型正文已经完整返回。先终止流式光标，再做整场落库、配音、生图和分段摘要；
  // 后处理耗时会随楼层增多而增长，但不应继续伪装成“正文仍在输出”。
  if (typeof onBeatReady === 'function') onBeatReady(beat, { phase: 'text' });
  await saveAuStory(session);
  if (typeof onBeatReady === 'function') onBeatReady(beat, { phase: 'content' });

  if (mechanics.autoImagePerBeat) {
    const availableImageSubjectIds = auStoryImageSubjectIds(session);
    const imageSubjectIds = Array.isArray(imageResult.imageSubjectIds)
      ? imageResult.imageSubjectIds.filter((id) => availableImageSubjectIds.includes(id))
      : availableImageSubjectIds;
    const scene = {
      place: session.auName,
      goal: session.title || session.plot,
      tone: mechanics.tone,
      imagePromptTemplate: mechanics.imagePromptTemplate,
    };
    const promptText = buildOfflineScenePrompt({
      scene,
      beatText: narration,
      styleId: mechanics.imageStyleId,
      aiPrompt: imageResult.imagePrompt,
      subjectCount: imageSubjectIds.length,
      includeUser: userInStory,
    });
    const generated = await maybeGenerateOfflineSceneImage({
      prompt: promptText,
      subjectIds: imageSubjectIds,
      user: userInStory ? user : null,
      imageGenMode: mechanics.imageGenMode,
      signal,
    }).catch((error) => {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      return {
        image: '',
        prompt: promptText,
        error: String(error?.message || error || '场景生图失败'),
      };
    });
    beat.image = generated?.image
      ? {
        url: generated.image,
        prompt: generated.prompt,
        styleId: mechanics.imageStyleId || '',
        ...(generated.referenceSkipped ? {
          referenceSkipped: true,
          warning: '参考图锁定未生效，已改用文字外观生成',
        } : {}),
      }
      : {
        url: '',
        prompt: generated?.prompt || promptText,
        styleId: mechanics.imageStyleId || '',
        error: String(generated?.error || '场景生图失败').slice(0, 160),
      };
  }
  if (mechanics.ttsEnabled) {
    await attachAuBeatVoices(beat, actors, { signal }).catch((error) => {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      return null;
    });
  }
  await maybeCreateAuCheckpointSummary(session, mechanics, { signal });
  syncActiveAuRerollVersion(session, beat);
  await saveAuStory(session);
  if (typeof onBeatReady === 'function') onBeatReady(beat, { phase: 'complete' });
  archiveNarration({
    kind: 'au',
    title: session.title || session.auName || '番外',
    subtitle: [session.auName, name].filter(Boolean).join(' · '),
    text: narration,
    characterId: primaryActor.id,
    characterName: name,
    meta: { auStoryId: session.id, characterIds: actorIds },
  });
  return beat;
  } finally {
    await generationLease.release();
  }
}

export async function continueAuBeat({
  session,
  user,
  characters = [],
  beatId = '',
  signal = null,
} = {}) {
  if (!session) throw new Error('番外会话不存在');
  const beat = [...(session.beats || [])].reverse().find((row) => row?.role === 'narration');
  if (!beat || String(beat.id || '') !== String(beatId || '')) throw new Error('只能续写当前最后一层');
  const generationLease = await acquireNarrationGenerationLease('au', session.id);
  if (!generationLease.acquired) throw narrationGenerationInFlightError();
  try {
  const actors = auStoryActors(session, characters);
  const profiles = actors.map((actor) => `【${actor.name}】\n${buildAuCharacterProfileText(actor.character, { includeUser: auStoryIncludesUser(session) })}`).join('\n\n');
  const apiOverride = await resolveSceneApiConfig().catch(() => null);
  let finishReason = '';
  const raw = await chatWithEmptyFallback(apiChat, [
    { role: 'system', content: narrationSystemForSession(session) },
    { role: 'user', content: [
      '下面番外正文因长度限制中断。只从断点继续正文，不要复述已有内容，不要另起开场，不要解释。',
      sessionOverlay(session).overlay ? `番外设定：${sessionOverlay(session).overlay}` : '',
      profiles,
      `已有正文：\n${beat.text || ''}`,
    ].filter(Boolean).join('\n\n') },
  ], {
    temperature: 0.9,
    maxTokens: await resolveNarrationMaxTokens(apiOverride),
    configOverride: apiOverride || undefined,
    signal,
    auditContext: { operation: 'au-continuation' },
    onFinishReason: (reason) => { finishReason = String(reason || '').trim(); },
  });
  const continuation = stripAuGenerationTail(raw).trim();
  if (!continuation) throw new Error('续写没有返回正文');
  beat.text = joinOfflineContinuationText(beat.text, continuation);
  beat.continuationPending = finishReason === 'length';
  beat.continuationReason = beat.continuationPending ? 'length' : '';
  beat.continuedAt = Date.now();
  if (!beat.continuationPending) delete beat.continuationReason;
  await saveAuStory(session);
  return beat;
  } finally {
    await generationLease.release();
  }
}

/** 只补当前末层仍缺失的番外心声，不改写已经展示的正文。 */
export async function supplementAuCharacterStates({
  session,
  characters = [],
  user,
  beatId = '',
  signal = null,
} = {}) {
  if (!session) throw new Error('番外会话不存在');
  if (!getAuStoryMechanics(session).innerVoiceEnabled) throw new Error('本场尚未开启心声');
  const target = [...(session.beats || [])].reverse().find((beat) => beat?.role === 'narration');
  if (!target || String(target.id || '') !== String(beatId || '')) {
    throw new Error('只能补当前最后一层的心声');
  }
  const actors = auStoryActors(session, characters);
  const missingIds = missingAuCharacterStateIds(target, actors.map((actor) => actor.id));
  if (!missingIds.length) return { beat: target, addedIds: [] };
  const missingActors = actors
    .filter((actor) => missingIds.includes(actor.id))
    .map(({ id, name, character: actorCharacter }) => ({
      id,
      name,
      translationProfile: normalizeTranslationProfile(actorCharacter?.translationProfile),
    }));
  const allIds = actors.map((actor) => actor.id);
  const previousStates = latestOfflineCharacterStates({
    ...session,
    beats: (session.beats || []).filter((beat) => beat?.id !== target.id),
  }, allIds);
  const userPresent = auStoryIncludesUser(session);
  const userName = userPresent ? getUserDisplayName(user) : '';
  const generationOptions = await resolveAuInnerVoiceGenerationOptions(user, missingActors);
  const apiOverride = await resolveSceneApiConfig().catch(() => null);
  const narrationMaxTokens = await resolveNarrationMaxTokens(apiOverride);
  const states = await requestAuCharacterStateRepair({
    actors: missingActors,
    narration: target.text,
    previousStates,
    userName,
    userPresent,
    generationOptions,
    apiOverride,
    narrationMaxTokens,
    signal,
  });
  const addedIds = Object.keys(states);
  if (!addedIds.length) throw new Error('接口没有返回可识别的心声格式，可重试一次');
  target.characterStates = { ...(target.characterStates || {}), ...states };
  target.thoughtSupplementedAt = Date.now();
  await saveAuStory(session);
  return { beat: target, addedIds };
}

/** 返回这一轮上次实际用于生图的提示词，供编辑与后续重 roll 延用。 */
export function resolveAuBeatImagePrompt(beat = {}) {
  return String(beat?.image?.prompt || '').trim();
}

/**
 * 手动生成/重 roll 番外场景图：未传 promptOverride 时沿用上次实际提示词；用户主动
 * 清空编辑框时，重新按番外设定与本轮内容组织画面。
 */
export async function generateAuBeatImage({
  session,
  user,
  beatId,
  promptOverride = null,
  styleId = '',
} = {}) {
  if (!session) throw new Error('番外会话不存在');
  const beat = (session.beats || []).find((row) => row?.id === beatId);
  if (!beat || beat.role !== 'narration') throw new Error('找不到这一轮');
  const availableImageSubjectIds = auStoryImageSubjectIds(session);
  const imageSubjectIds = Array.isArray(beat.aiImageSubjectIds)
    ? beat.aiImageSubjectIds.filter((id) => availableImageSubjectIds.includes(id))
    : availableImageSubjectIds;
  const userInStory = auStoryIncludesUser(session);
  const mechanics = getAuStoryMechanics(session);
  const effectiveStyleId = styleId || mechanics.imageStyleId;
  const effectivePromptOverride = promptOverride === null || promptOverride === undefined
    ? resolveAuBeatImagePrompt(beat)
    : String(promptOverride || '').trim();
  const prompt = buildOfflineScenePrompt({
    scene: {
      place: session.auName,
      goal: session.title || session.plot,
      tone: mechanics.tone,
      imagePromptTemplate: mechanics.imagePromptTemplate,
    },
    beatText: beat.text,
    styleId: effectiveStyleId,
    promptOverride: effectivePromptOverride,
    aiPrompt: beat.aiImagePrompt || '',
    subjectCount: imageSubjectIds.length,
    includeUser: userInStory,
  });
  const result = await maybeGenerateOfflineSceneImage({
    prompt,
    subjectIds: imageSubjectIds,
    user: userInStory ? user : null,
    imageGenMode: mechanics.imageGenMode,
  });
  if (!result?.image) throw new Error(result?.error || '生图未开启或生成失败');
  beat.image = {
    url: result.image,
    prompt: result.prompt,
    styleId: effectiveStyleId || '',
    generatedAt: Date.now(),
    ...(result.referenceSkipped ? {
      referenceSkipped: true,
      warning: '参考图锁定未生效，已改用文字外观生成',
    } : {}),
  };
  await saveAuStory(session);
  return beat;
}

export async function clearAuBeatImage(session, beatId) {
  const beat = (session?.beats || []).find((row) => row?.id === beatId);
  if (!beat?.image) return false;
  delete beat.image;
  await saveAuStory(session);
  return true;
}

/**
 * 把隔离番外整理成可作为新档位长期前提的背景，不发起额外计费请求。
 * 已有分段小结优先，最近尚未覆盖的叙事保留为当前进度。
 */
export function buildAuWorldBackground(session = {}, { maxLength = 9000 } = {}) {
  const clean = (value = '') => stripTranslationMarks(value)
    .replace(/\s+/g, ' ')
    .trim();
  const narrationBeats = (Array.isArray(session?.beats) ? session.beats : [])
    .filter((beat) => beat?.role === 'narration' && clean(beat.text));
  const checkpoints = (Array.isArray(session?.checkpointSummaries) ? session.checkpointSummaries : [])
    .map((row) => clean(row?.text))
    .filter(Boolean);
  const recentProgress = narrationBeats.slice(-3)
    .map((beat) => clean(beat.text).slice(0, 700))
    .filter(Boolean)
    .join(' ');
  const establishedPlot = [
    ...checkpoints.slice(-8),
    clean(session.summary),
    recentProgress,
  ].filter(Boolean);
  const uniquePlot = [...new Set(establishedPlot)];
  const actorNames = Object.values(auStoryCharacterNames(session)).filter(Boolean).join('、');
  const sections = [
    `【世界线】${clean(session.auName) || '未命名世界'}`,
    clean(session.auOverlay) ? `【世界背景】\n${String(session.auOverlay).trim()}` : '',
    actorNames ? `【主要人物】${actorNames}${auStoryIncludesUser(session) ? '、当前用户' : '；当前用户尚未参与此前剧情'}` : '',
    clean(session.relationships) ? `【人物关系】\n${String(session.relationships).trim()}` : '',
    clean(session.plot) ? `【原定走向】\n${String(session.plot).trim()}` : '',
    uniquePlot.length ? `【已经发生】\n${uniquePlot.join('\n')}` : '',
  ].filter(Boolean);
  const result = sections.join('\n\n').trim();
  const limit = Math.max(1000, Number(maxLength) || 9000);
  return result.length > limit ? `${result.slice(0, limit)}…` : result;
}

/** 生成番外标题 + 摘要（仅用于列表/分享，不写主线记忆）。 */
export async function summarizeAuStory({ session, finish = false }) {
  if (!session?.beats?.length) throw new Error('番外还没有内容');
  const generationLease = await acquireNarrationGenerationLease('au', session.id);
  if (!generationLease.acquired) throw narrationGenerationInFlightError();
  try {
  const joined = session.beats
    .filter((b) => b.role === 'narration')
    .map((b) => stripTranslationMarks(b.text || ''))
    .join('\n\n')
    .slice(0, 3000);
  const raw = await chatForTask([
    { role: 'system', content: '只输出一个 JSON 对象，不要解释。' },
    {
      role: 'user',
      content: `把下面这段「${session.auName}」番外凝练成 JSON：{"title":"不超过16字","summary":"1~2句不超过50字"}\n\n${joined}`,
    },
  ], { temperature: 0.6 }, 'chatSummary');
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let title = session.auName;
  let summary = '';
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      title = String(parsed?.title || session.auName).trim() || session.auName;
      summary = String(parsed?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    } catch (_) { /* keep defaults */ }
  }
  session.title = title;
  session.summary = summary;
  if (finish) {
    session.status = 'finished';
    session.finishedAt = Date.now();
  }
  await saveAuStory(session);
  return { title, summary };
  } finally {
    await generationLease.release();
  }
}

/**
 * 分享给参与角色：向各自私聊分别插入同一条用户侧脑洞，不回写任何角色记忆。
 */
export async function shareAuStoryToCharacters({ session, user }) {
  const characterIds = auStoryCharacterIds(session);
  const characterNames = auStoryCharacterNames(session);
  if (!characterIds.length) throw new Error('缺少角色');
  const title = session.title || session.auName || '一个脑洞';
  const summary = session.summary || stripTranslationMarks(session.beats.find((b) => b.role === 'narration')?.text || '').slice(0, 60);
  const content = `（跟你分享一个「${session.auName}」的番外脑洞）${title}：${summary}`;
  if (!Array.isArray(session.sharedTo)) session.sharedTo = [];
  const chats = [];
  for (const characterId of characterIds) {
    const chat = await ensurePrivateChat(session.userId, characterId, characterNames[characterId] || characterId);
    const timestamp = await nextChatMessageTimestamp(session.userId, chat.id);
    const msg = createMessage({
      chatId: chat.id,
      senderId: 'user',
      senderName: getUserDisplayName(user),
      type: 'text',
      content,
      timestamp,
      metadata: {
        auShared: true,
        auStoryId: session.id,
        auName: session.auName,
        auParticipantIds: characterIds,
      },
    });
    await saveMessage(msg);
    await updateChatPreview(chat.id, content, msg.timestamp);
    if (!session.sharedTo.includes(chat.id)) session.sharedTo.push(chat.id);
    chats.push(chat);
  }
  await saveAuStory(session);
  return chats;
}

/** 旧调用兼容：单角色番外仍返回一个 chat。 */
export async function shareAuStoryToCharacter(args) {
  const chats = await shareAuStoryToCharacters(args);
  return chats[0] || null;
}
