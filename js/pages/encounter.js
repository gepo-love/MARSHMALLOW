import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { countCollectiblesForUser } from '../core/collectibles.js';

const MODE_ICONS = {
  timeMachine: '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="34" fill="#d5e4ed"/><circle cx="50" cy="50" r="26" fill="#fdf8f4"/><circle cx="50" cy="50" r="4" fill="#f1b98f"/><path d="M50 30 V50 L64 58" fill="none" stroke="#5c7b8f" stroke-width="4" stroke-linecap="round"/><circle cx="22" cy="34" r="6" fill="#f5d0d8"/><circle cx="78" cy="66" r="5" fill="#b6cde0"/></svg>',
  date: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M24 40 Q24 22 50 22 Q76 22 76 40 Q76 60 50 80 Q24 60 24 40" fill="#f8d3c5"/><circle cx="50" cy="40" r="9" fill="#fff"/><path d="M30 70 Q50 84 70 70" fill="none" stroke="#b6cde0" stroke-width="4" stroke-linecap="round"/></svg>',
  audio: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M24 55 V47 Q24 24 50 24 Q76 24 76 47 V55" fill="none" stroke="#5c7b8f" stroke-width="6" stroke-linecap="round"/><rect x="18" y="49" width="17" height="30" rx="8" fill="#f8d3c5"/><rect x="65" y="49" width="17" height="30" rx="8" fill="#d5e4ed"/><path d="M50 38 V66 M42 48 V58 M58 45 V61" stroke="#f1b98f" stroke-width="4" stroke-linecap="round"/></svg>',
  trip: '<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="28" y="42" width="44" height="34" rx="6" fill="#f1b98f"/><rect x="40" y="30" width="20" height="14" rx="4" fill="none" stroke="#b6795a" stroke-width="4"/><circle cx="38" cy="60" r="4" fill="#fdf8f4"/><path d="M18 46 Q50 28 82 46" fill="none" stroke="#b6cde0" stroke-width="4" stroke-linecap="round"/></svg>',
  au: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 18 Q60 40 82 50 Q60 60 50 82 Q40 60 18 50 Q40 40 50 18" fill="#d5e4ed"/><circle cx="50" cy="50" r="8" fill="#fff"/><circle cx="30" cy="28" r="3" fill="#f1b98f"/><circle cx="74" cy="72" r="3" fill="#f5d0d8"/></svg>',
  first: '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="36" cy="44" r="12" fill="#f8d3c5"/><circle cx="64" cy="44" r="12" fill="#d5e4ed"/><path d="M24 74 Q36 60 48 72" fill="none" stroke="#f1b98f" stroke-width="4" stroke-linecap="round"/><path d="M52 72 Q64 60 76 74" fill="none" stroke="#5c7b8f" stroke-width="4" stroke-linecap="round"/><circle cx="50" cy="26" r="4" fill="#f5d0d8"/></svg>',
};

export default async function render(container) {
  const user = await ensureDefaultUser();
  let collected = 0;
  try { collected = await countCollectiblesForUser(user.id); } catch (_) { collected = 0; }

  container.className = 'page scrapbook-page encounter-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">相遇</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="encounter-scroll">
      <button type="button" class="encounter-card" data-go="time-machine">
        <span class="encounter-card-icon">${MODE_ICONS.timeMachine}</span>
        <span class="encounter-card-body">
          <strong>时光机</strong>
          <small>看 TA 的过往 · 或一起编织从前</small>
        </span>
        <span class="encounter-card-meta">${collected ? `已收集 ${collected} 件` : '去收集'} ›</span>
      </button>

      <button type="button" class="encounter-card" data-go="date">
        <span class="encounter-card-icon">${MODE_ICONS.date}</span>
        <span class="encounter-card-body">
          <strong>约会探索</strong>
          <small>一起出门，走一段线下</small>
        </span>
        <span class="encounter-card-meta">›</span>
      </button>

      <button type="button" class="encounter-card" data-go="audio">
        <span class="encounter-card-icon">${MODE_ICONS.audio}</span>
        <span class="encounter-card-body">
          <strong>音声线下</strong>
          <small>旁白与对白 · 单角色音声演出</small>
        </span>
        <span class="encounter-card-meta">›</span>
      </button>

      <button type="button" class="encounter-card" data-go="trip">
        <span class="encounter-card-icon">${MODE_ICONS.trip}</span>
        <span class="encounter-card-body">
          <strong>一起旅行</strong>
          <small>约定目的地，走一段多天的行程</small>
        </span>
        <span class="encounter-card-meta">›</span>
      </button>

      <button type="button" class="encounter-card" data-go="first">
        <span class="encounter-card-icon">${MODE_ICONS.first}</span>
        <span class="encounter-card-body">
          <strong>初遇</strong>
          <small>先见一面，再加入通讯录</small>
        </span>
        <span class="encounter-card-meta">›</span>
      </button>

      <button type="button" class="encounter-card" data-go="au">
        <span class="encounter-card-icon">${MODE_ICONS.au}</span>
        <span class="encounter-card-body">
          <strong>番外剧场</strong>
          <small>异世界脑洞 · 不写进真实记忆</small>
        </span>
        <span class="encounter-card-meta">›</span>
      </button>

      <button type="button" class="encounter-sub-link" data-go="date-log">我们的记录 · 回顾 / 继续过往的相遇</button>
      <button type="button" class="encounter-sub-link" data-go="archive">原文档案 · 回看完整生成记录</button>
      <button type="button" class="encounter-sub-link" data-go="regex">显示正则组 · 隐藏思维链 / 改写显示</button>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  container.querySelectorAll('[data-go]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const go = btn.getAttribute('data-go');
      if (go === 'time-machine') {
        navigate('encounter/time-machine');
      } else if (go === 'date') {
        navigate('encounter/date');
      } else if (go === 'audio') {
        navigate('encounter/audio');
      } else if (go === 'trip') {
        navigate('encounter/trip');
      } else if (go === 'first') {
        navigate('encounter/first');
      } else if (go === 'au') {
        navigate('encounter/au-theater');
      } else if (go === 'date-log') {
        navigate('encounter/date-log');
      } else if (go === 'archive') {
        navigate('narration-archive');
      } else if (go === 'regex') {
        navigate('display-regex');
      }
    });
  });
}
