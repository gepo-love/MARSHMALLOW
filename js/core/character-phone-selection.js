function cleanId(value = '') {
  return String(value || '').trim();
}

/**
 * 显式请求某位角色的手机时，只能打开这一位；若不在当前身份范围内就回到选择页。
 * 仅在没有显式目标且当前范围恰好一人时，才自动选中唯一角色。
 */
export function resolveCharacterPhoneSelection(requestedId = '', characters = []) {
  const requested = cleanId(requestedId);
  const ids = new Set((Array.isArray(characters) ? characters : [])
    .map((row) => cleanId(row?.id || row))
    .filter(Boolean));
  if (requested) {
    return ids.has(requested)
      ? { selectedId: requested, unavailableRequestedId: '' }
      : { selectedId: '', unavailableRequestedId: requested };
  }
  const availableIds = [...ids];
  return {
    selectedId: availableIds.length === 1 ? availableIds[0] : '',
    unavailableRequestedId: '',
  };
}
