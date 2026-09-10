/**
 * Fichaje y consulta de fichajes.
 *
 * El trabajador ficha y consulta lo suyo. La corrección la piden ellos y la
 * hacen la empresa o la gestoría: el trabajador solicita, no corrige.
 */
import { json, malaPeticion, prohibido, noEncontrado, conflicto } from '../lib/respuestas.js';
import {
  registrarFichaje, registrarRectificacion, registrarAnulacion, registrarAltaManual,
  fichajesEfectivos, estadoActual, accionesDisponibles, transicionValida,
  minutosTrabajados, verificarCadenaEmpresa,
} from '../lib/fichajes.js';
import { fechaLocal, horaLocal, ahoraUtc, localAUtc, resolverPeriodo } from '../lib/tiempo.js';
import { registrarAcceso } from '../lib/log.js';
import { nuevoId } from '../lib/ids.js';

/** El trabajador sólo puede mirar sus propios datos. */
function exigirPropio(sesion, empleadoId) {
  if (sesion.actorTipo === 'empleado' && sesion.actorId !== empleadoId) {
    throw prohibido('Sólo puede consultar sus propios fichajes');
  }
}

export function registrarRutasFichajes(router) {
  /** Estado actual y fichajes del día: es lo que pinta la pantalla principal. */
  router.get('/api/fichajes/estado', async ({ env, sesion, datos, empresa }) => {
    const empleadoId = sesion.actorTipo === 'empleado' ? sesion.actorId : null;
    if (!empleadoId) throw prohibido('Esta vista es la del trabajador');

    const hoy = fechaLocal(ahoraUtc(), empresa.zona_horaria);
    const delDia = await datos.listar('fichajes',
      { empleado_id: empleadoId, fecha_local: hoy }, { orden: 'timestamp_utc ASC' });

    const estado = estadoActual(delDia);
    return json({
      fecha: hoy,
      zona_horaria: empresa.zona_horaria,
      estado,
      acciones: accionesDisponibles(estado),
      minutos_trabajados: minutosTrabajados(delDia),
      fichajes: fichajesEfectivos(delDia).map((f) => vistaFichaje(f, empresa.zona_horaria)),
    });
  });

  /** Fichar. Es la ruta más caliente del sistema y la más simple a propósito. */
  router.post('/api/fichajes', async ({ env, sesion, datos, empresa, cuerpo, peticion }) => {
    if (sesion.actorTipo !== 'empleado') {
      throw prohibido('Los paneles registran fichajes por la vía de alta manual');
    }
    const tipo = String(cuerpo.tipo ?? '');
    const hoy = fechaLocal(ahoraUtc(), empresa.zona_horaria);
    const delDia = await datos.listar('fichajes',
      { empleado_id: sesion.actorId, fecha_local: hoy }, { orden: 'timestamp_utc ASC' });

    // La cola offline puede reenviar; si el fichaje ya está, se contesta con
    // el que hay en lugar de duplicarlo.
    if (cuerpo.idempotencia) {
      const yaEsta = delDia.find((f) => f.motivo === `idem:${cuerpo.idempotencia}`);
      if (yaEsta) {
        return json({ ok: true, repetido: true, fichaje: vistaFichaje(yaEsta, empresa.zona_horaria) });
      }
    }

    const estado = estadoActual(delDia);
    if (!transicionValida(estado, tipo)) {
      throw conflicto(
        `No procede «${tipo}» estando ${estado.replace('_', ' ')}`,
        'transicion_invalida',
      );
    }

    const fichaje = await registrarFichaje(env, empresa, {
      empleadoId: sesion.actorId,
      tipo,
      origen: 'pwa',
      timestampDeclarado: cuerpo.timestamp_declarado ?? null,
      ip: peticion.headers.get('cf-connecting-ip'),
      userAgent: peticion.headers.get('user-agent'),
      latitud: cuerpo.latitud ?? null,
      longitud: cuerpo.longitud ?? null,
      autorId: sesion.actorId,
      autorTipo: 'empleado',
      motivo: cuerpo.idempotencia ? `idem:${cuerpo.idempotencia}` : null,
    });

    const tras = [...delDia, fichaje];
    const nuevoEstado = estadoActual(tras);
    return json({
      ok: true,
      fichaje: vistaFichaje(fichaje, empresa.zona_horaria),
      estado: nuevoEstado,
      acciones: accionesDisponibles(nuevoEstado),
    }, 201);
  });

  /**
   * Fichajes de un empleado en un periodo, con su traza completa. El
   * trabajador ve los suyos; empresa y gestoría, los de cualquiera.
   */
  router.get('/api/fichajes/empleado/:id', async ({ env, sesion, datos, empresa, parametros, url, peticion }) => {
    exigirPropio(sesion, parametros.id);
    const { desde, hasta } = periodoDeConsulta(url);

    const filas = await datos.listar('fichajes', {
      empleado_id: parametros.id,
      fecha_local: { op: '>=', valor: desde },
    }, { orden: 'timestamp_utc ASC' });
    const enRango = filas.filter((f) => f.fecha_local <= hasta);

    if (sesion.actorTipo !== 'empleado') {
      await registrarAcceso(env.DB, {
        empresaId: empresa.id,
        actorTipo: sesion.actorTipo,
        actorId: sesion.actorId,
        accion: 'consulta',
        recurso: `fichajes ${desde}..${hasta}`,
        empleadoAfectadoId: parametros.id,
        ip: peticion.headers.get('cf-connecting-ip'),
      });
    }

    const efectivos = fichajesEfectivos(enRango);
    const porDia = agruparPorDia(efectivos, empresa.zona_horaria);

    return json({
      desde, hasta,
      zona_horaria: empresa.zona_horaria,
      dias: porDia,
      // La traza completa incluye originales sustituidos y anulaciones: es lo
      // que hace que una corrección sea auditable y no un borrado con otro
      // nombre.
      traza: enRango.map((f) => vistaFichaje(f, empresa.zona_horaria, true)),
    });
  });

  /** Rejilla del mes de toda la plantilla, que es la vista del panel. */
  router.get('/api/fichajes/rejilla', async ({ env, sesion, datos, empresa, url, peticion }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido();
    const { desde, hasta } = periodoDeConsulta(url);

    const empleados = await datos.listar('empleados', {}, { orden: 'apellidos ASC, nombre ASC' });
    const filas = await datos.consulta(
      `SELECT * FROM fichajes
        WHERE empresa_id = :empresa AND fecha_local BETWEEN ? AND ?
        ORDER BY timestamp_utc ASC`,
      [desde, hasta],
    );

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'consulta',
      recurso: `rejilla ${desde}..${hasta}`,
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    const efectivos = fichajesEfectivos(filas);
    return json({
      desde, hasta,
      zona_horaria: empresa.zona_horaria,
      empleados: empleados.map((e) => ({
        id: e.id,
        nombre: e.nombre,
        apellidos: e.apellidos,
        activo: e.activo,
        dias: agruparPorDia(efectivos.filter((f) => f.empleado_id === e.id), empresa.zona_horaria),
      })),
    });
  });

  /** Quién está dentro ahora mismo. Pantalla de inicio del panel de empresa. */
  router.get('/api/fichajes/presentes', async ({ sesion, datos, empresa }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido();
    const hoy = fechaLocal(ahoraUtc(), empresa.zona_horaria);

    const empleados = await datos.listar('empleados', { activo: 1 }, { orden: 'apellidos ASC' });
    const delDia = await datos.listar('fichajes', { fecha_local: hoy }, { orden: 'timestamp_utc ASC' });

    const salida = empleados.map((e) => {
      const suyos = delDia.filter((f) => f.empleado_id === e.id);
      const efectivos = fichajesEfectivos(suyos);
      return {
        id: e.id,
        nombre: e.nombre,
        apellidos: e.apellidos,
        estado: estadoActual(suyos),
        desde: efectivos.length
          ? horaLocal(efectivos[efectivos.length - 1].timestamp_utc, empresa.zona_horaria)
          : null,
        minutos_hoy: minutosTrabajados(suyos),
      };
    });

    return json({ fecha: hoy, zona_horaria: empresa.zona_horaria, empleados: salida });
  });

  // --- Correcciones -------------------------------------------------------

  /** El trabajador pide una corrección. No la aplica. */
  router.post('/api/correcciones', async ({ sesion, datos, empresa, cuerpo }) => {
    const empleadoId = sesion.actorTipo === 'empleado' ? sesion.actorId : String(cuerpo.empleado_id ?? '');
    if (!empleadoId) throw malaPeticion('Falta el empleado');
    const motivo = String(cuerpo.motivo ?? '').trim();
    if (!motivo) throw malaPeticion('Explique brevemente qué hay que corregir');
    const fecha = String(cuerpo.fecha_local ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw malaPeticion('Fecha no válida');

    const solicitud = await datos.insertar('solicitudes_correccion', {
      id: nuevoId('cor'),
      empleado_id: empleadoId,
      fichaje_id: cuerpo.fichaje_id ?? null,
      fecha_local: fecha,
      tipo_propuesto: cuerpo.tipo_propuesto ?? null,
      hora_propuesta: cuerpo.hora_propuesta ?? null,
      motivo,
      estado: 'solicitada',
    });
    return json({ ok: true, solicitud }, 201);
  });

  /** Bandeja de solicitudes de corrección. */
  router.get('/api/correcciones', async ({ sesion, datos, url }) => {
    const estado = url.searchParams.get('estado') ?? 'solicitada';
    const condiciones = estado === 'todas' ? {} : { estado };
    if (sesion.actorTipo === 'empleado') condiciones.empleado_id = sesion.actorId;
    const filas = await datos.listar('solicitudes_correccion', condiciones,
      { orden: 'solicitada_en DESC' });
    return json({ solicitudes: filas });
  });

  /**
   * Resuelve una solicitud. Si se aprueba, se inserta la rectificación (o el
   * alta manual, si el fichaje faltaba) y se guarda a qué registro dio lugar.
   */
  router.post('/api/correcciones/:id/resolver', async ({ env, sesion, datos, empresa, parametros, cuerpo, peticion }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido('La corrección la resuelve la empresa o la gestoría');

    const solicitud = await datos.uno('solicitudes_correccion', { id: parametros.id });
    if (!solicitud) throw noEncontrado('Solicitud no encontrada');
    if (solicitud.estado !== 'solicitada') throw conflicto('Esa solicitud ya está resuelta');

    const aprobar = cuerpo.decision === 'aprobar';
    let resultante = null;

    if (aprobar) {
      const motivo = String(cuerpo.motivo ?? solicitud.motivo).trim();
      const hora = cuerpo.hora ?? solicitud.hora_propuesta;
      const tipo = cuerpo.tipo ?? solicitud.tipo_propuesto;
      if (!hora) throw malaPeticion('Indique la hora corregida');
      const instante = localAUtc(solicitud.fecha_local, hora, empresa.zona_horaria);

      resultante = solicitud.fichaje_id
        ? await registrarRectificacion(env, empresa, {
            fichajeId: solicitud.fichaje_id,
            tipoCorregido: tipo,
            timestampUtcCorregido: instante,
            motivo,
            autorId: sesion.actorId,
            autorTipo: sesion.actorTipo,
            ip: peticion.headers.get('cf-connecting-ip'),
          })
        : await registrarAltaManual(env, empresa, {
            empleadoId: solicitud.empleado_id,
            tipo,
            timestampUtc: instante,
            motivo,
            autorId: sesion.actorId,
            autorTipo: sesion.actorTipo,
            ip: peticion.headers.get('cf-connecting-ip'),
          });
    }

    await datos.actualizar('solicitudes_correccion', { id: parametros.id }, {
      estado: aprobar ? 'aprobada' : 'denegada',
      resuelta_por: sesion.actorId,
      resuelta_en: ahoraUtc(),
      comentario_resolucion: cuerpo.comentario ?? null,
      fichaje_resultante_id: resultante?.id ?? null,
    });

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'correccion',
      recurso: `solicitud ${parametros.id} ${aprobar ? 'aprobada' : 'denegada'}`,
      empleadoAfectadoId: solicitud.empleado_id,
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    return json({ ok: true, fichaje: resultante });
  });

  /** Corrección puntual desde la rejilla, sin solicitud previa. Exige motivo. */
  router.post('/api/fichajes/:id/rectificar', async ({ env, sesion, empresa, parametros, cuerpo, peticion }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido('El trabajador solicita, no corrige');
    const hora = String(cuerpo.hora ?? '');
    if (!/^\d{2}:\d{2}$/.test(hora)) throw malaPeticion('Hora no válida (HH:MM)');
    const fecha = String(cuerpo.fecha_local ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw malaPeticion('Fecha no válida');

    const fichaje = await registrarRectificacion(env, empresa, {
      fichajeId: parametros.id,
      tipoCorregido: cuerpo.tipo ?? null,
      timestampUtcCorregido: localAUtc(fecha, hora, empresa.zona_horaria),
      motivo: cuerpo.motivo,
      autorId: sesion.actorId,
      autorTipo: sesion.actorTipo,
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'correccion',
      recurso: `rectificacion de ${parametros.id}`,
      empleadoAfectadoId: fichaje.empleado_id,
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    return json({ ok: true, fichaje }, 201);
  });

  router.post('/api/fichajes/:id/anular', async ({ env, sesion, empresa, parametros, cuerpo, peticion }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido('El trabajador solicita, no anula');
    const fichaje = await registrarAnulacion(env, empresa, {
      fichajeId: parametros.id,
      motivo: cuerpo.motivo,
      autorId: sesion.actorId,
      autorTipo: sesion.actorTipo,
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'correccion',
      recurso: `anulacion de ${parametros.id}`,
      empleadoAfectadoId: fichaje.empleado_id,
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    return json({ ok: true, fichaje }, 201);
  });

  /** Alta manual de un fichaje que nunca llegó a registrarse. */
  router.post('/api/fichajes/alta-manual', async ({ env, sesion, empresa, cuerpo, peticion }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido();
    const { fecha_local: fecha, hora, tipo, empleado_id: empleadoId, motivo } = cuerpo;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) throw malaPeticion('Fecha no válida');
    if (!/^\d{2}:\d{2}$/.test(String(hora))) throw malaPeticion('Hora no válida (HH:MM)');

    const fichaje = await registrarAltaManual(env, empresa, {
      empleadoId,
      tipo,
      timestampUtc: localAUtc(fecha, hora, empresa.zona_horaria),
      motivo,
      autorId: sesion.actorId,
      autorTipo: sesion.actorTipo,
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'correccion',
      recurso: 'alta manual de fichaje',
      empleadoAfectadoId: empleadoId,
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    return json({ ok: true, fichaje }, 201);
  });

  /**
   * Verificación de la cadena bajo demanda. Es la respuesta a «cómo sé que
   * esto no se ha tocado», y conviene poder enseñarla.
   */
  router.get('/api/fichajes/verificar-cadena', async ({ env, sesion, empresa, peticion }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido();
    const resultado = await verificarCadenaEmpresa(env, empresa.id);
    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'consulta',
      recurso: 'verificacion de cadena',
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    return json(resultado);
  });
}

// --- Utilidades de presentación ------------------------------------------

function vistaFichaje(f, zona, conTraza = false) {
  const base = {
    id: f.id,
    empleado_id: f.empleado_id,
    tipo: f.tipo,
    fecha: f.fecha_local,
    hora: horaLocal(f.timestamp_utc, zona),
    timestamp_utc: f.timestamp_utc,
    diferido: Boolean(f.diferido),
    origen: f.origen,
  };
  if (!conTraza) return base;
  return {
    ...base,
    tipo_registro: f.tipo_registro,
    fichaje_referenciado_id: f.fichaje_referenciado_id,
    motivo: f.motivo,
    autor_id: f.autor_id,
    autor_tipo: f.autor_tipo,
    timestamp_declarado: f.timestamp_declarado,
    hash: f.hash,
  };
}

function agruparPorDia(efectivos, zona) {
  const porDia = new Map();
  for (const f of efectivos) {
    if (!porDia.has(f.fecha_local)) porDia.set(f.fecha_local, []);
    porDia.get(f.fecha_local).push(f);
  }
  return [...porDia.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fecha, lista]) => ({
      fecha,
      minutos: minutosTrabajados(lista),
      fichajes: lista.map((f) => vistaFichaje(f, zona)),
    }));
}

/** Acepta ?desde=&hasta= o ?periodo=mes&anio=&indice=. */
function periodoDeConsulta(url) {
  const desde = url.searchParams.get('desde');
  const hasta = url.searchParams.get('hasta');
  if (desde && hasta) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
      throw malaPeticion('Fechas no válidas');
    }
    return { desde, hasta };
  }
  const clase = url.searchParams.get('periodo') ?? 'mes';
  const ahora = new Date();
  const anio = Number(url.searchParams.get('anio') ?? ahora.getUTCFullYear());
  const indice = Number(url.searchParams.get('indice') ?? (ahora.getUTCMonth() + 1));
  return resolverPeriodo(clase, anio, indice);
}

export { periodoDeConsulta };
