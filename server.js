'use strict';
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

if (!CLIENT_ID || !CLIENT_SECRET) console.warn('⚠  Missing Spotify credentials!');

/* ── Scopes ─────────────────────────────────────────────── */
const SCOPES = [
  'user-read-private', 'user-read-email',
  'user-top-read', 'user-read-recently-played',
  'user-read-playback-state', 'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private', 'playlist-read-collaborative',
  'playlist-modify-public', 'playlist-modify-private',
  'streaming', 'app-remote-control'
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
    secure: PROD,
    httpOnly: true,
    sameSite: PROD ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

/* ══════════════════════════════════════════════════════════
   SPOTIFY HELPERS
══════════════════════════════════════════════════════════ */
const b64 = () => 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

async function fetchTokens(body) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: b64() },
    body: new URLSearchParams(body).toString()
  });
  if (!r.ok) throw new Error(`token_error_${r.status}: ${await r.text()}`);
  return r.json();
}

async function doRefresh(sess) {
  if (!sess.refreshToken) throw new Error('no_refresh_token');
  const d = await fetchTokens({ grant_type: 'refresh_token', refresh_token: sess.refreshToken });
  sess.accessToken = d.access_token;
  sess.tokenExpiry = Date.now() + d.expires_in * 1000;
  if (d.refresh_token) sess.refreshToken = d.refresh_token;
  return sess.accessToken;
}

async function getToken(sess) {
  if (!sess.accessToken) throw new Error('not_authenticated');
  if (Date.now() > sess.tokenExpiry - 60_000) return doRefresh(sess);
  return sess.accessToken;
}

async function spFetch(sess, url, opts = {}) {
  const req = async (tok) => fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  let tok = await getToken(sess);
  let res = await req(tok);
  if (res.status === 401) { tok = await doRefresh(sess); res = await req(tok); }
  if (res.status === 204) return null;
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`spotify_${res.status}: ${txt}`);
  }
  return res.json();
}

function guard(req, res, next) {
  if (!req.session.accessToken) return res.status(401).json({ error: 'not_authenticated' });
  next();
}

function apiErr(res, e) {
  console.error('API err:', e.message);
  if (e.message === 'not_authenticated') return res.status(401).json({ error: 'not_authenticated' });
  if (e.message?.includes('spotify_403')) return res.status(403).json({ error: 'premium_required', detail: e.message });
  if (e.message?.includes('spotify_404')) return res.status(404).json({ error: 'not_found' });
  res.status(500).json({ error: e.message });
}

