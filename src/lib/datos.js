/**
 * Capa de acceso a datos.
 *
 * Decisión no negociable número 5: ninguna consulta se ejecuta sin filtrar por
 * empresa_id, y el filtro se aplica *aquí*, no repetido a mano en cada
 * endpoint. Las rutas no reciben la base de datos: reciben un alcance ya
 * atado a una empresa, y no tienen forma de salirse de él.
 *
 * Las tablas de negocio se declaran en TABLAS_CON_EMPRESA. Añadir una tabla
 * de datos sin empresa_id es un error de diseño, no una excepción a permitir.
 */

/** Tablas de datos: todas llevan empresa_id y todas se filtran siempre. */
const TABLAS_CON_EMPRESA = new Set([
  'empleados',
  'horarios_teoricos',
  'calendario_laboral',
  'fichajes',
  'ausencias',
  'solicitudes_correccion',
  'incidencias',
  'log_accesos',
  'accesos_inspeccion',
]);

const IDENTIFICADOR = /^[a-z_][a-z0-9_]*$/;

function comprobarIdentificador(nombre) {
  if (!IDENTIFICADOR.test(nombre)) {
    throw new Error(`Identificador no válido: ${nombre}`);
  }
  return nombre;
}

/**
 * Construye la cláusula WHERE. Acepta valores sueltos (igualdad), arrays
 * (IN), null (IS NULL) y los operadores explícitos { op: '>=', valor }.
 */
function construirWhere(condiciones) {
  const trozos = [];
  const parametros = [];
  for (const [campo, valor] of Object.entries(condiciones ?? {})) {
    comprobarIdentificador(campo);
    if (valor === null) {
      trozos.push(`${campo} IS NULL`);
    } else if (Array.isArray(valor)) {
      if (valor.length === 0) { trozos.push('0 = 1'); continue; }
      trozos.push(`${campo} IN (${valor.map(() => '?').join(',')})`);
      parametros.push(...valor);
    } else if (typeof valor === 'object' && 'op' in valor) {
      const op = valor.op;
      if (!['=', '!=', '<', '<=', '>', '>=', 'LIKE'].includes(op)) {
        throw new Error(`Operador no permitido: ${op}`);
      }
      trozos.push(`${campo} ${op} ?`);
      parametros.push(valor.valor);
    } else {
      trozos.push(`${campo} = ?`);
      parametros.push(valor);
    }
  }
  return { sql: trozos.length ? `WHERE ${trozos.join(' AND ')}` : '', parametros };
}

/**
 * Alcance de datos atado a una empresa.
 * Se obtiene con `alcanceEmpresa(db, empresaId)`.
 */
class AlcanceEmpresa {
  constructor(db, empresaId) {
    if (!empresaId) {
      throw new Error('No se puede abrir un alcance de datos sin empresa_id');
    }
    this.db = db;
    this.empresaId = empresaId;
  }

