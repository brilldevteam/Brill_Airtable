/*
 * Brill Tables service worker — makes the app installable and quick to open.
 *  - The app shell (index.html) is network-first: online you always get the latest version;
 *    offline you get the last one seen, which then shows its own "can't reach the server" states.
 *  - Built files under /assets/ have hashed names, so they're cached forever (cache-first).
 *  - The API (/api/…), files and anything cross-origin are never cached: data is always live
 *    and private data never sits in the cache.
 */
const SHELL = "brill-shell-v1";
const ASSETS = "brill-assets-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon-192.png", "/favicon.svg"])).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== ASSETS) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put("/", res.clone());
        return res;
      } catch {
        return (await caches.match("/")) || new Response("You're offline. Reconnect and reload.", { status: 503, headers: { "Content-Type": "text/plain" } });
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(ASSETS)).put(req, res.clone());
      return res;
    })());
  }
});
