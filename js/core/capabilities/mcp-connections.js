import { get, put, remove } from '../db.js';
import {
  capabilityFromMcpTool,
  normalizeInputSchema,
  resultToText,
  safeCapabilitySegment,
} from './schema.js';
import { RemoteMcpClient, validateMcpEndpoint } from './mcp-client.js';
import { revokeCapabilityGrants } from './grants.js';
import { builtinMcpToolRisk, getMcpServiceTemplate } from '../../data/mcp-service-templates.js';

export const MCP_CONNECTIONS_KEY = 'mcpConnections';
export const MCP_CREDENTIALS_KEY = 'mcpCredentials';

function clean(value = '', max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function makeConnectionId() {
  if (globalThis.crypto?.randomUUID) return `mcp_${globalThis.crypto.randomUUID()}`;
  return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function mcpConnectionProviderId(connectionId = '') {
  return `mcp.${safeCapabilitySegment(connectionId, 'remote')}`;
}

function capabilityForConnectionTool(connectionId, tool, serviceTemplateId = '') {
  const risk = builtinMcpToolRisk(serviceTemplateId, tool?.name);
  return capabilityFromMcpTool(tool, {
    serverId: connectionId,
    namespace: `mcp_${safeCapabilitySegment(connectionId, 'remote')}`,
    serviceTemplateId,
    contexts: ['chat', 'voice', 'video', 'manual'],
    ...(risk ? { riskOverrides: { [tool.name]: risk } } : {}),
  });
}

function normalizeTool(tool = {}, defaultAutoApproveRead = false) {
  const name = clean(tool.name, 180);
  if (!name) return null;
  const annotations = tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
  const readOnly = annotations.readOnlyHint === true;
  const hasOwnApproval = Object.prototype.hasOwnProperty.call(tool, 'autoApproveRead');
  let inputSchema = { type: 'object', properties: {} };
  let outputSchema = null;
  let schemaError = clean(tool.schemaError, 240);
  try {
    inputSchema = normalizeInputSchema(tool.inputSchema);
    outputSchema = tool.outputSchema ? normalizeInputSchema(tool.outputSchema) : null;
  } catch (error) {
    // One malformed or pathologically deep remote tool must not hide every
    // other tool returned by the same MCP server. Keep it visible but disabled.
    schemaError = clean(error?.message || 'Capability schema is invalid', 240);
  }
  return {
    name,
    enabled: !schemaError && tool.enabled !== false,
    autoApproveRead: !schemaError && readOnly
      && (hasOwnApproval ? tool.autoApproveRead === true : defaultAutoApproveRead === true),
    title: clean(tool.title, 100),
    description: clean(tool.description, 1200),
    inputSchema,
    outputSchema,
    schemaError,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: annotations.destructiveHint === true,
      idempotentHint: annotations.idempotentHint === true,
      openWorldHint: annotations.openWorldHint === true,
    },
  };
}

export function normalizeMcpConnection(value = {}) {
  const endpoint = value.endpoint ? validateMcpEndpoint(value.endpoint, value.allowInsecureLocal === true) : '';
  const autoApproveRead = value.autoApproveRead === true;
  const tools = (Array.isArray(value.tools) ? value.tools : [])
    .slice(0, 200)
    .map((tool) => normalizeTool(tool, autoApproveRead))
    .filter(Boolean);
  const serviceTemplate = getMcpServiceTemplate(value.serviceTemplateId);
  return {
    id: clean(value.id, 100) || makeConnectionId(),
    name: clean(value.name, 60) || clean(value.serverName, 60) || 'MCP 连接',
    endpoint,
    enabled: value.enabled !== false,
    autoApproveRead,
    allowAutonomousUse: value.allowAutonomousUse === true,
    allowInsecureLocal: value.allowInsecureLocal === true,
    serviceTemplateId: serviceTemplate?.id || '',
    preferredProtocolVersion: serviceTemplate
      ? clean(value.preferredProtocolVersion || serviceTemplate.preferredProtocolVersion, 40)
      : '',
    serverName: clean(value.serverName, 100),
    protocolVersion: clean(value.protocolVersion, 40),
    tools,
    lastConnectedAt: Math.max(0, Number(value.lastConnectedAt || 0) || 0),
    updatedAt: Math.max(0, Number(value.updatedAt || 0) || Date.now()),
  };
}

export function applyMcpConnectionReadGrants(value = {}, grants = []) {
  const row = normalizeMcpConnection(value);
  const providerId = mcpConnectionProviderId(row.id);
  const matching = (Array.isArray(grants) ? grants : []).filter((grant) => (
    grant?.allow === true && grant.providerId === providerId
  ));
  if (!matching.length) return row;
  const grantedIds = new Set(matching.map((grant) => String(grant.capabilityId || '').toLowerCase()));
  return normalizeMcpConnection({
    ...row,
    tools: row.tools.map((tool) => ({
      ...tool,
      autoApproveRead: tool.annotations?.readOnlyHint === true && (
        tool.autoApproveRead === true
        || grantedIds.has('*')
        || grantedIds.has(capabilityForConnectionTool(row.id, tool, row.serviceTemplateId).id)
      ),
    })),
  });
}

function endpointDraftKey(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch (_) {
    return raw;
  }
}

export function updateMcpConnectionEndpointDraft(value = {}, endpoint = '') {
  const nextEndpoint = String(endpoint || '');
  if (endpointDraftKey(value.endpoint) === endpointDraftKey(nextEndpoint)) {
    return { ...value, endpoint: nextEndpoint };
  }
  return {
    ...value,
    endpoint: nextEndpoint,
    tools: [],
    serverName: '',
    protocolVersion: '',
    serviceTemplateId: '',
    preferredProtocolVersion: '',
    lastConnectedAt: 0,
  };
}

async function loadCredentialMap() {
  const row = await get('settings', MCP_CREDENTIALS_KEY).catch(() => null);
  const source = row?.value && typeof row.value === 'object' ? row.value : {};
  const out = {};
  for (const [id, value] of Object.entries(source)) {
    const token = String(value?.bearerToken || '').trim();
    if (token) out[clean(id, 100)] = { bearerToken: token };
  }
  return out;
}

export async function listMcpConnections() {
  const row = await get('settings', MCP_CONNECTIONS_KEY).catch(() => null);
  return (Array.isArray(row?.value) ? row.value : [])
    .map((item) => {
      try { return normalizeMcpConnection(item); } catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

export async function getMcpConnectionCredential(connectionId) {
  const credentials = await loadCredentialMap();
  return credentials[clean(connectionId, 100)] || { bearerToken: '' };
}

export async function saveMcpConnection(value = {}, options = {}) {
  const next = normalizeMcpConnection({ ...value, updatedAt: Date.now() });
  if (!next.endpoint) throw new TypeError('请填写 MCP Server URL');
  const rows = await listMcpConnections();
  const index = rows.findIndex((item) => item.id === next.id);
  const previous = index >= 0 ? rows[index] : null;
  if (index >= 0) rows[index] = next;
  else rows.push(next);
  await put('settings', { key: MCP_CONNECTIONS_KEY, value: rows });

  const providerId = mcpConnectionProviderId(next.id);
  if (!next.enabled) {
    await revokeCapabilityGrants({ providerId });
  } else {
    if (previous) {
      const nextEnabled = new Set(next.tools.filter((tool) => tool.enabled !== false).map((tool) => tool.name));
      const nextByName = new Map(next.tools.map((tool) => [tool.name, tool]));
      const revoked = new Set();
      const revokeToolGrant = async (tool) => {
        const capability = capabilityForConnectionTool(next.id, tool, next.serviceTemplateId);
        if (revoked.has(capability.id)) return;
        revoked.add(capability.id);
        await revokeCapabilityGrants({ providerId, capabilityId: capability.id });
      };
      for (const tool of previous.tools.filter((item) => item.enabled !== false && !nextEnabled.has(item.name))) {
        await revokeToolGrant(tool);
      }
      for (const tool of previous.tools.filter((item) => item.autoApproveRead === true)) {
        const nextTool = nextByName.get(tool.name);
        if (!nextTool || nextTool.autoApproveRead !== true) await revokeToolGrant(tool);
      }
      for (const tool of next.tools.filter((item) => (
        item.annotations?.readOnlyHint === true && item.autoApproveRead !== true
      ))) {
        await revokeToolGrant(tool);
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(options, 'bearerToken')) {
    const credentials = await loadCredentialMap();
    const token = String(options.bearerToken || '').trim();
    if (token) credentials[next.id] = { bearerToken: token };
    else delete credentials[next.id];
    await put('settings', { key: MCP_CREDENTIALS_KEY, value: credentials });
  }
  return next;
}

export async function deleteMcpConnection(connectionId) {
  const id = clean(connectionId, 100);
  const rows = (await listMcpConnections()).filter((item) => item.id !== id);
  await put('settings', { key: MCP_CONNECTIONS_KEY, value: rows });
  const credentials = await loadCredentialMap();
  delete credentials[id];
  if (Object.keys(credentials).length) await put('settings', { key: MCP_CREDENTIALS_KEY, value: credentials });
  else await remove(MCP_CREDENTIALS_KEY).catch(() => {});
  await revokeCapabilityGrants({ providerId: mcpConnectionProviderId(id) });
}

export async function discoverMcpConnection(value = {}, options = {}) {
  const draft = normalizeMcpConnection(value);
  if (!draft.endpoint) throw new TypeError('请填写 MCP Server URL');
  const bearerToken = Object.prototype.hasOwnProperty.call(options, 'bearerToken')
    ? String(options.bearerToken || '').trim()
    : (await getMcpConnectionCredential(draft.id)).bearerToken;
  const client = options.client || new RemoteMcpClient({
    endpoint: draft.endpoint,
    bearerToken,
    allowInsecureLocal: draft.allowInsecureLocal,
    protocolVersion: draft.preferredProtocolVersion || undefined,
  });
  try {
    const tools = await client.listTools({ signal: options.signal });
    const previousByName = new Map(draft.tools.map((tool) => [tool.name, tool]));
    const info = client.serverInfo || {};
    return normalizeMcpConnection({
      ...draft,
      serverName: info.serverInfo?.name || draft.serverName,
      protocolVersion: info.protocolVersion || client.protocolVersion,
      tools: tools.map((tool) => ({
        ...tool,
        enabled: previousByName.get(String(tool?.name || '').trim())?.enabled !== false,
        autoApproveRead: previousByName.has(String(tool?.name || '').trim())
          ? previousByName.get(String(tool?.name || '').trim()).autoApproveRead === true
          : draft.autoApproveRead === true,
      })),
      lastConnectedAt: Date.now(),
    });
  } finally {
    await client.close().catch(() => {});
  }
}

function sampleSchemaValue(schema = {}, key = '', depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 5) return null;
  if (Object.prototype.hasOwnProperty.call(schema, 'default')) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (Object.prototype.hasOwnProperty.call(schema, 'example')) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((item) => item && item !== 'null') || (schema.properties ? 'object' : 'string');
  if (type === 'object') {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    return (Array.isArray(schema.required) ? schema.required : []).reduce((out, property) => {
      out[property] = sampleSchemaValue(properties[property] || {}, property, depth + 1);
      return out;
    }, {});
  }
  if (type === 'array') return [];
  if (type === 'boolean') return false;
  if (type === 'integer' || type === 'number') return Number.isFinite(Number(schema.minimum)) ? Number(schema.minimum) : 0;
  if (/url|uri|link/i.test(`${key} ${schema.format || ''}`)) return 'https://example.com/';
  if (/query|search|keyword|查询|搜索/i.test(key)) return 'MCP 连通性测试';
  if (schema.format === 'date') return new Date().toISOString().slice(0, 10);
  if (schema.format === 'date-time') return new Date().toISOString();
  return 'test';
}

export function buildMcpToolSelfTestArguments(tool = {}) {
  return sampleSchemaValue(normalizeInputSchema(tool.inputSchema), '', 0) || {};
}

export async function testMcpConnectionTool(value = {}, toolName = '', options = {}) {
  const draft = normalizeMcpConnection(value);
  const tool = draft.tools.find((item) => item.name === String(toolName || ''));
  if (!tool) throw new TypeError('MCP 工具不存在');
  if (tool.enabled === false) throw new TypeError('请先启用该工具');
  if (tool.annotations?.readOnlyHint !== true) throw new TypeError('只读工具才能使用页内试运行');
  const bearerToken = Object.prototype.hasOwnProperty.call(options, 'bearerToken')
    ? String(options.bearerToken || '').trim()
    : (await getMcpConnectionCredential(draft.id)).bearerToken;
  const client = options.client || new RemoteMcpClient({
    endpoint: draft.endpoint,
    bearerToken,
    allowInsecureLocal: draft.allowInsecureLocal,
    protocolVersion: draft.preferredProtocolVersion || undefined,
  });
  const args = options.arguments && typeof options.arguments === 'object'
    ? options.arguments
    : buildMcpToolSelfTestArguments(tool);
  try {
    const remoteTools = await client.listTools({ signal: options.signal });
    if (!remoteTools.some((item) => String(item?.name || '') === tool.name)) {
      throw new Error('服务器已不再提供该工具，请重新测试连接');
    }
    const result = await client.callTool(tool.name, args, { signal: options.signal });
    if (result?.isError === true) throw new Error(resultToText(result, 500) || '工具返回失败');
    return { arguments: args, result, text: resultToText(result, 1000) };
  } finally {
    await client.close().catch(() => {});
  }
}

export function createStoredMcpProvider(connection, credential = {}, options = {}) {
  const row = normalizeMcpConnection(connection);
  const client = options.client || new RemoteMcpClient({
    endpoint: row.endpoint,
    bearerToken: credential.bearerToken,
    allowInsecureLocal: row.allowInsecureLocal,
    protocolVersion: row.preferredProtocolVersion || undefined,
  });
  const capabilities = row.tools.filter((tool) => tool.enabled !== false).map((tool) => {
    const risk = builtinMcpToolRisk(row.serviceTemplateId, tool.name);
    return capabilityFromMcpTool(tool, {
    serverId: row.id,
    namespace: `mcp_${safeCapabilitySegment(row.id, 'remote')}`,
    serviceTemplateId: row.serviceTemplateId,
    contexts: ['chat', 'voice', 'video', 'manual'],
    allowAutonomousUse: row.allowAutonomousUse,
    autoApproveRead: tool.autoApproveRead,
    ...(risk ? { riskOverrides: { [tool.name]: risk } } : {}),
    });
  });
  let toolCatalogReady = false;
  let consecutiveFailures = 0;
  let breakerUntil = 0;
  return {
    provider: {
      id: mcpConnectionProviderId(row.id),
      type: 'mcp',
      priority: 0,
      metadata: {
        serverId: row.id,
        label: row.name,
        endpoint: row.endpoint,
        protocolVersion: row.protocolVersion,
        serviceTemplateId: row.serviceTemplateId,
      },
      async execute(capability, args, context = {}) {
        if (Date.now() < breakerUntil) {
          throw new Error(`MCP 连接暂时停用，请在 ${Math.ceil((breakerUntil - Date.now()) / 60000)} 分钟后重试`);
        }
        const toolName = capability.source?.toolName;
        if (!toolName) throw new Error(`MCP tool mapping is missing for ${capability.id}`);
        try {
          if (!toolCatalogReady) {
            await client.listTools({ signal: context.signal });
            toolCatalogReady = true;
          }
          const result = await client.callTool(toolName, args, { signal: context.signal });
          consecutiveFailures = 0;
          breakerUntil = 0;
          return result;
        } catch (error) {
          if (context.signal?.aborted || error?.name === 'AbortError') throw error;
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) breakerUntil = Date.now() + 5 * 60 * 1000;
          throw error;
        }
      },
      close: () => client.close(),
    },
    capabilities,
    client,
  };
}

export async function loadEnabledMcpProviders(options = {}) {
  const [connections, credentials] = await Promise.all([listMcpConnections(), loadCredentialMap()]);
  return connections
    .filter((item) => item.enabled && item.tools.some((tool) => tool.enabled !== false))
    .map((item) => createStoredMcpProvider(item, credentials[item.id], options));
}
