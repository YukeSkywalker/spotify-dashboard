/* ═══════════════════════════════════════════════════════════════
   MELODIA — app.js  (frontend completo)
═══════════════════════════════════════════════════════════════ */

const STATE = {
  user: null,
  theme: localStorage.getItem('melodia-theme') || 'dark',
  section: 'overview',
  cache: { topTracks: {}, topArtists: {}, recent: null, playlists: null },
  playerPolling: null,
  searchTimer: null,
  currentTrackUri: null,
  isPlaying: false
};

const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function fmtMs(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
function fmtAgo(iso) {
  const d = Date.now() - new Date(iso);
  const m = Math.floor(d / 60000);
  if (m < 1)  return 'Adesso';
  if (m < 60) return `${m}m fa`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h fa`;
  return `${Math.floor(h / 24)}g fa`;
}
function fmtFollowers(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}
function escH(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

/* ─── Toast ──────────────────────────────────────────────────── */
function toast(msg, type = 'info', ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, ms);
}

/* ─── API ────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    if (res.status === 401) {
      toast('Sessione scaduta — effettua di nuovo il login', 'error', 5000);
      setTimeout(() => { window.location.href = '/'; }, 2500);
      throw new Error('UNAUTHORIZED');
    }
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (err) {
    if (err.message !== 'UNAUTHORIZED') console.warn(`API ${path}:`, err.message);
    throw err;
  }
}

/* ─── Theme ──────────────────────────────────────────────────── */
function setTheme(t) {
  STATE.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('melodia-theme', t);
  const icon = t === 'dark' ? '☀' : '☾';
  const tt = $('themeToggle'), tm = $('themeToggleMobile');
  if (tt) tt.textContent = icon;
  if (tm) tm.textContent = icon;
}

/* ─── Navigation ─────────────────────────────────────────────── */
function navigate(section) {
  STATE.section = section;
  $$('.section').forEach(s => s.classList.remove('active'));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.section === section));
  const el = $(`section-${section}`);
  if (el) el.classList.add('active');
  closeSidebar();
  const loaders = {
    'overview':    loadOverview,
    'top-tracks':  () => loadTopTracks('short_term'),
    'top-artists': () => loadTopArtists('short_term'),
    'recent':      loadRecent,
    'playlists':   loadPlaylists,
    'search':      () => setTimeout(() => $('searchInput').focus(), 100),
    'stats':       loadStats,
    'nowplaying':  loadNowPlaying
  };
  if (loaders[section]) loaders[section]();
}

function openSidebar()  { $('sidebar').classList.add('open'); $('sidebarOverlay').classList.add('open'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebarOverlay').classList.remove('open'); }

/* ═══════ USER ═══════════════════════════════════════════════════ */
async function loadUser() {
  try {
    const user = await api('/api/me');
    STATE.user = user;
    renderUser(user);
    return user;
  } catch (err) {
    console.error('loadUser failed:', err.message);
    $('userName').textContent = 'Errore';
    $('avatarPlaceholder').textContent = '!';
    $('avatarPlaceholder').style.display = 'flex';
    toast('Impossibile caricare il profilo. Controlla la connessione.', 'error', 6000);
    return null;
  }
}

function renderUser(u) {
  $('userName').textContent = u.display_name || u.id || 'Utente';
  $('userPlan').textContent  = u.product === 'premium' ? '✦ Premium' : 'Free';
  $('overviewName').textContent = (u.display_name || u.id || 'Ciao').split(' ')[0];
  const img = u.images?.[0]?.url || u.images?.[1]?.url;
  const av  = $('userAvatar');
  const ph  = $('avatarPlaceholder');
  if (img) {
    av.src = img;
    av.style.display = 'block';
    ph.style.display = 'none';
    av.onerror = () => { av.style.display = 'none'; ph.style.display = 'flex'; ph.textContent = (u.display_name||'?')[0].toUpperCase(); };
  } else {
    av.style.display = 'none';
    ph.style.display = 'flex';
    ph.textContent = (u.display_name || u.id || '?')[0].toUpperCase();
  }
}

/* ═══════ OVERVIEW ═══════════════════════════════════════════════ */
async function loadOverview() {
  const [tracksRes, recentRes, playlistsRes, artistsRes] = await Promise.allSettled([
    api('/api/top-tracks?time_range=medium_term&limit=50'),
    api('/api/recently-played?limit=50'),
    api('/api/playlists?limit=50'),
    api('/api/top-artists?time_range=medium_term&limit=5')
  ]);

  if (tracksRes.status === 'fulfilled' && tracksRes.value) {
    $('statTracks').textContent = tracksRes.value.items?.length || '—';
    renderMiniList($('overviewTopTracks'), tracksRes.value.items.slice(0, 5));
  }
  if (playlistsRes.status === 'fulfilled' && playlistsRes.value) {
    $('statPlaylists').textContent = playlistsRes.value.total || playlistsRes.value.items?.length || '—';
  }
  if (recentRes.status === 'fulfilled' && recentRes.value) {
    const items = recentRes.value.items || [];
    $('statRecent').textContent  = items.length;
    $('statMinutes').textContent = Math.round(items.reduce((a,i) => a+(i.track?.duration_ms||0), 0) / 60000);
    renderMiniList($('overviewRecent'), items.slice(0,5).map(i => i.track));
  }
  if (artistsRes.status === 'fulfilled' && artistsRes.value?.items?.[0]) {
    renderTopArtistCard(artistsRes.value.items[0]);
  }
}

function renderTopArtistCard(a) {
  const el = $('topArtistCard');
  if (!el) return;
  el.innerHTML = `
    <div class="tac-inner">
      <img src="${a.images?.[0]?.url||''}" class="tac-img" alt="" onerror="this.style.display='none'" />
      <div class="tac-info">
        <div class="tac-label">Artista #1</div>
        <div class="tac-name">${escH(a.name)}</div>
        <div class="tac-genres">${(a.genres||[]).slice(0,3).join(' · ') || '—'}</div>
        <div class="tac-followers">${fmtFollowers(a.followers?.total)} followers</div>
      </div>
    </div>`;
}

function renderMiniList(container, tracks) {
  if (!container) return;
  if (!tracks?.length) { container.innerHTML = '<div class="empty-msg">Nessun dato</div>'; return; }
  container.innerHTML = tracks.filter(Boolean).map((t, i) => `
    <div class="track-item" onclick="playTrack('${escH(t.uri)}','${escH(t.name)}','${escH(t.artists?.[0]?.name||'')}','${escH(t.album?.images?.[0]?.url||'')}')">
      <span class="track-num">${i+1}</span>
      <div class="track-art-wrap">
        <img class="track-art" src="${t.album?.images?.[0]?.url||''}" alt="" loading="lazy" onerror="this.style.display='none'" />
        <div class="track-play-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
      </div>
      <div class="track-details">
        <div class="track-name">${escH(t.name)}</div>
        <div class="track-artist">${escH(t.artists?.map(a=>a.name).join(', ')||'')}</div>
      </div>
    </div>`).join('');
}

/* ═══════ TOP TRACKS ═════════════════════════════════════════════ */
async function loadTopTracks(range) {
  if (STATE.cache.topTracks[range]) { renderTopTracks(STATE.cache.topTracks[range]); return; }
  $('topTracksList').innerHTML = skelRows(15);
  try {
    const data = await api(`/api/top-tracks?time_range=${range}&limit=50`);
    STATE.cache.topTracks[range] = data.items;
    renderTopTracks(data.items);
  } catch { $('topTracksList').innerHTML = errMsg('Impossibile caricare le top tracks'); }
}

function renderTopTracks(tracks) {
  if (!tracks?.length) { $('topTracksList').innerHTML = errMsg('Nessun dato — ascolta più musica!'); return; }
  $('topTracksList').innerHTML = tracks.map((t, i) => `
    <div class="track-item ${STATE.currentTrackUri===t.uri?'now-playing':''}"
         onclick="playTrack('${escH(t.uri)}','${escH(t.name)}','${escH(t.artists[0]?.name||'')}','${escH(t.album.images[0]?.url||'')}')">
      <span class="track-num">${STATE.currentTrackUri===t.uri?'▶':i+1}</span>
      <div class="track-art-wrap">
        <img class="track-art" src="${t.album.images[0]?.url||''}" alt="" loading="lazy" onerror="this.style.display='none'" />
        <div class="track-play-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
      </div>
      <div class="track-details">
        <div class="track-name">${escH(t.name)}</div>
        <div class="track-artist">${escH(t.artists.map(a=>a.name).join(', '))}</div>
      </div>
      <div class="track-meta">
        <span class="track-album">${escH(t.album.name)}</span>
        <span class="track-duration">${fmtMs(t.duration_ms)}</span>
      </div>
    </div>`).join('');
}

/* ═══════ TOP ARTISTS ════════════════════════════════════════════ */
async function loadTopArtists(range) {
  if (STATE.cache.topArtists[range]) { renderTopArtists(STATE.cache.topArtists[range]); return; }
  $('topArtistsList').innerHTML = skelArtists(12);
  try {
    const data = await api(`/api/top-artists?time_range=${range}&limit=50`);
    STATE.cache.topArtists[range] = data.items;
    renderTopArtists(data.items);
  } catch { $('topArtistsList').innerHTML = errMsg('Impossibile caricare gli artisti'); }
}

function renderTopArtists(artists) {
  if (!artists?.length) { $('topArtistsList').innerHTML = errMsg('Nessun dato'); return; }
  $('topArtistsList').innerHTML = artists.map((a, i) => `
    <div class="artist-card">
      <div class="artist-rank">#${i+1}</div>
      <img class="artist-img" src="${a.images?.[0]?.url||''}" alt="${escH(a.name)}" loading="lazy" onerror="this.style.opacity='0'" />
      <div class="artist-name">${escH(a.name)}</div>
      <div class="artist-genres">${(a.genres||[]).slice(0,2).join(', ')||'—'}</div>
      <div class="artist-pop">
        <div class="pop-bar"><div class="pop-fill" style="width:${a.popularity||0}%"></div></div>
        <span class="pop-label">${a.popularity||0}</span>
      </div>
    </div>`).join('');
}

/* ═══════ RECENT ════════════════════════════════════════════════ */
async function loadRecent() {
  if (STATE.cache.recent) { renderRecent(STATE.cache.recent); return; }
  $('recentList').innerHTML = skelRows(15);
  try {
    const data = await api('/api/recently-played?limit=50');
    STATE.cache.recent = data.items;
    renderRecent(data.items);
  } catch { $('recentList').innerHTML = errMsg('Impossibile caricare i brani recenti'); }
}

function renderRecent(items) {
  if (!items?.length) { $('recentList').innerHTML = errMsg('Nessun brano recente'); return; }
  $('recentList').innerHTML = items.map((item, i) => {
    const t = item.track;
    if (!t) return '';
    return `
      <div class="track-item" onclick="playTrack('${escH(t.uri)}','${escH(t.name)}','${escH(t.artists[0]?.name||'')}','${escH(t.album.images[0]?.url||'')}')">
        <span class="track-num">${i+1}</span>
        <div class="track-art-wrap">
          <img class="track-art" src="${t.album.images[0]?.url||''}" alt="" loading="lazy" onerror="this.style.display='none'" />
          <div class="track-play-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
        </div>
        <div class="track-details">
          <div class="track-name">${escH(t.name)}</div>
          <div class="track-artist">${escH(t.artists.map(a=>a.name).join(', '))}</div>
        </div>
        <div class="track-meta">
          <span class="track-when">${fmtAgo(item.played_at)}</span>
          <span class="track-duration">${fmtMs(t.duration_ms)}</span>
        </div>
      </div>`;
  }).join('');
}

/* ═══════ PLAYLISTS ══════════════════════════════════════════════ */
async function loadPlaylists() {
  if (STATE.cache.playlists) { renderPlaylists(STATE.cache.playlists); return; }
  $('playlistsGrid').innerHTML = skelPlaylists(8);
  $('playlistsGrid').style.display = 'grid';
  $('playlistTracksPanel').style.display = 'none';
  try {
    const data = await api('/api/playlists?limit=50');
    STATE.cache.playlists = data.items;
    renderPlaylists(data.items);
  } catch { $('playlistsGrid').innerHTML = errMsg('Impossibile caricare le playlist'); }
}

function renderPlaylists(playlists) {
  $('playlistsGrid').style.display = 'grid';
  $('playlistTracksPanel').style.display = 'none';
  if (!playlists?.length) { $('playlistsGrid').innerHTML = errMsg('Nessuna playlist'); return; }
  $('playlistsGrid').innerHTML = playlists.map(pl => `
    <div class="playlist-card" onclick="openPlaylist('${escH(pl.id)}','${escH(pl.name)}','${escH(pl.images?.[0]?.url||'')}')">
      <div class="playlist-img-wrap">
        <img class="playlist-img" src="${pl.images?.[0]?.url||''}" alt="${escH(pl.name)}" loading="lazy" onerror="this.style.display='none'" />
        <div class="playlist-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
      </div>
      <div class="playlist-info">
        <div class="playlist-name">${escH(pl.name)}</div>
        <div class="playlist-count">${pl.tracks?.total||0} brani · ${escH(pl.owner?.display_name||'')}</div>
      </div>
    </div>`).join('');
}

async function openPlaylist(id, name, img) {
  $('playlistsGrid').style.display = 'none';
  $('playlistTracksPanel').style.display = 'block';
  $('playlistTracksTitle').textContent = name;
  const cover = $('playlistTracksCover');
  if (cover) { cover.src = img; cover.style.display = img ? 'block' : 'none'; }
  $('playlistTracksList').innerHTML = skelRows(10);
  try {
    const data = await api(`/api/playlist/${id}/tracks`);
    const tracks = (data.items||[]).filter(i=>i.track?.id);
    if (!tracks.length) { $('playlistTracksList').innerHTML = errMsg('Playlist vuota'); return; }
    $('playlistTracksList').innerHTML = tracks.map((item,i) => {
      const t = item.track;
      return `
        <div class="track-item" onclick="playTrack('${escH(t.uri)}','${escH(t.name)}','${escH(t.artists[0]?.name||'')}','${escH(t.album.images[0]?.url||'')}')">
          <span class="track-num">${i+1}</span>
          <div class="track-art-wrap">
            <img class="track-art" src="${t.album.images[0]?.url||''}" alt="" loading="lazy" onerror="this.style.display='none'" />
            <div class="track-play-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
          </div>
          <div class="track-details">
            <div class="track-name">${escH(t.name)}</div>
            <div class="track-artist">${escH(t.artists.map(a=>a.name).join(', '))}</div>
          </div>
          <div class="track-meta">
            <span class="track-album">${escH(t.album.name)}</span>
            <span class="track-duration">${fmtMs(t.duration_ms)}</span>
          </div>
        </div>`;
    }).join('');
  } catch { $('playlistTracksList').innerHTML = errMsg('Impossibile caricare i brani'); }
}

/* ═══════ SEARCH ════════════════════════════════════════════════ */
function initSearch() {
  const input = $('searchInput'), clear = $('searchClear');
  const results = $('searchResults'), empty = $('searchEmpty');

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clear.style.display = q ? 'block' : 'none';
    clearTimeout(STATE.searchTimer);
    if (!q) { results.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    results.innerHTML = skelRows(6);
    STATE.searchTimer = setTimeout(() => doSearch(q), 400);
  });

  clear.addEventListener('click', () => {
    input.value = ''; clear.style.display = 'none';
    results.innerHTML = ''; empty.style.display = 'block'; input.focus();
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && input.value.trim()) { clearTimeout(STATE.searchTimer); doSearch(input.value.trim()); }
  });
}

async function doSearch(q) {
  const results = $('searchResults');
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&type=track&limit=30`);
    const tracks = data.tracks?.items || [];
    if (!tracks.length) { results.innerHTML = `<div class="empty-msg">Nessun risultato per "<strong>${escH(q)}</strong>"</div>`; return; }
    results.innerHTML = tracks.map((t,i) => `
      <div class="track-item" onclick="playTrack('${escH(t.uri)}','${escH(t.name)}','${escH(t.artists[0]?.name||'')}','${escH(t.album.images[0]?.url||'')}')">
        <span class="track-num">${i+1}</span>
        <div class="track-art-wrap">
          <img class="track-art" src="${t.album.images[0]?.url||''}" alt="" loading="lazy" onerror="this.style.display='none'" />
          <div class="track-play-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
        </div>
        <div class="track-details">
          <div class="track-name">${escH(t.name)}</div>
          <div class="track-artist">${escH(t.artists.map(a=>a.name).join(', '))}</div>
        </div>
        <div class="track-meta">
          <span class="track-album">${escH(t.album.name)}</span>
          <span class="track-duration">${fmtMs(t.duration_ms)}</span>
        </div>
      </div>`).join('');
  } catch { results.innerHTML = errMsg('Ricerca fallita — riprova'); }
}

