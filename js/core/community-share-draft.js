import { navigate } from './router.js';
import { inferCommunityUploadMetadata } from './community-resource-package.js';

const SHARE_DRAFT_KEY = '__MM_COMMUNITY_SHARE_DRAFT__';

function clean(value, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

export function setCommunityShareDraft(options = {}) {
  const source = options.source;
  if (source == null || (typeof source !== 'object' && typeof source !== 'string')) {
    throw new Error('没有可分享的资源内容');
  }
  const inferred = inferCommunityUploadMetadata(source, options.fileName || '');
  const draft = {
    source,
    fileName: clean(options.fileName, 180),
    resourceType: clean(options.resourceType || inferred.resourceType, 40),
    resourceSubtype: clean(options.resourceSubtype || inferred.resourceSubtype, 40),
    title: clean(options.title || inferred.title, 80),
    version: clean(options.version, 30) || '1.0.0',
    originLabel: clean(options.originLabel, 60) || '当前功能',
    createdAt: Date.now(),
  };
  globalThis[SHARE_DRAFT_KEY] = draft;
  return draft;
}

export function getCommunityShareDraft() {
  const draft = globalThis[SHARE_DRAFT_KEY];
  if (!draft || Date.now() - Number(draft.createdAt || 0) > 30 * 60 * 1000) {
    delete globalThis[SHARE_DRAFT_KEY];
    return null;
  }
  return draft;
}

export function clearCommunityShareDraft() {
  delete globalThis[SHARE_DRAFT_KEY];
}

export function shareToCommunityStore(options = {}) {
  setCommunityShareDraft(options);
  navigate('app-store', { share: '1' });
}
