// KOVA STREAK API: Discord OAuth2, completion marks stored in KV, daily digest
// posted to a Discord channel via webhook.
//
// Bindings and variables (see wrangler.jsonc and README.md):
//   KV      KOVA
//   vars    DISCORD_CLIENT_ID, ADMIN_DISCORD_IDS, SITE_URL, GUILD_ID, TZ_NAME
//   secrets DISCORD_CLIENT_SECRET, SESSION_SECRET, DISCORD_WEBHOOK_URL

// Chain art: resvg renders the CHAIN FORGED PNG right in the worker.
// The wasm module is ~2.4MB and loads lazily, only when a chain forges.
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from './node_modules/@resvg/resvg-wasm/index_bg.wasm';

const ALLOWED_ORIGINS = [
  'https://rauder999.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const SESSION_DAYS = 60;

// ---------- utilities ----------

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

// Token: base64url(payload).base64url(signature). The frontend reads the payload, the signature is verified here.
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

// ---------- dates ----------

// The group's local date. Cloudflare runs in UTC while the admin's machine is in
// Mountain Time with DST, so a fixed offset will not do: we take
// the real timezone via Intl (en-CA gives the YYYY-MM-DD format).
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

// "2026-08-22" -> "Aug 22": dates in messages are always abbreviated
function shortDate(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Monday of the week the date belongs to: the key for the weekly rest-day quota
function weekKeyOf(date) {
  const d = new Date(date + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

const REST_QUOTA_PER_WEEK = 2;

// ---------- Chain Protocol constants (see CHAIN_PROTOCOL.md) ----------

const LINKS = { chain: 1, rescueMult: 2, perfect: 2, trialPart: 1, trialWin: 5 };
const VAULT_PRICES = { frame: 5, voucher: 12, shield: 15, score: 30 };
const FRAME_DAYS = 7;

// Roster Protocol (per Rauder, 2026-09-10). Silence = non-rest days without
// a fully closed day, counted from the last closed day (or the join /
// reinstatement date). Over pairIdle days of silence at a window start =
// no chain partner. At noticeIdle days the System serves a final notice by
// DM; still silent the next morning = removed from the roster. The way
// back is a message to Rauder and the Reinstate button in the admin panel.
const ROSTER = { pairIdle: 5, noticeIdle: 14, removeIdle: 15 };
// without a DiscordBot UA the Discord edge silently returns an empty 403
const BOT_UA = 'DiscordBot (https://rauder999.github.io/kova-streak, 1.0)';

// Half-week chain windows: Monday-Wednesday (A) and Thursday-Sunday (B).
function windowOf(date) {
  const wk = weekKeyOf(date);
  const dowMon = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7; // 0 = Monday
  const half = dowMon <= 2 ? 'A' : 'B';
  const start = half === 'A' ? wk : shiftDate(wk, 3);
  const len = half === 'A' ? 3 : 4;
  const days = [];
  for (let i = 0; i < len; i++) days.push(shiftDate(start, i));
  return { id: `${wk}:${half}`, start, days, last: days[len - 1] };
}

function prevWindowIdOf(win) {
  if (win.id.endsWith(':B')) return win.id.slice(0, 10) + ':A';
  return shiftDate(win.start, -7) + ':B';
}

// Concurrent duplicates (two tabs posting the same completion in the same
// millisecond, 2026-09-10) beat a KV get-then-put marker: both requests read
// "no marker" before either writes. Requests from one client land on one
// isolate almost always, so a short in-memory window closes the race
// cheaply; the KV markers stay as the durable line of defense.
const RECENT_KEYS = new Map();
function firstInWindow(key, ms) {
  const now = Date.now();
  const seen = RECENT_KEYS.get(key);
  if (seen && now - seen < ms) return false;
  RECENT_KEYS.set(key, now);
  if (RECENT_KEYS.size > 2000) {
    for (const [k, t] of RECENT_KEYS) if (now - t > ms) RECENT_KEYS.delete(k);
  }
  return true;
}

// Small deterministic PRNG: the same window id gives the same shuffle
// everywhere, so pairing needs no coordination.
function seededRng(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return function () {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h |= 0;
    return ((h >>> 0) % 100000) / 100000;
  };
}

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

// Every profile write goes through this so the metadata mirror (what the
// list-based group view reads) never drops a Roster flag.
function profileMeta(profile) {
  const m = { n: profile.displayName, a: profile.avatar || null, j: profile.joinedDate || null };
  if (profile.inactiveSince) m.x = 1;
  if (profile.reinstatedOn) m.r = profile.reinstatedOn;
  return m;
}

// Completion and profile values are duplicated into metadata, so the group view
// is assembled with two list requests and not a single get.
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
    // Roster Protocol flags ride the metadata too (x = removed, r = reinstated on)
    inactive: !!(k.metadata && k.metadata.x),
    reinstatedOn: (k.metadata && k.metadata.r) || null,
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

// Streak: consecutive completed days, ending today. If today is not
// closed yet, the day does not reset the streak, it just does not count yet. A rest
// day is transparent: the streak passes through it, neither growing nor breaking.
function computeStreak(byDate, today, rest) {
  let n = 0;
  if (byDate[today] && byDate[today].done) n++;
  let cursor = shiftDate(today, -1);
  while (true) {
    if (byDate[cursor] && byDate[cursor].done) { n++; cursor = shiftDate(cursor, -1); continue; }
    if (rest && rest.has(cursor)) { cursor = shiftDate(cursor, -1); continue; }
    break;
  }
  return n;
}

// Missed days for the month. Today does not count as missed until it
// is over; neither do days before joining the group or declared rest days.
function computeMissed(byDate, month, today, joinedDate, rest) {
  const days = monthDays(month);
  let missed = 0;
  for (const d of days) {
    if (d >= today) continue;
    if (joinedDate && d < joinedDate) continue;
    if (rest && rest.has(d)) continue;
    if (!(byDate[d] && byDate[d].done)) missed++;
  }
  return missed;
}

// Non-rest days after `start` up to today inclusive: the silence counter
// behind the digest tone, chain pairing and the Roster Protocol.
function countIdle(start, today, rest) {
  let idle = 0;
  for (let d = shiftDate(start, 1), i = 0; d <= today && i < 60; d = shiftDate(d, 1), i++) {
    if (!rest.has(d)) idle++;
  }
  return idle;
}

async function buildStandings(env, month, opts = {}) {
  const today = groupDate(env);
  const { users: allUsers, byUser } = await loadGroup(env);
  // Spectators are hidden everywhere (per Pasha's decision, 2026-08-26): anyone who has
  // not played a single run in all of history does not exist for the leaderboard, the calendar
  // and messages. They appear on their own as soon as their dashboard posts the first run.
  // Players removed by the Roster Protocol are hidden from live views the same way;
  // history months keep them (includeInactive), their past results were real.
  const users = allUsers.filter((u) => {
    if (u.inactive && !opts.includeInactive) return false;
    const recs = byUser.get(u.userId) || {};
    return Object.values(recs).some((r) => r.done || r.completedRuns > 0);
  });
  const restLists = await Promise.all(users.map((u) => env.KOVA.get(`rest:${u.userId}`, 'json')));

  // Chain Protocol: link balances and active Frames of Honor ride the
  // metadata of their keys, so the whole board costs two list calls.
  const [linkKeys, vaultKeys] = await Promise.all([listAll(env, 'links:'), listAll(env, 'vault:')]);
  const linksBy = new Map(linkKeys.map((k) => [k.name.slice('links:'.length), (k.metadata && k.metadata.t) || 0]));
  const frameBy = new Map(vaultKeys.map((k) => [k.name.slice('vault:'.length), (k.metadata && k.metadata.f) || 0]));
  // score points bought in the Vault land in the requested month's Done count
  const bonusBy = new Map(vaultKeys.map((k) => [k.name.slice('vault:'.length), (k.metadata && k.metadata.sb && k.metadata.sb[month]) || 0]));

  const players = users.map((u, i) => {
    const all = byUser.get(u.userId) || {};
    const rest = new Set(Array.isArray(restLists[i]) ? restLists[i] : []);
    const byDate = {};
    for (const [d, rec] of Object.entries(all)) if (d.startsWith(month + '-')) byDate[d] = rec;
    // days completed over the entire history (the All time column,
    // replaced This week per Pasha, 2026-09-06)
    let totalDone = 0;
    for (const rec of Object.values(all)) if (rec.done) totalDone++;
    // days completed within the requested month: the primary ranking metric
    // (per Pasha, 2026-09-01: most days done beats fewest missed, otherwise a
    // late joiner with 2 done / 0 missed would outrank a 28-done veteran).
    // Score points bought in the Vault add on top (per Pasha, 2026-09-07);
    // All time stays real played days only.
    const scoreBonus = bonusBy.get(u.userId) || 0;
    let doneDays = scoreBonus;
    for (const rec of Object.values(byDate)) if (rec.done) doneDays++;
    // last closed day in all of history: the digest uses it to tell
    // "did not make it today" from "has been silent for days"
    let lastDone = null;
    for (const [d, rec] of Object.entries(all)) if (rec.done && (!lastDone || d > lastDone)) lastDone = d;
    // days of silence as of today, NOT counting scheduled rest days:
    // legitimate rest is not a miss and does not push the player toward the harsh tone.
    // A reinstatement restarts the clock: the digest must not shame someone
    // "since Aug 20" the morning after Rauder let them back in.
    const idleFrom = [lastDone, u.reinstatedOn].filter(Boolean).sort().pop() || null;
    const idleDays = idleFrom ? countIdle(idleFrom, today, rest) : null;
    // the Roster clock also starts at the join date: a newcomer who never
    // closes a single day still runs out of time
    const silentFrom = [lastDone, u.reinstatedOn, u.joinedDate].filter(Boolean).sort().pop() || null;
    const silentDays = silentFrom ? countIdle(silentFrom, today, rest) : null;
    return {
      ...u,
      byDate,
      restDays: [...rest].filter((d) => d.startsWith(month.slice(0, 7))),
      restToday: rest.has(today) && !(all[today] && all[today].done),
      totalDone,
      doneDays,
      scoreBonus,
      links: linksBy.get(u.userId) || 0,
      frame: (frameBy.get(u.userId) || 0) > Date.now(),
      lastDone,
      idleDays,
      silentDays,
      streak: computeStreak(all, today, rest),
      missedDays: computeMissed(all, month, today, u.joinedDate, rest),
      doneToday: !!(all[today] && all[today].done),
      todayRuns: all[today] || null,
    };
  });

  // ranking: most days completed this month first; links break ties (the
  // Chain Protocol's promise), then fewer missed, longer streak, name
  players.sort((a, b) => b.doneDays - a.doneDays || b.links - a.links || a.missedDays - b.missedDays || b.streak - a.streak || a.displayName.localeCompare(b.displayName));
  return { month, today, days: monthDays(month), players };
}

// ---------- Chain Protocol ----------

// Pairs for a window, created lazily on first access and then stored, so a
// mid-window roster change never reshuffles anyone. Pool = players with at
// least one run BEFORE the window start (newcomers join at the next window).
async function getChainPairs(env, date) {
  const win = windowOf(date);
  const key = `chain:pairs:${win.id}`;
  let doc = await env.KOVA.get(key, 'json');
  if (doc) return { win, doc };

  const { users: allUsers, byUser } = await loadGroup(env);
  // Pool rule (tightened per Rauder, 2026-09-08, and again 2026-09-10): only
  // active players who have FULLY closed at least one day before the window
  // start, and who were silent for at most ROSTER.pairIdle non-rest days at
  // that point. Ghosts stay out: a partner who never shows up made three of
  // six pairs earn nothing in the first window. Silent 3-5 days = cold, the
  // pair pays double (the rescue) while the partner is still reachable.
  const idleAtStart = new Map();
  for (const u of allUsers) {
    if (u.inactive) continue;
    const recs = byUser.get(u.userId) || {};
    let lastDone = null;
    for (const [d, r] of Object.entries(recs)) if (r.done && d < win.start && (!lastDone || d > lastDone)) lastDone = d;
    if (!lastDone) continue;
    const rest = new Set((await env.KOVA.get(`rest:${u.userId}`, 'json')) || []);
    idleAtStart.set(u.userId, countIdle(lastDone, shiftDate(win.start, -1), rest));
  }
  const pool = allUsers.filter((u) => idleAtStart.has(u.userId) && idleAtStart.get(u.userId) <= ROSTER.pairIdle);
  if (pool.length < 2) { doc = { groups: [], cold: [] }; return { win, doc }; }

  const uids = pool.map((u) => u.userId).sort();
  const rand = seededRng(win.id);
  for (let i = uids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [uids[i], uids[j]] = [uids[j], uids[i]];
  }

  // best effort: not the same partner as in the previous two windows
  const prevPartners = new Map();
  for (const pid of [prevWindowIdOf(win), prevWindowIdOf({ id: prevWindowIdOf(win), start: win.start })]) {
    const prev = await env.KOVA.get(`chain:pairs:${pid}`, 'json').catch(() => null);
    if (!prev) continue;
    for (const g of prev.groups || []) {
      for (const a of g) for (const b of g) if (a !== b) {
        if (!prevPartners.has(a)) prevPartners.set(a, new Set());
        prevPartners.get(a).add(b);
      }
    }
  }
  const groups = [];
  for (let i = 0; i + 1 < uids.length; i += 2) groups.push([uids[i], uids[i + 1]]);
  if (uids.length % 2 === 1) groups[groups.length - 1].push(uids[uids.length - 1]);
  const bad = (a, b) => prevPartners.has(a) && prevPartners.get(a).has(b);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.length === 2 && bad(g[0], g[1]) && groups.length > 1) {
        const j = (i + 1) % groups.length;
        [g[1], groups[j][1]] = [groups[j][1], g[1]];
      }
    }
  }

  // cold members at window start (idle 3+ non-rest days): their chains pay double
  const cold = pool.filter((u) => idleAtStart.get(u.userId) >= 3).map((u) => u.userId);

  doc = { groups, cold, createdAt: Date.now() };
  await env.KOVA.put(key, JSON.stringify(doc), { expirationTtl: 60 * 60 * 24 * 45 });
  return { win, doc };
}

async function addLinks(env, uid, delta, why) {
  const key = `links:${uid}`;
  const doc = (await env.KOVA.get(key, 'json')) || { total: 0, log: [] };
  doc.total += delta;
  doc.log.push({ at: Date.now(), d: delta, why });
  doc.log = doc.log.slice(-40);
  await env.KOVA.put(key, JSON.stringify(doc), { metadata: { t: doc.total } });
  return doc.total;
}

async function getVault(env, uid) {
  return (await env.KOVA.get(`vault:${uid}`, 'json')) || {};
}

async function putVault(env, uid, doc) {
  // metadata mirrors what the leaderboard needs without a per-user GET:
  // f = Frame of Honor expiry, sb = bought score points per month
  const metadata = { f: doc.frameUntil || 0 };
  if (doc.scoreBonus) metadata.sb = doc.scoreBonus;
  await env.KOVA.put(`vault:${uid}`, JSON.stringify(doc), { metadata });
}

// A member's end of the chain is held for a date when they completed it,
// scheduled rest on it, or left the group entirely.
async function memberDayStatus(env, uid, date, userMap) {
  if (!userMap.has(uid)) return 'held';
  const rec = await env.KOVA.get(`completion:${uid}:${date}`, 'json');
  if (rec && rec.done) return 'done';
  const rest = (await env.KOVA.get(`rest:${uid}`, 'json')) || [];
  if (rest.includes(date)) return 'held';
  return 'waiting';
}

// Runs after every first completion of a day. Forges the chain when every
// end is held, pings the laggards when not. Backfilled dates (the grace
// window, healing) award quietly: links yes, channel noise no.
async function chainCheck(env, user, date) {
  try {
    if (!firstInWindow(`chain:${user.uid}:${date}`, 30000)) return;
    const today = groupDate(env);
    const quiet = date !== today;
    const { win, doc } = await getChainPairs(env, date);
    const gi = doc.groups.findIndex((g) => g.includes(user.uid));
    if (gi < 0) return;
    const group = doc.groups[gi];

    // removed players drop out of the map: their end reads as held, so a
    // partner left alone by a ghost still forges (same as a departed member)
    const { users } = await loadGroup(env);
    const userMap = new Map(users.filter((u) => !u.inactive).map((u) => [u.userId, u]));

    const completed = [user.uid];
    const waiting = [];
    for (const uid of group) {
      if (uid === user.uid) continue;
      const st = await memberDayStatus(env, uid, date, userMap);
      if (st === 'done') completed.push(uid);
      else if (st === 'waiting') waiting.push(uid);
    }

    if (waiting.length > 0) {
      if (quiet) return;
      const marker = `chain:wait:${win.id}:${date}:${gi}`;
      if (await env.KOVA.get(marker)) return;
      await env.KOVA.put(marker, '1', { expirationTtl: 60 * 60 * 36 });
      const me = userMap.get(user.uid);
      await announceChainWaiting(env, (me && me.displayName) || user.name, waiting);
      return;
    }

    // forged
    const marker = `chain:forged:${win.id}:${date}:${gi}`;
    if (await env.KOVA.get(marker)) return;
    await env.KOVA.put(marker, '1', { expirationTtl: 60 * 60 * 24 * 21 });

    const rescue = group.some((uid) => doc.cold.includes(uid));
    const delta = rescue ? LINKS.chain * LINKS.rescueMult : LINKS.chain;
    for (const uid of completed) await addLinks(env, uid, delta, `chain ${date}`);

    const stKey = `chain:state:${win.id}`;
    const st = (await env.KOVA.get(stKey, 'json')) || {};
    st[date] = st[date] || {};
    st[date][gi] = true;

    // perfect chain: every window day forged, or neutral (all ends resting
    // or departed with nobody completing). Future days block perfection.
    let perfectNow = false;
    const already = st.perfect && st.perfect[gi];
    if (!already) {
      let allHeld = true;
      for (const d of win.days) {
        if (st[d] && st[d][gi]) continue;
        if (d > today && d > date) { allHeld = false; break; }
        let neutral = true;
        for (const uid of group) {
          const s = await memberDayStatus(env, uid, d, userMap);
          if (s !== 'held') { neutral = false; break; }
        }
        if (!neutral) { allHeld = false; break; }
      }
      if (allHeld) {
        st.perfect = st.perfect || {};
        st.perfect[gi] = true;
        perfectNow = true;
        for (const uid of group) if (userMap.has(uid)) await addLinks(env, uid, LINKS.perfect, `perfect chain ${win.id}`);
      }
    }
    await env.KOVA.put(stKey, JSON.stringify(st), { expirationTtl: 60 * 60 * 24 * 45 });

    if (!quiet) {
      const members = group.map((uid) => userMap.get(uid) || { userId: uid, displayName: 'departed', avatar: null });
      await announceChainForged(env, members, delta, rescue, perfectNow);
    }
  } catch { /* chains never break a check-in */ }
}

async function announceChainWaiting(env, completerName, laggardIds) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  try {
    const mentions = laggardIds.map((id) => `<@${id}>`).join(' ');
    const lines = [`[${completerName} has held their end. The chain waits on you.]`];
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: mentions + '\n' + systemBlock(lines),
        allowed_mentions: { users: laggardIds },
      }),
    });
  } catch { /* the ping is not critical */ }
}

