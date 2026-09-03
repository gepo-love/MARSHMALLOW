import { icon } from './svg-icons.js';
import { showToast } from './toast.js';
import { openImageLightbox } from './image-lightbox.js';
import { navigate } from '../core/router.js';
import { normalizeMessageForUi } from '../core/chat-helpers.js';
import {
  orderShareCardHtml,
  redPacketDetailHtml,
  textImageDetailHtml,
  transferCardDetailHtml,
  buildVoiceBubbleInnerHtml,
  voiceCallCardHtml,
  getVoiceCallStateLabel,
  ensureLuckyRedPacketSplits,
  linkCardBubbleHtml,
  locationCardBubbleHtml,
} from '../core/chat/card-render.js';
import {
  chatRecordItemsHtml,
  bindChatRecordInteractions,
} from './chat-record-view.js';
import {
  buildClaimListHtml,
  getRemainingPacketCount,
  hasClaimed,
  performRedPacketClaim,
  seedLuckySplitsIfNeeded,
} from '../core/chat/red-packet-claims.js';
import { resolveActorDisplayLabel } from '../core/chat/character-code-fallback.js';
import { openHtmlExtensionSnapshotDialog } from '../core/html-extensions.js';
import { resolveChatInternalLink } from '../core/chat/internal-link.js';

function resolveModalActorLabel(id, storedName, resolveDisplayName, fallback = '某人') {
  const key = String(id || '').trim();
  const name = String(storedName || '').trim();
  // 合并转发保存的是原窗口当时可见的前台名；存在时不得再用后台 senderId 回查真身。
  if (name) return resolveActorDisplayLabel(name, { fallback });
  if (typeof resolveDisplayName === 'function' && key) {
    const resolved = String(resolveDisplayName(key) || '').trim();
    if (resolved && resolved !== key) return resolved;
  }
  return resolveActorDisplayLabel(key, { fallback });
}

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MODAL_KINDS = new Set([
  'redpacket',
  'transfer',
  'orderShare',
  'textimg',
  'voice',
  'voiceCall',
  'chatBundle',
  'link',
  'location',
  'dice',
]);

function resolveModalKind(msg = {}) {
  let type = String(msg.type || 'text');
  if (type === 'order-share') type = 'orderShare';
  if (type === 'chat-bundle') type = 'chatBundle';
  if (MODAL_KINDS.has(type)) return type;
  return '';
}

function openShell(title, bodyHtml, onClosed, shellOptions = {}) {
  const isAnon = shellOptions.variant === 'anon';
  const isIns = shellOptions.variant === 'ins';
  const sheetClass = isAnon
    ? 'modal-sheet anon-modal-sheet chat-card-modal-sheet chat-card-modal-sheet--anon'
    : `modal-sheet chat-card-modal-sheet${isIns ? ' chat-card-modal-sheet--ins' : ''}`;
  const overlayClass = isAnon
    ? 'modal-overlay modal-sheet-center chat-card-modal-overlay chat-card-modal-overlay--anon'
    : `modal-overlay modal-sheet-center chat-card-modal-overlay${isIns ? ' chat-card-modal-overlay--ins' : ''}`;
  const host = document.getElementById('modal-container');
  if (!host) return null;
  host.classList.add('active');
  host.innerHTML = `
    <div class="${overlayClass}" data-chat-card-overlay>
      <div class="${sheetClass}" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h3>${esc(title)}</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-chat-card-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body chat-card-modal-body">${bodyHtml}</div>
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
    onClosed?.();
  };
  host.querySelector('[data-chat-card-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-chat-card-close]')?.addEventListener('click', close);
  host.querySelector('.chat-card-modal-sheet')?.addEventListener('click', (e) => e.stopPropagation());
  return { close, host };
}

function resolveDeepLink(msg = {}) {
  return resolveChatInternalLink(msg)?.url || '';
}

function resolveLinkUrl(msg = {}) {
  const deep = resolveDeepLink(msg);
  if (deep) return deep;
  const candidates = [msg.metadata?.url, msg.metadata?.href, msg.metadata?.link, msg.content];
  return candidates
    .map((x) => {
      const raw = String(x || '').trim();
      if (/^https?:\/\//i.test(raw)) return raw;
      if (/^(www\.|[\w-]+(?:\.[\w-]+)+)/i.test(raw)) return `https://${raw.replace(/^\/+/, '')}`;
      return raw;
    })
    .find((x) => /^https?:\/\//i.test(x)) || '';
}

