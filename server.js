import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import cookieParser from "cookie-parser";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI
} = process.env;

const sessions = new Map();

// ================= UTILS =================
function generateId() {
  return crypto.randomBytes(24).toString("hex");
}

// ================= AUTH =================
function requireAuth(req, res, next) {
  const sid = req.cookies.session_id;
  const session = sessions.get(sid);

  if (!session) return res.status(401).json({ error: "Unauthorized" });

  req.session = session;
  req.sid = sid;
  next();
}

// ================= LOGIN =================
app.get("/login", (req, res) => {
  const scope = [
    "user-read-email",
    "user-top-read",
    "user-read-playback-state",
    "user-modify-playback-state",
    "streaming"
  ].join(" ");

  const url = new URL("https://accounts.spotify.com/authorize");

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", SPOTIFY_CLIENT_ID);
  url.searchParams.set("scope", scope);
  url.searchParams.set("redirect_uri", SPOTIFY_REDIRECT_URI);

  res.redirect(url.toString());
});

// ================= CALLBACK =================
app.get("/callback", async (req, res) => {
  try {
    const code = req.query.code;

    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            SPOTIFY_CLIENT_ID + ":" + SPOTIFY_CLIENT_SECRET
          ).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI
      })
    });

    const data = await tokenRes.json();

    if (!data.access_token) {
      return res.status(400).send("Auth failed");
    }

    const sid = generateId();

    sessions.set(sid, {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000
    });

    res.cookie("session_id", sid, {
      httpOnly: true,
      sameSite: "lax"
    });

    res.redirect("/app.html");
  } catch (err) {
    res.status(500).send("Callback error");
  }
});

// ================= REFRESH =================
async function refreshToken(session) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(
          SPOTIFY_CLIENT_ID + ":" + SPOTIFY_CLIENT_SECRET
        ).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refresh_token
    })
  });

  const data = await res.json();

  if (data.access_token) {
    session.access_token = data.access_token;
    session.expires_at = Date.now() + data.expires_in * 1000;
  }
}

// ================= FETCH WRAPPER =================
async function spotifyFetch(session, url, options = {}) {
  if (Date.now() > session.expires_at) {
    await refreshToken(session);
  }

  let res = await fetch(url, {
    ...options,
    headers: {
      Authorization: "Bearer " + session.access_token,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (res.status === 401) {
    await refreshToken(session);

    res = await fetch(url, {
      ...options,
      headers: {
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      }
    });
  }

  return res;
}

// ================= PLAYER DEVICE =================
app.get("/api/device", requireAuth, async (req, res) => {
  const r = await spotifyFetch(
    req.session,
    "https://api.spotify.com/v1/me/player/devices"
  );

  const data = await r.json();
  res.json(data);
});

// ================= PLAY =================
app.put("/api/play", requireAuth, async (req, res) => {
  const { uri } = req.body;

  const devices = await spotifyFetch(
    req.session,
    "https://api.spotify.com/v1/me/player/devices"
  );

  const d = await devices.json();
  const deviceId = d.devices?.[0]?.id;

  if (!deviceId) {
    return res.status(400).json({ error: "No active device" });
  }

  await spotifyFetch(
    req.session,
    `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
    {
      method: "PUT",
      body: JSON.stringify({ uris: [uri] })
    }
  );

  res.json({ success: true });
});

// ================= OTHER CONTROLS =================
app.put("/api/pause", requireAuth, async (req, res) => {
  await spotifyFetch(req.session, "https://api.spotify.com/v1/me/player/pause", {
    method: "PUT"
  });
  res.json({ success: true });
});

app.post("/api/next", requireAuth, async (req, res) => {
  await spotifyFetch(req.session, "https://api.spotify.com/v1/me/player/next", {
    method: "POST"
  });
  res.json({ success: true });
});

// ================= DATA =================
app.get("/api/me", requireAuth, async (req, res) => {
  const r = await spotifyFetch(req.session, "https://api.spotify.com/v1/me");
  res.json(await r.json());
});

app.get("/api/top-tracks", requireAuth, async (req, res) => {
  const r = await spotifyFetch(
    req.session,
    "https://api.spotify.com/v1/me/top/tracks?limit=20"
  );
  res.json(await r.json());
});

app.get("/api/top-artists", requireAuth, async (req, res) => {
  const r = await spotifyFetch(
    req.session,
    "https://api.spotify.com/v1/me/top/artists?limit=20"
  );
  res.json(await r.json());
});

app.get("/api/current", requireAuth, async (req, res) => {
  const r = await spotifyFetch(
    req.session,
    "https://api.spotify.com/v1/me/player/currently-playing"
  );
  res.json(await r.json());
});

// ================= LOGOUT =================
app.get("/logout", (req, res) => {
  sessions.delete(req.cookies.session_id);
  res.clearCookie("session_id");
  res.redirect("/");
});

app.listen(PORT, () => console.log("RUNNING ON " + PORT));
