import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { chat as apiChat, resolveGenerationMaxTokens } from '../core/api.js';
import {
  buildWeiboAiSystemPrompt,
  getWeiboBackgroundConfigFromSettings,
} from '../core/context/build-weibo-context.js';
import { getCharacter } from '../core/character-store.js';
import { cleanSocialDisplayText, resolveSocialAuthorLabel } from '../core/social-helpers.js';
import {
  generateWeiboDmCharacterReply,
  generateWeiboDmCounterpartReplies,
  syncWeiboDmReplyAwareness,
} from '../core/weibo/weibo-dm-reply.js';
import {
  appendWeiboDmIncoming,
  appendWeiboDmOutgoing,
  getWeiboDmThread,
  listWeiboDmMessages,
  listWeiboDmThreads,
  updateWeiboDmThread,
} from '../core/weibo/weibo-dm-store.js';
import { getVirtualNow, getVirtualTimePromptStamp } from '../core/virtual-time-shim.js';
import { showToast } from '../components/toast.js';
import { setButtonLoading } from '../components/generation-busy.js';
import { showGenerationErrorReport } from '../components/generation-error-report.js';
import { generationErrorFromCatch } from '../core/generation-error-guide.js';
import { weiboTranslationSuffixHtml } from '../core/weibo/weibo-post-utils.js';
import { sanitizeAiTranslation } from '../core/translation-utils.js';
import { bindNarrationTranslationToggle } from '../core/narration-translation.js';
import { fileToOptimizedChatImageDataUrl } from '../core/chat/chat-image-utils.js';
import { openImageLightbox } from '../components/image-lightbox.js';
import { icon } from '../components/svg-icons.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';
import { getAllStickersFlat } from '../core/chat/sticker-resolve.js';
import {
  collectSocialStickerTagNames,
  renderSocialRichText,
  stripSocialStickerMarkers,
  stripSocialStickerTranslationArtifacts,
} from '../components/social-sticker-picker.js';
import {
  buildWeiboDmPublicCharacter,
  buildWeiboDmRelationshipBoundary,
} from '../core/weibo/weibo-dm-boundary.js';

