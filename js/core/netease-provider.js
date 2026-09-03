const UNAVAILABLE_MESSAGE = '试玩版暂未连接网易云后端，正式版可直接扫码登录';

export const DEFAULT_NETEASE_PROXY_URL = '';

function unavailable() {
  throw new Error(UNAVAILABLE_MESSAGE);
}

function emptyConfig() {
  return {
    enabled: false,
    mode: 'disabled',
    appId: '',
    apiBaseUrl: '',
    clientType: 'web',
    redirectUrl: '',
    accessToken: '',
    refreshToken: '',
    tokenExpireAt: 0,
    profile: null,
    qrcode: null,
    lastDailyImage: null,
    updatedAt: 0,
  };
}

export async function loadNeteaseProviderConfig() {
  return emptyConfig();
}

export async function saveNeteaseProviderConfig() {
  return emptyConfig();
}

export function getNeteaseAuthUrl() {
  return '';
}

export function neteasePlaybackStatus(track = {}) {
  if (track.source !== 'netease' && track.provider !== 'netease') return '';
  return track.playUrl ? '已导入' : '试玩版不可联网刷新';
}

export async function warmNeteaseProxy() {
  return false;
}

export const checkNeteaseProxy = unavailable;
export const createNeteaseQrLogin = unavailable;
export const exchangeNeteaseCodeForToken = unavailable;
export const getNeteaseDailyImage = unavailable;
export const getNeteaseDailySongs = unavailable;
export const getNeteaseHeartModeSongs = unavailable;
export const getNeteaseMoreSongs = unavailable;
export const getNeteasePlaylistDetail = unavailable;
export const getNeteaseRecommendPlaylists = unavailable;
export const getNeteaseSimilarSongs = unavailable;
export const getNeteaseSongLyrics = unavailable;
export const getNeteaseSongPlayUrl = unavailable;
export const getNeteaseUserPlaylists = unavailable;
export const importNeteasePlaylistSongs = unavailable;
export const loadNeteaseProfile = unavailable;
export const pollNeteaseQrLogin = unavailable;
export const refreshNeteaseToken = unavailable;
export const searchNeteaseSongs = unavailable;
