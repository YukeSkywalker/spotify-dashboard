// ================= BASE =================
const userDiv = document.getElementById("user");
const contentDiv = document.getElementById("content");
const playerDiv = document.getElementById("player");

// ================= NAV =================
const routes = {
  overview: loadOverview,
  tracks: loadTopTracks,
  artists: loadTopArtists,
  recent: loadRecent,
  playlists: loadPlaylists,
  search: loadSearch,
  stats: loadStats,
  player: loadPlayer
};

document.querySelectorAll("[data-route]").forEach(el => {
  el.addEventListener("click", () => {
    const route = el.getAttribute("data-route");
    routes[route]();
  });
});

// ================= API =================
async function api(url, options = {}) {
  try {
    const res = await fetch(url, options);

    if (res.status === 401) {
      location.href = "/";
      return null;
    }

    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Errore");

    return data;
  } catch (e) {
    console.error(e);
    contentDiv.innerHTML = `<p style="color:red">${e.message}</p>`;
    return null;
  }
}

// ================= USER =================
aasync function loadUser() {
  const user = await api("/api/me");

  if (!user) {
    userDiv.innerHTML = "<p>Non autenticato</p>";
    return false;
  }

  userDiv.innerHTML = `
    <h2>${user.display_name}</h2>
  `;

  return true;
}

// ================= PANORAMICA =================
async function loadOverview() {
  contentDiv.innerHTML = "<p>Loading...</p>";

  const tracks = await api("/api/top-tracks");
  const artists = await api("/api/top-artists");

  if (!tracks || !artists) return;

  contentDiv.innerHTML = `
    <h2>Panoramica</h2>

    <h3>Top Track</h3>
    <p>${tracks.items[0].name}</p>

    <h3>Top Artist</h3>
    <p>${artists.items[0].name}</p>
  `;
}

// ================= TOP TRACKS =================
async function loadTopTracks() {
  const data = await api("/api/top-tracks");
  if (!data) return;

  contentDiv.innerHTML =
    "<h2>Top Tracks</h2>" +
    data.items
      .map(
        t => `
        <div class="card" data-uri="${t.uri}">
          ${t.name} - ${t.artists[0].name}
        </div>`
      )
      .join("");

  bindPlay();
}

// ================= TOP ARTISTS =================
async function loadTopArtists() {
  const data = await api("/api/top-artists");
  if (!data) return;

  contentDiv.innerHTML =
    "<h2>Top Artists</h2>" +
    data.items.map(a => `<p>${a.name}</p>`).join("");
}

// ================= RECENTI =================
async function loadRecent() {
  const data = await api("/api/recent");
  if (!data) return;

  contentDiv.innerHTML =
    "<h2>Recenti</h2>" +
    data.items
      .map(
        r => `<p>${r.track.name} - ${r.track.artists[0].name}</p>`
      )
      .join("");
}

// ================= PLAYLIST =================
async function loadPlaylists() {
  const data = await api("/api/playlists");
  if (!data) return;

  contentDiv.innerHTML =
    "<h2>Playlist</h2>" +
    data.items.map(p => `<p>${p.name}</p>`).join("");
}

// ================= SEARCH =================
async function loadSearch() {
  contentDiv.innerHTML = `
    <h2>Cerca</h2>
    <input id="searchInput" placeholder="Cerca brano..." />
    <div id="searchResults"></div>
  `;

  document.getElementById("searchInput").addEventListener("input", async e => {
    const q = e.target.value;

    if (q.length < 3) return;

    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (!data) return;

    document.getElementById("searchResults").innerHTML =
      data.tracks.items
        .map(
          t => `<div class="card" data-uri="${t.uri}">
            ${t.name} - ${t.artists[0].name}
          </div>`
        )
        .join("");

    bindPlay();
  });
}

// ================= STATISTICHE =================
async function loadStats() {
  const tracks = await api("/api/top-tracks");

  if (!tracks) return;

  const total = tracks.items.reduce((s, t) => s + t.duration_ms, 0);
  const minutes = Math.round(total / 60000);

  contentDiv.innerHTML = `
    <h2>Statistiche</h2>
    <p>Minuti ascolto stimati: ${minutes}</p>
    <p>Brani analizzati: ${tracks.items.length}</p>
  `;
}

// ================= PLAYER =================
async function loadPlayer() {
  const data = await api("/api/current");

  if (!data || !data.item) {
    playerDiv.innerHTML = "<p>Nessuna riproduzione</p>";
    return;
  }

  playerDiv.innerHTML = `
    <h3>In riproduzione</h3>
    <p>${data.item.name}</p>
    <button onclick="pause()">⏸</button>
    <button onclick="next()">⏭</button>
  `;
}

// ================= PLAYBACK =================
async function play(uri) {
  await api("/api/play", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uri })
  });
}

async function pause() {
  await api("/api/pause", { method: "PUT" });
}

async function next() {
  await api("/api/next", { method: "POST" });
}

function bindPlay() {
  document.querySelectorAll(".card").forEach(el => {
    el.addEventListener("click", () => {
      const uri = el.getAttribute("data-uri");
      play(uri);
    });
  });
}

// ================= LOOP PLAYER =================
setInterval(loadPlayer, 5000);

// ================= INIT =================
async function init() {
  await loadUser();
  await loadOverview();
}

init();
