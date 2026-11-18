import assert from 'node:assert/strict';
import test from 'node:test';
import { STORY_PAUSE_MS, dueStory, observeStory } from './story-turn.mjs';
import { deliverReply } from './chat-delivery.mjs';
import { boundedChatContext } from './history.mjs';

test('explicit listening survives a restart, hands off once and leaves commands and ordinary turns to the caller', () => {
  const first = observeStory(null, '先别回复，我想分几条讲。', { now: 1 });
  assert.equal(first.action, 'buffer');
  const second = observeStory(first.state, '同事说自己还没讲完。', { now: 3 });
  assert.equal(dueStory(second.state, 99_000), null);
  const last = observeStory(JSON.parse(JSON.stringify(second.state)), '我讲完了，你怎么看？', { now: 400 });
  assert.equal(last.action, 'flush'); assert.match(last.text, /同事说自己还没讲完/);
  assert.equal(last.state, null);
  assert.equal(observeStory(second.state, '算了，不讲了').action, 'cancel');
  assert.equal(observeStory(null, '怎么啦？').action, 'reply');
});

test('natural storytelling debounces the latest part and hands urgent messages through', () => {
  const first = observeStory(null, '我给你讲个故事', { now: 10 });
  const last = observeStory(first.state, '就在车快开走的时候，他回来了', { now: 3000 });
  assert.equal(dueStory(last.state, 3000 + STORY_PAUSE_MS - 1), null);
  assert.match(dueStory(last.state, 3000 + STORY_PAUSE_MS), /车快开走/);
  const urgent = observeStory(last.state, '我现在有危险');
  assert.equal(urgent.action, 'reply'); assert.equal(urgent.state.mode, 'explicit');
  assert.equal(dueStory(urgent.state, 1e9), null);
});

test('story context retains both ends within its bounded prompt budget', () => {
  let state = observeStory(null, '先听我讲，开场有朵花', { now: 0 }).state;
  for (let i = 0; i < 100; i++) state = observeStory(state, String(i) + '树'.repeat(80), { now: i }).state;
  const complete = observeStory(state, '我说完了，最后是一朵云。');
  assert.ok(complete.text.length <= 6000);
  assert.match(complete.text,/开场有朵花/); assert.match(complete.text,/最后是一朵云/);
  assert.equal(boundedChatContext([],complete.text,{story:true})[0].text,complete.text);
});

test('personal QQ text sends bounded ordered bubbles and the notice exactly once', async () => {
  const sent=[];
  const message={text:'先说第一件事。\n\n再说第二件。\n\n第三件。\n\n还有个结尾。',kind:'chat'};
  const options={adapter:{send:async (target,body)=>{sent.push(body);return {voice:false};}}, target:{type:'c2c'},
    message,text:message.text,isCurrent:async()=>true,notice:'余额提醒'};
  await deliverReply(options);
  assert.deepEqual(sent.map(s=>s.sequence??1),[1,2,3]);
  assert.deepEqual(sent.map(s=>s.text),['先说第一件事。','再说第二件。','第三件。\n\n还有个结尾。\n\n余额提醒']);
  sent.length=0;
  assert.equal(await deliverReply({...options,isCurrent:async()=>false}),null);
  assert.equal(sent.length,1);
  sent.length=0;
  await deliverReply({...options,message:{...message,kind:'search'}});
  assert.equal(sent.length,1);
});

test('ordinary events need no opening phrase, closing phrase, or command', () => {
  const first = observeStory(null, '下班路过花店', {now:100});
  assert.equal(first.action,'buffer');
  let state = observeStory(first.state, '门口趴着一只猫', {now:4200}).state;
  state = observeStory(state, '店主拿了条毛巾把它裹起来了', {now:9800}).state;
  assert.equal(dueStory(state,state.nextFlushAt - 1),null);
  assert.equal(dueStory(state,state.nextFlushAt),'下班路过花店\n门口趴着一只猫\n店主拿了条毛巾把它裹起来了');
  assert.equal(observeStory(null,'今天心烦。').action,'reply');
  assert.equal(observeStory(null,'你能陪我聊会儿吗？').action,'reply');
});

