import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.static("public"));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// sessioni in memoria (ok per ora)
const sessions = {};

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// ================= LOGIN =================
app.get("/login", (req, res) => {
  const scope = "user-read-email user-read-private user-top-read";

  const url =
    "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      scope,
      redirect_uri: REDIRECT_URI,
    });

  res.redirect(url);
});

// ================= CALLBACK =================
app.get("/callback", async (req, res) => {
  const code = req.query.code;

  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const data = await tokenRes.json();

    if (!data.access_token) {
      console.error(data);
      return res.send("Errore token Spotify");
    }

    const sessionId = crypto.randomUUID();

    sessions[sessionId] = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    console.log("LOGIN OK:", sessionId);

    res.redirect("/?session=" + sessionId);

  } catch (err) {
    console.error(err);
    res.send("Errore login");
  }
});

// ================= REFRESH TOKEN =================
async function refreshToken(sessionId) {
  const s = sessions[sessionId];

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: s.refresh_token,
    }),
  });

  const data = await res.json();

  if (data.access_token) {
    s.access_token = data.access_token;
    s.expires_at = Date.now() + data.expires_in * 1000;
  }
}

// ================= AUTH =================
async function auth(req, res, next) {
  const sessionId = req.headers["x-session-id"];

  if (!sessionId || !sessions[sessionId]) {
    return res.status(401).json({ error: "Non autorizzato" });
  }

  if (Date.now() > sessions[sessionId].expires_at) {
    await refreshToken(sessionId);
  }

  req.session = sessions[sessionId];
  next();
}

// ================= LOGOUT =================
app.post("/logout", (req, res) => {
  const sessionId = req.headers["x-session-id"];
  delete sessions[sessionId];
  res.json({ ok: true });
});

// ================= API =================
app.get("/api/me", auth, async (req, res) => {
  const r = await fetch("https://api.spotify.com/v1/me", {
    headers: {
      Authorization: "Bearer " + req.session.access_token,
    },
  });

  res.json(await r.json());
});

app.get("/api/top-tracks", auth, async (req, res) => {
  const r = await fetch("https://api.spotify.com/v1/me/top/tracks", {
    headers: {
      Authorization: "Bearer " + req.session.access_token,
    },
  });

  res.json(await r.json());
});

// ================= START =================
app.listen(PORT, () => {
  console.log("Server avviato su porta", PORT);
});
