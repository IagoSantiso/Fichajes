/**
 * Cadena de integridad de los fichajes.
 *
 * Cada fichaje guarda el hash del anterior *de su empresa* y su propio
 * SHA-256, calculado sobre el hash anterior más sus campos sustantivos.
 * La cadena es por empresa para que una empresa no dependa de otra.
 *
 * Los campos que entran en el hash son los que hacen prueba: quién, cuándo,
 * qué tipo de marca, y la trazabilidad de la corrección. Los campos
 * accesorios (user_agent, ip) quedan fuera a propósito: si mañana hubiera que
 * depurarlos por una petición de supresión, la cadena seguiría verificando.
 */

/** Campos sustantivos, en orden fijo. No reordenar ni quitar: rompe la cadena. */
export const CAMPOS_SUSTANTIVOS = [
  'id',
  'empresa_id',
  'empleado_id',
  'tipo',
  'timestamp_utc',
  'zona_horaria',
  'timestamp_declarado',
  'diferido',
  'origen',
  'tipo_evento',
  'modalidad',
  'naturaleza_hora',
  'autor_id',
  'autor_tipo',
  'tipo_registro',
  'fichaje_referenciado_id',
  'motivo',
];

const GENESIS = 'GENESIS';

/**
 * Serializa el fichaje de forma estable y sin ambigüedad posicional.
 * Se usa el separador \x1f (unit separator), que no puede aparecer en los
 * datos, para que dos campos distintos no puedan producir la misma cadena.
 */
export function serializarParaHash(fichaje, hashAnterior) {
  const partes = [hashAnterior ?? GENESIS];
  for (const campo of CAMPOS_SUSTANTIVOS) {
    const valor = fichaje[campo];
    partes.push(valor === null || valor === undefined ? '' : String(valor));
  }
  return partes.join('\x1f');
}

/** SHA-256 en hexadecimal, con la WebCrypto del runtime. */
export async function sha256Hex(texto) {
  const datos = new TextEncoder().encode(texto);
  const buffer = await crypto.subtle.digest('SHA-256', datos);
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Hash de un fichaje dado el hash del anterior de su empresa. */
export async function calcularHash(fichaje, hashAnterior) {
  return sha256Hex(serializarParaHash(fichaje, hashAnterior));
}

export const HASH_GENESIS = GENESIS;

/**
 * Verifica una secuencia de fichajes de una misma empresa, ordenada por
 * inserción. Devuelve el primer punto de ruptura, si lo hay.
 *
 * Se separan dos fallos distintos:
 *  - 'eslabon_roto': el hash_anterior no coincide con el hash del previo,
 *    es decir, falta un registro o se ha reordenado la cadena.
 *  - 'hash_no_coincide': los campos del registro no producen su propio hash,
 *    es decir, alguien ha modificado el contenido en la base de datos.
 */
export async function verificarCadena(fichajes) {
  let esperado = GENESIS;
  for (let i = 0; i < fichajes.length; i++) {
    const f = fichajes[i];
    if (f.hash_anterior !== esperado) {
      return {
        valida: false,
        motivo: 'eslabon_roto',
        posicion: i,
        fichaje_id: f.id,
        esperado,
        encontrado: f.hash_anterior,
      };
    }
    const recalculado = await calcularHash(f, f.hash_anterior);
    if (recalculado !== f.hash) {
      return {
        valida: false,
        motivo: 'hash_no_coincide',
        posicion: i,
        fichaje_id: f.id,
        esperado: recalculado,
        encontrado: f.hash,
      };
    }
    esperado = f.hash;
  }
  return { valida: true, verificados: fichajes.length, ultimo_hash: esperado };
}
