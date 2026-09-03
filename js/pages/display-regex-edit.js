import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { openOptionPicker } from '../components/option-picker.js';
import {
  REGEX_SURFACES,
  REGEX_PLACEMENTS,
  REGEX_EXEC_MODES,
  REGEX_SUBSTITUTE_MODES,
  applyExecModeToRule,
  createRegexRule,
  createRegexGroup,
  getRegexGroup,
  upsertRegexGroup,
  upsertRegexRule,
  deleteRegexRule,
  applyRegexWithRules,
  execModeFromRule,
  labelForExecMode,
  labelForPlacement,
  labelForSubstitute,
} from '../core/display-regex.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function getVal(container, sel) {
  return String(container.querySelector(sel)?.value ?? '');
}

function getChecked(container, sel) {
  return container.querySelector(sel)?.checked === true;
}

function parseDepth(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text === '-1') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function fieldBlock(label, sub, inner, required = false) {
  const req = required ? '<span class="rxg-req">*</span>' : '';
  const subHtml = sub ? `<span class="rxg-field-sub">${esc(sub)}</span>` : '';
  return `
    <section class="rxg-field-card scrapbook-panel">
      <div class="rxg-field-head">
        <span class="rxg-field-label">${esc(label)}${req}</span>
        ${subHtml}
      </div>
      ${inner}
    </section>`;
}

function pickerRow(key, label, value) {
  return `
    <button type="button" class="rxg-picker-row" data-pick="${esc(key)}">
      <span class="rxg-picker-label">${esc(label)}</span>
      <span class="rxg-picker-value" data-pick-value="${esc(key)}">${esc(value)}</span>
      <span class="rxg-picker-chevron">›</span>
    </button>`;
}

function targetsSummary(targets = []) {
  const set = new Set(targets || []);
  const labels = REGEX_SURFACES.filter((s) => set.has(s.id)).map((s) => s.label);
  return labels.length ? labels.join('、') : '未选择';
}

function regexEditorValue(rule = {}) {
  const source = String(rule.find || '');
  if (!source) return '';
  return `/${source}/${String(rule.flags || '')}`;
}

function checkboxRow(key, label, checked, sub = '') {
  return `
    <label class="rxg-check-row">
      <input type="checkbox" data-check="${esc(key)}" ${checked ? 'checked' : ''} />
      <span class="rxg-check-copy"><strong>${esc(label)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
    </label>`;
}

