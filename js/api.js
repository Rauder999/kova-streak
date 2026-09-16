// Backend client (Cloudflare Worker + KV).

// Worker address. Overridable via localStorage['kova-streak-api'] to run
// the frontend against `wrangler dev` or a mock before deploy.
export const API_BASE =
  localStorage.getItem('kova-streak-api') || 'https://kova-streak-api.codebreakerstf.workers.dev';

let sessionToken = null;

export function setToken(t) {
  sessionToken = t;
}

export function getToken() {
  return sessionToken;
}

async function call(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (sessionToken) headers['Authorization'] = 'Bearer ' + sessionToken;

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${method} ${path}: ${res.status}, response is not JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${method} ${path}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const loginUrl = () => `${API_BASE}/auth/login?redirect=${encodeURIComponent(location.origin + location.pathname)}`;

export const getMe = () => call('/api/me');
export const getPlaylist = () => call('/api/playlist');
export const getPrevPlaylist = () => call('/api/playlist/prev');
export const setPlaylist = (playlist) => call('/api/playlist', { method: 'PUT', body: playlist });
export const getGroup = (month) => call(`/api/group?month=${encodeURIComponent(month)}`);

export const postCompletion = (payload) => call('/api/completion', { method: 'POST', body: payload });
export const postScores = (bests) => call('/api/scores', { method: 'POST', body: { bests } });
export const postDigest = () => call('/api/digest', { method: 'POST' });
export const postCoach = (payload) => call('/api/coach', { method: 'POST', body: payload });
export const getRest = () => call('/api/rest');
export const postRest = (date, on) => call('/api/rest', { method: 'POST', body: { date, on } });

export const getChains = () => call('/api/chains');
export const getRoster = () => call('/api/admin/roster');
export const reinstate = (userId) => call('/api/admin/reinstate', { method: 'POST', body: { userId } });
export const runRosterSweep = () => call('/api/admin/roster-sweep', { method: 'POST' });
export const runShieldSweep = () => call('/api/admin/shield-sweep', { method: 'POST' });
export const getTrial = () => call('/api/trial');
// report: { best, runs, days } from before the window, { windowBest, windowRuns } inside it
export const postTrialBaseline = (windowId, report) => call('/api/trial/baseline', { method: 'POST', body: { windowId, ...report } });
export const setTrial = (body) => call('/api/admin/trial', { method: 'POST', body });
// The Gate: the push-your-luck sink for links (THE_GATE.md)
export const getGate = () => call('/api/gate');
export const gateEnter = () => call('/api/gate/enter', { method: 'POST', body: {} });
// door: which passage of the rank's rim; floor: the rank the client thinks
// it is on, so a stale tab cannot resolve the same rank twice
export const gateDescend = (door, floor) => call('/api/gate/descend', { method: 'POST', body: { door, floor } });
export const gateExtract = () => call('/api/gate/extract', { method: 'POST' });
export const setGate = (body) => call('/api/admin/gate', { method: 'POST', body });

export const getAdminRest = () => call('/api/admin/rest');
// body: { userId, on, and one of date | dates | from+to }
export const setAdminRest = (body) => call('/api/admin/rest', { method: 'POST', body });
export const resolveTrialNow = () => call('/api/admin/resolve-trial', { method: 'POST' });
export const getVault = () => call('/api/vault');
export const buyVault = (item) => call('/api/vault', { method: 'POST', body: { item } });
