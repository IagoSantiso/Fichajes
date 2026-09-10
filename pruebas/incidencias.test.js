/**
 * El motor de incidencias.
 *
 * Lo que se prueba aquí no es tanto que detecte, sino que *no* detecte cuando
 * no toca: un motor que avisa de más se silencia en una semana y arrastra
 * consigo a las alertas que sí importaban.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entornoDePrueba, sembrar, sembrarHorario } from './ayudas/d1.js';
import { registrarFichaje } from '../src/lib/fichajes.js';
import {
  ejecutarParaEmpresa, detectarEstructurales, detectarExpectativa,
} from '../src/incidencias/motor.js';
import { dentroDeVentana } from '../src/incidencias/cron.js';
import { localAUtc } from '../src/lib/tiempo.js';

/** Inserta un fichaje con hora local exacta, saltándose el sello del servidor. */
async function ficharA(env, empresa, tipo, fecha, hora, empleadoId = 'emp_1') {
  const instante = localAUtc(fecha, hora, empresa.zona_horaria);
  const { calcularHash, HASH_GENESIS } = await import('../src/lib/hash.js');
  const ultimo = await env.DB.prepare(
    `SELECT hash FROM fichajes WHERE empresa_id = ? ORDER BY rowid DESC LIMIT 1`,
  ).bind(empresa.id).first();
  const hashAnterior = ultimo?.hash ?? HASH_GENESIS;

  const fichaje = {
    id: `fic_${Math.random().toString(36).slice(2, 12)}`,
    empresa_id: empresa.id, empleado_id: empleadoId, tipo,
    timestamp_utc: instante, zona_horaria: empresa.zona_horaria, fecha_local: fecha,
    timestamp_declarado: null, diferido: 0, origen: 'pwa',
    ip: null, user_agent: null, latitud: null, longitud: null,
    tipo_evento: null, modalidad: null, naturaleza_hora: null,
    autor_id: empleadoId, autor_tipo: 'empleado', tipo_registro: 'original',
    fichaje_referenciado_id: null, motivo: null, hash_anterior: hashAnterior,
  };
  fichaje.hash = await calcularHash(fichaje, hashAnterior);
  const columnas = Object.keys(fichaje);
  await env.DB.prepare(
    `INSERT INTO fichajes (${columnas.join(',')}) VALUES (${columnas.map(() => '?').join(',')})`,
  ).bind(...columnas.map((c) => fichaje[c])).run();
  return fichaje;
}

const incidenciasDe = async (env, empresaId) => {
  const { results } = await env.DB.prepare(
    `SELECT tipo, estado, fecha FROM incidencias WHERE empresa_id = ? ORDER BY tipo`,
  ).bind(empresaId).all();
  return results;
};

// --- Estructurales --------------------------------------------------------

test('una jornada completa y correcta no genera ninguna incidencia', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  sembrarHorario(db, 'emp_1', '08:00', '17:00');

  await ficharA(env, empresa, 'entrada', '2026-09-10', '08:00');
  await ficharA(env, empresa, 'inicio_pausa', '2026-09-10', '13:00');
  await ficharA(env, empresa, 'fin_pausa', '2026-09-10', '14:00');
  await ficharA(env, empresa, 'salida', '2026-09-10', '17:00');

  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });
  assert.deepEqual(await incidenciasDe(env, empresa.id), []);
});

test('detecta una jornada sin cerrar en el cierre diario, pero no antes', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  await ficharA(env, empresa, 'entrada', '2026-09-10', '08:00');

  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: false });
  assert.deepEqual(await incidenciasDe(env, empresa.id), [],
    'a media mañana la jornada todavía puede cerrarse');

  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });
  const tipos = (await incidenciasDe(env, empresa.id)).map((i) => i.tipo);
  assert.deepEqual(tipos, ['jornada_no_cerrada']);
});

test('detecta una salida sin entrada previa', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  await ficharA(env, empresa, 'salida', '2026-09-10', '17:00');

  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });
  const tipos = (await incidenciasDe(env, empresa.id)).map((i) => i.tipo);
  assert.ok(tipos.includes('salida_sin_entrada'));
});

