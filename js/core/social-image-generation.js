import {
  generateImageForScene,
  isNovelAiImageGenerationEnabled,
  isRealisticImageGenerationEnabled,
  loadImageToolConfig,
  looksLikeBodyDetailPrompt,
  looksLikePersonPrompt,
  persistGeneratedImageUrlLocally,
  resolveChatImageGenMode,
} from './image-generation-tools.js';
import { applyCharacterImageLock, mergeImageLockIntoOptions } from './character-image-lock.js';
import { listCharacters } from './character-store.js';
import { getImageStylePreset } from './image-style-presets.js';
import { showToast } from '../components/toast.js';

const SCENE_CHOICES = new Set(['novelai', 'realistic', 'smart']);

const SCENE_USAGE = {
  chatImages: 'chatImages',
  anonymousSpace: 'chatImages',
  momentsImages: 'momentsImages',
  weiboImages: 'weiboImages',
};

function clean(value = '') {
  return String(value ?? '').trim();
}

const EMPTY_IMAGE_PROMPT_RE = /^(?:none|null|nil|n\/?a|no(?:\s+(?:image|prompt))?|not\s+applicable|无|没有|无需|不需要|空|无配图|无图片|无提示词)[.!。！]*$/iu;

/** 模型偶尔把 imageCharacterId 的 none 错填进 imagePrompt；这种占位绝不能发给生图接口。 */
export function normalizeSocialImagePrompt(value = '') {
  const prompt = clean(value);
  return !prompt || EMPTY_IMAGE_PROMPT_RE.test(prompt) ? '' : prompt;
}

export function resolveCharacterSubjectOptions(prompt = '', allowPersonPhoto = true, declaredCharacterSubject = false) {
  if (!allowPersonPhoto) return { peopleIntent: 'none', portraitStyleAllowed: false };
  if (looksLikePersonPrompt(prompt)) {
    return {
      peopleIntent: 'portrait',
      forcePortrait: true,
      preserveIdentity: true,
      characterStyleAllowed: true,
    };
  }
  if (looksLikeBodyDetailPrompt(prompt)) {
    return {
      peopleIntent: 'partial',
      preserveIdentity: true,
      characterStyleAllowed: true,
    };
  }
  if (declaredCharacterSubject) {
    return {
      peopleIntent: 'partial',
      preserveIdentity: true,
      characterStyleAllowed: true,
    };
  }
  return {};
}

function mergeCfg(config = {}) {
  return config && typeof config === 'object' ? config : {};
}

const DEPRECATED_REALISTIC_STYLE_IDS = new Set(['real_mature', 'real_youthful']);

function effectiveRealisticPersonStyleId(cfg = {}) {
  const id = clean(cfg.styles?.realisticPersonStyleId);
  return DEPRECATED_REALISTIC_STYLE_IDS.has(id) ? '' : id;
}

/**
 * 解析某社交场景生图模式（与聊天 gen_image 规则对齐）。
 * 'realistic_person' 表示兼容引擎 + 配了全局人物画风（人物照可露脸，画风可含 2.5D 等）。
 * @returns {'novelai'|'realistic'|'realistic_person'|'smart'|''}
 */
export async function resolveSocialImageGenMode(scene = 'chatImages', config = null) {
  const cfg = mergeCfg(config || await loadImageToolConfig().catch(() => ({})));
  const usageKey = SCENE_USAGE[scene] || SCENE_USAGE.chatImages;
  if (cfg.usage?.[usageKey] !== true) return '';
  const naiOk = isNovelAiImageGenerationEnabled(cfg);
  const realOk = isRealisticImageGenerationEnabled(cfg);
  if (!naiOk && !realOk) return '';
  const sceneKey = scene === 'anonymousSpace' ? 'chatImages' : scene;
  let choice = String(cfg.scenes?.[sceneKey] || cfg.scenes?.chatImages || 'smart').trim();
  if (!SCENE_CHOICES.has(choice)) choice = 'smart';
  if (naiOk && !realOk) return 'novelai';
  if (!naiOk && realOk) choice = 'realistic';
  if (choice === 'realistic'
    && getImageStylePreset(effectiveRealisticPersonStyleId(cfg))?.engine === 'realistic') {
    return 'realistic_person';
  }
  return choice;
}

