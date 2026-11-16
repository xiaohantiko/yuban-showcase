const $ = (id) => document.getElementById(id);
const routes = { admin: '管理后台', overview: '开始使用', ai: '高级接入', persona: '人设与记忆', greetings: '主动问候', usage: '用量看板', help: '使用说明', activity: '运行记录', feedback: '问题反馈' };
const fields = { enabled: 'greet-enabled', afterMinutes: 'delay', quietEnabled: 'quiet-enabled', quietStart: 'quiet-start', quietEnd: 'quiet-end', voiceReplies: 'voice-default' };
const field = (name) => $(fields[name]);
const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ownerTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const adminDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const usageFormatter = new Intl.NumberFormat('zh-CN');
const usageMetrics = [
  ['totalTokens', '总 Token'], ['inputTokens', '输入 Token'], ['outputTokens', '输出 Token'],
  ['requests', '请求'], ['failed', '失败'], ['unreported', '未返回用量'],
];
const usageProviders = new Map([
  ['openai', 'OpenAI'], ['deepseek', 'DeepSeek'], ['qwen', '千问'], ['doubao', '豆包'],
  ['kimi', '月之暗面'], ['compatible', '兼容接口'], ['other', '其他服务商'],
]);
const macPreview = location.protocol === 'yuban-preview:';
const desktopPreview = macPreview || location.origin === 'https://yuban-preview.invalid';
const legacyEndpoints = { qqWebhook: '/api/qq/webhook', aiReply: '/api/ai/reply', gptSchema: '/api/gpt/openapi.json' };
let state;
let dirty = false;
let companionDirty = false;
let companionSaving = false;
let dshSaving = false;
let setupSnapshot;
let setupWorking = false;
let setupLoaded = false;
let setupAutoOpened = false;
let setupRequestId = 0;
let ownerSnapshot;
let ownerClaim;
let ownerWorking = false;
let ownerRequestId = 0;
let ownerExpiryTimer;
let importMode = 'persona';
let importedPersona = null;
let importFileId = 0;
let redirectingToLogin = false;
let usageRequestId = 0;
let adminRequestId = 0;
let adminFeedbackRequestId = 0;
let adminFeedbackPage = { offset: 0, limit: 20 };
let userToDisable;
let updatingAdminUser = false;
const setupSteps = ['step-cloud', 'step-model', 'step-qq'];
const dshButtons = new Map();
let toastTimer;

