const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");

const appDiv = document.getElementById("app");
const userEl = document.getElementById("user");
const tracksEl = document.getElementById("tracks");

loginBtn.onclick = () => {
  window.location.href = "/login";
};

logoutBtn.onclick = async () => {
  await apiFetch("/logout", "POST");
  localStorage.removeItem("session_id");
  location.reload();
};

async function apiFetch(url, method = "GET") {
  const session = localStorage.getItem("session_id");

  const res = await fetch(url, {
    method,
    headers: {
      "x-session-id": session,
    },
  });

  if (res.status === 401) {
    localStorage.removeItem("session_id");
    location.reload();
    return;
  }

  return res.json();
}

async function init() {
  const params = new URLSearchParams(location.search);
  const session = params.get("session");

  if (session) {
    localStorage.setItem("session_id", session);
    history.replaceState({}, "", "/");
  }

  const saved = localStorage.getItem("session_id");
  if (!saved) return;

  loginBtn.style.display = "none";
  logoutBtn.style.display = "inline-block";
  appDiv.style.display = "block";

  const me = await apiFetch("/api/me");
  userEl.textContent = JSON.stringify(me, null, 2);

  const tracks = await apiFetch("/api/top-tracks");
  tracksEl.textContent = JSON.stringify(tracks, null, 2);
}

init();
