/**
 * 回复组织的纯函数骨架：Content plan -> Expression beats -> Packing。
 *
 * 该模块不读写存储、不调用模型，也不修改棉花糖协议。编译结果只使用
 * 现有 msg 事件形状，便于后续在 validator 之前做窄接线。
 */

export const REPLY_COMPOSITION_KIND = 'reply_composition';
export const REPLY_COMPOSITION_VERSION = 1;
export const REPLY_COMPOSITION_CONTRACT_ID = 'REPLY_COMPOSITION_V1';
export const REPLY_COMPOSITION_RECEIPT_START = '<<<REPLY_COMPOSITION_V1>>>';
export const REPLY_COMPOSITION_RECEIPT_END = '<<<END_REPLY_COMPOSITION_V1>>>';

const TOPIC_MOVES = new Set(['continue', 'branch', 'close']);
const EXPRESSION_DRIVES = new Set(['quiet', 'steady', 'engaged', 'overflowing']);
const EXPRESSION_DRIVER_KINDS = new Set([
  'character_baseline',
  'user_input',
  'current_emotion',
  'unfinished_thread',
  'current_life',
  'relationship_tension',
  'memory_trigger',
]);
const OBLIGATION_RESOLUTIONS = new Set([
  'answer',
  'acknowledge',
  'decline',
  'defer',
  'intentionally-skip',
  'unresolved',
]);
const JOIN_KINDS = new Set(['hard', 'soft']);
const PROTECTED_BEAT_FIELDS = ['reply', 'zh', 'translation', 'speech', 'sound', 'relay'];

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value ?? '').trim();
}

