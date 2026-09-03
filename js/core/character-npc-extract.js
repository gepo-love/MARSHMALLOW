import { chatJsonGeneration } from './chat-json-generation.js';
import {
  loadCharacterPhoneContacts,
  upsertPhoneContact,
  isPhoneUserImpersonator,
  ensurePhoneSocialActorContact,
} from './character-phone-contacts.js';
import { listCharacters } from './character-store.js';
import {
  createPhoneSocialActorDirectory,
  phoneContactCanonicalActorId,
  resolvePhoneSocialActorDisplayName,
} from './phone-social-actor-directory.js';
import { getUserDisplayName } from '../models/user.js';
import { buildWorldBookContextBlock } from './world-book-store.js';
import {
  loadRelationshipNetwork,
  newCircleId,
  newEdgeId,
  saveRelationshipNetwork,
} from './relationship-network.js';

const CATEGORIES = new Set(['family', 'work', 'friend', 'rival', 'other']);
const GENERATED_SOURCES = new Set([
  'generated', 'suggested', 'suggestion', 'invented', 'extra',
  '生成', '补充建议', '额外生成',
]);
const npcPhoneSaveQueues = new Map();

export const NPC_GENERATION_CATEGORIES = Object.freeze([
  { id: 'family', label: '家人' },
  { id: 'work', label: '工作' },
  { id: 'friend', label: '朋友' },
  { id: 'rival', label: '关系紧张' },
  { id: 'other', label: '其他' },
]);

function clip(value = '', max = 4000) {
  return String(value || '').trim().slice(0, max);
}

export function normalizeNpcGenerationOptions(options = {}) {
  const requested = Array.isArray(options?.categories) ? options.categories : [];
  const categories = [...new Set(requested
    .map((value) => clip(value, 20).toLowerCase())
    .filter((value) => CATEGORIES.has(value)))];
  return {
    count: Math.max(1, Math.min(8, Math.round(Number(options?.count) || 4))),
    categories: categories.length ? categories : NPC_GENERATION_CATEGORIES.map((item) => item.id),
    direction: clip(options?.direction, 300),
  };
}

export function buildNpcGenerationPrompt({
  profile = '',
  worldBook = '',
  existingNames = [],
  formalCharacterNames = [],
  options = {},
} = {}) {
  const normalized = normalizeNpcGenerationOptions(options);
  const categoryLabels = new Map(NPC_GENERATION_CATEGORIES.map((item) => [item.id, item.label]));
  const categoryText = normalized.categories
    .map((id) => `${id}（${categoryLabels.get(id) || id}）`)
    .join('、');
  return `请根据下面的角色卡与设定库，为手机主人创作 ${normalized.count} 位新的临时 NPC 联系人。

【手机主人人设】
${clip(profile, 22000)}

${worldBook ? `【当前世界观】\n${clip(worldBook, 16000)}\n` : ''}
${existingNames.length ? `【手机里已有联系人，不得重复】\n${existingNames.join('、')}\n` : ''}
${formalCharacterNames.length ? `【已经存在的正式角色，不得制造同名替身】\n${formalCharacterNames.join('、')}\n` : ''}
${normalized.direction ? `【用户补充方向】\n${normalized.direction}\n` : ''}
要求：
- 返回恰好 ${normalized.count} 位互不重复的新人物，category 只允许：${categoryText}。
- 这些人物是本次新增的创作，不得伪装成角色卡里已经明确存在的人；但其身份、职业、社会关系、命名方式与生活范围必须符合人设和世界观。
- 多选了不同类型时尽量分散，不要全部挤进同一类；关系要具体到能支持后续私聊、群聊与朋友圈互动。
- 不得生成用户本人、手机主人、已有正式角色、已有联系人、组织、地点、宠物或内部编号。
- name 必须是自然可读的人名或稳定称呼；禁止 char_、npc_、phone-contact 等内部编号。
- remark 是手机主人给对方的可选备注，必须像真实通讯录短称呼（例如“周姐”“楼下房东”）；不确定就留空，不能拿备注代替 name。
- source 固定写 generated。只输出 JSON 数组，不要 Markdown：
[{"name":"","remark":"","source":"generated","category":"family|work|friend|rival|other","relationship":"与手机主人的具体关系","summary":"一句话人物底色","traits":[],"speechStyle":"说话特点","boundary":"关系边界或隐情"}]`;
}

