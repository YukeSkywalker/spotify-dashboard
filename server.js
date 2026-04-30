'use strict';
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const crypto  = require('crypto');
const path    = require('path');

const app     = express();
const PORT    = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const CLIENT_ID      = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET  = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI   = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const GEMINI_KEY     = process.env.GEMINI_API_KEY || '';

if (!CLIENT_ID || !CLIENT_SECRET) console.warn('⚠  Missing Spotify credentials!');

const SCOPES = [
  'user-read-private','user-read-email',
  'user-top-read','user-read-recently-played',
  'user-read-playback-state','user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private','playlist-read-collaborative',
  'playlist-modify-public','playlist-modify-private',
  'streaming','app-remote-control'
].join(' ');

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: IS_PROD, httpOnly: true, sameSite: IS_PROD ? 'none' : 'lax', maxAge: 7*24*60*60*1000 }
}));

/* ── Spotify helpers ─────────────────────────────────── */
function basicAuth() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

async function fetchToken(body) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams(body).toString()
  });
  if (!r.ok) throw new Error(`token_${r.status}: ${await r.text()}`);
  return r.json();
}

async function refreshToken(sess) {
  if (!sess.refreshToken) throw new Error('no_refresh_token');
  const d = await fetchToken({ grant_type: 'refresh_token', refresh_token: sess.refreshToken });
  sess.accessToken = d.access_token;
  sess.tokenExpiry = Date.now() + d.expires_in * 1000;
  if (d.refresh_token) sess.refreshToken = d.refresh_token;
  return sess.accessToken;
}

async function validToken(sess) {
  if (!sess.accessToken) throw new Error('not_authenticated');
  if (Date.now() > sess.tokenExpiry - 60_000) return refreshToken(sess);
  return sess.accessToken;
}

// THE ONLY fetch wrapper — no aliases, no spFetch
async function spotifyFetch(sess, url, opts = {}) {
  const doReq = async (tok) => fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  let tok = await validToken(sess);
  let res = await doReq(tok);
  if (res.status === 401) { tok = await refreshToken(sess); res = await doReq(tok); }
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`spotify_${res.status}: ${await res.text()}`);
  return res.json();
}

function guard(req, res, next) {
  if (!req.session.accessToken) return res.status(401).json({ error: 'not_authenticated' });
  next();
}

function apiError(res, err) {
  console.error('API err:', err.message);
  if (err.message === 'not_authenticated')  return res.status(401).json({ error: 'not_authenticated' });
  if (err.message?.includes('spotify_403')) return res.status(403).json({ error: 'premium_required' });
  if (err.message?.includes('spotify_404')) return res.status(404).json({ error: 'not_found' });
  res.status(500).json({ error: err.message });
}

/* ── Auth ────────────────────────────────────────────── */
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.save(err => {
    if (err) return res.redirect('/?error=session_error');
    const p = new URLSearchParams({ response_type:'code', client_id:CLIENT_ID, scope:SCOPES, redirect_uri:REDIRECT_URI, state, show_dialog:'true' });
    res.redirect(`https://accounts.spotify.com/authorize?${p}`);
  });
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!state || state !== req.session.oauthState) return res.redirect('/?error=state_mismatch');
  delete req.session.oauthState;
  try {
    const d = await fetchToken({ grant_type:'authorization_code', code, redirect_uri:REDIRECT_URI });
    req.session.accessToken  = d.access_token;
    req.session.refreshToken = d.refresh_token;
    req.session.tokenExpiry  = Date.now() + d.expires_in * 1000;
    req.session.save(err => { if (err) return res.redirect('/?error=session_error'); res.redirect('/app'); });
  } catch (e) { console.error('callback:', e.message); res.redirect('/?error=token_failed'); }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

/* ── Status / Me ─────────────────────────────────────── */
app.get('/api/status', (req, res) => res.json({ authenticated: !!req.session.accessToken }));

app.get('/api/me', guard, async (req, res) => {
  try { res.json(await spotifyFetch(req.session, 'https://api.spotify.com/v1/me')); }
  catch (e) { apiError(res, e); }
});

/* ── Top Tracks ──────────────────────────────────────── */
app.get('/api/top-tracks', guard, async (req, res) => {
  const { time_range = 'medium_term', limit = 50 } = req.query;
  try { res.json(await spotifyFetch(req.session, `https://api.spotify.com/v1/me/top/tracks?time_range=${time_range}&limit=${limit}`)); }
  catch (e) { apiError(res, e); }
});

