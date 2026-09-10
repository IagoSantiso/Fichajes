/**
 * Service worker.
 *
 * Cachea el armazón de la aplicación para que la pantalla de fichaje abra sin
 * red. Los datos nunca se sirven de caché: un fichaje de ayer mostrado como si
 * fuera de hoy es peor que no mostrar nada. Lo que sí funciona sin cobertura es
 * la cola: ver public/js/cola.js.
 */
const VERSION = 'v4';
const CACHE = `armazon-${VERSION}`;

const ARMAZON = [
  '/',
  '/css/estilo.css',
  '/js/api.js',
  '/js/cola.js',
  '/js/trabajador.js',
  '/manifest.json',
  '/iconos/icono-192.png',
  '/iconos/icono-512.png',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ARMAZON))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(
        claves.filter((c) => c !== CACHE).map((c) => caches.delete(c)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (evento) => {
  const url = new URL(evento.request.url);

  // La API nunca se cachea ni se sirve de caché.
  if (url.pathname.startsWith('/api/')) return;
  if (evento.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Caché primero y revalidación en segundo plano: la pantalla de fichaje
  // abre al instante aunque la red esté a medias, y la siguiente apertura ya
  // trae la versión nueva. El armazón cambia poco; la inmediatez importa mucho.
  evento.respondWith(
    caches.match(evento.request).then((enCache) => {
      const desdeRed = fetch(evento.request).then((respuesta) => {
        if (respuesta.ok) {
          const copia = respuesta.clone();
          caches.open(CACHE).then((cache) => cache.put(evento.request, copia));
        }
        return respuesta;
      });
      if (enCache) {
        desdeRed.catch(() => {});   // la revalidación no debe romper nada
        return enCache;
      }
      return desdeRed.catch(() => caches.match('/'));
    }),
  );
});
