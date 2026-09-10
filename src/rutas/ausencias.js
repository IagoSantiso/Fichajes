/**
 * Ausencias.
 *
 * Tres reglas del brief que se cumplen aquí:
 *  1. Tabla genérica con campo tipo, no una tabla de vacaciones.
 *  2. En las bajas se guardan tipo y fechas, nunca el motivo médico: es
 *     categoría especial del artículo 9 del RGPD y no entra en la base de
 *     datos bajo ningún concepto. El comentario libre se descarta en las bajas.
 *  3. Las ausencias no tocan jamás la cadena de fichajes. Los informes las
 *     cruzan por consulta.
 *
 * El saldo de vacaciones es el número fijado a mano menos lo ya disfrutado del
 * año. No hay devengo proporcional ni arrastre: está fuera de alcance porque
 * depende de convenio.
 */
import { json, malaPeticion, prohibido, noEncontrado, conflicto } from '../lib/respuestas.js';
import { nuevoId } from '../lib/ids.js';
import { ahoraUtc, rangoFechas, diaSemanaIso } from '../lib/tiempo.js';
import { registrarAcceso } from '../lib/log.js';

const TIPOS = ['vacaciones', 'baja', 'permiso_retribuido', 'asuntos_propios', 'otro'];

export function registrarRutasAusencias(router) {
  router.get('/api/ausencias', async ({ sesion, datos, url }) => {
    const condiciones = {};
    const estado = url.searchParams.get('estado');
    if (estado && estado !== 'todas') condiciones.estado = estado;
    if (sesion.actorTipo === 'empleado') condiciones.empleado_id = sesion.actorId;
    else if (url.searchParams.get('empleado')) condiciones.empleado_id = url.searchParams.get('empleado');

    const filas = await datos.listar('ausencias', condiciones,
      { orden: 'fecha_inicio DESC' });
    return json({ ausencias: filas });
  });

  /**
   * Saldo de días del año. Se cuentan los días de vacaciones aprobados,
   * descontando fines de semana y festivos del calendario de la empresa:
   * contar el sábado como día de vacaciones es la primera queja que llega.
   */
  router.get('/api/ausencias/saldo', async ({ sesion, datos, url }) => {
    const empleadoId = sesion.actorTipo === 'empleado'
      ? sesion.actorId
      : url.searchParams.get('empleado');
    if (!empleadoId) throw malaPeticion('Falta el empleado');

    const anio = url.searchParams.get('anio') ?? String(new Date().getUTCFullYear());
    const empleado = await datos.uno('empleados', { id: empleadoId });
    if (!empleado) throw noEncontrado('Empleado no encontrado');

    const festivos = new Set((await datos.listar('calendario_laboral',
      { fecha: { op: 'LIKE', valor: `${anio}-%` } })).map((d) => d.fecha));

    const ausencias = await datos.listar('ausencias',
      { empleado_id: empleadoId, estado: 'aprobada' });

    let disfrutados = 0;
    const porTipo = {};
    for (const a of ausencias) {
      const dias = diasHabiles(a, festivos, anio);
      porTipo[a.tipo] = (porTipo[a.tipo] ?? 0) + dias;
      if (a.tipo === 'vacaciones') disfrutados += dias;
    }

    return json({
      anio,
      empleado_id: empleadoId,
      dias_anuales: empleado.dias_vacaciones_anuales,
      disfrutados,
      pendientes: empleado.dias_vacaciones_anuales - disfrutados,
      por_tipo: porTipo,
      // El saldo es informativo: no calcula devengo por antigüedad ni arrastre
      // del año anterior, que dependen de convenio.
      nota: 'Saldo sobre los días fijados a mano. No incluye devengo proporcional ni arrastres.',
    });
  });

  /** Solicita una ausencia. El trabajador solicita para sí; el panel, para otro. */
  router.post('/api/ausencias', async ({ env, sesion, datos, empresa, cuerpo, peticion }) => {
    const empleadoId = sesion.actorTipo === 'empleado'
      ? sesion.actorId
      : String(cuerpo.empleado_id ?? '');
    if (!empleadoId) throw malaPeticion('Falta el empleado');

    const tipo = String(cuerpo.tipo ?? '');
    if (!TIPOS.includes(tipo)) throw malaPeticion(`Tipo no válido. Use uno de: ${TIPOS.join(', ')}`);

    const inicio = String(cuerpo.fecha_inicio ?? '');
    const fin = String(cuerpo.fecha_fin ?? inicio);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fin)) {
      throw malaPeticion('Fechas no válidas');
    }
    if (fin < inicio) throw malaPeticion('La fecha de fin es anterior a la de inicio');

    const solapada = await datos.consulta(
      `SELECT id FROM ausencias
        WHERE empresa_id = :empresa AND empleado_id = ?
          AND estado IN ('solicitada','aprobada')
          AND fecha_inicio <= ? AND fecha_fin >= ?`,
      [empleadoId, fin, inicio],
    );
    if (solapada.length) throw conflicto('Ya hay una ausencia solicitada o aprobada en esas fechas');

    // Regla 2: en una baja no se guarda comentario. Ni siquiera si lo mandan.
    const comentario = tipo === 'baja' ? null : (cuerpo.comentario ?? null);

    const ausencia = await datos.insertar('ausencias', {
      id: nuevoId('aus'),
      empleado_id: empleadoId,
      tipo,
      fecha_inicio: inicio,
      fecha_fin: fin,
      medio_dia: cuerpo.medio_dia ? 1 : 0,
      // Una baja o un permiso que registra la empresa entra ya aprobado: no
      // tiene sentido que el empresario se apruebe a sí mismo una baja médica.
      estado: sesion.actorTipo === 'empleado' ? 'solicitada' : 'aprobada',
      solicitada_por: sesion.actorId,
      solicitada_en: ahoraUtc(),
      resuelta_por: sesion.actorTipo === 'empleado' ? null : sesion.actorId,
      resuelta_en: sesion.actorTipo === 'empleado' ? null : ahoraUtc(),
      comentario,
    });

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'alta',
      recurso: `ausencia ${tipo}`,
      empleadoAfectadoId: empleadoId,
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    return json({ ok: true, ausencia }, 201);
  });

  /** Aprueba o deniega. Es media bandeja de solicitudes del panel. */
  router.post('/api/ausencias/:id/resolver', async ({ env, sesion, datos, empresa, parametros, cuerpo, peticion }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido('La ausencia la resuelve la empresa o la gestoría');

    const ausencia = await datos.uno('ausencias', { id: parametros.id });
    if (!ausencia) throw noEncontrado('Ausencia no encontrada');
    if (ausencia.estado !== 'solicitada') throw conflicto('Esa ausencia ya está resuelta');

    const decision = cuerpo.decision === 'aprobar' ? 'aprobada' : 'denegada';
    await datos.actualizar('ausencias', { id: parametros.id }, {
      estado: decision,
      resuelta_por: sesion.actorId,
      resuelta_en: ahoraUtc(),
      comentario: ausencia.tipo === 'baja' ? null : (cuerpo.comentario ?? ausencia.comentario),
    });

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'aprobacion',
      recurso: `ausencia ${parametros.id}: ${decision}`,
      empleadoAfectadoId: ausencia.empleado_id,
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    return json({ ok: true, estado: decision });
  });

  /** El trabajador puede cancelar lo suyo mientras no esté disfrutado. */
  router.post('/api/ausencias/:id/cancelar', async ({ sesion, datos, parametros }) => {
    const ausencia = await datos.uno('ausencias', { id: parametros.id });
    if (!ausencia) throw noEncontrado('Ausencia no encontrada');
    if (sesion.actorTipo === 'empleado' && ausencia.empleado_id !== sesion.actorId) throw prohibido();
    if (ausencia.estado === 'cancelada') return json({ ok: true, estado: 'cancelada' });
    if (sesion.actorTipo === 'empleado' && ausencia.fecha_inicio <= ahoraUtc().slice(0, 10)) {
      throw conflicto('No se puede cancelar una ausencia ya iniciada; hable con la empresa');
    }
    await datos.actualizar('ausencias', { id: parametros.id }, {
      estado: 'cancelada',
      resuelta_por: sesion.actorId,
      resuelta_en: ahoraUtc(),
    });
    return json({ ok: true, estado: 'cancelada' });
  });
}

/**
 * Días hábiles de una ausencia dentro del año: quita sábados, domingos y
 * festivos del calendario de la empresa. El medio día cuenta como 0,5.
 */
export function diasHabiles(ausencia, festivos, anio = null) {
  let dias = 0;
  for (const fecha of rangoFechas(ausencia.fecha_inicio, ausencia.fecha_fin)) {
    if (anio && !fecha.startsWith(`${anio}-`)) continue;
    if (diaSemanaIso(fecha) >= 6) continue;
    if (festivos.has(fecha)) continue;
    dias += 1;
  }
  if (ausencia.medio_dia && dias > 0) dias -= 0.5;
  return dias;
}

export { TIPOS as TIPOS_AUSENCIA };
