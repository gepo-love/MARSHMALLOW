import * as db from './db.js';

const BEAUTIFY_ASSET_ID_KEYS = new Set([
  'wallpaperAssetId',
  'chatHubBackgroundAssetId',
  'chatSidebarBackgroundAssetId',
]);
const REFERENCE_STORES = ['settings', 'users', 'characters', 'chats', 'beautifyAssets'];
const MM_IMAGE_PATTERN = /mm-img:\/\/([a-zA-Z0-9_-]+)/g;

export function collectBeautifyAssetReferences(value, output = new Set(), seen = new WeakSet()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(MM_IMAGE_PATTERN)) output.add(match[1]);
    return output;
  }
  if (!value || typeof value !== 'object'
    || (typeof Blob !== 'undefined' && value instanceof Blob)) return output;
  if (seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectBeautifyAssetReferences(item, output, seen);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    if (BEAUTIFY_ASSET_ID_KEYS.has(key)) {
      const id = String(child || '').trim();
      if (id) output.add(id);
      continue;
    }
    if (key === 'assetIds' && Array.isArray(child)) {
      for (const id of child) {
        const normalized = String(id || '').trim();
        if (normalized) output.add(normalized);
      }
      continue;
    }
    // Base64 本体不可能包含素材协议，跳过可避免恢复后再次扫描数百 MB 图片。
    if (key === 'dataUrl' || key === 'audioDataUrl') continue;
    collectBeautifyAssetReferences(child, output, seen);
  }
  return output;
}

export async function inspectRestoredBeautifyAssetReferences() {
  const referencedIds = new Set();
  for (const storeName of REFERENCE_STORES) {
    await db.forEachStoreRecordBatched(storeName, (row) => {
      collectBeautifyAssetReferences(row, referencedIds);
    }, { batchSize: 32 });
  }
  const ids = [...referencedIds];
  if (!ids.length) return { referenced: 0, restored: 0, missing: 0, missingIds: [] };
  const records = await db.getMany('beautifyAssets', ids);
  const restoredIds = new Set(records.filter(Boolean).map((row) => String(row.id || '')));
  const missingIds = ids.filter((id) => !restoredIds.has(id));
  return {
    referenced: ids.length,
    restored: restoredIds.size,
    missing: missingIds.length,
    missingIds: missingIds.slice(0, 50),
  };
}
