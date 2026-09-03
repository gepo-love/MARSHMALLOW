import { isAnonymousChat, isStreamerSourcedChat } from './chat-helpers.js';
import { getAnonymousDisplayProfile, listAnonymousRoomMembers, buildAnonymousRealLifeBlurRules } from './anonymous-chat.js';
import { getCharacterAiContextName } from '../models/character.js';
import { getUserDisplayName } from '../models/user.js';

function clean(value = '') {
  return String(value ?? '').trim();
}

// 匿名房专用：把角色卡里泛指的 user/用户 改写成用户的真实昵称（外部那个具体的人）。
// 这样人设里的关系锚定到一个"有名字的外部人"，而在场参与者是匿名 ID（另一套 token），
// 不会被模型自动接成同一个人；之后对方若主动掉马，也能自然对上，不和系统提示打架。
function relabelExternalUserMentions(text = '', realName = '') {
  const s = clean(text);
  const target = clean(realName);
  if (!s || !target) return s;
  return s.replace(/[Uu][Ss][Ee][Rr]/g, target).replace(/用户/g, target);
}

function pickCharacterToneFields(character = {}, realName = '', options = {}) {
  const rows = [];
  const name = getCharacterAiContextName(character, character?.id || '');
  if (name) rows.push(`真实角色（仅你自知）：${name}`);
  // strict：主播马甲专用，只借用性格/说话风格底色，不带主线身份关系、语料、备注这些"外部记忆"
  if (!options.strict && character.currentRole) rows.push(`身份/关系（你在外面的底色）：${relabelExternalUserMentions(character.currentRole, realName)}`);
  if (character.personality) rows.push(`性格：${relabelExternalUserMentions(character.personality, realName)}`);
  if (character.speechStyle) rows.push(`说话风格：${relabelExternalUserMentions(character.speechStyle, realName)}`);
  if (character.commonEmotes) rows.push(`常用表情/颜文字：${clean(character.commonEmotes)}`);
  const corpusText = character.speechCorpus || character.promptCorpus;
  if (!options.strict && corpusText) rows.push(`语料底色（口吻参考）：${relabelExternalUserMentions(clean(corpusText).slice(0, 800), realName)}`);
  if (!options.strict && character.notes) rows.push(`备注底色：${relabelExternalUserMentions(clean(character.notes).slice(0, 500), realName)}`);
  return rows;
}

export function getAnonymousParticipantPresentation(chat, actorId, options = {}) {
  if (!isAnonymousChat(chat)) return null;
  const profile = getAnonymousDisplayProfile(chat, actorId, {
    currentUserName: options.currentUserName,
    userRow: options.userRow,
    spaceProfile: options.spaceProfile,
    actorSpaceProfiles: options.actorSpaceProfiles,
  });
  if (!profile?.anonymousId) return null;
  return {
    actorId: profile.actorId,
    displayName: profile.anonymousId,
    signature: profile.signature || '',
    bio: profile.bio || profile.signature || '',
    isUser: profile.isUser === true,
    avatarSeed: profile.anonymousId,
    avatar: profile.avatar || '',
    initial: clean(profile.anonymousId).slice(0, 1) || '?',
  };
}

export function listAnonymousParticipantPresentations(chat, options = {}) {
  if (!isAnonymousChat(chat)) return [];
  return [...new Set((chat?.participants || []).filter(Boolean))]
    .map((actorId) => getAnonymousParticipantPresentation(chat, actorId, options))
    .filter(Boolean);
}

