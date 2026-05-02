'use strict';

/* ── State ─────────────────────────────────────────── */
const S = {
  theme:   localStorage.getItem('mel-theme') || 'dark',
  section: 'overview',
  user:    null,
  cache:   { tt:{}, ta:{}, recent:null, playlists:null },
  player:  { uri:null, playing:false, poll:null },
  stimer:  null,
  srFilter: 'all',
  ai:      { data:null, trackCache:{} }
};

const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

/* ── Formatters ─────────────────────────────────────── */
const fmtMs  = ms => { const m=Math.floor(ms/60000),s=Math.floor((ms%60000)/1000); return `${m}:${s.toString().padStart(2,'0')}`; };
const fmtAgo = iso => { const d=Date.now()-new Date(iso),m=Math.floor(d/60000); if(m<1)return'Adesso'; if(m<60)return`${m}m fa`; const h=Math.floor(m/60); if(h<24)return`${h}h fa`; return`${Math.floor(h/24)}g fa`; };
const fmtK   = n   => { if(n==null||n===undefined||isNaN(+n))return'—'; n=+n; if(n>=1e6)return(n/1e6).toFixed(1)+'M'; if(n>=1e3)return(n/1e3).toFixed(1)+'K'; return String(n); };
const esc    = s   => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

/* ── Toast ──────────────────────────────────────────── */
function toast(msg, type='ok', ms=3500) {
  const el=$('toast');
  el.textContent=msg; el.className=`toast show ${type}`;
  clearTimeout(el._t); el._t=setTimeout(()=>el.className='toast',ms);
}

/* ── API ────────────────────────────────────────────── */
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
function applyTheme(t) {
  S.theme=t;
  document.documentElement.setAttribute('data-theme',t);
  localStorage.setItem('mel-theme',t);
  const ic=t==='dark'?'☀':'☾';
  [$('themeBtn'),$('mobTheme')].forEach(el=>{if(el)el.textContent=ic;});
}

/* ── Navigation ─────────────────────────────────────── */
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
    playlists:    loadPlaylists,
    search:       ()=>setTimeout(()=>$('searchInput')?.focus(),80),
    stats:        loadStats,
    ai:           initAiSection,
    player:       loadPlayerPage
  })[s]?.();
}

