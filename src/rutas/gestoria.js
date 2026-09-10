/**
 * Panel de gestoría y administración de empresa.
 *
 * La gestoría es el canal comercial: aporta los clientes y fija el precio.
 * El panel transversal es lo que le permite cerrar el mes de varias empresas
 * sin entrar y salir de cada una.
 */
import { json, malaPeticion, prohibido, noEncontrado, conflicto } from '../lib/respuestas.js';
import { nuevoId, nuevoToken } from '../lib/ids.js';
import { sha256Token, hashearPassword } from '../lib/auth.js';
import { ahoraUtc, fechaLocal, resolverPeriodo } from '../lib/tiempo.js';
import { informeDePeriodo } from '../lib/informes.js';
import { exportar, nombreFichero } from '../exportacion/index.js';
import { respuestaDescarga } from './informes.js';
import { registrarAcceso } from '../lib/log.js';

function exigirGestoria(sesion) {
  if (!sesion || sesion.actorTipo !== 'gestoria') throw prohibido('Sólo la gestoría');
}

export function registrarRutasGestoria(router) {
  /**
   * Lista de empresas con semáforo. Tres estados, en este orden de gravedad:
   *   rojo    — hay solicitudes pendientes de resolver (alguien espera)
   *   ámbar   — hay incidencias abiertas
   *   verde   — mes cerrado sin incidencias
   */
  router.get('/api/gestoria/empresas', async ({ env, sesion }) => {
    exigirGestoria(sesion);

    const { results: empresas } = await env.DB.prepare(
      `SELECT * FROM empresas WHERE gestoria_id = ? ORDER BY nombre`,
    ).bind(sesion.gestoriaId).all();

    const salida = [];
    for (const empresa of empresas ?? []) {
      const incidencias = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM incidencias WHERE empresa_id = ? AND estado = 'abierta'`,
      ).bind(empresa.id).first();
      const ausencias = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ausencias WHERE empresa_id = ? AND estado = 'solicitada'`,
      ).bind(empresa.id).first();
      const correcciones = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM solicitudes_correccion WHERE empresa_id = ? AND estado = 'solicitada'`,
      ).bind(empresa.id).first();
      const plantilla = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM empleados WHERE empresa_id = ? AND activo = 1`,
      ).bind(empresa.id).first();
      const ultimo = await env.DB.prepare(
        `SELECT fecha_local FROM fichajes WHERE empresa_id = ? ORDER BY rowid DESC LIMIT 1`,
      ).bind(empresa.id).first();

      const pendientes = (ausencias?.n ?? 0) + (correcciones?.n ?? 0);
      salida.push({
        id: empresa.id,
        nombre: empresa.nombre,
        numero: empresa.numero,
        codigo: empresa.codigo,
        cif: empresa.cif,
        activa: Boolean(empresa.activa),
        plantilla: plantilla?.n ?? 0,
        incidencias_abiertas: incidencias?.n ?? 0,
        solicitudes_pendientes: pendientes,
        ultimo_fichaje: ultimo?.fecha_local ?? null,
        semaforo: pendientes > 0 ? 'rojo' : (incidencias?.n ?? 0) > 0 ? 'ambar' : 'verde',
      });
    }
    return json({ empresas: salida });
  });

  /** Alta de empresa nueva, con su usuario de acceso y su código de fichaje. */
  router.post('/api/gestoria/empresas', async ({ env, sesion, cuerpo, peticion }) => {
    exigirGestoria(sesion);
    const nombre = String(cuerpo.nombre ?? '').trim();
    if (!nombre) throw malaPeticion('El nombre de la empresa es obligatorio');

    const codigo = String(cuerpo.codigo ?? codigoSugerido(nombre)).toUpperCase().trim();
    if (!/^[A-Z0-9-]{4,16}$/.test(codigo)) {
      throw malaPeticion('El código debe tener entre 4 y 16 caracteres (letras, números o guiones)');
    }
    const repetido = await env.DB.prepare(`SELECT id FROM empresas WHERE upper(codigo) = ?`)
      .bind(codigo).first();
    if (repetido) throw conflicto('Ya hay una empresa con ese código');

    // El número de empresa es lo que forma la primera mitad del identificador
    // con que fichan sus trabajadores. No se reutiliza el de una empresa dada
    // de baja: sus registros siguen ahí cuatro años.
    const mayor = await env.DB.prepare(`SELECT MAX(numero) AS n FROM empresas`).first();
    const numero = (mayor?.n ?? 0) + 1;
    if (numero > 999) throw conflicto('Se han agotado los números de empresa (máximo 999)');

    const empresa = {
      id: nuevoId('emc'),
      gestoria_id: sesion.gestoriaId,
      numero,
      nombre,
      codigo,
      cif: cuerpo.cif ?? null,
      direccion: cuerpo.direccion ?? null,
      zona_horaria: cuerpo.zona_horaria ?? 'Europe/Madrid',
      tolerancia_minutos: Number(cuerpo.tolerancia_minutos ?? 20),
      jornada_maxima_alerta_horas: Number(cuerpo.jornada_maxima_alerta_horas ?? 12),
      geolocalizacion_activa: 0,
      geolocalizacion_motivo: null,
      avisos_modo: 'resumen_diario',
      avisos_email: cuerpo.avisos_email ?? null,
      activa: 1,
      fecha_alta: ahoraUtc().slice(0, 10),
    };

    const columnas = Object.keys(empresa);
    await env.DB.prepare(
      `INSERT INTO empresas (${columnas.join(',')}) VALUES (${columnas.map(() => '?').join(',')})`,
    ).bind(...columnas.map((c) => empresa[c])).run();

    // Usuario de la empresa, si la gestoría facilita correo y contraseña. La
    // contraseña la elige la gestoría y nace marcada para cambio: quien la
    // reparte la conoce.
    let passwordInicial = null;
    if (cuerpo.email_empresa) {
      passwordInicial = String(cuerpo.password_empresa ?? '').trim() || passwordSugerida();
      await env.DB.prepare(
        `INSERT INTO usuarios (id, email, nombre, rol, empresa_id, activo, creado_en,
                               password_hash, debe_cambiar_password)
         VALUES (?,?,?,'empresa',?,1,?,?,1)`,
      ).bind(nuevoId('usu'), String(cuerpo.email_empresa).toLowerCase(), nombre,
        empresa.id, ahoraUtc(), await hashearPassword(passwordInicial)).run();
    }

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: 'gestoria',
      actorId: sesion.actorId,
      accion: 'alta',
      recurso: 'empresa',
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    return json({
      ok: true,
      empresa,
      // Se enseña una sola vez: sólo se guarda su hash.
      password_inicial: passwordInicial,
      aviso: passwordInicial
        ? 'Anote la contraseña ahora: no se puede volver a consultar. La empresa '
          + 'tendrá que cambiarla la primera vez que entre.'
        : null,
    }, 201);
  });

  /**
   * La gestoría repone la contraseña de una de sus empresas.
   *
   * Es la mitad de arriba de la cadena que sustituye al «he olvidado mi
   * contraseña» por correo: la gestoría repone la de sus empresas, y cada
   * empresa el PIN de sus trabajadores.
   */
  router.post('/api/gestoria/empresas/:id/password', async ({ env, sesion, parametros, cuerpo, peticion }) => {
    exigirGestoria(sesion);

    const empresa = await env.DB.prepare(
      `SELECT id, nombre FROM empresas WHERE id = ? AND gestoria_id = ?`,
    ).bind(parametros.id, sesion.gestoriaId).first();
    if (!empresa) throw noEncontrado('Esa empresa no pertenece a su gestoría');

    const usuario = await env.DB.prepare(
      `SELECT id, email FROM usuarios WHERE empresa_id = ? AND rol = 'empresa' AND activo = 1`,
    ).bind(empresa.id).first();
    if (!usuario) {
      throw noEncontrado('Esa empresa no tiene todavía un usuario de acceso al panel');
    }

    const password = String(cuerpo.password ?? '').trim() || passwordSugerida();
    await env.DB.prepare(
      `UPDATE usuarios SET password_hash = ?, debe_cambiar_password = 1 WHERE id = ?`,
    ).bind(await hashearPassword(password), usuario.id).run();

    // Las sesiones abiertas con la contraseña anterior dejan de valer.
    await env.DB.prepare(
      `UPDATE sesiones SET revocada_en = ?
        WHERE actor_id = ? AND revocada_en IS NULL`,
    ).bind(ahoraUtc(), usuario.id).run();

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: 'gestoria',
      actorId: sesion.actorId,
      accion: 'reposicion_clave',
      recurso: `contraseña de ${usuario.email}`,
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    return json({
      ok: true,
      email: usuario.email,
      password,
      aviso: 'Anótela ahora: no se puede volver a consultar. La empresa tendrá '
        + 'que cambiarla la primera vez que entre.',
    });
  });

  /**
   * Exportación masiva: un periodo, varias empresas. Es lo que convierte el
   * cierre de mes de la gestoría en una operación y no en cinco.
   */
  router.get('/api/gestoria/exportacion', async ({ env, sesion, url, peticion }) => {
    exigirGestoria(sesion);
    const formato = url.searchParams.get('formato') ?? 'csv';
    const clase = url.searchParams.get('periodo') ?? 'mes';
    const ahora = new Date();
    const anio = Number(url.searchParams.get('anio') ?? ahora.getUTCFullYear());
    const indice = Number(url.searchParams.get('indice') ?? (ahora.getUTCMonth() + 1));
    const { desde, hasta } = resolverPeriodo(clase, anio, indice);

    const pedidas = (url.searchParams.get('empresas') ?? '').split(',').filter(Boolean);
    const { results: empresas } = await env.DB.prepare(
      `SELECT * FROM empresas WHERE gestoria_id = ? AND activa = 1 ORDER BY nombre`,
    ).bind(sesion.gestoriaId).all();
    const seleccionadas = pedidas.length
      ? (empresas ?? []).filter((e) => pedidas.includes(e.id))
      : (empresas ?? []);
    if (!seleccionadas.length) throw noEncontrado('Ninguna empresa seleccionada');

    // Con varias empresas se devuelve un único informe consolidado en el
    // formato pedido, con una sección por empresa. Un ZIP obligaría a
    // comprimir en el Worker y a que la gestoría descomprima para nada.
    const informes = [];
    for (const empresa of seleccionadas) {
      informes.push(await informeDePeriodo(env, empresa, { desde, hasta }));
      await registrarAcceso(env.DB, {
        empresaId: empresa.id,
        actorTipo: 'gestoria',
        actorId: sesion.actorId,
        accion: 'exportacion',
        recurso: `masiva ${desde}..${hasta}`,
        ip: peticion.headers.get('cf-connecting-ip'),
      });
    }

    const consolidado = consolidar(informes, { desde, hasta });
    const salida = exportar(formato, consolidado);
    return respuestaDescarga(salida, nombreFichero(consolidado, salida.extension));
  });

  // --- Ajustes de empresa -------------------------------------------------

  /**
   * Ajustes que cambian el comportamiento del motor y del fichaje. La
   * geolocalización sólo se activa con una justificación escrita: es
   * tratamiento de datos y hay que poder explicar por qué.
   */
  router.patch('/api/empresa', async ({ env, sesion, empresa, cuerpo, peticion }) => {
    if (sesion.actorTipo === 'empleado' || sesion.actorTipo === 'inspeccion') throw prohibido();

    const cambios = {};
    for (const campo of ['nombre', 'cif', 'direccion', 'zona_horaria',
      'tolerancia_minutos', 'jornada_maxima_alerta_horas', 'avisos_email']) {
      if (campo in cuerpo) cambios[campo] = cuerpo[campo];
    }
    if ('avisos_modo' in cuerpo) {
      if (!['resumen_diario', 'inmediato'].includes(cuerpo.avisos_modo)) {
        throw malaPeticion('Modo de aviso no válido');
      }
      cambios.avisos_modo = cuerpo.avisos_modo;
    }
    if ('geolocalizacion_activa' in cuerpo) {
      const activa = Boolean(cuerpo.geolocalizacion_activa);
      const motivo = String(cuerpo.geolocalizacion_motivo ?? '').trim();
      if (activa && motivo.length < 20) {
        throw malaPeticion(
          'Para activar la geolocalización hay que dejar por escrito la justificación '
          + 'del tratamiento (mínimo 20 caracteres)',
        );
      }
      cambios.geolocalizacion_activa = activa ? 1 : 0;
      cambios.geolocalizacion_motivo = activa ? motivo : null;
    }
    if (!Object.keys(cambios).length) throw malaPeticion('Nada que cambiar');

    const campos = Object.keys(cambios);
    await env.DB.prepare(
      `UPDATE empresas SET ${campos.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    ).bind(...campos.map((c) => cambios[c]), empresa.id).run();

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'modificacion',
      recurso: `ajustes de empresa: ${campos.join(', ')}`,
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    return json({ ok: true, cambios });
  });

  /** Resumen de la empresa para la portada del panel. */
  router.get('/api/empresa/resumen', async ({ sesion, datos, empresa }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido();
    const hoy = fechaLocal(ahoraUtc(), empresa.zona_horaria);
    return json({
      empresa: {
        id: empresa.id, nombre: empresa.nombre, numero: empresa.numero,
        codigo: empresa.codigo,
        zona_horaria: empresa.zona_horaria,
        tolerancia_minutos: empresa.tolerancia_minutos,
        jornada_maxima_alerta_horas: empresa.jornada_maxima_alerta_horas,
        geolocalizacion_activa: Boolean(empresa.geolocalizacion_activa),
        avisos_modo: empresa.avisos_modo,
        avisos_email: empresa.avisos_email,
      },
      fecha: hoy,
      plantilla: await datos.contar('empleados', { activo: 1 }),
      incidencias_abiertas: await datos.contar('incidencias', { estado: 'abierta' }),
      ausencias_pendientes: await datos.contar('ausencias', { estado: 'solicitada' }),
      correcciones_pendientes: await datos.contar('solicitudes_correccion', { estado: 'solicitada' }),
    });
  });

  // --- Acceso de Inspección ----------------------------------------------

  /**
   * Cuenta de sólo lectura, con alcance a una sola empresa y con caducidad.
   *
   * Esto NO implementa la orden ministerial: no existe todavía y no hay
   * especificación que implementar. Es el hueco preparado para que, cuando se
   * publique, un inspector pueda acceder en remoto sin ver el resto de la
   * plataforma y sin que haya que migrar nada.
   */
  router.post('/api/inspeccion/acceso', async ({ env, sesion, empresa, cuerpo, peticion }) => {
    if (sesion.actorTipo !== 'gestoria' && sesion.actorTipo !== 'empresa') throw prohibido();
    const dias = Math.min(Math.max(Number(cuerpo.dias ?? 30), 1), 90);
    const token = nuevoToken();

    await env.DB.prepare(
      `INSERT INTO accesos_inspeccion (id, empresa_id, token_hash, referencia, creado_por, creado_en, expira_en)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(
      nuevoId('ins'), empresa.id, await sha256Token(token),
      cuerpo.referencia ?? null, sesion.actorId, ahoraUtc(),
      new Date(Date.now() + dias * 86400_000).toISOString(),
    ).run();

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'alta',
      recurso: `acceso de inspeccion (${dias} dias)`,
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    // El token se enseña una sola vez: sólo se guarda su hash.
    return json({
      ok: true,
      token,
      caduca_en: new Date(Date.now() + dias * 86400_000).toISOString(),
      aviso: 'Anote el token ahora: no se puede volver a consultar. Es de sólo lectura '
        + 'y sólo da acceso a esta empresa.',
    }, 201);
  });

  router.get('/api/inspeccion/accesos', async ({ sesion, datos }) => {
    if (sesion.actorTipo === 'empleado' || sesion.actorTipo === 'inspeccion') throw prohibido();
    const filas = await datos.listar('accesos_inspeccion', {}, { orden: 'creado_en DESC' });
    return json({
      accesos: filas.map(({ token_hash, ...resto }) => ({
        ...resto,
        vigente: !resto.revocado_en && resto.expira_en > ahoraUtc(),
      })),
    });
  });

  router.post('/api/inspeccion/accesos/:id/revocar', async ({ sesion, datos, parametros }) => {
    if (sesion.actorTipo === 'empleado' || sesion.actorTipo === 'inspeccion') throw prohibido();
    const cambiadas = await datos.actualizar('accesos_inspeccion', { id: parametros.id },
      { revocado_en: ahoraUtc() });
    if (!cambiadas) throw noEncontrado('Acceso no encontrado');
    return json({ ok: true });
  });
}

