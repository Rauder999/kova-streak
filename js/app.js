// KOVA STREAK: состояние, поллинг папки stats, автоотметка, рендер.

import { initAuth, currentUser, login, logout, authError } from './auth.js';
import * as api from './api.js';
import { localDate, localMonth } from './parser.js';
import {
  fsSupported, pickStatsFolder, getStoredFolder, forgetFolder,
  ensurePermission, countRunsForDate, matchPlaylist,
} from './fs.js';

// Стандартный путь стима; у друзей библиотека может жить на другом диске
const DEFAULT_STATS_PATH = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats';

const POLL_MS = 5000;          // как часто перечитываем листинг папки
const POST_DEBOUNCE_MS = 60000; // не чаще раза в минуту шлем частичный прогресс
const GROUP_REFRESH_MS = 60000;

// state и renderToday экспортируются, чтобы фронт можно было прогнать из
// консоли на подставном прогрессе, не подключая папку stats.
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
  streak: null,
  group: null,
  tab: 'today',
  scanError: null,
};

let pollTimer = null;
let groupTimer = null;
let fsObserver = null;
let lastTickAt = 0;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------- запуск ----------

async function boot() {
  $('login-btn').addEventListener('click', login);
  $('logout-btn').addEventListener('click', () => { logout(); location.reload(); });
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  // вернулся в окно после игры: пересканировать немедленно, не ждать таймер
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pollTimer) tick(); });
  window.addEventListener('focus', () => { if (pollTimer) tick(); });

  const err = authError();
  if (err) {
    const box = $('login-error');
    box.textContent = err === 'not_in_guild'
      ? 'That Discord account is not in the group server.'
      : 'Sign-in failed: ' + err;
    box.hidden = false;
  }

  state.user = initAuth();
  if (!state.user) return showView('login');

  $('user-name').textContent = state.user.name;
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

  state.handle = await getStoredFolder();
  if (state.handle) state.granted = await ensurePermission(state.handle);

  switchTab('today');
  refreshGroup();
  if (state.granted) startPolling();
}

function avatarFallback(uid) {
  const i = (BigInt(uid || '0') >> 22n) % 6n;
  return `https://cdn.discordapp.com/embed/avatars/${i}.png`;
}

// ---------- вкладки ----------

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  showView(tab);
  if (tab === 'today') renderToday();
  if (tab === 'group') { renderGroup(); refreshGroup(); }
  if (tab === 'admin') renderAdmin();
}

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
}

function renderWeekLabel() {
  $('week-label').textContent = state.playlist && state.playlist.weekLabel ? state.playlist.weekLabel : '';
}

// ---------- поллинг папки ----------

function startPolling() {
  if (pollTimer) return;
  $('scan-state').hidden = false;
  tick();
  // Поллинг это запасной механизм: в фоне Chrome душит таймеры до раза в
  // минуту, поэтому основную скорость дают observer и focus/visibility ниже.
  pollTimer = setInterval(tick, POLL_MS);
  startObserver();
}

// Нативный наблюдатель за папкой: реагирует на новый CSV сразу, даже когда
// вкладка спрятана за игрой. Есть не во всех браузерах, поэтому только
// как ускоритель поверх поллинга.
async function startObserver() {
  if (fsObserver || !('FileSystemObserver' in window)) return;
  try {
    fsObserver = new FileSystemObserver(() => tick());
    await fsObserver.observe(state.handle);
  } catch {
    fsObserver = null; // не дался, остается поллинг
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
  // observer, focus и интервал могут выстрелить пачкой, скан чаще раза в
  // секунду смысла не имеет
  if (Date.now() - lastTickAt < 1000) return;
  lastTickAt = Date.now();

  // полуночный переход: новый день, счетчики с нуля
  const today = localDate();
  if (today !== state.date) {
    state.date = today;
    state.lastPostedRuns = -1;
    state.lastPostAt = 0;
  }

  try {
    if (!(await ensurePermission(state.handle))) {
      state.granted = false;
      state.scanError = 'Folder access expired, click to grant it again.';
      stopPolling();
      if (state.tab === 'today') renderToday();
      return;
    }

    const { counts, scanned } = await countRunsForDate(state.handle, state.date);
    state.progress = matchPlaylist(state.playlist.scenarios, counts);
    state.progress.scanned = scanned;
    state.scanError = null;
    $('scan-text').textContent = state.progress.done
      ? 'today is done'
      : `${state.progress.completedRuns} / ${state.progress.requiredRuns} runs`;
  } catch (e) {
    state.scanError = 'Scan failed: ' + e.message;
  }

  if (state.tab === 'today') renderToday();
  maybePost();
}

// Отправляем прогресс, когда он изменился. Полное выполнение шлем немедленно,
// частичное не чаще раза в минуту, чтобы не жечь записи в KV.
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
    state.scanError = 'Could not save progress: ' + e.message;
  } finally {
    state.posting = false;
  }
}