function e(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatListTime(timestamp) {
  const date = new Date(Number(timestamp || Date.now()));
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function formatBubbleTime(timestamp) {
  return new Date(Number(timestamp || Date.now())).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function avatarText(name) {
  return Array.from(String(name || '匿').trim()).slice(-2).join('');
}

function messagePreview(thread, stickerPool = []) {
  const raw = cleanSocialDisplayText(thread?.lastMessage || '').trim();
  const text = stripSocialStickerMarkers(raw, stickerPool).trim();
  if (text) return text;
  if (collectSocialStickerTagNames(raw, stickerPool).length) return '[表情包]';
  return '图片';
}

const activeCounterpartRounds = new Set();

function renderSharedPost(message) {
  const post = message?.sharedPostSnapshot;
  if (!post && !message?.sharedPostId) return '';
  return `<button type="button" class="wbdm-share-card" data-shared-post-id="${e(message.sharedPostId || post?.id)}">
    <strong>@${e(post?.authorName || '微博用户')}</strong>
    <span>${e(cleanSocialDisplayText(post?.content || '查看分享的微博'))}</span>
  </button>`;
}

function renderMessage(message, stickerPool = []) {
  const media = Array.isArray(message?.media) ? message.media : [];
  const content = cleanSocialDisplayText(message?.content || '').trim();
  const contentHtml = renderSocialRichText(content, stickerPool);
  const translation = stripSocialStickerTranslationArtifacts(
    content,
    message?.translation || '',
    stickerPool,
  );
  return `<div class="wbdm-bubble-row ${message.direction === 'outgoing' ? 'is-outgoing' : 'is-incoming'}">
    <div class="wbdm-bubble-wrap">
      <div class="wbdm-bubble">
        ${content ? `<div class="wbdm-bubble-text social-richtext">${contentHtml}</div>` : ''}
        ${media.length ? `<div class="wbdm-bubble-media">${media.map((item) => `<button type="button" data-dm-image="${e(item.url || item)}"><img src="${e(item.url || item)}" alt="私信图片"></button>`).join('')}</div>` : ''}
        ${renderSharedPost(message)}
        ${weiboTranslationSuffixHtml(content, translation)}
      </div>
      <div class="wbdm-bubble-time">${e(formatBubbleTime(message.timestamp))}${message.status === 'failed' ? ' · 发送失败' : ''}</div>
    </div>
  </div>`;
}

async function renderThread(container, params, context) {
  const { ownerUserId, currentUserId } = context;
  const thread = await getWeiboDmThread(ownerUserId, params.threadId);
  if (!thread) {
    showToast('会话已不存在');
    back();
    return;
  }
  await updateWeiboDmThread(ownerUserId, thread.id, { unreadCount: 0 });
  const messages = await listWeiboDmMessages(ownerUserId, thread.id);
  const stickerPool = await getAllStickersFlat().catch(() => []);
  const effectiveAuthorId = thread.authorId || String(params?.authorId || '');
  const effectiveProfileName = thread.profileName === thread.profileKey && params?.profileName
    ? String(params.profileName)
    : thread.profileName;
  const effectiveIsSelf = thread.isSelf === true || params?.isSelf === true;
  const character = effectiveAuthorId ? await getCharacter(effectiveAuthorId) : null;
  const lastIncoming = [...messages].reverse().find((message) => message.direction === 'incoming');
  const roundKey = `${ownerUserId}:${thread.id}`;
  const isGeneratingCounterpart = activeCounterpartRounds.has(roundKey);

  container.innerHTML = `
    <header class="navbar wbdm-navbar">
      <button type="button" class="navbar-btn wbdm-back" aria-label="返回">${icon('back')}</button>
      <div class="wbdm-thread-title"><strong>${e(thread.counterpartName)}</strong><span>${e(thread.muted ? '已免打扰' : thread.counterpartType)}</span></div>
      <button type="button" class="navbar-btn wbdm-thread-more" aria-label="会话设置">${icon('more')}</button>
    </header>
    <div class="page-scroll weibo-dm-scroll wbdm-thread-scroll">
      <div class="wbdm-thread-settings" hidden>
        <button type="button" data-thread-action="pin">${thread.pinned ? '取消置顶' : '置顶会话'}</button>
        <button type="button" data-thread-action="mute">${thread.muted ? '取消免打扰' : '消息免打扰'}</button>
        <button type="button" data-thread-action="delete">删除会话</button>
      </div>
      <div class="wbdm-message-list">${messages.map((message) => renderMessage(message, stickerPool)).join('') || '<div class="wbdm-empty">发条消息，开始聊天</div>'}${isGeneratingCounterpart ? `<div class="wbdm-typing" role="status"><span></span><span></span><span></span><em>${e(thread.counterpartName)}正在输入</em></div>` : ''}</div>
    </div>
    <div class="wbdm-inputbar">
      <label class="wbdm-image-button ${isGeneratingCounterpart ? 'is-disabled' : ''}" aria-label="发送图片" ${isGeneratingCounterpart ? 'aria-disabled="true"' : ''}>${icon('plus')}<input type="file" accept="image/*" hidden ${isGeneratingCounterpart ? 'disabled' : ''}></label>
      <textarea class="wbdm-message-input" rows="1" maxlength="2000" placeholder="发私信" ${isGeneratingCounterpart ? 'disabled' : ''}></textarea>
      ${character && lastIncoming ? `<button type="button" class="wbdm-ai-reply" aria-label="生成主页回复草稿" title="生成主页回复草稿" ${isGeneratingCounterpart ? 'disabled' : ''}>${icon('sparkle')}</button>` : ''}
      <button type="button" class="wbdm-next-reply" aria-label="推进对话" title="推进对话" ${isGeneratingCounterpart ? 'disabled' : ''}>${icon('zap')}</button>
      <button type="button" class="wbdm-send" ${isGeneratingCounterpart ? 'disabled' : ''}>发送</button>
    </div>`;

  const scroll = container.querySelector('.wbdm-thread-scroll');
  if (scroll) requestAnimationFrame(() => scroll.scrollTop = scroll.scrollHeight);
  bindNarrationTranslationToggle(container, { onFailed: () => showToast('翻译暂时不可用') });
  container.querySelector('.wbdm-back')?.addEventListener('click', () => back());
  container.querySelector('.wbdm-thread-more')?.addEventListener('click', () => {
    const panel = container.querySelector('.wbdm-thread-settings');
    if (panel) panel.hidden = !panel.hidden;
  });
  container.querySelectorAll('[data-dm-image]').forEach((button) => button.addEventListener('click', () => openImageLightbox(button.dataset.dmImage)));
  container.querySelectorAll('.wbdm-bubble .chat-sticker img').forEach((image) => image.addEventListener('click', () => {
    const src = String(image.getAttribute('src') || '').trim();
    if (src) openImageLightbox(src);
  }));
  container.querySelectorAll('[data-shared-post-id]').forEach((button) => button.addEventListener('click', () => {
    const postId = button.dataset.sharedPostId;
    if (postId) navigate('weibo-detail', { postId });
  }));
  container.querySelectorAll('[data-thread-action]').forEach((button) => button.addEventListener('click', async () => {
    const action = button.dataset.threadAction;
    if (action === 'delete') {
      if (!window.confirm('删除这个会话？')) return;
      await updateWeiboDmThread(ownerUserId, thread.id, { deletedAt: Date.now() });
      back();
      return;
    }
    const patch = action === 'pin' ? { pinned: !thread.pinned } : { muted: !thread.muted };
    await updateWeiboDmThread(ownerUserId, thread.id, patch);
    await renderThread(container, params, context);
  }));

  const input = container.querySelector('.wbdm-message-input');
  input?.addEventListener('input', () => {
    delete input.dataset.aiGenerated;
    delete input.dataset.aiTranslation;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
  });
  const generateCounterpartRound = async () => {
    if (activeCounterpartRounds.has(roundKey)) return;
    activeCounterpartRounds.add(roundKey);
    try {
      await renderThread(container, params, context);
      const [freshThread, freshMessages, user] = await Promise.all([
        getWeiboDmThread(ownerUserId, thread.id),
        listWeiboDmMessages(ownerUserId, thread.id),
        currentUserId ? db.get('users', currentUserId) : null,
      ]);
      if (!freshThread) throw new Error('私信会话已不存在');
      const replies = await generateWeiboDmCounterpartReplies({
        user,
        character,
        thread: freshThread,
        messages: freshMessages,
      });
      const nowTs = await getVirtualNow(currentUserId || '', 0);
      for (const [index, reply] of replies.entries()) {
        await appendWeiboDmIncoming({
          ownerUserId,
          profileKey: freshThread.profileKey,
          profileName: freshThread.profileName,
          authorId: freshThread.authorId,
          isSelf: freshThread.isSelf,
          counterpartKey: freshThread.counterpartKey,
          senderName: freshThread.counterpartName,
          senderType: freshThread.counterpartType,
          content: reply.content,
          translation: reply.translation || '',
          timestamp: nowTs + index * 1200,
          source: 'conversation',
        });
      }
    } catch (error) {
      showGenerationErrorReport(generationErrorFromCatch(error, { scope: '微博 / 私信连续对话', title: '生成对方回复失败' }));
    } finally {
      activeCounterpartRounds.delete(roundKey);
      await renderThread(container, params, context);
    }
  };

  const send = async ({ media = [] } = {}) => {
    const content = String(input?.value || '').trim();
    if (!content && !media.length) return;
    const nowTs = await getVirtualNow(currentUserId || '', 0);
    const source = input?.dataset.aiGenerated === '1' ? 'char_ai' : (effectiveIsSelf ? 'user' : 'user_as_char');
    const translation = source === 'char_ai' ? sanitizeAiTranslation(content, input?.dataset.aiTranslation || '') : '';
    const sent = await appendWeiboDmOutgoing(ownerUserId, thread.id, {
      content,
      media,
      timestamp: nowTs,
      source,
      translation,
      senderName: effectiveProfileName,
    });
    if (character?.id && lastIncoming) {
      await syncWeiboDmReplyAwareness({
        characterId: character.id,
        userId: currentUserId,
        dmId: lastIncoming.legacyDmId || lastIncoming.id,
        replyId: sent.id,
        fanName: thread.counterpartName,
        fanContent: lastIncoming.content,
        replyContent: content || '[图片]',
        replyBy: source,
      }).catch(() => {});
    }
    await renderThread(container, params, context);
  };
  container.querySelector('.wbdm-send')?.addEventListener('click', () => send());
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  container.querySelector('.wbdm-image-button input')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const optimized = await fileToOptimizedChatImageDataUrl(file);
      await send({ media: [{ type: 'image', url: optimized.dataUrl }] });
    } catch (error) {
      showToast(error?.message || '图片读取失败');
    }
  });
  container.querySelector('.wbdm-next-reply')?.addEventListener('click', () => generateCounterpartRound());
  container.querySelector('.wbdm-ai-reply')?.addEventListener('click', async (event) => {
    if (!character || !lastIncoming || !input) return;
    setButtonLoading(event.currentTarget, true, { label: '…', preserveIcon: false });
    try {
      const user = currentUserId ? await db.get('users', currentUserId) : null;
      const reply = await generateWeiboDmCharacterReply({
        character,
        user,
        thread,
        messages,
        dm: { id: lastIncoming.id, senderName: thread.counterpartName, content: lastIncoming.content },
      });
      input.value = String(reply?.content || '').trim();
      input.dataset.aiGenerated = '1';
      if (reply?.translation) input.dataset.aiTranslation = reply.translation;
      input.focus();
    } catch (error) {
      showGenerationErrorReport(generationErrorFromCatch(error, { scope: '微博 / 私信回复', title: '生成回复失败' }));
    } finally {
      setButtonLoading(event.currentTarget, false);
    }
  });
}

