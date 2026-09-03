/**
 * 生成原文档案 · 线下 / 时光机 / 番外 / 小剧场等长文生成的「整体原文」留底。
 *
 * 目的：测试或日常使用时刷新页面不再丢失生成的原文，可随时回看完整记录（不是摘要）。
 * 存储：settings.narrationArchive（单键数组，按时间倒序，封顶 MAX 条），不新增 store。
 */

import { get as dbGet, put as dbPut } from './db.js';

const STORE_KEY = 'narrationArchive';
const HIDDEN_OFFLINE_STORE_PREFIX = 'narrationArchiveHiddenOffline_';
const MAX_ENTRIES = 300;

export const NARRATION_KINDS = {
  offline: '线下沉浸',
  time_machine: '时光机',
  au: '番外剧场',
  storycard: '小剧场卡',
};

export function narrationKindLabel(kind) {
  return NARRATION_KINDS[String(kind || '')] || '叙事';
}

function offlineRoundText(round = {}) {
  const text = String(round?.text || '').trim();
  if (!text) return '';
  if (round.role === 'opening') return `【你的开场】\n${text}`;
  if (round.role === 'directive') return `【你的方向】\n${text}`;
  if (round.role === 'interlude') {
    const status = String(round?.attendanceEvent?.status || '');
    const label = status === 'active'
      ? '加入现场'
      : (status === 'left' ? '离开现场' : '现场插曲');
    return `【${label}】\n${text}`;
  }
  return text;
}

/** 把约会档案作为“原文档案”里的只读主数据视图，不再复制第二份易漂移的全文。 */
export function offlineArchiveToNarrationEntry(archive = {}) {
  const archiveId = String(archive?.id || '').trim();
  if (!archiveId) return null;
  const rounds = Array.isArray(archive?.rounds) ? archive.rounds : [];
  const text = rounds.map(offlineRoundText).filter(Boolean).join('\n\n')
    || String(archive?.digest?.story || archive?.summary || '').trim();
  if (!text) return null;
  const names = (Array.isArray(archive?.participantNames)
    ? archive.participantNames
    : [archive?.characterName])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const place = String(archive?.scene?.place || archive?.scene?.goal || '').trim();
  return {
    id: `nar_offline_${archiveId}`,
    kind: 'offline',
    title: String(archive?.title || '一次线下相处').trim().slice(0, 60),
    subtitle: place.slice(0, 120),
    text,
    image: '',
    imagePrompt: '',
    chatId: String(archive?.chatId || '').trim(),
    characterId: String(archive?.characterId || archive?.participantIds?.[0] || '').trim(),
    characterName: names.join('、').slice(0, 40),
    meta: {
      offlineDateArchiveId: archiveId,
      canonicalOfflineArchive: true,
    },
    createdAt: Number(
      archive?.archivedAtReal
      || archive?.endedAt
      || archive?.startedAt
      || archive?.updatedAt
      || 0,
    ) || 0,
  };
}

/**
 * 原文档案聚合：线下全文以约会档案为准；旧版若曾留下同源副本则去重。
 * 纯函数单独导出，便于验证首次线下和历史回填。
 */
