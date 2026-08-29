// Discord session. The worker issues a signed token and returns it in the
// URL fragment (#token=...), the fragment never reaches server logs.
// The worker verifies the signature, the frontend only reads the payload.

import { setToken, loginUrl } from './api.js';

const STORAGE_KEY = 'kova-streak-token';

function decodePayload(token) {
  try {
    const part = token.split('.')[0];
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return null;
  }
}

let user = null;

export function initAuth() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromUrl = hash.get('token');
  if (fromUrl) {
    localStorage.setItem(STORAGE_KEY, fromUrl);
    // clean up the address bar so the token does not live on in history and bookmarks
    history.replaceState(null, '', location.pathname + location.search);
  }

  const token = localStorage.getItem(STORAGE_KEY);
  if (!token) return null;

  const payload = decodePayload(token);
  if (!payload || (payload.exp && payload.exp * 1000 < Date.now())) {
    logout();
    return null;
  }

  setToken(token);
  user = payload;
  return user;
}

export function currentUser() {
  return user;
}

export function login() {
  location.href = loginUrl();
}

export function logout() {
  localStorage.removeItem(STORAGE_KEY);
  setToken(null);
  user = null;
}

export function authError() {
  const err = new URLSearchParams(location.search).get('auth_error');
  if (err) history.replaceState(null, '', location.pathname);
  return err;
}
