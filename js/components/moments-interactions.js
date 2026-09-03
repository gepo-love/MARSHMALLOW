import { showToast } from './toast.js';
import { showGenerationErrorReport } from './generation-error-report.js';
import { openForwardPicker } from './forward-picker.js';
import { openImageLightbox } from './image-lightbox.js';
import { openChatCardModal } from './chat-interactive-modals.js';
import { openTextEditorModal } from './text-editor-modal.js';
import { createMessage } from '../models/chat.js';
import { getChat, saveMessage, updateChatPreview, previewFromMessage } from '../core/chat-store.js';
import { nextChatMessageTimestamp } from '../core/virtual-time-shim.js';
import { getMessageCopyText, isUserPresentInChat } from '../core/chat-helpers.js';
import { sanitizeMomentCommentText } from '../models/moment-post.js';
import { getUserDisplayName } from '../models/user.js';
import { resolveActorDisplayLabel } from '../core/chat/character-code-fallback.js';
import {
  putMomentPost,
  deleteMomentPost,
  buildMomentChatBundleMetadata,
} from '../core/moments/moments-store.js';
import { aiFillMomentReactions } from '../core/moments/moments-ai.js';
import { generationErrorFromCatch } from '../core/generation-error-guide.js';
import { resolveActorName, buildActorOptionsHtml } from '../core/moments/moments-actors.js';
import { normalizeSocialImagePrompt, regenerateSocialPostImage } from '../core/social-image-generation.js';
import { bindNarrationTranslationToggle } from '../core/narration-translation.js';
import { getChatPlatformCopy } from '../core/chat/chat-platform-copy.js';

function refreshWithSavedPost(onRefresh, savedPost) {
  return onRefresh?.(savedPost?.id ? { promotedPosts: [savedPost] } : {});
}

