let isPlaying = false;

// ── THEME ─────────────────────────────────────────────
const html = document.documentElement;
const savedTheme = localStorage.getItem('theme') || 'dark';
html.setAttribute('data-theme', savedTheme);

document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});

// ── NAVIGATION ────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('section-' + item.dataset.section).classList.add('active');
  });
});

// ── INIT ──────────────────────────────────────────────
async function init() {
  const { loggedIn } = await fetch('/api/auth-status').then(r => r.json());

  if (!loggedIn) {
    document.getElementById('login-page').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    return;
  }

  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  await Promise.all([
    loadUserProfile(),
    loadNowPlaying(),
    loadDashTopTracks(),
    loadDashTopArtists(),
    loadFullTopTracks('short_term'),
    loadFullTopArtists('short_term'),
    loadPlaylists(),
    loadStats(),
    loadDevices(),
  ]);

  setInterval(loadNowPlaying, 5000);

  const res = await fetch('/api/token').then(r => r.json()).catch(() => ({}));
  if (res.token) initWebPlayer(res.token);
}

// ── USER PROFILE ──────────────────────────────────────
async function loadUserProfile() {
  try {
    const data = await fetch('/api/me').then(r => r.json());
    const el = document.getElementById('user-info');
    const img = data.images?.[0]?.url;
    const initial = (data.display_name || 'U')[0].toUpperCase();
    el.innerHTML = img
      ? `<img class="user-avatar" src="${img}" alt="${data.display_name}"/><span class="user-name">${data.display_name}</span>`
      : `<div class="user-avatar-placeholder">${initial}</div><span class="user-name">${data.display_name || 'Utente'}</span>`;
  } catch (e) {}
}

// ── NOW PLAYING ───────────────────────────────────────
async function loadNowPlaying() {
  try {
    const data = await fetch('/api/now-playing').then(r => r.json());
    const dash   = document.getElementById('now-playing-dash');
    const player = document.getElementById('now-playing-player');

    if (!data.playing || !data.track) {
      const empty = `<p class="np-empty">Nessuna riproduzione in corso.</p>`;
      if (dash)   dash.innerHTML   = empty;
      if (player) player.innerHTML = empty;
      isPlaying = false;
      updatePlayBtn(false);
      return;
    }

    isPlaying = true;
    updatePlayBtn(true);

    const t   = data.track;
    const pct = Math.round((data.progress / t.duration_ms) * 100);
    const img = t.album.images?.[1]?.url || '';

    const card = `
      <div class="np-card">
        <div class="live-dot"></div>
        <img class="np-img" src="${img}" alt="${t.name}"/>
        <div class="np-info">
          <div class="np-track">${t.name}</div>
          <div class="np-artist">${t.artists.map(a => a.name).join(', ')} · ${t.album.name}</div>
          <div class="np-progress-bg">
            <div class="np-progress-fill" style="width:${pct}%"></div>
          </div>
        </div>
      </div>`;

    if (dash)   dash.innerHTML   = card;
    if (player) player.innerHTML = card;
  } catch (e) {}
}

function updatePlayBtn(playing) {
  const iconPlay  = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  if (!iconPlay || !iconPause) return;
  iconPlay.style.display  = playing ? 'none'  : 'block';
  iconPause.style.display = playing ? 'block' : 'none';
}

// ── PLAYER CONTROLS ───────────────────────────────────
async function togglePlay() {
  await fetch(isPlaying ? '/api/player/pause' : '/api/player/play', { method: 'POST' });
  isPlaying = !isPlaying;
  updatePlayBtn(isPlaying);
  setTimeout(loadNowPlaying, 400);
}

async function nextTrack() {
  await fetch('/api/player/next', { method: 'POST' });
  setTimeout(loadNowPlaying, 600);
}

async function prevTrack() {
  await fetch('/api/player/previous', { method: 'POST' });
  setTimeout(loadNowPlaying, 600);
}

let volTimeout;
function setVolume(val) {
  clearTimeout(volTimeout);
  volTimeout = setTimeout(() => {
    fetch(`/api/player/volume?volume=${val}`, { method: 'POST' });
  }, 200);
}

async function loadDevices() {
  try {
    const data = await fetch('/api/devices').then(r => r.json());
    const sel  = document.getElementById('device-select');
    if (!sel) return;
    if (!data.devices?.length) {
      sel.innerHTML = '<option>Nessun dispositivo attivo</option>';
      return;
    }
    sel.innerHTML = data.devices.map(d =>
      `<option value="${d.id}" ${d.is_active ? 'selected' : ''}>${d.name} (${d.type})</option>`
    ).join('');
  } catch (e) {}
}

