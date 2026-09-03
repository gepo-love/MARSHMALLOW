import * as db from './db.js';
import {
  CHAT_IMAGE_INLINE_MAX_BYTES,
  dataUrlApproxBytes,
  fileToOptimizedChatImageDataUrl,
} from './chat/chat-image-utils.js';

const JOURNAL_KEY = '__mm_media_compaction_journal_v1__';

function yieldToUi(delay = 0) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function settingAssetCategory(recordKey = '', path = '') {
  const probe = `${recordKey} ${path}`;
  if (/voiceAudioCache|callLineVoice/i.test(probe)) return '语音缓存';
  if (/radioAudioBlob|radioEpisode|podcast/i.test(probe)) return '电台与节目音频';
  if (/characterPhone/i.test(probe)) return '角色手机媒体';
  if (/companion/i.test(probe)) return '陪伴资源';
  if (/offline|dateSession/i.test(probe)) return '线下模式资源';
  if (/appearance|wallpaper|background|desktop|theme|customCss|customHtml/i.test(probe)) {
    return '主题与桌面资源';
  }
  return '其它设置媒体';
}

function categoryFor(storeName, path = '', recordKey = '') {
  if (storeName === 'messages') return '聊天图片';
  if (storeName === 'momentsPosts') return '朋友圈图片';
  if (storeName === 'weiboPosts') return '微博图片';
  if (storeName === 'forumThreads') return '论坛图片';
  if (storeName === 'characters' || storeName === 'users') return '头像与角色图片';
  if (storeName === 'chats') return '聊天头像与壁纸';
  if (storeName === 'beautifyAssets') return '美化素材库';
  if (storeName === 'musicTracks') return '本地音乐';
  if (storeName === 'soundAssets') return '音效资源';
  if (storeName === 'settings') return settingAssetCategory(recordKey, path);
  return '其它媒体';
}

function contributorLabel(storeName, recordKey = '') {
  const key = String(recordKey || '').trim();
  if (storeName === 'beautifyAssets') return key ? `美化素材 · ${key.slice(0, 30)}` : '美化素材';
  if (storeName === 'soundAssets') return key ? `音效 · ${key.slice(0, 30)}` : '音效';
  if (storeName === 'settings') {
    if (/voiceAudioCache/i.test(key)) return '聊天语音缓存';
    if (/callLineVoice/i.test(key)) return '通话语音缓存';
    if (/radioAudioBlob|radioEpisode/i.test(key)) return '电台与节目音频';
    if (/appearance/i.test(key)) return '主题与桌面设置';
    if (/characterPhone/i.test(key)) return '角色手机媒体';
    if (/companion/i.test(key)) return '陪伴资源';
    return key ? `设置项 · ${key.slice(0, 36)}` : '设置项';
  }
  const names = {
    messages: '聊天图片',
    momentsPosts: '朋友圈动态',
    weiboPosts: '微博动态',
    forumThreads: '论坛内容',
    characters: '角色图片',
    users: '用户头像',
    chats: '聊天壁纸或头像',
    musicTracks: '本地音乐',
  };
  return names[storeName] || storeName || '其它媒体';
}

function addMetric(report, category, kind, bytes, context = {}) {
  const size = Math.max(0, Number(bytes || 0));
  if (!size) return;
  const row = report.categories[category] || { imageBytes: 0, audioBytes: 0, images: 0, audio: 0 };
  if (kind === 'image') {
    row.imageBytes += size;
    row.images += 1;
    report.imageBytes += size;
    report.images += 1;
  } else {
    row.audioBytes += size;
    row.audio += 1;
    report.audioBytes += size;
    report.audio += 1;
  }
  report.categories[category] = row;
  const contributorKey = `${category}\u0000${context.storeName || ''}\u0000${context.recordKey || ''}`;
  const contributor = report.contributors[contributorKey] || {
    category,
    storeName: String(context.storeName || ''),
    recordKey: String(context.recordKey || ''),
    label: contributorLabel(context.storeName, context.recordKey),
    bytes: 0,
    items: 0,
  };
  contributor.bytes += size;
  contributor.items += 1;
  report.contributors[contributorKey] = contributor;
}

