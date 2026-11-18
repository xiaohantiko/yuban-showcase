import assert from 'node:assert/strict';
import test from 'node:test';
import { createBalanceMonitor } from './balance-monitor.mjs';

const initialEnv = { AI_BASE_URL: 'https://api.deepseek.com', AI_API_KEY: 'fixture-balance-key', AI_MODEL: 'deepseek-flash' };
const response = value => Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: value }] });

function fixture(fetchImpl) {
  let record = { revision: 0, value: {} };
  let now = Date.parse('2026-11-18T02:00:00Z');
  const env = { ...initialEnv };
  const store = {
    async read() { return structuredClone(record); },
    async compareAndSet(previous, value) {
      if (previous.revision !== record.revision) return false;
      record = { revision: record.revision + 1, value: structuredClone(value) };
      return true;
    },
  };
  const create = () => createBalanceMonitor({ store, getEnv: async () => env, fetchImpl, clock: () => now });
  return { create, env, store, advance: value => { now += value; } };
}

test('balance cache coalesces refreshes and persists one notice per real low-balance period', async () => {
  let calls = 0;
  let amount = '4.99';
  const app = fixture(async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://api.deepseek.com/user/balance');
    assert.equal(options.method, 'GET');
    return response(amount);
  });
  const monitor = app.create();
  assert.equal((await monitor.snapshot('owner-a')).status, 'not-checked');
  assert.equal(calls, 0);
  await Promise.all([monitor.refresh('owner-a'), app.create().refresh('owner-a')]);
  assert.equal(calls, 1);
  assert.equal((await monitor.snapshot('owner-a')).totalBalance, '4.99');
  const first = await monitor.pending('owner-a');
  assert.ok(first);
  assert.equal(await monitor.isCurrent(first), true);
  assert.equal(await monitor.confirm(first), true);
  assert.equal(await app.create().pending('owner-a'), null);
  await monitor.refresh('owner-a', { force: true });
  assert.equal(calls, 1);
  app.advance(60_000);
  amount = '5.00';
  await monitor.refresh('owner-a', { force: true });
  assert.equal((await monitor.snapshot('owner-a')).low, false);
  assert.equal(await monitor.isCurrent(first), false);
  app.advance(60_000);
  amount = '0.12';
  await monitor.refresh('owner-a', { force: true });
  const second = await monitor.pending('owner-a');
  assert.ok(second);
  assert.notEqual(first.receipt, second.receipt);
  assert.equal(await monitor.confirm(first), false);
  assert.equal(await monitor.isCurrent(second), true);
  assert.doesNotMatch(JSON.stringify(await monitor.snapshot('owner-a')), /fixture-balance-key|credentialId/);
});

test('pending notices fail closed on recovery, binding replacement, credential changes and unavailable checks', async () => {
  let amount = '1.25';
  let unavailable = false;
  const app = fixture(async () => unavailable ? new Response(null, { status: 503 }) : response(amount));
  const monitor = app.create();
  await monitor.refresh('owner-a');
  const first = await monitor.pending('owner-a', { proactive: true });
  assert.ok(first);
  assert.equal(await app.create().pending('owner-a', { proactive: true }), null);
  const replacement = await monitor.pending('owner-b');
  assert.ok(replacement);
  assert.equal(await monitor.isCurrent(first), false);
  assert.equal(await monitor.confirm(first), false);
  app.env.AI_API_KEY = 'fixture-new-balance-key';
  assert.equal(await monitor.isCurrent(replacement), false);
  assert.equal(await monitor.pending('owner-b'), null);
  await monitor.refresh('owner-b');
  const newKey = await monitor.pending('owner-b');
  assert.ok(newKey);
  app.advance(60_000);
  unavailable = true;
  await monitor.refresh('owner-b', { force: true });
  assert.equal(await monitor.isCurrent(newKey), false);
  assert.equal(await monitor.pending('owner-b'), null);
  assert.equal((await monitor.snapshot('owner-b')).totalBalance, null);
  app.advance(60_000);
  unavailable = false;
  amount = '9.00';
  await monitor.refresh('owner-b', { force: true });
  assert.equal(await monitor.isCurrent(newKey), false);
});

test('a slow query cannot overwrite a newer credential check', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const app = fixture(async (_url, options) => {
    if (options.headers.Authorization.endsWith('fixture-balance-key')) {
      started.resolve();
      await release.promise;
      return response('1.00');
    }
    return response('8.00');
  });
  const monitor = app.create();
  const checking = monitor.refresh('owner-a');
  await started.promise;
  app.env.AI_API_KEY = 'fixture-new-balance-key';
  await app.create().refresh('owner-a');
  release.resolve();
  assert.equal(await checking, false);
  assert.equal((await monitor.snapshot('owner-a')).totalBalance, '8.00');
  assert.equal(await monitor.pending('owner-a'), null);
});

test('independent tenant stores never share balances or notification receipts', async () => {
  const first = fixture(async () => response('1.25'));
  const second = fixture(async () => response('20.00'));
  second.env.AI_API_KEY = 'fixture-other-tenant-key';
  await Promise.all([first.create().refresh('same-owner-label'), second.create().refresh('same-owner-label')]);
  const ticket = await first.create().pending('same-owner-label');
  assert.ok(ticket);
  assert.equal(await second.create().pending('same-owner-label'), null);
  assert.equal(await second.create().confirm(ticket), false);
  assert.equal((await second.create().snapshot('same-owner-label')).totalBalance, '20.00');
  assert.equal((await first.create().snapshot('same-owner-label')).totalBalance, '1.25');
});
