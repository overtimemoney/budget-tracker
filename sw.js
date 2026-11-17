var CACHE = 'my-budget-v1';
var FILES = ['./', 'index.html', 'styles.css', 'app.js', 'parser.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return k !== CACHE ? caches.delete(k) : null; })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener('fetch', function (e) { e.respondWith(caches.match(e.request).then(function (hit) { return hit || fetch(e.request); })); });
