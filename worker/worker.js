// KOVA STREAK API: Discord OAuth2, хранение отметок в KV, ежедневный дайджест
// в канал Discord через вебхук.
//
// Биндинги и переменные (см. wrangler.jsonc и README.md):
//   KV      KOVA
//   vars    DISCORD_CLIENT_ID, ADMIN_DISCORD_IDS, SITE_URL, GUILD_ID, TZ_NAME
//   secrets DISCORD_CLIENT_SECRET, SESSION_SECRET, DISCORD_WEBHOOK_URL

const ALLOWED_ORIGINS = [
  'https://rauder999.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const SESSION_DAYS = 60;

// ---------- утилиты ----------

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

const json = (data, status, cors) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const b64url = {
  encode(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

const enc = new TextEncoder();
const dec = new TextDecoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// Токен: base64url(payload).base64url(подпись). Фронт читает payload, подпись проверяем тут.
async function signToken(payload, secret) {
  const body = b64url.encode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return `${body}.${b64url.encode(sig)}`;
}

async function verifyToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, b64url.decode(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64url.decode(body)));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- даты ----------

// Локальная дата группы. Cloudflare живет в UTC, а машина админа в Mountain
// Time с летним временем, поэтому фиксированный сдвиг не годится: берем
// настоящую таймзону через Intl (en-CA дает формат YYYY-MM-DD).
function groupDate(env, at = Date.now()) {
  const tz = env.TZ_NAME || 'America/Denver';
  return new Date(at).toLocaleDateString('en-CA', { timeZone: tz });
}

function shiftDate(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthDays(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (let i = 1; i <= last; i++) out.push(`${month}-${String(i).padStart(2, '0')}`);
  return out;
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isMonth = (s) => typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);

// ---------- KV ----------

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.KOVA.list({ prefix, cursor, limit: 1000 });
    out.push(...page.keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

// Значения отметок и профилей дублируются в metadata, поэтому групповой вид
// собирается двумя list-запросами без единого get.
async function loadGroup(env) {
  const [userKeys, compKeys] = await Promise.all([
    listAll(env, 'user:'),
    listAll(env, 'completion:'),
  ]);

  const users = userKeys.map((k) => ({
    userId: k.name.slice('user:'.length),
    displayName: (k.metadata && k.metadata.n) || 'unknown',
    avatar: (k.metadata && k.metadata.a) || null,
    joinedDate: (k.metadata && k.metadata.j) || null,
  }));

  const byUser = new Map(users.map((u) => [u.userId, {}]));
  for (const k of compKeys) {
    const rest = k.name.slice('completion:'.length);
    const cut = rest.lastIndexOf(':');
    if (cut < 0) continue;
    const uid = rest.slice(0, cut);
    const date = rest.slice(cut + 1);
    const m = k.metadata || {};
    if (!byUser.has(uid)) byUser.set(uid, {});
    byUser.get(uid)[date] = { completedRuns: m.c || 0, requiredRuns: m.r || 0, done: !!m.d };
  }

  return { users, byUser };
}

// Стрик: подряд идущие выполненные дни, заканчивая сегодня. Если сегодня еще
// не закрыт, день не обнуляет стрик, он просто пока не считается.
function computeStreak(byDate, today) {
  let cursor = byDate[today] && byDate[today].done ? today : shiftDate(today, -1);
  let n = 0;
  while (byDate[cursor] && byDate[cursor].done) {
    n++;
    cursor = shiftDate(cursor, -1);
  }
  return n;
}

// Пропуски за месяц. Сегодняшний день не считается пропуском, пока он не
// закончился, и дни до вступления в группу тоже не считаются.
function computeMissed(byDate, month, today, joinedDate) {
  const days = monthDays(month);
  let missed = 0;
  for (const d of days) {
    if (d >= today) continue;
    if (joinedDate && d < joinedDate) continue;
    if (!(byDate[d] && byDate[d].done)) missed++;
  }
  return missed;
}

async function buildStandings(env, month) {
  const today = groupDate(env);
  const { users, byUser } = await loadGroup(env);

  const players = users.map((u) => {
    const all = byUser.get(u.userId) || {};
    const byDate = {};
    for (const [d, rec] of Object.entries(all)) if (d.startsWith(month + '-')) byDate[d] = rec;
    return {
      ...u,
      byDate,
      streak: computeStreak(all, today),
      missedDays: computeMissed(all, month, today, u.joinedDate),
      doneToday: !!(all[today] && all[today].done),
      todayRuns: all[today] || null,
    };
  });

  players.sort((a, b) => a.missedDays - b.missedDays || b.streak - a.streak || a.displayName.localeCompare(b.displayName));
  return { month, today, days: monthDays(month), players };
}

// ---------- Discord OAuth ----------

function discordRedirectUri(request) {
  return new URL('/auth/callback', new URL(request.url).origin).toString();
}

// Куда возвращать игрока после логина. Проверяем origin по белому списку:
// иначе ссылку вида /auth/login?redirect=evil.com можно подсунуть жертве
// и увести ее сессионный токен из фрагмента URL.
function safeRedirect(target, env) {
  const fallback = env.SITE_URL || ALLOWED_ORIGINS[0];
  if (!target) return fallback;
  try {
    const u = new URL(target);
    return ALLOWED_ORIGINS.includes(u.origin) ? u.origin + u.pathname : fallback;
  } catch {
    return fallback;
  }
}

async function handleLogin(request, env) {
  const url = new URL(request.url);
  const redirect = safeRedirect(url.searchParams.get('redirect'), env);
  const state = await signToken({ redirect, iat: Math.floor(Date.now() / 1000) }, env.SESSION_SECRET);

  const scope = env.GUILD_ID ? 'identify guilds' : 'identify';
  const auth = new URL('https://discord.com/oauth2/authorize');
  auth.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  auth.searchParams.set('redirect_uri', discordRedirectUri(request));
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', scope);
  auth.searchParams.set('state', state);
  auth.searchParams.set('prompt', 'none');

  return Response.redirect(auth.toString(), 302);
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  const state = await verifyToken(stateRaw, env.SESSION_SECRET);
  const back = safeRedirect(state && state.redirect, env);

  const fail = (reason) => Response.redirect(`${back}?auth_error=${encodeURIComponent(reason)}`, 302);

  if (!code || !state) return fail('bad_state');

  const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: discordRedirectUri(request),
    }),
  });
  if (!tokenRes.ok) {
    console.error('token exchange failed:', tokenRes.status, (await tokenRes.text()).slice(0, 300));
    return fail('token_exchange_failed');
  }
  const tokens = await tokenRes.json();

  const meRes = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!meRes.ok) {
    console.error('profile fetch failed:', meRes.status, (await meRes.text()).slice(0, 300));
    return fail('profile_failed');
  }
  const me = await meRes.json();

  // Пускаем только участников сервера группы, если GUILD_ID задан.
  if (env.GUILD_ID) {
    const gRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!gRes.ok) {
      console.error('guild check failed:', gRes.status, (await gRes.text()).slice(0, 300));
      return fail('guild_check_failed');
    }
    const guilds = await gRes.json();
    if (!Array.isArray(guilds) || !guilds.some((g) => g.id === env.GUILD_ID)) return fail('not_in_guild');
  }

  const displayName = me.global_name || me.username;
  const avatar = me.avatar
    ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64`
    : null;

  const existing = await env.KOVA.get(`user:${me.id}`, 'json');
  const profile = {
    displayName,
    avatar,
    joinedAt: existing ? existing.joinedAt : Date.now(),
    joinedDate: existing ? existing.joinedDate : groupDate(env),
  };
  await env.KOVA.put(`user:${me.id}`, JSON.stringify(profile), {
    metadata: { n: displayName, a: avatar, j: profile.joinedDate },
  });

  const admins = String(env.ADMIN_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const session = await signToken({
    uid: me.id,
    name: displayName,
    avatar,
    admin: admins.includes(me.id),
    exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400,
  }, env.SESSION_SECRET);

  return Response.redirect(`${back}#token=${session}`, 302);
}

