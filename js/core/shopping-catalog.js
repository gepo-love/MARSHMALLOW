import { get, put } from './db.js';
import { getShoppingProvider } from './shopping-orders.js';

export const SHOPPING_CATALOGS_KEY = 'shoppingCatalogSnapshotsV1';
export const SHOPPING_CARTS_KEY = 'shoppingCartsV1';
export const SHOPPING_REVIEWS_KEY = 'shoppingOrderReviewsV1';
export const SHOPPING_CUSTOM_ITEMS_KEY = 'shoppingCustomItemsV1';
export const SHOPPING_PENDING_SHARES_KEY = 'shoppingPendingSharesV1';

function clean(value = '', max = 180) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanImage(value = '') {
  const source = String(value || '').trim();
  if (/^assets\/icons\/shopping\/meituan\/[a-z0-9-]+\.webp$/i.test(source)) return source;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString().slice(0, 3000) : '';
  } catch (_) {
    return '';
  }
}

function normalizeItem(value = {}, index = 0, source = 'official') {
  const name = clean(value.name || value.title || value.productName, 120);
  if (!name) return null;
  const normalizedSource = source === 'official' ? 'official' : source === 'ai' ? 'ai' : 'virtual';
  return Object.freeze({
    id: clean(value.id || value.productId || value.skuId, 100) || `item-${index}-${name}`,
    name,
    category: clean(value.category || value.categoryName || value.groupName, 60),
    spec: clean(value.spec || value.specification || value.variant, 160),
    price: clean(value.price || value.salePrice || value.amount, 40),
    imageUrl: cleanImage(value.imageUrl || value.pictureUrl || value.picUrl),
    imageEmoji: clean(value.imageEmoji || value.emoji, 8),
    storeName: clean(value.storeName || value.merchantName || value.shopName, 120),
    quantity: Math.max(1, Math.min(99, Math.round(Number(value.quantity) || 1))),
    source: normalizedSource,
  });
}

function catalogItemKey(item = {}) {
  const id = clean(item.id, 100);
  if (id) return `id:${id}`;
  return `name:${clean(item.name, 120).toLocaleLowerCase()}|${clean(item.spec, 160).toLocaleLowerCase()}`;
}

async function loadSetting(key) {
  const row = await get('settings', key).catch(() => null);
  return row?.value && typeof row.value === 'object' ? { ...row.value } : {};
}

async function saveSetting(key, value) {
  await put('settings', { key, value });
  return value;
}

function catalogKey(providerId = '', storeId = '') {
  return `${clean(providerId, 40)}::${clean(storeId, 120) || 'default'}`;
}

