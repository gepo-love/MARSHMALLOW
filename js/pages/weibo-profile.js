import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { chat as apiChat, resolveGenerationMaxTokens } from '../core/api.js';
import {
  buildWeiboAiSystemPrompt,
  collectRoleplayContextForSocialGeneration,
  normalizeWeiboBackgroundConfig,
} from '../core/context/build-weibo-context.js';
import { getCharacter } from '../core/character-store.js';
import { listSocialVisibleCharacters } from '../core/social-character-scope.js';
import {
  buildSocialGenerationExtraPrompt,
  buildSocialCharacterCardsBlock,
  cleanSocialDisplayText,
  resolveSocialAuthorLabel,
} from '../core/social-helpers.js';
import { getVirtualNow } from '../core/virtual-time-shim.js';
import { formatSocialCount, simulatePostMetrics } from '../core/weibo/weibo-metrics.js';
import {
  normalizePostFromAi,
  resolveGeneratedWeiboRepostMeta,
  weiboVisibilityLabel,
  weiboTranslationSuffixHtml,
} from '../core/weibo/weibo-post-utils.js';
import { appendWeiboGlobalContextBatch } from '../core/weibo/weibo-memory-sync.js';
import { loadWeiboMetaCompat } from '../core/weibo/weibo-meta-store.js';
import { icon } from '../components/svg-icons.js';
import { getAllStickersFlat } from '../core/chat/sticker-resolve.js';
import {
  buildSocialPostDisplayParts,
  renderSocialPostMediaBlock,
  bindWeiboImageLightbox,
} from '../components/social-sticker-picker.js';
import { resolveAvatarUrl, resolveWeiboUserAvatar } from '../core/resolve-avatar-url.js';
import { resolveDefaultAvatar } from '../core/default-avatar.js';
import { setButtonLoading } from '../components/generation-busy.js';
import { showToast } from '../components/toast.js';
import { filterNonGuidanceMessages } from '../core/guidance-memory.js';
import { openAllowStickersModal } from '../components/moments-gen-image-modal.js';
import { saveUserRecord } from '../core/user-slot.js';
import { getWeiboDisplayName } from '../models/user.js';
import { fileToCroppedOptimizedAvatarDataUrl } from '../components/image-crop-modal.js';
import {
  buildJsonFieldTranslationPromptBlock,
  collectTranslationActors,
  sanitizeAiTranslation,
} from '../core/translation-utils.js';
import { bindNarrationTranslationToggle } from '../core/narration-translation.js';
import { listActiveWeiboPosts } from '../core/weibo/weibo-post-store.js';
import { appendWeiboDmIncoming } from '../core/weibo/weibo-dm-store.js';
import { bindWeiboRichTextLinks } from '../components/weibo-rich-links.js';
import {
  applyWeiboCharacterStickerPolicy,
  characterAllowsWeiboStickers,
} from '../core/weibo/weibo-character-policy.js';
import { buildWeiboDmRelationshipBoundary } from '../core/weibo/weibo-dm-boundary.js';

function e(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function t(ts) {
  return new Date(ts || Date.now()).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function openGlobalModal(innerHtml) {
  const host = document.getElementById('modal-container');
  if (!host) return { close: () => {} };
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-sheet" role="dialog" aria-modal="true" data-modal-sheet>
        ${innerHtml}
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-modal-sheet]')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-modal-overlay]')?.addEventListener('click', close);
  return { close, root: host };
}

function listRecentChatHints(messages, max = 8) {
  const rows = filterNonGuidanceMessages(messages)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .filter((m) => m && m.content && m.type === 'text')
    .slice(0, max)
    .map((m) => `- ${String(m.content).replace(/\s+/g, ' ').slice(0, 42)}`);
  return rows.join('\n');
}

/**
 * 关注/编辑资料这类操作只是想局部更新一下状态，却要靠整页重渲染来实现，
 * container.innerHTML 重建会把 .page-scroll 的位置清零，长主页列表点一下就弹回顶部。
 */
async function rerenderKeepScroll(container, params) {
  const scroller = container.querySelector('.page-scroll');
  const top = scroller ? scroller.scrollTop : 0;
  await render(container, params);
  const nextScroller = container.querySelector('.page-scroll');
  if (nextScroller) nextScroller.scrollTop = top;
}

