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

  // Block service workers
  rewritten = rewritten.replace(/navigator\.serviceWorker/g, 'navigator.__blockedSW');
  rewritten = rewritten.replace(/'serviceWorker'/g, "'__blockedSW'");
  rewritten = rewritten.replace(/"serviceWorker"/g, '"__blockedSW"');

  // Strip restrictive headers/meta
  rewritten = rewritten.replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
  rewritten = rewritten.replace(/<meta[^>]*name=["']?referrer["']?[^>]*>/gi, '');
  rewritten = rewritten.replace(/\s*integrity=["'][^"']*["']/gi, '');
  rewritten = rewritten.replace(/\s*crossorigin=["'][^"']*["']/gi, '');
  rewritten = rewritten.replace(/\s+crossorigin(?=[\s>])/gi, '');

  // Kill inline frame-busting patterns in script text
  rewritten = rewritten.replace(/window\.top\s*!==?\s*window(?:\.self)?/g, 'false');
  rewritten = rewritten.replace(/window\.top\s*===?\s*window(?:\.self)?/g, 'true');
  rewritten = rewritten.replace(/window\s*!==?\s*window\.top/g, 'false');
  rewritten = rewritten.replace(/window\s*===?\s*window\.top/g, 'true');
  rewritten = rewritten.replace(/self\s*!==?\s*top/g, 'false');
  rewritten = rewritten.replace(/self\s*===?\s*top/g, 'true');
  rewritten = rewritten.replace(/top\.location/g, 'location');
  rewritten = rewritten.replace(/top\[["']location["']\]/g, "location");

  // Rewrite static src/href attributes
  rewritten = rewritten.replace(/(src|href|action)=["']([^"']+)["']/gi, (match, attr, url) => {
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
        'use strict';
        const __proxyOrigin = window.location.origin;
        const __targetOrigin = '${origin}';
        const __inFlight = new Set();

        // ── 1. FRAME-BUST PREVENTION ──────────────────────────────
        try {
          Object.defineProperty(window, 'top',         { get: () => window, configurable: true });
          Object.defineProperty(window, 'parent',      { get: () => window, configurable: true });
          Object.defineProperty(window, 'frameElement',{ get: () => null,   configurable: true });
        } catch(e) {}

        // ── 1b. SPOOF window.location to look like the real site ──
        try {
          const __tUrl = new URL(__targetOrigin);
          const __locOverrides = {
            hostname: { get: () => __tUrl.hostname },
            host:     { get: () => __tUrl.host },
            origin:   { get: () => __tUrl.origin },
            href: {
              get: () => __targetOrigin + window.location.pathname + window.location.search,
              set: (v) => { window.location.assign(__proxyUrl(v)); }
            },
            protocol: { get: () => __tUrl.protocol },
          };
          for (const [key, desc] of Object.entries(__locOverrides)) {
            try {
              Object.defineProperty(window.location, key, { ...desc, configurable: true });
            } catch(e) {}
          }
        } catch(e) {}

        // ── 2. BLOCK SERVICE WORKERS ──────────────────────────────
        try {
          if (navigator.serviceWorker) {
            navigator.serviceWorker.getRegistrations && navigator.serviceWorker.getRegistrations()
              .then(regs => regs.forEach(r => r.unregister()));
            Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined, configurable: false });
          }
        } catch(e) {}

        // ── 3. URL ENCODER ────────────────────────────────────────
        function __proxyUrl(url) {
          try {
            if (!url || url.startsWith('data:') || url.startsWith('blob:') ||
                url.startsWith('javascript:') || url.startsWith('/ocho/') ||
                url.includes(__proxyOrigin)) return url;
            let full = url;
            if (url.startsWith('//')) full = 'https:' + url;
            else if (url.startsWith('/')) full = __targetOrigin + url;
            else if (!url.startsWith('http')) full = __targetOrigin + '/' + url;
            const enc = btoa(full).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
            return __proxyOrigin + '/ocho/' + enc;
          } catch(e) { return url; }
        }

        // ── 4. INTERCEPT FETCH ────────────────────────────────────
        const __origFetch = window.fetch;
        window.fetch = function(input, init = {}) {
          let urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
          if (urlStr.startsWith('/ocho/') || urlStr.startsWith('data:') || urlStr.startsWith('blob:') || urlStr.includes(__proxyOrigin)) {
            return __origFetch(input, init);
          }
          if (__inFlight.has(urlStr)) return Promise.reject(new Error('Proxy loop'));
          __inFlight.add(urlStr);
          const proxied = __proxyUrl(urlStr);
          const newInput = typeof input === 'string' ? proxied : new Request(proxied, input);
          return __origFetch(newInput, init).finally(() => __inFlight.delete(urlStr));
        };

        // ── 5. INTERCEPT XHR ──────────────────────────────────────
        const __origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          return __origOpen.call(this, method, __proxyUrl(String(url)), ...rest);
        };

        // ── 6. INTERCEPT DYNAMIC ELEMENT src/href SETTING ─────────
        function __patchSrc(el) {
          ['src','href','action','data'].forEach(attr => {
            try {
              const proto = Object.getPrototypeOf(el);
              const desc = Object.getOwnPropertyDescriptor(proto, attr) ||
                           Object.getOwnPropertyDescriptor(HTMLElement.prototype, attr);
              if (!desc || !desc.set) return;
              const origSet = desc.set;
              Object.defineProperty(el, attr, {
                set(val) { return origSet.call(this, __proxyUrl(String(val))); },
                get: desc.get,
                configurable: true
              });
            } catch(e) {}
          });
        }

        const __origCreate = document.createElement.bind(document);
        document.createElement = function(tag, opts) {
          const el = __origCreate(tag, opts);
          const t = tag.toLowerCase();
          if (['script','link','img','iframe','video','audio','source','track'].includes(t)) {
            __patchSrc(el);
          }
          return el;
        };

        // ── 7. MUTATIONOBSERVER for late-injected nodes ───────────
        const __mo = new MutationObserver(mutations => {
          mutations.forEach(m => {
            m.addedNodes.forEach(node => {
              if (node.nodeType !== 1) return;
              ['src','href','action'].forEach(attr => {
                const val = node.getAttribute && node.getAttribute(attr);
                if (val && !val.startsWith('data:') && !val.startsWith('blob:') &&
                    !val.startsWith('/ocho/') && !val.includes(__proxyOrigin) &&
                    (val.startsWith('http') || val.startsWith('//'))) {
                  node.setAttribute(attr, __proxyUrl(val));
                }
              });
            });
          });
        });
        __mo.observe(document.documentElement || document, { childList: true, subtree: true });

        // ── 8. INTERCEPT WINDOW.LOCATION CHANGES ─────────────────
        try {
          const __origPushState    = history.pushState.bind(history);
          const __origReplaceState = history.replaceState.bind(history);
          history.pushState = function(state, title, url) {
            return __origPushState(state, title, url ? __proxyUrl(String(url)) : url);
          };
          history.replaceState = function(state, title, url) {
            return __origReplaceState(state, title, url ? __proxyUrl(String(url)) : url);
          };
        } catch(e) {}

        // ── 9. INTERCEPT LINK CLICKS ──────────────────────────────
        document.addEventListener('click', function(e) {
          const link = e.target.closest('a[href]');
          if (!link) return;
          const href = link.getAttribute('href');
          if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
          let full = href;
          if (href.startsWith('//')) full = 'https:' + href;
          else if (href.startsWith('/')) full = __targetOrigin + href;
          else if (!href.startsWith('http')) full = __targetOrigin + '/' + href;
          if (full.includes(__proxyOrigin)) return;
          e.preventDefault();
          e.stopPropagation();
          window.location.href = __proxyUrl(full);
        }, true);

        // ── 10. INTERCEPT window.open ─────────────────────────────
        const __origOpen2 = window.open;
        window.open = function(url, target, features) {
          return __origOpen2(__proxyUrl(String(url || '')), target, features);
        };

      })();
    <\/script>
  `;

  rewritten = rewritten.replace(/<head[^>]*>/i, (match) => match + proxyScript);
  return rewritten;
}

async function doProxyRequest(targetUrl, req, res) {
  try {
    const urlObj = new URL(targetUrl);

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Upgrade-Insecure-Requests': '1',
    };

    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;
    if (req.headers.range) headers['Range'] = req.headers.range;

    headers['Referer'] = urlObj.origin + '/';
    headers['Origin'] = urlObj.origin;
    headers['Host'] = urlObj.hostname;

    const fetchOptions = {
      method: req.method,
      headers,
      redirect: 'follow',
      compress: true,
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Buffer.isBuffer(req.body)) {
      fetchOptions.body = req.body;
    }

    console.log('Proxying:', targetUrl);
    const response = await fetch(targetUrl, fetchOptions);

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const encoding = response.headers.get('content-encoding') || '';

    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
      'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
      'X-Frame-Options': 'ALLOWALL',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': contentType,
    });

    if (response.headers.get('content-range')) res.set('Content-Range', response.headers.get('content-range'));
    if (response.headers.get('accept-ranges')) res.set('Accept-Ranges', response.headers.get('accept-ranges'));

    res.status(response.status);

    const isHtml = contentType.includes('text/html');
    const isM3u8 = contentType.includes('application/x-mpegURL') ||
                   contentType.includes('application/vnd.apple.mpegurl') ||
                   targetUrl.includes('.m3u8');
    const isText = contentType.includes('text/') || contentType.includes('javascript') ||
                   contentType.includes('json') || isM3u8;

    if (isHtml || isM3u8) {
      const text = await response.text();
      if (isHtml) {
        const rewritten = rewriteHtml(text, targetUrl, '/ocho/');
        res.send(rewritten);
      } else {
        res.send(text);
      }
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