// ---------- chain art (resvg) ----------

let resvgReady = null;
function ensureResvg() {
  if (!resvgReady) {
    resvgReady = initWasm(resvgWasm).catch((e) => { resvgReady = null; throw e; });
  }
  return resvgReady;
}

async function avatarDataUri(url) {
  try {
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > 400000) return null;
    let bin = '';
    for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
    const ct = (res.headers.get('content-type') || 'image/png').split(';')[0];
    return `data:${ct};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

// The site's chain in profile at card scale (per Rauder, 2026-09-10: the
// Discord card and the chain map must be the same chain): stadium rings
// joined by edge-on waisted links, a soft halo, energy dashes running
// around the rings and a spark riding the run. `phase` in [0, 1) is the
// animation position.
function chainRun(x1, x2, y, phase) {
  const ringW = 50, ringH = 30, pitch = 64, edgeW = 30, edgeH = 33;
  const span = x2 - x1;
  const n = Math.max(2, Math.floor((span + (pitch - ringW)) / pitch));
  const total = n * ringW + (n - 1) * (pitch - ringW);
  const start = x1 + (span - total) / 2;
  const rings = [];
  const edges = [];
  for (let i = 0; i < n; i++) {
    const rx = start + i * pitch;
    rings.push(`<rect x="${rx.toFixed(1)}" y="${(y - ringH / 2).toFixed(1)}" width="${ringW}" height="${ringH}" rx="${ringH / 2}"/>`);
    if (i < n - 1) {
      const cx = rx + ringW + (pitch - ringW) / 2;
      const hw = edgeW / 2, hh = edgeH / 2, pinch = hh * 0.56, cw = hw / 3;
      const f = (v) => v.toFixed(1);
      edges.push(`<path d="M${f(cx - hw)} ${f(y - hh)} C${f(cx - cw)} ${f(y - pinch)} ${f(cx + cw)} ${f(y - pinch)} ${f(cx + hw)} ${f(y - hh)} `
        + `L${f(cx + hw)} ${f(y + hh)} C${f(cx + cw)} ${f(y + pinch)} ${f(cx - cw)} ${f(y + pinch)} ${f(cx - hw)} ${f(y + hh)} Z"/>`);
    }
  }
  const ringStr = rings.join('');
  const sparkX = (x1 + span * phase).toFixed(1);
  return `<g fill="none" stroke="#E8B64A" stroke-opacity="0.26" stroke-width="14">${ringStr}</g>`
    + `<g fill="none" stroke="#E8B64A" stroke-width="5.5">${ringStr}</g>`
    + `<g fill="#E8B64A">${edges.join('')}</g>`
    + `<g fill="none" stroke="#FFF3D6" stroke-opacity="0.7" stroke-width="2.2" stroke-dasharray="10 24" stroke-dashoffset="${(-phase * 34).toFixed(2)}">${ringStr}</g>`
    + `<circle cx="${sparkX}" cy="${y}" r="16" fill="url(#spark)"/>`
    + `<circle cx="${sparkX}" cy="${y}" r="4.6" fill="#FFF7E6"/>`;
}

