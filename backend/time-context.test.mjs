import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { localTimeContext, prepareTimeContext } from './time-context.mjs';
import { createProviders } from './providers.mjs';
import { createGreeting, createReply, defaultSettings, isQuiet, mergeSettings, nextGreeting, readSettings } from './logic.mjs';
import { replyToOwner } from './owner-chat.mjs';
import { createApp } from './server.mjs';
import { createOneBotAdapter } from './onebot.mjs';
import { ownerChannelKey } from './state.mjs';

const at = value => Date.parse(value);
const prepare = (previous, time, text = '陪我聊一会儿', options = {}) => prepareTimeContext(previous, {
  at: at(time), timeZone: 'Asia/Shanghai', text, ...options,
});

test('local clock uses the stored account timezone and treats 06:00 as morning independently of quiet hours', () => {
  const instant = at('2026-11-18T17:15:00Z');
  assert.deepEqual(localTimeContext(instant, 'Asia/Shanghai'), { timeZone: 'Asia/Shanghai', localDate: '2026-11-19', localTime: '01:15', daypart: 'late-night' });
  assert.deepEqual(localTimeContext(instant, 'America/New_York'), { timeZone: 'America/New_York', localDate: '2026-11-18', localTime: '12:15', daypart: 'afternoon' });
  assert.equal(localTimeContext(at('2026-11-18T22:15:00Z'), 'Asia/Shanghai').daypart, 'morning');
  assert.equal(localTimeContext(instant, 'not-a-timezone').timeZone, 'Asia/Shanghai');
});

test('stored timezone validation falls back safely while invalid patches reject and DST quiet ends remain exact', () => {
  assert.equal(readSettings({ timeZone: 'not-a-timezone' }).timeZone, 'Asia/Shanghai');
  assert.equal(readSettings({ timeZone: null }).timeZone, 'Asia/Shanghai');
  assert.equal(mergeSettings({}, { timeZone: 'America/New_York' }).timeZone, 'America/New_York');
  for (const timeZone of [null, '', 'invalid', '+08:00', 'x'.repeat(81)]) assert.throws(() => mergeSettings({}, { timeZone }), /时区/u);
  const settings = { ...defaultSettings, timeZone: 'America/New_York', afterMinutes: 1, quietEnd: '06:30' };
  for (const [now, end] of [
    ['2027-03-14T06:30:00Z', '2027-03-14T10:30:00Z'],
    ['2026-11-01T04:30:00Z', '2026-11-01T11:30:00Z'],
  ]) {
    const due = nextGreeting({ lastUserAt: at(now) - 60_000 }, settings, at(now));
    assert.equal(due, at(end));
    assert.equal(isQuiet(due - 1, settings), true);
    assert.equal(isQuiet(due, settings), false);
  }
});

test('daytime conversation carries smoothly into the first late turn without a new arrival greeting', () => {
  const day = prepare(null, '2026-11-18T22:50:00+08:00');
  assert.equal(day.context.nightCue, 'none');
  const night = prepare(day.state, '2026-11-18T23:00:00+08:00');
  assert.equal(night.context.nightCue, 'first');
  assert.equal(night.context.continuing, true);
  assert.equal(night.state.activeMs, 0);
  assert.equal(prepare(night.state, '2026-11-18T23:05:00+08:00').context.nightCue, 'none');
});

test('only real continuous activity permits one optional reminder, across midnight and restart', () => {
  let result = prepare(null, '2026-11-18T23:30:00+08:00');
  assert.equal(result.context.nightCue, 'first');
  const cues = [];
  for (let minute = 15; minute <= 120; minute += 15) {
    result = prepareTimeContext(JSON.parse(JSON.stringify(result.state)), {
      at: at('2026-11-18T23:30:00+08:00') + minute * 60_000, timeZone: 'Asia/Shanghai', text: '继续聊聊纸船吧',
    });
    cues.push(result.context.nightCue);
  }
  assert.deepEqual(cues, ['none', 'none', 'none', 'reminder', 'none', 'none', 'none', 'none']);
  assert.equal(result.state.activeMs, 3_600_000);
  assert.equal(result.state.nightKey, '2026-11-18');
  assert.equal(prepare(result.state, '2026-11-19T23:30:00+08:00').context.nightCue, 'first');
});

