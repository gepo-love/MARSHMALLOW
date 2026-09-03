import { icon } from './svg-icons.js';
import {
  deleteChatInteractionTemplate,
  loadChatInteractionTemplates,
  normalizeChatInteractionPlan,
  normalizeChatInteractionSession,
  saveChatInteractionTemplate,
} from '../core/chat-interactions.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function templateCard(template) {
  const summary = String(template.summary || template.brief || '').trim();
  return `
    <article class="chat-interaction-template" data-interaction-template-id="${esc(template.id)}">
      <button type="button" class="chat-interaction-template-main" data-interaction-start="${esc(template.id)}">
        <span class="chat-interaction-template-name">${esc(template.name)}</span>
        ${summary ? `<span class="chat-interaction-template-summary">${esc(summary)}</span>` : ''}
      </button>
      ${template.builtin ? '' : `
        <button type="button" class="chat-interaction-template-edit" data-interaction-edit="${esc(template.id)}" aria-label="编辑 ${esc(template.name)}">${icon('edit')}</button>
      `}
    </article>
  `;
}

function libraryHtml({ characterName, proactiveEnabled, session, pendingDraft, templates }) {
  const active = normalizeChatInteractionSession(session);
  const waiting = !active && pendingDraft?.plan
    ? normalizeChatInteractionPlan(pendingDraft.plan, { forcePropose: true })
    : null;
  return `
    <div class="modal-overlay chat-interaction-overlay" data-interaction-close>
      <section class="modal-sheet chat-interaction-sheet" role="dialog" aria-modal="true" aria-labelledby="chat-interaction-title">
        <header class="modal-header chat-interaction-header">
          <h3 id="chat-interaction-title">互动 <small>测试中</small></h3>
          <button type="button" class="navbar-btn modal-close-btn" data-interaction-close aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="modal-body chat-interaction-body">
          <label class="chat-interaction-autonomy">
            <span>
              <strong>允许 ${esc(characterName || 'TA')} 主动发起</strong>
              <small>角色可安排稍后自然发起</small>
            </span>
            <input type="checkbox" data-interaction-proactive ${proactiveEnabled ? 'checked' : ''} />
          </label>

          ${active ? `
            <div class="chat-interaction-active">
              <span><small>正在聊</small><strong>${esc(active.title)}</strong></span>
              <button type="button" data-interaction-end>结束</button>
            </div>
          ` : ''}

          ${waiting ? `
            <div class="chat-interaction-active chat-interaction-pending">
              <span>
                <small>开场未完成</small>
                <strong>${pendingDraft.mode === 'blackbox' ? `${esc(characterName || 'TA')} 安排的互动` : esc(waiting.title)}</strong>
              </span>
              <span class="chat-interaction-active-actions">
                <button type="button" data-interaction-discard>放弃</button>
                <button type="button" data-interaction-resume>${pendingDraft.mode === 'blackbox' ? '重试' : '继续'}</button>
              </span>
            </div>
          ` : ''}

          <button type="button" class="chat-interaction-handoff" data-interaction-blackbox>
            <span class="chat-interaction-handoff-mark" aria-hidden="true"><i>我</i><b></b><i>TA</i></span>
            <span><strong>交给 TA</strong><small>不看预案，由角色自然发起</small></span>
            ${icon('chevron')}
          </button>

          <button type="button" class="chat-interaction-handoff is-negotiate" data-interaction-arrange>
            <span class="chat-interaction-handoff-mark" aria-hidden="true"><i>我</i><b></b><i>TA</i></span>
            <span><strong>一起商量</strong><small>先看主题，需要时再展开</small></span>
            ${icon('chevron')}
          </button>

          <div class="chat-interaction-list-heading">
            <span>玩法模板</span>
            <button type="button" data-interaction-new>${icon('plus')}<span>新建</span></button>
          </div>
          <div class="chat-interaction-template-list">
            ${templates.map(templateCard).join('')}
          </div>
        </div>
      </section>
    </div>
  `;
}