// Card geometry shared by the frames: a status-window panel with the
// avatars on it. Shapes only, no text (no fonts ship with the worker).
function chainCardLayout(members) {
  const n = members.length;
  return { W: n === 3 ? 960 : 640, H: 260, y: 130, xs: n === 3 ? [120, 480, 840] : [132, 508], r: 62 };
}

function chainCardSvg(members, avatars, phase, crop) {
  const { W, H, y, xs, r } = chainCardLayout(members);
  const discs = members.map((m, i) => {
    const cx = xs[i];
    if (avatars[i]) {
      return `<clipPath id="c${i}"><circle cx="${cx}" cy="${y}" r="${r}"/></clipPath>`
        + `<image href="${avatars[i]}" x="${cx - r}" y="${y - r}" width="${r * 2}" height="${r * 2}" clip-path="url(#c${i})" preserveAspectRatio="xMidYMid slice"/>`
        + `<circle cx="${cx}" cy="${y}" r="${r}" fill="none" stroke="#E8B64A" stroke-width="3"/>`;
    }
    const hue = 20 + (Number(BigInt(m.userId || '0') % 300n));
    return `<circle cx="${cx}" cy="${y}" r="${r}" fill="hsl(${hue} 30% 32%)" stroke="#E8B64A" stroke-width="3"/>`;
  }).join('');
  const chains = xs.slice(1).map((x, i) => chainRun(xs[i] + r + 10, x - r - 10, y, phase)).join('');
  // a crop renders just that region of the same picture (the animation strip)
  const view = crop ? `width="${crop.w}" height="${crop.h}" viewBox="${crop.x} ${crop.y} ${crop.w} ${crop.h}"` : `width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" ${view}>
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#E8B64A" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#E8B64A" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="spark">
      <stop offset="0%" stop-color="#FFF3D6" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#E8B64A" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#08070C"/>
  <g stroke="#7C6CF0" stroke-opacity="0.06" stroke-width="1">
    ${Array.from({ length: Math.floor(W / 64) }, (_, i) => `<line x1="${(i + 1) * 64}" y1="0" x2="${(i + 1) * 64}" y2="${H}"/>`).join('')}
    ${Array.from({ length: Math.floor(H / 64) }, (_, i) => `<line x1="0" y1="${(i + 1) * 64}" x2="${W}" y2="${(i + 1) * 64}"/>`).join('')}
  </g>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="6" y="6" width="${W - 12}" height="${H - 12}" fill="#121216" fill-opacity="0.5" stroke="#3A3A3E" stroke-width="1"/>
  <g stroke="#7C6CF0" stroke-width="3" fill="none">
    <path d="M6 22 V6 H22"/><path d="M${W - 22} 6 H${W - 6} V22"/>
    <path d="M6 ${H - 22} V${H - 6} H22"/><path d="M${W - 22} ${H - 6} H${W - 6} V${H - 22}"/>
  </g>
  ${chains}
  ${discs}
</svg>`;
}

// ---- APNG assembly. Frame 0 is the whole card, every later frame repaints
// only the chain band (an fcTL sub-region), so the file stays small and the
// render cheap. Discord desktop plays APNG attachments; a client that does
// not simply shows the first frame, which is the finished static card.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function pngChunk(type, data) {
  const body = concatBytes([new Uint8Array([...type].map((ch) => ch.charCodeAt(0))), data]);
  return concatBytes([new Uint8Array(be32(data.length)), body, new Uint8Array(be32(crc32(body)))]);
}
// IHDR data and the concatenated IDAT payload of a PNG
function pngParts(png) {
  let p = 8;
  let ihdr = null;
  const idat = [];
  while (p + 8 <= png.length) {
    const len = ((png[p] << 24) | (png[p + 1] << 16) | (png[p + 2] << 8) | png[p + 3]) >>> 0;
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr || !idat.length) throw new Error('not a PNG');
  return { ihdr, data: concatBytes(idat) };
}
// frames: [{ png, x, y, delay? }], frames[0] full size at offset 0. With
// opts.defaultPng that separate full-size PNG is the default image (what a
// client without APNG support shows) and is not part of the animation.
function buildApng(frames, delayMs, opts = {}) {
  const base = pngParts(opts.defaultPng || frames[0].png);
  const sameFormat = (ihdr) => [8, 9, 10, 11, 12].every((i) => ihdr[i] === base.ihdr[i]);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', base.ihdr)];
  parts.push(pngChunk('acTL', new Uint8Array([...be32(frames.length), ...be32(0)])));
  let seq = 0;
  const fctl = (ihdr, x, y, delay) => {
    const d = new Uint8Array(26);
    d.set(be32(seq++), 0);
    d.set(ihdr.subarray(0, 8), 4); // width, height straight from the frame's IHDR
    d.set(be32(x), 12); d.set(be32(y), 16);
    d.set([(delay >> 8) & 255, delay & 255, 3, 232], 20); // delay = ms / 1000
    d[24] = 0; d[25] = 0; // dispose none, blend source
    return pngChunk('fcTL', d);
  };
  const fdat = (data) => pngChunk('fdAT', concatBytes([new Uint8Array(be32(seq++)), data]));
  let rest = frames;
  if (opts.defaultPng) {
    parts.push(pngChunk('IDAT', base.data)); // no fcTL before it: default image only
  } else {
    parts.push(fctl(base.ihdr, 0, 0, frames[0].delay || delayMs), pngChunk('IDAT', base.data));
    rest = frames.slice(1);
  }
  for (const f of rest) {
    const fp = pngParts(f.png);
    if (!sameFormat(fp.ihdr)) throw new Error('frame format mismatch');
    parts.push(fctl(fp.ihdr, f.x, f.y, f.delay || delayMs), fdat(fp.data));
  }
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  return concatBytes(parts);
}

const CHAIN_FRAMES = 12;
const CHAIN_FRAME_MS = 80;

// The CHAIN FORGED card, animated: a full first frame plus a strip per
// phase covering the chain band, all rendered at 2x. Any hiccup in the
// animation path degrades to the static first frame.
async function buildChainArt(members) {
  await ensureResvg();
  const { y, xs, r } = chainCardLayout(members);
  const avatars = await Promise.all(members.map((m) => avatarDataUri(m.avatar)));
  const render = (phase, crop) => new Resvg(chainCardSvg(members, avatars, phase, crop), { fitTo: { mode: 'zoom', value: 2 } }).render().asPng();
  const still = render(0, null);
  try {
    const crop = { x: xs[0] + r + 4, y: y - 40, w: xs[xs.length - 1] - r - 4 - (xs[0] + r + 4), h: 80 };
    const frames = [{ png: still, x: 0, y: 0 }];
    for (let i = 1; i < CHAIN_FRAMES; i++) {
      frames.push({ png: render(i / CHAIN_FRAMES, crop), x: crop.x * 2, y: crop.y * 2 });
    }
    return buildApng(frames, CHAIN_FRAME_MS);
  } catch {
    return still;
  }
}