/** Consolida varios informes en uno, para la exportación masiva. */
function consolidar(informes, periodo) {
  const empleados = [];
  for (const informe of informes) {
    for (const e of informe.empleados) {
      empleados.push({ ...e, nombre: `${informe.empresa.nombre} — ${e.nombre}` });
    }
  }
  const totales = empleados.reduce((a, e) => ({
    minutos_registrados: a.minutos_registrados + e.minutos_registrados,
    minutos_teoricos: a.minutos_teoricos + e.minutos_teoricos,
    minutos_exceso: a.minutos_exceso + e.minutos_exceso,
    dias_trabajados: a.dias_trabajados + e.dias_trabajados,
    total_dias_ausencia: a.total_dias_ausencia + e.total_dias_ausencia,
    total_incidencias: a.total_incidencias + e.total_incidencias,
  }), {
    minutos_registrados: 0, minutos_teoricos: 0, minutos_exceso: 0,
    dias_trabajados: 0, total_dias_ausencia: 0, total_incidencias: 0,
  });

  return {
    empresa: {
      id: 'consolidado',
      nombre: `${informes.length} empresas`,
      cif: null,
      zona_horaria: informes[0]?.empresa.zona_horaria ?? 'Europe/Madrid',
    },
    periodo,
    etiqueta_diferencia: informes[0]?.etiqueta_diferencia ?? 'Exceso sobre jornada teórica',
    empleados,
    totales,
    generado_en: new Date().toISOString(),
  };
}

/**
 * Contraseña inicial legible: tres grupos separados por guiones. Se dicta por
 * teléfono sin equivocarse, y da igual que sea poco entrópica porque nace
 * marcada para cambio obligatorio en el primer acceso.
 */
function passwordSugerida() {
  const silabas = ['ma', 'ro', 'ti', 'lu', 'pe', 'sa', 'no', 'de', 'val', 'sol', 'mar', 'gal'];
  const trozo = () => silabas[Math.floor(Math.random() * silabas.length)]
    + silabas[Math.floor(Math.random() * silabas.length)];
  return `${trozo()}-${trozo()}-${String(Math.floor(10 + Math.random() * 90))}`;
}

function codigoSugerido(nombre) {
  const base = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8);
  const sufijo = String(Math.floor(1000 + Math.random() * 9000));
  return `${base || 'EMPRESA'}-${sufijo}`;
}
