require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.static('public'));

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI, PORT } = process.env;

let tokenStore = {};

app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const scope = 'user-read-currently-playing user-top-read user-read-playback-state user-modify-playback-state streaming user-read-email user-read-private';
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
  const { code } = req.query;
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
    tokenStore = { access_token, refresh_token, expires_at: Date.now() + expires_in * 1000 };
    res.redirect('/');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Errore durante il login');
  }
});

async function getAccessToken() {
  if (!tokenStore.access_token) throw new Error('Non loggato');
  if (Date.now() < tokenStore.expires_at - 60000) return tokenStore.access_token;
  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenStore.refresh_token,
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
      },
    }
  );
  tokenStore.access_token = response.data.access_token;
  tokenStore.expires_at = Date.now() + response.data.expires_in * 1000;
  return tokenStore.access_token;
}

app.get('/api/auth-status', (req, res) => {
  res.json({ loggedIn: !!tokenStore.access_token });
});

app.get('/api/token', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ token });
  } catch (err) {
    res.status(401).json({ error: 'Non autenticato' });
  }
});

app.get('/api/top-tracks', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { data } = await axios.get('https://api.spotify.com/v1/me/top/tracks?limit=10&time_range=short_term', {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(data);
  } catch (err) { res.status(401).json({ error: 'Non autenticato' }); }
});

app.get('/api/top-artists', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { data } = await axios.get('https://api.spotify.com/v1/me/top/artists?limit=10&time_range=short_term', {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(data);
  } catch (err) { res.status(401).json({ error: 'Non autenticato' }); }
});

app.get('/api/now-playing', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { data, status } = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (status === 204 || !data) return res.json({ playing: false });
    res.json({ playing: true, track: data.item, progress: data.progress_ms });
  } catch (err) { res.status(401).json({ error: 'Non autenticato' }); }
});

app.get('/api/devices', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { data } = await axios.get('https://api.spotify.com/v1/me/player/devices', {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(data);
  } catch (err) { res.status(401).json({ error: 'Non autenticato' }); }
});

app.put('/api/player/transfer', async (req, res) => {
  try {
    const token = await getAccessToken();
    await axios.put('https://api.spotify.com/v1/me/player',
      { device_ids: [req.query.device_id], play: true },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/play', async (req, res) => {
  try {
    const token = await getAccessToken();
    await axios.put('https://api.spotify.com/v1/me/player/play', {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/pause', async (req, res) => {
  try {
    const token = await getAccessToken();
    await axios.put('https://api.spotify.com/v1/me/player/pause', {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/next', async (req, res) => {
  try {
    const token = await getAccessToken();
    await axios.post('https://api.spotify.com/v1/me/player/next', {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/previous', async (req, res) => {
  try {
    const token = await getAccessToken();
    await axios.post('https://api.spotify.com/v1/me/player/previous', {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/volume', async (req, res) => {
  try {
    const token = await getAccessToken();
    await axios.put(`https://api.spotify.com/v1/me/player/volume?volume_percent=${req.query.volume}`, {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/search', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { data } = await axios.get(`https://api.spotify.com/v1/search?q=${encodeURIComponent(req.query.q)}&type=track&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/queue', async (req, res) => {
  try {
    const token = await getAccessToken();
    await axios.post(`https://api.spotify.com/v1/me/player/queue?uri=${req.query.uri}`, {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT || 3000, () => console.log(`Server su porta ${PORT || 3000}`));