// ---------- вкладка Today ----------

async function connectFolder() {
  try {
    state.handle = await pickStatsFolder();
    state.granted = await ensurePermission(state.handle, { request: true });
  } catch (e) {
    if (e.name !== 'AbortError') state.scanError = e.message;
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
    root.append(notice('This browser cannot read local folders. Use desktop Chrome or Edge.'));
    return;
  }
  if (!state.playlist || !state.playlist.scenarios || !state.playlist.scenarios.length) {
    // настоящая причина (бэкенд лег) важнее, чем "плейлиста не задана"
    root.append(notice(state.scanError || 'No playlist is set for this week yet. Rauder has to import it in Admin.',
      state.scanError ? 'error' : ''));
    return;
  }

  if (!state.granted) {
    const gate = el('div', 'card gate-card');
    if (state.handle) {
      // папка уже выбрана раньше, нужен только клик по разрешению
      gate.append(el('h2', null, 'Grant folder access'));
      gate.append(el('p', 'lede', 'The folder is remembered. In the browser prompt pick "Allow on every visit" and even this click disappears: next time the page will just start watching on its own.'));
      const btn = el('button', 'primary big', 'Grant access');
      btn.addEventListener('click', regrant);
      gate.append(btn);
      const forget = el('button', 'ghost', 'Pick a different folder');
      forget.addEventListener('click', async () => { await forgetFolder(); state.handle = null; renderToday(); });
      gate.append(forget);
    } else {
      // первый раз: браузер требует выбрать папку руками, но путь можно
      // вставить в диалог целиком, без блужданий по Program Files
      gate.append(el('h2', null, 'Connect your stats folder'));
      gate.append(el('p', 'lede', 'One-time setup. Copy the path, press the button, paste it into the folder field of the picker and hit Select Folder.'));
      const row = el('div', 'path-row');
      const code = el('code', 'mono path-text', DEFAULT_STATS_PATH);
      const copy = el('button', null, 'Copy path');
      copy.addEventListener('click', async () => {
        const ok = await copyText(DEFAULT_STATS_PATH);
        if (ok) {
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy path'; }, 1500);
        } else {
          // оба механизма копирования зарезаны: выделяем путь, юзеру остается Ctrl+C
          const range = document.createRange();
          range.selectNodeContents(code);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          copy.textContent = 'Press Ctrl+C';
        }
      });
      row.append(code, copy);
      gate.append(row);
      const btn = el('button', 'primary big', 'Choose stats folder');
      btn.addEventListener('click', connectFolder);
      gate.append(btn);
      gate.append(el('p', 'fine', 'Steam on another drive? Find steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats there. The folder is remembered afterwards.'));
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

  // шапка: кольцо прогресса + стрик
  const top = el('div', 'today-top');
  top.append(progressRing(p));

  const stats = el('div', 'today-stats');
  stats.append(statBlock(p.done ? 'Done' : 'In progress', `${p.completedRuns} / ${p.requiredRuns} runs`,
    p.done ? 'checked in for today, automatically' : `${p.items.filter((i) => i.done).length} of ${p.items.length} scenarios finished`));
  if (state.streak) {
    stats.append(statBlock('Streak', `${state.streak.streak} ${state.streak.streak === 1 ? 'day' : 'days'}`, 'consecutive days completed'));
    stats.append(statBlock('Missed this month', String(state.streak.missedDays), 'this is what the ranking uses'));
  }
  top.append(stats);
  root.append(top);

  if (state.scanError) root.append(notice(state.scanError, 'error'));

  // чеклист сценариев
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('h2', null, 'What is left to play'));
  head.append(el('span', 'muted mono', state.date));
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

// Клипборд с фолбэком: clipboard API может быть запрещен политикой,
// execCommand старый, но не требует разрешений.
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
    try { ok = document.execCommand('copy'); } catch { /* остается ручное выделение */ }
    ta.remove();
    return ok;
  }
}

