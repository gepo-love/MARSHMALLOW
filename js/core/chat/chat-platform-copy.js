import { getChatPlatformSync, normalizeChatPlatform } from '../appearance-prefs.js';

export function getChatPlatformCopy(platform = getChatPlatformSync()) {
  const normalized = normalizeChatPlatform(platform);
  const qq = normalized === 'qq';
  return {
    platform: normalized,
    isQq: qq,
    momentsName: qq ? 'QQ空间' : '朋友圈',
    momentsFeedName: qq ? '空间动态' : '朋友圈',
    momentsPromptName: qq ? 'QQ空间动态' : '朋友圈动态',
    postVerb: qq ? '发动态' : '发朋友圈',
    profileTitle: (name = 'TA') => qq ? `${name}的空间` : `${name}的朋友圈`,
    sharePrefix: qq ? '[QQ空间]' : '[朋友圈]',
  };
}
