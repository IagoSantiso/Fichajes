/**
 * Orquesta la generación de un mes de fichajes e incidencias para *todas*
 * las empresas que haya en la base local, no sólo la de referencia.
 *
 * Pensado para la demo con varias empresas (ver multiempresa.sql): en vez de
 * llamar a generar-mes.mjs y pasar-motor.mjs empresa por empresa, este script
 * los invoca para cada una.
 *
 *   npx wrangler d1 execute fichajes --local --file=./semillas/desarrollo.sql
 *   npx wrangler d1 execute fichajes --local --file=./semillas/multiempresa.sql
 *   node semillas/generar-demo-completa.mjs
 *   node semillas/volcar-demo.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { abrirD1Local } from './d1-local.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const { db } = abrirD1Local();

const empresas = db.prepare('SELECT id, nombre FROM empresas ORDER BY numero').all();
if (!empresas.length) {
  console.error('No hay ninguna empresa en la base local. Cargue antes una semilla.');
  process.exit(1);
}

for (const script of ['generar-mes.mjs', 'pasar-motor.mjs']) {
  for (const empresa of empresas) {
    console.log(`\n▶ ${script} ${empresa.id}  (${empresa.nombre})`);
    const resultado = spawnSync('node', [join(AQUI, script), empresa.id], { stdio: 'inherit' });
    if (resultado.status !== 0) {
      console.error(`Falló ${script} para ${empresa.id}`);
      process.exit(resultado.status ?? 1);
    }
  }
}

console.log(`\n${empresas.length} empresas con un mes de fichajes e incidencias generado.`);
console.log('Ahora vuelque el resultado con: node semillas/volcar-demo.mjs');
