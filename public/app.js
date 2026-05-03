'use strict';

/* ── State ─────────────────────────────────────────── */
// Oggetto globale che mantiene tutto lo stato dell'applicazione durante la sessione.
// - theme:     tema attuale ('dark' o 'light'), persistito in localStorage
// - section:   sezione attualmente visibile nel menu
// - user:      dati dell'utente Spotify loggato
// - cache:     cache delle risposte API per evitare richieste duplicate
//              tt = top tracks per range, ta = top artists per range,
//              recent = brani recenti
// - player:    stato del player (URI in riproduzione, se sta suonando, timer di polling)
// - stimer:    timer per il debounce della ricerca (mantenuto nello stato per compatibilità)
// - srFilter:  filtro attivo nella sezione ricerca ('all', 'track', 'artist')
// - ai:        dati e cache delle raccomandazioni AI
const S = {
  theme:   localStorage.getItem('mel-theme') || 'dark',
  section: 'overview',
  user:    null,
  cache:   { tt:{}, ta:{}, recent:null },
  player:  { uri:null, playing:false, poll:null },
  stimer:  null,
  srFilter: 'all',
  ai:      { data:null, trackCache:{} }
};

// Shorthand per getElementById — riduce verbosità nel codice
const $  = id  => document.getElementById(id);
// Shorthand per querySelectorAll — seleziona tutti gli elementi che corrispondono al selettore CSS
const $$ = sel => document.querySelectorAll(sel);

/* ── Formatters ─────────────────────────────────────── */
// Converte millisecondi in stringa MM:SS (es. 213000 → "3:33")
const fmtMs  = ms => { const m=Math.floor(ms/60000),s=Math.floor((ms%60000)/1000); return `${m}:${s.toString().padStart(2,'0')}`; };

// Converte una data ISO in stringa relativa leggibile (es. "5m fa", "2h fa", "1g fa")
const fmtAgo = iso => { const d=Date.now()-new Date(iso),m=Math.floor(d/60000); if(m<1)return'Adesso'; if(m<60)return`${m}m fa`; const h=Math.floor(m/60); if(h<24)return`${h}h fa`; return`${Math.floor(h/24)}g fa`; };

// Formatta numeri grandi con suffissi K/M (es. 1500 → "1.5K", 2000000 → "2.0M")
// Restituisce '—' per valori null/undefined/NaN
const fmtK   = n   => { if(n==null||n===undefined||isNaN(+n))return'—'; n=+n; if(n>=1e6)return(n/1e6).toFixed(1)+'M'; if(n>=1e3)return(n/1e3).toFixed(1)+'K'; return String(n); };

// Sanifica stringhe per l'inserimento sicuro in HTML, prevenendo XSS
// Sostituisce i caratteri speciali HTML con le rispettive entità HTML
const esc    = s   => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');

/* ── Toast ──────────────────────────────────────────── */
// Mostra una notifica temporanea (toast) in basso nello schermo.
// - msg:  testo del messaggio da mostrare
// - type: classe CSS per il colore ('ok' = verde, 'err' = rosso, 'warn' = giallo, 'ai' = viola)
// - ms:   durata in millisecondi prima che il toast scompaia (default: 3500ms)
// Cancella automaticamente il timer precedente per evitare sovrapposizioni.
function toast(msg, type='ok', ms=3500) {
  const el=$('toast');
  el.textContent=msg; el.className=`toast show ${type}`;
  clearTimeout(el._t); el._t=setTimeout(()=>el.className='toast',ms);
}

/* ── API ────────────────────────────────────────────── */
// Wrapper generico per tutte le chiamate fetch verso il backend Express.
// - path: percorso relativo dell'endpoint (es. '/api/me')
// - opts: opzioni fetch opzionali (method, body, ecc.)
// Gestisce automaticamente:
//   - aggiunta dell'header Content-Type JSON
//   - errore 401 (sessione scaduta): mostra toast e reindirizza al login dopo 2.8s
//   - risposta 204 (no content): restituisce null
//   - errori HTTP generici: lancia eccezione con il messaggio di errore del server
async function api(path, opts={}) {
  try {
    const res = await fetch(path, { ...opts, headers:{'Content-Type':'application/json',...(opts.headers||{})} });
    if (res.status===401) { toast('Sessione scaduta — fai di nuovo login','err',5000); setTimeout(()=>location.href='/',2800); throw new Error('UNAUTH'); }
    if (res.status===204) return null;
    const d = await res.json();
    if (!res.ok) throw new Error(d.error||`HTTP ${res.status}`);
    return d;
  } catch(e) {
    if(e.message!=='UNAUTH') console.warn('API',path,e.message);
    throw e;
  }
}

/* ── Theme ──────────────────────────────────────────── */
// Applica il tema scelto (dark/light) all'intera applicazione.
// - Aggiorna l'attributo data-theme sul tag <html> (usato dal CSS per le variabili)
// - Salva la preferenza in localStorage per ricordarla tra le sessioni
// - Aggiorna l'icona del pulsante tema nella sidebar e nell'header mobile
function applyTheme(t) {
  S.theme=t;
  document.documentElement.setAttribute('data-theme',t);
  localStorage.setItem('mel-theme',t);
  const ic=t==='dark'?'☀':'☾';
  [$('themeBtn'),$('mobTheme')].forEach(el=>{if(el)el.textContent=ic;});
}

/* ── Navigation ─────────────────────────────────────── */
// Gestisce la navigazione tra le sezioni dell'applicazione.
// - Aggiorna S.section con la sezione target
// - Rimuove la classe 'active' da tutte le view e i nav-item
// - Aggiunge 'active' alla view e al nav-item corrispondenti
// - Chiude la sidebar mobile
// - Esegue la funzione di caricamento dati associata alla sezione
//   (ogni sezione ha la propria funzione di fetch/render)
function nav(s) {
  S.section=s;
  $$('.view').forEach(v=>v.classList.remove('active'));
  $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.s===s));
  const v=$(`view-${s}`); if(v)v.classList.add('active');
  closeSidebar();
  ({
    overview:     loadOverview,
    'top-tracks': ()=>loadTT('short_term'),
    'top-artists':()=>loadTA('short_term'),
    recent:       loadRecent,
    stats:        loadStats,
    ai:           initAiSection,
    player:       loadPlayerPage
  })[s]?.();
}

