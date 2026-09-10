/**
 * Trabajadores, horario teórico y calendario laboral.
 *
 * Los días de vacaciones son un número que fija la empresa o la gestoría a
 * mano. El sistema no calcula devengos proporcionales, antigüedad ni arrastres
 * del año anterior: eso depende de convenio y está fuera de alcance.
 */
import { json, malaPeticion, prohibido, noEncontrado } from '../lib/respuestas.js';
import { hashearPin } from '../lib/auth.js';
import { nuevoId } from '../lib/ids.js';
import { ahoraUtc, sumarDias } from '../lib/tiempo.js';
import { registrarAcceso } from '../lib/log.js';

function exigirPanel(sesion) {
  if (sesion.actorTipo === 'empleado') throw prohibido('Sólo la empresa o la gestoría');
  if (sesion.actorTipo === 'inspeccion') throw prohibido('El acceso de inspección es de sólo lectura');
}

export function registrarRutasEmpleados(router) {
  router.get('/api/empleados', async ({ sesion, datos, url }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido();
    const incluirBajas = url.searchParams.get('incluir_bajas') === '1';
    const filas = await datos.listar('empleados',
      incluirBajas ? {} : { activo: 1 },
      { orden: 'apellidos ASC, nombre ASC' });
    // El PIN no sale de aquí ni siquiera hasheado.
    return json({ empleados: filas.map(({ pin_hash, ...resto }) => resto) });
  });

  router.get('/api/empleados/:id', async ({ sesion, datos, parametros }) => {
    if (sesion.actorTipo === 'empleado' && sesion.actorId !== parametros.id) throw prohibido();
    const empleado = await datos.uno('empleados', { id: parametros.id });
    if (!empleado) throw noEncontrado('Empleado no encontrado');
    const { pin_hash, ...vista } = empleado;
    return json({ empleado: vista });
  });

  router.post('/api/empleados', async ({ env, sesion, datos, empresa, cuerpo, peticion }) => {
    exigirPanel(sesion);
    const nombre = String(cuerpo.nombre ?? '').trim();
    if (!nombre) throw malaPeticion('El nombre es obligatorio');

    const empleado = {
      id: nuevoId('emp'),
      nombre,
      apellidos: String(cuerpo.apellidos ?? '').trim(),
      documento_identidad: cuerpo.documento_identidad ?? null,
      email: cuerpo.email ?? null,
      pin_hash: cuerpo.pin ? await hashearPin(cuerpo.pin) : null,
      tipo_jornada: cuerpo.tipo_jornada === 'parcial' ? 'parcial' : 'completa',
      rol: cuerpo.rol === 'responsable' ? 'responsable' : 'empleado',
      dias_vacaciones_anuales: Number(cuerpo.dias_vacaciones_anuales ?? 22),
      fecha_alta: cuerpo.fecha_alta ?? ahoraUtc().slice(0, 10),
      activo: 1,
    };
    await datos.insertar('empleados', empleado);

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'alta',
      recurso: 'empleado',
      empleadoAfectadoId: empleado.id,
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    const { pin_hash, ...vista } = empleado;
    return json({ ok: true, empleado: vista }, 201);
  });

  router.patch('/api/empleados/:id', async ({ env, sesion, datos, empresa, parametros, cuerpo, peticion }) => {
    exigirPanel(sesion);
    const cambios = {};
    for (const campo of ['nombre', 'apellidos', 'documento_identidad', 'email',
      'tipo_jornada', 'rol', 'dias_vacaciones_anuales', 'fecha_baja']) {
      if (campo in cuerpo) cambios[campo] = cuerpo[campo];
    }
    if (cuerpo.pin) cambios.pin_hash = await hashearPin(cuerpo.pin);
    if ('activo' in cuerpo) cambios.activo = cuerpo.activo ? 1 : 0;
    if (!Object.keys(cambios).length) throw malaPeticion('Nada que cambiar');

    const cambiadas = await datos.actualizar('empleados', { id: parametros.id }, cambios);
    if (!cambiadas) throw noEncontrado('Empleado no encontrado');

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'modificacion',
      recurso: `empleado: ${Object.keys(cambios).join(', ')}`,
      empleadoAfectadoId: parametros.id,
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    return json({ ok: true });
  });

  /**
   * Baja de un trabajador. No se borra nada: la conservación es de cuatro años
   * desde cada registro y eso vale también para quien ya no está en plantilla.
   */
  router.post('/api/empleados/:id/baja', async ({ sesion, datos, parametros, cuerpo }) => {
    exigirPanel(sesion);
    const fecha = cuerpo.fecha_baja ?? ahoraUtc().slice(0, 10);
    const cambiadas = await datos.actualizar('empleados', { id: parametros.id },
      { activo: 0, fecha_baja: fecha });
    if (!cambiadas) throw noEncontrado('Empleado no encontrado');
    return json({ ok: true, fecha_baja: fecha });
  });

  // --- Horario teórico ----------------------------------------------------

  router.get('/api/empleados/:id/horario', async ({ sesion, datos, parametros, url }) => {
    if (sesion.actorTipo === 'empleado' && sesion.actorId !== parametros.id) throw prohibido();
    const enFecha = url.searchParams.get('en') ?? ahoraUtc().slice(0, 10);
    const filas = await datos.listar('horarios_teoricos', { empleado_id: parametros.id },
      { orden: 'dia_semana ASC, vigente_desde ASC' });
    return json({
      horario: filas,
      vigente: filas.filter((h) => h.vigente_desde <= enFecha
        && (!h.vigente_hasta || h.vigente_hasta >= enFecha)),
    });
  });

  /**
   * Fija el horario semanal. Versionado por fechas de vigencia: en lugar de
   * reescribir el anterior, se le pone fecha de fin. Cambiar el horario de
   * alguien no debe reescribir la historia ni invalidar informes de meses
   * anteriores.
   */
  router.put('/api/empleados/:id/horario', async ({ sesion, datos, parametros, cuerpo }) => {
    exigirPanel(sesion);
    const desde = String(cuerpo.vigente_desde ?? ahoraUtc().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw malaPeticion('Fecha de vigencia no válida');
    const dias = Array.isArray(cuerpo.dias) ? cuerpo.dias : [];

    // Cierra la vigencia de lo anterior el día antes de que entre lo nuevo.
    await datos.actualizar('horarios_teoricos',
      { empleado_id: parametros.id, vigente_hasta: null },
      { vigente_hasta: sumarDias(desde, -1) });

    for (const dia of dias) {
      if (!dia.hora_entrada || !dia.hora_salida) continue;
      await datos.insertar('horarios_teoricos', {
        id: nuevoId('hor'),
        empleado_id: parametros.id,
        dia_semana: Number(dia.dia_semana),
        hora_entrada: dia.hora_entrada,
        hora_salida: dia.hora_salida,
        vigente_desde: desde,
        vigente_hasta: null,
      });
    }
    return json({ ok: true, vigente_desde: desde, dias: dias.length });
  });

  // --- Calendario laboral -------------------------------------------------

  router.get('/api/calendario', async ({ datos, url }) => {
    const anio = url.searchParams.get('anio') ?? String(new Date().getUTCFullYear());
    const filas = await datos.listar('calendario_laboral',
      { fecha: { op: 'LIKE', valor: `${anio}-%` } }, { orden: 'fecha ASC' });
    return json({ anio, dias: filas });
  });

  router.post('/api/calendario', async ({ sesion, datos, cuerpo }) => {
    exigirPanel(sesion);
    const fecha = String(cuerpo.fecha ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw malaPeticion('Fecha no válida');
    const tipo = String(cuerpo.tipo ?? '');
    const tipos = ['festivo_nacional', 'festivo_autonomico', 'festivo_local', 'cierre_empresa'];
    if (!tipos.includes(tipo)) throw malaPeticion(`Tipo no válido. Use uno de: ${tipos.join(', ')}`);

    // Idempotente: repetir el alta del mismo día actualiza el tipo.
    const existente = await datos.uno('calendario_laboral', { fecha });
    if (existente) {
      await datos.actualizar('calendario_laboral', { fecha },
        { tipo, descripcion: cuerpo.descripcion ?? null });
      return json({ ok: true, actualizado: true });
    }
    const dia = await datos.insertar('calendario_laboral', {
      id: nuevoId('cal'),
      fecha,
      tipo,
      descripcion: cuerpo.descripcion ?? null,
    });
    return json({ ok: true, dia }, 201);
  });

  router.delete('/api/calendario/:fecha', async ({ sesion, datos, parametros }) => {
    exigirPanel(sesion);
    const borradas = await datos.borrar('calendario_laboral', { fecha: parametros.fecha });
    if (!borradas) throw noEncontrado('Ese día no estaba marcado');
    return json({ ok: true });
  });
}
