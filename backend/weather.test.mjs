import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProviders } from './providers.mjs';
import { replyToOwner } from './owner-chat.mjs';
import { createWeather, setWeatherGrant, visibleSettings, weatherGrantFor, weatherInterest, weatherPermissionCurrent, weatherStatus } from './weather.mjs';

const hour = 3_600_000;
const start = Date.UTC(2026, 10, 20, 8, 5);
const owner = { transport: 'qq', boundAt: 8 };
const input = { enabled: true, consent: true, binding: 8, latitude: 60.04231, longitude: 15.55555 };
const saved = setWeatherGrant({}, owner, input, start, true);
function forecast(now = start, t = 4) {
  const time = Math.floor(now / hour) * hour;
  return { properties: { meta: { updated_at: new Date(time).toISOString(), units: { air_temperature: 'celsius' } },
    timeseries: [time, time + hour].map((at, i) => ({ time: new Date(at).toISOString(),
      data: { instant: { details: { air_temperature: t + i } }, next_1_hours: { summary: { symbol_code: 'lightrain' } } } })) } };
}

test('location consent is explicitly bound, rounded on writes, redacted in snapshots and disabled without fresh consent', () => {
  assert.throws(() => setWeatherGrant({}, owner, input, start, false), { status: 503 });
  assert.throws(() => setWeatherGrant({}, null, input, start, true), { status: 409 });
  assert.throws(() => setWeatherGrant({}, { ...owner, boundAt: 9 }, input, start, true), { status: 409 });
  for (const invalid of [{ consent: false }, { latitude: null }, { latitude: 100 }, { longitude: NaN }, { street: 'unused' }]) {
    assert.throws(() => setWeatherGrant({}, owner, { ...input, ...invalid }, start, true), { status: 400 });
  }
  const grant = weatherGrantFor(saved, owner);
  assert.equal(grant.latitude, 60); assert.equal(grant.longitude, 15.6);
  assert.deepEqual(visibleSettings(saved), {});
  const view = weatherStatus(saved, owner, start, true);
  assert.equal(JSON.stringify(view).includes('latitude'), false);
  assert.equal(view.expiresAt, start + 24 * hour);
  assert.equal(weatherStatus(saved, { ...owner, boundAt: 9 }, start, true).enabled, false);
  assert.equal(weatherPermissionCurrent(saved, grant, owner, start + 24 * hour), false);
  assert.equal(weatherPermissionCurrent({}, grant, owner, start), false);
  const disabled = setWeatherGrant(saved, owner, { enabled: false }, start, false);
  assert.throws(() => setWeatherGrant(disabled, owner, { ...input, expectedUpdatedAt: grant.updatedAt }, start + 1, true), { status: 409 });
  assert.deepEqual(visibleSettings(disabled), {});
  assert.equal(JSON.stringify(disabled).includes('latitude'), false);
  const again = setWeatherGrant(disabled, owner, { ...input, expectedUpdatedAt: null }, start, true);
  assert.ok(again.weatherGrant.updatedAt > grant.updatedAt);
  assert.throws(() => setWeatherGrant(again, owner, { ...input, expectedUpdatedAt: null }, start, true), { status: 409 });
  assert.throws(() => setWeatherGrant(again, owner, { enabled: false, binding: 99 }, start, true), { status: 409 });
});

test('only local questions and outdoor plans use location; bare greetings and named city searches read no grid', async () => {
  let now = start;
  const seen = [];
  const weather = createWeather({ clock: () => now, fetchImpl: async (url, opts) => {
    seen.push({ url, opts });
    return Response.json(forecast(), { headers: { Expires: new Date(start + 2 * hour).toUTCString(), 'Last-Modified': new Date(start).toUTCString() } });
  } });
  const read = (settings, text, options) => weather(settings, owner, text, { providerAvailable: true, ...options });
  for (const text of ['天气不错我真开心', '上海天气怎么样', '帮我查巴黎天气', '今天天气用英语怎么说', '明天气温多少', '哈喽', '你最喜欢哪个季节']) {
    assert.equal(await read(saved, text), null, text);
  }
  assert.equal((await read({}, '外面冷吗')).status, 'off');
  assert.equal(await read({}, '', { proactive: true }), null);
  assert.equal((await weather(saved, owner, '今天天气怎么样')).status, 'unavailable');
  assert.equal(seen.length, 0);
  const [first, second] = await Promise.all([read(saved, '今天要带伞吗'), read(saved, '我准备出门')]);
  assert.equal(first.temperature, 4); assert.equal(second.requested, false);
  assert.equal(first.condition, '有雨'); assert.equal(seen.length, 1);
  assert.deepEqual([...seen[0].url.searchParams], [['lat', '60'], ['lon', '15.6']]);
  assert.equal(JSON.stringify(first).includes('15.6'), false);
  assert.equal(seen[0].opts.redirect, 'error');
  now += hour;
  assert.equal((await read(saved, '现在外面多少度')).temperature, 5);
  assert.equal(seen.length, 1);
  now += 2 * hour;
  assert.equal((await read(saved, '现在几度')).status, 'unavailable');
  assert.ok(seen[1].opts.headers['If-Modified-Since']);
  now = start + 24 * hour;
  assert.equal((await read(saved, '气温多少')).status, 'expired');
  assert.equal(await read(saved, '我刚出门', { proactive: true }), null);
  assert.equal(seen.length, 2);
});

