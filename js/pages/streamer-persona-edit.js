import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { getStreamerChannel, saveStreamerChannel } from '../core/streamer-store.js';
import { generateStreamerPersonaAI } from '../core/streamer-ai.js';
import { STREAMER_CATEGORY_PRESETS } from '../data/streamer-presets.js';
import {
  generateImageForScene,
  persistGeneratedImageUrlLocally,
} from '../core/image-generation-tools.js';
import { resolveSocialImageGenMode } from '../core/social-image-generation.js';

function esc(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value = '') {
  return esc(value).replace(/'/g, '&#39;');
}

export default async function render(container, params = {}) {
  const channelId = String(params.channelId || '').trim();
  const channel = channelId ? await getStreamerChannel(channelId) : null;

  container.className = 'page anon-page anon-streamer-persona-edit-page';

  if (!channel) {
    container.innerHTML = `
      <header class="navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title">编辑设定</h1>
        <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
      </header>
      <div class="anon-empty">这个主播空间已经不在了</div>
    `;
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    return;
  }

  const persona = channel.persona || {};
  const isFromCharacter = channel.sourceType === 'character';
  const categoryChips = STREAMER_CATEGORY_PRESETS.map((c) => `
    <button type="button" class="anon-chip streamer-edit-category-chip ${c.id === persona.category ? 'is-active' : ''}" data-category="${escAttr(c.id)}">${esc(c.label)}</button>`).join('');

  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">编辑设定</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="anon-scroll">
      ${isFromCharacter ? '<p class="text-hint" style="margin:12px 14px 0;">这里改的是本场直播马甲的独立副本，不会同步回通讯录里的角色卡。</p>' : ''}
      <section class="anon-card">
        <div class="anon-section-title">马甲网名</div>
        <input type="text" class="form-input streamer-edit-handle" maxlength="24" value="${escAttr(persona.handle || '')}" />
      </section>

      <section class="anon-card">
        <div class="anon-section-title">直播类型</div>
        <div class="anon-chip-bar">${categoryChips}</div>
        <input type="text" class="form-input streamer-edit-category-custom" placeholder="自定义直播类型" value="${escAttr(persona.category === 'custom' ? persona.categoryLabel : '')}" ${persona.category === 'custom' ? '' : 'hidden'} />
      </section>

      <section class="anon-card">
        <div class="anon-section-title">背景小传</div>
        <label class="anon-form-field">
          <span>为什么直播</span>
          <input type="text" class="form-input streamer-edit-reason" placeholder="例如：攒钱买设备、单纯想找人说话" value="${escAttr(persona.streamReason || '')}" />
        </label>
        <label class="anon-form-field">
          <span>世界观 / 设定</span>
          <textarea class="form-input streamer-edit-world" rows="2" placeholder="留空则是普通现代主播">${esc(persona.worldSetting || '')}</textarea>
        </label>
      </section>

      <section class="anon-card">
        <div class="anon-section-title">性格与口吻</div>
        <label class="anon-form-field">
          <span>性格底色</span>
          <textarea class="form-input streamer-edit-personality" rows="2">${esc(persona.personality || '')}</textarea>
        </label>
        <label class="anon-form-field">
          <span>说话风格</span>
          <textarea class="form-input streamer-edit-speechstyle" rows="2">${esc(persona.speechStyle || '')}</textarea>
        </label>
        <label class="anon-form-field">
          <span>签名</span>
          <input type="text" class="form-input streamer-edit-signature" maxlength="60" value="${escAttr(persona.signature || '')}" />
        </label>
      </section>

      ${isFromCharacter ? '' : `
        <section class="anon-card">
          <div class="anon-section-title">头像与锁脸</div>
          <div class="anon-streamer-avatar-row">
            <div class="anon-streamer-avatar-preview streamer-edit-avatar-preview" data-empty="${persona.avatar ? '0' : '1'}">
              <img src="${escAttr(persona.avatar || '')}" alt="头像预览" ${persona.avatar ? '' : 'hidden'} />
            </div>
            <button type="button" class="btn btn-outline streamer-edit-gen-avatar">AI 生成头像</button>
          </div>
          <label class="anon-form-field">
            <span><input type="checkbox" class="streamer-edit-lock-face" ${persona.imageLockEnabled !== false ? 'checked' : ''} /> 后续直播画面锁定同一张脸</span>
          </label>
        </section>

        <section class="anon-card">
          <div class="anon-section-title">声线</div>
          <label class="anon-form-field">
            <span><input type="checkbox" class="streamer-edit-voice-enabled" ${persona.voiceEnabled ? 'checked' : ''} /> 启用主播语音</span>
          </label>
          <label class="anon-form-field">
            <span>MiniMax 声线 ID</span>
            <input type="text" class="form-input streamer-edit-voice-id" value="${escAttr(persona.voiceId || '')}" placeholder="voice_id / 克隆音色 ID" />
          </label>
        </section>
      `}

      <section class="anon-card">
        <div class="anon-section-title">AI 重新生成</div>
        <label class="anon-form-field">
          <span>性格/氛围倾向（可选）</span>
          <input type="text" class="form-input streamer-edit-vibe" placeholder="例如：嗓音软、爱冷笑话" />
        </label>
        <button type="button" class="btn btn-outline btn-block streamer-edit-regen">用 AI 重新捏一遍</button>
        <p class="text-hint">会整体替换上面的网名/性格/说话风格/签名/背景小传。</p>
      </section>

      <button type="button" class="btn btn-primary" style="width:calc(100% - 28px);margin:0 14px 16px;" data-save>保存</button>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());

  const handleInput = container.querySelector('.streamer-edit-handle');
  const reasonInput = container.querySelector('.streamer-edit-reason');
  const worldInput = container.querySelector('.streamer-edit-world');
  const personalityInput = container.querySelector('.streamer-edit-personality');
  const speechStyleInput = container.querySelector('.streamer-edit-speechstyle');
  const signatureInput = container.querySelector('.streamer-edit-signature');
  const customCategoryInput = container.querySelector('.streamer-edit-category-custom');
  const voiceEnabledInput = container.querySelector('.streamer-edit-voice-enabled');
  const voiceIdInput = container.querySelector('.streamer-edit-voice-id');
  const lockFaceInput = container.querySelector('.streamer-edit-lock-face');
  const avatarPreview = container.querySelector('.streamer-edit-avatar-preview');
  const avatarImage = avatarPreview?.querySelector('img');
  let draftAvatar = persona.avatar || '';
  let draftImageLockSeed = Number(persona.imageLockSeed) || 0;

  let selectedCategory = persona.category || 'chat';
  container.querySelectorAll('.streamer-edit-category-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      container.querySelectorAll('.streamer-edit-category-chip').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      selectedCategory = chip.getAttribute('data-category') || 'chat';
      if (customCategoryInput) customCategoryInput.hidden = selectedCategory !== 'custom';
    });
  });

  container.querySelector('.streamer-edit-regen')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '捏人格中…';
    try {
      const categoryPreset = STREAMER_CATEGORY_PRESETS.find((c) => c.id === selectedCategory);
      const generated = await generateStreamerPersonaAI({
        vibe: container.querySelector('.streamer-edit-vibe')?.value || '',
        worldview: worldInput?.value || '',
        category: categoryPreset?.label || '',
      });
      if (handleInput) handleInput.value = generated.handle;
      if (personalityInput) personalityInput.value = generated.personality;
      if (speechStyleInput) speechStyleInput.value = generated.speechStyle;
      if (signatureInput) signatureInput.value = generated.signature;
      if (reasonInput && generated.streamReason) reasonInput.value = generated.streamReason;
      if (worldInput && generated.worldSetting) worldInput.value = generated.worldSetting;
      showToast('已重新生成，记得保存');
    } catch (err) {
      showToast(err?.message || '生成失败');
    } finally {
      btn.disabled = false;
      btn.textContent = '用 AI 重新捏一遍';
    }
  });

  container.querySelector('.streamer-edit-gen-avatar')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const mode = await resolveSocialImageGenMode('chatImages').catch(() => '');
    if (!mode) {
      showToast('请先在「API 管理 › 生图」里启用生图');
      return;
    }
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      draftImageLockSeed = 1 + Math.floor(Math.random() * 4294967294);
      const prompt = [
        'portrait avatar of one distinctive attractive anonymous streamer',
        handleInput?.value || persona.handle || 'anonymous streamer',
        personalityInput?.value || persona.personality || '',
        worldInput?.value || persona.worldSetting || '',
        'head and shoulders, three-quarter view, facial identity clearly consistent and suitable as a face reference',
        'single person, clean background, polished profile picture',
      ].filter(Boolean).join(', ');
      const result = await generateImageForScene(prompt, 'chatImages', {
        forcePortrait: true,
        aspect: 'portrait',
        seed: draftImageLockSeed,
      });
      const url = await persistGeneratedImageUrlLocally(result?.url || '');
      if (!url) throw new Error('生成失败');
      draftAvatar = url;
      if (avatarImage) {
        avatarImage.src = url;
        avatarImage.hidden = false;
      }
      if (avatarPreview) avatarPreview.dataset.empty = '0';
      if (lockFaceInput) lockFaceInput.checked = true;
      showToast('头像已生成，保存后用于锁脸');
    } catch (err) {
      showToast(err?.message || '生成失败');
    } finally {
      btn.disabled = false;
      btn.textContent = 'AI 生成头像';
    }
  });

  container.querySelector('[data-save]')?.addEventListener('click', async () => {
    const btn = container.querySelector('[data-save]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
      const categoryPreset = STREAMER_CATEGORY_PRESETS.find((c) => c.id === selectedCategory);
      const categoryLabel = selectedCategory === 'custom'
        ? (customCategoryInput?.value || '自定义')
        : (categoryPreset?.label || persona.categoryLabel || '聊天唠嗑');
      channel.persona = {
        ...channel.persona,
        handle: handleInput?.value || persona.handle,
        category: selectedCategory,
        categoryLabel,
        streamReason: reasonInput?.value || '',
        worldSetting: worldInput?.value || '',
        personality: personalityInput?.value || '',
        speechStyle: speechStyleInput?.value || '',
        signature: signatureInput?.value || '',
        ...(!isFromCharacter ? {
          avatar: draftAvatar,
          voiceId: voiceIdInput?.value || '',
          voiceEnabled: voiceEnabledInput?.checked === true && !!voiceIdInput?.value?.trim(),
          imageLockEnabled: lockFaceInput?.checked !== false,
          imageLockSeed: draftImageLockSeed,
        } : {}),
      };
      await saveStreamerChannel(channel);
      showToast('设定已保存');
      navigate('anon/streamer/space', { channelId: channel.id }, true);
    } catch (err) {
      showToast(err?.message || '保存失败');
      if (btn) { btn.disabled = false; btn.textContent = '保存'; }
    }
  });
}