function inspectMediaValue(value, report, storeName, path = '', ancestors = new Set(), recordKey = '') {
  if (typeof value === 'string') {
    if (/^data:image\//i.test(value)) {
      addMetric(report, categoryFor(storeName, path, recordKey), 'image', dataUrlApproxBytes(value), {
        storeName,
        recordKey,
      });
    }
    return;
  }
  if (value instanceof Blob) {
    const type = String(value.type || '');
    if (/^audio\//i.test(type) || /audio|voice|sound|music/i.test(path)) {
      addMetric(report, categoryFor(storeName, path, recordKey), 'audio', value.size, {
        storeName,
        recordKey,
      });
    }
    return;
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) return;
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectMediaValue(item, report, storeName, `${path}[${index}]`, ancestors, recordKey));
  } else {
    Object.entries(value).forEach(([key, item]) => {
      inspectMediaValue(item, report, storeName, path ? `${path}.${key}` : key, ancestors, recordKey);
    });
  }
  ancestors.delete(value);
}

export async function scanMediaStorage(options = {}) {
  const throwIfAborted = () => {
    if (!options.signal?.aborted) return;
    const error = new Error('扫描已停止');
    error.name = 'AbortError';
    throw error;
  };
  const report = {
    imageBytes: 0,
    audioBytes: 0,
    images: 0,
    audio: 0,
    oversizedMessageImages: 0,
    oversizedMessageBytes: 0,
    duplicateMessageImages: 0,
    duplicateMessageBytes: 0,
    categories: {},
    contributors: {},
  };
  const stores = Object.keys(db.STORES);
  let lastProgressPaintAt = 0;
  const reportProgress = (detail, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressPaintAt < 120) return false;
    lastProgressPaintAt = now;
    options.onProgress?.(detail);
    return true;
  };
  for (let storeIndex = 0; storeIndex < stores.length; storeIndex += 1) {
    throwIfAborted();
    const storeName = stores[storeIndex];
    let rows = 0;
    const heavyStore = [
      'messages',
      'settings',
      'soundAssets',
      'momentsPosts',
      'weiboPosts',
      'forumThreads',
      'musicTracks',
      'beautifyAssets',
    ].includes(storeName);
    const inspectRecord = async (record, _rowIndex, _store, recordKey) => {
      throwIfAborted();
      rows += 1;
      if (heavyStore) {
        reportProgress({
          storeName,
          storeIndex,
          totalStores: stores.length,
          rows,
          recordKey: String(recordKey ?? record?.key ?? record?.id ?? ''),
        });
      }
      if (storeName === 'messages' && record?.type === 'image') {
        const content = String(record.content || '');
        const metaUrl = String(record.metadata?.url || '');
        const source = /^data:image\//i.test(content) ? content : metaUrl;
        const bytes = /^data:image\//i.test(source) ? dataUrlApproxBytes(source) : 0;
        if (bytes > CHAT_IMAGE_INLINE_MAX_BYTES) {
          report.oversizedMessageImages += 1;
          report.oversizedMessageBytes += bytes;
        }
        if (content && content === metaUrl && /^data:image\//i.test(content)) {
          report.duplicateMessageImages += 1;
          report.duplicateMessageBytes += bytes;
        }
      }
      inspectMediaValue(record, report, storeName, '', new Set(), String(recordKey ?? record?.key ?? record?.id ?? ''));
    };
    if (storeName === 'settings' || storeName === 'soundAssets') {
      // Read keys first so the UI can name a large record before IndexedDB clones its Blob or
      // Base64 payload. This also guarantees only one large value is live in this loop at a time.
      const keys = await db.getAllKeys(storeName);
      for (const recordKey of keys) {
        throwIfAborted();
        reportProgress({
          storeName,
          storeIndex,
          totalStores: stores.length,
          rows,
          recordKey: String(recordKey ?? ''),
        });
        const record = await db.getRecord(storeName, recordKey);
        if (record) await inspectRecord(record, rows, storeName, recordKey);
        // 大 Blob 仍逐条释放；只取消每条记录前后的双重 setTimeout。
        if (rows % 8 === 0) await yieldToUi();
      }
    } else await db.forEachStoreRecordBatched(storeName, inspectRecord, {
      // Each soundAssets row contains its audio Blob. Holding 20 imported sounds in one batch
      // creates an avoidable memory spike on Android WebView, even though inspection only needs size.
      // 社区动态等记录可能各自内嵌数 MB 的 Base64 图片。一次克隆多条会让
      // iOS Safari / PWA 瞬时占用陡增并被系统终止，因此所有媒体重表逐条读取。
      // messages 通常数量最大；逐条开启事务并 setTimeout 会让两万条记录耗时数分钟。
      // 小批量仍限制同时存活的 Base64 体积，但把事务/调度开销降到原来的约 1/8。
      batchSize: storeName === 'messages' ? 8 : (heavyStore ? 1 : 20),
      onBatch: async () => {
        throwIfAborted();
        reportProgress({ storeName, storeIndex, totalStores: stores.length, rows }, true);
        await yieldToUi();
      },
    });
    reportProgress({ storeName, storeIndex: storeIndex + 1, totalStores: stores.length, rows }, true);
    await yieldToUi();
  }
  report.contributors = Object.values(report.contributors)
    .sort((a, b) => b.bytes - a.bytes);
  report.totalBytes = report.imageBytes + report.audioBytes;
  return report;
}

