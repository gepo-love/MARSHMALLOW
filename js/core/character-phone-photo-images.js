import {
  applySceneStyleToPrompt,
  buildSocialImageGenPromptRules,
  isSocialImageGenEnabled,
  resolveSceneStyleFragment,
  resolveSocialImageGenMode,
  resolveTextImageCaption,
  buildFallbackTextImageCaption,
} from './social-image-generation.js';
import {
  generateImageForScene,
  loadImageToolConfig,
  looksLikePersonPrompt,
  persistGeneratedImageUrlLocally,
} from './image-generation-tools.js';
import { applyCharacterImageLock, mergeImageLockIntoOptions } from './character-image-lock.js';
import { applyUserImageLock } from './user-image-lock.js';
import { applyMultiActorImageLocks } from './multi-actor-image-lock.js';
import { loadCharacterPhone, saveCharacterPhone } from './character-phone-store.js';
import { getCurrentUser } from './user-slot.js';

/**
 * 相册生图：聊天或朋友圈任一开启即可（旧版只绑 chatImages，只开朋友圈时会整批降级成文字图）。
 * 引擎路由优先朋友圈场景，其次聊天。
 */
export async function resolvePhoneAlbumImageScene(config = null) {
  const cfg = config || await loadImageToolConfig().catch(() => ({}));
  if (await isSocialImageGenEnabled('momentsImages', cfg)) return 'momentsImages';
  if (await isSocialImageGenEnabled('chatImages', cfg)) return 'chatImages';
  return '';
}

export async function isPhoneAlbumImageGenEnabled(config = null) {
  return !!(await resolvePhoneAlbumImageScene(config));
}

export async function resolvePhoneAlbumImageGenMode(config = null) {
  const cfg = config || await loadImageToolConfig().catch(() => ({}));
  const scene = await resolvePhoneAlbumImageScene(cfg);
  if (!scene) return '';
  return resolveSocialImageGenMode(scene, cfg);
}

function clean(value = '') {
  return String(value ?? '').trim();
}

/** 供手机补记录 / 相册生成注入的配图规则 */
export function buildPhonePhotoRecordsImageRules(imageGenMode = '') {
  const base = buildSocialImageGenPromptRules(imageGenMode);
  return `${base}
【相册记录专用】
- photoRecords 每条都可配图；约半数 wantsImage:true，其余写 wantsImage:false 且不要写 imagePrompt / textImageCaption。
- title 写相册条目标题，caption 写一句话备注，location 可写拍摄地点。
- 每条必须写 imagePeople:"portrait|partial|none"；图中是 TA 本人时写 imageIdentity:"self"，是用户本人时写 "user"，TA 与用户合照写 "both"，其他人写 "other"，无人图写 "none"。
- 拍摄者不等于画面主体：例如「TA 给用户拍的照片」必须写 imageIdentity:"user"，不能因为记录在 TA 的手机里就写 self。
- 自拍、静物、窗景、街景、食物等都要有，符合 TA 人设与近期生活线索。`;
}

export function phonePhotoNeedsGeneration(record = {}, { forceReroll = false } = {}) {
  if (!record || typeof record !== 'object') return false;
  const url = clean(record.imageUrl || record.url || '');
  if (forceReroll) return !!(clean(record.imagePrompt) || clean(record.textImageCaption) || record.title || record.caption);
  // 模型明确选了不配图时，标题/备注只是相册文字，不应反过来触发一次收费生图。
  if (record.wantsImage === false) return false;
  if (record.imageKind === 'textimg' || record.imageKind === 'pending' || record.imageError) return true;
  if (url && record.imageKind === 'photo') return false;
  if (url) return false;
  return record.wantsImage === true
    || !!clean(record.imagePrompt)
    || !!clean(record.textImageCaption);
}

function buildFallbackCaption(record = {}) {
  return buildFallbackTextImageCaption({
    text: record.caption || record.title,
    imagePrompt: record.imagePrompt,
    mood: record.location,
  });
}

