/** 路由纯函数 · 供 smoke 测试与复用 */

export function parseHashRoute(hashValue = '') {
  const raw = String(hashValue || '').replace(/^#/, '');
  if (!raw) return { path: 'home', params: {} };
  const [pathPart, query = ''] = raw.split('?');
  const path = String(pathPart || 'home').trim() || 'home';
  const params = {};
  if (query) {
    try {
      const sp = new URLSearchParams(query);
      for (const [key, value] of sp.entries()) params[key] = value;
    } catch (_) {}
  }
  return { path, params };
}