export default async function render(container, params) {
  const currentUserId = (await db.get('settings', 'currentUserId'))?.value || '';
  const ownerUserId = currentUserId || 'guest';
  const weiboMetaKey = `weiboMeta_${ownerUserId}`;
  const authorId = params?.authorId || '';
  const authorName = params?.authorName || '用户';
  const season = '生活';
  const allPosts = await listActiveWeiboPosts({ ownerUserId });
  const posts = allPosts
    .filter((p) => (authorId && p.authorId === authorId) || (!authorId && p.authorName === authorName) || (authorName && p.authorName === authorName))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const loadedMeta = await loadWeiboMetaCompat(currentUserId);
  const meta = Object.keys(loadedMeta).length ? loadedMeta : { profiles: {}, followingIds: [] };
  const profileKey = authorId || authorName;
  const profile = meta.profiles?.[profileKey] || {};
  const viewerUser = currentUserId ? await db.get('users', currentUserId) : null;
  const isSelf = !!(authorId && currentUserId && authorId === currentUserId);
  const displayAuthorName = resolveSocialAuthorLabel(
    isSelf && viewerUser ? getWeiboDisplayName(viewerUser) : authorName,
    { fallback: '匿名用户' },
  );
  const fansRaw = isSelf && viewerUser?.weiboFans != null && Number.isFinite(Number(viewerUser.weiboFans))
    ? Number(viewerUser.weiboFans)
    : (profile.fans != null && profile.fans !== '' ? Number(profile.fans) : 0);
  const fansDisplay = Number.isFinite(fansRaw) ? fansRaw : 0;
  const bioWeibo = isSelf
    ? (String(viewerUser?.weiboBio || '').trim() || String(viewerUser?.bio || '').trim() || profile.bio || '')
    : (profile.bio || '');
  const bioDisplay = bioWeibo || '这个人还没写微博简介';
  const selfWeiboId = isSelf ? String(viewerUser?.weiboId || '').trim() : '';
  const avatarUrl = await resolveAvatarUrl(authorId, displayAuthorName, null, 'weibo');
  const avatarHtml = `<img src="${e(avatarUrl || resolveDefaultAvatar('weibo'))}" class="weibo-avatar-img" alt="" />`;
  const followed = new Set(meta.followingIds || []).has(profileKey);
  const followingCount = new Set(meta.followingIds || []).size;
  const stickerPool = await getAllStickersFlat();

  container.classList.add('weibo-page', 'weibo-profile-page');
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn wbp-back" aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">微博主页</h1>
      <button type="button" class="navbar-btn wbp-gen" aria-label="生成微博">${icon('zap')}</button>
    </header>
    <div class="page-scroll weibo-profile-scroll" style="${meta.homeBg ? `background-image:url('${e(meta.homeBg)}');background-size:cover;background-attachment:fixed;` : ''}">
      <div class="card-block weibo-profile-hero">
        <div style="display:flex;gap:10px;align-items:center;">
          <div class="weibo-avatar">${avatarHtml}</div>
          <div style="min-width:0;flex:1;">
            <div class="weibo-post-name">${e(displayAuthorName)}<span class="weibo-v-badge">V</span></div>
            <div class="weibo-post-meta" style="display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;">
              ${selfWeiboId ? `<span>ID ${e(selfWeiboId)}</span><span>·</span>` : ''}
              ${isSelf ? `<button type="button" class="wbp-relations-btn" data-relation-tab="following">关注 ${followingCount}</button><span>·</span>` : ''}
              <button type="button" class="wbp-fans-btn" title="${isSelf ? '查看粉丝' : '编辑粉丝数'}">粉丝 ${e(formatSocialCount(fansDisplay))}</button>
              ${isSelf ? '' : `<span>·</span><span>${followed ? '已关注' : '未关注'}</span>`}
            </div>
            <div class="text-hint" style="margin-top:4px;">${e(bioDisplay)}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
            <button type="button" class="btn btn-outline btn-sm wbp-edit-card" title="编辑微博主页展示">编辑</button>
            ${isSelf ? '' : `<button type="button" class="btn btn-outline wbp-follow">${followed ? '取消关注' : '+关注'}</button>`}
            <button type="button" class="btn btn-outline wbp-dm" title="粉丝私信">${icon('message', 'weibo-act-svg')}</button>
          </div>
        </div>
      </div>
      ${isSelf ? `<div class="wbp-self-tools" aria-label="微博管理">
        <button type="button" data-wbp-tool="settings">微博设置</button>
        <button type="button" data-wbp-tool="comments">补评论</button>
      </div>` : ''}
      <div class="card-block weibo-profile-feed-head">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>TA 的微博</strong>
          <span class="text-hint">${posts.length} 条</span>
        </div>
      </div>
      <div class="wbp-list">
        ${posts.map((p) => `
          ${(() => {
            const pd = buildSocialPostDisplayParts(cleanSocialDisplayText(p.content), p.images, stickerPool);
            const repostMeta = p?.metadata?.repostFrom;
            const simP = simulatePostMetrics(p);
            const visLab = weiboVisibilityLabel(p.metadata);
            const visHtml = visLab ? `<div class="weibo-post-vis"><span class="weibo-vis-badge">${e(visLab)}</span></div>` : '';
            const repostBlock = repostMeta
              ? `<div class="weibo-repost-origin" style="margin-top:8px;padding:8px 10px;border-radius:10px;background:#f7fbff;border:1px solid #d8e8fa;">
                  <div style="font-size:12px;color:#6f8cab;">转发 @${e(resolveSocialAuthorLabel(repostMeta.authorName || repostMeta.authorId, { fallback: '某人' }))}</div>
                  <div style="margin-top:4px;line-height:1.5;">${e(cleanSocialDisplayText(repostMeta.content || '（原文不可见）').slice(0, 120))}</div>
                </div>`
              : '';
            return `
          <article class="weibo-post card-block" data-post-id="${e(p.id)}">
            <div class="weibo-post-meta">${e(t(p.timestamp))}</div>
            ${visHtml}
            <div class="weibo-post-content social-richtext" style="margin-top:6px;">${pd.richTextHtml}</div>
            ${weiboTranslationSuffixHtml(p.content || '', p.metadata?.contentTranslation || p.contentTranslation || '')}
            ${renderSocialPostMediaBlock(p, pd.mergedImages, 'weibo', { stickerUrls: pd.stickerImageUrls })}
            ${repostBlock}
            <div class="weibo-post-meta" style="margin-top:8px;">转发 ${formatSocialCount(simP.reposts)} · 评论 ${formatSocialCount(simP.comments)} · 点赞 ${formatSocialCount(simP.likes)}</div>
          </article>
        `;
          })()}
        `).join('') || '<div class="placeholder-page" style="height:auto;padding:20px 0;"><div class="placeholder-text">这个主页还没微博</div></div>'}
      </div>
    </div>
  `;
  bindWeiboRichTextLinks(container);

  const openWeiboCardEditor = () => {
    const fansPrefill = isSelf
      ? (viewerUser?.weiboFans != null ? String(viewerUser.weiboFans) : '')
      : String(Math.round(fansDisplay));
    const bioPrefill = isSelf
      ? (String(viewerUser?.weiboBio || '').trim() || String(profile.bio || ''))
      : String(profile.bio || '');
    const nicknamePrefill = isSelf
      ? String(viewerUser?.weiboNickname || '').trim()
      : '';
    const weiboIdPrefill = isSelf ? String(viewerUser?.weiboId || '').trim() : '';
    let pendingAvatar = isSelf ? resolveWeiboUserAvatar(viewerUser) : '';
    let clearAvatar = false;
    let avatarTouched = false;

    const avatarPreview = pendingAvatar
      ? `<img src="${e(pendingAvatar)}" alt="" class="weibo-avatar-img" style="width:56px;height:56px;border-radius:50%;object-fit:cover;" />`
      : `<img src="${e(resolveDefaultAvatar('weibo'))}" alt="" class="weibo-avatar-img" style="width:56px;height:56px;border-radius:50%;object-fit:cover;" />`;
    const personalNameHint = isSelf ? getWeiboDisplayName(viewerUser) : '';

    const { close, root } = openGlobalModal(`
      <div class="modal-header"><h3>编辑微博主页</h3><button type="button" class="navbar-btn modal-close-btn">✕</button></div>
      <div class="modal-body wb-config-body">
        ${isSelf ? `
          <div style="display:flex;gap:12px;align-items:center;">
            <button type="button" class="wbp-edit-avatar-preview" aria-label="更换头像" style="border:0;background:transparent;padding:0;cursor:pointer;">${avatarPreview}</button>
            <div style="display:flex;flex-direction:column;gap:6px;">
              <button type="button" class="btn btn-sm btn-outline wbp-edit-avatar-pick">更换头像</button>
              <button type="button" class="btn btn-sm btn-outline wbp-edit-avatar-clear">清除头像</button>
            </div>
            <input type="file" class="wbp-edit-avatar-file" accept="image/*" hidden />
          </div>
          <label class="form-label" style="margin-top:10px;">微博显示名</label>
          <input class="form-input wbp-edit-weibo-nickname" value="${e(nicknamePrefill)}" maxlength="40" placeholder="留空则用个人昵称（${e(personalNameHint)}）" />
          <label class="form-label" style="margin-top:10px;">微博 ID</label>
          <input class="form-input wbp-edit-weibo-id" value="${e(weiboIdPrefill)}" maxlength="60" placeholder="UID（可选，用于识别本人链接）" />
        ` : ''}
        <label class="form-label" style="margin-top:10px;">粉丝数</label>
        <input type="number" class="form-input wbp-edit-fans" min="0" step="1" value="${e(fansPrefill)}" placeholder="${isSelf ? '留空则不固定' : ''}" />
        <label class="form-label" style="margin-top:10px;">微博简介</label>
        <textarea class="form-input wbp-edit-bio" rows="3" placeholder="简介">${e(bioPrefill)}</textarea>
      </div>
      <div class="wb-config-footer">
        <button type="button" class="btn btn-primary wbp-edit-save" style="width:100%;">保存</button>
      </div>
    `);
    root.querySelector('[data-modal-sheet]')?.classList.add('wb-config-sheet');
    root.querySelector('.modal-close-btn')?.addEventListener('click', close);

    if (isSelf) {
      const paintAvatar = () => {
        const host = root.querySelector('.wbp-edit-avatar-preview');
        if (!host) return;
        host.innerHTML = pendingAvatar
          ? `<img src="${e(pendingAvatar)}" alt="" class="weibo-avatar-img" style="width:56px;height:56px;border-radius:50%;object-fit:cover;" />`
          : `<img src="${e(resolveDefaultAvatar('weibo'))}" alt="" class="weibo-avatar-img" style="width:56px;height:56px;border-radius:50%;object-fit:cover;" />`;
      };
      const avatarFile = root.querySelector('.wbp-edit-avatar-file');
      const pickAvatar = () => avatarFile?.click();
      root.querySelector('.wbp-edit-avatar-preview')?.addEventListener('click', pickAvatar);
      root.querySelector('.wbp-edit-avatar-pick')?.addEventListener('click', pickAvatar);
      root.querySelector('.wbp-edit-avatar-clear')?.addEventListener('click', () => {
        pendingAvatar = '';
        clearAvatar = true;
        avatarTouched = true;
        if (avatarFile) avatarFile.value = '';
        paintAvatar();
      });
      avatarFile?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        try {
          const result = await fileToCroppedOptimizedAvatarDataUrl(file);
          if (!result?.dataUrl) return;
          pendingAvatar = result.dataUrl;
          clearAvatar = false;
          avatarTouched = true;
          paintAvatar();
        } catch (err) {
          showToast(String(err?.message || err || '头像处理失败'));
        } finally {
          ev.target.value = '';
        }
      });
    }

    root.querySelector('.wbp-edit-save')?.addEventListener('click', async () => {
      const fansStr = String(root.querySelector('.wbp-edit-fans')?.value || '').trim();
      const bioStr = String(root.querySelector('.wbp-edit-bio')?.value || '').trim();
      meta.profiles = meta.profiles || {};
      const nextProf = { ...(meta.profiles[profileKey] || {}) };

      if (isSelf && currentUserId) {
        const u = await db.get('users', currentUserId);
        if (u) {
          const weiboNickname = String(root.querySelector('.wbp-edit-weibo-nickname')?.value || '').trim();
          const weiboId = String(root.querySelector('.wbp-edit-weibo-id')?.value || '').trim();
          // 微博显示名 / 微博 ID 只写各自字段，不改个人昵称 nickname
          u.weiboNickname = weiboNickname;
          u.weiboId = weiboId;
          if (fansStr === '') {
            u.weiboFans = null;
            if (nextProf.fans == null || nextProf.fans === '') {
              nextProf.fans = profile.fans != null ? profile.fans : fansDisplay;
            }
          } else {
            const n = Math.max(0, Number(fansStr) || 0);
            u.weiboFans = n;
            nextProf.fans = n;
          }
          u.weiboBio = bioStr;
          if (avatarTouched) {
            u.weiboAvatarConfigured = true;
            u.weiboAvatar = clearAvatar ? '' : pendingAvatar;
          }
          const saved = await saveUserRecord(u);
          nextProf.bio = bioStr || nextProf.bio;
          if (saved.weiboFans != null) nextProf.fans = saved.weiboFans;
          // 同步导航参数里的展示名，避免保存后标题仍是旧名
          if (params && typeof params === 'object') {
            params.authorName = getWeiboDisplayName(saved);
          }
        }
      } else {
        const n = Math.max(0, Number(fansStr) || Number(profile.fans) || 0);
        nextProf.fans = n;
        nextProf.bio = bioStr;
      }

      meta.profiles[profileKey] = nextProf;
      await db.put('settings', { key: weiboMetaKey, value: meta });
      showToast('已保存');
      close();
      await rerenderKeepScroll(container, params);
    });
  };

  container.querySelector('.wbp-back')?.addEventListener('click', () => back());
  container.querySelector('[data-wbp-tool="settings"]')?.addEventListener('click', () => navigate('weibo', { panel: 'settings' }));
  container.querySelector('[data-wbp-tool="comments"]')?.addEventListener('click', () => navigate('weibo', { panel: 'comments' }));
  container.querySelector('.wbp-fans-btn')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (isSelf) navigate('weibo-relations', { tab: 'followers' });
    else openWeiboCardEditor();
  });
  container.querySelector('.wbp-relations-btn')?.addEventListener('click', () => navigate('weibo-relations', { tab: 'following' }));
  container.querySelector('.wbp-edit-card')?.addEventListener('click', () => openWeiboCardEditor());
  container.querySelector('.wbp-follow')?.addEventListener('click', async () => {
    const set = new Set(meta.followingIds || []);
    if (set.has(profileKey)) set.delete(profileKey);
    else set.add(profileKey);
    meta.followingIds = [...set];
    await db.put('settings', { key: weiboMetaKey, value: meta });
    await rerenderKeepScroll(container, params);
  });
  container.querySelector('.wbp-dm')?.addEventListener('click', () => {
    navigate('weibo-dm', {
      profileKey,
      profileName: authorName,
      ownerUserId,
      authorId,
      isSelf,
    });
  });
  container.querySelector('.wbp-gen')?.addEventListener('click', async () => {
    const stickerOpts = await openAllowStickersModal({ title: '主页生成选项' });
    if (!stickerOpts) return;
    let allowStickers = stickerOpts.allowStickers !== false;
    const btn = container.querySelector('.wbp-gen');
    setButtonLoading(btn, true, { label: '生成中…', preserveIcon: true });
    try {
    const chats = currentUserId ? await db.getAllByIndex('chats', 'userId', currentUserId) : [];
    const recentMsgs = [];
    for (const c of chats.slice(0, 8)) {
      const msg = filterNonGuidanceMessages(await db.getAllByIndex('messages', 'chatId', c.id));
      recentMsgs.push(...msg.slice(-12));
    }
    const recentHints = listRecentChatHints(recentMsgs, 10);
    const char = authorId ? await getCharacter(authorId) : null;
    allowStickers = allowStickers && characterAllowsWeiboStickers(char);
    const stickerHint = await buildSocialGenerationExtraPrompt(null, {
      stickersOnly: true,
      allowStickers,
    });
    const charCardBlock = char ? buildSocialCharacterCardsBlock([char], { mode: 'full' }) : '';
    const charHints = [char?.personality, char?.speechStyle, char?.bio].filter(Boolean).join('；');
    const roleplayCtx = await collectRoleplayContextForSocialGeneration(currentUserId || '', season, {
      focusCharacterIds: authorId ? [authorId] : [],
    });
    const bgConfig = normalizeWeiboBackgroundConfig(meta);
    const focusSnippets =
      roleplayCtx.snippets?.length
        ? `【与 TA 相关会话台词摘录（优先含该角色的私聊/群）】\n${roleplayCtx.snippets.slice(0, 20).join('\n')}`
        : '';
    const referenceNotes = [
      roleplayCtx.relationLines.length ? `【角色关系摘要】\n${roleplayCtx.relationLines.join('\n')}` : '',
      `【本页生成对象】${authorName}（${authorId || 'unknown'}）`,
      charCardBlock ? '' : `【角色设定线索】${charHints || '按角色人设自然发挥'}`,
      focusSnippets,
      `【最近聊天摘要】\n${recentHints || '- 暂无聊天内容'}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const systemPrompt = await buildWeiboAiSystemPrompt(viewerUser, season, {
      worldBookIds: bgConfig.worldBookIds,
      backgroundMode: bgConfig.backgroundMode,
      referenceNotes,
      characters: char ? [char] : [],
      characterCardMode: 'full',
      allowStickers,
    });
    const systemContent = `${systemPrompt}\n\n---\n[当前任务] 微博主页批量动态与私信 JSON。${stickerHint}\n只输出合法 JSON，不要解释。`;
    const repostTrustedAuthors = await listSocialVisibleCharacters(viewerUser, {
      excludeAnonNpc: true,
      userId: viewerUser?.id,
    }).catch(() => (char ? [char] : []));
    const recentPostDigest = allPosts.slice(0, 16).map((post) => (
      `- [postId=${post.id}] [authorId=${post.authorId || ''}] [visibility=${post.metadata?.visibility || 'public'}] ${post.authorName || '某人'}：${String(post.content || '').replace(/\s+/g, ' ').slice(0, 80)}`
    )).join('\n') || '暂无历史微博';
    const prompt = [
      `你要扮演微博运营文案，生成角色微博时间线。`,
      `时间线: ${season}`,
      `角色: ${authorName} (${authorId || 'unknown'})`,
      charCardBlock ? '角色设定见上方系统提示词中的完整角色卡，必须严格贴合，不要另外套模板。' : `角色设定线索: ${charHints || '按角色人设自然发挥'}`,
      `最近聊天摘要:\n${recentHints || '- 暂无聊天内容'}`,
      '每条 posts 必须包含：content；public/fans_only 的 reposts、comments、likes 为正整数且 hotComments 恰好 3 条；private 的三项互动必须全为 0 且 hotComments=[]。不得代替当前用户发言；通讯录角色写真实 id，普通路人写 npc。',
      `近期已有微博（真实转发来源只能从这里选择）：\n${recentPostDigest}`,
      '可选转发链：content 写转发者正文；repostFromContent 写原帖正文。若来源指向通讯录角色，必须选用上方该角色真实存在且非 private 的 repostFromPostId；没有可用原帖就把所有 repostFrom* 字段留空，绝不能编造角色发过的微博。路人、媒体或站外来源不受此 postId 约束。',
      'visibility：多数为 public；可掺 0～2 条 fans_only（粉丝可见）或 private（仅自己可见），剧情上要合理。',
      '题材可混排：生活日常、抽奖/转发抽奖、品牌官博、活动动态、八卦、同人吐槽等。',
      buildJsonFieldTranslationPromptBlock(
        collectTranslationActors(char ? [char] : []),
        { fields: 'content / hotComments[].content', exampleField: 'content' },
      ),
      buildWeiboDmRelationshipBoundary(),
      '输出 JSON 形态：',
      '{"posts":[{"content":"…","zh":"外语才需要","reposts":120,"comments":88,"likes":640,"visibility":"public|fans_only|private","repostFromAuthorId":"","repostFromAuthorName":"","repostFromPostId":"","repostComment":"","hotComments":[{"authorId":"角色真实id或npc","author":"A","content":"…","zh":"外语才需要","likes":99},{"authorId":"npc","author":"B","content":"…","likes":12},{"authorId":"npc","author":"C","content":"…","likes":5}]}],"dms":[{"senderName":"昵称","senderType":"粉丝|黑子|梦女|梦男|同行|营销号|广告商","content":"私信内容","zh":"外语才需要"}]}',
      '要求: 3-6 条 posts，语气贴人设；可有 @；带时间线感与生活感；不要解释文字。',
      '若有【与 TA 相关会话台词摘录】，话题与口吻应与之衔接，避免与当前私聊/群剧情完全脱节。',
    ].filter(Boolean).join('\n');
      const genCap = await resolveGenerationMaxTokens();
      const userMessage = [systemContent, '本次任务', prompt].join('\n\n');
      const raw = await apiChat(
        [{ role: 'user', content: userMessage }],
        { temperature: 0.95, maxTokens: genCap }
      );
      const text = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(text);
      const nowTs = await getVirtualNow(currentUserId || '', 0);
      const createdPosts = [];
      const policyPosts = applyWeiboCharacterStickerPolicy(parsed.posts || [], char ? [char] : []);
      const mentionActors = [
        ...(char ? [char] : []),
        ...policyPosts.map((row) => ({ id: row?.authorId, authorName: row?.authorName })),
      ];
      for (const it of policyPosts) {
        const merged = {
          ...it,
          authorId: it.authorId || authorId || authorName,
          authorName: it.authorName || authorName,
        };
        const normalized = normalizePostFromAi(merged, {
          user: viewerUser,
          trustedCommentAuthorIds: authorId ? [authorId] : [],
          mentionActors,
        });
        const repostFromMeta = resolveGeneratedWeiboRepostMeta({
          authorId: normalized.repostFromAuthorId,
          authorName: normalized.repostFromAuthorName,
          postId: normalized.repostFromPostId,
          content: normalized.repostFromContent || normalized.repostComment,
        }, {
          existingPosts: [...allPosts, ...createdPosts],
          trustedAuthors: repostTrustedAuthors,
        });
        if ((normalized.repostFromAuthorId || normalized.repostFromAuthorName) && !repostFromMeta) continue;
        const post = {
          id: `weibo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          ownerUserId,
          authorId: authorId || authorName,
          authorName,
          avatar: null,
          content: normalized.content || '',
          tags: normalized.tags || [],
          images: [],
          timestamp: nowTs - Math.floor(Math.random() * 3600_000),
          reposts: normalized.reposts,
          comments: normalized.comments,
          likes: normalized.likes,
          fans: Number(profile.fans || 0),
          commentList: normalized.hotComments.map((c) => ({
            authorId: c.authorId || '',
            author: resolveSocialAuthorLabel(c.author, { fallback: '热评用户' }),
            content: c.content,
            likes: c.likes,
            ...(c.translation ? { translation: c.translation } : {}),
            timestamp: nowTs - Math.floor(Math.random() * 400000),
          })),
          repostList: [],
          metadata: {
            generatedByAi: true,
            ...(repostFromMeta ? { repostFrom: repostFromMeta } : {}),
            visibility: normalized.visibility,
            ...(normalized.contentTranslation ? { contentTranslation: normalized.contentTranslation } : {}),
          },
        };
        await db.put('weiboPosts', post);
        createdPosts.push(post);
      }
      if (createdPosts.length) {
        appendWeiboGlobalContextBatch(meta, { trending: [], news: [], posts: createdPosts });
        await db.put('settings', { key: weiboMetaKey, value: meta });
      }
      for (const dm of (parsed.dms || []).slice(0, 8)) {
        const content = cleanSocialDisplayText(dm?.content).trim();
        const translation = sanitizeAiTranslation(content, dm?.zh || dm?.translation || '');
        await appendWeiboDmIncoming({
          ownerUserId,
          profileKey,
          profileName: authorName,
          authorId,
          isSelf,
          senderName: resolveSocialAuthorLabel(dm?.senderName, { fallback: '路人粉' }),
          senderType: String(dm?.senderType || '粉丝'),
          content,
          timestamp: nowTs - Math.floor(Math.random() * 1_200_000),
          translation,
        });
      }
      await rerenderKeepScroll(container, params);
      showToast('已生成动态与私信');
    } catch (err) {
      showToast(err?.message || '生成失败');
    } finally {
      setButtonLoading(btn, false);
    }
  });
  container.querySelectorAll('.wbp-list .weibo-post').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.weibo-img-cell, button, [data-translation-toggle]')) return;
      navigate('weibo-detail', { postId: el.dataset.postId });
    });
  });
  bindWeiboImageLightbox(container);
  bindNarrationTranslationToggle(container, {
    onFailed: () => showToast('翻译暂时不可用，请稍后再试'),
  });
}
