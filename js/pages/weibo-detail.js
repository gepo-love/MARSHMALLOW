import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { getVirtualNow } from '../core/virtual-time-shim.js';
import { getAllStickersFlat } from '../core/chat/sticker-resolve.js';
import { cleanSocialDisplayText, resolveSocialAuthorLabel } from '../core/social-helpers.js';
import { getWeiboDisplayName } from '../models/user.js';
import { resolveWeiboUserAvatar } from '../core/resolve-avatar-url.js';
import { formatSocialCount, simulatePostMetrics, estimateCommentLike } from '../core/weibo/weibo-metrics.js';
import { isPrivateWeiboPost, weiboVisibilityLabel, weiboTranslationSuffixHtml } from '../core/weibo/weibo-post-utils.js';
import { saveWeiboRepost } from '../core/weibo/weibo-repost-store.js';
import {
  mountStickerPickerAfterTextarea,
  buildSocialPostDisplayParts,
  renderSocialPostImageStrip,
  renderSocialPostMediaBlock,
  bindWeiboImageLightbox,
} from '../components/social-sticker-picker.js';
import { bindNarrationTranslationToggle } from '../core/narration-translation.js';
import { showActionToast, showToast } from '../components/toast.js';
import { icon } from '../components/svg-icons.js';
import { bindWeiboRichTextLinks } from '../components/weibo-rich-links.js';
import {
  finalizeExpiredWeiboPostDeletions,
  finalizeWeiboPostDeletion,
  isActiveWeiboPost,
  restoreWeiboPost,
  softDeleteWeiboPost,
  WEIBO_DELETE_UNDO_MS,
} from '../core/weibo/weibo-post-store.js';

/** 旧版评论/转发曾硬编码「旅行者」，展示时还原成当前用户名。 */
function resolveWeiboSelfAuthorLabel(author, user, fallback = '匿名') {
  const raw = String(author || '').trim();
  if (raw === '旅行者') return getWeiboDisplayName(user) || fallback;
  return resolveSocialAuthorLabel(raw, { fallback });
}

