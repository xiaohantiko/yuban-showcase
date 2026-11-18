import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createProviders } from './providers-local.mjs';
import { createQQAdapter } from './qq.mjs';
import { createOneBotAdapter } from './onebot.mjs';
import { addMessage, commandOff, commandOn, createGreeting, createReply, isQuiet, mergeSettings, newMessage, newThread, nextGreeting, renderForTransport, transportError } from './logic.mjs';
import { openState, ownerChannelKey as channelKey } from './state.mjs';
import { createDshRelay, isDshCommand } from './dsh.mjs';
import { configuredGptToolToken, createGptOpenAPI, gptChainAboutRoute, gptSchemaRoute, handleGptChainAbout, hasGptToolBearer } from './gpt-actions.mjs';
import { handleMemoryCommand, memoryContextFor } from './memory.mjs';
import { replyToOwner } from './owner-chat.mjs';
import { containsClaimCode, createOwnerClaim, matchesOwner, ownerIdentity, ownerStatus, parseOwnerCommand } from './owner.mjs';
import { handleAIReply } from './ai-api.mjs';
import { aiRoute, configuredAIToken, hasAIBearer, isJSONContentType } from './ai-auth.mjs';
import { createSetup, setupModelRoute, setupQQRoute, setupRoute } from './setup.mjs';
import { setupFile } from './setup-local.mjs';
import { createConsoleAuth } from './console-auth.mjs';
import { createMultiConsoleAuth } from './multi-console-auth.mjs';
import { createFeedbackStore } from './feedback-local.mjs';
import { createUsageTracker, usageProvider } from './usage.mjs';
import { usageFile } from './usage-local.mjs';

