import { icon } from './svg-icons.js';
import {
  DEFAULT_FORUM_AUTO,
  normalizeForumAutoPrefs,
} from '../core/forum/forum-auto.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const INTERVAL_OPTIONS = [
  [2, '每 2 小时'],
  [4, '每 4 小时'],
  [6, '每 6 小时'],
  [12, '每 12 小时'],
  [24, '每天 1 次'],
];

const DAILY_MAX_OPTIONS = [1, 2, 3, 5, 8];
const REPLY_COUNT_OPTIONS = [3, 5, 8, 10, 12];
const NEW_THREAD_REPLY_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 8];

/**
 * 论坛设置。保存时返回规范化配置，取消时返回 null。
 * @returns {Promise<object|null>}
 */
export function openForumSettingsModal({
  prefs = DEFAULT_FORUM_AUTO,
  sections = [],
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return Promise.resolve(null);
  const normalized = normalizeForumAutoPrefs(prefs, sections);
  const selectedIds = new Set(normalized.selectedSectionIds);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(value);
    };

    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay modal-sheet-center social-settings-overlay" data-forum-settings-overlay>
        <div class="modal-sheet moments-gen-sheet forum-settings-sheet social-settings-sheet" role="dialog" aria-modal="true" aria-labelledby="forum-settings-title">
          <header class="modal-header">
            <h3 id="forum-settings-title">论坛设置</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-forum-settings-cancel aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body moments-gen-body">
            <label class="api-field">
              <span class="api-field-label">帖子排序</span>
              <select class="form-input forum-thread-sort">
                <option value="activity"${normalized.threadSort === 'activity' ? ' selected' : ''}>最后发言</option>
                <option value="created"${normalized.threadSort === 'created' ? ' selected' : ''}>发帖时间</option>
              </select>
            </label>
            <label class="api-field">
              <span class="api-field-label">每次补评论</span>
              <select class="form-input forum-reply-count">
                ${REPLY_COUNT_OPTIONS.map((value) => `<option value="${value}"${value === normalized.replyGenerationCount ? ' selected' : ''}>${value} 条</option>`).join('')}
              </select>
            </label>
            <label class="api-field">
              <span class="api-field-label">每篇新帖初始回复</span>
              <select class="form-input forum-new-thread-reply-count">
                ${NEW_THREAD_REPLY_OPTIONS.map((value) => `<option value="${value}"${value === normalized.newThreadReplyCount ? ' selected' : ''}>${value} 条</option>`).join('')}
              </select>
            </label>
            <label class="chat-details-row chat-details-toggle">
              <span>补评论可带表情包</span>
              <input type="checkbox" class="forum-auto-stickers" ${normalized.allowStickers ? 'checked' : ''} />
            </label>
            <label class="chat-details-row chat-details-toggle">
              <span>定时自动更新</span>
              <input type="checkbox" class="forum-auto-enabled" ${normalized.enabled ? 'checked' : ''} />
            </label>
            <label class="api-field">
              <span class="api-field-label">更新频率</span>
              <select class="form-input forum-auto-interval">
                ${INTERVAL_OPTIONS.map(([value, label]) => `<option value="${value}"${value === normalized.intervalHours ? ' selected' : ''}>${esc(label)}</option>`).join('')}
              </select>
            </label>
            <label class="api-field">
              <span class="api-field-label">每天上限（批）</span>
              <select class="form-input forum-auto-dailymax">
                ${DAILY_MAX_OPTIONS.map((value) => `<option value="${value}"${value === normalized.dailyMaxBatches ? ' selected' : ''}>${value} 批</option>`).join('')}
              </select>
            </label>
            <div class="api-field">
              <span class="api-field-label">更新板块</span>
              <div class="moments-gen-check-list" role="radiogroup" aria-label="更新板块">
                <label class="chat-details-row chat-details-toggle">
                  <span>全部板块</span>
                  <input type="radio" name="forum-auto-scope" value="all" ${normalized.scope === 'all' ? 'checked' : ''} />
                </label>
                <label class="chat-details-row chat-details-toggle">
                  <span>当前板块</span>
                  <input type="radio" name="forum-auto-scope" value="current" ${normalized.scope === 'current' ? 'checked' : ''} />
                </label>
                <label class="chat-details-row chat-details-toggle">
                  <span>指定板块</span>
                  <input type="radio" name="forum-auto-scope" value="selected" ${normalized.scope === 'selected' ? 'checked' : ''} />
                </label>
              </div>
            </div>
            <div class="api-field forum-auto-section-field">
              <span class="api-field-label">指定板块</span>
              <div class="moments-gen-check-list">
                ${(Array.isArray(sections) ? sections : []).map((section) => `
                  <label class="chat-details-row chat-details-toggle">
                    <span>${esc(section?.name || section?.id || '未命名板块')}</span>
                    <input type="checkbox" class="forum-auto-section" value="${esc(section?.id)}" ${selectedIds.has(String(section?.id || '')) ? 'checked' : ''} />
                  </label>
                `).join('') || '<div class="chat-empty-hint">还没有板块</div>'}
              </div>
            </div>
            <label class="chat-details-row chat-details-toggle">
              <span>新帖子</span>
              <input type="checkbox" class="forum-auto-posts" ${normalized.generatePosts ? 'checked' : ''} />
            </label>
            <label class="chat-details-row chat-details-toggle">
              <span>新帖子允许生图</span>
              <input type="checkbox" class="forum-auto-images" ${normalized.allowImages ? 'checked' : ''} />
            </label>
            <label class="chat-details-row chat-details-toggle">
              <span>新帖子可含文字图</span>
              <input type="checkbox" class="forum-auto-text-images" ${normalized.allowTextImages ? 'checked' : ''} />
            </label>
            <label class="chat-details-row chat-details-toggle">
              <span>给旧帖补回复</span>
              <input type="checkbox" class="forum-auto-replies" ${normalized.enrichReplies ? 'checked' : ''} />
            </label>
            <label class="chat-details-row chat-details-toggle">
              <span>多角色与 NPC 互动</span>
              <input type="checkbox" class="forum-auto-multi-npc" ${normalized.multiNpcInteraction ? 'checked' : ''} />
            </label>
            <label class="chat-details-row chat-details-toggle">
              <span>路人头像随机取表情包</span>
              <input type="checkbox" class="forum-passerby-sticker-avatars" ${normalized.passerbyStickerAvatars ? 'checked' : ''} />
            </label>
          </div>
          <footer class="modal-footer">
            <button type="button" class="btn btn-outline" data-forum-settings-cancel>取消</button>
            <button type="button" class="btn btn-primary" data-forum-settings-save>保存</button>
          </footer>
        </div>
      </div>
    `;

    const syncSectionState = () => {
      const selectedScope = host.querySelector('input[name="forum-auto-scope"]:checked')?.value;
      const field = host.querySelector('.forum-auto-section-field');
      if (field) field.hidden = selectedScope !== 'selected';
    };
    host.querySelector('[data-forum-settings-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) finish(null);
    });
    host.querySelectorAll('[data-forum-settings-cancel]').forEach((button) => {
      button.addEventListener('click', () => finish(null));
    });
    host.querySelectorAll('input[name="forum-auto-scope"]').forEach((input) => {
      input.addEventListener('change', syncSectionState);
    });
    host.querySelector('[data-forum-settings-save]')?.addEventListener('click', () => {
      const selectedSectionIds = [...host.querySelectorAll('.forum-auto-section:checked')]
        .map((input) => String(input.value || '').trim())
        .filter(Boolean);
      finish(normalizeForumAutoPrefs({
        enabled: !!host.querySelector('.forum-auto-enabled')?.checked,
        intervalHours: Number(host.querySelector('.forum-auto-interval')?.value),
        dailyMaxBatches: Number(host.querySelector('.forum-auto-dailymax')?.value),
        scope: host.querySelector('input[name="forum-auto-scope"]:checked')?.value,
        selectedSectionIds,
        generatePosts: !!host.querySelector('.forum-auto-posts')?.checked,
        allowImages: !!host.querySelector('.forum-auto-images')?.checked,
        allowTextImages: !!host.querySelector('.forum-auto-text-images')?.checked,
        enrichReplies: !!host.querySelector('.forum-auto-replies')?.checked,
        multiNpcInteraction: !!host.querySelector('.forum-auto-multi-npc')?.checked,
        allowStickers: !!host.querySelector('.forum-auto-stickers')?.checked,
        replyGenerationCount: Number(host.querySelector('.forum-reply-count')?.value),
        newThreadReplyCount: Number(host.querySelector('.forum-new-thread-reply-count')?.value),
        threadSort: host.querySelector('.forum-thread-sort')?.value,
        passerbyStickerAvatars: !!host.querySelector('.forum-passerby-sticker-avatars')?.checked,
      }, sections));
    });
    syncSectionState();
  });
}
