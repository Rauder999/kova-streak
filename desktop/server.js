// A loopback static server for the bundled UI.
//
// The window could load the files over file://, and almost everything would
// work until login: the worker whitelists origins both for CORS and for the
// post-OAuth bounce, and file:// has no origin to whitelist. Serving the same
// bundled files from 127.0.0.1 gives the renderer a real origin, so the site's
// auth, API calls and storage behave exactly as they do in the browser and the
// frontend needs no desktop-specific branch. Nothing is exposed off-machine:
// the listener binds to the loopback address only.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Whitelisted in the worker's ALLOWED_ORIGINS. More than one because a fixed
// port is a hostage to whatever else is running; 8080 is deliberately not on
// the list, it is the local dev stand's.
const PORTS = [7384, 7385, 7386];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serve(root, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  // path.resolve collapses any ../ before we compare, so a crafted request
  // cannot climb out of the bundle
  const file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end('no');
    return;
  }
  try {
    const stat = await fsp.stat(file);
    const target = stat.isDirectory() ? path.join(file, 'index.html') : file;
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      // the bundle ships with the app and changes only when the app updates
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
}

// Resolves to the origin the window should load. Tries each port in turn so a
// busy one is a shrug rather than a dead app.
function start(root) {
  const abs = path.resolve(root);
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      serve(abs, req, res).catch(() => res.writeHead(500).end('error'));
    });
    let i = 0;
    const attempt = () => {
      if (i >= PORTS.length) return reject(new Error('every loopback port is taken'));
      const port = PORTS[i++];
      server.once('error', attempt);
      server.listen(port, '127.0.0.1', () => {
        // the retry handler has done its job: leaving it attached would turn a
        // later runtime error into a second listen on a live server
        server.removeListener('error', attempt);
        resolve({ server, origin: `http://127.0.0.1:${port}` });
      });
    };
    attempt();
  });
}

module.exports = { start, PORTS };
