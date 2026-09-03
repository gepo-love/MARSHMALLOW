import { RemoteMcpClient } from './capabilities/mcp-client.js';
import { resultToText } from './capabilities/schema.js';
import { normalizeAmapPois } from './amap-tools.js';

const AMAP_MCP_ENDPOINT = 'https://mcp.amap.com/mcp';

function clean(value = '', max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseJsonText(value = '') {
  const text = String(value || '').trim();
  if (!text) return null;
  const candidates = [text, text.replace(/^```(?:json)?\s*|\s*```$/gi, '')];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch (_) { /* continue */ }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { /* ignore */ }
  }
  return null;
}

function findPoiPayload(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 7) return null;
  if (Array.isArray(value.pois) || Array.isArray(value.pois?.poi)) return value;
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') continue;
    const hit = findPoiPayload(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function poisFromResult(result = {}) {
  const structured = findPoiPayload(result.structuredContent)
    || findPoiPayload(result.data)
    || findPoiPayload(result);
  if (structured) return normalizeAmapPois(structured);
  const parsed = parseJsonText(resultToText(result, 120000));
  const payload = findPoiPayload(parsed);
  return payload ? normalizeAmapPois(payload) : [];
}

function toolByPattern(tools = [], patterns = []) {
  return tools.find((tool) => patterns.some((pattern) => pattern.test(String(tool?.name || '')))) || null;
}

function setKnownArg(args, properties, names, value) {
  if (value === '' || value === null || value === undefined) return;
  const key = names.find((name) => Object.prototype.hasOwnProperty.call(properties, name));
  if (key) args[key] = value;
}

function buildSearchArgs(tool, values = {}) {
  const properties = tool?.inputSchema?.properties && typeof tool.inputSchema.properties === 'object'
    ? tool.inputSchema.properties
    : {};
  const args = {};
  setKnownArg(args, properties, ['keywords', 'keyword', 'query'], clean(values.keywords, 80));
  setKnownArg(args, properties, ['city', 'region'], clean(values.city, 40));
  setKnownArg(args, properties, ['location', 'center'], clean(values.location, 40));
  setKnownArg(args, properties, ['radius'], Math.max(100, Math.min(50000, Number(values.radius) || 1500)));
  setKnownArg(args, properties, ['citylimit', 'cityLimit'], values.cityLimit === false ? false : true);
  return args;
}

export async function createAmapMcpSearchSession(config = {}, options = {}) {
  const apiKey = String(config?.apiKey || '').trim();
  if (!apiKey) throw new Error('缺少高德 Web 服务 Key');
  const endpoint = new URL(AMAP_MCP_ENDPOINT);
  endpoint.searchParams.set('key', apiKey);
  const client = options.client || new RemoteMcpClient({ endpoint: endpoint.toString() });
  try {
    const tools = await client.listTools({ signal: options.signal });
    const textTool = toolByPattern(tools, [
      /(?:text|keyword).*search/i,
      /search.*(?:text|keyword)/i,
      /maps_text_search/i,
    ]);
    const aroundTool = toolByPattern(tools, [
      /around.*search/i,
      /search.*around/i,
      /maps_around_search/i,
    ]);
    if (!textTool) throw new Error('高德 MCP 暂未提供地点搜索工具');
    return {
      source: 'amap_mcp',
      async textSearch(values = {}) {
        const result = await client.callTool(textTool.name, buildSearchArgs(textTool, values), { signal: options.signal });
        const pois = poisFromResult(result);
        if (!pois.length) throw new Error('高德 MCP 地点搜索没有返回可解析结果');
        return { source: 'amap_mcp_text', pois, query: clean(values.keywords, 80), city: clean(values.city, 40) };
      },
      async aroundSearch(values = {}) {
        if (!aroundTool) throw new Error('高德 MCP 暂未提供周边搜索工具');
        const result = await client.callTool(aroundTool.name, buildSearchArgs(aroundTool, values), { signal: options.signal });
        const pois = poisFromResult(result);
        if (!pois.length) throw new Error('高德 MCP 周边搜索没有返回可解析结果');
        return { source: 'amap_mcp_around', pois, query: clean(values.keywords, 80), city: clean(values.city, 40) };
      },
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
