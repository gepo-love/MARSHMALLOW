export const TOGETHER_GROUP_APPS = Object.freeze([
  Object.freeze({
    id: 'reading',
    label: '一起读',
    route: 'together-reading',
    tone: 'forest',
    status: '测试中',
    icon: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 11c6-2 12-1 16 3 4-4 10-5 16-3v27c-6-2-12-1-16 3-4-4-10-5-16-3Z"/><path d="M24 14v27"/></svg>',
  }),
  Object.freeze({
    id: 'comic',
    label: '漫画',
    tone: 'brick',
    status: '未开放',
    icon: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="7" width="32" height="34" rx="4"/><path d="M13 13h22v10H13zM13 28h9v8h-9zM27 28h8v8h-8z"/></svg>',
  }),
  Object.freeze({
    id: 'movie',
    label: '电影',
    tone: 'navy',
    status: '未开放',
    icon: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="11" width="34" height="26" rx="5"/><path d="m21 18 11 6-11 6Z"/></svg>',
  }),
  Object.freeze({
    id: 'series',
    label: '追剧',
    tone: 'violet',
    status: '未开放',
    icon: '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="13" width="34" height="25" rx="5"/><path d="m18 7 6 6 6-6M16 32h16M24 18v9l7-4.5Z"/></svg>',
  }),
  Object.freeze({
    id: 'study',
    label: '共学',
    tone: 'blue',
    status: '未开放',
    icon: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="m6 17 18-9 18 9-18 9Z"/><path d="M12 21v11c7 6 17 6 24 0V21M42 18v13"/></svg>',
  }),
  Object.freeze({
    id: 'poetry',
    label: '读诗',
    tone: 'wine',
    status: '未开放',
    icon: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M35 7C24 9 15 17 12 31c8 2 17-2 23-10 3-4 4-9 4-14Z"/><path d="M10 40c7-13 15-20 25-27M20 31h14"/></svg>',
  }),
]);

export const HOME_APP_GROUP_IDS = Object.freeze(['watch-together', 'shopping']);

export function isHomeAppGroup(appId = '') {
  return HOME_APP_GROUP_IDS.includes(String(appId || '').trim());
}
