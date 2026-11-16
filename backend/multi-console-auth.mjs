import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { consoleAuthPrimitives } from './console-auth.mjs';
import { createRegistrationVerification } from './registration-verification.mjs';

const {
  methodFor, usernameOf, validPassword, configuredSetupCode, accountSecrets, passwordDigest, newSession, addSession,
  cookieToken, cookie, header, json, failure, invalidLogin, invalidRecovery, invalidCredentials, digest, equals,
} = consoleAuthPrimitives;

const accountLimit = 32;
const registrySize = 128 * 1024;
const attemptWindow = 15 * 60_000;
const attemptsPerClient = 8;
const attemptsPerRoute = 64;
const idPattern = /^[a-f0-9]{32}$/;
const hashPattern = /^[A-Za-z0-9_-]{43}$/;
const saltPattern = /^[A-Za-z0-9_-]{22}$/;
const resetPattern = /^[A-Za-z0-9_-]{32}$/;
const registerPath = '/api/auth/register';
const challengePath = `${registerPath}/challenge`;
const usernameKey = (value) => value.toLowerCase();
const newId = () => randomBytes(16).toString('hex');
const publicAccount = ({ id, username, legacy }) => ({ id, username, legacy });
const roleOf = (account) => account.legacy ? 'admin' : 'member';
const userIsEnabled = (account) => Boolean(account && account.disabledAt == null);
const publicUser = (account) => ({ id: account.id, username: account.username, role: roleOf(account),
  createdAt: account.createdAt ?? null, disabledAt: account.disabledAt ?? null });
const validOptionalTime = (value) => value == null || (Number.isSafeInteger(value) && value >= 0);

function validCredentialRecord(record) {
  return typeof record?.username === 'string' && usernameOf(record.username) === record.username
    && typeof record.salt === 'string' && saltPattern.test(record.salt)
    && typeof record.passwordHash === 'string' && hashPattern.test(record.passwordHash)
    && typeof record.recoveryHash === 'string' && hashPattern.test(record.recoveryHash);
}

function validRegistry(value) {
  if (value?.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > accountLimit
    || !Array.isArray(value.attempts) || value.attempts.length > attemptsPerRoute * 3) return false;
  return value.accounts.every((account) => validCredentialRecord(account) && typeof account.id === 'string' && idPattern.test(account.id)
    && typeof account.legacy === 'boolean' && validOptionalTime(account.createdAt) && validOptionalTime(account.disabledAt)
    && (!account.legacy || userIsEnabled(account)) && Array.isArray(account.sessions) && account.sessions.length <= 8
    && account.sessions.every((session) => typeof session?.hash === 'string' && hashPattern.test(session.hash)
      && Number.isSafeInteger(session.expiresAt) && typeof session.secure === 'boolean'))
    && new Set(value.accounts.map(({ id }) => id)).size === value.accounts.length
    && new Set(value.accounts.map(({ username }) => usernameKey(username))).size === value.accounts.length
    && value.accounts.filter(({ legacy }) => legacy).length <= 1
    && value.attempts.every((attempt) => Number.isSafeInteger(attempt?.at) && typeof attempt.key === 'string' && hashPattern.test(attempt.key)
      && ['/api/auth/register', '/api/auth/login', '/api/auth/reset'].includes(attempt.path));
}

function readRegistry(file) {
  try {
    const raw = readFileSync(file);
    if (raw.byteLength > registrySize) throw new Error('账户清单超出大小限制。');
    const registry = JSON.parse(raw);
    if (!validRegistry(registry)) throw new Error('账户清单格式无效。');
    return registry;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeRegistry(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* Keep the original write error. */ }
    throw error;
  }
}

