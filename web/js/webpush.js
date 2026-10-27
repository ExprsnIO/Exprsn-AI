// Browser notifications for the console (1.9.0, B-154): App.webPush for Settings › Devices, and the acknowledgement of
// push.notification on the console's socket (B-152).
//
// - App.webPush.supported(): whether this browser can take Web Push (service worker, PushManager, Notification).
// - App.webPush.status(): { supported, permission, subscribed, deviceId }.
// - App.webPush.subscribe({ name }): asks for permission, registers /sw.js, subscribes with the VAPID public key from
//   GET /api/push/web-config and registers the subscription as a device through POST /api/me/devices. Resolves to the
//   device; rejects with an Error whose message can be shown (no provider, permission refused, unsupported).
// - App.webPush.unsubscribe(): ends the browser's subscription and revokes the device (DELETE /api/me/devices/:id).
//
// Nothing here registers the service worker until subscribe() is called.
(function () {
  const KEY = 'exprsn.webpush.device';
  const remember = (id) => { try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch (e) { /* storage blocked */ } };
  const remembered = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const keyBytes = (b64) => {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };
  const sameKey = (sub, bytes) => {
    const k = sub && sub.options && sub.options.applicationServerKey;
    if (!k) return false;
    const a = new Uint8Array(k);
    return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
  };
  const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext !== false;
  const registration = () => (supported() ? navigator.serviceWorker.getRegistration('/') : Promise.resolve(null));

  App.webPush = {
    supported,
    async status() {
      if (!supported()) return { supported: false, permission: 'unsupported', subscribed: false, deviceId: null };
      const reg = await registration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      return { supported: true, permission: Notification.permission, subscribed: !!sub, deviceId: sub ? remembered() : null };
    },
    async subscribe(opts) {
      if (!supported()) throw new Error('This browser cannot show notifications from the console.');
      let cfg;
      try { cfg = await App.get('/api/push/web-config'); }
      catch (err) { throw new Error(err && err.status === 404 ? 'Browser notifications are not set up here yet: an administrator adds a Web Push provider first.' : 'The notification settings could not be read.'); }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site in the browser settings.' : 'Notifications were not allowed.');
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const key = keyBytes(cfg.publicKey);
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub, key)) { await sub.unsubscribe(); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const j = sub.toJSON();
      const name = (opts && opts.name) || (navigator.userAgent.indexOf('Firefox') >= 0 ? 'Firefox' : navigator.userAgent.indexOf('Edg/') >= 0 ? 'Edge' : navigator.userAgent.indexOf('Chrome') >= 0 ? 'Chrome' : navigator.userAgent.indexOf('Safari') >= 0 ? 'Safari' : 'Browser');
      const device = await App.post('/api/me/devices', { platform: 'web', provider: 'webpush', name: String(name).slice(0, 100), subscription: { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, expirationTime: j.expirationTime == null ? null : j.expirationTime } });
      remember(device && device.id);
      return device;
    },
    async unsubscribe() {
      const id = remembered();
      const reg = await registration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) await sub.unsubscribe();
      if (id) { try { await App.del('/api/me/devices/' + encodeURIComponent(id)); } catch (e) { /* revoked already */ } }
      remember(null);
      return true;
    }
  };

  // B-152: acknowledge push.notification on the console's socket, so the server does not also push to devices.
  const hook = () => {
    const sock = App.socket;
    if (!sock || sock.__pushAck) return;
    sock.__pushAck = true;
    sock.on('push.notification', (msg, ack) => { if (typeof ack === 'function') ack({ ok: true }); else if (msg && msg.deliveryId) sock.emit('push.ack', { deliveryId: msg.deliveryId }); });
  };
  setInterval(hook, 1000);
}());
