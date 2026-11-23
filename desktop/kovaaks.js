// Finding KovaaK's on the machine, and the handful of its files we touch.
//
// This is the whole reason the desktop build exists. In the browser the player
// has to pick the stats folder by hand, re-grant it after every restart, and
// nothing can tell them when the game has quietly stopped writing to it. Here
// we just go and look: Steam's own registry key, Steam's own library index,
// and the game's own settings file. No picker, no permission, no guessing.
//
// Plain Node, no Electron imports, so it runs under `node` on its own.

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const APP_ID = '824270'; // KovaaK's, confirmed against appmanifest_824270.acf
const GAME_DIR = 'FPSAimTrainer';

// Reading one registry value without a native module. `reg query` prints
//     SteamPath    REG_SZ    c:/program files (x86)/steam
// and exits non-zero when the key is missing, which is an ordinary miss here.
function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i').exec(stdout);
      resolve(m ? m[1].trim() : null);
    });
  });
}

const exists = (p) => fs.access(p).then(() => true, () => false);

// KovaaK's mixes encodings inside one folder: PlaylistInProgress.json is
// UTF-16 LE with a BOM while PrimaryUserSettings.json next to it is plain
// UTF-8, and a playlist is whichever of the two wrote it last (the in-game
// share gives UTF-16, the editor gives UTF-8). Reading any of them as UTF-8
// yields NUL-riddled nonsense that JSON.parse rejects, which is how the
// playlist upload broke in October and how PlaylistInProgress read as missing
// here. Every read of a game file goes through this.
async function readText(p) {
  const b = await fs.readFile(p);
  if (b[0] === 0xFF && b[1] === 0xFE) return { text: b.toString('utf16le', 2), encoding: 'utf16le' };
  if (b[0] === 0xFE && b[1] === 0xFF) {
    const swapped = Buffer.from(b.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be' };
  }
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return { text: b.toString('utf8', 3), encoding: 'utf8bom' };
  return { text: b.toString('utf8'), encoding: 'utf8' };
}

// Writes back in the encoding the file already had, BOM included. A settings
// file rewritten in the wrong encoding is a game that will not start.
async function writeText(p, text, encoding) {
  if (encoding === 'utf16le') {
    await fs.writeFile(p, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]));
    return;
  }
  if (encoding === 'utf16be') {
    const buf = Buffer.from(text, 'utf16le');
    buf.swap16();
    await fs.writeFile(p, Buffer.concat([Buffer.from([0xFE, 0xFF]), buf]));
    return;
  }
  if (encoding === 'utf8bom') {
    await fs.writeFile(p, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]));
    return;
  }
  await fs.writeFile(p, text, 'utf8');
}

const readJson = async (p) => JSON.parse((await readText(p)).text.replace(/^﻿/, ''));

// Steam writes the install path to HKCU on every launch; HKLM is the
// installer's copy and survives a profile that never ran Steam. The literal
// defaults are the last resort, for a registry wiped by a cleaner tool.
async function steamRoots() {
  const found = [
    await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
  ];
  const out = [];
  for (const raw of found) {
    if (!raw) continue;
    const p = path.win32.normalize(raw.replace(/\//g, '\\'));
    if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  }
  return out;
}

// libraryfolders.vdf lists every drive Steam installs to, each with the set of
// app ids living there. We want the library that actually holds 824270 rather
// than the first one on the list: a second drive is the normal setup, and
// guessing wrong is exactly the "it cannot see my folder" bug we are killing.
// The format is Valve's KeyValues; we only need two shapes out of it, so the
// two regexes below beat pulling in a VDF parser.
function parseLibraryFolders(text) {
  const libs = [];
  // every `"path"  "C:\\..."` opens a library block, and the `apps { ... }`
  // block that follows belongs to it until the next path
  const re = /"path"\s*"((?:[^"\\]|\\.)*)"|"apps"\s*\{([^}]*)\}/g;
  let m;
  let current = null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) {
      current = { path: m[1].replace(/\\\\/g, '\\'), apps: new Set() };
      libs.push(current);
    } else if (current && m[2] !== undefined) {
      for (const a of m[2].matchAll(/"(\d+)"\s*"\d+"/g)) current.apps.add(a[1]);
    }
  }
  return libs;
}

