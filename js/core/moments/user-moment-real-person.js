import { listChatsForUser } from '../chat-store.js';
import { loadResolvedCharacterAutonomyPolicy } from '../character-autonomy-settings.js';
import { enqueuePendingAction } from '../chat/pending-actions.js';
import { getPacingNowForUser } from '../time-mode.js';

function clean(value) {
  return String(value ?? '').trim();
}

function stableNumber(value = '') {
  const input = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export async function scheduleUserMomentRealPersonFollowup(post, options = {}) {
  const userId = clean(options.userId || post?.userId);
  const postId = clean(post?.id);
  if (!userId || !postId || clean(post?.authorId) !== userId) {
    return { ok: false, reason: 'not-user-moment' };
  }
  const chats = options.chats || await listChatsForUser(userId).catch(() => []);
  const candidates = [];
  for (const chat of chats) {
    if (!chat?.id || chat.type === 'group' || chat.metadata?.channelKind === 'stranger_intercept') continue;
    const characterId = (chat.participants || []).find((id) => id && id !== 'user');
    if (!characterId) continue;
    const policy = options.loadPolicy
      ? await options.loadPolicy(userId, characterId, chat.id)
      : await loadResolvedCharacterAutonomyPolicy(userId, characterId, chat.id).catch(() => null);
    // 朋友圈跟进属于「主动来找你」：真人感开着还不够，还要求主动行为总开关。
    if (policy?.totalEnabled !== true || policy?.realPersonMode?.enabled !== true) continue;
    candidates.push({ chat, characterId });
  }
  if (!candidates.length) return { ok: true, scheduled: 0, reason: 'no-enabled-character' };

  // 同一条用户朋友圈只挑一个真人模式角色，避免多人同时围上来。
  const picked = candidates[stableNumber(postId) % candidates.length];
  const delayMinutes = 20 + (stableNumber(`${postId}:${picked.characterId}`) % 101);
  const pacingNow = Number(options.pacingNow || 0) || await getPacingNowForUser(userId);
  const enqueue = options.enqueue || enqueuePendingAction;
  const result = await enqueue({
    userId,
    characterId: picked.characterId,
    chatId: picked.chat.id,
    kind: 'social_followup',
    dueAt: pacingNow + delayMinutes * 60 * 1000,
    createdAt: pacingNow,
    dedupeKey: `user-moment-followup:${postId}`,
    payload: {
      target: 'user_moment',
      postId,
    },
  });
  return { ok: result?.ok === true, scheduled: result?.ok ? 1 : 0, action: result?.action };
}

let bound = false;

export function initUserMomentRealPersonFollowup() {
  if (bound || typeof window === 'undefined') return;
  bound = true;
  window.addEventListener('user-moment-published', (event) => {
    const post = event?.detail?.post;
    if (!post?.id) return;
    scheduleUserMomentRealPersonFollowup(post, {
      userId: event?.detail?.userId,
    }).catch((error) => console.warn('[user-moment-real-person] schedule failed', error));
  });
}
