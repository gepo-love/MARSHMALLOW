/**
 * 心声弹层出厂样式：出厂自带、不可删除，排在自存预设前面。
 * - 奶油手账：原版样式（默认）
 * - ins 小白卡：ins 风白卡 + 头像，配合海 / 窗主题聊天页
 */
export const BUILTIN_INNER_VOICE_CARD_PRESETS = [
  {
    id: 'builtin_inner_voice_diary',
    name: '奶油手账',
    template: 'diary',
    position: 'center',
    css: '',
    labels: {},
  },
  {
    id: 'builtin_inner_voice_ins',
    name: 'ins 小白卡',
    template: 'ins',
    position: 'center',
    css: '',
    labels: {},
  },
];
