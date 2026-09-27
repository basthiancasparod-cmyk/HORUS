/**
 * HORUS — sw.js
 * Service worker.
 *
 * Estrategia de caché, por tipo de recurso:
 *   - Navegación (el HTML): red primero con tiempo máximo, y si falla se sirve
 *     la copia guardada. Así una versión nueva llega en cuanto hay conexión,
 *     pero la app abre igualmente sin ella.
 *   - Estáticos propios (CSS, JS, iconos, manifest): caché primero, porque
 *     llevan el número de versión en el nombre del caché y se refrescan al
 *     publicar. Es lo que hace que la app abra al instante y funcione offline.
 *   - Fuentes de Google: caché primero con relleno en segundo plano (son
 *     inmutables, así que no caducan).
 *   - API de Supabase: NUNCA se cachea. Servir datos de calendario viejos como
 *     si fueran actuales sería peor que no responder.
 */

const VERSION = 'v4.12.0';
const CACHE = `horus-${VERSION}`;
const RUNTIME = `horus-runtime-${VERSION}`;

/** Recursos que deben estar disponibles sin conexión desde la primera visita. */
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/tokens.css',
  './css/base.css',
  './css/components.css',
  './css/app.css',
  './js/app.js',
  './js/config.js',
  './js/core/date.js',
  './js/core/model.js',
  './js/core/store.js',
  './js/core/storage.js',
  './js/core/coverage.js',
  './js/core/utils.js',
  './js/core/auth.js',
  './js/core/sync.js',
  './js/core/exporter.js',
  './js/core/reminders.js',
  './js/core/holidays.js',
  './js/core/pdf-text.js',
  './js/core/schedule-import.js',
  './js/core/ai-vision.js',
  './js/ui/context.js',
  './js/ui/toolkit.js',
  './js/ui/dialogs.js',
  './js/ui/import-review.js',
  './js/ui/views/today.js',
  './js/ui/views/calendar.js',
  './js/ui/views/roster.js',
  './js/ui/views/team.js',
  './js/ui/views/hours.js',
  './js/ui/views/settings.js',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-96.png',
];

/** Peticiones que jamás deben servirse desde caché. */
function isNeverCached(url) {
  return url.hostname.endsWith('supabase.co')
    || url.hostname.endsWith('supabase.in')
    || url.pathname.includes('/rest/v1/')
    || url.pathname.includes('/auth/v1/')
    || url.pathname.includes('/realtime/v1/');
}

function isStaticAsset(url) {
  return /\.(?:css|js|mjs|png|jpg|jpeg|svg|webp|ico|woff2?|ttf|json)$/i.test(url.pathname);
}

function isFont(url) {
  return url.hostname === 'fonts.googleapis.com'
    || url.hostname === 'fonts.gstatic.com';
}

/* ------------------------------------------------------------------ *
 * Instalación
 * ------------------------------------------------------------------ */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Se añaden uno a uno: si un recurso falla, el resto del precache sigue en
    // pie en vez de abortar la instalación entera.
    await Promise.all(PRECACHE.map(async (asset) => {
      try {
        await cache.add(new Request(asset, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] no se pudo precachear', asset, err);
      }
    }));
    await self.skipWaiting();
  })());
});

/* ------------------------------------------------------------------ *
 * Activación
 * ------------------------------------------------------------------ */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('horus-') && key !== CACHE && key !== RUNTIME)
      .map((key) => caches.delete(key)));
    // Habilita la navegación previa para no recargar dos veces
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------ *
 * Interceptación de peticiones
 * ------------------------------------------------------------------ */

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Solo se gestionan GET del mismo origen o de las fuentes
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (isNeverCached(url)) return;

  // 1) Navegación: red primero, con la caché como red de seguridad
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  // 2) Fuentes de Google: caché primero (son inmutables)
  if (isFont(url)) {
    event.respondWith(cacheFirst(request, RUNTIME));
    return;
  }

  // 3) Estáticos propios (JS, CSS, HTML): RED primero, caché como respaldo.
  // Se explica el porqué en `networkFirst`.
  if (url.origin === self.location.origin && isStaticAsset(url)) {
    event.respondWith(networkFirst(request, CACHE));
  }
});

