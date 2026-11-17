var CACHE = 'my-budget-v6';
var FILES = ['./', 'index.html', 'styles.css', 'app.js', 'parser.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'fonts/inter-400.woff2', 'fonts/inter-600.woff2', 'fonts/inter-700.woff2', 'fonts/inter-800.woff2'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return k !== CACHE ? caches.delete(k) : null; })); }).then(function () { return self.clients.claim(); })); });
/* Network-first for the app's own files: a fresh deploy shows up on the next open,
   and the cache only steps in when the phone is offline. */
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(function (resp) {
      var copy = resp.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return resp;
    }).catch(function () { return caches.match(e.request); })
  );
});
