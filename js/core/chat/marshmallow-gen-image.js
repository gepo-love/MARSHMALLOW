import { createMessage } from '../../models/chat.js';
import { getRecord, putRecord } from '../db.js';
import {
  generateImageForScene,
  isImageGenerationOutcomeUnknown,
  normalizeImageAspect,
  persistGeneratedImageUrlLocally,
} from '../image-generation-tools.js';
import { mergeImageLockIntoOptions } from '../character-image-lock.js';
import {
  applyMultiActorImageLocks,
  normalizeImageSubjectIds,
} from '../multi-actor-image-lock.js';
import { saveMessage, updateChatPreview, previewFromMessage } from '../chat-store.js';
import { getNowForUser } from '../time-mode.js';
import { isAnonymousChat } from '../chat-helpers.js';
import { applyAnonymousIdentityPatch } from '../anonymous-chat.js';
import { showToast } from '../../components/toast.js';
import { getCharacter, saveCharacterForUser } from '../character-store.js';

/** 按画面中的 user / 多角色主体加工 prompt 与参考图参数。 */
async function buildLockedChatImageGeneration(subjectIds, prompt, baseOptions = {}) {
  const {
    allowedIds,
    user,
    characters,
    ...generationOptions
  } = baseOptions;
  const lock = await applyMultiActorImageLocks(subjectIds, prompt, {
    ...generationOptions,
    allowedIds,
    user,
    characters,
  }).catch(() => null);
  const genOptions = mergeImageLockIntoOptions(lock, generationOptions);
  if (lock?.referenceSubjects?.length) genOptions.referenceSubjects = lock.referenceSubjects;
  if (lock?.subjectIds?.length) genOptions.subjectIds = lock.subjectIds;
  return { prompt: lock?.prompt || prompt, options: genOptions };
}

export function resolveEventImageSubjectIds(event = {}, actorId = '', participants = new Set()) {
  const requested = event.subjects ?? event.subjectIds ?? event.actors ?? [];
  const ids = normalizeImageSubjectIds(requested, { allowedIds: participants });
  const actor = String(actorId || '').trim();
  const actorAllowed = !!actor && (!(participants instanceof Set) || participants.size === 0 || participants.has(actor));
  const identity = normalizeImageIdentity(event.identity);
  const peopleIntent = normalizePeopleIntent(event.people);

  // “本人”是比模型自由填写的 subjects 更可靠的结构化信号。
  // 单人自拍若被误标成 user/其他角色，过去会完整跳过发送者的参考图，只剩外观提示词。
  if (identity === 'self' && actorAllowed) {
    if (ids.length <= 1) return [actor];
    if (!ids.includes(actor)) {
      return normalizeImageSubjectIds([actor, ...ids], { allowedIds: participants });
    }
  }

  // 明确是路人/他人且没有给出可识别主体时，不要反过来套发送者的脸。
  if (!ids.length && (identity === 'other' || peopleIntent === 'none')) return [];
  if (!ids.length && actorAllowed) ids.push(actor);
  return ids;
}

function normalizePeopleIntent(value) {
  if (value === true) return 'portrait';
  if (value === false) return 'none';
  const key = String(value || '').trim().toLowerCase();
  if (['portrait', 'present', 'people', 'person', 'yes', '有', '有人'].includes(key)) return 'portrait';
  if (['partial', 'body', 'anonymous', '局部', '背影', '不露脸'].includes(key)) return 'partial';
  if (['none', 'no', 'empty', '无人', '没有'].includes(key)) return 'none';
  return '';
}

function normalizeImageIdentity(value) {
  const key = String(value || '').trim().toLowerCase();
  if (['self', 'actor', 'character', 'preserve', '本人', '自己', '角色'].includes(key)) return 'self';
  if (['other', 'none', 'anonymous', '路人', '他人', '其他'].includes(key)) return 'other';
  return '';
}

const MAX_STORED_IMAGE_ERROR_CHARS = 1200;