function cleanLower(value = '') {
  return clean(value).toLowerCase();
}

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.trunc(number);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function uniqueCleanStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = clean(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function normalizePlanItem(raw = {}, { obligation = false } = {}) {
  const source = object(raw);
  const item = {
    id: clean(source.id || source.ref || source.key),
    kind: cleanLower(source.kind || source.type) || 'other',
    required: obligation ? source.required !== false : source.required === true,
  };
  if (obligation) {
    const resolution = cleanLower(source.resolution || source.resolve || source.status);
    item.resolution = OBLIGATION_RESOLUTIONS.has(resolution) ? resolution : 'unresolved';
  } else {
    item.grounding = clean(source.grounding || source.source || source.basis);
  }
  const intent = clean(source.intent || source.commitment || source.summary);
  if (intent) item.intent = intent;
  return item;
}

/**
 * 归一化内容计划。只复制已有语义单元，不从最终句子反推计划。
 */
export function normalizeReplyContentPlan(raw = {}) {
  const envelope = object(raw);
  const source = Object.keys(object(envelope.plan)).length ? object(envelope.plan) : envelope;
  const version = Math.max(1, finiteInteger(
    source.v ?? source.version ?? envelope.v ?? envelope.version,
    REPLY_COMPOSITION_VERSION,
  ));
  const topicMove = cleanLower(source.topicMove || source.topic_move || source.move);
  const expressionDrive = cleanLower(source.expressionDrive || source.expression_drive);
  return {
    kind: cleanLower(envelope.kind || source.kind) || REPLY_COMPOSITION_KIND,
    version,
    obligations: (Array.isArray(source.obligations) ? source.obligations : [])
      .map((item) => normalizePlanItem(item, { obligation: true })),
    owned: (Array.isArray(source.owned) ? source.owned : [])
      .map((item) => normalizePlanItem(item)),
    topicMove: TOPIC_MOVES.has(topicMove) ? topicMove : 'continue',
    expressionDrive: EXPRESSION_DRIVES.has(expressionDrive) ? expressionDrive : 'steady',
    expressionReason: clean(source.expressionReason || source.expression_reason).slice(0, 160),
    expressionDrivers: uniqueCleanStrings(source.expressionDrivers || source.expression_drivers)
      .map(cleanLower)
      .filter((value) => EXPRESSION_DRIVER_KINDS.has(value))
      .slice(0, 5),
  };
}

function hasProtectedPayload(source = {}) {
  if (source.protected === true) return true;
  return PROTECTED_BEAT_FIELDS.some((field) => {
    const value = source[field];
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  });
}

function copyProtectedFields(source = {}, target = {}) {
  for (const field of PROTECTED_BEAT_FIELDS) {
    if (source[field] === undefined) continue;
    target[field] = cloneValue(source[field]);
  }
  return target;
}

/**
 * 归一化表达拍。每个 beat 必须是一个可独立发送的完整语义单元；
 * packing 只能合并 beat，不能再拆其内部文本。
 */
export function normalizeExpressionBeats(raw = [], plan = {}) {
  const source = Array.isArray(raw) ? raw : (Array.isArray(raw?.beats) ? raw.beats : []);
  const normalizedPlan = normalizeReplyContentPlan(plan);
  const requiredRefs = new Set([
    ...normalizedPlan.obligations.filter((item) => item.required).map((item) => item.id),
    ...normalizedPlan.owned.filter((item) => item.required).map((item) => item.id),
  ].filter(Boolean));
  return source.map((value, index) => {
    const item = object(value);
    const refs = uniqueCleanStrings(item.refs || item.contentRefs || item.content_refs);
    const protectedBeat = hasProtectedPayload(item);
    const joinBeforeRaw = cleanLower(item.joinBefore || item.join_before || item.boundaryBefore);
    const joinAfterRaw = cleanLower(item.joinAfter || item.join_after || item.boundaryAfter);
    const required = item.required === true
      || (item.required !== false && refs.some((ref) => requiredRefs.has(ref)));
    const beat = {
      id: clean(item.id || item.beatId || item.beat_id),
      from: clean(item.from || item.actor || item.senderId),
      act: cleanLower(item.act || item.kind || item.type) || 'other',
      refs,
      required,
      medium: cleanLower(item.medium) || 'text',
      // 正文是用户可见数据；归一化不修剪、不改换行，只在 validator
      // 中用 trim 判断“是否为空”。
      text: String(item.text ?? item.body ?? item.content ?? ''),
      // 表达欲只描述角色此刻有多少真实内容想说，不制造气泡边界。
      // 首拍保留边缘屏障；其余边界只服从模型对已经写完台词的事后标注。
      joinBefore: index === 0
        ? 'hard'
        : (JOIN_KINDS.has(joinBeforeRaw) ? joinBeforeRaw : 'soft'),
      joinAfter: JOIN_KINDS.has(joinAfterRaw) ? joinAfterRaw : 'soft',
      protected: protectedBeat,
      barrierBefore: item.barrierBefore === true || protectedBeat,
      barrierAfter: item.barrierAfter === true || protectedBeat,
    };
    if (Object.prototype.hasOwnProperty.call(item, 'sourceIndex')) {
      beat.sourceIndex = cloneValue(item.sourceIndex);
    }
    copyProtectedFields(item, beat);
    return beat;
  });
}

function duplicateIds(items = []) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    if (!item.id) continue;
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates];
}

function validationError(code, context = {}) {
  return { code, ...context };
}

/**
 * 校验计划与表达拍的引用完整性。默认不允许“必接义务”无可见 beat。
 */