test('short neutral observations get a brief pause while contact, feelings and direct requests stay immediate', () => {
  for (const text of ['窗台上有只鸟', '翅膀还挂着雨水', '桌上多了一张纸条']) {
    const first = observeStory(null, text, { now: 100 });
    assert.equal(first.action, 'buffer', text);
    assert.equal(first.state.mode, 'narrative');
    assert.equal(first.state.nextFlushAt, 3100);
    assert.equal(dueStory(first.state, 3099), null);
    assert.equal(dueStory(first.state, 3100), text);
  }
  const first = observeStory(null, '窗台上有只鸟', { now: 0 });
  const second = observeStory(first.state, '翅膀还挂着雨水', { now: 2000 });
  assert.equal(dueStory(second.state, second.state.nextFlushAt), '窗台上有只鸟\n翅膀还挂着雨水');
  for (const text of ['在吗', '你在不在', '嗨', '我回来了', '晚安', '好累', '有点难过', '有点烦', '抱抱', '我今天很想你',
    '陪我一会儿', '你能陪我聊会儿吗', '听我说说', '你叫什么', '你是谁', '你今天怎么样', '说说你自己', '这是什么意思', '今天吃什么',
    '请帮我查预算', '你会帮我查预算吗', '今晚别催我睡觉', '今天别提醒', '以后不要提醒我睡觉']) {
    assert.equal(observeStory(null, text).action, 'reply', text);
  }
});

test('casual listening prefaces stay automatic while only explicit strict waits need a handoff', () => {
  for (const text of ['你听我说，下午我经过花店', '听我讲啊，窗台上有只鸟', '先听我说，店主把猫抱起来了']) {
    const result = observeStory(null, text, { now: 10 });
    assert.equal(result.action, 'buffer', text);
    assert.equal(result.state.mode, 'narrative', text);
    assert.equal(dueStory(result.state, result.state.nextFlushAt), text);
  }
  for (const text of ['先别回复，我慢慢讲', '等我讲完再回', '先听我说完']) {
    const result = observeStory(null, text, { now: 10 });
    assert.equal(result.state.mode, 'explicit', text);
    assert.equal(dueStory(result.state, 1e9), null);
  }
});

test('a quoted story question does not release the buffer but a direct handoff does', () => {
  const first = observeStory(null, '你听我说，下午我经过花店', { now: 10 });
  const quoted = observeStory(first.state, '她问我，你觉得呢？', { now: 20 });
  assert.equal(quoted.action, 'buffer');
  const quotedAgain = observeStory(quoted.state, '店主说：「你怎么看？」', { now: 30 });
  assert.equal(quotedAgain.action, 'buffer');
  const handed = observeStory(quotedAgain.state, '你觉得呢？', { now: 40 });
  assert.equal(handed.action, 'flush');
  assert.match(handed.text, /她问我，你觉得呢？\n店主说：「你怎么看？」\n你觉得呢？$/u);
  assert.equal(observeStory(first.state, '你会帮我查预算吗', { now: 30 }).action, 'flush');
  assert.equal(observeStory(first.state, '我想问，你今天开心吗？', { now: 30 }).action, 'flush');
});

test('obvious urgent help bypasses buffering and preserves prior text without an automatic interruption', () => {
  const state = observeStory(null, '窗台上有只鸟', { now: 0 }).state;
  for (const text of ['快叫救护车', '救命', '着火了', '我这会不安全', '我现在有危险']) {
    const result = observeStory(state, text, { now: 20 });
    assert.equal(result.action, 'reply', text);
    assert.equal(result.text, text);
    assert.deepEqual(result.state.parts, state.parts);
    assert.equal(result.state.mode, 'explicit');
    assert.equal(result.state.nextFlushAt, null);
  }
});
