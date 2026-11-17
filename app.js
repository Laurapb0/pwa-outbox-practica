if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register("./sw.js");
    console.log("El service Woker está disponible");
} else {
    console.log("El service Woker no está disponible")
}

const nuevaOrden = {
    cliente: 'Empresa Logística SA',
    monto: 14500,
    fecha: Date.now()
};

guardarRegistro(nuevaOrden)
    .then((idAsignado) => {
        console.log('Registro encolado localmente con ID:', idAsignado);
        return obtenerTodosLosRegistros();
    })
    .then((listaCompleta) => {
        console.table(listaCompleta);
    })
    .catch((error) => {
        console.error('Falla en operación de IndexedDB:', error);
    });