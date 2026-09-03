import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';
import { showGenerationErrorReport } from '../components/generation-error-report.js';
import { listCharacters } from '../core/character-store.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import { chat as apiChat, resolveGenerationMaxTokens } from '../core/api.js';
import {
  publishMusicPlayerState,
  parseLyricLrc,
  registerMusicController,
  unregisterMusicController,
} from '../core/companion/music-player-bridge.js';
import { startCompanionSession, endCompanionSession } from '../core/companion/companion-runtime.js';
import { listActiveCompanionSessions } from '../core/companion/companion-session-store.js';
import { getCurrentUser } from '../core/user-slot.js';
import {
  loadAppearancePrefs,
  getActiveTheme,
  isSeaHomeTheme,
  isWindowHomeTheme,
} from '../core/appearance-prefs.js';
import {
  captureMediaGesture,
  audioFromGestureOrNew,
  takePlayableAudio,
  hasMediaSession,
  updateMediaSessionMetadata,
  updateMediaSessionPlaybackState,
  clearMediaSession,
} from '../core/media-playback.js';
import { suspendSilentKeepAliveAudio, resumeSilentKeepAliveAudio } from '../core/background-scheduler.js';
import { openFilePicker } from '../core/open-file-picker.js';
import { buildWeiboAiSystemPrompt, collectRoleplayContextForSocialGeneration } from '../core/context/build-weibo-context.js';
import { listChatsForUser } from '../core/chat-store.js';
import { getNowForUser } from '../core/time-mode.js';
import { saveMusicShareToChat } from '../core/music-chat-share.js';
import {
  pickUniqueMusicCommentAuthor,
  selectMusicCommentBatch,
} from '../core/music-comment-candidates.js';
import { isUserPresentInChat } from '../core/chat-helpers.js';
import { buildMomentsMemoryBlock, buildMomentsCharacterCardsBlock, loadCharactersMap } from '../core/moments/build-moments-context.js';
import {
  handleTranslationToggleClick,
  messageLikelyNeedsTranslation,
  sanitizeAiTranslation,
} from '../core/translation-utils.js';
import {
  addTracksToPlaylist,
  createAudioUrlForTrack,
  createMusicPlaylist,
  deleteMusicPost,
  deleteMusicPlaylist,
  deleteMusicTrack,
  getMusicPost,
  importNeteaseSongsToLibrary,
  importAudioFilesToLibrary,
  importLyricFilesToLibrary,
  importMusicLinkToLibrary,
  loadMusicLibrary,
  normalizeNeteaseSong,
  normalizeRemoteCoverUrl,
  removeTrackFromPlaylist,
  saveMusicPlaylist,
  sanitizeMusicPostContent,
  saveMusicPost,
  saveMusicTrack,
  updateTrackLyrics,
} from '../core/music-library.js';
import {
  checkNeteaseProxy,
  createNeteaseQrLogin,
  DEFAULT_NETEASE_PROXY_URL,
  exchangeNeteaseCodeForToken,
  getNeteaseDailyImage,
  getNeteaseDailySongs,
  getNeteaseAuthUrl,
  getNeteaseHeartModeSongs,
  getNeteaseMoreSongs,
  getNeteasePlaylistDetail,
  getNeteaseRecommendPlaylists,
  getNeteaseSimilarSongs,
  getNeteaseSongLyrics,
  getNeteaseSongPlayUrl,
  getNeteaseUserPlaylists,
  importNeteasePlaylistSongs,
  loadNeteaseProviderConfig,
  loadNeteaseProfile,
  neteasePlaybackStatus,
  pollNeteaseQrLogin,
  refreshNeteaseToken,
  saveNeteaseProviderConfig,
  searchNeteaseSongs,
  warmNeteaseProxy,
} from '../core/netease-provider.js';

const MUSIC_SHARE_CHAT_KEY = 'musicShareChatId';
const MUSIC_SHELL_STORE_KEY = 'marshmallowMusicShell:v2';
const MUSIC_FEED_STORE_KEY = 'marshmallowMusicFeed:v1';
const MUSIC_SOCIAL_STORE_KEY = 'marshmallowMusicSocial:v1';

const MUSIC_SQUARE_VOICE_RULES = [
  '[口吻与防串人设 · 硬性规则]',
  '1. 每条动态的选歌与文案必须完全符合该角色自己的人物设定、说话习惯与音乐口味，不得套用其他角色的语气或喜好。',
  '2. 禁止串人设：不得把 A 的口癖、心事或曲风偏好套到 B 身上；不得用用户口吻代角色发动态。',
  '3. 同一批动态里，不同角色的选曲和文案要有明显区分度，能看出各自性格差异，不要都往同一种情绪/曲风靠。',
  '4. 文案是「此刻正听这首歌」的即时感受，不是歌评/乐评/解说，禁止出现"这首歌讲的是/编曲/唱功"这类分析口吻。',
].join('\n');

const MUSIC_SQUARE_CONTENT_RULES = [
  '[音乐广场正文 · 写什么]',
  '像"网抑云"评论区风格：克制、含蓄、留白，用一两句话带出情绪，不必直接点破在想什么。',
  '禁止出现"作为AI/根据设定/世界书/聊天记录"等说明性措辞；禁止歌评口吻；禁止 [表情包:名称]、贴纸标签、mood/情绪小标题。',
  '不要逐字大段抄歌词当文案；可以化用一两个词或意象，但整条必须是角色自己此刻要说的话。',
].join('\n');

const MUSIC_SQUARE_PICK_RULES = [
  '[选歌规则 · 必须先"角色自己选歌"]',
  '每条动态先站在这个角色的立场想：TA现在会想搜、想听的是什么歌？可以是任何真实存在的歌曲（华语/外语/纯音乐/小众/翻唱都行），必须贴合TA的人设、心情和当下语境，不能是随手编的假歌名。',
  '把这首歌写进 customQuery（格式："歌名 歌手"，歌手不确定可省略），交给系统去搜索匹配；不需要、也不应该默认它在下面的"备用曲库"里。',
  '"备用曲库"是用户自己本地存的歌，代表用户口味，不代表角色口味；只有角色本人明确是在"蹭用户的歌/被用户安利/两人共同在听"时，才可以选备用曲库（填 songIndex，customQuery 留空），并在文案里体现出"这是对方的歌/被安利来的"语气，不要默认据为己有当成自己一直爱听的歌。',
  'customQuery 与 songIndex 二选一，不要同时给两个非空值；两个都给不出时该条跳过。',
].join('\n');

const TABS = [
  { id: 'home', label: '首页' },
  { id: 'playlists', label: '歌单' },
  { id: 'square', label: '广场' },
  { id: 'profile', label: '我的主页' },
];

let activeAudio = null;
let activeAudioUrl = '';
let playRequestSeq = 0;
let lastPlayerPublishAt = 0;

function openModal(html, bind) {
  const existing = document.querySelector('.music-modal-overlay');
  existing?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'music-modal-overlay';
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (event) => {
    if (event.target === wrap || event.target.closest('[data-modal-close]')) close();
  });
  if (typeof bind === 'function') bind(wrap, close);
  return close;
}

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMusicPostTime(ts = 0) {
  const value = Number(ts || 0) || 0;
  if (!value) return '刚刚';
  const diff = Date.now() - value;
  if (diff >= 0 && diff < 60 * 1000) return '刚刚';
  if (diff >= 0 && diff < 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`;
  if (diff >= 0 && diff < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 3600000))} 小时前`;
  const d = new Date(value);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return sameYear ? `${mm}-${dd} ${hh}:${mi}` : `${d.getFullYear()}-${mm}-${dd}`;
}

function upgradeMusicMediaUrl(value = '') {
  let url = String(value || '').trim();
  if (!url) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  else if (/^http:\/\//i.test(url)) url = `https://${url.slice(7)}`;
  return url;
}

function readShellStore() {
  try {
    const raw = localStorage.getItem(MUSIC_SHELL_STORE_KEY);
    if (!raw) throw new Error('empty');
    const parsed = JSON.parse(raw);
    return {
      recentTrackIds: Array.isArray(parsed.recentTrackIds) ? parsed.recentTrackIds.map(String) : [],
      singleTrackLoop: parsed.singleTrackLoop === true,
      profileName: String(parsed.profileName || ''),
      profileAvatar: upgradeMusicMediaUrl(parsed.profileAvatar || ''),
      profileBg: upgradeMusicMediaUrl(parsed.profileBg || ''),
      signature: String(parsed.signature || ''),
    };
  } catch {
    return { recentTrackIds: [], singleTrackLoop: false, profileName: '', profileAvatar: '', profileBg: '', signature: '' };
  }
}

function writeShellStore(store) {
  localStorage.setItem(MUSIC_SHELL_STORE_KEY, JSON.stringify({
    recentTrackIds: store.recentTrackIds,
    singleTrackLoop: store.singleTrackLoop === true,
    profileName: store.profileName || '',
    profileAvatar: store.profileAvatar || '',
    profileBg: store.profileBg || '',
    signature: store.signature || '',
  }));
}

function readFeedStore() {
  try {
    const raw = localStorage.getItem(MUSIC_FEED_STORE_KEY);
    if (!raw) throw new Error('empty');
    const parsed = JSON.parse(raw);
    return {
      loadedAt: Number(parsed.loadedAt || 0) || 0,
      dailySongs: Array.isArray(parsed.dailySongs) ? parsed.dailySongs : [],
      playlists: Array.isArray(parsed.playlists) ? parsed.playlists : [],
    };
  } catch {
    return { loadedAt: 0, dailySongs: [], playlists: [] };
  }
}

function writeFeedStore(store) {
  localStorage.setItem(MUSIC_FEED_STORE_KEY, JSON.stringify({
    loadedAt: Number(store.loadedAt || 0) || 0,
    dailySongs: Array.isArray(store.dailySongs) ? store.dailySongs.slice(0, 40) : [],
    playlists: Array.isArray(store.playlists) ? store.playlists.slice(0, 40) : [],
  }));
}

function sanitizeCharacterProfiles(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (!key || !value || typeof value !== 'object') continue;
      const bg = typeof value.bg === 'string' ? value.bg : '';
      const signature = typeof value.signature === 'string' ? value.signature.slice(0, 80) : '';
      if (!bg && !signature) continue;
      out[String(key)] = { bg, signature, updatedAt: Number(value.updatedAt) || 0 };
    }
  }
  return out;
}

function readMusicSocialStore() {
  try {
    const raw = localStorage.getItem(MUSIC_SOCIAL_STORE_KEY);
    if (!raw) throw new Error('empty');
    const parsed = JSON.parse(raw);
    return {
      followingCharacterIds: Array.isArray(parsed.followingCharacterIds)
        ? parsed.followingCharacterIds.map(String).filter(Boolean)
        : [],
      fansCharacterIds: Array.isArray(parsed.fansCharacterIds)
        ? parsed.fansCharacterIds.map(String).filter(Boolean)
        : [],
      profiles: sanitizeCharacterProfiles(parsed.profiles),
    };
  } catch {
    return { followingCharacterIds: [], fansCharacterIds: [], profiles: {} };
  }
}

function writeMusicSocialStore(store) {
  localStorage.setItem(MUSIC_SOCIAL_STORE_KEY, JSON.stringify({
    followingCharacterIds: [...new Set((store.followingCharacterIds || []).map(String).filter(Boolean))],
    fansCharacterIds: [...new Set((store.fansCharacterIds || []).map(String).filter(Boolean))],
    profiles: sanitizeCharacterProfiles(store.profiles),
  }));
}

function compressImageToDataUrl(file, maxW = 1000, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxW / (img.width || maxW));
        const w = Math.max(1, Math.round((img.width || maxW) * scale));
        const h = Math.max(1, Math.round((img.height || maxW) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

function formatSource(track) {
  if (track.source === 'local') return '本地';
  if (track.source === 'link') return '外链';
  if (track.source === 'netease' || track.provider === 'netease') return '网易云';
  return '手动';
}

function trackStatusLabel(track) {
  return neteasePlaybackStatus(track) || formatSource(track);
}

function lyricOf(track) {
  return String(track?.lyricText || track?.lyricLrc || '').trim();
}

function lyricLines(track, max = 8) {
  const raw = lyricOf(track);
  if (!raw) return ['还没有歌词，可以在歌曲行点纸张图标粘贴 LRC 或纯文本。'];
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/g, '').trim())
    .filter((line) => line && !isLyricMetaLine(line))
    .slice(0, max);
}

function isLyricMetaLine(text) {
  return /^(作词|作曲|编曲|制作人|混音|母带|录音|和声|监制|出品|发行|词|曲|OP|SP|Lyricist|Composer|Arranger|Producer)\s*[:：]/i.test(String(text || '').trim());
}

function normalizeTimedLyrics(lines = [], max = 120) {
  return lines
    .filter((line) => line?.text && !isLyricMetaLine(line.text))
    .filter(Boolean)
    .slice(0, max);
}

function timedLyricLines(track, max = 120) {
  const parsed = normalizeTimedLyrics(parseLyricLrc(track?.lyricLrc || ''), max);
  if (parsed.length) return parsed;
  return lyricLines(track, 48).map((text, index) => ({ timeMs: index * 5000, text })).slice(0, max);
}

function currentLyricIndex(lines = []) {
  const positionMs = activeAudio ? Math.round((activeAudio.currentTime || 0) * 1000) : 0;
  let idx = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if ((Number(lines[i].timeMs) || 0) <= positionMs) idx = i;
    else break;
  }
  return idx;
}

function formatPlayerTime(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const min = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

function pickLyricQuote(track) {
  return lyricLines(track, 8).find((line) => line.length >= 6) || '';
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(fenced);
  } catch {
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(fenced.slice(start, end + 1));
    throw new Error('AI 返回不是有效 JSON');
  }
}

function parseJsonObjectOnce(text) {
  return parseJsonObject(text);
}

function uniqueTracksByProvider(tracks = []) {
  const seen = new Set();
  const out = [];
  for (const track of tracks) {
    if (!track) continue;
    const key = track.providerTrackId ? `netease:${track.providerTrackId}` : `local:${track.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

function trackSearchText(track) {
  return [track.title, track.artist, track.album, track.mood, lyricOf(track), track.source].filter(Boolean).join(' ').toLowerCase();
}

function trackCoverHtml(track, small = false) {
  const cover = normalizeRemoteCoverUrl(track?.coverUrl);
  if (cover) {
    return `<span class="music-cover ${small ? 'is-small' : ''} has-image"><img src="${esc(cover)}" alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async"></span>`;
  }
  const tone = track?.coverTone || 'cream';
  const title = String(track?.title || 'M').slice(0, 1).toUpperCase();
  const shape = track?.coverShape === 'disc' ? 'is-disc' : '';
  return `<span class="music-cover is-${esc(tone)} ${shape} ${small ? 'is-small' : ''}"><span>${esc(title)}</span></span>`;
}

function neteaseResultRowHtml(track, options = {}) {
  const status = trackStatusLabel(track);
  const sub = [track.artist || '网易云音乐', track.album, status].filter(Boolean).join(' · ');
  return `
    <article class="music-remote-row" data-remote-index="${Number(options.index || 0)}">
      ${trackCoverHtml(track, true)}
      <button type="button" class="music-remote-main" data-play-netease-result="${Number(options.index || 0)}">
        <strong>${esc(track.title || '未命名歌曲')}</strong>
        <small>${esc(sub)}</small>
      </button>
      <div class="music-remote-actions">
        <button type="button" class="btn btn-xs btn-primary" data-play-netease-result="${Number(options.index || 0)}">播放</button>
        <button type="button" class="music-icon-btn" data-import-netease-song="${Number(options.index || 0)}" aria-label="收藏">${icon('plus')}</button>
      </div>
    </article>
  `;
}

function neteasePlaylistRowHtml(item, options = {}) {
  const cover = pickPlaylistCover(item);
  const title = item.name || item.title || '网易云歌单';
  const desc = item.creatorNickName || item.describe || item.description || '';
  const fakeTrack = { title, artist: desc, coverUrl: cover, coverTone: 'blue', coverShape: 'disc' };
  return `
    <article class="music-remote-row" data-remote-playlist-index="${Number(options.index || 0)}">
      ${trackCoverHtml(fakeTrack, true)}
      <button type="button" class="music-remote-main" data-open-netease-playlist="${Number(options.index || 0)}">
        <strong>${esc(title)}</strong>
        <small>${esc(desc || '推荐歌单')}</small>
      </button>
      <button type="button" class="btn btn-xs btn-primary" data-open-netease-playlist="${Number(options.index || 0)}">打开</button>
    </article>
  `;
}

function normalizeCoverUrl(value) {
  // 歌单横幅仍去掉 query，避免部分 CDN 尺寸参数干扰背景图缓存
  return normalizeRemoteCoverUrl(value).replace(/\?.*$/, '');
}

function pickPlaylistCover(item, depth = 0) {
  if (!item || typeof item !== 'object' || depth > 3) return '';
  const directKeys = [
    'coverImgUrl', 'coverImgURL', 'coverImgurl', 'picUrl', 'coverUrl',
    'imageUrl', 'imgUrl', 'cover', 'blurCoverImgUrl', 'coverImgUrlBig',
    'frontPicUrl', 'picUrlMini', 'image', 'pic', 'albumPicUrl',
  ];
  for (const key of directKeys) {
    const found = normalizeCoverUrl(item[key]);
    if (found) return found;
  }
  for (const key of ['playlist', 'coverImg', 'album', 'al', 'data', 'info', 'detail']) {
    if (item[key] && typeof item[key] === 'object') {
      const nested = pickPlaylistCover(item[key], depth + 1);
      if (nested) return nested;
    }
  }
  return '';
}

