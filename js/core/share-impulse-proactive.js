/**
 * 分享冲动的专属主动消息通道：不依赖「日程主动消息」是否有活跃日程块，也不依赖用户自己
 * 发消息或聊天自动推进——只要冲动激活（随机窗口 / 已读不回破冰 / 分享间隔兜底）且手里确实
 * 有能分享的东西，就单独拉起一轮对话，directive 只服务于「找机会分享」这一件事，不跟日程
 * 内容混在一起抢模型的注意力。
 *
 * 跟日程主动消息（character-phone-proactive.js）是两条独立通道，可能在同一个角色身上都配置了；
 * 靠「最近是否已有角色消息」的守卫 + 每角色冷却，避免两条通道前后脚各打一轮消息。
 */
import { listCharacters } from './character-store.js';
import { getCharacterAiContextName } from '../models/character.js';
import { ensureDefaultUser, getUserById } from './user-slot.js';
import { findPrivateChat, listMessagesForChat } from './chat-store.js';
import { getPacingNowForUser } from './time-mode.js';
import { get as dbGet, put as dbPut } from './db.js';
import {
  getShareImpulseForNow, resolveShareImpulseTarget, noteShareImpulseInjected, consumeShareImpulse,
  loadShareImpulseSettings,
} from './share-impulse.js';
import { shouldSuppressAiDelivery } from './chat-block-state.js';
import { computeCharacterSelfAbsenceGapMs, buildSelfAbsenceDirective, buildProactiveAntiRepeatDirective } from './chat-helpers.js';
import { isCharacterAutonomyMutedNow } from './character-autonomy-settings.js';

const CHECK_INTERVAL_MS = 20 * 60 * 1000; // 20 分钟探测一次，实际会不会发消息看冲动状态
const MIN_GAP_MS = 60 * 60 * 1000; // 同一个角色两次专属分享消息之间至少间隔 1 小时
const RECENT_AI_GUARD_MS = 5 * 60 * 1000; // 最近 5 分钟内角色刚发过消息就先让一让，避免撞车
const CATCH_UP_MAX_CHARACTERS = 3;
const TIMER_MAX_CHARACTERS = 16;

let _running = false;

export function buildShareImpulseProactiveStateKey(userId, characterId) {
  return `shareImpulseProactive_${encodeURIComponent(String(userId || '').trim())}_${encodeURIComponent(String(characterId || '').trim())}`;
}

async function hasRecentCharacterAiMessage(chatId, characterId, now) {
  if (!chatId || !characterId) return false;
  const recent = await listMessagesForChat(chatId, 12).catch(() => []);
  return recent.some((msg) => (
    msg
    && !msg.deleted
    && !msg.recalled
    && String(msg.senderId || '') === String(characterId || '')
    && msg.metadata?.aiGenerated
    && now - Number(msg.timestamp || 0) >= 0
    && now - Number(msg.timestamp || 0) < RECENT_AI_GUARD_MS
  ));
}

function cleanText(v, max = 160) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const SOURCE_OPENING = {
  xiaohongshu: '刷小红书',
  weibo: '刷微博',
  bilibili: '刷B站',
  web: '上网搜东西',
};

/**
 * 专属通道自己拼完整指令：不再依赖常规聊天上下文里的「TA 现在有点想分享」块带实际内容
 * （那块已经删除，分享彻底不进常规上下文），标题/链接/摘要必须在这里原样带上，模型才有
 * 东西可分享，而不是靠一句「上文提到的内容」空话去接一个根本不存在的上文。
 *
 * 这条指令只规定「这轮真正要做成的事」和「内容必须真实」，其余（消息条数、要不要交代由头、
 * 能不能多聊两句、聊完还能不能接别的）全部让位给常规聊天规则——分享链接应该跟平时聊天里
 * 随手甩个链接一样自然，不是一套单独收紧的格式。
 */