function normalizePhotoPeopleIntent(value = '') {
  const key = clean(value).toLowerCase();
  if (['portrait', 'present', 'people', 'person', 'yes', '有', '有人'].includes(key)) return 'portrait';
  if (['partial', 'body', 'anonymous', '局部', '背影', '不露脸'].includes(key)) return 'partial';
  if (['none', 'no', 'empty', '无人', '没有'].includes(key)) return 'none';
  return '';
}

function normalizePhotoIdentity(value = '') {
  const key = clean(value).toLowerCase();
  if (['self', 'actor', 'character', 'preserve', '本人', '自己', '角色'].includes(key)) return 'self';
  if (['user', 'the user', 'owner user', '用户', '用户本人', '我方'].includes(key)) return 'user';
  if (['both', 'together', 'couple', 'self+user', 'user+self', '两人', '合照', '角色和用户'].includes(key)) return 'both';
  if (['other', 'anonymous', 'npc', '路人', '他人', '其他'].includes(key)) return 'other';
  if (['none', 'no', '无人', '没有'].includes(key)) return 'none';
  return '';
}

/**
 * 相册与聊天生图共用锁脸链路，但相册记录过去没有把结构化人物信号传进去。
 * 新记录优先使用 imagePeople/imageIdentity；旧记录继续按完整文案识别，避免只检查 imagePrompt。
 */
export function resolvePhonePhotoSubjectOptions(record = {}, prompt = '', allowPersonPhoto = true) {
  if (!allowPersonPhoto) {
    return { peopleIntent: 'none', identityLockAllowed: false, portraitStyleAllowed: false };
  }
  const identity = normalizePhotoIdentity(
    record.imageIdentity || record.identity || record.imageSubjectIdentity,
  );
  let peopleIntent = normalizePhotoPeopleIntent(
    record.imagePeople || record.people || record.peopleIntent,
  );
  if (!peopleIntent) {
    const visualText = [
      prompt,
      record.imagePrompt,
      record.title,
      record.caption,
      record.textImageCaption,
    ].filter(Boolean).join(' ');
    if (looksLikePersonPrompt(visualText)) peopleIntent = 'portrait';
  }
  if (identity === 'none') peopleIntent = 'none';
  const preserveIdentity = ['self', 'user', 'both'].includes(identity)
    || (!identity && peopleIntent === 'portrait');
  return {
    ...(peopleIntent ? { peopleIntent } : {}),
    ...(peopleIntent === 'portrait' ? { forcePortrait: true, characterStyleAllowed: true } : {}),
    ...(peopleIntent === 'partial' ? { characterStyleAllowed: true } : {}),
    ...(preserveIdentity ? { preserveIdentity: true } : {}),
    ...((identity === 'other' || identity === 'none') ? { identityLockAllowed: false } : {}),
  };
}

/** 兼容旧记录：旧模型只能写 other，但 prompt 可能已明说画面主体是 user。 */
function legacyPhotoExplicitlyDepictsUser(record = {}, user = null) {
  const text = [record.imagePrompt, record.title, record.caption, record.textImageCaption]
    .map(clean)
    .filter(Boolean)
    .join(' ');
  if (!text) return false;
  if (/(?:portrait|photo|picture|snapshot)\s+of\s+(?:the\s+)?user\b/iu.test(text)) return true;
  if (/(?:^|[\s,.;:()\[\]，。；：（）【】])user\s+(?:standing|sitting|smiling|walking|posing|looking|wearing|sleeping|eating)\b/iu.test(text)) return true;
  if (/用户本人|给用户拍的|用户在(?:镜头|画面|照片|窗边|房间|街上|户外|家里)/u.test(text)) return true;
  const names = [user?.name, user?.nickname, user?.displayName]
    .map(clean)
    .filter((name) => name.length >= 2);
  return names.some((name) => (
    text.includes(`portrait of ${name}`)
    || text.includes(`photo of ${name}`)
    || text.includes(`${name}的单人照`)
    || text.includes(`${name}在画面`)
  ));
}

