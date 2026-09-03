export function normalizeRoundParticipantIds(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && id !== 'user' && id !== 'system' && id !== 'unknown'))];
}

export function isExplicitRelationshipObserverGroup(chat) {
  return !!(
    chat?.type === 'group'
    && !(chat.participants || []).includes('user')
    && chat.groupSettings?.isObserverMode === true
    && (
      String(chat.metadata?.relationshipGroupId || '').trim()
      || chat.metadata?.groupOrigin === 'relationship-network'
    )
  );
}

/**
 * Decide whether a backstage event may create/reuse a group.
 * Existing complete rosters may accept a one-speaker continuation; a new roster may not.
 */
export function decideBackstageRoundGate({
  participantIds = [],
  existingChat = null,
  explicitObserverChat = null,
} = {}) {
  const ids = normalizeRoundParticipantIds(participantIds);
  const existingIds = normalizeRoundParticipantIds(existingChat?.participants);

  if (explicitObserverChat && isExplicitRelationshipObserverGroup(explicitObserverChat)) {
    return {
      allowed: true,
      route: 'backstage',
      chat: explicitObserverChat,
      participantIds: normalizeRoundParticipantIds(explicitObserverChat.participants),
      code: 'explicit_observer_group_reused',
    };
  }
  const continuesExistingRoster = ids.length >= 1
    && existingIds.length >= 3
    && ids.every((id) => existingIds.includes(id));
  if (continuesExistingRoster) {
    return {
      allowed: true,
      route: 'backstage',
      chat: existingChat,
      participantIds: existingIds,
      code: ids.length === 1
        ? 'single_speaker_existing_roster_reused'
        : 'partial_speakers_existing_roster_reused',
    };
  }
  if (ids.length === 2) {
    return {
      allowed: true,
      route: 'peer_private',
      participantIds: ids,
      code: 'two_actor_backstage_to_peer_private',
    };
  }
  if (ids.length >= 3) {
    return {
      allowed: true,
      route: 'backstage',
      participantIds: ids,
      code: existingChat ? 'multi_actor_backstage_reused' : 'multi_actor_backstage_created',
    };
  }
  return {
    allowed: false,
    route: 'drop',
    participantIds: ids,
    code: ids.length ? 'single_speaker_without_complete_roster' : 'backstage_roster_missing',
  };
}

/**
 * Persistence-level gate: two-person backstage output is recoverable as a
 * peer-private chat, while genuinely new multi-person rooms still require an
 * explicit roster. Keeping this decision here prevents the persistence layer
 * from rejecting a recoverable two-person event before routing it.
 */
export function decideBackstagePersistenceGate({
  participantIds = [],
  existingChat = null,
  explicitObserverChat = null,
  explicitMemberIds = [],
} = {}) {
  const gate = decideBackstageRoundGate({
    participantIds,
    existingChat,
    explicitObserverChat,
  });
  if (!gate.allowed || gate.route === 'peer_private') return gate;

  const reusableChat = gate.chat || existingChat;
  const members = normalizeRoundParticipantIds(explicitMemberIds);
  if (!reusableChat && members.length < 3) {
    return {
      allowed: false,
      route: 'drop',
      participantIds: gate.participantIds,
      code: 'backstage_create_requires_explicit_members',
    };
  }
  return gate;
}
