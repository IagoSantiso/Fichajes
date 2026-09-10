/**
 * Genera un mes de fichajes realistas sobre la base D1 local.
 *
 * Sirve para demostraciones y para ver los paneles con datos: una base recién
 * sembrada está vacía y no enseña nada. Escribe directamente sobre el SQLite
 * de miniflare porque los fichajes van fechados en el pasado, y la API —con
 * razón— no deja fechar hacia atrás salvo por la vía de alta manual.
 *
 * Sólo para desarrollo. Respeta la cadena de hashes: cada fichaje se encadena
 * al anterior de su empresa igual que lo haría el Worker.
 *
 *   node semillas/generar-mes.mjs [empresa_id]
 */
import { calcularHash, HASH_GENESIS } from '../src/lib/hash.js';
import { localAUtc, diaSemanaIso, sumarDias } from '../src/lib/tiempo.js';
import { abrirD1Local } from './d1-local.mjs';

const EMPRESA = process.argv[2] ?? 'emc_dev';
const { db } = abrirD1Local();

const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(EMPRESA);
if (!empresa) {
  console.error(`No existe la empresa ${EMPRESA}. ¿Ha cargado la semilla?`);
  process.exit(1);
}

const empleados = db.prepare(
  'SELECT * FROM empleados WHERE empresa_id = ? AND activo = 1 ORDER BY id',
).all(EMPRESA);

const horarios = db.prepare(
  'SELECT * FROM horarios_teoricos WHERE empresa_id = ?',
).all(EMPRESA);

const festivos = new Set(
  db.prepare('SELECT fecha FROM calendario_laboral WHERE empresa_id = ?')
    .all(EMPRESA).map((f) => f.fecha),
);

// --- Cadena de hashes -----------------------------------------------------

let ultimoHash = db.prepare(
  'SELECT hash FROM fichajes WHERE empresa_id = ? ORDER BY rowid DESC LIMIT 1',
).get(EMPRESA)?.hash ?? HASH_GENESIS;

let contador = 0;

async function insertarFichaje(empleadoId, fecha, hora, tipo) {
  const instante = localAUtc(fecha, hora, empresa.zona_horaria);
  const fichaje = {
    id: `fic_demo${String(++contador).padStart(6, '0')}${Math.random().toString(36).slice(2, 8)}`,
    empresa_id: EMPRESA,
    empleado_id: empleadoId,
    tipo,
    timestamp_utc: instante,
    zona_horaria: empresa.zona_horaria,
    fecha_local: fecha,
    timestamp_declarado: null,
    diferido: 0,
    origen: 'pwa',
    ip: null,
    user_agent: null,
    latitud: null,
    longitud: null,
    tipo_evento: null,
    modalidad: null,
    naturaleza_hora: null,
    autor_id: empleadoId,
    autor_tipo: 'empleado',
    tipo_registro: 'original',
    fichaje_referenciado_id: null,
    motivo: null,
    hash_anterior: ultimoHash,
  };
  fichaje.hash = await calcularHash(fichaje, ultimoHash);
  ultimoHash = fichaje.hash;

  const columnas = Object.keys(fichaje);
  db.prepare(
    `INSERT INTO fichajes (${columnas.join(',')}) VALUES (${columnas.map(() => '?').join(',')})`,
  ).run(...columnas.map((c) => fichaje[c]));
  return fichaje;
}

// --- Variación realista ---------------------------------------------------

/**
 * Aleatoriedad con semilla fija: dos ejecuciones producen el mismo mes, para
 * que una captura de pantalla se pueda reproducir.
 */
let semilla = 20260910;
function aleatorio() {
  semilla = (semilla * 1103515245 + 12345) % 2147483648;
  return semilla / 2147483648;
}

