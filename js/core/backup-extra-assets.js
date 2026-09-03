function hasImageReference(value) {
  if (value == null) return false;
  if (typeof value === 'string') {
    const v = value.trim();
    if (!v) return false;
    return v.startsWith('data:image')
      || v.startsWith('blob:')
      || /^https?:\/\//i.test(v);
  }
  if (typeof value === 'object') {
    return hasImageReference(value.url) || hasImageReference(value.dataUrl);
  }
  return false;
}

/** 用户槽位头像（通讯录 / 聊天里显示的用户头像）。 */
export function extractUserAssetRow(user) {
  if (!user || typeof user !== 'object' || !user.id) return null;
  const avatar = user.avatar ?? user.videoAvatar ?? user.videoProfileImage ?? null;
  if (!hasImageReference(avatar)) return null;
  return {
    id: String(user.id),
    name: String(user.name || '').trim(),
    avatar,
  };
}

export function mergeUserAssetRow(existing, patch) {
  if (!existing || !patch?.id || existing.id !== patch.id) return null;
  if (patch.avatar == null) return null;
  return { ...existing, avatar: patch.avatar };
}

/** 会话壁纸 / 群头像等 groupSettings 里的图像资源。 */
export function extractChatAssetRow(chat) {
  if (!chat || typeof chat !== 'object' || !chat.id) return null;
  const gs = chat.groupSettings && typeof chat.groupSettings === 'object' ? chat.groupSettings : {};
  const wallpaper = gs.wallpaper ?? null;
  const groupAvatar = gs.avatar ?? null;
  const hasWallpaper = hasImageReference(wallpaper);
  const hasAvatar = hasImageReference(groupAvatar);
  if (!hasWallpaper && !hasAvatar) return null;
  const row = { id: String(chat.id) };
  if (hasWallpaper) row.wallpaper = wallpaper;
  if (hasAvatar) row.groupAvatar = groupAvatar;
  return row;
}

export function mergeChatAssetRow(existing, patch) {
  if (!existing || !patch?.id || existing.id !== patch.id) return null;
  const gs = { ...(existing.groupSettings || {}) };
  let changed = false;
  if (patch.wallpaper != null) {
    gs.wallpaper = patch.wallpaper;
    changed = true;
  }
  if (patch.groupAvatar != null) {
    gs.avatar = patch.groupAvatar;
    changed = true;
  }
  if (!changed) return null;
  return { ...existing, groupSettings: gs };
}
