import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_STORED_MESSAGES } from './history.mjs';
import { openState, ownerChannelKey } from './state.mjs';

test('Node keeps one bounded hot conversation and preserves detached generations in private files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'yuban-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const archive = `${file}.archive`;
  const owner = { transport: 'qq', id: 'active', scope: 'bot', boundAt: 3 };
  const key = ownerChannelKey(owner);
  const oldKey = ownerChannelKey({ ...owner, boundAt: 2 });
  const old = { messages: [{ role: 'user', text: '以前的聊天' }], memory: { notes: ['以前的记忆'] }, optedIn: true };
  const memory = { notes: ['当前绑定的记忆'] };
  const many = Array.from({ length: MAX_STORED_MESSAGES + 15 }, (_, index) => ({ role: 'user', id: String(index), text: '旧消息'.repeat(1_000) }));
  const original = { owner, channels: { [key]: { messages: many, memory }, [oldKey]: old } };
  await writeFile(file, JSON.stringify(original));

  // A failed archive write must leave the original hot file recoverable.
  await writeFile(archive, 'not a directory');
  assert.throws(() => openState(file));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
  await rm(archive);

  const { state, save } = openState(file);
  assert.deepEqual(Object.keys(state.channels), [key]);
  const active = state.channels[key];
  assert.equal(active.messages.length, MAX_STORED_MESSAGES);
  assert.equal(active.messages[0].id, '15');
  assert.equal(active.messages[0].text.length, 2_000);
  assert.deepEqual(active.memory, memory);
  const [detachedFile] = await readdir(archive);
  assert.deepEqual(JSON.parse(await readFile(join(archive, detachedFile), 'utf8')), { key: oldKey, thread: old });
  assert.equal((await stat(join(archive, detachedFile))).mode & 0o777, 0o600);

  active.messages.push({ role: 'assistant', text: '最新回复' });
  save();
  assert.equal(state.channels[key], active);
  assert.equal(active.messages.at(-1).text, '最新回复');
  assert.equal(active.messages.length, MAX_STORED_MESSAGES);

  state.owner = { ...owner, boundAt: 4 };
  save();
  assert.deepEqual(Object.keys(state.channels), []);
  const reopened = openState(file).state;
  assert.deepEqual(Object.keys(reopened.channels), []);
  assert.equal((await readdir(archive)).length, 2);
  assert.deepEqual(JSON.parse(await readFile(join(archive, detachedFile), 'utf8')).thread, old);
});
