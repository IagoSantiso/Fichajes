/**
 * Vuelca los datos de la base local a un fichero .sql aplicable en D1 remoto.
 *
 * `generar-mes.mjs` y `pasar-motor.mjs` escriben directamente sobre el SQLite
 * de miniflare, que es local. Para que una demostración desplegada en
 * Cloudflare no salga con todas las rejillas vacías hace falta llevar esos
 * datos al otro lado, y la vía que D1 ofrece para eso es un fichero de SQL:
 *
 *   node semillas/volcar-demo.mjs
 *   npx wrangler d1 execute fichajes --remote --file=./semillas/demo-completa.sql
 *
 * El fichero que sale es autocontenido: incluye la gestoría, la empresa, la
 * plantilla, los horarios, el calendario y el mes de fichajes con sus
 * incidencias. Se puede aplicar sobre una base recién migrada y vacía.
 *
 * Las sentencias van con INSERT OR IGNORE para que reaplicarlo no duplique
 * nada. No se borra nada antes: la tabla de fichajes es append-only y su
 * disparador aborta cualquier DELETE, también el que viniera de aquí.
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirD1Local } from './d1-local.mjs';

/**
 * Orden de volcado. Importa: las claves ajenas exigen que la gestoría exista
 * antes que la empresa, la empresa antes que el empleado, y así.
 *
 * Quedan fuera a propósito:
 *  - `sesiones` y `enlaces_magicos`, que son infraestructura de acceso y no
 *    tendría sentido trasladar.
 *  - `log_accesos`, que es la traza de quién consultó qué en *esta* máquina.
 *  - `accesos_inspeccion`, que son credenciales.
 */
const TABLAS = [
  'gestorias',
  'empresas',
  'usuarios',
  'empleados',
  'horarios_teoricos',
  'calendario_laboral',
  'fichajes',
  'ausencias',
  'solicitudes_correccion',
  'incidencias',
];

const AQUI = dirname(fileURLToPath(import.meta.url));
const DESTINO = process.argv[2] ?? join(AQUI, 'demo-completa.sql');

const { db } = abrirD1Local();

/** Convierte un valor de SQLite en un literal SQL. */
function literal(valor) {
  if (valor === null || valor === undefined) return 'NULL';
  if (typeof valor === 'number') return String(valor);
  if (typeof valor === 'bigint') return String(valor);
  // Las cadenas se escapan doblando la comilla simple, que es como lo hace SQL.
  return `'${String(valor).replace(/'/g, "''")}'`;
}

const lineas = [
  '-- Datos de demostración generados por semillas/volcar-demo.mjs',
  `-- Volcado el ${new Date().toISOString()}`,
  '--',
  '-- Aplicar sobre una base ya migrada:',
  '--   npx wrangler d1 execute fichajes --remote --file=./semillas/demo-completa.sql',
  '--',
  '-- NO usar con datos reales: sobreescribe la demostración, no la complementa.',
  '',
];

let total = 0;
for (const tabla of TABLAS) {
  const filas = db.prepare(`SELECT * FROM ${tabla}`).all();
  if (!filas.length) continue;

  lineas.push(`-- ${tabla}: ${filas.length} fila(s)`);
  const columnas = Object.keys(filas[0]);
  for (const fila of filas) {
    const valores = columnas.map((c) => literal(fila[c])).join(',');
    lineas.push(`INSERT OR IGNORE INTO ${tabla} (${columnas.join(',')}) VALUES (${valores});`);
  }
  lineas.push('');
  total += filas.length;
  console.log(`  ${tabla}: ${filas.length}`);
}

writeFileSync(DESTINO, lineas.join('\n'), 'utf8');
console.log(`\n${total} filas volcadas en ${DESTINO}`);
console.log('\nAplíquelo en remoto con:');
console.log('  npx wrangler d1 execute fichajes --remote --file=./semillas/demo-completa.sql');
