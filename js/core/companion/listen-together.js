// 一起听：陪伴 session 的特化。
// 启动后，runtime tick 会通过 buildListenTogetherContext() 注入歌词窗与当前曲目。
// 切歌自动重置「本首评论计数」。
// 详见 docs/companion-architecture.md §3.4 与 §6 listen-together.

import { getMusicPlayerState, lyricContextAround } from './music-player-bridge.js';
import { onTrackChange } from './companion-machine.js';

export function buildListenTogetherContext(session) {
  if (session?.type !== 'listen_together') return {};
  const player = getMusicPlayerState();
  if (!player?.trackId) return {};
  return {
    track: player.track || { id: player.trackId },
    isPlaying: player.isPlaying,
    positionMs: player.positionMs,
    lyricWindow: lyricContextAround(player.positionMs, player.lyricLines, 3) || null,
  };
}

// 若当前播放曲目与 session 记录的不一致，则迁移 session（计数清零、currentTrackId 更新）。
export function reconcileSessionWithPlayer(session) {
  if (session?.type !== 'listen_together' || session.status !== 'active') return session;
  const player = getMusicPlayerState();
  if (!player?.trackId) return session;
  if (player.trackId !== session.currentTrackId) {
    return onTrackChange(session, player.trackId);
  }
  return session;
}
