export const OFFLINE_CONTINUITY_STATE_START = '<<<OFFLINE_CONTINUITY_STATE>>>';
export const OFFLINE_CONTINUITY_STATE_END = '<<<END_OFFLINE_CONTINUITY_STATE>>>';
export const OFFLINE_CONTINUITY_STORAGE_VERSION = 2;

const TEXT_LIMIT = 160;
const LIST_LIMIT = 16;
const PROMPT_LIST_LIMIT = 8;
const PROMPT_KNOWLEDGE_LIMIT = 8;

function clean(value = '', limit = TEXT_LIMIT) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function cleanList(value, limit = LIST_LIMIT) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map((item) => clean(item)).filter(Boolean))].slice(-limit);
}

function cleanCharacterStates(value = {}, allowedIds = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [rawId, rawState] of Object.entries(value)) {
    const id = clean(rawId, 80);
    if (!id || id === 'user' || (allowedIds?.size && !allowedIds.has(id))) continue;
    const state = rawState && typeof rawState === 'object' ? rawState : {};
    out[id] = {
      position: clean(state.position),
      physical: clean(state.physical),
      clothing: clean(state.clothing),
      carrying: cleanList(state.carrying, 8) || [],
    };
  }
  return out;
}

function cleanItemOwnership(value) {
  if (!Array.isArray(value)) return null;
  return value.map((raw) => {
    if (typeof raw === 'string') return { item: clean(raw), ownerId: '', status: '' };
    const row = raw && typeof raw === 'object' ? raw : {};
    return {
      item: clean(row.item || row.name),
      ownerId: clean(row.ownerId || row.owner, 80),
      status: clean(row.status),
    };
  }).filter((row) => row.item).slice(-LIST_LIMIT);
}

function cleanCurrentUserState(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  if (typeof value.faceCovered === 'boolean') out.faceCovered = value.faceCovered;
  for (const field of ['appearanceNow', 'disguise', 'position', 'physical']) {
    const text = clean(value[field]);
    if (text) out[field] = text;
  }
  return out;
}

function factKey(value = '') {
  return clean(value, 200).toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()[\]{}<>《》【】]/g, '');
}

function cleanKnowledgeFact(value = {}, fallbackBeat = 0) {
  const raw = value && typeof value === 'object' ? value : {};
  const fact = clean(raw.fact || raw.content, 240);
  if (!fact) return null;
  return {
    factId: clean(raw.factId || raw.id, 100) || `fact_${factKey(fact).slice(0, 72)}`,
    fact,
    learnedAtBeat: Math.max(1, Number(raw.learnedAtBeat || raw.beat || fallbackBeat) || 1),
    evidence: clean(raw.evidence, 200),
  };
}

function cleanKnowledgeByCharacter(raw = {}, allowedIds = null, fallbackBeat = 0) {
  const out = {};
  const add = (characterId, value) => {
    const id = clean(characterId, 80);
    if (!id || id === 'user' || (allowedIds?.size && !allowedIds.has(id))) return;
    const fact = cleanKnowledgeFact(value, fallbackBeat);
    if (!fact) return;
    if (!out[id]) out[id] = [];
    if (!out[id].some((row) => row.factId === fact.factId || factKey(row.fact) === factKey(fact.fact))) {
      out[id].push(fact);
    }
    out[id] = out[id].slice(-24);
  };
  if (raw.knowledgeByCharacter && typeof raw.knowledgeByCharacter === 'object') {
    for (const [characterId, facts] of Object.entries(raw.knowledgeByCharacter)) {
      for (const fact of (Array.isArray(facts) ? facts : [])) add(characterId, fact);
    }
  }
  for (const gain of (Array.isArray(raw.knowledgeGains) ? raw.knowledgeGains : [])) {
    add(gain?.characterId, gain);
  }
  return out;
}

