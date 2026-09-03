/**
 * 棉花糖 流式策略与落库入口
 */

export { persistMarshmallowTurn, runChatAiTurn } from './ai-round.js';

export function shouldStreamAsMarshmallowProtocol(options = {}) {
  if (options.preferMarshmallowV2 === false || options.preferGuguV2 === false) return false;
  if (options.preferMarshmallowV2 === true || options.preferGuguV2 === true) return true;
  if (options.anonymousChat) return true;
  return true;
}