test('a return after hours of silence does not invent an hour of ongoing conversation', () => {
  const first = prepare(null, '2026-11-18T00:10:00+08:00');
  const returned = prepare(first.state, '2026-11-18T03:10:00+08:00');
  assert.equal(returned.context.nightCue, 'none');
  assert.equal(returned.context.continuing, false);
  assert.equal(returned.state.activeMs, 0);
  assert.equal(returned.state.turns, 1);
});

test('night work, deadlines and distress take priority without retaining their words or inferring a profile', () => {
  for (const text of ['我今晚要上夜班', '我还在赶方案', '我正在赶ddl', '我有点难过', '心烦', '我现在有危险']) {
    const first = prepare(null, '2026-11-18T01:00:00+08:00', text);
    assert.equal(first.context.nightCue, 'none', text);
    assert.equal(first.context.remindersSuppressed, true, text);
    assert.equal(first.state.muted, false);
    assert.doesNotMatch(JSON.stringify(first.state), /夜班|方案|ddl|难过|危险/u);
    const continued = prepare(first.state, '2026-11-18T01:15:00+08:00');
    assert.equal(continued.context.nightCue, 'none');
    assert.equal(continued.context.remindersSuppressed, true);
    assert.equal(prepare(continued.state, '2026-11-18T23:30:00+08:00').context.nightCue, 'first');
  }
  assert.equal(prepare(null, '2026-11-18T01:00:00+08:00', '我朋友今晚要上夜班').context.nightCue, 'first');
});

test('tonight-only boundaries expire while an explicit future request remains muted until owner allows it', () => {
  for (const text of ['今晚别催我睡觉', '今天别提醒我', '不用再提醒我睡觉', '以后再聊那个计划。今晚别催我睡觉']) {
    const quiet = prepare(null, '2026-11-18T01:00:00+08:00', text);
    assert.equal(quiet.context.nightCue, 'none');
    assert.equal(quiet.state.muted, false);
    assert.equal(prepare(quiet.state, '2026-11-18T23:30:00+08:00').context.nightCue, 'first');
  }
  const forever = prepare(null, '2026-11-18T01:00:00+08:00', '以后不要催我睡觉');
  assert.equal(forever.state.muted, true);
  const next = prepare(forever.state, '2026-11-18T23:30:00+08:00');
  assert.equal(next.context.nightCue, 'none');
  const allowed = prepare(next.state, '2026-11-18T23:40:00+08:00', '以后可以再提醒我休息');
  assert.equal(allowed.state.muted, false);
  assert.equal(allowed.state.suppressed, false);
  assert.equal(prepare(allowed.state, '2026-11-19T23:30:00+08:00').context.nightCue, 'first');
});

test('ineligible technical, search and command turns cannot consume the first cue or accumulate duration', () => {
  const skipped = prepare(null, '2026-11-18T01:00:00+08:00', '查一下资料', { eligible: false });
  assert.equal(skipped.state, null);
  assert.equal(skipped.context.nightCue, 'none');
  const first = prepare(skipped.state, '2026-11-18T01:01:00+08:00');
  assert.equal(first.context.nightCue, 'first');
  const unchanged = prepare(first.state, '2026-11-18T03:00:00+08:00', '测试语音', { eligible: false });
  assert.deepEqual(unchanged.state, first.state);
  assert.equal(prepare(unchanged.state, '2026-11-18T03:01:00+08:00').state.activeMs, 0);
  const sanitized = prepare({ ...first.state, extra: 'must not persist' }, '2026-11-18T01:02:00+08:00');
  assert.equal(sanitized.state.extra, undefined);
});

test('the real provider prompt receives local clock and the one-turn cue without changing persona or adding model calls', async () => {
  const requests = [];
  const providers = createProviders({ AI_BASE_URL: 'https://model.example.test/v1', AI_MODEL: 'fixture' }, {
    fetchImpl: async (_url, { body }) => { requests.push(JSON.parse(body)); return Response.json({ choices: [{ message: { content: '有点晚啦，那只小鸟还站在窗台上呢。' } }] }); },
  });
  const settings = { ...defaultSettings, timeZone: 'Asia/Shanghai', companionPersona: '原样保留的虚构纸船管理员。' };
  const first = await replyToOwner({ providers, settings, messages: [], text: '陪我聊一会儿', at: at('2026-11-18T01:00:00+08:00') });
  assert.equal(requests.length, 1);
  assert.equal(first.timeState.firstHandled, true);
  assert.match(requests[0].messages[0].content, /"localTime":"01:00"/u);
  assert.match(requests[0].messages[0].content, /本夜第一次适合留意时间/u);
  assert.ok(requests[0].messages[0].content.includes(JSON.stringify({ name: '小宇', persona: settings.companionPersona })));
  await replyToOwner({ providers, settings, messages: [], text: '那只小鸟还在呀', timeState: first.timeState, at: at('2026-11-18T01:05:00+08:00') });
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages[0].content, /这一轮没有休息提醒任务/u);
  await createGreeting(providers, settings, [], { at: at('2026-11-18T06:45:00+08:00') });
  assert.equal(requests.length, 3);
  assert.match(requests[2].messages[0].content, /"localTime":"06:45","daypart":"morning"/u);
});

