/**
 * 角色手机朋友圈。
 *
 * 已在主通讯录的角色继续使用全局 momentsPosts，因此他们发的动态会同步出现在
 * 用户朋友圈；仅存在于某部手机的轻量联系人则写入 owner scoped settings，避免
 * 被其它角色手机或用户主 feed 误读。
 *
 * 「补一轮」：已链接角色走完整朋友圈生成链路（人设/记忆/聊天/评论风格）；
 * 轻量 NPC 另打一枪补进本机私有 feed，保证也有产出。
 */
import * as db from './db.js';
import { resolveGenerationMaxTokens } from './api.js';
import { chatJsonGeneration } from './chat-json-generation.js';
import { listCharacters } from './character-store.js';
import { getCharacterAiContextName } from '../models/character.js';
import { getUserDisplayName } from '../models/user.js';
import { getCurrentUserId } from './user-slot.js';
import {
  loadCharacterPhoneContacts,
  canPhoneAutoContactLinkedPeer,
} from './character-phone-contacts.js';
import { listCharacterPhoneChats } from './character-phone-messages.js';
import {
  allocMomentTimestamp,
  listMomentPostsForUser,
  putMomentPost,
} from './moments/moments-store.js';
import { canCharacterSeeMomentPost } from './moments/moments-visibility.js';
import { aiGenerateMomentsFeedBatch } from './moments/moments-ai.js';
import {
  repairTranslationEntries,
  sanitizeAiTranslation,
} from './translation-utils.js';
import { getNowForUser } from './time-mode.js';
import {
  formatClockInTimezone,
  resolveCharacterScheduleTimezone,
} from './chat/chat-timezone.js';
import { stripLeakedCharacterCodes } from './chat/character-code-fallback.js';

const MAX_LOCAL_POSTS = 120;

async function assertPhoneMomentsSlotStillCurrent(userId) {
  if (String(await getCurrentUserId() || '').trim() !== String(userId || '').trim()) {
    throw new Error('生成期间已切换用户档位，本轮结果未写入');
  }
}

function clean(value = '', max = 280) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanId(value = '') {
  return String(value ?? '').trim();
}

const MAX_MOMENT_AVATAR_CHARS = 900000;
function normalizeMomentAvatarUrl(value = '') {
  const url = String(value ?? '').trim();
  if (!url) return '';
  if (!/^(data:image\/|https?:\/\/)/i.test(url)) return '';
  return url.length <= MAX_MOMENT_AVATAR_CHARS ? url : '';
}

function keyFor(userId, ownerId) {
  return `characterPhoneMoments:${encodeURIComponent(String(userId || 'guest'))}:${encodeURIComponent(String(ownerId || 'unknown'))}`;
}

function localPost(raw = {}, ownerId, now = Date.now()) {
  const authorId = cleanId(raw.authorId || raw.author);
  const authorName = clean(raw.authorName || raw.name || authorId || '联系人', 80);
  const content = clean(raw.content || raw.text || '', 1200);
  if (!authorId || !content) return null;
  return {
    id: cleanId(raw.id) || `phone_moment_${now}_${Math.random().toString(36).slice(2, 7)}`,
    phoneOwnerId: ownerId,
    authorId,
    authorName,
    authorAvatar: normalizeMomentAvatarUrl(raw.authorAvatar || raw.avatar || ''),
    content,
    translation: sanitizeAiTranslation(content, raw.translation || raw.zh || ''),
    timestamp: Number(raw.timestamp) || now,
    images: Array.isArray(raw.images) ? raw.images.slice(0, 4) : [],
    likes: Array.isArray(raw.likes) ? raw.likes.slice(0, 24) : [],
    likesIds: Array.isArray(raw.likesIds) ? raw.likesIds.map(cleanId).filter(Boolean).slice(0, 24) : [],
    comments: Array.isArray(raw.comments) ? raw.comments.slice(0, 24) : [],
    metadata: { ...(raw.metadata || {}), phoneLocal: true },
  };
}

