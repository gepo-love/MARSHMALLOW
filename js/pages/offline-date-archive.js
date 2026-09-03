import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import {
  getOfflineDateArchive,
  toggleOfflineDateArchiveFavorite,
  deleteOfflineDateArchive,
  updateOfflineDateArchive,
  regenerateOfflineDateArchiveSummary,
} from '../core/offline-date-archive.js';
import { openTextEditorModal } from '../components/text-editor-modal.js';
import { createSceneDraft, startOfflineSession, loadOfflineSession } from '../core/offline-session.js';
import { primeDisplayRegex, applyDisplayRegex } from '../core/display-regex.js';
import { sanitizeNarrationOutput, splitNarrationParagraphs } from '../core/narration-sanitize.js';
import { stripLeakedOfflineContinuityTail } from '../core/offline-continuity-state.js';
import { renderNarrationTextWithTranslations, bindNarrationTranslationToggle } from '../core/narration-translation.js';
import { getOfflineInterludeNotice } from '../core/offline-interlude.js';
import { hydrateHtmlExtensionHosts } from '../core/html-extensions.js';
import { openLinkPreview } from '../components/link-preview-sheet.js';
import { isOfflineAudioExperience } from '../core/offline-experience-mode.js';
import { openImageLightbox } from '../components/image-lightbox.js';
import { alignNarrativeVoiceLinesToDialogueSpans } from '../core/narrative-voice-lines.js';
import {
  collectOfflineSceneMediaStats,
  exportOfflineSceneVideo,
  formatMediaBytes,
  formatSceneDuration,
} from '../core/offline-scene-video-export.js';

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

function archiveWidgetKey(round = {}, index = 0) {
  return `archive:${String(round.id || round.ts || 'round')}:${index}`;
}

function archiveWidgetsHtml(round = {}) {
  const widgets = Array.isArray(round.htmlWidgets) ? round.htmlWidgets : [];
  if (!widgets.length) return '';
  return `<div class="offline-html-widgets">${widgets.map((_, index) => (
    `<div class="offline-html-widget" data-html-extension-host="${esc(archiveWidgetKey(round, index))}"></div>`
  )).join('')}</div>`;
}

function archiveVoiceLinesHtml(round = {}) {
  const lines = alignNarrativeVoiceLinesToDialogueSpans(
    round.text || '',
    (Array.isArray(round.voiceLines) ? round.voiceLines : []).filter((line) => line?.audio?.dataUrl),
    { allowBracketDialogue: true },
  );
  if (!lines.length) return '';
  return `<div class="oda-round-voices">${lines.map((line) => `
    <label><span>${esc(line.actorName || '角色')}</span><audio controls preload="none" src="${esc(line.audio.dataUrl)}"></audio></label>
  `).join('')}</div>`;
}

function renderRound(round, { sceneNumber = 0 } = {}) {
  if (round.role === 'opening') {
    return `
      <div class="oda-round oda-round--opening">
        <span class="oda-round-label">你的开场</span>
        <p>${esc(applyDisplayRegex(String(round.text || ''), 'offline'))}</p>
      </div>`;
  }
  if (round.role === 'directive') {
    return `
      <div class="oda-round oda-round--directive">
        <span class="oda-round-label">你的方向</span>
        <p>${esc(applyDisplayRegex(String(round.text || ''), 'offline'))}</p>
      </div>`;
  }
  if (round.role === 'interlude') {
    if (round.attendanceEvent) {
      const status = String(round.attendanceEvent.status || '');
      const label = status === 'active' ? '加入现场' : (status === 'left' ? '离开现场' : '现场邀请');
      return `
        <div class="oda-round oda-round--attendance">
          <span class="oda-round-label">${esc(label)} · ${esc(fmtTime(round.ts))}</span>
          <p>${esc(applyDisplayRegex(String(round.text || ''), 'offline'))}</p>
        </div>`;
    }
    const notice = getOfflineInterludeNotice(round);
    if (notice) {
      return `
        <button type="button" class="oda-round oda-round--message-notice" data-archive-notice-chat="${esc(notice.chatId || '')}">
          <span class="oda-message-notice-icon">${icon('message')}</span>
          <span><strong>${esc(notice.title)}</strong>${notice.detail ? `<small>${esc(notice.detail)}</small>` : ''}</span>
          ${notice.chatId ? icon('chevron') : ''}
        </button>`;
    }
    return `
      <div class="oda-round oda-round--directive">
        <span class="oda-round-label">手机插曲</span>
        <p>${esc(applyDisplayRegex(String(round.text || ''), 'offline'))}</p>
      </div>`;
  }
  const cleaned = applyDisplayRegex(stripLeakedOfflineContinuityTail(sanitizeNarrationOutput(round.text)), 'offline');
  const paras = splitNarrationParagraphs(cleaned);
  return `
    <div class="oda-round oda-round--narration">
      <span class="oda-round-label">${sceneNumber ? `第 ${sceneNumber} 幕 · ` : ''}${esc(fmtTime(round.ts))}</span>
      ${round.image?.url ? `<button type="button" class="oda-round-image" data-archive-round-image="${esc(round.image.url)}"><img src="${esc(round.image.url)}" alt="第 ${sceneNumber || ''} 幕场景图" loading="lazy" /></button>` : ''}
      ${round.image?.warning ? `<div class="oda-round-media-warning">${esc(round.image.warning)}</div>` : ''}
      ${paras.map((p) => `<p>${renderNarrationTextWithTranslations(p)}</p>`).join('') || `<p>${renderNarrationTextWithTranslations(cleaned)}</p>`}
      ${archiveVoiceLinesHtml(round)}
      ${archiveWidgetsHtml(round)}
    </div>`;
}