// Apre la sidebar mobile aggiungendo la classe 'open' alla sidebar e all'overlay
function openSidebar()  { $('sidebar').classList.add('open'); $('overlay').classList.add('open'); }

// Chiude la sidebar mobile rimuovendo la classe 'open' dalla sidebar e dall'overlay
function closeSidebar() { $('sidebar').classList.remove('open'); $('overlay').classList.remove('open'); }

/* ══════════════════════════════════════════════════════
   USER
══════════════════════════════════════════════════════ */
// Recupera i dati del profilo utente dall'API Spotify tramite il backend.
// Salva l'utente in S.user e chiama renderUser per aggiornare la UI.
// In caso di errore non-auth mostra un messaggio nella sidebar e un toast di errore.
// Restituisce l'oggetto utente o null in caso di fallimento.
async function loadUser() {
  try {
    const u = await api('/api/me');
    S.user=u; renderUser(u); return u;
  } catch(e) {
    if(e.message==='UNAUTH') return null;
    $('sbName').textContent='Errore profilo';
    toast('Impossibile caricare il profilo','err',6000);
    return null;
  }
}

// Aggiorna tutti gli elementi UI con i dati del profilo utente:
// - Sidebar: nome, piano (Premium/Free), avatar (immagine o iniziale come placeholder)
// - Overview: nome di benvenuto (solo il primo nome)
// Gestisce il caso in cui l'avatar non sia disponibile o l'immagine non si carichi.
function renderUser(u) {
  $('sbName').textContent = u.display_name||u.id||'Utente';
  $('sbPlan').textContent = u.product==='premium'?'✦ Premium':'Free';
  $('ovName').textContent = (u.display_name||u.id||'Ciao').split(' ')[0];
  const img = u.images?.[0]?.url||u.images?.[1]?.url;
  const av=$('sbAvatar'), ph=$('sbAvatarPh');
  if(img){ av.src=img; av.style.display='block'; ph.style.display='none'; av.onerror=()=>{ av.style.display='none'; ph.style.display='flex'; ph.textContent=(u.display_name||'?')[0].toUpperCase(); }; }
  else   { av.style.display='none'; ph.style.display='flex'; ph.textContent=(u.display_name||u.id||'?')[0].toUpperCase(); }
}

/* ══════════════════════════════════════════════════════
   OVERVIEW
══════════════════════════════════════════════════════ */
// Carica in parallelo tutti i dati necessari per la schermata panoramica:
// top tracks (medium term), brani recenti, playlist (solo per il conteggio), top artists.
// Usa Promise.allSettled per non bloccare il render se una delle API fallisce.
// Aggiorna i contatori statistici (stTracks, stArtists, stPlaylists, stMinutes)
// e renderizza le mini-liste di tracce e la card dell'artista #1.
async function loadOverview() {
  const [tR,rR,pR,aR] = await Promise.allSettled([
    api('/api/top-tracks?time_range=medium_term&limit=50'),
    api('/api/recent'),
    api('/api/playlists'),
    api('/api/top-artists?time_range=medium_term&limit=5')
  ]);
  const ok = r => r.status==='fulfilled' && r.value;
  if(ok(tR)){ $('stTracks').textContent=tR.value.items?.length||'—'; renderMiniTracks($('ovTracks'),tR.value.items.slice(0,5)); }
  if(ok(aR)){ $('stArtists').textContent=aR.value.items?.length||'—'; renderOvArtist(aR.value.items[0]); }
  if(ok(pR)){ $('stPlaylists').textContent=pR.value.total||pR.value.items?.length||'—'; }
  if(ok(rR)){ const items=rR.value.items||[]; $('stMinutes').textContent=Math.round(items.reduce((a,i)=>a+(i.track?.duration_ms||0),0)/60000); renderMiniTracks($('ovRecent'),items.slice(0,5).map(i=>i.track)); }
}

// Renderizza la card dell'artista più ascoltato nella panoramica.
// Mostra immagine, etichetta "Artista #1", nome, generi (max 3) e numero di follower formattato.
// Non fa nulla se il container o l'artista non esistono.
function renderOvArtist(a) {
  const el=$('ovArtistCard'); if(!el||!a)return;
  const fol = a.followers?.total != null ? fmtK(a.followers.total) + ' followers' : '';
  el.innerHTML=`<div class="ov-ac">
    <img src="${esc(a.images?.[0]?.url||'')}" alt="" onerror="this.style.display='none'"/>
    <div>
      <div class="ov-ac-lbl">Artista #1</div>
      <div class="ov-ac-name">${esc(a.name)}</div>
      <div class="ov-ac-gen">${(a.genres||[]).slice(0,3).join(' · ')||'—'}</div>
      ${fol ? `<div class="ov-ac-fol">${fol}</div>` : ''}
    </div>
  </div>`;
}

// Renderizza una lista compatta di tracce in un elemento contenitore.
// Usata nella panoramica per "Top 5 Tracks" e "Ascoltati di recente".
// Mostra un messaggio "Nessun dato" se l'array è vuoto o non valido.
function renderMiniTracks(el, tracks) {
  if(!el)return;
  if(!tracks?.length){el.innerHTML='<div class="empty">Nessun dato</div>';return;}
  el.innerHTML=tracks.filter(Boolean).map((t,i)=>trackRow(t,i,{mini:true})).join('');
}

