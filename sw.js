// 最小PWA: アプリの外枠をキャッシュ(価格などのSupabase通信は常にネットワーク)
const CACHE = "mirage-v1";
const SHELL = ["./", "./index.html", "./app.js", "./config.js", "./manifest.json",
               "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Supabase / フォント / CDN はネットワーク優先
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