const webRoot = new URL('../web/', import.meta.url);
const defaultStateFile = fileURLToPath(new URL('../.data/state.json', import.meta.url));
const DAY = 86_400_000;
const OWNER_ROUTE = '/api/owner';
const OWNER_CODE_ROUTE = `${OWNER_ROUTE}/code`;
const LOGIN_ASSETS = new Set([
  '/login', '/login.js', '/login.css', '/styles.css',
  '/assets/altcha.js', '/assets/altcha.css', '/assets/altcha-worker.js', '/assets/altcha-zh.js', '/assets/altcha-license.txt',
]);
const tenantQQRoute = /^\/t\/([0-9a-f]{32})\/api\/qq\/webhook$/;
const adminUserRoute = /^\/api\/admin\/users\/([0-9a-f]{32})$/;
const qqWebhook = '/api/qq/webhook';
const onebotWebhook = '/api/onebot/webhook';
const TYPES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/login', ['login.html', 'text/html; charset=utf-8']],
  ['/login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/login.css', ['login.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/model-catalog.js', ['model-catalog.js', 'text/javascript; charset=utf-8']],
  ['/dsh-portable.js', ['dsh-portable.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/assets/altcha.js', ['../node_modules/altcha/dist/external/altcha.min.js', 'text/javascript; charset=utf-8']],
  ['/assets/altcha.css', ['../node_modules/altcha/dist/external/altcha.css', 'text/css; charset=utf-8']],
  ['/assets/altcha-worker.js', ['../node_modules/altcha/dist/workers/pbkdf2.js', 'text/javascript; charset=utf-8']],
  ['/assets/altcha-zh.js', ['../node_modules/altcha/dist/i18n/zh-cn.js', 'text/javascript; charset=utf-8']],
  ['/assets/altcha-license.txt', ['../node_modules/altcha/LICENSE.txt', 'text/plain; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const send = (res, status, data, headers) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};
const fail = (status, message) => { throw new HttpError(status, message); };
const safeEqual = (a, b) => {
  const x = Buffer.from(a ?? '');
  const y = Buffer.from(b ?? '');
  return x.length === y.length && timingSafeEqual(x, y);
};

async function readJSON(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) fail(413, '请求内容过长');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch { fail(400, '无法读取 JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, '需要 JSON 对象');
  return { raw, data };
}
function fromLocalHost(host) {
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host ?? '');
}
function isLoopback(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && fromLocalHost(req.headers.host);
}
function ownerManagementIsSecure(req) {
  return Boolean(req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' || isLoopback(req));
}
function requestIsSameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['sec-fetch-site'] === 'same-site') return false;
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
function consoleOriginMatches(req, secure) {
  if (!req.headers.origin || !requestIsSameOrigin(req)) return false;
  try { return req.headers.origin === new URL(`${secure ? 'https' : 'http'}://${req.headers.host}`).origin; }
  catch { return false; }
}
async function serveAsset(res, path) {
  const [file, type] = TYPES.get(path);
  const body = await readFile(new URL(file, webRoot));
  const cache = path === '/' || path === '/login' ? 'no-store' : 'no-cache';
  const headers = { 'Content-Type': type, 'Cache-Control': cache };
  if (file.startsWith('../node_modules/altcha/dist/')) headers.Link = '</assets/altcha-license.txt>; rel="license"';
  res.writeHead(200, headers);
  return res.end(body);
}
async function sendAuthResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  return res.end(Buffer.from(await response.arrayBuffer()));
}
function consoleHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; media-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}
function requireLogin(res, path, method) {
  if (method === 'GET' && (path === '/' || path === '/admin')) {
    res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
    return res.end();
  }
  return send(res, 401, { error: '请先登录宇伴' }, { 'X-Yuban-Login': '1' });
}
function consoleError(res, error) {
  if (error instanceof HttpError) return send(res, error.status, { error: error.message });
  if (error.code === 'ENOENT') return send(res, 404, { error: '找不到文件' });
  console.error('宇伴请求失败：', error.name);
  return send(res, 500, { error: '暂时没处理好，请再试一次' });
}
const keyFor = (...values) => createHash('sha256').update(values.join('\0')).digest('hex');
const scopeFor = (runtime, transport) => transport === 'qq' ? runtime.env.QQ_APP_ID || null : null;
const lockKey = (transport, scope, target) => keyFor('thread', transport, scope, target.type, target.id);

export function createApp({ env = process.env, stateFile = env.YUBAN_STATE_FILE || defaultStateFile, providers, dshRelay, adapters, clock = Date.now, fetchImpl = fetch } = {}) {
  if (env.YUBAN_CONSOLE_ACCOUNTS === 'multi') return createMultiApp({ env, stateFile, providers, dshRelay, adapters, clock, fetchImpl });
  const relay = createRelay({ env, stateFile, providers, dshRelay, adapters, clock, fetchImpl });
  const server = createServer((req, res) => relay.handle(req, res));
  server.on('close', relay.stop);
  return { server, tick: relay.tick };
}

function createRelay({ env, stateFile, providers: injectedProviders, dshRelay = createDshRelay(env), adapters, clock,
  fetchImpl: upstreamFetch = fetch }) {
  const file = resolve(stateFile);
  const { state, save: saveState } = openState(file);
  const lifetime = new AbortController();
  const fetchImpl = (input, options = {}) => {
    lifetime.signal.throwIfAborted();
    const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
    return upstreamFetch(input, { ...options, signal });
  };
  let stopped = false;
  const save = () => { if (!stopped) saveState(); };
  const requireActive = () => { if (stopped) fail(403, '账号当前已禁用。'); };
  const usage = createUsageTracker({ store: usageFile(`${file}.usage.json`), clock });
  const onUsage = (entry) => { if (!stopped) return usage.record(entry); };
  const settingsStore = setupFile(`${file}.setup.json`);
  const setup = createSetup(env, {
    load: settingsStore.load,
    save(kind, value) { requireActive(); return settingsStore.save(kind, value); },
  }, { fetchImpl, clock, onUsage });
  const accountFile = env.YUBAN_CONSOLE_ACCOUNTS === '1' ? setupFile(`${file}.account.json`) : null;
  // The Node console and its existing state file run in one process. The comparison
  // and write both finish before another request can change the current revision.
  const consoleAuth = createConsoleAuth({ env, clock, store: {
    read: () => accountFile.load().account ?? null,
    compareAndSet(previous, next) {
      const current = accountFile.load().account;
      if ((current?.revision ?? null) !== (previous?.revision ?? null)) return false;
      accountFile.save('account', next);
      return true;
    },
  } });
  const aiToken = configuredAIToken(env);
  const gptToken = configuredGptToolToken(env);
  const publicOrigin = URL.parse(env.YUBAN_PUBLIC_ORIGIN ?? '');
  let gptSchema;
  if (gptToken && dshRelay.chainAboutConfigured && publicOrigin && publicOrigin.pathname === '/' && !publicOrigin.search && !publicOrigin.hash) {
    try { gptSchema = createGptOpenAPI(publicOrigin.href); } catch { /* Leave GPT Actions disabled for invalid public URLs. */ }
  }

  const onebot = adapters?.onebot ?? createOneBotAdapter({ apiBase: env.ONEBOT_API_BASE, accessToken: env.ONEBOT_ACCESS_TOKEN, webhookSecret: env.ONEBOT_WEBHOOK_SECRET });
  let qqCache;
  let verifiedQQ;
  async function services() {
    const runtime = await setup.runtime();
    const { QQ_APP_ID: appId, QQ_CLIENT_SECRET: clientSecret } = runtime.env;
    if (!qqCache || qqCache.appId !== appId || qqCache.clientSecret !== clientSecret) {
      qqCache = { appId, clientSecret, adapter: createQQAdapter({ appId, clientSecret, fetchImpl }) };
    }
    return {
      ...runtime,
      providers: injectedProviders ?? createProviders(runtime.env, { fetchImpl, onUsage }),
      transports: { qq: adapters?.qq ?? qqCache.adapter, onebot },
    };
  }
  const locks = new Map();
  const greetingInFlight = new Set();
  const seen = new Set(state.seen);
  const withThread = (key, job) => {
    const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(job);
    locks.set(key, next);
    next.then(clean, clean);
    function clean() { if (locks.get(key) === next) locks.delete(key); }
    return next;
  };
  const log = (transport, kind, status, detail) => {
    state.logs.unshift({ id: keyFor(transport, kind, status, String(clock()), String(Math.random())).slice(0, 14), transport, kind, status, detail, at: clock() });
    state.logs.length = Math.min(12, state.logs.length);
    save();
  };
  function currentOwner(runtime) {
    const owner = state.owner;
    if (!Number.isFinite(owner?.boundAt) || !runtime.transports[owner.transport]?.configured) return null;
    return scopeFor(runtime, owner.transport) === owner.scope ? owner : null;
  }
  const sameBinding = (owner) => matchesOwner(state.owner, owner) && state.owner.boundAt === owner.boundAt;
  async function transportCurrent(runtime, transport) {
    if (stopped) return false;
    if (transport !== 'qq') return true;
    const latest = await setup.runtime();
    return !stopped && scopeFor(latest, 'qq') === scopeFor(runtime, 'qq') && latest.qqVerifiedKey === runtime.qqVerifiedKey;
  }
  async function snapshot(username, endpoints, account) {
    const runtime = await services();
    requireActive();
    const { providers, transports, qqVerifiedKey } = runtime;
    const owner = currentOwner(runtime);
    const thread = owner ? state.channels[channelKey(owner)] : null;
    const statusOf = (id) => {
      const adapter = transports[id];
      const verified = id === 'qq' && qqVerifiedKey !== 'qq' ? verifiedQQ === qqVerifiedKey
        : state.logs.some((record) => record.transport === id && record.status === 'ok');
      return { configured: adapter.configured, verified: adapter.configured && verified, capabilities: adapter.capabilities };
    };
    return {
      settings: state.settings,
      ...(username ? { account: { username, ...(account && { role: account.legacy ? 'admin' : 'member' }) } } : {}),
      ...(endpoints ? { endpoints } : {}),
      runtime: 'local',
      stats: { conversations: Number(Boolean(thread)), optedIn: Number(Boolean(thread?.optedIn)) },
      services: {
        model: providers.modelConfigured ? 'configured' : 'demo',
        modelId: providers.modelId ?? null,
        aiApi: Boolean(aiToken),
        gptAction: Boolean(gptSchema),
        dsh: { configured: dshRelay.configured, tools: dshRelay.tools },
        search: providers.searchProvider ?? (providers.searchConfigured ? 'configured' : 'none'),
        voice: providers.voiceProvider ?? (providers.voiceConfigured ? 'remote' : 'browser'),
        qq: statusOf('qq'), onebot: statusOf('onebot'),
      },
      logs: state.logs,
    };
  }
  function markActivity(thread) { thread.lastUserAt = Math.max(clock(), (thread.lastUserAt ?? 0) + 1); }
  async function push(runtime, transport, target, message, { proactive = false, owner } = {}) {
    if (stopped || (owner && !sameBinding(owner))) return false;
    let audio;
    if (message.voice && !proactive) {
      try { audio = await runtime.providers.audio(message.text); } catch { /* Reply in text if voice generation fails. */ }
    }
    if (!await transportCurrent(runtime, transport) || (owner && !sameBinding(owner))) return false;
    await runtime.transports[transport].send(target, { text: renderForTransport(message), audio, proactive });
    return true;
  }
  function commitEvent(seenKey, { key, thread, owner = state.owner, ownerClaim = state.ownerClaim } = {}) {
    const previousOwner = state.owner;
    const previousClaim = state.ownerClaim;
    const previousThread = key ? state.channels[key] : null;
    if (key) state.channels[key] = thread;
    state.owner = owner;
    state.ownerClaim = ownerClaim;
    state.seen.push(seenKey);
    const expired = state.seen.splice(0, Math.max(0, state.seen.length - 2048));
    try { save(); }
    catch (err) {
      state.seen.pop();
      state.seen.unshift(...expired);
      state.owner = previousOwner;
      state.ownerClaim = previousClaim;
      if (key) {
        if (previousThread) state.channels[key] = previousThread;
        else delete state.channels[key];
      }
      throw err;
    }
    for (const old of expired) seen.delete(old);
  }
  async function handleEvent(runtime, transport, parsed) {
    const { providers, transports } = runtime;
    const adapter = transports[transport];
    const scope = scopeFor(runtime, transport);
    const namespace = scope ? [transport, scope] : [transport];
    const seenKey = keyFor(...namespace, parsed.id);
    const legacySeenKey = transport === 'qq' && !runtime.qqScope && scope ? keyFor(transport, parsed.id) : null;
    if (seen.has(seenKey) || (legacySeenKey && seen.has(legacySeenKey))) return;
    seen.add(seenKey);
    let committed = false;
    const commit = (changes) => { commitEvent(seenKey, changes); committed = true; };
    async function notice(text, kind, owner) {
      try {
        if (await push(runtime, transport, parsed.target, newMessage('assistant', text), { owner })) {
          log(transport, kind, 'ok', kind === 'owner' ? '已返回主人设置结果' : '已提示需要授权');
        }
      } catch (err) { log(transport, kind, 'error', transportError(err)); }
    }
    try {
      const learning = await withThread(lockKey(transport, scope, parsed.target), async () => {
        const text = parsed.text.trim().slice(0, 2000);
        if (!text || !await transportCurrent(runtime, transport)) return;
        const identity = ownerIdentity(transport, parsed.target, scope);
        const ownerCommand = parseOwnerCommand(parsed.text);
        if (!identity) {
          commit();
          return notice('主人认领和陪伴聊天只在 QQ 私聊中使用。', 'access');
        }
        if (ownerCommand?.kind === 'claim') {
          const now = clock();
          const pending = state.ownerClaim;
          if (!pending || pending.expiresAt <= now || !safeEqual(ownerCommand.digest, pending.digest)) {
            commit(pending?.expiresAt <= now ? { ownerClaim: null } : undefined);
            return notice('认领码无效、已过期或已使用。请在宇伴控制台重新生成。', 'owner');
          }
          const owner = { ...identity, name: pending.name, boundAt: Math.max(now, (state.owner?.boundAt ?? -1) + 1) };
          commit({ owner, ownerClaim: null });
          return notice(owner.name ? `主人绑定成功。以后就叫你${owner.name}啦。` : '主人绑定成功。你可以发「叫我 昵称」告诉我怎么称呼你。', 'owner', owner);
        }
        const owner = currentOwner(runtime);
        if (!matchesOwner(owner, identity)) {
          commit();
          const instruction = owner ? '当前 QQ 私聊没有主人授权。宇伴只回复已绑定的主人。'
            : '请在宇伴控制台生成认领码，再从 QQ 私聊发回认领命令。';
          return notice(instruction, 'access');
        }
        if (ownerCommand?.kind === 'invalid' || containsClaimCode(parsed.text)) {
          commit();
          return notice('命令格式不正确。请复制控制台的认领命令，或发送「叫我 昵称」。', 'owner', owner);
        }
        if (ownerCommand?.kind === 'name') {
          const renamed = { ...owner, name: ownerCommand.name };
          commit({ owner: renamed });
          return notice(`好呀，以后就叫你${renamed.name}。`, 'owner', renamed);
        }

        const key = channelKey(owner);
        const previous = state.channels[key];
        const thread = { ...(previous ?? newThread()), messages: [...(previous?.messages ?? [])] };
        thread.target = { type: 'c2c', id: identity.id };
        thread.transport = transport;
        markActivity(thread);

        const settings = state.settings;
        const memoryOptions = { allowed: settings.memoryEnabled !== false, privateChat: true };
        const memoryCommand = handleMemoryCommand(thread.memory, text, memoryOptions);
        const pluginCommand = isDshCommand(parsed.text);
        let message;
        let completion;
        if (pluginCommand) {
          // Save the event ID before calling an external plugin, which may have side effects.
        } else if (memoryCommand) {
          thread.memory = memoryCommand.memory;
          if (memoryCommand.clearHistory) thread.messages = [];
          message = newMessage('assistant', memoryCommand.text);
        } else if (commandOn.test(text) || commandOff.test(text)) {
          const canGreet = adapter.capabilities?.proactive;
          thread.optedIn = Boolean(canGreet && commandOn.test(text));
          message = newMessage('assistant', thread.optedIn ? '好呀，等你一阵子没回时，我会来问候一声。随时发「关闭问候」就能停下。' : commandOff.test(text) ? '问候已关闭。你想聊天的时候，我都在。' : '目前只有支持主动问候的单聊可以开启哦。');
        } else {
          const turn = await replyToOwner({
            providers, settings, messages: thread.messages, text, memory: thread.memory, ownerName: owner.name, at: clock(),
          });
          message = turn.reply;
          completion = turn.completion;
          if (state.settings.memoryEnabled !== false) thread.memory = turn.memory;
          addMessage(thread, newMessage('user', text, { at: clock(), ...(turn.searching ? { kind: 'search' } : {}) }));
          addMessage(thread, turn.searching ? { ...message, kind: 'search' } : message);
        }

        if (!await transportCurrent(runtime, transport) || !sameBinding(owner)) {
          commit();
          return;
        }
        commit({ key, thread });
        const kind = pluginCommand ? 'plugin' : 'reply';
        try {
          if (pluginCommand) {
            const result = await dshRelay.handle({ transport, target: parsed.target, text: parsed.text });
            message = newMessage('assistant', result?.text || '未能处理插件命令。');
          }
          if (!await push(runtime, transport, parsed.target, message, { owner })) return;
          log(transport, kind, 'ok', pluginCommand ? '已返回插件处理结果' : '已发送对话回复');
        } catch (err) { log(transport, kind, 'error', transportError(err)); }
        return completion ? { completion, owner, key, thread } : null;
      });
      // Learning may finish after delivery. Release the conversation lock first so
      // new chat and memory controls can run, then discard superseded observations.
      if (learning) {
        const { completion, owner, key, thread } = learning;
        const learned = await completion;
        if (learned && learned !== thread.memory && await transportCurrent(runtime, transport) && sameBinding(owner)
          && state.channels[key] === thread && state.settings.memoryEnabled !== false) {
          thread.memory = learned;
          save();
        }
      }
    } finally {
      if (!committed) seen.delete(seenKey);
    }
  }
  async function tick() {
    const now = clock();
    const settings = state.settings;
    if (stopped || !settings.enabled || isQuiet(now, settings)) return;
    const candidate = state.owner;
    const key = channelKey(candidate);
    const thread = key ? state.channels[key] : null;
    if (!thread?.optedIn || now - thread.lastUserAt >= 30 * DAY || nextGreeting(thread, settings, now) !== now) return;
    const target = { type: 'c2c', id: candidate.id };
    const lock = lockKey(candidate.transport, candidate.scope, target);
    if (locks.has(lock) || greetingInFlight.has(key)) return;
    const runtime = await services();
    if (stopped) return;
    const owner = currentOwner(runtime);
    if (!owner || !runtime.transports[owner.transport].capabilities?.proactive) return;
    const time = clock();
    if (!sameBinding(candidate) || state.channels[key] !== thread || state.settings !== settings
      || locks.has(lock) || greetingInFlight.has(key) || !thread.optedIn || time - thread.lastUserAt >= 30 * DAY
      || nextGreeting(thread, settings, time) !== time) return;
    const activity = thread.lastUserAt;
    greetingInFlight.add(key);
    try {
      // Let new private messages run while the model writes a greeting; recheck the idle period before sending.
      const message = await createGreeting(runtime.providers, settings, thread.messages.slice(), {
        at: time, idleMinutes: Math.floor((time - activity) / 60_000), ownerName: owner.name,
        memoryContext: memoryContextFor(thread.memory, { allowed: settings.memoryEnabled !== false, privateChat: true, includeNotes: false }),
      });
      await withThread(lock, async () => {
        if (!await transportCurrent(runtime, owner.transport) || !sameBinding(owner) || state.owner.name !== owner.name
          || state.channels[key] !== thread || state.settings !== settings || !thread.optedIn) return;
        const after = clock();
        if (after - activity >= 30 * DAY || nextGreeting(thread, settings, after) !== after) return;
        // A timed-out delivery may have succeeded remotely. Do not retry it automatically.
        thread.attemptedFor = activity;
        save();
        try {
          if (!await push(runtime, owner.transport, target, message, { proactive: true, owner })) return;
          log(owner.transport, 'greeting', 'ok', '已发送主动问候');
        } catch (err) {
          log(owner.transport, 'greeting', 'error', transportError(err));
          return;
        }
        if (sameBinding(owner)) {
          addMessage(thread, message);
          save();
        }
      });
    } finally { greetingInFlight.delete(key); }
  }
  const authToken = env.YUBAN_ADMIN_TOKEN;
  async function handle(req, res, { path: routedPath, account = null, endpoints } = {}) {
    consoleHeaders(res);
    try {
      requireActive();
      const method = req.method;
      const path = routedPath ?? new URL(req.url, 'http://localhost').pathname;
      if (method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
      if (path === gptSchemaRoute || path === gptChainAboutRoute) {
        const expected = path === gptSchemaRoute ? 'GET' : 'POST';
        if (method !== expected) { res.setHeader('Allow', expected); fail(405, `请使用 ${expected} 请求`); }
        if (!gptSchema) fail(503, '尚未启用 GPT 只读查询');
        if (!req.socket.encrypted && req.headers['x-forwarded-proto'] !== 'https') fail(403, 'GPT Actions 需要 HTTPS');
        if (path === gptSchemaRoute) return send(res, 200, gptSchema);
        if (!requestIsSameOrigin(req)) fail(403, '不接受跨站请求');
        if (!hasGptToolBearer(req.headers.authorization, gptToken)) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="YuBan GPT"');
          fail(401, 'GPT 查询密钥无效');
        }
        if (!isJSONContentType(req.headers['content-type'])) fail(415, '需要 application/json');
        const { data } = await readJSON(req);
        try { return send(res, 200, await handleGptChainAbout(dshRelay, data)); }
        catch (err) {
          if ([400, 502, 503].includes(err?.status)) fail(err.status, err.message);
          throw err;
        }
      }
      if (path === aiRoute) {
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST');
          fail(405, '请使用 POST 请求');
        }
        if (!requestIsSameOrigin(req)) fail(403, '不接受跨站请求');
        if (!aiToken) fail(503, '尚未启用 AI 接口');
        if (!hasAIBearer(req.headers.authorization, aiToken)) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="YuBan AI"');
          fail(401, 'AI 接口密钥无效');
        }
        if (!isJSONContentType(req.headers['content-type'])) fail(415, '需要 application/json');
        const { data } = await readJSON(req);
        const { providers } = await services();
        const { companionName, companionPersona } = state.settings;
        try { return send(res, 200, await handleAIReply(providers, data, { companionName, companionPersona })); }
        catch (err) {
          if ([400, 502, 503].includes(err?.status)) fail(err.status, err.message);
          throw err;
        }
      }
      const transport = path === qqWebhook ? 'qq' : path === onebotWebhook ? 'onebot' : null;
      if (transport && method === 'POST') {
        const runtime = await services();
        const adapter = runtime.transports[transport];
        if (!adapter.configured) fail(503, '尚未配置连接');
        const { data, raw } = await readJSON(req);
        requireActive();
        if (transport === 'qq' && data.op === 13) {
          const handshake = adapter.handshake(data, req.headers);
          if (!handshake) fail(401, '握手校验失败');
          verifiedQQ = runtime.qqVerifiedKey;
          return send(res, 200, handshake);
        }
        if (!adapter.verify(raw, req.headers)) fail(401, '签名校验失败');
        if (transport === 'qq') verifiedQQ = runtime.qqVerifiedKey;
        const parsed = adapter.parseEvent(data);
        send(res, 200, transport === 'qq' ? { op: 12, d: 0 } : {});
        if (parsed) handleEvent(runtime, transport, parsed).catch(() => console.error('处理平台消息失败'));
        return;
      }
      let username = account?.username ?? null;
      if (!account && consoleAuth.enabled) {
        const secure = Boolean(req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https');
        const loopback = isLoopback(req);
        if (!secure && !loopback) fail(403, '请通过 HTTPS 打开宇伴。');
        const headers = new Headers(req.headers);
        const sameOrigin = consoleOriginMatches(req, secure);
        const authResponse = await consoleAuth.handle({
          path, method, headers, secure, loopback, sameOrigin,
          readJSON: async () => (await readJSON(req)).data,
          clientKey: req.socket.remoteAddress ?? 'unknown',
        });
        if (authResponse) return await sendAuthResponse(res, authResponse);
        if (method === 'GET' && LOGIN_ASSETS.has(path)) return await serveAsset(res, path);
        username = await consoleAuth.authenticate(headers, { secure });
        if (!username) return requireLogin(res, path, method);
        if (!['GET', 'HEAD'].includes(method) && !sameOrigin) fail(403, '不接受跨站请求');
      } else if (!account && authToken) {
        const expected = 'Basic ' + Buffer.from(`yuban:${authToken}`).toString('base64');
        if (!safeEqual(req.headers.authorization, expected)) {
          res.setHeader('WWW-Authenticate', 'Basic realm="YuBan", charset="UTF-8"');
          return send(res, 401, { error: '请登录宇伴控制台' });
        }
      } else if (!account && !fromLocalHost(req.headers.host)) fail(403, '控制台仅在本机可用');
      if (!requestIsSameOrigin(req)) fail(403, '不接受跨站请求');
      if (path === OWNER_ROUTE || path === OWNER_CODE_ROUTE) {
        if (!authToken) fail(503, '请先设置宇伴控制台管理口令。');
        if (!ownerManagementIsSecure(req)) fail(403, '请通过 HTTPS 打开主人设置。');
        const expected = path === OWNER_ROUTE ? 'GET' : 'POST';
        if (method !== expected) {
          res.setHeader('Allow', expected);
          fail(405, `请使用 ${expected} 请求`);
        }
        if (method === 'GET') {
          const runtime = await services();
          requireActive();
          return send(res, 200, ownerStatus(currentOwner(runtime), state.ownerClaim, clock()));
        }
        if (!isJSONContentType(req.headers['content-type'])) fail(415, '需要 application/json');
        const { data } = await readJSON(req);
        requireActive();
        if (Object.keys(data).some(key => key !== 'name')) fail(400, '认领设置只接受可选的主人昵称');
        let claim;
        try { claim = createOwnerClaim(data.name, clock()); } catch (err) { fail(400, err.message); }
        const previous = state.ownerClaim;
        state.ownerClaim = claim.record;
        try { save(); } catch (err) { state.ownerClaim = previous; throw err; }
        return send(res, 200, { command: claim.command, expiresAt: claim.record.expiresAt });
      }
      if (path === setupRoute || path === setupModelRoute || path === setupQQRoute) {
        if (!fromLocalHost(req.headers.host) && req.headers['x-forwarded-proto'] !== 'https' && !req.socket.encrypted) {
          fail(403, '请通过 HTTPS 打开配置向导。');
        }
        const expected = path === setupRoute ? 'GET' : 'POST';
        if (method !== expected) {
          res.setHeader('Allow', expected);
          fail(405, `请使用 ${expected} 请求`);
        }
        if (method === 'GET') {
          const runtime = await setup.runtime();
          requireActive();
          return send(res, 200, runtime.status);
        }
        if (!isJSONContentType(req.headers['content-type'])) fail(415, '需要 application/json');
        const { data } = await readJSON(req);
        requireActive();
        try { return send(res, 200, await setup.save(path === setupModelRoute ? 'model' : 'qq', data)); }
        catch (err) {
          if ([400, 403, 502, 503].includes(err?.status)) fail(err.status, err.message);
          throw err;
        }
      }
      if (method === 'GET' && TYPES.has(path) && !path.startsWith('/login')) return await serveAsset(res, path);
      if (method === 'GET' && path === '/api/state') return send(res, 200, await snapshot(username, endpoints, account));
      if (method === 'GET' && path === '/api/usage') {
        const runtime = await setup.runtime();
        const { model, hasApiKey, configured } = runtime.status.model;
        const summary = await usage.snapshot();
        requireActive();
        return send(res, 200, { ...summary,
          current: { provider: configured ? usageProvider(runtime.env.AI_BASE_URL) : null, model, hasApiKey, configured } });
      }
      if (method === 'PATCH' && path === '/api/settings') {
        const { data } = await readJSON(req);
        requireActive();
        try { state.settings = mergeSettings(state.settings, data); } catch (err) { fail(400, err.message); }
        save();
        return send(res, 200, await snapshot(username, endpoints, account));
      }
      if (method === 'POST' && path === '/api/bridge/check') {
        const { providers } = await services();
        requireActive();
        const reply = await createReply(providers, state.settings, [], '今天工作很累，想歇一会儿。', { at: clock() });
        log('demo', 'check', 'ok', '内部收发链路测试通过');
        return send(res, 200, { ok: true, text: reply.text, voiceAvailable: Boolean(providers.voiceAvailable), state: await snapshot(username, endpoints, account) });
      }
      return send(res, 404, { error: '找不到这个地址' });
    } catch (error) { return consoleError(res, error); }
  }
  const scheduler = setInterval(() => tick().catch(() => console.error('主动问候任务失败')), 5_000);
  scheduler.unref();
  function stop() {
    stopped = true;
    clearInterval(scheduler);
    lifetime.abort();
  }
  return { handle, tick, stop, qqConfigured: async () => (await setup.runtime()).status.qq.configured };
}

export function createMultiApp({ env = process.env, stateFile = env.YUBAN_STATE_FILE || defaultStateFile, providers, dshRelay, adapters, clock = Date.now, fetchImpl = fetch } = {}) {
  if (!/^[\x21-\x7e]{32,256}$/.test(env.YUBAN_ADMIN_TOKEN ?? '')) {
    throw new Error('多人模式需要至少 32 位随机字符的 YUBAN_ADMIN_TOKEN');
  }
  const file = resolve(stateFile);
  const legacyAccount = setupFile(`${file}.account.json`).load().account ?? null;
  const auth = createMultiConsoleAuth({ env, stateFile: file, clock, legacyAccount });
  const feedback = createFeedbackStore({ stateFile: file, clock });
  const legacy = createRelay({
    env: { ...env, YUBAN_CONSOLE_ACCOUNTS: '' }, stateFile: file, providers, dshRelay, adapters, clock, fetchImpl,
  });
  const guests = new Map();
  function relayFor(account) {
    if (account.legacy) return legacy;
    if (!guests.has(account.id)) {
      // Start with an empty environment so a new account cannot inherit service credentials.
      const key = createHmac('sha256', env.YUBAN_ADMIN_TOKEN).update(`yuban tenant setup v1\0${account.id}`).digest('hex');
      guests.set(account.id, createRelay({
        env: { YUBAN_ADMIN_TOKEN: key },
        stateFile: join(`${file}.tenants`, account.id, 'state.json'),
        providers, clock, fetchImpl,
      }));
    }
    return guests.get(account.id);
  }
  function stopGuest(id) {
    guests.get(id)?.stop();
    guests.delete(id);
  }
  function setGuestDisabled(id, disabled) {
    const target = auth.account(id);
    if (!target) fail(404, '找不到这个账号。');
    if (target.legacy) fail(403, '管理员账号不可禁用。');
    const restarting = !disabled && !auth.userEnabled(id);
    if (restarting) relayFor(target);
    try {
      const user = auth.setUserDisabled(id, disabled);
      if (disabled) stopGuest(id);
      return user;
    } catch (error) {
      if (restarting) stopGuest(id);
      throw error;
    }
  }
  try {
    for (const account of auth.accounts()) if (auth.userEnabled(account.id)) relayFor(account);
  } catch (error) {
    legacy.stop();
    for (const guest of guests.values()) guest.stop();
    throw error;
  }

  const server = createServer(async (req, res) => {
    consoleHeaders(res);
    try {
      const { method } = req;
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path === '/healthz' && method === 'GET') return send(res, 200, { ok: true });
      const secure = Boolean(req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https');
      const loopback = isLoopback(req);
      if (!secure && !loopback) fail(403, '请通过 HTTPS 打开宇伴。');

      if (method === 'POST' && (path === qqWebhook || path === onebotWebhook)) return await legacy.handle(req, res, { path });
      if (path === aiRoute || path === gptSchemaRoute || path === gptChainAboutRoute) return await legacy.handle(req, res, { path });
      if (path.startsWith('/t/')) {
        const tenantId = tenantQQRoute.exec(path)?.[1];
        const account = tenantId && auth.account(tenantId);
        if (method !== 'POST' || !account || account.legacy || !auth.userEnabled(account.id)) fail(404, '找不到这个地址');
        // Only the signed platform callback can enter through a URL containing a tenant ID.
        return await relayFor(account).handle(req, res, { path: qqWebhook });
      }

      const headers = new Headers(req.headers);
      const sameOrigin = consoleOriginMatches(req, secure);
      const account = await auth.authenticate(headers, { secure });
      const expected = req.headers['x-yuban-account'];
      if (expected && (!account || expected !== encodeURIComponent(account.username))) return requireLogin(res, path, method);
      const proxyIp = env.YUBAN_TRUST_PROXY === '1' ? req.headers['x-real-ip'] : null;
      const authResponse = await auth.handle({
        path, method, headers, secure, loopback, sameOrigin,
        sameOriginRead: requestIsSameOrigin(req) && (!req.headers.origin || sameOrigin),
        readJSON: async () => (await readJSON(req)).data,
        clientKey: typeof proxyIp === 'string' && isIP(proxyIp) ? proxyIp : req.socket.remoteAddress ?? 'unknown',
      });
      if (authResponse) return await sendAuthResponse(res, authResponse);
      if (method === 'GET' && LOGIN_ASSETS.has(path)) return await serveAsset(res, path);
      if (!account || !auth.userEnabled(account.id)) return requireLogin(res, path, method);
      if (!['GET', 'HEAD'].includes(method) && !sameOrigin) fail(403, '不接受跨站请求');
      const managedUser = adminUserRoute.exec(path);
      if (path === '/admin' || path.startsWith('/api/admin/')) {
        if (!account.legacy) fail(403, '此页面仅供管理员使用。');
        if (!managedUser && !['/admin', '/api/admin/status', '/api/admin/users', '/api/admin/feedback'].includes(path)) {
          fail(404, '找不到这个地址');
        }
        const expected = managedUser ? 'PATCH' : 'GET';
        if (method !== expected) return send(res, 405, { error: `请使用 ${expected} 请求。` }, { Allow: expected });
        if (managedUser) {
          if (!isJSONContentType(req.headers['content-type'])) fail(415, '需要 application/json');
          const { data } = await readJSON(req);
          if (Object.keys(data).length !== 1 || typeof data.disabled !== 'boolean') fail(400, '请选择是否禁用账号。');
          if (!await auth.authenticate(headers, { secure })) return requireLogin(res, path, method);
          return send(res, 200, { user: setGuestDisabled(managedUser[1], data.disabled) });
        }
        if (path === '/admin') return await serveAsset(res, '/');
        if (path === '/api/admin/users') return send(res, 200, { users: auth.listUsers() });
        if (path === '/api/admin/feedback') {
          const offset = url.searchParams.get('offset') ?? '0';
          if (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) fail(400, '反馈分页位置不正确。');
          return send(res, 200, feedback.list(Number(offset)));
        }
        return send(res, 200, { ...auth.registrationSummary(), qqConfigured: await legacy.qqConfigured() });
      }
      if (path === '/api/feedback') {
        if (account.legacy) fail(403, '请使用成员账号提交反馈。');
        if (method !== 'POST') return send(res, 405, { error: '请使用 POST 请求。' }, { Allow: 'POST' });
        if (!isJSONContentType(req.headers['content-type'])) fail(415, '需要 application/json');
        const { data } = await readJSON(req);
        if (!await auth.authenticate(headers, { secure })) return requireLogin(res, path, method);
        try { return send(res, 201, feedback.submit(account, data)); }
        catch (error) {
          if ([400, 429].includes(error?.status)) fail(error.status, error.message);
          throw error;
        }
      }
      const endpoints = account.legacy
        ? { qqWebhook, aiReply: aiRoute, gptSchema: gptSchemaRoute }
        : { qqWebhook: `/t/${account.id}${qqWebhook}`, aiReply: null, gptSchema: null };
      return await relayFor(account).handle(req, res, { path, account, endpoints });
    } catch (error) { return consoleError(res, error); }
  });
  server.on('close', () => {
    legacy.stop();
    for (const guest of guests.values()) guest.stop();
  });
  return { server, tick: () => Promise.all([legacy.tick(), ...[...guests.values()].map(guest => guest.tick())]) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.YUBAN_HOST || '127.0.0.1';
  const port = Number(process.env.YUBAN_PORT || 4173);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.YUBAN_ADMIN_TOKEN) {
    throw new Error('非本机监听需要设置 YUBAN_ADMIN_TOKEN');
  }
  const { server } = createApp();
  server.listen(port, host, () => console.log(`宇伴已启动：http://${host === '::1' ? '[::1]' : host}:${server.address().port}`));
}