export async function isSocialImageGenEnabled(scene = 'chatImages', config = null) {
  return !!(await resolveSocialImageGenMode(scene, config));
}

/** 匿名空间沿用聊天生图开关 */
export async function isAnonymousSpaceImageGenEnabled(config = null) {
  return isSocialImageGenEnabled('chatImages', config);
}

/** 匿名场景补充规则：身份安全——人物类配图不许露出可辨认的脸；涉及露脸/亮相时用背影遮挡岔开 */
const ANON_FACE_HIDE_RULE = '【匿名配图 · 不露脸】这是匿名马甲身份，任何人物类配图都必须让人认不出脸——背对镜头、低头、被头发/手/口罩/物件遮挡、大逆光剪影、只拍局部（手部、桌面、脚边、环境）等手法皆可；禁止写清晰正脸、五官细节、"可以露脸""样貌以人设为准"这类措辞。若内容涉及露脸、亮相、自拍正脸，请改成背影/遮挡/局部画面岔开。';

/** 朋友圈 / 微博批次生成共用的配图多选规范化。 */
export function normalizeMomentsImageOptions(imageOptions = {}, genEnabled = false) {
  const allowLifePhoto = !!genEnabled && imageOptions.allowLifePhoto !== false;
  return {
    allowLifePhoto,
    allowPersonPhoto: allowLifePhoto && !!imageOptions.allowPersonPhoto,
    allowTextImage: imageOptions.allowTextImage !== false,
    allowStickers: imageOptions.allowStickers !== false,
  };
}

function usesBatchImageOptions(opts = {}) {
  const surface = String(opts?.surface || '').trim();
  return surface === 'moments' || surface === 'weibo' || opts?.imageOptions != null;
}

function batchSurfaceLabel(surface = '') {
  if (surface === 'weibo') return '微博';
  if (surface === 'moments') return '朋友圈';
  if (surface === 'forum') return '论坛';
  return '社交';
}

/**
 * 供 AI 任务注入：imagePrompt + textImageCaption 写法（与聊天 gen_image 一致）。
 * @param {string} imageGenMode
 * @param {{ anonymize?: boolean, imageOptions?: object, allowStickers?: boolean, surface?: string }} [opts]
 */
