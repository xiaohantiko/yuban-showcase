import assert from 'node:assert/strict';
import test from 'node:test';
import { balanceCredentialId, confirmBalanceNotice, prepareBalanceNotice, readModelBalance } from './balance.mjs';

const key = 'test-key';
const env = { AI_BASE_URL: 'https://api.deepseek.com', AI_API_KEY: key, AI_MODEL: 'deepseek-flash' };
const usage = (total_balance, extra = {}) => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance }], ...extra });
const resultFor = (value) => readModelBalance(env, { fetchImpl: async () => Response.json(value), clock: () => 1234 });
const scope = 'synthetic-owner-binding';

test('only explicit official DeepSeek model credentials can request the fixed balance endpoint', async () => {
  const id = await balanceCredentialId(env);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.notEqual(id, await balanceCredentialId({ ...env, AI_API_KEY: key + '-rotated' }));
  assert.equal(id, await balanceCredentialId({ ...env, AI_BASE_URL: 'https://api.deepseek.com/v1/' }));
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(usage('4.99'));
  };
  for (const base of ['https://api.openai.com/v1', 'https://api.deepseek.com.other.invalid', 'https://other.api.deepseek.com',
    'http://api.deepseek.com', 'https://api.deepseek.com:8443', 'https://user:password@api.deepseek.com',
    'https://api.deepseek.com/v1?key=synthetic', 'https://api.deepseek.com/#secret', 'https://api.deepseek.com/other']) {
    assert.equal((await readModelBalance({ ...env, AI_BASE_URL: base }, { fetchImpl })).status, 'unsupported');
  }
  assert.equal(calls, 0);
  for (const value of ['', 'invalid\r\nheader']) {
    assert.equal((await readModelBalance({ ...env, AI_API_KEY: value }, { fetchImpl })).status, 'unconfigured');
  }
  const result = await readModelBalance(env, { fetchImpl, clock: () => 1234 });
  assert.deepEqual(result, { status: 'ok', checkedAt: 1234, credentialId: id, currency: 'CNY', totalBalance: '4.99', low: true, isAvailable: true });
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /test-key/);
});

test('CNY decimal comparison is exact at the five-yuan threshold and never guesses from USD or availability', async () => {
  for (const [input, low, canonical] of [
    ['4.999999999999999999', true, '4.999999999999999999'], ['5.000000000000000000', false, '5.00'],
    ['4.99', true, '4.99'], ['0', true, '0.00'], ['-0.01', true, '-0.01'], ['-0.000', true, '0.00'],
    ['0005.10', false, '5.10'], ['999999999999999999.99', false, '999999999999999999.99'],
  ]) {
    const result = await resultFor(usage(input));
    assert.equal(result.status, 'ok');
    assert.equal(result.totalBalance, canonical);
    assert.equal(result.low, low);
  }
  const mixed = await resultFor(usage('9.00', { is_available: false, balance_infos: [
    { currency: 'USD', total_balance: '0.01' }, { currency: 'CNY', total_balance: '9.00' },
  ] }));
  assert.equal(mixed.low, false);
  assert.equal(mixed.isAvailable, false);
  const usd = await resultFor({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '0.01' }] });
  assert.equal(usd.status, 'unavailable');
  assert.equal(usd.error, 'currency');
  assert.equal(usd.low, undefined);
  for (const input of ['5e-1', 'NaN', '4.1234567890123456789', 4.99, ' 4.99', 'synthetic-private-token']) {
    assert.equal((await resultFor(usage(input))).error, 'invalid-response');
  }
});

test('errors, malformed and oversized bodies are sanitized without fabricating a balance', async () => {
  const secret = 'synthetic-upstream-secret-error';
  const failures = [
    [async () => Response.json({ error: secret }, { status: 401 }), 'authentication'],
    [async () => Response.json({ error: secret }, { status: 403 }), 'forbidden'],
    [async () => Response.json({ error: secret }, { status: 402 }), 'upstream'],
    [async () => Response.json({ error: secret }, { status: 429 }), 'rate-limit'],
    [async () => Response.redirect('https://other.invalid', 307), 'upstream'],
    [async () => { throw new DOMException(secret, 'TimeoutError'); }, 'timeout'],
    [async () => { throw new TypeError(secret); }, 'network'],
    [async () => new Response(secret, { headers: { 'content-type': 'application/json' } }), 'invalid-response'],
    [async () => new Response('{}', { headers: { 'content-type': 'text/plain' } }), 'invalid-response'],
    [async () => Response.json({ ...usage('4.00'), extra: 'x'.repeat(17 * 1024) }), 'invalid-response'],
    [async () => Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }, { currency: 'CNY', total_balance: '2.00' }] }), 'invalid-response'],
  ];
  for (const [fetchImpl, error] of failures) {
    const result = await readModelBalance(env, { fetchImpl });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.error, error);
    assert.equal(result.totalBalance, undefined);
    assert.equal(result.low, undefined);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-upstream-secret|test-key|other\.invalid/);
  }
});

