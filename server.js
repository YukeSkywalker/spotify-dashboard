require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.static('public'));

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI, PORT } = process.env;

const tokens = {};

app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const scope = [
    'user-read-currently-playing',
    'user-top-read',
    'user-read-playback-state',
    'user-modify-playback-state',
    'streaming',
    'user-read-email',
    'user-read-private',
    'playlist-read-private',
    'playlist-read-collaborative',
  ].join(' ');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=' + error);
  if (!code) return res.redirect('/?error=no_code');
  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
        },
      }
    );
    const { access_token, refresh_token, expires_in } = response.data;
    const sessionId = crypto.randomBytes(32).toString('hex');
    tokens[sessionId] = {
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000,
    };
    console.log('Login OK, sessionId:', sessionId);
    res.redirect('/?session=' + sessionId);
  } catch (err) {
    console.error('Callback error:', err.response?.data || err.message);
    res.redirect('/?error=callback_failed');
  }
});

async function getAccessToken(req) {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId || !tokens[sessionId]) throw new Error('Non loggato');
  const store = tokens[sessionId];
  if (Date.now() < store.expires_at - 60000) return store.access_token;
  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: store.refresh_token,
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
      },
    }
  );
  store.access_token = response.data.access_token;
  store.expires_at = Date.now() + response.data.expires_in * 1000;
  return store.access_token;
}

app.get('/api/auth-status', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  res.json({ loggedIn: !!(sessionId && tokens[sessionId]) });
});

app.get('/api/token', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    res.json({ token });
  } catch (err) { res.status(401).json({ error: 'Non autenticato' }); }
});

app.get('/api/me', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const { data } = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(data);
  } catch (err) { res.status(401).json({ error: 'Non autenticato' }); }
});

app.get('/api/now-playing', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const result = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (result.status === 204 || !result.data) return res.json({ playing: false });
    res.json({ playing: true, track: result.data.item, progress: result.data.progress_ms });
  } catch (err) { res.status(401).json({ error: 'Non autenticato' }); }
});

app.get('/api/top-tracks', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const range = req.query.range || 'short_term';
    const limit = req.query.limit || 10;
    const { data } = await axios.get(
      `https://api.spotify.com/v1/me/top/tracks?limit=${limit}&time_range=${range}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(data);
  } catch (err) { res.status(401).json({ error: 'Non autenticato' }); }
});

app.get('/api/top-artists', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const range = req.query.range || 'short_term';
    const limit = req.query.limit || 10;
    const { data } = await axios.get(
      `https://api.spotify.com/v1/me/top/artists?limit=${limit}&time_range=${range}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(data);
  } catch (err) { res.status(401).json({ error: 'Non autenticato' }); }
});

app.get('/api/playlists', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const { data } = await axios.get('https://api.spotify.com/v1/me/playlists?limit=50', {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(data);
  } catch (err) { res.status(401).json({ error: 'Non autenticato' }); }
});

app.get('/api/devices', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const { data } = await axios.get('https://api.spotify.com/v1/me/player/devices', {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(data);
  } catch (err) { res.status(401).json({ error: 'Non autenticato' }); }
});

app.put('/api/player/transfer', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    await axios.put(
      'https://api.spotify.com/v1/me/player',
      { device_ids: [req.query.device_id], play: true },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/play', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    await axios.put('https://api.spotify.com/v1/me/player/play', {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/pause', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    await axios.put('https://api.spotify.com/v1/me/player/pause', {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/next', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    await axios.post('https://api.spotify.com/v1/me/player/next', {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/previous', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    await axios.post('https://api.spotify.com/v1/me/player/previous', {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/volume', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    await axios.put(
      `https://api.spotify.com/v1/me/player/volume?volume_percent=${req.query.volume}`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/search', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const { data } = await axios.get(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(req.query.q)}&type=track&limit=20`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/queue', async (req, res) => {
  try {
    const token = await getAccessToken(req);
    await axios.post(
      `https://api.spotify.com/v1/me/player/queue?uri=${req.query.uri}`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT || 3000, () => console.log(`Server su porta ${PORT || 3000}`));
