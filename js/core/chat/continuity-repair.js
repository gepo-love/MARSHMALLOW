import { get, put } from '../db.js';

const KEY = (userId, chatId) => (
  `chatContinuityRepair:v1:${encodeURIComponent(clean(userId, 120))}:${encodeURIComponent(clean(chatId, 120))}`
);

const INCIDENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RESOLVED_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_INCIDENTS = 20;
const MAX_CONTEXT_INCIDENTS = 3;
const mutationQueues = new Map();

const NARRATIVE_KINDS = new Set([
  'delayed_reply_missed',
  'state_schedule_conflict',
]);

const NON_NARRATIVE_REASON_RE = /(?:user-abort|user-cancel|composer-active|foreground-streaming|blocked-by-user|all-muted|guidance-mode|proactive-disabled|real-person-disabled|mute-hours|hard-offline|active-offline-session|missing-api|api-key|unauthori[sz]ed|forbidden|payment|required|insufficient|余额|鉴权|密钥|配置)/iu;

function clean(value = '', max = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}
function timestamp(value, fallback = 0) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function hashText(value = '') {
  const text = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function incidentId(input = {}) {
  const seed = [
    clean(input.userId, 120),
    clean(input.chatId, 120),
    clean(input.characterId, 120),
    clean(input.kind, 60),
    clean(input.sourceId, 160) || Math.floor(timestamp(input.occurredAt, Date.now()) / 60_000),
  ].join('|');
  return `continuity_${hashText(seed)}`;
}

function normalizeIncident(input = {}) {
  const occurredAt = timestamp(input.occurredAt, Date.now());
  const status = input.status === 'resolved' || input.status === 'dismissed'
    ? input.status
    : 'pending';
  return {
    id: clean(input.id, 120) || incidentId({ ...input, occurredAt }),
    kind: clean(input.kind, 60),
    userId: clean(input.userId, 120),
    chatId: clean(input.chatId, 120),
    characterId: clean(input.characterId, 120),
    sourceId: clean(input.sourceId, 160),
    reason: clean(input.reason, 80),
    expectedAction: clean(input.expectedAction, 240),
    observedFact: clean(input.observedFact, 240),
    occurredAt,
    updatedAt: timestamp(input.updatedAt, occurredAt),
    status,
    resolvedAt: timestamp(input.resolvedAt),
    resolutionRoundId: clean(input.resolutionRoundId, 120),
    resolutionMessageIds: (Array.isArray(input.resolutionMessageIds) ? input.resolutionMessageIds : [])
      .map((id) => clean(id, 120))
      .filter(Boolean)
      .slice(0, 12),
  };
}

function pruneIncidents(incidents = [], now = Date.now()) {
  return (Array.isArray(incidents) ? incidents : [])
    .map(normalizeIncident)
    .filter((incident) => {
      const age = now - Number(incident.updatedAt || incident.occurredAt || 0);
      return incident.status === 'pending'
        ? age <= INCIDENT_RETENTION_MS
        : age <= RESOLVED_RETENTION_MS;
    })
    .sort((left, right) => Number(right.occurredAt || 0) - Number(left.occurredAt || 0))
    .slice(0, MAX_INCIDENTS);
}

function withMutation(userId, chatId, task) {
  const key = KEY(userId, chatId);
  const previous = mutationQueues.get(key) || Promise.resolve();
  const queued = previous.catch(() => {}).then(task);
  mutationQueues.set(key, queued);
  return queued.finally(() => {
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  });
}

async function readIncidents(userId, chatId, now = Date.now()) {
  const row = await get(KEY(userId, chatId)).catch(() => null);
  return pruneIncidents(row?.value?.incidents, now);
}

async function writeIncidents(userId, chatId, incidents = []) {
  const value = {
    version: 1,
    updatedAt: Date.now(),
    incidents: pruneIncidents(incidents),
  };
  await put({ key: KEY(userId, chatId), value });
  return value.incidents;
}

export function shouldRecordContinuityIncident(input = {}) {
  const kind = clean(input.kind, 60);
  const reason = clean(input.reason, 120);
  if (!NARRATIVE_KINDS.has(kind)) return false;
  if (input.aborted === true || input.cancelled === true) return false;
  if (NON_NARRATIVE_REASON_RE.test(reason)) return false;
  const httpStatus = Number(input.httpStatus || input.statusCode || 0) || 0;
  if ([400, 401, 402, 403, 404].includes(httpStatus)) return false;
  return true;
}

export async function recordChatContinuityIncident(input = {}) {
  const userId = clean(input.userId, 120);
  const chatId = clean(input.chatId, 120);
  const characterId = clean(input.characterId, 120);
  if (!userId || !chatId || !characterId || !shouldRecordContinuityIncident(input)) return null;
  return withMutation(userId, chatId, async () => {
    const incidents = await readIncidents(userId, chatId);
    const next = normalizeIncident({
      ...input,
      userId,
      chatId,
      characterId,
      status: 'pending',
      updatedAt: Date.now(),
    });
    const index = incidents.findIndex((incident) => incident.id === next.id);
    if (index >= 0) incidents[index] = { ...incidents[index], ...next };
    else incidents.unshift(next);
    await writeIncidents(userId, chatId, incidents);
    return next;
  });
}

export async function listPendingChatContinuityIncidents(userId, chatId, options = {}) {
  const actorIds = new Set((Array.isArray(options.characterIds) ? options.characterIds : [])
    .map((id) => clean(id, 120))
    .filter(Boolean));
  const incidents = await readIncidents(userId, chatId, timestamp(options.now, Date.now()));
  return incidents
    .filter((incident) => incident.status === 'pending')
    // 旧版本曾把 API 空回、截流和本地保存失败写进角色连续性账本。
    // 这类技术故障不是角色亲历事实，升级后也不能再进入提示词。
    .filter((incident) => shouldRecordContinuityIncident(incident))
    .filter((incident) => !actorIds.size || actorIds.has(incident.characterId))
    .slice(0, Math.max(1, Number(options.limit || MAX_CONTEXT_INCIDENTS)));
}

function incidentPromptLine(incident, characterNames = {}) {
  const actor = clean(characterNames?.[incident.characterId], 40) || incident.characterId || '当前角色';
  const expected = incident.expectedAction ? `原本应当：${incident.expectedAction}。` : '';
  const observed = incident.observedFact ? `用户已经看到的事实：${incident.observedFact}。` : '';
  const detail = {
    delayed_reply_missed: '之前明确约好稍后回来，但没有按时出现。优先直接接回当前话题；只有用户追问或这段等待明显影响语义时，才用符合已知日程与人物状态的一句话带过，不要求固定道歉。',
    state_schedule_conflict: '之前公开状态与实际活动没有同步。现在承认状态忘记改、临时改做别的或后来睡着都可以，但必须选择与现有事实相容的一种，不能改写用户已经看见的状态。',
  }[incident.kind] || '之前出现了一个用户可感知的连续性断点；现在用最小、自然的方式把它接回。';
  return `- ${actor}：${detail}${expected}${observed}`;
}

export function buildChatContinuityRepairPrompt(incidents = [], options = {}) {
  const rows = (Array.isArray(incidents) ? incidents : [])
    .filter((incident) => shouldRecordContinuityIncident(incident))
    .map((incident) => incidentPromptLine(normalizeIncident(incident), options.characterNames || {}))
    .filter(Boolean);
  if (!rows.length) return '';
  return [
    '【连续性自愈 · 已经发生的断点】',
    '以下断点已经被用户实际经历，不能删掉、倒带或假装从未发生。它们不是要求统一编造“信号不好”，而是要求你按人物、日程和现有事实给出最小且可信的承接。',
    ...rows,
    '这不是强制道歉任务。本轮优先回应用户眼前的新消息；用户没有追问且不影响语义时可以完全不提。禁止把 API 空回、生成截断、发送失败或保存失败解释成角色断网、没信号或设备故障；禁止提 API、模型、系统、任务、定时器、上下文或错误码，也禁止为了圆场虚构停电、事故或疾病。',
  ].join('\n');
}

export async function prepareChatContinuityRepair(input = {}) {
  const incidents = await listPendingChatContinuityIncidents(input.userId, input.chatId, {
    characterIds: input.characterIds,
    now: input.now,
  });
  return {
    incidents,
    incidentIds: incidents.map((incident) => incident.id),
    block: buildChatContinuityRepairPrompt(incidents, {
      characterNames: input.characterNames || {},
    }),
  };
}

export async function resolveChatContinuityIncidents(userId, chatId, incidentIds = [], options = {}) {
  const ids = new Set((Array.isArray(incidentIds) ? incidentIds : []).map((id) => clean(id, 120)).filter(Boolean));
  if (!clean(userId, 120) || !clean(chatId, 120) || !ids.size) return [];
  return withMutation(userId, chatId, async () => {
    const incidents = await readIncidents(userId, chatId);
    const resolvedAt = timestamp(options.resolvedAt, Date.now());
    const next = incidents.map((incident) => ids.has(incident.id)
      ? normalizeIncident({
        ...incident,
        status: 'resolved',
        resolvedAt,
        updatedAt: resolvedAt,
        resolutionRoundId: options.aiRoundId,
        resolutionMessageIds: options.messageIds,
      })
      : incident);
    await writeIncidents(userId, chatId, next);
    return next.filter((incident) => ids.has(incident.id));
  });
}