export function buildSocialImageGenPromptRules(imageGenMode = '', opts = {}) {
  const anonymize = opts?.anonymize === true;
  const surface = String(opts?.surface || '').trim();
  const imgOpts = usesBatchImageOptions(opts)
    ? normalizeMomentsImageOptions(opts.imageOptions || {}, !!imageGenMode)
    : null;
  const allowStickers = imgOpts
    ? imgOpts.allowStickers
    : opts?.allowStickers !== false;

  const stickerNote = !allowStickers
    ? '本次不要在正文或评论里写 [表情包:名称]。'
    : (allowStickers && !imageGenMode
      ? '正文与评论可自然穿插 [表情包:名称]；无图时尤其可用表情包。'
      : (allowStickers && imageGenMode ? '正文与评论也可穿插 [表情包:名称]，与配图不冲突。' : ''));

  const captionRule = 'textImageCaption：多行中文；第一行短标题，后面 2-4 行描述**具体可见画面**（物体、场景、颜色、构图、光线、时间线索），像在描述一张照片；必须与该条正文同一瞬间；禁止只写「氛围感」「深夜」「迷茫」等抽象词。';
  const imageSubjectRule = '有 imagePrompt 时必须填写 imageCharacterId：图中是角色池成员就写该角色真实 id，即使发帖者是营销号、粉丝、官号或其他人；无人、物件、风景或非角色人物写 none。它描述图中主体，不是作者。';

  if (imgOpts) {
    const parts = [`【配图 · ${batchSurfaceLabel(surface)}】多数 wantsImage:false，纯文字完全正常；约两三成 wantsImage:true 即可。`];
    const modes = [];
    if (imgOpts.allowLifePhoto) {
      modes.push(imgOpts.allowPersonPhoto
        ? '生活照/人物照生图（imagePrompt + textImageCaption 兜底）'
        : '生活照生图（风景/食物/宠物/物件等，imagePrompt + textImageCaption 兜底）');
    }
    if (imgOpts.allowTextImage) {
      modes.push('文字图（只写 textImageCaption，不写 imagePrompt）');
    }
    if (modes.length) parts.push(`本次允许的配图形式（可混用）：${modes.join('；')}。`);
    else parts.push('本次不要配图：全部 wantsImage:false。');
    if (imgOpts.allowLifePhoto && !imgOpts.allowPersonPhoto) {
      parts.push('未勾选人物时，imagePrompt 不要写 selfie/portrait/正脸人物。');
    }
    if (imgOpts.allowLifePhoto) parts.push(imageSubjectRule);
    parts.push(captionRule);
    if (stickerNote) parts.push(stickerNote);
    if (anonymize) parts.push(ANON_FACE_HIDE_RULE);
    return parts.filter(Boolean).join('\n');
  }

  const visualStyle = String(opts?.visualStyle || '').trim() || (imageGenMode ? 'lifestyle' : 'textimg');

  if (visualStyle === 'none') {
    return [
      '【配图】本次全部 wantsImage:false，不要写 imagePrompt / textImageCaption；纯文字动态即可。',
      stickerNote,
    ].filter(Boolean).join('\n');
  }

  if (visualStyle === 'textimg') {
    return [
      '【配图】本次不调生图 API：约两三成 wantsImage:true，只写 textImageCaption（作文字图），不要写 imagePrompt。',
      captionRule,
      stickerNote,
      anonymize ? ANON_FACE_HIDE_RULE : '',
    ].filter(Boolean).join('\n');
  }

  if (!imageGenMode) {
    return [
      '【配图】当前未开启生图 API：约两三成 wantsImage:true，只写 textImageCaption（作文字图），不要写 imagePrompt。',
      captionRule,
      stickerNote,
      anonymize ? ANON_FACE_HIDE_RULE : '',
    ].filter(Boolean).join('\n');
  }

  const selfieMode = visualStyle === 'selfie';
  const head = selfieMode
    ? '【配图 · 生图已开 · 可含人物】约两三成 wantsImage:true；人物照与生活证据图可混排，须同时写 textImageCaption 作失败兜底。'
    : '【配图 · 生图已开】约两三成 wantsImage:true；须同时写 textImageCaption。';
  const cameraRule = '拍照铁律：自拍/第一人称拍照时，拍照的手机绝不入镜——不要写 holding phone / phone in hand（对镜自拍写 mirror selfie 除外）。';

  if (imageGenMode === 'novelai') {
    return [
      head,
      selfieMode
        ? `- imagePrompt：人物/自拍用英文 Danbooru 标签；生活证据用英文 Danbooru 或场景 tag。${cameraRule}`
        : `- imagePrompt：生活证据英文 Danbooru 或场景 tag。${cameraRule}`,
      `- ${imageSubjectRule}`,
      `- ${captionRule}`,
      stickerNote,
      anonymize ? `- ${ANON_FACE_HIDE_RULE}` : '',
    ].filter(Boolean).join('\n');
  }
  if (imageGenMode === 'smart') {
    return [
      head,
      selfieMode
        ? `- imagePrompt：人物/自拍用英文 Danbooru 标签；生活证据用英文写实自然语言。${cameraRule}`
        : `- imagePrompt：英文写实自然语言写生活证据。${cameraRule}`,
      `- ${imageSubjectRule}`,
      `- ${captionRule}`,
      stickerNote,
      anonymize ? `- ${ANON_FACE_HIDE_RULE}` : '',
    ].filter(Boolean).join('\n');
  }
  if (imageGenMode === 'realistic_person') {
    return [
      head,
      selfieMode
        ? `- imagePrompt：人物照/自拍用英文自然语言；生活证据图用英文写实自然语言。${cameraRule}`
        : `- imagePrompt：英文写实自然语言写生活证据图。${cameraRule}`,
      `- ${imageSubjectRule}`,
      `- ${captionRule}`,
      stickerNote,
      anonymize ? `- ${ANON_FACE_HIDE_RULE}` : '',
    ].filter(Boolean).join('\n');
  }
  return [
    head,
    `- imagePrompt：英文写实自然语言写具体物件/场景/构图/光线。${cameraRule}`,
    `- ${imageSubjectRule}`,
    `- ${captionRule}`,
    stickerNote,
    anonymize ? `- ${ANON_FACE_HIDE_RULE}` : '',
  ].filter(Boolean).join('\n');
}

