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