const desplazar = (hora, minutos) => {
  const [h, m] = hora.split(':').map(Number);
  const total = Math.max(0, Math.min(23 * 60 + 59, h * 60 + m + minutos));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

// --- Generación -----------------------------------------------------------

const hoy = new Date().toISOString().slice(0, 10);
const primerDia = `${hoy.slice(0, 7)}-01`;

console.log(`Generando fichajes de ${primerDia} a ${hoy} para ${empresa.nombre}…`);

const incidenciasProvocadas = [];

for (const empleado of empleados) {
  let fecha = primerDia;
  while (fecha <= hoy) {
    const horario = horarios.find((h) => h.empleado_id === empleado.id
      && h.dia_semana === diaSemanaIso(fecha)
      && h.vigente_desde <= fecha
      && (!h.vigente_hasta || h.vigente_hasta >= fecha));

    if (!horario || festivos.has(fecha)) { fecha = sumarDias(fecha, 1); continue; }

    const sorteo = aleatorio();

    // Un día de cada quince, alguien se olvida de fichar la salida. Es lo que
    // hace que el panel de incidencias tenga algo que enseñar.
    const olvidaSalida = sorteo > 0.93;
    // Y de vez en cuando alguien llega tarde de verdad, más allá de la
    // ventana de tolerancia.
    const llegaTarde = sorteo > 0.86 && sorteo <= 0.93;

    const minutosEntrada = llegaTarde
      ? empresa.tolerancia_minutos + 15 + Math.floor(aleatorio() * 20)
      : Math.floor(aleatorio() * 12) - 5;
    const entrada = desplazar(horario.hora_entrada, minutosEntrada);
    await insertarFichaje(empleado.id, fecha, entrada, 'entrada');

    // Pausa sólo en jornadas de más de seis horas.
    const [he, me] = horario.hora_entrada.split(':').map(Number);
    const [hs, ms] = horario.hora_salida.split(':').map(Number);
    const duracion = (hs * 60 + ms) - (he * 60 + me);
    if (duracion > 6 * 60) {
      await insertarFichaje(empleado.id, fecha, '13:00', 'inicio_pausa');
      await insertarFichaje(empleado.id, fecha, desplazar('13:00', 45 + Math.floor(aleatorio() * 20)), 'fin_pausa');
    }

    if (olvidaSalida) {
      incidenciasProvocadas.push(`${fecha} ${empleado.nombre}: sin fichaje de salida`);
    } else {
      const salida = desplazar(horario.hora_salida, Math.floor(aleatorio() * 35) - 5);
      await insertarFichaje(empleado.id, fecha, salida, 'salida');
    }

    if (llegaTarde) {
      incidenciasProvocadas.push(`${fecha} ${empleado.nombre}: entrada fuera de tolerancia`);
    }

    fecha = sumarDias(fecha, 1);
  }
}

// --- Ausencias y solicitudes pendientes -----------------------------------

const ausencias = [
  // Vacaciones ya disfrutadas: aparecen en el informe y suprimen incidencias.
  ['aus_demo_1', empleados[1]?.id, 'vacaciones', sumarDias(primerDia, 2), sumarDias(primerDia, 6), 'aprobada'],
  // Y una solicitud sin resolver, para que la bandeja tenga contenido.
  ['aus_demo_2', empleados[2]?.id, 'vacaciones', sumarDias(hoy, 20), sumarDias(hoy, 27), 'solicitada'],
];

for (const [id, empleadoId, tipo, inicio, fin, estado] of ausencias) {
  if (!empleadoId) continue;
  db.prepare(
    `INSERT OR REPLACE INTO ausencias
       (id, empresa_id, empleado_id, tipo, fecha_inicio, fecha_fin, medio_dia,
        estado, solicitada_por, solicitada_en, resuelta_por, resuelta_en, comentario)
     VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?)`,
  ).run(id, EMPRESA, empleadoId, tipo, inicio, fin, estado, empleadoId,
    `${inicio}T09:00:00Z`,
    estado === 'aprobada' ? 'usu_jefe' : null,
    estado === 'aprobada' ? `${inicio}T10:00:00Z` : null,
    estado === 'aprobada' ? 'Vacaciones de verano' : 'Puente de octubre');
}

// Una solicitud de corrección esperando, que es la mitad de la bandeja.
// Se busca un día en que alguien fichó la entrada y no la salida: es el caso
// que de verdad lleva al trabajador a pedir una corrección.
const sinSalida = db.prepare(
  `SELECT e.empleado_id, e.fecha_local
     FROM fichajes e
    WHERE e.empresa_id = ? AND e.tipo = 'entrada'
      AND NOT EXISTS (
        SELECT 1 FROM fichajes s
         WHERE s.empresa_id = e.empresa_id
           AND s.empleado_id = e.empleado_id
           AND s.fecha_local = e.fecha_local
           AND s.tipo = 'salida')
    ORDER BY e.fecha_local DESC LIMIT 1`,
).get(EMPRESA);

if (sinSalida) {
  db.prepare(
    `INSERT OR REPLACE INTO solicitudes_correccion
       (id, empresa_id, empleado_id, fichaje_id, fecha_local, tipo_propuesto,
        hora_propuesta, motivo, estado, solicitada_en)
     VALUES ('cor_demo_1',?,?,NULL,?,'salida','17:15',
       'Me fui a las 17:15 y se me olvidó fichar la salida','solicitada',?)`,
  ).run(EMPRESA, sinSalida.empleado_id, sinSalida.fecha_local,
    `${sinSalida.fecha_local}T18:00:00Z`);
}

console.log(`  ${contador} fichajes insertados`);
console.log(`  ${incidenciasProvocadas.length} situaciones que el motor debe detectar:`);
for (const linea of incidenciasProvocadas.slice(0, 8)) console.log(`    · ${linea}`);
console.log('\nAhora pase el motor de incidencias sobre los días del mes desde el panel,');
console.log('o con: node semillas/pasar-motor.mjs');