/** 兼容旧聊天解析入口 */
export function resolveChatImageGenModeForPrompt(config = {}) {
  return resolveChatImageGenMode(config);
}

export function resolveTextImageCaption(item = {}) {
  const raw = clean(item.textImageCaption || item.textImage || item.text_image);
  if (raw) return raw.slice(0, 480);
  return buildFallbackTextImageCaption(item);
}

export function buildFallbackTextImageCaption(item = {}) {
  const text = clean(item.text || item.content);
  const prompt = normalizeSocialImagePrompt(item.imagePrompt);
  const title = clean(item.mood || item.tag) || (text ? text.slice(0, 12) : '配图');
  const lines = [];
  if (prompt) {
    lines.push(`画面：${prompt.slice(0, 100)}`);
  }
  if (text) {
    lines.push(`动态：${text.slice(0, 80)}`);
  }
  if (!lines.length) lines.push('一张与说说相关的生活照片。');
  return `${title}\n${lines.join('\n')}`;
}

/** 匿名场景生图强制追加：不管 AI 写没写到位，兜底不出现可辨认正脸 */
const ANON_IMAGE_PROMPT_SUFFIX = ', face not clearly visible, face turned away or hidden by hair/hand/object/shadow, anonymous, unidentifiable person';

function clampAnonymizePrompt(prompt = '') {
  const p = clean(prompt);
  if (!p) return p;
  return `${p}${ANON_IMAGE_PROMPT_SUFFIX}`;
}

/** 供匿名场景其它生图入口（如单条重roll）复用同一条不露脸兜底后缀 */
export function anonymizeImagePrompt(prompt = '') {
  return clampAnonymizePrompt(prompt);
}

/**
 * 场景滤镜（image-style-presets.js 的 SCENE_STYLE_PRESETS，跟旅行char/线下场景共用同一份表）：
 * 每次生成可传 imageStyleId 单独指定（朋友圈生成前弹窗可选），不传则退回 API 管理页里配的全局默认。
 */
export function resolveSceneStyleFragment(imageStyleId = '', config = {}) {
  const id = clean(imageStyleId) || clean(config?.styles?.sceneStyleId);
  if (!id) return '';
  return getImageStylePreset(id)?.prompt || '';
}

export function applySceneStyleToPrompt(prompt = '', styleFragment = '') {
  const base = clean(prompt);
  if (!base || !styleFragment) return base;
  return `${base}\nStyle direction: ${styleFragment}.`;
}

function itemWantsVisual(item = {}) {
  if (item.wantsImage === false) return false;
  return item.wantsImage === true
    || !!normalizeSocialImagePrompt(item.imagePrompt)
    || !!clean(item.textImageCaption || item.textImage)
    || !!clean(item.image)
    || (Array.isArray(item.images) && item.images.length > 0);
}

