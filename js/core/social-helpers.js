import { listStickerPacks, sanitizeStickerDisplayName } from './sticker-store.js';
import {
  resolveStickerUrlByExactName,
  resolveStickerUrlByKeyword,
  parseStickerTagLine,
  normalizeStickerBracketText,
} from './chat/sticker-resolve.js';
import { resolveChatParticipantName as relayResolveName } from './chat/social-chat-relay.js';
import { looksLikeRawParticipantId, stripLeakedCharacterCodes } from './chat/character-code-fallback.js';
import { getPartnerId, isAnonymousChat, isPeerPrivateChat } from './chat-helpers.js';
import { getAnonymousDisplayProfile } from './anonymous-chat.js';
import { principalKey } from './alias-account-model.js';

export { resolveChatParticipantName } from './chat/social-chat-relay.js';

export function formatChatPickerLabel(item, fallback = '') {
  const name = String(item?.name || item?.title || fallback || '').trim();
  const sub = String(item?.subtitle || item?.id || '').trim();
  return sub && sub !== name ? `${name} · ${sub}` : name || sub || '未命名';
}

function isUsableChatPickerLabel(value = '') {
  const label = String(value || '').trim();
  if (!label) return false;
  if (['对方', '会话', '私聊', '群聊', '匿名', '匿名群', '未命名', 'TA'].includes(label)) return false;
  if (looksLikeRawParticipantId(label)) return false;
  return true;
}

/** 陌生消息选择器只展示前台账号；缺快照也绝不回退到通讯录本体名。 */
export function getStrangerChatPickerLabel(chat = {}) {
  if (String(chat?.metadata?.channelKind || '') !== 'stranger_intercept') return '';
  const partnerId = getPartnerId(chat);
  const accountId = partnerId
    ? String(chat?.metadata?.accountIdentityMap?.[principalKey('character', partnerId)] || '').trim()
    : '';
  const snapshot = accountId ? chat?.metadata?.accountSnapshots?.[accountId] || {} : {};
  const displayName = String(snapshot.displayName || '').trim();
  const handle = String(snapshot.handle || '').trim().replace(/^@+/, '');
  if (displayName && handle) return `${displayName} · @${handle}`;
  return displayName || (handle ? `@${handle}` : '') || '陌生消息';
}

/**
 * 聊天会话选择器展示名（私聊解析角色名，群聊用群名）。
 * resolveName 可选；未传或返回不可用占位时，会自行查角色表 / 群名 / 匿名 ID。
 */
export async function formatChatPickerLabelForChat(chat, resolveName) {
  if (!chat || typeof chat !== 'object') return '未命名';

  const strangerLabel = getStrangerChatPickerLabel(chat);
  if (strangerLabel) return strangerLabel;

  if (isAnonymousChat(chat)) {
    if (chat.type === 'group') {
      return String(chat.groupSettings?.name || '').trim() || '匿名群';
    }
    const counterpartId = chat.anonymousPrivateConfig?.counterpartActorId || getPartnerId(chat);
    const anonId = String(
      getAnonymousDisplayProfile(chat, counterpartId, {})?.anonymousId || '',
    ).trim();
    if (anonId) return anonId;
  }

  const groupName = String(chat.groupSettings?.name || '').trim();
  if (chat.type === 'group') return groupName || '群聊';
  if (groupName) return groupName;

  const partnerId = getPartnerId(chat);
  const softFallback = '私聊';

  if (partnerId && typeof resolveName === 'function') {
    try {
      const custom = await resolveName(partnerId, { fallback: softFallback, chat });
      if (isUsableChatPickerLabel(custom)) return String(custom).trim();
    } catch (_) { /* fall through */ }
  }

  if (partnerId) {
    try {
      const fromStore = await relayResolveName(partnerId, { fallback: '' });
      if (isUsableChatPickerLabel(fromStore)) return String(fromStore).trim();
    } catch (_) { /* fall through */ }
  }

  if (isPeerPrivateChat(chat)) {
    try {
      const ids = (chat.participants || []).filter(Boolean).slice(0, 2);
      const names = [];
      for (const id of ids) {
        const n = await relayResolveName(id, { fallback: '' });
        if (isUsableChatPickerLabel(n)) names.push(String(n).trim());
      }
      if (names.length) return names.join('、');
    } catch (_) { /* fall through */ }
  }

  const partnerName = String(chat.metadata?.partnerName || '').trim();
  if (isUsableChatPickerLabel(partnerName)) return partnerName;

  return softFallback;
}

