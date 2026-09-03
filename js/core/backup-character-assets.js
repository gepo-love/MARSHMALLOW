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

function normalizeShowcaseForAsset(images) {
  if (!Array.isArray(images) || !images.length) return undefined;
  const list = images
    .map((img) => {
      if (!img || typeof img !== 'object') return null;
      const url = String(img.url || img.dataUrl || '').trim();
      if (!hasImageReference(url)) return null;
      return {
        id: String(img.id || '').trim() || undefined,
        url,
        label: String(img.label || img.caption || '').trim() || undefined,
      };
    })
    .filter(Boolean);
  return list.length ? list : undefined;
}

/** 从角色记录提取头像 / 锁脸参考图 / 展示图，供资源包导出。 */
export function extractCharacterAssetRow(char) {
  if (!char || typeof char !== 'object' || !char.id) return null;
  const avatar = char.avatar ?? null;
  const imageLock = char.imageLock && typeof char.imageLock === 'object' ? { ...char.imageLock } : null;
  const showcaseImages = normalizeShowcaseForAsset(char.showcaseImages);

  const hasAvatar = hasImageReference(avatar);
  const hasLockRef = hasImageReference(imageLock?.refImageUrl)
    || (imageLock?.baseImageId && imageLock.baseImageId !== 'avatar');
  const hasShowcase = !!showcaseImages?.length;

  if (!hasAvatar && !hasLockRef && !hasShowcase) return null;

  const row = {
    id: String(char.id),
    name: String(char.name || '').trim(),
  };
  if (hasAvatar) row.avatar = avatar;
  if (imageLock && (hasLockRef || imageLock.mode || imageLock.prompt || imageLock.seed)) {
    row.imageLock = imageLock;
  }
  if (hasShowcase) row.showcaseImages = showcaseImages;
  return row;
}

/** 将资源包里的角色图像字段合并进现有角色（按 id 匹配）。 */
export function mergeCharacterAssetRow(existing, patch) {
  if (!existing || !patch?.id || existing.id !== patch.id) return null;
  const merged = { ...existing };
  if (patch.avatar != null) merged.avatar = patch.avatar;
  if (patch.imageLock && typeof patch.imageLock === 'object') {
    merged.imageLock = { ...(existing.imageLock || {}), ...patch.imageLock };
  }
  if (Array.isArray(patch.showcaseImages) && patch.showcaseImages.length) {
    const prev = Array.isArray(existing.showcaseImages) ? existing.showcaseImages : [];
    const byId = new Map(prev.filter(Boolean).map((img) => [String(img.id || img.url || ''), img]));
    for (const img of patch.showcaseImages) {
      if (!img) continue;
      const key = String(img.id || img.url || '');
      byId.set(key, { ...(byId.get(key) || {}), ...img });
    }
    merged.showcaseImages = [...byId.values()];
  }
  return merged;
}
