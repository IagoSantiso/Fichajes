/**
 * Pasa el motor de incidencias sobre todos los días del mes en curso.
 *
 * Complemento de generar-mes.mjs: los fichajes generados producen jornadas sin
 * cerrar y entradas fuera de tolerancia, y esto es lo que las convierte en
 * incidencias visibles en los paneles. Es idempotente, como el cron.
 *
 *   node semillas/pasar-motor.mjs [empresa_id]
 */
import { ejecutarParaEmpresa, ejecutarExcesoMensual } from '../src/incidencias/motor.js';
import { sumarDias } from '../src/lib/tiempo.js';
import { abrirD1Local } from './d1-local.mjs';

const EMPRESA = process.argv[2] ?? 'emc_dev';
const { db, env } = abrirD1Local();

const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(EMPRESA);
if (!empresa) {
  console.error(`No existe la empresa ${EMPRESA}`);
  process.exit(1);
}

const hoy = new Date().toISOString().slice(0, 10);
let fecha = `${hoy.slice(0, 7)}-01`;
let total = 0;

while (fecha <= hoy) {
  // Los días pasados tienen la jornada cerrada por definición; el de hoy, no.
  const { nuevas } = await ejecutarParaEmpresa(env, empresa, fecha, {
    jornadaCerrada: fecha < hoy,
  });
  if (nuevas.length) {
    console.log(`${fecha}: ${nuevas.length} incidencia(s)`);
    for (const n of nuevas) console.log(`    · ${n.empleado}: ${n.descripcion}`);
  }
  total += nuevas.length;
  fecha = sumarDias(fecha, 1);
}

const mensuales = await ejecutarExcesoMensual(env, empresa, hoy);
total += mensuales.length;
for (const n of mensuales) console.log(`${n.fecha}: ${n.empleado}: ${n.descripcion}`);

console.log(`\n${total} incidencias en total.`);
