import { listCharacters, getCharacter, saveCharacter, deleteCharacter } from './character-store.js';
import { createCharacterProfile } from '../models/character.js';
import { loadContactGroupsConfig, saveContactGroupsConfig } from './contact-groups.js';
import { chat, chatForTask, getConfig } from './api.js';
import { isCharacterAiAvailable } from './character-ai-fill.js';
import { getCharacterAiContextName } from '../models/character.js';

export const ANON_NPC_GROUP_ID = 'anon_npc';
export const ANON_NPC_GROUP_NAME = '匿名NPC';

export function isAnonymousNpcCharacter(character) {
  return !!character && String(character.groupId || '').trim() === ANON_NPC_GROUP_ID;
}

export async function ensureAnonNpcGroup() {
  const config = await loadContactGroupsConfig();
  if (!config.groups.some((g) => g.id === ANON_NPC_GROUP_ID)) {
    config.groups.push({ id: ANON_NPC_GROUP_ID, name: ANON_NPC_GROUP_NAME });
    await saveContactGroupsConfig(config);
  }
}

function clean(value = '') {
  return String(value ?? '').trim();
}

function extractJson(text) {
  const raw = clean(text);
  if (!raw) return null;
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch (_) { return null; }
  };
  const relaxed = raw.replace(/,\s*([}\]])/g, '$1');
  let parsed = tryParse(raw) || tryParse(relaxed);
  if (parsed) return parsed;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    parsed = tryParse(fence[1].trim()) || tryParse(fence[1].replace(/,\s*([}\]])/g, '$1').trim());
    if (parsed) return parsed;
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = raw.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
    parsed = tryParse(slice);
    if (parsed) return parsed;
  }
  return null;
}

function sanitizeMask(value = '', fallback = '') {
  let s = clean(value).replace(/["'`@#]/g, '').replace(/\s+/g, '');
  if (s.length > 12) s = s.slice(0, 12);
  return s || fallback;
}

function characterAliasLookupKeys(character = {}) {
  const id = clean(character.id);
  const keys = new Set();
  if (id) keys.add(id);
  for (const name of [
    character.name,
    character.realName,
    character.customNickname,
    ...(Array.isArray(character.aliases) ? character.aliases : []),
  ]) {
    const key = clean(name);
    if (key) keys.add(key);
  }
  return [...keys];
}

function resolveAliasRowForCharacter(aliasMap = {}, character = {}) {
  const map = aliasMap && typeof aliasMap === 'object' ? aliasMap : {};
  const keys = characterAliasLookupKeys(character);
  for (const key of keys) {
    if (map[key]) return map[key];
  }
  const lowerEntries = Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]);
  for (const key of keys) {
    const hit = lowerEntries.find(([k]) => k === key.toLowerCase());
    if (hit) return hit[1];
  }
  const id = clean(character.id);
  if (id) {
    const partial = Object.entries(map).find(([k]) => k.includes(id) || id.includes(k));
    if (partial) return partial[1];
  }
  return null;
}

function buildAliasCharacterLine(character = {}) {
  const id = clean(character.id);
  if (!id) return '';
  const label = getCharacterAiContextName(character, id);
  const bits = [
    character.gender ? `性别：${clean(character.gender)}` : '',
    character.currentRole ? `身份底色：${clean(character.currentRole)}` : '',
    character.currentStatus ? `当前状态：${clean(character.currentStatus)}` : '',
    character.userRelationStatus ? `与用户关系：${clean(character.userRelationStatus)}` : '',
    character.personality ? `性格：${clean(character.personality)}` : '',
    character.speechStyle ? `口吻：${clean(character.speechStyle)}` : '',
    character.promptCorpus ? `完整角色设定：${clean(character.promptCorpus)}` : '',
    character.speechCorpus ? `完整语料：${clean(character.speechCorpus)}` : '',
    character.notes ? `备注：${clean(character.notes)}` : '',
  ].filter(Boolean);
  return `- actorId=${id}（仅供你理解，JSON key 必须写 ${id}；角色：${label}）\n  ${bits.join('；') || '人设资料较少，请按气质自拟不撞名的马甲'}`;
}

async function requestAliasJson({
  requirements,
  task,
  temperature = 0.92,
  useMainApi = false,
} = {}) {
  const request = useMainApi
    ? (messages, options) => chat(messages, options)
    : (messages, options) => chatForTask(messages, options, 'anonymousAlias');
  const response = await request(
    [
      { role: 'system', content: requirements },
      { role: 'user', content: task },
    ],
    { temperature },
  );
  return extractJson(response);
}

