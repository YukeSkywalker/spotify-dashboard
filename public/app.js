/* ─── State ──────────────────────────────────────────────────────────────────── */
const state = {
  user: null,
  theme: localStorage.getItem('melodia-theme') || 'dark',
  currentSection: 'overview',
  topTracks: { short_term: null, medium_term: null, long_term: null },
  topArtists: { short_term: null, medium_term: null, long_term: null },
  recentTracks: null,
  playlists: null,
  playerState: { isPlaying: false },
  playerPollInterval: null,
  searchTimeout: null
};

/* ─── DOM helpers ────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const fmt = ms => { const m = Math.floor(ms / 60000); const s = Math.floor((ms % 60000) / 1000); return `${m}:${s.toString().padStart(2, '0')}`; };
const fmtTimeAgo = iso => {
  const diff = Date.now() - new Date(iso);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Adesso';
  if (m < 60) return `${m}m fa`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h fa`;
  return `${Math.floor(h / 24)}g fa`;
};

/* ─── Toast ──────────────────────────────────────────────────────────────────── */
function showToast(msg, type = 'info', duration = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, duration);
}

/* ─── API ────────────────────────────────────────────────────────────────────── */
async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (res.status === 401) {
    // Session expired, redirect to home
    showToast('Sessione scaduta. Effettua di nuovo il login.', 'error');
    setTimeout(() => { window.location.href = '/'; }, 2000);
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ─── Theme ──────────────────────────────────────────────────────────────────── */
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('melodia-theme', theme);
  const icon = theme === 'dark' ? '☀' : '☾';
  const toggles = [$('themeToggle'), $('themeToggleMobile')];
  toggles.forEach(el => { if (el) el.querySelector('.theme-icon, &') && (el.textContent = icon); });
  // Set text for both buttons
  $('themeToggle') && ($('themeToggle').querySelector('.theme-icon') ? $('themeToggle').querySelector('.theme-icon').textContent = icon : $('themeToggle').textContent = icon);
  $('themeToggleMobile') && ($('themeToggleMobile').textContent = icon);
}

/* ─── Navigation ─────────────────────────────────────────────────────────────── */
function navigate(section) {
  state.currentSection = section;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.section === section);
  });
  const sectionEl = $(`section-${section}`);
  if (sectionEl) sectionEl.classList.add('active');

  // Lazy load
  const loaders = {
    'top-tracks': () => loadTopTracks('short_term'),
    'top-artists': () => loadTopArtists('short_term'),
    'recent': () => loadRecent(),
    'playlists': () => loadPlaylists(),
  };
  if (loaders[section]) loaders[section]();

  // Mobile: close sidebar
  closeSidebar();
}

/* ─── Sidebar mobile ─────────────────────────────────────────────────────────── */
function openSidebar() {
  $('sidebar').classList.add('open');
  $('sidebarOverlay').classList.add('open');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebarOverlay').classList.remove('open');
}

/* ─── User ────────────────────────────────────────────────────────────────────── */
async function loadUser() {
  try {
    const user = await api('/api/me');
    state.user = user;
    renderUser(user);
    loadOverview();
  } catch (err) {
    console.error('loadUser error:', err);
  }
}

function renderUser(user) {
  $('userName').textContent = user.display_name || user.id;
  $('userPlan').textContent = user.product || 'free';
  $('overviewName').textContent = (user.display_name || user.id).split(' ')[0];

  const avatar = user.images?.[0]?.url;
  if (avatar) {
    $('userAvatar').src = avatar;
    $('userAvatar').style.display = 'block';
    $('avatarPlaceholder').style.display = 'none';
  } else {
    $('avatarPlaceholder').textContent = (user.display_name || user.id)[0].toUpperCase();
    $('userAvatar').style.display = 'none';
  }
}