  #tabla(nombre) {
    comprobarIdentificador(nombre);
    if (!TABLAS_CON_EMPRESA.has(nombre)) {
      throw new Error(`La tabla ${nombre} no es una tabla de datos con alcance de empresa`);
    }
    return nombre;
  }

  /** SELECT con filtro de empresa siempre presente. */
  async listar(tabla, condiciones = {}, opciones = {}) {
    const t = this.#tabla(tabla);
    const { sql: donde, parametros } = construirWhere({
      ...condiciones,
      empresa_id: this.empresaId,
    });
    let sql = `SELECT ${opciones.campos ?? '*'} FROM ${t} ${donde}`;
    if (opciones.orden) {
      sql += ` ORDER BY ${opciones.orden.split(',').map((c) => {
        const [campo, dir = 'ASC'] = c.trim().split(/\s+/);
        comprobarIdentificador(campo);
        return `${campo} ${dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
      }).join(', ')}`;
    }
    if (opciones.limite) sql += ` LIMIT ${Number(opciones.limite)}`;
    if (opciones.desplazamiento) sql += ` OFFSET ${Number(opciones.desplazamiento)}`;
    const { results } = await this.db.prepare(sql).bind(...parametros).all();
    return results ?? [];
  }

  async uno(tabla, condiciones = {}, opciones = {}) {
    const filas = await this.listar(tabla, condiciones, { ...opciones, limite: 1 });
    return filas[0] ?? null;
  }

  async contar(tabla, condiciones = {}) {
    const filas = await this.listar(tabla, condiciones, { campos: 'COUNT(*) AS n' });
    return filas[0]?.n ?? 0;
  }

  /** INSERT con empresa_id forzado al del alcance. */
  async insertar(tabla, fila) {
    const t = this.#tabla(tabla);
    const datos = { ...fila, empresa_id: this.empresaId };
    const campos = Object.keys(datos).map(comprobarIdentificador);
    const sql = `INSERT INTO ${t} (${campos.join(',')}) VALUES (${campos.map(() => '?').join(',')})`;
    await this.db.prepare(sql).bind(...campos.map((c) => datos[c] ?? null)).run();
    return datos;
  }

  /**
   * UPDATE con filtro de empresa. Los fichajes quedan fuera a propósito: son
   * append-only, y la base de datos además lo impide con un disparador.
   */
  async actualizar(tabla, condiciones, cambios) {
    const t = this.#tabla(tabla);
    if (t === 'fichajes') {
      throw new Error('Los fichajes son inmutables: use registrarRectificacion');
    }
    const campos = Object.keys(cambios).map(comprobarIdentificador);
    const { sql: donde, parametros } = construirWhere({
      ...condiciones,
      empresa_id: this.empresaId,
    });
    if (!donde) throw new Error('UPDATE sin condiciones');
    const sql = `UPDATE ${t} SET ${campos.map((c) => `${c} = ?`).join(', ')} ${donde}`;
    const r = await this.db.prepare(sql)
      .bind(...campos.map((c) => cambios[c] ?? null), ...parametros)
      .run();
    return r.meta?.changes ?? 0;
  }

  async borrar(tabla, condiciones) {
    const t = this.#tabla(tabla);
    if (t === 'fichajes') {
      throw new Error('Los fichajes son inmutables: use registrarAnulacion');
    }
    const { sql: donde, parametros } = construirWhere({
      ...condiciones,
      empresa_id: this.empresaId,
    });
    if (!donde) throw new Error('DELETE sin condiciones');
    const r = await this.db.prepare(`DELETE FROM ${t} ${donde}`).bind(...parametros).run();
    return r.meta?.changes ?? 0;
  }

  /**
   * Escotilla para consultas con JOIN o agregados que el constructor de arriba
   * no cubre. El SQL debe incluir el marcador :empresa, que se sustituye por
   * el parámetro correspondiente; si no aparece, la consulta se rechaza. Así
   * una consulta a medida sigue sin poder olvidarse del filtro.
   */
  async consulta(sql, parametros = []) {
    if (!sql.includes(':empresa')) {
      throw new Error('Toda consulta a medida debe filtrar por :empresa');
    }
    const partes = sql.split(':empresa');
    const ordenados = intercalarParametros(partes, this.empresaId, parametros);
    const { results } = await this.db.prepare(partes.join('?')).bind(...ordenados).all();
    return results ?? [];
  }
}

/**
 * Reconstruye el orden real de los parámetros: recorre el SQL trozo a trozo
 * contando los '?' que el llamante puso antes de cada ':empresa'.
 */
function intercalarParametros(partes, empresaId, parametros) {
  const salida = [];
  let cursor = 0;
  for (let i = 0; i < partes.length; i++) {
    const interrogantes = (partes[i].match(/\?/g) ?? []).length;
    salida.push(...parametros.slice(cursor, cursor + interrogantes));
    cursor += interrogantes;
    if (i < partes.length - 1) salida.push(empresaId);
  }
  salida.push(...parametros.slice(cursor));
  return salida;
}

export function alcanceEmpresa(db, empresaId) {
  return new AlcanceEmpresa(db, empresaId);
}

/**
 * Acceso sin alcance de empresa. Sólo para las tablas que no lo tienen:
 * gestorias, empresas, usuarios y la infraestructura de sesión. Cualquier
 * lectura de datos de trabajadores debe pasar por `alcanceEmpresa`.
 */
export function alcanceGlobal(db) {
  return {
    async uno(sql, parametros = []) {
      return (await db.prepare(sql).bind(...parametros).first()) ?? null;
    },
    async todos(sql, parametros = []) {
      const { results } = await db.prepare(sql).bind(...parametros).all();
      return results ?? [];
    },
    async ejecutar(sql, parametros = []) {
      return db.prepare(sql).bind(...parametros).run();
    },
  };
}

export { TABLAS_CON_EMPRESA };