// The reinstatement card: the System re-scans the returning player. Grey
// avatar below the scanline, colour above, the dashed rings wake up with
// it, the readout brackets fill; the final state carries the gold ring.
function reinstateCardSvg(member, avatar, p, final, crop) {
  const W = 640, H = 260, cx = 320, cy = 130, r = 62;
  const scanY = cy - r - 8 + (2 * r + 16) * p;
  const grid = [];
  for (let i = 1; i < W / 64; i++) grid.push(`<line x1="${i * 64}" y1="0" x2="${i * 64}" y2="${H}"/>`);
  for (let i = 1; i < H / 64; i++) grid.push(`<line x1="0" y1="${i * 64}" x2="${W}" y2="${i * 64}"/>`);
  const wake = final ? 1 : p;
  const ringOp = (0.22 + 0.36 * wake).toFixed(2);
  const hue = 20 + (Number(BigInt(member.userId || '0') % 300n));
  const discGrey = avatar
    ? `<image href="${avatar}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#disc)" filter="url(#grey)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#34343a"/>`;
  const discColor = avatar
    ? `<image href="${avatar}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#disc)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${hue} 30% 32%)"/>`;
  const bars = [[48, -8], [30, 2]].map(([len, dy]) => {
    const l = (len * wake).toFixed(1);
    return `<rect x="${cx - 152}" y="${cy + dy}" width="${l}" height="3"/><rect x="${(cx + 152 - len * wake).toFixed(1)}" y="${cy + dy}" width="${l}" height="3"/>`;
  }).join('');
  const readOp = (0.35 + 0.45 * wake).toFixed(2);
  const view = crop ? `width="${crop.w}" height="${crop.h}" viewBox="${crop.x} ${crop.y} ${crop.w} ${crop.h}"` : `width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" ${view}>
  <defs>
    <radialGradient id="glow"><stop offset="0" stop-color="#7C6CF0" stop-opacity="0.24"/><stop offset="1" stop-color="#7C6CF0" stop-opacity="0"/></radialGradient>
    <filter id="grey"><feColorMatrix type="saturate" values="0.05"/><feComponentTransfer><feFuncR type="linear" slope="0.55"/><feFuncG type="linear" slope="0.55"/><feFuncB type="linear" slope="0.6"/></feComponentTransfer></filter>
    <clipPath id="disc"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
    <clipPath id="above"><rect x="0" y="0" width="${W}" height="${final ? H : scanY.toFixed(1)}"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="#08070C"/>
  <g stroke="#7C6CF0" stroke-opacity="0.06" stroke-width="1">${grid.join('')}</g>
  <circle cx="${cx}" cy="${cy}" r="150" fill="url(#glow)"/>
  <rect x="6" y="6" width="${W - 12}" height="${H - 12}" fill="#121216" fill-opacity="0.5" stroke="#3A3A3E" stroke-width="1"/>
  <g stroke="#7C6CF0" stroke-width="3" fill="none">
    <path d="M6 22 V6 H22"/><path d="M${W - 22} 6 H${W - 6} V22"/>
    <path d="M6 ${H - 22} V${H - 6} H22"/><path d="M${W - 22} ${H - 6} H${W - 6} V${H - 22}"/>
  </g>
  <circle cx="${cx}" cy="${cy}" r="96" fill="none" stroke="#B7AEF7" stroke-opacity="${ringOp}" stroke-width="1" stroke-dasharray="2 7"/>
  <circle cx="${cx}" cy="${cy}" r="82" fill="none" stroke="#7C6CF0" stroke-opacity="${(ringOp * 0.7).toFixed(2)}" stroke-width="1" stroke-dasharray="1 5"/>
  ${discGrey}
  <g clip-path="url(#above)">${discColor}</g>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${final ? '#E8B64A' : '#7C6CF0'}" stroke-width="3"/>
  ${final
    ? `<circle cx="${cx}" cy="${cy}" r="${r + 10}" fill="none" stroke="#E8B64A" stroke-opacity="0.35" stroke-width="6"/>`
    : `<rect x="${cx - r - 30}" y="${(scanY - 14).toFixed(1)}" width="${2 * r + 60}" height="14" fill="#B7AEF7" fill-opacity="0.18"/><rect x="${cx - r - 30}" y="${(scanY - 1.5).toFixed(1)}" width="${2 * r + 60}" height="3" fill="#EFE9FF" fill-opacity="0.9"/>`}
  <g stroke="#B7AEF7" stroke-opacity="${readOp}" stroke-width="2" fill="none">
    <path d="M${cx - 150} ${cy - 26} h-14 v52 h14"/><path d="M${cx + 150} ${cy - 26} h14 v52 h-14"/>
  </g>
  <g fill="#B7AEF7" fill-opacity="${readOp}">${bars}</g>
</svg>`;
}

const REINSTATE_FRAMES = 12;

// The reinstatement card as APNG: the default image is the finished gold
// state (what a non-animating client shows), the animation is the scan.
async function buildReinstateArt(member) {
  await ensureResvg();
  const avatar = await avatarDataUri(member.avatar);
  const render = (p, final, crop) => new Resvg(reinstateCardSvg(member, avatar, p, final, crop), { fitTo: { mode: 'zoom', value: 2 } }).render().asPng();
  const still = render(1, true, null);
  try {
    // everything that moves lives inside this band: rings, discs, readout
    const crop = { x: 148, y: 30, w: 344, h: 200 };
    const frames = [{ png: render(0, false, null), x: 0, y: 0 }];
    for (let i = 1; i <= REINSTATE_FRAMES; i++) {
      frames.push({ png: render(i / REINSTATE_FRAMES, false, crop), x: crop.x * 2, y: crop.y * 2 });
    }
    frames.push({ png: render(1, true, crop), x: crop.x * 2, y: crop.y * 2, delay: 1600 });
    return buildApng(frames, 90, { defaultPng: still });
  } catch {
    return still;
  }
}

// The return, said out loud (per Rauder, 2026-09-11): a ping, the record
// of the last stay, the card. Falls back to the plain block.
async function announceReinstated(env, member, stats) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  try {
    const lines = ['[KOVA STREAK // ROSTER UPDATE]', `[The gate reopened. ${member.displayName} walks back in.]`];
    if (stats.totalDone > 0) {
      lines.push(`[Last time: ${stats.totalDone} closed ${stats.totalDone === 1 ? 'day' : 'days'}, then silence since ${shortDate(stats.lastDone)}.]`);
    } else {
      lines.push('[Last time: not a single closed day.]');
    }
    lines.push('[Let us see how this one holds this time. The System is watching. Closely.]');
    const payload = { content: `<@${member.userId}>\n` + systemBlock(lines), allowed_mentions: { users: [member.userId] } };
    try {
      const png = await buildReinstateArt(member);
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify(payload));
      fd.append('files[0]', new Blob([png], { type: 'image/png' }), 'reinstated.png');
      const res = await fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', body: fd });
      if (res.ok) return;
    } catch { /* fall through to the plain block */ }
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch { /* the announce is not critical */ }
}

async function announceChainForged(env, members, delta, rescue, perfect) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  try {
    const names = members.map((m) => m.displayName).join(' x ');
    const ids = members.map((m) => m.userId);
    const endsWord = members.length === 3 ? 'All three ends' : 'Both ends';
    const lines = [`[CHAIN FORGED // ${names}]`, `[${endsWord} held. +${delta} ${delta === 1 ? 'link' : 'links'} each.]`];
    if (rescue) lines.push('[Rescue chain. Reward doubled.]');
    if (perfect) lines.push(`[PERFECT CHAIN. Every day of the window. +${LINKS.perfect} bonus.]`);
    const content = ids.map((id) => `<@${id}>`).join(' ') + '\n' + systemBlock(lines);

    // v2: the rendered chain card. Any failure falls back to the plain embed.
    try {
      const png = await buildChainArt(members);
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify({ content, allowed_mentions: { users: ids } }));
      fd.append('files[0]', new Blob([png], { type: 'image/png' }), 'chain.png');
      const res = await fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', body: fd });
      if (res.ok) return;
    } catch { /* fall back to the plain embed */ }

    const embed = {
      color: 0xE8B64A,
      author: { name: `[CHAIN FORGED // ${names}]` },
      description: systemBlock(lines.slice(1)),
    };
    if (members[0] && members[0].avatar) embed.author.icon_url = members[0].avatar;
    if (members[1] && members[1].avatar) embed.thumbnail = { url: members[1].avatar };
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: ids.map((id) => `<@${id}>`).join(' '),
        embeds: [embed],
        allowed_mentions: { users: ids },
      }),
    });
  } catch { /* the post is not critical */ }
}

// 03:30 group time: a held Streak Shield converts yesterday's zero-run day
// into a rest day. Public: the digest reports every absorb.
async function shieldSweep(env) {
  const today = groupDate(env);
  const target = shiftDate(today, -1);
  const vaultKeys = await listAll(env, 'vault:');
  const used = [];
  for (const k of vaultKeys) {
    const uid = k.name.slice('vault:'.length);
    const doc = await env.KOVA.get(k.name, 'json');
    if (!doc || !doc.shield) continue;
    const rec = await env.KOVA.get(`completion:${uid}:${target}`, 'json');
    if (rec && rec.completedRuns > 0) continue; // played something: the day is theirs to own
    const rest = (await env.KOVA.get(`rest:${uid}`, 'json')) || [];
    if (rest.includes(target)) continue;
    rest.push(target);
    rest.sort();
    await env.KOVA.put(`rest:${uid}`, JSON.stringify(rest));
    doc.shield = false;
    doc.shieldDays = [...(doc.shieldDays || []), target].slice(-12);
    await putVault(env, uid, doc);
    used.push(uid);
  }
  if (used.length) {
    await env.KOVA.put(`shieldused:${today}`, JSON.stringify(used), { expirationTtl: 60 * 60 * 72 });
  }
  return used;
}

// ---------- Roster Protocol ----------