// ---------- вкладка Group ----------

async function refreshGroup() {
  try {
    state.group = await api.getGroup(localMonth());
    // свой стрик и пропуски берем отсюда, чтобы они были на экране Today
    // сразу после логина, а не только после первой отправки прогресса
    const me = state.group.players.find((p) => p.userId === state.user.uid);
    if (me) state.streak = { streak: me.streak, missedDays: me.missedDays };
    if (state.tab === 'group') renderGroup();
    if (state.tab === 'today') renderToday();
  } catch (e) {
    state.scanError = e.message;
  }
  clearTimeout(groupTimer);
  groupTimer = setTimeout(refreshGroup, GROUP_REFRESH_MS);
}

function renderGroup() {
  const root = $('view-group');
  root.replaceChildren();

  const g = state.group;
  if (!g) { root.append(notice('Loading the group...')); return; }

  const today = localDate();
  const days = g.days;

  // лидерборд по количеству пропусков
  const lb = el('div', 'card');
  const lbHead = el('div', 'card-head');
  lbHead.append(el('h2', null, 'Fewest missed days'));
  lbHead.append(el('span', 'muted', monthName(g.month)));
  lb.append(lbHead);

  const table = el('table', 'leaderboard');
  const thead = el('thead');
  const hr = el('tr');
  ['#', 'Player', 'Missed', 'Streak', 'Today'].forEach((h) => hr.append(el('th', null, h)));
  thead.append(hr);
  table.append(thead);
  const tbody = el('tbody');
  g.players.forEach((pl, i) => {
    const tr = el('tr', pl.userId === state.user.uid ? 'me' : '');
    tr.append(el('td', 'rank mono', String(i + 1)));
    const nameCell = el('td', 'player');
    const img = el('img');
    img.src = pl.avatar || avatarFallback(pl.userId);
    img.width = 22; img.height = 22; img.alt = '';
    nameCell.append(img, el('span', null, pl.displayName));
    tr.append(nameCell);
    tr.append(el('td', 'mono', String(pl.missedDays)));
    tr.append(el('td', 'mono', String(pl.streak)));
    const t = pl.byDate[today];
    const todayCell = el('td', 'mono');
    todayCell.append(el('span', 'pill ' + cellClass(t), t && t.done ? 'done' : t ? Math.round((t.completedRuns / t.requiredRuns) * 100) + '%' : '-'));
    tr.append(todayCell);
    tbody.append(tr);
  });
  table.append(tbody);
  lb.append(table);
  root.append(lb);

  // календарь месяца, строка на участника
  const cal = el('div', 'card');
  const calHead = el('div', 'card-head');
  calHead.append(el('h2', null, 'The month'));
  calHead.append(el('span', 'muted', 'green means the day was completed'));
  cal.append(calHead);

  const grid = el('div', 'calendar');
  grid.style.setProperty('--days', String(days.length));

  grid.append(el('div', 'cal-corner'));
  for (const d of days) {
    const h = el('div', 'cal-day-head' + (d === today ? ' is-today' : ''), String(Number(d.slice(-2))));
    grid.append(h);
  }
  for (const pl of g.players) {
    const nameCell = el('div', 'cal-name' + (pl.userId === state.user.uid ? ' me' : ''), pl.displayName);
    grid.append(nameCell);
    for (const d of days) {
      const rec = pl.byDate[d];
      const cell = el('div', 'cal-cell ' + cellClass(rec, d, today, pl.joinedDate));
      cell.title = `${pl.displayName}, ${d}: ` + (rec ? `${rec.completedRuns}/${rec.requiredRuns}` : 'nothing');
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

// ---------- вкладка Admin ----------

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
      state.lastPostedRuns = -1; // требования сменились, пересчитать и переотправить
    } catch (e) {
      msg.textContent = 'Failed: ' + e.message;
      msg.className = 'notice error';
      msg.hidden = false;
      save.disabled = false;
    }
  });

  root.append(card);

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
