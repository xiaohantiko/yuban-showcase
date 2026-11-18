import assert from 'node:assert/strict';
import test from 'node:test';
import { groundedReply } from './grounded-reply.mjs';
import { createProviders } from './providers.mjs';
import { createReply, defaultSettings } from './logic.mjs';

const at = Date.parse('2026-11-18T03:00:00Z');
const user = (text, stamp = at) => ({ role: 'user', text, at: stamp });
const assistant = text => ({ role: 'assistant', text, at });
const timeContext = { timeZone: 'Asia/Shanghai' };
const check = (answer, messages, memoryContext) => groundedReply(answer, messages, { timeContext, memoryContext });

test('a neutral activity does not establish a feeling, including hedged and implied subjects', () => {
  const input = [user('刚在手帐上画了一张小地图。')];
  for (const claim of ['你心情不错嘛，还有闲心画画。', '看起来挺开心。', '今天心情挺好的嘛。', '应该是挺悠闲、挺有兴致的状态吧。', '比昨晚轻松多了吧。']) {
    assert.equal(check(`小地图留个角落画指南针就很酷。\n\n${claim}`, input), '小地图留个角落画指南针就很酷。', claim);
    assert.match(check(claim, input), /什么感觉呀[？]/u);
  }
});

test('an unanswered recall asks an open question, while the verifiable half of a mixed answer survives', () => {
  const messages = [user('刚把那个手工相册取名叫晴窗。'), assistant('我猜你喜欢上这种心情了吧？'), user('我的相册叫什么，当时的感受呢？')];
  const result = check('相册叫「晴窗」。\n\n你没细说，不过愿意慢慢挑名字，应该是宽宽舒舒的状态吧。', messages);
  assert.match(result, /相册叫「晴窗」/u);
  assert.match(result, /什么感觉呀？/u);
  assert.doesNotMatch(result, /宽宽舒舒|状态吧/u);
  assert.equal(check('你那时一定是暖洋洋的吧。', [user('我当时究竟是什么感觉？')]), '你那会儿是什么感觉呀？');
});

test('warmth about the event or the companion and non-presupposing questions can pass unchanged', () => {
  const messages = [user('上台说话时被打断了。')];
  for (const text of ['被那样打断，确实会不好受。', '我真替你高兴。', '当时你是什么感觉？', '如果你有点担心，也可以慢慢来。', '这件事让人难过。', '我倒是挺好奇你画了什么。']) {
    assert.equal(check(text, messages), text);
  }
});

test('owner evidence can support a fact or correction but not a quote, question, denial, unrelated event or an assistant guess', () => {
  const response = '你当时挺开心的。';
  assert.equal(check(response, [user('我当时很开心。')]), response);
  assert.equal(check(response, [assistant('你当时挺开心的，对吗？'), user('没错。')]), response);
  assert.equal(check('你并不开心。', [user('我并不开心。')]), '你并不开心。');
  assert.equal(check(response, [user('我画完地图很开心。'), user('那张地图让我是什么心情？')]), response);
  for (const messages of [
    [assistant('你当时肯定很开心。'), user('那会儿我是什么心情？')],
    [user('朋友昨天很开心。'), user('我当时的感受呢？')],
    [user('小说里我说“我当时很开心”。'), user('那会儿我是什么心情？')],
    [user('我没有说我当时很开心。'), user('那会儿我感觉怎样？')],
    [user('我很开心吗？')],
    [user('我当时很开心。'), user('刚才说错了，我当时并不开心。')],
    [user('我玩飞盘的时候很开心。'), user('我在家看书了。')],
  ]) assert.doesNotMatch(check(response, messages), /挺开心/u, JSON.stringify(messages));
});

test('a present event, a different day, undated observations and old assistant turns cannot license a dated mood claim', () => {
  const reply = '你昨晚很开心。';
  const old = at - 3 * 86_400_000;
  for (const data of [
    [user('我很开心。', old), user('我的心情怎么样？')],
    [assistant('我们昨晚聊得很开心。'), user('昨天心情如何？')],
    [user('熬夜做了个纸模型。'), user('你知道我昨晚心情吗？')],
  ]) assert.doesNotMatch(check(reply, data, { notes: ['我很开心'] }), /昨晚很开心/u);
  assert.equal(check(reply, [user('我昨晚很开心。'), user('我昨晚的心情怎样？')]), reply);
});

