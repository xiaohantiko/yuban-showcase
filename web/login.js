const $ = (id) => document.getElementById(id);
const forms = {
  login: $('login-form'),
  register: $('register-form'),
  reset: $('reset-form'),
};
const errorNotice = $('auth-error');
const recoveryCode = $('recovery-code');
const recoveryPanel = $('auth-recovery');
const copyStatus = $('copy-status');
const title = $('auth-title');
const description = $('auth-description');
const retry = $('auth-retry');
const setupCode = $('register-setup-code');
const verificationPanel = $('registration-verification');
const verificationMount = $('registration-widget');
const verificationNotice = $('registration-verification-status');
const verificationRetry = $('registration-verification-retry');
const rememberPanel = $('login-remember-panel');
const rememberInput = $('login-remember');
const rememberStatus = $('login-remember-status');
const forgetRetry = $('login-forget-retry');
const hasRememberUI = Boolean(rememberPanel && rememberInput && rememberStatus && forgetRetry);
const loginUsername = forms.login.elements.username;
const loginPassword = forms.login.elements.password;
const loginSubmit = forms.login.querySelector('button[type="submit"]');
const credentialKind = 'yubanLoginCredential';
const views = {
  login: ['登录云端管理台', '使用你的宇伴账号登录。'],
  register: ['注册宇伴账号', '为这个云端管理台创建你的私人账号。'],
  claim: ['认领原有管理台', '使用部署时的云端管理台口令，把原有配置和记忆转到你新建的账号。'],
  reset: ['重设密码', '使用注册时保存的恢复码重设密码。'],
  recovery: ['保存你的恢复码', '忘记密码时需要它。请单独保存，离开此页后将无法再次查看。'],
};
let accountName = '';
let authStatus = {};
let verificationLoader;
let verificationWidget;
let verificationAttempt = 0;
let credentialView = 0;
let credentialLoadStarted = false;
let loginWasEdited = false;
let autofilledUsername = '';
let passwordWasAutofilled = false;
let credentialForget;

function credentialBridge() {
  if (!hasRememberUI || window.self !== window.top || !window.isSecureContext || location.protocol !== 'https:'
    || location.href !== `${location.origin}/login` || typeof crypto.randomUUID !== 'function') return null;
  const mac = window.webkit?.messageHandlers?.[credentialKind];
  if (typeof mac?.postMessage === 'function') return { mac };
  const windows = window.chrome?.webview;
  if (typeof windows?.postMessage === 'function' && typeof windows.addEventListener === 'function'
    && typeof windows.removeEventListener === 'function') return { windows };
  return null;
}

async function nativeCredential(action, fields = {}) {
  const bridge = credentialBridge();
  if (!bridge) return null;
  const id = crypto.randomUUID();
  const message = { kind: credentialKind, id, action, ...fields };
  const matches = (reply) => reply?.kind === credentialKind && reply.id === id && typeof reply.ok === 'boolean';
  return new Promise((resolve) => {
    const finish = (reply) => {
      clearTimeout(timeout);
      bridge.windows?.removeEventListener('message', receive);
      resolve(matches(reply) ? reply : null);
    };
    const receive = ({ data }) => { if (matches(data)) finish(data); };
    const timeout = setTimeout(() => finish(null), 1600);
    try {
      if (bridge.mac) Promise.resolve(bridge.mac.postMessage(message)).then(finish, () => finish(null));
      else {
        bridge.windows.addEventListener('message', receive);
        bridge.windows.postMessage(message);
      }
    } catch { finish(null); }
  });
}

function resetLoginCredentialUI() {
  if (!hasRememberUI) return;
  ++credentialView;
  credentialLoadStarted = false;
  loginWasEdited = false;
  autofilledUsername = '';
  passwordWasAutofilled = false;
  rememberPanel.hidden = true;
  rememberInput.checked = false;
  rememberInput.disabled = false;
  rememberStatus.textContent = '';
  forgetRetry.hidden = true;
}

