/** Chat card / bubble HTML builders (ported from glory chat-helpers, esc as parameter). */

import { applyDisplayRegex } from '../display-regex.js';
import { detectLinkPlatform } from '../link-platforms.js';
import { isLinkMessageMetadataStale, displaySocialImageUrl, pickLinkCardDisplayCopy, isBodyFirstLinkPlatform } from '../link-card-enhancer.js';
import { renderNarrationTextWithTranslations } from '../narration-translation.js';
import { sanitizeAiTranslation } from '../translation-utils.js';
import { sanitizeVoiceTranscriptText, stripVoiceDisplayTags } from '../voice-tools.js';
import { icon } from '../../components/svg-icons.js';
import { resolveActorDisplayLabel } from './character-code-fallback.js';
import { resolveChatInternalLink } from './internal-link.js';

function formatOrderSharePriceDisplay(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[¥￥]/.test(raw)) return raw.replace(/￥/g, '¥');
  const num = raw.replace(/[^\d.]/g, '');
  if (!num) return raw;
  const n = Number(num);
  return Number.isFinite(n) && n >= 0 ? `¥${n.toFixed(2)}` : raw;
}

export function bundleSenderLabel(item = {}, options = {}) {
  const id = String(item.senderId || '').trim();
  const stored = String(item.senderName || '').trim();
  // senderName 是转发创建时冻结的前台身份；有值时绝不能按真实 senderId 重新解析。
  if (stored) {
    return resolveActorDisplayLabel(stored, { fallback: '某人' });
  }
  if (typeof options.resolveDisplayName === 'function' && id) {
    const resolved = String(options.resolveDisplayName(id) || '').trim();
    if (resolved && resolved !== id) return resolved;
  }
  return resolveActorDisplayLabel(id, {
    ...options,
    fallback: '某人',
  });
}

/** 只有这几个平台走过深度解析/官方封面，图能代表内容本身；其余（普通网页、抖音等）
 * 抓到的"封面"多半只是站点 logo/占位图，硬放大成方形卡片反而难看，统一收成信息密度更低、
 * 占地更小的纯标题卡。 */
const LINK_RICH_COVER_PLATFORMS = new Set(['xiaohongshu', 'weibo', 'bilibili', 'taobao']);

export function formatVoiceDurationLabel(totalSeconds = 3) {
  const sec = Math.max(1, Math.min(600, Math.round(Number(totalSeconds) || 0) || 3));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function radioEpisodeCardHtml(msg, escapeHtmlFn) {
  const escapeHtml = escapeHtmlFn || ((value) => String(value ?? ''));
  const metadata = msg?.metadata || {};
  const episodeId = String(metadata.radioEpisodeId || '').trim();
  const title = String(metadata.radioEpisodeTitle || msg?.content || '声音节目').trim();
  const subtitle = String(metadata.radioEpisodeSubtitle || metadata.radioEpisodeSummary || '').trim();
  const chapters = Math.max(0, Number(metadata.radioEpisodeChapters || 0) || 0);
  const typeLabel = String(metadata.radioEpisodeTypeLabel || '').trim() || ({
    bedtime: '枕边故事', memory: '角色往事', confession: '深夜自白', daily: '今日手记',
    knowledge: '小课堂', improv: '随便讲讲', reading: '来稿夜读',
  })[String(metadata.radioEpisodeType || '')] || '角色电台';
  return `
    <button type="button" class="radio-chat-card" data-card-type="radio-episode" data-radio-episode-id="${escapeHtml(episodeId)}">
      <span class="radio-chat-card-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span class="radio-chat-card-copy">
        <span class="radio-chat-card-kicker">${escapeHtml(typeLabel)}</span>
        <span class="radio-chat-card-title">${escapeHtml(title)}</span>
        ${subtitle ? `<span class="radio-chat-card-subtitle">${escapeHtml(subtitle)}</span>` : ''}
        <span class="radio-chat-card-meta">${chapters ? `${chapters} 个章节 · ` : ''}打开收听</span>
      </span>
      <span class="radio-chat-card-arrow" aria-hidden="true">↗</span>
    </button>`;
}

/** 解析秒数；支持 5、12秒、0:08 等，失败返回 null */
export function parseVoiceDurationInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const clock = raw.match(/^(\d+):(\d{1,2})$/);
  if (clock) {
    const sec = parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10);
    if (sec > 0 && sec <= 600) return sec;
    return null;
  }
  const numMatch = raw.match(/^(\d+(?:\.\d+)?)\s*(?:秒|s|S)?$/);
  if (numMatch) {
    const sec = Math.round(Number(numMatch[1]));
    if (sec > 0 && sec <= 600) return sec;
  }
  return null;
}

/** 规范化为 m:ss；fallbackSeconds 为 null 时解析失败返回空串 */
export function normalizeVoiceDurationLabel(input, fallbackSeconds = 5) {
  const sec = parseVoiceDurationInput(input);
  if (sec != null) return formatVoiceDurationLabel(sec);
  if (fallbackSeconds === null || fallbackSeconds === undefined) return '';
  return formatVoiceDurationLabel(fallbackSeconds);
}

/** 从协议 voice 事件解析时长：优先 seconds / duration，否则按转写估算 */
export function resolveVoiceEventDuration(event = {}, text = '') {
  const sources = [event.seconds, event.durationSeconds, event.duration];
  for (const src of sources) {
    if (src == null || src === '') continue;
    const label = normalizeVoiceDurationLabel(src, null);
    if (label) return label;
  }
  const transcript = String(text || event.text || event.body || '').trim();
  if (transcript) {
    const est = Math.max(2, Math.min(60, Math.ceil(transcript.length / 3)));
    return formatVoiceDurationLabel(est);
  }
  return formatVoiceDurationLabel(5);
}

export function parseDurationLabelToSeconds(label) {
  const sec = parseVoiceDurationInput(label);
  if (sec != null) return sec;
  const m = String(label || '').trim().match(/^(\d+):(\d{1,2})$/);
  if (!m) return null;
  return Math.min(600, Math.max(0, parseInt(m[1], 10) * 60 + parseInt(m[2], 10)));
}

export function voiceBarInlineStyle(durationLabel, options = {}) {
  const sec = parseDurationLabelToSeconds(durationLabel) ?? 3;
  if (options.compactVoice) {
    const w = Math.min(92, 52 + Math.round(sec * 5));
    const wechatWidth = Math.min(210, 72 + Math.round(sec * 5));
    return `--voice-duration-s:${sec};--voice-wechat-w:${wechatWidth}px;--voice-bar-w:${w}px`;
  }
  const w = Math.min(240, 40 + Math.round(sec * 5));
  return `min-width:${w}px`;
}

export function buildVoiceBubbleInnerHtml(msg, escapeHtml, options = {}) {
  const dur = msg.metadata?.duration || '0:03';
  const durationSeconds = parseDurationLabelToSeconds(dur) ?? 3;
  const compact = !!options.insCard || !!options.anonymous;
  const vstyle = voiceBarInlineStyle(dur, { compactVoice: compact });
  const text = String(msg.metadata?.text || msg.metadata?.transcript || '').trim();
  const expanded = !!msg.metadata?.voiceExpanded;
  const cached = !!msg.metadata?.audioCacheKey;
  const displayText = stripVoiceDisplayTags(sanitizeVoiceTranscriptText(text, msg.metadata || {}));
  const regexContext = {
    placement: msg.senderId === 'user' && !msg.metadata?.userComposedAsCharacter ? 1 : 2,
    depth: msg.__regexDepth,
    macros: { user: options.currentUserName || '用户', char: msg.senderName || '角色' },
  };
  const wave = '<span class="voice-msg-wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></span>';
  const durEl = `<span class="voice-msg-dur" data-voice-seconds="${durationSeconds}" aria-label="${durationSeconds}秒">${escapeHtml(dur)}</span>`;
  const playTitle = cached ? '播放缓存语音' : '生成并播放语音';
  const playBtn = `<button type="button" class="voice-msg-play" data-voice-action="play" title="${escapeHtml(playTitle)}" aria-label="${escapeHtml(playTitle)}">${icon('play')}</button>`;
  const cacheMark = cached ? '<span class="voice-msg-cache-mark" title="已缓存">●</span>' : '';
  const bar = `<div class="voice-msg-bar" style="${vstyle}">${playBtn}${wave}${durEl}${cacheMark}</div>`;
  const rootClass = compact ? 'voice-msg voice-msg--compact' : 'voice-msg chat-card';
  const stateClass = `${expanded ? ' voice-msg--expanded' : ' voice-msg--collapsed'}${cached ? ' voice-msg--cached' : ''}`;
  if (!text || !expanded) {
    return `<div class="${rootClass}${stateClass}" data-card-type="voice" title="${text ? '点击查看转写文字' : ''}">${bar}</div>`;
  }
  // 译文与原文转写一样剥掉性能标签：sanitize 会清一次，这里再兜底旧消息里残留的 <>
  const translation = stripVoiceDisplayTags(
    sanitizeAiTranslation(displayText || text, msg.metadata?.translation) || '',
  );
  const translationHtml = translation
    ? `<div class="voice-msg-translation-divider"></div><div class="voice-msg-translation">${escapeHtml(applyDisplayRegex(translation, 'chat', regexContext))}</div>`
    : '';
  return `<div class="${rootClass}${stateClass}" data-card-type="voice">${bar}<div class="voice-msg-transcript"><div class="voice-msg-text voice-msg-text--full">${escapeHtml(applyDisplayRegex(displayText || text, 'chat', regexContext))}</div>${translationHtml}</div></div>`;
}

function normalizeVoiceCallState(raw = '') {
  const s = String(raw || '').trim().toLowerCase();
  if (/miss|未接|没接/.test(s)) return 'missed';
  if (/cancel|取消|已取消/.test(s)) return 'cancelled';
  if (/declin|reject|拒绝/.test(s)) return 'declined';
  if (/hang\s*up|hung\s*up|挂断|已挂断/.test(s)) return 'ended';
  if (/end|ended|结束|已结束|通话结束/.test(s)) return 'ended';
  if (/active|calling|ongoing|接听|通话中|正在通话|继续/.test(s)) return 'active';
  if (/out|拨出|呼出/.test(s)) return 'outgoing';
  return 'incoming';
}

