let isPlaying = false;
let webPlayerReady = false;

async function init() {
  const { loggedIn } = await fetch('/api/auth-status').then(r => r.json());
  if (!loggedIn) {
    document.getElementById('login-btn').style.display = 'inline-block';
    return;
  }
  document.getElementById('dashboard').style.display = 'block';
  loadTopTracks();
  loadTopArtists();
  loadNowPlaying();
  loadDevices();
  setInterval(loadNowPlaying, 5000);

  const { token } = await fetch('/api/token').then(r => r.json());
  initWebPlayer(token);
}

function initWebPlayer(token) {
  window.onSpotifyWebPlaybackSDKReady = () => {
    const player = new Spotify.Player({
      name: 'Spotify Dashboard Web Player',
      getOAuthToken: cb => cb(token),
      volume: 0.8,
    });
    player.addListener('ready', ({ device_id }) => {
      console.log('Web Player pronto:', device_id);
      fetch(`/api/player/transfer?device_id=${device_id}`, { method: 'PUT' });
      setTimeout(loadDevices, 1000);
      webPlayerReady = true;
    });
    player.addListener('player_state_changed', state => {
      if (!state) return;
      isPlaying = !state.paused;
      const btn = document.getElementById('play-pause-btn');
      if (btn) btn.textContent = isPlaying ? '⏸' : '▶';
      loadNowPlaying();
    });
    player.connect();
  };
}

async function loadNowPlaying() {
  const data = await fetch('/api/now-playing').then(r => r.json());
  const el = document.getElementById('now-playing');
  const btn = document.getElementById('play-pause-btn');
  if (!data.playing) {
    el.innerHTML = `<p class="np-not-playing">Nessuna riproduzione in corso.</p>`;
    if (btn) { btn.textContent = '▶'; isPlaying = false; }
    return;
  }
  isPlaying = true;
  if (btn) btn.textContent = '⏸';
  const t = data.track;
  const pct = Math.round((data.progress / t.duration_ms) * 100);
  el.innerHTML = `
    <div class="now-playing-card">
      <div class="live-dot"></div>
      <img src="${t.album.images[1]?.url || ''}" alt="${t.name}"/>
      <div class="np-info">
        <div class="np-track">${t.name}</div>
        <div class="np-artist">${t.artists.map(a => a.name).join(', ')} · ${t.album.name}</div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width:${pct}%"></div>
        </div>
      </div>
    </div>`;
}

async function togglePlay() {
  const endpoint = isPlaying ? '/api/player/pause' : '/api/player/play';
  await fetch(endpoint, { method: 'POST' });
  isPlaying = !isPlaying;
  document.getElementById('play-pause-btn').textContent = isPlaying ? '⏸' : '▶';
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

let volumeTimeout;
function setVolume(val) {
  clearTimeout(volumeTimeout);
  volumeTimeout = setTimeout(() => {
    fetch(`/api/player/volume?volume=${val}`, { method: 'POST' });
  }, 200);
}

async function loadDevices() {
  const data = await fetch('/api/devices').then(r => r.json());
  const sel = document.getElementById('device-select');
  if (!data.devices?.length) {
    sel.innerHTML = '<option>Nessun dispositivo attivo</option>';
    return;
  }
  sel.innerHTML = data.devices.map(d =>
    `<option value="${d.id}" ${d.is_active ? 'selected' : ''}>${d.name} (${d.type})</option>`
  ).join('');
}

async function transferPlayback(deviceId) {
  await fetch(`/api/player/transfer?device_id=${deviceId}`, { method: 'PUT' });
  setTimeout(loadNowPlaying, 800);
}

async function searchTracks() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;
  const data = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then(r => r.json());
  const el = document.getElementById('search-results');
  el.innerHTML = data.tracks.items.map((t, i) => `
    <li class="track-item">
      <span class="item-rank">${i + 1}</span>
      <img class="item-img" src="${t.album.images[2]?.url || ''}" alt="${t.name}"/>
      <div class="item-info">
        <div class="item-name">${t.name}</div>
        <div class="item-sub">${t.artists.map(a => a.name).join(', ')}</div>
      </div>
      <button class="add-btn" onclick="addToQueue('${t.uri}', this)">+ Coda</button>
    </li>`).join('');
}

async function addToQueue(uri, btn) {
  await fetch(`/api/player/queue?uri=${encodeURIComponent(uri)}`, { method: 'POST' });
  btn.textContent = '✓ Aggiunto';
  btn.style.color = '#1DB954';
  btn.style.borderColor = '#1DB954';
  setTimeout(() => { btn.textContent = '+ Coda'; btn.style.color = ''; btn.style.borderColor = ''; }, 2000);
}

async function loadTopTracks() {
  const data = await fetch('/api/top-tracks').then(r => r.json());
  document.getElementById('top-tracks').innerHTML = data.items.map((t, i) => `
    <li class="track-item">
      <span class="item-rank">${i + 1}</span>
      <img class="item-img" src="${t.album.images[2]?.url || ''}" alt="${t.name}"/>
      <div class="item-info">
        <div class="item-name">${t.name}</div>
        <div class="item-sub">${t.artists.map(a => a.name).join(', ')}</div>
      </div>
      <button class="add-btn" onclick="addToQueue('${t.uri}', this)">+ Coda</button>
    </li>`).join('');
}

async function loadTopArtists() {
  const data = await fetch('/api/top-artists').then(r => r.json());
  document.getElementById('top-artists').innerHTML = data.items.map((a, i) => `
    <li class="artist-item">
      <span class="item-rank">${i + 1}</span>
      <img class="item-img" src="${a.images[2]?.url || ''}" alt="${a.name}"/>
      <div class="item-info">
        <div class="item-name">${a.name}</div>
        <div class="item-sub">${a.genres.slice(0, 2).join(', ') || 'artista'}</div>
      </div>
    </li>`).join('');
}

init();