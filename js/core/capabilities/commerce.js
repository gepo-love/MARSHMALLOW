import { CAPABILITY_RISKS } from './schema.js';

const COMMERCE_TEMPLATE_IDS = new Set(['mcd-cn', 'luckin-cn']);
const COMMERCE_INTENT_RE = /麦当劳|麦麦|瑞幸|咖啡|早餐|午餐|晚餐|夜宵|菜单|新品|活动|优惠|券|门店|外送|自取|点单|下单|订单|支付|付款|取餐码|买|来一|来两|吃|喝/i;
const CONCRETE_ORDER_RE = /确认下单|提交订单|就要这个|就这些|按这个|买这个|点这个|来[一二两三四五六七八九十\d]+(?:份|个|杯|套)|(?:一|二|两|三|四|五|六|七|八|九|十|\d+)(?:份|个|杯|套)/i;
const ORDER_STATUS_INTENT_RE = /订单.{0,8}(?:状态|进度|支付|付款|完成|取消|配送|取餐)|(?:查|刷新|更新|同步).{0,8}订单|(?:已经|已|刚刚)?(?:支付|付款)(?:了|成功|完成)?|取餐码/i;
const COMMERCE_CACHE_REFRESH_RE = /刷新|更新|最新|实时|库存|有货|售罄|优惠|活动|新品|下单|结算|支付|确认订单|附近|门店|地址|配送|外送|自取/i;

function clean(value = '', max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function messageText(message = {}) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => String(part?.text || part?.content || '')).join('\n');
}

function latestUserText(messages = []) {
  const message = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((item) => item?.role === 'user');
  return messageText(message).slice(-1600);
}

function intendedTemplateId(messages = [], priorSteps = []) {
  const recent = [...(Array.isArray(messages) ? messages : [])].reverse();
  for (const message of recent) {
    const text = messageText(message);
    if (/麦当劳|麦麦|麦门|汉堡/i.test(text)) return 'mcd-cn';
    if (/瑞幸|咖啡/i.test(text)) return 'luckin-cn';
  }
  const prior = [...(Array.isArray(priorSteps) ? priorSteps : [])].reverse()
    .find((step) => isOfficialCommerceCapability(step?.capability));
  return String(prior?.capability?.source?.serviceTemplateId || '');
}

export function commerceProviderIdForMessages(messages = [], priorSteps = []) {
  return intendedTemplateId(messages, priorSteps);
}

export function shouldInjectCommerceCatalog(messages = [], providerId = '') {
  const text = latestUserText(messages);
  if (providerId === 'mcd-cn') return /麦当劳|麦麦|麦门|汉堡/i.test(text);
  if (providerId === 'luckin-cn') return /瑞幸|咖啡/i.test(text);
  return false;
}

export function shouldRefreshCommerceCatalog(messages = []) {
  return COMMERCE_CACHE_REFRESH_RE.test(latestUserText(messages));
}

export function isOfficialCommerceCapability(capability = {}) {
  return capability.source?.type === 'mcp'
    && COMMERCE_TEMPLATE_IDS.has(String(capability.source?.serviceTemplateId || ''));
}

export function approveUserInitiatedCommerceRead(request = {}) {
  const capability = request?.capability || {};
  const approved = capability.risk === CAPABILITY_RISKS.READ
    && isOfficialCommerceCapability(capability);
  return Object.freeze({
    approved,
    reason: approved ? 'user_initiated_commerce_read' : 'explicit_approval_required',
  });
}

export function commerceCapabilityKind(capability = {}) {
  const blob = `${capability.source?.toolName || ''} ${capability.name || ''} ${capability.description || ''}`;
  const identity = `${capability.source?.toolName || ''} ${capability.name || ''}`;
  if (capability.risk === CAPABILITY_RISKS.TRANSACTION
    || /create.?order|submit.?order|checkout|purchase|redeem|exchange|下单|创建订单|提交订单|兑换/i.test(blob)) return 'checkout';
  if (/query.*order|order.*(?:detail|status|history|list)|get.*order|查询订单|订单(?:详情|状态|进度|列表)/i.test(identity)) return 'order';
  if (/address|location|nearby|store|shop|city|delivery|pickup|门店|地址|定位|附近|配送|自取/i.test(blob)) return 'location';
  if (/coupon|promotion|campaign|activity|benefit|deal|discount|优惠|活动|券|折扣|权益/i.test(blob)) return 'promotion';
  if (/menu|product|food|item|nutrition|category|sku|餐品|商品|菜单|营养|新品|规格/i.test(blob)) return 'catalog';
  if (/order|订单/i.test(blob)) return 'order';
  return 'support';
}

