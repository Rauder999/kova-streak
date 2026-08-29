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
  restError: null,
};

let pollTimer = null;
let groupTimer = null;
let fsObserver = null;
let lastTickAt = 0;
let celebrationPending = false;

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
    if (celebrationPending) { celebrationPending = false; startCelebration(); }
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
  if (!state.user) return showView('login');

  $('user-name').textContent = state.user.name;
  safeAvatar($('user-avatar'), state.user.uid);
  $('user-avatar').src = state.user.avatar || avatarFallback(state.user.uid);
  $('user-chip').hidden = false;
  $('tabs').hidden = false;
  if (state.user.admin) $('admin-tab-btn').hidden = false;

  try {
    state.playlist = await api.getPlaylist();
  } catch (e) {
    state.scanError = 'Backend unreachable: ' + e.message;
  }
  renderWeekLabel();

  // coach flag: the rollout is controlled from KV, the frontend just asks
  try {
    const me = await api.getMe();
    state.coachEnabled = !!(me && me.coachEnabled);
    $('stats-tab-btn').hidden = !state.coachEnabled;
  } catch { /* without the flag we behave as before */ }

  state.handle = await getStoredFolder();
  if (state.handle) state.granted = await ensurePermission(state.handle);

  // check-in is impossible from a phone, but the group calendar works,
  // so mobile users are greeted with it right away
  switchTab(fsSupported() ? 'today' : 'group');
  refreshGroup();
  loadRest().then(() => { if (state.tab === 'today') renderToday(); });
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
  if (tab === 'today') renderToday();
  if (tab === 'stats') renderStats();
  if (tab === 'group') { renderGroup(); refreshGroup(); }
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

    const { prev, grace, cur, scanned } = await countRunsAroundMidnight(state.handle, state.date, prevDateOf(state.date));
    const split = applyGraceWindow(state.playlist.scenarios, prev, grace, cur);
    state.progress = split.todayProgress;
    state.progress.scanned = scanned;
    state.graceUsed = split.graceUsed;
    // yesterday's progress is posted only if anything was played at all:
    // covers both the grace top-up and fixing "played yesterday but the tab was closed"
    state.prevProgress = split.prevProgress.completedRuns > 0 ? split.prevProgress : null;
    state.scanError = null;
    if (state.progress.done) maybeCelebrate();
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
    await api.postScores(bests);
    localStorage.setItem(PB_CACHE_KEY, ser);
  } catch { /* not critical: we retry with the next new run */ }
}

