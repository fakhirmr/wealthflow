// WealthFlow Service Worker — v5.0 (offline-capable)
//
// Dua cache terpisah:
//   SHELL  — HTML/ikon milik sendiri. Network-first (selalu ambil versi terbaru),
//            jatuh ke cache saat offline.
//   VENDOR — React/ReactDOM/Supabase/font dari CDN. Cache-first, karena URL-nya
//            sudah dipin ke versi tertentu + dilindungi SRI, jadi isinya tak berubah.
//            TANPA ini aplikasi mustahil jalan offline (React tak pernah termuat).

const SHELL_CACHE = 'wealthflow-shell-v7';
const VENDOR_CACHE = 'wealthflow-vendor-v1';

const VENDOR_URLS = [
  'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js',
  'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/dist/umd/supabase.min.js'
];
const SHELL_URLS = ['/', '/index.html', '/manifest.json'];

function isVendor(url) {
  return url.includes('cdn.jsdelivr.net') ||
    url.includes('unpkg.com') ||
    url.includes('fonts.googleapis.com') ||
    url.includes('fonts.gstatic.com');
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    Promise.all([
      // Satu per satu + catch: satu URL gagal tak boleh menggagalkan seluruh instalasi
      caches.open(VENDOR_CACHE).then(function (cache) {
        return Promise.all(VENDOR_URLS.map(function (u) {
          return cache.add(new Request(u, { mode: 'cors', credentials: 'omit' })).catch(function () { });
        }));
      }),
      caches.open(SHELL_CACHE).then(function (cache) {
        return Promise.all(SHELL_URLS.map(function (u) {
          return cache.add(new Request(u, { cache: 'reload' })).catch(function () { });
        }));
      })
    ]).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        // Buang cache shell lama, TAPI pertahankan vendor — kalau ikut dihapus,
        // user offline tepat setelah update akan kehilangan React.
        return Promise.all(keys.map(function (key) {
          if (key === SHELL_CACHE || key === VENDOR_CACHE) return null;
          return caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
      .then(function () { return self.clients.matchAll({ type: 'window', includeUncontrolled: true }); })
      .then(function (clients) {
        clients.forEach(function (client) { client.postMessage({ type: 'SW_UPDATED' }); });
      })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = req.url;

  // Jangan sentuh: non-GET, endpoint API sendiri, dan data Supabase.
  // Data ditangani di level aplikasi (snapshot + outbox), bukan di sini.
  if (req.method !== 'GET' || url.indexOf('/api/') >= 0 || url.includes('supabase.co')) return;

  // VENDOR — cache-first (versi terpin, isinya tetap)
  if (isVendor(url)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) {
            var copy = res.clone();
            caches.open(VENDOR_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  if (!url.startsWith(self.location.origin)) return;

  // SHELL — network-first supaya update langsung sampai; cache dipakai saat offline.
  e.respondWith(
    fetch(new Request(url, { cache: 'no-store', credentials: req.credentials }))
      .then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          // Navigasi apa pun saat offline -> sajikan app shell
          if (req.mode === 'navigate') return caches.match('/index.html') || caches.match('/');
          return new Response('', { status: 504, statusText: 'Offline' });
        });
      })
  );
});
