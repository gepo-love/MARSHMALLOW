const DEFAULT_AVATAR_URLS = Object.freeze({
  chat: 'assets/avatars/defaults/chat.webp',
  anonymous: 'assets/avatars/defaults/anonymous.webp',
  forum: 'assets/avatars/defaults/forum.webp',
  weibo: 'assets/avatars/defaults/weibo.webp',
});

const LEGACY_AVATAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#f8d3c5"/><circle cx="35" cy="45" r="4" fill="#5c7b8f"/><circle cx="65" cy="45" r="4" fill="#5c7b8f"/><path d="M 45 55 Q 50 60 55 55" fill="none" stroke="#5c7b8f" stroke-width="3" stroke-linecap="round"/></svg>';
const LEGACY_AVATAR_URL = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(LEGACY_AVATAR_SVG)}`;
const MARSHMALLOW_AVATAR_URL = 'assets/avatars/defaults/marshmallow.webp';

export const DEFAULT_AVATAR_STYLE_KEY = 'marshmallow-default-avatar-style';
export const CUSTOM_DEFAULT_AVATAR_KEY = 'marshmallow-custom-default-avatar';
export const DEFAULT_AVATAR_STYLE_CHANGED_EVENT = 'marshmallow-default-avatar-style-changed';
export const DEFAULT_AVATAR_STYLES = Object.freeze([
  Object.freeze({ id: 'original', label: '原款', description: '熟悉的粉色笑脸', preview: LEGACY_AVATAR_URL }),
  Object.freeze({ id: 'neutral', label: '中性灰调', description: '按页面切换黑白灰', preview: DEFAULT_AVATAR_URLS.chat }),
  Object.freeze({ id: 'marshmallow', label: '棉花糖', description: '粉嫩波点与小装饰', preview: MARSHMALLOW_AVATAR_URL }),
]);

const DEFAULT_AVATAR_STYLE_IDS = new Set(DEFAULT_AVATAR_STYLES.map((item) => item.id));

export function getCustomDefaultAvatar() {
  if (typeof localStorage === 'undefined') return '';
  const value = String(localStorage.getItem(CUSTOM_DEFAULT_AVATAR_KEY) || '').trim();
  return /^data:image\//i.test(value) && value.length <= 400000 ? value : '';
}

export function listDefaultAvatarStyles() {
  const custom = getCustomDefaultAvatar();
  return custom
    ? [...DEFAULT_AVATAR_STYLES, Object.freeze({ id: 'custom', label: '我的图片', description: '本机上传的默认头像', preview: custom })]
    : [...DEFAULT_AVATAR_STYLES];
}

export function getDefaultAvatarStyle() {
  if (typeof localStorage === 'undefined') return 'original';
  const saved = String(localStorage.getItem(DEFAULT_AVATAR_STYLE_KEY) || '').trim();
  if (saved === 'custom' && getCustomDefaultAvatar()) return 'custom';
  return DEFAULT_AVATAR_STYLE_IDS.has(saved) ? saved : 'original';
}

export function setDefaultAvatarStyle(styleId = 'original') {
  const requested = String(styleId || '');
  const next = requested === 'custom' && getCustomDefaultAvatar()
    ? 'custom'
    : (DEFAULT_AVATAR_STYLE_IDS.has(requested) ? requested : 'original');
  if (typeof localStorage !== 'undefined') localStorage.setItem(DEFAULT_AVATAR_STYLE_KEY, next);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DEFAULT_AVATAR_STYLE_CHANGED_EVENT, { detail: { style: next } }));
  }
  return next;
}

export function setCustomDefaultAvatar(dataUrl = '') {
  const value = String(dataUrl || '').trim();
  if (!/^data:image\//i.test(value)) throw new Error('请选择有效的图片');
  if (value.length > 400000) throw new Error('图片压缩后仍然过大，请换一张图片');
  if (typeof localStorage === 'undefined') throw new Error('当前环境无法保存默认头像');
  try {
    localStorage.setItem(CUSTOM_DEFAULT_AVATAR_KEY, value);
  } catch (_) {
    throw new Error('本机存储空间不足，无法保存默认头像');
  }
  return setDefaultAvatarStyle('custom');
}

export function clearCustomDefaultAvatar() {
  const wasCustom = typeof localStorage !== 'undefined'
    && localStorage.getItem(DEFAULT_AVATAR_STYLE_KEY) === 'custom';
  if (typeof localStorage !== 'undefined') localStorage.removeItem(CUSTOM_DEFAULT_AVATAR_KEY);
  if (wasCustom) setDefaultAvatarStyle('original');
}

export function resolveDefaultAvatar(scope = 'chat', styleId = getDefaultAvatarStyle()) {
  if (styleId === 'original') return LEGACY_AVATAR_URL;
  if (styleId === 'marshmallow') return MARSHMALLOW_AVATAR_URL;
  if (styleId === 'custom') return getCustomDefaultAvatar() || LEGACY_AVATAR_URL;
  const key = String(scope || '').toLowerCase();
  if (key.includes('anonymous') || key.includes('anon')) return DEFAULT_AVATAR_URLS.anonymous;
  if (key.includes('forum')) return DEFAULT_AVATAR_URLS.forum;
  if (key.includes('weibo')) return DEFAULT_AVATAR_URLS.weibo;
  return DEFAULT_AVATAR_URLS.chat;
}

export function defaultAvatarImage(scope = 'chat', className = '') {
  const cls = String(className || '').trim();
  return `<img${cls ? ` class="${cls}"` : ''} src="${resolveDefaultAvatar(scope)}" alt="" loading="lazy" decoding="async">`;
}
