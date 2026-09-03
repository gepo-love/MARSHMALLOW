function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function appendOfflineCheckpointSummary(checkpoints = [], checkpoint = {}) {
  const uptoBeatIndex = Math.max(0, number(checkpoint.uptoBeatIndex));
  const text = String(checkpoint.text || '').trim();
  if (!uptoBeatIndex || !text) return Array.isArray(checkpoints) ? [...checkpoints] : [];
  const rows = Array.isArray(checkpoints) ? checkpoints : [];
  const coveredUpto = rows.reduce(
    (max, row) => Math.max(max, Math.max(0, number(row?.uptoBeatIndex))),
    0,
  );
  return [...rows, {
    ...checkpoint,
    text,
    fromBeatIndex: Math.max(1, number(checkpoint.fromBeatIndex, coveredUpto + 1)),
    uptoBeatIndex,
  }];
}

export function shouldCreateOfflineCheckpoint(checkpoints = [], narrationCount = 0, every = 0) {
  const interval = Math.max(0, number(every));
  if (!interval) return false;
  const coveredUpto = (Array.isArray(checkpoints) ? checkpoints : []).reduce(
    (max, row) => Math.max(max, Math.max(0, number(row?.uptoBeatIndex))),
    0,
  );
  return Math.max(0, number(narrationCount)) - coveredUpto >= interval;
}

/**
 * 旧版本只写 uptoBeatIndex。首条仍从 1 开始时可连续推导；若首条已经很靠后，
 * 说明更早小结曾被固定容量淘汰，只把它视为一个 interval 长度的片段，留下缺口供原文自愈。
 */
export function offlineCheckpointCoverageRanges(checkpoints = [], every = 6) {
  const interval = Math.max(1, number(every, 6));
  const sorted = (Array.isArray(checkpoints) ? checkpoints : [])
    .filter((row) => number(row?.uptoBeatIndex) > 0 && String(row?.text || '').trim())
    .sort((left, right) => number(left.uptoBeatIndex) - number(right.uptoBeatIndex));
  let previousUpto = 0;
  return sorted.map((row, index) => {
    const uptoBeatIndex = Math.max(1, number(row.uptoBeatIndex));
    let fromBeatIndex = number(row.fromBeatIndex);
    if (!fromBeatIndex) {
      fromBeatIndex = index === 0 && uptoBeatIndex > interval
        ? Math.max(1, uptoBeatIndex - interval + 1)
        : previousUpto + 1;
    }
    fromBeatIndex = Math.max(1, Math.min(fromBeatIndex, uptoBeatIndex));
    previousUpto = Math.max(previousUpto, uptoBeatIndex);
    return { ...row, fromBeatIndex, uptoBeatIndex };
  });
}

export function isOfflineNarrationCovered(narrationNumber = 0, ranges = []) {
  const target = Math.max(0, number(narrationNumber));
  return (Array.isArray(ranges) ? ranges : []).some((range) =>
    target >= number(range?.fromBeatIndex) && target <= number(range?.uptoBeatIndex));
}

export function effectiveOfflineCheckpointSummaries(checkpoints = [], rollup = null) {
  const rows = Array.isArray(checkpoints) ? checkpoints : [];
  const rollupText = String(rollup?.text || '').trim();
  const rollupUpto = Math.max(0, number(rollup?.uptoBeatIndex));
  if (!rollupText || !rollupUpto) return [...rows];
  return [
    { ...rollup, fromBeatIndex: 1, uptoBeatIndex: rollupUpto, kind: 'rollup' },
    ...rows.filter((row) => number(row?.uptoBeatIndex) > rollupUpto),
  ];
}

export function selectOfflineCheckpointSummariesForContext(checkpoints = [], narrationBeforeWindow = 0) {
  const before = Math.max(0, number(narrationBeforeWindow));
  if (!before) return [];
  const sorted = (Array.isArray(checkpoints) ? checkpoints : [])
    .filter((checkpoint) => number(checkpoint?.uptoBeatIndex) > 0 && String(checkpoint?.text || '').trim())
    .sort((a, b) => number(a.uptoBeatIndex) - number(b.uptoBeatIndex));
  const fullyBefore = sorted.filter((checkpoint) => number(checkpoint.uptoBeatIndex) <= before);
  const coveredUpto = fullyBefore.length ? number(fullyBefore[fullyBefore.length - 1].uptoBeatIndex) : 0;
  if (coveredUpto >= before) return fullyBefore;
  const bridge = sorted.find((checkpoint) => number(checkpoint.uptoBeatIndex) > before);
  return bridge ? [...fullyBefore, bridge] : fullyBefore;
}
