function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function messageBody(event = {}) {
  return clean(event.body || event.text || event.content);
}

export function isCompletedInviteClaim(text = '') {
  const value = clean(text);
  if (!value) return false;
  if (/(?:没(?:有)?|还没|尚未|无法|不能|没法|失败|发不了|邀请不了|拉不了).{0,8}(?:邀请|进群|拉你)/u.test(value)) {
    return false;
  }
  return /(?:已经|刚刚|刚才|这就|我(?:给|把)?).{0,10}(?:发(?:了|好)?(?:一?个)?(?:入群)?邀请|邀请(?:发|弄|搞)?(?:好|过去|给你|了)|拉你(?:进群|进来)(?:了|啦)?)/u.test(value)
    || /(?:入群)?邀请.{0,8}(?:发给你了|已经发了|发过去了)/u.test(value);
}

export function claimedGroupName(text = '') {
  const value = clean(text);
  if (!value || /(?:没(?:有)?|还没|尚未|无法|不能|没法|失败).{0,8}(?:改|换).{0,6}(?:群名|名字)/u.test(value)) {
    return '';
  }
  const quoted = value.match(/(?:群名|群聊名字|名字).{0,8}(?:改成|改为|换成|换为|改叫|叫做)\s*[「『“"]([^」』”"\n]{1,40})[」』”"]/u);
  const plain = value.match(/(?:群名|群聊名字|名字).{0,8}(?:改成|改为|换成|换为|改叫|叫做)\s*([^，。！？；\n]{1,40})/u);
  return clean(quoted?.[1] || plain?.[1] || '')
    .replace(/(?:了|啦|呀|哦|哈)$/u, '')
    .slice(0, 40);
}

function groupManagerIds(chat = {}) {
  const participants = Array.isArray(chat?.participants) ? chat.participants : [];
  const settings = chat?.groupSettings || {};
  const owner = clean(settings.owner)
    || (participants.includes('user') ? 'user' : clean(participants.find((id) => id && id !== 'user')));
  return new Set([owner, ...(Array.isArray(settings.admins) ? settings.admins : [])].map(clean).filter(Boolean));
}

/**
 * 模型偶尔会在群里明确说“已经邀请/已经改名”，却漏掉对应隐藏事件。
 * 这里只修复当前群内、语义无歧义且权限真实成立的两种动作，避免出现台词成功、状态没变。
 */
export function groundClaimedGroupActions(events = [], chat = null) {
  const rows = Array.isArray(events) ? [...events] : [];
  if (!chat || chat.type !== 'group') return rows;
  const managers = groupManagerIds(chat);
  const hasInvite = rows.some((event) => event?.t === 'invite_user');
  const hasRename = rows.some((event) => event?.t === 'group_name');
  let inviteAdded = false;
  let renameAdded = false;

  for (const event of rows) {
    if (event?.t !== 'msg') continue;
    const actorId = clean(event.from || event.actor || event.senderId);
    if (!actorId || !(chat.participants || []).includes(actorId)) continue;
    const body = messageBody(event);
    if (!hasInvite
      && !inviteAdded
      && !(chat.participants || []).includes('user')
      && chat.groupSettings?.userTopicPolicy !== 'off'
      && isCompletedInviteClaim(body)) {
      rows.push({ t: 'invite_user', from: actorId, note: '邀请你加入群聊', groundedFromClaim: true });
      inviteAdded = true;
    }
    if (!hasRename && !renameAdded && managers.has(actorId) && chat.groupSettings?.allowAiGroupOps !== false) {
      const name = claimedGroupName(body);
      if (name) {
        rows.push({ t: 'group_name', from: actorId, name, groundedFromClaim: true });
        renameAdded = true;
      }
    }
  }
  return rows;
}

export function isExplicitGroupRenameRequest(message = {}) {
  if (!message || message.deleted || message.recalled) return false;
  const senderId = clean(message.senderId);
  if (senderId !== 'user' && message.metadata?.phoneProxyByUser !== true) return false;
  return /(?:改|换).{0,8}(?:群名|群聊名字)|(?:群名|群聊名字).{0,8}(?:改|换)/u.test(clean(message.content));
}

export function isExplicitGroupManagementRequest(message = {}) {
  if (!message || message.deleted || message.recalled) return false;
  const senderId = clean(message.senderId || message.from);
  if (senderId !== 'user' && message.metadata?.phoneProxyByUser !== true) return false;
  if (isExplicitGroupInviteRequest({ ...message, senderId: 'user' })) return true;
  const text = clean(message.content || message.body || message.text);
  return /(?:改|换).{0,8}(?:群名|群聊名字)|(?:群名|群聊名字).{0,8}(?:改|换)|群公告|群待办|群任务|群头衔|管理员|群主|转让群|移出群|踢出群|拉进群|加进群|邀请.{0,8}进群|禁言|解禁/u.test(text);
}

export function isExplicitGroupInviteRequest(message = {}) {
  if (!message || message.deleted || message.recalled) return false;
  const senderId = clean(message.senderId || message.from);
  if (senderId !== 'user') return false;
  const text = clean(message.content || message.body || message.text);
  return /(?:邀请|拉|加).{0,10}(?:我|user).{0,8}(?:进|加入).{0,8}(?:群|群聊)|(?:把|将).{0,6}(?:我|user).{0,8}(?:拉进|加进|邀请进).{0,8}(?:群|群聊)/u.test(text);
}

export function requestedGroupName(message = {}) {
  if (!message || message.deleted || message.recalled) return '';
  const senderId = clean(message.senderId || message.from);
  if (senderId !== 'user') return '';
  const text = clean(message.content || message.body || message.text);
  const direct = text.match(/(?:群名|群聊名字|群的名字).{0,8}(?:改成|改为|换成|换为|改叫|叫做)\s*[「『“"]?([^」』”"，。！？；\n]{1,40})/u);
  const withTarget = text.match(/(?:把|将).{1,40}?(?:群|群聊).{0,6}(?:改名为|改名成|改成|改为|换成|换为)\s*[「『“"]?([^」』”"，。！？；\n]{1,40})/u);
  return clean(direct?.[1] || withTarget?.[1]).replace(/[」』”"]+$/u, '').trim().slice(0, 40);
}

export function claimedGroupActionTypes(text = '') {
  const value = clean(text);
  if (!value) return [];
  const types = new Set();
  if (claimedGroupName(value)) types.add('group_name');
  if (isCompletedInviteClaim(value)) types.add('invite_user');
  if (!/(?:没|未|失败|不能|无法|还没)/u.test(value)) {
    if (/(?:群公告|公告).{0,12}(?:更新|改好|设好|发好|写好)(?:了|啦)?/u.test(value)) types.add('group_announcement');
    if (/(?:群待办|群任务|待办).{0,12}(?:加好|建好|更新|完成|删掉)(?:了|啦)?/u.test(value)) types.add('group_todo');
    if (/(?:群头衔|头衔).{0,12}(?:设好|改好|加上|取消)(?:了|啦)?/u.test(value)) types.add('group_title');
    if (/(?:群主).{0,12}(?:转给|转让给|换成).{0,20}(?:了|啦)/u.test(value)) types.add('group_transfer');
    if (/(?:管理员).{0,12}(?:设好|加上|取消|撤掉)(?:了|啦)?/u.test(value)) types.add('group_admin');
    if (/(?:拉进群|加进群|邀请进群|移出群|踢出群).{0,12}(?:了|啦)|(?:已经|刚刚).{0,12}(?:拉进|加进|移出|踢出)/u.test(value)) types.add('group_member');
    if (/(?:禁言|解禁).{0,12}(?:了|啦|成功)/u.test(value)) types.add('mute');
  }
  return [...types];
}

const GROUP_ACTION_LABELS = Object.freeze({
  group_name: '修改群名',
  group_announcement: '更新群公告',
  group_todo: '更新群待办',
  group_title: '设置群头衔',
  group_transfer: '转让群主',
  group_admin: '调整管理员',
  group_member: '调整群成员',
  mute: '群禁言',
  vote_close: '结束群投票',
  invite_user: '入群邀请',
});

const GROUP_ACTION_FAILURE_REASONS = Object.freeze({
  ai_group_ops_disabled: ['目标群关闭了“允许 AI 群管事件”', 'settings'],
  group_admin_context_invalid: ['操作所在会话不是可执行的群聊', 'routing'],
  group_invite_user_context_invalid: ['目标群不满足邀请条件，可能你已经在群内或该群禁止邀请', 'state'],
  group_invite_user_declined_cooldown: ['你近期拒绝过这个群的邀请，仍在一天冷却期内', 'cooldown'],
  group_invite_user_skipped: ['邀请人不在目标群内，或已有同一张待处理邀请', 'state'],
  remote_group_operation_invalid: ['模型生成了不受支持的远程群操作', 'protocol'],
  remote_group_target_not_allowed: ['模型使用的目标群不在本轮可操作白名单内，可能群记录已经变化', 'routing'],
  remote_group_target_missing: ['目标群不存在，或已经不再是群聊', 'routing'],
  remote_group_actor_not_member: ['执行角色不在目标群成员列表中', 'state'],
  remote_group_operation_rejected: ['目标群拒绝了这项操作', 'state'],
  cross_window_group_target_ambiguous: ['同时匹配到多个群，无法安全确认应该操作哪一个', 'routing'],
  group_action_cooldown: ['同类群操作刚执行过，仍在防重复冷却期内', 'cooldown'],
  group_action_actor_not_member: ['执行角色不在当前群成员列表中', 'state'],
  group_action_actor_not_manager: ['执行角色不是目标群的群主或管理员', 'permission'],
  group_action_actor_not_owner: ['这项操作只有群主能够执行', 'permission'],
  group_action_target_missing: ['操作缺少明确的目标成员', 'protocol'],
  group_action_target_not_member: ['目标成员不在群内', 'state'],
  group_action_target_protected: ['目标是群主或用户，不能执行这项成员操作', 'permission'],
  group_action_name_missing: ['没有提供有效的新群名', 'protocol'],
  group_action_todo_missing: ['没有提供有效的群待办内容', 'protocol'],
  group_action_todo_not_found: ['没有找到要更新的群待办', 'state'],
  group_action_member_already_present: ['目标成员已经在群内', 'state'],
  group_action_member_target_not_allowed: ['目标成员不在本轮允许邀请的联系人范围内', 'permission'],
  group_action_member_social_boundary: ['目标成员之间没有可用的关系网授权', 'permission'],
  group_action_member_action_invalid: ['成员操作类型无效', 'protocol'],
  group_action_vote_not_found: ['没有找到仍可结束的群投票', 'state'],
  group_action_vote_permission_denied: ['执行角色既不是投票发起人，也不是群管理', 'permission'],
});

function collectGroupActionFailureCodes(receipts = [], failedClaims = []) {
  const codes = [];
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    const code = clean(receipt?.code);
    if (code) codes.push(code);
    for (const nested of Array.isArray(receipt?.context?.failureCodes) ? receipt.context.failureCodes : []) {
      const nestedCode = clean(nested);
      if (nestedCode) codes.push(nestedCode);
    }
  }
  for (const claim of Array.isArray(failedClaims) ? failedClaims : []) {
    const code = clean(claim?.code);
    if (code) codes.push(code);
  }
  return [...new Set(codes)];
}

