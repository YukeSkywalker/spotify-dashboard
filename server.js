'use strict';

// Carica le variabili d'ambiente dal file .env (SPOTIFY_CLIENT_ID, SECRET, ecc.)
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const crypto  = require('crypto');
const path    = require('path');

const app    = express();
const PORT   = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Credenziali Spotify e Gemini lette dall'environment
const CLIENT_ID      = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET  = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI   = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const GEMINI_KEY     = process.env.GEMINI_API_KEY || '';

if (!CLIENT_ID || !CLIENT_SECRET) console.warn('⚠  Credenziali Spotify mancanti! Controlla il file .env');

// Permessi OAuth che richiediamo all'utente Spotify
const SCOPES = [
  'user-read-private',          // dati profilo utente
  'user-read-email',            // email utente
  'user-top-read',              // top tracks/artists
  'user-read-recently-played',  // brani recenti
  'user-read-playback-state',   // stato riproduzione
  'user-modify-playback-state', // controllo riproduzione (play/pause/skip)
  'user-read-currently-playing',// brano corrente
  'playlist-read-private',      // lettura playlist private
  'playlist-read-collaborative',// lettura playlist collaborative
  'playlist-modify-public',     // modifica playlist pubbliche
  'playlist-modify-private',    // modifica playlist private
  'streaming',                  // Web Playback SDK
  'app-remote-control'          // controllo remoto
].join(' ');

// Necessario per far funzionare i cookie sicuri dietro proxy (es. Heroku, Render)
app.set('trust proxy', 1);

// Middleware: parsing JSON e file statici dalla cartella /public
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configurazione sessioni con cookie HTTP-only (sicuro in produzione, lax in locale)
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD,
    httpOnly: true,
    sameSite: IS_PROD ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000  // 7 giorni
  }
}));

/* ══════════════════════════════════════════════════════════════════
   SPOTIFY HELPERS
   Funzioni di supporto per autenticazione e chiamate API Spotify
══════════════════════════════════════════════════════════════════ */

/**
 * Crea l'header Authorization per le richieste di token Spotify.
 * Spotify usa HTTP Basic Auth con client_id:client_secret in base64.
 */
function basicAuth() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

/**
 * Richiede un token OAuth a Spotify (usato sia per authorization_code che per refresh).
 * @param {Object} body - Parametri da inviare (grant_type, code, refresh_token, ecc.)
 * @returns {Promise<Object>} - Oggetto con access_token, refresh_token, expires_in
 */
async function fetchToken(body) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth()
    },
    body: new URLSearchParams(body).toString()
  });
  if (!r.ok) throw new Error(`token_${r.status}: ${await r.text()}`);
  return r.json();
}

/**
 * Rinnova il token di accesso Spotify usando il refresh_token salvato in sessione.
 * Spotify emette token validi 1 ora; questo viene chiamato automaticamente
 * quando il token è scaduto (o sta per scadere entro 60 secondi).
 * @param {Object} sess - Oggetto sessione Express
 * @returns {Promise<string>} - Nuovo access_token
 */
async function refreshToken(sess) {
  if (!sess.refreshToken) throw new Error('no_refresh_token');
  const d = await fetchToken({
    grant_type: 'refresh_token',
    refresh_token: sess.refreshToken
  });
  sess.accessToken  = d.access_token;
  sess.tokenExpiry  = Date.now() + d.expires_in * 1000;
  // Spotify può restituire un nuovo refresh_token (rotation); salviamolo
  if (d.refresh_token) sess.refreshToken = d.refresh_token;
  return sess.accessToken;
}

/**
 * Restituisce un token valido per l'utente corrente.
 * Se il token è scaduto (o scade entro 60s), lo rinnova automaticamente.
 * @param {Object} sess - Oggetto sessione Express
 * @returns {Promise<string>} - access_token valido
 */
async function validToken(sess) {
  if (!sess.accessToken) throw new Error('not_authenticated');
  if (Date.now() > sess.tokenExpiry - 60_000) return refreshToken(sess);
  return sess.accessToken;
}

