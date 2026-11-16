import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const scryptOptions = { N: 2 ** 14, r: 8, p: 5, maxmem: 32 * 1024 * 1024 };
const sessionSeconds = 8 * 60 * 60;
const maximumSessions = 8;
const attemptWindow = 15 * 60_000;
const maximumAttempts = 64;
const maximumClientAttempts = 8;
const maximumWrites = 8;
const routes = new Map([
  ['/api/auth/status', 'GET'],
  ['/api/auth/register', 'POST'],
  ['/api/auth/login', 'POST'],
  ['/api/auth/reset', 'POST'],
  ['/api/auth/logout', 'POST'],
]);

const random = (size = 32) => randomBytes(size).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('base64url');
const equals = (left, right) => timingSafeEqual(
  createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest(),
);

function usernameOf(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const username = value.trim().normalize('NFC');
  return /^[\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9._-]{1,31}$/u.test(username) ? username : null;
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128
    && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
}

async function passwordDigest(password, salt) {
  const key = await deriveKey(password, Buffer.from(salt, 'base64url'), 32, scryptOptions);
  return key.toString('base64url');
}

function header(headers, name) {
  const value = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
  return typeof value === 'string' ? value : '';
}

const cookieName = (secure) => secure ? '__Host-yuban_console' : 'yuban_console_local';
function cookieToken(headers, secure) {
  const prefix = `${cookieName(secure)}=`;
  const values = header(headers, 'cookie').split(';').map((item) => item.trim()).filter((item) => item.startsWith(prefix));
  if (values.length !== 1) return null;
  const token = values[0].slice(prefix.length);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function cookie(secure, token = '') {
  return `${cookieName(secure)}=${token}; Path=/; Max-Age=${token ? sessionSeconds : 0}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function failure(status, message, headers) {
  return json({ error: message }, status, headers);
}

const invalidLogin = () => failure(401, '用户名或密码有误。');
const invalidRecovery = () => failure(401, '用户名或恢复码有误。');
const invalidCredentials = () => failure(400, '用户名须为 2 至 32 位中文、英文字母、数字或 ._-，密码须为 8 至 128 位并含英文字母和数字。');

function configuredSetupCode(env) {
  const token = env.YUBAN_ADMIN_TOKEN;
  return typeof token === 'string' && /^[\x21-\x7e]{32,256}$/.test(token) ? token : null;
}

async function accountSecrets(password) {
  const salt = random(16);
  const passwordHash = await passwordDigest(password, salt);
  const recoveryCode = random(24);
  return { recoveryCode, record: { salt, passwordHash, recoveryHash: digest(recoveryCode), sessions: [] } };
}

function newSession(secure, now) {
  const token = random();
  return { token, entry: { hash: digest(token), secure, expiresAt: now + sessionSeconds * 1000 } };
}

const addSession = (sessions, entry, now) => [...sessions.filter((session) => session.expiresAt > now).slice(1 - maximumSessions), entry];

export const consoleAuthPrimitives = Object.freeze({
  methodFor: (path) => routes.get(path), usernameOf, validPassword, configuredSetupCode, accountSecrets, passwordDigest, newSession, addSession,
  cookieToken, cookie, header, json, failure, invalidLogin, invalidRecovery, invalidCredentials, digest, equals,
});

export function createConsoleAuth({ env = {}, store, clock = Date.now }) {
  const enabled = env.YUBAN_CONSOLE_ACCOUNTS === '1';
  const setupCode = configuredSetupCode(env);
  const rateSalt = setupCode ?? '';

  async function write(change) {
    for (let retry = 0; retry < maximumWrites; retry++) {
      const previous = await store.read();
      const next = change(previous);
      if (!next) return false;
      if (await store.compareAndSet(previous, { ...next, revision: random(16) })) return true;
    }
    throw Object.assign(new Error('账户状态刚刚变更，请重试。'), { status: 409 });
  }

  async function allowAttempt(path, clientKey, now) {
    const key = digest(`${rateSalt}\0${typeof clientKey === 'string' ? clientKey.slice(0, 200) : ''}`);
    if (typeof store.allowAttempt === 'function') {
      return await store.allowAttempt(`${path}:client:${key}`, now, maximumClientAttempts, attemptWindow)
        && await store.allowAttempt(`${path}:global`, now, maximumAttempts, attemptWindow);
    }
    return write((record) => {
      const recent = (record?.attempts ?? []).filter(({ at }) => at > now - attemptWindow && at <= now);
      const routeAttempts = recent.filter((item) => item.path === path);
      if (routeAttempts.length >= maximumAttempts || routeAttempts.filter((item) => item.key === key).length >= maximumClientAttempts) return null;
      return { ...record, attempts: [...recent, { at: now, key, path }] };
    });
  }

  function activeUsername(record, headers, secure) {
    const token = cookieToken(headers, secure);
    if (!token || !record?.username) return null;
    const hashed = digest(token);
    const now = clock();
    return record.sessions?.some((session) => session.hash === hashed
      && session.secure === secure && session.expiresAt > now) ? record.username : null;
  }

  async function authenticate(headers, { secure = true } = {}) {
    if (!enabled || !cookieToken(headers, secure)) return null;
    return activeUsername(await store.read(), headers, secure);
  }

  async function handle({ path, method, headers, secure = false, loopback = false, sameOrigin = false, readJSON, clientKey }) {
    const requiredMethod = routes.get(path);
    if (!enabled || !requiredMethod) return null;
    if (!secure && !loopback) return failure(403, '请通过 HTTPS 打开宇伴控制台。');
    if (method !== requiredMethod) return failure(405, `请使用 ${requiredMethod} 请求。`, { Allow: requiredMethod });

    if (path === '/api/auth/status') {
      const record = await store.read();
      return json({ registered: Boolean(record?.username), username: activeUsername(record, headers, secure) });
    }
    if (!sameOrigin) return failure(403, '不接受跨站请求。');

    if (path === '/api/auth/logout') {
      const token = cookieToken(headers, secure);
      if (token) {
        const hashed = digest(token);
        await write((record) => record?.sessions?.some((session) => session.hash === hashed && session.secure === secure)
          && { ...record, sessions: record.sessions.filter((session) => session.hash !== hashed) });
      }
      return json({ ok: true }, 200, { 'set-cookie': cookie(secure) });
    }

    if (!/^application\/json(?:\s*;|$)/i.test(header(headers, 'content-type'))) {
      return failure(415, '需要 application/json。');
    }
    const input = await readJSON();
    if (!input || typeof input !== 'object' || Array.isArray(input)) return failure(400, '请求体需要是 JSON 对象。');
    const { password } = input;
    const username = usernameOf(input.username);
    if (!username || !validPassword(password)) {
      if (path === '/api/auth/login') return invalidLogin();
      return invalidCredentials();
    }

    const restricted = () => failure(429, '尝试次数过多，请稍后再试。', { 'Retry-After': String(attemptWindow / 1000) });
    if (!await allowAttempt(path, clientKey, clock())) return restricted();

    if (path === '/api/auth/login') {
      const record = await store.read();
      if (!record?.username) return invalidLogin();
      const hashed = await passwordDigest(password, record.salt);
      if (!equals(record.passwordHash, hashed) || record.username !== username) return invalidLogin();
      const now = clock();
      const { token, entry } = newSession(secure, now);
      const accepted = await write((current) => current?.username === username && current.salt === record.salt
        && current.passwordHash === record.passwordHash && { ...current, sessions: addSession(current.sessions ?? [], entry, now) });
      return accepted ? json({ username }, 200, { 'set-cookie': cookie(secure, token) }) : invalidLogin();
    }

    const registering = path === '/api/auth/register';
    const recoveryCode = typeof input.recoveryCode === 'string' && input.recoveryCode.length <= 64 ? input.recoveryCode.trim() : '';
    const recoveryHash = digest(recoveryCode);
    const authorized = registering
      ? (record) => !record?.username
      : (record) => Boolean(record?.username === username && equals(record.recoveryHash, recoveryHash));
    if (registering) {
      if (!setupCode) return failure(503, '请让部署者先设置至少 32 位随机字符的管理口令。');
      if (typeof input.setupCode !== 'string' || input.setupCode.length > 256 || !equals(input.setupCode.trim(), setupCode)) {
        return failure(401, '初始化口令有误。');
      }
      if (!authorized(await store.read())) return failure(409, '管理员账户已创建。');
    } else if (!/^[A-Za-z0-9_-]{32}$/.test(recoveryCode)
      || !authorized(await store.read())) return invalidRecovery();

    const { recoveryCode: nextRecoveryCode, record: secrets } = await accountSecrets(password);
    const updated = await write((record) => authorized(record) && {
      ...record, username, ...secrets,
    });
    if (!updated) return registering ? failure(409, '管理员账户已创建。') : invalidRecovery();
    return json({ username, recoveryCode: nextRecoveryCode }, registering ? 201 : 200, { 'set-cookie': cookie(secure) });
  }

  return { enabled, authenticate, handle };
}
