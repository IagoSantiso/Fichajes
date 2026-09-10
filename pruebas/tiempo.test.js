/**
 * Zonas horarias y sellos temporales.
 *
 * El cambio de hora de octubre y marzo es donde se rompen los registros de
 * jornada: una hora que se repite o que no existe, y un mes entero de informes
 * descuadrado. Se prueba a propósito contra las fechas de transición.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fechaLocal, horaLocal, desfaseMinutos, localAUtc, diaSemanaIso,
  sumarDias, rangoFechas, minutosEntre, minutosDeHora, etiquetaPeriodo,
} from '../src/lib/tiempo.js';

test('la fecha local de un fichaje es la de la zona de la empresa, no la de UTC', () => {
  // 22:30 UTC del 10 de septiembre son las 00:30 del 11 en Madrid.
  assert.equal(fechaLocal('2026-09-10T22:30:00Z', 'Europe/Madrid'), '2026-09-11');
  assert.equal(horaLocal('2026-09-10T22:30:00Z', 'Europe/Madrid'), '00:30');

  // Y en Canarias, que es la otra zona que va a aparecer, sigue siendo el 10.
  assert.equal(fechaLocal('2026-09-10T22:30:00Z', 'Atlantic/Canary'), '2026-09-10');
});

test('el desfase horario se calcula en la fecha correspondiente, no en la actual', () => {
  assert.equal(desfaseMinutos('2026-07-15T12:00:00Z', 'Europe/Madrid'), 120);   // verano
  assert.equal(desfaseMinutos('2026-01-15T12:00:00Z', 'Europe/Madrid'), 60);    // invierno
  assert.equal(desfaseMinutos('2026-01-15T12:00:00Z', 'Atlantic/Canary'), 0);
});

test('una hora local se convierte a UTC según el desfase de su propia fecha', () => {
  assert.equal(localAUtc('2026-07-15', '08:00', 'Europe/Madrid'), '2026-07-15T06:00:00Z');
  assert.equal(localAUtc('2026-01-15', '08:00', 'Europe/Madrid'), '2026-01-15T07:00:00Z');
});

test('la conversión aguanta el cambio de hora de octubre', () => {
  // El último domingo de octubre de 2026 es el día 25: a las 03:00 se vuelve
  // a las 02:00 y esa hora se repite.
  const antes = localAUtc('2026-10-25', '01:00', 'Europe/Madrid');
  const despues = localAUtc('2026-10-25', '05:00', 'Europe/Madrid');
  assert.equal(antes, '2026-10-24T23:00:00Z');
  assert.equal(despues, '2026-10-25T04:00:00Z');

  // Ida y vuelta: la hora local de esos instantes es la que se pidió.
  assert.equal(horaLocal(antes, 'Europe/Madrid'), '01:00');
  assert.equal(horaLocal(despues, 'Europe/Madrid'), '05:00');
});

test('la conversión aguanta el cambio de hora de marzo', () => {
  // El 29 de marzo de 2026, a las 02:00 se salta a las 03:00: las 02:30 no
  // existen. Lo que no puede pasar es que la conversión devuelva basura.
  const previa = localAUtc('2026-03-29', '01:30', 'Europe/Madrid');
  const posterior = localAUtc('2026-03-29', '04:00', 'Europe/Madrid');
  assert.equal(previa, '2026-03-29T00:30:00Z');
  assert.equal(posterior, '2026-03-29T02:00:00Z');
  assert.equal(horaLocal(posterior, 'Europe/Madrid'), '04:00');

  const inexistente = localAUtc('2026-03-29', '02:30', 'Europe/Madrid');
  assert.match(inexistente, /^2026-03-29T\d{2}:\d{2}:00Z$/,
    'una hora que no existe debe resolverse a un instante válido, no a NaN');
});

test('una jornada de noche que cruza la medianoche mantiene la fecha del inicio', () => {
  // Turno de 22:00 a 06:00: la entrada pertenece al día en que se ficha.
  const entrada = localAUtc('2026-09-10', '22:00', 'Europe/Madrid');
  const salida = localAUtc('2026-09-11', '06:00', 'Europe/Madrid');
  assert.equal(fechaLocal(entrada, 'Europe/Madrid'), '2026-09-10');
  assert.equal(fechaLocal(salida, 'Europe/Madrid'), '2026-09-11');
  assert.equal(minutosEntre(entrada, salida), 8 * 60);
});

test('el día de la semana sigue el convenio ISO: 1 es lunes y 7 domingo', () => {
  assert.equal(diaSemanaIso('2026-09-07'), 1);   // lunes
  assert.equal(diaSemanaIso('2026-09-12'), 6);   // sábado
  assert.equal(diaSemanaIso('2026-09-13'), 7);   // domingo
});

test('la aritmética de fechas cruza meses y años', () => {
  assert.equal(sumarDias('2026-01-31', 1), '2026-02-01');
  assert.equal(sumarDias('2026-03-01', -1), '2026-02-28');
  assert.equal(sumarDias('2026-12-31', 1), '2027-01-01');
  assert.equal(sumarDias('2028-02-28', 1), '2028-02-29');
});

test('el rango de fechas incluye los dos extremos', () => {
  assert.deepEqual(rangoFechas('2026-09-07', '2026-09-09'),
    ['2026-09-07', '2026-09-08', '2026-09-09']);
  assert.deepEqual(rangoFechas('2026-09-07', '2026-09-07'), ['2026-09-07']);
  assert.deepEqual(rangoFechas('2026-09-08', '2026-09-07'), []);
});

test('las horas se convierten a minutos desde medianoche', () => {
  assert.equal(minutosDeHora('00:00'), 0);
  assert.equal(minutosDeHora('08:30'), 510);
  assert.equal(minutosDeHora('23:59'), 1439);
});

test('las etiquetas de periodo se escriben en castellano corriente', () => {
  assert.equal(etiquetaPeriodo('mes', 2026, 9), 'septiembre de 2026');
  assert.equal(etiquetaPeriodo('trimestre', 2026, 3), '3.º trimestre de 2026');
  assert.equal(etiquetaPeriodo('anio', 2026), 'año 2026');
});
