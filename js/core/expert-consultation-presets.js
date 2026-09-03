import { get, put } from './db.js';

const STORE_KEY = 'expertConsultationFlavorPresetsV1';

function clean(value = '', max = 500) {
  return String(value || '').trim().slice(0, max);
}

function normalize(row = {}) {
  const preserveFlavor = clean(row.preserveFlavor);
  const introduceFlavor = clean(row.introduceFlavor);
  if (!preserveFlavor || !introduceFlavor) return null;
  return {
    id: clean(row.id, 100) || `expert_flavor_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: clean(row.name, 80) || '未命名会诊方案',
    preserveFlavor,
    introduceFlavor,
    apiSection: ['main', 'scene'].includes(row.apiSection) ? row.apiSection : 'main',
    apiPresetId: clean(row.apiPresetId, 120),
    updatedAt: Number(row.updatedAt || Date.now()),
  };
}

export async function listExpertConsultationPresets() {
  const row = await get(STORE_KEY).catch(() => null);
  return (Array.isArray(row?.value) ? row.value : [])
    .map(normalize)
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveExpertConsultationPreset(input = {}) {
  const next = normalize(input);
  if (!next) throw new Error('请先填写希望保留和希望引入的特点');
  const list = await listExpertConsultationPresets();
  const sameId = list.findIndex((row) => row.id === next.id);
  const sameName = list.findIndex((row) => row.name === next.name);
  const index = sameId >= 0 ? sameId : sameName;
  if (index >= 0) list.splice(index, 1);
  await put({ key: STORE_KEY, value: [next, ...list].slice(0, 50) });
  return next;
}

export async function deleteExpertConsultationPreset(id = '') {
  const target = clean(id, 100);
  const list = await listExpertConsultationPresets();
  await put({ key: STORE_KEY, value: list.filter((row) => row.id !== target) });
}
