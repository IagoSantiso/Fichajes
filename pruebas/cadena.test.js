/**
 * La cadena de integridad y la inmutabilidad de los fichajes.
 *
 * Son las dos decisiones que cuestan poco hoy y son carísimas de introducir
 * con dos años de datos acumulados, así que son las que más pruebas merecen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entornoDePrueba, sembrar } from './ayudas/d1.js';
import {
  registrarFichaje, registrarRectificacion, registrarAnulacion, registrarAltaManual,
  fichajesEfectivos, estadoActual, minutosTrabajados, verificarCadenaEmpresa,
} from '../src/lib/fichajes.js';
import { verificarCadena, calcularHash, HASH_GENESIS } from '../src/lib/hash.js';

function fichar(env, empresa, tipo, extra = {}) {
  return registrarFichaje(env, empresa, {
    empleadoId: 'emp_1', tipo, origen: 'pwa',
    autorId: 'emp_1', autorTipo: 'empleado', ...extra,
  });
}

test('el primer fichaje de una empresa arranca en GENESIS', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);

  const fichaje = await fichar(env, empresa, 'entrada');
  assert.equal(fichaje.hash_anterior, HASH_GENESIS);
  assert.match(fichaje.hash, /^[0-9a-f]{64}$/);
});

test('cada fichaje encadena el hash del anterior de su empresa', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);

  const primero = await fichar(env, empresa, 'entrada');
  const segundo = await fichar(env, empresa, 'inicio_pausa');
  const tercero = await fichar(env, empresa, 'fin_pausa');

  assert.equal(segundo.hash_anterior, primero.hash);
  assert.equal(tercero.hash_anterior, segundo.hash);

  const resultado = await verificarCadenaEmpresa(env, empresa.id);
  assert.equal(resultado.valida, true);
  assert.equal(resultado.verificados, 3);
});

test('la cadena es por empresa: una no depende de la otra', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);

  db.prepare(
    `INSERT INTO empresas (id, gestoria_id, nombre, codigo, zona_horaria)
     VALUES ('emc_2','ges_1','Otra S.L.','OTRA','Europe/Madrid')`,
  ).run();
  db.prepare(
    `INSERT INTO empleados (id, empresa_id, nombre, apellidos)
     VALUES ('emp_2','emc_2','Luis','Soto')`,
  ).run();
  const otra = { ...empresa, id: 'emc_2', nombre: 'Otra S.L.' };

  await fichar(env, empresa, 'entrada');
  const suyo = await registrarFichaje(env, otra, {
    empleadoId: 'emp_2', tipo: 'entrada', autorId: 'emp_2', autorTipo: 'empleado',
  });

  // El primero de la segunda empresa también arranca en GENESIS.
  assert.equal(suyo.hash_anterior, HASH_GENESIS);
  assert.equal((await verificarCadenaEmpresa(env, empresa.id)).valida, true);
  assert.equal((await verificarCadenaEmpresa(env, 'emc_2')).valida, true);
});

test('la base de datos rechaza cualquier UPDATE sobre fichajes', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  const fichaje = await fichar(env, empresa, 'entrada');

  assert.throws(
    () => db.prepare(`UPDATE fichajes SET tipo = 'salida' WHERE id = ?`).run(fichaje.id),
    /inmutables/,
  );
});

test('la base de datos rechaza cualquier DELETE sobre fichajes', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  const fichaje = await fichar(env, empresa, 'entrada');

  assert.throws(
    () => db.prepare(`DELETE FROM fichajes WHERE id = ?`).run(fichaje.id),
    /inmutables/,
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM fichajes`).get().n, 1);
});

test('corregir es insertar una rectificación; el original permanece en la traza', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);

  const original = await fichar(env, empresa, 'entrada');
  const rectificacion = await registrarRectificacion(env, empresa, {
    fichajeId: original.id,
    timestampUtcCorregido: '2026-09-10T06:15:00Z',
    motivo: 'El trabajador fichó al llegar a la oficina y no a la obra',
    autorId: 'usu_1',
    autorTipo: 'empresa',
  });

  assert.equal(rectificacion.tipo_registro, 'rectificacion');
  assert.equal(rectificacion.fichaje_referenciado_id, original.id);

  const { results } = await env.DB.prepare(
    `SELECT * FROM fichajes WHERE empresa_id = ? ORDER BY rowid`,
  ).bind(empresa.id).all();

  // Los dos siguen en la tabla; sólo la rectificación cuenta a efectos de jornada.
  assert.equal(results.length, 2);
  const efectivos = fichajesEfectivos(results);
  assert.equal(efectivos.length, 1);
  assert.equal(efectivos[0].id, rectificacion.id);
  assert.equal((await verificarCadenaEmpresa(env, empresa.id)).valida, true);
});

test('no se puede rectificar dos veces el mismo fichaje', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  const original = await fichar(env, empresa, 'entrada');

  const opciones = {
    fichajeId: original.id,
    timestampUtcCorregido: '2026-09-10T06:15:00Z',
    motivo: 'primera corrección',
    autorId: 'usu_1',
    autorTipo: 'empresa',
  };
  await registrarRectificacion(env, empresa, opciones);
  await assert.rejects(
    () => registrarRectificacion(env, empresa, { ...opciones, motivo: 'segunda' }),
    /ya tiene una corrección posterior/,
  );
});

test('la rectificación y la anulación exigen motivo', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  const original = await fichar(env, empresa, 'entrada');

  await assert.rejects(
    () => registrarRectificacion(env, empresa, {
      fichajeId: original.id, motivo: '   ', autorId: 'u', autorTipo: 'empresa',
    }),
    /motivo/,
  );
  await assert.rejects(
    () => registrarAnulacion(env, empresa, {
      fichajeId: original.id, motivo: '', autorId: 'u', autorTipo: 'empresa',
    }),
    /motivo/,
  );
});

test('anular deja el fichaje fuera del cálculo sin borrarlo', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);

  const entrada = await fichar(env, empresa, 'entrada');
  const salida = await fichar(env, empresa, 'salida');
  await registrarAnulacion(env, empresa, {
    fichajeId: salida.id, motivo: 'Fichaje duplicado por error',
    autorId: 'usu_1', autorTipo: 'empresa',
  });

  const { results } = await env.DB.prepare(
    `SELECT * FROM fichajes WHERE empresa_id = ? ORDER BY rowid`,
  ).bind(empresa.id).all();

  assert.equal(results.length, 3);
  const efectivos = fichajesEfectivos(results);
  assert.deepEqual(efectivos.map((f) => f.id), [entrada.id]);
  assert.equal(estadoActual(results), 'dentro');
});

test('la verificación detecta una manipulación de los campos', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  await fichar(env, empresa, 'entrada');
  await fichar(env, empresa, 'salida');

  const { results } = await env.DB.prepare(
    `SELECT * FROM fichajes WHERE empresa_id = ? ORDER BY rowid`,
  ).bind(empresa.id).all();

  // Se altera el registro en memoria, como haría quien tocase la base de datos
  // por detrás saltándose los disparadores.
  const manipulados = results.map((f) => ({ ...f }));
  manipulados[1].timestamp_utc = '2026-09-10T20:00:00Z';

  const resultado = await verificarCadena(manipulados);
  assert.equal(resultado.valida, false);
  assert.equal(resultado.motivo, 'hash_no_coincide');
  assert.equal(resultado.posicion, 1);
});

test('la verificación detecta un eslabón que falta', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  await fichar(env, empresa, 'entrada');
  await fichar(env, empresa, 'inicio_pausa');
  await fichar(env, empresa, 'fin_pausa');

  const { results } = await env.DB.prepare(
    `SELECT * FROM fichajes WHERE empresa_id = ? ORDER BY rowid`,
  ).bind(empresa.id).all();

  const sinElDelMedio = [results[0], results[2]];
  const resultado = await verificarCadena(sinElDelMedio);
  assert.equal(resultado.valida, false);
  assert.equal(resultado.motivo, 'eslabon_roto');
});

test('el hash depende de los campos sustantivos y no de la IP ni del user agent', async () => {
  const base = {
    id: 'fic_1', empresa_id: 'emc_1', empleado_id: 'emp_1', tipo: 'entrada',
    timestamp_utc: '2026-09-10T06:00:00Z', zona_horaria: 'Europe/Madrid',
    timestamp_declarado: null, diferido: 0, origen: 'pwa',
    tipo_evento: null, modalidad: null, naturaleza_hora: null,
    autor_id: 'emp_1', autor_tipo: 'empleado', tipo_registro: 'original',
    fichaje_referenciado_id: null, motivo: null,
  };

  const conIp = await calcularHash({ ...base, ip: '1.2.3.4', user_agent: 'X' }, HASH_GENESIS);
  const sinIp = await calcularHash(base, HASH_GENESIS);
  assert.equal(conIp, sinIp);

  const otroTipo = await calcularHash({ ...base, tipo: 'salida' }, HASH_GENESIS);
  assert.notEqual(otroTipo, sinIp);
});

test('un fichaje diferido guarda las dos marcas y se marca como tal', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);

  const declarado = new Date(Date.now() - 45 * 60_000).toISOString();
  const fichaje = await fichar(env, empresa, 'entrada', { timestampDeclarado: declarado });

  assert.equal(fichaje.diferido, 1);
  assert.equal(fichaje.timestamp_declarado, declarado);
  // El sello de servidor es el de recepción, no el declarado por el cliente.
  assert.notEqual(fichaje.timestamp_utc, declarado);
  // Y el día al que pertenece es el de la hora declarada, que es la que hace fe.
  assert.equal(fichaje.fecha_local.length, 10);
});

test('el alta manual queda con origen panel y motivo obligatorio', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);

  const fichaje = await registrarAltaManual(env, empresa, {
    empleadoId: 'emp_1', tipo: 'entrada',
    timestampUtc: '2026-09-10T06:00:00Z',
    motivo: 'El trabajador olvidó fichar al entrar',
    autorId: 'usu_1', autorTipo: 'empresa',
  });

  assert.equal(fichaje.origen, 'panel');
  assert.equal(fichaje.tipo_registro, 'original');
  assert.equal(fichaje.fichaje_referenciado_id, null);

  await assert.rejects(
    () => registrarAltaManual(env, empresa, {
      empleadoId: 'emp_1', tipo: 'entrada',
      timestampUtc: '2026-09-10T06:00:00Z', motivo: '',
      autorId: 'usu_1', autorTipo: 'empresa',
    }),
    /motivo/,
  );
});

test('la geolocalización se descarta si la empresa no la tiene activada', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);

  const fichaje = await fichar(env, empresa, 'entrada', { latitud: 40.41, longitud: -3.70 });
  assert.equal(fichaje.latitud, null);
  assert.equal(fichaje.longitud, null);

  const conGeo = { ...empresa, id: 'emc_1', geolocalizacion_activa: 1 };
  const otro = await fichar(env, conGeo, 'salida', { latitud: 40.41, longitud: -3.70 });
  assert.equal(otro.latitud, 40.41);
});

test('los minutos trabajados descuentan las pausas', async () => {
  const dia = [
    { id: 'a', tipo: 'entrada', timestamp_utc: '2026-09-10T06:00:00Z', tipo_registro: 'original', fichaje_referenciado_id: null },
    { id: 'b', tipo: 'inicio_pausa', timestamp_utc: '2026-09-10T10:00:00Z', tipo_registro: 'original', fichaje_referenciado_id: null },
    { id: 'c', tipo: 'fin_pausa', timestamp_utc: '2026-09-10T10:30:00Z', tipo_registro: 'original', fichaje_referenciado_id: null },
    { id: 'd', tipo: 'salida', timestamp_utc: '2026-09-10T14:00:00Z', tipo_registro: 'original', fichaje_referenciado_id: null },
  ];
  assert.equal(minutosTrabajados(dia), 8 * 60 - 30);
});

test('una jornada sin salida no suma minutos: el sistema no inventa la hora de cierre', () => {
  const dia = [
    { id: 'a', tipo: 'entrada', timestamp_utc: '2026-09-10T06:00:00Z', tipo_registro: 'original', fichaje_referenciado_id: null },
  ];
  assert.equal(minutosTrabajados(dia), 0);
  assert.equal(estadoActual(dia), 'dentro');
});
