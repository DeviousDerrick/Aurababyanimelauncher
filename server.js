const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.raw({ type: '*/*', limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function encodeProxyUrl(url) {
  return Buffer.from(url).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function decodeProxyUrl(encoded) {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (base64.length % 4)) % 4;
    const decoded = Buffer.from(base64 + '='.repeat(padding), 'base64').toString('utf-8');
    if (!decoded.startsWith('http://') && !decoded.startsWith('https://')) {
      throw new Error('Invalid URL scheme');
    }
    return decoded;
  } catch (e) {
    throw new Error(`Failed to decode URL: ${e.message}`);
  }
}

function rewriteHtml(html, baseUrl, proxyPrefix) {
  let rewritten = html;
  const origin = new URL(baseUrl).origin;

  rewritten = rewritten.replace(/navigator\.serviceWorker/g, 'navigator.__blockedServiceWorker');
  rewritten = rewritten.replace(/'serviceWorker'/g, "'__blockedServiceWorker'");
  rewritten = rewritten.replace(/"serviceWorker"/g, '"__blockedServiceWorker"');

  rewritten = rewritten.replace(/<meta http-equiv="Content-Security-Policy".*?>/gi, '');
  rewritten = rewritten.replace(/<meta.*?name="referrer".*?>/gi, '');
  rewritten = rewritten.replace(/integrity="[^"]*"/gi, '');
  rewritten = rewritten.replace(/crossorigin="[^"]*"/gi, '');
  rewritten = rewritten.replace(/\s+crossorigin/gi, '');

  rewritten = rewritten.replace(/(src|href)=["']([^"']+)["']/gi, (match, attr, url) => {
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#') || url.startsWith('javascript:')) return match;
    if (url.includes('/ocho/')) return match;

    let absoluteUrl = url;
    try {
      if (url.startsWith('//')) absoluteUrl = 'https:' + url;
      else if (url.startsWith('/')) absoluteUrl = origin + url;
      else if (!url.startsWith('http')) {
        const baseUrlObj = new URL(baseUrl);
        const basePath = baseUrlObj.pathname.substring(0, baseUrlObj.pathname.lastIndexOf('/') + 1);
        absoluteUrl = baseUrlObj.origin + basePath + url;
      }
      const encoded = encodeProxyUrl(absoluteUrl);
      return `${attr}="${proxyPrefix}${encoded}"`;
    } catch (e) {
      return match;
    }
  });

  const proxyScript = `
    <script>
      (function() {
        const currentOrigin = window.location.origin;
        const targetOrigin = '${origin}';
        const inFlight = new Set();

        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistrations().then(regs => {
            regs.forEach(reg => reg.unregister());
          });
          delete navigator.serviceWorker;
          Object.defineProperty(navigator, 'serviceWorker', {
            get: () => undefined,
            configurable: false
          });
        }

        function safeEncodeUrl(url) {
          try {
            const encoded = btoa(url).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
            return currentOrigin + '/ocho/' + encoded;
          } catch (e) {
            return null;
          }
        }

        const origFetch = window.fetch;
        window.fetch = function(url, opts = {}) {
          let urlStr = typeof url === 'string' ? url : url.url;
          if (urlStr.startsWith('/ocho/') || urlStr.startsWith('data:') || urlStr.startsWith('blob:') || urlStr.includes(currentOrigin)) {
            return origFetch(url, opts);
          }
          if (inFlight.has(urlStr)) return Promise.reject(new Error('Loop prevented'));
          let fullUrl = urlStr;
          if (!urlStr.startsWith('http')) {
            fullUrl = urlStr.startsWith('/') ? targetOrigin + urlStr : targetOrigin + '/' + urlStr;
          }
          const proxied = safeEncodeUrl(fullUrl);
          if (!proxied) return Promise.reject(new Error('Invalid URL'));
          inFlight.add(urlStr);
          return origFetch(proxied, opts).finally(() => inFlight.delete(urlStr));
        };

        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
          if (typeof url === 'string' && !url.startsWith('/ocho/') && !url.startsWith('data:') && !url.startsWith('blob:') && !url.includes(currentOrigin)) {
            let fullUrl = url;
            if (!url.startsWith('http')) {
              fullUrl = url.startsWith('/') ? targetOrigin + url : targetOrigin + '/' + url;
            }
            const proxied = safeEncodeUrl(fullUrl);
            if (proxied) url = proxied;
          }
          return origOpen.call(this, method, url, ...args);
        };

        document.addEventListener('click', function(e) {
          const link = e.target.closest('a');
          if (link && link.href) {
            const url = link.href;
            if (url.startsWith(targetOrigin) || (!url.startsWith(currentOrigin) && !url.startsWith('javascript:') && !url.startsWith('mailto:') && !url.startsWith('tel:') && !url.startsWith('#'))) {
              e.preventDefault();
              const fullUrl = url.startsWith('http') ? url : targetOrigin + url;
              const proxied = safeEncodeUrl(fullUrl);
              if (proxied) window.location.href = proxied;
            }
          }
        }, true);
      })();
    </script>
  `;

  rewritten = rewritten.replace(/<head[^>]*>/i, (match) => match + proxyScript);
  return rewritten;
}

async function doProxyRequest(targetUrl, req, res) {
  try {
    const urlObj = new URL(targetUrl);

    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': req.headers.accept || '*/*',
      'Accept-Encoding': 'identity',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'Connection': 'keep-alive'
    };

    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;
    if (req.headers.range) headers['Range'] = req.headers.range;

    headers['Referer'] = urlObj.origin;
    headers['Origin'] = urlObj.origin;

    const fetchOptions = {
      method: req.method,
      headers,
      redirect: 'follow'
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Buffer.isBuffer(req.body)) {
      fetchOptions.body = req.body;
    }

    console.log('Proxying:', targetUrl);
    const response = await fetch(targetUrl, fetchOptions);

    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
      'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
      'X-Frame-Options': 'ALLOWALL',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': contentType
    });

    if (response.headers.get('content-length')) res.set('Content-Length', response.headers.get('content-length'));
    if (response.headers.get('content-range')) res.set('Content-Range', response.headers.get('content-range'));
    if (response.headers.get('accept-ranges')) res.set('Accept-Ranges', response.headers.get('accept-ranges'));

    res.status(response.status);

    const contentLength = parseInt(response.headers.get('content-length') || '0');
    if (contentType.includes('text/html') && contentLength < 5 * 1024 * 1024) {
      const text = await response.text();
      const rewritten = rewriteHtml(text, targetUrl, '/ocho/');
      res.send(rewritten);
    } else if (contentType.includes('application/x-mpegURL') || contentType.includes('application/vnd.apple.mpegurl') || targetUrl.includes('.m3u8')) {
      const text = await response.text();
      res.send(text);
    } else {
      response.body.pipe(res);
    }
  } catch (error) {
    console.error(`Proxy error for ${targetUrl}:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Proxy error', message: error.message, url: targetUrl });
    }
  }
}

app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.send(`
    self.addEventListener('install', (e) => self.skipWaiting());
    self.addEventListener('activate', (e) => e.waitUntil(self.registration.unregister()));
    self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));
  `);
});

app.use('/ocho/:url(*)', (req, res) => {
  try {
    let targetUrl = decodeProxyUrl(req.params.url);
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    if (queryString) targetUrl += queryString;
    doProxyRequest(targetUrl, req, res);
  } catch (e) {
    console.error('URL decode error:', e.message);
    if (!res.headersSent) res.status(400).json({ error: 'Invalid URL encoding', message: e.message });
  }
});

app.all('*', (req, res) => {
  const referer = req.headers.referer;
  if (referer && referer.includes('/ocho/')) {
    try {
      const refPath = new URL(referer).pathname;
      const parts = refPath.split('/ocho/');
      if (parts.length > 1) {
        const encodedPart = parts[1].split('/')[0];
        const targetOrigin = new URL(decodeProxyUrl(encodedPart)).origin;
        const fixedUrl = targetOrigin + req.url;
        return doProxyRequest(fixedUrl, req, res);
      }
    } catch (e) {
      console.error('Fallback error:', e.message);
    }
  }
  res.status(404).json({ error: 'Not Found' });
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌸 AuraBaby Anime Launcher running on port ${PORT}`);
  });
}