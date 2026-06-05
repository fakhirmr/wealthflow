// WealthFlow Service Worker — v4.1
// Minimal: enables PWA install without caching interference

const CACHE_NAME = 'wealthflow-v4';

// Install: skip waiting, take over immediately
self.addEventListener('install', function(e) {
  self.skipWaiting();
});

// Activate: wipe ALL old caches to fix broken cached resources
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.map(function(key) {
          console.log('[SW] Clearing old cache:', key);
          return caches.delete(key);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Fetch: ONLY cache the main HTML file (app shell)
// Everything else (Supabase API, CDN scripts) goes straight to network
self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // Never intercept Supabase API, CDN, or external requests
  if (url.includes('supabase.co') ||
      url.includes('cdn.jsdelivr.net') ||
      url.includes('unpkg.com') ||
      url.includes('googleapis.com') ||
      url.includes('anthropic.com') ||
      !url.startsWith(self.location.origin)) {
    return; // Let browser handle it normally
  }

  // For the app's own HTML — network first, cache fallback
  e.respondWith(
    fetch(e.request).then(function(response) {
      if (response && response.status === 200) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(e.request, clone);
        });
      }
      return response;
    }).catch(function() {
      return caches.match(e.request);
    })
  );
});