function editorHtml(template = null) {
  const editing = template && !template.builtin;
  return `
    <div class="modal-overlay chat-interaction-overlay">
      <form class="modal-sheet chat-interaction-sheet chat-interaction-editor" data-interaction-form role="dialog" aria-modal="true" aria-labelledby="chat-interaction-editor-title">
        <header class="modal-header chat-interaction-header">
          <button type="button" class="navbar-btn modal-close-btn" data-interaction-back aria-label="返回">${icon('back')}</button>
          <h3 id="chat-interaction-editor-title">${editing ? '编辑模板' : '新建模板'}</h3>
          <span class="chat-interaction-header-spacer" aria-hidden="true"></span>
        </header>
        <div class="modal-body chat-interaction-editor-body">
          <input type="hidden" name="id" value="${esc(editing ? template.id : '')}" />
          <label class="chat-interaction-field">
            <span>名称</span>
            <input type="text" name="name" maxlength="36" required value="${esc(editing ? template.name : '')}" placeholder="例如：睡前交换三个问题" />
          </label>
          <label class="chat-interaction-field">
            <span>怎么玩</span>
            <textarea name="brief" maxlength="2000" required placeholder="写下想聊的方向、双方怎么参与，或希望角色怎样带领。">${esc(editing ? template.brief : '')}</textarea>
          </label>
        </div>
        <footer class="modal-footer chat-interaction-editor-footer">
          ${editing ? '<button type="button" class="chat-interaction-delete" data-interaction-delete>删除</button>' : '<span></span>'}
          <button type="submit" class="btn btn-primary">保存</button>
        </footer>
      </form>
    </div>
  `;
}