async function loadLoginCredential() {
  if (credentialLoadStarted || forms.login.hidden || document.hidden || !credentialBridge()) return;
  credentialLoadStarted = true;
  const view = credentialView;
  if (credentialForget) await credentialForget;
  if (view !== credentialView || forms.login.hidden || !credentialBridge()) return;
  const reply = await nativeCredential('load');
  if (view !== credentialView || forms.login.hidden || !credentialBridge()) return;
  if (document.hidden) {
    credentialLoadStarted = false;
    return;
  }
  if (!reply?.ok) return;
  rememberPanel.hidden = false;
  rememberInput.disabled = loginSubmit.disabled || Boolean(credentialForget);
  if (loginWasEdited || loginSubmit.disabled || loginUsername.value || loginPassword.value) return;
  const { username, password } = reply;
  if (typeof username !== 'string' || !username || username.length > 32
    || typeof password !== 'string' || !password || password.length > 128) return;
  loginUsername.value = username;
  loginPassword.value = password;
  autofilledUsername = username;
  passwordWasAutofilled = true;
  rememberInput.checked = true;
}

function loginUsernameEdited() {
  loginWasEdited = true;
  if (!autofilledUsername || loginUsername.value === autofilledUsername) return;
  if (passwordWasAutofilled) loginPassword.value = '';
  autofilledUsername = '';
  passwordWasAutofilled = false;
  rememberInput.checked = false;
}

async function forgetLoginCredential() {
  if (rememberPanel.hidden || credentialForget) return;
  const view = credentialView;
  rememberInput.checked = false;
  rememberInput.disabled = true;
  forgetRetry.hidden = true;
  rememberStatus.textContent = '正在清除此设备上的登录信息…';
  const pending = nativeCredential('forget');
  credentialForget = pending;
  const result = await pending;
  credentialForget = undefined;
  if (credentialView !== view || rememberPanel.hidden) return;
  rememberInput.disabled = loginSubmit.disabled;
  rememberStatus.textContent = result?.ok ? '已清除此设备上的登录信息。' : '无法清除已保存的登录信息，请重试。';
  forgetRetry.hidden = result?.ok === true;
}

function loadVerificationAssets() {
  if (!verificationLoader) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/assets/altcha.css';
    const css = new Promise((resolve, reject) => {
      stylesheet.addEventListener('load', resolve, { once: true });
      stylesheet.addEventListener('error', reject, { once: true });
    });
    document.head.append(stylesheet);
    verificationLoader = Promise.all([css, import('/assets/altcha.js')]).then(async () => {
      await import('/assets/altcha-zh.js');
      globalThis.$altcha.algorithms.set('PBKDF2/SHA-256', () => new Worker('/assets/altcha-worker.js'));
      globalThis.$altcha.defaults.set({
        humanInteractionSignature: false,
        hideFooter: true,
        validationMessage: '请先完成人机验证。',
        formatError: () => '验证失败，请重试。',
      });
    }).catch((error) => {
      stylesheet.remove();
      verificationLoader = undefined;
      throw error;
    });
  }
  return verificationLoader;
}

function clearVerification() {
  ++verificationAttempt;
  const widget = verificationWidget;
  verificationWidget = undefined;
  widget?.reset?.();
  widget?.remove();
  verificationNotice.textContent = '';
  verificationRetry.hidden = true;
}

async function mountVerification(message = '') {
  clearVerification();
  const attempt = verificationAttempt;
  if (!globalThis.isSecureContext) {
    verificationNotice.textContent = '注册验证需要 HTTPS。请使用宇伴的安全连接地址。';
    return;
  }
  verificationNotice.textContent = '正在加载人机验证…';
  try {
    await loadVerificationAssets();
    if (attempt !== verificationAttempt) return;
    const widget = document.createElement('altcha-widget');
    widget.setAttribute('challenge', '/api/auth/register/challenge');
    widget.setAttribute('form', 'register-form');
    widget.setAttribute('language', 'zh-cn');
    widget.setAttribute('name', 'verification');
    widget.setAttribute('type', 'native');
    widget.setAttribute('workers', '2');
    widget.addEventListener('load', () => {
      if (verificationWidget === widget) verificationNotice.textContent = message;
    }, { once: true });
    widget.addEventListener('statechange', (event) => {
      if (verificationWidget !== widget) return;
      const state = event.detail?.state;
      verificationRetry.hidden = state !== 'error' && state !== 'expired';
      verificationNotice.textContent = state === 'error' ? '验证未完成，请重试。'
        : state === 'expired' ? '验证已过期，请重试。' : '';
    });
    verificationWidget = widget;
    verificationMount.append(widget);
  } catch {
    if (attempt !== verificationAttempt) return;
    verificationNotice.textContent = '暂时无法加载人机验证，请重试。';
    verificationRetry.hidden = false;
  }
}

