const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const userDiv = document.getElementById("user");
const tracksDiv = document.getElementById("tracks");

loginBtn.onclick = () => {
  window.location.href = "/login";
};

logoutBtn.onclick = () => {
  window.location.href = "/logout";
};

async function loadData() {
  try {
    const userRes = await fetch("/api/me");
    if (userRes.status === 401) return;

    const user = await userRes.json();

    userDiv.innerHTML = `
      <h2>${user.display_name}</h2>
      <p>${user.email}</p>
      <img src="${user.images?.[0]?.url || ""}" width="100"/>
    `;

    const tracksRes = await fetch("/api/top-tracks");
    const tracks = await tracksRes.json();

    tracksDiv.innerHTML = "<h3>Top Tracks</h3>" +
      tracks.items.map(t => `<p>${t.name} - ${t.artists[0].name}</p>`).join("");

  } catch (err) {
    console.error(err);
  }
}

loadData();
