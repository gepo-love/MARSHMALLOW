/**
 * 「确认式搜索」交互：打字过程中不触发任何重绘，只有回车或点搜索键才真正执行一次搜索。
 *
 * 背景：不少选人/搜索列表在输入框的 input 事件里直接重绘整段 HTML（含输入框本身），
 * 结果是打字或删字每敲一下就重建一次 DOM——移动端表现为输入焦点丢失、键盘被顶掉，
 * 删掉一个名字想搜下一个人时得重新点一下输入框才能继续打字，体验很割裂。
 * 统一改成：输入过程只是纯输入，不联动列表；直到用户主动确认（回车 / 点搜索图标 /
 * 点原生搜索框的清空按钮）才提交查询词并触发一次真正的搜索重绘。
 *
 * @param {object} options
 * @param {HTMLInputElement|null|undefined} options.input 搜索输入框
 * @param {HTMLElement|null|undefined} [options.trigger] 搜索图标/按钮，点击即提交
 * @param {(value: string) => void} options.onCommit 提交时回调，参数为输入框当前值
 */
export function bindCommitSearch({ input, trigger, onCommit } = {}) {
  if (!input || typeof onCommit !== 'function') return;
  const commit = () => onCommit(String(input.value || ''));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      input.blur();
    }
  });
  // input[type=search] 在按下回车或点原生圆叉清空按钮时会触发 search 事件，
  // 借这个信号让"清空搜索框"也能立刻回到完整列表，不用额外再点搜索键。
  input.addEventListener('search', commit);
  trigger?.addEventListener('click', commit);
}