/* ═══════ STATS ═════════════════════════════════════════════════ */
async function loadStats() {
  const container = $('statsContent');
  if (!container) return;
  container.innerHTML = `<div class="loading-spinner"></div>`;
  try {
    const [tracksLong, artistsLong, recent] = await Promise.all([
      api('/api/top-tracks?time_range=long_term&limit=50'),
      api('/api/top-artists?time_range=long_term&limit=50'),
      api('/api/recently-played?limit=50')
    ]);

    const genreMap = {};
    (artistsLong.items||[]).forEach(a => (a.genres||[]).forEach(g => { genreMap[g]=(genreMap[g]||0)+1; }));
    const topGenres = Object.entries(genreMap).sort((a,b)=>b[1]-a[1]).slice(0,8);

    const decades = {};
    (tracksLong.items||[]).forEach(t => {
      const y = t.album?.release_date?.substring(0,4);
      if (y) { const d = Math.floor(+y/10)*10; decades[d]=(decades[d]||0)+1; }
    });

    const recentMin = Math.round((recent.items||[]).reduce((a,i)=>a+(i.track?.duration_ms||0),0)/60000);
    const popAvg = tracksLong.items?.length ? Math.round(tracksLong.items.reduce((a,t)=>a+(t.popularity||0),0)/tracksLong.items.length) : 0;

    container.innerHTML = `
      <div class="stats-section">
        <h3 class="stats-title">🎸 Generi preferiti</h3>
        <div class="genre-bars">
          ${topGenres.map(([g,n])=>`
            <div class="genre-bar-row">
              <span class="genre-label">${escH(g)}</span>
              <div class="genre-bar-track"><div class="genre-bar-fill" style="width:${Math.round(n/topGenres[0][1]*100)}%"></div></div>
              <span class="genre-count">${n}</span>
            </div>`).join('')}
        </div>
      </div>
      <div class="stats-section">
        <h3 class="stats-title">📅 Decenni più ascoltati</h3>
        <div class="decade-grid">
          ${Object.entries(decades).sort((a,b)=>b[1]-a[1]).map(([d,n])=>`
            <div class="decade-card">
              <div class="decade-year">${d}s</div>
              <div class="decade-count">${n} brani</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="stats-section">
        <h3 class="stats-title">📊 Il tuo riepilogo</h3>
        <div class="summary-grid">
          <div class="summary-card"><div class="summary-val">${recentMin}</div><div class="summary-lbl">Minuti ascoltati (recenti)</div></div>
          <div class="summary-card"><div class="summary-val">${tracksLong.items?.length||0}</div><div class="summary-lbl">Top tracks nel tempo</div></div>
          <div class="summary-card"><div class="summary-val">${artistsLong.items?.length||0}</div><div class="summary-lbl">Artisti ascoltati</div></div>
          <div class="summary-card"><div class="summary-val">${popAvg}</div><div class="summary-lbl">Popolarità media</div></div>
        </div>
      </div>
      <div class="stats-section">
        <h3 class="stats-title">🏆 Top 10 di sempre</h3>
        <div class="track-list">
          ${(tracksLong.items||[]).slice(0,10).map((t,i)=>`
            <div class="track-item" onclick="playTrack('${escH(t.uri)}','${escH(t.name)}','${escH(t.artists[0]?.name||'')}','${escH(t.album.images[0]?.url||'')}')">
              <span class="track-num">${i+1}</span>
              <div class="track-art-wrap">
                <img class="track-art" src="${t.album.images[0]?.url||''}" alt="" loading="lazy" onerror="this.style.display='none'" />
                <div class="track-play-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
              </div>
              <div class="track-details">
                <div class="track-name">${escH(t.name)}</div>
                <div class="track-artist">${escH(t.artists.map(a=>a.name).join(', '))}</div>
              </div>
              <div class="track-meta">
                <span class="pop-badge">${t.popularity}</span>
                <span class="track-duration">${fmtMs(t.duration_ms)}</span>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  } catch { container.innerHTML = errMsg('Impossibile caricare le statistiche'); }
}

/* ═══════ NOW PLAYING ════════════════════════════════════════════ */
async function loadNowPlaying() {
  const container = $('nowPlayingContent');
  if (!container) return;
  container.innerHTML = `<div class="loading-spinner"></div>`;
  try {
    const data = await api('/api/player');
    if (!data?.item) {
      container.innerHTML = `
        <div class="np-empty">
          <div class="np-empty-icon">♫</div>
          <p>Nessun brano in riproduzione</p>
          <small>Apri Spotify su un dispositivo e avvia un brano</small>
        </div>`;
      return;
    }
    const t = data.item;
    const prog = data.progress_ms||0, dur = t.duration_ms||1;
    container.innerHTML = `
      <div class="np-card">
        <img class="np-cover" src="${t.album.images[0]?.url||''}" alt="${escH(t.name)}" onerror="this.style.display='none'" />
        <div class="np-details">
          <div class="np-track">${escH(t.name)}</div>
          <div class="np-artist">${escH(t.artists.map(a=>a.name).join(', '))}</div>
          <div class="np-album">${escH(t.album.name)} · ${t.album.release_date?.substring(0,4)||''}</div>
          <div class="np-progress-wrap">
            <span class="np-time">${fmtMs(prog)}</span>
            <div class="np-progress-bar"><div class="np-progress-fill" style="width:${Math.round(prog/dur*100)}%"></div></div>
            <span class="np-time">${fmtMs(dur)}</span>
          </div>
          <div class="np-status">${data.is_playing?'▶ In riproduzione':'⏸ In pausa'} · ${data.device?.name||'Dispositivo sconosciuto'}</div>
          <div class="np-controls">
            <button class="np-btn" onclick="playerPrev()">⏮</button>
            <button class="np-btn np-btn-main" onclick="togglePlayPause()">${data.is_playing?'⏸':'▶'}</button>
            <button class="np-btn" onclick="playerNext()">⏭</button>
          </div>
        </div>
      </div>`;
  } catch { container.innerHTML = errMsg('Impossibile caricare il player'); }
}

/* ═══════ PLAYER BAR ════════════════════════════════════════════ */
async function playTrack(uri, name, artist, art) {
  try {
    await api('/api/player/play', { method: 'PUT', body: JSON.stringify({ uris: [uri] }) });
    STATE.currentTrackUri = uri;
    STATE.isPlaying = true;
    updatePlayerBar(name, artist, art, true);
    toast(`▶  ${name}`, 'success');
    startPlayerPoll();
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') return;
    toast('Apri Spotify su un dispositivo attivo per riprodurre', 'error', 5000);
    updatePlayerBar(name, artist, art, false);
  }
}

function updatePlayerBar(title, artist, art, playing) {
  $('playerTitle').textContent  = title  || 'Nessun brano';
  $('playerArtist').textContent = artist || '—';
  const pa = $('playerArt');
  if (art) { pa.src = art; pa.style.display = 'block'; } else { pa.style.display = 'none'; }
  setPlayIcon(playing);
  STATE.isPlaying = playing;
}

function setPlayIcon(playing) {
  $('playPauseBtn').querySelector('.icon-play').style.display  = playing ? 'none'  : 'block';
  $('playPauseBtn').querySelector('.icon-pause').style.display = playing ? 'block' : 'none';
}

async function togglePlayPause() {
  try {
    if (STATE.isPlaying) {
      await api('/api/player/pause', { method: 'POST' });
      STATE.isPlaying = false; setPlayIcon(false);
    } else {
      await api('/api/player/play', { method: 'PUT', body: JSON.stringify({}) });
      STATE.isPlaying = true; setPlayIcon(true);
    }
  } catch { toast('Nessun dispositivo attivo — apri Spotify', 'error'); }
}

async function playerNext() {
  try { await api('/api/player/next', { method: 'POST' }); setTimeout(pollPlayer, 800); }
  catch { toast('Nessun dispositivo attivo', 'error'); }
}

async function playerPrev() {
  try { await api('/api/player/previous', { method: 'POST' }); setTimeout(pollPlayer, 800); }
  catch { toast('Nessun dispositivo attivo', 'error'); }
}

async function pollPlayer() {
  try {
    const data = await api('/api/player');
    if (data?.item) {
      const t = data.item;
      STATE.currentTrackUri = t.uri;
      STATE.isPlaying = data.is_playing;
      updatePlayerBar(t.name, t.artists?.[0]?.name||'', t.album?.images?.[0]?.url||'', data.is_playing);
      const bar = $('playerProgressFill');
      if (bar && t.duration_ms) bar.style.width = Math.min(100, Math.round((data.progress_ms/t.duration_ms)*100)) + '%';
    }
  } catch { /* silenzioso */ }
}

function startPlayerPoll() {
  if (STATE.playerPolling) return;
  STATE.playerPolling = setInterval(pollPlayer, 5000);
}

let volDebounce;
function initVolume() {
  const slider = $('volumeSlider');
  if (!slider) return;
  slider.addEventListener('input', e => {
    clearTimeout(volDebounce);
    volDebounce = setTimeout(async () => {
      try { await api('/api/player/volume', { method: 'PUT', body: JSON.stringify({ volume_percent: parseInt(e.target.value) }) }); }
      catch { /* no device */ }
    }, 300);
  });
}

/* ═══════ SKELETONS / ERRORS ════════════════════════════════════ */
function skelRows(n) {
  return Array(n).fill(0).map(()=>`
    <div class="track-item" style="pointer-events:none;opacity:.5">
      <div class="skeleton" style="width:20px;height:14px;border-radius:3px;flex-shrink:0"></div>
      <div class="skeleton" style="width:44px;height:44px;border-radius:6px;flex-shrink:0"></div>
      <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0">
        <div class="skeleton" style="height:13px;width:55%;border-radius:3px"></div>
        <div class="skeleton" style="height:11px;width:35%;border-radius:3px"></div>
      </div>
      <div class="skeleton" style="width:38px;height:11px;border-radius:3px;flex-shrink:0"></div>
    </div>`).join('');
}
function skelArtists(n) {
  return `<div class="artists-grid">${Array(n).fill(0).map(()=>`
    <div class="artist-card" style="pointer-events:none;opacity:.5">
      <div class="skeleton" style="width:90px;height:90px;border-radius:50%;margin:0 auto 0.75rem"></div>
      <div class="skeleton" style="height:13px;width:70%;margin:0 auto 6px;border-radius:3px"></div>
      <div class="skeleton" style="height:11px;width:50%;margin:0 auto;border-radius:3px"></div>
    </div>`).join('')}</div>`;
}
function skelPlaylists(n) {
  return Array(n).fill(0).map(()=>`
    <div class="playlist-card" style="pointer-events:none;opacity:.5">
      <div class="skeleton" style="width:100%;aspect-ratio:1"></div>
      <div style="padding:.85rem 1rem;display:flex;flex-direction:column;gap:6px">
        <div class="skeleton" style="height:13px;width:70%;border-radius:3px"></div>
        <div class="skeleton" style="height:11px;width:45%;border-radius:3px"></div>
      </div>
    </div>`).join('');
}
function errMsg(msg) { return `<div class="empty-msg">⚠ ${msg}</div>`; }

/* ═══════ EVENTS ════════════════════════════════════════════════ */
function initEvents() {
  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.section)));
  ['themeToggle','themeToggleMobile'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('click', () => setTheme(STATE.theme === 'dark' ? 'light' : 'dark'));
  });
  $('logoutBtn').addEventListener('click', () => window.location.href = '/logout');
  $('playPauseBtn').addEventListener('click', togglePlayPause);
  $('nextBtn').addEventListener('click', playerNext);
  $('prevBtn').addEventListener('click', playerPrev);
  $('hamburger').addEventListener('click', openSidebar);
  $('sidebarOverlay').addEventListener('click', closeSidebar);
  $('backFromPlaylist').addEventListener('click', () => { if (STATE.cache.playlists) renderPlaylists(STATE.cache.playlists); });

  $$('#topTracksTabs .tab-btn').forEach(btn => btn.addEventListener('click', () => {
    $$('#topTracksTabs .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadTopTracks(btn.dataset.range);
  }));
  $$('#topArtistsTabs .tab-btn').forEach(btn => btn.addEventListener('click', () => {
    $$('#topArtistsTabs .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadTopArtists(btn.dataset.range);
  }));
}

/* ═══════ INIT ══════════════════════════════════════════════════ */
async function init() {
  setTheme(STATE.theme);
  initEvents();
  initSearch();
  initVolume();

  try {
    const status = await api('/api/auth/status');
    if (!status.authenticated) { window.location.href = '/'; return; }
  } catch { window.location.href = '/'; return; }

  const user = await loadUser();
  if (!user) return;

  loadOverview();
  pollPlayer();
  startPlayerPoll();
}

document.addEventListener('DOMContentLoaded', init);