function relevanceScore(capability, intent = '') {
  const kind = commerceCapabilityKind(capability);
  let score = { location: 50, promotion: 42, catalog: 40, support: 20, order: 16, checkout: 0 }[kind] || 0;
  const blob = `${capability.name || ''} ${capability.description || ''}`;
  const words = clean(intent, 1000).match(/[\u3400-\u9fff]{2,6}|[a-z][a-z0-9_-]{2,}/gi) || [];
  score += words.slice(0, 20).filter((word) => blob.toLowerCase().includes(word.toLowerCase())).length * 8;
  return score;
}

export function selectCommerceCapabilitiesForRound(capabilities = [], options = {}) {
  const all = Array.isArray(capabilities) ? capabilities : [];
  const priorSteps = Array.isArray(options.priorSteps) ? options.priorSteps : [];
  const templateId = intendedTemplateId(options.messages, priorSteps);
  const commerce = all.filter((capability) => isOfficialCommerceCapability(capability)
    && (!templateId || capability.source?.serviceTemplateId === templateId));
  if (!commerce.length) return all;
  const intent = latestUserText(options.messages);
  if (!COMMERCE_INTENT_RE.test(intent)) return all;

  const completedKinds = new Set(priorSteps
    .filter((step) => step?.result?.ok !== false)
    .map((step) => commerceCapabilityKind(step.capability || {})));
  const hasKnownStore = completedKinds.has('location') || (Array.isArray(options.messages) && options.messages.some((message) => (
    /\[购物门店上下文\][\s\S]*默认门店/.test(messageText(message))
  )));
  const allowCheckout = CONCRETE_ORDER_RE.test(intent)
    && (completedKinds.has('catalog') || /确认下单|提交订单|就这些|按这个/i.test(intent));
  let allowedKinds;
  if (ORDER_STATUS_INTENT_RE.test(intent)) {
    allowedKinds = new Set(['order', 'support']);
  } else if (allowCheckout) {
    allowedKinds = new Set(['checkout', 'order', 'support']);
  } else if (!hasKnownStore && commerce.some((capability) => commerceCapabilityKind(capability) === 'location')) {
    allowedKinds = new Set(['location']);
  } else {
    allowedKinds = new Set(['promotion', 'catalog', 'support']);
    if (completedKinds.has('catalog')) allowedKinds.add('order');
  }

  return commerce
    .filter((capability) => allowedKinds.has(commerceCapabilityKind(capability)))
    .sort((left, right) => relevanceScore(right, intent) - relevanceScore(left, intent))
    .slice(0, 14);
}

export function commercePlannerInstructions(capabilities = [], messages = []) {
  if (!(Array.isArray(capabilities) && capabilities.some(isOfficialCommerceCapability))) return [];
  if (!COMMERCE_INTENT_RE.test(latestUserText(messages))) return [];
  return [
    '当前是官方餐饮购物流程。优先帮助用户查看菜单、新品、活动和优惠，再进入下单。',
    '地址、门店、商品或规格返回多个候选时，停止调用并让用户选择；绝不能擅自选择第一个。',
    '只有用户已经明确选择具体商品、数量、规格和配送/自取方式后，才能调用创建订单等交易能力。',
    '创建订单只做到待支付；支付必须由用户在官方页面亲自完成，不得声称已经付款。',
    '工具返回的支付链接必须原样保留，不得改写、补全或自行编造。',
  ];
}

