let deferredPrompt = null;

function readStandaloneFlag() {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator || {};
  let standalone = false;
  try {
    standalone = window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches
      || window.matchMedia('(display-mode: minimal-ui)').matches;
  } catch (_) {}
  if (nav.standalone === true) standalone = true;
  return standalone;
}

export function isStandalonePwa() {
  return readStandaloneFlag();
}

export function initPwaInstall() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.dispatchEvent(new CustomEvent('marshmallow-pwa-installable'));
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    window.dispatchEvent(new CustomEvent('marshmallow-pwa-installed'));
  });
}

export function canPromptPwaInstall() {
  return !!deferredPrompt;
}

export function getPwaInstallStatus() {
  if (isStandalonePwa()) {
    return {
      state: 'installed',
      title: '已独立运行',
      detail: '当前以全屏/独立窗口模式打开，已隐藏浏览器地址栏。',
    };
  }
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      state: 'blocked',
      title: '需 HTTPS 或 localhost',
      detail: 'Edge 仅在 HTTPS 或 localhost 下允许安装 PWA。局域网 IP（如 192.168.x.x）无法安装；请部署到 HTTPS，或在本机用 localhost 访问后再安装。',
    };
  }
  if (deferredPrompt) {
    return {
      state: 'ready',
      title: '可安装全屏应用',
      detail: '点击下方按钮安装；安装后将从桌面/开始菜单以全屏独立窗口打开。',
    };
  }
  const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
  if (/Edg\//.test(ua)) {
    return {
      state: 'manual',
      title: 'Edge 手动安装',
      detail: '地址栏右侧「应用可用」→ 安装；或菜单 ⋯ → 应用 → 安装此站点。安装后从开始菜单打开即为全屏独立窗口。',
    };
  }
  return {
    state: 'manual',
    title: '手动添加到主屏幕',
    detail: 'iOS：Safari 分享 → 添加到主屏幕。Android Chrome：菜单 → 安装应用或添加到主屏幕。',
  };
}

export async function promptPwaInstall() {
  if (!deferredPrompt) return { ok: false, reason: 'no-prompt' };
  try {
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    const accepted = choice?.outcome === 'accepted';
    deferredPrompt = null;
    return { ok: accepted, outcome: choice?.outcome || 'dismissed' };
  } catch (err) {
    deferredPrompt = null;
    return { ok: false, reason: String(err?.message || err || 'prompt-failed') };
  }
}
