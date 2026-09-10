/**
 * Acceso a la base D1 local de miniflare desde un script suelto.
 *
 * Los scripts de semilla escriben directamente sobre el SQLite porque generan
 * datos fechados en el pasado, y la API —con razón— no permite fechar hacia
 * atrás salvo por la vía de alta manual. Sólo para desarrollo.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIRECTORIO_D1 = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';

function localizarBase() {
  let ficheros;
  try {
    ficheros = readdirSync(DIRECTORIO_D1).filter((f) => f.endsWith('.sqlite'));
  } catch {
    throw new Error(
      `No encuentro la base local en ${DIRECTORIO_D1}.\n` +
      'Ejecute antes:  npm run db:local  &&  npm run semilla',
    );
  }
  if (!ficheros.length) throw new Error('No hay ninguna base D1 local todavía');
  // Si hubiera varias, la más reciente.
  return ficheros
    .map((f) => join(DIRECTORIO_D1, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

class Sentencia {
  constructor(db, sql) { this.db = db; this.sql = sql; this.parametros = []; }
  bind(...parametros) {
    this.parametros = parametros.map((p) => {
      if (p === undefined) return null;
      if (typeof p === 'boolean') return p ? 1 : 0;
      return p;
    });
    return this;
  }
  async all() { return { results: this.db.prepare(this.sql).all(...this.parametros), success: true }; }
  async first() { return this.db.prepare(this.sql).get(...this.parametros) ?? null; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.parametros);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

/** Devuelve { db, env } con la misma superficie que usa el Worker. */
export function abrirD1Local() {
  const db = new DatabaseSync(localizarBase());
  return {
    db,
    env: {
      DB: { prepare: (sql) => new Sentencia(db, sql) },
      ENTORNO: 'desarrollo',
      CORREO_PROVEEDOR: 'consola',
    },
  };
}