export function describeGroupActionFailure({
  receipts = [],
  failedClaims = [],
  attemptedTypes = [],
  failedCount = 1,
} = {}) {
  const codes = collectGroupActionFailureCodes(receipts, failedClaims);
  const matchedCode = codes.find((code) => GROUP_ACTION_FAILURE_REASONS[code]);
  const [reason, category] = GROUP_ACTION_FAILURE_REASONS[matchedCode]
    || ['应用没有记录到更具体的失败原因', 'internal'];
  const labels = [...new Set((Array.isArray(attemptedTypes) ? attemptedTypes : [])
    .map((type) => GROUP_ACTION_LABELS[clean(type)])
    .filter(Boolean))];
  const actionLabel = labels.length === 1 ? labels[0] : '群操作';
  const count = Math.max(1, Number(failedCount) || 1);
  return {
    message: `${count > 1 ? `有 ${count} 项群操作` : actionLabel}未生效：${reason}。群资料保持原状。`,
    reason,
    category,
    codes,
  };
}

export function shouldSurfaceGroupActionFailure({
  explicitRequest = false,
  claimedTypes = [],
  failedClaims = [],
  attemptedTypes = [],
} = {}) {
  if (explicitRequest === true || (Array.isArray(failedClaims) && failedClaims.length > 0)) return true;
  const attempted = new Set(Array.isArray(attemptedTypes) ? attemptedTypes : []);
  return (Array.isArray(claimedTypes) ? claimedTypes : []).some((type) => attempted.has(type));
}

