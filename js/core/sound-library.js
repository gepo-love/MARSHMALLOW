import {
  deleteRecord,
  forEachStoreRecordBatched,
  countRecords,
  getMany,
  getRecord,
  putRecord,
} from './db.js';

export const SOUND_ASSET_CATEGORIES = Object.freeze([
  { id: 'kiss', label: '亲吻', mode: 'cue', hint: '唇瓣贴合、轻啄或分开时真实发生的吻声' },
  { id: 'fabric', label: '布料摩擦', mode: 'texture', hint: '衣料、被褥或沙发确实发出持续摩擦声' },
  { id: 'breath_soft', label: '平缓呼吸', mode: 'cue', hint: '贴近时可闻的轻呼吸或吐息' },
  { id: 'breath_heavy', label: '较重呼吸', mode: 'cue', hint: '运动、哭泣、惊吓或明确喘息后的较重呼吸' },
  { id: 'body_movement', label: '身体动作 / 亲密接触', mode: 'texture', hint: '拥抱、贴近、抚触等持续动作带出的声音' },
  { id: 'body_impact', label: '身体碰撞', mode: 'texture', hint: '确实发生的身体撞击、跌落或连续拍击' },
  { id: 'footsteps', label: '脚步声', mode: 'cue', hint: '走近、离开或停下时真实可闻的脚步' },
  { id: 'door', label: '门 / 门锁', mode: 'cue', hint: '推门、关门、落锁或门把转动' },
  { id: 'wet', label: '湿润纹理（wet）', mode: 'texture', hint: '非接吻的持续亲密动作已经成立，并带出湿润声响' },
  { id: 'bgm_romantic', label: 'BGM · 浪漫暧昧', mode: 'background', hint: '浪漫、暧昧或亲密场景的连续背景音乐', continuous: true },
  { id: 'bgm_calm', label: 'BGM · 平静陪伴', mode: 'background', hint: '平静陪伴、闲聊或放松场景的连续背景音乐', continuous: true },
  { id: 'bgm_night', label: 'BGM · 夜晚低落', mode: 'background', hint: '深夜、失落或安静低落场景的连续背景音乐', continuous: true },
  { id: 'bgm_tension', label: 'BGM · 克制紧张', mode: 'background', hint: '僵持、压迫或克制紧张场景的连续背景音乐', continuous: true },
  { id: 'bgm', label: '背景 BGM（通用）', mode: 'background', hint: '适合覆盖整段场景的通用背景音乐', continuous: true },
  { id: 'ambience_water', label: '浴室 / 水声', mode: 'background', hint: '浴室、淋浴或持续水流环境声', continuous: true },
  { id: 'ambience_rain', label: '雨声', mode: 'background', hint: '窗外或户外持续存在的雨声环境', continuous: true },
  { id: 'ambience_scene', label: '其他场景氛围', mode: 'background', hint: '明确场景中适合连续铺设的环境声', continuous: true },
  { id: 'other', label: '其他', mode: 'cue', hint: '' },
]);

const CATEGORY_IDS = new Set(SOUND_ASSET_CATEGORIES.map((item) => item.id));
const SOUND_CUSTOM_CATEGORY_SETTING_KEY = 'soundAssetCustomCategoriesV1';
const SOUND_PLAYBACK_TRACE_SETTING_KEY = 'soundAssetPlaybackTraceV1';
const SOUND_ASSET_CATALOG_SETTING_KEY = 'soundAssetCatalogV1';
const CUSTOM_CATEGORY_ID_RE = /^user_(cue|texture|background)_[a-z0-9]{6,48}$/u;
const CUSTOM_CATEGORY_MODES = new Set(['cue', 'texture', 'background']);
const AVAILABLE_CATEGORY_CACHE_TTL_MS = 30_000;
const availableCategoryCache = new Map();
let playbackTraceWriteQueue = Promise.resolve();
let soundAssetCatalogPromise = null;
export const SOUND_ASSET_LIBRARY_OWNER_ID = 'local';
const SOUND_MIME_BY_EXTENSION = Object.freeze({
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
});

function soundCategoryCacheKey() {
  return 'local';
}

function invalidateAvailableCategoryCache() {
  availableCategoryCache.clear();
}

export function soundAssetCategoryFromPrefixedName(value = '') {
  const name = String(value || '').replace(/\\/g, '/').split('/').pop() || '';
  const match = name.match(/^([a-z0-9_]+)--/i);
  const category = String(match?.[1] || '').toLowerCase();
  return CATEGORY_IDS.has(category) || CUSTOM_CATEGORY_ID_RE.test(category) ? category : '';
}

