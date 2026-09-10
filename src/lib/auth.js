/**
 * Autenticación y sesión.
 *
 *  - Gestoría y empresa entran por enlace mágico al correo. No hay contraseñas
 *    que gestionar ni que filtrar.
 *  - El trabajador entra con el código de su empresa y un PIN de seis dígitos,
 *    porque muchos no tienen correo de trabajo. Su sesión dura mucho en su
 *    dispositivo: si tiene que autenticarse cada mañana, deja de fichar.
 *  - La sesión va en cookie httpOnly, firmada, y además existe en la tabla
 *    `sesiones` para poder revocarla.
 */
import { nuevoId, nuevoToken } from './ids.js';
import { ahoraUtc } from './tiempo.js';
import { noAutenticado, prohibido, malaPeticion } from './respuestas.js';

const COOKIE = 'sesion';
const DURACION_TRABAJADOR_DIAS = 180;
const DURACION_PANEL_HORAS = 12;
const DURACION_ENLACE_MINUTOS = 15;
const ITERACIONES_PBKDF2 = 100_000;

// --- Hash de PIN y contraseñas -------------------------------------------

/** PBKDF2-SHA256. Formato almacenado: pbkdf2$iteraciones$salHex$hashHex */
export async function hashearPin(pin) {
  if (!/^\d{6}$/.test(String(pin))) {
    throw malaPeticion('El PIN debe tener exactamente seis dígitos');
  }
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivar(String(pin), sal);
  return `pbkdf2$${ITERACIONES_PBKDF2}$${aHex(sal)}$${aHex(hash)}`;
}

export async function verificarPin(pin, almacenado) {
  if (!almacenado) return false;
  const [algoritmo, iteraciones, salHex, hashHex] = almacenado.split('$');
  if (algoritmo !== 'pbkdf2') return false;
  const hash = await derivar(String(pin), deHex(salHex), Number(iteraciones));
  return comparacionConstante(aHex(hash), hashHex);
}

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

// --- Enlaces mágicos ------------------------------------------------------

export async function crearEnlaceMagico(env, usuarioId) {
  const token = nuevoToken();
  const expira = new Date(Date.now() + DURACION_ENLACE_MINUTOS * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO enlaces_magicos (token_hash, usuario_id, expira_en, creado_en)
     VALUES (?,?,?,?)`,
  ).bind(await sha256Token(token), usuarioId, expira, ahoraUtc()).run();
  return { token, expira, minutos: DURACION_ENLACE_MINUTOS };
}

/** Canjea el token. De un solo uso: se marca como usado en el mismo paso. */
export async function canjearEnlaceMagico(env, token) {
  const hash = await sha256Token(token);
  const fila = await env.DB.prepare(
    `SELECT * FROM enlaces_magicos WHERE token_hash = ?`,
  ).bind(hash).first();
  if (!fila || fila.expira_en <= ahoraUtc()) {
    throw noAutenticado('El enlace no es válido o ha caducado');
  }
  // Quien pincha dos veces el mismo correo merece saber qué ha pasado.
  if (fila.usado_en) throw noAutenticado('Ese enlace ya se ha usado; pida otro');
  const r = await env.DB.prepare(
    `UPDATE enlaces_magicos SET usado_en = ? WHERE token_hash = ? AND usado_en IS NULL`,
  ).bind(ahoraUtc(), hash).run();
  if ((r.meta?.changes ?? 0) === 0) throw noAutenticado('El enlace ya se ha usado');

  return env.DB.prepare(`SELECT * FROM usuarios WHERE id = ? AND activo = 1`)
    .bind(fila.usuario_id).first();
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
  DURACION_ENLACE_MINUTOS,
};
