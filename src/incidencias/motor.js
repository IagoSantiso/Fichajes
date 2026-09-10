/**
 * Motor de incidencias.
 *
 * Dos familias con coste muy distinto:
 *  - Estructurales: salen solo de los fichajes, sin configuración.
 *  - De expectativa: requieren horario teórico y calendario.
 *
 * Y dos reglas que deciden si el módulo se usa o se silencia:
 *  1. Ventana de tolerancia configurable por empresa. Una alerta que salta
 *     porque alguien llega tres minutos tarde se ignora en una semana y
 *     arrastra consigo a todas las demás.
 *  2. No se genera ninguna incidencia de expectativa si ese día hay ausencia
 *     aprobada, es festivo del calendario de la empresa, o el trabajador está
 *     de baja o dado de baja.
 *
 * La generación es idempotente por (empleado, fecha, tipo): el índice único de
 * la tabla lo garantiza y aquí se inserta con OR IGNORE. El cron puede correr
 * mil veces sin duplicar nada ni reenviar avisos.
 */
import { nuevoId } from '../lib/ids.js';
import {
  ahoraUtc, fechaLocal, horaLocal, minutosEntre, minutosDeHora, diaSemanaIso,
} from '../lib/tiempo.js';
import { fichajesEfectivos } from '../lib/fichajes.js';

export const TIPOS_ESTRUCTURALES = [
  'salida_sin_entrada',
  'jornada_no_cerrada',
  'pausa_no_cerrada',
  'jornada_excesiva',
  'fichaje_duplicado',
];

export const TIPOS_EXPECTATIVA = [
  'falta_entrada',
  'salida_anticipada',
  'exceso_jornada_diaria',
  'exceso_jornada_mensual',
];

export const DESCRIPCIONES = {
  salida_sin_entrada: 'Salida sin entrada previa registrada ese día',
  jornada_no_cerrada: 'Jornada sin fichaje de salida',
  pausa_no_cerrada: 'Pausa iniciada y no cerrada',
  jornada_excesiva: 'Jornada por encima del umbral de la empresa',
  fichaje_duplicado: 'Fichaje del mismo tipo repetido en menos de dos minutos',
  falta_entrada: 'Sin fichaje de entrada pasada la ventana de tolerancia',
  salida_anticipada: 'Salida antes de la hora prevista',
  exceso_jornada_diaria: 'Exceso sobre la jornada teórica del día',
  exceso_jornada_mensual: 'Exceso acumulado sobre la jornada teórica del mes',
};

const MINUTOS_DUPLICADO = 2;
/** Margen antes de considerar excesivo un día; evita ruido por minutos sueltos. */
const MARGEN_EXCESO_DIARIO_MIN = 30;
const MARGEN_EXCESO_MENSUAL_MIN = 240;

// --- Detección ------------------------------------------------------------

/**
 * Incidencias estructurales de un empleado en un día. Sólo miran los fichajes.
 * `jornadaCerrada` distingue el cierre diario (donde una jornada sin salida ya
 * es una incidencia) de la pasada del día en curso (donde aún puede cerrarse).
 */
export function detectarEstructurales(fichajesDelDia, empresa, { jornadaCerrada }) {
  const encontradas = [];
  const efectivos = fichajesEfectivos(fichajesDelDia);
  if (!efectivos.length) return encontradas;

  const zona = empresa.zona_horaria;
  let estado = 'fuera';
  let entrada = null;
  let pausa = null;
  let trabajados = 0;

  for (let i = 0; i < efectivos.length; i++) {
    const f = efectivos[i];
    const previo = efectivos[i - 1];

    if (previo && previo.tipo === f.tipo
        && minutosEntre(previo.timestamp_utc, f.timestamp_utc) < MINUTOS_DUPLICADO) {
      encontradas.push({
        tipo: 'fichaje_duplicado',
        detalle: `Dos «${f.tipo}» a las ${horaLocal(previo.timestamp_utc, zona)} y ${horaLocal(f.timestamp_utc, zona)}`,
      });
    }

    switch (f.tipo) {
      case 'entrada':
        estado = 'dentro';
        entrada = f.timestamp_utc;
        break;
      case 'salida':
        if (estado === 'fuera') {
          encontradas.push({
            tipo: 'salida_sin_entrada',
            detalle: `Salida a las ${horaLocal(f.timestamp_utc, zona)} sin entrada previa`,
          });
        } else {
          trabajados += minutosEntre(entrada, f.timestamp_utc);
          if (pausa) { trabajados -= minutosEntre(pausa, f.timestamp_utc); pausa = null; }
        }
        estado = 'fuera';
        entrada = null;
        break;
      case 'inicio_pausa':
        if (estado === 'dentro') { estado = 'en_pausa'; pausa = f.timestamp_utc; }
        break;
      case 'fin_pausa':
        if (estado === 'en_pausa') {
          trabajados -= minutosEntre(pausa, f.timestamp_utc);
          estado = 'dentro';
          pausa = null;
        }
        break;
    }
  }

  if (jornadaCerrada) {
    if (estado === 'dentro') {
      encontradas.push({
        tipo: 'jornada_no_cerrada',
        detalle: `Entrada a las ${horaLocal(entrada, zona)} sin salida`,
      });
    }
    if (estado === 'en_pausa') {
      encontradas.push({
        tipo: 'pausa_no_cerrada',
        detalle: `Pausa iniciada a las ${horaLocal(pausa, zona)} sin cerrar`,
      });
    }
  }

  const umbral = (empresa.jornada_maxima_alerta_horas ?? 12) * 60;
  if (trabajados > umbral) {
    encontradas.push({
      tipo: 'jornada_excesiva',
      detalle: `${formatoHoras(trabajados)} registradas, por encima del umbral de ${empresa.jornada_maxima_alerta_horas} h`,
    });
  }

  return encontradas;
}

