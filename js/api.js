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
