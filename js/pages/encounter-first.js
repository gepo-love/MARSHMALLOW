import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { characterAvatarHtml, emptyIllustration } from '../components/scrapbook-illustrations.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listEncounterPendingCharacters, saveCharacter } from '../core/character-store.js';
import { deleteCharacterCascade } from '../core/data-hygiene.js';
import { createCharacterProfile, ENCOUNTER_PENDING_GROUP_ID, isPublicContactCharacter } from '../models/character.js';
import { parseBackupJson } from '../core/character-import.js';
import { startFirstEncounterSession } from '../core/offline-session.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function render(container) {
  const user = await ensureDefaultUser();
  let drafts = await listEncounterPendingCharacters().catch(() => []);
  let selectedId = drafts.length === 1 ? drafts[0].id : '';
  let starting = false;

  container.className = 'page scrapbook-page offline-date-page encounter-first-page';

  async function reloadDrafts(keepId = '') {
    drafts = await listEncounterPendingCharacters().catch(() => []);
    if (keepId && drafts.some((c) => c.id === keepId)) selectedId = keepId;
    else if (!drafts.some((c) => c.id === selectedId)) selectedId = drafts.length === 1 ? drafts[0].id : '';
  }

  function paint() {
    const picked = drafts.find((c) => c.id === selectedId) || null;
    const listHtml = drafts.length
      ? drafts.map((char) => {
        const active = char.id === selectedId ? ' is-active' : '';
        return `
          <button type="button" class="od-char${active}" data-id="${esc(char.id)}">
            <span class="od-char-avatar">${characterAvatarHtml(char, { className: 'od-char-avatar-img' })}</span>
            <span class="od-char-body">
              <strong>${esc(char.name || '未命名')}</strong>
              <small>${esc(char.personality ? char.personality.slice(0, 24) : '尚未相识')}</small>
            </span>
            <span class="od-char-check" aria-hidden="true">${active ? '✓' : ''}</span>
          </button>
        `;
      }).join('')
      : `<div class="od-empty">${emptyIllustration('chat')}<div class="od-empty-text">还没有等待初遇的角色</div></div>`;

    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">初遇</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <main class="od-scroll scrapbook-scroll">
        <section class="od-panel">
          <div class="od-char-list">${listHtml}</div>
          <div class="ef-draft-actions">
            <button type="button" class="btn btn-outline btn-sm" data-new-draft>新建角色草稿</button>
            <button type="button" class="btn btn-outline btn-sm" data-import-draft>导入角色包</button>
            ${picked ? '<button type="button" class="btn btn-soft btn-sm" data-del-draft>删除草稿</button>' : ''}
            <input type="file" accept=".json,application/json" class="ef-file-input" hidden>
          </div>
        </section>

        <section class="scrapbook-card od-form">
          <div class="chat-details-section-title">${picked ? `和 ${esc(picked.name || 'TA')} 的第一次见面` : '选一位角色开始初遇'}</div>
          <label class="api-field">
            <span class="api-field-label">在哪里遇见（可选）</span>
            <input type="text" class="form-input ef-place" placeholder="如：海滨小城的旧书店" maxlength="60" />
          </label>
          <label class="api-field">
            <span class="api-field-label">简述这场相遇（可选）</span>
            <textarea class="form-input ef-note" rows="3" placeholder="留空则完全即兴；也可以写个大概想法，如：雨天躲进同一间咖啡店"></textarea>
          </label>
        </section>
      </main>
      <footer class="od-footer">
        <button type="button" class="btn btn-primary ef-start" ${picked && !starting ? '' : 'disabled'}>${starting ? '准备中...' : '开始初遇'}</button>
      </footer>
    `;

    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelectorAll('.od-char').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-id') || '';
        selectedId = selectedId === id ? '' : id;
        paint();
      });
    });
    container.querySelector('[data-new-draft]')?.addEventListener('click', onNewDraft);
    const fileInput = container.querySelector('.ef-file-input');
    container.querySelector('[data-import-draft]')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', (e) => onImportFile(e));
    container.querySelector('[data-del-draft]')?.addEventListener('click', onDeleteDraft);
    container.querySelector('.ef-start')?.addEventListener('click', onStart);
  }

  function onNewDraft() {
    openTextEditorModal({
      title: '新建角色草稿',
      value: '',
      multiline: true,
      placeholder: '第一行写名字，其余行写人设（可选）',
      confirmLabel: '创建',
      onSave: async (text) => {
        const lines = String(text || '').split('\n');
        const name = String(lines[0] || '').trim();
        if (!name) { showToast('第一行需要是名字'); return; }
        const personality = lines.slice(1).join('\n').trim();
        const profile = createCharacterProfile({ name, personality, groupId: ENCOUNTER_PENDING_GROUP_ID });
        await saveCharacter(profile);
        await reloadDrafts(profile.id);
        paint();
        showToast(`已创建「${name}」，等待初遇`);
      },
    });
  }

  async function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseBackupJson(text);
      const rows = (parsed.characters || [])
        .map((row) => createCharacterProfile({ ...row, groupId: ENCOUNTER_PENDING_GROUP_ID }))
        .filter((row) => row && isPublicContactCharacter(row) && row.name);
      if (!rows.length) { showToast('角色包里没有可导入的角色'); return; }
      let lastId = '';
      for (const row of rows) {
        await saveCharacter(row);
        lastId = row.id;
      }
      await reloadDrafts(rows.length === 1 ? lastId : selectedId);
      paint();
      showToast(`已导入 ${rows.length} 位角色，等待初遇`);
    } catch (err) {
      showToast(String(err?.message || err));
    }
  }

  async function onDeleteDraft() {
    const picked = drafts.find((c) => c.id === selectedId);
    if (!picked) return;
    if (!window.confirm(`删除草稿「${picked.name || '未命名'}」？`)) return;
    await deleteCharacterCascade(picked.id);
    await reloadDrafts();
    paint();
    showToast('已删除草稿');
  }

  async function onStart() {
    const picked = drafts.find((c) => c.id === selectedId);
    if (!picked || starting) return;
    starting = true;
    const place = String(container.querySelector('.ef-place')?.value || '').trim();
    const note = String(container.querySelector('.ef-note')?.value || '').trim();
    paint();
    try {
      const { chatId, resumed } = await startFirstEncounterSession({
        userId: user.id,
        characterId: picked.id,
        place,
        note,
      });
      if (resumed) showToast('继续上次未收纳的初遇');
      navigate('offline', { chatId, justStarted: resumed ? '' : '1' });
    } catch (err) {
      starting = false;
      paint();
      showToast(String(err?.message || err));
    }
  }

  paint();
}
