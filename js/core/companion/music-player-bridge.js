// 音乐播放器与陪伴模块之间的只读桥。
// 音乐页通过 publishMusicPlayerState() 把当前 trackId / 进度 / 歌词写进来；
// 陪伴模块（listen-together）通过 getMusicPlayerState() 读。
// 不依赖 window，避免污染全局。

let state = {
  trackId: '',
  track: null,
  isPlaying: false,
  playMode: 'sequence',
  positionMs: 0,
  durationMs: 0,
  lyricLines: [],   // [{ timeMs, text }]
  queue: [],        // [{ id, title, artist, coverUrl }]
  updatedAt: 0,
};

const LRC_TIME_RE = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;

export function parseLyricLrc(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.replace(LRC_TIME_RE, '').trim();
    if (!stripped) continue;
    LRC_TIME_RE.lastIndex = 0;
    let m;
    const times = [];
    while ((m = LRC_TIME_RE.exec(line)) !== null) {
      const min = Number(m[1]) || 0;
      const sec = Number(m[2]) || 0;
      const frac = Number(((m[3] || '0') + '00').slice(0, 3)) || 0;
      times.push(min * 60_000 + sec * 1000 + frac);
    }
    if (!times.length) {
      out.push({ timeMs: 0, text: stripped });
    } else {
      for (const t of times) out.push({ timeMs: t, text: stripped });
    }
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

const listeners = new Set();

export function publishMusicPlayerState(patch = {}) {
  const { progressOnly, ...statePatch } = patch;
  const next = { ...state, ...statePatch, updatedAt: Date.now() };
  if (Array.isArray(patch.lyricLines)) next.lyricLines = patch.lyricLines;
  if (Array.isArray(patch.queue)) next.queue = patch.queue;
  state = next;
  for (const fn of listeners) {
    try { fn(state, { ...patch, progressOnly }); } catch (_) {}
  }
}

export function getMusicPlayerState() {
  return state;
}

export function subscribeMusicPlayer(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---- 远程控制（由音乐页注册具体控制器，浮窗等地方可调用） ----

let controller = null;

export function registerMusicController(c) {
  controller = c && typeof c === 'object' ? c : null;
}

export function unregisterMusicController(c) {
  if (controller === c) controller = null;
}

export function hasMusicController() {
  return !!controller;
}

export async function commandTogglePlay() {
  if (!controller?.togglePlay) return false;
  await controller.togglePlay();
  return true;
}

export async function commandNext() {
  if (!controller?.next) return false;
  await controller.next();
  return true;
}

export async function commandPrev() {
  if (!controller?.prev) return false;
  await controller.prev();
  return true;
}

export async function commandPlayTrack(trackId) {
  if (!controller?.playTrack) return false;
  await controller.playTrack(trackId);
  return true;
}

export async function commandDuckVolume(level = 0.24) {
  if (!controller?.duckVolume) return false;
  await controller.duckVolume(level);
  return true;
}

export async function commandRestoreVolume() {
  if (!controller?.restoreVolume) return false;
  await controller.restoreVolume();
  return true;
}

function lyricIndexAt(positionMs, lines = state.lyricLines) {
  if (!Array.isArray(lines) || !lines.length) return -1;
  let currentIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if ((Number(lines[i].timeMs) || 0) <= positionMs) currentIdx = i;
    else break;
  }
  return currentIdx;
}

export function lyricContextAround(positionMs, lines = state.lyricLines, radius = 3) {
  const list = Array.isArray(lines) ? lines : [];
  const currentIdx = lyricIndexAt(positionMs, list);
  if (currentIdx < 0) return null;
  const safeRadius = Math.max(1, Math.min(5, Number(radius) || 3));
  const start = Math.max(0, currentIdx - safeRadius);
  const end = Math.min(list.length, currentIdx + safeRadius + 1);
  const windowLines = list.slice(start, end).map((line, offset) => {
    const index = start + offset;
    return {
      text: line?.text || '',
      timeMs: Number(line?.timeMs || 0) || 0,
      offset: index - currentIdx,
      current: index === currentIdx,
    };
  }).filter((line) => line.text);
  return {
    before: list[currentIdx - 1]?.text || '',
    current: list[currentIdx]?.text || '',
    after: list[currentIdx + 1]?.text || '',
    lines: windowLines,
    currentIndex: currentIdx,
  };
}

// 计算「前一句 / 当前 / 后一句」歌词窗口。
export function lyricWindowAt(positionMs, lines = state.lyricLines) {
  return lyricContextAround(positionMs, lines, 1);
}
