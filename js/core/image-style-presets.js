/**
 * 内置生图画风预设：
 * - 兼容人物画风（realistic 引擎 = OpenAI 兼容生图，可接 gpt / gemini 等中转）：日系/韩系/欧系/2.5D 等档位，
 *   搭配「颜值稳定守则」与「防噪点防扭曲守则」，作为通用保底模板；具体样貌仍以角色人设（appearancePrompt）为准。
 *   不强制「真人」身份——2.5D 等档位可走精修数字艺术；写实/摄影质感由档位与保底提供。
 * - NovelAI 二次元画风（novelai 引擎）：厚涂/平涂两套通用画师串，作为没有自配画师串时的保底。
 *
 * 生效优先级（高→低）：单次调用显式 styleId（直播间局内选择等）→ 角色 imageStyleId → API 管理页全局默认。
 * 本模块只放纯数据与纯函数，不 import 其它 core 模块，避免循环依赖。
 */

/** 人物照的「手机随手拍」基底：去精修、去影棚感，但保持画面干净（写实质感保底，不绑「真人」身份） */
export const REALISTIC_PORTRAIT_CANDID_BASE = 'Looks like a casual photo taken on a phone in an unposed moment: natural soft lighting (indoor light or daylight), believable everyday setting with a bit of lived-in background, relaxed unforced expression and posture, real skin texture preserved, no heavy retouching, no studio lighting, no magazine-cover gloss, not a staged photoshoot.';

/** 颜值稳定守则：无锁脸/参考图时提高五官下限，避免随机普脸、崩脸 */
export const REALISTIC_FACE_QUALITY_GUARD = 'Facial quality: strikingly good-looking with clean facial geometry — crisp jawline with a smooth cheek-to-jaw transition, straight well-defined nose bridge with narrow refined nostrils, clearly shaped lips with a defined cupid\'s bow, clear bright symmetrical eyes with clean eyelid lines, smooth even skin without blemishes or harsh texture. The bone structure and presence must stay attractive and legible even in candid framing. Strictly avoid plain generic faces, coarse or mediocre features, asymmetric or ill-proportioned features, and stiff ID-photo blankness.';

/** 防噪点 / 防扭曲守则：针对 gpt 类生图常见的重噪点、五官融化、背景线条弯曲问题 */
export const REALISTIC_ANTI_ARTIFACT_GUARD = 'Image integrity: at most a subtle fine film grain — no heavy noise, no smeared or waxy skin, no over-sharpening halos, no warped or melted facial features, no distorted hands or wrong finger count, no bent or wobbling straight lines in the background, no glitch artifacts or double edges, natural believable proportions throughout the whole frame.';

/** 拍摄逻辑守则：自拍/第一人称视角里拍照的手机绝不入镜（镜面自拍除外），且肢体、透视、比例必须正确 */
export const REALISTIC_CAMERA_LOGIC_GUARD = 'Camera logic: this photo is taken WITH the phone, so the phone itself must never appear in a selfie or POV shot — no phone held toward the viewer, no floating phone, no camera visible in frame; a phone may appear ONLY in an explicit mirror selfie, as a reflection in the mirror. Anatomy and optics must be correct: natural limb placement and joint bends, correct number of arms and fingers, believable human body proportions, consistent perspective and subject-to-background scale, no impossible poses or warped geometry.';

/** 2.5D 必须保留可辨认的数字绘画质感，避免兼容模型退化成真人摄影。 */
export const ILLUSTRATED_25D_QUALITY_GUARD = '2.5D rendering lock: the result must be unmistakably stylized digital illustration, never a real photograph and never photorealistic. Keep visible high-end painted rendering in the skin, hair, eyes, clothing and lighting, with refined semi-realistic proportions, softly simplified materials, controlled illustration edges and subtle brush-rendered transitions. Do not use pores, documentary camera texture, live-action skin, photographic realism, cosplay-photo styling, or a real-person portrait finish.';

/** 2.5D 仍遵守自拍视角与肢体逻辑，但不再用 “this photo” 强化真人摄影语义。 */
export const ILLUSTRATED_CAMERA_LOGIC_GUARD = 'Composition logic: in a selfie or first-person composition, the capturing device stays outside the frame unless an explicit mirror selfie is requested. Anatomy and perspective must be coherent: natural limb placement and joint bends, correct number of arms and fingers, balanced stylized human proportions, consistent subject-to-background scale, no impossible poses or warped geometry.';

/**
 * 预设清单。
 * engine: 'realistic' | 'novelai'
 * group: 'person'（兼容人物） | 'anime'（NAI 画师串）
 * prompt: realistic 为英文画风描述段；novelai 为拼在最前的画师串/风格 tag
 * polished: true 表示走精修数字艺术质感（跳过随手拍基底），目前仅 2.5D 档
 */
