// File System Access API: stats folder access and counting today's runs.
//
// CSV contents are never read at all, only file names from the folder listing.
// That keeps the scan cheap (the author's folder has 1755 files), so it can
// run every few seconds to keep the progress creeping along live.

import { parseStatsFileName, parseRunContent, isStatsFile } from './parser.js';
import { kvGet, kvSet, kvDel, putParsedRuns, getParsedFileNames } from './db.js';

const HANDLE_KEY = 'statsDirHandle';

export function fsSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

export async function pickStatsFolder() {
  const handle = await window.showDirectoryPicker({ id: 'kovaaks-stats', mode: 'read' });
  await kvSet(HANDLE_KEY, handle);
  return handle;
}

export async function getStoredFolder() {
  try {
    return (await kvGet(HANDLE_KEY)) || null;
  } catch {
    return null;
  }
}

export async function forgetFolder() {
  await kvDel(HANDLE_KEY);
}

// The handle survives the tab being closed, but the permission does not.
// queryPermission without a user gesture returns 'prompt', requestPermission
// requires a click, so it is only called from a button handler.
export async function ensurePermission(handle, { request = false } = {}) {
  if (!handle) return false;
  let state = await handle.queryPermission({ mode: 'read' });
  if (state === 'granted') return true;
  if (request) {
    state = await handle.requestPermission({ mode: 'read' });
    return state === 'granted';
  }
  return false;
}

// The first hours after midnight, when night runs can still close out
// yesterday's day (a session that rolled over past midnight).
export const GRACE_HOURS = 2;

// One pass over the folder, three buckets: yesterday's runs, today's night
// runs (the first GRACE_HOURS hours) and the rest of today's.
export async function countRunsAroundMidnight(handle, today, prevDate) {
  const prev = new Map();
  const grace = new Map();
  const cur = new Map();
  let scanned = 0;
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file') continue;
    const name = entry.name;
    if (!name.endsWith('.csv')) continue;
    scanned++;
    const parsed = parseStatsFileName(name);
    if (!parsed) continue;
    if (parsed.date === prevDate) bump(prev, parsed.scenario);
    else if (parsed.date === today) {
      bump(Number(parsed.time.slice(0, 2)) < GRACE_HOURS ? grace : cur, parsed.scenario);
    }
  }
  return { prev, grace, cur, scanned };
}

// Grace window (per Pasha's request, 2026-08-28): if yesterday was STARTED
// but not closed, night runs (before GRACE_HOURS) are counted toward
// yesterday, not today: a session that crawled past midnight closes its own
// day. If yesterday is closed or never started, night runs belong to today.
// Pure function, tested in node without a browser.
export function applyGraceWindow(scenarios, prev, grace, cur) {
  const merge = (a, b) => {
    const m = new Map(a);
    for (const [k, v] of b) m.set(k, (m.get(k) || 0) + v);
    return m;
  };
  const prevAlone = matchPlaylist(scenarios, prev);
  if (!prevAlone.done && prevAlone.completedRuns > 0 && grace.size) {
    return {
      prevProgress: matchPlaylist(scenarios, merge(prev, grace)),
      todayProgress: matchPlaylist(scenarios, cur),
      graceUsed: [...grace.values()].reduce((a, b) => a + b, 0),
    };
  }
  return {
    prevProgress: prevAlone,
    todayProgress: matchPlaylist(scenarios, merge(cur, grace)),
    graceUsed: 0,
  };
}

// Content indexing: parses not-yet-parsed CSVs into compact metrics and
// stores them in IndexedDB. Incremental: after the first pass over history,
// every call touches only new files. Returns the number added.
let indexing = false;
export async function indexRunContents(handle, onProgress = () => {}) {
  if (indexing) return { added: 0, busy: true };
  indexing = true;
  try {
    const known = await getParsedFileNames();
    const fresh = [];
    for await (const entry of handle.values()) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.csv')) continue;
      if (!isStatsFile(entry.name) || known.has(entry.name)) continue;
      fresh.push(entry);
    }
    let done = 0;
    const batch = [];
    for (const entry of fresh) {
      try {
        const file = await entry.getFile();
        const text = await file.text();
        batch.push(parseRunContent(entry.name, text));
      } catch { /* skip the corrupt file, we'll try it another time, no we won't */ }
      done++;
      if (batch.length >= 100) await putParsedRuns(batch.splice(0));
      if (done % 50 === 0 || done === fresh.length) onProgress({ done, total: fresh.length });
    }
    if (batch.length) await putParsedRuns(batch);
    return { added: done };
  } finally {
    indexing = false;
  }
}

// Matches today's runs against the playlist requirements.
// scenarios: [{ name, requiredRuns }]
export function matchPlaylist(scenarios, counts) {
  const items = scenarios.map((s) => {
    const played = counts.get(s.name) || 0;
    return {
      name: s.name,
      required: s.requiredRuns,
      played,
      // credit no more than required, extra runs do not count toward the percent
      credited: Math.min(played, s.requiredRuns),
      done: played >= s.requiredRuns,
    };
  });
  const requiredRuns = items.reduce((n, i) => n + i.required, 0);
  const completedRuns = items.reduce((n, i) => n + i.credited, 0);
  return {
    items,
    requiredRuns,
    completedRuns,
    percent: requiredRuns > 0 ? completedRuns / requiredRuns : 0,
    done: requiredRuns > 0 && completedRuns >= requiredRuns,
  };
}
