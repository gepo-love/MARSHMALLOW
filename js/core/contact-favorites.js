import * as db from './db.js';

const SETTINGS_KEY = 'contactFavorites';

function normalize(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const ids = Array.isArray(base.ids) ? base.ids : [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < ids.length; i += 1) {
    const id = String(ids[i] || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return { ids: out };
}

export async function loadContactFavorites() {
  const row = await db.get(SETTINGS_KEY);
  return normalize(row?.value);
}

export async function saveContactFavorites(config) {
  const next = normalize(config);
  await db.put({ key: SETTINGS_KEY, value: next });
  return next;
}

export async function toggleContactFavorite(characterId) {
  const id = String(characterId || '').trim();
  if (!id) return null;
  const config = await loadContactFavorites();
  const idx = config.ids.indexOf(id);
  if (idx >= 0) {
    config.ids.splice(idx, 1);
  } else {
    config.ids.unshift(id);
  }
  await saveContactFavorites(config);
  return config;
}

export function isExplicitFavorite(config, characterId) {
  const id = String(characterId || '').trim();
  return !!(config && Array.isArray(config.ids) && config.ids.includes(id));
}
