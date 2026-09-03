export const REGION_BACKUP_FORMAT = 'marshmallow-phone-backup-region';
export const REGION_BACKUP_VERSION = 1;
export const REGION_PART_TARGET_BYTES = 256 * 1024 * 1024;
// Android 网页端先把每一卷流式写入 OPFS，再把磁盘 File 交给浏览器保存；
// 128MB 用于可靠的磁盘临时文件通道。
export const ANDROID_REGION_PART_TARGET_BYTES = 128 * 1024 * 1024;
// 华为默认浏览器等环境可能暴露 OPFS API 却拒绝创建文件。
// 应急导出改用单卷小 Blob，每次只在内存中保留一卷。
export const ANDROID_EMERGENCY_REGION_PART_TARGET_BYTES = 8 * 1024 * 1024;

const CORE_BACKUP_REGIONS = [
  { id: 'identity', label: '档位与角色', stores: ['users', 'characters', 'aliasAccounts'] },
  { id: 'chat', label: '聊天与消息', stores: ['chats', 'messages'] },
  { id: 'memory', label: '记忆', stores: ['memories', 'memoryFacts', 'eventMemories', 'memoryVectors', 'sharedEventKnowledge'] },
  { id: 'social', label: '动态与社区', stores: ['momentsPosts', 'weiboPosts', 'forumThreads'] },
  { id: 'world', label: '世界书与设定', stores: ['worldBooks'] },
  {
    id: 'play',
    label: '特殊玩法与收藏',
    stores: [
      'stickerPacks',
      'collectibles',
      'auStories',
      'streamerChannels',
      'streamerFanState',
      'streamerLedger',
      'streamerRecordings',
    ],
  },
  { id: 'music', label: '音乐与歌单', stores: ['musicTracks', 'musicPlaylists', 'musicPosts'] },
  { id: 'settings', label: 'API、预设与应用设置', stores: ['settings'] },
];

const LEGACY_REGION_IDS = ['identity', 'chat', 'memory', 'social', 'world', 'settings'];

const encoder = new TextEncoder();

export function getCoreBackupRegions() {
  return CORE_BACKUP_REGIONS.map((region) => ({
    ...region,
    stores: [...region.stores],
  }));
}

function hasCanonicalRegionList(value) {
  const expected = CORE_BACKUP_REGIONS.map((region) => region.id);
  if (!Array.isArray(value)) return false;
  const normalized = value.map(String);
  return (normalized.length === expected.length && normalized.every((region, index) => region === expected[index]))
    || (normalized.length === LEGACY_REGION_IDS.length && normalized.every((region, index) => region === LEGACY_REGION_IDS[index]));
}

/** Remove media fields that belong to the separately exported resource pack. */
export function stripRegionBackupAssets(storeName, row) {
  if (!row || typeof row !== 'object') return row;
  if (storeName === 'characters') {
    const next = { ...row };
    delete next.avatar;
    delete next.showcaseImages;
    if (next.imageLock && typeof next.imageLock === 'object') {
      next.imageLock = { ...next.imageLock };
      delete next.imageLock.refImageUrl;
      if (!Object.keys(next.imageLock).length) delete next.imageLock;
    }
    return next;
  }
  if (storeName === 'users') {
    const next = { ...row };
    delete next.avatar;
    delete next.videoAvatar;
    delete next.videoProfileImage;
    return next;
  }
  if (storeName === 'chats') {
    const next = { ...row };
    if (next.groupSettings && typeof next.groupSettings === 'object') {
      next.groupSettings = { ...next.groupSettings };
      delete next.groupSettings.wallpaper;
      delete next.groupSettings.avatar;
      if (!Object.keys(next.groupSettings).length) delete next.groupSettings;
    }
    return next;
  }
  if (storeName === 'musicTracks') {
    const next = { ...row };
    delete next.audioBlob;
    return next;
  }
  return row;
}

export function utf8ByteLength(text) {
  return encoder.encode(String(text ?? '')).byteLength;
}

/**
 * Preserve records as atomic units: an individual oversized record remains one
 * part, while subsequent records start a fresh part.
 */