const ROSTER_NOTICE_LINES = [
  '[KOVA STREAK // FINAL NOTICE]',
  '[Two weeks without a single closed day.]',
  '[This is your last day on the roster. Close today\'s playlist and the notice is void.]',
  '[Silence past midnight and the System removes you. The way back is a message to Rauder.]',
];
const ROSTER_REMOVED_LINES = [
  '[KOVA STREAK // ROSTER UPDATE]',
  '[The final notice went unanswered. You have been removed from the roster.]',
  '[Your history is kept. Nothing is lost.]',
  '[To return, message Rauder and ask to be reinstated. The gate reopens on his word.]',
];

// A private word from the System. Bot DM first; if the player keeps DMs
// closed (or no bot is configured) the same block lands in the channel
// with a mention, so the notice is never silently lost.
async function sendSystemDm(env, uid, lines) {
  const content = systemBlock(lines);
  if (env.DISCORD_BOT_TOKEN) {
    try {
      const headers = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': BOT_UA };
      const ch = await fetch('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST', headers, body: JSON.stringify({ recipient_id: uid }),
      });
      if (ch.ok) {
        const { id } = await ch.json();
        const msg = await fetch(`https://discord.com/api/v10/channels/${id}/messages`, {
          method: 'POST', headers, body: JSON.stringify({ content }),
        });
        if (msg.ok) return 'dm';
      }
    } catch { /* fall through to the channel */ }
  }
  if (!env.DISCORD_WEBHOOK_URL) return false;
  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `<@${uid}>\n` + content, allowed_mentions: { users: [uid] } }),
    });
    return 'channel';
  } catch {
    return false;
  }
}

// The morning roster sweep (03:30 group time, after the shield sweep).
// Silent for ROSTER.noticeIdle days = final notice, served once; still
// silent the morning after the notice = removed. Anyone already past the
// line when this shipped gets the notice first, never a surprise removal.
// A player who closes a day clears their notice; a removed player is
// hidden from live boards, chains and the digest until reinstated.
async function rosterSweep(env) {
  const today = groupDate(env);
  const standings = await buildStandings(env, today.slice(0, 7));
  const noticed = [];
  const removed = [];
  for (const p of standings.players) {
    if (p.silentDays == null) continue;
    const marker = `roster:notice:${p.userId}`;
    if (p.silentDays < ROSTER.noticeIdle) {
      // back in training: a stale notice must not turn into a surprise later
      if (await env.KOVA.get(marker)) await env.KOVA.delete(marker);
      continue;
    }
    const served = await env.KOVA.get(marker);
    if (!served) {
      await env.KOVA.put(marker, today, { expirationTtl: 60 * 60 * 24 * 10 });
      const via = await sendSystemDm(env, p.userId, ROSTER_NOTICE_LINES);
      noticed.push({ userId: p.userId, name: p.displayName, via });
      continue;
    }
    if (served < today && p.silentDays >= ROSTER.removeIdle) {
      const key = `user:${p.userId}`;
      const profile = (await env.KOVA.get(key, 'json')) || { displayName: p.displayName, avatar: p.avatar, joinedDate: p.joinedDate };
      profile.inactiveSince = today;
      await env.KOVA.put(key, JSON.stringify(profile), { metadata: profileMeta(profile) });
      await env.KOVA.delete(marker);
      const via = await sendSystemDm(env, p.userId, ROSTER_REMOVED_LINES);
      removed.push({ userId: p.userId, name: p.displayName, via });
    }
  }
  if (noticed.length || removed.length) await appendRosterEvents(env, today, { noticed, removed });
  return { noticed, removed };
}

// roster:events:{day} collects what the day did to the roster (the digest
// reads it); the sweep and a reinstatement both append, never overwrite
async function appendRosterEvents(env, day, patch) {
  const key = `roster:events:${day}`;
  const ev = (await env.KOVA.get(key, 'json')) || {};
  for (const [field, items] of Object.entries(patch)) {
    if (items && items.length) ev[field] = [...(ev[field] || []), ...items];
  }
  await env.KOVA.put(key, JSON.stringify(ev), { expirationTtl: 60 * 60 * 72 });
}

// The weekly trial: created at playlist publish, resolved in the Sunday
// digest. Winner = the largest percentage over your own snapshotted PB.
async function createTrial(env, playlist, publishedOn) {
  const dowMon = (new Date(publishedOn + 'T00:00:00Z').getUTCDay() + 6) % 7;
  // a Sunday publish targets the week that starts tomorrow
  const weekKey = dowMon === 6 ? shiftDate(publishedOn, 1) : weekKeyOf(publishedOn);
  const existing = await env.KOVA.get('trial:current', 'json');
  if (existing && existing.weekKey === weekKey) return null; // mid-week republish keeps the trial
  const rand = seededRng('trial:' + weekKey);
  const scenario = playlist.scenarios[Math.floor(rand() * playlist.scenarios.length)].name;
  const { users } = await loadGroup(env);
  const baselines = {};
  for (const u of users) {
    const pb = await env.KOVA.get(`pb:${u.userId}`, 'json');
    if (pb && pb[scenario] && pb[scenario].s > 0) baselines[u.userId] = pb[scenario].s;
  }
  const trial = { scenario, weekKey, baselines, createdAt: Date.now(), resolved: false };
  await env.KOVA.put('trial:current', JSON.stringify(trial));
  return trial;
}

async function announceTrial(env, trial) {
  if (!env.DISCORD_WEBHOOK_URL || !trial) return;
  try {
    const lines = [
      `[WEEKLY TRIAL // ${trial.scenario}]`,
      '[Beat your own record. The largest improvement takes the crown on Sunday.]',
      `[Any new personal best on it earns +${LINKS.trialPart} link. The top improver takes +${LINKS.trialWin}.]`,
    ];
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: systemBlock(lines), allowed_mentions: { parse: [] } }),
    });
  } catch { /* the announce is not critical */ }
}

async function resolveTrial(env, today) {
  const trial = await env.KOVA.get('trial:current', 'json');
  if (!trial || trial.resolved || trial.weekKey !== weekKeyOf(today)) return [];
  const { users } = await loadGroup(env);
  const improvers = [];
  for (const u of users) {
    const base = trial.baselines[u.userId];
    if (!base) continue;
    const pb = await env.KOVA.get(`pb:${u.userId}`, 'json');
    const cur = pb && pb[trial.scenario] && pb[trial.scenario].s;
    if (cur && cur > base) improvers.push({ uid: u.userId, name: u.displayName, pct: ((cur - base) / base) * 100 });
  }
  trial.resolved = true;
  await env.KOVA.put('trial:current', JSON.stringify(trial));
  if (!improvers.length) return [`[TRIAL COMPLETE // ${trial.scenario}. No records fell this week.]`];
  improvers.sort((a, b) => b.pct - a.pct);
  const top = improvers[0];
  for (const im of improvers) {
    const win = im.pct === top.pct;
    await addLinks(env, im.uid, LINKS.trialPart + (win ? LINKS.trialWin : 0), `trial ${trial.weekKey}`);
  }
  const lines = [`[TRIAL COMPLETE // ${top.name} improved ${top.pct.toFixed(1)}%. The System took note. +${LINKS.trialWin + LINKS.trialPart} links.]`];
  if (improvers.length > 1) lines.push(`[${improvers.length} players beat their record. +${LINKS.trialPart} link each.]`);
  return lines;
}

// ---------- Discord OAuth ----------

function discordRedirectUri(request) {
  return new URL('/auth/callback', new URL(request.url).origin).toString();
}