test('demo replies apply only the cue selected by policy and do not nag after suppression', async () => {
  const providers = createProviders({});
  const settings = { ...defaultSettings, timeZone: 'Asia/Shanghai' };
  const first = prepare(null, '2026-11-18T01:00:00+08:00');
  assert.match((await createReply(providers, settings, [], '你好', { timeContext: first.context })).text, /已经挺晚啦/u);
  const second = prepare(first.state, '2026-11-18T01:05:00+08:00');
  assert.doesNotMatch((await createReply(providers, settings, [], '你好', { timeContext: second.context })).text, /晚啦|歇会|睡觉/u);
  const busy = prepare(null, '2026-11-18T01:00:00+08:00', '我正在赶方案');
  assert.doesNotMatch((await createReply(providers, settings, [], '你好', { timeContext: busy.context })).text, /晚啦|歇会|睡觉/u);
});

test('signed owner ingress persists the per-owner cue across restart and privacy clear removes it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yuban-local-time-'));
  const file = join(directory, 'state.json');
  const owner = { transport: 'onebot', id: '123456', scope: null, name: '纸船', boundAt: 1 };
  const secret = 'synthetic-time-webhook-secret';
  let now = at('2026-11-18T06:00:00Z'); // 01:00 New York; machine timezone is irrelevant.
  await writeFile(file, JSON.stringify({ settings: { timeZone: 'America/New_York' }, owner, channels: {} }));
  const inputs = [];
  const deliveries = [];
  const adapter = createOneBotAdapter({ apiBase: 'https://onebot.example.test', accessToken: 'synthetic-outgoing-token', webhookSecret: secret,
    fetchImpl: async (_url, { body }) => { deliveries.push(JSON.parse(body)); return Response.json({ status: 'ok', retcode: 0, data: { message_id: 1 } }); } });
  let server;
  let tick;
  let origin;
  async function start() {
    ({ server, tick } = createApp({ env: {}, stateFile: file, clock: () => now, adapters: { onebot: adapter },
      providers: { reply: async input => { inputs.push(input); return { text: '我在呀。' }; } },
      fetchImpl: async () => assert.fail('no extra upstream request') }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  await start();
  let sequence = 0;
  const thread = async () => JSON.parse(await readFile(file, 'utf8')).channels[ownerChannelKey(owner)];
  async function message(text) {
    const before = deliveries.length;
    const raw = JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 987654,
      user_id: Number(owner.id), time: Math.floor(now / 1000), message_id: ++sequence, message: text });
    const response = await fetch(origin + '/api/onebot/webhook', { method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'X-Signature': `sha1=${createHmac('sha1', secret).update(raw).digest('hex')}` } });
    assert.equal(response.status, 200);
    for (let i = 0; i < 100 && deliveries.length === before; i++) await delay(3);
    assert.equal(deliveries.length, before + 1);
  }
  await message('在吗');
  assert.equal(inputs[0].timeContext.localTime, '01:00');
  assert.equal(inputs[0].timeContext.timeZone, 'America/New_York');
  assert.equal(inputs[0].timeContext.nightCue, 'first');
  assert.equal((await thread()).timeState.firstHandled, true);
  await close(); now += 5 * 60_000; await start();
  await message('在吗');
  assert.equal(inputs[1].timeContext.nightCue, 'none');
  assert.equal((await thread()).timeState.lastAt, now);
  await message('清空记忆');
  assert.equal(inputs.length, 2);
  assert.equal((await thread()).timeState, null);
  await message('在吗');
  assert.equal(inputs[2].timeContext.nightCue, 'first');
  const before = deliveries.length;
  await tick();
  assert.equal(deliveries.length, before, 'no new nighttime unsolicited sends');
});
