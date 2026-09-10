/**
 * Log de accesos.
 *
 * El borrador del RD reconoce derecho de acceso al trabajador, a la
 * representación legal y a la Inspección. Llegado el caso hay que poder
 * acreditar quién consultó qué, así que esto se escribe desde el primer día y
 * en todas las lecturas de datos ajenos, no sólo en las exportaciones.
 */
import { nuevoId } from './ids.js';
import { ahoraUtc } from './tiempo.js';

export async function registrarAcceso(db, {
  empresaId = null,
  actorTipo,
  actorId = null,
  accion,
  recurso = null,
  empleadoAfectadoId = null,
  ip = null,
}) {
  await db.prepare(
    `INSERT INTO log_accesos
       (id, empresa_id, actor_tipo, actor_id, accion, recurso,
        empleado_afectado_id, timestamp_utc, ip)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(
    nuevoId('log'), empresaId, actorTipo, actorId, accion, recurso,
    empleadoAfectadoId, ahoraUtc(), ip,
  ).run();
}
