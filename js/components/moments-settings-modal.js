import { icon } from './svg-icons.js';
import { MOMENTS_MIX_LEVELS, normalizeMomentsMix } from '../core/moments/moments-scenarios.js';
import { DEFAULT_MOMENTS_AUTO_GEN } from '../core/moments/moments-store.js';
import { getChatPlatformCopy } from '../core/chat/chat-platform-copy.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const INTERVAL_OPTIONS = [
  { value: 2, label: '每 2 小时' },
  { value: 4, label: '每 4 小时' },
  { value: 6, label: '每 6 小时' },
  { value: 12, label: '每 12 小时' },
  { value: 24, label: '每天 1 次' },
];

const DAILY_MAX_OPTIONS = [1, 2, 3, 5, 8];
const POST_COUNT_OPTIONS = [1, 2, 3, 4, 5];
const COMMENT_LEVEL_OPTIONS = [
  { value: 'low', label: '低频 · 随机 0–3 条' },
  { value: 'high', label: '高频 · 随机 3–8 条' },
];

function mixSelectHtml(cls, value) {
  return `
    <select class="form-input ${cls}">
      ${MOMENTS_MIX_LEVELS.map((l) => `<option value="${esc(l.id)}"${l.id === value ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}
    </select>
  `;
}

/**
 * 朋友圈生成设置（自动生成 + 内容占比 + 主要发帖人）。
 * @returns {Promise<{ genMix:object, autoGen:object }|null>} 保存返回新值，取消返回 null
 */
export function openMomentsSettingsModal({
  prefs = {},
  characters = [],
  platform,
} = {}) {
  const host = document.getElementById('modal-container');
  if (!host) return Promise.resolve(null);
  const platformCopy = getChatPlatformCopy(platform);

  const autoGen = { ...DEFAULT_MOMENTS_AUTO_GEN, ...(prefs.autoGen || {}) };
  const mix = normalizeMomentsMix(prefs.genMix || {});
  const selectedAuthors = new Set(autoGen.authorIds || []);

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
      <div class="modal-overlay modal-sheet-center social-settings-overlay" data-moments-settings-overlay>
        <div class="modal-sheet scrapbook-card moments-gen-sheet social-settings-sheet" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>${esc(platformCopy.momentsName)}设置</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-moments-settings-cancel aria-label="关闭">${icon('close')}</button>
          </header>
          <div class="modal-body moments-gen-body">
            <div class="api-field">
              <span class="api-field-label">内容占比</span>
              <div class="moments-gen-check-list">
                <label class="chat-details-row moments-settings-mix-row">
                  <span>和用户有关</span>
                  ${mixSelectHtml('moments-mix-user', mix.userRelated)}
                </label>
                <label class="chat-details-row moments-settings-mix-row">
                  <span>剧情 · 修罗场</span>
                  ${mixSelectHtml('moments-mix-drama', mix.drama)}
                </label>
                <label class="chat-details-row moments-settings-mix-row">
                  <span>分享 · 转发</span>
                  ${mixSelectHtml('moments-mix-share', mix.share)}
                </label>
              </div>
            </div>
            <label class="chat-details-row chat-details-toggle">
              <span>定时自动生成</span>
              <input type="checkbox" class="moments-auto-enabled" ${autoGen.enabled ? 'checked' : ''} />
            </label>
            <label class="api-field">
              <span class="api-field-label">手动每轮生成</span>
              <select class="form-input moments-manual-count">
                ${POST_COUNT_OPTIONS.map((n) => `<option value="${n}"${n === autoGen.manualPostCount ? ' selected' : ''}>${n} 条</option>`).join('')}
              </select>
            </label>
            <label class="api-field">
              <span class="api-field-label">自动每轮生成</span>
              <select class="form-input moments-auto-count">
                ${POST_COUNT_OPTIONS.map((n) => `<option value="${n}"${n === autoGen.autoPostCount ? ' selected' : ''}>${n} 条</option>`).join('')}
              </select>
            </label>
            <label class="api-field">
              <span class="api-field-label">补评论概率</span>
              <select class="form-input moments-comment-count">
                ${COMMENT_LEVEL_OPTIONS.map((option) => `<option value="${option.value}"${option.value === autoGen.reactionCommentLevel ? ' selected' : ''}>${option.label}</option>`).join('')}
              </select>
            </label>
            <label class="chat-details-row chat-details-toggle">
              <span>发布后自动补互动</span>
              <input type="checkbox" class="moments-auto-react-publish" ${autoGen.autoReactAfterPublish !== false ? 'checked' : ''} />
            </label>
            <label class="api-field">
              <span class="api-field-label">生成频率</span>
              <select class="form-input moments-auto-interval">
                ${INTERVAL_OPTIONS.map((o) => `<option value="${o.value}"${o.value === autoGen.intervalHours ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
              </select>
            </label>
            <label class="api-field">
              <span class="api-field-label">每天上限（批）</span>
              <select class="form-input moments-auto-dailymax">
                ${DAILY_MAX_OPTIONS.map((n) => `<option value="${n}"${n === autoGen.dailyMaxBatches ? ' selected' : ''}>${n} 批</option>`).join('')}
              </select>
            </label>
            <label class="chat-details-row chat-details-toggle">
              <span>聊完天后可能${esc(platformCopy.postVerb)}</span>
              <input type="checkbox" class="moments-auto-postchat" ${autoGen.postChatTrigger ? 'checked' : ''} />
            </label>
            <div class="api-field">
              <span class="api-field-label">自动生成内容（可多选）</span>
              <div class="moments-gen-check-list">
                <label class="chat-details-row chat-details-toggle moments-gen-check-item">
                  <span>生图</span>
                  <input type="checkbox" class="moments-auto-images" ${autoGen.allowImages ? 'checked' : ''} />
                </label>
                <label class="chat-details-row chat-details-toggle moments-gen-check-item">
                  <span>文字图</span>
                  <input type="checkbox" class="moments-auto-text-images" ${autoGen.allowTextImages ? 'checked' : ''} />
                </label>
                <label class="chat-details-row chat-details-toggle moments-gen-check-item">
                  <span>表情包</span>
                  <input type="checkbox" class="moments-auto-stickers" ${autoGen.allowStickers !== false ? 'checked' : ''} />
                </label>
              </div>
            </div>
            <div class="api-field">
              <span class="api-field-label">主要发帖人（不选 = 全部角色）</span>
              <div class="moments-gen-check-list moments-settings-author-list">
                ${characters.map((c) => `
                  <label class="chat-details-row chat-details-toggle moments-gen-check-item">
                    <span>${esc(c.name)}</span>
                    <input type="checkbox" class="moments-auto-author" value="${esc(c.id)}" ${selectedAuthors.has(c.id) ? 'checked' : ''} />
                  </label>
                `).join('') || '<div class="chat-empty-hint">还没有角色</div>'}
              </div>
            </div>
          </div>
          <footer class="modal-footer">
            <button type="button" class="btn btn-outline" data-moments-settings-cancel>取消</button>
            <button type="button" class="btn btn-primary" data-moments-settings-save>保存</button>
          </footer>
        </div>
      </div>
    `;

    host.querySelector('[data-moments-settings-overlay]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) finish(null);
    });
    host.querySelectorAll('[data-moments-settings-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => finish(null));
    });
    host.querySelector('[data-moments-settings-save]')?.addEventListener('click', () => {
      const genMix = normalizeMomentsMix({
        userRelated: host.querySelector('.moments-mix-user')?.value,
        drama: host.querySelector('.moments-mix-drama')?.value,
        share: host.querySelector('.moments-mix-share')?.value,
      });
      const authorIds = [...host.querySelectorAll('.moments-auto-author:checked')]
        .map((el) => String(el.value || '').trim())
        .filter(Boolean);
      finish({
        genMix,
        autoGen: {
          enabled: !!host.querySelector('.moments-auto-enabled')?.checked,
          intervalHours: Number(host.querySelector('.moments-auto-interval')?.value) || 6,
          dailyMaxBatches: Number(host.querySelector('.moments-auto-dailymax')?.value) || 3,
          manualPostCount: Number(host.querySelector('.moments-manual-count')?.value) || 3,
          autoPostCount: Number(host.querySelector('.moments-auto-count')?.value) || 2,
          reactionCommentLevel: host.querySelector('.moments-comment-count')?.value === 'low' ? 'low' : 'high',
          autoReactAfterPublish: !!host.querySelector('.moments-auto-react-publish')?.checked,
          authorIds,
          postChatTrigger: !!host.querySelector('.moments-auto-postchat')?.checked,
          allowImages: !!host.querySelector('.moments-auto-images')?.checked,
          allowTextImages: !!host.querySelector('.moments-auto-text-images')?.checked,
          allowStickers: !!host.querySelector('.moments-auto-stickers')?.checked,
        },
      });
    });
  });
}
