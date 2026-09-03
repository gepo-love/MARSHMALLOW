import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser, saveUserRecord } from '../core/user-slot.js';
import {
  TIME_MODE_REAL,
  TIME_MODE_VIRTUAL,
  getTimeMode,
  setTimeMode,
  getNowForUser,
  ensureTimeSchedule,
  formatGapHint,
  formatPromptTimeLine,
  advanceVirtualTime,
  setVirtualNow,
  getAiTimeBlind,
  setAiTimeBlind,
  getUserTimezone,
  getUserTimezonePreference,
  setUserTimezone,
  setPauseTimeOnBackground,
} from '../core/time-mode.js';
import {
  getZonedDateParts,
  timestampFromUserWallTime,
  zonedDateProxy,
} from '../core/user-timezone.js';
import {
  getHolidayPromptEnabled,
  setHolidayPromptEnabled,
  buildCalendarMonthCells,
  listUpcomingHolidays,
  formatHolidayRange,
  buildHolidayPromptLine,
  startOfDayTs,
} from '../core/civic-calendar.js';
import { getPrimaryHolidayAt } from '../data/civic-holidays.js';
import { TIMEZONE_OPTION_GROUPS, findTimezoneOptionLabel } from '../data/timezone-options.js';
import {
  listUserMemos,
  repairIneligibleCharacterMemos,
  addUserMemo,
  removeUserMemo,
  filterMemosForDay,
  buildMemoDayMap,
  formatMemoTime,
  MEMO_SOURCE_USER,
  MEMO_SOURCE_CHARACTER,
} from '../core/user-memos.js';
import {
  loadPeriodTracker,
  savePeriodTracker,
  setPeriodReminderTargets,
  recordPeriodStart,
  replacePeriodStart,
  removePeriodStart,
  getPeriodStatus,
  buildPeriodDayMap,
  formatPeriodStatusLine,
} from '../core/period-tracker.js';
import { listCharacters } from '../core/character-store.js';
import { ensurePrivateChat } from '../core/chat-store.js';
import { characterAvatarHtml } from '../components/scrapbook-illustrations.js';
import { loadAppearancePrefs, getActiveTheme, isWindowHomeTheme, isSeaHomeTheme } from '../core/appearance-prefs.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function confirmTimeAdjustmentNotice() {
  const message = '如果把虚拟时间调到已有聊天之前，继续聊天时会将该窗口中晚于新时刻的消息尾段整体对齐到新的世界时间，并保留原有先后顺序；这些消息原先显示的日期和钟点也会随之调整。';
  const host = document.getElementById('modal-container');
  if (!host) return Promise.resolve(window.confirm(message));

  host.classList.add('active');
  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center" data-cal-time-notice-overlay>
      <div class="modal-sheet scrapbook-card cal-time-notice" role="dialog" aria-modal="true" aria-labelledby="cal-time-notice-title" aria-describedby="cal-time-notice-copy">
        <header class="modal-header">
          <h3 id="cal-time-notice-title">调整时间前请注意</h3>
          <button type="button" class="navbar-btn modal-close-btn" data-cal-time-notice-cancel aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="modal-body">
          <p id="cal-time-notice-copy">${esc(message)}</p>
        </div>
        <footer class="cal-time-notice-actions">
          <button type="button" class="btn btn-outline" data-cal-time-notice-cancel>暂不调整</button>
          <button type="button" class="btn btn-primary" data-cal-time-notice-confirm>我知道了</button>
        </footer>
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeydown);
      host.innerHTML = '';
      host.classList.remove('active');
      resolve(confirmed);
    };
    const onKeydown = (event) => {
      if (event.key === 'Escape') finish(false);
    };
    host.querySelectorAll('[data-cal-time-notice-cancel]').forEach((button) => {
      button.addEventListener('click', () => finish(false));
    });
    host.querySelector('[data-cal-time-notice-confirm]')?.addEventListener('click', () => finish(true));
    host.querySelector('[data-cal-time-notice-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) finish(false);
    });
    document.addEventListener('keydown', onKeydown);
    host.querySelector('[data-cal-time-notice-confirm]')?.focus();
  });
}