export async function loadCharacterPhoneLocalMoments(userId, ownerId) {
  const row = await db.get('settings', keyFor(userId, ownerId)).catch(() => null);
  const posts = Array.isArray(row?.value?.posts) ? row.value.posts : [];
  return posts.map((item) => localPost(item, ownerId, Number(item?.timestamp) || Date.now()))
    .filter(Boolean)
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

export async function saveCharacterPhoneLocalMoments(userId, ownerId, posts = []) {
  const value = posts.map((item) => localPost(item, ownerId)).filter(Boolean)
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, MAX_LOCAL_POSTS);
  await db.put('settings', { key: keyFor(userId, ownerId), value: { version: 1, posts: value, updatedAt: Date.now() } });
  return value;
}

export async function getCharacterPhoneLocalMoment(userId, ownerId, postId) {
  const id = cleanId(postId);
  if (!id) return null;
  const posts = await loadCharacterPhoneLocalMoments(userId, ownerId);
  return posts.find((item) => item.id === id) || null;
}

export async function putCharacterPhoneLocalMoment(userId, ownerId, post) {
  const next = localPost(post, ownerId);
  if (!next) return null;
  const prior = await loadCharacterPhoneLocalMoments(userId, ownerId);
  const posts = [next, ...prior.filter((item) => item.id !== next.id)];
  await saveCharacterPhoneLocalMoments(userId, ownerId, posts);
  return next;
}

export async function deleteCharacterPhoneLocalMoment(userId, ownerId, postId) {
  const id = cleanId(postId);
  if (!id) return false;
  const prior = await loadCharacterPhoneLocalMoments(userId, ownerId);
  if (!prior.some((item) => item.id === id)) return false;
  await saveCharacterPhoneLocalMoments(userId, ownerId, prior.filter((item) => item.id !== id));
  return true;
}

/**
 * 手机朋友圈里的动态可能来自全局 feed，也可能是本机轻量联系人私有帖。
 */
export async function resolveCharacterPhoneMomentPost(userId, ownerId, postId) {
  const id = cleanId(postId);
  if (!id) return null;
  const local = await getCharacterPhoneLocalMoment(userId, ownerId, id);
  if (local) return { ...local, userId, phoneLocal: true };
  const { getMomentPost } = await import('./moments/moments-store.js');
  const global = await getMomentPost(id).catch(() => null);
  if (!global) return null;
  if (String(global.userId || '') !== String(userId || '')) return null;
  return { ...global, phoneLocal: false };
}

export async function deleteCharacterPhoneMomentPost(userId, ownerId, postId) {
  if (await deleteCharacterPhoneLocalMoment(userId, ownerId, postId)) return { local: true };
  const { deleteMomentPost } = await import('./moments/moments-store.js');
  await deleteMomentPost(postId, userId);
  return { local: false };
}

export async function putCharacterPhoneMomentPost(userId, ownerId, post) {
  if (post?.phoneLocal || post?.metadata?.phoneLocal || post?.phoneOwnerId) {
    return putCharacterPhoneLocalMoment(userId, ownerId, post);
  }
  // 若 id 已在本机私有库，继续写私有
  const local = await getCharacterPhoneLocalMoment(userId, ownerId, post?.id);
  if (local) return putCharacterPhoneLocalMoment(userId, ownerId, { ...local, ...post });
  const { putMomentPost } = await import('./moments/moments-store.js');
  return putMomentPost(post, userId);
}

async function collectPhoneRelatedCharacterIds(userId, ownerId, charMap) {
  // TA 的朋友圈 = 通讯录里已链接的角色 + 和 TA 有过私聊/群聊的主通讯录角色。
  const related = new Set();
  const chats = await listCharacterPhoneChats(userId, ownerId).catch(() => []);
  for (const chatRow of chats) {
    for (const pid of chatRow?.participants || []) {
      if (pid && pid !== ownerId && pid !== 'user' && charMap.has(pid)) related.add(pid);
    }
  }
  return related;
}

