// KOVA STREAK: state, stats folder polling, auto check-in, rendering.

import { initAuth, currentUser, login, logout, authError } from './auth.js';
import * as api from './api.js';
import { localDate, localMonth } from './parser.js';
import {
  fsSupported, pickStatsFolder, getStoredFolder, forgetFolder,
  ensurePermission, matchPlaylist, indexRunContents,
  countRunsAroundMidnight, applyGraceWindow,
} from './fs.js';
import { getAllParsedRuns, kvGet, kvSet } from './db.js';
import { startCelebration as runCeremony } from './celebrate.js';
import { openDescent } from './gate.js';
import { mountGateHall } from './gatehall.js';
import { buildDailyReport, coachPayload, buildTrackingLine } from './stats.js';
import { annotateTerms, initGlossary } from './glossary.js';

// Preview of the setup guide for a logged-in admin: ?setup=test
const SETUP_PREVIEW = new URLSearchParams(location.search).get('setup') === 'test';

// One-liner that installs/repairs the mirror; the same one appears in the guide and in the help line
const MIRROR_CMD = 'irm https://rauder999.github.io/kova-streak/mirror-setup.txt | iex';

const POLL_MS = 5000;          // how often we re-read the folder listing
const POST_DEBOUNCE_MS = 60000; // partial progress is posted at most once a minute
const GROUP_REFRESH_MS = 60000;

// state and renderToday are exported so the frontend can be exercised from
// the console with fake progress, without connecting the stats folder.
export const state = {
  user: null,
  playlist: null,
  prevPlaylist: null,     // the playlist that was active before the current one
  handle: null,
  granted: false,
  date: localDate(),
  progress: null,
  lastPostedRuns: -1,
  lastPostAt: 0,
  posting: false,
  prevProgress: null,     // yesterday's progress (grace window applied)
  lastPostedPrevRuns: -1,
  lastPrevPostAt: 0,
  postingPrev: false,
  graceUsed: 0,           // how many night runs were credited to yesterday
  streak: null,
  group: null,
  groupMonth: null,       // YYYY-MM when browsing history, null = current month
  joinedDate: null,       // stats and coach are fenced to days from this date on
  tab: 'today',
  scanError: null,
  coachEnabled: false,
  indexProgress: null,   // {done,total} while the initial indexing is in progress
  report: null,          // buildDailyReport for statsDate
  statsDate: null,       // which day the tab is viewing (null = today)
  playedDates: [],       // dates that have runs, newest first
  coachLines: null,
  coachHash: null,
  coachError: null,
  restDates: [],        // scheduled rest days (dates)
  restFree: [],         // of those, the ones that cost no quota (admin-granted, shield-absorbed)
  restReturnedFor: null, // the date whose rest permit came back because the day closed anyway
  restError: null,
  chains: null,         // current chain window (map data + my links)
  vault: null,          // Vault state for the Today tab card
  gate: null,           // The Gate: ladder, pot, daily allowance, the open run
  vaultMsg: null,
  trial: null,          // the trial of the half-week (scenario, standings, my baseline)
};

let pollTimer = null;
let groupTimer = null;
let fsObserver = null;
let lastTickAt = 0;
let celebrationPending = null; // { date, night }: a 100% that happened while the tab was hidden

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------- boot ----------

async function boot() {
  initGlossary();
  $('login-btn').addEventListener('click', login);
  // the gate's reject: the System does not recommend it
  $('reject-btn').addEventListener('click', () => {
    const note = $('reject-note');
    note.textContent = '[ THE SYSTEM HAS NOTED YOUR HESITATION. ]';
    setTimeout(() => { note.textContent = 'THE SYSTEM DOES NOT RECOMMEND IT'; }, 2200);
  });
  $('logout-btn').addEventListener('click', () => { logout(); location.reload(); });
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  // back in the window after playing: rescan immediately, do not wait for the
  // timer; and if 100% happened while the tab was hidden behind the game,
  // greet the person with the celebration right now
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (pollTimer) tick();
    if (celebrationPending) { const p = celebrationPending; celebrationPending = null; startCelebration(false, p); }
  });
  window.addEventListener('focus', () => { if (pollTimer) tick(); });

  const err = authError();
  if (err) {
    const box = $('login-error');
    box.textContent = err === 'not_in_guild'
      ? 'That Discord account is not in the group server.'
      : 'Sign-in failed: ' + err;
    box.hidden = false;
  }

  // celebration preview: ?celebrate=test, works even without login,
  // does not consume today's real celebration
  if (new URLSearchParams(location.search).get('celebrate') === 'test') {
    startCelebration(true);
  }

  state.user = initAuth();
  if (!state.user) {
    $('online-chip').hidden = false;
    return showView('login');
  }

  $('user-name').textContent = state.user.name;
  safeAvatar($('user-avatar'), state.user.uid);
  $('user-avatar').src = state.user.avatar || avatarFallback(state.user.uid);
  $('user-chip').hidden = false;
  $('tabs').hidden = false;
  if (state.user.admin) $('admin-tab-btn').hidden = false;

  try {
    state.playlist = await api.getPlaylist();
    // the playlist that was active before the current one: yesterday-healing
    // judges yesterday by it when the swap happened after yesterday ended.
    // Awaited BEFORE polling starts so the first tick never grades yesterday
    // against the wrong week.
    state.prevPlaylist = await api.getPrevPlaylist().catch(() => null);
  } catch (e) {
    state.scanError = 'Backend unreachable: ' + e.message;
  }
  renderWeekLabel();

  // coach flag: the rollout is controlled from KV, the frontend just asks
  try {
    const me = await api.getMe();
    state.coachEnabled = !!(me && me.coachEnabled);
    // analytics are fenced to the days after joining the group: an old
    // KovaaK's history must not be browsable and must not burn coach tokens
    state.joinedDate = (me && me.joinedDate) || null;
    $('stats-tab-btn').hidden = !state.coachEnabled;
  } catch { /* without the flag we behave as before */ }

  state.handle = await getStoredFolder();
  if (state.handle) state.granted = await ensurePermission(state.handle);

  // check-in is impossible from a phone, but the group calendar works,
  // so mobile users are greeted with it right away
  switchTab(fsSupported() ? 'today' : 'group');
  refreshGroup();
  loadRest().then(() => { if (state.tab === 'today') renderToday(); });
  loadVault(); // the rest calendar reads the shield and the voucher from it
  loadTrial();
  // A descent left open outranks whatever tab you would have landed on: the
  // key is already spent and links are sitting down there waiting to be
  // walked out. Reloading used to drop you on Today as if nothing were open.
  const landed = state.tab;
  loadGate(false).then(() => {
    if (state.tab === landed && state.gate && state.gate.run) switchTab('gate');
  });
  if (state.granted) startPolling();
}

function avatarFallback(uid) {
  const i = (BigInt(uid || '0') >> 22n) % 6n;
  return `https://cdn.discordapp.com/embed/avatars/${i}.png`;
}

// The avatar hash goes stale when the person changes it after login: the CDN
// returns 404 and the image breaks. On error, quietly fall back to the default.
function safeAvatar(img, uid) {
  img.addEventListener('error', () => {
    const fb = avatarFallback(uid);
    if (img.src !== fb) img.src = fb;
  }, { once: true });
  return img;
}

// ---------- tabs ----------

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  showView(tab);
  // a hidden view still gets frames, so the hall is shut down on the way out
  if (tab !== 'gate' && gateHall) { gateHall.stop(); gateHall = null; }
  if (tab === 'today') renderToday();
  if (tab === 'stats') renderStats();
  if (tab === 'group') { renderGroup(); refreshGroup(); }
  if (tab === 'vault') { renderVault(); loadVault(); }
  if (tab === 'gate') { renderGate(); loadGate(); }
  if (tab === 'admin') renderAdmin();
}

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
}

function renderWeekLabel() {
  $('week-label').textContent = state.playlist && state.playlist.weekLabel ? state.playlist.weekLabel : '';
}

// ---------- folder polling ----------

function startPolling() {
  if (pollTimer) return;
  $('scan-state').hidden = false;
  tick();
  // Polling is the fallback mechanism: backgrounded Chrome throttles timers
  // to once a minute, so the real speed comes from the observer and focus/visibility below.
  pollTimer = setInterval(tick, POLL_MS);
  startObserver();
}

// Native folder observer: reacts to a new CSV instantly, even while the tab
// is hidden behind the game. Not available in every browser, so it is only
// an accelerator on top of the polling.
async function startObserver() {
  if (fsObserver || !('FileSystemObserver' in window)) return;
  try {
    fsObserver = new FileSystemObserver(() => tick());
    await fsObserver.observe(state.handle);
  } catch {
    fsObserver = null; // failed to start, polling remains
  }
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (fsObserver) {
    fsObserver.disconnect();
    fsObserver = null;
  }
  $('scan-state').hidden = true;
}

async function tick() {
  if (!state.handle || !state.playlist) return;
  // the observer, focus and the interval can fire in a burst; scanning more
  // often than once a second makes no sense
  if (Date.now() - lastTickAt < 1000) return;
  lastTickAt = Date.now();

  // midnight rollover: a new day, counters from zero
  const today = localDate();
  if (today !== state.date) {
    state.date = today;
    state.lastPostedRuns = -1;
    state.lastPostAt = 0;
    state.lastPostedPrevRuns = -1;
    state.lastPrevPostAt = 0;
  }

  try {
    if (!(await ensurePermission(state.handle))) {
      state.granted = false;
      state.scanError = 'Folder access expired, click to grant it again.';
      stopPolling();
      if (state.tab === 'today') renderToday();
      return;
    }

    const prevDate = prevDateOf(state.date);
    const { prev, grace, cur, scanned } = await countRunsAroundMidnight(state.handle, state.date, prevDate);
    // night runs close yesterday even from zero, unless yesterday was a scheduled rest day
    const split = applyGraceWindow(state.playlist.scenarios, prev, grace, cur, prevScenariosFor(prevDate),
      { prevRest: state.restDates.includes(prevDate) });
    state.progress = split.todayProgress;
    state.progress.scanned = scanned;
    state.graceUsed = split.graceUsed;
    // yesterday's progress is posted only if anything was played at all (before midnight
    // or in the grace window): covers the grace top-up, a night session that started
    // after midnight, and fixing "played yesterday but the tab was closed"
    state.prevProgress = split.prevProgress.completedRuns > 0 ? split.prevProgress : null;
    state.scanError = null;
    // The ceremony (per Rauder, 2026-09-15: a finished playlist is a finished
    // playlist, whether the site was open at the time or not). Today closed,
    // or a yesterday found closed in the files and never celebrated on this
    // device: the night runs that healed it, or an evening session played
    // with the tab shut. The key holds the last date celebrated, so nothing
    // is played twice.
    if (state.progress.done) maybeCelebrate(state.date, false);
    else if (state.prevProgress && state.prevProgress.done) maybeCelebrate(prevDate, split.graceUsed > 0);
    let scanLine = state.progress.done
      ? 'today is done'
      : `${state.progress.completedRuns} / ${state.progress.requiredRuns} runs`;
    if (split.graceUsed > 0) {
      scanLine += ` (+${split.graceUsed} night ${split.graceUsed === 1 ? 'run' : 'runs'} counted toward yesterday)`;
    }
    $('scan-text').textContent = scanLine;
  } catch (e) {
    state.scanError = 'Scan failed: ' + e.message;
  }

  if (state.tab === 'today') renderToday();
  maybePost();
  maybePostPrev();
  // indexing is needed even without the coach: the personal records system depends on it
  refreshStatsPipeline();
}

// Yesterday's date in the same local format as state.date
function prevDateOf(date) {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return localDate(d);
}

// The playlist that was active on prevDate: if the current one replaced it
// AFTER that day, yesterday is judged by the archived version, so the weekly
// swap does not burn an unhealed yesterday.
function prevScenariosFor(prevDate) {
  const p = state.prevPlaylist;
  if (p && p.replacedOn && p.replacedOn > prevDate && Array.isArray(p.scenarios) && p.scenarios.length) {
    return p.scenarios;
  }
  return state.playlist.scenarios;
}

// ---------- personal stats and coach ----------

let statsBusy = false;
async function refreshStatsPipeline() {
  if (statsBusy || !state.handle) return;
  statsBusy = true;
  try {
    const res = await indexRunContents(state.handle, (p) => {
      state.indexProgress = p;
      if (state.tab === 'stats') renderStats();
    });
    state.indexProgress = null;
    await maybePostScores(res.added);
    await maybeReportTrialBaseline();
    // rebuild the report when new files have appeared or there is none yet
    if (state.coachEnabled && (res.added > 0 || !state.report)) {
      await rebuildReport(state.statsDate || state.date);
    }
  } catch (e) {
    state.coachError = e.message;
  } finally {
    statsBusy = false;
  }
}

// Rivalry system: personal bests for the current playlist's scenarios go to
// the server, which decides whose records fell and who gets pinged.
// The last submission is cached in localStorage: no changes means no request,
// and the heavy pass over all runs happens only when there are new files.
const PB_CACHE_KEY = 'kova-streak-pb-posted';
async function maybePostScores(added) {
  if (!state.user || !state.playlist) return;
  let cached = null;
  try { cached = localStorage.getItem(PB_CACHE_KEY); } catch { /* private browsing mode */ }
  if (!added && cached !== null) return;

  const wanted = new Set(state.playlist.scenarios.map((s) => s.name));
  // the trial scenario syncs too, even when it is not on the playlist
  for (const t of [state.trial && state.trial.current, state.trial && state.trial.next]) if (t && t.scenario) wanted.add(t.scenario);
  const runs = await getAllParsedRuns();
  const bests = {};
  for (const r of runs) {
    if (!wanted.has(r.scenario) || !(r.score > 0)) continue;
    if (!bests[r.scenario] || r.score > bests[r.scenario]) bests[r.scenario] = r.score;
  }
  if (!Object.keys(bests).length) return;

  const ser = JSON.stringify(Object.entries(bests).sort((a, b) => a[0].localeCompare(b[0])));
  if (ser === cached) return;
  try {
    await withPostLock(async () => {
      // re-read inside the lock: the other tab may have just posted this exact set
      let fresh = null;
      try { fresh = localStorage.getItem(PB_CACHE_KEY); } catch { /* private browsing mode */ }
      if (fresh === ser) return;
      await api.postScores(bests);
      localStorage.setItem(PB_CACHE_KEY, ser);
    });
  } catch { /* not critical: we retry with the next new run */ }
}

// Builds the report for the selected date (today or any past day).
// Days before joining the group are not browsable (per Pasha, 2026-09-01):
// pre-join history still feeds the baselines silently, but gets no day chip,
// no report and no coach call.
async function rebuildReport(day) {
  const runs = await getAllParsedRuns();
  if (state.joinedDate && day < state.joinedDate) day = state.date;
  state.playedDates = [...new Set(runs.map((r) => r.date))]
    .filter((d) => !state.joinedDate || d >= state.joinedDate)
    .sort().reverse().slice(0, 21);
  state.report = buildDailyReport(runs, day);
  if (state.tab === 'stats') renderStats();
  await maybeCoach();
}

// The AI is called only when the state hash changes, otherwise cached text is used.
// The coach remembers what it advised on previous days: the history goes into
// the payload so yesterday's tip is not repeated without a reason.
async function maybeCoach() {
  const r = state.report;
  if (!r || !r.niches.length) return;
  // the fence again, in case a pre-join report slipped through: no tokens
  if (state.joinedDate && r.today < state.joinedDate) return;

  const history = (await kvGet('coachHistory')) || [];
  const recent = history
    .filter((h) => h.date < r.today)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 2);
  // history affects the text, so it must affect the cache key too
  let hh = 5381;
  const hsrc = recent.map((h) => h.lines.join('|')).join('#');
  for (let i = 0; i < hsrc.length; i++) hh = ((hh << 5) + hh + hsrc.charCodeAt(i)) >>> 0;
  const fullHash = r.stateHash + '-a' + hh.toString(36);

  if (fullHash === state.coachHash && state.coachLines) return;
  try {
    const payload = coachPayload(r);
    payload.stateHash = fullHash;
    payload.date = r.today; // the server rejects pre-join dates
    payload.recentAdvice = recent.map((h) => ({ date: h.date, lines: h.lines }));
    // tracking does not go to the model: the client builds its line itself from the doctrine
    const trackingLine = buildTrackingLine(r);
    payload.niches = payload.niches.filter((n) => n.niche !== 'tracking');
    // the last tip for each niche, for the "do not repeat yourself" rule
    const lastLines = recent[0] ? recent[0].lines : [];
    for (const n of payload.niches) {
      const prev = lastLines.find((l) => l.toUpperCase().startsWith('[' + n.niche.toUpperCase() + ']'));
      if (prev) n.lastAdvice = prev;
    }

    let lines = [];
    if (payload.niches.length) {
      const res = await api.postCoach(payload);
      lines = res.lines || [];
    }
    if (trackingLine) lines = [...lines, trackingLine];

    state.coachLines = lines;
    state.coachHash = fullHash;
    state.coachError = null;
    // remember what was advised for this day (the day's latest version wins)
    const next = history.filter((h) => h.date !== r.today);
    next.push({ date: r.today, lines });
    next.sort((a, b) => a.date.localeCompare(b.date));
    await kvSet('coachHistory', next.slice(-14));
  } catch (e) {
    if (handleApiError(e)) return;
    state.coachError = e.message;
  }
  if (state.tab === 'stats') renderStats();
}

