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
  hashearPin, verificarPin, comparacionConstante, crearSesion, sesionDe,
  revocarSesion, crearEnlaceMagico, canjearEnlaceMagico, sha256Token,
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

  assert.equal(await verificarPin('123456', uno), true);
  assert.equal(await verificarPin('654321', uno), false);
});

test('el PIN tiene que ser de seis dígitos', async () => {
  await assert.rejects(() => hashearPin('12345'), /seis dígitos/);
  await assert.rejects(() => hashearPin('1234567'), /seis dígitos/);
  await assert.rejects(() => hashearPin('abcdef'), /seis dígitos/);
});

test('verificar contra un PIN inexistente devuelve falso, no revienta', async () => {
  assert.equal(await verificarPin('123456', null), false);
  assert.equal(await verificarPin('123456', 'basura'), false);
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

test('el enlace mágico es de un solo uso', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);
  db.prepare(
    `INSERT INTO usuarios (id, email, nombre, rol, empresa_id)
     VALUES ('usu_1','jefe@ejemplo.es','Jefe','empresa','emc_1')`,
  ).run();

  const { token } = await crearEnlaceMagico(env, 'usu_1');
  const usuario = await canjearEnlaceMagico(env, token);
  assert.equal(usuario.id, 'usu_1');

  await assert.rejects(() => canjearEnlaceMagico(env, token), /ya se ha usado/);
});

test('el enlace mágico caduca', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);
  db.prepare(
    `INSERT INTO usuarios (id, email, nombre, rol, empresa_id)
     VALUES ('usu_1','jefe@ejemplo.es','Jefe','empresa','emc_1')`,
  ).run();

  const { token } = await crearEnlaceMagico(env, 'usu_1');
  db.prepare(`UPDATE enlaces_magicos SET expira_en = '2020-01-01T00:00:00Z'`).run();
  await assert.rejects(() => canjearEnlaceMagico(env, token), /no es válido o ha caducado/);
});

test('en la base de datos se guarda el hash del token, nunca el token', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);
  db.prepare(
    `INSERT INTO usuarios (id, email, nombre, rol, empresa_id)
     VALUES ('usu_1','jefe@ejemplo.es','Jefe','empresa','emc_1')`,
  ).run();

  const { token } = await crearEnlaceMagico(env, 'usu_1');
  const fila = db.prepare(`SELECT token_hash FROM enlaces_magicos`).get();
  assert.notEqual(fila.token_hash, token);
  assert.equal(fila.token_hash, await sha256Token(token));
});