// Everything we care about, derived from one game root. The doubled
// FPSAimTrainer is not a typo: the Steam folder holds a folder of the same
// name, and stats live in the inner one.
function layout(gameRoot) {
  const inner = path.join(gameRoot, GAME_DIR);
  // A scenario lives in one of two places, and a playlist can name either:
  // the game's own Scenarios folder (made in the editor, or shared as a file)
  // and the Steam Workshop content for 824270, which is a sibling of the
  // library's `common`. That second one is where the weekly lists actually
  // come from, so both are needed to answer "can this player play this list".
  const library = path.resolve(gameRoot, '..', '..', '..');
  return {
    root: gameRoot,
    stats: path.join(inner, 'stats'),
    playlists: path.join(inner, 'Saved', 'SaveGames', 'Playlists'),
    scenarios: path.join(inner, 'Saved', 'SaveGames', 'Scenarios'),
    workshop: path.join(library, 'steamapps', 'workshop', 'content', APP_ID),
    settings: path.join(inner, 'Saved', 'SaveGames', 'PrimaryUserSettings.json'),
    playlistInProgress: path.join(inner, 'Saved', 'SaveGames', 'PlaylistInProgress.json'),
  };
}

// The search, in order of how much we trust the answer. Returns null only when
// the game is genuinely not on this machine, which is worth saying out loud
// rather than dropping the player into a folder picker that cannot help.
async function findGame() {
  for (const steam of await steamRoots()) {
    const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf');
    let libs = [];
    try {
      libs = parseLibraryFolders(await fs.readFile(vdf, 'utf8'));
    } catch { /* no index on this root, fall through to the direct guess */ }
    const ordered = [
      ...libs.filter((l) => l.apps.has(APP_ID)),
      ...libs.filter((l) => !l.apps.has(APP_ID)),
      { path: steam },
    ];
    for (const lib of ordered) {
      const gameRoot = path.join(lib.path, 'steamapps', 'common', GAME_DIR);
      if (await exists(path.join(gameRoot, GAME_DIR))) return layout(gameRoot);
    }
  }
  return null;
}

// A folder the player picked by hand, kept only for the case findGame fails.
// Accepts either the stats folder itself or the game root, because both are
// what someone reaches for when asked to "find KovaaK's".
async function layoutFromPicked(picked) {
  if (path.basename(picked).toLowerCase() === 'stats') {
    const inner = path.dirname(picked);
    return { ...layout(path.dirname(inner)), stats: picked };
  }
  if (await exists(path.join(picked, GAME_DIR))) return layout(picked);
  return null;
}

// ---------- the files we read ----------

// Names only. The day count never opens a CSV, and the author's folder holds
// 2659 of them, so listing stays cheap enough to run on every file event.
async function listStatsFiles(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.csv')) out.push(e.name);
  }
  return out;
}

const readStatsFile = (dir, name) => fs.readFile(path.join(dir, path.basename(name)), 'utf8');