// Builds the report for the selected date (today or any past day)
async function rebuildReport(day) {
  const runs = await getAllParsedRuns();
  state.playedDates = [...new Set(runs.map((r) => r.date))].sort().reverse().slice(0, 21);
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

function renderStats() {
  const root = $('view-stats');
  root.replaceChildren();

  if (!state.granted) {
    root.append(notice('Connect your stats folder on the Today tab first.'));
    return;
  }
  if (state.indexProgress) {
    root.append(notice(`Reading your history: ${state.indexProgress.done} / ${state.indexProgress.total} runs parsed. First time takes a minute, later it is instant.`));
    return;
  }
  const r = state.report;
  if (!r) {
    root.append(notice('Crunching your runs...'));
    return;
  }

  // day picker: today and past played dates
  if (state.playedDates.length) {
    const days = el('div', 'day-chips');
    const mk = (label, day, active) => {
      const b = el('button', 'day-chip mono' + (active ? ' active' : ''), label);
      b.addEventListener('click', async () => {
        state.statsDate = day;
        state.coachLines = null;
        state.coachHash = null;
        await rebuildReport(day || state.date);
      });
      return b;
    };
    const viewing = state.statsDate || state.date;
    days.append(mk('today', null, viewing === state.date));
    for (const d of state.playedDates) {
      if (d === state.date) continue;
      days.append(mk(d.slice(5), d, viewing === d));
    }
    root.append(days);
  }

  // coach: the answer goes first
  const isPast = (state.statsDate && state.statsDate !== state.date);
  const coach = el('div', 'card coach-card');
  const ch = el('div', 'card-head');
  ch.append(el('h2', null, isPast ? `Verdict for ${r.today}` : 'Next session'));
  if (r.rusty) ch.append(el('span', 'muted', `${r.gapDays} days off before that day`));
  coach.append(ch);
  if (state.coachLines && state.coachLines.length) {
    for (const line of state.coachLines) {
      const m = /^\[(CLICKING|TRACKING|SWITCHING)\]\s*(.*)$/.exec(line);
      const row = el('div', 'coach-line');
      row.append(el('span', 'coach-niche mono', m ? m[1] : '•'));
      row.append(el('span', null, m ? m[2] : line));
      coach.append(row);
    }
    annotateTerms(coach); // jargon becomes a clickable glossary
  } else if (state.coachError) {
    coach.append(el('p', 'muted', 'Coach is unavailable: ' + state.coachError));
  } else if (!r.scenarios.length) {
    coach.append(el('p', 'muted', isPast ? 'No runs on that day.' : 'Play something and the verdict appears here.'));
  } else {
    coach.append(el('p', 'muted', 'Thinking...'));
  }
  root.append(coach);

  // the day's scenarios against their own baseline
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('h2', null, isPast ? `${r.today} vs your usual back then` : 'Today vs your usual'));
  head.append(el('span', 'muted', 'best of the day against the median of the runs before it'));
  card.append(head);

  if (!r.scenarios.length) {
    card.append(el('p', 'muted', isPast ? 'Nothing was played that day.' : 'No runs yet today.'));
  } else {
    const table = el('table', 'stats-table');
    const thead = el('thead');
    const hr = el('tr');
    ['Scenario', 'Runs', 'Best today', 'Your usual', 'Delta'].forEach((h) => hr.append(el('th', null, h)));
    thead.append(hr);
    table.append(thead);
    const tbody = el('tbody');
    for (const s of r.scenarios) {
      const tr = el('tr');
      const nameCell = el('td', 'scen');
      nameCell.append(el('span', null, s.name));
      if (s.isPB) nameCell.append(el('span', 'pb-chip mono', 'PB'));
      tr.append(nameCell);
      tr.append(el('td', 'mono', String(s.runsToday)));
      tr.append(el('td', 'mono', s.bestToday != null ? fmtScore(s.bestToday) : '-'));
      tr.append(el('td', 'mono muted', s.base ? fmtScore(s.base.score) : 'no baseline yet'));
      const d = el('td', 'mono');
      if (s.scoreDelta != null) {
        const pct = Math.round(s.scoreDelta * 100);
        d.append(el('span', 'delta ' + (pct > 2 ? 'up' : pct < -2 ? 'down' : ''), (pct > 0 ? '+' : '') + pct + '%'));
      } else d.textContent = '-';
      tr.append(d);
      tbody.append(tr);
    }
    table.append(tbody);
    card.append(table);
  }
  root.append(card);
}

