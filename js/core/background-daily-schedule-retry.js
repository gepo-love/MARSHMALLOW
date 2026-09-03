export const DAILY_SCHEDULE_GEN_STATE_VERSION = 4;

export const DAILY_SCHEDULE_REQUEST_STATE = Object.freeze({
  REQUEST_NOT_STARTED: 'request_not_started',
  SUBMITTED_UNKNOWN: 'submitted_unknown',
  COMPLETED: 'completed',
});

export const DAILY_SCHEDULE_ATTEMPT_STATUS = Object.freeze({
  EXECUTING: 'executing',
  RETRY_COOLDOWN: 'retry-cooldown',
  NEEDS_USER_RETRY: 'needs-user-retry',
  EXHAUSTED: 'exhausted',
});

// 首次执行也计入上限；只有能明确证明请求尚未开始的失败才会使用这两次重试机会。
export const DAILY_SCHEDULE_PREFLIGHT_RETRY_DELAYS_MS = Object.freeze([
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
]);
export const DAILY_SCHEDULE_MAX_AUTOMATIC_ATTEMPTS_PER_DAY =
  DAILY_SCHEDULE_PREFLIGHT_RETRY_DELAYS_MS.length + 1;
export const DAILY_SCHEDULE_MANUAL_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const COMPLETED_OUTPUT_FAILURE_REASONS = new Set([
  'empty_api_response',
  'json_parse_failed',
  'schedule_unverified_user_presence',
  'schedule_plot_repeated',
]);

function marker(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function finiteTimestamp(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback = 1) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function cleanErrorField(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function isAttemptedState(value) {
  const normalized = marker(value);
  return normalized === DAILY_SCHEDULE_REQUEST_STATE.SUBMITTED_UNKNOWN
    || normalized === DAILY_SCHEDULE_REQUEST_STATE.COMPLETED
    || normalized === 'attempted'
    || normalized === 'request_started';
}

function isExplicitNotStarted(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.modelRequestAttempted === false || error.requestStarted === false) return true;
  return [error.requestState, error.generationState, error.reason, error.code]
    .some((value) => marker(value) === DAILY_SCHEDULE_REQUEST_STATE.REQUEST_NOT_STARTED);
}

function hasAttemptEvidence(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.modelRequestAttempted === true || error.requestStarted === true) return true;
  if (isAttemptedState(error.requestState) || isAttemptedState(error.generationState)) return true;
  if (Array.isArray(error.requestAttempts) && error.requestAttempts.length > 0) return true;
  if (Number(error.status || 0) > 0) return true;
  return COMPLETED_OUTPUT_FAILURE_REASONS.has(marker(error.reason));
}

/**
 * 只把明确的 request_not_started 识别为可自动重试。任何矛盾信号或未知错误都按
 * “请求可能已经提交”处理，不能用缺少 status/correlationId 反推请求未发生。
 */
export function classifyDailyScheduleFailure(error) {
  const reason = marker(error?.reason);
  if (COMPLETED_OUTPUT_FAILURE_REASONS.has(reason)) {
    return {
      requestState: DAILY_SCHEDULE_REQUEST_STATE.COMPLETED,
      failureKind: 'invalid-output',
      automaticRetryAllowed: false,
      certainty: 'explicit',
    };
  }
  if (hasAttemptEvidence(error)) {
    return {
      requestState: DAILY_SCHEDULE_REQUEST_STATE.SUBMITTED_UNKNOWN,
      failureKind: 'submitted-unknown',
      automaticRetryAllowed: false,
      certainty: 'explicit',
    };
  }
  if (isExplicitNotStarted(error)) {
    return {
      requestState: DAILY_SCHEDULE_REQUEST_STATE.REQUEST_NOT_STARTED,
      failureKind: 'preflight',
      automaticRetryAllowed: true,
      certainty: 'explicit',
    };
  }
  return {
    requestState: DAILY_SCHEDULE_REQUEST_STATE.SUBMITTED_UNKNOWN,
    failureKind: 'submitted-unknown',
    automaticRetryAllowed: false,
    certainty: 'conservative',
  };
}

