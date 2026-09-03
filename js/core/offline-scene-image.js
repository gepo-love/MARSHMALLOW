/**
 * 线下场景生图：约会探索（offline-session）用的手动/可选自动生图入口。
 * 复用 image-generation-tools.js 的 generateImageForScene（按 scene 配置智能选引擎）
 * + character-image-lock.js 的角色锁脸，风格模板参考 travel-char.js 的 TRAVEL_POSTCARD_STYLES 写法。
 */
import {
  generateImageForScene,
  isNovelAiImageGenerationEnabled,
  isRealisticImageGenerationEnabled,
  loadImageToolConfig,
  normalizeImageAspect,
  persistGeneratedImageUrlLocally,
  resolveImageProviderForScene,
  scrubNovelAiPromptCharset,
} from './image-generation-tools.js';
import { mergeImageLockIntoOptions } from './character-image-lock.js';
import { applyMultiActorImageLocks } from './multi-actor-image-lock.js';
import {
  OFFLINE_SCENE_STYLES,
  DEFAULT_OFFLINE_SCENE_STYLE_ID,
  normalizeOfflineSceneImageGenMode,
} from './offline-scene-image-config.js';

export {
  OFFLINE_SCENE_STYLES,
  DEFAULT_OFFLINE_SCENE_STYLE_ID,
  normalizeOfflineSceneImageGenMode,
} from './offline-scene-image-config.js';

export const OFFLINE_SCENE_IMAGE_SCENE_KEY = 'offlineScene';

// 线下场景的「画风」原来只有 4 款写死的基础滤镜，和旅行char/通讯录头像那边共用的
// image-style-presets.js 场景滤镜库（清透日常/INS胶片/青春电影感/梦核/复古胶片/
// 治愈插画/水彩速写/纯写实）是两套重复维护的东西——统一改成读同一份表，全站滤镜选项对齐。
export function resolveOfflineSceneStyleFragment(styleId = '', imageGenMode = '') {
  const style = OFFLINE_SCENE_STYLES[styleId] || OFFLINE_SCENE_STYLES[DEFAULT_OFFLINE_SCENE_STYLE_ID];
  if (normalizeOfflineSceneImageGenMode(imageGenMode) === 'novelai') {
    return style.novelAiPromptFragment || '';
  }
  return style.promptFragment;
}

function sceneSettingLine(scene = {}) {
  return [scene.place, scene.weather, scene.tone].filter(Boolean).join('，');
}

/**
 * 拼场景生图 prompt：
 * - promptOverride（单次手动指定）优先级最高，直接整段替换。
 * - 否则以「画风」+「固定风格/主体备注」(scene.imagePromptTemplate，每轮都带上，不会被替换) 为骨架，
 *   画面内容用 aiPrompt（本轮由模型跟正文一起产出的场景描述，更贴合实际剧情）；
 *   没有 aiPrompt 时才退回旧逻辑——摘取本轮旁白文本前 200 字当画面线索。
 */
// 没选具体滤镜（styleId=none）时也不能让画面没有任何画质基调兜底，否则容易灰扑扑、发灰发闷；
// 借用 image-style-presets.js「清透日常」的措辞，保证至少是一张干净、有对比、色彩正常的照片。
const DEFAULT_PHOTO_QUALITY_GUARD = 'Photo quality baseline (applies unless a specific art style overrides it): crisp clear focus, true-to-life saturated colors (not washed out, hazy, or dull gray), natural balanced lighting with real contrast and shadow — the kind of clean well-exposed shot you would want to keep, never a flat lifeless snapshot.';
const NOVELAI_SCENE_QUALITY_TAGS = 'atmospheric scene, detailed background, cinematic composition, expressive body language, face out of frame';

