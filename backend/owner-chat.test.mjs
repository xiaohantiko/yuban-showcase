import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSettings } from './logic.mjs';
import { startMemoryLearning } from './memory.mjs';
import { replyToOwner } from './owner-chat.mjs';

test('an explicit alias correction reaches the same reply without recalling its retired alias', async () => {
  const original = '以后我们把周三整理书桌叫扫星星吧。';
  const correction = '刚才那个名字我说错了，以后我们把周三整理书桌叫扫月亮，扫星星这个说法作废。';
  const memory = startMemoryLearning({ enabled: true, notes: [], scores: {} }, {
    text: original, messages: [], providers: { modelConfigured: false }, allowed: true, privateChat: true, at: 1,
  }).memory;
  let input;
  const turn = await replyToOwner({
    providers: { modelConfigured: false, async reply(value) { input = value; return { text: '好，改成扫月亮。' }; } },
    settings: defaultSettings, messages: [], text: correction, memory, at: 2,
  });
  assert.deepEqual(input.memoryContext.moments, [{ kind: 'inside-joke', evidence: '我们把周三整理书桌叫扫月亮' }]);
  assert.equal(input.messages.at(-1).text, correction);
  assert.deepEqual(turn.memory.shared.moments.map(({ evidence }) => evidence), ['我们把周三整理书桌叫扫月亮']);
  assert.deepEqual(memory.shared.moments.map(({ evidence }) => evidence), [original.slice(0, -1)]);
  assert.equal(turn.reply.text, '好，改成扫月亮。');
  assert.equal(turn.completion, null);
});