export function splitBackupRegionRowsByBytes(entries, targetBytes = REGION_PART_TARGET_BYTES) {
  const limit = Math.max(1, Number(targetBytes) || REGION_PART_TARGET_BYTES);
  const parts = [];
  let current = [];
  let bytes = 0;

  for (const entry of entries || []) {
    if (!entry || typeof entry.store !== 'string') continue;
    const entryBytes = utf8ByteLength(JSON.stringify(entry)) + 1;
    if (current.length && bytes + entryBytes > limit) {
      parts.push({ entries: current, bytes });
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += entryBytes;
  }
  if (current.length) parts.push({ entries: current, bytes });
  return parts;
}

/**
 * 只保留每卷在各数据表中的连续键范围，不保留记录正文。
 * 区域备份可先完成轻量预检，再按这些范围逐卷从 IndexedDB 回读并写入 OPFS。
 */
export function createBackupRegionPartPlanner(targetBytes = REGION_PART_TARGET_BYTES) {
  const limit = Math.max(1, Number(targetBytes) || REGION_PART_TARGET_BYTES);
  const parts = [];
  let current = null;

  const ensureCurrent = () => {
    if (!current) current = { ranges: [], bytes: 0, rows: 0 };
    return current;
  };
  const flush = () => {
    if (!current?.rows) return;
    parts.push(current);
    current = null;
  };

  return {
    add(store, key, bytes) {
      const storeName = String(store || '');
      if (!storeName || key === undefined || key === null) return;
      const entryBytes = Math.max(1, Number(bytes) || 1);
      if (current?.rows && current.bytes + entryBytes > limit) flush();
      const part = ensureCurrent();
      const last = part.ranges[part.ranges.length - 1];
      if (last?.store === storeName) {
        last.endKey = key;
        last.rows += 1;
      } else {
        part.ranges.push({ store: storeName, startKey: key, endKey: key, rows: 1 });
      }
      part.bytes += entryBytes;
      part.rows += 1;
    },
    finish() {
      flush();
      return parts;
    },
  };
}

export function validateRegionBackupManifest(manifest, headers, { allowPartial = false } = {}) {
  if (!manifest || manifest.format !== REGION_BACKUP_FORMAT) {
    return { ok: false, missing: [], error: '不是有效的区域备份清单' };
  }
  const backupId = String(manifest.backupId || '');
  const regions = manifest.coreRegions.map(String);
  if (!backupId || !hasCanonicalRegionList(manifest.coreRegions)) {
    return { ok: false, missing: [], error: '区域备份清单不完整' };
  }

  const seen = new Set();
  const missing = [];
  const invalid = [];
  const presentRegions = new Set();
  for (const header of headers || []) {
    if (String(header?.backupId || '') !== backupId) {
      invalid.push('包含不同批次的区域备份');
      continue;
    }
    const region = String(header?.region || '');
    const part = Number(header?.part || 0);
    const partsTotal = Number(header?.partsTotal || 0);
    if (!hasCanonicalRegionList(header?.coreRegions)
      || header.coreRegions.map(String).join('\u0000') !== regions.join('\u0000')
      || !regions.includes(region)
      || part < 1
      || partsTotal < part) {
      invalid.push(`无效分片：${region || '未知区域'}`);
      continue;
    }
    seen.add(`${region}:${part}`);
    presentRegions.add(region);
  }

  const targetRegions = allowPartial ? [...presentRegions] : regions;
  if (allowPartial && !targetRegions.length) {
    return { ok: false, missing: [], invalid: ['未找到可导入的区域'], backupId, partial: true };
  }
  for (const region of targetRegions) {
    const total = Math.max(
      1,
      ...(headers || [])
        .filter((header) => String(header?.backupId || '') === backupId && String(header?.region || '') === region)
        .map((header) => Number(header?.partsTotal || 0)),
    );
    for (let part = 1; part <= total; part += 1) {
      if (!seen.has(`${region}:${part}`)) missing.push(`${region} ${part}/${total}`);
    }
  }
  const fullSet = !allowPartial && targetRegions.length === regions.length;
  return {
    ok: !missing.length && !invalid.length,
    missing,
    invalid,
    backupId,
    partial: allowPartial && !fullSet,
    presentRegions: [...presentRegions],
  };
}

export function summarizeRegionBackupPlan(prepared = {}) {
  const groups = new Map();
  for (const file of prepared.files || []) {
    const key = String(file.region || '');
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        label: file.regionLabel || key,
        parts: 0,
        rows: 0,
      });
    }
    const group = groups.get(key);
    group.parts += 1;
    group.rows += Number(file.rows || 0);
  }
  const regions = [...groups.values()];
  return {
    backupId: prepared.backupId || '',
    fileCount: (prepared.files || []).length,
    regions,
    totalRows: Object.values(prepared.counts || {}).reduce((sum, n) => sum + Number(n || 0), 0),
    omissions: prepared.omissions || null,
  };
}

export function formatRegionBackupPlanText(plan = {}) {
  const lines = (plan.regions || []).map((region, index) => {
    const partHint = region.parts > 1 ? `（${region.parts} 个分片）` : '';
    return `${index + 1}. ${region.label}${partHint}`;
  });
  const head = `本次区域备份共 ${plan.fileCount || 0} 个文件，需全部保存才算完整一套。`;
  return lines.length ? `${head}\n${lines.join('\n')}` : head;
}

export function getRegionBackupRegionLabel(regionId = '') {
  const region = CORE_BACKUP_REGIONS.find((item) => item.id === regionId);
  return region?.label || String(regionId || '未知区域');
}
