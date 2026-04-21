/* ═══════════════════════════════════════════════════════════
   MELODIA — server.js
   Node 18+, Express, native fetch, in-memory sessions
═══════════════════════════════════════════════════════════ */
'use strict';

require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const crypto   = require('crypto');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

/* ── Env validation ─────────────────────────────────────── */
const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('⚠  SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set in env!');
}

/* ── Scopes ─────────────────────────────────────────────── */
const SCOPES = [
  'user-read-private','user-read-email',
  'user-top-read','user-read-recently-played',
  'user-read-playback-state','user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private','playlist-read-collaborative',
  'streaming'
].join(' ');

/* ── Middleware ─────────────────────────────────────────── */
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure:   IS_PROD,
    httpOnly: true,
    sameSite: IS_PROD ? 'none' : 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000   // 7 days
  }
}));

/* ══════════════════════════════════════════════════════════
   SPOTIFY HELPERS
══════════════════════════════════════════════════════════ */
function basicAuth() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

async function fetchToken(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': basicAuth() },
    body: new URLSearchParams(body).toString()
  });
  if (!res.ok) throw new Error(`Token error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function refreshToken(sess) {
  if (!sess.refreshToken) throw new Error('no_refresh_token');
  const data = await fetchToken({ grant_type: 'refresh_token', refresh_token: sess.refreshToken });
  sess.accessToken  = data.access_token;
  sess.tokenExpiry  = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) sess.refreshToken = data.refresh_token;
  return sess.accessToken;
}

async function validToken(sess) {
  if (!sess.accessToken) throw new Error('not_authenticated');
  if (Date.now() > sess.tokenExpiry - 60_000) return refreshToken(sess);
  return sess.accessToken;
}

async function spotifyFetch(sess, url, opts = {}) {
  const doReq = async (token) => fetch(url, {
    ...opts,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });

  let token = await validToken(sess);
  let res   = await doReq(token);

  if (res.status === 401) {
    token = await refreshToken(sess);
    res   = await doReq(token);
  }

  if (res.status === 204) return null;
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Spotify ${res.status}: ${msg}`);
  }
  return res.json();
}

/* ── Auth guard ─────────────────────────────────────────── */
function guard(req, res, next) {
  if (!req.session.accessToken) return res.status(401).json({ error: 'not_authenticated' });
  next();
}

/* ══════════════════════════════════════════════════════════
   AUTH ROUTES
══════════════════════════════════════════════════════════ */
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  req.session.save(err => {
    if (err) { console.error('session save:', err); return res.redirect('/?error=session_error'); }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     CLIENT_ID,
      scope:         SCOPES,
      redirect_uri:  REDIRECT_URI,
      state,
      show_dialog:   'false'
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params}`);
  });
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error)  return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!state || state !== req.session.oauthState)
    return res.redirect('/?error=state_mismatch');

  delete req.session.oauthState;

  try {
    const data = await fetchToken({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
    });

    req.session.accessToken  = data.access_token;
    req.session.refreshToken = data.refresh_token;
    req.session.tokenExpiry  = Date.now() + data.expires_in * 1000;

    req.session.save(err => {
      if (err) { console.error('session save:', err); return res.redirect('/?error=session_error'); }
      res.redirect('/app');
    });
  } catch (err) {
    console.error('callback:', err);
    res.redirect('/?error=token_failed');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

/* ══════════════════════════════════════════════════════════
   API ROUTES
══════════════════════════════════════════════════════════ */

/* Status */
app.get('/api/status', (req, res) => {
  res.json({ authenticated: !!req.session.accessToken });
});

/* Profile */
app.get('/api/me', guard, async (req, res) => {
  try {
    const data = await spotifyFetch(req.session, 'https://api.spotify.com/v1/me');
    res.json(data);
  } catch (e) { apiError(res, e); }
});

/* Top tracks */
app.get('/api/top-tracks', guard, async (req, res) => {
  const { time_range = 'medium_term', limit = 50 } = req.query;
  try {
    const data = await spotifyFetch(req.session,
      `https://api.spotify.com/v1/me/top/tracks?time_range=${time_range}&limit=${limit}`);
    res.json(data);
  } catch (e) { apiError(res, e); }
});