export const IMAGE_STYLE_PRESETS = [
  {
    id: 'real_custom',
    engine: 'realistic',
    group: 'person',
    label: '兼容 · 自定义（不套模板）',
    hint: '只用你自己写的外观描述',
    // 空 prompt：仍走人像管线（可露脸、带通用颜值/防扭曲/拍摄逻辑守则），但不叠加任何命名风格描述
    prompt: '',
  },
  {
    id: 'real_jp_fresh',
    engine: 'realistic',
    group: 'person',
    label: '兼容 · 日系清透',
    hint: '干净少年感',
    prompt: 'East Asian youthful look in a Japanese lifestyle-photo mood: soft natural black or dark-brown hair, slightly airy fringe with a few loose strands that never cover the eyes, cool fair translucent skin, bright gentle eyes with an easy warmth that could break into a smile at any moment, visible clean collarbone line under a simple cotton tee or shirt, soft even daylight, effortless boy-or-girl-next-door freshness with zero greasiness.',
    partialPrompt: 'Japanese lifestyle-photo mood with soft even daylight, clean cotton clothing, airy natural styling, cool fresh colors, relaxed youthful body language, and an effortless everyday snapshot finish.',
  },
  {
    id: 'real_kr_idol',
    engine: 'realistic',
    group: 'person',
    label: '兼容 · 韩式偶像',
    hint: '饭拍感',
    prompt: 'Korean idol styling: milky even-toned skin with believable texture, sleek carefully styled hair, sharp clean jawline, calm glassy eyes with a composed focus, understated fashionable outfit with clean silhouettes, soft diffused lighting like an off-stage fansite snapshot — polished presence caught in a candid instant.',
    partialPrompt: 'Polished Korean off-stage fansite styling with clean fashionable silhouettes, careful grooming where visible, soft diffused light, neat body lines, and a candid but refined snapshot finish.',
  },
  {
    id: 'real_eu_casual',
    engine: 'realistic',
    group: 'person',
    label: '兼容 · 欧系随和',
    hint: '暖调松弛',
    prompt: 'European features with a relaxed approachable vibe: casually tousled hair, natural skin with a warm undertone and believable texture, friendly expressive eyes with soft smile lines, casual knitwear, denim or an open shirt, warm golden natural light, easygoing charm rather than sharp glamour.',
    partialPrompt: 'Relaxed European lifestyle styling with casual knitwear, denim or an open shirt, warm golden natural light, believable fabric texture, loose body language, and easygoing candid framing.',
  },
  {
    id: 'real_eu_refined',
    engine: 'realistic',
    group: 'person',
    label: '兼容 · 欧系精致',
    hint: '电影感',
    prompt: 'Refined European editorial look: chiseled bone structure with high cheekbones and deep-set eyes, immaculate grooming, tailored clothing with clean structured lines, soft cinematic key light with gentle falloff, quietly luxurious and composed without looking like an advertisement.',
    partialPrompt: 'Refined European editorial styling with tailored clothing, clean structured lines, immaculate grooming where visible, soft cinematic key light with gentle falloff, and quietly luxurious environmental framing.',
  },
  {
    id: 'real_25d',
    engine: 'realistic',
    group: 'person',
    label: '兼容 · 2.5次元',
    hint: '半写实数字绘画',
    polished: true,
    renderMode: 'illustration',
    prompt: 'High-end 2.5D digital character illustration with semi-realistic proportions: clearly painted and stylized rather than photographed, refined BJD-inspired facial design, softly rendered porcelain-like skin without photographic pores, dimensional painted hair, large luminous yet anatomically coherent eyes, elegant simplified bone structure, cinematic illustrated lighting, ethereal cool atmosphere, premium game-cinematic concept-art finish, controlled painterly transitions and crisp intentional edges.',
    partialPrompt: 'High-end 2.5D digital character illustration with semi-realistic proportions: clearly painted and stylized rather than photographed, softly simplified skin and fabric materials, dimensional painted hair or clothing where visible, cinematic illustrated lighting, premium game-cinematic concept-art finish, controlled painterly transitions and crisp intentional edges. Keep the requested crop, back view, silhouette, hands, or body detail; never convert it into a face-focused portrait.',
    finalGuard: ILLUSTRATED_25D_QUALITY_GUARD,
  },
  {
    id: 'nai_custom',
    engine: 'novelai',
    group: 'anime',
    label: 'NAI · 自定义（不套画师串）',
    hint: '只用你自己写的提示词',
    // 空 prompt：不拼任何画师串/风格 tag，只用上方前缀/模板 + 本次内容
    prompt: '',
  },
  {
    id: 'nai_impasto',
    engine: 'novelai',
    group: 'anime',
    label: 'NAI · 厚涂',
    hint: '质感厚重',
    prompt: 'artist:wlop, artist:guweiz, impasto, painterly, thick brush strokes, rich color blending, soft volumetric lighting, detailed rendering',
  },
  {
    id: 'nai_flat',
    engine: 'novelai',
    group: 'anime',
    label: 'NAI · 平涂',
    hint: '清透明快',
    prompt: 'artist:ciloranko, artist:hiten, artist:sho (sho lwlw), flat color, clean thin lineart, cel shading, bright clear palette, simple clean shading',
  },
];

