import {
  createAliasPublicSnapshot,
  normalizeAccountIdentityMap,
  parsePrincipalKey,
  principalKey,
} from './alias-account-model.js';

export const STRANGER_FRIENDSHIP_STATES = Object.freeze([
  'stranger',
  'intercepted',
  'requested',
  'accepted',
  'blocked',
]);

export const IDENTITY_REVEAL_STATES = Object.freeze([
  'hidden',
  'suspected',
  'revealed',
  'revoked',
]);

const FRIENDSHIP_TRANSITIONS = Object.freeze({
  stranger: new Set(['intercepted', 'requested', 'accepted', 'blocked']),
  intercepted: new Set(['requested', 'accepted', 'blocked']),
  requested: new Set(['accepted', 'intercepted', 'blocked']),
  accepted: new Set(['blocked']),
  blocked: new Set(['intercepted', 'requested', 'accepted']),
});

const REVEAL_TRANSITIONS = Object.freeze({
  hidden: new Set(['suspected', 'revealed']),
  suspected: new Set(['hidden', 'revealed', 'revoked']),
  revealed: new Set(['revoked']),
  revoked: new Set(['suspected', 'revealed']),
});

function clean(value, max = 0) {
  const text = String(value ?? '').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function validState(value, allowed, fallback) {
  const state = clean(value).toLowerCase();
  return allowed.includes(state) ? state : fallback;
}

export function normalizeRevealEntry(input = {}) {
  const row = input && typeof input === 'object' ? input : {};
  const state = validState(row.state, IDENTITY_REVEAL_STATES, 'hidden');
  return {
    state,
    evidence: clean(row.evidence, 500),
    updatedAt: Math.max(0, Number(row.updatedAt) || 0),
    updatedBy: clean(row.updatedBy, 180),
  };
}

export function normalizeIdentityRevealMap(input = {}, participantKeys = []) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const keys = new Set([
    ...participantKeys.map((key) => parsePrincipalKey(key)?.key).filter(Boolean),
    ...Object.keys(source).map((key) => parsePrincipalKey(key)?.key).filter(Boolean),
  ]);
  const output = {};
  for (const key of keys) output[key] = normalizeRevealEntry(source[key]);
  return output;
}

export function canTransitionFriendship(from, to) {
  const current = validState(from, STRANGER_FRIENDSHIP_STATES, 'stranger');
  const next = validState(to, STRANGER_FRIENDSHIP_STATES, '');
  return !!next && (current === next || FRIENDSHIP_TRANSITIONS[current]?.has(next));
}

export function transitionFriendship(metadata = {}, nextState, evidence = {}) {
  const current = validState(metadata.friendshipState, STRANGER_FRIENDSHIP_STATES, 'stranger');
  const next = validState(nextState, STRANGER_FRIENDSHIP_STATES, '');
  if (!canTransitionFriendship(current, next)) throw new Error(`不允许的陌生人状态变化：${current} -> ${next || '?'}`);
  if (next === 'blocked') {
    return {
      ...metadata,
      friendshipState: next,
      friendshipBlockedBy: parsePrincipalKey(evidence.by)?.key || '',
      friendshipBlockedAt: Math.max(0, Number(evidence.at) || Date.now()),
      friendshipBlockedReason: clean(evidence.reason, 300),
      blockedDeliveryAttempts: Math.max(0, Number(metadata.blockedDeliveryAttempts) || 0),
    };
  }
  return {
    ...metadata,
    friendshipState: next,
    friendshipBlockedBy: '',
    friendshipBlockedAt: 0,
    friendshipBlockedReason: '',
    blockedDeliveryAttempts: 0,
  };
}

export function isUserAliasBlockedByCharacter(chat) {
  const metadata = chat?.metadata || {};
  if (!isStrangerInterceptChat(chat) || metadata.friendshipState !== 'blocked') return false;
  const hasUserAlias = Object.entries(metadata.accountIdentityMap || {})
    .some(([key, accountId]) => String(key).startsWith('user:') && String(accountId || '').trim());
  return hasUserAlias && String(metadata.friendshipBlockedBy || '').startsWith('character:');
}

