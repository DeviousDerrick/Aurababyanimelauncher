/* ─── AuraBaby Anime App ─────────────────────────────────────────────────── */

// ── Petals ────────────────────────────────────────────────────────────────
(function spawnPetals() {
  const c = document.getElementById('petals');
  const chars = ['✿','✾','❀','✽','❁'];
  for (let i = 0; i < 16; i++) {
    const p = document.createElement('div');
    p.className = 'petal';
    p.textContent = chars[Math.floor(Math.random() * chars.length)];
    p.style.cssText = `left:${Math.random()*100}%;animation-delay:${Math.random()*12}s;animation-duration:${9+Math.random()*10}s;font-size:${13+Math.random()*16}px;opacity:${.15+Math.random()*.35}`;
    c.appendChild(p);
  }
})();

// ── State ─────────────────────────────────────────────────────────────────
let currentAnime     = null;  // { id, title, episodes: [{id, number}] }
let currentEpisodeId = null;
let backupSources    = [];
let backupIndex      = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────
const grid          = document.getElementById('grid');
const searchInput   = document.getElementById('searchInput');
const searchBtn     = document.getElementById('searchBtn');
const loadingScreen = document.getElementById('loadingScreen');
const loadingMsg    = document.getElementById('loadingMsg');
const detailOverlay = document.getElementById('detailOverlay');
const closeDetail   = document.getElementById('closeDetail');
const playerOverlay = document.getElementById('playerOverlay');
const backToDetail  = document.getElementById('backToDetail');
const videoPlayer   = document.getElementById('videoPlayer');
const playerTitle   = document.getElementById('playerTitle');
const playerLoading = document.getElementById('playerLoading');
const playerError   = document.getElementById('playerError');
const qualityBar    = document.getElementById('qualityBar');
const fsBtn         = document.getElementById('fsBtn');
const tabs          = document.querySelectorAll('.tab');