function clearSecrets() {
  for (const form of Object.values(forms)) {
    for (const field of form.querySelectorAll('input[type="password"]')) field.value = '';
  }
  recoveryCode.value = '';
  copyStatus.textContent = '';
}

function showView(view, username = accountName, focus = true) {
  clearSecrets();
  resetLoginCredentialUI();
  errorNotice.textContent = '';
  retry.hidden = true;
  [title.textContent, description.textContent] = views[view];
  const multi = authStatus.multi === true;
  if (view === 'register' && multi) description.textContent = '每个账号都有独立的人设、记忆、QQ 和 AI 配置。';
  $('show-register').hidden = !multi;
  $('show-reset').hidden = authStatus.registered === false;
  $('show-claim').hidden = !multi || authStatus.canClaimLegacy !== true;
  $('register-back').hidden = !multi;
  const needsSetupCode = !multi || view === 'claim';
  $('register-setup-field').hidden = !needsSetupCode;
  setupCode.disabled = !needsSetupCode;
  setupCode.required = needsSetupCode;
  $('setup-code-hint').textContent = view === 'claim'
    ? '这是部署原有管理台时设置的口令。'
    : '使用部署宇伴时设置的口令，只在首次注册时填写。';
  $('register-submit').textContent = view === 'claim' ? '认领并注册' : '注册账号';
  document.title = `${title.textContent} · 宇伴`;
  const formView = view === 'claim' ? 'register' : view;
  for (const [name, form] of Object.entries(forms)) form.hidden = name !== formView;
  recoveryPanel.hidden = view !== 'recovery';
  if (forms[formView]) forms[formView].elements.username.value = username;
  const needsVerification = view === 'register' && multi && authStatus.registrationVerification === true;
  verificationPanel.hidden = !needsVerification;
  if (needsVerification) void mountVerification();
  else clearVerification();
  if (view === 'login') void loadLoginCredential();
  if (focus) title.focus();
}

async function authRequest(action, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(`/api/auth/${action}`, {
      cache: 'no-store',
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== 'object') {
      throw new Error(typeof payload?.error === 'string' ? payload.error : '暂时无法连接宇伴账号服务，请重试。');
    }
    return payload;
  } finally { clearTimeout(timeout); }
}

function showError(error) {
  errorNotice.textContent = error instanceof TypeError || error?.name === 'AbortError'
    ? '连接超时或网络不可用，请重试。'
    : error.message;
}

function openConsole(role) {
  location.replace(role === 'admin' ? '/admin' : '/');
}

async function loadAccount(focus) {
  retry.hidden = true;
  errorNotice.textContent = '';
  description.textContent = '正在检查账号状态…';
  try {
    const status = await authRequest('status');
    if (typeof status.registered !== 'boolean') throw new Error('暂时无法读取账号状态，请重试。');
    if (status.registered && typeof status.username === 'string' && status.username) {
      openConsole(status.role);
      return;
    }
    authStatus = status;
    showView(status.multi === true || status.registered ? 'login' : 'register', accountName, focus);
  } catch (error) {
    description.textContent = '暂时无法读取账号状态。';
    showError(error);
    retry.hidden = false;
    if (focus) retry.focus();
  }
}