/* ── Top Artists — FIX: enrich followers if missing ─── */
app.get('/api/top-artists', guard, async (req, res) => {
  const { time_range = 'medium_term', limit = 50 } = req.query;
  try {
    const data = await spotifyFetch(req.session,
      `https://api.spotify.com/v1/me/top/artists?time_range=${time_range}&limit=${limit}`);

    // Spotify sometimes omits followers in top-artists. Enrich via /artists batch if needed.
    const needEnrich = (data.items || []).filter(a => a.followers?.total == null);
    if (needEnrich.length > 0) {
      // max 50 ids per call
      const ids = needEnrich.slice(0,50).map(a => a.id).join(',');
      try {
        const enriched = await spotifyFetch(req.session, `https://api.spotify.com/v1/artists?ids=${ids}`);
        const map = {};
        (enriched.artists || []).forEach(a => { map[a.id] = a; });
        data.items = data.items.map(a =>
          map[a.id] ? { ...a, followers: map[a.id].followers, images: map[a.id].images || a.images, popularity: map[a.id].popularity } : a
        );
      } catch (_) { /* best effort, send what we have */ }
    }
    res.json(data);
  } catch (e) { apiError(res, e); }
});

/* ── Recent ──────────────────────────────────────────── */
app.get('/api/recent', guard, async (req, res) => {
  try { res.json(await spotifyFetch(req.session, 'https://api.spotify.com/v1/me/player/recently-played?limit=50')); }
  catch (e) { apiError(res, e); }
});

/* ── Playlists ───────────────────────────────────────── */
app.get('/api/playlists', guard, async (req, res) => {
  try { res.json(await spotifyFetch(req.session, 'https://api.spotify.com/v1/me/playlists?limit=50')); }
  catch (e) { apiError(res, e); }
});

//API per get Tracks
app.get('/api/playlists/:id/tracks', guard, async (req, res) => {
  try {
    const allItems = [];
    let url = `https://api.spotify.com/v1/playlists/${req.params.id}/tracks?limit=100&market=from_token`;
    while (url) {
      const page = await spotifyFetch(req.session, url);
      if (!page) break;
      allItems.push(...(page.items || []));
      url = page.next || null;
    }
    res.json({ items: allItems, total: allItems.length });
  } catch (e) { apiError(res, e); }
});

app.post('/api/playlists', guard, async (req, res) => {
  try {
    const me = await spotifyFetch(req.session, 'https://api.spotify.com/v1/me');
    res.json(await spotifyFetch(req.session,
      `https://api.spotify.com/v1/users/${me.id}/playlists`,
      { method:'POST', body:JSON.stringify({ name:req.body.name||'Nuova Playlist', description:req.body.description||'', public:false }) }
    ));
  } catch (e) { apiError(res, e); }
});

app.post('/api/playlists/:id/tracks', guard, async (req, res) => {
  try {
    res.json(await spotifyFetch(req.session,
      `https://api.spotify.com/v1/playlists/${req.params.id}/tracks`,
      { method:'POST', body:JSON.stringify({ uris:req.body.uris }) }
    ));
  } catch (e) { apiError(res, e); }
});

/* ── Search — FIX: was using undefined spFetch ───────── */
app.get('/api/search', guard, async (req, res) => {
  const { q, limit = 20 } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'query_required' });
  try {
    const query = q.trim().replace(/[<>]/g, '');
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track,artist&limit=${Math.min(Number(limit), 50)}&market=IT`;
    const data = await spotifyFetch(req.session, url);
    res.json(data);
  } catch (e) {
    console.error('Search error:', e.message);
    apiError(res, e);
  }
});


/* ── Recommendations — FIX: was using undefined spFetch  */
app.get('/api/recommendations', guard, async (req, res) => {
  const { seed_tracks, seed_artists, seed_genres, limit = 20 } = req.query;
  try {
    const p = new URLSearchParams({ limit, market:'from_token' });
    if (seed_tracks)  p.set('seed_tracks',  seed_tracks);
    if (seed_artists) p.set('seed_artists', seed_artists);
    if (seed_genres)  p.set('seed_genres',  seed_genres);
    res.json(await spotifyFetch(req.session, `https://api.spotify.com/v1/recommendations?${p}`));
  } catch (e) { apiError(res, e); }
});

