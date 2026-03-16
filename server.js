const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.raw({ type: '*/*', limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── AniList GraphQL proxy ───────────────────────────────────────────────────
app.post('/api/anilist', async (req, res) => {
  try {
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Consumet gogoanime search ────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ results: [] });
  try {
    const r = await fetch(`https://api.consumet.org/anime/gogoanime/${encodeURIComponent(q)}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Consumet: get anime episodes by gogoanime ID ─────────────────────────────
app.get('/api/episodes/:id', async (req, res) => {
  try {
    const r = await fetch(`https://api.consumet.org/anime/gogoanime/info/${encodeURIComponent(req.params.id)}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Consumet: get streaming links for an episode ─────────────────────────────
app.get('/api/stream', async (req, res) => {
  const episodeId = req.query.id;
  if (!episodeId) return res.status(400).json({ error: 'Missing id' });
  try {
    const r = await fetch(`https://api.consumet.org/anime/gogoanime/watch/${encodeURIComponent(episodeId)}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Consumet: AniList meta → gogoanime episode streaming ─────────────────────
app.get('/api/meta/stream', async (req, res) => {
  const { id, ep } = req.query;
  if (!id || !ep) return res.status(400).json({ error: 'Missing id or ep' });
  try {
    const r = await fetch(`https://api.consumet.org/meta/anilist/watch/${encodeURIComponent(id)}?id=${encodeURIComponent(id)}&ep=${ep}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Consumet: get episode IDs for an AniList anime ID ────────────────────────
app.get('/api/meta/episodes/:anilistId', async (req, res) => {
  try {
    const r = await fetch(`https://api.consumet.org/meta/anilist/info/${req.params.anilistId}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── VIDEO PROXY: pipe any URL through our server ────────────────────────────
function encodeUrl(url) {
  return Buffer.from(url).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function decodeUrl(enc) {
  const b64 = enc.replace(/-/g,'+').replace(/_/g,'/');
  const pad = (4 - b64.length % 4) % 4;
  const s = Buffer.from(b64 + '='.repeat(pad), 'base64').toString('utf8');
  if (!s.startsWith('http')) throw new Error('Bad URL');
  return s;
}

app.use('/proxy/:enc(*)', async (req, res) => {
  try {
    let target = decodeUrl(req.params.enc);
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    if (qs) target += qs;

    const urlObj = new URL(target);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': urlObj.origin + '/',
      'Origin': urlObj.origin,
    };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const response = await fetch(target, { headers, redirect: 'follow', compress: true });
    const ct = response.headers.get('content-type') || 'application/octet-stream';

    res.set({
      'Access-Control-Allow-Origin': '*',
      'Content-Type': ct,
      'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
      'X-Frame-Options': 'ALLOWALL',
    });
    if (response.headers.get('content-range')) res.set('Content-Range', response.headers.get('content-range'));
    if (response.headers.get('accept-ranges')) res.set('Accept-Ranges', response.headers.get('accept-ranges'));
    if (response.headers.get('content-length') && !ct.includes('text/html'))
      res.set('Content-Length', response.headers.get('content-length'));
    res.status(response.status);

    // Rewrite m3u8 playlists so segment URLs also go through our proxy
    if (ct.includes('application/x-mpegURL') || ct.includes('application/vnd.apple.mpegurl') || target.includes('.m3u8')) {
      let text = await response.text();
      const base = target.substring(0, target.lastIndexOf('/') + 1);
      text = text.replace(/^((?!#)(.+))$/gm, (line) => {
        line = line.trim();
        if (!line || line.startsWith('#')) return line;
        let absUrl = line;
        if (line.startsWith('//')) absUrl = 'https:' + line;
        else if (line.startsWith('/')) absUrl = urlObj.origin + line;
        else if (!line.startsWith('http')) absUrl = base + line;
        return '/proxy/' + encodeUrl(absUrl);
      });
      return res.send(text);
    }

    response.body.pipe(res);
  } catch (e) {
    console.error('Proxy error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.all('*', (req, res) => res.status(404).send('Not found'));

module.exports = app;
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => console.log(`🌸 AuraBaby Anime running on :${PORT}`));
}