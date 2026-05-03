'use strict';

/* ══════════════════════════════════════════════════════════════════
   STATO GLOBALE — S
   Oggetto singleton che contiene tutto lo stato dell'applicazione.
   Evita variabili globali sparse e rende il debugging più semplice.
══════════════════════════════════════════════════════════════════ */
const S = {
  theme:   localStorage.getItem('mel-theme') || 'dark', // Tema attuale (dark/light)
  section: 'overview',   // Sezione corrente
  user:    null,          // Profilo utente Spotify

  // Cache dati Spotify: evita chiamate API duplicate per la stessa sessione
  cache: {
    tt:      {},   // Top tracks per range (tt['short_term'], ecc.)
    ta:      {},   // Top artists per range
    recent:  null, // Brani recenti
  },

  // Stato del player nella barra inferiore
  player: {
    uri:     null,  // URI del brano in riproduzione
    playing: false, // true se sta suonando
    poll:    null   // ID dell'intervallo di polling
  },

  // Dati sezione AI (Gemini)
  ai: {
    data:       null, // Risultato ultima generazione raccomandazioni
    trackCache: {}    // Cache URI→artwork per i brani AI già risolti
  }
};

/* ══════════════════════════════════════════════════════════════════
   SHORTHAND DOM
   Utility per accedere al DOM in modo compatto
══════════════════════════════════════════════════════════════════ */

/** Seleziona elemento per ID */
const $  = id  => document.getElementById(id);
/** Seleziona tutti gli elementi che corrispondono al selettore CSS */
const $$ = sel => document.querySelectorAll(sel);

/* ══════════════════════════════════════════════════════════════════
   FORMATTATORI
   Funzioni pure per la formattazione dei valori
══════════════════════════════════════════════════════════════════ */

/**
 * Converte millisecondi in formato m:ss (es. 3:42).
 * @param {number} ms - Durata in millisecondi
 * @returns {string}
 */
