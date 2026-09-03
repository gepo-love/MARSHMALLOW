import { get, put } from './db.js';
import { getShoppingProvider } from './shopping-orders.js';

export const SHOPPING_CONTEXTS_KEY = 'shoppingContextsV1';

function clean(value = '', max = 180) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanHttpsUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString().slice(0, 3000);
  } catch (_) {
    return '';
  }
}

function normalizeStore(value = {}) {
  const id = clean(value.id || value.storeId || value.shopId || value.restaurantId, 120);
  const name = clean(value.name || value.storeName || value.shopName || value.restaurantName, 120);
  const address = clean(value.address || value.storeAddress || value.shopAddress, 220);
  if (!id && !name && !address) return null;
  return Object.freeze({
    id,
    name: name || '附近门店',
    address,
    distance: clean(value.distance || value.distanceText, 60),
    businessHours: clean(value.businessHours || value.openingHours || value.hours, 100),
    imageUrl: cleanHttpsUrl(value.imageUrl || value.pictureUrl || value.photoUrl),
  });
}

function normalizeContext(providerId = '', value = {}) {
  const provider = getShoppingProvider(providerId);
  if (!provider) return null;
  const nearbyStores = (Array.isArray(value.nearbyStores) ? value.nearbyStores : [])
    .slice(0, 20).map(normalizeStore).filter(Boolean);
  const requestedDefault = normalizeStore(value.defaultStore || {});
  const defaultStore = requestedDefault
    || nearbyStores.find((store) => store.id && store.id === clean(value.defaultStoreId, 120))
    || null;
  return Object.freeze({
    providerId: provider.id,
    address: clean(value.address, 220),
    defaultStore,
    nearbyStores: Object.freeze(nearbyStores),
    updatedAt: Math.max(0, Number(value.updatedAt || 0) || 0),
  });
}

async function loadAll() {
  const row = await get('settings', SHOPPING_CONTEXTS_KEY).catch(() => null);
  return row?.value && typeof row.value === 'object' ? { ...row.value } : {};
}

export async function getShoppingContext(providerId = '') {
  const all = await loadAll();
  return normalizeContext(providerId, {
    ...(all[providerId] || {}),
    address: clean(all.sharedAddress || all[providerId]?.address, 220),
  });
}

async function saveContext(providerId = '', patch = {}) {
  const all = await loadAll();
  const current = normalizeContext(providerId, all[providerId] || {});
  if (!current) throw new TypeError('不支持的购物平台');
  const next = normalizeContext(providerId, { ...current, ...patch, updatedAt: Date.now() });
  all[providerId] = next;
  await put('settings', { key: SHOPPING_CONTEXTS_KEY, value: all });
  return next;
}

export function normalizeShoppingStore(value = {}) {
  return normalizeStore(value);
}

export async function saveShoppingAddress(providerId = '', address = '') {
  const all = await loadAll();
  const normalizedAddress = clean(address, 220);
  const current = normalizeContext(providerId, {
    ...(all[providerId] || {}),
    address: normalizedAddress,
  });
  if (!current) throw new TypeError('不支持的购物平台');
  all.sharedAddress = normalizedAddress;
  all[providerId] = normalizeContext(providerId, { ...current, address: normalizedAddress, updatedAt: Date.now() });
  await put('settings', { key: SHOPPING_CONTEXTS_KEY, value: all });
  return all[providerId];
}

export async function getSharedShoppingAddress() {
  const all = await loadAll();
  return clean(all.sharedAddress || all['mcd-cn']?.address || all['luckin-cn']?.address, 220);
}

export async function saveSharedShoppingAddress(address = '') {
  const all = await loadAll();
  all.sharedAddress = clean(address, 220);
  await put('settings', { key: SHOPPING_CONTEXTS_KEY, value: all });
  return all.sharedAddress;
}

export async function saveShoppingStoreDiscovery(providerId = '', stores = []) {
  const nearbyStores = (Array.isArray(stores) ? stores : []).slice(0, 20).map(normalizeStore).filter(Boolean);
  const current = await getShoppingContext(providerId);
  const stillPresent = current?.defaultStore && nearbyStores.some((store) => (
    (store.id && store.id === current.defaultStore.id)
    || (!store.id && store.name === current.defaultStore.name && store.address === current.defaultStore.address)
  ));
  return saveContext(providerId, {
    nearbyStores,
    defaultStore: stillPresent ? current.defaultStore : (nearbyStores.length === 1 ? nearbyStores[0] : null),
  });
}

export async function setDefaultShoppingStore(providerId = '', storeId = '') {
  const current = await getShoppingContext(providerId);
  const id = clean(storeId, 120);
  const store = current?.nearbyStores.find((item) => item.id === id)
    || current?.nearbyStores.find((item) => item.name === id)
    || null;
  if (!store) throw new Error('门店不存在，请重新获取附近门店');
  return saveContext(providerId, { defaultStore: store });
}

export function shoppingContextPrompt(context = {}) {
  const lines = [];
  if (context.address) lines.push(`用户填写的点单地址：${context.address}`);
  if (context.defaultStore) {
    lines.push(`默认门店：${context.defaultStore.name}${context.defaultStore.id ? `（门店 ID：${context.defaultStore.id}）` : ''}`);
    if (context.defaultStore.address) lines.push(`默认门店地址：${context.defaultStore.address}`);
  }
  return lines.length ? ['[购物门店上下文]', ...lines, '仅在本轮餐饮查询中使用这些信息；需要更改时先询问用户。'].join('\n') : '';
}
