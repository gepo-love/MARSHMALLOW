/**
 * 推进走向选项（ABC 快捷走向）· 线下沉浸 / 番外剧场通用。
 *
 * 设计：走向选项与正文是**同一轮 API 调用**产出的——在 prompt 末尾追加指令，
 * 让模型在正文之后用标记块输出几个走向，再从原始回复里解析出来，附在该轮 beat 上。
 * 用户可不选、可折叠收纳；选了就填进「方向」框推进下一轮。
 */

import { stripLeakedReasoning } from './narration-sanitize.js';

export const OPTIONS_START = '<<<OPTIONS>>>';
export const OPTIONS_END = '<<<END_OPTIONS>>>';

function clampCount(n) {
  const v = Math.round(Number(n) || 3);
  return Math.max(2, Math.min(4, v));
}

function parseOptionLines(text = '') {
  return stripLeakedReasoning(text)
    .split('\n')
    .map((line) => line.replace(/^[\s\-*0-9.、）)A-Da-d．。]+/, '').replace(/^["“]|["”]$/g, '').trim())
    .filter(Boolean)
    .map((line) => (line.length > 60 ? `${line.slice(0, 60)}…` : line))
    .slice(0, 4);
}

/**
 * 兼容模型漏掉标记、直接在正文最后列出 A/B/C 的情况。
 * 只接受末尾连续且从 A 开始的至少两项，避免误把正常对白中的字母当选项。
 */
function extractUnmarkedLetterOptions(raw = '') {
  const text = String(raw || '').replace(/\r\n?/g, '\n');
  const pattern = /^\s*([A-DＡ-Ｄ])\s*[.．、:：)）]\s*(.+?)\s*$/gim;
  const rows = [];
  let match;
  while ((match = pattern.exec(text))) {
    const letter = String(match[1]).toUpperCase().replace(/[Ａ-Ｄ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
    rows.push({ letter, value: String(match[2] || '').trim(), start: match.index, end: pattern.lastIndex });
  }
  if (rows.length < 2) return null;
  let start = rows.length - 1;
  while (start > 0 && rows[start].start === rows[start - 1].end + 1) start -= 1;
  const tail = rows.slice(start);
  if (tail.length < 2 || text.slice(tail[tail.length - 1].end).trim()) return null;
  if (tail[0].letter !== 'A' || !tail.every((row, index) => row.letter === String.fromCharCode(65 + index))) return null;
  const optionStart = tail[0].start;
  let body = text.slice(0, optionStart).replace(/\n?\s*(?:【?走向选项】?|请选择(?:以下)?|接下来你可以选择)\s*[:：]?\s*$/u, '');
  const options = parseOptionLines(tail.map((row) => row.value).join('\n'));
  return options.length >= 2 ? { body: body.trim(), options } : null;
}

/** 追加到 beat prompt 末尾的指令：要求模型在正文后输出走向选项块。 */
export function advanceOptionsInstruction(count = 3, options = {}) {
  const n = clampCount(count);
  const finalBlock = options.finalBlock === true;
  const finalRule = finalBlock
    ? `${OPTIONS_START} 选项块必须是整份回复的最后一块；${OPTIONS_END} 之后立即结束，不得再输出任何文字或 JSON。`
    : '';
  if (options.dialogue === true) {
    return [
      finalBlock
        ? `本轮叙事正文与所有隐藏结构块完成后，单独一行输出 ${OPTIONS_START}；然后给出 ${n} 句互不相同、符合用户人物设定和当前关系、可以由用户下一秒直接说出口的对白，每行一句，每句不超过 24 字；最后单独一行输出 ${OPTIONS_END}。`
        : `本轮叙事正文最后一个标点写完后，必须立刻另起一行输出 ${OPTIONS_START}；然后给出 ${n} 句互不相同、符合用户人物设定和当前关系、可以由用户下一秒直接说出口的对白，每行一句，每句不超过 24 字；最后单独一行输出 ${OPTIONS_END}。`,
      `选项只写用户会说出口的原话，不编号，不加引号，不写动作、心理、语气说明、剧情概述或“选择去做某事”。${finalBlock ? '可见叙事正文必须位于隐藏块之前；' : `${OPTIONS_START} 之前只写叙事正文；`}角色不得停下来宣布选择题。`,
      finalRule,
    ].join('\n');
  }
  return [
    finalBlock
      ? `本轮叙事正文与所有隐藏结构块完成后，单独一行输出 ${OPTIONS_START}；然后给出 ${n} 个互不相同、各有看点的后续剧情走向短句，每行一个，每条不超过 18 字，口语自然、可直接当下一步推进指令；最后单独一行输出 ${OPTIONS_END}。`
      : `本轮叙事正文最后一个标点写完后，必须立刻另起一行输出 ${OPTIONS_START}，中间不要继续思考、解释、总结或停顿；然后给出 ${n} 个互不相同、各有看点的后续剧情走向短句，每行一个，每条不超过 18 字，口语自然、可直接当下一步推进指令；最后单独一行输出 ${OPTIONS_END}。`,
    `这些走向只是正文之外的平行推进建议，不是场内人物正在要求用户作答的选择题。${finalBlock ? '可见叙事正文必须位于隐藏块之前；' : `${OPTIONS_START} 之前只写叙事正文；`}正文不得提到后面的走向，不得为了引出它们而让角色停下等待用户作答或决定；选项区每行只写一个走向，不要编号、不要解释。`,
    finalRule,
  ].join('\n');
}

/**
 * 从模型原始回复里分离正文与走向选项。
 * @returns {{ body: string, options: string[] }}
 */
export function extractAdvanceOptions(raw = '') {
  const text = String(raw || '');
  const si = text.indexOf(OPTIONS_START);
  if (si === -1) return extractUnmarkedLetterOptions(text) || { body: text, options: [] };
  const body = text.slice(0, si);
  let rest = text.slice(si + OPTIONS_START.length);
  const ei = rest.indexOf(OPTIONS_END);
  if (ei !== -1) rest = rest.slice(0, ei);
  // 选项块偶发夹带模型泄漏的思维链（尤其是没按标记规矩输出、或标记内先吐了一段英文自言自语再给选项）：
  // 先整体过一遍通用思维链过滤，再按行拆选项，避免把 CoT 段落当成一整条选项渲染出来。
  const options = parseOptionLines(rest);
  return { body: body.trim(), options };
}

/** 流式显示时，截掉 OPTIONS 标记及之后内容，只显示正文部分。 */
export function stripOptionsTail(raw = '') {
  const text = String(raw || '');
  const si = text.indexOf(OPTIONS_START);
  if (si !== -1) return text.slice(0, si);
  return extractUnmarkedLetterOptions(text)?.body || text;
}
