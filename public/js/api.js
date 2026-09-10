/**
 * Cliente de la API. Un único punto por el que pasan todas las llamadas, para
 * que el manejo de sesión caducada y de errores esté en un sitio y no en cada
 * pantalla.
 */

/** Empresa en la que trabaja la gestoría ahora mismo (null para el resto). */
let empresaActiva = null;

export function fijarEmpresaActiva(id) {
  empresaActiva = id;
  if (id) sessionStorage.setItem('empresa_activa', id);
  else sessionStorage.removeItem('empresa_activa');
}

export function obtenerEmpresaActiva() {
  return empresaActiva ?? sessionStorage.getItem('empresa_activa');
}

export class ErrorApi extends Error {
  constructor(estado, mensaje, codigo) {
    super(mensaje);
    this.estado = estado;
    this.codigo = codigo;
  }
}

function conEmpresa(ruta) {
  const empresa = obtenerEmpresaActiva();
  if (!empresa) return ruta;
  const separador = ruta.includes('?') ? '&' : '?';
  return `${ruta}${separador}empresa=${encodeURIComponent(empresa)}`;
}

export async function api(ruta, opciones = {}) {
  const respuesta = await fetch(conEmpresa(ruta), {
    method: opciones.metodo ?? 'GET',
    headers: opciones.cuerpo ? { 'content-type': 'application/json' } : {},
    body: opciones.cuerpo ? JSON.stringify(opciones.cuerpo) : undefined,
    credentials: 'same-origin',
  });

  if (respuesta.status === 401) {
    // Un 401 puede ser una sesión caducada o unas credenciales que no valen.
    // El mensaje lo pone el servidor, que es quien sabe cuál de las dos es:
    // decirle «sesión caducada» a quien acaba de teclear mal su PIN no ayuda
    // a nadie. Sólo se redirige cuando quien llama no gestiona el error.
    const datos = await respuesta.json().catch(() => ({}));
    if (!opciones.silencioso) location.href = opciones.destinoEntrada ?? '/';
    throw new ErrorApi(401, datos.error ?? 'Sesión caducada', datos.codigo);
  }

  const tipo = respuesta.headers.get('content-type') ?? '';
  if (!tipo.includes('application/json')) {
    if (!respuesta.ok) throw new ErrorApi(respuesta.status, await respuesta.text());
    return respuesta;
  }

  const datos = await respuesta.json();
  if (!respuesta.ok) throw new ErrorApi(respuesta.status, datos.error ?? 'Error', datos.codigo);
  return datos;
}

/** Descarga un fichero de exportación respetando la empresa activa. */
export function descargar(ruta) {
  const enlace = document.createElement('a');
  enlace.href = conEmpresa(ruta);
  enlace.rel = 'noopener';
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
}

// --- Utilidades de presentación compartidas ------------------------------

export function horasYMinutos(minutos) {
  const signo = minutos < 0 ? '−' : '';
  const m = Math.abs(Math.round(minutos ?? 0));
  return `${signo}${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export function fechaLegible(fecha) {
  const [a, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d)).toLocaleDateString('es-ES', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

export const NOMBRE_TIPO = {
  entrada: 'Entrada',
  salida: 'Salida',
  inicio_pausa: 'Inicio de pausa',
  fin_pausa: 'Fin de pausa',
};

export const NOMBRE_ESTADO = {
  fuera: 'fuera',
  dentro: 'trabajando',
  en_pausa: 'en pausa',
};

export function escapar(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

/** Muestra un aviso efímero en el contenedor indicado. */
export function avisar(contenedor, mensaje, clase = '') {
  if (!contenedor) return;
  contenedor.className = `aviso ${clase}`;
  contenedor.textContent = mensaje;
  contenedor.hidden = false;
  if (clase === 'exito') {
    clearTimeout(contenedor._temporizador);
    contenedor._temporizador = setTimeout(() => { contenedor.hidden = true; }, 4000);
  }
}
