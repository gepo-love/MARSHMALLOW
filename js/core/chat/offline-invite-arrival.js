/**
 * 角色已经走到见面地点、但模型只发了普通 msg 时，确定性补齐 arrived 邀约事件。
 *
 * 这里只识别严格完成态；“快到了 / 在路上 / 等我到了”仍交给正常聊天，不提前打开线下入口。
 */

const ARRIVAL_NEGATION_RE = /(还没到|尚未到|没到(?:呢|啊|呀|达)?|未到|到不了|不会到|不去|别来|不要来|不用来)/i;
const ARRIVAL_FUTURE_RE = /(?:(?:等|等到|如果|要是|明天|后天|待会(?:儿)?|一会(?:儿)?|过会(?:儿)?|下班后|放学后).{0,12}(?:我)?(?:到|抵达))|(?:(?:我)?(?:快|马上|就快|就要|准备|正要).{0,8}(?:到|抵达|出门|过去))/i;
const ARRIVAL_PAST_RE = /(?:昨天|前天|上次|之前|那天|刚才还说).{0,16}(?:到(?:了|达)|在.{0,6}(?:门口|楼下))/i;
const ARRIVAL_QUOTE_RE = /(?:(?:他|她|它|ta|朋友|同事|司机).{0,8}(?:说|问|发来|告诉)|(?:转发|引用|截图|原话)).{0,24}(?:我到了|在.{0,8}(?:门口|楼下))/i;
const ORDINARY_DESTINATION_RE = /(?:我)?(?:已经|刚刚|刚|现在)?\s*到(?:家|公司|学校|宿舍|酒店|机场|车站|单位|办公室)(?:了|啦|咯|喽)?/i;

const DIRECT_USER_PLACE_RE = /(?:我\s*)?(?:已经|刚刚|刚|现在|这会儿|终于)?\s*(?:到|在)(?:你(?:家|公司|学校|小区|宿舍)?(?:楼下|门口)|你那(?:边|儿)?|你这里)(?:了|啦|呢|咯|喽)?/i;
const DIRECT_DOOR_RE = /(?:我(?:已经|刚刚|刚)?\s*)?(?:来开门|给我开门|开下门|开门呀|敲门了|按门铃了)/i;
const AGREED_PLACE_ARRIVAL_RE = /(?:我\s*)?(?:已经|刚刚|刚|现在|终于)?\s*(?:到|在)(?:约定(?:的)?(?:地点|地方)|我们约的(?:地点|地方)|老地方|见面地点)(?:了|啦|呢|咯|喽)?/i;
const BARE_ARRIVAL_RE = /(?:^|[，,。.!！?？\s])(?:我\s*)?(?:已经|刚刚|刚|现在|终于)?\s*(?:到(?:了|啦|咯|喽)|抵达了)(?:[，,。.!！?？\s]|$)/i;

const MEETING_PROPOSAL_RE = /(见面|碰面|见一面|出来(?:玩|吃饭|喝咖啡|走走)?|一起(?:吃饭|看电影|逛街|散步|喝咖啡)|约会|我去找你|来找你|去接你|来接你|门口见|楼下见|待会见|一会见)/i;
const MEETING_ACCEPT_RE = /^(?:好|好啊|好呀|可以|行|行啊|行呀|没问题|那就这样|说定了|约好了|来吧|你来吧|过来吧|我等你|等你|待会见|一会见)[！!。.，,\s]*$/i;
const MEETING_ACCEPT_PREFIX_RE = /^(?:好|好啊|好呀|可以|行|行啊|行呀|没问题|那就这样|说定了|约好了)[！!。.，,\s]*/i;
const MEETING_REJECT_RE = /(不想见|不见面|别见|不要见|别约|不要约|没空见|改天再说|别来|不要来|不用来)/i;
const EXPLICIT_AGREEMENT_RE = /(说定了|约好了|待会见|一会见|门口见|楼下见|你来吧|过来吧|来我这|我等你|到了告诉我)/i;
const MEETING_APPROACH_RE = new RegExp([
  '(?:我)?(?:已经|刚刚|刚|现在|这会儿)?\\s*(?:在路上|正在过去|正往.{0,12}(?:走|赶|过去)|往你那(?:边|儿)?(?:走|赶|过去))',
  '(?:我)?(?:快|马上|就快|就要)\\s*(?:到|抵达)(?:了)?',
  '(?:还有|大概|差不多)?\\s*(?:\\d{1,2}|[一二三四五六七八九十]+)\\s*分钟(?:左右)?(?:.{0,8})(?:到|抵达|见)',
].join('|'), 'i');
const ORDINARY_TRAVEL_RE = /(回家|去(?:公司|学校|宿舍|医院|药店|超市|商场|上班|买药|买东西|取快递|办事)|帮.{0,8}(?:买|取|送))/i;
const ARRIVAL_SOUND_EFFECT_ONLY_RE = /^(?:[（(\[【]\s*)?(?:叮(?:咚|铃)?|咚咚?|砰砰?|笃笃|当当|滴滴|门铃(?:响|声)?|敲门(?:声)?|按门铃|ding(?:\s*dong)?|knock(?:\s*knock)?)(?:\s*[）)\]】])?[\s~～!！。.…·]*$/iu;

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function eventActor(event = {}) {
  return clean(event.from || event.actor || event.senderId);
}