function imageGenerationFailureMetadata(error) {
  const message = String(error?.message || error || '图片生成失败').trim() || '图片生成失败';
  const persistDiagnostics = error?.persistDiagnostics && typeof error.persistDiagnostics === 'object'
    ? {
      target: String(error.persistDiagnostics.target || '').slice(0, 300),
      authApplied: error.persistDiagnostics.authApplied === true,
      native: String(error.persistDiagnostics.native || '').slice(0, 160),
      direct: String(error.persistDiagnostics.direct || '').slice(0, 160),
      proxy: String(error.persistDiagnostics.proxy || '').slice(0, 160),
    }
    : null;
  return {
    generationError: message.slice(0, MAX_STORED_IMAGE_ERROR_CHARS),
    generationErrorCode: String(error?.code || error?.timeoutStage || '').slice(0, 80),
    generationErrorElapsedMs: Math.max(0, Number(error?.requestElapsedMs || 0)),
    generationErrorTarget: String(error?.targetOrigin || error?.usedUrl || '').slice(0, 300),
    generationResultUnknown: isImageGenerationOutcomeUnknown(error),
    generationRetryUnsafe: error?.replayBlocked === true || isImageGenerationOutcomeUnknown(error),
    generationFailedAt: Date.now(),
    generationPersistDiagnostics: persistDiagnostics,
  };
}

function clearedImageGenerationFailureMetadata() {
  return {
    generationError: '',
    generationErrorCode: '',
    generationErrorElapsedMs: 0,
    generationErrorTarget: '',
    generationResultUnknown: false,
    generationRetryUnsafe: false,
    generationFailedAt: 0,
    generationPersistDiagnostics: null,
  };
}

export const GEN_IMAGE_STUCK_MS = 90 * 1000;

// 生成接口本身最长会等 5 分钟，不能只因超过 90 秒就把仍在执行的请求误报为“卡住”。
// token 还能避免旧任务的 finally 把同一消息后来启动的新任务从表里删掉。
const activeGeneratedImageJobs = new Map();

function beginGeneratedImageJob(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return null;
  if (activeGeneratedImageJobs.has(id)) return null;
  const token = {};
  activeGeneratedImageJobs.set(id, token);
  return token;
}

function endGeneratedImageJob(messageId, token) {
  const id = String(messageId || '').trim();
  if (id && activeGeneratedImageJobs.get(id) === token) activeGeneratedImageJobs.delete(id);
}

export function isGeneratedImageJobActive(messageId) {
  return activeGeneratedImageJobs.has(String(messageId || '').trim());
}

export function getGenImageStartedAt(message = {}) {
  const md = message?.metadata || {};
  const started = Number(md.generationStartedAt || 0);
  if (started > 0) return started;
  const ts = Number(message?.timestamp || 0);
  return ts > 0 ? ts : 0;
}

export function isGeneratedImageMessage(message = {}) {
  return String(message?.type || '') === 'image' && message?.metadata?.generatedImage === true;
}

export function canRerollGeneratedImage(message = {}) {
  return isGeneratedImageMessage(message) && !!String(message?.metadata?.prompt || '').trim();
}

export function isGenImageStuck(message = {}) {
  if (!message?.metadata?.generatingImage) return false;
  if (isGeneratedImageJobActive(message?.id)) return false;
  const started = getGenImageStartedAt(message);
  if (!started) return true;
  return Date.now() - started >= GEN_IMAGE_STUCK_MS;
}

/**
 * 页面被系统回收/刷新后，原 Promise 已不存在，但 IndexedDB 里可能还留着“生成中”。
 * 若服务端已经返回过图片地址，先只补做本地保存，绝不重新调用生图接口；否则标成
 * “结果未知”，让再次生图前走二次确认，避免已经扣费的请求被静默重放。
 */
