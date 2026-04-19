const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");

const userDiv = document.getElementById("user");
const tracksDiv = document.getElementById("tracks");
const artistsDiv = document.getElementById("artists");
const currentDiv = document.getElementById("current");
const minutesDiv = document.getElementById("minutes");

const playBtn = document.getElementById("play");
const pauseBtn = document.getElementById("pause");
const nextBtn = document.getElementById("next");

loginBtn.onclick = () => window.location.href = "/login";
logoutBtn.onclick = () => window.location.href = "/logout";

async function api(url, method = "GET", body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 401) return null;
  return res.json();
}

// PLAYER CONTROLS
playBtn.onclick = async () => {
  const tracks = await api("/api/top-tracks");
  if (!tracks) return;

  const first = tracks.items[0];
  await api("/api/play", "PUT", { uri: first.uri });
};

pauseBtn.onclick = () => api("/api/pause", "PUT");
nextBtn.onclick = () => api("/api/next", "POST");

// LOAD DATA
async function loadData() {
  const user = await api("/api/me");
  if (!user) return;

  userDiv.innerHTML = `
    <h2>${user.display_name}</h2>
    <p>${user.email}</p>
  `;

  const tracks = await api("/api/top-tracks");
  tracksDiv.innerHTML =
    "<h3>Top Tracks</h3>" +
    tracks.items.map(t => `<p>${t.name}</p>`).join("");

  // CALCOLO MINUTI
  let totalMs = tracks.items.reduce((sum, t) => sum + t.duration_ms, 0);
  let minutes = Math.round(totalMs / 60000);
  minutesDiv.innerHTML = `<h3>Minuti ascolto stimati: ${minutes}</h3>`;

  const artists = await api("/api/top-artists");
  artistsDiv.innerHTML =
    "<h3>Top Artists</h3>" +
    artists.items.map(a => `<p>${a.name}</p>`).join("");

  loadCurrent();
}

// TRACK ATTUALE
async function loadCurrent() {
  const current = await api("/api/current");
  if (!current || !current.item) return;

  currentDiv.innerHTML = `
    <h3>In riproduzione</h3>
    <p>${current.item.name}</p>
  `;

  setTimeout(loadCurrent, 5000);
}

loadData();
