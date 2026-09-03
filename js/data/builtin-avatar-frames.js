export const BUILTIN_AVATAR_FRAMES = [
  {
    id: 'clean-ring',
    name: '清透圆环',
    css: `.chat-thread-page .chat-bubble-avatar {
  --chat-bubble-avatar-radius: 50%;
  border: 3px solid rgba(255,255,255,.92);
  box-shadow: 0 0 0 2px rgba(112,157,181,.48), 0 6px 14px rgba(53,82,98,.16);
}`,
  },
  {
    id: 'pearl',
    name: '珍珠方框',
    css: `.chat-thread-page .chat-bubble-avatar {
  --chat-bubble-avatar-radius: 14px;
  border: 3px double rgba(235,220,190,.95);
  box-shadow: 0 0 0 2px rgba(255,255,255,.9), 0 5px 16px rgba(89,74,55,.16);
}`,
  },
  {
    id: 'night-glow',
    name: '夜海微光',
    css: `.chat-thread-page .chat-bubble-avatar {
  --chat-bubble-avatar-radius: 50%;
  border: 2px solid rgba(166,215,239,.9);
  box-shadow: 0 0 0 3px rgba(52,91,117,.75), 0 0 16px rgba(105,190,229,.48);
}`,
  },
  {
    id: 'ribbon',
    name: '丝带框',
    css: `.chat-thread-page .chat-bubble-avatar {
  --chat-bubble-avatar-radius: 12px;
  border: 3px solid #f1c4cf;
  box-shadow: -3px 3px 0 #fff, -5px 5px 0 rgba(178,126,143,.35);
}`,
  },
];
