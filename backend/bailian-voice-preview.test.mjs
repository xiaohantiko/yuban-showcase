import assert from 'node:assert/strict';
import { test } from 'node:test';
import { designVoicePreview, PreviewError, validateDesignPreview } from './bailian-voice-preview.mjs';

const target = 'qwen-audio-3.1-tts-flash';
const voiceId = `${target}-vd-yuban-fixture42`;
const example = {
  apiKey: crypto.randomUUID(), workspaceId: 'ws-example',
  description: '音色清亮，语尾带笑，语速从容。',
  previewText: '外面天刚放晴，我们下楼走一小圈怎么样？',
};

function wave(sampleBytes = 8) {
  const bytes = Buffer.alloc(44 + sampleBytes);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24);
  bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(sampleBytes, 40);
  return bytes;
}

function output(bytes = wave()) {
  return {
    target_model: target, voice_id: voiceId,
    preview_audio: { data: bytes.toString('base64'), sample_rate: 24_000, response_format: 'wav' },
  };
}

test('one Beijing enrollment returns only its own preview and identifier', async () => {
  for (const [workspaceId, hostname, language, previewText] of [
    ['ws-example', 'ws-example.cn-beijing.maas.aliyuncs.com', 'zh', example.previewText],
    [undefined, 'dashscope.aliyuncs.com', 'en', 'How about a walk in the sunshine?'],
  ]) {
    let requests = 0;
    const data = { ...example, workspaceId, previewText, url: 'https://example.com', chatKey: crypto.randomUUID() };
    const result = await designVoicePreview(data, { fetchImpl: async (url, options) => {
      requests++;
      assert.equal(url.href, `https://${hostname}/api/v1/services/audio/tts/customization`);
      assert.deepEqual(options.headers, { Authorization: `Bearer ${example.apiKey}`, 'Content-Type': 'application/json' });
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'manual');
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(options.body), {
        model: 'voice-enrollment',
        input: { action: 'create_voice', target_model: target, prefix: 'yuban', voice_prompt: example.description,
          preview_text: previewText, language_hints: [language] },
        parameters: { response_format: 'wav', sample_rate: 24_000 },
      });
      return Response.json({ output: output(), request_id: 'private-trace', usage: { count: 1 } });
    } });
    assert.deepEqual(result, { bytes: new Uint8Array(wave()), contentType: 'audio/wav', voiceId });
    assert.equal(requests, 1);
  }
});

test('a design response may omit the target-model echo only when the design ID and full preview still match', async () => {
  const bytes = wave(24_000 * 2 * 10); // Ten seconds of synthetic silence.
  const { voice_id, preview_audio } = output(bytes);
  const minimal = { voice_id, preview_audio };
  const preview = data => designVoicePreview(example, { fetchImpl: () => Response.json({ output: data }) });
  assert.deepEqual(await preview(minimal), { bytes: new Uint8Array(bytes), contentType: 'audio/wav', voiceId });
  for (const bad of [
    { ...minimal, target_model: 'different-model' }, { ...minimal, target_model: null }, { ...minimal, target_model: '' },
    { ...minimal, voice_id: 'another-model-vd-yuban-fixture42' },
    { ...minimal, voice_id: `${target}-vd-other-fixture42` },
    { ...minimal, preview_audio: { ...preview_audio, data: bytes.subarray(0, -2).toString('base64') } },
    { ...minimal, preview_audio: { data: preview_audio.data, response_format: 'wav' } },
  ]) await assert.rejects(preview(bad), { status: 502 });
});