export function buildShareOnlyDirective(name, target) {
  const isSocial = target.kind === 'user_social';
  // user_social 素材本来就不发链接（那是对方自己发的），所以这条 directive 不能沿用
  // verified_post 那套"把链接分享出去"的目标措辞，否则会把模型往"必须甩个链接完成任务"的
  // 生硬开场上推，跟"不动声色接话/顺嘴提一句"的实际诉求脱节。
  const motivationSceneDirective = [
    '节奏和格式跟平时聊天完全一样：按角色人设和下面的输出协议自然发挥；消息条数、长短与分段先服从本会话已经开启的气泡范围和短气泡设置，未设置的部分再由内容与角色说话习惯决定，不额外压成一两条短消息。',
    isSocial
      ? '这轮真正要完成的只有一件事——把下面这个由头自然地聊起来；但过程可以很松散：可以先接住对方没被回应的话、聊几句别的日常，把话题自然地放进对话里的某一步，不必一开口就提，提完也不必立刻收尾——对方追问就多聊几句，对方没接话也不用硬憋着不说话。'
      : '这轮真正要完成的只有一件事——把下面这条链接分享出去；但过程可以很松散：可以先接住对方没被回应的话、聊几句别的日常，把链接自然地放进对话里的某一步，不必一开口就甩链接，分享完也不必立刻收尾——对方追问就多聊几句，对方没接话也不用硬憋着不说话。',
    isSocial
      ? '交代由头（比如刚好想起/刷到什么）只是可选的调味，不是必须出现的台词：想到更贴角色口吻的说法就换着说，想不出来就直接跳过来源交代，别把这次开口写成上次说过的同一种固定句式（比如反复用"看到你发的xx了"这句开场）。'
      : '"刚刷手机/上网看到"这类交代来源的话只是可选的调味，不是必须出现的台词：想到更贴角色口吻的说法就换着说，想不出来就直接跳过来源交代，把链接甩过去、带一句自己的真实反应即可，不要每次都用"刷到/看到"开头把它写成固定句式。',
    isSocial
      ? ''
      : '链接卡发出后，可以继续说这个角色独有的评价、联想到对方的原因、具体槽点或顺手的问题；把真实想法说成立，再按【回复节奏 · 错落】自然分条，不要同义复述，也不要为了凑数改写或再发一次 URL。',
    '先结合「角色手机日程」和此刻情绪，弄清这件事为什么偏偏触动 TA、为什么此刻想到这个人。没说出口的感受或联想放进 state.inner；角色自己已经意识到的“想给 TA 看”“想听 TA 怎么说”“先不告诉 TA”这类小心思放进 intent。两者都用角色自己的自然语气，不写成动机分析，也不强求在可见消息里交代由头。',
  ].join('\n');

  let contentBlock;
  if (isSocial) {
    const title = cleanText(target.title, 60);
    contentBlock = target.secret
      ? `这次想自然带到的由头：user 自己发布的小红书内容《${title}》。披露方式是「偷偷关注」——绝对不能暴露自己看过对方主页、不能说"我看到你发的xx了"这类话，只能不动声色地把相关话题自然聊起来，显得心有灵犀，不说破从哪知道的。`
      : `这次想自然带到的由头：user 自己发布的小红书内容《${title}》。披露方式是「光明正大」——可以提起自己在关注对方主页，"看到你发的xx了"只是其中一种说法，不必当成固定开场白，也可以换成更贴当下语境的说法；不用发链接（那是对方自己发的）。`;
  } else {
    const title = cleanText(target.title, 60);
    const summary = cleanText(target.summary, 160);
    const opening = SOURCE_OPENING[target.source] || '刷手机';
    const reasonHint = target.reason ? `（当初觉得它值得看的理由：${cleanText(target.reason, 80)}，可以参考语气但不用照搬措辞）` : '';
    contentBlock = [
      '这次要分享的实际内容——标题/链接/摘要必须照抄，不能编造或改写：',
      `标题：${title}`,
      summary ? `摘要：${summary}` : '',
      `url=${target.url}`,
      `场景参考（仅供你判断语气/心里知道，不是必须交代的台词，可以完全不提）：大概是"${opening}"的时候看到的。${reasonHint}`,
      `分享方式：{"t":"link","from":"角色id","url":"${target.url}","title":"${title}","desc":"一句话摘要"}，url 必须和上面完全一致，不能改写或编造；也可以不发这个事件，直接把上面这个 url 原样贴进 msg.body 里，系统会自动识别成链接卡片。禁止只写"[分享链接]"这类占位文字——那不会变成真正的卡片，用户只会看到一句占位符。`,
    ].filter(Boolean).join('\n');
  }

  return [
    '[主动分享由头]',
    isSocial
      ? `现在是 ${name} 想主动找对方聊点什么的时机（冲动信号已经激活：可能是随手想起、也可能是有一阵子没主动提过了/对方晾了挺久没回，想找由头破冰）。跟平时聊天一样看完整上下文接话，该接的话先接住、想聊别的小事也可以聊，只是这一轮最主要想做成的事是把下面这个由头自然聊起来。`
      : `现在是 ${name} 想主动找对方分享点什么的时机（冲动信号已经激活：可能是随手想起、也可能是有一阵子没主动分享了/对方晾了挺久没回，想找由头破冰）。跟平时聊天一样看完整上下文接话，该接的话先接住、想聊别的小事也可以聊，只是这一轮最主要想做成的事是把这条链接分享出去。`,
    contentBlock,
    motivationSceneDirective,
  ].join('\n\n');
}