/**
 * Wrapper generico per tutte le chiamate all'API Spotify.
 * Gestisce automaticamente:
 * - Aggiunta dell'header Authorization Bearer
 * - Refresh del token in caso di 401
 * - Parsing della risposta JSON
 * - Errori HTTP
 * @param {Object} sess - Sessione Express (contiene il token)
 * @param {string} url  - URL completo endpoint Spotify
 * @param {Object} opts - Opzioni fetch aggiuntive (method, body, headers)
 * @returns {Promise<Object|null>} - Dati JSON o null per risposte 204
 */
async function spotifyFetch(sess, url, opts = {}) {
  // Funzione interna che esegue la richiesta con un determinato token
  const doReq = async (tok) => fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${tok}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });

  let tok = await validToken(sess);
  let res = await doReq(tok);

  // Se 401, proviamo a rinnovare il token UNA volta e ririproviamo
  if (res.status === 401) {
    tok = await refreshToken(sess);
    res = await doReq(tok);
  }

  // 204 No Content: risposta valida ma senza corpo (es. play/pause)
  if (res.status === 204) return null;

  if (!res.ok) {
    const body = await res.text();
    console.error(`Spotify ${res.status} per ${url}:`, body);
    throw new Error(`spotify_${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Middleware di autenticazione per le route API protette.
 * Blocca le richieste di utenti non loggati restituendo 401.
 */
function guard(req, res, next) {
  if (!req.session.accessToken) return res.status(401).json({ error: 'not_authenticated' });
  next();
}

/**
 * Helper centralizzato per la gestione degli errori nelle route API.
 * Converte gli errori interni in risposte HTTP appropriate.
 * @param {Response} res - Oggetto risposta Express
 * @param {Error} err    - Errore catturato
 */
function apiError(res, err) {
  console.error('API err:', err.message);
  if (err.message === 'not_authenticated')      return res.status(401).json({ error: 'not_authenticated' });
  if (err.message?.includes('spotify_403'))     return res.status(403).json({ error: 'premium_required' });
  if (err.message?.includes('spotify_404'))     return res.status(404).json({ error: 'not_found' });
  res.status(500).json({ error: err.message });
}

/* ══════════════════════════════════════════════════════════════════
   OAUTH — LOGIN / CALLBACK / LOGOUT
══════════════════════════════════════════════════════════════════ */

/**
 * Avvia il flusso OAuth Spotify.
 * Genera uno state casuale (protezione CSRF) e redirige l'utente alla
 * pagina di autorizzazione Spotify con tutti i permessi richiesti.
 */
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  req.session.save(err => {
    if (err) return res.redirect('/?error=session_error');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     CLIENT_ID,
      scope:         SCOPES,
      redirect_uri:  REDIRECT_URI,
      state,
      show_dialog: 'true' // Mostra sempre il dialogo di conferma Spotify
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params}`);
  });
});

/**
 * Callback OAuth: Spotify redirige qui dopo che l'utente ha autorizzato (o negato).
 * Verifica lo state (anti-CSRF), scambia il code con i token e salva in sessione.
 */
app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);

  // Verifica anti-CSRF: lo state deve corrispondere a quello salvato prima del redirect
  if (!state || state !== req.session.oauthState)
    return res.redirect('/?error=state_mismatch');

  delete req.session.oauthState;

  try {
    const d = await fetchToken({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
    });
    req.session.accessToken  = d.access_token;
    req.session.refreshToken = d.refresh_token;
    req.session.tokenExpiry  = Date.now() + d.expires_in * 1000;
    req.session.save(err => {
      if (err) return res.redirect('/?error=session_error');
      res.redirect('/app');
    });
  } catch (e) {
    console.error('callback error:', e.message);
    res.redirect('/?error=token_failed');
  }
});

/**
 * Logout: distrugge la sessione e redirige alla homepage.
 */
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

/* ══════════════════════════════════════════════════════════════════
   API — STATO E PROFILO
══════════════════════════════════════════════════════════════════ */

/**
 * Controlla se l'utente è autenticato (usato dal frontend al caricamento pagina).
 */
app.get('/api/status', (req, res) =>
  res.json({ authenticated: !!req.session.accessToken })
);

/**
 * Restituisce il profilo dell'utente corrente (nome, avatar, piano, ecc.).
 */
