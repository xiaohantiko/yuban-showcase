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
const localQuestion = /^(?:(?:天气(?:预报)?|气温|温度)(?:怎么样|咋样|如何|怎样|是什么样(?:的|子)?|什么样(?:的|子)?(?:吗)?|好不好|还好吗|多少摄氏度|是多少(?:度)?|多少(?:度)?|有多高|高吗|低吗|几度|冷吗|热吗|呢)?|多少度|几度|冷不冷|热不热|冷吗|热吗|下雨(?:了没|没有|了吗|吗|没)|会(?:不会)?下雨(?:吗)?|要(?:不要)?带伞(?:吗)?|用(?:不用)?带伞(?:吗)?|要带外套吗|要穿什么|穿什么|是晴天吗|在下雨吗|有雨吗|有多冷|有多热)(?:呀|啊|呢|嘛|啦|吧)?[\s。？！!?～~]*$/u;
const outdoorActivity = /出门|遛狗|跑步|散步|骑车|晾衣服|爬山|通勤/u;
const outingWords = /等会儿?|待会儿?|一会儿?|刚刚?|准备|打算|计划|现在|马上|今天|晚上|早上|下午|下班|一起|出去|下楼|家门口|门口|楼下|附近|小区|公园|这边|这里|一圈|一趟|一下|我们|[我要想去到在就正先再来啦呀了呢吧里]|[\s，,。！!～~]/gu;