/**
 * Incidencias de expectativa. Requieren horario teórico y calendario, y la
 * regla 2 (supresión) se aplica *antes* de mirar nada: si el día está cubierto
 * por ausencia, festivo o baja, no hay expectativa que incumplir.
 */
export function detectarExpectativa(fichajesDelDia, empresa, {
  fecha, horarioDelDia, cubierto, jornadaCerrada, ahora,
}) {
  if (cubierto || !horarioDelDia) return [];

  const encontradas = [];
  const zona = empresa.zona_horaria;
  const tolerancia = empresa.tolerancia_minutos ?? 20;
  const efectivos = fichajesEfectivos(fichajesDelDia);
  const entrada = efectivos.find((f) => f.tipo === 'entrada');
  const salida = [...efectivos].reverse().find((f) => f.tipo === 'salida');

  const minutosAhora = minutosDeHora(horaLocal(ahora, zona));
  const mismoDia = fechaLocal(ahora, zona) === fecha;
  const previstaEntrada = minutosDeHora(horarioDelDia.hora_entrada);
  const previstaSalida = minutosDeHora(horarioDelDia.hora_salida);

  // Regla 1: la tolerancia se aplica aquí y sólo aquí. No se avisa hasta que
  // ha pasado de verdad la ventana.
  if (!entrada) {
    const yaVencio = !mismoDia || minutosAhora > previstaEntrada + tolerancia;
    if (yaVencio) {
      encontradas.push({
        tipo: 'falta_entrada',
        detalle: `Sin entrada; estaba prevista a las ${horarioDelDia.hora_entrada} (tolerancia ${tolerancia} min)`,
      });
    }
  }

  if (salida) {
    const minutosSalida = minutosDeHora(horaLocal(salida.timestamp_utc, zona));
    if (minutosSalida < previstaSalida - tolerancia) {
      encontradas.push({
        tipo: 'salida_anticipada',
        detalle: `Salida a las ${horaLocal(salida.timestamp_utc, zona)}; estaba prevista a las ${horarioDelDia.hora_salida}`,
      });
    }
  }

  if (jornadaCerrada) {
    const teoricos = previstaSalida - previstaEntrada;
    const reales = minutosTrabajadosDe(efectivos);
    if (reales > teoricos + Math.max(tolerancia, MARGEN_EXCESO_DIARIO_MIN)) {
      encontradas.push({
        tipo: 'exceso_jornada_diaria',
        // Nunca «horas extra»: la calificación la hace la gestoría.
        detalle: `${formatoHoras(reales - teoricos)} de exceso sobre la jornada teórica`,
      });
    }
  }

  return encontradas;
}

function minutosTrabajadosDe(efectivos) {
  let total = 0;
  let entrada = null;
  let pausa = null;
  for (const f of efectivos) {
    if (f.tipo === 'entrada' && !entrada) entrada = f.timestamp_utc;
    else if (f.tipo === 'inicio_pausa' && entrada && !pausa) pausa = f.timestamp_utc;
    else if (f.tipo === 'fin_pausa' && pausa) { total -= minutosEntre(pausa, f.timestamp_utc); pausa = null; }
    else if (f.tipo === 'salida' && entrada) {
      total += minutosEntre(entrada, f.timestamp_utc);
      if (pausa) { total -= minutosEntre(pausa, f.timestamp_utc); pausa = null; }
      entrada = null;
    }
  }
  return Math.max(0, total);
}

