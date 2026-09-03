import { navigate, back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { emptyIllustration } from '../components/scrapbook-illustrations.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import {
  getChat,
  saveMemory,
  saveMessage,
  updateChatPreview,
  previewFromMessage,
} from '../core/chat-store.js';
import { getCharacter } from '../core/character-store.js';
import { getRecord, putRecord, deleteRecord } from '../core/db.js';
import { createMemory, MEMORY_TYPES } from '../models/memory.js';
import {
  MEMORY_FACT_TYPES,
  MEMORY_FACT_SCOPES,
  memoryFactDisplayTimestamp,
  splitMemoryFactContent,
} from '../models/memory-fact.js';
import { coerceUserFacingLabel, getUserDisplayName } from '../models/user.js';
import { resolveActorDisplayLabel, stripLeakedCharacterCodes } from '../core/chat/character-code-fallback.js';
import { EVENT_VISIBILITY } from '../models/event-memory.js';
import { getMemoryRegion, getMemoryIconSvg } from '../data/memory-layout.js';
import { showToast } from '../components/toast.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import { exportChatMessagesAsLongImage } from '../components/chat-long-image-export.js';
import { bindLongPress, openChatBubbleMenu } from '../components/chat-bubble-menu.js';
import {
  chatRecordItemsHtml,
  bindChatRecordInteractions,
} from '../components/chat-record-view.js';
import { captureScrollerTop, restoreScrollerTop } from '../core/scroll-state.js';
import {
  loadMemoryWorkspace,
  pickMemoriesForScope,
  chatPartnerId,
  GLOBAL_SCOPE_ID,
} from '../core/memory/memory-scope.js';
import { upsertMemoryFacts } from '../core/memory/memory-facts.js';
import { recordDeletedMemoryTombstone } from '../core/memory/memory-deletion-guard.js';
import { getCollectible, saveCollectible, deleteCollectible } from '../core/collectibles.js';
import { listOfflineDateArchives, deleteOfflineDateArchive, updateOfflineDateArchive, getOfflineDateArchive } from '../core/offline-date-archive.js';
import { primeDisplayRegex, applyDisplayRegex } from '../core/display-regex.js';
import { sanitizeNarrationOutput } from '../core/narration-sanitize.js';
import {
  deleteVectorSources,
  enqueueVectorSource,
  getMemoryVectorBacklogRuntimeState,
  getMemoryVectorIndexStats,
  listMemoryVectorIndexEntries,
  MEMORY_VECTOR_BACKLOG_EVENT,
  pruneOrphanedMemoryVectors,
  requestMemoryVectorBacklog,
  retryMemoryVectorIndexEntries,
  searchMemoryVectors,
  VECTOR_THRESHOLDS,
} from '../core/memory/memory-vectors.js';
import {
  buildMemoryCompactionCandidates,
  distillMemorySources,
  isDistilledMemory,
  restoreCompactedMemory,
  saveCompactedMemory,
} from '../core/memory/memory-compaction.js';
import {
  isEmbeddingEnabled,
  loadEmbeddingConfig,
} from '../core/embedding-tools.js';
import { markMemoryRegionSeen, rowsForMemoryRegion } from '../core/memory/memory-region-indicator.js';
import {
  listMessageFavorites,
  restoreFavoriteOriginalMessages,
} from '../core/message-favorites.js';
import { createMessage } from '../models/chat.js';
import { getNowForUser } from '../core/time-mode.js';
import { openChatCardModal } from '../components/chat-interactive-modals.js';
import { openHtmlExtensionSnapshotDialog } from '../core/html-extensions.js';

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const VECTOR_ENTRY_LABELS = Object.freeze({
  memory: '回忆',
  fact: '事实',
  event: '事件',
  worldbook: '设定',
  archive: '线下片段',
  message_passage: '聊天片段',
});

const VECTOR_STATUS_LABELS = Object.freeze({
  ready: '已收录',
  pending: '整理中',
  failed: '需重试',
  superseded: '已合并',
});

// 世界书、聊天原文和线下档案都有各自的管理入口。这里仅展示能在记忆馆直接维护的
// 回忆、事实和事件，避免后台检索索引与“这个人真实记得什么”在同一列表里混成一类。
const PERSONAL_VECTOR_NAMESPACES = Object.freeze([
  'memory',
  'fact',
  'event',
]);

const VECTOR_SOURCE_STORES = Object.freeze({
  memory: 'memories',
  fact: 'memoryFacts',
  event: 'eventMemories',
});

function formatVectorRetryTime(timestamp = 0) {
  const due = Number(timestamp || 0);
  if (!due || due <= Date.now()) return '可以立即重试';
  const minutes = Math.max(1, Math.ceil((due - Date.now()) / 60000));
  if (minutes < 60) return `约 ${minutes} 分钟后自动重试`;
  const hours = Math.ceil(minutes / 60);
  return hours < 24 ? `约 ${hours} 小时后自动重试` : '稍后自动重试';
}

function vectorFailureLabel(message = '') {
  const text = String(message || '').trim();
  if (!text) return '本次整理没有完成';
  if (/(?:timeout|timed out|超时)/i.test(text)) return '连接超时';
  if (/(?:401|unauthori|invalid.?key|api.?key)/i.test(text)) return '鉴权失败，请检查 Key';
  if (/(?:403|forbidden|permission)/i.test(text)) return '当前 Key 没有模型权限';
  if (/(?:429|rate.?limit|too many)/i.test(text)) return '请求过多，接口正在限流';
  if (/(?:failed to fetch|network|load failed|econn|socket|网络|连接失败)/i.test(text)) return '网络连接失败';
  if (/(?:model|模型).*(?:not found|不存在|invalid)/i.test(text)) return '模型名称不可用';
  const status = text.match(/(?:HTTP\s*)?(4\d\d|5\d\d)/i)?.[1];
  return status ? `接口返回 ${status}` : '向量接口返回异常';
}

function vectorEntrySource(row = {}, titles = {}) {
  const source = row.sourceRecord || {};
  const typeLabel = row.namespace === 'fact' && source.factType
    ? factTypeLabel(source.factType)
    : (VECTOR_ENTRY_LABELS[row.namespace] || row.namespace || '记忆');
  const parts = [typeLabel];
  const scopeTitle = titles[row.scopeId];
  if (scopeTitle && scopeTitle !== '未知会话') parts.push(scopeTitle);
  const timestamp = Number(row.sourceTimestamp || 0);
  if (timestamp) parts.push(formatTime(timestamp));
  return parts.join(' · ');
}

function renderVectorEntry(row = {}, {
  titles = {},
  userDisplayName = '用户',
  scopeCharacter = null,
  searchMode = false,
  embeddingReady = false,
} = {}) {
  const status = String(row.status || 'pending');
  const source = row.sourceRecord || {};
  const sourceContent = row.namespace === 'event'
    ? (source.summary || source.content)
    : source.content;
  const content = safeMemoryDisplayText(sourceContent || row.content, userDisplayName, scopeCharacter);
  const subjectLabel = row.namespace === 'fact'
    ? factPersonLabel(source, 'subject', userDisplayName, scopeCharacter)
    : '';
  const objectLabel = row.namespace === 'fact' && (source.objectName || source.objectId)
    ? factPersonLabel(source, 'object', userDisplayName, scopeCharacter)
    : '';
  const direction = subjectLabel
    ? `<div class="memory-vector-actors"><strong>${esc(subjectLabel)}</strong>${objectLabel ? ` <span aria-hidden="true">→</span> <strong>${esc(objectLabel)}</strong>` : ''}</div>`
    : '';
  const sourceKind = row.namespace === 'memory'
    ? (source.type === 'summary' ? 'summary' : 'memory')
    : (row.namespace === 'fact' ? 'fact' : (row.namespace === 'event' ? 'event' : ''));
  const manageActions = sourceKind && source.id ? actions(sourceKind, source.id) : '';
  const retryDetail = status === 'failed'
    ? `
      <div class="memory-vector-failure-detail">
        <span>${esc(vectorFailureLabel(row.error))}</span>
        <span>${esc(formatVectorRetryTime(row.nextAttemptAt))}</span>
      </div>
      <button type="button" class="memory-card-btn memory-vector-retry" data-vector-retry="${esc(row.id)}" ${embeddingReady ? '' : 'disabled'}>重新尝试</button>
    `
    : '';
  return `
    <article class="scrapbook-card memory-card memory-vector-entry is-${esc(status)}">
      <div class="memory-card-head">
        <span class="memory-card-type">${esc(vectorEntrySource(row, titles))}</span>
        <span class="memory-vector-entry-state is-${esc(status)}">${esc(VECTOR_STATUS_LABELS[status] || status)}</span>
      </div>
      ${direction}
      <div class="memory-card-body">${esc(content)}</div>
      ${searchMode ? `<div class="memory-card-evidence">匹配度 ${Math.round(Number(row.score || 0) * 100)}%</div>` : ''}
      ${retryDetail}
      ${manageActions}
    </article>
  `;
}

