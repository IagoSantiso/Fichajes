/**
 * Acceso de Inspección: sólo lectura, una empresa, con caducidad.
 *
 * Advertencia deliberada: esto no implementa el acceso remoto que prevé el
 * borrador del Real Decreto, porque las especificaciones técnicas irán en una
 * orden ministerial que a fecha de hoy sigue en fase previa. Lo que hay aquí
 * es la estructura para que ese acceso sea después un adaptador más y no una
 * migración: alcance limitado, caducidad, sólo lectura y todo registrado en el
 * log de accesos.
 */
import { json, noAutenticado, prohibido } from '../lib/respuestas.js';
import { sha256Token } from '../lib/auth.js';
import { ahoraUtc } from '../lib/tiempo.js';
import { registrarAcceso } from '../lib/log.js';

/**
 * Resuelve un token de inspección presentado en la cabecera. Devuelve una
 * sesión equivalente a la de un actor 'inspeccion', que el enrutador limita a
 * rutas de lectura.
 */
export async function sesionDeInspeccion(peticion, env) {
  const cabecera = peticion.headers.get('authorization') ?? '';
  if (!cabecera.startsWith('Inspeccion ')) return null;
  const token = cabecera.slice('Inspeccion '.length).trim();
  if (!token) return null;

  const fila = await env.DB.prepare(
    `SELECT * FROM accesos_inspeccion WHERE token_hash = ? AND revocado_en IS NULL`,
  ).bind(await sha256Token(token)).first();
  if (!fila || fila.expira_en <= ahoraUtc()) return null;

  return {
    id: fila.id,
    actorTipo: 'inspeccion',
    actorId: fila.id,
    empresaId: fila.empresa_id,
    gestoriaId: null,
  };
}

/** Rutas de lectura pensadas para una actuación inspectora. */
export function registrarRutasInspeccion(router) {
  router.get('/api/inspeccion/empresa', async ({ env, sesion, empresa, peticion }) => {
    if (sesion?.actorTipo !== 'inspeccion') throw prohibido();
    const acceso = await env.DB.prepare(
      `SELECT referencia, expira_en FROM accesos_inspeccion WHERE id = ?`,
    ).bind(sesion.actorId).first();

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: 'inspeccion',
      actorId: sesion.actorId,
      accion: 'consulta',
      recurso: 'ficha de empresa',
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    return json({
      empresa: {
        id: empresa.id,
        nombre: empresa.nombre,
        cif: empresa.cif,
        direccion: empresa.direccion,
        zona_horaria: empresa.zona_horaria,
      },
      acceso: {
        referencia: acceso?.referencia ?? null,
        caduca_en: acceso?.expira_en ?? null,
        alcance: 'sólo lectura, limitado a esta empresa',
      },
      aviso: 'Los registros se conservan cuatro años desde cada anotación (art. 34.9 ET). '
        + 'La integridad se acredita mediante encadenamiento SHA-256 verificable en '
        + '/api/fichajes/verificar-cadena.',
    });
  });
}

/** Rutas que un token de inspección puede recorrer. Todo lo demás, prohibido. */
export const RUTAS_INSPECCION = [
  'GET /api/inspeccion/empresa',
  'GET /api/auth/yo',
  'GET /api/empleados',
  'GET /api/fichajes/empleado/:id',
  'GET /api/fichajes/rejilla',
  'GET /api/fichajes/verificar-cadena',
  'GET /api/informes',
  'GET /api/informes/integridad',
  'GET /api/informes/accesos',
  'GET /api/exportacion',
  'GET /api/exportacion/empleado/:id',
  'GET /api/exportacion/formatos',
  'GET /api/calendario',
  'GET /api/ausencias',
  'GET /api/incidencias',
];
