import {
  effectiveOfflineCheckpointSummaries,
} from '../offline-checkpoint-memory.js';

const DEFAULT_RECENT_BEATS = 8;
const DEFAULT_BUDGET_CHARS = 5200;

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clipKeepTail(value = '', limit = 900) {
  const text = clean(value);
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.35);
  return `${text.slice(0, head)}…（中段略）…${text.slice(-(limit - head))}`;
}

function attendanceMemberEverActive(member = {}) {
  if (member.status === 'active' || member.joinedAt || member.joinedBeatId) return true;
  return (Array.isArray(member.history) ? member.history : []).some((entry) =>
    entry?.status === 'active' || entry?.joinedAt || entry?.joinedBeatId);
}

export function activeOfflineSessionCharacterIds(session = {}) {
  return new Set([
    ...(Array.isArray(session.participants) ? session.participants : []),
    ...(Array.isArray(session.originChat?.participantIds) ? session.originChat.participantIds : []),
    ...(Array.isArray(session.attendance?.members)
      ? session.attendance.members
        .filter(attendanceMemberEverActive)
        .map((member) => member?.characterId)
      : []),
  ].map((id) => String(id || '').trim()).filter((id) => id && id !== 'user'));
}

export function activeOfflineSessionTouchesCharacters(session = {}, characterIds = []) {
  const involved = activeOfflineSessionCharacterIds(session);
  return (Array.isArray(characterIds) ? characterIds : [])
    .map((id) => String(id || '').trim())
    .some((id) => id && involved.has(id));
}

export function pickRelatedActiveOfflineSession(
  sessions = [],
  { currentChatId = '', characterIds = [] } = {},
) {
  const currentId = String(currentChatId || '').trim();
  return (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session?.status === 'active')
    .filter((session) => String(session?.chatId || '').trim() !== currentId)
    .filter((session) => activeOfflineSessionTouchesCharacters(session, characterIds))
    .sort((a, b) => Number(b?.updatedAt || b?.createdAt || 0) - Number(a?.updatedAt || a?.createdAt || 0))[0]
    || null;
}

function visibleBeatIndexesForCharacter(beats = [], characterId = '') {
  const cid = String(characterId || '').trim();
  const events = beats
    .map((beat, index) => ({ beat, index }))
    .filter(({ beat }) => String(beat?.attendanceEvent?.characterId || '') === cid);
  if (!events.length) return new Set(beats.map((_beat, index) => index));

  const visible = new Set();
  const firstStatus = String(events[0]?.beat?.attendanceEvent?.status || '');
  let start = firstStatus === 'left' ? 0 : null;
  for (const { beat, index } of events) {
    const status = String(beat.attendanceEvent?.status || '');
    if (status === 'active') {
      if (start == null) start = index;
    } else if (status === 'left' && start != null) {
      for (let cursor = start; cursor <= index; cursor += 1) visible.add(cursor);
      start = null;
    }
  }
  if (start != null) {
    for (let cursor = start; cursor < beats.length; cursor += 1) visible.add(cursor);
  }
  return visible;
}

function visibleBeatsForTargets(beats = [], targetIds = []) {
  if (!targetIds.length) return beats;
  const visibleIndexes = new Set();
  for (const id of targetIds) {
    for (const index of visibleBeatIndexesForCharacter(beats, id)) visibleIndexes.add(index);
  }
  return beats.filter((_beat, index) => visibleIndexes.has(index));
}

export function activeOfflineTargetsStillAtScene(session = {}, targetIds = []) {
  const members = Array.isArray(session.attendance?.members) ? session.attendance.members : [];
  if (!members.length) return true;
  const wanted = new Set(targetIds);
  return members.some((member) =>
    wanted.has(String(member?.characterId || '').trim()) && member?.status === 'active');
}

function beatLabel(beat = {}) {
  if (beat.role === 'opening') return '本场开场';
  if (beat.role === 'directive') return '用户方向';
  if (beat.role === 'interlude') return '线上插曲';
  if (beat.attendanceEvent) return '现场人员变化';
  return '线下进展';
}

