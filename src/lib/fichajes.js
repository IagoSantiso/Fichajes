/**
 * Registro de fichajes.
 *
 * Decisión no negociable número 1: esta tabla es append-only. En este módulo
 * no hay UPDATE ni DELETE sobre `fichajes`, y no debe haberlos en ninguna otra
 * ruta del código. Corregir es insertar una rectificación que referencia al
 * original; anular es insertar una anulación. El original permanece siempre
 * visible en la traza.
 *
 * Decisión no negociable número 3: el sello temporal lo pone el servidor, en
 * UTC. Si el fichaje llega diferido desde la cola offline se guardan las dos
 * marcas y el registro queda marcado como diferido.
 */
import { nuevoId } from './ids.js';
import { calcularHash, verificarCadena, HASH_GENESIS } from './hash.js';
import { ahoraUtc, fechaLocal, minutosEntre } from './tiempo.js';
import { malaPeticion, conflicto, noEncontrado } from './respuestas.js';

export const TIPOS = ['entrada', 'salida', 'inicio_pausa', 'fin_pausa'];

/** Reintentos ante colisión de dos fichajes simultáneos en la misma empresa. */
const REINTENTOS_CADENA = 5;

/**
 * Inserta un fichaje enlazándolo a la cadena de su empresa.
 *
 * La serialización de la cadena la garantiza el índice único
 * (empresa_id, hash_anterior): si dos peticiones leen el mismo último hash,
 * sólo una puede insertar y la otra reintenta con el hash ya actualizado.
 */
async function insertarEnCadena(env, empresaId, campos) {
  let ultimoError;
  for (let intento = 0; intento < REINTENTOS_CADENA; intento++) {
    const ultimo = await env.DB.prepare(
      `SELECT hash FROM fichajes WHERE empresa_id = ? ORDER BY rowid DESC LIMIT 1`,
    ).bind(empresaId).first();
    const hashAnterior = ultimo?.hash ?? HASH_GENESIS;

    const fichaje = { ...campos, empresa_id: empresaId, hash_anterior: hashAnterior };
    fichaje.hash = await calcularHash(fichaje, hashAnterior);

    const columnas = Object.keys(fichaje);
    try {
      await env.DB.prepare(
        `INSERT INTO fichajes (${columnas.join(',')})
         VALUES (${columnas.map(() => '?').join(',')})`,
      ).bind(...columnas.map((c) => fichaje[c] ?? null)).run();
      return fichaje;
    } catch (error) {
      const mensaje = String(error?.message ?? error);
      if (!/UNIQUE constraint failed: fichajes\.empresa_id/.test(mensaje)) throw error;
      ultimoError = error;
      // Otro fichaje ganó la carrera: se reintenta con el nuevo extremo.
      await new Promise((r) => setTimeout(r, 15 * (intento + 1)));
    }
  }
  throw conflicto(
    'No se ha podido cerrar la cadena de integridad; reintente el fichaje',
    'cadena_ocupada',
  );
}

/**
 * Registra un fichaje nuevo.
 *
 * @param opciones.timestampDeclarado  Lo que dice el cliente. Sólo se guarda,
 *   nunca se usa como sello. Si viene y difiere del de servidor, el registro
 *   se marca como diferido.
 */
export async function registrarFichaje(env, empresa, {
  empleadoId,
  tipo,
  origen = 'pwa',
  timestampDeclarado = null,
  ip = null,
  userAgent = null,
  latitud = null,
  longitud = null,
  autorId,
  autorTipo,
  motivo = null,
}) {
  if (!TIPOS.includes(tipo)) throw malaPeticion(`Tipo de fichaje no válido: ${tipo}`);

  const timestampUtc = ahoraUtc();
  // Se considera diferido si el cliente declara una hora anterior en más de
  // un minuto: es un fichaje que estuvo esperando en la cola offline.
  const diferido = Boolean(
    timestampDeclarado && Math.abs(minutosEntre(timestampDeclarado, timestampUtc)) >= 1,
  );

  // Geolocalización: sólo si la empresa la tiene activada. Si no, se descarta
  // aunque el cliente la mande.
  const geo = empresa.geolocalizacion_activa ? { latitud, longitud } : { latitud: null, longitud: null };

  // La fecha local del fichaje es la del instante que hace fe. En un diferido
  // eso es la hora declarada: un fichaje de las 22:00 sincronizado a las 00:10
  // pertenece al día 22:00, no al siguiente.
  const instanteEfectivo = diferido ? timestampDeclarado : timestampUtc;

  return insertarEnCadena(env, empresa.id, {
    id: nuevoId('fic'),
    empleado_id: empleadoId,
    tipo,
    timestamp_utc: timestampUtc,
    zona_horaria: empresa.zona_horaria,
    fecha_local: fechaLocal(instanteEfectivo, empresa.zona_horaria),
    timestamp_declarado: diferido ? timestampDeclarado : null,
    diferido: diferido ? 1 : 0,
    origen,
    ip,
    user_agent: userAgent,
    latitud: geo.latitud,
    longitud: geo.longitud,
    // Campos del borrador del RD: existen, se dejan vacíos.
    tipo_evento: null,
    modalidad: null,
    naturaleza_hora: null,
    autor_id: autorId,
    autor_tipo: autorTipo,
    tipo_registro: 'original',
    fichaje_referenciado_id: null,
    motivo,
  });
}

