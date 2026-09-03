import { navigate } from '../router.js';
import { TUTORIAL_NAV } from '../../data/tutorial-sections.js';

export const SUPPORT_ACTIONS = Object.freeze({
  'open-support-api': {
    label: '配置答疑 API',
    route: 'settings/api',
    params: { tab: 'support', focus: 'support.baseUrl' },
  },
  'open-main-api': {
    label: '打开聊天模型设置',
    route: 'settings/api',
    params: { tab: 'llm', focus: 'main.baseUrl' },
  },
  'open-search-api': {
    label: '打开搜索 API',
    route: 'settings/api',
    params: { tab: 'search' },
  },
  'open-voice-api': {
    label: '打开语音 API',
    route: 'settings/api',
    params: { tab: 'voice' },
  },
  'open-image-api': {
    label: '打开生图 API',
    route: 'settings/api',
    params: { tab: 'image' },
  },
  'open-chat': {
    label: '打开聊天列表',
    route: 'chat',
    params: {},
  },
  'open-calendar': {
    label: '打开日程与时间',
    route: 'calendar',
    params: {},
  },
  'open-contacts': {
    label: '打开通讯录',
    route: 'contacts',
    params: {},
  },
  'open-chat-beautify': {
    label: '打开聊天美化工作室',
    route: 'beautify',
    params: { target: 'chat-thread' },
  },
  'focus-main-key': {
    label: '检查聊天 API 密钥',
    route: 'settings/api',
    params: { tab: 'llm', focus: 'main.apiKey' },
  },
  'focus-main-model': {
    label: '检查聊天模型名',
    route: 'settings/api',
    params: { tab: 'llm', focus: 'main.model' },
  },
  'focus-single-user': {
    label: '打开兼容模式',
    route: 'settings/api',
    params: { tab: 'llm', focus: 'main.singleUserCompat' },
  },
  'focus-stream-mode': {
    label: '检查输出方式',
    route: 'settings/api',
    params: { tab: 'llm', focus: 'main.preferStream' },
  },
  'open-debug-log': {
    label: '打开错误日志',
    route: 'settings/debug-log',
    params: {},
  },
  'open-cache-recovery': {
    label: '修复启动缓存',
    href: 'recovery.html',
  },
  'open-keepalive': {
    label: '查看后台活跃',
    route: 'settings',
    params: { focus: 'background.keepalive' },
  },
  'open-api-tutorial': {
    label: '查看 API 教程',
    route: 'tutorial',
    params: { section: 'api' },
  },
  ...Object.fromEntries(TUTORIAL_NAV.map((section) => [
    `open-tutorial-${section.id}`,
    {
      label: `打开${section.label}教程`,
      route: 'tutorial',
      params: { section: section.id },
    },
  ])),
});

export function getSupportAction(actionId = '') {
  return SUPPORT_ACTIONS[String(actionId || '').trim()] || null;
}

export function normalizeSupportActionIds(actionIds = []) {
  return [...new Set((Array.isArray(actionIds) ? actionIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => !!SUPPORT_ACTIONS[id]))].slice(0, 4);
}

export function runSupportAction(actionId = '') {
  const action = getSupportAction(actionId);
  if (!action) return false;
  if (action.href === 'recovery.html') {
    location.assign('recovery.html');
    return true;
  }
  navigate(action.route, action.params || {});
  return true;
}
