import * as db from './db.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function makeAssetId() {
  return `image-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function saveWallpaperAssetSource(value, name = '聊天壁纸') {
  const source = String(value || '').trim();
  const existing = (await db.getAllRecords('beautifyAssets').catch(() => []))
    .find((asset) => asset?.type === 'image' && asset.dataUrl === source);
  if (existing) return existing;

  const dataMatch = source.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  let record;
  if (dataMatch) {
    const size = Math.round(Math.max(0, source.length - dataMatch[0].length) * 0.75);
    if (size > MAX_IMAGE_BYTES) throw new Error('图片压缩后仍超过 4MB');
    record = {
      id: makeAssetId(),
      type: 'image',
      name,
      mime: dataMatch[1],
      size,
      dataUrl: source,
      updatedAt: Date.now(),
    };
  } else {
    let parsed;
    try {
      parsed = new URL(source);
    } catch (_) {
      throw new Error('图片链接格式不正确');
    }
    if (parsed.protocol !== 'https:') throw new Error('请使用 HTTPS 图片直链');
    record = {
      id: makeAssetId(),
      type: 'image',
      name: name || '外链壁纸',
      mime: '',
      size: 0,
      dataUrl: parsed.href,
      remote: true,
      updatedAt: Date.now(),
    };
  }
  await db.putRecord('beautifyAssets', record);
  return record;
}

function wallpaperSettings(chat = {}) {
  return chat?.groupSettings && typeof chat.groupSettings === 'object'
    ? chat.groupSettings
    : {};
}

function isStoredWallpaperSource(value = '') {
  return /^(?:data:image\/|https:\/\/)/i.test(String(value || '').trim());
}

export function chatWallpaperNeedsCompaction(chat = {}) {
  const settings = wallpaperSettings(chat);
  return !!String(settings.wallpaperAssetId || '').trim()
    || isStoredWallpaperSource(settings.wallpaper);
}

export function chatWallpaperNeedsHydration(chat = {}) {
  const settings = wallpaperSettings(chat);
  return !!String(settings.wallpaperAssetId || '').trim()
    && !String(settings.wallpaper || '').trim();
}

/** 落库前把壁纸正文收进素材库，会话只保留轻量资源 ID。 */
export async function compactChatWallpaperReference(chat = {}) {
  if (!chat || typeof chat !== 'object') return chat;
  const settings = wallpaperSettings(chat);
  let assetId = String(settings.wallpaperAssetId || '').trim();
  const wallpaper = String(settings.wallpaper || '').trim();
  if (!assetId && isStoredWallpaperSource(wallpaper)) {
    const asset = await saveWallpaperAssetSource(
      wallpaper,
      wallpaper.startsWith('data:image/') ? '聊天壁纸' : '外链壁纸',
    );
    assetId = String(asset?.id || '').trim();
  }
  if (!assetId) return chat;
  const groupSettings = { ...settings, wallpaperAssetId: assetId };
  delete groupSettings.wallpaper;
  return { ...chat, groupSettings };
}

/** 读取会话时临时解析素材，供现有同步渲染链使用；解析结果不会再次写进数据库。 */
export async function hydrateChatWallpaperReference(chat) {
  if (!chat || typeof chat !== 'object') return chat;
  const settings = wallpaperSettings(chat);
  const assetId = String(settings.wallpaperAssetId || '').trim();
  if (!assetId || String(settings.wallpaper || '').trim()) return chat;
  const asset = await db.getRecord('beautifyAssets', assetId).catch(() => null);
  const wallpaper = String(asset?.dataUrl || '').trim();
  if (!isStoredWallpaperSource(wallpaper)) return chat;
  return { ...chat, groupSettings: { ...settings, wallpaper } };
}

/** 删除素材前保住已经应用到会话的壁纸；下次保存或导出时会重新去重入库。 */
export async function detachChatWallpaperAsset(asset = {}) {
  const assetId = String(asset?.id || '').trim();
  const wallpaper = String(asset?.dataUrl || '').trim();
  if (!assetId || !isStoredWallpaperSource(wallpaper)) return 0;
  let detached = 0;
  await db.forEachStoreRecordBatched('chats', async (chat) => {
    const settings = wallpaperSettings(chat);
    if (String(settings.wallpaperAssetId || '').trim() !== assetId) return;
    const groupSettings = { ...settings, wallpaper };
    delete groupSettings.wallpaperAssetId;
    await db.putRecord('chats', { ...chat, groupSettings });
    detached += 1;
  }, { batchSize: 8 });
  return detached;
}

/** 备份前一次性收拢旧聊天中重复保存的 base64/HTTPS 壁纸。 */
export async function migrateLegacyChatWallpaperAssets() {
  let migrated = 0;
  const knownAssets = new Map((await db.getAllRecords('beautifyAssets').catch(() => []))
    .filter((asset) => asset?.type === 'image' && isStoredWallpaperSource(asset.dataUrl))
    .map((asset) => [String(asset.dataUrl).trim(), asset]));
  await db.forEachStoreRecordBatched('chats', async (chat) => {
    const settings = wallpaperSettings(chat);
    if (String(settings.wallpaperAssetId || '').trim()) {
      if (Object.prototype.hasOwnProperty.call(settings, 'wallpaper')) {
        const groupSettings = { ...settings };
        delete groupSettings.wallpaper;
        await db.putRecord('chats', { ...chat, groupSettings });
        migrated += 1;
      }
      return;
    }
    if (!isStoredWallpaperSource(settings.wallpaper)) return;
    const wallpaper = String(settings.wallpaper).trim();
    let asset = knownAssets.get(wallpaper);
    if (!asset) {
      asset = await saveWallpaperAssetSource(
        wallpaper,
        wallpaper.startsWith('data:image/') ? '聊天壁纸' : '外链壁纸',
      );
      if (asset) knownAssets.set(wallpaper, asset);
    }
    const groupSettings = { ...settings, wallpaperAssetId: String(asset?.id || '').trim() };
    delete groupSettings.wallpaper;
    const compacted = groupSettings.wallpaperAssetId ? { ...chat, groupSettings } : chat;
    if (compacted !== chat) {
      await db.putRecord('chats', compacted);
      migrated += 1;
    }
  }, { batchSize: 8 });
  return migrated;
}
