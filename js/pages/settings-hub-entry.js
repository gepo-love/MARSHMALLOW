import { renderSettingsRouteSkeleton, yieldSettingsRoutePaint } from './settings-route-entry.js';

export default async function render(container, params = {}) {
  renderSettingsRouteSkeleton(container, {
    title: '设置',
    pageClass: 'settings-hub-page',
  });
  await yieldSettingsRoutePaint();
  const page = await import('./settings-hub.js');
  if (!container.isConnected) return;
  await page.default(container, params);
}
