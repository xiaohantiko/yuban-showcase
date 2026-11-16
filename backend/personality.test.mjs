import assert from 'node:assert/strict';
import test from 'node:test';
import { evolvePersonality, handleMemoryCommand, memoryContextFor, observeMemory, readMemory } from './memory.mjs';
import { validatePersonalityObservation } from './personality.mjs';

const allowed = { allowed: true, privateChat: true };
const optedIn = () => handleMemoryCommand(undefined, '开启记忆', allowed).memory;
const pair = (user, assistant) => [{ role: 'user', text: user }, { role: 'assistant', text: assistant }];
const learn = (memory, text, messages, providers, options = allowed) => evolvePersonality(observeMemory(memory, text, options), {
  text, messages, providers, ...options,
});

test('personality needs repeated reciprocal turns and never stores their wording', async () => {
  let memory = optedIn();
  const examples = [
    ['我今天有点委屈。', '我在听，你可以慢慢说。', '是啊，被同事误会的时候尤其难受。'],
    ['我想吐槽一件糟心事。', '听着就挺难，你想说的话慢慢说。', '确实，等我讲到后面你就知道了。'],
    ['今天心情不好。', '那会儿肯定不好受，想说就说。', '对呀，尤其吃饭的时候还是很难过。'],
  ];
  for (const [index, [user, assistant, text]] of examples.entries()) {
    memory = await learn(memory, text, pair(user, assistant));
    if (index < 2) assert.equal(memoryContextFor(memory, allowed), undefined);
  }
  assert.deepEqual(memoryContextFor(memory, allowed), {
    traits: [], notes: [], personality: [{ context: 'venting', trait: 'listening' }],
  });
  assert.doesNotMatch(JSON.stringify(memory), /同事|吃饭|糟心/);
  assert.match(handleMemoryCommand(memory, '查看记忆', allowed).text, /回复习惯：倾诉时先听我说/);
  assert.equal(memoryContextFor(memory, { ...allowed, privateChat: false }), undefined);
  assert.equal(memoryContextFor(handleMemoryCommand(memory, '清空记忆', allowed).memory, allowed), undefined);

  const duplicate = await learn(memory, examples[0][2], [...pair(...examples[0].slice(0, 2)), ...pair(examples[0][2], '好。')]);
  assert.deepEqual(duplicate, memory);
  assert.equal((await learn(undefined, examples[0][2], pair(...examples[0].slice(0, 2)))).enabled, false);
});

test('affection and disagreement cues require reciprocity, and explicit correction deactivates immediately', async () => {
  let memory = optedIn();
  memory = await learn(memory, '嘿嘿，我也觉得不错。', pair('早上喝了奶茶。', '贴贴，做我的恋人吧。'));
  assert.equal(memoryContextFor(memory, allowed), undefined);

  for (const variant of ['一', '二', '三']) {
    memory = await learn(memory, `好耶，再来贴贴。今天第${variant}次。`, pair(`今天想贴贴一下，第${variant}次。`, '给你一个软乎乎的贴贴。'));
    memory = await learn(memory, `对，这就是我的意思，第${variant}个小问题讲清了。`, pair(`你误会我的意思了，第${variant}个点。`, '我重新说一下，按你的意思分开看。'));
  }
  const active = memoryContextFor(memory, allowed).personality;
  assert.ok(active.some(cue => cue.context === 'affection' && cue.trait === 'playful'));
  assert.ok(active.some(cue => cue.context === 'disagreement' && cue.trait === 'practical'));

  let sampled = false;
  memory.personality.turns = 4;
  const messages = ['一', '二', '三', '四'].flatMap(variant => pair(`我想贴贴，第${variant}次。`, '软乎乎的贴贴。'));
  memory = await learn(memory, '不要撒娇了。', messages, {
    async learnPersonality() { sampled = true; return { signals: [{ context: 'affection', trait: 'playful' }] }; },
  });
  assert.equal(sampled, false);
  assert.deepEqual(memoryContextFor(memory, allowed).personality, [{ context: 'disagreement', trait: 'practical' }]);
});