async function generateIncomingDms({ ownerUserId, currentUserId, profileKey, profileName, authorId, isSelf, button }) {
  setButtonLoading(button, true, { label: '…', preserveIcon: false });
  try {
    const nowTs = await getVirtualNow(currentUserId || '', 0);
    const user = currentUserId ? await db.get('users', currentUserId) : null;
    const character = !isSelf && authorId ? await getCharacter(authorId) : null;
    const bgConfig = await getWeiboBackgroundConfigFromSettings(currentUserId || '');
    const publicCharacter = buildWeiboDmPublicCharacter(character, currentUserId);
    const existingThreads = (await listWeiboDmThreads(ownerUserId, { profileKey })).slice(0, 6);
    const historyGroups = await Promise.all(existingThreads.map(async (thread) => {
      const recent = (await listWeiboDmMessages(ownerUserId, thread.id)).slice(-6);
      return recent.length
        ? `${thread.counterpartName}（${thread.counterpartType}）\n${recent.map((message) => `${message.direction === 'incoming' ? thread.counterpartName : profileName}：${cleanSocialDisplayText(message.content || '[图片]')}`).join('\n')}`
        : '';
    }));
    const dmHistory = historyGroups.filter(Boolean).join('\n\n');
    const relationshipBoundary = buildWeiboDmRelationshipBoundary({ existingThreads });
    const systemPrompt = await buildWeiboAiSystemPrompt(user, '生活', {
      worldBookIds: bgConfig.worldBookIds,
      backgroundMode: bgConfig.backgroundMode,
      referenceNotes: '',
      characters: publicCharacter ? [publicCharacter] : [],
      characterCardMode: publicCharacter ? 'full' : 'compact',
      passerbyIsolation: true,
    });
    const timeStamp = await getVirtualTimePromptStamp(currentUserId || '', nowTs);
    const userMessage = [
      `当前虚拟时间：${timeStamp}\n收件人主页：${profileName}\n生成 1-3 条自然的微博私信。发送者可以是粉丝、路人、同行或商务联系人；有明确历史的同名账号可以续聊，新账号必须像第一次联系，避免每条都夸赞。${dmHistory ? `\n\n近期私信历史：\n${dmHistory}` : ''}`,
      relationshipBoundary,
      '输出要求',
      '只输出合法 JSON：{"dms":[{"senderName":"昵称","senderType":"类型","content":"内容","zh":"仅外语需要"}]}',
    ].join('\n\n');
    const raw = await apiChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ], { temperature: 0.9, maxTokens: await resolveGenerationMaxTokens() });
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    let count = 0;
    for (const dm of (Array.isArray(parsed?.dms) ? parsed.dms : []).slice(0, 3)) {
      const content = cleanSocialDisplayText(dm?.content).trim();
      if (!content) continue;
      await appendWeiboDmIncoming({
        ownerUserId,
        profileKey,
        profileName,
        authorId,
        isSelf,
        senderName: resolveSocialAuthorLabel(dm?.senderName, { fallback: '路人粉' }),
        senderType: String(dm?.senderType || '粉丝'),
        content,
        translation: sanitizeAiTranslation(content, dm?.zh || dm?.translation || ''),
        timestamp: nowTs - Math.floor(Math.random() * 900000),
      });
      count += 1;
    }
    showToast(count ? `收到 ${count} 条新私信` : '这次没有新私信');
  } catch (error) {
    showGenerationErrorReport(generationErrorFromCatch(error, { scope: '微博 / 私信生成', title: '生成私信失败' }));
    showToast(error?.message || '生成失败');
  } finally {
    setButtonLoading(button, false);
  }
}

