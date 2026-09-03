import { selectPsychologicalContinuityForPrompt } from './psychological-continuity.js';

const STAGE_LABELS = Object.freeze({
  private: '只在心里成形',
  hinted: '已经暗示过',
  partial: '已经说出一部分',
  said: '已经说清',
});

const TRIGGER_LABELS = Object.freeze({
  user_ask: '对方沿原题追问',
  character_later: '角色在合适时机主动接回',
  similar_topic: '出现真正相似的话题',
  none: '没有约定触发',
});

function clean(value = '', max = 520) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trim()}…`;
}

function strengthLabel(value) {
  const number = Number(value || 0);
  if (number >= 0.7) return '余波较强';
  if (number >= 0.35) return '仍有影响';
  return '轻微余波';
}

function confidenceLabel(value) {
  const number = Number(value || 0);
  if (number >= 0.75) return '较确定';
  if (number >= 0.45) return '只是倾向';
  return '低把握推测';
}

/**
 * 把有界 runtime 投影成条件注入块。这里不回放原心声，也不把私有线头
 * 写成 user 已知事实；没有有效 topic/episode/disclosure 时返回空串。
 */
export function buildPsychologicalContinuityPromptBlock(
  runtime,
  characterId,
  characterName = '角色',
  options = {},
) {
  const actorId = clean(characterId, 120);
  if (!actorId || actorId === 'user' || actorId === 'system') return '';
  const selected = selectPsychologicalContinuityForPrompt(runtime, actorId, {
    now: options.now,
    topicId: options.topicId,
    limit: options.limit ?? 1,
    episodeLimit: options.episodeLimit ?? 2,
    excludeAiRoundIds: options.excludeAiRoundIds,
    excludeAiRoundId: options.excludeAiRoundId,
  });
  const disclosureThreads = selected.disclosureThreads;
  const episodes = selected.episodes;
  const topic = selected.topic;
  const selfDisclosureDebt = Number(selected.selfDisclosureDebt || 0);
  if (
    !topic
    && !disclosureThreads.length
    && !episodes.length
    && selfDisclosureDebt < 2
  ) return '';

  const scopedName = `${clean(characterName, 120) || '角色'}（id=${actorId}）`;
  const lines = [
    `[${scopedName}当前心理连续性 · 结构化线头]`,
    '以下是这个角色私有、仍可能影响本轮的压缩状态，不是对方已经知道的事实，也不是必须照表推进的剧情任务。先读最新消息，再决定承接、推进、暂缓或收线；这份结构化列表属于系统账本，绝不能改写、概括或按顺序搬进 state.inner。表达欲要从最新输入与这些真实余波、线头共同派生，不能先选高档再回来搜素材。',
  ];
  const topicDuplicatesDisclosure = !!(
    topic
    && disclosureThreads.some((thread) => clean(thread.proposition, 520) === clean(topic.summary, 520))
  );
  if (topic && !topicDuplicatesDisclosure) {
    lines.push(`- 当前相关话题「${clean(topic.summary, 320)}」；最近动作「${clean(topic.lastMove, 120) || '仍在进行'}」。`);
  }
  for (const episode of episodes) {
    lines.push(`- 心理余波「${clean(episode.content, 360)}」；${strengthLabel(episode.effectiveIntensity)}，${confidenceLabel(episode.confidence)}。低把握推测必须保留“可能/拿不准”，不能升级成角色已知事实。`);
  }
  for (const thread of disclosureThreads) {
    const triggers = (Array.isArray(thread.triggers) ? thread.triggers : [])
      .map((value) => TRIGGER_LABELS[value])
      .filter(Boolean)
      .join('、') || TRIGGER_LABELS.none;
    lines.push(`- 线头 id=${clean(thread.id, 120)}：仍未完的内容「${clean(thread.proposition, 520)}」；目前${STAGE_LABELS[thread.disclosureStage] || STAGE_LABELS.private}；触发条件：${triggers}。真正交出这一层时，回复组织收据必须原样复用这个 id。`);
  }
  if (disclosureThreads.length) {
    lines.push(
      '若最新输入已经命中上述触发，而且角色确实把表达欲判为 engaged / overflowing，本轮可见回复要对对应线头产生一种真实语义变化：交出一层新内容、明确暂缓，或给出边界并关题；一条自然消息可以同时完成回应与推进，不需要拆成“首先/其次”或固定三拍。若角色此刻不想说，就把表达欲如实判低并保留、降温或推翻线头；不得只在 inner 里想过就算兑现，也不得换个问句再次延期。没有命中时不能强行把旧线头抢成当前话题。',
    );
  }
  if (selfDisclosureDebt >= 2) {
    lines.push(
      '- 连续表达压力：此前至少两次出现“角色确认高表达欲来自未完线头，却没有在可见回复中推进”的落差。先检查最新输入是否仍命中那条具体线头；命中才自然推进、暂缓或关题，没有命中就继续保留，绝不能用一段泛化自我分享偿还。这里校验的是状态与可见语义是否一致，不要求经历、观点、联想、追问等任何固定类别或条数。',
    );
  }
  return lines.join('\n');
}
