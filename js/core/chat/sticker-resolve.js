import { getRecord } from '../db.js';
import { getCharacter } from '../character-store.js';
import {
  getStickerPack,
  listStickerPacks,
  sanitizeStickerDisplayName,
  normalizeBoundStickerPackIdsFromRow,
  upgradeStickerImageUrl,
} from '../sticker-store.js';
import { createMessage } from '../../models/chat.js';
import {
  EXPRESSION_FREQUENCY_OFF,
  buildExpressionFrequencyInstruction,
  buildExpressionRoundSeed,
  normalizeExpressionFrequency,
  rotateExpressionCandidates,
} from './chat-emote-settings.js';

const STICKER_PACK_CACHE_TTL_MS = 15_000;
let stickerPacksCache = { at: 0, packs: null };

export function invalidateStickerPacksCache() {
  stickerPacksCache = { at: 0, packs: null };
}

async function getCachedStickerPacks() {
  const now = Date.now();
  if (Array.isArray(stickerPacksCache.packs) && now - stickerPacksCache.at < STICKER_PACK_CACHE_TTL_MS) {
    return stickerPacksCache.packs;
  }
  const packs = await listStickerPacks();
  stickerPacksCache = { at: now, packs };
  return packs;
}

export function normalizeStickerBracketText(s) {
  return String(s || '')
    .replace(/\uFF3B/g, '[')
    .replace(/\uFF3D/g, ']');
}

export function parseStickerTagLine(content) {
  const s = normalizeStickerBracketText(String(content || '').trim());
  const head = s.match(/^\[(?:表情包|贴纸)[:：]\s*([^\]]+)\]/);
  if (!head) return null;
  const name = head[1].trim();
  const tail = s.slice(head[0].length).trim();
  const urlM = tail.match(/(?:https?:\/\/[^\s\]\)]+|data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+)/i);
  if (urlM) {
    let url = urlM[0];
    if (/[)\].,;]+$/.test(url)) url = url.replace(/[)\].,;]+$/, '');
    const inlineText = tail.replace(urlM[0], '').trim();
    return { name, url, inlineText };
  }
  return { name, url: '', inlineText: tail };
}