export async function listCharacterPhoneMoments(userId, ownerId) {
  const [contactsState, characters, globalPosts, localPosts] = await Promise.all([
    loadCharacterPhoneContacts(userId, ownerId),
    listCharacters({ includeInternal: true, userId, identityScoped: true }).catch(() => []),
    listMomentPostsForUser(userId),
    loadCharacterPhoneLocalMoments(userId, ownerId),
  ]);
  const charMap = new Map(characters.map((item) => [item.id, item]));
  // 角色手机看到的是“这名角色可见的朋友圈”，其中也应包含用户本人发布的动态。
  // 聊天记录分享帖的 authorId 是当前档位 userId；旧逻辑只放手机主人和联系人，
  // 导致普通角色动态正常、唯独用户晒出的聊天记录在角色手机里消失。
  const allowed = new Set([ownerId, userId]);
  for (const contact of contactsState.contacts || []) if (contact.linkedCharacterId) allowed.add(contact.linkedCharacterId);
  for (const id of await collectPhoneRelatedCharacterIds(userId, ownerId, charMap)) {
    if (canPhoneAutoContactLinkedPeer(contactsState, id)) allowed.add(id);
  }
  const global = globalPosts.filter((post) => (
    allowed.has(String(post.authorId || ''))
    && canCharacterSeeMomentPost(post, ownerId, charMap)
  ));
  // 公共朋友圈交互层会按 userId 校验帖子归属。本机轻量联系人动态存于
  // owner-scoped settings，原始记录无需冗余 userId，但送到 UI 前必须补齐；
  // 否则三点菜单在 loadPost 时会把它当成其它档位的数据并静默返回。
  const local = localPosts.map((post) => ({
    ...post,
    userId,
    phoneOwnerId: ownerId,
    phoneLocal: true,
  }));
  return [...global, ...local].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

function clipPersona(value = '', max = 140) {
  return clean(value, max);
}

/** id / 名字 → 展示真名；解不出时用「好友」，绝不把后台 id 露给用户。 */
function resolveDisplayName(ref, nameById) {
  const key = cleanId(ref);
  if (!key) return '好友';
  if (nameById.has(key)) return nameById.get(key);
  for (const [id, name] of nameById.entries()) {
    if (name === key) return name;
  }
  if (/^phone-contact:/i.test(key) || /^char_/i.test(key) || /^npc_/i.test(key) || key.includes(':')) {
    return '好友';
  }
  return key;
}

/**
 * 「补一轮」：
 * 1) 已链接角色 / 关系网熟人 → 完整朋友圈链路（场景抽签、人设、记忆、聊天语气、评论风格）
 * 2) 轻量 NPC → 另打一枪写入本机私有 feed，并可用链接角色/主人点赞评论
 */
export async function generateCharacterPhoneMoments({
  user,
  ownerId,
  count = 4,
  onProgress = null,
  signal = null,
} = {}) {
  if (!user?.id || !ownerId) throw new Error('缺少手机主人');
  const targetCount = Math.min(5, Math.max(3, Math.round(Number(count) || 4)));
  const userName = getUserDisplayName(user) || '用户';

  const [contactsState, characters] = await Promise.all([
    loadCharacterPhoneContacts(user.id, ownerId),
    listCharacters({ includeInternal: true, userId: user.id, identityScoped: true }).catch(() => []),
  ]);
  const charMap = new Map(characters.map((item) => [item.id, item]));
  const owner = charMap.get(ownerId) || null;
  const ownerName = getCharacterAiContextName(owner, ownerId) || '手机主人';

  const linkedIdSet = new Set(
    (contactsState.contacts || []).map((item) => item.linkedCharacterId).filter((id) => id && charMap.has(id)),
  );
  for (const id of await collectPhoneRelatedCharacterIds(user.id, ownerId, charMap)) {
    if (canPhoneAutoContactLinkedPeer(contactsState, id)) linkedIdSet.add(id);
  }
  // 手机主人也可以发圈（完整链路）
  if (owner) linkedIdSet.add(ownerId);
  const linkedIds = [...linkedIdSet].slice(0, 10);

  const localContacts = (contactsState.contacts || [])
    .filter((item) => item?.id && !item.linkedCharacterId)
    .slice(0, 12);
  if (!linkedIds.length && !localContacts.length) {
    throw new Error('这部手机还没有可以发朋友圈的联系人：先在 Chat 通讯录里加联系人，或让 TA 和其他角色聊过天');
  }

  const result = { global: 0, local: 0, posts: [] };

  // —— 1) 已链接 / 主人：走完整朋友圈生成 ——
  const linkedTarget = localContacts.length
    ? Math.min(Math.max(2, targetCount - 1), linkedIds.length, 4)
    : Math.min(targetCount, linkedIds.length, 5);
  if (linkedIds.length && linkedTarget > 0) {
    onProgress?.('正在生成已关联角色的朋友圈…');
    const generated = await aiGenerateMomentsFeedBatch({
      user,
      authorIds: linkedIds,
      count: linkedTarget,
      onProgress,
    });
    for (const item of generated) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await assertPhoneMomentsSlotStillCurrent(user.id);
      const timestamp = await allocMomentTimestamp(user.id);
      // userId 必须在 spread 之后强制写入，并用 putMomentPost 二次钉死档位，
      // 避免 AI/归一化字段里偶发带上别档 userId 时污染主朋友圈索引。
      const post = await putMomentPost({
        id: `moment_phone_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp,
        visibility: 'all',
        ...item,
        userId: user.id,
        metadata: { ...(item.metadata || {}), phoneBatch: true, phoneOwnerId: ownerId },
      }, user.id);
      result.posts.push(post);
      result.global += 1;
    }
  }

  // —— 2) 轻量 NPC：另打一枪，互动池含主人与已链接熟人 ——
  const localNeed = localContacts.length
    ? Math.min(
      localContacts.length,
      Math.max(1, targetCount - result.global),
      3,
    )
    : 0;
  if (localNeed > 0) {
    onProgress?.('正在生成手机联系人动态…');
    const nowBase = await getNowForUser(user.id).catch(() => Date.now());
    const ownerTimeZone = await resolveCharacterScheduleTimezone(user.id, ownerId, owner).catch(() => '');
    const ownerLocalClock = ownerTimeZone ? formatClockInTimezone(nowBase, ownerTimeZone) : '';
    const nameById = new Map();
    nameById.set(ownerId, ownerName);
    for (const id of linkedIds) {
      nameById.set(id, getCharacterAiContextName(charMap.get(id), id) || id);
    }
    for (const item of localContacts) {
      nameById.set(item.id, clean(item.name || item.nickname || item.id, 40));
    }

    const localAuthors = localContacts.slice(0, Math.max(localNeed + 3, 6)).map((item) => ({
      id: item.id,
      name: nameById.get(item.id),
      category: item.category || 'other',
      persona: clipPersona(item.personaCapsule?.summary || item.note || '', 160),
      relationship: clipPersona(item.personaCapsule?.relationship || '', 100),
      speechStyle: clipPersona(item.personaCapsule?.speechStyle || '', 80),
      translationProfile: item.translationProfile || {},
    }));
    const reactionPool = [
      {
        id: ownerId,
        name: ownerName,
        kind: 'owner',
        translationProfile: charMap.get(ownerId)?.translationProfile || {},
      },
      ...linkedIds.filter((id) => id !== ownerId).slice(0, 8).map((id) => ({
        id,
        name: nameById.get(id),
        kind: 'linked',
        translationProfile: charMap.get(id)?.translationProfile || {},
      })),
      ...localAuthors.map((a) => ({
        id: a.id,
        name: a.name,
        kind: 'local',
        translationProfile: a.translationProfile,
      })),
    ];

    const maxTokens = await resolveGenerationMaxTokens();
    let parsed = null;
    let localGenerationError = null;
    let localGenerationRaw = '';
    try {
      const generated = await chatJsonGeneration({
        scope: 'character-phone-moments',
        retryOnInvalid: false,
        messages: [{
          role: 'system',
          content: `你在补全角色「${ownerName}」手机里、只存在于这部手机的联系人朋友圈。

手机主人：${ownerName}（id=${ownerId}）
${ownerLocalClock ? `手机主人当地此刻：${ownerLocalClock}（${ownerTimeZone}）。这部手机里的轻量联系人若资料未明确写在异地，按手机主人的当地昼夜判断，不得套用用户手机钟点。` : ''}
用户 ${userName} 禁止替其发圈，也不要虚构其未发生的事。

可发圈的轻量联系人（author 必须从这里选，每人最多一条）：
${JSON.stringify(localAuthors)}

可点赞/评论的人（likes / comments.authorId 从这里选，可用真角色 id 或轻量联系人 id）：
${JSON.stringify(reactionPool)}

任务：生成 ${localNeed} 条近期、生活化、互不重复话题的动态。
规则：
- 正文贴合该联系人的 relationship / persona / speechStyle，像真人随手发，不要模板口号。
- 每条尽量带 1～4 个 likes，以及 1～4 条短口语评论；熟人之间可以互相调侃、接梗、追问一句，贴主也可偶尔回复（comments 里再写一条，replyTo 写被回复者的真名）。
- 评论禁止写成剧本旁白或客服话术；不要条条都是「哈哈哈支持」。
- 严格服从每个人的 translationProfile：mode=full 时 content / comments[].text 必须写指定外语或中文方言原文并在同一对象给 "zh" 简体中文普通话（现代标准汉语）翻译；中文方言即使全是汉字也不能省略 zh，且不能只做繁简转换；mode=mixed 仅在实际出现外语或方言时给 zh；off 使用普通话且不用 zh。
- 表情请直接写 Unicode emoji（😭😂🤦），不要写 [大哭][捂脸] 这类微信方括号码。
- likes / comments 里写 id；落库时会转成真名。禁止把后台 id 写进评论文字。
- 只输出 JSON，不要 Markdown：
{"posts":[{"authorId":"联系人id","content":"正文","zh":"外语正文才需要","likes":["id"],"comments":[{"authorId":"id","text":"评论","zh":"外语评论才需要","replyTo":"可选，回复对象真名"}]}]}`,
        }, {
          role: 'user',
          content: '请按上述手机联系人与关系设定生成本轮朋友圈 JSON。',
        }],
        temperature: 0.88,
        maxTokens,
        signal,
        preferStream: true,
        onProgress,
        validate: (value) => Array.isArray(value?.posts) && value.posts.length > 0,
      });
      localGenerationRaw = generated.raw;
      parsed = generated.data;
    } catch (error) {
      localGenerationError = error;
    }
    if (!parsed?.posts?.length) {
      // 轻量 NPC 失败不整轮作废：已有链接角色动态就仍算成功
      if (!result.global) {
        throw localGenerationError || new Error('手机联系人朋友圈未返回有效 JSON');
      }
    } else {
      const byId = new Map(localContacts.map((item) => [item.id, item]));
      const allowedReaction = new Set(reactionPool.map((item) => item.id));
      const profileById = new Map(reactionPool.map((item) => [item.id, item.translationProfile || {}]));
      const repairEntries = [];
      for (const [postIndex, post] of parsed.posts.entries()) {
        repairEntries.push({
          id: `phone_moment_post_${postIndex}`,
          source: post?.content || post?.text || '',
          translation: post?.zh || post?.translation || '',
          languageHint: profileById.get(cleanId(post?.authorId || post?.author))?.language
            || profileById.get(cleanId(post?.authorId || post?.author))?.dialectNote
            || '',
        });
        for (const [commentIndex, comment] of (Array.isArray(post?.comments) ? post.comments : []).entries()) {
          repairEntries.push({
            id: `phone_moment_comment_${postIndex}_${commentIndex}`,
            source: comment?.text || comment?.content || '',
            translation: comment?.zh || comment?.translation || '',
            languageHint: profileById.get(cleanId(comment?.authorId || comment?.author))?.language
              || profileById.get(cleanId(comment?.authorId || comment?.author))?.dialectNote
              || '',
          });
        }
      }
      const repairedTranslations = await repairTranslationEntries(repairEntries, {
        signal,
        automatic: true,
      }).catch(() => new Map());
      const prior = await loadCharacterPhoneLocalMoments(user.id, ownerId);
      const used = new Set();
      const created = [];
      for (const [index, item] of (Array.isArray(parsed.posts) ? parsed.posts : []).entries()) {
        if (created.length >= localNeed) break;
        const authorId = cleanId(item?.authorId || item?.author);
        const contact = byId.get(authorId);
        if (!contact || used.has(authorId)) continue;
        used.add(authorId);
        const content = clean(item?.content || item?.text || '', 1200);
        if (!content) continue;

        const likeIds = [...new Set((Array.isArray(item.likes) ? item.likes : [])
          .map(cleanId)
          .filter((id) => id && id !== authorId && allowedReaction.has(id)))]
          .slice(0, 6);
        const comments = (Array.isArray(item.comments) ? item.comments : [])
          .map((c, commentIndex) => {
            let cid = cleanId(c?.authorId || c?.author);
            // 模型有时只回昵称；贴主回复也可能不在 reaction pool 里——按昵称回填，并放行贴主本人
            if (cid && cid !== authorId && !allowedReaction.has(cid) && nameById?.entries) {
              for (const [id, name] of nameById.entries()) {
                if (String(name || '').trim() !== cid) continue;
                if (id === authorId || allowedReaction.has(id)) {
                  cid = id;
                  break;
                }
              }
            }
            const text = clean(stripLeakedCharacterCodes(
              c?.text || c?.content || '',
              { nameMap: nameById, userName, fallbackLabel: '好友' },
            ), 120);
            if (!cid || !text) return null;
            if (cid !== authorId && !allowedReaction.has(cid)) return null;
            const translation = sanitizeAiTranslation(
              text,
              c?.zh || c?.translation || repairedTranslations.get(`phone_moment_comment_${index}_${commentIndex}`) || '',
              {
                languageHint: profileById.get(cid)?.language || profileById.get(cid)?.dialectNote || '',
              },
            );
            return {
              authorId: cid,
              authorName: resolveDisplayName(cid, nameById),
              author: resolveDisplayName(cid, nameById),
              text,
              replyTo: clean(stripLeakedCharacterCodes(
                c?.replyTo,
                { nameMap: nameById, userName, fallbackLabel: '好友' },
              ), 40),
              ...(translation ? { translation } : {}),
            };
          })
          .filter(Boolean)
          .slice(0, 7);

        created.push(localPost({
          authorId,
          authorName: nameById.get(authorId) || contact.name || contact.nickname,
          authorAvatar: contact.avatar || '',
          content,
          translation: sanitizeAiTranslation(
            content,
            item?.zh || item?.translation || repairedTranslations.get(`phone_moment_post_${index}`) || '',
            {
              languageHint: profileById.get(authorId)?.language
                || profileById.get(authorId)?.dialectNote
                || '',
            },
          ),
          likes: likeIds.map((id) => resolveDisplayName(id, nameById)),
          likesIds: likeIds,
          comments,
          timestamp: nowBase - (index + 1) * 90 * 1000,
          metadata: { phoneBatch: true },
        }, ownerId));
      }
      if (created.length) {
        await assertPhoneMomentsSlotStillCurrent(user.id);
        await saveCharacterPhoneLocalMoments(user.id, ownerId, [...created, ...prior]);
        result.posts.push(...created);
        result.local = created.length;
      } else if (!result.global) {
        const error = new Error('模型有返回，但联系人或正文不符合朋友圈要求');
        error.reason = 'validation-failed';
        error.rawText = localGenerationRaw;
        throw error;
      }
    }
  }

  if (!result.global && !result.local) {
    const error = new Error('这一轮没有生成出可用的朋友圈内容');
    error.reason = 'no-results';
    throw error;
  }
  return result;
}
