import { renderSettingsRouteSkeleton, yieldSettingsRoutePaint } from './settings-route-entry.js';

export default async function render(container, params = {}) {
  renderSettingsRouteSkeleton(container, {
    title: 'API 管理',
    pageClass: 'api-manager-page',
    scrollClass: 'api-manager-scroll scrapbook-scroll',
    tabStrip: true,
  });
  await yieldSettingsRoutePaint();
  const page = await import('./api-manager.js');
  if (!container.isConnected) return;
  await page.default(container, params);
}