app.get('/api/me', guard, async (req, res) => {
  try { res.json(await spotifyFetch(req.session, 'https://api.spotify.com/v1/me')); }
  catch (e) { apiError(res, e); }
});

/* ══════════════════════════════════════════════════════════════════
   API — TOP TRACKS E TOP ARTISTS
══════════════════════════════════════════════════════════════════ */

/**
 * Top tracks dell'utente.
 * @param time_range - short_term (4 sett.), medium_term (6 mesi), long_term (sempre)
 * @param limit      - numero di brani (max 50)
 */
app.get('/api/top-tracks', guard, async (req, res) => {
  const { time_range = 'medium_term', limit = 50 } = req.query;
  try {
    res.json(await spotifyFetch(req.session,
      `https://api.spotify.com/v1/me/top/tracks?time_range=${time_range}&limit=${limit}`
    ));
  } catch (e) { apiError(res, e); }
});

/**
 * Top artists dell'utente.
 * Nota: l'API Spotify a volte omette i followers nei risultati top-artists,
 * quindi eseguiamo un arricchimento aggiuntivo per gli artisti che ne sono privi.
 * @param time_range - short_term / medium_term / long_term
 * @param limit      - numero di artisti (max 50)
 */
app.get('/api/top-artists', guard, async (req, res) => {
  const { time_range = 'medium_term', limit = 50 } = req.query;
  try {
    const data = await spotifyFetch(req.session,
      `https://api.spotify.com/v1/me/top/artists?time_range=${time_range}&limit=${limit}`
    );

    // Arricchimento: gli artisti senza followers.total vengono ricaricati singolarmente
    // Spotify /v1/artists?ids= accetta fino a 50 ID per richiesta
    const needEnrich = (data.items || []).filter(a => a.followers?.total == null);
    if (needEnrich.length > 0) {
      const ids = needEnrich.slice(0, 50).map(a => a.id).join(',');
      try {
        const enriched = await spotifyFetch(req.session,
          `https://api.spotify.com/v1/artists?ids=${ids}`
        );
        const map = {};
        (enriched.artists || []).forEach(a => { map[a.id] = a; });
        data.items = data.items.map(a =>
          map[a.id]
            ? { ...a, followers: map[a.id].followers, images: map[a.id].images || a.images, popularity: map[a.id].popularity }
            : a
        );
      } catch (_) { /* arricchimento best-effort: se fallisce continuiamo comunque */ }
    }

    res.json(data);
  } catch (e) { apiError(res, e); }
});

/* ══════════════════════════════════════════════════════════════════
   API — BRANI RECENTI
══════════════════════════════════════════════════════════════════ */

/**
 * Ultimi 50 brani ascoltati dall'utente.
 */
app.get('/api/recent', guard, async (req, res) => {
  try {
    res.json(await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player/recently-played?limit=50'
    ));
  } catch (e) { apiError(res, e); }
});

/* ══════════════════════════════════════════════════════════════════
   API — PLAYLIST
══════════════════════════════════════════════════════════════════ */

/**
 * Legge TUTTE le playlist dell'utente con paginazione automatica.
 * Spotify restituisce max 50 playlist per pagina; seguiamo il campo "next"
 * finché non è null per raccoglierle tutte.
 */
app.get('/api/playlists', guard, async (req, res) => {
  try {
    const allItems = [];
    let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
    while (url) {
      const page = await spotifyFetch(req.session, url);
      if (!page) break;
      allItems.push(...(page.items || []));
      url = page.next || null; // "next" è null quando siamo all'ultima pagina
    }
    res.json({ items: allItems, total: allItems.length });
  } catch (e) { apiError(res, e); }
});

/**
 * Legge i brani di una playlist specifica con paginazione automatica.
 * Usiamo market=IT per filtrare i brani disponibili in Italia.
 * @param id - ID della playlist Spotify
 */
app.get('/api/playlists/:id/tracks', guard, async (req, res) => {
  try {
    const allItems = [];
    let url = `https://api.spotify.com/v1/playlists/${req.params.id}/tracks?limit=100&market=IT`;
    while (url) {
      const page = await spotifyFetch(req.session, url);
      if (!page) break;
      allItems.push(...(page.items || []));
      url = page.next || null;
    }
    res.json({ items: allItems, total: allItems.length });
  } catch (e) { apiError(res, e); }
});

