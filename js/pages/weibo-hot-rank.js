import { back, navigate } from '../core/router.js';
import * as db from '../core/db.js';
import { listActiveWeiboPosts } from '../core/weibo/weibo-post-store.js';
import { buildWeiboDiscoveryIndex } from '../core/weibo/weibo-discovery-service.js';
import { icon } from '../components/svg-icons.js';

function e(value = '') {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default async function render(container) {
  const currentUserId = (await db.get('settings', 'currentUserId'))?.value || '';
  const ownerUserId = currentUserId || 'guest';
  const [metaRow, posts] = await Promise.all([
    db.get('settings', `weiboMeta_${ownerUserId}`),
    listActiveWeiboPosts({ ownerUserId }),
  ]);
  const meta = metaRow?.value || {};
  const discovery = buildWeiboDiscoveryIndex({ posts, meta });
  const labels = [];
  const seen = new Set();
  for (const raw of [...(meta.trending || []), ...discovery.topics.map((item) => item.label)]) {
    const label = String(typeof raw === 'string' ? raw : raw?.topic || raw?.title || raw?.name || '').replace(/^#+|#+$/g, '').trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  const rows = labels.slice(0, 30).map((label, rankIndex) => {
    const topic = discovery.topics.find((item) => item.label === label);
    const heat = Number(topic?.postCount || 0) * 12873 + Math.max(0, 98642 - rankIndex * 6137);
    const mark = rankIndex === 0 ? '爆' : rankIndex < 3 ? '热' : (rankIndex === 4 || rankIndex === 7 ? '新' : '');
    return `<button type="button" class="wbhot-rank-row" data-topic="${e(label)}"><b>${rankIndex + 1}</b><span><strong>${e(label)}</strong><small>${heat}</small></span>${mark ? `<i data-mark="${mark}">${mark}</i>` : ''}</button>`;
  }).join('');

  container.classList.add('weibo-page', 'weibo-hot-rank-page');
  container.innerHTML = `
    <header class="wbhot-rank-hero"><button type="button" class="wbhot-rank-back" aria-label="返回">${icon('back')}</button><div><strong>微博热搜</strong><span>懂你的热点雷达</span></div><button type="button" class="wbhot-rank-more" aria-label="生成热搜或超话">${icon('sparkle')}</button></header>
    <div class="wbhot-rank-tabs" role="tablist"><button class="is-active">我的</button><button>热搜</button><button>文娱</button><button>生活</button><button>社会</button><button>同城</button></div>
    <div class="wbhot-rank-caption">热搜雷达，发现你关心的热点</div>
    <div class="page-scroll wbhot-rank-scroll">${rows || '<div class="wbsearch-empty">暂无热搜内容</div>'}</div>`;
  container.querySelector('.wbhot-rank-back')?.addEventListener('click', () => back());
  container.querySelector('.wbhot-rank-more')?.addEventListener('click', () => navigate('weibo', {
    panel: 'topics',
    topicGeneratorReturn: 'hot-rank',
  }, true));
  container.querySelectorAll('[data-topic]').forEach((button) => button.addEventListener('click', () => navigate('weibo-topic', { topic: button.dataset.topic })));
}