export function stripSoundAssetCategoryPrefix(value = '') {
  return String(value || '').replace(/^[a-z0-9_]+--/i, '');
}

export function soundAssetMimeTypeForName(value = '') {
  const name = String(value || '').replace(/[?#].*$/, '').trim().toLowerCase();
  const extension = name.match(/\.([a-z0-9]+)$/)?.[1] || '';
  return SOUND_MIME_BY_EXTENSION[extension] || '';
}

export function normalizeSoundAssetAudioType(name = '', value = '') {
  const fromName = soundAssetMimeTypeForName(name);
  if (fromName) return fromName;
  const raw = String(value || '').split(';')[0].trim().toLowerCase();
  if (raw === 'audio/mp3' || raw === 'audio/x-mp3' || raw === 'audio/mpeg3') return 'audio/mpeg';
  if (raw === 'audio/x-m4a') return 'audio/mp4';
  if (raw.startsWith('audio/')) return raw;
  return 'audio/mpeg';
}

/**
 * iOS 对 Blob URL 的 MIME 比 Android 严格。旧备份、某些文件选择器会返回空类型或
 * application/octet-stream；播放前用原始文件名重建一个类型正确的 Blob，不改原始字节。
 */
export function createSoundAssetPlaybackBlob(row = {}) {
  const blob = row?.audioBlob instanceof Blob
    ? row.audioBlob
    : (row?.blob instanceof Blob ? row.blob : null);
  if (!(blob instanceof Blob) || blob.size <= 0) return null;
  const sourceName = row?.sourceName || row?.fileName || row?.name || '';
  const audioType = normalizeSoundAssetAudioType(sourceName, row?.audioType || blob.type);
  if (String(blob.type || '').toLowerCase() === audioType) return blob;
  return blob.slice(0, blob.size, audioType);
}

export function normalizeSoundAssetCategory(value = '') {
  const id = String(value || '').trim().toLowerCase();
  return CATEGORY_IDS.has(id) || CUSTOM_CATEGORY_ID_RE.test(id) ? id : 'other';
}

export function soundAssetCategoryMode(value = '') {
  const directMode = String(value || '').trim().toLowerCase();
  if (CUSTOM_CATEGORY_MODES.has(directMode)) return directMode;
  const id = normalizeSoundAssetCategory(value);
  const builtIn = SOUND_ASSET_CATEGORIES.find((item) => item.id === id);
  if (builtIn) return builtIn.mode || (builtIn.continuous ? 'background' : 'cue');
  return id.match(CUSTOM_CATEGORY_ID_RE)?.[1] || 'cue';
}

export function soundAssetCategoryLabel(value = '', definition = null) {
  const id = normalizeSoundAssetCategory(value);
  return SOUND_ASSET_CATEGORIES.find((item) => item.id === id)?.label
    || (definition?.id === id ? String(definition.label || '').trim() : '')
    || '自定义分类';
}

function createSoundAssetCustomCategoryId(mode = 'cue') {
  const normalizedMode = CUSTOM_CATEGORY_MODES.has(mode) ? mode : 'cue';
  const token = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 18)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `user_${normalizedMode}_${token.toLowerCase()}`;
}

function normalizeSoundAssetCustomCategory(row = {}) {
  const requestedMode = String(row.mode || '').trim().toLowerCase();
  const existingId = String(row.id || '').trim().toLowerCase();
  const existingMode = existingId.match(CUSTOM_CATEGORY_ID_RE)?.[1] || '';
  const mode = existingMode || (CUSTOM_CATEGORY_MODES.has(requestedMode) ? requestedMode : 'cue');
  const now = Date.now();
  return {
    id: CUSTOM_CATEGORY_ID_RE.test(existingId) ? existingId : createSoundAssetCustomCategoryId(mode),
    label: String(row.label || '').trim().slice(0, 40),
    hint: String(row.hint || '').trim().replace(/\s+/gu, ' ').slice(0, 180),
    mode,
    createdAt: Math.max(0, Number(row.createdAt || now) || now),
    updatedAt: Math.max(0, Number(row.updatedAt || now) || now),
  };
}

export async function listSoundAssetCustomCategories() {
  const row = await getRecord('settings', SOUND_CUSTOM_CATEGORY_SETTING_KEY).catch(() => null);
  return (Array.isArray(row?.value) ? row.value : [])
    .filter((item) => CUSTOM_CATEGORY_ID_RE.test(String(item?.id || '').trim().toLowerCase()))
    .map((item) => normalizeSoundAssetCustomCategory(item))
    .filter((item) => item.label && CUSTOM_CATEGORY_ID_RE.test(item.id));
}

async function writeSoundAssetCustomCategories(categories = []) {
  await putRecord('settings', {
    key: SOUND_CUSTOM_CATEGORY_SETTING_KEY,
    value: categories.map((item) => normalizeSoundAssetCustomCategory(item)),
    updatedAt: Date.now(),
  });
  invalidateAvailableCategoryCache();
}

export async function saveSoundAssetCustomCategory(row = {}) {
  const categories = await listSoundAssetCustomCategories();
  const normalized = normalizeSoundAssetCustomCategory({ ...row, updatedAt: Date.now() });
  if (!normalized.label) throw new Error('请填写分类名称');
  if (!normalized.hint) throw new Error('请填写什么时候使用这类声音');
  const duplicate = categories.find((item) => (
    item.id !== normalized.id && item.label.toLowerCase() === normalized.label.toLowerCase()
  ));
  if (duplicate) throw new Error('已经有同名分类');
  const index = categories.findIndex((item) => item.id === normalized.id);
  if (index >= 0) categories[index] = { ...categories[index], ...normalized };
  else categories.push(normalized);
  await writeSoundAssetCustomCategories(categories);
  return normalized;
}

export async function deleteSoundAssetCustomCategory(id = '') {
  const key = String(id || '').trim().toLowerCase();
  if (!CUSTOM_CATEGORY_ID_RE.test(key)) return;
  const categories = await listSoundAssetCustomCategories();
  await writeSoundAssetCustomCategories(categories.filter((item) => item.id !== key));
}

export async function listSoundAssetCategoryCatalog() {
  const custom = await listSoundAssetCustomCategories();
  return [
    ...SOUND_ASSET_CATEGORIES.map((item) => ({ ...item, builtIn: true })),
    ...custom.map((item) => ({ ...item, builtIn: false })),
  ];
}

function normalizeSoundAssetPlaybackTraceItem(row = {}) {
  return {
    assetId: String(row.assetId || '').trim(),
    category: normalizeSoundAssetCategory(row.category),
    name: String(row.name || '').trim().slice(0, 80),
    layer: ['cue', 'texture', 'background'].includes(String(row.layer || '').trim())
      ? String(row.layer).trim()
      : soundAssetCategoryMode(row.category),
    playedAt: Math.max(0, Number(row.playedAt || 0) || 0),
  };
}

export async function listRecentSoundAssetPlaybackTrace({ limit = 40 } = {}) {
  const row = await getRecord('settings', SOUND_PLAYBACK_TRACE_SETTING_KEY).catch(() => null);
  const max = Math.max(1, Math.min(100, Math.round(Number(limit || 40) || 40)));
  return (Array.isArray(row?.value) ? row.value : [])
    .map((item) => normalizeSoundAssetPlaybackTraceItem(item))
    .filter((item) => item.assetId && item.playedAt)
    .sort((left, right) => right.playedAt - left.playedAt)
    .slice(0, max);
}

export function recordSoundAssetPlayback(asset = {}, { category = '', layer = '' } = {}) {
  const next = normalizeSoundAssetPlaybackTraceItem({
    assetId: asset.id,
    category: category || asset.category,
    name: asset.name || asset.sourceName,
    layer,
    playedAt: Date.now(),
  });
  if (!next.assetId) return Promise.resolve();
  playbackTraceWriteQueue = playbackTraceWriteQueue.catch(() => {}).then(async () => {
    const current = await listRecentSoundAssetPlaybackTrace({ limit: 100 });
    const rows = [
      next,
      ...current.filter((item) => item.assetId !== next.assetId),
    ].slice(0, 40);
    await putRecord('settings', {
      key: SOUND_PLAYBACK_TRACE_SETTING_KEY,
      value: rows,
      updatedAt: Date.now(),
    });
  });
  return playbackTraceWriteQueue;
}

const WET_PROFILE_LABELS = Object.freeze({
  gentle: '轻缓',
  rhythm: '常规节奏',
  intense: '快速 / 强烈',
  natural: '自然',
  short: '短音',
  medium: '中段',
  long: '持续音',
});

/** 按素材名与真实时长给 wet 池做轻量自动档位，不要求用户重命名旧素材。 */
export function inferWetSoundAssetProfile(asset = {}) {
  const text = [asset?.sourceName, asset?.name, asset?.id]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  const durationMs = Math.max(0, Number(asset?.durationMs || 0));
  const pace = /(?:^|[\s_.-])(slow|gentle|soft|muted|light)(?:[\s_.-]|$)|轻柔|轻缓|缓慢|轻微/u.test(text)
    ? 'gentle'
    : (/(?:^|[\s_.-])(fast|intense|very[-_ ]?intense|hard|rapid)(?:[\s_.-]|$)|强烈|激烈|快速/u.test(text)
      ? 'intense'
      : (/rhythm|tempo|suction|pulse|节奏|律动/u.test(text) ? 'rhythm' : 'natural'));
  const length = /(?:^|[\s_.-])(long|loop|sustain|continuous)(?:[\s_.-]|$)|持续|长段/u.test(text)
    || durationMs >= 2800
    ? 'long'
    : (/(?:^|[\s_.-])(short|hit|one[-_ ]?shot)(?:[\s_.-]|$)|短音|点音/u.test(text)
      || (durationMs > 0 && durationMs <= 1400)
      ? 'short'
      : 'medium');
  return {
    pace,
    length,
    label: `${WET_PROFILE_LABELS[pace]} · ${WET_PROFILE_LABELS[length]}`,
  };
}

export function createSoundAssetId() {
  if (globalThis.crypto?.randomUUID) return `sound-${globalThis.crypto.randomUUID()}`;
  return `sound-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeSoundAssetRow(row = {}) {
  const now = Date.now();
  const blob = row.audioBlob instanceof Blob ? row.audioBlob : null;
  const audioType = normalizeSoundAssetAudioType(
    row.sourceName || row.fileName || '',
    row.audioType || blob?.type,
  );
  return {
    ...row,
    id: String(row.id || createSoundAssetId()).trim(),
    // 音频库属于当前浏览器 / PWA / APK，而不是某一个用户身份。
    // 旧记录仍保留原 ownerId；它们在 listSoundAssets 中会一并读取，编辑后再归入本机作用域。
    ownerId: SOUND_ASSET_LIBRARY_OWNER_ID,
    name: String(row.name || '未命名音频').trim().slice(0, 80) || '未命名音频',
    category: normalizeSoundAssetCategory(row.category),
    categoryLabel: String(row.categoryLabel || '').trim().slice(0, 40),
    categoryHint: String(row.categoryHint || '').trim().replace(/\s+/gu, ' ').slice(0, 180),
    categoryMode: soundAssetCategoryMode(row.categoryMode || row.category),
    enabled: row.enabled !== false,
    mixGain: Math.max(0.5, Math.min(2, Number(row.mixGain || 1) || 1)),
    texturePlayback: ['auto', 'shot', 'span'].includes(String(row.texturePlayback || '').trim())
      ? String(row.texturePlayback).trim()
      : 'auto',
    audioType,
    audioBlob: blob,
    durationMs: Math.max(0, Math.round(Number(row.durationMs || 0) || 0)),
    size: Math.max(0, Math.round(Number(row.size ?? blob?.size ?? 0) || 0)),
    sourceName: String(row.sourceName || '').trim().slice(0, 160),
    createdAt: Math.max(0, Number(row.createdAt || now) || now),
    updatedAt: now,
  };
}

export async function saveSoundAsset(row = {}) {
  const category = normalizeSoundAssetCategory(row.category);
  const builtIn = SOUND_ASSET_CATEGORIES.find((item) => item.id === category) || null;
  const custom = builtIn
    ? null
    : (await listSoundAssetCustomCategories()).find((item) => item.id === category) || null;
  const normalized = normalizeSoundAssetRow({
    ...row,
    category,
    categoryLabel: builtIn?.label || custom?.label || row.categoryLabel,
    categoryHint: builtIn?.hint || custom?.hint || row.categoryHint,
    categoryMode: builtIn?.mode || custom?.mode || soundAssetCategoryMode(category),
  });
  if (!(normalized.audioBlob instanceof Blob) || normalized.audioBlob.size <= 0) {
    throw new Error('没有可保存的音频');
  }
  await putRecord('soundAssets', normalized);
  // iOS 的 Blob 写入失败有时要到下一次读取才暴露；导入成功前立即从 IndexedDB 回读，
  // 不让页面只凭内存中的对象显示“已导入”。
  const stored = await getRecord('soundAssets', normalized.id);
  if (!(stored?.audioBlob instanceof Blob) || stored.audioBlob.size !== normalized.audioBlob.size) {
    await deleteRecord('soundAssets', normalized.id).catch(() => {});
    throw new Error('音频未完整写入本机存储，请检查可用空间后重试');
  }
  await updateSoundAssetCatalogEntry(normalized).catch(() => { soundAssetCatalogPromise = null; });
  invalidateAvailableCategoryCache();
  return normalized;
}

const SOUND_ASSET_MUTABLE_METADATA_KEYS = Object.freeze([
  'name',
  'category',
  'enabled',
  'mixGain',
  'texturePlayback',
]);

async function cloneSoundAssetBlobForRewrite(row = {}) {
  const source = createSoundAssetPlaybackBlob(row);
  if (!(source instanceof Blob) || source.size <= 0) {
    throw new Error('这条音频的本地文件已经失效');
  }
  const bytes = await source.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength !== source.size) {
    throw new Error('这条音频的本地文件读取不完整');
  }
  return new Blob([bytes], { type: source.type || 'audio/mpeg' });
}

/**
 * 只修改素材元数据。iOS WebKit 不适合把刚从 IndexedDB 取出的 Blob 句柄原样覆盖回
 * 同一个记录：写入当下可能正常，重新进页面后却会变成不可读。这里先复制真实字节，
 * 再交给完整保存与回读校验，启停、改名等操作都不会伤到原音频。
 */
export async function updateSoundAssetMetadata(id = '', patch = {}) {
  const key = String(id || '').trim();
  if (!key) throw new Error('没有找到这条音频');
  const current = await getSoundAsset(key);
  if (!current) throw new Error('这条音频已经不存在');
  const metadata = {};
  SOUND_ASSET_MUTABLE_METADATA_KEYS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(patch, field)) metadata[field] = patch[field];
  });
  const audioBlob = await cloneSoundAssetBlobForRewrite(current);
  return saveSoundAsset({ ...current, ...metadata, audioBlob });
}

export async function getSoundAsset(id = '') {
  const row = await getRecord('soundAssets', String(id || '').trim());
  return row || null;
}

function soundAssetSummary(row = {}) {
  const { audioBlob: _audioBlob, blob: _blob, ...summary } = row || {};
  const source = _audioBlob instanceof Blob ? _audioBlob : (_blob instanceof Blob ? _blob : null);
  return {
    ...summary,
    size: Math.max(0, Number(summary.size ?? source?.size ?? 0) || 0),
    hasAudio: !!(source?.size || Number(summary.size || 0) > 0),
  };
}

async function writeSoundAssetCatalog(rows = []) {
  const summaries = (Array.isArray(rows) ? rows : []).map(soundAssetSummary);
  await putRecord('settings', {
    key: SOUND_ASSET_CATALOG_SETTING_KEY,
    value: { version: 1, complete: true, count: summaries.length, assets: summaries },
    updatedAt: Date.now(),
  });
  return summaries;
}

async function buildSoundAssetCatalog() {
  const rows = [];
  await forEachStoreRecordBatched('soundAssets', (row) => {
    rows.push(soundAssetSummary(row));
  }, { batchSize: 1 });
  await writeSoundAssetCatalog(rows);
  return rows;
}

async function loadSoundAssetCatalog() {
  if (!soundAssetCatalogPromise) {
    soundAssetCatalogPromise = (async () => {
      const [stored, count] = await Promise.all([
        getRecord('settings', SOUND_ASSET_CATALOG_SETTING_KEY).catch(() => null),
        countRecords('soundAssets'),
      ]);
      const value = stored?.value;
      if (value?.version === 1
        && value.complete === true
        && Array.isArray(value.assets)
        && Number(value.count || 0) === count
        && value.assets.length === count) {
        return value.assets.map(soundAssetSummary);
      }
      return buildSoundAssetCatalog();
    })().catch((error) => {
      soundAssetCatalogPromise = null;
      throw error;
    });
  }
  return soundAssetCatalogPromise;
}

async function updateSoundAssetCatalogEntry(row = {}) {
  const current = await loadSoundAssetCatalog();
  const summary = soundAssetSummary(row);
  const next = [summary, ...current.filter((item) => item.id !== summary.id)];
  soundAssetCatalogPromise = Promise.resolve(next);
  await writeSoundAssetCatalog(next);
}

export async function listSoundAssets({
  ownerId = '',
  category = '',
  categories = [],
  metadataOnly = false,
  limitPerCategory = 0,
} = {}) {
  // ownerId 仅为旧调用兼容参数。素材是“本机音频库”，切换身份后也必须继续可见；
  // 逐条读取同时能找回历史版本按用户 ID 保存、后来因身份切换而看似丢失的音频。
  void ownerId;
  const normalizedCategory = category ? normalizeSoundAssetCategory(category) : '';
  const categorySet = new Set((Array.isArray(categories) ? categories : [])
    .map((value) => normalizeSoundAssetCategory(value))
    .filter(Boolean));
  let summaries = (await loadSoundAssetCatalog())
    .filter((row) => {
      if (normalizedCategory && row?.category !== normalizedCategory) return false;
      if (categorySet.size && !categorySet.has(normalizeSoundAssetCategory(row?.category))) return false;
      return true;
    })
    .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));
  const perCategoryLimit = Math.max(0, Number(limitPerCategory || 0) || 0);
  if (perCategoryLimit) {
    const seen = new Map();
    summaries = summaries.filter((row) => {
      const key = normalizeSoundAssetCategory(row?.category);
      const count = Number(seen.get(key) || 0);
      if (count >= perCategoryLimit) return false;
      seen.set(key, count + 1);
      return true;
    });
  }
  const rows = metadataOnly
    ? summaries
    : (await getMany('soundAssets', summaries.map((row) => row.id))).filter(Boolean);
  return rows.sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));
}

export function listSoundAssetSummaries(options = {}) {
  return listSoundAssets({ ...options, metadataOnly: true });
}

/**
 * 返回本机真正有可播放素材的分类。结果做短时缓存，避免每轮聊天提示都重复
 * 把音频 Blob 从 IndexedDB 载入内存；保存、启停或删除素材时会主动失效。
 */
export async function listAvailableSoundAssetCategories({
  ownerId = '',
  refresh = false,
  includeSpecs = false,
} = {}) {
  const key = soundCategoryCacheKey();
  const cached = availableCategoryCache.get(key);
  if (!refresh && cached && Date.now() - cached.ts < AVAILABLE_CATEGORY_CACHE_TTL_MS) {
    return includeSpecs ? cached.specs.map((item) => ({ ...item })) : [...cached.categories];
  }
  const rows = await listSoundAssetSummaries({ ownerId });
  const categories = [...new Set(rows
    .filter((row) => row?.enabled !== false && row?.hasAudio === true)
    .map((row) => normalizeSoundAssetCategory(row.category))
    .filter((id) => id && id !== 'other'))];
  const customDefinitions = await listSoundAssetCustomCategories();
  const specs = categories.map((id) => {
    const builtIn = SOUND_ASSET_CATEGORIES.find((item) => item.id === id);
    const custom = customDefinitions.find((item) => item.id === id);
    const sample = rows.find((item) => item.category === id);
    return {
      id,
      label: builtIn?.label || custom?.label || sample?.categoryLabel || '自定义分类',
      hint: builtIn?.hint || custom?.hint || sample?.categoryHint || '',
      mode: builtIn?.mode || custom?.mode || sample?.categoryMode || soundAssetCategoryMode(id),
    };
  });
  availableCategoryCache.set(key, { ts: Date.now(), categories, specs });
  return includeSpecs ? specs.map((item) => ({ ...item })) : [...categories];
}

export async function deleteSoundAsset(id = '') {
  const key = String(id || '').trim();
  if (!key) return;
  await deleteRecord('soundAssets', key);
  const current = await loadSoundAssetCatalog().catch(() => []);
  const next = current.filter((item) => item.id !== key);
  soundAssetCatalogPromise = Promise.resolve(next);
  await writeSoundAssetCatalog(next).catch(() => { soundAssetCatalogPromise = null; });
  invalidateAvailableCategoryCache();
}

export function createSoundAssetPlayback(row = {}) {
  const blob = createSoundAssetPlaybackBlob(row);
  if (!(blob instanceof Blob)) return { url: '', revoke() {} };
  const url = URL.createObjectURL(blob);
  return {
    url,
    revoke() {
      try { URL.revokeObjectURL(url); } catch (_) {}
    },
  };
}
