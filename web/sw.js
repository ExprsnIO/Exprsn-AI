/*
 * Exprsn-AI console service worker (1.9.0, B-154): shows Web Push notifications and opens the console on a click.
 * Registered by web/js/webpush.js only when the person turns on browser notifications (Settings, Devices). It caches
 * nothing and handles no fetches. The payload is RFC 8291-encrypted by the server; the browser decrypts it before
 * this runs. A click opens a page of this console only (the route the server sent, never an outside link).
 */
'use strict';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

function routeUrl(route) {
  var r = typeof route === 'string' ? route.replace(/^[#/]+/, '') : '';
  // Same origin only: a route is a hash path of this console.
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@/?%-]*$/.test(r)) r = '';
  return new URL(r ? '/#/' + r : '/', self.location.origin).href;
}

self.addEventListener('push', function (event) {
  var d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: 'Exprsn-AI', body: event.data ? event.data.text() : '' }; }
  var title = typeof d.title === 'string' && d.title ? d.title.slice(0, 200) : 'Exprsn-AI';
  var options = { body: typeof d.body === 'string' ? d.body.slice(0, 1000) : '', data: { url: routeUrl(d.route) } };
  if (typeof d.tag === 'string' && d.tag) { options.tag = d.tag.slice(0, 64); options.renotify = true; }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || routeUrl('');
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (new URL(c.url).origin === self.location.origin && 'focus' in c) { if ('navigate' in c) c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
