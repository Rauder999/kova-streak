// Copies the site's own files into desktop/renderer so the app ships the UI
// it was built from. Deliberately a plain copy rather than a bundler or a
// symlink into ../: the packaged app must carry its own frozen copy, and the
// one thing worse than a stale build is a build nobody can explain.
//
// Run it before `npm start` and before `npm run dist`; both scripts do.

import { cp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const out = path.join(here, 'renderer');

// Everything the page loads, and nothing else: the worker, the docs, the
// design briefs and the local dev stand have no business in the installer.
const ITEMS = ['index.html', 'js', 'css', 'assets'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const item of ITEMS) {
  await cp(path.join(site, item), path.join(out, item), { recursive: true });
}
console.log(`renderer synced: ${ITEMS.join(', ')}`);
