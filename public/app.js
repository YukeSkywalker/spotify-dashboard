async function init() {
    const { authenticated } = await fetch('/api/auth-check').then(r => r.json());
    if (authenticated) {
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
        loadUser();
        showView('home');
        setInterval(updatePlayer, 3000);
    }
}

async function loadUser() {
    const user = await fetch('/api/me').then(r => r.json());
    document.getElementById('user-profile').innerHTML = `<p style="color:var(--green)">● ${user.display_name}</p>`;
}

async function showView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById(`view-${viewId}`).classList.remove('hidden');
    
    // Trova il bottone cliccato e aggiungi active
    const btns = document.querySelectorAll('.nav-item');
    btns.forEach(b => { if(b.getAttribute('onclick').includes(viewId)) b.classList.add('active'); });

    if (viewId === 'home') loadHome();
    if (viewId === 'tracks') renderGrid('/api/top-tracks', 'grid-tracks', 'track');
    if (viewId === 'artists') renderGrid('/api/top-artists', 'grid-artists', 'artist');
    if (viewId === 'recent') renderGrid('/api/recent', 'grid-recent', 'recent');
    if (viewId === 'playlists') renderGrid('/api/playlists', 'grid-playlists', 'playlist');
    if (viewId === 'stats') loadStats();
}

async function renderGrid(url, containerId, type) {
    const data = await fetch(url).then(r => r.json());
    const container = document.getElementById(containerId);
    container.innerHTML = data.map(item => {
        const obj = type === 'recent' ? item.track : item;
        const img = (type === 'artist') ? obj.images[0]?.url : (obj.album?.images[0]?.url || obj.images?.[0]?.url);
        return `
            <div class="card" onclick="play('${obj.uri}')">
                <img src="${img || ''}">
                <h4>${obj.name}</h4>
                <p>${type === 'artist' ? 'Artista' : (obj.artists?.[0]?.name || 'Playlist')}</p>
            </div>
        `;
    }).join('');
}

async function loadHome() {
    const tracks = await fetch('/api/top-tracks').then(r => r.json());
    const artists = await fetch('/api/top-artists').then(r => r.json());
    if(tracks[0]) document.getElementById('hero-track').innerHTML = `<h3>TOP TRACK</h3><h2>${tracks[0].name}</h2><p>${tracks[0].artists[0].name}</p>`;
    if(artists[0]) document.getElementById('hero-artist').innerHTML = `<h3>TOP ARTIST</h3><h2>${artists[0].name}</h2><p>Il tuo preferito</p>`;
}

async function loadStats() {
    const tracks = await fetch('/api/top-tracks').then(r => r.json());
    const cont = document.getElementById('stats-container');
    cont.innerHTML = `
        <div class="card"><h2>${tracks.length}</h2><p>Brani Analizzati</p></div>
        <div class="card"><h2>${Math.floor(tracks.length * 3.5)}</h2><p>Minuti Stimati</p></div>
        <div class="card"><h2>Premium</h2><p>Status Account</p></div>
    `;
}

async function doSearch(q) {
    if (q.length < 3) return;
    const data = await fetch(`/api/search?q=${q}`).then(r => r.json());
    document.getElementById('grid-search').innerHTML = data.tracks.items.map(t => `
        <div class="card" onclick="play('${t.uri}')">
            <img src="${t.album.images[0].url}">
            <h4>${t.name}</h4><p>${t.artists[0].name}</p>
        </div>
    `).join('');
}

async function play(uri) { 
    await fetch('/api/play', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ uri }) });
    setTimeout(updatePlayer, 500);
}

async function control(cmd) { 
    await fetch(`/api/${cmd}`, { method: 'POST' }); 
    setTimeout(updatePlayer, 500);
}

async function updatePlayer() {
    const data = await fetch('/api/current').then(r => r.status === 204 ? null : r.json());
    const info = document.getElementById('player-track');
    if (data && data.item) {
        info.innerHTML = `<img src="${data.item.album.images[0].url}"><div><b>${data.item.name}</b><br><small>${data.item.artists[0].name}</small></div>`;
    }
}

init();
