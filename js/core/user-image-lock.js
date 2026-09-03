/**
 * 用户生图锁脸：把 user.imageLock 转成实际生图参数。
 * 结构与角色锁脸对齐，供用户空间预览、聊天自助生图等入口共用。
 */
import { getCurrentUser, saveUserRecord } from './user-slot.js';
import {
  isNovelAiImageGenerationEnabled,
  isNoFaceImageRequest,
  isRealisticImageGenerationEnabled,
  loadImageToolConfig,
  looksLikePersonPrompt,
} from './image-generation-tools.js';
import { getImageStylePreset } from './image-style-presets.js';
import { normalizeImageLock } from '../models/character.js';
import { normalizeUserRecord } from '../models/user.js';

export function resolveUserImageLockRefUrl(user = {}) {
  const lock = user?.imageLock || {};
  const customRef = String(lock.refImageUrl || '').trim();
  if (customRef) return customRef;
  return String(user.avatar || '').trim();
}

function mergeLockedPrompt(lockPrompt, appearancePrompt, scenePrompt) {
  const locked = String(lockPrompt || appearancePrompt || '').trim();
  const scene = String(scenePrompt || '').trim();
  if (!locked) return scene;
  if (!scene) return locked;
  if (scene.includes(locked)) return scene;
  return `${locked}, ${scene}`;
}

async function persistUserLockedSeed(userId, seed) {
  try {
    const uid = String(userId || '').trim();
    if (!uid) return;
    const fresh = await getCurrentUser();
    if (!fresh || String(fresh.id) !== uid) return;
    const next = normalizeUserRecord({
      ...fresh,
      imageLock: { ...normalizeImageLock(fresh.imageLock), seed: String(seed) },
    });
    await saveUserRecord(next);
  } catch (e) {
    console.warn('[user-image-lock] persist seed failed', e);
  }
}

function resolveUserStyle(user, cfg) {
  const preset = getImageStylePreset(user?.imageStyleId);
  if (!preset) return { styleId: '', styleProvider: '' };
  const engineOk = preset.engine === 'novelai'
    ? isNovelAiImageGenerationEnabled(cfg)
    : isRealisticImageGenerationEnabled(cfg);
  return { styleId: preset.id, styleProvider: engineOk ? preset.engine : '' };
}

/**
 * @returns {Promise<{ prompt: string, providerOverride: ''|'novelai'|'realistic', seed?: number, refImageUrls?: string[], styleId?: string }>}
 */
export async function applyUserImageLock(user, scenePrompt, options = {}) {
  const fallback = { prompt: scenePrompt, providerOverride: '' };
  if (!user) return fallback;
  const lock = normalizeImageLock(user.imageLock);
  const mode = String(lock.mode || 'none');
  const hasStyle = !!getImageStylePreset(user.imageStyleId);
  const peopleIntent = String(options.peopleIntent || '').trim();
  const detectedPerson = options.forcePortrait === true || looksLikePersonPrompt(scenePrompt);
  const hasPersonScene = peopleIntent ? peopleIntent !== 'none' : detectedPerson;
  const isPortraitScene = peopleIntent ? peopleIntent === 'portrait' : detectedPerson;
  const characterStyleAllowed = isPortraitScene || options.characterStyleAllowed === true;
  const preserveIdentity = isPortraitScene || options.preserveIdentity === true;
  const shouldApplyIdentityLock = hasPersonScene
    && preserveIdentity
    && options.identityLockAllowed !== false;

  // 手动勾选用户时会传 forcePortrait。即使没有另开 seed / 参考图锁定，
  // 已填写的「生图外观描述」也应参与提示词，行为与角色人物保持一致。
  if (mode === 'none' && !hasStyle) {
    return {
      prompt: shouldApplyIdentityLock
        ? mergeLockedPrompt('', user.appearancePrompt, scenePrompt)
        : scenePrompt,
      providerOverride: '',
    };
  }

  let cfg;
  try {
    cfg = options.config || await loadImageToolConfig();
  } catch (_) {
    return fallback;
  }
  const resolved = resolveUserStyle(user, cfg);
  const styleId = resolved.styleId;
  const styleProvider = (
    options.styleEngineOverride === false
    || !hasPersonScene
    || !characterStyleAllowed
  )
    ? ''
    : resolved.styleProvider;

  if (mode === 'none') {
    return { prompt: scenePrompt, providerOverride: styleProvider, styleId };
  }

  if (!shouldApplyIdentityLock) {
    return { prompt: scenePrompt, providerOverride: '', styleId };
  }

  const prompt = mergeLockedPrompt(lock.prompt, user.appearancePrompt, scenePrompt);
  const suppressFaceLock = isNoFaceImageRequest(options);
  if (suppressFaceLock && (mode === 'seed' || mode === 'reference')) {
    return { prompt, providerOverride: styleProvider, styleId, faceReferenceSuppressed: true };
  }

  if (mode === 'seed') {
    if (!isNovelAiImageGenerationEnabled(cfg)) return { prompt, providerOverride: styleProvider, styleId };
    let seed = Number(lock.seed);
    if (!Number.isFinite(seed) || seed <= 0) {
      seed = Math.floor(Math.random() * 4294967295);
      if (user.id) await persistUserLockedSeed(user.id, seed);
    }
    return { prompt, providerOverride: 'novelai', seed, styleId };
  }

  if (mode === 'reference') {
    const refUrl = resolveUserImageLockRefUrl({ ...user, imageLock: lock });
    if (!refUrl) return { prompt, providerOverride: styleProvider, styleId };
    const naiOk = isNovelAiImageGenerationEnabled(cfg);
    const realOk = isRealisticImageGenerationEnabled(cfg);
    if (!naiOk && !realOk) return { prompt, providerOverride: '', styleId };
    const providerOverride = styleProvider === 'novelai'
      ? 'novelai'
      : (realOk ? 'realistic' : 'novelai');
    let seed = Number(lock.seed);
    if (naiOk && (!Number.isFinite(seed) || seed <= 0)) {
      seed = Math.floor(Math.random() * 4294967295);
      if (user.id) await persistUserLockedSeed(user.id, seed);
    }
    return {
      prompt,
      providerOverride,
      ...(naiOk && seed > 0 ? { seed } : {}),
      refImageUrls: [refUrl],
      requireReferenceIdentity: true,
      referenceProviderFallback: true,
      styleId,
    };
  }

  return { prompt, providerOverride: styleProvider, styleId };
}

export { mergeImageLockIntoOptions } from './character-image-lock.js';
