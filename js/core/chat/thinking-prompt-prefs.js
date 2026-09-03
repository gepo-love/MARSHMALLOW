import { get, put } from '../db.js';

const STORE_KEY = 'thinkingPromptPresets';
export const MAX_THINKING_PROMPT_LENGTH = 4000;
export const THINKING_PROMPT_EXPORT_TYPE = 'marshmallow-thinking-prompt';
export const THINKING_PROMPT_EXPORT_VERSION = 1;
export const THINKING_PROMPT_MODES = Object.freeze(['default', 'claude-light', 'gemini-flash-deep', 'custom']);

export function cleanThinkingPrompt(value = '') {
  return String(value || '')
    .replace(/<<<\/?(?:THINKING|END_THINKING|MARSHMALLOW_CHAT_V2|END_MARSHMALLOW_CHAT_V2)>>>/gi, '')
    .trim()
    .slice(0, MAX_THINKING_PROMPT_LENGTH);
}

export function normalizeThinkingPromptConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = THINKING_PROMPT_MODES.includes(src.mode) ? src.mode : 'default';
  return {
    mode,
    prompt: cleanThinkingPrompt(src.prompt),
  };
}

export function buildThinkingPromptExportPayload(config = {}) {
  return {
    type: THINKING_PROMPT_EXPORT_TYPE,
    version: THINKING_PROMPT_EXPORT_VERSION,
    exportedAt: Date.now(),
    formatName: '棉花糖机思维链规则',
    formatNote: '棉花糖机自用 JSON 格式，与酒馆角色卡无关，不兼容酒馆导入格式。',
    config: normalizeThinkingPromptConfig(config),
  };
}

export function parseThinkingPromptImportText(text = '') {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('文件里没有可导入的思维链规则');

  const candidates = [raw];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match = fenceRe.exec(raw);
  while (match) {
    const block = String(match[1] || '').trim();
    if (block) candidates.unshift(block);
    match = fenceRe.exec(raw);
  }

  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(candidate);
      if (!payload || typeof payload !== 'object') continue;
      if (payload.type === THINKING_PROMPT_EXPORT_TYPE && payload.config) {
        return normalizeThinkingPromptConfig(payload.config);
      }
      if (payload.config && typeof payload.config === 'object' && !payload.type) {
        return normalizeThinkingPromptConfig(payload.config);
      }
      if ('prompt' in payload || 'mode' in payload) {
        return normalizeThinkingPromptConfig(payload);
      }
      const legacy = payload.thinkingPrompt ?? payload.chainOfThought ?? payload.rules;
      if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
        return normalizeThinkingPromptConfig(legacy);
      }
      if (Array.isArray(legacy)) {
        return normalizeThinkingPromptConfig({ mode: 'custom', prompt: legacy.join('\n') });
      }
      if (String(legacy || '').trim()) {
        return normalizeThinkingPromptConfig({ mode: 'custom', prompt: legacy });
      }
    } catch (_) {
      // 旧版或手工整理的 .txt：在 JSON 候选全部失败后按纯文本规则导入。
    }
  }
  return normalizeThinkingPromptConfig({ mode: 'custom', prompt: raw });
}

function normalizePreset(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const config = normalizeThinkingPromptConfig(raw);
  const now = Date.now();
  return {
    id: String(raw.id || '').trim() || `think_${now}_${Math.random().toString(36).slice(2, 7)}`,
    name: String(raw.name || '').trim().slice(0, 40) || '未命名模板',
    ...config,
    createdAt: Number(raw.createdAt || now) || now,
    updatedAt: Number(raw.updatedAt || now) || now,
  };
}

export async function loadThinkingPromptPresets() {
  const row = await get(STORE_KEY).catch(() => null);
  const list = Array.isArray(row?.value?.presets) ? row.value.presets : [];
  return list.map(normalizePreset).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveThinkingPromptPreset(name, config = {}) {
  const label = String(name || '').trim();
  if (!label) throw new Error('请填写模板名称');
  const list = await loadThinkingPromptPresets();
  const preset = normalizePreset({ name: label, ...normalizeThinkingPromptConfig(config) });
  await put({ key: STORE_KEY, value: { presets: [preset, ...list] } });
  return preset;
}

export async function deleteThinkingPromptPreset(id) {
  const target = String(id || '').trim();
  if (!target) return;
  const list = await loadThinkingPromptPresets();
  await put({ key: STORE_KEY, value: { presets: list.filter((item) => item.id !== target) } });
}