export function validateReplyComposition(raw = {}, options = {}) {
  const envelope = object(raw);
  const plan = normalizeReplyContentPlan(envelope.plan || envelope);
  const beats = normalizeExpressionBeats(envelope.beats || [], plan);
  const errors = [];
  const warnings = [];

  if (plan.kind !== REPLY_COMPOSITION_KIND) {
    errors.push(validationError('composition_kind_invalid', { kind: plan.kind }));
  }
  if (plan.version !== REPLY_COMPOSITION_VERSION) {
    errors.push(validationError('composition_version_unsupported', { version: plan.version }));
  }

  for (const [collection, items] of [['obligation', plan.obligations], ['owned', plan.owned]]) {
    items.forEach((item, index) => {
      if (!item.id) errors.push(validationError(`${collection}_id_missing`, { index }));
    });
    for (const id of duplicateIds(items)) {
      errors.push(validationError(`${collection}_id_duplicate`, { id }));
    }
  }
  const planIds = [...plan.obligations, ...plan.owned].map((item) => item.id).filter(Boolean);
  for (const id of duplicateIds(planIds.map((value) => ({ id: value })))) {
    errors.push(validationError('plan_ref_duplicate', { id }));
  }

  const knownRefs = new Set(planIds);
  const ownedById = new Map(plan.owned.map((item) => [item.id, item]));
  const allowedMedia = new Set(
    (Array.isArray(options.allowedMedia) ? options.allowedMedia : ['text'])
      .map(cleanLower)
      .filter(Boolean),
  );
  const allowedActors = Array.isArray(options.allowedActors)
    ? new Set(options.allowedActors.map(clean).filter(Boolean))
    : null;

  beats.forEach((beat, index) => {
    if (!beat.id) errors.push(validationError('beat_id_missing', { index }));
    if (!beat.from) errors.push(validationError('beat_actor_missing', { index, beatId: beat.id }));
    if (!beat.text.trim()) errors.push(validationError('beat_text_missing', { index, beatId: beat.id }));
    if (!allowedMedia.has(beat.medium)) {
      errors.push(validationError('beat_medium_unsupported', { index, beatId: beat.id, medium: beat.medium }));
    }
    if (allowedActors && beat.from && !allowedActors.has(beat.from)) {
      errors.push(validationError('beat_actor_not_allowed', { index, beatId: beat.id, actor: beat.from }));
    }
    if (!beat.refs.length) warnings.push(validationError('beat_without_refs', { index, beatId: beat.id }));
    beat.refs.forEach((ref) => {
      if (!knownRefs.has(ref)) {
        errors.push(validationError('beat_ref_unknown', { index, beatId: beat.id, ref }));
      }
      const owned = ownedById.get(ref);
      if (owned && !owned.grounding) {
        errors.push(validationError('owned_grounding_missing', { beatId: beat.id, ref }));
      }
    });
  });
  for (const id of duplicateIds(beats)) {
    errors.push(validationError('beat_id_duplicate', { id }));
  }

  const visibleRefIds = new Set(
    beats.filter((beat) => !!beat.text.trim()).flatMap((beat) => beat.refs),
  );
  const allowIntentionalSkip = options.allowIntentionalSkip === true;
  const requiredItems = [
    ...plan.obligations.filter((item) => item.required),
    ...plan.owned.filter((item) => item.required),
  ];
  const exemptRequiredIds = new Set(plan.obligations
    .filter((item) => item.required && item.resolution === 'intentionally-skip' && allowIntentionalSkip)
    .map((item) => item.id));
  for (const obligation of plan.obligations.filter((item) => item.required)) {
    if (obligation.resolution === 'unresolved') {
      errors.push(validationError('required_obligation_unresolved', { id: obligation.id }));
    }
    if (obligation.resolution === 'intentionally-skip' && !allowIntentionalSkip) {
      errors.push(validationError('required_obligation_skip_not_allowed', { id: obligation.id }));
    }
  }
  const requiredIds = requiredItems.map((item) => item.id).filter(Boolean);
  const uncoveredRequiredIds = requiredIds.filter((id) => (
    !exemptRequiredIds.has(id) && !visibleRefIds.has(id)
  ));
  uncoveredRequiredIds.forEach((id) => {
    errors.push(validationError('required_ref_uncovered', { id }));
  });
  if (options.requireVisible === true && beats.filter((beat) => !!beat.text.trim()).length === 0) {
    errors.push(validationError('visible_beat_required'));
  }

  const highExpressionDrive = plan.expressionDrive === 'engaged'
    || plan.expressionDrive === 'overflowing';
  if (highExpressionDrive && !plan.expressionReason) {
    errors.push(validationError('expression_reason_missing', { drive: plan.expressionDrive }));
  }
  if (highExpressionDrive && !plan.expressionDrivers.length) {
    errors.push(validationError('expression_drivers_missing', { drive: plan.expressionDrive }));
  }

  const coveredRequiredIds = requiredIds.filter((id) => (
    exemptRequiredIds.has(id) || visibleRefIds.has(id)
  ));
  const requiredTotal = requiredIds.length;
  const visibleBeats = beats.filter((beat) => !!beat.text.trim());
  const visibleBeatCount = visibleBeats.length;
  const requiredVisibleBeats = visibleBeats.filter((beat) => beat.required === true);
  const ownedIds = new Set(plan.owned.map((item) => item.id).filter(Boolean));
  const coveredOwnedIds = new Set(visibleBeats.flatMap((beat) => (
    beat.refs.filter((ref) => ownedIds.has(ref))
  )));
  const coverage = {
    requiredTotal,
    coveredCount: coveredRequiredIds.length,
    ratio: requiredTotal > 0 ? coveredRequiredIds.length / requiredTotal : 1,
    requiredIds,
    coveredRequiredIds,
    uncoveredRequiredIds,
  };
  const expression = {
    drive: plan.expressionDrive,
    reason: plan.expressionReason,
    drivers: [...plan.expressionDrivers],
    // 表达欲没有条数或“角色自有内容”配额。这里继续保留零值字段，
    // 兼容已落库的 v1 元数据，同时确保旧的 underfill 续力不会再创建。
    minimumBeatCount: 0,
    minimumOwnedCount: 0,
    visibleBeatCount,
    requiredVisibleBeatCount: requiredVisibleBeats.length,
    coveredRequiredOwnedCount: coveredOwnedIds.size,
    requiredOwnedBeatCount: 0,
    satisfied: true,
  };

  return {
    ok: errors.length === 0,
    plan,
    beats,
    errors,
    warnings,
    coverage,
    expression,
  };
}