export function getSafeCharacterDisplayName(characterOrId, options = {}) {
  const fallback = String(options.fallback || '').trim();
  if (characterOrId && typeof characterOrId === 'object') {
    return characterOrId.name || characterOrId.customNickname || characterOrId.realName || fallback || characterOrId.id || '角色';
  }
  const id = String(characterOrId || '').trim();
  if (!id) return fallback || '角色';
  return fallback || id;
}

export function cleanSocialDisplayText(value, options = {}) {
  return stripLeakedCharacterCodes(String(value || ''), {
    ...options,
    fallbackLabel: String(options.fallbackLabel || '匿名用户').trim() || '匿名用户',
  });
}

export function resolveSocialAuthorLabel(value, options = {}) {
  const fallback = String(options.fallback || '匿名用户').trim() || '匿名用户';
  return cleanSocialDisplayText(value, { ...options, fallbackLabel: fallback }).trim() || fallback;
}

export function expandStickerTagsInBubbleText(rawText, allStickers, esc, escAttr) {
  const s = normalizeStickerBracketText(String(rawText ?? ''));
  if (!s) return '';
  if (!allStickers?.length) return esc(s);
  if (!/(?:\[表情包|\[贴纸|(?:表情包|贴纸)\s*[：:]|\[[^\]\r\n]{1,80}\])/.test(s)) return esc(s);

  const imgSpan = (url, name) =>
    `<span class="chat-sticker-slot chat-sticker-slot--mixed-bubble"><span class="chat-sticker"><img src="${escAttr(url)}" alt="${esc(name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.closest('.chat-sticker-slot')?.replaceWith(document.createTextNode('[表情包: ${escAttr(name)}]'))" /></span></span>`;

  function segmentToHtml(seg) {
    const t = String(seg || '').trim();
    if (!t) return '';
    const pl = parseStickerTagLine(t);
    if (pl?.url) return imgSpan(pl.url, pl.name);
    const bracket = t.match(/^\[(?:表情包|贴纸)[:：]\s*([^\]]+)\]\s*$/);
    if (bracket) {
      const r = resolveStickerUrlByKeyword(bracket[1], allStickers, { fallbackToAll: false });
      if (r?.url) return imgSpan(r.url, r.name);
      return esc(t);
    }
    const bareBracket = t.match(/^\[([^\]\r\n]{1,80})\]\s*$/);
    if (bareBracket) {
      const r = resolveStickerUrlByExactName(bareBracket[1], allStickers);
      if (r?.url) return imgSpan(r.url, r.name);
      return esc(t);
    }
    const kwForm = t.match(/^(?:表情包|贴纸)[：:]\s*(.+)$/);
    if (kwForm) {
      const r = resolveStickerUrlByKeyword(kwForm[1].trim(), allStickers, { fallbackToAll: false });
      if (r?.url) return imgSpan(r.url, r.name);
    }
    return esc(t);
  }

  const re =
    /\[(?:表情包|贴纸)[:：]\s*[^\]]+\](?:\s+(?:https?:\/\/[^\s\[\]）]+|data:image[^;\s]+;base64,[A-Za-z0-9+/=]+))?|(?:表情包|贴纸)[：:]\s*[^\n\r，。！？]{1,48}|\[[^\]\r\n]{1,80}\]/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    out += esc(s.slice(last, m.index));
    out += segmentToHtml(m[0]);
    last = m.index + m[0].length;
  }
  out += esc(s.slice(last));
  return out;
}

function cleanCardLine(value = '', limit = 0) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return limit > 0 ? text.slice(0, limit) : text;
}

