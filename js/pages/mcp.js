import { back } from '../core/router.js';
import { icon } from '../components/svg-icons.js';
import { showToast } from '../components/toast.js';
import {
  deleteMcpConnection,
  discoverMcpConnection,
  applyMcpConnectionReadGrants,
  getMcpConnectionCredential,
  listMcpConnections,
  mcpConnectionProviderId,
  normalizeMcpConnection,
  saveMcpConnection,
  testMcpConnectionTool,
  updateMcpConnectionEndpointDraft,
} from '../core/capabilities/mcp-connections.js';
import { listCapabilityGrants } from '../core/capabilities/grants.js';
import { refreshMcpCapabilityProviders } from '../core/capabilities/runtime.js';
import { listCharacters } from '../core/character-store.js';
import { MCP_SERVICE_TEMPLATES, getMcpServiceTemplate } from '../data/mcp-service-templates.js';
import {
  describeToyCandidate,
  importToyCompatibilityReport,
} from '../core/toy-adapter-registry.js';
import {
  connectKisstoyDevice,
  disconnectKisstoyDevice,
  getKisstoyDeviceState,
  scanKisstoyDevices,
  setKisstoyAutonomousControl,
  setKisstoyCharacterAuthorization,
  setKisstoyMaxIntensity,
  setKisstoyNativeProfile,
  setToyConnectionMode,
  setToyIntifaceEndpoint,
  stopKisstoyDevice,
  subscribeKisstoyDevice,
  testKisstoyNativeOutput,
} from '../core/capabilities/builtin-kisstoy-device.js';
import {
  MEITUAN_PAOTUI_SKILL_URL,
  MEITUAN_TRAVEL_TOKEN_URL,
  callMeituanErrandBridge,
  getMeituanServiceState,
  saveMeituanServiceState,
} from '../core/meituan-services.js';
import { subscribeIntifaceToy } from '../core/intiface-toy.js';