// My stats is the System's STATUS window: the hunter's identity plate, the
// three niches as attributes with today's delta against the player's own
// baseline on a bipolar bar, the coach's verdict as System lines tagged by
// niche, and the day's scenarios against their usual.
export function renderStats() {
  const root = $('view-stats');
  root.replaceChildren();

  if (!state.granted) {
    root.append(notice('Connect your stats folder on the Today tab first.'));
    return;
  }
  const r = state.report;
  const indexing = !!state.indexProgress;
  if (!r && !indexing) {
    root.append(notice('Crunching your runs...'));
    return;
  }

  const viewing = state.statsDate || state.date;
  const isPast = !!(state.statsDate && state.statsDate !== state.date);
  const me = state.group && state.group.players.find((p) => p.userId === state.user.uid);
  const rank = state.group ? state.group.players.findIndex((p) => p.userId === state.user.uid) + 1 : 0;

  // ---- the STATUS window ----
  const win = mkWin();
  activeDecor(win);
  const head = el('div', 'win-head');
  head.append(el('span', 'win-label', `[ Status // ${indexing ? 'first visit' : isPast ? monthDayShort(viewing) : 'today'} ]`));
  const chips = el('div', 'chipline');
  chips.append(el('span', 'win-sub', 'RECORD OF'));
  const mk = (label, day, active) => {
    const b = el('button', 'dc' + (active ? ' on' : ''), label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      state.statsDate = day;
      state.coachLines = null;
      state.coachHash = null;
      await rebuildReport(day || state.date);
    });
    return b;
  };
  chips.append(mk('TODAY', null, viewing === state.date));
  for (const d of state.playedDates) {
    if (d === state.date) continue;
    chips.append(mk(monthDayShort(d).toUpperCase(), d, viewing === d));
  }
  head.append(chips);
  win.append(head);

  const grid = el('div', 'status-grid');
  const left = el('div');
  const id = el('div', 'id-row');
  id.append(avatarTile({ avatar: state.user.avatar, userId: state.user.uid }, me && me.frame ? 'gold' : null, 256));
  const idText = el('div');
  idText.style.cssText = 'display:flex;flex-direction:column;gap:8px;min-width:0';
  idText.append(el('span', 'id-nm', state.user.name));
  const bits = ['HUNTER'];
  if (rank > 0) bits.push(`RANK <b>#${rank}</b> THIS MONTH`);
  if (state.streak) bits.push(`STREAK <b>${state.streak.streak}D</b>`);
  if (me) bits.push(`<b>${me.links || 0}</b> LINKS`);
  if (me && me.frame) bits.push('FRAME OF HONOR ACTIVE');
  const sub = el('span', 'id-sub');
  sub.innerHTML = bits.join(' · ');
  idText.append(sub);
  id.append(idText);
  left.append(id);

  const dcol = (pct) => (pct > 2 ? 'up' : pct < -2 ? 'down' : 'flat');
  const dtxt = (pct) => (pct > 0 ? '+' : '') + pct + '%';
  for (const n of ['clicking', 'tracking', 'switching']) {
    const row = el('div', 'attr');
    row.append(el('span', 'k ' + n, n.toUpperCase()));
    const found = r && r.niches.find((x) => x.niche === n);
    const pct = found && found.scoreDelta != null ? Math.round(found.scoreDelta * 100) : null;
    const d = el('span', 'd' + (pct == null ? '' : ' ' + dcol(pct)), pct == null ? '--' : dtxt(pct));
    if (pct == null) d.style.color = 'var(--text-2)';
    row.append(d);
    const bar = el('div', 'bip');
    if (pct != null) {
      const half = Math.min(50, Math.abs(pct) * 5); // plus or minus 10% fills the whole half
      const fill = el('i', Math.abs(pct) <= 1 ? 'flat' : pct > 0 ? 'up' : 'dn');
      if (Math.abs(pct) <= 1) fill.style.cssText = 'left: calc(50% - 2px); width: 4px;';
      else if (pct > 0) fill.style.cssText = `left: 50%; width: ${half}%;`;
      else fill.style.cssText = `right: 50%; width: ${half}%;`;
      bar.append(fill);
    }
    row.append(bar);
    let note = indexing ? 'waiting for the history' : 'not played today';
    if (found) {
      const parts = [];
      if (found.best && found.best.scoreDelta != null && found.best.scoreDelta > 0.02) parts.push(shortScen(found.best.name) + ' up');
      if (found.worst && found.worst.scoreDelta != null && found.worst.scoreDelta < -0.02) parts.push(shortScen(found.worst.name) + ' down');
      if (found.pbs && found.pbs.length) parts.push(found.pbs.length === 1 ? shortScen(found.pbs[0]) + ' is a PB' : found.pbs.length + ' PBs');
      note = parts.join(', ') || (found.scenarios.length + ' played, on your usual');
    }
    row.append(el('span', 'n', note));
    left.append(row);
  }
  grid.append(left);

  const rec = el('div', 'rec-grid');
  const recBlock = (label, value, hint, color) => {
    const b = el('div', 'rec');
    b.append(el('span', 'lbl', label));
    const v = el('span', 'v', value);
    if (color) v.style.color = color;
    b.append(v, el('span', 'h', hint));
    return b;
  };
  if (indexing) {
    const ip = state.indexProgress;
    rec.append(recBlock('History', `${ip.done} / ${ip.total}`, 'runs parsed · first time takes a minute'));
    const pr = el('div', 'rec');
    pr.style.cssText = 'grid-column: span 2; justify-content: center;';
    const bar = el('div', 'prog');
    const fill = el('i');
    fill.style.width = (ip.total ? Math.round((ip.done / ip.total) * 100) : 0) + '%';
    bar.append(fill);
    pr.append(bar, el('span', 'h', '[ Reading your history. Later it is instant. ]'));
    pr.querySelector('.h').style.marginTop = '8px';
    rec.append(pr);
  } else {
    const runs = r.scenarios.reduce((a, s) => a + s.runsToday, 0);
    const secured = state.progress && !isPast ? state.progress.items.filter((i) => i.done).length : null;
    rec.append(recBlock('Runs ' + (isPast ? 'that day' : 'today'), String(runs), `${r.scenarios.length} scenarios${secured != null ? ` · ${secured} secured` : ''}`));
    const pb = r.pbs.length;
    rec.append(recBlock('New bests', String(pb), pb ? shortScen(r.pbs[0]) + (pb > 1 ? ` and ${pb - 1} more` : '') : 'none today, the usual holds', pb ? 'var(--gold)' : null));
    const deltas = r.scenarios.map((s) => s.scoreDelta).filter((x) => x != null).sort((a, b) => a - b);
    const med = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;
    const medPct = med == null ? null : Math.round(med * 100);
    rec.append(recBlock('Day vs usual', medPct == null ? '--' : dtxt(medPct), medPct == null ? 'no baseline yet' : `median of ${deltas.length} deltas · ${Math.abs(medPct) <= 2 ? 'a flat day' : medPct > 0 ? 'a strong day' : 'a soft day'}`, medPct == null ? 'var(--text-2)' : medPct > 2 ? 'var(--ok)' : medPct < -2 ? 'var(--bad)' : 'var(--text-1)'));
  }
  grid.append(rec);
  win.append(grid);
  root.append(win);

  // ---- coach: the diagnostic window, the answer goes first ----
  const coach = mkWin();
  const coachSub = indexing ? 'NO VERDICT YET'
    : isPast ? r.today.toUpperCase()
      : (r.rusty ? `${r.gapDays} DAYS OFF BEFORE THIS` : 'NEXT SESSION') + ' · ONE FOCUS PER NICHE · UNDERLINED TERMS OPEN THE GLOSSARY';
  coach.append(winHead('[ Coach diagnostic ]', coachSub));
  if (state.coachLines && state.coachLines.length) {
    for (const line of state.coachLines) {
      const m = /^\[(CLICKING|TRACKING|SWITCHING)\]\s*(.*)$/.exec(line);
      const niche = m ? m[1] : null;
      let text = m ? m[2] : line;
      const row = el('div', 'cl');
      const tags = el('div', 'tags');
      tags.append(el('span', 'ntag' + (niche ? ' ' + niche.toLowerCase() : ''), niche || 'COACH'));
      // the repeat marker becomes a visible badge instead of buried prose
      if (/^Same focus as yesterday:?\s*/i.test(text)) {
        text = text.replace(/^Same focus as yesterday:?\s*/i, '');
        tags.append(el('span', 'ntag repeat', 'REPEAT'));
      }
      row.append(tags, el('span', 'tx', text));
      coach.append(row);
    }
    annotateTerms(coach); // jargon becomes a clickable glossary
  } else {
    const line = el('div', 'quest-line');
    line.style.cssText = 'padding:20px 0 6px;font-size:13px;letter-spacing:.08em';
    if (state.coachError) line.textContent = `[ COACH UNAVAILABLE: ${state.coachError} ]`;
    else if (indexing || !r.scenarios.length) {
      const b = el('span', 'blink', '[ ANALYZING... ]');
      line.append(b, ' ');
      const t = el('span', null, isPast ? 'no runs on that day' : 'the verdict appears after the first runs of the day');
      t.style.color = 'var(--text-2)';
      line.append(t);
    } else line.append(el('span', 'blink', '[ ANALYZING... ]'));
    coach.append(line);
  }
  root.append(coach);

  // ---- the day's scenarios against their own baseline ----
  const table = mkWin();
  table.append(winHead(`[ ${isPast ? monthDayShort(r ? r.today : viewing) : 'Today'} vs your usual ]`, 'BEST OF THE DAY AGAINST THE MEDIAN OF THE RUNS BEFORE IT · PB = NEW PERSONAL BEST'));
  if (indexing || !r.scenarios.length) {
    const line = el('div', 'quest-line', isPast ? '[ NOTHING WAS PLAYED THAT DAY. ]' : '[ NO RUNS YET TODAY. THE TABLE FILLS AS YOU PLAY. ]');
    line.style.cssText = 'padding:18px 0 6px;color:var(--text-2)';
    table.append(line);
  } else {
    const scroll = el('div', 'st-scroll');
    scroll.style.marginTop = '10px';
    const cols = el('div', 'st-cols');
    ['Scenario', 'Niche', 'Runs', 'Best today', 'Your usual', 'Delta'].forEach((h, i) => cols.append(el('span', i >= 2 ? 'r' : '', h)));
    scroll.append(cols);
    for (const s of r.scenarios) {
      const row = el('div', 'st-row');
      const nm = el('div', 'nm');
      nm.append(el('span', null, s.name));
      if (s.isPB) nm.append(el('span', 'tag gold', 'PB'));
      row.append(nm);
      const nt = el('span', 'ntag' + (s.niche && s.niche !== 'unknown' ? ' ' + s.niche : ''), (s.niche && s.niche !== 'unknown' ? s.niche : 'other').toUpperCase());
      nt.style.justifySelf = 'start';
      row.append(nt);
      row.append(el('span', 'r', String(s.runsToday)));
      row.append(el('span', 'r' + (s.isPB ? ' gold' : ''), s.bestToday != null ? fmtScore(s.bestToday) : '-'));
      row.append(el('span', 'r mute', s.base ? fmtScore(s.base.score) : 'no baseline yet'));
      const d = el('span', 'r dl');
      if (s.scoreDelta != null) {
        const pct = Math.round(s.scoreDelta * 100);
        d.classList.add(dcol(pct));
        d.textContent = `[${dtxt(pct)}]`;
      } else d.textContent = '-';
      row.append(d);
      scroll.append(row);
    }
    table.append(scroll);
  }
  root.append(table);
}

// "VT Pasu Rasp Novice" reads as "Pasu Rasp" in a short note
function shortScen(name) {
  return String(name).replace(/^VT\s+/i, '').replace(/\s+(Novice|Intermediate|Advanced|Easy|Medium|Hard|Ez|Beginner)$/i, '');
}

function fmtScore(v) {
  return v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString();
}