// Where to send the player back after login. The origin is checked against the whitelist:
// otherwise a link like /auth/login?redirect=evil.com could be slipped to a victim
// to steal their session token from the URL fragment.
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

  // Only members of the group's server are let in, if GUILD_ID is set.
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
  // spread first: a login must not wipe Roster flags (removed players can
  // still sign in and watch, they just stay off the boards until reinstated)
  const profile = {
    ...(existing || {}),
    displayName,
    avatar,
    joinedAt: existing ? existing.joinedAt : Date.now(),
    joinedDate: existing ? existing.joinedDate : groupDate(env),
  };
  await env.KOVA.put(`user:${me.id}`, JSON.stringify(profile), { metadata: profileMeta(profile) });

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
    const profile = await env.KOVA.get(`user:${user.uid}`, 'json');
    return json({
      ...user,
      coachEnabled: await coachAllowed(env, user),
      // the frontend fences stats and coach to days from this date on
      joinedDate: (profile && profile.joinedDate) || null,
    }, 200, cors);
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
    // Archive the outgoing playlist: yesterday-healing on the client judges
    // yesterday by the playlist that was ACTIVE yesterday, so a weekly swap
    // does not burn the previous day (files stop matching the new list).
    const old = await env.KOVA.get('playlist:current', 'json');
    if (old && Array.isArray(old.scenarios) && old.scenarios.length) {
      await env.KOVA.put('playlist:prev', JSON.stringify({ ...old, replacedOn: groupDate(env) }));
    }
    await env.KOVA.put('playlist:current', JSON.stringify(playlist));
    // the weekly trial rides the playlist publish (see CHAIN_PROTOCOL.md)
    if (ctx) ctx.waitUntil((async () => {
      const trial = await createTrial(env, playlist, groupDate(env));
      await announceTrial(env, trial);
    })());
    return json(playlist, 200, cors);
  }

  // The previously active playlist (with replacedOn): the client uses it to
  // evaluate yesterday across a weekly playlist swap.
  if (path === '/api/playlist/prev' && request.method === 'GET') {
    const prev = await env.KOVA.get('playlist:prev', 'json');
    return json(prev || { scenarios: [], replacedOn: null }, 200, cors);
  }

  if (path === '/api/completion' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || !isDate(body.date)) return json({ error: 'date is required' }, 400, cors);

    // The client sends the date (its local day). We accept yesterday, today
    // and tomorrow in group time: a player in a timezone east of the admin
    // lives a day ahead, and backdating beyond yesterday is closed off anyway.
    const today = groupDate(env);
    if (![shiftDate(today, -1), today, shiftDate(today, 1)].includes(body.date)) {
      return json({ error: 'Date out of range' }, 400, cors);
    }

    const requiredRuns = Math.max(0, Number(body.requiredRuns) || 0);
    const completedRuns = Math.max(0, Math.min(requiredRuns, Number(body.completedRuns) || 0));
    const done = requiredRuns > 0 && completedRuns >= requiredRuns;

    const key = `completion:${user.uid}:${body.date}`;
    const prev = await env.KOVA.get(key, 'json');
    // First crossing of 100% for this day: prev either did not exist or was
    // partial. Repeated posts for the same day (a tab reload)
    // do not trigger the announcement.
    const firstCompletionToday = done && !(prev && prev.done);
    // The day is already closed: do not let a partial scan accidentally roll it back
    // (for example, after a playlist change in the middle of the day).
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
    // list after put is eventually consistent in KV: we slot the fresh record in ourselves
    if (!(prev && prev.done && !done)) all[body.date] = { completedRuns, requiredRuns, done };
    const profile = await env.KOVA.get(`user:${user.uid}`, 'json');
    const restArr = (await env.KOVA.get(`rest:${user.uid}`, 'json')) || [];
    const rest = new Set(restArr);
    // Streak anchor = the player's topmost closed day. A player east of the group
    // lives a day ahead: their "tomorrow" is already closed, the streak runs from there.
    const upD = shiftDate(today, 1);
    const anchor = all[upD] && all[upD].done ? upD : today;
    const streak = computeStreak(all, anchor, rest);

    // Chain Protocol: individual completion announces are gone (channel
    // noise); the chain does the talking now. Backfilled dates award quietly.
    if (firstCompletionToday && ctx) ctx.waitUntil(chainCheck(env, user, body.date));

    return json({
      ok: true,
      done,
      streak,
      missedDays: computeMissed(all, anchor.slice(0, 7), anchor, profile && profile.joinedDate, rest),
    }, 200, cors);
  }

  // rest days: up to 2 per week, declared STRICTLY before the day starts in group
  // time. Not retroactively and not during the day: that is exactly the guard against
  // "forgot to play, will file a rest day in the evening".
  if (path === '/api/rest' && request.method === 'GET') {
    const dates = (await env.KOVA.get(`rest:${user.uid}`, 'json')) || [];
    return json({ dates, quota: REST_QUOTA_PER_WEEK, today: groupDate(env) }, 200, cors);
  }

  if (path === '/api/rest' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || !isDate(body.date) || typeof body.on !== 'boolean') {
      return json({ error: 'date and on are required' }, 400, cors);
    }
    const today = groupDate(env);
    if (body.date <= today) {
      return json({ error: 'Rest days must be scheduled before the day starts. Today and past days cannot be changed.' }, 400, cors);
    }
    if (body.date > shiftDate(today, 21)) {
      return json({ error: 'Rest days can be scheduled at most 3 weeks ahead' }, 400, cors);
    }
    let dates = (await env.KOVA.get(`rest:${user.uid}`, 'json')) || [];
    if (body.on) {
      if (!dates.includes(body.date)) {
        // shield-converted days are emergencies, they never eat the weekly quota
        const vault = await getVault(env, user.uid);
        const shieldDays = new Set(vault.shieldDays || []);
        const sameWeek = dates.filter((d) => weekKeyOf(d) === weekKeyOf(body.date) && !shieldDays.has(d)).length;
        if (sameWeek >= REST_QUOTA_PER_WEEK) {
          // a held Vault voucher buys ONE day over the quota, once a calendar month
          const month = body.date.slice(0, 7);
          if (vault.voucher && vault.voucherUsedMonth !== month) {
            vault.voucher = false;
            vault.voucherUsedMonth = month;
            await putVault(env, user.uid, vault);
          } else {
            return json({ error: `Only ${REST_QUOTA_PER_WEEK} rest days per week` }, 400, cors);
          }
        }
        dates.push(body.date);
      }
    } else {
      dates = dates.filter((d) => d !== body.date);
    }
    // history older than 4 months is not needed even for long streaks
    const keepFrom = shiftDate(today, -120);
    dates = dates.filter((d) => d >= keepFrom).sort();
    await env.KOVA.put(`rest:${user.uid}`, JSON.stringify(dates));
    return json({ dates, quota: REST_QUOTA_PER_WEEK, today }, 200, cors);
  }

  // Personal bests for the weekly playlist's scenarios. The client sends its bests,
  // the worker stores them in pb:{uid} (only the owner writes the doc, no races).
  // Improving an existing best triggers a search for fallen records and a ping
  // (announceRecords). The first upload is entirely silent: it is a history baseline,
  // not an event, otherwise release day would bring a storm of old records.
  if (path === '/api/scores' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const incoming = body && body.bests;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return json({ error: 'bests object is required' }, 400, cors);
    }

    const key = `pb:${user.uid}`;
    const stored = await env.KOVA.get(key, 'json');
    const doc = stored || {};
    const firstUpload = !stored;
    const improvements = [];
    let changed = false;
    let n = 0;
    for (const [rawName, rawScore] of Object.entries(incoming)) {
      if (++n > 60) break;
      const name = String(rawName).trim().slice(0, 120);
      const score = Number(rawScore);
      if (!name || !Number.isFinite(score) || score <= 0) continue;
      const old = doc[name];
      if (old && score <= old.s) continue;
      // i:1 only on real improvements: history baselines and first runs
      // of a new scenario do not count as records of the day in the digest
      const isImp = !firstUpload && !!old;
      doc[name] = isImp ? { s: score, at: Date.now(), i: 1 } : { s: score, at: Date.now() };
      changed = true;
      // ping only on improving an ALREADY known best: a new scenario in the doc
      // is also a baseline (the first week played with it), not an event
      if (isImp) improvements.push({ name, oldS: old.s, newS: score });
    }
    if (changed) await env.KOVA.put(key, JSON.stringify(doc));
    if (improvements.length && ctx) ctx.waitUntil(announceRecords(env, user, improvements));
    return json({ ok: true, improved: improvements.length }, 200, cors);
  }

  if (path === '/api/group' && request.method === 'GET') {
    const month = url.searchParams.get('month');
    if (!isMonth(month)) return json({ error: 'month must be YYYY-MM' }, 400, cors);
    // a past month is a closed record: removed players keep their place in it
    const includeInactive = month < groupDate(env).slice(0, 7);
    return json(await buildStandings(env, month, { includeInactive }), 200, cors);
  }

  // Chain map data for the current window + the caller's link balance
  if (path === '/api/chains' && request.method === 'GET') {
    const today = groupDate(env);
    const { win, doc } = await getChainPairs(env, today);
    const st = (await env.KOVA.get(`chain:state:${win.id}`, 'json')) || {};
    const { users, byUser } = await loadGroup(env);
    const userMap = new Map(users.filter((u) => !u.inactive).map((u) => [u.userId, u]));
    const groups = doc.groups.map((g, gi) => ({
      members: g.map((uid) => {
        const u = userMap.get(uid);
        return u
          ? { userId: uid, displayName: u.displayName, avatar: u.avatar }
          : { userId: uid, displayName: 'departed', avatar: null };
      }),
      rescue: g.some((uid) => doc.cold.includes(uid)),
      perfect: !!(st.perfect && st.perfect[gi]),
      days: win.days.map((d) => {
        let state;
        if (st[d] && st[d][gi]) state = 'forged';
        else if (d > today) state = 'upcoming';
        else if (d < today) state = 'broken';
        else state = g.some((uid) => { const r = (byUser.get(uid) || {})[d]; return r && r.done; }) ? 'waiting' : 'open';
        return { date: d, state };
      }),
    }));
    const linksDoc = await env.KOVA.get(`links:${user.uid}`, 'json');
    return json({
      windowId: win.id, start: win.start, last: win.last,
      groups, myLinks: (linksDoc && linksDoc.total) || 0,
    }, 200, cors);
  }

  // The Vault
  if (path === '/api/vault' && request.method === 'GET') {
    const [vault, linksDoc] = await Promise.all([getVault(env, user.uid), env.KOVA.get(`links:${user.uid}`, 'json')]);
    return json({
      links: (linksDoc && linksDoc.total) || 0,
      // the last movements of the ledger, newest first: the wallet shows
      // where links came from and where they went
      log: ((linksDoc && linksDoc.log) || []).slice(-8).reverse(),
      prices: VAULT_PRICES,
      shield: !!vault.shield,
      voucher: !!vault.voucher,
      voucherUsedMonth: vault.voucherUsedMonth || null,
      frameUntil: vault.frameUntil || 0,
      scoreBonus: (vault.scoreBonus && vault.scoreBonus[groupDate(env).slice(0, 7)]) || 0,
    }, 200, cors);
  }

  if (path === '/api/vault' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const item = body && body.item;
    if (!['frame', 'voucher', 'shield', 'score'].includes(item)) return json({ error: 'Unknown item' }, 400, cors);
    const vault = await getVault(env, user.uid);
    if (item === 'shield' && vault.shield) return json({ error: 'You already hold a Streak Shield' }, 400, cors);
    if (item === 'voucher' && vault.voucher) return json({ error: 'You already hold a rest voucher' }, 400, cors);
    const linksDoc = (await env.KOVA.get(`links:${user.uid}`, 'json')) || { total: 0, log: [] };
    const price = VAULT_PRICES[item];
    if (linksDoc.total < price) return json({ error: `Not enough links: ${linksDoc.total}/${price}` }, 400, cors);
    await addLinks(env, user.uid, -price, `vault ${item}`);
    if (item === 'frame') {
      const base = Math.max(Date.now(), vault.frameUntil || 0);
      vault.frameUntil = base + FRAME_DAYS * 86400000;
    }
    if (item === 'voucher') vault.voucher = true;
    if (item === 'shield') vault.shield = true;
    if (item === 'score') {
      // +1 to this month's Done count on the leaderboard; stacks, priced so
      // only real grinders reach it (per Pasha, 2026-09-07)
      const m = groupDate(env).slice(0, 7);
      vault.scoreBonus = vault.scoreBonus || {};
      vault.scoreBonus[m] = (vault.scoreBonus[m] || 0) + 1;
    }
    await putVault(env, user.uid, vault);
    return json({ ok: true, links: linksDoc.total - price, item }, 200, cors);
  }

  // manual shield sweep (the 03:30 cron does this on its own)
  if (path === '/api/admin/shield-sweep' && request.method === 'POST') {
    if (!user.admin) return json({ error: 'Admin only' }, 403, cors);
    const used = await shieldSweep(env);
    return json({ ok: true, absorbed: used }, 200, cors);
  }

  // manual trial resolution (the Sunday digest does this on its own)
  if (path === '/api/admin/resolve-trial' && request.method === 'POST') {
    if (!user.admin) return json({ error: 'Admin only' }, 403, cors);
    const lines = await resolveTrial(env, groupDate(env));
    return json({ ok: true, lines }, 200, cors);
  }

  // Roster Protocol: who is out, who is on final notice, and the way back
  if (path === '/api/admin/roster' && request.method === 'GET') {
    if (!user.admin) return json({ error: 'Admin only' }, 403, cors);
    const today = groupDate(env);
    const { users, byUser } = await loadGroup(env);
    const removed = [];
    for (const u of users.filter((x) => x.inactive)) {
      const profile = (await env.KOVA.get(`user:${u.userId}`, 'json')) || {};
      let lastDone = null;
      for (const [d, r] of Object.entries(byUser.get(u.userId) || {})) if (r.done && (!lastDone || d > lastDone)) lastDone = d;
      removed.push({ userId: u.userId, displayName: u.displayName, avatar: u.avatar, inactiveSince: profile.inactiveSince || null, lastDone });
    }
    const standings = await buildStandings(env, today.slice(0, 7));
    const onNotice = [];
    for (const p of standings.players) {
      if (p.silentDays == null || p.silentDays < ROSTER.noticeIdle) continue;
      const served = await env.KOVA.get(`roster:notice:${p.userId}`);
      onNotice.push({ userId: p.userId, displayName: p.displayName, avatar: p.avatar, silentDays: p.silentDays, servedOn: served || null });
    }
    return json({ removed, onNotice, rules: ROSTER }, 200, cors);
  }

  if (path === '/api/admin/reinstate' && request.method === 'POST') {
    if (!user.admin) return json({ error: 'Admin only' }, 403, cors);
    const body = await request.json().catch(() => null);
    const uid = body ? String(body.userId || '') : '';
    if (!/^\d{1,25}$/.test(uid)) return json({ error: 'userId is required' }, 400, cors);
    const key = `user:${uid}`;
    const profile = await env.KOVA.get(key, 'json');
    if (!profile) return json({ error: 'No such player' }, 404, cors);
    const today = groupDate(env);
    delete profile.inactiveSince;
    profile.reinstatedOn = today; // a fresh two weeks, the clock starts here
    await env.KOVA.put(key, JSON.stringify(profile), { metadata: profileMeta(profile) });
    await env.KOVA.delete(`roster:notice:${uid}`);
    // the record of the last stay, for the announce
    const member = { userId: uid, displayName: profile.displayName || 'unknown', avatar: profile.avatar || null };
    if (ctx) ctx.waitUntil((async () => {
      const { byUser } = await loadGroup(env);
      let totalDone = 0;
      let lastDone = null;
      for (const [d, r] of Object.entries(byUser.get(uid) || {})) if (r.done) { totalDone++; if (!lastDone || d > lastDone) lastDone = d; }
      await appendRosterEvents(env, today, { reinstated: [{ userId: uid, name: member.displayName }] });
      await announceReinstated(env, member, { totalDone, lastDone });
    })());
    return json({ ok: true, userId: uid, reinstatedOn: today }, 200, cors);
  }

  // manual roster sweep (the 03:30 cron does this on its own)
  if (path === '/api/admin/roster-sweep' && request.method === 'POST') {
    if (!user.admin) return json({ error: 'Admin only' }, 403, cors);
    return json({ ok: true, ...(await rosterSweep(env)) }, 200, cors);
  }

  // three-line coach: client-side rules found the diagnosis codes, the AI here
  // only phrases them. Cached by state hash: while the diagnosis has not changed,
  // repeated requests do not spend a single token.
  if (path === '/api/coach' && request.method === 'POST') {
    if (!(await coachAllowed(env, user))) return json({ error: 'Coach is not enabled for you yet' }, 403, cors);
    const body = await request.json().catch(() => null);
    if (!body || typeof body.stateHash !== 'string' || !Array.isArray(body.niches) || !body.niches.length) {
      return json({ error: 'stateHash and niches are required' }, 400, cors);
    }
    // days before joining the group never reach the model (per Pasha,
    // 2026-09-01): a year of pre-join history must not burn tokens
    if (body.date && isDate(body.date)) {
      const profile = await env.KOVA.get(`user:${user.uid}`, 'json');
      if (profile && profile.joinedDate && body.date < profile.joinedDate) {
        return json({ error: 'Coach covers only days after you joined the group' }, 403, cors);
      }
    }
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'Coach is not configured yet (ANTHROPIC_API_KEY)' }, 503, cors);
    // version in the key: a new prompt generation buries the old cached verdicts
    const cacheKey = `coach:v7:${user.uid}:${body.stateHash.slice(0, 64)}`;
    const cached = await env.KOVA.get(cacheKey, 'json');
    if (cached) return json({ lines: cached.lines, cached: true }, 200, cors);

    const lines = await generateCoachLines(env, body);
    if (!lines) return json({ error: 'Coach model returned nothing useful' }, 502, cors);
    await env.KOVA.put(cacheKey, JSON.stringify({ lines, at: Date.now() }), { expirationTtl: 60 * 60 * 24 * 14 });
    return json({ lines, cached: false }, 200, cors);
  }

  // manual digest send from the admin panel: the same text the cron will send
  if (path === '/api/digest' && request.method === 'POST') {
    if (!user.admin) return json({ error: 'Admin only' }, 403, cors);
    if (!env.DISCORD_WEBHOOK_URL) return json({ error: 'Webhook is not configured yet (DISCORD_WEBHOOK_URL)' }, 400, cors);
    await postDigest(env);
    return json({ ok: true }, 200, cors);
  }

  return json({ error: 'Not found' }, 404, cors);
}

