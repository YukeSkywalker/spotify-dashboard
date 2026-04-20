async function spotifyApi(url, method = 'GET', body = null) {
    const opts = { method };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (res.status === 401) window.location.href = '/';
    return res.json();
}

async function init() {
    const user = await spotifyApi('/api/me');
    document.getElementById('user-display').innerHTML = `<img src="${user.images[0]?.url || ''}" style="width:30px; border-radius:50%; margin-right:10px"> ${user.display_name}`;
    loadOverview();
    startPolling();
}

function switchTab(tabId) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.getElementById(tabId).classList.remove('hidden');
    event.currentTarget.classList.add('active');
    
    if (tabId === 'top-tracks') loadGrid('/api/top-tracks', 'grid-tracks', 'track');
    if (tabId === 'top-artists') loadGrid('/api/top-artists', 'grid-artists', 'artist');
    if (tabId === 'recent') loadGrid('/api/recent', 'grid-recent', 'recent');
    if (tabId === 'playlists') loadGrid('/api/playlists', 'grid-playlists', 'playlist');
    if (tabId === 'stats') loadStats();
}

async function loadOverview() {
    const tracks = await spotifyApi('/api/top-tracks');
    const artists = await spotifyApi('/api/top-artists');
    
    if(tracks[0]) document.getElementById('best-track').innerHTML = `<h3>La tua traccia preferita</h3><img src="${tracks[0].album.images[0].url}" style="width:100px; border-radius:4px"><p>${tracks[0].name}</p>`;
    if(artists[0]) document.getElementById('best-artist').innerHTML = `<h3>Il tuo artista top</h3><img src="${artists[0].images[0].url}" style="width:100px; border-radius:4px"><p>${artists[0].name}</p>`;
}

async function loadGrid(url, containerId, type) {
    const data = await spotifyApi(url);
    const items = type === 'recent' ? data.map(d => d.track) : data;
    document.getElementById(containerId).innerHTML = items.map(i => `
        <div class="card" onclick="playTrack('${i.uri}')">
            <img src="${(type === 'artist' ? i.images[0]?.url : i.album?.images[0]?.url) || ''}">
            <h4>${i.name}</h4>
            <p>${i.artists ? i.artists[0].name : (i.owner ? 'di ' + i.owner.display_name : '')}</p>
        </div>
    `).join('');
}

async function loadStats() {
    const tracks = await spotifyApi('/api/top-tracks');
    const popularity = Math.round(tracks.reduce((acc, t) => acc + t.popularity, 0) / tracks.length);
    document.getElementById('stats-content').innerHTML = `
        <div class="hero-card"><h2>Popolarità Media</h2><h1 class="green">${popularity}%</h1><p>Quanto è mainstream la tua musica?</p></div>
        <div class="hero-card"><h2>Brani Analizzati</h2><h1 class="green">${tracks.length}</h1><p>Dati basati sugli ultimi 6 mesi</p></div>
    `;
}

async function playTrack(uri) {
    const res = await fetch('/api/play', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ uri }) });
    const data = await res.json();
    if (data.error) alert(data.error);
}

async function playerAction(action) {
    await fetch(`/api/${action}`, { method: 'POST' });
    setTimeout(updatePlayer, 500);
}

async function updatePlayer() {
    const data = await spotifyApi('/api/current');
    const container = document.getElementById('now-playing');
    if (data && data.item) {
        container.innerHTML = `<img src="${data.item.album.images[0].url}"><div><b>${data.item.name}</b><br><small>${data.item.artists[0].name}</small></div>`;
    } else {
        container.innerHTML = "Nessun brano in riproduzione";
    }
}

let searchTimer;
function handleSearch(q) {
    clearTimeout(searchTimer);
    if (q.length < 2) return;
    searchTimer = setTimeout(async () => {
        const data = await spotifyApi(`/api/search?q=${q}`);
        document.getElementById('grid-search').innerHTML = data.tracks.items.map(i => `
            <div class="card" onclick="playTrack('${i.uri}')">
                <img src="${i.album.images[0].url}">
                <h4>${i.name}</h4>
                <p>${i.artists[0].name}</p>
            </div>
        `).join('');
    }, 500);
}

function startPolling() {
    updatePlayer();
    setInterval(updatePlayer, 5000);
}

init();
