export const USER_ACTOR_REFERENCE = 'U';

function cleanId(value = '') {
  return String(value || '').trim();
}

export function normalizeActorReference(value = '') {
  const raw = cleanId(value)
    .replace(/^[\s@＠]+/, '')
    .replace(/[Ｕｕ]/g, 'U')
    .replace(/[Ｃｃ]/g, 'C')
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xFF10))
    .toUpperCase();
  if (/^U(?:$|[·|｜:：（(【\[])/.test(raw)) return USER_ACTOR_REFERENCE;
  const match = raw.match(/^C[\s_-]*0*(\d{1,3})(?:$|[·|｜:：\s（(【\[])/);
  if (!match) return '';
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? `C${index}` : '';
}

export function buildChatActorReferenceTable(chat = null, options = {}) {
  const participantIds = [...new Set([
    ...(Array.isArray(chat?.participants) ? chat.participants : []),
    ...(Array.isArray(options.actorIds) ? options.actorIds : []),
  ].map(cleanId).filter((id) => id && id !== 'system'))];
  const characterIds = participantIds.filter((id) => id !== 'user');
  const idToRef = new Map();
  const refToId = new Map([[USER_ACTOR_REFERENCE, 'user']]);
  idToRef.set('user', USER_ACTOR_REFERENCE);
  characterIds.forEach((id, index) => {
    const ref = `C${index + 1}`;
    idToRef.set(id, ref);
    refToId.set(ref, id);
  });
  return {
    participantIds,
    characterIds,
    rows: [
      ...(participantIds.includes('user') || options.includeUser === true
        ? [{ ref: USER_ACTOR_REFERENCE, id: 'user', kind: 'user' }]
        : []),
      ...characterIds.map((id) => ({
        ref: idToRef.get(id),
        id,
        kind: 'character',
      })),
    ],
    idToRef,
    refToId,
    refFor(actorId = '') {
      return idToRef.get(cleanId(actorId)) || '';
    },
    idFor(reference = '') {
      const normalized = normalizeActorReference(reference);
      return normalized ? (refToId.get(normalized) || '') : '';
    },
  };
}

export function resolveChatActorReference(chat = null, actorId = '', options = {}) {
  const id = cleanId(actorId);
  if (!id) return '';
  return buildChatActorReferenceTable(chat, {
    ...options,
    actorIds: [
      ...(Array.isArray(options.actorIds) ? options.actorIds : []),
      id,
    ],
  }).refFor(id);
}