async function patchMessageMetadata(msg, patch, onMetadataUpdate) {
  const next = {
    ...msg,
    metadata: { ...(msg.metadata || {}), ...patch },
  };
  await onMetadataUpdate?.(next);
  return next;
}

/**
 * Open a scrapbook-styled modal for interactive chat cards.
 * @param {object} msg — message row (type drives which modal opens)
 * @param {object} [options]
 * @param {string} [options.currentUserId]
 * @param {(nextMsg: object) => Promise<void>|void} [options.onMetadataUpdate]
 * @param {(text: string, meta?: object) => Promise<void>|void} [options.onSystemEvent]
 * @param {(message: object, state: string) => Promise<void>|void} [options.onTransferSettled]
 * @param {() => void} [options.onClosed]
 */
export function openChatCardModal(msg, options = {}) {
  const {
    currentUserId = 'user',
    resolveDisplayName,
    onMetadataUpdate,
    onSystemEvent,
    onTransferSettled,
    onClosed,
    variant = '',
    anonymous = false,
  } = options;
  const shellVariant = variant || (anonymous ? 'anon' : '');
  const shellOpts = { variant: shellVariant };
  const cardOpts = shellVariant === 'anon' ? { anonymous: true } : {};
  let normalized = normalizeMessageForUi(msg);
  const kind = resolveModalKind(normalized);
  if (!kind) return null;

  if (kind === 'orderShare') {
    const inner = orderShareCardHtml(normalized, esc);
    return openShell('购物礼物', `<div class="chat-card-modal-pad">${inner}</div>`, onClosed, shellOpts);
  }

  if (kind === 'location') {
    const name = String(normalized.metadata?.locationName || normalized.metadata?.label || normalized.content || '').trim();
    const addr = String(normalized.metadata?.address || '').trim();
    const inner = locationCardBubbleHtml(normalized, esc, cardOpts);
    const shell = openShell(
      '位置',
      `<div class="chat-card-modal-pad">
        ${inner}
        <div class="chat-card-meta-panel">
          <div class="chat-card-meta-label">地点名称</div>
          <div class="chat-card-meta-value">${esc(name || '位置')}</div>
          ${addr ? `<div class="chat-card-meta-label">地址</div><div class="chat-card-meta-note">${esc(addr)}</div>` : ''}
        </div>
      </div>`,
      onClosed,
      shellOpts,
    );
    return shell;
  }

  if (kind === 'link') {
    const url = resolveLinkUrl(normalized);
    const title = normalized.metadata?.title || '链接';
    const desc = String(normalized.metadata?.desc || normalized.metadata?.description || normalized.content || '').trim();
    if (url.startsWith('weibo://')) {
      const postId = url.slice('weibo://'.length);
      const shell = openShell(
        title || '微博',
        `<div class="chat-card-modal-pad">
          <div class="chat-card-meta-note" style="margin-bottom:10px;">${esc(desc || '分享了一条微博')}</div>
          <button type="button" class="btn btn-primary btn-block" data-open-weibo>在微博中打开</button>
        </div>`,
        onClosed,
      );
      shell.host?.querySelector('[data-open-weibo]')?.addEventListener('click', () => {
        navigate('weibo-detail', { postId });
        shell.close();
      });
      return shell;
    }
    if (url.startsWith('forum://')) {
      const threadId = url.slice('forum://'.length);
      const shell = openShell(
        title || '论坛',
        `<div class="chat-card-modal-pad">
          <div class="chat-card-meta-note" style="margin-bottom:10px;">${esc(desc || '分享了一条论坛帖')}</div>
          <button type="button" class="btn btn-primary btn-block" data-open-forum>在论坛中打开</button>
        </div>`,
        onClosed,
      );
      shell.host?.querySelector('[data-open-forum]')?.addEventListener('click', () => {
        navigate('forum-detail', { threadId });
        shell.close();
      });
      return shell;
    }
    const inner = linkCardBubbleHtml(normalized, esc, cardOpts);
    const shell = openShell(
      '链接',
      `<div class="chat-card-modal-pad">
        ${inner}
        <div class="chat-card-meta-panel">
          <div class="chat-card-meta-value">${esc(title)}</div>
          ${desc ? `<div class="chat-card-meta-note">${esc(desc)}</div>` : ''}
          ${url ? `<a class="chat-bubble-link chat-card-open-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : '<div class="chat-card-meta-note">无可用链接</div>'}
        </div>
      </div>`,
      onClosed,
      shellOpts,
    );
    return shell;
  }

  if (kind === 'textimg') {
    const textImageCardOpts = shellVariant === 'anon' ? cardOpts : { ...cardOpts, insCard: true };
    const textImageShellOpts = shellVariant === 'anon' ? shellOpts : { variant: 'ins' };
    const inner = textImageDetailHtml(normalized, esc, textImageCardOpts);
    const shell = openShell('文字图', `<div class="chat-card-modal-pad">${inner}</div>`, onClosed, textImageShellOpts);
    shell?.host?.querySelector('.chat-card-modal-sheet')?.classList.add('chat-card-modal-sheet--textimg');
    return shell;
  }

  if (kind === 'voice') {
    const inner = buildVoiceBubbleInnerHtml(normalized, esc, cardOpts);
    const transcript = String(normalized.metadata?.text || '').trim();
    const shell = openShell(
      '语音消息',
      `<div class="chat-card-modal-pad">
        ${inner}
        ${transcript ? `<div class="chat-card-meta-label">转写</div><div class="chat-card-meta-note">${esc(transcript)}</div>` : ''}
      </div>`,
      onClosed,
      shellOpts,
    );
    return shell;
  }

  if (kind === 'voiceCall') {
    const inner = voiceCallCardHtml(normalized, esc);
    const state = normalized.metadata?.callState || normalized.metadata?.state || '';
    const shell = openShell(
      getVoiceCallStateLabel(state, normalized.metadata?.callMode),
      `<div class="chat-card-modal-pad">${inner}</div>`,
      onClosed,
      shellOpts,
    );
    shell.host?.querySelector('.voice-call-answer')?.addEventListener('click', async () => {
      normalized = await patchMessageMetadata(normalized, { callState: 'active', state: 'active' }, onMetadataUpdate);
      showToast('已接听');
      shell.close();
    });
    shell.host?.querySelector('.voice-call-decline')?.addEventListener('click', async () => {
      normalized = await patchMessageMetadata(normalized, { callState: 'declined', state: 'declined' }, onMetadataUpdate);
      showToast('已挂断');
      shell.close();
    });
    return shell;
  }

  if (kind === 'dice') {
    const sides = Number(normalized.metadata?.sides || 6) || 6;
    const result = Number(normalized.metadata?.result || 0) || 0;
    return openShell(
      `掷骰 d${sides}`,
      `<div class="chat-card-modal-pad chat-card-dice-result">
        <div class="chat-card-dice-num">${esc(String(result))}</div>
        <div class="chat-card-meta-note">d${sides} 随机结果</div>
      </div>`,
      onClosed,
      shellOpts,
    );
  }

  if (kind === 'chatBundle') {
    const items = Array.isArray(normalized.metadata?.items)
      ? normalized.metadata.items
      : (Array.isArray(normalized.metadata?.bundleItems) ? normalized.metadata.bundleItems : []);
    const fromLab = String(normalized.metadata?.fromChatLabel || '').trim();
    const list = chatRecordItemsHtml(items, {
      currentUserId,
      resolveDisplayName: (id) => resolveModalActorLabel(id, '', resolveDisplayName),
      limit: 40,
    });
    const shell = openShell(
      normalized.metadata?.bundleTitle || '聊天记录',
      `<div class="chat-card-modal-pad chat-bundle-modal-pad">
        ${fromLab ? `<div class="chat-card-meta-note">转自「${esc(fromLab)}」</div>` : ''}
        <div class="chat-bundle-list chat-record-list">${list || '<div class="chat-card-meta-note">无片段</div>'}</div>
        ${items.length > 40 ? `<div class="chat-card-meta-note">仅展示前 40 条 · 共 ${items.length} 条</div>` : ''}
      </div>`,
      onClosed,
      shellOpts,
    );
    const listRoot = shell.host?.querySelector('.chat-bundle-list');
    bindChatRecordInteractions(listRoot, items, {
      onOpenCard: (item) => {
        if (item?.type === 'htmlWidget') {
          const snapshot = item.metadata?.htmlExtension;
          if (snapshot) openHtmlExtensionSnapshotDialog(snapshot);
          else showToast('这张小卡片缺少原内容');
          return;
        }
        openChatCardModal(item, { currentUserId, resolveDisplayName, variant: shellVariant });
      },
      onVoiceSnapshotUpdate: async (updated, index) => {
        const key = Array.isArray(normalized.metadata?.items) ? 'items' : 'bundleItems';
        const nextItems = items.map((row, rowIndex) => (
          rowIndex === index
            ? { ...updated, metadata: { ...(updated.metadata || {}) } }
            : row
        ));
        normalized = {
          ...normalized,
          metadata: { ...(normalized.metadata || {}), [key]: nextItems },
        };
        await onMetadataUpdate?.(normalized);
      },
    });
    return shell;
  }

  if (kind === 'transfer') {
    const st = normalized.metadata?.transferState || 'pending';
    const inner = transferCardDetailHtml(normalized, esc, cardOpts);
    const shell = openShell(
      '转账',
      `<div class="chat-card-modal-pad">
        ${inner}
        <div class="chat-card-actions">
          <button type="button" class="btn btn-primary" data-tf-accept ${st !== 'pending' ? 'disabled' : ''}>确认收款</button>
          <button type="button" class="btn btn-outline" data-tf-decline ${st !== 'pending' ? 'disabled' : ''}>退回</button>
        </div>
      </div>`,
      onClosed,
      shellOpts,
    );
    shell.host?.querySelector('[data-tf-accept]')?.addEventListener('click', async () => {
      normalized = await patchMessageMetadata(normalized, { transferState: 'accepted' }, onMetadataUpdate);
      await onTransferSettled?.(normalized, 'accepted');
      showToast('已收款');
      shell.close();
    });
    shell.host?.querySelector('[data-tf-decline]')?.addEventListener('click', async () => {
      normalized = await patchMessageMetadata(normalized, { transferState: 'returned' }, onMetadataUpdate);
      showToast('已退回');
      shell.close();
    });
    return shell;
  }

  if (kind === 'redpacket') {
    normalized = seedLuckySplitsIfNeeded(normalized);
    const resolveName = (id) => {
      if (id === currentUserId || id === 'user') return '我';
      return resolveModalActorLabel(id, '', resolveDisplayName, '成员');
    };

    const shell = openShell('红包', '<div class="chat-card-modal-pad" data-rp-modal-pad></div>', onClosed, shellOpts);
    const pad = shell.host?.querySelector('[data-rp-modal-pad]');
    if (!pad) return shell;

    const renderBody = () => {
      let m = seedLuckySplitsIfNeeded(normalized);
      const mode = m.metadata?.redpacketMode || 'normal';
      const remain = getRemainingPacketCount(m);
      const claimed = hasClaimed(m, currentUserId || 'user');
      const claimList = buildClaimListHtml(m, { resolveName, esc, currentUserId });
      let body = redPacketDetailHtml(m, esc, cardOpts);
      let actions = '';

      if (mode === 'lucky') {
        actions = `
          <div class="chat-card-meta-note">拼手气 · ${remain > 0 ? `剩余 ${remain} 个` : '已领完'} · 共 ${esc(String(m.metadata?.packetCount || ''))} 个</div>
          ${claimList}
          ${remain > 0 && !claimed ? '<button type="button" class="btn btn-primary btn-block" data-rp-grab>抢红包</button>' : ''}
        `;
      } else if (mode === 'exclusive') {
        const tid = String(m.metadata?.exclusiveTargetId || '').trim();
        const done = !!m.metadata?.exclusiveClaimed;
        const canUser = tid === 'user' || tid === currentUserId;
        actions = `
          ${claimList}
          ${done
            ? '<div class="chat-card-meta-note">已领取</div>'
            : `<button type="button" class="btn btn-primary btn-block" data-rp-exclusive ${canUser ? '' : 'disabled'}>${canUser ? '领取红包' : '仅指定对象可领'}</button>`}
        `;
      } else {
        const st = m.metadata?.packetState || 'pending';
        actions = `
          ${claimList}
          ${st === 'pending' && !claimed ? `
            <div class="chat-card-actions">
              <button type="button" class="btn btn-primary" data-rp-claim>领取</button>
              <button type="button" class="btn btn-outline" data-rp-expire>标记过期</button>
            </div>
          ` : ''}
        `;
      }

      pad.innerHTML = `${body}${actions}`;
      bindRedPacketActions(pad, m);
    };

    const bindRedPacketActions = (root, m) => {
      const claimOpts = {
        claimerId: currentUserId || 'user',
        claimerName: resolveName(currentUserId || 'user'),
        senderName: resolveName(m.senderId) || m.senderName || '',
      };
      root.querySelector('[data-rp-claim]')?.addEventListener('click', async () => {
        const result = performRedPacketClaim(m, claimOpts);
        if (!result.ok) {
          showToast(result.reason === 'already-claimed' ? '你已经领过了' : '红包已不可领');
          return;
        }
        normalized = await patchMessageMetadata(m, result.patch, onMetadataUpdate);
        await onSystemEvent?.(result.systemText, {
          financeEvent: 'redpacket_claimed',
          amount: result.got,
          claimerId: currentUserId || 'user',
          sourceMessageId: normalized.id,
        });
        showToast(`领取 ¥${result.got}`);
        renderBody();
      });
      root.querySelector('[data-rp-expire]')?.addEventListener('click', async () => {
        normalized = await patchMessageMetadata(m, { packetState: 'expired' }, onMetadataUpdate);
        showToast('已标记过期');
        renderBody();
      });
      root.querySelector('[data-rp-exclusive]')?.addEventListener('click', async () => {
        const result = performRedPacketClaim(m, claimOpts);
        if (!result.ok) {
          showToast('无法领取');
          return;
        }
        normalized = await patchMessageMetadata(m, result.patch, onMetadataUpdate);
        await onSystemEvent?.(result.systemText, {
          financeEvent: 'redpacket_claimed',
          amount: result.got,
          sourceMessageId: normalized.id,
        });
        showToast(`领取 ¥${result.got}`);
        renderBody();
      });
      root.querySelector('[data-rp-grab]')?.addEventListener('click', async () => {
        const result = performRedPacketClaim(m, claimOpts);
        if (!result.ok) {
          showToast(result.reason === 'already-claimed' ? '你已经抢过了' : '红包已抢完');
          return;
        }
        normalized = await patchMessageMetadata(m, result.patch, onMetadataUpdate);
        await onSystemEvent?.(result.systemText, {
          financeEvent: 'redpacket_grabbed',
          amount: result.got,
          claimerId: currentUserId || 'user',
          sourceMessageId: normalized.id,
        });
        showToast(`抢到 ¥${result.got}`);
        renderBody();
      });
    };

    renderBody();
    return shell;
  }

  return null;
}

/** Alias for glory-style import paths. */
export const openChatInteractiveCardModal = openChatCardModal;