export function formatoHoras(minutos) {
  const signo = minutos < 0 ? '-' : '';
  const m = Math.abs(Math.round(minutos));
  return `${signo}${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// --- Ejecución ------------------------------------------------------------

/**
 * Pasa el motor sobre una empresa y una fecha local.
 *
 * @param opciones.jornadaCerrada  true en el cierre diario, false en la pasada
 *   del día en curso. Cambia qué incidencias tiene sentido levantar.
 */
export async function ejecutarParaEmpresa(env, empresa, fecha, { jornadaCerrada }) {
  const ahora = ahoraUtc();
  const nuevas = [];

  const { results: empleados } = await env.DB.prepare(
    `SELECT * FROM empleados
      WHERE empresa_id = ? AND activo = 1
        AND fecha_alta <= ? AND (fecha_baja IS NULL OR fecha_baja >= ?)`,
  ).bind(empresa.id, fecha, fecha).all();
  if (!empleados?.length) return { empresa: empresa.id, fecha, nuevas: [] };

  const { results: fichajes } = await env.DB.prepare(
    `SELECT * FROM fichajes WHERE empresa_id = ? AND fecha_local = ? ORDER BY timestamp_utc ASC`,
  ).bind(empresa.id, fecha).all();

  const festivo = await env.DB.prepare(
    `SELECT tipo FROM calendario_laboral WHERE empresa_id = ? AND fecha = ?`,
  ).bind(empresa.id, fecha).first();

  const { results: ausencias } = await env.DB.prepare(
    `SELECT empleado_id, tipo FROM ausencias
      WHERE empresa_id = ? AND estado = 'aprobada' AND fecha_inicio <= ? AND fecha_fin >= ?`,
  ).bind(empresa.id, fecha, fecha).all();
  const conAusencia = new Set((ausencias ?? []).map((a) => a.empleado_id));

  const diaSemana = diaSemanaIso(fecha);
  const { results: horarios } = await env.DB.prepare(
    `SELECT * FROM horarios_teoricos
      WHERE empresa_id = ? AND dia_semana = ?
        AND vigente_desde <= ? AND (vigente_hasta IS NULL OR vigente_hasta >= ?)`,
  ).bind(empresa.id, diaSemana, fecha, fecha).all();

  for (const empleado of empleados) {
    const suyos = (fichajes ?? []).filter((f) => f.empleado_id === empleado.id);

    const estructurales = detectarEstructurales(suyos, empresa, { jornadaCerrada });

    // Regla 2: ausencia aprobada, festivo o baja suprimen la expectativa.
    const cubierto = Boolean(festivo) || conAusencia.has(empleado.id);
    const expectativa = detectarExpectativa(suyos, empresa, {
      fecha,
      horarioDelDia: (horarios ?? []).find((h) => h.empleado_id === empleado.id) ?? null,
      cubierto,
      jornadaCerrada,
      ahora,
    });

    for (const inc of [...estructurales, ...expectativa]) {
      const insertada = await guardarIncidencia(env, {
        empresaId: empresa.id,
        empleadoId: empleado.id,
        fecha,
        tipo: inc.tipo,
        detalle: inc.detalle,
      });
      if (insertada) {
        nuevas.push({
          ...inc,
          empleado_id: empleado.id,
          empleado: `${empleado.nombre} ${empleado.apellidos}`.trim(),
          fecha,
          descripcion: `${DESCRIPCIONES[inc.tipo]}${inc.detalle ? `. ${inc.detalle}` : ''}`,
        });
      }
    }
  }

  return { empresa: empresa.id, fecha, nuevas };
}

/**
 * Inserta si no existía. Devuelve true sólo cuando es nueva, que es lo que
 * decide si se avisa: una incidencia que ya se comunicó no se reenvía, y una
 * que el empresario marcó como ignorada no vuelve.
 */
async function guardarIncidencia(env, { empresaId, empleadoId, fecha, tipo, detalle }) {
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO incidencias
       (id, empresa_id, empleado_id, fecha, tipo, detalle, estado, detectada_en)
     VALUES (?,?,?,?,?,?,'abierta',?)`,
  ).bind(nuevoId('inc'), empresaId, empleadoId, fecha, tipo, detalle ?? null, ahoraUtc()).run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * Exceso acumulado sobre la jornada teórica del mes.
 *
 * Se ancla al día 1 del mes a propósito: el índice único es
 * (empleado, fecha, tipo), así que anclarlo al primer día hace que la
 * incidencia se levante una sola vez por mes en lugar de repetirse cada día
 * desde que se cruza el umbral. Es la diferencia entre un aviso útil y un
 * aviso que se silencia.
 */
