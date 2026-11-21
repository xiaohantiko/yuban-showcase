import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followupMessages, planFollowup } from './followup.mjs';
import { companionGreeting, validGreeting } from './companion.mjs';
import { createGreeting } from './logic.mjs';
import { createProviders } from './providers.mjs';

const minute = 60_000;
const anchor = Date.parse('2026-11-20T13:00:00+08:00');
const settings = { enabled: true, timeZone: 'Asia/Shanghai', quietEnabled: true, quietStart: '23:00', quietEnd: '06:30' };
const open = '我还没讲完，后面有个彩蛋。';
function exchange(final = open, gap = 3, at = anchor) {
  const samples = [
    ['今天听了首新歌，前奏很特别。', '哪件乐器最抓你？'],
    ['电吉他一响我就喜欢上了。', '我也喜欢有点沙沙的吉他声。'],
    [final, '你最喜欢听哪一段呀？'],
  ];
  return { optedIn: true, lastUserAt: at, messages: samples.flatMap(([user, reply], i) => {
    const sent = at - (samples.length - 1 - i) * gap * minute;
    return [{ role: 'user', text: user, at: sent }, { role: 'assistant', text: reply, at: sent }];
  }) };
}

test('adaptive timing uses completed reciprocal turns and the recent human pace', () => {
  const quick = planFollowup(exchange(), settings, anchor);
  const slower = planFollowup(exchange(open, 15), settings, anchor);
  assert.deepEqual(quick, { anchor, stage: 1, reason: 'open', dueAt: anchor + 15 * minute, expiresAt: anchor + 70 * minute });
  assert.ok(slower.dueAt > quick.dueAt);
  assert.equal(planFollowup(exchange(), settings, quick.expiresAt), null);
  const conversation = planFollowup(exchange('我更喜欢吉他这段，感觉很好听。'), settings, anchor);
  assert.equal(conversation.reason, 'conversation');
  assert.equal(conversation.dueAt, anchor + 30 * minute);
  const short = exchange(); short.messages = short.messages.slice(-4);
  assert.ok(planFollowup(short, settings, anchor));
  assert.equal(planFollowup(exchange('拿杯水，一会儿回来接着讲。'), settings, anchor).reason, 'open');
  assert.equal(planFollowup(exchange('没想到他真的把气球藏起来了。'), settings, anchor).reason, 'conversation');
  short.messages = short.messages.slice(-2);
  assert.equal(planFollowup(short, settings, anchor), null);
});

test('busy, goodbyes, short replies, administrative actions, pending stories and one-sided messages cannot trigger a nudge', () => {
  for (const ending of ['明天再聊呀。', '今晚我准备睡了。', '我先去开会啦，晚点再说。', '我还没讲完，不过别等我。', '等我回你，再接着说。', '过两天再说吧。', '我去开会，等我忙完。', '我去睡了，晚安。', '今天天气多少度？', '我想一个人待会儿。', '谢谢你。', '嗯嗯', '关闭主动找我']) {
    assert.equal(planFollowup(exchange(ending), settings, anchor), null, ending);
  }
  const base = exchange();
  for (const thread of [
    { ...base, optedIn: false }, { ...base, storyTurn: { mode: 'narrative' } }, { ...base, lastUserAt: anchor + minute },
    { ...base, messages: base.messages.filter(m => m.role === 'assistant') },
    { ...base, messages: base.messages.slice(0, -1) },
    { ...base, messages: [...base.messages.slice(0, -1), { ...base.messages.at(-1), kind: 'search' }] },
    { ...base, messages: [...base.messages, { role: 'system', text: 'system event', at: anchor }] },
    { ...base, messages: [...base.messages.slice(0, -1), { ...base.messages.at(-1), text: '那你先去忙，明天再聊。' }] },
  ]) assert.equal(planFollowup(thread, settings, anchor + minute), null);
  assert.equal(planFollowup(base, { ...settings, enabled: false }, anchor), null);
  assert.equal(planFollowup(exchange('我觉得这首歌很好听。', 50), settings, anchor), null);
});