function officialCheckoutHost(templateId = '', hostname = '') {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  const suffixes = templateId === 'mcd-cn'
    ? ['mcd.cn', 'mcdchina.net']
    : templateId === 'luckin-cn'
      ? ['lkcoffee.com', 'luckincoffee.com']
      : [];
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function validateCommerceCheckoutUrl(value = '', templateId = '') {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return officialCheckoutHost(templateId, url.hostname) ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

export function validateCommerceImageUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString().slice(0, 3000);
  } catch (_) {
    return '';
  }
}

function visit(value, callback, depth = 0, seen = new Set()) {
  if (value == null || depth > 10) return;
  if (typeof value === 'string') {
    callback('', value);
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 200_000) {
      try { visit(JSON.parse(trimmed), callback, depth + 1, seen); } catch (_) {}
    }
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((item) => visit(item, callback, depth + 1, seen));
    return;
  }
  Object.entries(value).slice(0, 300).forEach(([key, item]) => {
    if (typeof item === 'string' || typeof item === 'number') callback(key, String(item));
    visit(item, callback, depth + 1, seen);
  });
}

function firstField(sources = [], pattern, max = 160) {
  let found = '';
  for (const source of sources) {
    visit(source, (key, value) => {
      if (!found && pattern.test(String(key || ''))) found = clean(value, max);
    });
    if (found) return found;
  }
  return '';
}

function firstImageField(sources = []) {
  let found = '';
  for (const source of sources) {
    visit(source, (key, value) => {
      if (found || !/(?:image|picture|photo|pic|thumbnail|cover|logo).*(?:url|src)?$/i.test(String(key || ''))) return;
      found = validateCommerceImageUrl(value);
    });
    if (found) return found;
  }
  return '';
}

function normalizeCommerceItem(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sources = [value];
  const name = firstField(sources, /^(?:productName|productTitle|itemName|skuName|goodsName|foodName|name|title)$/i, 120);
  if (!name) return null;
  const quantityText = firstField(sources, /^(?:quantity|qty|count|num|number)$/i, 12);
  const quantity = Math.max(1, Math.min(99, Math.round(Number(quantityText) || 1)));
  return Object.freeze({
    id: firstField(sources, /^(?:productId|productCode|skuCode|itemId|skuId|goodsId|foodId|id)$/i, 100),
    name,
    quantity,
    category: firstField(sources, /^(?:category|categoryName|group|groupName|productCategory|menuCategory)$/i, 60),
    spec: firstField(sources, /^(?:spec|specification|variant|option|options|attribute|attributes|remark)$/i, 160),
    price: firstField(sources, /^(?:discountPrice|estimatePrice|initialPrice|currentPrice|payAmount|totalAmount|salePrice|unitPrice|price|amount)$/i, 40),
    imageUrl: firstImageField(sources),
  });
}

function extractCommerceItems(sources = []) {
  let found = [];
  const seen = new Set();
  const scan = (value, depth = 0) => {
    if (found.length || value == null || depth > 9 || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      const items = value.slice(0, 50).map(normalizeCommerceItem).filter(Boolean);
      if (items.length) found = items;
      else value.slice(0, 100).forEach((item) => scan(item, depth + 1));
      return;
    }
    Object.entries(value).slice(0, 300).forEach(([key, item]) => {
      if (found.length) return;
      if (Array.isArray(item) && /items?|products?|goods|foods?|skus?|details?|cart|orderLines?/i.test(key)) {
        const items = item.slice(0, 50).map(normalizeCommerceItem).filter(Boolean);
        if (items.length) { found = items; return; }
      }
      if (typeof item === 'object') scan(item, depth + 1);
      else if (typeof item === 'string') {
        const text = item.trim();
        if ((text.startsWith('{') || text.startsWith('[')) && text.length < 200_000) {
          try { scan(JSON.parse(text), depth + 1); } catch (_) {}
        }
      }
    });
  };
  sources.forEach((source) => scan(source));
  return found.slice(0, 50);
}

export function extractCommerceCatalog(steps = []) {
  const rows = [...(Array.isArray(steps) ? steps : [])].reverse();
  for (const step of rows) {
    if (step?.result?.ok === false || !isOfficialCommerceCapability(step?.capability)) continue;
    if (commerceCapabilityKind(step.capability) !== 'catalog') continue;
    const sources = [step.result?.structuredContent, step.result?.raw, step.result?.content, step.result?.text];
    const items = extractCommerceItems(sources);
    if (!items.length) continue;
    return Object.freeze({
      templateId: String(step.capability.source?.serviceTemplateId || ''),
      items: Object.freeze(items),
    });
  }
  return null;
}