test('calling the companion by name retains local questions; travel to another place never uses the saved grid', async () => {
  let calls = 0;
  const weather = createWeather({ clock: () => start, fetchImpl: async () => { calls++; return Response.json(forecast()); } });
  const settings = { ...saved, companionName: '小晴' };
  for (const text of ['晚上我要去上海跑步', '等会儿我出门去广州', '我在大阪，准备出门', '我要去 Oslo 骑车',
    '姐姐，北京多少度？', '上海，天气怎么样？', '小枫，我这边多少度？']) {
    assert.equal(await weather(settings, owner, text, { providerAvailable: true }), null, text);
    assert.equal(await weather(settings, owner, text, { providerAvailable: true, proactive: true }), null, text);
  }
  assert.equal(calls, 0);
  for (const text of ['小晴，我这边多少度？', '姐姐，今天多少度？', '小晴呀：外面会下雨吗？', '今天天气咋样']) {
    assert.equal((await weather(settings, owner, text, { providerAvailable: true })).requested, true, text);
  }
  assert.equal((await weather(settings, owner, '我准备去楼下跑步', { providerAvailable: true })).requested, false);
  assert.equal(calls, 1);
});

test('provider throttling, old bulletins and bad units fail without guessing or making repeated requests', async () => {
  for (const response of [
    () => new Response(null, { status: 429, headers: { 'Retry-After': '3600' } }),
    () => Response.json(forecast(start - 48 * hour)),
    () => { const data = forecast(); data.properties.meta.units.air_temperature = 'fahrenheit'; return Response.json(data); },
    () => { throw new Error('offline'); },
  ]) {
    let calls = 0;
    const weather = createWeather({ clock: () => start, fetchImpl: async () => { calls++; return response(); } });
    for (let i = 0; i < 2; i++) assert.deepEqual(await weather(saved, owner, '气温多少', { providerAvailable: true }), { status: 'unavailable', requested: true });
    assert.equal(calls, 1);
  }
  assert.equal(weatherInterest('带伞这个词用英语怎么说'), null);
  assert.equal(weatherInterest('我这里现在天气怎么样，多少度呀？'), 'question');
});

test('owner weather questions use authorized forecasts in normal chat instead of external search; no raw grid enters model', async () => {
  const calls = [];
  const providers = createProviders({ AI_BASE_URL: 'https://model.example.test/v1', AI_MODEL: 'sample' }, {
    fetchImpl: async (url, opts) => { calls.push({ url: String(url), body: JSON.parse(opts.body) });
      return Response.json({ choices: [{ message: { content: '大概 4℃，还有雨。出门带上伞呀。' } }] }); }
  });
  const args = { providers, settings: {}, text: '帮我查一下我这边气温多少', messages: [], ownerName: '', at: start };
  const current = { status: 'current', condition: '有雨', temperature: 4, observedAt: start, requested: true };
  const turn = await replyToOwner({ ...args, weatherContext: current });
  assert.equal(turn.searching, false);
  assert.match(turn.reply.text, /4℃/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.messages[0].content, /当前小时的预报/);
  assert.doesNotMatch(JSON.stringify(calls[0].body), /latitude|longitude|60\.04231|15\.55555/);
  for (const status of ['off', 'expired', 'unavailable']) {
    const result = await replyToOwner({ ...args, weatherContext: { status, requested: true } });
    assert.doesNotMatch(result.reply.text, /\d+℃|有雨/);
  }
  assert.equal(calls.length, 1);
});
