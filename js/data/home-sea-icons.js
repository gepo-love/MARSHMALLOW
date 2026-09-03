/**
 * 棉花糖之海 · 极简线条图标集
 * 与 home-layout.js 各 appId 一一对应；画风为 24px 视口下的 2px 极简纯线条，无多余装饰。
 */

import { getCommercialHomeIcon } from './home-commercial-icons.js';

const SEA_ICONS = {
  // 页1
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="ic-line" d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  worldbook: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="ic-line" d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path class="ic-line" d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  preset: '<svg viewBox="0 0 24 24" aria-hidden="true"><line class="ic-line" x1="4" y1="21" x2="4" y2="14"/><line class="ic-line" x1="4" y1="10" x2="4" y2="3"/><line class="ic-line" x1="12" y1="21" x2="12" y2="12"/><line class="ic-line" x1="12" y1="8" x2="12" y2="3"/><line class="ic-line" x1="20" y1="21" x2="20" y2="16"/><line class="ic-line" x1="20" y1="12" x2="20" y2="3"/><line class="ic-line" x1="1" y1="14" x2="7" y2="14"/><line class="ic-line" x1="9" y1="8" x2="15" y2="8"/><line class="ic-line" x1="17" y1="16" x2="23" y2="16"/></svg>',
  encounter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="ic-line" d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle class="ic-line" cx="12" cy="10" r="3"/></svg>',

  // 页2
  weibo: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="ic-line" cx="12" cy="12" r="2"/><path class="ic-line" d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>',
  forum: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="ic-line" d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  stickers: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="ic-line" cx="12" cy="12" r="10"/><path class="ic-line" d="M8 14s1.5 2 4 2 4-2 4-2"/><line class="ic-line" x1="9" y1="9" x2="9.01" y2="9"/><line class="ic-line" x1="15" y1="9" x2="15.01" y2="9"/></svg>',
  radio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="ic-line" d="m5 7 13-4"/><rect class="ic-line" x="3" y="7" width="18" height="13" rx="3"/><path class="ic-line" d="M7 11h5M7 15h3"/><circle class="ic-line" cx="16.5" cy="13.5" r="2.5"/></svg>',
  companion: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="ic-line" d="M3 18v-6a9 9 0 0 1 18 0v6"/><path class="ic-line" d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
  memory: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="ic-line" x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle class="ic-line" cx="8.5" cy="8.5" r="1.5"/><polyline class="ic-line" points="21 15 16 10 5 21"/></svg>',
  music: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="ic-line" d="M9 18V5l12-2v13"/><circle class="ic-line" cx="6" cy="18" r="3"/><circle class="ic-line" cx="18" cy="16" r="3"/></svg>',
  'anon-chat': '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="ic-line" d="M9 10h.01"/><path class="ic-line" d="M15 10h.01"/><path class="ic-line" d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/></svg>',
  'character-phone': '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="ic-line" x="5" y="2" width="14" height="20" rx="2" ry="2"/><line class="ic-line" x1="12" y1="18" x2="12.01" y2="18"/></svg>',

  // 页3
  au: '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon class="ic-line" points="12 2 2 7 12 12 22 7 12 2"/><polyline class="ic-line" points="2 12 12 17 22 12"/><polyline class="ic-line" points="2 17 12 22 22 17"/></svg>',
  'travel-char': '<svg viewBox="0 0 24 24" aria-hidden="true"><line class="ic-line" x1="22" y1="2" x2="11" y2="13"/><polygon class="ic-line" points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  extensions: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="ic-line" x="3" y="4" width="18" height="16" rx="3"/><path class="ic-line" d="M7 9h5M7 13h10M7 17h7"/><path class="ic-line" d="M17 6v4M15 8h4"/></svg>',
  appearance: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="ic-line" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path class="ic-line" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  beautify: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="ic-line" x="3" y="3" width="18" height="18" rx="3"/><path class="ic-line" d="M3 9h18M9 3v18"/><circle class="ic-line" cx="15" cy="14" r="3"/><path class="ic-line" d="M17 16l3 3"/></svg>',

  // Dock
  contacts: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="ic-line" d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle class="ic-line" cx="9" cy="7" r="4"/><path class="ic-line" d="M23 21v-2a4 4 0 0 0-3-3.87"/><path class="ic-line" d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="ic-line" x="3" y="4" width="18" height="18" rx="2" ry="2"/><line class="ic-line" x1="16" y1="2" x2="16" y2="6"/><line class="ic-line" x1="8" y1="2" x2="8" y2="6"/><line class="ic-line" x1="3" y1="10" x2="21" y2="10"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="ic-line" cx="12" cy="12" r="3"/><path class="ic-line" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  'my-space': '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="ic-line" d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle class="ic-line" cx="12" cy="7" r="4"/></svg>',
};

const FALLBACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="ic-line" cx="12" cy="12" r="10"/><circle class="ic-line" cx="12" cy="12" r="2"/></svg>';

export function getSeaIcon(appId) {
  return SEA_ICONS[appId] || getCommercialHomeIcon(appId) || FALLBACK_ICON;
}