export function isInternalNpcExtractionName(value = '') {
  const name = clip(value, 120);
  return /^(?:char|character|npc|lightnpc|phone[-_:]?contact)[_:-][a-z0-9_-]{5,}$/i.test(name);
}

function relationshipText(value) {
  if (typeof value === 'string' || typeof value === 'number') return clip(value, 240);
  if (!value || typeof value !== 'object') return '';
  return clip(
    value.relationship
    || value.relation
    || value.description
    || value.summary
    || value.label
    || value.type
    || value.note,
    240,
  );
}

function relationshipTargetName(id, value, characterById) {
  const rawId = clip(id, 160);
  const linked = resolvePhoneSocialActorDisplayName(characterById.get(rawId));
  if (linked && !isInternalNpcExtractionName(linked)) return linked;
  if (value && typeof value === 'object') {
    const embedded = clip(
      value.name
      || value.displayName
      || value.realName
      || value.characterName
      || value.targetName
      || value.target
      || value.nickname,
      80,
    );
    if (embedded && !isInternalNpcExtractionName(embedded)) return embedded;
  }
  if (/^\d+$/.test(rawId) || rawId === 'user' || isInternalNpcExtractionName(rawId)) return '';
  return rawId;
}

export function buildNpcExtractionRelationshipLines(relationships = {}, characters = []) {
  const characterById = new Map((Array.isArray(characters) ? characters : [])
    .map((row) => [clip(row?.id, 160), row])
    .filter(([id]) => id));
  return Object.entries(relationships && typeof relationships === 'object' ? relationships : {})
    .filter(([id]) => id !== 'user')
    .map(([id, relationship]) => {
      let name = relationshipTargetName(id, relationship, characterById);
      let label = relationshipText(relationship);
      if (!name && Array.isArray(relationships) && typeof relationship === 'string') {
        const match = clip(relationship, 320).match(/^([^:：]{1,80})[:：]\s*(.+)$/);
        if (match) {
          name = clip(match[1], 80);
          label = clip(match[2], 240);
        }
      }
      return name && !isInternalNpcExtractionName(name) && label ? `- ${name}：${label}` : '';
    })
    .filter(Boolean)
    .slice(0, 30);
}

function jsonProfileBlock(value) {
  if (!value || typeof value !== 'object' || !Object.keys(value).length) return '';
  try {
    return JSON.stringify(value);
  } catch (_) {
    return '';
  }
}

