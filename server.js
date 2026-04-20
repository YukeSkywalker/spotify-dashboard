require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-top-read',
  'user-read-recently-played',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'streaming'
].join(' ');

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

function generateRandomString(length) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

async function refreshAccessToken(session) {
  if (!session.refreshToken) throw new Error('No refresh token');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken
  });
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
    },
    body: params.toString()
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token refresh failed: ${err}`);
  }
  const data = await response.json();
  session.accessToken = data.access_token;
  session.tokenExpiry = Date.now() + (data.expires_in * 1000);
  if (data.refresh_token) session.refreshToken = data.refresh_token;
  return session.accessToken;
}

async function getValidToken(session) {
  if (!session.accessToken) throw new Error('Not authenticated');
  if (Date.now() > (session.tokenExpiry - 60000)) {
    return await refreshAccessToken(session);
  }
  return session.accessToken;
}

async function spotifyFetch(url, session, options = {}) {
  const token = await getValidToken(session);
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (response.status === 401) {
    const newToken = await refreshAccessToken(session);
    const retry = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${newToken}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (retry.status === 204) return null;
    if (!retry.ok) {
      const err = await retry.text();
      throw new Error(`Spotify API error ${retry.status}: ${err}`);
    }
    return retry.json();
  }
  if (response.status === 204) return null;
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Spotify API error ${response.status}: ${err}`);
  }
  return response.json();
}

function requireAuth(req, res, next) {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

app.get('/login', (req, res) => {
  const state = generateRandomString(16);
  req.session.oauthState = state;
  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.redirect('/?error=server_error');
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      state: state,
      show_dialog: 'false'
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
  });
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);

  if (!state || !req.session.oauthState || state !== req.session.oauthState) {
    console.error('State mismatch:', { received: state, expected: req.session.oauthState, sessionID: req.sessionID });
    return res.redirect('/?error=state_mismatch');
  }

  delete req.session.oauthState;

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI
    });
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
      },
      body: params.toString()
    });
    if (!tokenResponse.ok) {
      const err = await tokenResponse.text();
      console.error('Token exchange failed:', err);
      return res.redirect('/?error=token_exchange_failed');
    }
    const tokenData = await tokenResponse.json();
    req.session.accessToken = tokenData.access_token;
    req.session.refreshToken = tokenData.refresh_token;
    req.session.tokenExpiry = Date.now() + (tokenData.expires_in * 1000);
    req.session.save((err) => {
      if (err) {
        console.error('Session save error after token:', err);
        return res.redirect('/?error=server_error');
      }
      res.redirect('/app');
    });
  } catch (err) {
    console.error('Callback error:', err);
    res.redirect('/?error=server_error');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Session destroy error:', err);
    res.redirect('/');
  });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: !!req.session.accessToken });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const data = await spotifyFetch('https://api.spotify.com/v1/me', req.session);
    res.json(data);
  } catch (err) {
    if (err.message.includes('Not authenticated')) return res.status(401).json({ error: 'Not authenticated' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/top-tracks', requireAuth, async (req, res) => {
  try {
    const { time_range = 'medium_term', limit = 20 } = req.query;
    const data = await spotifyFetch(`https://api.spotify.com/v1/me/top/tracks?time_range=${time_range}&limit=${limit}`, req.session);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/top-artists', requireAuth, async (req, res) => {
  try {
    const { time_range = 'medium_term', limit = 20 } = req.query;
    const data = await spotifyFetch(`https://api.spotify.com/v1/me/top/artists?time_range=${time_range}&limit=${limit}`, req.session);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recently-played', requireAuth, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const data = await spotifyFetch(`https://api.spotify.com/v1/me/player/recently-played?limit=${limit}`, req.session);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/playlists', requireAuth, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const data = await spotifyFetch(`https://api.spotify.com/v1/me/playlists?limit=${limit}`, req.session);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const { q, type = 'track', limit = 20 } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter required' });
    const data = await spotifyFetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit}`, req.session);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/player', requireAuth, async (req, res) => {
  try {
    const data = await spotifyFetch('https://api.spotify.com/v1/me/player', req.session);
    res.json(data || { is_playing: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/player/play', requireAuth, async (req, res) => {
  try {
    await spotifyFetch('https://api.spotify.com/v1/me/player/play', req.session, {
      method: 'PUT',
      body: JSON.stringify(req.body)
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/player/pause', requireAuth, async (req, res) => {
  try {
    await spotifyFetch('https://api.spotify.com/v1/me/player/pause', req.session, { method: 'PUT' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/player/next', requireAuth, async (req, res) => {
  try {
    await spotifyFetch('https://api.spotify.com/v1/me/player/next', req.session, { method: 'POST' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/player/previous', requireAuth, async (req, res) => {
  try {
    await spotifyFetch('https://api.spotify.com/v1/me/player/previous', req.session, { method: 'POST' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/player/volume', requireAuth, async (req, res) => {
  try {
    const { volume_percent } = req.body;
    await spotifyFetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=${volume_percent}`, req.session, { method: 'PUT' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/playlist/:id/tracks', requireAuth, async (req, res) => {
  try {
    const data = await spotifyFetch(`https://api.spotify.com/v1/playlists/${req.params.id}/tracks?limit=50`, req.session);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/app', (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/', (req, res) => {
  if (req.session.accessToken) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('⚠️  WARNING: SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET not set!');
  }
});