// Profile refresh via the bot token: the OAuth login takes a one-off avatar snapshot,
// while the bot can ask Discord at any time. The cron calls this daily.
async function refreshProfiles(env) {
  if (!env.DISCORD_BOT_TOKEN) return;
  try {
    const list = await listAll(env, 'user:');
    for (const k of list) {
      const uid = k.name.slice('user:'.length);
      const res = await fetch(`https://discord.com/api/v10/users/${uid}`, {
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'User-Agent': BOT_UA },
      });
      if (!res.ok) continue;
      const u = await res.json();
      const prev = (await env.KOVA.get(k.name, 'json')) || {};
      const displayName = u.global_name || u.username || prev.displayName;
      const avatar = u.avatar ? `https://cdn.discordapp.com/avatars/${uid}/${u.avatar}.png?size=64` : null;
      if (displayName === prev.displayName && avatar === prev.avatar) continue;
      const profile = { ...prev, displayName, avatar };
      await env.KOVA.put(k.name, JSON.stringify(profile), { metadata: profileMeta(profile) });
    }
  } catch (e) {
    console.log('profile refresh failed', e.message);
  }
}

// ---------- daily digest to Discord ----------

// ---------- coach ----------

// Rollout flag: KV flag:coach = {"all":true} or {"users":["discordId",...]}.
// Changed by editing KV, no redeploy needed.
async function coachAllowed(env, user) {
  const flag = await env.KOVA.get('flag:coach', 'json');
  if (!flag) return false;
  if (flag.all) return true;
  return Array.isArray(flag.users) && flag.users.includes(user.uid);
}

// Shared knowledge base, distilled from coach 4BK's materials and the
// Voltaic/Aimer7 doctrine, WITHOUT personal context. The client-side rules do the finding,
// the model only phrases the advice in human language.
// The coach's only source of knowledge: knowledge/coach-kb.md, embedded here
// verbatim (the KNOWLEDGE BASE section). When you change the base, change the file and this constant.
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
      // generous limit: with thinking models the reasoning eats the budget before the text,
      // 300 tokens used to cut the reply off mid-sentence (a pitfall known from AimSama)
      max_tokens: 6000,
      // the ~4.3k-token prompt is identical in every call and dominates the bill:
      // prompt caching makes repeat reads ~10x cheaper (2026-09-05, cost review:
      // 900 calls in 11 days, nearly all of the $7.82 was this prompt re-sent raw)
      system: [{ type: 'text', text: COACH_PROMPT, cache_control: { type: 'ephemeral' } }],
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

// The manhwa "System" voice: cold lines in square brackets inside
// a gray Discord code block. The formulaic, repetitive style is part of the aesthetic.
function systemBlock(lines) {
  return '```\n' + lines.join('\n') + '\n```';
}

// Individual completion announces were removed with the Chain Protocol
// (2026-09-07, Rauder's call): the chain messages and the digest carry the
// channel now. chainCheck() is what runs on every first completion.

// Digest stings, Pasha's pick: under 3 days of silence a rotation of the two medium ones,
// from 3 days on the meanest one. Days of silence are counted WITHOUT scheduled rest days.
const STING_HARSH = 'The System issues no penalty. Your aim is the penalty.';
const STING_MILD = [
  'The others are training. The gap grows either way.',
  'Every skipped day is handed to the others.',
];

