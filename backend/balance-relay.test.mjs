import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from './server.mjs';

async function fixture(t, { proactive = false } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'yuban-balance-relay-'));
  const stateFile = join(folder, 'state.json');
  const env = { YUBAN_ADMIN_TOKEN: 'fixture-balance-admin-token-00000000',
    AI_BASE_URL: 'https://api.deepseek.com', AI_MODEL: 'deepseek-flash', AI_API_KEY: 'fixture-balance-key',
    QQ_APP_ID: '123456', QQ_CLIENT_SECRET: 'fixture-qq-secret' };
  let now = Date.parse('2026-11-18T02:00:00Z');
  let amount = '4.99';
  let balanceCalls = 0;
  let proactiveAttempts = 0;
  let failProactive = false;
  let failSupplement = false;
  let balanceGate;
  let sequence = 0;
  let app;
  let origin;
  const deliveries = [];
  const inputs = [];
  const spoken = [];
  const providers = {
    modelConfigured: true,
    async reply(input) { inputs.push(input); return { text: '正常聊天回复。' }; },
    async greeting() { return { text: '在干嘛呀？' }; },
    async audio(text) { spoken.push(text); return { bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/wav' }; },
  };
  const adapter = {
    configured: true, capabilities: { proactive },
    verify: (_raw, headers) => headers['x-fixture-signature'] === 'signed',
    parseEvent: ({ id, text, contact = 'first-owner' }) => ({ id, text, target: { type: 'c2c', id: contact, messageId: id } }),
    async send(target, body) {
      if (body.proactive) {
        proactiveAttempts++;
        if (failProactive) throw Object.assign(new Error('fixture proactive quota'), { status: 403 });
      }
      if (body.sequence === 2 && failSupplement) throw new Error('fixture supplemental send failure');
      deliveries.push({ target: { ...target }, ...body });
      return { messageId: 'fixture-outbound', voice: Boolean(body.audio) };
    },
  };
  async function close() { if (app?.server.listening) await new Promise(resolve => app.server.close(resolve)); }
  async function start() {
    await close();
    app = createApp({ env, stateFile, providers, adapters: { qq: adapter }, clock: () => now,
      fetchImpl: async (url, options) => {
        balanceCalls++;
        assert.equal(String(url), 'https://api.deepseek.com/user/balance');
        assert.equal(options.method, 'GET');
        if (balanceGate) await balanceGate;
        return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: amount }] });
      } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    origin = `http://127.0.0.1:${app.server.address().port}`;
  }
  await start();
  t.after(async () => { await close(); await rm(folder, { recursive: true, force: true }); });
  const admin = (path, method = 'GET', body) => fetch(origin + path, { method,
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`yuban:${env.YUBAN_ADMIN_TOKEN}`).toString('base64')}` },
    body: body === undefined ? undefined : JSON.stringify(body) });
  async function message(text, contact = 'first-owner') {
    const before = deliveries.length;
    const response = await fetch(origin + '/api/qq/webhook', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fixture-Signature': 'signed' },
      body: JSON.stringify({ id: String(++sequence), text, contact }) });
    assert.equal(response.status, 200);
    for (let attempt = 0; attempt < 50 && deliveries.length === before; attempt++) await delay(5);
    assert.ok(deliveries.length > before, 'the normal reply arrives without waiting for a balance query');
    await delay(0);
    return deliveries.slice(before);
  }
  async function bind(contact = 'first-owner') {
    const issued = await (await admin('/api/owner/code', 'POST', {})).json();
    await message(issued.command, contact);
  }
  const status = async () => (await admin('/api/balance')).json();
  return { env, providers, deliveries, inputs, spoken, admin, message, bind, start, status,
    origin: () => origin, tick: () => app.tick(), advance: value => { now += value; },
    amount: value => { amount = value; }, calls: () => balanceCalls, proactiveAttempts: () => proactiveAttempts,
    holdBalance: promise => { balanceGate = promise; },
    failProactive: value => { failProactive = value; }, failSupplement: value => { failSupplement = value; },
    disk: async () => JSON.parse(await readFile(stateFile, 'utf8')) };
}

test('a real cached low balance reaches only the bound private owner once and survives restart', async (t) => {
  const app = await fixture(t);
  assert.equal((await fetch(app.origin() + '/api/balance')).status, 401);
  assert.equal((await app.status()).status, 'not-checked');
  assert.equal(app.calls(), 0);
  assert.equal((await app.admin('/api/balance/refresh', 'POST', { apiKey: 'untrusted' })).status, 400);
  await app.bind();
  await app.tick();
  assert.equal(app.calls(), 1);
  const stranger = await app.message('你好', 'stranger');
  assert.doesNotMatch(stranger[0].text, /五块|零钱/);
  const first = await app.message('你好。');
  assert.equal(first.length, 1);
  assert.match(first[0].text, /^正常聊天回复。/);
  assert.match(first[0].text, /五块/);
  assert.doesNotMatch(first[0].text, /API|DeepSeek|余额/);
  assert.equal((await app.status()).notification.notified, true);
  assert.equal((await app.status()).totalBalance, '4.99');
  assert.equal((await app.message('接着聊吧。'))[0].text, '正常聊天回复。');
  await app.start();
  assert.equal((await app.message('重启之后继续聊。'))[0].text, '正常聊天回复。');
  const [thread] = Object.values((await app.disk()).channels);
  assert.ok(thread.messages.every(({ text }) => !/五块|零钱/.test(text)));
  app.amount('5.00');
  app.advance(15 * 60_000);
  await app.tick();
  assert.equal((await app.status()).low, false);
  app.amount('0.12');
  app.advance(15 * 60_000);
  await app.tick();
  assert.match((await app.message('我回来啦。'))[0].text, /五块/);
});

test('a denied proactive notice stays pending for one normal private reply without repeated wakeups', async (t) => {
  const app = await fixture(t, { proactive: true });
  app.failProactive(true);
  await app.bind();
  await app.message('先聊一会儿。');
  await app.admin('/api/settings', 'PATCH', { enabled: false, quietEnabled: false, companionName: '林悦', companionPersona: '你是温柔的邻家姐姐。' });
  await Promise.all([app.tick(), app.tick()]);
  assert.equal(app.proactiveAttempts(), 1);
  assert.equal((await app.status()).notification.pending, true);
  app.advance(15 * 60_000);
  await app.tick();
  assert.equal(app.proactiveAttempts(), 1);
  const [reply] = await app.message('我又回来啦。');
  assert.match(reply.text, /正常聊天回复。/);
  assert.match(reply.text, /林悦/);
  assert.match(reply.text, /五块/);
  assert.equal((await app.status()).notification.notified, true);
  assert.equal(app.deliveries.filter(({ proactive }) => proactive).length, 0);
});

test('voice remains intact while a failed text supplement retries on the next ordinary reply', async (t) => {
  const app = await fixture(t);
  await app.bind();
  await app.tick();
  await app.admin('/api/settings', 'PATCH', { voiceReplies: true });
  app.failSupplement(true);
  const first = await app.message('用语音陪我聊聊。');
  assert.equal(first.length, 1);
  assert.ok(first[0].audio);
  assert.deepEqual(app.spoken, ['正常聊天回复。']);
  assert.equal((await app.status()).notification.pending, true);
  app.failSupplement(false);
  const voice = await app.message('再说一句吧。');
  assert.equal(voice.length, 2);
  assert.ok(voice[0].audio);
  assert.equal(voice[1].sequence, 2);
  assert.equal(voice[0].target.messageId, voice[1].target.messageId);
  assert.match(voice[1].text, /五块/);
  assert.equal((await app.status()).notification.notified, true);
  assert.equal((await app.message('继续。')).length, 1);
});

test('a key replacement during an ordinary reply suppresses the old balance without losing chat', async (t) => {
  const app = await fixture(t);
  await app.bind();
  await app.tick();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  app.providers.reply = async () => { started.resolve(); await release.promise; return { text: '正常聊天回复。' }; };
  const reply = app.message('等你回我。');
  await started.promise;
  app.env.AI_API_KEY = 'fixture-replacement-balance-key';
  release.resolve();
  assert.equal((await reply)[0].text, '正常聊天回复。');
  assert.equal((await app.status()).status, 'not-checked');
  const changed = await app.admin('/api/balance/refresh', 'POST', {});
  assert.equal(changed.status, 202);
  for (let attempt = 0; attempt < 50 && (await app.status()).status !== 'ok'; attempt++) await delay(5);
  assert.match((await app.message('现在再聊。'))[0].text, /五块/);
});

test('a proactive notification sends once even when companion check-ins are disabled', async (t) => {
  const app = await fixture(t, { proactive: true });
  await app.bind();
  await app.message('先聊一句。');
  await app.admin('/api/settings', 'PATCH', { enabled: false, quietEnabled: false });
  await Promise.all([app.tick(), app.tick()]);
  const notifications = app.deliveries.filter(({ proactive }) => proactive);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].target.id, 'first-owner');
  assert.match(notifications[0].text, /五块/);
  assert.equal((await app.status()).notification.notified, true);
  assert.equal((await app.message('我回来啦。'))[0].text, '正常聊天回复。');
  await app.start();
  await app.tick();
  assert.equal(app.deliveries.filter(({ proactive }) => proactive).length, 1);
});

test('an in-flight balance query never delays the current private conversation', async (t) => {
  const app = await fixture(t);
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  app.holdBalance(release.promise);
  await app.bind();
  const checking = app.tick();
  for (let attempt = 0; attempt < 50 && app.calls() === 0; attempt++) await delay(5);
  assert.equal(app.calls(), 1);
  assert.equal((await app.message('余额查询还在等，但我想接着聊天。'))[0].text, '正常聊天回复。');
  release.resolve();
  await checking;
  assert.match((await app.message('再聊一句。'))[0].text, /五块/);
});
