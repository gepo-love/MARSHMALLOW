import { chatForTask } from './api.js';
import { resolveCharacterAiRoute } from './character-ai-fill.js';
import { buildWorldBookContextBlock } from './world-book-store.js';
import { createCharacterProfile } from '../models/character.js';

const USER_AI_FIELDS = [
  ['name', '姓名', false],
  ['nickname', '昵称', false],
  ['preferredCallName', '角色称呼', false],
  ['gender', '性别', false],
  ['pronouns', '第三人称代词', false],
  ['birthday', '生日', false],
  ['virtualCity', '所在城市', false],
  ['realCityMap', '映射现实城市', false],
  ['signature', '个性签名', false],
  ['hobbies', '兴趣爱好', true],
  ['dislikes', '雷点', true],
  ['persona', '人物设定', true],
  ['appearancePrompt', '生图外观描述', true],
];

function clean(value = '', max = 8000) {
  return String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
}

function parseJsonPayload(raw = '') {
  const text = clean(raw, 100000);
  if (!text) return null;
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstObject = text.indexOf('{');
  const lastObject = text.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(text.slice(firstObject, lastObject + 1));
  const firstArray = text.indexOf('[');
  const lastArray = text.lastIndexOf(']');
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(text.slice(firstArray, lastArray + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch (_) {}
  }
  return null;
}

function compactUser(user = {}) {
  const out = {};
  USER_AI_FIELDS.forEach(([key]) => {
    const value = clean(user?.[key], key === 'persona' ? 5000 : 800);
    if (value && !(key === 'name' && value === '用户')) out[key] = value;
  });
  return out;
}

function compactRelatedCharacter(character = {}) {
  return {
    id: clean(character.id, 100),
    name: clean(character.realName || character.name, 80),
    currentRole: clean(character.currentRole, 160),
    personality: clean(character.personality, 500),
    userRelationStatus: clean(character.userRelationStatus, 240),
  };
}

async function selectedWorldBookContext(user, description, worldBookIds = [], characterIds = []) {
  const ids = [...new Set((worldBookIds || []).map((id) => clean(id, 120)).filter(Boolean))];
  if (!ids.length) return '';
  return buildWorldBookContextBlock(user, description, {
    worldBookMode: 'full',
    onlyBookIds: ids,
    restrictToBookIds: true,
    characterIds,
  });
}

async function requestProfileJson(prompt, options = {}) {
  const route = await resolveCharacterAiRoute();
  if (!route.available) throw new Error('请先在设置中配置聊天或工具 API');
  const response = await chatForTask([
    { role: 'system', content: prompt },
    { role: 'user', content: '请按上述完整资料生成本次档案 JSON。' },
  ], {
    temperature: Number(options.temperature ?? 0.65),
    stream: route.requestStream === true,
    signal: options.signal,
    maxTokens: options.maxTokens || 12000,
  }, 'characterFill');
  const parsed = parseJsonPayload(response);
  if (!parsed) {
    const error = new Error('AI 返回格式无效，请重试');
    error.rawResponse = String(response || '');
    throw error;
  }
  return parsed;
}

export async function generateCharacterBatch(options = {}) {
  const count = Math.max(1, Math.min(12, Math.round(Number(options.count) || 1)));
  const description = clean(options.description, 5000);
  const user = options.user || {};
  const relatedCharacters = (Array.isArray(options.relatedCharacters) ? options.relatedCharacters : [])
    .filter((row) => row?.id)
    .slice(0, 20);
  const worldBook = await selectedWorldBookContext(
    user,
    description,
    options.worldBookIds,
    relatedCharacters.map((row) => row.id),
  );
  const existingNames = (Array.isArray(options.existingCharacters) ? options.existingCharacters : [])
    .map((row) => clean(row?.realName || row?.name, 80))
    .filter(Boolean)
    .slice(0, 160);
  const prompt = [
    '背景与任务：为通讯录批量创建可长期使用的原创角色草稿。',
    `必须生成恰好 ${count} 位角色，彼此有明显差异，但共同符合用户指定的世界与关系范围。`,
    '不要使用任何旧作品、战队、赛季或商业 IP 设定。不要替用户决定已经发生过的共同经历。',
    '用户身份：',
    JSON.stringify(compactUser(user)),
    description ? `用户要求：\n${description}` : '用户要求：围绕现有资料自然补足一组角色。',
    worldBook ? `所选世界书（必须遵守）：\n${worldBook}` : '本次未绑定世界书，不要擅自套用其它世界书。',
    relatedCharacters.length
      ? `指定相关角色（可建立合理关系，relationships 必须使用这里的 id）：\n${JSON.stringify(relatedCharacters.map(compactRelatedCharacter))}`
      : '本次没有指定相关角色。',
    existingNames.length ? `已有通讯录姓名，禁止重名或近似复刻：${existingNames.join('、')}` : '',
    '只输出 JSON：{"characters":[...]}。每位角色填写 name、realName、gender、pronouns、currentRole、personality、speechStyle、userRelationStatus、currentStatus、promptCorpus、speechCorpus、appearancePrompt、notes、relationships。',
    'name 是通讯录显示名；promptCorpus 写完整但克制的人设；speechCorpus 给 3～6 条符合口吻的短句；relationships 是 {"指定角色id":"关系"}，没有则 {}。',
  ].filter(Boolean).join('\n\n');
  const parsed = await requestProfileJson(prompt, { ...options, maxTokens: Math.max(6000, count * 1800) });
  const rows = Array.isArray(parsed) ? parsed : parsed.characters;
  if (!Array.isArray(rows) || !rows.length) throw new Error('AI 没有返回角色草稿');
  const seen = new Set(existingNames.map((name) => name.toLowerCase()));
  const relatedIds = new Set(relatedCharacters.map((row) => String(row.id)));
  const drafts = [];
  for (const raw of rows.slice(0, count)) {
    if (!raw || typeof raw !== 'object') continue;
    const name = clean(raw.name || raw.realName, 80);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const relationships = {};
    Object.entries(raw.relationships && typeof raw.relationships === 'object' ? raw.relationships : {})
      .forEach(([id, value]) => {
        if (relatedIds.has(String(id)) && clean(value, 240)) relationships[String(id)] = clean(value, 240);
      });
    drafts.push(createCharacterProfile({
      ...raw,
      id: undefined,
      name,
      realName: clean(raw.realName || name, 80),
      groupId: clean(options.groupId, 120) || 'default',
      relationships,
      isCustom: true,
    }));
  }
  if (!drafts.length) throw new Error('AI 返回的角色都与现有通讯录重名，请重试');
  return drafts;
}

export async function generateUserProfileDraft(options = {}) {
  const description = clean(options.description, 5000);
  const user = options.user || {};
  if (!description && !Object.keys(compactUser(user)).length) throw new Error('请先输入一点身份描述');
  const worldBook = await selectedWorldBookContext(user, description, options.worldBookIds, []);
  const prompt = [
    '背景与任务：根据用户的简要描述，为当前 User 身份补全资料草稿。',
    '只补全用户本人，不要生成角色，不要虚构已经发生过的共同经历。已有字段保持原意。',
    `现有 User 资料：${JSON.stringify(compactUser(user))}`,
    `用户描述：${description || '请依据现有资料补足空白。'}`,
    worldBook ? `所选世界书（用于约束身份与世界观）：\n${worldBook}` : '本次不绑定世界书，不要读取或套用其它世界书。',
    `只输出一个 JSON 对象，可用字段：${USER_AI_FIELDS.map(([key]) => key).join('、')}。`,
    'persona 应是可直接给 AI 使用的人物设定，包含稳定性格、生活背景、行为偏好和边界；不要写教程或解释。',
  ].join('\n\n');
  const parsed = await requestProfileJson(prompt, options);
  const source = parsed.user && typeof parsed.user === 'object' ? parsed.user : parsed;
  const draft = {};
  USER_AI_FIELDS.forEach(([key]) => {
    const value = clean(source?.[key], key === 'persona' ? 6000 : 1200);
    if (value) draft[key] = value;
  });
  if (!Object.keys(draft).length) throw new Error('AI 没有返回可用的 User 资料');
  return draft;
}

export function buildUserAiReviewFields(current = {}, draft = {}) {
  return USER_AI_FIELDS.flatMap(([key, label, multiline]) => {
    const existing = clean(current?.[key]);
    const value = clean(draft?.[key]);
    const empty = !existing || (key === 'name' && existing === '用户');
    return value && empty ? [{ id: key, label, value, multiline }] : [];
  });
}