/** 把相册记录里的画面身份转成真实锁脸主体；拍摄者不参与这个判断。 */
export function resolvePhonePhotoIdentitySubjectIds(record = {}, characterId = '', subjectOptions = {}, context = {}) {
  if (subjectOptions.peopleIntent === 'none') return [];
  const identity = normalizePhotoIdentity(
    record.imageIdentity || record.identity || record.imageSubjectIdentity,
  );
  const cid = clean(characterId);
  if (identity === 'user') return ['user'];
  if (identity === 'both') return ['user', cid].filter(Boolean);
  if (identity === 'self') return cid ? [cid] : [];
  if (identity === 'other') {
    return legacyPhotoExplicitlyDepictsUser(record, context.user) ? ['user'] : [];
  }
  if (identity === 'none') return [];
  if (subjectOptions.identityLockAllowed === false) return [];
  // 旧记录没有 imageIdentity 时沿用历史行为：明确人像默认视为手机主人。
  return subjectOptions.preserveIdentity && cid ? [cid] : [];
}

/** 相册单人 / 多人锁脸的统一入口，供补图与重 roll 共用。 */
export async function applyPhonePhotoIdentityLocks(record = {}, scenePrompt = '', options = {}) {
  const character = options.character || null;
  const characterId = clean(options.characterId || character?.id);
  const subjectOptions = options.subjectOptions || {};
  let user = options.user || null;
  const subjectIds = resolvePhonePhotoIdentitySubjectIds(record, characterId, subjectOptions, { user });
  const repairedLegacyUser = subjectIds.length === 1
    && subjectIds[0] === 'user'
    && normalizePhotoIdentity(record.imageIdentity || record.identity || record.imageSubjectIdentity) === 'other';
  const effectiveSubjectOptions = repairedLegacyUser
    ? { ...subjectOptions, identityLockAllowed: true, preserveIdentity: true, forcePortrait: true }
    : subjectOptions;
  if (subjectIds.includes('user') && !user) {
    user = await getCurrentUser().catch(() => null);
  }

  if (subjectIds.length > 1 && user && character && characterId) {
    const lock = await applyMultiActorImageLocks(subjectIds, scenePrompt, {
      config: options.config,
      user,
      characters: { [characterId]: character },
      allowedIds: new Set(['user', characterId]),
      styleId: clean(options.imageStyleId),
      ...effectiveSubjectOptions,
    }).catch(() => null);
    if (lock) {
      return {
        prompt: lock.prompt || scenePrompt,
        genOptions: { ...lock, ...effectiveSubjectOptions },
        subjectIds,
      };
    }
  }

  let lock = null;
  if (subjectIds.includes('user')) {
    if (subjectIds.length === 1 && user) {
      lock = await applyUserImageLock(user, scenePrompt, {
        config: options.config,
        ...effectiveSubjectOptions,
      }).catch(() => null);
    }
    // 明确拍 user / 两人合照时，user 资料临时不可用也不能退回去套手机主人的脸。
  } else if (character) {
    // self / 旧记录继续走原角色链；other / none 会由 subjectOptions 禁止身份锁定。
    lock = await applyCharacterImageLock(character, scenePrompt, {
      config: options.config,
      ...effectiveSubjectOptions,
    }).catch(() => null);
  }
  return {
    prompt: lock?.prompt || scenePrompt,
    genOptions: mergeImageLockIntoOptions(lock, effectiveSubjectOptions),
    subjectIds,
  };
}

