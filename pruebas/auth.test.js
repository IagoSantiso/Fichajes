/**
 * Autenticación.
 *
 * El PIN del trabajador es el punto más expuesto del sistema: seis dígitos en
 * un móvil que se deja encima de un banco de trabajo. Lo que se puede hacer es
 * que no se guarde en claro, que la sesión sea revocable y que la respuesta no
 * distinga «no existe» de «PIN incorrecto».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entornoDePrueba, sembrar } from './ayudas/d1.js';
import {
  hashearPin, hashearPassword, verificarSecreto, comparacionConstante,
  crearSesion, sesionDe, revocarSesion, sha256Token,
  exigirSinBloqueo, anotarFallo, limpiarFallos,
  INTENTOS_MAXIMOS, INTENTOS_MAXIMOS_IP, MINIMO_PASSWORD,
} from '../src/lib/auth.js';

const peticionCon = (cookie) => ({
  headers: { get: (nombre) => (nombre === 'cookie' ? cookie : null) },
});

test('el PIN se guarda hasheado y con sal distinta cada vez', async () => {
  const uno = await hashearPin('123456');
  const otro = await hashearPin('123456');

  assert.notEqual(uno, otro, 'dos hashes del mismo PIN no pueden coincidir');
  assert.ok(!uno.includes('123456'));
  assert.match(uno, /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);

  assert.equal(await verificarSecreto('123456', uno), true);
  assert.equal(await verificarSecreto('654321', uno), false);
});

test('el PIN tiene que ser de seis dígitos', async () => {
  await assert.rejects(() => hashearPin('12345'), /seis dígitos/);
  await assert.rejects(() => hashearPin('1234567'), /seis dígitos/);
  await assert.rejects(() => hashearPin('abcdef'), /seis dígitos/);
});

test('verificar contra un PIN inexistente devuelve falso, no revienta', async () => {
  assert.equal(await verificarSecreto('123456', null), false);
  assert.equal(await verificarSecreto('123456', 'basura'), false);
});

test('la comparación de secretos no se corta en la primera diferencia', () => {
  assert.equal(comparacionConstante('abc', 'abc'), true);
  assert.equal(comparacionConstante('abc', 'abd'), false);
  assert.equal(comparacionConstante('abc', 'abcd'), false);
});

test('una cookie de sesión sin firma válida no vale', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);

  const cookie = await crearSesion(env, {
    actorTipo: 'empleado', actorId: 'emp_1', empresaId: 'emc_1',
  });
  const valor = /sesion=([^;]+)/.exec(cookie)[1];

  assert.ok(await sesionDe(peticionCon(`sesion=${valor}`), env));

  // Se cambia la firma: el token es correcto pero la cookie está manipulada.
  const manipulada = `${valor.slice(0, valor.lastIndexOf('.'))}.0000`;
  assert.equal(await sesionDe(peticionCon(`sesion=${manipulada}`), env), null);
  assert.equal(await sesionDe(peticionCon('sesion=cualquiercosa'), env), null);
  assert.equal(await sesionDe(peticionCon(''), env), null);
});

test('la sesión del trabajador dura mucho y la del panel poco', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);

  const delTrabajador = await crearSesion(env, {
    actorTipo: 'empleado', actorId: 'emp_1', empresaId: 'emc_1',
  });
  const delPanel = await crearSesion(env, {
    actorTipo: 'empresa', actorId: 'usu_1', empresaId: 'emc_1',
  });

  const edad = (cookie) => Number(/Max-Age=(\d+)/.exec(cookie)[1]);
  assert.ok(edad(delTrabajador) > 90 * 86400,
    'si el trabajador tiene que autenticarse cada mañana, deja de fichar');
  assert.ok(edad(delPanel) < 2 * 86400);
});

test('una sesión revocada deja de valer inmediatamente', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);

  const cookie = await crearSesion(env, {
    actorTipo: 'empleado', actorId: 'emp_1', empresaId: 'emc_1',
  });
  const peticion = peticionCon(`sesion=${/sesion=([^;]+)/.exec(cookie)[1]}`);

  const sesion = await sesionDe(peticion, env);
  assert.ok(sesion);
  await revocarSesion(env, sesion.id);
  assert.equal(await sesionDe(peticion, env), null);
});

test('una sesión caducada no vale aunque la firma sea correcta', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);

  const cookie = await crearSesion(env, {
    actorTipo: 'empresa', actorId: 'usu_1', empresaId: 'emc_1',
  });
  const peticion = peticionCon(`sesion=${/sesion=([^;]+)/.exec(cookie)[1]}`);

  db.prepare(`UPDATE sesiones SET expira_en = '2020-01-01T00:00:00Z'`).run();
  assert.equal(await sesionDe(peticion, env), null);
});

test('la cookie de sesión es httpOnly y SameSite', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);
  const cookie = await crearSesion(env, {
    actorTipo: 'empleado', actorId: 'emp_1', empresaId: 'emc_1',
  });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
});

test('la contraseña se guarda hasheada y con un mínimo de longitud', async () => {
  const uno = await hashearPassword('fichajes2026');
  const otro = await hashearPassword('fichajes2026');

  assert.notEqual(uno, otro, 'dos hashes de la misma contraseña no pueden coincidir');
  assert.ok(!uno.includes('fichajes2026'));
  assert.equal(await verificarSecreto('fichajes2026', uno), true);
  assert.equal(await verificarSecreto('Fichajes2026', uno), false);

  await assert.rejects(() => hashearPassword('corta'), /al menos/);
  await assert.rejects(() => hashearPassword(''), /al menos/);
  assert.ok(MINIMO_PASSWORD >= 8);
});

test('el PIN y la contraseña se guardan con el mismo formato', async () => {
  const pin = await hashearPin('482915');
  const password = await hashearPassword('fichajes2026');
  const formato = /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

  assert.match(pin, formato);
  assert.match(password, formato);
});

// --- Límite de intentos ----------------------------------------------------

test('el cerrojo salta al quinto fallo y no antes', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);

  for (let i = 0; i < INTENTOS_MAXIMOS - 1; i++) {
    await anotarFallo(env, '001001', '203.0.113.1');
    // Todavía no debe bloquear.
    await exigirSinBloqueo(env, '001001', '203.0.113.1');
  }

  await anotarFallo(env, '001001', '203.0.113.1');
  await assert.rejects(
    () => exigirSinBloqueo(env, '001001', '203.0.113.1'),
    (error) => error.estado === 429 && error.codigo === 'demasiados_intentos',
  );
});

test('el cerrojo por IP aguanta más, para no bloquear a compañeros', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);

  // Un identificador distinto en cada fallo: el cerrojo por identificador no
  // llega a saltar nunca, sólo el de la IP.
  for (let i = 0; i < INTENTOS_MAXIMOS_IP - 1; i++) {
    await anotarFallo(env, `00100${i}`, '198.51.100.1');
  }
  await exigirSinBloqueo(env, 'otro-mas', '198.51.100.1');

  await anotarFallo(env, 'el-ultimo', '198.51.100.1');
  await assert.rejects(
    () => exigirSinBloqueo(env, 'cualquiera', '198.51.100.1'),
    (error) => error.estado === 429,
  );
  assert.ok(INTENTOS_MAXIMOS_IP > INTENTOS_MAXIMOS);
});

test('acertar borra la cuenta del identificador, pero no la de la IP', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);

  for (let i = 0; i < 3; i++) await anotarFallo(env, '001001', '203.0.113.2');
  await limpiarFallos(env, '001001', '203.0.113.2');

  const porIdentificador = db.prepare(
    `SELECT fallidos FROM intentos_acceso WHERE clave = 'id:001001'`,
  ).get();
  assert.equal(porIdentificador, undefined, 'la cuenta del identificador se borra');

  const porIp = db.prepare(
    `SELECT fallidos FROM intentos_acceso WHERE clave = 'ip:203.0.113.2'`,
  ).get();
  assert.equal(porIp.fallidos, 3,
    'si acertar limpiase la IP, bastaría un acceso legítimo entre tanteos para anular el cerrojo');
});

test('un bloqueo vencido no arrastra la cuenta anterior', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);

  for (let i = 0; i < INTENTOS_MAXIMOS; i++) await anotarFallo(env, '001001', null);
  await assert.rejects(() => exigirSinBloqueo(env, '001001', null),
    (error) => error.estado === 429);

  // Se adelanta el reloj: el bloqueo ya pasó.
  db.prepare(
    `UPDATE intentos_acceso SET bloqueado_hasta = '2020-01-01T00:00:00Z' WHERE clave = 'id:001001'`,
  ).run();
  await exigirSinBloqueo(env, '001001', null);

  // Y vuelve a haber cinco intentos, no uno.
  await anotarFallo(env, '001001', null);
  const fila = db.prepare(`SELECT fallidos FROM intentos_acceso WHERE clave = 'id:001001'`).get();
  assert.equal(fila.fallidos, 1, 'la cuenta reinicia tras cumplirse el bloqueo');
});