/* ── Player ──────────────────────────────────────────── */
app.get('/api/current', guard, async (req, res) => {
  try { res.json(await spotifyFetch(req.session, 'https://api.spotify.com/v1/me/player') || { is_playing:false, item:null }); }
  catch (e) { apiError(res, e); }
});
app.get('/api/devices', guard, async (req, res) => {
  try { res.json(await spotifyFetch(req.session, 'https://api.spotify.com/v1/me/player/devices')); }
  catch (e) { apiError(res, e); }
});
app.put('/api/play', guard, async (req, res) => {
  try { await spotifyFetch(req.session, 'https://api.spotify.com/v1/me/player/play', { method:'PUT', body:JSON.stringify(req.body||{}) }); res.json({ ok:true }); }
  catch (e) { apiError(res, e); }
});
app.put('/api/pause', guard, async (req, res) => {
  try { await spotifyFetch(req.session, 'https://api.spotify.com/v1/me/player/pause', { method:'PUT' }); res.json({ ok:true }); }
  catch (e) { apiError(res, e); }
});
app.post('/api/next', guard, async (req, res) => {
  try { await spotifyFetch(req.session, 'https://api.spotify.com/v1/me/player/next', { method:'POST' }); res.json({ ok:true }); }
  catch (e) { apiError(res, e); }
});
app.post('/api/prev', guard, async (req, res) => {
  try { await spotifyFetch(req.session, 'https://api.spotify.com/v1/me/player/previous', { method:'POST' }); res.json({ ok:true }); }
  catch (e) { apiError(res, e); }
});
app.put('/api/volume', guard, async (req, res) => {
  try { await spotifyFetch(req.session, `https://api.spotify.com/v1/me/player/volume?volume_percent=${req.body.volume_percent}`, { method:'PUT' }); res.json({ ok:true }); }
  catch (e) { apiError(res, e); }
});

/* ── Gemini AI ───────────────────────────────────────── */
app.post('/api/ai/recommend', guard, async (req, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ error: 'gemini_not_configured' });
  const { topTracks, topArtists, topGenres } = req.body;
  const prompt = `Sei un esperto musicale AI. Profilo utente:
Artisti top: ${(topArtists||[]).slice(0,6).join(', ')}.
Brani top: ${(topTracks||[]).slice(0,6).join(', ')}.
Generi: ${(topGenres||[]).slice(0,5).join(', ')}.
Rispondi SOLO con JSON puro, nessun testo, nessun markdown:
{"summary":"analisi 2 frasi in italiano","mood":"vibe 3-4 parole italiano","playlist_name":"nome creativo italiano","recommendations":[{"type":"artist","name":"...","reason":"..."},{"type":"artist","name":"...","reason":"..."},{"type":"artist","name":"...","reason":"..."},{"type":"track","name":"...","artist":"...","reason":"..."},{"type":"track","name":"...","artist":"...","reason":"..."},{"type":"track","name":"...","artist":"...","reason":"..."},{"type":"track","name":"...","artist":"...","reason":"..."},{"type":"track","name":"...","artist":"...","reason":"..."}]}`;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.85,maxOutputTokens:1500} }) }
    );
    if (!r.ok) throw new Error(`gemini_${r.status}: ${await r.text()}`);
    const gd = await r.json();
    let text = gd.candidates?.[0]?.content?.parts?.[0]?.text || '';
    text = text.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no_json_in_response');
    res.json(JSON.parse(match[0]));
  } catch (e) { console.error('Gemini:', e.message); res.status(500).json({ error:'ai_error', detail:e.message }); }
});

// Helper: find Spotify URI for a track name (used by AI playlist creation)
app.get('/api/search-uri', guard, async (req, res) => {
  const { track, artist } = req.query;
  if (!track) return res.status(400).json({ error:'track_required' });
  try {
    const q = artist ? `track:${track} artist:${artist}` : track;
    const d = await spotifyFetch(req.session,
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1&market=from_token`);
    const item = d.tracks?.items?.[0];
    if (!item) return res.json({ found:false });
    res.json({ found:true, uri:item.uri, name:item.name, artist:item.artists?.[0]?.name, album_art:item.album?.images?.[0]?.url, duration_ms:item.duration_ms });
  } catch (e) { apiError(res, e); }
});

/* ── Pages ───────────────────────────────────────────── */
app.get('/',    (req, res) => { if (req.session.accessToken) return res.redirect('/app'); res.sendFile(path.join(__dirname,'public','index.html')); });
app.get('/app', (req, res) => { if (!req.session.accessToken) return res.redirect('/'); res.sendFile(path.join(__dirname,'public','app.html')); });

app.listen(PORT, () => console.log(`✅ Melodia → http://localhost:${PORT}`));
