// Importar el mini-wrapper de IndexedDB en el contexto del Service Worker
importScripts('./db-helper.js');

// Definición de contenedores versionados y límites
const CACHE_STATIC_NAME = 'static-outbox-v2';
const CACHE_DYNAMIC_NAME = 'dynamic-v2';
const DYNAMIC_LIMIT = 5; // Límite máximo de elementos en caché dinámica
const TTL_MAX_SECONDS = 30; // Tiempo de vida máximo de 30 segundos para pruebas

const STATIC_FILES = [
  './',
  './index.html',
  './styles.css',
  './db-helper.js',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_STATIC_NAME).then((cache) => cache.addAll(STATIC_FILES))
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Rutas estáticas locales
    if (url.origin === location.origin && !url.pathname.includes('/api/')) {
        event.respondWith(cacheFirstEvolucionado(event.request));
        return;
    }

    // Rutas a APIs dinámicas
    if (url.hostname.includes('jsonplaceholder.typicode.com')) {
        event.respondWith(networkFirstEvolucionado(event.request));
        return;
    }
});

self.addEventListener('activate', (event) => {
    const listaBlanca = [CACHE_STATIC_NAME, CACHE_DYNAMIC_NAME];

    event.waitUntil(
        caches.keys()
            .then((nombresCaches) => {
                return Promise.all(
                    nombresCaches.map((nombreCache) => {
                        if (!listaBlanca.includes(nombreCache)) {
                            console.log('[SW] Purgando contenedor obsoleto:', nombreCache);
                            return caches.delete(nombreCache);
                        }
                    })
                );
            })
            .then(() => self.clients.claim())
    );
});

self.addEventListener('sync', (event) => {
    console.log('[SW-Sync] Evento sync disparado con etiqueta:', event.tag);

    if (event.tag === 'sync-reportes') {
        event.waitUntil(
            sincronizarPendientesSW()
                .catch((error) => {
                    console.error('[SW-Sync] Falla en sincronización; el navegador reintentará luego:', error);
                    // Relanzar el error indica al navegador que debe programar un reintento automático
                    throw error;
                })
        );
    }
});

function notificarClientesActualizacion() {
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then((clientes) => {
            clientes.forEach((cliente) => {
                cliente.postMessage({
                    tipo: 'OUTBOX_SINCRONIZADO',
                    timestamp: Date.now()
                });
            });
        });
}

function sincronizarPendientesSW() {
    console.log('[SW-Sync] Ejecutando barrido de transacciones pendientes...');

    return obtenerTodosLosRegistros()
        .then((registros) => {
            const pendientes = registros.filter((item) => item.estado === 'pendiente');

            if (pendientes.length === 0) {
                console.log('[SW-Sync] Cola limpia. Nada por sincronizar.');
                return;
            }

            const promesasDeEnvio = pendientes.map((item) => {
                return fetch('https://jsonplaceholder.typicode.com/posts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: item.titulo,
                        body: item.descripcion
                    })
                })
                    .then((respuesta) => {
                        if (!respuesta.ok) {
                            throw new Error(`Error HTTP ${respuesta.status} al sincronizar ID ${item.id}`);
                        }
                        return actualizarEstadoRegistro(item.id, 'sincronizado');
                    });
            });

            return Promise.all(promesasDeEnvio)
                .then(() => notificarClientesActualizacion());
        });
}

function limpiarCacheLimitado(nombreCache, maxElementos) {
    return caches.open(nombreCache)
        .then((cache) => {
            return cache.keys()
                .then((keys) => {
                    if (keys.length > maxElementos) {
                        return cache.delete(keys[0])
                            .then(() => limpiarCacheLimitado(nombreCache, maxElementos));
                    }
                });
        });
}

function crearRespuestaConTimestamp(respuestaOriginal) {
    // 1. Copiar las cabeceras originales de la respuesta
    const nuevasCabeceras = new Headers(respuestaOriginal.headers);

    // 2. Inyectar nuestra cabecera personalizada con la fecha/hora actual
    nuevasCabeceras.append('x-sw-timestamp', Date.now().toString());

    // 3. Leer el cuerpo de la respuesta como Blob y reconstruir el objeto Response
    return respuestaOriginal.blob()
        .then((cuerpoBlob) => {
            return new Response(cuerpoBlob, {
                status: respuestaOriginal.status,
                statusText: respuestaOriginal.statusText,
                headers: nuevasCabeceras
            });
        });
}

function esRespuestaFresca(respuesta, maxSegundos) {
    if (!respuesta) return false;

    // Extraer nuestra cabecera personalizada
    const timestampGuardado = respuesta.headers.get('x-sw-timestamp');
    if (!timestampGuardado) return false; // Si no tiene el timestamp inyectado, se considera obsoleta

    const fechaGuardada = parseInt(timestampGuardado, 10);
    const fechaActual = Date.now();
    const diferenciaSegundos = (fechaActual - fechaGuardada) / 1000;

    console.log(`[SW] Edad del recurso inyectado: ${diferenciaSegundos.toFixed(1)}s (Máximo permitido: ${maxSegundos}s)`);

    return diferenciaSegundos < maxSegundos;
}

function cacheFirstEvolucionado(request) {
    return caches.match(request)
        .then((respuestaCache) => {
            // 1. Evaluar si existe en caché y si aún está fresca según el TTL inyectado
            if (respuestaCache && esRespuestaFresca(respuestaCache, TTL_MAX_SECONDS)) {
                return respuestaCache;
            }

            console.log('[SW] Recurso no disponible o expirado. Solicitando a la red:', request.url);

            // 2. Si falló la caché o expiró, salir a la red
            return fetch(request)
                .then((respuestaRed) => {
                    // Inyectar timestamp antes de almacenar en la Cache API
                    return crearRespuestaConTimestamp(respuestaRed)
                        .then((respuestaConTimestamp) => {
                            return caches.open(CACHE_STATIC_NAME)
                                .then((cache) => {
                                    cache.put(request, respuestaConTimestamp.clone());
                                    return respuestaConTimestamp;
                                });
                        });
                })
                .catch(() => respuestaCache);
        });
}

function networkFirstEvolucionado(request) {
    return fetch(request)
        .then((respuestaRed) => {
            if (respuestaRed.status === 200) {
                // Transformar la respuesta inyectando el timestamp
                return crearRespuestaConTimestamp(respuestaRed)
                    .then((respuestaConTimestamp) => {
                        return caches.open(CACHE_DYNAMIC_NAME)
                            .then((cache) => {
                                cache.put(request, respuestaConTimestamp.clone());
                                // Aplicar restricción de tamaño en la caché dinámica
                                limpiarCacheLimitado(CACHE_DYNAMIC_NAME, DYNAMIC_LIMIT);
                                return respuestaConTimestamp;
                            });
                    });
            }
            return respuestaRed;
        })
        .catch(() => {
            console.warn('[SW] Falla de red. Verificando respaldo en caché con TTL inyectado...');

            return caches.match(request)
                .then((respuestaCache) => {
                    // Validar existencia Y frescura del timestamp inyectado
                    if (respuestaCache && esRespuestaFresca(respuestaCache, TTL_MAX_SECONDS)) {
                        return respuestaCache;
                    }

                    // Fallback si no hay red y los datos cacheados expiraron
                    return new Response(
                        JSON.stringify({
                            error: true,
                            mensaje: "La conexión falló y los datos locales han expirado o no existen."
                        }),
                        { status: 400, headers: { 'Content-Type': 'application/json' } }
                    );
                });
        });
}