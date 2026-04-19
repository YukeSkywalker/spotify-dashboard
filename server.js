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

function generateRandomString(length) {
  return crypto.randomBytes(length).toString("hex");
}

// Middleware auth
function requireAuth(req, res, next) {
  const sessionId = req.cookies.session_id;
  const session = sessions.get(sessionId);

  if (!session) return res.status(401).json({ error: "Not authenticated" });

  req.session = session;
  req.sessionId = sessionId;
  next();
}

// LOGIN
app.get("/login", (req, res) => {
  const state = generateRandomString(16);

  const scope = "user-read-email user-top-read";

  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.append("response_type", "code");
  url.searchParams.append("client_id", SPOTIFY_CLIENT_ID);
  url.searchParams.append("scope", scope);
  url.searchParams.append("redirect_uri", SPOTIFY_REDIRECT_URI);
  url.searchParams.append("state", state);

  res.redirect(url.toString());
});

// CALLBACK
app.get("/callback", async (req, res) => {
  const code = req.query.code;

  try {
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

    const sessionId = generateRandomString(24);

    sessions.set(sessionId, {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000
    });

    res.cookie("session_id", sessionId, {
      httpOnly: true,
      sameSite: "lax"
    });

    res.redirect("/");
  } catch (err) {
    res.status(500).send("Auth error");
  }
});

// REFRESH TOKEN
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

  session.access_token = data.access_token;
  session.expires_at = Date.now() + data.expires_in * 1000;
}

// FETCH SPOTIFY CON AUTO REFRESH
async function spotifyFetch(session, url) {
  if (Date.now() > session.expires_at) {
    await refreshToken(session);
  }

  const res = await fetch(url, {
    headers: {
      Authorization: "Bearer " + session.access_token
    }
  });

  if (res.status === 401) {
    await refreshToken(session);

    return fetch(url, {
      headers: {
        Authorization: "Bearer " + session.access_token
      }
    });
  }

  return res;
}

// API ME
app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const r = await spotifyFetch(
      req.session,
      "https://api.spotify.com/v1/me"
    );
    const data = await r.json();
    res.json(data);
  } catch {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// API TOP TRACKS
app.get("/api/top-tracks", requireAuth, async (req, res) => {
  try {
    const r = await spotifyFetch(
      req.session,
      "https://api.spotify.com/v1/me/top/tracks?limit=10"
    );
    const data = await r.json();
    res.json(data);
  } catch {
    res.status(500).json({ error: "Failed to fetch tracks" });
  }
});

// LOGOUT
app.get("/logout", (req, res) => {
  const sessionId = req.cookies.session_id;
  sessions.delete(sessionId);
  res.clearCookie("session_id");
  res.redirect("/");
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
