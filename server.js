const express = require('express');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.set('trust proxy', 1);
app.use(express.static('public'));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, sameSite: 'none', maxAge: 3600000 }
}));

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, REDIRECT_URI } = process.env;

// Helper per fetch con refresh token
async function spotifyFetch(url, req, options = {}) {
    if (Date.now() > req.session.expires_at) {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
            },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: req.session.refresh_token })
        });
        const data = await response.json();
        req.session.access_token = data.access_token;
        req.session.expires_at = Date.now() + (data.expires_in * 1000);
    }
    const res = await fetch(url, {
        ...options,
        headers: { ...options.headers, 'Authorization': `Bearer ${req.session.access_token}`, 'Content-Type': 'application/json' }
    });
    return res.status === 204 ? null : res.json();
}

// AUTH ROUTES
app.get('/login', (req, res) => {
    const scopes = 'user-read-private user-read-email user-top-read user-read-recently-played playlist-read-private user-modify-playback-state user-read-playback-state';
    res.redirect(`https://accounts.spotify.com/authorize?response_type=code&client_id=${SPOTIFY_CLIENT_ID}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`);
});

app.get('/callback', async (req, res) => {
    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: REDIRECT_URI })
    });
    const data = await response.json();
    req.session.access_token = data.access_token;
    req.session.refresh_token = data.refresh_token;
    req.session.expires_at = Date.now() + (data.expires_in * 1000);
    res.redirect('/');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// API ENDPOINTS
const checkAuth = (req, res, next) => req.session.access_token ? next() : res.status(401).send();

app.get('/api/auth-check', (req, res) => res.json({ authenticated: !!req.session.access_token }));
app.get('/api/me', checkAuth, async (req, res) => res.json(await spotifyFetch('https://api.spotify.com/v1/me', req)));
app.get('/api/top-tracks', checkAuth, async (req, res) => res.json((await spotifyFetch('https://api.spotify.com/v1/me/top/tracks?limit=30', req)).items));
app.get('/api/top-artists', checkAuth, async (req, res) => res.json((await spotifyFetch('https://api.spotify.com/v1/me/top/artists?limit=20', req)).items));
app.get('/api/recent', checkAuth, async (req, res) => res.json((await spotifyFetch('https://api.spotify.com/v1/me/player/recently-played?limit=20', req)).items));
app.get('/api/playlists', checkAuth, async (req, res) => res.json((await spotifyFetch('https://api.spotify.com/v1/me/playlists?limit=20', req)).items));
app.get('/api/current', checkAuth, async (req, res) => res.json(await spotifyFetch('https://api.spotify.com/v1/me/player/currently-playing', req)));
app.get('/api/search', checkAuth, async (req, res) => res.json(await spotifyFetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(req.query.q)}&type=track,artist&limit=15`, req)));

app.post('/api/play', checkAuth, async (req, res) => {
    await spotifyFetch('https://api.spotify.com/v1/me/player/play', req, { method: 'PUT', body: JSON.stringify({ uris: [req.body.uri] }) });
    res.json({ success: true });
});
app.post('/api/pause', checkAuth, async (req, res) => { await spotifyFetch('https://api.spotify.com/v1/me/player/pause', req, { method: 'PUT' }); res.json({ success: true }); });
app.post('/api/next', checkAuth, async (req, res) => { await spotifyFetch('https://api.spotify.com/v1/me/player/next', req, { method: 'POST' }); res.json({ success: true }); });

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