// ── AniList GQL helper ────────────────────────────────────────────────────
async function anilist(query, variables = {}) {
  const r = await fetch('/api/anilist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return r.json();
}

const GQL_PAGE = `
query($page:Int,$perPage:Int,$sort:[MediaSort],$search:String){
  Page(page:$page,perPage:$perPage){
    media(type:ANIME,sort:$sort,search:$search,isAdult:false){
      id title{romaji english} coverImage{large} averageScore
      startDate{year} status episodes description(asHtml:false)
      genres
    }
  }
}`;

// ── Load grid ─────────────────────────────────────────────────────────────
async function loadMode(mode, searchQuery) {
  showLoading(`Loading ${mode}...`);
  grid.innerHTML = '';
  try {
    let vars = { page: 1, perPage: 30 };
    if (searchQuery) {
      vars.sort = ['SEARCH_MATCH']; vars.search = searchQuery;
    } else if (mode === 'trending') {
      vars.sort = ['TRENDING_DESC'];
    } else if (mode === 'popular') {
      vars.sort = ['POPULARITY_DESC'];
    } else if (mode === 'recent') {
      vars.sort = ['START_DATE_DESC'];
    }
    const data = await anilist(GQL_PAGE, vars);
    const items = data?.data?.Page?.media || [];
    hideLoading();
    if (!items.length) {
      grid.innerHTML = '<div class="empty">No results found.</div>';
      return;
    }
    items.forEach(renderCard);
  } catch (e) {
    hideLoading();
    grid.innerHTML = `<div class="empty">Error loading: ${e.message}</div>`;
  }
}

function renderCard(item) {
  const title = item.title.english || item.title.romaji;
  const score = item.averageScore ? `⭐ ${(item.averageScore/10).toFixed(1)}` : '';
  const year  = item.startDate?.year || '';
  const card  = document.createElement('div');
  card.className = 'anime-card';
  card.innerHTML = `
    <img src="${item.coverImage.large}" alt="${title}" loading="lazy"/>
    <div class="card-overlay"></div>
    <div class="card-play">▶</div>
    <div class="card-info">
      <div class="card-title">${title}</div>
      <div class="card-meta">
        <span class="card-score">${score}</span>
        <span>${year}</span>
      </div>
    </div>`;
  card.onclick = () => openDetail(item);
  grid.appendChild(card);
}

// ── Detail overlay ────────────────────────────────────────────────────────
async function openDetail(item) {
  const title = item.title.english || item.title.romaji;
  document.getElementById('detailTitle').textContent  = title;
  document.getElementById('detailDesc').textContent   = item.description?.replace(/<[^>]*>/g,'') || 'No description.';
  document.getElementById('detailPoster').src         = item.coverImage.large;
  document.getElementById('detailScore').textContent  = item.averageScore ? `⭐ ${(item.averageScore/10).toFixed(1)}` : '';
  document.getElementById('detailYear').textContent   = item.startDate?.year || '';
  document.getElementById('detailStatus').textContent = item.status || '';

  const epList    = document.getElementById('episodeList');
  const epLoading = document.getElementById('epLoading');
  epList.innerHTML = '';
  epLoading.textContent = 'loading episodes...';
  detailOverlay.classList.remove('hidden');

  currentAnime = { id: item.id, title };

  try {
    // Fetch episode list from Consumet meta/anilist
    const r    = await fetch(`/api/meta/episodes/${item.id}`);
    const data = await r.json();
    const eps  = data?.episodes || [];
    epLoading.textContent = eps.length ? `${eps.length} eps` : 'no episodes found';

    if (!eps.length) {
      epList.innerHTML = '<div style="color:rgba(176,106,255,.5);font-size:12px;grid-column:1/-1">No episode data available.</div>';
      return;
    }

    currentAnime.episodes = eps;
    eps.forEach((ep, idx) => {
      const btn = document.createElement('button');
      btn.className  = 'ep-btn';
      btn.textContent = ep.number || (idx + 1);
      btn.dataset.idx = idx;
      btn.onclick = () => {
        document.querySelectorAll('.ep-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        playEpisode(ep, title);
      };
      epList.appendChild(btn);
    });
  } catch (e) {
    epLoading.textContent = 'failed to load';
    epList.innerHTML = `<div style="color:#ff6464;font-size:12px;grid-column:1/-1">${e.message}</div>`;
  }
}

// ── Play episode ──────────────────────────────────────────────────────────
async function playEpisode(ep, animeTitle) {
  const epNum = ep.number || '?';
  playerTitle.textContent = `${animeTitle} — Ep ${epNum}`;
  detailOverlay.classList.add('hidden');
  playerOverlay.classList.remove('hidden');

  playerLoading.style.display = 'flex';
  playerError.classList.add('hidden');
  videoPlayer.src = '';
  qualityBar.innerHTML = '';
  backupSources = [];
  backupIndex   = 0;

  try {
    // Get streaming sources for this episode
    const r    = await fetch(`/api/stream?id=${encodeURIComponent(ep.id)}`);
    const data = await r.json();
    const sources = data?.sources || [];

    if (!sources.length) throw new Error('No sources returned');

    // Store all sources for backup switching
    backupSources    = sources;
    currentEpisodeId = ep.id;

    // Build quality selector
    qualityBar.innerHTML = '';
    sources.forEach((src, i) => {
      const btn = document.createElement('button');
      btn.className   = 'q-btn' + (i === 0 ? ' active' : '');
      btn.textContent = src.quality || `Source ${i+1}`;
      btn.onclick     = () => {
        document.querySelectorAll('.q-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadSource(src.url);
      };
      qualityBar.appendChild(btn);
    });

    // Load best quality first (usually last in array = highest)
    const best = sources.find(s => s.isM3U8) || sources[sources.length - 1] || sources[0];
    loadSource(best.url);

  } catch (e) {
    console.error('Stream fetch error:', e);
    playerLoading.style.display = 'none';
    playerError.classList.remove('hidden');
  }
}

function loadSource(rawUrl) {
  playerLoading.style.display = 'flex';
  playerError.classList.add('hidden');

  // Route through our proxy to bypass filters
  const encoded  = btoa(rawUrl).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const proxyUrl = `/proxy/${encoded}`;

  videoPlayer.src = proxyUrl;
  videoPlayer.load();
  videoPlayer.play().catch(() => {});
}

// Backup source button
document.getElementById('tryBackup').onclick = () => {
  backupIndex++;
  if (backupIndex < backupSources.length) {
    loadSource(backupSources[backupIndex].url);
  } else {
    playerError.querySelector('p').textContent = '⚠️ All sources exhausted';
  }
};

videoPlayer.oncanplay = () => {
  playerLoading.style.display = 'none';
  playerError.classList.add('hidden');
};
videoPlayer.onerror = () => {
  playerLoading.style.display = 'none';
  if (backupIndex + 1 < backupSources.length) {
    backupIndex++;
    loadSource(backupSources[backupIndex].url);
  } else {
    playerError.classList.remove('hidden');
  }
};

// ── Controls ──────────────────────────────────────────────────────────────
closeDetail.onclick = () => detailOverlay.classList.add('hidden');
detailOverlay.onclick = e => { if (e.target === detailOverlay) detailOverlay.classList.add('hidden'); };

backToDetail.onclick = () => {
  videoPlayer.pause();
  videoPlayer.src = '';
  playerOverlay.classList.add('hidden');
  if (currentAnime) detailOverlay.classList.remove('hidden');
};

fsBtn.onclick = () => {
  const w = document.getElementById('playerWrap');
  (w.requestFullscreen || w.webkitRequestFullscreen || (() => {})).call(w);
};

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!playerOverlay.classList.contains('hidden')) backToDetail.click();
    else if (!detailOverlay.classList.contains('hidden')) detailOverlay.classList.add('hidden');
  }
});

// ── Tabs ──────────────────────────────────────────────────────────────────
let currentMode = 'trending';
tabs.forEach(tab => {
  tab.onclick = () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentMode = tab.dataset.mode;
    searchInput.value = '';
    loadMode(currentMode);
  };
});

// ── Search ────────────────────────────────────────────────────────────────
let searchTimer;
searchInput.oninput = () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) { loadMode(currentMode); return; }
  searchTimer = setTimeout(() => loadMode('search', q), 400);
};
searchBtn.onclick = () => {
  const q = searchInput.value.trim();
  if (q) loadMode('search', q); else loadMode(currentMode);
};
searchInput.onkeydown = e => { if (e.key === 'Enter') searchBtn.click(); };

// ── Helpers ───────────────────────────────────────────────────────────────
function showLoading(msg) {
  loadingMsg.textContent = msg || 'Loading...';
  loadingScreen.classList.remove('hidden');
}
function hideLoading() {
  loadingScreen.classList.add('hidden');
}

// ── Init ──────────────────────────────────────────────────────────────────
loadMode('trending');