import { getRecord } from '../db.js';
import { isAnonymousChat } from '../chat-helpers.js';
import { saveChat } from '../chat-store.js';
import { applyAnonymousIdentityPatch } from '../anonymous-chat.js';
import { loadCharacterPhone } from '../character-phone-store.js';
import { compactAvatarDataUrlForStorage } from '../avatar-compaction.js';
import { getCharacter, saveCharacterForUser } from '../character-store.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

function isImageValue(value = '') {
  return /^(?:data:image\/|https?:\/\/|\.{0,2}\/|\/)/i.test(clean(value));
}

function wantsUserImage(event = {}) {
  if (event.useUserImage === true || event.fromUserImage === true) return true;
  const ref = clean(event.source || event.pick || event.avatar).toLowerCase();
  return ref === 'user_image' || ref === 'useruimage' || ref === 'user' || ref === 'couple' || ref === '情头' || ref === '用户图片';
}

function wantsLibraryPick(event = {}) {
  if (event.fromLibrary === true || event.pickFromLibrary === true) return true;
  const ref = clean(event.pick || event.source).toLowerCase();
  return !!ref && ref !== 'user_image' && ref !== 'user';
}

/**
 * 从本会话消息里挑用户最近发的一张图（data:image 或 http），用作角色头像/情头。
 *
 * 聊天页为控制移动端内存，会把已落库的大图替换成 deferredImage 占位：内存消息的
 * content / metadata.url 都为空，真正像素仍在 messages 表。头像事件通常发生在图片发送
 * 数秒后，正好可能撞上这次延迟化刷新；因此遇到空占位时按消息 id 定向回读原记录。
 */
async function resolveUserImageMessageUrl(message = null, options = {}) {
  const m = message;
  if (!m || m.deleted || m.recalled || m.senderId !== 'user' || m.type !== 'image') return '';
  const url = clean(m.content || m.metadata?.url);
  if (isImageValue(url)) return url;
  const messageId = clean(m.id);
  if (!messageId) return '';
  const loadMessage = typeof options.loadMessage === 'function'
    ? options.loadMessage
    : (id) => getRecord('messages', id);
  const stored = await Promise.resolve(loadMessage(messageId)).catch(() => null);
  if (!stored
    || stored.deleted
    || stored.recalled
    || stored.senderId !== 'user'
    || stored.type !== 'image') return '';
  const storedUrl = clean(stored.content || stored.metadata?.url);
  return isImageValue(storedUrl) ? storedUrl : '';
}

async function resolveUserImageUrl(event = {}, messages = [], options = {}) {
  const candidates = (Array.isArray(options.imageCandidates) ? options.imageCandidates : [])
    .filter((m) => m && !m.deleted && !m.recalled && m.senderId === 'user' && m.type === 'image');
  const requestedIndex = Math.max(0, Math.min(5, Math.trunc(Number(event.imageIndex || 0)) || 0));
  if (requestedIndex > 0) {
    return resolveUserImageMessageUrl(candidates[requestedIndex - 1], options);
  }
  // 多图时没有明确编号就不擅自选末图，避免角色说选 A、实际换成 B。
  if (candidates.length > 1) return '';
  if (candidates.length === 1) return resolveUserImageMessageUrl(candidates[0], options);

  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.deleted && !m.recalled && m.senderId === 'user' && m.type === 'image')
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  for (const m of list) {
    const url = await resolveUserImageMessageUrl(m, options);
    if (url) return url;
  }
  return '';
}

/** 从角色手机头像库挑一张图：有关键词就按 标题/描述/标签 匹配，否则随机 */
async function pickAvatarFromLibrary(userId = '', characterId = '', hint = '') {
  const uid = clean(userId);
  const cid = clean(characterId);
  if (!uid || !cid) return '';
  const phone = await loadCharacterPhone(uid, cid).catch(() => null);
  const library = (phone?.avatarLibrary || []).filter((item) => isImageValue(clean(item?.imageUrl)));
  if (!library.length) return '';
  const keyword = clean(hint).toLowerCase();
  const generic = !keyword || ['random', '随机', 'library', '头像库', 'true', '1', 'pick'].includes(keyword);
  if (!generic) {
    const matched = library.find((item) => {
      const hay = [item.title, item.description, ...(Array.isArray(item.tags) ? item.tags : [])]
        .map((x) => clean(x).toLowerCase())
        .join(' ');
      return hay.includes(keyword);
    });
    if (matched) return clean(matched.imageUrl);
  }
  const choice = library[Math.floor(Math.random() * library.length)];
  return clean(choice?.imageUrl);
}

export async function applyMarshmallowProfileEvents(events = [], options = {}) {
  const chat = options.chat || null;
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const list = (Array.isArray(events) ? events : []).filter((e) => e?.t === 'alias' || e?.t === 'avatar');
  if (!chat || !list.length) return { applied: 0 };
  const participants = new Set((chat.participants || []).map((id) => clean(id)).filter(Boolean));
  let applied = 0;
  let chatChanged = false;

  for (const event of list) {
    const actorId = clean(event.from || event.actor);
    if (!actorId || actorId === 'user' || actorId === 'system' || !participants.has(actorId)) continue;

    if (isAnonymousChat(chat)) {
      if (event.t === 'alias' && event.name) {
        applyAnonymousIdentityPatch(chat, actorId, {
          currentId: event.name,
          signature: event.signature,
        });
        applied += 1;
        chatChanged = true;
      } else if (event.t === 'avatar' && event.avatar) {
        applyAnonymousIdentityPatch(chat, actorId, { avatar: event.avatar });
        applied += 1;
        chatChanged = true;
      }
      continue;
    }

    if (event.t === 'alias' && event.name) {
      if (!chat.groupSettings || typeof chat.groupSettings !== 'object') chat.groupSettings = {};
      if (!chat.groupSettings.memberCards || typeof chat.groupSettings.memberCards !== 'object') {
        chat.groupSettings.memberCards = {};
      }
      chat.groupSettings.memberCards[actorId] = clean(event.name).slice(0, 24);
      applied += 1;
      chatChanged = true;
      continue;
    }

    if (event.t === 'avatar') {
      let imageUrl = '';
      if (wantsUserImage(event)) {
        imageUrl = await resolveUserImageUrl(event, messages, options);
      } else if (isImageValue(event.avatar)) {
        imageUrl = clean(event.avatar);
      } else if (wantsLibraryPick(event)) {
        imageUrl = await pickAvatarFromLibrary(options.userId, actorId, event.pick || event.source);
      }
      if (imageUrl && isImageValue(imageUrl)) {
        const avatarUrl = await compactAvatarDataUrlForStorage(imageUrl).catch(() => '');
        if (avatarUrl && isImageValue(avatarUrl)) {
          const userId = clean(options.userId);
          if (!userId) continue;
          const stored = await getCharacter(actorId, { userId }).catch(() => null);
          if (!stored) continue;
          // 聊天中的换头像发生在当前 user 的关系上下文里，只能写该档位覆盖层。
          // 直接更新 characters 会污染通用底卡；已有其它档位覆盖时，还会造成
          // “设定页已换、聊天气泡仍被旧覆盖盖住”的互相矛盾状态。
          const saved = await saveCharacterForUser(userId, {
            ...stored,
            id: actorId,
            avatar: avatarUrl,
          }, { forceOverride: true }).catch(() => null);
          if (clean(saved?.avatar) !== avatarUrl) continue;
          applied += 1;
        }
      }
    }
  }

  if (chatChanged) await saveChat(chat);
  return { applied };
}
