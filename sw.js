// WealthFlow Service Worker — v4.2

const CACHE_NAME = 'wealthflow-v5';

self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(key) {
        return caches.delete(key);
      }));
    })
    .then(function() {
      return self.clients.claim();
    })
    .then(function() {
      // Tell every open window to reload so they get the new version
      return self.clients.matchAll({type: 'window', includeUncontrolled: true});
    })
    .then(function(clients) {
      clients.forEach(function(client) {
        client.postMessage({type: 'SW_UPDATED'});
      });
    })
  );
});

self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  if (url.includes('supabase.co') ||
      url.includes('cdn.jsdelivr.net') ||
      url.includes('unpkg.com') ||
      url.includes('googleapis.com') ||
      url.includes('groq.com') ||
      !url.startsWith(self.location.origin)) {
    return;
  }

  // Always bypass HTTP cache so we always serve the freshest HTML
  e.respondWith(
    fetch(new Request(e.request.url, {cache: 'no-store', credentials: e.request.credentials}))
      .then(function(response) {
        if (response && response.status === 200) {
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(e.request, response.clone());
          });
        }
        return response;
      })
      .catch(function() {
        return caches.match(e.request);
      })
  );
});
