import { callMeituanErrandBridge, queryMeituanTravel } from '../meituan-services.js';

const source = (toolName) => ({ type: 'builtin-meituan', serverId: 'meituan', toolName });
const objectSchema = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const addressSchema = {
  type: 'object',
  description: '从美团地址簿或 POI 搜索结果中选择的完整地址',
  properties: {
    address: { type: 'string' }, houseNumber: { type: 'string' },
    lat: { type: 'integer' }, lng: { type: 'integer' }, cityId: { type: 'integer' },
    name: { type: 'string' }, phone: { type: 'string' },
  },
  required: ['address', 'lat', 'lng', 'cityId', 'phone'],
  additionalProperties: false,
};
const deliverySchema = objectSchema({
  sender: addressSchema,
  recipient: addressSchema,
  goods: {
    type: 'object',
    properties: {
      goodsName: { type: 'string' }, goodsWeight: { type: 'number' },
      goodTypes: { type: 'array', items: { type: 'integer' } },
      goodTypeNames: { type: 'array', items: { type: 'string' } },
    },
    required: ['goodsName', 'goodsWeight'],
    additionalProperties: false,
  },
  businessType: { type: 'integer', enum: [1, 2] },
  bizTypeSceneTag: { type: 'integer', minimum: 0, maximum: 6 },
  tipFee: { type: 'number', minimum: 0 },
  remark: { type: 'string', maxLength: 300 },
  purchaseDetail: { type: 'string', maxLength: 500 },
}, ['sender', 'recipient', 'goods', 'businessType']);

export function createBuiltinMeituanProvider() {
  const capabilities = [
    {
      id: 'meituan.travel.query', name: '美团酒店旅行查询',
      description: '查询美团酒旅的酒店、机票、火车票、景点门票、度假与行程规划信息。不包含外卖、打车或跑腿。',
      inputSchema: objectSchema({
        city: { type: 'string', minLength: 1, maxLength: 60 },
        query: { type: 'string', minLength: 1, maxLength: 1600 },
        originQuery: { type: 'string', maxLength: 1600 },
      }, ['city', 'query']),
      risk: 'read', contexts: ['chat', 'voice'], allowAutonomousUse: true,
      autoApproveRead: true, annotations: { readOnly: true, openWorld: true }, source: source('travel.query'),
    },
    {
      id: 'meituan.errand.login', name: '美团跑腿授权',
      description: '检查跑腿登录状态；未授权时返回可在美团 App 打开的授权链接。',
      inputSchema: objectSchema({ force: { type: 'boolean' } }), risk: 'write',
      contexts: ['chat', 'manual'], source: source('errand.login'),
    },
    {
      id: 'meituan.errand.confirm_auth', name: '确认美团跑腿授权',
      description: '用户已在美团 App 同意后，等待授权结果并将登录态保存在用户自己的桥服务。',
      inputSchema: objectSchema({}), risk: 'write', contexts: ['chat', 'manual'], source: source('errand.confirm_auth'),
    },
    {
      id: 'meituan.errand.addresses', name: '美团跑腿地址簿',
      description: '读取用户已授权的美团跑腿地址簿。',
      inputSchema: objectSchema({ businessType: { type: 'integer', enum: [1, 2] } }),
      risk: 'read', contexts: ['chat'], autoApproveRead: true, annotations: { readOnly: true }, source: source('errand.addresses'),
    },
    {
      id: 'meituan.errand.search_poi', name: '美团跑腿地址搜索',
      description: '在地址簿匹配不到时搜索 POI 并取得跑腿所需坐标。',
      inputSchema: objectSchema({
        keyword: { type: 'string', minLength: 1, maxLength: 160 }, city: { type: 'string', maxLength: 60 },
        lat: { type: 'integer' }, lng: { type: 'integer' },
      }, ['keyword']),
      risk: 'read', contexts: ['chat'], autoApproveRead: true, annotations: { readOnly: true, openWorld: true }, source: source('errand.search_poi'),
    },
    {
      id: 'meituan.errand.preview', name: '预览美团跑腿订单',
      description: '根据取送地址和物品计算跑腿费用，只预览，不提交订单。',
      inputSchema: deliverySchema, risk: 'transaction', contexts: ['chat'], source: source('errand.preview'),
    },
    {
      id: 'meituan.errand.submit', name: '提交美团跑腿订单',
      description: '在用户看过预览并明确确认后提交跑腿订单；参数必须与预览一致。',
      inputSchema: deliverySchema, risk: 'transaction', contexts: ['chat'],
      annotations: { destructive: false, idempotent: false, openWorld: true }, source: source('errand.submit'),
    },
    {
      id: 'meituan.errand.status', name: '查询美团跑腿订单',
      description: '使用订单号查询跑腿实时状态。',
      inputSchema: objectSchema({ orderId: { type: 'string', minLength: 1, maxLength: 120 } }, ['orderId']),
      risk: 'read', contexts: ['chat'], autoApproveRead: true, annotations: { readOnly: true }, source: source('errand.status'),
    },
  ];
  const commandMap = {
    'meituan.errand.login': 'login', 'meituan.errand.confirm_auth': 'confirm_auth',
    'meituan.errand.addresses': 'get_address_list', 'meituan.errand.search_poi': 'search_poi',
    'meituan.errand.preview': 'preview', 'meituan.errand.submit': 'submit',
    'meituan.errand.status': 'get_order_status',
  };
  return {
    provider: {
      id: 'builtin.meituan', type: 'builtin-meituan', priority: 90,
      async execute(capability = {}, argumentsValue = {}, options = {}) {
        if (capability.id === 'meituan.travel.query') return queryMeituanTravel(argumentsValue, options);
        const command = commandMap[capability.id];
        if (!command) throw new Error('不支持的美团能力');
        return callMeituanErrandBridge(command, argumentsValue, options);
      },
    },
    capabilities,
  };
}
