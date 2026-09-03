import * as db from '../db.js';

export const WEIBO_COMPOSER_MAX_MEDIA = 9;
export const WEIBO_COMPOSER_MAX_TEXT = 2000;

function clean(value = '') {
  return String(value ?? '').trim();
}

function draftKey(ownerUserId = '') {
  return `weiboComposerDraft_${clean(ownerUserId) || 'guest'}`;
}

function normalizeMediaItem(item = {}, index = 0) {
  const url = clean(item.url);
  if (!url) return null;
  const status = item.status === 'failed' ? 'failed' : 'ready';
  return {
    id: clean(item.id) || `wb_media_${Date.now()}_${index}`,
    url,
    source: ['local', 'generated', 'sticker'].includes(item.source) ? item.source : 'local',
    status,
    prompt: clean(item.prompt),
    provider: clean(item.provider),
    error: status === 'failed' ? clean(item.error) : '',
    createdAt: Math.max(0, Number(item.createdAt || Date.now()) || Date.now()),
  };
}

export function createWeiboComposerDraft(ownerUserId = '') {
  return {
    id: `wb_draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ownerUserId: clean(ownerUserId) || 'guest',
    text: '',
    textImage: '',
    topic: '',
    visibility: 'public',
    media: [],
    generatedCandidate: null,
    updatedAt: Date.now(),
  };
}

export function normalizeWeiboComposerDraft(value = {}, ownerUserId = '') {
  const fallback = createWeiboComposerDraft(ownerUserId);
  const candidate = value?.generatedCandidate
    ? normalizeMediaItem(value.generatedCandidate, 99)
    : null;
  return {
    ...fallback,
    id: clean(value.id) || fallback.id,
    ownerUserId: clean(ownerUserId || value.ownerUserId) || 'guest',
    text: String(value.text || '').slice(0, WEIBO_COMPOSER_MAX_TEXT),
    textImage: String(value.textImage || value.textImageCaption || '').slice(0, 1200),
    topic: clean(value.topic).replace(/^#+|#+$/g, '').slice(0, 80),
    visibility: ['public', 'fans_only', 'private'].includes(value.visibility)
      ? value.visibility
      : 'public',
    media: (Array.isArray(value.media) ? value.media : [])
      .map(normalizeMediaItem)
      .filter(Boolean)
      .slice(0, WEIBO_COMPOSER_MAX_MEDIA),
    generatedCandidate: candidate,
    updatedAt: Math.max(0, Number(value.updatedAt || Date.now()) || Date.now()),
  };
}

export async function loadWeiboComposerDraft(ownerUserId = '') {
  const row = await db.get('settings', draftKey(ownerUserId));
  return normalizeWeiboComposerDraft(row?.value || {}, ownerUserId);
}

export async function saveWeiboComposerDraft(draft, ownerUserId = '') {
  const normalized = normalizeWeiboComposerDraft({
    ...(draft || {}),
    updatedAt: Date.now(),
  }, ownerUserId);
  await db.put('settings', { key: draftKey(normalized.ownerUserId), value: normalized });
  return normalized;
}

export async function clearWeiboComposerDraft(ownerUserId = '') {
  await db.remove(draftKey(ownerUserId));
}

export function appendWeiboComposerMedia(draft, items = []) {
  const normalized = normalizeWeiboComposerDraft(draft, draft?.ownerUserId);
  const available = Math.max(0, WEIBO_COMPOSER_MAX_MEDIA - normalized.media.length);
  const additions = (Array.isArray(items) ? items : [items])
    .map(normalizeMediaItem)
    .filter(Boolean)
    .slice(0, available);
  return { ...normalized, media: [...normalized.media, ...additions], updatedAt: Date.now() };
}

export function removeWeiboComposerMedia(draft, mediaId = '') {
  const normalized = normalizeWeiboComposerDraft(draft, draft?.ownerUserId);
  return {
    ...normalized,
    media: normalized.media.filter((item) => item.id !== mediaId),
    updatedAt: Date.now(),
  };
}

export function moveWeiboComposerMedia(draft, mediaId = '', offset = 0) {
  const normalized = normalizeWeiboComposerDraft(draft, draft?.ownerUserId);
  const from = normalized.media.findIndex((item) => item.id === mediaId);
  const to = Math.max(0, Math.min(normalized.media.length - 1, from + Number(offset || 0)));
  if (from < 0 || from === to) return normalized;
  const media = [...normalized.media];
  const [item] = media.splice(from, 1);
  media.splice(to, 0, item);
  return { ...normalized, media, updatedAt: Date.now() };
}

export function hasWeiboComposerDraftContent(draft = {}) {
  return !!String(draft.text || '').trim()
    || !!String(draft.textImage || '').trim()
    || !!String(draft.topic || '').trim()
    || (Array.isArray(draft.media) && draft.media.length > 0)
    || !!draft.generatedCandidate?.url;
}