function historyActor(message = {}) {
  return clean(message.senderId || message.from || message.actor);
}

function visibleHistory(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && !message.deleted && !message.recalled && message.type !== 'system');
}

export function classifyStrictOfflineArrivalText(value = '') {
  const text = clean(value);
  if (!text
    || ARRIVAL_NEGATION_RE.test(text)
    || ARRIVAL_FUTURE_RE.test(text)
    || ARRIVAL_PAST_RE.test(text)
    || ARRIVAL_QUOTE_RE.test(text)
    || ORDINARY_DESTINATION_RE.test(text)) {
    return { arrived: false, directToUserPlace: false };
  }
  const directToUserPlace = DIRECT_USER_PLACE_RE.test(text) || DIRECT_DOOR_RE.test(text);
  const arrived = directToUserPlace
    || AGREED_PLACE_ARRIVAL_RE.test(text)
    || BARE_ARRIVAL_RE.test(text);
  return { arrived, directToUserPlace };
}

export function classifyOfflineMeetingApproachText(value = '') {
  const text = clean(value);
  if (!text
    || classifyStrictOfflineArrivalText(text).arrived
    || ARRIVAL_NEGATION_RE.test(text)
    || ARRIVAL_PAST_RE.test(text)
    || ARRIVAL_QUOTE_RE.test(text)
    || ORDINARY_DESTINATION_RE.test(text)
    || ORDINARY_TRAVEL_RE.test(text)) {
    return false;
  }
  return MEETING_APPROACH_RE.test(text);
}

export function isPureOfflineArrivalSoundEffect(value = '') {
  return ARRIVAL_SOUND_EFFECT_ONLY_RE.test(clean(value));
}

export function sanitizeOfflineArrivalNote(value = '', fallback = '我到了') {
  const text = clean(value).slice(0, 160);
  if (!text || isPureOfflineArrivalSoundEffect(text)) return clean(fallback) || '我到了';
  return text;
}

export function sanitizeOfflineArrivalEvents(events = []) {
  const list = Array.isArray(events) ? events : [];
  const arrivedActors = new Set(list
    .filter((event) => event?.t === 'offline_invite' && event.arrived === true)
    .map(eventActor)
    .filter(Boolean));
  if (!arrivedActors.size) return list;
  return list.flatMap((event) => {
    const actorId = eventActor(event);
    if (event?.t === 'msg'
      && arrivedActors.has(actorId)
      && isPureOfflineArrivalSoundEffect(event.body)) {
      return [];
    }
    if (event?.t === 'offline_invite' && event.arrived === true) {
      return [{
        ...event,
        note: sanitizeOfflineArrivalNote(event.note || event.activity, '我到了'),
      }];
    }
    return [event];
  });
}

export function hasRecentOfflineMeetingAgreement(messages = []) {
  const recent = visibleHistory(messages).slice(-12);
  if (!recent.length) return false;
  const latestUser = [...recent].reverse().find((message) => historyActor(message) === 'user');
  if (MEETING_REJECT_RE.test(clean(latestUser?.content))) return false;
  if (recent.some((message) => EXPLICIT_AGREEMENT_RE.test(clean(message.content)))) return true;

  for (let i = 0; i < recent.length; i += 1) {
    const proposal = recent[i];
    const proposalText = clean(proposal?.content);
    if (!proposalText || !MEETING_PROPOSAL_RE.test(proposalText)) continue;
    const proposer = historyActor(proposal);
    const accepted = recent.slice(i + 1).some((message) => (
      historyActor(message)
      && historyActor(message) !== proposer
      && (MEETING_ACCEPT_RE.test(clean(message.content))
        || (MEETING_ACCEPT_PREFIX_RE.test(clean(message.content))
          && MEETING_PROPOSAL_RE.test(clean(message.content))))
    ));
    if (accepted) return true;
  }
  return false;
}

