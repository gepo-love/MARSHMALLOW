import {
  REPLY_COMPOSITION_VERSION,
  normalizeReplyContentPlan,
  packExpressionBeats,
  validateReplyComposition,
} from './reply-composition.js';

export const REPLY_PLAN_EVENT_TYPE = 'reply_plan';
export const REPLY_COMPOSITION_RECEIPT_START = '<<<REPLY_COMPOSITION_V1>>>';
export const REPLY_COMPOSITION_RECEIPT_END = '<<<END_REPLY_COMPOSITION_V1>>>';

const PROTECTED_MESSAGE_FIELDS = new Set([
  'reply',
  'zh',
  'translation',
  'speech',
  'speechPlan',
  'speech_plan',
  'sound',
  'relay',
  'inner',
  'intent',
  'mood',
  'custom',
]);

const PROTECTED_MESSAGE_BODY_RE = /(?:\[\s*(?:回复|图片|发送图片|红包|转账)|(?:https?:\/\/|www\.)\S+)/iu;

function clean(value = '') {
  return String(value ?? '').trim();
}

function cleanLower(value = '') {
  return clean(value).toLowerCase();
}

function uniqueStrings(values = []) {
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

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function eventActor(event = {}) {
  return clean(event.from || event.actor || event.senderId);
}

function beatIdOf(event = {}) {
  return clean(event.beatId || event.beat_id || event.compositionBeatId);
}

function eventHasProtectedPayload(event = {}) {
  if (PROTECTED_MESSAGE_BODY_RE.test(String(event.body ?? event.text ?? event.content ?? ''))) return true;
  if (event.protected === true) return true;
  for (const key of PROTECTED_MESSAGE_FIELDS) {
    const value = event[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    return true;
  }
  return false;
}

/**
 * 只解析专用 marker 中的小型 JSON 收据，不尝试理解整段自由思考文本。
 * 未闭合、重复、过大或 JSON 错误都是非致命诊断，调用方必须回退旧路径。
 */
export function extractReplyCompositionReceipt(rawText = '', options = {}) {
  const source = String(rawText || '');
  const maxChars = Math.max(512, Math.trunc(Number(options.maxChars) || 12_000));
  const starts = [];
  let cursor = 0;
  while (cursor < source.length) {
    const index = source.indexOf(REPLY_COMPOSITION_RECEIPT_START, cursor);
    if (index < 0) break;
    starts.push(index);
    cursor = index + REPLY_COMPOSITION_RECEIPT_START.length;
  }
  if (!starts.length) return { found: false, receipt: null, reason: 'receipt-missing' };
  if (starts.length > 1) return { found: true, receipt: null, reason: 'receipt-duplicate' };
  const start = starts[0] + REPLY_COMPOSITION_RECEIPT_START.length;
  const end = source.indexOf(REPLY_COMPOSITION_RECEIPT_END, start);
  if (end < 0) return { found: true, receipt: null, reason: 'receipt-unclosed' };
  const payload = source.slice(start, end).trim();
  if (!payload || payload.length > maxChars) {
    return { found: true, receipt: null, reason: payload ? 'receipt-too-large' : 'receipt-empty' };
  }
  try {
    const receipt = JSON.parse(payload);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      return { found: true, receipt: null, reason: 'receipt-not-object' };
    }
    return { found: true, receipt, reason: 'ok' };
  } catch (_) {
    return { found: true, receipt: null, reason: 'receipt-invalid-json' };
  }
}

function normalizePlanEvent(raw = {}) {
  const source = raw?.plan && typeof raw.plan === 'object' && !Array.isArray(raw.plan)
    ? raw.plan
    : raw;
  return normalizeReplyContentPlan({
    ...source,
    kind: source.kind || 'reply_composition',
    v: source.v ?? source.version ?? raw.v ?? raw.version ?? REPLY_COMPOSITION_VERSION,
  });
}

/**
 * reply_plan 是本轮隐藏的内容账本，不是可落库消息。这一步在任何
 * sender filter / materialize 之前将它分离，防止 plan-only 被误认成可见交付。
 */
export function extractReplyPlanEvent(events = []) {
  const source = Array.isArray(events) ? events : [];
  const planEvents = source.filter((event) => event?.t === REPLY_PLAN_EVENT_TYPE);
  return {
    planEvent: planEvents[0] || null,
    events: source.filter((event) => event?.t !== REPLY_PLAN_EVENT_TYPE),
    diagnostics: {
      planEventCount: planEvents.length,
      duplicatePlanEvents: Math.max(0, planEvents.length - 1),
    },
  };
}

function buildBeat(event, eventIndex, events, plan) {
  const previous = events[eventIndex - 1];
  const next = events[eventIndex + 1];
  const previousIsAnnotatedMessage = previous?.t === 'msg' && !!beatIdOf(previous);
  const nextIsAnnotatedMessage = next?.t === 'msg' && !!beatIdOf(next);
  const protectedPayload = eventHasProtectedPayload(event);
  return {
    id: beatIdOf(event),
    from: eventActor(event),
    act: cleanLower(event.act || event.move || event.compositionAct) || 'other',
    refs: uniqueStrings(event.refs || event.contentRefs || event.compositionRefs),
    required: event.required === true || event.compositionRequired === true,
    medium: 'text',
    text: String(event.body ?? event.text ?? event.content ?? ''),
    joinBefore: previousIsAnnotatedMessage
      ? (cleanLower(event.joinBefore || event.join_before) || 'soft')
      : 'hard',
    joinAfter: nextIsAnnotatedMessage
      ? (cleanLower(event.joinAfter || event.join_after) || 'soft')
      : 'hard',
    protected: protectedPayload,
    barrierBefore: !previousIsAnnotatedMessage || protectedPayload,
    barrierAfter: !nextIsAnnotatedMessage || protectedPayload,
    // packer 会原样把 sourceIndex 放进 group；这里故意用轮内数组下标，
    // 重建事件时不依赖模型可写的 sourceIndex。
    sourceIndex: eventIndex,
    ...(event.reply !== undefined ? { reply: cloneValue(event.reply) } : {}),
    ...(event.zh !== undefined ? { zh: cloneValue(event.zh) } : {}),
    ...(event.translation !== undefined ? { translation: cloneValue(event.translation) } : {}),
    ...(event.speech !== undefined ? { speech: cloneValue(event.speech) } : {}),
    ...(event.sound !== undefined ? { sound: cloneValue(event.sound) } : {}),
    ...(event.relay !== undefined ? { relay: cloneValue(event.relay) } : {}),
    plan,
  };
}

function groupMetadata(group, sourceEvents, plan, expression = {}) {
  const acts = uniqueStrings(group.beats?.map((beat) => beat.act));
  const obligationIds = new Set((plan.obligations || []).map((item) => clean(item.id)).filter(Boolean));
  const ownedIds = new Set((plan.owned || []).map((item) => clean(item.id)).filter(Boolean));
  const refs = [...(group.refs || [])];
  const deliveries = (group.beats || []).map((beat) => ({
    beatId: clean(beat.id),
    act: cleanLower(beat.act) || 'other',
    refs: [...(beat.refs || [])],
    obligationRefs: (beat.refs || []).filter((ref) => obligationIds.has(ref)),
    ownedRefs: (beat.refs || []).filter((ref) => ownedIds.has(ref)),
  }));
  const originIndexes = (group.sourceIndexes || []).map((index) => (
    sourceEvents[index]?.sourceIndex ?? index
  ));
  return {
    compositionVersion: REPLY_COMPOSITION_VERSION,
    compositionBeatIds: [...(group.beatIds || [])],
    compositionRefs: refs,
    compositionObligationRefs: refs.filter((ref) => obligationIds.has(ref)),
    compositionOwnedRefs: refs.filter((ref) => ownedIds.has(ref)),
    compositionDeliveries: deliveries,
    compositionActs: acts,
    compositionRequired: group.required === true,
    compositionTopicMove: plan.topicMove,
    compositionExpressionDrive: plan.expressionDrive,
    compositionExpressionReason: plan.expressionReason,
    compositionExpressionDrivers: [...(plan.expressionDrivers || [])],
    compositionExpressionSatisfied: expression.satisfied === true,
    compositionExpressionMinimumBeatCount: Number(expression.minimumBeatCount || 0),
    compositionExpressionMinimumOwnedCount: Number(expression.minimumOwnedCount || 0),
    packingOriginIndexes: originIndexes,
    ...(originIndexes.length === 1 ? { packingOriginIndex: originIndexes[0] } : {}),
  };
}

function annotateWithoutPacking(events, beats, plan, expression = {}) {
  const byIndex = new Map(beats.map((beat) => [beat.sourceIndex, beat]));
  const obligationIds = new Set((plan.obligations || []).map((item) => clean(item.id)).filter(Boolean));
  const ownedIds = new Set((plan.owned || []).map((item) => clean(item.id)).filter(Boolean));
  return events.map((event, index) => {
    const beat = byIndex.get(index);
    if (!beat) return event;
    return {
      ...event,
      compositionVersion: REPLY_COMPOSITION_VERSION,
      compositionBeatIds: [beat.id],
      compositionRefs: [...beat.refs],
      compositionObligationRefs: beat.refs.filter((ref) => obligationIds.has(ref)),
      compositionOwnedRefs: beat.refs.filter((ref) => ownedIds.has(ref)),
      compositionDeliveries: [{
        beatId: beat.id,
        act: beat.act,
        refs: [...beat.refs],
        obligationRefs: beat.refs.filter((ref) => obligationIds.has(ref)),
        ownedRefs: beat.refs.filter((ref) => ownedIds.has(ref)),
      }],
      compositionActs: [beat.act],
      compositionRequired: beat.required === true,
      compositionTopicMove: plan.topicMove,
      compositionExpressionDrive: plan.expressionDrive,
      compositionExpressionReason: plan.expressionReason,
      compositionExpressionDrivers: [...(plan.expressionDrivers || [])],
      compositionExpressionSatisfied: expression.satisfied === true,
      compositionExpressionMinimumBeatCount: Number(expression.minimumBeatCount || 0),
      compositionExpressionMinimumOwnedCount: Number(expression.minimumOwnedCount || 0),
      packingOriginIndexes: [event.sourceIndex ?? index],
      packingOriginIndex: event.sourceIndex ?? index,
    };
  });
}

/**
 * 在模型已经完成台词之后做确定性 packing。任何结构不完整都保留原消息，
 * 不修写台词、不补 filler、不触发第二次 API 请求。
 */
export function applyReplyCompositionPlan(events = [], rawPlanEvent = null, options = {}) {
  const source = Array.isArray(events) ? events : [];
  if (!rawPlanEvent) {
    return {
      events: source,
      applied: false,
      reason: 'plan-missing',
      diagnostics: { planPresent: false },
    };
  }

  const plan = normalizePlanEvent(rawPlanEvent);
  const messageIndexes = source
    .map((event, index) => (event?.t === 'msg' ? index : -1))
    .filter((index) => index >= 0);
  const annotatedIndexes = messageIndexes.filter((index) => !!beatIdOf(source[index]));
  if (!messageIndexes.length || annotatedIndexes.length !== messageIndexes.length) {
    return {
      events: source,
      applied: false,
      reason: messageIndexes.length ? 'beat-annotations-incomplete' : 'visible-message-missing',
      plan,
      diagnostics: {
        planPresent: true,
        messageCount: messageIndexes.length,
        annotatedMessageCount: annotatedIndexes.length,
      },
    };
  }

  const beats = annotatedIndexes.map((index) => buildBeat(source[index], index, source, plan));
  const allowedActors = Array.isArray(options.allowedActors)
    ? options.allowedActors
    : uniqueStrings(beats.map((beat) => beat.from));
  const validation = validateReplyComposition({ plan, beats }, {
    allowedActors,
    allowedMedia: ['text'],
    requireVisible: true,
    allowIntentionalSkip: options.allowIntentionalSkip === true,
  });
  if (!validation.ok) {
    return {
      events: source,
      applied: false,
      reason: 'composition-invalid',
      plan,
      beats,
      validation,
      diagnostics: {
        planPresent: true,
        validationErrors: validation.errors.map((error) => error.code),
        validationWarnings: validation.warnings.map((warning) => warning.code),
      },
    };
  }

  const packingEnabled = options.packingEnabled !== false;
  if (!packingEnabled) {
    return {
      events: annotateWithoutPacking(source, validation.beats, validation.plan, validation.expression),
      applied: true,
      packed: false,
      reason: 'metadata-only',
      plan: validation.plan,
      beats: validation.beats,
      validation,
      diagnostics: {
        planPresent: true,
        beforeCount: validation.beats.length,
        afterCount: validation.beats.length,
        rangeStatus: options.bubbleRange ? 'not-applied' : 'disabled',
      },
    };
  }

  const packed = packExpressionBeats(validation.beats, {
    plan: validation.plan,
    bubbleRange: options.bubbleRange,
    shortBubble: options.shortBubble === true,
    naturalCount: options.naturalCount,
    joiner: typeof options.joiner === 'string' ? options.joiner : '\n',
  });
  const groupsByFirstIndex = new Map();
  const skippedIndexes = new Set();
  for (const group of packed.groups) {
    const indexes = group.sourceIndexes || [];
    if (!indexes.length) continue;
    groupsByFirstIndex.set(indexes[0], group);
    indexes.slice(1).forEach((index) => skippedIndexes.add(index));
  }
  const nextEvents = [];
  source.forEach((event, index) => {
    if (skippedIndexes.has(index)) return;
    const group = groupsByFirstIndex.get(index);
    if (!group) {
      nextEvents.push(event);
      return;
    }
    nextEvents.push({
      ...event,
      body: group.text,
      ...groupMetadata(group, source, validation.plan, validation.expression),
    });
  });

  return {
    events: nextEvents,
    applied: true,
    packed: true,
    reason: 'ok',
    plan: validation.plan,
    beats: validation.beats,
    groups: packed.groups,
    validation,
    diagnostics: {
      planPresent: true,
      ...packed.diagnostics,
    },
  };
}

function receiptEventIndex(beat = {}) {
  const value = Number(beat.eventIndex ?? beat.event_index);
  return Number.isInteger(value) ? value : -1;
}

/**
 * 将隐藏收据绑定到已通过旧协议校验的 msg。收据不带台词；可见正文
 * 始终来自 MARSHMALLOW msg.body。
 */
export function applyReplyCompositionReceipt(events = [], receipt = null, options = {}) {
  const source = Array.isArray(events) ? events : [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { events: source, applied: false, reason: 'receipt-missing' };
  }
  const kind = cleanLower(receipt.kind);
  const version = Number(receipt.v ?? receipt.version);
  if (kind !== 'reply_composition' || version !== REPLY_COMPOSITION_VERSION) {
    return { events: source, applied: false, reason: 'receipt-version-unsupported' };
  }
  const receiptBeats = Array.isArray(receipt.beats) ? receipt.beats : [];
  const messageEventIndexes = source
    .map((event, index) => (event?.t === 'msg' ? index : -1))
    .filter((index) => index >= 0);
  if (!messageEventIndexes.length || receiptBeats.length !== messageEventIndexes.length) {
    return {
      events: source,
      applied: false,
      reason: 'receipt-message-count-mismatch',
      diagnostics: { beatCount: receiptBeats.length, messageCount: messageEventIndexes.length },
    };
  }
  const orderedIndexes = receiptBeats.map(receiptEventIndex);
  if (orderedIndexes.some((index) => index < 0 || index >= messageEventIndexes.length)
    || new Set(orderedIndexes).size !== orderedIndexes.length
    || orderedIndexes.some((index, position) => index !== position)) {
    return { events: source, applied: false, reason: 'receipt-event-index-invalid' };
  }

  const annotated = source.map((event) => ({ ...event }));
  receiptBeats.forEach((beat, messageIndex) => {
    const eventIndex = messageEventIndexes[messageIndex];
    annotated[eventIndex] = {
      ...annotated[eventIndex],
      beatId: clean(beat.id || beat.beatId || beat.beat_id),
      act: cleanLower(beat.act || beat.move),
      refs: uniqueStrings(beat.refs || beat.contentRefs),
      required: beat.required === true,
      joinBefore: cleanLower(beat.joinBefore || beat.join_before) || (messageIndex ? 'soft' : 'hard'),
      joinAfter: cleanLower(beat.joinAfter || beat.join_after) || 'soft',
    };
  });
  return applyReplyCompositionPlan(annotated, receipt.plan || receipt, options);
}