export default async function render(container, params = {}) {
  const groupId = String(params.gid || params.group || '').trim();
  const ruleId = String(params.rid || params.rule || '').trim();
  const isNewRule = !ruleId || ruleId === 'new';
  const isNewGroup = !groupId || groupId === 'new';

  let group = null;
  let rule = createRegexRule({ name: '', placement: [2] });
  let draftGroupId = isNewGroup ? genId('rxg') : groupId;

  if (!isNewGroup) {
    group = await getRegexGroup(groupId);
    if (!group) {
      showToast('找不到该正则组');
      navigate('display-regex', {}, true);
      return;
    }
    draftGroupId = group.id;
    if (!isNewRule) {
      rule = (group.rules || []).find((r) => r.id === ruleId) || null;
      if (!rule) {
        showToast('找不到该规则');
        navigate('display-regex', {}, true);
        return;
      }
      rule = createRegexRule(rule);
    }
  } else {
    group = createRegexGroup({ id: draftGroupId, name: '新建正则组', rules: [] });
  }

  container.className = 'page scrapbook-page rxg-edit-page';

  function syncRuleFromForm() {
    const findRaw = getVal(container, '[data-key="find"]').trim();
    const rebuilt = createRegexRule({
      ...rule,
      name: getVal(container, '[data-key="name"]').trim() || '未命名规则',
      findRegex: findRaw,
      // rule 已经带有规范字段 replace；这里若再写兼容导入字段 replaceString，
      // createRegexRule 会优先读取旧 replace，导致刚输入的替换内容被旧空值覆盖。
      replace: getVal(container, '[data-key="replace"]'),
      trimStrings: getVal(container, '[data-key="trim"]')
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean),
      enabled: !getChecked(container, '[data-check="disabled"]'),
      runOnEdit: getChecked(container, '[data-check="runOnEdit"]'),
      minDepth: parseDepth(getVal(container, '[data-key="minDepth"]')),
      maxDepth: parseDepth(getVal(container, '[data-key="maxDepth"]')),
    });
    Object.assign(rule, rebuilt);
    return rule;
  }

  function updateCounter() {
    const findEl = container.querySelector('[data-key="find"]');
    const counter = container.querySelector('[data-find-count]');
    if (findEl && counter) counter.textContent = String(findEl.value.length);
  }

  function updateTestOutput() {
    const output = container.querySelector('[data-test-output]');
    if (!output) return;
    const draft = syncRuleFromForm();
    const mode = execModeFromRule(draft);
    const phase = mode === 'prompt' ? 'prompt' : (mode === 'permanent' ? 'permanent' : 'display');
    output.value = applyRegexWithRules(getVal(container, '[data-key="testInput"]'), [draft], {
      phase,
      surface: draft.targets?.[0] || 'chat',
      placement: draft.placement?.[0] || 2,
      depth: 0,
      macros: { user: '用户', char: '角色' },
    });
  }

  function paint() {
    const title = isNewRule ? '新建正则' : '编辑正则';
    const findValue = regexEditorValue(rule);
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${title}</h1>
        <button type="button" class="navbar-btn" data-save aria-label="保存">${icon('check')}</button>
      </header>
      <main class="rxg-edit-scroll scrapbook-scroll">
        ${fieldBlock('测试模式', '', `
          <div class="rxg-test-grid">
            <label><span>输入</span><textarea class="form-input rxg-code-area" data-key="testInput" rows="3" placeholder="输入一段文本测试规则"></textarea></label>
            <label><span>输出</span><textarea class="form-input rxg-code-area" data-test-output rows="3" readonly></textarea></label>
          </div>
        `)}

        ${fieldBlock('名字', '', `<input type="text" class="form-input" data-key="name" value="${esc(rule.name)}" placeholder="例如：去除思维链补充" maxlength="60" />`, true)}

        ${fieldBlock('正则表达式', 'Find Regex', `
          <textarea class="form-input rxg-code-area" data-key="find" rows="4" placeholder="/pattern/flags 或纯 pattern">${esc(findValue)}</textarea>
          <div class="rxg-code-meta"><span></span><span data-find-count>${String(findValue.length)}</span></div>
        `)}

        ${fieldBlock('替换内容', 'Replace With', `
          <textarea class="form-input rxg-code-area" data-key="replace" rows="4" placeholder="使用 {{match}} 来包含匹配到的内容，或 $1、$2 等引用捕获组">${esc(rule.replace)}</textarea>
        `)}

        ${fieldBlock('替换前修剪', 'Trim Out', `
          <textarea class="form-input rxg-code-area" data-key="trim" rows="3" placeholder="执行正则替换前，从匹配到的内容中先移除指定内容，每行一个">${esc((rule.trimStrings || []).join('\n'))}</textarea>
        `)}

        ${fieldBlock('影响对象', 'Affects', `
          <div class="rxg-picker-card rxg-picker-card-inner">
            ${pickerRow('placement', '文本来源', labelForPlacement(rule.placement))}
            ${pickerRow('targets', '应用页面', targetsSummary(rule.targets))}
          </div>
        `)}

        ${fieldBlock('其它选项', '', `
          <div class="rxg-check-list">
            ${checkboxRow('disabled', '停用此规则', !rule.enabled)}
            ${checkboxRow('runOnEdit', '编辑后重新执行', rule.runOnEdit, '手动编辑已有内容并保存时再次应用永久规则')}
          </div>
        `)}

        <section class="rxg-field-card scrapbook-panel rxg-picker-card">
          ${pickerRow('substitute', '查找式中的宏', labelForSubstitute(rule.substituteRegex))}
        </section>

        ${fieldBlock('消息深度', '', `
          <div class="rxg-depth-row">
            <label><span>最小深度</span><input type="number" class="form-input rxg-depth-input" data-key="minDepth" min="-1" value="${rule.minDepth == null ? '' : esc(rule.minDepth)}" placeholder="不限" /></label>
            <span class="rxg-depth-sep">—</span>
            <label><span>最大深度</span><input type="number" class="form-input rxg-depth-input" data-key="maxDepth" min="-1" value="${rule.maxDepth == null ? '' : esc(rule.maxDepth)}" placeholder="不限" /></label>
          </div>
        `)}

        ${fieldBlock('执行方式', '', `
          <div class="rxg-picker-card rxg-picker-card-inner">
            ${pickerRow('execMode', '作用范围', labelForExecMode(rule))}
          </div>
          <p class="rxg-field-hint">永久替换会写入之后新保存的内容，并同步作用于已有内容的显示与模型上下文；不会批量改写已有历史或世界书数据。</p>
        `)}

        ${!isNewRule ? '<button type="button" class="btn btn-soft rxg-delete-rule">删除此规则</button>' : ''}
      </main>
    `;
    bind();
  }

  function setPickValue(key, text) {
    const el = container.querySelector(`[data-pick-value="${key}"]`);
    if (el) el.textContent = text;
  }

  async function onPick(key) {
    if (key === 'placement') {
      const picked = await openOptionPicker({
        title: '影响对象',
        items: REGEX_PLACEMENTS.map((item) => ({ id: String(item.id), label: item.label })),
        multiple: true,
        preselected: (rule.placement || []).map(String),
        confirmLabel: '确认',
      });
      if (!picked) return;
      rule.placement = picked.map(Number).filter(Number.isFinite);
      setPickValue('placement', labelForPlacement(rule.placement));
      updateTestOutput();
      return;
    }
    if (key === 'substitute') {
      const picked = await openOptionPicker({
        title: '查找式中的宏',
        items: REGEX_SUBSTITUTE_MODES.map((item) => ({ id: String(item.id), label: item.label })),
        preselected: String(rule.substituteRegex || 0),
      });
      if (picked == null) return;
      rule.substituteRegex = Number(picked) || 0;
      setPickValue('substitute', labelForSubstitute(rule.substituteRegex));
      updateTestOutput();
      return;
    }
    if (key === 'execMode') {
      const picked = await openOptionPicker({
        title: '执行方式',
        items: REGEX_EXEC_MODES.map((item) => ({ id: item.id, label: item.label })),
        preselected: execModeFromRule(rule),
      });
      if (picked == null) return;
      applyExecModeToRule(rule, picked);
      setPickValue('execMode', labelForExecMode(rule));
      updateTestOutput();
      return;
    }
    if (key === 'targets') {
      const picked = await openOptionPicker({
        title: '显示用途',
        items: REGEX_SURFACES.map((s) => ({ id: s.id, label: s.label })),
        multiple: true,
        preselected: rule.targets || [],
        confirmLabel: '确认',
      });
      if (!picked) return;
      rule.targets = picked;
      setPickValue('targets', targetsSummary(rule.targets));
      updateTestOutput();
    }
  }

  async function onSave() {
    syncRuleFromForm();
    if (!rule.name.trim()) {
      showToast('请填写名字');
      return;
    }
    if (!rule.find.trim()) {
      showToast('请填写正则表达式');
      return;
    }
    try {
      // eslint-disable-next-line no-new
      new RegExp(rule.find, rule.flags || '');
    } catch (e) {
      showToast(`正则无效：${e.message || e}`);
      return;
    }
    if (isNewGroup && !(group?.rules?.length)) {
      await upsertRegexGroup(group);
    }
    await upsertRegexRule(draftGroupId, rule);
    showToast('已保存');
    navigate('display-regex', {}, true);
  }

  function bind() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('[data-save]')?.addEventListener('click', onSave);
    container.querySelector('[data-key="find"]')?.addEventListener('input', updateCounter);
    container.querySelectorAll('[data-key], [data-check]').forEach((el) => {
      el.addEventListener('input', updateTestOutput);
      el.addEventListener('change', updateTestOutput);
    });
    container.querySelectorAll('[data-pick]').forEach((el) => {
      el.addEventListener('click', () => onPick(el.getAttribute('data-pick')));
    });
    container.querySelector('.rxg-delete-rule')?.addEventListener('click', async () => {
      if (!window.confirm('删除这条正则规则？')) return;
      await deleteRegexRule(draftGroupId, rule.id);
      showToast('已删除');
      navigate('display-regex', {}, true);
    });
  }

  paint();
}