export async function bindMomentPostInteractions(container, ctx = {}) {
  const {
    user,
    actors = [],
    nameMap = new Map(),
    onRefresh,
    setBusy,
  } = ctx;

  const userId = String(user?.id || '').trim();
  bindNarrationTranslationToggle(container);

  container.querySelectorAll('.moment-post').forEach((article) => {
    const postId = article.getAttribute('data-moment-id');
    if (!postId) return;

    article.querySelector('.moment-post-name')?.addEventListener('click', () => {
      const authorId = article.querySelector('.moment-post-name')?.getAttribute('data-author-id');
      if (authorId && authorId !== userId && ctx.onOpenProfile) ctx.onOpenProfile(authorId);
    });
    article.querySelector('.moment-post-avatar')?.addEventListener('click', () => {
      const authorId = article.querySelector('.moment-post-avatar')?.getAttribute('data-author-id');
      if (authorId && authorId !== userId && ctx.onOpenProfile) ctx.onOpenProfile(authorId);
    });

    article.querySelector('.moment-comment-send')?.addEventListener('click', async () => {
      const savedPost = await submitMomentComment(postId, article, ctx);
      await refreshWithSavedPost(onRefresh, savedPost);
    });

    article.querySelector('.moment-comment-input')?.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const savedPost = await submitMomentComment(postId, article, ctx);
      await refreshWithSavedPost(onRefresh, savedPost);
    });

    article.querySelectorAll('.moment-comment-line').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if (e.target.closest('[data-translation-toggle], .chat-bubble-translation')) return;
        const row = btn.closest('.moment-comment-row');
        const nextOpen = !row?.classList.contains('is-editing');
        article.querySelectorAll('.moment-comment-row.is-editing').forEach((other) => {
          other.classList.remove('is-editing');
          other.querySelector('.moment-comment-line')?.setAttribute('aria-expanded', 'false');
          other.querySelector('.moment-comment-actions')?.setAttribute('aria-hidden', 'true');
        });
        row?.classList.toggle('is-editing', nextOpen);
        btn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
        row?.querySelector('.moment-comment-actions')?.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
      });
    });

    article.querySelectorAll('.moment-comment-reply-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = btn.getAttribute('data-comment-idx');
        const post = ctx.getPost?.(postId);
        const c = post?.comments?.[Number(idx)];
        const input = article.querySelector('.moment-comment-input');
        openMomentComposer(article);
        if (input && c) {
          input.dataset.replyTo = commentAuthorKey(c);
          input.placeholder = `回复 ${commentAuthorKey(c)}：`;
          input.focus();
        }
      });
    });

    article.querySelectorAll('.moment-comment-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-comment-idx'));
        const post = ctx.getPost?.(postId);
        if (!post || !Array.isArray(post.comments)) return;
        post.comments = post.comments.filter((_, i) => i !== idx);
        const savedPost = await savePost(post, userId, ctx);
        await refreshWithSavedPost(onRefresh, savedPost);
      });
    });

    article.querySelectorAll('.moment-image-cell img').forEach((img) => {
      img.addEventListener('click', () => {
        const idx = Number(img.getAttribute('data-moment-image-idx') || 0);
        const post = ctx.getPost?.(postId);
        const src = post?.images?.[idx];
        if (!src) return;
        const rawPrompt = String(post?.imagePrompt || '').trim();
        const validPrompt = normalizeSocialImagePrompt(rawPrompt);
        openImageLightbox(src, {
          // 重 roll 按钮自带「生成中…/失败」状态展示，这里不再叠加全局忙碌层
          ...(validPrompt ? { onReroll: () => regenerateMomentImage(postId, idx, ctx) } : {}),
          // 旧数据若误存了 none，仍保留“改词重画”入口，但编辑框从空白开始。
          ...(rawPrompt ? { onEditPrompt: () => editMomentImagePromptAndReroll(postId, idx, ctx) } : {}),
        });
      });
    });

    article.querySelectorAll('[data-moment-textimg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const post = ctx.getPost?.(postId);
        const text = String(post?.textImage || '').trim();
        if (!text) return;
        openChatCardModal({ type: 'textimg', content: text });
      });
    });

    article.querySelectorAll('[data-moment-image-reroll]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.getAttribute('data-moment-image-idx') || 0);
        await regenerateMomentImage(postId, idx, ctx, { toast: true, busy: true }).catch(() => {});
      });
    });

    article.querySelectorAll('[data-moment-image-edit-reroll]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.getAttribute('data-moment-image-idx') || 0);
        await editMomentImagePromptAndReroll(postId, idx, ctx);
      });
    });

    article.querySelector('.moment-post-more')?.addEventListener('click', async () => {
      await openPostMoreMenu(postId, article, ctx);
    });
    article.querySelector('.moment-quick-like')?.addEventListener('click', async () => {
      const savedPost = await toggleMomentLike(postId, article, ctx);
      await refreshWithSavedPost(onRefresh, savedPost);
    });
    article.querySelectorAll('.moment-quick-comment').forEach((button) => button.addEventListener('click', () => {
      openMomentComposer(article);
      article.querySelector('.moment-comment-input')?.focus();
    }));
    article.querySelector('.moment-quick-share')?.addEventListener('click', async () => {
      await forwardMomentToChat(postId, ctx);
    });
  });
}

/** 生成配图 / 重 roll 共用：忽略已有图，强制重新生成并存库 */
async function regenerateMomentImage(postId, idx, ctx, { toast = false, busy = false } = {}) {
  const userId = String(ctx.user?.id || '').trim();
  const post = await loadPost(postId, userId, ctx);
  if (!post) return null;
  if (busy) ctx.setBusy?.(true, '正在生成配图…', { imageGen: true });
  try {
    const url = await regenerateSocialPostImage(post, { scene: 'momentsImages' });
    const nextImages = Array.isArray(post.images) ? [...post.images] : [];
    nextImages[idx] = url;
    const savedPost = await savePost({ ...post, images: nextImages }, userId, ctx);
    if (toast) showToast('配图已生成');
    await refreshWithSavedPost(ctx.onRefresh, savedPost);
    return url;
  } catch (err) {
    if (toast) showToast(err?.message || '生成失败');
    throw err;
  } finally {
    if (busy) ctx.setBusy?.(false);
  }
}