async function renderList(container, params, context) {
  const { ownerUserId, currentUserId, currentUserName } = context;
  const profileKey = String(params?.profileKey || currentUserId || 'user');
  const profileName = String(params?.profileName || '消息');
  const authorId = String(params?.authorId || '');
  const isSelf = params?.isSelf === true || (!!authorId && authorId === currentUserId);
  const filter = String(params?.dmFilter || 'all');
  const threads = await listWeiboDmThreads(ownerUserId, {
    profileKeys: isSelf ? [currentUserId, currentUserName, 'user'] : [profileKey],
    unreadOnly: filter === 'unread',
  });
  const stickerPool = await getAllStickersFlat().catch(() => []);

  container.innerHTML = `
    <header class="navbar wbdm-navbar">
      <button type="button" class="navbar-btn wbdm-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">${e(isSelf ? '消息' : `${profileName} · 私信`)}</h1>
      <button type="button" class="navbar-btn wbdm-gen" aria-label="生成私信">${icon('zap')}</button>
    </header>
    <div class="page-scroll weibo-dm-scroll wbdm-inbox-scroll">
      <div class="wbdm-tabs" role="tablist">
        <button type="button" class="${filter === 'all' ? 'is-active' : ''}" data-dm-filter="all">全部</button>
        <button type="button" class="${filter === 'unread' ? 'is-active' : ''}" data-dm-filter="unread">未读</button>
      </div>
      <div class="wbdm-conversation-list">
        ${threads.map((thread) => `<div class="wbdm-conversation ${thread.pinned ? 'is-pinned' : ''}">
          <button type="button" class="wbdm-conversation-main" data-thread-id="${e(thread.id)}">
            <span class="wbdm-avatar"><img src="${e(resolveDefaultAvatar('weibo'))}" alt=""></span>
            <span class="wbdm-conversation-copy">
              <span class="wbdm-conversation-head"><strong>${e(thread.counterpartName)}</strong><time>${e(formatListTime(thread.updatedAt))}</time></span>
              <span class="wbdm-conversation-preview">${thread.muted ? '🔕 ' : ''}${thread.pinned ? '置顶 · ' : ''}${e(messagePreview(thread, stickerPool))}</span>
            </span>
            ${Number(thread.unreadCount || 0) ? `<span class="wbdm-unread">${Math.min(99, Number(thread.unreadCount))}</span>` : ''}
          </button>
          <button type="button" class="wbdm-row-more" data-row-more="${e(thread.id)}" aria-label="会话操作">${icon('more')}</button>
          <div class="wbdm-row-actions" data-row-actions="${e(thread.id)}" hidden>
            <button type="button" data-list-action="pin" data-thread-id="${e(thread.id)}">${thread.pinned ? '取消置顶' : '置顶'}</button>
            <button type="button" data-list-action="mute" data-thread-id="${e(thread.id)}">${thread.muted ? '取消免打扰' : '免打扰'}</button>
            ${thread.unreadCount ? `<button type="button" data-list-action="read" data-thread-id="${e(thread.id)}">标为已读</button>` : ''}
            <button type="button" data-list-action="delete" data-thread-id="${e(thread.id)}">删除</button>
          </div>
        </div>`).join('') || `<div class="wbdm-empty">${filter === 'unread' ? '没有未读消息' : '暂无私信'}</div>`}
      </div>
    </div>`;

  container.querySelector('.wbdm-back')?.addEventListener('click', () => back());
  container.querySelectorAll('[data-dm-filter]').forEach((button) => button.addEventListener('click', () => renderList(container, { ...params, dmFilter: button.dataset.dmFilter }, context)));
  container.querySelectorAll('.wbdm-conversation-main').forEach((button) => button.addEventListener('click', () => navigate('weibo-dm', { ...params, threadId: button.dataset.threadId })));
  container.querySelectorAll('[data-row-more]').forEach((button) => button.addEventListener('click', () => {
    const actions = container.querySelector(`[data-row-actions="${CSS.escape(button.dataset.rowMore)}"]`);
    if (actions) actions.hidden = !actions.hidden;
  }));
  container.querySelectorAll('[data-list-action]').forEach((button) => button.addEventListener('click', async () => {
    const thread = threads.find((item) => item.id === button.dataset.threadId);
    if (!thread) return;
    const action = button.dataset.listAction;
    if (action === 'delete' && !window.confirm('删除这个会话？')) return;
    const patch = action === 'pin' ? { pinned: !thread.pinned }
      : action === 'mute' ? { muted: !thread.muted }
        : action === 'read' ? { unreadCount: 0 }
          : { deletedAt: Date.now() };
    await updateWeiboDmThread(ownerUserId, thread.id, patch);
    await renderList(container, params, context);
  }));
  container.querySelector('.wbdm-gen')?.addEventListener('click', async (event) => {
    await generateIncomingDms({ ownerUserId, currentUserId, profileKey, profileName, authorId, isSelf, button: event.currentTarget });
    await renderList(container, params, context);
  });
}

export default async function render(container, params = {}) {
  const currentUserId = (await db.get('settings', 'currentUserId'))?.value || '';
  const currentUserName = currentUserId ? String((await db.get('users', currentUserId))?.name || '') : '';
  const ownerUserId = params?.ownerUserId || currentUserId || 'guest';
  container.classList.add('weibo-page', 'weibo-dm-page');
  const context = { ownerUserId, currentUserId, currentUserName };
  if (params.threadId) return renderThread(container, params, context);
  return renderList(container, params, context);
}