/**
 * Crea una nuova playlist privata nell'account dell'utente.
 * Viene usata dalla sezione AI Consigli per salvare i suggerimenti Gemini.
 */
app.post('/api/playlists', guard, async (req, res) => {
  try {
    const me = await spotifyFetch(req.session, 'https://api.spotify.com/v1/me');
    res.json(await spotifyFetch(req.session,
      `https://api.spotify.com/v1/users/${me.id}/playlists`,
      {
        method: 'POST',
        body: JSON.stringify({
          name:        req.body.name        || 'Nuova Playlist',
          description: req.body.description || '',
          public: false
        })
      }
    ));
  } catch (e) { apiError(res, e); }
});

/**
 * Aggiunge brani a una playlist esistente.
 * @param id         - ID playlist
 * @body  uris       - Array di URI Spotify (es. ["spotify:track:xxx", ...])
 */
app.post('/api/playlists/:id/tracks', guard, async (req, res) => {
  try {
    res.json(await spotifyFetch(req.session,
      `https://api.spotify.com/v1/playlists/${req.params.id}/tracks`,
      { method: 'POST', body: JSON.stringify({ uris: req.body.uris }) }
    ));
  } catch (e) { apiError(res, e); }
});

/* ══════════════════════════════════════════════════════════════════
   API — ARTISTI
══════════════════════════════════════════════════════════════════ */

/**
 * Top brani di un artista specifico (mercato italiano).
 */
app.get('/api/artists/:id/top-tracks', guard, async (req, res) => {
  try {
    res.json(await spotifyFetch(req.session,
      `https://api.spotify.com/v1/artists/${req.params.id}/top-tracks?market=IT`
    ));
  } catch (e) { apiError(res, e); }
});

/**
 * Informazioni complete su un artista (follower, generi, popolarità, immagini).
 */
app.get('/api/artists/:id', guard, async (req, res) => {
  try {
    res.json(await spotifyFetch(req.session,
      `https://api.spotify.com/v1/artists/${req.params.id}`
    ));
  } catch (e) { apiError(res, e); }
});

/**
 * Album e singoli di un artista (mercato italiano, max 20).
 */
app.get('/api/artists/:id/albums', guard, async (req, res) => {
  try {
    res.json(await spotifyFetch(req.session,
      `https://api.spotify.com/v1/artists/${req.params.id}/albums?market=IT&limit=20&include_groups=album,single`
    ));
  } catch (e) { apiError(res, e); }
});

/* ══════════════════════════════════════════════════════════════════
   API — RICERCA (usata internamente dall'AI per trovare URI)
══════════════════════════════════════════════════════════════════ */

/**
 * Cerca un brano per nome+artista e restituisce l'URI Spotify.
 * Usata dalla sezione AI per risolvere i brani suggeriti in URI riproducibili.
 * @param track  - Nome del brano
 * @param artist - Nome dell'artista (opzionale, migliora la precisione)
 */