async function editMomentImagePromptAndReroll(postId, idx, ctx) {
  const userId = String(ctx.user?.id || '').trim();
  const post = await loadPost(postId, userId, ctx);
  if (!post) return;
  openTextEditorModal({
    title: '修改配图提示词',
    value: normalizeSocialImagePrompt(post.imagePrompt),
    placeholder: '描述画面主体、场景、构图和光线',
    multiline: true,
    confirmLabel: '保存并重 roll',
    onSave: async (nextPrompt) => {
      const prompt = String(nextPrompt || '').trim();
      if (!prompt) {
        showToast('提示词不能为空');
        return;
      }
      await savePost({
        ...post,
        imagePrompt: prompt,
        wantsImage: true,
      }, userId, ctx);
      await regenerateMomentImage(postId, idx, ctx, { toast: true, busy: true }).catch(() => {});
    },
  });
}

function openMomentComposer(article) {
  const panel = article.querySelector('.moment-comments');
  panel?.classList.add('is-composing');
}

function commentAuthorKey(comment = {}) {
  return String(comment.author || comment.authorName || comment.authorId || '好友').trim() || '好友';
}

async function loadPost(postId, userId, ctx = {}) {
  // 编辑提示词会先落库、随后立刻重抽；页面 ctx 里的 Map 是首屏快照，
  // 此时可能仍保留旧 imagePrompt。交互写入后的读取必须以数据库为准，
  // 否则不仅会按旧词生图，生成完成时还会把新提示词覆盖回去。
  const { getMomentPost } = await import('../core/moments/moments-store.js');
  const stored = await getMomentPost(postId).catch(() => null);
  if (stored && String(stored.userId || '') === String(userId || '')) return stored;
  // 自定义上下文可能不使用 momentsPosts；数据库没有记录时才回退其数据源。
  if (typeof ctx.getPost === 'function') {
    const custom = await ctx.getPost(postId);
    if (custom && String(custom.userId || '') === String(userId || '')) return custom;
  }
  return null;
}

async function savePost(post, userId, ctx = {}) {
  if (typeof ctx.putPost === 'function') {
    return ctx.putPost(post);
  }
  return putMomentPost(post, userId);
}

async function removePost(postId, userId, ctx = {}) {
  if (typeof ctx.deletePost === 'function') {
    return ctx.deletePost(postId);
  }
  return deleteMomentPost(postId, userId);
}

async function toggleMomentLike(postId, article, ctx) {
  const userId = String(ctx.user?.id || '').trim();
  const post = await loadPost(postId, userId, ctx);
  if (!post) return null;
  const actorSel = article.querySelector('.moment-actor-select');
  const actorId = ctx.forceActorId || actorSel?.value || userId;
  const actorName = ctx.actors?.find((a) => a.id === actorId)?.name
    || await resolveActorName(actorId, ctx.nameMap);
  if (!Array.isArray(post.likes)) post.likes = [];
  if (!Array.isArray(post.likesIds)) post.likesIds = [];
  const idx = post.likes.findIndex((x) => (typeof x === 'string' ? x === actorName : x?.name === actorName));
  if (idx >= 0) {
    post.likes.splice(idx, 1);
    post.likesIds = post.likesIds.filter((id) => id !== actorId);
  } else {
    post.likes.push(actorName);
    if (!post.likesIds.includes(actorId)) post.likesIds.push(actorId);
  }
  return savePost(post, userId, ctx);
}

async function submitMomentComment(postId, article, ctx) {
  const userId = String(ctx.user?.id || '').trim();
  const post = await loadPost(postId, userId, ctx);
  if (!post) return null;
  const input = article.querySelector('.moment-comment-input');
  const text = sanitizeMomentCommentText(String(input?.value || '').trim());
  if (!text) return null;
  const actorSel = article.querySelector('.moment-actor-select');
  const actorId = actorSel?.value || userId;
  const actorName = ctx.actors?.find((a) => a.id === actorId)?.name
    || await resolveActorName(actorId, ctx.nameMap);
  if (!Array.isArray(post.comments)) post.comments = [];
  post.comments.push({
    author: actorName,
    authorId: actorId,
    text,
    replyTo: String(input?.dataset?.replyTo || '').trim(),
  });
  const savedPost = await savePost(post, userId, ctx);
  if (input) {
    input.value = '';
    delete input.dataset.replyTo;
    input.placeholder = '写评论…';
  }
  return savedPost;
}

