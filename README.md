# Melodia — Spotify Dashboard

**Melodia** è una web app personale che si connette al tuo account Spotify e ti offre una dashboard completa per esplorare i tuoi ascolti, visualizzare statistiche, ricevere raccomandazioni AI e controllare la riproduzione in tempo reale.

---

## 🌐 Demo live

L'app è hostata su **Render** ed è accessibile pubblicamente:

👉 **https://spotify-dashboard-rk15.onrender.com/**

> ⚠️ Trattandosi di un piano gratuito su Render, la prima apertura potrebbe richiedere 30-60 secondi mentre il server si avvia (cold start).

---

## ✨ Funzionalità

- **Panoramica** — statistiche generali: top tracks, artisti, playlist e minuti ascoltati
- **Top Tracks** — le tue tracce più ascoltate negli ultimi 4 settimane, 6 mesi o di sempre
- **Top Artists** — i tuoi artisti più ascoltati con generi e barra di popolarità
- **Recenti** — ultimi 50 brani ascoltati con timestamp relativo
- **Statistiche** — generi preferiti, decenni più ascoltati, riepilogo numerico e top 10 di sempre
- **AI Consigli** — raccomandazioni musicali personalizzate basate sui tuoi ascolti recenti
- **In Riproduzione** — controlli completi del player: play/pausa, avanti, indietro, volume, barra di avanzamento
- **Tema dark/light** — preferenza salvata in localStorage
- **Player bar persistente** — visibile in tutte le sezioni, si aggiorna ogni 5 secondi

---

## 🗂 Struttura del progetto
spotify-dashboard/
├── server.js           # Backend Express: autenticazione OAuth, proxy API Spotify, endpoint REST
├── package.json        # Dipendenze e script npm
├── .env                # Variabili d'ambiente (NON incluso nel repo)
└── public/
├── index.html      # Pagina di login
├── app.html        # Shell della dashboard (layout, sidebar, player bar)
├── app.js          # Tutta la logica frontend (navigazione, fetch, render, player)
└── style.css       # Stili completi con supporto tema dark/light via CSS variables

---

## ⚙️ Come funziona

### Autenticazione
L'app usa il flusso **OAuth 2.0 Authorization Code** di Spotify. Quando l'utente clicca "Accedi con Spotify", viene reindirizzato alla pagina di autorizzazione di Spotify. Dopo il consenso, Spotify rimanda al callback con un codice che il backend scambia con un `access_token` e un `refresh_token`. Entrambi vengono salvati nella sessione server-side. Il token viene rinnovato automaticamente prima della scadenza (ogni ~60 minuti).

### Architettura
Il backend **Node.js + Express** fa da proxy tra il browser e le API Spotify: il frontend non tocca mai direttamente le API Spotify né espone credenziali. Tutte le chiamate passano per gli endpoint `/api/*` del server, che aggiungono il Bearer token dalla sessione.

Il frontend è **vanilla JavaScript** puro (nessun framework), con gestione dello stato tramite un oggetto globale `S` e caching delle risposte API in memoria per evitare fetch ridondanti.

### Player
I controlli di riproduzione (play, pausa, avanti, indietro, volume) richiedono **Spotify Premium** — è una limitazione dell'API Spotify, non dell'app. Il player bar si aggiorna ogni 5 secondi tramite polling su `/api/current`.

---

## 🔌 API Endpoints

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| `GET` | `/api/status` | Verifica se l'utente è autenticato |
| `GET` | `/api/me` | Profilo utente Spotify |
| `GET` | `/api/top-tracks` | Top tracks (`time_range`, `limit`) |
| `GET` | `/api/top-artists` | Top artists (`time_range`, `limit`) |
| `GET` | `/api/recent` | Ultimi brani ascoltati |
| `GET` | `/api/playlists` | Lista playlist dell'utente |
| `GET` | `/api/playlists/:id/tracks` | Tracce di una playlist |
| `POST` | `/api/playlists` | Crea una nuova playlist |
| `POST` | `/api/playlists/:id/tracks` | Aggiunge brani a una playlist |
| `GET` | `/api/search` | Ricerca brani e artisti |
| `GET` | `/api/search-uri` | Trova URI Spotify di un brano |
| `GET` | `/api/artists/:id/top-tracks` | Top tracks di un artista |
| `GET` | `/api/current` | Brano attualmente in riproduzione |
| `GET` | `/api/devices` | Dispositivi Spotify attivi |
| `PUT` | `/api/play` | Avvia riproduzione |
| `PUT` | `/api/pause` | Mette in pausa |
| `POST` | `/api/next` | Traccia successiva |
| `POST` | `/api/prev` | Traccia precedente |
| `PUT` | `/api/volume` | Imposta volume |
| `POST` | `/api/ai/recommend` | Genera raccomandazioni AI |

---

## 🛠 Stack tecnico

- **Backend**: Node.js 18+, Express, express-session
- **Frontend**: HTML5, CSS3, JavaScript ES2022 (vanilla, no framework)
- **Auth**: Spotify OAuth 2.0 Authorization Code Flow
- **AI**: Google Gemini API (raccomandazioni musicali)
- **Hosting**: [Render](https://render.com) (Web Service, piano gratuito)

---

## 🔧 Variabili d'ambiente richieste

```env
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
REDIRECT_URI=https://tuo-dominio.onrender.com/callback
SESSION_SECRET=
GEMINI_API_KEY=        # opzionale, per le raccomandazioni AI
NODE_ENV=production
```

---

## 📌 Note

- **Questa repo è solo il codice sorgente** — non è necessario clonare o installare nulla per usare l'app. Basta aprire il link sopra.
- Se vuoi eseguirla in locale: `npm install` → crea il file `.env` → `npm run dev`
- L'app è registrata su Spotify Developer Dashboard con gli URI di redirect autorizzati. Per usarla con il tuo account devi essere aggiunto come utente di test nelle impostazioni dell'app Spotify (finché non viene pubblicata).
