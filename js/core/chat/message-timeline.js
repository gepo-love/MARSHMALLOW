import { applyDisplayRegex } from '../display-regex.js';
import { icon } from '../../components/svg-icons.js';

export const TIME_DIVIDER_GAP_MS = 10 * 60 * 1000;

export function formatMsgTime(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  return new Date(n).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatGapHint(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (!n) return '';
  const min = Math.round(n / 60000);
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return `${min} 分钟`;
  const hr = Math.round(n / 3600000);
  if (hr < 24) return `${hr} 小时`;
  const day = Math.round(n / 86400000);
  return `${day} 天`;
}

export function isStatusTimelineHint(msg = {}) {
  return msg?.metadata?.statusChangeHint === true
    && msg?.metadata?.narratorBeat !== true;
}

export function formatChatClockTime(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatStatusHintTime(ts) {
  return formatChatClockTime(ts);
}

export function isSystemTimelineMessage(msg = {}) {
  if (!msg || msg.type === 'storyCard') return false;
  if (msg.metadata?.sceneGuide) return false;
  // 剧情解释只进 AI 上下文，不进时间线提示行。
  if (msg.metadata?.plotExplain === true) return false;
  const content = String(msg.content || '').trim();
  if (msg.senderId === 'system' && /^【剧情解释】/.test(content)) return false;
  if (msg.type === 'chatAction' || msg.metadata?.chatAction) return true;
  if (msg.type === 'system') return true;
  if (msg.metadata?.narratorBeat) return true;
  if (msg.senderId === 'system' && /^(【(?:当前轮系统旁白承接|旁白)】)/.test(content)) return true;
  return false;
}

/** 跨窗导演说明：入库供续写，前台日常不展示。 */
export function isPlotExplainMessage(msg = {}) {
  if (!msg) return false;
  if (msg.metadata?.plotExplain === true) return true;
  return msg.senderId === 'system' && /^【剧情解释】/.test(String(msg.content || '').trim());
}

/** 聊天窗 UI 应跳过的消息（占位气泡、剧情解释等）。 */
export function isHiddenFromChatUi(msg = {}) {
  if (!msg || msg.deleted || msg.recalled) return true;
  if (msg.metadata?.aiPlaceholder) return true;
  if (isPlotExplainMessage(msg)) return true;
  const financeEvent = String(msg.metadata?.financeEvent || '').trim();
  if (
    msg.type === 'system'
    && financeEvent === 'transfer_returned'
    && (msg.metadata?.sourceFinanceMessageId || msg.metadata?.sourceMessageId)
  ) return true;
  return false;
}

export function formatSystemHintDisplayText(msg = {}) {
  const content = String(msg?.content || '系统提示').trim() || '系统提示';
  if (msg?.type === 'chatAction' || msg?.metadata?.chatAction) {
    return String(msg?.metadata?.actionText || content || '系统提示')
      .replace(/^\[(?:聊天动作|群聊动作)\]\s*/, '')
      .trim() || '系统提示';
  }
  return content
    .replace(/^【当前轮系统旁白承接】/, '')
    .replace(/^【旁白】/, '')
    .trim() || content;
}

export function shouldInsertTimeDivider(prevTs, nextTs, gapMs = TIME_DIVIDER_GAP_MS) {
  const ts = Number(nextTs) || 0;
  const last = Number(prevTs) || 0;
  if (!ts || !last) return false;
  const dayKey = new Date(ts).toLocaleDateString('zh-CN');
  const lastDayKey = new Date(last).toLocaleDateString('zh-CN');
  if (dayKey && lastDayKey && dayKey !== lastDayKey) return true;
  return ts - last >= gapMs;
}

export function renderTimeDividerHtml(ts) {
  const label = formatMsgTime(ts);
  if (!label) return '';
  return `<div class="date-divider chat-time-divider">${label}</div>`;
}

export function renderSystemHintRowHtml(msg, esc, options = {}) {
  const regexContext = { placement: 2, depth: msg?.__regexDepth };
  const content = applyDisplayRegex(formatSystemHintDisplayText(msg), 'chat', regexContext);
  const id = String(msg?.id || '').trim();
  const attrs = id ? ` data-msg-id="${esc(id)}"` : '';
  const selectable = options.selectionMode ? ' is-selectable' : '';
  const selected = options.selectionMode && options.selectedSet?.has(id) ? ' is-selected' : '';
  const checkHtml = `<input type="checkbox" class="chat-bubble-select chat-timeline-select" aria-label="选择这条消息" ${options.selectionMode ? '' : 'hidden'} ${selected ? 'checked' : ''} />`;
  if (msg?.metadata?.narratorBeat === true) {
    return `<div class="chat-narration-row is-flow${selectable}${selected}"${attrs}>`
      + checkHtml
      + '<div class="chat-narration-card">'
      + '<div class="chat-narration-rule" aria-hidden="true">'
      + '<span class="chat-narration-rule-line"></span>'
      + '<span class="chat-narration-rule-label"></span>'
      + '<span class="chat-narration-rule-line"></span>'
      + '</div>'
      + `<div class="chat-narration-body">${esc(content)}</div>`
      + '</div>'
      + `</div>`;
  }
  const statusTime = isStatusTimelineHint(msg) ? formatStatusHintTime(msg?.timestamp) : '';
  const statusTimeHtml = statusTime
    ? ` <span class="system-hint-time chat-bubble-time">${esc(statusTime)}</span>`
    : '';
  const recalledContent = applyDisplayRegex(String(msg?.metadata?.recalledContent || '').trim(), 'chat', regexContext);
  if (recalledContent) {
    return `<div class="date-divider system-hint-row recall-hint${selectable}${selected}"${attrs} data-recalled="1">`
      + checkHtml
      + `<button type="button" class="recall-hint-line">${esc(content)}</button>`
      + `<div class="recall-hint-card" hidden><div class="recall-hint-card-text">${esc(recalledContent)}</div></div>`
      + `</div>`;
  }
  return `<div class="date-divider system-hint-row${selectable}${selected}"${attrs}>${checkHtml}${esc(content)}${statusTimeHtml}</div>`;
}