/* ── Track row (generico, usato ovunque) ─ */
// Genera l'HTML per una singola riga/card di traccia musicale.
// Parametri:
// - t:    oggetto traccia Spotify (name, uri, artists, album, duration_ms, ecc.)
// - i:    indice nella lista (mostrato come numero o "▶" se in riproduzione)
// - ago:  (opzionale) stringa "X min fa" per la sezione recenti, altrimenti mostra la durata
// - mini: (opzionale) se true, nasconde i metadati aggiuntivi (album, durata/tempo)
// Al click avvia la riproduzione tramite playTrack().
// Evidenzia la riga se corrisponde alla traccia attualmente in riproduzione (S.player.uri).
function trackRow(t, i, {ago=null, mini=false}={}) {
  if(!t)return'';
  const art=t.album?.images?.[0]?.url||'';
  const artists=t.artists?.map(a=>a.name).join(', ')||'';
  const isPlaying=S.player.uri===t.uri;
  return `
    <div class="track-item${isPlaying?' playing':''}" onclick="playTrack('${esc(t.uri)}','${esc(t.name)}','${esc(t.artists?.[0]?.name||'')}','${esc(art)}')">
      <span class="t-num">${isPlaying?'▶':i+1}</span>
      <div class="t-art-wrap">
        <img class="t-art" src="${esc(art)}" alt="" loading="lazy" onerror="this.style.display='none'"/>
        <div class="t-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
      </div>
      <div class="t-det">
        <div class="t-name">${esc(t.name)}</div>
        <div class="t-art2">${esc(artists)}</div>
      </div>
      ${!mini?`<div class="t-meta">
        <span class="t-alb">${esc(t.album?.name||'')}</span>
        ${ago?`<span class="t-when">${esc(ago)}</span>`:`<span class="t-dur">${fmtMs(t.duration_ms||0)}</span>`}
      </div>`:''}`
    +`</div>`;
}

/* ══════════════════════════════════════════════════════
   TOP TRACKS
══════════════════════════════════════════════════════ */
// Carica le top tracks per il range temporale specificato ('short_term', 'medium_term', 'long_term').
// Prima controlla la cache (S.cache.tt[range]) per evitare chiamate API ridondanti.
// Mostra skeleton loader durante il fetch, poi renderizza i risultati o un messaggio di errore.
async function loadTT(range) {
  if(S.cache.tt[range]){renderTT(S.cache.tt[range]);return;}
  $('ttList').innerHTML=skelRows(15);
  try{ const d=await api(`/api/top-tracks?time_range=${range}&limit=50`); S.cache.tt[range]=d.items; renderTT(d.items); }
  catch{ $('ttList').innerHTML=emptyMsg('Impossibile caricare le top tracks'); }
}

// Renderizza la lista delle top tracks nell'elemento #ttList.
// Usa trackRow() per ogni traccia. Mostra messaggio se non ci sono dati.
function renderTT(tracks){
  if(!tracks?.length){$('ttList').innerHTML=emptyMsg('Nessun dato — ascolta più musica!');return;}
  $('ttList').innerHTML=tracks.map((t,i)=>trackRow(t,i)).join('');
}

/* ══════════════════════════════════════════════════════
   TOP ARTISTS
══════════════════════════════════════════════════════ */
// Carica i top artist per il range temporale specificato ('short_term', 'medium_term', 'long_term').
// Prima controlla la cache (S.cache.ta[range]) per evitare chiamate API ridondanti.
// Mostra skeleton loader durante il fetch, poi renderizza i risultati o un messaggio di errore.
async function loadTA(range) {
  if(S.cache.ta[range]){renderTA(S.cache.ta[range]);return;}
  $('taList').innerHTML=skelArtists(12);
  try{ const d=await api(`/api/top-artists?time_range=${range}&limit=50`); S.cache.ta[range]=d.items; renderTA(d.items); }
  catch{ $('taList').innerHTML=emptyMsg('Impossibile caricare gli artisti'); }
}

// Renderizza la griglia degli artisti nell'elemento #taList.
// Ogni card mostra: rank (#1, #2…), immagine, nome, generi (max 2),
// e una barra di popolarità con il valore numerico (0-100).
function renderTA(artists){
  if(!artists?.length){$('taList').innerHTML=emptyMsg('Nessun dato');return;}
  $('taList').innerHTML=artists.map((a,i)=>`
    <div class="artist-card">
      <div class="ac-rank">#${i+1}</div>
      <img class="ac-img" src="${esc(a.images?.[0]?.url||'')}" alt="${esc(a.name)}" loading="lazy" onerror="this.style.opacity='0'"/>
      <div class="ac-name">${esc(a.name)}</div>
      <div class="ac-gen">${(a.genres||[]).slice(0,2).join(', ')||'—'}</div>
      ${a.popularity ? `<div class="ac-pop"><div class="ac-bar"><div class="ac-fill" style="width:${a.popularity}%"></div></div><span class="ac-plbl">${a.popularity}</span></div>` : ''}
    </div>`).join('');
}

/* ══════════════════════════════════════════════════════
   RECENT
══════════════════════════════════════════════════════ */
// Carica i brani ascoltati di recente dall'API.
// Prima controlla la cache (S.cache.recent) per evitare chiamate ridondanti.
// Mostra skeleton loader durante il fetch, poi renderizza i risultati o un errore.
async function loadRecent() {
  if(S.cache.recent){renderRecent(S.cache.recent);return;}
  $('recentList').innerHTML=skelRows(15);
  try{ const d=await api('/api/recent'); S.cache.recent=d.items; renderRecent(d.items); }
  catch{ $('recentList').innerHTML=emptyMsg('Impossibile caricare i recenti'); }
}

