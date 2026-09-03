import { CAPABILITY_RISKS, normalizeCapability } from './schema.js';

export const SEARCH_WEB_CAPABILITY = normalizeCapability({
  id: 'search.web',
  name: '联网搜索',
  description: '搜索公开网页中的最新信息',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 160 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  risk: CAPABILITY_RISKS.READ,
  contexts: ['chat', 'voice', 'video', 'manual'],
  rememberApproval: true,
  annotations: {
    readOnly: true,
    openWorld: true,
  },
  source: { type: 'builtin' },
});

function resultSummary(result, query) {
  const count = Array.isArray(result?.results) ? result.results.length : 0;
  return count ? `已为「${query}」找到 ${count} 条公开网页结果。` : `没有找到「${query}」的公开网页结果。`;
}

export function createBuiltinWebSearchProvider(options = {}) {
  const injectedSearch = typeof options.runSearch === 'function' ? options.runSearch : null;
  return {
    provider: {
      id: 'builtin.web-search',
      type: 'builtin',
      priority: 100,
      metadata: { label: '内置联网搜索' },
      async execute(_capability, args, context = {}) {
        const runSearch = injectedSearch || (await import('../web-search-tools.js')).runWebSearch;
        const metadata = context.metadata && typeof context.metadata === 'object' ? context.metadata : {};
        const result = await runSearch(args.query, {
          signal: context.signal,
          category: metadata.category,
          characterId: metadata.characterId,
          maxResults: metadata.maxResults,
          searchDepth: metadata.searchDepth,
          beforeProviderAttempt: metadata.beforeProviderAttempt,
        });
        return {
          content: [{ type: 'text', text: resultSummary(result, args.query) }],
          structuredContent: result,
        };
      },
    },
    capabilities: [SEARCH_WEB_CAPABILITY],
  };
}