function scoreStickerMatch(sticker, keyword) {
  const norm = (t) => String(t || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  const k = norm(keyword);
  const n = norm(sanitizeStickerDisplayName(sticker.name));
  if (!k || !n) return 0;
  if (n === k) return 100;
  if (n.includes(k)) return 85;
  if (k.includes(n) && n.length >= 2) return 70;
  for (let len = Math.min(6, k.length, n.length); len >= 2; len -= 1) {
    for (let i = 0; i + len <= k.length; i += 1) {
      if (n.includes(k.slice(i, i + len))) return 45 + len;
    }
  }
  return 0;
}

function pickStickerFromPool(pool, salt) {
  if (!pool?.length) return null;
  const s = String(salt || '') + '_' + pool.length + '_' + (pool[0]?.url || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h << 5) - h + s.charCodeAt(i);
  const idx = Math.abs(h) % pool.length;
  return pool[idx];
}

function pickStickerFromPoolDeterministic(pool, keyword) {
  if (!pool?.length) return null;
  let h = 2166136261;
  const s = String(keyword || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return pool[Math.abs(h >>> 0) % pool.length];
}

/**
 * @param {string} keyword
 * @param {Array} allStickers
 * @param {{ fallbackToAll?: boolean }} [options]
 *   fallbackToAll：名称完全对不上时是否仍从整池抽一张。
 *   发送/协议解析可开（总要出一张）；气泡展示应关，避免大图 defer 后被误换成无关表情。
 */
export function resolveStickerUrlByKeyword(keyword, allStickers, options = {}) {
  const kw = String(keyword || '').trim();
  if (!kw || !allStickers?.length) return null;
  const fallbackToAll = options.fallbackToAll !== false;
  const scored = allStickers
    .map((s) => ({ s, sc: scoreStickerMatch(s, kw) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc);
  let pool;
  if (scored.length) {
    const best = scored[0].sc;
    pool = scored.filter((x) => x.sc === best).map((x) => x.s);
  } else if (fallbackToAll) {
    pool = [...allStickers];
  } else {
    return null;
  }
  const found = pickStickerFromPoolDeterministic(pool, kw);
  if (!found?.url) return null;
  return {
    url: upgradeStickerImageUrl(found.url),
    name: sanitizeStickerDisplayName(found.name || kw),
  };
}

/**
 * 社交生成偶尔会把 `[表情包:名称]` 漏成 `[名称]`。裸方括号兼容必须只接受库内
 * 精确名称，不能沿用关键词模糊匹配，否则普通动作描写可能被误换成无关图片。
 */
export function resolveStickerUrlByExactName(keyword, allStickers) {
  const normalize = (value) => sanitizeStickerDisplayName(value)
    .normalize('NFKC')
    .trim();
  const target = normalize(keyword);
  if (!target || target === '表情' || !Array.isArray(allStickers)) return null;
  const exact = allStickers.filter((sticker) => normalize(sticker?.name || '') === target);
  if (!exact.length) return null;
  const found = pickStickerFromPoolDeterministic(exact, target);
  if (!found?.url) return null;
  return {
    url: upgradeStickerImageUrl(found.url),
    name: sanitizeStickerDisplayName(found.name || target),
  };
}

export function resolveStickerBubbleImageUrl(msg, stickerPool) {
  if (!msg || msg.type !== 'sticker') return '';
  const metaUrl = String(msg.metadata?.url || '').trim();
  const content = String(msg.content || '').trim();
  const isImg = (s) => {
    const t = String(s || '').trim();
    return t && /^(https?:\/\/|data:image\/)/i.test(t);
  };
  if (isImg(metaUrl)) return upgradeStickerImageUrl(metaUrl);
  if (isImg(content)) return upgradeStickerImageUrl(content);
  if (msg.metadata?.bareStickerPlaceholder === true && Array.isArray(stickerPool) && stickerPool.length) {
    const fallback = pickStickerFromPoolDeterministic(stickerPool, `${msg.id || ''}|${msg.chatId || ''}|bare-sticker`);
    if (fallback?.url) return upgradeStickerImageUrl(fallback.url);
  }
  const nameFromMeta = String(msg.metadata?.stickerName || msg.metadata?.sticker || '').trim();
  const stickerId = String(msg.metadata?.stickerId || '').trim();
  const packId = String(msg.metadata?.packId || '').trim();
  const packName = String(msg.metadata?.packName || '').trim();
  const exactLibraryHit = (Array.isArray(stickerPool) ? stickerPool : []).find((sticker) => {
    const candidateId = String(sticker?.id || '').trim();
    const candidatePackId = String(sticker?.packId || '').trim();
    const candidatePackName = String(sticker?.pack || sticker?.packName || '').trim();
    const candidateName = sanitizeStickerDisplayName(sticker?.name || '');
    if (stickerId) return candidateId === stickerId && (!packId || candidatePackId === packId);
    if (!nameFromMeta) return false;
    if (packId) return candidatePackId === packId && candidateName === sanitizeStickerDisplayName(nameFromMeta);
    return !!packName && candidatePackName === packName && candidateName === sanitizeStickerDisplayName(nameFromMeta);
  });
  if (exactLibraryHit?.url) return upgradeStickerImageUrl(exactLibraryHit.url);
  if (stickerId || packId) return '';
  if (packName && nameFromMeta) {
    // 旧消息没有稳定 ID；分组后来改名时，仅在全库名称唯一的情况下兜底。
    // 同名超过一个就保持占位，不能随机换成别的图。
    const exactName = sanitizeStickerDisplayName(nameFromMeta);
    const uniqueNameHits = (Array.isArray(stickerPool) ? stickerPool : [])
      .filter((sticker) => sanitizeStickerDisplayName(sticker?.name || '') === exactName);
    if (uniqueNameHits.length === 1 && uniqueNameHits[0]?.url) {
      return upgradeStickerImageUrl(uniqueNameHits[0].url);
    }
    return '';
  }
  const pl = parseStickerTagLine(content);
  const keyword = nameFromMeta || (pl?.name ? String(pl.name).trim() : '');
  if (keyword && stickerPool?.length) {
    // 展示解析：必须名称对得上，禁止「对不上就整池抽一张」把历史气泡换成错图
    const r = resolveStickerUrlByKeyword(keyword, stickerPool, { fallbackToAll: false });
    if (r?.url) return upgradeStickerImageUrl(r.url);
  }
  return '';
}

/**
 * 延迟媒体消息若暂时无法从 messages 表取回大图，按稳定表情 / 分组身份回表情库补图。
 * 仍复用展示侧的精确匹配规则，不会拿同名或随机表情冒充原图。
 */
export async function resolveStickerMessageImageFromLibrary(msg) {
  if (!msg || msg.type !== 'sticker') return '';
  const resolver = await buildStickerPoolResolverForMessages([msg]);
  const pool = resolver.poolForMessage(msg);
  return resolveStickerBubbleImageUrl(msg, pool);
}

export async function getAllStickersFlat() {
  const packs = await getCachedStickerPacks();
  return packs.flatMap((p) => (p.stickers || []).map((s) => ({ ...s, pack: p.name, packId: p.id })));
}

export async function getBoundStickerPackIdsForCharacter(actorId, userId = '') {
  const id = String(actorId || '').trim();
  if (!id || id === 'user' || id === 'system') return [];
  const row = await getCharacter(id, { userId: String(userId || '').trim() }).catch(() => null);
  return normalizeBoundStickerPackIdsFromRow(row);
}

function buildStickerFlatListForBoundPackIds(packs, boundPackIds) {
  const ids = [...new Set((boundPackIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) return [];
  const out = [];
  const seenStickerIds = new Set();
  for (const pid of ids) {
    const pack = packs.find((p) => p.id === pid);
    if (!pack) continue;
    const pn = String(pack?.name || '').trim() || '已绑定分组';
    for (const s of pack.stickers || []) {
      const sid = String(s.id || '');
      if (sid && seenStickerIds.has(sid)) continue;
      if (sid) seenStickerIds.add(sid);
      out.push({ ...s, pack: pn, packId: pack.id });
    }
  }
  return out;
}

function buildStickerFlatListForAllPacks(packs) {
  return (packs || []).flatMap((p) => (p.stickers || []).map((s) => ({ ...s, pack: p.name, packId: p.id })));
}

export async function getStickerPoolForMessageResolve(senderId, userId = '') {
  const packs = await getCachedStickerPacks();
  const id = String(senderId || '').trim();
  if (id === 'user') return buildStickerFlatListForAllPacks(packs);
  if (!id || id === 'system') return [];
  const boundIds = await getBoundStickerPackIdsForCharacter(senderId, userId);
  if (!boundIds.length) return [];
  return buildStickerFlatListForBoundPackIds(packs, boundIds);
}

export async function buildStickerPoolResolverFromMessageSenders(senderIdsFromMessages) {
  const packs = await getCachedStickerPacks();
  const full = buildStickerFlatListForAllPacks(packs);
  const uniq = [
    ...new Set(
      (senderIdsFromMessages || [])
        .map((id) => String(id || '').trim())
        .filter((id) => id && id !== 'user' && id !== 'system'),
    ),
  ];
  const charRows = await Promise.all(uniq.map((id) => getRecord('characters', id).catch(() => null)));
  const boundIdsOf = new Map(uniq.map((id, i) => [id, normalizeBoundStickerPackIdsFromRow(charRows[i])]));
  const bySender = new Map();
  for (const sid of uniq) {
    const boundIds = boundIdsOf.get(sid) || [];
    bySender.set(sid, boundIds.length ? buildStickerFlatListForBoundPackIds(packs, boundIds) : []);
  }
  return {
    full,
    poolForMessage(msg) {
      const sid = String(msg?.senderId || '').trim();
      if (!sid || sid === 'user' || sid === 'system') return full;
      const bound = bySender.get(sid) || [];
      // 展示用：角色未绑定分组时回退全库，避免历史「只有名字」的气泡永久停在「[表情]」。
      // 发送/协议解析仍走 getStickerPoolForMessageResolve（未绑定 = 空池，不会误发）。
      return bound.length ? bound : full;
    },
  };
}

/**
 * 首屏补图优先按消息里保存的 packId 精确读取相关分组。只有旧消息缺少稳定分组
 * 身份时才回退整库，避免一条缺图表情让上千 URL 全部进入聊天页内存。
 */
export async function buildStickerPoolResolverForMessages(messages = []) {
  const stickerMessages = (Array.isArray(messages) ? messages : []).filter((message) => message?.type === 'sticker');
  const packIds = [...new Set(stickerMessages
    .map((message) => String(message?.metadata?.packId || '').trim())
    .filter(Boolean))];
  const hasUnscopedMessage = stickerMessages.some((message) => {
    const directUrl = String(message?.metadata?.url || message?.content || '').trim();
    if (/^(?:https?:\/\/|data:image\/)/i.test(directUrl)) return false;
    return !String(message?.metadata?.packId || '').trim();
  });
  if (!packIds.length || hasUnscopedMessage) {
    return buildStickerPoolResolverFromMessageSenders(stickerMessages.map((message) => message?.senderId));
  }

  const packs = (await Promise.all(packIds.map((id) => getStickerPack(id)))).filter(Boolean);
  const full = buildStickerFlatListForAllPacks(packs);
  const bySender = new Map();
  for (const message of stickerMessages) {
    const senderId = String(message?.senderId || '').trim();
    const packId = String(message?.metadata?.packId || '').trim();
    if (!senderId || !packId) continue;
    const pack = packs.find((row) => String(row?.id || '') === packId);
    if (!pack) continue;
    const current = bySender.get(senderId) || [];
    const next = buildStickerFlatListForBoundPackIds([pack], [packId]);
    bySender.set(senderId, [...current, ...next]);
  }
  return {
    full,
    poolForMessage(message) {
      const senderId = String(message?.senderId || '').trim();
      return bySender.get(senderId) || full;
    },
  };
}

export async function resolveStickerMessage(text, chatId, senderId, senderName, options = {}) {
  const trimmed = String(text || '').trim();
  const parsed = parseStickerTagLine(trimmed);
  if (parsed?.url) {
    return createMessage({
      chatId,
      senderId,
      senderName,
      type: 'sticker',
      content: parsed.url,
      metadata: {
        stickerName: sanitizeStickerDisplayName(parsed.name),
        url: parsed.url,
        packName: '',
        ...(String(parsed.inlineText || '').trim() ? { inlineText: String(parsed.inlineText).trim() } : {}),
      },
    });
  }
  const m = trimmed.match(/^\[(?:表情包|贴纸)[:：]\s*([^\]]+)\]\s*(.*)$/s)
    || trimmed.match(/^\[sticker:([^\]]+)\]/i);
  const bare = !m ? trimmed.match(/^\[(?:表情包|贴纸)\]\s*(.*)$/s) : null;
  const keyword = String(parsed?.name || m?.[1] || (bare ? '表情' : '')).trim();
  const trailingText = String((parsed ? parsed.inlineText : (m?.[2] ?? bare?.[1])) || '').trim();
  if (!keyword) return null;

  const all = await getStickerPoolForMessageResolve(senderId, options.userId);
  if (!all.length) return null;

  const scored = all
    .map((s) => ({ s, sc: scoreStickerMatch(s, keyword) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc);

  let pool;
  if (scored.length) {
    const best = scored[0].sc;
    pool = scored.filter((x) => x.sc === best).map((x) => x.s);
  } else {
    pool = [...all];
  }

  const salt = `${keyword}|${chatId}|${senderId}|${senderName}|${performance.now()}|${Math.random()}`;
  const found = pickStickerFromPool(pool, salt);
  if (!found?.url) return null;

  return createMessage({
    chatId,
    senderId,
    senderName,
    type: 'sticker',
    content: found.url,
    metadata: {
      stickerName: sanitizeStickerDisplayName(found.name || keyword),
      url: found.url,
      stickerId: String(found.id || '').trim(),
      packId: String(found.packId || '').trim(),
      packName: found.pack || '',
      inlineText: trailingText,
    },
  });
}

export function collectRecentStickerNames(messages = [], actorId = '', maxItems = 8) {
  const wantedActor = String(actorId || '').trim();
  const found = [];
  const seen = new Set();
  const rows = Array.isArray(messages) ? messages : [];
  for (let index = rows.length - 1; index >= 0 && found.length < maxItems; index -= 1) {
    const message = rows[index];
    if (!message || message.deleted || message.recalled || String(message.type || '') !== 'sticker') continue;
    if (wantedActor && String(message.senderId || '').trim() !== wantedActor) continue;
    const name = sanitizeStickerDisplayName(
      message.metadata?.stickerName || message.metadata?.sticker || parseStickerTagLine(message.content)?.name || '',
    );
    if (!name || seen.has(name)) continue;
    seen.add(name);
    found.push(name);
  }
  return found;
}

/** 注入系统提示：本地表情包名称列表，供 AI 写 sticker 事件或 [表情包:名称] */
export async function buildStickerAliasPromptSection(arg = 72) {
  let maxNames = 72;
  let restrictToCharacterId = '';
  let groupCharacterIds = [];
  let recentMessages = [];
  let rotationSeed = '';
  let frequency = 'normal';
  let userId = '';
  if (typeof arg === 'number' && Number.isFinite(arg)) {
    maxNames = arg;
  } else if (arg && typeof arg === 'object') {
    maxNames = Number(arg.maxNames);
    if (!Number.isFinite(maxNames) || maxNames < 1) maxNames = 72;
    restrictToCharacterId = String(arg.restrictToCharacterId || '').trim();
    groupCharacterIds = Array.isArray(arg.groupCharacterIds)
      ? arg.groupCharacterIds.map((id) => String(id || '').trim()).filter((id) => id && id !== 'user' && id !== 'system')
      : [];
    recentMessages = Array.isArray(arg.recentMessages) ? arg.recentMessages : [];
    rotationSeed = String(arg.rotationSeed || '').trim();
    frequency = normalizeExpressionFrequency(arg.frequency);
    userId = String(arg.userId || '').trim();
  }
  if (frequency === EXPRESSION_FREQUENCY_OFF) return '';
  const packs = await getCachedStickerPacks();
  const baseSeed = rotationSeed || buildExpressionRoundSeed(recentMessages, '', 'sticker');
  const formatList = (stickers, limit, actorId = '') => {
    const uniq = [...new Set((stickers || []).map((s) => sanitizeStickerDisplayName(s.name)).filter(Boolean))];
    const recent = collectRecentStickerNames(recentMessages, actorId, 8);
    const selection = rotateExpressionCandidates(uniq, {
      seed: `${baseSeed}|${actorId || 'shared'}`,
      recentValues: recent,
      limit,
    });
    return {
      total: uniq.length,
      names: selection.names,
      cooled: selection.cooled,
      more: selection.omitted,
    };
  };
  const frequencyInstruction = buildExpressionFrequencyInstruction(frequency, '表情包');

  const uniqGroupIds = [...new Set(groupCharacterIds)];
  if (uniqGroupIds.length) {
    const rows = [];
    const perActorLimit = Math.max(12, Math.floor(maxNames / Math.max(1, uniqGroupIds.length)));
    for (const actorId of uniqGroupIds) {
      const boundIds = await getBoundStickerPackIdsForCharacter(actorId, userId);
      if (!boundIds.length) continue;
      const pool = buildStickerFlatListForBoundPackIds(packs, boundIds);
      const list = formatList(pool, perActorLimit, actorId);
      if (!list.total) continue;
      rows.push({ actorId, list });
    }
    if (!rows.length) return '';
    return (
      '\n[角色表情包权限 · 表达工具箱]\n'
      + '只有下列角色可输出 sticker，name 必须用本角色行内的准确名称；未列出的角色不发 sticker 也不借用别人的。\n'
      + `${frequencyInstruction}\n`
      + '表情包只用于表达情绪、接梗或斗图，不是照片、自拍、文字卡或生成画面；用户要生成新画面时，不能拿表情包代替。\n'
      + '表情包是活人聊天的一部分：可以参与接梗、被戳中后的反应、加码与收尾，但不能成为跳过本轮真实回应的捷径。用法视具体人设与【回复节奏 · 错落】——网感角色可连发；稳重角色也可为了配合对方主动试一张（可能笨拙、有点不好意思）；连发细则见下文协议 sticker 条。\n'
      + rows.map(({ actorId, list }) => (
        `from=${actorId} 本轮可用（总库 ${list.total}）：${list.names.join('、')}${list.more ? `（其余 ${list.more} 个会在后续轮次轮换）` : ''}`
        + (list.cooled.length ? `；近期已用、当前冷却：${list.cooled.join('、')}` : '')
      )).join('\n')
    );
  }

  let packRows = [];
  let packTitle = '本角色表情包';
  if (restrictToCharacterId) {
    const boundIds = await getBoundStickerPackIdsForCharacter(restrictToCharacterId, userId);
    if (!boundIds.length) return '';
    const selectedPacks = boundIds.map((bid) => packs.find((p) => p.id === bid)).filter(Boolean);
    const nonEmpty = selectedPacks.filter((p) => (Array.isArray(p.stickers) ? p.stickers : []).length);
    if (!nonEmpty.length) return '';
    packRows = nonEmpty;
    const packNames = nonEmpty.map((p) => String(p.name || '').trim() || '分组').join('、');
    packTitle = nonEmpty.length === 1
      ? `本角色表情包（分组「${packNames}」）`
      : `本角色表情包（已绑定 ${nonEmpty.length} 个分组：${packNames}）`;
  } else {
    return '';
  }
  const names = [];
  for (const p of packRows) {
    for (const s of p.stickers || []) {
      names.push(sanitizeStickerDisplayName(s.name));
    }
  }
  const uniq = [...new Set(names)];
  if (!uniq.length) return '';
  const selection = rotateExpressionCandidates(uniq, {
    seed: `${baseSeed}|${restrictToCharacterId}`,
    recentValues: collectRecentStickerNames(recentMessages, restrictToCharacterId, 8),
    limit: maxNames,
  });
  const list = selection.names;
  const more = selection.omitted
    ? `\n（其余 ${selection.omitted} 个会在后续轮次轮换，不会永久排除）`
    : '';
  const cooldown = selection.cooled.length
    ? `\n- 近期已使用、当前冷却：${selection.cooled.join('、')}。除非正在连续斗图或复读本身就是梗，本轮不要重复。`
    : '';
  return (
    `\n[${packTitle} · 表达工具箱]\n`
    + `${frequencyInstruction}\n`
    + '本轮轮换名单（name 必须完全等于其一）：\n'
    + list.map((n) => `· ${n}`).join('\n')
    + more
    + cooldown
    + '\n- 表情包只用于表达情绪、接梗或斗图，不是照片、自拍、文字卡或生成画面；用户要生成新画面时，不能拿表情包代替。'
    + '\n- 表情包是这个角色的表达方式之一，不是装饰：接梗收尾、被戳中（害羞/心虚/嘴硬）不想打字、无话可接但不想冷场、纯粹想戳对方一下——这些时刻发一个表情往往比硬憋一句话更像活人。'
    + '\n- 表情包可以参与接梗、加码与收尾，但不能成为跳过本轮真实回应的捷径；一轮是否使用、怎样连发，以人设与【回复节奏 · 错落】为准，细则见下文协议 sticker 条。'
    + '\n- 对方长时间没回消息时，粘人/外向型角色可以拿表情包单方面戳一戳（想念类表情单发或连发）；克制型角色则不会这么做。'
    + '\n- 风格跟人设走：网感年轻角色可以高频玩梗连发；长辈/沉稳角色平时不爱刷，但对方在用表情包或气氛适合时，可以为了配合主动试一张——发得笨拙、害羞、甚至跟一句找补都比硬憋着像活人。依旧以具体人设为准：人设明确讨厌表情包的就别硬发。'
    + '\n- 硬约束：想不起准确名称、或想表达的情绪名单里没有，改用 msg/react，不要编造名称，也不要把 [表情包:xx] 写进 msg.body。'
  );
}
