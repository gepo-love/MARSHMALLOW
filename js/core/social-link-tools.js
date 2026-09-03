import * as db from './db.js';

export const SOCIAL_LINK_CONFIG_KEY = 'socialLinkApiConfig';

export const DEFAULT_SOCIAL_LINK_CONFIG = {
  enabled: false,
  provider: 'tikhub',
  apiKey: '',
  includeComments: false,
  commentCount: 3,
  cacheDays: 3,
  // APK 用内置网页窗截图兜底解析小红书/微博/淘宝等分享链接：截图会发给用户当前配置的
  // 识图模型，因此默认关闭；原生缓存与消息里的临时截图会在一次识图成功后清理。
  webviewFallbackEnabled: false,
  webviewFallbackMaxShots: 2,
};

function mergeConfig(value = {}) {
  return {
    ...DEFAULT_SOCIAL_LINK_CONFIG,
    ...(value || {}),
    provider: 'tikhub',
    apiKey: String(value?.apiKey || '').trim(),
    includeComments: value?.includeComments !== undefined ? !!value.includeComments : DEFAULT_SOCIAL_LINK_CONFIG.includeComments,
    commentCount: Math.max(0, Math.min(20, Number(value?.commentCount ?? DEFAULT_SOCIAL_LINK_CONFIG.commentCount) || 0)),
    cacheDays: Math.max(1, Math.min(30, Number(value?.cacheDays || DEFAULT_SOCIAL_LINK_CONFIG.cacheDays) || DEFAULT_SOCIAL_LINK_CONFIG.cacheDays)),
    webviewFallbackEnabled: value?.webviewFallbackEnabled === true,
    webviewFallbackMaxShots: Math.max(1, Math.min(3, Number(value?.webviewFallbackMaxShots ?? DEFAULT_SOCIAL_LINK_CONFIG.webviewFallbackMaxShots) || DEFAULT_SOCIAL_LINK_CONFIG.webviewFallbackMaxShots)),
  };
}

export async function loadSocialLinkConfig() {
  const row = await db.get('settings', SOCIAL_LINK_CONFIG_KEY);
  return mergeConfig(row?.value || {});
}

export async function saveSocialLinkConfig(config = {}) {
  const next = mergeConfig(config);
  await db.put('settings', { key: SOCIAL_LINK_CONFIG_KEY, value: next });
  return next;
}
