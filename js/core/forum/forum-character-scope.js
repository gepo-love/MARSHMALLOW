import { listSocialVisibleCharacters } from '../social-character-scope.js';

/**
 * 论坛属于 user 面具。已绑定身份时按绑定角色/分组取人；未绑定时使用通讯录全员。
 * 是否已经出现在聊天列表或论坛历史里，不应决定角色有没有资格参与生成。
 */
export async function listForumVisibleCharacters(user, options = {}) {
  return listSocialVisibleCharacters(user, options);
}
