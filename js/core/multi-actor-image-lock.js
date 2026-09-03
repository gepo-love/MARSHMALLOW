/**
 * 多主体生图锁脸：
 * 把 user / 多个 character 的外观提示与参考图合并为一次生图请求，
 * 并保留稳定的「参考图序号 → 主体」映射，供 GPT Image 多图编辑使用。
 */
import { getCharacter } from './character-store.js';
import { getCurrentUser } from './user-slot.js';
import {
  isRealisticImageGenerationEnabled,
  loadImageToolConfig,
} from './image-generation-tools.js';
import {
  applyCharacterImageLock,
  mergeImageLockIntoOptions,
} from './character-image-lock.js';
import { applyUserImageLock } from './user-image-lock.js';

export const MAX_MULTI_IDENTITY_SUBJECTS = 4;

function clean(value = '') {
  return String(value || '').trim();
}

export function hasImageSubjectLook(record = {}) {
  const row = record && typeof record === 'object' ? record : {};
  return !!(
    clean(row.appearancePrompt)
    || clean(row.imageLock?.prompt)
    || clean(row.imageLock?.refImageUrl || row.avatar)
  );
}

/**
 * 聊天手动生图的人物候选。人物是否在画面里与是否配置锁脸资料是两件事：
 * 没有 appearancePrompt / 参考图的人也必须能被选中，否则整个合照入口会凭空消失。
 * MAX_MULTI_IDENTITY_SUBJECTS 只限制本次勾选数，不能提前截掉后面的群成员。
 */
export function buildLockableImageSubjectChoices({
  user = {},
  participantIds = [],
  characters = {},
} = {}) {
  const choices = [];
  const seen = new Set();
  const userHasLook = hasImageSubjectLook(user);
  choices.push({ id: 'user', label: clean(user.name) || '我', checked: userHasLook, hasLook: userHasLook });
  seen.add('user');
  for (const rawId of Array.isArray(participantIds) ? participantIds : []) {
    const id = clean(rawId);
    if (!id || id === 'user' || seen.has(id)) continue;
    const character = characters?.[id];
    const hasLook = hasImageSubjectLook(character);
    choices.push({
      id,
      label: clean(character?.customNickname || character?.name) || id,
      checked: false,
      hasLook,
    });
    seen.add(id);
  }
  return choices;
}

export function normalizeImageSubjectIds(subjectIds = [], options = {}) {
  const allowed = options.allowedIds instanceof Set
    ? options.allowedIds
    : new Set((Array.isArray(options.allowedIds) ? options.allowedIds : []).map(clean).filter(Boolean));
  const hasAllowList = allowed.size > 0;
  const list = Array.isArray(subjectIds) ? subjectIds : [subjectIds];
  const normalized = [];
  for (const raw of list) {
    const id = clean(raw && typeof raw === 'object' ? (raw.id || raw.actorId || raw.subjectId) : raw);
    if (!id || normalized.includes(id) || (hasAllowList && !allowed.has(id))) continue;
    normalized.push(id);
    if (normalized.length >= MAX_MULTI_IDENTITY_SUBJECTS) break;
  }
  return normalized;
}

function subjectLabel(id, record = {}) {
  if (id === 'user') return clean(record.name || record.nickname || 'user');
  return clean(record.customNickname || record.name || id);
}

function inferSubjectType(record = {}) {
  const direct = clean(record?.gender).toLowerCase();
  const prompt = [record?.appearancePrompt, record?.imageLock?.prompt]
    .map(clean)
    .filter(Boolean)
    .join(', ')
    .toLowerCase();
  const haystack = `${direct}, ${prompt}`;
  if (/(?:^|[\s,，;；])(女|女性|女生|女孩|少女|woman|women|female|girl|1girl)(?:$|[\s,，;；])/iu.test(haystack)) {
    return 'girl';
  }
  if (/(?:^|[\s,，;；])(男|男性|男生|男孩|少年|man|men|male|boy|1boy)(?:$|[\s,，;；])/iu.test(haystack)) {
    return 'boy';
  }
  return 'person';
}

function countSubjectTag(count, type) {
  if (type === 'person') return `${count} ${count === 1 ? 'person' : 'people'}`;
  return `${count}${type}${count === 1 ? '' : 's'}`;
}

/** 勾选多人时把人数写进基础 prompt；否则没有锁脸资料的人虽然可选，请求本身却仍不知道是合照。 */
export function applySelectedSubjectCount(prompt = '', subjects = []) {
  const rows = Array.isArray(subjects) ? subjects.filter(Boolean) : [];
  if (rows.length <= 1) return clean(prompt);

  const counts = { girl: 0, boy: 0, person: 0 };
  rows.forEach((row) => { counts[inferSubjectType(row.record || row)] += 1; });
  const tags = ['girl', 'boy', 'person']
    .filter((type) => counts[type] > 0)
    .map((type) => countSubjectTag(counts[type], type));
  const rest = clean(prompt)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    // 单人锁定描述常以 1girl / 1boy 开头；合照时由上面的总人数标签统一接管。
    .filter((part) => !/^(?:solo|\d+(?:girls?|boys?|others?|people|persons?)|multiple\s+(?:girls|boys|others|people|persons))$/iu.test(part));
  return [...tags, ...rest].join(', ');
}

/**
 * 一张多人图只能采用一套人物媒介画风。只有所有已设置画风的主体一致时才继承；
 * 若彼此冲突，交回单次显式选择 / API 全局默认处理，不能让名单第一人覆盖整张图。
 */
export function resolveMultiActorStyleId(locks = [], requestedStyleId = '') {
  const requested = clean(requestedStyleId);
  if (requested) return requested;
  const styleIds = [...new Set((Array.isArray(locks) ? locks : [])
    .map((row) => clean(row?.lock?.styleId))
    .filter(Boolean))];
  return styleIds.length === 1 ? styleIds[0] : '';
}