function localDateKey(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftedDateKey(now, boundaryMinutes = 300) {
  const value = new Date(now);
  const minutes = value.getHours() * 60 + value.getMinutes();
  if (minutes < boundaryMinutes) value.setDate(value.getDate() - 1);
  return localDateKey(value);
}

function nextBoundary(now, targetMinutes) {
  const value = new Date(now);
  value.setHours(Math.floor(targetMinutes / 60), targetMinutes % 60, 0, 0);
  if (value.getTime() <= now.getTime()) value.setDate(value.getDate() + 1);
  return value.getTime();
}

function parseBusinessHours(value = '') {
  const match = clean(value, 100).match(/(?:^|\s)([01]?\d|2[0-3]):([0-5]\d)\s*[-–—~至]\s*([01]?\d|2[0-3]):([0-5]\d)/);
  if (!match) return null;
  return {
    start: Number(match[1]) * 60 + Number(match[2]),
    end: Number(match[3]) * 60 + Number(match[4]),
  };
}

function isInsideBusinessHours(minutes, hours) {
  if (!hours || hours.start === hours.end) return true;
  return hours.end > hours.start
    ? minutes >= hours.start && minutes < hours.end
    : minutes >= hours.start || minutes < hours.end;
}

export function getShoppingCatalogPeriod(providerId = '', context = {}, nowValue = Date.now()) {
  const now = new Date(Number(nowValue) || Date.now());
  const minutes = now.getHours() * 60 + now.getMinutes();
  const hours = parseBusinessHours(context?.defaultStore?.businessHours || context?.businessHours || '');
  if (providerId === 'mcd-cn') {
    if (minutes >= 300 && minutes < 630) {
      return Object.freeze({
        key: `${localDateKey(now)}:breakfast`,
        label: '早餐时段',
        expiresAt: nextBoundary(now, 630),
        openNow: isInsideBusinessHours(minutes, hours),
      });
    }
    return Object.freeze({
      key: `${shiftedDateKey(now, 300)}:regular`,
      label: '正餐时段',
      expiresAt: nextBoundary(now, 300),
      openNow: isInsideBusinessHours(minutes, hours),
    });
  }
  const openingBoundary = hours?.start ?? 300;
  return Object.freeze({
    key: `${shiftedDateKey(now, openingBoundary)}:business-day`,
    label: '本营业日',
    expiresAt: nextBoundary(now, openingBoundary),
    openNow: isInsideBusinessHours(minutes, hours),
  });
}

export function isShoppingCatalogFresh(snapshot, context = {}, nowValue = Date.now()) {
  if (!snapshot?.items?.length || !snapshot.periodKey) return false;
  const expectedStoreId = clean(context?.defaultStore?.id, 120);
  if (expectedStoreId && clean(snapshot.storeId, 120) !== expectedStoreId) return false;
  const period = getShoppingCatalogPeriod(snapshot.providerId, context, nowValue);
  return snapshot.periodKey === period.key
    && Number(snapshot.expiresAt || 0) > Number(nowValue)
    && period.openNow !== false;
}

export async function saveShoppingCatalogSnapshot(providerId = '', items = [], context = {}) {
  const provider = getShoppingProvider(providerId);
  if (!provider) throw new TypeError('不支持的购物平台');
  const category = clean(context.category, 60);
  const normalizedItems = (Array.isArray(items) ? items : []).slice(0, 100)
    .map((item, index) => normalizeItem(category ? { ...item, category } : item, index, 'official')).filter(Boolean);
  if (!normalizedItems.length) return null;
  const storeId = clean(context.storeId || context.defaultStore?.id, 120);
  const period = getShoppingCatalogPeriod(provider.id, context);
  const all = await loadSetting(SHOPPING_CATALOGS_KEY);
  let snapshotItems = normalizedItems;
  if (context.merge === true) {
    const previous = all[catalogKey(provider.id, storeId)];
    const previousItems = previous?.periodKey === period.key && Array.isArray(previous.items)
      ? previous.items.map((item, index) => normalizeItem(item, index, 'official')).filter(Boolean)
      : [];
    const retainedItems = category
      ? previousItems.filter((item) => item.category !== category)
      : previousItems;
    const seen = new Set();
    snapshotItems = [...normalizedItems, ...retainedItems].filter((item) => {
      const key = catalogItemKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 100);
  }
  const snapshot = Object.freeze({
    providerId: provider.id,
    storeId,
    storeName: clean(context.storeName || context.defaultStore?.name, 120),
    items: Object.freeze(snapshotItems),
    source: 'official',
    fetchedAt: Date.now(),
    periodKey: period.key,
    periodLabel: period.label,
    expiresAt: period.expiresAt,
  });
  all[catalogKey(provider.id, storeId)] = snapshot;
  all[`${provider.id}::latest`] = snapshot;
  await saveSetting(SHOPPING_CATALOGS_KEY, all);
  return snapshot;
}

export async function getShoppingCatalogSnapshot(providerId = '', storeId = '') {
  const provider = getShoppingProvider(providerId);
  if (!provider) return null;
  const all = await loadSetting(SHOPPING_CATALOGS_KEY);
  const requestedStoreId = clean(storeId, 120);
  const raw = all[catalogKey(provider.id, requestedStoreId)]
    || (!requestedStoreId ? all[`${provider.id}::latest`] : null);
  if (!raw || !Array.isArray(raw.items)) return null;
  return Object.freeze({
    providerId: provider.id,
    storeId: clean(raw.storeId, 120),
    storeName: clean(raw.storeName, 120),
    source: 'official',
    fetchedAt: Math.max(0, Number(raw.fetchedAt || 0) || 0),
    periodKey: clean(raw.periodKey, 100),
    periodLabel: clean(raw.periodLabel, 40),
    expiresAt: Math.max(0, Number(raw.expiresAt || 0) || 0),
    items: Object.freeze(raw.items.map((item, index) => normalizeItem(item, index, 'official')).filter(Boolean)),
  });
}

export function shoppingCatalogPrompt(snapshot = {}, context = {}) {
  if (!snapshot?.items?.length) return '';
  const fetched = snapshot.fetchedAt
    ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(snapshot.fetchedAt))
    : '';
  const items = snapshot.items.slice(0, 36).map((item) => (
    `- ${item.name}${item.spec ? `（${item.spec}）` : ''}${item.price ? `：¥${item.price}` : ''}`
  ));
  return [
    '[本地菜单快照]',
    `${snapshot.storeName || context?.defaultStore?.name || '当前门店'} · ${snapshot.periodLabel || '当前时段'}${fetched ? ` · ${fetched} 刷新` : ''}`,
    ...items,
    '这是用户手动刷新后保存在本机的菜单摘要，只用于本轮选餐；若用户要求最新库存、优惠或正式下单，必须重新调用官方工具校验。',
  ].join('\n');
}

export async function getShoppingCart(providerId = '') {
  const provider = getShoppingProvider(providerId);
  if (!provider) return Object.freeze({ providerId: '', items: Object.freeze([]), updatedAt: 0 });
  const all = await loadSetting(SHOPPING_CARTS_KEY);
  const raw = all[provider.id] || {};
  return Object.freeze({
    providerId: provider.id,
    items: Object.freeze((Array.isArray(raw.items) ? raw.items : []).map((item, index) => normalizeItem(item, index, item.source)).filter(Boolean)),
    updatedAt: Math.max(0, Number(raw.updatedAt || 0) || 0),
  });
}

async function saveCart(providerId = '', items = []) {
  const provider = getShoppingProvider(providerId);
  if (!provider) throw new TypeError('不支持的购物平台');
  const all = await loadSetting(SHOPPING_CARTS_KEY);
  all[provider.id] = {
    providerId: provider.id,
    items: items.slice(0, 50).map((item, index) => normalizeItem(item, index, item.source)).filter(Boolean),
    updatedAt: Date.now(),
  };
  await saveSetting(SHOPPING_CARTS_KEY, all);
  return getShoppingCart(provider.id);
}

export async function addShoppingCartItem(providerId = '', item = {}) {
  const cart = await getShoppingCart(providerId);
  const next = [...cart.items];
  const normalized = normalizeItem(item, next.length, item.source);
  if (!normalized) throw new Error('商品信息不完整');
  const existing = next.findIndex((row) => row.id === normalized.id && row.spec === normalized.spec);
  if (existing >= 0) next[existing] = { ...next[existing], quantity: Math.min(99, next[existing].quantity + 1) };
  else next.push(normalized);
  return saveCart(providerId, next);
}

export async function updateShoppingCartItem(providerId = '', itemId = '', quantity = 1) {
  const cart = await getShoppingCart(providerId);
  const id = clean(itemId, 100);
  const count = Math.max(0, Math.min(99, Math.round(Number(quantity) || 0)));
  const next = count > 0
    ? cart.items.map((item) => item.id === id ? { ...item, quantity: count } : item)
    : cart.items.filter((item) => item.id !== id);
  return saveCart(providerId, next);
}

export async function clearShoppingCart(providerId = '') {
  return saveCart(providerId, []);
}

export async function listShoppingCustomItems(providerId = '') {
  const provider = getShoppingProvider(providerId);
  if (!provider) return Object.freeze([]);
  const all = await loadSetting(SHOPPING_CUSTOM_ITEMS_KEY);
  const rows = Array.isArray(all[provider.id]) ? all[provider.id] : [];
  return Object.freeze(rows.map((item, index) => normalizeItem(item, index, item?.source || 'virtual')).filter(Boolean));
}

export async function saveShoppingCustomItem(providerId = '', item = {}) {
  const provider = getShoppingProvider(providerId);
  if (!provider) throw new TypeError('不支持的购物平台');
  const all = await loadSetting(SHOPPING_CUSTOM_ITEMS_KEY);
  const rows = Array.isArray(all[provider.id]) ? [...all[provider.id]] : [];
  const id = clean(item.id, 100) || `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const normalized = normalizeItem({ ...item, id }, rows.length, item?.source === 'ai' ? 'ai' : 'virtual');
  if (!normalized) throw new Error('请填写商品或套餐名称');
  const index = rows.findIndex((row) => clean(row?.id, 100) === id);
  if (index >= 0) rows[index] = normalized;
  else rows.push(normalized);
  all[provider.id] = rows.slice(-80);
  await saveSetting(SHOPPING_CUSTOM_ITEMS_KEY, all);
  return normalized;
}

export async function deleteShoppingCustomItem(providerId = '', itemId = '') {
  const provider = getShoppingProvider(providerId);
  if (!provider) return false;
  const all = await loadSetting(SHOPPING_CUSTOM_ITEMS_KEY);
  const id = clean(itemId, 100);
  const rows = Array.isArray(all[provider.id]) ? all[provider.id] : [];
  const next = rows.filter((item) => clean(item?.id, 100) !== id);
  if (next.length === rows.length) return false;
  all[provider.id] = next;
  await saveSetting(SHOPPING_CUSTOM_ITEMS_KEY, all);
  return true;
}

function cartTotal(items = []) {
  const total = items.reduce((sum, item) => {
    const price = Number.parseFloat(String(item.price || '').replace(/[^\d.]/g, ''));
    return sum + (Number.isFinite(price) ? price * Math.max(1, Number(item.quantity) || 1) : 0);
  }, 0);
  return total > 0 ? total.toFixed(2).replace(/\.00$/, '') : '';
}

export async function createPendingShoppingShare(providerId = '') {
  const provider = getShoppingProvider(providerId);
  const cart = await getShoppingCart(providerId);
  if (!provider || !cart.items.length) throw new Error('购物车还是空的');
  const all = await loadSetting(SHOPPING_PENDING_SHARES_KEY);
  const id = `share_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  all[id] = {
    id,
    providerId: provider.id,
    providerLabel: provider.label,
    items: cart.items.slice(0, 50),
    amount: cartTotal(cart.items),
    createdAt: Date.now(),
  };
  const recent = Object.values(all)
    .filter((item) => Number(item?.createdAt || 0) > Date.now() - 24 * 60 * 60 * 1000)
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .slice(0, 12);
  await saveSetting(SHOPPING_PENDING_SHARES_KEY, Object.fromEntries(recent.map((item) => [item.id, item])));
  return Object.freeze({ ...all[id], items: Object.freeze(cart.items) });
}

export async function getPendingShoppingShare(shareId = '') {
  const all = await loadSetting(SHOPPING_PENDING_SHARES_KEY);
  const value = all[clean(shareId, 120)];
  if (!value || !Array.isArray(value.items)) return null;
  return Object.freeze({
    id: clean(value.id, 120),
    providerId: clean(value.providerId, 40),
    providerLabel: clean(value.providerLabel, 80),
    amount: clean(value.amount, 40),
    createdAt: Number(value.createdAt || 0),
    items: Object.freeze(value.items.map((item, index) => normalizeItem(item, index, item.source)).filter(Boolean)),
  });
}

export async function consumePendingShoppingShare(shareId = '') {
  const all = await loadSetting(SHOPPING_PENDING_SHARES_KEY);
  const id = clean(shareId, 120);
  if (!all[id]) return false;
  delete all[id];
  await saveSetting(SHOPPING_PENDING_SHARES_KEY, all);
  return true;
}

export async function getShoppingOrderReview(orderId = '') {
  const all = await loadSetting(SHOPPING_REVIEWS_KEY);
  const value = all[clean(orderId, 120)];
  if (!value) return null;
  return Object.freeze({ rating: Math.max(1, Math.min(5, Number(value.rating) || 5)), text: clean(value.text, 500), updatedAt: Number(value.updatedAt || 0) });
}

export async function saveShoppingOrderReview(orderId = '', review = {}) {
  const id = clean(orderId, 120);
  if (!id) throw new Error('订单不存在');
  const all = await loadSetting(SHOPPING_REVIEWS_KEY);
  all[id] = { rating: Math.max(1, Math.min(5, Number(review.rating) || 5)), text: clean(review.text, 500), updatedAt: Date.now() };
  await saveSetting(SHOPPING_REVIEWS_KEY, all);
  return getShoppingOrderReview(id);
}