function normalizedGenderKind(value = '') {
  const text = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!text) return '';
  if (/^(?:女|女性|女人|女孩|女生|female|woman|girl|she\/her|she|她|f)(?:$|[（(\/])/.test(text)) return 'female';
  if (/^(?:男|男性|男人|男孩|男生|male|man|boy|he\/him|he|他|m)(?:$|[（(\/])/.test(text)) return 'male';
  if (/^(?:非二元|无性别|中性|性别流动|nonbinary|agender|genderfluid|they\/them)(?:$|[（(\/])/.test(text)) return 'neutral';
  return 'custom';
}

/** 只读取结构化字段或角色资料中的明确自述；绝不按姓名、职业、性格和外观猜性别。 */
export function resolveExplicitCharacterGender(character = {}) {
  const pronouns = cleanCardLine(character?.pronouns, 24);
  if (pronouns) return { kind: normalizedGenderKind(pronouns), label: pronouns, source: 'pronouns字段' };
  const structured = cleanCardLine(character?.gender, 24);
  if (structured) return { kind: normalizedGenderKind(structured), label: structured, source: 'gender字段' };
  const corpus = [
    character?.promptCorpus,
    character?.personality,
    character?.notes,
  ].map((value) => String(value || '')).filter(Boolean).join('\n');
  const match = corpus.match(/(?:性别\s*[:：=]\s*|(?:本角色|角色本人|本人|她|他)\s*(?:明确)?(?:是|为)\s*(?:一名|一个)?\s*)(女性|女人|女孩|女生|男性|男人|男孩|男生|非二元|无性别|中性|性别流动|female|woman|girl|male|man|boy|non[- ]?binary|agender|genderfluid)/i);
  if (!match) return { kind: '', label: '', source: '' };
  return { kind: normalizedGenderKind(match[1]), label: cleanCardLine(match[1], 24), source: '角色资料明确设定' };
}

export function buildCharacterGenderRuleLine(character = {}, fallbackId = '') {
  const id = cleanCardLine(character?.id || fallbackId, 100) || 'unknown';
  const name = cleanCardLine(character?.name || character?.realName || id, 80) || id;
  const gender = resolveExplicitCharacterGender(character);
  const explicitPronouns = cleanCardLine(character?.pronouns, 24);
  if (gender.kind === 'female') {
    return `- id=${id}｜${name}：明确为女性（${gender.source}=${gender.label}）；第三人称只能用“${explicitPronouns || '她'}”${explicitPronouns ? '' : '或“TA”'}，禁止用“他”。`;
  }
  if (gender.kind === 'male') {
    return `- id=${id}｜${name}：明确为男性（${gender.source}=${gender.label}）；第三人称只能用“${explicitPronouns || '他'}”${explicitPronouns ? '' : '或“TA”'}，禁止用“她”。`;
  }
  if (gender.kind) {
    return `- id=${id}｜${name}：性别明确为“${gender.label}”（${gender.source}）；严格沿用原设定，不得强行二元化，拿不准代词时只用“TA”或名字。`;
  }
  return `- id=${id}｜${name}：未明确填写性别；只能用“TA”或名字，禁止根据姓名、职业、性格、外观或关系猜成“他/她”。`;
}

export function buildCharacterGenderRulesBlock(characters = []) {
  const rows = (Array.isArray(characters) ? characters : []).filter((character) => character?.id);
  if (!rows.length) return '';
  return [
    '【角色性别与代词硬表 · 按 id 绑定】',
    '发帖人、被提及对象、朋友圈贴主和每位评论者都必须按对应 id 查表；名字、职业、性格和语气不能推翻本表。没有明确性别时保持中性，禁止猜测。',
    ...rows.map((character) => buildCharacterGenderRuleLine(character)),
  ].join('\n');
}

function compactObjectLinesForCard(obj = {}, labelMap = {}, limit = 0) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const clean = cleanCardLine(text, limit);
      return clean ? `${labelMap[key] || key}：${clean}` : '';
    })
    .filter(Boolean);
}

const CARD_LIFE_LABELS = {
  homeDetails: '居家细节',
  familyThreads: '家庭线索',
  socialAnchors: '社交锚点',
  habits: '习惯与小癖',
  activitySeeds: '活动种子',
};

const CARD_ANCHOR_LABELS = {
  city: '故事城市',
  realCityMap: '现实城市',
  weatherHint: '天气描述',
  area: '活动片区',
  label: '住址标签',
  mapQuery: '真实地点/地标',
  note: '地图备注',
};