async function forwardMomentToChat(postId, ctx) {
  const platformCopy = getChatPlatformCopy();
  const userId = String(ctx.user?.id || '').trim();
  const post = await loadPost(postId, userId, ctx);
  if (!post) return;
  const dest = await openForwardPicker({
    userId,
    title: `转发${platformCopy.momentsName}到聊天`,
  });
  if (!dest?.chatId) return;
  const destChat = await getChat(dest.chatId).catch(() => null);
  if (!destChat || !isUserPresentInChat(destChat)) {
    showToast('该窗口不支持用户转发');
    return;
  }
  const ts = await nextChatMessageTimestamp(userId, dest.chatId);
  const bundle = createMessage({
    chatId: dest.chatId,
    senderId: 'user',
    senderName: getUserDisplayName(ctx.user),
    type: 'chatBundle',
    content: `${platformCopy.sharePrefix} ${post.authorName || '好友'}`,
    timestamp: ts,
    metadata: {
      ...buildMomentChatBundleMetadata(post),
      momentPostId: post.id,
    },
  });
  await saveMessage(bundle);
  await updateChatPreview(dest.chatId, previewFromMessage(bundle), ts);
  showToast('已转发到聊天');
}

async function openPostMoreMenu(postId, article, ctx) {
  const platformCopy = getChatPlatformCopy();
  const userId = String(ctx.user?.id || '').trim();
  const post = await loadPost(postId, userId, ctx);
  if (!post) return;
  const host = document.getElementById('modal-container');
  if (!host) return;
  const actorOptionsHtml = buildActorOptionsHtml(ctx.actors || [], userId);
  const alreadyLiked = (post.likesIds || []).includes(userId)
    || (post.likes || []).some((x) => (typeof x === 'string' ? x : x?.name) === (ctx.actors?.find((a) => a.id === userId)?.name));
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-moment-more-overlay>
      <div class="modal-sheet scrapbook-card moments-more-sheet" role="dialog" aria-modal="true">
        <header class="modal-header"><h3>动态操作</h3></header>
        <div class="modal-body moments-more-actions">
          ${actorOptionsHtml ? `
            <label class="moments-more-identity-label">互动身份</label>
            <select class="form-input moments-more-identity">${actorOptionsHtml}</select>
          ` : ''}
          <button type="button" class="btn btn-outline btn-sm" data-moment-more-like>${alreadyLiked ? '取消赞' : '赞'}</button>
          <button type="button" class="btn btn-outline btn-sm" data-moment-more-comment>评论</button>
          <button type="button" class="btn btn-outline btn-sm" data-moment-more-ai>AI 补互动</button>
          <button type="button" class="btn btn-outline btn-sm" data-moment-more-forward>转发到聊天</button>
          <button type="button" class="btn is-danger btn-sm" data-moment-more-delete>删除</button>
          <button type="button" class="btn btn-soft btn-sm" data-moment-more-cancel>取消</button>
        </div>
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-moment-more-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-moment-more-cancel]')?.addEventListener('click', close);
  host.querySelector('.moments-more-sheet')?.addEventListener('click', (e) => e.stopPropagation());

  host.querySelector('[data-moment-more-like]')?.addEventListener('click', async () => {
    const identitySel = host.querySelector('.moments-more-identity');
    close();
    const savedPost = await toggleMomentLike(postId, article, { ...ctx, forceActorId: identitySel?.value });
    await refreshWithSavedPost(ctx.onRefresh, savedPost);
  });

  host.querySelector('[data-moment-more-comment]')?.addEventListener('click', () => {
    const identitySel = host.querySelector('.moments-more-identity');
    close();
    openMomentComposer(article);
    const actorSel = article.querySelector('.moment-actor-select');
    if (actorSel && identitySel?.value) actorSel.value = identitySel.value;
    article.querySelector('.moment-comment-input')?.focus();
  });

  host.querySelector('[data-moment-more-ai]')?.addEventListener('click', async () => {
    close();
    const actorIds = (ctx.actors || []).filter((a) => a.kind === 'character').map((a) => a.id);
    const extraLightActors = (ctx.actors || []).filter((a) => a.kind === 'phone-contact');
    if (!actorIds.length && !extraLightActors.length) {
      showToast('通讯录暂无角色');
      return;
    }
    ctx.setBusy?.(true, '正在补互动…');
    try {
      const patch = await aiFillMomentReactions({
        user: ctx.user,
        post,
        actorIds,
        extraLightActors,
        phoneOwnerId: ctx.phoneOwnerId || post.phoneOwnerId || post.metadata?.phoneOwnerId || '',
        interactionMode: 'manual',
        commentLevel: ctx.commentLevel,
      });
      if (!patch) {
        showToast('生成失败');
        return;
      }
      const savedPost = await savePost({ ...post, ...patch }, userId, ctx);
      showToast('已更新互动');
      await refreshWithSavedPost(ctx.onRefresh, savedPost);
    } catch (err) {
      showGenerationErrorReport(generationErrorFromCatch(err, {
        scope: `${platformCopy.momentsName} / 互动生成`,
        title: `${platformCopy.momentsName}互动生成失败`,
      }));
      showToast(err?.message || '生成失败');
    } finally {
      ctx.setBusy?.(false);
    }
  });

  host.querySelector('[data-moment-more-forward]')?.addEventListener('click', async () => {
    close();
    await forwardMomentToChat(postId, ctx);
  });
  host.querySelector('[data-moment-more-delete]')?.addEventListener('click', async () => {
    if (!window.confirm(`确定删除这条${platformCopy.momentsName}？`)) return;
    await removePost(postId, userId, ctx);
    close();
    showToast('已删除');
    await ctx.onRefresh?.();
  });
}