// ---------- API ----------

async function auth(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  return verifyToken(header.slice(7), env.SESSION_SECRET);
}

async function handleApi(request, env, url, cors, ctx) {
  const path = url.pathname;

  if (path === '/api/playlist' && request.method === 'GET') {
    const pl = await env.KOVA.get('playlist:current', 'json');
    return json(pl || { weekLabel: null, scenarios: [], updatedAt: 0 }, 200, cors);
  }

  const user = await auth(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401, cors);

  if (path === '/api/me' && request.method === 'GET') {
    return json({ ...user, coachEnabled: await coachAllowed(env, user) }, 200, cors);
  }

  if (path === '/api/playlist' && request.method === 'PUT') {
    if (!user.admin) return json({ error: 'Admin only' }, 403, cors);
    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.scenarios) || !body.scenarios.length) {
      return json({ error: 'scenarios is required' }, 400, cors);
    }
    const scenarios = body.scenarios
      .filter((s) => s && typeof s.name === 'string' && s.name.trim())
      .map((s) => ({ name: s.name.trim(), requiredRuns: Math.max(1, Math.min(50, Number(s.requiredRuns) || 1)) }));
    if (!scenarios.length) return json({ error: 'No usable scenarios' }, 400, cors);

    const playlist = {
      weekLabel: String(body.weekLabel || 'This week').slice(0, 60),
      shareCode: body.shareCode ? String(body.shareCode).slice(0, 100) : null,
      scenarios,
      updatedAt: Date.now(),
      updatedBy: user.name,
    };
    await env.KOVA.put('playlist:current', JSON.stringify(playlist));
    return json(playlist, 200, cors);
  }

  if (path === '/api/completion' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || !isDate(body.date)) return json({ error: 'date is required' }, 400, cors);

    // Дату присылает клиент (его локальный день). Принимаем вчера, сегодня
    // и завтра по времени группы: игрок в часовом поясе восточнее админа
    // живет на день впереди, а задний ход дальше вчера все равно закрыт.
    const today = groupDate(env);
    if (![shiftDate(today, -1), today, shiftDate(today, 1)].includes(body.date)) {
      return json({ error: 'Date out of range' }, 400, cors);
    }

    const requiredRuns = Math.max(0, Number(body.requiredRuns) || 0);
    const completedRuns = Math.max(0, Math.min(requiredRuns, Number(body.completedRuns) || 0));
    const done = requiredRuns > 0 && completedRuns >= requiredRuns;

    const key = `completion:${user.uid}:${body.date}`;
    const prev = await env.KOVA.get(key, 'json');
    // Первый переход через 100% за этот день: prev либо не было, либо он
    // был частичным. Повторные посты того же дня (перезагрузка вкладки)
    // анонс не триггерят.
    const firstCompletionToday = done && !(prev && prev.done);
    // День уже закрыт: не даем случайно откатить его частичным сканом
    // (например, после смены плейлисты в середине дня).
    if (!(prev && prev.done && !done)) {
      const record = {
        completedRuns,
        requiredRuns,
        done,
        completedAt: done ? (prev && prev.completedAt) || Date.now() : null,
      };
      await env.KOVA.put(key, JSON.stringify(record), {
        metadata: { c: record.completedRuns, r: record.requiredRuns, d: record.done },
      });
    }

    const all = {};
    for (const k of await listAll(env, `completion:${user.uid}:`)) {
      const m = k.metadata || {};
      all[k.name.slice(`completion:${user.uid}:`.length)] = { completedRuns: m.c || 0, requiredRuns: m.r || 0, done: !!m.d };
    }
    const profile = await env.KOVA.get(`user:${user.uid}`, 'json');
    const streak = computeStreak(all, today);

    if (firstCompletionToday && ctx) ctx.waitUntil(announceCompletion(env, user, streak));

    return json({
      ok: true,
      done,
      streak,
      missedDays: computeMissed(all, today.slice(0, 7), today, profile && profile.joinedDate),
    }, 200, cors);
  }

  if (path === '/api/group' && request.method === 'GET') {
    const month = url.searchParams.get('month');
    if (!isMonth(month)) return json({ error: 'month must be YYYY-MM' }, 400, cors);
    return json(await buildStandings(env, month), 200, cors);
  }

  // трехстрочный коуч: правила на клиенте нашли коды диагнозов, ИИ здесь
  // только формулирует. Кэш по хэшу состояния: пока диагноз не изменился,
  // повторные запросы не тратят ни токена.
  if (path === '/api/coach' && request.method === 'POST') {
    if (!(await coachAllowed(env, user))) return json({ error: 'Coach is not enabled for you yet' }, 403, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'Coach is not configured yet (ANTHROPIC_API_KEY)' }, 503, cors);
    const body = await request.json().catch(() => null);
    if (!body || typeof body.stateHash !== 'string' || !Array.isArray(body.niches) || !body.niches.length) {
      return json({ error: 'stateHash and niches are required' }, 400, cors);
    }
    // версия в ключе: смена поколения промпта хоронит старые кэшированные вердикты
    const cacheKey = `coach:v7:${user.uid}:${body.stateHash.slice(0, 64)}`;
    const cached = await env.KOVA.get(cacheKey, 'json');
    if (cached) return json({ lines: cached.lines, cached: true }, 200, cors);

    const lines = await generateCoachLines(env, body);
    if (!lines) return json({ error: 'Coach model returned nothing useful' }, 502, cors);
    await env.KOVA.put(cacheKey, JSON.stringify({ lines, at: Date.now() }), { expirationTtl: 60 * 60 * 24 * 14 });
    return json({ lines, cached: false }, 200, cors);
  }

  // ручная отправка дайджеста из админки: тот же текст, что уйдет по крону
  if (path === '/api/digest' && request.method === 'POST') {
    if (!user.admin) return json({ error: 'Admin only' }, 403, cors);
    if (!env.DISCORD_WEBHOOK_URL) return json({ error: 'Webhook is not configured yet (DISCORD_WEBHOOK_URL)' }, 400, cors);
    await postDigest(env);
    return json({ ok: true }, 200, cors);
  }

  return json({ error: 'Not found' }, 404, cors);
}

