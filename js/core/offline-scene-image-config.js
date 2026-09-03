import { listScenePresets } from './image-style-presets.js';

export const DEFAULT_OFFLINE_SCENE_STYLE_ID = 'none';
const OFFLINE_SCENE_IMAGE_GEN_MODES = new Set(['smart', 'novelai', 'realistic']);

const NOVELAI_SCENE_STYLE_PROMPTS = {
  scene_clear_daily: 'clean composition, natural daylight, vivid colors, crisp focus, everyday atmosphere',
  scene_ins_film: 'film grain, warm colors, creamy color palette, soft shadows, vignette, candid composition',
  scene_youth_cinema: 'cinematic lighting, backlighting, golden hour, depth of field, warm colors, nostalgic atmosphere',
  scene_dreamcore: 'dreamcore, soft focus, pastel colors, light bloom, liminal space, surreal atmosphere',
  scene_retro_film: 'analog film, film grain, faded colors, warm colors, halation, vintage',
  scene_healing_illustration: 'healing, cozy, pastel colors, soft lighting, clean lineart, storybook illustration',
  scene_watercolor_sketch: 'watercolor, traditional media, sketch, paper texture, visible brush strokes',
  scene_pure_realistic: 'realistic, photorealistic, natural lighting, detailed, accurate colors',
};

/** 空串表示跟随 API 管理中的全局线下默认。 */
export function normalizeOfflineSceneImageGenMode(value = '') {
  const mode = String(value || '').trim();
  return OFFLINE_SCENE_IMAGE_GEN_MODES.has(mode) ? mode : '';
}

/** 线下场景画风清单。数据独立于生图执行链，供建场页轻量读取。 */
export const OFFLINE_SCENE_STYLES = {
  none: {
    label: '不限定（跟随下方风格备注/角色外观）',
    promptFragment: '',
  },
  ...Object.fromEntries(listScenePresets().map((preset) => [
    preset.id,
    {
      label: preset.label,
      promptFragment: preset.prompt || '',
      novelAiPromptFragment: NOVELAI_SCENE_STYLE_PROMPTS[preset.id] || '',
    },
  ])),
};