test('detecta una pausa iniciada y no cerrada', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  await ficharA(env, empresa, 'entrada', '2026-09-10', '08:00');
  await ficharA(env, empresa, 'inicio_pausa', '2026-09-10', '13:00');

  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });
  const tipos = (await incidenciasDe(env, empresa.id)).map((i) => i.tipo);
  assert.ok(tipos.includes('pausa_no_cerrada'));
});

test('detecta el fichaje duplicado por doble toque', () => {
  const empresa = { zona_horaria: 'Europe/Madrid', jornada_maxima_alerta_horas: 12 };
  const dia = [
    { id: 'a', tipo: 'entrada', timestamp_utc: '2026-09-10T06:00:00Z', tipo_registro: 'original', fichaje_referenciado_id: null },
    { id: 'b', tipo: 'entrada', timestamp_utc: '2026-09-10T06:00:40Z', tipo_registro: 'original', fichaje_referenciado_id: null },
  ];
  const encontradas = detectarEstructurales(dia, empresa, { jornadaCerrada: false });
  assert.ok(encontradas.some((i) => i.tipo === 'fichaje_duplicado'));
});

test('la jornada excesiva usa el umbral configurado por empresa', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db, { jornadaMaxima: 10 });
  await ficharA(env, empresa, 'entrada', '2026-09-10', '06:00');
  await ficharA(env, empresa, 'salida', '2026-09-10', '17:00');   // 11 horas

  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });
  const tipos = (await incidenciasDe(env, empresa.id)).map((i) => i.tipo);
  assert.ok(tipos.includes('jornada_excesiva'));
});

// --- De expectativa: la tolerancia ---------------------------------------

test('la falta de entrada respeta la ventana de tolerancia', () => {
  const empresa = { zona_horaria: 'Europe/Madrid', tolerancia_minutos: 20 };
  const horario = { hora_entrada: '08:00', hora_salida: '17:00' };
  const opciones = { fecha: '2026-09-10', horarioDelDia: horario, cubierto: false, jornadaCerrada: false };

  // 08:10 local: dentro de la tolerancia, no se avisa.
  const dentro = detectarExpectativa([], empresa, {
    ...opciones, ahora: localAUtc('2026-09-10', '08:10', 'Europe/Madrid'),
  });
  assert.deepEqual(dentro, [], 'tres minutos tarde no es una incidencia');

  // 08:25 local: pasada la ventana, sí.
  const fuera = detectarExpectativa([], empresa, {
    ...opciones, ahora: localAUtc('2026-09-10', '08:25', 'Europe/Madrid'),
  });
  assert.equal(fuera[0].tipo, 'falta_entrada');
});

test('la salida anticipada también respeta la tolerancia', () => {
  const empresa = { zona_horaria: 'Europe/Madrid', tolerancia_minutos: 20 };
  const horario = { hora_entrada: '08:00', hora_salida: '17:00' };
  const base = {
    fecha: '2026-09-10', horarioDelDia: horario, cubierto: false,
    jornadaCerrada: false, ahora: localAUtc('2026-09-10', '18:00', 'Europe/Madrid'),
  };
  const dia = (hora) => [
    { id: 'a', tipo: 'entrada', timestamp_utc: localAUtc('2026-09-10', '08:00', 'Europe/Madrid'), tipo_registro: 'original', fichaje_referenciado_id: null },
    { id: 'b', tipo: 'salida', timestamp_utc: localAUtc('2026-09-10', hora, 'Europe/Madrid'), tipo_registro: 'original', fichaje_referenciado_id: null },
  ];

  assert.deepEqual(
    detectarExpectativa(dia('16:50'), empresa, base).map((i) => i.tipo), [],
    'diez minutos antes está dentro de la tolerancia',
  );
  assert.ok(
    detectarExpectativa(dia('15:00'), empresa, base).some((i) => i.tipo === 'salida_anticipada'),
  );
});