export async function recoverInterruptedGeneratedImageMessage(messageId, options = {}) {
  const id = String(messageId || '').trim();
  if (!id || isGeneratedImageJobActive(id)) return null;
  const msg = await getRecord('messages', id).catch(() => null);
  if (!msg?.metadata?.generatingImage || !isGenImageStuck(msg)) return msg;

  const remoteUrl = String(msg.metadata?.generationRemoteUrl || '').trim();
  if (remoteUrl) {
    const token = beginGeneratedImageJob(id);
    if (!token) return getRecord('messages', id).catch(() => msg);
    try {
      const localUrl = await persistChatGeneratedImageLocally(remoteUrl, { signal: options.signal });
      const latest = await getRecord('messages', id).catch(() => null) || msg;
      latest.content = localUrl;
      latest.metadata = {
        ...(latest.metadata || {}),
        generatingImage: false,
        generationFailed: false,
        generationStage: '',
        generationRemoteUrl: '',
        generationStartedAt: 0,
        generatedImageStoredLocally: true,
        ...clearedImageGenerationFailureMetadata(),
      };
      await saveMessage(latest);
      await updateChatPreview(latest.chatId, previewFromMessage(latest), latest.timestamp);
      return latest;
    } catch (error) {
      const latest = await getRecord('messages', id).catch(() => null) || msg;
      latest.metadata = {
        ...(latest.metadata || {}),
        ...imageGenerationFailureMetadata(error),
        generatingImage: false,
        generationFailed: true,
        generationStage: 'persist_failed',
        generationResultUnknown: false,
        generationRetryUnsafe: false,
        generationErrorCode: 'persist_failed',
        generationErrorElapsedMs: 0,
        generationErrorTarget: '',
        generationError: `图片已经生成，但未能保存到本机：${String(error?.message || error).slice(0, 300)}`,
        generationFailedAt: Date.now(),
      };
      await saveMessage(latest);
      return latest;
    } finally {
      endGeneratedImageJob(id, token);
    }
  }

  msg.metadata = {
    ...(msg.metadata || {}),
    generatingImage: false,
    generationFailed: true,
    generationStage: 'interrupted',
    generationError: '上次生图任务被页面刷新或系统回收中断，没有收到可保存的图片。服务端可能已经生成并计费，请先检查生成记录。',
    generationErrorCode: 'client_interrupted',
    generationResultUnknown: true,
    generationRetryUnsafe: true,
    generationFailedAt: Date.now(),
  };
  await saveMessage(msg);
  await updateChatPreview(msg.chatId, previewFromMessage(msg), msg.timestamp);
  return msg;
}

/**
 * 聊天生图会长期出现在历史消息与备份中，不能把短时效远程 URL 当作成功结果落库。
 * 先压缩为备份安全的 data URL；本地化失败则由上层保留提示词和重 roll 入口。
 */
export async function persistChatGeneratedImageLocally(url, options = {}) {
  const localUrl = await persistGeneratedImageUrlLocally(url, {
    ...(options.signal ? { signal: options.signal } : {}),
    optimizeForStorage: true,
    requireLocal: true,
  });
  if (!/^data:image\//i.test(String(localUrl || '').trim())) {
    throw new Error('生成成功，但图片未能保存到本地，请重试');
  }
  return localUrl;
}

const legacyGeneratedImageLocalizationJobs = new Map();