async function hydrateVectorEntrySources(rows = []) {
  return Promise.all((Array.isArray(rows) ? rows : []).map(async (row) => {
    const store = VECTOR_SOURCE_STORES[row?.namespace];
    const sourceId = String(row?.sourceId || '').trim();
    if (!store || !sourceId) return row;
    const sourceRecord = await getRecord(store, sourceId).catch(() => null);
    return sourceRecord ? { ...row, sourceRecord } : row;
  }));
}

function vectorStatusCardBody(vectorStats = {}, embeddingConfig = {}, runtimeState = {}) {
  const total = Math.max(0, Number(vectorStats.total || 0));
  const ready = Math.max(0, Number(vectorStats.ready || 0));
  const pending = Math.max(0, Number(vectorStats.pending || 0));
  const failed = Math.max(0, Number(vectorStats.failed || 0));
  const superseded = Math.max(0, Number(vectorStats.superseded || 0));
  const complete = Math.min(total, ready + superseded);
  const enabled = isEmbeddingEnabled(embeddingConfig);
  const phase = String(runtimeState?.phase || '');
  let statusLine = '暂无可索引内容';
  if (!enabled && (pending || failed)) statusLine = '等待启用向量模型';
  else if (phase === 'working') statusLine = '正在整理记忆';
  else if (phase === 'deferred') statusLine = '使用结束后继续整理';
  else if (pending) statusLine = `排队处理中 · 剩余 ${pending}`;
  else if (failed) statusLine = `等待重试 · ${failed} 条`;
  else if (total) statusLine = '索引已同步';
  const indexDetails = [
    vectorStats.models?.join('、'),
    vectorStats.dims?.length ? `${vectorStats.dims.join('/')} 维` : '',
  ].filter(Boolean).join(' · ');
  const progressMax = Math.max(1, total);
  return `
    <div class="memory-card-head">
      <span class="memory-card-type">索引状态</span>
      <span class="memory-card-time">${ready}/${total}</span>
    </div>
    <div class="memory-vector-status-line">${esc(statusLine)}</div>
    <progress class="memory-vector-progress" max="${progressMax}" value="${complete}" aria-label="向量记忆索引进度"></progress>
    <div class="memory-vector-counts">
      <span><b>${ready}</b> 可搜索</span>
      <span><b>${pending}</b> 整理中</span>
      <span class="${failed ? 'has-failure' : ''}"><b>${failed}</b> 需重试</span>
    </div>
    <div class="memory-vector-status-actions">
      ${failed ? `<button type="button" class="memory-card-btn memory-vector-retry-all" data-vector-retry="all" ${enabled ? '' : 'disabled'}>重试全部</button>` : ''}
      ${!enabled && (pending || failed) ? '<button type="button" class="memory-card-btn" data-open-vector-settings>检查向量设置</button>' : ''}
    </div>
    ${indexDetails || superseded ? `
      <details class="memory-vector-tech-details">
        <summary>索引详情</summary>
        <div>${indexDetails ? esc(indexDetails) : '暂无已完成索引'}${superseded ? ` · 已合并 ${superseded}` : ''}</div>
      </details>
    ` : ''}
  `;
}

const VISIBILITY_LABEL = {
  [EVENT_VISIBILITY.public]: '公开',
  [EVENT_VISIBILITY.private]: '私密',
  [EVENT_VISIBILITY.spreading]: '扩散中',
};

const KIND_EDIT = {
  summary: { store: 'memories', field: 'content', title: '编辑剧情摘要' },
  memory: { store: 'memories', field: 'content', title: '编辑回忆' },
  fact: { store: 'memoryFacts', field: 'content', title: '编辑事实内容' },
  event: { store: 'eventMemories', field: 'summary', title: '编辑事件' },
  archive: { store: 'memoryFacts', field: 'content', title: '编辑条目' },
  aboutYou: { store: 'memoryFacts', field: 'content', title: '编辑条目' },
  characterTrait: { store: 'memoryFacts', field: 'content', title: '编辑条目' },
  anonymous: { store: 'memoryFacts', field: 'content', title: '编辑条目' },
};

function narrativeToHtml(text = '', surface = 'timemachine') {
  const cleaned = applyDisplayRegex(sanitizeNarrationOutput(text), surface);
  const paras = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paras.map((p) => `<p>${esc(p)}</p>`).join('') || `<p>${esc(cleaned)}</p>`;
}

function factTypeLabel(type = '') {
  return MEMORY_FACT_TYPES[type] || type || '事实';
}

function canManualAddFact(regionKind = '') {
  return regionKind === 'aboutYou' || regionKind === 'characterTrait' || regionKind === 'archive';
}

function pickPrivateChatIdForCharacter(chats = [], characterId = '') {
  const cid = String(characterId || '').trim();
  if (!cid) return '';
  const hit = (chats || []).find((chat) => chat && chat.type !== 'group' && chatPartnerId(chat) === cid);
  return String(hit?.id || '').trim();
}

