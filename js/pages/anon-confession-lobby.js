import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listCharacters } from '../core/character-store.js';
import { openOrCreateConfessionRoom } from '../core/anonymous-confession.js';

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

  container.className = 'page anon-page anon-confession-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">赛博告解室</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="anon-scroll">
      <section class="anon-hero" style="margin-bottom:12px;">
        <h2 class="anon-hero-title">赛博告解室</h2>
        <p class="anon-hero-sub">固定房间，来客一位接一位地换。下面选你的角色。</p>
      </section>
      <section class="anon-card">
        <div class="anon-section-title">我来告解</div>
        <button type="button" class="btn btn-primary btn-block" data-mode="seeker">找位修女听我说</button>
        <button type="button" class="btn btn-outline btn-block" style="margin-top:8px;" data-mode="seeker" data-new-case>换一位修女</button>
      </section>
      <section class="anon-card">
        <div class="anon-section-title">我来值班</div>
        <button type="button" class="btn btn-outline btn-block" data-mode="sister">坐窗这头当修女</button>
        <button type="button" class="btn btn-outline btn-block" style="margin-top:8px;" data-mode="sister" data-new-case>下一位来客</button>
      </section>
      <section class="anon-card">
        <div class="anon-section-title">旁观局 · 指定修女</div>
        <label class="anon-form-field">
          <span>修女角色</span>
          <select class="form-input anon-nun-pick">
            <option value="">请选择</option>
            ${chars.map((c) => `<option value="${escAttr(c.id)}">${esc(c.name || c.id)}</option>`).join('')}
          </select>
        </label>
        <label class="anon-form-field">
          <span>记忆方式</span>
          <select class="form-input anon-memory-isolation">
            <option value="soft">带着窗外的记忆（推荐）</option>
            <option value="hard">只聊这一轮</option>
          </select>
        </label>
        <button type="button" class="btn btn-outline btn-block" data-mode="observer_nun">在一旁看</button>
        <button type="button" class="btn btn-outline btn-block" style="margin-top:8px;" data-mode="observer_nun" data-new-case>下一位来客</button>
      </section>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());

  async function enter(mode, startNewCase = false) {
    try {
      const nunActorId = container.querySelector('.anon-nun-pick')?.value || '';
      const memoryIsolation = container.querySelector('.anon-memory-isolation')?.value || 'soft';
      const chat = await openOrCreateConfessionRoom({
        userId: user.id,
        userRow: user,
        mode,
        nunActorId,
        memoryIsolation,
        startNewCase,
      });
      navigate('chat/thread', { chatId: chat.id, from: 'anon' });
    } catch (err) {
      showToast(err?.message || '进入失败');
    }
  }

  container.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode') || 'seeker';
      if (mode === 'observer_nun' && !container.querySelector('.anon-nun-pick')?.value) {
        showToast('请先选择修女角色');
        return;
      }
      enter(mode, btn.hasAttribute('data-new-case'));
    });
  });
}
