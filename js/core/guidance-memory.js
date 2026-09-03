/**
 * 扮演指导专用记忆：按角色绑定，跨会话共享。
 * 存于 memories 表（type/source = guidance，importance = high）。
 */

import * as db from './db.js';
import { createMemory } from '../models/memory.js';
import { resolveCharacterAiContextName } from '../models/character.js';
import { chatForTask } from './api.js';
import { getNowForUser } from './time-mode.js';

export const GUIDANCE_MEMORY_TYPE = 'guidance';
export const GUIDANCE_MEMORY_SOURCE = 'guidance';
export const GUIDANCE_SENDER_ID = 'guidance';
export const GUIDANCE_STATUS_ACTIVE = 'active';
export const GUIDANCE_STATUS_DISABLED = 'disabled';
export const GUIDANCE_STATUS_ARCHIVED = 'archived';
export const GUIDANCE_PROMPT_BUDGET_CHARS = 4200;
export const GUIDANCE_MODE_PROMPT_BUDGET_CHARS = 6000;
export const GUIDANCE_ROLEPLAY_EVIDENCE_BUDGET_CHARS = 12000;
export const GUIDANCE_SCENE_DEFAULT_TURNS = 8;

function cleanGuidanceText(value = '') {
  return String(value || '').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function clipGuidanceText(value = '', limit = 1400) {
  const text = cleanGuidanceText(value);
  if (text.length <= limit) return text;
  const marker = '\n…（原指导中段已省略，可在管理页查看）…\n';
  if (limit <= marker.length + 40) return text.slice(0, Math.max(1, limit)).trim();
  const available = limit - marker.length;
  const head = Math.floor(available * 0.72);
  return `${text.slice(0, head).trim()}${marker}${text.slice(-(available - head)).trim()}`;
}

/**
 * 指导模式读取正常扮演已经沉淀的资料时，只把它们作为诊断证据。
 * 这里统一做预算与边界声明，避免本体把资料当成角色续写提示，或在证据为空时
 * 武断宣称“系统永久没有相关记忆”。权限过滤仍由各业务记忆构建器负责。
 */
export function buildGuidanceRoleplayEvidenceBlock(
  sections = [],
  { budgetChars = GUIDANCE_ROLEPLAY_EVIDENCE_BUDGET_CHARS, full = false } = {},
) {
  const header = [
    '【当前剧情证据 · 只读诊断】',
    '以下资料来自当前会话对象在正常扮演时有权读取的存档与状态，只用于回答用户的检查、纠偏和原因分析；不要进入角色扮演，也不要把它们续写成新剧情。',
    '必须区分“本次证据中未找到”“系统有记录但当前对象无权知道”“记录存在且正常扮演应当读取”“记录存在但上一轮可能未注入”；不得仅因聊天气泡没有明写，就断言系统没有相关记忆。',
    '若证据与聊天气泡或当前日程冲突，指出具体冲突来源；已完成事件只作为既定事实与后果，不得误判为仍在进行。',
  ].join('\n');
  const cap = full
    ? Number.MAX_SAFE_INTEGER
    : Math.max(header.length + 240, Math.floor(Number(budgetChars) || GUIDANCE_ROLEPLAY_EVIDENCE_BUDGET_CHARS));
  let remaining = cap - header.length - 2;
  const rows = [];
  const seen = new Set();
  for (const section of (Array.isArray(sections) ? sections : [])) {
    const label = cleanGuidanceText(section?.label || '剧情资料');
    const text = cleanGuidanceText(section?.text || '');
    if (!text) continue;
    const key = `${label}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const prefix = `【证据来源：${label}】\n`;
    if (remaining <= prefix.length + 80) break;
    const clipped = full
      ? text
      : clipGuidanceText(text, Math.min(5200, remaining - prefix.length));
    if (!clipped) continue;
    const row = `${prefix}${clipped}`;
    rows.push(row);
    remaining -= row.length + 2;
  }
  if (!rows.length) {
    rows.push('【证据状态】\n本次上下文没有读取到可核对的剧情证据。这里只能说明“本次证据为空”，不能据此推断系统永久没有记录。');
  }
  return `${header}\n\n${rows.join('\n\n')}`;
}

export function guidanceMemoryStatus(row = {}) {
  const status = String(row?.guidanceStatus || '').trim();
  if (status === GUIDANCE_STATUS_DISABLED || status === GUIDANCE_STATUS_ARCHIVED) return status;
  return GUIDANCE_STATUS_ACTIVE;
}

export function isActiveGuidanceMemory(row = {}) {
  return isGuidanceMemory(row) && guidanceMemoryStatus(row) === GUIDANCE_STATUS_ACTIVE;
}

export function estimateGuidanceTokens(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return 0;
  const cjk = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.max(1, Math.ceil(cjk * 1.2 + (raw.length - cjk) / 4));
}

export function isGuidanceMemory(row = {}) {
  return row?.type === GUIDANCE_MEMORY_TYPE
    || row?.source === GUIDANCE_MEMORY_SOURCE
    || row?.category === GUIDANCE_MEMORY_TYPE;
}

export function isGuidanceMessage(message = {}) {
  return message?.metadata?.guidanceMode === true
    || message?.senderId === GUIDANCE_SENDER_ID
    || message?.metadata?.guidanceReply === true
    || String(message?.metadata?.aiRoundKind || '').trim() === 'guidance';
}

export function guidanceMessageCreatedAtReal(message = {}) {
  const explicit = Number(
    message?.createdAt
    || message?.metadata?.createdAtReal
    || message?.metadata?.aiRoundCreatedAt
    || 0,
  );
  if (explicit > 0) return explicit;
  const idMatch = String(message?.id || '').match(/^msg_(\d{10,})_/);
  const fromId = Number(idMatch?.[1] || 0);
  return fromId > 0 ? fromId : 0;
}

export function isGuidanceMessageAfterStart(message = {}, startedAt = 0) {
  const boundary = Number(startedAt || 0) || 0;
  if (!boundary) return true;
  const createdAtReal = guidanceMessageCreatedAtReal(message);
  if (createdAtReal > 0) return createdAtReal >= boundary;
  // 兼容没有真实创建时间的旧备份；新消息优先使用 msg_<Date.now()> 或 aiRoundCreatedAt，
  // 避免把可被时间机器改写的聊天时间与设备时间直接比较。
  return Number(message.timestamp || 0) >= boundary;
}

function compareGuidanceSessionMessages(left = {}, right = {}) {
  const leftCreatedAt = guidanceMessageCreatedAtReal(left);
  const rightCreatedAt = guidanceMessageCreatedAtReal(right);
  // 指导讨论发生在应用现实中，不属于剧情时间线。两边都有真实创建时刻时，
  // 必须按实际问答轮次排列；否则多气泡的剧情时间交错会让后发问题回弹到回复后面。
  if (leftCreatedAt > 0 && rightCreatedAt > 0 && leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }
  // 同一 AI 回合的气泡共用 aiRoundCreatedAt，轮内继续沿用分配好的气泡时间。
  // 缺少真实创建时刻的旧备份也以 timestamp 作为兼容回退。
  const timestampDiff = Number(left.timestamp || 0) - Number(right.timestamp || 0);
  if (timestampDiff) return timestampDiff;
  return String(left.id || '').localeCompare(String(right.id || ''));
}

/** 请求历史、退出勾选和最终保存共用同一条“本次指导会话”边界。 */
export function selectGuidanceSessionMessages(messages = [], { startedAt = 0 } = {}) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => (
      message
      && !message.deleted
      && !message.recalled
      && isGuidanceMessage(message)
      && isGuidanceMessageAfterStart(message, startedAt)
    ))
    .sort(compareGuidanceSessionMessages);
}

/**
 * 指导模式聊天框只展示当前这次指导，并把它作为普通聊天之后的一段独立讨论。
 * 旧指导不能在再次进入模式时按历史时间戳散落回普通消息之间。
 */
export function selectGuidanceDisplayMessages(messages = [], { startedAt = 0 } = {}) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && !message.deleted);
  const roleplayRows = list.filter((message) => !isGuidanceMessage(message));
  const guidanceRows = selectGuidanceSessionMessages(list, { startedAt });
  return [...roleplayRows, ...guidanceRows];
}

/** 普通扮演 / 社媒 / 摘要等链路统一剔除指导气泡 */
export function filterNonGuidanceMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).filter((m) => m && !isGuidanceMessage(m));
}

/** 群聊、旁观群聊和角色间侧窗使用会话级指导，避免误存到其中某一个角色名下。 */
export function guidanceChatScopeId(chatId = '') {
  const id = String(chatId || '').trim();
  return id ? `guidance-chat:${id}` : '';
}

export async function listGuidanceMemoriesForCharacter(characterId, userId, options = {}) {
  const cid = String(characterId || '').trim();
  if (!cid) return [];
  const rows = await db.getAllByIndex('memories', 'characterId', cid);
  const uid = String(userId || '').trim();
  const list = (Array.isArray(rows) ? rows : [])
    .filter((m) => m && isGuidanceMemory(m) && (!m.userId || !uid || m.userId === uid))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return options.includeArchived === false
    ? list.filter((row) => guidanceMemoryStatus(row) !== GUIDANCE_STATUS_ARCHIVED)
    : list;
}

export async function saveGuidanceMemory({
  characterId,
  userId,
  content,
  chatId = '',
  sourceMessageIds = [],
  distilled = false,
} = {}) {
  const body = String(content || '').trim();
  const cid = String(characterId || '').trim();
  if (!body || !cid) throw new Error('指导内容与角色不能为空');
  const mem = createMemory({
    chatId: String(chatId || '').trim(),
    characterId: cid,
    userId: String(userId || '').trim(),
    type: GUIDANCE_MEMORY_TYPE,
    category: GUIDANCE_MEMORY_TYPE,
    content: body,
    importance: 'high',
    source: GUIDANCE_MEMORY_SOURCE,
    timestamp: await getNowForUser(String(userId || '').trim()),
  });
  mem.guidanceStatus = GUIDANCE_STATUS_ACTIVE;
  mem.guidancePinned = false;
  mem.guidanceScope = 'persistent';
  mem.guidanceDistilled = distilled === true;
  const ids = Array.isArray(sourceMessageIds)
    ? sourceMessageIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  if (ids.length) mem.sourceMessageIds = ids;
  await db.putRecord('memories', mem);
  return mem;
}

function normalizeScopedGuidanceEntry(raw = {}, { remainingTurns = 0 } = {}) {
  const content = cleanGuidanceText(raw?.content || '');
  if (!content) return null;
  const entry = {
    content: clipGuidanceText(content, 6000),
    createdAt: Math.max(0, Number(raw?.createdAt || Date.now()) || Date.now()),
  };
  if (remainingTurns > 0) {
    entry.remainingTurns = Math.max(1, Math.min(24, Math.floor(Number(raw?.remainingTurns || remainingTurns) || remainingTurns)));
  }
  return entry;
}

/**
 * 一次性与本段指导保存在会话偏好中，不进入长期记忆库。
 * 一次性指导只在下一次重 roll 时注入；本段指导按成功生成轮数自动衰减。
 */
export function buildScopedGuidancePromptBlock(prefs = {}, { mode = 'advance' } = {}) {
  const reroll = String(mode || '').toLowerCase().includes('reroll');
  const oneShot = reroll ? normalizeScopedGuidanceEntry(prefs?.guidancePendingReroll) : null;
  const scene = normalizeScopedGuidanceEntry(prefs?.guidanceScene, {
    remainingTurns: GUIDANCE_SCENE_DEFAULT_TURNS,
  });
  const sections = [];
  if (oneShot) sections.push(`【仅用于本次重写】\n${oneShot.content}`);
  if (scene) sections.push(`【仅在当前片段生效 · 剩余 ${scene.remainingTurns} 轮】\n${scene.content}`);
  if (!sections.length) return '';
  return [
    '【临时扮演纠偏】',
    '以下是用户刚与 AI 本体完成的纠偏讨论。只落实其中已经达成的表演结论，不要在角色气泡中提到、引用、复述或回应这段讨论。',
    '其中出现的台词、动作、脸红、心跳等例子只用于说明被纠正的那个情境，不代表之后每轮都必须重复；触发条件已经过去时，应自然推进后果或新的反应。',
    ...sections,
  ].join('\n\n');
}

/** 成功生成后消费临时指导；返回可直接交给 patchChatPrefs 的浅补丁。 */
export function scopedGuidanceSuccessPatch(prefs = {}, { mode = 'advance' } = {}) {
  const patch = {};
  const reroll = String(mode || '').toLowerCase().includes('reroll');
  if (reroll && normalizeScopedGuidanceEntry(prefs?.guidancePendingReroll)) {
    patch.guidancePendingReroll = null;
  }
  const scene = normalizeScopedGuidanceEntry(prefs?.guidanceScene, {
    remainingTurns: GUIDANCE_SCENE_DEFAULT_TURNS,
  });
  if (scene) {
    patch.guidanceScene = scene.remainingTurns <= 1
      ? null
      : { ...scene, remainingTurns: scene.remainingTurns - 1 };
  }
  return patch;
}

export async function distillGuidanceSession({
  content,
  characterName = '该角色',
} = {}) {
  const source = cleanGuidanceText(content);
  if (!source) throw new Error('没有可整理的指导内容');
  const name = cleanGuidanceText(characterName) || '该角色';
  const prompt = [
    `你在把用户与 AI 本体关于角色「${name}」的一次纠偏讨论，整理成可长期复用的扮演规则。`,
    '只输出整理后的规则，不解释过程，不使用 Markdown 代码围栏。',
    '要求：',
    '- 只保留长期稳定的性格、边界、叙事或表达要求；一次性的剧情安排、当前动作和当场情绪不得写成永久习惯。',
    '- 讨论里的示例台词和动作只用于理解，不要照抄；尤其不要把脸红、心跳、沉默、回避等单次反应写成每轮必须重复。',
    '- 必须写清适用条件；条件过去后允许剧情自然推进。',
    '- 不保留“用户说 / 本体说 / 指导模式 / OOC”等讨论痕迹。',
    '- 没有足够依据成为长期规则的内容直接舍弃，不要补设定。',
    '- 控制在 80～900 个中文字符。建议结构：规则、适用条件、避免；没有内容的栏目省略。',
    '',
    '待整理讨论：',
    clipGuidanceText(source, 12000),
  ].join('\n');
  const result = await chatForTask(
    [{ role: 'user', content: prompt }],
    { temperature: 0.15 },
    'materialCompress',
  );
  const distilled = sanitizeDistilledGuidance(result);
  if (!distilled) throw new Error('AI 没有整理出可保存的长期规则');
  return distilled;
}

export async function updateGuidanceMemory(id, content) {
  const memId = String(id || '').trim();
  if (!memId) throw new Error('memory id required');
  const existing = await db.getRecord('memories', memId);
  if (!existing || !isGuidanceMemory(existing)) throw new Error('指导记忆不存在');
  const body = String(content || '').trim();
  if (!body) throw new Error('内容不能为空');
  const next = {
    ...existing,
    content: body,
    timestamp: await getNowForUser(existing.userId),
  };
  await db.putRecord('memories', next);
  return next;
}

export async function setGuidanceMemoryStatus(id, status = GUIDANCE_STATUS_ACTIVE) {
  const memId = String(id || '').trim();
  const nextStatus = [GUIDANCE_STATUS_ACTIVE, GUIDANCE_STATUS_DISABLED, GUIDANCE_STATUS_ARCHIVED]
    .includes(String(status || '').trim())
    ? String(status).trim()
    : GUIDANCE_STATUS_ACTIVE;
  const existing = await db.getRecord('memories', memId);
  if (!existing || !isGuidanceMemory(existing)) throw new Error('指导记忆不存在');
  const next = {
    ...existing,
    guidanceStatus: nextStatus,
    guidanceStatusUpdatedAt: Date.now(),
  };
  await db.putRecord('memories', next);
  return next;
}

export async function setGuidanceMemoryPinned(id, pinned = false) {
  const memId = String(id || '').trim();
  const existing = await db.getRecord('memories', memId);
  if (!existing || !isGuidanceMemory(existing)) throw new Error('指导记忆不存在');
  const next = {
    ...existing,
    guidancePinned: pinned === true,
    timestamp: await getNowForUser(existing.userId),
  };
  await db.putRecord('memories', next);
  return next;
}

export async function deleteGuidanceMemory(id) {
  const memId = String(id || '').trim();
  if (!memId) return;
  await db.deleteRecord('memories', memId);
}

export function selectGuidanceMemoriesForPrompt(list = [], {
  limit = 12,
  budgetChars = GUIDANCE_PROMPT_BUDGET_CHARS,
  maxItemChars = 1400,
} = {}) {
  const cap = Math.max(1, Math.floor(Number(limit) || 12));
  const budget = Math.max(400, Math.floor(Number(budgetChars) || GUIDANCE_PROMPT_BUDGET_CHARS));
  const rows = (Array.isArray(list) ? list : [])
    .filter(isActiveGuidanceMemory)
    .sort((left, right) => (
      Number(right.guidancePinned === true) - Number(left.guidancePinned === true)
      || Number(right.timestamp || 0) - Number(left.timestamp || 0)
    ));
  const selected = [];
  let used = 0;
  for (const row of rows) {
    const remaining = budget - used;
    if (remaining < 80) break;
    const content = clipGuidanceText(row.content, Math.min(maxItemChars, remaining));
    if (!content) continue;
    selected.push({ ...row, promptContent: content });
    used += content.length;
    if (selected.length >= cap) break;
  }
  return selected;
}

export function sanitizeDistilledGuidance(value = '') {
  return cleanGuidanceText(value)
    .replace(/^```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<<<THINKING>>>[\s\S]*?<<<END_THINKING>>>/gi, '')
    .trim()
    .slice(0, 2200);
}

export async function distillGuidanceMemories({
  characterId,
  userId,
  memoryIds = [],
  characters = {},
} = {}) {
  const wanted = new Set((Array.isArray(memoryIds) ? memoryIds : []).map(String).filter(Boolean));
  if (wanted.size < 2) throw new Error('请至少选择两条指导记忆');
  const all = await listGuidanceMemoriesForCharacter(characterId, userId);
  const selected = all
    .filter((row) => wanted.has(String(row.id)) && guidanceMemoryStatus(row) !== GUIDANCE_STATUS_ARCHIVED)
    .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
  if (selected.length < 2) throw new Error('可提炼的指导记忆不足两条');
  const name = resolveCharacterAiContextName(characterId, characters) || '该角色';
  const source = selected.map((row, index) => (
    `【记录 ${index + 1}｜${row.guidancePinned ? '已置顶' : '普通'}】\n${cleanGuidanceText(row.content)}`
  )).join('\n\n');
  const prompt = [
    `你在整理用户针对角色「${name}」积累的扮演指导。`,
    '任务：将下列多条记录去重、消除讨论过程和客套话，合并成一条可直接约束后续扮演的短指导。',
    '要求：',
    '- 只保留来源中明确出现的要求，不自行补设定。',
    '- 重复要求合并；发生冲突时以时间更靠后的记录为准。',
    '- 用具体、可执行的措辞，不写“注意人物性格”“保持自然”之类空话。',
    '- 总长控制在 300～1200 个中文字符；没有内容的栏目不要输出。',
    '- 只输出整理结果，不要解释过程，不要 Markdown 代码围栏。',
    '可用结构：',
    '【必须遵守】',
    '- …',
    '【避免】',
    '- …',
    '【表现目标】',
    '- …',
    '【必要示例】',
    '- …',
    '',
    '待整理记录：',
    source,
  ].join('\n');
  const result = await chatForTask(
    [{ role: 'user', content: prompt }],
    { temperature: 0.2 },
    'materialCompress',
  );
  const distilled = sanitizeDistilledGuidance(result);
  if (!distilled) throw new Error('AI 没有返回可用的提炼结果');
  return { content: distilled, sourceMemories: selected };
}

export async function saveDistilledGuidanceMemory({
  characterId,
  userId,
  content,
  sourceMemoryIds = [],
  chatId = '',
} = {}) {
  const body = sanitizeDistilledGuidance(content);
  const cid = String(characterId || '').trim();
  const sourceIds = [...new Set((Array.isArray(sourceMemoryIds) ? sourceMemoryIds : [])
    .map(String).filter(Boolean))];
  if (!cid || !body || sourceIds.length < 2) throw new Error('提炼内容或来源不足');
  const originals = [];
  for (const id of sourceIds) {
    const row = await db.getRecord('memories', id).catch(() => null);
    if (row && isGuidanceMemory(row) && String(row.characterId || '') === cid) originals.push(row);
  }
  if (originals.length < 2) throw new Error('原指导记录已发生变化，请重新选择');
  const consolidated = createMemory({
    chatId: String(chatId || originals[originals.length - 1]?.chatId || '').trim(),
    characterId: cid,
    userId: String(userId || '').trim(),
    type: GUIDANCE_MEMORY_TYPE,
    category: GUIDANCE_MEMORY_TYPE,
    content: body,
    importance: 'high',
    source: GUIDANCE_MEMORY_SOURCE,
  });
  consolidated.guidanceStatus = GUIDANCE_STATUS_ACTIVE;
  consolidated.guidancePinned = originals.some((row) => row.guidancePinned === true);
  consolidated.guidanceDistilled = true;
  consolidated.sourceMemoryIds = originals.map((row) => row.id);
  const now = Date.now();
  const archived = originals.map((row) => ({
    ...row,
    guidanceStatus: GUIDANCE_STATUS_ARCHIVED,
    guidanceStatusUpdatedAt: now,
    archivedAt: now,
    archivedByGuidanceId: consolidated.id,
  }));
  await db.putMany('memories', [...archived, consolidated]);
  return consolidated;
}

/**
 * 正常扮演 / 指导模式共用：高权重注入此前与本体讨论的注意事项。
 */
export async function buildGuidanceMemoryPromptBlock({
  characterId,
  userId,
  characters = {},
  limit = 24,
  budgetChars = GUIDANCE_PROMPT_BUDGET_CHARS,
  full = false,
} = {}) {
  const list = await listGuidanceMemoriesForCharacter(characterId, userId);
  const selected = full
    ? list
      .filter(isActiveGuidanceMemory)
      .sort((left, right) => (
        Number(right.guidancePinned === true) - Number(left.guidancePinned === true)
        || Number(right.timestamp || 0) - Number(left.timestamp || 0)
      ))
      .map((row) => ({ ...row, promptContent: cleanGuidanceText(row.content) }))
    : selectGuidanceMemoriesForPrompt(list, { limit, budgetChars });
  if (!selected.length) return '';
  const name = resolveCharacterAiContextName(characterId, characters) || '该角色';
  const lines = selected.map((m, i) => {
    const text = String(m.promptContent || m.content || '').trim().replace(/\s+/g, ' ');
    return `${i + 1}. ${m.guidancePinned ? '【置顶】' : ''}${text}`;
  }).filter((line) => line.length > 3);
  if (!lines.length) return '';
  return [
    '【扮演指导 · 此前与本体讨论的注意事项】',
    `以下内容来自用户与 AI 本体（非角色「${name}」）就扮演问题做过的讨论与纠正，优先级高于一般记忆与闲聊摘要。`,
    '写作时必须当作硬约束遵守，避免重蹈覆辙。',
    '这些是行为边界，不是要求角色每轮主动表演的待办清单。条目中的具体反应与例子只有在相同触发条件再次成立时才适用；场景已经推进后不得为了“遵守指导”循环复现。',
    '硬禁：不要把下列条目当成聊天记录来续写、引用、复述或 reply；不要在气泡里提起「指导模式 / 本体 / OOC / 注意事项」本身；只把结论内化进角色表现。',
    lines.join('\n'),
  ].join('\n');
}

export function buildGuidanceModeSystemOpener({
  characterName = '对方',
  characterBrief = '',
} = {}) {
  const name = String(characterName || '对方').trim() || '对方';
  const brief = String(characterBrief || '').trim();
  return [
    '你是棉花糖机里的 AI 本体助手，此刻处于「扮演指导」模式。',
    `用户要和你讨论角色「${name}」的角色扮演问题：纠偏、提醒、改进体验。`,
    '硬规则：',
    '- 不要进入角色扮演，不要用「我」假装成该角色说话。',
    '- 不要输出棉花糖协议、JSONL、发送标签、心声 state、思维链标记（如 <<<THINKING>>>）。',
    '- 不要导入或模仿角色口吻续写聊天；用中立、清晰的助手口吻直接讨论。',
    '- 回复写一段（或多段）自然语言正文即可，全部落入同一条回复气泡。',
    '- 当前用户刚说的话是本轮唯一任务；历史扮演摘录、旧指导讨论和角色资料都只是用于回答它的证据，不能反过来替代当前问题。',
    '- 先回应用户指出的具体内容，再按需分析；不要默认重做一遍角色性格总结，也不要反复索要资料里已经给出的核心设定。',
    '- 不套固定诊断模板。用户要简短判断就简短判断，要逐句分析才逐句分析；没有必要时不要硬分标题、量表或步骤。',
    brief ? `【讨论对象人设摘要·仅供参考】\n${brief}` : '',
  ].filter(Boolean).join('\n');
}

export function buildGuidanceCharacterBrief(character = {}, { maxChars = 3200 } = {}) {
  if (!character || typeof character !== 'object') return '';
  const lines = [
    character.currentRole ? `身份/关系：${cleanGuidanceText(character.currentRole)}` : '',
    character.currentStatus ? `当前状态：${cleanGuidanceText(character.currentStatus)}` : '',
    character.userRelationStatus ? `与用户当前关系：${cleanGuidanceText(character.userRelationStatus)}` : '',
    character.personality ? `性格：${cleanGuidanceText(character.personality)}` : '',
    character.speechStyle ? `说话风格：${cleanGuidanceText(character.speechStyle)}` : '',
    character.speechCorpus ? `口吻样例：${cleanGuidanceText(character.speechCorpus)}` : '',
    character.promptCorpus ? `核心设定：${cleanGuidanceText(character.promptCorpus)}` : '',
    character.notes ? `备注：${cleanGuidanceText(character.notes)}` : '',
  ].filter(Boolean);
  const text = lines.join('\n');
  const limit = Math.max(600, Math.floor(Number(maxChars) || 3200));
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 18)).trim()}\n…（角色资料已截断）`;
}

export function formatMessagesAsGuidanceNote(messages = [], {
  userName = '用户',
  characterName = '角色',
} = {}) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.deleted && !m.recalled)
    .map((m) => {
      const body = String(m.content || '').trim();
      if (!body) return '';
      let who = '旁白';
      if (m.senderId === 'user') who = userName;
      else if (isGuidanceMessage(m) || m.senderId === GUIDANCE_SENDER_ID) who = '本体';
      else who = characterName;
      return `${who}：${body}`;
    })
    .filter(Boolean)
    .join('\n');
}
