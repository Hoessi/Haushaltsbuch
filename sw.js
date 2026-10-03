// Offline-Cache für das Haushaltsbuch. Bei Änderungen an der App VERSION erhöhen.
const VERSION = "hb-v6";
const CORE = ["./", "index.html", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Seite: sofort aus dem Cache (schneller Start auch bei schwachem Netz), im Hintergrund aktualisieren.
  // Ohne Cache: Netz, nach 4 s Fallback auf den Cache.
  if (req.mode === "navigate"){
    const net = fetch(req).then(r => { if (r.ok){ const c = r.clone(); caches.open(VERSION).then(x => x.put("index.html", c)); } return r; });
    e.waitUntil(net.catch(() => {}));
    e.respondWith(caches.match("index.html").then(hit => hit ||
      Promise.race([net, new Promise((_, rej) => setTimeout(rej, 4000))]).catch(() => caches.match("index.html").then(h => h || net))));
    return;
  }
  // Eigene Dateien und Schriften: Cache zuerst, im Hintergrund nachladen
  if (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)){
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(r => { if (r.ok || r.type === "opaque") { const c = r.clone(); caches.open(VERSION).then(x => x.put(req, c)); } return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
