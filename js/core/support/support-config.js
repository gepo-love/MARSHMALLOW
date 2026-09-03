import * as db from '../db.js';

export const SUPPORT_CONFIG_KEY = 'supportAssistantConfig';

export const DEFAULT_SUPPORT_CONFIG = Object.freeze({
  baseUrl: '',
  apiKey: '',
  model: '',
  enabled: false,
  maxTokens: 1800,
});

let cached = null;

export async function loadSupportConfig() {
  if (cached) return { ...cached };
  const row = await db.get('settings', SUPPORT_CONFIG_KEY).catch(() => null);
  cached = { ...DEFAULT_SUPPORT_CONFIG, ...(row?.value || {}) };
  return { ...cached };
}

export async function saveSupportConfig(input = {}) {
  const current = await loadSupportConfig();
  cached = {
    ...DEFAULT_SUPPORT_CONFIG,
    ...current,
    ...input,
    baseUrl: String(input.baseUrl ?? current.baseUrl ?? '').trim().replace(/\/+$/, ''),
    apiKey: String(input.apiKey ?? current.apiKey ?? '').trim(),
    model: String(input.model ?? current.model ?? '').trim(),
    enabled: input.enabled === true,
    maxTokens: Math.max(1, Math.floor(Number(input.maxTokens ?? current.maxTokens) || 1800)),
  };
  await db.put('settings', { key: SUPPORT_CONFIG_KEY, value: cached });
  window.dispatchEvent(new CustomEvent('support-config-changed', { detail: { ...cached, apiKey: '' } }));
  return { ...cached };
}

export function isSupportConfigReady(config = {}) {
  return config.enabled === true
    && !!String(config.baseUrl || '').trim()
    && !!String(config.apiKey || '').trim()
    && !!String(config.model || '').trim();
}