const fmtMs = ms => {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

/**
 * Converte una data ISO in "tempo fa" leggibile (es. "5m fa", "2h fa").
 * @param {string} iso - Stringa data ISO 8601
 * @returns {string}
 */
const fmtAgo = iso => {
  const d = Date.now() - new Date(iso);
  const m = Math.floor(d / 60000);
  if (m < 1)  return 'Adesso';
  if (m < 60) return `${m}m fa`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h fa`;
  return `${Math.floor(h / 24)}g fa`;
};

/**
 * Formatta numeri grandi con suffissi K/M (es. 1500 → "1.5K").
 * Restituisce '—' per valori null/undefined/NaN.
 * @param {number} n
 * @returns {string}
 */
const fmtK = n => {
  if (n == null || isNaN(+n)) return '—';
  n = +n;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
};

/**
 * Escapa i caratteri HTML speciali per prevenire XSS nelle interpolazioni di template.
 * IMPORTANTE: usare sempre questa funzione prima di inserire dati utente nell'HTML.
 * @param {*} s - Qualsiasi valore da rendere sicuro
 * @returns {string}
 */
const esc = s =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/* ══════════════════════════════════════════════════════════════════
   TOAST — NOTIFICHE TEMPORANEE
══════════════════════════════════════════════════════════════════ */

/**
 * Mostra una notifica toast temporanea nell'angolo dello schermo.
 * Le notifiche scompaiono automaticamente dopo il timeout.
 * @param {string} msg  - Testo della notifica
 * @param {string} type - Tipo: 'ok' (verde) | 'err' (rosso) | 'warn' (giallo) | 'ai' (viola)
 * @param {number} ms   - Durata in ms (default 3500)
 */
function toast(msg, type = 'ok', ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._t); // Cancella timer precedente se toast già visibile
  el._t = setTimeout(() => el.className = 'toast', ms);
}

/* ══════════════════════════════════════════════════════════════════
   API CLIENT
   Wrapper fetch che gestisce autenticazione, errori e redirect
══════════════════════════════════════════════════════════════════ */

/**
 * Funzione centrale per tutte le chiamate alle API del server.
 *
 * Gestisce:
 * - Header Content-Type automatico
 * - Rilevamento sessione scaduta (401) con redirect al login
 * - Parsing JSON della risposta
 * - Propagazione degli errori HTTP
 *
 * @param {string} path  - URL relativo (es. '/api/me')
 * @param {Object} opts  - Opzioni fetch (method, body, headers)
 * @returns {Promise<Object|null>} - Dati JSON o null per 204
 * @throws {Error} - Lancia errore per risposta non-ok (tranne 204)
 */
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });

    // Sessione scaduta: avvisa l'utente e redirige al login dopo 2.8s
    if (res.status === 401) {
      toast('Sessione scaduta — fai di nuovo login', 'err', 5000);
      setTimeout(() => location.href = '/', 2800);
      throw new Error('UNAUTH');
    }

    if (res.status === 204) return null; // No content: risposta valida senza corpo

    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    return d;

  } catch (e) {
    if (e.message !== 'UNAUTH') console.warn('API', path, e.message);
    throw e;
  }
}

/* ══════════════════════════════════════════════════════════════════
   TEMA — DARK / LIGHT
══════════════════════════════════════════════════════════════════ */

/**
 * Applica il tema scelto e lo salva nel localStorage per persistenza.
 * Aggiorna anche le icone dei pulsanti tema nella sidebar e nell'header mobile.
 * @param {string} t - 'dark' oppure 'light'
 */
function applyTheme(t) {
  S.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('mel-theme', t);
  const ic = t === 'dark' ? '☀' : '☾';
  [$('themeBtn'), $('mobTheme')].forEach(el => { if (el) el.textContent = ic; });
}

/* ══════════════════════════════════════════════════════════════════
   NAVIGAZIONE
   Gestisce il routing client-side tra le sezioni dell'app
══════════════════════════════════════════════════════════════════ */

/**
 * Naviga verso una sezione dell'app.
 *
 * Funzionamento:
 * 1. Aggiorna S.section
 * 2. Toglie la classe 'active' da tutte le view e nav items
 * 3. Aggiunge 'active' alla view e nav item corretti
 * 4. Chiude la sidebar mobile
 * 5. Chiama la funzione di caricamento specifica per quella sezione
 *
 * @param {string} s - ID della sezione (es. 'overview', 'top-tracks', 'stats')
 */
function nav(s) {
  S.section = s;

  // Disattiva tutte le view
  $$('.view').forEach(v => v.classList.remove('active'));

  // Aggiorna i bottoni di navigazione
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.s === s));

  // Attiva la view corretta
  const v = $(`view-${s}`);
  if (v) v.classList.add('active');

  closeSidebar();

  // Mappa sezione → funzione di caricamento
  ({
    overview:      loadOverview,
    'top-tracks':  () => loadTT('short_term'),
    'top-artists': () => loadTA('short_term'),
    recent:        loadRecent,
    stats:         loadStats,
    ai:            initAiSection,
    player:        loadPlayerPage
  })[s]?.();
}

/** Apre la sidebar mobile (overlay incluso) */
function openSidebar()  { $('sidebar').classList.add('open'); $('overlay').classList.add('open'); }
/** Chiude la sidebar mobile */
function closeSidebar() { $('sidebar').classList.remove('open'); $('overlay').classList.remove('open'); }

/* ══════════════════════════════════════════════════════════════════
   UTENTE — Caricamento e render profilo
══════════════════════════════════════════════════════════════════ */

/**
 * Carica il profilo utente da Spotify e lo rende nella sidebar.
 * Salva l'utente in S.user per uso futuro (es. creazione playlist).
 * @returns {Promise<Object|null>} - Oggetto utente Spotify o null in caso di errore
 */
async function loadUser() {
  try {
    const u = await api('/api/me');
    S.user = u;
    renderUser(u);
    return u;
  } catch (e) {
    if (e.message === 'UNAUTH') return null;
    $('sbName').textContent = 'Errore profilo';
    toast('Impossibile caricare il profilo', 'err', 6000);
    return null;
  }
}

/**
 * Popola la sidebar con i dati del profilo utente:
 * - Avatar (immagine o placeholder con iniziale)
 * - Nome display
 * - Piano (Free / Premium)
 * - Nome di benvenuto nella panoramica
 *
 * @param {Object} u - Oggetto utente Spotify
 */
function renderUser(u) {
  $('sbName').textContent = u.display_name || u.id || 'Utente';
  $('sbPlan').textContent = u.product === 'premium' ? '✦ Premium' : 'Free';
  $('ovName').textContent = (u.display_name || u.id || 'Ciao').split(' ')[0];

  const img = u.images?.[0]?.url || u.images?.[1]?.url;
  const av  = $('sbAvatar');
  const ph  = $('sbAvatarPh');

  if (img) {
    av.src            = img;
    av.style.display  = 'block';
    ph.style.display  = 'none';
    // Fallback: se l'immagine non carica, mostriamo la lettera iniziale
    av.onerror = () => {
      av.style.display = 'none';
      ph.style.display = 'flex';
      ph.textContent   = (u.display_name || '?')[0].toUpperCase();
    };
  } else {
    av.style.display = 'none';
    ph.style.display = 'flex';
    ph.textContent   = (u.display_name || u.id || '?')[0].toUpperCase();
  }
}

/* ══════════════════════════════════════════════════════════════════
   PANORAMICA — Dashboard principale
══════════════════════════════════════════════════════════════════ */

/**
 * Carica tutti i dati per la schermata Panoramica in parallelo.
 *
 * Usa Promise.allSettled() invece di Promise.all() per gestire i fallimenti
 * parziali: se una chiamata fallisce, le altre continuano comunque.
 * Questo rende la panoramica resiliente a errori di singole API.
 */
async function loadOverview() {
  const [tR, rR, pR, aR] = await Promise.allSettled([
    api('/api/top-tracks?time_range=medium_term&limit=50'),
    api('/api/recent'),
    api('/api/playlists'),
    api('/api/top-artists?time_range=medium_term&limit=5')
  ]);

  const ok = r => r.status === 'fulfilled' && r.value;

  // Top tracks: mostra contatore e lista mini
  if (ok(tR)) {
    $('stTracks').textContent = tR.value.items?.length || '—';
    renderMiniTracks($('ovTracks'), tR.value.items.slice(0, 5));
  }

  // Top artists: mostra contatore e card artista #1
  if (ok(aR)) {
    $('stArtists').textContent = aR.value.items?.length || '—';
    renderOvArtist(aR.value.items[0]);
  }

  // Playlist: mostra solo il contatore
  if (ok(pR)) {
    $('stPlaylists').textContent = pR.value.total || pR.value.items?.length || '—';
  }

  // Recenti: calcola minuti totali e mostra lista mini
  if (ok(rR)) {
    const items = rR.value.items || [];
    $('stMinutes').textContent = Math.round(
      items.reduce((a, i) => a + (i.track?.duration_ms || 0), 0) / 60000
    );
    renderMiniTracks($('ovRecent'), items.slice(0, 5).map(i => i.track));
  }
}

/**
 * Renderizza la card dell'artista più ascoltato nella panoramica.
 * @param {Object} a - Oggetto artista Spotify
 */
function renderOvArtist(a) {
  const el = $('ovArtistCard');
  if (!el || !a) return;
  const fol = a.followers?.total != null ? fmtK(a.followers.total) + ' followers' : '';
  el.innerHTML = `
    <div class="ov-ac">
      <img src="${esc(a.images?.[0]?.url || '')}" alt="" onerror="this.style.display='none'"/>
      <div>
        <div class="ov-ac-lbl">Artista #1</div>
        <div class="ov-ac-name">${esc(a.name)}</div>
        <div class="ov-ac-gen">${(a.genres || []).slice(0, 3).join(' · ') || '—'}</div>
        ${fol ? `<div class="ov-ac-fol">${fol}</div>` : ''}
      </div>
    </div>`;
}

/**
 * Renderizza una lista compatta di brani (usata nella panoramica).
 * @param {Element} el     - Elemento contenitore
 * @param {Array}   tracks - Array di brani Spotify
 */
function renderMiniTracks(el, tracks) {
  if (!el) return;
  if (!tracks?.length) { el.innerHTML = '<div class="empty">Nessun dato</div>'; return; }
  el.innerHTML = tracks.filter(Boolean).map((t, i) => trackRow(t, i, { mini: true })).join('');
}

/* ══════════════════════════════════════════════════════════════════
   TRACK ROW — Template HTML per una riga brano
   Usato in panoramica, top tracks, recenti e statistiche
══════════════════════════════════════════════════════════════════ */

/**
 * Genera l'HTML per una singola riga brano.
 *
 * La riga è cliccabile e avvia la riproduzione tramite playTrack().
 * In modalità "mini" nasconde le metadati aggiuntivi (album, durata).
 *
 * @param {Object}  t         - Oggetto brano Spotify
 * @param {number}  i         - Indice (0-based) per il numero progressivo
 * @param {Object}  opts
 * @param {string}  opts.ago  - Testo "X minuti fa" (per brani recenti)
 * @param {boolean} opts.mini - Se true, nasconde album e durata
 * @returns {string} - HTML della riga
 */
function trackRow(t, i, { ago = null, mini = false } = {}) {
  if (!t) return '';
  const art      = t.album?.images?.[0]?.url || '';
  const artists  = t.artists?.map(a => a.name).join(', ') || '';
  const isPlaying = S.player.uri === t.uri;

  return `
    <div class="track-item${isPlaying ? ' playing' : ''}"
         onclick="playTrack('${esc(t.uri)}','${esc(t.name)}','${esc(t.artists?.[0]?.name || '')}','${esc(art)}')">
      <span class="t-num">${isPlaying ? '▶' : i + 1}</span>
      <div class="t-art-wrap">
        <img class="t-art" src="${esc(art)}" alt="" loading="lazy" onerror="this.style.display='none'"/>
        <div class="t-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
      </div>
      <div class="t-det">
        <div class="t-name">${esc(t.name)}</div>
        <div class="t-art2">${esc(artists)}</div>
      </div>
      ${!mini ? `
        <div class="t-meta">
          <span class="t-alb">${esc(t.album?.name || '')}</span>
          ${ago
            ? `<span class="t-when">${esc(ago)}</span>`
            : `<span class="t-dur">${fmtMs(t.duration_ms || 0)}</span>`
          }
        </div>` : ''}
    </div>`;
}

/* ══════════════════════════════════════════════════════════════════
   TOP TRACKS
══════════════════════════════════════════════════════════════════ */

/**
 * Carica le top tracks per un dato periodo temporale.
 * Usa la cache S.cache.tt[range] per evitare chiamate ripetute.
 * Mostra skeleton loader mentre carica.
 * @param {string} range - 'short_term' | 'medium_term' | 'long_term'
 */
async function loadTT(range) {
  if (S.cache.tt[range]) { renderTT(S.cache.tt[range]); return; }
  $('ttList').innerHTML = skelRows(15);
  try {
    const d = await api(`/api/top-tracks?time_range=${range}&limit=50`);
    S.cache.tt[range] = d.items;
    renderTT(d.items);
  } catch {
    $('ttList').innerHTML = emptyMsg('Impossibile caricare le top tracks');
  }
}

/**
 * Renderizza la lista delle top tracks.
 * @param {Array} tracks - Array di brani Spotify
 */
function renderTT(tracks) {
  if (!tracks?.length) {
    $('ttList').innerHTML = emptyMsg('Nessun dato — ascolta più musica!');
    return;
  }
  $('ttList').innerHTML = tracks.map((t, i) => trackRow(t, i)).join('');
}

/* ══════════════════════════════════════════════════════════════════
   TOP ARTISTS
══════════════════════════════════════════════════════════════════ */

/**
 * Carica i top artists per un dato periodo temporale.
 * Usa la cache S.cache.ta[range]. Mostra skeleton loader.
 * @param {string} range - 'short_term' | 'medium_term' | 'long_term'
 */
async function loadTA(range) {
  if (S.cache.ta[range]) { renderTA(S.cache.ta[range]); return; }
  $('taList').innerHTML = skelArtists(12);
  try {
    const d = await api(`/api/top-artists?time_range=${range}&limit=50`);
    S.cache.ta[range] = d.items;
    renderTA(d.items);
  } catch {
    $('taList').innerHTML = emptyMsg('Impossibile caricare gli artisti');
  }
}

/**
 * Renderizza la griglia degli artisti.
 * Ogni card include: rank, foto, nome, generi, barra di popolarità.
 * @param {Array} artists - Array di artisti Spotify
 */
function renderTA(artists) {
  if (!artists?.length) { $('taList').innerHTML = emptyMsg('Nessun dato'); return; }
  $('taList').innerHTML = artists.map((a, i) => `
    <div class="artist-card">
      <div class="ac-rank">#${i + 1}</div>
      <img class="ac-img"
           src="${esc(a.images?.[0]?.url || '')}"
           alt="${esc(a.name)}"
           loading="lazy"
           onerror="this.style.opacity='0'"/>
      <div class="ac-name">${esc(a.name)}</div>
      <div class="ac-gen">${(a.genres || []).slice(0, 2).join(', ') || '—'}</div>
      ${a.popularity ? `
        <div class="ac-pop">
          <div class="ac-bar">
            <div class="ac-fill" style="width:${a.popularity}%"></div>
          </div>
          <span class="ac-plbl">${a.popularity}</span>
        </div>` : ''}
    </div>`).join('');
}

/* ══════════════════════════════════════════════════════════════════
   RECENTI
══════════════════════════════════════════════════════════════════ */

/**
 * Carica gli ultimi 50 brani ascoltati. Usa cache S.cache.recent.
 */
async function loadRecent() {
  if (S.cache.recent) { renderRecent(S.cache.recent); return; }
  $('recentList').innerHTML = skelRows(15);
  try {
    const d = await api('/api/recent');
    S.cache.recent = d.items;
    renderRecent(d.items);
  } catch {
    $('recentList').innerHTML = emptyMsg('Impossibile caricare i recenti');
  }
}

/**
 * Renderizza i brani recenti con indicazione temporale ("5m fa").
 * @param {Array} items - Array di {track, played_at} da Spotify
 */
function renderRecent(items) {
  if (!items?.length) { $('recentList').innerHTML = emptyMsg('Nessun brano recente'); return; }
  $('recentList').innerHTML = items
    .map((item, i) => {
      if (!item.track) return '';
      return trackRow(item.track, i, { ago: fmtAgo(item.played_at) });
    })
    .join('');
}

/* ══════════════════════════════════════════════════════════════════
   STATISTICHE
   Sezione con analisi approfondita dei gusti musicali
══════════════════════════════════════════════════════════════════ */

/**
 * Carica e renderizza le statistiche musicali dell'utente.
 *
 * Composizione della pagina:
 * 1. 🎸 Generi preferiti — analizzati da Gemini AI (top 3 con %)
 * 2. 📅 Decenni più ascoltati — distribuzione per decade
 * 3. 📊 Riepilogo numerico — minuti, artisti unici, popolarità media
 * 4. 🏆 Top 10 di sempre — brani con playback
 *
 * Carica dati Spotify in parallelo, poi avvia l'analisi Gemini in background.
 */
async function loadStats() {
  const c = $('statsContent');
  if (!c) return;
  c.innerHTML = '<div class="spinner"></div>';

  try {
    // Caricamento parallelo dei dati necessari per le statistiche
    const [tL, aL, rR] = await Promise.all([
      api('/api/top-tracks?time_range=long_term&limit=50'),   // Top tracks di sempre
      api('/api/top-artists?time_range=long_term&limit=50'),  // Top artists di sempre
      api('/api/recent')                                       // Per i minuti recenti
    ]);

    /* ── Calcolo decenni ──
       Raggruppa i brani per decennio di uscita per la sezione "Decenni più ascoltati"
       Esempio: "2019" → decade 2010 */
    const dec = {};
    (tL.items || []).forEach(t => {
      const y = t.album?.release_date?.slice(0, 4);
      if (y) {
        const d = Math.floor(+y / 10) * 10;
        dec[d] = (dec[d] || 0) + 1;
      }
    });

    /* ── Statistiche di riepilogo ── */
    const recMin  = Math.round(
      (rR.items || []).reduce((a, i) => a + (i.track?.duration_ms || 0), 0) / 60000
    );
    const popAvg  = tL.items?.length
      ? Math.round(tL.items.reduce((a, t) => a + (t.popularity || 0), 0) / tL.items.length)
      : 0;
    const uniqArt = new Set(
      (tL.items || []).flatMap(t => (t.artists || []).map(a => a.id))
    ).size;

    // Struttura la pagina con placeholder per la sezione Gemini (viene caricata dopo)
    c.innerHTML = `
      <!-- Generi preferiti — placeholder, poi riempito da Gemini -->
      <div class="stats-section" id="genreSection">
        <div class="stats-h">🎸 Generi preferiti</div>
        <div id="genreContent">
          <div class="genre-ai-loading">
            <div class="spinner"></div>
            <p>Gemini AI sta analizzando i tuoi gusti musicali…</p>
          </div>
        </div>
      </div>

      <!-- Decenni -->
      <div class="stats-section">
        <div class="stats-h">📅 Decenni più ascoltati</div>
        <div class="decade-grid">
          ${Object.entries(dec)
            .sort((a, b) => b[1] - a[1])
            .map(([d, n]) => `
              <div class="dec-card">
                <div class="dec-y">${d}s</div>
                <div class="dec-n">${n} brani</div>
              </div>`)
            .join('')}
        </div>
      </div>

      <!-- Riepilogo numerico -->
      <div class="stats-section">
        <div class="stats-h">📊 Riepilogo</div>
        <div class="sum-grid">
          <div class="sum-card">
            <div class="sum-val">${recMin}</div>
            <div class="sum-lbl">Min. ascoltati (recenti)</div>
          </div>
          <div class="sum-card">
            <div class="sum-val">${tL.items?.length || 0}</div>
            <div class="sum-lbl">Top tracks nel tempo</div>
          </div>
          <div class="sum-card">
            <div class="sum-val">${uniqArt}</div>
            <div class="sum-lbl">Artisti unici</div>
          </div>
          <div class="sum-card">
            <div class="sum-val">${popAvg}</div>
            <div class="sum-lbl">Popolarità media</div>
          </div>
        </div>
      </div>

      <!-- Top 10 di sempre -->
      <div class="stats-section">
        <div class="stats-h">🏆 Top 10 di sempre</div>
        <div class="track-list">
          ${(tL.items || []).slice(0, 10).map((t, i) => trackRow(t, i)).join('')}
        </div>
      </div>`;

    // Avvia l'analisi Gemini in background (non blocca il rendering della pagina)
    loadGeminiGenres(tL.items || [], aL.items || []);

  } catch (e) {
    console.error('loadStats:', e);
    c.innerHTML = emptyMsg('Impossibile caricare le statistiche');
  }
}

/**
 * Chiama l'API Gemini per l'analisi dei generi e aggiorna la sezione "Generi preferiti".
 *
 * Viene chiamata in background dopo il rendering iniziale delle statistiche,
 * in modo da non rallentare il caricamento della pagina.
 *
 * Il flusso:
 * 1. Prepara la lista brani (nome + artista) e artisti (nome + generi Spotify)
 * 2. Chiama POST /api/ai/genres con questi dati
 * 3. Renderizza i 3 generi con barre di progresso animate, artisti chiave, descrizioni
 * 4. Mostra anche "overall_vibe" e "fun_fact" restituiti da Gemini
 *
 * In caso di errore (Gemini non configurato, rate limit, ecc.) mostra un fallback
 * con i generi calcolati direttamente dai metadati Spotify.
 *
 * @param {Array} tracks  - Array di brani Spotify (top long_term)
 * @param {Array} artists - Array di artisti Spotify (top long_term)
 */
async function loadGeminiGenres(tracks, artists) {
  const genreContent = $('genreContent');
  if (!genreContent) return;

  // Prepara i dati da inviare a Gemini
  const topTracks = tracks.slice(0, 50).map(t => ({
    name:   t.name,
    artist: t.artists?.[0]?.name || '',
    album:  t.album?.name || ''
  }));

  const topArtists = artists.slice(0, 20).map(a => ({
    name:   a.name,
    genres: a.genres || []
  }));

  try {
    const data = await api('/api/ai/genres', {
      method: 'POST',
      body:   JSON.stringify({ topTracks, topArtists })
    });

    const genres = data.top_genres || [];

    if (!genres.length) {
      genreContent.innerHTML = '<p class="genre-ai-error">Nessun genere identificato da Gemini.</p>';
      return;
    }

    // Calcolo per normalizzare le barre di percentuale (la più alta = 100%)
    const maxPct = Math.max(...genres.map(g => g.percentage || 0)) || 1;

    genreContent.innerHTML = `
      <!-- Badge Gemini AI in alto a destra della sezione -->
      <div class="genre-ai-badge">✨ Analisi Gemini AI</div>

      <!-- Top 3 generi con barre animate -->
      <div class="genre-ai-list">
        ${genres.map((g, i) => `
          <div class="genre-ai-card">
            <div class="genre-ai-header">
              <!-- Rank numerato con colori diversi per i 3 posti -->
              <span class="genre-ai-rank rank-${i + 1}">#${i + 1}</span>
              <span class="genre-ai-name">${esc(g.name)}</span>
              <span class="genre-ai-pct">${g.percentage || 0}%</span>
            </div>
            <!-- Barra di progresso -->
            <div class="genre-ai-bar-wrap">
              <div class="genre-ai-bar"
                   style="width:${Math.round((g.percentage || 0) / maxPct * 100)}%">
              </div>
            </div>
            <!-- Spiegazione di Gemini sul perché questo genere domina -->
            ${g.description ? `<p class="genre-ai-desc">${esc(g.description)}</p>` : ''}
            <!-- Artisti rappresentativi del genere -->
            ${g.key_artists?.length ? `
              <div class="genre-ai-artists">
                ${g.key_artists.map(a => `<span class="genre-ai-pill">${esc(a)}</span>`).join('')}
              </div>` : ''}
          </div>`).join('')}
      </div>

      <!-- Vibe generale + curiosità -->
      ${data.overall_vibe ? `
        <div class="genre-ai-vibe">
          <span class="genre-ai-vibe-ico">🎵</span>
          <span>${esc(data.overall_vibe)}</span>
        </div>` : ''}

      ${data.fun_fact ? `
        <div class="genre-ai-funfact">
          <span class="genre-ai-funfact-ico">💡</span>
          <span>${esc(data.fun_fact)}</span>
        </div>` : ''}`;

  } catch (e) {
    console.warn('Gemini genres error:', e.message);

    // Fallback: calcola generi dai metadati Spotify (meno preciso ma sempre disponibile)
    const genreMap = {};
    artists.forEach(a => {
      (a.genres || []).forEach(g => {
        if (g) genreMap[g] = (genreMap[g] || 0) + 1;
      });
    });
    const fallbackGenres = Object.entries(genreMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const maxG = fallbackGenres.length ? fallbackGenres[0][1] : 1;

    if (!fallbackGenres.length) {
      genreContent.innerHTML = `
        <p style="color:var(--t3);font-size:.88rem">
          Dati non disponibili — ascolta più musica con artisti che hanno generi su Spotify.
        </p>`;
      return;
    }

    genreContent.innerHTML = `
      <div class="genre-ai-badge genre-ai-badge-fallback">📊 Da metadati Spotify</div>
      <div class="genre-rows">
        ${fallbackGenres.map(([g, n]) => `
          <div class="g-row">
            <span class="g-lbl">${esc(g)}</span>
            <div class="g-track">
              <div class="g-fill" style="width:${Math.round(n / maxG * 100)}%"></div>
            </div>
            <span class="g-cnt">${n}</span>
          </div>`).join('')}
      </div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════
   AI CONSIGLI — Sezione raccomandazioni Gemini
══════════════════════════════════════════════════════════════════ */

/**
 * Inizializza la sezione AI Consigli.
 * Se i risultati sono già in cache (S.ai.data), li mostra direttamente
 * senza rielaborare. Altrimenti mostra il messaggio introduttivo.
 */
function initAiSection() {
  if (S.ai.data) { renderAiResults(S.ai.data); return; }
  $('aiOut').innerHTML = `
    <div class="ai-intro">
      <div class="ai-intro-icon">🤖</div>
      <h3>Raccomandazioni Personalizzate</h3>
      <p>Gemini analizzerà i tuoi ascolti e ti suggerirà artisti e brani nuovi basandosi sui tuoi gusti musicali.</p>
      <p class="ai-note">Puoi anche creare una playlist Spotify con i brani consigliati in un click.</p>
    </div>`;
}

/**
 * Genera raccomandazioni musicali personalizzate tramite Gemini.
 *
 * Flusso:
 * 1. Carica top tracks (short_term) e top artists dell'utente
 * 2. Estrae generi dagli artisti
 * 3. Chiama POST /api/ai/recommend con questi dati
 * 4. Memorizza il risultato in S.ai.data e lo renderizza
 *
 * Chiamato dal click del bottone "✨ Genera Consigli"
 */
async function generateAiRecommendations() {
  const btn = $('aiGenBtn');
  const out = $('aiOut');

  btn.disabled     = true;
  btn.textContent  = '✨ Generazione…';

  out.innerHTML = `
    <div class="spinner"></div>
    <p style="text-align:center;color:var(--t3);font-size:.85rem;margin-top:.5rem">
      Analisi dei tuoi gusti in corso…
    </p>`;

  try {
    // Carica dati necessari per il prompt Gemini
    const [ttRes, taRes] = await Promise.all([
      api('/api/top-tracks?time_range=short_term&limit=20'),
      api('/api/top-artists?time_range=short_term&limit=20')
    ]);

    const tracks  = (ttRes.items || []).map(t => t.name + ' – ' + (t.artists?.[0]?.name || ''));
    const artists = (taRes.items || []).map(a => a.name);

    // Raccoglie tutti i generi univoci dai top artists
    const genreSet = new Set();
    (taRes.items || []).forEach(a => (a.genres || []).forEach(g => genreSet.add(g)));
    const genres = [...genreSet].slice(0, 10);

    // Chiama Gemini per le raccomandazioni
    const data = await api('/api/ai/recommend', {
      method: 'POST',
      body:   JSON.stringify({ topTracks: tracks, topArtists: artists, topGenres: genres })
    });

    S.ai.data = data; // Salva in cache per evitare rigenerazioni
    renderAiResults(data);
    toast('✨ Raccomandazioni generate!', 'ai');

  } catch (e) {
    console.error('AI generate error:', e);
    out.innerHTML = emptyMsg('Errore generazione AI — verifica la chiave Gemini');
    toast('Errore AI', 'err');
  } finally {
    btn.disabled    = false;
    btn.textContent = '✨ Genera Consigli';
  }
}

/**
 * Renderizza i risultati AI: mood, summary, artisti consigliati, brani consigliati.
 * Dopo il render, avvia in background il caricamento degli artwork per i brani AI.
 * @param {Object} data - Oggetto risposta da /api/ai/recommend
 */
function renderAiResults(data) {
  const out = $('aiOut');
  const tracks  = (data.recommendations||[]).filter(r=>r.type==='track');
  const artists = (data.recommendations||[]).filter(r=>r.type==='artist');

  out.innerHTML=`
    <div class="ai-result">
      <div class="ai-header-card">
        <div class="ai-header-top">
          <div class="ai-mood-pill">🎵 ${esc(data.mood||'Il tuo vibe')}</div>
          <button class="ai-regen-btn" onclick="S.ai.data=null;generateAiRecommendations()">↺ Rigenera</button>
        </div>
        <p class="ai-summary">${esc(data.summary||'')}</p>
        ${data.playlist_name?`<div class="ai-pl-suggestion">💿 Playlist suggerita: <strong>"${esc(data.playlist_name)}"</strong></div>`:''}
      </div>

      ${artists.length?`
      <div class="ai-section">
        <div class="ai-section-title">👤 Artisti consigliati</div>
        <div class="ai-artist-grid">
          ${artists.map(a=>`
            <div class="ai-artist-card">
              <div class="ai-artist-initial">${esc(a.name[0]||'?')}</div>
              <div class="ai-artist-name">${esc(a.name)}</div>
              <div class="ai-artist-reason">${esc(a.reason)}</div>
              <button class="ai-search-spotify" onclick="searchAndNav('${esc(a.name)}')">
                <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
                Cerca su Spotify
              </button>
            </div>`).join('')}
        </div>
      </div>`:''}

      ${tracks.length?`
      <div class="ai-section">
        <div class="ai-section-title">🎵 Brani consigliati</div>
        <div class="ai-tracks-list" id="aiTracksList">
          ${tracks.map((t,i)=>`
            <div class="ai-track-item" id="ait-${i}">
              <div class="ai-track-num">${i+1}</div>
              <div class="ai-track-art" id="ait-art-${i}"><span class="ai-track-art-ph">♫</span></div>
              <div class="ai-track-det">
                <div class="ai-track-name">${esc(t.name)}</div>
                <div class="ai-track-artist">${esc(t.artist||'')}</div>
                <div class="ai-track-reason">${esc(t.reason)}</div>
              </div>
              <div class="ai-track-actions">
                <button class="ai-play-btn" id="ait-play-${i}" onclick="aiPlayTrack(${i},'${esc(t.name)}','${esc(t.artist||'')}')">
                  <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </button>
                <button class="ai-search-btn-sm" onclick="searchAndNav('${esc(t.name+' '+t.artist)}')">
                  <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
                </button>
              </div>
            </div>`).join('')}
        </div>
        <div class="ai-create-pl-wrap">
          <button class="ai-create-pl-btn" id="aiCreatePlBtn" onclick="createAiPlaylist()">
            <svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>
            Crea Playlist su Spotify
          </button>
          <p class="ai-create-pl-note">Creerà una playlist con i brani sopra nel tuo account Spotify</p>
        </div>
      </div>`:''}
    </div>`;

  if (tracks.length) loadAiTrackData(tracks);
}


/**
 * Risolve in background ogni brano AI in un URI Spotify reale.
 * Cerca ogni brano tramite /api/search-uri e aggiorna:
 * - S.ai.trackCache[i] con URI e artwork
 * - L'elemento DOM ait-art-{i} con l'immagine dell'album
 *
 * Sequenziale (non parallela) per evitare di sovraccaricare l'API Spotify.
 *
 * @param {Array} tracks - Array di {name, artist} da Gemini
 */
async function loadAiTrackData(tracks) {
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    try {
      const d = await api(
        `/api/search-uri?track=${encodeURIComponent(t.name)}&artist=${encodeURIComponent(t.artist || '')}`
      );
      if (d && d.found) {
        // Salva in cache per uso futuro (play, crea playlist)
        S.ai.trackCache[i] = { uri: d.uri, name: d.name, artist: d.artist, art: d.album_art };
        // Aggiorna l'immagine nell'elemento DOM corrispondente
        const artEl = $(`ait-art-${i}`);
        if (artEl && d.album_art) {
          artEl.innerHTML = `<img src="${esc(d.album_art)}" alt="" onerror="this.innerHTML='♫'"/>`;
        }
      }
    } catch (_) { /* errore singolo non blocca gli altri */ }
  }
}

/**
 * Riproduce un brano AI cercandolo prima nella cache locale.
 * Se non è in cache, lo risolve tramite /api/search-uri.
 * @param {number} idx    - Indice del brano nell'array AI
 * @param {string} name   - Nome del brano
 * @param {string} artist - Nome dell'artista
 */
async function aiPlayTrack(idx, name, artist) {
  const cached = S.ai.trackCache[idx];
  if (cached?.uri) {
    await playTrack(cached.uri, cached.name || name, cached.artist || artist, cached.art || '');
    return;
  }
  try {
    const d = await api(
      `/api/search-uri?track=${encodeURIComponent(name)}&artist=${encodeURIComponent(artist)}`
    );
    if (d && d.found) {
      S.ai.trackCache[idx] = { uri: d.uri, name: d.name, artist: d.artist, art: d.album_art };
      await playTrack(d.uri, d.name, d.artist, d.album_art || '');
    } else {
      toast('Brano non trovato su Spotify', 'warn');
    }
  } catch {
    toast('Impossibile trovare il brano', 'warn');
  }
}

/**
 * Crea una playlist Spotify con i brani AI consigliati.
 *
 * Flusso:
 * 1. Raccoglie gli URI dalla cache (o li risolve al volo per quelli mancanti)
 * 2. Crea una nuova playlist privata tramite POST /api/playlists
 * 3. Aggiunge i brani trovati alla playlist tramite POST /api/playlists/:id/tracks
 * 4. Invalida la cache delle playlist per forzare refresh alla prossima visita
 */
async function createAiPlaylist() {
  if (!S.ai.data) return;
  const btn = $('aiCreatePlBtn');
  if (!btn) return;
  btn.disabled    = true;
  btn.textContent = '⏳ Creazione…';

  try {
    const tracks = (S.ai.data.recommendations || []).filter(r => r.type === 'track');
    const plName = S.ai.data.playlist_name || 'AI Consigli Melodia';
    const uris   = [];

    // Raccoglie gli URI: dalla cache se disponibili, altrimenti li cerca
    for (let i = 0; i < tracks.length; i++) {
      const cached = S.ai.trackCache[i];
      if (cached?.uri) { uris.push(cached.uri); continue; }
      try {
        const d = await api(
          `/api/search-uri?track=${encodeURIComponent(tracks[i].name)}&artist=${encodeURIComponent(tracks[i].artist || '')}`
        );
        if (d?.found) {
          uris.push(d.uri);
          S.ai.trackCache[i] = { uri: d.uri, name: d.name, artist: d.artist, art: d.album_art };
        }
      } catch (_) {}
    }

    if (!uris.length) { toast('Nessun brano trovato su Spotify', 'warn'); return; }

    // Crea la playlist e aggiunge i brani
    const pl = await api('/api/playlists', {
      method: 'POST',
      body:   JSON.stringify({ name: plName, description: 'Creata da Melodia AI con Gemini' })
    });
    await api(`/api/playlists/${pl.id}/tracks`, {
      method: 'POST',
      body:   JSON.stringify({ uris })
    });

    toast(`✅ Playlist "${plName}" creata con ${uris.length} brani!`, 'ok', 5000);
    btn.textContent  = '✅ Playlist creata!';
    btn.style.background = 'var(--g)';
    setTimeout(() => {
      btn.disabled         = false;
      btn.textContent      = 'Crea Playlist su Spotify';
      btn.style.background = '';
    }, 4000);

  } catch (e) {
    toast('Errore creazione playlist: ' + e.message, 'err');
    btn.disabled    = false;
    btn.textContent = 'Crea Playlist su Spotify';
  }
}

/* ══════════════════════════════════════════════════════════════════
   PLAYER PAGE — Vista estesa riproduzione
══════════════════════════════════════════════════════════════════ */

/**
 * Carica e mostra la pagina "In Riproduzione" con dettaglio completo del brano corrente.
 * Include cover, titolo, artista, barra di avanzamento e controlli.
 */
async function loadPlayerPage() {
  const c = $('playerPageContent');
  if (!c) return;
  c.innerHTML = '<div class="spinner"></div>';

  try {
    const d = await api('/api/current');

    if (!d?.item) {
      c.innerHTML = `
        <div class="np-empty">
          <div class="np-empty-ico">♫</div>
          <p>Nessun brano in riproduzione</p>
          <p class="np-hint">Apri Spotify su un dispositivo e avvia un brano</p>
        </div>`;
      return;
    }

    const t    = d.item;
    const prog = d.progress_ms || 0;
    const dur  = t.duration_ms || 1;

    c.innerHTML = `
      <div class="np-card">
        <img class="np-cover"
             src="${esc(t.album.images[0]?.url || '')}"
             alt="${esc(t.name)}"
             onerror="this.style.display='none'"/>
        <div class="np-det">
          <div class="np-track">${esc(t.name)}</div>
          <div class="np-artist">${esc(t.artists.map(a => a.name).join(', '))}</div>
          <div class="np-album">${esc(t.album.name)} · ${t.album.release_date?.slice(0, 4) || ''}</div>
          <div class="np-bar-wrap">
            <span class="np-t">${fmtMs(prog)}</span>
            <div class="np-bar">
              <div class="np-bar-fill" style="width:${Math.round(prog / dur * 100)}%"></div>
            </div>
            <span class="np-t">${fmtMs(dur)}</span>
          </div>
          <div class="np-status">
            ${d.is_playing ? '▶ In riproduzione' : '⏸ In pausa'} · ${d.device?.name || '—'}
          </div>
          <div class="np-ctrls">
            <button class="np-btn" onclick="playerPrev()">⏮</button>
            <button class="np-btn np-btn-main" onclick="togglePlay()">
              ${d.is_playing ? '⏸' : '▶'}
            </button>
            <button class="np-btn" onclick="playerNext()">⏭</button>
          </div>
          <div class="np-dev">
            Dispositivo: ${esc(d.device?.name || 'Sconosciuto')} · Vol: ${d.device?.volume_percent ?? '—'}%
          </div>
        </div>
      </div>`;

  } catch {
    c.innerHTML = emptyMsg('Impossibile caricare il player');
  }
}

/* ══════════════════════════════════════════════════════════════════
   PLAYER CONTROLS — Barra inferiore di riproduzione
══════════════════════════════════════════════════════════════════ */

/**
 * Avvia la riproduzione di un brano specifico.
 *
 * Richiede Spotify Premium e un dispositivo attivo.
 * In caso di errore 403 (no Premium) o dispositivo non trovato, mostra avviso.
 * Aggiorna la barra player in basso con cover, titolo, artista.
 *
 * @param {string} uri    - URI Spotify del brano (spotify:track:xxx)
 * @param {string} name   - Nome del brano (per la UI)
 * @param {string} artist - Nome dell'artista (per la UI)
 * @param {string} art    - URL cover album (per la UI)
 */
async function playTrack(uri, name, artist, art) {
  if (!uri) return;
  try {
    await api('/api/play', { method: 'PUT', body: JSON.stringify({ uris: [uri] }) });
    S.player.uri     = uri;
    S.player.playing = true;
    updatePB(name, artist, art, true);
    toast(`▶  ${name}`, 'ok');
    startPoll(); // Avvia il polling dello stato player
  } catch (e) {
    if (e.message === 'UNAUTH') return;
    if (e.message?.includes('premium') || e.message?.includes('403'))
      return toast('Spotify Premium richiesto per la riproduzione', 'warn', 5000);
    toast('Apri Spotify su un dispositivo attivo', 'warn', 5000);
    updatePB(name, artist, art, false); // Mostra comunque il brano nella barra
  }
}

/**
 * Toggle play/pausa del brano corrente.
 * Inverte lo stato di S.player.playing e chiama l'API corrispondente.
 */
async function togglePlay() {
  try {
    if (S.player.playing) {
      await api('/api/pause', { method: 'PUT' });
      S.player.playing = false;
      setPlayIcon(false);
    } else {
      await api('/api/play', { method: 'PUT', body: JSON.stringify({}) });
      S.player.playing = true;
      setPlayIcon(true);
    }
  } catch (e) {
    if (e.message !== 'UNAUTH') toast('Nessun dispositivo attivo — apri Spotify', 'warn');
  }
}

/** Salta al brano successivo. Aggiorna il player dopo 700ms (tempo per Spotify di processare) */
async function playerNext() {
  try {
    await api('/api/next', { method: 'POST' });
    setTimeout(pollPlayer, 700);
  } catch { toast('Nessun dispositivo attivo', 'warn'); }
}

/** Torna al brano precedente */
async function playerPrev() {
  try {
    await api('/api/prev', { method: 'POST' });
    setTimeout(pollPlayer, 700);
  } catch { toast('Nessun dispositivo attivo', 'warn'); }
}

/**
 * Aggiorna la barra player inferiore con i dati del brano corrente.
 * @param {string}  title   - Titolo brano
 * @param {string}  artist  - Artista
 * @param {string}  art     - URL cover
 * @param {boolean} playing - Stato riproduzione
 */
function updatePB(title, artist, art, playing) {
  $('pbTitle').textContent  = title  || 'Nessun brano';
  $('pbArtist').textContent = artist || '—';
  const pa = $('pbArt');
  const ph = $('pbArtPh');
  if (art) { pa.src = art; pa.style.display = 'block'; ph.style.display = 'none'; }
  else     { pa.style.display = 'none'; ph.style.display = 'flex'; }
  setPlayIcon(playing);
  S.player.playing = playing;
}

/**
 * Aggiorna le icone play/pausa nella barra inferiore.
 * Mostra l'icona corretta in base allo stato di riproduzione.
 * @param {boolean} p - true = in riproduzione (mostra pausa), false = in pausa (mostra play)
 */
function setPlayIcon(p) {
  $('pbPlay').querySelector('.ico-play').style.display  = p ? 'none'  : 'block';
  $('pbPlay').querySelector('.ico-pause').style.display = p ? 'block' : 'none';
}

/**
 * Interroga Spotify per lo stato corrente del player.
 * Aggiorna barra inferiore, barra di progresso, tempo trascorso/totale.
 * Chiamata ogni 5 secondi da startPoll().
 */
async function pollPlayer() {
  try {
    const d = await api('/api/current');
    if (d?.item) {
      const t = d.item;
      S.player.uri     = t.uri;
      S.player.playing = d.is_playing;
      updatePB(t.name, t.artists?.[0]?.name || '', t.album?.images?.[0]?.url || '', d.is_playing);

      // Aggiorna barra di progresso
      const fill = $('pbFill');
      if (fill && t.duration_ms) {
        fill.style.width = Math.min(100, Math.round((d.progress_ms / t.duration_ms) * 100)) + '%';
      }
      const el = $('pbElapsed'); if (el) el.textContent = fmtMs(d.progress_ms || 0);
      const et = $('pbTotal');   if (et) et.textContent = fmtMs(t.duration_ms  || 0);
    }
  } catch { /* Polling silenzioso: errori non mostrati all'utente */ }
}

/**
 * Avvia il polling periodico dello stato player (ogni 5 secondi).
 * Idempotente: non crea più intervalli se già in esecuzione.
 */
function startPoll() {
  if (S.player.poll) return;
  S.player.poll = setInterval(pollPlayer, 5000);
}

/* Slider volume nella barra player — debounced a 300ms per non spammare l'API */
let _vt;
document.addEventListener('DOMContentLoaded', () => {
  $('pbVol')?.addEventListener('input', e => {
    clearTimeout(_vt);
    _vt = setTimeout(async () => {
      try {
        await api('/api/volume', {
          method: 'PUT',
          body:   JSON.stringify({ volume_percent: +e.target.value })
        });
      } catch {}
    }, 300);
  });
});

/* ══════════════════════════════════════════════════════════════════
   SKELETON LOADERS E UTILITY DOM
   Placeholder animati mentre i dati si caricano
══════════════════════════════════════════════════════════════════ */

/**
 * Genera n righe skeleton per la lista brani.
 * @param {number} n - Numero di righe placeholder
 * @returns {string} - HTML
 */
function skelRows(n) {
  return Array(n).fill(0).map(() => `
    <div class="track-item" style="pointer-events:none;opacity:.4">
      <div class="skel" style="width:18px;height:13px;flex-shrink:0"></div>
      <div class="skel" style="width:40px;height:40px;border-radius:5px;flex-shrink:0"></div>
      <div style="flex:1;display:flex;flex-direction:column;gap:5px;min-width:0">
        <div class="skel" style="height:12px;width:52%"></div>
        <div class="skel" style="height:10px;width:34%"></div>
      </div>
      <div class="skel" style="width:35px;height:10px;flex-shrink:0"></div>
    </div>`).join('');
}

/**
 * Genera n card skeleton per la griglia artisti.
 * @param {number} n - Numero di card placeholder
 * @returns {string} - HTML
 */
function skelArtists(n) {
  return `<div class="artist-grid">${Array(n).fill(0).map(() => `
    <div class="artist-card" style="pointer-events:none;opacity:.4">
      <div class="skel" style="width:78px;height:78px;border-radius:50%;margin:0 auto .6rem"></div>
      <div class="skel" style="height:12px;width:70%;margin:0 auto 5px"></div>
      <div class="skel" style="height:10px;width:50%;margin:0 auto"></div>
    </div>`).join('')}</div>`;
}

/**
 * Genera un messaggio "vuoto" per sezioni senza dati.
 * @param {string} msg - Testo del messaggio
 * @returns {string} - HTML
 */
function emptyMsg(msg) {
  return `<div class="empty">⚠ ${msg}</div>`;
}

/* ══════════════════════════════════════════════════════════════════
   INIZIALIZZAZIONE EVENTI
   Binding di tutti i listener dell'interfaccia
══════════════════════════════════════════════════════════════════ */

/**
 * Registra tutti gli event listener dell'app.
 * Separato da init() per chiarezza e testabilità.
 */
function initEvents() {
  // Navigazione sidebar
  $$('.nav-item').forEach(b =>
    b.addEventListener('click', () => nav(b.dataset.s))
  );

  // Toggle tema dark/light (sidebar desktop + header mobile)
  ['themeBtn', 'mobTheme'].forEach(id =>
    $(id)?.addEventListener('click', () =>
      applyTheme(S.theme === 'dark' ? 'light' : 'dark')
    )
  );

  // Logout
  $('logoutBtn').addEventListener('click', () => location.href = '/logout');

  // Sidebar mobile: apri/chiudi
  $('mobMenu').addEventListener('click', openSidebar);
  $('overlay').addEventListener('click', closeSidebar);

  // Controlli player nella barra inferiore
  $('pbPlay').addEventListener('click', togglePlay);
  $('pbNext').addEventListener('click', playerNext);
  $('pbPrev').addEventListener('click', playerPrev);

  // Bottone genera AI
  $('aiGenBtn')?.addEventListener('click', generateAiRecommendations);

  // Tab periodi top tracks
  $$('#ttTabs .tab').forEach(b =>
    b.addEventListener('click', () => {
      $$('#ttTabs .tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      loadTT(b.dataset.r);
    })
  );

  // Tab periodi top artists
  $$('#taTabs .tab').forEach(b =>
    b.addEventListener('click', () => {
      $$('#taTabs .tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      loadTA(b.dataset.r);
    })
  );
}

/* ══════════════════════════════════════════════════════════════════
   INIT — Punto di ingresso dell'applicazione
══════════════════════════════════════════════════════════════════ */

/**
 * Funzione di inizializzazione principale.
 * Eseguita al DOMContentLoaded.
 *
 * Sequenza:
 * 1. Applica il tema salvato
 * 2. Registra tutti gli event listener
 * 3. Verifica autenticazione (redirige se non loggato)
 * 4. Carica il profilo utente
 * 5. Carica la panoramica iniziale
 * 6. Avvia il polling del player
 */
async function init() {
  applyTheme(S.theme);
  initEvents();

  // Verifica che l'utente sia ancora autenticato
  try {
    const st = await api('/api/status');
    if (!st.authenticated) { location.href = '/'; return; }
  } catch {
    location.href = '/';
    return;
  }

  await loadUser();     // Carica profilo nella sidebar
  loadOverview();       // Carica dashboard
  pollPlayer();         // Prima lettura stato player
  startPoll();          // Avvia polling periodico
}

// Avvia l'app quando il DOM è pronto
document.addEventListener('DOMContentLoaded', init);
