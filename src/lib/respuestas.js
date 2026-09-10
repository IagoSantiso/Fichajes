/** Respuestas HTTP uniformes. Los errores nunca filtran detalle interno. */

export function json(datos, estado = 200, cabeceras = {}) {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...cabeceras,
    },
  });
}

export class ErrorHttp extends Error {
  constructor(estado, mensaje, codigo = null) {
    super(mensaje);
    this.estado = estado;
    this.codigo = codigo;
  }
}

export const malaPeticion = (m, c) => new ErrorHttp(400, m, c);
export const noAutenticado = (m = 'Sesión no válida o caducada') => new ErrorHttp(401, m);
export const prohibido = (m = 'Sin permiso para esta operación') => new ErrorHttp(403, m);
export const noEncontrado = (m = 'No encontrado') => new ErrorHttp(404, m);
export const conflicto = (m, c) => new ErrorHttp(409, m, c);

export function respuestaDeError(error, entorno) {
  if (error instanceof ErrorHttp) {
    return json({ error: error.message, codigo: error.codigo }, error.estado);
  }
  console.error('Error no controlado:', error?.stack ?? error);
  return json(
    {
      error: 'Error interno',
      ...(entorno === 'desarrollo' ? { detalle: String(error?.message ?? error) } : {}),
    },
    500,
  );
}