function normalizeCommerceStore(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sources = [value];
  const id = firstField(sources, /^(?:storeId|shopId|restaurantId|poiId|id)$/i, 120);
  const name = firstField(sources, /^(?:storeName|shopName|restaurantName|poiName|name)$/i, 120);
  const address = firstField(sources, /^(?:storeAddress|shopAddress|restaurantAddress|address)$/i, 220);
  if (!id && !name && !address) return null;
  return Object.freeze({
    id,
    name: name || '附近门店',
    address,
    distance: firstField(sources, /^(?:distanceText|distance)$/i, 60),
    businessHours: firstField(sources, /^(?:businessHours|openingHours|openHours|hours)$/i, 100),
    imageUrl: firstImageField(sources),
  });
}

function findCommerceStores(sources = []) {
  let found = [];
  const seen = new Set();
  const scan = (value, depth = 0, parentKey = '') => {
    if (found.length || value == null || depth > 9 || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      if (/stores?|shops?|restaurants?|pois?|list|data|results?/i.test(parentKey)) {
        const stores = value.slice(0, 20).map(normalizeCommerceStore).filter(Boolean);
        if (stores.length) { found = stores; return; }
      }
      value.slice(0, 100).forEach((item) => scan(item, depth + 1, parentKey));
      return;
    }
    Object.entries(value).slice(0, 300).forEach(([key, item]) => {
      if (found.length) return;
      if (typeof item === 'object') scan(item, depth + 1, key);
      else if (typeof item === 'string') {
        const text = item.trim();
        if ((text.startsWith('{') || text.startsWith('[')) && text.length < 200_000) {
          try { scan(JSON.parse(text), depth + 1, key); } catch (_) {}
        }
      }
    });
  };
  sources.forEach((source) => scan(source));
  if (!found.length) {
    for (const source of sources) {
      const store = normalizeCommerceStore(source);
      if (store) { found = [store]; break; }
    }
  }
  return found.slice(0, 20);
}

export function extractCommerceStoreDiscovery(steps = []) {
  const rows = [...(Array.isArray(steps) ? steps : [])].reverse();
  for (const step of rows) {
    if (step?.result?.ok === false || !isOfficialCommerceCapability(step?.capability)) continue;
    if (commerceCapabilityKind(step.capability) !== 'location') continue;
    const sources = [step.result?.structuredContent, step.result?.raw, step.result?.content, step.result?.text];
    const stores = findCommerceStores(sources);
    if (!stores.length) continue;
    return Object.freeze({
      templateId: String(step.capability.source?.serviceTemplateId || ''),
      stores: Object.freeze(stores),
    });
  }
  return null;
}

export function extractCommerceCheckout(steps = []) {
  const rows = [...(Array.isArray(steps) ? steps : [])].reverse();
  for (const step of rows) {
    if (step?.result?.ok === false || !isOfficialCommerceCapability(step?.capability)) continue;
    if (commerceCapabilityKind(step.capability) !== 'checkout') continue;
    const templateId = String(step.capability.source?.serviceTemplateId || '');
    const sources = [step.result?.structuredContent, step.result?.raw, step.result?.content, step.result?.text];
    let checkoutUrl = '';
    for (const source of sources) {
      visit(source, (key, value) => {
        if (checkoutUrl || !/(?:pay|payment|cashier|checkout|redirect).*(?:url|link)|payH5Url/i.test(String(key || ''))) return;
        checkoutUrl = validateCommerceCheckoutUrl(value, templateId);
      });
      if (checkoutUrl) break;
    }
    const providerLabel = templateId === 'mcd-cn' ? '麦当劳' : '瑞幸咖啡';
    const items = extractCommerceItems(sources);
    const orderId = firstField(sources, /^(?:orderId|orderNo|tradeNo|orderCode)$/i, 100);
    const explicitTitle = firstField(sources, /^(?:title|productTitle|orderTitle|summary|productName)$/i, 100);
    const amount = firstField(sources, /^(?:payAmount|totalAmount|amount|orderPrice|price)$/i, 40);
    if (!checkoutUrl && !orderId && !explicitTitle && !amount && !items.length) continue;
    return Object.freeze({
      templateId,
      providerLabel,
      checkoutUrl,
      orderId,
      title: explicitTitle || items[0]?.name || `${providerLabel}订单`,
      amount,
      storeName: firstField(sources, /^(?:storeName|shopName|restaurantName|branchName)$/i, 120),
      storeAddress: firstField(sources, /^(?:storeAddress|shopAddress|restaurantAddress|address)$/i, 180),
      fulfillment: firstField(sources, /^(?:fulfillmentType|deliveryType|pickupType|diningType|serviceType|orderType)$/i, 80),
      imageUrl: items.find((item) => item.imageUrl)?.imageUrl || firstImageField(sources),
      items: Object.freeze(items),
      note: '订单已准备好，支付需由你本人完成',
    });
  }
  return null;
}