function renderRoundSequence(rounds = []) {
  let sceneNumber = 0;
  return (Array.isArray(rounds) ? rounds : []).map((round) => {
    if (round?.role === 'narration') sceneNumber += 1;
    return renderRound(round, { sceneNumber });
  }).join('');
}

function unusedBranchesHtml(branches = []) {
  if (!Array.isArray(branches) || !branches.length) return '';
  return `
    <details class="oda-unused-branches">
      <summary>未采用路线 <span>${branches.length}</span></summary>
      <div class="oda-unused-branch-list">
        ${branches.map((branch) => `
          <details class="oda-unused-branch">
            <summary>${esc(branch.name || '未采用路线')}</summary>
            <div class="oda-unused-rounds">
              ${renderRoundSequence(branch.rounds || []) || '<div class="oda-empty">没有留下文本</div>'}
            </div>
          </details>`).join('')}
      </div>
    </details>`;
}

export default async function render(container, params = {}) {
  const archiveId = String(params.id || '').trim();
  const user = await ensureDefaultUser();
  await primeDisplayRegex();
  let archive = await getOfflineDateArchive(user.id, archiveId);
  let activeView = 'dossier';
  let activeMemoryCharacterId = '';
  let summaryBusy = false;
  let videoBusy = false;

  container.className = 'page scrapbook-page oda-page';

  if (!archive) {
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">约会档案</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <main class="oda-scroll"><div class="oda-empty">找不到这份档案</div></main>`;
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    return;
  }

  function dossierGroupHtml(label, items) {
    if (!Array.isArray(items) || !items.length) return '';
    return `
      <div class="oda-dossier-group">
        <span class="oda-dossier-group-label">${esc(label)}</span>
        ${items.map((x) => `<p>${esc(x)}</p>`).join('')}
      </div>`;
  }

  function dossierHtml(digest) {
    if (!digest) return '';
    const quotes = (digest.quotes || []).map((q) => `「${q.line}」${q.speaker ? ` —— ${q.speaker}` : ''}`);
    return `
      <section class="scrapbook-card oda-dossier-card">
        <div class="oda-section-label">卷宗${digest.fallback ? ' · 基础摘要' : (digest.title ? ` · ${esc(digest.title)}` : ' · 核心锚点')}</div>
        ${digest.cast ? `<p class="oda-dossier-cast">${esc(digest.cast)}</p>` : ''}
        ${dossierGroupHtml('关键台词', quotes)}
        ${dossierGroupHtml('情感与认知变动', digest.shifts)}
        ${dossierGroupHtml('物品与伏笔', digest.items)}
        ${dossierGroupHtml('未完成悬念', digest.hooks)}
        ${digest.story ? `
        <div class="oda-dossier-group">
          <span class="oda-dossier-group-label">剧情压缩</span>
          <p class="oda-dossier-story">${esc(digest.story)}</p>
        </div>` : ''}
      </section>`;
  }

  function paint() {
    const isTrip = archive.scene?.activityKind === 'trip';
    const isAudio = isOfflineAudioExperience(archive.scene);
    // 兜底：极少数旧数据的摘要是模型顺着协议惯性吐出的裸 JSON（不是正文），过一遍净化器，
    // 净化后为空就提示异常而不是把 {"t":...} 原样糊在用户脸上。
    const summaryText = sanitizeNarrationOutput(archive.summary || '');
    const ownedMemories = Array.isArray(archive.characterMemories) && archive.characterMemories.length
      ? archive.characterMemories
      : (archive.participantIds || [archive.characterId].filter(Boolean)).map((characterId, index) => ({
        characterId,
        characterName: archive.participantNames?.[index] || archive.characterName || 'TA',
        content: summaryText,
        visibility: [],
        roundIds: [],
        legacy: true,
      }));
    if (!activeMemoryCharacterId || !ownedMemories.some((entry) => entry.characterId === activeMemoryCharacterId)) {
      activeMemoryCharacterId = String(ownedMemories[0]?.characterId || '');
    }
    const activeMemory = ownedMemories.find((entry) => entry.characterId === activeMemoryCharacterId) || ownedMemories[0];
    const attendanceMember = archive.attendance?.members?.find((entry) =>
      String(entry.characterId || '') === String(activeMemory?.characterId || ''));
    const memoryRange = attendanceMember
      ? [attendanceMember.joinedAt ? `加入 ${fmtTime(attendanceMember.joinedAt)}` : '', attendanceMember.leftAt ? `离场 ${fmtTime(attendanceMember.leftAt)}` : ''].filter(Boolean).join(' · ')
      : '';
    const dossierView = `
      <section class="scrapbook-card oda-current-state-card">
        <div class="oda-section-label">当前状态 · 后续日程参考</div>
        <p class="oda-summary">${archive.currentState ? esc(archive.currentState) : '暂未记录持续状态'}</p>
      </section>
      <section class="scrapbook-card oda-summary-card">
        <div class="oda-section-label">摘要 · 已写入共同回忆</div>
        <p class="oda-summary">${summaryText ? esc(summaryText) : '摘要生成异常，暂时空缺（不影响下方过程记录）'}</p>
      </section>
      ${dossierHtml(archive.digest) || '<div class="oda-empty">这份档案尚未生成结构化卷宗，可点击重新生成摘要补齐</div>'}`;
    const mediaStats = collectOfflineSceneMediaStats(archive.rounds || [], archive.scene || {});
    const processView = `
      <section class="oda-rounds">
        <div class="oda-section-label">按幕回看 · ${mediaStats.sceneCount} 幕</div>
        <div class="oda-media-summary">图像与语音缓存 ${formatMediaBytes(mediaStats.cachedBytes)} · 视频预计 ${formatSceneDuration(mediaStats.durationSeconds)} / ${formatMediaBytes(mediaStats.estimatedVideoBytes)}</div>
        ${renderRoundSequence(archive.rounds || []) || '<div class="oda-empty">暂无轮次</div>'}
      </section>
      ${unusedBranchesHtml(archive.unusedBranches)}`;
    const memoryView = activeMemory ? `
      <section class="scrapbook-card oda-memory-card">
        ${ownedMemories.length > 1 ? `
          <div class="oda-memory-people" role="tablist" aria-label="选择角色记忆">
            ${ownedMemories.map((entry) => `
              <button type="button" role="tab" class="oda-memory-person${entry.characterId === activeMemory.characterId ? ' is-active' : ''}"
                aria-selected="${entry.characterId === activeMemory.characterId ? 'true' : 'false'}"
                data-memory-character="${esc(entry.characterId)}">${esc(entry.characterName || 'TA')}</button>`).join('')}
          </div>` : ''}
        <div class="oda-section-label">${esc(activeMemory.characterName || 'TA')}的记忆${activeMemory.legacy ? ' · 旧档案摘要' : ''}</div>
        ${memoryRange ? `<div class="oda-memory-range">${esc(memoryRange)}</div>` : ''}
        <p class="oda-memory-text">${esc(activeMemory.content || '没有留下可见记忆。')}</p>
      </section>` : '<div class="oda-empty">暂无角色记忆</div>';
    const activeContent = activeView === 'process' ? processView : (activeView === 'memory' ? memoryView : dossierView);
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">${isTrip ? '旅行记录' : (isAudio ? '音声档案' : '约会档案')}</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <main class="oda-scroll">
        <section class="scrapbook-card oda-head-card">
          <div class="oda-ribbon">${isTrip ? `🧳 一起旅行 · ${Number(archive.scene?.durationDays || 1)} 天` : (isAudio ? '音声线下' : '线下约会')}</div>
          <h2 class="oda-title">${esc(archive.title || '一次线下')}</h2>
          <div class="oda-meta">${esc(fmtTime(archive.startedAt))}${archive.endedAt && archive.endedAt !== archive.startedAt ? ` — ${esc(fmtTime(archive.endedAt))}` : ''}</div>
        </section>
        <section class="oda-actions">
          ${archive.chatId ? '<button type="button" class="btn btn-outline btn-sm oda-chat">返回聊天</button>' : ''}
          <button type="button" class="btn btn-outline btn-sm oda-favorite">${archive.favorite ? '★ 已收藏' : '☆ 收藏'}</button>
          <button type="button" class="btn btn-outline btn-sm oda-continue">续写这段</button>
          <button type="button" class="btn btn-outline btn-sm oda-edit-current-state" ${summaryBusy ? 'disabled' : ''}>编辑当前状态</button>
          <button type="button" class="btn btn-outline btn-sm oda-edit-summary" ${summaryBusy ? 'disabled' : ''}>编辑摘要</button>
          <button type="button" class="btn btn-outline btn-sm oda-regenerate-summary" ${summaryBusy ? 'disabled' : ''}>${summaryBusy ? '重新总结中…' : '重新生成摘要'}</button>
          <button type="button" class="btn btn-outline btn-sm oda-export-video" ${videoBusy || !mediaStats.sceneCount ? 'disabled' : ''}>${videoBusy ? '视频生成中…' : '导出音声视频'}</button>
          <button type="button" class="btn btn-outline btn-sm oda-delete">删除</button>
        </section>
        <nav class="oda-view-switch" aria-label="档案视图">
          <button type="button" class="${activeView === 'dossier' ? 'is-active' : ''}" data-oda-view="dossier">卷宗</button>
          <button type="button" class="${activeView === 'process' ? 'is-active' : ''}" data-oda-view="process">过程</button>
          <button type="button" class="${activeView === 'memory' ? 'is-active' : ''}" data-oda-view="memory">角色记忆</button>
        </nav>
        <div class="oda-view-content">${activeContent}</div>
      </main>
    `;
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    bindNarrationTranslationToggle(container);
    const htmlExtensionSnapshots = {};
    const collectWidgets = (rounds = []) => {
      (Array.isArray(rounds) ? rounds : []).forEach((round) => {
        (Array.isArray(round?.htmlWidgets) ? round.htmlWidgets : []).forEach((snapshot, index) => {
          htmlExtensionSnapshots[archiveWidgetKey(round, index)] = snapshot;
        });
      });
    };
    collectWidgets(archive.rounds);
    (Array.isArray(archive.unusedBranches) ? archive.unusedBranches : [])
      .forEach((branch) => collectWidgets(branch?.rounds));
    hydrateHtmlExtensionHosts(container, htmlExtensionSnapshots, {
      onOpenLink: (url, linkOptions) => openLinkPreview(url, linkOptions),
    });
    container.querySelectorAll('[data-oda-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeView = String(btn.getAttribute('data-oda-view') || 'dossier');
        paint();
      });
    });
    container.querySelectorAll('[data-memory-character]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeMemoryCharacterId = String(btn.getAttribute('data-memory-character') || '');
        paint();
      });
    });
    container.querySelectorAll('[data-archive-notice-chat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetChatId = String(btn.getAttribute('data-archive-notice-chat') || '');
        if (targetChatId) navigate('chat/thread', { chatId: targetChatId });
      });
    });
    container.querySelectorAll('[data-archive-round-image]').forEach((btn) => {
      btn.addEventListener('click', () => openImageLightbox(btn.getAttribute('data-archive-round-image') || ''));
    });
    if (archive.chatId) {
      container.querySelector('.oda-chat')?.addEventListener('click', () => {
        navigate('chat/thread', { chatId: archive.chatId });
      });
      container.querySelector('.oda-head-card')?.addEventListener('dblclick', () => {
        navigate('chat/thread', { chatId: archive.chatId });
      });
    }
    container.querySelector('.oda-favorite')?.addEventListener('click', async () => {
      archive = await toggleOfflineDateArchiveFavorite(user.id, archive.id);
      paint();
    });
    container.querySelector('.oda-edit-summary')?.addEventListener('click', () => {
      openTextEditorModal({
        title: '编辑线下约会摘要',
        value: String(archive.summary || ''),
        placeholder: '写下这次线下相处的摘要',
        onSave: async (next) => {
          if (!next) { showToast('内容不能为空'); return; }
          try {
            summaryBusy = true;
            paint();
            archive = await updateOfflineDateArchive(user.id, archive.id, { summary: next });
            showToast('已保存，并已同步角色记忆与日程');
          } catch (error) {
            showToast(error?.message || '摘要保存失败');
          } finally {
            summaryBusy = false;
            paint();
          }
        },
      });
    });
    container.querySelector('.oda-edit-current-state')?.addEventListener('click', () => {
      openTextEditorModal({
        title: '编辑当前状态',
        value: String(archive.currentState || ''),
        placeholder: '例如：两人目前暂住在海滨公寓，次日日程从这里继续',
        onSave: async (next) => {
          try {
            summaryBusy = true;
            paint();
            archive = await updateOfflineDateArchive(user.id, archive.id, { currentState: next });
            showToast(next ? '当前状态已保存，后续日程会优先参考' : '已清空当前状态');
          } catch (error) {
            showToast(error?.message || '当前状态保存失败');
          } finally {
            summaryBusy = false;
            paint();
          }
        },
      });
    });
    container.querySelector('.oda-regenerate-summary')?.addEventListener('click', async () => {
      if (summaryBusy) return;
      summaryBusy = true;
      paint();
      try {
        archive = await regenerateOfflineDateArchiveSummary(user.id, archive.id, { user });
        showToast('已重新生成，并同步角色记忆与日程');
      } catch (error) {
        showToast(error?.message || '重新生成摘要失败');
      } finally {
        summaryBusy = false;
        paint();
      }
    });
    container.querySelector('.oda-export-video')?.addEventListener('click', async () => {
      if (videoBusy || !mediaStats.sceneCount) return;
      if (!window.confirm(`预计生成 ${formatSceneDuration(mediaStats.durationSeconds)}、约 ${formatMediaBytes(mediaStats.estimatedVideoBytes)} 的视频。生成过程按实际时长录制，成片不会写回应用缓存。继续吗？`)) return;
      videoBusy = true;
      paint();
      const button = container.querySelector('.oda-export-video');
      try {
        const result = await exportOfflineSceneVideo({
          rounds: archive.rounds || [],
          scene: archive.scene || {},
          title: archive.title || '线下音声回顾',
          orientation: archive.scene?.audioSceneLayout || 'portrait',
          onProgress: (progress) => {
            if (!button) return;
            if (progress.phase === 'prepare') button.textContent = `准备 ${progress.current}/${progress.total}`;
            else button.textContent = `生成 ${Math.min(100, Math.round((progress.elapsed / Math.max(1, progress.total)) * 100))}%`;
          },
        });
        showToast(`视频已导出（${formatMediaBytes(result.bytes)}）`);
      } catch (error) {
        showToast(`视频导出失败：${error?.message || error}`);
      } finally {
        videoBusy = false;
        paint();
      }
    });
    container.querySelector('.oda-delete')?.addEventListener('click', async () => {
      if (!window.confirm('删除这份约会档案？回忆里的摘要不会被撤回。')) return;
      await deleteOfflineDateArchive(user.id, archive.id);
      showToast('已删除');
      back();
    });
    container.querySelector('.oda-continue')?.addEventListener('click', async () => {
      if (!archive.chatId) { showToast('这份档案没有关联会话'); return; }
      const btn = container.querySelector('.oda-continue');
      if (btn) { btn.disabled = true; btn.textContent = '准备中…'; }
      try {
        // 这个 chat 上如果已经有另一场没收纳的线下，先回去继续那场，不要覆盖它。
        const existingSession = await loadOfflineSession(archive.chatId);
        if (existingSession) {
          showToast('这段对话还有未收纳的线下，先带你回去继续');
          navigate('offline', { chatId: archive.chatId });
          return;
        }
        const scene = createSceneDraft({
          ...(archive.scene || {}),
          dayIndex: 0,
          openingLine: '',
        });
        await startOfflineSession({
          chatId: archive.chatId,
          userId: user.id,
          scene,
          participantIds: Array.isArray(archive.participantIds)
            ? archive.participantIds
            : [archive.characterId].filter(Boolean),
          userPresent: archive.userPresent !== false,
          continuationArchive: archive,
          originSeed: {
            from: 'archive-continuation',
            archiveId: archive.id,
            place: archive.scene?.place || '',
            activity: archive.scene?.goal || '',
            note: '',
          },
        });
        navigate('offline', { chatId: archive.chatId, justStarted: '1' });
      } catch (err) {
        showToast(`失败：${err?.message || err}`);
        if (btn) { btn.disabled = false; btn.textContent = '续写这段'; }
      }
    });
  }

  paint();
}