const icon = (name) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3300);
}
function badge(id, label, tone = 'neutral') {
  const el = $(id);
  el.textContent = label;
  el.className = `badge ${tone}`;
}
function accountUsername(snapshot = state) {
  return !desktopPreview && typeof snapshot?.account?.username === 'string' ? snapshot.account.username : '';
}
function isAdmin(snapshot = state) {
  return Boolean(accountUsername(snapshot)) && snapshot?.account?.role === 'admin';
}
function isMember(snapshot = state) {
  return Boolean(accountUsername(snapshot)) && snapshot?.account?.role === 'member';
}
function endpointURL(name) {
  if (desktopPreview || !state) return '';
  const path = (state.endpoints === undefined ? legacyEndpoints : state.endpoints)?.[name];
  if (typeof path !== 'string' || !/^\/[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(path)) return '';
  const url = new URL(path, location.origin);
  return url.origin === location.origin && url.pathname === path ? url.href : '';
}
function showAIAddress(url, available = true) {
  $('ai-url').textContent = url || '连接云端后显示';
  $('ai-url').title = url;
  $('copy-ai-url').disabled = !url;
  $('ai-endpoint').hidden = !available;
  $('ai-token-note').hidden = desktopPreview || !available;
  $('ai-api-example').hidden = !available;
  $('ai-curl').textContent = available ? [
    `curl -X POST '${url || `https://yuban.example.com${legacyEndpoints.aiReply}`}' \\`,
    '  -H "Authorization: Bearer $YUBAN_AI_API_TOKEN" \\',
    "  -H 'Content-Type: application/json' \\",
    "  -d '{\"message\":\"你好，小宇\",\"mode\":\"chat\"}'",
  ].join('\n') : '';
}
async function copyAddress(id, message) {
  const code = $(id);
  if (!code.title) return;
  try {
    await navigator.clipboard.writeText(code.title);
    toast(message);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast('地址已选中，可以手动复制');
  }
}
function renderModelCatalog() {
  if (typeof MODEL_CATALOG === 'undefined' || !MODEL_CATALOG.length) return;
  const models = MODEL_CATALOG.flatMap(({ base, docs, models }) => models.map((item) => ({ ...item, base, docs })));
  const list = $('model-options');
  const buttons = [];
  function show(index) {
    const item = models[index];
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    $('model-note').textContent = item.note;
    $('model-docs').href = item.docs;
    $('model-docs').setAttribute('aria-label', `${item.name} 官方文档`);
    $('model-config').textContent = `AI_BASE_URL=${item.base}\nAI_MODEL=${item.model}`;
    $('model-detail').hidden = false;
  }
  for (const [index, item] of models.entries()) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    const name = document.createElement('strong');
    const model = document.createElement('code');
    button.type = 'button';
    button.title = item.model;
    name.textContent = item.name;
    model.textContent = item.model;
    button.addEventListener('click', () => show(index));
    button.append(name, model);
    li.append(button);
    list.append(li);
    buttons.push(button);
  }
  show(0);
}
async function copyCodeBlock(id, message) {
  const code = $(id);
  try {
    await navigator.clipboard.writeText(code.textContent);
    toast(message);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Leave the text selected. */ }
    if (copied) selection.removeAllRanges();
    toast(copied ? message : '内容已选中，可以手动复制');
  }
}
function selectedDshPlugins() {
  return Array.isArray(state?.settings.dshPlugins) ? state.settings.dshPlugins : [];
}
function renderDshPlan() {
  const selected = selectedDshPlugins();
  for (const [id, button] of dshButtons) {
    const added = selected.includes(id);
    button.textContent = added ? '移出清单' : '添加';
    button.setAttribute('aria-pressed', String(added));
    button.setAttribute('aria-label', `${added ? '从清单移除' : '添加'} ${button.dataset.pluginName}`);
    button.disabled = !state || dshSaving;
  }
  $('dsh-plan-status').textContent = selected.length ? `已添加 ${selected.length} 项` : '未添加';
  const entries = typeof DSH_PLUGIN_CATALOG === 'undefined' ? [] : selected.flatMap((id) => DSH_PLUGIN_CATALOG.filter((item) => item.id === id));
  $('dsh-plan').hidden = !entries.length;
  const separatesMemoryProfiles = selected.includes('remember') && selected.includes('memory');
  $('dsh-plan-conflict').hidden = !separatesMemoryProfiles;
  $('dsh-plan-text').textContent = entries.map((item) => {
    const profile = item.id === 'remember' ? 'DSH_REMEMBER_PROFILE' : item.id === 'memory' ? 'DSH_MEMORY_PROFILE' : '';
    const steps = separatesMemoryProfiles && profile ? item.steps.replace('--profile web', `--profile "$${profile}"`) : item.steps;
    return `# ${item.source} · ${item.mode}\n${steps}`;
  }).join('\n\n');
}
async function toggleDshPlugin(id) {
  if (!state || dshSaving) return;
  const selected = selectedDshPlugins();
  const added = selected.includes(id);
  const next = added ? selected.filter((value) => value !== id) : [...selected, id];
  dshSaving = true;
  renderDshPlan();
  try {
    render(await request('/api/settings', 'PATCH', { dshPlugins: next }));
    toast(added ? '已移出安装清单' : '已添加到安装清单');
  } catch (err) { toast(err.message); }
  finally { dshSaving = false; renderDshPlan(); }
}
function buildDshCatalog() {
  if (typeof DSH_PLUGIN_CATALOG === 'undefined') return;
  for (const item of DSH_PLUGIN_CATALOG) {
    const row = document.createElement('li');
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    const source = document.createElement('a');
    const detail = document.createElement('p');
    const mode = document.createElement('span');
    const button = document.createElement('button');
    title.textContent = item.name;
    source.className = 'link dsh-source';
    source.href = item.docs;
    source.target = '_blank';
    source.rel = 'noreferrer';
    source.textContent = item.source;
    detail.textContent = item.detail;
    mode.className = 'badge neutral';
    mode.textContent = item.mode;
    button.type = 'button';
    button.className = 'button subtle';
    button.dataset.pluginName = item.name;
    button.addEventListener('click', () => toggleDshPlugin(item.id));
    copy.append(title, source, detail, mode);
    row.append(copy, button);
    $('dsh-options').append(row);
    dshButtons.set(item.id, button);
  }
  renderDshPlan();
}
function savedCompanionConfig() {
  const saved = state?.settings ?? {};
  return {
    companionName: saved.companionName ?? '',
    companionPersona: saved.companionPersona ?? '',
    memoryEnabled: saved.memoryEnabled !== false,
  };
}
function currentCompanionConfig() {
  return {
    companionName: $('companion-name').value.trim(),
    companionPersona: $('companion-persona').value.trim(),
    memoryEnabled: $('memory-enabled').checked,
  };
}
const sameCompanionConfig = (a, b) => Object.keys(a).every((key) => a[key] === b[key]);
function renderCompanion() {
  const saved = savedCompanionConfig();
  if (!companionDirty) {
    $('companion-name').value = saved.companionName;
    $('companion-persona').value = saved.companionPersona;
    $('memory-enabled').checked = saved.memoryEnabled;
  }
  const choice = currentCompanionConfig();
  $('persona-count').textContent = `${$('companion-persona').value.length} / 1000`;
  $('save-companion').disabled = !state || sameCompanionConfig(choice, saved) || companionSaving;
  $('companion-note').textContent = desktopPreview ? '离线设置保存在本机。要应用到 QQ，请在云端控制台保存。' : '保存后应用于下一条陪伴回复。';
}
const publicCloud = () => !desktopPreview && (state?.runtime === 'cloud' || (location.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)));
function openSetupStep(id, scroll = false) {
  for (const step of setupSteps) $(step).open = step === id;
  if (scroll && id) $(id).scrollIntoView({ block: 'nearest' });
}
function feedback(id, text, tone = '') {
  const el = $(id);
  el.textContent = text;
  el.dataset.tone = tone;
}
function setupSelectedProvider() {
  const value = $('setup-provider').value;
  return typeof MODEL_CATALOG === 'undefined' ? undefined : MODEL_CATALOG.find((provider) => provider.id === value);
}
function renderSetupProvider() {
  const provider = setupSelectedProvider();
  const models = provider?.models ?? [];
  const showPicker = models.length > 1;
  const picker = $('setup-preset-model');
  picker.replaceChildren(...models.map(({ name, model }) => new Option(name, model)));
  picker.hidden = !showPicker;
  picker.disabled = !showPicker;
  $('setup-preset-label').hidden = !showPicker;

  const custom = $('setup-provider').value === 'custom';
  $('setup-custom-model').hidden = !custom;
  for (const id of ['setup-base', 'setup-model-id']) {
    $(id).required = custom;
    $(id).disabled = !custom;
  }
  $('setup-provider-docs').hidden = !provider;
  if (provider) $('setup-provider-docs').href = provider.docs;
  $('setup-provider-voice').textContent = provider?.voiceNote ?? '语音服务须支持 POST /audio/speech，并直接返回音频。对话和语音可以分别选服务商。';
  const voiceDocs = $('setup-provider-voice-docs');
  voiceDocs.hidden = !provider?.voiceDocs;
  if (provider?.voiceDocs) voiceDocs.href = provider.voiceDocs;
  else voiceDocs.removeAttribute('href');
}
function initializeSetup() {
  const picker = $('setup-provider');
  if (typeof MODEL_CATALOG !== 'undefined') {
    for (const provider of MODEL_CATALOG) {
      picker.add(new Option(provider.name, provider.id));
    }
  }
  picker.add(new Option('其他服务商', 'custom'));
  renderSetupProvider();
  $('setup-connect').hidden = !desktopPreview;
}
function renderOwner(transportConfigured) {
  const owner = ownerSnapshot?.owner;
  if (ownerClaim && (ownerClaim.expiresAt <= Date.now() || ownerClaim.expiresAt !== ownerSnapshot?.expiresAt)) {
    ownerClaim = undefined;
    clearTimeout(ownerExpiryTimer);
  }
  const pending = ownerSnapshot?.expiresAt > Date.now();
  const canPair = Boolean(!desktopPreview && transportConfigured && ownerSnapshot);
  badge('owner-status', pending ? (owner ? '等待新账号确认' : '等待 QQ 确认') : owner ? '已认领' : '未认领', owner && !pending ? 'success' : 'neutral');
  $('owner-note').textContent = owner
    ? `当前主人：${owner.name || '未设置称呼'}（${owner.transport === 'onebot' ? 'OneBot' : 'QQ'} ${owner.idHint}）。新账号认领成功后，才会替换当前主人。`
    : canPair ? '只有发出有效认领码的 QQ 账号才能成为主人。发「我是你主人」不会改变身份。'
    : !transportConfigured || desktopPreview ? '连接云端并保存 QQ 机器人后，就能生成一次性认领码。'
    : '还没读到认领状态。请刷新；已有云端服务需更新到支持认领的版本。';
  $('owner-fields').disabled = !canPair || ownerWorking;
  $('owner-generate').textContent = ownerWorking ? '正在生成…' : owner ? (pending ? '重新生成更换码' : '生成更换码') : pending ? '重新生成认领码' : '生成认领码';
  $('owner-refresh').hidden = !transportConfigured || desktopPreview;
  $('owner-refresh').disabled = ownerWorking;
  $('owner-claim').hidden = !ownerClaim;
  $('owner-command').textContent = ownerClaim?.command || '';
  $('owner-expires').textContent = ownerClaim ? `北京时间 ${ownerTime.format(ownerClaim.expiresAt)} 到期，只能使用一次。` : '';
}
async function loadOwner() {
  if (desktopPreview || ownerWorking) return;
  const id = ++ownerRequestId;
  let loaded;
  try { loaded = await request('/api/owner'); } catch { return; }
  if (id !== ownerRequestId || typeof loaded?.bound !== 'boolean') return;
  const confirmed = Boolean(ownerClaim && loaded.bound && loaded.expiresAt == null && loaded.owner?.boundAt !== ownerSnapshot?.owner?.boundAt);
  ownerSnapshot = loaded;
  if (confirmed) feedback('owner-feedback', '认领成功。现在可以在 QQ 开始聊天。', 'success');
  renderSetup();
  return loaded;
}
async function generateOwnerClaim() {
  if ($('owner-fields').disabled) return;
  ownerWorking = true;
  ++ownerRequestId;
  renderSetup();
  feedback('owner-feedback', '');
  try {
    ownerClaim = await request('/api/owner/code', 'POST', { name: $('owner-name').value.trim() });
    ownerSnapshot = { ...ownerSnapshot, expiresAt: ownerClaim.expiresAt };
    clearTimeout(ownerExpiryTimer);
    ownerExpiryTimer = setTimeout(() => renderSetup(), Math.max(0, ownerClaim.expiresAt - Date.now()));
    $('owner-name').value = '';
  } catch (err) { feedback('owner-feedback', err.message, 'error'); }
  finally { ownerWorking = false; renderSetup(); }
}
function renderSetup() {
  const cloud = publicCloud();
  const canSave = !desktopPreview && setupSnapshot?.canSave === true;
  const model = setupSnapshot?.model;
  const qq = setupSnapshot?.qq;
  const modelConfigured = model?.configured ?? state?.services.model === 'configured';
  const qqConfigured = qq?.configured ?? Boolean(state?.services.qq?.configured);
  const qqVerified = qqConfigured && Boolean(state?.services.qq?.verified);
  const onebotConfigured = Boolean(state?.services.onebot?.configured);
  const ownerReady = ownerSnapshot?.bound && (ownerSnapshot.owner?.transport === 'onebot' ? onebotConfigured : qqVerified);
  badge('step-cloud-status', cloud ? '已连接' : '未连接', cloud ? 'success' : 'neutral');
  badge('step-model-status', model?.needsRecovery ? '需重新填写' : modelConfigured ? '已就绪' : cloud ? '待填写' : '待连接', modelConfigured ? 'success' : 'neutral');
  badge('qq-status', ownerReady ? '已就绪' : qq?.needsRecovery ? '需重新填写' : qqVerified || onebotConfigured ? '待认领' : qqConfigured ? '待填写回调' : cloud ? '待填写' : '待连接', ownerReady ? 'success' : 'neutral');
  $('setup-cloud-note').textContent = cloud ? '已连接到宇伴云端。接下来选一个 AI。' : '你现在可以离线试用。想在 QQ 里使用，需要先连接云端。';
  $('setup-model-note').textContent = model?.needsRecovery ? '云端口令已变更。请重新填入 AI 密钥。'
    : modelConfigured ? `当前模型：${model?.model || state?.services.modelId || '已配置'}。需要更换时再填写新密钥。`
    : canSave ? '选择已有账号的服务商。验证时只会请求一条很短的回复。'
    : cloud && setupLoaded ? '暂时无法在向导保存。请让部署者启用云端设置。' : '连接云端后可以在这里验证并保存模型。';
  $('setup-qq-note').textContent = qq?.needsRecovery ? '云端口令已变更。请重新填入机器人资料。'
    : qqVerified ? (ownerReady ? 'QQ 回调已验证，主人已认领。' : 'QQ 回调已验证。接下来在下面认领主人。')
    : qqConfigured ? '机器人资料已保存。请把回调地址填到 QQ 开放平台。'
    : onebotConfigured ? '已配置 OneBot。用 QQ 私聊完成主人认领即可。'
    : '在 QQ 开放平台创建机器人后，复制它的 AppID 和 ClientSecret。';
  $('setup-model-fields').disabled = !canSave || setupWorking;
  $('setup-qq-fields').disabled = !canSave || setupWorking;
  $('setup-callback').hidden = !cloud || !qqConfigured;
  $('qq-note').textContent = qqVerified ? 'QQ 已验证回调地址。请确认开启了单聊消息，再生成认领码。'
    : '复制地址，填到 QQ 开放平台的「事件订阅」，开启单聊消息。';
  renderOwner(qqConfigured || onebotConfigured);
  $('setup-finished').hidden = !cloud || !modelConfigured || !ownerReady;
  if (!setupAutoOpened && state && (desktopPreview || setupLoaded)) {
    setupAutoOpened = true;
    openSetupStep(!cloud ? 'step-cloud' : !modelConfigured ? 'step-model' : !ownerReady ? 'step-qq' : '');
  }
}
async function loadSetup() {
  if (desktopPreview || setupWorking) return;
  const id = ++setupRequestId;
  const [result] = await Promise.allSettled([request('/api/setup'), loadOwner()]);
  if (id !== setupRequestId) return;
  setupLoaded = true;
  if (result.status === 'fulfilled' && result.value) setupSnapshot = result.value;
  renderSetup();
}
async function saveSetup(kind, payload) {
  if (setupWorking || setupSnapshot?.canSave !== true) return;
  setupWorking = true;
  ++setupRequestId;
  renderSetup();
  const target = `setup-${kind}-feedback`;
  feedback(target, '正在验证…');
  try {
    setupSnapshot = await request(`/api/setup/${kind}`, 'POST', payload);
    $(`setup-${kind === 'model' ? 'model-key' : 'qq-secret'}`).value = '';
    feedback(target, '验证通过，已保存。', 'success');
    renderSetup();
    if (kind === 'model') {
      toast('AI 验证通过，接下来连接 QQ');
      openSetupStep('step-qq', true);
    } else {
      ownerSnapshot = undefined;
      ownerClaim = undefined;
      clearTimeout(ownerExpiryTimer);
      ++ownerRequestId;
      renderSetup();
      void loadOwner();
      $('setup-callback').scrollIntoView({ block: 'nearest' });
    }
    await refresh();
  } catch (err) { feedback(target, err.message, 'error'); }
  finally { setupWorking = false; renderSetup(); }
}
function clearImportPreview() {
  importedPersona = null;
  $('apply-dsh-import').textContent = '预览';
  $('dsh-memory-preview').hidden = true;
  $('dsh-memory-candidates').replaceChildren();
  $('dsh-memory-commands').textContent = '';
  $('copy-memory-commands').disabled = true;
  feedback('dsh-import-result', '');
}
function openImport(mode) {
  importMode = mode;
  $('dsh-import-file').value = '';
  $('dsh-import-text').value = '';
  clearImportPreview();
  $('dsh-import-title').textContent = mode === 'persona' ? '导入人设' : '挑选相处记忆';
  $('dsh-import-help').textContent = mode === 'persona'
    ? '选择 AGENT.md 或 SOUL.md，或粘贴想保留的段落。预览后才会填到人设编辑框。'
    : '选择 memory_summary.md、MEMORY.md 或粘贴摘要。内容只在这里预览，不会自动写入聊天。';
  $('dsh-import-dialog').showModal();
}
function previewImport() {
  if (typeof DSH_PORTABLE === 'undefined') return;
  if (importMode === 'persona' && importedPersona) {
    $('companion-persona').value = importedPersona;
    companionDirty = true;
    renderCompanion();
    $('dsh-import-dialog').close();
    $('companion-persona').focus();
    toast('已填入编辑框，确认后保存人设');
    return;
  }
  const source = $('dsh-import-text').value;
  if (!source.trim()) return feedback('dsh-import-result', '请先选择文件或粘贴内容。', 'error');
  if (importMode === 'persona') {
    const result = DSH_PORTABLE.parsePersona(source);
    if (!result.text) return feedback('dsh-import-result', '没有可导入的文字。', 'error');
    importedPersona = result.text;
    $('dsh-import-text').value = result.text;
    $('apply-dsh-import').textContent = '填入人设';
    feedback('dsh-import-result', result.truncated
      ? `原文 ${result.originalLength} 字，预览仅保留前 1000 字。可以编辑后再预览。`
      : '请核对上面的预览。填入后仍需按「保存人设与记忆设置」。');
    return;
  }
  const result = DSH_PORTABLE.parseMemory(source);
  if (!result.candidates.length) return feedback('dsh-import-result', '没有找到可选的简短记忆。可以粘贴几行日常偏好重试。', 'error');
  const fields = $('dsh-memory-candidates');
  const choices = [];
  const update = () => {
    const commands = choices.filter(([check]) => check.checked).map(([, item]) => item.command);
    $('dsh-memory-commands').textContent = commands.join('\n');
    $('copy-memory-commands').disabled = !commands.length;
  };
  fields.replaceChildren();
  for (const item of result.candidates) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    const text = document.createElement('span');
    input.type = 'checkbox';
    text.textContent = item.text;
    label.append(input, text);
    fields.append(label);
    choices.push([input, item]);
    input.addEventListener('change', update);
  }
  $('dsh-memory-preview').hidden = false;
  update();
  feedback('dsh-import-result', `找到 ${result.candidates.length} 条可选记忆。${result.skipped || result.capped ? '较长、重复或含隐私风险的内容已跳过，仍请检查每一条。' : '请确认你愿意把它们保留在自己的 QQ 对话里。'}`);
}
function activeRoute() {
  const key = location.hash.slice(1);
  if (key === 'overview-qq') return 'overview';
  if (key !== 'admin' && (key !== 'feedback' || isMember()) && Object.hasOwn(routes, key)) return key;
  return location.pathname === '/admin' && (!state || isAdmin()) ? 'admin' : 'overview';
}
function navigate() {
  const current = activeRoute();
  for (const name of Object.keys(routes)) $(name).hidden = current !== name;
  for (const link of document.querySelectorAll('[data-route]')) {
    if (link.dataset.route === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('breadcrumb').textContent = routes[current];
  window.scrollTo(0, 0);
  if (location.hash === '#overview-qq') {
    setupAutoOpened = true;
    openSetupStep('step-qq', true);
    $('step-qq').querySelector('summary')?.focus({ preventScroll: true });
  }
  if (current !== 'admin') {
    ++adminRequestId;
    ++adminFeedbackRequestId;
    adminFeedbackPage.offset = 0;
    if ($('disable-member-dialog').open) $('disable-member-dialog').close();
  }
  if (current !== 'usage') ++usageRequestId;
  if (current === 'admin') return void loadAdmin();
  if (current === 'usage') return void loadUsage();
  if (!state || ['activity', 'ai', 'persona', 'overview'].includes(current)) void refresh();
}
async function request(path, method = 'GET', body) {
  if (macPreview) {
    const bridge = window.webkit?.messageHandlers?.yubanPreview;
    if (!bridge) throw new Error('无法连接离线预览');
    return await bridge.postMessage({ path, method, ...(body !== undefined ? { body } : {}) });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const headers = new Headers();
  const username = accountUsername();
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (username) headers.set('X-Yuban-Account', encodeURIComponent(username));
  try {
    const response = await fetch(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (!desktopPreview && response.status === 401 && response.headers.get('X-Yuban-Login') === '1') {
      goToLogin();
      throw new Error('登录已过期，请重新登录。');
    }
    if (path === '/api/auth/logout' && response.ok) return;
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(result?.error || '服务暂不可用');
      error.status = response.status;
      throw error;
    }
    if (!result) throw new Error('暂时无法读取服务状态');
    return result;
  } finally { clearTimeout(timeout); }
}
function goToLogin() {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  document.body.hidden = true;
  location.replace('/login');
}
const isUsageCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isUsageDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
function hasUsageTokens(counters) {
  // A failed request can still return valid Token counts without being in `reported`.
  return ['reported', 'inputTokens', 'outputTokens', 'totalTokens'].some((key) => isUsageCount(counters?.[key]) && counters[key] > 0);
}
function usageValue(counters, key) {
  const value = counters?.[key];
  return isUsageCount(value) && (!key.endsWith('Tokens') || hasUsageTokens(counters)) ? usageFormatter.format(value) : '—';
}
function showDashboardStatus(id, message, tone = 'neutral') {
  const notice = $(id);
  notice.textContent = message;
  notice.dataset.tone = tone;
  notice.classList.toggle('usage-live-only', tone === 'ready');
}
function adminTimestamp(value) {
  return isUsageCount(value) && value <= 8_640_000_000_000_000 ? adminDate.format(value) : '未记录';
}
function renderAdminSummary({ registrationVerification, memberCount, accountLimit, qqConfigured, disabledCount }) {
  if (typeof registrationVerification !== 'boolean' || typeof qqConfigured !== 'boolean'
    || !isUsageCount(memberCount) || !isUsageCount(accountLimit)) throw new Error('管理状态格式无效');
  badge('admin-verification', registrationVerification ? '已开启' : '未开启', registrationVerification ? 'success' : 'neutral');
  $('admin-members').textContent = `${usageFormatter.format(memberCount)} 个`;
  $('admin-disabled-count').textContent = isUsageCount(disabledCount) ? `已禁用 ${usageFormatter.format(disabledCount)} 个` : '禁用数未记录';
  $('admin-account-limit').textContent = `最多 ${usageFormatter.format(accountLimit)} 个成员`;
  badge('admin-qq-status', qqConfigured ? '已配置' : '未配置', qqConfigured ? 'success' : 'neutral');
  $('admin-summary').hidden = false;
  showDashboardStatus('admin-status', '管理状态已更新。', 'ready');
}
function renderAdminUsers({ users }) {
  if (!Array.isArray(users)) throw new Error('账号列表格式无效');
  const rows = users.filter((user) => user?.role === 'admin' || user?.role === 'member');
  $('admin-users-list').replaceChildren(...rows.map((user) => {
    const row = document.createElement('li');
    row.className = 'admin-member-row';
    const identity = document.createElement('div');
    const name = document.createElement('strong');
    const time = document.createElement('small');
    name.textContent = user.username || '未记录';
    const disabled = user.disabledAt != null;
    time.textContent = `注册 ${adminTimestamp(user.createdAt)}${disabled ? ` · 禁用 ${adminTimestamp(user.disabledAt)}` : ''}`;
    identity.append(name, time);
    const actions = document.createElement('div');
    actions.className = 'admin-member-actions';
    const status = document.createElement('span');
    status.className = `badge ${disabled ? 'warning' : 'neutral'}`;
    status.textContent = user.role === 'admin' ? '管理员' : disabled ? '已禁用' : '正常';
    actions.append(status);
    if (user.role === 'member' && typeof user.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(user.id) && user.username) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button subtle';
      button.textContent = disabled ? '解除禁用' : '禁用';
      button.setAttribute('aria-label', `${button.textContent} ${user.username}`);
      button.disabled = updatingAdminUser;
      button.addEventListener('click', () => {
        if (disabled) void updateAdminUser(user, false);
        else if (isAdmin() && activeRoute() === 'admin' && !updatingAdminUser) {
          userToDisable = user;
          $('disable-member-message').textContent = `禁用「${user.username}」后，此账号将无法登录。你可以随时解除禁用。`;
          $('disable-member-dialog').showModal();
        }
      });
      actions.append(button);
    }
    row.append(identity, actions);
    return row;
  }));
  showDashboardStatus('admin-users-status', rows.length ? '账号列表已更新。' : '暂无账号记录。', rows.length ? 'ready' : 'neutral');
}
function renderAdminFeedback({ items, total, offset, limit }) {
  if (!Array.isArray(items) || !isUsageCount(total) || !isUsageCount(offset) || !isUsageCount(limit) || !limit) throw new Error('反馈列表格式无效');
  adminFeedbackPage = { offset, limit };
  $('admin-feedback-list').replaceChildren(...items.map((item) => {
    const row = document.createElement('li');
    row.className = 'admin-feedback-entry';
    const title = document.createElement('h3');
    title.textContent = item.title || '未记录';
    const byline = document.createElement('small');
    byline.textContent = `${item.username || '未记录'} · ${adminTimestamp(item.createdAt)}`;
    const message = document.createElement('p');
    message.textContent = item.message || '未记录';
    row.append(title, byline, message);
    return row;
  }));
  $('admin-feedback-total').textContent = `共 ${usageFormatter.format(total)} 条`;
  $('admin-feedback-total').hidden = false;
  $('admin-feedback-pages').hidden = offset === 0 && total <= limit;
  $('admin-feedback-range').textContent = items.length ? `第 ${offset + 1}–${offset + items.length} 条` : '';
  $('admin-feedback-prev').disabled = offset === 0;
  $('admin-feedback-next').disabled = offset + limit >= total;
  showDashboardStatus('admin-feedback-status', items.length ? '反馈已更新。' : total ? '这页没有反馈。' : '暂无问题反馈。', items.length ? 'ready' : 'neutral');
}
async function loadAdminPanel(path, status, renderPanel, current) {
  try {
    const payload = await request(path);
    if (current()) renderPanel(payload);
  } catch (error) {
    if (current()) showDashboardStatus(status, error.status === 403
      ? '当前账号没有此管理权限。' : '暂时无法读取，请刷新重试。', 'error');
  }
}
async function loadAdminFeedback(offset) {
  if (!isAdmin() || activeRoute() !== 'admin' || redirectingToLogin) return;
  const id = ++adminFeedbackRequestId;
  const username = accountUsername();
  const current = () => id === adminFeedbackRequestId && activeRoute() === 'admin'
    && !redirectingToLogin && isAdmin() && accountUsername() === username;
  adminFeedbackPage.offset = offset;
  $('admin-feedback-list').replaceChildren();
  $('admin-feedback-total').hidden = true;
  $('admin-feedback-pages').hidden = true;
  showDashboardStatus('admin-feedback-status', '正在读取反馈…');
  await loadAdminPanel(`/api/admin/feedback?offset=${offset}`, 'admin-feedback-status', renderAdminFeedback, current);
}
async function loadAdmin() {
  if (activeRoute() !== 'admin' || redirectingToLogin) return;
  const id = ++adminRequestId;
  const current = () => id === adminRequestId && activeRoute() === 'admin' && !redirectingToLogin;
  $('admin-summary').hidden = true;
  $('admin-refresh').disabled = true;
  showDashboardStatus('admin-status', '正在读取管理状态…');
  try {
    if (!state) {
      const initial = await request('/api/state');
      if (!current()) return;
      render(initial);
    }
    if (!current() || !isAdmin()) return;
    const username = accountUsername();
    const authorized = () => current() && isAdmin() && accountUsername() === username;
    $('admin-users-panel').hidden = false;
    $('admin-feedback-panel').hidden = false;
    $('admin-users-list').replaceChildren();
    showDashboardStatus('admin-users-status', '正在读取账号列表…');
    await Promise.all([
      loadAdminPanel('/api/admin/status', 'admin-status', renderAdminSummary, authorized),
      loadAdminPanel('/api/admin/users', 'admin-users-status', renderAdminUsers, authorized),
      loadAdminFeedback(adminFeedbackPage.offset),
    ]);
  } catch (error) {
    if (current()) showDashboardStatus('admin-status', error.status === 403
      ? '当前账号无法打开管理后台。' : '暂时无法读取管理状态，请重试。', 'error');
  } finally {
    if (current()) $('admin-refresh').disabled = false;
  }
}
async function updateAdminUser(user, disabled) {
  if (updatingAdminUser || !isAdmin() || activeRoute() !== 'admin') return;
  const username = accountUsername();
  const current = () => isAdmin() && accountUsername() === username && activeRoute() === 'admin' && !redirectingToLogin;
  updatingAdminUser = true;
  for (const button of $('admin-users-list').querySelectorAll('button')) button.disabled = true;
  showDashboardStatus('admin-users-status', disabled ? '正在禁用账号…' : '正在解除禁用…');
  try {
    await request(`/api/admin/users/${encodeURIComponent(user.id)}`, 'PATCH', { disabled });
    if (!current()) return;
    toast(disabled ? '成员账号已禁用。' : '已解除成员账号的禁用。');
    await loadAdmin();
  } catch (error) {
    if (current()) showDashboardStatus('admin-users-status', error.message || '暂时无法更新账号，请重试。', 'error');
  } finally {
    updatingAdminUser = false;
    for (const button of $('admin-users-list').querySelectorAll('button')) button.disabled = false;
  }
}
async function submitMemberFeedback(event) {
  event.preventDefault();
  const submit = $('submit-feedback');
  if (!isMember() || activeRoute() !== 'feedback' || submit.disabled) return;
  const form = event.currentTarget;
  const title = $('feedback-title').value.trim();
  const message = $('feedback-message').value.trim();
  if (title.length < 3 || title.length > 80) {
    feedback('member-feedback-status', '标题需为 3 至 80 个字符。', 'error');
    $('feedback-title').focus();
    return;
  }
  if (message.length < 8 || message.length > 2000) {
    feedback('member-feedback-status', '问题描述需为 8 至 2000 个字符。', 'error');
    $('feedback-message').focus();
    return;
  }
  const username = accountUsername();
  submit.disabled = true;
  submit.textContent = '正在发送…';
  feedback('member-feedback-status', '');
  try {
    await request('/api/feedback', 'POST', { title, message });
    if (!isMember() || accountUsername() !== username || redirectingToLogin) return;
    form.reset();
    feedback('member-feedback-status', '反馈已发送。', 'success');
  } catch (error) {
    if (!redirectingToLogin) feedback('member-feedback-status', error.message || '暂时无法发送，请重试。', 'error');
  } finally {
    submit.disabled = false;
    submit.textContent = '发送反馈';
  }
}
function renderUsagePeriod(id, counters) {
  $(id).replaceChildren(...usageMetrics.map(([key, label]) => {
    const item = document.createElement('div');
    const name = document.createElement('dt');
    const value = document.createElement('dd');
    name.textContent = label;
    value.textContent = usageValue(counters, key);
    item.append(name, value);
    return item;
  }));
}
function usageRow(label, counters, { date, provider } = {}) {
  const row = document.createElement('tr');
  const heading = document.createElement('th');
  heading.scope = 'row';
  if (date) {
    const time = document.createElement('time');
    time.dateTime = date;
    time.textContent = label;
    heading.append(time);
  } else {
    heading.textContent = label;
    if (provider) {
      const name = document.createElement('small');
      name.textContent = provider;
      heading.append(name);
    }
  }
  row.append(heading);
  const values = [
    ['totalTokens', `输入 ${usageValue(counters, 'inputTokens')} · 输出 ${usageValue(counters, 'outputTokens')}`],
    ['requests', `失败 ${usageValue(counters, 'failed')} · 未报用量 ${usageValue(counters, 'unreported')}`],
  ];
  for (const [key, breakdown] of values) {
    const cell = document.createElement('td');
    const detail = document.createElement('small');
    cell.textContent = usageValue(counters, key);
    detail.textContent = breakdown;
    cell.append(detail);
    row.append(cell);
  }
  return row;
}
function renderUsage(snapshot) {
  const { today, last30Days, byDay, byModel, current, trackingSince } = snapshot;
  if (!isUsageCount(today?.requests) || !isUsageCount(last30Days?.requests) || !Array.isArray(byDay) || !Array.isArray(byModel)) {
    throw new Error('无法读取用量记录');
  }
  const model = typeof current?.model === 'string' ? current.model : '';
  const providerName = usageProviders.get(current?.provider);
  $('usage-current-model').textContent = model || '未配置模型';
  $('usage-current-provider').textContent = [providerName, current?.configured === false && model ? '模型未就绪' : ''].filter(Boolean).join(' · ');
  const keyStatus = current?.hasApiKey === true ? 'API 密钥已配置' : current?.hasApiKey === false ? 'API 密钥未配置' : 'API 密钥状态未知';
  badge('usage-key', keyStatus, current?.hasApiKey === true ? 'success' : 'neutral');
  renderUsagePeriod('usage-today', today);
  renderUsagePeriod('usage-month', last30Days);
  $('usage-since').textContent = isUsageDate(trackingSince) ? ` 最早记录 ${trackingSince}。` : '';
  const days = byDay.filter((day) => isUsageDate(day?.date)).slice(-7).reverse();
  $('usage-day-rows').replaceChildren(...days.map((day) => usageRow(day.date, day, { date: day.date })));
  $('usage-days').hidden = !last30Days.requests || !days.length;
  const models = byModel.filter((entry) => typeof entry?.model === 'string' && entry.model).slice(0, 17);
  $('usage-model-rows').replaceChildren(...models.map((entry) => entry.model === '(other-models)' && entry.provider === 'other'
    ? usageRow('其他模型（合计）', entry)
    : usageRow(entry.model, entry, { provider: usageProviders.get(entry.provider) })));
  $('usage-models').hidden = !models.length;
  $('usage-results').hidden = false;
  if (!last30Days.requests) showDashboardStatus('usage-status', '近 30 天还没有模型请求记录。');
  else if (!hasUsageTokens(last30Days)) showDashboardStatus('usage-status', '已有模型请求，暂未取得服务商返回的 Token 数量。');
  else showDashboardStatus('usage-status', '用量已更新。', 'ready');
}
async function loadUsage() {
  if (activeRoute() !== 'usage' || redirectingToLogin) return;
  const requestId = ++usageRequestId;
  const stillCurrent = () => requestId === usageRequestId && activeRoute() === 'usage' && !redirectingToLogin;
  $('usage-results').hidden = true;
  $('usage-refresh').disabled = true;
  if (desktopPreview) {
    showDashboardStatus('usage-status', '连接宇伴云端后可查看用量。');
    return;
  }
  showDashboardStatus('usage-status', '正在读取用量…');
  try {
    if (!state) {
      const initial = await request('/api/state');
      if (!stillCurrent()) return;
      render(initial);
    }
    const account = accountUsername();
    const snapshot = await request('/api/usage');
    if (stillCurrent() && accountUsername() === account) renderUsage(snapshot);
  } catch (error) {
    if (!stillCurrent()) return;
    if ([404, 405, 501].includes(error.status)) showDashboardStatus('usage-status', '此部署尚未提供用量看板。');
    else showDashboardStatus('usage-status', '暂时无法读取用量，请重试。', 'error');
  } finally {
    if (stillCurrent()) $('usage-refresh').disabled = false;
  }
}
function delayLabel(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}
function renderLogs(logs) {
  const root = $('logs');
  root.replaceChildren();
  if (!logs?.length) {
    const box = document.createElement('div');
    const title = document.createElement('strong');
    const copy = document.createElement('span');
    box.className = 'empty';
    title.textContent = '还没有运行记录';
    copy.textContent = '接入 QQ 或执行一次中转测试后，结果会显示在这里。';
    box.append(icon('clipboard'), title, copy);
    root.append(box);
    return;
  }
  for (const log of logs) {
    const row = document.createElement('div');
    const at = document.createElement('time');
    const item = document.createElement('div');
    const title = document.createElement('strong');
    const detail = document.createElement('span');
    const label = document.createElement('span');
    row.className = 'log-row';
    const stamp = new Date(log.at);
    if (!Number.isNaN(stamp.valueOf())) {
      at.dateTime = stamp.toISOString();
      at.textContent = time.format(stamp);
    }
    const via = { qq: 'QQ 官方', onebot: 'OneBot', demo: '中转服务' }[log.transport] || '中转服务';
    const kind = { reply: '回复', greeting: '主动问候', check: '测试', plugin: '插件' }[log.kind] || '回调';
    title.textContent = `${via} · ${kind}`;
    detail.textContent = log.detail;
    label.textContent = log.status === 'ok' ? '成功' : '失败';
    label.className = `badge ${log.status === 'ok' ? 'success' : 'error'}`;
    item.append(title, detail);
    row.append(at, item, label);
    root.append(row);
  }
}
function syncQuiet() {
  field('quietStart').disabled = !field('quietEnabled').checked;
  field('quietEnd').disabled = !field('quietEnabled').checked;
}
function render(next) {
  if (redirectingToLogin) return;
  const previousRoute = activeRoute();
  const account = accountUsername(next);
  const previousAccount = accountUsername();
  if (previousAccount && account !== previousAccount) return goToLogin();
  state = next;
  const { settings, services, logs } = next;
  const cloud = publicCloud();
  const admin = isAdmin(next);
  const member = isMember(next);
  document.body.toggleAttribute('data-admin', admin);
  document.body.toggleAttribute('data-member', member);
  $('admin-nav').hidden = !admin;
  $('member-feedback-nav').hidden = !member;
  $('account-role').hidden = !admin;
  $('active-account').hidden = !account;
  $('active-account').textContent = account;
  $('active-account').title = account ? `当前账号：${account}` : '';
  $('logout').hidden = !account;
  $('environment').lastChild.textContent = cloud ? '云端控制台' : desktopPreview ? '离线预览' : '本地预览';
  $('sidebar-status').textContent = cloud ? '云端服务' : '控制台';
  $('health-text').textContent = cloud ? '云端服务已响应' : desktopPreview ? '离线模式 · 未连接云端' : '本地服务已响应';
  const qqURL = endpointURL('qqWebhook');
  $('qq-url').textContent = qqURL || '回调地址暂未提供';
  $('qq-url').title = qqURL;
  $('copy-webhook').disabled = !qqURL;
  renderSetup();
  badge('onebot-status', services.onebot?.configured ? (services.onebot.verified ? '已验证' : '等待回调') : '待配置', services.onebot?.verified ? 'success' : 'neutral');
  badge('model-status', services.model === 'configured' ? '已配置' : desktopPreview ? '待连接' : '演示回复', services.model === 'configured' ? 'success' : 'neutral');
  const modelConfigured = services.model === 'configured';
  const aiEnabled = services.aiApi === true;
  badge('ai-model-status', modelConfigured ? '已配置' : desktopPreview ? '待连接云端' : '待配置', modelConfigured ? 'success' : 'neutral');
  $('active-model').textContent = modelConfigured
    ? `当前配置：${services.modelId || '自定义模型'}。选择下方条目可查看接入方式。`
    : desktopPreview ? '下面是可接入的模型示例，连接云端后会显示当前配置。' : '尚未配置模型。选择一个模型查看接入方式。';
  renderCompanion();
  const dshConfigured = services.dsh?.configured === true;
  badge('dsh-status', desktopPreview ? '待连接云端' : dshConfigured ? '已配置' : '未启用', dshConfigured ? 'success' : 'neutral');
  const dshTools = Array.isArray(services.dsh?.tools) ? services.dsh.tools : [];
  $('dsh-tools').hidden = !dshConfigured || !dshTools.length;
  $('dsh-tools').textContent = `允许的工具：${dshTools.join('、')}`;
  renderDshPlan();
  const scoped = !desktopPreview && next.endpoints !== undefined;
  const gptURL = endpointURL('gptSchema');
  const gptAvailable = !scoped || Boolean(gptURL);
  const gptEnabled = Boolean(gptURL) && cloud && services.gptAction === true && location.protocol === 'https:';
  badge('gpt-actions-status', !gptAvailable ? '此账号未开放' : gptEnabled ? '已启用' : desktopPreview ? '待连接云端' : '未启用', gptEnabled ? 'success' : 'neutral');
  const schemaURL = gptEnabled ? gptURL : '';
  $('gpt-actions-steps').hidden = !gptAvailable;
  $('gpt-schema-url').title = schemaURL;
  $('gpt-schema-url').textContent = schemaURL || '连接云端并启用后显示';
  $('copy-gpt-schema').disabled = !schemaURL;
  const aiURL = endpointURL('aiReply');
  const aiAvailable = !scoped || Boolean(aiURL);
  badge('ai-api-status', !aiAvailable ? '此账号未开放' : desktopPreview ? '待连接云端' : aiEnabled ? '已启用' : '尚未启用', aiAvailable && aiEnabled && !desktopPreview ? 'success' : 'neutral');
  showAIAddress(scoped || cloud || aiEnabled ? aiURL : '', aiAvailable);
  badge('search-status', ({ wikipedia: '维基百科', brave: '网页搜索', configured: '已配置' })[services.search] || '待配置', services.search === 'none' ? 'neutral' : 'success');
  const voice = ({ remote: '已配置', macos: '本机语音' })[services.voice];
  badge('voice-status', voice || '待配置', voice ? 'success' : 'neutral');
  $('quick-greet').setAttribute('aria-checked', String(settings.enabled));
  $('quick-greet').disabled = false;
  $('greet-summary').textContent = settings.enabled ? `${delayLabel(settings.afterMinutes)}未回复后问候` : '主动问候已暂停';
  $('opted-in').textContent = `已开启问候的 QQ 好友：${next.stats?.optedIn ?? 0}`;
  if (!dirty) {
    for (const name of Object.keys(fields)) {
      const input = field(name);
      if (input.type === 'checkbox') input.checked = settings[name];
      else input.value = settings[name];
    }
    syncQuiet();
  }
  renderLogs(logs);
  if (previousRoute !== activeRoute()) navigate();
}
async function refresh(show = false) {
  try {
    render(await request('/api/state'));
    if (activeRoute() === 'overview') void loadSetup();
    if (show) toast('运行记录已刷新');
  }
  catch (err) {
    $('health-text').textContent = '暂时无法连接中转服务';
    if (!state) {
      badge('ai-model-status', '待连接');
      badge('ai-api-status', '待连接');
    }
    if (show) toast(err.message);
  }
}

if (desktopPreview) {
  $('check').firstChild.textContent = '测试离线预览 ';
  $('ai-preview-note').hidden = false;
}
showAIAddress('', desktopPreview);
$('logout').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (button.hidden || button.disabled) return;
  button.disabled = true;
  button.textContent = '正在退出…';
  try {
    await request('/api/auth/logout', 'POST', {});
    goToLogin();
  } catch (err) {
    if (!redirectingToLogin) toast(err.message);
  } finally {
    if (!redirectingToLogin) {
      button.disabled = false;
      button.textContent = '退出登录';
    }
  }
});
$('copy-webhook').addEventListener('click', () => copyAddress('qq-url', location.protocol === 'https:' ? '已复制回调地址' : '已复制本地地址；QQ 接入需要公网 HTTPS'));
$('copy-ai-url').addEventListener('click', () => copyAddress('ai-url', '已复制 AI 接口地址'));
$('copy-gpt-schema').addEventListener('click', () => copyCodeBlock('gpt-schema-url', '已复制 GPT 架构网址'));
$('copy-model').addEventListener('click', () => copyCodeBlock('model-config', '已复制模型配置'));
$('copy-dsh-plan').addEventListener('click', () => copyCodeBlock('dsh-plan-text', '已复制安装清单'));
$('companion-settings').addEventListener('input', () => {
  companionDirty = true;
  renderCompanion();
});
$('companion-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const choice = currentCompanionConfig();
  if (!state || companionSaving || sameCompanionConfig(choice, savedCompanionConfig())) return;
  companionSaving = true;
  renderCompanion();
  try {
    const next = await request('/api/settings', 'PATCH', choice);
    companionDirty = !sameCompanionConfig(currentCompanionConfig(), choice);
    render(next);
    toast(desktopPreview ? '预览人设已保存在本机' : '人设与记忆设置已保存');
  } catch (err) { toast(err.message); }
  finally { companionSaving = false; renderCompanion(); }
});
$('quick-greet').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { const enabled = !state.settings.enabled; render(await request('/api/settings', 'PATCH', { enabled })); toast(enabled ? '已启用主动问候' : '已暂停主动问候'); }
  catch (err) { toast(err.message); }
  finally { button.disabled = false; }
});
$('settings').addEventListener('input', () => { dirty = true; syncQuiet(); });
$('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  const payload = {};
  for (const name of Object.keys(fields)) {
    const input = field(name);
    payload[name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? input.valueAsNumber : input.value;
  }
  try { const next = await request('/api/settings', 'PATCH', payload); dirty = false; render(next); toast(desktopPreview ? '预览设置已保存在本机' : '问候规则已保存'); }
  catch (err) { toast(err.message); }
  finally { button.disabled = false; }
});
$('check').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { const result = await request('/api/bridge/check', 'POST', {}); render(result.state); toast(desktopPreview ? '离线测试通过，未连接 QQ' : '内部测试通过，未向 QQ 发送消息'); }
  catch (err) { toast(err.message); }
  finally { button.disabled = false; }
});
$('refresh').addEventListener('click', () => refresh(true));
$('setup-connect').addEventListener('click', async () => {
  try { await request('/app/cloud-connection', 'POST'); } catch (err) { toast(err.message); }
});
$('setup-provider').addEventListener('change', renderSetupProvider);
$('setup-model-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const provider = setupSelectedProvider();
  const preset = provider?.models.find(({ model }) => model === $('setup-preset-model').value) ?? provider?.models[0];
  void saveSetup('model', {
    baseUrl: provider?.base ?? $('setup-base').value.trim(),
    model: preset?.model ?? $('setup-model-id').value.trim(),
    apiKey: $('setup-model-key').value.trim(),
  });
});
$('setup-qq-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void saveSetup('qq', { appId: $('setup-qq-id').value.trim(), clientSecret: $('setup-qq-secret').value.trim() });
});
$('setup-refresh-qq').addEventListener('click', async () => {
  await refresh();
  toast(state?.services.qq?.verified ? 'QQ 回调已验证' : '还没有收到 QQ 的验证，请检查开放平台设置');
});
$('owner-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void generateOwnerClaim();
});
$('owner-refresh').addEventListener('click', async () => {
  const current = await loadOwner();
  if (!current) toast('暂时无法读取认领状态');
  else toast(current.expiresAt > Date.now() ? '还没收到这次的认领确认' : current.bound ? '已认领主人' : '还没收到认领确认');
  void refresh();
});
$('copy-owner-command').addEventListener('click', () => {
  if (ownerClaim?.expiresAt > Date.now()) return copyCodeBlock('owner-command', '已复制，到 QQ 私聊粘贴发送');
  renderSetup();
});
$('import-persona').addEventListener('click', () => openImport('persona'));
$('import-memory').addEventListener('click', () => openImport('memory'));
for (const id of ['close-dsh-import', 'cancel-dsh-import']) $(id).addEventListener('click', () => $('dsh-import-dialog').close());
$('dsh-import-dialog').addEventListener('close', () => {
  ++importFileId;
  $('dsh-import-text').value = '';
  $('dsh-import-file').value = '';
  clearImportPreview();
});
$('dsh-import-text').addEventListener('input', () => {
  ++importFileId;
  clearImportPreview();
});
$('dsh-import-file').addEventListener('change', async () => {
  const file = $('dsh-import-file').files[0];
  const id = ++importFileId;
  clearImportPreview();
  if (!file) return;
  if (file.size > 65_536) return feedback('dsh-import-result', '文件太长。请粘贴你要导入的片段。', 'error');
  try {
    const value = await file.text();
    if (id !== importFileId || !$('dsh-import-dialog').open) return;
    if (value.length > 30_000) return feedback('dsh-import-result', '文件太长。请粘贴你要导入的片段。', 'error');
    $('dsh-import-text').value = value;
  } catch { if (id === importFileId) feedback('dsh-import-result', '无法读取文件，可以粘贴文本重试。', 'error'); }
});
$('apply-dsh-import').addEventListener('click', previewImport);
$('copy-memory-commands').addEventListener('click', () => copyCodeBlock('dsh-memory-commands', '已复制选中的记忆命令'));
window.addEventListener('hashchange', navigate);
$('admin-refresh').addEventListener('click', loadAdmin);
$('admin-feedback-prev').addEventListener('click', () => void loadAdminFeedback(Math.max(0, adminFeedbackPage.offset - adminFeedbackPage.limit)));
$('admin-feedback-next').addEventListener('click', () => void loadAdminFeedback(adminFeedbackPage.offset + adminFeedbackPage.limit));
$('cancel-disable-member').addEventListener('click', () => $('disable-member-dialog').close());
$('confirm-disable-member').addEventListener('click', () => {
  const user = userToDisable;
  $('disable-member-dialog').close();
  if (user) void updateAdminUser(user, true);
});
$('disable-member-dialog').addEventListener('close', () => { userToDisable = undefined; });
$('member-feedback-form').addEventListener('submit', submitMemberFeedback);
$('usage-refresh').addEventListener('click', loadUsage);
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !accountUsername()) return;
  const route = activeRoute();
  if (route === 'admin') void loadAdmin();
  if (route === 'usage') void loadUsage();
});
window.addEventListener('pagehide', () => {
  if (accountUsername()) document.body.hidden = true;
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted && accountUsername()) location.reload();
});
initializeSetup();
renderModelCatalog();
buildDshCatalog();
renderCompanion();
renderLogs([]);
navigate();
setInterval(() => {
  const page = activeRoute();
  if (!document.hidden && (page === 'activity' || (page === 'overview' && (ownerSnapshot?.expiresAt > Date.now() || (publicCloud() && state?.services.qq?.configured && !state.services.qq.verified))))) refresh();
}, 15000);