function latestOfflineInviteForActor(messages = [], actorId = '') {
  const actor = clean(actorId);
  return [...visibleHistory(messages)].reverse().find((message) => {
    if (message?.type !== 'offlineInvite') return false;
    const md = message.metadata || {};
    const initiator = clean(md.initiatorId || message.senderId);
    return !actor || initiator === actor;
  }) || null;
}

function inviteIsNearTail(messages = [], inviteMessage = null, distance = 4) {
  if (!inviteMessage?.id) return false;
  return visibleHistory(messages).slice(-Math.max(1, Number(distance) || 4))
    .some((message) => message?.id === inviteMessage.id);
}

function nextSourceIndex(events = []) {
  return (Array.isArray(events) ? events : []).reduce(
    (max, event) => Math.max(max, Number(event?.sourceIndex) || 0),
    -1,
  ) + 1;
}

function inferMeetingTimeLabel(text = '') {
  return clean(text).match(/(?:今天|今晚|明天|明晚|后天|周末|下班后|放学后|待会(?:儿)?|一会(?:儿)?|现在|此刻)/)?.[0] || '';
}

function inferMeetingActivity(text = '') {
  return clean(text).match(/(?:吃饭|看电影|逛街|散步|喝咖啡|喝一杯|约会|出来玩|见面|碰面)/)?.[0] || '';
}

function buildTransitionEvent({
  actorId,
  text,
  inviteMessage,
  directToUserPlace = false,
  sourceIndex,
  phase = 'agreed',
  accepted = false,
  arrived = false,
}) {
  const md = inviteMessage?.metadata || {};
  const place = clean(md.place);
  return {
    t: 'offline_invite',
    from: actorId,
    invitees: Array.isArray(md.inviteeIds) ? md.inviteeIds.slice(0, 5) : [],
    place,
    activity: clean(md.activity) || inferMeetingActivity(text),
    note: sanitizeOfflineArrivalNote(text, '我到了'),
    timeLabel: arrived ? '此刻' : (clean(md.timeLabel) || inferMeetingTimeLabel(text)),
    tone: clean(md.tone),
    arrived,
    accepted,
    transitionPhase: phase,
    toUserPlace: directToUserPlace || md.toUserPlace === true || (arrived && !place),
    kind: clean(md.kind),
    sourceInviteMessageId: clean(inviteMessage?.id),
    sourceIndex,
    synthesizedOfflineArrival: arrived,
    synthesizedOfflineTransition: !arrived,
  };
}

function buildArrivalEvent(options = {}) {
  return buildTransitionEvent({
    ...options,
    phase: 'arrived',
    accepted: true,
    arrived: true,
  });
}

/**
 * @returns {{ events: object[], repaired: boolean, reason: string }}
 */
