/**
 * 角色手机社交身份目录。
 *
 * 这是纯函数层：把主角色、关系网 NPC、手机联系人归到同一 canonical actor，
 * 但名字只有在全目录唯一时才参与解析。稳定 id 永远优先于名字。
 */

function clean(value = '', max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function phoneSocialActorNameKey(value = '') {
  return clean(value, 80).toLowerCase().replace(/[\s_\-./]+/g, '');
}

export function isUsablePhoneActorDisplayName(value = '') {
  const name = clean(value, 80);
  if (!name || /^(?:npc_|lightnpc_|phone-contact:|phone-group:)/i.test(name)) return false;
  return !/^(?:联系人|对方|TA)$/i.test(name);
}

/**
 * 微博等社交生成器会创建 npc_<base36 hash> 身份。旧链路偶尔会剥掉 npc_
 * 后把哈希尾巴误当联系人姓名，例如 1etwupk。这里只识别“同时含字母和数字”的
 * 6～10 位纯 ASCII 串，避免把正常英文名或纯数字备注误判成内部身份。
 */
export function isLikelyGeneratedSocialActorCode(value = '') {
  const raw = clean(value, 80).replace(/^npc_/i, '');
  return /^(?=.{6,10}$)(?=.*[a-z])(?=.*\d)[a-z0-9]+$/i.test(raw);
}

export function phoneContactCanonicalActorId(contact = {}) {
  return clean(
    contact?.linkedCharacterId
    || contact?.linkedActorId
    || contact?.canonicalActorId
    || contact?.id,
  );
}

function characterRows(characters) {
  if (characters instanceof Map) return [...characters.values()];
  if (Array.isArray(characters)) return characters;
  return characters && typeof characters === 'object' ? Object.values(characters) : [];
}

function actorAliases(row = {}) {
  return [
    row.name,
    row.realName,
    row.customNickname,
    row.nickname,
    ...(Array.isArray(row.aliases) ? row.aliases : []),
  ].map((value) => clean(value, 80)).filter(Boolean);
}

/** 从角色、关系网 NPC、联系人或历史别名中挑出首个可读姓名。 */
export function resolvePhoneSocialActorDisplayName(...sources) {
  for (const source of sources) {
    const values = source && typeof source === 'object'
      ? [
        source.realName,
        source.name,
        source.displayName,
        source.remarkName,
        source.nickname,
        source.customNickname,
        ...(Array.isArray(source.aliases) ? source.aliases : []),
      ]
      : [source];
    const name = values.map((value) => clean(value, 80)).find(isUsablePhoneActorDisplayName);
    if (name) return name;
  }
  return '';
}

function ownerNetworkActorIds(network = null, ownerId = '') {
  const owner = clean(ownerId, 160);
  const ids = new Set();
  if (!owner) return ids;
  for (const circle of network?.circles || []) {
    const members = asArray(circle?.memberIds).map((id) => clean(id)).filter(Boolean);
    const edgeHit = asArray(circle?.edges).some((edge) => (
      clean(edge?.a) === owner || clean(edge?.b) === owner
    ));
    if (!members.includes(owner) && !edgeHit) continue;
    members.forEach((id) => {
      if (id && id !== owner && id !== 'user') ids.add(id);
    });
    for (const edge of circle?.edges || []) {
      const a = clean(edge?.a);
      const b = clean(edge?.b);
      if (a === owner && b && b !== 'user') ids.add(b);
      if (b === owner && a && a !== 'user') ids.add(a);
    }
  }
  return ids;
}

/**
 * 返回 { actors, byId, resolve, candidates }。
 * resolve(ref) 先查稳定 id；仅当名字无歧义时才按名字返回。
 */
export function createPhoneSocialActorDirectory({
  ownerId = '',
  characters = [],
  relationshipNetwork = null,
  contacts = [],
  removedLinkedCharacterIds = [],
  removedLinkedActorIds = [],
  canUseCharacter = null,
} = {}) {
  const owner = clean(ownerId, 160);
  const removed = new Set([
    ...asArray(removedLinkedCharacterIds),
    ...asArray(removedLinkedActorIds),
  ].map((id) => clean(id, 240)).filter(Boolean));
  const relatedIds = ownerNetworkActorIds(relationshipNetwork, owner);
  const characterById = new Map(characterRows(characters)
    .map((row) => [clean(row?.id, 160), row])
    .filter(([id]) => id));
  const npcById = new Map(asArray(relationshipNetwork?.npcs)
    .map((row) => [clean(row?.id), row])
    .filter(([id]) => id));
  const contactRows = asArray(contacts).filter((row) => row?.id);

  const actors = new Map();
  const stableAliases = new Map();
  const nameCandidates = new Map();

  const ensureActor = (id, source, row, contact = null) => {
    const canonicalId = clean(id);
    if (!canonicalId || canonicalId === owner || canonicalId === 'user') return null;
    const character = characterById.get(canonicalId) || null;
    if (removed.has(canonicalId)) return null;
    if (character && typeof canUseCharacter === 'function' && canUseCharacter(character) === false) return null;
    const previous = actors.get(canonicalId);
    const npc = npcById.get(canonicalId) || null;
    const names = [...new Set([
      ...actorAliases(character || {}),
      ...actorAliases(npc || {}),
      ...actorAliases(contact || {}),
      ...actorAliases(row || {}),
    ])].filter(isUsablePhoneActorDisplayName);
    const actor = {
      ...(previous || {}),
      id: canonicalId,
      canonicalId,
      kind: character ? 'character' : (npc ? 'relationship-npc' : 'phone-contact'),
      name: names[0] || '',
      avatar: clean(character?.avatar || character?.avatarUrl || npc?.avatar || contact?.avatar || '', 900000),
      character,
      npc,
      contact: contact || previous?.contact || null,
      aliases: names,
      relatedToOwner: relatedIds.has(canonicalId) || !!contact,
      source,
    };
    actors.set(canonicalId, actor);
    stableAliases.set(canonicalId, canonicalId);
    return actor;
  };

  for (const row of characterById.values()) ensureActor(row.id, 'character', row);
  for (const row of npcById.values()) ensureActor(row.id, 'relationship-npc', row);
  for (const contact of contactRows) {
    const linkedCharacterId = clean(contact.linkedCharacterId, 160);
    if (linkedCharacterId && removed.has(linkedCharacterId)) continue;
    const canonicalId = phoneContactCanonicalActorId(contact);
    const actor = ensureActor(canonicalId, 'phone-contact', contact, contact);
    if (!actor) continue;
    stableAliases.set(clean(contact.id), actor.id);
    if (linkedCharacterId) stableAliases.set(linkedCharacterId, actor.id);
    const linkedActorId = clean(contact.linkedActorId);
    if (linkedActorId) stableAliases.set(linkedActorId, actor.id);
  }

  for (const actor of actors.values()) {
    for (const alias of actor.aliases || []) {
      const key = phoneSocialActorNameKey(alias);
      if (!key) continue;
      if (!nameCandidates.has(key)) nameCandidates.set(key, new Set());
      nameCandidates.get(key).add(actor.id);
    }
  }
  const uniqueNameAliases = new Map();
  for (const [key, ids] of nameCandidates) {
    if (ids.size === 1) uniqueNameAliases.set(key, [...ids][0]);
  }

  const resolve = (reference = '', options = {}) => {
    const ref = clean(reference);
    if (ref && stableAliases.has(ref)) return actors.get(stableAliases.get(ref)) || null;
    const name = clean(options.name || reference, 80);
    const byName = uniqueNameAliases.get(phoneSocialActorNameKey(name));
    return byName ? actors.get(byName) || null : null;
  };

  const candidates = [...actors.values()].filter((actor) => (
    actor.relatedToOwner
    && actor.id !== owner
    && !(actor.kind === 'character' && removed.has(actor.id))
  ));

  return {
    actors: [...actors.values()],
    byId: actors,
    stableAliases,
    ambiguousNameKeys: new Set(
      [...nameCandidates].filter(([, ids]) => ids.size > 1).map(([key]) => key),
    ),
    resolve,
    candidates,
  };
}

/**
 * “新的联系人 → 从通讯录选择”是用户主动授权，不沿用自动社交的认识门禁。
 * 返回主通讯录里的全部角色（除手机主人）；已移除角色也保留在候选中，选择后由
 * upsertPhoneContact 清除移除标记。自动消息、群聊等链路仍使用上面的 candidates。
 */
export function createPhoneAddressBookActorDirectory({
  ownerId = '',
  characters = [],
  relationshipNetwork = null,
  contacts = [],
} = {}) {
  const directory = createPhoneSocialActorDirectory({
    ownerId,
    characters,
    relationshipNetwork,
    contacts,
  });
  return {
    ...directory,
    candidates: directory.actors.filter((actor) => actor.kind === 'character'),
  };
}

/** 懒创建手机联系人时使用；关系网 NPC 保留 actor id，不冒充主角色。 */
export function phoneSocialActorToContactInput(actor = {}) {
  const id = clean(actor?.canonicalId || actor?.id);
  const name = resolvePhoneSocialActorDisplayName(actor);
  if (!id || !name) return null;
  return {
    name,
    avatar: clean(actor.avatar || '', 900000),
    category: 'friend',
    ...(actor.kind === 'character'
      ? { linkedCharacterId: id }
      : (actor.kind === 'relationship-npc' ? { linkedActorId: id } : {})),
  };
}
