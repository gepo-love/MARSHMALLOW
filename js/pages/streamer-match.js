import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { createStreamerChannel, listStreamerChannelsForUser } from '../core/streamer-store.js';
import { generateStreamerPersonaAI } from '../core/streamer-ai.js';
import { STREAMER_POPULARITY_TIERS, STREAMER_CATEGORY_PRESETS } from '../data/streamer-presets.js';

function esc(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value = '') {
  return esc(value).replace(/'/g, '&#39;');
}

function setMatchPhase(container, active = false, text = '匹配中') {
  let overlay = container.querySelector('.anon-match-overlay');
  if (!active) {
    overlay?.remove();
    return;
  }
  if (!overlay) {
    container.insertAdjacentHTML('beforeend', `
      <div class="anon-match-overlay" aria-live="polite">
        <div class="anon-match-radar">
          <span></span><span></span><span></span>
        </div>
        <div class="anon-match-phase"></div>
      </div>
    `);
    overlay = container.querySelector('.anon-match-overlay');
  }
  const phase = overlay?.querySelector('.anon-match-phase');
  if (phase) phase.textContent = text;
}

/** 权重抽取：越久没看过权重越高，避免总刷到同一个 */
function pickWeightedChannel(channels = []) {
  const now = Date.now();
  const weighted = channels.map((c) => {
    const idleMs = Math.max(0, now - (c.lastVisitAt || 0));
    const idleDays = idleMs / 86400000;
    return { channel: c, weight: 1 + Math.min(8, idleDays) };
  });
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = Math.random() * total;
  for (const w of weighted) {
    roll -= w.weight;
    if (roll <= 0) return w.channel;
  }
  return weighted[weighted.length - 1]?.channel || null;
}

export default async function render(container) {
  const user = await ensureDefaultUser();

  const tierRadios = STREAMER_POPULARITY_TIERS.map((t, i) => `
    <label class="anon-match-option">
      <input type="radio" name="sms-tier" class="sms-tier" value="${escAttr(t.id)}" ${i === 0 ? 'checked' : ''} />
      <span class="anon-match-option-body">
        <strong>${esc(t.label)}</strong>
        <small>${esc(t.hint)}</small>
      </span>
    </label>`).join('');

  const categoryRadios = STREAMER_CATEGORY_PRESETS.filter((c) => c.id !== 'custom').map((c, i) => `
    <label class="anon-match-option">
      <input type="radio" name="sms-category" class="sms-category" value="${escAttr(c.id)}" ${i === 0 ? 'checked' : ''} />
      <span class="anon-match-option-body"><strong>${esc(c.label)}</strong></span>
    </label>`).join('');

  container.className = 'page anon-page anon-match-page anon-streamer-match-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">随机匹配主播</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="anon-scroll anon-match-scroll">
      <section class="anon-card">
        <div class="anon-section-title">只要新面孔？</div>
        <label class="anon-form-field" style="flex-direction:row;align-items:center;gap:8px;">
          <input type="checkbox" class="sms-only-new" />
          <span>跳过我已建的频道，现场生成一个陌生主播</span>
        </label>
        <label class="anon-form-field" style="flex-direction:row;align-items:center;gap:8px;">
          <input type="checkbox" class="sms-keep-new" checked />
          <span>保留到首页信息流（取消勾选则离开直播间后丢弃）</span>
        </label>
      </section>
      <section class="anon-card sms-new-face-detail">
        <div class="anon-section-title">新主播偏好（仅现场生成时生效）</div>
        <div class="anon-match-list">${tierRadios}</div>
      </section>
      <section class="anon-card sms-new-face-detail">
        <div class="anon-section-title">直播类型偏好</div>
        <div class="anon-match-list">${categoryRadios}</div>
      </section>
      <button type="button" class="btn btn-primary anon-match-start">开始匹配</button>
      <p class="text-hint anon-match-hint">匹配到已建频道会直接进房；匹配到新面孔会现场捏人格并进房。无封面时会尝试开局生图；也可在直播设置里上传背景。</p>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());

  container.querySelector('.anon-match-start')?.addEventListener('click', async () => {
    const btn = container.querySelector('.anon-match-start');
    const onlyNew = !!container.querySelector('.sms-only-new')?.checked;
    const keepNew = !!container.querySelector('.sms-keep-new')?.checked;
    if (btn) { btn.disabled = true; btn.textContent = '匹配中…'; }
    setMatchPhase(container, true, '搜索在线频道');
    try {
      // 只从「直播中」的频道里匹配，避免随机匹配到一个已下播的频道，看起来像是没匹配上
      const existing = (await listStreamerChannelsForUser(user.id)).filter((c) => c.status !== 'ended');
      let channel = null;
      if (!onlyNew && existing.length) {
        channel = pickWeightedChannel(existing);
      }
      if (!channel) {
        setMatchPhase(container, true, '正在捏一个新主播');
        const tierId = container.querySelector('.sms-tier:checked')?.value || 'small';
        const categoryId = container.querySelector('.sms-category:checked')?.value || 'chat';
        const categoryPreset = STREAMER_CATEGORY_PRESETS.find((c) => c.id === categoryId);
        const persona = await generateStreamerPersonaAI({
          category: categoryPreset?.label || '',
        });
        channel = await createStreamerChannel(user.id, {
          sourceType: 'generated',
          persona: {
            ...persona,
            popularityTier: tierId,
            category: categoryId,
            categoryLabel: categoryPreset?.label || '直播',
          },
          ephemeral: !keepNew,
        });
      }
      setMatchPhase(container, true, '连接直播间');
      showToast('匹配成功');
      navigate('anon/streamer/room', { channelId: channel.id }, true);
    } catch (err) {
      setMatchPhase(container, false);
      showToast(err?.message || '匹配失败');
      if (btn) { btn.disabled = false; btn.textContent = '开始匹配'; }
    }
  });
}