async function transferPlayback(deviceId) {
  await fetch(`/api/player/transfer?device_id=${deviceId}`, { method: 'PUT' });
  setTimeout(loadNowPlaying, 800);
}

// ── WEB PLAYBACK SDK ──────────────────────────────────
function initWebPlayer(token) {
  window.onSpotifyWebPlaybackSDKReady = () => {
    const player = new Spotify.Player({
      name: 'Music Dashboard',
      getOAuthToken: cb => cb(token),
      volume: 0.8,
    });
    player.addListener('ready', ({ device_id }) => {
      fetch(`/api/player/transfer?device_id=${device_id}`, { method: 'PUT' });
      setTimeout(loadDevices, 1000);
    });
    player.addListener('player_state_changed', state => {
      if (!state) return;
      isPlaying = !state.paused;
      updatePlayBtn(isPlaying);
      setTimeout(loadNowPlaying, 300);
    });
    player.connect();
  };
}

// ── TOP TRACKS ────────────────────────────────────────
async function loadDashTopTracks() {
  try {
    const data = await fetch('/api/top-tracks?range=short_term&limit=5').then(r => r.json());
    document.getElementById('dash-top-tracks').innerHTML = renderTrackList(data.items, false);
  } catch (e) {}
}

async function loadFullTopTracks(range) {
  try {
    const data = await fetch(`/api/top-tracks?range=${range}&limit=50`).then(r => r.json());
    document.getElementById('full-top-tracks').innerHTML = renderTrackList(data.items, true);
  } catch (e) {}
}

function renderTrackList(items, showAdd) {
  if (!items?.length) return '<li style="color:var(--text3);padding:0.5rem 0.6rem">Nessun dato disponibile</li>';
  return items.map((t, i) => `
    <li class="track-item">
      <span class="track-rank">${i + 1}</span>
      <img class="track-img" src="${t.album?.images?.[2]?.url || ''}" alt="${t.name}"/>
      <div class="track-info">
        <div class="track-name">${t.name}</div>
        <div class="track-sub">${t.artists?.map(a => a.name).join(', ')}</div>
      </div>
      ${showAdd ? `<button class="add-btn" onclick="addToQueue('${t.uri}', this)">+ Coda</button>` : ''}
    </li>`).join('');
}

// ── TOP ARTISTS ───────────────────────────────────────
async function loadDashTopArtists() {
  try {
    const data = await fetch('/api/top-artists?range=short_term&limit=5').then(r => r.json());
    const el = document.getElementById('dash-top-artists');
    if (!data.items?.length) { el.innerHTML = '<li style="color:var(--text3);padding:0.5rem">Nessun dato</li>'; return; }
    el.innerHTML = data.items.map((a, i) => `
      <li class="track-item">
        <span class="track-rank">${i + 1}</span>
        <img class="track-img" src="${a.images?.[2]?.url || ''}" alt="${a.name}" style="border-radius:50%"/>
        <div class="track-info">
          <div class="track-name">${a.name}</div>
          <div class="track-sub">${a.genres?.[0] || 'artista'}</div>
        </div>
      </li>`).join('');
  } catch (e) {}
}

async function loadFullTopArtists(range) {
  try {
    const data = await fetch(`/api/top-artists?range=${range}&limit=50`).then(r => r.json());
    const el = document.getElementById('full-top-artists');
    if (!data.items?.length) { el.innerHTML = '<p style="color:var(--text3)">Nessun dato</p>'; return; }
    el.innerHTML = data.items.map((a, i) => `
      <div class="artist-card">
        <div class="artist-rank">#${i + 1}</div>
        <img class="artist-img" src="${a.images?.[1]?.url || ''}" alt="${a.name}"/>
        <div class="artist-name">${a.name}</div>
        <div class="artist-genre">${a.genres?.[0] || ''}</div>
      </div>`).join('');
  } catch (e) {}
}

function switchRange(btn, type, range) {
  btn.closest('.timerange-tabs').querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  if (type === 'tracks') loadFullTopTracks(range);
  else loadFullTopArtists(range);
}

// ── PLAYLISTS ─────────────────────────────────────────
async function loadPlaylists() {
  try {
    const data = await fetch('/api/playlists').then(r => r.json());
    const el = document.getElementById('playlists-grid');
    if (!data.items?.length) { el.innerHTML = '<p style="color:var(--text3)">Nessuna playlist trovata</p>'; return; }
    el.innerHTML = data.items.map(p => `
      <div class="playlist-card">
        <img class="playlist-img" src="${p.images?.[0]?.url || ''}" alt="${p.name}"/>
        <div class="playlist-name">${p.name}</div>
        <div class="playlist-count">${p.tracks.total} brani</div>
      </div>`).join('');
  } catch (e) {}
}

