/**
 * 社交生成（朋友圈/微博）用的「角色近期真实生活素材」：
 * 把日程主题、旅行归来、真实刷到过的内容这些零散信息按角色收拢成几行短素材，
 * 让发圈/发博能引用 TA 真实过的日子，而不是每次凭空编生活。
 *
 * 时效是硬规则：每条素材都带相对时间标注，过期来源直接不进素材
 * （旅行/线下见面 14 天、刷到的内容 3 天、日程只取今昨两天、站内微博批次 48 小时）——
 * 半个月前的事被写成"刚发生"比没有素材更伤体验。
 *
 * 只读汇总，不写任何状态；任何一路来源失败都静默跳过，绝不阻塞生成主流程。
 */
import * as db from './db.js';
import { loadCharacterPhone, dateKeyFromTimestamp } from './character-phone-store.js';
import { collectCharacterPhoneCurrentContext } from './character-phone-current-context.js';
import { resolveCharacterScheduleTimezone } from './chat/chat-timezone.js';
import { listTravelCharTrips } from './travel-char.js';
import { listOfflineDateArchives } from './offline-date-archive.js';
import { listVerifiedPosts, listRecentBriefings, isLowQualityPooledPost } from './interest-search-orchestrator.js';
import { formatWeiboGlobalPostHeadline } from './weibo/weibo-memory-sync.js';
import { loadWeiboMetaCompat } from './weibo/weibo-meta-store.js';

const TRAVEL_FRESH_MS = 14 * 86400000;
const OFFLINE_DATE_FRESH_MS = 14 * 86400000;
const VERIFIED_POST_FRESH_MS = 3 * 86400000;
const BRIEFING_FRESH_MS = 3 * 86400000;
const WEIBO_BATCH_FRESH_MS = 48 * 3600000;