function openSidebar()  { $('sidebar').classList.add('open'); $('overlay').classList.add('open'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('overlay').classList.remove('open'); }

/* ══════════════════════════════════════════════════════
   USER
══════════════════════════════════════════════════════ */
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

function renderMiniTracks(el, tracks) {
  if(!el)return;
  if(!tracks?.length){el.innerHTML='<div class="empty">Nessun dato</div>';return;}
  el.innerHTML=tracks.filter(Boolean).map((t,i)=>trackRow(t,i,{mini:true})).join('');
}

/* ── Track row (generico, usato ovunque tranne search) ─ */
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
async function loadTT(range) {
  if(S.cache.tt[range]){renderTT(S.cache.tt[range]);return;}
  $('ttList').innerHTML=skelRows(15);
  try{ const d=await api(`/api/top-tracks?time_range=${range}&limit=50`); S.cache.tt[range]=d.items; renderTT(d.items); }
  catch{ $('ttList').innerHTML=emptyMsg('Impossibile caricare le top tracks'); }
}
function renderTT(tracks){
  if(!tracks?.length){$('ttList').innerHTML=emptyMsg('Nessun dato — ascolta più musica!');return;}
  $('ttList').innerHTML=tracks.map((t,i)=>trackRow(t,i)).join('');
}

/* ══════════════════════════════════════════════════════
   TOP ARTISTS
══════════════════════════════════════════════════════ */
async function loadTA(range) {
  if(S.cache.ta[range]){renderTA(S.cache.ta[range]);return;}
  $('taList').innerHTML=skelArtists(12);
  try{ const d=await api(`/api/top-artists?time_range=${range}&limit=50`); S.cache.ta[range]=d.items; renderTA(d.items); }
  catch{ $('taList').innerHTML=emptyMsg('Impossibile caricare gli artisti'); }
}
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
async function loadRecent() {
  if(S.cache.recent){renderRecent(S.cache.recent);return;}
  $('recentList').innerHTML=skelRows(15);
  try{ const d=await api('/api/recent'); S.cache.recent=d.items; renderRecent(d.items); }
  catch{ $('recentList').innerHTML=emptyMsg('Impossibile caricare i recenti'); }
}
function renderRecent(items){
  if(!items?.length){$('recentList').innerHTML=emptyMsg('Nessun brano recente');return;}
  $('recentList').innerHTML=items.map((item,i)=>{ if(!item.track)return''; return trackRow(item.track,i,{ago:fmtAgo(item.played_at)}); }).join('');
}

/* ══════════════════════════════════════════════════════
   PLAYLISTS — riscritto da zero
══════════════════════════════════════════════════════ */

async function loadPlaylists() {
  plShowGrid();
  if (S.cache.playlists) { renderPlaylists(S.cache.playlists); return; }
  $('plGrid').innerHTML = skelPlaylists(12);
  try {
    const d = await api('/api/playlists');
    S.cache.playlists = d.items || [];
    renderPlaylists(S.cache.playlists);
  } catch(e) {
    $('plGrid').innerHTML = emptyMsg('Impossibile caricare le playlist');
  }
}

function plShowGrid() {
  $('plGrid').style.display   = 'grid';
  $('plDetail').style.display = 'none';
}

function renderPlaylists(pls) {
  plShowGrid();
  if (!pls?.length) { $('plGrid').innerHTML = emptyMsg('Nessuna playlist trovata'); return; }
  $('plGrid').innerHTML = pls.map(p => {
    const img   = p.images?.[0]?.url || '';
    const total = p.tracks?.total ?? 0;
    const owner = esc(p.owner?.display_name || '');
    const name  = esc(p.name || 'Playlist');
    const id    = esc(p.id);
    return `
      <div class="plc" onclick="openPlaylist('${id}','${name}','${esc(img)}','${total}','${owner}')">
        <div class="plc-img-wrap">
          ${img
            ? `<img class="plc-img" src="${esc(img)}" alt="${name}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=plc-noimg>\u266b</div>'">`
            : `<div class="plc-noimg">\u266b</div>`
          }
          <div class="plc-overlay">
            <div class="plc-play-btn">
              <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
        </div>
        <div class="plc-info">
          <div class="plc-name">${name}</div>
          <div class="plc-meta">${total} brani${owner ? ' \u00b7 ' + owner : ''}</div>
        </div>
      </div>`;
  }).join('');
}

async function openPlaylist(id, name, img, total, owner) {
  $('plGrid').style.display   = 'none';
  $('plDetail').style.display = 'block';

  /* ── Header ─────────────────────────────────────── */
  const imgEl   = $('pld-img');
  const noImgEl = $('pld-noimg');
  if (img) { imgEl.src = img; imgEl.style.display = 'block'; noImgEl.style.display = 'none'; }
  else      { imgEl.style.display = 'none'; noImgEl.style.display = 'flex'; }
  $('pld-name').textContent = name;
  $('pld-meta').textContent = `${total} brani${owner ? ' · ' + owner : ''}`;
  $('pld-tracks').innerHTML = skelRows(12);

  try {
    const d      = await api(`/api/playlists/${id}/tracks`);
    const tracks = (d.items || [])
      .map(item => item?.track)
      .filter(t => t && t.uri && t.name && t.artists);

    if (!tracks.length) {
      $('pld-tracks').innerHTML = emptyMsg('Playlist vuota o brani non disponibili');
      return;
    }
    /* aggiorna contatore reale */
    $('pld-meta').textContent = `${tracks.length} brani${owner ? ' · ' + owner : ''}`;
    $('pld-tracks').innerHTML = tracks.map((t, i) => trackRow(t, i)).join('');

  } catch(e) {
    console.error('openPlaylist:', e);
    $('pld-tracks').innerHTML = emptyMsg('Errore nel caricamento dei brani');
  }
}

/* ══════════════════════════════════════════════════════
   SEARCH — riscritto da zero
══════════════════════════════════════════════════════ */

function initSearch() {
  const inp = $('searchInput');
  const clr = $('searchClear');

  /* filtri tipo */
  $$('.sr-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.sr-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      S.srFilter = btn.dataset.f;
      const q = inp.value.trim();
      if (q) doSearch(q);
    });
  });

  inp.addEventListener('input', () => {
    const q = inp.value.trim();
    clr.style.display = q ? 'flex' : 'none';
    clearTimeout(S.stimer);
    if (!q) { srShowEmpty(); return; }
    srShowSkel();
    S.stimer = setTimeout(() => doSearch(q), 360);
  });

  clr.addEventListener('click', () => {
    inp.value = '';
    clr.style.display = 'none';
    srShowEmpty();
    inp.focus();
  });

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && inp.value.trim()) {
      clearTimeout(S.stimer);
      doSearch(inp.value.trim());
    }
  });
}

