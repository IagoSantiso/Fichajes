/**
 * Service worker.
 *
 * Guarda una copia del armazón de la aplicación para que la pantalla de
 * fichaje abra sin cobertura. Los datos nunca se sirven de caché: un fichaje
 * de ayer mostrado como si fuera de hoy es peor que no mostrar nada. Lo que sí
 * funciona sin red es la cola: ver public/js/cola.js.
 *
 * La estrategia es **red primero, con la copia local como respaldo**, y no al
 * revés. Sirviendo de caché primero, un despliegue quedaba invisible para
 * quien ya hubiera abierto la aplicación una vez: el navegador no volvía a
 * preguntar. Depender de acordarse de subir VERSION en cada cambio no es una
 * salvaguarda, es una trampa —ya falló una vez— así que la corrección está en
 * la estrategia, no en la disciplina.
 *
 * Para que eso no penalice a quien ficha con mala señal, la red no se espera
 * indefinidamente: pasado ESPERA_RED_MS sale la copia guardada.
 */
const VERSION = 'v6';
const CACHE = `armazon-${VERSION}`;

/** Cuánto se espera a la red antes de tirar de la copia local. */
const ESPERA_RED_MS = 2500;

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

  evento.respondWith(responder(evento.request));
});

/** Resuelve a null pasados los milisegundos indicados. */
function espera(ms) {
  return new Promise((resolver) => setTimeout(() => resolver(null), ms));
}

async function responder(peticion) {
  const cache = await caches.open(CACHE);

  // Nunca rechaza: null significa que no hubo red. Así el reintento tardío de
  // más abajo no deja una promesa rechazada suelta.
  const desdeRed = fetch(peticion)
    .then((respuesta) => {
      if (respuesta.ok) cache.put(peticion, respuesta.clone()).catch(() => {});
      return respuesta;
    })
    .catch(() => null);

  const pronta = await Promise.race([desdeRed, espera(ESPERA_RED_MS)]);
  if (pronta) return pronta;

  // La red no ha llegado a tiempo, o no hay: vale la copia guardada.
  const enCache = await cache.match(peticion);
  if (enCache) return enCache;

  // Sin copia. Se le da a la red el tiempo que necesite antes de rendirse.
  const tardia = await desdeRed;
  if (tardia) return tardia;

  // Una navegación a una ruta que no está guardada: al menos el armazón, que
  // deja al trabajador en la pantalla de fichaje y con la cola operativa.
  if (peticion.mode === 'navigate') {
    const raiz = await cache.match('/');
    if (raiz) return raiz;
  }

  return new Response('Sin conexión', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