app.get('/api/search-uri', guard, async (req, res) => {
  const { track, artist } = req.query;
  if (!track) return res.status(400).json({ error: 'track_required' });
  try {
    // Ricerca avanzata Spotify: "track:Nome artist:Artista" è più precisa di una query libera
    const q = artist ? `track:${track} artist:${artist}` : track;
    const d = await spotifyFetch(req.session,
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1&market=IT`
    );
    const item = d.tracks?.items?.[0];
    if (!item) return res.json({ found: false });
    res.json({
      found:       true,
      uri:         item.uri,
      name:        item.name,
      artist:      item.artists?.[0]?.name,
      album_art:   item.album?.images?.[0]?.url,
      duration_ms: item.duration_ms
    });
  } catch (e) { apiError(res, e); }
});

/* ══════════════════════════════════════════════════════════════════
   API — PLAYER (controllo riproduzione)
   Richiedono Spotify Premium per funzionare
══════════════════════════════════════════════════════════════════ */

/** Brano attualmente in riproduzione + stato dispositivo */
app.get('/api/current', guard, async (req, res) => {
  try {
    res.json(await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player'
    ) || { is_playing: false, item: null });
  } catch (e) { apiError(res, e); }
});

/** Lista dispositivi attivi dell'utente */
app.get('/api/devices', guard, async (req, res) => {
  try {
    res.json(await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player/devices'
    ));
  } catch (e) { apiError(res, e); }
});

/** Avvia la riproduzione (opzionalmente con URI specifici) */
app.put('/api/play', guard, async (req, res) => {
  try {
    await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player/play',
      { method: 'PUT', body: JSON.stringify(req.body || {}) }
    );
    res.json({ ok: true });
  } catch (e) { apiError(res, e); }
});

/** Mette in pausa la riproduzione */
app.put('/api/pause', guard, async (req, res) => {
  try {
    await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player/pause',
      { method: 'PUT' }
    );
    res.json({ ok: true });
  } catch (e) { apiError(res, e); }
});

/** Salta al brano successivo */
app.post('/api/next', guard, async (req, res) => {
  try {
    await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player/next',
      { method: 'POST' }
    );
    res.json({ ok: true });
  } catch (e) { apiError(res, e); }
});

/** Torna al brano precedente */
app.post('/api/prev', guard, async (req, res) => {
  try {
    await spotifyFetch(req.session,
      'https://api.spotify.com/v1/me/player/previous',
      { method: 'POST' }
    );
    res.json({ ok: true });
  } catch (e) { apiError(res, e); }
});

/** Imposta il volume (0-100) */
app.put('/api/volume', guard, async (req, res) => {
  try {
    await spotifyFetch(req.session,
      `https://api.spotify.com/v1/me/player/volume?volume_percent=${req.body.volume_percent}`,
      { method: 'PUT' }
    );
    res.json({ ok: true });
  } catch (e) { apiError(res, e); }
});

/* ══════════════════════════════════════════════════════════════════
   API — GEMINI AI: GENERI PREFERITI
   Analizza le top 50 tracks dell'utente per identificare i generi
   musicali dominanti tramite l'AI di Google Gemini.
══════════════════════════════════════════════════════════════════ */

/**
 * Analisi generi con Gemini AI.
 *
 * Il flusso è:
 * 1. Il client invia la lista delle top tracks (nome, artista, album) e
 *    dei top artists (nome, generi già noti da Spotify)
 * 2. Costruiamo un prompt dettagliato per Gemini che chiede di analizzare
 *    il profilo musicale e identificare i TOP 3 generi
 * 3. Gemini risponde in JSON puro con nome genere, percentuale stima e spiegazione
 * 4. Restituiamo i dati al frontend per la visualizzazione
 *
 * @body topTracks  - Array [{name, artist, album}, ...]
 * @body topArtists - Array [{name, genres: [...]}, ...]
 */