/**
 * 为社交动态批量配图：优先真图，失败或未开生图时用 textImageCaption。
 * @param {object[]} items
 * @param {object} options
 * @param {string} options.scene - chatImages | momentsImages | weiboImages
 * @param {number} options.maxImages
 * @param {'image'|'images'} options.imageField - 匿名空间用 image，朋友圈/微博用 images
 */
function matchCharacterByAuthor(characters = [], authorId = '', authorName = '') {
  let hit = authorId ? characters.find((c) => c.id === authorId) : null;
  if (!hit && authorName) {
    hit = characters.find((c) => c.name === authorName
      || c.realName === authorName
      || c.customNickname === authorName
      || (c.aliases || []).includes(authorName));
  }
  return hit || null;
}

function characterSubjectLabels(character = {}) {
  return [
    character.id,
    character.name,
    character.realName,
    character.customNickname,
    ...(Array.isArray(character.aliases) ? character.aliases : []),
  ].map(clean).filter((value, index, list) => (
    value
    && list.indexOf(value) === index
    && (value.length >= 2 || /^[a-z0-9_-]{3,}$/i.test(value))
  ));
}

/**
 * 解析一张社交配图真正描绘的角色。显式 imageCharacterId/name 优先；角色本人发帖沿用作者；
 * 营销号、粉丝、官号等非角色作者则从 imagePrompt、正文与标签里回溯唯一角色。
 */