// StatsExportLevel is the setting whose silent "off" costs people their days:
// the folder stays connected and full of history while the game writes nothing
// new. 0 is off, anything above is on (1 = challenge completion, 2 = always).
// We can both see it and fix it, which the browser never could.
async function readExportLevel(settingsPath) {
  try {
    const { text } = await readText(settingsPath);
    const m = /"EIntegerSettingId::StatsExportLevel"\s*:\s*(\d+)/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Written by hand rather than through JSON.parse/stringify: the file carries
// the game's own key order and formatting, and a round trip would rewrite all
// of it. One number changes, nothing else moves. KovaaK's reads this at
// startup, so it only takes effect on the next launch.
async function setExportLevel(settingsPath, level) {
  const { text, encoding } = await readText(settingsPath);
  const re = /("EIntegerSettingId::StatsExportLevel"\s*:\s*)(\d+)/g;
  if (!re.test(text)) throw new Error('StatsExportLevel is not in the settings file');
  await writeText(settingsPath, text.replace(re, `$1${level}`), encoding);
}

// Which playlist the player actually has loaded. This is the file that proved
// a whole session had been trained on last week's list (2026-11-22), and in
// the app it lets us say so before the session is spent, not after.
async function readPlaylistInProgress(p) {
  try {
    const j = await readJson(p);
    return {
      name: j.playlistName || null,
      shareCode: j.shareCode || null,
      scenarios: (j.scenarioList || []).map((s) => s.scenario_name),
    };
  } catch {
    return null;
  }
}

// ---------- playlists ----------

// The playlists the game has on disk. This is how the admin publishes: he
// builds the list in KovaaK's as usual and the app reads it straight out of
// the game, so the scenario names can never be mistyped and the share code
// can never be the wrong week's.
async function listPlaylists(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    // .bak files are the game's own backups; they are not offerable playlists
    if (!e.isFile() || !/\.json$/i.test(e.name)) continue;
    const full = path.join(dir, e.name);
    try {
      const j = await readJson(full);
      const list = Array.isArray(j.scenarioList) ? j.scenarioList : [];
      if (!list.length) continue;
      out.push({
        file: e.name,
        name: j.playlistName || e.name.replace(/\.json$/i, ''),
        shareCode: j.shareCode || null,
        scenarios: list.length,
        runs: list.reduce((n, s) => n + (Number(s.play_Count) || 1), 0),
        mtime: (await fs.stat(full)).mtimeMs,
      });
    } catch { /* not a playlist, or unreadable: it simply is not on the list */ }
  }
  out.sort((a, b) => b.mtime - a.mtime); // newest first: that is the week he just built
  return out;
}

const readPlaylist = (dir, file) => readJson(path.join(dir, path.basename(file)));

// What matters about a playlist for "is the installed copy the published one":
// the name, the code, the id and the scenarios with their counts. Deliberately
// not the whole object - the game bumps `version` and `updated` on its own, and
// rewriting the file on every launch over that would churn its folder.
const signature = (p) => JSON.stringify([
  p.playlistName || '',
  p.shareCode || '',
  p.playlistId || 0,
  (p.scenarioList || []).map((s) => [s.scenario_name, Number(s.play_Count) || 1]),
]);

// Drop the week's playlist straight into the game. Verified on 2026-11-22 that
// this folder takes a write without elevation, which is what makes "they never
// touch a share code again" possible. The game reads playlists at startup, so
// a running game picks it up on the next launch.
//
// Written as UTF-8 with tab indentation and CRLF line endings because that is
// byte for byte what the game writes itself (verified against its own file):
// the installed copy is indistinguishable from one KovaaK's saved. Real
// newlines only ever come from the serializer here - one inside a scenario
// name is escaped as \n by JSON.stringify - so the line ending swap is safe.
async function installPlaylist(playlistsDir, playlist) {
  const safe = String(playlist.playlistName || 'Playlist')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Playlist';
  const file = path.join(playlistsDir, `${safe}.json`);
  await fs.mkdir(playlistsDir, { recursive: true });
  try {
    if (signature(await readJson(file)) === signature(playlist)) return { file, wrote: false };
  } catch { /* missing, or the game left something unparsable: overwrite it */ }
  await fs.writeFile(file, JSON.stringify(playlist, null, '\t').replace(/\n/g, '\r\n'), 'utf8');
  return { file, wrote: true };
}

// ---------- scenarios ----------

// Every scenario name this machine can actually play. The walk is two folders
// deep at most (workshop items are content\824270\<id>\<Name>.sce), 339 names
// and ~50 ms on the author's machine, cached because the status call is cheap
// to ask for and this is the only expensive part of it.
let scenarioCache = { at: 0, dir: null, names: null };
async function installedScenarios(game, { fresh = false } = {}) {
  if (!fresh && scenarioCache.names && scenarioCache.dir === game.root && Date.now() - scenarioCache.at < 30000) {
    return scenarioCache.names;
  }
  const names = new Set();
  const add = (f) => { if (/\.sce$/i.test(f)) names.add(f.slice(0, -4)); };
  try {
    for (const e of await fs.readdir(game.scenarios, { withFileTypes: true })) if (e.isFile()) add(e.name);
  } catch { /* no local scenarios folder yet */ }
  try {
    for (const d of await fs.readdir(game.workshop, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        for (const e of await fs.readdir(path.join(game.workshop, d.name), { withFileTypes: true })) {
          if (e.isFile()) add(e.name);
        }
      } catch { /* an item mid-download, skip it */ }
    }
  } catch { /* nothing subscribed, or the library moved */ }
  scenarioCache = { at: Date.now(), dir: game.root, names };
  return names;
}

// The scenarios of a playlist this player cannot start. A playlist file can be
// installed in a second, but the scenarios inside it come from the Workshop and
// only the game can subscribe to them, so this is the one part of the setup we
// can detect and explain but not fix. Case-insensitive: the names come from
// Windows filenames.
async function missingScenarios(game, names, opts) {
  const have = await installedScenarios(game, opts);
  // Nothing readable at all means the folders are somewhere we did not look.
  // Reporting every scenario as missing would be a lie with a loud voice.
  if (!have.size) return [];
  const lower = new Set([...have].map((n) => n.toLowerCase()));
  return names.filter((n) => !lower.has(String(n).toLowerCase()));
}

// Is KovaaK's up right now? Only used to word things correctly: a playlist
// installed while the game is running appears after a restart, and the export
// setting is read at startup too.
function gameRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq FPSAimTrainer-Win64-Shipping.exe', '/NH'], { windowsHide: true }, (err, stdout) => {
      resolve(!err && /FPSAimTrainer/i.test(stdout || ''));
    });
  });
}

module.exports = {
  APP_ID,
  findGame,
  layout,
  layoutFromPicked,
  parseLibraryFolders,
  steamRoots,
  readText,
  readJson,
  listStatsFiles,
  readStatsFile,
  readExportLevel,
  setExportLevel,
  readPlaylistInProgress,
  listPlaylists,
  readPlaylist,
  installPlaylist,
  installedScenarios,
  missingScenarios,
  gameRunning,
  signature,
};
