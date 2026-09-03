const _state = {
  currentUserId: '',
  wallpaperDataUrl: '',
};

export function getState() {
  return { ..._state };
}

export function setState(partial = {}) {
  Object.assign(_state, partial || {});
}
