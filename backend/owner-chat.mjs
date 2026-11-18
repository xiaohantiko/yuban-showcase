import { createReply, searchRequest, voiceRequest } from './logic.mjs';
import { memoryContextFor, observeMemory, startMemoryLearning } from './memory.mjs';
import { lookupText } from './providers.mjs';

export async function replyToOwner({ providers, settings, messages, text, memory, ownerName, at }) {
  const input = text.replace(voiceRequest, '').trim();
  const searching = searchRequest.test(input) || lookupText(input) !== null;
  const conversation = Boolean(input) && !searching;
  const memoryOptions = { allowed: settings.memoryEnabled !== false, privateChat: true };
  const remember = conversation && memoryOptions.allowed && memory?.enabled === true;
  const observed = remember ? observeMemory(memory, input, memoryOptions) : memory;
  const learning = remember ? startMemoryLearning(observed, { ...memoryOptions, text: input, messages, providers, at }) : { memory: observed };
  const reply = createReply(providers, settings, messages, text, {
    at, ownerName, ...(searching ? { mode: 'search' } : {}),
    memoryContext: remember ? memoryContextFor(learning.memory, { ...memoryOptions, query: input }) : undefined,
  });
  // Start the occasional classifier alongside the reply, but delivery never awaits it.
  const completion = learning.completion ? Promise.resolve().then(learning.completion).catch(() => null) : null;
  return { reply: await reply, memory: learning.memory, completion, searching };
}