// --- De expectativa: la supresión ----------------------------------------

test('no hay incidencia de expectativa en un festivo del calendario', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  sembrarHorario(db, 'emp_1', '08:00', '17:00');
  db.prepare(
    `INSERT INTO calendario_laboral (id, empresa_id, fecha, tipo, descripcion)
     VALUES ('cal_1','emc_1','2026-09-10','festivo_local','Fiesta local')`,
  ).run();

  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });
  assert.deepEqual(await incidenciasDe(env, empresa.id), []);
});

test('no hay incidencia de expectativa con una ausencia aprobada', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  sembrarHorario(db, 'emp_1', '08:00', '17:00');
  db.prepare(
    `INSERT INTO ausencias (id, empresa_id, empleado_id, tipo, fecha_inicio, fecha_fin, estado)
     VALUES ('aus_1','emc_1','emp_1','vacaciones','2026-09-07','2026-09-11','aprobada')`,
  ).run();

  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });
  assert.deepEqual(await incidenciasDe(env, empresa.id), []);
});

test('una ausencia solamente solicitada no suprime la incidencia', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  sembrarHorario(db, 'emp_1', '08:00', '17:00');
  db.prepare(
    `INSERT INTO ausencias (id, empresa_id, empleado_id, tipo, fecha_inicio, fecha_fin, estado)
     VALUES ('aus_1','emc_1','emp_1','vacaciones','2026-09-10','2026-09-10','solicitada')`,
  ).run();

  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });
  const tipos = (await incidenciasDe(env, empresa.id)).map((i) => i.tipo);
  assert.ok(tipos.includes('falta_entrada'));
});

test('un trabajador dado de baja no genera incidencias', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  sembrarHorario(db, 'emp_1', '08:00', '17:00');
  db.prepare(`UPDATE empleados SET fecha_baja = '2026-09-01', activo = 0 WHERE id = 'emp_1'`).run();

  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });
  assert.deepEqual(await incidenciasDe(env, empresa.id), []);
});

test('sin horario teórico no hay incidencias de expectativa, sólo estructurales', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);   // sin sembrarHorario

  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });
  assert.deepEqual(await incidenciasDe(env, empresa.id), [],
    'quien no tiene horario declarado no incumple ninguna expectativa');
});

// --- Idempotencia ---------------------------------------------------------

test('ejecutar el motor mil veces no duplica ni reabre incidencias', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  await ficharA(env, empresa, 'entrada', '2026-09-10', '08:00');

  const primera = await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });
  assert.equal(primera.nuevas.length, 1);

  // Repetir no crea nada nuevo: es lo que permite que el cron corra cada
  // quince minutos sin inundar de avisos.
  for (let i = 0; i < 5; i++) {
    const otra = await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });
    assert.equal(otra.nuevas.length, 0);
  }
  assert.equal((await incidenciasDe(env, empresa.id)).length, 1);
});

test('una incidencia marcada como ignorada no vuelve a abrirse', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  await ficharA(env, empresa, 'entrada', '2026-09-10', '08:00');
  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });

  db.prepare(`UPDATE incidencias SET estado = 'ignorada' WHERE empresa_id = 'emc_1'`).run();
  await ejecutarParaEmpresa(env, empresa, '2026-09-10', { jornadaCerrada: true });

  const filas = await incidenciasDe(env, empresa.id);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].estado, 'ignorada');
});

// --- Ventana del cierre diario -------------------------------------------

test('el cierre diario sólo se dispara en la ventana de las 23:50 locales', () => {
  assert.equal(dentroDeVentana('23:50', '23:50', 20), true);
  assert.equal(dentroDeVentana('23:59', '23:50', 20), true);
  assert.equal(dentroDeVentana('00:05', '23:50', 20), true, 'la ventana cruza la medianoche');
  assert.equal(dentroDeVentana('00:15', '23:50', 20), false);
  assert.equal(dentroDeVentana('23:49', '23:50', 20), false);
  assert.equal(dentroDeVentana('12:00', '23:50', 20), false);
});