function mapAliasesFromParsed(parsed, rows = [], reservedHandles = []) {
  const map = parsed?.aliases && typeof parsed.aliases === 'object'
    ? parsed.aliases
    : (parsed && typeof parsed === 'object' ? parsed : {});
  const out = {};
  const used = new Set(
    (Array.isArray(reservedHandles) ? reservedHandles : [])
      .map((h) => clean(h).toLowerCase())
      .filter(Boolean),
  );
  for (const c of rows) {
    const row = resolveAliasRowForCharacter(map, c);
    if (!row) continue;
    let mask = sanitizeMask(row.currentId || row.name || row.handle, '');
    if (!mask) continue;
    while (used.has(mask.toLowerCase())) mask = `${mask}${used.size + 1}`;
    used.add(mask.toLowerCase());
    out[c.id] = {
      currentId: mask,
      signature: clean(row.signature || row.bio) || `${mask}，刚进房`,
    };
  }
  return out;
}

/**
 * 让 AI 现场捏造一批匿名路人网友：互不相识、各有性格、马甲不继承任何真实身份。
 * @returns {Promise<Array<{anonymousId,personality,speechStyle,signature,privateDraft}>>}
 */
export async function generateAnonymousNpcProfiles({
  count = 1,
  vibe = '',
  worldview = '',
  roomTopic = '',
  gender = 'random',
  direction = '',
  reservedHandles = [],
} = {}) {
  const n = Math.max(1, Math.min(6, Number(count) || 1));
  if (!(await isCharacterAiAvailable())) {
    const err = new Error('请先在设置里配置聊天或工具 API 才能生成路人');
    err.code = 'api-not-configured';
    throw err;
  }
  const reserved = [...new Set(
    (Array.isArray(reservedHandles) ? reservedHandles : [])
      .map((h) => clean(h))
      .filter(Boolean),
  )];
  const requirements = [
    '背景设定与生成要求：',
    '- 你在为一个匿名聊天室现场捏造几名临时路人网友（NPC）。他们彼此、以及与用户都互不相识，只是随机被拼进同一个房间的陌生网友。',
    '- 每个路人都是独立的陌生人：网名、性格、说话风格各不相同，不要写成同一种「水群网友」模板，不要趋同。',
    '- 网名(anonymousId)是匿名马甲：2-6 个字，可中文、可带轻符号，但绝不能是真实姓名、联系方式或任何可定位信息，也不能套用任何已知作品角色或真实人物。',
    reserved.length
      ? `- 【硬性】网名绝对不能与用户已有马甲撞名或近似：${reserved.join('、')}`
      : '',
    '- 路人只活在这个房间，不要引用真实 IP、作品、明星、品牌。',
    '- 同时为每人准备一份仅在本人愿意掉马后才可见的简略底稿；底稿不能包含联系方式、精确地址或可定位信息。',
    roomTopic ? `- 房间主题：${roomTopic}` : '',
    vibe ? `- 路人整体氛围/性格倾向：${vibe}` : '',
    worldview ? `- 房间世界观/设定（路人需要自洽地融入，但仍是普通匿名网友）：${worldview}` : '',
    gender && gender !== 'random' ? `- 这位路人的性别方向：${gender}` : '- 性别方向：随机，不需要强调或刻板化。',
    direction ? `- 用户希望匹配到的方向：${direction}` : '',
  ].filter(Boolean).join('\n');
  const task = [
    `本次任务：生成 ${n} 名互不相同的匿名路人网友。`,
    '输出 JSON 格式（只输出这个 JSON，不要解释、不要 Markdown）：',
    '{"npcs":[{"anonymousId":"房内马甲网名","personality":"一句话性格底色","speechStyle":"说话风格/语气","signature":"一句话匿名签名","privateDraft":{"realName":"掉马后使用的名字","currentRole":"模糊身份","background":"一两句背景","interests":["兴趣"],"revealNote":"愿意相认时会怎么说"}}]}',
  ].join('\n');
  const response = await chatForTask(
    [
      { role: 'system', content: requirements },
      { role: 'user', content: task },
    ],
    { temperature: 0.95 },
    'anonymousNpc',
  );
  const parsed = extractJson(response);
  const rows = Array.isArray(parsed?.npcs) ? parsed.npcs : (Array.isArray(parsed) ? parsed : []);
  const out = [];
  const used = new Set(reserved.map((h) => h.toLowerCase()));
  for (const row of rows) {
    if (out.length >= n) break;
    let mask = sanitizeMask(row?.anonymousId || row?.name || row?.handle, `路人${out.length + 1}`);
    while (used.has(mask.toLowerCase())) mask = `${mask}${out.length + 1}`;
    used.add(mask.toLowerCase());
    out.push({
      anonymousId: mask,
      personality: clean(row?.personality) || '随机进来的陌生网友，话不多。',
      speechStyle: clean(row?.speechStyle) || '短句、随意。',
      signature: clean(row?.signature) || `${mask}，路过`,
      privateDraft: {
        realName: clean(row?.privateDraft?.realName || row?.realName).slice(0, 40),
        currentRole: clean(row?.privateDraft?.currentRole || row?.role).slice(0, 80),
        background: clean(row?.privateDraft?.background || row?.background).slice(0, 300),
        interests: Array.isArray(row?.privateDraft?.interests)
          ? row.privateDraft.interests.map(clean).filter(Boolean).slice(0, 8)
          : [],
        revealNote: clean(row?.privateDraft?.revealNote).slice(0, 160),
        gender: clean(row?.privateDraft?.gender || row?.gender || gender).slice(0, 16),
      },
    });
  }
  if (!out.length) throw new Error('AI 没有生成出可用的路人，请重试');
  return out;
}

