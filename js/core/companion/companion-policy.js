// 陪伴主动说话策略引擎（纯函数，无副作用）。
// 这是唯一决定「是否产生一次主动输出」的地方，是成本与噪音的护栏。
// 详见 docs/companion-architecture.md §4。

const MIN = 60 * 1000;

// 各场景节奏：最短冷却 + 触发窗口区间（毫秒）。
export const RHYTHM = {
  idle: { minCooldownMs: 3 * MIN, window: [8 * MIN, 25 * MIN] },
  co_work: { minCooldownMs: 5 * MIN, window: [10 * MIN, 30 * MIN] },
  reading: { minCooldownMs: 5 * MIN, window: [10 * MIN, 30 * MIN] },
  cooking: { minCooldownMs: 4 * MIN, window: [6 * MIN, 18 * MIN] },
  focus: { minCooldownMs: 8 * MIN, window: [15 * MIN, 40 * MIN] },
  listen_together: { minCooldownMs: 45 * 1000, window: [60 * 1000, 150 * 1000], perTrackMax: 3 },
  voice_live: { minCooldownMs: 20 * 1000, window: [25 * 1000, 90 * 1000] },
  sleep: { minCooldownMs: 35 * 1000, window: [45 * 1000, 90 * 1000] },
};

// 安静时段（深夜）冷却与窗口的放大倍数。
export const QUIET_MULTIPLIER = 2;

export function rhythmFor(type) {
  return RHYTHM[type] || RHYTHM.idle;
}

// quietHours: { start, end } 为 0-23 的小时；支持跨午夜（如 23 -> 7）。
export function isQuietHour(now, quietHours) {
  if (!quietHours || quietHours.start == null || quietHours.end == null) return false;
  const h = new Date(now).getHours();
  const { start, end } = quietHours;
  if (start === end) return false;
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

function pickKind(session, ctx) {
  if (session.type === 'sleep') return 'speech';
  const s = ctx.settings || {};
  const rand = ctx.rand2 ?? Math.random();

  // 列出所有可选 kind 及权重，按设置过滤。
  const pool = [];
  if (session.type === 'listen_together') {
    if (s.allowMusicPost) pool.push(['music_post', 0.25]);
    if (s.allowChat) pool.push(['chat', 0.2]);
    if (s.allowBubble) pool.push(['bubble', 0.55]);
  } else {
    if (s.allowBubble) pool.push(['bubble', 0.45]);
    if (s.allowChat) pool.push(['chat', 0.25]);
  }
  if (!pool.length) return '';
  const total = pool.reduce((sum, [, w]) => sum + w, 0);
  let acc = 0;
  for (const [kind, w] of pool) {
    acc += w / total;
    if (rand <= acc) return kind;
  }
  return pool[pool.length - 1][0];
}

/**
 * 判定本 tick 是否应该主动产出。
 * @returns {{act:false, reason:string} | {act:true, kind:string, reason:string}}
 */
export function decideCompanionAction(session, now = Date.now(), ctx = {}) {
  if (!session || session.status !== 'active') return { act: false, reason: 'inactive' };

  const settings = ctx.settings || {};
  const sleepSession = session.type === 'sleep';
  if (settings.proactiveEnabled === false && !sleepSession) return { act: false, reason: 'disabled' };

  const quiet = !sleepSession && isQuietHour(now, settings.quietHours);
  const rhythm = rhythmFor(session.type);
  const freqMul = Number(ctx.frequencyMultiplier) > 0 ? Number(ctx.frequencyMultiplier) : 1;

  const customCooldown = !sleepSession && Number(settings.cooldownMinutes || 0) > 0
    ? Number(settings.cooldownMinutes) * MIN
    : 0;
  const cooldown = (customCooldown || rhythm.minCooldownMs) * (quiet ? QUIET_MULTIPLIER : 1) * freqMul;
  const sinceSpoke = now - Number(session.lastAiSpokeAt || session.startedAt || now);
  if (sinceSpoke < cooldown) return { act: false, reason: 'cooldown' };

  if (session.type === 'listen_together'
    && Number(session.commentCountForCurrentTrack || 0) >= (rhythm.perTrackMax || 3)) {
    return { act: false, reason: 'track-cap' };
  }

  // 专注模式只在阶段变化或用户求助时说话。
  if (session.type === 'focus' && !ctx.focusStage && !ctx.userAskedHelp) {
    return { act: false, reason: 'focus-quiet' };
  }

  if (now < Number(session.nextAmbientAt || 0)) return { act: false, reason: 'not-due' };

  const guaranteeMs = Math.max(0, Number(settings.guaranteeMinutes || 0)) * MIN;
  const guaranteed = guaranteeMs > 0 && sinceSpoke >= guaranteeMs;
  const baseProbability = Math.max(0, Math.min(100, Number(settings.proactiveProbability ?? 70))) / 100;
  const probability = sleepSession ? 1 : (guaranteed ? 1 : (quiet ? Math.min(baseProbability, 0.4) : baseProbability));
  const rand = ctx.rand ?? Math.random();
  if (rand > probability) return { act: false, reason: 'dice' };

  const kind = pickKind(session, ctx);
  if (!kind) return { act: false, reason: 'no-kind-allowed' };
  return { act: true, kind, reason: guaranteed ? 'guarantee' : 'due' };
}