function openMemoryFactFormModal({
  title = '手动添加',
  defaultFactType = 'preference',
  typeOptions = [],
  onSave,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  host.classList.add('active');
  const options = (typeOptions || []).map((opt) => (
    `<option value="${esc(opt.value)}" ${opt.value === defaultFactType ? 'selected' : ''}>${esc(opt.label)}</option>`
  )).join('');
  host.innerHTML = `
    <div class="modal-overlay" data-memory-fact-overlay>
      <div class="modal-sheet scrapbook-card text-editor-sheet" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h3>${esc(title)}</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-memory-fact-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body">
          <label class="api-field">
            <span class="api-field-label">类型</span>
            <select class="form-input" data-memory-fact-type>${options}</select>
          </label>
          <label class="api-field">
            <span class="api-field-label">内容</span>
            <textarea class="form-input" data-memory-fact-content rows="5" placeholder="写一条偏好、习惯或印象" maxlength="8000"></textarea>
          </label>
          <label class="api-field">
            <span class="api-field-label">依据（可选）</span>
            <input type="text" class="form-input" data-memory-fact-evidence placeholder="例如：某次聊天提到" maxlength="240" />
          </label>
          <button type="button" class="btn btn-primary text-editor-save" data-memory-fact-save>写入</button>
        </div>
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-memory-fact-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-memory-fact-close]')?.addEventListener('click', close);
  host.querySelector('.text-editor-sheet')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('[data-memory-fact-save]')?.addEventListener('click', async () => {
    const factType = String(host.querySelector('[data-memory-fact-type]')?.value || '').trim();
    const content = String(host.querySelector('[data-memory-fact-content]')?.value || '').trim();
    const evidence = String(host.querySelector('[data-memory-fact-evidence]')?.value || '').trim();
    close();
    await onSave?.({ factType, content, evidence });
  });
  host.querySelector('[data-memory-fact-content]')?.focus();
}

function openVectorFactEditorModal({ fact = {}, userDisplayName = '用户', scopeCharacter = null, onSave } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const subjectLabel = factPersonLabel(fact, 'subject', userDisplayName, scopeCharacter);
  const objectLabel = factPersonLabel(fact, 'object', userDisplayName, scopeCharacter);
  const typeOptions = Object.entries(MEMORY_FACT_TYPES).map(([value, label]) => (
    `<option value="${esc(value)}" ${value === fact.factType ? 'selected' : ''}>${esc(label)}</option>`
  )).join('');
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-vector-fact-overlay>
      <div class="modal-sheet scrapbook-card text-editor-sheet" role="dialog" aria-modal="true" aria-labelledby="vector-fact-title">
        <header class="modal-header">
          <h3 id="vector-fact-title">编辑事实</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-vector-fact-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body">
          <label class="api-field">
            <span class="api-field-label">事实归属</span>
            <input type="text" class="form-input" data-vector-fact-subject value="${esc(subjectLabel)}" maxlength="80" />
          </label>
          <label class="api-field">
            <span class="api-field-label">相关对象（可空）</span>
            <input type="text" class="form-input" data-vector-fact-object value="${esc(objectLabel)}" maxlength="80" />
          </label>
          <label class="api-field">
            <span class="api-field-label">类型</span>
            <select class="form-input" data-vector-fact-type>${typeOptions}</select>
          </label>
          <label class="api-field">
            <span class="api-field-label">内容</span>
            <textarea class="form-input" data-vector-fact-content rows="5" maxlength="8000">${esc(fact.content)}</textarea>
          </label>
          <label class="api-field">
            <span class="api-field-label">依据（可选）</span>
            <input type="text" class="form-input" data-vector-fact-evidence value="${esc(fact.evidence)}" maxlength="240" />
          </label>
          <button type="button" class="btn btn-primary text-editor-save" data-vector-fact-save>保存</button>
        </div>
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  host.querySelector('[data-vector-fact-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-vector-fact-close]')?.addEventListener('click', close);
  host.querySelector('.text-editor-sheet')?.addEventListener('click', (event) => event.stopPropagation());
  host.querySelector('[data-vector-fact-save]')?.addEventListener('click', async () => {
    const subjectName = String(host.querySelector('[data-vector-fact-subject]')?.value || '').trim();
    const objectName = String(host.querySelector('[data-vector-fact-object]')?.value || '').trim();
    const factType = String(host.querySelector('[data-vector-fact-type]')?.value || '').trim();
    const content = String(host.querySelector('[data-vector-fact-content]')?.value || '').trim();
    const evidence = String(host.querySelector('[data-vector-fact-evidence]')?.value || '').trim();
    if (!subjectName || !content) {
      showToast('事实归属和内容不能为空');
      return;
    }
    close();
    await onSave?.({ subjectName, objectName, factType, content, evidence });
  });
  host.querySelector('[data-vector-fact-content]')?.focus();
}

function editedFactActorId(name = '', fact = {}, userDisplayName = '用户', scopeCharacter = null) {
  const value = String(name || '').trim();
  if (!value) return '';
  const candidates = [
    [fact.subjectName, fact.subjectId],
    [fact.subjectId, fact.subjectId],
    [fact.objectName, fact.objectId],
    [fact.objectId, fact.objectId],
    [userDisplayName, 'user'],
    [scopeCharacter?.customNickname, scopeCharacter?.id],
    [scopeCharacter?.name, scopeCharacter?.id],
  ];
  return String(candidates.find(([label]) => String(label || '').trim() === value)?.[1] || '').trim();
}

function memoryTypeLabel(type = '') {
  return MEMORY_TYPES[type] || type || '记忆';
}

function memoryCardTypeLabel(mem = {}) {
  if (isDistilledMemory(mem)) return '精简记忆';
  return ['manual-import', 'manual-shared'].includes(mem.source) ? '手动记忆' : memoryTypeLabel(mem.type);
}

function openMemoryCompactionPickerModal({ candidates = [], onGenerate } = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return;
  const rows = Array.isArray(candidates) ? candidates : [];
  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay" data-memory-compact-overlay>
      <div class="modal-sheet scrapbook-card text-editor-sheet memory-compact-sheet" role="dialog" aria-modal="true" aria-labelledby="memory-compact-title">
        <header class="modal-header">
          <h3 id="memory-compact-title">精简记忆</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-memory-compact-close aria-label="关闭">${icon('back')}</button>
        </header>
        <div class="modal-body">
          <div class="memory-compact-list">
            ${rows.map((item, index) => `
              <label class="memory-compact-option">
                <input type="checkbox" value="${index}" data-memory-compact-check />
                <span>
                  <b>${esc(item.kind)} · ${esc(formatTime(item.timestamp))}</b>
                  <span>${esc(item.content.slice(0, 110))}${item.content.length > 110 ? '…' : ''}</span>
                </span>
              </label>
            `).join('')}
          </div>
          <div class="memory-compact-controls">
            <button type="button" class="memory-card-btn" data-memory-compact-all>全选</button>
            <button type="button" class="btn btn-primary" data-memory-compact-generate disabled>生成精简稿</button>
          </div>
        </div>
      </div>
    </div>
  `;
  const close = () => {
    host.classList.remove('active');
    host.innerHTML = '';
  };
  const checks = () => [...host.querySelectorAll('[data-memory-compact-check]')];
  const selectedRows = () => checks()
    .filter((input) => input.checked)
    .map((input) => rows[Number(input.value)])
    .filter(Boolean);
  const sync = () => {
    const count = selectedRows().length;
    const button = host.querySelector('[data-memory-compact-generate]');
    if (!button) return;
    button.disabled = count < 2;
    button.textContent = count >= 2 ? `生成精简稿（${count}）` : '生成精简稿';
  };
  host.querySelector('[data-memory-compact-overlay]')?.addEventListener('click', close);
  host.querySelector('[data-memory-compact-close]')?.addEventListener('click', close);
  host.querySelector('.memory-compact-sheet')?.addEventListener('click', (event) => event.stopPropagation());
  checks().forEach((input) => input.addEventListener('change', sync));
  host.querySelector('[data-memory-compact-all]')?.addEventListener('click', () => {
    const list = checks();
    const shouldCheck = list.some((input) => !input.checked);
    list.forEach((input) => { input.checked = shouldCheck; });
    sync();
  });
  host.querySelector('[data-memory-compact-generate]')?.addEventListener('click', () => {
    const selected = selectedRows();
    if (selected.length < 2) return;
    close();
    onGenerate?.(selected);
  });
}

function safeMemoryDisplayText(text = '', userDisplayName = '用户', scopeCharacter = null) {
  const characters = scopeCharacter?.id ? { [scopeCharacter.id]: scopeCharacter } : {};
  return stripLeakedCharacterCodes(String(text || ''), {
    userName: userDisplayName,
    characters,
    fallbackLabel: '某位',
  });
}

function factPersonLabel(fact = {}, side = 'subject', userDisplayName = '用户', scopeCharacter = null) {
  const id = String(fact[`${side}Id`] || '').trim();
  const name = String(fact[`${side}Name`] || '').trim();
  if (!id && !name) return '';
  const characters = {};
  if (id && scopeCharacter?.id === id) characters[id] = scopeCharacter;
  return resolveActorDisplayLabel(coerceUserFacingLabel(name, userDisplayName) || name || id, {
    userName: userDisplayName,
    characters,
    fallback: id === 'user' ? userDisplayName : '某位',
  });
}

async function resolveChatTitles(ids) {
  const titles = {};
  await Promise.all([...new Set(ids.filter(Boolean))].map(async (chatId) => {
    const chat = await getChat(chatId);
    if (!chat) { titles[chatId] = '未知会话'; return; }
    if (chat.type === 'group') { titles[chatId] = chat.groupSettings?.name || '群聊'; return; }
    titles[chatId] = chat.metadata?.partnerName || '私聊';
  }));
  return titles;
}

function chatTag(chatId, titles) {
  if (!chatId) return '<div class="memory-card-chat">跨会话</div>';
  return `<div class="memory-card-chat" data-chat-id="${esc(chatId)}">${esc(titles[chatId] || '会话')}</div>`;
}

function actions(kind, id) {
  return `
    <div class="memory-card-actions">
      <button type="button" class="memory-card-btn" data-edit-kind="${esc(kind)}" data-edit-id="${esc(id)}">编辑</button>
      <button type="button" class="memory-card-btn is-danger" data-del-store="${esc(KIND_EDIT[kind].store)}" data-del-id="${esc(id)}">删除</button>
    </div>`;
}

function memoryActions(mem = {}, kind = 'memory') {
  if (!isDistilledMemory(mem)) return actions(kind, mem.id);
  return `
    <div class="memory-card-actions">
      <button type="button" class="memory-card-btn" data-edit-kind="${esc(kind)}" data-edit-id="${esc(mem.id)}">编辑</button>
      <button type="button" class="memory-card-btn" data-memory-compact-restore="${esc(mem.id)}">撤销精简</button>
    </div>`;
}

async function buildCollectibleMap(memories = []) {
  const ids = [...new Set(memories.map((mem) => String(mem.collectibleId || '').trim()).filter(Boolean))];
  const entries = await Promise.all(ids.map(async (id) => [id, await getCollectible(id).catch(() => null)]));
  return new Map(entries.filter(([, item]) => item));
}

function renderCollectibleCards(list, kind) {
  return list.slice()
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .map((item) => {
      const fullText = String(item.body || '').trim();
      const fragments = Array.isArray(item.albumFragments) ? item.albumFragments.filter(Boolean) : [];
      const expandable = !!(fullText || fragments.length);
      return `
      <article class="scrapbook-card memory-card${expandable ? ' is-clickable is-expandable' : ''}"${expandable ? ' data-expand' : ''}>
        <div class="memory-card-head">
          <span class="memory-card-type">时光机</span>
          <span class="memory-card-time">${esc(formatTime(item.timestamp))}</span>
        </div>
        ${item.image ? `<img class="memory-card-image" src="${esc(item.image)}" alt="">` : ''}
        <div class="memory-card-body">
          <strong>${esc(item.title || '一段过往')}</strong>
          ${item.summary ? `<div>${esc(item.summary)}</div>` : ''}
        </div>
        ${expandable ? `
          <div class="memory-card-full" hidden>
            ${fullText ? `<div class="memory-card-fulltext">${narrativeToHtml(fullText, 'timemachine')}</div>` : ''}
            ${fragments.length ? `<div class="memory-card-fragments">${fragments.map((f) => `<span>${esc(f)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="memory-card-expand-hint">点击展开 · 看原文卡片</div>
        ` : ''}
        <div class="memory-card-actions">
          <button type="button" class="memory-card-btn" data-edit-kind="fragment" data-edit-id="${esc(item.id)}">编辑</button>
          <button type="button" class="memory-card-btn is-danger" data-del-store="collectibles" data-del-id="${esc(item.id)}">删除</button>
        </div>
      </article>
    `;
    }).join('');
}

function renderMemoryCards(list, kind, titles, collectibleMap = new Map(), userDisplayName = '用户', scopeCharacter = null) {
  return list.slice()
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .map((mem) => {
      const collectible = collectibleMap.get(String(mem.collectibleId || '').trim());
      const archiveId = String(mem.offlineDateArchiveId || '').trim();
      const collectibleBody = String(collectible?.body || '').trim();
      const expandable = !archiveId && !!collectibleBody;
      const attr = archiveId
        ? ` data-open-archive="${esc(archiveId)}"`
        : (expandable ? ' data-expand' : '');
      const clickable = archiveId || expandable;
      return `
        <article class="scrapbook-card memory-card${clickable ? ' is-clickable' : ''}${expandable ? ' is-expandable' : ''}"${attr}>
          <div class="memory-card-head">
            <span class="memory-card-type">${esc(memoryCardTypeLabel(mem))}</span>
            <span class="memory-card-time">${esc(formatTime(mem.timestamp))}</span>
          </div>
          ${chatTag(mem.chatId, titles)}
          ${mem.archiveTitle ? `<div class="memory-card-chat">${esc(mem.archiveTitle)}</div>` : ''}
          ${collectible?.image ? `<img class="memory-card-image" src="${esc(collectible.image)}" alt="">` : ''}
          <div class="memory-card-body">${esc(safeMemoryDisplayText(mem.content, userDisplayName, scopeCharacter))}</div>
          ${expandable ? `
            <div class="memory-card-full" hidden>
              <div class="memory-card-fulltext">${narrativeToHtml(collectibleBody, 'timemachine')}</div>
            </div>
            <div class="memory-card-expand-hint">点击展开 · 看原文卡片</div>
          ` : ''}
          ${archiveId ? '<div class="memory-card-evidence">点击查看完整约会档案</div>' : ''}
          ${memoryActions(mem, kind)}
        </article>
      `;
    }).join('');
}

function renderArchiveCards(list) {
  return list.slice()
    .sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0))
    .map((archive) => {
      const rounds = Array.isArray(archive.rounds)
        ? archive.rounds.filter((r) => r.role === 'narration').length
        : 0;
      return `
        <article class="scrapbook-card memory-card is-clickable" data-open-archive="${esc(archive.id)}">
          <div class="memory-card-head">
            <span class="memory-card-type">线下约会</span>
            <span class="memory-card-time">${esc(formatTime(archive.endedAt || archive.startedAt))}</span>
          </div>
          <div class="memory-card-chat">${esc(archive.title || '一次线下相处')}</div>
          <div class="memory-card-body">${esc(archive.summary || '点击查看完整约会档案')}</div>
          <div class="memory-card-evidence">${rounds ? `共 ${rounds} 段 · ` : ''}点击查看完整约会档案</div>
          <div class="memory-card-actions">
            <button type="button" class="memory-card-btn" data-edit-kind="offlineArchive" data-edit-id="${esc(archive.id)}">编辑</button>
            <button type="button" class="memory-card-btn is-danger" data-del-store="offlineArchive" data-del-id="${esc(archive.id)}">删除</button>
          </div>
        </article>
      `;
    }).join('');
}

function renderFactCards(list, kind, titles, userDisplayName, scopeCharacter = null) {
  return list.slice()
    .sort((a, b) => memoryFactDisplayTimestamp(b) - memoryFactDisplayTimestamp(a))
    .map((fact) => {
      const subjectLabel = factPersonLabel(fact, 'subject', userDisplayName, scopeCharacter);
      const objectLabel = fact.objectName || fact.objectId
        ? factPersonLabel(fact, 'object', userDisplayName, scopeCharacter)
        : '';
      const fullContent = safeMemoryDisplayText(fact.content, userDisplayName, scopeCharacter);
      const previewParts = splitMemoryFactContent(fullContent, 180);
      const expandable = previewParts.length > 1;
      const previewContent = expandable ? `${previewParts[0]}…` : fullContent;
      return `
      <article class="scrapbook-card memory-card${expandable ? ' is-clickable is-expandable' : ''}"${expandable ? ' data-expand' : ''}>
        <div class="memory-card-head">
          <span class="memory-card-type">${esc(factTypeLabel(fact.factType))}</span>
          <span class="memory-card-time">${esc(formatTime(memoryFactDisplayTimestamp(fact)))}</span>
        </div>
        ${chatTag(fact.chatId || fact.sourceChatId, titles)}
        <div class="memory-card-body">
          <strong>${esc(subjectLabel || '相关人物')}</strong>${objectLabel ? ` → ${esc(objectLabel)}` : ''}
          <div>${esc(previewContent)}</div>
          ${fact.evidence ? `<div class="memory-card-evidence">依据：${esc(safeMemoryDisplayText(fact.evidence, userDisplayName, scopeCharacter))}</div>` : ''}
        </div>
        ${expandable ? `
          <div class="memory-card-full" hidden>
            <div class="memory-card-fulltext"><p>${esc(fullContent)}</p></div>
          </div>
          <div class="memory-card-expand-hint">点击展开 · 查看完整事实</div>
        ` : ''}
        ${actions(kind, fact.id)}
      </article>
    `;
    }).join('');
}

function renderEventCards(list, titles, userDisplayName = '用户', scopeCharacter = null) {
  return list.slice()
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .map((event) => {
      const chats = (event.involvedChats || []).map((id) => titles[id] || id).filter(Boolean);
      return `
        <article class="scrapbook-card memory-card">
          <div class="memory-card-head">
            <span class="memory-card-type">${esc(VISIBILITY_LABEL[event.visibility] || '事件')}</span>
            <span class="memory-card-time">${esc(formatTime(event.timestamp))}</span>
          </div>
          <div class="memory-card-chat">${esc(chats.join('、') || '跨会话')}</div>
          <div class="memory-card-body">${esc(safeMemoryDisplayText(event.summary, userDisplayName, scopeCharacter))}</div>
          ${event.highlight ? `<div class="memory-card-evidence">名场面：${esc(safeMemoryDisplayText(event.highlight, userDisplayName, scopeCharacter))}</div>` : ''}
          ${actions('event', event.id)}
        </article>
      `;
    }).join('');
}

function renderFavoriteCards(list = [], options = {}) {
  return list.map((item, favoriteIndex) => {
    const messages = Array.isArray(item.messages) ? item.messages : [];
    const preview = chatRecordItemsHtml(messages, {
      currentUserId: options.currentUserId,
      currentUserName: options.currentUserName,
      resolveDisplayName: (id) => (
        id === options.scopeCharacter?.id
          ? (options.scopeCharacter.customNickname || options.scopeCharacter.name)
          : ''
      ),
      limit: 12,
    }) || `<div class="memory-favorite-empty">${esc(item.body || '一段收藏')}</div>`;
    const hidden = Math.max(0, messages.length - 12);
    return `
      <article class="scrapbook-card memory-card memory-favorite-card" data-favorite-index="${favoriteIndex}">
        <div class="memory-card-head">
          <span class="memory-card-type">${item.source === 'offline_favorite' ? '线下收藏' : '聊天收藏'}</span>
          <span class="memory-card-time">${esc(formatTime(item.timestamp))}</span>
        </div>
        <div class="memory-card-body">
          <strong>${esc(item.title || '一段收藏')}</strong>
          ${item.albumNote || item.summary ? `<div class="memory-favorite-note">${esc(item.albumNote || item.summary)}</div>` : ''}
        </div>
        <div class="memory-favorite-dialogue chat-record-list">${preview}${hidden ? `<div class="memory-card-evidence">另有 ${hidden} 条</div>` : ''}</div>
        <div class="memory-card-actions">
          <button type="button" class="memory-card-btn" data-favorite-share="${favoriteIndex}">分享给 TA</button>
          <button type="button" class="memory-card-btn" data-favorite-card="${favoriteIndex}">保存小卡片</button>
          <button type="button" class="memory-card-btn" data-favorite-note="${favoriteIndex}">备注</button>
          <button type="button" class="memory-card-btn is-danger" data-favorite-delete="${favoriteIndex}">删除</button>
        </div>
      </article>`;
  }).join('');
}

function favoriteRowAt(list = [], value = '') {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) return null;
  return (Array.isArray(list) ? list : [])[index] || null;
}

