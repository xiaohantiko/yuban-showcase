import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReply, defaultSettings, mergeSettings, readSettings } from './logic.mjs';
import { requestedVoice } from './voice-replies.mjs';
import { visibleSettings } from './weather.mjs';

const at = Date.parse('2026-11-20T16:00:00+08:00');
const minute = 60_000;
const settings = mergeSettings(defaultSettings, { voiceReplyMode: 'occasionally', companionName: '小晴' });
function history(count = 4, end = at, gap = 2 * minute) {
  return Array.from({ length: count }, (_, i) => {
    const when = end - (count - i) * gap;
    return [{ role: 'user', text: '这段旋律你觉得如何？', at: when },
      { role: 'assistant', text: '鼓声很轻，听着挺舒服。', at: when }];
  }).flat();
}
async function turn(input, options = {}) {
  const providers = { voiceAvailable: true, reply: async () => ({ text: '好呀，那我轻声跟你说一句。' }), ...options.providers };
  return createReply(providers, options.settings ?? settings, options.messages ?? history(), input, { at, ...options.context });
}

test('voice settings migrate the existing switch and require explicit account consent for speaking with the chat key', () => {
  assert.equal(readSettings({}).voiceReplyMode, 'text');
  assert.equal(readSettings({ voiceReplies: true }).voiceReplyMode, 'voice');
  assert.equal(readSettings({ voiceReplies: false }).voiceReplyMode, 'text');
  assert.equal(readSettings({ useDeepseekVoice: 'true' }).useDeepseekVoice, false);
  const audio = mergeSettings(settings, { voiceReplies: true });
  assert.equal(audio.voiceReplyMode, 'voice');
  const both = mergeSettings(audio, { voiceReplies: true, voiceReplyMode: 'occasionally', useDeepseekVoice: true });
  assert.equal(both.voiceReplies, false);
  assert.equal(both.voiceReplyMode, 'occasionally');
  assert.equal(visibleSettings(readSettings(JSON.parse(JSON.stringify(both)))).useDeepseekVoice, true);
  assert.equal(mergeSettings(both, { useDeepseekVoice: false }).useDeepseekVoice, false);
  assert.throws(() => mergeSettings(settings, { useDeepseekVoice: 1 }), /开关/u);
  assert.throws(() => mergeSettings(settings, { voiceReplyMode: 'sometimes' }), /语音/u);
  assert.throws(() => mergeSettings(settings, { voiceReplies: 'false' }), /语音/u);
});

test('explicit format requests take precedence in every mode and a question about audio stays text', async () => {
  for (const mode of ['text', 'occasionally', 'mixed', 'voice']) {
    const config = mergeSettings(settings, { voiceReplyMode: mode });
    for (const input of ['能用文字说吗？', '先别发语音，我不方便听。', '不要用语音回复']) {
      assert.equal((await turn(input, { settings: config, context: { voice: true } })).voice, undefined, input);
    }
    for (const input of ['发条语音吧', '语音：晚安', '我想听听你的声音', '不用发文字，用语音说晚安', '可以用语音吗？', '能不能来条语音呀', '我想听你用语音和我说晚安']) {
      assert.equal((await turn(input, { settings: config, messages: [] })).voice, true, input);
    }
  }
  for (const input of ['语音识别是什么？', '语音回复设置在哪里？', '他给朋友发了一条语音', '朋友说，发条语音吧。我该怎么回？']) {
    assert.equal(requestedVoice(input), undefined, input);
    assert.equal((await turn(input, { settings: defaultSettings })).voice, undefined, input);
  }
});

test('short shared moments can use occasional audio; reported words, long or private content and quiet hours do not', async () => {
  for (const input of ['我终于把演出门票抢到了，好开心！', '给我打打气', '那我先睡啦，晚安。', '晚安小晴',
    '哈哈哈，这个梗我能笑一天', '笑死我了，刚才那个太好笑了']) {
    assert.equal((await turn(input)).voice, true, input);
  }
  for (const input of ['他说他笑死了', '朋友说：“这个梗我能笑一天。”', '我今天真的开心不起来', '哈哈哈',
    '今天几度？太开心了', '晚安是什么意思？', '找到了我的验证码，好开心。', 'a'.repeat(120) + '，好开心！']) {
    assert.equal((await turn(input)).voice, undefined, input);
  }
  const concrete = '我终于通过了，好开心！';
  assert.equal((await turn(concrete, { messages: history(3) })).voice, undefined);
  assert.equal((await turn(concrete, { messages: history(5).filter(m => m.role === 'assistant') })).voice, undefined);
  assert.equal((await turn(concrete, { context: { story: true } })).voice, undefined);
  assert.equal((await turn(concrete, { context: { mode: 'search' } })).voice, undefined);
  assert.equal((await turn(concrete, { context: { weatherContext: { requested: true } } })).voice, undefined);
  assert.equal((await turn(concrete, { providers: { reply: async () => ({ text: '我想跟你说的话。'.repeat(20) }) } })).voice, undefined);
  assert.equal((await turn(concrete, { providers: { reply: async () => ({ text: '登录密码是一个私密字段。' }) } })).voice, undefined);
  assert.equal((await turn(concrete, { providers: { reply: async () => { throw new Error('offline'); } } })).voice, undefined);
  const night = Date.parse('2026-11-20T23:00:00+08:00');
  assert.equal((await turn('晚安啦', { context: { at: night }, messages: history(6, night) })).voice, undefined);
  assert.equal((await turn('用语音说晚安', { context: { at: night } })).voice, true);
});