/* stati UI */
function srShowEmpty() {
  $('srEmptyState').style.display  = 'flex';
  $('srResults').style.display     = 'none';
  $('srArtistDetail').style.display= 'none';
}
function srShowResults() {
  $('srEmptyState').style.display  = 'none';
  $('srResults').style.display     = 'block';
  $('srArtistDetail').style.display= 'none';
}
function srShowArtist() {
  $('srEmptyState').style.display  = 'none';
  $('srResults').style.display     = 'none';
  $('srArtistDetail').style.display= 'block';
}
function srShowSkel() {
  srShowResults();
  $('srResults').innerHTML = `
    <div class="sr-section">
      <div class="sr-sec-label">Ricerca in corso…</div>
      ${Array(6).fill(0).map(() => `
        <div class="sr-track-row" style="pointer-events:none;opacity:.35">
          <div class="skel" style="width:42px;height:42px;border-radius:6px;flex-shrink:0"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px">
            <div class="skel" style="height:12px;width:46%"></div>
            <div class="skel" style="height:10px;width:28%"></div>
          </div>
        </div>`).join('')}
    </div>`;
}

async function doSearch(q) {
  srShowResults();
  try {
    const d       = await api(`/api/search?q=${encodeURIComponent(q)}&limit=20`);
    const tracks  = (d?.tracks?.items  || []).filter(t => t?.name && t?.uri && t?.artists);
    const artists = (d?.artists?.items || []).filter(a => a?.name && a?.id);

    /* applica filtro attivo */
    const showTracks  = S.srFilter !== 'artist';
    const showArtists = S.srFilter !== 'track';

    if ((!tracks.length || !showTracks) && (!artists.length || !showArtists)) {
      $('srResults').innerHTML = `
        <div class="sr-noresult">
          <div class="sr-noresult-ico">🔍</div>
          <p>Nessun risultato per <strong>"${esc(q)}"</strong></p>
        </div>`;
      return;
    }

    let html = '';

    /* ── ARTISTI ── */
    if (artists.length && showArtists) {
      html += `<div class="sr-section">
        <div class="sr-sec-label">Artisti</div>
        <div class="sr-artists-grid">
          ${artists.slice(0, 8).map(a => {
            const ph  = esc((a.name[0] || '?').toUpperCase());
            const img = a.images?.[0]?.url || '';
            return `
            <div class="sr-artist-card" onclick="srOpenArtist('${esc(a.id)}','${esc(a.name)}','${esc(img)}','${esc((a.genres||[]).slice(0,1).join('')||'')}')">
              <div class="sr-ac-wrap">
                ${img
                  ? `<img src="${esc(img)}" alt="${esc(a.name)}" onerror="this.parentElement.innerHTML='<div class=sr-ac-ph>${ph}</div>'">`
                  : `<div class="sr-ac-ph">${ph}</div>`
                }
                <div class="sr-ac-hover"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
              </div>
              <div class="sr-ac-name">${esc(a.name)}</div>
              <div class="sr-ac-genre">${esc((a.genres||[]).slice(0,1).join('') || 'Artista')}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }

    /* ── BRANI ── */
    if (tracks.length && showTracks) {
      html += `<div class="sr-section">
        <div class="sr-sec-label">Brani</div>
        ${tracks.map((t, i) => srTrackRow(t, i)).join('')}
      </div>`;
    }

    $('srResults').innerHTML = html;

  } catch(e) {
    console.error('doSearch error:', e);
    $('srResults').innerHTML = `
      <div class="sr-noresult">
        <div class="sr-noresult-ico">⚠️</div>
        <p>Errore durante la ricerca. Riprova.</p>
      </div>`;
  }
}