/**
 * 让线上请求看见尚未收纳的线下现场。这里只提供只读快照，不把线下旁白
 * 复制进聊天消息表；收纳完成后 session 被清除，长期承接自动交给档案与时间轴。
 */
export function buildActiveOfflineContinuityContext({
  session = null,
  characterIds = [],
  recentBeatLimit = DEFAULT_RECENT_BEATS,
  budgetChars = DEFAULT_BUDGET_CHARS,
} = {}) {
  if (!session || session.status !== 'active') return '';
  const targets = new Set(
    (Array.isArray(characterIds) ? characterIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const involved = activeOfflineSessionCharacterIds(session);
  if (targets.size && ![...targets].some((id) => involved.has(id))) return '';

  const allBeats = (Array.isArray(session.beats) ? session.beats : [])
    .filter((beat) => beat && ['opening', 'directive', 'narration', 'interlude'].includes(beat.role));
  const targetIds = [...targets].filter((id) => involved.has(id));
  const beats = visibleBeatsForTargets(allBeats, targetIds);
  const narrationCount = beats.filter((beat) => beat.role === 'narration').length;
  if (!beats.length && !narrationCount) return '';

  const cap = Math.max(2, Math.min(20, Number(recentBeatLimit) || DEFAULT_RECENT_BEATS));
  const maxChars = Math.max(1600, Math.min(12000, Number(budgetChars) || DEFAULT_BUDGET_CHARS));
  const recent = beats.slice(-cap);
  const recentLines = [];
  let used = 0;
  for (const beat of recent) {
    const text = clipKeepTail(beat.text, 900);
    if (!text) continue;
    const line = `- ${beatLabel(beat)}：${text}`;
    if (used + line.length > maxChars && recentLines.length >= 2) continue;
    recentLines.push(line);
    used += line.length;
  }

  const targetCoversEveryone = !targetIds.length
    || [...involved].every((id) => targets.has(id));
  const checkpoints = targetCoversEveryone
    ? effectiveOfflineCheckpointSummaries(
      session.checkpointSummaries,
      session.checkpointRollup,
    )
    : [];
  const latestCheckpoint = checkpoints
    .filter((row) => clean(row?.text))
    .sort((a, b) => Number(b.uptoBeatIndex || 0) - Number(a.uptoBeatIndex || 0))[0];
  const checkpointLine = latestCheckpoint && narrationCount > recent
    .filter((beat) => beat.role === 'narration').length
    ? `- 更早进展小结：${clipKeepTail(
      latestCheckpoint.text,
      Math.max(400, Math.min(1600, maxChars - used)),
    )}`
    : '';

  const scene = session.scene || {};
  const sceneLine = [
    scene.place ? `地点：${clean(scene.place)}` : '',
    scene.goal ? `正在做：${clean(scene.goal)}` : '',
  ].filter(Boolean).join('；');
  const stillAtScene = activeOfflineTargetsStillAtScene(session, targetIds);
  return [
    stillAtScene
      ? '【跨模式现场快照 · 线下仍在进行，尚未收纳】'
      : '【跨模式亲历快照 · 这场线下尚未收纳，当前角色已离场】',
    stillAtScene
      ? '这是角色正在亲历的当前事实，不是旧回忆。线上回复必须保持对现场、关系变化、物品和未完动作的认知；不要假装这场线下没有发生，也不要把现场重新开演。'
      : '以下只包含当前角色亲历到离场为止的事实。线上回复必须承接这些经历和离场原因；角色不知道自己离场后现场又发生了什么，不要假装仍在现场，也不要退回刚见面的时刻。',
    sceneLine ? `- ${stillAtScene ? '当前现场' : '离场前所在场景'}：${sceneLine}` : '',
    checkpointLine,
    ...recentLines,
    stillAtScene
      ? '线上聊天只是从当前现场临时打开的一条沟通通道。除非用户明确结束或收纳，本场线下仍处于进行中。'
      : '这场群线下仍可能由其他在场者继续，但当前角色的亲历已经停在离场节点；请从离场后的线上时间点自然接话。',
  ].filter(Boolean).join('\n');
}