/* ══════════════════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════════════════ */
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.save(err => {
    if (err) return res.redirect('/?error=session_error');
    const p = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID,
      scope: SCOPES, redirect_uri: REDIRECT_URI,
      state, show_dialog: 'true'   // ← true = forza schermata login Spotify ogni volta
    });
    res.redirect(`https://accounts.spotify.com/authorize?${p}`);
  });
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!state || state !== req.session.oauthState) return res.redirect('/?error=state_mismatch');
  delete req.session.oauthState;
  try {
    const d = await fetchTokens({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
    req.session.accessToken = d.access_token;
    req.session.refreshToken = d.refresh_token;
    req.session.tokenExpiry = Date.now() + d.expires_in * 1000;
    req.session.save(err => {
      if (err) return res.redirect('/?error=session_error');
      res.redirect('/app');
    });
  } catch (e) {
    console.error('callback error:', e.message);
    res.redirect('/?error=token_failed');
  }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

/* ══════════════════════════════════════════════════════════
   API — AUTH / PROFILE
══════════════════════════════════════════════════════════ */
app.get('/api/status', (req, res) => res.json({ authenticated: !!req.session.accessToken }));

app.get('/api/me', guard, async (req, res) => {
  try { res.json(await spFetch(req.session, 'https://api.spotify.com/v1/me')); }
  catch (e) { apiErr(res, e); }
});

/* ══════════════════════════════════════════════════════════
   API — MUSIC DATA
══════════════════════════════════════════════════════════ */
app.get('/api/top-tracks', guard, async (req, res) => {
  const { time_range = 'medium_term', limit = 50 } = req.query;
  try { res.json(await spFetch(req.session, `https://api.spotify.com/v1/me/top/tracks?time_range=${time_range}&limit=${limit}`)); }
  catch (e) { apiErr(res, e); }
});

app.get('/api/top-artists', guard, async (req, res) => {
  const { time_range = 'medium_term', limit = 50 } = req.query;
  try { res.json(await spFetch(req.session, `https://api.spotify.com/v1/me/top/artists?time_range=${time_range}&limit=${limit}`)); }
  catch (e) { apiErr(res, e); }
});

app.get('/api/recent', guard, async (req, res) => {
  try { res.json(await spFetch(req.session, 'https://api.spotify.com/v1/me/player/recently-played?limit=50')); }
  catch (e) { apiErr(res, e); }
});

/* ── Playlists ─────────────────────────────────────────── */
app.get('/api/playlists', guard, async (req, res) => {
  try { res.json(await spFetch(req.session, 'https://api.spotify.com/v1/me/playlists?limit=50')); }
  catch (e) { apiErr(res, e); }
});

app.get('/api/playlists/:id/tracks', guard, async (req, res) => {
  try {
    // Paginate up to 100 tracks
    const url = `https://api.spotify.com/v1/playlists/${req.params.id}/tracks?limit=100&fields=items(track(id,name,uri,duration_ms,artists,album(name,images),preview_url)),total`;
    res.json(await spFetch(req.session, url));
  } catch (e) { apiErr(res, e); }
});

app.post('/api/playlists', guard, async (req, res) => {
  try {
    const me = await spFetch(req.session, 'https://api.spotify.com/v1/me');
    const pl = await spFetch(req.session,
      `https://api.spotify.com/v1/users/${me.id}/playlists`,
      { method: 'POST', body: JSON.stringify({ name: req.body.name || 'Nuova Playlist', description: req.body.description || '', public: false }) }
    );
    res.json(pl);
  } catch (e) { apiErr(res, e); }
});

app.post('/api/playlists/:id/tracks', guard, async (req, res) => {
  try {
    const d = await spFetch(req.session,
      `https://api.spotify.com/v1/playlists/${req.params.id}/tracks`,
      { method: 'POST', body: JSON.stringify({ uris: req.body.uris }) }
    );
    res.json(d);
  } catch (e) { apiErr(res, e); }
});

app.delete('/api/playlists/:id/tracks', guard, async (req, res) => {
  try {
    const d = await spFetch(req.session,
      `https://api.spotify.com/v1/playlists/${req.params.id}/tracks`,
      { method: 'DELETE', body: JSON.stringify({ tracks: req.body.uris.map(u => ({ uri: u })) }) }
    );
    res.json(d);
  } catch (e) { apiErr(res, e); }
});

/* ── Search ────────────────────────────────────────────── */
app.get('/api/search', guard, async (req, res) => {
  const { q, limit = 20 } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'query_required' });
  try {
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q.trim())}&type=track,artist&limit=${limit}&market=from_token`;
    res.json(await spFetch(req.session, url));
  } catch (e) { apiErr(res, e); }
});

/* ── Recommendations (Spotify) ─────────────────────────── */
app.get('/api/recommendations', guard, async (req, res) => {
  const { seed_tracks, seed_artists, seed_genres, limit = 20 } = req.query;
  try {
    const params = new URLSearchParams({ limit, market: 'from_token' });
    if (seed_tracks) params.set('seed_tracks', seed_tracks);
    if (seed_artists) params.set('seed_artists', seed_artists);
    if (seed_genres) params.set('seed_genres', seed_genres);
    res.json(await spFetch(req.session, `https://api.spotify.com/v1/recommendations?${params}`));
  } catch (e) { apiErr(res, e); }
});

/* ── Player ────────────────────────────────────────────── */
app.get('/api/current', guard, async (req, res) => {
  try {
    const d = await spFetch(req.session, 'https://api.spotify.com/v1/me/player');
    res.json(d || { is_playing: false, item: null });
  } catch (e) { apiErr(res, e); }
});

app.get('/api/devices', guard, async (req, res) => {
  try { res.json(await spFetch(req.session, 'https://api.spotify.com/v1/me/player/devices')); }
  catch (e) { apiErr(res, e); }
});

app.put('/api/play', guard, async (req, res) => {
  try {
    await spFetch(req.session, 'https://api.spotify.com/v1/me/player/play',
      { method: 'PUT', body: JSON.stringify(req.body || {}) });
    res.json({ ok: true });
  } catch (e) { apiErr(res, e); }
});

