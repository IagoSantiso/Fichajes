/**
 * Aislamiento por empresa.
 *
 * La regla es que ninguna consulta se ejecuta sin filtrar por empresa_id y que
 * el filtro vive en la capa de datos, no repetido a mano en cada endpoint. Lo
 * que se comprueba aquí es que esa capa no se pueda esquivar por descuido.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entornoDePrueba, sembrar } from './ayudas/d1.js';
import { alcanceEmpresa } from '../src/lib/datos.js';

function sembrarDosEmpresas(db) {
  sembrar(db);
  db.prepare(
    `INSERT INTO empresas (id, gestoria_id, nombre, codigo, zona_horaria)
     VALUES ('emc_2','ges_1','Otra S.L.','OTRA','Europe/Madrid')`,
  ).run();
  db.prepare(
    `INSERT INTO empleados (id, empresa_id, nombre, apellidos)
     VALUES ('emp_2','emc_2','Luis','Soto')`,
  ).run();
}

test('un alcance sólo ve los datos de su empresa', async () => {
  const { db, env } = entornoDePrueba();
  sembrarDosEmpresas(db);

  const primera = alcanceEmpresa(env.DB, 'emc_1');
  const segunda = alcanceEmpresa(env.DB, 'emc_2');

  assert.deepEqual((await primera.listar('empleados')).map((e) => e.id), ['emp_1']);
  assert.deepEqual((await segunda.listar('empleados')).map((e) => e.id), ['emp_2']);
});

test('pedir por id un registro de otra empresa devuelve nada, no un error de permisos', async () => {
  const { db, env } = entornoDePrueba();
  sembrarDosEmpresas(db);

  const primera = alcanceEmpresa(env.DB, 'emc_1');
  assert.equal(await primera.uno('empleados', { id: 'emp_2' }), null);
});

test('el empresa_id de una inserción lo pone el alcance, no quien llama', async () => {
  const { db, env } = entornoDePrueba();
  sembrarDosEmpresas(db);

  const primera = alcanceEmpresa(env.DB, 'emc_1');
  // Aunque se intente colar otro empresa_id, se ignora.
  await primera.insertar('incidencias', {
    id: 'inc_1', empresa_id: 'emc_2', empleado_id: 'emp_1',
    fecha: '2026-09-10', tipo: 'jornada_no_cerrada', estado: 'abierta',
  });

  const fila = db.prepare(`SELECT empresa_id FROM incidencias WHERE id = 'inc_1'`).get();
  assert.equal(fila.empresa_id, 'emc_1');
});

test('un UPDATE no puede alcanzar filas de otra empresa', async () => {
  const { db, env } = entornoDePrueba();
  sembrarDosEmpresas(db);

  const primera = alcanceEmpresa(env.DB, 'emc_1');
  const cambiadas = await primera.actualizar('empleados', { id: 'emp_2' }, { nombre: 'Suplantado' });

  assert.equal(cambiadas, 0);
  assert.equal(db.prepare(`SELECT nombre FROM empleados WHERE id='emp_2'`).get().nombre, 'Luis');
});

test('no se puede abrir un alcance sin empresa', () => {
  const { env } = entornoDePrueba();
  assert.throws(() => alcanceEmpresa(env.DB, null), /sin empresa_id/);
  assert.throws(() => alcanceEmpresa(env.DB, ''), /sin empresa_id/);
});

test('el alcance no permite modificar ni borrar fichajes', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);
  const alcance = alcanceEmpresa(env.DB, 'emc_1');

  await assert.rejects(() => alcance.actualizar('fichajes', { id: 'x' }, { tipo: 'salida' }),
    /inmutables/);
  await assert.rejects(() => alcance.borrar('fichajes', { id: 'x' }), /inmutables/);
});

test('una consulta a medida sin filtro de empresa se rechaza', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);
  const alcance = alcanceEmpresa(env.DB, 'emc_1');

  await assert.rejects(
    () => alcance.consulta('SELECT * FROM fichajes'),
    /debe filtrar por :empresa/,
  );
});

test('una consulta a medida coloca los parámetros en su sitio', async () => {
  const { db, env } = entornoDePrueba();
  sembrarDosEmpresas(db);

  const alcance = alcanceEmpresa(env.DB, 'emc_1');
  const filas = await alcance.consulta(
    `SELECT id FROM empleados WHERE empresa_id = :empresa AND nombre = ?`,
    ['Ana'],
  );
  assert.deepEqual(filas.map((f) => f.id), ['emp_1']);

  const vacio = await alcance.consulta(
    `SELECT id FROM empleados WHERE empresa_id = :empresa AND nombre = ?`,
    ['Luis'],
  );
  assert.deepEqual(vacio, []);
});

test('sólo se admiten tablas de datos declaradas con empresa_id', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);
  const alcance = alcanceEmpresa(env.DB, 'emc_1');

  await assert.rejects(() => alcance.listar('usuarios'), /no es una tabla de datos/);
  await assert.rejects(() => alcance.listar('empresas'), /no es una tabla de datos/);
  await assert.rejects(() => alcance.listar('sesiones'), /no es una tabla de datos/);
});

test('los nombres de campo y de tabla no admiten inyección', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);
  const alcance = alcanceEmpresa(env.DB, 'emc_1');

  await assert.rejects(
    () => alcance.listar('empleados; DROP TABLE fichajes'),
    /Identificador no válido/,
  );
  await assert.rejects(
    () => alcance.listar('empleados', { 'nombre = 1 OR 1': 1 }),
    /Identificador no válido/,
  );
});
