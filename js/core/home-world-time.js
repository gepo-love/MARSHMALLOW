import { getNowForUser, getUserTimezone } from './time-mode.js';
import { zonedDateProxy } from './user-timezone.js';

export function homeWorldDateFromTimestamp(timestamp, timeZone = '') {
  return zonedDateProxy(timestamp, timeZone);
}

/**
 * 主屏只负责显示“当前档位眼里的现在”：
 * - 现实同步：跟随设备/用户所选时区；
 * - 虚拟时间：跟随世界时钟的暂停、倍速、跳转与追平状态。
 * 返回的是墙上时间代理，只供 Date 格式化方法读取，不可作为绝对时间戳存库。
 */
export async function getHomeWorldDate(userId = '') {
  const id = String(userId || '').trim();
  if (!id) return new Date();
  const [timestamp, timeZone] = await Promise.all([
    getNowForUser(id),
    getUserTimezone(id),
  ]);
  return homeWorldDateFromTimestamp(timestamp, timeZone);
}