export function buildMomentShareLinesFromMessages(messages = [], { user, characters = {} } = {}) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.deleted && !m.recalled)
    .map((m) => {
      const who = m.senderId === 'user'
        ? getUserDisplayName(user)
        : resolveActorDisplayLabel(
          m.senderName || characters[m.senderId]?.customNickname || characters[m.senderId]?.name || m.senderId,
          { user, characters, fallback: 'TA' },
        );
      const body = getMessageCopyText(m) || String(m.content || '').trim();
      if (!body) return '';
      const text = `${who}：${body}`.slice(0, 200);
      const zhBody = String(m.metadata?.translation || m.translation || '').trim();
      if (zhBody && zhBody !== body) {
        return { text, translation: `${who}：${zhBody}`.slice(0, 200) };
      }
      return text;
    })
    .filter(Boolean);
}

export async function shareChatLinesToMoments({
  user,
  actors,
  lines = [],
  title = '聊天记录',
  caption = '',
  sourceChatId = '',
  involvedActorIds = [],
} = {}) {
  if (!user?.id || !lines.length) return false;
  const postCaption = await new Promise((resolve) => {
    openTextEditorModal({
      title: '分享聊天记录',
      value: String(caption || '').trim(),
      placeholder: '说点什么（可不填）',
      confirmLabel: '发布',
      onSave: (text) => resolve(text),
      onClosed: () => resolve(null),
    });
  });
  if (postCaption == null) return false;
  const { allocMomentTimestamp, putMomentPost } = await import('../core/moments/moments-store.js');
  const ts = await allocMomentTimestamp(user.id);
  const post = {
    id: `moment_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    userId: user.id,
    authorId: user.id,
    authorName: getUserDisplayName(user),
    avatar: user.avatar || '',
    content: postCaption || '分享一则聊天',
    postKind: 'chat_share',
    chatShare: { title, lines: lines.slice(0, 12) },
    timestamp: ts,
    likes: [],
    likesIds: [],
    comments: [],
    visibility: 'all',
    images: [],
    metadata: {
      sourceType: 'chat_share',
      sourceChatId: String(sourceChatId || '').trim(),
      involvedActorIds: [...new Set([
        'user',
        ...(Array.isArray(involvedActorIds) ? involvedActorIds : []),
      ].map((id) => String(id || '').trim()).filter(Boolean))],
    },
  };
  await putMomentPost(post, user.id);
  showToast(`已晒到${getChatPlatformCopy().momentsName}`);
  return true;
}
