import {
  stripLeakedMarshmallowProtocolMarkers,
  stripThinkingBlocks,
} from '../marshmallow-protocol.js';

function splitSentences(text = '') {
  const source = String(text || '').trim();
  if (!source) return [];
  const parts = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (!'.。！？!?'.includes(char)) continue;
    if (
      char === '.'
      && /\d/.test(source[i - 1] || '')
      && /\d/.test(source[i + 1] || '')
    ) continue;
    let end = i + 1;
    while (end < source.length && '.。！？!?…'.includes(source[end])) end += 1;
    while (end < source.length && '”’"\'）)]】'.includes(source[end])) end += 1;
    const part = source.slice(start, end).trim();
    if (part) parts.push(part);
    start = end;
    i = end - 1;
  }
  const tail = source.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

/**
 * 掉格式原文的人工确认候选：原换行优先；没有换行才按句末标点拆分。
 * 本函数只准备候选，不代表内容可展示，更不能据此自动落库。
 */
export function splitPlainTextFallbackBubbles(raw = '', options = {}) {
  let text = stripThinkingBlocks(String(raw || ''))
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/<thinking>[\s\S]*$/i, '');
  text = stripLeakedMarshmallowProtocolMarkers(text);
  if (!text) return [];
  const wholeFence = text.match(
    /^\s*```(?:markdown|md|text|plaintext|txt)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i,
  );
  if (wholeFence) text = String(wholeFence[1] || '').trim();
  if (!text) return [];

  const lines = text.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
  let parts = lines.length > 1 ? lines : splitSentences(text);
  if (!parts.length) parts = [text];

  const maxBubbles = Math.max(1, Math.min(12, Number(options.maxBubbles || 8)));
  if (parts.length > maxBubbles) {
    parts = [
      ...parts.slice(0, maxBubbles - 1),
      parts.slice(maxBubbles - 1).join('\n'),
    ];
  }
  return parts;
}

function stripLegacyTimestampPrefix(value = '') {
  let text = String(value || '').trim();
  text = text.replace(/^(?:时间戳\s*)/i, '');
  text = text.replace(/^[【[]\s*(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?\s*)?(?:今天|昨天|前天)?\s*\d{1,2}:\d{2}(?::\d{2})?[^\]】]{0,24}[\]】]\s*/, '');
  text = text.replace(/^(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?\s*)?(?:今天|昨天|前天)?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:[·•|｜-]\s*)?/, '');
  return text.trim();
}

/**
 * 兼容模型掉成「[C1] 时间 角色：正文」的旧式聊天行。
 * 群聊只认明确 actor 编号；私聊/指定发言人还可认「角色：」和已确认角色名。
 * 普通自由文本继续走人工确认。
 */
export function convertLegacyTaggedChatOutput(raw = '', options = {}) {
  const source = stripThinkingBlocks(String(raw || ''))
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
  if (!source) return '';
  const defaultActorId = String(options.defaultActorId || '').trim();
  const defaultActorLabels = (Array.isArray(options.defaultActorLabels) ? options.defaultActorLabels : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const events = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tagged = line.match(/^(?:[-*]\s*)?(?:[\[【]\s*(C\d+|U|user)\s*[\]】]|(C\d+|U|user))\s*([\s\S]+)$/i);
    const actorToken = String(tagged?.[1] || tagged?.[2] || '').trim();
    const actor = actorToken
      ? (/^u(?:ser)?$/i.test(actorToken) ? 'user' : actorToken.toUpperCase())
      : defaultActorId;
    if (!actor) continue;
    const rest = stripLegacyTimestampPrefix(tagged ? tagged[3] : line.replace(/^(?:[-*]\s*)?/, ''));
    let message = rest.match(/^(?:角色(?:回复|发言)?\s*)?(?:[^：:\n]{1,40})?[：:]\s*([\s\S]+)$/);
    if (!tagged && defaultActorLabels.length) {
      const named = rest.match(/^([^：:\n]{1,40})[：:]\s*([\s\S]+)$/);
      if (named && defaultActorLabels.includes(String(named[1] || '').trim())) {
        message = [named[0], named[2]];
      }
    }
    // 无 actor 编号时只接受私聊/指定发言人的「角色：正文」或已确认角色名，
    // 群聊里不猜名字，避免把不同人的台词全塞给同一个角色。
    if (!tagged && !/^(?:角色(?:回复|发言)?\s*)[：:]/.test(rest)
      && !defaultActorLabels.some((label) => rest.startsWith(`${label}：`) || rest.startsWith(`${label}:`))) {
      continue;
    }
    const body = String(message?.[1] || '').trim();
    if (!body) continue;
    events.push({ t: 'msg', from: actor, body });
  }
  return events.map((event) => JSON.stringify(event)).join('\n');
}
