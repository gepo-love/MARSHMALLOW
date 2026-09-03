import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import {
  executeSingleMatch,
  MATCH_PURPOSES_SINGLE,
  MATCH_RELATION_INTENTS,
} from '../core/anonymous-match.js';
import { loadAnonymousCharacterCandidates } from '../core/anonymous-character-pool.js';
import { createAnonymousPrivateFromRandomMatch } from '../core/anonymous-private-chat.js';

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
  const characterCandidates = await loadAnonymousCharacterCandidates({ userId: user.id }).catch(() => []);
  const characterOptions = characterCandidates
    .map((character) => `<option value="${escAttr(character.id)}">${esc(character.name || character.realName || '未命名角色')}</option>`)
    .join('');

  const purposeRadios = MATCH_PURPOSES_SINGLE.map(
    (p, i) => `
    <label class="anon-match-option">
      <input type="radio" name="ams-purpose" class="ams-purpose" value="${escAttr(p.id)}" ${i === 0 ? 'checked' : ''} />
      <span class="anon-match-option-body">
        <strong>${esc(p.label)}</strong>
        <small>${esc(p.description)}</small>
      </span>
    </label>`,
  ).join('');

  const relationRadios = MATCH_RELATION_INTENTS.map(
    (item, i) => `
    <label class="anon-match-option">
      <input type="radio" name="ams-relation" class="ams-relation" value="${escAttr(item.id)}" ${i === 0 ? 'checked' : ''} />
      <span class="anon-match-option-body">
        <strong>${esc(item.label)}</strong>
        <small>${esc(item.description)}</small>
      </span>
    </label>`,
  ).join('');

  container.className = 'page anon-page anon-match-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">匿名匹配</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="anon-scroll anon-match-scroll">
      <section class="anon-card">
        <div class="anon-section-title">你想做什么？</div>
        <div class="anon-match-list">${purposeRadios}</div>
      </section>
      <section class="anon-card">
        <div class="anon-section-title">关系期待</div>
        <div class="anon-match-list">${relationRadios}</div>
      </section>
      <section class="anon-card">
        <div class="anon-section-title">想遇见谁</div>
        <div class="anon-match-list">
          <label class="anon-match-option"><input type="radio" name="ams-source" class="ams-source" value="random" checked /><span class="anon-match-option-body"><strong>随机</strong><small>随机遇到通讯录角色或新路人</small></span></label>
          <label class="anon-match-option"><input type="radio" name="ams-source" class="ams-source" value="character" /><span class="anon-match-option-body"><strong>已有角色</strong><small>只从通讯录里匹配</small></span></label>
          <label class="anon-match-option"><input type="radio" name="ams-source" class="ams-source" value="specific" ${characterOptions ? '' : 'disabled'} /><span class="anon-match-option-body"><strong>指定角色</strong><small>${characterOptions ? '选一位角色进入匿名匹配' : '通讯录里还没有可选角色'}</small></span></label>
          <label class="anon-match-option"><input type="radio" name="ams-source" class="ams-source" value="npc" /><span class="anon-match-option-body"><strong>匿名路人</strong><small>现场生成一位只属于这次相遇的陌生网友</small></span></label>
        </div>
        <div class="anon-match-specific-options" hidden>
          <label class="form-label" for="ams-specific-character">选择角色</label>
          <select id="ams-specific-character" class="form-input ams-specific-character">
            <option value="">请选择</option>
            ${characterOptions}
          </select>
        </div>
        <div class="anon-match-npc-options">
          <label class="form-label">路人性别方向（可选）</label>
          <select class="form-input ams-npc-gender">
            <option value="random">随机</option>
            <option value="女性">女性</option>
            <option value="男性">男性</option>
            <option value="非二元">非二元 / 不设定</option>
          </select>
          <label class="form-label">这次想遇见的感觉（可选）</label>
          <input type="text" class="form-input ams-custom-direction" maxlength="80" placeholder="例如：嘴硬但会认真听、同样在熬夜的人" />
        </div>
      </section>
      <button type="button" class="btn btn-primary anon-match-start">开始匹配</button>
      <p class="text-hint anon-match-hint">匹配成功后进入匿名私聊，双方显示匿名网名。</p>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  const specificOptions = container.querySelector('.anon-match-specific-options');
  const npcOptions = container.querySelector('.anon-match-npc-options');
  container.querySelectorAll('.ams-source').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (specificOptions) specificOptions.hidden = radio.value !== 'specific' || !radio.checked;
      if (npcOptions && radio.checked) npcOptions.hidden = !['random', 'npc'].includes(radio.value);
    });
  });

  container.querySelector('.anon-match-start')?.addEventListener('click', async () => {
    const purposeId = container.querySelector('.ams-purpose:checked')?.value || 'casual';
    const relationIntentId = container.querySelector('.ams-relation:checked')?.value || 'light';
    const counterpartSource = container.querySelector('.ams-source:checked')?.value || 'random';
    const npcGender = container.querySelector('.ams-npc-gender')?.value || 'random';
    const customDirection = container.querySelector('.ams-custom-direction')?.value || '';
    const selectedActorId = container.querySelector('.ams-specific-character')?.value || '';
    const btn = container.querySelector('.anon-match-start');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '匹配中…';
    }
    setMatchPhase(container, true, '搜索在线小号');
    try {
      const match = await executeSingleMatch({
        userRow: user,
        purposeId,
        relationIntentId,
        counterpartSource,
        npcGender,
        customDirection,
        selectedActorId,
      });
      setMatchPhase(container, true, '连通信号');
      const chat = await createAnonymousPrivateFromRandomMatch({
        userId: user.id,
        userRow: user,
        counterpartActorId: match.candidateId,
        counterpartIdentity: match.counterpartIdentity,
        userIdentity: match.userIdentity,
        purpose: match.purpose,
        relationIntent: match.relationIntent,
        counterpartSource: match.counterpartSource,
        npcGender: match.npcGender,
        customDirection: match.customDirection,
      });
      setMatchPhase(container, true, '匿名窗已开');
      showToast('匹配成功');
      navigate('chat/thread', { chatId: chat.id, from: 'anon' });
    } catch (err) {
      setMatchPhase(container, false);
      showToast(err?.message || '匹配失败');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '开始匹配';
      }
    }
  });
}
