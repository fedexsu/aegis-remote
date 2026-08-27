// HatchConnect console service worker.
// Deliberately minimal: it exists so the console is installable as a desktop app
// (its own window, taskbar icon, minimize). It does NOT cache the app, so the
// dashboard is always served fresh from the relay and never goes stale on deploy.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  // Network-first for page navigations only; everything else passes straight through.
  if (e.request.mode === 'navigate') { e.respondWith(fetch(e.request)); }
});