/* Top artists */
app.get('/api/top-artists', guard, async (req, res) => {
  const { time_range = 'medium_term', limit = 50 } = req.query;
  try {
    const data = await spotifyFetch(req.session,
      `https://api.spotify.com/v1/me/top/artists?time_range=${time_range}&limit=${limit}`);
    res.json(data);
  } catch (e) { apiError(res, e); }
});

/* Recent */
app.get('/api/recent', guard, async (req, res) => {
  try {
    const data = await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player/recently-played?limit=50');
    res.json(data);
  } catch (e) { apiError(res, e); }
});

/* Playlists */
app.get('/api/playlists', guard, async (req, res) => {
  try {
    const data = await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/playlists?limit=50');
    res.json(data);
  } catch (e) { apiError(res, e); }
});

/* Playlist tracks */
app.get('/api/playlists/:id/tracks', guard, async (req, res) => {
  try {
    const data = await spotifyFetch(req.session,
      `https://api.spotify.com/v1/playlists/${req.params.id}/tracks?limit=100`);
    res.json(data);
  } catch (e) { apiError(res, e); }
});

/* Search */
app.get('/api/search', guard, async (req, res) => {
  const { q, limit = 20 } = req.query;
  if (!q) return res.status(400).json({ error: 'query_required' });
  try {
    const data = await spotifyFetch(req.session,
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track,artist&limit=${limit}`);
    res.json(data);
  } catch (e) { apiError(res, e); }
});

/* Current player */
app.get('/api/current', guard, async (req, res) => {
  try {
    const data = await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player');
    res.json(data || { is_playing: false, item: null });
  } catch (e) { apiError(res, e); }
});

/* Devices */
app.get('/api/devices', guard, async (req, res) => {
  try {
    const data = await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player/devices');
    res.json(data);
  } catch (e) { apiError(res, e); }
});

/* Play */
app.put('/api/play', guard, async (req, res) => {
  try {
    await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player/play',
      { method: 'PUT', body: JSON.stringify(req.body || {}) });
    res.json({ ok: true });
  } catch (e) { apiError(res, e); }
});

/* Pause */
app.put('/api/pause', guard, async (req, res) => {
  try {
    await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player/pause',
      { method: 'PUT' });
    res.json({ ok: true });
  } catch (e) { apiError(res, e); }
});

/* Next */
app.post('/api/next', guard, async (req, res) => {
  try {
    await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player/next',
      { method: 'POST' });
    res.json({ ok: true });
  } catch (e) { apiError(res, e); }
});

/* Previous */
app.post('/api/prev', guard, async (req, res) => {
  try {
    await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player/previous',
      { method: 'POST' });
    res.json({ ok: true });
  } catch (e) { apiError(res, e); }
});

/* Volume */
app.put('/api/volume', guard, async (req, res) => {
  const { volume_percent } = req.body;
  try {
    await spotifyFetch(req.session,
      `https://api.spotify.com/v1/me/player/volume?volume_percent=${volume_percent}`,
      { method: 'PUT' });
    res.json({ ok: true });
  } catch (e) { apiError(res, e); }
});

/* ── Error helper ───────────────────────────────────────── */
function apiError(res, err) {
  console.error('API error:', err.message);
  if (err.message === 'not_authenticated') return res.status(401).json({ error: 'not_authenticated' });
  if (err.message.includes('403'))  return res.status(403).json({ error: 'premium_required' });
  if (err.message.includes('404'))  return res.status(404).json({ error: 'not_found' });
  res.status(500).json({ error: err.message });
}

/* ══════════════════════════════════════════════════════════
   PAGE ROUTES
══════════════════════════════════════════════════════════ */
app.get('/', (req, res) => {
  if (req.session.accessToken) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

/* ── Start ──────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`✅  Melodia running → http://localhost:${PORT}`);
});