for (const [mode, form] of Object.entries(forms)) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const buttons = [...form.querySelectorAll('button')];
    const submit = form.querySelector('button[type="submit"]');
    if (submit.disabled) return;
    if (mode === 'login') loginUsernameEdited();
    errorNotice.textContent = '';
    const data = Object.fromEntries(new FormData(form));
    data.username = data.username.trim();
    if (!data.username) {
      errorNotice.textContent = '请输入用户名。';
      form.elements.username.focus();
      return;
    }
    if (mode !== 'login' && (!/[A-Za-z]/.test(data.password) || !/[0-9]/.test(data.password))) {
      errorNotice.textContent = '密码需至少包含一个英文字母和一个数字。';
      form.elements.password.focus();
      return;
    }
    const needsVerification = mode === 'register' && !verificationPanel.hidden;
    if (needsVerification && (!data.verification || verificationWidget?.getState?.() !== 'verified')) {
      errorNotice.textContent = '请先完成人机验证。';
      if (!verificationRetry.hidden) verificationRetry.focus();
      return;
    }
    if (!needsVerification) delete data.verification;
    const remember = mode === 'login' && hasRememberUI && !rememberPanel.hidden && rememberInput.checked && !rememberInput.disabled;
    const label = submit.textContent;
    submit.textContent = '处理中…';
    for (const button of buttons) button.disabled = true;
    if (mode === 'login' && hasRememberUI) {
      rememberInput.disabled = true;
      loginUsername.readOnly = loginPassword.readOnly = true;
    }
    try {
      const result = await authRequest(mode, data);
      if (mode === 'login') {
        await credentialForget;
        if (remember && rememberInput.checked && typeof result.username === 'string' && result.username) {
          await nativeCredential('save', { username: result.username, password: data.password });
        }
        clearSecrets();
        openConsole(result.role);
      } else {
        if (typeof result.recoveryCode !== 'string' || !result.recoveryCode) throw new Error('服务未返回恢复码，请检查云端部署状态。');
        accountName = typeof result.username === 'string' ? result.username : data.username;
        authStatus.registered = true;
        if (mode === 'register' && data.setupCode && authStatus.multi) authStatus.canClaimLegacy = false;
        showView('recovery');
        recoveryCode.value = result.recoveryCode;
      }
    } catch (error) {
      showError(error);
      if (needsVerification) void mountVerification('请重新完成人机验证。');
    } finally {
      for (const button of buttons) button.disabled = false;
      submit.textContent = label;
      if (mode === 'login' && hasRememberUI) {
        rememberInput.disabled = Boolean(credentialForget);
        loginUsername.readOnly = loginPassword.readOnly = false;
      }
    }
  });
}

retry.addEventListener('click', () => void loadAccount(true));
loginUsername.addEventListener('input', loginUsernameEdited);
loginUsername.addEventListener('change', loginUsernameEdited);
loginPassword.addEventListener('input', () => {
  loginWasEdited = true;
  passwordWasAutofilled = false;
});
if (hasRememberUI) {
  rememberInput.addEventListener('change', () => {
    if (!rememberInput.checked) void forgetLoginCredential();
    else {
      rememberStatus.textContent = '';
      forgetRetry.hidden = true;
    }
  });
  forgetRetry.addEventListener('click', () => void forgetLoginCredential());
}
verificationRetry.addEventListener('click', () => {
  if (verificationWidget) {
    verificationWidget.reset();
    void verificationWidget.verify();
  } else void mountVerification();
});
$('show-register').addEventListener('click', () => showView('register', forms.login.elements.username.value));
$('show-claim').addEventListener('click', () => showView('claim', forms.login.elements.username.value));
$('register-back').addEventListener('click', () => showView('login', forms.register.elements.username.value));
$('show-reset').addEventListener('click', () => showView('reset', forms.login.elements.username.value));
$('back-to-login').addEventListener('click', () => showView('login', forms.reset.elements.username.value));
$('finish-recovery').addEventListener('click', () => showView('login'));
$('copy-recovery-code').addEventListener('click', async () => {
  if (!recoveryCode.value) return;
  try {
    await navigator.clipboard.writeText(recoveryCode.value);
    copyStatus.textContent = '已复制恢复码。';
  } catch {
    if (recoveryPanel.hidden) return;
    recoveryCode.focus();
    recoveryCode.select();
    copyStatus.textContent = '恢复码已选中，可以手动复制。';
  }
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadLoginCredential(); });
window.addEventListener('hashchange', () => {
  if (credentialBridge()) void loadLoginCredential();
  else if (credentialLoadStarted) {
    if (passwordWasAutofilled) loginPassword.value = '';
    resetLoginCredentialUI();
  }
});
window.addEventListener('pagehide', () => { clearSecrets(); clearVerification(); resetLoginCredentialUI(); });
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void loadAccount(false);
});
void loadAccount(false);