function draftRules(value = '') {
  return String(value || '')
    .split(/\r?\n/)
    .map((item) => item.replace(/^\s*[-•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

function readDraftPlan(form, basePlan = {}) {
  const data = new FormData(form);
  return normalizeChatInteractionPlan({
    ...basePlan,
    decision: 'propose',
    title: String(data.get('title') || '').trim(),
    summary: String(data.get('summary') || '').trim(),
    proposal: String(data.get('proposal') || '').trim(),
    rules: draftRules(data.get('rules')),
  }, { forcePropose: true });
}

function draftHtml({ characterName, plan = null, loading = false, feedback = '', expanded = false }) {
  const draft = normalizeChatInteractionPlan(plan || {}, { forcePropose: true });
  const disabled = loading ? 'disabled' : '';
  const rules = draft.rules.join('\n');
  return `
    <div class="modal-overlay chat-interaction-overlay">
      <form class="modal-sheet chat-interaction-sheet chat-interaction-draft" data-interaction-draft-form role="dialog" aria-modal="true" aria-labelledby="chat-interaction-draft-title" ${loading ? 'aria-busy="true"' : ''}>
        <header class="modal-header chat-interaction-header">
          <button type="button" class="navbar-btn modal-close-btn" data-interaction-back aria-label="返回" ${disabled}>${icon('back')}</button>
          <h3 id="chat-interaction-draft-title">和 ${esc(characterName || 'TA')} 商量 <small>测试中</small></h3>
          <button type="button" class="navbar-btn modal-close-btn" data-interaction-close aria-label="关闭">${icon('close')}</button>
        </header>
        ${!plan && loading ? `
          <div class="modal-body chat-interaction-draft-loading" role="status">
            <span class="chat-interaction-draft-pulse" aria-hidden="true"></span>
            <strong>${esc(characterName || 'TA')} 正在准备草案…</strong>
          </div>
        ` : !expanded ? `
          <div class="modal-body chat-interaction-draft-cover">
            <small>${esc(characterName || 'TA')} 想到的主题</small>
            <h4>${esc(draft.title || '一起聊聊')}</h4>
            ${draft.summary ? `<p>${esc(draft.summary)}</p>` : ''}
            <button type="button" data-interaction-expand ${disabled}>展开商量</button>
          </div>
          <footer class="modal-footer chat-interaction-draft-footer">
            <button type="button" data-interaction-back ${disabled}>换一个</button>
            <button type="submit" class="btn btn-primary" ${disabled}>直接开始</button>
          </footer>
        ` : `
          <div class="modal-body chat-interaction-draft-body">
            <label class="chat-interaction-field">
              <span>名称</span>
              <input type="text" name="title" maxlength="48" required value="${esc(draft.title)}" ${disabled} />
            </label>
            <label class="chat-interaction-field">
              <span>一句话构想</span>
              <textarea class="chat-interaction-draft-short" name="summary" maxlength="140" required ${disabled}>${esc(draft.summary)}</textarea>
            </label>
            <label class="chat-interaction-field">
              <span>具体玩法</span>
              <textarea name="proposal" maxlength="900" required ${disabled}>${esc(draft.proposal)}</textarea>
            </label>
            <label class="chat-interaction-field">
              <span>共同约定 <small>每行一条</small></span>
              <textarea class="chat-interaction-draft-short" name="rules" maxlength="1200" ${disabled}>${esc(rules)}</textarea>
            </label>
            <div class="chat-interaction-draft-revision">
              <label class="chat-interaction-field">
                <span>还想怎么改</span>
                <textarea class="chat-interaction-draft-short" name="feedback" maxlength="1200" placeholder="例如：身份互换一下，开场慢一点……" ${disabled}>${esc(feedback)}</textarea>
              </label>
              <button type="button" data-interaction-revise ${disabled}>${loading ? `${esc(characterName || 'TA')} 正在调整…` : `让 ${esc(characterName || 'TA')} 调整`}</button>
            </div>
          </div>
          <footer class="modal-footer chat-interaction-draft-footer">
            <button type="button" data-interaction-collapse ${disabled}>收起</button>
            <button type="submit" class="btn btn-primary" ${disabled}>就这样开始</button>
          </footer>
        `}
      </form>
    </div>
  `;
}

export async function openChatInteractionsModal({
  userId = '',
  characterName = 'TA',
  proactiveEnabled = false,
  session = null,
  pendingDraft = null,
  onToggleProactive,
  onPrepare,
  onConfirm,
  onBlackbox,
  onDiscardDraft,
  onEnd,
  onError,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return null;
  let templates = await loadChatInteractionTemplates(userId);
  let currentSession = normalizeChatInteractionSession(session);
  let waitingDraft = pendingDraft?.plan ? {
    ...pendingDraft,
    mode: pendingDraft.mode === 'blackbox' ? 'blackbox' : 'negotiate',
    plan: normalizeChatInteractionPlan(pendingDraft.plan, { forcePropose: true }),
  } : null;
  let editingTemplate = null;
  let draftState = null;
  let draftBusy = false;
  let draftRequestId = 0;
  let closed = false;

  const report = (error) => {
    if (typeof onError === 'function') onError(error);
    else console.error('[chat-interactions]', error);
  };
  const focusFirst = () => window.setTimeout(() => {
    host.querySelector('input:not([type="hidden"]), textarea, button')?.focus?.({ preventScroll: true });
  }, 0);
  const renderLibrary = () => {
    editingTemplate = null;
    draftState = null;
    draftBusy = false;
    host.innerHTML = libraryHtml({
      characterName,
      proactiveEnabled,
      session: currentSession,
      pendingDraft: waitingDraft,
      templates,
    });
    focusFirst();
  };
  const renderEditor = (template = null) => {
    editingTemplate = template && !template.builtin ? template : null;
    host.innerHTML = editorHtml(editingTemplate);
    focusFirst();
  };
  const renderDraft = ({ loading = false, feedback = '' } = {}) => {
    host.innerHTML = draftHtml({
      characterName,
      plan: draftState?.plan || null,
      loading,
      feedback,
      expanded: draftState?.expanded === true,
    });
    if (!loading) focusFirst();
  };
  const prepareDraft = async ({
    kind = 'arrange',
    template = null,
    currentPlan = null,
    revisionRequest = '',
    expanded = false,
  } = {}) => {
    if (draftBusy || closed) return;
    const previousState = draftState;
    const requestId = ++draftRequestId;
    draftBusy = true;
    draftState = {
      kind,
      template,
      plan: currentPlan ? normalizeChatInteractionPlan(currentPlan, { forcePropose: true }) : null,
      expanded: expanded === true,
    };
    renderDraft({ loading: true, feedback: revisionRequest });
    try {
      const result = await onPrepare?.({ kind, template, currentPlan, revisionRequest });
      if (closed || requestId !== draftRequestId) return;
      const plan = normalizeChatInteractionPlan(result, { forcePropose: true });
      if (!plan.title || !plan.proposal) throw new Error('角色没有给出可用的互动草案');
      draftState = { kind, template, plan, expanded: expanded === true };
      draftBusy = false;
      renderDraft();
    } catch (error) {
      if (closed || requestId !== draftRequestId) return;
      draftBusy = false;
      if (previousState?.plan) {
        draftState = previousState;
        renderDraft({ feedback: revisionRequest });
      } else {
        renderLibrary();
      }
      report(error);
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    draftRequestId += 1;
    document.removeEventListener('keydown', onKeydown);
    host.removeEventListener('click', onClick);
    host.removeEventListener('change', onChange);
    host.removeEventListener('submit', onSubmit);
    host.classList.remove('active');
    host.innerHTML = '';
  };
  const onKeydown = (event) => {
    if (event.key !== 'Escape') return;
    if (draftState?.plan && draftState.expanded) {
      draftState.expanded = false;
      renderDraft();
    } else if (host.querySelector('[data-interaction-form], [data-interaction-draft-form]')) {
      draftRequestId += 1;
      renderLibrary();
    }
    else close();
  };
  const onClick = async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches('[data-interaction-close]') && !target.closest('.chat-interaction-sheet')) {
      close();
      return;
    }
    if (target.closest('button[data-interaction-close]')) {
      close();
      return;
    }
    if (target.closest('[data-interaction-back]')) {
      if (draftBusy) return;
      if (draftState?.plan && draftState.expanded) {
        draftState.expanded = false;
        renderDraft();
        return;
      }
      draftRequestId += 1;
      renderLibrary();
      return;
    }
    if (target.closest('[data-interaction-new]')) {
      renderEditor();
      return;
    }
    const editButton = target.closest('[data-interaction-edit]');
    if (editButton) {
      const id = editButton.getAttribute('data-interaction-edit') || '';
      renderEditor(templates.find((item) => item.id === id) || null);
      return;
    }
    const startButton = target.closest('[data-interaction-start]');
    if (startButton) {
      const id = startButton.getAttribute('data-interaction-start') || '';
      const template = templates.find((item) => item.id === id);
      if (!template) return;
      void prepareDraft({ kind: 'template', template });
      return;
    }
    if (target.closest('[data-interaction-arrange]')) {
      void prepareDraft({ kind: 'arrange', template: null });
      return;
    }
    if (target.closest('[data-interaction-blackbox]')) {
      close();
      Promise.resolve(onBlackbox?.({ kind: 'blackbox', template: null, plan: null })).catch(report);
      return;
    }
    if (target.closest('[data-interaction-resume]')) {
      if (!waitingDraft?.plan) return;
      if (waitingDraft.mode === 'blackbox') {
        const retry = waitingDraft;
        close();
        Promise.resolve(onBlackbox?.({
          kind: 'blackbox',
          template: retry.template || null,
          plan: retry.plan,
        })).catch(report);
      } else {
        draftState = {
          kind: waitingDraft.kind || 'arrange',
          template: waitingDraft.template || null,
          plan: waitingDraft.plan,
          expanded: false,
        };
        renderDraft();
      }
      return;
    }
    if (target.closest('[data-interaction-discard]')) {
      const button = target.closest('button');
      if (button) button.disabled = true;
      try {
        await onDiscardDraft?.(waitingDraft);
        waitingDraft = null;
        renderLibrary();
      } catch (error) {
        if (button?.isConnected) button.disabled = false;
        report(error);
      }
      return;
    }
    if (target.closest('[data-interaction-expand]')) {
      if (!draftState?.plan || draftBusy) return;
      draftState.expanded = true;
      renderDraft();
      return;
    }
    if (target.closest('[data-interaction-collapse]')) {
      if (!draftState?.plan || draftBusy) return;
      const form = target.closest('[data-interaction-draft-form]');
      if (form) draftState.plan = readDraftPlan(form, draftState.plan);
      draftState.expanded = false;
      renderDraft();
      return;
    }
    if (target.closest('[data-interaction-revise]')) {
      const form = target.closest('[data-interaction-draft-form]');
      if (!form || !draftState?.plan || draftBusy) return;
      const currentPlan = readDraftPlan(form, draftState.plan);
      const feedback = String(new FormData(form).get('feedback') || '').trim();
      if (!feedback) {
        report(new Error('先写下想让 TA 怎么调整'));
        return;
      }
      void prepareDraft({
        kind: draftState.kind,
        template: draftState.template,
        currentPlan,
        revisionRequest: feedback,
        expanded: true,
      });
      return;
    }
    if (target.closest('[data-interaction-end]')) {
      const button = target.closest('button');
      if (button) button.disabled = true;
      try {
        await onEnd?.(currentSession);
        currentSession = null;
        renderLibrary();
      } catch (error) {
        if (button) button.disabled = false;
        report(error);
      }
      return;
    }
    if (target.closest('[data-interaction-delete]')) {
      if (!editingTemplate) return;
      if (!window.confirm(`删除模板“${editingTemplate.name}”？`)) return;
      try {
        await deleteChatInteractionTemplate(userId, editingTemplate.id);
        templates = await loadChatInteractionTemplates(userId);
        editingTemplate = null;
        renderLibrary();
      } catch (error) {
        report(error);
      }
    }
  };
  const onChange = async (event) => {
    const input = event.target.closest?.('[data-interaction-proactive]');
    if (!input) return;
    const previous = proactiveEnabled;
    proactiveEnabled = input.checked === true;
    input.disabled = true;
    try {
      await onToggleProactive?.(proactiveEnabled);
    } catch (error) {
      proactiveEnabled = previous;
      input.checked = previous;
      report(error);
    } finally {
      if (input.isConnected) input.disabled = false;
    }
  };
  const onSubmit = async (event) => {
    const draftForm = event.target.closest?.('[data-interaction-draft-form]');
    if (draftForm) {
      event.preventDefault();
      if (draftBusy || !draftState?.plan) return;
      const submit = draftForm.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      try {
        const plan = draftState.expanded
          ? readDraftPlan(draftForm, draftState.plan)
          : normalizeChatInteractionPlan(draftState.plan, { forcePropose: true });
        if (!plan.title || !plan.summary || !plan.proposal) throw new Error('请保留主题和具体玩法');
        await onConfirm?.({
          kind: draftState.kind,
          template: draftState.template,
          plan,
        });
        close();
      } catch (error) {
        if (submit?.isConnected) submit.disabled = false;
        report(error);
      }
      return;
    }
    const form = event.target.closest?.('[data-interaction-form]');
    if (!form) return;
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const data = new FormData(form);
      const name = String(data.get('name') || '').trim();
      const brief = String(data.get('brief') || '').trim();
      if (!name || !brief) throw new Error('请填写模板名称和玩法');
      await saveChatInteractionTemplate(userId, {
        ...(editingTemplate || {}),
        id: String(data.get('id') || '').trim() || undefined,
        name,
        brief,
        summary: brief.replace(/\s+/g, ' ').slice(0, 60),
      });
      templates = await loadChatInteractionTemplates(userId);
      editingTemplate = null;
      renderLibrary();
    } catch (error) {
      if (submit) submit.disabled = false;
      report(error);
    }
  };

  host.classList.add('active');
  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  host.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onKeydown);
  renderLibrary();
  return { close };
}