// Two tabs on the same stats folder used to post the same completion in
// the same millisecond (2026-09-10: duplicate CHAIN FORGED cards and record
// pings). Web Locks serialize the posts across every tab of this origin,
// and a shared localStorage note lets the second tab see the first one
// already did the work, so the request is never sent twice.
async function withPostLock(fn) {
  if (navigator.locks && navigator.locks.request) return navigator.locks.request('kova-streak-post', fn);
  return fn();
}
function postedNote(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function rememberPosted(key, date, runs) {
  try { localStorage.setItem(key, JSON.stringify({ date, runs })); } catch { /* private mode */ }
}
const POSTED_KEY = 'kova-streak-posted';
const POSTED_PREV_KEY = 'kova-streak-posted-prev';

// A rest day the server handed back because the day was closed anyway: the
// calendar has to drop the permit at once, and the ceremony says so.
function noteRestReturned(date) {
  state.restReturnedFor = date;
  loadRest().then(() => { if (state.tab === 'today') renderToday(); });
}

// Posting for yesterday: the grace top-up for a night session and the fix for
// "played yesterday but the tab was not open". The server accepts yesterday
// within its date window and never downgrades an already closed day, so the post is safe.
async function maybePostPrev() {
  const p = state.prevProgress;
  if (!p || state.postingPrev) return;
  if (p.completedRuns === state.lastPostedPrevRuns) return;

  const justFinished = p.done && state.lastPostedPrevRuns < p.requiredRuns;
  if (!justFinished && Date.now() - state.lastPrevPostAt < POST_DEBOUNCE_MS) return;

  state.postingPrev = true;
  const date = prevDateOf(state.date);
  try {
    await withPostLock(async () => {
      const note = postedNote(POSTED_PREV_KEY);
      if (note && note.date === date && note.runs === p.completedRuns) {
        state.lastPostedPrevRuns = p.completedRuns; // another tab already sent exactly this
        return;
      }
      const res = await api.postCompletion({
        date,
        completedRuns: p.completedRuns,
        requiredRuns: p.requiredRuns,
        done: p.done,
      });
      if (res && res.restReturned) noteRestReturned(date);
      rememberPosted(POSTED_PREV_KEY, date, p.completedRuns);
      state.lastPostedPrevRuns = p.completedRuns;
      state.lastPrevPostAt = Date.now();
    });
  } catch (e) {
    if (handleApiError(e)) return;
    // not critical: we retry on the next tick
  } finally {
    state.postingPrev = false;
  }
}

// Post progress when it has changed. Full completion is sent immediately,
// partial progress at most once a minute, to avoid burning KV writes.
async function maybePost() {
  const p = state.progress;
  if (!p || state.posting) return;
  if (p.completedRuns === state.lastPostedRuns) return;

  const justFinished = p.done && state.lastPostedRuns < p.requiredRuns;
  if (!justFinished && Date.now() - state.lastPostAt < POST_DEBOUNCE_MS) return;

  state.posting = true;
  const date = state.date;
  try {
    await withPostLock(async () => {
      const note = postedNote(POSTED_KEY);
      if (note && note.date === date && note.runs === p.completedRuns) {
        state.lastPostedRuns = p.completedRuns; // another tab already sent exactly this
        return;
      }
      const res = await api.postCompletion({
        date,
        completedRuns: p.completedRuns,
        requiredRuns: p.requiredRuns,
        done: p.done,
      });
      rememberPosted(POSTED_KEY, date, p.completedRuns);
      state.lastPostedRuns = p.completedRuns;
      state.lastPostAt = Date.now();
      if (res && res.restReturned) noteRestReturned(date);
      if (res && res.streak !== undefined) state.streak = res;
      if (state.tab === 'today') renderToday();
    });
  } catch (e) {
    if (handleApiError(e)) return;
    state.scanError = 'Could not save progress: ' + e.message;
  } finally {
    state.posting = false;
  }
}

// ---------- Today tab ----------

async function connectFolder() {
  // stop and restart so the observer gets recreated on the new handle
  stopPolling();
  try {
    state.handle = await pickStatsFolder();
    state.granted = await ensurePermission(state.handle, { request: true });
  } catch (e) {
    if (e.name !== 'AbortError') state.scanError = e.message;
    state.granted = state.handle ? await ensurePermission(state.handle) : false;
  }
  renderToday();
  if (state.granted) startPolling();
}

async function regrant() {
  state.granted = await ensurePermission(state.handle, { request: true });
  renderToday();
  if (state.granted) startPolling();
}

// Today is the System's Daily Quest window: the quest line under the label,
// the day gauge, the scenario list as GOAL rows that read [credited/required]
// with a quest checkbox, the WARNING with the penalty, the rest calendar and
// your chain of the half-week beside it.
export function renderToday() {
  const root = $('view-today');
  root.replaceChildren();

  if (!fsSupported()) {
    root.append(notice('Check-ins happen on your gaming PC in desktop Chrome or Edge. On this device you can watch the group tab.'));
    root.append(renderRestWindow()); // rest days are convenient to schedule right from the phone
    root.append(renderTrialWindow());
    return;
  }
  if (!state.playlist || !state.playlist.scenarios || !state.playlist.scenarios.length) {
    // the real cause (backend down) matters more than "no playlist set"
    root.append(notice(state.scanError || 'No playlist is set for this week yet. Rauder has to import it in Admin.',
      state.scanError ? 'error' : ''));
    return;
  }

  if (SETUP_PREVIEW || !state.granted) {
    root.append(renderSetupGate());
    if (state.scanError) root.append(notice(state.scanError, 'error'));
    return;
  }

  const p = state.progress;
  if (!p) {
    root.append(notice('Scanning...'));
    return;
  }

  document.title = p.done
    ? 'done for today - KOVA STREAK'
    : `${Math.round(p.percent * 100)}% today - KOVA STREAK`;

  // no stats files in the folder at all: almost certainly the wrong one was picked
  if (p.scanned === 0) {
    const warn = notice('There are no KovaaK\'s stats files in this folder at all, so it is probably the wrong one. It has to be the "stats" folder inside FPSAimTrainer\\FPSAimTrainer. If the folder is right, check that Statistics Export is set to "Always" in KovaaK\'s settings (Misc tab).', 'error');
    const rebtn = el('button', 'btn ghost', 'Pick a different folder');
    rebtn.addEventListener('click', connectFolder);
    warn.append(rebtn);
    root.append(warn);
  }

  // ---- the daily quest window ----
  const hero = mkWin();
  activeDecor(hero, p.done);
  hero.append(winHead(`[ Daily quest // ${monthDayShort(state.date)} ]`, p.done ? 'DAY SECURED' : gateLine(), { gold: p.done }));
  hero.append(questLine(`[ Daily Quest: ${state.playlist.weekLabel ? state.playlist.weekLabel + ' playlist' : 'the playlist'} has arrived. ${p.requiredRuns} runs close the day. ]`));
  const row = el('div', 'hero-row');
  row.append(progressRing(p));
  const stats = el('div', 'hero-stats');
  const finished = p.items.filter((i) => i.done).length;
  stats.append(statBlock(p.done ? 'Done' : 'In progress', `${p.completedRuns} / ${p.requiredRuns}`,
    p.done ? 'runs · checked in automatically' : `runs · ${finished} of ${p.items.length} scenarios finished`, p.done ? 'gold' : ''));
  if (state.streak) {
    stats.append(statBlock('Streak', `${state.streak.streak} ${state.streak.streak === 1 ? 'day' : 'days'}`, 'consecutive days completed'));
    stats.append(statBlock('Done this month', state.streak.doneDays != null ? String(state.streak.doneDays) : '-', 'this is what the ranking uses'));
  }
  if (state.group && state.group.players.length > 1) {
    const doneCnt = state.group.players.filter((x) => x.doneToday).length;
    stats.append(statBlock('Group today', `${doneCnt} / ${state.group.players.length}`, 'friends already checked in'));
  }
  row.append(stats);
  hero.append(row);
  root.append(hero);

  if (state.scanError) root.append(notice(state.scanError, 'error'));

  // ---- the goals and the side column ----
  const two = el('div', 'row2');
  two.append(renderGoalsWindow(p));
  const side = el('div', 'side');
  side.append(renderRestWindow());
  const chain = renderMyChainWindow();
  if (chain) side.append(chain);
  side.append(renderTrialWindow());
  two.append(side);
  root.append(two);

  // ---- the playlist line ----
  if (state.playlist.shareCode) {
    const pl = mkWin('playlist-line');
    pl.style.padding = '20px 28px';
    pl.append(el('span', 'win-label', '[ Playlist ]'));
    pl.append(el('span', 'win-sub', `${(state.playlist.weekLabel || 'THIS WEEK').toUpperCase()} · ${p.items.length} SCENARIOS · ${p.requiredRuns} RUNS`));
    pl.append(codeChip(state.playlist.shareCode));
    pl.append(el('span', 'fine', 'Import it in KovaaK\'s: Playlists, Share code, paste. Only runs from this playlist count.'));
    root.append(pl);
  }

  // first aid at the quiet bottom (audit: a healthy player should not meet
  // repair instructions as the first thing on the page)
  const help = el('div', 'help-line');
  help.append(el('span', 'win-sub', '[ PROGRESS NOT UPDATING WHILE YOU PLAY? ]'));
  help.append(el('span', 'win-sub', 'run this in PowerShell:'));
  help.append(codeChip(MIRROR_CMD));
  root.append(help);
}

// GOAL: what remains carries the meaning, secured rows follow under a divider
function renderGoalsWindow(p) {
  const win = mkWin('goals grow');
  win.append(winHead('[ What is left to play ]', p.done ? 'EVERY SCENARIO SECURED' : `${monthDayShort(state.date).toUpperCase()} · RESETS AT YOUR LOCAL MIDNIGHT`));
  const gh = el('div', 'goal-h');
  gh.append(el('i'), el('span', null, 'Goal'), el('i', 'r'));
  win.append(gh);

  const rowFor = (item) => {
    const g = el('div', 'goal' + (item.done ? ' ok' : ''));
    g.append(el('span', 'n', item.name), el('span', 'lead'));
    const c = el('span', 'c', `[${item.credited}/${item.required}]`);
    if (item.played > item.required) c.title = `${item.played} runs played, ${item.required} required`;
    g.append(c, qbox(!!item.done));
    return g;
  };
  const remaining = p.items.filter((i) => !i.done);
  const secured = p.items.filter((i) => i.done);
  for (const item of remaining) win.append(rowFor(item));
  if (secured.length) {
    if (remaining.length) {
      const sh = el('div', 'secured-h');
      sh.append(el('span', null, `[ ${secured.length} ${secured.length === 1 ? 'SCENARIO' : 'SCENARIOS'} SECURED ]`), el('i'));
      win.append(sh);
    }
    for (const item of secured) win.append(rowFor(item));
  }

  if (p.done) {
    const v = el('div', 'verdict');
    const streak = state.streak && state.streak.streak;
    v.innerHTML = '[ DAY SECURED. THE SYSTEM TOOK NOTE. ]<br><span>Checked in automatically. '
      + (streak ? `The streak is ${streak} ${streak === 1 ? 'day' : 'days'}. ` : '')
      + 'Nothing else to do tonight.</span>';
    win.append(v);
  } else {
    const w = el('div', 'warn');
    w.innerHTML = 'Failure to complete the daily quest before midnight will result in a <em>broken streak</em>. A scheduled rest day or an armed Streak Shield is the only way through.';
    win.append(w);
  }
  return win;
}

// your chain of the half-week: the partner, the link state, what it pays
function renderMyChainWindow() {
  const ch = state.chains;
  if (!ch || !ch.groups) return null;
  const g = ch.groups.find((x) => x.members.some((m) => m.userId === state.user.uid));
  const win = mkWin();
  win.style.cssText = 'display:flex;flex-direction:column;gap:18px';
  win.append(winHead('[ Your chain ]', `${monthDayShort(ch.start).toUpperCase()} - ${monthDayShort(ch.last).toUpperCase()}`));
  if (!g) {
    win.append(el('span', 'fine', 'No chain in this window. Close a day and the System pairs you at the next one.'));
    return win;
  }
  const cls = threadClass(g, null);
  const forged = cls === 'is-forged';
  const waiting = cls === 'is-waiting';
  const rowEl = el('div', 'chain-st');
  g.members.forEach((m, i) => {
    if (i > 0) rowEl.append(chainConnector(cls));
    rowEl.append(avatarTile(m, forged ? 'gold' : null));
  });
  const st = el('span', 'win-sub' + (forged ? ' gold' : ''), forged ? 'FORGED' : waiting ? 'WAITING' : 'OPEN');
  st.style.marginLeft = 'auto';
  if (waiting) st.style.color = 'var(--accent)';
  rowEl.append(st);
  win.append(rowEl);

  const partners = g.members.filter((m) => m.userId !== state.user.uid).map((m) => m.displayName);
  const who = partners.join(' and ') || 'your partner';
  const meDone = !!(state.progress && state.progress.done);
  const pay = g.rescue ? '+2 links each, a rescue chain pays double' : '+1 link each';
  const txt = el('span');
  txt.style.cssText = 'font-size:13px;color:var(--text-1);line-height:1.5';
  if (forged) txt.textContent = `${who} and you both closed the day: the chain is forged, ${pay}.`;
  else if (waiting && meDone) txt.textContent = `You closed the day. ${who} ${partners.length > 1 ? 'have' : 'has'} not: the chain waits. Wake ${partners.length > 1 ? 'them' : 'them'} up and it is forged, ${pay}.`;
  else if (waiting) txt.textContent = `${who} already closed the day. Close yours and the chain is forged: ${pay}.`;
  else txt.textContent = `Nobody has closed the day yet. Both ends close, both earn: ${pay}.`;
  win.append(txt);

  const dots = el('div', 'dots');
  for (const d of g.days) dots.append(el('span', 'dot-sq ' + d.state));
  const forgedCount = g.days.filter((d) => d.state === 'forged').length;
  const lab = el('span', 'win-sub', `${forgedCount} OF ${g.days.length} DAYS FORGED${g.perfect ? ' · PERFECT' : ''}`);
  lab.style.marginLeft = '10px';
  dots.append(lab);
  win.append(dots);
  return win;
}

// The first visit: System initialization. Five steps IN ORDER, each its own
// numbered row. People kept jumping straight to the PowerShell line with no
// export enabled and no stats folder on disk, and everything broke (per
// Rauder, 2026-09-10). The folder path always arrives from the helper via
// the clipboard. No fallback Copy path buttons: they overwrote the clipboard
// with the wrong path, friends got caught by that twice.
function renderSetupGate() {
  const gate = mkWin();
  activeDecor(gate);

  if (state.handle && !SETUP_PREVIEW) {
    // the folder was already picked before, only the permission click is needed
    gate.append(winHead('[ Grant folder access ]', 'THE FOLDER IS REMEMBERED'));
    gate.append(questLine('[ Pick "Allow on every visit" in the browser prompt and even this click disappears: next time the page starts watching on its own. ]'));
    const actions = el('div', 'setup-actions');
    const btn = el('button', 'btn big', 'Grant access');
    btn.addEventListener('click', regrant);
    const forget = el('button', 'btn ghost', 'Pick a different folder');
    forget.addEventListener('click', async () => { await forgetFolder(); state.handle = null; renderToday(); });
    actions.append(btn, forget);
    gate.append(actions);
    return gate;
  }

  gate.append(winHead('[ System initialization ]', 'ONE-TIME SETUP · FIVE STEPS, IN THIS ORDER'));
  gate.append(questLine('[ You have become a Player. Each step needs the previous one. After this it is fully automatic: you play, the site checks you in. ]'));

  const steps = el('div');
  steps.style.cssText = 'margin-top:14px;max-width:860px';
  const step = (title, body) => {
    const s = el('div', 'step');
    s.append(svgPlate(String(steps.children.length + 1).padStart(2, '0'), 'accent'));
    const b = el('div');
    b.append(el('div', 't', title));
    const x = el('div', 'x');
    if (typeof body === 'string') x.textContent = body;
    else x.append(...body);
    b.append(x);
    s.append(b, qbox(false));
    steps.append(s);
  };
  step('Turn on stats export', 'In KovaaK\'s: Settings, then the Misc tab, then Statistics Export = "Always".');
  step('Play one run', 'Any scenario, one game. KovaaK\'s creates its stats folder only after the first run with export on. Skip this and the next steps find nothing.');
  if (state.playlist && state.playlist.shareCode) {
    step('Get the playlist', ['Download it in KovaaK\'s with this code: ', codeChip(state.playlist.shareCode)]);
  } else {
    step('Get the playlist', 'Import the week\'s playlist in KovaaK\'s (ask Rauder for the code).');
  }
  const cmdRow = el('div', 'cmd');
  const cmdCode = el('code', null, MIRROR_CMD);
  const cmdCopy = el('button', 'btn ghost', 'Copy command');
  cmdCopy.addEventListener('click', async () => {
    const ok = await copyText(MIRROR_CMD);
    if (ok) {
      cmdCopy.textContent = 'Copied';
      setTimeout(() => { cmdCopy.textContent = 'Copy command'; }, 1500);
    } else {
      const range = document.createRange();
      range.selectNodeContents(cmdCode);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      cmdCopy.textContent = 'Press Ctrl+C';
    }
  });
  cmdRow.append(cmdCode, cmdCopy);
  step('Run the helper', [
    'Press Win, type "powershell", Enter. Paste this line, Enter:',
    cmdRow,
    'When it says Done, your folder path is in the clipboard. If it asks a question, answer it right there.',
  ]);
  step('Pick the folder', 'Press the button below, then Ctrl+V, Enter, "Select Folder".');
  gate.append(steps);

  const actions = el('div', 'setup-actions');
  const btn = el('button', 'btn big', 'Choose stats folder');
  btn.addEventListener('click', connectFolder);
  actions.append(btn, el('span', 'fine', 'When Chrome asks for folder access, pick "Allow on every visit". Everything is remembered after that.'));
  gate.append(actions);

  const w = el('div', 'warn');
  w.style.cssText = 'margin-top:18px;max-width:860px';
  w.innerHTML = 'Skipping step 02 leaves no stats folder on disk, and the helper in step 04 will <em>find nothing</em>. Do them in order.';
  gate.append(w);
  return gate;
}

// ---------- the trial ----------

async function loadTrial() {
  try {
    state.trial = await api.getTrial();
    if (state.tab === 'today') renderToday();
    // on the Admin tab only the trial window redraws: a playlist file read
    // but not yet published must survive the refresh
    if (state.tab === 'admin') {
      const old = document.querySelector('#view-admin .win.trial-admin');
      if (old) old.replaceWith(renderTrialAdminWindow());
    }
  } catch { /* the trial window is optional */ }
}

// The trial report, out of the whole local history: the best, the run count
// and the distinct days on the scenario from BEFORE the window (the
// baseline), plus the best and the run count INSIDE it. Sent once per trial
// and again only when the numbers change (a new run, late files from the mirror).
const TRIAL_BASE_KEY = 'kova-streak-trial-baseline';
async function maybeReportTrialBaseline() {
  const t = state.trial && state.trial.current;
  if (!t || t.resolved || !state.user) return;
  const runs = await getAllParsedRuns();
  let best = 0;
  let n = 0;
  let windowBest = 0;
  let windowRuns = 0;
  const days = new Set();
  for (const r of runs) {
    if (r.scenario !== t.scenario) continue;
    if (r.date < t.start) {
      n++;
      days.add(r.date);
      if (r.score > best) best = r.score;
    } else if (r.date <= t.last) {
      windowRuns++;
      if (r.score > windowBest) windowBest = r.score;
    }
  }
  const sig = `${t.windowId}|${t.scenario}|${n}|${days.size}|${Math.round(best * 10)}|${windowRuns}|${Math.round(windowBest * 10)}`;
  let cached = null;
  try { cached = localStorage.getItem(TRIAL_BASE_KEY); } catch { /* private browsing mode */ }
  if (cached === sig && state.trial.mine) return;
  try {
    await api.postTrialBaseline(t.windowId, { best, runs: n, days: days.size, windowBest, windowRuns });
    try { localStorage.setItem(TRIAL_BASE_KEY, sig); } catch { /* private browsing mode */ }
    await loadTrial();
  } catch (e) {
    if (handleApiError(e)) return;
    /* not critical: retried on the next scan */
  }
}

// The trial of the half-week: the scenario, your own numbers, and the whole
// board in the open (per Rauder, 2026-09-15: transparency, dressed up): the
// baseline, the best inside the window and the delta for everyone who synced.
const TRIAL_RULES_FALLBACK = { crownRuns: 10, crownDays: 5, partRuns: 3, part: 1, crown: 5 };
const TRIAL_BOARD_SHORT = 5;
let trialBoardOpen = false; // the "show all" toggle survives a redraw
function renderTrialWindow() {
  const t = state.trial;
  const win = mkWin();
  win.style.cssText = 'display:flex;flex-direction:column;gap:14px';
  const cur = t && t.current;
  const rules = (t && t.rules) || TRIAL_RULES_FALLBACK;
  if (!cur) {
    win.append(winHead('[ Trial ]', t && t.window ? `${monthDayShort(t.window.start).toUpperCase()} - ${monthDayShort(t.window.last).toUpperCase()}` : 'THIS WINDOW'));
    win.append(el('span', 'fine', 'No trial this window. Rauder picks the scenario.'));
    if (t && t.next) win.append(el('span', 'quest-line', `[ Next window: ${t.next.scenario} ]`));
    return win;
  }
  win.append(winHead('[ Trial ]', `${monthDayShort(cur.start).toUpperCase()} - ${monthDayShort(cur.last).toUpperCase()}` + (cur.resolved ? ' · CLOSED' : '')));
  win.append(el('span', 'trial-scen', cur.scenario));

  // your own line: where the baseline stands, whether you are in, the delta
  const me = t.mine;
  const st = el('span', 'quest-line');
  if (cur.resolved) st.textContent = '[ Closed. The result is in the channel. ]';
  else if (!me) st.textContent = fsSupported() && state.granted ? '[ Syncing your numbers from your history... ]' : '[ Open the site on your gaming PC to sync your numbers. ]';
  else {
    const bits = [];
    if (me.eligible) {
      bits.push(`Baseline <b>${fmtScore(me.baseline)}</b>`);
      if (me.best != null) bits.push(`best now <b>${fmtScore(me.best)}</b> · ${me.pct > 0 ? '<b style="color: var(--ok)">+' + me.pct.toFixed(1) + '%</b>' : 'not beaten yet'}`);
    } else {
      bits.push(`No crown baseline: <b>${me.runs}/${rules.crownRuns}</b> runs on <b>${me.days}/${rules.crownDays}</b> days before ${monthDayShort(cur.start)}`);
    }
    bits.push(me.taking ? `<b>${me.windowRuns}</b> runs this window, you are in` : `<b>${me.windowRuns}/${rules.partRuns}</b> runs this window to be in`);
    st.innerHTML = `[ ${bits.join(' · ')} ]`;
  }
  win.append(st);

  // the board: everyone who synced, the crown-eligible ranked first
  const rows = t.standings || [];
  if (rows.length) {
    const board = el('div', 'tboard');
    const shown = trialBoardOpen ? rows : rows.slice(0, TRIAL_BOARD_SHORT);
    let rank = 0;
    for (const r of shown) {
      const row = el('div', 'tr' + (state.user && r.userId === state.user.uid ? ' you' : ''));
      if (r.eligible && r.pct > 0 && rank < 3) row.append(svgPlate(String(rank + 1), METALS[rank]));
      else row.append(el('span', 'rk', r.eligible ? '·' : ''));
      if (r.eligible && r.pct > 0) rank++;
      row.append(avatarImg(r, 'av sq', 64));
      const nm = el('span', 'nm');
      nm.append(el('span', 'txt', r.name));
      if (row.classList.contains('you')) nm.append(el('span', 'tag you', 'YOU'));
      row.append(nm);
      const sub = el('span', 'sub');
      if (r.eligible) {
        sub.innerHTML = `<b>${fmtScore(r.baseline)}</b> <i>&rarr;</i> <b>${r.best != null ? fmtScore(r.best) : '-'}</b>` + (r.taking ? ` · ${r.windowRuns} in` : ` · ${r.windowRuns}/${rules.partRuns} in`);
      } else {
        sub.innerHTML = `<span class="rookie">no baseline</span> ${r.runs}/${rules.crownRuns} runs · ${r.days}/${rules.crownDays} days` + (r.taking ? ` · ${r.windowRuns} in` : ` · ${r.windowRuns}/${rules.partRuns} in`);
      }
      row.append(sub);
      const pct = el('span', 'pct' + (r.pct > 0 ? ' up' : ' mute'), r.eligible ? (r.pct > 0 ? '+' + r.pct.toFixed(1) + '%' : '0%') : (r.taking ? '+' + rules.part : '-'));
      pct.title = r.eligible ? 'improvement over the baseline' : r.taking ? `in for the +${rules.part} link, no crown without a baseline` : `${rules.partRuns} runs this window to be in`;
      row.append(pct);
      board.append(row);
    }
    win.append(board);
    if (rows.length > TRIAL_BOARD_SHORT) {
      const more = el('button', 'tb-more', trialBoardOpen ? '[ show top 5 ]' : `[ show all ${rows.length} ]`);
      more.type = 'button';
      more.addEventListener('click', () => { trialBoardOpen = !trialBoardOpen; renderToday(); });
      win.append(more);
    }
  }
  const taking = rows.filter((r) => r.taking).length;
  const eligibleCnt = rows.filter((r) => r.eligible).length;
  win.append(el('span', 'win-sub', `${taking} TAKING PART · ${eligibleCnt} CROWN-ELIGIBLE · +${rules.part} LINK FOR ${rules.partRuns} RUNS · +${rules.crown} FOR THE CROWN`));
  return win;
}

// ---------- The Vault: the artifact exchange ----------
// Spend chain links on perks (see CHAIN_PROTOCOL.md). Four artifacts on the
// podium's rarity ladder: the Score point is S (gold, the Monarch's aura), the
// Shield A (silver), the rest day B (bronze), the Frame C (steel). It used to
// live at the bottom of Today and nobody scrolled that far.

const VAULT_ITEMS = [
  { id: 'score', tier: 'gold', name: 'Score point', stock: 'STACKS', fx: '[ +1 DONE · THIS MONTH ]',
    desc: "+1 day to this month's Done score, straight into the ranking. Shows a gold mark by your Done count." },
  { id: 'shield', tier: 'silver', name: 'Streak Shield', stock: '1 HELD AT A TIME', fx: '[ ABSORBS ONE MISS ]',
    desc: 'If a day ends with nothing played, the shield turns it into a rest day at 03:30. Automatic, held until it fires.' },
  { id: 'voucher', tier: 'bronze', name: 'Extra rest day', stock: '1 PER MONTH', fx: '[ +1 REST DAY OVER QUOTA ]',
    desc: 'One rest day above the weekly limit. One use per calendar month.' },
  { id: 'frame', tier: 'steel', name: 'Frame of Honor', stock: 'EXTENDS', fx: '[ +7 DAYS · GOLD FRAME ]',
    desc: 'A golden frame around your avatar on the leaderboard. Seven days of everyone seeing it.' },
];

// line-art glyphs, drawn twice: a wide soft stroke under a crisp one
const GLYPH_PATHS = {
  frame: '<polygon points="14,4 50,4 60,14 60,50 50,60 14,60 4,50 4,14" fill="none"/><polygon points="20,12 44,12 52,20 52,44 44,52 20,52 12,44 12,20" fill="none" opacity=".45"/><circle cx="32" cy="27" r="6" fill="none"/><path d="M20 47 C20 38 44 38 44 47" fill="none"/>',
  voucher: '<path d="M40 8 A22 22 0 1 0 56 40 A17 17 0 1 1 40 8 Z" fill="none" stroke-linejoin="round"/><polygon points="50,12 52.5,16 50,20 47.5,16" fill="currentColor" stroke="none"/><polygon points="56,26 58,29 56,32 54,29" fill="currentColor" stroke="none"/>',
  shield: '<path d="M32 6 L54 14 C54 34 46 50 32 58 C18 50 10 34 10 14 Z" fill="none" stroke-linejoin="round"/><polygon points="32,22 42,32 32,42 22,32" fill="none"/>',
  score: '<polygon points="32,6 52,20 32,34 12,20" fill="none" stroke-linejoin="round"/><path d="M12 32 L32 46 L52 32" fill="none" stroke-linejoin="round"/><path d="M12 44 L32 58 L52 44" fill="none" stroke-linejoin="round"/>',
};
function glyphSvg(id) {
  const p = GLYPH_PATHS[id];
  return `<svg class="glyph" viewBox="0 0 64 64" aria-hidden="true"><g class="glow" fill="none" stroke-linecap="round">${p}</g><g class="line" fill="none" stroke-linecap="round">${p}</g></svg>`;
}

// what you hold right now, per artifact: { text, cls } or null
function vaultItemState(v, id) {
  if (id === 'frame') return v.frameUntil > Date.now() ? { text: 'ACTIVE UNTIL ' + fmtTs(v.frameUntil).toUpperCase(), cls: 'gold' } : null;
  if (id === 'voucher') return v.voucher ? { text: 'HELD', cls: 'ok' } : (v.voucherUsedMonth === localMonth() ? { text: 'USED THIS MONTH', cls: 'amber' } : null);
  if (id === 'shield') return v.shield ? { text: 'HELD · ARMED', cls: 'ok' } : null;
  if (id === 'score') return v.scoreBonus ? { text: `+${v.scoreBonus} THIS MONTH`, cls: 'gold' } : null;
  return null;
}

// the price plate reads the situation: buy, extend, held, or the links missing
function vaultBuyLabel(v, it) {
  const price = v.prices[it.id];
  if (it.id === 'shield' && v.shield) return { label: `${price} LINKS · HELD`, off: true };
  if (it.id === 'voucher' && v.voucher) return { label: `${price} LINKS · HELD`, off: true };
  if (v.links < price) return { label: `${price} LINKS · ${price - v.links} MORE`, off: true };
  if (it.id === 'frame' && v.frameUntil > Date.now()) return { label: `${price} LINKS · EXTEND`, off: false };
  return { label: `${price} LINKS`, off: false };
}

// one artifact tile: the rarity frame, the glyph window, the effect line,
// the state chip, the price plate
function vaultTile(it, v, idx) {
  const t = METAL[it.tier];
  const w = 256, h = 380, c = 16, i = 6;
  const outer = `${c},1 ${w - c},1 ${w - 1},${c} ${w - 1},${h - c} ${w - c},${h - 1} ${c},${h - 1} 1,${h - c} 1,${c}`;
  const inner = `${c + i},${i} ${w - c - i},${i} ${w - i},${c + i} ${w - i},${h - c - i} ${w - c - i},${h - i} ${c + i},${h - i} ${i},${h - c - i} ${i},${c + i}`;
  const orn = (x, y, sx, sy) => `<path d="M${x} ${y + 14 * sy} L${x} ${y + 4 * sy} L${x + 4 * sx} ${y} L${x + 14 * sx} ${y}" fill="none" stroke="${t.metal}" stroke-width="1.5" stroke-opacity=".95"/>`;
  const runes = it.tier === 'steel' ? '' : `<svg class="runes${idx % 2 ? ' rev' : ''}" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="46" fill="none" stroke="${t.metal}" stroke-width=".6" stroke-dasharray="1.4 3.2"/>
      <circle cx="50" cy="50" r="41" fill="none" stroke="${t.metal}" stroke-width="1.6" stroke-dasharray="0.6 9.6" stroke-opacity=".8"/>
      <g fill="${t.metal}" fill-opacity=".85"><rect x="48.6" y="2.6" width="2.8" height="2.8" transform="rotate(45 50 4)"/><rect x="48.6" y="94.6" width="2.8" height="2.8" transform="rotate(45 50 96)"/><rect x="2.6" y="48.6" width="2.8" height="2.8" transform="rotate(45 4 50)"/><rect x="94.6" y="48.6" width="2.8" height="2.8" transform="rotate(45 96 50)"/></g>
    </svg>`;
  const tile = el('div', 'vt');
  tile.style.cssText = `--metal: ${t.metal}; --metal-2: ${t.metal2}; --aura: ${t.aura};`;
  tile.innerHTML = `<div class="aura"></div>${runes}
    <svg class="bg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="vsteel-${it.id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B212B"/><stop offset="1" stop-color="#0E1218"/></linearGradient>
        <linearGradient id="vmet-${it.id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.metal2}"/><stop offset=".5" stop-color="${t.metal}"/><stop offset="1" stop-color="${t.metal2}"/></linearGradient>
      </defs>
      <polygon points="${outer}" fill="url(#vsteel-${it.id})"/>
    </svg>
    <div class="sheen" style="animation-delay: ${idx * 1.7}s;"></div>
    <div class="body">
      <div class="tags"><span class="rtag">${t.rank}-RANK</span><span class="stock">${it.stock}</span></div>
      <div class="icon">${glyphSvg(it.id)}</div>
      <span class="nm">${esc(it.name)}</span>
      <span class="desc">${esc(it.desc)}</span>
      <span class="fx">${it.fx}</span>
    </div>
    <svg class="frame" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="${outer}" fill="none" stroke="url(#vmet-${it.id})" stroke-width="2"/>
      <polygon points="${inner}" fill="none" stroke="${t.metal}" stroke-width="1" stroke-opacity=".34"/>
      <polygon class="energy" points="${outer}" fill="none" stroke="${t.metal2}" stroke-width="2.4" style="animation-delay: ${idx * 1.3}s;"/>
      ${orn(5, 5 + c, 1, 1)}${orn(w - 5, 5 + c, -1, 1)}${orn(5, h - 5 - c, 1, -1)}${orn(w - 5, h - 5 - c, -1, -1)}
    </svg>`;
  const body = tile.querySelector('.body');
  const st = vaultItemState(v, it.id);
  const chip = el('span', 'state' + (st ? ' ' + st.cls : ''), st ? st.text : (it.id === 'score' ? 'NONE THIS MONTH' : 'NONE HELD'));
  body.append(chip);
  const buy = vaultBuyLabel(v, it);
  const btn = el('button', 'buy' + (buy.off ? ' off' : ''));
  btn.type = 'button';
  if (!buy.off) btn.insertAdjacentHTML('afterbegin', linkMarkSvg(t.metal2, 34, 11));
  btn.append(buy.label);
  btn.disabled = buy.off;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await api.buyVault(it.id);
      state.vaultMsg = null;
    } catch (e) {
      if (handleApiError(e)) return;
      state.vaultMsg = e.message;
    }
    await loadVault();
  });
  body.append(btn);
  return tile;
}