export function mergeNarrationWithOfflineArchives(
  entries = [],
  archives = [],
  { hiddenOfflineArchiveIds = [] } = {},
) {
  const hiddenIds = new Set(
    (Array.isArray(hiddenOfflineArchiveIds) ? hiddenOfflineArchiveIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const canonicalArchiveIds = new Set(
    (Array.isArray(archives) ? archives : [])
      .map((archive) => String(archive?.id || '').trim())
      .filter(Boolean),
  );
  const offlineEntries = (Array.isArray(archives) ? archives : [])
    .filter((archive) => !hiddenIds.has(String(archive?.id || '').trim()))
    .map(offlineArchiveToNarrationEntry)
    .filter(Boolean);
  const storedEntries = (Array.isArray(entries) ? entries : []).filter((entry) => {
    const linkedId = String(entry?.meta?.offlineDateArchiveId || '').trim();
    return !linkedId || (!canonicalArchiveIds.has(linkedId) && !hiddenIds.has(linkedId));
  });
  return [...offlineEntries, ...storedEntries]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, MAX_ENTRIES);
}

function hiddenOfflineStoreKey(userId = '') {
  return `${HIDDEN_OFFLINE_STORE_PREFIX}${encodeURIComponent(String(userId || '').trim() || 'guest')}`;
}

export async function listHiddenOfflineNarrationIds(userId = '') {
  const row = await dbGet(hiddenOfflineStoreKey(userId));
  return Array.isArray(row?.value)
    ? [...new Set(row.value.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
}

export async function hideOfflineNarrationEntries(userId = '', archiveIds = []) {
  const current = await listHiddenOfflineNarrationIds(userId);
  const next = [...new Set([
    ...current,
    ...(Array.isArray(archiveIds) ? archiveIds : [archiveIds])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  ])].slice(-MAX_ENTRIES);
  await dbPut({ key: hiddenOfflineStoreKey(userId), value: next });
  return next;
}

function genId() {
  return `nar_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function listNarrationArchive() {
  const row = await dbGet(STORE_KEY);
  const list = Array.isArray(row?.value) ? row.value : [];
  return list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getNarrationEntry(id) {
  const list = await listNarrationArchive();
  return list.find((e) => e.id === String(id || '').trim()) || null;
}

/**
 * 追加一条原文记录。失败时静默（绝不阻塞生成主流程）。
 * entry: { kind, title, subtitle, text, image, imagePrompt, chatId, characterId, characterName, meta }
 */
export async function archiveNarration(entry = {}) {
  try {
    const text = String(entry.text || '').trim();
    if (!text) return null;
    const row = await dbGet(STORE_KEY);
    const list = Array.isArray(row?.value) ? row.value : [];
    const record = {
      id: genId(),
      kind: String(entry.kind || 'offline'),
      title: String(entry.title || '').trim().slice(0, 60),
      subtitle: String(entry.subtitle || '').trim().slice(0, 120),
      text,
      image: String(entry.image || '').trim(),
      imagePrompt: String(entry.imagePrompt || '').trim(),
      chatId: String(entry.chatId || '').trim(),
      characterId: String(entry.characterId || '').trim(),
      characterName: String(entry.characterName || '').trim().slice(0, 40),
      meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : {},
      createdAt: Date.now(),
    };
    list.push(record);
    // 倒序裁剪，保留最近 MAX 条
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const trimmed = list.slice(0, MAX_ENTRIES);
    await dbPut({ key: STORE_KEY, value: trimmed });
    return record;
  } catch (_) {
    return null;
  }
}

export async function updateNarrationEntry(id, patch = {}) {
  try {
    const rid = String(id || '').trim();
    if (!rid) return null;
    const row = await dbGet(STORE_KEY);
    const list = Array.isArray(row?.value) ? row.value : [];
    let updated = null;
    const next = list.map((entry) => {
      if (entry?.id !== rid) return entry;
      updated = {
        ...entry,
        ...(Object.prototype.hasOwnProperty.call(patch, 'image')
          ? { image: String(patch.image || '').trim() }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(patch, 'imagePrompt')
          ? { imagePrompt: String(patch.imagePrompt || '').trim() }
          : {}),
        meta: patch.meta && typeof patch.meta === 'object'
          ? { ...(entry.meta || {}), ...patch.meta }
          : (entry.meta || {}),
      };
      return updated;
    });
    if (!updated) return null;
    await dbPut({ key: STORE_KEY, value: next });
    return updated;
  } catch (_) {
    return null;
  }
}

export async function deleteNarrationEntry(id) {
  const rid = String(id || '').trim();
  const row = await dbGet(STORE_KEY);
  const list = Array.isArray(row?.value) ? row.value : [];
  const next = list.filter((e) => e.id !== rid);
  await dbPut({ key: STORE_KEY, value: next });
  return next;
}

export async function clearNarrationArchive() {
  await dbPut({ key: STORE_KEY, value: [] });
  return [];
}
