// The only bridge between the page and the machine.
//
// Everything here is a named, argument-free-or-primitive call into the main
// process: the renderer never gets a path, a handle or a module, so a bug in
// the UI cannot turn into an arbitrary file read. js/fs.js picks this up as
// window.kova and uses it instead of the File System Access API; when it is
// absent (the site in a browser) the old path runs unchanged.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kova', {
  desktop: true,

  // { found, stats, exportLevel, playlistInProgress } - everything the UI
  // needs to explain itself on first paint, in one round trip
  status: () => ipcRenderer.invoke('kova:status'),

  // the fallback for a machine where the game is not where Steam says
  pickGameFolder: () => ipcRenderer.invoke('kova:pick-folder'),

  // file names only; the day count never opens a CSV
  listStatsFiles: () => ipcRenderer.invoke('kova:list-stats'),
  readStatsFile: (name) => ipcRenderer.invoke('kova:read-stats', name),

  // turn Statistics Export back on, the silent failure that costs people days
  fixExport: () => ipcRenderer.invoke('kova:fix-export'),

  // drop the week's playlist into the game so nobody types a share code again
  // -> { ok, file, wrote, running, missing: [scenario names] }
  installPlaylist: (playlist) => ipcRenderer.invoke('kova:install-playlist', playlist),

  // the game's own playlists, for publishing a week straight out of KovaaK's
  listPlaylists: () => ipcRenderer.invoke('kova:playlists'),
  readPlaylist: (file) => ipcRenderer.invoke('kova:read-playlist', file),

  // which of these scenarios this PC cannot play (not subscribed on Workshop)
  checkScenarios: (names) => ipcRenderer.invoke('kova:check-scenarios', names),

  // fires when KovaaK's writes a new stats file: no polling, no browser
  // throttling, and it works while the window is hidden in the tray
  onStatsChange: (fn) => {
    const h = () => fn();
    ipcRenderer.on('kova:stats-changed', h);
    return () => ipcRenderer.removeListener('kova:stats-changed', h);
  },

  appVersion: () => ipcRenderer.invoke('kova:version'),
});