/** Red primero para el HTML, con la copia guardada como respaldo. */
async function handleNavigation(event) {
  const cache = await caches.open(CACHE);

  try {
    const preload = await event.preloadResponse;
    if (preload) {
      cache.put('./index.html', preload.clone()).catch(() => {});
      return preload;
    }
    const response = await fetch(event.request);
    if (response && response.ok) {
      cache.put('./index.html', response.clone()).catch(() => {});
    }
    return response;
  } catch {
    // Sin conexión: se sirve la última copia conocida de la app
    return (await cache.match('./index.html'))
      || (await cache.match('./'))
      || new Response(
        '<!doctype html><meta charset="utf-8"><title>HORUS sin conexión</title>'
        + '<body style="font-family:system-ui;padding:2rem;text-align:center;background:#0b0d12;color:#edf0f7">'
        + '<h1>HORUS no está disponible sin conexión</h1>'
        + '<p>Abre la aplicación al menos una vez con internet para poder usarla sin conexión.</p>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
  }
}

/** Caché primero con relleno desde la red. Para lo inmutable (fuentes, iconos). */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // Solo se cachean respuestas correctas y del propio origen o de las fuentes
    if (response && response.ok && (response.type === 'basic' || response.type === 'cors')) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    // Si hay una copia antigua con otra clave, se intenta
    const fallback = await caches.match(request);
    if (fallback) return fallback;
    throw err;
  }
}

/**
 * Red primero, con la caché como red de seguridad. Para el código y los estilos
 * de la propia aplicación.
 *
 * POR QUÉ: con «caché primero» y sin paso de compilación, cambiar un `.js` sin
 * subir la versión de la caché deja al navegador sirviendo el archivo viejo
 * indefinidamente, y el síntoma es de los peores: la app arranca, se ve bien y
 * un botón «no hace nada», porque el manejador que falta está en el archivo
 * nuevo que nunca se descarga. Pasó exactamente eso.
 *
 * Yendo a la red primero, un archivo cambiado se ve en la siguiente recarga
 * (sin tocar versiones) y sin conexión se sigue sirviendo la copia guardada, que
 * es lo que pide una app local-first. El coste es que sin conexión se espera a
 * que falle la red antes de tirar de caché; a cambio, nunca se sirve código
 * viejo con código nuevo.
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response && response.ok && (response.type === 'basic' || response.type === 'cors')) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Mensajes desde la aplicación
 * ------------------------------------------------------------------ */

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  // La app pide mostrar una notificación (los avisos de turno)
  if (data.type === 'SHOW_NOTIFICATION' && data.payload) {
    const { title, body, tag, icon: iconUrl, badge, vibrate, requireInteraction, data: extra, silent } = data.payload;
    event.waitUntil((async () => {
      try {
        await self.registration.showNotification(title || 'HORUS', {
          body: body || '',
          tag: tag || 'horus',
          icon: iconUrl || 'icons/icon-192.png',
          badge: badge || 'icons/icon-96.png',
          vibrate: silent ? undefined : (vibrate || [180, 90, 180]),
          requireInteraction: !!requireInteraction,
          silent: !!silent,
          data: extra || {},
        });
      } catch (err) {
        console.error('[sw] no se pudo mostrar la notificación:', err);
      }
    })());
    return;
  }

  // La app pide activar la versión nueva
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // La app pide vaciar las cachés (al reinstalar o al reiniciar todo)
  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('horus-')).map((k) => caches.delete(k)));
      event.source?.postMessage({ type: 'CACHE_CLEARED' });
    })());
  }
});

/* ------------------------------------------------------------------ *
 * Notificaciones
 * ------------------------------------------------------------------ */

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || './';

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Si la app ya está abierta, se enfoca en lugar de abrir otra pestaña
    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'NOTIFICATION_CLICKED', data: event.notification.data || {} });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

self.addEventListener('notificationclose', () => {
  // No hace falta hacer nada: el registro de avisos ya está en la app
});

/* ------------------------------------------------------------------ *
 * Sincronización en segundo plano
 * ------------------------------------------------------------------ */

self.addEventListener('sync', (event) => {
  if (event.tag !== 'horus-sync') return;
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      client.postMessage({ type: 'BACKGROUND_SYNC' });
    }
  })());
});

