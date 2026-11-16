import assert from 'node:assert/strict';
import test from 'node:test';
import { boundStoredHistory } from './history.mjs';
import { createReply, defaultSettings } from './logic.mjs';

function largeHistory(visibleTail, messages) {
  const raw = Array.from({ length: 10_000 }, (_, index) => messages(index));
  const check = (key) => {
    if (typeof key === 'string' && /^[0-9]+$/.test(key)) assert.ok(Number(key) >= raw.length - visibleTail, 'read a cold message');
  };
  return new Proxy(raw, {
    get(target, key, receiver) { check(key); return Reflect.get(target, key, receiver); },
    has(target, key) { check(key); return Reflect.has(target, key); },
  });
}

test('a long existing history contributes only its newest forty messages to hot storage', () => {
  const history = largeHistory(40, (index) => ({
    role: index % 2 ? 'assistant' : 'user', id: String(index), text: `${'文'.repeat(1999)}🌙尾`,
  }));
  const saved = boundStoredHistory(history);
  assert.equal(saved.length, 40);
  assert.equal(saved[0].id, '9960');
  assert.equal(saved.at(-1).id, '9999');
  assert.equal(saved.at(-1).text, '文'.repeat(1999));
});

test('chat sends a fixed-size recent context even with ten thousand prior messages', async () => {
  const providerInputs = [];
  const providers = { async reply(input) { providerInputs.push(input); return { text: '我在。' }; } };
  const input = '刚刚说到哪儿了？';
  const short = largeHistory(19, (index) => ({ role: index % 2 ? 'assistant' : 'user', text: `聊天 ${index}` }));
  const long = largeHistory(19, (index) => ({ role: index % 2 ? 'assistant' : 'user', text: `${index}${'呀'.repeat(1996)}` }));
  await createReply(providers, defaultSettings, short, input);
  await createReply(providers, defaultSettings, long, input);
  assert.equal(providerInputs[0].messages.length, 20);
  assert.equal(providerInputs[0].messages[0].text, '聊天 9981');
  assert.equal(providerInputs[1].messages.reduce((size, message) => size + message.text.length, 0), 6000);
  for (const { messages } of providerInputs) assert.deepEqual(messages.at(-1), { role: 'user', text: input });
});
