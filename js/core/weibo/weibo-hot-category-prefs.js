/**
 * 微博热搜分区权重：按角色性格与 AU 预设微调，供 pickWeiboHotTopicForChat 加权抽样。
 */

export const DEFAULT_CATEGORY_PREFERENCES = {
  general: 1,
  entertainment: 1,
  life: 1.2,
  social: 0.8,
};

/** key 为 characters.js 中的角色 id */
export const CHARACTER_CATEGORY_WEIGHT_OVERRIDES = {};

/** key 为 au-presets.js 中的 preset id（与 user.auPreset 一致，如 au-entertainment） */
export const AU_CATEGORY_WEIGHT_OVERRIDES = {};

/**
 * @param {{ characterIds?: string[], user?: object }} args
 */
export function resolveCategoryPreferences({ characterIds = [], user = null } = {}) {
  let prefs = { ...DEFAULT_CATEGORY_PREFERENCES };

  const charOverrides = characterIds
    .map((id) => CHARACTER_CATEGORY_WEIGHT_OVERRIDES[String(id || '').trim()])
    .filter(Boolean);
  if (charOverrides.length > 0) {
    const accum = { general: 0, entertainment: 0, life: 0, social: 0 };
    for (const o of charOverrides) {
      for (const k of Object.keys(accum)) {
        accum[k] += Number(o[k] != null ? o[k] : prefs[k]);
      }
    }
    for (const k of Object.keys(accum)) {
      prefs[k] = accum[k] / charOverrides.length;
    }
  }

  const auId = String(user?.auPreset || '').trim();
  const auOverride = AU_CATEGORY_WEIGHT_OVERRIDES[auId];
  if (auOverride) {
    for (const k of Object.keys(prefs)) {
      prefs[k] = prefs[k] * Number(auOverride[k] != null ? auOverride[k] : 1);
    }
  }

  return prefs;
}
