/** Identificadores. UUID v4 del runtime, con prefijo para que se lean solos. */
export function nuevoId(prefijo) {
  return `${prefijo}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** Token opaco de 32 bytes en base64url, para enlaces mágicos y sesiones. */
export function nuevoToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