/**
 * 场景/滤镜类预设：不是「画谁」，是「这张图整体的滤镜调子」，给旅行明信片、途中拍照、
 * 线下氛围图之类不一定有人物的场景用。用户可选是否允许人物出现，风格只管调子/构图，不锁人物有无。
 * 全部走 realistic 引擎；参考自常见摄影向 AI 生图提示词写法，强调镜头质感，避免灰扑扑、过度柔化。
 */
export const SCENE_STYLE_PRESETS = [
  {
    id: 'scene_clear_daily',
    engine: 'realistic',
    group: 'scene',
    label: '清透日常',
    hint: '干净自然光',
    prompt: 'Clean everyday photography look: bright natural daylight, crisp clear focus on the main subject, true-to-life saturated colors (not washed out or hazy), gentle contrast, soft realistic shadows, the kind of clear well-exposed photo you would want to keep — not a dull flat snapshot.',
  },
  {
    id: 'scene_ins_film',
    engine: 'realistic',
    group: 'scene',
    label: 'INS 胶片',
    hint: '奶油胶片色调',
    prompt: 'Instagram-style film photography: warm creamy color grading, subtle film grain, soft lifted shadows, gently muted but still rich colors, slight vignette, candid lifestyle-photo framing with intentional composition — polished enough to post, never a plain gray phone snapshot.',
  },
  {
    id: 'scene_youth_cinema',
    engine: 'realistic',
    group: 'scene',
    label: '青春电影感',
    hint: '柔光叙事',
    prompt: 'Youthful coming-of-age film still aesthetic: soft cinematic backlight or golden-hour glow, shallow depth of field with a gently blurred background, warm nostalgic color grading, a quiet narrative mood as if paused mid-scene from a movie — sharp enough on the subject to read clearly, not blurry overall.',
  },
  {
    id: 'scene_dreamcore',
    engine: 'realistic',
    group: 'scene',
    label: '梦核',
    hint: '柔雾超现实',
    prompt: 'Dreamcore atmosphere: hazy soft-focus glow, pastel-leaning color palette with a slightly surreal tint, gentle lens flare or light bloom, quiet liminal-space stillness, nostalgic dreamlike softness — keep the main subject legible and intentional, not just noise or blur.',
  },
  {
    id: 'scene_retro_film',
    engine: 'realistic',
    group: 'scene',
    label: '复古胶片',
    hint: '老照片质感',
    prompt: 'Vintage analog film photograph: warm faded color cast, visible film grain, slightly lifted blacks, soft halation around bright highlights, a subtle time-worn print quality reminiscent of an old physical photo — still a legible, well-composed shot, not degraded or unclear.',
  },
  {
    id: 'scene_healing_illustration',
    engine: 'realistic',
    group: 'scene',
    label: '治愈插画',
    hint: '柔色插画',
    prompt: 'Warm healing-style digital illustration: soft rounded shapes, gentle pastel color palette, clean flat-ish shading with light texture, cozy and comforting atmosphere, storybook-illustration composition — clean linework, not messy or unfinished.',
  },
  {
    id: 'scene_watercolor_sketch',
    engine: 'realistic',
    group: 'scene',
    label: '水彩速写',
    hint: '手绘笔触',
    prompt: 'Loose watercolor travel-journal sketch: visible brush strokes and paper texture, light washes of color, a few confident ink line accents, hand-drawn spontaneous feel — composition still clear and intentional, not a chaotic scribble.',
  },
  {
    id: 'scene_pure_realistic',
    engine: 'realistic',
    group: 'scene',
    label: '纯写实',
    hint: '摄影棚级还原',
    prompt: 'High-fidelity realistic photography: accurate natural colors, sharp true-to-life detail and texture, well-balanced exposure and dynamic range, believable natural lighting — like a well-shot photo straight off a good camera, no artistic filter laid over it.',
  },
];

const ALL_PRESETS = [...IMAGE_STYLE_PRESETS, ...SCENE_STYLE_PRESETS];
const PRESET_MAP = new Map(ALL_PRESETS.map((p) => [p.id, p]));

/** 按 id 取预设（人物画风 + 场景滤镜共用一张表）；无效 id 返回 null */
export function getImageStylePreset(id = '') {
  return PRESET_MAP.get(String(id || '').trim()) || null;
}