// the ledger line for a link movement
function ledgerLine(entry) {
  const why = String(entry.why || '');
  let what = why.toUpperCase();
  if (why.startsWith('chain ')) what = 'CHAIN FORGED';
  else if (why.startsWith('perfect chain')) what = 'PERFECT CHAIN';
  else if (why.startsWith('trial crown')) what = 'CROWN';
  else if (why.startsWith('trial')) what = 'TRIAL';
  else if (why.startsWith('vault ')) {
    const it = VAULT_ITEMS.find((x) => x.id === why.slice(6));
    what = 'THE VAULT · ' + (it ? it.name.toUpperCase() : why.slice(6).toUpperCase());
  }
  const row = el('div');
  row.append(el('span', 'd', fmtTs(entry.at).toUpperCase()), el('span', null, what), el('span', 'lead'));
  const amt = el('span', 'amt', (entry.d > 0 ? '+' : '') + entry.d);
  amt.style.color = entry.d > 0 ? 'var(--ok)' : 'var(--bad)';
  row.append(amt);
  return row;
}

function renderVault() {
  const root = $('view-vault');
  root.replaceChildren();
  const v = state.vault;

  // ---- the wallet: the balance greets you, no scrolling required ----
  const wallet = mkWin();
  activeDecor(wallet, true);
  wallet.append(winHead(`[ The Vault // ${monthDayShort(state.date)} ]`, 'THE SYSTEM TRADES IN LINKS'));
  const grid = el('div', 'vault-wallet');
  const left = el('div');
  left.style.cssText = 'display:flex;flex-direction:column;gap:10px;border-left:1px solid var(--line-1);padding-left:22px';
  left.append(el('span', 'lbl', 'Your links'));
  const bal = el('div');
  bal.style.cssText = 'display:flex;align-items:center;gap:18px';
  const count = el('span', 'mono gold-num count-glow', v ? String(v.links) : '--');
  count.style.cssText = 'font-size:64px;font-weight:700;line-height:1;letter-spacing:-.02em';
  const mark = el('div');
  mark.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  mark.innerHTML = linkMarkSvg('#E8B64A', 84, 27) + `<span class="mono" style="font-size:11px;letter-spacing:.22em;color:#C9A45E">${v && v.links === 1 ? 'LINK' : 'LINKS'}</span>`;
  bal.append(count, mark);
  left.append(bal);
  left.append(el('span', 'lede', 'Forge chains with your partner to earn links. Rescue chains pay double, perfect windows pay a bonus. Links never touch the ranking, they only break ties.'));
  grid.append(left);
  const right = el('div');
  right.style.cssText = 'display:flex;flex-direction:column;gap:12px;border-left:1px solid var(--line-1);padding-left:22px';
  right.append(el('span', 'lbl', 'Ledger'));
  const led = el('div', 'led');
  if (v && v.log && v.log.length) for (const entry of v.log) led.append(ledgerLine(entry));
  else led.append(el('span', 'win-sub', v ? 'NO LINKS HAVE MOVED YET. FORGE A CHAIN.' : 'OPENING THE VAULT...'));
  right.append(led);
  grid.append(right);
  wallet.append(grid);
  root.append(wallet);

  if (!v) return;

  // ---- the exchange ----
  const shop = mkWin();
  shop.append(winHead('[ Exchange ]', 'FOUR ARTIFACTS · THE SAME RARITY LADDER AS THE PODIUM'));
  const tiles = el('div', 'vault-grid');
  VAULT_ITEMS.forEach((it, i) => tiles.append(vaultTile(it, v, i)));
  shop.append(tiles);
  if (state.vaultMsg) {
    const s = el('div', 'status err', `[ THE SYSTEM REFUSED: ${state.vaultMsg} ]`);
    s.style.marginTop = '20px';
    shop.append(s);
  }
  root.append(shop);

  // ---- what you hold, and how links are forged ----
  const two = el('div', 'row2');
  const held = mkWin('grow');
  held.append(winHead('[ Held artifacts ]', 'YOUR INVENTORY'));
  const rows = [
    ['frame', v.frameUntil > Date.now()
      ? [`Gold frame on the leaderboard · ${Math.max(1, Math.ceil((v.frameUntil - Date.now()) / 86400000))} days left · a repurchase extends it by 7`, { text: 'ACTIVE UNTIL ' + fmtTs(v.frameUntil).toUpperCase(), cls: 'gold' }]
      : ['Buy one and the leaderboard shows it for seven days', { text: 'NONE', cls: 'none' }]],
    ['shield', v.shield
      ? ['Fires at 03:30 on the first empty day · the digest reports it', { text: 'ARMED', cls: 'ok' }]
      : ['Nothing absorbs a miss right now', { text: 'NONE', cls: 'none' }]],
    ['voucher', v.voucher
      ? ['One rest day over the weekly quota, once this month', { text: 'HELD', cls: 'ok' }]
      : v.voucherUsedMonth === localMonth()
        ? ['Used this month · one per calendar month', { text: 'NEXT MONTH', cls: 'amber' }]
        : ['One rest day over the weekly quota, once a month', { text: 'NONE', cls: 'none' }]],
    ['score', v.scoreBonus
      ? [`${v.scoreBonus} bought this month · counted in the ranking already`, { text: `+${v.scoreBonus} THIS MONTH`, cls: 'gold' }]
      : [v.links < v.prices.score ? `None bought this month · ${v.prices.score - v.links} more links to the first one` : 'None bought this month · affordable now', { text: 'NONE', cls: 'none' }]],
  ];
  for (const [id, [sub, chip]] of rows) {
    const it = VAULT_ITEMS.find((x) => x.id === id);
    const t = METAL[it.tier];
    const r = el('div', 'held');
    r.style.cssText = `--metal: ${t.metal}; --metal-2: ${t.metal2};`;
    const g = el('div', 'g');
    g.innerHTML = glyphSvg(id);
    const tx = el('div', 't');
    tx.append(el('span', 'n', it.name), el('span', 's', sub));
    r.append(g, tx, el('span', 'stchip ' + chip.cls, chip.text));
    held.append(r);
  }
  two.append(held);

  const rules = mkWin('side wide');
  rules.append(winHead('[ How links are forged ]'));
  // launch defaults of the Chain Protocol (the worker's LINKS table)
  for (const [what, amt] of [['CHAIN FORGED · BOTH ENDS CLOSE', '+1'], ['RESCUE CHAIN · WAKE A SLEEPER', '+2'], ['PERFECT CHAIN · WHOLE WINDOW', '+2'], ['WEEKLY TRIAL · NEW BEST', '+1'], ['WEEKLY TRIAL · TOP IMPROVER', '+5']]) {
    const r = el('div', 'rule');
    r.append(el('span', 'dia'), el('span', null, what), el('span', 'lead'), el('span', 'amt', amt));
    rules.append(r);
  }
  const foot = el('span', 'win-sub', 'EQUAL DONE DAYS: MORE LINKS WINS THE TIE');
  foot.style.cssText = 'display:block;margin-top:14px';
  rules.append(foot);
  two.append(rules);
  root.append(two);
}

async function loadVault() {
  try {
    state.vault = await api.getVault();
    if (state.tab === 'vault') renderVault();
    if (state.tab === 'today') renderToday();
  } catch { /* the shop window is optional */ }
}

// ---------- The Red Gate ----------
// Its own tab, out of the Vault: turning a key is the largest thing a day of
// training buys, and it was sitting underneath a shop. The hall is one canvas
// and one control, because a person who ground all day for that key should
// arrive somewhere that knows it. Everything under it, the ladder and the
// rules, is flat and still like every other window on the site. The descent
// itself is an event and lives in gate.js, full screen, where the
// constitution lets motion off the leash.

let gateBusy = false;
let gateFlash = null; // the outcome of the last descent, shown until the next one
let gateHall = null;  // the live scene, stopped whenever the tab is left

async function loadGate(render = true) {
  try {
    state.gate = await api.getGate();
    paintGateTab();
    if (render && state.tab === 'gate') renderGate();
  } catch { /* the Gate is optional */ }
}

// The tab chip carries the one thing a fresh page must not swallow: a descent
// you walked away from is still open, and it is still holding your links.
function paintGateTab() {
  const b = document.querySelector('.tab-btn[data-tab="gate"]');
  if (!b) return;
  const g = state.gate;
  const inside = !!(g && g.run);
  b.classList.toggle('inside', inside);
  b.classList.toggle('ready', !inside && !!(g && g.open));
  b.title = inside ? 'A descent is still open' : '';
}

// the key marks: one diamond per key the System will hold for you
function keyMarks(held, max) {
  const wrap = el('div', 'rg-keys');
  for (let i = 0; i < max; i++) {
    const k = el('span', 'rgk' + (i < held ? ' on' : ''));
    k.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="12,2 22,12 12,22 2,12"/></svg>';
    wrap.append(k);
  }
  return wrap;
}

// The tab: the hall on top, then the ladder, then the terms.
function renderGate() {
  const root = $('view-gate');
  if (!root) return;
  if (gateHall) { gateHall.stop(); gateHall = null; }
  root.replaceChildren();
  const g = state.gate;
  const inside = !!(g && g.run && !g.run.dead);
  const sealed = !g || (!g.open && !inside);

  // ---- the hall: the arch, and the one thing you do here ----
  const hallWin = mkWin('thegate hall');
  const gh = el('div', 'gh');
  const canvas = el('canvas', 'gh-fx');
  gh.append(canvas);

  const top = el('div', 'gh-top');
  top.append(el('span', 'gh-name' + (inside && g.run.red ? ' red' : ''), inside && g.run.red ? '[ A RED GATE IS OPEN ]' : '[ THE GATE ]'));
  if (g) {
    const kw = el('span', 'gh-k');
    kw.append(keyMarks(g.keys, g.keysMax), el('span', 'n', `${g.keys} ${g.keys === 1 ? 'KEY' : 'KEYS'}`));
    top.append(kw);
  }
  gh.append(top);

  const front = el('div', 'gh-front');
  const fig = (kick, value, unit, alarm) => {
    front.append(el('span', 'gh-kick' + (alarm ? ' alarm' : ''), kick));
    front.append(el('div', 'gh-fig' + (alarm ? ' alarm' : ''), value));
    front.append(el('span', 'gh-unit', unit));
  };
  const enterBtn = (label, sub, fn) => {
    const b = el('button', 'gh-enter');
    b.type = 'button';
    b.append(el('span', 't', label));
    if (sub) b.append(el('span', 's', sub));
    b.addEventListener('mouseenter', () => gateHall && gateHall.heat(true));
    b.addEventListener('mouseleave', () => gateHall && gateHall.heat(false));
    b.addEventListener('focus', () => gateHall && gateHall.heat(true));
    b.addEventListener('blur', () => gateHall && gateHall.heat(false));
    b.addEventListener('click', () => { if (gateHall) gateHall.flare(); fn(); });
    return b;
  };

  if (!g) {
    fig('THE HOARD', '--', 'LINKS');
    front.append(el('span', 'gh-note', '[ Reading the Gate... ]'));
  } else if (inside) {
    // a descent left open is the loudest thing this screen can say
    fig('YOU ARE STILL INSIDE', String(g.run.holding), `HELD AT THE ${g.run.floor > 0 ? g.ranks[g.run.floor - 1] + ' RANK' : 'THRESHOLD'}`, true);
    front.append(enterBtn('BACK INTO THE SHAFT', 'THE KEY IS ALREADY TURNED', () => enterDescent()));
    front.append(el('span', 'gh-note', '[ Walk out from down there and the links are yours. ]'));
    front.append(el('span', 'gh-note dim', '[ Leave the descent open and the shaft keeps them. ]'));
  } else {
    fig('THE HOARD', String(g.hoard), g.hoard === 1 ? 'LINK' : 'LINKS');
    if (g.open) {
      front.append(enterBtn('TURN A KEY', `${g.keys} IN HAND`, () => enterDescent(true)));
      front.append(el('span', 'gh-note', '[ Six ranks down. Everything you hold rides on each one. ]'));
      if (!g.keyToday) front.append(el('span', 'gh-note dim', '[ Close today and the System cuts you another. ]'));
    } else {
      front.append(el('span', 'gh-shut', `[ ${g.why || 'The Gate is shut.'} ]`));
    }
  }
  gh.append(front);
  hallWin.append(gh);

  if (gateFlash) {
    const s = el('div', 'status ' + (gateFlash.kind === 'err' ? 'err' : 'ok'), gateFlash.text);
    s.style.cssText = 'margin:0 26px 22px';
    hallWin.append(s);
  }
  root.append(hallWin);
  gateHall = mountGateHall(canvas, { sealed: sealed && !inside });

  if (!g) return;

  // ---- the ladder: what each rank would hand over right now ----
  const two = el('div', 'row2');
  const lad = mkWin('grow');
  // inside a red gate the ladder IS the red one; outside, the red prices ride
  // alongside the ordinary ones so everybody knows what the 5% is worth
  const inRed = inside && g.run.red;
  const L = inside ? g.run : g;
  lad.append(winHead('[ Six ranks down ]', inRed
    ? 'YOU ARE IN A RED GATE · THESE ARE ITS ODDS AND ITS PRICES'
    : 'WALK OUT WHENEVER YOU LIKE WITH THE SHARE YOUR DEPTH ALLOWS'));
  const lede = el('span', 'lede', 'Each rank is less likely to let you through than the last. Fail one and the Hoard keeps everything you were holding. The S rank takes the Hoard entire.');
  lede.style.cssText = 'display:block;margin-top:10px;max-width:62ch';
  lad.append(lede);
  const ladder = el('div', 'gl' + (inRed ? ' red' : ''));
  g.ranks.forEach((rank, i) => {
    const row = el('div', 'gl-step');
    const claim = L.claim[i];
    const whole = L.share[i] === null;
    if (inside && i < g.run.floor) row.classList.add('cleared');
    else if (inside && i === g.run.floor) row.classList.add('next');
    if (!claim) row.classList.add('dry');
    row.append(svgPlate(rank, i >= 4 ? METALS[0] : i >= 2 ? METALS[1] : 'plain'));
    const t = el('div', 'gl-t');
    t.append(el('span', 'gl-r', `${rank} RANK`));
    t.append(el('span', 'gl-o', `${Math.round(L.survive[i] * 100)}% through · ${Math.round(L.survive.slice(0, i + 1).reduce((a, b) => a * b, 1) * 1000) / 10}% from the door`));
    row.append(t);
    row.append(el('span', 'lead'));
    if (!inside && g.red) {
      const alt = el('span', 'gl-red', whole ? 'ALL' : String(g.red.claim[i]));
      alt.title = 'what a red gate pays at this rank';
      row.append(alt);
    }
    row.append(el('span', 'gl-p', claim ? String(claim) : '--'));
    if (whole) row.append(el('span', 'gl-v', 'THE HOARD'));
    ladder.append(row);
  });
  lad.append(ladder);
  if (!inside && g.red) {
    const key = el('span', 'fine', `The red column is what a red gate pays at that rank. One key in ${Math.round(1 / g.red.chance)} opens one, and in there every rank keeps one more passage of ${g.doors} shut.`);
    key.style.cssText = 'display:block;margin-top:14px';
    lad.append(key);
  }
  two.append(lad);

  // ---- the terms, in the group's own words ----
  const terms = mkWin('side wide');
  terms.append(winHead('[ The terms ]'));
  const rows = [
    ['A DAY CLOSED · ONE KEY CUT', '+1 KEY', ''],
    ['KEYS THE SYSTEM WILL HOLD FOR YOU', String(g.keysMax), ''],
    ['THE HOARD, EVERY NIGHT', '+1 LINK', ''],
    ['EVERY DAY SOMEBODY LET GO', '+1 LINK', ''],
    ['A RANK THAT TURNS YOU AWAY', 'THE HOARD KEEPS IT', ''],
  ];
  if (g.red) rows.push([`A KEY THAT OPENS A RED GATE`, `1 IN ${Math.round(1 / g.red.chance)}`, 'red']);
  for (const [what, amt, cls] of rows) {
    const r = el('div', 'rule' + (cls ? ' ' + cls : ''));
    r.append(el('span', 'dia'), el('span', null, what), el('span', 'lead'), el('span', 'amt', amt));
    terms.append(r);
  }
  const fine = el('span', 'fine', 'The Gate costs training and never touches what you have saved: a key cannot be bought and cannot be traded. Everything it pays comes out of the Hoard, red gates included, and the Hoard is fed by the group. Train well as a group and the Gate stays poor.');
  fine.style.cssText = 'display:block;margin-top:16px';
  terms.append(fine);
  two.append(terms);
  root.append(two);
}