function buildNovelAiOfflineScenePrompt({
  scene = {},
  styleId = '',
  aiPrompt = '',
  beatText = '',
  subjectCount = 2,
} = {}) {
  const count = Number.isFinite(Number(subjectCount))
    ? Math.max(0, Math.trunc(Number(subjectCount)))
    : 1;
  const subjectTags = count === 0 ? 'no humans, scenery' : `${count}people`;
  const styleTags = resolveOfflineSceneStyleFragment(styleId, 'novelai');
  const anchor = scrubNovelAiPromptCharset(scene.imagePromptTemplate || '');
  const setting = scrubNovelAiPromptCharset(sceneSettingLine(scene));
  const moment = scrubNovelAiPromptCharset(
    String(aiPrompt || '').trim() || String(beatText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  );
  return [subjectTags, styleTags, anchor, setting, moment, NOVELAI_SCENE_QUALITY_TAGS]
    .filter(Boolean)
    .join(', ');
}

export function buildOfflineScenePrompt({
  scene = {},
  beatText = '',
  styleId = '',
  promptOverride = '',
  aiPrompt = '',
  subjectCount = 2,
  includeUser = true,
  imageGenMode = '',
} = {}) {
  const override = String(promptOverride || '').trim();
  if (override) return override;
  if (normalizeOfflineSceneImageGenMode(imageGenMode) === 'novelai') {
    return buildNovelAiOfflineScenePrompt({ scene, styleId, aiPrompt, beatText, subjectCount });
  }
  const setting = sceneSettingLine(scene);
  const anchor = String(scene.imagePromptTemplate || '').trim();
  const styleFragment = resolveOfflineSceneStyleFragment(styleId);
  const moment = String(aiPrompt || '').trim() || String(beatText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  // 媒介由场景滤镜、角色画风或用户自定义外观决定。这里保持中性，避免未选插画时
  // 仍用 illustration 把兼容生图（尤其「自定义」真人关键词）拉回 2.5D / 数字绘画。
  const numericSubjectCount = Number(subjectCount);
  const normalizedSubjectCount = Number.isFinite(numericSubjectCount)
    ? Math.max(0, Math.trunc(numericSubjectCount))
    : 1;
  const peopleLine = normalizedSubjectCount === 0
    ? 'A single atmospheric scene image focused on the environment and objects, with no people in frame.'
    : normalizedSubjectCount > 2
    ? `A single atmospheric scene image capturing one shared moment among ${normalizedSubjectCount} people.`
    : (normalizedSubjectCount === 2
      ? 'A single atmospheric scene image capturing one quiet moment between two people.'
      : 'A single atmospheric scene image capturing one quiet moment with one person.');
  const continuityLine = includeUser
    ? 'Visual continuity: keep every recurring person as the same identity across scenes; preserve established hair, body proportions, clothing and accessories unless the story explicitly changes them; never swap the user and character.'
    : 'Visual continuity: keep every recurring character as the same identity across scenes; preserve established hair, body proportions, clothing and accessories unless the story explicitly changes them; show only the selected character cast and do not introduce a user, player, camera operator, director, or extra person.';
  return [
    peopleLine,
    styleFragment ? `Art direction: ${styleFragment}.` : DEFAULT_PHOTO_QUALITY_GUARD,
    anchor ? `Fixed style / subject notes (apply to every image in this scene): ${anchor}.` : '',
    setting ? `Setting: ${setting}.` : '',
    moment ? `Moment to depict: ${moment}` : '',
    continuityLine,
    'Focus on atmosphere, environment, framing, and small expressive details; avoid a tight clear face close-up.',
    'No readable text, no Chinese characters overlay, no UI screenshot, no watermark, no logo.',
  ].filter(Boolean).join('\n');
}

export const SCENE_IMAGE_DIRECTIVE_START = '<<<SCENE_IMAGE>>>';
export const SCENE_IMAGE_DIRECTIVE_END = '<<<END_SCENE_IMAGE>>>';

/**
 * 追加到叙事 prompt 末尾的指令：让模型在正文（及走向选项，若有）写完后，
 * 额外用一段英文给出「本轮最适合配图的一个画面瞬间」，比事后从中文旁白里截字符串拼英文模板更贴合实际内容。
 */
export function sceneImageDirectiveInstruction({
  styleId = '',
  anchor = '',
  includeUser = true,
  availableSubjects = [],
  imageGenMode = '',
} = {}) {
  const novelAiMode = normalizeOfflineSceneImageGenMode(imageGenMode) === 'novelai';
  const styleFragment = resolveOfflineSceneStyleFragment(styleId, imageGenMode);
  const styleNote = [styleFragment, String(anchor || '').trim()].filter(Boolean).join('; ');
  const subjectDirectory = (Array.isArray(availableSubjects) ? availableSubjects : [])
    .map((row) => {
      const id = String(row?.id || '').trim();
      const name = String(row?.name || row?.label || '').trim();
      return id ? `${id}=${name || id}` : '';
    })
    .filter(Boolean)
    .join('，');
  const subjectInstruction = subjectDirectory
    ? `块内第一行必须写 SUBJECT_IDS: 并只列出这个具体画面中实际可见的人物 id（可选范围：${subjectDirectory}）；不要把整场参与名单全抄进去。无人入镜就写 SUBJECT_IDS: none。第二行起再写英文画面描述。`
    : '';
  return [
    `正文（以及走向选项，如果要求了的话）写完后，另起一行输出 ${SCENE_IMAGE_DIRECTIVE_START}。${subjectInstruction}${novelAiMode ? '只用英文 Danbooru 标签并用半角逗号分隔' : '用一段英文自然语言'}描述本轮最适合配图的一个具体画面瞬间——构图、环境、光线、氛围、动作，不写清晰正脸/五官特写；同一人物必须延续前幕身份、发型、体型、服装与配饰，${includeUser ? '禁止把用户和角色的外观互换' : '画面只允许出现所选角色，禁止加入用户、玩家、导演或额外人物'}；未在档案或前幕确定的五官细节不要擅自固定。${styleNote ? `画风倾向：${styleNote}；` : ''}不要出现可读文字、水印、UI；写完另起一行输出 ${SCENE_IMAGE_DIRECTIVE_END}。`,
    `${SCENE_IMAGE_DIRECTIVE_START} 块只用于生图，不算正文的一部分，正文里不要提前描述"配图"或提到这个标记。`,
  ].join('\n');
}

/** 从模型原始回复里取出场景生图指令块，返回去掉该块之后的正文。 */
export function extractSceneImageDirective(raw = '') {
  const text = String(raw || '');
  const si = text.indexOf(SCENE_IMAGE_DIRECTIVE_START);
  if (si === -1) return { body: text, imagePrompt: '', imageSubjectIds: null };
  const body = text.slice(0, si);
  let rest = text.slice(si + SCENE_IMAGE_DIRECTIVE_START.length);
  const ei = rest.indexOf(SCENE_IMAGE_DIRECTIVE_END);
  if (ei !== -1) rest = rest.slice(0, ei);
  const subjectLine = rest.match(/^\s*SUBJECT_IDS\s*:\s*([^\r\n]*)/iu);
  let imageSubjectIds = null;
  if (subjectLine) {
    const rawIds = String(subjectLine[1] || '').trim();
    imageSubjectIds = /^(?:none|无|无人)$/iu.test(rawIds)
      ? []
      : rawIds
        .replace(/[\[\]"'`]/gu, '')
        .split(/[,，;；\s]+/u)
        .map((id) => id.trim())
        .filter(Boolean);
    rest = rest.slice(subjectLine[0].length);
  }
  const imagePrompt = rest.replace(/^\s*(?:PROMPT\s*:\s*)?/iu, '').replace(/\s+/g, ' ').trim();
  return { body: body.trim(), imagePrompt, imageSubjectIds };
}

/** 流式显示时，截掉场景生图指令标记及之后内容，只显示正文部分。 */
export function stripSceneImageDirectiveTail(raw = '') {
  const text = String(raw || '');
  const si = text.indexOf(SCENE_IMAGE_DIRECTIVE_START);
  return si === -1 ? text : text.slice(0, si);
}

/**
 * 实际调用生图：角色在场时套锁脸，失败静默返回 error 字段，不抛出——调用方按 image 是否为空判断成败。
 * 氛围图保留环境构图（peopleIntent=partial），但角色在场时继续保留身份与人物媒介画风；
 * 指定引擎失败时再试另一引擎（测试生图走兼容、线下若绑了 NovelAI 会表现为「测试可以线下不行」）。
 */
export async function maybeGenerateOfflineSceneImage({
  prompt,
  novelAiPrompt = '',
  characterId = '',
  subjectIds = [],
  user = null,
  imageGenMode = '',
  aspect = '',
  signal,
} = {}) {
  const trimmed = String(prompt || '').trim();
  const naiTrimmed = String(novelAiPrompt || '').trim() || trimmed;
  if (!trimmed) return { image: '', prompt: '', error: '缺少生图提示词' };
  let submittedPrompt = trimmed;
  try {
    const normalizedMode = normalizeOfflineSceneImageGenMode(imageGenMode);
    const loadedConfig = await loadImageToolConfig().catch(() => ({}));
    const effectiveConfig = normalizedMode
      ? {
        ...loadedConfig,
        scenes: {
          ...(loadedConfig.scenes || {}),
          [OFFLINE_SCENE_IMAGE_SCENE_KEY]: normalizedMode,
        },
      }
      : loadedConfig;
    const routedProvider = normalizedMode === 'novelai' || normalizedMode === 'realistic'
      ? normalizedMode
      : resolveImageProviderForScene(OFFLINE_SCENE_IMAGE_SCENE_KEY, effectiveConfig, trimmed, {
        portraitStyleAllowed: false,
        peopleIntent: 'partial',
      });
    if (routedProvider === 'novelai') submittedPrompt = naiTrimmed;
    const ids = (Array.isArray(subjectIds) ? subjectIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    if (!ids.length && String(characterId || '').trim()) ids.push(String(characterId || '').trim());
    const prepareLock = async (basePrompt) => {
      if (!ids.length) return null;
      try {
        return await applyMultiActorImageLocks(ids, basePrompt, {
          user,
          signal,
          config: effectiveConfig,
          styleEngineOverride: false,
          portraitStyleAllowed: false,
          peopleIntent: 'partial',
          preserveIdentity: true,
          characterStyleAllowed: true,
        });
      } catch (lockError) {
        const wrapped = new Error(`人物锁定准备失败：${String(lockError?.message || lockError || '').slice(0, 120)}`);
        wrapped.code = 'OFFLINE_IMAGE_LOCK_PREPARE';
        throw wrapped;
      }
    };
    let lock = await prepareLock(submittedPrompt);
    // 跟随全局设置时，角色 seed / NAI 画风可能在锁定阶段把最终引擎切到 NAI；
    // 这时重新用 NAI 标签版准备一次，不能把先前的兼容摄影模板继续带过去。
    if (!normalizedMode && lock?.providerOverride === 'novelai' && submittedPrompt !== naiTrimmed) {
      submittedPrompt = naiTrimmed;
      lock = await prepareLock(submittedPrompt);
    }
    const genPrompt = lock?.prompt || submittedPrompt;
    // 线下场景保持环境构图，不套正脸人像模板；角色的媒介画风仍可生效。
    const genOptions = mergeImageLockIntoOptions(lock, {
      ...(signal ? { signal } : {}),
      config: effectiveConfig,
      portraitStyleAllowed: false,
      peopleIntent: 'partial',
      preserveIdentity: true,
      characterStyleAllowed: true,
      ...(normalizeImageAspect(aspect) ? { aspect: normalizeImageAspect(aspect) } : {}),
    });
    if (lock?.referenceSubjects?.length) genOptions.referenceSubjects = lock.referenceSubjects;
    if (lock?.subjectIds?.length) genOptions.subjectIds = lock.subjectIds;
    // 本场显式选择优先于角色锁脸里可能携带的引擎建议；智能模式重新交给场景路由判断。
    if (normalizedMode === 'novelai' || normalizedMode === 'realistic') {
      genOptions.providerOverride = normalizedMode;
    } else if (normalizedMode === 'smart') {
      delete genOptions.providerOverride;
    }
    const result = await generateImageForScene(genPrompt, OFFLINE_SCENE_IMAGE_SCENE_KEY, genOptions);
    let url = String(result?.url || '').trim();
    if (!url) throw new Error('没有生成图片地址');
    // NAI 常返回体积很大的 PNG/data URL。线下会话会整份重写到 IndexedDB，
    // 必须先压缩为备份安全大小；否则图片写库失败时会连带让本轮正文看起来消失。
    url = await persistGeneratedImageUrlLocally(url, {
      ...(signal ? { signal } : {}),
      optimizeForStorage: true,
      requireLocal: true,
    });
    return {
      image: url,
      prompt: submittedPrompt,
      error: '',
      provider: String(result?.provider || ''),
      referenceSkipped: result?.referenceSkipped === true,
      referenceError: String(result?.referenceError || ''),
      referenceSubmittedCount: Number(result?.referenceSubmittedCount || 0),
      referenceSubjectIds: (lock?.referenceSubjects || []).map((row) => row.id),
      referenceSubmittedSubjectIds: Array.isArray(result?.referenceSubmittedSubjectIds)
        ? result.referenceSubmittedSubjectIds
        : [],
    };
  } catch (err) {
    console.warn('[offline-scene-image] generation failed', err);
    return { image: '', prompt: submittedPrompt, error: String(err?.message || err || '').slice(0, 160) };
  }
}
