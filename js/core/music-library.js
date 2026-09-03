import * as db from './db.js';

const DEFAULT_OWNER_ID = 'user';
const LEGACY_SEED_PLAYLIST_IDS = new Set(['pl_late', 'pl_together']);

export const MUSIC_SEED_TRACKS = [];
export const MUSIC_SEED_PLAYLISTS = [];
export const MUSIC_SEED_POSTS = [];

function id(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clean(value, max = 300) {
  return String(value || '').trim().slice(0, max);
}

/**
 * 远端封面 URL 规范化。
 * APK 源是 https://localhost，http 图会被 WebView 当 mixed-content 直接拦掉（裂图）；
 * 网易云常回 http://p*.music.126.net/...，这里统一升 https，并丢掉数字 picId 等非 URL。
 */
export function normalizeRemoteCoverUrl(value) {
  let url = String(value || '').trim();
  if (!url) return '';
  if (/^data:image\//i.test(url)) return url.slice(0, 600000);
  // 与 media-url.upgradeMixedContentMediaUrl 同策略（此处避免循环依赖，内联）
  if (url.startsWith('//')) url = `https:${url}`;
  else if (/^http:\/\//i.test(url)) url = `https://${url.slice(7)}`;
  if (!/^https:\/\//i.test(url)) return '';
  return url.slice(0, 2000);
}

/** 歌单封面：支持外链或本地上传的 data URL（压缩后仍可能较长） */
function cleanPlaylistCoverUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^data:image\//i.test(s)) return s.slice(0, 600000);
  return normalizeRemoteCoverUrl(s);
}

/**
 * AI / 旧数据偶尔把本应为 string 的 content 写成对象或对象数组。
 * 只提取已知文本键；未知对象宁可丢弃，也不能让 String(object) 污染成 [object Object]。
 */
function coerceMusicText(value) {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    text = String(value);
  } else if (Array.isArray(value)) {
    text = value.map((item) => coerceMusicText(item)).filter(Boolean).join(' ');
  } else if (value && typeof value === 'object') {
    const candidate = value.text
      ?? value.content
      ?? value.message
      ?? value.body
      ?? value.caption
      ?? value.zh
      ?? value.original
      ?? '';
    text = coerceMusicText(candidate);
  }
  return String(text || '').trim();
}

function cleanMusicPostContent(value = '') {
  return coerceMusicText(value)
    .replace(/\[object Object\]/gi, ' ')
    .replace(/\[(?:表情包|贴纸)[:：][^\]]+\]/g, '')
    .replace(/(?:表情包|贴纸)[：:]\s*[^\n\r，。！？]{1,48}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 供生成/写入路径复用：对象/数组 content → 可读纯文本 */
export function sanitizeMusicPostContent(value = '', max = 600) {
  return clean(cleanMusicPostContent(value), max);
}

function uniq(list = []) {
  return [...new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim()).filter(Boolean))];
}

function toneBySeed(seed = '') {
  const tones = ['peach', 'blue', 'cream', 'pink'];
  let n = 0;
  for (let i = 0; i < String(seed).length; i += 1) n += String(seed).charCodeAt(i);
  return tones[n % tones.length];
}

export function normalizeMusicTrack(raw = {}) {
  const now = Date.now();
  const source = clean(raw.source || 'manual', 32) || 'manual';
  const title = clean(raw.title || raw.name || '未命名歌曲', 120) || '未命名歌曲';
  const artist = clean(raw.artist || raw.singer || '未知歌手', 120) || '未知歌手';
  return {
    id: clean(raw.id || id('trk'), 80),
    ownerId: clean(raw.ownerId || DEFAULT_OWNER_ID, 80),
    title,
    artist,
    album: clean(raw.album || '', 120),
    duration: clean(raw.duration || '', 24),
    durationMs: Number(raw.durationMs || 0) || 0,
    mood: clean(raw.mood || '', 40),
    source,
    provider: clean(raw.provider || (source === 'netease' ? 'netease' : source), 40),
    providerTrackId: clean(raw.providerTrackId || raw.neteaseSongId || '', 120),
    providerEncryptedId: clean(raw.providerEncryptedId || raw.encryptedId || '', 300),
    providerPlaylistId: clean(raw.providerPlaylistId || '', 120),
    providerRaw: raw.providerRaw && typeof raw.providerRaw === 'object' ? raw.providerRaw : null,
    sourceUrl: clean(raw.sourceUrl || raw.url || '', 1200),
    playUrl: clean(raw.playUrl || '', 2000),
    playUrlExpireAt: Number(raw.playUrlExpireAt || 0) || 0,
    playFlag: raw.playFlag === undefined ? null : !!raw.playFlag,
    visible: raw.visible === undefined ? null : !!raw.visible,
    vipFlag: !!raw.vipFlag,
    vipPlayFlag: !!raw.vipPlayFlag,
    payPlayFlag: !!raw.payPlayFlag,
    freeTrailFlag: !!raw.freeTrailFlag,
    freeTrialPrivilege: raw.freeTrialPrivilege && typeof raw.freeTrialPrivilege === 'object'
      ? {
          cannotListenReason: raw.freeTrialPrivilege.cannotListenReason ?? null,
          resConsumable: !!raw.freeTrialPrivilege.resConsumable,
          userConsumable: !!raw.freeTrialPrivilege.userConsumable,
          listenType: raw.freeTrialPrivilege.listenType ?? null,
          freeLimitTagType: raw.freeTrialPrivilege.freeLimitTagType ?? null,
        }
      : null,
    freeTrail: raw.freeTrail && typeof raw.freeTrail === 'object'
      ? {
          start: Number(raw.freeTrail.start || 0) || 0,
          end: Number(raw.freeTrail.end || 0) || 0,
        }
      : null,
    songFee: Number(raw.songFee || 0) || 0,
    level: clean(raw.level || '', 40),
    plLevel: clean(raw.plLevel || '', 40),
    dlLevel: clean(raw.dlLevel || '', 40),
    maxBrLevel: clean(raw.maxBrLevel || '', 40),
    br: Number(raw.br || 0) || 0,
    songSize: Number(raw.songSize || raw.size || 0) || 0,
    songMd5: clean(raw.songMd5 || raw.md5 || '', 120),
    qualities: Array.isArray(raw.qualities) ? raw.qualities.map((x) => clean(x, 60)).filter(Boolean).slice(0, 40) : [],
    alg: clean(raw.alg || '', 500),
    openApiTraceInfo: raw.openApiTraceInfo && typeof raw.openApiTraceInfo === 'object' ? raw.openApiTraceInfo : null,
    trialScene: clean(raw.trialScene || '', 80),
    chorusMeta: raw.chorusMeta && typeof raw.chorusMeta === 'object'
      ? {
          startTime: Number(raw.chorusMeta.startTime || 0) || 0,
          endTime: Number(raw.chorusMeta.endTime || 0) || 0,
        }
      : null,
    gain: raw.gain === undefined || raw.gain === null ? null : Number(raw.gain),
    peak: raw.peak === undefined || raw.peak === null ? null : Number(raw.peak),
    audioBlob: raw.audioBlob instanceof Blob ? raw.audioBlob : null,
    audioType: clean(raw.audioType || raw.audioBlob?.type || '', 80),
    fileName: clean(raw.fileName || '', 180),
    fileModified: Number(raw.fileModified || 0) || 0,
    coverUrl: normalizeRemoteCoverUrl(raw.coverUrl || ''),
    coverTone: clean(raw.coverTone || toneBySeed(`${title}${artist}`), 24),
    lyricText: clean(raw.lyricText || raw.lyric || '', 12000),
    lyricLrc: clean(raw.lyricLrc || '', 24000),
    tags: Array.isArray(raw.tags) ? raw.tags.map((x) => clean(x, 40)).filter(Boolean).slice(0, 20) : [],
    createdAt: Number(raw.createdAt || now) || now,
    updatedAt: Number(raw.updatedAt || now) || now,
  };
}

export function normalizeMusicPlaylist(raw = {}) {
  const now = Date.now();
  return {
    id: clean(raw.id || id('pl'), 80),
    ownerType: clean(raw.ownerType || 'user', 32) || 'user',
    ownerId: clean(raw.ownerId || DEFAULT_OWNER_ID, 80),
    title: clean(raw.title || '新歌单', 120) || '新歌单',
    desc: clean(raw.desc || raw.description || '', 300),
    coverUrl: cleanPlaylistCoverUrl(raw.coverUrl),
    trackIds: uniq(raw.trackIds),
    visibility: clean(raw.visibility || 'private', 32) || 'private',
    generatedBy: clean(raw.generatedBy || 'user', 32) || 'user',
    createdAt: Number(raw.createdAt || now) || now,
    updatedAt: Number(raw.updatedAt || now) || now,
  };
}

function normalizeMusicComments(list = []) {
  if (!Array.isArray(list)) return [];
  return list
    .map((raw, index) => {
      const text = clean(cleanMusicPostContent(raw?.text || raw?.content || ''), 400);
      if (!text) return null;
      const now = Date.now();
      return {
        id: clean(raw?.id || `mc_${now}_${index}_${Math.random().toString(36).slice(2, 6)}`, 80),
        authorId: clean(raw?.authorId || raw?.characterId || '', 80),
        authorName: clean(raw?.authorName || '', 120),
        characterId: clean(raw?.characterId || '', 80),
        text,
        replyTo: clean(raw?.replyTo || '', 120),
        createdAt: Number(raw?.createdAt || now) || now,
      };
    })
    .filter(Boolean)
    .slice(0, 60);
}

export function normalizeMusicPost(raw = {}) {
  const now = Date.now();
  return {
    id: clean(raw.id || id('mp'), 80),
    authorId: clean(raw.authorId || raw.characterId || 'radio', 80),
    authorName: clean(raw.authorName || '', 120),
    authorType: clean(raw.authorType || (raw.characterId ? 'character' : (raw.authorId === 'user' ? 'user' : '')), 32),
    characterId: clean(raw.characterId || '', 80),
    trackId: clean(raw.trackId || '', 80),
    playlistId: clean(raw.playlistId || '', 80),
    content: clean(cleanMusicPostContent(raw.content || ''), 600),
    translation: clean(raw.translation || raw.contentTranslation || '', 600),
    mood: clean(raw.mood || '', 40),
    lyricQuote: clean(raw.lyricQuote || '', 300),
    visibility: clean(raw.visibility || 'square', 40),
    likes: Math.max(0, Number(raw.likes || 0) || 0),
    likedByMe: Boolean(raw.likedByMe),
    comments: normalizeMusicComments(raw.comments),
    createdAt: Number(raw.createdAt || now) || now,
    updatedAt: Number(raw.updatedAt || now) || now,
  };
}

async function seedMusicIfEmpty() {
  return false;
}

function isLegacySeedTrack(track) {
  return String(track?.source || '') === 'demo' || String(track?.id || '').startsWith('seed_');
}

function isLegacySeedPost(post) {
  return String(post?.id || '').startsWith('post_seed_') || String(post?.trackId || '').startsWith('seed_');
}

function filterPlayablePlaylist(playlist, validTrackIds) {
  const row = normalizeMusicPlaylist(playlist);
  row.trackIds = row.trackIds.filter((trackId) => validTrackIds.has(trackId));
  return row;
}

export async function loadMusicLibrary() {
  await seedMusicIfEmpty();
  const [tracks, playlists, posts] = await Promise.all([
    db.getAllRecords('musicTracks'),
    db.getAllRecords('musicPlaylists'),
    db.getAllRecords('musicPosts'),
  ]);
  const cleanTracks = (Array.isArray(tracks) ? tracks : [])
    .map(normalizeMusicTrack)
    .filter((track) => !isLegacySeedTrack(track))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const validTrackIds = new Set(cleanTracks.map((track) => track.id));
  const cleanPlaylists = (Array.isArray(playlists) ? playlists : [])
    .map((playlist) => filterPlayablePlaylist(playlist, validTrackIds))
    .filter((playlist) => !LEGACY_SEED_PLAYLIST_IDS.has(playlist.id))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const cleanPosts = (Array.isArray(posts) ? posts : [])
    .map(normalizeMusicPost)
    .filter((post) => !isLegacySeedPost(post) && validTrackIds.has(post.trackId))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { tracks: cleanTracks, playlists: cleanPlaylists, posts: cleanPosts };
}

export async function saveMusicTrack(track) {
  const row = normalizeMusicTrack({ ...track, updatedAt: Date.now() });
  await db.putRecord('musicTracks', row);
  return row;
}

export async function saveMusicPlaylist(playlist) {
  const row = normalizeMusicPlaylist({ ...playlist, updatedAt: Date.now() });
  await db.putRecord('musicPlaylists', row);
  return row;
}

export async function saveMusicPost(post) {
  const row = normalizeMusicPost({ ...post, updatedAt: Date.now() });
  await db.putRecord('musicPosts', row);
  return row;
}

export async function getMusicPost(postId) {
  const key = clean(postId, 80);
  if (!key) return null;
  const row = await db.getRecord('musicPosts', key);
  return row ? normalizeMusicPost(row) : null;
}

export async function deleteMusicPost(postId) {
  const key = clean(postId, 80);
  if (!key) return false;
  const existing = await db.getRecord('musicPosts', key);
  if (!existing) return false;
  await db.deleteRecord('musicPosts', key);
  return true;
}

export async function deleteMusicPlaylist(playlistId) {
  const key = clean(playlistId, 80);
  if (!key) return false;
  await db.deleteRecord('musicPlaylists', key);
  return true;
}

export async function deleteMusicTrack(trackId) {
  const key = clean(trackId, 80);
  if (!key) return false;
  const [playlists, posts] = await Promise.all([
    db.getAllRecords('musicPlaylists').catch(() => []),
    db.getAllRecords('musicPosts').catch(() => []),
  ]);
  const changed = [];
  for (const raw of (Array.isArray(playlists) ? playlists : [])) {
    const playlist = normalizeMusicPlaylist(raw);
    if (!playlist.trackIds.includes(key)) continue;
    playlist.trackIds = playlist.trackIds.filter((id) => id !== key);
    playlist.updatedAt = Date.now();
    changed.push(playlist);
  }
  if (changed.length) await db.putMany('musicPlaylists', changed);
  for (const post of (Array.isArray(posts) ? posts : [])) {
    if (String(post?.trackId || '') === key) await db.deleteRecord('musicPosts', post.id);
  }
  await db.deleteRecord('musicTracks', key);
  return true;
}

function isSameLocalAudioFile(track, file) {
  if (!track || !file || String(track.source || '') !== 'local') return false;
  const storedName = clean(track.fileName || `${track.title || ''}`, 180).toLowerCase();
  const incomingName = clean(file.name || '', 180).toLowerCase();
  if (!storedName || !incomingName || storedName !== incomingName) return false;
  const storedSize = Number(track.songSize || track.audioBlob?.size || 0) || 0;
  const incomingSize = Number(file.size || 0) || 0;
  if (storedSize && incomingSize && storedSize !== incomingSize) return false;
  const storedModified = Number(track.fileModified || 0) || 0;
  const incomingModified = Number(file.lastModified || 0) || 0;
  return !(storedModified && incomingModified && storedModified !== incomingModified);
}

export async function consolidateLocalTrackDuplicates(canonicalId, duplicateIds = []) {
  const duplicates = new Set(uniq(duplicateIds).filter((trackId) => trackId !== canonicalId));
  if (!canonicalId || !duplicates.size) return 0;
  const canonical = await db.getRecord('musicTracks', canonicalId).catch(() => null);
  if (!canonical) return 0;
  const [playlists, posts] = await Promise.all([
    db.getAllRecords('musicPlaylists').catch(() => []),
    db.getAllRecords('musicPosts').catch(() => []),
  ]);
  const changedPlaylists = [];
  for (const raw of (Array.isArray(playlists) ? playlists : [])) {
    const playlist = normalizeMusicPlaylist(raw);
    if (!playlist.trackIds.some((trackId) => duplicates.has(trackId))) continue;
    playlist.trackIds = uniq(playlist.trackIds.map((trackId) => (
      duplicates.has(trackId) ? canonicalId : trackId
    )));
    playlist.updatedAt = Date.now();
    changedPlaylists.push(playlist);
  }
  if (changedPlaylists.length) await db.putMany('musicPlaylists', changedPlaylists);
  const changedPosts = (Array.isArray(posts) ? posts : [])
    .filter((post) => duplicates.has(String(post?.trackId || '')))
    .map((post) => normalizeMusicPost({ ...post, trackId: canonicalId, updatedAt: Date.now() }));
  if (changedPosts.length) await db.putMany('musicPosts', changedPosts);
  for (const duplicateId of duplicates) {
    await db.deleteRecord('musicTracks', duplicateId);
  }
  return duplicates.size;
}

export async function importAudioFilesToLibrary(files = []) {
  const list = Array.from(files || []).filter((file) => (
    file instanceof File
    && (/^audio\//i.test(file.type) || /\.(mp3|wav|m4a|flac|ogg)$/i.test(file.name))
  ));
  if (!list.length) return [];
  let knownTracks = (await db.getAllRecords('musicTracks').catch(() => []))
    .map(normalizeMusicTrack);
  const rows = [];
  for (const file of list) {
    const matches = knownTracks.filter((track) => isSameLocalAudioFile(track, file));
    const canonical = matches.find((track) => track.audioBlob instanceof Blob) || matches[0] || null;
    // 不把文件选择器返回的同一个 File 句柄直接挂进多次 IDB 写入；
    // 独立 Blob 可避免旧 WebView 在删除重复记录时连带释放另一条的底层文件。
    const audioBlob = file.slice(0, file.size, file.type || 'audio/mpeg');
    const row = normalizeMusicTrack({
      ...(canonical || {}),
      id: canonical?.id || id('local'),
      title: canonical?.title || file.name.replace(/\.[^.]+$/, '') || '本地音乐',
      artist: canonical?.artist || '本地上传',
      source: 'local',
      provider: 'local',
      audioBlob,
      audioType: audioBlob.type || canonical?.audioType || '',
      fileName: file.name,
      fileModified: file.lastModified || 0,
      songSize: file.size || 0,
      mood: canonical?.mood || '本地',
      lyricText: canonical?.lyricText || '本地音频可绑定 LRC 或粘贴歌词。',
    });
    await db.putRecord('musicTracks', row);
    const duplicateIds = matches.map((track) => track.id).filter((trackId) => trackId !== row.id);
    await consolidateLocalTrackDuplicates(row.id, duplicateIds);
    knownTracks = knownTracks.filter((track) => !duplicateIds.includes(track.id) && track.id !== row.id);
    knownTracks.push(row);
    rows.push(row);
  }
  await addTracksToPlaylist('pl_local', rows.map((row) => row.id), {
    title: '本地导入',
    desc: '上传到本机音乐库',
  });
  return rows;
}

export async function createMusicPlaylist(title, overrides = {}) {
  const row = normalizeMusicPlaylist({
    ...overrides,
    id: overrides.id || id('pl'),
    title,
  });
  await db.putRecord('musicPlaylists', row);
  return row;
}

export async function addTracksToPlaylist(playlistId, trackIds = [], defaults = {}) {
  const key = clean(playlistId, 80);
  if (!key) return null;
  const existing = await db.getRecord('musicPlaylists', key).catch(() => null);
  const base = existing || normalizeMusicPlaylist({
    id: key,
    title: defaults.title || '我的收藏',
    desc: defaults.desc || '',
  });
  const next = normalizeMusicPlaylist({
    ...base,
    trackIds: uniq([...(trackIds || []), ...(base.trackIds || [])]),
    updatedAt: Date.now(),
  });
  await db.putRecord('musicPlaylists', next);
  return next;
}

export async function removeTrackFromPlaylist(playlistId, trackId) {
  const key = clean(playlistId, 80);
  const tid = clean(trackId, 80);
  if (!key || !tid) return null;
  const existing = await db.getRecord('musicPlaylists', key).catch(() => null);
  if (!existing) return null;
  const next = normalizeMusicPlaylist({
    ...existing,
    trackIds: uniq(existing.trackIds).filter((id) => id !== tid),
    updatedAt: Date.now(),
  });
  await db.putRecord('musicPlaylists', next);
  return next;
}

// 站点跑在 HTTPS 时，http 音频会被当成混合内容静默拦截（点了没声）。
// 网易云 CDN 支持 https，这里对返回链接做保险升级。
function upgradeMixedContentUrl(url) {
  const u = String(url || '').trim();
  if (!/^http:\/\//i.test(u)) return u;
  try {
    if (typeof window !== 'undefined' && window.location && window.location.protocol === 'https:') {
      return u.replace(/^http:\/\//i, 'https://');
    }
  } catch (_) {}
  return u;
}

export function createAudioUrlForTrack(track) {
  if (track?.audioBlob instanceof Blob) return URL.createObjectURL(track.audioBlob);
  if (track?.playUrl && (!track.playUrlExpireAt || Number(track.playUrlExpireAt) > Date.now())) {
    return upgradeMixedContentUrl(track.playUrl);
  }
  if (track?.sourceUrl && /^https?:\/\//i.test(track.sourceUrl)) return track.sourceUrl;
  return '';
}

export async function importMusicLinkToLibrary(raw = {}) {
  const title = clean(raw.title || '外链歌曲', 120);
  const url = clean(raw.sourceUrl || raw.url, 1200);
  const row = normalizeMusicTrack({
    id: id('link'),
    title,
    artist: raw.artist || '外部平台',
    source: 'link',
    sourceUrl: url,
    coverUrl: normalizeRemoteCoverUrl(raw.coverUrl || ''),
    mood: raw.mood || '外链',
    lyricText: raw.lyricText || '',
  });
  await db.putRecord('musicTracks', row);
  await addTracksToPlaylist('pl_links', [row.id], {
    title: '外链收藏',
    desc: '只保存元信息和官方链接',
  });
  return row;
}

export function normalizeNeteaseSong(raw = {}, overrides = {}) {
  const artists = Array.isArray(raw.artists) ? raw.artists : (Array.isArray(raw.fullArtists) ? raw.fullArtists : []);
  const artist = clean(raw.artistName || artists.map((item) => item?.name).filter(Boolean).join(' / ') || '', 180);
  const durationMs = Number(raw.duration || raw.durationMs || 0) || 0;
  const duration = durationMs ? `${Math.floor(durationMs / 60000)}:${String(Math.floor((durationMs % 60000) / 1000)).padStart(2, '0')}` : '';
  return normalizeMusicTrack({
    id: overrides.id || `netease_${clean(raw.id || raw.songId || '', 120) || id('song')}`,
    title: raw.name || raw.title || '',
    artist: artist || '网易云音乐',
    album: raw.album?.name || raw.albumName || '',
    duration,
    durationMs,
    source: 'netease',
    provider: 'netease',
    providerTrackId: raw.id || raw.songId || '',
    providerEncryptedId: raw.encryptedId || raw.encryptedSongId || '',
    providerPlaylistId: overrides.providerPlaylistId || '',
    coverUrl: normalizeRemoteCoverUrl(
      raw.coverImgUrl || raw.picUrl || raw.coverUrl || raw.imageUrl || raw.album?.picUrl || raw.album?.coverImgUrl || '',
    ),
    playUrl: raw.playUrl || '',
    playUrlExpireAt: raw.playUrlExpireTime ? Number(raw.playUrlExpireTime) : 0,
    playFlag: raw.playFlag,
    visible: raw.visible,
    vipFlag: raw.vipFlag,
    vipPlayFlag: raw.vipPlayFlag,
    payPlayFlag: raw.payPlayFlag,
    freeTrailFlag: raw.freeTrailFlag,
    freeTrialPrivilege: raw.freeTrialPrivilege || null,
    freeTrail: raw.freeTrail || null,
    songFee: raw.songFee,
    level: raw.level,
    plLevel: raw.plLevel,
    dlLevel: raw.dlLevel,
    maxBrLevel: raw.maxBrLevel,
    br: raw.br,
    songSize: raw.songSize || raw.size,
    songMd5: raw.songMd5 || raw.md5,
    qualities: Array.isArray(raw.qualities) ? raw.qualities : [],
    alg: raw.alg,
    openApiTraceInfo: raw.openApiTraceInfo || null,
    trialScene: overrides.trialScene || raw.trialScene || '',
    chorusMeta: raw.chorusMeta || null,
    gain: raw.gain,
    peak: raw.peak,
    tags: Array.isArray(raw.songTag) ? raw.songTag : [],
    mood: overrides.mood || '网易云',
    providerRaw: raw,
    ...overrides,
  });
}

export async function importNeteaseSongsToLibrary(songs = [], options = {}) {
  const rows = (Array.isArray(songs) ? songs : []).map((song) => normalizeNeteaseSong(song, options)).filter((row) => row.providerTrackId || row.title);
  if (!rows.length) return [];
  await db.putMany('musicTracks', rows);
  if (options.playlistId) {
    await addTracksToPlaylist(options.playlistId, rows.map((row) => row.id), {
      title: options.playlistTitle || '网易云导入',
      desc: '来自网易云官方授权',
    });
  }
  return rows;
}

export async function updateTrackLyrics(trackId, { lyricText = '', lyricLrc = '' } = {}) {
  const track = await db.getRecord('musicTracks', clean(trackId, 80));
  if (!track) return null;
  return saveMusicTrack({
    ...track,
    lyricText,
    lyricLrc,
  });
}

export async function importLyricFilesToLibrary(files = [], tracks = []) {
  const fileList = Array.from(files || []).filter((file) => file instanceof File && /\.(lrc|txt)$/i.test(file.name));
  if (!fileList.length) return { updated: 0, missed: [] };
  const rows = Array.isArray(tracks) && tracks.length ? tracks : (await loadMusicLibrary()).tracks;
  const normalized = rows.map((track) => ({
    track,
    key: clean(track.title, 120).toLowerCase().replace(/\s+/g, ''),
  }));
  let updated = 0;
  const missed = [];
  for (const file of fileList) {
    const base = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/\s+/g, '');
    const hit = normalized.find((item) => item.key && (base.includes(item.key) || item.key.includes(base)));
    if (!hit) {
      missed.push(file.name);
      continue;
    }
    const text = await file.text();
    const looksLrc = /\[\d{1,2}:\d{1,2}(?:\.\d+)?\]/.test(text);
    await updateTrackLyrics(hit.track.id, looksLrc ? { lyricLrc: text, lyricText: hit.track.lyricText || '' } : { lyricText: text, lyricLrc: hit.track.lyricLrc || '' });
    updated += 1;
  }
  return { updated, missed };
}
