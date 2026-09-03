import { shouldSkipBackupSettingsRow } from './backup-stream-import.js';

const CATEGORY_LABELS = {
  voiceAudioCache: '语音缓存',
  radioAudioCache: '电台音频缓存',
  debugLog: '调试/搜索日志',
  relationSyncMarkers: '关系同步标记',
  appearanceWallpapers: '主题壁纸原图',
  characterPhoneAssets: '角色手机内嵌图',
  localMusicAudio: '本地音乐音频',
  derivedVectorCache: '可重建的向量索引',
  settingsTrimmed: '其它 settings 内嵌大图',
  sensitiveCredentials: '本机凭据',
};

function approxJsonBytes(value) {
  try {
    return JSON.stringify(value).length;
  } catch (_) {
    return 0;
  }
}

function categoryForSettingsKey(key = '') {
  const k = String(key || '');
  if (k === 'voiceAudioCacheIndex' || k.startsWith('voiceAudioCache_')) return 'voiceAudioCache';
  if (k.startsWith('radioAudioBlob_')) return 'radioAudioCache';
  if (k === 'debugLogEvents' || k === 'searchCallLog' || k.startsWith('aiDebugSnapshot_')) return 'debugLog';
  if (k.startsWith('userRelationDeltaApplied_')
    || k.startsWith('userRelationCustomApplied_')
    || k.startsWith('userRelationDeltaLog_')) return 'relationSyncMarkers';
  if (k === 'appearancePrefs') return 'appearanceWallpapers';
  if (k.startsWith('characterPhone_')) return 'characterPhoneAssets';
  if (k === 'mcpCredentials' || k === 'meituanCredentials' || k === 'capabilityGrants' || k === 'shoppingCheckoutLinksV1') return 'sensitiveCredentials';
  return 'settingsTrimmed';
}

export function createExportOmissionTracker() {
  return { groups: new Map() };
}

function addOmission(tracker, category, bytes, { count = 1, key = '' } = {}) {
  if (!tracker || !bytes || bytes <= 0) return;
  const cat = category || 'settingsTrimmed';
  const prev = tracker.groups.get(cat) || { category: cat, label: CATEGORY_LABELS[cat] || cat, bytes: 0, count: 0, sampleKeys: [] };
  prev.bytes += bytes;
  prev.count += count;
  if (key && prev.sampleKeys.length < 3 && !prev.sampleKeys.includes(key)) prev.sampleKeys.push(key);
  tracker.groups.set(cat, prev);
}

export function trackSettingsExportRow(tracker, originalRow, normalizedRow) {
  if (!tracker || !originalRow) return;
  const key = String(originalRow.key || '');
  const originalBytes = approxJsonBytes(originalRow);

  if (shouldSkipBackupSettingsRow(originalRow)) {
    const cat = categoryForSettingsKey(key);
    addOmission(tracker, cat, originalBytes, { count: 1, key });
    return;
  }

  if (!normalizedRow) {
    addOmission(tracker, categoryForSettingsKey(key), originalBytes, { count: 1, key });
    return;
  }

  const normalizedBytes = approxJsonBytes(normalizedRow);
  if (normalizedBytes < originalBytes) {
    addOmission(tracker, categoryForSettingsKey(key), originalBytes - normalizedBytes, { count: 1, key });
  }
}

export function trackMusicExportRow(tracker, row) {
  const blob = row?.audioBlob;
  if (!(blob instanceof Blob) || !blob.size) return;
  addOmission(tracker, 'localMusicAudio', blob.size, {
    count: 1,
    key: String(row.fileName || row.title || row.id || ''),
  });
}

export function trackDerivedVectorExportRow(tracker, row) {
  addOmission(tracker, 'derivedVectorCache', approxJsonBytes(row), {
    count: 1,
    key: String(row?.id || row?.sourceId || ''),
  });
}

export function summarizeExportOmissions(tracker) {
  if (!tracker?.groups?.size) return [];
  return [...tracker.groups.values()]
    .filter((item) => item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
}

export function buildExportMeta(tracker, { suggestAssetExport = false, partsMode = false } = {}) {
  const omitted = summarizeExportOmissions(tracker);
  const omittedBytes = omitted.reduce((sum, item) => sum + item.bytes, 0);
  const notes = [];
  if (suggestAssetExport && omitted.some((item) => item.category === 'voiceAudioCache'
    || item.category === 'radioAudioCache'
    || item.category === 'appearanceWallpapers'
    || item.category === 'characterPhoneAssets'
    || item.category === 'localMusicAudio')) {
    notes.push('语音/电台缓存、壁纸原图、角色手机图与本地音乐请用「导出资源包」单独备份与导入');
  }
  if (partsMode) {
    notes.push('分片 ZIP 按数据表拆分：各表 + settings-core + settings-assets');
  }
  return {
    omittedBytes,
    omitted: omitted.map((item) => ({
      category: item.category,
      label: item.label,
      bytes: item.bytes,
      count: item.count,
      sampleKeys: item.sampleKeys,
      note: (item.category === 'voiceAudioCache'
        || item.category === 'radioAudioCache'
        || item.category === 'appearanceWallpapers'
        || item.category === 'characterPhoneAssets'
        || item.category === 'localMusicAudio')
        ? '请用「导出资源包」单独迁移'
        : (item.category === 'relationSyncMarkers'
          || item.category === 'debugLog'
          || item.category === 'derivedVectorCache')
          ? '可重建或仅作调试，不影响聊天数据'
          : item.category === 'sensitiveCredentials'
            ? '敏感凭据仅保存在本机，不随备份导出'
            : '为控制体积已裁剪内嵌大图',
    })),
    notes,
  };
}

export function formatBytesShort(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

export function formatExportOmissionHint(trackerOrSummary) {
  const summary = Array.isArray(trackerOrSummary)
    ? trackerOrSummary
    : summarizeExportOmissions(trackerOrSummary);
  if (!summary.length) return '';
  return `未含 ${summary.map((item) => `${item.label} ${formatBytesShort(item.bytes)}`).join('、')}`;
}