export function normalizeCommerceOrderStatus(value = '', templateId = '') {
  const raw = clean(value, 120);
  if (!raw) return '';
  const normalized = raw.toLowerCase().replace(/[\s_-]+/g, '');
  if (templateId === 'mcd-cn' && /^\d+$/.test(normalized)) {
    const code = Number(normalized);
    if (code === 1) return 'pending_payment';
    if ([2, 4, 10].includes(code)) return 'paid';
    if ([6, 8].includes(code)) return 'completed';
    if (code === 7) return 'cancelled';
  }
  if (/取消|已关(?:闭|单)|closed|cancel(?:led)?|refund(?:ed)?|退款/.test(normalized)) return 'cancelled';
  if (/过期|超时|失效|expired|timeout/.test(normalized)) return 'expired';
  if (/未支付|待支付|待付款|unpaid|pendingpayment|paymentpending|notpaid|paying/.test(normalized)) return 'pending_payment';
  if (/已完成|订单完成|已取餐|已送达|已评价|completed|complete|delivered|pickedup|fulfilled|reviewed/.test(normalized)) return 'completed';
  if (/已支付|支付成功|付款成功|已付款|制作|配餐|备餐|配送中|待取餐|可取餐|paid|paymentsuccess|paysuccess|tradesuccess|preparing|delivering|readyforpickup/.test(normalized)) return 'paid';
  return '';
}

export function extractCommerceOrderStatus(steps = [], expectedOrderId = '') {
  const rows = [...(Array.isArray(steps) ? steps : [])].reverse();
  const expected = clean(expectedOrderId, 100);
  for (const step of rows) {
    if (step?.result?.ok === false || !isOfficialCommerceCapability(step?.capability)) continue;
    if (commerceCapabilityKind(step.capability) !== 'order') continue;
    const templateId = String(step.capability.source?.serviceTemplateId || '');
    const sources = [step.result?.structuredContent, step.result?.raw, step.result?.content, step.result?.text];
    const externalOrderId = firstField(sources, /^(?:orderId|orderNo|tradeNo|orderCode)$/i, 100);
    if (expected && externalOrderId && externalOrderId !== expected) continue;
    const statusFields = [
      /^(?:orderStatusCode|mpOrderStatusCode)$/i,
      /^(?:orderStatus|orderState)$/i,
      /^(?:payStatus|paymentStatus|tradeStatus)$/i,
      /^(?:statusCode|status)$/i,
    ];
    let rawStatus = '';
    let status = '';
    for (const [index, pattern] of statusFields.entries()) {
      rawStatus = firstField(sources, pattern, 120);
      status = normalizeCommerceOrderStatus(rawStatus, templateId);
      if (!status && index === 2 && /^success$/i.test(clean(rawStatus, 40))) status = 'paid';
      if (status) break;
    }
    if (!status) continue;
    return Object.freeze({
      templateId,
      externalOrderId: externalOrderId || expected,
      status,
      rawStatus,
      checkedAt: Date.now(),
    });
  }
  return null;
}
