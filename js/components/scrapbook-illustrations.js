/** 手账风占位插画 · 替代 emoji 空态与默认头像 */

import { isOversizedAvatarDataUrl } from '../core/avatar-compaction.js';
import { defaultAvatarImage } from '../core/default-avatar.js';

const EMPTY = {
  chat: `<svg viewBox="0 0 80 80" aria-hidden="true"><path d="M14 44 Q14 24 40 24 Q66 24 66 44 Q66 58 52 58 L40 58 L24 66 L28 54 Q14 50 14 44" fill="#fff" stroke="#b6cde0" stroke-width="2.5"/><circle cx="32" cy="42" r="3" fill="#5c7b8f"/><circle cx="48" cy="42" r="3" fill="#5c7b8f"/></svg>`,
  message: `<svg viewBox="0 0 80 80" aria-hidden="true"><rect x="16" y="22" width="48" height="34" rx="6" fill="#fff" stroke="#f1b98f" stroke-width="2.5"/><path d="M16 28 L40 42 L64 28" fill="none" stroke="#b6cde0" stroke-width="2"/><path d="M58 18 L68 12 L66 24 Z" fill="#d5e4ed"/></svg>`,
  moon: `<svg viewBox="0 0 80 80" aria-hidden="true"><path d="M48 18 A22 22 0 1 0 48 62 A18 18 0 1 1 48 18" fill="#fff" stroke="#b6cde0" stroke-width="2.5"/><circle cx="54" cy="24" r="2" fill="#f1b98f"/></svg>`,
  memory: `<svg viewBox="0 0 80 80" aria-hidden="true"><rect x="18" y="20" width="44" height="40" rx="4" fill="#fff" stroke="#f1b98f" stroke-width="2"/><circle cx="40" cy="36" r="10" fill="#d5e4ed"/><path d="M24 54 L34 44 L48 52 L58 38" fill="none" stroke="#b6cde0" stroke-width="2.5" stroke-linecap="round"/></svg>`,
  camera: `<svg viewBox="0 0 80 80" aria-hidden="true"><rect x="16" y="28" width="48" height="32" rx="6" fill="#fff" stroke="#b6cde0" stroke-width="2.5"/><circle cx="40" cy="44" r="10" fill="#f8d3c5" stroke="#5c7b8f" stroke-width="2"/><rect x="28" y="22" width="12" height="8" rx="2" fill="#f1b98f"/></svg>`,
  sticker: `<svg viewBox="0 0 80 80" aria-hidden="true"><path d="M24 24 L56 24 L56 56 L24 56 Z" fill="#f8d3c5" stroke="#f1b98f" stroke-width="2"/><circle cx="40" cy="40" r="10" fill="#fff"/><path d="M52 18 L64 30 L64 18 Z" fill="#b6cde0"/></svg>`,
  book: `<svg viewBox="0 0 80 80" aria-hidden="true"><path d="M22 18 H58 Q62 18 62 22 V62 Q62 66 58 66 H22 Q18 66 18 62 V22 Q18 18 22 18" fill="#fff" stroke="#f1b98f" stroke-width="2.5"/><path d="M40 18 V66" stroke="#b6cde0" stroke-width="2"/><circle cx="30" cy="34" r="4" fill="#d5e4ed"/></svg>`,
};

export function escAttr(value = '') {
  return String(value ?? '').replace(/"/g, '&quot;');
}

export function emptyIllustration(name = 'chat', className = 'scrapbook-empty-art') {
  const svg = EMPTY[name] || EMPTY.chat;
  return `<span class="${className}">${svg}</span>`;
}

export function characterAvatarHtml(char, { className = 'character-avatar', fallbackClass = '' } = {}) {
  const avatar = String(char?.avatar || '').trim();
  // 历史遗留的超大头像（未压缩相机直出图）不直接内嵌：列表页角色一多就会拼出几十 MB 的
  // innerHTML 字符串，导致切页卡顿甚至闷死渲染进程。这类头像会被后台一次性收敛，收敛完成前先按无头像显示。
  if (avatar && !isOversizedAvatarDataUrl(avatar)) {
    return `<img class="${className}" src="${escAttr(avatar)}" alt="" decoding="async">`;
  }
  const cls = [className, 'is-fallback', fallbackClass].filter(Boolean).join(' ');
  return defaultAvatarImage('chat', cls);
}

export function characterAvatarInner(char) {
  return characterAvatarHtml(char, { className: '' }).replace(/^<img class="" /, '<img ').replace(/class=" is-fallback"/, 'class="is-fallback"');
}