/** 单个角色的完整角色卡文本块（多行，供论坛/微博单角色生成等场景使用）。 */
function buildFullCharacterCard(ch, list = []) {
  const parts = [`【角色卡 · ${ch.name || ch.realName || ch.id} · id=${ch.id}】`];
  parts.push(`性别与代词：${buildCharacterGenderRuleLine(ch).replace(/^[-]\s*/, '')}`);
  if (ch.name) parts.push(`用户侧显示备注：${cleanCardLine(ch.name, 80)}（只用于界面显示，不等于角色真名）`);
  if (ch.realName && ch.realName !== ch.name) parts.push(`真名：${cleanCardLine(ch.realName, 80)}`);
  if (Array.isArray(ch.aliases) && ch.aliases.length) parts.push(`别名：${ch.aliases.map((x) => cleanCardLine(x, 40)).filter(Boolean).join(' / ')}`);
  if (ch.customNickname) parts.push(`用户备注名：${cleanCardLine(ch.customNickname, 80)}（仅作用户侧称呼参考，不等于公开展示名）`);
  if (ch.roleTier) {
    const tierLabel = {
      main: '主陪伴',
      supporting: '常驻角色（群像常驻、可独立私聊，不是路人或背景板）',
      npc: 'NPC',
      background: '背景',
    }[String(ch.roleTier).trim()] || String(ch.roleTier);
    parts.push(`角色层级：${cleanCardLine(tierLabel, 80)}`);
  }
  if (ch.currentRole) parts.push(`身份/关系：${cleanCardLine(ch.currentRole)}`);
  if (ch.currentStatus) parts.push(`当前状态：${cleanCardLine(ch.currentStatus)}`);
  if (ch.userRelationStatus) parts.push(`与用户关系状态：${cleanCardLine(ch.userRelationStatus)}`);
  if (ch.birthDate) parts.push(`出生日期：${cleanCardLine(ch.birthDate, 40)}`);
  if (ch.personality) parts.push(`性格底色：${cleanCardLine(ch.personality)}`);
  if (ch.speechStyle) parts.push(`说话风格：${cleanCardLine(ch.speechStyle)}`);
  if (ch.commonEmotes) parts.push(`常用 Emoji / 颜文字：${cleanCardLine(ch.commonEmotes)}`);
  if (ch.appearancePrompt) parts.push(`外观描述：${cleanCardLine(ch.appearancePrompt)}`);
  if (ch.promptCorpus) parts.push(`角色资料（完整）：${cleanCardLine(ch.promptCorpus)}`);
  if (ch.speechCorpus) parts.push(`语料库（完整）：${cleanCardLine(ch.speechCorpus)}`);
  const lifeLines = compactObjectLinesForCard(ch.lifeProfile, CARD_LIFE_LABELS);
  if (lifeLines.length) parts.push(`生活圈：\n${lifeLines.join('\n')}`);
  const anchorLines = compactObjectLinesForCard(ch.residenceAnchor, CARD_ANCHOR_LABELS);
  if (anchorLines.length) parts.push(`地点锚点：\n${anchorLines.join('\n')}`);
  const loc = ch.locationProfile && typeof ch.locationProfile === 'object' ? ch.locationProfile : null;
  if (loc) {
    const locBits = [
      loc.mode ? `模式=${cleanCardLine(loc.mode, 40)}` : '',
      loc.region ? `区域=${cleanCardLine(loc.region, 80)}` : '',
      loc.city?.name ? `城市=${cleanCardLine(loc.city.name, 80)}` : '',
      loc.lifestyle?.identity ? `生活身份=${cleanCardLine(loc.lifestyle.identity, 120)}` : '',
      loc.lifestyle?.commute ? `通勤=${cleanCardLine(loc.lifestyle.commute, 120)}` : '',
      Array.isArray(loc.lifestyle?.hobbies) && loc.lifestyle.hobbies.length ? `兴趣=${loc.lifestyle.hobbies.map((x) => cleanCardLine(x, 40)).join('、')}` : '',
    ].filter(Boolean);
    if (locBits.length) parts.push(`位置资料：${locBits.join('；')}`);
  }
  const relLines = [];
  for (const [rid, rel] of Object.entries(ch.relationships || {})) {
    const target = list.find((item) => item.id === rid);
    relLines.push(`${target?.name || rid}：${cleanCardLine(rel)}`);
  }
  if (relLines.length) parts.push(`关系网：\n${relLines.join('\n')}`);
  if (ch.notes) parts.push(`本地备注：${cleanCardLine(ch.notes)}`);
  if (Array.isArray(ch.promptTags) && ch.promptTags.length) parts.push(`说话标签ID：${ch.promptTags.map((x) => cleanCardLine(x, 40)).join('、')}`);
  return parts.join('\n');
}

