import { characterAvatarHtml, escAttr } from '../../components/scrapbook-illustrations.js';
import { formatReplyRefDisplayLine, normalizeMessageForUi, buildMessageUiUserLabelOptions } from '../chat-helpers.js';
import { getUserDisplayName } from '../../models/user.js';
import { applyDisplayRegex } from '../display-regex.js';
import { sanitizeHtmlExtensionTemplate } from '../html-extensions.js';
import {
  stripLeakedCharacterCodes,
  looksLikeRawParticipantId,
  participantIdentityLookupIds,
} from './character-code-fallback.js';
import { buildChatActorReferenceTable } from './actor-reference.js';
import { stripLeakedVoiceCallContextPrefix } from './voice-call-guard.js';
import { stripLeakedVoicePerformanceTags } from '../voice-tools.js';
import {
  buildVoiceBubbleInnerHtml,
  voiceCallCardHtml,
  redPacketBubbleHtml,
  transferCardBubbleHtml,
  transferReceiptCardHtml,
  orderShareCardHtml,
  textImageBubbleHtml,
  chatBundleBubbleHtml,
  voteCardBubbleHtml,
  buildStoryCardHtml,
  linkCardBubbleHtml,
  locationCardBubbleHtml,
  diceCardBubbleHtml,
  offlineInviteCardHtml,
  npcCardBubbleHtml,
  groupInviteUserCardHtml,
  radioEpisodeCardHtml,
} from './card-render.js';
import {
  isSystemTimelineMessage,
  isStatusTimelineHint,
  isHiddenFromChatUi,
  shouldInsertTimeDivider,
  renderTimeDividerHtml,
  renderSystemHintRowHtml,
  formatMsgTime,
  formatChatClockTime,
} from './message-timeline.js';
import { resolveStickerBubbleImageUrl } from './sticker-resolve.js';
import { upgradeStickerImageUrl } from '../sticker-store.js';
import { upgradeMixedContentMediaUrl } from '../media-url.js';
import {
  canRerollGeneratedImage,
  isGenImageStuck,
} from './marshmallow-gen-image.js';
import {
  isGenericPeerActorLabel,
  sanitizeLeakedMarshmallowMessageBody,
  stripEphemeralNpcLabel,
} from '../marshmallow-protocol.js';
import {
  messageLikelyNeedsTranslationForProfile,
  sanitizeAiTranslation,
} from '../translation-utils.js';
import { icon } from '../../components/svg-icons.js';
import { renderChatMentionText } from './mentions.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function identityDisplayNameKey(value = '') {
  return String(value || '').trim().toLocaleLowerCase().replace(/[\s_\-./·•]+/g, '');
}

function isLegacyTruncatedPhoneContactId(value = '') {
  const id = String(value || '').trim();
  return id.length === 60 && /^phone-contact:/i.test(id);
}