function normalizeBubbleRange(options = {}) {
  let raw = options.bubbleRange;
  if (!raw && options.bubbleRangeEnabled === true) {
    raw = {
      min: options.bubbleRangeMin,
      max: options.bubbleRangeMax,
    };
  }
  if (!raw || typeof raw !== 'object' || raw.enabled === false) return null;
  const minValue = Number(raw.min ?? raw.bubbleRangeMin);
  const maxValue = Number(raw.max ?? raw.bubbleRangeMax);
  const min = Number.isFinite(minValue) && minValue >= 1 ? Math.trunc(minValue) : 1;
  const parsedMax = Number.isFinite(maxValue) && maxValue >= 1 ? Math.trunc(maxValue) : min;
  return { min, max: Math.max(min, parsedMax) };
}

function beatBoundary(left, right) {
  if (!left || !right) return { hard: true, reason: 'edge' };
  if (left.from !== right.from) return { hard: true, reason: 'actor-change' };
  if (left.medium !== right.medium) return { hard: true, reason: 'medium-change' };
  if (left.protected || right.protected) return { hard: true, reason: 'protected-beat' };
  if (left.barrierAfter || right.barrierBefore) return { hard: true, reason: 'explicit-barrier' };
  if (left.joinAfter === 'hard' || right.joinBefore === 'hard') {
    return { hard: true, reason: 'hard-boundary' };
  }
  return { hard: false, reason: 'soft-boundary' };
}