// opens the full-screen descent; `fresh` spends a key first
async function enterDescent(fresh = false) {
  if (gateBusy) return;
  gateBusy = true;
  try {
    if (fresh) {
      const res = await api.gateEnter();
      state.gate = res;
    }
    const g = state.gate;
    if (!g || !g.run) { gateFlash = { kind: 'err', text: '[ The Gate did not open. ]' }; renderGate(); return; }
    openDescent({
      gate: g,
      descend: (door, floor) => api.gateDescend(door, floor),
      extract: () => api.gateExtract(),
      onEnd: (res) => {
        if (res) {
          state.gate = res;
          const which = res.red ? 'RED GATE' : 'GATE';
          gateFlash = res.taken !== undefined
            ? { kind: 'ok', text: res.cleared
              ? `[ ${which} // S RANK. The Hoard left with you: ${res.taken} ${res.taken === 1 ? 'link' : 'links'}. ]`
              : `[ ${which} // Out of the ${res.rank} rank with ${res.taken} ${res.taken === 1 ? 'link' : 'links'}. ]` }
            : { kind: 'err', text: `[ ${which} // The ${res.rank} rank did not let you through. ]` };
        }
        loadVault();
        loadGate();
      },
    });
  } catch (e) {
    if (handleApiError(e)) return;
    gateFlash = { kind: 'err', text: '[ ' + e.message + ' ]' };
    await loadGate(false);
    renderGate();
  } finally {
    gateBusy = false;
  }
}

// ---------- rest days: the permit calendar ----------
// Up to 2 days a week without losing the streak. Scheduled strictly before
// the day starts (group time), so today cannot be toggled: this guards
// against "forgot to play, I will file a rest day in the evening".
// Three weeks (the backend's horizon), one row per week, every cell carries
// its state, the quota reads at the row's end. A click asks the System to
// confirm in a NOTIFICATION box before anything is sent.

const REST_QUOTA_PER_WEEK = 2;  // mirrors the worker's constant
const REST_HORIZON_DAYS = 21;   // the worker refuses dates further ahead

let restPending = null; // { date, on } awaiting the accept

async function loadRest() {
  try {
    const res = await api.getRest();
    state.restDates = res.dates || [];
    state.restFree = res.free || [];
  } catch { /* not critical */ }
}

const CELL_MARKS = {
  done: `<svg class="m" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 5.3 L4 7.6 L8.5 2.5" fill="none" stroke="#4CC38A" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  miss: `<svg class="m" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 L8 8 M8 2 L2 8" fill="none" stroke="#E5484D" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  rest: `<svg class="m" viewBox="0 0 10 10" aria-hidden="true"><path d="M6.5 1.2 A4 4 0 1 0 9 6.6 A3 3 0 1 1 6.5 1.2 Z" fill="#FFFFFF"/></svg>`,
  today: `<svg class="m" viewBox="0 0 10 10" aria-hidden="true"><polygon points="5,1 9,5 5,9 1,5" style="fill: var(--accent)"/></svg>`,
  pend: `<svg class="m" viewBox="0 0 10 10" aria-hidden="true"><polygon points="5,1 9,5 5,9 1,5" fill="none" style="stroke: var(--accent)" stroke-width="1.4"/></svg>`,
};

function renderRestWindow() {
  const win = mkWin();
  win.append(winHead('[ Rest days ]', 'CLICK A DAY · 3 WEEKS AHEAD'));

  const today = state.date;
  const me = state.group && state.group.players.find((p) => p.userId === state.user.uid);
  const restSet = new Set(state.restDates);
  // granted by Rauder or absorbed by a shield: a rest day like any other,
  // but not one the player spent, so it never counts against the weekly quota
  const freeSet = new Set(state.restFree);
  const horizon = addDays(today, REST_HORIZON_DAYS);
  const t0 = new Date(today + 'T12:00:00');
  const monday = addDays(today, -((t0.getDay() + 6) % 7));
  const wdL = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const weekLabels = ['THIS WEEK', 'NEXT WEEK'];

  const cal = el('div', 'cal3');
  cal.style.marginTop = '14px';
  for (let w = 0; w < 3; w++) {
    const row = el('div', 'cal-row');
    const start = addDays(monday, w * 7);
    row.append(el('span', 'wk', weekLabels[w] || monthDayShort(start).toUpperCase()));
    let used = 0;
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      const rec = me && me.byDate[date];
      const isRest = restSet.has(date);
      let st = 'open';
      if (date < today) {
        if (rec && rec.done) st = 'done';
        else if (isRest) st = 'rest';
        else if (rec && rec.completedRuns > 0) st = 'part';
        else if (me && me.joinedDate && date < me.joinedDate) st = 'lock';
        else st = 'miss';
      } else if (date === today) {
        st = rec && rec.done ? 'done' : isRest ? 'rest' : 'today';
      } else if (isRest) st = 'rest';
      else if (restPending && restPending.date === date) st = 'pend';
      else if (date > horizon) st = 'lock';
      const free = st === 'rest' && freeSet.has(date);
      if (st === 'rest' && !free) used++;

      const clickable = date > today && (st === 'open' || st === 'rest' || st === 'pend');
      const cell = el(clickable ? 'button' : 'span', 'cell ' + st + (free ? ' given' : ''));
      if (clickable) {
        cell.type = 'button';
        cell.title = free ? `${date}: rest day given to you, it costs you no quota. Click to cancel`
          : st === 'rest' ? `${date}: scheduled rest day, click to cancel` : `${date}: click to schedule a rest day`;
        cell.addEventListener('click', () => {
          restPending = { date, on: st !== 'rest' };
          state.restError = null;
          renderToday();
        });
      } else {
        cell.title = `${date}: ${st === 'today' ? 'today is locked' : st}`;
      }
      if (CELL_MARKS[st]) cell.insertAdjacentHTML('afterbegin', CELL_MARKS[st]);
      cell.append(el('span', 'wd', wdL[i]), el('span', 'dn', String(Number(date.slice(-2)))));
      row.append(cell);
    }
    row.append(el('span', 'q' + (used >= REST_QUOTA_PER_WEEK ? ' full' : ''), `[${used}/${REST_QUOTA_PER_WEEK}]`));
    cal.append(row);
  }
  win.append(cal);

  // the rules and the current situation, one legend
  const legend = el('span', 'legend');
  legend.style.cssText = 'display:block;margin-top:14px';
  const lines = [`<b>${REST_QUOTA_PER_WEEK} PER WEEK</b> · THE STREAK PASSES OVER A REST DAY · SET IT BEFORE THE DAY STARTS · TODAY IS LOCKED · CLOSE THE PLAYLIST ANYWAY AND THE PERMIT COMES BACK`];
  const bits = [];
  const upcoming = state.restDates.filter((d) => d > today).sort();
  if (upcoming.length) bits.push(upcoming.map((d) => monthDayShort(d).toUpperCase()).join(', ') + ' SCHEDULED');
  const given = upcoming.filter((d) => freeSet.has(d));
  if (given.length) bits.push(`${given.length} GIVEN TO YOU · NO QUOTA SPENT`);
  if (restPending) bits.push(monthDayShort(restPending.date).toUpperCase() + (restPending.on ? ' PENDING' : ' CANCEL PENDING'));
  const v = state.vault;
  if (v) {
    if (v.shield) bits.push('SHIELD ARMED');
    if (v.voucher) bits.push('VOUCHER HELD: ONE MORE DAY THIS MONTH');
    else if (v.voucherUsedMonth === localMonth()) bits.push('VOUCHER USED THIS MONTH');
  }
  if (bits.length) lines.push(bits.map(esc).join(' · '));
  legend.innerHTML = lines.join('<br>');
  win.append(legend);

  if (restPending) win.append(restNotification());
  else if (state.restError) {
    const box = el('div', 'notif err');
    box.style.marginTop = '14px';
    const nh = el('div', 'nh');
    nh.append(el('span', 'ic', '!'), el('span', 'ttl', 'Refused'));
    box.append(nh);
    box.append(el('p', null, `[ ${state.restError} ]`));
    const acts = el('div', 'acts');
    const ok = el('button', 'btn sm ghost', 'Understood');
    ok.type = 'button';
    ok.addEventListener('click', () => { state.restError = null; renderToday(); });
    acts.append(ok);
    box.append(acts);
    win.append(box);
  }
  return win;
}

// the System asks before a rest permit is filed or withdrawn
function restNotification() {
  const { date, on } = restPending;
  const box = el('div', 'notif');
  box.style.marginTop = '14px';
  const nh = el('div', 'nh');
  nh.append(el('span', 'ic', '!'), el('span', 'ttl', 'Notification'));
  box.append(nh);
  const p = el('p');
  p.innerHTML = on
    ? `[ Rest permit: <b>${esc(longDay(date))}</b>. The streak passes over this day. It must be set before the day starts, and it can be cancelled until then. ]`
    : `[ Withdraw the rest permit for <b>${esc(longDay(date))}</b>? The day goes back to a normal quest day. ]`;
  box.append(p);
  const acts = el('div', 'acts');
  const ok = el('button', 'btn sm', 'Accept');
  ok.type = 'button';
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try {
      const res = await api.postRest(date, on);
      state.restDates = res.dates || [];
      state.restError = null;
    } catch (e) {
      if (handleApiError(e)) return;
      state.restError = e.message;
    }
    restPending = null;
    renderToday();
  });
  const no = el('button', 'btn sm ghost', 'Reject');
  no.type = 'button';
  no.addEventListener('click', () => { restPending = null; renderToday(); });
  acts.append(ok, no);
  box.append(acts);
  return box;
}

// ---------- the System's kit: atoms shared by every screen ----------

// The day gauge: a holographic System dial. A slow tick ring and a counter-
// rotating inner dashed circle frame a gradient arc with a comet tip; the
// percentage is holographic metal. Everything glows via layered strokes,
// never CSS filters (a filter on an svg child rasterizes a visible square
// over the translucent window).
function progressRing(p) {
  const size = 200, stroke = 10, r = 78, c = 2 * Math.PI * r;
  const pct = Math.round(p.percent * 100);
  const grad = p.done ? 'rg-done' : 'rg-live';
  const deg = Math.min(360, p.percent * 360);
  const wrap = el('div', 'ring-wrap' + (p.done ? ' done' : ''));
  wrap.innerHTML = `
    <svg viewBox="0 0 ${size} ${size}" class="ring ${p.done ? 'is-done' : ''}${p.percent <= 0 ? ' rg-zero' : ''}">
      <defs>
        <linearGradient id="rg-live" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#B7AEF7"/><stop offset="1" stop-color="#7C6CF0"/>
        </linearGradient>
        <linearGradient id="rg-done" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#F5DFA6"/><stop offset="1" stop-color="#E8B64A"/>
        </linearGradient>
      </defs>
      <circle cx="100" cy="100" r="95" class="rg-dial"/>
      <circle cx="100" cy="100" r="62" class="rg-inner"/>
      <circle cx="100" cy="100" r="${r}" class="rg-track" stroke-width="${stroke}" fill="none"/>
      <g class="rg-turn">
        <circle cx="100" cy="100" r="${r}" class="rg-halo" stroke-width="24" fill="none"
                style="stroke: url(#${grad})"
                stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p.percent)}" stroke-linecap="round"/>
        <circle cx="100" cy="100" r="${r}" class="ring-fill" stroke-width="${stroke}" fill="none"
                style="stroke: url(#${grad})"
                stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p.percent)}" stroke-linecap="round"/>
      </g>
      <g class="rg-tip-rot" style="transform: rotate(${deg}deg)">
        <circle cx="100" cy="${100 - r}" r="9" class="rg-tip-halo"/>
        <circle cx="100" cy="${100 - r}" r="3.4" class="rg-tip"/>
      </g>
    </svg>
    <div class="ring-label"><b class="rg-pct">${pct}%</b><span>${p.done ? 'SECURED' : 'TODAY'}</span></div>`;
  return wrap;
}

// a readout block: label, big mono value, a hint underneath
function statBlock(label, value, hint, cls = '') {
  const b = el('div', 'stat');
  b.append(el('span', 'lbl', label));
  b.append(el('span', 'v' + (cls ? ' ' + cls : ''), value));
  if (hint) b.append(el('span', 'h', hint));
  return b;
}

// the rarity ladder: the podium's places and the Vault's artifacts share it
const METAL = {
  gold: { metal: '#E8B64A', metal2: '#FFF0C2', aura: 'rgba(139, 124, 255, 0.75)', rank: 'S' },
  silver: { metal: '#C3CAD6', metal2: '#FFFFFF', aura: 'rgba(79, 195, 255, 0.45)', rank: 'A' },
  bronze: { metal: '#B88A57', metal2: '#F2D3A6', aura: 'rgba(232, 182, 74, 0.35)', rank: 'B' },
  steel: { metal: '#8A97A8', metal2: '#D7DEE8', aura: 'transparent', rank: 'C' },
};
const METALS = ['gold', 'silver', 'bronze'];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function mkWin(cls = '') {
  return el('div', 'win' + (cls ? ' ' + cls : ''));
}

function winHead(label, sub, opts = {}) {
  const h = el('div', 'win-head');
  h.append(el('span', 'win-label' + (opts.gold ? ' gold' : ''), label));
  if (sub != null) h.append(el('span', 'win-sub' + (opts.gold ? ' gold' : ''), sub));
  return h;
}

// the active window's light: a blurred ribbon, its sharp line, the scan line
function activeDecor(win, gold = false) {
  win.classList.add('active');
  if (gold) win.classList.add('gold');
  win.append(el('span', 'ribbon'), el('span', 'ribbon-line'), el('span', 'scan'));
}

// a quest line under a window label: the System announcing the quest
function questLine(text) {
  const q = el('span', 'quest-line', text);
  q.style.cssText = 'display:block;margin-top:8px';
  return q;
}

// the diamond rank plate, the ARISE ranking mark. Metal plates pulse.
function svgPlate(n, kind = 'plain') {
  const d = '17,2 32,17 17,32 2,17';
  const dIn = '17,7 27,17 17,27 7,17';
  const m = METAL[kind];
  let inner;
  if (m) {
    inner = `<polygon class="halo" points="${d}" fill="none" stroke="${m.metal}" stroke-width="4"/>`
      + `<polygon points="${d}" fill="${m.metal}" fill-opacity=".16" stroke="${m.metal}" stroke-width="1.4"/>`
      + `<polygon points="${dIn}" fill="none" stroke="${m.metal}" stroke-width=".8" stroke-opacity=".45"/>`
      + `<text x="17" y="21.3" text-anchor="middle" fill="${m.metal2}">${esc(n)}</text>`;
  } else if (kind === 'me' || kind === 'accent') {
    inner = (kind === 'me' ? `<polygon class="halo" points="${d}" fill="none" style="stroke: var(--accent)" stroke-width="4"/>` : '')
      + `<polygon points="${d}" style="fill: var(--accent); stroke: var(--accent)" fill-opacity=".14" stroke-width="1.4"/>`
      + `<polygon points="${dIn}" fill="none" style="stroke: var(--accent)" stroke-width=".8" stroke-opacity=".45"/>`
      + `<text x="17" y="21.3" text-anchor="middle" fill="#FFFFFF">${esc(n)}</text>`;
  } else if (kind === 'red' || kind === 'warn') {
    const col = kind === 'red' ? 'var(--bad)' : 'var(--warn)';
    inner = `<polygon points="${d}" style="fill: ${col}; stroke: ${col}" fill-opacity=".12" stroke-opacity=".85" stroke-width="1.2"/>`
      + `<text x="17" y="21.3" text-anchor="middle" style="fill: ${col}">${esc(n)}</text>`;
  } else {
    inner = `<polygon points="${d}" fill="none" style="stroke: var(--line-1)" stroke-width="1.2"/>`
      + `<text x="17" y="21.3" text-anchor="middle" style="fill: var(--text-2)">${esc(n)}</text>`;
  }
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'plate');
  s.setAttribute('viewBox', '0 0 34 34');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = inner;
  return s;
}

