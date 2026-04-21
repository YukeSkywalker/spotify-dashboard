/* ═══════════════════════════════════════════════════════════════
   MELODIA  app.js  — complete frontend
═══════════════════════════════════════════════════════════════ */
'use strict';

/* ── State ─────────────────────────────────────────────────── */
const S = {
  theme:   localStorage.getItem('mel-theme') || 'dark',
  section: 'overview',
  user:    null,
  cache:   { tt:{}, ta:{}, recent:null, playlists:null },
  player:  { uri:null, playing:false, poll:null },
  stimer:  null
};

/* ── DOM ───────────────────────────────────────────────────── */
const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

/* ── Formatters ────────────────────────────────────────────── */
const fmtMs  = ms => { const m=Math.floor(ms/60000),s=Math.floor((ms%60000)/1000); return `${m}:${s.toString().padStart(2,'0')}`; };
const fmtAgo = iso => { const d=Date.now()-new Date(iso),m=Math.floor(d/60000); if(m<1)return'Adesso'; if(m<60)return`${m}m fa`; const h=Math.floor(m/60); if(h<24)return`${h}h fa`; return`${Math.floor(h/24)}g fa`; };
const fmtK   = n   => n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n||0);
const esc    = s   => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

/* ── Toast ─────────────────────────────────────────────────── */
function toast(msg, type='ok', ms=3500) {
  const el=$('toast');
  el.textContent=msg; el.className=`toast show ${type}`;
  clearTimeout(el._t); el._t=setTimeout(()=>el.className='toast',ms);
}

/* ── API ───────────────────────────────────────────────────── */
async function api(path, opts={}) {
  try {
    const res = await fetch(path, {
      ...opts,
      headers:{'Content-Type':'application/json',...(opts.headers||{})}
    });
    if (res.status===401) { toast('Sessione scaduta — fai di nuovo login','err',5000); setTimeout(()=>location.href='/',2800); throw new Error('UNAUTH'); }
    if (res.status===204) return null;
    const d = await res.json();
    if (!res.ok) throw new Error(d.error||`HTTP ${res.status}`);
    return d;
  } catch(e) {
    if (e.message!=='UNAUTH') console.warn('API',path,e.message);
    throw e;
  }
}

/* ── Theme ─────────────────────────────────────────────────── */
function applyTheme(t) {
  S.theme=t;
  document.documentElement.setAttribute('data-theme',t);
  localStorage.setItem('mel-theme',t);
  const ic=t==='dark'?'☀':'☾';
  [$('themeBtn'),$('mobTheme')].forEach(el=>{if(el)el.textContent=ic;});
}

/* ── Navigation ────────────────────────────────────────────── */
function nav(s) {
  S.section=s;
  $$('.view').forEach(v=>v.classList.remove('active'));
  $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.s===s));
  const v=$(`view-${s}`);
  if(v) v.classList.add('active');
  closeSidebar();
  ({
    overview:    loadOverview,
    'top-tracks':()=>loadTT('short_term'),
    'top-artists':()=>loadTA('short_term'),
    recent:      loadRecent,
    playlists:   loadPlaylists,
    search:      ()=>setTimeout(()=>$('searchInput').focus(),80),
    stats:       loadStats,
    player:      loadPlayerPage
  })[s]?.();
}

function openSidebar()  { $('sidebar').classList.add('open'); $('overlay').classList.add('open'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('overlay').classList.remove('open'); }

/* ══════════════════════════════════════════════════════════════
   USER
══════════════════════════════════════════════════════════════ */
async function loadUser() {
  try {
    const u = await api('/api/me');
    S.user = u;
    renderUser(u);
    return u;
  } catch(e) {
    if(e.message==='UNAUTH') return null;
    $('sbName').textContent='Errore profilo';
    $('sbAvatarPh').textContent='!';
    toast('Impossibile caricare il profilo','err',6000);
    return null;
  }
}

function renderUser(u) {
  $('sbName').textContent   = u.display_name||u.id||'Utente';
  $('sbPlan').textContent   = u.product==='premium'?'✦ Premium':'Free';
  $('ovName').textContent   = (u.display_name||u.id||'Ciao').split(' ')[0];
  const img = u.images?.[0]?.url||u.images?.[1]?.url;
  const av=$('sbAvatar'), ph=$('sbAvatarPh');
  if(img){
    av.src=img; av.style.display='block'; ph.style.display='none';
    av.onerror=()=>{ av.style.display='none'; ph.style.display='flex'; ph.textContent=(u.display_name||'?')[0].toUpperCase(); };
  } else {
    av.style.display='none'; ph.style.display='flex';
    ph.textContent=(u.display_name||u.id||'?')[0].toUpperCase();
  }
}

/* ══════════════════════════════════════════════════════════════
   OVERVIEW
══════════════════════════════════════════════════════════════ */
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
  if(ok(rR)){
    const items=rR.value.items||[];
    $('stMinutes').textContent=Math.round(items.reduce((a,i)=>a+(i.track?.duration_ms||0),0)/60000);
    renderMiniTracks($('ovRecent'),items.slice(0,5).map(i=>i.track));
  }
}

