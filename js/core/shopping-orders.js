import { get, put } from './db.js';

export const SHOPPING_ORDERS_KEY = 'shoppingOrdersV1';
export const SHOPPING_CHECKOUT_LINKS_KEY = 'shoppingCheckoutLinksV1';

const PROVIDERS = Object.freeze({
  'mcd-cn': Object.freeze({ id: 'mcd-cn', label: '麦当劳', route: 'shopping/mcd' }),
  'luckin-cn': Object.freeze({ id: 'luckin-cn', label: '瑞幸咖啡', route: 'shopping/luckin' }),
  'meituan-cn': Object.freeze({ id: 'meituan-cn', label: '美团', route: 'shopping/meituan' }),
});

function clean(value = '', max = 160) {
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

function normalizeItems(value = []) {
  return Object.freeze((Array.isArray(value) ? value : []).slice(0, 50).map((item) => Object.freeze({
    id: clean(item?.id, 100),
    name: clean(item?.name, 120) || '商品',
    quantity: Math.max(1, Math.min(99, Math.round(Number(item?.quantity) || 1))),
    spec: clean(item?.spec, 160),
    price: clean(item?.price, 40),
    imageUrl: cleanHttpsUrl(item?.imageUrl),
  })));
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return `order_${globalThis.crypto.randomUUID()}`;
  return `order_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeOrder(value = {}) {
  const provider = PROVIDERS[clean(value.providerId, 40)];
  if (!provider) throw new TypeError('不支持的购物平台');
  const now = Date.now();
  return Object.freeze({
    id: clean(value.id, 100) || makeId(),
    providerId: provider.id,
    providerLabel: provider.label,
    externalOrderId: clean(value.externalOrderId || value.orderId, 100),
    title: clean(value.title, 100) || `${provider.label}订单`,
    amount: clean(value.amount, 40),
    note: clean(value.note, 160),
    // 早期测试版只有带支付链接的订单才能落库；缺少该字段的旧订单按可支付迁移。
    checkoutAvailable: value.checkoutAvailable !== false,
    imageUrl: cleanHttpsUrl(value.imageUrl),
    storeName: clean(value.storeName, 120),
    storeAddress: clean(value.storeAddress, 180),
    fulfillment: clean(value.fulfillment, 80),
    items: normalizeItems(value.items),
    status: ['pending_payment', 'paid', 'cancelled', 'expired', 'completed'].includes(value.status)
      ? value.status
      : 'pending_payment',
    statusText: clean(value.statusText, 120),
    statusCheckedAt: Math.max(0, Number(value.statusCheckedAt || 0) || 0),
    chatId: clean(value.chatId, 100),
    actorId: clean(value.actorId, 100),
    actorName: clean(value.actorName, 80),
    createdAt: Math.max(0, Number(value.createdAt || 0) || now),
    updatedAt: Math.max(0, Number(value.updatedAt || 0) || now),
  });
}

async function loadRows() {
  const row = await get('settings', SHOPPING_ORDERS_KEY).catch(() => null);
  return (Array.isArray(row?.value) ? row.value : [])
    .map((item) => {
      try { return normalizeOrder(item); } catch (_) { return null; }
    })
    .filter(Boolean);
}

async function loadCheckoutLinks() {
  const row = await get('settings', SHOPPING_CHECKOUT_LINKS_KEY).catch(() => null);
  return row?.value && typeof row.value === 'object' ? { ...row.value } : {};
}

export function getShoppingProvider(value = '') {
  return PROVIDERS[clean(value, 40)] || null;
}

export function listShoppingProviders() {
  return Object.values(PROVIDERS);
}

export async function listShoppingOrders(options = {}) {
  const providerId = clean(options.providerId, 40);
  const rows = await loadRows();
  return rows
    .filter((item) => !providerId || item.providerId === providerId)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function getShoppingOrder(orderId = '') {
  const id = clean(orderId, 100);
  if (!id) return null;
  const rows = await loadRows();
  return rows.find((item) => item.id === id) || null;
}

export async function getShoppingCheckoutUrl(orderId = '') {
  const links = await loadCheckoutLinks();
  const row = links[clean(orderId, 100)];
  return typeof row === 'string' ? row : clean(row?.url, 4000);
}

export async function saveShoppingCheckout(checkout = {}, context = {}) {
  const providerId = clean(checkout.templateId || checkout.providerId, 40);
  const provider = getShoppingProvider(providerId);
  if (!provider) return null;
  const rows = await loadRows();
  const duplicate = rows.find((item) => (
    item.providerId === providerId
    && checkout.orderId
    && item.externalOrderId === clean(checkout.orderId, 100)
  ));
  const next = normalizeOrder({
    ...duplicate,
    id: duplicate?.id,
    providerId,
    externalOrderId: checkout.orderId,
    title: checkout.title,
    amount: checkout.amount,
    note: checkout.note,
    checkoutAvailable: !!checkout.checkoutUrl,
    imageUrl: checkout.imageUrl,
    storeName: checkout.storeName,
    storeAddress: checkout.storeAddress,
    fulfillment: checkout.fulfillment,
    items: checkout.items,
    status: duplicate?.status || 'pending_payment',
    statusText: duplicate?.statusText,
    statusCheckedAt: duplicate?.statusCheckedAt,
    chatId: context.chatId,
    actorId: context.actorId,
    actorName: context.actorName,
    createdAt: duplicate?.createdAt,
    updatedAt: Date.now(),
  });
  const index = rows.findIndex((item) => item.id === next.id);
  if (index >= 0) rows[index] = next;
  else rows.unshift(next);
  await put('settings', { key: SHOPPING_ORDERS_KEY, value: rows.slice(0, 300) });

  const links = await loadCheckoutLinks();
  if (checkout.checkoutUrl) links[next.id] = { url: String(checkout.checkoutUrl), savedAt: Date.now() };
  const liveIds = new Set(rows.slice(0, 300).map((item) => item.id));
  Object.keys(links).forEach((id) => { if (!liveIds.has(id)) delete links[id]; });
  await put('settings', { key: SHOPPING_CHECKOUT_LINKS_KEY, value: links });
  return next;
}

async function updateStatusAt(rows, index, status, details = {}) {
  const allowed = new Set(['pending_payment', 'paid', 'cancelled', 'expired', 'completed']);
  if (!allowed.has(status)) return rows[index];
  const current = rows[index].status;
  const terminal = new Set(['cancelled', 'expired', 'completed']);
  const regresses = terminal.has(current)
    ? status !== current
    : current === 'paid' && status === 'pending_payment';
  const nextStatus = regresses ? current : status;
  const now = Date.now();
  rows[index] = normalizeOrder({
    ...rows[index],
    status: nextStatus,
    statusText: regresses ? rows[index].statusText : clean(details.statusText, 120) || rows[index].statusText,
    statusCheckedAt: Math.max(0, Number(details.checkedAt || 0) || now),
    updatedAt: nextStatus === current ? rows[index].updatedAt : now,
  });
  await put('settings', { key: SHOPPING_ORDERS_KEY, value: rows });
  return rows[index];
}

export async function updateShoppingOrderStatus(orderId = '', status = '', details = {}) {
  const rows = await loadRows();
  const index = rows.findIndex((item) => item.id === clean(orderId, 100));
  if (index < 0) return null;
  return updateStatusAt(rows, index, status, details);
}

export async function updateShoppingOrderStatusByExternalId(providerId = '', externalOrderId = '', status = '', details = {}) {
  const provider = getShoppingProvider(providerId);
  const externalId = clean(externalOrderId, 100);
  if (!provider || !externalId) return null;
  const rows = await loadRows();
  const index = rows.findIndex((item) => item.providerId === provider.id && item.externalOrderId === externalId);
  if (index < 0) return null;
  return updateStatusAt(rows, index, status, details);
}