function dataUrlToBlob(dataUrl) {
  const raw = String(dataUrl || '');
  const comma = raw.indexOf(',');
  const header = comma > 0 ? raw.slice(0, comma) : '';
  if (comma < 0 || !/^data:[^,]*;base64$/i.test(header)) return null;
  const type = header.slice(5).split(/[;,]/)[0] || 'image/jpeg';
  const encodedStart = comma + 1;
  const parts = [];
  const step = 256 * 1024;
  for (let offset = encodedStart; offset < raw.length; offset += step) {
    const binary = atob(raw.slice(offset, Math.min(raw.length, offset + step)));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    parts.push(bytes);
  }
  return new Blob(parts, { type });
}

function saveJournal(value) {
  try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(value)); } catch (_) {}
}

function stripInlineImagePayloads(value, stats, ancestors = new Set()) {
  if (typeof value === 'string') {
    if (!/^data:image\//i.test(value)) return { value, changed: false };
    stats.payloads += 1;
    stats.bytes += dataUrlApproxBytes(value);
    return { value: '', changed: true };
  }
  if (!value || typeof value !== 'object' || value instanceof Blob || ancestors.has(value)) {
    return { value, changed: false };
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = [];
    value.forEach((item) => {
      const stripped = stripInlineImagePayloads(item, stats, ancestors);
      changed ||= stripped.changed;
      if (!(stripped.changed && stripped.value === '')) next.push(stripped.value);
    });
    ancestors.delete(value);
    return { value: changed ? next : value, changed };
  }
  let changed = false;
  const next = { ...value };
  Object.entries(value).forEach(([key, item]) => {
    const stripped = stripInlineImagePayloads(item, stats, ancestors);
    if (!stripped.changed) return;
    changed = true;
    next[key] = stripped.value;
  });
  ancestors.delete(value);
  return { value: changed ? next : value, changed };
}

const CLEARABLE_IMAGE_CATEGORIES = Object.freeze({
  '朋友圈图片': 'momentsPosts',
  '微博图片': 'weiboPosts',
  '论坛图片': 'forumThreads',
});

/**
 * 清除社区内容中的本地图片载荷，但保留帖子、正文、评论、时间线与外链图片。
 * 逐条读取和写回，避免清理本身在 iOS 上制造大内存峰值。
 */
export async function clearLocalMediaCategory(category, options = {}) {
  const storeName = CLEARABLE_IMAGE_CATEGORIES[String(category || '')];
  if (!storeName) throw new Error('这类媒体暂不支持直接清理');
  const result = {
    category: String(category || ''),
    storeName,
    scanned: 0,
    changed: 0,
    failed: 0,
    clearedPayloads: 0,
    clearedBytes: 0,
  };
  let riskToken = globalThis.__mm_mark_risky_activity__?.('community-media-clear', {
    phase: 'start',
    category: result.category,
  });
  try {
    const keys = await db.getAllKeys(storeName);
    for (const recordKey of keys) {
      result.scanned += 1;
      try {
        let cleared = null;
        const update = await db.updateRecord(storeName, recordKey, (current) => {
          if (!current) return null;
          const stats = { payloads: 0, bytes: 0 };
          const stripped = stripInlineImagePayloads(current, stats);
          if (!stripped.changed) return null;
          cleared = stats;
          return stripped.value;
        });
        if (!update.updated || !cleared) continue;
        result.changed += 1;
        result.clearedPayloads += cleared.payloads;
        result.clearedBytes += cleared.bytes;
      } catch (error) {
        result.failed += 1;
        console.warn('[community-media-clear] record skipped', storeName, recordKey, error);
      }
      riskToken = globalThis.__mm_mark_risky_activity__?.('community-media-clear', {
        phase: 'record',
        ...result,
      }) || riskToken;
      options.onProgress?.({ ...result, recordKey });
      await yieldToUi(20);
    }
    return result;
  } finally {
    if (riskToken) globalThis.__mm_clear_risky_activity__?.(riskToken);
  }
}

/**
 * 紧急释放消息库里的本地图片字节。保留消息、说明文字、提示词与时间线；
 * 仅移除 data:image 内联内容，https 外链与其它业务数据不动。
 */
export async function clearLocalMessageImages(options = {}) {
  const result = {
    scanned: 0,
    changed: 0,
    failed: 0,
    clearedPayloads: 0,
    clearedBytes: 0,
  };
  let riskToken = globalThis.__mm_mark_risky_activity__?.('media-image-clear', { phase: 'start' });
  try {
    await db.forEachStoreRecordBatched('messages', async (record) => {
      result.scanned += 1;
      if (!record?.id) return;
      const probeStats = { payloads: 0, bytes: 0 };
      if (!stripInlineImagePayloads(record, probeStats).changed) return;
      try {
        let cleared = null;
        const update = await db.updateRecord('messages', record.id, (current) => {
          if (!current) return null;
          const stats = { payloads: 0, bytes: 0 };
          const stripped = stripInlineImagePayloads(current, stats);
          if (!stripped.changed) return null;
          cleared = stats;
          const next = stripped.value;
          if (next.type === 'image') {
            next.metadata = {
              ...(next.metadata && typeof next.metadata === 'object' ? next.metadata : {}),
              localImageCleared: true,
              localImageClearedAt: Date.now(),
            };
          }
          return next;
        });
        if (!update.updated || !cleared) return;
        result.changed += 1;
        result.clearedPayloads += cleared.payloads;
        result.clearedBytes += cleared.bytes;
      } catch (error) {
        result.failed += 1;
        console.warn('[media-image-clear] message skipped', record?.id, error);
      }
      riskToken = globalThis.__mm_mark_risky_activity__?.('media-image-clear', {
        phase: 'message',
        ...result,
      }) || riskToken;
      options.onProgress?.({ ...result, messageId: record.id });
      await yieldToUi();
    }, {
      batchSize: 8,
      onBatch: () => yieldToUi(),
    });
    return result;
  } finally {
    if (riskToken) globalThis.__mm_clear_risky_activity__?.(riskToken);
  }
}

/**
 * 一次只解码一张历史聊天图。新图写入并读回确认后才替换旧值；中断后重跑会自动跳过已压缩记录。
 */
export async function compactOversizedMessageImages(options = {}) {
  const result = { scanned: 0, changed: 0, failed: 0, beforeBytes: 0, afterBytes: 0 };
  let riskToken = globalThis.__mm_mark_risky_activity__?.('media-compaction', { phase: 'start' });
  try {
    await db.forEachStoreRecordBatched('messages', async (record) => {
      result.scanned += 1;
      if (!record || record.type !== 'image') return;
      const content = String(record.content || '');
      const metaUrl = String(record.metadata?.url || '');
      const source = /^data:image\//i.test(content) ? content : metaUrl;
      const beforeBytes = /^data:image\//i.test(source) ? dataUrlApproxBytes(source) : 0;
      const duplicated = !!content && content === metaUrl && /^data:image\//i.test(content);
      if (beforeBytes <= CHAT_IMAGE_INLINE_MAX_BYTES && !duplicated) return;
      try {
        let optimized = source;
        if (beforeBytes > CHAT_IMAGE_INLINE_MAX_BYTES) {
          const blob = dataUrlToBlob(source);
          if (!blob) throw new Error('图片数据无法解码');
          optimized = String((await fileToOptimizedChatImageDataUrl(blob))?.dataUrl || '');
          if (!optimized) throw new Error('图片压缩结果为空');
        }
        const afterBytes = dataUrlApproxBytes(optimized);
        if (afterBytes > beforeBytes && !duplicated) return;
        const update = await db.updateRecord('messages', record.id, (current) => {
          if (!current) return null;
          const currentContent = String(current.content || '');
          const currentMeta = current.metadata && typeof current.metadata === 'object' ? current.metadata : {};
          const currentMetaUrl = String(currentMeta.url || '');
          if (currentContent !== source && currentMetaUrl !== source) return null;
          const nextMeta = { ...currentMeta, compressedLocalImage: true, storedSize: afterBytes };
          let nextContent = currentContent;
          if (currentContent === source) {
            nextContent = optimized;
            if (currentMetaUrl === source) nextMeta.url = '';
          } else {
            nextMeta.url = optimized;
          }
          return { ...current, content: nextContent, metadata: nextMeta };
        });
        if (!update.updated) return;
        const verified = await db.getRecord('messages', record.id);
        const verifiedSource = String(verified?.content || verified?.metadata?.url || '');
        if (verifiedSource !== optimized) {
          // 极少数 WebKit 存储异常下，只有当前值仍是本轮写入结果时才回滚；
          // 若用户恰好同时编辑了消息，则保留用户的新值，绝不以旧快照覆盖。
          await db.updateRecord('messages', record.id, (current) => {
            const currentContent = String(current?.content || '');
            const currentMeta = current?.metadata && typeof current.metadata === 'object'
              ? current.metadata
              : {};
            const currentMetaUrl = String(currentMeta.url || '');
            if (currentContent !== optimized && currentMetaUrl !== optimized) return null;
            return { ...record };
          });
          throw new Error('压缩后读回校验失败，已恢复原记录');
        }
        result.changed += 1;
        result.beforeBytes += beforeBytes * (duplicated ? 2 : 1);
        result.afterBytes += afterBytes;
      } catch (error) {
        result.failed += 1;
        console.warn('[media-compaction] message skipped', record?.id, error);
      }
      saveJournal({ ...result, lastMessageId: record.id, updatedAt: new Date().toISOString() });
      riskToken = globalThis.__mm_mark_risky_activity__?.('media-compaction', {
        phase: 'message',
        ...result,
      }) || riskToken;
      options.onProgress?.({ ...result, messageId: record.id });
      await yieldToUi(40);
    }, {
      batchSize: 1,
      onBatch: () => yieldToUi(40),
    });
    saveJournal({ ...result, complete: true, updatedAt: new Date().toISOString() });
    return result;
  } finally {
    if (riskToken) globalThis.__mm_clear_risky_activity__?.(riskToken);
  }
}