test('occasional speech requires a usable authorized provider and respects delivered-audio time and frequency limits', async () => {
  const text = '我终于拿到了，好开心！';
  const cloud = { voiceAvailable: false, voiceConfigured: false, deepseekVoiceAvailable: true };
  assert.equal((await turn(text, { providers: cloud })).voice, undefined);
  assert.equal((await turn(text, { providers: cloud, settings: { ...settings, useDeepseekVoice: true } })).voice, true);
  assert.equal((await turn(text, { providers: { ...cloud, voiceConfigured: true } })).voice, true);
  const deploymentOnly = { voiceAvailable: true, voiceConfigured: true, deepseekVoiceAvailable: false };
  assert.equal((await turn(text, { providers: deploymentOnly, settings: { ...settings, useDeepseekVoice: true } })).voice, undefined);
  assert.equal((await turn(text, { providers: deploymentOnly })).voice, true);
  const recent = history(10);
  const delivered = recent.at(-1);
  delivered.voice = true; delivered.voiceDelivered = true;
  assert.equal((await turn(text, { messages: recent })).voice, undefined);
  delete delivered.voiceDelivered;
  assert.equal((await turn(text, { messages: recent })).voice, undefined, 'preserve old voice history');
  delivered.voiceDelivered = false;
  assert.equal((await turn(text, { messages: recent })).voice, true, 'a confirmed text fallback does not consume a voice slot');

  const earlier = history(8, at, 16 * minute);
  earlier[5].voiceDelivered = true;
  assert.equal((await turn(text, { messages: earlier })).voice, true, 'after 96 minutes and five intervening replies');
  earlier[5].at = at - 89 * minute;
  assert.equal((await turn(text, { messages: earlier })).voice, undefined, '90-minute cooldown');
  earlier[5].voiceDelivered = false;
  earlier.at(-5).voiceDelivered = true; earlier.at(-5).at = at - 120 * minute;
  assert.equal((await turn(text, { messages: earlier })).voice, undefined, 'four intervening ordinary replies also required');
});

test('mixed mode alternates confirmed ordinary turns, including short replies and inbound chats at night', async () => {
  const mixed = mergeSettings(settings, { voiceReplyMode: 'mixed', useDeepseekVoice: true });
  assert.equal(readSettings(mixed).voiceReplyMode, 'mixed');
  assert.equal(mixed.voiceReplies, false);
  const providers = { deepseekVoiceAvailable: false, bailianVoiceSelected: true, bailianVoiceAvailable: true };
  const previous = [], context = { at: Date.parse('2026-11-20T23:40:00+08:00') };
  for (let i = 0; i < 6; i++) {
    const reply = await turn('嗯嗯', { settings: mixed, providers, messages: previous, context });
    assert.equal(Boolean(reply.voice), i % 2 === 0);
    previous.push({ ...reply, voiceDelivered: Boolean(reply.voice) });
    previous.push({ ...reply, kind: 'greeting' }, { ...reply, kind: 'search' }, { ...reply, pendingDelivery: true });
  }
  assert.equal((await turn('现在不方便听，打字就好', { settings: mixed, providers, messages: [] })).voice, undefined);
  const failedMedia = [{ role: 'assistant', text: '好呀', voice: true, voiceDelivered: false }];
  assert.equal((await turn('你好', { settings: mixed, providers, messages: failedMedia })).voice, true);
  for (const input of ['帮我查一下北京的人口', '你那里今天几度？', '验证码发你了']) {
    assert.equal((await turn(input, { settings: mixed, providers, messages: [] })).voice, undefined);
  }
  assert.equal((await turn('怎么啦', { settings: mixed, messages: [],
    providers: { ...providers, deepseekVoiceAvailable: true, bailianVoiceAvailable: false } })).voice, undefined);
});

test('a QQ voice request grounds model capabilities and retains the actual question even after a false refusal', async () => {
  const { createProviders } = await import('./providers.mjs');
  const { replyToOwner } = await import('./owner-chat.mjs');
  const input = '请用语音回答。如果能学一种乐器，小提琴和长笛你想学哪个？';
  async function respond(answers, transport = 'qq', configured = true) {
    const calls = [];
    const providers = createProviders({ AI_BASE_URL: 'https://api.deepseek.com', AI_MODEL: 'fixture',
      AI_API_KEY: 'fixture-chat', ...(configured ? { VOICE_BASE_URL: 'https://example.invalid', VOICE_MODEL: 'fixture', VOICE_NAME: 'fixture' } : {}) },
      { fetchImpl: async (_url, opts) => {
        const messages = JSON.parse(opts.body).messages;
        calls.push(messages);
        return Response.json({ choices: [{ message: { content: answers[calls.length - 1] } }] });
      } });
    const turn = await replyToOwner({ providers, settings: { ...settings, voiceReplyMode: 'mixed' }, transport,
      messages: [], text: input, at });
    assert.ok(calls[0].at(-1).content.includes('小提琴和长笛'));
    return { calls, reply: turn.reply };
  }
  const denial = '我只能打字，不能发语音。';
  const choice = '我想学长笛，喜欢它清亮的声音。';
  const normal = await respond([denial + choice]);
  assert.equal(normal.reply.text, choice);
  assert.equal(normal.reply.voice, true);
  assert.equal(normal.calls.length, 1);
  assert.match(normal.calls[0][0].content, /本轮 QQ 私聊已接入语音/u);
  const retried = await respond([denial, choice]);
  assert.equal(retried.reply.text, choice);
  assert.equal(retried.calls.length, 2);
  const unavailable = await respond([denial], 'qq', false);
  assert.match(unavailable.calls[0][0].content, /尚无可用语音/u);
  assert.equal(unavailable.reply.text, denial);
  const otherChannel = await respond([denial], 'onebot');
  assert.doesNotMatch(otherChannel.calls[0][0].content, /QQ 私聊已接入语音/u);
  assert.equal(otherChannel.reply.text, denial);
});