export function normalizeOfflineContinuityState(value = {}, options = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowedIds = new Set((Array.isArray(options.characterIds) ? options.characterIds : [])
    .map((id) => clean(id, 80)).filter(Boolean));
  const out = {
    location: clean(raw.location),
    worldTime: clean(raw.worldTime || raw.time),
    presentCharacterIds: cleanList(raw.presentCharacterIds, 8) || [],
    characterStates: cleanCharacterStates(raw.characterStates, allowedIds) || {},
    itemOwnership: cleanItemOwnership(raw.itemOwnership) || [],
    establishedFacts: cleanList(raw.establishedFacts) || [],
    completedActions: cleanList(raw.completedActions, 12) || [],
    openThreads: cleanList(raw.openThreads) || [],
    promises: cleanList(raw.promises) || [],
    relationshipDeltas: cleanList(raw.relationshipDeltas, 12) || [],
    currentUserState: cleanCurrentUserState(raw.currentUserState),
    knowledgeByCharacter: cleanKnowledgeByCharacter(raw, allowedIds, options.beatNumber),
  };
  if (allowedIds.size) {
    out.presentCharacterIds = out.presentCharacterIds.filter((id) => allowedIds.has(id));
  }
  return out;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

export function mergeOfflineContinuityState(previous = {}, patch = {}, options = {}) {
  const base = normalizeOfflineContinuityState(previous, options);
  const raw = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const normalized = normalizeOfflineContinuityState(raw, options);
  const next = { ...base };
  const scalarFields = ['location', 'worldTime'];
  const listFields = [
    'presentCharacterIds',
    'itemOwnership',
    'establishedFacts',
    'completedActions',
    'openThreads',
    'promises',
    'relationshipDeltas',
  ];
  for (const field of scalarFields) {
    if (hasOwn(raw, field) || (field === 'worldTime' && hasOwn(raw, 'time'))) next[field] = normalized[field];
  }
  for (const field of listFields) {
    if (hasOwn(raw, field)) next[field] = normalized[field];
  }
  if (hasOwn(raw, 'characterStates')) {
    next.characterStates = { ...base.characterStates, ...normalized.characterStates };
  }
  if (hasOwn(raw, 'currentUserState')) {
    next.currentUserState = { ...base.currentUserState, ...normalized.currentUserState };
  }
  next.knowledgeByCharacter = { ...base.knowledgeByCharacter };
  const incomingKnowledge = normalized.knowledgeByCharacter || {};
  for (const [characterId, facts] of Object.entries(incomingKnowledge)) {
    const existing = Array.isArray(next.knowledgeByCharacter[characterId])
      ? next.knowledgeByCharacter[characterId]
      : [];
    const merged = [...existing];
    for (const fact of facts) {
      const index = merged.findIndex((row) => row.factId === fact.factId || factKey(row.fact) === factKey(fact.fact));
      if (index < 0) merged.push(fact);
      else merged[index] = {
        ...merged[index],
        ...fact,
        learnedAtBeat: Math.min(merged[index].learnedAtBeat || fact.learnedAtBeat, fact.learnedAtBeat),
      };
    }
    next.knowledgeByCharacter[characterId] = merged.slice(-24);
  }
  return next;
}

/** 把同一楼的断点续写 patch 合成一份可重放 patch。 */
export function mergeOfflineContinuityPatches(first = {}, second = {}) {
  const left = first && typeof first === 'object' && !Array.isArray(first) ? first : {};
  const right = second && typeof second === 'object' && !Array.isArray(second) ? second : {};
  const merged = { ...left, ...right };
  if (left.characterStates || right.characterStates) {
    merged.characterStates = { ...(left.characterStates || {}), ...(right.characterStates || {}) };
  }
  if (left.currentUserState || right.currentUserState) {
    merged.currentUserState = { ...(left.currentUserState || {}), ...(right.currentUserState || {}) };
  }
  const knowledgeGains = [...(Array.isArray(left.knowledgeGains) ? left.knowledgeGains : []),
    ...(Array.isArray(right.knowledgeGains) ? right.knowledgeGains : [])];
  if (knowledgeGains.length) merged.knowledgeGains = knowledgeGains;
  return merged;
}

function sameStateValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function offlineContinuityStateDiff(previous = {}, current = {}, options = {}) {
  const before = normalizeOfflineContinuityState(previous, options);
  const after = normalizeOfflineContinuityState(current, options);
  const patch = {};
  for (const field of [
    'location',
    'worldTime',
    'presentCharacterIds',
    'characterStates',
    'itemOwnership',
    'establishedFacts',
    'completedActions',
    'openThreads',
    'promises',
    'relationshipDeltas',
    'currentUserState',
  ]) {
    if (!sameStateValue(before[field], after[field])) patch[field] = after[field];
  }
  const knowledgeGains = [];
  for (const [characterId, facts] of Object.entries(after.knowledgeByCharacter || {})) {
    const previousFacts = before.knowledgeByCharacter?.[characterId] || [];
    for (const fact of facts) {
      if (!previousFacts.some((row) => row.factId === fact.factId && sameStateValue(row, fact))) {
        knowledgeGains.push({ characterId, ...fact });
      }
    }
  }
  if (knowledgeGains.length) patch.knowledgeGains = knowledgeGains;
  return patch;
}

/**
 * 下一轮只需要“眼前还成立的状态”。已完成事件、关系变化、承诺和长期伏笔
 * 已由分段小结承接，不再每轮把整份累积清单重复塞回提示词。
 */
export function compactOfflineContinuityStateForPrompt(value = {}, options = {}) {
  const state = normalizeOfflineContinuityState(value, options);
  const knowledgeByCharacter = {};
  for (const [characterId, facts] of Object.entries(state.knowledgeByCharacter || {})) {
    const kept = (Array.isArray(facts) ? facts : []).slice(-PROMPT_KNOWLEDGE_LIMIT);
    if (kept.length) knowledgeByCharacter[characterId] = kept;
  }
  return {
    location: state.location,
    worldTime: state.worldTime,
    presentCharacterIds: state.presentCharacterIds.slice(-PROMPT_LIST_LIMIT),
    characterStates: state.characterStates,
    itemOwnership: state.itemOwnership.slice(-PROMPT_LIST_LIMIT),
    currentUserState: state.currentUserState,
    knowledgeByCharacter,
  };
}

/** 从 session 级快照、旧楼层快照与新楼层 patch 恢复当前状态。 */
export function rebuildOfflineContinuityState(session = {}, fallback = {}, options = {}) {
  const explicitFallback = fallback && typeof fallback === 'object' ? fallback : {};
  const participantIds = (Array.isArray(session?.participants) ? session.participants : [])
    .map(String)
    .filter((id) => id && id !== 'user');
  const sceneFallback = Object.keys(explicitFallback).length
    ? explicitFallback
    : {
      location: session?.scene?.place || '',
      worldTime: session?.scene?.timeLabel || '',
      presentCharacterIds: session?.scene?.naturalEnsemble === true
        ? participantIds.slice(0, 1)
        : participantIds,
    };
  let state = normalizeOfflineContinuityState(sceneFallback, options);
  let found = false;
  for (const beat of (Array.isArray(session?.beats) ? session.beats : [])) {
    if (beat?.role !== 'narration') continue;
    if (beat.continuityState && typeof beat.continuityState === 'object') {
      state = normalizeOfflineContinuityState(beat.continuityState, options);
      found = true;
    }
    if (beat.continuityPatch && typeof beat.continuityPatch === 'object') {
      state = mergeOfflineContinuityState(state, beat.continuityPatch, options);
      found = true;
    }
  }
  if (found || Object.values(sceneFallback).some((value) => Array.isArray(value) ? value.length : !!value)) {
    session.continuityState = state;
  }
  else delete session.continuityState;
  return state;
}

/**
 * 旧存档每层都带合并后的完整快照。首次读取时机械换成逐层 patch，
 * 保留最终 session 状态，避免长会话以后每次保存都重复序列化整套状态。
 */
export function compactLegacyOfflineContinuitySnapshots(session = {}, options = {}) {
  const beats = Array.isArray(session?.beats) ? session.beats : [];
  if (
    Number(session?.continuityStorageVersion || 0) >= OFFLINE_CONTINUITY_STORAGE_VERSION
    && !beats.some((beat) => beat?.continuityState)
  ) {
    return { changed: false, state: session.continuityState || {} };
  }
  const seedSession = { ...session, beats: [] };
  delete seedSession.continuityState;
  let previous = rebuildOfflineContinuityState(seedSession, {}, options);
  let changed = false;
  let found = false;
  for (const beat of beats) {
    if (beat?.role !== 'narration') continue;
    if (beat.continuityState && typeof beat.continuityState === 'object') {
      const current = normalizeOfflineContinuityState(beat.continuityState, options);
      const migratedPatch = offlineContinuityStateDiff(previous, current, options);
      const combinedPatch = mergeOfflineContinuityPatches(migratedPatch, beat.continuityPatch);
      if (Object.keys(combinedPatch).length) beat.continuityPatch = combinedPatch;
      else delete beat.continuityPatch;
      delete beat.continuityState;
      previous = mergeOfflineContinuityState(current, beat.continuityPatch, options);
      changed = true;
      found = true;
      continue;
    }
    if (beat.continuityPatch && typeof beat.continuityPatch === 'object') {
      previous = mergeOfflineContinuityState(previous, beat.continuityPatch, options);
      found = true;
    }
  }
  if (found) session.continuityState = previous;
  session.continuityStorageVersion = OFFLINE_CONTINUITY_STORAGE_VERSION;
  return { changed, state: session.continuityState || previous };
}

export function latestOfflineContinuityState(session = {}, fallback = {}) {
  if (session?.continuityState && typeof session.continuityState === 'object') {
    return session.continuityState;
  }
  const beats = Array.isArray(session?.beats) ? session.beats : [];
  for (let index = beats.length - 1; index >= 0; index -= 1) {
    if (beats[index]?.continuityState) return beats[index].continuityState;
  }
  return rebuildOfflineContinuityState({
    beats,
    scene: session?.scene,
    participants: session?.participants,
  }, fallback);
}

export function collectOfflineKnowledgeFacts(session = {}) {
  const state = latestOfflineContinuityState(session, {});
  const out = [];
  for (const [characterId, facts] of Object.entries(state?.knowledgeByCharacter || {})) {
    for (const fact of (Array.isArray(facts) ? facts : [])) {
      const cleaned = cleanKnowledgeFact(fact);
      if (cleaned) out.push({ characterId, ...cleaned });
    }
  }
  return out;
}

export function buildOfflineContinuityFallback(scene = {}, characterIds = []) {
  const presentCharacterIds = scene?.naturalEnsemble === true
    ? characterIds.slice(0, 1)
    : characterIds;
  return normalizeOfflineContinuityState({
    location: scene.place || '',
    worldTime: scene.timeLabel || '',
    presentCharacterIds,
  }, { characterIds });
}

export function offlineContinuityStateInstruction(previous = {}, characterIds = [], options = {}) {
  const beatNumber = Math.max(1, Number(options.beatNumber) || 1);
  const state = compactOfflineContinuityStateForPrompt(previous, { characterIds, beatNumber });
  return [
    '【现场连续状态 · 隐藏结构块】',
    '叙事正文和其它尾部结构写完后，追加一个极短的现场状态 JSON patch；它不会显示在正文里。',
    '只记录本轮发生变化的字段（只限眼前状态）：location、worldTime、presentCharacterIds、characterStates、itemOwnership、currentUserState 或 knowledgeGains。没有变化的字段全部省略；完全没变化就输出 {}。',
    '已完成事件、关系评价、承诺、伏笔和剧情概括由分段小结保存；这里禁止输出 establishedFacts、completedActions、openThreads、promises 或 relationshipDeltas。',
    '数组字段一旦有变化，写变化后的精简当前数组；禁止原样重复或复制上一轮整份状态。',
    'currentUserState 只写用户眼下可变的状态。faceCovered=true 只表示现在重新遮住了脸，不表示角色从未见过。',
    `knowledgeGains 只追加本轮新获得的认知，learnedAtBeat 固定写 ${beatNumber}。例如角色亲眼看见用户摘下口罩时，追加 factId=user_face_seen；之后用户重新戴口罩也绝不能撤销这条认知。`,
    '认知按角色隔离：只有本轮实际在场并亲眼看到/亲耳听到的角色才能获得；没在场、离场或只听含糊转述的角色不能自动知道。',
    options.naturalEnsemble === true
      ? '自然群像开启：角色池不等于实际在镜头内。presentCharacterIds 只记录此刻已经进入现场的人；当角色因剧情自然到场或离开时，输出变化后的完整列表。未入镜、只被提及、只打来电话或仍在候场的人不要加入。'
      : '',
    'presentCharacterIds、characterStates 的键只能使用当前角色 id；user 的位置或状态写进 currentUserState，不得伪造 user 角色 id。',
    `上一轮状态（只用于判断本轮变化，禁止原样重复）：${JSON.stringify(state)}`,
    OFFLINE_CONTINUITY_STATE_START,
    `{"knowledgeGains":[{"characterId":"角色id","factId":"稳定事实id","fact":"本轮新知道的事实","learnedAtBeat":${beatNumber},"evidence":"本轮依据"}]}`,
    OFFLINE_CONTINUITY_STATE_END,
  ].filter(Boolean).join('\n');
}

const OFFLINE_CONTINUITY_STATE_KEYS = new Set([
  'location',
  'worldTime',
  'time',
  'presentCharacterIds',
  'currentUserState',
  'characterStates',
  'itemOwnership',
  'establishedFacts',
  'completedActions',
  'openThreads',
  'promises',
  'relationshipDeltas',
  'knowledgeGains',
  'knowledgeByCharacter',
]);

function isOfflineContinuityStateShape(value, { allowPatch = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const knownCount = keys.filter((key) => OFFLINE_CONTINUITY_STATE_KEYS.has(key)).length;
  if (allowPatch) return knownCount >= 1 && knownCount === keys.length;
  return knownCount >= 4;
}

function startsLikeOfflineContinuityState(text = '') {
  return /^(?:```(?:json)?\s*)?\{\s*"(?:location|worldTime|time|presentCharacterIds|currentUserState|characterStates|itemOwnership|establishedFacts|completedActions|openThreads|promises|relationshipDeltas|knowledgeGains|knowledgeByCharacter)"\s*:/iu.test(
    String(text || '').trim(),
  );
}

function findLeakedContinuityTailStart(text = '') {
  const source = String(text || '');
  const patterns = [
    // 不能要求隐藏对象另起一行：部分模型会把 JSON 数组直接黏在正文句号后，
    // 甚至连续输出多个对象。流式预览和最终落库都必须从第一个内部对象处截断。
    /(?:```(?:json)?\s*)?\[?\s*(\{\s*"characterId"\s*:)/giu,
    /(?:```(?:json)?\s*)?\{?\s*("knowledgeGains"\s*:\s*\[)/giu,
    // 完整现场状态也可能不带协议标记，并直接黏在正文末尾。状态本来允许只输出
    // 一个变化字段，因此从第一个明确的状态键出现时就要截断，不能等凑齐四个键。
    /(?:```(?:json)?\s*)?(\{\s*"(?:location|worldTime|time|presentCharacterIds|currentUserState|characterStates|itemOwnership|establishedFacts|completedActions|openThreads|promises|relationshipDeltas|knowledgeGains|knowledgeByCharacter)"\s*:)/giu,
  ];
  let earliest = -1;
  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(source))) {
      const start = match.index;
      const tail = source.slice(start, start + 2400);
      const isKnowledgeTail = /"(?:characterId|knowledgeGains)"\s*:/u.test(match[0]);
      if (isKnowledgeTail && !/"(?:fact|factId|learnedAtBeat|evidence)"\s*:/u.test(tail)) continue;
      if (earliest < 0 || start < earliest) earliest = start;
      break;
    }
  }
  return earliest;
}

function collectLooseKnowledgeGainObjects(text = '') {
  const source = String(text || '');
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    try {
      const parsed = JSON.parse(source.slice(start, index + 1));
      if (parsed && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && parsed.characterId
        && (parsed.fact || parsed.content)
        && (parsed.learnedAtBeat != null || parsed.evidence != null)) {
        objects.push(parsed);
      }
    } catch (_) { /* incomplete hidden objects are still removed from narration */ }
    start = -1;
  }
  return objects;
}

