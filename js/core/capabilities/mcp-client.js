import { capabilityFromMcpTool, safeCapabilitySegment } from './schema.js';
import { hasNativeHttp, nativeHttpPostJson } from '../native-http.js';
import { isBuiltinMcpProxyEndpoint } from '../../data/mcp-service-templates.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_MCP_PROTOCOL_VERSION = '2025-11-25';

export class McpProtocolError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'McpProtocolError';
    this.code = details.code ?? 'mcp_protocol_error';
    this.data = details.data;
    this.status = details.status;
  }
}

export function validateMcpEndpoint(value, allowInsecureLocal = false) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch (_) {
    throw new TypeError('MCP endpoint must be a valid URL');
  }
  if (url.username || url.password) throw new TypeError('MCP credentials must not be embedded in the URL');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
  if (url.protocol !== 'https:' && !(allowInsecureLocal && local && url.protocol === 'http:')) {
    throw new TypeError('MCP endpoint must use HTTPS (HTTP is allowed only for localhost development)');
  }
  url.hash = '';
  return url.toString();
}

function normalizeHeaders(value = {}) {
  const headers = {};
  for (const [key, item] of Object.entries(value || {})) {
    const name = String(key || '').trim();
    if (!name || item == null || item === '') continue;
    if (/^(host|origin|content-length|mcp-session-id|mcp-protocol-version|mcp-method|mcp-name)$/i.test(name)) continue;
    headers[name] = String(item);
  }
  return headers;
}

async function defaultMcpFetch(url, init = {}) {
  if (hasNativeHttp() && String(init.method || 'GET').toUpperCase() === 'POST') {
    return nativeHttpPostJson(url, {
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      connectTimeout: 60_000,
      readTimeout: 120_000,
    });
  }
  const pageLocation = globalThis.location;
  if (pageLocation?.protocol === 'https:' && isBuiltinMcpProxyEndpoint(url)) {
    // Official commerce MCP servers do not consistently expose browser CORS
    // headers. PWA requests therefore use our authenticated, same-origin,
    // allowlisted relay. Native builds keep using the native HTTP transport.
    const headers = {};
    const sourceHeaders = new Headers(init.headers || {});
    sourceHeaders.forEach((value, key) => { headers[key] = value; });
    return globalThis.fetch(new URL('/api/mcp/proxy', pageLocation.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: String(url || ''),
        method: String(init.method || 'POST').toUpperCase(),
        headers,
        body: typeof init.body === 'string' ? init.body : '',
      }),
      credentials: 'same-origin',
      signal: init.signal,
    });
  }
  return globalThis.fetch(url, init);
}

function utf8Base64(value = '') {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function encodeMcpHeaderValue(value) {
  let text;
  if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else if (typeof value === 'string') text = value;
  else throw new TypeError('MCP header parameters must be string, number, or boolean');
  const unsafe = /^[ \t]|[ \t]$/.test(text) || /[^\x20-\x7e]/.test(text) || /[\x00-\x1f\x7f]/.test(text);
  return unsafe ? `=?base64?${utf8Base64(text)}?=` : text;
}

function containsNestedMcpHeader(schema, depth = 0) {
  if (!schema || typeof schema !== 'object') return false;
  if (Array.isArray(schema)) return schema.some((item) => containsNestedMcpHeader(item, depth + 1));
  return Object.entries(schema).some(([key, item]) => {
    if (key === 'x-mcp-header') return depth > 0;
    return containsNestedMcpHeader(item, depth + 1);
  });
}

function toolHeaderMappings(tool = {}) {
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const mappings = [];
  const used = new Set();
  for (const [property, definition] of Object.entries(properties)) {
    if (!definition || typeof definition !== 'object') continue;
    if (containsNestedMcpHeader(definition)) {
      throw new TypeError(`MCP tool ${tool.name} uses x-mcp-header on a nested schema`);
    }
    if (!Object.prototype.hasOwnProperty.call(definition, 'x-mcp-header')) continue;
    const name = String(definition['x-mcp-header'] || '');
    if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new TypeError(`MCP tool ${tool.name} has an invalid x-mcp-header name`);
    }
    const normalized = name.toLowerCase();
    if (used.has(normalized)) {
      throw new TypeError(`MCP tool ${tool.name} repeats an x-mcp-header name`);
    }
    used.add(normalized);
    const types = Array.isArray(definition.type) ? definition.type : [definition.type];
    if (!types.length || types.some((type) => !['string', 'number', 'integer', 'boolean'].includes(type))) {
      throw new TypeError(`MCP tool ${tool.name} uses x-mcp-header on a non-primitive parameter`);
    }
    mappings.push({ property, name });
  }
  return mappings;
}