function isQqCardRender(options = {}) {
  return String(options.chatPlatform || '').trim().toLowerCase() === 'qq';
}

export function getVoiceCallStateLabel(state = '', callMode = '') {
  const s = normalizeVoiceCallState(state);
  const modeWord = String(callMode || '').trim().toLowerCase() === 'video' ? '视频' : '语音';
  if (s === 'missed') return '未接听';
  if (s === 'cancelled') return '已取消';
  if (s === 'declined') return '已拒绝';
  if (s === 'ended') return '已挂断';
  if (s === 'active') return `${modeWord}通话中`;
  if (s === 'outgoing') return `${modeWord}呼出`;
  return `${modeWord}来电`;
}

export function voiceCallCardHtml(msg, escapeHtml, options = {}) {
  const state = normalizeVoiceCallState(msg.metadata?.callState || msg.metadata?.state || '');
  const callMode = String(msg.metadata?.callMode || '').trim().toLowerCase() === 'video' ? 'video' : 'voice';
  const note = String(msg.metadata?.note || msg.metadata?.reason || msg.content || '').trim();
  const duration = String(msg.metadata?.duration || '').trim();
  const isPending = state === 'incoming' || state === 'outgoing';
  const isActive = state === 'active';
  const isSettled = state === 'ended' || state === 'cancelled' || state === 'declined' || state === 'missed';
  const stateLabel = getVoiceCallStateLabel(state, callMode);
  // 已结束/取消/拒接/未接：气泡只留状态 + 时长，不把通话转写/开场塞进小卡（转写仍在 metadata，点开记录可看）
  const showNote = !isSettled && !!note;
  const modeLabel = callMode === 'video' ? 'VIDEO CALL' : 'VOICE CALL';
  const sub = isSettled
    ? (duration ? duration : '')
    : (duration ? `${stateLabel} · ${duration}` : '');
  const pendingActions = state === 'outgoing'
    ? '<div class="voice-call-card-actions"><button type="button" class="btn btn-sm btn-primary voice-call-answer">进入</button><button type="button" class="btn btn-sm btn-outline voice-call-decline">取消</button></div>'
    : '<div class="voice-call-card-actions"><button type="button" class="btn btn-sm btn-primary voice-call-answer">接听</button><button type="button" class="btn btn-sm btn-outline voice-call-decline">挂断</button></div>';
  if (isQqCardRender(options)) {
    const retryText = state === 'missed'
      ? `${stateLabel}，点击回拨`
      : (state === 'cancelled' || state === 'declined'
        ? `${stateLabel}，点击重拨`
        : (state === 'ended' ? (duration || stateLabel) : stateLabel));
    return `
      <div class="voice-call-card qq-call-card chat-card voice-call-card--${state} voice-call-card--${callMode}" data-card-type="voice-call">
        <div class="qq-call-card-summary">
          <span class="qq-call-card-icon" aria-hidden="true">${icon(callMode === 'video' ? 'videoCallSolid' : 'voiceCallSolid')}</span>
          <span class="qq-call-card-label">${escapeHtml(retryText)}</span>
        </div>
        ${showNote ? `<div class="qq-call-card-note">${escapeHtml(note)}</div>` : ''}
        ${isPending ? pendingActions : ''}
        ${isActive ? '<div class="voice-call-card-actions"><button type="button" class="btn btn-sm btn-primary voice-call-answer">继续</button><button type="button" class="btn btn-sm btn-outline voice-call-decline">挂断</button></div>' : ''}
      </div>`;
  }
  return `
    <div class="voice-call-card chat-card chat-card--compact voice-call-card--${state} voice-call-card--${callMode}" data-card-type="voice-call">
      <div class="voice-call-card-icon" aria-hidden="true">${icon(callMode === 'video' ? 'videoCall' : 'voiceCall')}</div>
      <div class="voice-call-card-main">
        <div class="voice-call-card-kicker">${modeLabel}</div>
        <div class="voice-call-card-title">${escapeHtml(stateLabel)}</div>
        ${showNote ? `<div class="voice-call-card-note">${escapeHtml(note)}</div>` : ''}
        ${sub ? `<div class="voice-call-card-sub">${escapeHtml(sub)}</div>` : ''}
        ${isPending ? pendingActions : ''}
        ${isActive ? '<div class="voice-call-card-actions"><button type="button" class="btn btn-sm btn-primary voice-call-answer">继续</button><button type="button" class="btn btn-sm btn-outline voice-call-decline">挂断</button></div>' : ''}
      </div>
    </div>
  `;
}

function hashSeedString(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str || '').length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function splitLuckyRedPacketYuan(totalYuan, count, seedStr) {
  const n = Math.max(1, Math.min(100, Number(count) || 1));
  const cents = Math.round(Math.max(0, Number(totalYuan) || 0) * 100);
  const minC = 1;
  if (cents < n * minC) {
    const eq = Math.floor(cents / n);
    return Array(n).fill(eq / 100);
  }
  let rng = hashSeedString(seedStr || 'rp');
  const rand = () => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return (rng & 0xfffffff) / 0xfffffff;
  };
  const weights = Array.from({ length: n }, () => rand() + 0.02);
  const sumW = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => Math.floor((w / sumW) * cents));
  let diff = cents - raw.reduce((a, b) => a + b, 0);
  let i = 0;
  while (diff > 0 && i < n * 500) {
    raw[i % n] += 1;
    diff -= 1;
    i += 1;
  }
  return raw.map((c) => c / 100);
}

export function ensureLuckyRedPacketSplits(msg) {
  const m = { ...msg, metadata: { ...(msg.metadata || {}) } };
  if (m.metadata.redpacketMode !== 'lucky') return m;
  const st = m.metadata.packetState || 'pending';
  const grabN = Object.keys(m.metadata.luckyGrabs || {}).length;
  const claimN = Object.keys(m.metadata.claimRecords || {}).length;
  const claimedN = Math.max(grabN, claimN);
  const totalCnt = Math.max(1, Math.min(100, Number(m.metadata.packetCount) || 5));
  const hasSplits = Array.isArray(m.metadata.luckySplits) && m.metadata.luckySplits.length;

  // 已领完：清空残留/误重切的份数，保持终态
  if (st === 'claimed' || st === 'expired' || claimedN >= totalCnt) {
    if (hasSplits) m.metadata.luckySplits = [];
    if (st !== 'expired' && claimedN >= totalCnt) m.metadata.packetState = 'claimed';
    return m;
  }

  // 有领取记录却又出现「满额份数」= 曾被错误重切；按剩余金额/个数重建
  if (claimedN > 0 && hasSplits && m.metadata.luckySplits.length + claimedN > totalCnt) {
    const totalYuan = parseFloat(String(m.metadata.totalAmount || '8.88').replace(/[^\d.]/g, '')) || 8.88;
    const claimedSum = Object.values(m.metadata.claimRecords || {}).reduce((acc, rec) => {
      const v = parseFloat(String(rec?.amount ?? rec ?? '').replace(/[^\d.]/g, ''));
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0);
    const remainCnt = Math.max(0, totalCnt - claimedN);
    const remainYuan = Math.max(0, Math.round((totalYuan - claimedSum) * 100) / 100);
    m.metadata.luckySplits = remainCnt > 0
      ? splitLuckyRedPacketYuan(remainYuan, remainCnt, `${m.id || ''}_heal_${claimedN}`)
      : [];
    if (!remainCnt) m.metadata.packetState = 'claimed';
    return m;
  }

  if (hasSplits) return m;

  // 已有领取记录时 splits 为空是正常中间态/终态，绝不能重新切满份
  if (claimedN > 0) return m;

  const total = parseFloat(String(m.metadata.totalAmount || '8.88').replace(/[^\d.]/g, '')) || 8.88;
  m.metadata.luckySplits = splitLuckyRedPacketYuan(total, totalCnt, m.id || String(m.timestamp || ''));
  return m;
}

export function orderShareThemeClass(platform) {
  const p = String(platform || '').toLowerCase();
  if (/麦当劳|mcd/.test(p)) return 'mcd';
  if (/瑞幸|luckin/.test(p)) return 'luckin';
  if (/淘宝|天猫/.test(p)) return 'taobao';
  if (/美团|饿了么|外卖/.test(p)) return 'meituan';
  if (/京东/.test(p)) return 'jd';
  if (/拼/.test(p)) return 'pdd';
  return 'generic';
}

export function orderShareCardHtml(msg, escapeHtmlFn) {
  const esc = escapeHtmlFn;
  const isCheckout = msg.metadata?.mcpCheckout === true && !!msg.metadata?.shoppingOrderId;
  const giftFor = String(msg.metadata?.giftForName || '').trim();
  const plat = giftFor ? '礼物' : (msg.metadata?.orderPlatform || msg.metadata?.platform || '购物');
  const title = msg.metadata?.orderTitle || msg.metadata?.productTitle || msg.content || '商品';
  const price = formatOrderSharePriceDisplay(msg.metadata?.orderPrice || msg.metadata?.price || '');
  const note = msg.metadata?.orderNote || msg.metadata?.note || '';
  const imageUrl = isCheckout ? String(msg.metadata?.orderImageUrl || '').trim() : '';
  const checkoutAvailable = isCheckout && msg.metadata?.shoppingCheckoutAvailable === true;
  const theme = orderShareThemeClass(plat);
  const kicker = isCheckout ? '待支付' : (giftFor ? `送给 ${giftFor}` : 'GIFT');
  const priceRow = price
    ? `<div class="order-share-price"><span class="order-share-price-label">实付款</span><span class="order-share-price-num">${esc(price)}</span></div>`
    : '';
  const noteRow = note ? `<div class="order-share-note">${esc(note)}</div>` : '';
  return `
    <div class="order-share-card chat-card chat-card--compact order-share-card--${theme}${isCheckout ? ' is-checkout' : ''}" data-card-type="order-share"${isCheckout ? ` data-shopping-order-id="${esc(msg.metadata.shoppingOrderId)}"` : ''}>
      <div class="order-share-header">
        <span class="order-share-kicker">${esc(kicker)}</span>
        <span class="order-share-brand">${esc(plat)}</span>
      </div>
      <div class="order-share-body">
        <div class="order-share-thumb" aria-hidden="true">${icon('ordershare')}${imageUrl ? `<img src="${esc(imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-order-share-image>` : ''}</div>
        <div class="order-share-main">
          <div class="order-share-title">${esc(title)}</div>
          ${priceRow}
          ${noteRow}
        </div>
      </div>
      <div class="order-share-footer">
        <span class="order-share-linkish">${checkoutAvailable ? `前往${esc(plat)}支付` : (giftFor ? '礼物订单' : '查看订单')}</span>${icon('chevron')}
      </div>
    </div>`;
}

function resolveCardUrl(msg = {}) {
  const internalLink = resolveChatInternalLink(msg);
  if (internalLink) return internalLink.url;
  const candidates = [msg.metadata?.url, msg.metadata?.href, msg.metadata?.link, msg.content];
  for (let i = 0; i < candidates.length; i += 1) {
    const raw = String(candidates[i] || '').trim();
    if (!raw) continue;
    if (/^(weibo|forum):\/\//i.test(raw)) return raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^(www\.|[\w-]+(?:\.[\w-]+)+)/i.test(raw)) return `https://${raw.replace(/^\/+/, '')}`;
  }
  return '';
}