/* ─── Overview ────────────────────────────────────────────────────────────────── */
async function loadOverview() {
  try {
    const [tracksData, recentData, playlistsData] = await Promise.allSettled([
      api('/api/top-tracks?time_range=medium_term&limit=5'),
      api('/api/recently-played?limit=50'),
      api('/api/playlists?limit=50')
    ]);

    // Stats
    if (tracksData.status === 'fulfilled') {
      $('statTracks').textContent = tracksData.value.total || tracksData.value.items.length;
      renderMiniList($('overviewTopTracks'), tracksData.value.items.slice(0, 5));
    }
    if (playlistsData.status === 'fulfilled') {
      $('statPlaylists').textContent = playlistsData.value.total || playlistsData.value.items.length;
    }
    if (recentData.status === 'fulfilled') {
      const items = recentData.value.items;
      $('statRecent').textContent = items.length;
      const totalMs = items.reduce((acc, i) => acc + i.track.duration_ms, 0);
      $('statMinutes').textContent = Math.round(totalMs / 60000);
      renderMiniList($('overviewRecent'), items.slice(0, 5).map(i => i.track));
    }
  } catch (err) {
    console.error('loadOverview error:', err);
  }
}

function renderMiniList(container, tracks) {
  container.innerHTML = tracks.map((track, i) => `
    <div class="track-item" onclick="playTrack('${track.uri}', '${escHtml(track.name)}', '${escHtml(track.artists?.[0]?.name || '')}', '${track.album?.images?.[0]?.url || ''}')">
      <span class="track-num">${i + 1}</span>
      <div class="track-art-wrap">
        <img class="track-art" src="${track.album?.images?.[0]?.url || ''}" alt="" loading="lazy" />
        <div class="track-play-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
      </div>
      <div class="track-details">
        <div class="track-name">${escHtml(track.name)}</div>
        <div class="track-artist">${escHtml(track.artists?.map(a => a.name).join(', ') || '')}</div>
      </div>
    </div>
  `).join('');
}

/* ─── Top Tracks ─────────────────────────────────────────────────────────────── */
async function loadTopTracks(range) {
  if (state.topTracks[range]) {
    renderTopTracks(state.topTracks[range]);
    return;
  }
  $('topTracksList').innerHTML = skeletonRows(10);
  try {
    const data = await api(`/api/top-tracks?time_range=${range}&limit=50`);
    state.topTracks[range] = data.items;
    renderTopTracks(data.items);
  } catch (err) {
    $('topTracksList').innerHTML = errorMsg('Impossibile caricare le top tracks');
  }
}

function renderTopTracks(tracks) {
  $('topTracksList').innerHTML = tracks.map((track, i) => `
    <div class="track-item" onclick="playTrack('${track.uri}', '${escHtml(track.name)}', '${escHtml(track.artists[0]?.name || '')}', '${track.album.images[0]?.url || ''}')">
      <span class="track-num">${i + 1}</span>
      <div class="track-art-wrap">
        <img class="track-art" src="${track.album.images[0]?.url || ''}" alt="" loading="lazy" />
        <div class="track-play-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
      </div>
      <div class="track-details">
        <div class="track-name">${escHtml(track.name)}</div>
        <div class="track-artist">${escHtml(track.artists.map(a => a.name).join(', '))}</div>
      </div>
      <span class="track-duration">${fmt(track.duration_ms)}</span>
    </div>
  `).join('');
}

/* ─── Top Artists ────────────────────────────────────────────────────────────── */
async function loadTopArtists(range) {
  if (state.topArtists[range]) {
    renderTopArtists(state.topArtists[range]);
    return;
  }
  $('topArtistsList').innerHTML = skeletonArtists(10);
  try {
    const data = await api(`/api/top-artists?time_range=${range}&limit=50`);
    state.topArtists[range] = data.items;
    renderTopArtists(data.items);
  } catch (err) {
    $('topArtistsList').innerHTML = errorMsg('Impossibile caricare gli artisti');
  }
}

function renderTopArtists(artists) {
  $('topArtistsList').innerHTML = artists.map((artist, i) => `
    <div class="artist-card">
      <div class="artist-rank">#${i + 1}</div>
      <img class="artist-img" src="${artist.images?.[0]?.url || ''}" alt="${escHtml(artist.name)}" loading="lazy" />
      <div class="artist-name">${escHtml(artist.name)}</div>
      <div class="artist-genres">${(artist.genres || []).slice(0, 2).join(', ')}</div>
    </div>
  `).join('');
}

