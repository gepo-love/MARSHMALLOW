import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listStreamerChannelsForUser, sampleStreamerFeed } from '../core/streamer-store.js';
import { getStreamerPopularityTierById } from '../data/streamer-presets.js';

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

function coverStyle(cover = '') {
  const src = String(cover || '').trim();
  if (/^(data:image\/|https?:\/\/|blob:)/i.test(src)) {
    return `style="background-image:url(${escAttr(src)});background-size:cover;background-position:center"`;
  }
  return '';
}

function renderDanmakuTicker(channel) {
  const texts = (channel.recentDanmaku || []).slice(0, 6).map((d) => esc(d.text)).filter(Boolean);
  if (!texts.length) return '<span class="streamer-ticker-empty">刚开播，还没有弹幕</span>';
  const joined = texts.join(' · ');
  return `<span>${joined}　·　${joined}</span>`;
}

function renderCard(channel) {
  const tier = getStreamerPopularityTierById(channel.persona?.popularityTier);
  const isGenerated = channel.sourceType === 'generated';
  const ended = channel.status === 'ended';
  return `
    <button type="button" class="streamer-card ${ended ? 'is-ended' : ''}" data-channel-id="${escAttr(channel.id)}">
      <div class="streamer-card-cover" ${coverStyle(channel.currentSceneImage || channel.persona?.avatarCover)}>
        ${ended
          ? '<span class="streamer-card-offline-badge">已下播</span>'
          : '<span class="streamer-live-badge" aria-hidden="true"><i></i>LIVE</span>'}
        <span class="streamer-tier-badge">${esc(tier.label)}</span>
        ${isGenerated ? '<span class="streamer-source-badge">新面孔</span>' : ''}
      </div>
      <div class="streamer-card-body">
        <strong>${esc(channel.persona?.handle || '匿名主播')}</strong>
        <small>${esc(channel.persona?.categoryLabel || '直播中')}</small>
      </div>
      <div class="streamer-card-ticker" aria-hidden="true">${renderDanmakuTicker(channel)}</div>
    </button>
  `;
}

export default async function render(container) {
  const user = await ensureDefaultUser();
  let channels = (await listStreamerChannelsForUser(user.id)).filter((c) => !c.ephemeral);

  container.className = 'page anon-page anon-streamer-hub-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">深夜主播</h1>
      <button type="button" class="navbar-btn" data-go-create aria-label="开播">${icon('plus')}</button>
    </header>
    <main class="anon-scroll streamer-hub-scroll">
      <section class="anon-create-poster streamer-hub-poster">
        <strong>此刻，谁在直播</strong>
        <span>不露脸的深夜频道，弹幕自己会说话</span>
      </section>
      <button type="button" class="btn btn-outline btn-block streamer-match-entry" data-go-match>
        ${icon('sparkle')}<span>随机匹配一个主播</span>
      </button>
      <div class="streamer-feed-grid" id="streamer-feed-grid"></div>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());
  container.querySelector('[data-go-create]')?.addEventListener('click', () => navigate('anon/streamer/create'));
  container.querySelector('[data-go-match]')?.addEventListener('click', () => navigate('anon/streamer/match'));

  function paintFeed() {
    const grid = container.querySelector('#streamer-feed-grid');
    if (!grid) return;
    if (!channels.length) {
      grid.innerHTML = '<div class="anon-empty">还没有任何频道，先开一间，或去随机匹配一个主播</div>';
      return;
    }
    const feed = sampleStreamerFeed(channels, 30);
    grid.innerHTML = feed.map(renderCard).join('');
    grid.querySelectorAll('[data-channel-id]').forEach((card) => {
      card.addEventListener('click', () => {
        navigate('anon/streamer/room', { channelId: card.getAttribute('data-channel-id') });
      });
    });
  }

  paintFeed();
}