// ---------- ежедневный дайджест в Discord ----------

const MILESTONES = new Set([3, 7, 14, 21, 30, 50, 75, 100]);

// ---------- коуч ----------

// Флаг раскатки: KV flag:coach = {"all":true} или {"users":["discordId",...]}.
// Меняется правкой KV, без передеплоя.
async function coachAllowed(env, user) {
  const flag = await env.KOVA.get('flag:coach', 'json');
  if (!flag) return false;
  if (flag.all) return true;
  return Array.isArray(flag.users) && flag.users.includes(user.uid);
}

// Общая база знаний, дистиллирована из материалов тренера 4BK и доктрины
// Voltaic/Aimer7, БЕЗ персонального контекста. Ищут правила на клиенте,
// модель только формулирует советы человеческим языком.
// Единственный источник знаний коуча: knowledge/coach-kb.md, вшивается сюда
// дословно (секция KNOWLEDGE BASE). Меняешь базу - меняй файл и эту константу.
const COACH_PROMPT = `You are the player's aim coach (KovaaK's, training for The Finals). Every answer must pass through the KNOWLEDGE BASE below: it is the canonical doctrine (distilled from a real aim coach's full body of work). Do not invent theory outside it.

PAYLOAD SEMANTICS:
- Diagnosis codes and numbers are computed from the player's own history: every delta is vs THEIR OWN past runs of the same scenarios, never absolute standards.
- Niches arrive sorted worst first. Each named scenario carries a "kind" tag (pokeball / tracking / clicking / switching / dynamic); the KIND, not the niche, decides which cue from the base fits it. kind "clicking" = static targets; kind "dynamic" = MOVING targets clicked once (pasu family, 3-click): dynamic is tracking first, clicking second, never pace-pushed, and a longer kill time there is often correct technique (tracking before the click), not hesitation. accPct on a scenario is its accuracy today, usable ONLY for the difficulty-calibration rules, never to shame the player.
- Codes map to the diagnostic playbook: SPAM, HESITATE, CHOKES, FATIGUE, SOFT, STRONG, OK; rustyDays means a break before this day.
- recentAdvice lists what you told this player on previous days (may be empty); each niche's lastAdvice is your previous line for that niche.
- TRACKING never reaches you: stats files cannot see the hand in tracking, so the app writes the tracking line itself from doctrine. You only see measured niches (clicking, switching).

KNOWLEDGE BASE:
## Philosophy (overrides everything)

- The goal is clean technique and habits, never score. Score must be an OUTCOME of good
  technique. A score gain paid for with degraded technique is a regression (Goodhart's law:
  once a metric becomes the goal it stops measuring progress).
- KovaaK's is a habit builder. Bad habits translate into the game 1:1 (overflicking,
  shooting before confirming, edge clicking, edge tracking). Under pressure the brain
  draws only from the pool of flicks you trained; feed it faulty ones and it picks from them.
- Everything is connected (assisting skills): pokeball assists static and TS; TS assists
  static and pokeball; static builds control; smoothness assists reactive and first-shot
  accuracy; tracking assists flicking. When a field is stuck, attack its assisting fields
  instead of spamming it.
- Timings: every method is right at the right stage. Beginners mostly need playtime and
  fundamentals across ALL fields; hyper-specific fixes come later. Most players have 2-3
  core problems that bleed into everything.
- Progress = raising your floor: best and worst aim closer together, roughly 0.01% a day,
  non-linear. Comfortable = maintaining, not training; train with in-game urgency, no autopilot.
- Inconsistency is not a trait, it is a skill gap: the spread between peak and floor.

## Speed management: the core model of why flicks miss

- Peripheral vision plans the initial path (fast, blurry); central vision guides the
  correction (accurate, engages late if allowed). The classic fault: explosive initial
  guided by peripherals only, abrupt halt, freeze (recalculation), slow separate correction.
- The correct flick: eyes on the target BEFORE and DURING the movement, central vision
  engages mid-flick (by 60-80% of the path), deceleration starts before the target, the
  correction BLENDS into the initial: one smooth glide at even speed ("hand through water").
- Speed = MINIMAL WASTED MOVEMENT, not hand speed. 100ms initial + 100ms correction beats
  50ms initial + 300ms correction. Prefer UNDERFLICKING; the correction is a fallback for
  saving a flick, not a standard feature of every flick.
- Flicking fast and adjusting slow teaches the brain that the correction takes forever, so
  in game it sprays around the target instead of adjusting. Fix: equalize the whole flick
  to the correction's speed, then rebuild speed.
- Randomness (shakes, hesitation, dirty micros) = the brain filling gaps with guesswork.
  Cures: intent per movement, decelerations (a millisecond to re-read the path), reading
  the target, looking at the bot before the mouse moves.

## Fields and how to read them

- STATIC CLICKING (builds control; = knowing WHEN to click). Confirmation methods: 100%
  mode (98-100% accuracy runs even at score cost), visual confirm (a millisecond of seeing
  you are on target at ANY speed), clicking the DEAD CENTER (never edges), 4BClick (finger
  off M1, flick, confirm, finger back, click). Punishment scens (never-miss, bardpill) when
  the spam habit is strong. Wide wall = the flick splits into initial + correction, trains
  decelerations. Clustered = raw snap speed, NOT corrections. Missing close-range flicks is
  a lines/speed issue, not a "micro" issue. Accuracy homes: ~95-100% accuracy-focused
  statics, 92%+ speed-focused; speed focus = +10-20% over comfort, never +40-50%.
- POKEBALL (assists static and TS; accuracy of lines). M1 held the whole run, targets are
  static balls; accuracy = time on target, 10-30% is normal, never judged by clicking
  standards. Smooth pathing for overflickers: any speed as long as zero over/underflick,
  one straight line, no correction at the end; drop the technique once consistently landing
  close. Wide-wall pokeball is the main overflicking cure. Progression = tiny handspeed
  bumps, about +5% at a time, never 0-100.
- TARGET SWITCHING (assists static and pokeball; speed). M1 held, let the mouse fly; trains
  the speed of REALIZING where the crosshair is. Large TS = pure speed; small TS = accuracy
  plus blending the flick into a short track. Freeze after the initial flick = slow
  correction routing: low-TTK scens, ballsheet, larger targets. Can't blend flick into
  track: higher-HP / evasive TS, regen switching. Eyes jump to the next target the instant
  the current one dies; hand 10-20% faster than comfortable. Chain kills: minimal time
  BETWEEN targets, a fraction longer ON the target.
- DYNAMIC (clicking moving targets; pasu family, 3-click scens). NEVER spam and never
  pace-push: track the bot for a millisecond before clicking; dynamic is tracking first,
  clicking second, and a longer kill time here is often correct technique, not hesitation.
  Target reading: flick to where the target WILL be, not its old position (flicking to old
  position is the #1 reason for "overflick in game but not in KovaaK's"). 3-click scens
  force tracking priority.
- TRACKING = smoothness. Reactive = recognizing and reacting to a direction change;
  everything before and after the reaction is smoothness. Read the target: if he is smooth,
  be smooth; be reactive only for the millisecond of the change (constant reactivity =
  shakes and biting feints; some scens are designed to bait overreaction). Aim center mass,
  glued to one body part; edge tracking = score cheese. Undertracking (#1 tracking fault) =
  poor speed matching, the brain chases old info ("tracking a ghost behind the target"):
  cure with easier-but-FASTER scens plus the cue "track where he is GOING". Shaking while
  hitting = precision gap: slower and smaller targets, dead center. Shaky after reactive =
  play abruptly easy smoothness right after (reactive conditioning). Use the arm more.
  Late/floaty reactions = overly smooth: gradually harder reactive, awareness of changes.
- MOVEMENT: mouse and keyboard in sync; anti-mirror always (mirroring = cheese); freezing
  the crosshair (or the feet) while the other works = disconnection; move after firing
  regardless of hit.
- MEASUREMENT LIMIT: stats files cannot see the hand in tracking (invincible and regen
  bots, accuracy semantics vary per scenario). Tracking is therefore never diagnosed from
  data: the coach gives doctrine-based general assignments for tracking, no measured claims.
- REFLEX / INFORMATION / PUNISHMENT: the most game-like field; punishes misses live the way
  a game punishes with death. One single-target surprise scenario per category counters
  pre-pathing with peripherals. Requires fundamentals first.

## Difficulty calibration (scenario selection, not player judgment)

- Tracking smoothness/precision: 25-40% accuracy keeps improvement; over 50% = scenario too
  easy, under 20% = too hard. Reactive: 40-60%. Statics: 95%+ accuracy home. CALM-style
  inertia scens ("Accuracy Edit"): 60-80%, never below ~50.
- A scenario should show improvement within 3-5 runs (tracking: accuracy climbing 1-2%
  within ~10 minutes); high difficulty + frustration + zero progress = scale back or attack
  the assisting skills instead.

## Diagnostic playbook (symptom -> root -> prescription)

- Accuracy under own norm at same-or-faster pace (SPAM): assumption clicking, no
  confirmation. Prescribe confirmation methods, one accuracy-first pass on the named static
  before playing for score, punishment/one-shot statics, dead center only.
- Slower than own norm with fine accuracy (HESITATE): over-confirming; the first confirm is
  enough. Prescribe clicking earlier, one speed pass ~10% over comfort, speed statics.
- Occasional kills 3x the player's norm (CHOKES): eyes leave late for the next target, or a
  missed flick spirals into re-flicks. Prescribe eyes-first chaining; if a flick misses,
  correct forward, never re-flick from zero; low-TTK switching.
- Accuracy fades inside runs (FATIGUE): creeping grip/arm tension. Prescribe loosening the
  hand between kills, 15-30s breaks between runs, stop a death-grip run; wrist pressed into
  the desk drains tension; posture (eyes level with top of screen).
- Broadly under own norm with no specific fault (SOFT): prescribe the slowed ladder (play
  the named scenario deliberately at ~90% speed until it LOOKS clean, then normal), or the
  assisting field of that scenario (static stuck -> its pokeball/TS twin first).
- Flick lands near target then slow adjust: pokeball lines. Losing a straight-line target:
  smoothness, not reactivity. Shaky spray on the body: precision while tracking.
- Overflick in game only: target reading in dynamic (intercept where he WILL be).
- Overflicking on large targets at speed: comfort with speed lacking; large/easy scens with
  conscious push first; speed lack HIDES other faults, rule it out first.
- Score up while accuracy/technique down: regression, say it plainly.

## Progression doctrine (what to assign on a GREEN day)

Green means the habit held; comfortable is maintaining, so assign the next rung, ONE dial
at a time, small steps:
- clicking: +10% pace on the weakest static while holding the usual accuracy; or dead-center
  focus runs; or one extra-small / one-shot variant; or punishment static if confirmation
  is the current theme.
- pokeball: +5% handspeed, never a big jump; or perfect lines at current speed (zero
  over/underflick).
- tracking: same scenarios one notch faster staying smooth; or precision tightening (glue
  to one body part, no drifting inside the bot); or "track where he is GOING" as the run's
  only focus.
- switching: tighter chains (eyes first, hand 10-20% faster); or a lower-TTK / faster
  variant of the best scenario.
- General: progressive overload weekly, not daily; 2-3 pushing scenarios per ~10
  comfortable ones; variety beats repetition (three size/speed variants of one scenario,
  one minute each, beat three minutes of one).
- Speed calibration ladder: push to 100%, then back off 5% at a time until mistakes happen
  but do not form habits.

## Delivering feedback (how a coach talks; grounded in motor-learning research and real coach reviews)

- Priorities, not inventories: one cue per area per day. A review that lists twenty fixes
  teaches none; the student remembers about two things. Keep the action plan small.
- Feedforward: phrase everything as what to DO next session, with the why in half a
  sentence. Never a rehash of today's misses.
- External-focus cues work better than body-part cues (15+ years of motor-learning
  research, all skill levels): describe the effect in the world, not the limb. "One
  straight line to the ball" beats "relax your wrist"; "let the crosshair settle before
  you click" beats "slow your finger". Use body cues only for tension release, where the
  body IS the subject.
- One dial per assignment, small step. Two changes at once means neither gets learned.
- Repetition discipline (bandwidth feedback): do not repeat yesterday's cue by default;
  constant nagging about the same thing becomes wallpaper. Repeat ONLY when the data still
  shows that fault as today's top priority, and then say openly that you are repeating on
  purpose ("Same focus as yesterday, it is still the one"). Where there is no data
  (tracking), never repeat: rotate to a different doctrine cue.
- Confidence first when it is TRUE: open with what held up before what broke; expectancy of
  success measurably improves learning. Never manufacture praise, and never praise without
  attaching the next step.
- Certainty discipline: state only what the data supports. Where the data is blind, give
  doctrine, not diagnosis. No guessing dressed as measurement.

## Session context

- Rust (3+ days off): expected, not regression; technique survives breaks, cheesed score
  does not. Read the day by which habits held, prescribe an easy warmup ramp, no panic.
- Warmup: first runs of a session are cold; judge the day by the later runs.
- After a PB: celebrate in passing, then check the technique held (a PB with degraded
  accuracy is a warning, not a win).
- Plateau on a scenario: conditioning (easier/harder variants around it, SYA: same scenario
  at 75% timescale then normal), attack assisting fields, or shelve it for a week.

HOW TO ANSWER:
- REPETITION CHECK, do it FIRST for every measured niche: its lastAdvice field is what you told the player last time. Your line today must use a DIFFERENT cue (the idea, not the exact words: "tighter chains, eyes first" rephrased is still the SAME cue). The only exception: the data still shows the same fault as today's top priority; then keep the cue but the assignment must literally begin with "Same focus as yesterday:". A repeated cue without that opener is a wrong answer.
- Every line = short state verdict + a concrete next-session assignment from the base. Praise alone is banned; "keep it up" is banned. The player must leave each line knowing what to DO.
- Anchor the assignment on the WORST scenario by name whenever one is given; its kind picks the cue. Do not dodge to the best scenario because the worst is awkward. Pokeball worst = pokeball work only (lines OR +5% handspeed, never both). Dynamic worst = track-first work: track each target briefly, decide, then click; intercept where it WILL be; never "add pace".
- Green niche = assign the next rung from the progression doctrine, ONE dial, small step. One instruction per line: never two sequenced dials ("do X, then add Y" is two).
- Faulty niche = the playbook prescription for its code, phrased around the named scenario.
- If rustyDays is present, fold "normal after N days off" into the first line, then still assign.

VOICE:
- Plain words a newcomer understands. No jargon, no metric names, no "baseline" (say "your usual").
- Numbers: at most ONE per line. When evidence and assignment both carry a number, keep the assignment's number and drop the evidence's.
- Scenario names shortened (drop "4BK -", "Accuracy Edit", "Voltaic").
- Never use dashes as punctuation; commas and periods only.
- No idioms, no wordplay. The words clicking, tracking and switching are niche names here and mean nothing else; a phrase like "switching is clicking" is a bug, not a joke.

OUTPUT CONTRACT (strict):
- One line per niche, EXACT order given (worst first). No preamble, no summary, nothing after.
- Line format: [CLICKING] / [SWITCHING] prefix, then 1-2 short sentences, max ~25 words total per line.`;


