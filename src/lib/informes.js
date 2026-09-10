/**
 * Informes.
 *
 * Con estos volúmenes no se precalcula nada: consulta directa sobre las
 * tablas. Un año completo de una empresa de diez personas son unos pocos
 * miles de filas.
 *
 * Sobre cómo se etiqueta la diferencia de horas: nunca «horas extra». En el
 * momento en que el sistema emite un número etiquetado como horas
 * extraordinarias está emitiendo una cifra que puede acabar en una papeleta de
 * conciliación, y si son extraordinarias, complementarias o compensación por
 * flexibilidad depende del convenio y del contrato, que el sistema no conoce.
 * La etiqueta es «exceso sobre jornada teórica». La calificación la hace la
 * gestoría.
 */
import { fichajesEfectivos, minutosTrabajados } from './fichajes.js';
import { minutosTeoricosDelPeriodo, DESCRIPCIONES } from '../incidencias/motor.js';
import { rangoFechas, diaSemanaIso, fechaLocal, ahoraUtc } from './tiempo.js';

export const ETIQUETA_DIFERENCIA = 'Exceso sobre jornada teórica';

/**
 * Informe de una empresa en un periodo.
 * Devuelve una fila por empleado más los totales de la empresa.
 */
export async function informeDePeriodo(env, empresa, { desde, hasta, empleadoId = null }) {
  // Un periodo que llega más allá de hoy sólo puede acumular jornada teórica
  // hasta hoy. Si no, un mes en curso muestra el déficit de los días que aún
  // no han ocurrido y el número deja de significar nada.
  const hoy = fechaLocal(ahoraUtc(), empresa.zona_horaria);
  const enCurso = hasta > hoy;
  const hastaTeorico = enCurso ? hoy : hasta;

  const parametrosEmpleado = empleadoId ? ' AND id = ?' : '';
  const { results: empleados } = await env.DB.prepare(
    `SELECT * FROM empleados WHERE empresa_id = ?${parametrosEmpleado}
      ORDER BY apellidos, nombre`,
  ).bind(...(empleadoId ? [empresa.id, empleadoId] : [empresa.id])).all();

  const { results: fichajes } = await env.DB.prepare(
    `SELECT * FROM fichajes WHERE empresa_id = ? AND fecha_local BETWEEN ? AND ?
      ORDER BY timestamp_utc ASC`,
  ).bind(empresa.id, desde, hasta).all();

  const { results: ausencias } = await env.DB.prepare(
    `SELECT * FROM ausencias WHERE empresa_id = ? AND estado = 'aprobada'
        AND fecha_inicio <= ? AND fecha_fin >= ?`,
  ).bind(empresa.id, hasta, desde).all();

  const { results: incidencias } = await env.DB.prepare(
    `SELECT * FROM incidencias WHERE empresa_id = ? AND fecha BETWEEN ? AND ?`,
  ).bind(empresa.id, desde, hasta).all();

  const { results: festivos } = await env.DB.prepare(
    `SELECT fecha, tipo, descripcion FROM calendario_laboral
      WHERE empresa_id = ? AND fecha BETWEEN ? AND ?`,
  ).bind(empresa.id, desde, hasta).all();
  const diasFestivos = new Set((festivos ?? []).map((f) => f.fecha));

  const filas = [];
  for (const empleado of empleados ?? []) {
    const suyos = (fichajes ?? []).filter((f) => f.empleado_id === empleado.id);
    const porDia = agrupar(suyos);

    let minutosRegistrados = 0;
    let diasTrabajados = 0;
    for (const lista of porDia.values()) {
      const m = minutosTrabajados(lista);
      minutosRegistrados += m;
      if (fichajesEfectivos(lista).length) diasTrabajados += 1;
    }

    const minutosTeoricos = desde > hastaTeorico
      ? 0    // el periodo entero está en el futuro
      : await minutosTeoricosDelPeriodo(env, empresa, empleado.id, desde, hastaTeorico);

    const ausenciasSuyas = (ausencias ?? []).filter((a) => a.empleado_id === empleado.id);
    const diasAusencia = {};
    for (const a of ausenciasSuyas) {
      const dias = diasEfectivos(a, diasFestivos, desde, hasta);
      diasAusencia[a.tipo] = (diasAusencia[a.tipo] ?? 0) + dias;
    }

    const incidenciasSuyas = (incidencias ?? []).filter((i) => i.empleado_id === empleado.id);
    const porTipo = {};
    for (const i of incidenciasSuyas) porTipo[i.tipo] = (porTipo[i.tipo] ?? 0) + 1;

    filas.push({
      empleado_id: empleado.id,
      nombre: `${empleado.nombre} ${empleado.apellidos}`.trim(),
      documento_identidad: empleado.documento_identidad,
      tipo_jornada: empleado.tipo_jornada,
      minutos_registrados: minutosRegistrados,
      minutos_teoricos: minutosTeoricos,
      // La diferencia se llama así y no de otra manera. Ver cabecera.
      minutos_exceso: minutosRegistrados - minutosTeoricos,
      dias_trabajados: diasTrabajados,
      dias_ausencia: diasAusencia,
      total_dias_ausencia: Object.values(diasAusencia).reduce((a, b) => a + b, 0),
      incidencias_por_tipo: porTipo,
      total_incidencias: incidenciasSuyas.length,
    });
  }

  const totales = filas.reduce((acumulado, f) => ({
    minutos_registrados: acumulado.minutos_registrados + f.minutos_registrados,
    minutos_teoricos: acumulado.minutos_teoricos + f.minutos_teoricos,
    minutos_exceso: acumulado.minutos_exceso + f.minutos_exceso,
    dias_trabajados: acumulado.dias_trabajados + f.dias_trabajados,
    total_dias_ausencia: acumulado.total_dias_ausencia + f.total_dias_ausencia,
    total_incidencias: acumulado.total_incidencias + f.total_incidencias,
  }), {
    minutos_registrados: 0, minutos_teoricos: 0, minutos_exceso: 0,
    dias_trabajados: 0, total_dias_ausencia: 0, total_incidencias: 0,
  });

  return {
    empresa: {
      id: empresa.id,
      nombre: empresa.nombre,
      cif: empresa.cif,
      zona_horaria: empresa.zona_horaria,
    },
    periodo: {
      desde,
      hasta,
      // Un periodo en curso se marca como tal: las horas teóricas están
      // calculadas hasta hoy, no hasta el final del periodo.
      en_curso: enCurso,
      teoricas_hasta: hastaTeorico,
    },
    etiqueta_diferencia: ETIQUETA_DIFERENCIA,
    empleados: filas,
    totales,
    festivos: festivos ?? [],
    generado_en: new Date().toISOString(),
  };
}