function visibleChronological(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && !message.deleted && !message.recalled && !message.metadata?.aiPlaceholder)
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

export function findUnansweredCharacterShare(messages = [], characterId = '') {
  const cid = String(characterId || '').trim();
  if (!cid) return null;
  const list = visibleChronological(messages);
  let shareIndex = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (String(message.senderId || '') !== cid || message.type !== 'link') continue;
    const url = cleanText(message.metadata?.url || message.metadata?.href || message.content, 500);
    if (!url) continue;
    shareIndex = i;
    break;
  }
  if (shareIndex < 0) return null;
  if (list.slice(shareIndex + 1).some((message) => String(message.senderId || '') === 'user')) return null;
  const share = list[shareIndex];
  return {
    id: String(share.id || `${cid}:${Number(share.timestamp || 0)}`),
    timestamp: Number(share.timestamp || 0),
    url: cleanText(share.metadata?.url || share.metadata?.href || share.content, 500),
    title: cleanText(share.metadata?.title || share.metadata?.siteName || '', 80),
    summary: cleanText(share.metadata?.summary || share.metadata?.desc || share.metadata?.description || '', 180),
  };
}

export function resolvePriorShareFollowUpState({
  messages = [],
  characterId = '',
  now = Date.now(),
  coldReplyHours = 6,
  handledShareId = '',
} = {}) {
  const share = findUnansweredCharacterShare(messages, characterId);
  if (!share) return { status: 'none', share: null };
  if (handledShareId && String(handledShareId) === share.id) return { status: 'handled', share };
  const coldMs = Math.max(1, Number(coldReplyHours || 6)) * 60 * 60 * 1000;
  if (!share.timestamp || Number(now) - share.timestamp < coldMs) return { status: 'waiting', share };
  return { status: 'due', share };
}

export function buildPriorShareFollowUpDirective(name, share) {
  const title = cleanText(share?.title, 80);
  const summary = cleanText(share?.summary, 180);
  return [
    '[主动跟进之前的分享]',
    `${name} 之前分享的链接一直没有收到 user 回应。现在已经隔了一段自然的冷场时间，这轮围绕那次分享继续聊，不分享新内容。`,
    [
      title ? `之前分享的标题：${title}` : '',
      summary ? `之前分享的摘要：${summary}` : '',
      share?.url ? `之前的 URL（仅用于辨认上下文，禁止再次输出）：${share.url}` : '',
    ].filter(Boolean).join('\n'),
    '按角色本人的表达欲、关系距离、当前心情和说话习惯选择新的角度：可以轻轻补一句，也可以补充具体看法、解释为什么想到对方、挑一个细节继续聊，或自然岔出相关话题；不强制高信息量，条数按【回复节奏 · 错落】决定，也不要为了克制而预先截断。不要套固定情绪，也不要替 user 的沉默下结论。',
    '本轮禁止输出 link 事件、禁止再次粘贴旧 URL，也禁止寻找或分享另一条 URL。只用 msg 讨论旧链接；没有真正的新角度时不要同义复述，有新内容时也不要预先压短。',
  ].join('\n\n');
}

