/**
 * TA 关注你的小红书（v1，先只做小红书）：
 * 用户自愿粘贴自己的小红书主页分享链接，给某个角色开权限，角色能定期看到你发了什么，
 * 聊天时可以自然接得上——是「现实锚点」而不是通用功能，默认关闭，按角色单独开。
 *
 * 隐私边界：
 * - 抓取直接走用户自己的 TikHub Key（BYOK），我们不会把这些内容上传/存到任何服务端，
 *   只落在用户自己设备的本地数据库，和其它 TikHub 解析结果一样。
 * - 只能看到小红书本身公开可见的主页内容（不涉及私信、不涉及好友可见等非公开信息）。
 *
 * 技术要点：
 * - 去重：settings.seenNoteIds 记录已经处理过的 noteId，之后只处理没见过的新笔记。
 * - 首次连接（baseline）：不会把全部历史笔记一次性塞给角色（否则显得像扒了个底朝天），
 *   只深看最新一条，其余历史笔记直接标记已读、不生成正文/评论区抓取。
 * - 频率：默认约 20 小时才会真正跑一轮（近似一天一次），手动「立即看一次」可以跳过冷却测试用。
 */
import * as db from './db.js';
import { loadSocialLinkConfig } from './social-link-tools.js';
import { fetchXiaohongshuUserNotes, fetchXiaohongshuNoteDetail } from './social-link-resolver.js';
import { logSearchCall } from './search-usage-log.js';

const DAILY_COOLDOWN_MS = 20 * 60 * 60 * 1000;
const NEW_NOTES_PER_ROUND = 3;
const POOL_CAP = 12;
const SEEN_IDS_CAP = 200;

/** 保留导出以兼容旧调用；动态现在只作为新内容交付一次，不再按冷却时间循环出现。 */
export const SURFACE_COOLDOWN_MS = 10 * 60 * 60 * 1000;

/** 只有从未交付给模型、也未聊过的动态才算新内容。兼容旧数据里仅有 lastSurfacedAt 的记录。 */
export function isFreshUserSocialPost(post) {
  return Boolean(post?.noteId) && !post.mentionedAt && !post.lastSurfacedAt;
}

function settingsKey(userId, characterId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const cid = encodeURIComponent(String(characterId || '').trim());
  return `userSocialWatch_${uid}_${cid}`;
}

function postsKey(userId, characterId) {
  const uid = encodeURIComponent(String(userId || '').trim() || 'guest');
  const cid = encodeURIComponent(String(characterId || '').trim());
  return `userSocialWatchPosts_${uid}_${cid}`;
}

export const DISCLOSURE_MODES = ['secret', 'open'];

function normalizeSettings(value = {}) {
  const src = value && typeof value === 'object' ? value : {};
  return {
    enabled: src.enabled === true,
    profileInput: String(src.profileInput || '').trim().slice(0, 500),
    disclosureMode: DISCLOSURE_MODES.includes(src.disclosureMode) ? src.disclosureMode : 'secret',
    seenNoteIds: Array.isArray(src.seenNoteIds) ? src.seenNoteIds.slice(-SEEN_IDS_CAP) : [],
    initialized: src.initialized === true,
    lastCheckedAt: Number(src.lastCheckedAt) || 0,
    lastError: String(src.lastError || '').slice(0, 200),
  };
}

export async function loadUserSocialWatchSettings(userId, characterId) {
  const row = await db.get('settings', settingsKey(userId, characterId)).catch(() => null);
  return normalizeSettings(row?.value || {});
}

export async function saveUserSocialWatchSettings(userId, characterId, patch = {}) {
  const current = await loadUserSocialWatchSettings(userId, characterId);
  const next = normalizeSettings({ ...current, ...patch });
  await db.put('settings', { key: settingsKey(userId, characterId), value: next });
  return next;
}

/** 换主页链接/关掉重开：清空基线状态，重新走一次「首次连接」流程。 */
export async function resetUserSocialWatchProgress(userId, characterId) {
  return saveUserSocialWatchSettings(userId, characterId, {
    seenNoteIds: [],
    initialized: false,
    lastCheckedAt: 0,
    lastError: '',
  });
}

export async function listUserSocialPosts(userId, characterId) {
  const row = await db.get('settings', postsKey(userId, characterId)).catch(() => null);
  return Array.isArray(row?.value) ? row.value : [];
}

/** 标记某条用户动态「已经和对方聊过」：之后注入时不再当新鲜事提，避免原地打转。 */
export async function markUserSocialPostMentioned(userId, characterId, { noteId = '', url = '' } = {}) {
  const posts = await listUserSocialPosts(userId, characterId);
  if (!posts.length) return false;
  const nid = String(noteId || '').trim();
  const u = String(url || '').trim();
  let changed = false;
  const next = posts.map((p) => {
    if (p.mentionedAt) return p;
    const hit = (nid && p.noteId === nid) || (u && p.url && (p.url === u || u.includes(p.noteId)));
    if (!hit) return p;
    changed = true;
    return { ...p, mentionedAt: Date.now() };
  });
  if (changed) await db.put('settings', { key: postsKey(userId, characterId), value: next });
  return changed;
}

/**
 * 标记某条动态「已经作为新内容交给模型」。交付一次即退出候选：模型这轮即使没开口，之后也不会
 * 因为过了冷却时间再次把同一条旧动态当新闻投喂。只有主页抓到新的 noteId 才会再触发。
 */
