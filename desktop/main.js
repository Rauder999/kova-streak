// Kova Streak desktop shell.
//
// The job here is to make the tracker stop being something the player has to
// operate. It finds KovaaK's by itself, watches the stats folder natively,
// lives in the tray, starts with Windows and updates without asking. The UI is
// the site's own files, served from loopback (see server.js), so there is one
// frontend, not two.

const { app, BrowserWindow, Tray, Menu, dialog, shell, ipcMain, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { autoUpdater } = require('electron-updater');

const kovaaks = require('./kovaaks');
const staticServer = require('./server');

const RENDERER = path.join(__dirname, 'renderer');
const ICON = path.join(__dirname, 'build', 'icon.ico');

// The hops the Discord login makes before it lands back on our own origin.
const AUTH_HOSTS = ['kova-streak-api.codebreakerstf.workers.dev', 'discord.com'];

// Identify as the Chrome this is built on, not as Electron. Discord's login
// page turns embedded browsers away, and the default string announces exactly
// that; dropping the two Electron tokens leaves a genuine Chrome UA.
app.userAgentFallback = app.userAgentFallback
  .replace(/ Electron\/[\d.]+/, '')
  .replace(new RegExp(` ${app.getName()}\\/[\\d.]+`), '');

let win = null;
let tray = null;
let origin = null;
let game = null;        // the resolved KovaaK's layout, or null
let watcher = null;
let quitting = false;

// Second launch just raises the first window. Two copies would both scan the
// folder and both post the day, which is how a count ends up racing itself.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

// ---------- the game ----------

async function locateGame(picked) {
  game = picked ? await kovaaks.layoutFromPicked(picked) : await kovaaks.findGame();
  startWatching();
  return game;
}

// A native watcher on the stats folder. The browser build polls every few
// seconds and gets throttled to once a minute behind the game; this fires on
// the write itself. Debounced because KovaaK's touches the file more than once
// as it finishes writing.
function startWatching() {
  if (watcher) { watcher.close(); watcher = null; }
  if (!game) return;
  let timer = null;
  try {
    watcher = fs.watch(game.stats, { persistent: false }, (_e, name) => {
      if (name && !String(name).endsWith('.csv')) return;
      clearTimeout(timer);
      timer = setTimeout(() => win && win.webContents.send('kova:stats-changed'), 400);
    });
  } catch {
    watcher = null; // the folder went away; status will say so
  }
}

// ---------- the bridge ----------

ipcMain.handle('kova:status', async () => {
  if (!game) await locateGame();
  if (!game) return { found: false };
  return {
    found: true,
    root: game.root,
    stats: game.stats,
    // 0 means KovaaK's is writing nothing: the failure that looks exactly
    // like a rest day until someone works out why
    exportLevel: await kovaaks.readExportLevel(game.settings),
    playlistInProgress: await kovaaks.readPlaylistInProgress(game.playlistInProgress),
  };
});

ipcMain.handle('kova:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Find your KovaaK\'s folder',
    properties: ['openDirectory'],
    message: 'Pick the FPSAimTrainer folder, or its stats folder.',
  });
  if (r.canceled || !r.filePaths.length) return { found: false, canceled: true };
  await locateGame(r.filePaths[0]);
  return game ? { found: true, stats: game.stats } : { found: false };
});

ipcMain.handle('kova:list-stats', async () => (game ? kovaaks.listStatsFiles(game.stats) : []));
ipcMain.handle('kova:read-stats', async (_e, name) => (game ? kovaaks.readStatsFile(game.stats, name) : null));

ipcMain.handle('kova:fix-export', async () => {
  if (!game) return { ok: false };
  try {
    await kovaaks.setExportLevel(game.settings, 2); // 2 = always
    return { ok: true, restartNeeded: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('kova:install-playlist', async (_e, playlist) => {
  if (!game) return { ok: false };
  try {
    return { ok: true, file: await kovaaks.installPlaylist(game.playlists, playlist) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('kova:version', () => app.getVersion());

// ---------- window and tray ----------

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(startHidden) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    show: false,
    backgroundColor: '#0a0a0c',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the preload needs require(); the bridge stays narrow
    },
  });

  win.loadURL(origin);
  if (!startHidden) win.once('ready-to-show', () => win.show());

  // Closing the window parks the app in the tray instead of quitting: the
  // whole point is that it keeps counting while the player is in the game.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  // Login has to happen IN here. The worker hands the session token back as a
  // URL fragment on our own origin, so a flow that detoured through the
  // player's real browser would leave the token in that browser's storage and
  // the app still signed out. Our origin plus the two hosts the OAuth hop
  // passes through stay inside the window; everything else is a real link and
  // belongs in the real browser.
  const inApp = (url) => {
    if (url.startsWith(origin)) return true;
    try {
      return AUTH_HOSTS.includes(new URL(url).host);
    } catch {
      return false;
    }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (inApp(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (inApp(url)) return;
    e.preventDefault();
    shell.openExternal(url);
  });
}

function createTray() {
  const img = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('Kova Streak');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Kova Streak', click: showWindow },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// ---------- updates ----------

// Silent by design (per Rauder, 2026-11-22: "no 'press to update' popups").
// electron-updater downloads in the background and installs on quit, so the
// player simply has the new version next time. Checked at startup and every
// six hours for the machines that never close the app.
function startUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => { /* offline or rate limited: try again later */ });
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

// ---------- boot ----------

app.whenReady().then(async () => {
  // First run installs the autostart entry: the app is only useful when it is
  // already running, and asking people to remember to launch it is the habit
  // we are removing. Packaged builds only - in development the path would
  // point at electron.exe and leave a broken entry in the player's startup.
  if (app.isPackaged && !app.getLoginItemSettings().openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  }

  ({ origin } = await staticServer.start(RENDERER));
  await locateGame();
  createWindow(process.argv.includes('--hidden'));
  createTray();
  startUpdates();
});

// Tray app: closing every window is not a reason to exit.
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; });