/** 尚未过期的旧远程生图在成功显示时立刻补转成本地数据，避免下一次打开才失效。 */
export function localizeLegacyGeneratedImageMessage(messageId, options = {}) {
  const id = String(messageId || '').trim();
  if (!id) return Promise.resolve('');
  if (legacyGeneratedImageLocalizationJobs.has(id)) {
    return legacyGeneratedImageLocalizationJobs.get(id);
  }
  const job = (async () => {
    const before = await getRecord('messages', id);
    const remoteUrl = String(before?.content || before?.metadata?.url || '').trim();
    if (before?.metadata?.generatedImage !== true || !/^https?:\/\//i.test(remoteUrl)) return '';

    const localUrl = await persistChatGeneratedImageLocally(remoteUrl, options);
    const latest = await getRecord('messages', id);
    const latestUrl = String(latest?.content || latest?.metadata?.url || '').trim();
    if (!latest || latestUrl !== remoteUrl) return '';
    latest.content = localUrl;
    latest.metadata = {
      ...(latest.metadata || {}),
      url: '',
      generatedImageStoredLocally: true,
      generatedImageLocalizedAt: Date.now(),
    };
    await saveMessage(latest);
    return localUrl;
  })().finally(() => {
    legacyGeneratedImageLocalizationJobs.delete(id);
  });
  legacyGeneratedImageLocalizationJobs.set(id, job);
  return job;
}

/**
 * 棉花糖 gen_image 事件落库与真实生图（对齐原项目 chat-window applyMarshmallowGeneratedImageEvents）
 */
export async function applyMarshmallowGeneratedImageEvents(events = [], options = {}) {
  const sourceChatId = String(options.sourceChatId || options.sourceChat?.id || '').trim();
  const items = (Array.isArray(events) ? events : []).filter((event) => event?.t === 'gen_image');
  if (!sourceChatId || !items.length) {
    return { handled: 0, skipped: 0, chat: options.sourceChat || null };
  }
  let handled = 0;
  let skipped = 0;
  const chatRow = await getRecord('chats', sourceChatId);
  if (!chatRow) return { handled, skipped: items.length, chat: options.sourceChat || null };
  const participants = new Set((chatRow.participants || []).map((id) => String(id || '').trim()).filter(Boolean));
  const resolveName = typeof options.resolveSenderName === 'function'
    ? options.resolveSenderName
    : async (id) => String(id || '');

  for (const event of items.slice(0, 2)) {
    const actorId = String(event.from || '').trim();
    const prompt = String(event.prompt || '').trim();
    const aspect = normalizeImageAspect(event.shape || event.aspect || '');
    const peopleIntent = normalizePeopleIntent(event.people);
    const imageIdentity = normalizeImageIdentity(event.identity);
    const subjectIds = resolveEventImageSubjectIds(event, actorId, participants);
    if (!actorId || !participants.has(actorId) || !prompt) {
      skipped += 1;
      continue;
    }
    const placeholderMessageId = String(event.placeholderMessageId || '').trim();
    const jobToken = beginGeneratedImageJob(placeholderMessageId);
    if (placeholderMessageId && !jobToken) {
      skipped += 1;
      continue;
    }
    let generatedRemoteUrl = '';
    try {
      const locked = await buildLockedChatImageGeneration(subjectIds, prompt, {
        signal: options.signal,
        allowedIds: participants,
        user: options.user,
        characters: options.characters,
        respectConfiguredSize: true,
        ...(aspect ? { aspect } : {}),
        ...(peopleIntent ? { peopleIntent } : {}),
        ...(peopleIntent && peopleIntent !== 'none' ? { characterStyleAllowed: true } : {}),
        ...((peopleIntent === 'portrait' || imageIdentity === 'self') ? { preserveIdentity: true } : {}),
      });
      const generated = await generateImageForScene(locked.prompt, 'chatImages', locked.options);
      if (generated?.referenceSkipped) {
        showToast('参考图锁定未生效，已改用文字外观生成', 5000);
      }
      let url = String(generated?.url || '').trim();
      if (!url) throw new Error('没有生成图片地址');
      generatedRemoteUrl = url;
      if (placeholderMessageId) {
        const placeholder = await getRecord('messages', placeholderMessageId);
        if (placeholder && String(placeholder.chatId || '') === sourceChatId) {
          placeholder.metadata = {
            ...(placeholder.metadata || {}),
            generationStage: 'persisting',
            generationRemoteUrl: url,
          };
          await saveMessage(placeholder);
        }
      }
      url = await persistChatGeneratedImageLocally(url, { signal: options.signal });

      if (event.use === 'avatar') {
        let avatarSaved = false;
        if (isAnonymousChat(chatRow)) {
          applyAnonymousIdentityPatch(chatRow, actorId, { avatar: url });
          await putRecord('chats', chatRow);
          avatarSaved = true;
        } else {
          const userId = String(options.userId || '').trim();
          const stored = userId
            ? await getCharacter(actorId, { userId }).catch(() => null)
            : null;
          if (stored && userId) {
            const saved = await saveCharacterForUser(
              userId,
              { ...stored, id: actorId, avatar: url },
              { forceOverride: true },
            );
            avatarSaved = String(saved?.avatar || '').trim() === url;
          }
        }
        if (!avatarSaved) {
          skipped += 1;
          continue;
        }
        handled += 1;
        continue;
      }

      if (placeholderMessageId) {
        const placeholder = await getRecord('messages', placeholderMessageId);
        if (placeholder && String(placeholder.chatId || '') === sourceChatId) {
          placeholder.content = url;
          placeholder.metadata = {
            ...(placeholder.metadata || {}),
            generatingImage: false,
            generatedImage: true,
            generationFailed: false,
            generationStage: '',
            generationRemoteUrl: '',
            generationStartedAt: 0,
            generatedImageStoredLocally: true,
            ...clearedImageGenerationFailureMetadata(),
            prompt,
            imageSubjectIds: subjectIds,
            imageReferenceSubjectIds: locked.options.referenceSubjects?.map((row) => row.id) || [],
            imageReferenceSubmittedCount: Number(generated?.referenceSubmittedCount || 0),
            ...(peopleIntent ? { imagePeople: peopleIntent } : {}),
            ...(imageIdentity ? { imageIdentity } : {}),
            ...(generated?.referenceSkipped ? { imageReferenceSkipped: true } : {}),
            ...(aspect ? { imageAspect: aspect } : {}),
            ...(event.caption ? { caption: event.caption, text: event.caption } : {}),
            ...(event.reason ? { reason: event.reason } : {}),
            ...(options.aiRoundId ? { aiRoundId: options.aiRoundId } : {}),
          };
          await saveMessage(placeholder);
          await updateChatPreview(sourceChatId, previewFromMessage(placeholder), placeholder.timestamp);
          handled += 1;
          continue;
        }
      }

      const senderName = await resolveName(actorId);
      const ts = await getNowForUser(options.userId || '');
      const imageMsg = createMessage({
        chatId: sourceChatId,
        senderId: actorId,
        senderName,
        type: 'image',
        content: url,
        timestamp: ts,
        metadata: {
          protocol: 'MARSHMALLOW_CHAT_V2',
          marshmallowEventType: 'gen_image',
          generatedImage: true,
          ...clearedImageGenerationFailureMetadata(),
          prompt,
          imageSubjectIds: subjectIds,
          imageReferenceSubjectIds: locked.options.referenceSubjects?.map((row) => row.id) || [],
          imageReferenceSubmittedCount: Number(generated?.referenceSubmittedCount || 0),
          ...(peopleIntent ? { imagePeople: peopleIntent } : {}),
          ...(imageIdentity ? { imageIdentity } : {}),
          ...(generated?.referenceSkipped ? { imageReferenceSkipped: true } : {}),
          ...(aspect ? { imageAspect: aspect } : {}),
          ...(event.caption ? { caption: event.caption, text: event.caption } : {}),
          ...(event.reason ? { reason: event.reason } : {}),
          ...(options.aiRoundId ? { aiRoundId: options.aiRoundId } : {}),
        },
      });
      await saveMessage(imageMsg);
      await updateChatPreview(sourceChatId, previewFromMessage(imageMsg), imageMsg.timestamp);
      handled += 1;
    } catch (err) {
      skipped += 1;
      let failedPlaceholderUpdated = false;
      if (placeholderMessageId) {
        const placeholder = await getRecord('messages', placeholderMessageId);
        if (placeholder && String(placeholder.chatId || '') === sourceChatId) {
          placeholder.content = '';
          placeholder.metadata = {
            ...(placeholder.metadata || {}),
            generatingImage: false,
            generatedImage: true,
            generationFailed: true,
            generationStage: String(placeholder.metadata?.generationRemoteUrl || '').trim()
              ? 'persist_failed'
              : 'generation_failed',
            prompt,
            ...(peopleIntent ? { imagePeople: peopleIntent } : {}),
            ...(aspect ? { imageAspect: aspect } : {}),
            ...(event.caption ? { caption: event.caption, text: event.caption } : {}),
            ...(event.reason ? { reason: event.reason } : {}),
            ...(options.aiRoundId ? { aiRoundId: options.aiRoundId } : {}),
            ...imageGenerationFailureMetadata(err),
          };
          await saveMessage(placeholder);
          failedPlaceholderUpdated = true;
        }
      }
      if (!failedPlaceholderUpdated && event.use !== 'avatar') {
        const senderName = await resolveName(actorId);
        const ts = await getNowForUser(options.userId || '');
        const failMsg = createMessage({
          chatId: sourceChatId,
          senderId: actorId,
          senderName,
          type: 'image',
          content: '',
          timestamp: ts,
          metadata: {
            protocol: 'MARSHMALLOW_CHAT_V2',
            marshmallowEventType: 'gen_image',
            generatingImage: false,
            generatedImage: true,
            generationFailed: true,
            generationStage: generatedRemoteUrl ? 'persist_failed' : 'generation_failed',
            ...(generatedRemoteUrl ? { generationRemoteUrl: generatedRemoteUrl } : {}),
            prompt,
            ...(peopleIntent ? { imagePeople: peopleIntent } : {}),
            ...(aspect ? { imageAspect: aspect } : {}),
            ...(event.caption ? { caption: event.caption, text: event.caption } : {}),
            ...(event.reason ? { reason: event.reason } : {}),
            ...(options.aiRoundId ? { aiRoundId: options.aiRoundId } : {}),
            ...imageGenerationFailureMetadata(err),
          },
        });
        await saveMessage(failMsg);
      }
      console.warn('[marshmallow-gen-image]', err);
    } finally {
      endGeneratedImageJob(placeholderMessageId, jobToken);
    }
  }
  return { handled, skipped, chat: chatRow };
}

export async function rerollGeneratedImageMessage(messageId, options = {}) {
  const id = String(messageId || '').trim();
  if (!id) throw new Error('消息不存在');
  const msg = await getRecord('messages', id);
  const storedPrompt = String(msg?.metadata?.prompt || '').trim();
  // 用户手动编辑过的提示词优先，并持久化为这条消息之后的重 roll 基准
  const prompt = String(options.promptOverride || '').trim() || storedPrompt;
  if (!msg || msg.type !== 'image' || !prompt || msg.metadata?.generatedImage !== true) {
    throw new Error('这张图没有可重 roll 的生成提示词');
  }
  const aspect = normalizeImageAspect(msg.metadata?.imageAspect || '');
  const peopleIntent = normalizePeopleIntent(msg.metadata?.imagePeople);
  const imageIdentity = normalizeImageIdentity(msg.metadata?.imageIdentity);
  const sourceChat = await getRecord('chats', msg.chatId).catch(() => null);
  const participants = new Set(
    (sourceChat?.participants || []).map((actorId) => String(actorId || '').trim()).filter(Boolean),
  );
  const subjectIds = resolveEventImageSubjectIds({
    subjects: msg.metadata?.imageSubjectIds || [],
    people: msg.metadata?.imagePeople,
    identity: msg.metadata?.imageIdentity,
  }, msg.senderId, participants);
  const jobToken = beginGeneratedImageJob(id);
  if (!jobToken) {
    throw new Error('这张图仍在生成，请等待当前请求完成，避免重复计费');
  }
  msg.content = '';
  msg.metadata = {
    ...(msg.metadata || {}),
    prompt,
    generatingImage: true,
    generationFailed: false,
    ...(options.forceRegenerate === true ? { generationRemoteUrl: '', generationStage: 'generating' } : {}),
    ...clearedImageGenerationFailureMetadata(),
    generationStartedAt: Date.now(),
  };
  try {
    await saveMessage(msg);
    // 服务端已经返回过图、只是本地保存失败时，只重试下载保存，不再扣一次生图费用。
    const recoverableRemoteUrl = String(msg.metadata?.generationRemoteUrl || '').trim();
    if (recoverableRemoteUrl && options.forceRegenerate !== true) {
      const localUrl = await persistChatGeneratedImageLocally(recoverableRemoteUrl, { signal: options.signal });
      msg.content = localUrl;
      msg.metadata = {
        ...(msg.metadata || {}),
        generatingImage: false,
        generationFailed: false,
        generationStage: '',
        generationRemoteUrl: '',
        generationStartedAt: 0,
        generatedImageStoredLocally: true,
        ...clearedImageGenerationFailureMetadata(),
      };
      await saveMessage(msg);
      await updateChatPreview(msg.chatId, previewFromMessage(msg), msg.timestamp);
      return localUrl;
    }
    const locked = await buildLockedChatImageGeneration(subjectIds, prompt, {
      signal: options.signal,
      allowedIds: participants,
      user: options.user,
      characters: options.characters,
      respectConfiguredSize: true,
      ...(aspect ? { aspect } : {}),
      ...(peopleIntent ? { peopleIntent } : {}),
      ...(peopleIntent && peopleIntent !== 'none' ? { characterStyleAllowed: true } : {}),
      ...((peopleIntent === 'portrait' || imageIdentity === 'self') ? { preserveIdentity: true } : {}),
    });
    const generated = await generateImageForScene(locked.prompt, 'chatImages', locked.options);
    if (generated?.referenceSkipped) {
      showToast('参考图锁定未生效，已改用文字外观生成', 5000);
    }
    let url = String(generated?.url || '').trim();
    if (!url) throw new Error('没有生成图片地址');
    msg.metadata = {
      ...(msg.metadata || {}),
      generationStage: 'persisting',
      generationRemoteUrl: url,
    };
    await saveMessage(msg);
    url = await persistChatGeneratedImageLocally(url, { signal: options.signal });
    msg.content = url;
    msg.metadata = {
      ...(msg.metadata || {}),
      generatingImage: false,
      generationFailed: false,
      generationStage: '',
      generationRemoteUrl: '',
      generationStartedAt: 0,
      generatedImageStoredLocally: true,
      ...clearedImageGenerationFailureMetadata(),
      imageReferenceSkipped: generated?.referenceSkipped === true,
      imageReferenceSubjectIds: locked.options.referenceSubjects?.map((row) => row.id) || [],
      imageReferenceSubmittedCount: Number(generated?.referenceSubmittedCount || 0),
      rerolledAt: Date.now(),
      rerollCount: Number(msg.metadata?.rerollCount || 0) + 1,
    };
    await saveMessage(msg);
    await updateChatPreview(msg.chatId, previewFromMessage(msg), msg.timestamp);
    return url;
  } catch (err) {
    msg.metadata = {
      ...(msg.metadata || {}),
      generatingImage: false,
      generationFailed: true,
      generationStage: String(msg.metadata?.generationRemoteUrl || '').trim()
        ? 'persist_failed'
        : 'generation_failed',
      ...imageGenerationFailureMetadata(err),
    };
    await saveMessage(msg);
    await updateChatPreview(msg.chatId, previewFromMessage(msg), msg.timestamp);
    throw err;
  } finally {
    endGeneratedImageJob(id, jobToken);
  }
}