function featureBannerHtml({ cover = '', title = '', desc = '', tag = '歌单', tone = 'cream', dataAttr = '' }) {
  const safeTitle = String(title || '推荐歌单');
  const safeCover = normalizeRemoteCoverUrl(cover) || (/^data:image\//i.test(String(cover || '')) ? String(cover) : '');
  return `
    <button type="button" class="music-feature-card ${safeCover ? 'has-image' : `tone-${esc(tone)}`}" ${dataAttr}>
      <span class="music-feature-bg" ${safeCover ? `style="background-image:url('${esc(safeCover)}')"` : ''} aria-hidden="true">${safeCover ? '' : `<span class="music-feature-initial">${esc(safeTitle.slice(0, 1).toUpperCase())}</span>`}</span>
      <span class="music-feature-tag">${esc(tag)}</span>
      <span class="music-feature-cap">
        <strong>${esc(safeTitle)}</strong>
        <small>${esc(desc)}</small>
      </span>
      <span class="music-feature-play" aria-hidden="true">▶</span>
    </button>
  `;
}

function trackRowHtml(track, options = {}) {
  const sub = [track.artist || '未知歌手', trackStatusLabel(track), track.mood].filter(Boolean).join(' · ');
  const shareMode = !!options.shareMode;
  const playlistId = options.playlistId || '';
  return `
    <article class="music-track-row" data-track-id="${esc(track.id)}">
      ${trackCoverHtml(track, true)}
      <button type="button" class="music-track-main" data-play-track="${esc(track.id)}">
        <strong>${esc(track.title || '未命名歌曲')}</strong>
        <small>${esc(sub)}</small>
      </button>
      <span class="music-track-duration">${esc(track.duration || '--:--')}</span>
      <button type="button" class="music-icon-btn" data-lyrics-track="${esc(track.id)}" aria-label="歌词">${icon('textimg')}</button>
      <button type="button" class="music-icon-btn" data-${shareMode ? 'share' : 'add'}-track="${esc(track.id)}" aria-label="${shareMode ? '分享' : '收藏'}">
        ${shareMode ? icon('send') : icon('plus')}
      </button>
      <button type="button" class="music-icon-btn" data-track-menu="${esc(track.id)}" data-track-menu-playlist="${esc(playlistId)}" aria-label="更多">${icon('more')}</button>
    </article>
  `;
}

function playlistCardHtml(playlist, trackById) {
  const tracks = (playlist.trackIds || []).map(trackById).filter(Boolean);
  const cover = playlistCover(playlist, trackById);
  const preview = tracks.slice(0, 3).map((track) => `
    <button type="button" class="music-playlist-mini" data-play-track="${esc(track.id)}" data-queue-playlist="${esc(playlist.id)}">
      ${trackCoverHtml(track, true)}
      <span>${esc(track.title)}</span>
    </button>
  `).join('');
  return `
    <section class="music-playlist-card scrapbook-panel" data-playlist-id="${esc(playlist.id)}">
      <div class="music-playlist-pin" aria-hidden="true"></div>
      <div class="music-playlist-head">
        <button type="button" class="music-playlist-cover-thumb ${cover ? 'has-image' : ''}" data-open-playlist="${esc(playlist.id)}" aria-hidden="${cover ? 'false' : 'true'}">
          ${cover ? `<img src="${esc(cover)}" alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async">` : `<span>${esc(String(playlist.title || '歌').slice(0, 1))}</span>`}
        </button>
        <button type="button" class="music-playlist-open" data-open-playlist="${esc(playlist.id)}">
          <strong>${esc(playlist.title || '未命名歌单')}</strong>
          <small>${esc(`${tracks.length} 首 · ${playlist.desc || '自己的收藏'}`)}</small>
        </button>
        <div class="music-playlist-actions">
          <button type="button" class="btn btn-xs btn-primary" data-play-playlist="${esc(playlist.id)}">播放</button>
          <button type="button" class="music-icon-btn" data-edit-playlist="${esc(playlist.id)}" aria-label="编辑">${icon('edit')}</button>
        </div>
      </div>
      <div class="music-playlist-preview">
        ${preview || '<div class="music-soft-empty">还没有歌曲</div>'}
      </div>
    </section>
  `;
}

function userAvatarHtml(me, className = 'music-post-avatar-img') {
  const avatar = String(me?.avatar || '').trim();
  if (avatar) return `<img class="${className}" src="${esc(avatar)}" alt="" decoding="async">`;
  const initial = esc(String(me?.name || '我').slice(0, 1));
  return `<span class="${className} is-fallback">${initial}</span>`;
}

function isUserPost(post, me) {
  return post.authorType === 'user' || (!post.characterId && (post.authorId === 'user' || post.authorId === me?.id));
}

function commentLineHtml(comment, charactersMap, me) {
  const char = comment.characterId ? charactersMap.get(comment.characterId) : null;
  const isUser = !comment.characterId && (comment.authorId === 'user' || comment.authorId === me?.id);
  const name = char?.name || (isUser ? (me?.name || '我') : (comment.authorName || '匿名'));
  return `<div class="music-comment">
    <span class="music-comment-name">${esc(name)}</span>
    <span class="music-comment-text">${esc(comment.text || '')}</span>
  </div>`;
}

function postCardHtml(post, charactersMap, trackById, me) {
  const track = trackById(post.trackId);
  if (!track) return '';
  const char = post.characterId ? charactersMap.get(post.characterId) : null;
  if (post.characterId && !char) return '';
  const asUser = !char && isUserPost(post, me);
  const authorName = char?.name || (asUser ? (me?.name || '我') : (post.authorName || '音乐广场'));
  const avatarHtml = char
    ? characterAvatarHtml(char, { className: 'music-post-avatar-img' })
    : (asUser ? userAvatarHtml(me) : trackCoverHtml(track, true));
  const comments = Array.isArray(post.comments) ? post.comments : [];
  const previewComments = comments.slice(0, 2).map((c) => commentLineHtml(c, charactersMap, me)).join('');
  const likeCount = Math.max(0, Number(post.likes || 0) || 0);
  return `
    <article class="music-post scrapbook-panel" data-post-id="${esc(post.id)}">
      <div class="music-post-author">
        <button type="button" class="music-post-avatar" ${char ? `data-open-music-character="${esc(char.id)}"` : ''} aria-label="${esc(authorName)}">
          ${avatarHtml}
        </button>
        <div>
          ${char
            ? `<button type="button" class="music-post-author-name" data-open-music-character="${esc(char.id)}">${esc(authorName)}</button>`
            : `<strong>${esc(authorName)}${asUser ? ' <em class="music-post-badge">我</em>' : ''}</strong>`}
          <small>${esc(formatMusicPostTime(post.createdAt))}</small>
        </div>
        <button type="button" class="music-icon-btn music-post-menu" data-post-menu="${esc(post.id)}" aria-label="动态操作">${icon('more')}</button>
      </div>
      ${post.content || (!post.lyricQuote && lyricOf(track)) ? `<p>${esc(post.content || lyricOf(track) || '')}${musicPostTranslationHtml(post.content || lyricOf(track) || '', post.translation || '')}</p>` : ''}
      ${post.lyricQuote ? `<blockquote class="music-post-lyric">${esc(post.lyricQuote).replace(/\n/g, '<br>')}</blockquote>` : ''}
      <div class="music-post-track">
        ${trackCoverHtml(track, true)}
        <button type="button" data-play-track="${esc(track.id)}">
          <strong>${esc(track.title)}</strong>
          <small>${esc(track.artist || '')}</small>
        </button>
        <button type="button" class="music-icon-btn music-post-play" data-play-track="${esc(track.id)}" aria-label="播放">${icon('music')}</button>
      </div>
      <div class="music-post-actions">
        <button type="button" data-repost-track="${esc(track.id)}">${icon('weiboRepost')}<span>转发</span></button>
        <button type="button" data-open-post-thread="${esc(post.id)}">${icon('weiboComment')}<span>${comments.length || '评论'}</span></button>
        <button type="button" class="music-post-like ${post.likedByMe ? 'is-on' : ''}" data-like-post="${esc(post.id)}">${icon('weiboLike')}<span>${likeCount || '赞'}</span></button>
      </div>
      ${comments.length ? `<div class="music-post-comments">
        ${previewComments}
        ${comments.length > 2 ? `<button type="button" class="music-comment-more" data-open-post-thread="${esc(post.id)}">查看全部 ${comments.length} 条评论</button>` : ''}
      </div>` : ''}
    </article>
  `;
}

function musicPostTranslationHtml(text = '', translation = '') {
  const source = String(text || '').trim();
  const zh = sanitizeAiTranslation(source, translation);
  if (!source || !(zh || messageLikelyNeedsTranslation(source))) return '';
  return `<button type="button" class="music-post-translate-btn" data-translation-toggle data-translation-source="${esc(source)}" aria-expanded="false">译</button><span class="narration-translation music-post-translation" hidden>${esc(zh)}</span>`;
}

function buildCharacterPosts(characters, tracks) {
  return [];
}

function renderSearchResults(query, tracks, shareMode) {
  const q = query.trim().toLowerCase();
  if (!q) return '';
  const results = tracks.filter((track) => trackSearchText(track).includes(q));
  return `
    <section class="music-section">
      <div class="music-section-head">
        <h2>搜索结果</h2>
        <span>${results.length}</span>
      </div>
      <div class="music-track-list">
        ${results.length ? results.map((track) => trackRowHtml(track, { shareMode })).join('') : '<div class="music-soft-empty">本地音乐库里还没有这首</div>'}
      </div>
    </section>
  `;
}

function playerPanelHtml({ track, isPlaying, queue, listenTogether = false, listenTogetherName = '' }) {
  if (!track) return '';
  const lines = timedLyricLines(track);
  const currentIndex = currentLyricIndex(lines);
  return `
    <section class="music-player-card scrapbook-panel">
      <div class="music-player-cover">${trackCoverHtml(track)}</div>
      <div class="music-player-info">
        <strong>${esc(track.title)}</strong>
        <small>${esc([track.artist, trackStatusLabel(track)].filter(Boolean).join(' · '))}</small>
      </div>
      <div class="music-player-controls">
        <button type="button" class="music-round-btn" data-prev-track aria-label="上一首">‹</button>
        <button type="button" class="music-round-btn is-main" data-toggle-play aria-label="${isPlaying ? '暂停' : '播放'}">${isPlaying ? 'Ⅱ' : '▶'}</button>
        <button type="button" class="music-round-btn" data-next-track aria-label="下一首">›</button>
      </div>
      <div class="music-player-sub">
        <button type="button" class="btn btn-xs btn-outline" data-open-queue>队列 ${queue.length}</button>
        <button type="button" class="btn btn-xs btn-soft" data-lyrics-track="${esc(track.id)}">歌词</button>
        <button type="button" class="btn btn-xs ${listenTogether ? 'btn-primary' : 'btn-soft'}" data-listen-together>${listenTogether ? `结束一起听${listenTogetherName ? ` · ${esc(listenTogetherName)}` : ''}` : '一起听'}</button>
        ${listenTogether ? '<button type="button" class="btn btn-xs btn-soft" data-open-listen-view>沉浸视图</button>' : ''}
        ${(track.source === 'link' || track.source === 'netease' || track.provider === 'netease') && track.sourceUrl ? `<button type="button" class="btn btn-xs btn-primary" data-open-link="${esc(track.id)}">打开链接</button>` : ''}
      </div>
      <div class="music-lyric-panel is-scroll" data-player-lyrics>
        ${lines.map((line, index) => `<p class="${index === currentIndex ? 'is-current' : ''}" data-lyric-line data-time-ms="${Number(line.timeMs || 0) || 0}">${esc(line.text || '')}</p>`).join('')}
      </div>
    </section>
  `;
}

/** 黑胶中心标贴：有封面放封面，没有就放首字母，外圈是黑胶纹理。 */
function vinylLabelHtml(track) {
  const coverUrl = normalizeRemoteCoverUrl(track?.coverUrl);
  const cover = coverUrl
    ? `<img src="${esc(coverUrl)}" alt="" referrerpolicy="no-referrer" decoding="async">`
    : '';
  const initial = String(track?.title || 'M').slice(0, 1).toUpperCase();
  return `
    <span class="music-vinyl-label${cover ? ' has-image' : ''}">
      ${cover || `<b>${esc(initial)}</b>`}
    </span>
  `;
}

/** 心电图 / 波形分隔线：呼应「一起听」的心跳母题，作播放页签名元素。 */
const HEARTBEAT_WAVE_SVG = `
  <svg class="music-wave" viewBox="0 0 300 40" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 20 H86 l6 -13 l7 26 l8 -34 l9 41 l7 -20 l5 0 q6 -16 12 0 l86 0" />
  </svg>
`;

function playerPageHtml({
  track,
  isPlaying,
  queue,
  singleTrackLoop = false,
  listenTogether = false,
  listenTogetherName = '',
  lyricsView = false,
}) {
  if (!track) return '<section class="music-player-page"><div class="music-soft-empty">先播放一首歌</div></section>';
  const lines = timedLyricLines(track);
  const currentIndex = currentLyricIndex(lines);
  const positionMs = activeAudio ? Math.round((activeAudio.currentTime || 0) * 1000) : 0;
  const durationMs = activeAudio?.duration ? Math.round(activeAudio.duration * 1000) : 0;
  const percent = durationMs ? Math.max(0, Math.min(100, Math.round((positionMs / durationMs) * 100))) : 0;
  const byline = esc([track.artist, trackStatusLabel(track)].filter(Boolean).join(' · '));
  const lyricsHtml = lines.length
    ? lines.map((line, index) => `<p class="${index === currentIndex ? 'is-current' : ''}" data-lyric-line data-time-ms="${Number(line.timeMs || 0) || 0}">${esc(line.text || '')}</p>`).join('')
    : '<p class="is-empty">这首歌还没有歌词 · 轻点返回唱片</p>';
  // 轻点唱片 / 歌词在两种视图间切换
  const stage = lyricsView
    ? `<div class="music-player-meta is-compact">
        <h2 class="music-player-name">${esc(track.title)}</h2>
        <p class="music-player-byline">${byline}</p>
      </div>
      <div class="music-player-lyrics is-stage" data-toggle-player-lyrics data-player-page-lyrics role="button" tabindex="0" aria-label="返回唱片">
        ${lyricsHtml}
      </div>`
    : `<div class="music-player-stage">
        <button type="button" class="music-vinyl ${isPlaying ? 'is-playing' : ''}" data-toggle-player-lyrics aria-label="查看歌词">
          <span class="music-vinyl-disc" aria-hidden="true"></span>
          ${vinylLabelHtml(track)}
          <span class="music-vinyl-arm ${isPlaying ? 'is-down' : ''}" aria-hidden="true"></span>
        </button>
        <div class="music-player-meta">
          ${HEARTBEAT_WAVE_SVG}
          <h2 class="music-player-name">${esc(track.title)}</h2>
          <p class="music-player-byline">${byline}</p>
        </div>
      </div>`;
  return `
    <section class="music-player-page ${lyricsView ? 'is-lyrics' : ''}">
      ${stage}
      <div class="music-player-progress">
        <span data-player-time-current>${formatPlayerTime(positionMs)}</span>
        <div class="music-player-progress-bar" aria-hidden="true"><i data-player-progress style="width:${percent}%"></i></div>
        <span data-player-time-duration>${durationMs ? formatPlayerTime(durationMs) : '--:--'}</span>
      </div>
      <div class="music-player-controls is-page">
        <button type="button" class="music-round-btn is-mode ${singleTrackLoop ? 'is-active' : ''}" data-toggle-single-loop aria-label="${singleTrackLoop ? '关闭单曲循环' : '开启单曲循环'}" aria-pressed="${singleTrackLoop ? 'true' : 'false'}" title="单曲循环">${icon('repeatOne')}</button>
        <button type="button" class="music-round-btn" data-prev-track aria-label="上一首">‹</button>
        <button type="button" class="music-round-btn is-main" data-toggle-play aria-label="${isPlaying ? '暂停' : '播放'}">${isPlaying ? 'Ⅱ' : '▶'}</button>
        <button type="button" class="music-round-btn" data-next-track aria-label="下一首">›</button>
        <button type="button" class="music-round-btn is-mode" data-open-queue aria-label="打开播放队列" title="播放队列">${icon('menu')}</button>
      </div>
      <div class="music-player-sub is-page">
        <button type="button" class="btn btn-xs btn-primary" data-share-player="${esc(track.id)}">转发</button>
        <button type="button" class="btn btn-xs btn-soft" data-lyrics-track="${esc(track.id)}">编辑歌词</button>
        <button type="button" class="btn btn-xs ${listenTogether ? 'btn-primary' : 'btn-soft'}" data-listen-together>${listenTogether ? `结束一起听${listenTogetherName ? ` · ${esc(listenTogetherName)}` : ''}` : '一起听'}</button>
        ${listenTogether ? '<button type="button" class="btn btn-xs btn-soft" data-open-listen-view>沉浸视图</button>' : ''}
        ${(track.source === 'link' || track.source === 'netease' || track.provider === 'netease') && track.sourceUrl ? `<button type="button" class="btn btn-xs btn-soft" data-open-link="${esc(track.id)}">打开链接</button>` : ''}
      </div>
    </section>
  `;
}

function playlistCover(playlist, trackById) {
  const direct = String(playlist?.coverUrl || '').trim();
  if (direct) return direct;
  const tracks = (playlist?.trackIds || []).map(trackById).filter(Boolean);
  for (const track of tracks) {
    const cover = normalizeCoverUrl(track?.coverUrl);
    if (cover) return cover;
  }
  return '';
}

function renderHome({ tracks, recentTracks, feed, playlists = [], trackById = () => null }) {
  const feedSongs = (feed.dailySongs || []).map((song) => normalizeNeteaseSong(song)).filter((track) => track.providerTrackId || track.title);
  const displaySongs = feedSongs.length ? feedSongs.slice(0, 8) : tracks.slice(0, 8);
  if (!tracks.length && !feedSongs.length && !playlists.length) {
    return `
      <section class="music-hero scrapbook-panel">
        <span class="scrapbook-tape scrapbook-tape-orange" aria-hidden="true"></span>
        <div class="music-soft-empty">登录网易云、上传本地音乐，或者新建一个歌单，这里就会热闹起来</div>
        <div class="music-hero-actions">
          <button type="button" class="btn btn-primary" data-create-playlist>新建歌单</button>
          <button type="button" class="btn btn-outline" data-upload-trigger>上传本地音乐</button>
        </div>
      </section>
    `;
  }
  const coveredPlaylists = (playlists || []).filter((pl) => playlistCover(pl, trackById));
  const playlistCards = coveredPlaylists.slice(0, 8).map((pl) => {
    const count = (pl.trackIds || []).length;
    return featureBannerHtml({
      cover: playlistCover(pl, trackById),
      title: pl.title,
      desc: pl.desc || `${count} 首`,
      tag: pl.generatedBy === 'character' ? '角色' : '歌单',
      dataAttr: `data-open-playlist="${esc(pl.id)}"`,
    });
  }).join('');
  const recentCards = (recentTracks.length ? recentTracks : tracks.slice(0, 4)).map((track) => `
    <button type="button" class="music-quick-card scrapbook-panel" data-play-track="${esc(track.id)}">
      ${trackCoverHtml(track)}
      <strong>${esc(track.title)}</strong>
      <small>${esc(track.artist)}</small>
    </button>
  `).join('');
  return `
    <section class="music-section">
      <div class="music-section-head">
        <h2>我的歌单</h2>
        <button type="button" class="music-head-btn" data-create-playlist aria-label="新建歌单">${icon('plus')}</button>
      </div>
      ${playlistCards
        ? `<div class="music-feature-strip">${playlistCards}</div>`
        : `<div class="music-feature-empty music-soft-empty">收藏或创建歌单，给它加一张封面，就会出现在这里。<button type="button" class="btn btn-xs btn-primary" data-create-playlist>创建歌单</button></div>`}
    </section>
    <section class="music-section">
      <div class="music-section-head">
        <h2>推荐歌曲</h2>
        <button type="button" class="music-head-btn" data-refresh-music-feed aria-label="刷新推荐">${icon('reroll')}</button>
      </div>
      <div class="music-track-list">${displaySongs.map((track, index) => `
        <article class="music-track-row" data-feed-song-index="${index}">
          ${trackCoverHtml(track, true)}
          <button type="button" class="music-track-main" data-play-feed-song="${index}">
            <strong>${esc(track.title || '未命名歌曲')}</strong>
            <small>${esc([track.artist || '网易云音乐', track.album, trackStatusLabel(track)].filter(Boolean).join(' · '))}</small>
          </button>
          <span class="music-track-duration">${esc(track.duration || '--:--')}</span>
          <button type="button" class="music-icon-btn" data-play-feed-song="${index}" aria-label="播放">${icon('play')}</button>
          <button type="button" class="music-icon-btn" data-import-feed-song="${index}" aria-label="收藏">${icon('plus')}</button>
          <button type="button" class="music-icon-btn" data-feed-song-menu="${index}" aria-label="更多">${icon('more')}</button>
        </article>
      `).join('') || '<div class="music-soft-empty">还没有推荐，点右上角刷新试试</div>'}</div>
    </section>
    <section class="music-section">
      <div class="music-section-head"><h2>最近在听</h2><span>${recentTracks.length}</span></div>
      <div class="music-quick-grid">${recentCards || '<div class="music-soft-empty">播一首歌，这里就会亮起来</div>'}</div>
    </section>
  `;
}

function renderPlaylists(playlists, trackById, selectedPlaylistId, playMode = 'sequence') {
  const selected = selectedPlaylistId ? playlists.find((p) => p.id === selectedPlaylistId) || null : null;
  const selectedTracks = selected ? (selected.trackIds || []).map(trackById).filter(Boolean) : [];
  const selectedCover = selected ? playlistCover(selected, trackById) : '';
  return `
    <section class="music-toolbar-card scrapbook-panel">
      <button type="button" class="music-tool-action is-primary" data-upload-trigger>${icon('plus')}<span>本地</span></button>
      <button type="button" class="music-tool-action" data-create-playlist>${icon('edit')}<span>新建</span></button>
      <button type="button" class="music-tool-action" data-link-provider>${icon('link')}<span>外链</span></button>
      <button type="button" class="music-tool-action" data-lyric-upload-trigger>${icon('textimg')}<span>歌词</span></button>
    </section>
    <section class="music-playlist-selector">
      ${playlists.map((p) => `<button type="button" class="music-playlist-chip ${selected?.id === p.id ? 'is-active' : ''}" data-select-playlist="${esc(p.id)}">${esc(p.title)}</button>`).join('')}
    </section>
    ${selected ? `
      <section class="music-section">
        <div class="music-section-head music-playlist-detail-head">
          <div class="music-playlist-detail-title">
            <span class="music-playlist-detail-cover ${selectedCover ? 'has-image' : ''}" aria-hidden="true">
              ${selectedCover ? `<img src="${esc(selectedCover)}" alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async">` : `<span>${esc(String(selected.title || '歌').slice(0, 1))}</span>`}
            </span>
            <h2>${esc(selected.title)}</h2>
          </div>
          <button type="button" class="music-head-btn" data-close-playlist-detail aria-label="收起歌单">${icon('chevron')}</button>
        </div>
        <div class="music-playlist-detail-tools">
          <button type="button" class="btn btn-xs btn-primary" data-play-playlist="${esc(selected.id)}">播放歌单</button>
          <button type="button" class="btn btn-xs ${playMode === 'sequence' ? 'btn-primary' : 'btn-soft'}" data-playlist-mode="sequence">顺序</button>
          <button type="button" class="btn btn-xs ${playMode === 'shuffle' ? 'btn-primary' : 'btn-soft'}" data-playlist-mode="shuffle">随机</button>
          <button type="button" class="music-icon-btn" data-edit-playlist="${esc(selected.id)}" aria-label="编辑">${icon('edit')}</button>
        </div>
        <div class="music-track-list">${selectedTracks.map((track) => trackRowHtml(track, { playlistId: selected.id })).join('') || '<div class="music-soft-empty">这个歌单还没有歌曲</div>'}</div>
      </section>
    ` : `
      <section class="music-section">
        <div class="music-section-head"><h2>全部歌单</h2><span>${playlists.length}</span></div>
        <div class="music-playlist-grid">${playlists.map((p) => playlistCardHtml(p, trackById)).join('') || '<div class="music-soft-empty">还没有歌单</div>'}</div>
      </section>
    `}
  `;
}

function renderSquare(posts, charactersMap, trackById, me, socialStore, filter = 'all') {
  const following = new Set(socialStore.followingCharacterIds || []);
  // 故事头像行：关注的角色优先，其次近期发帖的角色
  const storyIds = [];
  for (const id of following) if (charactersMap.has(id)) storyIds.push(id);
  for (const post of posts) {
    if (post.characterId && charactersMap.has(post.characterId) && !storyIds.includes(post.characterId)) storyIds.push(post.characterId);
    if (storyIds.length >= 12) break;
  }
  const storyHtml = storyIds.map((id) => {
    const char = charactersMap.get(id);
    const active = following.has(id);
    return `<button type="button" class="music-story ${active ? 'is-active' : ''}" data-open-music-character="${esc(id)}">
      <span class="music-story-ring">${characterAvatarHtml(char, { className: 'music-story-img' })}</span>
      <small>${esc(char.name || id)}</small>
    </button>`;
  }).join('');
  const visible = filter === 'following'
    ? posts.filter((post) => post.characterId && following.has(post.characterId))
    : posts;
  const feedHtml = visible.map((post) => postCardHtml(post, charactersMap, trackById, me)).filter(Boolean).join('');
  const emptyText = filter === 'following'
    ? '关注的角色还没发动态，去关注几个，或点右上「生成」'
    : '广场还很安静，分享一首在听的歌，或点「生成」让角色冒泡';
  return `
    <section class="music-square-compose" data-compose-post>
      <span class="music-square-compose-avatar">${userAvatarHtml(me, 'music-square-compose-img')}</span>
      <span class="music-square-compose-hint">分享一首正在听的歌…</span>
      ${icon('music')}
    </section>
    ${storyHtml ? `<div class="music-story-row">${storyHtml}</div>` : ''}
    <div class="music-feed-bar">
      <div class="music-feed-filter">
        <button type="button" class="music-feed-tab ${filter !== 'following' ? 'is-active' : ''}" data-square-filter="all">全部</button>
        <button type="button" class="music-feed-tab ${filter === 'following' ? 'is-active' : ''}" data-square-filter="following">关注</button>
      </div>
      <button type="button" class="music-feed-gen" data-generate-posts>${icon('sparkle')}<span>生成</span></button>
    </div>
    <section class="music-section">
      <div class="music-post-list">${feedHtml || `<div class="music-soft-empty">${emptyText}</div>`}</div>
    </section>
  `;
}

function renderFollowPage(characters, posts, socialStore, trackById) {
  const following = new Set(socialStore.followingCharacterIds || []);
  const followedChars = characters.filter((char) => char?.id && following.has(char.id));
  const rows = followedChars.map((char) => {
    const charPosts = posts.filter((post) => post.characterId === char.id && trackById(post.trackId));
    const latest = charPosts[0];
    const track = latest ? trackById(latest.trackId) : null;
    return `
      <button type="button" class="music-character-row scrapbook-panel" data-open-music-character="${esc(char.id)}">
        <span class="music-post-avatar">${characterAvatarHtml(char, { className: 'music-post-avatar-img' })}</span>
        <span>
          <strong>${esc(char.name || char.id)}</strong>
          <small>${esc(track ? `${track.title} · ${latest.mood || '正在听'}` : '还没有听歌记录')}</small>
        </span>
        <em>${charPosts.length}</em>
      </button>
    `;
  }).join('');
  return `
    <section class="music-radio-card scrapbook-panel">
      <div>
        <strong>我的关注</strong>
        <small>角色主页 / 听歌记录</small>
      </div>
      <div class="music-inline-actions">
        <button type="button" class="btn btn-xs btn-soft" data-open-square>逛广场</button>
      </div>
    </section>
    <section class="music-section">
      <div class="music-character-list">${rows || '<div class="music-soft-empty">还没有关注的角色，去广场点头像看看</div>'}</div>
    </section>
  `;
}

function characterSignature(character) {
  const raw = String(
    character?.signature
    || character?.bio
    || character?.summary
    || character?.personality
    || character?.description
    || '',
  ).replace(/\s+/g, ' ').trim();
  return raw.slice(0, 48);
}

function renderCharacterMusicProfile(character, posts, charactersMap, trackById, socialStore, me) {
  if (!character) return '';
  const followed = new Set(socialStore.followingCharacterIds || []).has(character.id);
  const profile = (socialStore.profiles && socialStore.profiles[character.id]) || {};
  const charPosts = posts.filter((post) => post.characterId === character.id);
  const charTracks = uniqueTracksByProvider(charPosts.map((post) => trackById(post.trackId)).filter(Boolean));
  const recentTracks = charTracks.slice(0, 8);
  const signature = (profile.signature || '').trim() || characterSignature(character) || '';
  const postsHtml = charPosts.map((post) => postCardHtml(post, charactersMap, trackById, me)).filter(Boolean).join('');
  const recentHtml = recentTracks.map((track) => `
    <button type="button" class="music-cover-card" data-play-track="${esc(track.id)}">
      ${trackCoverHtml(track)}
      <strong>${esc(track.title)}</strong>
      <small>${esc(track.artist || '')}</small>
    </button>
  `).join('');
  const coverStyle = profile.bg ? ` style="background-image:url('${esc(profile.bg)}')"` : '';
  return `
    <section class="music-character-cover ${profile.bg ? 'has-bg' : ''}"${coverStyle}>
      <div class="music-character-cover-top">
        <button type="button" class="music-character-back" data-close-music-character aria-label="返回">${icon('back')}</button>
        <button type="button" class="music-character-bg-btn" data-upload-character-bg="${esc(character.id)}">${profile.bg ? '换背景' : '传背景'}</button>
      </div>
      <div class="music-character-cover-body">
        <span class="music-character-profile-avatar">${characterAvatarHtml(character, { className: 'music-post-avatar-img' })}</span>
        <h2>${esc(character.name || character.id)}</h2>
        <p class="music-character-sign">${esc(signature || '还没有个性签名，点「生成主页」让 TA 写一条')}</p>
      </div>
    </section>
    <section class="music-character-bar">
      <div class="music-character-stats">
        <span><em>${charPosts.length}</em> 动态</span>
        <span><em>${charTracks.length}</em> 在听</span>
      </div>
      <div class="music-character-profile-actions">
        <button type="button" class="btn btn-xs btn-outline" data-toggle-music-follow="${esc(character.id)}">${followed ? '已关注' : '+ 关注'}</button>
        <button type="button" class="btn btn-xs btn-primary" data-generate-character-post="${esc(character.id)}">生成主页</button>
      </div>
    </section>
    ${recentTracks.length ? `
      <section class="music-section">
        <div class="music-section-head"><h2>最近在听</h2><span>${recentTracks.length}</span></div>
        <div class="music-cover-strip">${recentHtml}</div>
      </section>
    ` : ''}
    ${charTracks.length ? `
      <section class="music-section">
        <div class="music-section-head"><h2>TA 的歌单</h2><span>${charTracks.length}</span></div>
        <div class="music-track-list">${charTracks.slice(0, 12).map((track) => trackRowHtml(track)).join('')}</div>
      </section>
    ` : ''}
    <section class="music-section">
      <div class="music-section-head"><h2>网抑云动态</h2><span>${charPosts.length}</span></div>
      <div class="music-post-list">${postsHtml || '<div class="music-soft-empty">还没有听歌动态，点上面「生成主页」让 TA 发几条</div>'}</div>
    </section>
  `;
}

function renderProfile({ shellStore, me, posts, tracks, playlists, neteaseConfig, socialStore, charactersMap, trackById }) {
  const myPosts = posts.filter((post) => isUserPost(post, me));
  const followingCount = (socialStore.followingCharacterIds || []).length;
  const fansCount = (socialStore.fansCharacterIds || []).length;
  const coverStyle = me.bg ? ` style="background-image:url('${esc(me.bg)}')"` : '';
  const postsHtml = myPosts.slice(0, 12).map((post) => postCardHtml(post, charactersMap, trackById, me)).filter(Boolean).join('');
  const recentHtml = shellStore.recentTrackIds.map((id) => tracks.find((track) => track.id === id)).filter(Boolean).slice(0, 6).map((track) => trackRowHtml(track)).join('');
  return `
    <section class="music-character-cover music-me-cover ${me.bg ? 'has-bg' : ''}"${coverStyle}>
      <div class="music-character-cover-top">
        <span></span>
        <button type="button" class="music-character-bg-btn" data-edit-profile>编辑资料</button>
      </div>
      <div class="music-character-cover-body">
        <span class="music-character-profile-avatar">${userAvatarHtml(me, 'music-post-avatar-img')}</span>
        <h2>${esc(me.name)}</h2>
        <p class="music-character-sign">${esc(me.signature || '还没有签名，点「编辑资料」写一句')}</p>
      </div>
    </section>
    <section class="music-character-bar">
      <div class="music-character-stats">
        <button type="button" class="music-stat-btn" data-open-music-following><em>${followingCount}</em> 关注</button>
        <span><em>${fansCount}</em> 粉丝</span>
        <span><em>${myPosts.length}</em> 动态</span>
      </div>
      <div class="music-character-profile-actions">
        <button type="button" class="btn btn-xs btn-primary" data-compose-post>发动态</button>
      </div>
    </section>
    <section class="music-section">
      <div class="music-section-head"><h2>我的动态</h2><span>${myPosts.length}</span></div>
      <div class="music-post-list">${postsHtml || '<div class="music-soft-empty">还没有发过动态，点上面「发动态」分享一首歌，等角色来评论</div>'}</div>
    </section>
    <section class="music-provider-card scrapbook-panel">
      <div>
        <strong>网易云音乐</strong>
        <small>试玩版暂未连接后端，正式版可直接扫码登录</small>
      </div>
    </section>
    <section class="music-section">
      <div class="music-section-head"><h2>添加音乐</h2></div>
      <div class="music-source-grid">
        <button type="button" class="music-source-card scrapbook-panel" data-upload-trigger><strong>上传本地音乐</strong><small>从手机选 MP3 / WAV / M4A / FLAC</small></button>
        <button type="button" class="music-source-card scrapbook-panel" data-link-provider><strong>粘贴音乐外链</strong><small>网易云 / QQ / YouTube 链接</small></button>
      </div>
    </section>
    <section class="music-section">
      <div class="music-section-head"><h2>最近播放</h2><span>${shellStore.recentTrackIds.length}</span></div>
      <div class="music-track-list">
        ${recentHtml || '<div class="music-soft-empty">播一首歌，这里就会亮起来</div>'}
      </div>
    </section>
  `;
}

/** 首帧骨架：数据到达前先画出音乐页占位，避免路由「加载中」出现 */
function renderMusicSkeleton(container) {
  container.innerHTML = `
    <div class="page-skeleton" aria-hidden="true">
      <div class="sk-row">
        <span class="sk-block sk-circle"></span>
        <span class="sk-block sk-bar" style="width:26%"></span>
      </div>
      <span class="sk-block" style="height:120px"></span>
      <div class="sk-row"><span class="sk-block sk-circle"></span><span class="sk-block sk-bar" style="width:52%"></span></div>
      <div class="sk-row"><span class="sk-block sk-circle"></span><span class="sk-block sk-bar" style="width:44%"></span></div>
      <div class="sk-row"><span class="sk-block sk-circle"></span><span class="sk-block sk-bar" style="width:58%"></span></div>
    </div>`;
}

export default async function render(container, params = {}) {
  const legacyShareChatId = String(params.shareChatId || '').trim();
  if (legacyShareChatId) {
    sessionStorage.setItem(MUSIC_SHARE_CHAT_KEY, legacyShareChatId);
    navigate('music', {}, true);
    return;
  }

  renderMusicSkeleton(container);
  const shareChatId = String(sessionStorage.getItem(MUSIC_SHARE_CHAT_KEY) || '').trim();
  const shareMode = !!shareChatId;
  const shellStore = readShellStore();
  const [characters, loadedNeteaseConfig, loadedLibrary] = await Promise.all([
    listCharacters({ excludeAnonNpc: true }).catch(() => []),
    loadNeteaseProviderConfig().catch(() => null),
    loadMusicLibrary(),
  ]);
  let neteaseConfig = loadedNeteaseConfig;
  const charactersMap = new Map(characters.map((char) => [char.id, char]));
  let library = loadedLibrary;
  let activeTab = (() => {
    try {
      const wanted = String(sessionStorage.getItem('musicOpenTab') || '').trim();
      sessionStorage.removeItem('musicOpenTab');
      return TABS.some((tab) => tab.id === wanted) ? wanted : 'home';
    } catch (_) {
      return 'home';
    }
  })();
  let activeView = '';
  let query = String(params.query || '').trim();
  let searchComposing = false;
  let currentTrackId = shellStore.recentTrackIds.find((id) => library.tracks.some((track) => track.id === id)) || library.tracks[0]?.id || '';
  let queueTrackIds = library.tracks.map((track) => track.id);
  let selectedPlaylistId = '';
  let playlistPlayMode = 'sequence';
  let singleTrackLoop = shellStore.singleTrackLoop === true;
  let selectedCharacterId = '';
  let isPlaying = !!(activeAudio && !activeAudio.paused && !activeAudio.ended);
  let loadingTrackId = '';
  let mediaSessionBound = false;
  let posts = [...buildCharacterPosts(characters, library.tracks), ...library.posts].slice(0, 20);
  let pendingNeteaseQr = null;
  let listenTogether = { active: false, name: '' };
  let playerLyricsView = false; // 播放页：false=唱片，true=滚动歌词
  let playerLyricTimer = null;
  let lastSyncedPlayerLyricIndex = -1;
  let musicVolumeBeforeDuck = null;
  let searchPaintTimer = null;

  async function refreshListenStatus() {
    try {
      const u = await getCurrentUser();
      const active = await listActiveCompanionSessions(u.id);
      const s = active.find((x) => x.type === 'listen_together');
      listenTogether = s
        ? { active: true, name: characters.find((c) => c.id === s.characterId)?.name || '' }
        : { active: false, name: '' };
    } catch (_) {
      listenTogether = { active: false, name: '' };
    }
  }
  await refreshListenStatus();
  let feedStore = readFeedStore();
  let socialStore = readMusicSocialStore();
  let squareFilter = 'all';
  let currentUser = await getCurrentUser().catch(() => null);

  function meProfile() {
    return {
      id: currentUser?.id || 'user',
      name: shellStore.profileName || currentUser?.nickname || currentUser?.name || '我',
      avatar: shellStore.profileAvatar || currentUser?.avatar || '',
      signature: shellStore.signature || currentUser?.signature || '',
      bg: shellStore.profileBg || '',
    };
  }

  // 跟随当前美化主题：海 / 窗各自有专属 ins 风皮肤（作用域收在 .music-page）。
  let musicThemeClass = '';
  try {
    const prefs = await loadAppearancePrefs();
    const { id, theme } = getActiveTheme(prefs);
    if (isSeaHomeTheme(id, theme)) musicThemeClass = ' music-theme-sea';
    else if (isWindowHomeTheme(id, theme)) musicThemeClass = ' music-theme-window';
  } catch (_) {
    musicThemeClass = '';
  }

  container.className = `page scrapbook-page music-page${musicThemeClass}`;

  function stopPlayerLyricTimer() {
    if (playerLyricTimer) clearInterval(playerLyricTimer);
    playerLyricTimer = null;
    lastSyncedPlayerLyricIndex = -1;
  }

  function syncPlayerPageProgress() {
    const positionMs = activeAudio ? Math.round((activeAudio.currentTime || 0) * 1000) : 0;
    const durationMs = activeAudio?.duration ? Math.round(activeAudio.duration * 1000) : 0;
    const percent = durationMs ? Math.max(0, Math.min(100, Math.round((positionMs / durationMs) * 100))) : 0;
    const progress = container.querySelector('[data-player-progress]');
    if (progress) progress.style.width = `${percent}%`;
    const current = container.querySelector('[data-player-time-current]');
    if (current) current.textContent = formatPlayerTime(positionMs);
    const duration = container.querySelector('[data-player-time-duration]');
    if (duration) duration.textContent = durationMs ? formatPlayerTime(durationMs) : '--:--';
  }

  function syncPlayerPageLyrics(options = {}) {
    syncPlayerPageProgress();
    const lyricsBox = container.querySelector('[data-player-page-lyrics]');
    const lines = lyricsBox ? [...lyricsBox.querySelectorAll('[data-lyric-line]')] : [];
    if (!lines.length) return;
    const positionMs = activeAudio ? Math.round((activeAudio.currentTime || 0) * 1000) : 0;
    let currentIndex = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if ((Number(lines[i].getAttribute('data-time-ms') || 0) || 0) <= positionMs) currentIndex = i;
      else break;
    }
    lines.forEach((line, index) => line.classList.toggle('is-current', index === currentIndex));
    if (options.force || currentIndex !== lastSyncedPlayerLyricIndex) {
      lastSyncedPlayerLyricIndex = currentIndex;
      const currentLine = lines[currentIndex];
      if (lyricsBox && currentLine) {
        const top = currentLine.offsetTop - lyricsBox.offsetTop - (lyricsBox.clientHeight / 2) + (currentLine.clientHeight / 2);
        lyricsBox.scrollTo({ top: Math.max(0, top), behavior: options.force ? 'auto' : 'smooth' });
      }
    }
  }

  function syncPlayerPageEffects() {
    stopPlayerLyricTimer();
    if (activeView !== 'player') return;
    syncPlayerPageLyrics({ force: true });
    playerLyricTimer = setInterval(() => {
      if (activeView !== 'player' || !document.body.contains(container)) {
        stopPlayerLyricTimer();
        return;
      }
      syncPlayerPageLyrics();
    }, 600);
  }

  const trackById = (trackId) => library.tracks.find((track) => track.id === trackId) || null;

  async function reloadLibrary() {
    library = await loadMusicLibrary();
    posts = [...buildCharacterPosts(characters, library.tracks), ...library.posts].slice(0, 20);
    if (!trackById(currentTrackId)) currentTrackId = library.tracks[0]?.id || '';
    queueTrackIds = queueTrackIds.filter((id) => trackById(id));
    if (!queueTrackIds.length) queueTrackIds = library.tracks.map((track) => track.id);
    if (selectedPlaylistId && !library.playlists.some((p) => p.id === selectedPlaylistId)) selectedPlaylistId = '';
  }

  async function refreshMusicFeed(options = {}) {
    if (!neteaseConfig?.enabled || !neteaseConfig?.apiBaseUrl || !neteaseConfig?.accessToken) {
      if (options.manual) showToast('先完成网易云扫码登录');
      return false;
    }
    try {
      const [dailySongs, playlists] = await Promise.all([
        getNeteaseDailySongs(neteaseConfig, { limit: 12 }).catch(() => []),
        getNeteaseRecommendPlaylists(neteaseConfig, { limit: 12 }).catch(() => []),
      ]);
      feedStore = { loadedAt: Date.now(), dailySongs, playlists };
      writeFeedStore(feedStore);
      if (options.manual) showToast('推荐已刷新');
      return true;
    } catch (err) {
      if (options.manual) showToast(err?.message || '刷新推荐失败');
      return false;
    }
  }

  async function ensureMusicFeed() {
    const stale = !feedStore.loadedAt || Date.now() - feedStore.loadedAt > 30 * 60 * 1000;
    const empty = !feedStore.dailySongs.length && !feedStore.playlists.length;
    if ((stale || empty) && neteaseConfig?.accessToken) {
      await refreshMusicFeed().catch(() => false);
      paint();
    }
  }

  async function importFeedSong(index, options = {}) {
    const source = feedStore.dailySongs[index];
    const gestureToken = options.gestureToken || null;
    if (!source) {
      gestureToken?.dispose?.();
      return null;
    }
    try {
      const rows = await importRemoteSongs([source], {
        playlistId: 'pl_netease_daily',
        playlistTitle: '网易云每日推荐',
        mood: '日推',
      });
      const row = rows[0] || null;
      if (row && options.play) await playTrack(row.id, { openPlayer: options.openPlayer === true, gestureToken });
      else gestureToken?.dispose?.();
      return row;
    } catch (err) {
      gestureToken?.dispose?.();
      throw err;
    }
  }

  async function importAndPlayNeteaseSong(song, options = {}) {
    const gestureToken = options.gestureToken || null;
    if (!song) {
      gestureToken?.dispose?.();
      return null;
    }
    try {
      const rows = await importRemoteSongs([song], options);
      const row = rows[0] || null;
      if (row) await playTrack(row.id, { gestureToken });
      else gestureToken?.dispose?.();
      return row;
    } catch (err) {
      gestureToken?.dispose?.();
      throw err;
    }
  }

  function rememberTrack(trackId) {
    if (!trackId) return;
    shellStore.recentTrackIds = [trackId, ...shellStore.recentTrackIds.filter((id) => id !== trackId)].slice(0, 30);
    writeShellStore(shellStore);
  }

  function currentTrack() {
    return trackById(currentTrackId) || library.tracks[0] || null;
  }

  function currentQueue() {
    const list = queueTrackIds.map(trackById).filter(Boolean);
    return list.length ? list : library.tracks;
  }

  function publishPlayerState(patch = {}) {
    const progressOnly = patch.progressOnly === true;
    if (progressOnly && Date.now() - lastPlayerPublishAt < 500) return;
    lastPlayerPublishAt = Date.now();
    const track = currentTrack();
    const lyricLines = track ? timedLyricLines(track) : [];
    const nextPatch = { ...patch };
    publishMusicPlayerState({
      trackId: track?.id || '',
      track: track ? { id: track.id, title: track.title, artist: track.artist, coverUrl: track.coverUrl } : null,
      isPlaying,
      playMode: singleTrackLoop ? 'single' : 'sequence',
      positionMs: activeAudio ? Math.round((activeAudio.currentTime || 0) * 1000) : 0,
      durationMs: activeAudio?.duration ? Math.round(activeAudio.duration * 1000) : 0,
      lyricLines,
      queue: currentQueue().slice(0, 30).map((item) => ({
        id: item.id,
        title: item.title,
        artist: item.artist,
        coverUrl: item.coverUrl,
      })),
      ...nextPatch,
    });
    updateMediaSessionPlaybackState(isPlaying);
  }

  function neteaseReady() {
    if (!neteaseConfig?.enabled) {
      showToast('先在我的主页设置网易云授权');
      activeTab = 'profile';
      paint();
      return false;
    }
    if (!neteaseConfig.apiBaseUrl) {
      showToast('需要 API 代理地址');
      return false;
    }
    return true;
  }

  async function refreshNeteaseProfile() {
    if (!neteaseReady()) return;
    try {
      const result = await loadNeteaseProfile(neteaseConfig);
      neteaseConfig = result.config;
      showToast(result.profile?.nickname ? `已登录：${result.profile.nickname}` : '资料已刷新');
      paint();
    } catch (err) {
      showToast(err?.message || '刷新资料失败');
    }
  }

  async function refreshNeteasePlayableTrack(track) {
    if (!track || (track.source !== 'netease' && track.provider !== 'netease')) return track;
    if (track.playUrl && (!track.playUrlExpireAt || Number(track.playUrlExpireAt) > Date.now())) return track;
    if (!neteaseConfig?.apiBaseUrl) return track;
    const play = await getNeteaseSongPlayUrl(neteaseConfig, track);
    const playUrl = String(play.playUrl || play.url || play.data?.playUrl || play.data?.url || '').trim();
    if (!playUrl) {
      throw new Error(play.message || play.msg || play.data?.message || play.data?.msg || '网易云没有返回可播放链接');
    }
    const row = await saveMusicTrack({
      ...track,
      playUrl,
      playUrlExpireAt: Number(play.playUrlExpireTime || play.expireTime || 0) || (Date.now() + 20 * 60 * 1000),
      playFlag: play.playFlag ?? track.playFlag,
      visible: play.visible ?? track.visible,
      vipFlag: play.vipFlag ?? track.vipFlag,
      vipPlayFlag: play.vipPlayFlag ?? track.vipPlayFlag,
      payPlayFlag: play.payPlayFlag ?? track.payPlayFlag,
      freeTrailFlag: play.freeTrailFlag ?? track.freeTrailFlag,
      freeTrail: play.freeTrail || track.freeTrail,
      freeTrialPrivilege: play.freeTrialPrivilege || track.freeTrialPrivilege,
      songFee: play.songFee ?? track.songFee,
      level: play.level || track.level,
      plLevel: play.plLevel || track.plLevel,
      maxBrLevel: play.maxBrLevel || track.maxBrLevel,
      br: play.br || track.br,
      songSize: play.songSize || play.size || track.songSize,
      songMd5: play.songMd5 || play.md5 || track.songMd5,
      gain: play.gain ?? track.gain,
      peak: play.peak ?? track.peak,
      openApiTraceInfo: play.openApiTraceInfo || track.openApiTraceInfo,
      providerRaw: { ...(track.providerRaw || {}), play },
    });
    await reloadLibrary();
    return row;
  }

  async function fetchNeteaseLyricsForTrack(trackId, options = {}) {
    let track = trackById(trackId);
    if (!track || (track.source !== 'netease' && track.provider !== 'netease')) return track;
    if (!options.force && lyricOf(track)) return track;
    if (!neteaseReady()) return track;
    const songId = track.providerTrackId || track.id.replace(/^netease_/, '');
    try {
      const data = await getNeteaseSongLyrics(neteaseConfig, songId);
      if (!data || data.noLyric) {
        showToast('这首歌没有歌词');
        return track;
      }
      const lyricLrc = data.lyric || data.lrc?.lyric || data.lrc || '';
      const trans = data.transLyric || data.tlyric?.lyric || data.tlyric || '';
      const roma = data.romalrc?.lyric || data.romalrc || '';
      const lyricText = data.txtLyric || data.klyric?.lyric || data.klyric || '';
      if (!String(lyricLrc || trans || roma || lyricText).trim()) {
        showToast('这首歌没有歌词');
        return track;
      }
      track = await updateTrackLyrics(track.id, {
        lyricLrc,
        lyricText: [lyricText, trans, roma].filter(Boolean).join('\n\n'),
      });
      await reloadLibrary();
      return track;
    } catch (err) {
      if (options.force) showToast(err?.message || '拉取歌词失败');
      return track;
    }
  }

  function setQueueFromPlaylist(playlistId) {
    const playlist = library.playlists.find((item) => item.id === playlistId);
    const ids = playlist?.trackIds?.filter((id) => trackById(id)) || [];
    if (ids.length) {
      queueTrackIds = playlistPlayMode === 'shuffle' ? shuffleIds(ids) : ids;
      selectedPlaylistId = playlistId;
    }
  }

  function restoreSearchFocus(caret = null) {
    const input = container.querySelector('[data-music-search]');
    if (!input) return;
    try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
    const pos = Math.max(0, Math.min(input.value.length, Number(caret ?? input.value.length) || 0));
    try { input.setSelectionRange(pos, pos); } catch (_) {}
  }

  // 搜索框的 × 按钮是唯一会随 query 增删的头部元素，单独维护，
  // 避免为了它把整个头部（含输入框本身）也塞进局部重绘范围。
  function updateSearchClearButton() {
    const box = container.querySelector('.music-search');
    if (!box) return;
    const existing = box.querySelector('[data-clear-search]');
    if (query) {
      if (existing) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-clear-search', '');
      btn.setAttribute('aria-label', '清空');
      btn.textContent = '×';
      btn.addEventListener('click', () => {
        query = '';
        const input = container.querySelector('[data-music-search]');
        if (input) input.value = '';
        updateSearchClearButton();
        paintSearchBody();
        restoreSearchFocus(0);
      });
      box.appendChild(btn);
    } else if (existing) {
      existing.remove();
    }
  }

  // 搜索输入只重绘结果区（<main>），不碰输入框本身：
  // 之前每次打字都整页 innerHTML 重建，输入框被销毁重建再手动 focus，
  // 移动端上这个「摧毁-重建-抢焦点」的过程会让键盘闪一下甚至收起，
  // 概率复现且和输入内容无关，本质是重绘范围过大，不是字段匹配的问题。
  function paintSearchBody() {
    if (searchPaintTimer) {
      clearTimeout(searchPaintTimer);
      searchPaintTimer = null;
    }
    const main = container.querySelector('main.music-scroll');
    if (!main) { paint(); return; }
    const prevScroll = main.scrollTop || 0;
    main.innerHTML = tabBody();
    main.scrollTop = prevScroll;
    updateSearchClearButton();
    bindEvents(main);
    syncPlayerPageEffects();
    applyLoadingState();
  }

  function scheduleSearchPaint() {
    if (searchPaintTimer) clearTimeout(searchPaintTimer);
    searchPaintTimer = setTimeout(() => {
      searchPaintTimer = null;
      paintSearchBody();
    }, 120);
  }

  function shuffleIds(ids = []) {
    const list = [...ids];
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  // 播放反馈：点了播放到真正出声之间会有取链/缓冲的空窗，
  // 用按钮上的转圈即时回应，避免用户以为没点上、反复猛戳。
  function applyLoadingState() {
    if (!container) return;
    const active = !!loadingTrackId;
    container.querySelectorAll('[data-play-track]').forEach((btn) => {
      btn.classList.toggle('is-loading', active && btn.getAttribute('data-play-track') === loadingTrackId);
    });
    container.querySelectorAll('[data-toggle-play]').forEach((btn) => {
      btn.classList.toggle('is-loading', active && loadingTrackId === currentTrackId);
    });
  }

  function setLoadingTrack(trackId) {
    loadingTrackId = trackId || '';
    applyLoadingState();
  }

  function clearLoadingTrack(trackId = null) {
    if (trackId && loadingTrackId !== trackId) return;
    loadingTrackId = '';
    applyLoadingState();
  }

  function stopActiveAudio() {
    musicVolumeBeforeDuck = null;
    if (activeAudio) {
      try {
        activeAudio.onended = null;
        activeAudio.ontimeupdate = null;
        activeAudio.onpause = null;
        activeAudio.onplay = null;
        activeAudio.onplaying = null;
        activeAudio.oncanplay = null;
        activeAudio.onwaiting = null;
        activeAudio.onerror = null;
        activeAudio.pause();
        activeAudio.src = '';
        activeAudio.load?.();
      } catch (_) {}
      activeAudio = null;
    }
    if (activeAudioUrl && activeAudioUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(activeAudioUrl); } catch (_) {}
    }
    activeAudioUrl = '';
    resumeSilentKeepAliveAudio();
  }

  function markMusicAudioPlaying(audio) {
    if (activeAudio !== audio) return;
    isPlaying = true;
    suspendSilentKeepAliveAudio();
    publishPlayerState();
  }

  function markMusicAudioStopped(audio) {
    if (activeAudio !== audio) return;
    isPlaying = false;
    resumeSilentKeepAliveAudio();
    publishPlayerState();
  }

  function bindMediaSessionHandlers() {
    if (!hasMediaSession() || mediaSessionBound) return;
    const handlers = {
      play: () => { void togglePlay().then(() => paint()); },
      pause: () => { void togglePlay().then(() => paint()); },
      previoustrack: () => { void nextTrack(-1).then(() => paint()); },
      nexttrack: () => { void nextTrack(1).then(() => paint()); },
      seekto: (details) => {
        if (!activeAudio || typeof details?.seekTime !== 'number') return;
        try { activeAudio.currentTime = details.seekTime; } catch (_) {}
        publishPlayerState();
      },
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
    }
    mediaSessionBound = true;
  }

  async function playTrack(trackId, options = {}) {
    const gestureToken = options.gestureToken || null;
    // iOS Safari 只会可靠放行用户手势解锁过的媒体元素。自动下一首、主屏切歌
    // 和系统媒体键都没有新的 click 手势，因此这几条链路要沿用当前 Audio。
    const reusableAudio = options.reuseActiveAudio === activeAudio ? activeAudio : null;
    const reusableAudioUrl = reusableAudio ? activeAudioUrl : '';
    const requestSeq = ++playRequestSeq;
    let track = trackById(trackId);
    if (!track) {
      gestureToken?.dispose?.();
      return;
    }
    if (options.playlistId && !options.keepQueue) setQueueFromPlaylist(options.playlistId);
    if (!queueTrackIds.includes(track.id)) queueTrackIds = [track.id, ...queueTrackIds];
    currentTrackId = track.id;
    rememberTrack(track.id);
    setLoadingTrack(track.id);
    if (!reusableAudio) stopActiveAudio();
    isPlaying = false;
    publishPlayerState();
    let playUrlFailed = false;
    if (track.source === 'netease' || track.provider === 'netease') {
      const needsPlayUrl = !(track.playUrl && (!track.playUrlExpireAt || Number(track.playUrlExpireAt) > Date.now()));
      if (needsPlayUrl) showToast('正在获取播放链接…');
      try {
        track = await refreshNeteasePlayableTrack(track);
        if (requestSeq !== playRequestSeq) {
          gestureToken?.dispose?.();
          clearLoadingTrack(trackId);
          return;
        }
        fetchNeteaseLyricsForTrack(track.id).then((nextTrack) => {
          if (nextTrack?.id === currentTrackId) publishPlayerState();
          paint();
        }).catch(() => {});
      } catch (err) {
        if (requestSeq !== playRequestSeq) {
          gestureToken?.dispose?.();
          clearLoadingTrack(trackId);
          return;
        }
        playUrlFailed = true;
        showToast(err?.message || '获取播放链接失败');
      }
    }
    if (playUrlFailed) {
      gestureToken?.dispose?.();
      if (reusableAudio && activeAudio === reusableAudio) stopActiveAudio();
      clearLoadingTrack(track.id);
      publishPlayerState();
      paint();
      return;
    }
    const nextAudioUrl = createAudioUrlForTrack(track);
    if (track.source === 'local' && !nextAudioUrl) {
      gestureToken?.dispose?.();
      if (reusableAudio && activeAudio === reusableAudio) stopActiveAudio();
      isPlaying = false;
      clearLoadingTrack(track.id);
      showToast('本地音频文件缺失，请重新导入同名文件恢复');
      publishPlayerState();
      paint();
      return;
    }
    if ((track.source === 'netease' || track.provider === 'netease') && !nextAudioUrl) {
      gestureToken?.dispose?.();
      if (reusableAudio && activeAudio === reusableAudio) stopActiveAudio();
      isPlaying = false;
      clearLoadingTrack(track.id);
      showToast('这首歌暂时拿不到可播放音源，换一首或稍后再试');
      publishPlayerState();
      paint();
      return;
    }
    if (requestSeq !== playRequestSeq) {
      gestureToken?.dispose?.();
      clearLoadingTrack(trackId);
      return;
    }
    if (nextAudioUrl && (track.source === 'local' || track.source === 'netease' || track.provider === 'netease')) {
      let audio;
      if (reusableAudio && activeAudio === reusableAudio) {
        // 不调用 load()，只在同一个已获播放许可的元素上换 src；Safari 会把它视为
        // 同一段连续播放，而不是一次新的无手势自动播放请求。
        activeAudioUrl = nextAudioUrl;
        audio = takePlayableAudio(nextAudioUrl, { audio: reusableAudio });
        if (reusableAudioUrl && reusableAudioUrl !== nextAudioUrl && reusableAudioUrl.startsWith('blob:')) {
          try { URL.revokeObjectURL(reusableAudioUrl); } catch (_) {}
        }
      } else {
        stopActiveAudio();
        activeAudioUrl = nextAudioUrl;
        audio = audioFromGestureOrNew(nextAudioUrl, gestureToken);
      }
      if (!audio) {
        gestureToken?.dispose?.();
        isPlaying = false;
        clearLoadingTrack(track.id);
        publishPlayerState();
        paint();
        return;
      }
      audio.preload = 'auto';
      audio.setAttribute('playsinline', 'true');
      audio.loop = singleTrackLoop;
      musicVolumeBeforeDuck = null;
      activeAudio = audio;
      bindMediaSessionHandlers();
      updateMediaSessionMetadata(track);
      audio.onended = () => { if (activeAudio === audio) void nextTrack(1, { reuseActiveAudio: audio }); };
      audio.ontimeupdate = () => { if (activeAudio === audio) publishPlayerState({ progressOnly: true }); };
      audio.onpause = () => markMusicAudioStopped(audio);
      audio.onplay = () => markMusicAudioPlaying(audio);
      // 真正出声/可播放才撤掉转圈；缓冲卡顿时再次转圈，给出真实状态。
      audio.onplaying = () => {
        if (activeAudio !== audio) return;
        clearLoadingTrack(track.id);
        markMusicAudioPlaying(audio);
      };
      audio.oncanplay = () => { if (activeAudio === audio) clearLoadingTrack(track.id); };
      audio.onwaiting = () => { if (activeAudio === audio) setLoadingTrack(track.id); };
      audio.onerror = () => {
        if (activeAudio !== audio) return;
        markMusicAudioStopped(audio);
        clearLoadingTrack(track.id);
        showToast('音频加载失败，检查网络或在歌曲菜单里「刷新播放」');
        paint();
      };
      audio.play().catch(() => {
        if (activeAudio !== audio) return;
        markMusicAudioStopped(audio);
        clearLoadingTrack(track.id);
        showToast('浏览器拦截了自动播放，再点一次试试');
        paint();
      });
      showToast(`正在播放：${track.title}`);
    } else if ((track.source === 'netease' || track.provider === 'netease') && !activeAudioUrl) {
      gestureToken?.dispose?.();
      isPlaying = false;
      clearLoadingTrack(track.id);
      showToast('播放链接已过期或未获取，需要重新向网易云请求');
    } else if (track.source === 'link' && track.sourceUrl) {
      gestureToken?.dispose?.();
      isPlaying = false;
      clearLoadingTrack(track.id);
      showToast('外链已保存，暂不在应用内直播放');
    } else {
      gestureToken?.dispose?.();
      isPlaying = false;
      clearLoadingTrack(track.id);
      showToast(`已选中：${track.title}`);
    }
    publishPlayerState();
    if (options.openPlayer) activeView = 'player';
    paint();
  }

  async function togglePlay(options = {}) {
    const gestureToken = options.gestureToken || null;
    const track = currentTrack();
    if (!track) {
      gestureToken?.dispose?.();
      return;
    }
    if (activeAudio && isPlaying) {
      activeAudio.pause();
      isPlaying = false;
      publishPlayerState();
      paint();
      return;
    }
    if (activeAudio && !isPlaying) {
      try {
        await activeAudio.play();
        markMusicAudioPlaying(activeAudio);
      } catch (_) {
        markMusicAudioStopped(activeAudio);
        showToast('浏览器拦截了自动播放，再点一次试试');
      }
      paint();
      return;
    }
    await playTrack(track.id, { gestureToken });
  }

  function duckMusicVolume(level = 0.24) {
    if (!activeAudio) return false;
    if (musicVolumeBeforeDuck === null) musicVolumeBeforeDuck = activeAudio.volume;
    const next = Math.max(0.05, Math.min(1, Number(level) || 0.24));
    activeAudio.volume = Math.min(activeAudio.volume || 1, next);
    return true;
  }

  function restoreMusicVolume() {
    if (!activeAudio || musicVolumeBeforeDuck === null) return false;
    activeAudio.volume = musicVolumeBeforeDuck;
    musicVolumeBeforeDuck = null;
    return true;
  }

  async function nextTrack(delta = 1, options = {}) {
    const gestureToken = options.gestureToken || null;
    const queue = currentQueue();
    if (!queue.length) {
      gestureToken?.dispose?.();
      return;
    }
    const idx = Math.max(0, queue.findIndex((track) => track.id === currentTrackId));
    const next = queue[(idx + delta + queue.length) % queue.length];
    const reuseActiveAudio = options.reuseActiveAudio
      || (!gestureToken ? activeAudio : null);
    await playTrack(next.id, { gestureToken, reuseActiveAudio });
  }

  function toggleSingleTrackLoop() {
    singleTrackLoop = !singleTrackLoop;
    shellStore.singleTrackLoop = singleTrackLoop;
    writeShellStore(shellStore);
    if (activeAudio) activeAudio.loop = singleTrackLoop;
    publishPlayerState();
    showToast(singleTrackLoop ? '已开启单曲循环' : '已恢复顺序播放');
    paint();
  }

  async function shareTrack(trackId) {
    const track = trackById(trackId);
    if (!track) return;
    if (!shareChatId) {
      showToast('可以从聊天里的音乐分享入口进入');
      return;
    }
    try {
      const user = currentUser || await getCurrentUser().catch(() => null);
      await saveMusicShareToChat({
        chatId: shareChatId,
        user,
        track,
        timestamp: await getNowForUser(user?.id || ''),
      });
      sessionStorage.removeItem(MUSIC_SHARE_CHAT_KEY);
      sessionStorage.removeItem(`pendingMusic_${shareChatId}`);
      navigate('chat/thread', { chatId: shareChatId }, true);
    } catch (error) {
      showToast(error?.message || '转发失败，请重试');
    }
  }

  async function addTrackToPlaylist(trackId) {
    const track = trackById(trackId);
    if (!track) return;
    const target = library.playlists[0] || await createMusicPlaylist('我的收藏');
    await addTracksToPlaylist(target.id, [track.id]);
    await reloadLibrary();
    showToast(`已加入「${target.title}」`);
    paint();
  }

  async function removeOrDeleteTrack(trackId, playlistId = '', mode = 'ask') {
    const track = trackById(trackId);
    if (!track) return;
    const isNetease = track.source === 'netease' || track.provider === 'netease';
    if (mode === 'delete') {
      const message = isNetease
        ? `从棉花糖机音乐库删除「${track.title}」？不会影响网易云收藏或原歌单。`
        : `从本机音乐库删除「${track.title}」？`;
      if (!window.confirm(message)) return;
      await deleteMusicTrack(track.id);
      shellStore.recentTrackIds = shellStore.recentTrackIds.filter((id) => id !== track.id);
      writeShellStore(shellStore);
      showToast('歌曲已删除');
    } else if (mode === 'remove' && playlistId) {
      const playlist = library.playlists.find((item) => item.id === playlistId);
      const suffix = isNetease ? '，不会影响网易云原歌单' : '';
      if (!window.confirm(`从「${playlist?.title || '当前歌单'}」移除「${track.title}」？只修改棉花糖机里的歌单副本${suffix}。`)) return;
      await removeTrackFromPlaylist(playlistId, track.id);
      showToast('已从歌单移除');
    } else {
      return;
    }
    await reloadLibrary();
    paint();
  }

  function openTrackMenu(trackId, playlistId = '') {
    const track = trackById(trackId);
    if (!track) return;
    const isNetease = track.source === 'netease' || track.provider === 'netease';
    openModal(`
      <div class="music-modal-card scrapbook-panel">
        <div class="music-modal-head">
          <strong>${esc(track.title)}</strong>
          <button type="button" data-modal-close aria-label="关闭">${icon('close')}</button>
        </div>
        <div class="music-track-menu-cover">
          ${trackCoverHtml(track)}
          <div>
            <strong>${esc(track.artist || '未知歌手')}</strong>
            <small>${esc([formatSource(track), track.mood].filter(Boolean).join(' · '))}</small>
          </div>
        </div>
        <div class="music-track-menu-actions">
          <button type="button" class="btn btn-primary" data-menu-play>播放</button>
          <button type="button" class="btn btn-outline" data-menu-lyrics>歌词</button>
          <button type="button" class="btn btn-soft" data-menu-add>加入歌单</button>
          ${track.source === 'link' && track.sourceUrl ? '<button type="button" class="btn btn-outline" data-menu-open-link>打开外链</button>' : ''}
          ${isNetease ? '<button type="button" class="btn btn-outline" data-menu-similar>相似歌曲</button>' : ''}
          ${isNetease ? '<button type="button" class="btn btn-outline" data-menu-heart>心动模式</button>' : ''}
          ${isNetease ? '<button type="button" class="btn btn-outline" data-menu-more>更多推荐</button>' : ''}
          ${isNetease ? '<button type="button" class="btn btn-outline" data-menu-refresh-url>刷新播放</button>' : ''}
          ${playlistId ? '<button type="button" class="btn btn-outline" data-menu-remove>移出当前歌单</button>' : ''}
          <button type="button" class="btn btn-outline is-danger" data-menu-delete>${isNetease ? '从本机音乐库删除' : '删除歌曲'}</button>
        </div>
      </div>
    `, (wrap, close) => {
      wrap.querySelector('[data-menu-play]')?.addEventListener('click', async () => {
        close();
        await playTrack(track.id, { playlistId });
      });
      wrap.querySelector('[data-menu-lyrics]')?.addEventListener('click', () => {
        close();
        void editLyrics(track.id);
      });
      wrap.querySelector('[data-menu-add]')?.addEventListener('click', async () => {
        close();
        await addTrackToPlaylist(track.id);
      });
      wrap.querySelector('[data-menu-open-link]')?.addEventListener('click', () => {
        if (track.sourceUrl) window.open(track.sourceUrl, '_blank', 'noopener');
      });
      wrap.querySelector('[data-menu-similar]')?.addEventListener('click', async () => {
        close();
        await openNeteaseSimilar(track.id);
      });
      wrap.querySelector('[data-menu-heart]')?.addEventListener('click', async () => {
        close();
        await openNeteaseHeartMode(track.id);
      });
      wrap.querySelector('[data-menu-more]')?.addEventListener('click', async () => {
        close();
        await openNeteaseMore();
      });
      wrap.querySelector('[data-menu-refresh-url]')?.addEventListener('click', async () => {
        close();
        try {
          await refreshNeteasePlayableTrack(track);
          showToast('播放链接已刷新');
          paint();
        } catch (err) {
          showToast(err?.message || '刷新播放链接失败');
        }
      });
      wrap.querySelector('[data-menu-remove]')?.addEventListener('click', async () => {
        close();
        await removeOrDeleteTrack(track.id, playlistId, 'remove');
      });
      wrap.querySelector('[data-menu-delete]')?.addEventListener('click', async () => {
        close();
        await removeOrDeleteTrack(track.id, playlistId, 'delete');
      });
    });
  }

  async function playPlaylist(playlistId, options = {}) {
    const gestureToken = options.gestureToken || null;
    const playlist = library.playlists.find((item) => item.id === playlistId);
    const ids = playlist?.trackIds?.filter((id) => trackById(id)) || [];
    const queue = playlistPlayMode === 'shuffle' ? shuffleIds(ids) : ids;
    const trackId = queue[0] || '';
    if (!trackId) {
      gestureToken?.dispose?.();
      showToast('这个歌单还没有可播放的歌');
      return;
    }
    queueTrackIds = queue;
    selectedPlaylistId = playlistId;
    await playTrack(trackId, { playlistId, keepQueue: true, openPlayer: true, gestureToken });
  }

  async function createPlaylist() {
    openPlaylistModal(null);
  }

  function openPlaylistModal(playlistId) {
    const playlist = playlistId ? library.playlists.find((item) => item.id === playlistId) : null;
    let coverUrl = String(playlist?.coverUrl || '').trim();
    const coverPreviewHtml = () => {
      const safeCover = normalizeRemoteCoverUrl(coverUrl) || (/^data:image\//i.test(coverUrl) ? coverUrl : '');
      return safeCover
        ? `<img src="${esc(safeCover)}" alt="" referrerpolicy="no-referrer" decoding="async">`
        : '<span>封面</span>';
    };
    openModal(`
      <div class="music-modal-card scrapbook-panel">
        <div class="music-modal-head">
          <strong>${playlist ? '编辑歌单' : '新建歌单'}</strong>
          <button type="button" data-modal-close aria-label="关闭">${icon('close')}</button>
        </div>
        <label class="form-label">封面</label>
        <div class="music-playlist-cover-edit">
          <div class="music-playlist-cover-preview ${coverUrl ? 'has-image' : ''}" data-playlist-cover-preview>${coverPreviewHtml()}</div>
          <div class="music-playlist-cover-actions">
            <button type="button" class="btn btn-xs btn-soft" data-playlist-cover-upload>上传图片</button>
            <button type="button" class="btn btn-xs btn-outline" data-playlist-cover-clear ${coverUrl ? '' : 'hidden'}>清除</button>
          </div>
        </div>
        <label class="form-label">名称</label>
        <input class="form-input" data-playlist-title value="${esc(playlist?.title || '')}" placeholder="歌单名称">
        <label class="form-label">备注</label>
        <textarea class="form-input music-modal-textarea" data-playlist-desc placeholder="一句备注">${esc(playlist?.desc || '')}</textarea>
        <div class="music-modal-actions">
          ${playlist ? '<button type="button" class="btn btn-outline" data-delete-playlist>删除</button>' : ''}
          <button type="button" class="btn btn-primary" data-save-playlist>保存</button>
        </div>
      </div>
    `, (wrap, close) => {
      const preview = wrap.querySelector('[data-playlist-cover-preview]');
      const clearBtn = wrap.querySelector('[data-playlist-cover-clear]');
      const syncCoverUi = () => {
        if (preview) {
          preview.classList.toggle('has-image', !!coverUrl);
          preview.innerHTML = coverPreviewHtml();
        }
        if (clearBtn) clearBtn.hidden = !coverUrl;
      };
      wrap.querySelector('[data-playlist-cover-upload]')?.addEventListener('click', () => {
        pickImageInto((data) => {
          coverUrl = String(data || '').trim();
          syncCoverUi();
        }, { maxW: 640, quality: 0.8 });
      });
      clearBtn?.addEventListener('click', () => {
        coverUrl = '';
        syncCoverUi();
      });
      wrap.querySelector('[data-save-playlist]')?.addEventListener('click', async () => {
        const title = wrap.querySelector('[data-playlist-title]')?.value || '';
        const desc = wrap.querySelector('[data-playlist-desc]')?.value || '';
        if (!title.trim()) {
          showToast('先写歌单名称');
          return;
        }
        try {
          if (playlist) await saveMusicPlaylist({ ...playlist, title, desc, coverUrl });
          else await createMusicPlaylist(title, { desc, coverUrl });
          close();
          await reloadLibrary();
          activeTab = 'playlists';
          showToast('歌单已保存');
          paint();
        } catch (err) {
          showToast(err?.name === 'QuotaExceededError' ? '封面太大，换张小一点的图' : (err?.message || '保存失败'));
        }
      });
      wrap.querySelector('[data-delete-playlist]')?.addEventListener('click', async () => {
        if (!playlist) return;
        if (!window.confirm(`删除歌单「${playlist.title}」？歌曲本身会保留。`)) return;
        await deleteMusicPlaylist(playlist.id);
        close();
        await reloadLibrary();
        showToast('歌单已删除');
        paint();
      });
      setTimeout(() => wrap.querySelector('[data-playlist-title]')?.focus(), 0);
    });
  }

  async function importAudioFiles(fileList) {
    const imported = await importAudioFilesToLibrary(fileList);
    if (!imported.length) {
      showToast('请选择音频文件');
      return;
    }
    await reloadLibrary();
    currentTrackId = imported[0].id;
    activeTab = 'playlists';
    showToast(`已导入 ${imported.length} 首`);
    paint();
  }

  async function importLink() {
    openModal(`
      <div class="music-modal-card scrapbook-panel">
        <div class="music-modal-head">
          <strong>收藏外链</strong>
          <button type="button" data-modal-close aria-label="关闭">${icon('close')}</button>
        </div>
        <label class="form-label">官方链接</label>
        <input class="form-input" data-link-url placeholder="https://...">
        <label class="form-label">歌曲名</label>
        <input class="form-input" data-link-title placeholder="歌曲名">
        <label class="form-label">歌手</label>
        <input class="form-input" data-link-artist placeholder="歌手">
        <div class="music-modal-actions">
          <button type="button" class="btn btn-outline" data-modal-close>取消</button>
          <button type="button" class="btn btn-primary" data-save-link>保存</button>
        </div>
      </div>
    `, (wrap, close) => {
      wrap.querySelector('[data-save-link]')?.addEventListener('click', async () => {
        const sourceUrl = wrap.querySelector('[data-link-url]')?.value || '';
        const title = wrap.querySelector('[data-link-title]')?.value || '外链歌曲';
        const artist = wrap.querySelector('[data-link-artist]')?.value || '外部平台';
        if (!/^https?:\/\//i.test(sourceUrl.trim())) {
          showToast('请粘贴 http/https 链接');
          return;
        }
        const row = await importMusicLinkToLibrary({ sourceUrl, title, artist });
        close();
        await reloadLibrary();
        currentTrackId = row.id;
        activeTab = 'playlists';
        showToast('外链已收藏');
        paint();
      });
      setTimeout(() => wrap.querySelector('[data-link-url]')?.focus(), 0);
    });
  }

  function openNeteaseSettings() {
    const authUrl = getNeteaseAuthUrl(neteaseConfig, `mm${Date.now()}`);
    const qr = pendingNeteaseQr || neteaseConfig?.qrcode || null;
    const profileName = neteaseConfig?.profile?.nickname || '';
    const apiBaseUrl = neteaseConfig?.apiBaseUrl || DEFAULT_NETEASE_PROXY_URL;
    const providerMode = neteaseConfig?.mode || 'cloudapi';
    openModal(`
      <div class="music-modal-card scrapbook-panel">
        <div class="music-modal-head">
          <strong>网易云授权登录</strong>
          <button type="button" data-modal-close aria-label="关闭">${icon('close')}</button>
        </div>
        <div class="music-provider-status">
          <span>${esc(profileName || (neteaseConfig?.accessToken ? '已授权' : '未登录'))}</span>
          <span>${esc(qr?.message || (qr?.status ? `二维码 ${qr.status}` : ''))}</span>
        </div>
        <div class="music-provider-note">
          <p>点击扫码登录后，用自己的网易云 App 扫码授权。登录的是你的网易云账号。</p>
          <p>二维码约 5 分钟后过期，过期后重新点「扫码登录」即可。</p>
        </div>
        <button type="button" class="cphone-quiet-link music-netease-tutorial-btn" style="display:block;margin:0 0 8px;">卡在检测代理 / 扫码半天没反应？看说明 →</button>
        <div class="music-provider-error" data-netease-error hidden></div>
        ${qr?.qrimg ? `<img class="music-qr-img" src="${esc(qr.qrimg)}" alt="网易云登录二维码">` : ''}
        ${qr?.qrCodeUrl && !qr?.qrimg ? `<a class="music-qr-link" href="${esc(qr.qrCodeUrl)}" target="_blank" rel="noopener">${esc(qr.qrCodeUrl)}</a>` : ''}
        <div class="music-modal-actions music-modal-actions-main">
          <button type="button" class="btn btn-primary" data-netease-qr>扫码登录</button>
          <button type="button" class="btn btn-outline" data-netease-poll>我已扫码</button>
          <button type="button" class="btn btn-soft" data-save-netease>保存</button>
        </div>
        <details class="music-provider-advanced">
          <summary>高级 / 调试</summary>
          <label class="form-label">连接模式</label>
          <select class="form-input" data-netease-mode>
            <option value="cloudapi" ${providerMode === 'cloudapi' ? 'selected' : ''}>网页扫码登录</option>
            <option value="openapi" ${providerMode === 'openapi' ? 'selected' : ''}>开放平台授权</option>
          </select>
          <label class="form-label">App ID（H5 授权调试用）</label>
          <input class="form-input" data-netease-app-id value="${esc(neteaseConfig?.appId || '')}" placeholder="通常不用填写">
          <label class="form-label">API 代理地址</label>
          <input class="form-input" data-netease-api-base value="${esc(apiBaseUrl)}" placeholder="${esc(DEFAULT_NETEASE_PROXY_URL)}">
          <div class="music-provider-advanced-actions">
            <button type="button" class="btn btn-xs btn-outline" data-netease-check-proxy>检测代理</button>
            <button type="button" class="btn btn-xs btn-soft" data-refresh-netease-profile>刷新资料</button>
            <button type="button" class="btn btn-xs btn-soft" data-refresh-netease-token>刷新 token</button>
            <button type="button" class="btn btn-xs btn-soft" data-clear-netease-login>清除登录</button>
          </div>
          <label class="form-label">授权回调地址（H5 授权用，扫码登录可不填）</label>
          <input class="form-input" data-netease-redirect value="${esc(neteaseConfig?.redirectUrl || '')}" placeholder="https://你的域名/callback">
          <label class="form-label">授权 code</label>
          <input class="form-input" data-netease-code placeholder="H5 回调里的 code">
          <div class="music-provider-advanced-actions">
            <button type="button" class="btn btn-xs btn-soft" data-open-netease-auth>H5 授权</button>
            <button type="button" class="btn btn-xs btn-soft" data-exchange-netease-code>换 H5 token</button>
          </div>
        </details>
      </div>
    `, (wrap, close) => {
      wrap.querySelector('.music-netease-tutorial-btn')?.addEventListener('click', () => {
        navigate('tutorial', { section: 'music' });
      });
      const showNeteaseError = (message) => {
        const text = String(message || '网易云操作失败');
        const box = wrap.querySelector('[data-netease-error]');
        if (box) {
          box.hidden = false;
          box.textContent = text;
        }
        showToast(text, 7000);
      };
      const readPatch = () => ({
          enabled: true,
          mode: wrap.querySelector('[data-netease-mode]')?.value || 'cloudapi',
          appId: wrap.querySelector('[data-netease-app-id]')?.value || '',
          apiBaseUrl: wrap.querySelector('[data-netease-api-base]')?.value || '',
          redirectUrl: wrap.querySelector('[data-netease-redirect]')?.value || '',
        });
      wrap.querySelector('[data-save-netease]')?.addEventListener('click', async () => {
        neteaseConfig = await saveNeteaseProviderConfig(readPatch());
        close();
        showToast('网易云配置已保存');
        paint();
      });
      wrap.querySelector('[data-open-netease-auth]')?.addEventListener('click', () => {
        const latest = getNeteaseAuthUrl({
          ...neteaseConfig,
          appId: wrap.querySelector('[data-netease-app-id]')?.value || '',
          redirectUrl: wrap.querySelector('[data-netease-redirect]')?.value || '',
        }, `mm${Date.now()}`);
        if (latest) window.open(latest, '_blank', 'noopener');
        else showToast('先填写 App ID 和回调地址');
      });
      wrap.querySelector('[data-netease-check-proxy]')?.addEventListener('click', async () => {
        try {
          neteaseConfig = await saveNeteaseProviderConfig(readPatch());
          const health = await checkNeteaseProxy(neteaseConfig);
          if (neteaseConfig.mode === 'cloudapi' && !health.cloudApi?.available) showNeteaseError('代理已连上，先启动网易云扫码接口');
          else if (!health.privateKey && neteaseConfig.mode === 'openapi') showToast('代理已连上，但还没填 PrivateKey');
          else if (!health.appId && neteaseConfig.mode === 'openapi') showToast('代理已连上，但还没填 AppID');
          else if (health.cli?.installed) showToast(`代理已连上，CLI ${health.cli.version || '可用'}`);
          else showToast('代理已连上');
        } catch (err) {
          showNeteaseError(err?.message || '代理没有响应');
        }
      });
      wrap.querySelector('[data-netease-qr]')?.addEventListener('click', async () => {
        try {
          neteaseConfig = await saveNeteaseProviderConfig(readPatch());
          const result = await createNeteaseQrLogin(neteaseConfig);
          neteaseConfig = result.config;
          pendingNeteaseQr = result.qrcode || null;
          close();
          showToast('二维码已生成');
          openNeteaseSettings();
          paint();
        } catch (err) {
          showNeteaseError(err?.message || '获取二维码失败');
        }
      });
      wrap.querySelector('[data-netease-poll]')?.addEventListener('click', async () => {
        try {
          neteaseConfig = await saveNeteaseProviderConfig(readPatch());
          const result = await pollNeteaseQrLogin(neteaseConfig);
          neteaseConfig = result.config;
          if (result.status === 803) pendingNeteaseQr = null;
          close();
          if (result.status === 803) {
            showToast('网易云已登录');
            await refreshNeteaseProfile().catch(() => {});
          }
          else showToast(result.message || `二维码状态 ${result.status || ''}`);
          openNeteaseSettings();
          paint();
        } catch (err) {
          showNeteaseError(err?.message || '检查扫码失败');
        }
      });
      wrap.querySelector('[data-exchange-netease-code]')?.addEventListener('click', async () => {
        const code = wrap.querySelector('[data-netease-code]')?.value || '';
        if (!code.trim()) {
          showToast('先粘贴 code');
          return;
        }
        try {
          neteaseConfig = await saveNeteaseProviderConfig(readPatch());
          const result = await exchangeNeteaseCodeForToken(neteaseConfig, code);
          neteaseConfig = result.config;
          close();
          await refreshNeteaseProfile();
          openNeteaseSettings();
        } catch (err) {
          showToast(err?.message || '换 token 失败');
        }
      });
      wrap.querySelector('[data-refresh-netease-token]')?.addEventListener('click', async () => {
        try {
          neteaseConfig = await saveNeteaseProviderConfig(readPatch());
          const result = await refreshNeteaseToken(neteaseConfig);
          neteaseConfig = result.config;
          close();
          showToast('token 已刷新');
          openNeteaseSettings();
          paint();
        } catch (err) {
          showToast(err?.message || '刷新 token 失败');
        }
      });
      wrap.querySelector('[data-refresh-netease-profile]')?.addEventListener('click', async () => {
        neteaseConfig = await saveNeteaseProviderConfig(readPatch());
        close();
        await refreshNeteaseProfile();
        openNeteaseSettings();
      });
      wrap.querySelector('[data-clear-netease-login]')?.addEventListener('click', async () => {
        neteaseConfig = await saveNeteaseProviderConfig({
          ...readPatch(),
          accessToken: '',
          refreshToken: '',
          tokenExpireAt: 0,
          profile: null,
          qrcode: null,
        });
        close();
        showToast('网易云登录态已清除');
        openNeteaseSettings();
        paint();
      });
    });
  }

  async function importRemoteSongs(songs, options = {}) {
    const rows = await importNeteaseSongsToLibrary(songs, options);
    await reloadLibrary();
    if (rows[0] && !options.silent) currentTrackId = rows[0].id;
    if (options.playlistId && !options.silent) selectedPlaylistId = options.playlistId;
    if (options.goToPlaylist && options.playlistId && !options.silent) {
      activeTab = 'playlists';
      activeView = '';
    }
    if (!options.silent) {
      showToast(rows.length ? `已收藏 ${rows.length} 首` : '没有可收藏的歌曲');
      paint();
    }
    return rows;
  }

  function openNeteaseSongResults(title, songs, options = {}) {
    const normalized = songs.map((song) => normalizeNeteaseSong(song, options));
    openModal(`
      <div class="music-modal-card scrapbook-panel">
        <div class="music-modal-head">
          <strong>${esc(title)}</strong>
          <button type="button" data-modal-close aria-label="关闭">${icon('close')}</button>
        </div>
        ${normalized.length && options.goToPlaylist ? `
          <div class="music-modal-actions music-modal-actions-main">
            <button type="button" class="btn btn-primary" data-import-all-netease>${esc(options.importAllLabel || '整张加入歌单页')}</button>
          </div>
        ` : ''}
        <div class="music-remote-list">
          ${normalized.length ? normalized.map((track, index) => neteaseResultRowHtml(track, { index })).join('') : '<div class="music-soft-empty">没有结果</div>'}
        </div>
        <div class="music-modal-actions">
          ${normalized.length ? `<button type="button" class="btn btn-primary" data-import-all-netease>${esc(options.importAllLabel || '全部收藏')}</button>` : ''}
        </div>
      </div>
    `, (wrap, close) => {
      wrap.querySelectorAll('[data-play-netease-result]').forEach((btn) => {
        btn.addEventListener('click', async (event) => {
          const index = Number(btn.getAttribute('data-play-netease-result') || 0) || 0;
          const gestureToken = captureMediaGesture(event);
          close();
          await importAndPlayNeteaseSong(songs[index], { ...options, gestureToken });
        });
      });
      wrap.querySelectorAll('[data-import-netease-song]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const index = Number(btn.getAttribute('data-import-netease-song') || 0) || 0;
          close();
          await importRemoteSongs([songs[index]], options);
        });
      });
      wrap.querySelectorAll('[data-import-all-netease]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          close();
          await importRemoteSongs(songs, options);
        });
      });
    });
  }

  async function searchNetease(searchText = query) {
    if (!neteaseReady()) return;
    const keyword = String(searchText || '').trim();
    if (!keyword) {
      showToast('先输入歌名或歌手');
      return;
    }
    try {
      showToast('正在搜索网易云');
      const songs = await searchNeteaseSongs(neteaseConfig, keyword);
      openNeteaseSongResults(`网易云搜索 · ${keyword}`, songs, {
        playlistId: 'pl_netease_search',
        playlistTitle: '网易云搜索',
      });
    } catch (err) {
      showToast(err?.message || '网易云搜索失败');
    }
  }

  async function openNeteaseDaily() {
    if (!neteaseReady()) return;
    try {
      const [songs, coverResult] = await Promise.all([
        getNeteaseDailySongs(neteaseConfig, { limit: 30 }),
        getNeteaseDailyImage(neteaseConfig).catch(() => null),
      ]);
      if (coverResult?.config) neteaseConfig = coverResult.config;
      openNeteaseSongResults('每日推荐', songs, {
        playlistId: 'pl_netease_daily',
        playlistTitle: coverResult?.image?.name || '网易云每日推荐',
        mood: '日推',
      });
    } catch (err) {
      showToast(err?.message || '获取日推失败');
    }
  }

  async function openNeteasePlaylists() {
    if (!neteaseReady()) return;
    try {
      const playlists = await getNeteaseRecommendPlaylists(neteaseConfig, { limit: 20 });
      openModal(`
        <div class="music-modal-card scrapbook-panel">
          <div class="music-modal-head">
            <strong>推荐歌单</strong>
            <button type="button" data-modal-close aria-label="关闭">${icon('close')}</button>
          </div>
          <div class="music-remote-list">
            ${playlists.length ? playlists.map((item, index) => neteasePlaylistRowHtml(item, { index })).join('') : '<div class="music-soft-empty">没有结果</div>'}
          </div>
        </div>
      `, (wrap, close) => {
        wrap.querySelectorAll('[data-open-netease-playlist]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const index = Number(btn.getAttribute('data-open-netease-playlist') || 0) || 0;
            const item = playlists[index];
            if (!item) return;
            close();
            await openNeteasePlaylistDetail(item);
          });
        });
      });
    } catch (err) {
      showToast(err?.message || '获取推荐歌单失败');
    }
  }

  async function openNeteaseUserPlaylists() {
    if (!neteaseReady()) return;
    try {
      const playlists = await getNeteaseUserPlaylists(neteaseConfig, { limit: 50 });
      openModal(`
        <div class="music-modal-card scrapbook-panel">
          <div class="music-modal-head">
            <strong>我的网易云歌单</strong>
            <button type="button" data-modal-close aria-label="关闭">${icon('close')}</button>
          </div>
          <div class="music-remote-list">
            ${playlists.length ? playlists.map((item, index) => neteasePlaylistRowHtml(item, { index })).join('') : '<div class="music-soft-empty">暂时没有可导入的歌单</div>'}
          </div>
        </div>
      `, (wrap, close) => {
        wrap.querySelectorAll('[data-open-netease-playlist]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const index = Number(btn.getAttribute('data-open-netease-playlist') || 0) || 0;
            const item = playlists[index];
            if (!item) return;
            close();
            await openNeteasePlaylistDetail(item);
          });
        });
      });
    } catch (err) {
      showToast(err?.message || '获取网易云歌单失败');
    }
  }

  async function openNeteasePlaylistDetail(item) {
    if (!neteaseReady()) return;
    const playlistId = item?.id || item?.playlistId;
    if (!playlistId) {
      showToast('歌单缺少 ID');
      return;
    }
    try {
      showToast('正在打开歌单');
      const detail = await getNeteasePlaylistDetail(neteaseConfig, playlistId).catch(() => null);
      const songs = await importNeteasePlaylistSongs(neteaseConfig, playlistId, { encryptedId: item.encryptedId });
      openNeteaseSongResults(detail?.name || item.name || item.title || '网易云歌单', songs, {
        playlistId: `netease_pl_${playlistId}`,
        playlistTitle: detail?.name || item.name || item.title || '网易云歌单',
        providerPlaylistId: playlistId,
        goToPlaylist: true,
        importAllLabel: '整张加入歌单页',
        trialScene: detail?.allFreeTrialFlag ? 'playlist_trial' : '',
      });
    } catch (err) {
      showToast(err?.message || '打开歌单失败');
    }
  }

  async function importNeteasePlaylist(item) {
    if (!neteaseReady()) return;
    const playlistId = item.id || item.playlistId;
    if (!playlistId) {
      showToast('歌单缺少 ID');
      return;
    }
    try {
      showToast('正在收藏歌单');
      const detail = await getNeteasePlaylistDetail(neteaseConfig, playlistId).catch(() => null);
      const songs = await importNeteasePlaylistSongs(neteaseConfig, playlistId, { encryptedId: item.encryptedId });
      await importRemoteSongs(songs, {
        playlistId: `netease_pl_${playlistId}`,
        playlistTitle: detail?.name || item.name || item.title || '网易云歌单',
        providerPlaylistId: playlistId,
        trialScene: detail?.allFreeTrialFlag ? 'playlist_trial' : '',
        goToPlaylist: true,
      });
    } catch (err) {
      showToast(err?.message || '收藏歌单失败');
    }
  }

  async function openNeteaseSimilar(trackId) {
    const track = trackById(trackId);
    if (!track || !neteaseReady()) return;
    const songId = track.providerTrackId || track.id.replace(/^netease_/, '');
    try {
      const songs = await getNeteaseSimilarSongs(neteaseConfig, songId, { limit: 20 });
      openNeteaseSongResults(`相似歌曲 · ${track.title}`, songs, {
        playlistId: 'pl_netease_similar',
        playlistTitle: '相似歌曲',
      });
    } catch (err) {
      showToast(err?.message || '获取相似歌曲失败');
    }
  }

  async function openNeteaseHeartMode(trackId) {
    const track = trackById(trackId);
    if (!track || !neteaseReady()) return;
    const playlist = library.playlists.find((item) => item.trackIds?.includes(track.id) && item.id.startsWith('netease_pl_'))
      || library.playlists.find((item) => item.trackIds?.includes(track.id));
    const playlistId = track.providerPlaylistId || playlist?.id?.replace(/^netease_pl_/, '') || '';
    if (!playlistId) {
      showToast('心动模式需要先打开并收藏网易云歌单');
      return;
    }
    try {
      const songId = track.providerTrackId || track.id.replace(/^netease_/, '');
      const songs = await getNeteaseHeartModeSongs(neteaseConfig, { playlistId, songId, type: 'fromPlayOne', count: 30 });
      openNeteaseSongResults(`心动模式 · ${track.title}`, songs, {
        playlistId: 'pl_netease_heart',
        playlistTitle: '心动模式',
      });
    } catch (err) {
      showToast(err?.message || '心动模式失败');
    }
  }

  async function openNeteaseMore() {
    if (!neteaseReady()) return;
    const ids = currentQueue()
      .map((track) => track.providerTrackId || (track.provider === 'netease' ? track.id.replace(/^netease_/, '') : ''))
      .filter(Boolean)
      .slice(0, 30);
    if (!ids.length) {
      showToast('先播放或收藏几首网易云歌曲');
      return;
    }
    try {
      const songs = await getNeteaseMoreSongs(neteaseConfig, { songIds: ids, currentPlaySongId: ids[0], limit: 20 });
      openNeteaseSongResults('推荐更多歌曲', songs, {
        playlistId: 'pl_netease_more',
        playlistTitle: '推荐更多歌曲',
      });
    } catch (err) {
      showToast(err?.message || '推荐更多失败');
    }
  }

  async function editLyrics(trackId) {
    let track = trackById(trackId);
    if (!track) return;
    if ((track.source === 'netease' || track.provider === 'netease') && !lyricOf(track)) {
      track = await fetchNeteaseLyricsForTrack(track.id, { force: true }) || track;
    }
    openModal(`
      <div class="music-modal-card scrapbook-panel">
        <div class="music-modal-head">
          <strong>${esc(track.title)} · 歌词</strong>
          <button type="button" data-modal-close aria-label="关闭">${icon('close')}</button>
        </div>
        <textarea class="form-input music-lyrics-editor" data-lyrics-input placeholder="粘贴 LRC 或纯文本歌词">${esc(track.lyricLrc || track.lyricText || '')}</textarea>
        <div class="music-modal-actions">
          <button type="button" class="btn btn-outline" data-modal-close>取消</button>
          <button type="button" class="btn btn-primary" data-save-lyrics>保存</button>
        </div>
      </div>
    `, (wrap, close) => {
      wrap.querySelector('[data-save-lyrics]')?.addEventListener('click', async () => {
        const next = wrap.querySelector('[data-lyrics-input]')?.value || '';
        const looksLrc = /\[\d{1,2}:\d{1,2}(?:\.\d+)?\]/.test(next);
        await updateTrackLyrics(track.id, looksLrc ? { lyricLrc: next, lyricText: track.lyricText || '' } : { lyricText: next, lyricLrc: track.lyricLrc || '' });
        close();
        await reloadLibrary();
        showToast('歌词已保存');
        paint();
      });
    });
  }

  async function importLyricFiles(fileList) {
    const result = await importLyricFilesToLibrary(fileList, library.tracks);
    await reloadLibrary();
    showToast(result.updated ? `已匹配 ${result.updated} 份歌词` : '没有匹配到同名歌曲');
    paint();
  }

  function openQueue() {
    const queue = currentQueue();
    openModal(`
      <div class="music-modal-card scrapbook-panel">
        <div class="music-modal-head">
          <strong>播放队列</strong>
          <button type="button" data-modal-close aria-label="关闭">${icon('close')}</button>
        </div>
        <div class="music-queue-list">
          ${queue.map((track) => `
            <button type="button" class="music-queue-item ${track.id === currentTrackId ? 'is-active' : ''}" data-queue-track="${esc(track.id)}">
              ${trackCoverHtml(track, true)}
              <span><strong>${esc(track.title)}</strong><small>${esc(track.artist || '')}</small></span>
            </button>
          `).join('')}
        </div>
      </div>
    `, (wrap, close) => {
      wrap.querySelectorAll('[data-queue-track]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          close();
          await playTrack(btn.getAttribute('data-queue-track'));
        });
      });
    });
  }

  function pickCharacterBackground(characterId) {
    if (!characterId) return;
    openFilePicker({
      accept: 'image/*',
      onChange: async (files) => {
        const file = files && files[0];
        if (!file) return;
        try {
          const dataUrl = await compressImageToDataUrl(file, 1000, 0.82);
          const profiles = { ...(socialStore.profiles || {}) };
          profiles[characterId] = { ...(profiles[characterId] || {}), bg: dataUrl, updatedAt: Date.now() };
          const next = { ...socialStore, profiles };
          writeMusicSocialStore(next);
          socialStore = next;
          showToast('主页背景已更新');
          paint();
        } catch (err) {
          showToast(err?.name === 'QuotaExceededError' ? '图片太大，换张小一点的' : (err?.message || '背景设置失败'));
        }
      },
    });
  }

  async function ensureBackupTrackImported(song) {
    if (!song) return song;
    if (trackById(song.id)) return song;
    const rawSong = feedStore.dailySongs.find((raw) => String(raw.id || raw.songId || '') === String(song.providerTrackId || ''));
    if (rawSong) {
      const rows = await importRemoteSongs([rawSong], {
        playlistId: 'pl_netease_daily',
        playlistTitle: '网易云每日推荐',
        mood: '日推',
        silent: true,
      });
      return rows[0] || song;
    }
    return song;
  }

  async function resolveCustomQueryTrack(query, cache) {
    const keyword = String(query || '').trim();
    if (!keyword) return null;
    if (cache.has(keyword)) return cache.get(keyword);
    let result = null;
    const canSearchNetease = !!(neteaseConfig?.enabled && neteaseConfig?.apiBaseUrl);
    if (canSearchNetease) {
      try {
        const hits = await searchNeteaseSongs(neteaseConfig, keyword, { limit: 3 });
        const best = Array.isArray(hits) ? hits.find(Boolean) : null;
        if (best) {
          const rows = await importRemoteSongs([best], {
            playlistId: 'pl_character_pick',
            playlistTitle: '角色自己搜的歌',
            mood: '角色自选',
            silent: true,
          });
          result = rows[0] || null;
        }
      } catch {
        result = null;
      }
    }
    cache.set(keyword, result);
    return result;
  }

  async function generatePosts(options = {}) {
    const user = await getCurrentUser().catch(() => null);
    const focusCharacterId = String(options.characterId || '').trim();
    const candidates = (focusCharacterId
      ? characters.filter((char) => char?.id === focusCharacterId)
      : characters.filter((char) => char?.id).slice(0, 8));
    if (!candidates.length) {
      showToast('通讯录里还没有角色');
      return;
    }
    if (!feedStore.dailySongs.length && neteaseConfig?.accessToken) {
      await refreshMusicFeed().catch(() => false);
    }
    const feedTracks = (feedStore.dailySongs || [])
      .map((song, index) => normalizeNeteaseSong(song, {
        playlistId: 'pl_netease_daily',
        playlistTitle: '网易云每日推荐',
        mood: '日推',
        feedIndex: index,
      }))
      .filter((track) => track.providerTrackId || track.title);
    const backupPool = uniqueTracksByProvider([...library.tracks, ...feedTracks]).slice(0, 20);
    const canSearchNetease = !!(neteaseConfig?.enabled && neteaseConfig?.apiBaseUrl);
    if (!backupPool.length && !canSearchNetease) {
      showToast('先播放/收藏几首歌，或在我的主页配置网易云代理让角色自己搜歌');
      return;
    }
    try {
      showToast(focusCharacterId ? '正在生成听歌记录' : '正在生成角色动态');
      const candidateIds = candidates.map((char) => char.id);
      const roleplay = await collectRoleplayContextForSocialGeneration(user?.id || '', null, {
        focusCharacterIds: candidateIds,
      }).catch(() => ({ relationLines: [], snippets: [] }));
      const system = await buildWeiboAiSystemPrompt(user, null, {
        referenceNotes: [
          '本次不是微博，而是音乐软件广场里的短动态。',
          '请写“网抑云”式但贴合角色口吻的听歌感想：克制、含蓄、像随手发在音乐 App，不要鸡汤，不要解释设定，不要歌评口吻。',
          '音乐广场动态只能是纯文本短句，不要写 [表情包:名称]、贴纸标签或 emoji 表情包占位。',
        ].join('\n'),
      }).catch(() => '');
      const charCards = await loadCharactersMap(candidateIds)
        .then((map) => buildMomentsCharacterCardsBlock(map, candidateIds))
        .catch(() => '');
      const memoryBlock = user?.id
        ? await buildMomentsMemoryBlock(user.id, candidateIds, { memoryLimit: 6, factLimit: 6 }).catch(() => '')
        : '';
      const backupSongLines = backupPool.map((track, index) =>
        `${index}. ${track.title} - ${track.artist || '未知'}${pickLyricQuote(track) ? `｜歌词片段:${pickLyricQuote(track)}` : ''}`
      ).join('\n');
      const charLines = candidates.map((char, index) => `${index}. id=${char.id} name=${char.name || char.id}`).join('\n');
      const postCount = 4;
      const userMsg = [
        MUSIC_SQUARE_VOICE_RULES,
        MUSIC_SQUARE_CONTENT_RULES,
        charCards,
        memoryBlock ? `[角色的记忆 / 事实碎片 · 各角色只能用标有自己 id 的部分]\n${memoryBlock}` : '',
        roleplay?.relationLines?.length ? `人物关系：\n${roleplay.relationLines.join('\n')}` : '',
        roleplay?.snippets?.length ? `近期聊天口吻参考：\n${roleplay.snippets.join('\n')}` : '',
        `可选角色：\n${charLines}`,
        backupSongLines
          ? `[备用曲库 · 用户本地歌单，代表用户口味不代表角色口味，能不用就不用]\n${backupSongLines}`
          : '（当前没有备用曲库，必须给出 customQuery 让角色自己搜歌）',
        MUSIC_SQUARE_PICK_RULES,
        focusCharacterId
          ? `本次任务：为这一个角色生成 TA 的音乐主页内容——${postCount} 条听歌动态（每条不同的歌），外加一句个性签名 signature（12-24 字，像挂在音乐主页上的心情，不点歌名）。每条动态 content 写 18-42 字，像角色正在听这首歌时发的一句话。`
          : `本次任务：生成 ${postCount} 条音乐广场动态，尽量覆盖不同角色。每条选一个 characterId，content 写 18-42 字，像角色正在听这首歌时发的一句话。`,
        '要求：每条动态都要具体匹配那首歌，能引用情绪但不要逐字大段抄歌词；不要出现“作为AI/根据设定/世界书/聊天记录”等说明；不要出现 [表情包:名称]、贴纸标签、mood 标签或情绪小标题。',
        focusCharacterId
          ? '只输出一个合法JSON对象，不要解释，不要代码块：{"signature":"个性签名","posts":[{"customQuery":"歌名 歌手","songIndex":null,"content":"动态正文"}]}'
          : '只输出一个合法JSON对象，不要解释，不要代码块：{"posts":[{"characterId":"角色id","customQuery":"歌名 歌手","songIndex":null,"content":"动态正文"}]}',
      ].filter(Boolean).join('\n\n');
      const raw = await apiChat([
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: userMsg },
      ], {
        maxTokens: await resolveGenerationMaxTokens(),
        temperature: 0.85,
      });
      const parsed = await parseJsonObjectOnce(raw);
      const generated = Array.isArray(parsed.posts) ? parsed.posts.slice(0, focusCharacterId ? 5 : 6) : [];
      if (focusCharacterId) {
        const sign = String(parsed.signature || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (sign) {
          const profiles = { ...(socialStore.profiles || {}) };
          profiles[focusCharacterId] = { ...(profiles[focusCharacterId] || {}), signature: sign, updatedAt: Date.now() };
          socialStore = { ...socialStore, profiles };
          writeMusicSocialStore(socialStore);
        }
      }
      const queryCache = new Map();
      let saved = 0;
      for (const item of generated) {
        const char = candidates.find((c) => c.id === item.characterId) || candidates[saved % candidates.length];
        // content 偶发是对象/数组；走同源清洗，避免落库成 [object Object]
        const content = sanitizeMusicPostContent(item.content, 120);
        if (!char || !content) continue;
        let song = null;
        const customQuery = String(item.customQuery || '').trim();
        if (customQuery) {
          song = await resolveCustomQueryTrack(customQuery, queryCache);
        }
        if (!song && item.songIndex !== null && item.songIndex !== undefined && backupPool.length) {
          const idx = Math.max(0, Math.min(backupPool.length - 1, Number(item.songIndex) || 0));
          song = await ensureBackupTrackImported(backupPool[idx]);
        }
        if (!song && backupPool.length) {
          song = await ensureBackupTrackImported(backupPool[saved % backupPool.length]);
        }
        if (!song) continue;
        await saveMusicPost({
          id: `music_ai_${Date.now()}_${saved}`,
          characterId: char.id,
          authorId: char.id,
          authorName: char.name || '',
          trackId: song.id,
          content,
          mood: '',
          createdAt: Date.now() - saved * 1000,
        });
        saved += 1;
      }
      await reloadLibrary();
      showToast(saved ? `已生成 ${saved} 条动态` : '没有生成有效动态');
      if (focusCharacterId) {
        selectedCharacterId = focusCharacterId;
        activeView = 'character';
      } else {
        activeTab = 'square';
        activeView = '';
      }
      paint();
    } catch (err) {
      showGenerationErrorReport({
        scope: '音乐 / 听歌动态生成',
        title: '听歌动态生成失败',
        message: err?.message || '生成动态失败',
        detail: err?.stack || err?.message || String(err || '生成动态失败'),
      });
      showToast(err?.message || '生成动态失败');
    }
  }

  function pickImageInto(onData, options = {}) {
    const maxW = Number(options.maxW) > 0 ? Number(options.maxW) : 1000;
    const quality = Number(options.quality) > 0 ? Number(options.quality) : 0.82;
    openFilePicker({
      accept: 'image/*',
      onChange: async (files) => {
        const file = files && files[0];
        if (!file) return;
        try {
          const dataUrl = await compressImageToDataUrl(file, maxW, quality);
          onData(dataUrl);
        } catch (err) {
          showToast(err?.name === 'QuotaExceededError' ? '图片太大，换张小一点的' : (err?.message || '图片读取失败'));
        }
      },
    });
  }

  function openProfileEditModal() {
    const me = meProfile();
    let avatar = me.avatar;
    let bg = me.bg;
    openModal(`
      <div class="music-modal-card music-edit-card">
        <div class="music-modal-head"><strong>编辑音乐主页</strong><button type="button" class="music-icon-btn" data-modal-close aria-label="关闭">${icon('close')}</button></div>
        <label class="music-field"><span>昵称</span><input type="text" data-edit-name maxlength="24" value="${esc(me.name)}" placeholder="你的音乐昵称"></label>
        <label class="music-field"><span>个性签名</span><textarea data-edit-sign maxlength="60" rows="2" placeholder="挂在主页的一句话">${esc(me.signature)}</textarea></label>
        <div class="music-field">
          <span>头像</span>
          <div class="music-edit-media">
            <span class="music-edit-avatar" data-edit-avatar-preview>${userAvatarHtml({ name: me.name, avatar }, 'music-post-avatar-img')}</span>
            <div class="music-edit-media-ops">
              <input type="url" data-edit-avatar-url value="${esc(avatar)}" placeholder="粘贴头像图片 URL">
              <button type="button" class="btn btn-xs btn-soft" data-edit-avatar-upload>上传图片</button>
            </div>
          </div>
        </div>
        <div class="music-field">
          <span>主页背景</span>
          <div class="music-edit-media">
            <span class="music-edit-bg" data-edit-bg-preview style="${bg ? `background-image:url('${esc(bg)}')` : ''}"></span>
            <div class="music-edit-media-ops">
              <input type="url" data-edit-bg-url value="${esc(bg)}" placeholder="粘贴背景图片 URL">
              <button type="button" class="btn btn-xs btn-soft" data-edit-bg-upload>上传图片</button>
            </div>
          </div>
        </div>
        <div class="music-modal-actions">
          <button type="button" class="btn btn-soft" data-modal-close>取消</button>
          <button type="button" class="btn btn-primary" data-edit-save>保存</button>
        </div>
      </div>
    `, (wrap, close) => {
      const avatarPreview = wrap.querySelector('[data-edit-avatar-preview]');
      const bgPreview = wrap.querySelector('[data-edit-bg-preview]');
      const avatarUrl = wrap.querySelector('[data-edit-avatar-url]');
      const bgUrl = wrap.querySelector('[data-edit-bg-url]');
      const renderAvatar = () => { avatarPreview.innerHTML = userAvatarHtml({ name: wrap.querySelector('[data-edit-name]').value || me.name, avatar }, 'music-post-avatar-img'); };
      const renderBg = () => { bgPreview.style.backgroundImage = bg ? `url('${bg}')` : ''; };
      const upgradeMediaUrl = (raw) => {
        let u = String(raw || '').trim();
        if (u.startsWith('//')) u = `https:${u}`;
        else if (/^http:\/\//i.test(u)) u = `https://${u.slice(7)}`;
        return u;
      };
      avatarUrl.addEventListener('input', () => { avatar = upgradeMediaUrl(avatarUrl.value); renderAvatar(); });
      bgUrl.addEventListener('input', () => { bg = upgradeMediaUrl(bgUrl.value); renderBg(); });
      wrap.querySelector('[data-edit-avatar-upload]')?.addEventListener('click', () => pickImageInto((data) => { avatar = data; avatarUrl.value = ''; renderAvatar(); }));
      wrap.querySelector('[data-edit-bg-upload]')?.addEventListener('click', () => pickImageInto((data) => { bg = data; bgUrl.value = ''; renderBg(); }));
      wrap.querySelector('[data-edit-save]')?.addEventListener('click', () => {
        shellStore.profileName = (wrap.querySelector('[data-edit-name]').value || '').trim().slice(0, 24);
        shellStore.signature = (wrap.querySelector('[data-edit-sign]').value || '').trim().slice(0, 60);
        shellStore.profileAvatar = upgradeMediaUrl(avatar) || '';
        shellStore.profileBg = upgradeMediaUrl(bg) || '';
        try {
          writeShellStore(shellStore);
        } catch (err) {
          showToast('背景图太大存不下，换张小图或用 URL');
          return;
        }
        close();
        showToast('主页已更新');
        paint();
      });
    });
  }

  function openComposeModal(prefillTrackId = '') {
    const trackList = library.tracks.slice(0, 80);
    if (!trackList.length) { showToast('先添加几首歌再发动态'); return; }
    const defaultId = trackById(prefillTrackId) ? prefillTrackId : (currentTrackId || trackList[0].id);
    const options = trackList.map((track) => `<option value="${esc(track.id)}" ${track.id === defaultId ? 'selected' : ''}>${esc(track.title)} · ${esc(track.artist || '未知')}</option>`).join('');
    openModal(`
      <div class="music-modal-card music-compose-card">
        <div class="music-modal-head"><strong>分享一首歌</strong><button type="button" class="music-icon-btn" data-modal-close aria-label="关闭">${icon('close')}</button></div>
        <textarea data-compose-text rows="3" maxlength="280" placeholder="说点什么，让角色们来评论…"></textarea>
        <label class="music-field"><span>带上这首歌</span><select class="music-select" data-compose-track>${options}</select></label>
        <div class="music-modal-actions">
          <button type="button" class="btn btn-soft" data-modal-close>取消</button>
          <button type="button" class="btn btn-primary" data-compose-submit>发布</button>
        </div>
      </div>
    `, (wrap, close) => {
      wrap.querySelector('[data-compose-text]')?.focus();
      wrap.querySelector('[data-compose-submit]')?.addEventListener('click', () => {
        const trackId = wrap.querySelector('[data-compose-track]').value;
        const text = wrap.querySelector('[data-compose-text]').value || '';
        close();
        void composeUserPost({ trackId, text });
      });
    });
  }

  function openShareModal(trackId) {
    const track = trackById(trackId);
    if (!track) { showToast('先播放一首歌'); return; }
    const lines = lyricLines(track, 60).filter((l) => l && !l.startsWith('还没有歌词'));
    const hasLyric = lines.length > 0;
    let lyricMode = hasLyric ? 'full' : 'none'; // none | full | pick
    const picked = new Set();
    const lyricSection = () => {
      if (!hasLyric) return '<p class="music-share-note">这首歌还没歌词，转发会带上标题和歌手。</p>';
      const modes = [['none', '不带'], ['full', '整首'], ['pick', '选段拼贴']];
      const tabs = modes.map(([m, label]) => `<button type="button" class="music-share-mode ${lyricMode === m ? 'is-active' : ''}" data-lyric-mode="${m}">${label}</button>`).join('');
      const pickList = lyricMode === 'pick'
        ? `<div class="music-share-lines">${lines.map((line, i) => `<button type="button" class="music-share-line ${picked.has(i) ? 'is-on' : ''}" data-lyric-pick="${i}">${esc(line)}</button>`).join('')}</div>`
        : '';
      return `<div class="music-share-modes">${tabs}</div>${pickList}`;
    };
    const collectLyric = () => {
      if (!hasLyric || lyricMode === 'none') return '';
      if (lyricMode === 'full') return lines.join('\n');
      return [...picked].sort((a, b) => a - b).map((i) => lines[i]).join('\n');
    };
    openModal(`
      <div class="music-modal-card music-share-card">
        <div class="music-modal-head"><strong>转发这首歌</strong><button type="button" class="music-icon-btn" data-modal-close aria-label="关闭">${icon('close')}</button></div>
        <div class="music-track-menu-cover">
          ${trackCoverHtml(track)}
          <div><strong>${esc(track.title)}</strong><small>${esc([track.artist, track.album, trackStatusLabel(track)].filter(Boolean).join(' · '))}</small></div>
        </div>
        <div class="music-field"><span>带上歌词</span><div data-share-lyric-wrap>${lyricSection()}</div></div>
        <label class="music-field"><span>配文（可选）</span><textarea data-share-text rows="2" maxlength="280" placeholder="想说的话…"></textarea></label>
        <div class="music-modal-actions music-modal-actions-main">
          <button type="button" class="btn btn-outline" data-share-to-chat>转发到聊天</button>
          <button type="button" class="btn btn-primary" data-share-to-square>转发到动态</button>
        </div>
      </div>
    `, (wrap, close) => {
      const lyricWrap = wrap.querySelector('[data-share-lyric-wrap]');
      const rerender = () => {
        lyricWrap.innerHTML = lyricSection();
        bindLyric();
      };
      function bindLyric() {
        lyricWrap.querySelectorAll('[data-lyric-mode]').forEach((btn) => {
          btn.addEventListener('click', () => { lyricMode = btn.getAttribute('data-lyric-mode'); rerender(); });
        });
        lyricWrap.querySelectorAll('[data-lyric-pick]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const i = Number(btn.getAttribute('data-lyric-pick'));
            if (picked.has(i)) picked.delete(i); else picked.add(i);
            btn.classList.toggle('is-on');
          });
        });
      }
      bindLyric();
      wrap.querySelector('[data-share-to-square]')?.addEventListener('click', () => {
        const text = wrap.querySelector('[data-share-text]').value || '';
        const lyric = collectLyric();
        if (lyricMode === 'pick' && hasLyric && !lyric) { showToast('先选几句歌词，或换「整首」'); return; }
        close();
        void composeUserPost({ trackId: track.id, text, lyricQuote: lyric });
      });
      wrap.querySelector('[data-share-to-chat]')?.addEventListener('click', () => {
        const text = wrap.querySelector('[data-share-text]').value || '';
        const lyric = collectLyric();
        if (lyricMode === 'pick' && hasLyric && !lyric) { showToast('先选几句歌词，或换「整首」'); return; }
        close();
        void openChatPickerForShare(track, { caption: text, lyric });
      });
    });
  }

  async function openChatPickerForShare(track, { caption = '', lyric = '' } = {}) {
    const user = currentUser || await getCurrentUser().catch(() => null);
    const chats = user?.id ? await listChatsForUser(user.id).catch(() => []) : [];
    const userChats = chats.filter((c) => c?.id && !c.deleted && isUserPresentInChat(c));
    const rows = userChats.slice(0, 30).map((chat) => {
      const isGroup = chat.type === 'group';
      const otherId = (chat.participants || []).find((p) => p && p !== 'user');
      const name = isGroup
        ? (chat.groupSettings?.name || '群聊')
        : (charactersMap.get(otherId)?.name || chat.title || '聊天');
      return `<button type="button" class="music-chat-pick" data-pick-chat="${esc(chat.id)}">
        <span class="music-chat-pick-avatar">${isGroup ? icon('message') : (charactersMap.get(otherId) ? characterAvatarHtml(charactersMap.get(otherId), { className: 'music-thread-avatar-img' }) : icon('message'))}</span>
        <span>${esc(name)}</span>
      </button>`;
    }).join('');
    openModal(`
      <div class="music-modal-card music-chatpick-card">
        <div class="music-modal-head"><strong>转发到聊天</strong><button type="button" class="music-icon-btn" data-modal-close aria-label="关闭">${icon('close')}</button></div>
        <div class="music-chat-pick-list">${rows || '<div class="music-soft-empty">还没有聊天，先去和角色聊几句</div>'}</div>
      </div>
    `, (wrap, close) => {
      wrap.querySelectorAll('[data-pick-chat]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const chatId = btn.getAttribute('data-pick-chat') || '';
          const target = userChats.find((chat) => chat.id === chatId);
          if (!target || !isUserPresentInChat(target)) {
            showToast('该窗口不支持用户转发');
            return;
          }
          if (btn.disabled) return;
          btn.disabled = true;
          try {
            await saveMusicShareToChat({
              chatId,
              user,
              track,
              caption,
              lyric,
              timestamp: await getNowForUser(user?.id || ''),
            });
            sessionStorage.removeItem(`pendingMusic_${chatId}`);
            close();
            navigate('chat/thread', { chatId }, true);
          } catch (error) {
            btn.disabled = false;
            showToast(error?.message || '转发失败，请重试');
          }
        });
      });
    });
  }

  async function composeUserPost({ trackId, text, lyricQuote = '' }) {
    const track = trackById(trackId);
    if (!track) { showToast('选一首歌再发'); return; }
    const me = meProfile();
    const post = await saveMusicPost({
      id: `music_user_${Date.now()}`,
      authorId: me.id,
      authorName: me.name,
      authorType: 'user',
      characterId: '',
      trackId: track.id,
      content: String(text || '').trim().slice(0, 300),
      lyricQuote: String(lyricQuote || '').trim().slice(0, 300),
      visibility: 'square',
      createdAt: Date.now(),
    });
    await reloadLibrary();
    activeTab = 'profile';
    activeView = '';
    showToast('动态已发布，正在回复评论…');
    paint();
    void generatePostReplies(post.id);
  }

  async function toggleLikePost(postId) {
    const post = posts.find((p) => p.id === postId);
    if (!post) return;
    const liked = !post.likedByMe;
    await saveMusicPost({
      ...post,
      likedByMe: liked,
      likes: Math.max(0, (Number(post.likes || 0) || 0) + (liked ? 1 : -1)),
    });
    await reloadLibrary();
    paint();
  }

  function openPostMenu(postId) {
    const post = posts.find((item) => item.id === postId);
    if (!post) return;
    openModal(`
      <div class="music-modal-card music-post-menu-card">
        <div class="music-modal-head">
          <strong>动态操作</strong>
          <button type="button" data-modal-close aria-label="关闭">${icon('close')}</button>
        </div>
        <div class="music-post-menu-actions">
          <button type="button" class="btn btn-outline is-danger" data-delete-music-post>删除动态</button>
        </div>
      </div>
    `, (wrap, close) => {
      wrap.querySelector('[data-delete-music-post]')?.addEventListener('click', async () => {
        if (!window.confirm('确认删除这条音乐动态吗？')) return;
        const deleted = await deleteMusicPost(post.id);
        close();
        if (!deleted) {
          showToast('这条动态已经不存在了');
          await reloadLibrary();
          paint();
          return;
        }
        await reloadLibrary();
        showToast('动态已删除');
        paint();
      });
    });
  }

  async function addUserComment(postId, text) {
    const post = posts.find((p) => p.id === postId);
    const value = String(text || '').trim();
    if (!post || !value) return;
    const me = meProfile();
    const comments = [...(post.comments || []), {
      id: `mc_${Date.now()}`,
      authorId: me.id,
      authorName: me.name,
      characterId: '',
      text: value.slice(0, 300),
      createdAt: Date.now(),
    }];
    await saveMusicPost({ ...post, comments });
    await reloadLibrary();
    paint();
  }

  async function generatePostReplies(postId) {
    const post = posts.find((p) => p.id === postId);
    if (!post) return;
    const track = trackById(post.trackId);
    if (!track) return;
    const me = meProfile();
    const pool = characters.filter((c) => c?.id);
    const recentCommentCharacterIds = posts
      .flatMap((item) => (item.comments || []).map((comment) => ({
        characterId: comment.characterId,
        createdAt: Number(comment.createdAt || 0),
      })))
      .filter((comment) => comment.characterId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 18)
      .map((comment) => comment.characterId);
    // 本地先抽定本轮真正出场的人，避免模型总从 6 人候选池里偏爱同几位。
    const candidates = selectMusicCommentBatch(pool, {
      followingCharacterIds: socialStore.followingCharacterIds || [],
      existingCommentCharacterIds: (post.comments || []).map((comment) => comment.characterId).filter(Boolean),
      recentCommentCharacterIds,
      min: 2,
      max: 4,
    });
    if (!candidates.length) { showToast('通讯录里还没有角色'); return; }
    try {
      const user = currentUser || await getCurrentUser().catch(() => null);
      const candidateIds = candidates.map((c) => c.id);
      const roleplay = await collectRoleplayContextForSocialGeneration(user?.id || '', null, {
        focusCharacterIds: candidateIds,
      }).catch(() => ({ relationLines: [], snippets: [] }));
      const system = await buildWeiboAiSystemPrompt(user, null, {
        referenceNotes: [
          '这是音乐 App 里，用户（你的对象/朋友）发了一条听歌动态，角色们在底下评论。',
          '评论要短、自然、贴角色口吻和你俩关系，像真的在对方主页下留言；可以接歌、调侃、心疼、起哄。',
          '只写纯文本，不要 [表情包]、贴纸标签、情绪小标题，不要解释设定。',
        ].join('\n'),
      }).catch(() => '');
      // 像朋友圈一样注入参与角色的人设卡 + 长期记忆 / 事实碎片
      const charCards = await loadCharactersMap(candidateIds)
        .then((map) => buildMomentsCharacterCardsBlock(map, candidateIds))
        .catch(() => '');
      const memoryBlock = user?.id ? await buildMomentsMemoryBlock(user.id, candidateIds, { memoryLimit: 8, factLimit: 8 }).catch(() => '') : '';
      const charLines = candidates.map((c, i) => `${i}. id=${c.id} name=${c.name || c.id}`).join('\n');
      const sharedLyric = String(post.lyricQuote || '').trim();
      const songBlock = [
        `歌曲：${track.title} - ${track.artist || '未知'}${track.album ? `（${track.album}）` : ''}`,
        sharedLyric ? `${me.name} 特地摘出来的歌词：\n${sharedLyric}` : (pickLyricQuote(track) ? `歌词片段：${pickLyricQuote(track)}` : ''),
        `配文：${post.content || '（没有配文）'}`,
      ].filter(Boolean).join('\n');
      const userMsg = [
        MUSIC_SQUARE_VOICE_RULES,
        charCards,
        memoryBlock ? `[你与各角色的记忆 / 事实碎片 · 各角色只能用标有自己 id 的部分]\n${memoryBlock}` : '',
        roleplay?.relationLines?.length ? `人物关系：\n${roleplay.relationLines.join('\n')}` : '',
        roleplay?.snippets?.length ? `近期聊天口吻参考：\n${roleplay.snippets.join('\n')}` : '',
        `可选角色：\n${charLines}`,
        `${me.name} 刚发了一条音乐动态：\n${songBlock}`,
        sharedLyric
          ? '本次任务：上面的角色已经由本地轮换抽定。每位角色都各写一条 8-30 字的评论，不得跳过、替换或新增角色。评论要扣住上面那几句歌词来接话——可以顺着歌词的情绪、画面或一句词回应，结合你和 TA 的关系与记忆，不要泛泛而谈。'
          : '本次任务：上面的角色已经由本地轮换抽定。每位角色都各写一条 8-30 字的评论，不得跳过、替换或新增角色；回应这条动态，并结合你和 TA 的关系与记忆。',
        '只输出一个合法JSON对象，不要解释，不要代码块：{"comments":[{"characterId":"角色id","text":"评论正文"}]}',
      ].filter(Boolean).join('\n\n');
      const raw = await apiChat([
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: userMsg },
      ], {
        maxTokens: await resolveGenerationMaxTokens(),
        temperature: 0.9,
      });
      const parsed = await parseJsonObjectOnce(raw);
      const list = Array.isArray(parsed.comments) ? parsed.comments.slice(0, candidates.length) : [];
      // 用户可能在评论生成期间删除动态。必须重新读取数据库，不能拿生成前的
      // 闭包快照继续 saveMusicPost，否则删除后会被迟到的评论结果重新创建。
      const fresh = await getMusicPost(postId);
      if (!fresh) return;
      const newComments = [];
      const newFans = new Set(socialStore.fansCharacterIds || []);
      const usedCharacterIds = new Set();
      let n = 0;
      for (const item of list) {
        const char = pickUniqueMusicCommentAuthor(item.characterId, candidates, usedCharacterIds);
        const text = String(item.text || '').trim();
        if (!char || !text) continue;
        usedCharacterIds.add(char.id);
        newComments.push({
          id: `mc_${Date.now()}_${n}`,
          authorId: char.id,
          authorName: char.name || '',
          characterId: char.id,
          text: text.slice(0, 200),
          createdAt: Date.now() + n,
        });
        newFans.add(char.id);
        n += 1;
      }
      if (!newComments.length) { showToast('角色暂时没接话，稍后再试'); return; }
      await saveMusicPost({ ...fresh, comments: [...(fresh.comments || []), ...newComments] });
      socialStore = { ...socialStore, fansCharacterIds: [...newFans] };
      writeMusicSocialStore(socialStore);
      await reloadLibrary();
      showToast(`${newComments.length} 个角色来评论了`);
      paint();
    } catch (err) {
      showGenerationErrorReport({
        scope: '音乐 / 角色评论生成',
        title: '角色评论生成失败',
        message: err?.message || '生成评论失败',
        detail: err?.stack || err?.message || String(err || '生成评论失败'),
      });
      showToast(err?.message || '生成评论失败');
    }
  }

  function openPostThread(postId) {
    const post = posts.find((p) => p.id === postId);
    if (!post) return;
    const me = meProfile();
    const commentsHtml = (post.comments || []).map((c) => {
      const char = c.characterId ? charactersMap.get(c.characterId) : null;
      const isUser = !c.characterId && (c.authorId === 'user' || c.authorId === me.id);
      const name = char?.name || (isUser ? me.name : (c.authorName || '匿名'));
      const avatar = char ? characterAvatarHtml(char, { className: 'music-thread-avatar-img' }) : userAvatarHtml(isUser ? me : { name }, 'music-thread-avatar-img');
      return `<div class="music-thread-row">
        <span class="music-thread-avatar">${avatar}</span>
        <div><strong>${esc(name)}</strong><p>${esc(c.text || '')}</p></div>
      </div>`;
    }).join('') || '<div class="music-soft-empty">还没有评论，写一条，或让角色来接话</div>';
    openModal(`
      <div class="music-modal-card music-thread-card">
        <div class="music-modal-head"><strong>评论 ${post.comments?.length || 0}</strong><button type="button" class="music-icon-btn" data-modal-close aria-label="关闭">${icon('close')}</button></div>
        <div class="music-thread-list">${commentsHtml}</div>
        <div class="music-thread-compose">
          <input type="text" data-thread-input maxlength="200" placeholder="写条评论…">
          <button type="button" class="btn btn-xs btn-primary" data-thread-send>发送</button>
        </div>
        <button type="button" class="btn btn-soft music-thread-gen" data-thread-gen>让角色来评论</button>
      </div>
    `, (wrap, close) => {
      const input = wrap.querySelector('[data-thread-input]');
      wrap.querySelector('[data-thread-send]')?.addEventListener('click', () => {
        const value = input.value || '';
        if (!value.trim()) return;
        close();
        void addUserComment(postId, value);
      });
      wrap.querySelector('[data-thread-gen]')?.addEventListener('click', () => {
        close();
        showToast('正在回复评论…');
        void generatePostReplies(postId);
      });
    });
  }

  function tabBody() {
    if (activeView === 'player') {
      return playerPageHtml({ track: currentTrack(), isPlaying, queue: currentQueue(), singleTrackLoop, listenTogether: listenTogether.active, listenTogetherName: listenTogether.name, lyricsView: playerLyricsView });
    }
    if (query.trim()) return renderSearchResults(query, library.tracks, shareMode);
    const me = meProfile();
    if (activeView === 'character') {
      const selectedCharacter = selectedCharacterId ? charactersMap.get(selectedCharacterId) : null;
      return selectedCharacter
        ? renderCharacterMusicProfile(selectedCharacter, posts, charactersMap, trackById, socialStore, me)
        : renderSquare(posts, charactersMap, trackById, me, socialStore, squareFilter);
    }
    if (activeView === 'following') return renderFollowPage(characters, posts, socialStore, trackById);
    if (activeTab === 'playlists') return renderPlaylists(library.playlists, trackById, selectedPlaylistId, playlistPlayMode);
    if (activeTab === 'square') return renderSquare(posts, charactersMap, trackById, me, socialStore, squareFilter);
    if (activeTab === 'profile') return renderProfile({ shellStore, me, posts, tracks: library.tracks, playlists: library.playlists, neteaseConfig, socialStore, charactersMap, trackById });
    return renderHome({
      tracks: library.tracks,
      recentTracks: shellStore.recentTrackIds.map(trackById).filter(Boolean).slice(0, 4),
      playlists: library.playlists,
      trackById,
      shareMode,
      currentTrack: currentTrack(),
      isPlaying,
      queue: currentQueue(),
      feed: feedStore,
    });
  }

  async function toggleListenTogether() {
    const track = currentTrack();
    if (!track) { showToast('先播放一首歌'); return; }
    const user = await getCurrentUser().catch(() => null);
    if (!user?.id) {
      showToast('先完成登录或激活');
      return;
    }
    const active = await listActiveCompanionSessions(user.id);
    const existing = active.find((s) => s.type === 'listen_together');
    if (existing) {
      await endCompanionSession(existing.id);
      await refreshListenStatus();
      showToast('一起听已结束');
      paint();
      return;
    }
    // 用之前在「陪伴助手」选好的陪伴角色；没选过就跳到陪伴 App 走一遍标准流程
    const { loadCompanionSettings } = await import('../core/companion/companion-settings.js');
    const settings = await loadCompanionSettings(user.id);
    const cid = settings.dockCharacterId
      || (characters.length === 1 ? characters[0].id : '');
    if (!cid) {
      showToast('先去「陪伴」App 选一位陪伴角色');
      navigate('companion');
      return;
    }
    await startCompanionSession({
      characterId: cid,
      type: 'listen_together',
      mode: 'ambient',
      scenarioTitle: '一起听歌',
      context: { currentTrackId: track.id, userActivity: '一起听音乐' },
    });
    const name = characters.find((c) => c.id === cid)?.name || '';
    await refreshListenStatus();
    showToast(`一起听已开始${name ? ` · ${name}` : ''}`);
    paint();
  }

  function openPlayer() {
    if (!currentTrack()) {
      showToast('先播放一首歌');
      return;
    }
    activeView = 'player';
    playerLyricsView = false;
    query = '';
    paint();
  }

  function miniPlayerHtml() {
    const track = currentTrack();
    if (!track) return '';
    return `
      <footer class="music-mini-player scrapbook-panel">
        <button type="button" class="music-mini-cover" data-open-player aria-label="展开播放页">${trackCoverHtml(track, true)}</button>
        <button type="button" class="music-mini-main" data-open-player>
          <strong>${esc(track.title)}</strong>
          <small>${esc(track.artist || formatSource(track))}</small>
        </button>
        <button type="button" class="music-player-btn" data-toggle-play aria-label="${isPlaying ? '暂停' : '播放'}">${isPlaying ? 'Ⅱ' : '▶'}</button>
        <button type="button" class="music-player-btn" data-next-track aria-label="下一首">›</button>
        <button type="button" class="music-player-btn ${listenTogether.active ? 'is-active' : ''}" data-listen-together aria-label="${listenTogether.active ? `结束一起听${listenTogether.name ? ` · ${listenTogether.name}` : ''}` : '一起听'}" title="${listenTogether.active ? `结束一起听${listenTogether.name ? ` · ${listenTogether.name}` : ''}` : '一起听'}">♪</button>
      </footer>
    `;
  }

  function pageTitle() {
    if (activeView === 'player') return '正在播放';
    if (activeView === 'character') {
      const char = selectedCharacterId ? charactersMap.get(selectedCharacterId) : null;
      return char?.name || '音乐主页';
    }
    if (activeView === 'following') return '我的关注';
    return shareMode ? '分享音乐' : '音乐';
  }

  function paint() {
    if (searchPaintTimer) {
      clearTimeout(searchPaintTimer);
      searchPaintTimer = null;
    }
    const prevScroll = captureScrollerTop(container, '.music-scroll');
    container.innerHTML = `
      <header class="navbar music-navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${esc(pageTitle())}</h1>
        <button type="button" class="navbar-btn" data-upload-trigger aria-label="上传">${icon('plus')}</button>
      </header>
      ${activeView === 'player' ? '' : `<div class="music-subhead">
        <div class="music-search">
          ${icon('search')}
          <input type="search" value="${esc(query)}" placeholder="搜歌名 / 歌手 / 歌单" data-music-search autocomplete="off">
        </div>
        <nav class="music-tabs" aria-label="音乐导航">
          ${TABS.map((tab) => `
            <button type="button" class="music-tab ${activeTab === tab.id ? 'is-active' : ''}" data-tab="${esc(tab.id)}">${esc(tab.label)}</button>
          `).join('')}
        </nav>
      </div>`}
      <main class="music-scroll scrapbook-scroll">
        ${tabBody()}
      </main>
      ${activeView === 'player' ? '' : miniPlayerHtml()}
      <input type="file" accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg" multiple hidden data-audio-file>
      <input type="file" accept=".lrc,.txt,text/plain" multiple hidden data-lyric-file>
    `;
    restoreScrollerTop(container, '.music-scroll', prevScroll);
    bindEvents();
    updateSearchClearButton();
    syncPlayerPageEffects();
    applyLoadingState();
  }

  function bindEvents(root = container) {
    root.querySelector('[data-back]')?.addEventListener('click', () => {
      if (activeView === 'player') {
        if (playerLyricsView) { playerLyricsView = false; paint(); return; }
        activeView = '';
        paint();
        return;
      }
      if (activeView === 'character') {
        selectedCharacterId = '';
        activeView = activeTab === 'profile' ? 'following' : '';
        if (!activeView) activeTab = 'square';
        paint();
        return;
      }
      if (activeView === 'following') {
        activeView = '';
        activeTab = 'profile';
        paint();
        return;
      }
      if (activeTab === 'playlists' && selectedPlaylistId) {
        selectedPlaylistId = '';
        paint();
        return;
      }
      sessionStorage.removeItem(MUSIC_SHARE_CHAT_KEY);
      back();
    });
    root.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.getAttribute('data-tab') || 'home';
        activeView = '';
        query = '';
        if (activeTab === 'playlists') selectedPlaylistId = '';
        selectedCharacterId = '';
        paint();
      });
    });
    root.querySelector('[data-music-search]')?.addEventListener('compositionstart', () => {
      searchComposing = true;
    });
    root.querySelector('[data-music-search]')?.addEventListener('compositionend', (event) => {
      searchComposing = false;
      query = event.target.value || '';
      updateSearchClearButton();
      scheduleSearchPaint();
    });
    root.querySelector('[data-music-search]')?.addEventListener('input', (event) => {
      query = event.target.value || '';
      updateSearchClearButton();
      if (searchComposing || event.isComposing) return;
      scheduleSearchPaint();
    });
    root.querySelector('[data-music-search]')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void searchNetease(query);
    });
    root.querySelectorAll('[data-play-track]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        const rowPlaylistId = btn.closest('[data-track-id]')?.querySelector('[data-track-menu]')?.getAttribute('data-track-menu-playlist') || '';
        void playTrack(btn.getAttribute('data-play-track'), {
          playlistId: btn.getAttribute('data-queue-playlist') || rowPlaylistId,
          openPlayer: true,
          gestureToken: captureMediaGesture(event),
        });
      });
    });
    root.querySelectorAll('[data-play-feed-song]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        void importFeedSong(Number(btn.getAttribute('data-play-feed-song') || 0), {
          play: true,
          openPlayer: true,
          gestureToken: captureMediaGesture(event),
        });
      });
    });
    root.querySelectorAll('[data-import-feed-song]').forEach((btn) => {
      btn.addEventListener('click', () => { void importFeedSong(Number(btn.getAttribute('data-import-feed-song') || 0)); });
    });
    root.querySelectorAll('[data-feed-song-menu]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        void importFeedSong(Number(btn.getAttribute('data-feed-song-menu') || 0), {
          play: true,
          gestureToken: captureMediaGesture(event),
        });
      });
    });
    root.querySelectorAll('[data-open-netease-feature]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = feedStore.playlists[Number(btn.getAttribute('data-open-netease-feature') || 0)];
        if (item) void openNeteasePlaylistDetail(item);
      });
    });
    root.querySelectorAll('[data-open-player]').forEach((btn) => {
      btn.addEventListener('click', openPlayer);
    });
    root.querySelectorAll('[data-toggle-play]').forEach((btn) => {
      btn.addEventListener('click', (event) => { void togglePlay({ gestureToken: captureMediaGesture(event) }).then(() => paint()); });
    });
    root.querySelectorAll('[data-toggle-single-loop]').forEach((btn) => {
      btn.addEventListener('click', toggleSingleTrackLoop);
    });
    root.querySelectorAll('[data-toggle-player-lyrics]').forEach((el) => {
      el.addEventListener('click', () => { playerLyricsView = !playerLyricsView; paint(); });
    });
    root.querySelectorAll('[data-share-player]').forEach((btn) => {
      btn.addEventListener('click', () => openShareModal(btn.getAttribute('data-share-player') || ''));
    });
    root.querySelectorAll('[data-next-track]').forEach((btn) => {
      btn.addEventListener('click', (event) => { void nextTrack(1, { gestureToken: captureMediaGesture(event) }).then(() => paint()); });
    });
    root.querySelectorAll('[data-prev-track]').forEach((btn) => {
      btn.addEventListener('click', (event) => { void nextTrack(-1, { gestureToken: captureMediaGesture(event) }).then(() => paint()); });
    });
    root.querySelectorAll('[data-open-queue]').forEach((btn) => {
      btn.addEventListener('click', openQueue);
    });
    root.querySelectorAll('[data-share-track]').forEach((btn) => {
      btn.addEventListener('click', () => { void shareTrack(btn.getAttribute('data-share-track')); });
    });
    root.querySelectorAll('[data-add-track]').forEach((btn) => {
      btn.addEventListener('click', () => { void addTrackToPlaylist(btn.getAttribute('data-add-track')); });
    });
    root.querySelectorAll('[data-lyrics-track]').forEach((btn) => {
      btn.addEventListener('click', () => { void editLyrics(btn.getAttribute('data-lyrics-track')); });
    });
    root.querySelectorAll('[data-track-menu]').forEach((btn) => {
      btn.addEventListener('click', () => openTrackMenu(btn.getAttribute('data-track-menu'), btn.getAttribute('data-track-menu-playlist') || ''));
    });
    root.querySelectorAll('[data-open-link]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const track = trackById(btn.getAttribute('data-open-link'));
        if (track?.sourceUrl) window.open(track.sourceUrl, '_blank', 'noopener');
      });
    });
    root.querySelectorAll('[data-play-playlist]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        void playPlaylist(btn.getAttribute('data-play-playlist'), { gestureToken: captureMediaGesture(event) });
      });
    });
    root.querySelectorAll('[data-upload-trigger]').forEach((btn) => {
      btn.addEventListener('click', () => container.querySelector('[data-audio-file]')?.click());
    });
    root.querySelector('[data-audio-file]')?.addEventListener('change', (event) => {
      void importAudioFiles(event.target.files);
    });
    root.querySelectorAll('[data-lyric-upload-trigger]').forEach((btn) => {
      btn.addEventListener('click', () => container.querySelector('[data-lyric-file]')?.click());
    });
    root.querySelector('[data-lyric-file]')?.addEventListener('change', (event) => {
      void importLyricFiles(event.target.files);
    });
    root.querySelectorAll('[data-select-playlist]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedPlaylistId = btn.getAttribute('data-select-playlist') || '';
        paint();
      });
    });
    root.querySelector('[data-close-playlist-detail]')?.addEventListener('click', () => {
      selectedPlaylistId = '';
      paint();
    });
    root.querySelectorAll('[data-playlist-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-playlist-mode') === 'shuffle' ? 'shuffle' : 'sequence';
        playlistPlayMode = mode;
        if (selectedPlaylistId) setQueueFromPlaylist(selectedPlaylistId);
        paint();
      });
    });
    root.querySelectorAll('[data-edit-playlist]').forEach((btn) => {
      btn.addEventListener('click', () => openPlaylistModal(btn.getAttribute('data-edit-playlist')));
    });
    root.querySelectorAll('[data-create-playlist]').forEach((btn) => {
      btn.addEventListener('click', () => { void createPlaylist(); });
    });
    root.querySelectorAll('[data-open-playlist]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedPlaylistId = btn.getAttribute('data-open-playlist') || '';
        activeView = '';
        activeTab = 'playlists';
        query = '';
        paint();
      });
    });
    root.querySelectorAll('[data-listen-together]').forEach((btn) => {
      btn.addEventListener('click', () => { void toggleListenTogether(); });
    });
    root.querySelectorAll('[data-open-listen-view]').forEach((btn) => {
      btn.addEventListener('click', () => navigate('companion/listen'));
    });
    root.querySelector('[data-generate-posts]')?.addEventListener('click', () => { void generatePosts(); });
    root.querySelectorAll('[data-compose-post]').forEach((btn) => {
      btn.addEventListener('click', () => openComposeModal());
    });
    root.querySelector('[data-edit-profile]')?.addEventListener('click', () => openProfileEditModal());
    root.querySelectorAll('[data-square-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        squareFilter = btn.getAttribute('data-square-filter') || 'all';
        paint();
      });
    });
    root.querySelectorAll('[data-like-post]').forEach((btn) => {
      btn.addEventListener('click', () => { void toggleLikePost(btn.getAttribute('data-like-post') || ''); });
    });
    root.querySelectorAll('[data-post-menu]').forEach((btn) => {
      btn.addEventListener('click', () => openPostMenu(btn.getAttribute('data-post-menu') || ''));
    });
    root.querySelectorAll('[data-translation-toggle]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.preventDefault();
        const sourceText = String(btn.getAttribute('data-translation-source') || '').trim();
        const translationText = String(btn.nextElementSibling?.textContent || '').trim();
        const ok = await handleTranslationToggleClick(btn, { sourceText, translationText });
        if (!ok) showToast('翻译暂时不可用，请稍后再试');
      });
    });
    root.querySelectorAll('[data-open-post-thread]').forEach((btn) => {
      btn.addEventListener('click', () => openPostThread(btn.getAttribute('data-open-post-thread') || ''));
    });
    root.querySelectorAll('[data-repost-track]').forEach((btn) => {
      btn.addEventListener('click', () => openComposeModal(btn.getAttribute('data-repost-track') || ''));
    });
    root.querySelectorAll('[data-open-music-character]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-open-music-character') || '';
        if (!id) return;
        selectedCharacterId = id;
        activeView = 'character';
        query = '';
        paint();
      });
    });
    root.querySelector('[data-close-music-character]')?.addEventListener('click', () => {
      selectedCharacterId = '';
      activeView = activeTab === 'profile' ? 'following' : '';
      if (!activeView) activeTab = 'square';
      paint();
    });
    root.querySelectorAll('[data-generate-character-post]').forEach((btn) => {
      btn.addEventListener('click', () => { void generatePosts({ characterId: btn.getAttribute('data-generate-character-post') || '' }); });
    });
    root.querySelectorAll('[data-upload-character-bg]').forEach((btn) => {
      btn.addEventListener('click', () => pickCharacterBackground(btn.getAttribute('data-upload-character-bg') || ''));
    });
    root.querySelectorAll('[data-toggle-music-follow]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-toggle-music-follow') || '';
        if (!id) return;
        const set = new Set(socialStore.followingCharacterIds || []);
        if (set.has(id)) set.delete(id);
        else set.add(id);
        socialStore = { ...socialStore, followingCharacterIds: [...set] };
        writeMusicSocialStore(socialStore);
        paint();
      });
    });
    root.querySelector('[data-open-music-following]')?.addEventListener('click', () => {
      activeView = 'following';
      activeTab = 'profile';
      query = '';
      selectedCharacterId = '';
      paint();
    });
    root.querySelector('[data-open-square]')?.addEventListener('click', () => {
      activeView = '';
      activeTab = 'square';
      query = '';
      selectedCharacterId = '';
      paint();
    });
    root.querySelectorAll('[data-refresh-music-feed]').forEach((btn) => {
      btn.addEventListener('click', () => { void refreshMusicFeed({ manual: true }).then(() => paint()); });
    });
    root.querySelectorAll('[data-netease-daily]').forEach((btn) => {
      btn.addEventListener('click', () => { void openNeteaseDaily(); });
    });
    root.querySelectorAll('[data-netease-playlists]').forEach((btn) => {
      btn.addEventListener('click', () => { void openNeteasePlaylists(); });
    });
    root.querySelectorAll('[data-netease-user-playlists]').forEach((btn) => {
      btn.addEventListener('click', () => { void openNeteaseUserPlaylists(); });
    });
    root.querySelectorAll('[data-netease-refresh-profile]').forEach((btn) => {
      btn.addEventListener('click', () => { void refreshNeteaseProfile(); });
    });
    root.querySelector('[data-link-provider]')?.addEventListener('click', () => { void importLink(); });
    root.querySelector('[data-provider-soon]')?.addEventListener('click', () => {
      showToast('授权曲库会按 provider 单独接入');
    });
    root.querySelector('[data-lyrics-soon]')?.addEventListener('click', () => {
      showToast('在歌曲行点纸张图标编辑歌词');
    });
    root.querySelectorAll('[data-search-web]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = encodeURIComponent(btn.getAttribute('data-search-web') || query);
        window.open(`https://www.baidu.com/s?wd=${q}%20%E6%AD%8C%E6%9B%B2`, '_blank', 'noopener');
      });
    });
    root.querySelectorAll('[data-search-netease]').forEach((btn) => {
      btn.addEventListener('click', () => searchNetease(btn.getAttribute('data-search-netease') || query));
    });
    root.querySelectorAll('[data-netease-settings]').forEach((btn) => {
      btn.addEventListener('click', openNeteaseSettings);
    });
  }

  paint();
  if (query && String(params.provider || '') === 'netease' && String(params.autoSearch || '') === '1') {
    setTimeout(() => { void searchNetease(query); }, 0);
  }
  try {
    if (sessionStorage.getItem('musicFromListen') === '1') {
      sessionStorage.removeItem('musicFromListen');
      showToast('换歌或改队列后会同步到「一起听」');
    }
  } catch (_) {}
  void ensureMusicFeed();

  // 让浮窗等地方能远程控制播放（一起听里的迷你播放器）
  const controller = {
    togglePlay: () => togglePlay(),
    next: () => nextTrack(1),
    prev: () => nextTrack(-1),
    playTrack: (trackId) => playTrack(trackId),
    duckVolume: (level) => duckMusicVolume(level),
    restoreVolume: () => restoreMusicVolume(),
  };
  // 音乐页不在 Keep-Alive：再次进入时需把仍在播的 audio 事件绑回本轮闭包，
  // 否则主屏/一起听的远程暂停会读到错误的 isPlaying。
  if (activeAudio) {
    const audio = activeAudio;
    isPlaying = !audio.paused && !audio.ended;
    // 页面离开后音频仍会继续播放；再次进入音乐页时，onended 不能继续指向
    // 上一轮已离屏的 render 闭包。否则网易云自动切到下一首后，旧页面虽然
    // 换了音频，当前可见页却不会重绘歌名与封面，只能靠返回重进才刷新。
    audio.onended = () => { if (activeAudio === audio) void nextTrack(1, { reuseActiveAudio: audio }); };
    audio.loop = singleTrackLoop;
    audio.ontimeupdate = () => { if (activeAudio === audio) publishPlayerState({ progressOnly: true }); };
    audio.onpause = () => markMusicAudioStopped(audio);
    audio.onplay = () => markMusicAudioPlaying(audio);
    audio.onplaying = () => markMusicAudioPlaying(audio);
    if (isPlaying) suspendSilentKeepAliveAudio();
    else resumeSilentKeepAliveAudio();
    bindMediaSessionHandlers();
    publishPlayerState();
  }
  registerMusicController(controller);
  const onSessionChanged = async () => {
    await refreshListenStatus();
    paint();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('companion-session-changed', onSessionChanged);
  }
  const cleanupController = () => {
    unregisterMusicController(controller);
    if (typeof window !== 'undefined') {
      window.removeEventListener('companion-session-changed', onSessionChanged);
    }
    // 仅在真正卸载（关闭页面）时清掉媒体会话；SPA 内切页不会触发 beforeunload，播放可继续。
    if (hasMediaSession() && mediaSessionBound) {
      ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto'].forEach((action) => {
        try { navigator.mediaSession.setActionHandler(action, null); } catch (_) {}
      });
      mediaSessionBound = false;
    }
    clearMediaSession();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', cleanupController, { once: true });
  }
}
