/**
 * Autenticación y sesión.
 *
 * Cada uno entra con credenciales suyas, sin correo de por medio:
 *
 *  - El trabajador teclea su identificador de seis cifras —el número de su
 *    empresa y el suyo dentro de ella— y su PIN, todo en el teclado numérico
 *    de la aplicación, que es lo que se puede usar con guantes. Su sesión dura
 *    mucho en su dispositivo: si tiene que autenticarse cada mañana, deja de
 *    fichar.
 *  - La empresa y la gestoría, con su correo y una contraseña.
 *
 * No hay enlaces mágicos: obligaban a mantener un proveedor de correo con
 * dominio verificado y a que el mensaje llegase, para un producto que se vende
 * a empresas de tres personas. Las claves olvidadas se reponen por jerarquía
 * (ver src/rutas/auth.js).
 *
 * La sesión va en cookie httpOnly, firmada, y además existe en la tabla
 * `sesiones` para poder revocarla.
 */
import { nuevoId, nuevoToken } from './ids.js';
import { ahoraUtc } from './tiempo.js';
import { noAutenticado, prohibido, malaPeticion, ErrorHttp } from './respuestas.js';

const COOKIE = 'sesion';
const DURACION_TRABAJADOR_DIAS = 180;
const DURACION_PANEL_HORAS = 12;
const ITERACIONES_PBKDF2 = 100_000;

/** Longitud mínima de la contraseña de empresa y gestoría. */
export const MINIMO_PASSWORD = 8;

// --- Hash de PIN y contraseñas -------------------------------------------

/**
 * PBKDF2-SHA256. Formato almacenado: pbkdf2$iteraciones$salHex$hashHex
 *
 * Mismo algoritmo para el PIN y para la contraseña: cambia lo que se admite
 * como entrada, no cómo se guarda.
 */
async function hashear(secreto) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivar(String(secreto), sal);
  return `pbkdf2$${ITERACIONES_PBKDF2}$${aHex(sal)}$${aHex(hash)}`;
}

/** Comprueba un secreto contra su hash almacenado. */
export async function verificarSecreto(secreto, almacenado) {
  if (!almacenado) return false;
  const [algoritmo, iteraciones, salHex, hashHex] = almacenado.split('$');
  if (algoritmo !== 'pbkdf2') return false;
  const hash = await derivar(String(secreto), deHex(salHex), Number(iteraciones));
  return comparacionConstante(aHex(hash), hashHex);
}

export async function hashearPin(pin) {
  if (!/^\d{6}$/.test(String(pin))) {
    throw malaPeticion('El PIN debe tener exactamente seis dígitos');
  }
  return hashear(pin);
}

export async function hashearPassword(password) {
  const texto = String(password ?? '');
  if (texto.length < MINIMO_PASSWORD) {
    throw malaPeticion(`La contraseña debe tener al menos ${MINIMO_PASSWORD} caracteres`);
  }
  return hashear(texto);
}

/** Alias histórico. La verificación es la misma para PIN y contraseña. */
export const verificarPin = verificarSecreto;

async function derivar(texto, sal, iteraciones = ITERACIONES_PBKDF2) {
  const clave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(texto), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: sal, iterations: iteraciones, hash: 'SHA-256' },
    clave, 256,
  );
  return new Uint8Array(bits);
}

const aHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const deHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

/** Comparación en tiempo constante, para no filtrar por temporización. */
export function comparacionConstante(a, b) {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

// --- Firma de la cookie ---------------------------------------------------

async function firmar(valor, secreto) {
  const clave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const firma = await crypto.subtle.sign('HMAC', clave, new TextEncoder().encode(valor));
  return aHex(new Uint8Array(firma));
}

export async function sha256Token(token) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return aHex(new Uint8Array(buffer));
}

// --- Sesiones -------------------------------------------------------------