// Daily report in the System's voice. Three tone levels: recognition for those who completed,
// a rotating jab for the incomplete (under 3 days of silence), harsh and by name
// for those silent 3+ days. Rest days are transparent: today's rester goes into
// "On scheduled leave", and past rest days do not count as days of silence.
// The role ping lives OUTSIDE the code block (Discord does not resolve it inside), the role id
// is in KV config:aimChadRoleId, without it the digest simply goes out without a ping.
async function postDigest(env) {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const today = groupDate(env);
  const standings = await buildStandings(env, today.slice(0, 7));
  // Only those who have closed at least one day in all of history exist in
  // the digest (per Pasha's decision, 2026-08-29): partial players without a single
  // closed day get no lines and no place in the denominator. They will appear
  // in the evening report on their own as soon as they close a day for the first time.
  const players = standings.players.filter((p) => p.lastDone !== null);
  if (!players.length) return;

  // this morning's roster sweep: its lines come later, but whoever got the
  // final notice today is named there and not shamed a second time below
  let rosterEv = null;
  try { rosterEv = await env.KOVA.get(`roster:events:${today}`, 'json'); } catch { /* optional */ }
  const noticedIds = new Set(((rosterEv && rosterEv.noticed) || []).map((x) => x.userId));

  const done = players.filter((p) => p.doneToday);
  const resting = players.filter((p) => !p.doneToday && p.restToday);
  const missing = players.filter((p) => !p.doneToday && !p.restToday);
  const silent = missing.filter((p) => p.idleDays >= 3 && !noticedIds.has(p.userId));
  const incomplete = missing.filter((p) => p.idleDays < 3);

  // Distinction of the day: the most NEW personal bests today
  // (pb records with the i flag, history baselines do not count)
  let distinction = null;
  try {
    const pbDocs = await Promise.all(players.map((p) => env.KOVA.get(`pb:${p.userId}`, 'json')));
    let best = 0;
    let who = [];
    players.forEach((p, i) => {
      let n = 0;
      for (const rec of Object.values(pbDocs[i] || {})) {
        if (rec && rec.i && rec.at && groupDate(env, rec.at) === today) n++;
      }
      if (n > best) { best = n; who = [p.displayName]; }
      else if (n > 0 && n === best) who.push(p.displayName);
    });
    if (best > 0) {
      const pbWord = best === 1 ? 'a new personal best' : `${best} new personal bests`;
      distinction = who.length === 1
        ? `[Distinction: ${who[0]} set ${pbWord} today. The System took note.]`
        : who.length === 2
          ? `[Distinction: ${who.join(' and ')} set ${pbWord} each today. The System took note.]`
          : `[Distinction: ${who.length} players set ${pbWord} each today. The System took note.]`;
    }
  } catch { /* the line is optional */ }

  const names = (list) => list.map((p) => p.displayName).join(', ');
  const lines = [`[Daily report: ${shortDate(today)}.]`];

  if (done.length === players.length) {
    lines.push(`[All ${players.length} players have cleared the daily quest.]`);
    if (distinction) lines.push(distinction);
    lines.push('[Full clear. The System has nothing to add.]');
  } else {
    lines.push(done.length
      ? `[Cleared: ${names(done)}. The System acknowledges.]`
      : '[Cleared: none. The System has no one to acknowledge.]');
    if (distinction) lines.push(distinction);
    if (resting.length) lines.push(`[On scheduled leave: ${names(resting)}.]`);
    // Chain Protocol lines: forged count and shield absorbs
    try {
      const { win, doc: pairsDoc } = await getChainPairs(env, today);
      if (pairsDoc.groups.length) {
        const st = (await env.KOVA.get(`chain:state:${win.id}`, 'json')) || {};
        const forged = pairsDoc.groups.filter((g, gi) => st[today] && st[today][gi]).length;
        lines.push(`[Chains forged today: ${forged}/${pairsDoc.groups.length}.]`);
      }
      const shieldUsers = (await env.KOVA.get(`shieldused:${today}`, 'json')) || [];
      for (const uid of shieldUsers) {
        const p = players.find((x) => x.userId === uid);
        if (p) lines.push(`[${p.displayName}'s Streak Shield absorbed the miss. The chain of days holds.]`);
      }
    } catch { /* chains never break the digest */ }
    // Roster Protocol: what this morning's sweep did, said out loud
    if (rosterEv && rosterEv.noticed && rosterEv.noticed.length) {
      lines.push(`[Final notice served to ${rosterEv.noticed.map((x) => x.name).join(', ')}. One day remains.]`);
    }
    if (rosterEv && rosterEv.removed && rosterEv.removed.length) {
      lines.push(`[Removed from the roster: ${rosterEv.removed.map((x) => x.name).join(', ')}. Two weeks of silence. The System does not chase.]`);
    }
    if (rosterEv && rosterEv.reinstated && rosterEv.reinstated.length) {
      lines.push(`[Reinstated today: ${rosterEv.reinstated.map((x) => x.name).join(', ')}. The clock restarts.]`);
    }
    if (incomplete.length) {
      const sting = STING_MILD[Number(today.slice(-2)) % STING_MILD.length];
      lines.push(`[Incomplete: ${names(incomplete)}. The day is not over. ${sting}]`);
    }
    // one line for ALL the silent, not a line per player (per Pasha,
    // 2026-09-04): a single name keeps the "since" form, several collapse
    // into "Name (date)" pairs so the sting is not spammed
    if (silent.length === 1) {
      lines.push(`[No training detected from ${silent[0].displayName} since ${shortDate(silent[0].lastDone)}. ${STING_HARSH}]`);
    } else if (silent.length > 1) {
      const shown = silent.slice(0, 8);
      let listed = shown.map((p) => `${p.displayName} (${shortDate(p.lastDone)})`).join(', ');
      if (silent.length > shown.length) listed += ` and ${silent.length - shown.length} more`;
      lines.push(`[No training detected from ${listed}. ${STING_HARSH}]`);
    }
    lines.push(`[${done.length}/${players.length} cleared. Gate closes at midnight.]`);
  }

  // Sunday: the weekly trial resolves inside the digest
  try {
    const dowMon = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;
    if (dowMon === 6) lines.push(...await resolveTrial(env, today));
  } catch { /* the trial never breaks the digest */ }

  const roleId = await env.KOVA.get('config:aimChadRoleId');
  const content = (roleId ? `<@&${roleId}>\n` : '') + systemBlock(lines).slice(0, 1900);
  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      allowed_mentions: roleId ? { roles: [roleId] } : { parse: [] },
    }),
  });
}

const fmtScore = (s) => (s >= 100 ? Math.round(s) : Math.round(s * 10) / 10);

// Rivalry system: ping those whose records have fallen. Ping conditions:
// a crossing (the victim was not below the attacker's old best, otherwise they
// were already behind and it is not an event) and a close overtake (the new score is above
// the victim's best by no more than 5%: a rematch is realistic, this is a duel, not a
// wall of shame). One message per player+scenario pair per day.
async function announceRecords(env, user, improvements) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  try {
    const today = groupDate(env);
    const { users } = await loadGroup(env);
    const meName = (users.find((u) => u.userId === user.uid) || {}).displayName || user.name;
    const others = users.filter((u) => u.userId !== user.uid);
    const docs = await Promise.all(others.map((u) => env.KOVA.get(`pb:${u.userId}`, 'json')));

    for (const imp of improvements.slice(0, 5)) {
      const victims = [];
      for (let i = 0; i < others.length; i++) {
        const rec = docs[i] && docs[i][imp.name];
        if (!rec || !(rec.s > 0)) continue;
        const crossed = rec.s < imp.newS && rec.s >= imp.oldS;
        const close = (imp.newS - rec.s) / rec.s <= 0.05;
        if (crossed && close) victims.push({ ...others[i], best: rec.s });
      }
      if (!victims.length) continue;

      const dedupeKey = `pbping:${user.uid}:${imp.name}:${today}`;
      if (!firstInWindow(dedupeKey, 30000)) continue;
      if (await env.KOVA.get(dedupeKey)) continue;
      await env.KOVA.put(dedupeKey, '1', { expirationTtl: 172800 });

      victims.sort((a, b) => b.best - a.best);
      const top = victims.slice(0, 10);
      const listed = top.map((v) => `${v.displayName} ${fmtScore(v.best)}`);
      const joined = listed.length === 1
        ? listed[0]
        : listed.slice(0, -1).join(', ') + ' and ' + listed[listed.length - 1];
      const lines = [
        `[Record broken: ${imp.name}.]`,
        `[${meName} ${fmtScore(imp.newS)} has overtaken ${joined}.]`,
        top.length === 1
          ? '[Your record has fallen. Reclaim what is yours.]'
          : '[Your records have fallen. Reclaim what is yours.]',
      ];
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: top.map((v) => `<@${v.userId}>`).join(' ') + '\n' + systemBlock(lines),
          allowed_mentions: { users: top.map((v) => v.userId) },
        }),
      });
    }
  } catch { /* the ping is not critical */ }
}

// ---------- entry point ----------

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
    // 09:30 UTC = 03:30 Denver in summer: the Streak Shield sweep, after the
    // 3h night grace window has fully closed
    if (event.cron === '30 9 * * *') {
      ctx.waitUntil((async () => {
        await shieldSweep(env);
        // the roster sweep runs after the shield sweep so a shield-covered
        // day is already a rest day and does not count as silence
        await rosterSweep(env);
      })());
      return;
    }
    ctx.waitUntil((async () => {
      // once a day we pull fresh avatars/names (a change made in Discord
      // arrives without a re-login)
      await refreshProfiles(env);
      // the auto-digest can be muted with a flag, no redeploy:
      // flag:digest = {"enabled":false}. The manual button in the admin panel always works.
      const flag = await env.KOVA.get('flag:digest', 'json');
      if (flag && flag.enabled === false) return;
      await postDigest(env);
    })());
  },
};
