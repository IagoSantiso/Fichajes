/**
 * Cola de fichajes sin conexión.
 *
 * Si no hay cobertura, el fichaje se guarda en IndexedDB, se muestra como
 * pendiente de sincronizar y se envía en cuanto vuelve la red, marcado como
 * diferido. En una nave con paredes de hormigón esto no es un caso raro: es
 * el caso de todos los días.
 *
 * La hora que se guarda es la del dispositivo, y se envía como
 * `timestamp_declarado`. El servidor no se fía de ella: pone su propio sello y
 * conserva las dos marcas. Esa es la razón de que la cola pueda existir sin
 * romper la integridad del registro.
 */

const BASE = 'fichajes-offline';
const ALMACEN = 'pendientes';

function abrir() {
  return new Promise((resolver, rechazar) => {
    const peticion = indexedDB.open(BASE, 1);
    peticion.onupgradeneeded = () => {
      const db = peticion.result;
      if (!db.objectStoreNames.contains(ALMACEN)) {
        db.createObjectStore(ALMACEN, { keyPath: 'idempotencia' });
      }
    };
    peticion.onsuccess = () => resolver(peticion.result);
    peticion.onerror = () => rechazar(peticion.error);
  });
}

async function transaccion(modo, operacion) {
  const db = await abrir();
  return new Promise((resolver, rechazar) => {
    const tx = db.transaction(ALMACEN, modo);
    const resultado = operacion(tx.objectStore(ALMACEN));
    tx.oncomplete = () => resolver(resultado?.result ?? resultado);
    tx.onerror = () => rechazar(tx.error);
  });
}

export async function encolar(fichaje) {
  const entrada = {
    idempotencia: crypto.randomUUID(),
    tipo: fichaje.tipo,
    timestamp_declarado: new Date().toISOString(),
    latitud: fichaje.latitud ?? null,
    longitud: fichaje.longitud ?? null,
    intentos: 0,
  };
  await transaccion('readwrite', (almacen) => almacen.put(entrada));
  return entrada;
}

export async function pendientes() {
  return transaccion('readonly', (almacen) => almacen.getAll());
}

export async function descartar(idempotencia) {
  return transaccion('readwrite', (almacen) => almacen.delete(idempotencia));
}

async function anotarIntento(entrada) {
  entrada.intentos += 1;
  entrada.ultimo_intento = new Date().toISOString();
  await transaccion('readwrite', (almacen) => almacen.put(entrada));
}

/**
 * Intenta enviar todo lo pendiente, en el orden en que se registró.
 *
 * Un fichaje que el servidor rechaza por reglas de negocio (una salida sin
 * entrada, por ejemplo) se descarta de la cola en lugar de reintentarse para
 * siempre: se queda en el registro como incidencia y la empresa lo corrige.
 * Reintentar en bucle un fichaje imposible sólo consigue que la cola no vacíe
 * nunca y que el trabajador vea «pendiente» eternamente.
 */
export async function sincronizar({ silencioso = false } = {}) {
  const cola = (await pendientes()).sort(
    (a, b) => a.timestamp_declarado.localeCompare(b.timestamp_declarado),
  );
  const resultado = { enviados: 0, descartados: 0, pendientes: 0 };

  for (const entrada of cola) {
    try {
      const respuesta = await fetch('/api/fichajes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          tipo: entrada.tipo,
          timestamp_declarado: entrada.timestamp_declarado,
          idempotencia: entrada.idempotencia,
          latitud: entrada.latitud,
          longitud: entrada.longitud,
        }),
      });

      if (respuesta.ok) {
        await descartar(entrada.idempotencia);
        resultado.enviados += 1;
        continue;
      }

      // 4xx que no sea de sesión: el fichaje no va a entrar nunca.
      if (respuesta.status >= 400 && respuesta.status < 500 && respuesta.status !== 401) {
        await descartar(entrada.idempotencia);
        resultado.descartados += 1;
        continue;
      }

      await anotarIntento(entrada);
      resultado.pendientes += 1;
    } catch {
      // Sigue sin haber red. Se deja en la cola tal cual.
      await anotarIntento(entrada);
      resultado.pendientes += 1;
    }
  }

  if (!silencioso && resultado.enviados) {
    window.dispatchEvent(new CustomEvent('cola-sincronizada', { detail: resultado }));
  }
  return resultado;
}
