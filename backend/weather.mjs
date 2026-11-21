const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const providerURL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const agent = 'YubanCompanion/1.0 github.com/xiaohantiko/yuban-showcase';
const degrees = n => Math.round(n * 10) / 10;
const validGrid = (n, limit) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit;
const reject = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function weatherGrantFor(settings, owner) {
  const grant = settings?.weatherGrant;
  if (owner?.transport !== 'qq' || !Number.isSafeInteger(owner.boundAt) || grant?.boundAt !== owner.boundAt
    || !Number.isSafeInteger(grant.updatedAt) || !validGrid(grant.latitude, 90) || !validGrid(grant.longitude, 180)) return null;
  return grant;
}

export function weatherStatus(settings, owner, now, providerAvailable) {
  const grant = weatherGrantFor(settings, owner);
  return { providerAvailable, binding: owner?.transport === 'qq' ? owner.boundAt : null, enabled: Boolean(grant), updatedAt: grant?.updatedAt ?? null, expiresAt: grant ? grant.updatedAt + DAY : null,
    needsRefresh: Boolean(grant && grant.updatedAt + DAY <= now) };
}

export function setWeatherGrant(settings, owner, input, now, providerAvailable) {
  const previous = weatherGrantFor(settings, owner);
  if ('expectedUpdatedAt' in input && input.expectedUpdatedAt !== (previous?.updatedAt ?? null)) {
    reject(409, '位置授权已经改变，请重新打开插件查看。');
  }
  const next = { ...settings };
  if (input.enabled === false && Object.keys(input).every(key => ['enabled', 'expectedUpdatedAt', 'binding'].includes(key))) {
    const binding = owner?.transport === 'qq' ? owner.boundAt : null;
    if ('binding' in input && input.binding !== binding) reject(409, 'QQ 绑定已经改变，请刷新后再撤销。');
    // Retain only the last sequence value, so a same-millisecond regrant cannot revive an old automatic update.
    if (settings.weatherGrant) next.weatherRevision = Math.max(now, settings.weatherGrant.updatedAt);
    delete next.weatherGrant;
    return next;
  }
  if (!providerAvailable) reject(503, '部署者尚未启用天气服务。');
  if (input.enabled !== true || input.consent !== true || !validGrid(input.latitude, 90) || !validGrid(input.longitude, 180)
    || Object.keys(input).some(key => !['enabled', 'consent', 'binding', 'latitude', 'longitude', 'expectedUpdatedAt'].includes(key))) {
    reject(400, '请确认使用大致位置，并提供有效的经纬度。');
  }
  if (owner?.transport !== 'qq' || !Number.isSafeInteger(owner.boundAt) || owner.boundAt !== input.binding) reject(409, '请先绑定本账号的 QQ，或刷新插件后重新确认。');
  next.weatherGrant = { boundAt: owner.boundAt, latitude: degrees(input.latitude), longitude: degrees(input.longitude),
    updatedAt: Math.max(now, (settings.weatherRevision ?? 0) + 1, (previous?.updatedAt ?? 0) + 1) };
  return next;
}

export function weatherPermissionCurrent(settings, expected, owner, now) {
  const grant = weatherGrantFor(settings, owner);
  return Boolean(grant && grant.updatedAt === expected?.updatedAt && grant.latitude === expected.latitude
    && grant.longitude === expected.longitude && grant.updatedAt + DAY > now);
}

export function visibleSettings(settings) {
  const { weatherGrant, weatherRevision, ...visible } = settings;
  return visible;
}