export function weatherInterest(text, companionName = '') {
  let input = String(text ?? '').trim();
  const address = /^([^，,、：:\s]+)[，,、：:\s]+/u.exec(input);
  if (address) {
    const calling = address[1].replace(/[呀啊]$/u, '');
    if (calling === companionName || /^(?:姐姐?|哥哥?)$/u.test(calling)) input = input.slice(address[0].length);
  }
  if (/明天|明日|后天|昨天|昨晚|上周|下周|周末|未来|预警|台风路径|对比/u.test(input)) return null;
  const clauses = input.split(/[，,。；;？！!?]/u).map(clause => clause.trim()).filter(Boolean);
  const asksLocal = clause => localQuestion.test(clause.replace(localPrefix, ''));
  if (asksLocal(input) || (clauses.length > 1 && clauses.every(asksLocal))) return 'question';
  // Someone reporting the weather or talking about clothes is not necessarily requesting a lookup.
  // Accept a local activity only when the rest describes timing, intent or a nearby place.
  // An unspecified destination, including text after the activity, must not use the owner's grid.
  const parts = input.split(outdoorActivity);
  if (parts.length > 1 && /我|准备|打算|计划|等会|待会|马上|一会|刚|想|要/u.test(input)
    && parts.every(part => part.replace(outingWords, '') === '')) return 'outing';
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
  return async function context(settings, owner, text, { proactive = false, topicOnly = false, providerAvailable = false } = {}) {
    const interest = weatherInterest(text, settings?.companionName);
    if (!interest && (!proactive || topicOnly || outdoorActivity.test(text) || /天气|气温|几度|多少度|带伞/u.test(text))) return null;
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
  return '这是当前小时的预报，供你回答这条消息：' + JSON.stringify(facts)
    + (weather.requested ? '。这次已经查到了，以这一条为准。用熟人聊天的口气回答对方问的那件事。问几度就说几度，问带不带伞就先回答伞；气温可以写成“一度”或“1度”。' : '')
    + ' 直接从答案说起。别念插件、位置授权、地区、数据来源或天气栏目，也别用“按刚才那份预报”开场。只问温度时一句就够；对方提到出门或问穿什么，才顺口接穿衣建议。未知的天气、风力、昼夜温差别补，也不要说自己看见了对方那里的实况。';
}

const digits = '零一二三四五六七八九';
function spokenDegrees(value) {
  if (/^\d/u.test(value)) return Number(value);
  const [tens, ones] = value.replace(/两/gu, '二').split('十');
  if (ones === undefined) return tens.length === 1 ? digits.indexOf(tens) : NaN;
  return (tens === '' ? 1 : digits.indexOf(tens)) * 10 + (ones === '' ? 0 : digits.indexOf(ones));
}

// Remove a bulletin-style preface without rewriting the companion's actual answer.
export function weatherChatText(text) {
  return text.trim().replace(/^(?:(?:按(?:照)?|根据)(?:(?:我)?刚(?:才|刚)(?:查到|看到)?的?|最新的?|目前的?|这份|那份|这次的?|当地的?|你那边的?|天气){0,5}(?:天气)?预报(?:来看|来说|显示)?|(?:当地|最新|这份|那份)?(?:天气)?预报(?:上说|显示))[，,:：、]\s*/u, '')
    .replace(/(\d)\s+(?=℃|度)/gu, '$1').replace(/(?<![A-Za-z])([大约概近才有])\s+(?=[-−+]?\d)/gu, '$1');
}

// Keep a conversational answer, including spoken numerals, if it matches this turn's forecast.
export function reportsCurrentWeather(text, weather, question = '') {
  if (typeof text !== 'string' || weather?.status !== 'current') return false;
  const readings = [...text.matchAll(/(零下|负|−|[-+])?\s*(\d+(?:\.\d+)?|[零一二两三四五六七八九十]+)\s*(?:℃|°\s*C|摄氏度|度)/giu)];
  const asksAboutRain = /伞|下雨|有雨/u.test(question) && !/几度|多少度|气温|温度/u.test(question);
  if (!readings.length && !(asksAboutRain && weather.condition && /雨|伞|雪|雷/u.test(text))) return false;
  if (readings.some(([, sign, value]) =>
    spokenDegrees(value) * (['零下', '负', '−', '-'].includes(sign) ? -1 : 1) !== weather.temperature)) return false;
  if (/授权|共享的?位置|分享的?(?:地区|区域|位置)|所在(?:地区|区域)|当前时段|这个时段预报|数据显示|天气插件|无法(?:查|获取|读取)|看不到.{0,8}(?:天气|气温)|没法.{0,6}查/u.test(text)) return false;
  const cond = weather.condition || '';
  if (asksAboutRain && /雨|雪|雷/u.test(cond)
    && /(?:不用|不必|不需要|可以不)(?:带|拿)?(?:雨)?伞|(?:雨)?伞.{0,5}(?:用不上|不用带|留家里)/u.test(text)) return false;
  const claims = text.replace(/雨伞|雨衣/gu, '');
  for (const word of ['雨', '雪', '雷', '雾', '晴', '阴', '多云']) {
    const denied = new RegExp('(?:不会|不用担心|没有|没见|没|不)(?:有|下|打|起|是|见)?' + word, 'gu');
    if (cond.includes(word) && denied.test(claims)) return false;
    if (!cond.includes(word) && claims.replace(denied, '').includes(word)) return false;
  }
  return true;
}

const skyPhrase = {
  '晴': '天倒是晴的', '大致晴朗': '天还算晴', '局部多云': '天上有些云', '阴': '天有点阴',
  '有雾': '有点雾', '有雨': '可能会下雨', '有较强降雨': '雨可能还挺大', '雨夹雪': '可能有雨夹雪',
  '有降雪': '可能会下雪', '有雷暴可能': '可能会打雷',
};

export function weatherAnswer(weather, question = '') {
  if (!weather?.requested) return null;
  if (weather.status === 'off') return '我还看不到你那边的天气。想让我帮你看的话，在宇伴里点一下「当地天气」就好。';
  if (weather.status === 'expired') return '我这里看不到你那边最新的天气了。方便的话，在宇伴的「当地天气」里再分享一次就好。';
  if (weather.status !== 'current') return '我刚看了一眼，没查到你那边现在几度。';
  const { temperature, condition } = weather;
  const temp = temperature < 0 ? '零下' + Math.abs(temperature) + '度' : temperature + '度';
  const sky = skyPhrase[condition];
  if (/下雨|有雨/u.test(question) && !/伞/u.test(question)) {
    if (!condition) return `我这儿只看到气温，大概${temp}。下不下雨还说不准。`;
    if (/雨|雷/u.test(condition)) return `${sky}，你那边现在大概${temp}。`;
    return `看起来这会儿没雨，${sky}。现在大概${temp}。`;
  }
  if (/伞/u.test(question)) {
    if (/雨|雪|雷/u.test(condition)) return `带把伞吧，${sky}。你那边现在大概${temp}。`;
    if (!condition) return `我只查到现在大概${temp}，会不会下雨还说不准。`;
    return `这会儿看着不用带伞，${sky}。现在大概${temp}。`;
  }
  if (/外套|穿什么/u.test(question)) {
    if (temperature <= 12) return `外套穿上吧，你那边${temp}左右，挺冷的。`;
    if (temperature >= 26) return `你那边都有${temp}了，穿轻薄点儿就行。`;
    return `大概${temp}。怕凉的话，带件薄外套就好。`;
  }
  if (temperature <= 7) {
    if (/多少度|几度|冷不冷|冷吗|多冷/u.test(question)) return temperature < 0 ? `都零下${Math.abs(temperature)}度了，怪冷的。` : `你那边才${temp}，怪冷的。`;
    if (condition === '晴' || condition === '大致晴朗') return `晴是晴，可你那儿也就${temp}呀。`;
    return `你那边${temp}左右，挺冷的${sky ? '，' + sky : ''}。`;
  }
  if (temperature >= 30) return `你那边都${temp}了，挺热的${sky ? '，' + sky : ''}。`;
  return `你那边现在大概${temp}${sky ? '，' + sky : ''}。`;
}