/**
 * 用户在陌生拦截窗里点「拦截」时，只封当前角色马甲账户对应的线程。
 * 同一 characterId 的主号与其它马甲不受影响。
 */
export function isCharacterAliasBlockedByUser(chat) {
  const metadata = chat?.metadata || {};
  if (!isStrangerInterceptChat(chat) || metadata.friendshipState !== 'blocked') return false;
  const hasCharacterAlias = Object.entries(metadata.accountIdentityMap || {})
    .some(([key, accountId]) => String(key).startsWith('character:') && String(accountId || '').trim());
  return hasCharacterAlias && String(metadata.friendshipBlockedBy || '').startsWith('user:');
}

/**
 * 当前窗口里角色是否正以前台马甲发言。
 * 拉黑本体只影响本体账号；不能因为马甲和本体共用 characterId，
 * 就把马甲消息也当作本体消息拒收。
 */
export function isCharacterAliasActiveInChat(chat, characterId) {
  const id = clean(characterId);
  if (!id || !isStrangerInterceptChat(chat)) return false;
  return !!clean(chat?.metadata?.accountIdentityMap?.[principalKey('character', id)]);
}

/**
 * 陌生线程能否作为跨窗记忆来源。
 * - 全员已揭示：可共享
 * - 当前也在马甲窗：只允许同一 accountId，禁止多小号互串
 * - 主会话默认不把未揭示马甲窗当跨窗源（身份清单走专用注入块，防剧情串号）
 * - allowOwnerAliasCrossWindow=true 时才按主人参与方放行（兼容显式共享）
 */