export async function ejecutarExcesoMensual(env, empresa, fecha) {
  const mes = fecha.slice(0, 7);
  const ancla = `${mes}-01`;
  const nuevas = [];

  const { results: empleados } = await env.DB.prepare(
    `SELECT * FROM empleados WHERE empresa_id = ? AND activo = 1`,
  ).bind(empresa.id).all();

  for (const empleado of empleados ?? []) {
    const { results: fichajes } = await env.DB.prepare(
      `SELECT * FROM fichajes
        WHERE empresa_id = ? AND empleado_id = ? AND fecha_local BETWEEN ? AND ?
        ORDER BY timestamp_utc ASC`,
    ).bind(empresa.id, empleado.id, ancla, fecha).all();
    if (!fichajes?.length) continue;

    const porDia = new Map();
    for (const f of fichajes) {
      if (!porDia.has(f.fecha_local)) porDia.set(f.fecha_local, []);
      porDia.get(f.fecha_local).push(f);
    }
    let reales = 0;
    for (const lista of porDia.values()) reales += minutosTrabajadosDe(fichajesEfectivos(lista));

    const teoricos = await minutosTeoricosDelPeriodo(env, empresa, empleado.id, ancla, fecha);
    const exceso = reales - teoricos;
    if (exceso <= MARGEN_EXCESO_MENSUAL_MIN) continue;

    const insertada = await guardarIncidencia(env, {
      empresaId: empresa.id,
      empleadoId: empleado.id,
      fecha: ancla,
      tipo: 'exceso_jornada_mensual',
      detalle: `${formatoHoras(exceso)} de exceso sobre la jornada teórica acumulada del mes`,
    });
    if (insertada) {
      nuevas.push({
        tipo: 'exceso_jornada_mensual',
        empleado_id: empleado.id,
        empleado: `${empleado.nombre} ${empleado.apellidos}`.trim(),
        fecha: ancla,
        descripcion: `${DESCRIPCIONES.exceso_jornada_mensual}. ${formatoHoras(exceso)}`,
      });
    }
  }
  return nuevas;
}

/**
 * Minutos de jornada teórica de un empleado entre dos fechas, descontando
 * festivos del calendario de la empresa y días con ausencia aprobada. Se usa
 * tanto en el motor como en los informes.
 */
export async function minutosTeoricosDelPeriodo(env, empresa, empleadoId, desde, hasta) {
  const { results: horarios } = await env.DB.prepare(
    `SELECT * FROM horarios_teoricos
      WHERE empresa_id = ? AND empleado_id = ?
        AND vigente_desde <= ? AND (vigente_hasta IS NULL OR vigente_hasta >= ?)`,
  ).bind(empresa.id, empleadoId, hasta, desde).all();
  if (!horarios?.length) return 0;

  const { results: festivos } = await env.DB.prepare(
    `SELECT fecha FROM calendario_laboral
      WHERE empresa_id = ? AND fecha BETWEEN ? AND ?`,
  ).bind(empresa.id, desde, hasta).all();
  const diasFestivos = new Set((festivos ?? []).map((f) => f.fecha));

  const { results: ausencias } = await env.DB.prepare(
    `SELECT fecha_inicio, fecha_fin FROM ausencias
      WHERE empresa_id = ? AND empleado_id = ? AND estado = 'aprobada'
        AND fecha_inicio <= ? AND fecha_fin >= ?`,
  ).bind(empresa.id, empleadoId, hasta, desde).all();

  let total = 0;
  for (const fecha of rangoDeFechas(desde, hasta)) {
    if (diasFestivos.has(fecha)) continue;
    if ((ausencias ?? []).some((a) => a.fecha_inicio <= fecha && a.fecha_fin >= fecha)) continue;
    const horario = horarios.find((h) => h.dia_semana === diaSemanaIso(fecha)
      && h.vigente_desde <= fecha && (!h.vigente_hasta || h.vigente_hasta >= fecha));
    if (!horario) continue;
    total += minutosDeHora(horario.hora_salida) - minutosDeHora(horario.hora_entrada);
  }
  return total;
}

function rangoDeFechas(desde, hasta) {
  const dias = [];
  let f = desde;
  let guarda = 0;
  while (f <= hasta && guarda++ < 3700) {
    dias.push(f);
    const t = new Date(`${f}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    f = t.toISOString().slice(0, 10);
  }
  return dias;
}