/**
 * Rectifica un fichaje existente. No lo toca: inserta uno nuevo de tipo
 * rectificación que lo referencia y guarda autor, motivo y momento del cambio.
 *
 * @param opciones.timestampUtcCorregido  Instante corregido, ya en UTC.
 */
export async function registrarRectificacion(env, empresa, {
  fichajeId,
  tipoCorregido = null,
  timestampUtcCorregido = null,
  motivo,
  autorId,
  autorTipo,
  ip = null,
}) {
  if (!motivo || !motivo.trim()) throw malaPeticion('La corrección exige un motivo');

  const original = await env.DB.prepare(
    `SELECT * FROM fichajes WHERE id = ? AND empresa_id = ?`,
  ).bind(fichajeId, empresa.id).first();
  if (!original) throw noEncontrado('El fichaje que se quiere corregir no existe');

  const yaCorregido = await env.DB.prepare(
    `SELECT id FROM fichajes WHERE fichaje_referenciado_id = ? AND empresa_id = ?`,
  ).bind(fichajeId, empresa.id).first();
  if (yaCorregido) {
    throw conflicto('Ese fichaje ya tiene una corrección posterior; corrija la última');
  }

  const tipo = tipoCorregido ?? original.tipo;
  if (!TIPOS.includes(tipo)) throw malaPeticion(`Tipo de fichaje no válido: ${tipo}`);
  const instante = timestampUtcCorregido ?? original.timestamp_utc;

  return insertarEnCadena(env, empresa.id, {
    id: nuevoId('fic'),
    empleado_id: original.empleado_id,
    tipo,
    // El sello es el instante corregido, que es el que hace fe a efectos de
    // jornada. Cuándo se hizo la corrección queda en `motivo` y en el log.
    timestamp_utc: instante,
    zona_horaria: empresa.zona_horaria,
    fecha_local: fechaLocal(instante, empresa.zona_horaria),
    timestamp_declarado: null,
    diferido: 0,
    origen: 'panel',
    ip,
    user_agent: null,
    latitud: null,
    longitud: null,
    tipo_evento: null,
    modalidad: null,
    naturaleza_hora: null,
    autor_id: autorId,
    autor_tipo: autorTipo,
    tipo_registro: 'rectificacion',
    fichaje_referenciado_id: fichajeId,
    motivo: motivo.trim(),
  });
}

/** Anula un fichaje: mismo mecanismo, pero el registro deja de contar. */
export async function registrarAnulacion(env, empresa, {
  fichajeId, motivo, autorId, autorTipo, ip = null,
}) {
  if (!motivo || !motivo.trim()) throw malaPeticion('La anulación exige un motivo');

  const original = await env.DB.prepare(
    `SELECT * FROM fichajes WHERE id = ? AND empresa_id = ?`,
  ).bind(fichajeId, empresa.id).first();
  if (!original) throw noEncontrado('El fichaje que se quiere anular no existe');

  return insertarEnCadena(env, empresa.id, {
    id: nuevoId('fic'),
    empleado_id: original.empleado_id,
    tipo: original.tipo,
    timestamp_utc: original.timestamp_utc,
    zona_horaria: empresa.zona_horaria,
    fecha_local: original.fecha_local,
    timestamp_declarado: null,
    diferido: 0,
    origen: 'panel',
    ip,
    user_agent: null,
    latitud: null,
    longitud: null,
    tipo_evento: null,
    modalidad: null,
    naturaleza_hora: null,
    autor_id: autorId,
    autor_tipo: autorTipo,
    tipo_registro: 'anulacion',
    fichaje_referenciado_id: fichajeId,
    motivo: motivo.trim(),
  });
}

/**
 * Da de alta un fichaje que nunca llegó a registrarse (el trabajador se olvidó
 * y lo pide después). Es un alta, no una rectificación: no hay original al que
 * referenciar. Exige motivo y queda con origen 'panel'.
 */