function renderOvArtist(a) {
  const el=$('ovArtistCard');
  if(!el||!a) return;
  el.innerHTML=`<div class="ov-ac">
    <img src="${esc(a.images?.[0]?.url||'')}" alt="" onerror="this.style.display='none'" />
    <div>
      <div class="ov-ac-lbl">Artista #1</div>
      <div class="ov-ac-name">${esc(a.name)}</div>
      <div class="ov-ac-gen">${(a.genres||[]).slice(0,3).join(' · ')||'—'}</div>
      <div class="ov-ac-fol">${fmtK(a.followers?.total)} followers</div>
    </div>
  </div>`;
}

function renderMiniTracks(el, tracks) {
  if(!el) return;
  if(!tracks?.length){el.innerHTML='<div class="empty">Nessun dato</div>';return;}
  el.innerHTML=tracks.filter(Boolean).map((t,i)=>trackRow(t,i,{mini:true})).join('');
}

/* ══════════════════════════════════════════════════════════════
   TRACK ROW helper
══════════════════════════════════════════════════════════════ */
function trackRow(t, i, {ago=null, mini=false}={}) {
  const art = t.album?.images?.[0]?.url||'';
  const artists = t.artists?.map(a=>a.name).join(', ')||'';
  const isPlaying = S.player.uri===t.uri;
  return `
    <div class="track-item${isPlaying?' playing':''}"
         onclick="playTrack('${esc(t.uri)}','${esc(t.name)}','${esc(t.artists?.[0]?.name||'')}','${esc(art)}')">
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
      </div>`:''}
    </div>`;
}

/* ══════════════════════════════════════════════════════════════
   TOP TRACKS
══════════════════════════════════════════════════════════════ */
async function loadTT(range) {
  if(S.cache.tt[range]){renderTT(S.cache.tt[range]);return;}
  $('ttList').innerHTML=skelRows(15);
  try{
    const d=await api(`/api/top-tracks?time_range=${range}&limit=50`);
    S.cache.tt[range]=d.items;
    renderTT(d.items);
  }catch{$('ttList').innerHTML=emptyMsg('Impossibile caricare le top tracks');}
}
function renderTT(tracks){
  if(!tracks?.length){$('ttList').innerHTML=emptyMsg('Nessun dato — ascolta più musica!');return;}
  $('ttList').innerHTML=tracks.map((t,i)=>trackRow(t,i)).join('');
}

/* ══════════════════════════════════════════════════════════════
   TOP ARTISTS
══════════════════════════════════════════════════════════════ */
async function loadTA(range) {
  if(S.cache.ta[range]){renderTA(S.cache.ta[range]);return;}
  $('taList').innerHTML=skelArtists(12);
  try{
    const d=await api(`/api/top-artists?time_range=${range}&limit=50`);
    S.cache.ta[range]=d.items;
    renderTA(d.items);
  }catch{$('taList').innerHTML=emptyMsg('Impossibile caricare gli artisti');}
}
function renderTA(artists){
  if(!artists?.length){$('taList').innerHTML=emptyMsg('Nessun dato');return;}
  $('taList').innerHTML=artists.map((a,i)=>`
    <div class="artist-card">
      <div class="ac-rank">#${i+1}</div>
      <img class="ac-img" src="${esc(a.images?.[0]?.url||'')}" alt="${esc(a.name)}" loading="lazy" onerror="this.style.opacity='0'"/>
      <div class="ac-name">${esc(a.name)}</div>
      <div class="ac-gen">${(a.genres||[]).slice(0,2).join(', ')||'—'}</div>
      <div class="ac-pop">
        <div class="ac-bar"><div class="ac-fill" style="width:${a.popularity||0}%"></div></div>
        <span class="ac-plbl">${a.popularity||0}</span>
      </div>
    </div>`).join('');
}

/* ══════════════════════════════════════════════════════════════
   RECENT
══════════════════════════════════════════════════════════════ */
async function loadRecent() {
  if(S.cache.recent){renderRecent(S.cache.recent);return;}
  $('recentList').innerHTML=skelRows(15);
  try{
    const d=await api('/api/recent');
    S.cache.recent=d.items;
    renderRecent(d.items);
  }catch{$('recentList').innerHTML=emptyMsg('Impossibile caricare i recenti');}
}
function renderRecent(items){
  if(!items?.length){$('recentList').innerHTML=emptyMsg('Nessun brano recente');return;}
  $('recentList').innerHTML=items.map((item,i)=>{
    if(!item.track)return'';
    return trackRow(item.track,i,{ago:fmtAgo(item.played_at)});
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   PLAYLISTS
══════════════════════════════════════════════════════════════ */
async function loadPlaylists() {
  if(S.cache.playlists){renderPlaylists(S.cache.playlists);return;}
  $('plGrid').innerHTML=skelPlaylists(8);
  showPlGrid();
  try{
    const d=await api('/api/playlists');
    S.cache.playlists=d.items;
    renderPlaylists(d.items);
  }catch{$('plGrid').innerHTML=emptyMsg('Impossibile caricare le playlist');}
}
function showPlGrid(){ $('plGrid').style.display='grid'; $('plDetail').style.display='none'; }
function renderPlaylists(pls){
  showPlGrid();
  if(!pls?.length){$('plGrid').innerHTML=emptyMsg('Nessuna playlist');return;}
  $('plGrid').innerHTML=pls.map(p=>`
    <div class="pl-card" onclick="openPlaylist('${esc(p.id)}','${esc(p.name)}','${esc(p.images?.[0]?.url||'')}')">
      <div class="pl-img-wrap">
        <img class="pl-img" src="${esc(p.images?.[0]?.url||'')}" alt="${esc(p.name)}" loading="lazy" onerror="this.style.display='none'"/>
        <div class="pl-card-ov"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
      </div>
      <div class="pl-info">
        <div class="pl-name">${esc(p.name)}</div>
        <div class="pl-cnt">${p.tracks?.total||0} brani · ${esc(p.owner?.display_name||'')}</div>
      </div>
    </div>`).join('');
}
async function openPlaylist(id,name,img){
  $('plGrid').style.display='none';
  $('plDetail').style.display='block';
  $('plDetailName').textContent=name;
  const ci=$('plDetailImg');
  if(img){ci.src=img;ci.style.display='block';}else{ci.style.display='none';}
  $('plTrackList').innerHTML=skelRows(10);
  try{
    const d=await api(`/api/playlists/${id}/tracks`);
    const tracks=(d.items||[]).filter(i=>i.track?.id);
    if(!tracks.length){$('plTrackList').innerHTML=emptyMsg('Playlist vuota');return;}
    $('plTrackList').innerHTML=tracks.map((item,i)=>trackRow(item.track,i)).join('');
  }catch{$('plTrackList').innerHTML=emptyMsg('Impossibile caricare i brani');}
}

/* ══════════════════════════════════════════════════════════════
   SEARCH
══════════════════════════════════════════════════════════════ */
function initSearch(){
  const inp=$('searchInput'),clr=$('searchClear'),res=$('searchResults'),hint=$('searchHint');
  inp.addEventListener('input',()=>{
    const q=inp.value.trim();
    clr.style.display=q?'block':'none';
    clearTimeout(S.stimer);
    if(!q){res.innerHTML='';hint.style.display='block';return;}
    hint.style.display='none';
    res.innerHTML=skelRows(6);
    S.stimer=setTimeout(()=>doSearch(q),380);
  });
  clr.addEventListener('click',()=>{inp.value='';clr.style.display='none';res.innerHTML='';hint.style.display='block';inp.focus();});
  inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&inp.value.trim()){clearTimeout(S.stimer);doSearch(inp.value.trim());}});
}
async function doSearch(q){
  const res=$('searchResults');
  try{
    const d=await api(`/api/search?q=${encodeURIComponent(q)}&limit=20`);
    const tracks=d.tracks?.items||[];
    const artists=d.artists?.items||[];
    if(!tracks.length&&!artists.length){res.innerHTML=`<div class="empty">Nessun risultato per "<strong>${esc(q)}</strong>"</div>`;return;}
    let html='';
    if(tracks.length){
      html+=`<div class="search-section-title">Brani</div>`;
      html+=tracks.map((t,i)=>trackRow(t,i)).join('');
    }
    if(artists.length){
      html+=`<div class="search-section-title">Artisti</div>`;
      html+=artists.slice(0,6).map(a=>`
        <div class="artist-search-item">
          <img class="asi-img" src="${esc(a.images?.[0]?.url||'')}" alt="${esc(a.name)}" onerror="this.style.display='none'"/>
          <div>
            <div class="asi-name">${esc(a.name)}</div>
            <div class="asi-gen">${(a.genres||[]).slice(0,2).join(', ')||'—'}</div>
          </div>
        </div>`).join('');
    }
    res.innerHTML=html;
  }catch{res.innerHTML=emptyMsg('Ricerca fallita — riprova');}
}

/* ══════════════════════════════════════════════════════════════
   STATS
══════════════════════════════════════════════════════════════ */
async function loadStats(){
  const c=$('statsContent');
  if(!c)return;
  c.innerHTML='<div class="spinner"></div>';
  try{
    const [tL,aL,rR]=await Promise.all([
      api('/api/top-tracks?time_range=long_term&limit=50'),
      api('/api/top-artists?time_range=long_term&limit=50'),
      api('/api/recent')
    ]);
    const genreMap={};
    (aL.items||[]).forEach(a=>(a.genres||[]).forEach(g=>{genreMap[g]=(genreMap[g]||0)+1;}));
    const genres=Object.entries(genreMap).sort((a,b)=>b[1]-a[1]).slice(0,8);
    const dec={};
    (tL.items||[]).forEach(t=>{const y=t.album?.release_date?.slice(0,4);if(y){const d=Math.floor(+y/10)*10;dec[d]=(dec[d]||0)+1;}});
    const recMin=Math.round((rR.items||[]).reduce((a,i)=>a+(i.track?.duration_ms||0),0)/60000);
    const popAvg=tL.items?.length?Math.round(tL.items.reduce((a,t)=>a+(t.popularity||0),0)/tL.items.length):0;

    c.innerHTML=`
      <div class="stats-section">
        <div class="stats-h">🎸 Generi preferiti</div>
        <div class="genre-rows">${genres.map(([g,n])=>`
          <div class="g-row">
            <span class="g-lbl">${esc(g)}</span>
            <div class="g-track"><div class="g-fill" style="width:${Math.round(n/genres[0][1]*100)}%"></div></div>
            <span class="g-cnt">${n}</span>
          </div>`).join('')}
        </div>
      </div>
      <div class="stats-section">
        <div class="stats-h">📅 Decenni più ascoltati</div>
        <div class="decade-grid">${Object.entries(dec).sort((a,b)=>b[1]-a[1]).map(([d,n])=>`
          <div class="dec-card"><div class="dec-y">${d}s</div><div class="dec-n">${n} brani</div></div>`).join('')}
        </div>
      </div>
      <div class="stats-section">
        <div class="stats-h">📊 Riepilogo</div>
        <div class="sum-grid">
          <div class="sum-card"><div class="sum-val">${recMin}</div><div class="sum-lbl">Min. ascoltati (recenti)</div></div>
          <div class="sum-card"><div class="sum-val">${tL.items?.length||0}</div><div class="sum-lbl">Top tracks nel tempo</div></div>
          <div class="sum-card"><div class="sum-val">${aL.items?.length||0}</div><div class="sum-lbl">Artisti ascoltati</div></div>
          <div class="sum-card"><div class="sum-val">${popAvg}</div><div class="sum-lbl">Popolarità media</div></div>
        </div>
      </div>
      <div class="stats-section">
        <div class="stats-h">🏆 Top 10 di sempre</div>
        <div class="track-list">${(tL.items||[]).slice(0,10).map((t,i)=>trackRow(t,i)).join('')}</div>
      </div>`;
  }catch{c.innerHTML=emptyMsg('Impossibile caricare le statistiche');}
}

/* ══════════════════════════════════════════════════════════════
   PLAYER PAGE
══════════════════════════════════════════════════════════════ */
async function loadPlayerPage(){
  const c=$('playerPageContent');
  if(!c)return;
  c.innerHTML='<div class="spinner"></div>';
  try{
    const d=await api('/api/current');
    if(!d?.item){
      c.innerHTML=`<div class="np-empty">
        <div class="np-empty-ico">♫</div>
        <p>Nessun brano in riproduzione</p>
        <p class="np-hint">Apri Spotify su un dispositivo e avvia un brano</p>
      </div>`;
      return;
    }
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
  }catch{c.innerHTML=emptyMsg('Impossibile caricare il player');}
}

/* ══════════════════════════════════════════════════════════════
   PLAYER CONTROLS
══════════════════════════════════════════════════════════════ */
async function playTrack(uri, name, artist, art) {
  if(!uri) return;
  try{
    await api('/api/play',{method:'PUT',body:JSON.stringify({uris:[uri]})});
    S.player.uri=uri; S.player.playing=true;
    updatePB(name,artist,art,true);
    toast(`▶  ${name}`,'ok');
    startPoll();
  }catch(e){
    if(e.message==='UNAUTH') return;
    if(e.message?.includes('premium')) return toast('Riproduzione disponibile solo con Spotify Premium','warn',5000);
    if(e.message?.includes('403')) return toast('Spotify Premium richiesto per la riproduzione','warn',5000);
    toast('Apri Spotify su un dispositivo attivo','warn',5000);
    updatePB(name,artist,art,false);
  }
}

async function togglePlay(){
  try{
    if(S.player.playing){
      await api('/api/pause',{method:'PUT'});
      S.player.playing=false; setPlayIcon(false);
    } else {
      await api('/api/play',{method:'PUT',body:JSON.stringify({})});
      S.player.playing=true; setPlayIcon(true);
    }
  }catch(e){
    if(e.message==='UNAUTH') return;
    toast('Nessun dispositivo attivo — apri Spotify','warn');
  }
}

async function playerNext(){
  try{await api('/api/next',{method:'POST'});setTimeout(pollPlayer,700);}
  catch{toast('Nessun dispositivo attivo','warn');}
}
async function playerPrev(){
  try{await api('/api/prev',{method:'POST'});setTimeout(pollPlayer,700);}
  catch{toast('Nessun dispositivo attivo','warn');}
}

function updatePB(title,artist,art,playing){
  $('pbTitle').textContent=title||'Nessun brano';
  $('pbArtist').textContent=artist||'—';
  const pa=$('pbArt'),ph=$('pbArtPh');
  if(art){pa.src=art;pa.style.display='block';ph.style.display='none';}
  else{pa.style.display='none';ph.style.display='flex';}
  setPlayIcon(playing);
  S.player.playing=playing;
}

function setPlayIcon(p){
  $('pbPlay').querySelector('.ico-play').style.display=p?'none':'block';
  $('pbPlay').querySelector('.ico-pause').style.display=p?'block':'none';
}

async function pollPlayer(){
  try{
    const d=await api('/api/current');
    if(d?.item){
      const t=d.item;
      S.player.uri=t.uri; S.player.playing=d.is_playing;
      updatePB(t.name,t.artists?.[0]?.name||'',t.album?.images?.[0]?.url||'',d.is_playing);
      const fill=$('pbFill');
      if(fill&&t.duration_ms){fill.style.width=Math.min(100,Math.round((d.progress_ms/t.duration_ms)*100))+'%';}
      $('pbElapsed').textContent=fmtMs(d.progress_ms||0);
      $('pbTotal').textContent=fmtMs(t.duration_ms||0);
    }
  }catch{/* silent */}
}

function startPoll(){
  if(S.player.poll) return;
  S.player.poll=setInterval(pollPlayer,5000);
}

/* ── Volume ────────────────────────────────────────────────── */
let _vt;
$('pbVol')?.addEventListener('input',e=>{
  clearTimeout(_vt);
  _vt=setTimeout(async()=>{
    try{await api('/api/volume',{method:'PUT',body:JSON.stringify({volume_percent:+e.target.value})});}
    catch{/* no device */}
  },300);
});

/* ══════════════════════════════════════════════════════════════
   SKELETONS / UTILS
══════════════════════════════════════════════════════════════ */
function skelRows(n){
  return Array(n).fill(0).map(()=>`
    <div class="track-item" style="pointer-events:none;opacity:.45">
      <div class="skel" style="width:18px;height:13px;flex-shrink:0"></div>
      <div class="skel" style="width:40px;height:40px;border-radius:5px;flex-shrink:0"></div>
      <div style="flex:1;display:flex;flex-direction:column;gap:5px;min-width:0">
        <div class="skel" style="height:12px;width:52%"></div>
        <div class="skel" style="height:10px;width:34%"></div>
      </div>
      <div class="skel" style="width:35px;height:10px;flex-shrink:0"></div>
    </div>`).join('');
}
function skelArtists(n){
  return `<div class="artist-grid">${Array(n).fill(0).map(()=>`
    <div class="artist-card" style="pointer-events:none;opacity:.45">
      <div class="skel" style="width:78px;height:78px;border-radius:50%;margin:0 auto .6rem"></div>
      <div class="skel" style="height:12px;width:70%;margin:0 auto 5px"></div>
      <div class="skel" style="height:10px;width:50%;margin:0 auto"></div>
    </div>`).join('')}</div>`;
}
function skelPlaylists(n){
  return Array(n).fill(0).map(()=>`
    <div class="pl-card" style="pointer-events:none;opacity:.45">
      <div class="skel" style="width:100%;aspect-ratio:1;border-radius:0"></div>
      <div style="padding:.75rem .85rem;display:flex;flex-direction:column;gap:5px">
        <div class="skel" style="height:12px;width:68%"></div>
        <div class="skel" style="height:10px;width:42%"></div>
      </div>
    </div>`).join('');
}
function emptyMsg(msg){return `<div class="empty">⚠ ${msg}</div>`;}

/* ══════════════════════════════════════════════════════════════
   EVENTS
══════════════════════════════════════════════════════════════ */
function initEvents(){
  // Nav
  $$('.nav-item').forEach(b=>b.addEventListener('click',()=>nav(b.dataset.s)));
  // Theme
  ['themeBtn','mobTheme'].forEach(id=>$(id)?.addEventListener('click',()=>applyTheme(S.theme==='dark'?'light':'dark')));
  // Logout
  $('logoutBtn').addEventListener('click',()=>location.href='/logout');
  // Mobile
  $('mobMenu').addEventListener('click',openSidebar);
  $('overlay').addEventListener('click',closeSidebar);
  // Player bar
  $('pbPlay').addEventListener('click',togglePlay);
  $('pbNext').addEventListener('click',playerNext);
  $('pbPrev').addEventListener('click',playerPrev);
  // Back from playlist
  $('plBack').addEventListener('click',()=>{if(S.cache.playlists)renderPlaylists(S.cache.playlists);});
  // TT tabs
  $$('#ttTabs .tab').forEach(b=>b.addEventListener('click',()=>{
    $$('#ttTabs .tab').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); loadTT(b.dataset.r);
  }));
  // TA tabs
  $$('#taTabs .tab').forEach(b=>b.addEventListener('click',()=>{
    $$('#taTabs .tab').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); loadTA(b.dataset.r);
  }));
}

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */
async function init(){
  applyTheme(S.theme);
  initEvents();
  initSearch();

  // Check auth
  try{
    const st=await api('/api/status');
    if(!st.authenticated){location.href='/';return;}
  }catch{location.href='/';return;}

  // Load user — if fails we still continue
  await loadUser();

  // Load overview
  loadOverview();

  // Start player poll
  pollPlayer();
  startPoll();
}

document.addEventListener('DOMContentLoaded', init);