/** 流式预览也要尽早截掉模型漏标记的连续状态残片，不能等落库后才清理。 */
export function stripLeakedOfflineContinuityTail(text = '') {
  const source = String(text || '');
  const start = findLeakedContinuityTailStart(source);
  return start >= 0 ? source.slice(0, start).trimEnd() : source;
}

function parseBareOfflineContinuityState(raw = '') {
  const source = String(raw || '');
  const trimmed = source.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidates = [{ start: 0, text: fenced ? fenced[1].trim() : trimmed }];
  const tailPattern = /(?:^|\n)\s*(\{\s*"location"\s*:)/g;
  let match = null;
  while ((match = tailPattern.exec(source))) {
    const start = match.index + match[0].indexOf(match[1]);
    if (start > 0) candidates.push({ start, text: source.slice(start).trim() });
  }
  const detectedTailStart = findLeakedContinuityTailStart(source);
  if (detectedTailStart > 0 && !candidates.some((candidate) => candidate.start === detectedTailStart)) {
    candidates.push({ start: detectedTailStart, text: source.slice(detectedTailStart).trim() });
  }
  candidates.sort((left, right) => left.start - right.start);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.text);
      if (isOfflineContinuityStateShape(parsed, { allowPatch: true })) {
        return { body: source.slice(0, candidate.start).trim(), parsed, found: true };
      }
    } catch (_) {
      // A model may truncate the hidden block. Do not show a recognizable state
      // payload as narration even when it cannot safely be merged.
      if (startsLikeOfflineContinuityState(candidate.text)) {
        return { body: source.slice(0, candidate.start).trim(), parsed: null, found: false };
      }
    }
  }
  const leakedStart = findLeakedContinuityTailStart(source);
  if (leakedStart >= 0) {
    const knowledgeGains = collectLooseKnowledgeGainObjects(source.slice(leakedStart));
    return {
      body: source.slice(0, leakedStart).trim(),
      parsed: knowledgeGains.length ? { knowledgeGains } : null,
      found: knowledgeGains.length > 0,
    };
  }
  return null;
}