// Renderizza la lista dei brani recenti nell'elemento #recentList.
// Per ogni item passa il timestamp 'played_at' a fmtAgo() per mostrare "X min fa".
// Salta gli item senza traccia (track null/undefined).
function renderRecent(items){
  if(!items?.length){$('recentList').innerHTML=emptyMsg('Nessun brano recente');return;}
  $('recentList').innerHTML=items.map((item,i)=>{ if(!item.track)return''; return trackRow(item.track,i,{ago:fmtAgo(item.played_at)}); }).join('');
}

/* ══════════════════════════════════════════════════════
   STATS
══════════════════════════════════════════════════════ */
// Carica e renderizza la sezione statistiche avanzate.
// Esegue tre chiamate API in parallelo: top tracks (long term), top artists (long term), brani recenti.
// Calcola e mostra:
//   1. Generi preferiti: aggrega tutti i generi di tutti gli artisti e li ordina per frequenza
//      (con barre proporzionali al genere più frequente per evitare divisione per 0)
//   2. Decenni più ascoltati: raggruppa le top tracks per decennio dalla release date
//   3. Riepilogo numerico: minuti ascoltati (dai recenti), numero top tracks, artisti unici, popolarità media
//   4. Top 10 di sempre: le prime 10 tracce long-term renderizzate con trackRow()
async function loadStats() {
  const c = $('statsContent');
  if (!c) return;
  c.innerHTML = '<div class="spinner"></div>';

  try {
    const [tL, aL, rR] = await Promise.all([
      api('/api/top-tracks?time_range=long_term&limit=50'),
      api('/api/top-artists?time_range=long_term&limit=50'),
      api('/api/recent')
    ]);

    /* ── Generi: conta tutti i generi da tutti gli artisti ── */
    const genreMap = {};
    (aL.items || []).forEach(a => {
      (a.genres || []).forEach(g => {
        if (g) genreMap[g] = (genreMap[g] || 0) + 1;
      });
    });
    const genres = Object.entries(genreMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const maxGenre = genres.length ? genres[0][1] : 1;  /* evita divisione per 0 */

    /* ── Decenni ── */
    const dec = {};
    (tL.items || []).forEach(t => {
      const y = t.album?.release_date?.slice(0, 4);
      if (y) { const d = Math.floor(+y / 10) * 10; dec[d] = (dec[d] || 0) + 1; }
    });

    /* ── Riepilogo ── */
    const recMin  = Math.round((rR.items || []).reduce((a, i) => a + (i.track?.duration_ms || 0), 0) / 60000);
    const popAvg  = tL.items?.length ? Math.round(tL.items.reduce((a, t) => a + (t.popularity || 0), 0) / tL.items.length) : 0;
    const uniqArt = new Set((tL.items || []).flatMap(t => (t.artists || []).map(a => a.id))).size;

    c.innerHTML = `
      <!-- Generi preferiti -->
      <div class="stats-section">
        <div class="stats-h">🎸 Generi preferiti</div>
        ${genres.length
          ? `<div class="genre-rows">
              ${genres.map(([g, n]) => `
                <div class="g-row">
                  <span class="g-lbl">${esc(g)}</span>
                  <div class="g-track"><div class="g-fill" style="width:${Math.round(n / maxGenre * 100)}%"></div></div>
                  <span class="g-cnt">${n}</span>
                </div>`).join('')}
             </div>`
          : `<p style="color:var(--t3);font-size:.88rem">Dati non disponibili — ascolta più musica con artisti che hanno generi su Spotify.</p>`
        }
      </div>

      <!-- Decenni -->
      <div class="stats-section">
        <div class="stats-h">📅 Decenni più ascoltati</div>
        <div class="decade-grid">
          ${Object.entries(dec).sort((a, b) => b[1] - a[1]).map(([d, n]) => `
            <div class="dec-card">
              <div class="dec-y">${d}s</div>
              <div class="dec-n">${n} brani</div>
            </div>`).join('')}
        </div>
      </div>

      <!-- Riepilogo -->
      <div class="stats-section">
        <div class="stats-h">📊 Riepilogo</div>
        <div class="sum-grid">
          <div class="sum-card"><div class="sum-val">${recMin}</div><div class="sum-lbl">Min. ascoltati (recenti)</div></div>
          <div class="sum-card"><div class="sum-val">${tL.items?.length || 0}</div><div class="sum-lbl">Top tracks nel tempo</div></div>
          <div class="sum-card"><div class="sum-val">${uniqArt}</div><div class="sum-lbl">Artisti unici</div></div>
          <div class="sum-card"><div class="sum-val">${popAvg}</div><div class="sum-lbl">Popolarità media</div></div>
        </div>
      </div>

      <!-- Top 10 -->
      <div class="stats-section">
        <div class="stats-h">🏆 Top 10 di sempre</div>
        <div class="track-list">${(tL.items || []).slice(0, 10).map((t, i) => trackRow(t, i)).join('')}</div>
      </div>`;

  } catch(e) {
    console.error('loadStats:', e);
    c.innerHTML = emptyMsg('Impossibile caricare le statistiche');
  }
}

/* ══════════════════════════════════════════════════════
   AI — GEMINI SECTION
══════════════════════════════════════════════════════ */
// Inizializza la sezione AI Consigli.
// Se esistono già dati in cache (S.ai.data) li renderizza immediatamente senza nuova fetch.
// Altrimenti mostra la schermata introduttiva con le istruzioni per generare consigli.
function initAiSection() {
  if (S.ai.data) { renderAiResults(S.ai.data); return; }
  const out = $('aiOut');
  out.innerHTML = `
    <div class="ai-intro">
      <div class="ai-intro-icon">🤖</div>
      <h3>Raccomandazioni Personalizzate</h3>
      <p>Gemini analizzerà i tuoi ascolti e ti suggerirà artisti e brani nuovi basandosi sui tuoi gusti musicali.</p>
      <p class="ai-note">Puoi anche creare una playlist Spotify con i brani consigliati in un click.</p>
    </div>`;
}

// Genera raccomandazioni musicali basandosi sulle top 3 tracce recenti dell'utente.
// Algoritmo:
//   1. Recupera le top 10 tracce a breve termine
//   2. Per ognuna delle prime 3, cerca su Spotify brani simili (stesso nome+artista → tracce correlate)
//   3. Filtra i duplicati mantenendo un Set di ID già visti
//   4. Prende le prime 10 tracce uniche e le mostra come "Consigliati per te"
// Gestisce lo stato del bottone (disabilitato durante la generazione) e mostra toast di esito.
async function generateAiRecommendations() {
  const btn = $('aiGenBtn');
  const out = $('aiOut');

  btn.disabled = true;
  btn.textContent = '✨ Generazione…';

  out.innerHTML = `
    <div class="spinner"></div>
    <p style="text-align:center;color:var(--t3);font-size:.85rem;margin-top:.5rem">
      Analisi dei tuoi gusti in corso…
    </p>`;

  try {
    const tt = await api('/api/top-tracks?time_range=short_term&limit=10');
    const top3 = (tt.items || []).slice(0, 3);
    const seeds = top3.map(t => ({ name: t.name, artist: t.artists?.[0]?.name }));

    let suggestions = [];
    for (const s of seeds) {
      try {
        const d = await api(`/api/search?q=${encodeURIComponent(s.name + ' ' + s.artist)}&limit=5`);
        suggestions.push(...(d?.tracks?.items || []).filter(f => f.name !== s.name));
      } catch (_) {}
    }

    // Deduplicazione per ID: mantiene solo tracce con ID univoco
    const unique = [];
    const ids = new Set();
    suggestions.forEach(t => { if (t.id && !ids.has(t.id)) { ids.add(t.id); unique.push(t); } });
    const finalTracks = unique.slice(0, 10);

    if (!finalTracks.length) { out.innerHTML = emptyMsg('Nessun suggerimento trovato'); return; }

    out.innerHTML = `
      <div class="ai-result">
        <div class="ai-section">
          <div class="ai-section-title">🎵 Consigliati per te</div>
          <div class="track-list">${finalTracks.map((t, i) => trackRow(t, i)).join('')}</div>
        </div>
      </div>`;

    toast('✨ Suggerimenti generati!', 'ai');
  } catch (e) {
    console.error(e);
    out.innerHTML = emptyMsg('Errore generazione AI');
    toast('Errore AI', 'err');
  } finally {
    // Ripristina sempre il bottone, anche in caso di errore
    btn.disabled = false;
    btn.textContent = '✨ Genera Consigli';
  }
}

// Renderizza i risultati AI quando i dati sono già disponibili in S.ai.data.
// Mostra: header con mood/summary/nome playlist suggerito,
// griglia artisti consigliati (con bottone "Cerca su Spotify"),
// lista brani consigliati (con play e search), bottone "Crea Playlist su Spotify".
// Dopo il render avvia loadAiTrackData() per cercare gli URI Spotify reali in background.
function renderAiResults(data) {
  const out = $('aiOut');
  const tracks  = (data.recommendations||[]).filter(r=>r.type==='track');
  const artists = (data.recommendations||[]).filter(r=>r.type==='artist');

  out.innerHTML=`
    <div class="ai-result">
      <div class="ai-header-card">
        <div class="ai-header-top">
          <div class="ai-mood-pill">🎵 ${esc(data.mood||'Il tuo vibe')}</div>
          <button class="ai-regen-btn" onclick="S.ai.data=null;generateAiRecommendations()">↺ Rigenera</button>
        </div>
        <p class="ai-summary">${esc(data.summary||'')}</p>
        ${data.playlist_name?`<div class="ai-pl-suggestion">💿 Playlist suggerita: <strong>"${esc(data.playlist_name)}"</strong></div>`:''}
      </div>

      ${artists.length?`
      <div class="ai-section">
        <div class="ai-section-title">👤 Artisti consigliati</div>
        <div class="ai-artist-grid">
          ${artists.map(a=>`
            <div class="ai-artist-card">
              <div class="ai-artist-initial">${esc(a.name[0]||'?')}</div>
              <div class="ai-artist-name">${esc(a.name)}</div>
              <div class="ai-artist-reason">${esc(a.reason)}</div>
              <button class="ai-search-spotify" onclick="searchAndNav('${esc(a.name)}')">
                <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
                Cerca su Spotify
              </button>
            </div>`).join('')}
        </div>
      </div>`:''}

      ${tracks.length?`
      <div class="ai-section">
        <div class="ai-section-title">🎵 Brani consigliati</div>
        <div class="ai-tracks-list" id="aiTracksList">
          ${tracks.map((t,i)=>`
            <div class="ai-track-item" id="ait-${i}">
              <div class="ai-track-num">${i+1}</div>
              <div class="ai-track-art" id="ait-art-${i}"><span class="ai-track-art-ph">♫</span></div>
              <div class="ai-track-det">
                <div class="ai-track-name">${esc(t.name)}</div>
                <div class="ai-track-artist">${esc(t.artist||'')}</div>
                <div class="ai-track-reason">${esc(t.reason)}</div>
              </div>
              <div class="ai-track-actions">
                <button class="ai-play-btn" id="ait-play-${i}" onclick="aiPlayTrack(${i},'${esc(t.name)}','${esc(t.artist||'')}')">
                  <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </button>
                <button class="ai-search-btn-sm" onclick="searchAndNav('${esc(t.name+' '+t.artist)}')">
                  <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
                </button>
              </div>
            </div>`).join('')}
        </div>
        <div class="ai-create-pl-wrap">
          <button class="ai-create-pl-btn" id="aiCreatePlBtn" onclick="createAiPlaylist()">
            <svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>
            Crea Playlist su Spotify
          </button>
          <p class="ai-create-pl-note">Creerà una playlist con i brani sopra nel tuo account Spotify</p>
        </div>
      </div>`:''}
    </div>`;

  if (tracks.length) loadAiTrackData(tracks);
}

// Cerca in background gli URI Spotify reali per i brani consigliati dall'AI.
// Per ogni traccia chiama /api/search-uri con nome+artista.
// Se trovata: salva in S.ai.trackCache[i] e aggiorna l'immagine dell'album nel DOM.
// Gli errori vengono ignorati silenziosamente (traccia rimane senza URI/immagine).
async function loadAiTrackData(tracks) {
  for(let i=0; i<tracks.length; i++){
    const t=tracks[i];
    try{
      const d=await api(`/api/search-uri?track=${encodeURIComponent(t.name)}&artist=${encodeURIComponent(t.artist||'')}`);
      if(d&&d.found){
        S.ai.trackCache[i]={uri:d.uri,name:d.name,artist:d.artist,art:d.album_art};
        const artEl=$(`ait-art-${i}`);
        if(artEl&&d.album_art) artEl.innerHTML=`<img src="${esc(d.album_art)}" alt="" onerror="this.innerHTML='♫'"/>`;
      }
    } catch(_){}
  }
}

// Avvia la riproduzione di un brano consigliato dall'AI.
// Prima verifica se l'URI è già in cache (S.ai.trackCache[idx]).
// Se non in cache, chiama /api/search-uri per trovarlo su Spotify.
// Mostra un toast di avviso se il brano non viene trovato.
async function aiPlayTrack(idx, name, artist) {
  const cached=S.ai.trackCache[idx];
  if(cached?.uri){ await playTrack(cached.uri,cached.name||name,cached.artist||artist,cached.art||''); }
  else{
    try{
      const d=await api(`/api/search-uri?track=${encodeURIComponent(name)}&artist=${encodeURIComponent(artist)}`);
      if(d&&d.found){ S.ai.trackCache[idx]={uri:d.uri,name:d.name,artist:d.artist,art:d.album_art}; await playTrack(d.uri,d.name,d.artist,d.album_art||''); }
      else toast('Brano non trovato su Spotify','warn');
    } catch(e){ toast('Impossibile trovare il brano','warn'); }
  }
}

// Crea una playlist Spotify con i brani consigliati dall'AI.
// Processo:
//   1. Raccoglie gli URI dai brani già in cache, cerca quelli mancanti con /api/search-uri
//   2. Crea la playlist su Spotify tramite POST /api/playlists
//   3. Aggiunge i brani trovati alla playlist tramite POST /api/playlists/:id/tracks
//   4. Invalida la cache delle playlist (S.cache.playlists=null) per forzare un refresh
//   5. Mostra il numero di brani aggiunti nel toast di conferma
// Gestisce lo stato del bottone durante l'operazione e ripristina in caso di errore.
async function createAiPlaylist() {
  if(!S.ai.data)return;
  const btn=$('aiCreatePlBtn'); if(!btn)return;
  btn.disabled=true; btn.textContent='⏳ Creazione…';
  try{
    const tracks=(S.ai.data.recommendations||[]).filter(r=>r.type==='track');
    const plName=S.ai.data.playlist_name||'AI Consigli Melodia';
    const uris=[];
    for(let i=0;i<tracks.length;i++){
      const cached=S.ai.trackCache[i];
      if(cached?.uri){uris.push(cached.uri);continue;}
      try{ const d=await api(`/api/search-uri?track=${encodeURIComponent(tracks[i].name)}&artist=${encodeURIComponent(tracks[i].artist||'')}`); if(d?.found){uris.push(d.uri);S.ai.trackCache[i]={uri:d.uri,name:d.name,artist:d.artist,art:d.album_art};} }catch(_){}
    }
    if(!uris.length){toast('Nessun brano trovato su Spotify','warn');return;}
    const pl=await api('/api/playlists',{method:'POST',body:JSON.stringify({name:plName,description:'Creata da Melodia AI con Gemini'})});
    await api(`/api/playlists/${pl.id}/tracks`,{method:'POST',body:JSON.stringify({uris})});
    S.cache.playlists=null; // Invalida la cache delle playlist
    toast(`✅ Playlist "${plName}" creata con ${uris.length} brani!`,'ok',5000);
    btn.textContent='✅ Playlist creata!'; btn.style.background='var(--g)';
    setTimeout(()=>{btn.disabled=false;btn.textContent='Crea Playlist su Spotify';btn.style.background='';},4000);
  } catch(e){ toast('Errore creazione playlist: '+e.message,'err'); btn.disabled=false; btn.textContent='Crea Playlist su Spotify'; }
}

// Naviga alla sezione ricerca e precompila il campo di testo con la query fornita.
// Usato dalla sezione AI per cercare artisti/brani su Spotify direttamente.
// Il timeout di 150ms garantisce che la sezione sia visibile prima di impostare il valore.
function searchAndNav(q) {
  nav('search');
  setTimeout(() => {
    const inp = $('searchInput');
    if (!inp) return;
    inp.value = q;
    inp.dispatchEvent(new Event('input'));
  }, 150);
}

/* ══════════════════════════════════════════════════════
   PLAYER PAGE
══════════════════════════════════════════════════════ */
// Carica e renderizza la pagina "In Riproduzione" con il brano attualmente attivo su Spotify.
// Mostra: copertina album, titolo, artisti, album+anno, barra progresso con tempi,
// stato (in riproduzione/pausa) e dispositivo attivo, controlli play/pause/prev/next,
// info dispositivo e volume.
// Se nessun brano è in riproduzione mostra un messaggio placeholder con istruzioni.
async function loadPlayerPage(){
  const c=$('playerPageContent'); if(!c)return;
  c.innerHTML='<div class="spinner"></div>';
  try{
    const d=await api('/api/current');
    if(!d?.item){ c.innerHTML=`<div class="np-empty"><div class="np-empty-ico">♫</div><p>Nessun brano in riproduzione</p><p class="np-hint">Apri Spotify su un dispositivo e avvia un brano</p></div>`; return; }
    const t=d.item, prog=d.progress_ms||0, dur=t.duration_ms||1;
    c.innerHTML=`<div class="np-card">
      <img class="np-cover" src="${esc(t.album.images[0]?.url||'')}" alt="${esc(t.name)}" onerror="this.style.display='none'"/>
      <div class="np-det">
        <div class="np-track">${esc(t.name)}</div>
        <div class="np-artist">${esc(t.artists.map(a=>a.name).join(', '))}</div>
        <div class="np-album">${esc(t.album.name)} · ${t.album.release_date?.slice(0,4)||''}</div>
        <div class="np-bar-wrap">
          <span class="np-t">${fmtMs(prog)}</span>
          <div class="np-bar"><div class="np-bar-fill" style="width:${Math.round(prog/dur*100)}%"></div></div>
          <span class="np-t">${fmtMs(dur)}</span>
        </div>
        <div class="np-status">${d.is_playing?'▶ In riproduzione':'⏸ In pausa'} · ${d.device?.name||'—'}</div>
        <div class="np-ctrls">
          <button class="np-btn" onclick="playerPrev()">⏮</button>
          <button class="np-btn np-btn-main" onclick="togglePlay()">${d.is_playing?'⏸':'▶'}</button>
          <button class="np-btn" onclick="playerNext()">⏭</button>
        </div>
        <div class="np-dev">Dispositivo: ${esc(d.device?.name||'Sconosciuto')} · Vol: ${d.device?.volume_percent??'—'}%</div>
      </div>
    </div>`;
  } catch{ c.innerHTML=emptyMsg('Impossibile caricare il player'); }
}

/* ══════════════════════════════════════════════════════
   PLAYER CONTROLS
══════════════════════════════════════════════════════ */
// Avvia la riproduzione di una traccia specifica tramite il suo URI Spotify.
// - Chiama PUT /api/play con l'array di URI
// - Aggiorna lo stato locale S.player e la player bar (updatePB)
// - Mostra un toast con il nome del brano
// - Avvia il polling periodico dello stato del player (startPoll)
// Gestisce i casi di errore: utente non premium (403), nessun dispositivo attivo.
async function playTrack(uri, name, artist, art) {
  if(!uri)return;
  try{
    await api('/api/play',{method:'PUT',body:JSON.stringify({uris:[uri]})});
    S.player.uri=uri; S.player.playing=true;
    updatePB(name,artist,art,true);
    toast(`▶  ${name}`,'ok');
    startPoll();
  } catch(e){
    if(e.message==='UNAUTH')return;
    if(e.message?.includes('premium')||e.message?.includes('403')) return toast('Spotify Premium richiesto per la riproduzione','warn',5000);
    toast('Apri Spotify su un dispositivo attivo','warn',5000);
    updatePB(name,artist,art,false); // Mostra comunque le info del brano anche senza riproduzione
  }
}

// Alterna tra play e pausa per la riproduzione corrente.
// Usa /api/pause (PUT) o /api/play (PUT senza body) a seconda dello stato attuale.
// Aggiorna S.player.playing e l'icona del pulsante nella player bar.
async function togglePlay(){
  try{
    if(S.player.playing){ await api('/api/pause',{method:'PUT'}); S.player.playing=false; setPlayIcon(false); }
    else                 { await api('/api/play',{method:'PUT',body:JSON.stringify({})}); S.player.playing=true; setPlayIcon(true); }
  } catch(e){ if(e.message!=='UNAUTH') toast('Nessun dispositivo attivo — apri Spotify','warn'); }
}

// Salta alla traccia successiva nella coda Spotify (POST /api/next).
// Attende 700ms prima di fare polling per dare tempo a Spotify di aggiornare lo stato.
async function playerNext(){ try{await api('/api/next',{method:'POST'});setTimeout(pollPlayer,700);}catch{toast('Nessun dispositivo attivo','warn');} }

// Torna alla traccia precedente nella coda Spotify (POST /api/prev).
// Attende 700ms prima di fare polling per dare tempo a Spotify di aggiornare lo stato.
async function playerPrev(){ try{await api('/api/prev',{method:'POST'});setTimeout(pollPlayer,700);}catch{toast('Nessun dispositivo attivo','warn');} }

// Aggiorna la player bar persistente in fondo allo schermo.
// Mostra titolo, artista, copertina album (o placeholder ♫ se mancante).
// Chiama setPlayIcon per sincronizzare l'icona play/pausa.
function updatePB(title,artist,art,playing){
  $('pbTitle').textContent=title||'Nessun brano';
  $('pbArtist').textContent=artist||'—';
  const pa=$('pbArt'),ph=$('pbArtPh');
  if(art){pa.src=art;pa.style.display='block';ph.style.display='none';}
  else{pa.style.display='none';ph.style.display='flex';}
  setPlayIcon(playing); S.player.playing=playing;
}

// Aggiorna la visibilità delle icone play/pausa nel bottone centrale della player bar.
// true  → mostra pausa (brano in riproduzione)
// false → mostra play  (brano in pausa)
function setPlayIcon(p){
  $('pbPlay').querySelector('.ico-play').style.display=p?'none':'block';
  $('pbPlay').querySelector('.ico-pause').style.display=p?'block':'none';
}

// Interroga l'API /api/current per ottenere lo stato aggiornato della riproduzione Spotify.
// Aggiorna la player bar con titolo, artista, copertina, stato play/pausa,
// la barra di avanzamento (percentuale e tempo trascorso/totale).
// Chiamato periodicamente da startPoll() ogni 5 secondi.
// Gli errori vengono ignorati silenziosamente per non interrompere il polling.
async function pollPlayer(){
  try{
    const d=await api('/api/current');
    if(d?.item){
      const t=d.item; S.player.uri=t.uri; S.player.playing=d.is_playing;
      updatePB(t.name,t.artists?.[0]?.name||'',t.album?.images?.[0]?.url||'',d.is_playing);
      const fill=$('pbFill');
      if(fill&&t.duration_ms) fill.style.width=Math.min(100,Math.round((d.progress_ms/t.duration_ms)*100))+'%';
      const el=$('pbElapsed'); if(el) el.textContent=fmtMs(d.progress_ms||0);
      const et=$('pbTotal');   if(et) et.textContent=fmtMs(t.duration_ms||0);
    }
  } catch{/* silent — errori di polling non mostrati all'utente */}
}

// Avvia il polling periodico della riproduzione ogni 5 secondi.
// Usa un guard (S.player.poll) per evitare di creare intervalli multipli.
function startPoll(){ if(S.player.poll)return; S.player.poll=setInterval(pollPlayer,5000); }

// Debounce per il controllo del volume: aspetta 300ms dopo l'ultimo movimento
// dello slider prima di inviare la richiesta API PUT /api/volume.
// Evita di inondare il server di richieste mentre l'utente trascina lo slider.
let _vt;
document.addEventListener('DOMContentLoaded', ()=>{
  $('pbVol')?.addEventListener('input',e=>{
    clearTimeout(_vt);
    _vt=setTimeout(async()=>{ try{await api('/api/volume',{method:'PUT',body:JSON.stringify({volume_percent:+e.target.value})});}catch{} },300);
  });
});

/* ══════════════════════════════════════════════════════
   SKELETONS / UTILS
══════════════════════════════════════════════════════ */
// Genera n righe skeleton per liste di tracce (usate come placeholder durante il caricamento).
// Ogni skeleton simula la struttura visiva di una trackRow con div animati.
function skelRows(n){ return Array(n).fill(0).map(()=>`<div class="track-item" style="pointer-events:none;opacity:.4"><div class="skel" style="width:18px;height:13px;flex-shrink:0"></div><div class="skel" style="width:40px;height:40px;border-radius:5px;flex-shrink:0"></div><div style="flex:1;display:flex;flex-direction:column;gap:5px;min-width:0"><div class="skel" style="height:12px;width:52%"></div><div class="skel" style="height:10px;width:34%"></div></div><div class="skel" style="width:35px;height:10px;flex-shrink:0"></div></div>`).join(''); }

// Genera n card skeleton per la griglia artisti (placeholder durante il caricamento).
// Include avatar circolare e due righe di testo animate.
function skelArtists(n){ return `<div class="artist-grid">${Array(n).fill(0).map(()=>`<div class="artist-card" style="pointer-events:none;opacity:.4"><div class="skel" style="width:78px;height:78px;border-radius:50%;margin:0 auto .6rem"></div><div class="skel" style="height:12px;width:70%;margin:0 auto 5px"></div><div class="skel" style="height:10px;width:50%;margin:0 auto"></div></div>`).join('')}</div>`; }

// Genera un messaggio di stato vuoto con icona di avviso.
// Usato quando una sezione non ha dati da mostrare o si è verificato un errore.
function emptyMsg(msg){ return `<div class="empty">⚠ ${msg}</div>`; }

/* ══════════════════════════════════════════════════════
   EVENTS
══════════════════════════════════════════════════════ */
// Registra tutti i listener di eventi dell'applicazione.
// - Nav items: click su qualsiasi voce del menu chiama nav(s)
// - Tema: click su themeBtn o mobTheme alterna dark/light
// - Logout: reindirizza a /logout
// - Sidebar mobile: mobMenu apre, overlay chiude
// - Player bar: pulsanti play/next/prev
// - AI: bottone genera consigli
// - Tab top tracks: al click carica il range selezionato (short/medium/long term)
// - Tab top artists: stessa logica delle top tracks
function initEvents(){
  $$('.nav-item').forEach(b=>b.addEventListener('click',()=>nav(b.dataset.s)));
  ['themeBtn','mobTheme'].forEach(id=>$(id)?.addEventListener('click',()=>applyTheme(S.theme==='dark'?'light':'dark')));
  $('logoutBtn').addEventListener('click',()=>location.href='/logout');
  $('mobMenu').addEventListener('click',openSidebar);
  $('overlay').addEventListener('click',closeSidebar);
  $('pbPlay').addEventListener('click',togglePlay);
  $('pbNext').addEventListener('click',playerNext);
  $('pbPrev').addEventListener('click',playerPrev);
  $('aiGenBtn')?.addEventListener('click', generateAiRecommendations);
  $$('#ttTabs .tab').forEach(b=>b.addEventListener('click',()=>{ $$('#ttTabs .tab').forEach(x=>x.classList.remove('active')); b.classList.add('active'); loadTT(b.dataset.r); }));
  $$('#taTabs .tab').forEach(b=>b.addEventListener('click',()=>{ $$('#taTabs .tab').forEach(x=>x.classList.remove('active')); b.classList.add('active'); loadTA(b.dataset.r); }));
}

/* ══════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════ */
// Punto di ingresso principale dell'applicazione. Eseguito al DOMContentLoaded.
// Sequenza di avvio:
//   1. Applica il tema salvato (evita flash di tema sbagliato)
//   2. Registra tutti i listener di eventi (initEvents)
//   3. Verifica autenticazione: se non autenticato reindirizza al login
//   4. Carica il profilo utente
//   5. Carica la panoramica (sezione default)
//   6. Avvia il polling del player per mostrare subito la barra di riproduzione
async function init(){
  applyTheme(S.theme);
  initEvents();
  try{ const st=await api('/api/status'); if(!st.authenticated){location.href='/';return;} }catch{ location.href='/'; return; }
  await loadUser();
  loadOverview();
  pollPlayer();
  startPoll();
}

document.addEventListener('DOMContentLoaded', init);