function esc(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function endpointLabel(value = '') {
  try { return new URL(value).host; } catch (_) { return String(value || ''); }
}

function toolRiskLabel(tool = {}) {
  if (tool.schemaError) return '不可用';
  if (tool.annotations?.destructiveHint === true) return '写入';
  if (tool.annotations?.readOnlyHint === true) return '只读';
  return '需确认';
}

function friendlyMcpError(error, fallback = '操作失败') {
  const message = String(error?.message || error || fallback);
  if (/TOY_BLE_SCAN_TIMEOUT/i.test(message)) return '扫描超时，请确认蓝牙已打开后重试';
  if (/permission[- ]denied|permission[- ]required/i.test(message)) return '请在系统设置中允许附近设备权限';
  if (/bluetooth[- ]off|adapter[- ]disabled/i.test(message)) return '请先打开手机蓝牙';
  if (/scan-failed|Bluetooth scan failed/i.test(message)) return '系统蓝牙扫描失败，请关闭占用玩具的 App 后重试';
  if (/valid URL/i.test(message)) return 'Server URL 格式不正确';
  if (/must not be embedded/i.test(message)) return '请不要把账号或密码写在 URL 里';
  if (/must use HTTPS/i.test(message)) return '远程 MCP 必须使用 HTTPS';
  if (/HTTP (401|403)/i.test(message)) return 'Token 无效或没有访问权限';
  if (/timed out|timeout/i.test(message)) return '连接超时，请检查地址或网络';
  if (/schema is too deeply nested/i.test(message)) return '服务器返回的工具参数结构过深';
  if (/ORIGIN_ERROR_STATUS_RESPONSE|OutboundException|HTTP 5\d\d/i.test(message)) {
    return 'MCP 服务网关暂时异常，请稍后重试；持续失败请重新获取 Token';
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return '浏览器未说明失败原因：请检查地址、证书、网络或服务器 CORS';
  }
  return message.slice(0, 240);
}

function toyGattUuids(result = {}) {
  return (Array.isArray(result.services) ? result.services : []).flatMap((service) => [
    String(service?.uuid || '').toLowerCase(),
    ...(Array.isArray(service?.characteristics) ? service.characteristics : [])
      .map((characteristic) => String(characteristic?.uuid || '').toLowerCase()),
  ]);
}

function friendlyToyConnectionFailure(result = {}) {
  const status = String(result?.status || 'unknown');
  const uuids = toyGattUuids(result);
  const alternateProtocol = status === 'alternate-control-protocol'
    || uuids.includes('0000ae3a-0000-1000-8000-00805f9b34fb')
    || uuids.includes('0000ae3b-0000-1000-8000-00805f9b34fb');
  if (alternateProtocol) {
    return '连接失败：检测到另一版控制协议，本机直连暂不能安全使用，请改用 Intiface';
  }
  if (status === 'service-discovery-failed') {
    return '连接失败：没有读到玩具的蓝牙服务，请关闭官方 App、重启玩具后重试';
  }
  if (status === 'control-characteristic-missing') {
    return uuids.length
      ? '连接失败：该型号或固件暂不支持本机直连，请改用 Intiface'
      : '连接失败：未找到玩具控制通道，请关闭官方 App、重启玩具后重试';
  }
  if (status === 'connect-timeout') return '连接超时，请重启玩具后重试';
  if (status === 'disconnected-before-ready') return '玩具在连接完成前已断开，请靠近后重试';
  return `连接失败：${friendlyMcpError(status, '未知错误')}`;
}

function connectionRow(item = {}) {
  const tools = Array.isArray(item.tools) ? item.tools : [];
  const count = tools.filter((tool) => tool.enabled !== false).length;
  const countLabel = count === tools.length ? `${count} 个工具` : `${count}/${tools.length} 已启用`;
  return `
    <article class="mcp-connection${item.enabled ? '' : ' is-off'}" data-mcp-row="${esc(item.id)}">
      <button type="button" class="mcp-connection-main" data-edit-mcp="${esc(item.id)}">
        <span class="mcp-rail" aria-hidden="true"><i></i></span>
        <span class="mcp-connection-copy">
          <strong>${esc(item.name)}</strong>
          <small>${esc(endpointLabel(item.endpoint))}</small>
        </span>
        <span class="mcp-tool-count">${countLabel}</span>
      </button>
      <label class="mcp-switch" aria-label="${item.enabled ? '停用' : '启用'}${esc(item.name)}">
        <input type="checkbox" data-toggle-mcp="${esc(item.id)}" ${item.enabled ? 'checked' : ''} />
        <span></span>
      </label>
    </article>`;
}

function serviceTemplateRow(template = {}) {
  return `
    <article class="mcp-connection">
      <button type="button" class="mcp-connection-main" data-add-mcp-template="${esc(template.id)}">
        <span class="mcp-rail" aria-hidden="true"><i></i></span>
        <span class="mcp-connection-copy">
          <strong>${esc(template.name)}</strong>
          <small>官方 MCP</small>
        </span>
        <span class="mcp-tool-count">连接</span>
      </button>
    </article>`;
}

function deviceStatus(state = {}, message = '') {
  return message || (state.connected
    ? `${state.deviceName || '设备'} · ${state.backend === 'intiface' ? 'Intiface' : '本机直连'}`
    : (state.backend === 'intiface'
      ? '打开 Intiface 后扫描'
      : (state.available ? '尚未连接' : '仅 Android App 可用')));
}

function builtinDeviceEntry(state = {}, message = '') {
  return `
    <article class="mcp-connection mcp-device-entry">
      <button type="button" class="mcp-connection-main" data-open-device>
        <span class="mcp-rail" aria-hidden="true"><i></i></span>
        <span class="mcp-connection-copy">
          <strong>小玩具</strong>
          <small>${esc(deviceStatus(state, message))}</small>
        </span>
        <span class="mcp-tool-count">${state.connected ? '已连接' : '进入'}</span>
      </button>
    </article>`;
}

function builtinMeituanEntry(state = {}) {
  const ready = [state.travelReady, state.errandReady].filter(Boolean).length;
  const status = ready === 2 ? '酒店旅行、跑腿已连接'
    : ready === 1 ? (state.travelReady ? '酒店旅行已连接' : '跑腿已连接')
      : '尚未连接';
  return `
    <article class="mcp-connection mcp-meituan-entry">
      <button type="button" class="mcp-connection-main" data-open-meituan>
        <span class="mcp-rail" aria-hidden="true"><i></i></span>
        <span class="mcp-connection-copy"><strong>美团</strong><small>${status}</small></span>
        <span class="mcp-tool-count">${ready ? `${ready}/2` : '连接'}</span>
      </button>
    </article>`;
}

function meituanEditorHtml(state = {}) {
  const travelSaved = Boolean(state.credentials?.travelToken);
  const errandSaved = Boolean(state.credentials?.errandToken);
  return `
    <section class="mcp-editor" aria-labelledby="mcp-meituan-title">
      <header class="mcp-editor-head">
        <button type="button" class="navbar-btn" data-close-meituan aria-label="返回">${icon('back')}</button>
        <h2 id="mcp-meituan-title">美团</h2>
        <button type="button" class="mcp-save" data-save-meituan>保存</button>
      </header>
      <div class="mcp-editor-scroll" data-ime-scroll-region>
        <section class="mcp-tools" aria-label="酒店旅行">
          <h3>酒店旅行</h3>
          <label class="api-field"><span class="api-field-label">默认城市</span><input class="form-input" name="travelCity" maxlength="60" value="${esc(state.config?.travel?.city || '')}" placeholder="上海"></label>
          <label class="api-field"><span class="api-field-label">Token</span><input class="form-input" name="travelToken" type="password" autocomplete="off" placeholder="${travelSaved ? '已保存在本机；留空保持不变' : '填写访问 Token'}"></label>
          <button type="button" class="mcp-clear-token" data-open-meituan-travel-token>获取 Token</button>
          <label class="mcp-enable-row"><span>启用酒店旅行</span><input name="travelEnabled" type="checkbox" ${state.config?.travel?.enabled ? 'checked' : ''}></label>
          <label class="mcp-enable-row"><span>允许角色自主查询</span><input name="travelAutonomous" type="checkbox" ${state.config?.travel?.allowAutonomousUse ? 'checked' : ''}></label>
        </section>
        <section class="mcp-tools" aria-label="跑腿">
          <h3>跑腿</h3>
          <label class="api-field"><span class="api-field-label">桥地址</span><input class="form-input" name="errandUrl" type="url" inputmode="url" value="${esc(state.config?.errand?.bridgeUrl || '')}" placeholder="https://relay.example.com"></label>
          <label class="api-field"><span class="api-field-label">访问令牌</span><input class="form-input" name="errandToken" type="password" autocomplete="off" placeholder="${errandSaved ? '已保存在本机；留空保持不变' : '填写桥访问令牌'}"></label>
          <label class="mcp-enable-row"><span>启用跑腿</span><input name="errandEnabled" type="checkbox" ${state.config?.errand?.enabled ? 'checked' : ''}></label>
          <button type="button" class="mcp-test" data-test-meituan-errand>测试连接</button>
          <button type="button" class="mcp-clear-token" data-open-meituan-paotui-skill>官方 Skill</button>
        </section>
      </div>
    </section>`;
}

function nativeDeviceMatchLabel(device = {}) {
  return describeToyCandidate(device).label;
}

function deviceCharacterName(character = {}) {
  return String(character.customNickname || character.remarkName || character.name || character.realName || '未命名角色').trim();
}

function deviceAuthorizationRows(characters = [], state = {}) {
  const authorized = new Set(Array.isArray(state.authorizedCharacterIds) ? state.authorizedCharacterIds : []);
  if (!characters.length) return '<div class="mcp-device-auth-empty">暂无可授权角色</div>';
  return characters.map((character) => `
    <label class="mcp-enable-row mcp-device-character">
      <span>${esc(deviceCharacterName(character))}</span>
      <input type="checkbox" data-device-character="${esc(character.id)}" ${authorized.has(character.id) ? 'checked' : ''}>
    </label>`).join('');
}

function builtinDevicePanel(state = {}, rows = [], message = '', busy = false, broadScanAvailable = false, characters = []) {
  const status = deviceStatus(state, message);
  return `
    <section class="mcp-device" aria-labelledby="mcp-device-title">
      <div class="mcp-device-head">
        <span><strong id="mcp-device-title">小玩具</strong><small>${esc(status)}</small></span>
        ${state.connected
          ? '<button type="button" class="mcp-device-link" data-device-disconnect>断开</button>'
          : `<button type="button" class="mcp-device-link" data-device-scan ${busy || !state.available ? 'disabled' : ''}>${busy ? '扫描中…' : '扫描'}</button>`}
      </div>
      ${!state.connected ? `
        <div class="mcp-device-source" role="group" aria-label="连接方式">
          <button type="button" data-device-source="native" aria-pressed="${state.backend !== 'intiface'}">本机直连</button>
          <button type="button" data-device-source="intiface" aria-pressed="${state.backend === 'intiface'}">Intiface</button>
        </div>
        ${state.backend === 'intiface' ? `
          <label class="mcp-device-endpoint">
            <span>服务器地址</span>
            <input type="url" value="${esc(state.intifaceEndpoint || 'ws://127.0.0.1:12345')}" data-device-endpoint inputmode="url" autocapitalize="none" spellcheck="false">
          </label>` : ''}` : ''}
      ${state.connected ? `
        ${state.backend === 'native' ? `
          <div class="mcp-device-profile">
            <span>${state.nativeProfile === 'unconfirmed' ? '测试后选择设备功能' : '设备功能'}</span>
            <div role="group" aria-label="设备功能">
              <button type="button" data-device-profile="vibration" aria-pressed="${state.nativeProfile === 'vibration'}">仅震动</button>
              <button type="button" data-device-profile="suction" aria-pressed="${state.nativeProfile === 'suction'}">仅吮吸</button>
              <button type="button" data-device-profile="both" aria-pressed="${state.nativeProfile === 'both'}">双功能</button>
            </div>
          </div>
          <div class="mcp-device-test" aria-label="低强度测试">
            <button type="button" data-device-test="vibration" ${busy ? 'disabled' : ''}>测试震动</button>
            <button type="button" data-device-test="suction" ${busy ? 'disabled' : ''}>测试吮吸</button>
          </div>` : ''}
        <label class="mcp-device-limit">
          <span>最高强度 <output>${Number(state.maxIntensity) || 100}</output></span>
          <input type="range" min="1" max="100" value="${Number(state.maxIntensity) || 100}" data-device-limit>
        </label>
        <section class="mcp-device-access" aria-label="角色授权">
          <strong>响应指令的角色</strong>
          <div class="mcp-device-character-list">${deviceAuthorizationRows(characters, state)}</div>
          <label class="mcp-enable-row mcp-device-role">
            <span>允许角色主动控制</span>
            <input type="checkbox" data-device-autonomous ${state.autonomousControl ? 'checked' : ''} ${state.roleControl ? '' : 'disabled'}>
          </label>
        </section>
        <button type="button" class="mcp-device-stop" data-device-stop>立即停止</button>` : ''}
      ${!state.connected && rows.length ? `<div class="mcp-device-results">${rows.map((device) => `
        <button type="button" data-device-connect="${esc(device.address)}">
          <span>${esc(device.name || '设备')}</span><small>${device.source === 'intiface'
            ? `${Number(device.outputs?.length) || 0} 个可控功能 · Intiface 已识别`
            : `${esc(nativeDeviceMatchLabel(device))} · ${esc(device.rssi ?? '?')} dBm`}</small>
        </button>`).join('')}</div>` : ''}
      ${!state.connected && state.backend !== 'intiface' && broadScanAvailable ? `
        <button type="button" class="mcp-device-broad-scan" data-device-scan-all ${busy ? 'disabled' : ''}>扫描其他型号</button>` : ''}
      ${!state.connected && state.backend !== 'intiface' ? `
        <button type="button" class="mcp-device-broad-scan" data-import-device-report>导入兼容报告</button>
        <input type="file" accept="application/json,.json" data-device-report-file hidden>` : ''}
    </section>`;
}

function deviceHelpDialog() {
  return `
    <div class="mcp-device-help-backdrop" data-close-device-help>
      <section class="mcp-device-help" role="dialog" aria-modal="true" aria-labelledby="mcp-device-help-title">
        <header>
          <h3 id="mcp-device-help-title">连接教程</h3>
          <button type="button" data-close-device-help aria-label="关闭教程">×</button>
        </header>
        <div class="mcp-device-help-body">
          <section>
            <strong>本机直连</strong>
            <ol>
              <li>打开玩具，并关闭官方 App、nRF 等占用蓝牙的应用。</li>
              <li>选择「本机直连」，允许附近设备权限后点扫描。</li>
              <li>选择设备；连接成功后选择可以控制的角色。</li>
            </ol>
            <small>目前实机验证 KISSTOY Lost 入体版 KST-082 与 Polly Max；找不到其他型号时可扫描全部设备，连接后按协议特征确认。</small>
          </section>
          <section>
            <strong>Intiface</strong>
            <ol>
              <li>安装 Intiface Central，开启 Bluetooth LE 并启动 Engine。</li>
              <li>同一手机使用 ws://127.0.0.1:12345；另一设备填写 Intiface 所在设备的局域网地址。</li>
              <li>回到这里选择「Intiface」，填写地址并扫描连接。</li>
            </ol>
            <small>Intiface 只会显示其设备库已经识别出的功能。</small>
          </section>
        </div>
      </section>
    </div>`;
}

function devicePageHtml(state = {}, rows = [], message = '', busy = false, helpOpen = false, broadScanAvailable = false, characters = []) {
  return `
    <section class="mcp-editor mcp-device-page" aria-labelledby="mcp-device-page-title">
      <header class="mcp-editor-head mcp-device-page-head">
        <button type="button" class="navbar-btn" data-close-device aria-label="返回 MCP">${icon('back')}</button>
        <h2 id="mcp-device-page-title">小玩具</h2>
        <button type="button" class="mcp-device-help-button" data-open-device-help aria-label="查看连接教程">?</button>
      </header>
      <main class="mcp-editor-scroll mcp-device-page-scroll">
        ${builtinDevicePanel(state, rows, message, busy, broadScanAvailable, characters)}
      </main>
      ${helpOpen ? deviceHelpDialog() : ''}
    </section>`;
}

function toolRows(tools = [], state = {}) {
  if (!tools.length) return '<div class="mcp-tools-empty">测试连接后显示工具</div>';
  return tools.map((tool) => `
    <div class="mcp-tool-row">
      <span><strong>${esc(tool.title || tool.name)}</strong>${tool.schemaError ? '<small>参数结构异常，已停用</small>' : (tool.description ? `<small>${esc(tool.description)}</small>` : '')}</span>
      <span class="mcp-tool-control">
        <em>${esc(toolRiskLabel(tool))}</em>
        ${tool.annotations?.readOnlyHint === true ? `
          <label class="mcp-tool-auto-approve" aria-label="${esc(tool.title || tool.name)}免确认">
            <input type="checkbox" data-auto-approve-mcp-tool="${esc(tool.name)}" ${tool.autoApproveRead === true ? 'checked' : ''} ${tool.schemaError ? 'disabled' : ''} />
            <span>免确认</span>
          </label>` : ''}
        ${tool.annotations?.readOnlyHint === true ? `
          <button type="button" class="mcp-tool-test" data-test-mcp-tool="${esc(tool.name)}" ${state.toolTestingName || tool.schemaError ? 'disabled' : ''}>
            ${state.toolTestingName === tool.name ? '运行中…' : '试运行'}
          </button>` : ''}
        <button type="button" class="mcp-tool-toggle${tool.enabled !== false ? ' is-on' : ''}"
          data-toggle-mcp-tool="${esc(tool.name)}" aria-pressed="${tool.enabled !== false ? 'true' : 'false'}"
          ${tool.schemaError ? 'disabled' : ''}
          aria-label="${tool.enabled === false ? '启用' : '停用'}${esc(tool.title || tool.name)}">
          ${tool.enabled !== false ? '已开启' : '已关闭'}
        </button>
      </span>
    </div>`).join('');
}

function editorHtml(item = {}, state = {}) {
  const serviceTemplate = getMcpServiceTemplate(item.serviceTemplateId);
  const hasSavedToken = state.hasSavedToken === true;
  const readTools = (Array.isArray(item.tools) ? item.tools : [])
    .filter((tool) => tool.annotations?.readOnlyHint === true);
  const allReadToolsAutoApproved = readTools.length
    ? readTools.every((tool) => tool.autoApproveRead === true)
    : item.autoApproveRead === true;
  const connectionResult = state.error
    ? state.error
    : (item.lastConnectedAt ? `已连接 · ${item.tools?.length || 0} 个工具` : '');
  const toolResult = state.toolTestError
    ? `试运行失败 · ${state.toolTestError}`
    : (state.toolTestText ? `试运行成功 · ${state.toolTestText}` : '');
  return `
      <section class="mcp-editor" aria-labelledby="mcp-editor-title">
        <header class="mcp-editor-head">
          <button type="button" class="navbar-btn" data-close-mcp aria-label="关闭">${icon('back')}</button>
          <h2 id="mcp-editor-title">${item.id ? '编辑连接' : '添加连接'}</h2>
          <button type="button" class="mcp-save" data-save-mcp>保存</button>
        </header>
        <div class="mcp-editor-scroll" data-ime-scroll-region>
          <label class="api-field">
            <span class="api-field-label">名称</span>
            <input class="form-input mcp-name" maxlength="60" value="${esc(item.name || '')}" placeholder="如：我的搜索工具" />
          </label>
          <label class="api-field">
            <span class="api-field-label">Server URL</span>
            <input class="form-input mcp-endpoint" inputmode="url" autocapitalize="none" spellcheck="false" value="${esc(item.endpoint || '')}" placeholder="https://example.com/mcp" />
          </label>
          <label class="api-field">
            <span class="api-field-label">Access Token</span>
            <input class="form-input mcp-token" type="password" autocomplete="off" value="${esc(state.token || '')}" placeholder="${hasSavedToken ? '已保存在本机；留空则保持不变' : '可选'}" />
            <small class="mcp-local-note">仅保存在本机，不随备份导出</small>
          </label>
          ${serviceTemplate?.authUrl ? `<button type="button" class="mcp-clear-token" data-open-mcp-auth="${esc(serviceTemplate.authUrl)}">获取 Token</button>` : ''}
          ${hasSavedToken ? '<button type="button" class="mcp-clear-token" data-clear-mcp-token>移除本机 Token</button>' : ''}
          <label class="mcp-enable-row">
            <span>启用连接</span>
            <input type="checkbox" class="mcp-enabled" ${item.enabled !== false ? 'checked' : ''} />
          </label>
          <label class="mcp-enable-row">
            <span>允许角色自主调用</span>
            <input type="checkbox" class="mcp-autonomous" ${item.allowAutonomousUse === true ? 'checked' : ''} />
          </label>
          <label class="mcp-enable-row">
            <span>所有只读工具免确认</span>
            <input type="checkbox" class="mcp-auto-approve-read" ${allReadToolsAutoApproved ? 'checked' : ''} />
          </label>
          <small class="mcp-permission-note">写入操作仍会每次询问</small>
          <label class="mcp-enable-row mcp-local-http-row">
            <span>允许 localhost HTTP</span>
            <input type="checkbox" class="mcp-allow-local-http" ${item.allowInsecureLocal === true ? 'checked' : ''} />
          </label>
          <button type="button" class="mcp-test" data-test-mcp ${state.testing ? 'disabled' : ''}>
            ${state.testing ? '正在连接…' : '测试连接'}
          </button>
          <div class="mcp-test-result${state.error ? ' is-error' : ''}" data-mcp-connection-result role="status" ${connectionResult ? '' : 'hidden'}>${esc(connectionResult)}</div>
          <div class="mcp-test-result${state.toolTestError ? ' is-error' : ''}" data-mcp-tool-result role="status" ${toolResult ? '' : 'hidden'}>${esc(toolResult)}</div>
          <section class="mcp-tools" aria-label="工具列表">
            ${toolRows(item.tools, state)}
          </section>
          ${item.id ? '<button type="button" class="mcp-delete" data-delete-mcp>删除连接</button>' : ''}
        </div>
      </section>`;
}

export default async function render(container, params = {}) {
  const [initialConnections, initialMeituanState, characters] = await Promise.all([
    listMcpConnections(),
    getMeituanServiceState(),
    listCharacters({ excludeAnonNpc: true }).catch(() => []),
  ]);
  let connections = initialConnections;
  let meituanState = initialMeituanState;
  let deviceState = getKisstoyDeviceState();
  let deviceRows = [];
  let deviceMessage = '';
  let deviceBusy = false;
  let deviceOpen = false;
  let deviceHelpOpen = false;
  let meituanOpen = String(params.service || '').trim() === 'meituan';
  let deviceBroadScanAvailable = false;
  let editing = null;
  let editorState = {
    token: '', hasSavedToken: false, clearSavedToken: false, testing: false, error: '',
    toolTestingName: '', toolTestText: '', toolTestError: '',
  };
  container.className = 'page mcp-page';
  const unsubscribeDevice = subscribeKisstoyDevice((next) => {
    deviceState = next;
    if (!editing && container.isConnected) paint();
  });
  const unsubscribeIntiface = subscribeIntifaceToy((next) => {
    if (deviceState.backend !== 'intiface' || deviceState.connected) return;
    deviceRows = Array.isArray(next?.devices) ? next.devices : [];
    if (deviceRows.length) deviceMessage = `发现 ${deviceRows.length} 个设备`;
    else if (!deviceBusy) deviceMessage = '未发现设备';
    if (!editing && container.isConnected) paint();
  });
  const onRouteDisposed = (event) => {
    if (event.detail?.container !== container) return;
    unsubscribeDevice();
    unsubscribeIntiface();
    window.removeEventListener('marshmallow-route-disposed', onRouteDisposed);
  };
  window.addEventListener('marshmallow-route-disposed', onRouteDisposed);

  function paint() {
    if (editing) {
      container.innerHTML = editorHtml(editing, editorState);
      bind();
      return;
    }
    if (meituanOpen) {
      container.innerHTML = meituanEditorHtml(meituanState);
      bind();
      return;
    }
    if (deviceOpen) {
      container.innerHTML = devicePageHtml(
        deviceState,
        deviceRows,
        deviceMessage,
        deviceBusy,
        deviceHelpOpen,
        deviceBroadScanAvailable,
        characters,
      );
      bind();
      return;
    }
    const availableTemplates = MCP_SERVICE_TEMPLATES.filter((template) => (
      !connections.some((item) => item.serviceTemplateId === template.id)
    ));
    container.innerHTML = `
      <header class="navbar mcp-navbar">
        <button type="button" class="navbar-btn" data-back aria-label="返回">${icon('back')}</button>
        <h1 class="navbar-title mcp-title">MCP</h1>
        <button type="button" class="navbar-btn" data-new-mcp aria-label="添加连接">${icon('plus')}</button>
      </header>
      <main class="mcp-scroll">
        <div class="mcp-list">
          ${builtinDeviceEntry(deviceState, deviceMessage)}
          ${builtinMeituanEntry(meituanState)}
          ${availableTemplates.map(serviceTemplateRow).join('')}
          ${connections.map(connectionRow).join('')}
          ${!connections.length && !availableTemplates.length ? `
            <button type="button" class="mcp-empty" data-new-mcp>
              <strong>添加 MCP 连接</strong>
              <span>连接远程工具服务器</span>
            </button>` : ''}
        </div>
      </main>`;
    bind();
  }

  function readEditor() {
    const sheet = container.querySelector('.mcp-editor');
    if (!sheet) return editing;
    const toolStates = new Map(Array.from(sheet.querySelectorAll('[data-toggle-mcp-tool]')).map((control) => [
      control.dataset.toggleMcpTool,
      control.getAttribute('aria-pressed') === 'true',
    ]));
    const toolApprovalStates = new Map(Array.from(sheet.querySelectorAll('[data-auto-approve-mcp-tool]')).map((input) => [
      input.dataset.autoApproveMcpTool,
      input.checked,
    ]));
    const endpointDraft = updateMcpConnectionEndpointDraft(
      editing,
      sheet.querySelector('.mcp-endpoint')?.value,
    );
    return {
      ...endpointDraft,
      name: sheet.querySelector('.mcp-name')?.value,
      enabled: sheet.querySelector('.mcp-enabled')?.checked !== false,
      allowAutonomousUse: sheet.querySelector('.mcp-autonomous')?.checked === true,
      autoApproveRead: sheet.querySelector('.mcp-auto-approve-read')?.checked === true,
      allowInsecureLocal: sheet.querySelector('.mcp-allow-local-http')?.checked === true,
      tools: (endpointDraft.tools || []).map((tool) => ({
        ...tool,
        enabled: toolStates.has(tool.name) ? toolStates.get(tool.name) : tool.enabled !== false,
        autoApproveRead: tool.annotations?.readOnlyHint === true
          && (toolApprovalStates.has(tool.name) ? toolApprovalStates.get(tool.name) : tool.autoApproveRead === true),
      })),
    };
  }

  function readTypedToken() {
    return String(container.querySelector('.mcp-token')?.value || '').trim();
  }

  function syncEditorTransientState() {
    const testButton = container.querySelector('[data-test-mcp]');
    if (testButton) {
      testButton.disabled = editorState.testing === true;
      testButton.textContent = editorState.testing ? '正在连接…' : '测试连接';
    }
    const connectionResult = container.querySelector('[data-mcp-connection-result]');
    if (connectionResult) {
      const text = editorState.error
        ? editorState.error
        : (editing?.lastConnectedAt ? `已连接 · ${editing.tools?.length || 0} 个工具` : '');
      connectionResult.hidden = !text;
      connectionResult.classList.toggle('is-error', Boolean(editorState.error));
      connectionResult.textContent = text;
    }
    const toolResult = container.querySelector('[data-mcp-tool-result]');
    if (toolResult) {
      const text = editorState.toolTestError
        ? `试运行失败 · ${editorState.toolTestError}`
        : (editorState.toolTestText ? `试运行成功 · ${editorState.toolTestText}` : '');
      toolResult.hidden = !text;
      toolResult.classList.toggle('is-error', Boolean(editorState.toolTestError));
      toolResult.textContent = text;
    }
    container.querySelectorAll('[data-test-mcp-tool]').forEach((button) => {
      const running = editorState.toolTestingName === button.dataset.testMcpTool;
      button.disabled = Boolean(editorState.toolTestingName);
      button.textContent = running ? '运行中…' : '试运行';
    });
  }

  async function openEditor(item = null) {
    let credential = { bearerToken: '' };
    if (item?.id) {
      const providerId = mcpConnectionProviderId(item.id);
      const [grants, savedCredential] = await Promise.all([
        listCapabilityGrants({ providerId }),
        getMcpConnectionCredential(item.id),
      ]);
      editing = applyMcpConnectionReadGrants(item, grants);
      credential = savedCredential;
    } else if (item) editing = { ...item };
    else editing = {
      id: '',
      name: '',
      endpoint: '',
      enabled: true,
      allowAutonomousUse: false,
      autoApproveRead: false,
      tools: [],
      lastConnectedAt: 0,
    };
    editorState = {
      token: '',
      hasSavedToken: Boolean(credential.bearerToken),
      clearSavedToken: false,
      testing: false,
      error: '',
      toolTestingName: '',
      toolTestText: '',
      toolTestError: '',
    };
    paint();
    container.querySelector('.mcp-name')?.focus();
  }

  async function openTemplateEditor(templateId = '') {
    const template = getMcpServiceTemplate(templateId);
    if (!template) return;
    await openEditor({
      id: '',
      name: template.name,
      endpoint: template.endpoint,
      serviceTemplateId: template.id,
      preferredProtocolVersion: template.preferredProtocolVersion,
      enabled: true,
      allowAutonomousUse: false,
      autoApproveRead: false,
      tools: [],
      lastConnectedAt: 0,
    });
    container.querySelector('.mcp-token')?.focus();
  }

  async function openExternalUrl(url = '') {
    const target = String(url || '').trim();
    if (!target) return;
    try {
      const browser = window.Capacitor?.Plugins?.Browser;
      if (browser?.open) await browser.open({ url: target });
      else window.open(target, '_blank', 'noopener,noreferrer');
    } catch (_) {
      window.open(target, '_blank', 'noopener,noreferrer');
    }
  }

  function closeEditor(event = null) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    editing = null;
    editorState = {
      token: '', hasSavedToken: false, clearSavedToken: false, testing: false, error: '',
      toolTestingName: '', toolTestText: '', toolTestError: '',
    };
    paint();
  }

  async function testConnection() {
    const draft = readEditor();
    const typedToken = readTypedToken();
    editing = draft;
    editorState = {
      ...editorState,
      token: typedToken,
      testing: true,
      error: '',
      toolTestText: '',
      toolTestError: '',
    };
    syncEditorTransientState();
    try {
      editing = await discoverMcpConnection(draft, {
        ...((typedToken || editorState.clearSavedToken) ? { bearerToken: typedToken } : {}),
      });
      editorState = { ...editorState, testing: false, error: '' };
      renderToolRowsPreservingScroll({ readEditorState: false });
      syncEditorTransientState();
      showToast(`已发现 ${editing.tools.length} 个工具`);
    } catch (error) {
      editorState = {
        ...editorState,
        testing: false,
        error: friendlyMcpError(error, '连接失败'),
      };
      syncEditorTransientState();
    }
  }

  async function testTool(toolName = '') {
    const draft = readEditor();
    const typedToken = readTypedToken();
    editing = draft;
    editorState = {
      ...editorState,
      token: typedToken,
      toolTestingName: toolName,
      toolTestText: '',
      toolTestError: '',
    };
    syncEditorTransientState();
    try {
      const result = await testMcpConnectionTool(draft, toolName, {
        ...((typedToken || editorState.clearSavedToken) ? { bearerToken: typedToken } : {}),
      });
      editorState = {
        ...editorState,
        toolTestingName: '',
        toolTestText: String(result.text || '服务器已返回结果').replace(/\s+/g, ' ').slice(0, 120),
        toolTestError: '',
      };
      syncEditorTransientState();
    } catch (error) {
      editorState = {
        ...editorState,
        toolTestingName: '',
        toolTestText: '',
        toolTestError: friendlyMcpError(error, '工具调用失败'),
      };
      syncEditorTransientState();
    }
  }

  async function saveEditor() {
    const draft = readEditor();
    const typedToken = readTypedToken();
    try {
      const normalized = normalizeMcpConnection(draft);
      const credentialOptions = typedToken
        ? { bearerToken: typedToken }
        : (editorState.hasSavedToken && !editorState.clearSavedToken ? {} : { bearerToken: '' });
      await saveMcpConnection(normalized, credentialOptions);
      await refreshMcpCapabilityProviders();
      const { invalidateChatSystemPromptPrewarm } = await import('../core/context/build-chat-context.js');
      invalidateChatSystemPromptPrewarm();
      connections = await listMcpConnections();
      editing = null;
      paint();
      showToast('MCP 连接已保存');
    } catch (error) {
      editorState = { ...editorState, token: typedToken, error: friendlyMcpError(error, '保存失败') };
      paint();
    }
  }

  async function removeEditor() {
    if (!editing?.id || !window.confirm(`删除「${editing.name}」？`)) return;
    await deleteMcpConnection(editing.id);
    await refreshMcpCapabilityProviders();
    const { invalidateChatSystemPromptPrewarm } = await import('../core/context/build-chat-context.js');
    invalidateChatSystemPromptPrewarm();
    connections = await listMcpConnections();
    editing = null;
    paint();
    showToast('MCP 连接已删除');
  }

  function renderToolRowsPreservingScroll({ readEditorState = true } = {}) {
    const scroll = container.querySelector('.mcp-editor-scroll');
    const tools = container.querySelector('.mcp-tools');
    if (!tools) return;
    const scrollTop = scroll?.scrollTop || 0;
    if (readEditorState) editing = readEditor();
    tools.innerHTML = toolRows(editing?.tools, editorState);
    bindToolControls();
    if (scroll) {
      scroll.scrollTop = scrollTop;
      // Android System WebView 会把长滚动弹层的局部样式变更错误复用为
      // 透明纹理块。替换工具列表节点后再恢复滚动位置，让它重建可见区。
      requestAnimationFrame(() => { scroll.scrollTop = scrollTop; });
    }
  }

  function bindToolControls() {
    container.querySelectorAll('[data-test-mcp-tool]').forEach((button) => {
      button.addEventListener('click', () => testTool(button.dataset.testMcpTool));
    });
    container.querySelectorAll('[data-toggle-mcp-tool]').forEach((control) => {
      control.addEventListener('click', (event) => {
        event.stopPropagation();
        const enabled = control.getAttribute('aria-pressed') !== 'true';
        // Android WebView 在长滚动区切换隐藏 checkbox + :checked 伪元素时仍可能
        // 丢失整页合成层。工具开关使用无伪元素的普通按钮，只更新文本状态。
        control.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        control.classList.toggle('is-on', enabled);
        control.textContent = enabled ? '已开启' : '已关闭';
        control.setAttribute(
          'aria-label',
          String(control.getAttribute('aria-label') || '').replace(/^(?:启用|停用)/, enabled ? '停用' : '启用'),
        );
      });
    });
    container.querySelectorAll('[data-auto-approve-mcp-tool]').forEach((input) => {
      input.addEventListener('change', () => {
        const approvals = Array.from(container.querySelectorAll('[data-auto-approve-mcp-tool]'));
        const bulk = container.querySelector('.mcp-auto-approve-read');
        if (bulk && approvals.length) bulk.checked = approvals.every((item) => item.checked);
      });
    });
  }

  function bind() {
    container.querySelector('[data-back]')?.addEventListener('click', () => back());
    container.querySelector('[data-open-meituan]')?.addEventListener('click', async () => {
      meituanState = await getMeituanServiceState();
      meituanOpen = true;
      paint();
    });
    container.querySelector('[data-close-meituan]')?.addEventListener('click', () => {
      meituanOpen = false;
      paint();
    });
    container.querySelector('[data-open-meituan-travel-token]')?.addEventListener('click', () => openExternalUrl(MEITUAN_TRAVEL_TOKEN_URL));
    container.querySelector('[data-open-meituan-paotui-skill]')?.addEventListener('click', () => openExternalUrl(MEITUAN_PAOTUI_SKILL_URL));
    container.querySelector('[data-test-meituan-errand]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = '测试中…';
      try { await callMeituanErrandBridge('health'); showToast('跑腿桥连接正常'); }
      catch (error) { showToast(error?.message || '跑腿桥无法连接'); }
      finally { button.disabled = false; button.textContent = '测试连接'; }
    });
    container.querySelector('[data-save-meituan]')?.addEventListener('click', async () => {
      const value = (name) => String(container.querySelector(`[name="${name}"]`)?.value || '').trim();
      try {
        await saveMeituanServiceState({
          travel: {
            enabled: container.querySelector('[name="travelEnabled"]')?.checked === true,
            allowAutonomousUse: container.querySelector('[name="travelAutonomous"]')?.checked === true,
            city: value('travelCity'),
          },
          errand: {
            enabled: container.querySelector('[name="errandEnabled"]')?.checked === true,
            bridgeUrl: value('errandUrl'),
          },
          credentials: {
            travelToken: value('travelToken') || meituanState.credentials?.travelToken || '',
            errandToken: value('errandToken') || meituanState.credentials?.errandToken || '',
          },
        });
        meituanState = await getMeituanServiceState();
        showToast('美团连接已保存');
        paint();
      } catch (error) { showToast(error?.message || '无法保存美团连接'); }
    });
    container.querySelector('[data-open-device]')?.addEventListener('click', () => {
      deviceOpen = true;
      deviceHelpOpen = false;
      paint();
    });
    container.querySelector('[data-close-device]')?.addEventListener('click', () => {
      deviceOpen = false;
      deviceHelpOpen = false;
      paint();
    });
    container.querySelector('[data-open-device-help]')?.addEventListener('click', () => {
      deviceHelpOpen = true;
      paint();
      container.querySelector('.mcp-device-help [data-close-device-help]')?.focus();
    });
    container.querySelectorAll('[data-close-device-help]').forEach((element) => {
      element.addEventListener('click', (event) => {
        if (event.currentTarget === event.target || event.currentTarget.matches('.mcp-device-help header button')) {
          deviceHelpOpen = false;
          paint();
          container.querySelector('[data-open-device-help]')?.focus();
        }
      });
    });
    container.querySelector('.mcp-device-help')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      deviceHelpOpen = false;
      paint();
      container.querySelector('[data-open-device-help]')?.focus();
    });
    container.querySelectorAll('[data-new-mcp]').forEach((button) => button.addEventListener('click', () => openEditor()));
    container.querySelectorAll('[data-add-mcp-template]').forEach((button) => {
      button.addEventListener('click', () => openTemplateEditor(button.dataset.addMcpTemplate));
    });
    container.querySelectorAll('[data-edit-mcp]').forEach((button) => {
      button.addEventListener('click', () => openEditor(connections.find((item) => item.id === button.dataset.editMcp)));
    });
    container.querySelectorAll('[data-toggle-mcp]').forEach((input) => {
      input.addEventListener('change', async () => {
        const item = connections.find((row) => row.id === input.dataset.toggleMcp);
        if (!item) return;
        await saveMcpConnection({ ...item, enabled: input.checked });
        await refreshMcpCapabilityProviders();
        const { invalidateChatSystemPromptPrewarm } = await import('../core/context/build-chat-context.js');
        invalidateChatSystemPromptPrewarm();
        connections = await listMcpConnections();
        paint();
      });
    });
    container.querySelector('[data-close-mcp]')?.addEventListener('click', closeEditor);
    container.querySelector('[data-test-mcp]')?.addEventListener('click', testConnection);
    container.querySelector('[data-open-mcp-auth]')?.addEventListener('click', (event) => {
      openExternalUrl(event.currentTarget.dataset.openMcpAuth);
    });
    bindToolControls();
    container.querySelector('.mcp-auto-approve-read')?.addEventListener('change', (event) => {
      container.querySelectorAll('[data-auto-approve-mcp-tool]').forEach((input) => {
        input.checked = event.currentTarget.checked;
      });
    });
    container.querySelector('[data-clear-mcp-token]')?.addEventListener('click', () => {
      editorState = { ...editorState, token: '', hasSavedToken: false, clearSavedToken: true };
      paint();
      container.querySelector('.mcp-token')?.focus();
    });
    container.querySelector('[data-save-mcp]')?.addEventListener('click', saveEditor);
    container.querySelector('[data-delete-mcp]')?.addEventListener('click', removeEditor);
    container.querySelectorAll('[data-device-source]').forEach((button) => {
      button.addEventListener('click', () => {
        try {
          deviceState = setToyConnectionMode(button.dataset.deviceSource);
          deviceRows = [];
          deviceMessage = '';
          deviceBroadScanAvailable = false;
        } catch (error) {
          deviceMessage = friendlyMcpError(error, '切换失败');
        }
        paint();
      });
    });
    container.querySelector('[data-device-endpoint]')?.addEventListener('change', (event) => {
      try {
        deviceState = setToyIntifaceEndpoint(event.currentTarget.value);
        deviceMessage = '';
      } catch (error) {
        deviceMessage = friendlyMcpError(error, '地址无效');
      }
      paint();
    });
    async function scanDeviceRows(includeUnknown = false) {
      const endpointDraft = container.querySelector('[data-device-endpoint]')?.value || '';
      try {
        if (endpointDraft) deviceState = setToyIntifaceEndpoint(endpointDraft);
      } catch (error) {
        deviceMessage = friendlyMcpError(error, '地址无效');
        paint();
        return;
      }
      deviceBusy = true;
      deviceMessage = includeUnknown ? '正在扫描附近全部 BLE 设备…' : '正在扫描玩具…';
      paint();
      try {
        const result = await scanKisstoyDevices({ includeUnknown });
        deviceRows = Array.isArray(result?.devices) ? result.devices : [];
        deviceMessage = deviceRows.length ? `发现 ${deviceRows.length} 个设备` : '未发现设备';
        deviceBroadScanAvailable = deviceState.backend !== 'intiface' && !includeUnknown;
      } catch (error) { deviceMessage = friendlyMcpError(error, '扫描失败'); }
      finally { deviceBusy = false; paint(); }
    }
    container.querySelector('[data-device-scan]')?.addEventListener('click', () => {
      void scanDeviceRows(false);
    });
    container.querySelector('[data-device-scan-all]')?.addEventListener('click', () => {
      void scanDeviceRows(true);
    });
    container.querySelector('[data-import-device-report]')?.addEventListener('click', () => {
      container.querySelector('[data-device-report-file]')?.click();
    });
    container.querySelector('[data-device-report-file]')?.addEventListener('change', async (event) => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      try {
        const profile = importToyCompatibilityReport(await file.text());
        deviceMessage = `已导入 ${profile.model}，重新扫描后即可连接`;
        deviceBroadScanAvailable = true;
      } catch (error) {
        deviceMessage = friendlyMcpError(error, '导入失败');
      }
      paint();
    });
    container.querySelectorAll('[data-device-connect]').forEach((button) => {
      button.addEventListener('click', async () => {
        const device = deviceRows.find((item) => item.address === button.dataset.deviceConnect);
        if (!device) return;
        deviceBusy = true; deviceMessage = `正在连接 ${device.name || '设备'}…`; paint();
        try {
          const result = await connectKisstoyDevice(device);
          deviceState = result.state;
          deviceRows = [];
          deviceBroadScanAvailable = false;
          deviceMessage = result.connected ? '' : friendlyToyConnectionFailure(result);
        } catch (error) { deviceMessage = friendlyMcpError(error, '连接失败'); }
        finally { deviceBusy = false; paint(); }
      });
    });
    container.querySelector('[data-device-limit]')?.addEventListener('change', (event) => {
      deviceState = setKisstoyMaxIntensity(event.currentTarget.value);
      paint();
    });
    container.querySelectorAll('[data-device-profile]').forEach((button) => {
      button.addEventListener('click', () => {
        try {
          deviceState = setKisstoyNativeProfile(button.dataset.deviceProfile);
          deviceMessage = '设备功能已保存';
        } catch (error) {
          deviceMessage = friendlyMcpError(error, '保存失败');
        }
        paint();
      });
    });
    container.querySelectorAll('[data-device-test]').forEach((button) => {
      button.addEventListener('click', async () => {
        deviceBusy = true;
        deviceMessage = button.dataset.deviceTest === 'suction' ? '正在低强度测试吮吸…' : '正在低强度测试震动…';
        paint();
        try {
          await testKisstoyNativeOutput(button.dataset.deviceTest);
          deviceMessage = '测试已自动停止，请按实际效果选择设备功能';
        } catch (error) {
          deviceMessage = friendlyMcpError(error, '测试失败');
        } finally {
          deviceBusy = false;
          paint();
        }
      });
    });
    container.querySelectorAll('[data-device-character]').forEach((input) => {
      input.addEventListener('change', (event) => {
        try {
          deviceState = setKisstoyCharacterAuthorization(
            event.currentTarget.dataset.deviceCharacter,
            event.currentTarget.checked,
          );
          deviceMessage = '';
        } catch (error) {
          deviceMessage = friendlyMcpError(error, '授权失败');
        }
        paint();
      });
    });
    container.querySelector('[data-device-autonomous]')?.addEventListener('change', (event) => {
      try {
        deviceState = setKisstoyAutonomousControl(event.currentTarget.checked);
        deviceMessage = '';
      } catch (error) {
        deviceMessage = friendlyMcpError(error, '授权失败');
      }
      paint();
    });
    container.querySelector('[data-device-stop]')?.addEventListener('click', async () => {
      try { deviceState = await stopKisstoyDevice(); deviceMessage = '已停止'; }
      catch (error) { deviceMessage = friendlyMcpError(error, '停止失败'); }
      paint();
    });
    container.querySelector('[data-device-disconnect]')?.addEventListener('click', async () => {
      try { deviceState = await disconnectKisstoyDevice(); deviceMessage = ''; }
      catch (error) { deviceMessage = friendlyMcpError(error, '断开失败'); }
      paint();
    });
  }

  paint();
}