export function createMultiConsoleAuth({ env = {}, stateFile, clock = Date.now, legacyAccount = null }) {
  const file = `${resolve(stateFile)}.accounts.json`;
  const setupCode = configuredSetupCode(env);
  const registrationVerification = env.YUBAN_REGISTRATION_VERIFICATION === '1'
    ? createRegistrationVerification({ secret: setupCode, clock }) : null;
  // A suspend/restore cycle must invalidate password checks already in progress.
  const accessChanges = new Map();
  let registry = readRegistry(file);
  if (!registry) {
    registry = { version: 1, accounts: [], attempts: [] };
    if (legacyAccount?.username !== undefined) {
      if (!validCredentialRecord(legacyAccount)) throw new Error('旧管理员账户无法迁移。');
      const { username, salt, passwordHash, recoveryHash } = legacyAccount;
      registry.accounts.push({ id: newId(), username, salt, passwordHash, recoveryHash, legacy: true, sessions: [] });
      writeRegistry(file, registry);
    }
  }

  // Node owns this registry in one process. The file is replaced before publishing the new in-memory view.
  function commit(next) {
    writeRegistry(file, next);
    registry = next;
  }

  const lookup = (username) => registry.accounts.find((account) => usernameKey(account.username) === usernameKey(username));
  const byId = (id) => registry.accounts.find((account) => account.id === id);
  const hasLegacy = () => registry.accounts.some(({ legacy }) => legacy);
  const canClaimLegacy = () => Boolean(setupCode) && !hasLegacy();

  function replaceAccount(account, updates) {
    commit({ ...registry, accounts: registry.accounts.map((item) => item.id === account.id ? { ...item, ...updates } : item) });
  }

  function setUserDisabled(id, disabled) {
    const account = byId(id);
    if (!account || account.legacy || typeof disabled !== 'boolean') return null;
    const current = publicUser(account);
    if (disabled === (current.disabledAt !== null)) return current;
    const disabledAt = disabled ? clock() : null;
    replaceAccount(account, { disabledAt, sessions: [] });
    accessChanges.set(id, Symbol());
    return { ...current, disabledAt };
  }

  function allowAttempt(path, clientKey) {
    const now = clock();
    const client = typeof clientKey === 'string' ? clientKey.slice(0, 200) : '';
    const key = digest(`${setupCode ?? ''}\0${client}`);
    const recent = registry.attempts.filter(({ at }) => at > now - attemptWindow && at <= now);
    const route = recent.filter((attempt) => attempt.path === path);
    if (route.length >= attemptsPerRoute || route.filter((attempt) => attempt.key === key).length >= attemptsPerClient) return false;
    commit({ ...registry, attempts: [...recent, { at: now, key, path }] });
    return true;
  }

  function sessionOwner(headers, secure) {
    const token = cookieToken(headers, secure);
    if (!token) return null;
    const hash = digest(token);
    const now = clock();
    const account = registry.accounts.find((item) => userIsEnabled(item) && item.sessions.some((session) =>
      session.hash === hash && session.secure === secure && session.expiresAt > now));
    return account ? { account, hash } : null;
  }

  async function authenticate(headers, { secure = true } = {}) {
    const login = sessionOwner(headers, secure);
    return login ? publicAccount(login.account) : null;
  }

  function registrationConflict(username, legacy) {
    if (lookup(username)) return failure(409, '这个用户名已被注册。');
    if (legacy && !canClaimLegacy()) return failure(409, '旧管理台已经认领。');
    const reserved = !legacy && !hasLegacy() ? 1 : 0;
    if (registry.accounts.length >= accountLimit - reserved) return failure(409, '当前部署的账户数量已满。');
    return null;
  }

  async function register(input, username, secure, clientKey) {
    if (input.setupCode !== undefined && (typeof input.setupCode !== 'string' || input.setupCode.length > 256)) {
      return failure(401, '初始化口令有误。');
    }
    const supplied = input.setupCode?.trim() ?? '';
    const legacy = Boolean(supplied);
    if (legacy && (!setupCode || !equals(supplied, setupCode))) return failure(401, '初始化口令有误。');
    if (!legacy && registrationVerification && !await registrationVerification.consume(input.verification, clientKey)) {
      return failure(400, '请先完成人机验证，或重新验证后再试。');
    }
    if (!allowAttempt(registerPath, clientKey)) return failure(429, '尝试次数过多，请稍后再试。', { 'Retry-After': String(attemptWindow / 1000) });
    const initialConflict = registrationConflict(username, legacy);
    if (initialConflict) return initialConflict;
    const { recoveryCode, record } = await accountSecrets(input.password);
    const conflict = registrationConflict(username, legacy);
    if (conflict) return conflict;
    const account = { id: newId(), username, legacy, createdAt: clock(), ...record };
    commit({ ...registry, accounts: [...registry.accounts, account] });
    return json({ username, recoveryCode }, 201, { 'set-cookie': cookie(secure) });
  }

  async function login(input, username, secure) {
    const original = lookup(username);
    if (!userIsEnabled(original)) return invalidLogin();
    const access = accessChanges.get(original.id);
    if (!equals(original.passwordHash, await passwordDigest(input.password, original.salt))) return invalidLogin();
    const account = lookup(username);
    if (!userIsEnabled(account) || account.id !== original.id || accessChanges.get(account.id) !== access
      || account.salt !== original.salt || account.passwordHash !== original.passwordHash) {
      return invalidLogin();
    }
    const now = clock();
    const { token, entry } = newSession(secure, now);
    replaceAccount(account, { sessions: addSession(account.sessions, entry, now) });
    return json({ username: account.username, role: roleOf(account) }, 200, { 'set-cookie': cookie(secure, token) });
  }

  async function reset(input, username, secure, headers) {
    const code = typeof input.recoveryCode === 'string' && input.recoveryCode.length <= 64 ? input.recoveryCode.trim() : '';
    if (!resetPattern.test(code)) return invalidRecovery();
    const original = lookup(username);
    const hash = digest(code);
    if (!userIsEnabled(original) || !equals(original.recoveryHash, hash)) return invalidRecovery();
    const access = accessChanges.get(original.id);
    const { recoveryCode, record } = await accountSecrets(input.password);
    const account = lookup(username);
    if (!userIsEnabled(account) || account.id !== original.id || accessChanges.get(account.id) !== access
      || !equals(account.recoveryHash, hash)) return invalidRecovery();
    const logout = sessionOwner(headers, secure)?.account.id === account.id;
    replaceAccount(account, record);
    return json({ username: account.username, recoveryCode }, 200, logout ? { 'set-cookie': cookie(secure) } : {});
  }

  async function handle({ path, method, headers, secure = false, loopback = false, sameOrigin = false,
    sameOriginRead = false, readJSON, clientKey }) {
    if (path === challengePath && registrationVerification) {
      if (method !== 'GET') return failure(405, '请使用 GET 请求。', { Allow: 'GET' });
      if (!secure && !loopback) return failure(403, '请通过 HTTPS 打开宇伴控制台。');
      if (!sameOriginRead) return failure(403, '不接受跨站请求。');
      const challenge = await registrationVerification.issue(clientKey);
      if (!challenge) return failure(429, '验证请求过多，请稍后再试。');
      return json(challenge);
    }
    const expected = methodFor(path);
    if (!expected) return null;
    if (!secure && !loopback) return failure(403, '请通过 HTTPS 打开宇伴控制台。');
    if (method !== expected) return failure(405, `请使用 ${expected} 请求。`, { Allow: expected });
    if (path === '/api/auth/status') {
      const active = sessionOwner(headers, secure);
      return json({ registered: registry.accounts.length > 0, username: active?.account.username ?? null, multi: true,
        canClaimLegacy: canClaimLegacy(), ...(active ? { role: roleOf(active.account) } : {}),
        ...(registrationVerification ? { registrationVerification: true } : {}) });
    }
    if (!sameOrigin) return failure(403, '不接受跨站请求。');
    if (path === '/api/auth/logout') {
      const active = sessionOwner(headers, secure);
      if (active) replaceAccount(active.account, { sessions: active.account.sessions.filter(({ hash }) => hash !== active.hash) });
      return json({ ok: true }, 200, { 'set-cookie': cookie(secure) });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(header(headers, 'content-type'))) return failure(415, '需要 application/json。');
    const input = await readJSON();
    if (!input || typeof input !== 'object' || Array.isArray(input)) return failure(400, '请求体需要是 JSON 对象。');
    const username = usernameOf(input.username);
    if (!username || !validPassword(input.password)) return path === '/api/auth/login' ? invalidLogin() : invalidCredentials();
    if (path === registerPath) return register(input, username, secure, clientKey);
    if (!allowAttempt(path, clientKey)) return failure(429, '尝试次数过多，请稍后再试。', { 'Retry-After': String(attemptWindow / 1000) });
    if (path === '/api/auth/login') return login(input, username, secure);
    return reset(input, username, secure, headers);
  }

  return {
    enabled: true,
    authenticate,
    handle,
    registrationSummary: () => ({
      registrationVerification: Boolean(registrationVerification),
      memberCount: registry.accounts.filter(({ legacy }) => !legacy).length,
      disabledCount: registry.accounts.filter((account) => !account.legacy && !userIsEnabled(account)).length,
      accountLimit: accountLimit - 1,
    }),
    accounts: () => registry.accounts.map(publicAccount),
    listUsers: () => registry.accounts.map(publicUser),
    setUserDisabled,
    userEnabled: (id) => userIsEnabled(byId(id)),
    account(id) {
      const account = byId(id);
      return account ? publicAccount(account) : null;
    },
  };
}