test('a low balance creates one persistent receipt, retries until delivery succeeds, and survives restart', async () => {
  const balance = await resultFor(usage('4.99'));
  const first = prepareBalanceNotice(null, { balance, scope });
  assert.match(first.notice, /聊天用的零钱不到五块了/);
  assert.doesNotMatch(first.notice, /DeepSeek|API|Token|余额|充值|官方|4\.99|个人|钱包/i);
  assert.ok(first.receipt);
  const pending = JSON.parse(JSON.stringify(first.state));
  assert.deepEqual(prepareBalanceNotice(pending, { balance, scope }), first);
  assert.deepEqual(confirmBalanceNotice(pending, 'stale-receipt'), pending);
  const delivered = confirmBalanceNotice(pending, first.receipt);
  assert.equal(delivered.notified, true);
  assert.equal(prepareBalanceNotice(delivered, { balance, scope }).notice, null);
  assert.equal(prepareBalanceNotice(JSON.parse(JSON.stringify(delivered)), { balance, scope }).notice, null);
  assert.doesNotMatch(JSON.stringify(delivered), /test-key|totalBalance|4\.99/);
  assert.deepEqual(Object.keys(delivered).sort(), ['credentialId', 'low', 'notified', 'receipt', 'scope', 'version']);
});

test('recovery, new credentials and owner changes invalidate old receipts while failed reads never create notices', async () => {
  const low = await resultFor(usage('4.99'));
  const high = await resultFor(usage('5.00'));
  const first = prepareBalanceNotice(null, { balance: low, scope });
  const failed = { status: 'unavailable', credentialId: low.credentialId, error: 'network' };
  assert.equal(prepareBalanceNotice(first.state, { balance: failed, scope }).notice, null);
  assert.deepEqual(prepareBalanceNotice(first.state, { balance: failed, scope }).state, first.state);

  const restored = prepareBalanceNotice(first.state, { balance: high, scope }).state;
  assert.equal(restored.low, false);
  assert.equal(confirmBalanceNotice(restored, first.receipt).notified, false);
  const nextLow = prepareBalanceNotice(restored, { balance: low, scope });
  assert.notEqual(nextLow.receipt, first.receipt);
  assert.equal(confirmBalanceNotice(nextLow.state, first.receipt).notified, false);
  assert.ok(nextLow.notice);

  const otherScope = prepareBalanceNotice(first.state, { balance: low, scope: 'new-owner-binding' });
  assert.notEqual(otherScope.receipt, first.receipt);
  assert.equal(confirmBalanceNotice(otherScope.state, first.receipt).notified, false);
  const newCredential = await balanceCredentialId({ ...env, AI_API_KEY: key + '-rotated' });
  const changed = prepareBalanceNotice(first.state, { balance: { ...low, credentialId: newCredential }, scope });
  assert.notEqual(changed.receipt, first.receipt);
  assert.equal(confirmBalanceNotice(changed.state, first.receipt).notified, false);
  assert.equal(prepareBalanceNotice(first.state, { balance: { ...failed, credentialId: newCredential }, scope }).state, null);
  assert.deepEqual(prepareBalanceNotice(first.state, { balance: { status: 'unsupported' }, scope }), { state: null, notice: null, receipt: null });
  assert.deepEqual(prepareBalanceNotice(first.state, { balance: low, scope: null }), { state: null, notice: null, receipt: null });
});

test('only the current account explicit sister persona selects a gentle notice, without exposing or storing its text', async () => {
  const balance = await resultFor(usage('3.2700'));
  const gentle = prepareBalanceNotice(null, { balance, scope,
    companionName: '阿岚', companionPersona: '你是温柔的邻家姐姐。虚构设定中的纸月亮不应进入服务通知。' });
  assert.match(gentle.notice, /^诶，咱们聊天的小零钱是不是快见底啦？阿岚刚看了一眼，连五块都不到了。$/);
  assert.doesNotMatch(gentle.notice, /姐姐|纸月亮|充值|钱包|DeepSeek|API|Token|余额|官方|3\.27|报个数|署名/i);
  assert.doesNotMatch(JSON.stringify(gentle.state), /阿岚|姐姐|纸月亮|companion/);

  for (const companionPersona of ['', '你是简洁的星际导航员。', '你是邻家姐姐，但不要姐姐语气。',
    '你是大姐姐。禁止使用姐姐风格。', 'You are an older sister. Do not use sister tone.']) {
    const neutral = prepareBalanceNotice(gentle.state, { balance, scope,
      companionName: '小椿', companionPersona });
    assert.match(neutral.notice, /^小椿刚看了一眼，聊天用的零钱不到五块了，跟你说一声。$/);
    assert.equal(neutral.receipt, gentle.receipt);
    assert.deepEqual(neutral.state, gentle.state);
    assert.doesNotMatch(neutral.notice, /阿岚|咱们|姐姐|星际/);
  }
  for (const companionName of ['行一\n行二', 'a'.repeat(21), '隐\u200b形', 'DeepSeek', 'API', 'Token', '官方']) {
    assert.match(prepareBalanceNotice(null, { balance, scope, companionName }).notice, /^我刚看了一眼/);
  }
});

test('QQ notices distinguish an exhausted balance without technical words or exposing exact amounts', async () => {
  for (const total of ['0', '-0.000', '-0.01', '-100']) {
    const balance = await resultFor(usage(total));
    for (const companionPersona of ['', '你是大姐姐。']) {
      const { notice } = prepareBalanceNotice(null, { balance, scope, companionName: '阿岚', companionPersona });
      assert.match(notice, /零钱用完/);
      assert.match(notice, /阿岚/);
      assert.doesNotMatch(notice, /不到五块|DeepSeek|API|Token|余额|充值|官方|人民币|\d|姐姐/i);
    }
  }
  const balance = await resultFor(usage('0.000001'));
  assert.match(prepareBalanceNotice(null, { balance, scope }).notice, /不到五块/);
});
