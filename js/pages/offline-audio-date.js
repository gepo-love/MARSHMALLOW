import renderOfflineDate from './offline-date.js';
import { OFFLINE_EXPERIENCE_AUDIO } from '../core/offline-experience-mode.js';

export default function render(container, params = {}) {
  return renderOfflineDate(container, {
    ...params,
    experienceMode: OFFLINE_EXPERIENCE_AUDIO,
  });
}
