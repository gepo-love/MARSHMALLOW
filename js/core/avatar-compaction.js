// 头像体积收敛：早期版本上传角色/用户头像不压缩，相机直出图能把单条记录堆到几 MB。
// 通讯录、聊天列表、我的空间等几乎所有页面都会把头像原样拼进一段 <img src> 列表 HTML，
// 角色一多、头像一大，就是切页卡顿甚至低内存机型闷死渲染进程的常见根因。
// 这里做两件事：渲染侧（scrapbook-illustrations.js）对超大头像直接跳过内嵌；这里后台一次性把
// 历史遗留的超大头像收敛到正常压缩后的尺寸，收敛完成后渲染侧自然能正常显示真实头像。
import * as db from './db.js';

export const OVERSIZED_AVATAR_THRESHOLD_CHARS = 400_000; // base64 字符数，约对应压缩前 ~300KB 原始图

export function isOversizedAvatarDataUrl(value) {
  return typeof value === 'string'
    && value.length > OVERSIZED_AVATAR_THRESHOLD_CHARS
    && /^data:image\//i.test(value);
}

function decodeAndResizeDataUrl(dataUrl, { maxSize = 512, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') { reject(new Error('no Image')); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const longest = Math.max(img.naturalWidth || maxSize, img.naturalHeight || maxSize);
        const scale = Math.min(1, maxSize / longest);
        const w = Math.max(1, Math.round((img.naturalWidth || maxSize) * scale));
        const h = Math.max(1, Math.round((img.naturalHeight || maxSize) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('头像解码失败'));
    img.src = dataUrl;
  });
}

/**
 * 即时头像写入使用：聊天原图可能远大于头像渲染保护阈值，直接落库会被 UI
 * 当作超大历史头像隐藏，视觉上像“换回默认头像”。普通 URL 与已经足够小的
 * data URL 原样保留，只有超大 data URL 才在写入前收敛。
 */
export async function compactAvatarDataUrlForStorage(value = '') {
  const avatar = String(value || '').trim();
  if (!isOversizedAvatarDataUrl(avatar)) return avatar;
  return decodeAndResizeDataUrl(avatar, { maxSize: 512, quality: 0.82 });
}

async function compactStoreAvatars(storeName, getAvatar, withAvatar) {
  let changed = 0;
  await db.forEachStoreRecordBatched(storeName, async (row, _index, _store, recordKey) => {
    const avatar = getAvatar(row);
    if (!isOversizedAvatarDataUrl(avatar)) return;
    let riskToken = globalThis.__mm_mark_risky_activity__?.('avatar-compaction', {
      phase: 'decode',
      storeName,
      recordKey: String(recordKey ?? row?.id ?? ''),
    }) || '';
    try {
      const resized = await decodeAndResizeDataUrl(avatar, { maxSize: 512, quality: 0.82 });
      riskToken = globalThis.__mm_mark_risky_activity__?.('avatar-compaction', {
        phase: 'write',
        storeName,
        recordKey: String(recordKey ?? row?.id ?? ''),
      }) || riskToken;
      // 解码在旧机型上可能持续数秒。写入前必须在同一事务里核对当前头像，并基于最新记录合并，
      // 否则用户期间更换的头像或其它资料会被启动时读到的旧快照整条覆盖。
      const result = await db.updateRecord(storeName, row.id, (current) => {
        if (!current || getAvatar(current) !== avatar) return null;
        return withAvatar(current, resized);
      });
      if (result.updated) changed += 1;
    } catch (_) { /* 单条失败跳过，不阻断其它记录 */ }
    finally {
      if (riskToken) globalThis.__mm_clear_risky_activity__?.(riskToken);
    }
  }, {
    // 记录内是 base64 图片，必须一次只克隆一条，让前一张解码图尽快释放。
    batchSize: 1,
    onBatch: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  return changed;
}

async function compactChatGroupImages() {
  let changed = 0;
  await db.forEachStoreRecordBatched('chats', async (row, _index, _store, recordKey) => {
    const gs = row?.groupSettings;
    if (!gs || typeof gs !== 'object') return;
    const patch = {};
    const sourceAvatar = gs.avatar;
    const sourceWallpaper = gs.wallpaper;
    if (!isOversizedAvatarDataUrl(sourceAvatar) && !isOversizedImageWallpaper(sourceWallpaper)) return;
    let riskToken = globalThis.__mm_mark_risky_activity__?.('avatar-compaction', {
      phase: 'decode-chat',
      storeName: 'chats',
      recordKey: String(recordKey ?? row?.id ?? ''),
    }) || '';
    try {
      if (isOversizedAvatarDataUrl(sourceAvatar)) {
        try { patch.avatar = await decodeAndResizeDataUrl(sourceAvatar, { maxSize: 512, quality: 0.82 }); } catch (_) {}
      }
      // 会话壁纸压缩目标更大（背景图不止头像大小），沿用与美化壁纸一致的量级。
      if (isOversizedImageWallpaper(sourceWallpaper)) {
        try { patch.wallpaper = await decodeAndResizeDataUrl(sourceWallpaper, { maxSize: 1600, quality: 0.82 }); } catch (_) {}
      }
      if (Object.keys(patch).length) {
        riskToken = globalThis.__mm_mark_risky_activity__?.('avatar-compaction', {
          phase: 'write-chat',
          storeName: 'chats',
          recordKey: String(recordKey ?? row?.id ?? ''),
        }) || riskToken;
        const result = await db.updateRecord('chats', row.id, (current) => {
          const currentSettings = current?.groupSettings;
          if (!current || !currentSettings || typeof currentSettings !== 'object') return null;
          const safePatch = {};
          if (patch.avatar && currentSettings.avatar === sourceAvatar) safePatch.avatar = patch.avatar;
          if (patch.wallpaper && currentSettings.wallpaper === sourceWallpaper) safePatch.wallpaper = patch.wallpaper;
          if (!Object.keys(safePatch).length) return null;
          return {
            ...current,
            groupSettings: {
              ...currentSettings,
              ...safePatch,
            },
          };
        });
        if (result.updated) changed += 1;
      }
    } finally {
      if (riskToken) globalThis.__mm_clear_risky_activity__?.(riskToken);
    }
  }, {
    batchSize: 1,
    onBatch: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  return changed;
}

function isOversizedImageWallpaper(value) {
  return typeof value === 'string' && value.length > 900_000 && /^data:image\//i.test(value);
}

/** 后台一次性收敛角色/用户/会话历史遗留的超大头像与壁纸；不在任何页面渲染路径上调用，由 boot 完成后空闲触发。 */
export async function compactOversizedContactAvatars() {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return { changed: 0 };
  // 收敛过程中逐条 putRecord 会逐条触发缓存失效通知；批量收敛时先压住，最后统一发一次，
  // 避免角色多时通讯录等页面的内存缓存被反复清空重建。
  db.setSuppressWriteNotify(true);
  let charactersChanged = 0;
  let usersChanged = 0;
  let chatsChanged = 0;
  try {
    charactersChanged = await compactStoreAvatars(
      'characters',
      (row) => row?.avatar,
      (row, avatar) => ({ ...row, avatar }),
    );
    usersChanged = await compactStoreAvatars(
      'users',
      (row) => row?.avatar,
      (row, avatar) => ({ ...row, avatar }),
    );
    chatsChanged = await compactChatGroupImages();
  } finally {
    db.setSuppressWriteNotify(false);
    db.flushWriteListeners();
  }
  return {
    changed: charactersChanged + usersChanged + chatsChanged,
    charactersChanged,
    usersChanged,
    chatsChanged,
  };
}
