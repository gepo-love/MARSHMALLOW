/**
 * 「心声状态栏」：点击头像弹出，展示角色心声 / 当前状态 + 情绪波动值。
 * 支持「往期」分页回顾；当前与往期均可手动编辑修改。
 *
 * 外观支持两套出厂骨架（奶油手账 / ins 小白卡）+ 弹出位置 + 自定义 CSS + 文案替换，
 * 具体取值来自会话详情页「心声样式」，见 core/chat/inner-voice-style.js。
 */
import {
  loadChatCharState,
  loadChatCharStateHistory,
  canReadLegacyUnscopedChatState,
  filterChatCharStateForUser,
  paginateCharStateHistory,
  deleteCharStateHistoryEntry,
  clearCharStateForCharacter,
  updateChatCharCurrentState,
  updateCharStateHistoryEntry,
  clampMoodValue,
  sanitizeInnerVoiceText,
  sanitizeIntentText,
  sanitizeMoodText,
  sanitizeStatusText,
  sanitizeCustomStateFields,
} from '../core/chat/character-state.js';
import { normalizeInnerVoiceCard, resolveInnerVoiceLabel } from '../core/chat/inner-voice-style.js';
import { applyDisplayRegex } from '../core/display-regex.js';
import { handleTranslationToggleClick, messageLikelyNeedsTranslation, sanitizeAiTranslation } from '../core/translation-utils.js';
import { showToast } from './toast.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value = '') {
  return esc(value);
}

function displayText(value = '') {
  return applyDisplayRegex(String(value ?? ''), 'chat');
}

function clamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function formatHistoryTime(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime()) || !ts) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${m}/${day} ${hh}:${mm}`;
}

function moodBarHtml(moodValue, labels) {
  const value = clamp(moodValue);
  return `
    <div class="char-state-mood-row">
      <span class="char-state-row-label char-state-mood-label">${esc(resolveInnerVoiceLabel(labels, 'fieldMoodBar'))}</span>
      <span class="char-state-mood-track"><span class="char-state-mood-fill" style="width:${value}%;"></span></span>
      <span class="char-state-mood-value">${value}</span>
    </div>`;
}

function valueWithTranslationHtml(val, translation = '') {
  if (!val) return '—';
  const plain = esc(displayText(val));
  const raw = String(translation || '').trim();
  const sanitized = sanitizeAiTranslation(val, raw);
  if (!sanitized && !raw && !messageLikelyNeedsTranslation(val)) return plain;
  // sanitize 已剥性能标签；无效译文回退时也尽量别把 <> 裸露出去
  const show = sanitized || String(raw).replace(/<[^<>\n]{0,48}>/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return `${plain}<button type="button" class="chat-bubble-translate-btn char-state-translate-btn" data-translation-toggle data-translation-source="${escAttr(val)}" aria-expanded="false">翻译</button><div class="chat-bubble-translation" hidden><div class="chat-bubble-translation-divider"></div><div class="chat-bubble-translation-text">${esc(displayText(show))}</div></div>`;
}

function rowHtml(key, val, translation = '') {
  // 即使模型漏了 innerZh，也要为明显的外语心声保留“翻译”入口，
  // 让点击时的工具翻译兜底有机会运行。
  const valueHtml = val ? valueWithTranslationHtml(val, translation) : '—';
  return `
    <div class="char-state-row">
      <span class="char-state-row-label">${esc(key)}</span>
      <span class="char-state-row-value">${valueHtml}</span>
    </div>`;
}

function customRowsHtml(custom = {}, fallbackInner = '') {
  const rows = Object.entries(sanitizeCustomStateFields(custom));
  if (!rows.length && String(fallbackInner || '').trim()) {
    return `
      <div class="char-state-row char-state-custom-row char-state-custom-row-fallback" data-state-key="inner">
        <span class="char-state-row-label">心声</span>
        <span class="char-state-row-value">${esc(displayText(fallbackInner))}</span>
      </div>`;
  }
  return rows.map(([key, value]) => `
    <div class="char-state-row char-state-custom-row" data-state-key="${escAttr(key)}">
      <span class="char-state-row-label">${esc(key)}</span>
      <span class="char-state-row-value">${esc(displayText(value))}</span>
    </div>`).join('');
}

export function renderInnerVoiceBodyTemplate(templateHtml = '', snapshot = {}) {
  const template = String(templateHtml || '').trim();
  if (!template) return '';
  const replacements = {
    name: esc(snapshot.name || ''),
    inner: esc(displayText(snapshot.inner || '')),
    intent: esc(displayText(snapshot.intent || '')),
    status: esc(displayText(snapshot.status || '')),
    moodValue: String(clamp(snapshot.moodValue)),
    customRows: customRowsHtml(snapshot.custom, snapshot.inner),
  };
  return template.replace(/\{\{(name|inner|intent|status|moodValue|customRows)\}\}/g, (_, key) => replacements[key] || '');
}

/** Collapsed by default: the intent is a spoiler-ish peek, revealed on tap */
function intentRowHtml(key, val) {
  if (!val) return '';
  return `
    <div class="char-state-row char-state-intent-row">
      <span class="char-state-row-label">${esc(key)}</span>
      <span class="char-state-row-value"><button type="button" class="chat-bubble-translate-btn char-state-translate-btn" data-intent-toggle aria-expanded="false">查看</button><div class="chat-bubble-translation" hidden><div class="chat-bubble-translation-text">${esc(displayText(val))}</div></div></span>
    </div>`;
}

function historyActionsHtml(item, options = {}) {
  const buttons = [];
  if (options.editable !== false) {
    buttons.push(`<button type="button" class="char-state-edit-btn" data-edit-entry="${escAttr(item.id)}">编辑</button>`);
  }
  if (options.deletable !== false) {
    buttons.push(`<button type="button" class="char-state-del-btn" data-del-entry="${escAttr(item.id)}">删除</button>`);
  }
  if (!buttons.length) return '';
  return `<span class="char-state-history-actions">${buttons.join('')}</span>`;
}

function historyCardHtml(item, labels, options = {}) {
  const time = formatHistoryTime(item.recordedAt);
  const customBody = options.templateHtml
    ? `<div class="char-state-custom-template">${renderInnerVoiceBodyTemplate(options.templateHtml, item)}</div>`
    : '';
  return `
    <article class="char-state-history-card" data-state-entry-id="${escAttr(item.id)}">
      <div class="char-state-history-head">
        <span class="char-state-history-time">${esc(time || '未知时间')}</span>
        ${historyActionsHtml(item, options)}
      </div>
      ${customBody || `
        ${rowHtml(resolveInnerVoiceLabel(labels, 'fieldInner'), item.inner, item.innerTranslation)}
        ${intentRowHtml(resolveInnerVoiceLabel(labels, 'fieldIntent'), item.intent)}
        ${item.mood ? rowHtml(resolveInnerVoiceLabel(labels, 'fieldMood'), item.mood) : ''}
        ${item.status ? rowHtml(resolveInnerVoiceLabel(labels, 'fieldStatus'), item.status) : ''}
        ${customRowsHtml(item.custom)}
        ${moodBarHtml(item.moodValue, labels)}`}
    </article>`;
}

function editFormHtml(snapshot, labels, { title = '编辑心声' } = {}) {
  const moodValue = clamp(snapshot.moodValue);
  const showMood = Boolean(String(snapshot.mood || '').trim());
  return `
    <form class="char-state-edit-form" data-char-state-edit-form>
      <div class="char-state-edit-title">${esc(title)}</div>
      <label class="char-state-edit-field">
        <span class="char-state-edit-label">${esc(resolveInnerVoiceLabel(labels, 'fieldInner'))}</span>
        <textarea class="form-input char-state-edit-input" name="inner" rows="4">${esc(snapshot.inner || '')}</textarea>
      </label>
      <label class="char-state-edit-field">
        <span class="char-state-edit-label">译文</span>
        <textarea class="form-input char-state-edit-input" name="innerTranslation" rows="2" placeholder="外语心声时可填">${esc(snapshot.innerTranslation || '')}</textarea>
      </label>
      <label class="char-state-edit-field">
        <span class="char-state-edit-label">${esc(resolveInnerVoiceLabel(labels, 'fieldIntent'))}</span>
        <textarea class="form-input char-state-edit-input" name="intent" rows="3">${esc(snapshot.intent || '')}</textarea>
      </label>
      ${showMood ? `
      <label class="char-state-edit-field">
        <span class="char-state-edit-label">${esc(resolveInnerVoiceLabel(labels, 'fieldMood'))}</span>
        <input class="form-input char-state-edit-input" type="text" name="mood" value="${escAttr(snapshot.mood || '')}" />
      </label>` : ''}
      <label class="char-state-edit-field">
        <span class="char-state-edit-label">${esc(resolveInnerVoiceLabel(labels, 'fieldStatus'))}</span>
        <input class="form-input char-state-edit-input" type="text" name="status" value="${escAttr(snapshot.status || '')}" />
      </label>
      <label class="char-state-edit-field">
        <span class="char-state-edit-label">${esc(resolveInnerVoiceLabel(labels, 'fieldMoodBar'))}</span>
        <input class="form-input char-state-edit-input" type="number" name="moodValue" min="0" max="100" step="1" value="${moodValue}" />
      </label>
      <div class="char-state-edit-actions">
        <button type="button" class="char-state-edit-cancel" data-edit-cancel>取消</button>
        <button type="submit" class="char-state-edit-save">保存</button>
      </div>
    </form>`;
}

function readEditForm(form) {
  if (!form) return null;
  const get = (name) => String(form.elements?.namedItem?.(name)?.value || '').trim();
  const moodEl = form.elements?.namedItem?.('mood');
  const inner = sanitizeInnerVoiceText(get('inner'));
  return {
    inner,
    innerTranslation: inner ? sanitizeAiTranslation(inner, get('innerTranslation')) : '',
    intent: sanitizeIntentText(get('intent')),
    ...(moodEl ? { mood: sanitizeMoodText(get('mood')) } : {}),
    status: sanitizeStatusText(get('status')),
    moodValue: clampMoodValue(get('moodValue')),
  };
}

function avatarBlockHtml(name, avatarUrl) {
  const initial = esc(String(name || '').trim().slice(0, 1) || '·');
  const url = String(avatarUrl || '').trim();
  const inner = url
    ? `<img src="${escAttr(url)}" alt="" decoding="async" />`
    : `<span class="char-state-avatar-fallback">${initial}</span>`;
  return `<span class="char-state-avatar">${inner}</span>`;
}

function injectCustomCss(css) {
  const id = 'char-state-popover-custom-css';
  document.getElementById(id)?.remove();
  const text = String(css || '').trim();
  if (!text) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = text;
  document.head.appendChild(style);
}

function clearCustomCss() {
  document.getElementById('char-state-popover-custom-css')?.remove();
}

export function closeCharStatePopover() {
  document.getElementById('char-state-popover')?.remove();
  clearCustomCss();
}

export function openCharStatePopover(data = {}) {
  const name = String(data.name || '对方').trim() || '对方';
  let inner = String(data.inner || '').trim();
  let innerTranslation = String(data.innerTranslation || '').trim();
  let intent = String(data.intent || '').trim();
  let status = String(data.status || '').trim();
  let mood = String(data.mood || '').trim();
  let moodValue = clamp(data.moodValue);
  let custom = sanitizeCustomStateFields(data.custom);
  let currentLoading = data.loading === true;
  const chatId = String(data.chatId || '').trim();
  const characterId = String(data.characterId || '').trim();
  const userId = String(data.userId || '').trim();
  const avatarUrl = String(data.avatarUrl || '').trim();
  const card = normalizeInnerVoiceCard(data.card);
  const labels = card.labels;
  let suppliedHistory = Array.isArray(data.historyItems) ? data.historyItems.slice() : null;
  const onSaveCurrent = typeof data.onSaveCurrent === 'function' ? data.onSaveCurrent : null;
  const onSaveHistory = typeof data.onSaveHistory === 'function' ? data.onSaveHistory : null;
  const onDeleteHistory = typeof data.onDeleteHistory === 'function' ? data.onDeleteHistory : null;
  const canPersistCurrent = Boolean(onSaveCurrent || (chatId && characterId && !suppliedHistory));
  const canPersistHistory = Boolean(onSaveHistory || (chatId && characterId && !suppliedHistory));
  const historyEditable = data.historyEditable === true
    || (data.historyEditable !== false && canPersistHistory);
  const historyDeletable = data.historyDeletable === true
    || (data.historyDeletable !== false && !suppliedHistory && !!chatId && !!characterId && !onDeleteHistory)
    || (data.historyDeletable !== false && !!onDeleteHistory);
  // 兼容旧调用：显式 historyReadOnly 仍关闭往期改删
  const historyReadOnly = data.historyReadOnly === true;
  const allowHistoryEdit = !historyReadOnly && historyEditable;
  const allowHistoryDelete = !historyReadOnly && historyDeletable;
  const allowCurrentEdit = data.currentEditable !== false && canPersistCurrent;

  closeCharStatePopover();
  injectCustomCss(card.css);

  const wrap = document.createElement('div');
  wrap.id = 'char-state-popover';
  wrap.className = `csp-pos-${card.position} csp-skin-${card.template}`;

  let activeTab = 'current';
  let historyPage = 1;
  const PAGE_SIZE = 5;
  let editing = null; // { mode: 'current' | 'history', entryId?: string }

  const isIns = card.template === 'ins';
  const titleSuffix = resolveInnerVoiceLabel(labels, 'titleSuffix');
  const tabCurrent = resolveInnerVoiceLabel(labels, 'tabCurrent');
  const tabHistory = resolveInnerVoiceLabel(labels, 'tabHistory');
  const closeButton = resolveInnerVoiceLabel(labels, 'closeButton');

  wrap.innerHTML = `
    <div class="char-state-card csp-${card.template}" role="dialog" aria-label="${escAttr(name)}${titleSuffix ? ` ${titleSuffix}` : ''}">
      <div class="char-state-header">
        ${isIns ? avatarBlockHtml(name, avatarUrl) : ''}
        <span class="char-state-header-title">${esc(name)}${titleSuffix ? ` · ${esc(titleSuffix)}` : ''}</span>
        ${isIns ? '<button type="button" class="char-state-close-x" data-close aria-label="关闭">×</button>' : ''}
      </div>
      ${isIns ? '<div class="char-state-divider"></div>' : ''}
      <div class="char-state-tabs">
        <button type="button" class="char-state-tab is-active" data-tab="current">${esc(tabCurrent)}</button>
        <button type="button" class="char-state-tab" data-tab="history">${esc(tabHistory)}</button>
      </div>
      <div class="char-state-popover-body"></div>
      ${!isIns ? `<button type="button" class="char-state-close-btn" data-close>${esc(closeButton)}</button>` : ''}
    </div>`;

  const body = wrap.querySelector('.char-state-popover-body');
  const tabButtons = wrap.querySelectorAll('[data-tab]');

  function setActiveTabButton() {
    tabButtons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-tab') === activeTab);
    });
  }

  function applyLocalSnapshot(snapshot = {}) {
    inner = String(snapshot.inner || '').trim();
    innerTranslation = String(snapshot.innerTranslation || '').trim();
    intent = String(snapshot.intent || '').trim();
    status = String(snapshot.status || '').trim();
    mood = String(snapshot.mood || '').trim();
    moodValue = clamp(snapshot.moodValue);
    custom = sanitizeCustomStateFields(snapshot.custom);
  }

  function currentSnapshot() {
    return { name, inner, innerTranslation, intent, mood, status, moodValue, custom };
  }

  function renderCurrentPanel() {
    if (currentLoading) {
      body.innerHTML = '<div class="char-state-empty-hint">加载中…</div>';
      return;
    }
    if (card.templateHtml) {
      body.innerHTML = `
        ${allowCurrentEdit ? `
          <div class="char-state-current-actions">
            <button type="button" class="char-state-edit-btn" data-edit-current>编辑</button>
          </div>` : ''}
        <div class="char-state-custom-template">${renderInnerVoiceBodyTemplate(card.templateHtml, currentSnapshot())}</div>`;
      return;
    }
    body.innerHTML = `
      ${allowCurrentEdit ? `
        <div class="char-state-current-actions">
          <button type="button" class="char-state-edit-btn" data-edit-current>编辑</button>
        </div>` : ''}
      ${rowHtml(resolveInnerVoiceLabel(labels, 'fieldInner'), inner, innerTranslation)}
      ${intentRowHtml(resolveInnerVoiceLabel(labels, 'fieldIntent'), intent)}
      ${mood ? rowHtml(resolveInnerVoiceLabel(labels, 'fieldMood'), mood) : ''}
      ${rowHtml(resolveInnerVoiceLabel(labels, 'fieldStatus'), status)}
      ${customRowsHtml(custom)}
      ${moodBarHtml(moodValue, labels)}`;
  }

  function clearAllButtonHtml() {
    if (historyReadOnly || suppliedHistory || !chatId || !characterId) return '';
    return `<button type="button" class="char-state-clear-all-btn" data-clear-all>清空该角色全部心声</button>`;
  }

  async function loadHistoryList() {
    if (suppliedHistory) return suppliedHistory;
    if (!chatId || !characterId) return [];
    return loadChatCharStateHistory(chatId, characterId, { userId });
  }

  async function renderHistoryPanel() {
    if (!suppliedHistory && (!chatId || !characterId)) {
      body.innerHTML = '<div class="char-state-empty-hint">暂无往期记录</div>';
      return;
    }
    body.innerHTML = '<div class="char-state-empty-hint">加载中…</div>';
    const all = await loadHistoryList();
    const pageData = paginateCharStateHistory(all, historyPage, PAGE_SIZE);
    historyPage = pageData.page;
    if (!pageData.total) {
      body.innerHTML = `<div class="char-state-empty-hint">还没有往期心声</div>${clearAllButtonHtml()}`;
      return;
    }
    const cards = pageData.items.map((item) => historyCardHtml(item, labels, {
      editable: allowHistoryEdit,
      deletable: allowHistoryDelete,
      templateHtml: card.templateHtml,
    })).join('');
    const pager = pageData.totalPages > 1
      ? `
        <div class="char-state-pager">
          <button type="button" class="char-state-pager-btn" data-history-prev ${pageData.page <= 1 ? 'disabled' : ''}>上一页</button>
          <span class="char-state-pager-count">${pageData.page} / ${pageData.totalPages}</span>
          <button type="button" class="char-state-pager-btn" data-history-next ${pageData.page >= pageData.totalPages ? 'disabled' : ''}>下一页</button>
        </div>`
      : `<div class="char-state-pager-total">共 ${pageData.total} 条</div>`;
    body.innerHTML = `${cards}${pager}${clearAllButtonHtml()}`;
  }

  function renderEditPanel() {
    if (!editing) return;
    if (editing.mode === 'current') {
      body.innerHTML = editFormHtml(currentSnapshot(), labels, { title: '编辑当前心声' });
      body.querySelector('[name="inner"]')?.focus();
      return;
    }
    const item = editing.item || {};
    body.innerHTML = editFormHtml(item, labels, { title: '编辑往期心声' });
    body.querySelector('[name="inner"]')?.focus();
  }

  async function renderPanel() {
    setActiveTabButton();
    if (editing) {
      renderEditPanel();
      return;
    }
    if (activeTab === 'history') {
      await renderHistoryPanel();
      return;
    }
    renderCurrentPanel();
  }

  async function persistCurrent(patch) {
    if (onSaveCurrent) {
      const saved = await onSaveCurrent(patch);
      return saved && typeof saved === 'object' ? { ...currentSnapshot(), ...patch, ...saved } : { ...currentSnapshot(), ...patch };
    }
    const saved = await updateChatCharCurrentState(chatId, characterId, patch);
    return saved || { ...currentSnapshot(), ...patch };
  }

  async function persistHistory(entryId, patch) {
    if (onSaveHistory) {
      const saved = await onSaveHistory(entryId, patch);
      return saved && typeof saved === 'object' ? saved : { id: entryId, ...patch };
    }
    return updateCharStateHistoryEntry(chatId, characterId, entryId, patch);
  }

  async function persistDeleteHistory(entryId) {
    if (onDeleteHistory) return onDeleteHistory(entryId);
    return deleteCharStateHistoryEntry(chatId, characterId, entryId);
  }

  wrap.addEventListener('click', async (e) => {
    if (e.target.closest('[data-char-state-edit-form]')) {
      if (e.target.closest('[data-edit-cancel]')) {
        e.preventDefault();
        editing = null;
        await renderPanel();
      }
      return;
    }
    const intentBtn = e.target.closest('[data-intent-toggle]');
    if (intentBtn && wrap.contains(intentBtn)) {
      e.preventDefault();
      e.stopPropagation();
      const panel = intentBtn.nextElementSibling;
      const expanded = intentBtn.getAttribute('aria-expanded') === 'true';
      if (panel) panel.hidden = expanded;
      intentBtn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      intentBtn.textContent = expanded ? '查看' : '收起';
      return;
    }
    const translateBtn = e.target.closest('[data-translation-toggle]');
    if (translateBtn && wrap.contains(translateBtn)) {
      e.preventDefault();
      e.stopPropagation();
      const sourceText = String(translateBtn.getAttribute('data-translation-source') || inner || '').trim();
      const translationText = String(translateBtn.nextElementSibling?.querySelector('.chat-bubble-translation-text')?.textContent || innerTranslation || '').trim();
      handleTranslationToggleClick(translateBtn, {
        sourceText,
        translationText,
        languageHint: String(data.languageHint || '').trim(),
        onRepaired: async (repaired) => {
          const historyEntryId = String(
            translateBtn.closest('[data-state-entry-id]')?.getAttribute('data-state-entry-id') || '',
          ).trim();
          if (historyEntryId) {
            await persistHistory(historyEntryId, { innerTranslation: repaired });
          } else {
            innerTranslation = repaired;
            await persistCurrent({ innerTranslation: repaired });
          }
        },
      }).then((ok) => {
        if (!ok) showToast('翻译暂时不可用，请稍后再试');
      }).catch(() => showToast('翻译暂时不可用，请稍后再试'));
      return;
    }
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      if (editing) return;
      activeTab = String(tabBtn.getAttribute('data-tab') || 'current');
      if (activeTab === 'history') historyPage = 1;
      await renderPanel();
      return;
    }
    if (e.target.closest('[data-edit-current]')) {
      if (!allowCurrentEdit) return;
      editing = { mode: 'current' };
      await renderPanel();
      return;
    }
    const editBtn = e.target.closest('[data-edit-entry]');
    if (editBtn) {
      const entryId = String(editBtn.getAttribute('data-edit-entry') || '');
      if (!entryId || !allowHistoryEdit) return;
      const all = await loadHistoryList();
      const item = all.find((row) => row && String(row.id || '') === entryId);
      if (!item) {
        showToast('找不到这条心声');
        return;
      }
      editing = { mode: 'history', entryId, item: { ...item } };
      await renderPanel();
      return;
    }
    const delBtn = e.target.closest('[data-del-entry]');
    if (delBtn) {
      const entryId = String(delBtn.getAttribute('data-del-entry') || '');
      if (!entryId || !allowHistoryDelete) return;
      if (!window.confirm('删除这条心声记录？')) return;
      const ok = await persistDeleteHistory(entryId).catch(() => false);
      if (ok && suppliedHistory) {
        suppliedHistory = suppliedHistory.filter((row) => row && String(row.id || '') !== entryId);
      }
      showToast(ok ? '已删除' : '删除失败');
      await renderHistoryPanel();
      return;
    }
    if (e.target.closest('[data-clear-all]')) {
      if (!chatId || !characterId || suppliedHistory) return;
      if (!window.confirm('清空该角色在本会话的全部心声（含往期）？')) return;
      const ok = await clearCharStateForCharacter(chatId, characterId, { userId }).catch(() => false);
      showToast(ok ? '已清空心声' : '清空失败');
      close();
      return;
    }
    if (e.target.closest('[data-history-prev]') && historyPage > 1) {
      historyPage -= 1;
      await renderHistoryPanel();
      return;
    }
    if (e.target.closest('[data-history-next]')) {
      historyPage += 1;
      await renderHistoryPanel();
    }
  });

  wrap.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-char-state-edit-form]');
    if (!form || !wrap.contains(form) || !editing) return;
    e.preventDefault();
    const patch = readEditForm(form);
    if (!patch) return;
    const saveBtn = form.querySelector('.char-state-edit-save');
    if (saveBtn) saveBtn.disabled = true;
    try {
      if (editing.mode === 'current') {
        const saved = await persistCurrent(patch);
        applyLocalSnapshot(saved);
        editing = null;
        activeTab = 'current';
        showToast('已保存');
        await renderPanel();
        return;
      }
      const entryId = String(editing.entryId || '');
      const saved = await persistHistory(entryId, patch);
      if (!saved) {
        showToast('保存失败');
        return;
      }
      if (suppliedHistory) {
        suppliedHistory = suppliedHistory.map((row) => (
          row && String(row.id || '') === entryId
            ? { ...row, ...saved, id: entryId }
            : row
        ));
      } else if (chatId && characterId) {
        // 同轮往期改动会写回当前态，刷新本地面板
        const raw = await loadChatCharState(chatId).catch(() => null);
        const allowLegacyUnscoped = await canReadLegacyUnscopedChatState(chatId, userId);
        const live = filterChatCharStateForUser(raw, userId, { allowLegacyUnscoped })?.[characterId];
        if (live) applyLocalSnapshot(live);
      }
      editing = null;
      activeTab = 'history';
      showToast('已保存');
      await renderPanel();
    } catch (_) {
      showToast('保存失败');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  });

  const close = () => {
    closeCharStatePopover();
  };
  close.update = (snapshot = {}) => {
    if (!wrap.isConnected) return;
    applyLocalSnapshot(snapshot);
    currentLoading = false;
    if (activeTab === 'current' && !editing) renderCurrentPanel();
  };
  close.fail = () => {
    if (!wrap.isConnected) return;
    currentLoading = false;
    if (activeTab === 'current' && !editing) {
      body.innerHTML = '<div class="char-state-empty-hint">加载失败</div>';
    }
  };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });

  document.body.appendChild(wrap);
  renderPanel().catch(() => {
    body.innerHTML = '<div class="char-state-empty-hint">加载失败</div>';
  });
  return close;
}