export function extractOfflineContinuityState(rawText = '', options = {}) {
  const raw = String(rawText || '');
  const start = raw.indexOf(OFFLINE_CONTINUITY_STATE_START);
  const previous = options.previousState || {};
  if (start < 0) {
    const bare = parseBareOfflineContinuityState(raw);
    return {
      body: bare ? bare.body : raw,
      patch: bare?.parsed || {},
      state: bare?.parsed
        ? mergeOfflineContinuityState(previous, bare.parsed, options)
        : normalizeOfflineContinuityState(previous, options),
      found: bare?.found === true,
    };
  }
  const contentStart = start + OFFLINE_CONTINUITY_STATE_START.length;
  const end = raw.indexOf(OFFLINE_CONTINUITY_STATE_END, contentStart);
  const block = raw.slice(contentStart, end >= 0 ? end : raw.length).trim();
  const body = `${raw.slice(0, start)}${end >= 0 ? raw.slice(end + OFFLINE_CONTINUITY_STATE_END.length) : ''}`.trim();
  const fence = block.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = (fence ? fence[1] : block).trim();
  const objectStart = source.indexOf('{');
  const objectEnd = source.lastIndexOf('}');
  let parsed = null;
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      parsed = JSON.parse(source.slice(objectStart, objectEnd + 1));
    } catch (_) { /* malformed state keeps the previous known state */ }
  }
  return {
    body,
    patch: parsed || {},
    state: mergeOfflineContinuityState(previous, parsed || {}, options),
    found: !!parsed,
  };
}
