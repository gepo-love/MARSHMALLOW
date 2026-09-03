import { icon } from './svg-icons.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 用户发起线下邀约的手账风表单。
 * resolve 一个 { place, activity, timeLabel, note, tone }；取消则 resolve(null)。
 */
export function openOfflineInviteModal(options = {}) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-container');
    if (!host) { resolve(null); return; }
    const partnerName = String(options.partnerName || '对方');
    host.classList.add('active');
    host.innerHTML = `
      <div class="modal-overlay" data-oi-overlay>
        <div class="modal-sheet scrapbook-card offline-invite-sheet" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h3>约 ${esc(partnerName)} 线下</h3>
            <button type="button" class="navbar-btn modal-close-btn" data-oi-close aria-label="关闭">${icon('back')}</button>
          </header>
          <div class="modal-body offline-invite-sheet-body">
            <div class="offline-invite-sheet-ribbon">递一张邀约卡</div>
            <label class="api-field">
              <span class="api-field-label">想约什么时候</span>
              <input type="text" class="form-input oi-time" placeholder="如：这周六下午" maxlength="40" />
            </label>
            <label class="api-field">
              <span class="api-field-label">去哪儿</span>
              <input type="text" class="form-input oi-place" placeholder="如：江边的旧书店" maxlength="60" />
            </label>
            <label class="api-field">
              <span class="api-field-label">一起做什么</span>
              <input type="text" class="form-input oi-activity" placeholder="如：逛逛书、喝杯热的" maxlength="80" />
            </label>
            <label class="api-field">
              <span class="api-field-label">想说的话（可留空）</span>
              <textarea class="form-input oi-note" rows="2" placeholder="用你的口吻写一句邀约"></textarea>
            </label>
            <label class="api-field">
              <span class="api-field-label">氛围（可留空）</span>
              <input type="text" class="form-input oi-tone" placeholder="如：松弛、暧昧、热闹" maxlength="24" />
            </label>
            <button type="button" class="btn btn-primary oi-send">送出邀约</button>
          </div>
        </div>
      </div>
    `;
    let done = false;
    const close = (val) => {
      if (done) return;
      done = true;
      host.classList.remove('active');
      host.innerHTML = '';
      resolve(val);
    };
    host.querySelector('[data-oi-overlay]')?.addEventListener('click', () => close(null));
    host.querySelector('[data-oi-close]')?.addEventListener('click', () => close(null));
    host.querySelector('.offline-invite-sheet')?.addEventListener('click', (e) => e.stopPropagation());
    host.querySelector('.oi-send')?.addEventListener('click', () => {
      const place = String(host.querySelector('.oi-place')?.value || '').trim();
      const activity = String(host.querySelector('.oi-activity')?.value || '').trim();
      const timeLabel = String(host.querySelector('.oi-time')?.value || '').trim();
      const note = String(host.querySelector('.oi-note')?.value || '').trim();
      const tone = String(host.querySelector('.oi-tone')?.value || '').trim();
      if (!place && !activity && !note) {
        host.querySelector('.oi-activity')?.focus();
        return;
      }
      close({ place, activity, timeLabel, note, tone });
    });
    host.querySelector('.oi-time')?.focus();
  });
}