function mergeSignals(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener?.('abort', forward, { once: true });
  const timer = Number(timeoutMs) > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Number(timeoutMs)) : null;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', forward);
    },
  };
}

function parseSsePayload(text = '') {
  const messages = [];
  const events = String(text || '').replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const event of events) {
    const data = event.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
      .trim();
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch (_) {}
  }
  return messages;
}

async function readRpcMessages(response) {
  if (response.status === 202 || response.status === 204) return [];
  const text = await response.text();
  if (!text.trim()) return [];
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/event-stream') || /^\s*(event|data):/m.test(text)) {
    return parseSsePayload(text);
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    throw new McpProtocolError('MCP server returned invalid JSON', { status: response.status });
  }
}

export class RemoteMcpClient {
  #endpoint;

  #headers;

  #fetch;

  #requestId = 0;

  #sessionId = '';

  #initialized = false;

  #serverInfo = null;

  #mode = 'modern';

  #toolHeaderMappings = new Map();

  constructor(options = {}) {
    this.#endpoint = validateMcpEndpoint(options.endpoint, options.allowInsecureLocal === true);
    this.#headers = normalizeHeaders(options.headers);
    if (options.bearerToken) this.#headers.Authorization = `Bearer ${String(options.bearerToken)}`;
    this.#fetch = options.fetch || defaultMcpFetch;
    if (typeof this.#fetch !== 'function') throw new TypeError('MCP client requires fetch');
    this.protocolVersion = String(options.protocolVersion || MCP_PROTOCOL_VERSION);
    this.legacyProtocolVersion = String(
      options.legacyProtocolVersion
      || (options.protocolVersion && options.protocolVersion !== MCP_PROTOCOL_VERSION ? options.protocolVersion : '')
      || LEGACY_MCP_PROTOCOL_VERSION,
    );
    this.preferLegacy = options.preferLegacy === true || this.protocolVersion !== MCP_PROTOCOL_VERSION;
    this.clientInfo = {
      name: String(options.clientName || 'marshmallow-machine').slice(0, 100),
      version: String(options.clientVersion || '0.1.0').slice(0, 50),
    };
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || 60_000));
  }

  get endpoint() { return this.#endpoint; }

  get sessionId() { return this.#sessionId; }

  get serverInfo() { return this.#serverInfo; }

  get initialized() { return this.#initialized; }

  get mode() { return this.#mode; }

  #requestParams(params = {}, modern = this.#mode === 'modern') {
    if (!modern) return params;
    return {
      ...(params || {}),
      _meta: {
        ...(params?._meta || {}),
        'io.modelcontextprotocol/protocolVersion': this.protocolVersion,
        'io.modelcontextprotocol/clientInfo': this.clientInfo,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    };
  }

  async #post(message, options = {}) {
    const timeout = mergeSignals(options.signal, options.timeoutMs || this.timeoutMs);
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...this.#headers,
    };
    const modern = options.modern === true || this.#mode === 'modern';
    if (modern) {
      headers['Mcp-Method'] = String(message?.method || '');
      const routedName = message?.params?.name || message?.params?.uri;
      if (routedName) headers['Mcp-Name'] = String(routedName);
    }
    if (modern || this.#initialized) headers['MCP-Protocol-Version'] = this.protocolVersion;
    if (!modern && this.#sessionId) headers['Mcp-Session-Id'] = this.#sessionId;
    if (modern && options.requestHeaders) Object.assign(headers, options.requestHeaders);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: timeout.signal,
      });
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) this.#sessionId = sessionId;
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new McpProtocolError(`MCP HTTP ${response.status}: ${body.slice(0, 500) || response.statusText}`, {
          status: response.status,
        });
      }
      return readRpcMessages(response);
    } catch (error) {
      if (timeout.timedOut()) {
        const wrapped = new McpProtocolError('MCP request timed out', { code: 'mcp_timeout' });
        wrapped.cause = error;
        throw wrapped;
      }
      throw error;
    } finally {
      timeout.cleanup();
    }
  }

  async request(method, params = {}, options = {}) {
    const allowedBeforeConnect = method === 'initialize'
      || method === 'server/discover'
      || options.allowBeforeConnect === true;
    if (!this.#initialized && !allowedBeforeConnect) {
      throw new McpProtocolError('MCP client is not initialized', { code: 'mcp_not_initialized' });
    }
    const id = ++this.#requestId;
    const modern = options.modern === true || this.#mode === 'modern';
    const requestParams = this.#requestParams(params, modern);
    const messages = await this.#post({ jsonrpc: '2.0', id, method, params: requestParams }, {
      ...options,
      modern,
    });
    const response = messages.find((item) => item?.id === id);
    if (!response) throw new McpProtocolError(`MCP response missing for ${method}`, { code: 'mcp_missing_response' });
    if (response.error) {
      throw new McpProtocolError(response.error.message || `MCP ${method} failed`, {
        code: response.error.code,
        data: response.error.data,
      });
    }
    return response.result;
  }

  async notify(method, params = {}, options = {}) {
    if (!this.#initialized && method !== 'notifications/initialized') {
      throw new McpProtocolError('MCP client is not initialized', { code: 'mcp_not_initialized' });
    }
    const modern = options.modern === true || this.#mode === 'modern';
    await this.#post({
      jsonrpc: '2.0',
      method,
      params: this.#requestParams(params, modern),
    }, { ...options, modern });
  }

  async connect(options = {}) {
    if (this.#initialized) return this.#serverInfo;
    if (!this.preferLegacy) {
      this.#mode = 'modern';
      this.protocolVersion = MCP_PROTOCOL_VERSION;
      try {
        const discovered = await this.request('server/discover', {}, {
          ...options,
          modern: true,
          allowBeforeConnect: true,
        });
        const supported = Array.isArray(discovered?.supportedVersions)
          ? discovered.supportedVersions.map(String)
          : [];
        if (supported.length && !supported.includes(MCP_PROTOCOL_VERSION)) {
          throw new McpProtocolError('MCP server does not support the current stateless protocol', {
            code: 'mcp_unsupported_modern_protocol',
          });
        }
        const responseMeta = discovered?._meta || {};
        this.#serverInfo = Object.freeze({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: discovered?.capabilities || {},
          serverInfo: responseMeta['io.modelcontextprotocol/serverInfo'] || discovered?.serverInfo || {},
          instructions: String(discovered?.instructions || ''),
        });
        this.#initialized = true;
        return this.#serverInfo;
      } catch (error) {
        const fallback = error?.code === -32601
          || error?.code === 'mcp_unsupported_modern_protocol'
          || [400, 404, 405, 426].includes(Number(error?.status))
          || error instanceof TypeError;
        if (!fallback) throw error;
      }
    }

    this.#mode = 'legacy';
    this.protocolVersion = this.legacyProtocolVersion;
    const result = await this.request('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: this.clientInfo,
    }, { ...options, modern: false, allowBeforeConnect: true });
    if (!result?.protocolVersion) {
      throw new McpProtocolError('MCP initialize response is missing protocolVersion');
    }
    this.protocolVersion = String(result.protocolVersion);
    this.#serverInfo = Object.freeze({
      protocolVersion: this.protocolVersion,
      capabilities: result.capabilities || {},
      serverInfo: result.serverInfo || {},
      instructions: String(result.instructions || ''),
    });
    this.#initialized = true;
    try {
      await this.notify('notifications/initialized', {}, { ...options, modern: false });
    } catch (error) {
      this.#initialized = false;
      throw error;
    }
    return this.#serverInfo;
  }

  async listTools(options = {}) {
    if (!this.#initialized) await this.connect(options);
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, options);
      if (Array.isArray(result?.tools)) {
        for (const tool of result.tools) {
          try {
            const mappings = toolHeaderMappings(tool);
            this.#toolHeaderMappings.set(String(tool?.name || ''), mappings);
            tools.push(tool);
          } catch (error) {
            if (typeof options.onWarning === 'function') options.onWarning(error, tool);
          }
        }
      }
      cursor = String(result?.nextCursor || '');
      if (!cursor) return tools;
    }
    throw new McpProtocolError('MCP tools/list exceeded pagination limit');
  }

  async callTool(name, args = {}, options = {}) {
    if (!this.#initialized) await this.connect(options);
    const toolArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const requestHeaders = {};
    if (this.#mode === 'modern') {
      for (const mapping of this.#toolHeaderMappings.get(String(name || '')) || []) {
        if (!Object.prototype.hasOwnProperty.call(toolArgs, mapping.property)) continue;
        const value = toolArgs[mapping.property];
        if (value == null) continue;
        requestHeaders[`Mcp-Param-${mapping.name}`] = encodeMcpHeaderValue(value);
      }
    }
    return this.request('tools/call', {
      name: String(name || ''),
      arguments: toolArgs,
    }, { ...options, requestHeaders });
  }

  async close(options = {}) {
    if (this.#mode === 'modern') {
      this.#initialized = false;
      this.#serverInfo = null;
      return;
    }
    if (!this.#sessionId) {
      this.#initialized = false;
      this.#serverInfo = null;
      return;
    }
    const timeout = mergeSignals(options.signal, options.timeoutMs || 10_000);
    try {
      await this.#fetch(this.#endpoint, {
        method: 'DELETE',
        headers: {
          ...this.#headers,
          'MCP-Protocol-Version': this.protocolVersion,
          'Mcp-Session-Id': this.#sessionId,
        },
        signal: timeout.signal,
      });
    } catch (_) {
      // Session cleanup is best effort; local client state must still be cleared.
    } finally {
      timeout.cleanup();
      this.#sessionId = '';
      this.#initialized = false;
      this.#serverInfo = null;
    }
  }
}

export async function createMcpCapabilityProvider(options = {}) {
  const serverId = String(options.serverId || options.name || 'remote').trim();
  const client = options.client || new RemoteMcpClient(options);
  const tools = await client.listTools({ signal: options.signal });
  const capabilities = tools.map((tool) => capabilityFromMcpTool(tool, {
    serverId,
    namespace: options.namespace,
    contexts: options.contexts,
    riskOverrides: options.riskOverrides,
  }));
  const providerId = `mcp.${safeCapabilitySegment(serverId, 'remote')}`;
  return {
    provider: {
      id: providerId,
      type: 'mcp',
      priority: options.priority || 0,
      metadata: {
        serverId,
        endpoint: client.endpoint,
        serverInfo: client.serverInfo,
      },
      async execute(capability, args, context = {}) {
        const toolName = capability.source?.toolName;
        if (!toolName) throw new Error(`MCP tool mapping is missing for ${capability.id}`);
        return client.callTool(toolName, args, { signal: context.signal });
      },
      close: () => client.close(),
    },
    capabilities,
    client,
  };
}