const checkSvg = (color = '#4CC38A') => `<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M1.6 5.3 L4 7.6 L8.5 2.5" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// a quest checkbox: true = checked, false = open, null = dashed (nothing recorded)
function qbox(on) {
  const s = el('span', 'qb' + (on ? ' on' : on === null ? ' off' : ''));
  if (on) s.innerHTML = checkSvg();
  return s;
}

// the site's chain glyph (three stadium rings, two twists): the link mark
function linkMarkSvg(color, w = 62, h = 20) {
  return `<svg viewBox="0 0 62 20" style="width: ${w}px; height: ${h}px; display: block;" aria-hidden="true">`
    + `<g fill="none" stroke="${color}" stroke-width="2.1"><rect x="2" y="5.4" width="16" height="9.2" rx="4.6"/><rect x="23" y="5.4" width="16" height="9.2" rx="4.6"/><rect x="44" y="5.4" width="16" height="9.2" rx="4.6"/></g>`
    + `<g fill="${color}"><path d="M15.9 4.8 C19 7.1 22 7.1 25.1 4.8 L25.1 15.2 C22 12.9 19 12.9 15.9 15.2 Z"/><path d="M36.9 4.8 C40 7.1 43 7.1 46.1 4.8 L46.1 15.2 C43 12.9 40 12.9 36.9 15.2 Z"/></g></svg>`;
}

// Discord's CDN serves the size it is asked for. The worker stores the 64px
// URL (enough for a row), so tiles and portraits ask for what they need.
function avatarAt(url, size) {
  if (!url || !/cdn\.discordapp\.com\/(avatars|embed\/avatars)\//.test(url)) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('size', String(size));
    return u.toString();
  } catch {
    return url;
  }
}

function avatarImg(p, cls = 'av sq', size = 128) {
  const img = el('img', cls);
  img.src = avatarAt((p && p.avatar) || avatarFallback(p && p.userId), size);
  img.alt = '';
  safeAvatar(img, p && p.userId);
  return img;
}

// a chamfered portrait tile; with a metal it gets the rarity edge
function avatarTile(p, metal = null, size = 128) {
  const img = avatarImg(p, 'av sq', size);
  if (!metal) return img;
  const t = el('span', 'tile');
  t.style.setProperty('--tm', METAL[metal].metal);
  t.append(img);
  return t;
}

// Today as a quest checkbox: checked DONE, an open box with the goal and a
// thin progress bar, a dashed box when nothing is recorded
function todayQuestCell(t, rest) {
  const cell = el('div', 'today-cell');
  if (t && t.done) {
    const q = el('span', 'qrow ok');
    q.append(qbox(true), 'DONE');
    cell.append(q);
  } else if (rest) {
    const q = el('span', 'qrow');
    q.append(qbox(false), 'REST');
    cell.append(q);
  } else if (t && t.requiredRuns) {
    const pct = Math.min(100, Math.round((t.completedRuns / t.requiredRuns) * 100));
    const q = el('span', 'qrow');
    q.append(qbox(false), `${t.completedRuns}/${t.requiredRuns}`);
    const bar = el('span', 'qbar');
    const fill = el('i');
    fill.style.width = pct + '%';
    bar.append(fill);
    cell.append(q, bar);
  } else {
    const q = el('span', 'qrow none');
    q.append(qbox(null), '--');
    cell.append(q);
  }
  return cell;
}

// time left until the local midnight, the gate of the day
function gateLine() {
  const now = new Date();
  const mid = new Date(now);
  mid.setHours(24, 0, 0, 0);
  const mins = Math.max(0, Math.round((mid - now) / 60000));
  return `GATE CLOSES AT MIDNIGHT · ${Math.floor(mins / 60)}H ${String(mins % 60).padStart(2, '0')}M LEFT`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return localDate(d);
}

// "Tue Sep 15"
function longDay(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTs(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function notice(text, kind = '') {
  return el('div', 'notice ' + kind, text);
}

// ---------- the 100% ceremony ----------
// The cores, the cracks and the black hole live in celebrate.js; this is
// only the gate: once per closed day (the key remembers the last date
// celebrated), only while the tab is visible, with the numbers the verdict
// window shows. A day closed with the site shut still gets its ceremony:
// the first scan after opening finds it done and the key does not match.

const CELEBRATED_KEY = 'kova-celebrated';

function maybeCelebrate(date, night) {
  if (localStorage.getItem(CELEBRATED_KEY) === date) return;
  const p = { date, night };
  if (document.hidden) { celebrationPending = p; return; }
  startCelebration(false, p);
}

function startCelebration(test = false, p = { date: state.date, night: false }) {
  if (!test) localStorage.setItem(CELEBRATED_KEY, p.date);
  const past = p.date !== state.date;
  const progress = past ? state.prevProgress : state.progress;
  runCeremony({
    test,
    date: p.date,
    past,
    night: p.night,
    runs: progress ? progress.requiredRuns : null,
    // read at verdict time: the completion post that carries the fresh streak
    // is still in flight when the ceremony starts. A past day is never given
    // a streak: the number on hand belongs to today, not to that day.
    streak: past ? null : () => (state.streak ? state.streak.streak : null),
    // read at verdict time too: the post that reports it is still in flight
    restReturned: () => state.restReturnedFor === p.date,
    weekLabel: past ? null : state.playlist && state.playlist.weekLabel,
  });
}

// Clickable share-code chip: a click copies it, the label flashes a confirmation.
function codeChip(code) {
  const chip = el('button', 'code');
  chip.type = 'button';
  chip.title = 'Click to copy';
  const txt = el('span', 'txt', code);
  const cp = el('span', 'cp', 'COPY');
  chip.append(txt, cp);
  chip.addEventListener('click', async () => {
    const ok = await copyText(code);
    cp.textContent = ok ? 'COPIED' : 'COPY';
    if (ok) setTimeout(() => { cp.textContent = 'COPY'; }, 1200);
  });
  return chip;
}

// Clipboard with a fallback: the clipboard API can be blocked by policy,
// execCommand is old but requires no permissions.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* manual selection remains */ }
    ta.remove();
    return ok;
  }
}

// ---------- Group tab ----------

// Session expired: clear the token and return to the login screen, otherwise
// the app hammers the backend with 401s forever on top of stale data.
function handleApiError(e) {
  if (e && e.status === 401) {
    logout();
    location.reload();
    return true;
  }
  return false;
}

async function refreshGroup() {
  try {
    // state.groupMonth = null means the current month; a YYYY-MM string means
    // the history view (month navigation next to the calendar title)
    const month = state.groupMonth || localMonth();
    const g = await api.getGroup(month);
    // ignore a stale response if the user navigated to another month meanwhile
    if (g.month === (state.groupMonth || localMonth())) state.group = g;
    // own streak and ranking stats are taken from here so they are on the Today
    // screen right after login, not only after the first progress post.
    // Only from the current month: history months carry historical numbers.
    if (!state.groupMonth) {
      const me = g.players.find((p) => p.userId === state.user.uid);
      if (me) state.streak = { streak: me.streak, missedDays: me.missedDays, doneDays: me.doneDays };
    }
    if (state.tab === 'group') renderGroup();
    if (state.tab === 'today') renderToday();
  } catch (e) {
    if (handleApiError(e)) return;
    state.scanError = e.message;
  }
  // the chain map lives on the current-month view only
  if (!state.groupMonth) {
    try {
      state.chains = await api.getChains();
      if (state.tab === 'group') renderGroup();
    } catch { /* the chain map is optional */ }
    try {
      state.trial = await api.getTrial();
      if (state.tab === 'today') renderToday();
    } catch { /* the trial window is optional */ }
  }
  clearTimeout(groupTimer);
  groupTimer = setTimeout(refreshGroup, GROUP_REFRESH_MS);
}

// First month with any group data: there is nothing to browse before it
const GROUP_MIN_MONTH = '2026-08';

function shiftMonth(m, delta) {
  const [y, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mm - 1 + delta, 1)).toISOString().slice(0, 7);
}

function gotoMonth(month) {
  state.groupMonth = month === localMonth() ? null : month;
  state.group = null; // show the loading notice instead of the stale month
  renderGroup();
  refreshGroup();
}

export function renderGroup() {
  const root = $('view-group');
  root.replaceChildren();

  const g = state.group;
  if (!g) { root.append(notice('Loading the group...')); return; }

  const today = localDate();
  const days = g.days;
  // history view: a past month, frozen results; the live blocks are hidden
  const isHistory = g.month !== localMonth();
  const doneOf = (pl) => (pl.doneDays != null ? pl.doneDays : Object.values(pl.byDate).filter((r) => r.done).length);
  const requiredRuns = state.playlist && state.playlist.scenarios ? state.playlist.scenarios.reduce((n, s) => n + (s.requiredRuns || 0), 0) : 0;

  if (isHistory) {
    // slim banner instead of the live readout
    const bar = mkWin('history-bar');
    bar.style.padding = '18px 28px';
    bar.append(el('span', 'win-label', `[ ${monthName(g.month)} // final results ]`));
    const back = el('button', 'btn ghost', 'Back to this month');
    back.addEventListener('click', () => gotoMonth(localMonth()));
    bar.append(back);
    root.append(bar);
  } else {
    // the group readout: the day's key numbers in one active window
    const doneCnt = g.players.filter((p) => p.doneToday).length;
    const restCnt = g.players.filter((p) => p.restToday).length;
    const runsToday = g.players.reduce((a, p) => a + ((p.todayRuns && p.todayRuns.completedRuns) || 0), 0);
    const topStreak = [...g.players].sort((a, b) => b.streak - a.streak)[0];
    const open = g.players.filter((p) => !p.doneToday && !p.restToday).map((p) => p.displayName);
    const readout = mkWin();
    activeDecor(readout);
    readout.append(winHead(`[ Group // ${monthDayShort(today)} ]`, gateLine()));
    const grid = el('div', 'readout');
    const openLine = open.length
      ? `${open.slice(0, 3).join(', ')}${open.length > 3 ? ` and ${open.length - 3} more` : ''} still open${restCnt ? ` · ${restCnt} on rest` : ''}`
      : (restCnt ? `everyone is in or on rest · ${restCnt} on rest` : 'everyone checked in');
    grid.append(statBlock('Checked in today', `${doneCnt} / ${g.players.length}`, openLine, 'grad-num'));
    grid.append(statBlock('Runs today', String(runsToday), requiredRuns ? `${requiredRuns} per player closes the day` : 'across the group', 'grad-num'));
    if (topStreak && topStreak.streak > 0) {
      const since = topStreak.lastDone ? addDays(topStreak.lastDone, -(topStreak.streak - 1)) : null;
      grid.append(statBlock('Top streak', `${topStreak.streak}d`, `${topStreak.displayName}${since ? ', since ' + monthDayShort(since) : ''}`, 'gold'));
    } else {
      grid.append(statBlock('Top streak', '-', 'nobody holds a streak yet'));
    }
    readout.append(grid);
    root.append(readout);
  }

  // streak podium: top 3 DISTINCT streak values as hunter cards. Players tied
  // on the same streak share the place and fan out like a hand of cards, the
  // longest holder in front (per Pasha, 2026-09-01 and 2026-09-11). A streak
  // is an honor, not a shame: no red board. Current month only.
  const active = g.players.filter((p) => p.streak > 0);
  const podiumValues = [...new Set(active.map((p) => p.streak))].sort((a, b) => b - a).slice(0, 3);
  const podiumGroups = podiumValues.map((v) => active.filter((p) => p.streak === v)
    .sort((a, b) => a.missedDays - b.missedDays || (a.lastDone || '').localeCompare(b.lastDone || '') || a.displayName.localeCompare(b.displayName)));
  if (!isHistory && podiumGroups.length) {
    const pod = mkWin();
    pod.style.overflow = 'hidden';
    pod.append(winHead('[ Streak podium ]', 'LONGEST ACTIVE STREAKS'));
    const stage = el('div', 'podium-stage');
    const sizes = [
      { w: 210, h: 304, ped: 120, num: 54, slot: 280 },
      { w: 172, h: 250, ped: 84, num: 40, slot: 236 },
      { w: 150, h: 218, ped: 56, num: 32, slot: 236 },
    ];
    // the classic order: second on the left, first in the center, third on the right
    const displayOrder = [1, 0, 2].filter((i) => i < podiumGroups.length);
    for (const i of displayOrder) {
      const grp = podiumGroups[i];
      const shown = grp.slice(0, 4); // a wider tie collapses into "+N"
      const sz = sizes[i];
      const metal = METALS[i];
      const slot = el('div', 'podium-slot');
      slot.style.cssText = `width: ${sz.slot}px; --metal: ${METAL[metal].metal};`;
      const cards = shown.map((p, k) => ({
        metal, w: sz.w, h: sz.h, avatar: avatarAt(p.avatar || avatarFallback(p.userId), 512), uid: p.userId, name: p.displayName,
        days: `${podiumValues[i]}d`, rev: k % 2 === 1,
        tier: p.lastDone ? 'SINCE ' + monthDayShort(addDays(p.lastDone, -(p.streak - 1))).toUpperCase() : 'ACTIVE',
      }));
      const holder = el('div');
      holder.innerHTML = cards.length > 1 ? podiumFan(cards, sz.w, sz.h) : podiumCard(cards[0]);
      holder.querySelectorAll('img.portrait').forEach((img) => safeAvatar(img, img.dataset.uid));
      slot.append(holder.firstElementChild);
      const ped = el('div', 'ped');
      ped.style.height = sz.ped + 'px';
      const num = el('span', 'ped-num', ['01', '02', '03'][i]);
      num.style.fontSize = sz.num + 'px';
      ped.append(num);
      if (grp.length > shown.length) ped.append(el('span', 'ped-more', `+${grp.length - shown.length}`));
      slot.append(ped);
      stage.append(slot);
    }
    pod.append(stage);
    root.append(pod);
  }

  // ---- the leaderboard: ranked by days completed this month (the worker sorts) ----
  const lb = mkWin('lb');
  lb.insertAdjacentHTML('afterbegin', '<svg class="lb-rail" viewBox="0 0 1000 8" preserveAspectRatio="none" aria-hidden="true"><line class="glow" x1="0" y1="4" x2="1000" y2="4"/><line class="base" x1="0" y1="4" x2="1000" y2="4"/><rect class="cap" x="0" y="2.5" width="46" height="3"/><rect class="cap" x="954" y="2.5" width="46" height="3"/><line class="run" x1="0" y1="4" x2="1000" y2="4"/></svg>');
  const lbHead = el('div', 'lb-head');
  const title = el('div', 'lb-title');
  title.innerHTML = '<svg class="lb-ico" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="11.5" fill="none" style="stroke: var(--accent)" stroke-width="1.4"/><polygon points="13,6.5 19.5,13 13,19.5 6.5,13" style="fill: var(--accent)" fill-opacity=".9"/></svg>';
  const box = el('span', 'lb-box');
  box.append(el('span', 'win-label', '[ Most days completed ]'));
  title.append(box);
  lbHead.append(title);
  const dayN = Number(today.slice(-2));
  lbHead.append(el('span', 'win-sub', isHistory ? `FINAL STANDINGS · ${monthName(g.month).toUpperCase()}` : `THE PRIZE RANKING · ${monthName(g.month).split(' ')[0].toUpperCase()} · DAY ${dayN} OF ${days.length}`));
  lb.append(lbHead);

  const scroll = el('div', 'lb-scroll');
  const cols = el('div', 'lb-cols' + (isHistory ? ' hist' : ''));
  const colNames = isHistory ? ['#', 'Hunter', 'Done', 'Missed'] : ['#', 'Hunter', 'Done', 'Missed', 'Streak', 'All time', 'Links', 'Today'];
  colNames.forEach((h, i) => cols.append(el('span', i >= 2 ? 'r' : '', h)));
  scroll.append(cols);
  const body = el('div', 'lb-body');
  const topStreakValue = Math.max(0, ...g.players.map((p) => p.streak || 0));
  const chainOf = (uid) => !isHistory && state.chains && state.chains.groups ? state.chains.groups.find((x) => x.members.some((m) => m.userId === uid)) : null;
  g.players.forEach((pl, i) => {
    const isMe = pl.userId === state.user.uid;
    // the red zone: not a single fully completed day in all of history
    const redzone = !isHistory && (pl.totalDone || 0) === 0;
    const returned = !isHistory && pl.reinstatedOn && addDays(pl.reinstatedOn, 14) >= today;
    const metal = i < 3 ? METALS[i] : null;
    const kind = isMe ? 'me' : redzone ? 'red' : metal || 'plain';
    const row = el('div', 'lb-row' + (isHistory ? ' hist' : '') + (isMe ? ' t-me' : metal ? ' t-' + METAL[metal].rank.toLowerCase() : '') + (redzone ? ' t-red' : returned ? ' t-ret' : ''));
    row.append(svgPlate(String(i + 1), kind));

    const hunter = el('div', 'hunter');
    hunter.append(avatarTile(pl, pl.frame ? 'gold' : metal));
    const who = el('div', 'who');
    who.append(el('span', 'nm', pl.displayName));
    const line = el('span', 'code-l');
    const ch = chainOf(pl.userId);
    if (redzone) line.innerHTML = `<span class="bad">NOT PAIRED · NO RECORD${pl.silentDays != null ? ` · SILENT ${pl.silentDays} DAYS` : ''}</span>`;
    else if (ch) {
      const partners = ch.members.filter((m) => m.userId !== pl.userId).map((m) => esc(m.displayName)).join(' + ');
      const cls = threadClass(ch, null);
      const st = cls === 'is-forged' ? '<span class="gold">FORGED</span>' : cls === 'is-waiting' ? '<span class="acc">WAITING</span>' : 'OPEN';
      line.innerHTML = `LINK · ${partners} · ${st}${ch.perfect ? ' <span class="gold">· PERFECT</span>' : ''}`;
    } else if (returned) line.textContent = `BACK SINCE ${monthDayShort(pl.reinstatedOn).toUpperCase()} · CHAINS AFTER A CLOSED DAY`;
    else if (!isHistory) line.textContent = pl.streak > 0 ? `ON A ${pl.streak}-DAY STREAK` : 'NO CHAIN THIS WINDOW';
    else line.textContent = `${doneOf(pl)} DAYS THAT MONTH`;
    who.append(line);
    hunter.append(who);
    if (isMe) hunter.append(el('span', 'tag you', 'YOU'));
    else if (redzone) hunter.append(el('span', 'tag red', 'NO RECORD'));
    else if (returned) hunter.append(el('span', 'tag ret', 'RETURNED'));
    hunter.append(el('span', 'lead'));
    row.append(hunter);

    // Done is the prize metric, so it alone gets the plate
    const doneN = doneOf(pl);
    const score = el('div', 'score');
    const pill = el('span', 'pill' + (metal ? ' metal' : isMe ? ' me' : doneN > 0 ? '' : ' zero'));
    if (metal) pill.style.cssText = `--metal: ${METAL[metal].metal}; --metal-2: ${METAL[metal].metal2};`;
    pill.append(el('i'), String(doneN));
    if (pl.scoreBonus > 0) {
      // bought score points are public: a gold mark keeps the board honest
      pill.append(el('sup', 'score-bought', '+' + pl.scoreBonus));
      pill.title = `includes ${pl.scoreBonus} score point${pl.scoreBonus > 1 ? 's' : ''} from The Vault`;
    }
    score.append(pill);
    row.append(score);
    row.append(el('span', 'num' + (pl.missedDays > 0 ? ' bad' : ' mute'), String(pl.missedDays)));
    if (!isHistory) {
      row.append(el('span', 'num' + (pl.streak > 0 && pl.streak === topStreakValue ? ' gold' : pl.streak > 0 ? '' : ' mute'), pl.streak > 0 ? pl.streak + 'd' : '-'));
      const allN = pl.totalDone != null ? pl.totalDone : doneN;
      row.append(el('span', 'num' + (allN > 0 ? '' : ' mute'), String(allN)));
      row.append(el('span', 'num' + ((pl.links || 0) > 0 ? ' acc' : ' mute'), String(pl.links || 0)));
      const t = pl.byDate[today];
      row.append(todayQuestCell(t, !(t && t.done) && pl.restToday));
    }
    body.append(row);
  });
  scroll.append(body);
  lb.append(scroll);

  // the Your-rank bar pinned to the window bottom
  const meIdx = g.players.findIndex((p) => p.userId === state.user.uid);
  if (!isHistory && meIdx >= 0) {
    const me = g.players[meIdx];
    const bar = el('div', 'lb-me');
    const left = el('div');
    left.style.cssText = 'display:flex;align-items:center;gap:12px';
    left.append(svgPlate(String(meIdx + 1), 'me'));
    const lbl = el('span', 'lbl', 'Your rank');
    lbl.style.color = 'var(--text-0)';
    left.append(lbl);
    bar.append(left);
    bar.append(el('span', 'mono', `${doneOf(me)} DONE · ${me.missedDays} MISSED`));
    bar.append(el('span', 'lead'));
    const third = g.players[2];
    let gap;
    if (meIdx < 3) gap = 'ON THE PODIUM';
    else if (third) {
      const behind = doneOf(third) - doneOf(me);
      gap = behind > 0 ? `${behind} ${behind === 1 ? 'DAY' : 'DAYS'} BEHIND THE PODIUM` : 'TIED WITH THE PODIUM · LINKS DECIDE';
    } else gap = '';
    const gapEl = el('span', 'win-sub', gap);
    gapEl.style.color = 'var(--text-1)';
    bar.append(gapEl);
    const left2 = days.length - dayN;
    bar.append(el('span', 'win-sub sep', `MONTH CLOSES IN ${left2}D`));
    const t = me.byDate[today];
    const q = el('span', 'qrow sep' + (t && t.done ? ' ok' : ''));
    q.append(qbox(!!(t && t.done)), t && t.done ? 'DONE TODAY' : me.restToday ? 'REST TODAY' : t && t.completedRuns ? `${t.completedRuns}/${t.requiredRuns} TODAY` : 'NOTHING YET TODAY');
    bar.append(q);
    lb.append(bar);
  }
  root.append(lb);

  // ---- month calendar, one row per player ----
  const cal = mkWin();
  const calHead = el('div', 'win-head');
  const titleWrap = el('div', 'cal-title');
  titleWrap.append(el('span', 'win-label', `[ ${monthName(g.month)} ]`));
  // quiet history navigation: small chevrons, nothing flashy (per Pasha)
  const nav = el('div', 'month-nav');
  const prevBtn = el('button', null, '‹');
  prevBtn.title = 'Previous month';
  prevBtn.disabled = g.month <= GROUP_MIN_MONTH;
  prevBtn.addEventListener('click', () => gotoMonth(shiftMonth(g.month, -1)));
  const nextBtn = el('button', null, '›');
  nextBtn.title = 'Next month';
  nextBtn.disabled = !isHistory;
  nextBtn.addEventListener('click', () => gotoMonth(shiftMonth(g.month, 1)));
  nav.append(prevBtn, nextBtn);
  titleWrap.append(nav);
  calHead.append(titleWrap);
  const legend = el('div', 'cal-legend');
  [['is-done', 'done'], ['is-partial', 'partial'], ['is-rest', 'rest'], ['is-today-empty', 'today'], ['is-future', 'upcoming']].forEach(([cls, label]) => {
    const item = el('span', 'legend-item');
    item.append(el('span', 'legend-swatch ' + cls));
    item.append(label);
    legend.append(item);
  });
  calHead.append(legend);
  cal.append(calHead);

  const grid = el('div', 'calendar');
  grid.style.setProperty('--days', String(days.length));
  const isMonday = (d) => new Date(d + 'T00:00:00Z').getUTCDay() === 1;
  grid.append(el('div', 'cal-corner'));
  for (const d of days) {
    grid.append(el('div', 'cal-day-head' + (d === today ? ' is-today' : '') + (isMonday(d) ? ' wk' : ''), String(Number(d.slice(-2)))));
  }
  for (const pl of g.players) {
    const restSet = new Set(pl.restDays || []);
    grid.append(el('div', 'cal-name' + (pl.userId === state.user.uid ? ' me' : ''), pl.displayName));
    for (const d of days) {
      const rec = pl.byDate[d];
      let cls = cellClass(rec, d, today, pl.joinedDate);
      let tip = rec ? `${rec.completedRuns}/${rec.requiredRuns}` : 'nothing';
      // a rest day is visible both in the past and as a plan for the future
      if (!(rec && rec.done) && restSet.has(d)) { cls = 'is-rest'; tip = 'scheduled rest day'; }
      const cell = el('div', 'cal-cell ' + cls + (isMonday(d) ? ' wk' : ''));
      cell.title = `${pl.displayName}, ${d}: ` + tip;
      grid.append(cell);
    }
  }
  cal.append(grid);
  root.append(cal);

  if (!isHistory && state.chains && state.chains.groups && state.chains.groups.length) {
    root.append(renderChainMap(state.chains));
  }
}