function fullProfileText(value = '') {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

export function buildNpcExtractionProfile(character = {}, characters = []) {
  const relationshipLines = buildNpcExtractionRelationshipLines(character.relationships, characters);
  const lifeProfile = jsonProfileBlock(character.lifeProfile);
  return [
    `角色名：${clip(character.realName || character.name || character.id, 80)}`,
    `整段设定：${fullProfileText(character.promptCorpus)}`,
    `人设：${fullProfileText(character.personality)}`,
    `身份：${fullProfileText(character.currentRole)}`,
    `当前状态：${fullProfileText(character.currentStatus)}`,
    `经历：${fullProfileText(character.background || character.backgroundStory)}`,
    `场景：${fullProfileText(character.scenario)}`,
    `补充：${fullProfileText(character.notes)}`,
    `口吻与对话语料：${fullProfileText(character.speechCorpus)}`,
    `与用户关系（用户本人不可提取）：${fullProfileText(character.userRelationStatus)}`,
    relationshipLines.length ? `已登记角色关系：\n${relationshipLines.join('\n')}` : '',
    lifeProfile ? `生活资料：${lifeProfile}` : '',
  ].filter((line) => !line.endsWith('：')).join('\n');
}

export function normalizeNpcExtractionCandidate(raw, index, characters = [], sourceOwnerId = '') {
  const characterById = new Map((Array.isArray(characters) ? characters : [])
    .map((row) => [clip(row?.id, 160), row])
    .filter(([id]) => id));
  const rawName = clip(raw?.name, 80);
  const linkedName = isInternalNpcExtractionName(rawName)
    ? resolvePhoneSocialActorDisplayName(characterById.get(rawName))
    : '';
  const name = clip(linkedName || rawName, 40);
  if (isInternalNpcExtractionName(name)) return null;
  if (!name) return null;
  const category = CATEGORIES.has(raw?.category) ? raw.category : 'other';
  const rawSource = clip(raw?.source || raw?.origin, 40).toLowerCase();
  const source = raw?.generated === true || GENERATED_SOURCES.has(rawSource)
    ? 'generated'
    : 'extracted';
  return {
    id: `npc_candidate_${index}`,
    sourceOwnerId: clip(sourceOwnerId, 160),
    name,
    remark: clip(raw?.remark || raw?.remarkName, 40),
    source,
    category,
    relationship: clip(raw?.relationship || raw?.relation, 120),
    summary: clip(raw?.summary || raw?.personality, 180),
    traits: (Array.isArray(raw?.traits) ? raw.traits : [])
      .map((item) => clip(item, 24))
      .filter(Boolean)
      .slice(0, 6),
    speechStyle: clip(raw?.speechStyle, 100),
    boundary: clip(raw?.boundary, 100),
  };
}

/** 生成角色给用户的手机备注；返回值仅供显示，绝不作为 actor 名称或别名。 */
export async function generatePhoneUserRemark(character, { user = null, signal = null } = {}) {
  if (!character?.id) throw new Error('找不到手机主人角色');
  const userName = getUserDisplayName(user || {}) || '用户';
  const ownerName = clip(character.realName || character.name, 80) || '角色';
  const { data } = await chatJsonGeneration({
    scope: 'character-phone-user-remark',
    messages: [{
      role: 'system',
      content: `你要模拟 ${ownerName} 在自己手机通讯录里给 ${userName} 设置的备注。\n角色设定：${clip(character.promptCorpus || character.personality, 6000)}\n与用户关系：${clip(character.userRelationStatus, 1200)}\n要求：备注应符合关系与人物习惯，1～12 个汉字或同等长度；可以是真名、昵称、关系称呼或角色私下会用的短称呼。不要输出身份分析，不要改变任何人的真实姓名。只输出 JSON：{"remark":""}`,
    }, {
      role: 'user',
      content: '生成这个角色会真实写进手机的用户备注。',
    }],
    temperature: 0.65,
    signal,
    validate: (value) => typeof value?.remark === 'string',
  });
  const remark = clip(data?.remark, 40);
  if (!remark) throw new Error('这次没有生成可用的备注');
  return remark;
}

export async function extractNpcCandidatesFromCharacter(character, { signal = null, user = null } = {}) {
  if (!character?.id) throw new Error('找不到手机主人角色');
  const [characters, phoneState] = await Promise.all([
    listCharacters({
      includeInternal: true,
      userId: user?.id,
    }).catch(() => []),
    user?.id
      ? loadCharacterPhoneContacts(user.id, character.id).catch(() => ({ contacts: [] }))
      : Promise.resolve({ contacts: [] }),
  ]);
  const profile = buildNpcExtractionProfile(character, characters);
  const relationshipSeeds = buildNpcExtractionRelationshipLines(character.relationships, characters)
    .map((line) => {
      const value = line.replace(/^-\s*/, '');
      const separator = value.indexOf('：');
      if (separator <= 0) return null;
      return {
        name: value.slice(0, separator),
        source: 'extracted',
        relationship: value.slice(separator + 1),
      };
    })
    .filter(Boolean);
  const existingNames = (phoneState.contacts || [])
    .map((row) => clip(row?.nickname || row?.name, 40))
    .filter(Boolean)
    .slice(0, 80);
  let generated;
  try {
    generated = await chatJsonGeneration({
      scope: 'character-npc-extract',
      messages: [
        {
          role: 'system',
          content: `阅读下面的完整角色卡，为这个角色的手机整理联系人候选。候选必须分清“原设提取”和“补充建议”。

${profile}

${existingNames.length ? `手机里已有联系人（不要重复返回）：${existingNames.join('、')}\n` : ''}

要求：
- source=extracted：提取角色卡里明确存在或强烈暗示的人，尤其要通读“整段设定”和“已登记角色关系”；只有关系称谓而无姓名时，可用“妈妈”“经纪人”“房东”等可读称呼，不要因此漏掉。
- source=generated：在原设人物之外，可以额外建议 2～4 位符合角色身份、生活环境和社交习惯的新联系人。补充建议是待用户确认的创作，不得伪装成原设事实；资料不足时可以少写。
- 先完整返回有依据的人，再补充建议；不要为了补充建议挤掉原设人物。
- 合并同一人的不同称呼；不要返回已有联系人，不要提取或生成用户本人、当前角色本人、组织、地点或宠物。
- 姓名必须是人能读懂的称呼，禁止把 char_、npc_ 等内部编号当作姓名。
- 最多 12 人。原设人物关系不明确时宁可不写；补充建议则填写合理、克制的关系。
- category 只能是 family/work/friend/rival/other。
- remark 是当前角色可能会写在手机里的可选短备注；必须和 name 分开，不确定就留空。
- 只输出 JSON 数组，不要 Markdown。若使用对象包裹，也只能使用 candidates 数组：
[{"name":"","remark":"","source":"extracted|generated","category":"family|work|friend|rival|other","relationship":"与当前角色的关系","summary":"一句话人设","traits":[],"speechStyle":"","boundary":""}]`,
        },
        { role: 'user', content: '请按上述完整角色卡整理可加入手机的联系人候选 JSON。' },
      ],
      temperature: 0.2,
      signal,
      validate: (value) => Array.isArray(value) || Array.isArray(value?.candidates),
    });
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError' || !relationshipSeeds.length) throw err;
    generated = { data: [] };
  }
  const generatedPayload = Array.isArray(generated.data) ? generated.data : generated.data?.candidates;
  const payload = [...relationshipSeeds, ...(Array.isArray(generatedPayload) ? generatedPayload : [])];
  const existingNameKeys = new Set(existingNames.map((name) => name.toLocaleLowerCase()));
  const seenNameKeys = new Set();
  const rows = payload
    .map((row, index) => normalizeNpcExtractionCandidate(row, index, characters, character.id))
    .filter(Boolean)
    .filter((row) => !isPhoneUserImpersonator(row, {
      userId: user?.id,
      userName: getUserDisplayName(user || {}),
    }))
    .filter((row) => {
      const key = row.name.toLocaleLowerCase();
      if (existingNameKeys.has(key) || seenNameKeys.has(key)) return false;
      seenNameKeys.add(key);
      return true;
    });
  if (!rows.length) throw new Error('没有找到可加入的新联系人候选');
  return rows;
}

export async function generateNpcCandidatesFromCharacter(character, {
  signal = null,
  user = null,
  count = 4,
  categories = [],
  direction = '',
} = {}) {
  if (!character?.id) throw new Error('找不到手机主人角色');
  const options = normalizeNpcGenerationOptions({ count, categories, direction });
  const [characters, phoneState] = await Promise.all([
    listCharacters({
      includeInternal: true,
      userId: user?.id,
    }).catch(() => []),
    user?.id
      ? loadCharacterPhoneContacts(user.id, character.id).catch(() => ({ contacts: [] }))
      : Promise.resolve({ contacts: [] }),
  ]);
  const profile = buildNpcExtractionProfile(character, characters);
  const existingNames = (phoneState.contacts || [])
    .map((row) => clip(row?.nickname || row?.name, 40))
    .filter(Boolean)
    .slice(0, 80);
  const formalCharacterNames = characters
    .filter((row) => row?.id && row.id !== character.id && !row?._lightweightNpc)
    .map((row) => clip(row.realName || row.name, 40))
    .filter(Boolean)
    .slice(0, 80);
  const worldBook = await buildWorldBookContextBlock(
    user,
    [profile, options.direction].filter(Boolean).join('\n'),
    { characterIds: [character.id], worldBookMode: 'full' },
  ).catch(() => '');
  const prompt = buildNpcGenerationPrompt({
    profile,
    worldBook,
    existingNames,
    formalCharacterNames,
    options,
  });
  const generated = await chatJsonGeneration({
    scope: 'character-npc-generate',
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: '请按上述完整角色与世界书设定生成本次新联系人候选 JSON。' },
    ],
    temperature: 0.45,
    signal,
    validate: (value) => Array.isArray(value) || Array.isArray(value?.candidates),
  });
  const payload = Array.isArray(generated.data) ? generated.data : generated.data?.candidates;
  const existingNameKeys = new Set([
    ...existingNames,
    ...formalCharacterNames,
    character.realName,
    character.name,
  ].filter(Boolean).map((name) => String(name).toLocaleLowerCase()));
  const allowedCategories = new Set(options.categories);
  const seenNameKeys = new Set();
  const rows = (Array.isArray(payload) ? payload : [])
    .map((row, index) => normalizeNpcExtractionCandidate(
      { ...row, source: 'generated' },
      index,
      characters,
      character.id,
    ))
    .filter(Boolean)
    .filter((row) => allowedCategories.has(row.category))
    .filter((row) => !isPhoneUserImpersonator(row, {
      userId: user?.id,
      userName: getUserDisplayName(user || {}),
      ownerId: character.id,
      ownerName: character.realName || character.name,
    }))
    .filter((row) => {
      const key = row.name.toLocaleLowerCase();
      if (existingNameKeys.has(key) || seenNameKeys.has(key)) return false;
      seenNameKeys.add(key);
      return true;
    })
    .slice(0, options.count);
  if (!rows.length) throw new Error('这次没有生成可用的新联系人，请调整类型或补充方向后重试');
  return rows;
}

