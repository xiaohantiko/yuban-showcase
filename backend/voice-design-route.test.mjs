import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.mjs';
import { previewReservation, voiceDesignResponse, voiceDesignRoute, voiceSelectionRoute } from './voice-design-route.mjs';

test('preview reservations space calls and cap a rolling day across midnight', () => {
  const first = Date.UTC(2025, 0, 1, 23, 59);
  let times = [];
  for (let index = 0; index < 12; index++) {
    const now = first + index * 15_000;
    times = previewReservation(times, now).attempts;
    assert.equal(times.length, index + 1);
    assert.ok(previewReservation(times, now + 1).retryAfter >= 15);
  }
  assert.equal(previewReservation(times, first + 86_399_999).retryAfter, 1);
  assert.deepEqual(previewReservation(times, first + 86_400_000).attempts, [...times.slice(1), first + 86_400_000]);
});

test('preview errors distinguish vendor authentication from console login and redact upstream text', async () => {
  const apiKey = randomUUID();
  const input = { apiKey, description: '柔和的声线', previewText: '门口那家咖啡店今天新买了一盆好看的绿萝。' };
  const options = {
    method: 'POST', username: 'fixture', trustedOrigin: true, contentType: 'application/json',
    readInput: async () => input, reserve: () => ({}),
  };
  const messages = new Set();
  for (const status of [400, 401, 403, 429]) {
    const response = await voiceDesignResponse({ ...options, fetchImpl: async () => Response.json(
      { code: status === 401 ? 'InvalidApiKey' : 'UnknownFailure', message: apiKey }, { status }) });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('x-yuban-login'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { error } = await response.json();
    assert.ok(error.length > 0 && !error.includes(apiKey) && !error.includes('UnknownFailure'));
    messages.add(error);
  }
  assert.equal(messages.size, 4);

  const forged = Object.assign(new Error(apiKey), { status: 400 });
  const malformed = await voiceDesignResponse({ ...options, readInput: () => ({ get apiKey() { throw forged; } }) });
  assert.equal(malformed.status, 400);
  assert.ok(!(await malformed.text()).includes(apiKey));
  const interrupted = await voiceDesignResponse({ ...options, fetchImpl: async () => { throw forged; } });
  assert.equal(interrupted.status, 502);
  assert.ok(!(await interrupted.text()).includes(apiKey));
});

test('only signed-in console accounts can audition; quotas, audio and keys stay isolated on Node', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'yuban-voice-design-'));
  const stateFile = join(folder, 'state.json');
  const env = { YUBAN_ADMIN_TOKEN: randomUUID(), YUBAN_CONSOLE_ACCOUNTS: 'multi' };
  const input = { apiKey: randomUUID(), description: '清亮轻松的声音', previewText: '城市的路灯亮了，我们去买刚刚出炉的面包吧。' };
  const wave = 'UklGRiYAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQIAAAAAAA==';
  const model = 'qwen-audio-3.1-tts-flash';
  const voiceId = model + '-vd-yuban-test';
  let server, base, origin, calls = 0, now = Date.now();
  const generating = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const slowQuery = Promise.withResolvers();
  const finishQuery = Promise.withResolvers();
  const fetchImpl = async (url, init) => {
    const action = JSON.parse(init.body).input;
    if (action.action === 'query_voice') {
      assert.equal(new URL(url).hostname, 'workspace-test.cn-beijing.maas.aliyuncs.com');
      const auth = new Headers(init.headers).get('authorization');
      if (auth !== 'Bearer ' + input.apiKey) return Response.json({ message: input.apiKey }, { status: 403 });
      if (action.voice_id === voiceId + '-pending') {
        slowQuery.resolve();
        await finishQuery.promise;
      }
      return Response.json({ output: { voice_id: action.voice_id, target_model: model, status: 'OK' } });
    }
    calls++;
    assert.equal(url.hostname, 'dashscope.aliyuncs.com');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + input.apiKey);
    assert.equal(JSON.parse(init.body).input.preview_text, input.previewText);
    if (calls === 4) {
      generating.resolve();
      await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }));
      disconnected.resolve();
      throw Error('Mock connection cancelled');
    }
    if (calls > 2) return new Response(input.apiKey, { status: 429 });
    return Response.json({ output: { voice_id: voiceId, target_model: model,
      preview_audio: { response_format: 'wav', sample_rate: 24_000, data: wave } } });
  };
  const close = () => new Promise(resolve => server.close(resolve));
  const boot = async () => {
    ({ server } = createApp({ stateFile, env, fetchImpl, clock: () => now }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + server.address().port;
    origin = base.replace('http:', 'https:');
  };
  const request = (path, { data, cookie, headers, method = data ? 'POST' : 'GET', signal } = {}) => fetch(base + path, { method, signal, headers: {
    Origin: origin, 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...headers,
  }, ...(data && { body: JSON.stringify(data) }) });
  const preview = (cookie, extras = {}) => request(voiceDesignRoute, { cookie, data: input, ...extras });
  const state = async cookie => (await request('/api/state', { cookie })).json();
  async function signIn(username) {
    const data = { username, password: 'A1' + randomUUID() };
    assert.equal((await request('/api/auth/register', { data })).status, 201);
    return (await request('/api/auth/login', { data })).headers.get('set-cookie').split(';')[0];
  }
  await boot();
  t.after(async () => { if (server.listening) await close(); await rm(folder, { force: true, recursive: true }); });
  const basic = { Authorization: 'Basic ' + Buffer.from('yuban:' + env.YUBAN_ADMIN_TOKEN).toString('base64') };
  assert.equal((await preview(null, { headers: basic })).status, 401);
  const a = await signIn('blue-fixture');
  const b = await signIn('green-fixture');
  const initial = await state(a);
  assert.equal(initial.services.voiceDesignPreview, true);
  assert.match((await request('/', { cookie: a })).headers.get('content-security-policy'), /media-src 'self' blob:/);
  assert.equal((await request(voiceDesignRoute, { cookie: a })).status, 405);
  for (const headers of [{ Origin: '' }, { Origin: 'https://example.com' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await preview(a, { headers })).status, 403);
  }
  assert.equal((await preview(a, { headers: { 'X-Yuban-Account': 'green-fixture' } })).status, 401);
  assert.equal((await preview(a, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await preview(a, { data: { ...input, previewText: '短句' } })).status, 400);
  assert.equal(calls, 0);
  const responses = await Promise.all([preview(a), preview(a), preview(a)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 429, 429]);
  const ok = responses.find(r => r.ok);
  assert.equal(ok.headers.get('content-type'), 'audio/wav');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('x-yuban-voice-id'), voiceId);
  assert.equal(Buffer.from(await ok.arrayBuffer()).toString('base64'), wave);
  assert.equal(responses.find(r => !r.ok).headers.get('retry-after'), '15');
  assert.equal((await preview(b)).status, 200);
  assert.deepEqual((await state(a)).settings, initial.settings);
  assert.equal(calls, 2);
  await close();
  await boot();
  assert.equal((await preview(a)).status, 429);
  now += 15_000;
  const denied = await preview(a);
  assert.equal(denied.status, 429);
  assert.ok(!(await denied.text()).includes(input.apiKey));
  assert.equal(calls, 3);
  assert.equal((await preview(a)).headers.get('retry-after'), '15');
  now += 15_000;
  const controller = new AbortController();
  const pending = preview(a, { signal: controller.signal });
  await generating.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await disconnected.promise;
  assert.equal((await preview(a)).status, 429);
  for (const name of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!name.isFile()) continue;
    const saved = await readFile(join(name.parentPath ?? name.path, name.name), 'utf8');
    for (const value of [input.apiKey, input.previewText, input.description, voiceId, wave]) assert.ok(!saved.includes(value));
  }
  const selection = { enabled: true, voiceId, apiKey: input.apiKey, workspaceId: 'workspace-test' };
  const select = (cookie, data = selection, headers) => request(voiceSelectionRoute, { cookie, data, headers });
  assert.equal((await select(null)).status, 401);
  assert.equal((await select(a, selection, { Origin: '' })).status, 403);
  assert.equal((await select(a, selection, { 'X-Yuban-Account': 'green-fixture' })).status, 401);
  assert.equal((await select(a, { ...selection, workspaceId: 'space.example' })).status, 400);
  const unavailable = await select(a, { ...selection, apiKey: randomUUID() });
  assert.equal(unavailable.status, 502);
  assert.ok(!(await unavailable.text()).includes(input.apiKey));
  const selected = await select(a);
  assert.equal(selected.status, 200);
  assert.deepEqual(await selected.json(), { enabled: true, voiceId, needsRecovery: false });
  assert.deepEqual((await state(a)).settings, initial.settings);
  assert.equal((await state(b)).services.voiceSelection.enabled, false);
  await close();
  await boot();
  assert.deepEqual((await state(a)).services.voiceSelection, { enabled: true, voiceId, needsRecovery: false });
  for (const name of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!name.isFile()) continue;
    const saved = await readFile(join(name.parentPath ?? name.path, name.name), 'utf8');
    for (const value of [input.apiKey, voiceId]) assert.ok(!saved.includes(value));
  }
  const slower = select(a, { ...selection, voiceId: voiceId + '-pending' });
  await slowQuery.promise;
  assert.equal((await select(a, { enabled: false })).status, 200);
  finishQuery.resolve();
  assert.equal((await slower).status, 409);
  assert.equal((await state(a)).services.voiceSelection.enabled, false);
  await close();
  env.YUBAN_CONSOLE_ACCOUNTS = '';
  await boot();
  assert.equal((await (await request('/api/state', { headers: basic })).json()).services.voiceDesignPreview, false);
  assert.equal((await preview(null, { headers: basic })).status, 401);
  assert.equal(calls, 4);
});