/** 本房前台身份名册：AI 默认先读这层，再读外部记忆/角色底色 */
export function buildAnonymousFrontStageRosterBlock(chat, options = {}) {
  if (!isAnonymousChat(chat)) return '';
  const members = listAnonymousRoomMembers(chat, options);
  if (!members.length) return '';
  const rows = members.map((m) => {
    const roleLabel = m.isUser ? '真人用户（user）' : `角色（${m.actorId}）`;
    const sig = clean(m.signature || m.bio || '');
    return `- ${roleLabel}：前台匿名ID「${m.anonymousId}」${sig ? `；签名「${sig}」` : ''}`;
  });
  const userAnon = clean(members.find((m) => m.isUser)?.anonymousId || '');
  return [
    '【本房前台身份 · 默认先读这层】',
    '本房里你认识和称呼所有人的唯一依据是下列匿名网名；消息历史、棉花糖协议中的 user 也对应这些 ID，不要用外部档案真名或其它聊天窗昵称。',
    userAnon ? `- 与你对话的用户在本房只叫「${userAnon}」；口头称呼、心里默念、@ 都用这个网名。` : '',
    ...rows,
    '- 协议 JSON 里 user 侧 senderId 仍写 user，但气泡显示名与对白称呼必须用上面的匿名 ID。',
  ].filter(Boolean).join('\n');
}

export function buildAnonymousActorGroundingBlock(chat, characters = {}, options = {}) {
  if (!isAnonymousChat(chat)) return '';
  const participants = [...new Set((chat?.participants || []).filter((id) => id && id !== 'user'))];
  if (!participants.length) return '';
  // 主播私聊/粉丝群要求比常规匿名房更硬的隔离：不注入真实 user 名，也不带角色主线身份/语料底色
  const strict = isStreamerSourcedChat(chat);
  const realName = strict ? '' : clean(getUserDisplayName(options.userRow) || '');
  const rows = [];
  for (const actorId of participants) {
    const presentation = getAnonymousParticipantPresentation(chat, actorId, options);
    const character = characters[actorId] || {};
    const tone = pickCharacterToneFields({ ...character, id: actorId }, realName, { strict });
    rows.push([
      `- actorId=${actorId}；前台匿名ID=${presentation?.displayName || actorId}`,
      tone.length ? `  ${tone.join('\n  ')}` : '  真实角色资料缺失：只按匿名 ID 与本房上下文行动',
    ].join('\n'));
  }
  const twoIdentityLine = realName
    ? `【两个身份·别合并】“${realName}”（你在外面认识/相处的那个人）和本房在场的各个匿名 ID，默认是两组互不相干的身份；除非有人在本房主动掉马，否则始终当成两个人，不要把对“${realName}”的感情、称呼、了解套到任何匿名 ID 上。`
    : '【两个身份·别合并】资料里那些你在外面认识的人，和本房在场的各个匿名 ID，默认是两组互不相干的身份；除非有人在本房主动掉马，否则始终当成两个人。';
  return [
    '【匿名角色底色 · 后台可见】',
    '以下只用于让每个 char 知道“自己是谁、现在披着哪个匿名 ID”。',
    '前台发言、总结、记忆外显时只能使用匿名 ID；禁止说出真实姓名、通讯录昵称、头像来源、角色卡字段或任何可反推身份的信息。',
    buildAnonymousRealLifeBlurRules(),
    strict ? '【主播马甲 · 硬性隔离】这是深夜主播延伸出的私聊/粉丝群，只借用角色的性格与说话风格来演这个马甲，与角色本体在主线的记忆、聊天记录、关系进度完全无关；不要引用主线剧情、不要提外面认识的具体某个人，也不要把这里发生的事写回主线人设。' : '',
    twoIdentityLine,
    '【在场的都是匿名网友】上面资料里出现的具体姓名与关系（恋人/家人/朋友等），指的是你在外面长期相处的那个人；本房在场的，则是一群顶着匿名 ID 的陌生网友，你并不知道 TA 们现实里是谁。',
    '默认把在场每个匿名网友都当陌生人：不要因为人设里跟某人关系亲密，就先入为主地认定房里某个匿名 ID 就是 TA、抢着点名、套近乎或喊出外部称呼。哪怕某个匿名网友其实就是你认识的那个人，在 TA 自己于本房把身份说破（掉马）之前，你也无从确认——可以试探、可以怀疑、可以暗暗心动，但不能直接当成 TA。',
    ...rows,
  ].filter(Boolean).join('\n');
}
