import {
  MOOD_BASELINE,
  nextMoodValue,
  sanitizeCustomStateFields,
  sanitizeInnerVoiceText,
  sanitizeIntentText,
  sanitizeStatusText,
} from './chat/character-state.js';
import { messageLikelyNeedsTranslation, sanitizeAiTranslation } from './translation-utils.js';
import { normalizeTranslationProfile } from '../models/character.js';

export const OFFLINE_CHARACTER_STATES_START = '<<<OFFLINE_CHARACTER_STATES>>>';
export const OFFLINE_CHARACTER_STATES_END = '<<<END_OFFLINE_CHARACTER_STATES>>>';

function clean(value = '') {
  return String(value ?? '').trim();
}

function compactPromptText(value = '', maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trim()}…`;
}

function compactAnchorText(value = '', maxLength = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function actorName(actor = {}) {
  return clean(actor.name || actor.id) || '角色';
}

export function resolveOfflineCharacterStateDisplayName(
  characterId = '',
  storedName = '',
  currentName = '',
) {
  const id = clean(characterId);
  const looksInternal = (value = '') => {
    const name = clean(value);
    return !name
      || name === id
      || /^(?:char(?:acter)?|npc|contact)_[a-z0-9_-]+$/iu.test(name);
  };
  const live = clean(currentName);
  if (!looksInternal(live)) return live;
  const stored = clean(storedName);
  if (!looksInternal(stored)) return stored;
  return 'TA';
}

export function latestOfflineCharacterStates(session = {}, characterIds = []) {
  const wanted = new Set((Array.isArray(characterIds) ? characterIds : [])
    .map((id) => clean(id))
    .filter(Boolean));
  const found = {};
  const beats = Array.isArray(session?.beats) ? session.beats : [];
  for (let i = beats.length - 1; i >= 0; i -= 1) {
    const states = beats[i]?.characterStates;
    if (!states || typeof states !== 'object') continue;
    for (const [charId, state] of Object.entries(states)) {
      if (!charId || found[charId] || (wanted.size && !wanted.has(charId))) continue;
      if (state && typeof state === 'object') found[charId] = state;
    }
    if (wanted.size && Object.keys(found).length >= wanted.size) break;
  }
  return found;
}

export function offlineCharacterStatesInstruction(actors = [], previousStates = {}, options = {}) {
  const list = (Array.isArray(actors) ? actors : [])
    .map((actor) => ({
      id: clean(actor?.id),
      name: actorName(actor),
      translationProfile: normalizeTranslationProfile(actor?.translationProfile),
    }))
    .filter((actor) => actor.id && actor.id !== 'user' && actor.id !== 'system');
  if (!list.length) return '';
  const previous = list
    .map((actor) => {
      const state = previousStates?.[actor.id];
      if (!state) return '';
      const parts = [
        state.intent ? `盘算「${compactPromptText(sanitizeIntentText(state.intent))}」` : '',
        state.status ? `状态「${sanitizeStatusText(state.status)}」` : '',
        Object.keys(sanitizeCustomStateFields(state.custom)).length
          ? `自定义字段 ${JSON.stringify(sanitizeCustomStateFields(state.custom))}`
          : '',
        `情绪波动值 ${Number.isFinite(Number(state.moodValue)) ? Math.round(Number(state.moodValue)) : MOOD_BASELINE}/100`,
      ].filter(Boolean);
      return `- ${actor.id}（${actor.name}）：${parts.join('，')}`;
    })
    .filter(Boolean);
  const customPrompt = options.generationMode === 'custom'
    ? String(options.generationPrompt || '').trim().slice(0, 4000)
    : '';
  const actorGenerationPrompts = options.actorGenerationPrompts
    && typeof options.actorGenerationPrompts === 'object'
    ? list.map((actor) => {
      const prompt = String(options.actorGenerationPrompts[actor.id] || '').trim().slice(0, 2000);
      return prompt ? `- ${actor.id}（${actor.name}）：${prompt}` : '';
    }).filter(Boolean)
    : [];
  const customExample = customPrompt ? ',"custom":{"自定义字段":"按要求填写"}' : '';
  const userPresent = options.userPresent !== false;
  const userName = clean(options.userName);
  const userReference = !userPresent
    ? '本场没有用户或聊天对象；心声只能围绕在场角色、环境与角色自己的判断。'
    : (userName && !/^(?:用户|user|我)$/iu.test(userName)
      ? `聊天对象显示名是「${userName}」；心声中按角色习惯使用这个名字、昵称、关系称呼、TA 或省略主语。`
      : '心声中按角色习惯使用关系称呼、TA 或省略主语。');
  const requiredIds = list.map((actor) => actor.id);
  const naturalEnsemble = options.naturalEnsemble === true && list.length > 1;
  const translationRules = list.map((actor) => {
    const profile = normalizeTranslationProfile(actor.translationProfile);
    if (profile.mode === 'full') {
      return `- ${actor.id}=${actor.name}：inner 必须使用${profile.language || '角色设定的外语或方言'}原文，并在同一行填写 innerZh 作为完整、通顺的简体中文普通话翻译。`;
    }
    if (profile.mode === 'mixed') {
      return `- ${actor.id}=${actor.name}：inner 按角色自然口吻书写；只要出现${profile.dialectNote || profile.language || '设定的外语或方言'}，就在同一行填写 innerZh 作为完整的简体中文普通话版本；未出现时省略 innerZh。`;
    }
    return '';
  }).filter(Boolean);
  return [
    '【线下心声 · 隐藏结构块】',
    '可见叙事正文写完后，必须追加下面的结构块；它不会显示在正文里。',
    naturalEnsemble
      ? `本轮使用自然群像。允许的角色 id：${list.map((actor) => `${actor.id}=${actor.name}`).join('；')}。只为可见正文中真正成为本轮聚光对象、且能提供第二层信息的角色输出心声，通常 1～2 条；未发言、未行动、只在背景或根本没入镜的人必须省略，禁止用心声反向给全员点名。禁止写 user，禁止使用名字代替 from 里的 id。`
      : `本轮必须恰好输出 ${list.length} 条心声，当前在场角色每人一条：${list.map((actor) => `${actor.id}=${actor.name}`).join('；')}。即使某人本轮没有说话、没有出现在正文焦点中，也绝不能省略。禁止写 user，禁止使用名字代替 from 里的 id。`,
    naturalEnsemble
      ? '完整性硬校验：每条 from 必须来自允许 id 且不能重复；每条必须带能在正文逐字找到、并确属该角色的 anchor。不要为了凑人数生成无锚点心声。结束响应前自行核对，不要输出核对过程。'
      : `完整性硬校验：from 的集合必须与 ${JSON.stringify(requiredIds)} 完全相等，每个 id 恰好出现一次；少一人、多一人、重复或用姓名替代 id 都是不合格输出。结束响应前自行核对数量，不要输出核对过程。`,
    'inner 是角色此刻真正没说出口的 1～4 句脑内短段，用角色自己的口吻，允许犹豫、误解、嘴硬与关系判断。它必须提供正文表面之下的第二层信息：角色为何改口、对关系哪里拿不准、认出了什么旧习惯、藏住了什么，或此刻最不愿承认的私人反应；不要写动作、环境旁白、人物小传或把正文改写一遍。',
    'anchor 用于决定心声入口插在正文哪里：从可见正文中复制一段 6～40 字的连续原文，必须来自该角色本轮最近一次有意义的动作、对白或被描写处所在段落。A 的 anchor 只能锚定 A，禁止为了排列好看把 C 的心声挂在 A/B 的互动中。该角色本轮完全没有进入正文时填空字符串，系统会把其心声收在正文末尾；不要捏造锚点。',
    '关系信息必须服从角色卡、用户卡和已经发生的共同经历。资料不足时只写角色自己的不确定、试探或错误猜测，不替聊天对象补性格、感受、期待、过去或默认亲密。',
    userPresent
      ? `${userReference} 禁止把聊天对象称作“用户”或 user；它们只是内部身份标签。`
      : `${userReference} 禁止虚构用户、玩家、导演、旁观者或第二人称对象的心声与互动。`,
    'intent 是下一拍真实盘算，可为空；status 是角色此刻正在做什么的短句；moodShift 是相对上一轮的波动，普通互动 -3..+4，重大冲突或亲密转折才可更大，范围 -20..20。',
    translationRules.length
      ? `心声语言跟随角色翻译设置：\n${translationRules.join('\n')}\ninnerZh 只翻译 inner。intent、status 以及 custom 中所有自然语言字符串仍必须直接使用简体中文普通话。`
      : '这个隐藏结构块是给用户直接阅读的状态摘要：inner、intent、status 以及 custom 中所有自然语言字符串都必须直接使用简体中文。不要额外输出 zh 或 innerZh 翻译字段。',
    customPrompt
      ? `本场使用自定义心声方案。严格按下面要求生成，并把其中要求的额外字段全部放进每行 JSON 的 custom 对象；不要把自定义字段放在 JSON 顶层：\n${customPrompt}`
      : '',
    actorGenerationPrompts.length
      ? `以下角色使用各自关联会话的心声方案。只把对应要求用于对应 id；额外字段放进该行 custom 对象，不要串给其他角色：\n${actorGenerationPrompts.join('\n')}`
      : '',
    previous.length ? `上一轮状态（只用于连续性，不要照抄 inner）：\n${previous.join('\n')}` : '',
    OFFLINE_CHARACTER_STATES_START,
    ...(naturalEnsemble
      ? [`{"from":"<本轮实际聚光角色id>","anchor":"该角色正文段落中的连续原文","inner":"该角色此刻未说出口的心声","intent":"","status":"此刻状态","moodShift":0${customExample}}`]
      : list.map((actor) => {
        const profile = normalizeTranslationProfile(actor.translationProfile);
        const translationExample = profile.mode === 'full'
          ? `,"innerZh":"该心声的完整简体中文翻译"`
          : '';
        return `{"from":"${actor.id}","anchor":"该角色正文段落中的连续原文","inner":"该角色本轮未说出口的心声"${translationExample},"intent":"","status":"此刻状态","moodShift":0${customExample}}`;
      })),
    OFFLINE_CHARACTER_STATES_END,
  ].filter(Boolean).join('\n');
}

function parseJsonLine(line = '') {
  const text = clean(line).replace(/^```(?:json)?\s*|```$/gi, '').replace(/,\s*$/, '');
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function parseStateItems(block = '') {
  const text = clean(block).replace(/^```(?:json)?\s*|```$/gi, '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((item) => item && typeof item === 'object');
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch (_) {
    // JSONL 与多行对象继续走下面的兼容扫描。
  }
  const items = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const item = parseJsonLine(text.slice(start, index + 1));
        if (item) items.push(item);
        start = -1;
      }
    }
  }
  return items;
}

export function extractOfflineCharacterStates(rawText = '', options = {}) {
  const raw = String(rawText || '');
  const start = raw.indexOf(OFFLINE_CHARACTER_STATES_START);
  if (start < 0) return { body: raw, states: {}, found: false };
  const contentStart = start + OFFLINE_CHARACTER_STATES_START.length;
  const end = raw.indexOf(OFFLINE_CHARACTER_STATES_END, contentStart);
  const block = end >= 0 ? raw.slice(contentStart, end) : raw.slice(contentStart);
  const body = `${raw.slice(0, start)}${end >= 0 ? raw.slice(end + OFFLINE_CHARACTER_STATES_END.length) : ''}`.trim();
  const actors = (Array.isArray(options.actors) ? options.actors : [])
    .map((actor) => ({
      id: clean(actor?.id),
      name: actorName(actor),
      translationProfile: normalizeTranslationProfile(actor?.translationProfile),
    }))
    .filter((actor) => actor.id);
  const byId = new Map(actors.map((actor) => [actor.id, actor]));
  const nameCounts = new Map();
  actors.forEach((actor) => nameCounts.set(actor.name, (nameCounts.get(actor.name) || 0) + 1));
  const byName = new Map(actors
    .filter((actor) => nameCounts.get(actor.name) === 1)
    .map((actor) => [actor.name, actor]));
  const previousStates = options.previousStates && typeof options.previousStates === 'object'
    ? options.previousStates
    : {};
  const states = {};

  for (const item of parseStateItems(block)) {
    const rawFrom = clean(item.from || item.actor || item.characterId);
    const actor = byId.get(rawFrom) || byName.get(rawFrom);
    if (!actor || actor.id === 'user' || states[actor.id]) continue;
    const inner = sanitizeInnerVoiceText(item.inner || item.innerVoice || '', options.userName);
    const intent = sanitizeIntentText(item.intent || item.plan || '', options.userName);
    const status = sanitizeStatusText(item.status || '', options.userName);
    const custom = sanitizeCustomStateFields(item.custom || item.fields || item.extra);
    if (!inner && !intent && !status && !Object.keys(custom).length) continue;
    const previous = previousStates[actor.id] || {};
    const profile = normalizeTranslationProfile(actor.translationProfile);
    const languageHint = [profile.language, profile.dialectNote].filter(Boolean).join(' ');
    const expectsInnerTranslation = profile.mode === 'full'
      || (profile.mode === 'mixed' && messageLikelyNeedsTranslation(inner));
    states[actor.id] = {
      anchor: compactAnchorText(item.anchor || item.narrativeAnchor || ''),
      inner,
      innerTranslation: inner && (expectsInnerTranslation || messageLikelyNeedsTranslation(inner))
        ? sanitizeAiTranslation(inner, item.innerZh || item.zh || '', { languageHint })
        : '',
      intent,
      mood: '',
      status,
      custom,
      moodValue: nextMoodValue(previous.moodValue, item.moodShift),
      name: actor.name,
      recordedAt: Number(options.recordedAt || Date.now()) || Date.now(),
    };
  }
  return { body, states, found: true };
}

/**
 * 自然群像只保留真正锚定到本轮正文的少量心声。模型即使违令给角色池全员
 * 生成 state，也不能让隐藏结构反向把每个人都变成本轮焦点。
 */
export function filterNaturalEnsembleCharacterStates(states = {}, narration = '', maxCount = 2) {
  const source = compactAnchorText(narration, Number.MAX_SAFE_INTEGER);
  const limit = Math.max(1, Math.min(2, Number(maxCount) || 2));
  const kept = Object.entries(states && typeof states === 'object' ? states : {})
    .filter(([, state]) => {
      const anchor = compactAnchorText(state?.anchor || '', 120);
      return !!anchor && source.includes(anchor);
    })
    .slice(0, limit);
  return Object.fromEntries(kept);
}

function actorNameCandidates(name = '') {
  const full = compactAnchorText(name, 80);
  if (!full) return [];
  const candidates = [full];
  const parts = full.split(/[·・•\s]+/u).map((part) => part.trim()).filter((part) => part.length >= 2);
  candidates.push(...parts);
  if (/^[\p{Script=Han}]{3,4}$/u.test(full)) candidates.push(full.slice(1));
  return [...new Set(candidates)].sort((a, b) => b.length - a.length);
}

/**
 * 把每条多人线下心声绑定到对应角色的正文段落。
 * 新内容优先使用模型返回的逐字 anchor；旧楼层再按角色名回退。完全找不到归属时
 * 收到正文末尾，避免继续用等距算法把 C 的心声插进 A/B 的对手戏。
 */
export function placeOfflineCharacterStateAnchors(paragraphs = [], stateEntries = []) {
  const normalizedParagraphs = (Array.isArray(paragraphs) ? paragraphs : [])
    .map((paragraph) => compactAnchorText(paragraph, Number.MAX_SAFE_INTEGER));
  const lastIndex = Math.max(0, normalizedParagraphs.length - 1);
  return (Array.isArray(stateEntries) ? stateEntries : []).map(([characterId, state]) => {
    const anchor = compactAnchorText(state?.anchor || '', 120);
    let paragraphIndex = anchor
      ? normalizedParagraphs.findIndex((paragraph) => paragraph.includes(anchor))
      : -1;
    let matchedBy = paragraphIndex >= 0 ? 'anchor' : '';
    if (paragraphIndex < 0) {
      const candidates = actorNameCandidates(state?.name || '');
      for (let index = normalizedParagraphs.length - 1; index >= 0; index -= 1) {
        if (candidates.some((candidate) => normalizedParagraphs[index].includes(candidate))) {
          paragraphIndex = index;
          matchedBy = 'name';
          break;
        }
      }
    }
    if (paragraphIndex < 0) {
      paragraphIndex = lastIndex;
      matchedBy = 'tail';
    }
    return { characterId, state, paragraphIndex, matchedBy };
  });
}

export function offlineCharacterStateHistory(session = {}, characterId = '', currentBeatId = '') {
  const id = clean(characterId);
  if (!id) return [];
  const beats = Array.isArray(session?.beats) ? session.beats : [];
  return beats
    .filter((beat) => beat?.role === 'narration' && beat?.id !== currentBeatId && beat?.characterStates?.[id])
    .map((beat) => ({
      ...beat.characterStates[id],
      id: `${beat.id}:${id}`,
      beatId: String(beat.id || '').trim(),
      charId: id,
      recordedAt: Number(beat.characterStates[id]?.recordedAt || beat.ts || 0) || Date.now(),
    }))
    .sort((a, b) => Number(b.recordedAt || 0) - Number(a.recordedAt || 0));
}