function preflightDelayForAttempt(attemptCount) {
  const index = Math.max(0, positiveInteger(attemptCount) - 1);
  return DAILY_SCHEDULE_PREFLIGHT_RETRY_DELAYS_MS[
    Math.min(index, DAILY_SCHEDULE_PREFLIGHT_RETRY_DELAYS_MS.length - 1)
  ];
}

function cleanAttemptError(error) {
  return {
    reason: cleanErrorField(error?.reason, 120),
    statusCode: Number(error?.status || 0) || null,
    message: cleanErrorField(error?.message || error, 500),
    correlationId: cleanErrorField(error?.correlationId, 160),
  };
}

export function beginDailyScheduleAttempt(previous, { now } = {}) {
  const startedAt = finiteTimestamp(now);
  const previousCount = previous && typeof previous === 'object'
    ? Math.max(0, Math.floor(Number(previous.attemptCount || 0) || 0))
    : 0;
  return {
    attemptCount: previousCount + 1,
    status: DAILY_SCHEDULE_ATTEMPT_STATUS.EXECUTING,
    requestState: DAILY_SCHEDULE_REQUEST_STATE.SUBMITTED_UNKNOWN,
    failureKind: '',
    automaticRetryAllowed: false,
    lastAttemptAt: startedAt,
    nextEligibleAt: startedAt + DAILY_SCHEDULE_MANUAL_RETRY_COOLDOWN_MS,
    reason: '',
    statusCode: null,
    message: '',
    correlationId: '',
  };
}

export function settleDailyScheduleFailure(startedAttempt, error, { now } = {}) {
  const failedAt = finiteTimestamp(now, finiteTimestamp(startedAttempt?.lastAttemptAt));
  const attemptCount = positiveInteger(startedAttempt?.attemptCount);
  const classification = classifyDailyScheduleFailure(error);
  const exhausted = classification.automaticRetryAllowed
    && attemptCount >= DAILY_SCHEDULE_MAX_AUTOMATIC_ATTEMPTS_PER_DAY;
  const automaticRetryAllowed = classification.automaticRetryAllowed && !exhausted;
  const nextEligibleAt = automaticRetryAllowed
    ? failedAt + preflightDelayForAttempt(attemptCount)
    : failedAt + DAILY_SCHEDULE_MANUAL_RETRY_COOLDOWN_MS;
  return {
    attemptCount,
    status: exhausted
      ? DAILY_SCHEDULE_ATTEMPT_STATUS.EXHAUSTED
      : automaticRetryAllowed
        ? DAILY_SCHEDULE_ATTEMPT_STATUS.RETRY_COOLDOWN
        : DAILY_SCHEDULE_ATTEMPT_STATUS.NEEDS_USER_RETRY,
    requestState: classification.requestState,
    failureKind: classification.failureKind,
    automaticRetryAllowed,
    certainty: classification.certainty,
    lastAttemptAt: failedAt,
    nextEligibleAt,
    ...cleanAttemptError(error),
  };
}

