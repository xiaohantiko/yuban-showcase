import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activationSnapshot, applyPluginActivation, assertPluginSettingsPatch, botIsEnabled, migratePluginActivation } from './plugin-activation.mjs';
import { createApp } from './server.mjs';

test('plugin activation is explicit, versioned, and preserves data on disable and soft reset', () => {
  const initial = { companionPersona: '虚构纸船管理员', memoryEnabled: true, dshPlugins: [] };
  const proposal = activationSnapshot(initial);
  assert.equal(botIsEnabled(initial), false);
  assert.deepEqual(proposal.selected, ['agent-md', 'remember', 'memory', 'chain']);
  assert.equal(migratePluginActivation(initial), initial);
  assert.throws(() => applyPluginActivation(initial, { action: 'activate', selected: proposal.selected, revision: 0 }), /确认/);
  const first = applyPluginActivation(initial, { action: 'activate', selected: ['remember', 'chain'], confirmed: true, revision: 0 });
  assert.equal(botIsEnabled(first), true);
  assert.equal(first.companionPersona, initial.companionPersona);
  assert.equal(first.memoryEnabled, true); // Does not grant per-owner memory consent.
  const disabled = applyPluginActivation(first, { action: 'update', selected: [], confirmed: true, revision: 1 });
  assert.deepEqual(disabled.dshPlugins, []);
  assert.deepEqual(disabled.pluginActivation.everEnabled, ['remember', 'chain']);
  assert.throws(() => applyPluginActivation(disabled, { action: 'update', selected: ['remember'], confirmed: true, revision: 2 }), /软重置/);
  assert.throws(() => applyPluginActivation(disabled, { action: 'reset', selected: ['remember'], confirmed: true, revision: 1 }), /刷新/);
  const reset = applyPluginActivation(disabled, { action: 'reset', selected: ['remember'], confirmed: true, revision: 2 });
  assert.deepEqual(reset.dshPlugins, ['remember']);
  assert.equal(reset.companionPersona, initial.companionPersona);
  assert.throws(() => assertPluginSettingsPatch(reset, { dshPlugins: ['chain'] }), /确认/);
  assert.throws(() => assertPluginSettingsPatch(reset, { pluginActivation: initial }), /确认/);
  assert.doesNotThrow(() => assertPluginSettingsPatch(reset, { dshPlugins: ['remember'], companionName: '小宇' }));
  const legacy = migratePluginActivation(initial, { legacy: true });
  assert.deepEqual(activationSnapshot(legacy).selected, []);
  assert.equal(legacy.pluginActivation.legacy, true);
  assert.equal(migratePluginActivation(legacy, { legacy: true }), legacy);
});

test('portable deployment shows chain truthfully but cannot activate unavailable capability', () => {
  const dsh = { supportsChain: false };
  const view = activationSnapshot({}, { dsh });
  assert.deepEqual(view.available, ['agent-md', 'remember', 'memory']);
  assert.deepEqual(view.selected, view.available);
  assert.equal(view.capabilities.find(item => item.id === 'chain').status, 'unavailable');
  assert.throws(() => applyPluginActivation({}, { action: 'activate', selected: ['chain'], confirmed: true, revision: 0 }, { dsh }), /支持/);
  assert.deepEqual(applyPluginActivation({}, { action: 'activate', selected: [], confirmed: true, revision: 0 }, { dsh }).dshPlugins, []);
});

async function fixture(t, { saved, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yuban-activation-'));
  const stateFile = join(directory, 'state.json');
  if (saved) await writeFile(stateFile, JSON.stringify(saved));
  let server;
  let origin;
  async function start() {
    ({ server } = createApp({ stateFile, ...options }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
  const request = (path, data, method = data === undefined ? 'GET' : 'POST') => fetch(origin + path, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  await start();
  return { request, stateFile, start, stop };
}

test('Node enforces first confirmation before QQ credential test, reset and imports survive restart', async t => {
  let upstreamCalls = 0;
  const app = await fixture(t, { env: { YUBAN_ADMIN_TOKEN: '' }, fetchImpl: async () => { upstreamCalls++; throw Error('must not call'); } });
  const get = async () => (await app.request('/api/plugins/activation')).json();
  const first = await get();
  assert.equal(first.configured, false);
  assert.equal((await app.request('/api/setup/qq', { appId: '123456', clientSecret: 'fixture' })).status, 409);
  assert.equal(upstreamCalls, 0);
  assert.equal((await app.request('/api/settings', { dshPlugins: ['remember'] }, 'PATCH')).status, 409);
  assert.equal((await app.request('/api/settings', { pluginActivation: { configured: true } }, 'PATCH')).status, 400);
  assert.equal((await app.request('/api/plugins/activation', { action: 'activate', revision: 0, confirmed: false, selected: [] })).status, 400);
  assert.equal((await get()).revision, 0);
  const confirmed = await app.request('/api/plugins/activation', { action: 'activate', revision: 0, confirmed: true, selected: ['agent-md'] });
  assert.equal(confirmed.status, 200);
  assert.equal((await app.request('/api/plugins/persona/import', { plugin: 'agent-md', persona: '虚构纸船管理员' })).status, 200);
  assert.equal((await app.request('/api/plugins/activation', { action: 'update', revision: 1, confirmed: true, selected: [] })).status, 200);
  assert.equal((await app.request('/api/plugins/persona/import', { plugin: 'agent-md', persona: '不应写入' })).status, 409);
  assert.equal((await app.request('/api/plugins/activation', { action: 'update', revision: 2, confirmed: true, selected: ['memory'] })).status, 409);
  const concurrent = await Promise.all([['memory'], ['agent-md']].map(selected => app.request('/api/plugins/activation', {
    action: 'reset', revision: 2, confirmed: true, selected,
  })));
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
  await app.stop(); await app.start();
  const restarted = await get();
  assert.equal(restarted.revision, 3);
  const stored = JSON.parse(await readFile(app.stateFile, 'utf8'));
  assert.equal(stored.settings.companionPersona, '虚构纸船管理员');
  assert.equal(stored.settings.memoryEnabled, true);
  assert.deepEqual(stored.channels, {});
});

test('an in-flight chain result is dropped after disable and the next call never enters gateway', async t => {
  const owner = { transport: 'onebot', id: '123456', scope: null, name: '纸船', boundAt: 1 };
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const deliveries = [];
  let calls = 0;
  const app = await fixture(t, { env: {}, saved: { settings: { dshPlugins: ['chain'] }, owner },
    adapters: { onebot: { configured: true, capabilities: {}, verify: () => true,
      parseEvent: body => body, send: async (_target, message) => { deliveries.push(message.text); } } },
    dshRelay: { configured: true, tools: ['chain_about'], handle: async () => { calls++; entered(); await held; return { text: '过期结果不应发送' }; } },
  });
  const post = id => app.request('/api/onebot/webhook', { id, target: { type: 'c2c', id: owner.id }, text: '插件 chain_about {}' });
  assert.equal((await post('first')).status, 200);
  await started;
  const previous = await (await app.request('/api/plugins/activation')).json();
  assert.deepEqual(previous.selected, ['chain']);
  assert.equal((await app.request('/api/plugins/activation', { action: 'update', revision: previous.revision, confirmed: true, selected: [] })).status, 200);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(deliveries, []);
  assert.equal((await post('second')).status, 200);
  for (let i = 0; i < 30 && !deliveries.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0], /移除|停用/);
  const saved = JSON.parse(await readFile(app.stateFile, 'utf8'));
  assert.deepEqual(saved.owner, owner);
});
