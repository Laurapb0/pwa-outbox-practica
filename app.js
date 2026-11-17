if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js');

    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
            console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
            renderizarColaOutbox();
        }
    });
}

function procesarEnvioReporte(datosFormulario) {
    const endpoint = 'https://jsonplaceholder.typicode.com/posts';

    return fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(datosFormulario)
    })
        .then((respuesta) => {
            if (!respuesta.ok) throw new Error('Error HTTP del servidor');
            return respuesta.json();
        })
        .then(() => {
            // Envío exitoso en vivo: registrar en bitácora local como sincronizado
            return guardarRegistro({
                ...datosFormulario,
                estado: 'sincronizado',
                fechaCreacion: Date.now()
            });
        })
        .catch(() => {
            console.warn('[Outbox] Sin conexión. Encolando en IndexedDB...');

            return guardarRegistro({
                ...datosFormulario,
                estado: 'pendiente',
                fechaCreacion: Date.now()
            })
                .then(() => {
                    // Detección de soporte para Background Sync API
                    if ('serviceWorker' in navigator && 'SyncManager' in window) {
                        return navigator.serviceWorker.ready
                            .then((registro) => {
                                console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
                                return registro.sync.register('sync-reportes');
                            });
                    }
                });
        })
        .then(() => {
            // Actualizar la lista visual en ambos escenarios
            return renderizarColaOutbox();
        });
}

function sincronizarPendientes() {
    console.log('[Outbox] Conexión detectada. Buscando registros pendientes...');

    return obtenerTodosLosRegistros()
        .then((registros) => {
            const pendientes = registros.filter((item) => item.estado === 'pendiente');

            if (pendientes.length === 0) {
                console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
                return;
            }

            // Convertir cada registro pendiente en una promesa de envío + actualización
            const promesasDeEnvio = pendientes.map((item) => {
                return fetch('https://jsonplaceholder.typicode.com/posts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: item.titulo, body: item.descripcion })
                })
                    .then((res) => {
                        if (!res.ok) throw new Error('Falla al reintentar envío');
                        // Actualizar estado en IndexedDB de 'pendiente' a 'sincronizado'
                        return actualizarEstadoRegistro(item.id, 'sincronizado');
                    });
            });

            // Esperar a que todos los reenvíos concluyan
            return Promise.all(promesasDeEnvio);
        })
        .then(() => {
            return renderizarColaOutbox();
        })
        .catch((error) => {
            console.error('[Outbox] Error durante la sincronización masiva:', error);
        });
}

function renderizarColaOutbox() {
    console.log('[Outbox] Renderizando registros ...');

    return obtenerTodosLosRegistros()
        .then((registros) => {
            const listaBandeja = document.getElementById('lista-outbox');
            listaBandeja.innerHTML = '';

            registros.forEach((reporte) => {
                const fila = document.createElement('li');
                const horaTexto = new Date(reporte.fechaCreacion).toLocaleTimeString();
                fila.textContent = reporte.titulo + ' (' + reporte.estado + ') a las ' + horaTexto;
                listaBandeja.appendChild(fila);
            });
        })
        .catch((error) => {
            console.error('[Outbox] Error al renderizar los registros:', error);
        });
}

const formularioReporte = document.getElementById('form-incidencia');
const botonPurgar = document.getElementById('btn-purgar');

formularioReporte.addEventListener('submit', (evento) => {
    evento.preventDefault();
    const tituloReporte = document.getElementById('titulo').value;
    const detalleReporte = document.getElementById('descripcion').value;

    procesarEnvioReporte({ titulo: tituloReporte, descripcion: detalleReporte });

    formularioReporte.reset();
});

botonPurgar.addEventListener('click', () => {
    obtenerTodosLosRegistros()
        .then((registros) => {
            const yaEnviados = registros.filter((reporte) => reporte.estado === 'sincronizado');

            if (yaEnviados.length === 0) {
                console.log('[Outbox] No hay reportes enviados para borrar.');
                return;
            }

            const borrados = yaEnviados.map((reporte) => eliminarRegistro(reporte.id));

            return Promise.all(borrados);
        })
        .then(() => {
            return renderizarColaOutbox();
        })
        .catch((error) => {
            console.error('[Outbox] Error al purgar los registros:', error);
        });
});

function actualizarIndicadorRed() {
    const etiquetaRed = document.getElementById('badge-red');
    if (navigator.onLine) {
        etiquetaRed.textContent = 'En Línea';
        etiquetaRed.className = 'badge online';
    } else {
        etiquetaRed.textContent = 'Sin Conexión';
        etiquetaRed.className = 'badge offline';
    }
}

actualizarIndicadorRed();
renderizarColaOutbox();

// Escuchar el regreso de la conectividad
window.addEventListener('online', () => {
    actualizarIndicadorRed();

    // Degradación elegante: Solo sincronizar desde UI si el navegador NO soporta Background Sync (ej. Safari/iOS)
    if (!('SyncManager' in window)) {
        console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
        sincronizarPendientes();
    }
});

window.addEventListener('offline', actualizarIndicadorRed);