export function canStrangerChatShareMemory(chat, options = {}) {
  // 会话已删/查不到时不能当「可共享」——否则调用方对 undefined 读 .id 会整轮炸
  if (!chat || typeof chat !== 'object') return false;
  if (!isStrangerInterceptChat(chat)) return true;
  const identityMap = chat?.metadata?.accountIdentityMap || {};
  const keys = Object.keys(identityMap);
  if (isStrangerThreadFullyRevealed(chat)) return true;

  const currentAccountId = String(options.currentAccountId || '').trim();
  if (currentAccountId) {
    return Object.values(identityMap).some((id) => String(id || '').trim() === currentAccountId);
  }

  // 主会话 / 无当前马甲：未揭示的马甲窗默认不进跨窗记忆，避免多号剧情揉成一份
  if (options.allowOwnerAliasCrossWindow !== true) return false;

  const ownerIds = new Set(
    (Array.isArray(options.ownerCharacterIds) ? options.ownerCharacterIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  if (!ownerIds.size) return false;
  for (const key of keys) {
    if (!String(key).startsWith('character:')) continue;
    const cid = String(key).slice('character:'.length);
    if (ownerIds.has(cid) && String(identityMap[key] || '').trim()) return true;
  }
  const participants = Array.isArray(chat?.participants) ? chat.participants : [];
  return participants.some((id) => ownerIds.has(String(id || '').trim()));
}

export function canTransitionIdentityReveal(from, to) {
  const current = validState(from, IDENTITY_REVEAL_STATES, 'hidden');
  const next = validState(to, IDENTITY_REVEAL_STATES, '');
  return !!next && (current === next || REVEAL_TRANSITIONS[current]?.has(next));
}

export function transitionIdentityReveal(metadata = {}, subjectKey, nextState, evidence = {}) {
  const principal = parsePrincipalKey(subjectKey);
  if (!principal) throw new Error('身份揭示主体无效');
  const reveal = normalizeIdentityRevealMap(metadata.identityReveal, [principal.key]);
  const current = reveal[principal.key]?.state || 'hidden';
  const next = validState(nextState, IDENTITY_REVEAL_STATES, '');
  if (!canTransitionIdentityReveal(current, next)) throw new Error(`不允许的身份状态变化：${current} -> ${next || '?'}`);
  reveal[principal.key] = normalizeRevealEntry({
    state: next,
    evidence: evidence.text,
    updatedAt: evidence.at || Date.now(),
    updatedBy: evidence.by,
  });
  return { ...metadata, identityReveal: reveal };
}

export function strangerThreadKey(participants = [], identityMap = {}) {
  const accounts = normalizeAccountIdentityMap(identityMap);
  const parts = participants
    .map((item) => typeof item === 'string' ? parsePrincipalKey(item) : item)
    .filter((item) => item?.ownerType && item?.ownerId)
    .map((item) => {
      const key = principalKey(item.ownerType, item.ownerId);
      return key ? `${key}@${accounts[key] || 'main'}` : '';
    })
    .filter(Boolean)
    .sort();
  return parts.length >= 2 ? parts.join('|') : '';
}

export function createStrangerThreadMetadata({
  participants = [],
  accountIdentityMap = {},
  accountSnapshots = {},
  friendshipState = 'stranger',
  initiatorKey = '',
  recipientKey = '',
} = {}) {
  const participantKeys = participants
    .map((item) => typeof item === 'string' ? parsePrincipalKey(item)?.key : principalKey(item?.ownerType, item?.ownerId))
    .filter(Boolean);
  const identityMap = normalizeAccountIdentityMap(accountIdentityMap);
  const snapshots = {};
  for (const key of participantKeys) {
    const accountId = identityMap[key];
    const snapshot = accountId && accountSnapshots[accountId];
    if (snapshot) snapshots[accountId] = createAliasPublicSnapshot({ ...snapshot, id: accountId });
  }
  const state = validState(friendshipState, STRANGER_FRIENDSHIP_STATES, 'stranger');
  return {
    channel: 'stranger',
    channelKind: 'stranger_intercept',
    friendshipState: state,
    strangerThreadKey: strangerThreadKey(participantKeys, identityMap),
    strangerParticipantKeys: participantKeys,
    accountIdentityMap: identityMap,
    accountSnapshots: snapshots,
    identityReveal: normalizeIdentityRevealMap({}, participantKeys),
    initiatorKey: parsePrincipalKey(initiatorKey)?.key || '',
    recipientKey: parsePrincipalKey(recipientKey)?.key || '',
    memoryMode: 'isolated_alias',
  };
}

export function isStrangerInterceptChat(chat) {
  return String(chat?.metadata?.channelKind || '') === 'stranger_intercept';
}

/** 返回这扇陌生窗实际投递到的用户前台身份；空串表示用户本体。 */
export function resolveStrangerThreadUserAccountId(chat, userId = '') {
  if (!isStrangerInterceptChat(chat)) return '';
  const uid = String(userId || chat?.userId || '').trim();
  if (!uid) return '';
  return String(chat?.metadata?.accountIdentityMap?.[principalKey('user', uid)] || '').trim();
}

export function isStrangerThreadFullyRevealed(chat) {
  if (!isStrangerInterceptChat(chat)) return false;
  const identityMap = chat?.metadata?.accountIdentityMap || {};
  const keys = Object.keys(identityMap).filter((key) => String(identityMap[key] || '').trim());
  return keys.length > 0 && keys.every((key) => (
    normalizeRevealEntry(chat?.metadata?.identityReveal?.[key]).state === 'revealed'
  ));
}

/** 主会话只能二选一：未全揭示读隔离摘要，全揭示后才显式共享线程原文。 */
export function resolveAliasThreadMainChatShareMode(chat) {
  if (!isStrangerInterceptChat(chat)) return 'not_alias_thread';
  return isStrangerThreadFullyRevealed(chat) ? 'explicit_shared' : 'isolated_summary';
}

export function visibleIdentityFor(metadata = {}, subjectKey, principalProfile = {}) {
  const principal = parsePrincipalKey(subjectKey);
  if (!principal) return null;
  const identityMap = normalizeAccountIdentityMap(metadata.accountIdentityMap);
  const accountId = identityMap[principal.key] || '';
  const publicAlias = accountId ? metadata.accountSnapshots?.[accountId] : null;
  const reveal = normalizeRevealEntry(metadata.identityReveal?.[principal.key]);
  if (reveal.state === 'revealed') {
    return {
      kind: accountId ? 'revealed_alias' : 'principal',
      accountId,
      displayName: clean(principalProfile.displayName || principalProfile.name, 60),
      avatar: clean(principalProfile.avatar),
      bio: clean(principalProfile.bio, 300),
      revealState: reveal.state,
    };
  }
  if (publicAlias) return { kind: 'alias', ...publicAlias, revealState: reveal.state };
  return {
    kind: 'principal',
    accountId: '',
    displayName: clean(principalProfile.displayName || principalProfile.name, 60),
    avatar: clean(principalProfile.avatar),
    bio: clean(principalProfile.bio, 300),
    revealState: reveal.state,
  };
}

export function buildAliasIdentityBoundaryPrompt({
  actorKey,
  actorPublicIdentity = {},
  actorPrivateIdentity = {},
  counterpartKey,
  counterpartVisibleIdentity = {},
  counterpartRevealState = 'hidden',
  actorUsesAlias = false,
  actorKnowsCounterpartIdentity = false,
  mustPerformAsStranger = false,
  counterpartIsUnsolicitedUserAlias = false,
  actorAccountId = '',
  actorHandle = '',
  actorWindowLabel = '',
} = {}) {
  const actor = parsePrincipalKey(actorKey);
  const counterpart = parsePrincipalKey(counterpartKey);
  if (!actor || !counterpart) return '';
  const reveal = validState(counterpartRevealState, IDENTITY_REVEAL_STATES, 'hidden');
  const actorName = clean(actorPublicIdentity.displayName || actorPublicIdentity.name, 60) || '当前账户';
  const counterpartName = clean(counterpartVisibleIdentity.displayName || counterpartVisibleIdentity.name, 60) || '对方';
  const privateOwnerName = clean(actorPrivateIdentity.displayName || actorPrivateIdentity.name, 60);
  const privateMotive = clean(actorPrivateIdentity.personaOverlay, 4000);
  const windowLabel = clean(actorWindowLabel || actorPrivateIdentity.windowLabel, 40);
  const handle = clean(actorHandle || actorPublicIdentity.handle, 60);
  const accountId = clean(actorAccountId || actorPublicIdentity.accountId, 180);
  const ownerLine = actorUsesAlias && privateOwnerName
    ? `你就是角色“${privateOwnerName}”，正在有意识地操作自己的马甲“${actorName}”；这个马甲不是另一个 NPC。`
    : actorUsesAlias
      ? `你正在有意识地操作自己的马甲“${actorName}”；这个马甲不是另一个 NPC。`
      : `你当前以前台身份“${actorName}”参与本线程。`;
  const counterpartRule = actorKnowsCounterpartIdentity
    ? `你私下明确知道前台账户“${counterpartName}”对应的是你原本认识的对方，可以在内部沿用真实关系与共同经历；但这些认知不能自动变成公开措辞。`
    : reveal === 'revealed'
    ? `对方身份已明确揭示，可按已确认的身份事实理解“${counterpartName}”。`
    : reveal === 'suspected'
      ? `你对“${counterpartName}”的真实身份最多只能怀疑，不能当成已经确认。`
      : `你只认识前台账户“${counterpartName}”，不知道其真实身份。`;
  const shouldIsolateCounterpartAlias = counterpartIsUnsolicitedUserAlias
    && !actorKnowsCounterpartIdentity
    && reveal !== 'revealed';
  const unsolicitedBoundary = shouldIsolateCounterpartAlias
    ? [
      '【最高优先级：陌生骚扰者关系边界】',
      `“${counterpartName}”是一个未经邀请、莫名来联系你的路人账号。你必须把 TA 当成真正的陌生人，而不是用户本人、熟人、小号测试对象或可直接发展亲密关系的人。`,
      '你的态度必须和面对原本用户时有明显差异：默认保持距离、降低热情并提高防备。即使你的人设礼貌、温柔或善于社交，也只能客气而疏离，不能自然熟、主动宠溺、无条件安抚、暧昧迎合或迅速交心。',
      '原本用户在你心里的关系位置、亲密称呼、共同经历和情感特权是独占的，绝不能复制或转移给这个陌生账号。不得把只对原本用户使用的语气、昵称、承诺和身体/情感亲密直接给 TA。',
      '若陌生账号套话、试探感情、挑拨、示爱或勾引，你要按人设表现警惕、回避、追问来意、划清界限或拒绝；如果你原本对用户有爱情、暧昧或承诺，必须优先守住这段关系，不得以“只是聊聊”为由出轨式回应。',
      '除非本线程之后积累了足够、可信且符合人设的真实交往，关系只能缓慢变化；几轮普通聊天不足以消除陌生与防备。',
      '你保留自己遭遇过的其它陌生账号与骚扰话术记忆。若不同账号反复使用高度相似的措辞、试探路径或细节，可以逐步怀疑它们有关联、受同一人操控，或有人换号继续骚扰；但只能形成怀疑，不能据此确认这些账号属于原本用户，也不能跳过明确的身份揭示。',
    ].join('\n')
    : '';
  const aliasWindowPriority = actorUsesAlias
    ? [
      '【最高优先级·本马甲窗】',
      `当前前台：「${actorName}」${handle ? `（@${handle}）` : ''}${accountId ? `；accountId=${accountId}` : ''}`,
      windowLabel ? `本窗专用标签/用途：${windowLabel}——本窗的一切言行、心声与记忆都必须围绕这个用途，不得滑成「随便换个号闲聊」。` : '本窗必须有明确且持续的见不得光动机；禁止把它演成无差别闲聊号。',
      privateMotive
        ? `本窗专用意图与人设（完整遵循，优先级高于通用人设卡里与本窗冲突的部分）：\n${privateMotive}`
        : '本窗缺少内部动机说明时，只做最低限度的试探/窥视，不要发明另一套人格。',
      '记忆硬墙：只使用「本线程消息 + 明确标注属于本马甲的事实」。禁止调用你其它马甲窗的具体对话、承诺、试探进度或前台人设细节，也禁止把其它号的经历说成这个号做过。',
      '与大号关系：大号关系只可作幕后动机与对照；对外气泡不得掉马，也不得把大号独占亲密直接搬到本窗表演。',
      '若系统记忆里出现其它马甲的摘要，只能当「你知道自己还开过别的号」的清单级认知，不得把那些剧情揉进当前号的连续记忆。',
    ].join('\n')
    : '';
  return [
    '[陌生人账户边界]',
    aliasWindowPriority,
    unsolicitedBoundary,
    ownerLine,
    counterpartRule,
    mustPerformAsStranger ? '所有对外可见气泡都必须维持陌生人表演：不要承认这是你的小号，不要直接复述只有大号关系中才会知道的细节。' : '',
    actorKnowsCounterpartIdentity ? '' : '只使用本段给出的前台资料和本线程消息。不得调用对方主号聊天、真实姓名、头像、共同记忆或用户卡来反推身份。',
    '模型猜中、语气相似、关系熟悉都不构成身份揭示；没有明确揭示事件时，必须维持当前状态。',
    '【马甲窗心声硬规则】本线程与普通私聊一样：每轮协议块第一行必须输出 state（含 inner/intent/status），不得因「防掉马」省略心声。',
    'state.inner / intent 是玩家可见的幕后字段：可以写你作为本体操作马甲时的真实盘算、紧张、窥视欲、表演感或对对方身份的怀疑；这不算掉马。',
    '禁止的是通过 msg/voice/正文/旁白/翻译/引用名等对外可见内容泄露真实身份；不要把「我其实是某某」写进对外气泡。',
    `【对方事实边界】禁止虚构“${counterpartName}”/user 从未在本线程消息、记忆或档案中发生过的具体事件、行程、说过的话或共同经历；没有依据时只可表达你自己的感受、猜测或试探，并标明那是猜测，不得当成既成事实追问或指责。`,
    '继续遵循普通聊天的消息格式、语气、翻译和心声规则（state 必填）。',
  ].filter(Boolean).join('\n');
}