test('only a confirmed first delivery for a genuinely unfinished exchange can lead to one more message', () => {
  const thread = exchange();
  const first = planFollowup(thread, settings, anchor);
  thread.attemptedFor = anchor;
  assert.equal(planFollowup(thread, settings, first.dueAt), null);
  thread.followup = { anchor, stage: 1, at: first.dueAt, delivered: false };
  assert.equal(planFollowup(thread, settings, first.dueAt), null);
  thread.followup.delivered = true;
  const second = planFollowup(thread, settings, first.dueAt);
  assert.equal(second.stage, 2);
  assert.equal(second.dueAt, first.dueAt + 120 * minute);
  assert.equal(planFollowup(thread, settings, anchor + 5 * 60 * minute), null);
  assert.equal(planFollowup({ ...exchange('我更喜欢这首歌。'), followup: thread.followup }, settings, second.dueAt), null);
  thread.followup.stage = 2;
  assert.equal(planFollowup(thread, settings, second.dueAt), null);
  const late = Date.parse('2026-11-20T23:55:00+08:00');
  assert.equal(planFollowup(exchange(open, 3, late), settings, late + 16 * minute), null);
  const dawn = Date.parse('2026-11-21T05:55:00+08:00');
  assert.equal(planFollowup(exchange(open, 3, dawn), settings, dawn + 35 * minute), null);
});

test('an errand keeps only an actual unfinished turn; a third person or a new day never inherits it', () => {
  const conversation = exchange();
  const after = anchor + minute;
  const add = (thread, user, reply, at) => ({ ...thread, lastUserAt: at,
    messages: [...thread.messages, { role: 'user', text: user, at }, { role: 'assistant', text: reply, at }] });
  const water = add(conversation, '我去接杯水。', '好呀，慢慢来。', after);
  assert.equal(planFollowup(water, settings, after).reason, 'open');
  const closed = add(exchange('这个笑话就说到这里。'), '我去接杯水。', '好呀，慢慢来。', after);
  assert.equal(planFollowup(closed, settings, after), null);
  for (const ending of ['我还没讲完，不过我接个电话。', '我在想另一个事，刚才的就不说了。', '旁边的人还没讲完呢。']) {
    assert.equal(planFollowup(exchange(ending), settings, anchor), null, ending);
  }
  const nextDay = anchor + 24 * 60 * minute;
  const weather = add(water, '今天这里天气咋样？', '预报大概十二度。', nextDay);
  assert.equal(planFollowup(weather, settings, nextDay), null);
  assert.deepEqual(followupMessages(weather.messages, { anchor: nextDay }, settings.timeZone, nextDay)
    .map(m => m.text), ['今天这里天气咋样？', '预报大概十二度。']);

  const justAfterMidnight = Date.parse('2026-11-21T00:01:00+08:00');
  const separate = exchange(open, 4, justAfterMidnight);
  assert.equal(planFollowup(separate, { ...settings, quietEnabled: false }, justAfterMidnight), null);
  const across = Date.parse('2026-11-20T23:55:00+08:00');
  assert.equal(planFollowup(exchange(open, 4, across), { ...settings, quietEnabled: false }, across), null);
});

test('a second nudge passes its stage through the model and leaves space without guessing about danger', async () => {
  const thread = exchange();
  const plan = { anchor, stage: 2, reason: 'open' };
  let system;
  const providers = createProviders({ AI_BASE_URL: 'https://example.com/v1', AI_MODEL: 'fixture' }, {
    fetchImpl: async (_url, options) => {
      system = JSON.parse(options.body).messages[0].content;
      return Response.json({ choices: [{ message: { content: '你是不是出事了？赶快回我一句。' } }] });
    },
  });
  const result = await createGreeting(providers, settings, thread.messages, { at: anchor + 140 * minute, followupPlan: plan });
  assert.match(system, /上次已经留过一句/u);
  assert.equal(result.kind, 'greeting');
  assert.equal(result.text, companionGreeting({ messages: thread.messages, followupPlan: plan }));
  assert.equal(validGreeting('咦，人呢？刚才那段我还想听。', { followupPlan: { stage: 1 } }), '咦，人呢？刚才那段我还想听。');
  assert.equal(validGreeting('你还在吗？', { followupPlan: plan }), null);
  assert.equal(validGreeting('你是不是出事了？', { followupPlan: { stage: 1 } }), null);
});