/** 单个角色的精简单行卡片（供微博多角色批量生成等 token 敏感场景使用）。 */
function buildCompactCharacterCard(ch, list = []) {
  const bits = [];
  const displayName = cleanCardLine(ch.name || ch.realName || ch.id, 80);
  const realName = cleanCardLine(ch.realName || ch.name || ch.id, 80);
  bits.push(`真名=${realName}`);
  bits.push(`用户侧显示备注=${displayName}（仅界面标签，不是真名）`);
  bits.push(`性别=${buildCharacterGenderRuleLine(ch).replace(/^[-]\s*/, '')}`);
  if (ch.currentRole) bits.push(`身份=${cleanCardLine(ch.currentRole)}`);
  if (ch.userRelationStatus) bits.push(`与用户关系=${cleanCardLine(ch.userRelationStatus)}`);
  if (ch.personality) bits.push(`性格=${cleanCardLine(ch.personality)}`);
  if (ch.speechStyle) bits.push(`说话风格=${cleanCardLine(ch.speechStyle)}`);
  if (ch.speechCorpus) bits.push(`语料库（完整）=${cleanCardLine(ch.speechCorpus)}`);
  if (ch.promptCorpus) bits.push(`角色资料（完整）=${cleanCardLine(ch.promptCorpus)}`);
  if (ch.currentStatus) bits.push(`当前状态=${cleanCardLine(ch.currentStatus)}`);
  const relEntries = Object.entries(ch.relationships || {});
  if (relEntries.length) {
    const relText = relEntries
      .map(([rid, rel]) => `${list.find((item) => item.id === rid)?.name || rid}:${cleanCardLine(rel)}`)
      .join('、');
    if (relText) bits.push(`关系=${relText}`);
  }
  const line = bits.join('｜') || '（未填写人设，需自行建立、避免同质化）';
  return `【角色卡·${ch.name || ch.realName || ch.id}·id=${ch.id}】${line}`;
}

/**
 * 社交生成通用角色卡注入：把通讯录角色卡拼成可读文本块，喂给微博/论坛/朋友圈等生成 prompt，
 * 强调"必须服从角色卡人设"而不是只给个名字让模型自由发挥。
 * @param {Array} characters 角色对象数组（来自 character-store 的 listCharacters）
 * @param {object} options
 * @param {'full'|'compact'} [options.mode] full=每人多行完整卡片（论坛/单角色场景）；
 *   compact=每人一行精简卡片（微博多角色批量生成，控制 token）。
 * @param {number} [options.maxCount] 最多注入的角色数量。
 */
export function buildSocialCharacterCardsBlock(characters = [], options = {}) {
  const mode = options.mode === 'compact' ? 'compact' : 'full';
  const maxCount = Number(options.maxCount) || (mode === 'compact' ? 18 : 80);
  const list = (Array.isArray(characters) ? characters : [])
    .filter((ch) => ch?.id && ch.id !== 'user')
    .slice(0, maxCount);
  if (!list.length) return '';
  const cards = list.map((ch) => (mode === 'compact' ? buildCompactCharacterCard(ch, list) : buildFullCharacterCard(ch, list)));
  return [
    '【通讯录角色卡 · 生成必须读取】',
    '以下是当前存档的通讯录角色卡。发帖、楼层、评论、私信、小号/马甲都必须优先服从对应角色卡的人设、语料库、说话风格、关系位置和生活资料；不要只套模板、不要凭空编人设。',
    '角色卡标题及 name / authorName 可以沿用用户侧显示备注用于前台展示；叙事中的身份、自称和“姓名是谁”必须以真名字段为准。备注与真名不同时，禁止把备注误写成角色本名。',
    buildCharacterGenderRulesBlock(list),
    ...cards,
  ].join('\n\n');
}

export function buildSocialHardRulesPrompt(user = null) {
  const uid = user ? String(user.id || '').trim() : '';
  const uname = user ? String(user.name || user.nickname || '').trim() : '';
  return (
    `[社交硬规则 · 身份约束]\n`
    + `- 禁止 AI 扮演用户发朋友圈、发微博、发论坛主帖：生成内容中的发贴人 author / authorId / authorName、朋友圈 posts[].author、微博 posts[].authorId 等，不得为 \`user\`、不得与当前用户档案 id（${uid || '未选择'}）或显示名（${uname || '未选择'}）相同。\n`
    + `- 用户本人动态只能由用户在应用内亲自发布；你只生成世界观内其他角色、NPC、官号、营销号、路人或匿名账号的内容。\n`
    + `- 评论、私信、转发链中可提及或 @用户，但不要生成「用户本人刚发的」那条微博/朋友圈/论坛帖的正文。\n`
    + `- 【用户事实边界】任何提及用户的具体经历、原话、近况、关系进展或与他人的互动，只能来自已提供的用户档案、聊天记录、记忆、角色设定或本轮场景指令；不得为了八卦、吃醋、营销号爆料、朋友圈暗示或论坛剧情自行杜撰。没有来源时只能写角色单方面的感受/猜测，且不能伪装成既成事实。仅当用户当前明确授权虚构该事件时例外。`
  );
}