function clean(value = '', max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function daysAgoLabel(ts, now) {
  const days = Math.floor((now - Number(ts || 0)) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${days}天前`;
}

/**
 * 单个角色的生活素材行（每行自带相对时间），最多 6 行。
 * @returns {Promise<string[]>}
 */
export async function collectCharacterLifeMaterial(userId, characterId, { now = Date.now() } = {}) {
  const uid = String(userId || '').trim();
  const cid = String(characterId || '').trim();
  if (!uid || !cid) return [];
  const lines = [];

  // 日程只提供一个“此刻片段”和一个已结束的昨日回顾，绝不把未来安排整段塞进动态素材。
  try {
    const [phone, timeZone] = await Promise.all([
      loadCharacterPhone(uid, cid),
      resolveCharacterScheduleTimezone(uid, cid).catch(() => ''),
    ]);
    const current = await collectCharacterPhoneCurrentContext({
      userId: uid,
      characterId: cid,
      phone,
      now,
      timeZone,
    }).catch(() => null);
    if (current?.effective?.source === 'offline') {
      lines.push('此刻正在进行未公开的私下线下活动（只用于禁止把角色写到别处；不得公开地点、同行人、活动内容或私下细节，也不要求发动态）');
    } else if (current?.effective?.source === 'runtime') {
      lines.push(`此刻有效状态：${clean(current.effective.activity, 60)}（短时事实，到期后不可继续沿用；可以只当语气背景，不必主动分享）`);
    } else if (current?.effective?.source === 'schedule' && current.effective.activity) {
      const place = clean(current.effective.place, 24);
      lines.push(`今天此刻的日程片段：${clean(current.effective.activity, 60)}${place ? `@${place}` : ''}（只代表当前片段，不是整日日程；未来步骤不可写成已经发生）`);
    }
    const yesterdayKey = dateKeyFromTimestamp(now - 86400000, timeZone);
    const yesterday = (phone?.dailyLifePlans || []).find((plan) => plan?.dateKey === yesterdayKey);
    if (yesterday) {
      const acts = (Array.isArray(yesterday.blocks) ? yesterday.blocks : [])
        .filter((block) => block && block.isSleep !== true)
        .map((block) => clean(block.activity, 28))
        .filter(Boolean)
        .slice(0, 2)
        .join('、');
      const theme = clean(yesterday.dayTheme, 30);
      if (theme || acts) lines.push(`昨天已结束的生活片段：${theme}${acts ? `（${acts}）` : ''}（只能回顾，且不必主动分享）`);
    }
  } catch (_) { /* 静默跳过 */ }
  // 近两周已归来的旅行（已结束事实，只能当回顾/晒图素材，不能写成正在旅行）
  try {
    const trips = (await listTravelCharTrips(uid, cid))
      .filter((t) => t?.status === 'returned' && now - Number(t.returnedAt || t.updatedAt || 0) < TRAVEL_FRESH_MS)
      .sort((a, b) => Number(b.returnedAt || 0) - Number(a.returnedAt || 0))
      .slice(0, 2);
    for (const t of trips) {
      const when = daysAgoLabel(t.returnedAt || t.updatedAt, now);
      const place = [clean(t.city, 16), clean(t.title || t.theme, 24)].filter(Boolean).join('·');
      const memo = clean(t.memoryText || t.returnSummary, 60);
      lines.push(`${when}旅行归来：${place}${memo ? `——${memo}` : ''}（已结束，只能当回顾）`);
    }
  } catch (_) { /* 静默跳过 */ }

  // 近两周的线下见面档案（和 user 或多人线下约会/一起玩；已发生，只能当回忆素材）
  try {
    const dates = (await listOfflineDateArchives(uid, { characterId: cid }))
      .filter((d) => now - Number(d.endedAt || d.startedAt || 0) < OFFLINE_DATE_FRESH_MS)
      .sort((a, b) => Number(b.endedAt || 0) - Number(a.endedAt || 0))
      .slice(0, 2);
    for (const d of dates) {
      const when = daysAgoLabel(d.endedAt || d.startedAt, now);
      const place = clean(d.scene?.place || d.scene?.goal, 20);
      const memo = clean(d.summary, 60);
      lines.push(`${when}线下见了面${place ? `（${place}）` : ''}${memo ? `：${memo}` : ''}（已发生；发动态只能当"和朋友出门/约饭"式的模糊回忆，不点名对方、不复述私下对话细节）`);
    }
  } catch (_) { /* 静默跳过 */ }

  // 最近 3 天真实刷到并细看过的内容（发"看了个东西有感"类动态的素材；低质量旧存货剔除）
  try {
    const posts = (await listVerifiedPosts(uid, cid))
      .filter((p) => p.depth === 'read' && p.title
        && now - Number(p.foundAt || 0) < VERIFIED_POST_FRESH_MS
        && !isLowQualityPooledPost(p))
      .slice(0, 2);
    for (const p of posts) {
      lines.push(`${daysAgoLabel(p.foundAt, now)}刷到并细看过：《${clean(p.title, 40)}》${clean(p.summary, 50)}`);
    }
  } catch (_) { /* 静默跳过 */ }

  // 最近沉淀的兴趣简报标题（TA 最近在关注/研究什么）
  try {
    const briefs = (await listRecentBriefings(cid, 3))
      .filter((b) => now - Number(b.updatedAt || b.createdAt || 0) < BRIEFING_FRESH_MS)
      .slice(0, 2);
    for (const b of briefs) {
      lines.push(`最近在关注：${clean(b.name, 30)}`);
    }
  } catch (_) { /* 静默跳过 */ }

  return lines.slice(0, 7);
}

/**
 * 多角色批量收集 + 格式化成注入块（朋友圈/微博生成的 prompt 用）。
 * @param authors Array<{ id, name }>
 */
export async function buildLifeMaterialBlock(userId, authors = [], { now = Date.now(), title = '角色近期真实生活素材' } = {}) {
  const rows = [];
  for (const a of authors.slice(0, 8)) {
    const lines = await collectCharacterLifeMaterial(userId, a?.id, { now }).catch(() => []);
    if (!lines.length) continue;
    rows.push(`[life-owner ownerId=${a?.id}] ${clean(a?.name, 20) || a?.id}：\n${lines.map((l) => `  - ${l}`).join('\n')}`);
  }
  if (!rows.length) return '';
  return [
    `[${title} · 每条已带相对时间 · 过期来源已剔除]`,
    rows.join('\n'),
    '用法：这些只是可选生活背景，不是发动态任务。每条素材严格属于它所在的 ownerId，禁止把 A 的经历改写成 B 的亲历；多人同场也只能写各自确实做过的部分。使用素材时输出 sourceType=life、lifeSourceOwnerId=对应 ownerId；本人第一人称发布时作者必须等于 ownerId，路人/营销号报道时 subjectCharacterId 必须等于 ownerId。角色可以完全不用素材。硬规则：①时间以标注为准，「已结束/昨天」只能回顾，未来步骤不可写成已经发生；②一条动态最多围绕一个素材，禁止日程播报和整日流水账；③关系未到亲密程度时，不要默认向 user 定向报备；④私下线下活动默认不公开地点、同行人和对话；⑤不要照抄素材原文。',
  ].join('\n');
}

/**
 * 未过期的站内微博舆情（热搜+简讯），给朋友圈/论坛生成当公共背景：
 * 朋友圈、论坛和微博是同一个世界，顺着站内热搜发感想/开讨论楼很自然；
 * 超过 48 小时的批次直接丢弃——过气热搜当新鲜事聊是穿帮。
 * audience：'moments'（默认，私人口吻）或 'forum'（吃瓜/讨论楼口吻）。
 */
export async function buildAmbientWeiboMaterialBlock(userId, { now = Date.now(), audience = 'moments' } = {}) {
  try {
    const meta = await loadWeiboMetaCompat(userId);
    const batches = (Array.isArray(meta.globalWeiboBatches) ? meta.globalWeiboBatches : [])
      .filter((b) => b && now - Number(b.ts || 0) < WEIBO_BATCH_FRESH_MS);
    if (!batches.length) return '';
    const trending = [...new Set(batches.flatMap((b) => b.trending || []))].slice(0, 8);
    const news = [...new Set(batches.flatMap((b) => b.news || []))].slice(0, 4);
    // 角色微博原帖摘录只给论坛用：吃瓜楼/搬运讨论楼需要"谁发了什么"这一层，朋友圈用不上还占上下文
    const headlines = audience === 'forum'
      ? [...new Set(
        batches
          .flatMap((b) => b.postHeadlines || [])
          .map(formatWeiboGlobalPostHeadline)
          .filter(Boolean),
      )].slice(0, 6)
      : [];
    if (!trending.length && !news.length && !headlines.length) return '';
    const usage = audience === 'forum'
      ? '用法：这是论坛网友可能看见的公共环境认知，不是本轮任务，也不控制论坛是否更新。只有本轮【主话题来源】明确标为 topicSource=weibo 的帖子才可围绕其中一项展开；其他帖子不得把微博当主线，最多允许一个楼层自然顺带提一句。微博没有更新、素材为空或本轮未选中时，论坛仍须从版块、角色兴趣/剧情与普通生活另开话题。'
      : '用法：朋友圈和站内微博是同一个世界，可以让个别动态顺着这些公共话题发感想/吐槽（用朋友圈的私人口吻，不是转发腔）；多数动态还是该发自己的生活，公共话题最多占一两条，不相关的角色完全不用提。';
    return [
      '[站内微博近况 · 48小时内 · 公共背景]',
      trending.length ? `热搜：${trending.join('、')}` : '',
      news.length ? `简讯：${news.join('；')}` : '',
      headlines.length ? `微博原帖摘录：\n${headlines.map((h) => `  - ${h}`).join('\n')}` : '',
      usage,
    ].filter(Boolean).join('\n');
  } catch (_) {
    return '';
  }
}