function toDatetimeLocalValue(ts, timeZone = '') {
  const p = getZonedDateParts(Number(ts) || Date.now(), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function parseDatetimeLocalValue(value, timeZone = '') {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  return timestampFromUserWallTime({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  }, timeZone);
}

function formatShortDate(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function toDateInputValue(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDateInputValue(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0).getTime();
}

function combineDayAndTime(dayTs, timeValue, timeZone = '') {
  const d = new Date(Number(dayTs) || Date.now());
  const m = String(timeValue || '').match(/^(\d{1,2}):(\d{2})$/);
  return timestampFromUserWallTime({
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: m ? Number(m[1]) : 9,
    minute: m ? Number(m[2]) : 0,
  }, timeZone);
}

function renderMonthGrid(cells, { memoDayMap, periodDayMap, selectedDayTs } = {}) {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const head = weekdays.map((w) => `<span class="cal-page-wd">${w}</span>`).join('');
  const body = cells.map((cell) => {
    if (!cell) return '<span class="cal-page-cell is-empty" aria-hidden="true"></span>';
    const periodKind = periodDayMap?.get(cell.ts) || '';
    const hasMemo = (memoDayMap?.get(cell.ts) || 0) > 0;
    const cls = [
      'cal-page-cell',
      cell.isToday ? 'is-today' : '',
      cell.isHoliday ? 'is-holiday' : '',
      cell.ts === selectedDayTs ? 'is-selected' : '',
      periodKind === 'recorded' ? 'is-period' : '',
      periodKind === 'predicted' ? 'is-period-predicted' : '',
    ].filter(Boolean).join(' ');
    const title = cell.holidayTitle ? ` title="${esc(cell.holidayTitle)}"` : '';
    return `<button type="button" class="${cls}" data-day-ts="${cell.ts}"${title}>
      <span class="cal-page-day">${cell.day}</span>
      <span class="cal-page-dots" aria-hidden="true">
        ${cell.isHoliday ? '<span class="cal-page-dot is-holiday-dot"></span>' : ''}
        ${hasMemo ? '<span class="cal-page-dot is-memo-dot"></span>' : ''}
      </span>
    </button>`;
  }).join('');
  return `<div class="cal-page-weekdays">${head}</div><div class="cal-page-grid">${body}</div>`;
}

function renderUserMemoRow(memo, timeZone = '') {
  return `
    <li class="cal-memo-row" data-memo-id="${esc(memo.id)}">
      <span class="cal-memo-time">${esc(formatMemoTime(memo.ts, timeZone))}</span>
      <span class="cal-memo-title">${esc(memo.title)}</span>
      <button type="button" class="cal-memo-del" data-memo-id="${esc(memo.id)}" aria-label="删除这条备忘">${icon('close')}</button>
    </li>
  `;
}

function renderCharMemoCard(memo, character, timeZone = '') {
  const avatar = characterAvatarHtml(character, { className: 'cal-char-memo-avatar' });
  const name = character?.customNickname || character?.name || 'TA';
  const done = !!memo.doneAt;
  return `
    <div class="cal-char-memo-card${done ? ' is-done' : ''}" data-memo-id="${esc(memo.id)}">
      <span class="cal-char-memo-time">${icon('time')}${esc(formatMemoTime(memo.ts, timeZone))}</span>
      ${avatar}
      <div class="cal-char-memo-body">
        <div class="cal-char-memo-name">${esc(name)}</div>
        <div class="cal-char-memo-title">${esc(memo.title)}</div>
        ${memo.note ? `<div class="cal-char-memo-note">${esc(memo.note)}</div>` : ''}
      </div>
      <button type="button" class="cal-char-memo-del" data-memo-id="${esc(memo.id)}" aria-label="删除这条备忘">${icon('close')}</button>
    </div>
  `;
}

export default async function render(container) {
  let user = await ensureDefaultUser();
  const userId = user?.id || '';
  const [initialTimezone, initialNow] = await Promise.all([
    getUserTimezone(userId),
    getNowForUser(userId),
  ]);
  const today = zonedDateProxy(initialNow, initialTimezone);
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth();
  let selectedDayTs = startOfDayTs(Date.now());
  let showCreate = false;
  let showPeriodSettings = false;
  let showAdvanced = false;
  let createDraft = { title: '', time: '09:00', note: '', characterId: '' };
  let busy = false;

  let glassTheme = false;
  let seaTheme = false;
  let windowTheme = false;
  try {
    const prefs = await loadAppearancePrefs();
    const active = getActiveTheme(prefs);
    seaTheme = isSeaHomeTheme(active.id, active.theme);
    windowTheme = isWindowHomeTheme(active.id, active.theme);
    glassTheme = seaTheme || windowTheme;
  } catch (_) {
    glassTheme = false;
  }

  container.className = [
    'page',
    'scrapbook-page',
    'cal-page',
    glassTheme ? 'cal-page--ins' : '',
    seaTheme ? 'cal-page--sea' : '',
    windowTheme ? 'cal-page--window' : '',
  ].filter(Boolean).join(' ');

  async function loadState() {
    const [nowTs, mode, schedule, holidayOn, aiTimeBlind, timezone, timezonePreference, memos, periodTracker, characterLoad] = await Promise.all([
      getNowForUser(userId),
      getTimeMode(userId),
      ensureTimeSchedule(userId),
      getHolidayPromptEnabled(userId),
      getAiTimeBlind(userId),
      getUserTimezone(userId),
      getUserTimezonePreference(userId),
      listUserMemos(userId),
      loadPeriodTracker(userId),
      listCharacters({ excludeAnonNpc: true, userId })
        .then((rows) => ({ ok: true, rows }))
        .catch(() => ({ ok: false, rows: [] })),
    ]);
    const characters = characterLoad.rows;
    const eligibleCharacterIds = new Set(characters.map((character) => String(character?.id || '').trim()).filter(Boolean));
    const repairedMemos = characterLoad.ok
      ? await repairIneligibleCharacterMemos(userId, eligibleCharacterIds, memos)
      : memos;
    // 时间债追平中：剧情时间领先现实，世界钟停在锚点等现实自然追上。
    const reconvergeDebtMs = mode === TIME_MODE_VIRTUAL && schedule.reconverge === true
      ? Math.max(0, Number(schedule.anchorVirtual || 0) - Date.now())
      : 0;
    const calendarNowTs = zonedDateProxy(nowTs, timezone).getTime();
    const holiday = getPrimaryHolidayAt(calendarNowTs);
    const holidayLine = holidayOn && holiday ? buildHolidayPromptLine(calendarNowTs) : '';
    const upcoming = listUpcomingHolidays(calendarNowTs, 4);
    const cells = buildCalendarMonthCells(viewYear, viewMonth, calendarNowTs);
    const memoDayMap = buildMemoDayMap(repairedMemos, timezone);
    const periodDayMap = buildPeriodDayMap(periodTracker, viewYear, viewMonth);
    const periodStatus = getPeriodStatus(periodTracker, calendarNowTs);
    const dayMemos = filterMemosForDay(repairedMemos, selectedDayTs, timezone);
    const characterById = new Map(characters.map((c) => [c.id, c]));
    return {
      nowTs, calendarNowTs, mode, reconvergeDebtMs, holidayOn, aiTimeBlind, timezone, timezonePreference,
      pauseOnBackground: schedule.pauseOnBackground === true,
      holiday, holidayLine, upcoming, cells,
      memos: repairedMemos, dayMemos, memoDayMap, periodTracker, periodDayMap, periodStatus,
      characters, characterById,
    };
  }

  function syncDraftFromForm() {
    const form = container.querySelector('.cal-create-form');
    if (!form) return;
    createDraft = {
      ...createDraft,
      title: form.querySelector('.cal-create-title')?.value || '',
      time: form.querySelector('.cal-create-time')?.value || createDraft.time,
      note: form.querySelector('.cal-create-note')?.value || '',
    };
  }

  function renderCreateForm(state) {
    const chips = [
      `<button type="button" class="cal-remind-chip${!createDraft.characterId ? ' is-active' : ''}" data-char-id="">仅备忘</button>`,
      ...state.characters.slice(0, 10).map((c) => `<button type="button" class="cal-remind-chip${createDraft.characterId === c.id ? ' is-active' : ''}" data-char-id="${esc(c.id)}">${esc(c.customNickname || c.name)}</button>`),
    ].join('');
    return `
      <form class="cal-create-form" novalidate>
        <input type="text" class="form-input cal-create-title" placeholder="要做什么" value="${esc(createDraft.title)}" maxlength="40" autofocus />
        <div class="cal-create-row">
          <input type="time" class="form-input cal-create-time" value="${esc(createDraft.time)}" />
          <input type="text" class="form-input cal-create-note" placeholder="备注（可选）" value="${esc(createDraft.note)}" maxlength="60" />
        </div>
        <div class="cal-create-remind">
          <span class="cal-create-remind-label">到点让 TA 提醒我</span>
          <div class="cal-create-chip-row">${chips}</div>
        </div>
        <div class="cal-create-actions">
          <button type="button" class="btn btn-outline btn-sm cal-create-cancel">取消</button>
          <button type="submit" class="btn btn-primary btn-sm cal-create-submit">保存</button>
        </div>
      </form>
    `;
  }

  function renderDayPanel(state) {
    const d = new Date(selectedDayTs);
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const isToday = startOfDayTs(state.calendarNowTs) === selectedDayTs;
    const userMemos = state.dayMemos.filter((m) => m.source === MEMO_SOURCE_USER);
    const charMemos = state.dayMemos.filter((m) => m.source === MEMO_SOURCE_CHARACTER);

    return `
      <section class="scrapbook-card cal-day-card">
        <div class="cal-day-head">
          <div class="cal-day-title">
            ${esc(formatShortDate(selectedDayTs))}
            <span class="cal-day-week">${esc(weekdays[d.getDay()])}${isToday ? ' · 今天' : ''}</span>
          </div>
          <button type="button" class="cal-day-add${showCreate ? ' is-active' : ''}" aria-label="${showCreate ? '取消新建' : '新建备忘'}">${icon(showCreate ? 'close' : 'plus')}</button>
        </div>
        ${showCreate ? renderCreateForm(state) : ''}
        ${userMemos.length ? `
          <ul class="cal-memo-list">${userMemos.map((m) => renderUserMemoRow(m, state.timezone)).join('')}</ul>
        ` : (!showCreate && !charMemos.length ? '<p class="cal-day-empty">这天还没有安排</p>' : '')}
        ${charMemos.length ? `
          <div class="cal-char-memo-grid">
            ${charMemos.map((m) => renderCharMemoCard(m, state.characterById.get(m.characterId), state.timezone)).join('')}
          </div>
        ` : ''}
      </section>
    `;
  }

  function renderPeriodSection(state) {
    const t = state.periodTracker;
    const status = state.periodStatus;
    const statusLine = formatPeriodStatusLine(status);
    const alreadyRecorded = t.history.includes(selectedDayTs);
    const reminderIds = new Set(t.reminderTargets.map((item) => item.characterId));
    const reminderNames = t.reminderTargets.map((item) => {
      const character = state.characterById.get(item.characterId);
      return character?.customNickname || character?.name || '';
    }).filter(Boolean);
    const reminderChips = state.characters.map((character) => `
      <button type="button" class="cal-remind-chip cal-period-character-chip${reminderIds.has(character.id) ? ' is-active' : ''}" data-char-id="${esc(character.id)}" aria-pressed="${reminderIds.has(character.id) ? 'true' : 'false'}">${esc(character.customNickname || character.name)}</button>
    `).join('');
    const editableStart = t.active?.startDayTs || t.history[t.history.length - 1] || 0;
    const editableLabel = t.active ? '当前开始日' : '最近一次开始日';
    const nextStartLine = t.history.length && status.nextStart
      ? `下次预计 ${formatShortDate(status.nextStart)}`
      : '';
    return `
      <section class="scrapbook-card cal-section cal-period-card">
        <div class="cal-section-title">经期记录</div>
        <label class="cal-toggle-row">
          <span>快到日子提醒 TA 关心</span>
          <input type="checkbox" class="cal-period-remind-toggle" ${t.remindAi ? 'checked' : ''} />
        </label>
        ${t.remindAi ? `
          <div class="cal-period-character-picker">
            <span class="cal-create-remind-label">选择知道的 TA</span>
            <div class="cal-create-chip-row cal-period-character-row">${reminderChips}</div>
          </div>
        ` : ''}
        <p class="cal-period-status${status.phase === 'during' ? ' is-during' : ''}${!statusLine ? ' is-empty' : ''}">${statusLine ? esc(statusLine) : '还没有记录'}</p>
        ${nextStartLine ? `<p class="cal-period-status">${esc(nextStartLine)}${status.predicted ? ' · 预测' : ''}</p>` : ''}
        ${reminderNames.length ? `<p class="cal-period-status">由 ${esc(reminderNames.join('、'))} 低频关心</p>` : (t.remindAi ? '<p class="cal-period-status is-empty">还未选择关心角色</p>' : '')}
        <div class="cal-period-actions">
          <button type="button" class="btn btn-soft btn-sm cal-period-record" data-recorded="${alreadyRecorded ? '1' : '0'}">${alreadyRecorded ? `取消 ${esc(formatShortDate(selectedDayTs))} 的记录` : `记一天：${esc(formatShortDate(selectedDayTs))}`}</button>
          <button type="button" class="btn btn-outline btn-sm cal-period-settings-toggle">周期设置</button>
        </div>
        ${editableStart ? `
          <div class="cal-period-record-editor" data-start-ts="${editableStart}">
            <label class="cal-period-date-field">
              <span>${editableLabel}</span>
              <input type="date" class="form-input cal-period-start-date" value="${toDateInputValue(editableStart)}" />
            </label>
            <div class="cal-period-edit-actions">
              <button type="button" class="btn btn-outline btn-sm cal-period-start-save">保存日期</button>
              <button type="button" class="btn btn-outline btn-sm cal-period-start-delete">删除这次</button>
            </div>
          </div>
        ` : ''}
        ${showPeriodSettings ? `
          <div class="cal-period-settings">
            <label class="cal-period-num-field">
              <span>周期天数</span>
              <input type="number" class="form-input cal-period-cycle" min="20" max="45" value="${t.cycleDays}" />
            </label>
            <label class="cal-period-num-field">
              <span>经期天数</span>
              <input type="number" class="form-input cal-period-days" min="2" max="10" value="${t.periodDays}" />
            </label>
          </div>
        ` : ''}
      </section>
    `;
  }

  async function paint() {
    const state = await loadState();
    const modeLabel = state.reconvergeDebtMs > 0
      ? `等现实追上中 · 还差约 ${formatGapHint(state.reconvergeDebtMs)}`
      : (state.mode === TIME_MODE_VIRTUAL ? '虚拟时间' : '现实同步');
    const monthLabel = `${viewYear}年${viewMonth + 1}月`;
    const timezoneLabel = state.timezonePreference
      ? findTimezoneOptionLabel(state.timezonePreference)
      : `跟随设备（${findTimezoneOptionLabel(state.timezone)}）`;
    const timezoneOptions = TIMEZONE_OPTION_GROUPS.map((group) => `
      <optgroup label="${esc(group.label)}">
        ${group.options.map((option) => `<option value="${esc(option.id)}" ${option.id === state.timezonePreference ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}
      </optgroup>
    `).join('');
    const knownTimezoneIds = new Set(TIMEZONE_OPTION_GROUPS.flatMap((group) => group.options.map((option) => option.id)));
    const savedCustomTimezone = state.timezonePreference && !knownTimezoneIds.has(state.timezonePreference)
      ? `<option value="${esc(state.timezonePreference)}" selected>${esc(state.timezonePreference)}</option>`
      : '';
    const prevScrollTop = container.querySelector('.cal-scroll')?.scrollTop || 0;

    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn cal-back" aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">日程表</h1>
        <button type="button" class="navbar-btn cal-tutorial" aria-label="教程">${icon('time')}</button>
      </header>
      <main class="cal-scroll scrapbook-scroll">
        <section class="scrapbook-card cal-hero">
          <span class="scrapbook-tape is-peach" aria-hidden="true"></span>
          <div class="cal-hero-top">
            <span class="cal-mode-badge ${state.mode === TIME_MODE_VIRTUAL ? 'is-virtual' : ''}">${esc(modeLabel)}</span>
            ${state.holiday ? `<span class="cal-holiday-badge">${esc(state.holiday.title)}</span>` : ''}
          </div>
          <div class="cal-now-line">${esc(formatPromptTimeLine(state.nowTs, state.timezone))}</div>
          ${state.holidayLine ? `<p class="cal-holiday-hint">${esc(state.holidayLine)}</p>` : ''}
        </section>

        <section class="scrapbook-card cal-section cal-month-card">
          <div class="cal-month-head">
            <button type="button" class="cal-month-nav" data-nav="-1" aria-label="上个月">${icon('chevron')}</button>
            <strong class="cal-month-label">${esc(monthLabel)}</strong>
            <button type="button" class="cal-month-nav is-next" data-nav="1" aria-label="下个月">${icon('chevron')}</button>
          </div>
          ${renderMonthGrid(state.cells, { memoDayMap: state.memoDayMap, periodDayMap: state.periodDayMap, selectedDayTs })}
        </section>

        ${renderDayPanel(state)}

        ${renderPeriodSection(state)}

        <button type="button" class="cal-advanced-toggle">${showAdvanced ? '收起时间与假期设置' : '时间与假期设置'} ${icon('chevron')}</button>

        ${showAdvanced ? `
        <section class="scrapbook-card cal-section">
          <div class="cal-section-title">时间模式</div>
          <div class="cal-mode-seg">
            <button type="button" class="cal-mode-btn ${state.mode === TIME_MODE_REAL ? 'is-active' : ''}" data-mode="${TIME_MODE_REAL}">现实同步</button>
            <button type="button" class="cal-mode-btn ${state.mode === TIME_MODE_VIRTUAL ? 'is-active' : ''}" data-mode="${TIME_MODE_VIRTUAL}">虚拟时间</button>
          </div>
          <label class="cal-toggle-row" style="margin-top:12px;">
            <span>切到后台时暂停剧情时间</span>
            <input type="checkbox" class="cal-background-time-pause" ${state.pauseOnBackground ? 'checked' : ''} />
          </label>
          <label class="api-field cal-timezone-field">
            <span class="api-field-label">我的时区</span>
            <select class="form-input cal-timezone-select">
              <option value="" ${state.timezonePreference ? '' : 'selected'}>跟随设备</option>
              ${savedCustomTimezone}
              ${timezoneOptions}
            </select>
            <small class="cal-timezone-current">当前：${esc(timezoneLabel)}</small>
          </label>
          <label class="cal-toggle-row" style="margin-top:12px;">
            <span>屏蔽 AI 时间感应</span>
            <input type="checkbox" class="cal-ai-time-toggle" ${state.aiTimeBlind ? 'checked' : ''} />
          </label>
        </section>

        <section class="scrapbook-card cal-section">
          <div class="cal-section-title">推进</div>
          <div class="cal-chip-row">
            <button type="button" class="btn btn-sm btn-soft cal-advance" data-delta="1800000">+30 分</button>
            <button type="button" class="btn btn-sm btn-soft cal-advance" data-delta="3600000">+1 小时</button>
            <button type="button" class="btn btn-sm btn-soft cal-advance" data-delta="86400000">+1 天</button>
          </div>
          <label class="api-field cal-custom-delta">
            <span class="api-field-label">自定义跨度</span>
            <select class="form-input cal-delta-select">
              <option value="900000">15 分钟</option>
              <option value="7200000">2 小时</option>
              <option value="43200000">半天</option>
              <option value="604800000">一周</option>
              <option value="2592000000">一个月</option>
            </select>
          </label>
          <button type="button" class="btn btn-primary btn-block cal-advance-custom">按所选跨度推进</button>
        </section>

        <section class="scrapbook-card cal-section">
          <div class="cal-section-title">跳转到</div>
          <label class="api-field">
            <span class="api-field-label">日期与时间</span>
            <input type="datetime-local" class="form-input cal-jump-input" value="${esc(toDatetimeLocalValue(state.nowTs, state.timezone))}" />
          </label>
          <button type="button" class="btn btn-soft btn-block cal-jump-btn">跳转到该时刻</button>
        </section>

        <section class="scrapbook-card cal-section">
          <label class="cal-toggle-row">
            <span>节假日注入角色语境</span>
            <input type="checkbox" class="cal-holiday-toggle" ${state.holidayOn ? 'checked' : ''} />
          </label>
        </section>

        ${state.upcoming.length ? `
        <section class="scrapbook-card cal-section">
          <div class="cal-section-title">临近假期</div>
          <ul class="cal-upcoming-list">
            ${state.upcoming.map((h) => `<li>${esc(formatHolidayRange(h))}</li>`).join('')}
          </ul>
        </section>
        ` : ''}
        ` : ''}
      </main>
    `;

    const scrollEl = container.querySelector('.cal-scroll');
    if (scrollEl && prevScrollTop) scrollEl.scrollTop = prevScrollTop;

    container.querySelector('.cal-back')?.addEventListener('click', () => back());
    container.querySelector('.cal-tutorial')?.addEventListener('click', () => {
      navigate('tutorial', { section: 'time' });
    });

    container.querySelectorAll('.cal-mode-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (busy) return;
        const mode = String(btn.dataset.mode || '');
        if (mode === state.mode) return;
        busy = true;
        try {
          const next = await setTimeMode(userId, mode);
          // 时间债未追平时不回拨世界钟（避免新消息时间戳倒挂到线下收纳之前）。
          if (mode === TIME_MODE_REAL && next?.timeMode === TIME_MODE_VIRTUAL && next?.reconverge === true) {
            const debt = Math.max(0, Number(next.anchorVirtual || 0) - Date.now());
            showToast(`剧情时间还领先现实约 ${formatGapHint(debt)}，会等现实自然追上后自动恢复现实同步；确需立即回拨可用下方「跳转到」`, 6000);
          } else {
            showToast(mode === TIME_MODE_REAL ? '已切换为现实同步' : '已切换为虚拟时间');
          }
          await paint();
        } finally {
          busy = false;
        }
      });
    });

    container.querySelector('.cal-timezone-select')?.addEventListener('change', async (e) => {
      if (busy) return;
      busy = true;
      try {
        const preference = String(e.target.value || '').trim();
        await setUserTimezone(userId, preference);
        user = await saveUserRecord({ ...user, timezone: preference });
        const effective = await getUserTimezone(userId);
        const localToday = zonedDateProxy(await getNowForUser(userId), effective);
        viewYear = localToday.getFullYear();
        viewMonth = localToday.getMonth();
        selectedDayTs = startOfDayTs(localToday.getTime());
        showToast(preference ? `已切换到 ${findTimezoneOptionLabel(preference)}` : '已改为跟随设备时区');
        await paint();
      } catch (_) {
        showToast('时区设置未保存，请重试');
      } finally {
        busy = false;
      }
    });

    const doAdvance = async (deltaMs) => {
      if (busy || !deltaMs) return;
      busy = true;
      try {
        const next = await advanceVirtualTime(userId, deltaMs);
        showToast(`已推进至 ${formatPromptTimeLine(next, state.timezone)}`);
        await paint();
      } finally {
        busy = false;
      }
    };

    container.querySelectorAll('.cal-advance').forEach((btn) => {
      btn.addEventListener('click', () => doAdvance(Number(btn.dataset.delta || 0)));
    });
    container.querySelector('.cal-advance-custom')?.addEventListener('click', () => {
      const delta = Number(container.querySelector('.cal-delta-select')?.value || 0);
      doAdvance(delta);
    });

    container.querySelector('.cal-jump-btn')?.addEventListener('click', async () => {
      if (busy) return;
      const ts = parseDatetimeLocalValue(container.querySelector('.cal-jump-input')?.value, state.timezone);
      if (!Number.isFinite(ts)) {
        showToast('请选择有效时间');
        return;
      }
      busy = true;
      try {
        await setVirtualNow(userId, ts);
        showToast(`已跳转至 ${formatPromptTimeLine(ts, state.timezone)}`);
        const localJump = zonedDateProxy(ts, state.timezone);
        viewYear = localJump.getFullYear();
        viewMonth = localJump.getMonth();
        selectedDayTs = startOfDayTs(localJump.getTime());
        await paint();
      } finally {
        busy = false;
      }
    });

    container.querySelectorAll('.cal-page-cell[data-day-ts]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ts = Number(btn.dataset.dayTs || 0);
        if (!ts) return;
        selectedDayTs = ts;
        showCreate = false;
        paint();
      });
    });

    container.querySelector('.cal-holiday-toggle')?.addEventListener('change', async (e) => {
      const on = !!e.target.checked;
      await setHolidayPromptEnabled(userId, on);
      showToast(on ? '已开启节假日注入' : '已关闭节假日注入');
      await paint();
    });

    container.querySelector('.cal-ai-time-toggle')?.addEventListener('change', async (e) => {
      const on = !!e.target.checked;
      await setAiTimeBlind(userId, on);
      showToast(on ? '已屏蔽 AI 时间感应' : '已恢复 AI 时间感应');
      await paint();
    });

    container.querySelector('.cal-background-time-pause')?.addEventListener('change', async (e) => {
      const on = !!e.target.checked;
      await setPauseTimeOnBackground(userId, on);
      showToast(on ? '切到后台时将暂停剧情时间' : '剧情时间将继续随现实流逝');
      await paint();
    });

    container.querySelectorAll('.cal-month-nav').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const step = Number(btn.dataset.nav || 0);
        viewMonth += step;
        if (viewMonth < 0) {
          viewMonth = 11;
          viewYear -= 1;
        } else if (viewMonth > 11) {
          viewMonth = 0;
          viewYear += 1;
        }
        await paint();
      });
    });

    container.querySelector('.cal-advanced-toggle')?.addEventListener('click', async () => {
      if (!showAdvanced) {
        const ok = await confirmTimeAdjustmentNotice();
        if (!ok) return;
      }
      showAdvanced = !showAdvanced;
      paint();
    });

    // ── 日程备忘 ──
    container.querySelector('.cal-day-add')?.addEventListener('click', () => {
      showCreate = !showCreate;
      if (showCreate) createDraft = { title: '', time: '09:00', note: '', characterId: '' };
      paint();
    });

    container.querySelector('.cal-create-cancel')?.addEventListener('click', () => {
      showCreate = false;
      paint();
    });

    container.querySelectorAll('.cal-create-remind .cal-remind-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        syncDraftFromForm();
        createDraft.characterId = String(chip.dataset.charId || '');
        paint();
      });
    });

    container.querySelector('.cal-create-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const form = e.target;
      const title = String(form.querySelector('.cal-create-title')?.value || '').trim();
      const timeValue = String(form.querySelector('.cal-create-time')?.value || '').trim();
      const note = String(form.querySelector('.cal-create-note')?.value || '').trim();
      if (!title) {
        showToast('先填一下要做什么');
        return;
      }
      const ts = combineDayAndTime(selectedDayTs, timeValue, state.timezone);
      const wantsRemind = !!createDraft.characterId;
      if (wantsRemind && !state.characterById.has(createDraft.characterId)) {
        showToast('这位提醒人不可用，请重新选择');
        createDraft.characterId = '';
        await paint();
        return;
      }
      if (wantsRemind && ts <= state.nowTs) {
        showToast('提醒时间需晚于现在');
        return;
      }
      busy = true;
      try {
        await addUserMemo(userId, {
          ts,
          title,
          note,
          source: wantsRemind ? MEMO_SOURCE_CHARACTER : MEMO_SOURCE_USER,
          characterId: createDraft.characterId,
          remind: wantsRemind,
        });
        showToast(wantsRemind ? '已保存，到点会提醒你' : '已保存');
        showCreate = false;
        createDraft = { title: '', time: '09:00', note: '', characterId: '' };
        await paint();
      } finally {
        busy = false;
      }
    });

    container.querySelectorAll('.cal-memo-del, .cal-char-memo-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = String(btn.dataset.memoId || '');
        if (!id) return;
        await removeUserMemo(userId, id);
        showToast('已删除');
        await paint();
      });
    });

    // ── 经期记录 ──
    container.querySelector('.cal-period-remind-toggle')?.addEventListener('change', async (e) => {
      await savePeriodTracker(userId, { remindAi: !!e.target.checked });
      showToast(e.target.checked ? '已开启，请选择知道的 TA' : '已关闭');
      await paint();
    });

    container.querySelectorAll('.cal-period-character-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        if (busy) return;
        const characterId = String(chip.dataset.charId || '').trim();
        const character = state.characterById.get(characterId);
        if (!character) return;
        busy = true;
        try {
          const current = state.periodTracker.reminderTargets;
          const selected = current.some((item) => item.characterId === characterId);
          let nextTargets;
          if (selected) {
            nextTargets = current.filter((item) => item.characterId !== characterId);
          } else {
            const chat = await ensurePrivateChat(
              userId,
              characterId,
              character.customNickname || character.name || '',
            );
            nextTargets = [...current, { characterId, chatId: chat.id }];
          }
          await setPeriodReminderTargets(userId, nextTargets);
          showToast(selected ? `已取消让 ${character.customNickname || character.name} 知道` : `会让 ${character.customNickname || character.name} 知道`);
          await paint();
        } finally {
          busy = false;
        }
      });
    });

    container.querySelector('.cal-period-record')?.addEventListener('click', async (e) => {
      if (busy) return;
      busy = true;
      try {
        const recorded = e.target.dataset.recorded === '1';
        if (recorded) {
          await removePeriodStart(userId, selectedDayTs);
          showToast('已取消这天的记录');
        } else {
          await recordPeriodStart(userId, selectedDayTs);
          showToast('已记录');
        }
        await paint();
      } finally {
        busy = false;
      }
    });

    container.querySelector('.cal-period-settings-toggle')?.addEventListener('click', () => {
      showPeriodSettings = !showPeriodSettings;
      paint();
    });

    container.querySelector('.cal-period-start-save')?.addEventListener('click', async () => {
      if (busy) return;
      const editor = container.querySelector('.cal-period-record-editor');
      const oldDayTs = Number(editor?.dataset.startTs || 0);
      const nextDayTs = parseDateInputValue(editor?.querySelector('.cal-period-start-date')?.value);
      if (!oldDayTs || !Number.isFinite(nextDayTs)) {
        showToast('请选择有效的开始日期');
        return;
      }
      if (oldDayTs === nextDayTs) {
        showToast('开始日期没有变化');
        return;
      }
      busy = true;
      try {
        await replacePeriodStart(userId, oldDayTs, nextDayTs);
        showToast(`已改为 ${formatShortDate(nextDayTs)}`);
        await paint();
      } finally {
        busy = false;
      }
    });

    container.querySelector('.cal-period-start-delete')?.addEventListener('click', async () => {
      if (busy) return;
      const oldDayTs = Number(container.querySelector('.cal-period-record-editor')?.dataset.startTs || 0);
      if (!oldDayTs) return;
      busy = true;
      try {
        await removePeriodStart(userId, oldDayTs);
        showToast('已删除这次经期记录');
        await paint();
      } finally {
        busy = false;
      }
    });

    container.querySelector('.cal-period-cycle')?.addEventListener('change', async (e) => {
      await savePeriodTracker(userId, { cycleDays: Number(e.target.value) || 28 });
      await paint();
    });

    container.querySelector('.cal-period-days')?.addEventListener('change', async (e) => {
      await savePeriodTracker(userId, { periodDays: Number(e.target.value) || 5 });
      await paint();
    });
  }

  await paint();
}
