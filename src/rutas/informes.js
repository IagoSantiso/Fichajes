/**
 * Informes y exportación.
 *
 * Toda salida de datos pasa por el módulo de exportación: estas rutas calculan
 * y delegan, nunca serializan por su cuenta. Cuando la orden ministerial exista
 * y haya que mandar los registros a la Inspección, el cambio será registrar un
 * adaptador nuevo, no tocar esto.
 */
import { json, malaPeticion, prohibido, noEncontrado } from '../lib/respuestas.js';
import { informeDePeriodo, detalleDiario } from '../lib/informes.js';
import { exportar, listarAdaptadores, nombreFichero } from '../exportacion/index.js';
import { resolverPeriodo, etiquetaPeriodo } from '../lib/tiempo.js';
import { verificarCadenaEmpresa } from '../lib/fichajes.js';
import { registrarAcceso } from '../lib/log.js';

export function registrarRutasInformes(router) {
  router.get('/api/exportacion/formatos', async () => json({ formatos: listarAdaptadores() }));

  /** Informe del periodo, en JSON, para pintarlo en el panel. */
  router.get('/api/informes', async ({ env, sesion, empresa, url, peticion }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido('Consulte «Mis fichajes»');
    const { desde, hasta, etiqueta } = periodoDeUrl(url);
    const informe = await informeDePeriodo(env, empresa, { desde, hasta });

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'consulta',
      recurso: `informe ${desde}..${hasta}`,
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    return json({ ...informe, etiqueta_periodo: etiqueta });
  });

  /**
   * Exportación del periodo. `formato` acepta 'pdf', 'csv' o 'nombre@version',
   * para poder reproducir un informe con el mismo adaptador con que se emitió.
   */
  router.get('/api/exportacion', async ({ env, sesion, empresa, url, peticion }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido();
    const formato = url.searchParams.get('formato') ?? 'pdf';
    const { desde, hasta } = periodoDeUrl(url);

    const informe = await informeDePeriodo(env, empresa, { desde, hasta });
    const salida = exportar(formato, informe);

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'exportacion',
      recurso: `${salida.adaptador} ${desde}..${hasta}`,
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    return respuestaDescarga(salida, nombreFichero(informe, salida.extension));
  });

  /**
   * Registro diario de un empleado. El trabajador puede descargar el suyo:
   * el artículo 34.9 le reconoce el derecho de acceso y hacerlo pasar por la
   * empresa convierte un derecho en un favor.
   */
  router.get('/api/exportacion/empleado/:id', async ({ env, sesion, empresa, parametros, url, peticion }) => {
    if (sesion.actorTipo === 'empleado' && sesion.actorId !== parametros.id) throw prohibido();
    const formato = url.searchParams.get('formato') ?? 'pdf';
    const { desde, hasta } = periodoDeUrl(url);

    const detalle = await detalleDiario(env, empresa, { empleadoId: parametros.id, desde, hasta });
    if (!detalle) throw noEncontrado('Empleado no encontrado');
    detalle.empresa.zona_horaria = empresa.zona_horaria;

    const salida = exportar(formato, detalle, { detalle: 'diario' });

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'exportacion',
      recurso: `detalle diario ${salida.adaptador} ${desde}..${hasta}`,
      empleadoAfectadoId: parametros.id,
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    const nombre = `jornada-${detalle.empleado.nombre.replace(/\s+/g, '-').toLowerCase()}-${desde}_${hasta}.${salida.extension}`;
    return respuestaDescarga(salida, nombre);
  });

  /**
   * Certificado de integridad: verificación de la cadena de la empresa con el
   * hash de cierre. Es la respuesta corta a «cómo demuestro que esto no se ha
   * manipulado» mientras no exista la orden ministerial que lo regule.
   */
  router.get('/api/informes/integridad', async ({ env, sesion, empresa, peticion }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido();
    const resultado = await verificarCadenaEmpresa(env, empresa.id);
    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: sesion.actorTipo,
      actorId: sesion.actorId,
      accion: 'consulta',
      recurso: 'certificado de integridad',
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    return json({
      empresa: { id: empresa.id, nombre: empresa.nombre },
      verificado_en: new Date().toISOString(),
      ...resultado,
      nota: 'Verificación de la cadena de hashes SHA-256 de los fichajes de esta empresa. '
        + 'No constituye certificación oficial: a fecha de hoy no existe ninguna.',
    });
  });

  /** Log de accesos de la empresa. Lo pide la Inspección y lo pide el comité. */
  router.get('/api/informes/accesos', async ({ sesion, datos, url }) => {
    if (sesion.actorTipo === 'empleado') throw prohibido();
    const desde = url.searchParams.get('desde');
    const condiciones = desde ? { timestamp_utc: { op: '>=', valor: desde } } : {};
    const filas = await datos.listar('log_accesos', condiciones,
      { orden: 'timestamp_utc DESC', limite: Number(url.searchParams.get('limite') ?? 500) });
    return json({ accesos: filas });
  });
}

function periodoDeUrl(url) {
  const desde = url.searchParams.get('desde');
  const hasta = url.searchParams.get('hasta');
  if (desde && hasta) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
      throw malaPeticion('Fechas no válidas');
    }
    return { desde, hasta, etiqueta: `${desde} a ${hasta}` };
  }
  const clase = url.searchParams.get('periodo') ?? 'mes';
  if (!['mes', 'trimestre', 'semestre', 'anio'].includes(clase)) {
    throw malaPeticion('Periodo no válido. Use mes, trimestre, semestre o anio');
  }
  const ahora = new Date();
  const anio = Number(url.searchParams.get('anio') ?? ahora.getUTCFullYear());
  const indice = Number(url.searchParams.get('indice') ?? (ahora.getUTCMonth() + 1));
  return { ...resolverPeriodo(clase, anio, indice), etiqueta: etiquetaPeriodo(clase, anio, indice) };
}

export function respuestaDescarga(salida, nombre) {
  return new Response(salida.contenido, {
    headers: {
      'content-type': salida.tipoContenido,
      'content-disposition': `attachment; filename="${nombre}"`,
      'cache-control': 'no-store',
      'x-adaptador-exportacion': salida.adaptador,
    },
  });
}

export { periodoDeUrl };