async function generateCoachLines(env, body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      // щедрый лимит: у думающих моделей рассуждение ест бюджет до текста,
      // 300 токенов обрезали ответ на полуслове (грабли, знакомые по AimSama)
      max_tokens: 6000,
      system: COACH_PROMPT,
      messages: [{ role: 'user', content: 'Diagnosis:\n' + JSON.stringify({ rustyDays: body.rustyDays || null, niches: body.niches }) }],
    }),
  });
  if (!res.ok) {
    console.log('coach model error', res.status, (await res.text()).slice(0, 300));
    return null;
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => /^\[(CLICKING|TRACKING|SWITCHING)\]/.test(l)).slice(0, 3);
  return lines.length ? lines : null;
}

// Голос "Системы" из манхв: холодные строки в квадратных скобках внутри
// серого код-блока Discord. Формульность и повторяемость - часть эстетики.
function systemBlock(lines) {
  return '```\n' + lines.join('\n') + '\n```';
}

// Мгновенный пост в канал, когда игрок впервые за день закрыл плейлисту.
// Социальное давление капает весь день, а не одним вечерним залпом.
// Никогда не ломает сам чек-ин: все ошибки глотаются.
async function announceCompletion(env, user, streak) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  try {
    const today = groupDate(env);
    const standings = await buildStandings(env, today.slice(0, 7));
    const players = standings.players;
    const meCounted = players.some((p) => p.userId === user.uid && p.doneToday);
    const doneCount = players.filter((p) => p.doneToday).length + (meCounted ? 0 : 1);

    const variants = [
      `[Daily quest complete: ${user.name}]`,
      `[Player ${user.name} has cleared today's playlist.]`,
      `[${user.name}: all runs verified. Day secured.]`,
      `[Quest log updated: ${user.name} - daily training complete.]`,
    ];
    const lines = [variants[Math.floor(Math.random() * variants.length)]];
    if (streak >= 3) {
      lines.push(MILESTONES.has(streak)
        ? `[Streak: ${streak} days. Milestone reached.]`
        : `[Streak: ${streak} days.]`);
    }
    if (players.length >= 3) lines.push(`[${doneCount}/${players.length} players complete today.]`);

    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: systemBlock(lines), allowed_mentions: { parse: [] } }),
    });
  } catch { /* пост не критичен */ }
}

