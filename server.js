require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'spotify_pro_dash_secret_99',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 3600000 * 24
    }
}));

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, REDIRECT_URI } = process.env;

// Helper Fetch con gestione 204 No Content e Auto-Refresh
async function spotifyFetch(url, req, options = {}) {
    if (Date.now() > req.session.tokenExpiry) {
        const refresh = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')
            },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: req.session.refreshToken })
        });
        const data = await refresh.json();
        req.session.accessToken = data.access_token;
        req.session.tokenExpiry = Date.now() + (data.expires_in * 1000);
    }

    const response = await fetch(url, {
        ...options,
        headers: {
            ...options.headers,
            'Authorization': `Bearer ${req.session.accessToken}`,
            'Content-Type': 'application/json'
        }
    });

    if (response.status === 204) return null;
    if (!response.ok) {
        const err = await response.text();
        throw new Error(err || response.statusText);
    }
    return response.json();
}

// AUTH ROUTES
app.get('/login', (req, res) => {
    const scopes = 'user-read-private user-read-email user-top-read user-read-recently-played playlist-read-private user-modify-playback-state user-read-playback-state user-read-currently-playing';
    res.redirect(`https://accounts.spotify.com/authorize?response_type=code&client_id=${SPOTIFY_CLIENT_ID}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`);
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
    });
    const data = await response.json();
    req.session.accessToken = data.access_token;
    req.session.refreshToken = data.refresh_token;
    req.session.tokenExpiry = Date.now() + (data.expires_in * 1000);
    res.redirect('/app.html');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// API ENDPOINTS
const authMiddleware = (req, res, next) => req.session.accessToken ? next() : res.status(401).json({ error: 'Auth required' });

app.get('/api/me', authMiddleware, async (req, res) => res.json(await spotifyFetch('https://api.spotify.com/v1/me', req)));
app.get('/api/top-tracks', authMiddleware, async (req, res) => res.json(await spotifyFetch('https://api.spotify.com/v1/me/top/tracks?limit=30&time_range=medium_term', req)));
app.get('/api/top-artists', authMiddleware, async (req, res) => res.json(await spotifyFetch('https://api.spotify.com/v1/me/top/artists?limit=20', req)));
app.get('/api/recent', authMiddleware, async (req, res) => res.json(await spotifyFetch('https://api.spotify.com/v1/me/player/recently-played?limit=20', req)));
app.get('/api/playlists', authMiddleware, async (req, res) => res.json(await spotifyFetch('https://api.spotify.com/v1/me/playlists?limit=20', req)));
app.get('/api/search', authMiddleware, async (req, res) => res.json(await spotifyFetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(req.query.q)}&type=track,artist&limit=10`, req)));
app.get('/api/current', authMiddleware, async (req, res) => res.json(await spotifyFetch('https://api.spotify.com/v1/me/player/currently-playing', req)));

app.post('/api/play', authMiddleware, async (req, res) => {
    try {
        await spotifyFetch('https://api.spotify.com/v1/me/player/play', req, {
            method: 'PUT',
            body: JSON.stringify(req.body.uri ? { uris: [req.body.uri] } : {})
        });
        res.json({ success: true });
    } catch (e) { res.status(404).json({ error: 'Nessun dispositivo attivo trovato.' }); }
});

app.post('/api/pause', authMiddleware, async (req, res) => {
    await spotifyFetch('https://api.spotify.com/v1/me/player/pause', req, { method: 'PUT' });
    res.json({ success: true });
});

app.post('/api/next', authMiddleware, async (req, res) => {
    await spotifyFetch('https://api.spotify.com/v1/me/player/next', req, { method: 'POST' });
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
