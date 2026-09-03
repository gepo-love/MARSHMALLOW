import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listCharacters } from '../core/character-store.js';
import { createAnonymousGroupRoom } from '../core/anonymous-room.js';
import { ANONYMOUS_MEMORY_MODES, ANONYMOUS_ROOM_TOPIC_TEMPLATES } from '../data/anonymous-room-presets.js';
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

export default async function render(container) {
  const user = await ensureDefaultUser();
  const chars = (await listCharacters({
    excludeAnonNpc: true,
    userId: user.id,
    identityScoped: true,
  })).filter((c) => c?.id && c.id !== 'user');
  const worldBookOptions = await listAllWorldBookRows().catch(() => []);
  const selected = new Set();

  container.className = 'page anon-page anon-room-create-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">创建匿名房</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="anon-scroll">
      <section class="anon-create-poster">
        <strong>一间没有门牌的房间</strong>
        <span>先定底色网名，再选主题与成员</span>
      </section>
      <section class="anon-card">
        <div class="anon-section-title">房间信息</div>
        <label class="anon-form-field">
          <span>房间名</span>
          <input type="text" class="form-input anon-room-name" placeholder="例如：深夜树洞" />
        </label>
        <label class="anon-form-field">
          <span>主题模板</span>
          <select class="form-input anon-topic-template">
            ${ANONYMOUS_ROOM_TOPIC_TEMPLATES.map((t, i) => `<option value="${escAttr(t.id)}" ${i === 0 ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>
        </label>
        <label class="anon-form-field">
          <span>自定义主题（可选）</span>
          <input type="text" class="form-input anon-custom-topic" placeholder="留空则用模板" />
        </label>
        <label class="anon-form-field">
          <span>记忆档位</span>
          <select class="form-input anon-memory-mode">
            ${ANONYMOUS_MEMORY_MODES.map((m) => `<option value="${escAttr(m.id)}" ${m.id === 'inherit_full' ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </label>
        <label class="anon-form-field" style="flex-direction:row;align-items:center;gap:8px;">
          <input type="checkbox" class="anon-include-self" checked />
          <span>包含我自己</span>
        </label>
      </section>

      ${renderAnonymousRoomWorldviewSection({ worldBookOptions })}

      <section class="anon-card">
        <div class="anon-section-title">选择成员</div>
        ${chars.length ? chars.map((c) => `
          <label class="anon-member-row">
            <input type="checkbox" class="anon-member-pick" value="${escAttr(c.id)}" />
            <span>${esc(c.name || c.id)}</span>
          </label>
        `).join('') : '<div class="anon-empty">通讯录还是空的，先去写角色吧</div>'}
      </section>

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

      <button type="button" class="btn btn-primary" style="width:calc(100% - 28px);margin:0 14px 16px;" data-create>创建并进入</button>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  const worldviewFields = bindAnonymousRoomWorldview(container);
  container.querySelectorAll('.anon-member-pick').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) selected.add(input.value);
      else selected.delete(input.value);
    });
  });
  const npcEnable = container.querySelector('.anon-npc-enable');
  const npcDetail = container.querySelector('.anon-npc-detail');
  npcEnable?.addEventListener('change', () => {
    if (npcDetail) npcDetail.hidden = !npcEnable.checked;
  });

  container.querySelector('[data-create]')?.addEventListener('click', async () => {
    const btn = container.querySelector('[data-create]');
    const npcEnabled = !!npcEnable?.checked;
    const npcCount = npcEnabled ? Math.max(1, Number(container.querySelector('.anon-npc-count')?.value || 1)) : 0;
    if (selected.size + npcCount < 2) {
      showToast('请至少凑够 2 位成员（可勾选路人补足）');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
    try {
      const chat = await createAnonymousGroupRoom({
        userId: user.id,
        userRow: user,
        roomName: container.querySelector('.anon-room-name')?.value || '',
        topicTemplateId: container.querySelector('.anon-topic-template')?.value || 'lounge',
        customTopic: container.querySelector('.anon-custom-topic')?.value || '',
        memberIds: [...selected],
        memoryMode: container.querySelector('.anon-memory-mode')?.value || 'inherit_full',
        includeSelf: container.querySelector('.anon-include-self')?.checked !== false,
        npcConfig: {
          enabled: npcEnabled,
          count: npcCount,
          vibe: container.querySelector('.anon-npc-vibe')?.value || '',
          persist: !!container.querySelector('.anon-npc-persist')?.checked,
        },
        roomWorldview: worldviewFields.readValues(),
        maskMode: container.querySelector('.anon-mask-random')?.checked ? 'random' : 'ai',
        onPhase: (text) => { if (btn) btn.textContent = `${text}…`; },
      });
      await seedAnonymousMatchOpening({ chat, userId: user.id, purposeId: 'lounge', isGroup: true }).catch(() => null);
      const aliasWarning = String(chat.metadata?.anonymousAliasMeta?.warning || '').trim();
      if (aliasWarning) showToast(aliasWarning, 4500);
      showToast('房间已创建');
      navigate('chat/thread', { chatId: chat.id, from: 'anon' });
    } catch (err) {
      showToast(err?.message || '创建失败');
      if (btn) { btn.disabled = false; btn.textContent = '创建并进入'; }
    }
  });
}