// Дайджест построен на механиках Duolingo: угроза стрику первой строкой
// (loss aversion сильнее награды), конкретные числа, вехи празднуются,
// провалившимся - "прогресс важнее идеальности" вместо стыда, и копия
// ротируется по дню месяца, чтобы не стать обоями.
async function postDigest(env) {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const today = groupDate(env);
  const standings = await buildStandings(env, today.slice(0, 7));
  const players = standings.players;
  if (!players.length) return;

  const done = players.filter((p) => p.doneToday);
  const missing = players.filter((p) => !p.doneToday);
  const atRisk = missing.filter((p) => p.streak >= 1);
  const partial = missing.filter((p) => p.todayRuns && p.todayRuns.completedRuns > 0);
  const notStarted = missing.filter((p) => !p.todayRuns || p.todayRuns.completedRuns === 0);

  const dayNum = Number(today.slice(-2));
  const pick = (arr) => arr[dayNum % arr.length];
  const header = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const tag = (p) => (p.streak >= 3 ? `${p.displayName} (${p.streak}d)` : p.displayName);

  const lines = [`[SYSTEM NOTICE - ${header}]`];

  if (missing.length === 0) {
    lines.push(`[All ${players.length} players have completed the daily quest.]`);
    lines.push(pick([
      '[No penalties issued today.]',
      '[Flawless day recorded.]',
      '[The system approves. Barely.]',
    ]));
  } else {
    // угроза стрику: главный крючок, всегда первой строкой
    if (atRisk.length) {
      const names = atRisk.map(tag).join(', ');
      lines.push(pick([
        `[Warning: streak termination at midnight for: ${names}.]`,
        `[Unfinished daily detected: ${names}. Consequences apply at midnight.]`,
        `[Pending streak loss: ${names}. The system does not extend deadlines.]`,
      ]));
    }
    if (done.length) {
      lines.push(`[Complete: ${done.length}/${players.length} - ${done.map(tag).join(', ')}]`);
    } else {
      lines.push('[Complete: 0/' + players.length + '. The system is watching.]');
    }
    // оставшееся считаем до конца, а не от нуля
    for (const p of partial) {
      const left = p.todayRuns.requiredRuns - p.todayRuns.completedRuns;
      lines.push(`[${p.displayName}: ${left} ${left === 1 ? 'run' : 'runs'} remaining.]`);
    }
    // после сорванного стрика - прогресс, а не стыд
    const fresh = notStarted.filter((p) => p.streak === 0 && Object.values(p.byDate).some((d) => d.done));
    for (const p of fresh.slice(0, 3)) {
      const goodDays = Object.values(p.byDate).filter((d) => d.done).length;
      lines.push(`[${p.displayName}: streak reset. ${goodDays} completed ${goodDays === 1 ? 'day' : 'days'} on record this month. A new one starts today.]`);
    }
  }

  // вехи празднуем в день достижения
  for (const p of done.filter((x) => MILESTONES.has(x.streak))) {
    lines.push(`[Milestone: ${p.displayName} - ${p.streak} consecutive days.]`);
  }

  // гонка за призы: только когда есть реальное расслоение
  const best = players[0].missedDays;
  const leaders = players.filter((p) => p.missedDays === best).map((p) => p.displayName);
  if (leaders.length < players.length) {
    const chasers = players.filter((p) => p.missedDays === best + 1).map((p) => p.displayName);
    let race = leaders.length === 1
      ? `[Ranking: ${leaders[0]} leads with ${best} missed.`
      : `[Ranking: ${leaders.join(', ')} tied at ${best} missed.`;
    if (chasers.length && chasers.length <= 3) race += ` ${chasers.join(', ')} trail by one.`;
    lines.push(race + ']');
  }

  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: systemBlock(lines).slice(0, 1900), allowed_mentions: { parse: [] } }),
  });
}

// ---------- вход ----------

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    if (url.pathname === '/auth/login') return handleLogin(request, env);
    if (url.pathname === '/auth/callback') return handleCallback(request, env);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url, cors, ctx);
      } catch (e) {
        return json({ error: 'Server error: ' + e.message }, 500, cors);
      }
    }
    return new Response('kova-streak api', { status: 200, headers: cors });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(postDigest(env));
  },
};
