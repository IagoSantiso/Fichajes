/**
 * Regresión: ¿se ve un despliegue sin borrar la caché a mano?
 *
 * Sirviendo de caché primero, el service worker dejaba invisible cualquier
 * despliegue para quien ya hubiera abierto la aplicación una vez. Costó una
 * tarde de diagnóstico en un despliegue real, así que queda fijado aquí.
 *
 * Necesita Playwright y levanta el servidor por su cuenta, por eso vive fuera
 * de `npm test`:
 *
 *   npm install --no-save playwright
 *   npm run test:navegador
 *
 * El servidor se reinicia entre el cambio y la recarga porque `wrangler dev`
 * no recalcula el ETag de los assets al vuelo: sin reinicio devuelve 304 y la
 * prueba mediría ese defecto del servidor de desarrollo en lugar de la
 * estrategia del service worker. Un despliegue real sí cambia el ETag.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const B = 'http://127.0.0.1:8787';
const RAIZ = new URL('../..', import.meta.url).pathname;
const FICHERO = `${RAIZ}public/entrar/index.html`;
const original = readFileSync(FICHERO, 'utf8');
let servidor = null;

const esperarServidor = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      execSync(`curl -sf --noproxy '*' ${B}/api/salud -o /dev/null`, { stdio: 'ignore' });
      return true;
    } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw new Error('el servidor no arrancó');
};

const arrancar = async () => {
  servidor = spawn('npx', ['wrangler', 'dev', '--local', '--port', '8787', '--ip', '127.0.0.1'],
    { cwd: RAIZ, stdio: 'ignore', detached: true });
  await esperarServidor();
};
const parar = () => { if (servidor) { try { process.kill(-servidor.pid); } catch {} servidor = null; } };

const nav = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await nav.newContext();
const p = await ctx.newPage();

try {
  await arrancar();

  await p.goto(B, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 20000 });
  await p.goto(`${B}/entrar/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  console.log(`1. antes del despliegue: "${await p.textContent('h1')}"`);

  // Despliegue: cambia el fichero y el servidor vuelve a levantarse.
  parar();
  await new Promise((r) => setTimeout(r, 2000));
  writeFileSync(FICHERO, original.replace('<h1>Entrar</h1>', '<h1>ENTRAR-DESPLEGADO</h1>'), 'utf8');
  await arrancar();
  console.log('2. desplegado (servidor reiniciado con el fichero nuevo)');

  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const despues = await p.textContent('h1');
  console.log(`3. tras una recarga normal: "${despues}"`);

  if (despues === 'ENTRAR-DESPLEGADO') {
    console.log('\n✅ El despliegue se ve sin borrar caché ni forzar nada');
  } else {
    console.log('\n❌ Sigue sirviendo la versión vieja');
    process.exitCode = 1;
  }
} finally {
  writeFileSync(FICHERO, original, 'utf8');
  await nav.close();
  parar();
}