test('form validation trims, counts code points and rejects malformed inputs before sending any credentials', async () => {
  const normalized = validateDesignPreview({ ...example, workspaceId: undefined, description: '  好  ', extra: 'ignored' });
  assert.deepEqual(normalized, { ...example, workspaceId: '', description: '好' });
  for (const [field, value] of [
    ['apiKey', ''], ['apiKey', 'a\nb'], ['apiKey', 'a'.repeat(513)],
    ['workspaceId', null], ['workspaceId', 'https://example.com'], ['workspaceId', 'a.b'],
    ['workspaceId', 'a'.repeat(64)], ['workspaceId', '-ws'], ['workspaceId', 'user@host'],
    ['description', ' \n '], ['description', '中'.repeat(501)], ['description', 'これは日本語です'],
    ['previewText', 'abcde'], ['previewText', '英'.repeat(201)], ['previewText', 'x'.repeat(15) + '\u0000text'],
  ]) {
    let requests = 0;
    await assert.rejects(designVoicePreview({ ...example, [field]: value }, { fetchImpl: () => { requests++; } }),
      error => error.status === 400 && !error.message.includes(example.apiKey));
    assert.equal(requests, 0);
  }
  const edge = { ...example, description: '𠀀'.repeat(500), previewText: '𠀀'.repeat(200) };
  assert.deepEqual(validateDesignPreview(edge), edge);
  assert.doesNotThrow(() => validateDesignPreview({ ...example, previewText: 'e'.repeat(15) }));
});

test('redirects, service errors and fetch exceptions never leak upstream text or trigger a retry', async () => {
  for (const [status, expected] of [[307, 502], [400, 400], [401, 401], [403, 403], [429, 429], [500, 500], [0, 502]]) {
    let requests = 0;
    let canceled = 0;
    const result = designVoicePreview(example, { fetchImpl: async () => {
      requests++;
      if (!status) throw Object.assign(new Error(example.apiKey), { status: 400 });
      return new Response(new ReadableStream({
        pull() { assert.fail('the error body must be discarded'); },
        cancel() { canceled++; },
      }, { highWaterMark: 0 }), { status, headers: { Location: 'https://example.com' } });
    } });
    await assert.rejects(result, error => error.status === expected && !error.message.includes(example.apiKey));
    assert.equal(requests, 1);
    assert.equal(canceled, status ? 1 : 0);
  }
});

test('known DashScope errors preserve HTTP status with a local action and never expose upstream text or request identifiers', async () => {
  for (const [status, code, advice] of [
    [401, 'InvalidApiKey', '通用 API Key'], [401, 'invalid_api_key', '通用 API Key'],
    [403, 'Arrearage', '费用中心'], [403, 'AccessDenied.Unpurchased', '服务尚未开通'],
    [403, 'Model.AccessDenied', 'voice-enrollment'], [403, 'access_denied', '可访问模型范围'],
    [400, 'Workspace.AccessDenied', '空间成员权限'], [404, 'WorkSpaceNotFound', '复制业务空间 ID'],
    [403, 'AllocationQuota.FreeTierOnly', '用完即停'], [429, 'Throttling.RateQuota', '请求频率'],
    [429, 'Throttling.AllocationQuota', '自定义音色数量'], [400, 'InvalidParameter', '15 至 200 字'],
    [404, 'ModelNotFound', 'qwen-audio-3.1-tts-flash'], [400, 'DataInspectionFailed', '输入内容检查'],
    [503, 'ServiceUnavailable', '是否已创建'],
  ]) {
    const detail = { code, message: `${example.apiKey} ${example.previewText}`, request_id: 'private-request-id' };
    for (const body of [detail, { error: detail }]) {
      const operation = designVoicePreview(example, { fetchImpl: () => Response.json(body, { status }) });
      await assert.rejects(operation, error => {
        assert.ok(error instanceof PreviewError);
        assert.equal(error.status, status);
        assert.ok(error.message.includes(`HTTP ${status} · ${code}`));
        assert.ok(error.message.includes(advice));
        assert.ok(!error.message.includes(example.apiKey));
        assert.ok(!error.message.includes(example.previewText));
        assert.doesNotMatch(error.message, /private-request-id/);
        assert.deepEqual(Object.keys(error), ['status']);
        return true;
      });
    }
  }
});