export async function generatePhonePhotoImage(record = {}, options = {}) {
  const item = { ...record };
  const config = options.config || await loadImageToolConfig().catch(() => ({}));
  const scene = options.scene || await resolvePhoneAlbumImageScene(config);
  const genEnabled = !!scene && await isSocialImageGenEnabled(scene, config);
  const textImage = resolveTextImageCaption(item) || buildFallbackCaption(item);
  const existingUrl = clean(item.imageUrl);
  const pendingGeneratedUrl = clean(item.imagePendingUrl);
  const forceReroll = !!options.forceReroll;
  const allowPersonPhoto = options.allowPersonPhoto !== false;
  const allowTextImageFallback = options.allowTextImage !== false;

  if (existingUrl && item.imageKind === 'photo' && !forceReroll) {
    return {
      ...item,
      textImageCaption: textImage,
      imageKind: 'photo',
    };
  }
  if (forceReroll && !genEnabled) {
    throw new Error('当前相册生图未开启或配置不可用（请在 API 管理开启聊天生图或朋友圈生图）');
  }
  // 上一次已经成功生图、只是下载进本地失败时，先重试保存原图，绝不能再请求一次生图扣点。
  if (!forceReroll && pendingGeneratedUrl) {
    try {
      const localUrl = await persistGeneratedImageUrlLocally(pendingGeneratedUrl, {
        signal: options.signal,
        requireLocal: true,
        optimizeForStorage: true,
      });
      return {
        ...item,
        imageUrl: localUrl,
        imagePendingUrl: '',
        imageKind: 'photo',
        imageError: '',
      };
    } catch (error) {
      return {
        ...item,
        imageKind: 'pending',
        imageError: `图片已生成，但保存到本地失败；重试时不会重新扣点：${String(error?.message || error || '').slice(0, 100)}`,
      };
    }
  }

  let prompt = clean(item.imagePrompt);
  if (!prompt && genEnabled) {
    const parts = [item.title, item.caption, item.location].filter(Boolean);
    if (parts.length) prompt = `phone album photo, ${parts.join(', ').slice(0, 140)}`;
  }

  if (genEnabled && prompt) {
    try {
      const styledPrompt = applySceneStyleToPrompt(
        prompt,
        resolveSceneStyleFragment(options.imageStyleId, config),
      );
      const character = (allowPersonPhoto && options.character) ? options.character : null;
      const subjectOptions = resolvePhonePhotoSubjectOptions(item, prompt, allowPersonPhoto);
      const locked = await applyPhonePhotoIdentityLocks(item, styledPrompt, {
        character,
        characterId: options.characterId || character?.id,
        user: options.user,
        config,
        imageStyleId: options.imageStyleId,
        subjectOptions,
      });
      const genPrompt = locked.prompt || styledPrompt;
      const genOptions = { ...locked.genOptions, signal: options.signal };
      const result = await generateImageForScene(genPrompt, scene, genOptions);
      const generatedUrl = clean(result?.url);
      if (generatedUrl) {
        // 相册是长期记录：必须下载并压缩成可备份的本地 data URL，
        // 不能把会过期的中转 URL 当作成功结果写入角色手机。
        let url = '';
        try {
          url = await persistGeneratedImageUrlLocally(generatedUrl, {
            signal: options.signal,
            requireLocal: true,
            optimizeForStorage: true,
          });
        } catch (error) {
          return {
            ...item,
            imageUrl: '',
            imagePendingUrl: generatedUrl,
            imagePrompt: prompt,
            textImageCaption: textImage,
            imageKind: 'pending',
            imageGeneratedAt: Date.now(),
            imageError: `图片已生成，但保存到本地失败；重试时不会重新扣点：${String(error?.message || error || '').slice(0, 100)}`,
          };
        }
        return {
          ...item,
          imageUrl: url,
          imagePendingUrl: '',
          imagePrompt: prompt,
          textImageCaption: textImage,
          imageKind: 'photo',
          imageGeneratedAt: Date.now(),
          imageStyleId: clean(options.imageStyleId) || clean(item.imageStyleId),
          imageError: '',
          rerollCount: forceReroll ? Math.max(0, Number(item.rerollCount || 0)) + 1 : Number(item.rerollCount || 0),
        };
      }
    } catch (error) {
      if (forceReroll) throw error;
      // 批量补图：生图已开启时不再静默降级成文字图（否则点「补生图」像没反应）
      if (genEnabled) {
        return {
          ...item,
          imagePrompt: prompt || item.imagePrompt,
          textImageCaption: textImage,
          imageKind: item.imageKind === 'photo' && existingUrl ? 'photo' : (item.imageKind || 'pending'),
          imageError: String(error?.message || error || '生图失败').slice(0, 160),
        };
      }
    }
    if (forceReroll) {
      throw new Error('生图服务没有返回可用图片');
    }
    if (genEnabled) {
      return {
        ...item,
        imagePrompt: prompt || item.imagePrompt,
        textImageCaption: textImage,
        imageKind: item.imageKind === 'photo' && existingUrl ? 'photo' : (item.imageKind || 'pending'),
        imageError: '生图服务没有返回可用图片',
      };
    }
  }
  if (forceReroll) {
    throw new Error('这条相册记录缺少可用于生图的描述');
  }

  // 仅在明确允许、且生图未开启时，才降级为文字图
  if (!genEnabled && allowTextImageFallback && textImage) {
    return {
      ...item,
      imageUrl: '',
      textImageCaption: textImage,
      imageKind: 'textimg',
    };
  }
  return item;
}

