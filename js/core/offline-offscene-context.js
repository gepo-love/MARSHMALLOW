function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function aliasesForCharacter(character = {}) {
  return [...new Set([
    character.id,
    character.name,
    character.realName,
    character.customNickname,
    character.nickname,
    ...(Array.isArray(character.aliases) ? character.aliases : []),
  ].map(clean).filter((value) => value.length >= 2))];
}

function includesAlias(text = '', alias = '') {
  const source = String(text || '').toLocaleLowerCase();
  const needle = String(alias || '').toLocaleLowerCase();
  if (!source || !needle) return false;
  if (/^[a-z0-9_-]+$/i.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`, 'i').test(source);
  }
  return source.includes(needle);
}

/**
 * 只解决「需要读取人物卡」；返回的角色仍不在现场，不改变 attendance。
 */
export function resolveMentionedOffsceneCharacterIds({
  text = '',
  characters = [],
  activeCharacterIds = [],
  limit = 4,
} = {}) {
  const source = clean(text);
  if (!source) return [];
  const active = new Set((activeCharacterIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  return (Array.isArray(characters) ? characters : [])
    .filter((character) => character?.id && !active.has(String(character.id)))
    .map((character) => {
      const aliases = aliasesForCharacter(character)
        .filter((alias) => includesAlias(source, alias))
        .sort((left, right) => right.length - left.length);
      if (!aliases.length) return null;
      return {
        id: String(character.id),
        matchedAlias: aliases[0],
        index: source.toLocaleLowerCase().indexOf(aliases[0].toLocaleLowerCase()),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index || right.matchedAlias.length - left.matchedAlias.length)
    .slice(0, Math.max(1, Math.min(8, Number(limit) || 4)))
    .map((row) => row.id);
}

export function buildOfflineOffsceneQueryText(session = {}, directive = '') {
  const beats = (Array.isArray(session.beats) ? session.beats : [])
    .filter((beat) => ['opening', 'directive', 'narration'].includes(beat?.role))
    .slice(-4)
    .map((beat) => clean(beat.text))
    .filter(Boolean);
  return [
    clean(session.scene?.openingLine),
    clean(session.scene?.goal),
    ...beats,
    clean(directive),
  ].filter(Boolean).join('\n');
}
