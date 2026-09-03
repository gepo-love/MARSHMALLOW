import { renderSettingsRouteSkeleton, yieldSettingsRoutePaint } from './settings-route-entry.js';

export default async function render(container, params = {}) {
  renderSettingsRouteSkeleton(container, {
    title: '存储与数据',
    pageClass: 'settings-debug-page',
  });
  await yieldSettingsRoutePaint();
  const page = await import('./settings-data-hygiene.js');
  if (!container.isConnected) return;
  await page.default(container, params);
}