function resolveIdentityCharacterBySenderName(characters = {}, senderName = '') {
  const nameKey = identityDisplayNameKey(senderName);
  if (!nameKey) return null;
  const candidates = new Map();
  for (const [lookupId, row] of Object.entries(characters || {})) {
    if (!row) continue;
    const names = [
      row.realName,
      row.name,
      row.customNickname,
      row.nickname,
      ...(Array.isArray(row.aliases) ? row.aliases : []),
    ];
    if (!names.some((name) => identityDisplayNameKey(name) === nameKey)) continue;
    const stableId = String(
      row.linkedCharacterId
      || row.linkedActorId
      || row.metadata?.linkedCharacterId
      || row.id
      || lookupId,
    ).trim() || lookupId;
    if (!candidates.has(stableId)) candidates.set(stableId, row);
  }
  const canonical = [...candidates.entries()]
    .filter(([id]) => !/^phone-contact:/i.test(id));
  if (canonical.length === 1) return canonical[0][1];
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

function resolveIdentityCharacter(characters = {}, actorId = '', senderName = '') {
  // 旧版曾把长 phone-contact id 截到 60 字，截断点可能只是整本通讯录的
  // 公共前缀。消息自己的历史署名能唯一指向成员时，先用姓名找头像，避免所有
  // 气泡都误吃 characters[截断 id] 上的第一张头像。
  if (isLegacyTruncatedPhoneContactId(actorId)) {
    const named = resolveIdentityCharacterBySenderName(characters, senderName);
    if (named) return named;
  }
  const rows = participantIdentityLookupIds(actorId)
    .map((lookupId) => characters?.[lookupId])
    .filter(Boolean);
  return rows.find((row) => {
    const label = String(row?.realName || row?.name || row?.customNickname || '').trim();
    return label && !looksLikeRawParticipantId(label);
  }) || rows[0] || null;
}

function resolveIdentityMapValue(rows = {}, actorId = '') {
  for (const lookupId of participantIdentityLookupIds(actorId)) {
    const value = rows?.[lookupId];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function resolveRoleBubbleBg(displaySenderId, options = {}) {
  const session = String(options.sessionBubbleOther || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(session)) return session;
  // 私聊只使用本会话取色；群聊仍可用成员档案色区分多人身份。
  if (!options.isGroup) return '';
  const charMap = options.characters || {};
  return String(resolveIdentityCharacter(charMap, displaySenderId)?.bubbleColor || '').trim();
}

function roleBubbleRowStyleAttr(displaySenderId, options = {}) {
  const color = resolveRoleBubbleBg(displaySenderId, options);
  return /^#[0-9a-f]{6}$/i.test(color)
    ? ` style="--chat-character-role-bubble-bg:${escAttr(color)}"`
    : '';
}

function normalizeMessageForRender(message = {}, options = {}) {
  return normalizeMessageForUi(message, buildMessageUiUserLabelOptions(options));
}

export function shouldRenderDeliveryRejected(message = {}, options = {}) {
  const metadata = message?.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {};
  const rejected = metadata.deliveryBlockedByUser === true
    || String(metadata.deliveryStatus || '').trim() === 'rejected';
  if (!rejected) return false;

  // 拦截箱、马甲拒收和「对方拉黑用户」都有明确的业务来源。
  // 普通会话的旧数据可能因泛化 isBlocked 字段被误写拒收；没有
  // 真实拉黑状态或新版确认标记时，不再显示红色感叹号。
  const reason = String(metadata.deliveryRejectedReason || '').trim();
  const phoneIntercept = String(options.chat?.metadata?.phoneChannel || '').trim() === 'intercept';
  const explicitAliasRejection = reason === 'blocked-character-alias-by-user'
    || reason === 'blocked-by-character-alias'
    || metadata.deliveryBlockedByCharacter === true;
  const currentUserId = String(options.user?.id || options.userId || '').trim();
  const rejectedUserId = String(metadata.deliveryRejectedUserId || '').trim();
  const confirmedForCurrentSlot = metadata.deliveryRejectedConfirmed === true
    && !!currentUserId
    && rejectedUserId === currentUserId;
  return phoneIntercept
    || explicitAliasRejection
    || confirmedForCurrentSlot
    || options.chatBlockedByUser === true;
}

function isAvatarImage(value = '') {
  return /^(?:data:image\/|https?:\/\/|\.{0,2}\/|\/)/i.test(String(value || '').trim());
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatWeChatTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayOffset = Math.round((startToday - startTarget) / 86400000);
  const clock = formatChatClockTime(ts);
  if (dayOffset === 0) return clock;
  if (dayOffset === 1) return `昨天 ${clock}`;
  const dateLabel = date.getFullYear() === now.getFullYear()
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  return `${dateLabel} ${clock}`;
}

function renderThreadTimeDividerHtml(ts, options = {}) {
  if (options.chatPlatform === 'wechat') {
    return `<div class="date-divider chat-time-divider chat-time-divider--wechat">${esc(formatWeChatTime(ts))}</div>`;
  }
  return renderTimeDividerHtml(ts);
}

function shouldSuppressMessageTime(message = {}, options = {}) {
  if (options.messageTimestampMode === 'each') return false;
  const id = String(message?.id || '').trim();
  return !!(id && options.suppressTimeIds?.has?.(id));
}

function offlineJoinIntentHtml(normalized = {}) {
  const md = normalized.metadata || {};
  const intent = String(md.offlineJoinIntent || '');
  if (!['ask_join', 'coming'].includes(intent)) return '';
  const decision = String(md.offlineJoinDecision || 'pending');
  const name = String(md.offlineJoinCharacterName || normalized.senderName || 'TA').trim() || 'TA';
  if (decision === 'accepted') {
    return `<div class="chat-offline-join-card is-resolved"><span>${esc(name)}已加入现场</span></div>`;
  }
  if (decision === 'rejected') {
    return `<div class="chat-offline-join-card is-resolved"><span>这次没有叫${esc(name)}过来</span></div>`;
  }
  const hint = decision === 'later' ? '稍后处理' : (intent === 'coming' ? 'TA 想过来' : 'TA 想加入');
  return `<div class="chat-offline-join-card" data-offline-join-job="${esc(md.offlinePhoneCinematicJobId || '')}">
    <span>${esc(hint)}</span>
    <div class="chat-offline-join-actions">
      <button type="button" data-offline-join-action="accept">同意</button>
      <button type="button" data-offline-join-action="reject">拒绝</button>
      <button type="button" data-offline-join-action="later">稍后</button>
    </div>
  </div>`;
}

function formatAnonGroupDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

function formatAnonGroupClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatAnonGroupTimeHtml(ts) {
  const date = formatAnonGroupDate(ts);
  const clock = formatAnonGroupClock(ts);
  if (!date && !clock) return '';
  return `<span class="chat-msg-group-time"><span class="chat-bubble-date">${esc(date)}</span><span class="chat-bubble-time">${esc(clock)}</span></span>`;
}

function isBareMediaType(type, normalized) {
  if (type === 'sticker') return true;
  if (type !== 'image') return false;
  if (normalized?.metadata?.deferredImage) return true;
  if (normalized?.metadata?.generatingImage) return true;
  if (normalized?.metadata?.generationFailed) return true;
  return !!(
    String(normalized?.content || '').trim()
    || String(normalized?.metadata?.url || '').trim()
    || (normalized?.metadata?.generatedImage && normalized?.metadata?.prompt)
  );
}

function isStandaloneCardType(type, options = {}) {
  if (type === 'voice' && (options.insCard || options.anonymous)) return false;
  return [
    'voice',
    'voiceCall',
    'redpacket',
    'transfer',
    'transferReceipt',
    'orderShare',
    'textimg',
    'chatBundle',
    'mergeForward',
    'location',
    'link',
    'dice',
    'vote',
    'offlineInvite',
    'npcCard',
    'groupInviteUser',
    'htmlWidget',
  ].includes(type);
}

function genImagePlaceholderHtml(msg) {
  const stuck = isGenImageStuck(msg);
  const persisting = msg.metadata?.generationStage === 'persisting';
  const caption = String(msg.metadata?.caption || msg.metadata?.text || '').trim();
  const status = persisting
    ? '图片已生成，正在保存到本机…'
    : (stuck ? '上次生成已中断' : '正在生成图片…');
  const hint = canRerollGeneratedImage(msg)
    ? (persisting ? '请稍候，不要重复生成' : '点开查看状态')
    : '请稍候';
  return `<div class="chat-sticker-slot chat-user-image-wrap" data-chat-image="1"><div class="chat-sticker"><div class="chat-gen-image-placeholder${stuck ? ' is-stuck' : ' is-loading'}">${caption ? `<div class="chat-gen-image-caption">${esc(caption)}</div>` : ''}<div class="chat-gen-image-status">${status}</div><div class="chat-gen-image-hint">${hint}</div></div></div></div>`;
}

function imageBubbleHtml(normalized) {
  const msg = normalized;
  if (msg.type !== 'image') return '';
  if (msg.metadata?.deferredImage) {
    // 占位框故意留高一点：真实图片换上来时和占位差太多会把已经钉底的聊天区顶上去一截。
    return `<div class="chat-sticker-slot chat-user-image-wrap" data-chat-image="1"><div class="chat-sticker"><div class="chat-gen-image-placeholder is-deferred"><div class="chat-gen-image-status">图片</div><div class="chat-gen-image-hint">点开查看</div></div></div></div>`;
  }
  if (msg.metadata?.generatingImage) {
    return genImagePlaceholderHtml(msg);
  }
  if (msg.metadata?.generationFailed) {
    const err = String(msg.metadata?.generationError || '').trim();
    const errLine = err ? `<div class="chat-gen-image-hint">${esc(err.slice(0, 80))}</div>` : '';
    const resultUnknown = msg.metadata?.generationResultUnknown === true
      || msg.metadata?.generationRetryUnsafe === true
      || /等待约\s*\d+\s*秒后失败|请求(?:很)?可能已经到达服务端|结果未知|可能仍在服务端处理/i.test(err);
    const status = resultUnknown ? '生图结果未知' : '图片生成失败';
    const actionHint = resultUnknown ? '点开查看 · 重试前先查生成记录' : '点开重 roll';
    return `<div class="chat-sticker-slot chat-user-image-wrap" data-chat-image="1"><div class="chat-sticker"><div class="chat-gen-image-placeholder is-failed"><div class="chat-gen-image-status">${status}</div>${errLine}<div class="chat-gen-image-hint">${actionHint}</div></div></div></div>`;
  }
  if (msg.metadata?.localImageCleared) {
    return `<div class="chat-sticker-slot chat-user-image-wrap" data-chat-image="1"><div class="chat-sticker"><div class="chat-gen-image-placeholder is-failed"><div class="chat-gen-image-status">图片已清理</div><div class="chat-gen-image-hint">已释放本地图片占用</div></div></div></div>`;
  }
  if (msg.metadata?.generatedImage && msg.metadata?.prompt && !msg.content) {
    return `<div class="chat-sticker-slot chat-user-image-wrap" data-chat-image="1"><div class="chat-sticker"><div class="chat-gen-image-placeholder is-failed"><div class="chat-gen-image-status">图片未保存</div><div class="chat-gen-image-hint">点开重 roll</div></div></div></div>`;
  }
  const src = upgradeMixedContentMediaUrl(String(msg.content || msg.metadata?.url || '').trim());
  if (src && (/^data:image\//i.test(src) || /^https:\/\//i.test(src))) {
    // data-gen-image-id：加载失败时把卡片稳定换成失败占位，避免破图半透明反复闪
    const genAttr = msg.metadata?.generatedImage && msg.id
      ? ` data-generated-image-id="${escAttr(msg.id)}"`
      : '';
    const localizeAttr = msg.metadata?.generatedImage && /^https:\/\//i.test(src)
      ? ` onload="this.closest('[data-generated-image-id]')?.dispatchEvent(new CustomEvent('marshmallow-gen-image-loaded',{bubbles:true}))"`
      : '';
    return `<div class="chat-sticker-slot chat-user-image-wrap" data-chat-image="1"${genAttr}><div class="chat-sticker"><img src="${escAttr(src)}" alt="图片" loading="lazy" decoding="async"${localizeAttr} onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.style.display='flex');this.closest('[data-generated-image-id]')?.dispatchEvent(new CustomEvent('marshmallow-gen-image-broken',{bubbles:true}))" /><span class="chat-image-broken-hint">图片已失效 · 点开重 roll</span></div></div>`;
  }
  return `<span class="chat-bubble-tag">[图片]</span>`;
}

function stickerImageHtml(imgUrl, name, esc, escAttr) {
  const label = String(name || '表情包').trim() || '表情包';
  return `<span class="chat-sticker-slot"><span class="chat-sticker">`
    + `<img src="${escAttr(imgUrl)}" alt="${esc(label)}" decoding="async" referrerpolicy="no-referrer" `
    + `onerror="this.style.display='none';var h=this.nextElementSibling;if(h){h.hidden=false;this.closest('.chat-sticker')?.classList.add('is-broken')}" />`
    + `<span class="chat-sticker-broken-hint" hidden>`
    + `<span class="chat-sticker-broken-name">${esc(label)}</span>`
    + `<span class="chat-sticker-broken-tip">未加载 · 外链图床可能需翻墙，建议上传或换图床</span>`
    + `</span></span></span>`;
}

function stickerBubbleHtml(normalized, options = {}) {
  const content = String(normalized.content || '').trim();
  const name = String(normalized.metadata?.stickerName || normalized.metadata?.sticker || content || '表情包').trim();
  const pool = typeof options.stickerPoolForMessage === 'function'
    ? options.stickerPoolForMessage(normalized)
    : (options.stickerPool || null);
  const metaUrl = String(normalized.metadata?.url || '').trim();
  const rawImgUrl = resolveStickerBubbleImageUrl(normalized, pool)
    || (/^(https?:\/\/|data:image\/)/i.test(metaUrl) ? metaUrl : '')
    || (/^(https?:\/\/|data:image\/)/i.test(content) ? content : '');
  const imgUrl = upgradeStickerImageUrl(rawImgUrl);
  // 已有可展示 URL 时首屏直接出图，不要一律画成「[表情]」再等 hydration——
  // APK 上 requestIdleCallback / 输入框焦点会拖住升级，表现为表情包一直不显示。
  if (imgUrl) {
    return stickerImageHtml(imgUrl, name, esc, escAttr);
  }
  // 大型本地上传表情会由 chat-store 暂时剥掉 data URL，并标记 deferredSticker。
  // 必须先画出懒加载器可识别的占位节点；若先走通用 deferStickers 文本分支，
  // 页面只会留下「[表情] 名称」，IntersectionObserver 永远找不到节点恢复原图。
  if (normalized.metadata?.deferredSticker) {
    return `<span class="chat-sticker-slot"><span class="chat-sticker">`
      + `<div class="chat-gen-image-placeholder is-deferred chat-sticker-deferred" `
      + `style="box-sizing:border-box!important;width:108px!important;min-width:108px!important;max-width:108px!important;height:108px!important;min-height:108px!important;max-height:108px!important;padding:8px!important;overflow:hidden">`
      + `<div class="chat-gen-image-status">${esc(name)}</div>`
      + `<div class="chat-gen-image-hint">加载中…</div>`
      + `</div></span></span>`;
  }
  if (options.deferStickers) {
    return `<span class="chat-bubble-tag">[表情] ${esc(name)}</span>`;
  }
  return `<span class="chat-bubble-tag">[表情] ${esc(name)}</span>`;
}

function resolveRowAvatar(senderId, options = {}) {
  const id = String(senderId || '').trim();
  const { user, partner, characters = {}, anonymousProfiles = {}, isGroup, msgId } = options;
  const msgAttrs = msgId
    ? ` data-msg-id="${esc(msgId)}" role="button" tabindex="0" aria-label="查看心声"`
    : '';
  const openTag = (extraClass = '') => `<span class="chat-bubble-avatar${extraClass ? ` ${extraClass}` : ''}"${msgAttrs}>`;
  if (id === 'user') {
    const anon = anonymousProfiles[id];
    if (anon?.avatar && isAvatarImage(anon.avatar)) {
      return `${openTag('is-anon')}<img class="chat-bubble-avatar-img" src="${escAttr(anon.avatar)}" alt=""></span>`;
    }
    if (anon?.anonymousId) {
      const letter = esc(anon.anonymousId.slice(0, 1));
      return `${openTag('is-anon')}<span class="chat-bubble-avatar-letter">${letter}</span></span>`;
    }
    if (options.anonymous) {
      return `${openTag('is-anon')}<span class="chat-bubble-avatar-letter">匿</span></span>`;
    }
    if (user?.avatar) {
      return `${openTag()}<img class="chat-bubble-avatar-img" src="${escAttr(user.avatar)}" alt=""></span>`;
    }
    return `${openTag()}${characterAvatarHtml(user || { name: '我' }, { className: 'chat-bubble-avatar-img' })}</span>`;
  }
  if (id === 'system') return '';
  if (id === 'guidance' || options.message?.metadata?.guidanceMode) {
    return `${openTag('is-guidance')}<span class="chat-bubble-avatar-letter">本</span></span>`;
  }
  const anon = resolveIdentityMapValue(anonymousProfiles, id);
  if (anon?.anonymousId) {
    if (anon.avatar && isAvatarImage(anon.avatar)) {
      return `${openTag('is-anon')}<img class="chat-bubble-avatar-img" src="${escAttr(anon.avatar)}" alt=""></span>`;
    }
    const letter = esc(anon.anonymousId.slice(0, 1));
    return `${openTag('is-anon')}<span class="chat-bubble-avatar-letter">${letter}</span></span>`;
  }
  const char = resolveIdentityCharacter(characters, id, options.message?.senderName)
    || (participantIdentityLookupIds(id).includes(partner?.id) ? partner : null);
  if (char) {
    return `${openTag()}${characterAvatarHtml(char, { className: 'chat-bubble-avatar-img' })}</span>`;
  }
  if (!isGroup && partner) {
    return `${openTag()}${characterAvatarHtml(partner, { className: 'chat-bubble-avatar-img' })}</span>`;
  }
  // 没有对应角色卡时（比如幕后一次性 NPC），letter 优先取显示名而不是内部 id，
  // 避免「npc_室友」这类 id 露出英文字母、看着更像 bug。
  const letterSource = String(options.fallbackLabel || '').trim() || String(id);
  return `${openTag()}<span class="chat-bubble-avatar-letter">${esc(letterSource.slice(0, 1))}</span></span>`;
}

function bubbleBody(normalized, options = {}) {
  const type = normalized.type || 'text';
  const rawContent = normalized.content || '';
  const hasBrokenObjectContent = (rawContent != null && typeof rawContent === 'object')
    || /^\[\s*(?:object\s+object|对象\s*对象)\s*\]$/iu.test(String(rawContent).trim());
  // 兼容已经落库、但缺少 aiGenerated 标记的旧消息与后台/中继消息：
  // 非用户亲自编写的角色普通气泡一律隐藏内部通话前缀和供应商语音标签。
  // 用户正文（包括代角色发送）仍保持原样，避免误删用户有意输入的括号内容。
  const shouldStripLeakedVoiceTags = type === 'text'
    && normalized.senderId !== 'user'
    && normalized.metadata?.userComposedAsCharacter !== true;
  const voiceCleanContent = shouldStripLeakedVoiceTags
    ? stripLeakedVoicePerformanceTags(stripLeakedVoiceCallContextPrefix(rawContent))
    : rawContent;
  // 已经被旧版保底落库的角色气泡也在展示时修复，避免升级后历史记录继续露出
  // `"msg","from","body"` 协议字段。用户亲自输入的 JSON 保持原样。
  const sanitizedContent = type === 'text'
    && normalized.senderId !== 'user'
    && normalized.metadata?.userComposedAsCharacter !== true
    ? sanitizeLeakedMarshmallowMessageBody(voiceCleanContent)
    : voiceCleanContent;
  const content = type === 'text' && hasBrokenObjectContent
    ? '消息内容解析失败'
    : sanitizedContent;
  const placement = normalized.senderId === 'user' && !normalized.metadata?.userComposedAsCharacter ? 1 : 2;
  const regexContext = {
    placement,
    depth: normalized.__regexDepth,
    macros: { user: options.currentUserName || '用户', char: normalized.senderName || '角色' },
  };
  if (type === 'image') return imageBubbleHtml(normalized);
  if (type === 'sticker') return stickerBubbleHtml(normalized, options);
  if (type === 'voice') return buildVoiceBubbleInnerHtml(normalized, esc, options);
  if (type === 'voiceCall') return voiceCallCardHtml(normalized, esc, options);
  if (type === 'radioEpisode') return radioEpisodeCardHtml(normalized, esc);
  if (type === 'redpacket') return redPacketBubbleHtml(normalized, esc, options);
  if (type === 'transfer') return transferCardBubbleHtml(normalized, esc, options);
  if (type === 'transferReceipt') return transferReceiptCardHtml(normalized, esc, options);
  if (type === 'orderShare') return orderShareCardHtml(normalized, esc);
  if (type === 'textimg') return textImageBubbleHtml(normalized, esc, options);
  if (type === 'chatBundle' || type === 'mergeForward') {
    return chatBundleBubbleHtml(normalized, esc, options);
  }
  if (type === 'location') return locationCardBubbleHtml(normalized, esc, options);
  if (type === 'link') return linkCardBubbleHtml(normalized, esc, options);
  if (type === 'dice') return diceCardBubbleHtml(normalized, esc, options);
  if (type === 'vote') return voteCardBubbleHtml(normalized, esc);
  if (type === 'offlineInvite') return offlineInviteCardHtml(normalized, esc);
  if (type === 'npcCard') return npcCardBubbleHtml(normalized, esc);
  if (type === 'groupInviteUser') return groupInviteUserCardHtml(normalized, esc);
  if (type === 'htmlWidget') {
    const key = String(normalized.id || '').trim();
    return key
      ? `<div class="chat-html-widget" data-html-extension-host="${escAttr(key)}"></div>`
      : esc(content);
  }
  if (normalized.senderId === 'system' && type !== 'storyCard') {
    let systemText = content;
    if (type === 'chatAction' || normalized.metadata?.chatAction) {
      systemText = options.anonymous
        ? resolveAnonymousChatActionText(normalized, options)
        : String(normalized.metadata?.actionText || content || '')
          .replace(/^\[(?:聊天动作|群聊动作)\]\s*/, '');
    }
    const display = applyDisplayRegex(stripLeakedCharacterCodes(systemText, options), 'chat', regexContext);
    const html = /<(?:style|div|span|p|details|summary|section|article)\b/i.test(display)
      ? sanitizeHtmlExtensionTemplate(display)
      : esc(display);
    return `<div class="chat-bubble-system">${html}</div>`;
  }
  const display = applyDisplayRegex(stripLeakedCharacterCodes(content, {
    ...options,
    replaceActorReferences: options.isGroup === true && normalized.metadata?.aiGenerated === true,
  }), 'chat', regexContext);
  const hasHtmlExtension = /<(?:style|div|span|p|details|summary|section|article)\b/i.test(display);
  const plainText = hasHtmlExtension
    ? sanitizeHtmlExtensionTemplate(display)
    : (type === 'text' && normalized.metadata?.mentions
      ? renderChatMentionText(display, normalized.metadata.mentions, {
        escape: esc,
        memberCards: options.memberCards,
        characters: options.characters,
        user: options.user,
        currentUserName: options.currentUserName,
      })
      : esc(display));
  if (type !== 'text') return plainText;
  const sourceText = String(content || '').trim();
  const rawTranslation = String(normalized.metadata?.translation || '').trim();
  const senderId = String(normalized.senderId || '').trim();
  const translationProfile = options.characters?.[senderId]?.translationProfile || {};
  const languageHint = String(
    translationProfile.language || translationProfile.dialectNote || '',
  ).trim();
  const translation = sanitizeAiTranslation(sourceText, rawTranslation, { languageHint });
  const viewerId = String(options.viewerId || 'user').trim() || 'user';
  const isUserBubble = senderId === 'user' || senderId === viewerId;
  const aiGeneratedBubble = normalized.metadata?.aiGenerated === true
    || normalized.metadata?.backstage === true;
  // 真人输入的本方气泡只有已有有效译文时才保留入口，避免普通英文缩写误触发。
  // 角色手机视角下，手机主人发出的后台 AI 消息也在右侧，但它仍是 AI 生成内容；
  // 模型漏掉 zh 时必须和其它角色气泡一样保留可补译入口。
  const showTranslate = isUserBubble && !aiGeneratedBubble
    ? !!translation
    : !!(translation || messageLikelyNeedsTranslationForProfile(sourceText, translationProfile));
  if (!showTranslate) return plainText;
  const translationBody = translation || '';
  return `${plainText}<button type="button" class="chat-bubble-translate-btn" data-translation-toggle aria-expanded="false">翻译</button><div class="chat-bubble-translation" hidden><div class="chat-bubble-translation-divider"></div><div class="chat-bubble-translation-text">${esc(applyDisplayRegex(translationBody, 'chat', regexContext))}</div></div>`;
}

function resolveDisplaySenderId(normalized, options = {}) {
  const roleAsId = normalized.metadata?.sendAsCharacterId;
  const legacyRoleSenderId = normalized.senderId === 'user' && normalized.metadata?.userComposedAsCharacter && roleAsId
    ? String(roleAsId || '').trim()
    : '';
  // 角色手机的早期代发记录可能仍以 user 作为 senderId 落库；实际展示身份
  // 已由 phoneProxyOwnerId 明确，不能因此把角色一侧的头像画成用户头像。
  const phoneProxyOwnerId = normalized.senderId === 'user' && normalized.metadata?.phoneProxyByUser === true
    ? String(normalized.metadata?.phoneProxyOwnerId || roleAsId || '').trim()
    : '';
  const rawId = phoneProxyOwnerId || legacyRoleSenderId || normalized.senderId;
  const actorReferences = buildChatActorReferenceTable(options.chat, {
    includeUser: (options.chat?.participants || []).includes('user'),
  });
  return actorReferences.idFor(rawId) || rawId;
}

function resolveSenderLabel(normalized, options = {}) {
  const displaySenderId = resolveDisplaySenderId(normalized, options);
  const charMap = options.characters || {};
  const isGroup = !!options.isGroup;
  const viewerId = String(options.viewerId || 'user').trim() || 'user';
  const isUser = displaySenderId === viewerId;
  const isSystem = displaySenderId === 'system';
  const isGuidance = displaySenderId === 'guidance'
    || normalized.metadata?.guidanceMode === true
    || normalized.metadata?.guidanceReply === true;
  const showSenderName = (isGroup && !isUser && !isSystem) || isGuidance;
  const char = showSenderName && !isGuidance
    ? resolveIdentityCharacter(charMap, displaySenderId, normalized.senderName)
    : null;
  const phoneViewer = viewerId && viewerId !== 'user';
  const charLabel = phoneViewer
    ? (char?.realName || char?.name || '')
    : (char?.name || char?.customNickname || '');
  // 一次性 NPC 的内部 id 前缀（npc_）是实现细节，历史消息里若曾把它存进了 senderName，
  // 这里兜底剥掉，不让它露到聊天气泡的发言人名字上。
  // 手机视角优先真名，避免历史落库的备注称谓（如「爸爸」）盖住真名。
  let senderLabel = isGuidance
    ? '本体'
    : (phoneViewer
      ? (charLabel || stripEphemeralNpcLabel(normalized.senderName) || stripEphemeralNpcLabel(normalized.senderId) || normalized.senderId)
      : (stripEphemeralNpcLabel(normalized.senderName) || charLabel || stripEphemeralNpcLabel(normalized.senderId) || normalized.senderId));
  if (showSenderName && charLabel && !isGuidance) {
    const rawName = String(normalized.senderName || '').trim();
    const rawKey = rawName.toLowerCase().replace(/[\s_\-./]+/g, '');
    const idKey = String(normalized.senderId || '').toLowerCase().replace(/[\s_\-./]+/g, '');
    const looksLikeBareId = rawName
      && !/[\u4e00-\u9fff]/.test(rawName)
      && (/^[a-z][a-z0-9_-]{2,}$/i.test(rawName) || rawKey === idKey);
    // 历史落库的「对方」等协议占位名，角色卡补齐后要用真实昵称盖掉。
    if (!rawName || looksLikeBareId || phoneViewer || isGenericPeerActorLabel(rawName)) {
      senderLabel = charLabel || senderLabel;
    }
  }
  if (showSenderName && isGenericPeerActorLabel(senderLabel)) {
    senderLabel = charLabel || options.fallbackLabel || '群成员';
  }
  if (showSenderName) {
    const card = String(resolveIdentityMapValue(options.memberCards, displaySenderId) || '').trim();
    if (card) senderLabel = card;
  }
  const anonProfile = resolveIdentityMapValue(options.anonymousProfiles, displaySenderId);
  if (anonProfile?.anonymousId) senderLabel = anonProfile.anonymousId;
  // 最后再兜底扫一遍：未知/已删除角色的 senderId 落到这里时可能还是原始内部 id。
  senderLabel = stripLeakedCharacterCodes(senderLabel, {
    ...options,
    fallbackLabel: charLabel || options.fallbackLabel || '群成员',
  });
  if (showSenderName && looksLikeRawParticipantId(senderLabel)) {
    senderLabel = charLabel || options.fallbackLabel || '群成员';
  }
  return { displaySenderId, senderLabel, isUser, isSystem, isGuidance, showSenderName };
}

function resolveAnonymousChatActionText(normalized, options = {}) {
  const md = normalized?.metadata && typeof normalized.metadata === 'object' ? normalized.metadata : {};
  let systemText = String(md.actionText || normalized.content || '')
    .replace(/^\[(?:聊天动作|群聊动作)\]\s*/, '');
  const actorId = String(md.actionActorId || 'user').trim();
  const targetId = String(md.actionTargetId || '').trim();
  const profiles = options.anonymousProfiles || {};
  const actorName = String(profiles[actorId]?.anonymousId || md.actionActorName || '').trim();
  const targetName = String(profiles[targetId]?.anonymousId || md.actionTargetName || '').trim();
  if (!actorName || !targetName) return systemText;
  const verbMatch = systemText.match(/(拍了拍|戳了戳|拽了拽|摸了摸[^，。！？\s]*|捏了捏[^，。！？\s]*)/);
  const verb = verbMatch ? verbMatch[1] : '拍了拍';
  const tailMatch = systemText.match(new RegExp(`${verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[^，。！？\\s]+[，。！？]?\\s*(.*)$`));
  const tail = String(tailMatch?.[1] || '').trim();
  return tail ? `${actorName} ${verb} ${targetName}，${tail}` : `${actorName} ${verb} ${targetName}`;
}

function buildBubbleReactionsHtml(rx, byUser = {}) {
  if (!rx || typeof rx !== 'object' || !Object.keys(rx).length) return '';
  const chips = Object.entries(rx).map(([em, n]) => {
    const mine = Math.max(0, Number(byUser[em] || 0)) > 0;
    const count = Number(n) > 1 ? esc(String(n)) : '';
    if (mine) {
      return `<button type="button" class="chat-bubble-reaction-chip is-mine" data-reaction-emoji="${escAttr(em)}" title="取消回应" aria-label="取消 ${esc(em)} 回应">${esc(em)}${count}</button>`;
    }
    return `<span class="chat-bubble-reaction-chip">${esc(em)}${count}</span>`;
  }).join('');
  return `<div class="chat-bubble-reactions">${chips}</div>`;
}

function renderBubblePayload(normalized, options = {}) {
  const type = normalized.type || 'text';
  const bareMedia = isBareMediaType(type, normalized);
  const standaloneCard = isStandaloneCardType(type, options);
  const isAnon = !!options.anonymous;
  const speechButton = renderSpeechPlayButtonHtml(normalized, options);
  const replyLine = formatReplyRefDisplayLine(
    normalized,
    getUserDisplayName(options.user),
    {
      resolveReplySenderLabel: options.resolveReplySenderLabel || options.resolveSenderLabel,
      isGroup: !!options.isGroup,
    },
  );
  const reply = replyLine
    ? `<div class="chat-bubble-reply">${esc(stripLeakedCharacterCodes(replyLine, options))}</div>`
    : '';
  const rx = normalized.metadata?.reactions;
  const reactions = buildBubbleReactionsHtml(rx, normalized.metadata?.reactionsByUser);
  const bodyContent = bubbleBody(normalized, options);
  if (isAnon) {
    if (bareMedia) {
      const mediaInner = `${reply}<div class="chat-bubble-body">${bodyContent}</div>`;
      return { contentHtml: `<div class="chat-bubble-media">${mediaInner}</div>`, reactions, bareMedia, standaloneCard };
    }
    if (standaloneCard) {
      const cardHtml = reply ? `<div class="chat-anon-card-wrap">${reply}${bodyContent}</div>` : bodyContent;
      return { contentHtml: cardHtml, reactions, bareMedia, standaloneCard };
    }
    const textInner = `<div class="chat-anon-bubble${speechButton ? ' has-speech-play' : ''}">${reply}<div class="chat-bubble-body">${bodyContent}${speechButton}</div></div>`;
    return { contentHtml: textInner, reactions, bareMedia, standaloneCard };
  }
  const bodyInner = `${reply}<div class="chat-bubble-body">${bodyContent}${speechButton}</div>`;
  const contentHtml = bareMedia
    ? `<div class="chat-bubble-media" data-chat-media-anchor="1">${bodyInner}</div>`
    : standaloneCard
      ? `<div class="chat-bubble-card">${bodyInner}</div>`
      : `<div class="chat-bubble scrapbook-bubble${speechButton ? ' has-speech-play' : ''}">${bodyInner}</div>`;
  return { contentHtml, reactions, bareMedia, standaloneCard };
}

export function renderSpeechPlayButtonHtml(message = {}, options = {}) {
  const id = String(message?.id || '').trim();
  const type = String(message?.type || 'text').trim() || 'text';
  if (options.voicePerformanceModeEnabled !== true
    || !id
    || type !== 'text'
    || !message?.metadata?.speechPlan
    || message?.deleted
    || message?.recalled) {
    return '';
  }
  if (options.voicePerformanceContinuousEnabled === true) {
    if (options.voiceRoundSuppressedIds?.has?.(id)) return '';
    const round = options.voiceRoundControlByMessageId?.get?.(id);
    if (round?.roundId) {
      return `<button type="button" class="chat-speech-play-btn is-round-play" data-speech-play="${escAttr(id)}" data-speech-round="${escAttr(round.roundId)}" title="连续播放本轮" aria-label="按顺序播放本轮角色气泡">${icon('play')}</button>`;
    }
  }
  return `<button type="button" class="chat-speech-play-btn" data-speech-play="${escAttr(id)}" title="朗读" aria-label="朗读这条消息">${icon('play')}</button>`;
}

export function buildVoiceRoundPlaybackPlan(messages = [], options = {}) {
  const suppressedIds = new Set();
  const controlByMessageId = new Map();
  if (options.voicePerformanceModeEnabled !== true
    || options.voicePerformanceContinuousEnabled !== true) {
    return { suppressedIds, controlByMessageId };
  }
  const rounds = new Map();
  (messages || []).forEach((message) => {
    const id = String(message?.id || '').trim();
    const roundId = String(message?.metadata?.aiRoundId || '').trim();
    const type = String(message?.type || 'text').trim() || 'text';
    if (!id
      || !roundId
      || type !== 'text'
      || !message?.metadata?.speechPlan
      || message?.deleted
      || message?.recalled) {
      return;
    }
    const row = rounds.get(roundId) || [];
    row.push(message);
    rounds.set(roundId, row);
  });
  rounds.forEach((roundMessages, roundId) => {
    if (!roundMessages.length) return;
    const control = roundMessages[roundMessages.length - 1];
    const controlId = String(control?.id || '').trim();
    if (!controlId) return;
    roundMessages.slice(0, -1).forEach((message) => {
      const id = String(message?.id || '').trim();
      if (id) suppressedIds.add(id);
    });
    controlByMessageId.set(controlId, {
      roundId,
      messageIds: roundMessages.map((message) => String(message?.id || '').trim()).filter(Boolean),
    });
  });
  return { suppressedIds, controlByMessageId };
}

function renderAnonymousMessageGroup(groupMessages = [], options = {}) {
  const items = groupMessages.map((m) => normalizeMessageForRender(m, options));
  const first = items[0];
  const { displaySenderId, senderLabel, isUser, showSenderName } = resolveSenderLabel(first, options);
  const rowClass = isUser ? 'is-user' : 'is-them';
  const isGroup = !!options.isGroup;
  const charMap = options.characters || {};

  const avatarOpts = {
    user: options.user,
    partner: options.partner,
    characters: charMap,
    anonymousProfiles: options.anonymousProfiles,
    anonymous: options.anonymous,
    isGroup,
    msgId: first.id,
    fallbackLabel: senderLabel,
  };

  const memberTitle = showSenderName
    ? String(resolveIdentityMapValue(options.memberTitles, displaySenderId) || '').trim()
    : '';
  const titleBadge = memberTitle ? `<span class="chat-bubble-title-badge">${esc(memberTitle)}</span>` : '';
  const timeHtml = formatAnonGroupTimeHtml(first.timestamp);

  const bubbleParts = items.map((normalized) => {
    const { contentHtml, reactions, standaloneCard, bareMedia } = renderBubblePayload(normalized, options);
    const itemSelectable = options.selectionMode ? ' is-selectable' : '';
    const itemSelected = options.selectionMode && options.selectedSet?.has(normalized.id) ? ' is-selected' : '';
    const itemClass = standaloneCard ? 'chat-msg-card' : bareMedia ? 'chat-msg-media' : 'chat-msg-bubble';
    const itemCheckHtml = `<input type="checkbox" class="chat-bubble-select chat-msg-item-select" ${options.selectionMode ? '' : 'hidden'} ${itemSelected ? 'checked' : ''} />`;
    const phoneProxyLine = normalized.metadata?.phoneProxyByUser === true
      ? '<div class="chat-bubble-phone-proxy" title="用户操作角色手机发出">代发</div>'
      : '';
    const formatRecoveryLine = normalized.metadata?.modelFormatRecoveryNotice === true
      ? '<div class="chat-bubble-format-recovered" title="模型没有按约定协议输出；本轮由兼容解析器拆分">掉格式 · 已兼容</div>'
      : '';
    return `<div class="${itemClass}${itemSelectable}${itemSelected}" data-msg-id="${esc(normalized.id)}">${itemCheckHtml}${phoneProxyLine}${formatRecoveryLine}${contentHtml}${reactions}</div>`;
  }).join('');

  const readLabel = resolveAnonymousReadLabel(first, isUser, options);
  const readHtml = `<div class="chat-bubble-read">${esc(readLabel)}</div>`;
  const stackFooter = `<div class="chat-bubble-stack-foot">${readHtml}</div>`;
  const avatarInner = isUser
    ? resolveRowAvatar('user', { ...avatarOpts, user: options.user })
    : resolveRowAvatar(displaySenderId, avatarOpts);
  const avatarWrap = `<span class="chat-bubble-avatar-wrap">${avatarInner}</span>`;
  const identityHtml = `<span class="chat-bubble-sender chat-bubble-identity${showSenderName ? '' : ' is-beautify-identity'}" data-sender-label="${escAttr(senderLabel)}">${esc(senderLabel)}${titleBadge}</span>`;
  const metaHtml = showSenderName
    ? `<div class="chat-msg-group-meta is-named">${identityHtml}${timeHtml}</div>`
    : `<div class="chat-msg-group-meta">${identityHtml}${timeHtml}</div>`;
  const groupTop = `<div class="chat-msg-group-top">${avatarWrap}${metaHtml}</div>`;

  return `
    <div class="chat-msg-group ${rowClass}">
      <div class="chat-msg-group-col">
        ${groupTop}
        <div class="chat-msg-stack">
          ${bubbleParts}
          ${stackFooter}
        </div>
      </div>
    </div>
  `;
}

export function renderMessageBubble(msg, options = {}) {
  if (isHiddenFromChatUi(msg)) return '';
  const normalized = normalizeMessageForRender(msg, options);
  if (options.anonymous && normalized.senderId !== 'system' && normalized.type !== 'storyCard') {
    return renderAnonymousMessageGroup([msg], options);
  }
  const charMap = options.characters || {};
  const { displaySenderId, senderLabel, isUser, isSystem, isGuidance, showSenderName } = resolveSenderLabel(normalized, options);
  const isGroup = !!options.isGroup;
  const { contentHtml, reactions, bareMedia, standaloneCard } = renderBubblePayload(normalized, options);
  const rejectedHtml = shouldRenderDeliveryRejected(normalized, options)
    ? `<span class="chat-delivery-rejected" title="消息被拒收">!</span>`
    : '';

  const type = normalized.type || 'text';
  const rowClass = isUser ? 'is-user' : isSystem ? 'is-system' : 'is-them';
  const guidanceClass = isGuidance ? ' is-guidance' : '';
  const selectable = options.selectionMode ? ' is-selectable' : '';
  const selected = options.selectedSet?.has(normalized.id) ? ' is-selected' : '';
  const mediaClass = bareMedia ? ' is-media' : '';
  const cardClass = standaloneCard ? ' is-card' : '';
  const rawTimeHtml = shouldSuppressMessageTime(normalized, options)
    ? ''
    : `<div class="chat-bubble-time">${esc(formatTime(normalized.timestamp))}</div>`;
  const timeHtml = options.chatPlatform === 'wechat' ? '' : rawTimeHtml;
  const readReceiptHtml = options.anonymous && !standaloneCard && !bareMedia
    ? `<div class="chat-bubble-read">${esc(resolveAnonymousReadLabel(normalized, isUser, options))}</div>`
    : '';
  const rowStyle = !isUser && !isSystem && !isGuidance && !options.anonymous
    ? roleBubbleRowStyleAttr(displaySenderId, options)
    : '';

  const hasSenderLine = showSenderName;
  const senderClass = hasSenderLine ? ' has-sender' : '';

  const avatarOpts = {
    user: options.user,
    partner: options.partner,
    characters: charMap,
    anonymousProfiles: options.anonymousProfiles,
    anonymous: options.anonymous,
    isGroup,
    msgId: normalized.id,
    fallbackLabel: senderLabel,
    message: normalized,
  };
  const checkHtml = `<input type="checkbox" class="chat-bubble-select" ${options.selectionMode ? '' : 'hidden'} ${selected ? 'checked' : ''} />`;

  if (isSystem) {
    // 拍一拍/戳一戳等动作提示属于行内通知，不再单独跟一个多余的时间戳
    const isActionNotice = type === 'chatAction' || !!normalized.metadata?.chatAction;
    return `
      <div class="chat-bubble-row is-system${selectable}${selected}" data-msg-id="${esc(normalized.id)}">
        ${checkHtml}
        <div class="chat-bubble-col is-center">
          <div class="chat-bubble-system-line">${bubbleBody(normalized, options)}</div>
          ${isActionNotice ? '' : timeHtml}
        </div>
      </div>
    `;
  }

  const leftAvatar = !isUser ? resolveRowAvatar(displaySenderId, avatarOpts) : '';
  const rightAvatar = isUser
    ? resolveRowAvatar(displaySenderId, {
      ...avatarOpts,
      ...(displaySenderId === 'user' ? { user: options.user } : {}),
    })
    : '';

  const memberTitle = showSenderName
    ? String(resolveIdentityMapValue(options.memberTitles, displaySenderId) || '').trim()
    : '';
  const titleBadge = memberTitle ? `<span class="chat-bubble-title-badge">${esc(memberTitle)}</span>` : '';
  const nameLine = `<div class="chat-bubble-sender chat-bubble-identity${hasSenderLine ? '' : ' is-beautify-identity'}" data-sender-label="${escAttr(senderLabel)}">${esc(senderLabel)}${titleBadge}</div>`;
  const autoReplyLine = normalized.metadata?.phoneAutoReply || normalized.metadata?.offlineAutoReply
    ? `<div class="chat-bubble-auto-reply">${esc(normalized.metadata?.autoReplyLabel || '系统自动回复')}</div>`
    : '';
  const phoneProxyLine = normalized.metadata?.phoneProxyByUser === true
    ? '<div class="chat-bubble-phone-proxy" title="用户操作角色手机发出">代发</div>'
    : '';
  const formatRecoveryLine = normalized.metadata?.modelFormatRecoveryNotice === true
    ? '<div class="chat-bubble-format-recovered" title="模型没有按约定协议输出；本轮由兼容解析器拆分">掉格式 · 已兼容</div>'
    : '';
  const joinIntentLine = offlineJoinIntentHtml(normalized);

  if (isUser) {
    return `
      <div class="chat-bubble-row ${rowClass}${senderClass}${guidanceClass}${selectable}${selected}${mediaClass}${cardClass}" data-msg-id="${esc(normalized.id)}"${rowStyle}>
        ${checkHtml}
        <div class="chat-bubble-col">
          ${nameLine}
          ${phoneProxyLine}
          ${formatRecoveryLine}
          ${autoReplyLine}
          ${contentHtml}
          ${joinIntentLine}
          ${reactions}
          ${timeHtml}
          ${readReceiptHtml}
        </div>
        ${rejectedHtml}
        ${rightAvatar}
      </div>
    `;
  }

  return `
    <div class="chat-bubble-row ${rowClass}${senderClass}${guidanceClass}${selectable}${selected}${mediaClass}${cardClass}" data-msg-id="${esc(normalized.id)}"${rowStyle}>
      ${checkHtml}
      ${leftAvatar}
      <div class="chat-bubble-col">
        ${nameLine}
        ${phoneProxyLine}
        ${formatRecoveryLine}
        ${autoReplyLine}
        ${contentHtml}
        ${joinIntentLine}
        ${reactions}
        ${timeHtml}
        ${readReceiptHtml}
      </div>
      ${rejectedHtml}
    </div>
  `;
}

function resolveAnonymousReadLabel(normalized, isUser, options = {}) {
  const md = normalized?.metadata && typeof normalized.metadata === 'object' ? normalized.metadata : {};
  const explicit = md.readStatus ?? md.receiptStatus ?? md.deliveryRead ?? md.read;
  if (explicit === false || explicit === 'false' || explicit === 'unread' || explicit === 'pending') return '未读';
  if (explicit === true || explicit === 'true' || explicit === 'read' || explicit === 'seen') return '已读';
  if (!isUser) return '已读';
  // Anonymous chats never persisted read receipts; treat a later peer reply as "seen".
  if (options.peerHasRepliedAfter) return '已读';
  return '未读';
}

/** True if any later visible message is from a peer (not viewer / system / story). */
function hasPeerMessageAfter(visible, startIndex, options = {}) {
  const viewerId = String(options.viewerId || 'user').trim() || 'user';
  for (let i = startIndex; i < visible.length; i += 1) {
    const n = normalizeMessageForRender(visible[i], options);
    if (!n || n.type === 'storyCard' || isSystemTimelineMessage(n)) continue;
    const sid = resolveDisplaySenderId(n);
    if (sid && sid !== viewerId && sid !== 'system' && sid !== 'guidance') return true;
  }
  return false;
}

function canStackMessage(normalized) {
  if (!normalized || normalized.senderId === 'system') return false;
  if (normalized.type === 'storyCard') return false;
  return true;
}

function messageStackIdentity(normalized, options = {}) {
  const senderId = resolveDisplaySenderId(normalized, options);
  if (!isLegacyTruncatedPhoneContactId(senderId)) return senderId;
  // 多个旧成员可能共用同一个截断 id；历史署名不同就必须拆成不同气泡组，
  // 否则后一人的内容会沿用前一人的姓名和头像。
  const senderName = identityDisplayNameKey(normalized?.senderName);
  return senderName ? `${senderId}\u0000${senderName}` : senderId;
}

/**
 * 「连续气泡」：普通（非匿名）聊天下，同一发送者连续消息合并成一组——
 * 头像/称呼只在组头露一次，时间只在组尾露一次，中间挨得更紧。
 * 结构复用匿名页已验证过的 chat-msg-bubble/card/media 分类（选择模式/CSS 都认这几个类名），
 * 但内容渲染路径走普通分支（renderBubblePayload 的 isAnon 仍取 options.anonymous，不受影响）。
 */
function renderStackedMessageGroup(groupMessages = [], options = {}) {
  const items = groupMessages.map((m) => normalizeMessageForRender(m, options));
  const first = items[0];
  const last = items[items.length - 1];
  const { displaySenderId, senderLabel, isUser, showSenderName } = resolveSenderLabel(first, options);
  const isGroup = !!options.isGroup;
  const charMap = options.characters || {};
  const rowClass = isUser ? 'is-user' : 'is-them';

  const rowStyle = !isUser && !options.anonymous
    ? roleBubbleRowStyleAttr(displaySenderId, options)
    : '';

  const avatarOpts = {
    user: options.user,
    partner: options.partner,
    characters: charMap,
    anonymousProfiles: options.anonymousProfiles,
    anonymous: options.anonymous,
    isGroup,
    msgId: first.id,
    fallbackLabel: senderLabel,
    message: first,
  };
  const avatarHtml = isUser
    ? resolveRowAvatar(displaySenderId, {
      ...avatarOpts,
      ...(displaySenderId === 'user' ? { user: options.user } : {}),
    })
    : resolveRowAvatar(displaySenderId, avatarOpts);

  const memberTitle = showSenderName
    ? String(resolveIdentityMapValue(options.memberTitles, displaySenderId) || '').trim()
    : '';
  const titleBadge = memberTitle ? `<span class="chat-bubble-title-badge">${esc(memberTitle)}</span>` : '';
  const nameLine = `<div class="chat-bubble-sender chat-bubble-identity${showSenderName ? '' : ' is-beautify-identity'}" data-sender-label="${escAttr(senderLabel)}">${esc(senderLabel)}${titleBadge}</div>`;

  const itemsHtml = items.map((normalized) => {
    const { contentHtml, reactions, standaloneCard, bareMedia } = renderBubblePayload(normalized, options);
    const itemSelectable = options.selectionMode ? ' is-selectable' : '';
    const itemSelected = options.selectionMode && options.selectedSet?.has(normalized.id) ? ' is-selected' : '';
    const itemClass = standaloneCard ? 'chat-msg-card' : bareMedia ? 'chat-msg-media' : 'chat-msg-bubble';
    const itemCheckHtml = `<input type="checkbox" class="chat-bubble-select chat-msg-item-select" ${options.selectionMode ? '' : 'hidden'} ${itemSelected ? 'checked' : ''} />`;
    const autoReplyLine = normalized.metadata?.phoneAutoReply || normalized.metadata?.offlineAutoReply
      ? `<div class="chat-bubble-auto-reply">${esc(normalized.metadata?.autoReplyLabel || '系统自动回复')}</div>`
      : '';
    const joinIntentLine = offlineJoinIntentHtml(normalized);
    const rejectedHtml = shouldRenderDeliveryRejected(normalized, options)
      ? `<span class="chat-delivery-rejected" title="消息被拒收">!</span>`
      : '';
    const phoneProxyLine = normalized.metadata?.phoneProxyByUser === true
      ? '<div class="chat-bubble-phone-proxy" title="用户操作角色手机发出">代发</div>'
      : '';
    const itemTimeHtml = options.messageTimestampMode === 'each'
      ? `<div class="chat-bubble-time chat-bubble-item-time">${esc(formatTime(normalized.timestamp))}</div>`
      : '';
    return `<div class="${itemClass}${itemSelectable}${itemSelected}" data-msg-id="${esc(normalized.id)}">${itemCheckHtml}${phoneProxyLine}${autoReplyLine}${contentHtml}${joinIntentLine}${reactions}${rejectedHtml}${itemTimeHtml}</div>`;
  }).join('');

  const timeHtml = options.messageTimestampMode === 'each' || shouldSuppressMessageTime(last, options)
    ? ''
    : `<div class="chat-bubble-time chat-bubble-stack-time">${esc(formatTime(last.timestamp))}</div>`;
  const avatarSide = !isUser ? avatarHtml : '';
  const avatarEnd = isUser ? avatarHtml : '';

  return `
    <div class="chat-bubble-row ${rowClass} is-stack-group"${rowStyle}>
      ${avatarSide}
      <div class="chat-bubble-col chat-bubble-col-stack">
        ${nameLine}
        ${itemsHtml}
        ${timeHtml}
      </div>
      ${avatarEnd}
    </div>
  `;
}

export function renderStreamingPlaceholder(text = '正在输入…', options = {}) {
  const displaySenderId = options.partnerId || Object.keys(options.characters || {})[0] || 'character';
  const avatar = resolveRowAvatar(displaySenderId, options);
  const rowStyle = roleBubbleRowStyleAttr(displaySenderId, options);
  return `
    <div class="chat-bubble-row is-them is-streaming" data-stream-placeholder${rowStyle}>
      ${avatar}
      <div class="chat-bubble-col">
        <div class="chat-bubble scrapbook-bubble is-pending">
          <div class="chat-bubble-body chat-typing-indicator" aria-label="${esc(text)}">
            <span class="chat-typing-label">${esc(text.replace(/…+$/, ''))}</span>
            <span class="chat-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          </div>
        </div>
      </div>
    </div>
  `;
}

/** 小剧场卡台词常是多角色台词合写在一起，最容易把内部 id 当名字抄进去，渲染前先兜底清一遍。 */
function stripLeakedCharacterCodesFromStoryCard(normalized, options = {}) {
  const md = normalized.metadata || {};
  const clean = (v) => stripLeakedCharacterCodes(v, options);
  return {
    ...normalized,
    content: clean(normalized.content),
    metadata: {
      ...md,
      summary: md.summary ? clean(md.summary) : md.summary,
      fullText: md.fullText ? clean(md.fullText) : md.fullText,
      paragraphs: Array.isArray(md.paragraphs) ? md.paragraphs.map((p) => clean(p)) : md.paragraphs,
    },
  };
}

export function renderStoryCardRowHtml(msg, options = {}) {
  const normalized = stripLeakedCharacterCodesFromStoryCard(normalizeMessageForRender(msg, options), options);
  const id = String(normalized.id || '').trim();
  const storyKind = String(normalized.metadata?.storyKind || '').trim();
  const statusRowClass = storyKind === 'status' || storyKind === 'life_glimpse'
    ? ' story-card-row--status'
    : '';
  const lifeGlimpseRowClass = storyKind === 'life_glimpse' ? ' story-card-row--life-glimpse' : '';
  return `
    <div class="story-card-row${statusRowClass}${lifeGlimpseRowClass}" data-msg-id="${esc(id)}">
      <div class="story-card-row-main">
        ${buildStoryCardHtml(normalized, esc, escAttr)}
        <div class="story-card-row-time">${esc(formatMsgTime(normalized.timestamp))}</div>
      </div>
    </div>
  `;
}

function flushMessageGroup(group, options, parts, peerHasRepliedAfter = false) {
  if (!group.length) return;
  if (options.anonymous) {
    parts.push(renderAnonymousMessageGroup(group, {
      ...options,
      peerHasRepliedAfter: !!peerHasRepliedAfter,
    }));
    return;
  }
  if (group.length === 1) {
    parts.push(renderMessageBubble(group[0], options));
  } else {
    parts.push(renderStackedMessageGroup(group, options));
  }
}

/**
 * 追加渲染的快速路径：把新到的几条消息渲染成可以直接 insertAdjacentHTML('beforeend')
 * 的 HTML，跳过整个可见列表的 innerHTML 重建（长会话里点发送「卡一下」的主要成本）。
 * 只处理「新消息作为独立行接在已渲染内容后面」的情况；当新消息按连续气泡规则
 * 需要并进上一条已渲染的组（要改旧 DOM）时返回 null，调用方退回整体重绘。
 */
export function renderAppendedMessagesHtml(appended = [], { prevMessages = [], options = {} } = {}) {
  const list = (appended || []).filter((m) => m && !isHiddenFromChatUi(m));
  if (!list.length) return '';
  // Anonymous peer replies must full-repaint so earlier user groups can flip 未读 → 已读.
  if (options.anonymous && hasPeerMessageAfter(list, 0, options)) return null;
  if (options.voicePerformanceModeEnabled === true
    && options.voicePerformanceContinuousEnabled === true) {
    const appendedRoundIds = new Set(list
      .map((message) => String(message?.metadata?.aiRoundId || '').trim())
      .filter(Boolean));
    if (appendedRoundIds.size && (prevMessages || []).some((message) => (
      appendedRoundIds.has(String(message?.metadata?.aiRoundId || '').trim())
    ))) {
      // 同一回合逐条落库时必须重画整轮，让唯一播放键始终移动到本轮最后一条可朗读气泡。
      return null;
    }
  }
  // 从已渲染内容尾部找：最后一行（连续气泡判断用）和最后一条有时间戳的内容（分割线判断用）。
  let prevNorm = null;
  let lastContentTs = 0;
  for (let i = prevMessages.length - 1; i >= 0; i -= 1) {
    const m = prevMessages[i];
    if (!m || isHiddenFromChatUi(m)) continue;
    const normalized = normalizeMessageForRender(m, options);
    if (!prevNorm) prevNorm = normalized;
    if (isStatusTimelineHint(normalized)) {
      const ts = Number(normalized.timestamp || 0);
      if (ts) {
        lastContentTs = ts;
        break;
      }
    }
    if (!isSystemTimelineMessage(normalized)) {
      const ts = Number(normalized.timestamp || 0);
      if (ts) {
        lastContentTs = ts;
        break;
      }
    }
  }
  const firstNorm = normalizeMessageForRender(list[0], options);
  const firstTs = Number(firstNorm.timestamp || 0);
  const needDivider = !!(lastContentTs && firstTs && shouldInsertTimeDivider(lastContentTs, firstTs));
  const stackEnabled = options.anonymous || options.groupConsecutive;
  if (
    stackEnabled && !needDivider && prevNorm
    && !isSystemTimelineMessage(prevNorm)
    && canStackMessage(prevNorm) && canStackMessage(firstNorm)
    && messageStackIdentity(prevNorm, options) === messageStackIdentity(firstNorm, options)
  ) {
    return null;
  }
  return (needDivider ? renderThreadTimeDividerHtml(firstTs, options) : '')
    + renderMessagesHtml(list, { ...options, suppressInitialTimeDivider: true });
}

export function renderMessagesHtml(messages, options = {}) {
  const visibleRows = (messages || []).filter((m) => m && !isHiddenFromChatUi(m));
  const visible = visibleRows.map((message, index) => ({
    ...message,
    __regexDepth: visibleRows.length - 1 - index,
  }));
  const narrationRounds = new Map();
  visible.forEach((message) => {
    const roundId = String(message?.metadata?.aiRoundId || '').trim();
    if (!roundId) return;
    const row = narrationRounds.get(roundId) || { hasNarration: false, messages: [] };
    if (message?.metadata?.narratorBeat === true) row.hasNarration = true;
    else if (message.senderId !== 'system' && message.type !== 'system') row.messages.push(message);
    narrationRounds.set(roundId, row);
  });
  const suppressTimeIds = new Set(options.suppressTimeIds || []);
  narrationRounds.forEach((round) => {
    if (!round.hasNarration || round.messages.length < 2) return;
    round.messages.slice(0, -1).forEach((message) => {
      const id = String(message?.id || '').trim();
      if (id) suppressTimeIds.add(id);
    });
  });
  const baseRenderOptions = suppressTimeIds.size ? { ...options, suppressTimeIds } : options;
  const voiceRoundPlan = buildVoiceRoundPlaybackPlan(visible, baseRenderOptions);
  const renderOptions = voiceRoundPlan.controlByMessageId.size
    ? {
      ...baseRenderOptions,
      voiceRoundSuppressedIds: voiceRoundPlan.suppressedIds,
      voiceRoundControlByMessageId: voiceRoundPlan.controlByMessageId,
    }
    : baseRenderOptions;
  const parts = [];
  let lastContentTs = 0;
  let msgGroup = [];
  const stackEnabled = options.anonymous || options.groupConsecutive;

  const flushGroup = (nextIndex) => {
    let peerHasRepliedAfter = false;
    if (options.anonymous && msgGroup.length) {
      const first = normalizeMessageForRender(msgGroup[0], renderOptions);
      const { isUser } = resolveSenderLabel(first, renderOptions);
      if (isUser) peerHasRepliedAfter = hasPeerMessageAfter(visible, nextIndex, options);
    }
    flushMessageGroup(msgGroup, renderOptions, parts, peerHasRepliedAfter);
    msgGroup = [];
  };

  for (let idx = 0; idx < visible.length; idx += 1) {
    const m = visible[idx];
    const normalized = normalizeMessageForRender(m, renderOptions);
    if (normalized.type === 'storyCard') {
      flushGroup(idx);
      const ts = Number(normalized.timestamp || 0);
      if (ts && lastContentTs && shouldInsertTimeDivider(lastContentTs, ts)) {
        parts.push(renderThreadTimeDividerHtml(ts, renderOptions));
      }
      parts.push(renderStoryCardRowHtml(normalized, renderOptions));
      if (ts) lastContentTs = ts;
      continue;
    }
    if (isSystemTimelineMessage(normalized)) {
      flushGroup(idx);
      const systemTimelineTs = (
        normalized.metadata?.narratorBeat === true
        || isStatusTimelineHint(normalized)
      )
        ? Number(normalized.timestamp || 0)
        : 0;
      if (systemTimelineTs && lastContentTs && shouldInsertTimeDivider(lastContentTs, systemTimelineTs)) {
        parts.push(renderThreadTimeDividerHtml(systemTimelineTs, renderOptions));
      }
      parts.push(renderSystemHintRowHtml(normalized, esc, renderOptions));
      if (systemTimelineTs) lastContentTs = systemTimelineTs;
      continue;
    }

    const ts = Number(normalized.timestamp || 0);
    if (ts && ((options.chatPlatform === 'wechat' && !lastContentTs && options.suppressInitialTimeDivider !== true)
      || (lastContentTs && shouldInsertTimeDivider(lastContentTs, ts)))) {
      flushGroup(idx);
      parts.push(renderThreadTimeDividerHtml(ts, renderOptions));
    }

    if (stackEnabled && canStackMessage(normalized)) {
      const sender = messageStackIdentity(normalized, renderOptions);
      const prevSender = msgGroup.length
        ? messageStackIdentity(normalizeMessageForRender(msgGroup[msgGroup.length - 1], renderOptions), renderOptions)
        : '';
      if (msgGroup.length && prevSender === sender) {
        msgGroup.push(m);
      } else {
        flushGroup(idx);
        msgGroup = [m];
      }
    } else {
      flushGroup(idx);
      parts.push(renderMessageBubble(normalized, renderOptions));
    }
    if (ts) lastContentTs = ts;
  }

  flushGroup(visible.length);
  return parts.join('');
}