test('unknown, malformed or oversized vendor errors fall back to the HTTP status with a bounded read', async () => {
  for (const code of [null, example.apiKey, '__proto__', 'toString', { code: 'InvalidParameter' }]) {
    const attempt = designVoicePreview(example, { fetchImpl: () => Response.json({ code, message: example.apiKey }, { status: 403 }) });
    await assert.rejects(attempt, error => error.status === 403 && /HTTP 403）/.test(error.message)
      && !error.message.includes(example.apiKey));
  }
  let pulls = 0;
  let canceled = 0;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(4096)); },
    cancel() { canceled++; },
  }, { highWaterMark: 0 });
  const attempt = designVoicePreview(example, { fetchImpl: () => new Response(body, { status: 503,
    headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(attempt, error => error.status === 503 && /HTTP 503）/.test(error.message));
  assert.equal(pulls, 3);
  assert.equal(canceled, 1);
  assert.equal(body.locked, false);
});

test('only matching design IDs and complete, playable WAV bytes can reach the client', async () => {
  const invalid = [
    result => { result.voice_id = 'some-other-id'; },
    result => { result.voice_id = `${target}-vd-yuban-`; },
    result => { result.voice_id = `${voiceId}/not-an-id`; },
    result => { result.target_model = 'other-model'; },
    result => { result.preview_audio.data = '@' + result.preview_audio.data.slice(1); },
    result => { result.preview_audio.response_format = 'mp3'; },
    result => { result.preview_audio.sample_rate = 16000; },
    result => { delete result.preview_audio; },
  ];
  for (const modify of [
    b => { b[0] |= 0x80; }, b => b.writeUInt32LE(10, 4), b => b.writeUInt32LE(8, 16),
    b => b.writeUInt16LE(0, 22), b => b.writeUInt32LE(8_000, 24), b => b.writeUInt32LE(96_000, 28),
    b => b.writeUInt32LE(0, 40), b => b.writeUInt32LE(10, 40), b => b.write('junk', 36),
  ]) {
    invalid.push(result => { const bytes = wave(); modify(bytes); result.preview_audio.data = bytes.toString('base64'); });
  }
  for (const modify of invalid) {
    const result = output();
    modify(result);
    await assert.rejects(designVoicePreview(example, { fetchImpl: () => Response.json({ output: result }) }),
      error => error.status === 502 && !error.message.includes(voiceId));
  }
});

test('checks both declared and streamed response limits and releases body readers', async () => {
  for (const useHeader of [true, false]) {
    let pulls = 0;
    let cancellations = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancellations++; },
    }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json', ...(useHeader && { 'Content-Length': '9000000' }) } });
    await assert.rejects(designVoicePreview(example, { fetchImpl: () => response }), { status: 502 });
    assert.equal(cancellations, 1);
    assert.equal(pulls, useHeader ? 0 : 6);
    assert.equal(response.body.locked, false);
  }
});

test('canceling after request submission or during the body stops once and preserves the unknown creation outcome', async () => {
  for (const duringBody of [false, true]) {
    const controller = new AbortController();
    let requests = 0;
    let cancellations = 0;
    const attempt = designVoicePreview(example, { signal: controller.signal, fetchImpl: (_url, { signal }) => {
      requests++;
      if (!duringBody) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error(example.apiKey)), { once: true });
          queueMicrotask(() => controller.abort());
        });
      }
      return new Response(new ReadableStream({
        pull() { queueMicrotask(() => controller.abort()); },
        cancel() { cancellations++; },
      }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json' } });
    } });
    await assert.rejects(attempt, error => error.status === 504 && /是否已经生成/.test(error.message));
    assert.equal(requests, 1);
    assert.equal(cancellations, duringBody ? 1 : 0);
  }
});

test('the provider deadline is applied even when a caller supplies no abort signal', async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', ms => {
    assert.equal(ms, 55_000);
    return controller.signal;
  });
  let requests = 0;
  const result = designVoicePreview(example, { fetchImpl: (_url, { signal }) => {
    requests++;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      queueMicrotask(() => controller.abort());
    });
  } });
  await assert.rejects(result, { status: 504 });
  assert.equal(requests, 1);
});
