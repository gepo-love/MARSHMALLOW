/**
 * 角色生图锁脸：把 character.imageLock 转成实际生图参数。
 * 供聊天生图（marshmallow-gen-image）、朋友圈/微博配图（social-image-generation）、
 * 通讯录「生成预览」（contacts-edit）等所有真实生图入口共用，避免各处各写一套。
 */
import { getCharacter, saveCharacter } from './character-store.js';
import {
  isNovelAiImageGenerationEnabled,
  isRealisticImageGenerationEnabled,
  loadImageToolConfig,
  isNoFaceImageRequest,
  looksLikePersonPrompt,
} from './image-generation-tools.js';
import { getImageStylePreset } from './image-style-presets.js';

/**
 * 解析角色锁定用的参考图 URL，优先级：
 * 1. imageLock.refImageUrl（上传或从「生成预览」结果里选定的专属锁定图，最准，不受头像变动影响）
 * 2. imageLock.baseImageId 指向 showcaseImages 里的某张图（旧字段，兼容保留）
 * 3. 当前头像（兜底；头像可能被换成别的东西，不如前两者准）
 */
export function resolveImageLockRefUrl(character = {}) {
  const lock = character?.imageLock || {};
  const customRef = String(lock.refImageUrl || '').trim();
  if (customRef) return customRef;
  const baseImageId = String(lock.baseImageId || '').trim();
  if (baseImageId && baseImageId !== 'avatar') {
    const hit = (character.showcaseImages || []).find((img) => img?.id === baseImageId);
    if (hit?.url) return String(hit.url).trim();
  }
  return String(character.avatar || '').trim();
}

function mergeLockedPrompt(lockPrompt, appearancePrompt, scenePrompt) {
  const locked = String(lockPrompt || appearancePrompt || '').trim();
  const scene = String(scenePrompt || '').trim();
  if (!locked) return scene;
  if (!scene) return locked;
  if (scene.includes(locked)) return scene;
  return `${locked}, ${scene}`;
}

async function persistLockedSeed(characterId, seed) {
  try {
    const fresh = await getCharacter(characterId);
    if (!fresh) return;
    await saveCharacter({ ...fresh, imageLock: { ...(fresh.imageLock || {}), seed: String(seed) } });
  } catch (e) {
    // 匿名路人 NPC 等不可写入通讯录的角色，静默跳过，不影响本次生图
    console.warn('[character-image-lock] persist seed failed', e);
  }
}

async function resolveOrCreateLockedSeed(character, lock = {}) {
  let seed = Number(lock.seed);
  if (Number.isFinite(seed) && seed > 0) return seed;
  seed = Math.floor(Math.random() * 4294967295);
  if (character?.id) await persistLockedSeed(character.id, seed);
  return seed;
}

/**
 * 解析角色专属画风（character.imageStyleId）：
 * 返回 styleId 与建议的引擎覆盖（画风绑定的引擎已启用时才建议切引擎，未启用只带 styleId 让核心层按引擎匹配回落）。
 */
function resolveCharacterStyle(character, cfg) {
  const preset = getImageStylePreset(character?.imageStyleId);
  if (!preset) return { styleId: '', styleProvider: '' };
  const engineOk = preset.engine === 'novelai'
    ? isNovelAiImageGenerationEnabled(cfg)
    : isRealisticImageGenerationEnabled(cfg);
  return { styleId: preset.id, styleProvider: engineOk ? preset.engine : '' };
}

/**
 * 按角色 imageLock + imageStyleId 配置加工生图参数。不抛错——任何配置不全/引擎未开都优雅回落。
 * options.styleEngineOverride === false 时，角色画风只带 styleId、不强制切引擎
 * （线下氛围图等仍按场景配置选引擎的场合用）。
 * @returns {Promise<{ prompt: string, providerOverride: ''|'novelai'|'realistic', seed?: number, refImageUrls?: string[], styleId?: string }>}
 */