const localPrefix = /^(?:(?:请问|请|能不能|能|你知道|你|帮我|麻烦|给我|看一下|看下|看看|查一下|查查|查下|查|告诉我|播报|说说|一下|问一下|现在|今天|今日|此刻|当前|这会儿|我所在(?:的)?地区|我这边|我这儿|我这里|我那边|这边|这儿|这里|当地|本地|附近|外边|外面|室外|出门|的|[\s，,：:])*)/u;
const localQuestion = /^(?:(?:天气(?:预报)?|气温|温度)(?:怎么样|如何|怎样|是什么样(?:的|子)?|什么样(?:的|子)?(?:吗)?|好不好|还好吗|多少摄氏度|是多少(?:度)?|多少(?:度)?|有多高|高吗|低吗|几度|冷吗|热吗|呢)?|多少度|几度|冷不冷|热不热|冷吗|热吗|下雨(?:了没|没有|了吗|吗|没)|会(?:不会)?下雨(?:吗)?|要(?:不要)?带伞(?:吗)?|用(?:不用)?带伞(?:吗)?|要带外套吗|要穿什么|穿什么|是晴天吗|在下雨吗|有雨吗|有多冷|有多热)(?:呀|啊|呢|嘛|啦|吧)?[\s。？！!?～~]*$/u;
export function weatherInterest(text) {
  const input = String(text ?? '').trim();
  if (/明天|明日|后天|昨天|昨晚|上周|下周|周末|未来|预警|台风路径|对比/u.test(input)) return null;
  const clauses = input.split(/[，,。；;？！!?]/u).map(clause => clause.trim()).filter(Boolean);
  const asksLocal = clause => localQuestion.test(clause.replace(localPrefix, ''));
  if (asksLocal(input) || (clauses.length > 1 && clauses.every(asksLocal))) return 'question';
  // Someone reporting the weather or talking about clothes is not necessarily requesting a lookup.
  if (/(?:我|准备|打算|等会|待会|马上|一会|刚|想去|要去).{0,8}(?:出门|遛狗|跑步|去散步|骑车|晾衣服|爬山|通勤)/u.test(input)) return 'outing';
  return null;
}

function condition(symbol) {
  const s = typeof symbol === 'string' ? symbol.replace(/_(?:day|night|polartwilight)$/u, '') : '';
  if (s.includes('thunder')) return '有雷暴可能';
  if (s.includes('sleet')) return '雨夹雪';
  if (s.includes('snow')) return '有降雪';
  if (s.includes('rain')) return s.includes('heavy') ? '有较强降雨' : '有雨';
  return ({ clearsky: '晴', fair: '大致晴朗', partlycloudy: '局部多云', cloudy: '阴', fog: '有雾' })[s] ?? '';
}

function currentForecast(entry, now) {
  if (!entry || !Number.isFinite(entry.producedAt) || entry.producedAt < now - 36 * HOUR || entry.producedAt > now + HOUR) return null;
  const hour = entry.hours.findLast(item => item.observedAt <= now && item.observedAt >= now - HOUR);
  return hour ? { status: 'current', ...hour } : null;
}

