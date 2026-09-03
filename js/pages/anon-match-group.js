import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import {
  executeGroupMatchPlan,
  persistRandomGroupMatchPlan,
  MATCH_PURPOSES_GROUP,
  MATCH_RELATION_INTENTS,
} from '../core/anonymous-match.js';
import { seedAnonymousMatchOpening } from '../core/anonymous-match-seed.js';
import { listAllWorldBookRows } from '../core/world-book-store.js';
import { renderAnonymousRoomWorldviewSection, bindAnonymousRoomWorldview } from '../components/anonymous-room-worldview.js';

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

export default async function render(container) {
  const user = await ensureDefaultUser();
  const worldBookOptions = await listAllWorldBookRows().catch(() => []);

  container.className = 'page anon-page anon-match-group-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">随机群匹配</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="anon-scroll">
      <section class="anon-card">
        <div class="anon-section-title">群主题</div>
        <div class="anon-match-list">
          ${MATCH_PURPOSES_GROUP.map((p, i) => `
            <label class="anon-match-option">
              <input type="radio" name="amg-purpose" value="${escAttr(p.id)}" ${i === 0 ? 'checked' : ''} />
              <span class="anon-match-option-body">
                <strong>${esc(p.label)}</strong>
                ${p.description ? `<small>${esc(p.description)}</small>` : ''}
              </span>
            </label>
          `).join('')}
        </div>
      </section>
      <section class="anon-card">
        <div class="anon-section-title">人数</div>
        <label class="anon-form-field">
          <span>总人数（含你）</span>
          <input type="number" class="form-input anon-member-count" min="3" max="8" value="4" />
        </label>
      </section>
      ${renderAnonymousRoomWorldviewSection({ worldBookOptions })}
      <section class="anon-card">
        <div class="anon-section-title">路人网友</div>
        <label class="anon-form-field" style="flex-direction:row;align-items:center;gap:8px;">
          <input type="checkbox" class="anon-npc-enable" />
          <span>掺入 AI 现场捏造的路人</span>
        </label>
        <div class="anon-npc-detail" hidden>
          <label class="anon-form-field">
            <span>路人数量</span>
            <input type="number" class="form-input anon-npc-count" min="1" max="6" value="1" />
          </label>
          <label class="anon-form-field">
            <span>背景 / 性格倾向（可选）</span>
            <input type="text" class="form-input anon-npc-vibe" placeholder="例如：嘴碎夜猫子、慢热文艺青年" />
          </label>
          <label class="anon-form-field" style="flex-direction:row;align-items:center;gap:8px;">
            <input type="checkbox" class="anon-npc-persist" />
            <span>保存到「匿名NPC」分组（可复用，否则用完即弃）</span>
          </label>
        </div>
      </section>
      <section class="anon-card">
        <div class="anon-section-title">角色马甲</div>
        <label class="anon-form-field" style="flex-direction:row;align-items:center;gap:8px;">
          <input type="checkbox" class="anon-mask-random" />
          <span>用随机马甲（默认让 AI 按人设起名）</span>
        </label>
      </section>
      <section class="anon-card">
        <div class="anon-section-title">关系期待</div>
        <div class="anon-match-list">
          ${MATCH_RELATION_INTENTS.map((item, i) => `
            <label class="anon-match-option">
              <input type="radio" name="amg-relation" value="${escAttr(item.id)}" ${i === 0 ? 'checked' : ''} />
              <span class="anon-match-option-body">
                <strong>${esc(item.label)}</strong>
              </span>
            </label>
          `).join('')}
        </div>
      </section>
      <button type="button" class="btn btn-primary anon-match-start">开始拼桌</button>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  const worldviewFields = bindAnonymousRoomWorldview(container);
  const npcEnable = container.querySelector('.anon-npc-enable');
  const npcDetail = container.querySelector('.anon-npc-detail');
  npcEnable?.addEventListener('change', () => {
    if (npcDetail) npcDetail.hidden = !npcEnable.checked;
  });
  container.querySelector('.anon-match-start')?.addEventListener('click', async () => {
    const purposeId = container.querySelector('input[name="amg-purpose"]:checked')?.value || 'lounge';
    const relationIntentId = container.querySelector('input[name="amg-relation"]:checked')?.value || 'light';
    const memberCountTotal = Number(container.querySelector('.anon-member-count')?.value || 4);
    const npcConfig = {
      enabled: !!npcEnable?.checked,
      count: Number(container.querySelector('.anon-npc-count')?.value || 1),
      vibe: container.querySelector('.anon-npc-vibe')?.value || '',
      persist: !!container.querySelector('.anon-npc-persist')?.checked,
    };
    const roomWorldview = worldviewFields.readValues();
    const maskMode = container.querySelector('.anon-mask-random')?.checked ? 'random' : 'ai';
    const btn = container.querySelector('.anon-match-start');
    if (btn) { btn.disabled = true; btn.textContent = '匹配中…'; }
    setMatchPhase(container, true, '寻找同频群友');
    try {
      const plan = await executeGroupMatchPlan({
        userRow: user,
        purposeId,
        relationIntentId,
        memberCountTotal,
        npcConfig,
        roomWorldview,
        maskMode,
        onPhase: (text) => setMatchPhase(container, true, text),
      });
      setMatchPhase(container, true, '拼接匿名房间');
      const chat = await persistRandomGroupMatchPlan({ userId: user.id, userRow: user, plan });
      await seedAnonymousMatchOpening({ chat, userId: user.id, userRow: user, purposeId, isGroup: true });
      const aliasWarning = String(chat.metadata?.anonymousAliasMeta?.warning || '').trim();
      if (aliasWarning) showToast(aliasWarning, 4500);
      setMatchPhase(container, true, '已拼好桌');
      showToast('拼桌成功');
      navigate('chat/thread', { chatId: chat.id, from: 'anon' });
    } catch (err) {
      setMatchPhase(container, false);
      showToast(err?.message || '匹配失败');
      if (btn) { btn.disabled = false; btn.textContent = '开始拼桌'; }
    }
  });
}
