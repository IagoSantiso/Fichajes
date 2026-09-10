/**
 * Informes y exportación.
 *
 * Además de que las cifras salgan, se comprueba que la diferencia de horas no
 * se etiqueta nunca como «horas extra»: es una decisión del brief y es la clase
 * de cosa que se cuela sola en cuanto alguien toca una plantilla.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entornoDePrueba, sembrar, sembrarHorario } from './ayudas/d1.js';
import { informeDePeriodo, horasYMinutos, horasDecimales, ETIQUETA_DIFERENCIA } from '../src/lib/informes.js';
import { minutosTeoricosDelPeriodo } from '../src/incidencias/motor.js';
import { exportar, listarAdaptadores, registrarAdaptador, nombreFichero } from '../src/exportacion/index.js';
import { calcularHash, HASH_GENESIS } from '../src/lib/hash.js';
import { localAUtc, resolverPeriodo } from '../src/lib/tiempo.js';

async function ficharA(env, empresa, tipo, fecha, hora) {
  const ultimo = await env.DB.prepare(
    `SELECT hash FROM fichajes WHERE empresa_id = ? ORDER BY rowid DESC LIMIT 1`,
  ).bind(empresa.id).first();
  const hashAnterior = ultimo?.hash ?? HASH_GENESIS;
  const fichaje = {
    id: `fic_${Math.random().toString(36).slice(2, 12)}`,
    empresa_id: empresa.id, empleado_id: 'emp_1', tipo,
    timestamp_utc: localAUtc(fecha, hora, empresa.zona_horaria),
    zona_horaria: empresa.zona_horaria, fecha_local: fecha,
    timestamp_declarado: null, diferido: 0, origen: 'pwa',
    ip: null, user_agent: null, latitud: null, longitud: null,
    tipo_evento: null, modalidad: null, naturaleza_hora: null,
    autor_id: 'emp_1', autor_tipo: 'empleado', tipo_registro: 'original',
    fichaje_referenciado_id: null, motivo: null, hash_anterior: hashAnterior,
  };
  fichaje.hash = await calcularHash(fichaje, hashAnterior);
  const columnas = Object.keys(fichaje);
  await env.DB.prepare(
    `INSERT INTO fichajes (${columnas.join(',')}) VALUES (${columnas.map(() => '?').join(',')})`,
  ).bind(...columnas.map((c) => fichaje[c])).run();
}

test('el informe suma horas registradas y las compara con las teóricas', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  sembrarHorario(db, 'emp_1', '08:00', '16:00');   // 8 h de lunes a viernes

  // Lunes 7 y martes 8 de septiembre de 2026, nueve horas cada uno.
  for (const fecha of ['2026-09-07', '2026-09-08']) {
    await ficharA(env, empresa, 'entrada', fecha, '08:00');
    await ficharA(env, empresa, 'salida', fecha, '17:00');
  }

  const informe = await informeDePeriodo(env, empresa, { desde: '2026-09-07', hasta: '2026-09-08' });
  const fila = informe.empleados[0];

  assert.equal(fila.minutos_registrados, 18 * 60);
  assert.equal(fila.minutos_teoricos, 16 * 60);
  assert.equal(fila.minutos_exceso, 2 * 60);
  assert.equal(fila.dias_trabajados, 2);
});

test('la diferencia se llama exceso sobre jornada teórica y nunca horas extra', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  sembrarHorario(db, 'emp_1', '08:00', '16:00');
  await ficharA(env, empresa, 'entrada', '2026-09-07', '08:00');
  await ficharA(env, empresa, 'salida', '2026-09-07', '18:00');

  const informe = await informeDePeriodo(env, empresa, { desde: '2026-09-07', hasta: '2026-09-07' });
  assert.equal(informe.etiqueta_diferencia, 'Exceso sobre jornada teórica');
  assert.equal(ETIQUETA_DIFERENCIA, 'Exceso sobre jornada teórica');

  for (const formato of ['csv', 'pdf']) {
    const salida = exportar(formato, informe);
    const texto = formato === 'csv'
      ? salida.contenido
      : new TextDecoder('latin1').decode(salida.contenido);
    assert.ok(texto.includes('exceso sobre jornada te'), `${formato} debe usar la etiqueta correcta`);
    // El límite de palabra deja pasar «hora extraordinaria» dentro de la
    // advertencia, que sí debe aparecer; lo que no puede haber es una cifra
    // rotulada como «horas extra».
    assert.ok(!/horas? extras?\b/i.test(texto), `${formato} no puede rotular horas extra`);
    assert.ok(/extraordinaria/i.test(texto),
      `${formato} debe advertir de que la calificación la hace la gestoría`);
  }
});

test('un periodo en curso sólo acumula jornada teórica hasta hoy', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  sembrarHorario(db, 'emp_1', '08:00', '16:00');

  // Un periodo que se adentra en el futuro: contar los días que aún no han
  // ocurrido produciría un déficit falso de decenas de horas.
  const hoy = new Date().toISOString().slice(0, 10);
  const dentroDeUnAnio = `${Number(hoy.slice(0, 4)) + 1}-12-31`;

  const informe = await informeDePeriodo(env, empresa, { desde: hoy, hasta: dentroDeUnAnio });
  assert.equal(informe.periodo.en_curso, true);
  assert.equal(informe.periodo.teoricas_hasta, hoy);

  // Como mucho, la jornada teórica de hoy: nunca la de todo el año que viene.
  assert.ok(informe.empleados[0].minutos_teoricos <= 8 * 60);

  // Un periodo enteramente futuro no acumula nada.
  const futuro = await informeDePeriodo(env, empresa, {
    desde: `${Number(hoy.slice(0, 4)) + 1}-01-01`, hasta: dentroDeUnAnio,
  });
  assert.equal(futuro.empleados[0].minutos_teoricos, 0);
});

test('un periodo ya cerrado cuenta la jornada teórica completa', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  sembrarHorario(db, 'emp_1', '08:00', '16:00');

  // Semana del lunes 5 al viernes 9 de enero de 2026: ya pasó del todo, y el
  // horario sembrado rige desde el 1 de enero.
  const informe = await informeDePeriodo(env, empresa, { desde: '2026-01-05', hasta: '2026-01-09' });
  assert.equal(informe.periodo.en_curso, false);
  assert.equal(informe.empleados[0].minutos_teoricos, 5 * 8 * 60);
});

test('las horas teóricas descuentan festivos y ausencias aprobadas', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  sembrarHorario(db, 'emp_1', '08:00', '16:00');

  // Semana del lunes 7 al viernes 11: cinco días de ocho horas.
  const completa = await minutosTeoricosDelPeriodo(env, empresa, 'emp_1', '2026-09-07', '2026-09-11');
  assert.equal(completa, 5 * 8 * 60);

  db.prepare(
    `INSERT INTO calendario_laboral (id, empresa_id, fecha, tipo)
     VALUES ('cal_1','emc_1','2026-09-09','festivo_local')`,
  ).run();
  db.prepare(
    `INSERT INTO ausencias (id, empresa_id, empleado_id, tipo, fecha_inicio, fecha_fin, estado)
     VALUES ('aus_1','emc_1','emp_1','vacaciones','2026-09-11','2026-09-11','aprobada')`,
  ).run();

  const conBajas = await minutosTeoricosDelPeriodo(env, empresa, 'emp_1', '2026-09-07', '2026-09-11');
  assert.equal(conBajas, 3 * 8 * 60, 'quitando el festivo y el día de vacaciones');
});

test('las ausencias se cruzan por consulta y no tocan la cadena de fichajes', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  db.prepare(
    `INSERT INTO ausencias (id, empresa_id, empleado_id, tipo, fecha_inicio, fecha_fin, estado)
     VALUES ('aus_1','emc_1','emp_1','vacaciones','2026-09-07','2026-09-11','aprobada')`,
  ).run();

  const informe = await informeDePeriodo(env, empresa, { desde: '2026-09-01', hasta: '2026-09-30' });
  assert.equal(informe.empleados[0].dias_ausencia.vacaciones, 5);
  // Ni un solo fichaje generado por una ausencia.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM fichajes`).get().n, 0);
});

test('en una baja no se guarda comentario, sólo tipo y fechas', async () => {
  const { db, env } = entornoDePrueba();
  sembrar(db);
  const { registrarRutasAusencias } = await import('../src/rutas/ausencias.js');
  const { Router } = await import('../src/lib/router.js');
  const { alcanceEmpresa } = await import('../src/lib/datos.js');

  const router = new Router();
  registrarRutasAusencias(router);
  const { manejador } = router.resolver('POST', '/api/ausencias');

  await manejador({
    env,
    sesion: { actorTipo: 'empresa', actorId: 'usu_1', empresaId: 'emc_1' },
    datos: alcanceEmpresa(env.DB, 'emc_1'),
    empresa: { id: 'emc_1' },
    cuerpo: {
      empleado_id: 'emp_1', tipo: 'baja',
      fecha_inicio: '2026-09-07', fecha_fin: '2026-09-18',
      comentario: 'Lumbalgia con parte de baja del médico de cabecera',
    },
    peticion: { headers: { get: () => null } },
  });

  const fila = db.prepare(`SELECT tipo, comentario FROM ausencias`).get();
  assert.equal(fila.tipo, 'baja');
  assert.equal(fila.comentario, null,
    'el motivo médico es categoría especial del RGPD y no entra en la base de datos');
});

test('los adaptadores de exportación están versionados y se pueden ampliar', () => {
  const disponibles = listarAdaptadores();
  assert.ok(disponibles.some((a) => a.nombre === 'csv' && a.version === '1.0'));
  assert.ok(disponibles.some((a) => a.nombre === 'pdf' && a.version === '1.0'));

  // Así es como entrará el adaptador de la Inspección cuando exista la orden
  // ministerial: registrándose, sin tocar el resto del sistema.
  registrarAdaptador({
    nombre: 'prueba', version: '2.1',
    tipoContenido: 'text/plain', extension: 'txt',
    descripcion: 'Adaptador de prueba',
    generar: (datos) => `empresa:${datos.empresa.nombre}`,
  });

  const informe = {
    empresa: { nombre: 'Soldaduras Pérez S.L.' },
    periodo: { desde: '2026-09-01', hasta: '2026-09-30' },
  };
  assert.equal(exportar('prueba', informe).contenido, 'empresa:Soldaduras Pérez S.L.');
  assert.equal(exportar('prueba@2.1', informe).adaptador, 'prueba@2.1');
});

test('un formato desconocido se rechaza y dice cuáles hay', () => {
  assert.throws(() => exportar('xml', { empresa: {}, periodo: {} }), /no disponible/);
});

test('el PDF generado es un fichero PDF bien formado', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  await ficharA(env, empresa, 'entrada', '2026-09-07', '08:00');
  await ficharA(env, empresa, 'salida', '2026-09-07', '17:00');

  const informe = await informeDePeriodo(env, empresa, { desde: '2026-09-01', hasta: '2026-09-30' });
  const { contenido } = exportar('pdf', informe);
  const texto = new TextDecoder('latin1').decode(contenido);

  assert.ok(texto.startsWith('%PDF-1.4'));
  assert.ok(texto.trimEnd().endsWith('%%EOF'));

  // El /Length declarado de cada flujo debe coincidir con su contenido real:
  // si no, el visor lo rechaza.
  for (const coincidencia of texto.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const declarado = Number(coincidencia[1]);
    const inicio = coincidencia.index + coincidencia[0].length;
    const fin = texto.indexOf('\nendstream', inicio);
    assert.equal(fin - inicio, declarado);
  }

  // Y la tabla de referencias cruzadas debe apuntar a cada objeto.
  const inicioXref = Number(/startxref\n(\d+)/.exec(texto)[1]);
  assert.equal(texto.slice(inicioXref, inicioXref + 4), 'xref');
});

test('el CSV sale con separador de punto y coma, coma decimal y BOM', async () => {
  const { db, env } = entornoDePrueba();
  const { empresa } = sembrar(db);
  sembrarHorario(db, 'emp_1', '08:00', '16:00');
  await ficharA(env, empresa, 'entrada', '2026-09-07', '08:00');
  await ficharA(env, empresa, 'salida', '2026-09-07', '17:00');

  const informe = await informeDePeriodo(env, empresa, { desde: '2026-09-07', hasta: '2026-09-07' });
  const { contenido } = exportar('csv', informe);

  assert.ok(contenido.startsWith('﻿'), 'sin BOM, Excel en español destroza los acentos');
  assert.ok(contenido.includes(';'));
  assert.ok(/\d,\d\d/.test(contenido), 'las horas decimales van con coma');
});

test('el nombre del fichero exportado identifica empresa y periodo', () => {
  const informe = {
    empresa: { nombre: 'Soldaduras Pérez S.L.' },
    periodo: { desde: '2026-09-01', hasta: '2026-09-30' },
  };
  assert.equal(
    nombreFichero(informe, 'pdf'),
    'registro-jornada-soldaduras-perez-s-l-2026-09-01_2026-09-30.pdf',
  );
});

test('el formateo de horas es legible y con signo', () => {
  assert.equal(horasYMinutos(0), '0 h 00 min');
  assert.equal(horasYMinutos(90), '1 h 30 min');
  assert.equal(horasYMinutos(-75), '-1 h 15 min');
  assert.equal(horasDecimales(90), '1,50');
});

test('los periodos de informe abarcan lo que dicen abarcar', () => {
  assert.deepEqual(resolverPeriodo('mes', 2026, 2), { desde: '2026-02-01', hasta: '2026-02-28' });
  assert.deepEqual(resolverPeriodo('mes', 2028, 2), { desde: '2028-02-01', hasta: '2028-02-29' });
  assert.deepEqual(resolverPeriodo('trimestre', 2026, 1), { desde: '2026-01-01', hasta: '2026-03-31' });
  assert.deepEqual(resolverPeriodo('semestre', 2026, 2), { desde: '2026-07-01', hasta: '2026-12-31' });
  assert.deepEqual(resolverPeriodo('anio', 2026), { desde: '2026-01-01', hasta: '2026-12-31' });
});
