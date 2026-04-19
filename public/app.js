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

playBtn.onclick = async () => {
  const tracks = await api("/api/top-tracks");
  if (!tracks) return;

  await api("/api/play", "PUT", { uri: tracks.items[0].uri });
};

pauseBtn.onclick = () => api("/api/pause", "PUT");
nextBtn.onclick = () => api("/api/next", "POST");

async function loadData() {
  const user = await api("/api/me");
  if (!user) return;

  userDiv.innerHTML = `<h2>${user.display_name}</h2>`;

  const tracks = await api("/api/top-tracks");

  tracksDiv.innerHTML =
    "<h3>Top Tracks</h3>" +
    tracks.items.map(t => `<p>${t.name}</p>`).join("");

  let total = tracks.items.reduce((sum, t) => sum + t.duration_ms, 0);
  minutesDiv.innerHTML = `<h3>Minuti stimati: ${Math.round(total / 60000)}</h3>`;

  const artists = await api("/api/top-artists");

  artistsDiv.innerHTML =
    "<h3>Top Artists</h3>" +
    artists.items.map(a => `<p>${a.name}</p>`).join("");

  loadCurrent();
}

async function loadCurrent() {
  const current = await api("/api/current");

  if (current && current.item) {
    currentDiv.innerHTML = `<p>Now playing: ${current.item.name}</p>`;
  }

  setTimeout(loadCurrent, 5000);
}

loadData();