// Each cache is bounded. It retains validated hourly values and no user/chat identifiers.
export function createWeather({ fetchImpl = (...args) => fetch(...args), clock = Date.now, reusePending = true } = {}) {
  const cache = new Map();
  const pending = new Map();
  let backoffUntil = 0;
  let recentStarts = [];
  async function load(key, previous) {
    const now = clock();
    const url = new URL(providerURL);
    const [lat, lon] = key.split(',');
    url.search = new URLSearchParams({ lat, lon });
    try {
      const headers = { 'User-Agent': agent, Accept: 'application/json' };
      if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
      const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(2800) });
      const expiresAt = Math.max(now + 10 * 60_000, Date.parse(response.headers.get('Expires')) || 0);
      if (response.status === 304 && previous) return { ...previous, expiresAt };
      if (!response.ok) {
        if ([403, 429].includes(response.status)) {
          const retry = response.headers.get('Retry-After');
          const retryAt = /^\d+$/u.test(retry ?? '') ? now + Number(retry) * 1000 : Date.parse(retry);
          backoffUntil = Math.max(now + 10 * 60_000, retryAt || 0);
        }
        await response.body?.cancel();
        throw new Error();
      }
      const data = (await response.json())?.properties;
      if (!Array.isArray(data?.timeseries) || data.meta?.units?.air_temperature !== 'celsius') throw new Error();
      const hours = [];
      for (const step of data.timeseries.slice(0, 60)) {
        const t = step?.data?.instant?.details?.air_temperature;
        const observedAt = Date.parse(step?.time);
        if (typeof t !== 'number' || !Number.isFinite(t) || Math.abs(t) > 100 || !Number.isFinite(observedAt)) continue;
        hours.push({ temperature: Math.round(t), condition: condition(step.data?.next_1_hours?.summary?.symbol_code), observedAt });
      }
      return { hours, producedAt: Date.parse(data.meta.updated_at), expiresAt, lastModified: response.headers.get('Last-Modified') };
    } catch { return { expiresAt: now + 5 * 60_000 }; }
  }
  async function forecast(grant) {
    const key = [degrees(grant.latitude), degrees(grant.longitude)].join(',');
    const now = clock();
    const previous = cache.get(key);
    if (previous?.expiresAt > now) return currentForecast(previous, now);
    if (backoffUntil > now || pending.size >= 16) return null;
    let work = reusePending ? pending.get(key) : null;
    if (!work) {
      recentStarts = recentStarts.filter(at => now - at < 1000);
      if (recentStarts.length >= 12) return null;
      recentStarts.push(now);
      work = load(key, previous).then(entry => {
        if (cache.size >= 256 && !cache.has(key)) cache.delete(cache.keys().next().value);
        cache.set(key, entry);
        return entry;
      });
      if (reusePending) pending.set(key, work);
    }
    try { return currentForecast(await work, clock()); }
    finally { if (pending.get(key) === work) pending.delete(key); }
  }
  return async function context(settings, owner, text, { proactive = false, providerAvailable = false } = {}) {
    const interest = weatherInterest(text);
    if (!interest && !proactive) return null;
    const grant = weatherGrantFor(settings, owner);
    const status = !providerAvailable ? 'unavailable' : !grant ? 'off' : grant.updatedAt + DAY <= clock() ? 'expired' : null;
    if (status) return interest === 'question' && !proactive ? { status, requested: true } : null;
    const current = await forecast(grant);
    if (!current) return interest === 'question' && !proactive ? { status: 'unavailable', requested: true } : null;
    if (proactive && !interest && current.temperature > 2 && current.temperature < 33 && !/雨|雪|雷暴/u.test(current.condition)) return null;
    return { ...current, requested: interest === 'question' && !proactive };
  };
}

export function weatherGuidance(weather) {
  if (weather?.status !== 'current') return '缺少本轮本地天气数据时，不猜测对方身边的天气、气温或未来预报。可以回应对方自己描述的天气。';
  const facts = { temperatureC: weather.temperature, condition: weather.condition };
  return '天气插件提供最后一次授权的大致地区、当前小时的预报：' + JSON.stringify(facts)
    + '。回答当地天气时可说「你那边预报大概……」。气温用摄氏度；空白天气情况表示未知。不能推断具体位置、用户人在室外、窗外实况或其他城市和时段。对方谈到出门时，合适才顺带关心一句；不要逢聊必报，也别暗示在监控位置。';
}

export function weatherAnswer(weather) {
  if (!weather?.requested) return null;
  if (weather.status === 'off') return '我还看不到你那边的天气。在宇伴的「当地天气」里分享一次大致位置，我就能帮你看啦。';
  if (weather.status === 'expired') return '上次分享的位置已经过期了。你可以在宇伴的「当地天气」里更新一下，我再帮你看。';
  if (weather.status !== 'current') return '我这会儿没查到你那边的天气，等会儿再帮你看看？';
  return `你上次分享的地区，这个时段预报大约 ${weather.temperature}℃${weather.condition ? '，' + weather.condition : ''}。`;
}
