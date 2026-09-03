import { navigate } from '../core/router.js';

const TOKEN_RE = /(#[^#\n]{1,60}#)|@([\p{L}\p{N}_·.-]{1,30})/gu;

function decorate(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const raw = String(node.nodeValue || '');
    TOKEN_RE.lastIndex = 0;
    if (!TOKEN_RE.test(raw)) continue;
    TOKEN_RE.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of raw.matchAll(TOKEN_RE)) {
      if (match.index > cursor) fragment.append(document.createTextNode(raw.slice(cursor, match.index)));
      const link = document.createElement('span');
      link.className = 'weibo-rich-link';
      link.setAttribute('role', 'link');
      link.tabIndex = node.parentElement?.closest('button') ? -1 : 0;
      link.textContent = match[0];
      if (match[1]) link.dataset.weiboTopic = match[1].slice(1, -1).trim();
      else link.dataset.weiboAuthorName = match[2].trim();
      fragment.append(link);
      cursor = match.index + match[0].length;
    }
    if (cursor < raw.length) fragment.append(document.createTextNode(raw.slice(cursor)));
    node.replaceWith(fragment);
  }
}

export function bindWeiboRichTextLinks(container) {
  if (!container) return;
  container.querySelectorAll('.social-richtext:not([data-weibo-rich-ready])').forEach((root) => {
    root.dataset.weiboRichReady = '1';
    decorate(root);
  });
  if (container.dataset.weiboRichLinksBound === '1') return;
  container.dataset.weiboRichLinksBound = '1';
  const activate = (target, event) => {
    const link = target?.closest?.('.weibo-rich-link');
    if (!link || !container.contains(link)) return false;
    event.preventDefault();
    event.stopPropagation();
    if (link.dataset.weiboTopic) navigate('weibo-topic', { topic: link.dataset.weiboTopic });
    else if (link.dataset.weiboAuthorName) navigate('weibo-profile', { authorName: link.dataset.weiboAuthorName });
    return true;
  };
  container.addEventListener('click', (event) => activate(event.target, event));
  container.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') activate(event.target, event);
  });
}