async function runForCharacter(user, character, now, reason = '') {
  const characterId = String(character?.id || '').trim();
  if (!characterId) return { skipped: true, reason: 'missing-character' };
  const { loadResolvedCharacterAutonomyPolicy } = await import('./character-autonomy-settings.js');
  const policy = await loadResolvedCharacterAutonomyPolicy(user.id, characterId).catch(() => null);
  if (policy?.totalEnabled !== true) {
    return { characterId, skipped: true, reason: 'proactive-disabled' };
  }
  if (await isCharacterAutonomyMutedNow(user.id, characterId, now)) {
    return { characterId, skipped: true, reason: 'mute-hours' };
  }
  try {
    const { isCharacterBusyInOfflineSession } = await import('./character-phone-proactive.js');
    if (await isCharacterBusyInOfflineSession(user.id, characterId)) {
      return { characterId, skipped: true, reason: 'active-offline-session' };
    }
  } catch (_) { /* 线下态读不到时不阻塞 */ }

  const chat = await findPrivateChat(user.id, characterId).catch(() => null);
  if (!chat?.id) return { characterId, skipped: true, reason: 'no-chat' };

  const proactiveKey = buildShareImpulseProactiveStateKey(user.id, characterId);
  const state = (await dbGet(proactiveKey).catch(() => null))?.value || {};
  // 负差（lastFiredAt 落在 now 之后，如时间债追平完成后节奏钟回落）按冷却已过处理。
  const sinceLastFired = now - Number(state.lastFiredAt || 0);
  if (state.lastFiredAt && sinceLastFired >= 0 && sinceLastFired < MIN_GAP_MS) {
    return { characterId, skipped: true, reason: 'cooldown' };
  }

  const impulse = await getShareImpulseForNow(user.id, characterId, now).catch(() => null);
  if (!impulse?.activeNow) return { characterId, skipped: true, reason: 'not-active' };

  const recentForDirective = await listMessagesForChat(chat.id, 30).catch(() => []);
  const settings = await loadShareImpulseSettings(user.id, characterId).catch(() => ({ coldReplyHours: 6 }));
  const followUpState = resolvePriorShareFollowUpState({
    messages: recentForDirective,
    characterId,
    now,
    coldReplyHours: settings.coldReplyHours,
    handledShareId: state.lastFollowedUpShareId,
  });
  let followUpShare = null;
  let target = null;
  if (followUpState.share) {
    if (followUpState.status === 'handled') {
      return { characterId, skipped: true, reason: 'share-follow-up-already-sent' };
    }
    if (followUpState.status !== 'due') {
      return { characterId, skipped: true, reason: 'awaiting-share-reply' };
    }
    followUpShare = followUpState.share;
    target = { kind: 'share_follow_up', id: followUpShare.id };
  } else {
    target = await resolveShareImpulseTarget(user.id, characterId, impulse).catch(() => null);
    if (!target) return { characterId, skipped: true, reason: 'no-target' };
  }

  const blocked = await shouldSuppressAiDelivery(chat).catch(() => ({ blocked: false }));
  if (blocked?.blocked) return { characterId, skipped: true, reason: 'blocked-by-user' };

  if (await hasRecentCharacterAiMessage(chat.id, characterId, now)) {
    return { characterId, skipped: true, reason: 'recent-ai-message' };
  }

  const { getCharacterProactiveUsageStatus, recordProactiveOutcome } = await import('./character-proactive-usage.js');
  const proactiveUsage = await getCharacterProactiveUsageStatus(user.id, characterId, now).catch(() => null);
  if (proactiveUsage && proactiveUsage.remaining <= 0) {
    await recordProactiveOutcome({
      userId: user.id,
      characterId,
      chatId: chat.id,
      channel: 'share-impulse',
      status: 'skipped',
      reason: 'daily-limit-reached',
      now,
    }).catch(() => {});
    return { ok: false, skipped: true, reason: 'daily-limit-reached', characterId };
  }

  const name = getCharacterAiContextName(character) || character?.name || 'TA';
  const selfGapMs = computeCharacterSelfAbsenceGapMs(recentForDirective, characterId, now);
  const selfAbsenceDirective = buildSelfAbsenceDirective(selfGapMs);
  const antiRepeatDirective = buildProactiveAntiRepeatDirective(recentForDirective, characterId);
  const sceneDirective = [
    followUpShare
      ? buildPriorShareFollowUpDirective(name, followUpShare)
      : buildShareOnlyDirective(name, target),
    selfAbsenceDirective,
    antiRepeatDirective,
  ].filter(Boolean).join('\n\n');
  const { runHeadlessChatReply } = await import('./chat/headless-reply.js');
  const result = await runHeadlessChatReply(chat, user, {
    allowInactive: true,
    sceneDirective,
    skipBusyAutoReply: true,
    reason: 'share-impulse-proactive',
    proactiveChannel: 'share-impulse',
    proactiveIdempotencyKey: `${characterId}:${target?.id || target?.url || now}`,
  }).catch((err) => ({ ok: false, reason: err?.message || String(err || 'failed') }));

  const bridgedOfflineReturn = result?.offlineReturnBridge === true;
  if (!bridgedOfflineReturn) {
    // 返线上承接轮只借用这次触发时机，不得把原分享素材记成已经注入或消费。
    await noteShareImpulseInjected(user.id, characterId, target).catch(() => {});
    if (target.kind === 'user_social') {
      await consumeShareImpulse(user.id, characterId).catch(() => {});
    }
  }

  if (!bridgedOfflineReturn) {
    await dbPut({
      key: proactiveKey,
      value: {
        ...state,
        lastFiredAt: now,
        lastStatus: result?.ok ? 'ok' : (result?.reason || 'failed'),
        ...(result?.ok && followUpShare ? { lastFollowedUpShareId: followUpShare.id } : {}),
      },
    }).catch(() => {});
  }

  if (result?.ok) {
    if (!bridgedOfflineReturn && followUpShare) {
      await consumeShareImpulse(user.id, characterId).catch(() => {});
    }
    const {
      bumpPersistedMessagesUnread,
      notifyCharacterSentMessageIfEnabled,
      shouldNotifyForBackgroundReason,
    } = await import('./native-notifications.js');
    if (shouldNotifyForBackgroundReason(reason, chat.id)) {
      await bumpPersistedMessagesUnread(chat.id, result.messages).catch(() => {});
      await notifyCharacterSentMessageIfEnabled({
        characterName: name,
        chatId: chat.id,
        tag: `share-impulse-proactive-${characterId}`,
        messages: result.messages,
        requireHidden: false,
        avatar: character?.avatar || '',
      }).catch(() => {});
    }
    try {
      const [{ collectOfflineState }, { maybeRunOfflineAutoReply }] = await Promise.all([
        import('./character-phone-proactive.js'),
        import('./offline-auto-reply.js'),
      ]);
      const offlineState = await collectOfflineState(user.id);
      if (offlineState.active) {
        await maybeRunOfflineAutoReply({
          user,
          chat,
          characterId,
          incomingMessages: result.messages || [],
          activeOffline: offlineState.active,
        });
      }
    } catch (err) {
      console.warn('[share-impulse-proactive] offline auto reply failed', err);
    }
  }
  return { characterId, generated: !!result?.ok, result };
}