/** 列出人物画风预设；可按 engine（'realistic'|'novelai'）过滤 */
export function listImageStylePresets(engine = '') {
  const key = String(engine || '').trim();
  if (!key) return [...IMAGE_STYLE_PRESETS];
  return IMAGE_STYLE_PRESETS.filter((p) => p.engine === key);
}

/** 列出场景/滤镜预设（旅行明信片、线下氛围图、时光机插画等场景用） */
export function listScenePresets() {
  return [...SCENE_STYLE_PRESETS];
}

/**
 * 组装「场景/滤镜」类图片的最终提示词：风格方向 + 本次画面内容 + 人物是否允许出现 + 用户自定义追加词。
 * 结果作为 rawPrompt 直接发给兼容引擎（realistic）。
 * 自定义追加词置顶覆盖；其后才是画风、画面内容、人物规则与防伪影保底。
 * @param {string} basePrompt 本次要画的具体内容（地点/事件/氛围，不含风格词）
 * @param {object|null} preset SCENE_STYLE_PRESETS 里的一条，null/空 prompt 表示不套风格模板
 * @param {object} opts
 * @param {boolean} [opts.allowPeople] 是否允许画面里出现人物（默认不允许，即当前生活流的默认克制风格）
 * @param {string} [opts.customSuffix] 用户自定义风格描述，拼在最前优先覆盖
 */
export function buildSceneStylePrompt(basePrompt = '', preset = null, opts = {}) {
  const base = String(basePrompt || '').trim();
  const allowPeople = opts.allowPeople === true;
  const custom = opts.customSuffix ? String(opts.customSuffix).trim() : '';
  return [
    custom ? `User style override: ${custom}` : '',
    preset?.prompt ? `Style direction: ${preset.prompt}` : '',
    base ? `Scene content: ${base}` : '',
    allowPeople
      ? 'People may appear naturally in the scene if the content calls for it, kept candid and unposed.'
      : 'No identifiable people as the focal subject — keep the frame about the place, objects, and atmosphere.',
    REALISTIC_ANTI_ARTIFACT_GUARD,
  ].filter(Boolean).join('\n');
}

/**
 * 组装兼容引擎人物照最终提示词：画风档位 + 本次画面内容（外貌以人设/锁定描述为准）+ 质感基底 + 守则。
 * 结果作为 rawPrompt 直接发给兼容引擎（不再叠加默认的无脸生活图规则）。
 */
export function buildRealisticPortraitPrompt(basePrompt = '', preset = null) {
  const base = String(basePrompt || '').trim();
  const style = preset && preset.engine === 'realistic' ? preset : null;
  const isIllustration = style?.renderMode === 'illustration';
  return [
    style?.prompt ? `Style direction: ${style.prompt}` : '',
    base ? `Subject and moment: ${base}` : '',
    style?.polished ? '' : REALISTIC_PORTRAIT_CANDID_BASE,
    isIllustration ? ILLUSTRATED_25D_QUALITY_GUARD : REALISTIC_FACE_QUALITY_GUARD,
    REALISTIC_ANTI_ARTIFACT_GUARD,
    isIllustration ? ILLUSTRATED_CAMERA_LOGIC_GUARD : REALISTIC_CAMERA_LOGIC_GUARD,
    style?.finalGuard && style.finalGuard !== ILLUSTRATED_25D_QUALITY_GUARD
      ? style.finalGuard
      : '',
  ].filter(Boolean).join('\n');
}

/**
 * 组装局部人物/背影画面：允许人物画风控制整张图的媒介与质感，但不启用五官、
 * 自拍或正脸守则。只有提供 partialPrompt 的预设才会在这里注入专属风格词。
 */
export function buildRealisticPartialPersonPrompt(basePrompt = '', preset = null, options = {}) {
  const base = String(basePrompt || '').trim();
  const style = preset && preset.engine === 'realistic' ? preset : null;
  const isIllustration = style?.renderMode === 'illustration';
  const framingConstraint = 'Framing constraint: preserve the requested cropped body detail, hands, back view, silhouette, or environmental composition. Keep identity only through non-face cues such as hair, clothing, build, and accessories; no visible or identifiable face anywhere and no portrait framing.';
  return [
    style?.partialPrompt ? `Style direction: ${style.partialPrompt}` : '',
    base ? `Subject and moment: ${base}` : '',
    isIllustration ? ILLUSTRATED_25D_QUALITY_GUARD : '',
    REALISTIC_ANTI_ARTIFACT_GUARD,
    isIllustration ? ILLUSTRATED_CAMERA_LOGIC_GUARD : REALISTIC_CAMERA_LOGIC_GUARD,
    framingConstraint,
    style?.finalGuard && style.finalGuard !== ILLUSTRATED_25D_QUALITY_GUARD
      ? style.finalGuard
      : '',
  ].filter(Boolean).join('\n');
}