/**
 * Detalle diario de un empleado. Es lo que se entrega al trabajador o a la
 * Inspección cuando piden el registro y no un resumen.
 */
export async function detalleDiario(env, empresa, { empleadoId, desde, hasta }) {
  const empleado = await env.DB.prepare(
    `SELECT * FROM empleados WHERE id = ? AND empresa_id = ?`,
  ).bind(empleadoId, empresa.id).first();
  if (!empleado) return null;

  const { results: fichajes } = await env.DB.prepare(
    `SELECT * FROM fichajes WHERE empresa_id = ? AND empleado_id = ?
        AND fecha_local BETWEEN ? AND ? ORDER BY timestamp_utc ASC`,
  ).bind(empresa.id, empleadoId, desde, hasta).all();

  const porDia = agrupar(fichajes ?? []);
  const dias = [...porDia.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fecha, lista]) => ({
      fecha,
      minutos: minutosTrabajados(lista),
      fichajes: fichajesEfectivos(lista),
      // La traza incluye lo sustituido y lo anulado: sin eso, una corrección
      // sería indistinguible de un borrado.
      traza: lista.filter((f) => f.tipo_registro !== 'original' || tieneCorreccion(lista, f.id)),
    }));

  return {
    empleado: {
      id: empleado.id,
      nombre: `${empleado.nombre} ${empleado.apellidos}`.trim(),
      documento_identidad: empleado.documento_identidad,
    },
    empresa: { id: empresa.id, nombre: empresa.nombre, cif: empresa.cif },
    periodo: { desde, hasta },
    dias,
  };
}

function tieneCorreccion(lista, id) {
  return lista.some((f) => f.fichaje_referenciado_id === id);
}

function agrupar(fichajes) {
  const porDia = new Map();
  for (const f of fichajes) {
    if (!porDia.has(f.fecha_local)) porDia.set(f.fecha_local, []);
    porDia.get(f.fecha_local).push(f);
  }
  return porDia;
}

/** Días de una ausencia que caen dentro del periodo, sin fines de semana ni festivos. */
function diasEfectivos(ausencia, festivos, desde, hasta) {
  let dias = 0;
  const inicio = ausencia.fecha_inicio > desde ? ausencia.fecha_inicio : desde;
  const fin = ausencia.fecha_fin < hasta ? ausencia.fecha_fin : hasta;
  for (const fecha of rangoFechas(inicio, fin)) {
    if (diaSemanaIso(fecha) >= 6) continue;
    if (festivos.has(fecha)) continue;
    dias += 1;
  }
  if (ausencia.medio_dia && dias > 0) dias -= 0.5;
  return dias;
}

/** '7 h 30 min' a partir de minutos. Se usa en PDF y en pantalla. */
export function horasYMinutos(minutos) {
  const signo = minutos < 0 ? '-' : '';
  const m = Math.abs(Math.round(minutos));
  return `${signo}${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** '7,50' — horas decimales con coma, que es lo que espera una hoja de cálculo española. */
export function horasDecimales(minutos) {
  return (Math.round((minutos / 60) * 100) / 100).toFixed(2).replace('.', ',');
}

export { DESCRIPCIONES as DESCRIPCIONES_INCIDENCIA };