app.put('/api/pause', guard, async (req, res) => {
  try {
    await spFetch(req.session, 'https://api.spotify.com/v1/me/player/pause', { method: 'PUT' });
    res.json({ ok: true });
  } catch (e) { apiErr(res, e); }
});

app.post('/api/next', guard, async (req, res) => {
  try {
    await spFetch(req.session, 'https://api.spotify.com/v1/me/player/next', { method: 'POST' });
    res.json({ ok: true });
  } catch (e) { apiErr(res, e); }
});

app.post('/api/prev', guard, async (req, res) => {
  try {
    await spFetch(req.session, 'https://api.spotify.com/v1/me/player/previous', { method: 'POST' });
    res.json({ ok: true });
  } catch (e) { apiErr(res, e); }
});

app.put('/api/seek', guard, async (req, res) => {
  try {
    await spFetch(req.session,
      `https://api.spotify.com/v1/me/player/seek?position_ms=${req.body.position_ms}`,
      { method: 'PUT' });
    res.json({ ok: true });
  } catch (e) { apiErr(res, e); }
});

app.put('/api/volume', guard, async (req, res) => {
  try {
    await spFetch(req.session,
      `https://api.spotify.com/v1/me/player/volume?volume_percent=${req.body.volume_percent}`,
      { method: 'PUT' });
    res.json({ ok: true });
  } catch (e) { apiErr(res, e); }
});

app.put('/api/shuffle', guard, async (req, res) => {
  try {
    await spFetch(req.session,
      `https://api.spotify.com/v1/me/player/shuffle?state=${req.body.state}`,
      { method: 'PUT' });
    res.json({ ok: true });
  } catch (e) { apiErr(res, e); }
});

app.put('/api/repeat', guard, async (req, res) => {
  try {
    await spFetch(req.session,
      `https://api.spotify.com/v1/me/player/repeat?state=${req.body.state}`,
      { method: 'PUT' });
    res.json({ ok: true });
  } catch (e) { apiErr(res, e); }
});

/* ══════════════════════════════════════════════════════════
   API — GEMINI AI
══════════════════════════════════════════════════════════ */
app.post('/api/ai/recommend', guard, async (req, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ error: 'gemini_not_configured' });

  const { topTracks, topArtists, topGenres } = req.body;

  const prompt = `Sei un esperto musicale. L'utente ascolta principalmente: 
Artisti top: ${(topArtists || []).slice(0, 5).join(', ')}.
Brani top: ${(topTracks || []).slice(0, 5).join(', ')}.
Generi preferiti: ${(topGenres || []).slice(0, 5).join(', ')}.

Fornisci consigli musicali personalizzati in italiano. Rispondi SOLO con JSON valido, nessun testo extra, nessun markdown:
{
  "summary": "breve analisi del gusto musicale (2 frasi)",
  "recommendations": [
    {"type":"artist","name":"nome artista","reason":"perché lo consigli (1 frase)"},
    {"type":"artist","name":"nome artista","reason":"perché lo consigli (1 frase)"},
    {"type":"artist","name":"nome artista","reason":"perché lo consigli (1 frase)"},
    {"type":"track","name":"Titolo Brano","artist":"Nome Artista","reason":"perché lo consigli (1 frase)"},
    {"type":"track","name":"Titolo Brano","artist":"Nome Artista","reason":"perché lo consigli (1 frase)"},
    {"type":"track","name":"Titolo Brano","artist":"Nome Artista","reason":"perché lo consigli (1 frase)"}
  ],
  "playlist_name": "nome creativo per una playlist basata sui tuoi gusti",
  "mood": "l'umore/vibe generale della tua musica (3-4 parole)"
}`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 1024 }
        })
      }
    );
    if (!r.ok) throw new Error(`gemini_${r.status}`);
    const gd = await r.json();
    let text = gd.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // Strip markdown code fences if present
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(text);
    res.json(parsed);
  } catch (e) {
    console.error('Gemini error:', e.message);
    res.status(500).json({ error: 'ai_error', detail: e.message });
  }
});

/* ══════════════════════════════════════════════════════════
   PAGES
══════════════════════════════════════════════════════════ */
app.get('/', (req, res) => {
  if (req.session.accessToken) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/app', (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.listen(PORT, () => console.log(`✅ Melodia → http://localhost:${PORT}`));
