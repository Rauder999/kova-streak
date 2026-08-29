// Parsing KovaaK's stats file names. We do not need the CSV contents:
// the file name already carries both the scenario and the run finish time.
//
// Format confirmed on 1755 real files from the stats folder:
//   {Scenario} - Challenge - YYYY.MM.DD-HH.MM.SS Stats.csv
// The timestamp is the MOMENT THE RUN FINISHED (verified: the 20.18.33 file
// contains Challenge Start 20:17:31.871), so a run is credited to the day
// the player closed it out. Time is local, no conversion needed.

const FILENAME_RE = /^(.*) - Challenge - (\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}) Stats\.csv$/;

// The ' - Challenge - ' anchor separates the scenario name in full, so a
// scenario whose name is a prefix of another gives no false matches.
export function parseStatsFileName(fileName) {
  const m = FILENAME_RE.exec(fileName);
  if (!m) return null;
  return {
    scenario: m[1],
    date: `${m[2]}-${m[3]}-${m[4]}`,
    time: `${m[5]}:${m[6]}:${m[7]}`,
  };
}

export function isStatsFile(fileName) {
  return FILENAME_RE.test(fileName);
}

// Local date as YYYY-MM-DD. Always local, not UTC:
// the player's day is their calendar day, not Greenwich's.
export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localMonth(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// ---------- CSV content parsing (for personal stats) ----------
// File format: kill table, per-weapon summary, key-value summary, settings.
// The parser is adapted from AimSama but stores run metrics, not raw kills:
// on 1800+ history files that is the difference between megabytes and kilobytes.

function toNum(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(/s$/, '');
  if (t === '' || !/^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(t)) return null;
  return parseFloat(t);
}

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function parseRunContent(fileName, text) {
  const meta = parseStatsFileName(fileName);
  if (!meta) throw new Error('not a stats file: ' + fileName);

  const lines = text.split(/\r?\n/);
  const kills = [];
  const weapons = [];
  const kv = {};
  let section = 'start';
  let killCols = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === '') continue;
    if (line.startsWith('Kill #,')) { section = 'kills'; killCols = line.split(','); continue; }
    if (line.startsWith('Weapon,')) { section = 'weapons'; continue; }
    const kvIdx = line.indexOf(':,');
    if (kvIdx > 0 && section !== 'kills') {
      kv[line.slice(0, kvIdx).trim()] = line.slice(kvIdx + 2).trim();
      section = 'kv';
      continue;
    }
    if (section === 'kills') {
      const parts = line.split(',');
      if (!killCols || parts.length < killCols.length) continue;
      // a bot name with a comma shifts the columns; glue the extras into the Bot field
      const extra = parts.length - killCols.length;
      const fixed = extra > 0
        ? [...parts.slice(0, 2), parts.slice(2, 3 + extra).join(','), ...parts.slice(3 + extra)]
        : parts;
      kills.push({ ttk: toNum(fixed[4]), shots: toNum(fixed[5]), hits: toNum(fixed[6]) });
      continue;
    }
    if (section === 'weapons') {
      const parts = line.split(',');
      if (parts.length >= 3 && parts[0]) weapons.push({ shots: toNum(parts[1]) || 0, hits: toNum(parts[2]) || 0 });
    }
  }

  const shots = weapons.reduce((s, w) => s + w.shots, 0);
  const hits = weapons.reduce((s, w) => s + w.hits, 0);
  const ttks = kills.map((k) => k.ttk).filter((t) => t != null && t > 0.05);
  const instantKills = kills.filter((k) => k.ttk != null && k.ttk <= 0.05).length;

  // run type is determined from the data, not the name: tracking with
  // immortal bots has no kills, clicking has near-zero TTKs
  let type = 'unknown';
  const ttkMed = median(ttks);
  if (kills.length === 0 && shots > 50) type = 'tracking';
  else if (kills.length > 0 && instantKills / kills.length > 0.5) type = 'clicking';
  else if (kills.length > 0 && ttkMed != null && ttkMed > 2) type = 'tracking';
  else if (kills.length > 0) type = 'switching';

  // accuracy dynamics: first vs second half of kills (tensing up / fatigue)
  let accDrop = null;
  const withShots = kills.filter((k) => k.shots > 0);
  if (withShots.length >= 6) {
    const half = Math.floor(withShots.length / 2);
    const sum = (list, f) => list.reduce((s, k) => s + f(k), 0);
    const a = withShots.slice(0, half);
    const b = withShots.slice(half);
    const accA = sum(a, (k) => k.hits) / Math.max(1, sum(a, (k) => k.shots));
    const accB = sum(b, (k) => k.hits) / Math.max(1, sum(b, (k) => k.shots));
    accDrop = accB - accA; // negative = worse toward the end of the run
  }

  // chokes: kills the player got stuck on (TTK three times the run's own median)
  const ttkTail = ttks.length >= 8 && ttkMed > 0
    ? ttks.filter((t) => t > ttkMed * 3).length / ttks.length
    : null;

  return {
    fileName,
    scenario: (kv['Scenario'] || meta.scenario).trim(),
    date: meta.date,
    dateTime: `${meta.date}T${meta.time}`,
    type,
    score: toNum(kv['Score']),
    kills: kills.length,
    shots,
    hits,
    accuracy: shots > 0 ? hits / shots : null,
    ttkMed,
    ttkTail,
    accDrop,
    totalOvershots: toNum(kv['Total Overshots']),
    pauseCount: toNum(kv['Pause Count']),
  };
}
