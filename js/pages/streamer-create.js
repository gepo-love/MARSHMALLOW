import { back, navigate } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import { fileToCroppedOptimizedAvatarDataUrl, fileToCroppedCompressedDataUrl, IMAGE_CROP_PRESETS } from '../components/image-crop-modal.js';
import { ensureDefaultUser } from '../core/user-slot.js';
import { listCharacters } from '../core/character-store.js';
import { createStreamerChannel } from '../core/streamer-store.js';
import { generateStreamerPersonaAI, generateStreamerAliasForCharacterAI } from '../core/streamer-ai.js';
import { STREAMER_POPULARITY_TIERS, STREAMER_CATEGORY_PRESETS, STREAMER_IMAGE_SYNC_TIERS } from '../data/streamer-presets.js';
import {
  generateImageForScene,
  persistGeneratedImageUrlLocally,
} from '../core/image-generation-tools.js';
import { resolveSocialImageGenMode } from '../core/social-image-generation.js';
import { isCharacterVoiceTtsEnabled } from '../core/voice-tools.js';

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

export default async function render(container) {
  const user = await ensureDefaultUser();
  const chars = (await listCharacters({
    excludeAnonNpc: true,
    userId: user.id,
    identityScoped: true,
  })).filter((c) => c?.id && c.id !== 'user');

  const state = {
    sourceType: 'generated',
    characterId: '',
    avatar: '',
    cover: '',
    category: 'chat',
    customCategory: '',
    popularityTier: 'small',
    imageSyncTier: 'low',
    streamReason: '',
    worldSetting: '',
    generatedPersona: null,
  };

  container.className = 'page anon-page anon-streamer-create-page';
  container.innerHTML = `
    <header class="navbar">
      <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
      <h1 class="navbar-title">开一间直播</h1>
      <span class="navbar-btn scrapbook-nav-spacer" aria-hidden="true"></span>
    </header>
    <main class="anon-scroll">
      <section class="anon-create-poster">
        <strong>谁在镜头后面</strong>
        <span>选来源、定人气、想清楚为什么要播</span>
      </section>

      <section class="anon-card">
        <div class="anon-section-title">主播来源</div>
        <label class="anon-form-field" style="flex-direction:row;align-items:center;gap:8px;">
          <input type="radio" name="streamer-source" value="generated" checked />
          <span>AI 现场捏一个陌生主播人格</span>
        </label>
        <label class="anon-form-field" style="flex-direction:row;align-items:center;gap:8px;">
          <input type="radio" name="streamer-source" value="character" ${chars.length ? '' : 'disabled'} />
          <span>${chars.length ? '让通讯录角色演一个隔离马甲' : '让通讯录角色演一个隔离马甲（暂无可用角色）'}</span>
        </label>
        <div class="anon-streamer-char-pick" hidden>
          <select class="form-input streamer-char-select">
            <option value="">选择角色</option>
            ${chars.map((c) => `<option value="${escAttr(c.id)}">${esc(c.name || c.id)}</option>`).join('')}
          </select>
          <p class="text-hint">开播时会单独给这个角色生成一个直播马甲网名，前台不会直接用角色本名；只借用说话风格和性格底色，不读取记忆、聊天记录和关系进度。</p>
        </div>
        <div class="anon-streamer-gen-pick">
          <label class="anon-form-field">
            <span>性格/氛围倾向（可选）</span>
            <input type="text" class="form-input streamer-gen-vibe" placeholder="例如：嗓音软、爱冷笑话" />
          </label>
          <button type="button" class="btn btn-outline btn-block streamer-gen-persona">用 AI 捏一个人格</button>
          <div class="anon-streamer-persona-card" hidden>
            <label class="anon-form-field">
              <span>马甲网名</span>
              <input type="text" class="form-input streamer-gen-handle" maxlength="24" />
            </label>
            <label class="anon-form-field">
              <span>性格底色</span>
              <textarea class="form-input streamer-gen-personality" rows="2"></textarea>
            </label>
            <label class="anon-form-field">
              <span>说话风格</span>
              <textarea class="form-input streamer-gen-speechstyle" rows="2"></textarea>
            </label>
            <label class="anon-form-field">
              <span>签名</span>
              <input type="text" class="form-input streamer-gen-signature" maxlength="60" />
            </label>
            <p class="text-hint">生成结果已回填到上面和下方「背景小传」里，都可以直接改。</p>
          </div>
        </div>
      </section>

      <section class="anon-card">
        <div class="anon-section-title">头像</div>
        <div class="anon-streamer-avatar-row">
          <div class="anon-streamer-avatar-preview" data-empty="1"><img alt="头像预览" hidden /></div>
          <div class="anon-streamer-avatar-actions">
            <button type="button" class="btn btn-outline streamer-avatar-upload">上传头像</button>
            <p class="text-hint">不上传就用封面图当头像；头像和封面可以是两张不同的图。</p>
          </div>
        </div>
        <input type="file" class="streamer-avatar-file" accept="image/*" hidden />
      </section>

      <section class="anon-card">
        <div class="anon-section-title">封面</div>
        <div class="anon-streamer-cover-preview" hidden><img alt="封面预览" /></div>
        <div class="anon-streamer-cover-actions">
          <button type="button" class="btn btn-outline streamer-cover-upload">上传封面</button>
          <button type="button" class="btn btn-outline streamer-cover-gen">AI 生成封面</button>
        </div>
        <input type="file" class="streamer-cover-file" accept="image/*" hidden />
      </section>

      <section class="anon-card">
        <div class="anon-section-title">人气档位</div>
        <div class="anon-chip-bar streamer-tier-bar">
          ${STREAMER_POPULARITY_TIERS.map((t, i) => `<button type="button" class="anon-chip streamer-tier-chip ${i === 0 ? 'is-active' : ''}" data-tier="${escAttr(t.id)}">${esc(t.label)}</button>`).join('')}
        </div>
        <p class="text-hint streamer-tier-hint">${esc(STREAMER_POPULARITY_TIERS[0].hint)}</p>
      </section>

      <section class="anon-card">
        <div class="anon-section-title">直播类型</div>
        <div class="anon-chip-bar streamer-category-bar">
          ${STREAMER_CATEGORY_PRESETS.map((c, i) => `<button type="button" class="anon-chip streamer-category-chip ${i === 0 ? 'is-active' : ''}" data-category="${escAttr(c.id)}">${esc(c.label)}</button>`).join('')}
        </div>
        <input type="text" class="form-input streamer-category-custom" placeholder="自定义直播类型" hidden />
      </section>

      <section class="anon-card">
        <div class="anon-section-title">换画面频率</div>
        <div class="anon-chip-bar streamer-image-tier-bar">
          ${STREAMER_IMAGE_SYNC_TIERS.map((t, i) => `<button type="button" class="anon-chip streamer-image-tier-chip ${i === 1 ? 'is-active' : ''}" data-image-tier="${escAttr(t.id)}">${esc(t.label)}</button>`).join('')}
        </div>
        <p class="text-hint streamer-image-tier-hint">${esc(STREAMER_IMAGE_SYNC_TIERS[1].hint)}</p>
      </section>

      <section class="anon-card">
        <div class="anon-section-title">语音</div>
        <label class="anon-form-field" style="flex-direction:row;align-items:center;gap:8px;">
          <input type="checkbox" class="streamer-voice-toggle" />
          <span>直播间接入语音朗读，主播说话时自动播报</span>
        </label>
        <p class="text-hint streamer-voice-hint">未选角色来源时，AI 捏的人格默认没有声音。</p>
        <div class="streamer-voice-id-field" hidden>
          <label class="anon-form-field">
            <span>MiniMax 声线 ID</span>
            <input type="text" class="form-input streamer-voice-id" placeholder="voice_id / 克隆音色 ID" />
          </label>
        </div>
      </section>

      <section class="anon-card">
        <div class="anon-section-title">背景小传（可选）</div>
        <label class="anon-form-field">
          <span>为什么直播</span>
          <input type="text" class="form-input streamer-reason" placeholder="例如：攒钱买设备、单纯想找人说话" />
        </label>
        <label class="anon-form-field">
          <span>世界观 / 设定</span>
          <textarea class="form-input streamer-world" rows="2" placeholder="留空则是普通现代主播"></textarea>
        </label>
      </section>

      <button type="button" class="btn btn-primary" style="width:calc(100% - 28px);margin:0 14px 16px;" data-create>开播</button>
    </main>
  `;

  container.querySelector('[data-back]')?.addEventListener('click', () => back());

  const charPickBlock = container.querySelector('.anon-streamer-char-pick');
  const genPickBlock = container.querySelector('.anon-streamer-gen-pick');
  const voiceToggle = container.querySelector('.streamer-voice-toggle');
  const voiceHint = container.querySelector('.streamer-voice-hint');
  const voiceIdField = container.querySelector('.streamer-voice-id-field');

  function selectedCharacter() {
    return chars.find((c) => c.id === state.characterId) || null;
  }

  function refreshVoiceUi() {
    if (!voiceToggle) return;
    if (state.sourceType === 'character') {
      const char = selectedCharacter();
      const hasVoice = isCharacterVoiceTtsEnabled(char?.voiceProfile || {});
      voiceToggle.checked = hasVoice;
      if (voiceHint) voiceHint.textContent = hasVoice
        ? '该角色已启用语音，直播时会自动用这个声线朗读。'
        : '该角色未启用语音；可在通讯录角色编辑里勾选「启用语音合成」并填写声线 ID。';
      if (voiceIdField) voiceIdField.hidden = true;
    } else {
      voiceToggle.checked = false;
      if (voiceHint) voiceHint.textContent = 'AI 捏的人格默认没有声音，勾选后填一个 MiniMax 声线 ID 才会出声。';
      if (voiceIdField) voiceIdField.hidden = !voiceToggle.checked;
    }
  }

  container.querySelectorAll('input[name="streamer-source"]').forEach((input) => {
    input.addEventListener('change', () => {
      state.sourceType = input.value;
      if (charPickBlock) charPickBlock.hidden = state.sourceType !== 'character';
      if (genPickBlock) genPickBlock.hidden = state.sourceType !== 'generated';
      refreshVoiceUi();
    });
  });
  container.querySelector('.streamer-char-select')?.addEventListener('change', (e) => {
    state.characterId = e.target.value;
    refreshVoiceUi();
  });
  voiceToggle?.addEventListener('change', () => {
    if (state.sourceType === 'generated' && voiceIdField) voiceIdField.hidden = !voiceToggle.checked;
  });
  refreshVoiceUi();

  const personaCard = container.querySelector('.anon-streamer-persona-card');
  const genHandleInput = container.querySelector('.streamer-gen-handle');
  const genPersonalityInput = container.querySelector('.streamer-gen-personality');
  const genSpeechStyleInput = container.querySelector('.streamer-gen-speechstyle');
  const genSignatureInput = container.querySelector('.streamer-gen-signature');

  function fillPersonaCard(persona) {
    state.generatedPersona = persona;
    if (personaCard) personaCard.hidden = false;
    if (genHandleInput) genHandleInput.value = persona.handle || '';
    if (genPersonalityInput) genPersonalityInput.value = persona.personality || '';
    if (genSpeechStyleInput) genSpeechStyleInput.value = persona.speechStyle || '';
    if (genSignatureInput) genSignatureInput.value = persona.signature || '';
    const reasonInput = container.querySelector('.streamer-reason');
    const worldInput = container.querySelector('.streamer-world');
    if (reasonInput && persona.streamReason) reasonInput.value = persona.streamReason;
    if (worldInput && persona.worldSetting) worldInput.value = persona.worldSetting;
  }

  container.querySelector('.streamer-gen-persona')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '捏人格中…';
    try {
      const categoryPreset = STREAMER_CATEGORY_PRESETS.find((c) => container.querySelector(`.streamer-category-chip[data-category="${c.id}"]`)?.classList.contains('is-active'));
      const persona = await generateStreamerPersonaAI({
        vibe: container.querySelector('.streamer-gen-vibe')?.value || '',
        worldview: container.querySelector('.streamer-world')?.value || '',
        category: categoryPreset?.label || '',
      });
      fillPersonaCard(persona);
      showToast('已生成人格，字段都可以直接改，改完再开播');
    } catch (err) {
      showToast(err?.message || '生成失败');
    } finally {
      btn.disabled = false;
      btn.textContent = state.generatedPersona ? '换一个人格' : '用 AI 捏一个人格';
    }
  });

  const avatarPreview = container.querySelector('.anon-streamer-avatar-preview');
  const avatarImg = avatarPreview?.querySelector('img');
  function setAvatar(src) {
    state.avatar = src || '';
    if (!avatarPreview || !avatarImg) return;
    if (src) {
      avatarImg.src = src;
      avatarImg.hidden = false;
      avatarPreview.dataset.empty = '0';
    } else {
      avatarImg.hidden = true;
      avatarPreview.dataset.empty = '1';
    }
  }
  container.querySelector('.streamer-avatar-upload')?.addEventListener('click', () => {
    container.querySelector('.streamer-avatar-file')?.click();
  });
  container.querySelector('.streamer-avatar-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !/^image\//.test(file.type || '')) return;
    try {
      const result = await fileToCroppedOptimizedAvatarDataUrl(file);
      if (!result) return;
      setAvatar(result.dataUrl);
    } catch (err) {
      showToast(err?.message || '头像读取失败');
    }
  });

  const coverPreview = container.querySelector('.anon-streamer-cover-preview');
  const coverImg = coverPreview?.querySelector('img');
  function setCover(src) {
    state.cover = src || '';
    if (!coverPreview || !coverImg) return;
    if (src) {
      coverImg.src = src;
      coverPreview.hidden = false;
    } else {
      coverPreview.hidden = true;
    }
  }
  container.querySelector('.streamer-cover-upload')?.addEventListener('click', () => {
    container.querySelector('.streamer-cover-file')?.click();
  });
  container.querySelector('.streamer-cover-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !/^image\//.test(file.type || '')) return;
    try {
      const cover = await fileToCroppedCompressedDataUrl(file, IMAGE_CROP_PRESETS.cover);
      if (!cover) return;
      setCover(cover);
    } catch (err) {
      showToast(err?.message || '封面读取失败');
    }
  });
  container.querySelector('.streamer-cover-gen')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const mode = await resolveSocialImageGenMode('chatImages').catch(() => '');
    if (!mode) {
      showToast('请先在「API 管理 › 生图」里启用生图');
      return;
    }
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const categoryLabel = container.querySelector('.streamer-category-chip.is-active')?.textContent || '直播';
      const personaHint = genHandleInput?.value
        ? `${genHandleInput.value}, ${genPersonalityInput?.value || ''}`
        : (container.querySelector('.streamer-char-select')?.selectedOptions?.[0]?.textContent || '主播');
      const prompt = `vertical portrait of a good-looking person live streaming (${categoryLabel}), ${personaHint}, half body, upper body framing, face turned away or looking down or covered by hair/hand/mic so the face is not clearly visible, chin or side profile can show, natural cozy indoor lighting, clear well-exposed framing`;
      // 封面主体是人物半身像，只是刻意藏脸；吃人物画风+竖屏画幅，不强制「真人」身份
      const result = await generateImageForScene(prompt, 'chatImages', { forcePortrait: true, aspect: 'portrait' });
      const url = await persistGeneratedImageUrlLocally(result?.url || '');
      if (url) setCover(url);
      else showToast('生成失败');
    } catch (err) {
      showToast(err?.message || '生成失败');
    } finally {
      btn.disabled = false;
      btn.textContent = 'AI 生成封面';
    }
  });

  container.querySelectorAll('.streamer-tier-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      container.querySelectorAll('.streamer-tier-chip').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      state.popularityTier = chip.getAttribute('data-tier') || 'small';
      const tier = STREAMER_POPULARITY_TIERS.find((t) => t.id === state.popularityTier);
      const hint = container.querySelector('.streamer-tier-hint');
      if (hint && tier) hint.textContent = tier.hint;
    });
  });

  container.querySelectorAll('.streamer-image-tier-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      container.querySelectorAll('.streamer-image-tier-chip').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      state.imageSyncTier = chip.getAttribute('data-image-tier') || 'low';
      const tier = STREAMER_IMAGE_SYNC_TIERS.find((t) => t.id === state.imageSyncTier);
      const hint = container.querySelector('.streamer-image-tier-hint');
      if (hint && tier) hint.textContent = tier.hint;
    });
  });

  const customCategoryInput = container.querySelector('.streamer-category-custom');
  container.querySelectorAll('.streamer-category-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      container.querySelectorAll('.streamer-category-chip').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      state.category = chip.getAttribute('data-category') || 'chat';
      if (customCategoryInput) customCategoryInput.hidden = state.category !== 'custom';
    });
  });

  container.querySelector('[data-create]')?.addEventListener('click', async () => {
    const btn = container.querySelector('[data-create]');
    if (state.sourceType === 'character' && !state.characterId) {
      showToast('请先选择一个角色');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
    try {
      const categoryPreset = STREAMER_CATEGORY_PRESETS.find((c) => c.id === state.category);
      const categoryLabel = state.category === 'custom'
        ? (container.querySelector('.streamer-category-custom')?.value || '自定义')
        : (categoryPreset?.label || '聊天唠嗑');
      const streamReason = container.querySelector('.streamer-reason')?.value || '';
      let persona = {
        avatar: state.avatar,
        avatarCover: state.cover,
        popularityTier: state.popularityTier,
        imageSyncTier: state.imageSyncTier,
        category: state.category,
        categoryLabel,
        streamReason,
        worldSetting: container.querySelector('.streamer-world')?.value || '',
        imageLockEnabled: state.sourceType === 'generated',
      };
      if (state.sourceType === 'character') {
        const char = chars.find((c) => c.id === state.characterId);
        if (!char) throw new Error('角色不存在');
        if (btn) btn.textContent = '生成马甲中…';
        const alias = await generateStreamerAliasForCharacterAI(char, { category: categoryLabel, streamReason });
        if (alias.warning) showToast(alias.warning);
        const hasVoice = isCharacterVoiceTtsEnabled(char.voiceProfile || {});
        persona = {
          ...persona,
          handle: alias.handle,
          personality: char.personality || '',
          speechStyle: char.speechStyle || '',
          signature: alias.signature || '',
          aliasFromCharacter: true,
          voiceEnabled: !!voiceToggle?.checked && hasVoice,
        };
      } else {
        if (!state.generatedPersona) {
          const generated = await generateStreamerPersonaAI({
            vibe: container.querySelector('.streamer-gen-vibe')?.value || '',
            worldview: container.querySelector('.streamer-world')?.value || '',
            category: categoryLabel,
          });
          fillPersonaCard(generated);
        }
        const voiceId = container.querySelector('.streamer-voice-id')?.value || '';
        persona = {
          ...persona,
          // 重新从输入框读取：可能是用户在预览卡里手改过的，字段以当前 DOM 为准
          streamReason: container.querySelector('.streamer-reason')?.value || persona.streamReason,
          worldSetting: container.querySelector('.streamer-world')?.value || persona.worldSetting,
          handle: genHandleInput?.value || state.generatedPersona?.handle || '匿名主播',
          personality: genPersonalityInput?.value || state.generatedPersona?.personality || '',
          speechStyle: genSpeechStyleInput?.value || state.generatedPersona?.speechStyle || '',
          signature: genSignatureInput?.value || state.generatedPersona?.signature || '',
          voiceEnabled: !!voiceToggle?.checked && !!voiceId.trim(),
          voiceId,
        };
        if (voiceToggle?.checked && !voiceId.trim()) showToast('没填声线 ID，本场直播先不接语音');
      }
      const channel = await createStreamerChannel(user.id, {
        sourceType: state.sourceType,
        characterId: state.sourceType === 'character' ? state.characterId : '',
        persona,
        ephemeral: false,
      });
      showToast('已开播');
      navigate('anon/streamer/room', { channelId: channel.id });
    } catch (err) {
      showToast(err?.message || '创建失败');
      if (btn) { btn.disabled = false; btn.textContent = '开播'; }
    }
  });
}
