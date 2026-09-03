/**
 * 线下邀约/见面的路程摘要。
 * 开了高德且能解析出双方坐标时用真实算路；没开高德或解析失败时虚构一个自然的导航时间，
 * 保证「没开高德也照样能用、活人感不掉线」。
 */
import { normalizeLocationProfile, getBaseLocationAnchor, describeLocationAnchor } from '../location-profile.js';
import { loadAmapConfig, amapTextSearch, amapRoutePlan, isAmapLocation } from '../amap-tools.js';

function clean(value = '', max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDuration(seconds = 0) {
  const minutes = Math.max(0, Math.round((Number(seconds) || 0) / 60));
  if (!minutes) return '';
  if (minutes >= 60) return `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分钟` : ''}`;
  return `${minutes}分钟`;
}

const FABRICATED_MODES = [
  { mode: 'walk', label: '步行', min: 6, max: 18 },
  { mode: 'ride', label: '骑车', min: 8, max: 22 },
  { mode: 'drive', label: '打车', min: 12, max: 35 },
];

function fabricateEta() {
  const pick = FABRICATED_MODES[Math.floor(Math.random() * FABRICATED_MODES.length)];
  const minutes = pick.min + Math.floor(Math.random() * (pick.max - pick.min + 1));
  return { mode: pick.mode, durationText: `${pick.label}大约${minutes}分钟` };
}

/**
 * @param {object} options
 * @param {object} options.character - 出发方角色档案（用于取住址/生活圈锚点）
 * @param {string} options.destinationLabel - 目的地文字（第三方地点或用户设的位置标签）
 * @param {string} [options.destinationLocation] - 目的地坐标 "lng,lat"（已知时可跳过搜索）
 */
export async function buildOfflineInviteRoutePlan({
  character = null,
  destinationLabel = '',
  destinationLocation = '',
} = {}) {
  const profile = normalizeLocationProfile(character || {});
  const base = getBaseLocationAnchor(profile);
  const originLabel = clean(describeLocationAnchor(base) || profile.region || profile.city?.name || '', 80) || '出发地';
  const destLabel = clean(destinationLabel, 80) || '约定地点';
  const eta = fabricateEta();
  const fallback = {
    source: 'text_fallback',
    mode: eta.mode,
    originLabel,
    destinationLabel: destLabel,
    durationText: eta.durationText,
    distanceText: '',
    summary: `${originLabel} → ${destLabel} · ${eta.durationText}`,
  };

  const cfg = await loadAmapConfig().catch(() => null);
  if (!cfg?.enabled || !cfg?.apiKey || profile.mapEnabled === false) return fallback;

  try {
    const city = clean(profile.city?.name || '', 40);
    let originLoc = isAmapLocation(base?.location) ? base.location : '';
    if (!originLoc && originLabel) {
      const found = await amapTextSearch({ keywords: originLabel, city, maxResults: 1 }).catch(() => null);
      originLoc = found?.pois?.[0]?.location || '';
    }
    let destLoc = isAmapLocation(destinationLocation) ? destinationLocation : '';
    if (!destLoc && destLabel) {
      const found = await amapTextSearch({ keywords: destLabel, city, maxResults: 1 }).catch(() => null);
      destLoc = found?.pois?.[0]?.location || '';
    }
    if (!originLoc || !destLoc || originLoc === destLoc) return fallback;

    const driven = await amapRoutePlan({ origin: originLoc, destination: destLoc, mode: 'drive', city }).catch(() => null);
    const driveRoute = driven?.route;
    if (!driveRoute || (!driveRoute.distance && !driveRoute.duration)) return fallback;

    const distanceKm = driveRoute.distance ? driveRoute.distance / 1000 : 0;
    let finalRoute = driveRoute;
    let mode = 'drive';
    if (distanceKm > 0 && distanceKm <= 1.2) {
      const walked = await amapRoutePlan({ origin: originLoc, destination: destLoc, mode: 'walk', city }).catch(() => null);
      if (walked?.route?.duration) {
        finalRoute = walked.route;
        mode = 'walk';
      }
    }
    const durationText = formatDuration(finalRoute.duration);
    if (!durationText) return fallback;
    const distanceText = finalRoute.distance ? `${(finalRoute.distance / 1000).toFixed(1)}公里` : '';
    const modeLabel = mode === 'walk' ? '步行' : '打车';
    return {
      source: 'amap_route',
      mode,
      originLabel,
      destinationLabel: destLabel,
      durationText: `${modeLabel}大约${durationText}`,
      distanceText,
      summary: `${originLabel} → ${destLabel} · ${distanceText ? `${distanceText} · ` : ''}${modeLabel}大约${durationText}`,
    };
  } catch (_) {
    return fallback;
  }
}