test('a local and semantic observation of the same cue count once in a turn', async () => {
  const previous = [
    ...pair('天气不错。', '有空可以出去走走。'),
    ...pair('我刚看完书。', '读到哪儿了？'),
    ...pair('现在想做个计划。', '先说说目标。'),
    ...pair('我该怎么开始？', '可以先整理材料，再列出一件想做的事。'),
  ];
  const memory = { ...optedIn(), personality: { scores: {}, turns: 4 } };
  const learned = await learn(memory, '那我先把材料整理出来。', previous, {
    async learnPersonality() { return { signals: [{ context: 'planning', trait: 'practical' }] }; },
  });
  assert.equal(learned.personality.scores.planning.practical, 1);
});

test('semantic personality sampling skips search and greetings, validates outputs, and is gated by opt-in', async () => {
  const messages = [
    ...pair('查一下极光怎么形成', '这是检索结果。'),
    ...pair('一个没有来源指令的问句', '另一条检索结果。').map(message => message.role === 'assistant' ? { ...message, sources: [{ url: 'https://example.com' }] } : message),
    ...pair('刚才聊了早晨的事情。', '今天早晨过得怎么样？'),
    { role: 'assistant', kind: 'greeting', text: '我是主动问候。' },
    ...pair('后来我去散步了。', '那应该是个不错的片刻。'),
    ...pair('我想把下午的事说一下。', '可以慢慢说。'),
    ...pair('我刚刚把书翻到下一章。', '那一章是怎样的？'),
  ];
  const calls = [];
  const providers = {
    async learnPersonality({ messages }) {
      calls.push(messages);
      return { signals: [{ context: 'casual', trait: 'gentle' }, { context: 'affection', trait: 'playful' }] };
    },
  };
  let memory = optedIn();
  for (const text of ['今天聊点别的。', '我想到一个故事。', '换一种方式也行。', '这个话题先放这里。']) {
    memory = await learn(memory, text, messages, providers);
  }
  assert.equal(calls.length, 0);
  memory = await learn(memory, '我还想继续说刚才那一段。', messages, providers);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 9);
  assert.doesNotMatch(JSON.stringify(calls[0]), /检索结果|极光|主动问候/);
  assert.equal(memory.personality.scores.casual.gentle, 1);
  assert.equal(memory.personality.scores.affection, undefined);
  assert.equal(memoryContextFor(memory, allowed), undefined);

  memory.personality.turns = 4;
  const disabled = await learn(memory, '这条不应该触发学习。', messages, providers, { ...allowed, allowed: false });
  assert.deepEqual(disabled, memory);
  const sensitive = await learn(memory, '我的密码是测试。', messages, providers);
  assert.deepEqual(sensitive, memory);
  assert.equal(calls.length, 1);
  const bad = await learn(memory, '分类器失败时照常返回状态。', messages, { async learnPersonality() { throw new Error('fixture'); } });
  assert.equal(bad.personality.scores.casual.gentle, 1);
  assert.equal(bad.personality.turns, 0);
});

test('only recognized bounded profile keys and classifier signals are accepted', () => {
  const valid = { context: 'casual', trait: 'gentle' };
  assert.deepEqual(validatePersonalityObservation({ signals: [valid] }), [valid]);
  for (const candidate of [
    { signals: [valid, valid] }, { signals: [{ ...valid, quote: 'do not store' }] },
    { signals: [{ context: 'venting', trait: 'playful' }] }, { signals: [valid], note: 'do not store' },
  ]) assert.deepEqual(validatePersonalityObservation(candidate), []);
  const imported = readMemory({ ...optedIn(), personality: { turns: 99, scores: { casual: { gentle: 999, arbitrary: 9 }, secret: { note: 100 } } } });
  assert.deepEqual(imported.personality, { turns: 4, scores: { casual: { gentle: 6 } } });
});