// one hunter card of the podium (an HTML string; portraits carry data-uid for
// the avatar fallback)
function podiumCard({ w, h, metal, avatar, uid, name, days, tier, rev, style = '', cls = '' }) {
  const m = METAL[metal];
  const rank = m.rank;
  const c = 16;
  const outer = `${c},1 ${w - c},1 ${w - 1},${c} ${w - 1},${h - c} ${w - c},${h - 1} ${c},${h - 1} 1,${h - c} 1,${c}`;
  const i = 6;
  const inner = `${c + i},${i} ${w - c - i},${i} ${w - i},${c + i} ${w - i},${h - c - i} ${w - c - i},${h - i} ${c + i},${h - i} ${i},${h - c - i} ${i},${c + i}`;
  const bandH = Math.round(h * 0.27);
  const portTop = 8, portX = 8, portW = w - 16, portH = h - 16 - bandH + 6;
  const plateW = Math.round(w * 0.24), plateH = Math.round(plateW * 0.9);
  const gid = `${rank}-${w}`;
  const orn = (x, y, sx, sy) => `<path d="M${x} ${y + 14 * sy} L${x} ${y + 4 * sy} L${x + 4 * sx} ${y} L${x + 14 * sx} ${y}" fill="none" stroke="${m.metal}" stroke-width="1.5" stroke-opacity=".95"/>`;
  return `<div class="hcard ${cls}" style="--metal: ${m.metal}; --metal-2: ${m.metal2}; --aura: ${m.aura}; width: ${w}px; height: ${h}px; ${style}">
  <div class="aura"></div>
  <svg class="runes${rev ? ' rev' : ''}" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="46" fill="none" stroke="${m.metal}" stroke-width=".6" stroke-dasharray="1.4 3.2"/>
    <circle cx="50" cy="50" r="41" fill="none" stroke="${m.metal}" stroke-width="1.6" stroke-dasharray="0.6 9.6" stroke-opacity=".8"/>
    <circle cx="50" cy="50" r="36.5" fill="none" stroke="${m.metal}" stroke-width=".4" stroke-opacity=".6"/>
    <g fill="${m.metal}" fill-opacity=".85"><rect x="48.6" y="2.6" width="2.8" height="2.8" transform="rotate(45 50 4)"/><rect x="48.6" y="94.6" width="2.8" height="2.8" transform="rotate(45 50 96)"/><rect x="2.6" y="48.6" width="2.8" height="2.8" transform="rotate(45 4 50)"/><rect x="94.6" y="48.6" width="2.8" height="2.8" transform="rotate(45 96 50)"/></g>
  </svg>
  <svg class="frame-bg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="steel-${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B212B"/><stop offset="1" stop-color="#0E1218"/></linearGradient>
      <linearGradient id="met-${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.metal2}"/><stop offset=".5" stop-color="${m.metal}"/><stop offset="1" stop-color="${m.metal2}"/></linearGradient>
    </defs>
    <polygon points="${outer}" fill="url(#steel-${gid})"/>
  </svg>
  <img class="portrait" src="${esc(avatar)}" data-uid="${esc(uid)}" alt="" style="left: ${portX}px; top: ${portTop}px; width: ${portW}px; height: ${portH}px;">
  <div class="fade" style="left: ${portX}px; top: ${portTop}px; width: ${portW}px; height: ${portH}px;"></div>
  <div class="sheen" style="left: ${portX}px; top: ${portTop}px; width: ${portW}px; height: ${portH}px;"></div>
  <div class="band" style="min-height: ${bandH}px;">
    <span class="nm" style="font-size: ${Math.round(w * 0.092)}px;">${esc(name)}</span>
    <div class="row"><span class="days" style="font-size: ${Math.round(w * 0.13)}px;">${esc(days)}</span><span class="tier">STREAK</span></div>
    <span class="tier">${esc(tier)}</span>
  </div>
  <svg class="frame" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="${outer}" fill="none" stroke="url(#met-${gid})" stroke-width="2"/>
    <polygon points="${inner}" fill="none" stroke="${m.metal}" stroke-width="1" stroke-opacity=".38"/>
    <polygon class="energy" points="${outer}" fill="none" stroke="${m.metal2}" stroke-width="2.6"/>
    ${orn(5, 5 + c, 1, 1)}${orn(w - 5, 5 + c, -1, 1)}${orn(5, h - 5 - c, 1, -1)}${orn(w - 5, h - 5 - c, -1, -1)}
  </svg>
  <div class="rtag">${rank}-RANK</div>
  <div class="plate-h" style="top: ${-Math.round(plateH / 2) + 2}px; width: ${plateW}px; height: ${plateH}px; font-size: ${Math.round(plateH * 0.62)}px;">
    <svg viewBox="0 0 40 36" aria-hidden="true"><polygon points="20,1 38,10 38,26 20,35 2,26 2,10" fill="#0E1218" stroke="url(#met-${gid})" stroke-width="2"/><polygon points="20,6 33.5,12.5 33.5,23.5 20,30 6.5,23.5 6.5,12.5" fill="none" stroke="${m.metal}" stroke-opacity=".45" stroke-width="1"/></svg>
    <span>${rank}</span>
  </div>
  <svg class="wing" viewBox="0 0 60 20" style="top: ${-Math.round(plateH / 2) + 6}px; left: 50%; width: ${plateW + 56}px; height: auto; transform: translateX(-50%);" aria-hidden="true"><path d="M2 14 C10 4 18 4 24 8" fill="none" stroke="${m.metal}" stroke-width="1.6" stroke-linecap="round"/><path d="M4 18 C11 10 17 10 22 13" fill="none" stroke="${m.metal}" stroke-width="1.2" stroke-opacity=".6" stroke-linecap="round"/><path d="M58 14 C50 4 42 4 36 8" fill="none" stroke="${m.metal}" stroke-width="1.6" stroke-linecap="round"/><path d="M56 18 C49 10 43 10 38 13" fill="none" stroke="${m.metal}" stroke-width="1.2" stroke-opacity=".6" stroke-linecap="round"/></svg>
</div>`;
}

// a fanned hand of cards for a shared place: cards[0] holds the place the
// longest and sits in front (rightmost, upright-most)
function podiumFan(cards, w, h) {
  const n = cards.length;
  const spread = { 2: [-8, 8], 3: [-13, 0, 13], 4: [-16, -5, 5, 16] }[n] || [0];
  const step = Math.round(w * 0.36);
  const width = w + (n - 1) * step;
  const inner = cards.slice().reverse().map((cfg, idx) => {
    const j = n - 1 - idx; // j = 0 front
    const rot = spread[n - 1 - j];
    const dx = Math.round((n - 1 - j - (n - 1) / 2) * step);
    return podiumCard({ ...cfg, w, h, rev: j % 2 === 1, cls: j === 0 ? 'front' : 'back', style: `transform: translateX(calc(-50% + ${dx}px)) rotate(${rot}deg); z-index: ${10 - j};` });
  }).join('');
  return `<div class="fan" style="width: ${width}px; height: ${h + 14}px; max-width: 100%;">${inner}</div>`;
}

// The chain map: the current half-week window's pairs, their day states and
// the window arc, a grid with 1px seams (not cards).
function renderChainMap(ch) {
  const win = mkWin();
  win.append(winHead('[ Chain map ]', `${monthDayShort(ch.start).toUpperCase()} - ${monthDayShort(ch.last).toUpperCase()} · YOUR LINKS: ${ch.myLinks}`));
  const cm = el('div', 'cm');
  for (const g of ch.groups) {
    const cls = threadClass(g, null);
    const forged = cls === 'is-forged';
    const node = el('div');
    node.title = g.members.map((m) => m.displayName).join(' x ');
    const row = el('div', 'chain-avatars');
    g.members.forEach((m, i) => {
      if (i > 0) row.append(chainConnector(cls + (g.members.length > 2 ? ' short' : '')));
      row.append(avatarTile(m, forged ? 'gold' : null));
    });
    const forgedCount = g.days.filter((d) => d.state === 'forged').length;
    const st = el('span', 'win-sub state' + (forged ? ' forged' : cls === 'is-waiting' ? ' waiting' : ''),
      (forged ? 'FORGED' : cls === 'is-waiting' ? 'WAITING' : 'OPEN') + (forgedCount > 1 ? ` · x${forgedCount}` : '') + (g.perfect ? ' · PERFECT' : '') + (g.rescue ? ' · RESCUE' : ''));
    row.append(st);
    node.append(row);
    node.append(el('span', 'names', g.members.map((m) => m.displayName).join(' x ')));
    const dots = el('div', 'dots');
    for (const d of g.days) dots.append(el('span', 'dot-sq ' + d.state));
    node.append(dots);
    cm.append(node);
  }
  win.append(cm);
  return win;
}

// A real chain in profile (per Rauder's reference): stadium rings joined by
// edge-on links, waisted where they turn away from the viewer. Color and
// motion come from the state class; forged chains run an energy spark.
function chainConnector(stateCls) {
  const s = el('span', 'chain-conn ' + stateCls);
  const edge = (cx) => `M${cx - 4.6} 4.8 C${cx - 1.5} 7.1 ${cx + 1.5} 7.1 ${cx + 4.6} 4.8 `
    + `L${cx + 4.6} 15.2 C${cx + 1.5} 12.9 ${cx - 1.5} 12.9 ${cx - 4.6} 15.2 Z`;
  s.innerHTML = '<svg viewBox="0 0 62 20" aria-hidden="true">'
    + '<g class="link-run" fill="none" stroke="currentColor" stroke-width="2.1">'
    + '<rect x="2" y="5.4" width="16" height="9.2" rx="4.6"/>'
    + '<rect x="23" y="5.4" width="16" height="9.2" rx="4.6"/>'
    + '<rect x="44" y="5.4" width="16" height="9.2" rx="4.6"/>'
    + '</g>'
    + `<g class="link-edge" fill="currentColor"><path d="${edge(20.5)}"/><path d="${edge(41.5)}"/></g>`
    + '<circle class="link-spark" cx="0" cy="10" r="2.1" fill="currentColor"/>'
    + '</svg>';
  return s;
}

function threadClass(g, todayState) {
  const today = g.days.find((d) => d.state !== 'upcoming' && d.state !== 'forged' && d.state !== 'broken');
  const forgedToday = g.days.some((d) => d.state === 'forged' && d.date === localDate());
  if (forgedToday || g.perfect) return 'is-forged';
  if (today && today.state === 'waiting') return 'is-waiting';
  return 'is-open';
}

function monthDayShort(d) {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function cellClass(rec, date, today, joinedDate) {
  if (rec && rec.done) return 'is-done';
  if (rec && rec.completedRuns > 0) return 'is-partial';
  if (date && joinedDate && date < joinedDate) return 'is-outside';
  if (date && date > today) return 'is-future';
  if (date && date === today) return 'is-today-empty';
  return 'is-missed';
}

function monthName(m) {
  const [y, mm] = m.split('-');
  return new Date(Number(y), Number(mm) - 1, 1).toLocaleString('en', { month: 'long', year: 'numeric' });
}

// ---------- Admin: the operator console ----------

// Roster Protocol: who the System removed for two silent weeks, who is on
// final notice today, and the Reinstate button (the way back runs through
// Rauder by design: the player asks, Rauder clicks). The two sweeps the
// 03:30 cron runs on its own sit at the bottom for the day one cannot wait.
function renderRosterWindow() {
  const win = mkWin();
  win.append(winHead('[ Roster protocol ]', 'IDLE 5 DAYS = NOT PAIRED · 14 = FINAL NOTICE · 15 = REMOVED'));
  const body = el('div');
  body.append(el('div', 'quest-line', '[ Loading the roster... ]'));
  win.append(body);

  const fmt = (d) => (d ? monthDayShort(d) : 'never');
  const load = async () => {
    try {
      const r = await api.getRoster();
      body.replaceChildren();
      const sec = (text, cls) => { const s = el('div', 'sec' + (cls ? ' ' + cls : '')); s.append(el('span', null, text), el('i')); return s; };
      if (r.onNotice.length) {
        body.append(sec(`[ ON FINAL NOTICE · ${r.onNotice.length} ]`, 'red'));
        r.onNotice.forEach((p, i) => {
          const row = el('div', 'ro');
          row.append(svgPlate(String(i + 1).padStart(2, '0'), 'red'));
          const img = avatarImg(p);
          img.style.opacity = '.7';
          row.append(img);
          const t = el('div');
          t.append(el('div', 'n', p.displayName));
          t.append(el('div', 's', `${p.silentDays} silent days · ${p.servedOn ? 'notice served ' + fmt(p.servedOn) + ' · removed at the next sweep if still silent' : 'notice due tomorrow 03:30'}`));
          row.append(t);
          row.append(el('span', 'stchip ' + (p.servedOn ? 'bad' : 'amber'), p.servedOn ? 'DM SENT' : 'DUE'));
          body.append(row);
        });
      }
      body.append(sec(`[ REMOVED · ${r.removed.length} ]`));
      if (!r.removed.length) body.append(el('div', 'quest-line', '[ Nobody. The roster is whole. ]'));
      for (const p of r.removed) {
        const row = el('div', 'ro');
        row.append(svgPlate('--', 'plain'));
        const img = avatarImg(p);
        img.style.opacity = '.5';
        row.append(img);
        const t = el('div');
        const n = el('div', 'n', p.displayName);
        n.style.color = 'var(--text-1)';
        t.append(n);
        t.append(el('div', 's', `removed ${fmt(p.inactiveSince)} · last closed day ${fmt(p.lastDone)} · off the leaderboard and the chain pool`));
        row.append(t);
        const btn = el('button', 'btn ghost', 'Reinstate');
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api.reinstate(p.userId);
            await load();
          } catch (e) {
            if (handleApiError(e)) return;
            btn.textContent = e.message;
          }
        });
        row.append(btn);
        body.append(row);
      }
      const fine = el('span', 'fine', 'A reinstated player gets a fresh two weeks from today. They return to the leaderboard at once and to the chains at the next window after their first closed day.');
      fine.style.cssText = 'display:block;margin-top:14px';
      body.append(fine);
    } catch (e) {
      if (handleApiError(e)) return;
      body.replaceChildren(notice(e.message, 'error'));
    }
  };
  load();

  const sweeps = el('div', 'sweeps');
  const status = el('span', 'fine', 'The 03:30 cron does both on its own. Manual runs are for the day you cannot wait.');
  const sweepBtn = (label, fn, report) => {
    const b = el('button', 'btn ghost', label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const res = await fn();
        status.textContent = report(res);
        await load();
      } catch (e) {
        if (handleApiError(e)) return;
        status.textContent = 'Failed: ' + e.message;
      }
      b.disabled = false;
    });
    return b;
  };
  sweeps.append(
    sweepBtn('Run roster sweep', api.runRosterSweep, (res) => `Roster sweep done: ${(res.noticed || []).length || 0} notices, ${(res.removed || []).length || 0} removed.`),
    sweepBtn('Run shield sweep', api.runShieldSweep, (res) => `Shield sweep done: ${res.absorbed || 0} ${res.absorbed === 1 ? 'miss' : 'misses'} absorbed.`),
    status,
  );
  win.append(sweeps);
  return win;
}