export async function markUserSocialPostSurfaced(userId, characterId, noteId = '') {
  const nid = String(noteId || '').trim();
  if (!nid) return false;
  const posts = await listUserSocialPosts(userId, characterId);
  if (!posts.length) return false;
  let changed = false;
  const next = posts.map((p) => {
    if (p.noteId !== nid) return p;
    changed = true;
    const surfacedAt = Date.now();
    return {
      ...p,
      surfaceCount: Number(p.surfaceCount || 0) + 1,
      lastSurfacedAt: surfacedAt,
      mentionedAt: p.mentionedAt || surfacedAt,
    };
  });
  if (changed) await db.put('settings', { key: postsKey(userId, characterId), value: next });
  return changed;
}

/**
 * 跑一轮检查：没开、没配置主页链接、没到冷却时间都会直接跳过（manual=true 时跳过冷却）。
 * 返回 { ok, reason?, added, baseline? }。
 */
export async function checkUserSocialUpdates({ userId, characterId, manual = false } = {}) {
  const settings = await loadUserSocialWatchSettings(userId, characterId);
  if (!settings.enabled) return { ok: false, reason: 'disabled', added: 0 };
  if (!settings.profileInput) return { ok: false, reason: 'no-profile', added: 0 };
  if (!manual && settings.lastCheckedAt && Date.now() - settings.lastCheckedAt < DAILY_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', added: 0 };
  }
  const socialCfg = await loadSocialLinkConfig().catch(() => null);
  if (!socialCfg?.enabled || !socialCfg?.apiKey) {
    return { ok: false, reason: 'social-link-not-configured', added: 0 };
  }

  let listResult;
  try {
    listResult = await fetchXiaohongshuUserNotes(settings.profileInput, { apiKey: socialCfg.apiKey, limit: 10 });
    await logSearchCall({ category: 'user_social_watch', provider: 'xiaohongshu', characterId, ok: true, query: '用户主页', manual }).catch(() => {});
  } catch (err) {
    await logSearchCall({ category: 'user_social_watch', provider: 'xiaohongshu', characterId, ok: false, query: '用户主页', error: err?.message || String(err), manual }).catch(() => {});
    await saveUserSocialWatchSettings(userId, characterId, { lastCheckedAt: Date.now(), lastError: err?.message || String(err) });
    return { ok: false, reason: 'fetch-failed', error: err?.message || String(err), added: 0 };
  }

  const notes = listResult.notes || [];
  if (!notes.length) {
    await saveUserSocialWatchSettings(userId, characterId, { lastCheckedAt: Date.now(), lastError: '', initialized: true });
    return { ok: true, added: 0, reason: 'empty' };
  }

  const seen = new Set(settings.seenNoteIds);
  let targetNoteIds = [];
  const baseline = !settings.initialized;
  // 主页列表把置顶排最前，「第一条」不等于「最新发布」：优先按发布时间排序，
  // 时间字段解析不出来（全为 0）时退回列表顺序但跳过识别出的置顶
  const newestFirst = [...notes].sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  if (baseline) {
    const target = (Number(newestFirst[0]?.createdAt) || 0) > 0
      ? newestFirst[0]
      : (notes.find((n) => !n.pinned) || notes[0]);
    targetNoteIds = [target.noteId];
    notes.forEach((n) => seen.add(n.noteId));
  } else {
    const fresh = newestFirst.filter((n) => n.noteId && !seen.has(n.noteId));
    targetNoteIds = fresh.slice(0, NEW_NOTES_PER_ROUND).map((n) => n.noteId);
    fresh.forEach((n) => seen.add(n.noteId));
  }

  const added = [];
  for (const noteId of targetNoteIds) {
    try {
      const detail = await fetchXiaohongshuNoteDetail(noteId, {
        apiKey: socialCfg.apiKey,
        includeComments: true,
        commentCount: 4,
        cacheDays: socialCfg.cacheDays,
      });
      await logSearchCall({ category: 'user_social_watch', provider: 'xiaohongshu', characterId, ok: true, query: noteId, manual }).catch(() => {});
      if (!detail) continue;
      const preview = notes.find((n) => n.noteId === noteId);
      added.push({
        noteId,
        title: detail.title || '',
        desc: detail.desc || preview?.desc || '',
        images: (detail.images || []).slice(0, 6),
        url: detail.url || preview?.url || '',
        commentHighlights: (detail.comments || []).slice(0, 4),
        likeCount: detail.stats?.like || preview?.likeCount || 0,
        foundAt: Date.now(),
      });
    } catch (err) {
      await logSearchCall({ category: 'user_social_watch', provider: 'xiaohongshu', characterId, ok: false, query: noteId, error: err?.message || String(err), manual }).catch(() => {});
    }
  }

  if (added.length) {
    const existing = await listUserSocialPosts(userId, characterId);
    const existingById = new Map(existing.map((p) => [p.noteId, p]));
    // 同一 noteId 重新抓到时（比如重连基线后旧笔记又被当作「首条」处理一次），
    // 沿用旧记录的已提及/已喂过状态，不要让重新抓取顶掉「已经聊过」的标记。
    const addedWithState = added.map((p) => {
      const prev = existingById.get(p.noteId);
      if (!prev) return p;
      return {
        ...p,
        mentionedAt: prev.mentionedAt || 0,
        lastSurfacedAt: prev.lastSurfacedAt || 0,
        surfaceCount: prev.surfaceCount || 0,
      };
    });
    const merged = [...addedWithState, ...existing.filter((p) => !added.some((a) => a.noteId === p.noteId))].slice(0, POOL_CAP);
    await db.put('settings', { key: postsKey(userId, characterId), value: merged });
  }

  await saveUserSocialWatchSettings(userId, characterId, {
    seenNoteIds: [...seen],
    initialized: true,
    lastCheckedAt: Date.now(),
    lastError: '',
  });

  return { ok: true, added: added.length, baseline };
}
