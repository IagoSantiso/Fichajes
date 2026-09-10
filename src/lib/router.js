/**
 * Enrutador mínimo. No hay framework a propósito: las rutas de este servicio
 * caben en una tabla y un enrutador propio pesa menos que la dependencia.
 */
export class Router {
  constructor() {
    this.rutas = [];
  }

  #añadir(metodo, patron, manejador) {
    const nombres = [];
    const expresion = new RegExp(
      '^' + patron.replace(/:[a-zA-Z_]+/g, (m) => {
        nombres.push(m.slice(1));
        return '([^/]+)';
      }) + '$',
    );
    this.rutas.push({ metodo, patron, expresion, nombres, manejador });
    return this;
  }

  get(p, h) { return this.#añadir('GET', p, h); }
  post(p, h) { return this.#añadir('POST', p, h); }
  put(p, h) { return this.#añadir('PUT', p, h); }
  patch(p, h) { return this.#añadir('PATCH', p, h); }
  delete(p, h) { return this.#añadir('DELETE', p, h); }

  /** Devuelve { manejador, parametros, clave } o null si ninguna ruta encaja. */
  resolver(metodo, ruta) {
    for (const r of this.rutas) {
      if (r.metodo !== metodo) continue;
      const coincidencia = r.expresion.exec(ruta);
      if (!coincidencia) continue;
      const parametros = {};
      r.nombres.forEach((n, i) => { parametros[n] = decodeURIComponent(coincidencia[i + 1]); });
      return { manejador: r.manejador, parametros, clave: `${metodo} ${r.patron}` };
    }
    return null;
  }
}