/**
 * 把生成的路人落库到隐藏的【匿名NPC】分组（默认不参与日常匹配）。
 * ephemeral=true 时记录归属房间，删除房间时一并清掉。
 * @returns {Promise<Array<{actorId,anonymousId,signature}>>}
 */
export async function persistAnonymousNpcs(profiles = [], options = {}) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (!list.length) return [];
  await ensureAnonNpcGroup();
  const out = [];
  for (const p of list) {
    const mask = clean(p?.anonymousId) || '路人';
    const profile = createCharacterProfile({
      name: mask,
      groupId: ANON_NPC_GROUP_ID,
      roleTier: 'npc',
      currentRole: '匿名网友',
      personality: clean(p?.personality),
      speechStyle: clean(p?.speechStyle),
      notes: clean(p?.signature),
      anonymousLifecycle: {
        phase: 'temporary',
        retained: options.ephemeral !== true,
        sourceChatIds: Array.isArray(options.sourceChatIds) ? options.sourceChatIds : [],
      },
      anonymousPrivateDraft: p?.privateDraft && typeof p.privateDraft === 'object' ? p.privateDraft : {},
      isCustom: true,
    });
    const saved = await saveCharacter(profile);
    out.push({ actorId: saved.id, anonymousId: mask, signature: clean(p?.signature) || `${mask}，路过` });
  }
  return out;
}

/** 将匿名路人留存为可持续私聊对象，避免来源房间销毁时被当作一次性数据清理。 */
export async function retainAnonymousNpc(actorId = '', sourceChatId = '') {
  const id = clean(actorId);
  const row = id ? await getCharacter(id).catch(() => null) : null;
  if (!row || !isAnonymousNpcCharacter(row)) return row;
  const previous = row.anonymousLifecycle || {};
  const sourceChatIds = [...new Set([
    ...(Array.isArray(previous.sourceChatIds) ? previous.sourceChatIds : []),
    clean(sourceChatId),
  ].filter(Boolean))].slice(-20);
  const next = {
    ...row,
    anonymousLifecycle: {
      ...previous,
      phase: previous.phase === 'revealed' ? 'revealed' : 'private',
      retained: true,
      sourceChatIds,
    },
  };
  return saveCharacter(next);
}

/** 彻底删除一位已保留的匿名路人：联系人、匿名空间、聊天、记忆与角色档案一起清理。 */
export async function deleteRetainedAnonymousNpc(userId = '', actorId = '') {
  const uid = clean(userId);
  const aid = clean(actorId);
  if (!uid || !aid) return { deleted: false, reason: 'missing-id' };
  const actor = await getCharacter(aid);
  if (!actor || !isAnonymousNpcCharacter(actor)) {
    return { deleted: false, reason: 'not-anonymous-npc' };
  }
  const [
    { removeAnonymousContact },
    { deleteAnonymousSpaceState },
    { deleteCharacterCascade },
  ] = await Promise.all([
    import('./anonymous-contacts.js'),
    import('./anonymous-space.js'),
    import('./data-hygiene.js'),
  ]);
  await removeAnonymousContact(uid, aid);
  await deleteAnonymousSpaceState(uid, aid);
  const cascade = await deleteCharacterCascade(aid);
  return { deleted: true, actorId: aid, ...cascade };
}