async function saveNpcCandidatesToPhoneUnlocked({
  userId,
  user = null,
  owner,
  candidates = [],
} = {}) {
  const uid = String(userId || '').trim();
  const ownerId = String(owner?.id || '').trim();
  if (!uid || !ownerId) throw new Error('缺少手机主人');
  const foreignCandidate = (Array.isArray(candidates) ? candidates : []).find((row) => (
    row?.sourceOwnerId && String(row.sourceOwnerId).trim() !== ownerId
  ));
  if (foreignCandidate) throw new Error('联系人候选不属于当前角色，请重新提取');
  const selected = (Array.isArray(candidates) ? candidates : []).filter((row) => (
    row?.name
    && !isPhoneUserImpersonator(row, {
      userId: uid,
      userName: getUserDisplayName(user || {}),
    })
  ));
  if (!selected.length) return [];

  const [phoneState, net, characters] = await Promise.all([
    loadCharacterPhoneContacts(uid, ownerId),
    loadRelationshipNetwork(uid),
    listCharacters({ includeInternal: true, userId: uid }).catch(() => []),
  ]);
  const directory = createPhoneSocialActorDirectory({
    ownerId,
    characters,
    relationshipNetwork: net,
    contacts: phoneState.contacts || [],
    removedLinkedCharacterIds: phoneState.removedLinkedCharacterIds || [],
    removedLinkedActorIds: phoneState.removedLinkedActorIds || [],
  });
  const savedPairs = [];
  for (const row of selected) {
    const actor = directory.resolve('', { name: row.name });
    const baseContact = actor
      ? await ensurePhoneSocialActorContact(uid, ownerId, actor)
      : null;
    const contact = await upsertPhoneContact(uid, ownerId, {
      id: baseContact?.id,
      name: row.name,
      remark: row.remark || '',
      linkedCharacterId: baseContact?.linkedCharacterId || '',
      linkedActorId: baseContact?.linkedActorId || '',
      category: row.category || 'other',
      note: row.relationship || '',
      personaCapsule: {
        relationship: row.relationship || '',
        summary: row.summary || '',
        traits: row.traits || [],
        speechStyle: row.speechStyle || '',
        boundary: row.boundary || '',
      },
    });
    if (contact) {
      savedPairs.push({ contact, source: row, actorId: actor?.id || phoneContactCanonicalActorId(contact) });
    }
  }

  if (savedPairs.length) {
    const ownerName = clip(owner.realName || owner.name || ownerId, 20);
    const circleName = `${ownerName}的生活圈`.slice(0, 24);
    let circle = (net.circles || []).find((item) => item.name === circleName);
    if (!circle) {
      circle = { id: newCircleId(), name: circleName, memberIds: [ownerId], edges: [], groups: [] };
      net.circles = [...(net.circles || []), circle];
    }
    if (!(circle.memberIds || []).includes(ownerId)) circle.memberIds.push(ownerId);
    for (const pair of savedPairs) {
      const { contact, source, actorId } = pair;
      const networkActorId = actorId || contact.id;
      pair.networkActorId = networkActorId;
      if (!(net.npcs || []).some((npc) => npc.id === networkActorId)
        && !characters.some((character) => character.id === networkActorId)) {
        net.npcs = [...(net.npcs || []), {
          id: networkActorId,
          name: contact.name,
          note: source.summary || source.relationship || '',
        }];
      }
      if (!(circle.memberIds || []).includes(networkActorId)) circle.memberIds.push(networkActorId);
      if (!(circle.edges || []).some((edge) => (
        (edge.a === ownerId && edge.b === networkActorId)
        || (edge.a === networkActorId && edge.b === ownerId)
      ))) {
        circle.edges.push({
          id: newEdgeId(),
          a: ownerId,
          b: networkActorId,
          label: source.relationship || '认识',
        });
      }
    }
    await saveRelationshipNetwork(net, uid);
    for (const pair of savedPairs) {
      if (pair.contact.linkedCharacterId || pair.contact.linkedActorId || !pair.networkActorId) continue;
      const linkedContact = await upsertPhoneContact(uid, ownerId, {
        id: pair.contact.id,
        linkedActorId: pair.networkActorId,
      });
      if (linkedContact) pair.contact = linkedContact;
    }
  }
  return savedPairs.map((row) => row.contact);
}

/**
 * 同一档位里可以连续为多位角色发起提取。联系人本身按 ownerId 分库存储，
 * 但关系网是同一份 settings 记录；并行的“读取→补边→整份保存”会让最后完成者
 * 覆盖其它角色刚写入的圈。按 userId 串行提交，保证每一轮都基于上一轮最新结果。
 */
export async function saveNpcCandidatesToPhone(options = {}) {
  const queueKey = String(options?.userId || '').trim() || 'guest';
  const previous = npcPhoneSaveQueues.get(queueKey) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => gate);
  npcPhoneSaveQueues.set(queueKey, queued);
  await previous.catch(() => {});
  try {
    return await saveNpcCandidatesToPhoneUnlocked(options);
  } finally {
    release();
    if (npcPhoneSaveQueues.get(queueKey) === queued) npcPhoneSaveQueues.delete(queueKey);
  }
}