export function resolveImageSubjectCharacter(characters = [], item = {}) {
  const rows = Array.isArray(characters) ? characters : [];
  const explicitId = clean(
    item.imageCharacterId
    || item.imageSubjectId
    || item.depictedCharacterId
    || item.subjectCharacterId,
  );
  const explicitName = clean(
    item.imageCharacterName
    || item.imageSubjectName
    || item.depictedCharacterName
    || item.subjectCharacterName,
  );
  if (/^(none|other|npc|anonymous|无|他人|路人)$/i.test(explicitId || explicitName)) return null;
  const explicit = matchCharacterByAuthor(rows, explicitId, explicitName);
  if (explicit) return explicit;

  const author = matchCharacterByAuthor(
    rows,
    clean(item.authorId || item.author),
    clean(item.authorName || item.author),
  );
  if (author) return author;

  const imageText = normalizeSocialImagePrompt(item.imagePrompt).toLowerCase();
  const postText = [
    item.content,
    item.text,
    ...(Array.isArray(item.tags) ? item.tags : []),
    item.repostComment,
    item.repostFromAuthorName,
  ].map(clean).filter(Boolean).join(' ').toLowerCase();
  const scored = rows.map((character) => {
    let score = 0;
    for (const label of characterSubjectLabels(character)) {
      const token = label.toLowerCase();
      if (imageText.includes(token)) score = Math.max(score, 1000 + token.length);
      if (postText.includes(token)) score = Math.max(score, 100 + token.length);
    }
    return { character, score };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].character;
}

function itemDeclaresImageCharacter(item = {}, character = null) {
  if (!character) return false;
  const explicit = clean(
    item.imageCharacterId
    || item.imageSubjectId
    || item.depictedCharacterId
    || item.subjectCharacterId
    || item.imageCharacterName
    || item.imageSubjectName
    || item.depictedCharacterName
    || item.subjectCharacterName,
  );
  if (explicit) return !/^(none|other|npc|anonymous|无|他人|路人)$/i.test(explicit);
  return !matchCharacterByAuthor(
    [character],
    clean(item.authorId || item.author),
    clean(item.authorName || item.author),
  );
}

/** 按图中主体找角色，用于把该角色的锁脸与人物画风应用到营销号/粉丝等第三方帖子。 */
function createAuthorCharacterResolver() {
  let charactersPromise = null;
  return async function resolveAuthorCharacter(item = {}) {
    if (!charactersPromise) charactersPromise = listCharacters({ excludeAnonNpc: true }).catch(() => []);
    const characters = await charactersPromise;
    return resolveImageSubjectCharacter(characters, item);
  };
}

/** 单条动态手动重新生成配图用（朋友圈/微博卡片「生成配图」「重 roll」入口），不走批量记忆化 */
async function resolveCharacterForImageSubject(item = {}) {
  const characters = await listCharacters({ excludeAnonNpc: true }).catch(() => []);
  return resolveImageSubjectCharacter(characters, item);
}

/**
 * 单条动态手动重新生成配图：忽略已有 image，强制重新调一次生图 API。
 * 用于失败态兜底「生成配图」按钮，以及已有配图的「重 roll」。
 * @param {object} item - 需要有 imagePrompt（无则报错，因为没有可用的画面描述）
 * @param {{ scene?: string, anonymize?: boolean, allowPersonPhoto?: boolean, config?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<string>} 新图片 URL（已持久化到本地）
 */
export async function regenerateSocialPostImage(item = {}, options = {}) {
  const scene = options.scene || 'momentsImages';
  const anonymize = options.anonymize === true;
  const prompt = normalizeSocialImagePrompt(item.imagePrompt);
  if (!prompt) throw new Error('这条动态没有配图描述，无法生成');
  const genEnabled = await isSocialImageGenEnabled(scene, options.config);
  if (!genEnabled) throw new Error('生图未开启，请先在 API 管理里开启对应生图场景');
  const allowPersonPhoto = options.allowPersonPhoto !== false;
  const character = (anonymize || !allowPersonPhoto)
    ? null
    : await resolveCharacterForImageSubject(item);
  const styledPrompt = applySceneStyleToPrompt(prompt, resolveSceneStyleFragment(options.imageStyleId, options.config));
  const subjectOptions = resolveCharacterSubjectOptions(
    prompt,
    allowPersonPhoto && !anonymize,
    itemDeclaresImageCharacter(item, character),
  );
  const lock = character
    ? await applyCharacterImageLock(character, styledPrompt, {
      config: options.config,
      ...subjectOptions,
    }).catch(() => null)
    : null;
  const genPrompt = anonymize ? clampAnonymizePrompt(lock?.prompt || styledPrompt) : (lock?.prompt || styledPrompt);
  const genOptions = mergeImageLockIntoOptions(lock, {
    signal: options.signal,
    ...subjectOptions,
  });
  const result = await generateImageForScene(genPrompt, scene, genOptions);
  if (result?.referenceSkipped) {
    showToast('参考图锁定未生效，已改用文字外观生成', 5000);
  }
  const rawUrl = clean(result?.url);
  if (!rawUrl) throw new Error('生图失败，请重试');
  // 社交动态会长期落库，不能把短时效远程 URL 当成功结果保存；本地化失败就明确失败，
  // 由 UI 保留 imagePrompt 供用户重 roll，而不是过一会儿变成「图片已失效」。
  return persistGeneratedImageUrlLocally(rawUrl, {
    signal: options.signal,
    requireLocal: true,
  });
}

export async function applySocialPostImages(items = [], options = {}) {
  const scene = options.scene || 'chatImages';
  const imageField = options.imageField === 'image' ? 'image' : 'images';
  const max = Math.max(0, Math.min(Number(options.maxImages ?? 2) || 2, 6));
  const anonymize = options.anonymize === true;
  const genEnabledRaw = await isSocialImageGenEnabled(scene, options.config);
  const useBatchOpts = scene === 'momentsImages'
    || (options.imageOptions != null && typeof options.imageOptions === 'object'
      && options.imageOptions.visualStyle == null);
  const imgOpts = useBatchOpts
    ? normalizeMomentsImageOptions(options.imageOptions || {}, genEnabledRaw)
    : null;
  const visualStyle = String(options.imageOptions?.visualStyle || '').trim();
  const genEnabled = imgOpts
    ? imgOpts.allowLifePhoto
    : genEnabledRaw && visualStyle !== 'none' && visualStyle !== 'textimg';
  const canTextImg = imgOpts ? imgOpts.allowTextImage : visualStyle !== 'none';
  const allowPersonPhoto = imgOpts ? imgOpts.allowPersonPhoto : visualStyle === 'selfie';
  const list = Array.isArray(items) ? items.map((p) => ({ ...p })) : [];
  const resolveAuthorCharacter = createAuthorCharacterResolver();
  const configForStyle = options.config || await loadImageToolConfig().catch(() => ({}));
  const sceneStyleFragment = resolveSceneStyleFragment(options.imageOptions?.imageStyleId, configForStyle);
  let generated = 0;

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (imgOpts && !imgOpts.allowLifePhoto && !imgOpts.allowTextImage) {
      list[i] = {
        ...item,
        wantsImage: false,
        imagePrompt: '',
        textImage: '',
        textImageCaption: '',
        imageKind: undefined,
        imageLoading: false,
        images: undefined,
        image: undefined,
      };
      continue;
    }
    if (!imgOpts && visualStyle === 'none') {
      list[i] = {
        ...item,
        wantsImage: false,
        imagePrompt: '',
        textImage: '',
        textImageCaption: '',
        imageKind: undefined,
        imageLoading: false,
        images: undefined,
        image: undefined,
      };
      continue;
    }
    if (!itemWantsVisual(item)) continue;

    const textImage = resolveTextImageCaption(item);
    const existingImage = clean(item.image)
      || (Array.isArray(item.images) ? clean(item.images[0]) : '');

    if (existingImage) {
      list[i] = {
        ...item,
        textImage,
        imageKind: 'photo',
        imageLoading: false,
        ...(imageField === 'image' ? { image: existingImage } : { images: [existingImage] }),
      };
      continue;
    }

    let prompt = normalizeSocialImagePrompt(item.imagePrompt);
    const bodyText = clean(item.text || item.content);
    const textimgOnly = imgOpts
      ? (!imgOpts.allowLifePhoto && imgOpts.allowTextImage)
      : visualStyle === 'textimg';
    if (textimgOnly) {
      prompt = '';
    } else if (!allowPersonPhoto && prompt && looksLikePersonPrompt(prompt)) {
      prompt = '';
    }

    if (genEnabled && prompt && generated < max) {
      try {
        const styledPrompt = applySceneStyleToPrompt(prompt, sceneStyleFragment);
        const character = (anonymize || !allowPersonPhoto)
          ? null
          : await resolveAuthorCharacter(item);
        const subjectOptions = resolveCharacterSubjectOptions(
          prompt,
          allowPersonPhoto && !anonymize,
          itemDeclaresImageCharacter(item, character),
        );
        const lock = character
          ? await applyCharacterImageLock(character, styledPrompt, {
            config: options.config,
            ...subjectOptions,
          }).catch(() => null)
          : null;
        const genPrompt = anonymize ? clampAnonymizePrompt(lock?.prompt || styledPrompt) : (lock?.prompt || styledPrompt);
        const genOptions = mergeImageLockIntoOptions(lock, {
          signal: options.signal,
          ...subjectOptions,
        });
        const result = await generateImageForScene(genPrompt, scene, genOptions);
        if (result?.referenceSkipped) {
          showToast('参考图锁定未生效，已改用文字外观生成', 5000);
        }
        let url = clean(result?.url);
        if (url) {
          url = await persistGeneratedImageUrlLocally(url, {
            signal: options.signal,
            requireLocal: true,
          });
          list[i] = {
            ...item,
            imagePrompt: prompt,
            textImage,
            imageKind: 'photo',
            imageLoading: false,
            ...(imageField === 'image' ? { image: url } : { images: [url] }),
          };
          generated += 1;
          continue;
        }
      } catch (_) { /* fallback textimg */ }
    }

    if (textImage && canTextImg) {
      list[i] = {
        ...item,
        textImage,
        imageKind: 'textimg',
        imageLoading: false,
      };
    } else {
      list[i] = { ...item, imageLoading: false, wantsImage: false };
    }
  }
  return list;
}