/** 群操作失败时不允许继续显示“已经改好/已经发出”这类成功台词。 */
export function reconcileGroupActionClaimMessages(messages = [], options = {}) {
  const failedByIndex = new Map((Array.isArray(options.failedClaims) ? options.failedClaims : [])
    .map((item) => [Number(item?.messageIndex), clean(item?.type)]));
  const renameAttempted = options.renameAttempted === true;
  const inviteAttempted = options.inviteAttempted === true;
  const renameSucceeded = options.renameSucceeded === true;
  const inviteSucceeded = options.inviteSucceeded === true;
  const attemptedTypes = new Set(Array.isArray(options.attemptedTypes) ? options.attemptedTypes : []);
  const succeededTypes = new Set(Array.isArray(options.succeededTypes) ? options.succeededTypes : []);
  return (Array.isArray(messages) ? messages : []).map((message, index) => {
    const body = clean(message?.content || message?.body);
    const failedType = failedByIndex.get(index);
    const renameFailed = (failedType === 'group_name')
      || (renameAttempted && !renameSucceeded && !!claimedGroupName(body));
    const inviteFailed = (failedType === 'invite_user')
      || (inviteAttempted && !inviteSucceeded && isCompletedInviteClaim(body));
    const otherFailed = claimedGroupActionTypes(body)
      .find((type) => !['group_name', 'invite_user'].includes(type)
        && attemptedTypes.has(type)
        && !succeededTypes.has(type));
    if (!renameFailed && !inviteFailed && !otherFailed) return message;
    const content = renameFailed && inviteFailed
      ? '我刚试了，群资料和邀请都还没有操作成功。'
      : (renameFailed
        ? '我刚试了，群名还没有改成功。'
        : (inviteFailed ? '我刚试了，邀请还没有发出去。' : '我刚试了，这项群操作还没有成功。'));
    return { ...message, content, body: content };
  });
}