function fmtScore(v) {
  return v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString();
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
  try {
    await api.postCompletion({
      date: prevDateOf(state.date),
      completedRuns: p.completedRuns,
      requiredRuns: p.requiredRuns,
      done: p.done,
    });
    state.lastPostedPrevRuns = p.completedRuns;
    state.lastPrevPostAt = Date.now();
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
  try {
    const res = await api.postCompletion({
      date: state.date,
      completedRuns: p.completedRuns,
      requiredRuns: p.requiredRuns,
      done: p.done,
    });
    state.lastPostedRuns = p.completedRuns;
    state.lastPostAt = Date.now();
    if (res && res.streak !== undefined) state.streak = res;
    if (state.tab === 'today') renderToday();
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

export function renderToday() {
  const root = $('view-today');
  root.replaceChildren();

  if (!fsSupported()) {
    root.append(notice('Check-ins happen on your gaming PC in desktop Chrome or Edge. On this device you can watch the group tab.'));
    root.append(renderRestCard()); // rest days are convenient to schedule right from the phone
    return;
  }
  if (!state.playlist || !state.playlist.scenarios || !state.playlist.scenarios.length) {
    // the real cause (backend down) matters more than "no playlist set"
    root.append(notice(state.scanError || 'No playlist is set for this week yet. Rauder has to import it in Admin.',
      state.scanError ? 'error' : ''));
    return;
  }

  if (SETUP_PREVIEW || !state.granted) {
    const gate = el('div', 'card gate-card');
    if (state.handle && !SETUP_PREVIEW) {
      // the folder was already picked before, only the permission click is needed
      gate.append(el('h2', null, 'Grant folder access'));
      gate.append(el('p', 'lede', 'The folder is remembered. In the browser prompt pick "Allow on every visit" and even this click disappears: next time the page will just start watching on its own.'));
      const btn = el('button', 'primary big', 'Grant access');
      btn.addEventListener('click', regrant);
      gate.append(btn);
      const forget = el('button', 'ghost', 'Pick a different folder');
      forget.addEventListener('click', async () => { await forgetFolder(); state.handle = null; renderToday(); });
      gate.append(forget);
    } else {
      // first time: four steps, the folder path always arrives from the helper
      // via the clipboard. No fallback Copy path buttons: they overwrote the
      // clipboard with the wrong path, friends got caught by that twice.
      gate.append(el('h2', null, 'One-time setup'));
      gate.append(el('p', 'lede', 'Two minutes, once. Then it is fully automatic: you play, the site checks you in.'));

      const cmdRow = el('div', 'path-row');
      const cmdCode = el('code', 'mono path-text', MIRROR_CMD);
      const cmdCopy = el('button', null, 'Copy command');
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

      const steps = el('ol', 'setup-steps');
      const step = (title, rest) => {
        const li = el('li');
        li.append(el('b', null, title));
        if (typeof rest === 'string') li.append(' ' + rest);
        else if (rest) li.append(...rest);
        steps.append(li);
        return li;
      };
      step('KovaaK\'s settings.', 'Game Options -> Main -> Statistics Export = "Always".');
      if (state.playlist && state.playlist.shareCode) {
        step('Playlist.', [' Download it in KovaaK\'s with this code: ', codeChip(state.playlist.shareCode)]);
      } else {
        step('Playlist.', 'Import the week\'s playlist in KovaaK\'s (ask Rauder for the code).');
      }
      step('PowerShell.', [
        ' Press Win, type "powershell", Enter. Paste this line, Enter:',
        cmdRow,
        'When it says Done, your folder path is in the clipboard. If it asks a question, answer it right there.',
      ]);
      step('Folder.', 'Press the button below, then Ctrl+V, Enter, "Select Folder".');
      gate.append(steps);

      const btn = el('button', 'primary big', 'Choose stats folder');
      btn.addEventListener('click', connectFolder);
      gate.append(btn);

      gate.append(el('p', 'fine', 'When Chrome asks for folder access, pick "Allow on every visit". Everything is remembered after that.'));
    }
    root.append(gate);
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

  // first aid as the very first line, no scrolling needed to reach it: if the
  // mirror on the player's machine died, the answer hangs right above the ring
  const help = el('div', 'help-line');
  help.append(el('span', null, 'Progress not updating while you play? Run this in PowerShell:'));
  const hcode = el('code', 'mono', MIRROR_CMD);
  help.append(hcode);
  const hbtn = el('button', 'ghost', 'Copy');
  hbtn.addEventListener('click', async () => {
    const ok = await copyText(MIRROR_CMD);
    hbtn.textContent = ok ? 'Copied' : 'Copy';
    if (ok) setTimeout(() => { hbtn.textContent = 'Copy'; }, 1500);
  });
  help.append(hbtn);
  root.append(help);

  // no stats files in the folder at all: almost certainly the wrong one was picked
  if (p.scanned === 0) {
    const warn = notice('There are no KovaaK\'s stats files in this folder at all, so it is probably the wrong one. It has to be the "stats" folder inside FPSAimTrainer\\FPSAimTrainer. If the folder is right, check that Statistics Export is set to "Always" in KovaaK\'s Game Options.', 'error');
    const rebtn = el('button', null, 'Pick a different folder');
    rebtn.addEventListener('click', connectFolder);
    warn.append(rebtn);
    root.append(warn);
  }

  // header: progress ring + streak
  const top = el('div', 'today-top');
  top.append(progressRing(p));

  const stats = el('div', 'today-stats');
  stats.append(statBlock(p.done ? 'Done' : 'In progress', `${p.completedRuns} / ${p.requiredRuns} runs`,
    p.done ? 'checked in for today, automatically' : `${p.items.filter((i) => i.done).length} of ${p.items.length} scenarios finished`));
  if (state.streak) {
    stats.append(statBlock('Streak', `${state.streak.streak} ${state.streak.streak === 1 ? 'day' : 'days'}`, 'consecutive days completed'));
    stats.append(statBlock('Missed this month', String(state.streak.missedDays), 'this is what the ranking uses'));
  }
  if (state.group && state.group.players.length > 1) {
    const doneCnt = state.group.players.filter((x) => x.doneToday).length;
    stats.append(statBlock('Group today', `${doneCnt} / ${state.group.players.length}`, 'friends already checked in'));
  }
  if (state.playlist && state.playlist.shareCode) {
    const pc = el('div', 'stat');
    pc.append(el('span', 'stat-label', 'Playlist code'));
    pc.append(codeChip(state.playlist.shareCode));
    pc.append(el('span', 'stat-hint', 'import it in KovaaK\'s, click to copy'));
    stats.append(pc);
  }
  top.append(stats);
  root.append(top);

  if (state.scanError) root.append(notice(state.scanError, 'error'));

  // scenario checklist
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('h2', null, 'What is left to play'));
  head.append(el('span', 'muted mono', state.date + ' · resets at your local midnight'));
  card.append(head);

  const list = el('ul', 'checklist');
  for (const item of p.items) {
    const li = el('li', item.done ? 'done' : '');
    li.append(el('span', 'check', item.done ? '✓' : ''));
    li.append(el('span', 'scen-name', item.name));
    const count = el('span', 'scen-count mono', `${item.credited} / ${item.required}`);
    if (item.played > item.required) count.title = `${item.played} runs played, ${item.required} required`;
    li.append(count);
    list.append(li);
  }
  card.append(list);
  root.append(card);

  root.append(renderRestCard());
}

// ---------- rest days ----------
// Up to 2 days a week without losing the streak. Scheduled strictly before
// the day starts (group time), so today cannot be toggled: this guards
// against "forgot to play, I will file a rest day in the evening".

async function loadRest() {
  try {
    const res = await api.getRest();
    state.restDates = res.dates || [];
  } catch { /* not critical */ }
}

function renderRestCard() {
  const card = el('div', 'card rest-card');
  const head = el('div', 'card-head');
  head.append(el('h2', null, 'Rest days'));
  head.append(el('span', 'muted', 'up to 2 per week, streak survives'));
  card.append(head);
  card.append(el('p', 'lede', 'Know you cannot play on a day? Schedule it in advance and your streak will pass right over it. Days must be set before they start, today cannot be changed.'));

  const row = el('div', 'rest-days');
  for (let i = 1; i <= 10; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const pad = (n) => String(n).padStart(2, '0');
    const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const label = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
    const on = state.restDates.includes(iso);
    const chip = el('button', 'rest-chip' + (on ? ' on' : ''), label);
    chip.title = iso + (on ? ' - scheduled rest day, click to cancel' : ' - click to schedule a rest day');
    chip.addEventListener('click', async () => {
      chip.disabled = true;
      try {
        const res = await api.postRest(iso, !on);
        state.restDates = res.dates || [];
        state.restError = null;
      } catch (e) {
        if (handleApiError(e)) return;
        state.restError = e.message;
      }
      renderToday();
    });
    row.append(chip);
  }
  card.append(row);
  if (state.restError) card.append(el('p', 'notice error', state.restError));
  return card;
}

function progressRing(p) {
  const size = 200, stroke = 14, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const pct = Math.round(p.percent * 100);
  const wrap = el('div', 'ring-wrap');
  wrap.innerHTML = `
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="ring ${p.done ? 'is-done' : ''}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-track" stroke-width="${stroke}" fill="none"></circle>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fill" stroke-width="${stroke}" fill="none"
              stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p.percent)}"
              transform="rotate(-90 ${size / 2} ${size / 2})" stroke-linecap="round"></circle>
    </svg>
    <div class="ring-label"><b class="mono">${pct}%</b><span>today</span></div>`;
  return wrap;
}

function statBlock(label, value, hint) {
  const b = el('div', 'stat');
  b.append(el('span', 'stat-label', label));
  b.append(el('span', 'stat-value mono', value));
  if (hint) b.append(el('span', 'stat-hint', hint));
  return b;
}

function notice(text, kind = '') {
  return el('div', 'notice ' + kind, text);
}

// ---------- 100% celebration: a pentagon of targets, KovaaK's style ----------
// Dim for ~a second, five "3D" balls appear one by one with a spin-up and a
// rising spawn sound. Click = shot sound (always the same) + a kill sound
// that gets higher with every hit. The fifth: a chord and the card.
// The sounds are real ones from Pasha's KovaaK's folder: 808 perc (spawn),
// rxSound11 (shot), kick-deep (kill). If they fail to load, synth fallback.

const CELEBRATED_KEY = 'kova-celebrated';
const HIT_NOTES = [392.0, 440.0, 493.88, 587.33, 659.25]; // fallback: G4 A4 B4 D5 E5
const FINAL_CHORD = [523.25, 659.25, 783.99, 1046.5];     // C E G C
const KILL_RATES = [1, 1.19, 1.41, 1.68, 2.0];    // +3 semitones per hit
const SPAWN_RATES = [1, 1.12, 1.26, 1.41, 1.59];  // +2 semitones per spawn

let actx = null;
function ensureCtx() {
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

function tone(freq, dur = 0.22, gainV = 0.16) {
  try {
    const ctx = ensureCtx();
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = freq;
    g.gain.setValueAtTime(gainV, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  } catch { /* sound is optional */ }
}

let sndBuffers = null; // null = not loaded yet, false = failed, object = ready
async function loadSounds() {
  if (sndBuffers !== null) return;
  try {
    const ctx = ensureCtx();
    const load = async (url) => ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const [spawn, shot, kill] = await Promise.all(
      ['assets/spawn-808.ogg', 'assets/shot-rx11.ogg', 'assets/kill-kick.ogg'].map(load));
    sndBuffers = { spawn, shot, kill };
  } catch {
    sndBuffers = false;
  }
}

function playBuf(name, rate = 1, gain = 0.5) {
  if (!sndBuffers || !sndBuffers[name]) return false;
  try {
    const ctx = ensureCtx();
    const s = ctx.createBufferSource();
    s.buffer = sndBuffers[name];
    s.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    s.connect(g).connect(ctx.destination);
    s.start();
    return true;
  } catch {
    return false;
  }
}

function maybeCelebrate() {
  if (localStorage.getItem(CELEBRATED_KEY) === state.date) return;
  if (document.hidden) { celebrationPending = true; return; }
  startCelebration();
}

function startCelebration(test = false) {
  if (document.querySelector('.celebrate-overlay')) return;
  if (!test) localStorage.setItem(CELEBRATED_KEY, state.date);
  loadSounds(); // decoding the three small ogg files finishes before the first spawn

  const overlay = el('div', 'celebrate-overlay');
  const finale = () => {
    FINAL_CHORD.forEach((f, i) => setTimeout(() => tone(f, 0.7, 0.14), i * 70));
    overlay.replaceChildren();
    const fin = el('div', 'celebrate-final');
    fin.append(el('div', 'final-pct mono', '100%'));
    fin.append(el('div', 'final-title', 'Day complete'));
    fin.append(el('div', 'final-sub', state.streak && state.streak.streak
      ? `${state.streak.streak} day streak, checked in automatically`
      : 'checked in automatically'));
    overlay.append(fin);
    setTimeout(() => overlay.remove(), 2600);
  };

  // respect reduced motion: no shooting gallery, straight to the card
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.body.append(overlay);
    finale();
    return;
  }

  const hint = el('div', 'celebrate-hint', 'shoot the targets');
  overlay.append(hint);

  const R = Math.max(140, Math.min(300, Math.min(window.innerWidth, window.innerHeight) * 0.3));
  const balls = [];
  let left = 5;
  for (let i = 0; i < 5; i++) {
    const ang = (-90 + i * 72) * Math.PI / 180;
    const ball = el('button', 'celebrate-ball');
    ball.style.left = `calc(50% + ${Math.round(Math.cos(ang) * R)}px)`;
    ball.style.top = `calc(50% + ${Math.round(Math.sin(ang) * R)}px)`;
    ball.addEventListener('click', () => {
      if (ball.classList.contains('hit') || !ball.classList.contains('spawned')) return;
      ball.classList.add('hit');
      const idx = 5 - left;
      // the shot is always the same, the kill sound rises with every hit
      if (!playBuf('shot', 1, 0.5)) tone(660, 0.05, 0.07);
      if (!playBuf('kill', KILL_RATES[idx], 0.6)) tone(HIT_NOTES[idx]);
      hint.classList.add('gone');
      left--;
      if (left === 0) setTimeout(finale, 220);
    });
    overlay.append(ball);
    balls.push(ball);
  }

  const skip = el('button', 'celebrate-skip ghost', 'skip');
  skip.addEventListener('click', () => overlay.remove());
  overlay.append(skip);

  document.body.append(overlay);

  // dim for ~0.9s, then balls one by one: spin-up + spawn sound higher and higher
  balls.forEach((b, i) => {
    setTimeout(() => {
      if (!overlay.isConnected) return; // skip could have been pressed during the spawn
      b.classList.add('spawned');
      if (!playBuf('spawn', SPAWN_RATES[i], 0.45)) tone(280 * SPAWN_RATES[i], 0.14, 0.07);
      if (i === balls.length - 1) hint.classList.add('shown');
    }, 900 + i * 190);
  });
}

// Clickable share-code chip: a click copies it, the label flashes a confirmation.
function codeChip(code) {
  const chip = el('button', 'code-chip mono', code);
  chip.title = 'Click to copy';
  chip.addEventListener('click', async () => {
    const ok = await copyText(code);
    const prev = chip.textContent;
    chip.textContent = ok ? 'copied!' : code;
    if (ok) setTimeout(() => { chip.textContent = prev; }, 1200);
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
    state.group = await api.getGroup(localMonth());
    // own streak and missed days are taken from here so they are on the Today
    // screen right after login, not only after the first progress post
    const me = state.group.players.find((p) => p.userId === state.user.uid);
    if (me) state.streak = { streak: me.streak, missedDays: me.missedDays };
    if (state.tab === 'group') renderGroup();
    if (state.tab === 'today') renderToday();
  } catch (e) {
    if (handleApiError(e)) return;
    state.scanError = e.message;
  }
  clearTimeout(groupTimer);
  groupTimer = setTimeout(refreshGroup, GROUP_REFRESH_MS);
}

export function renderGroup() {
  const root = $('view-group');
  root.replaceChildren();

  const g = state.group;
  if (!g) { root.append(notice('Loading the group...')); return; }

  const today = localDate();
  const days = g.days;

  // group pulse: the day's key numbers in a single strip
  const doneCnt = g.players.filter((p) => p.doneToday).length;
  const restCnt = g.players.filter((p) => p.restToday).length;
  const runsToday = g.players.reduce((a, p) => a + ((p.todayRuns && p.todayRuns.completedRuns) || 0), 0);
  const topStreak = [...g.players].sort((a, b) => b.streak - a.streak)[0];
  const hero = el('div', 'group-hero');
  const tile = (label, value, hint) => {
    const t = el('div', 'hero-tile');
    t.append(el('span', 'stat-label', label));
    t.append(el('span', 'hero-value mono', value));
    if (hint) t.append(el('span', 'stat-hint', hint));
    return t;
  };
  hero.append(tile('Checked in today', `${doneCnt} / ${g.players.length}`));
  hero.append(tile('Runs today', String(runsToday)));
  if (topStreak && topStreak.streak > 0) hero.append(tile('Top streak', `${topStreak.streak}d`, topStreak.displayName));
  if (restCnt) hero.append(tile('On rest today', String(restCnt)));
  root.append(hero);

  // streak podium: top 3 with big avatars in frames from the OPERATOR pack.
  // A streak is an honor, not a shame: no red "did not play today" board.
  const streakers = [...g.players].filter((p) => p.streak > 0)
    .sort((a, b) => b.streak - a.streak || a.missedDays - b.missedDays || a.displayName.localeCompare(b.displayName))
    .slice(0, 3);
  if (streakers.length) {
    const pod = el('div', 'card podium-card');
    const ph = el('div', 'card-head');
    ph.append(el('h2', null, 'Streak podium'));
    ph.append(el('span', 'muted', 'longest active streaks'));
    pod.append(ph);
    const stage = el('div', 'podium');
    const metals = ['gold', 'silver', 'bronze'];
    // the classic order: second on the left, first in the center, third on the right
    const displayOrder = [1, 0, 2].filter((i) => i < streakers.length);
    for (const i of displayOrder) {
      const p = streakers[i];
      const slot = el('div', `podium-slot place-${i + 1}`);
      const frame = el('div', 'podium-frame');
      frame.style.backgroundImage = `url('assets/frame-${metals[i]}.svg')`;
      const img = el('img', 'podium-avatar');
      img.src = p.avatar || avatarFallback(p.userId);
      img.alt = '';
      safeAvatar(img, p.userId);
      frame.append(img);
      slot.append(frame);
      slot.append(el('div', 'podium-name', p.displayName));
      const st = el('div', 'podium-streak mono');
      const fl = el('img', 'podium-flame');
      fl.src = 'assets/flame.svg';
      fl.alt = '';
      st.append(fl, `${p.streak}d`);
      slot.append(st);
      slot.append(el('div', 'podium-pedestal'));
      stage.append(slot);
    }
    pod.append(stage);
    root.append(pod);
  }

  // leaderboard by missed day count
  const lb = el('div', 'card');
  const lbHead = el('div', 'card-head');
  lbHead.append(el('h2', null, 'Fewest missed days'));
  lbHead.append(el('span', 'muted', 'the prize ranking'));
  lb.append(lbHead);

  const table = el('table', 'leaderboard');
  const thead = el('thead');
  const hr = el('tr');
  ['#', 'Player', 'Missed', 'Streak', 'This week', 'Today'].forEach((h) => hr.append(el('th', null, h)));
  thead.append(hr);
  table.append(thead);
  const tbody = el('tbody');
  g.players.forEach((pl, i) => {
    const medal = i === 0 ? ' rank-1' : i === 1 ? ' rank-2' : i === 2 ? ' rank-3' : '';
    const tr = el('tr', (pl.userId === state.user.uid ? 'me' : '') + medal);
    tr.append(el('td', 'rank mono', String(i + 1)));
    const nameCell = el('td', 'player');
    const img = el('img');
    img.src = pl.avatar || avatarFallback(pl.userId);
    img.width = 22; img.height = 22; img.alt = '';
    safeAvatar(img, pl.userId);
    nameCell.append(img, el('span', null, pl.displayName));
    tr.append(nameCell);
    tr.append(el('td', 'mono', String(pl.missedDays)));
    tr.append(el('td', 'mono', pl.streak > 0 ? pl.streak + 'd' : '-'));
    tr.append(el('td', 'mono muted', (pl.weekDone != null ? pl.weekDone : 0) + '/7'));
    const t = pl.byDate[today];
    const todayCell = el('td', 'mono');
    if (!(t && t.done) && pl.restToday) {
      todayCell.append(el('span', 'pill is-rest', 'rest'));
    } else {
      todayCell.append(el('span', 'pill ' + cellClass(t), t && t.done ? 'done' : t ? Math.round((t.completedRuns / t.requiredRuns) * 100) + '%' : '-'));
    }
    tr.append(todayCell);
    tbody.append(tr);
  });
  table.append(tbody);
  lb.append(table);
  root.append(lb);

  // month calendar, one row per player
  const cal = el('div', 'card');
  const calHead = el('div', 'card-head');
  calHead.append(el('h2', null, monthName(g.month)));
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
    const h = el('div', 'cal-day-head' + (d === today ? ' is-today' : '') + (isMonday(d) ? ' wk' : ''), String(Number(d.slice(-2))));
    grid.append(h);
  }
  for (const pl of g.players) {
    const restSet = new Set(pl.restDays || []);
    const nameCell = el('div', 'cal-name' + (pl.userId === state.user.uid ? ' me' : ''), pl.displayName);
    grid.append(nameCell);
    for (const d of days) {
      const rec = pl.byDate[d];
      let cls = cellClass(rec, d, today, pl.joinedDate);
      let title = rec ? `${rec.completedRuns}/${rec.requiredRuns}` : 'nothing';
      // a rest day is visible both in the past and as a plan for the future
      if (!(rec && rec.done) && restSet.has(d)) { cls = 'is-rest'; title = 'scheduled rest day'; }
      const cell = el('div', 'cal-cell ' + cls + (isMonday(d) ? ' wk' : ''));
      cell.title = `${pl.displayName}, ${d}: ` + title;
      grid.append(cell);
    }
  }
  cal.append(grid);
  root.append(cal);
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

// ---------- Admin tab ----------

function renderAdmin() {
  const root = $('view-admin');
  root.replaceChildren();

  const card = el('div', 'card');
  card.append(el('h2', null, 'Playlist of the week'));
  card.append(el('p', 'lede', 'Import the playlist JSON from FPSAimTrainer\\Saved\\SaveGames\\Playlists. Scenario names and play counts are read from it, nothing is typed by hand.'));

  const row = el('div', 'admin-row');
  const input = el('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  row.append(input);

  const label = el('input', 'text-input');
  label.type = 'text';
  label.placeholder = 'Week label, e.g. Week 1';
  label.value = (state.playlist && state.playlist.weekLabel) || '';
  row.append(label);

  const save = el('button', 'primary', 'Publish to the group');
  save.disabled = true;
  row.append(save);
  card.append(row);

  const preview = el('div', 'preview');
  card.append(preview);
  const msg = el('p', 'notice');
  msg.hidden = true;
  card.append(msg);

  let parsed = null;

  input.addEventListener('change', async () => {
    const file = input.files[0];
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
      renderPreview(preview, parsed);
      save.disabled = false;
      msg.hidden = true;
    } catch (e) {
      parsed = null;
      save.disabled = true;
      msg.textContent = 'Could not read that file: ' + e.message;
      msg.className = 'notice error';
      msg.hidden = false;
    }
  });

  save.addEventListener('click', async () => {
    if (!parsed) return;
    parsed.weekLabel = label.value.trim() || parsed.weekLabel;
    save.disabled = true;
    try {
      state.playlist = await api.setPlaylist(parsed);
      renderWeekLabel();
      msg.textContent = 'Published. Everyone checks against this list now.';
      msg.className = 'notice ok';
      msg.hidden = false;
      state.lastPostedRuns = -1; // requirements changed, recompute and repost
    } catch (e) {
      msg.textContent = 'Failed: ' + e.message;
      msg.className = 'notice error';
      msg.hidden = false;
      save.disabled = false;
    }
  });

  root.append(card);

  // manual digest: the same text the 18:00 cron sends
  const dig = el('div', 'card');
  dig.append(el('h2', null, 'Discord digest'));
  dig.append(el('p', 'lede', 'Instant completion shouts and the daily 18:00 auto-digest are live. This button posts an extra digest right now, same text the evening one would send.'));
  const dbtn = el('button', 'primary', 'Post digest now');
  const dmsg = el('p', 'notice');
  dmsg.hidden = true;
  dbtn.addEventListener('click', async () => {
    dbtn.disabled = true;
    try {
      await api.postDigest();
      dmsg.textContent = 'Posted. Check the channel.';
      dmsg.className = 'notice ok';
    } catch (e) {
      dmsg.textContent = e.message;
      dmsg.className = 'notice error';
    }
    dmsg.hidden = false;
    dbtn.disabled = false;
  });
  dig.append(dbtn, dmsg);
  root.append(dig);

  if (state.playlist && state.playlist.scenarios) {
    const cur = el('div', 'card');
    const h = el('div', 'card-head');
    h.append(el('h2', null, 'Currently published'));
    h.append(el('span', 'muted mono', `${state.playlist.scenarios.reduce((n, s) => n + s.requiredRuns, 0)} runs`));
    cur.append(h);
    renderPreview(cur, state.playlist);
    root.append(cur);
  }
}

function renderPreview(container, playlist) {
  const old = container.querySelector('.preview-list');
  if (old) old.remove();
  const ul = el('ul', 'checklist preview-list');
  for (const s of playlist.scenarios) {
    const li = el('li');
    li.append(el('span', 'check'));
    li.append(el('span', 'scen-name', s.name));
    li.append(el('span', 'scen-count mono', 'x' + s.requiredRuns));
    ul.append(li);
  }
  container.append(ul);
}

boot();