// The admin picks the trial: this window or the next, any scenario from
// this week's list or last week's (a Monday window wants last week's list:
// everyone has a week of runs behind it).
let trialAdminFlash = null; // the outcome of the last button, shown once after the redraw
function renderTrialAdminWindow() {
  const win = mkWin('trial-admin');
  const t = state.trial;
  win.append(winHead('[ Trial ]', 'ONE SCENARIO PER CHAIN WINDOW · YOU PICK IT'));
  const cur = t && t.current;
  const rows = t ? (t.standings || []) : [];
  const eligible = rows.filter((r) => r.eligible);
  const taking = rows.filter((r) => r.taking);
  const rules = (t && t.rules) || TRIAL_RULES_FALLBACK;
  const lead = eligible.find((r) => r.taking && r.pct > 0);
  const status = el('div', 'quest-line', cur
    ? `[ This window: ${cur.scenario} · ${monthDayShort(cur.start)} - ${monthDayShort(cur.last)} · ${taking.length} taking part · ${eligible.length} crown-eligible${lead ? ` · ${lead.name} leads at +${lead.pct.toFixed(1)}%` : ''}${cur.resolved ? ' · closed' : cur.announcedAt ? '' : ' · not announced yet'} ]`
    : '[ No trial this window. ]');
  status.style.cssText = 'display:block;margin-top:8px';
  win.append(status);
  const nxt = el('div', 'quest-line', t && t.next ? `[ Next window: ${t.next.scenario} · announced at 03:30 on its first day ]` : '[ Next window: nothing queued. ]');
  nxt.style.cssText = 'display:block;margin-top:4px';
  win.append(nxt);

  const form = el('div');
  form.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:18px';
  const sel = el('select', 'inp');
  sel.style.minWidth = '320px';
  const addGroup = (label, list) => {
    if (!list || !list.length) return;
    const og = el('optgroup');
    og.label = label;
    for (const s of list) {
      const o = el('option', null, s.name);
      o.value = s.name;
      og.append(o);
    }
    sel.append(og);
  };
  addGroup(state.playlist && state.playlist.weekLabel ? `${state.playlist.weekLabel} (this week)` : 'This week', state.playlist && state.playlist.scenarios);
  addGroup(state.prevPlaylist && state.prevPlaylist.weekLabel ? `${state.prevPlaylist.weekLabel} (last week)` : 'Last week', state.prevPlaylist && state.prevPlaylist.scenarios);
  form.append(sel);
  const target = el('select', 'inp');
  for (const [v, l] of [['current', 'This window'], ['next', 'Next window']]) {
    const o = el('option', null, l);
    o.value = v;
    target.append(o);
  }
  form.append(target);
  const msg = el('div', 'status');
  msg.hidden = true;
  msg.style.marginTop = '14px';
  const say = (text, cls) => { msg.textContent = text; msg.className = 'status ' + cls; msg.hidden = false; };
  if (trialAdminFlash) { say(trialAdminFlash, 'ok'); trialAdminFlash = null; }
  const act = (btn, fn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      trialAdminFlash = await fn();
      await loadTrial(); // redraws this window with the flash
    } catch (e) {
      if (handleApiError(e)) return;
      say('[ ' + e.message + ' ]', 'err');
      btn.disabled = false;
    }
  });
  const set = el('button', 'btn', 'Set trial');
  act(set, async () => {
    const res = await api.setTrial({ scenario: sel.value, target: target.value });
    return `[ Trial set: ${res.trial.scenario} · ${target.value === 'next' ? 'announced at 03:30 on its first day' : 'announced in the channel'} ]`;
  });
  const clear = el('button', 'btn ghost', 'Clear');
  act(clear, async () => { await api.setTrial({ target: target.value, clear: true }); return '[ Cleared. ]'; });
  const close = el('button', 'btn ghost', 'Close now');
  act(close, async () => { const res = await api.resolveTrialNow(); return res.lines && res.lines.length ? res.lines.join(' ') : '[ Nothing to close. ]'; });
  form.append(set, clear, close);
  win.append(form, msg);
  const fine = el('span', 'fine', `Everything pays when the window closes. Playing the scenario ${rules.partRuns} times inside the window: +${rules.part} link, newcomers too. The crown (+${rules.crown} on top) goes to the largest improvement over a real baseline: the player's best from before the window, with at least ${rules.crownRuns} runs on ${rules.crownDays} different days behind it. A Monday window wants a scenario from last week's list, a Thursday window one from this week's.`);
  fine.style.cssText = 'display:block;margin-top:14px';
  win.append(fine);
  return win;
}

function renderAdmin() {
  const root = $('view-admin');
  root.replaceChildren();
  if (!state.gate) loadGate(false).then(() => { if (state.tab === 'admin') renderAdmin(); });

  // ---- the playlist of the week: drop the JSON, name the week, publish ----
  const win = mkWin();
  activeDecor(win);
  win.append(winHead('[ Playlist of the week ]', 'OPERATOR CONSOLE · NOTHING IS TYPED BY HAND'));
  win.append(questLine('[ Drop the playlist JSON from FPSAimTrainer\\Saved\\SaveGames\\Playlists. Scenario names and play counts are read from it. ]'));
  const grid = el('div', 'admin-grid');
  const left = el('div', 'admin-left');

  const drop = el('label', 'drop');
  const input = el('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  drop.append(input);
  drop.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 30 30" aria-hidden="true"><polygon points="6,3 19,3 24,8 24,27 6,27" fill="none" style="stroke: var(--accent)" stroke-width="1.4" stroke-linejoin="round"/><path d="M19 3 L19 8 L24 8" fill="none" style="stroke: var(--accent)" stroke-width="1.4" stroke-linejoin="round"/><path d="M15 12 L15 22 M11 18 L15 22 L19 18" fill="none" style="stroke: var(--accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>');
  drop.append(el('span', 't', 'Drop the playlist JSON'));
  const dropSub = el('span', 's', 'or click to pick it');
  drop.append(dropSub);
  left.append(drop);

  const label = el('input', 'inp');
  label.type = 'text';
  label.placeholder = 'Week label, e.g. Week 1';
  label.value = (state.playlist && state.playlist.weekLabel) || '';
  left.append(label);

  const actions = el('div');
  actions.style.cssText = 'display:flex;align-items:center;gap:14px;flex-wrap:wrap';
  const save = el('button', 'btn', 'Publish to the group');
  save.disabled = true;
  actions.append(save, el('span', 'fine', state.playlist && state.playlist.weekLabel ? `Replaces ${state.playlist.weekLabel} at once. Everyone's Today switches to this list.` : 'Everyone\'s Today switches to this list at once.'));
  left.append(actions);
  grid.append(left);

  const right = el('div');
  const ph = el('div', 'win-head');
  ph.style.marginBottom = '8px';
  const previewLabel = el('span', 'lbl', 'Preview');
  const previewSub = el('span', 'win-sub', 'NOTHING READ YET');
  ph.append(previewLabel, previewSub);
  right.append(ph);
  const preview = el('div');
  right.append(preview);
  const msg = el('div', 'status');
  msg.style.marginTop = '16px';
  msg.hidden = true;
  right.append(msg);
  grid.append(right);
  win.append(grid);

  let parsed = null;
  const say = (text, cls) => { msg.textContent = text; msg.className = 'status ' + cls; msg.hidden = false; };
  const readFile = async (file) => {
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const list = json.scenarioList;
      if (!Array.isArray(list) || !list.length) throw new Error('scenarioList is missing or empty');
      parsed = {
        weekLabel: label.value.trim() || json.playlistName || 'This week',
        shareCode: json.shareCode || null,
        scenarios: list.map((s) => ({ name: s.scenario_name, requiredRuns: Number(s.play_Count) || 1 })),
      };
      if (!label.value.trim()) label.value = parsed.weekLabel;
      const runs = parsed.scenarios.reduce((n, s) => n + s.requiredRuns, 0);
      dropSub.textContent = `${file.name} read · ${parsed.shareCode || 'no share code'} · ${parsed.scenarios.length} scenarios · ${runs} runs`;
      previewLabel.textContent = `Preview · ${parsed.weekLabel}`;
      previewSub.textContent = `${parsed.scenarios.length} SCENARIOS · ${runs} RUNS · ${parsed.shareCode ? 'SHARE CODE READ' : 'NO SHARE CODE IN THE FILE'}`;
      renderPreview(preview, parsed, false);
      save.disabled = false;
      say('[ File read. Nothing published yet. The list above is what the group will see. ]', 'ok');
    } catch (e) {
      parsed = null;
      save.disabled = true;
      say('[ Could not read that file: ' + e.message + ' ]', 'err');
    }
  };
  input.addEventListener('change', () => readFile(input.files[0]));
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    drop.classList.remove('over');
    readFile(ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]);
  });

  save.addEventListener('click', async () => {
    if (!parsed) return;
    parsed.weekLabel = label.value.trim() || parsed.weekLabel;
    save.disabled = true;
    try {
      state.playlist = await api.setPlaylist(parsed);
      renderWeekLabel();
      say('[ Published. Everyone checks against this list now. ]', 'ok');
      state.lastPostedRuns = -1; // requirements changed, recompute and repost
      renderAdmin();
    } catch (e) {
      say('[ Failed: ' + e.message + ' ]', 'err');
      save.disabled = false;
    }
  });
  root.append(win);

  // ---- what the group checks against right now, and the Discord window ----
  const two = el('div', 'row2');
  const cur = mkWin('grow');
  if (state.playlist && state.playlist.scenarios && state.playlist.scenarios.length) {
    const runs = state.playlist.scenarios.reduce((n, s) => n + s.requiredRuns, 0);
    cur.append(winHead('[ Currently published ]', `${(state.playlist.weekLabel || '').toUpperCase()} · ${state.playlist.scenarios.length} SCENARIOS · ${runs} RUNS`));
    const kv = el('div');
    kv.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin:14px 0';
    const pair = (k, v) => { const b = el('div', 'kv'); b.append(el('span', 'k', k), el('span', 'v', v)); return b; };
    kv.append(pair('WEEK LABEL', state.playlist.weekLabel || '-'), pair('SHARE CODE', state.playlist.shareCode || '-'), pair('PUBLISHED', state.playlist.updatedAt ? new Date(state.playlist.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'));
    cur.append(kv);
    renderPreview(cur, state.playlist, true);
  } else {
    cur.append(winHead('[ Currently published ]', 'NOTHING YET'));
    cur.append(el('div', 'quest-line', '[ No playlist is published. The group waits. ]'));
  }
  two.append(cur);

  // manual digest: the same text the 18:00 cron sends
  const dig = mkWin('side wide');
  dig.style.cssText = 'display:flex;flex-direction:column;gap:16px';
  dig.append(winHead('[ Discord ]', 'THE CHANNEL'));
  const chips = el('div', 'chipline');
  chips.append(el('span', 'stchip ok', 'COMPLETION SHOUTS · LIVE'), el('span', 'stchip ok', 'CHAIN CARDS · LIVE'));
  dig.append(chips);
  dig.append(el('span', 'lede', 'Instant completion shouts and the daily 18:00 auto-digest are live. This button posts an extra digest right now, the same text the evening one would send.'));
  const dbtn = el('button', 'btn', 'Post digest now');
  const dmsg = el('div', 'status');
  dmsg.hidden = true;
  dbtn.addEventListener('click', async () => {
    dbtn.disabled = true;
    try {
      await api.postDigest();
      dmsg.textContent = '[ Posted. Check the channel. ]';
      dmsg.className = 'status ok';
    } catch (e) {
      dmsg.textContent = '[ ' + e.message + ' ]';
      dmsg.className = 'status err';
    }
    dmsg.hidden = false;
    dbtn.disabled = false;
  });
  const dact = el('div');
  dact.append(dbtn);
  dig.append(dact, dmsg);
  two.append(dig);
  root.append(two);

  root.append(renderTrialAdminWindow());
  root.append(renderAdminRestWindow());
  root.append(renderGateAdminWindow());
  root.append(renderRosterWindow());
}

// The Red Gate's admin levers: seal it for everyone, set the Hoard, feed it
// by hand, and cut yourself a key. The last three are for testing.
let gateAdminFlash = null;
function renderGateAdminWindow() {
  const win = mkWin('gate-admin');
  win.append(winHead('[ The Red Gate ]', 'KEYS FROM CLOSED DAYS · SEE THE_GATE.MD'));
  const g = state.gate;
  const status = el('div', 'quest-line', g
    ? `[ Hoard: ${g.hoard} ${g.hoard === 1 ? 'link' : 'links'} · one key per closed day, ${g.keysMax} held at most · everything it pays comes out of the Hoard ]`
    : '[ Reading the Gate... ]');
  status.style.cssText = 'display:block;margin-top:8px';
  win.append(status);

  const form = el('div', 'rest-form');
  const potIn = el('input', 'inp date');
  potIn.type = 'number';
  potIn.min = '0';
  potIn.value = g ? String(g.hoard) : '0';
  const msg = el('div', 'status');
  msg.hidden = true;
  const say = (t, c) => { msg.textContent = t; msg.className = 'status ' + c; msg.hidden = false; };
  if (gateAdminFlash) { say(gateAdminFlash, 'ok'); gateAdminFlash = null; }
  const act = (btn, fn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      gateAdminFlash = await fn();
      await loadGate(false);
      renderAdmin();
    } catch (e) {
      if (handleApiError(e)) return;
      say('[ ' + e.message + ' ]', 'err');
      btn.disabled = false;
    }
  });
  const setPot = el('button', 'btn ghost', 'Set the Hoard');
  act(setPot, async () => { const r = await api.setGate({ hoard: Number(potIn.value) }); return `[ Hoard set to ${r.hoard}. ]`; });
  const feed = el('button', 'btn ghost', 'Feed it now');
  act(feed, async () => {
    const r = await api.setGate({ feed: true });
    return r.fed ? `[ Fed ${r.fed.fed} for ${r.fed.date}: 1 plus ${r.fed.missed} missed. Hoard ${r.hoard}. ]` : `[ Already fed for yesterday. Hoard ${r.hoard}. ]`;
  });
  const cutKey = el('button', 'btn ghost', 'Cut me a key');
  act(cutKey, async () => { await api.setGate({ keyFor: state.user.uid }); return '[ Key cut. ]'; });
  const seal = el('button', 'btn ghost', 'Seal the Gate');
  act(seal, async () => { const r = await api.setGate({ closed: true }); return r.closed ? '[ Sealed. Nobody can enter. ]' : '[ Open. ]'; });
  const open = el('button', 'btn ghost', 'Open the Gate');
  act(open, async () => { const r = await api.setGate({ closed: false }); return r.closed ? '[ Sealed. ]' : '[ Open again. ]'; });
  form.append(el('span', 'rest-dash', 'hoard'), potIn, setPot, feed, cutKey, seal, open);
  win.append(form, msg);
  const fine = el('span', 'fine', 'The Hoard eats at the 03:30 sweep: one link for the day plus one for every player who let it go. Everything the Gate pays comes out of it, so the link supply grows by exactly that and no more, and a group that trains well keeps the Gate poor. Seal it if it ever stops being fun. Setting the Hoard, feeding it early and cutting keys are for testing.');
  fine.style.cssText = 'display:block;margin-top:14px';
  win.append(fine);
  return win;
}

// Rest days handed out by the admin (per Rauder, 2026-09-15): any player,
// any stretch of days, past or future, no weekly quota. The player's own
// calendar on Today keeps all of its guards; this window is the way around
// them for the cases only a human can judge, an illness or a week away.
let adminRestFlash = null; // the outcome of the last button, shown once after the redraw
function renderAdminRestWindow() {
  const win = mkWin('rest-admin');
  win.append(winHead('[ Rest days ]', 'ANY PLAYER · ANY DAYS · NO WEEKLY LIMIT'));
  const body = el('div');
  body.append(el('div', 'quest-line', '[ Loading the group... ]'));
  win.append(body);

  const load = async () => {
    let r;
    try {
      r = await api.getAdminRest();
    } catch (e) {
      if (handleApiError(e)) return;
      body.replaceChildren(el('div', 'quest-line', '[ ' + e.message + ' ]'));
      return;
    }
    body.replaceChildren();
    const granted = new Set();
    for (const p of r.players) for (const d of p.granted || []) granted.add(p.userId + '|' + d);

    // ---- the form: who, from when, to when ----
    const form = el('div', 'rest-form');
    const who = el('select', 'inp');
    for (const p of r.players) {
      const o = el('option', null, p.displayName);
      o.value = p.userId;
      who.append(o);
    }
    const from = el('input', 'inp date');
    from.type = 'date';
    from.value = r.today;
    const to = el('input', 'inp date');
    to.type = 'date';
    to.value = r.today;
    // a single day is the common case: moving the start drags the end along
    from.addEventListener('change', () => { if (!to.value || to.value < from.value) to.value = from.value; });
    const dash = el('span', 'rest-dash', 'to');
    form.append(who, from, dash, to);

    const msg = el('div', 'status');
    msg.hidden = true;
    const say = (text, cls) => { msg.textContent = text; msg.className = 'status ' + cls; msg.hidden = false; };
    if (adminRestFlash) { say(adminRestFlash, 'ok'); adminRestFlash = null; }

    const act = (btn, on) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      const name = who.options[who.selectedIndex] ? who.options[who.selectedIndex].textContent : 'the player';
      try {
        const res = await api.setAdminRest({ userId: who.value, from: from.value, to: to.value, on });
        const span = from.value === to.value ? monthDayShort(from.value) : `${monthDayShort(from.value)} - ${monthDayShort(to.value)}`;
        adminRestFlash = res.changed
          ? `[ ${name}: ${span} ${on ? 'granted' : 'withdrawn'} · ${res.changed} ${res.changed === 1 ? 'day' : 'days'} changed ]`
          : `[ ${name}: nothing to change, ${span} was already ${on ? 'off' : 'a normal day'} ]`;
        renderAdmin();
      } catch (e) {
        if (handleApiError(e)) return;
        say('[ ' + e.message + ' ]', 'err');
        btn.disabled = false;
      }
    });
    const give = el('button', 'btn', 'Grant rest');
    act(give, true);
    const take = el('button', 'btn ghost', 'Withdraw');
    act(take, false);
    form.append(give, take);
    body.append(form, msg);

    // ---- who is off, and when ----
    const withDays = r.players.filter((p) => p.dates.some((d) => d >= r.today));
    const head = el('div', 'sec');
    head.append(el('span', null, `[ SCHEDULED FROM TODAY · ${withDays.length} ${withDays.length === 1 ? 'PLAYER' : 'PLAYERS'} ]`), el('i'));
    body.append(head);
    if (!withDays.length) body.append(el('div', 'quest-line', '[ Nobody has a rest day ahead. ]'));
    for (const p of withDays) {
      const row = el('div', 'ro rest-row');
      row.append(svgPlate(String(p.dates.filter((d) => d >= r.today).length).padStart(2, '0'), 'plain'));
      row.append(avatarImg(p));
      const t = el('div');
      t.append(el('div', 'n', p.displayName));
      const chips = el('div', 'rest-chips');
      for (const d of p.dates.filter((x) => x >= r.today)) {
        const chip = el('button', 'rest-chip' + (granted.has(p.userId + '|' + d) ? ' granted' : ''));
        chip.type = 'button';
        chip.title = (granted.has(p.userId + '|' + d) ? 'Granted by you. ' : 'Scheduled by the player. ') + 'Click to withdraw ' + d;
        chip.append(el('span', null, monthDayShort(d).toUpperCase()), el('i', null, '×'));
        chip.addEventListener('click', async () => {
          chip.disabled = true;
          try {
            await api.setAdminRest({ userId: p.userId, date: d, on: false });
            adminRestFlash = `[ ${p.displayName}: ${monthDayShort(d)} withdrawn ]`;
            renderAdmin();
          } catch (e) {
            if (handleApiError(e)) return;
            say('[ ' + e.message + ' ]', 'err');
            chip.disabled = false;
          }
        });
        chips.append(chip);
      }
      t.append(chips);
      row.append(t);
      body.append(row);
    }
    const fine = el('span', 'fine', `A rest day is transparent: the streak passes over it and it is never a missed day. Past days work too, which is how a day is forgiven after the fact. Days you grant here do not count against the player's own ${r.quota} a week, so they can still schedule their own. If they train through a rest day and close the playlist, the day counts as done and the permit goes back to them.`);
    fine.style.cssText = 'display:block;margin-top:14px';
    body.append(fine);
  };
  load();
  return win;
}

// the playlist as quest goals: open boxes for a preview, checked for the
// published one
function renderPreview(container, playlist, published) {
  const old = container.querySelector('.pl');
  if (old) old.remove();
  const pl = el('div', 'pl');
  for (const s of playlist.scenarios) {
    const row = el('div', 'pl-row');
    row.append(qbox(!!published), el('span', 'n', s.name), el('span', 'lead'), el('span', 'x', 'x' + s.requiredRuns));
    pl.append(row);
  }
  container.append(pl);
}

boot();