/* Riga brano nella search */
function srTrackRow(t, i) {
  const art     = esc(t.album?.images?.[0]?.url || '');
  const name    = esc(t.name);
  const artists = esc((t.artists||[]).map(a=>a.name).join(', '));
  const album   = esc(t.album?.name || '');
  const dur     = fmtMs(t.duration_ms || 0);
  const uri     = esc(t.uri);
  const playing = S.player.uri === t.uri;
  return `
    <div class="sr-track-row${playing ? ' sr-playing' : ''}" onclick="playTrack('${uri}','${name}','${artists}','${art}')">
      <div class="sr-tr-num">
        ${playing
          ? `<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:var(--g)"><path d="M8 5v14l11-7z"/></svg>`
          : i + 1}
      </div>
      <div class="sr-tr-cover">
        ${art ? `<img src="${art}" alt="" onerror="this.style.display='none'">` : `<div class="sr-tr-ph">\u266b</div>`}
        <div class="sr-tr-hover"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
      </div>
      <div class="sr-tr-info">
        <div class="sr-tr-name${playing ? ' sr-green' : ''}">${name}</div>
        <div class="sr-tr-sub">${artists}</div>
      </div>
      <div class="sr-tr-right">
        <span class="sr-tr-album">${album}</span>
        <span class="sr-tr-dur">${dur}</span>
      </div>
    </div>`;
}

/* Pagina artista */
async function srOpenArtist(artistId, artistName, artistImg, artistGenre) {
  srShowArtist();

  /* hero */
  $('srArtistHero').innerHTML = `
    <button class="sr-back" onclick="srBackToResults()">
      <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
      Indietro
    </button>
    <div class="sr-ah-content">
      ${artistImg
        ? `<img class="sr-ah-img" src="${esc(artistImg)}" alt="${esc(artistName)}">`
        : `<div class="sr-ah-img sr-ah-ph">${esc((artistName[0]||'?').toUpperCase())}</div>`
      }
      <div class="sr-ah-info">
        <div class="sr-ah-label">Artista</div>
        <h2 class="sr-ah-name">${esc(artistName)}</h2>
        ${artistGenre ? `<div class="sr-ah-genre">${esc(artistGenre)}</div>` : ''}
      </div>
    </div>`;

  /* brani */
  $('srArtistBody').innerHTML = `
    <div class="sr-sec-label" style="margin-bottom:.75rem">Top Brani</div>
    ${skelRows(8)}`;

  try {
    const d      = await api(`/api/artists/${artistId}/top-tracks`);
    const tracks = (d.tracks || []).filter(t => t?.uri && t?.name);

    if (!tracks.length) {
      $('srArtistBody').innerHTML = emptyMsg('Nessun brano trovato per questo artista');
      return;
    }
    $('srArtistBody').innerHTML = `
      <div class="sr-sec-label" style="margin-bottom:.75rem">Top Brani · ${tracks.length}</div>
      ${tracks.map((t, i) => srTrackRow(t, i)).join('')}`;

  } catch(e) {
    console.error('srOpenArtist:', e);
    $('srArtistBody').innerHTML = emptyMsg('Errore nel caricamento dei brani');
  }
}

function srBackToResults() {
  const q = $('searchInput').value.trim();
  if (q) { srShowResults(); }
  else   { srShowEmpty(); }
}

/* Chiamato dall'AI section */
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
   STATS — generi fix + tutto il resto
══════════════════════════════════════════════════════ */
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
    btn.disabled = false;
    btn.textContent = '✨ Genera Consigli';
  }
}

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
    S.cache.playlists=null;
    toast(`✅ Playlist "${plName}" creata con ${uris.length} brani!`,'ok',5000);
    btn.textContent='✅ Playlist creata!'; btn.style.background='var(--g)';
    setTimeout(()=>{btn.disabled=false;btn.textContent='Crea Playlist su Spotify';btn.style.background='';},4000);
  } catch(e){ toast('Errore creazione playlist: '+e.message,'err'); btn.disabled=false; btn.textContent='Crea Playlist su Spotify'; }
}

/* ══════════════════════════════════════════════════════
   PLAYER PAGE
══════════════════════════════════════════════════════ */
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
    updatePB(name,artist,art,false);
  }
}

async function togglePlay(){
  try{
    if(S.player.playing){ await api('/api/pause',{method:'PUT'}); S.player.playing=false; setPlayIcon(false); }
    else                 { await api('/api/play',{method:'PUT',body:JSON.stringify({})}); S.player.playing=true; setPlayIcon(true); }
  } catch(e){ if(e.message!=='UNAUTH') toast('Nessun dispositivo attivo — apri Spotify','warn'); }
}
async function playerNext(){ try{await api('/api/next',{method:'POST'});setTimeout(pollPlayer,700);}catch{toast('Nessun dispositivo attivo','warn');} }
async function playerPrev(){ try{await api('/api/prev',{method:'POST'});setTimeout(pollPlayer,700);}catch{toast('Nessun dispositivo attivo','warn');} }

function updatePB(title,artist,art,playing){
  $('pbTitle').textContent=title||'Nessun brano';
  $('pbArtist').textContent=artist||'—';
  const pa=$('pbArt'),ph=$('pbArtPh');
  if(art){pa.src=art;pa.style.display='block';ph.style.display='none';}
  else{pa.style.display='none';ph.style.display='flex';}
  setPlayIcon(playing); S.player.playing=playing;
}

function setPlayIcon(p){
  $('pbPlay').querySelector('.ico-play').style.display=p?'none':'block';
  $('pbPlay').querySelector('.ico-pause').style.display=p?'block':'none';
}

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
  } catch{/* silent */}
}

function startPoll(){ if(S.player.poll)return; S.player.poll=setInterval(pollPlayer,5000); }

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
function skelRows(n){ return Array(n).fill(0).map(()=>`<div class="track-item" style="pointer-events:none;opacity:.4"><div class="skel" style="width:18px;height:13px;flex-shrink:0"></div><div class="skel" style="width:40px;height:40px;border-radius:5px;flex-shrink:0"></div><div style="flex:1;display:flex;flex-direction:column;gap:5px;min-width:0"><div class="skel" style="height:12px;width:52%"></div><div class="skel" style="height:10px;width:34%"></div></div><div class="skel" style="width:35px;height:10px;flex-shrink:0"></div></div>`).join(''); }
function skelArtists(n){ return `<div class="artist-grid">${Array(n).fill(0).map(()=>`<div class="artist-card" style="pointer-events:none;opacity:.4"><div class="skel" style="width:78px;height:78px;border-radius:50%;margin:0 auto .6rem"></div><div class="skel" style="height:12px;width:70%;margin:0 auto 5px"></div><div class="skel" style="height:10px;width:50%;margin:0 auto"></div></div>`).join('')}</div>`; }
function skelPlaylists(n){ return Array(n).fill(0).map(()=>`<div class="plc" style="pointer-events:none;opacity:.4"><div class="plc-img-wrap"><div class="skel" style="width:100%;aspect-ratio:1"></div></div><div class="plc-info"><div class="skel" style="height:12px;width:68%;margin-bottom:6px"></div><div class="skel" style="height:10px;width:42%"></div></div></div>`).join(''); }
function emptyMsg(msg){ return `<div class="empty">⚠ ${msg}</div>`; }

/* ══════════════════════════════════════════════════════
   EVENTS
══════════════════════════════════════════════════════ */
function initEvents(){
  $$('.nav-item').forEach(b=>b.addEventListener('click',()=>nav(b.dataset.s)));
  ['themeBtn','mobTheme'].forEach(id=>$(id)?.addEventListener('click',()=>applyTheme(S.theme==='dark'?'light':'dark')));
  $('logoutBtn').addEventListener('click',()=>location.href='/logout');
  $('mobMenu').addEventListener('click',openSidebar);
  $('overlay').addEventListener('click',closeSidebar);
  $('pbPlay').addEventListener('click',togglePlay);
  $('pbNext').addEventListener('click',playerNext);
  $('pbPrev').addEventListener('click',playerPrev);
  $('plBack')?.addEventListener('click',()=>{ if(S.cache.playlists)renderPlaylists(S.cache.playlists); else plShowGrid(); });
  $('aiGenBtn')?.addEventListener('click', generateAiRecommendations);
  $$('#ttTabs .tab').forEach(b=>b.addEventListener('click',()=>{ $$('#ttTabs .tab').forEach(x=>x.classList.remove('active')); b.classList.add('active'); loadTT(b.dataset.r); }));
  $$('#taTabs .tab').forEach(b=>b.addEventListener('click',()=>{ $$('#taTabs .tab').forEach(x=>x.classList.remove('active')); b.classList.add('active'); loadTA(b.dataset.r); }));
}

/* ══════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════ */
async function init(){
  applyTheme(S.theme);
  initEvents();
  initSearch();
  try{ const st=await api('/api/status'); if(!st.authenticated){location.href='/';return;} }catch{ location.href='/'; return; }
  await loadUser();
  loadOverview();
  pollPlayer();
  startPoll();
}

document.addEventListener('DOMContentLoaded', init);
