/**
 * 主屏待开发入口图标。
 * 图形取自 Lucide（ISC），许可证见 /vendor/lucide/LICENSE。
 */

const ICONS = {
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/></svg>',
  browser: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.8 5.41a2 2 0 0 1-1.27 1.27l-5.41 1.8 1.8-5.41a2 2 0 0 1 1.27-1.27Z"/></svg>',
  map: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15M15 6v15"/><circle cx="15" cy="10" r="2"/></svg>',
  photos: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>',
  calls: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.8a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.33 1.85.56 2.81.69A2 2 0 0 1 22 16.92Z"/></svg>',
  interests: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z"/></svg>',
  avatars: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>',
  memo: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/><path d="M8 7h8M8 11h6"/></svg>',
  worldbook: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6a2 2 0 0 1 2-2h5a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H2Z"/><path d="M22 6a2 2 0 0 0-2-2h-5a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h7Z"/></svg>',
  preset: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>',
  encounter: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  weibo: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
  forum: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h6"/></svg>',
  stickers: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8.5L21 13.5V5a2 2 0 0 0-2-2Z"/><path d="M13 21v-6a2 2 0 0 1 2-2h6"/><path d="M8 9h.01M16 9h.01M8.5 13a5 5 0 0 0 7 0"/></svg>',
  'anon-chat': '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4M12 15v2"/></svg>',
  companion: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.5-1.5 3-3.2 3-5.5A4.5 4.5 0 0 0 17.5 4c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A4.5 4.5 0 0 0 4 8.5c0 2.3 1.5 4 3 5.5l6 6Z"/></svg>',
  radio: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4.9 19.1 14.2-14.2"/><rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="15.5" cy="13.5" r="2.5"/><path d="M7 11h3M7 15h2"/></svg>',
  memory: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.5-1.5 3-3.2 3-5.5A4.5 4.5 0 0 0 17.5 4c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A4.5 4.5 0 0 0 4 8.5c0 2.3 1.5 4 3 5.5l6 6Z"/><path d="M3.2 12H7l2-3 3 6 2-3h6"/></svg>',
  music: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  'character-phone': '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>',
  mailbox: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  au: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.1L5 10l5.1 1.9L12 17l1.9-5.1L19 10l-5.1-1.9Z"/><path d="M5 3v4M3 5h4M19 17v4M17 19h4"/></svg>',
  'travel-char': '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 19-9-9 19-2-8Z"/><path d="m11 13 6-6"/></svg>',
  extensions: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M7 8h10M7 12h6M7 16h8"/></svg>',
  appearance: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 22a10 10 0 1 0-10-10c0 5.5 4.5 10 10 10Z"/><path d="M12 22c2 0 3-1 3-2.5S14 17 12.5 17H11a2 2 0 0 1 0-4h1"/></svg>',
  beautify: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 4 5 5L7 22l-5-5Z"/><path d="m14 5 5 5M14 2v4M12 4h4M19 14v4M17 16h4"/></svg>',
  contacts: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 2v4M8 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/><circle cx="12" cy="15" r="2"/><path d="M8.5 20a4 4 0 0 1 7 0"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>',
  'my-space': '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 22a8 8 0 0 1 16 0"/></svg>',
  live: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1a10 10 0 0 1 0-14.2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>',
  'couple-space': '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.5-1.5 3-3.2 3-5.5A4.5 4.5 0 0 0 17.5 4c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A4.5 4.5 0 0 0 4 8.5c0 2.3 1.5 4 3 5.5l6 6Z"/><path d="m12 6-2 3 4 3-2 3"/></svg>',
  'together-reading': '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5c3-1 6-.5 8 2 2-2.5 5-3 8-2v14c-3-1-6-.5-8 2-2-2.5-5-3-8-2Z"/><path d="M12 7v14"/></svg>',
  'parallel-universe': '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a8 8 0 1 0-14.8 0"/><path d="M4.6 9a8 8 0 1 0 14.8 0"/></svg>',
  shopping: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/></svg>',
  mcp: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><path d="M6.5 10v4a3.5 3.5 0 0 0 3.5 3.5h4"/></svg>',
  'app-store': '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 7 2-5h16l2 5"/><path d="M5 13v9h14v-9"/><path d="M9 22v-5h6v5"/><path d="M2 7a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/></svg>',
  'play-together': '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 11h4M8 9v4"/><path d="M15 12h.01M18 10h.01"/><path d="M17.3 5H6.7A4.7 4.7 0 0 0 2 9.7v4.6A4.7 4.7 0 0 0 6.7 19l2.1-2h6.4l2.1 2a4.7 4.7 0 0 0 4.7-4.7V9.7A4.7 4.7 0 0 0 17.3 5Z"/></svg>',
  'strategy-game': '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 17.5-5-5L4 18l2 2 5.5-5.5"/><path d="m9.5 6.5 5 5L20 6l-2-2-5.5 5.5"/><path d="m14 4 6 6M4 14l6 6"/></svg>',
};

export function getCommercialHomeIcon(appId) {
  return ICONS[String(appId || '').trim()] || '';
}

const ALBUM_OBJECT_ICONS = new Set([
  'chat',
  'worldbook',
  'preset',
  'encounter',
  'weibo',
  'forum',
  'stickers',
  'anon-chat',
  'companion',
  'radio',
  'memory',
  'music',
  'mailbox',
  'character-phone',
  'au',
  'travel-char',
  'extensions',
  'mcp',
  'appearance',
  'beautify',
  'app-store',
  'live',
  'couple-space',
  'together-reading',
  'parallel-universe',
  'shopping',
  'play-together',
  'strategy-game',
  'contacts',
  'calendar',
  'settings',
  'my-space',
]);

export function hasAlbumHomeIcon(appId) {
  return ALBUM_OBJECT_ICONS.has(String(appId || '').trim());
}

export function getAlbumHomeIcon(appId) {
  const id = String(appId || '').trim();
  if (id === 'together-reading') return getCommercialHomeIcon(id);
  if (!hasAlbumHomeIcon(id)) return getCommercialHomeIcon(id);
  return `<svg class="album-object-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false"><image href="assets/icons/album/${id}.png?v=8" width="256" height="256" preserveAspectRatio="xMidYMid meet" /></svg>`;
}
