/**
 * Volcado de datos de demostración.
 *
 * El fichero que genera `semillas/volcar-demo.mjs` se aplica sobre D1 remoto,
 * donde no hay forma cómoda de depurar si sale mal. Lo que se comprueba aquí
 * es que carga en una base recién migrada, que reaplicarlo no duplica nada, y
 * —lo importante— que la cadena de integridad de los fichajes sobrevive al
 * viaje: un volcado que reordenase los registros la rompería en silencio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { crearBaseDePrueba } from './ayudas/d1.js';
import { verificarCadena } from '../src/lib/hash.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const VOLCADO = join(RAIZ, 'semillas', 'demo-completa.sql');

/**
 * El volcado lo produce un script que lee la base local de miniflare, que no
 * existe en integración continua. Si no está el fichero, no hay nada que
 * comprobar: se genera con `node semillas/volcar-demo.mjs`.
 */
const hayVolcado = existsSync(VOLCADO);

test('el volcado de demostración carga en una base recién migrada', { skip: !hayVolcado }, async () => {
  const { db } = crearBaseDePrueba();
  db.exec(readFileSync(VOLCADO, 'utf8'));

  const empresas = db.prepare('SELECT COUNT(*) AS n FROM empresas').get().n;
  const empleados = db.prepare('SELECT COUNT(*) AS n FROM empleados').get().n;
  assert.ok(empresas > 0, 'debe traer al menos una empresa');
  assert.ok(empleados > 0, 'debe traer plantilla');
});

test('reaplicar el volcado no duplica filas', { skip: !hayVolcado }, async () => {
  const { db } = crearBaseDePrueba();
  const sql = readFileSync(VOLCADO, 'utf8');

  db.exec(sql);
  const primera = db.prepare('SELECT COUNT(*) AS n FROM fichajes').get().n;
  db.exec(sql);
  const segunda = db.prepare('SELECT COUNT(*) AS n FROM fichajes').get().n;

  assert.equal(segunda, primera, 'INSERT OR IGNORE debe hacer inocua la reaplicación');
});

test('la cadena de integridad sobrevive al volcado', { skip: !hayVolcado }, async () => {
  const { db } = crearBaseDePrueba();
  db.exec(readFileSync(VOLCADO, 'utf8'));

  const empresas = db.prepare('SELECT id FROM empresas').all();
  for (const { id } of empresas) {
    const filas = db.prepare(
      'SELECT * FROM fichajes WHERE empresa_id = ? ORDER BY rowid ASC',
    ).all(id);
    if (!filas.length) continue;

    const resultado = await verificarCadena(filas);
    assert.equal(resultado.valida, true,
      `la cadena de ${id} se rompe tras el volcado: ${JSON.stringify(resultado)}`);
  }
});

test('el volcado no arrastra sesiones, credenciales ni traza de accesos', { skip: !hayVolcado }, () => {
  const sql = readFileSync(VOLCADO, 'utf8');
  for (const tabla of ['sesiones', 'enlaces_magicos', 'log_accesos', 'accesos_inspeccion']) {
    assert.ok(!sql.includes(`INTO ${tabla} `),
      `el volcado no debe incluir ${tabla}`);
  }
});

// --- Reparación de claves ---------------------------------------------------

/**
 * semillas/resetear-claves-demo.sql existe porque ya pasó una vez: el volcado
 * de demostración se quedó desactualizado respecto al esquema y las cuentas de
 * panel llegaron a un despliegue real con la contraseña vacía. INSERT OR
 * IGNORE no corrige una fila que ya existe, así que recargar el volcado no
 * arregla nada; hace falta este script aparte.
 */
test('el script de reparación deja entrar con las claves documentadas', async () => {
  const RESETEO = join(RAIZ, 'semillas', 'resetear-claves-demo.sql');
  const { db } = crearBaseDePrueba();
  db.exec(readFileSync(join(RAIZ, 'semillas', 'desarrollo.sql'), 'utf8'));

  // Reproduce el estado roto: la contraseña llegó vacía y el PIN es otro.
  db.exec(`UPDATE usuarios SET password_hash = NULL`);
  db.exec(`UPDATE empleados SET pin_hash = 'no-es-este'`);

  db.exec(readFileSync(RESETEO, 'utf8'));

  const { verificarSecreto } = await import('../src/lib/auth.js');
  const gestor = db.prepare(`SELECT password_hash FROM usuarios WHERE email='gestor@ejemplo.es'`).get();
  const jefe = db.prepare(`SELECT password_hash FROM usuarios WHERE email='jefe@soldaduras.ejemplo'`).get();
  const ana = db.prepare(`SELECT pin_hash FROM empleados WHERE id='emp_ana'`).get();

  assert.equal(await verificarSecreto('fichajes2026', gestor.password_hash), true);
  assert.equal(await verificarSecreto('fichajes2026', jefe.password_hash), true);
  assert.equal(await verificarSecreto('482915', ana.pin_hash), true);
});

test('la contraseña de la demo y el PIN de la demo no son el mismo hash', () => {
  // Es justo el fallo que se coló al escribir el script de reparación: extraer
  // el primer hash del fichero por descuido, en lugar del que tocaba.
  const sql = readFileSync(join(RAIZ, 'semillas', 'resetear-claves-demo.sql'), 'utf8');
  const hashes = [...sql.matchAll(/'(pbkdf2\$[^']+)'/g)].map((m) => m[1]);
  assert.equal(hashes.length, 2, 'debe haber exactamente un hash de contraseña y uno de PIN');
  assert.notEqual(hashes[0], hashes[1], 'la contraseña y el PIN de la demo deben llevar hashes distintos');
});