function e(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function t(ts) {
  return new Date(ts || Date.now()).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * 评论/转发之后整页重渲染会把 .page-scroll 的滚动位置清零，长评论列表下
 * 发完一条又弹回顶部——重渲染前后自己搬运一下滚动位置。
 */
async function rerenderKeepScroll(container, params) {
  const scroller = container.querySelector('.page-scroll');
  const top = scroller ? scroller.scrollTop : 0;
  await render(container, params);
  const nextScroller = container.querySelector('.page-scroll');
  if (nextScroller) nextScroller.scrollTop = top;
}

export default async function render(container, params) {
  const postId = params?.postId;
  const currentUserId = (await db.get('settings', 'currentUserId'))?.value || '';
  const ownerUserId = currentUserId || 'guest';
  await finalizeExpiredWeiboPostDeletions({ ownerUserId });
  const user = currentUserId ? await db.get('users', currentUserId) : null;
  const selfAuthor = getWeiboDisplayName(user);
  const post = postId ? await db.get('weiboPosts', postId) : null;
  if (!post || (post.ownerUserId || '') !== ownerUserId || !isActiveWeiboPost(post)) {
    container.innerHTML = '<div class="placeholder-page"><div class="placeholder-text">微博不存在</div></div>';
    return;
  }
  const stickerPool = await getAllStickersFlat();
  const mainDisp = buildSocialPostDisplayParts(cleanSocialDisplayText(post.content), post.images || [], stickerPool);
  const privatePost = isPrivateWeiboPost(post);
  const sourceComments = privatePost ? [] : (Array.isArray(post.commentList) ? post.commentList : []);
  let repairedCommentIds = false;
  const comments = sourceComments.map((comment, index) => {
    if (comment?.id) return comment;
    repairedCommentIds = true;
    return { ...comment, id: `wbc_legacy_${post.id}_${index}` };
  });
  if (repairedCommentIds) {
    post.commentList = comments;
    await db.put('weiboPosts', post);
  }
  const reposts = privatePost ? [] : (post.repostList || []);
  const repostMeta = post?.metadata?.repostFrom || null;
  const sim = simulatePostMetrics(post);
  const visLab = weiboVisibilityLabel(post.metadata);
  const visHtml = visLab ? `<span class="weibo-vis-badge">${e(visLab)}</span>` : '';
  const displayReposts = Math.max(sim.reposts, Number(post.reposts || 0), reposts.length);
  const displayComments = Math.max(sim.comments, Number(post.comments || 0), comments.length);
  const displayLikes = Math.max(sim.likes, Number(post.likes || 0));
  const commentIndexById = new Map(comments.map((comment, index) => [String(comment.id || ''), index]));
  const childrenByParent = new Map();
  const roots = [];
  for (const [commentIndex, comment] of comments.entries()) {
    const parentId = String(comment.replyToCommentId || '').trim();
    if (parentId && commentIndexById.has(parentId) && commentIndexById.get(parentId) < commentIndex) {
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(comment);
    } else {
      roots.push(comment);
    }
  }

  const renderComment = (comment, depth = 0) => {
    const commentIndex = commentIndexById.get(String(comment.id || ''));
    const cd = buildSocialPostDisplayParts(cleanSocialDisplayText(comment.content), [], stickerPool, { inlineStickers: true });
    const replyHint = comment.replyTo ? `<span>回复 ${e(String(comment.replyTo).trim())}</span>` : '';
    const likedBy = Array.isArray(comment.likedByUserIds) ? comment.likedByUserIds.map(String) : [];
    const liked = currentUserId && likedBy.includes(String(currentUserId));
    const likeCount = Math.max(Number(comment.likes || 0), estimateCommentLike(post, comment)) + (liked ? 1 : 0);
    const children = childrenByParent.get(String(comment.id || '')) || [];
    return `<div class="wb-detail-comment-node ${depth ? 'is-child' : ''}" data-weibo-comment-index="${commentIndex}" data-comment-id="${e(comment.id)}">
      <button type="button" class="wb-detail-comment-body" data-comment-reply="${e(comment.id)}">
        <span class="wb-detail-comment-author">${e(resolveWeiboSelfAuthorLabel(comment.author, user, '匿名'))}${replyHint}</span>
        <span class="social-richtext wb-detail-comment-text">${cd.richTextHtml}</span>
        ${weiboTranslationSuffixHtml(comment.content || '', comment.translation || '')}
        ${renderSocialPostImageStrip(cd.mergedImages, 'weibo')}
      </button>
      <button type="button" class="wb-detail-comment-like ${liked ? 'is-liked' : ''}" data-comment-like="${e(comment.id)}">${icon('weiboLike')} ${formatSocialCount(likeCount)}</button>
      ${children.length ? `<div class="wb-detail-comment-children">${children.map((child) => renderComment(child, depth + 1)).join('')}</div>` : ''}
    </div>`;
  };

  container.classList.add('weibo-page', 'weibo-detail-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn wb-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">微博详情</h1>
      <button type="button" class="navbar-btn wb-detail-delete" aria-label="删除微博">${icon('trash')}</button>
    </header>
    <div class="page-scroll weibo-detail-scroll">
      <div class="card-block weibo-detail-post">
        <div class="weibo-post-name">${e(resolveSocialAuthorLabel(post.authorName, { fallback: '匿名用户' }))}</div>
        <div class="weibo-post-meta">${e(t(post.timestamp))}${post.metadata?.editedAt ? ' · 已编辑' : ''}</div>
        ${visHtml ? `<div class="weibo-post-vis" style="margin-top:6px;">${visHtml}</div>` : ''}
        ${repostMeta ? `<div class="weibo-repost-origin">转发 @${e(resolveSocialAuthorLabel(repostMeta.authorName || repostMeta.authorId, { fallback: '某人' }))}${repostMeta.content ? `：${e(cleanSocialDisplayText(repostMeta.content).slice(0, 120))}` : ''}</div>` : ''}
        <div class="weibo-detail-metrics-bar">
          <button type="button" data-interaction-tab="reposts"><strong>${formatSocialCount(displayReposts)}</strong> 转发</button>
          <button type="button" data-interaction-tab="comments"><strong>${formatSocialCount(displayComments)}</strong> 评论</button>
          <button type="button" data-interaction-tab="likes"><strong>${formatSocialCount(displayLikes)}</strong> 赞</button>
        </div>
        <div class="weibo-post-content social-richtext" style="margin-top:8px;">${mainDisp.richTextHtml}</div>
        ${weiboTranslationSuffixHtml(post.content || '', post.metadata?.contentTranslation || post.contentTranslation || '')}
        ${renderSocialPostMediaBlock(post, mainDisp.mergedImages, 'weibo', { stickerUrls: mainDisp.stickerImageUrls })}
      </div>
      <div class="card-block weibo-detail-section">
        <div style="font-weight:600;">转发 · ${formatSocialCount(displayReposts)}</div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
          ${reposts
            .map((r) => {
              const rd = buildSocialPostDisplayParts(cleanSocialDisplayText(r.content || '转发微博'), [], stickerPool, { inlineStickers: true });
              return `<div style="padding:8px;border-radius:10px;background:#f7fbff;border:1px solid #d8e8fa;"><div style="font-size:12px;color:#6f8cab;">${e(resolveWeiboSelfAuthorLabel(r.author, user, '匿名转发'))} · ${e(t(r.timestamp))}</div><div class="social-richtext">${rd.richTextHtml}</div>${weiboTranslationSuffixHtml(r.content || '', r.translation || '')}${renderSocialPostImageStrip(rd.mergedImages, 'weibo')}</div>`;
            })
            .join('') || '<div class="text-hint">暂无站内转发记录（数字含剧情热度）</div>'}
        </div>
      </div>
      <div class="card-block weibo-detail-section weibo-detail-comments">
        <div style="font-weight:600;">评论 · ${formatSocialCount(displayComments)}</div>
        <div class="wb-detail-comment-tree">
          ${roots.map((comment) => renderComment(comment)).join('') || '<div class="text-hint">暂无评论</div>'}
        </div>
        <div class="wb-detail-replying" hidden><span></span><button type="button" class="wb-detail-reply-cancel">取消</button></div>
        ${privatePost ? '<div class="text-hint" style="margin-top:10px;">仅自己可见的微博不开放互动</div>' : '<textarea class="form-input wb-detail-comment" rows="3" placeholder="写评论..." style="margin-top:10px;"></textarea>'}
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button type="button" class="btn btn-outline wb-detail-repost" style="flex:1;" ${privatePost ? 'disabled' : ''}>转发</button>
          <button type="button" class="btn btn-primary wb-detail-send" style="flex:1;" ${privatePost ? 'disabled' : ''}>发送评论</button>
        </div>
      </div>
    </div>
  `;
  bindWeiboRichTextLinks(container);
  mountStickerPickerAfterTextarea(container, '.wb-detail-comment');
  bindWeiboImageLightbox(container);
  bindNarrationTranslationToggle(container, {
    onRepaired: async (translation, { button } = {}) => {
      const commentIndex = Number(button?.closest('[data-weibo-comment-index]')?.getAttribute('data-weibo-comment-index'));
      if (!Number.isInteger(commentIndex) || commentIndex < 0 || !post.commentList?.[commentIndex]) return;
      post.commentList[commentIndex] = { ...post.commentList[commentIndex], translation };
      await db.put('weiboPosts', post);
    },
    onFailed: () => showToast('翻译暂时不可用，请稍后再试'),
  });
  container.querySelector('.wb-back')?.addEventListener('click', () => back());
  container.querySelectorAll('[data-interaction-tab]').forEach((button) => button.addEventListener('click', () => {
    navigate('weibo-interactions', { postId: post.id, tab: button.dataset.interactionTab });
  }));
  const commentInput = container.querySelector('.wb-detail-comment');
  const replyingBar = container.querySelector('.wb-detail-replying');
  const clearReplyTarget = () => {
    if (commentInput) {
      delete commentInput.dataset.replyToCommentId;
      delete commentInput.dataset.replyToName;
      commentInput.placeholder = '写评论...';
    }
    if (replyingBar) replyingBar.hidden = true;
  };
  container.querySelectorAll('[data-comment-reply]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.commentReply;
    const comment = comments.find((item) => String(item.id) === id);
    if (!comment || !commentInput) return;
    const name = resolveWeiboSelfAuthorLabel(comment.author, user, '匿名');
    commentInput.dataset.replyToCommentId = id;
    commentInput.dataset.replyToName = name;
    commentInput.placeholder = `回复 ${name}`;
    if (replyingBar) {
      replyingBar.hidden = false;
      const label = replyingBar.querySelector('span');
      if (label) label.textContent = `回复 ${name}`;
    }
    commentInput.focus({ preventScroll: true });
  }));
  container.querySelector('.wb-detail-reply-cancel')?.addEventListener('click', clearReplyTarget);
  container.querySelectorAll('[data-comment-like]').forEach((button) => button.addEventListener('click', async () => {
    const comment = comments.find((item) => String(item.id) === button.dataset.commentLike);
    if (!comment || !currentUserId) return;
    const likedBy = new Set((Array.isArray(comment.likedByUserIds) ? comment.likedByUserIds : []).map(String));
    if (likedBy.has(String(currentUserId))) likedBy.delete(String(currentUserId));
    else likedBy.add(String(currentUserId));
    comment.likedByUserIds = [...likedBy];
    post.commentList = comments;
    await db.put('weiboPosts', post);
    await rerenderKeepScroll(container, params);
  }));
  container.querySelector('.wb-detail-delete')?.addEventListener('click', async () => {
    if (!window.confirm('确认删除这条微博吗？')) return;
    await softDeleteWeiboPost(post.id);
    back();
    showActionToast('微博已删除', {
      label: '撤销',
      duration: WEIBO_DELETE_UNDO_MS,
      onAction: async () => {
        await restoreWeiboPost(post.id);
        showToast('已恢复');
      },
      onExpire: () => {
        void finalizeWeiboPostDeletion(post.id, post).catch(() => {});
      },
      onError: () => showToast('恢复失败，请稍后再试'),
    });
  });
  container.querySelector('.wb-detail-send')?.addEventListener('click', async () => {
    if (privatePost) return;
    const text = (commentInput?.value || '').trim();
    if (!text) return;
    const nowTs = await getVirtualNow(currentUserId || '', 0);
    post.commentList = [...(post.commentList || []), {
      id: `wbc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      author: selfAuthor,
      authorId: String(currentUserId || '').trim(),
      content: text,
      timestamp: nowTs,
      likes: 0,
      ...(commentInput?.dataset.replyToCommentId ? {
        replyToCommentId: commentInput.dataset.replyToCommentId,
        replyTo: commentInput.dataset.replyToName || '',
      } : {}),
    }];
    post.comments = Math.max(Number(post.comments || 0), post.commentList.length);
    await db.put('weiboPosts', post);
    await rerenderKeepScroll(container, params);
  });
  const focusCommentId = String(params?.focusCommentId || '').trim();
  if (focusCommentId) {
    requestAnimationFrame(() => {
      const target = container.querySelector(`[data-comment-id="${CSS.escape(focusCommentId)}"]`);
      target?.scrollIntoView({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      target?.classList.add('is-focused');
    });
  }
  container.querySelector('.wb-detail-repost')?.addEventListener('click', async () => {
    if (privatePost) return;
    const rawText = window.prompt('转发并评论（可空）', '');
    if (rawText === null) return;
    const text = String(rawText).trim();
    const nowTs = await getVirtualNow(currentUserId || '', 0);
    await saveWeiboRepost({
      sourcePost: post,
      ownerUserId,
      authorId: currentUserId || 'guest',
      authorName: selfAuthor,
      avatar: resolveWeiboUserAvatar(user) || null,
      comment: text,
      timestamp: nowTs,
    });
    await rerenderKeepScroll(container, params);
  });
}
