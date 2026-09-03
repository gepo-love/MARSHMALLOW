import { getChat, saveChat } from '../chat-store.js';

const MAX_PHASE = 5;
export const OFFLINE_FAST_FORWARD_EVENT_TEXT = '（线下时间已推进，角色可在对话中自然提及这段时间的见闻与余波。）';

export function isActiveEventUserVisible(event) {
  if (!event || typeof event !== 'object') return false;
  if (String(event.variant || '').trim() === 'offline-fast-forward') return false;
  // 兼容修复前已经按默认 gacha variant 落库的线下快进状态。
  if (String(event.text || '').trim() === OFFLINE_FAST_FORWARD_EVENT_TEXT) return false;
  return true;
}


export function buildActiveEventInjection(text = '') {
  const body = String(text || '').trim();
  if (!body) return '';
  return `[特殊事件·机密——仅供 AI 编排剧情，不要以旁白复述全文]

## 事件种子
${body}

## 本轮要求
- 只推进一个节拍：疑问、线索、误解或反常反应之一
- 不要在本轮揭晓全部真相
- 不同角色可以掌握不同信息量
- 禁止用叙述者口吻总结整个事件`;
}

export function getActiveEvent(chat) {
  const raw = chat?.metadata?.activeEvent;
  return raw && typeof raw === 'object' ? raw : null;
}

export async function persistActiveEvent(chatId, payload = {}) {
  const chat = await getChat(chatId);
  if (!chat) throw new Error('会话不存在');
  const text = String(payload.text || '').trim();
  if (!text) throw new Error('事件内容不能为空');
  chat.metadata = {
    ...(chat.metadata || {}),
    activeEvent: {
      text,
      phase: 1,
      maxPhase: MAX_PHASE,
      status: 'active',
      createdAt: Date.now(),
      variant: payload.variant || 'gacha',
    },
  };
  await saveChat(chat);
  return chat.metadata.activeEvent;
}

export async function clearActiveEvent(chatId) {
  const chat = await getChat(chatId);
  if (!chat?.metadata?.activeEvent) return null;
  const next = { ...(chat.metadata || {}) };
  delete next.activeEvent;
  chat.metadata = next;
  await saveChat(chat);
  return chat;
}

export async function advanceActiveEventAfterAiReply(chatId) {
  const chat = await getChat(chatId);
  const ev = getActiveEvent(chat);
  if (!ev || ev.status !== 'active') return null;
  const phase = Number(ev.phase || 1) + 1;
  if (phase > Number(ev.maxPhase || MAX_PHASE)) {
    return clearActiveEvent(chatId);
  }
  chat.metadata.activeEvent = { ...ev, phase };
  await saveChat(chat);
  return chat.metadata.activeEvent;
}

export async function rewindActiveEventAfterReroll(chatId) {
  const chat = await getChat(chatId);
  const ev = getActiveEvent(chat);
  if (!ev) return null;
  const phase = Math.max(1, Number(ev.phase || 1) - 1);
  chat.metadata.activeEvent = { ...ev, phase };
  await saveChat(chat);
  return chat.metadata.activeEvent;
}

export function buildActiveEventPromptBlock(chat) {
  const ev = getActiveEvent(chat);
  if (!ev?.text || ev.status === 'cancelled') return '';
  const phase = Number(ev.phase || 1);
  const max = Number(ev.maxPhase || MAX_PHASE);
  return [
    buildActiveEventInjection(ev.text),
    `（事件进度：第 ${phase}/${max} 节拍）`,
  ].join('\n\n');
}