export async function runShareImpulseProactiveCheck({ user: suppliedUser = null, userId = '', reason = '' } = {}) {
  if (_running) return { ok: false, reason: 'in-flight' };
  _running = true;
  try {
    const requestedUserId = String(userId || suppliedUser?.id || '').trim();
    const user = suppliedUser
      || (requestedUserId ? await getUserById(requestedUserId) : null)
      || await ensureDefaultUser();
    if (!user?.id) return { ok: false, reason: 'missing-user' };
    // 节奏钟：时间债追平期间不冻结，冷却/活跃时段判断照常推进。
    const now = await getPacingNowForUser(user.id);
    const characters = await listCharacters({
      userId: user.id,
      identityScoped: true,
      excludeAnonNpc: true,
    }).catch(() => []);
    const isCatchUp = /^catch-up:/i.test(String(reason || ''));
    const maxCharacters = isCatchUp ? CATCH_UP_MAX_CHARACTERS : TIMER_MAX_CHARACTERS;
    const results = [];
    let fired = 0;
    for (const character of characters) {
      if (fired >= maxCharacters) break;
      // eslint-disable-next-line no-await-in-loop
      const r = await runForCharacter(user, character, now, reason);
      results.push(r);
      if (r?.generated) fired += 1;
    }
    return { ok: true, reason, results };
  } finally {
    _running = false;
  }
}

export { CHECK_INTERVAL_MS as SHARE_IMPULSE_PROACTIVE_CHECK_MS };
