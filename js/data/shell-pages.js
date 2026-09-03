/** 阶段 1 占位页配置：标题 + 空状态（不写教程长文） */

export const SHELL_PAGES = {
  encounter: {
    title: '相遇',
    emoji: '🤝',
    empty: '相遇模式即将上线',
  },
  'his-space': {
    title: '他的空间',
    emoji: '🏠',
    empty: '角色空间即将上线',
  },
};

export const SHELL_ROUTE_IDS = Object.keys(SHELL_PAGES);

export function getShellPageConfig(path) {
  return SHELL_PAGES[path] || null;
}
