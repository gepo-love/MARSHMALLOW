const SEEN_KEY_PREFIX = 'memory-region-seen-at:';
const BASELINE_KEY = 'memory-region-indicator-baseline-at';

function seenKey(userId, scopeId, regionId) {
  return [
    SEEN_KEY_PREFIX,
    encodeURIComponent(String(userId || '').trim()),
    encodeURIComponent(String(scopeId || '').trim()),
    encodeURIComponent(String(regionId || '').trim()),
  ].join(':');
}

function idCreatedAt(id) {
  const value = String(id || '');
  const decimal = value.match(/^(?:mem|mf|evm|clt)_(\d{10,})_/);
  if (decimal) return Number(decimal[1]) || 0;
  const offline = value.match(/(?:^|_)oda_([a-z0-9]+)_/i);
  if (offline) return Number.parseInt(offline[1], 36) || 0;
  return 0;
}

export function memoryRegionRecordCreatedAt(record) {
  return (Number(record?.createdAt || 0) || 0)
    || idCreatedAt(record?.id)
    || (Number(record?.updatedAt || 0) || 0)
    || (Number(record?.timestamp || record?.endedAt || record?.startedAt || 0) || 0);
}

export function memoryRegionHasUnseen(rows, seenAt = 0) {
  const threshold = Math.max(0, Number(seenAt) || 0);
  return (Array.isArray(rows) ? rows : [])
    .some((row) => memoryRegionRecordCreatedAt(row) > threshold);
}

export function initializeMemoryRegionIndicator() {
  try {
    const stored = Math.max(0, Number(localStorage.getItem(BASELINE_KEY)) || 0);
    if (stored) return stored;
    const baseline = Date.now();
    localStorage.setItem(BASELINE_KEY, String(baseline));
    return baseline;
  } catch (_) {
    return Date.now();
  }
}

export function readMemoryRegionSeenAt(userId, scopeId, regionId) {
  try {
    const stored = localStorage.getItem(seenKey(userId, scopeId, regionId));
    if (stored != null) return Math.max(0, Number(stored) || 0);
    return initializeMemoryRegionIndicator();
  } catch (_) {
    return Date.now();
  }
}

export function markMemoryRegionSeen(userId, scopeId, regionId, rows = []) {
  if (!userId || !scopeId || !regionId) return 0;
  const latestRecordAt = (Array.isArray(rows) ? rows : [])
    .reduce((latest, row) => Math.max(latest, memoryRegionRecordCreatedAt(row)), 0);
  // 旧事件没有 createdAt，只能回退到剧情时间；剧情时钟可能快于设备时间。
  // 进入分区时把已读线推进到当前记录最大时间，保证“已经亲眼看过”后红点能清掉。
  const seenAt = Math.max(Date.now(), latestRecordAt);
  try {
    localStorage.setItem(seenKey(userId, scopeId, regionId), String(seenAt));
  } catch (_) {}
  return seenAt;
}

export function rowsForMemoryRegion(picked, regionId, extras = {}) {
  const region = String(regionId || '').trim();
  if (region === 'journal') return picked?.summaries || [];
  if (region === 'shared') return picked?.shared || [];
  if (region === 'fragments') return picked?.timeMachineFragments || [];
  if (region === 'events') return picked?.events || [];
  if (region === 'archive') return picked?.aboutYou || picked?.archive || [];
  if (region === 'characterTraits') return picked?.characterTraits || [];
  if (region === 'anonymous') return picked?.anonymous || [];
  if (region === 'offline') return extras.offlineArchives || [];
  if (region === 'travel') return extras.travelCollectibles || [];
  return [];
}

export function memoryRegionUnseenState({
  userId,
  scopeId,
  picked,
  regionIds = [],
  offlineArchives = [],
  travelCollectibles = [],
} = {}) {
  return Object.fromEntries(regionIds.map((regionId) => {
    const rows = rowsForMemoryRegion(picked, regionId, { offlineArchives, travelCollectibles });
    const seenAt = readMemoryRegionSeenAt(userId, scopeId, regionId);
    return [regionId, memoryRegionHasUnseen(rows, seenAt)];
  }));
}
