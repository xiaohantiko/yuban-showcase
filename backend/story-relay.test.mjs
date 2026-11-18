import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from './server.mjs';
import { ownerChannelKey } from './state.mjs';
import { STORY_PAUSE_MS } from './story-turn.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'yuban-story-'));
  const stateFile = join(directory, 'state.json');
  let now = Date.parse('2026-11-18T02:00:00Z');
  const owner = { transport: 'onebot', id: '123456', scope: null, name: '纸船', boundAt: 1 };
  const key = ownerChannelKey(owner);
  await writeFile(stateFile, JSON.stringify({ settings: { quietEnabled: false, afterMinutes: 1 }, owner,
    channels: { [key]: { messages: [], memory: { enabled: true, notes: [] }, optedIn: true, lastUserAt: now } } }));
  const deliveries = [];
  const inputs = [];
  let greetings = 0;
  let server;
  let tick;
  let origin;
  const providers = { reply: async input => { inputs.push(input); return { text: '我听完啦。' }; },
    greeting: async () => { greetings++; return { text: '最近怎么样呀？' }; } };
  const onebot = { configured: true, capabilities: { proactive: true }, verify: () => true,
    parseEvent: body => body, send: async (target, message) => { deliveries.push({ target, ...message }); } };
  async function start() {
    ({ server, tick } = createApp({ env: {}, stateFile, providers, adapters: { onebot }, clock: () => now }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  await start();
  let sequence = 0;
  const disk = async () => JSON.parse(await readFile(stateFile, 'utf8'));
  const thread = async () => (await disk()).channels[key];
  const until = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(3); }
    assert.fail('synthetic local event did not settle');
  };
  const post = async (text, id = `part-${++sequence}`) => {
    const response = await fetch(origin + '/api/onebot/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, text, target: { type: 'c2c', id: owner.id, messageId: id } }) });
    assert.equal(response.status, 200);
    return id;
  };
  const buffer = async text => { const id = await post(text); await until(async () => (await thread()).storyTarget?.messageId === id); return id; };
  const message = async text => { const count = deliveries.length; await post(text); await until(() => deliveries.length > count); };
  return { inputs, deliveries, providers, thread, disk, buffer, message, post, until, start, stop,
    advance: ms => { now += ms; }, tick: () => tick(), greetings: () => greetings };
}

test('Node explicit narration persists across restart, never times out, and invokes one complete model turn', async t => {
  const app = await fixture(t);
  await app.buffer('先别回，我想分几条讲。');
  const long = `开头的小纸船${'沿河慢慢走。'.repeat(430)}最后看到了灯塔`;
  await app.buffer(long);
  await app.stop(); await app.start();
  assert.ok((await app.thread()).storyTurn.parts.join('\n').includes('最后看到了灯塔'));
  app.advance(60 * 60_000);
  await app.tick();
  assert.equal(app.inputs.length, 0);
  assert.equal(app.deliveries.length, 0);
  assert.equal(app.greetings(), 0);
  await app.message('我说完了，你怎么看？');
  assert.equal(app.inputs.length, 1);
  const text = app.inputs[0].messages.at(-1).text;
  assert.ok(text.length > 2000);
  assert.match(text, /先别回.*\n开头的小纸船/u);
  assert.match(text, /最后看到了灯塔\n我说完了，你怎么看？$/u);
  assert.equal((await app.thread()).storyTurn, null);
  assert.equal(app.deliveries.length, 1);
  await app.tick();
  assert.equal(app.inputs.length, 1);
});

test('Node natural narration debounces new parts, flushes once to latest passive target, and normal chat stays immediate', async t => {
  const app = await fixture(t);
  await app.message('晚上好');
  assert.equal(app.inputs.length, 1);
  assert.equal((await app.thread()).storyTurn, null);
  await app.buffer('我给你讲个事');
  app.advance(4_000);
  const latest = await app.buffer('然后我们绕过小桥，看到了纸船。');
  app.advance(STORY_PAUSE_MS - 1);
  await app.tick();
  assert.equal(app.inputs.length, 1);
  app.advance(1);
  await Promise.all([app.tick(), app.tick()]);
  assert.equal(app.inputs.length, 2);
  assert.equal(app.deliveries.length, 2);
  assert.equal(app.deliveries.at(-1).target.messageId, latest);
  assert.equal(app.inputs.at(-1).messages.at(-1).text, '我给你讲个事\n然后我们绕过小桥，看到了纸船。');
  assert.equal((await app.thread()).storyTurn, null);
});

test('Node detects ordinary consecutive story sentences without an opening or ending instruction', async t => {
  const app = await fixture(t);
  await app.buffer('下班路过花店');
  app.advance(2500);
  await app.buffer('门口趴着一只猫');
  app.advance(4000);
  await app.buffer('店主拿了条毛巾把它裹起来了');
  assert.equal(app.inputs.length, 0);
  const due = (await app.thread()).storyTurn.nextFlushAt;
  const updated = (await app.thread()).storyTurn.updatedAt;
  app.advance(due - updated);
  await app.tick();
  assert.equal(app.inputs.length, 1);
  assert.equal(app.inputs[0].messages.at(-1).text, '下班路过花店\n门口趴着一只猫\n店主拿了条毛巾把它裹起来了');
  assert.equal(app.deliveries.length, 1);
});

test('Node memory controls clear buffered text immediately, cancellation is explicit and interrupted work retains the story', async t => {
  const app = await fixture(t);
  await app.buffer('先别回，我还没讲完。');
  await app.buffer('之前待讲的纸船细节。');
  await app.message('关闭记忆');
  assert.equal((await app.thread()).storyTurn, null);
  assert.equal(app.inputs.length, 0);
  await app.buffer('先别回，我想继续讲。');
  await app.message('算了不讲了');
  assert.equal((await app.thread()).storyTurn, null);
  assert.equal(app.inputs.length, 0);
  await app.buffer('先别回，我要讲一件事。');
  await app.buffer('关键的灯塔段落。');
  const reply = app.providers.reply;
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  app.providers.reply = async () => { entered(); await held; return { text: '不应提交停机后的结果' }; };
  await app.post('说完了');
  await started;
  await app.stop();
  release();
  await delay(5);
  assert.match((await app.thread()).storyTurn.parts.join('\n'), /关键的灯塔段落/u);
  app.providers.reply = reply;
  await app.start();
  await app.message('说完了');
  assert.equal(app.inputs.length, 1);
  assert.match(app.inputs[0].messages.at(-1).text, /关键的灯塔段落/u);
});