export function buildMultiIdentityPrompt(prompt = '', referenceSubjects = []) {
  const refs = (Array.isArray(referenceSubjects) ? referenceSubjects : [])
    .filter((row) => row?.id)
    .slice(0, MAX_MULTI_IDENTITY_SUBJECTS);
  if (!refs.length) return clean(prompt);
  const mapping = refs
    .map((row, index) => `Input image ${index + 1} is the identity reference for ${row.label || row.id} (subject id: ${row.id}).`)
    .join('\n');
  if (refs.length === 1) {
    return [
      clean(prompt),
      'Identity preservation requirements:',
      mapping,
      'The input image defines who this person is, not the pose, framing, background, outfit, or lighting.',
      'Keep the same person and preserve their facial identity and defining appearance while following the requested scene and pose.',
      'Do not replace, merge, duplicate, or beautify them into a different person, and do not copy the reference composition unless requested.',
      'If the face is visible, it must clearly match the identity reference.',
    ].filter(Boolean).join('\n');
  }
  return [
    clean(prompt),
    'Identity preservation requirements:',
    mapping,
    'The input images define who these people are, not their pose, framing, background, outfit, or lighting.',
    'Keep these as separate, distinct people. Preserve each referenced person’s facial identity and defining appearance.',
    'Do not merge, average, swap, duplicate, or transfer facial features between subjects.',
    'Treat the references only as an identity library. The scene prompt decides who is actually visible; never add a referenced person merely because their image was supplied.',
    'For each person who is visible, include them exactly once. Referenced people who are not part of the depicted moment must remain outside the frame.',
  ].filter(Boolean).join('\n');
}

export async function applyMultiActorImageLocks(subjectIds = [], scenePrompt = '', options = {}) {
  const ids = normalizeImageSubjectIds(subjectIds, { allowedIds: options.allowedIds });
  if (!ids.length) {
    return { prompt: scenePrompt, providerOverride: '', subjectIds: [] };
  }

  const cfg = options.config || await loadImageToolConfig().catch(() => ({}));
  const suppliedCharacters = options.characters && typeof options.characters === 'object'
    ? options.characters
    : {};
  const user = ids.includes('user')
    ? (options.user || await getCurrentUser().catch(() => null))
    : null;

  let prompt = clean(scenePrompt);
  const locks = [];
  for (const id of ids) {
    let record = null;
    let lock = null;
    if (id === 'user') {
      record = user;
      lock = record
        ? await applyUserImageLock(record, prompt, { ...options, config: cfg }).catch(() => null)
        : null;
    } else {
      record = suppliedCharacters[id] || await getCharacter(id).catch(() => null);
      lock = record
        ? await applyCharacterImageLock(record, prompt, { ...options, config: cfg }).catch(() => null)
        : null;
    }
    if (!record || !lock) continue;
    prompt = lock.prompt || prompt;
    locks.push({ id, record, lock });
  }

  prompt = applySelectedSubjectCount(prompt, locks);

  const refImageUrls = [];
  const referenceSubjects = [];
  for (const row of locks) {
    const urls = Array.isArray(row.lock.refImageUrls) ? row.lock.refImageUrls.filter(Boolean) : [];
    for (const url of urls) {
      if (refImageUrls.length >= MAX_MULTI_IDENTITY_SUBJECTS) break;
      refImageUrls.push(url);
      referenceSubjects.push({ id: row.id, label: subjectLabel(row.id, row.record) });
    }
  }

  const hasReference = refImageUrls.length > 0;
  const referenceProvider = locks.find((row) => row.lock?.refImageUrls?.length)
    ?.lock?.providerOverride || '';
  const realisticPreferred = hasReference
    && referenceProvider !== 'novelai'
    && isRealisticImageGenerationEnabled(cfg);
  const requireReferenceIdentity = locks.some((row) => (
    row.lock?.requireReferenceIdentity === true && row.lock?.refImageUrls?.length
  ));
  const firstLock = locks[0]?.lock || null;
  const merged = mergeImageLockIntoOptions(firstLock, {
    prompt,
    providerOverride: realisticPreferred ? 'realistic' : (firstLock?.providerOverride || ''),
  });
  const resolvedStyleId = resolveMultiActorStyleId(locks, options.styleId);
  if (resolvedStyleId) merged.styleId = resolvedStyleId;
  else delete merged.styleId;
  if (realisticPreferred) merged.providerOverride = 'realistic';
  if (refImageUrls.length > 1) delete merged.seed;
  if (refImageUrls.length) merged.refImageUrls = refImageUrls;
  if (referenceSubjects.length) merged.referenceSubjects = referenceSubjects;
  if (refImageUrls.length) {
    merged.expectedReferenceCount = refImageUrls.length;
    merged.expectedReferenceSubjectIds = referenceSubjects.map((row) => row.id);
  }
  if (requireReferenceIdentity) {
    merged.requireReferenceIdentity = true;
    merged.referenceProviderFallback = true;
  }

  return {
    ...merged,
    // NAI 原生 prompt 必须保持 Danbooru 标签形态；GPT Image 的自然语言身份约束
    // 延迟到最终 Provider 已确定时再选用，避免手动切引擎或参考图跨渠道回退时串用。
    prompt,
    realisticIdentityPrompt: buildMultiIdentityPrompt(prompt, referenceSubjects),
    subjectIds: ids,
    refImageUrls,
    referenceSubjects,
    expectedReferenceCount: refImageUrls.length,
    expectedReferenceSubjectIds: referenceSubjects.map((row) => row.id),
  };
}