/* ─── Recent ─────────────────────────────────────────────────────────────────── */
async function loadRecent() {
  if (state.recentTracks) { renderRecent(state.recentTracks); return; }
  $('recentList').innerHTML = skeletonRows(10);
  try {
    const data = await api('/api/recently-played?limit=50');
    state.recentTracks = data.items;
    renderRecent(data.items);
  } catch (err) {
    $('recentList').innerHTML = errorMsg('Impossibile caricare i brani recenti');
  }
}

function renderRecent(items) {
  $('recentList').innerHTML = items.map((item, i) => {
    const track = item.track;
    return `
      <div class="track-item" onclick="playTrack('${track.uri}', '${escHtml(track.name)}', '${escHtml(track.artists[0]?.name || '')}', '${track.album.images[0]?.url || ''}')">
        <span class="track-num">${i + 1}</span>
        <div class="track-art-wrap">
          <img class="track-art" src="${track.album.images[0]?.url || ''}" alt="" loading="lazy" />
          <div class="track-play-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
        </div>
        <div class="track-details">
          <div class="track-name">${escHtml(track.name)}</div>
          <div class="track-artist">${escHtml(track.artists.map(a => a.name).join(', '))}</div>
        </div>
        <span class="track-when">${fmtTimeAgo(item.played_at)}</span>
      </div>
    `;
  }).join('');
}

/* ─── Playlists ──────────────────────────────────────────────────────────────── */
async function loadPlaylists() {
  if (state.playlists) { renderPlaylists(state.playlists); return; }
  $('playlistsGrid').innerHTML = skeletonPlaylists(6);
  try {
    const data = await api('/api/playlists?limit=50');
    state.playlists = data.items;
    renderPlaylists(data.items);
  } catch (err) {
    $('playlistsGrid').innerHTML = errorMsg('Impossibile caricare le playlist');
  }
}

function renderPlaylists(playlists) {
  $('playlistsGrid').style.display = 'grid';
  $('playlistTracksPanel').style.display = 'none';
  $('playlistsGrid').innerHTML = playlists.map(pl => `
    <div class="playlist-card" onclick="openPlaylist('${pl.id}', '${escHtml(pl.name)}')">
      <img class="playlist-img" src="${pl.images?.[0]?.url || ''}" alt="${escHtml(pl.name)}" loading="lazy" />
      <div class="playlist-info">
        <div class="playlist-name">${escHtml(pl.name)}</div>
        <div class="playlist-count">${pl.tracks.total} brani</div>
      </div>
    </div>
  `).join('');
}

