function attrs(className = '') {
  return className ? ` class="${String(className).replace(/"/g, '&quot;')}"` : '';
}

/** 微信平台壳专用线性图标。保持 24×24 同一笔触，避免复用通用图标造成平台走样。 */
export function wechatGlyph(name, className = 'wechat-glyph') {
  const common = `${attrs(className)} viewBox="0 0 24 24" aria-hidden="true"`;
  if (name === 'chats') return `<svg ${common}><path d="M4.2 5.5h11.2a4.1 4.1 0 0 1 4.1 4.1v2.7a4.1 4.1 0 0 1-4.1 4.1H10l-4.7 2.8.8-3.2a4.1 4.1 0 0 1-1.9-3.5V9.6a4.1 4.1 0 0 1 4.1-4.1Z"/><path d="M8 10.8h.01M11.9 10.8h.01M15.8 10.8h.01"/></svg>`;
  if (name === 'contacts') return `<svg ${common}><circle cx="12" cy="7.1" r="3.2"/><path d="M5.7 19c.4-4.2 2.5-6.3 6.3-6.3s5.9 2.1 6.3 6.3M18.2 6.6c1.2.3 2 1.4 2 2.6s-.8 2.2-1.9 2.6M19.1 14.3c1.5.8 2.3 2.2 2.5 4.3"/></svg>`;
  if (name === 'discover') return `<svg ${common}><circle cx="12" cy="12" r="8.3"/><path d="m14.7 9.3-1.6 3.8-3.8 1.6 1.6-3.8 3.8-1.6Z"/></svg>`;
  if (name === 'me') return `<svg ${common}><circle cx="12" cy="7" r="3.25"/><path d="M5.5 19.3c.5-4.4 2.7-6.6 6.5-6.6s6 2.2 6.5 6.6"/></svg>`;
  if (name === 'search') return `<svg ${common}><circle cx="10.7" cy="10.7" r="6.2"/><path d="m15.3 15.3 4.2 4.2"/></svg>`;
  if (name === 'back') return `<svg ${common}><path d="m14.7 4.7-7.1 7.3 7.1 7.3"/></svg>`;
  if (name === 'more') return `<svg ${common}><path d="M5.2 12h.01M12 12h.01M18.8 12h.01"/></svg>`;
  if (name === 'plus') return `<svg ${common}><circle cx="12" cy="12" r="9.25"/><path d="M12 7.15v9.7M7.15 12h9.7"/></svg>`;
  if (name === 'voice-input') return `<svg ${common}><circle cx="12" cy="12" r="9.25"/><path d="M7.2 10.25c1.2.85 1.2 2.65 0 3.5M9.65 8.2c2.45 2.05 2.45 5.55 0 7.6M12.25 6.15c3.65 3.25 3.65 8.45 0 11.7"/></svg>`;
  if (name === 'emoji') return `<svg ${common}><circle cx="12" cy="12" r="9.25"/><circle cx="8.6" cy="9.45" r=".85" fill="currentColor" stroke="none"/><circle cx="15.4" cy="9.45" r=".85" fill="currentColor" stroke="none"/><path d="M6.95 13.15h10.1c-.72 2.7-2.4 4.05-5.05 4.05s-4.33-1.35-5.05-4.05Z"/></svg>`;
  if (name === 'mic') return `<svg ${common}><path d="M12 2.9a3.2 3.2 0 0 0-3.2 3.2v5.45a3.2 3.2 0 0 0 6.4 0V6.1A3.2 3.2 0 0 0 12 2.9Z"/><path d="M5.9 11.45a6.1 6.1 0 0 0 12.2 0M12 17.55v3.15M9 20.7h6"/></svg>`;
  if (name === 'camera') return `<svg ${common}><path d="M4 8.3h3l1.4-2.2h7.2L17 8.3h3v10.1H4V8.3Z"/><circle cx="12" cy="13.2" r="3.2"/></svg>`;
  if (name === 'chevron') return `<svg ${common}><path d="m9 5.5 6.2 6.5L9 18.5"/></svg>`;
  if (name === 'new-friend') return `<svg ${common}><circle cx="10" cy="8.2" r="3"/><path d="M4.5 18c.4-3.9 2.2-5.8 5.5-5.8 1.7 0 3 .5 3.9 1.4M18 12.5v6M15 15.5h6"/></svg>`;
  if (name === 'only-chat') return `<svg ${common}><path d="M4 5.5h16v11H9l-4.2 2.7.7-2.7H4v-11Z"/><circle cx="12" cy="9.3" r="2"/><path d="M8.8 14c.3-1.7 1.4-2.6 3.2-2.6s2.9.9 3.2 2.6"/></svg>`;
  if (name === 'group') return `<svg ${common}><circle cx="9" cy="8.3" r="2.7"/><circle cx="16.2" cy="9.2" r="2.2"/><path d="M3.8 18c.4-3.7 2.1-5.5 5.2-5.5s4.8 1.8 5.2 5.5M14.2 14c3.4-.5 5.4.9 6 4"/></svg>`;
  if (name === 'tag') return `<svg ${common}><path d="M4.2 5.1h8.1l7.1 7.1-7.3 7.3L4.2 11.6V5.1Z"/><circle cx="8.4" cy="9.2" r="1.2"/></svg>`;
  if (name === 'official') return `<svg ${common}><path d="M5 5.2h5.3c1.1 0 1.7.6 1.7 1.7v12c0-1.1-.6-1.7-1.7-1.7H5v-12ZM19 5.2h-5.3c-1.1 0-1.7.6-1.7 1.7v12c0-1.1.6-1.7 1.7-1.7H19v-12Z"/></svg>`;
  if (name === 'service') return `<svg ${common}><path d="m8.2 5 3.8 7-3.8 7L4.4 12l3.8-7ZM15.8 5l3.8 7-3.8 7-3.8-7 3.8-7Z"/></svg>`;
  if (name === 'moments') return `<svg ${common}><circle cx="12" cy="12" r="4.2"/><path d="M12 2.8 15 7H9l3-4.2ZM21.2 12 17 15V9l4.2 3ZM12 21.2 9 17h6l-3 4.2ZM2.8 12 7 9v6l-4.2-3Z"/></svg>`;
  if (name === 'channels') return `<svg ${common}><path d="M5 5.5h14v13H5z"/><path d="m10 9 5 3-5 3V9Z"/></svg>`;
  if (name === 'scan') return `<svg ${common}><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M8 8h3v3H8zM14 8h2v2h-2zM8 14h2v2H8zM13 13h3v3h-3z"/></svg>`;
  if (name === 'look') return `<svg ${common}><path d="M4.2 12s2.8-5 7.8-5 7.8 5 7.8 5-2.8 5-7.8 5-7.8-5-7.8-5Z"/><circle cx="12" cy="12" r="2.4"/></svg>`;
  if (name === 'search-page') return `<svg ${common}><circle cx="10.4" cy="10.4" r="5.6"/><path d="m14.6 14.6 4.8 4.8M5.2 5.2 3.6 3.6"/></svg>`;
  if (name === 'mini') return `<svg ${common}><rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/></svg>`;
  if (name === 'services') return `<svg ${common}><path d="M4.5 7.3h15v10.4h-15z"/><path d="M8 7.3V5.4h8v1.9M4.5 11.3h15"/><circle cx="12" cy="14.5" r="1.4"/></svg>`;
  if (name === 'favorite') return `<svg ${common}><path d="m12 4.2 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8L12 4.2Z"/></svg>`;
  if (name === 'cards') return `<svg ${common}><rect x="4" y="6" width="16" height="12" rx="1.8"/><path d="M4 10h16M7.5 14.5h4"/></svg>`;
  if (name === 'sticker') return `<svg ${common}><path d="M5 4.5h14v9.1L13.6 19H5V4.5Z"/><path d="M13.6 19v-5.4H19M8.2 9h.01M15.8 9h.01M8.8 12.4c1.8 1.3 4.6 1.3 6.4 0"/></svg>`;
  if (name === 'settings') return `<svg ${common}><circle cx="12" cy="12" r="3"/><path d="M12 3.4v2M12 18.6v2M3.4 12h2M18.6 12h2M5.9 5.9l1.4 1.4M16.7 16.7l1.4 1.4M18.1 5.9l-1.4 1.4M7.3 16.7l-1.4 1.4"/></svg>`;
  return `<svg ${common}><circle cx="12" cy="12" r="8"/></svg>`;
}