export async function registrarAltaManual(env, empresa, {
  empleadoId, tipo, timestampUtc, motivo, autorId, autorTipo, ip = null,
}) {
  if (!motivo || !motivo.trim()) throw malaPeticion('El alta manual exige un motivo');
  if (!TIPOS.includes(tipo)) throw malaPeticion(`Tipo de fichaje no válido: ${tipo}`);

  return insertarEnCadena(env, empresa.id, {
    id: nuevoId('fic'),
    empleado_id: empleadoId,
    tipo,
    timestamp_utc: timestampUtc,
    zona_horaria: empresa.zona_horaria,
    fecha_local: fechaLocal(timestampUtc, empresa.zona_horaria),
    timestamp_declarado: null,
    diferido: 0,
    origen: 'panel',
    ip,
    user_agent: null,
    latitud: null,
    longitud: null,
    tipo_evento: null,
    modalidad: null,
    naturaleza_hora: null,
    autor_id: autorId,
    autor_tipo: autorTipo,
    tipo_registro: 'original',
    fichaje_referenciado_id: null,
    motivo: motivo.trim(),
  });
}

/**
 * Deja los fichajes que cuentan a efectos de jornada: quita los que han sido
 * rectificados o anulados, y quita las propias anulaciones. Las
 * rectificaciones ocupan el lugar del registro al que sustituyen.
 *
 * Los originales no desaparecen de la base de datos ni de la traza: esto es
 * sólo la vista de cálculo.
 */
export function fichajesEfectivos(filas) {
  const sustituidos = new Set(
    filas.filter((f) => f.fichaje_referenciado_id).map((f) => f.fichaje_referenciado_id),
  );
  return filas
    .filter((f) => f.tipo_registro !== 'anulacion' && !sustituidos.has(f.id))
    .sort((a, b) => a.timestamp_utc.localeCompare(b.timestamp_utc));
}

/**
 * Estado del trabajador ahora mismo, que es lo que decide qué pone el botón
 * grande de la PWA. Se deduce de sus fichajes efectivos del día.
 */
export function estadoActual(fichajesDelDia) {
  const efectivos = fichajesEfectivos(fichajesDelDia);
  let estado = 'fuera';
  for (const f of efectivos) {
    if (f.tipo === 'entrada') estado = 'dentro';
    else if (f.tipo === 'salida') estado = 'fuera';
    else if (f.tipo === 'inicio_pausa' && estado === 'dentro') estado = 'en_pausa';
    else if (f.tipo === 'fin_pausa' && estado === 'en_pausa') estado = 'dentro';
  }
  return estado;
}

/** Acciones ofrecidas en cada estado. La primera es la del botón grande. */
export function accionesDisponibles(estado) {
  switch (estado) {
    case 'fuera': return [{ tipo: 'entrada', texto: 'Fichar entrada' }];
    case 'dentro': return [
      { tipo: 'salida', texto: 'Fichar salida' },
      { tipo: 'inicio_pausa', texto: 'Iniciar pausa' },
    ];
    case 'en_pausa': return [{ tipo: 'fin_pausa', texto: 'Terminar pausa' }];
    default: return [];
  }
}

/**
 * Comprueba que la transición tiene sentido antes de insertar. No bloquea
 * nada raro que el trabajador quiera registrar de verdad: sólo impide el
 * doble toque accidental sobre el mismo botón.
 */
export function transicionValida(estado, tipo) {
  return accionesDisponibles(estado).some((a) => a.tipo === tipo);
}

/**
 * Minutos trabajados en un día a partir de sus fichajes efectivos.
 * Las pausas se descuentan. Una jornada sin salida no suma nada y genera
 * incidencia: el motor no inventa una hora de cierre.
 */
export function minutosTrabajados(fichajesDelDia) {
  const efectivos = fichajesEfectivos(fichajesDelDia);
  let total = 0;
  let entrada = null;
  let pausa = null;
  for (const f of efectivos) {
    if (f.tipo === 'entrada' && !entrada) entrada = f.timestamp_utc;
    else if (f.tipo === 'inicio_pausa' && entrada && !pausa) pausa = f.timestamp_utc;
    else if (f.tipo === 'fin_pausa' && pausa) {
      total -= minutosEntre(pausa, f.timestamp_utc);
      pausa = null;
    } else if (f.tipo === 'salida' && entrada) {
      total += minutosEntre(entrada, f.timestamp_utc);
      if (pausa) {
        // Pausa abierta al cerrar la jornada: se descuenta hasta la salida.
        total -= minutosEntre(pausa, f.timestamp_utc);
        pausa = null;
      }
      entrada = null;
    }
  }
  return Math.max(0, total);
}

/**
 * Verifica la cadena de una empresa. Invocable bajo demanda desde el panel de
 * gestoría y desde la exportación.
 */
export async function verificarCadenaEmpresa(env, empresaId) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM fichajes WHERE empresa_id = ? ORDER BY rowid ASC`,
  ).bind(empresaId).all();
  return verificarCadena(results ?? []);
}
