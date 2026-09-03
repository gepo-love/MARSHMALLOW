import { icon } from './svg-icons.js';
import { showToast } from './toast.js';
import {
  advanceVirtualTime,
  formatPromptTimeLine,
  getNowForUser,
  getUserTimezone,
} from '../core/time-mode.js';
import { createOfflineStoryCard } from '../core/chat/offline-story-card.js';
import { OFFLINE_FAST_FORWARD_EVENT_TEXT, persistActiveEvent } from '../core/chat/active-event.js';
import { getChat } from '../core/chat-store.js';
import {
  listOfflinePresetOptions,
  loadOfflineFastForwardPresetIds,
  saveOfflineFastForwardPresetIds,
} from '../core/preset-store.js';
import {
  runEventSlotWeiboFastForward,
  GENERIC_OFFLINE_FF_BACKGROUND,
} from '../core/weibo/event-slot-weibo.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 「线下小剧场」：生成单卡线下片段，也可顺带推进虚拟时间。
 */
export async function openOfflineFastForwardModal(ctx = {}) {
  const host = document.getElementById('modal-container');
  if (!host || !ctx.chat?.id) return;

  const user = ctx.user;
  const userId = user?.id || '';
  let busy = false;
  const presetOptions = await listOfflinePresetOptions().catch(() => []);
  const availablePresetIds = presetOptions.map((item) => String(item.id || '').trim()).filter(Boolean);
  const initialPresetStyleIds = await loadOfflineFastForwardPresetIds(userId, availablePresetIds)
    .catch(() => []);
  const initialParticipantIds = [...new Set(
    (Array.isArray(ctx.defaultParticipantIds) ? ctx.defaultParticipantIds : (ctx.chat?.participants || []))
      .map((id) => String(id || '').trim())
      .filter((id) => id && id !== 'user'),
  )];
  const initialUserPresent = ctx.defaultUserPresent === undefined
    ? (ctx.chat?.participants || []).includes('user')
    : ctx.defaultUserPresent === true;
  const suppliedParticipantOptions = Array.isArray(ctx.participantOptions) ? ctx.participantOptions : [];
  const participantOptions = initialParticipantIds.map((id) => {
    const supplied = suppliedParticipantOptions.find((item) => String(item?.id || '').trim() === id);
    return { id, name: String(supplied?.name || supplied?.label || id).trim() || id };
  });

  function close() {
    if (busy) return;
    host.classList.remove('active');
    host.innerHTML = '';
  }

  host.innerHTML = `
    <div class="modal-overlay modal-sheet-center" data-offline-ff-overlay>
      <div class="modal-sheet modal-sheet-tall scrapbook-card offline-ff-sheet" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h3>线下小剧场</h3>
          <button type="button" class="navbar-btn modal-close-btn offline-ff-close" aria-label="关闭">${icon('close')}</button>
        </header>
        <div class="modal-body offline-ff-body" data-ime-scroll-region>
          <div class="api-field">
            <span class="api-field-label">类型</span>
            <div class="offline-ff-mode-list">
              <label class="offline-ff-mode-item">
                <input type="radio" name="offline-ff-mode" value="story" checked />
                <span><strong>线下小剧场</strong><small>写一段当下发生的线下片段。</small></span>
              </label>
              <label class="offline-ff-mode-item">
                <input type="radio" name="offline-ff-mode" value="time+story" />
                <span><strong>时间流逝 + 小剧场</strong><small>推进故事时间，再写期间发生的片段。</small></span>
              </label>
              <label class="offline-ff-mode-item">
                <input type="radio" name="offline-ff-mode" value="memory" />
                <span><strong>回忆小剧场</strong><small>补写过去已经发生的一段片段。</small></span>
              </label>
              <label class="offline-ff-mode-item">
                <input type="radio" name="offline-ff-mode" value="time" />
                <span><strong>仅推进时间</strong><small>不生成小剧场。</small></span>
              </label>
            </div>
          </div>
          <div class="offline-ff-story-fields">
            <div class="api-field">
              <span class="api-field-label">参与人</span>
              <div class="offline-ff-participants">
                ${participantOptions.map((item) => `
                  <label class="offline-ff-check-item">
                    <input type="checkbox" name="offline-ff-participant" value="${esc(item.id)}" ${initialParticipantIds.includes(item.id) ? 'checked' : ''} />
                    <span>${esc(item.name)}</span>
                  </label>
                `).join('') || '<span class="text-hint">还没有可选角色</span>'}
              </div>
            </div>
            <label class="offline-ff-check-item offline-ff-user-present">
              <input type="checkbox" class="offline-ff-user" ${initialUserPresent ? 'checked' : ''} />
              <span>我也在现场</span>
            </label>
          </div>
          <label class="api-field offline-ff-delta-wrap">
            <span class="api-field-label">时间跨度</span>
            <select class="form-input offline-ff-delta">
              <option value="1800000">半小时</option>
              <option value="3600000">1 小时</option>
              <option value="7200000">2 小时</option>
              <option value="43200000">半天</option>
              <option value="86400000" selected>一天</option>
              <option value="604800000">一周</option>
              <option value="1296000000">半个月</option>
              <option value="2592000000">一个月</option>
            </select>
          </label>
          <label class="offline-ff-weibo-wrap">
            <input type="checkbox" class="offline-ff-weibo" /> 同步生成微博
          </label>
          <div class="offline-ff-story-fields">
            <div class="off-num-row offline-ff-word-range">
              <label class="api-field off-num">
                <span class="api-field-label">字数下限</span>
                <input type="number" class="form-input offline-ff-story-wmin" min="80" step="50" value="300" />
              </label>
              <label class="api-field off-num">
                <span class="api-field-label">上限</span>
                <input type="number" class="form-input offline-ff-story-wmax" min="120" step="50" value="700" />
              </label>
            </div>
            <label class="api-field">
              <span class="api-field-label">语气 / 氛围</span>
              <input type="text" class="form-input offline-ff-story-tone" value="日常推进" placeholder="如：日常推进、暧昧、剧情" />
            </label>
            <div class="api-field">
              <span class="api-field-label">文风预设</span>
              <div class="offline-ff-presets">
                ${presetOptions.map((item) => `
                  <label class="offline-ff-check-item">
                    <input type="checkbox" name="offline-ff-preset" value="${esc(item.id)}" ${initialPresetStyleIds.includes(String(item.id || '').trim()) ? 'checked' : ''} />
                    <span>${esc(item.name || item.id)}</span>
                  </label>
                `).join('') || '<span class="text-hint">跟随预设页默认开关</span>'}
              </div>
            </div>
            <label class="api-field">
              <span class="api-field-label">附加提示</span>
              <textarea class="form-input offline-ff-story-extra" rows="3" placeholder="可补充想强调的动作、场景、关系变化。"></textarea>
            </label>
          </div>
          <div class="offline-ff-status" hidden></div>
          <div class="offline-ff-actions">
            <button type="button" class="btn btn-outline offline-ff-cancel">取消</button>
            <button type="button" class="btn btn-primary offline-ff-confirm">确认</button>
          </div>
        </div>
      </div>
    </div>
  `;

  host.classList.add('active');
  const overlay = host.querySelector('[data-offline-ff-overlay]');
  const storyFields = [...host.querySelectorAll('.offline-ff-story-fields')];
  const weiboWrap = host.querySelector('.offline-ff-weibo-wrap');
  const deltaWrap = host.querySelector('.offline-ff-delta-wrap');
  const statusEl = host.querySelector('.offline-ff-status');

  const getMode = () => String(host.querySelector('input[name="offline-ff-mode"]:checked')?.value || 'story');
  const syncModeUi = () => {
    const mode = getMode();
    storyFields.forEach((field) => { field.style.display = mode === 'time' ? 'none' : 'flex'; });
    if (weiboWrap) weiboWrap.style.display = (mode === 'story' || mode === 'memory') ? 'none' : 'flex';
    if (deltaWrap) deltaWrap.style.display = (mode === 'story' || mode === 'memory') ? 'none' : 'block';
  };
  syncModeUi();
  host.querySelectorAll('input[name="offline-ff-mode"]').forEach((el) => el.addEventListener('change', syncModeUi));
  const readPresetStyleIds = () => [...host.querySelectorAll('input[name="offline-ff-preset"]:checked')]
    .map((input) => String(input.value || '').trim())
    .filter(Boolean);
  host.querySelectorAll('input[name="offline-ff-preset"]').forEach((input) => {
    input.addEventListener('change', () => {
      saveOfflineFastForwardPresetIds(userId, readPresetStyleIds(), availablePresetIds).catch(() => {});
    });
  });

  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  host.querySelector('.offline-ff-sheet')?.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('.offline-ff-close')?.addEventListener('click', close);
  host.querySelector('.offline-ff-cancel')?.addEventListener('click', close);

  host.querySelector('.offline-ff-confirm')?.addEventListener('click', async () => {
    const mode = getMode();
    const advancesTime = mode === 'time' || mode === 'time+story';
    const deltaMs = Number(host.querySelector('.offline-ff-delta')?.value || 86400000);
    const doWeibo = !!host.querySelector('.offline-ff-weibo')?.checked;
    const wordMin = Math.max(80, Number(host.querySelector('.offline-ff-story-wmin')?.value || 300) || 300);
    const wordMax = Math.max(wordMin, Number(host.querySelector('.offline-ff-story-wmax')?.value || 700) || 700);
    const targetWords = Math.round((wordMin + wordMax) / 2);
    const toneLabel = String(host.querySelector('.offline-ff-story-tone')?.value || '').trim();
    const extraPrompt = String(host.querySelector('.offline-ff-story-extra')?.value || '').trim();
    const participantIds = [...host.querySelectorAll('input[name="offline-ff-participant"]:checked')]
      .map((input) => String(input.value || '').trim())
      .filter(Boolean);
    const userPresent = !!host.querySelector('.offline-ff-user')?.checked;
    const presetStyleIds = readPresetStyleIds();
    if (mode !== 'time' && !participantIds.length) {
      showToast('请至少选择一位参与角色');
      return;
    }
    if (mode !== 'time' && participantIds.length > 6) {
      showToast('一次最多选择 6 位参与角色');
      return;
    }
    await saveOfflineFastForwardPresetIds(userId, presetStyleIds, availablePresetIds).catch(() => {});
    const timeLabelMap = {
      1800000: '半小时后',
      3600000: '1小时后',
      7200000: '2小时后',
      43200000: '半天后',
      86400000: '次日',
      604800000: '一周后',
      1296000000: '半个月后',
      2592000000: '一个月后',
    };
    const timeLabel = advancesTime ? (timeLabelMap[deltaMs] || '') : '';
    const cbtn = host.querySelector('.offline-ff-confirm');
    const cancelBtn = host.querySelector('.offline-ff-cancel');
    busy = true;
    if (cbtn) {
      cbtn.disabled = true;
      cbtn.textContent = mode === 'time' ? '推进中…' : '生成中…';
    }
    if (cancelBtn) cancelBtn.disabled = true;
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = mode === 'time'
        ? (doWeibo ? '正在推进时间并生成微博，请稍候。' : '正在推进时间，请稍候。')
        : mode === 'memory'
          ? '正在生成回忆补充小剧场，请稍候。'
          : mode === 'story'
            ? '正在生成小剧场卡片，请稍候。'
            : (doWeibo ? '正在推进时间、生成小剧场，并让微博跟随本次推进，请稍候。' : '正在推进时间并生成小剧场，请稍候。');
    }
    try {
      let storyCard = null;
      if (advancesTime) {
        await advanceVirtualTime(userId, deltaMs);
        try {
          await persistActiveEvent(ctx.chat.id, {
            text: OFFLINE_FAST_FORWARD_EVENT_TEXT,
            variant: 'offline-fast-forward',
          });
        } catch (_) { /* optional */ }
        const updated = await getChat(ctx.chat.id);
        if (updated) ctx.onChatUpdated?.(updated);
      }
      if (mode !== 'time') {
        storyCard = await createOfflineStoryCard(
          { ...ctx, chat: ctx.chat, chatId: ctx.chat.id, user, messages: ctx.messages || [] },
          {
            mode: mode === 'memory' ? 'memory' : mode === 'story' ? 'story' : 'time+story',
            targetWords,
            wordMin,
            wordMax,
            timeLabel,
            toneLabel,
            extraPrompt,
            participantIds,
            userPresent,
            presetStyleIds,
          },
        );
      }
      if (advancesTime && doWeibo) {
        const summary = String(storyCard?.metadata?.summary || '').trim();
        const title = String(storyCard?.metadata?.title || '').trim();
        const bg = summary || title
          ? `【基于本次时间推进生成的小剧场】【以下为已经发生过的事件摘要，当前时间已推进到事件之后，请勿复读原事件】${title ? `标题：${title}；` : ''}${summary ? `摘要：${summary}` : ''}`
          : GENERIC_OFFLINE_FF_BACKGROUND;
        await runEventSlotWeiboFastForward({
          userId,
          user,
          backgroundEvent: bg,
          deltaMs: 0,
          focusCharacterIds: participantIds,
        });
      }
      const storyIncomplete = storyCard
        && String(storyCard.metadata?.generationStatus || 'complete') !== 'complete';
      const actionText = storyIncomplete
        ? '已保留未完成的小剧场返回'
        : mode === 'time'
          ? '时间已推进'
          : mode === 'memory'
            ? '已生成回忆补充小剧场'
            : mode === 'story'
              ? '已生成小剧场'
              : '时间已推进，并生成了小剧场';
      const weiboSuffix = mode !== 'story' && mode !== 'memory' && doWeibo ? '，微博已尝试生成并转发' : '';
      let timeSuffix = '';
      if (advancesTime && userId) {
        const [nowTs, timeZone] = await Promise.all([
          getNowForUser(userId),
          getUserTimezone(userId),
        ]);
        const nowLine = formatPromptTimeLine(nowTs, timeZone);
        timeSuffix = ` · 当前 ${nowLine}`;
      }
      if (statusEl) {
        statusEl.textContent = `${actionText}${weiboSuffix ? `${weiboSuffix}。` : '。'}${timeSuffix}`;
      }
      showToast(`${actionText}${weiboSuffix}${timeSuffix}`);
      await ctx.reloadMessages?.();
      close();
    } catch (e) {
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = `失败：${esc(e?.message || e)}`;
      }
      showToast(`失败：${e?.message || e}`);
    } finally {
      busy = false;
      if (cbtn) {
        cbtn.disabled = false;
        cbtn.textContent = '确认';
      }
      if (cancelBtn) cancelBtn.disabled = false;
    }
  });
}