app.post('/api/ai/genres', guard, async (req, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ error: 'gemini_not_configured' });

  const { topTracks = [], topArtists = [] } = req.body;

  // Costruiamo una lista leggibile dei brani per il prompt
  const tracksText = topTracks.slice(0, 50)
    .map((t, i) => `${i + 1}. "${t.name}" di ${t.artist}${t.album ? ` (album: ${t.album})` : ''}`)
    .join('\n');

  // Costruiamo una lista degli artisti con i loro generi Spotify (se disponibili)
  const artistsText = topArtists.slice(0, 20)
    .map(a => `- ${a.name}${a.genres?.length ? `: ${a.genres.slice(0, 3).join(', ')}` : ''}`)
    .join('\n');

  // Prompt ottimizzato per ottenere un'analisi musicale precisa in italiano
  // con output JSON strutturato — NON vuole markdown o testo extra
  const prompt = `Sei un esperto critico musicale e analista di dati Spotify.

L'utente ha ascoltato principalmente questi brani (top 50):
${tracksText}

I suoi artisti più ascoltati (con generi Spotify):
${artistsText}

Analizza profondamente questo profilo musicale e identifica i TOP 3 GENERI DOMINANTI.
Considera: le sonorità degli artisti, le caratteristiche degli album, i generi Spotify già noti, e le tendenze stilistiche.

Rispondi ESCLUSIVAMENTE con un JSON valido, senza markdown, senza testo aggiuntivo:
{
  "top_genres": [
    {
      "name": "nome genere in italiano (es. Hip-Hop, Rock Alternativo, Electronic)",
      "percentage": 45,
      "description": "spiegazione di 1-2 frasi in italiano su perché questo genere domina",
      "key_artists": ["artista1", "artista2", "artista3"]
    },
    {
      "name": "secondo genere",
      "percentage": 30,
      "description": "spiegazione breve",
      "key_artists": ["artista1", "artista2"]
    },
    {
      "name": "terzo genere",
      "percentage": 25,
      "description": "spiegazione breve",
      "key_artists": ["artista1"]
    }
  ],
  "overall_vibe": "descrizione del gusto musicale complessivo in 1 frase italiana",
  "fun_fact": "curiosità interessante sulle sue scelte musicali in italiano"
}`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,      // Creatività moderata per analisi bilanciata
            maxOutputTokens: 1200  // Sufficiente per i 3 generi con descrizioni
          }
        })
      }
    );

    if (!r.ok) throw new Error(`gemini_${r.status}: ${await r.text()}`);

    const gd   = await r.json();
    let   text = gd.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Pulizia: rimuoviamo eventuali backtick markdown che Gemini aggiunge a volte
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    // Estraiamo il JSON anche se c'è testo prima/dopo
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no_json_in_gemini_response');

    res.json(JSON.parse(match[0]));

  } catch (e) {
    console.error('Gemini genres error:', e.message);
    res.status(500).json({ error: 'ai_error', detail: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════════
   API — GEMINI AI: RACCOMANDAZIONI MUSICALI
   Genera suggerimenti di artisti e brani personalizzati
══════════════════════════════════════════════════════════════════ */

/**
 * Genera raccomandazioni personalizzate con Gemini.
 * Prende in input artisti, brani e generi top dell'utente e restituisce
 * suggerimenti con spiegazioni, un nome di playlist creativo e un vibe.
 *
 * @body topArtists - Array di nomi artisti
 * @body topTracks  - Array di nomi brani
 * @body topGenres  - Array di nomi generi
 */
app.post('/api/ai/recommend', guard, async (req, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ error: 'gemini_not_configured' });

  const { topTracks, topArtists, topGenres } = req.body;

  const prompt = `Sei un esperto musicale AI. Profilo utente:
Artisti top: ${(topArtists || []).slice(0, 6).join(', ')}.
Brani top: ${(topTracks || []).slice(0, 6).join(', ')}.
Generi: ${(topGenres || []).slice(0, 5).join(', ')}.
Rispondi SOLO con JSON puro, nessun testo, nessun markdown:
{"summary":"analisi 2 frasi in italiano","mood":"vibe 3-4 parole italiano","playlist_name":"nome creativo italiano","recommendations":[{"type":"artist","name":"...","reason":"..."},{"type":"artist","name":"...","reason":"..."},{"type":"artist","name":"...","reason":"..."},{"type":"track","name":"...","artist":"...","reason":"..."},{"type":"track","name":"...","artist":"...","reason":"..."},{"type":"track","name":"...","artist":"...","reason":"..."},{"type":"track","name":"...","artist":"...","reason":"..."},{"type":"track","name":"...","artist":"...","reason":"..."}]}`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.85, maxOutputTokens: 1500 }
        })
      }
    );
    if (!r.ok) throw new Error(`gemini_${r.status}: ${await r.text()}`);

    const gd   = await r.json();
    let   text = gd.candidates?.[0]?.content?.parts?.[0]?.text || '';
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no_json_in_response');
    res.json(JSON.parse(match[0]));

  } catch (e) {
    console.error('Gemini recommend error:', e.message);
    res.status(500).json({ error: 'ai_error', detail: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════════
   PAGINE HTML
══════════════════════════════════════════════════════════════════ */

/**
 * Homepage: se l'utente è già loggato lo manda a /app, altrimenti mostra index.html
 */
app.get('/', (req, res) => {
  if (req.session.accessToken) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * App principale: se NON loggato rimanda alla homepage, altrimenti serve app.html
 */
app.get('/app', (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.listen(PORT, () =>
  console.log(`✅ Melodia → http://localhost:${PORT}`)
);