export function repairOfflineArrivalEvents(events = [], options = {}) {
  const list = Array.isArray(events) ? events : [];
  if (options.allow !== true || options.activeSession === true) {
    return { events: list, repaired: false, reason: 'disabled' };
  }
  if (list.some((event) => event?.t === 'offline_invite' && event.arrived === true)) {
    return { events: list, repaired: false, reason: 'structured-arrival-exists' };
  }

  const arrivalMessage = [...list].reverse().find((event) => {
    if (event?.t !== 'msg') return false;
    const actorId = eventActor(event);
    return actorId && actorId !== 'user' && classifyStrictOfflineArrivalText(event.body).arrived;
  });
  if (!arrivalMessage) return { events: list, repaired: false, reason: 'no-strict-arrival' };

  const actorId = eventActor(arrivalMessage);
  const arrival = classifyStrictOfflineArrivalText(arrivalMessage.body);
  const latestInvite = latestOfflineInviteForActor(options.messages, actorId);
  const inviteStatus = clean(latestInvite?.metadata?.status || '');
  const inviteFrom = clean(latestInvite?.metadata?.inviteFrom || '');

  if (inviteFrom && inviteFrom !== 'character') {
    return { events: list, repaired: false, reason: 'entry-card-already-actionable' };
  }
  if (['declined', 'fulfilled', 'merged', 'others_went'].includes(inviteStatus)) {
    return { events: list, repaired: false, reason: 'invite-closed' };
  }

  const sameRoundInviteIndex = list.findIndex((event) => (
    event?.t === 'offline_invite' && eventActor(event) === actorId
  ));
  const hasOpenInvite = ['pending', 'shelved'].includes(inviteStatus);
  const hasMeetingContext = sameRoundInviteIndex >= 0
    || hasOpenInvite
    || inviteStatus === 'accepted'
    || hasRecentOfflineMeetingAgreement(options.messages);
  if (!hasMeetingContext) {
    return { events: list, repaired: false, reason: 'missing-meeting-context' };
  }

  // 已经接受的旧卡可能早已滑出可见聊天。明确到场时只在旧卡仍靠近底部时去重，
  // 否则把可进入入口刷新到当前消息旁边，避免用户回翻历史找卡。
  if (inviteStatus === 'accepted' && inviteIsNearTail(options.messages, latestInvite)) {
    return { events: list, repaired: false, reason: 'entry-card-already-nearby' };
  }

  if (sameRoundInviteIndex >= 0) {
    const current = list[sameRoundInviteIndex];
    const upgraded = {
      ...current,
      arrived: true,
      timeLabel: '此刻',
      note: sanitizeOfflineArrivalNote(current.note || arrivalMessage.body, '我到了'),
      toUserPlace: current.toUserPlace === true || arrival.directToUserPlace,
      synthesizedOfflineArrival: true,
    };
    return {
      events: list.map((event, index) => (index === sameRoundInviteIndex ? upgraded : event)),
      repaired: true,
      reason: 'upgraded-round-invite',
    };
  }

  return {
    events: [
      ...list,
      buildArrivalEvent({
        actorId,
        text: arrivalMessage.body,
        inviteMessage: latestInvite,
        directToUserPlace: arrival.directToUserPlace,
        sourceIndex: nextSourceIndex(list),
      }),
    ],
    repaired: true,
    reason: 'synthesized-arrival-card',
  };
}

/**
 * 邀约内容与是否发卡交给模型判断。这里只保留两类确定性保护：
 * - 角色已经明确到达门口/约定地点时，补一个可进入线下的入口；
 * - 模型重复输出仍处于相同阶段的结构化邀约时，阻止重复落卡。
 *
 * 普通提议、双方说定或“正在路上”都不能由关键词自动拼卡，否则会把聊天正文
 * 原样复制成僵硬卡片，并替模型臆造 accepted 状态、地点或路线。
 */
export function repairOfflineInviteTransitionEvents(events = [], options = {}) {
  const arrivalResult = repairOfflineArrivalEvents(events, options);
  if (arrivalResult.repaired) return arrivalResult;

  const list = Array.isArray(arrivalResult.events) ? arrivalResult.events : [];
  if (options.allow !== true || options.activeSession === true) {
    return { events: list, repaired: false, reason: 'disabled' };
  }
  // 模型可能在旧 pending / shelved / accepted 卡仍有效时，又输出一张相同阶段的
  // offline_invite。两句普通聊天不应让邀请重发；只有接受推进或明确到场才保留新事件。
  const duplicateIndexes = new Set();
  list.forEach((event, index) => {
    if (event?.t !== 'offline_invite') return;
    const actorId = eventActor(event);
    const previous = latestOfflineInviteForActor(options.messages, actorId);
    const previousStatus = clean(previous?.metadata?.status || '');
    if (!['pending', 'shelved', 'accepted'].includes(previousStatus)) return;
    const advancesToAccepted = event.accepted === true && previousStatus !== 'accepted';
    if (event.arrived !== true && !advancesToAccepted) duplicateIndexes.add(index);
  });
  if (duplicateIndexes.size) {
    return {
      events: list.filter((_, index) => !duplicateIndexes.has(index)),
      repaired: true,
      reason: 'duplicate-open-invite-suppressed',
    };
  }
  if (list.some((event) => event?.t === 'offline_invite')) {
    return { events: list, repaired: false, reason: 'structured-invite-exists' };
  }
  return { events: list, repaired: false, reason: 'model-controlled-invite' };
}