// ── STATS ─────────────────────────────────────────────
async function loadStats() {
  try {
    const [tracksData, artistsData] = await Promise.all([
      fetch('/api/top-tracks?range=short_term&limit=50').then(r => r.json()),
      fetch('/api/top-artists?range=short_term&limit=50').then(r => r.json()),
    ]);

    const tracks  = tracksData.items  || [];
    const artists = artistsData.items || [];

    const uniqueArtists = new Set(tracks.flatMap(t => t.artists.map(a => a.name))).size;
    const avgPop = tracks.length
      ? Math.round(tracks.reduce((s, t) => s + t.popularity, 0) / tracks.length)
      : 0;

    const statsHtml = `
      <div class="stat-card"><div class="stat-label">Top brani</div><div class="stat-num">${tracks.length}</div><div class="stat-sub">ultimo mese</div></div>
      <div class="stat-card"><div class="stat-label">Artisti unici</div><div class="stat-num">${uniqueArtists}</div><div class="stat-sub">nei top brani</div></div>
      <div class="stat-card"><div class="stat-label">Popolarità media</div><div class="stat-num">${avgPop}</div><div class="stat-sub">su 100</div></div>
      <div class="stat-card"><div class="stat-label">Top artisti</div><div class="stat-num">${artists.length}</div><div class="stat-sub">tracciati</div></div>
    `;

    const el1 = document.getElementById('stats-cards');
    const el2 = document.getElementById('stats-cards-2');
    if (el1) el1.innerHTML = statsHtml;
    if (el2) el2.innerHTML = statsHtml;

    const genres = {};
    artists.forEach(a => a.genres?.slice(0, 2).forEach(g => { genres[g] = (genres[g] || 0) + 1; }));
    const sortedGenres = Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 7);
    const maxG = sortedGenres[0]?.[1] || 1;

    const genresHtml = sortedGenres.map(([g, n]) => `
      <div class="genre-row">
        <div class="genre-header"><span>${g}</span><span>${Math.round((n / maxG) * 100)}%</span></div>
        <div class="genre-bar-bg"><div class="genre-bar-fill" style="width:${Math.round((n / maxG) * 100)}%"></div></div>
      </div>`).join('');

    const gc = document.getElementById('genres-chart');
    const gf = document.getElementById('genres-full');
    if (gc) gc.innerHTML = genresHtml;
    if (gf) gf.innerHTML = genresHtml;

    const popHtml = artists.slice(0, 8).map(a => `
      <div class="genre-row">
        <div class="genre-header"><span>${a.name}</span><span>${a.popularity}</span></div>
        <div class="genre-bar-bg"><div class="genre-bar-fill" style="width:${a.popularity}%"></div></div>
      </div>`).join('');

    const pc = document.getElementById('popularity-chart');
    if (pc) pc.innerHTML = popHtml;
  } catch (e) {}
}

// ── SEARCH ────────────────────────────────────────────
async function searchTracks() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;
  try {
    const data = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then(r => r.json());
    const card = document.getElementById('search-results-card');
    const el   = document.getElementById('search-results');
    card.style.display = 'block';
    el.innerHTML = renderTrackList(data.tracks?.items, true);
  } catch (e) {}
}

async function addToQueue(uri, btn) {
  try {
    await fetch(`/api/player/queue?uri=${encodeURIComponent(uri)}`, { method: 'POST' });
    btn.textContent = '✓';
    btn.classList.add('added');
    setTimeout(() => { btn.textContent = '+ Coda'; btn.classList.remove('added'); }, 2000);
  } catch (e) {}
}

// ── START ─────────────────────────────────────────────
async function init() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('error')) {
    console.error('Errore login:', params.get('error'));
  }

  const { loggedIn } = await fetch('/api/auth-status').then(r => r.json());

  if (!loggedIn) {
    document.getElementById('login-page').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    return;
  }

  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  await Promise.all([
    loadUserProfile(),
    loadNowPlaying(),
    loadDashTopTracks(),
    loadDashTopArtists(),
    loadFullTopTracks('short_term'),
    loadFullTopArtists('short_term'),
    loadPlaylists(),
    loadStats(),
    loadDevices(),
  ]);

  setInterval(loadNowPlaying, 5000);

  const res = await fetch('/api/token').then(r => r.json()).catch(() => ({}));
  if (res.token) initWebPlayer(res.token);
}
