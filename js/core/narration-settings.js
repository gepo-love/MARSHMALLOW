/**
 * 线下 / 番外 / 时光机等长文叙事共用：
 * - 字数完全由用户决定，不设内置上限（只兜一个下限，避免空段）。
 * - token 预算完全跟随用户字数上限，无内置天花板。
 * - 统一的「分段错落有致」提示，所有线下叙事都注入。
 * - 用户上次设定的字数上下限写入 settings，下次自动恢复。
 */

import { get as dbGet, put as dbPut } from './db.js';

const WORD_RANGE_PREFS_KEY = 'narrationWordRangePrefs';

export const VARIED_SEGMENTATION_HINT =
  '分段要错落有致：长段与短段交替，不要每段都差不多长。需要顿一下、留白、收一拍时就用一两句的短段，需要铺陈画面或情绪时再展开成长段，让阅读有呼吸和节奏感，避免一律均匀的「豆腐块」段落。';

/** 归一字数区间：只兜下限与 max>min，不设上限（字数由用户决定）。 */
export function clampWordRange(partial = {}, fallbackMin = 200, fallbackMax = 500) {
  const toInt = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : def;
  };
  const wordMin = Math.max(30, toInt(partial.wordMin, fallbackMin));
  const wordMax = Math.max(wordMin + 30, toInt(partial.wordMax, fallbackMax));
  return { wordMin, wordMax };
}

import { resolveGenerationMaxTokens } from './api.js';

/** 线下/番外/时光机等长文叙事：max_tokens 完全跟随用户 API 设置（可传该会话的模型覆盖配置） */
export async function resolveNarrationMaxTokens(overrideConfig = null) {
  return resolveGenerationMaxTokens(overrideConfig);
}

/** 写给模型的字数区间指令（强调这是用户设定）。 */
export function wordRangeDirective(wordMin, wordMax) {
  return `篇幅：本段正文控制在 ${wordMin}~${wordMax} 字之间（这是用户设定的字数区间，请认真贴合，不要明显过短，也不要硬凑灌水）。`;
}

/** 读取用户上次保存的字数上下限（全模式共用）。 */
export async function loadSavedWordRange(fallbackMin = 200, fallbackMax = 500) {
  try {
    const row = await dbGet(WORD_RANGE_PREFS_KEY);
    const v = row?.value;
    if (v && typeof v === 'object') {
      return clampWordRange(v, fallbackMin, fallbackMax);
    }
  } catch (_) { /* 读取失败用默认 */ }
  return clampWordRange({}, fallbackMin, fallbackMax);
}

/** 持久化字数上下限（开始线下 / 保存场景 / 生成时光机 / 开番外时调用）。 */
export async function saveWordRangePrefs(partial = {}) {
  const range = clampWordRange(partial);
  try {
    await dbPut({
      key: WORD_RANGE_PREFS_KEY,
      value: { wordMin: range.wordMin, wordMax: range.wordMax, updatedAt: Date.now() },
    });
  } catch (_) { /* 写入失败不阻塞主流程 */ }
  return range;
}