function resolveUrlHost(url = '') {
  try {
    return new URL(url).host.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function resolveLinkPlatformInfo(url = '', msg = {}) {
  const md = msg.metadata || {};
  if (md.platform && md.platform.id) return md.platform;
  if (md.platformId) {
    return { id: md.platformId, label: md.platformLabel || md.platformId, color: md.platformColor || '#8c7362', mono: md.platformMono || '' };
  }
  return detectLinkPlatform(url);
}

function resolveLinkBadgeLabel(url = '', msg = {}, platform = null) {
  if (platform?.label) return platform.label;
  const source = String(msg.metadata?.source || '').trim();
  return resolveUrlHost(url) || source || '链接';
}

function hexToRgbTuple(hex = '') {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 把平台色转成淡底深字的 tint 样式，跨浏览器兼容比 color-mix() 更稳 */
function tintStyle(hex = '', alpha = 0.16) {
  const rgb = hexToRgbTuple(hex);
  if (!rgb) return '';
  return `background:rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha});color:${hex};`;
}

function solidChipStyle(hex = '') {
  if (!/^#[0-9a-f]{6}$/i.test(String(hex || ''))) return '';
  return `background:${hex};color:#fff;`;
}

/** 关键词标签行：最多 6 个，纯展示 */
function linkCardKeywordsHtml(keywords, esc, className = 'link-ins-tags') {
  const list = (Array.isArray(keywords) ? keywords : []).filter(Boolean).slice(0, 6);
  if (!list.length) return '';
  return `<div class="${className}">${list.map((k) => `<span class="link-ins-tag">#${esc(k)}</span>`).join('')}</div>`;
}

function formatLinkStatCount(value = 0) {
  const n = Number(value) || 0;
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n || 0);
}

function stripHashTagsFromBody(body = '', tags = []) {
  let next = String(body || '');
  (Array.isArray(tags) ? tags : []).forEach((tag) => {
    const clean = String(tag || '').replace(/^#+/, '').trim();
    if (!clean) return;
    next = next.replace(new RegExp(`#${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#?`, 'gi'), ' ');
  });
  return next.replace(/(?:#[^\s#]{1,32}\s*){2,}$/g, ' ').replace(/\s+/g, ' ').trim();
}

function excerptLinkBody(body = '', max = 96) {
  const raw = String(body || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max).trim()}…`;
}

function pickLinkCardCopy(msg = {}, url = '') {
  return pickLinkCardDisplayCopy(msg, url);
}

function isLinkMetadataStale(msg = {}) {
  return isLinkMessageMetadataStale(msg);
}

function renderShareLinkCard({
  esc,
  url,
  host,
  platform,
  title,
  body,
  cover,
  images,
  pendingResolve,
  showMore,
  anon,
  linkOpenAttrs,
  rootTag,
  compact,
  coverEligible,
  detailAction,
}) {
  const platformId = platform?.id || 'web';
  const platformClass = ` share-link-card--${esc(platformId)}`;
  const anonClass = anon ? ' message-card' : '';

  // 普通网页/无深度解析平台既没抓到可靠封面、也没抓到正文摘要时，不放大图区、不留空摘要行，
  // 只留标题 + 来源的小卡片，占地跟一条短消息差不多。只要抓到了摘要正文（哪怕平台没有深度解析），
  // 就应该展示出来，不能因为卡瘦身把兜底出来的正文一起吞掉。
  if (compact) {
    const compactTitle = title || host || platform?.label || '网页链接';
    const compactSub = pendingResolve ? '正在解析链接…' : (host || platform?.label || '');
    const compactClasses = `${anonClass} share-link-card share-link-card--compact chat-card chat-card--link${platformClass}${pendingResolve ? ' is-pending' : ''}`.trim();
    return `
    <${rootTag} class="${compactClasses}" data-card-type="link"${linkOpenAttrs}>
      <span class="share-link-compact-icon" aria-hidden="true">${icon('link')}</span>
      <span class="share-link-compact-info">
        <span class="share-link-compact-title">${esc(compactTitle)}</span>
        ${compactSub ? `<span class="share-link-compact-host">${esc(compactSub)}</span>` : ''}
      </span>
    </${rootTag}>`;
  }

  const rootClasses = `${anonClass} share-link-card chat-card chat-card--link${platformClass}${cover ? ' has-cover' : ''}${pendingResolve ? ' is-pending' : ''}`.trim();
  const appLabel = esc(platform?.label || resolveUrlHost(url) || '链接');
  const imageCount = Math.max(images.length, cover ? 1 : 0);
  const countBadge = imageCount > 1
    ? `<span class="share-link-media-count">${esc(String(imageCount))} 图</span>`
    : '';
  const coverHtml = cover
    ? `<div class="share-link-media">${countBadge}<img class="share-link-cover" src="${esc(cover)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" /></div>`
    : (pendingResolve && coverEligible
      ? `<div class="share-link-media share-link-media--pending" aria-hidden="true"></div>`
      : '');
  const titleHtml = title ? `<h3 class="share-link-title">${esc(title)}</h3>` : '';
  const bodyHtml = body ? `<p class="share-link-text">${esc(body)}</p>` : '';
  const moreHtml = showMore ? '<div class="share-link-more">展开更多</div>' : '';
  const detailActionHtml = detailAction
    ? '<span class="share-link-detail-action" data-link-read-detail="1" role="button" tabindex="0">让角色看看</span>'
    : '';
  const footerHtml = `<div class="share-link-footer"><span class="share-link-footer-source"><span class="share-link-icon" aria-hidden="true"></span>转发自 ${appLabel}</span>${detailActionHtml}</div>`;

  return `
    <${rootTag} class="${rootClasses}" data-card-type="link"${linkOpenAttrs}>
      ${coverHtml}
      <div class="share-link-content">
        ${titleHtml}
        ${bodyHtml}
        ${moreHtml}
        ${footerHtml}
      </div>
    </${rootTag}>`;
}

/** @deprecated 内部别名，保持导出兼容 */
function renderLinkInsCard(props) {
  return renderShareLinkCard(props);
}

export function linkCardBubbleHtml(msg, escapeHtmlFn, options = {}) {
  const esc = escapeHtmlFn;
  const url = resolveCardUrl(msg);
  const host = resolveUrlHost(url);
  const isMusic = !!msg.metadata?.musicTitle;
  const platform = isMusic ? null : resolveLinkPlatformInfo(url, msg);
  const md = msg.metadata || {};
  const platformId = platform?.id || md.platformId || '';
  const { title, body, tags, pendingResolve, showMore } = pickLinkCardCopy(msg, url);
  const bodyFirst = isBodyFirstLinkPlatform(platformId);
  const displayTitle = isMusic
    ? String(md.musicTitle || '音乐分享').trim()
    : (bodyFirst ? '' : (title || (body ? text(body, 48) : '') || host || '网页链接'));
  const displayBody = isMusic
    ? (String(md.musicArtist || md.artist || '').trim() || '音乐分享')
    : body;
  const cover = String(md.coverUrl || md.imageUrl || '').trim();
  const images = Array.isArray(md.images) ? md.images.filter(Boolean) : [];
  const coverBust = String(md.resolvedNoteId || md.enhancedAt || '').trim();
  let coverSrc = cover;
  if (cover) {
    coverSrc = displaySocialImageUrl(cover, platformId);
    if (coverBust) {
      coverSrc = `${coverSrc}${coverSrc.includes('?') ? '&' : '?'}v=${encodeURIComponent(coverBust.slice(0, 24))}`;
    }
  }
  const stats = md.stats || {};
  const author = md.author || {};
  const anon = isInsNeutralCardRender(options);
  const externalUrl = /^https?:\/\//i.test(url) ? url : '';
  const internalLink = resolveChatInternalLink(msg);
  // 站内预览不再局限于这几个社媒平台白名单——原生壳的顶层 WebView 能打开任意网页
  // （ins/普通网页同样受益），具体走站内小窗还是直接甩浏览器，统一交给 openLinkPreview()
  // 自己按「原生壳/网页端 + 是否社媒」分流，这里不用重复判断，避免两边逻辑不一致。
  const previewInApp = !!externalUrl;
  const linkOpenAttrs = externalUrl
    ? (previewInApp
      ? ` href="${esc(externalUrl)}" data-link-preview="1" role="link"`
      : ` href="${esc(externalUrl)}" target="_blank" rel="noopener noreferrer" data-link-open="1"`)
    : (internalLink ? ' data-link-internal="1" role="link" tabindex="0"' : '');
  const rootTag = externalUrl ? 'a' : 'div';
  const detailAction = platformId === 'taobao'
    && msg.senderId === 'user'
    && md.screenshotFallback !== true;

  if (isMusic) {
    return renderShareLinkCard({
      esc,
      url,
      host,
      platform: { id: 'music', label: '音乐', color: '#111' },
      title: displayTitle,
      body: displayBody,
      cover: coverSrc,
      images,
      pendingResolve: false,
      showMore: false,
      anon,
      linkOpenAttrs,
      rootTag,
      compact: false,
      coverEligible: true,
    });
  }

  const richCover = LINK_RICH_COVER_PLATFORMS.has(platformId);
  // 有没有摘要正文才是决定瘦身与否的标准，不是平台白名单：深度解析平台之外的链接
  // （抖音/YouTube/普通网页等）一样可能靠本地分享文案、OG 抓取或联网摘要拿到正文，
  // 拿到了就该展示；真的什么都没抓到时才收成纯图标小卡。
  const hasSummaryText = !!String(displayBody || '').trim();
  const compact = !richCover && !hasSummaryText;

  return renderShareLinkCard({
    esc,
    url,
    host,
    platform: platform || { id: 'web', label: host || '网页', color: '#8d8d92' },
    title: title || displayTitle,
    body: displayBody,
    cover: richCover ? coverSrc : '',
    images: richCover ? images : [],
    pendingResolve,
    showMore,
    anon,
    linkOpenAttrs,
    rootTag,
    compact,
    coverEligible: richCover,
    detailAction,
  });
}

function text(value = '', max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function locationCardBubbleHtml(msg, escapeHtmlFn, options = {}) {
  const esc = escapeHtmlFn;
  const name = String(msg.metadata?.locationName || msg.metadata?.label || msg.content || '位置').trim();
  const addr = String(msg.metadata?.address || msg.metadata?.detail || '').trim();
  if (isQqCardRender(options)) {
    return `
    <div class="location-card qq-location-card chat-card chat-card--location" data-card-type="location">
      <div class="location-card-info">
        <div class="location-card-title">${esc(name || '位置')}</div>
        <div class="location-card-desc">${addr ? esc(addr) : '共享位置'}</div>
      </div>
      <div class="location-card-map" aria-hidden="true">
        <span class="location-card-route"></span>
        <span class="location-card-pin"></span>
      </div>
    </div>`;
  }
  if (isInsNeutralCardRender(options)) {
    return `
    <div class="message-card location-card chat-card chat-card--compact chat-card--location" data-card-type="location">
      <div class="location-card-map" aria-hidden="true">
        <span class="location-card-route"></span>
        <span class="location-card-pin"></span>
      </div>
      <div class="location-card-info">
        <div class="location-card-kicker">SHARED PLACE</div>
        <div class="location-card-title">${esc(name || '位置')}</div>
        <div class="location-card-desc">${addr ? esc(addr) : '共享位置'}</div>
      </div>
    </div>`;
  }
  return `
    <div class="location-card chat-card chat-card--compact chat-card--location" data-card-type="location">
      <div class="location-card-map" aria-hidden="true">
        <span class="location-card-route"></span>
        <span class="location-card-pin"></span>
      </div>
      <div class="location-card-info">
        <div class="location-card-kicker">SHARED PLACE</div>
        <div class="location-card-title">${esc(name || '位置')}</div>
        <div class="location-card-desc">${addr ? esc(addr) : '共享位置'}</div>
      </div>
    </div>`;
}

function resolveDiceResult(msg = {}) {
  const metaResult = Number(msg.metadata?.result || 0);
  if (metaResult > 0) return metaResult;
  const m = String(msg.content || '').match(/\d+/);
  return m ? Number(m[0]) : 0;
}

export function diceCardBubbleHtml(msg, escapeHtmlFn, options = {}) {
  const esc = escapeHtmlFn;
  const sides = Number(msg.metadata?.sides || 6) || 6;
  const result = resolveDiceResult(msg);
  if (isQqCardRender(options)) {
    const pipCount = Math.max(0, Math.min(6, result));
    const pips = Array.from({ length: pipCount }, (_, idx) => `<i class="qq-dice-pip qq-dice-pip--${idx + 1}"></i>`).join('');
    return `
      <div class="qq-dice-emote" data-card-type="dice" role="img" aria-label="骰子 ${esc(result ? String(result) : '未知')}">
        <span class="qq-dice-cube qq-dice-cube--${esc(result ? String(result) : 'unknown')}">${pips || '<b>?</b>'}</span>
      </div>`;
  }
  return `
    <div class="dice-card chat-card chat-card--compact chat-card--dice" data-card-type="dice">
      <div class="dice-card-face">${icon('dice')}<strong>${esc(result ? String(result) : '?')}</strong></div>
      <div class="dice-card-info">
        <div class="dice-card-kicker">DICE · D${esc(String(sides))}</div>
        <div class="dice-card-title">掷骰</div>
        <div class="dice-card-desc">结果 ${esc(result ? String(result) : '?')}</div>
      </div>
    </div>`;
}

export function formatTransferAmountForCard(msg) {
  const raw = String(msg.metadata?.amount ?? msg.content ?? '').trim();
  if (!raw) return '¥0.00';
  const noYen = raw.replace(/^\s*¥\s*/u, '').trim();
  if (/^\d+(\.\d+)?$/.test(noYen)) {
    const n = Number(noYen);
    return Number.isFinite(n) ? `¥${n.toFixed(2)}` : `¥${noYen}`;
  }
  if (/^¥/.test(raw)) return raw;
  return `¥${noYen}`;
}

function getTransferStateLabel(msg) {
  const st = msg.metadata?.transferState || 'pending';
  return st === 'accepted' ? '已收款' : st === 'returned' ? '已退回' : '待确认';
}

export function getRedPacketState(msg) {
  const mode = msg.metadata?.redpacketMode || 'normal';
  if (mode === 'lucky') {
    const md = msg.metadata || {};
    if (md.packetState === 'claimed' || md.packetState === 'expired') {
      return { key: 'done', label: '已领完' };
    }
    const splits = Array.isArray(md.luckySplits) ? md.luckySplits : [];
    const grabs = md.luckyGrabs && typeof md.luckyGrabs === 'object' ? md.luckyGrabs : {};
    const records = md.claimRecords && typeof md.claimRecords === 'object' ? md.claimRecords : {};
    const nGrab = Math.max(Object.keys(grabs).length, Object.keys(records).length);
    const total = Math.max(1, Number(md.packetCount) || 1);
    if (nGrab >= total) return { key: 'done', label: '已领完' };
    if (splits.length === 0 && nGrab > 0) return { key: 'done', label: '已领完' };
    if (splits.length === 0 && nGrab === 0) {
      return { key: 'open', label: `${total}个待领` };
    }
    return { key: 'open', label: `剩${splits.length}个` };
  }
  if (mode === 'exclusive') {
    const claimed = !!msg.metadata?.exclusiveClaimed;
    return { key: claimed ? 'done' : 'open', label: claimed ? '已领取' : '可领取' };
  }
  const ps = msg.metadata?.packetState || 'pending';
  if (ps === 'claimed') return { key: 'done', label: '已领取' };
  if (ps === 'expired') return { key: 'done', label: '已过期' };
  return { key: 'open', label: '可领取' };
}

function getRedPacketSubtext(msg, esc) {
  const mode = msg.metadata?.redpacketMode || 'normal';
  if (mode === 'lucky') {
    return `共 ${esc(String(msg.metadata?.totalAmount || ''))} 元 · ${esc(String(msg.metadata?.packetCount || ''))} 个`;
  }
  if (mode === 'exclusive') {
    return `¥${esc(String(msg.metadata?.exclusiveAmount || ''))} → ${esc(String(msg.metadata?.exclusiveTargetId || ''))}`;
  }
  const amt = msg.metadata?.amount || msg.metadata?.totalAmount || '';
  if (amt) return `¥${esc(String(amt))}`;
  return '';
}

function getTextImageBody(msg) {
  return String(msg.metadata?.text || msg.metadata?.caption || msg.content || '').trim();
}

function splitTextImageLines(msg) {
  const body = getTextImageBody(msg);
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines : (body ? [body] : []);
}

function isInsNeutralCardRender(options = {}) {
  return !!options.anonymous || !!options.insCard;
}

function textImagePolaroidHtml(msg, escapeHtmlFn, options = {}) {
  const esc = escapeHtmlFn;
  const lines = splitTextImageLines(msg);
  const isDetail = !!options.detail;
  const hasCaption = lines.length > 1;
  const photoLines = hasCaption ? lines.slice(1) : lines;
  const caption = hasCaption ? lines[0] : '';
  const visiblePhotoLines = isDetail ? photoLines : photoLines.slice(0, 4);
  const photoHtml = visiblePhotoLines.length
    ? visiblePhotoLines.map((line) => `<p class="textimg-polaroid-line">${esc(line)}</p>`).join('')
    : '<p class="textimg-polaroid-line textimg-polaroid-line--placeholder">&nbsp;</p>';
  const captionHtml = caption
    ? `<div class="textimg-polaroid-caption"><div class="textimg-polaroid-title">${esc(caption)}</div></div>`
    : '<div class="textimg-polaroid-caption is-empty" aria-hidden="true"></div>';
  const detailClass = isDetail ? ' textimg-polaroid--detail' : '';
  return `
      <div class="message-card textimg-polaroid chat-card${detailClass}" data-card-type="textimg" data-textimg-lines="${Math.max(lines.length, 1)}">
        <div class="textimg-polaroid-sheet">
          <span class="textimg-polaroid-tape" aria-hidden="true"></span>
          <div class="textimg-polaroid-photo">
            <div class="textimg-polaroid-text">${photoHtml}</div>
          </div>
          ${captionHtml}
        </div>
      </div>`;
}

export function textImageBubbleHtml(msg, escapeHtmlFn, options = {}) {
  if (isInsNeutralCardRender(options)) {
    return textImagePolaroidHtml(msg, escapeHtmlFn, options);
  }
  const esc = escapeHtmlFn;
  const lines = splitTextImageLines(msg);
  const title = lines[0] || '文字图片';
  const previewLinesLegacy = lines.slice(1, 4);
  const preview = previewLinesLegacy.length ? previewLinesLegacy.map((line) => `<div class="textimg-card-line">${esc(line)}</div>`).join('') : '<div class="textimg-card-line textimg-card-line--empty">　</div>';
  return `
        <div class="textimg-sheet-card chat-card" data-card-type="textimg" data-textimg-lines="${Math.max(lines.length, 1)}">
          <div class="textimg-sheet-topbar">
            <span class="textimg-sheet-dot"></span>
            <span class="textimg-sheet-dot"></span>
            <span class="textimg-sheet-dot"></span>
          </div>
          <div class="textimg-sheet-body">
            <div class="textimg-sheet-title">${esc(title)}</div>
            <div class="textimg-sheet-preview">${preview}</div>
          </div>
        </div>`;
}

export function textImageDetailHtml(msg, escapeHtmlFn, options = {}) {
  if (isInsNeutralCardRender(options)) {
    return textImagePolaroidHtml(msg, escapeHtmlFn, { ...options, detail: true });
  }
  const esc = escapeHtmlFn;
  const lines = splitTextImageLines(msg);
  const title = lines[0] || '文字图片';
  const bodyLines = lines.slice(1);
  const renderedBody = (bodyLines.length ? bodyLines : [getTextImageBody(msg) || ''])
    .map((line) => `<div class="textimg-detail-line">${esc(line || '　')}</div>`)
    .join('');
  return `
    <div class="textimg-detail-card">
      <div class="textimg-detail-paper">
        <div class="textimg-detail-pin"></div>
        <div class="textimg-detail-title">${esc(title)}</div>
        <div class="textimg-detail-body">${renderedBody}</div>
      </div>
    </div>`;
}

export function transferCardBubbleHtml(msg, escapeHtmlFn, options = {}) {
  const esc = escapeHtmlFn;
  const amount = formatTransferAmountForCard(msg);
  const tn = msg.metadata?.transferNote || msg.metadata?.note;
  const st = msg.metadata?.transferState || 'pending';
  const stateLabel = getTransferStateLabel(msg);
  const receiptClass = options.transferReceipt ? ' transfer-receipt-card' : '';
  const receiptAttr = options.transferReceipt ? ' data-transfer-receipt="accepted"' : '';
  if (isQqCardRender(options)) {
    const stateClass = st === 'accepted' ? 'transfer-card--accepted' : st === 'returned' ? 'transfer-card--returned' : 'transfer-card--pending';
    const noteLine = tn ? `<span><span>${esc(tn)}</span></span>` : '';
    return `
      <div class="message-card transfer-card${receiptClass} qq-transfer-card chat-card ${stateClass}" data-card-type="transfer"${receiptAttr} data-transfer-state="${esc(st)}">
        <div class="transfer-main qq-transfer-main">
          <span class="transfer-mark qq-transfer-mark" aria-hidden="true">¥</span>
          <span class="qq-transfer-copy"><strong>${esc(amount)}</strong>${noteLine}</span>
        </div>
        <div class="transfer-foot qq-transfer-foot"><span>QQ转账</span><span>${esc(stateLabel)}</span></div>
      </div>`;
  }
  if (isInsNeutralCardRender(options)) {
    const noteLine = tn ? `<span><span>${esc(tn)}</span></span>` : '';
    return `
      <div class="message-card transfer-card${receiptClass} chat-card transfer-card--${esc(st)}" data-card-type="transfer"${receiptAttr} data-transfer-state="${esc(st)}">
        <div class="transfer-main">
          <div class="transfer-mark" aria-hidden="true">¥</div>
          <div>
            <strong>${esc(amount)}</strong>
            ${noteLine}
          </div>
        </div>
        <div class="transfer-foot"><span>转账</span><span>${esc(stateLabel)}</span></div>
      </div>`;
  }
  const noteHtml = tn ? `<div class="transfer-card-note">${esc(tn)}</div>` : '';
  const stateClass = st === 'accepted' ? 'transfer-card--accepted' : st === 'returned' ? 'transfer-card--returned' : 'transfer-card--pending';
  return `
        <div class="transfer-card${receiptClass} chat-card ${stateClass}" data-card-type="transfer"${receiptAttr} data-transfer-state="${esc(st)}">
          <div class="transfer-card-inner">
            <div class="transfer-card-header">
              <div class="transfer-card-main">
                <div class="transfer-card-amount">${esc(amount)}</div>
                ${noteHtml}
              </div>
            </div>
            <div class="transfer-card-footer"><span>转账</span><span>${esc(stateLabel)}</span></div>
          </div>
        </div>`;
}

export function transferReceiptCardHtml(msg, escapeHtmlFn, options = {}) {
  const normalized = {
    ...msg,
    type: 'transfer',
    metadata: {
      ...(msg.metadata || {}),
      transferNote: '已收款',
      transferState: 'accepted',
    },
  };
  return transferCardBubbleHtml(normalized, escapeHtmlFn, { ...options, transferReceipt: true });
}

export function transferCardDetailHtml(msg, escapeHtmlFn, options = {}) {
  const esc = escapeHtmlFn;
  const amount = formatTransferAmountForCard(msg);
  const stateLabel = getTransferStateLabel(msg);
  const note = String(msg.metadata?.transferNote || '').trim();
  return `
    <div class="finance-detail-wrap finance-detail-wrap--transfer">
      ${transferCardBubbleHtml(msg, escapeHtmlFn, options)}
      <div class="finance-detail-meta">
        <div class="finance-detail-row"><span>状态</span><strong>${esc(stateLabel)}</strong></div>
        <div class="finance-detail-row"><span>金额</span><strong>${esc(amount)}</strong></div>
        ${note ? `<div class="finance-detail-note">备注：${esc(note)}</div>` : ''}
      </div>
    </div>`;
}

export function redPacketBubbleHtml(msg, escapeHtmlFn, options = {}) {
  const esc = escapeHtmlFn;
  const greet = msg.metadata?.greeting || msg.content || '恭喜发财';
  const { key: stateKey, label: stateLabel } = getRedPacketState(msg);
  const sub = getRedPacketSubtext(msg, esc);
  if (isQqCardRender(options)) {
    const sealText = stateKey === 'done' ? '✓' : '開';
    return `
      <div class="red-packet-card qq-red-packet-card qq-red-packet-card--${esc(stateKey)}" data-card-type="redpacket" data-rp-state="${esc(stateKey)}">
        <div class="qq-red-packet-cover">
          <strong class="qq-red-packet-greeting">${esc(greet)}</strong>
          ${stateKey === 'done' && sub ? `<span class="qq-red-packet-sub">${sub}</span>` : ''}
          <span class="qq-red-packet-seal" aria-hidden="true">${sealText}</span>
        </div>
        <span class="sr-only">${esc(stateLabel)}</span>
      </div>`;
  }
  if (isInsNeutralCardRender(options)) {
    const subLine = sub || greet;
    return `
      <div class="message-card anon-rp-card chat-card red-packet-card red-packet-card--${esc(stateKey)}" data-card-type="redpacket" data-rp-state="${esc(stateKey)}">
        <div class="anon-rp-main">
          <div class="anon-rp-icon" aria-hidden="true">¥</div>
          <div class="anon-rp-copy">
            <div class="anon-rp-title">${esc(msg.metadata?.title || '红包')}</div>
            <div class="anon-rp-greet">${esc(greet)}</div>
            ${sub && sub !== greet ? `<div class="anon-rp-sub">${sub}</div>` : ''}
          </div>
        </div>
        <div class="transfer-foot"><span>红包</span><span>${esc(stateLabel)}</span></div>
      </div>`;
  }
  const modClass = stateKey === 'done' ? 'red-packet-card--done' : 'red-packet-card--open';
  return `
        <div class="red-packet-card chat-card ${modClass}" data-card-type="redpacket" data-rp-state="${esc(stateKey)}">
          <div class="red-packet-cover">
            <div class="red-packet-seal" aria-hidden="true">¥</div>
            <div class="red-packet-main">
              <div class="red-packet-title">${esc(msg.metadata?.title || '红包')}</div>
              <div class="red-packet-greeting">${esc(greet)}</div>
              ${sub ? `<div class="red-packet-sub">${sub}</div>` : ''}
            </div>
          </div>
          <div class="red-packet-footer"><span>棉花糖红包</span><span>${esc(stateLabel)}</span></div>
        </div>`;
}

export function redPacketDetailHtml(msg, escapeHtmlFn, options = {}) {
  const esc = escapeHtmlFn;
  const greet = msg.metadata?.greeting || msg.content || '恭喜发财';
  const { label: stateLabel } = getRedPacketState(msg);
  const sub = getRedPacketSubtext(msg, esc);
  return `
    <div class="finance-detail-wrap finance-detail-wrap--redpacket">
      ${redPacketBubbleHtml(msg, escapeHtmlFn, options)}
      <div class="finance-detail-meta">
        <div class="finance-detail-row"><span>状态</span><strong>${esc(stateLabel)}</strong></div>
        <div class="finance-detail-row"><span>祝福语</span><strong>${esc(greet)}</strong></div>
        ${sub ? `<div class="finance-detail-note">${sub}</div>` : ''}
      </div>
    </div>`;
}

/** 合并转发条目的短标签：非文本类型只给占位符，绝不把 base64/URL 原文漏出去 */
export function chatBundleItemLabel(item = {}) {
  const type = String(item.type || 'text');
  if (type === 'image') return '[图片]';
  if (type === 'voice' || type === 'voiceCall') return '[语音]';
  if (type === 'sticker') return '[表情]';
  if (type === 'textimg') return '[文字图]';
  if (type === 'link') return '[链接]';
  if (type === 'location') return '[位置]';
  return String(item.content || '').trim();
}

export function chatBundleBubbleHtml(msg, escapeHtmlFn, options = {}) {
  const esc = escapeHtmlFn;
  const items = Array.isArray(msg.metadata?.items)
    ? msg.metadata.items
    : (Array.isArray(msg.metadata?.bundleItems) ? msg.metadata.bundleItems : []);
  const fromLab = String(msg.metadata?.fromChatLabel || '').trim();
  const title = String(msg.metadata?.bundleTitle || '聊天记录').trim() || '聊天记录';
  const unresolved = !!msg.metadata?.unresolvedRelayBundle;
  const previewLines = items
    .slice(0, 3)
    .map((it) => {
      const name = bundleSenderLabel(it, options);
      const text = applyDisplayRegex(chatBundleItemLabel(it), 'chat', {
        placement: it.senderId === 'user' ? 1 : 2,
        macros: { user: options.currentUserName || '用户', char: it.senderName || name || '角色' },
      });
      if (!name && !text) return '';
      const source = String(it.metadata?.text || it.metadata?.transcript || it.content || '').trim();
      const translated = sanitizeAiTranslation(source, it.metadata?.translation || it.translation) || '';
      const self = String(it.senderId || '') === 'user';
      return `<div class="chat-bundle-card-line ${self ? 'is-self' : 'is-other'}">
        ${name ? `<span>${esc(name)}</span>` : ''}
        <em>${esc(text)}${translated ? '<small>含译文</small>' : ''}</em>
      </div>`;
    })
    .filter(Boolean)
    .join('');
  const fallbackPreview = !previewLines && unresolved
    ? '<div class="chat-bundle-card-line">聊天记录</div>'
    : previewLines;
  const footNote = items.length
    ? `共 ${items.length} 条${fromLab ? ` · 来自「${fromLab}」` : ''}`
    : (fromLab ? `来自「${fromLab}」` : '聊天记录');
  const anonClass = isInsNeutralCardRender(options) ? ' message-card' : '';
  const platformClass = isQqCardRender(options) ? ' chat-bundle-card--qq' : '';
  return `
      <div class="chat-card chat-bundle-card${anonClass}${platformClass}" data-card-type="chat-bundle" aria-label="查看聊天记录">
        <div class="chat-bundle-card-main">
          <div class="chat-bundle-card-title">${esc(title)}</div>
          ${fallbackPreview ? `<div class="chat-bundle-card-preview">${fallbackPreview}</div>` : ''}
        </div>
        <div class="chat-bundle-card-foot"><span>聊天记录</span><span>${esc(footNote)}</span></div>
      </div>
    `;
}

export function voteCardBubbleHtml(msg, escapeHtmlFn) {
  const esc = escapeHtmlFn;
  const title = String(msg.metadata?.voteTitle || msg.content || '投票').trim();
  const opts = Array.isArray(msg.metadata?.voteOptions) ? msg.metadata.voteOptions : [];
  const counts = msg.metadata?.voteCounts && typeof msg.metadata.voteCounts === 'object'
    ? msg.metadata.voteCounts
    : {};
  const closed = !!msg.metadata?.voteClosed;
  const optsHtml = opts.map((opt, idx) => {
    const key = String(opt);
    const n = Number(counts[key] || counts[idx] || 0);
    return `<div class="vote-card-opt" data-vote-idx="${idx}">${esc(key)}${n ? ` (${n})` : ''}</div>`;
  }).join('');
  return `
    <div class="chat-card vote-card" data-card-type="vote" data-vote-closed="${closed ? '1' : '0'}">
      <div class="vote-card-title">${icon('vote')}<span>${esc(title)}</span></div>
      <div class="vote-card-opts">${optsHtml || '<div class="vote-card-opt">暂无选项</div>'}</div>
      ${closed ? '<div class="vote-card-foot">投票已结束</div>' : '<div class="vote-card-foot">点击选项投票</div>'}
    </div>`;
}

export function offlineInviteCardHtml(msg, escapeHtmlFn) {
  const esc = escapeHtmlFn;
  const md = msg?.metadata || {};
  const fromChar = md.inviteFrom === 'character';
  const isGroupInvite = md.isGroupInvite === true;
  const arrived = md.arrived === true;
  const transitionPhase = String(md.transitionPhase || '').trim();
  const toUserPlace = md.toUserPlace === true;
  const status = String(md.status || 'pending');
  const place = String(md.place || '').trim();
  const activity = String(md.activity || '').trim();
  const timeLabel = String(md.timeLabel || '').trim();
  const note = String(md.note || msg?.content || '').trim();
  const metaLine = [timeLabel, place].filter(Boolean).join(' · ');
  const routeSummary = String(md.route?.summary || '').trim();
  const initiatorName = String(md.initiatorName || msg?.senderName || '').trim();
  const inviteeNames = Array.isArray(md.inviteeNames) ? md.inviteeNames.filter(Boolean) : [];
  const groupResponses = Array.isArray(md.groupResponses) ? md.groupResponses : [];
  const declineReason = String(md.declineReason || '').trim();

  const inviteeChipsHtml = inviteeNames.length
    ? `<div class="offline-invite-card-invitees">${inviteeNames.map((name) => `<span class="offline-invite-invitee-chip">${esc(name)}</span>`).join('')}</div>`
    : '';

  const responsesHtml = groupResponses.length
    ? `<div class="offline-invite-card-responses${status === 'resolving' ? ' is-loading' : ''}">
        ${groupResponses.map((item) => {
          const attending = item?.attending !== false;
          const name = resolveActorDisplayLabel(item?.name || item?.id, { fallback: '成员' });
          const reaction = String(item?.reaction || '').trim();
          return `<div class="offline-invite-response${attending ? ' is-attending' : ' is-skip'}">
            <span class="offline-invite-response-avatar" aria-hidden="true">${esc(name.slice(0, 1) || '?')}</span>
            <span class="offline-invite-response-body">
              <strong>${esc(name)}</strong>${attending ? '<em>赴约</em>' : '<em>不去</em>'}
              ${reaction ? `<small>${esc(reaction)}</small>` : ''}
            </span>
          </div>`;
        }).join('')}
      </div>`
    : (status === 'resolving'
      ? '<div class="offline-invite-card-responses is-loading"><div class="offline-invite-card-status">正在看大家的反应…</div></div>'
      : '');

  const charActions = isGroupInvite
    ? '<div class="offline-invite-card-actions offline-invite-card-actions--double"><button type="button" class="offline-invite-accept">赴约</button><button type="button" class="offline-invite-decline">婉拒</button></div>'
    : '<div class="offline-invite-card-actions offline-invite-card-actions--triple"><button type="button" class="offline-invite-accept">接受</button><button type="button" class="offline-invite-shelve">暂时搁置</button><button type="button" class="offline-invite-decline">婉拒</button></div>';

  let footer;
  if (status === 'merged') {
    footer = '<div class="offline-invite-card-status">TA 被你叫来现场汇合了，这场线下继续</div>';
  } else if (status === 'declined') {
    footer = `<div class="offline-invite-card-status is-declined">${declineReason ? `已婉拒：${esc(declineReason)}` : '这次先婉拒了'}</div>${responsesHtml}`;
  } else if (status === 'others_went') {
    footer = `<div class="offline-invite-card-status is-shelved">你没去，他们还是去了</div>${responsesHtml}`;
  } else if (status === 'fulfilled') {
    footer = `${responsesHtml}<div class="offline-invite-card-status">这次见面已经结束并收进共同回忆</div>`;
  } else if (status === 'accepted') {
    footer = `${responsesHtml}<div class="offline-invite-card-actions"><button type="button" class="offline-invite-enter">进入线下沉浸 ›</button></div>`;
  } else if (fromChar && status === 'shelved') {
    footer = `<div class="offline-invite-card-status is-shelved">先搁着了，想好了再回 TA</div>${isGroupInvite ? charActions : `${charActions}`}`;
  } else if (fromChar) {
    footer = `${inviteeChipsHtml}${charActions}`;
  } else {
    footer = '<div class="offline-invite-card-actions"><button type="button" class="offline-invite-enter">进入线下沉浸 ›</button></div>';
  }

  const headText = arrived
    ? 'TA 已经到了'
    : (transitionPhase === 'approaching'
      ? 'TA 正在来见你的路上'
      : (transitionPhase === 'agreed'
        ? '这次见面已经说定'
    : (isGroupInvite
      ? `${initiatorName || 'TA'} 发起了群聚邀约`
      : (toUserPlace ? 'TA 要出门来找你' : (fromChar ? 'TA 想约你出门' : '你递出的邀约')))));

  return `
    <div class="offline-invite-card chat-card offline-invite-card--${esc(status)}${isGroupInvite ? ' offline-invite-card--group' : ''}" data-card-type="offline-invite">
      <div class="offline-invite-card-ribbon">${isGroupInvite ? '群聚邀约' : '线下邀约'}</div>
      <div class="offline-invite-card-paper">
        <div class="offline-invite-card-head">${esc(headText)}</div>
        ${metaLine ? `<div class="offline-invite-card-meta">${esc(metaLine)}</div>` : ''}
        ${activity ? `<div class="offline-invite-card-act">${esc(activity)}</div>` : ''}
        ${note ? `<div class="offline-invite-card-note">${esc(note)}</div>` : ''}
        ${routeSummary ? `<div class="offline-invite-card-route">${icon('pin')}<span>${esc(routeSummary)}</span></div>` : ''}
        ${footer}
      </div>
    </div>`;
}

export function groupInviteUserCardHtml(msg, escapeHtmlFn) {
  const esc = escapeHtmlFn;
  const md = msg?.metadata || {};
  const status = String(md.status || 'pending');
  const inviterName = String(md.inviterName || msg?.senderName || '').trim();
  const note = String(md.note || msg?.content || '').trim();
  let footer;
  if (status === 'declined') {
    footer = '<div class="group-invite-card-status is-declined">这次先不加入</div>';
  } else if (status === 'accepted') {
    footer = '<div class="group-invite-card-status is-accepted">已加入这个群聊</div>';
  } else {
    footer = '<div class="group-invite-card-actions"><button type="button" class="group-invite-accept">加入群聊</button><button type="button" class="group-invite-decline">不用了</button></div>';
  }
  return `
    <div class="group-invite-card chat-card group-invite-card--${esc(status)}" data-card-type="group-invite">
      <div class="group-invite-card-ribbon">邀请</div>
      <div class="group-invite-card-body">
        <div class="group-invite-card-head">${inviterName ? `${esc(inviterName)} 想拉你进这个群` : '有人想拉你进这个群'}</div>
        ${note ? `<div class="group-invite-card-note">${esc(note)}</div>` : ''}
        ${footer}
      </div>
    </div>`;
}

export function npcCardBubbleHtml(msg, escapeHtmlFn) {
  const esc = escapeHtmlFn;
  const md = msg?.metadata || {};
  const npcName = String(md.npcName || msg?.content || '').trim() || '神秘的人';
  const npcBio = String(md.npcBio || '').trim();
  const relation = String(md.relation || '').trim();
  const addedContactId = String(md.addedContactId || '').trim();
  const isAnonymousReveal = !!String(md.anonymousRevealActorId || '').trim();
  const footer = addedContactId
    ? `<div class="npc-card-actions"><button type="button" class="npc-card-view" data-contact-id="${esc(addedContactId)}">已加入 · 查看</button></div>`
    : `<div class="npc-card-actions"><button type="button" class="npc-card-add">${isAnonymousReveal ? '确认相认 · 加入通讯录' : '加入通讯录'}</button></div>`;
  return `
    <div class="npc-card chat-card" data-card-type="npc-card">
      <div class="npc-card-ribbon">${isAnonymousReveal ? '相认' : '名片'}</div>
      <div class="npc-card-body">
        <div class="npc-card-head">
          <span class="npc-card-avatar">${icon('roleSay')}</span>
          <div class="npc-card-headtext">
            <div class="npc-card-name">${esc(npcName)}</div>
            ${relation ? `<div class="npc-card-relation">${esc(relation)}</div>` : ''}
          </div>
        </div>
        ${npcBio ? `<div class="npc-card-bio">${esc(npcBio)}</div>` : ''}
        ${footer}
      </div>
    </div>`;
}

function stripMimickedContextPrefixes(text) {
  return String(text || '')
    .replace(/^\[[^\]]+\][：:]\s*/gm, '')
    .trim();
}

const INNER_VOICE_SOURCE =
  '(?:\\[|［|【)\\s*(?:心声|心聲)\\s*(?:\\]|］|】)(?!\\s*[：:﹕][^\\n\\r]{1,20}\\s*(?:\\]|］|】))\\s*(?:[：:﹕]\\s*)?([^\\n\\r]*)';
const INNER_VOICE_WITH_OWNER_SOURCE =
  '(?:\\[|［|【)\\s*(?:心声|心聲)\\s*[：:﹕]\\s*([^\\]］】\\n\\r]{1,20})\\s*(?:\\]|］|】)\\s*(?:[：:﹕]\\s*)?([^\\n\\r]*)';
const INNER_VOICE_PAREN_SOURCE =
  '(?:\\(|（)\\s*(?:心声|心聲)\\s*(?:[：:﹕]\\s*)?([^\\)）\\n\\r]*)(?:\\)|）)';
const HIDDEN_INTENT_SOURCE =
  '(?:\\[|［|【)\\s*(?:意图|意圖|意向|动机|動機|潜台词|潛台詞|心理备注|心理備註|心理OS|备注|備註)\\s*(?:\\]|］|】)\\s*(?:[：:﹕]\\s*)?([^\\n\\r]*)';
const HIDDEN_INTENT_DOUBLE_SOURCE =
  '(?:\\[\\[)\\s*(?:意图|意圖|意向|动机|動機|潜台词|潛台詞|心理备注|心理備註|心理OS|备注|備註)\\s*(?:\\]\\])\\s*(?:[：:﹕]\\s*)?([^\\n\\r]*)';
const HIDDEN_STATUS_SOURCE =
  '(?:\\[|［|【)\\s*(?:状态|狀態|动作状态|動作狀態)(?:\\s*[：:﹕]\\s*([^\\]］】\\n\\r]*))?\\s*(?:\\]|］|】)\\s*(?:[：:﹕]\\s*)?([^\\n\\r]*)';
const HIDDEN_MOOD_SOURCE =
  '(?:\\[|［|【)\\s*(?:情绪|情緒|本轮情绪|本輪情緒)(?:\\s*[：:﹕]\\s*([^\\]］】\\n\\r]*))?\\s*(?:\\]|］|】)\\s*(?:[：:﹕]\\s*)?([^\\n\\r]*)';
const HIDDEN_ACTION_SOURCE =
  '(?:\\[|［|【)\\s*(?:动作|動作|正在做什么|正在做什麼|当前动作|當前動作|当前在做什么|當前在做什麼)\\s*(?:\\]|］|】)\\s*(?:[：:﹕]\\s*)?([^\\n\\r]*)';

function stripInnerVoiceTagsToBucket(raw, innerParts) {
  return String(raw || '').replace(new RegExp(INNER_VOICE_SOURCE, 'gi'), (_, g1) => {
    const t = String(g1 || '').trim();
    if (t) innerParts.push(t);
    return '';
  });
}

function stripInnerVoiceWithOwnerToBucket(raw, innerParts) {
  return String(raw || '').replace(new RegExp(INNER_VOICE_WITH_OWNER_SOURCE, 'gi'), (_, owner, tail) => {
    const o = String(owner || '').trim();
    const t = String(tail || '').trim().replace(/^[：:﹕]\s*/, '');
    if (o && t) innerParts.push(`心声（${o}）：${t}`);
    else if (o) innerParts.push(`心声（${o}）`);
    else if (t) innerParts.push(`心声：${t}`);
    return '';
  });
}

function stripParenInnerVoiceToBucket(raw, innerParts) {
  return String(raw || '').replace(new RegExp(INNER_VOICE_PAREN_SOURCE, 'gi'), (_, g1) => {
    const t = String(g1 || '').trim();
    if (t) innerParts.push(t);
    return '';
  });
}

function stripIntentBracketLabelThenVoiceToBucket(raw, innerParts) {
  return String(raw || '').replace(
    /(?:(?:\[|［)([^\]\n\r]{1,20})(?:\]|］)\s*)?(?:\[|［)\s*(?:意图|意圖)\s*[：:]\s*([^\]\n\r]+)\]\s*([^\n\r]+)/g,
    (full, speaker, label, tail, offset, source) => {
      const t = String(tail || '').trim();
      const lab = String(label || '').trim();
      const sp = String(speaker || '').trim();
      if (!t || !lab) return full;
      const before = String(source || '').slice(0, Number(offset) || 0);
      const hasPublicBefore = !!before.trim();
      innerParts.push(`意图（${lab}）：${t}`);
      return hasPublicBefore && !sp ? '' : '';
    },
  );
}

function stripIntentWithRoleParenToBucket(raw, innerParts) {
  const push = (summary, role) => {
    const r = String(role || '').trim();
    const s = String(summary || '').trim();
    if (r && s) innerParts.push(`意图（${r}）：${s}`);
    else if (r) innerParts.push(`意图（${r}）`);
    else if (s) innerParts.push(`意图：${s}`);
  };
  let out = String(raw || '');
  out = out.replace(
    /(?:\[|［)\s*(?:意图|意圖)\s*[：:]\s*([\s\S]*?)（([^）]+)）\s*(?:\]|］)/g,
    (_, sum, role) => {
      push(sum, role);
      return '';
    },
  );
  out = out.replace(
    /(?:\[|［)\s*(?:意图|意圖)\s*[：:]\s*([\s\S]*?)\(([^)\n\r]+)\)\s*(?:\]|］)/g,
    (_, sum, role) => {
      push(sum, role);
      return '';
    },
  );
  return out;
}

function stripHiddenIntentToBucket(raw, innerParts, actionParts, moodParts) {
  let out = String(raw || '').replace(/\[\s*(?:意图|意圖)\s*:\s*([^\]\n\r]+)\](?!\s*[^\n\r])/gi, (_, g1) => {
    const inner = String(g1 || '').trim();
    if (inner) innerParts.push(`意图:${inner}`);
    return '';
  });
  out = out.replace(new RegExp(HIDDEN_INTENT_SOURCE, 'gi'), (_, g1) => {
    const t = String(g1 || '').trim();
    if (t) innerParts.push(`意图:${t}`);
    return '';
  });
  out = out.replace(new RegExp(HIDDEN_INTENT_DOUBLE_SOURCE, 'gi'), (_, g1) => {
    const t = String(g1 || '').trim();
    if (t) innerParts.push(`意图:${t}`);
    return '';
  });
  out = out.replace(new RegExp(HIDDEN_ACTION_SOURCE, 'gi'), (_, g1) => {
    const t = String(g1 || '').trim();
    if (!t) return '';
    if (Array.isArray(actionParts)) actionParts.push(t);
    else innerParts.push(`动作:${t}`);
    return '';
  });
  out = out.replace(new RegExp(HIDDEN_STATUS_SOURCE, 'gi'), (_, g1, g2) => {
    const inline = String(g1 || '').trim();
    const tail = String(g2 || '').trim();
    const t = [inline, tail].filter(Boolean).join('：').trim();
    if (t) innerParts.push(`状态:${t}`);
    return '';
  });
  out = out.replace(new RegExp(HIDDEN_MOOD_SOURCE, 'gi'), (_, g1, g2) => {
    const inline = String(g1 || '').trim();
    const tail = String(g2 || '').trim();
    const t = [inline, tail].filter(Boolean).join('：').trim();
    if (t) {
      if (Array.isArray(moodParts)) moodParts.push(t);
      else innerParts.push(`情绪:${t}`);
    }
    return '';
  });
  return out;
}

export function splitPublicAndInnerVoice(text) {
  const raw = String(text || '');
  const simple = raw.match(/[\[［【]\s*(心声|心聲|意图|意圖|状态|狀態|情绪|情緒|本轮情绪|本輪情緒|动作状态|動作狀態|动作|動作|正在做什么|正在做什麼|当前动作|當前動作|当前在做什么|當前在做什麼|旁白)\s*[\]］】]\s*(.+)$/);
  if (simple) {
    const lab = simple[1];
    const isVoice = lab === '心声' || lab === '心聲';
    const isMood = lab === '情绪' || lab === '情緒' || lab === '本轮情绪' || lab === '本輪情緒';
    const isStatus = lab === '状态' || lab === '狀態' || lab === '动作状态' || lab === '動作狀態';
    const isAction = lab === '动作' || lab === '動作'
      || lab === '正在做什么' || lab === '正在做什麼'
      || lab === '当前动作' || lab === '當前動作'
      || lab === '当前在做什么' || lab === '當前在做什麼';
    const publicText = raw.replace(/[\[［【]\s*(?:心声|心聲|意图|意圖|状态|狀態|情绪|情緒|本轮情绪|本輪情緒|动作状态|動作狀態|动作|動作|正在做什么|正在做什麼|当前动作|當前動作|当前在做什么|當前在做什麼|旁白)\s*[\]］】]\s*.+$/, '').trim();
    const isNarrator = lab === '旁白';
    const tail = String(simple[2] || '')
      .trim()
      .replace(/^[：:﹕]\s*/, '');
    if (isAction) {
      return { publicText, innerVoice: '', actionText: tail, moodText: '' };
    }
    if (isMood) {
      return { publicText, innerVoice: '', actionText: '', moodText: tail };
    }
    const innerLabel = isVoice ? '心声' : (isStatus ? '状态' : (isNarrator ? '旁白' : '意图'));
    return { publicText, innerVoice: `${innerLabel}：${tail}`, actionText: '', moodText: '' };
  }
  const innerParts = [];
  const actionParts = [];
  const moodParts = [];
  let publicText = stripIntentWithRoleParenToBucket(raw, innerParts);
  publicText = stripIntentBracketLabelThenVoiceToBucket(publicText, innerParts);
  publicText = stripHiddenIntentToBucket(publicText, innerParts, actionParts, moodParts);
  publicText = stripInnerVoiceWithOwnerToBucket(publicText, innerParts);
  publicText = stripInnerVoiceTagsToBucket(publicText, innerParts);
  publicText = stripParenInnerVoiceToBucket(publicText, innerParts);
  publicText = stripMimickedContextPrefixes(publicText);
  publicText = stripIntentBracketLabelThenVoiceToBucket(publicText, innerParts);
  publicText = stripHiddenIntentToBucket(publicText, innerParts, actionParts, moodParts);
  publicText = stripInnerVoiceWithOwnerToBucket(publicText, innerParts);
  publicText = stripInnerVoiceTagsToBucket(publicText, innerParts);
  publicText = stripParenInnerVoiceToBucket(publicText, innerParts);
  publicText = publicText
    .replace(new RegExp(`^\\s*(?:\\[|［|【)\\s*(?:心声|心聲|状态|狀態|情绪|情緒|本轮情绪|本輪情緒|动作状态|動作狀態|动作|動作|正在做什么|正在做什麼|当前动作|當前動作|当前在做什么|當前在做什麼|意图|意圖|潜台词|潛台詞)\\s*(?:\\]|］|】)\\s*$`, 'gim'), '')
    .replace(/^\s*(?:'|`|\]|\[|\(\(|\)\)|:|：)\s*$/gim, '')
    .trim();
  const cleanedPublicText = publicText
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => !/^\s*(?:\[\[?意图\]?\]?|\[潜台词\]|\[心声\]|\[状态\]|\[情绪\]|\[本轮情绪\]|\[动作状态\]|\[动作\]|\[正在做什么\]|\[当前动作\]|\[当前在做什么\]|'|`|\]|\[|:|：)\s*$/u.test(line))
    .join('\n')
    .trim();
  return {
    publicText: cleanedPublicText,
    innerVoice: innerParts.join('；'),
    actionText: actionParts.join('；'),
    moodText: moodParts.join('；'),
  };
}

export function isReadOnlyStoryCardMessage(msg) {
  const md = msg?.metadata || {};
  const isLifeGlimpse = md.storyKind === 'life_glimpse' || md.lifeGlimpse === true;
  // 生活侧面不是普通聊天气泡，但用户仍应能管理自己已支付生成的内容。
  // 旧档里保存过 readOnly=true，也要允许编辑、重新生成和删除。
  return md.readOnly === true && !isLifeGlimpse;
}

export function buildStoryCardHtml(msg, escapeHtml, escapeAttr) {
  const md = msg?.metadata || {};
  const isStatusStory = md.storyKind === 'status';
  const isLifeGlimpse = md.storyKind === 'life_glimpse' || md.lifeGlimpse === true;
  const isReadOnly = isReadOnlyStoryCardMessage(msg);
  const isCompactOnly = md.compactOnly === true;
  const usesAmbientCardStyle = isStatusStory || isLifeGlimpse;
  const title = String(md.title || '小剧场').trim() || '小剧场';
  const subtitle = [String(md.timeLabel || '').trim(), String(md.toneLabel || '').trim()].filter(Boolean).join(' · ');
  const summary = applyDisplayRegex(
    String(md.summary || '').replace(/\s+/g, ' ').trim()
      || String(msg?.content || '').replace(/\s+/g, ' ').trim(),
    'storycard',
  );
  const fullText = isCompactOnly ? '' : String(md.fullText || msg?.content || '').trim();
  const rawParagraphs = !isCompactOnly && Array.isArray(md.paragraphs) && md.paragraphs.length
    ? md.paragraphs
    : (isCompactOnly
      ? []
      : fullText.split(/\n\s*\n/).map((part) => String(part || '').trim()).filter(Boolean));
  const cleanedStory = applyDisplayRegex(rawParagraphs.map((part) => String(part || '')).join('\n\n'), 'storycard');
  const paragraphs = cleanedStory
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chars = Array.isArray(md.characters) ? md.characters.filter(Boolean).slice(0, 6) : [];
  const expanded = !!md.expanded;
  const badge = String(md.badge || '小剧场更新').trim() || '小剧场更新';
  const generationStatus = String(md.generationStatus || 'complete').trim() || 'complete';
  const generationNotice = String(md.generationNotice || '').trim();
  const rawModelResponse = String(md.rawModelResponse || '').trim();
  const rawPreviewLimit = 20000;
  const rawPreview = rawModelResponse.slice(0, rawPreviewLimit);
  const rawClipped = rawModelResponse.length > rawPreviewLimit;
  const hasReadableBody = paragraphs.length > 0;
  // 重roll 只对线下快进小剧场有意义；状态小剧场是那一轮的真实幕后，不重摇。
  const canEdit = !isReadOnly;
  const canReroll = !isStatusStory && !isReadOnly;
  const canContinue = !isReadOnly
    && md.offlineFastForward === true
    && generationStatus !== 'format-error'
    && hasReadableBody;
  return `
    <div class="story-card chat-card ${usesAmbientCardStyle ? 'story-card--status' : ''} ${isLifeGlimpse ? 'story-card--life-glimpse' : ''} ${generationStatus !== 'complete' ? `story-card--${escapeAttr(generationStatus)}` : ''} ${expanded ? 'story-card--expanded' : 'story-card--collapsed'}" data-card-type="story-card"${(isStatusStory || isLifeGlimpse) && hasReadableBody ? ` role="button" tabindex="0" aria-expanded="${expanded ? 'true' : 'false'}"` : ''}>
      <div class="story-card-head">
        <div class="story-card-badge">${escapeHtml(badge)}</div>
        <div class="story-card-head-actions">
          ${canEdit ? `<button type="button" class="story-card-action-btn story-card-edit-btn" data-story-edit="1" data-story-action="1" aria-label="${isLifeGlimpse ? '编辑生活侧面' : '编辑小剧场'}">✎</button>` : ''}
          ${canContinue ? '<button type="button" class="story-card-action-btn story-card-continue-btn" data-story-continue="1" data-story-action="1" aria-label="续写小剧场">续写</button>' : ''}
          ${canReroll ? `<button type="button" class="story-card-action-btn story-card-reroll-btn" data-story-reroll="1" data-story-action="1" aria-label="${isLifeGlimpse ? '重新生成生活侧面' : '重roll'}">⟳</button>` : ''}
          ${isLifeGlimpse ? `<button type="button" class="story-card-action-btn story-card-delete-btn" data-story-delete="1" data-story-action="1" aria-label="删除生活侧面">${icon('trash')}</button>` : ''}
        </div>
        <div class="story-card-title">${escapeHtml(title)}</div>
        ${subtitle ? `<div class="story-card-meta">${escapeHtml(subtitle)}</div>` : ''}
      </div>
      ${generationNotice ? `<div class="story-card-generation-notice" role="status">${escapeHtml(generationNotice)}</div>` : ''}
      ${chars.length ? `<div class="story-card-cast">${chars.map((name) => `<span class="story-card-cast-chip">${escapeHtml(name)}</span>`).join('')}</div>` : ''}
      ${summary ? `<div class="story-card-summary">${escapeHtml(summary)}</div>` : ''}
      ${paragraphs.length ? `<div class="story-card-body-shell"><div class="story-card-body">${paragraphs.map((part) => `<p>${renderNarrationTextWithTranslations(part)}</p>`).join('')}</div></div>` : ''}
      ${rawPreview ? `<details class="story-card-raw" data-story-action="1"><summary>查看原始返回</summary><pre>${escapeHtml(rawPreview)}</pre>${rawClipped ? '<small>原始返回较长，这里仅展示前 20000 字。</small>' : ''}</details>` : ''}
      ${hasReadableBody ? `<div class="story-card-footer">
        <span data-story-toggle-label>${expanded ? '收起' : '展开阅读'}</span>
      </div>` : ''}
    </div>
  `;
}