function evenlySelect(values = [], count = 0) {
  if (count <= 0 || !values.length) return [];
  if (count >= values.length) return [...values];
  const selected = [];
  for (let index = 1; index <= count; index += 1) {
    const position = Math.floor((index * values.length) / (count + 1));
    selected.push(values[position]);
  }
  return [...new Set(selected)];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function collectGroup(beats = [], joiner = '\n', index = 0) {
  const refs = uniqueCleanStrings(beats.flatMap((beat) => beat.refs));
  const sourceIndexes = beats
    .filter((beat) => Object.prototype.hasOwnProperty.call(beat, 'sourceIndex'))
    .map((beat) => cloneValue(beat.sourceIndex));
  return {
    id: `group_${index + 1}`,
    beatIds: beats.map((beat) => beat.id),
    beats: beats.map(cloneValue),
    from: beats[0]?.from || '',
    medium: beats[0]?.medium || 'text',
    refs,
    required: beats.some((beat) => beat.required),
    text: beats.map((beat) => beat.text).join(joiner),
    sourceIndexes,
    protected: beats.some((beat) => beat.protected),
  };
}

/**
 * 只对已经完成的 beat 做分组。范围不可行时保留全部内容并返回诊断，
 * 不补写、不复制、不删除 beat。
 */
export function packExpressionBeats(rawBeats = [], options = {}) {
  const beats = normalizeExpressionBeats(rawBeats, options.plan || {});
  const joiner = typeof options.joiner === 'string' ? options.joiner : '\n';
  const boundaries = [];
  for (let index = 1; index < beats.length; index += 1) {
    boundaries.push({ afterIndex: index - 1, ...beatBoundary(beats[index - 1], beats[index]) });
  }
  const hardBoundaries = boundaries.filter((boundary) => boundary.hard);
  const softBoundaries = boundaries.filter((boundary) => !boundary.hard);
  const feasibleMin = beats.length ? hardBoundaries.length + 1 : 0;
  const feasibleMax = beats.length;
  const requestedNatural = finiteInteger(options.naturalCount, 0);
  // P0 没有角色断句样本时不猜一个“默认气泡数”。保留表达层已经
  // 给出的独立 beats；后续接线由 persona profile 显式传 naturalCount。
  const baseNaturalCount = beats.length
    ? clamp(requestedNatural >= 1 ? requestedNatural : feasibleMax, feasibleMin, feasibleMax)
    : 0;
  // 短气泡只改 packing 偏置，不直接强制“一 beat 一泡”。无可再拆的软边界时
  // 自然不会改变数量。
  const naturalCount = options.shortBubble === true && baseNaturalCount < feasibleMax
    ? Math.ceil((baseNaturalCount + feasibleMax) / 2)
    : baseNaturalCount;
  const range = normalizeBubbleRange(options);
  let targetCount = naturalCount;
  let rangeStatus = range ? 'met' : 'disabled';
  let rangeUnmetReason = '';
  if (range) {
    const intersectionMin = Math.max(feasibleMin, range.min);
    const intersectionMax = Math.min(feasibleMax, range.max);
    if (range.min > feasibleMax) {
      targetCount = feasibleMax;
      rangeStatus = 'underflow';
      rangeUnmetReason = 'insufficient-independent-beats';
    } else if (range.max < feasibleMin) {
      targetCount = feasibleMin;
      rangeStatus = 'overflow';
      rangeUnmetReason = 'content-integrity';
    } else {
      targetCount = clamp(naturalCount, intersectionMin, intersectionMax);
    }
  }

  const mandatorySplitIndexes = new Set(hardBoundaries.map((boundary) => boundary.afterIndex));
  const additionalSplitCount = Math.max(0, targetCount - feasibleMin);
  const selectedSoftSplits = evenlySelect(
    softBoundaries.map((boundary) => boundary.afterIndex),
    additionalSplitCount,
  );
  const splitIndexes = new Set([...mandatorySplitIndexes, ...selectedSoftSplits]);
  const groups = [];
  let pending = [];
  beats.forEach((beat, index) => {
    pending.push(beat);
    if (splitIndexes.has(index) || index === beats.length - 1) {
      groups.push(collectGroup(pending, joiner, groups.length));
      pending = [];
    }
  });

  const sourceText = beats.map((beat) => beat.text).join(joiner);
  const packedText = groups.map((group) => group.text).join(joiner);
  return {
    beats,
    groups,
    diagnostics: {
      naturalCount,
      feasibleMin,
      feasibleMax,
      targetCount,
      actualCount: groups.length,
      requestedRange: range,
      rangeStatus,
      rangeUnmetReason,
      hardBoundaryCount: hardBoundaries.length,
      softBoundaryCount: softBoundaries.length,
      textConserved: sourceText === packedText,
      sourceText,
      packedText,
    },
  };
}

function singleBeatEventFields(group = {}) {
  if (group.beats?.length !== 1) return {};
  const beat = group.beats[0];
  return copyProtectedFields(beat, {});
}

/**
 * 把通过校验的组织结果编译成现有 msg 事件。
 */
export function compileReplyCompositionEvents(raw = {}, options = {}) {
  const envelope = object(raw);
  const validation = validateReplyComposition(envelope, options);
  const packed = packExpressionBeats(validation.beats, {
    ...options,
    plan: validation.plan,
  });
  const sourceIndexStart = Math.max(1, finiteInteger(options.sourceIndexStart, 1));
  const events = validation.ok
    ? packed.groups.map((group, index) => ({
      t: 'msg',
      from: group.from,
      body: group.text,
      sourceIndex: sourceIndexStart + index,
      compositionVersion: REPLY_COMPOSITION_VERSION,
      compositionBeatIds: [...group.beatIds],
      compositionRefs: [...group.refs],
      compositionRequired: group.required,
      packingOriginIndexes: cloneValue(group.sourceIndexes),
      ...(group.sourceIndexes.length === 1
        ? { packingOriginIndex: cloneValue(group.sourceIndexes[0]) }
        : {}),
      ...singleBeatEventFields(group),
    }))
    : [];
  const analysis = analyzeReplyComposition({
    plan: validation.plan,
    beats: validation.beats,
    events,
    diagnostics: packed.diagnostics,
    validation,
  }, options);
  return {
    ok: validation.ok,
    events,
    plan: validation.plan,
    beats: validation.beats,
    groups: packed.groups,
    validation,
    diagnostics: {
      ...packed.diagnostics,
      ...analysis,
    },
  };
}

/**
 * 生成不含时间、随机数或存储状态的稳定诊断。
 */
export function analyzeReplyComposition(raw = {}, options = {}) {
  const source = object(raw);
  const plan = normalizeReplyContentPlan(source.plan || source);
  const beats = normalizeExpressionBeats(source.beats || [], plan);
  // 诊断必须基于当前输入重算，不信任上一次 compile 携带的 validation；
  // 否则调用方修改 beats 后会继续得到过期 coverage。
  const validation = validateReplyComposition({ plan, beats }, options);
  const events = Array.isArray(source.events) ? source.events : [];
  const joiner = typeof options.joiner === 'string' ? options.joiner : '\n';
  const messageEvents = events.filter((event) => event?.t === 'msg');
  const sourceText = beats.map((beat) => beat.text).join(joiner);
  const outputText = messageEvents.map((event) => String(event.body ?? event.text ?? '')).join(joiner);
  const expectedBeatIds = beats.map((beat) => beat.id);
  const emittedBeatIds = messageEvents.flatMap((event) => (
    Array.isArray(event.compositionBeatIds) ? event.compositionBeatIds.map(clean) : []
  ));
  const missingBeatIds = expectedBeatIds.filter((id) => !emittedBeatIds.includes(id));
  const duplicateEmittedBeatIds = duplicateIds(emittedBeatIds.map((id) => ({ id })));
  const orderConserved = expectedBeatIds.length === emittedBeatIds.length
    && expectedBeatIds.every((id, index) => emittedBeatIds[index] === id);
  const textConserved = sourceText === outputText;
  const repacked = packExpressionBeats(beats, { ...options, plan });
  const requestedRange = normalizeBubbleRange(options);
  let rangeStatus = 'disabled';
  let rangeUnmetReason = '';
  if (requestedRange) {
    if (messageEvents.length < requestedRange.min) {
      rangeStatus = 'underflow';
      rangeUnmetReason = repacked.diagnostics.rangeStatus === 'underflow'
        ? repacked.diagnostics.rangeUnmetReason
        : 'actual-count-below-range';
    } else if (messageEvents.length > requestedRange.max) {
      rangeStatus = 'overflow';
      rangeUnmetReason = repacked.diagnostics.rangeStatus === 'overflow'
        ? repacked.diagnostics.rangeUnmetReason
        : 'actual-count-above-range';
    } else {
      rangeStatus = 'met';
    }
  }
  const orphanBeatIds = expectedBeatIds.filter((id) => !emittedBeatIds.includes(id));
  return {
    valid: validation.ok === true && textConserved && orderConserved,
    beforeCount: beats.length,
    afterCount: messageEvents.length,
    requiredCoverage: cloneValue(validation.coverage || {
      requiredTotal: 0,
      coveredCount: 0,
      ratio: 1,
      requiredIds: [],
      coveredRequiredIds: [],
      uncoveredRequiredIds: [],
    }),
    // unreferenced 是内容计划诊断；orphan 则专指没有映射到任何输出事件的 beat。
    unreferencedBeatCount: beats.filter((beat) => beat.refs.length === 0).length,
    orphanBeatCount: orphanBeatIds.length,
    orphanBeatIds,
    multiBeatBubbleCount: messageEvents.filter((event) => (
      Array.isArray(event.compositionBeatIds) && event.compositionBeatIds.length > 1
    )).length,
    textConserved,
    orderConserved,
    sourceText,
    outputText,
    missingBeatIds,
    duplicateEmittedBeatIds,
    rangeStatus,
    rangeUnmetReason,
  };
}

/** 同次生成使用的隐藏结构契约；只描述计划与可见 beat 的对应关系。 */
export function buildReplyCompositionContract() {
  return [
    `【${REPLY_COMPOSITION_CONTRACT_ID}】`,
    '先完全按人物与当前语境写完自然的可见回复，再在已有 <<<THINKING>>> 内追加一份简短的事后收据；收据不得反过来增加内容、拆句、改写措辞或改变气泡数量，不展开推理，不复制最终台词：',
    REPLY_COMPOSITION_RECEIPT_START,
    '{"kind":"reply_composition","v":1,"plan":{"obligations":[{"id":"q1","kind":"question","required":true,"resolution":"answer"}],"owned":[{"id":"s1","kind":"opinion","grounding":"character-card","required":false}],"topicMove":"continue","expressionDrive":"engaged","expressionDrivers":["user_input"],"expressionReason":"此刻确实想把判断说清"},"beats":[{"id":"b1","eventIndex":0,"act":"answer-and-share","refs":["q1","s1"],"required":true}]}',
    REPLY_COMPOSITION_RECEIPT_END,
    'eventIndex 只把已经写出的本轮 msg 从 0 连续登记；beats 是逐条交付记录，不是写作提纲。每条现有 msg 登记一条，同一条可引用多个 obligations / owned；绝不能为了让一个语义动作独占一拍而拆气泡。beat 只记 act 与 refs，不写 text/body；普通相邻消息省略 joinBefore，只有引用、角色切换、媒介切换等确实不可合并的边界才写 hard。',
    'plan 是对已完成回复的简短归档：obligations 只登记本轮确实需要处理的明确问题、请求或边界；owned 只登记角色已经自然说出的自身观点、经历、偏好、计划或矛盾，没有就留空，不为提高主动性硬塞。可见台词始终只写在 MARSHMALLOW msg.body。',
    'plan.expressionDrive 只记录本轮真实表达欲：quiet / steady / engaged / overflowing。根据人物基线、最新 user 输入、当前情绪、未完线头、此刻生活或记忆触发填写 expressionDrivers 与一句 expressionReason；expressionDrivers 只可从 character_baseline / user_input / current_emotion / unfinished_thread / current_life / relationship_tension / memory_trigger 中选择。表达欲不对应任何最低条数、字数、内容类别或 owned 配额：engaged / overflowing 可以是一条完整长句，也可以是自然追发；quiet / steady 也不妨碍必要时说清楚。若高表达欲来自本轮命中的 unfinished_thread，已有可见回复应推进、暂缓或关闭对应线头；没有推进意愿就如实记录较低表达欲。禁止为了证明表达欲而套用“回应＋自我分享＋观点/追问”或“首先＋其次＋最后”的结构。',
    '如果结构化心理连续性给出了“线头 id”，真正交出那一层时必须原样复用该 id 作为 owned.id 与 beat ref；act 用 self-disclose（交出一层）、resolve-disclosure（说清并关线）或 boundary（明确不说并关线）。只在 inner 里想过不能列为已交付。',
    '气泡 packing 只可能合并已经自然写出的相邻消息；不拆分，不为达到下限增写、复制或空洞拆句。',
  ].join('\n');
}

function messageContentContains(content, marker) {
  if (typeof content === 'string') return content.includes(marker);
  if (!Array.isArray(content)) return false;
  return content.some((part) => (
    typeof part === 'string'
      ? part.includes(marker)
      : String(part?.text || '').includes(marker)
  ));
}

function appendMessageContent(content, addition) {
  if (Array.isArray(content)) {
    return [...content.map(cloneValue), { type: 'text', text: addition }];
  }
  const current = String(content ?? '').trimEnd();
  return current ? `${current}\n\n${addition}` : addition;
}

/**
 * 不变更原数组/消息，且重复调用不会重复追加契约。
 */
export function appendReplyCompositionContract(messages = [], options = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const contract = clean(options.contract) || buildReplyCompositionContract();
  const marker = clean(options.marker) || REPLY_COMPOSITION_CONTRACT_ID;
  const cloned = source.map((message) => cloneValue(object(message)));
  if (cloned.some((message) => (
    message.role === 'system' && messageContentContains(message.content, marker)
  ))) return cloned;
  const systemIndex = cloned.findIndex((message) => message.role === 'system');
  if (systemIndex >= 0) {
    cloned[systemIndex] = {
      ...cloned[systemIndex],
      content: appendMessageContent(cloned[systemIndex].content, contract),
    };
    return cloned;
  }
  return [{ role: 'system', content: contract }, ...cloned];
}
