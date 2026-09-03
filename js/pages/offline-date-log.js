import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listCharacters } from '../core/character-store.js';
import { listOfflineDateArchives } from '../core/offline-date-archive.js';
import { listChatsForUser } from '../core/chat-store.js';
import { loadOfflineSession } from '../core/offline-session-store.js';
import { isOfflineAudioExperience } from '../core/offline-experience-mode.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default async function render(container) {
  const user = await ensureDefaultUser();
  const characters = (await listCharacters({ excludeAnonNpc: true }).catch(() => []))
    .filter((c) => c && c.id);
  const charName = (id) => {
    const c = characters.find((x) => x.id === id);
    return c ? (c.customNickname || c.name || 'TA') : 'TA';
  };

  let characterId = '';

  container.className = 'page scrapbook-page odl-page';

  async function paint() {
    const [archives, chats] = await Promise.all([
      listOfflineDateArchives(user.id, { characterId }).catch(() => []),
      listChatsForUser(user.id).catch(() => []),
    ]);
    const active_sessions = (await Promise.all(chats.map(async (chat) => {
      const participant_ids = (chat?.participants || []).filter((id) => id && id !== 'user');
      if (characterId && !participant_ids.includes(characterId)) return null;
      const session = await loadOfflineSession(chat.id).catch(() => null);
      return session ? { chat, session, participant_ids } : null;
    })))
      .filter(Boolean)
      .sort((a, b) => (b.session.updatedAt || b.session.createdAt || 0)
        - (a.session.updatedAt || a.session.createdAt || 0));
    const active_html = active_sessions.map(({ chat, session, participant_ids }) => {
      const participant_names = participant_ids.map(charName);
      const is_trip = session.scene?.activityKind === 'trip';
      const is_audio = isOfflineAudioExperience(session.scene);
      const is_group = participant_ids.length > 1;
      const title = is_group
        ? (chat.groupSettings?.name || participant_names.join('、') || '多人线下')
        : `与 ${participant_names[0] || 'TA'} 的${is_audio ? '音声线下' : '线下'}`;
      const scene_summary = [session.scene?.place, session.scene?.goal].filter(Boolean).join(' · ');
      return `
        <button type="button" class="odl-item" data-session="${esc(chat.id)}">
          <div class="odl-item-body">
            <strong>${esc(title)}</strong>
            <span class="odl-item-badge">进行中 · ${is_trip ? '一起旅行' : (is_audio ? '音声线下' : (is_group ? '多人线下' : '线下相遇'))}</span>
            <small>${esc(participant_names.join('、'))} · ${esc(fmtTime(session.updatedAt || session.createdAt))}</small>
            ${scene_summary ? `<p>${esc(scene_summary)}</p>` : ''}
          </div>
        </button>`;
    }).join('');
    const archive_html = archives.map((a) => {
      const is_trip = a.scene?.activityKind === 'trip';
      const is_audio = isOfflineAudioExperience(a.scene);
      return `
        <button type="button" class="odl-item${a.favorite ? ' is-favorite' : ''}" data-archive="${esc(a.id)}">
          ${a.favorite ? '<span class="odl-item-fav">★</span>' : ''}
          <div class="odl-item-body">
            <strong>${esc(a.title || '一次线下')}</strong>
            ${is_trip ? `<span class="odl-item-badge">🧳 一起旅行 · ${Number(a.scene?.durationDays || 1)} 天</span>` : ''}
            ${!is_trip && is_audio ? '<span class="odl-item-badge">音声线下</span>' : ''}
            <small>${esc((a.participantNames || [charName(a.characterId)]).join('、'))} · ${esc(fmtTime(a.endedAt || a.startedAt))}</small>
            <p>${esc(a.summary || '')}</p>
          </div>
        </button>`;
    }).join('');
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">我们的记录</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <main class="odl-scroll">
        ${characters.length > 1 ? `
          <div class="odl-filter">
            <select class="form-input odl-char-select">
              <option value="">全部角色</option>
              ${characters.map((c) => `<option value="${esc(c.id)}" ${characterId === c.id ? 'selected' : ''}>${esc(c.customNickname || c.name || 'TA')}</option>`).join('')}
            </select>
          </div>
        ` : ''}
        <div class="odl-list">
          ${active_html || archive_html ? `${active_html}${archive_html}` : '<div class="odl-empty">还没有相遇记录</div>'}
        </div>
      </main>
    `;
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('.odl-char-select')?.addEventListener('change', (e) => {
      characterId = String(e.target.value || '');
      paint();
    });
    container.querySelectorAll('[data-session]').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigate('offline', { chatId: btn.getAttribute('data-session') });
      });
    });
    container.querySelectorAll('[data-archive]').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigate('offline/archive', { id: btn.getAttribute('data-archive') });
      });
    });
  }

  await paint();
}
