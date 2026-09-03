import * as db from './db.js';

export const FRONT_SYSTEM_PROMPT_KEY = 'frontSystemPrompt';
export const FRONT_SYSTEM_PROMPT_HEADER = '【前置系统提示词】';

export async function loadFrontSystemPrompt() {
  const row = await db.get(FRONT_SYSTEM_PROMPT_KEY).catch(() => null);
  return String(row?.value || '').trim();
}

export async function saveFrontSystemPrompt(content = '') {
  const value = String(content || '').trim();
  await db.put({ key: FRONT_SYSTEM_PROMPT_KEY, value });
  return value;
}

export async function buildFrontSystemPromptBlock() {
  const content = await loadFrontSystemPrompt();
  return content ? `${FRONT_SYSTEM_PROMPT_HEADER}\n${content}` : '';
}

function messageText(message = {}) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((part) => part?.type === 'text')
    .map((part) => String(part?.text || ''))
    .join('\n');
}

/**
 * 所有用户发起的文本生成共用这一层。已有业务链若已经把前置块放进自身 system
 * 的正确位置，只做去重；普通工具任务则保留首条任务 system，再紧接着插入前置块。
 */
export async function injectFrontSystemPrompt(messages = []) {
  const rows = Array.isArray(messages) ? [...messages] : [];
  const alreadyInjected = rows.some((message) => (
    ['system', 'developer'].includes(String(message?.role || '').trim().toLowerCase())
    && messageText(message).includes(FRONT_SYSTEM_PROMPT_HEADER)
  ));
  if (alreadyInjected) return rows;

  const block = await buildFrontSystemPromptBlock();
  if (!block) return rows;
  const frontMessage = { role: 'system', content: block };
  const firstRole = String(rows[0]?.role || '').trim().toLowerCase();
  if (firstRole === 'system' || firstRole === 'developer') {
    return [rows[0], frontMessage, ...rows.slice(1)];
  }
  return [frontMessage, ...rows];
}