export async function buildSocialNarrativeGuidancePrompt(options = {}) {
  const scopedPackIds = Array.isArray(options.stickerPackIds)
    ? [...new Set(options.stickerPackIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : null;
  if (options.allowStickers === false || (scopedPackIds && !scopedPackIds.length)) {
    return (
      `[社交叙事指导 · 表情包正文]\n`
      + `本次不要在正文、评论或楼层里写 \`[表情包:名称]\`，也不要省略前缀写成 \`[名称]\`；不要输出 stickerNames，纯文字即可。`
    );
  }
  const maxNames = options.maxNames ?? 200;
  const packs = (await listStickerPacks())
    .filter((pack) => !scopedPackIds || scopedPackIds.includes(String(pack?.id || '').trim()));
  const names = [];
  for (const p of packs) {
    for (const s of p.stickers || []) {
      names.push(sanitizeStickerDisplayName(s.name));
    }
  }
  const uniq = [...new Set(names)];
  if (uniq.length) {
    const list = uniq.slice(0, maxNames);
    const more =
      uniq.length > maxNames
        ? `\n（还有 ${uniq.length - maxNames} 个未列出，仍可用 [表情包:名称] 精确匹配）`
        : '';
    return (
      `[社交叙事指导 · 表情包正文]\n`
      + `在微博正文、热评、论坛帖与楼层、朋友圈正文与评论中，可自然使用 \`[表情包:名称]\`。名称须与下列之一完全一致（含标点）。\n`
      + `“表情包:”前缀不可省略；禁止把它写成裸 \`[名称]\`，也不要用方括号舞台动作冒充表情包。\n`
      + `建议：本批生成里多数条目在正文或评论中至少出现 1 处 \`[表情包:…]\`；表情包请放在整段文字写完之后（单独成行或紧接句末），不要插进词语中间把一句话拆开；不要用 Markdown 图片语法代替。\n`
      + list.map((n) => `· ${n}`).join('\n')
      + more
    );
  }
  if (scopedPackIds) {
    return (
      `[社交叙事指导 · 表情包正文]\n`
      + `当前角色没有可用的已绑定表情包；本次不要在正文、评论或楼层里写 \`[表情包:名称]\` 或裸 \`[名称]\`，也不要输出 stickerNames；纯文字即可。`
    );
  }
  return (
    `[社交叙事指导 · 表情包正文]\n`
    + `用户尚未导入表情包时可省略；若写 \`[表情包:名称]\`，前台会按本地库匹配；“表情包:”前缀不可省略，名称尽量简短、像真实表情包名。`
  );
}

export async function resolveParticipantNameForSocial(id, fallback = '') {
  return relayResolveName(id, { fallback });
}

const SOCIAL_FORMAT_LABELS = {
  moments: '朋友圈',
  weibo: '微博',
  forum: '论坛',
  anon_space: '空间动态',
  anon_wall: '匿名墙投稿',
};

const SOCIAL_SOURCE_BALANCE_BLOCK = [
  '[内容来源 · 别只从聊天记录抄]',
  '一批内容来源要有比例，不要全部指向同一件事、也不要全是聊天记录复读：',
  '- 一部分来自仍新鲜的最近聊天梗/事件/被调侃的点（要改写口吻和措辞，不能整句照抄）；已过期的昨日常只能作口吻背景，不要反复当新动态/新帖主话题',
  '- 一部分来自角色自己的兴趣爱好、习惯、职业相关碎片，和当前聊天无关也可以',
  '- 一部分是纯生活流水账：天气、通勤、吃的、刷到的东西、莫名其妙的碎碎念',
  '同一次批量生成里，禁止把已经写过的同一件具体事换皮再发一遍；没有新鲜聊天素材时优先另开新题。',
  '评论区/回复区的笑点更多来自围观者互相打趣、内部黑话、错位理解、被突然牵连的第三人，而不是句句都在夸赞或回应发帖人本身；可以有和正文毫不相关的插科打诨、复读老梗、荒谬的逻辑跳跃。',
].join('\n');

const SOCIAL_SHAPE_BLOCKS = {
  multi_author: [
    '[常见形状 · 三选一或混用，不要每次都用同一种]',
    '- 单人连发呼应：同一个人短时间内连发好几条，情绪从吐槽到自嘲/上头层层递进，可以碎片化、不完整，像意识流',
    '- 多人各自发但有关联：几个人因同一件事（一起做的事、同一场天气、同一条新闻）各自提了一句，互不复述，评论区里彼此串门',
    '- 完全不相关各自独立：单纯是各过各的生活切片，互不知情，评论区偶尔有人串场但话题不接续',
  ].join('\n'),
  forum_echo: [
    '[版式参考 · 前后隔空呼应，非必须]',
    '不同帖子/不同楼层可以互相"隔空"呼应，不必是同一帖内的直接回复：',
    '- 新帖可以影射/接梗前几天某个热帖，却不必点名是哪一条',
    '- 同一个常驻小号在不同帖子里的说话习惯、立场保持一致，让眼熟的老读者认得出"又是这人"',
    '- 某帖里被玩坏的梗，过几天在毫不相关的版块里被人顺手玩一次',
    '没有合适呼应点时正常发帖即可，不要为了呼应而生硬关联。',
  ].join('\n'),
  single_timeline: [
    '[版式参考 · 这是TA自己的时间线]',
    '这些动态都出自同一个人，不必强求每条独立完整；可以有几条明显是同一晚/同一件事的连续碎碎念（情绪递进），也可以是完全不相干的不同天心情，别每条都工整地各自成篇。',
  ].join('\n'),
};

/**
 * 只有明确要公开聊天内容时，主动发帖链路才允许使用聊天记录形态。
 */
export function socialIntentExplicitlyRequestsChatTranscript(value = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return /(?:晒|贴|发|放|公开|截).{0,10}(?:聊天记录|聊天截图|对话截图|对话记录|聊天内容|这段对话)|(?:聊天记录|聊天截图|对话截图|对话记录|聊天内容|这段对话).{0,10}(?:晒|贴|发|放|公开)|把.{0,8}(?:刚才那段|这段聊天|这段对话).{0,8}(?:发出去|晒出去|贴出去)/u.test(text);
}

/**
 * 社交生成通用前置指导：人设与人物关系优先于任何版式/参考，版式只决定形状。
 * @param {'moments'|'weibo'|'forum'|'anon_space'|'anon_wall'} surface
 */
export function buildSocialFormatGuidancePrompt(surface = 'moments') {
  const label = SOCIAL_FORMAT_LABELS[surface] || '内容';
  const shape = surface === 'forum'
    ? SOCIAL_SHAPE_BLOCKS.forum_echo
    : surface === 'anon_space'
      ? SOCIAL_SHAPE_BLOCKS.single_timeline
      : (surface === 'anon_wall' ? '' : SOCIAL_SHAPE_BLOCKS.multi_author);
  return [
    '[生成前置 · 人设与关系优先，形状与来源仅供参考]',
    `人物设定、人物关系、当下语境永远优先于下面这套参考；参考只决定这批${label}"长成什么样"，不能为了凑形式而让角色 OOC 或强行关联——宁可平淡也不能失真。`,
    `下笔前先想清楚这批${label}整体更贴近谁的人设、大致长成哪种形状（如适用）、内容主要来自哪块，再动笔，前后保持一致。`,
    `每条内容动笔前用一次「换个人设说这句话/这条${label}是否也成立」自检：成立就重写到只有这个人会这么说、这么写；个性强度以人设为上限，温和角色依然温和。`,
    shape,
    SOCIAL_SOURCE_BALANCE_BLOCK,
  ].filter(Boolean).join('\n');
}

export async function buildSocialGenerationExtraPrompt(user = null, options = {}) {
  const stickersOnly = !!options.stickersOnly;
  const stickerBlock = await buildSocialNarrativeGuidancePrompt({
    ...options,
    allowStickers: options.allowStickers !== false,
  });
  if (stickersOnly) {
    return stickerBlock;
  }
  return `${buildSocialHardRulesPrompt(user)}\n\n${stickerBlock}`;
}
