/**
 * Incidencias.
 *
 * El trabajador ve las suyas y sólo las suyas. Es lo que hace que se corrijan
 * solas y lo que evita que el módulo se convierta en un panel de vigilancia.
 */
import { json, prohibido, noEncontrado, malaPeticion } from '../lib/respuestas.js';
import { ahoraUtc, fechaLocal } from '../lib/tiempo.js';
import { DESCRIPCIONES, TIPOS_ESTRUCTURALES, TIPOS_EXPECTATIVA } from '../incidencias/motor.js';
import { ejecutarParaEmpresa } from '../incidencias/motor.js';
import { registrarAcceso } from '../lib/log.js';

export function registrarRutasIncidencias(router) {
  router.get('/api/incidencias', async ({ sesion, datos, url }) => {
    const condiciones = {};
    const estado = url.searchParams.get('estado') ?? 'abierta';
    if (estado !== 'todas') condiciones.estado = estado;
    if (sesion.actorTipo === 'empleado') condiciones.empleado_id = sesion.actorId;
    else if (url.searchParams.get('empleado')) condiciones.empleado_id = url.searchParams.get('empleado');
    if (url.searchParams.get('desde')) {
      condiciones.fecha = { op: '>=', valor: url.searchParams.get('desde') };
    }

    const filas = await datos.listar('incidencias', condiciones, { orden: 'fecha DESC' });
    const empleados = await datos.listar('empleados', {}, { campos: 'id, nombre, apellidos' });
    const porId = new Map(empleados.map((e) => [e.id, `${e.nombre} ${e.apellidos}`.trim()]));

    return json({
      incidencias: filas.map((i) => ({
        ...i,
        empleado: porId.get(i.empleado_id) ?? null,
        descripcion: DESCRIPCIONES[i.tipo] ?? i.tipo,
        familia: TIPOS_ESTRUCTURALES.includes(i.tipo) ? 'estructural' : 'expectativa',
      })),
    });
  });

  /**
   * Marcar como resuelta o ignorada. Es la razón de que las incidencias se
   * persistan en lugar de calcularse al vuelo: si se recalculan cada vez, no
   * hay dónde apuntar que ésta ya se miró y no es un problema.
   */
  router.post('/api/incidencias/:id/estado', async ({ env, sesion, datos, empresa, parametros, cuerpo, peticion }) => {
    if (sesion.actorTipo === 'empleado') {
      throw prohibido('El trabajador ve sus incidencias; las resuelve la empresa o la gestoría');
    }
    const estado = String(cuerpo.estado ?? '');
    if (!['resuelta', 'ignorada', 'abierta'].includes(estado)) {
      throw malaPeticion('Estado no válido. Use resuelta, ignorada o abierta');
    }

    const incidencia = await datos.uno('incidencias', { id: parametros.id });
    if (!incidencia) throw noEncontrado('Incidencia no encontrada');

    await datos.actualizar('incidencias', { id: parametros.id }, {
      estado,
      resuelta_por: estado === 'abierta' ? null : sesion.actorId,
      resuelta_en: estado === 'abierta' ? null : ahoraUtc(),
    });

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'resolucion_incidencia',
      recurso: `${incidencia.tipo} ${incidencia.fecha} -> ${estado}`,
      empleadoAfectadoId: incidencia.empleado_id,
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    return json({ ok: true, estado });
  });

  /**
   * Pasada manual del motor sobre una fecha. Útil para revisar un día
   * concreto después de corregir fichajes, y para probar el motor sin esperar
   * al cron. Es idempotente, así que se puede invocar sin miedo.
   */
  router.post('/api/incidencias/revisar', async ({ env, sesion, empresa, cuerpo }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido();
    const fecha = String(cuerpo.fecha ?? fechaLocal(ahoraUtc(), empresa.zona_horaria));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw malaPeticion('Fecha no válida');

    const hoy = fechaLocal(ahoraUtc(), empresa.zona_horaria);
    const resultado = await ejecutarParaEmpresa(env, empresa, fecha, {
      // Un día pasado tiene la jornada cerrada por definición.
      jornadaCerrada: fecha < hoy,
    });
    return json({ ok: true, fecha, nuevas: resultado.nuevas.length, detalle: resultado.nuevas });
  });

  /** Catálogo de tipos, para que el frontend no los repita a mano. */
  router.get('/api/incidencias/tipos', async () => json({
    estructurales: TIPOS_ESTRUCTURALES.map((t) => ({ tipo: t, descripcion: DESCRIPCIONES[t] })),
    expectativa: TIPOS_EXPECTATIVA.map((t) => ({ tipo: t, descripcion: DESCRIPCIONES[t] })),
  }));
}