/**
 * 为相册记录批量配图：开生图时直接生真图；未开时可降级文字图；开了但失败则保留待补状态。
 */
export async function applyPhonePhotoImages(records = [], options = {}) {
  const list = Array.isArray(records) ? records.map((r) => ({ ...r })) : [];
  const onlyIds = options.onlyIds ? new Set([...options.onlyIds].map(String)) : null;
  const forceReroll = !!options.forceReroll;
  const max = Math.max(0, Math.min(Number(options.maxImages ?? 12) || 12, 24));
  let generated = 0;
  const config = options.config || await loadImageToolConfig().catch(() => ({}));
  const scene = options.scene || await resolvePhoneAlbumImageScene(config);

  for (let i = 0; i < list.length; i += 1) {
    const rec = list[i];
    if (onlyIds && !onlyIds.has(String(rec.id || ''))) continue;
    if (!forceReroll && !phonePhotoNeedsGeneration(rec)) continue;
    if (!onlyIds && !forceReroll && generated >= max) continue;

    list[i] = await generatePhonePhotoImage(rec, {
      ...options,
      config,
      scene,
      forceReroll,
    });
    generated += 1;
  }
  return list;
}

function mergePhotoRecordsIntoPhone(phone, updatedRecords = []) {
  const map = new Map(updatedRecords.map((r) => [String(r.id || ''), r]));
  return {
    ...phone,
    photoRecords: (phone.photoRecords || []).map((row) => map.get(String(row.id || '')) || row),
  };
}

export async function generatePhonePhotoImagesForPhone({
  userId,
  characterId,
  character,
  user = null,
  recordIds = null,
  forceReroll = false,
  signal = null,
  imageStyleId = '',
  allowPersonPhoto = true,
  allowTextImage = true,
} = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || character?.id || '').trim();
  if (!uid || !cid) throw new Error('缺少用户或角色');

  let phone = await loadCharacterPhone(uid, cid);
  const targets = (phone.photoRecords || []).filter((row) => {
    if (recordIds && recordIds.length) return recordIds.includes(String(row.id || ''));
    return phonePhotoNeedsGeneration(row, { forceReroll });
  });
  if (!targets.length) throw new Error(forceReroll ? '没有可重 roll 的相册图' : '没有待补图的相册记录');

  const config = await loadImageToolConfig().catch(() => ({}));
  const scene = await resolvePhoneAlbumImageScene(config);
  if (!scene && forceReroll) {
    throw new Error('当前相册生图未开启或配置不可用（请在 API 管理开启聊天生图或朋友圈生图）');
  }

  const updated = await applyPhonePhotoImages(phone.photoRecords || [], {
    character,
    characterId: cid,
    user,
    onlyIds: recordIds && recordIds.length ? recordIds : null,
    forceReroll,
    maxImages: recordIds?.length || 24,
    signal,
    config,
    scene,
    imageStyleId,
    allowPersonPhoto,
    allowTextImage,
  });
  const targetIds = new Set(targets.map((row) => String(row.id || '')));
  let photoOk = 0;
  let failed = 0;
  for (const row of updated) {
    if (!targetIds.has(String(row.id || ''))) continue;
    if (row.imageKind === 'photo' && clean(row.imageUrl)) photoOk += 1;
    else if (row.imageError || phonePhotoNeedsGeneration(row)) failed += 1;
  }
  phone = mergePhotoRecordsIntoPhone(phone, updated);
  phone = await saveCharacterPhone(phone);
  return { phone, count: targets.length, generated: targets.length, photoOk, failed, scene };
}
