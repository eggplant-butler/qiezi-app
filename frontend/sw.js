// v6.9.19 kill-switch SW：清缓存 + 注销 + 透传所有请求
self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys()
      .then(function(names) {
        return Promise.all(names.map(function(n) { return caches.delete(n); }));
      })
      .then(function() { return self.clients.claim(); })
      .then(function() {
        return self.clients.matchAll({ includeUncontrolled: true });
      })
      .then(function(clients) {
        clients.forEach(function(c) {
          c.postMessage({ type: 'SW_KILLED', version: 'kill-switch' });
        });
      })
  );
});

self.addEventListener('fetch', function(e) {
  e.respondWith(fetch(e.request));
});
