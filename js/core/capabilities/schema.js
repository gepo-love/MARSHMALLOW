export const CAPABILITY_RISKS = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  TRANSACTION: 'transaction',
  DEVICE: 'device',
});

export const CAPABILITY_CONTEXTS = Object.freeze([
  'chat',
  'voice',
  'video',
  'background',
  'manual',
]);

const RISK_SET = new Set(Object.values(CAPABILITY_RISKS));
const CONTEXT_SET = new Set(CAPABILITY_CONTEXTS);
// JSON Schema adds several wrapper objects (properties/items/anyOf) for each
// actual argument level. Sixteen generic object levels rejects otherwise
// reasonable commerce schemas, while this higher bound still prevents an
// untrusted MCP catalog from causing unbounded recursive work.
const MAX_CAPABILITY_SCHEMA_DEPTH = 64;

function compactText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function stableHash(value = '') {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function safeCapabilitySegment(value = '', fallback = 'tool') {
  const raw = String(value || '').trim().toLowerCase();
  const ascii = raw
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (ascii && ascii === raw) return ascii;
  return `${ascii || fallback}_${stableHash(raw).slice(0, 7)}`;
}

export function assertCapabilityId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) {
    throw new TypeError(`Invalid capability id: ${String(value || '')}`);
  }
  return id;
}

function sanitizeSchemaNode(value, state, depth = 0) {
  if (depth > MAX_CAPABILITY_SCHEMA_DEPTH) throw new TypeError('Capability schema is too deeply nested');
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 8000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeSchemaNode(item, state, depth + 1));
  }
  if (typeof value !== 'object') return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    state.keys += 1;
    if (state.keys > 600) throw new TypeError('Capability schema contains too many fields');
    const clean = sanitizeSchemaNode(item, state, depth + 1);
    if (clean !== undefined) out[String(key).slice(0, 120)] = clean;
  }
  return out;
}

export function normalizeInputSchema(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { type: 'object', properties: {} };
  const clean = sanitizeSchemaNode(source, { keys: 0 });
  if (!clean.type) clean.type = 'object';
  if (clean.type === 'object' && !clean.properties) clean.properties = {};
  return clean;
}

function sanitizeArgumentNode(value, depth = 0) {
  if (depth > 20) throw new TypeError('Capability arguments are too deeply nested');
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Capability arguments contain a non-finite number');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new TypeError('Capability argument array is too large');
    return value.map((item) => sanitizeArgumentNode(item, depth + 1));
  }
  if (typeof value !== 'object') throw new TypeError('Capability arguments contain an unsupported value');
  const out = {};
  const entries = Object.entries(value);
  if (entries.length > 500) throw new TypeError('Capability arguments contain too many fields');
  for (const [key, item] of entries) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    out[String(key).slice(0, 160)] = sanitizeArgumentNode(item, depth + 1);
  }
  return out;
}

function valueMatchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateArgumentNode(value, schema, path = '$', depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 20) return;
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (allowedTypes.length && !allowedTypes.some((type) => valueMatchesType(value, type))) {
    throw new TypeError(`${path} does not match the capability schema type`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    throw new TypeError(`${path} is not an allowed capability argument value`);
  }
  if (typeof value === 'string') {
    if (Number.isFinite(Number(schema.minLength)) && value.length < Number(schema.minLength)) {
      throw new TypeError(`${path} is shorter than the capability schema allows`);
    }
    if (Number.isFinite(Number(schema.maxLength)) && value.length > Number(schema.maxLength)) {
      throw new TypeError(`${path} is longer than the capability schema allows`);
    }
  }
  if (typeof value === 'number') {
    if (Number.isFinite(Number(schema.minimum)) && value < Number(schema.minimum)) {
      throw new TypeError(`${path} is below the capability schema minimum`);
    }
    if (Number.isFinite(Number(schema.maximum)) && value > Number(schema.maximum)) {
      throw new TypeError(`${path} is above the capability schema maximum`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateArgumentNode(item, schema.items, `${path}[${index}]`, depth + 1));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new TypeError(`${path}.${key} is required by the capability schema`);
      }
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) validateArgumentNode(item, properties[key], `${path}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) {
        throw new TypeError(`${path}.${key} is not allowed by the capability schema`);
      }
    }
  }
}

export function normalizeCapabilityArguments(value, inputSchema = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Capability arguments must be an object');
  }
  const clean = sanitizeArgumentNode(value);
  validateArgumentNode(clean, inputSchema || { type: 'object' });
  return clean;
}

function normalizeContexts(value) {
  const list = Array.isArray(value) && value.length ? value : CAPABILITY_CONTEXTS;
  const clean = [...new Set(list.map((item) => String(item || '').trim()).filter((item) => CONTEXT_SET.has(item)))];
  return clean.length ? clean : ['manual'];
}

export function normalizeCapability(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Capability definition must be an object');
  }
  const risk = String(value.risk || CAPABILITY_RISKS.READ).trim();
  if (!RISK_SET.has(risk)) throw new TypeError(`Unsupported capability risk: ${risk}`);
  const id = assertCapabilityId(value.id);
  const name = compactText(value.name || id, 100);
  const description = compactText(value.description, 1200);
  const source = value.source && typeof value.source === 'object' ? value.source : {};
  return Object.freeze({
    id,
    name,
    description,
    inputSchema: normalizeInputSchema(value.inputSchema),
    outputSchema: value.outputSchema ? normalizeInputSchema(value.outputSchema) : null,
    risk,
    contexts: Object.freeze(normalizeContexts(value.contexts)),
    requiresForeground: value.requiresForeground === true
      || risk === CAPABILITY_RISKS.TRANSACTION
      || risk === CAPABILITY_RISKS.DEVICE,
    rememberApproval: risk === CAPABILITY_RISKS.READ && value.rememberApproval !== false,
    allowAutonomousUse: value.allowAutonomousUse === true,
    autoApproveRead: risk === CAPABILITY_RISKS.READ && value.autoApproveRead === true,
    annotations: Object.freeze({
      readOnly: value.annotations?.readOnly === true || risk === CAPABILITY_RISKS.READ,
      destructive: value.annotations?.destructive === true,
      idempotent: value.annotations?.idempotent === true,
      openWorld: value.annotations?.openWorld === true,
    }),
    source: Object.freeze({
      type: compactText(source.type || 'builtin', 30),
      serverId: compactText(source.serverId, 100),
      toolName: compactText(source.toolName, 180),
      serviceTemplateId: compactText(source.serviceTemplateId, 40),
    }),
  });
}

export function capabilityFromMcpTool(tool = {}, options = {}) {
  const serverId = String(options.serverId || 'remote').trim();
  const toolName = String(tool.name || '').trim();
  if (!toolName) throw new TypeError('MCP tool is missing a name');
  const override = options.riskOverrides?.[toolName];
  let risk = RISK_SET.has(override) ? override : CAPABILITY_RISKS.WRITE;
  if (!override && tool.annotations?.readOnlyHint === true) risk = CAPABILITY_RISKS.READ;
  if (!override && tool.annotations?.destructiveHint === true) risk = CAPABILITY_RISKS.WRITE;
  const namespace = safeCapabilitySegment(options.namespace || `mcp_${serverId}`, 'mcp');
  return normalizeCapability({
    id: `${namespace}.${safeCapabilitySegment(toolName)}`,
    name: tool.title || toolName,
    description: tool.description || '',
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    risk,
    contexts: options.contexts,
    requiresForeground: options.requiresForeground,
    rememberApproval: options.rememberApproval,
    allowAutonomousUse: options.allowAutonomousUse,
    autoApproveRead: options.autoApproveRead === true || tool.autoApproveRead === true,
    annotations: {
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true,
      idempotent: tool.annotations?.idempotentHint === true,
      openWorld: tool.annotations?.openWorldHint === true,
    },
    source: {
      type: 'mcp',
      serverId,
      toolName,
      serviceTemplateId: options.serviceTemplateId,
    },
  });
}

export function resultToText(result, maxChars = 24000) {
  if (typeof result === 'string') return result.slice(0, maxChars);
  const content = Array.isArray(result?.content) ? result.content : [];
  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') parts.push(item);
    else if (item?.type === 'text') parts.push(String(item.text || ''));
    else if (item?.type === 'resource') parts.push(String(item.resource?.text || item.resource?.uri || ''));
    else if (item?.type === 'resource_link') parts.push(String(item.uri || ''));
    else if (item?.type === 'image') parts.push(`[image:${String(item.mimeType || 'unknown')}]`);
    else if (item?.type === 'audio') parts.push(`[audio:${String(item.mimeType || 'unknown')}]`);
  }
  if (!parts.length && result?.structuredContent != null) {
    try { parts.push(JSON.stringify(result.structuredContent)); } catch (_) {}
  }
  if (!parts.length && typeof result?.text === 'string') parts.push(result.text);
  if (!parts.length && result != null) {
    try { parts.push(JSON.stringify(result)); } catch (_) { parts.push(String(result)); }
  }
  const text = parts.join('\n').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[工具结果已截断]`;
}
