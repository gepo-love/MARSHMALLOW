/**
 * Prompt 注入的知情范围门禁。
 *
 * parentChatId / linkedParentChatIds 只描述导航关系，绝不能作为知情证据。
 * 普通会话的参与者默认知道该窗公开内容；knownBy 可补充明确知情者；
 * explicitShared 是用户主动互通，保留为显式越权入口。
 */

function cleanId(value = '') {
  return String(value || '').trim();
}

export function normalizeAudienceCharacterIds(characterIds = []) {
  return [...new Set((Array.isArray(characterIds) ? characterIds : [])
    .map(cleanId)
    .filter((id) => id && id !== 'user' && id !== 'system'))];
}

export function knownByCharacterIds(value = null) {
  const knownBy = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return new Set(Object.entries(knownBy)
    .filter(([, level]) => level === true
      || ['heard', 'known', 'involved', 'shared'].includes(cleanId(level)))
    .map(([id]) => cleanId(id))
    .filter((id) => id && id !== 'user' && id !== 'system'));
}

export function collectExplicitKnownBy(record = null) {
  const row = record && typeof record === 'object' ? record : {};
  return {
    ...(row.metadata?.knownBy && typeof row.metadata.knownBy === 'object' ? row.metadata.knownBy : {}),
    ...(row.metadata?.explicitKnownBy && typeof row.metadata.explicitKnownBy === 'object'
      ? row.metadata.explicitKnownBy
      : {}),
    ...(row.knownBy && typeof row.knownBy === 'object' ? row.knownBy : {}),
  };
}

export function sourceChatKnownCharacterIds(sourceChat = null, record = null) {
  const ids = new Set((Array.isArray(sourceChat?.participants) ? sourceChat.participants : [])
    .map(cleanId)
    .filter((id) => id && id !== 'user' && id !== 'system'));
  for (const id of knownByCharacterIds(collectExplicitKnownBy(record || sourceChat))) ids.add(id);
  for (const id of [
    ...(Array.isArray(sourceChat?.metadata?.knownByActorIds) ? sourceChat.metadata.knownByActorIds : []),
    ...(Array.isArray(record?.knownByActorIds) ? record.knownByActorIds : []),
    ...(Array.isArray(record?.metadata?.knownByActorIds) ? record.metadata.knownByActorIds : []),
    ...(Array.isArray(record?.participantSnapshot?.actorIds) ? record.participantSnapshot.actorIds : []),
  ].map(cleanId).filter((id) => id && id !== 'user' && id !== 'system')) ids.add(id);
  return ids;
}

/**
 * 多角色共用一个 prompt 时默认 requireAll：只有全体当前角色共同已知才注入。
 * 单角色 prompt 则保留该角色亲历过的群公屏、私聊与侧窗内容。
 */
export function audienceCanReceiveSource({
  audienceCharacterIds = [],
  sourceChat = null,
  record = null,
  currentChatId = '',
  explicitShared = false,
  requireAll = true,
} = {}) {
  const audience = normalizeAudienceCharacterIds(audienceCharacterIds);
  if (!audience.length) return false;
  if (explicitShared) return true;
  const sourceId = cleanId(sourceChat?.id || record?.chatId || record?.sourceChatId);
  if (sourceId && sourceId === cleanId(currentChatId)) return true;
  const known = sourceChatKnownCharacterIds(sourceChat, record);
  return requireAll
    ? audience.every((id) => known.has(id))
    : audience.some((id) => known.has(id));
}

export function archiveRosterCharacterIds(archive = null) {
  const row = archive && typeof archive === 'object' ? archive : {};
  return new Set([
    cleanId(row.characterId),
    ...(Array.isArray(row.participantIds) ? row.participantIds.map(cleanId) : []),
    ...(Array.isArray(row.allEverParticipantIds) ? row.allEverParticipantIds.map(cleanId) : []),
    ...(Array.isArray(row.attendance?.members)
      ? row.attendance.members.map((member) => cleanId(member?.characterId || member?.id))
      : []),
    // 旧档案没有 participantSnapshot 时，按角色保存的独立记忆仍是可靠的亲历证据；
    // 不能用全场 summary 猜 roster，但可以让这名角色读取自己 coversAll 的卷宗。
    ...(Array.isArray(row.characterMemories)
      ? row.characterMemories.map((entry) => cleanId(entry?.characterId))
      : []),
  ].filter(Boolean));
}

export function selectArchiveAudienceScope(archive = null, audienceCharacterIds = []) {
  const audience = normalizeAudienceCharacterIds(audienceCharacterIds);
  const roster = archiveRosterCharacterIds(archive);
  const memories = Array.isArray(archive?.characterMemories) ? archive.characterMemories : [];
  const owned = audience.map((id) => memories.find((entry) =>
    cleanId(entry?.characterId) === id && cleanId(entry?.content))).filter(Boolean);
  const allInRoster = audience.length > 0 && audience.every((id) => roster.has(id));
  const allHaveMemory = audience.length > 0 && owned.length === audience.length;
  const allCoverAll = allHaveMemory && owned.every((entry) => entry.coversAll === true);
  return {
    audience,
    owned,
    allInRoster,
    allHaveMemory,
    allCoverAll,
    canUseSharedSummary: allInRoster && allCoverAll,
    timeAnchorOnly: !allHaveMemory || (audience.length > 1 && !allCoverAll),
  };
}
