function decodeInternalId(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Resolve app-internal links carried by chat link messages.
 * Older backups may retain only the metadata id, so those fields are part of
 * the canonical resolution path rather than one-off compatibility branches.
 */
export function resolveChatInternalLink(msg = {}) {
  const metadata = msg?.metadata || {};
  const candidates = [metadata.url, metadata.href, metadata.link, msg?.content];
  for (let i = 0; i < candidates.length; i += 1) {
    const raw = String(candidates[i] || '').trim();
    const match = raw.match(/^(forum|weibo):\/\/(.+)$/i);
    if (!match) continue;
    const id = decodeInternalId(match[2]);
    if (!id) continue;
    const kind = match[1].toLowerCase();
    return kind === 'forum'
      ? { kind, id, url: `forum://${id}`, path: 'forum-detail', params: { threadId: id } }
      : { kind, id, url: `weibo://${id}`, path: 'weibo-detail', params: { postId: id } };
  }

  const forumThreadId = decodeInternalId(metadata.forumThreadId);
  if (forumThreadId) {
    return {
      kind: 'forum',
      id: forumThreadId,
      url: `forum://${forumThreadId}`,
      path: 'forum-detail',
      params: { threadId: forumThreadId },
    };
  }

  const weiboPostId = decodeInternalId(metadata.weiboPostId);
  if (weiboPostId) {
    return {
      kind: 'weibo',
      id: weiboPostId,
      url: `weibo://${weiboPostId}`,
      path: 'weibo-detail',
      params: { postId: weiboPostId },
    };
  }
  return null;
}