/** Crea la sesión en base de datos y devuelve la cabecera Set-Cookie. */
export async function crearSesion(env, { actorTipo, actorId, empresaId = null, gestoriaId = null }) {
  const token = nuevoToken();
  const id = await sha256Token(token);
  const dias = actorTipo === 'empleado'
    ? DURACION_TRABAJADOR_DIAS
    : DURACION_PANEL_HORAS / 24;
  const expira = new Date(Date.now() + dias * 86400_000).toISOString();

  await env.DB.prepare(
    `INSERT INTO sesiones (id, actor_tipo, actor_id, empresa_id, gestoria_id, expira_en, creada_en)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(id, actorTipo, actorId, empresaId, gestoriaId, expira, ahoraUtc()).run();

  const firma = await firmar(token, env.SECRETO_SESION);
  const valor = `${token}.${firma}`;
  const maxAge = Math.round(dias * 86400);
  const seguro = env.ENTORNO === 'desarrollo' ? '' : ' Secure;';
  return `${COOKIE}=${valor}; Path=/; HttpOnly;${seguro} SameSite=Lax; Max-Age=${maxAge}`;
}

export function cookieDeCierre(env) {
  const seguro = env.ENTORNO === 'desarrollo' ? '' : ' Secure;';
  return `${COOKIE}=; Path=/; HttpOnly;${seguro} SameSite=Lax; Max-Age=0`;
}

function leerCookie(peticion, nombre) {
  const cabecera = peticion.headers.get('cookie') ?? '';
  for (const trozo of cabecera.split(';')) {
    const [k, ...resto] = trozo.trim().split('=');
    if (k === nombre) return resto.join('=');
  }
  return null;
}

/**
 * Resuelve la sesión de la petición. Devuelve null si no hay ninguna válida;
 * no lanza, para que las rutas públicas puedan seguir su curso.
 */
export async function sesionDe(peticion, env) {
  const bruto = leerCookie(peticion, COOKIE);
  if (!bruto || !bruto.includes('.')) return null;
  const corte = bruto.lastIndexOf('.');
  const token = bruto.slice(0, corte);
  const firma = bruto.slice(corte + 1);
  if (!comparacionConstante(await firmar(token, env.SECRETO_SESION), firma)) return null;

  const fila = await env.DB.prepare(
    `SELECT * FROM sesiones WHERE id = ? AND revocada_en IS NULL`,
  ).bind(await sha256Token(token)).first();
  if (!fila) return null;
  if (fila.expira_en <= ahoraUtc()) return null;

  return {
    id: fila.id,
    actorTipo: fila.actor_tipo,
    actorId: fila.actor_id,
    empresaId: fila.empresa_id,
    gestoriaId: fila.gestoria_id,
  };
}

export async function revocarSesion(env, sesionId) {
  await env.DB.prepare(`UPDATE sesiones SET revocada_en = ? WHERE id = ?`)
    .bind(ahoraUtc(), sesionId).run();
}

// --- Límite de intentos ---------------------------------------------------

/**
 * Dos cerrojos, porque frenan ataques distintos.
 *
 * Por identificador: cinco fallos y diez minutos de espera. A ese ritmo,
 * agotar el millón de combinaciones de un PIN de seis cifras llevaría casi
 * cuatro años.
 *
 * Por IP, más holgado: frena lo que el anterior no ve, que es probar un mismo
 * PIN contra muchos identificadores distintos —posible porque el identificador
 * es secuencial y por tanto enumerable—. El umbral es alto a propósito: varios
 * trabajadores tras la misma conexión de la nave no deben bloquearse entre
 * ellos.
 */
export const INTENTOS_MAXIMOS = 5;
export const INTENTOS_MAXIMOS_IP = 20;
export const BLOQUEO_MINUTOS = 10;

const claveIdentificador = (identificador) => `id:${String(identificador).toLowerCase()}`;
const claveIp = (ip) => `ip:${ip}`;

/**
 * Rechaza la petición si el identificador o la IP están bloqueados. Se llama
 * *antes* de comprobar la clave, para no dar ni siquiera la señal de si era
 * correcta.
 */
export async function exigirSinBloqueo(env, identificador, ip) {
  const claves = [claveIdentificador(identificador)];
  if (ip) claves.push(claveIp(ip));

  for (const clave of claves) {
    const fila = await env.DB.prepare(
      `SELECT bloqueado_hasta FROM intentos_acceso WHERE clave = ?`,
    ).bind(clave).first();
    if (!fila?.bloqueado_hasta) continue;
    if (fila.bloqueado_hasta <= ahoraUtc()) continue;

    // Con Date.now() y no con ahoraUtc(), que trunca los milisegundos y hacía
    // que un bloqueo de diez minutos se anunciara como once.
    const restan = Math.max(1, Math.ceil(
      (new Date(fila.bloqueado_hasta) - Date.now()) / 60_000,
    ));
    throw new ErrorHttp(
      429,
      `Demasiados intentos fallidos. Vuelva a probar en ${restan} minuto${restan === 1 ? '' : 's'}.`,
      'demasiados_intentos',
    );
  }
}

/** Anota un fallo y, alcanzado el límite, echa el cerrojo. */
export async function anotarFallo(env, identificador, ip) {
  await sumarFallo(env, claveIdentificador(identificador), INTENTOS_MAXIMOS);
  if (ip) await sumarFallo(env, claveIp(ip), INTENTOS_MAXIMOS_IP);
}

async function sumarFallo(env, clave, limite) {
  const ahora = ahoraUtc();
  const fila = await env.DB.prepare(
    `SELECT fallidos, bloqueado_hasta FROM intentos_acceso WHERE clave = ?`,
  ).bind(clave).first();

  // Un bloqueo ya vencido no arrastra la cuenta anterior: se empieza de cero.
  const vencido = fila?.bloqueado_hasta && fila.bloqueado_hasta <= ahora;
  const fallidos = (vencido ? 0 : (fila?.fallidos ?? 0)) + 1;
  const bloqueo = fallidos >= limite
    ? new Date(Date.now() + BLOQUEO_MINUTOS * 60_000).toISOString()
    : null;

  await env.DB.prepare(
    `INSERT INTO intentos_acceso (clave, fallidos, primer_fallo, ultimo_fallo, bloqueado_hasta)
     VALUES (?,?,?,?,?)
     ON CONFLICT(clave) DO UPDATE SET
       fallidos = excluded.fallidos,
       ultimo_fallo = excluded.ultimo_fallo,
       bloqueado_hasta = excluded.bloqueado_hasta`,
  ).bind(clave, fallidos, ahora, ahora, bloqueo).run();
}

/** Un acceso correcto borra la cuenta de fallos de ese identificador. */
export async function limpiarFallos(env, identificador, ip) {
  await env.DB.prepare(`DELETE FROM intentos_acceso WHERE clave = ?`)
    .bind(claveIdentificador(identificador)).run();
  // La cuenta por IP no se limpia: si no, bastaría un acceso legítimo entre
  // tanteos para reiniciar el contador y anular el cerrojo.
}

// --- Autorización ---------------------------------------------------------

/**
 * Comprueba que el actor puede operar sobre la empresa indicada y devuelve el
 * alcance. La gestoría puede entrar en cualquiera de *sus* empresas; la
 * empresa y el empleado, sólo en la suya; la inspección, sólo en la suya y en
 * modo lectura (lo aplica el enrutador, que no le da rutas de escritura).
 */
export async function comprobarAlcanceEmpresa(env, sesion, empresaId) {
  if (!sesion) throw noAutenticado();
  if (sesion.actorTipo === 'gestoria') {
    const empresa = await env.DB.prepare(
      `SELECT id FROM empresas WHERE id = ? AND gestoria_id = ?`,
    ).bind(empresaId, sesion.gestoriaId).first();
    if (!empresa) throw prohibido('Esa empresa no pertenece a su gestoría');
    return;
  }
  if (sesion.empresaId !== empresaId) throw prohibido();
}

export const DURACIONES = {
  DURACION_TRABAJADOR_DIAS,
  DURACION_PANEL_HORAS,
};