test('the actual model adapter meters one request and keeps valid bubbles when the model adds a mood guess', async () => {
  let calls = 0;
  const providers = createProviders({ AI_BASE_URL: 'https://example.com/v1', AI_MODEL: 'fixture' }, {
    fetchImpl: async () => { calls++; return Response.json({ choices: [{ message: { content: '这个名字很像一家旧书铺。\n\n你心情挺好的吧？' } }] }); },
  });
  const result = await createReply(providers, defaultSettings, [], '我给手工作品取名叫灯下。', { at, timeContext });
  assert.equal(result.text, '这个名字很像一家旧书铺。');
  assert.equal(calls, 1);
});

test('a mixed recall has separate time scopes and retains explicit feelings even outside the vocabulary', () => {
  const prompt = '贴纸现在叫什么，我自己说当时是什么感受？';
  for (const mood of ['有点得意', '挺踏实的', '的感受是五味杂陈']) {
    const messages = [{ role: 'user', text: `我给贴纸想名字时，我${mood}。对了，贴纸的名字改成星苔啦。` }, user(prompt)];
    const reply = `贴纸叫星苔。你当时${mood}。`;
    assert.equal(check(reply, messages), reply);
  }
  const input = '我给书签起名叫青石，我当时的心情呢？';
  const reply = '青石，这个刚说过。至于心情，我不太清楚，要不要说说？';
  assert.equal(check(reply, [user(input)]), reply);
  const past = [user('昨晚我有点难过。', at - 10_000), user('你还记得我昨晚是怎么说的吗？')];
  assert.equal(check('你说昨晚有点难过。', past), '你说昨晚有点难过。');
});

test('ordinary greetings and proactive notices also filter present-mood assumptions without a second request', async () => {
  let calls = 0;
  const providers = createProviders({ AI_BASE_URL: 'https://example.com/v1', AI_MODEL: 'fixture' }, {
    fetchImpl: async () => { calls++; return Response.json({ choices: [{ message: { content: '你今天心情肯定不错。' } }] }); },
  });
  assert.doesNotMatch((await providers.reply({ messages: [user('你好')] })).text, /心情|什么感觉/u);
  for (const messages of [[], [user('以前我很开心。')]]) {
    assert.doesNotMatch((await providers.greeting({ messages })).text, /心情|肯定|什么感觉/u);
  }
  assert.equal(calls, 3);
  assert.equal(check('你应该吃饭了吧？', [user('到食堂啦。')]), '你应该吃饭了吧？');
  for (const claim of ['今天心情肯定不错！', '你最近应该挺幸福的吧。', '你当时应该挺百感交集的吧。']) {
    assert.doesNotMatch(check(claim, [user('我到车站了。')]), /不错|幸福|百感交集/u);
  }
});

test('a disclosed reaction retains its degree and cannot be extended in time or into current satisfaction', () => {
  const messages = [user('我画邮票那会儿有点自豪。后来把它的名字改成云边。')];
  for (const duration of ['了半天', '了一整天', '了一晚上']) {
    const reply = `「云边」听着好清爽。原来你自豪${duration}，现在满意了吧？`;
    const result = check(reply, messages);
    assert.match(result, /「云边」听着好清爽。原来你有点自豪。/u);
    assert.doesNotMatch(result, /半天|整天|晚上|满意/u);
  }
  assert.equal(check('你当时得意了半天。', [user('我当时得意了半天。')]), '你当时得意了半天。');
  assert.equal(check('那幅画真亮，你整晚都很自豪。', messages), '那幅画真亮，你有点自豪。');
  assert.equal(check('我挺满意这个配色，你现在满意了吧？', [user('我当时挺满意的。')]), '我挺满意这个配色。');
  assert.equal(check('你很满意。', [user('我现在很满意。')]), '你很满意。');
  assert.equal(check('你对这个配色满意吗？', [user('我画了一张票。')]), '你对这个配色满意吗？');
});

test('the companion may express her own view without inventing the user’s thoughts or motives', () => {
  const messages = [user('那套书签叫风铃，我选名字时有点得意。')];
  const fact = '书签叫风铃。你说那会儿有点得意。';
  for (const guess of ['我猜你肯定觉得这个词听着很响，然后才定下来。', '你心里一定在想总算起对了吧。', '多半是想留住那个画面吧。']) {
    assert.equal(check(`${fact}\n\n${guess}`, messages), fact);
  }
  const own = '我觉得这个名字很衬那套书签。';
  assert.equal(check(own, messages), own);
  const actual = '我猜你觉得这名字有夏天的味道。';
  assert.equal(check(actual, [user('我当时觉得这名字有夏天的味道。')]), actual);
  assert.doesNotMatch(check(actual, [user('朋友说我觉得这名字有夏天的味道。')]), /猜你觉得/u);
  assert.doesNotMatch(check(actual, [user('我当时觉得这名字有夏天的味道。'), user('我不是觉得这名字有夏天的味道。')]), /猜你觉得/u);
});