export async function applyCharacterImageLock(character, scenePrompt, options = {}) {
  const fallback = { prompt: scenePrompt, providerOverride: '' };
  if (!character) return fallback;
  const lock = character.imageLock || {};
  const mode = String(lock.mode || 'none');

  let cfg;
  try {
    cfg = options.config || await loadImageToolConfig();
  } catch (_) {
    return fallback;
  }
  const resolved = resolveCharacterStyle(character, cfg);
  const styleId = resolved.styleId;
  // 人物是否存在、是否需要保留角色身份、是否采用人物画风和是否为正脸人像是四件事。
  // partial 可用于背影/手部/环境构图：允许显式保留身份或套媒介画风，但不能因此强制变成自拍。
  const peopleIntent = String(options.peopleIntent || '').trim();
  const detectedPerson = options.forcePortrait === true || looksLikePersonPrompt(scenePrompt);
  const hasPersonScene = peopleIntent ? peopleIntent !== 'none' : detectedPerson;
  const isPortraitScene = peopleIntent ? peopleIntent === 'portrait' : detectedPerson;
  const characterStyleAllowed = isPortraitScene || options.characterStyleAllowed === true;
  const preserveIdentity = isPortraitScene || options.preserveIdentity === true;
  const shouldApplyIdentityLock = hasPersonScene
    && preserveIdentity
    && options.identityLockAllowed !== false;
  const styleProvider = (
    options.styleEngineOverride === false
    || !hasPersonScene
    || !characterStyleAllowed
  )
    ? ''
    : resolved.styleProvider;

  if (mode === 'none') {
    // 未配置 seed/参考图锁定时，明确是角色本人出镜仍应带上角色外观。
    // 聊天生图过去只依赖模型临时写 prompt，容易比相册更频繁崩脸。
    const prompt = shouldApplyIdentityLock
      ? mergeLockedPrompt('', character.appearancePrompt, scenePrompt)
      : scenePrompt;
    return { prompt, providerOverride: styleProvider, styleId };
  }

  // 无人图永远不注入角色；局部人物只有调用方明确声明 preserveIdentity 时才锁定，
  // 避免角色只是发了一张路人/物件照片却被参考图重新拉回本人正脸。
  if (!shouldApplyIdentityLock) {
    return { prompt: scenePrompt, providerOverride: '', styleId };
  }

  const prompt = mergeLockedPrompt(lock.prompt, character.appearancePrompt, scenePrompt);
  const suppressFaceLock = isNoFaceImageRequest(options);

  // 局部、背影和无人构图可以保留文字层面的发型/衣着等身份线索，但不能把
  // 正脸参考图或复现人像的 seed 带进请求，否则会反向把无脸构图拉成正脸照。
  if (suppressFaceLock && (mode === 'seed' || mode === 'reference')) {
    return { prompt, providerOverride: styleProvider, styleId, faceReferenceSuppressed: true };
  }

  if (mode === 'seed') {
    // seed 锁必须走 NovelAI，优先于画风绑定的引擎
    if (!isNovelAiImageGenerationEnabled(cfg)) return { prompt, providerOverride: styleProvider, styleId };
    const seed = await resolveOrCreateLockedSeed(character, lock);
    return { prompt, providerOverride: 'novelai', seed, styleId };
  }

  if (mode === 'reference') {
    const refUrl = resolveImageLockRefUrl(character);
    if (!refUrl) return { prompt, providerOverride: styleProvider, styleId };
    const naiOk = isNovelAiImageGenerationEnabled(cfg);
    const realOk = isRealisticImageGenerationEnabled(cfg);
    if (!naiOk && !realOk) return { prompt, providerOverride: '', styleId };
    // 无专属 NovelAI 画风时优先走真正接收参考图的兼容编辑接口；
    // NovelAI Vibe Transfer 同时带稳定 seed，减少同一角色跨图漂移。
    const providerOverride = styleProvider === 'novelai'
      ? 'novelai'
      : (realOk ? 'realistic' : 'novelai');
    const seed = naiOk
      ? await resolveOrCreateLockedSeed(character, lock)
      : undefined;
    return {
      prompt,
      providerOverride,
      ...(seed ? { seed } : {}),
      refImageUrls: [refUrl],
      requireReferenceIdentity: true,
      referenceProviderFallback: true,
      styleId,
    };
  }

  // prompt 模式：任何引擎都只需要把锁定的外观描述并入本次提示词
  return { prompt, providerOverride: styleProvider, styleId };
}

/** 便捷方法：按 characterId 查角色并应用锁定；查不到角色时原样返回 scenePrompt，不影响正常发图 */
export async function applyImageLockByCharacterId(characterId, scenePrompt, options = {}) {
  const id = String(characterId || '').trim();
  if (!id) return { prompt: scenePrompt, providerOverride: '' };
  const character = options.character || await getCharacter(id).catch(() => null);
  if (!character) return { prompt: scenePrompt, providerOverride: '' };
  return applyCharacterImageLock(character, scenePrompt, options);
}

/** 把 applyCharacterImageLock 的结果铺平进生图 options，供 generateImageForScene 直接使用 */
export function mergeImageLockIntoOptions(lockResult, baseOptions = {}) {
  const next = { ...baseOptions };
  if (lockResult?.providerOverride) next.providerOverride = lockResult.providerOverride;
  if (lockResult?.seed != null) next.seed = lockResult.seed;
  if (lockResult?.refImageUrls?.length) next.refImageUrls = lockResult.refImageUrls;
  if (lockResult?.referenceSubjects?.length) next.referenceSubjects = lockResult.referenceSubjects;
  if (lockResult?.expectedReferenceCount != null) {
    next.expectedReferenceCount = Number(lockResult.expectedReferenceCount) || 0;
  }
  if (lockResult?.expectedReferenceSubjectIds?.length) {
    next.expectedReferenceSubjectIds = lockResult.expectedReferenceSubjectIds;
  }
  if (lockResult?.requireReferenceIdentity === true) next.requireReferenceIdentity = true;
  if (lockResult?.referenceProviderFallback === false) next.referenceProviderFallback = false;
  else if (lockResult?.referenceProviderFallback === true) next.referenceProviderFallback = true;
  if (lockResult?.realisticIdentityPrompt) next.realisticIdentityPrompt = lockResult.realisticIdentityPrompt;
  if (lockResult?.styleId) next.styleId = lockResult.styleId;
  return next;
}