/** 删除某个一次性房间生成的临时路人（用之即弃模式） */
export async function deleteEphemeralNpcsForChat(chat) {
  const ids = Array.isArray(chat?.metadata?.anonymousNpcActorIds) ? chat.metadata.anonymousNpcActorIds : [];
  if (!ids.length || chat?.metadata?.anonymousNpcEphemeral !== true) return;
  for (const id of ids) {
    const row = await getCharacter(id).catch(() => null);
    if (row && isAnonymousNpcCharacter(row) && row.anonymousLifecycle?.retained !== true) {
      await deleteCharacter(id).catch(() => {});
    }
  }
}

/**
 * 开局让 AI 按人设给在场角色重新起一个匿名马甲（贴合性格但不掉马）。
 * @returns {Promise<{aliases:Object, generatedCount:number, requestedCount:number, usedAi:boolean, warning:string}>}
 */
export async function generateAnonymousAliasesForActors(characters = [], options = {}) {
  const rows = (Array.isArray(characters) ? characters : []).filter((c) => c?.id);
  const empty = {
    aliases: {},
    generatedCount: 0,
    requestedCount: rows.length,
    usedAi: false,
    warning: '',
  };
  if (!rows.length) return empty;
  const available = options.useMainApi === true
    ? !!String((await getConfig())?.model || '').trim()
    : await isCharacterAiAvailable();
  if (!available) {
    const warning = options.useMainApi === true
      ? '未配置聊天 API，无法按人设起马甲'
      : '未配置聊天/工具 API，无法按人设起马甲';
    if (options.required === true) {
      const err = new Error(warning);
      err.code = 'api-not-configured';
      throw err;
    }
    return { ...empty, warning };
  }
  const { roomTopic = '', vibe = '', reservedHandles = [] } = options || {};
  const reserved = [...new Set(
    (Array.isArray(reservedHandles) ? reservedHandles : [])
      .map((h) => clean(h))
      .filter(Boolean),
  )];
  const exampleId = rows[0].id;
  const requirements = [
    '背景设定与生成要求：',
    '- 你在为匿名聊天室里的真实角色分配「房内马甲网名」。马甲只用于本房前台，绝不能暴露真名、作品名、联系方式或可定位信息。',
    '- 每个马甲必须贴合该角色的人设、口吻、兴趣或怪癖，一眼能看出性格差异；禁止所有人共用同一种网友模板。',
    '- 禁止套用系统默认拼接词表风格（如晚风汽水、海盐旅人、雾里耳机、空格白噪、半糖候鸟等两词硬拼）；可以是短语、谐音、抽象词、数字混排，但要像真人网名。',
    '- 马甲 2-8 字，可中文为主，可少量符号；签名是一句网友自我介绍，不要写成角色真名自我介绍。',
    reserved.length
      ? `- 【硬性】马甲网名绝对不能与用户已有马甲撞名或近似：${reserved.join('、')}`
      : '',
    roomTopic ? `- 房间主题：${roomTopic}` : '',
    vibe ? `- 房间氛围：${vibe}` : '',
  ].filter(Boolean).join('\n');
  const lines = rows.map((c) => buildAliasCharacterLine(c));
  const task = [
    '本次任务：为下列角色各起一个马甲网名 currentId 和一句匿名签名 signature。',
    '【硬性】JSON 的 aliases 对象 key 必须逐字使用上面给出的 actorId（例如 char_xxx），不要用角色真名/显示名当 key。',
    '角色列表：',
    lines.join('\n'),
    '输出 JSON（只输出 JSON，不要 Markdown）：',
    `{"aliases":{"${exampleId}":{"currentId":"示例网名","signature":"一句签名"}}}`,
  ].join('\n');
  let parsed = null;
  try {
    parsed = await requestAliasJson({
      requirements,
      task,
      temperature: 0.92,
      useMainApi: options.useMainApi === true,
    });
  } catch (err) {
    const warning = `马甲 API 调用失败：${String(err?.message || err || '未知错误')}`;
    if (options.required === true) throw err;
    return { ...empty, warning };
  }
  const aliases = mapAliasesFromParsed(parsed, rows, reserved);
  const generatedCount = Object.keys(aliases).length;
  const usedAi = generatedCount > 0;
  let warning = '';
  if (!generatedCount) {
    warning = '马甲 API 未返回可用结果，已改用本地备选网名';
    if (options.required === true) {
      throw new Error(warning);
    }
  } else if (generatedCount < rows.length) {
    warning = `有 ${rows.length - generatedCount} 位角色马甲未生成，已改用本地备选`;
  }
  return {
    aliases,
    generatedCount,
    requestedCount: rows.length,
    usedAi,
    warning,
  };
}
