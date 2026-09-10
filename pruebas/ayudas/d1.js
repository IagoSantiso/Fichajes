/**
 * Doble de D1 sobre node:sqlite, con la misma superficie que usa el código.
 *
 * Las pruebas corren contra el esquema real, con sus disparadores de
 * inmutabilidad y sus índices únicos. Probar la cadena de hashes contra un
 * objeto simulado no demostraría nada: lo que hay que comprobar es que la base
 * de datos rechaza de verdad un UPDATE sobre `fichajes`.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

class SentenciaD1 {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.parametros = [];
  }

  bind(...parametros) {
    // node:sqlite no acepta undefined ni booleanos.
    this.parametros = parametros.map((p) => {
      if (p === undefined) return null;
      if (typeof p === 'boolean') return p ? 1 : 0;
      return p;
    });
    return this;
  }

  async all() {
    return { results: this.db.prepare(this.sql).all(...this.parametros), success: true };
  }

  async first() {
    return this.db.prepare(this.sql).get(...this.parametros) ?? null;
  }

  async run() {
    const resultado = this.db.prepare(this.sql).run(...this.parametros);
    return { success: true, meta: { changes: Number(resultado.changes) } };
  }
}

class BaseD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new SentenciaD1(this.db, sql); }
  async batch(sentencias) { return Promise.all(sentencias.map((s) => s.run())); }
}

/** Crea una base en memoria con todas las migraciones aplicadas. */
export function crearBaseDePrueba() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const directorio = join(RAIZ, 'migraciones');
  const migraciones = readdirSync(directorio).filter((f) => f.endsWith('.sql')).sort();
  for (const fichero of migraciones) {
    db.exec(readFileSync(join(directorio, fichero), 'utf8'));
  }
  return { db, DB: new BaseD1(db) };
}

/** Entorno mínimo equivalente al `env` del Worker. */
export function entornoDePrueba() {
  const { db, DB } = crearBaseDePrueba();
  return {
    db,
    env: {
      DB,
      ENTORNO: 'pruebas',
      SECRETO_SESION: 'secreto-de-pruebas',
      CORREO_PROVEEDOR: 'consola',
    },
  };
}

/** Gestoría, empresa y un empleado, que es el mínimo para probar cualquier cosa. */
export function sembrar(db, opciones = {}) {
  const empresa = {
    id: 'emc_1',
    gestoria_id: 'ges_1',
    nombre: 'Soldaduras Pérez S.L.',
    codigo: 'SOLDPER',
    cif: 'B12345678',
    zona_horaria: opciones.zonaHoraria ?? 'Europe/Madrid',
    tolerancia_minutos: opciones.tolerancia ?? 20,
    jornada_maxima_alerta_horas: opciones.jornadaMaxima ?? 12,
    geolocalizacion_activa: opciones.geolocalizacion ? 1 : 0,
    activa: 1,
  };

  db.exec(`INSERT INTO gestorias (id, nombre) VALUES ('ges_1', 'Gestoría Ejemplo')`);
  db.prepare(
    `INSERT INTO empresas (id, gestoria_id, nombre, codigo, cif, zona_horaria,
        tolerancia_minutos, jornada_maxima_alerta_horas, geolocalizacion_activa, activa)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(empresa.id, empresa.gestoria_id, empresa.nombre, empresa.codigo, empresa.cif,
    empresa.zona_horaria, empresa.tolerancia_minutos, empresa.jornada_maxima_alerta_horas,
    empresa.geolocalizacion_activa, empresa.activa);

  db.prepare(
    `INSERT INTO empleados (id, empresa_id, nombre, apellidos, tipo_jornada, rol,
        dias_vacaciones_anuales, fecha_alta, activo)
     VALUES ('emp_1','emc_1','Ana','Ruiz Gómez','completa','empleado',22,'2026-01-01',1)`,
  ).run();

  return {
    empresa,
    empleado: { id: 'emp_1', nombre: 'Ana', apellidos: 'Ruiz Gómez' },
  };
}

/** Alta de un horario teórico de lunes a viernes. */
export function sembrarHorario(db, empleadoId, entrada, salida, desde = '2026-01-01') {
  for (let dia = 1; dia <= 5; dia++) {
    db.prepare(
      `INSERT INTO horarios_teoricos (id, empresa_id, empleado_id, dia_semana,
          hora_entrada, hora_salida, vigente_desde, vigente_hasta)
       VALUES (?,?,?,?,?,?,?,NULL)`,
    ).run(`hor_${empleadoId}_${dia}`, 'emc_1', empleadoId, dia, entrada, salida, desde);
  }
}
