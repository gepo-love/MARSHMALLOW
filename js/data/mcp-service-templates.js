const SERVICE_TEMPLATES = [
  {
    id: 'mcd-cn',
    name: '麦当劳',
    endpoint: 'https://mcp.mcd.cn/',
    authUrl: 'https://open.mcd.cn/mcp',
    preferredProtocolVersion: '2025-06-18',
  },
  {
    id: 'luckin-cn',
    name: '瑞幸咖啡',
    endpoint: 'https://gwmcp.lkcoffee.com/order/user/mcp',
    authUrl: 'https://open.lkcoffee.com/mcp',
    // The official profile is standard Streamable HTTP. Pin the handshake so
    // the client does not probe the 2026 stateless extension first; Luckin's
    // gateway currently surfaces that unknown method as an upstream HTTP 500.
    preferredProtocolVersion: '2025-06-18',
  },
];

const BUILTIN_MCP_READ_TOOLS = Object.freeze({
  'mcd-cn': Object.freeze([
    /^delivery-query-addresses$/i,
    /^query-nearby-stores$/i,
    /^query-meals$/i,
  ]),
  'luckin-cn': Object.freeze([
    /^queryShopList$/i,
    /^searchProductForMcp$/i,
    /^queryOrderDetailInfo$/i,
  ]),
});

export const MCP_SERVICE_TEMPLATES = Object.freeze(
  SERVICE_TEMPLATES.map((item) => Object.freeze({ ...item })),
);

export function isBuiltinMcpProxyEndpoint(value = '') {
  let candidate;
  try {
    candidate = new URL(String(value || '').trim());
    candidate.hash = '';
  } catch (_) {
    return false;
  }
  return MCP_SERVICE_TEMPLATES.some((item) => {
    const endpoint = new URL(item.endpoint);
    endpoint.hash = '';
    return candidate.toString() === endpoint.toString();
  });
}

export function getMcpServiceTemplate(templateId = '') {
  const id = String(templateId || '').trim();
  return MCP_SERVICE_TEMPLATES.find((item) => item.id === id) || null;
}

export function builtinMcpToolRisk(templateId = '', toolName = '') {
  if (!getMcpServiceTemplate(templateId)) return '';
  const name = String(toolName || '').trim();
  if (!name) return '';
  if (/(?:^|[-_])create[-_]?order(?:$|[-_])|createOrder|(?:^|[-_])(?:redeem|exchange|purchase)(?:$|[-_])/i.test(name)) {
    return 'transaction';
  }
  if (/(?:^|[-_])(?:create[-_]?address|claim|receive|cancel|delete|update)(?:$|[-_])|createAddress|cancelOrder/i.test(name)) {
    return 'write';
  }
  if ((BUILTIN_MCP_READ_TOOLS[templateId] || []).some((pattern) => pattern.test(name))) {
    return 'read';
  }
  return '';
}