function normalizeAttemptRecord(raw, { now } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const lastAttemptAt = finiteTimestamp(raw.lastAttemptAt || raw.failedAt, finiteTimestamp(now));
  const attemptCount = positiveInteger(raw.attemptCount);
  const requestStateMarker = marker(raw.requestState || raw.generationState);
  const requestState = Object.values(DAILY_SCHEDULE_REQUEST_STATE).includes(requestStateMarker)
    ? requestStateMarker
    : classifyDailyScheduleFailure(raw).requestState;
  const preflight = requestState === DAILY_SCHEDULE_REQUEST_STATE.REQUEST_NOT_STARTED;
  const exhausted = preflight && attemptCount >= DAILY_SCHEDULE_MAX_AUTOMATIC_ATTEMPTS_PER_DAY;
  const automaticRetryAllowed = preflight && !exhausted && raw.automaticRetryAllowed !== false;
  const nextEligibleAt = finiteTimestamp(raw.nextEligibleAt)
    || lastAttemptAt + (automaticRetryAllowed
      ? preflightDelayForAttempt(attemptCount)
      : DAILY_SCHEDULE_MANUAL_RETRY_COOLDOWN_MS);
  const defaultStatus = exhausted
    ? DAILY_SCHEDULE_ATTEMPT_STATUS.EXHAUSTED
    : automaticRetryAllowed
      ? DAILY_SCHEDULE_ATTEMPT_STATUS.RETRY_COOLDOWN
      : DAILY_SCHEDULE_ATTEMPT_STATUS.NEEDS_USER_RETRY;
  const rawStatus = marker(raw.status);
  const status = Object.values(DAILY_SCHEDULE_ATTEMPT_STATUS).includes(rawStatus)
    ? rawStatus
    : defaultStatus;
  return {
    attemptCount,
    status,
    requestState,
    failureKind: cleanErrorField(raw.failureKind, 80)
      || (preflight ? 'preflight' : 'submitted-unknown'),
    automaticRetryAllowed: status === DAILY_SCHEDULE_ATTEMPT_STATUS.RETRY_COOLDOWN
      && automaticRetryAllowed,
    certainty: cleanErrorField(raw.certainty, 40) || 'conservative',
    lastAttemptAt,
    nextEligibleAt,
    reason: cleanErrorField(raw.reason, 120),
    statusCode: Number(raw.statusCode || raw.status || 0) || null,
    message: cleanErrorField(raw.message, 500),
    correlationId: cleanErrorField(raw.correlationId, 160),
  };
}

export function isDailyScheduleAttemptEligible(record, { now } = {}) {
  if (!record) return true;
  const normalized = normalizeAttemptRecord(record, { now });
  if (!normalized) return true;
  return normalized.status === DAILY_SCHEDULE_ATTEMPT_STATUS.RETRY_COOLDOWN
    && normalized.requestState === DAILY_SCHEDULE_REQUEST_STATE.REQUEST_NOT_STARTED
    && normalized.automaticRetryAllowed === true
    && normalized.attemptCount < DAILY_SCHEDULE_MAX_AUTOMATIC_ATTEMPTS_PER_DAY
    && finiteTimestamp(now) >= normalized.nextEligibleAt;
}

export function normalizeDailyScheduleGenerationState(raw, { dateKey, now } = {}) {
  const normalizedDateKey = String(dateKey || '').trim();
  const source = raw && typeof raw === 'object' ? raw : null;
  if (!source || String(source.dateKey || '') !== normalizedDateKey) {
    return {
      version: DAILY_SCHEDULE_GEN_STATE_VERSION,
      dateKey: normalizedDateKey,
      doneCharacterIds: [],
      attemptsByCharacter: {},
    };
  }

  const doneCharacterIds = [...new Set((Array.isArray(source.doneCharacterIds)
    ? source.doneCharacterIds
    : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  const doneIds = new Set(doneCharacterIds);
  const attemptsByCharacter = {};
  const currentAttempts = source.attemptsByCharacter && typeof source.attemptsByCharacter === 'object'
    ? source.attemptsByCharacter
    : {};
  for (const [characterId, attempt] of Object.entries(currentAttempts)) {
    const id = String(characterId || '').trim();
    if (!id || doneIds.has(id)) continue;
    const normalized = normalizeAttemptRecord(attempt, { now });
    if (normalized) attemptsByCharacter[id] = normalized;
  }

  // v3 的 failedCharacters 不能在升级时直接清空；未知旧失败一律按可能已请求迁移。
  const legacyFailures = source.failedCharacters && typeof source.failedCharacters === 'object'
    ? source.failedCharacters
    : {};
  for (const [characterId, failure] of Object.entries(legacyFailures)) {
    const id = String(characterId || '').trim();
    if (!id || doneIds.has(id) || attemptsByCharacter[id]) continue;
    const failedAt = finiteTimestamp(failure?.failedAt, finiteTimestamp(now));
    const startedAttempt = {
      ...beginDailyScheduleAttempt(null, { now: failedAt }),
      attemptCount: positiveInteger(failure?.attemptCount),
    };
    attemptsByCharacter[id] = settleDailyScheduleFailure(startedAttempt, failure, { now: failedAt });
  }

  return {
    version: DAILY_SCHEDULE_GEN_STATE_VERSION,
    dateKey: normalizedDateKey,
    doneCharacterIds,
    attemptsByCharacter,
  };
}