export default async function render(container, params = {}) {
  const scopeId = String(params.character || '').trim();
  const region = getMemoryRegion(params.region);
  if (!region || !scopeId) {
    navigate('memory', {}, true);
    return;
  }
  const user = await ensureDefaultUser();
  const userDisplayName = getUserDisplayName(user);
  await primeDisplayRegex();
  let vectorQuery = '';
  let vectorFilter = 'all';
  let vectorStatusRefreshTimer = 0;
  let pageDisposed = false;
  let vectorScopeChatIds = [];

  const vectorScopeOptions = () => ({
    userId: user.id,
    characterIds: scopeId === GLOBAL_SCOPE_ID ? [] : [scopeId],
    scopeIds: scopeId === GLOBAL_SCOPE_ID ? [] : vectorScopeChatIds,
    namespaces: PERSONAL_VECTOR_NAMESPACES,
    strictCharacterScope: true,
  });

  async function retryVectorEntries(button) {
    if (!button || button.disabled) return;
    const target = String(button.dataset.vectorRetry || '').trim();
    button.disabled = true;
    try {
      const result = await retryMemoryVectorIndexEntries({
        ...vectorScopeOptions(),
        ids: target && target !== 'all' ? [target] : [],
      });
      const count = Number(result?.retried || 0);
      showToast(count ? `已将 ${count} 条记忆放回整理队列` : '没有需要重试的记忆');
      await paint();
    } catch (error) {
      button.disabled = false;
      showToast(error?.message || '重新尝试失败');
    }
  }

  function bindVectorStatusActions(root = container) {
    root.querySelectorAll('[data-vector-retry]').forEach((button) => {
      button.addEventListener('click', () => retryVectorEntries(button));
    });
    root.querySelectorAll('[data-open-vector-settings]').forEach((button) => {
      button.addEventListener('click', () => navigate('settings/api'));
    });
  }

  async function refreshVectorStatus() {
    if (pageDisposed || region.kind !== 'vector') return;
    const card = container.querySelector('[data-vector-status-card]');
    if (!card) return;
    const [vectorStats, embeddingConfig] = await Promise.all([
      getMemoryVectorIndexStats({
        ...vectorScopeOptions(),
      }).catch(() => ({
        total: 0, ready: 0, pending: 0, failed: 0, superseded: 0, models: [], dims: [],
      })),
      loadEmbeddingConfig().catch(() => ({})),
    ]);
    if (pageDisposed || !card.isConnected) return;
    card.innerHTML = vectorStatusCardBody(
      vectorStats,
      embeddingConfig,
      getMemoryVectorBacklogRuntimeState(),
    );
    bindVectorStatusActions(card);
  }

  function scheduleVectorStatusRefresh() {
    if (pageDisposed || vectorStatusRefreshTimer || typeof window === 'undefined') return;
    vectorStatusRefreshTimer = window.setTimeout(() => {
      vectorStatusRefreshTimer = 0;
      refreshVectorStatus().catch(() => {});
    }, 180);
  }

  async function paint() {
    const ws = await loadMemoryWorkspace(user.id);
    vectorScopeChatIds = scopeId === GLOBAL_SCOPE_ID
      ? []
      : ws.chats
        .filter((chat) => (
          chatPartnerId(chat) === scopeId
          || (Array.isArray(chat?.participants) && chat.participants.map(String).includes(scopeId))
        ))
        .map((chat) => String(chat.id || '').trim())
        .filter(Boolean);
    const scopeCharacter = scopeId !== GLOBAL_SCOPE_ID
      ? await getCharacter(scopeId).catch(() => null)
      : null;
    const picked = pickMemoriesForScope(ws, scopeId);
    markMemoryRegionSeen(user.id, scopeId, region.id, rowsForMemoryRegion(picked, region.id));
    const collectibleMap = await buildCollectibleMap([...picked.summaries, ...picked.shared]);
    const compactionCandidates = buildMemoryCompactionCandidates({
      summaries: picked.summaries,
      events: picked.events,
    });
    const titles = await resolveChatTitles([
      ...ws.memories.map((m) => m.chatId),
      ...ws.facts.map((f) => f.chatId || f.sourceChatId),
      ...ws.events.flatMap((e) => (Array.isArray(e.involvedChats) ? e.involvedChats : [])),
    ]);

    let body = '';
    let favoriteRows = [];
    if (region.kind === 'summary') body = renderMemoryCards(picked.summaries, 'summary', titles, collectibleMap, userDisplayName, scopeCharacter);
    else if (region.kind === 'memory') body = renderMemoryCards(picked.shared, 'memory', titles, collectibleMap, userDisplayName, scopeCharacter);
    else if (region.kind === 'fragment') body = renderCollectibleCards(picked.timeMachineFragments || [], 'fragment');
    else if (region.kind === 'aboutYou' || region.kind === 'archive') body = renderFactCards(picked.aboutYou || picked.archive || [], 'aboutYou', titles, userDisplayName, scopeCharacter);
    else if (region.kind === 'characterTrait') body = renderFactCards(picked.characterTraits || [], 'characterTrait', titles, userDisplayName, scopeCharacter);
    else if (region.kind === 'anonymous') body = renderFactCards(picked.anonymous || [], 'anonymous', titles, userDisplayName, scopeCharacter);
    else if (region.kind === 'offlineArchive') {
      const archives = scopeId === GLOBAL_SCOPE_ID
        ? []
        : await listOfflineDateArchives(user.id, { characterId: scopeId }).catch(() => []);
      body = renderArchiveCards(archives);
    }
    else if (region.kind === 'fact') body = renderFactCards(picked.facts || [], 'fact', titles, userDisplayName, scopeCharacter);
    else if (region.kind === 'event') body = renderEventCards(picked.events, titles, userDisplayName, scopeCharacter);
    else if (region.kind === 'favorite') {
      favoriteRows = await listMessageFavorites(user.id, scopeId).catch(() => []);
      favoriteRows = (await Promise.all(
        favoriteRows.map((item) => restoreFavoriteOriginalMessages(item)),
      )).filter(Boolean);
      body = renderFavoriteCards(favoriteRows, {
        currentUserId: user.id,
        currentUserName: userDisplayName,
        scopeCharacter,
      });
    }
    else if (region.kind === 'vector') {
      // 先清掉旧版删除源记忆后遗留的派生向量，避免显示成无法管理的孤儿卡片。
      await pruneOrphanedMemoryVectors({
        userId: user.id,
        namespaces: PERSONAL_VECTOR_NAMESPACES,
      }).catch(() => 0);
      const [vectorStats, embeddingConfig] = await Promise.all([
        getMemoryVectorIndexStats({
          ...vectorScopeOptions(),
        }).catch(() => ({
          total: 0, ready: 0, pending: 0, failed: 0, superseded: 0, models: [], dims: [],
        })),
        loadEmbeddingConfig().catch(() => ({})),
      ]);
      const embeddingReady = isEmbeddingEnabled(embeddingConfig);
      const indexRows = vectorQuery
        ? await searchMemoryVectors(vectorQuery, {
          ...vectorScopeOptions(),
          limit: 40,
          threshold: VECTOR_THRESHOLDS.memorySearch,
        }).catch(() => [])
        : await listMemoryVectorIndexEntries({
          ...vectorScopeOptions(),
          statuses: vectorFilter === 'all' ? ['ready', 'pending', 'failed'] : [vectorFilter],
          limit: 40,
        }).catch(() => []);
      const rows = await hydrateVectorEntrySources(indexRows);
      Object.assign(titles, await resolveChatTitles(rows.map((row) => row.scopeId)));
      const filterOptions = [
        ['all', '全部', vectorStats.ready + vectorStats.pending + vectorStats.failed],
        ['ready', '可搜索', vectorStats.ready],
        ['pending', '整理中', vectorStats.pending],
        ['failed', '需重试', vectorStats.failed],
      ];
      const listTitle = vectorQuery
        ? '搜索结果'
        : ({ ready: '可搜索内容', pending: '等待整理', failed: '需要重试' }[vectorFilter] || '最近收录');
      body = `
        <article class="scrapbook-card memory-card memory-vector-status-card" data-vector-status-card aria-live="polite">
          ${vectorStatusCardBody(
            vectorStats,
            embeddingConfig,
            getMemoryVectorBacklogRuntimeState(),
          )}
        </article>
        <form class="memory-vector-search" data-vector-search>
          <input class="form-input" data-vector-query value="${esc(vectorQuery)}" placeholder="描述想找的记忆" autocomplete="off" />
          <button type="submit" class="btn btn-primary btn-sm">搜索</button>
          ${vectorQuery ? '<button type="button" class="btn btn-outline btn-sm" data-vector-clear>清除</button>' : ''}
        </form>
        ${vectorQuery ? '' : `
          <nav class="memory-vector-filters" aria-label="索引状态筛选">
            ${filterOptions.map(([value, label, count]) => `
              <button type="button" data-vector-filter="${value}" aria-pressed="${vectorFilter === value}">
                ${label}<span>${Number(count || 0)}</span>
              </button>
            `).join('')}
          </nav>
        `}
        <div class="memory-vector-list-head">
          <span>${esc(listTitle)}</span>
          <span>${rows.length ? `显示 ${rows.length} 条` : ''}</span>
        </div>
        ${!rows.length ? `<div class="memory-region-placeholder">${vectorQuery ? '没有找到相关片段' : (vectorFilter === 'failed' ? '当前没有失败的记忆' : '这里还没有可显示的内容')}</div>` : ''}
        <div class="memory-vector-entry-list">
          ${rows.map((row) => renderVectorEntry(row, {
            titles,
            userDisplayName,
            scopeCharacter,
            searchMode: !!vectorQuery,
            embeddingReady,
          })).join('')}
        </div>
      `;
    }

    const content = body || `
      <div class="chat-empty scrapbook-empty">
        ${emptyIllustration('memory')}
        <div class="chat-empty-text">这里还空空的</div>
        <div class="chat-empty-hint">${esc(region.hint)}</div>
      </div>`;

    const prevScroll = captureScrollerTop(container, '.memory-region-scroll');
    container.className = 'page memory-hall';
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${esc(region.name)}</h1>
        ${((region.kind === 'summary' || canManualAddFact(region.kind)) && scopeId !== GLOBAL_SCOPE_ID) || region.kind === 'memory'
    ? `<button type="button" class="navbar-btn" data-add-memory aria-label="新增记忆">${icon('plus')}</button>`
    : '<span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>'}
      </header>
      <main class="memory-region-scroll">
        <div class="memory-region-head">
          <span class="mri">${getMemoryIconSvg(region.icon)}</span>
          <span class="mrt"><b>${esc(region.name)}</b><span>${esc(region.hint)}</span></span>
        </div>
        ${(region.kind === 'summary' || region.kind === 'event') && compactionCandidates.length >= 2
    ? '<div class="memory-compact-toolbar"><button type="button" class="btn btn-primary btn-sm" data-memory-compact>精简记忆</button></div>'
    : ''}
        ${content}
      </main>
    `;
    restoreScrollerTop(container, '.memory-region-scroll', prevScroll);

    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('[data-vector-search]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      vectorQuery = String(container.querySelector('[data-vector-query]')?.value || '').trim();
      await paint();
    });
    container.querySelector('[data-vector-clear]')?.addEventListener('click', async () => {
      vectorQuery = '';
      await paint();
    });
    container.querySelectorAll('[data-vector-filter]').forEach((button) => {
      button.addEventListener('click', async () => {
        vectorFilter = String(button.dataset.vectorFilter || 'all');
        await paint();
      });
    });
    if (region.kind === 'vector') bindVectorStatusActions(container);
    container.querySelector('[data-add-memory]')?.addEventListener('click', () => {
      if (region.kind === 'memory') {
        openTextEditorModal({
          title: '写入共同回忆',
          placeholder: '写下你们共同经历、彼此记得的一件事',
          confirmLabel: '写入',
          onSave: async (content) => {
            if (!content) {
              showToast('内容不能为空');
              return;
            }
            try {
              const chatId = scopeId === GLOBAL_SCOPE_ID
                ? ''
                : pickPrivateChatIdForCharacter(ws.chats, scopeId);
              await saveMemory(createMemory({
                userId: user.id,
                chatId,
                characterId: scopeId === GLOBAL_SCOPE_ID ? '' : scopeId,
                type: 'event',
                category: 'shared',
                content,
                source: 'manual-shared',
                importance: 'high',
              }));
              showToast('已写入共同回忆');
              await paint();
            } catch (_) {
              showToast('写入失败');
            }
          },
        });
        return;
      }
      if (canManualAddFact(region.kind)) {
        const aboutYou = region.kind === 'aboutYou' || region.kind === 'archive';
        openMemoryFactFormModal({
          title: aboutYou ? '添加与你有关' : '添加偏好/习惯',
          defaultFactType: aboutYou ? 'relationship_impression' : 'preference',
          typeOptions: aboutYou
            ? [
              { value: 'relationship_impression', label: '关系印象' },
              { value: 'preference', label: '偏好/习惯' },
            ]
            : [
              { value: 'preference', label: '偏好/习惯' },
              { value: 'relationship_impression', label: '关系印象' },
              { value: 'boundary', label: '边界' },
              { value: 'topic_affinity', label: '话题倾向' },
            ],
          onSave: async ({ factType, content, evidence }) => {
            if (!content) {
              showToast('内容不能为空');
              return;
            }
            const chatId = pickPrivateChatIdForCharacter(ws.chats, scopeId);
            if (!chatId) {
              showToast('请先与 TA 建立私聊后再写入');
              return;
            }
            const charName = String(scopeCharacter?.customNickname || scopeCharacter?.name || '').trim();
            try {
              const saved = await upsertMemoryFacts({
                userId: user.id,
                chatId,
                sourceChatId: chatId,
                scope: MEMORY_FACT_SCOPES.normal_chat,
                factType: factType || (aboutYou ? 'relationship_impression' : 'preference'),
                content,
                evidence: evidence || '手动添加',
                confidence: 1,
                subjectId: aboutYou ? 'user' : scopeId,
                subjectName: aboutYou ? userDisplayName : charName,
                objectId: aboutYou ? scopeId : 'user',
                objectName: aboutYou ? charName : userDisplayName,
                knownBy: { [scopeId]: true, user: true },
                tags: ['manual'],
                temporalState: 'evergreen',
              });
              if (!saved.length) {
                showToast('写入失败');
                return;
              }
              showToast(saved.length > 1 ? `已拆分写入 ${saved.length} 条` : '已写入');
              await paint();
            } catch (_) {
              showToast('写入失败');
            }
          },
        });
        return;
      }
      openTextEditorModal({
        title: '写入一段记忆',
        placeholder: '粘贴或写下已经发生的剧情、关系变化与重要细节',
        confirmLabel: '写入',
        onSave: async (content) => {
          if (!content) {
            showToast('内容不能为空');
            return;
          }
          try {
            await saveMemory(createMemory({
              userId: user.id,
              characterId: scopeId === GLOBAL_SCOPE_ID ? '' : scopeId,
              type: 'summary',
              content,
              source: 'manual-import',
              importance: 'high',
            }));
            showToast('已写入剧情长卷');
            await paint();
          } catch (err) {
            showToast('写入失败');
          }
        },
      });
    });
    container.querySelector('[data-memory-compact]')?.addEventListener('click', () => {
      openMemoryCompactionPickerModal({
        candidates: compactionCandidates,
        onGenerate: async (selected) => {
          showToast('正在生成精简稿…');
          try {
            const content = await distillMemorySources(selected, {
              leaseId: `${user.id}:${scopeId}`,
            });
            openTextEditorModal({
              title: '确认精简记忆',
              value: content,
              placeholder: '检查并修改需要长期保留的内容',
              confirmLabel: '确认精简',
              onSave: async (next) => {
                if (!next) {
                  showToast('内容不能为空');
                  return;
                }
                try {
                  await saveCompactedMemory({
                    userId: user.id,
                    characterId: scopeId === GLOBAL_SCOPE_ID ? '' : scopeId,
                    content: next,
                    sourceRefs: selected.map((item) => ({ store: item.store, id: item.id })),
                  });
                  showToast(`已精简 ${selected.length} 条，原记录已归档`);
                  await paint();
                } catch (error) {
                  showToast(error?.message || '保存失败');
                }
              },
            });
          } catch (error) {
            showToast(error?.message || '生成失败');
          }
        },
      });
    });
    container.querySelectorAll('[data-memory-compact-restore]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const id = button.getAttribute('data-memory-compact-restore');
        if (!id || !window.confirm('撤销这次精简并恢复原记录？')) return;
        try {
          const result = await restoreCompactedMemory(id, user.id);
          showToast(`已恢复 ${result.restored} 条原记录`);
          await paint();
        } catch (error) {
          showToast(error?.message || '恢复失败');
        }
      });
    });
    container.querySelectorAll('[data-chat-id]').forEach((tag) => {
      tag.addEventListener('click', (e) => {
        e.stopPropagation();
        const chatId = tag.getAttribute('data-chat-id');
        if (chatId) navigate('chat/thread', { chatId });
      });
    });
    container.querySelectorAll('[data-open-archive]').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-edit-id], [data-del-id]')) return;
        const id = card.getAttribute('data-open-archive');
        if (id) navigate('offline/archive', { id });
      });
    });
    container.querySelectorAll('[data-expand]').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-edit-id], [data-del-id], a, button')) return;
        const full = card.querySelector('.memory-card-full');
        const hint = card.querySelector('.memory-card-expand-hint');
        if (!full) return;
        const open = full.hasAttribute('hidden');
        if (open) full.removeAttribute('hidden'); else full.setAttribute('hidden', '');
        card.classList.toggle('is-open', open);
        if (hint) hint.textContent = open ? '点击收起' : '点击展开 · 看原文卡片';
      });
    });
    const saveFavoriteCard = async (item) => {
      if (!item) {
        showToast('收藏不存在');
        return;
      }
      const rows = Array.isArray(item.messages) ? item.messages : [];
      if (!rows.length) {
        showToast('这条收藏没有可生成的记录');
        return;
      }
      try {
        await exportChatMessagesAsLongImage({
          messages: rows,
          title: item.title || '收藏回顾',
          subtitle: item.albumNote || item.summary || '',
          isGroup: new Set(rows.map((row) => row.senderId).filter((id) => id && id !== 'user')).size > 1,
          currentUserName: userDisplayName,
          currentUserAvatar: user.avatar,
          currentUserId: user.id,
          appearance: item.appearance || {},
          resolveSenderName: async (message) => (
            message.senderName
            || (message.senderId === scopeId
              ? (scopeCharacter?.customNickname || scopeCharacter?.name)
              : '')
            || 'TA'
          ),
          filenameBase: `${item.title || '收藏'}-小卡片`,
        });
        showToast('小卡片已保存');
      } catch (err) {
        showToast(err?.message || '保存失败');
      }
    };
    container.querySelectorAll('.memory-favorite-card').forEach((card) => {
      const item = favoriteRowAt(favoriteRows, card.getAttribute('data-favorite-index'));
      const target = card.querySelector('.memory-favorite-dialogue');
      if (!target) return;
      bindChatRecordInteractions(target, item?.messages || [], {
        onOpenCard: (message) => {
          if (message?.type === 'htmlWidget') {
            const snapshot = message.metadata?.htmlExtension;
            if (snapshot) openHtmlExtensionSnapshotDialog(snapshot);
            else showToast('这张小卡片缺少原内容');
            return;
          }
          openChatCardModal(message, {
            currentUserId: user.id,
            resolveDisplayName: (id) => (
              id === scopeCharacter?.id
                ? (scopeCharacter.customNickname || scopeCharacter.name)
                : ''
            ),
          });
        },
        onVoiceSnapshotUpdate: async (updated, index) => {
          if (!item) return;
          item.messages = (item.messages || []).map((message, rowIndex) => (
            rowIndex === index
              ? { ...updated, metadata: { ...(updated.metadata || {}) } }
              : message
          ));
          await saveCollectible(item);
        },
      });
      bindLongPress(target, ({ x, y }) => {
        openChatBubbleMenu({
          x,
          y,
          actions: [{
            label: '保存小卡片',
            onClick: async () => {
              await saveFavoriteCard(item);
            },
          }],
        });
      }, 560);
    });
    container.querySelectorAll('[data-favorite-share]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = favoriteRowAt(favoriteRows, btn.getAttribute('data-favorite-share'));
        if (!item) {
          showToast('收藏不存在');
          return;
        }
        const chatId = pickPrivateChatIdForCharacter(ws.chats, scopeId);
        if (!chatId) {
          showToast('请先与 TA 建立私聊');
          return;
        }
        const destChat = await getChat(chatId).catch(() => null);
        if (!destChat) {
          showToast('聊天窗口不存在');
          return;
        }
        const ts = await getNowForUser(user.id);
        const bundleItems = (Array.isArray(item.messages) ? item.messages : []).map((message) => ({
          ...message,
          metadata: { ...(message.metadata || {}) },
        }));
        const bundle = createMessage({
          chatId,
          senderId: 'user',
          senderName: userDisplayName,
          type: 'chatBundle',
          content: `[收藏回顾] ${item.title || '一段对话'}`,
          timestamp: ts,
          metadata: {
            bundleTitle: item.title || '收藏回顾',
            bundleSummary: item.albumNote || item.summary || `${bundleItems.length} 条记录`,
            bundleItems,
            favoriteId: item.id,
            source: 'memory-favorite',
          },
        });
        await saveMessage(bundle);
        await updateChatPreview(chatId, previewFromMessage(bundle), ts);
        showToast('已分享给 TA');
        navigate('chat/thread', { chatId });
      });
    });
    container.querySelectorAll('[data-favorite-card]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = favoriteRowAt(favoriteRows, btn.getAttribute('data-favorite-card'));
        await saveFavoriteCard(item);
      });
    });
    container.querySelectorAll('[data-favorite-note]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = favoriteRowAt(favoriteRows, btn.getAttribute('data-favorite-note'));
        if (!item) return;
        openTextEditorModal({
          title: '收藏备注',
          value: item.albumNote || item.summary || '',
          placeholder: '写下为什么收藏（可不填）',
          confirmLabel: '保存',
          onSave: async (note) => {
            await saveCollectible({ ...item, albumNote: note, summary: note, updatedAt: Date.now() });
            showToast('备注已保存');
            await paint();
          },
        });
      });
    });
    container.querySelectorAll('[data-favorite-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = favoriteRowAt(favoriteRows, btn.getAttribute('data-favorite-delete'));
        if (!item || item.id == null || item.id === '') {
          showToast('收藏不存在');
          return;
        }
        if (!window.confirm('删除这条收藏？')) return;
        await deleteCollectible(item.id);
        showToast('已删除');
        await paint();
      });
    });
    container.querySelectorAll('[data-del-id]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const store = btn.getAttribute('data-del-store');
        const id = btn.getAttribute('data-del-id');
        if (!store || !id) return;
        if (!window.confirm('删除这条记忆？此操作不可撤销。')) return;
        try {
          if (store === 'offlineArchive') {
            await deleteOfflineDateArchive(user.id, id);
          } else if (store === 'collectibles') {
            await deleteCollectible(id);
            await deleteRecord('memories', `mem_clt_${id}`).catch(() => {});
            await deleteVectorSources('memory', [`mem_clt_${id}`]).catch(() => {});
          } else {
            if (['memories', 'memoryFacts', 'eventMemories'].includes(store)) {
              const deletedRow = await getRecord(store, id).catch(() => null);
              if (deletedRow) {
                await recordDeletedMemoryTombstone(store, {
                  ...deletedRow,
                  userId: deletedRow.userId || user.id,
                  ...(scopeId !== GLOBAL_SCOPE_ID && !deletedRow.characterId
                    ? { characterId: scopeId }
                    : {}),
                });
              }
            }
            await deleteRecord(store, id);
            const namespace = store === 'memories'
              ? 'memory'
              : (store === 'memoryFacts' ? 'fact' : (store === 'eventMemories' ? 'event' : ''));
            if (namespace) await deleteVectorSources(namespace, [id]).catch(() => {});
          }
          showToast('已删除');
          await paint();
        } catch (err) {
          showToast('删除失败');
        }
      });
    });
    container.querySelectorAll('[data-edit-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const kind = btn.getAttribute('data-edit-kind');
        const id = btn.getAttribute('data-edit-id');
        if (!kind || !id) return;

        if (kind === 'offlineArchive') {
          getOfflineDateArchive(user.id, id).then((archive) => {
            if (!archive) { showToast('条目不存在'); return; }
            openTextEditorModal({
              title: '编辑线下约会摘要',
              value: String(archive.summary || ''),
              placeholder: '写下这次线下相处的摘要',
              onSave: async (next) => {
                if (!next) { showToast('内容不能为空'); return; }
                try {
                  await updateOfflineDateArchive(user.id, id, { summary: next });
                  showToast('已保存');
                  await paint();
                } catch (err) {
                  showToast('保存失败');
                }
              },
            });
          });
          return;
        }

        if (kind === 'fragment') {
          getCollectible(id).then((rec) => {
            if (!rec) { showToast('条目不存在'); return; }
            openTextEditorModal({
              title: '编辑时光机条目',
              value: String(rec.summary || rec.body || rec.title || ''),
              placeholder: '写下内容',
              onSave: async (next) => {
                if (!next) { showToast('内容不能为空'); return; }
                try {
                  await saveCollectible({
                    ...rec,
                    summary: next,
                    updatedAt: Date.now(),
                  });
                  showToast('已保存');
                  await paint();
                } catch (err) {
                  showToast('保存失败');
                }
              },
            });
          });
          return;
        }

        if (kind === 'fact') {
          getRecord('memoryFacts', id).then((rec) => {
            if (!rec) { showToast('条目不存在'); return; }
            openVectorFactEditorModal({
              fact: rec,
              userDisplayName,
              scopeCharacter,
              onSave: async ({ subjectName, objectName, factType, content, evidence }) => {
                const updated = {
                  ...rec,
                  subjectId: editedFactActorId(subjectName, rec, userDisplayName, scopeCharacter),
                  subjectName,
                  objectId: editedFactActorId(objectName, rec, userDisplayName, scopeCharacter),
                  objectName,
                  factType: factType || rec.factType,
                  content,
                  evidence,
                  updatedAt: Date.now(),
                };
                try {
                  await putRecord('memoryFacts', updated);
                  await enqueueVectorSource('fact', updated).catch(() => null);
                  showToast('已保存并重新整理索引');
                  await paint();
                } catch (error) {
                  showToast('保存失败');
                }
              },
            });
          });
          return;
        }

        const cfg = KIND_EDIT[kind];
        if (!cfg) return;
        getRecord(cfg.store, id).then((rec) => {
          if (!rec) { showToast('条目不存在'); return; }
          openTextEditorModal({
            title: cfg.title,
            value: String(rec[cfg.field] || ''),
            placeholder: '写下内容',
            onSave: async (next) => {
              if (!next) { showToast('内容不能为空'); return; }
              const updated = { ...rec, [cfg.field]: next };
              if ('updatedAt' in rec) updated.updatedAt = Date.now();
              try {
                await putRecord(cfg.store, updated);
                if (cfg.store === 'memories') {
                  await enqueueVectorSource('memory', updated).catch(() => null);
                } else if (cfg.store === 'memoryFacts') {
                  await enqueueVectorSource('fact', updated).catch(() => null);
                } else if (cfg.store === 'eventMemories') {
                  await enqueueVectorSource('event', updated).catch(() => null);
                }
                showToast('已保存');
                await paint();
              } catch (err) {
                showToast('保存失败');
              }
            },
          });
        });
      });
    });
  }

  await paint();
  if (region.kind === 'vector' && typeof window !== 'undefined') {
    const onVectorBacklogChanged = () => scheduleVectorStatusRefresh();
    const onRouteDisposed = (event) => {
      if (event?.detail?.container !== container) return;
      pageDisposed = true;
      if (vectorStatusRefreshTimer) window.clearTimeout(vectorStatusRefreshTimer);
      vectorStatusRefreshTimer = 0;
      window.removeEventListener(MEMORY_VECTOR_BACKLOG_EVENT, onVectorBacklogChanged);
      window.removeEventListener('marshmallow-route-disposed', onRouteDisposed);
    };
    window.addEventListener(MEMORY_VECTOR_BACKLOG_EVENT, onVectorBacklogChanged);
    window.addEventListener('marshmallow-route-disposed', onRouteDisposed);
    requestMemoryVectorBacklog('memory-page-open');
  }
}
