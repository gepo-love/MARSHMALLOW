import { ensureLuckyRedPacketSplits, splitLuckyRedPacketYuan } from './card-render.js';

const AI_REDPACKET_FALLBACK_AMOUNTS = ['18.88', '28.88', '38.88', '52.00', '66.66', '88.88'];
let aiRedpacketFallbackCursor = 0;

function nextAiRedPacketFallbackAmount() {
  const value = AI_REDPACKET_FALLBACK_AMOUNTS[aiRedpacketFallbackCursor % AI_REDPACKET_FALLBACK_AMOUNTS.length];
  aiRedpacketFallbackCursor += 1;
  return value;
}

function yuan(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0.00';
  return v.toFixed(2);
}

function parseYuan(raw, fallback = 0) {
  const v = parseFloat(String(raw ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(v) ? v : fallback;
}

export function normalizePacketCount(raw, fallback = 1) {
  const n = Math.max(1, Math.min(100, Math.round(Number(raw) || fallback)));
  return n;
}

/** 用户 / AI 发红包时的 metadata 归一化 */
export function buildRedPacketSendMetadata({
  amount = '',
  count = 1,
  greeting = '恭喜发财',
  mode = '',
  isGroup = false,
} = {}) {
  const amt = String(amount || '').trim();
  const cnt = isGroup ? normalizePacketCount(count, 1) : 1;
  const g = String(greeting || '恭喜发财').trim() || '恭喜发财';
  let redpacketMode = String(mode || '').trim().toLowerCase();
  if (!redpacketMode) {
    redpacketMode = isGroup && cnt > 1 ? 'lucky' : 'normal';
  }
  const lucky = redpacketMode === 'lucky' && cnt > 1;
  return {
    title: lucky ? '拼手气红包' : '红包',
    redpacketMode: lucky ? 'lucky' : 'normal',
    greeting: g,
    amount: lucky ? '' : amt,
    totalAmount: lucky ? amt : (isGroup ? amt : ''),
    packetCount: String(cnt),
    packetState: 'pending',
    claimRecords: {},
    luckyGrabs: {},
    luckySplits: [],
  };
}

/** AI redpacket 事件 → metadata */
export function buildAiRedPacketMetadata(event = {}, { isGroup = false } = {}) {
  // 弱模型漏填金额时使用轮换兜底，避免每次都落成同一个 8.88。
  // 正常情况下金额仍完全服从事件本身。
  const amount = String(event.amount || event.total || nextAiRedPacketFallbackAmount()).trim();
  const count = normalizePacketCount(event.count || event.packetCount || (isGroup ? 3 : 1), isGroup ? 3 : 1);
  const mode = String(event.mode || '').trim().toLowerCase();
  const greeting = String(event.greeting || event.body || '恭喜发财').trim() || '恭喜发财';
  return buildRedPacketSendMetadata({ amount, count, greeting, mode, isGroup });
}

export function getClaimRecords(msg = {}) {
  const md = msg.metadata || {};
  const records = md.claimRecords && typeof md.claimRecords === 'object' ? { ...md.claimRecords } : {};
  const legacy = md.luckyGrabs && typeof md.luckyGrabs === 'object' ? md.luckyGrabs : {};
  for (const [id, amt] of Object.entries(legacy)) {
    if (!records[id]) {
      records[id] = { amount: yuan(amt), at: Number(md.claimRecords?.[id]?.at || 0) || 0 };
    }
  }
  return records;
}

/**
 * 用已经落库的领取系统消息补齐红包卡片记录。
 *
 * 旧版本在角色连续抢红包、或用户打开旧快照后领取时，可能把较新的
 * claimRecords 覆盖掉；系统消息仍然保留了领取人和金额，可作为恢复依据。
 */
export function reconcileRedPacketClaimNotices(msg = {}, messages = []) {
  if (!msg?.id || msg.type !== 'redpacket') return { message: msg, changed: false };
  const records = getClaimRecords(msg);
  const luckyGrabs = { ...(msg.metadata?.luckyGrabs || {}) };
  let changed = false;
  for (const notice of Array.isArray(messages) ? messages : []) {
    const meta = notice?.metadata || {};
    const sourceId = String(meta.sourceFinanceMessageId || meta.sourceMessageId || '').trim();
    const financeEvent = String(meta.financeEvent || '').trim();
    const claimerId = String(meta.claimerId || '').trim();
    if (sourceId !== String(msg.id)
      || !['redpacket_claimed', 'redpacket_grabbed'].includes(financeEvent)
      || !claimerId
      || records[claimerId]) continue;
    const amount = yuan(meta.amount || 0);
    records[claimerId] = {
      amount,
      at: Number(notice.timestamp || meta.claimedAt || 0) || 0,
      name: String(meta.claimerName || notice.senderName || '').trim(),
    };
    if (msg.metadata?.redpacketMode === 'lucky') luckyGrabs[claimerId] = amount;
    changed = true;
  }
  if (!changed) return { message: msg, changed: false };
  const repaired = ensureLuckyRedPacketSplits({
    ...msg,
    metadata: {
      ...(msg.metadata || {}),
      claimRecords: records,
      luckyGrabs,
    },
  });
  return { message: repaired, changed: true };
}

export function listClaimEntries(msg = {}, resolveName) {
  const records = getClaimRecords(msg);
  return Object.entries(records)
    .map(([id, rec]) => ({
      id,
      amount: yuan(rec?.amount ?? rec),
      at: Number(rec?.at || 0) || 0,
      name: typeof resolveName === 'function' ? resolveName(id) : (id === 'user' ? '我' : id),
    }))
    .sort((a, b) => (a.at || 0) - (b.at || 0));
}

export function hasClaimed(msg = {}, participantId = '') {
  const id = String(participantId || '').trim();
  if (!id) return false;
  return !!getClaimRecords(msg)[id];
}

export function getRemainingPacketCount(msg = {}) {
  const md = msg.metadata || {};
  const mode = md.redpacketMode || 'normal';
  if (mode === 'lucky') {
    const st = md.packetState || 'pending';
    if (st === 'claimed' || st === 'expired') return 0;
    const claimed = Object.keys(getClaimRecords(msg)).length;
    const total = normalizePacketCount(md.packetCount, 0);
    if (total > 0 && claimed >= total) return 0;
    const splits = Array.isArray(md.luckySplits) ? md.luckySplits : [];
    if (splits.length) return splits.length;
    // 懒 seed：刚发出时 luckySplits 还是空的，不能当成已抢完；按 packetCount 回退
    if (total > 0) return Math.max(0, total - claimed);
    return claimed ? 0 : 1;
  }
  if (mode === 'normal') {
    const st = md.packetState || 'pending';
    return st === 'pending' ? 1 : 0;
  }
  if (mode === 'exclusive') {
    return md.exclusiveClaimed ? 0 : 1;
  }
  return 0;
}

export function formatClaimNotice(name, amount) {
  const n = String(name || '有人').trim() || '有人';
  return `${n}领取了红包 ¥${yuan(amount)}`;
}

/** 群聊公屏抢红包提示：更口语一点，方便和对话错落穿插 */
export function formatGrabNotice(name, amount, senderName = '') {
  const n = String(name || '有人').trim() || '有人';
  const got = yuan(amount);
  const from = String(senderName || '').trim();
  if (from) return `${n}抢了${from}的红包 ¥${got}`;
  return `${n}抢到了红包 ¥${got}`;
}

export function getRemainingPacketAmount(msg = {}) {
  const md = msg.metadata || {};
  const mode = md.redpacketMode || 'normal';
  if (mode === 'lucky') {
    const st = md.packetState || 'pending';
    if (st === 'claimed' || st === 'expired') return '0.00';
    const claimed = Object.keys(getClaimRecords(msg)).length;
    const totalCount = normalizePacketCount(md.packetCount, 0);
    if (totalCount > 0 && claimed >= totalCount) return '0.00';
    const splits = Array.isArray(md.luckySplits) ? md.luckySplits : [];
    if (splits.length) {
      const sum = splits.reduce((acc, s) => acc + parseYuan(s), 0);
      return yuan(sum);
    }
    // 未 seed 时用总金额估算剩余（已领金额从 claimRecords 扣）
    const total = parseYuan(md.totalAmount || md.amount, 0);
    const claimedSum = Object.values(getClaimRecords(msg)).reduce((acc, rec) => acc + parseYuan(rec?.amount ?? rec), 0);
    return yuan(Math.max(0, total - claimedSum));
  }
  if (mode === 'normal') {
    const st = md.packetState || 'pending';
    return st === 'pending' ? yuan(md.amount || md.totalAmount || 0) : '0.00';
  }
  if (mode === 'exclusive') {
    return md.exclusiveClaimed ? '0.00' : yuan(md.exclusiveAmount || md.amount || 0);
  }
  return '0.00';
}

const REDPACKET_CLAIM_SPEECH_RE = /(?:抢|领)(?:到|了|走|到了|走了)?(?:这个|那个|了)?(?:红包)?[\s\S]{0,8}(?:红包|[¥￥]?\s*\d+(?:\.\d+)?\s*(?:元|块钱?|块)?)/u;
const REDPACKET_CLAIM_AMOUNT_RE = /((?:抢|领)(?:到|了|走|到了|走了)?(?:这个|那个|了)?(?:红包)?(?:竟然|才|就|有|是|：|:|，|,|\s){0,6})[¥￥]?\s*\d+(?:\.\d+)?\s*(?:元|块钱?|块)?/gu;
const REDPACKET_CLAIM_NEGATED_RE = /(?:没|未|别|不要|不准|不能|没能).{0,5}(?:抢|领)|(?:抢|领)(?:不到|不了|不着)|(?:抢|领).{0,10}(?:吗|没有|没[？?]?|[？?])/u;

/**
 * 弱模型偶尔只在 msg 里喊“抢到了 480”，却漏掉 redpacket_claim。
 * 对已有待领红包，把这种明确领取陈述补成真实事件，并移除模型自报金额；
 * 稍后 applyRedPacketClaimEvents 会按本地份额生成唯一可信的金额系统提示。
 */
export function repairRedPacketClaimSpeech(events = [], messages = []) {
  const sourceEvents = Array.isArray(events) ? events : [];
  const pendingPackets = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .filter((message) => (
      message
      && !message.deleted
      && !message.recalled
      && message.type === 'redpacket'
      && getRemainingPacketCount(message) > 0
    ));
  if (!pendingPackets.length) {
    return { events: sourceEvents, repaired: false, added: 0, sanitized: 0 };
  }

  const existingClaimActors = new Set(sourceEvents
    .filter((event) => event?.t === 'redpacket_claim')
    .map((event) => String(event.from || event.actor || '').trim())
    .filter(Boolean));
  const inferredClaims = [];
  let sanitized = 0;
  const normalizedEvents = sourceEvents.map((event) => {
    if (!event || event.t !== 'msg') return event;
    const actor = String(event.from || event.actor || '').trim();
    const body = String(event.body || event.text || event.content || '').trim();
    if (!actor || !body || !REDPACKET_CLAIM_SPEECH_RE.test(body) || REDPACKET_CLAIM_NEGATED_RE.test(body)) return event;
    const target = pendingPackets.find((packet) => (
      String(packet.senderId || '').trim() !== actor && !hasClaimed(packet, actor)
    ));
    if (!target) return event;
    if (!existingClaimActors.has(actor)) {
      existingClaimActors.add(actor);
      inferredClaims.push({
        t: 'redpacket_claim',
        from: actor,
        target: target.id,
        sourceIndex: Number(event.sourceIndex || 0) + 0.01,
        repairedFromSpeech: true,
      });
    }
    const cleanBody = body.replace(REDPACKET_CLAIM_AMOUNT_RE, '$1').replace(/\s+([！!，,。])/gu, '$1');
    if (cleanBody === body) return event;
    sanitized += 1;
    return { ...event, body: cleanBody };
  });
  return {
    events: inferredClaims.length ? [...normalizedEvents, ...inferredClaims] : normalizedEvents,
    repaired: inferredClaims.length > 0 || sanitized > 0,
    added: inferredClaims.length,
    sanitized,
  };
}

/**
 * 执行领取/抢红包，返回 patch 与系统通知文案。
 * @returns {{ ok: boolean, reason?: string, patch?: object, systemText?: string, got?: string }}
 */
export function performRedPacketClaim(msg = {}, {
  claimerId = 'user',
  claimerName = '',
  senderName = '',
} = {}) {
  const id = String(claimerId || 'user').trim() || 'user';
  const name = String(claimerName || (id === 'user' ? '我' : id)).trim();
  if (hasClaimed(msg, id)) {
    return { ok: false, reason: 'already-claimed' };
  }

  let m = ensureLuckyRedPacketSplits({ ...msg, metadata: { ...(msg.metadata || {}) } });
  const md = { ...(m.metadata || {}) };
  const mode = md.redpacketMode || 'normal';
  const records = getClaimRecords(m);
  const luckyGrabs = { ...(md.luckyGrabs || {}) };
  let splits = Array.isArray(md.luckySplits) ? [...md.luckySplits] : [];
  let got = 0;
  const now = Date.now();
  const fromName = String(senderName || msg.senderName || '').trim();
  const notice = (gotAmt) => formatGrabNotice(name, gotAmt, fromName);

  if (mode === 'lucky') {
    if (!splits.length) return { ok: false, reason: 'empty' };
    // 金额一律以本地预切份额为准，保证领完合计 = 红包总额。
    // 不接受模型自报金额来挑选份额；否则普通台词里编出的“480/两千”会反向污染领取结果。
    const pick = 0;
    got = parseYuan(splits[pick]);
    splits.splice(pick, 1);
    luckyGrabs[id] = yuan(got);
    records[id] = { amount: yuan(got), at: now, name };
    return {
      ok: true,
      got: yuan(got),
      systemText: notice(got),
      patch: {
        luckySplits: splits,
        luckyGrabs,
        claimRecords: records,
        packetState: splits.length ? 'pending' : 'claimed',
      },
    };
  }

  if (mode === 'exclusive') {
    const tid = String(md.exclusiveTargetId || '').trim();
    if (tid && tid !== id && tid !== 'user' && id !== 'user') {
      return { ok: false, reason: 'not-target' };
    }
    if (md.exclusiveClaimed) return { ok: false, reason: 'empty' };
    got = parseYuan(md.exclusiveAmount || md.amount || md.totalAmount, 0);
    if (got <= 0) got = parseYuan(md.exclusiveAmount || md.amount || md.totalAmount, 0.01);
    records[id] = { amount: yuan(got), at: now, name };
    return {
      ok: true,
      got: yuan(got),
      systemText: notice(got),
      patch: {
        exclusiveClaimed: true,
        packetState: 'claimed',
        claimRecords: records,
      },
    };
  }

  const st = md.packetState || 'pending';
  if (st !== 'pending') return { ok: false, reason: 'empty' };
  got = parseYuan(md.amount || md.totalAmount, 0);
  if (got <= 0) got = parseYuan(md.amount || md.totalAmount, 0.01);
  records[id] = { amount: yuan(got), at: now, name };
  return {
    ok: true,
    got: yuan(got),
    systemText: notice(got),
    patch: {
      packetState: 'claimed',
      claimRecords: records,
    },
  };
}

export function buildClaimListHtml(msg, { resolveName, esc, currentUserId = 'user' } = {}) {
  const e = typeof esc === 'function' ? esc : (s) => String(s ?? '');
  const entries = listClaimEntries(msg, (id) => {
    if (id === currentUserId || id === 'user') return '我';
    return resolveName?.(id) || id;
  });
  if (!entries.length) {
    return '<div class="chat-rp-grab-list chat-rp-grab-list--empty"><div class="chat-card-meta-note">暂无领取记录</div></div>';
  }
  const rows = entries.map((row) => `
    <div class="chat-rp-grab-row">
      <span class="chat-rp-grab-name">${e(row.name)}</span>
      <span class="chat-rp-grab-amt">¥${e(row.amount)}</span>
    </div>
  `).join('');
  return `<div class="chat-rp-grab-list">${rows}</div>`;
}

export function seedLuckySplitsIfNeeded(msg = {}) {
  const m = ensureLuckyRedPacketSplits({ ...msg, metadata: { ...(msg.metadata || {}) } });
  const md = m.metadata || {};
  if (md.redpacketMode !== 'lucky') return m;
  if (Array.isArray(md.luckySplits) && md.luckySplits.length) return m;
  const total = parseYuan(md.totalAmount, 8.88);
  const cnt = normalizePacketCount(md.packetCount, 5);
  return {
    ...m,
    metadata: {
      ...md,
      luckySplits: splitLuckyRedPacketYuan(total, cnt, m.id || String(m.timestamp || '')),
    },
  };
}