async function openPlaylist(id, name) {
  $('playlistsGrid').style.display = 'none';
  const panel = $('playlistTracksPanel');
  panel.style.display = 'block';
  $('playlistTracksTitle').textContent = name;
  $('playlistTracksList').innerHTML = skeletonRows(8);
  try {
    const data = await api(`/api/playlist/${id}/tracks`);
    const tracks = data.items.filter(i => i.track && i.track.id);
    $('playlistTracksList').innerHTML = tracks.map((item, i) => {
      const track = item.track;
      return `
        <div class="track-item" onclick="playTrack('${track.uri}', '${escHtml(track.name)}', '${escHtml(track.artists[0]?.name || '')}', '${track.album.images[0]?.url || ''}')">
          <span class="track-num">${i + 1}</span>
          <div class="track-art-wrap">
            <img class="track-art" src="${track.album.images[0]?.url || ''}" alt="" loading="lazy" />
            <div class="track-play-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
          </div>
          <div class="track-details">
            <div class="track-name">${escHtml(track.name)}</div>
            <div class="track-artist">${escHtml(track.artists.map(a => a.name).join(', '))}</div>
          </div>
          <span class="track-duration">${fmt(track.duration_ms)}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    $('playlistTracksList').innerHTML = errorMsg('Impossibile caricare i brani');
  }
}

/* ─── Search ─────────────────────────────────────────────────────────────────── */
function initSearch() {
  const input = $('searchInput');
  const clear = $('searchClear');

  input.addEventListener('input', () => {
    clear.style.display = input.value ? 'block' : 'none';
    clearTimeout(state.searchTimeout);
    if (!input.value.trim()) {
      $('searchResults').innerHTML = '';
      $('searchEmpty').style.display = 'block';
      return;
    }
    state.searchTimeout = setTimeout(() => doSearch(input.value.trim()), 350);
  });

  clear.addEventListener('click', () => {
    input.value = '';
    clear.style.display = 'none';
    $('searchResults').innerHTML = '';
    $('searchEmpty').style.display = 'block';
    input.focus();
  });
}

async function doSearch(q) {
  $('searchEmpty').style.display = 'none';
  $('searchResults').innerHTML = skeletonRows(5);
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&type=track&limit=30`);
    const tracks = data.tracks?.items || [];
    if (!tracks.length) {
      $('searchResults').innerHTML = `<div class="search-empty"><p>Nessun risultato per "${escHtml(q)}"</p></div>`;
      return;
    }
    $('searchResults').innerHTML = tracks.map((track, i) => `
      <div class="track-item" onclick="playTrack('${track.uri}', '${escHtml(track.name)}', '${escHtml(track.artists[0]?.name || '')}', '${track.album.images[0]?.url || ''}')">
        <span class="track-num">${i + 1}</span>
        <div class="track-art-wrap">
          <img class="track-art" src="${track.album.images[0]?.url || ''}" alt="" loading="lazy" />
          <div class="track-play-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
        </div>
        <div class="track-details">
          <div class="track-name">${escHtml(track.name)}</div>
          <div class="track-artist">${escHtml(track.artists.map(a => a.name).join(', '))}</div>
        </div>
        <span class="track-duration">${fmt(track.duration_ms)}</span>
      </div>
    `).join('');
  } catch (err) {
    $('searchResults').innerHTML = errorMsg('Ricerca fallita');
  }
}

/* ─── Player ─────────────────────────────────────────────────────────────────── */
async function playTrack(uri, name, artist, art) {
  try {
    await api('/api/player/play', {
      method: 'PUT',
      body: JSON.stringify({ uris: [uri] })
    });
    updatePlayerUI(name, artist, art, true);
    showToast(`▶ ${name}`, 'success');
    startPlayerPoll();
  } catch (err) {
    // No active device: prompt user to open Spotify
    showToast('Apri Spotify su un dispositivo per riprodurre brani', 'error', 5000);
    updatePlayerUI(name, artist, art, false);
  }
}

function updatePlayerUI(title, artist, art, playing) {
  $('playerTitle').textContent = title;
  $('playerArtist').textContent = artist;
  $('playerArt').src = art;
  $('playerArt').style.display = art ? 'block' : 'none';
  setPlayPauseIcon(playing);
  state.playerState.isPlaying = playing;
}

function setPlayPauseIcon(playing) {
  const playIcon = $('playPauseBtn').querySelector('.icon-play');
  const pauseIcon = $('playPauseBtn').querySelector('.icon-pause');
  if (playing) {
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';
  } else {
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
  }
}

async function togglePlayPause() {
  try {
    if (state.playerState.isPlaying) {
      await api('/api/player/pause', { method: 'POST' });
      state.playerState.isPlaying = false;
      setPlayPauseIcon(false);
    } else {
      await api('/api/player/play', { method: 'PUT', body: JSON.stringify({}) });
      state.playerState.isPlaying = true;
      setPlayPauseIcon(true);
    }
  } catch (err) {
    showToast('Apri Spotify su un dispositivo', 'error');
  }
}

async function pollPlayer() {
  try {
    const data = await api('/api/player');
    if (data && data.item) {
      const track = data.item;
      updatePlayerUI(
        track.name,
        track.artists[0]?.name || '',
        track.album.images[0]?.url || '',
        data.is_playing
      );
    }
  } catch (err) {
    // Silently ignore player poll errors
  }
}

function startPlayerPoll() {
  if (state.playerPollInterval) return;
  state.playerPollInterval = setInterval(pollPlayer, 5000);
}

/* ─── Volume ─────────────────────────────────────────────────────────────────── */
let volumeDebounce;
$('volumeSlider').addEventListener('input', e => {
  clearTimeout(volumeDebounce);
  volumeDebounce = setTimeout(async () => {
    try {
      await api('/api/player/volume', { method: 'PUT', body: JSON.stringify({ volume_percent: parseInt(e.target.value) }) });
    } catch (err) { /* no active device */ }
  }, 300);
});

/* ─── Skeleton / Error helpers ───────────────────────────────────────────────── */
function skeletonRows(n) {
  return Array(n).fill(0).map(() => `
    <div class="track-item" style="pointer-events:none">
      <div class="skeleton" style="width:20px;height:16px;border-radius:4px"></div>
      <div class="skeleton" style="width:44px;height:44px;border-radius:6px;flex-shrink:0"></div>
      <div style="flex:1;display:flex;flex-direction:column;gap:6px">
        <div class="skeleton" style="height:13px;width:60%;border-radius:4px"></div>
        <div class="skeleton" style="height:11px;width:40%;border-radius:4px"></div>
      </div>
    </div>
  `).join('');
}
function skeletonArtists(n) {
  return Array(n).fill(0).map(() => `
    <div class="artist-card" style="pointer-events:none">
      <div class="skeleton" style="width:90px;height:90px;border-radius:50%;margin:0 auto 0.75rem"></div>
      <div class="skeleton" style="height:13px;width:70%;margin:0 auto 6px;border-radius:4px"></div>
      <div class="skeleton" style="height:11px;width:50%;margin:0 auto;border-radius:4px"></div>
    </div>
  `).join('');
}
function skeletonPlaylists(n) {
  return Array(n).fill(0).map(() => `
    <div class="playlist-card" style="pointer-events:none">
      <div class="skeleton" style="width:100%;aspect-ratio:1"></div>
      <div style="padding:0.85rem 1rem">
        <div class="skeleton" style="height:13px;width:70%;border-radius:4px;margin-bottom:6px"></div>
        <div class="skeleton" style="height:11px;width:40%;border-radius:4px"></div>
      </div>
    </div>
  `).join('');
}
function errorMsg(msg) {
  return `<div style="padding:2rem;color:var(--text-3);text-align:center;font-size:0.9rem">⚠ ${msg}</div>`;
}
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ─── Event Wiring ───────────────────────────────────────────────────────────── */
function initEvents() {
  // Nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.section));
  });

  // Time range tabs - top tracks
  document.querySelectorAll('#topTracksTabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#topTracksTabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadTopTracks(btn.dataset.range);
    });
  });

  // Time range tabs - top artists
  document.querySelectorAll('#topArtistsTabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#topArtistsTabs .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadTopArtists(btn.dataset.range);
    });
  });

  // Theme toggles
  ['themeToggle', 'themeToggleMobile'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
  });

  // Logout
  $('logoutBtn').addEventListener('click', () => { window.location.href = '/logout'; });

  // Player controls
  $('playPauseBtn').addEventListener('click', togglePlayPause);
  $('nextBtn').addEventListener('click', async () => {
    try { await api('/api/player/next', { method: 'POST' }); setTimeout(pollPlayer, 800); } catch {}
  });
  $('prevBtn').addEventListener('click', async () => {
    try { await api('/api/player/previous', { method: 'POST' }); setTimeout(pollPlayer, 800); } catch {}
  });

  // Back from playlist
  $('backFromPlaylist').addEventListener('click', () => renderPlaylists(state.playlists));

  // Mobile hamburger
  $('hamburger').addEventListener('click', openSidebar);
  $('sidebarOverlay').addEventListener('click', closeSidebar);
}

/* ─── Init ───────────────────────────────────────────────────────────────────── */
async function init() {
  // Apply saved theme
  applyTheme(state.theme);

  // Init events
  initEvents();
  initSearch();

  // Load user
  await loadUser();

  // Poll player once at start
  pollPlayer();
  startPlayerPoll();
}

document.addEventListener('DOMContentLoaded', init);
