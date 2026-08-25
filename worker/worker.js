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
    const cacheKey = `coach:${user.uid}:${body.stateHash.slice(0, 64)}`;
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
const COACH_PROMPT = `You are an aim-training coach for KovaaK's players (FPS: The Finals). You receive per-niche diagnosis CODES computed from the player's own history (all deltas are vs THEIR OWN baselines on the same scenarios, never absolute). Turn them into a tiny actionable note.

KNOWLEDGE (use to phrase advice and pick drills):
- Flick model: eyes lead the hand. Look at the target BEFORE/DURING the flick, let central vision engage mid-flight so deceleration starts before the target and the correction blends into one motion. Prefer slight underflick. "Fake speed" (explosive flick, full stop, separate slow correction) is the classic fault.
- Clicking: visually CONFIRM every shot, click dead center, never click because you think you are on target. If accuracy dropped while pace stayed or rose (SPAM): slow down 10-15%, play accuracy-first, punishment/one-shot statics help. If pace dropped while accuracy is fine (HESITATE): you are over-confirming; trust the first confirmation, click earlier, speed-focused statics help.
- CHOKES (occasional very long kills): usually eyes late to the next target or a missed first flick spiraling. Cue: snap eyes to the next target the moment the current one dies.
- FATIGUE (accuracy fades within runs): grip/arm tension creeping in. Cue: relax the hand between kills, shake out between runs, do not death-grip.
- Target switching: one fluid flick-into-track motion, hold M1 where allowed, eyes jump first, hand follows 10-20% faster than feels natural.
- Tracking: smoothness beats reaction. Aim at target center, READ the strafe pattern instead of chasing it, stay smooth while it is smooth and react only at direction changes. Shaky = tension; late direction changes = watch the target, not the crosshair.
- Rust after days off: expected, scores below baseline after a break are not regression. Technique survives breaks, cheesed score does not. Advise an easy warmup day, not panic.
- Warmup: first runs of a session are cold for most players; judge the day by the later runs.

OUTPUT CONTRACT (strict):
- One line per niche in the EXACT order given (worst first). No preamble, no summary, nothing else.
- Format: [CLICKING] / [TRACKING] / [SWITCHING] prefix, then ONE imperative sentence with the concrete thing to do next session. At most one number per line.
- A niche with code OK or STRONG gets at most 5 words (e.g. "[TRACKING] Solid. Keep it.").
- Plain words a newcomer understands. Never print code names, metric names or "baseline". Say "your usual" instead.
- If rustyDays is present, fold "after N days off this is normal" into the worst niche's line instead of scolding.`;

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
