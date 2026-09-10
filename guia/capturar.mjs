/**
 * Captura todas las pantallas que ilustran la guía de uso.
 *
 * Reproducible de principio a fin: arranque la aplicación con datos de ejemplo
 * y ejecute este script. Las capturas se sobreescriben, de modo que cuando la
 * interfaz cambie basta con volver a pasarlo y regenerar el PDF.
 *
 *   npm run db:local && npm run semilla
 *   node semillas/generar-mes.mjs && node semillas/pasar-motor.mjs
 *   npm run dev                        # en otra terminal
 *   node guia/capturar.mjs <enlace-magico-de-la-gestoria>
 *
 * El enlace mágico de la gestoría se obtiene pidiéndolo y copiándolo de la
 * salida de `wrangler dev`, donde el proveedor de correo de desarrollo lo
 * vuelca:
 *
 *   curl -X POST localhost:8787/api/auth/enlace \
 *        -H 'content-type: application/json' \
 *        -d '{"email":"gestor@ejemplo.es"}'
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const ENLACE_GESTORIA = process.argv[2];
const SALIDA = join(dirname(fileURLToPath(import.meta.url)), 'capturas');
const CODIGO_EMPRESA = 'SOLDPER';
const TRABAJADOR = 'Ana';
const PIN = '482915';

if (!ENLACE_GESTORIA) {
  console.error('Falta el enlace mágico de la gestoría. Ver la cabecera de este fichero.');
  process.exit(1);
}

mkdirSync(SALIDA, { recursive: true });

const errores = [];
const navegador = await chromium.launch({
  // En el entorno de desarrollo remoto Chromium viene preinstalado aquí.
  executablePath: process.env.CHROMIUM_PATH || undefined,
});

const comun = { locale: 'es-ES', timezoneId: 'Europe/Madrid', deviceScaleFactor: 2 };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function vigilar(pagina, etiqueta) {
  pagina.on('pageerror', (e) => errores.push(`${etiqueta}: ${e.message}`));
  pagina.on('console', (m) => {
    // El 401 de la comprobación inicial de sesión es esperado y no es un fallo.
    if (m.type() === 'error' && !m.text().includes('401')) {
      errores.push(`${etiqueta} (consola): ${m.text()}`);
    }
  });
}

// ---------------------------------------------------------------- trabajador

console.log('Trabajador: acceso y fichaje…');
const movil = await navegador.newContext({ ...comun, viewport: { width: 390, height: 800 } });
const t = await movil.newPage();
vigilar(t, 'trabajador');
await t.goto(BASE, { waitUntil: 'domcontentloaded' });
await t.waitForSelector('#paso-empresa:not([hidden])');

await t.screenshot({ path: `${SALIDA}/t1-codigo.png` });
await t.fill('#codigo', CODIGO_EMPRESA);
await t.click('#form-empresa button[type=submit]');
await t.waitForSelector('#paso-empleado:not([hidden])');
await t.screenshot({ path: `${SALIDA}/t2-elegir.png` });

await t.click(`#lista-empleados button:has-text("${TRABAJADOR}")`);
await t.waitForSelector('#paso-pin:not([hidden])');
for (const digito of PIN.slice(0, 4)) await t.click(`#teclado button:text-is("${digito}")`);
await t.screenshot({ path: `${SALIDA}/t3-pin.png` });
for (const digito of PIN.slice(4)) await t.click(`#teclado button:text-is("${digito}")`);
await t.waitForSelector('#app:not([hidden])', { timeout: 15000 });
await espera(1500);

// Se cierra la jornada, si estuviera abierta, para partir del estado «fuera».
for (let intento = 0; intento < 4; intento++) {
  const texto = await t.textContent('#texto-principal');
  if (texto.includes('entrada') || texto.includes('cerrada')) break;
  await t.click('#boton-principal');
  await espera(1100);
}
await espera(600);
await t.screenshot({ path: `${SALIDA}/t4-fuera.png` });

await t.click('#boton-principal');                       // entrada
await espera(1500);
await t.screenshot({ path: `${SALIDA}/t5-dentro.png` });

await t.click('#boton-secundario');                      // iniciar pausa
await espera(1500);
await t.screenshot({ path: `${SALIDA}/t6-pausa.png` });

await t.click('#boton-principal');                       // terminar pausa
await espera(1300);

console.log('Trabajador: cola sin conexión…');
await movil.setOffline(true);
await t.click('#boton-principal');
await espera(1800);
await t.screenshot({ path: `${SALIDA}/t7-offline.png` });
await movil.setOffline(false);
await espera(2500);

// Las consultas piden una ventana más alta: la tabla del mes no cabe en 800 px
// y una captura de página entera saldría interminable. Se cambia el tamaño sin
// abrir un contexto nuevo, que perdería la sesión.
console.log('Trabajador: consultas…');
await t.setViewportSize({ width: 390, height: 1000 });
for (const [vista, fichero] of [
  ['fichajes', 't8-mis-fichajes'],
  ['ausencias', 't9-ausencias'],
  ['incidencias', 't10-incidencias'],
]) {
  await t.click(`.barra nav button[data-vista=${vista}]`);
  await espera(1600);
  await t.screenshot({ path: `${SALIDA}/${fichero}.png` });
}
await movil.close();

// ------------------------------------------------------- empresa y gestoría

console.log('Gestoría y panel de empresa…');
const escritorio = await navegador.newContext({ ...comun, viewport: { width: 1200, height: 800 } });
const p = await escritorio.newPage();
vigilar(p, 'panel');

await p.goto(`${BASE}/entrar/`, { waitUntil: 'domcontentloaded' });
await espera(700);
await p.screenshot({ path: `${SALIDA}/c1-entrar.png` });

await p.goto(ENLACE_GESTORIA, { waitUntil: 'domcontentloaded' });
await espera(1800);
await p.screenshot({ path: `${SALIDA}/g1-empresas.png` });

for (const [vista, fichero] of [['cierre', 'g2-cierre'], ['alta', 'g3-alta']]) {
  await p.click(`.barra nav button[data-vista=${vista}]`);
  await espera(900);
  await p.screenshot({ path: `${SALIDA}/${fichero}.png` });
}

await p.click('.barra nav button[data-vista=empresas]');
await espera(900);
await p.click('.rejilla-empresas .tarjeta');
await espera(2400);
await p.screenshot({ path: `${SALIDA}/e1-ahora.png` });

for (const [vista, fichero] of [
  ['plantilla', 'e2-plantilla'],
  ['bandeja', 'e5-solicitudes'],
  ['incidencias', 'e6-incidencias'],
  ['informes', 'e7-informes'],
]) {
  await p.click(`.barra nav button[data-vista=${vista}]`);
  await espera(1400);
  if (vista === 'informes') { await p.click('#p-ver'); await espera(1300); }
  await p.screenshot({ path: `${SALIDA}/${fichero}.png` });
}

// Calendario, rejilla y ajustes son más largas y piden más alto.
await p.setViewportSize({ width: 1200, height: 1150 });
for (const [vista, fichero] of [
  ['calendario', 'e3-calendario'],
  ['rejilla', 'e4-fichajes'],
  ['ajustes', 'e8-ajustes'],
]) {
  await p.click(`.barra nav button[data-vista=${vista}]`);
  await espera(1500);
  await p.screenshot({ path: `${SALIDA}/${fichero}.png` });
}

await navegador.close();

if (errores.length) {
  console.error(`\n${errores.length} error(es) de JavaScript durante la captura:`);
  for (const e of errores) console.error(`  · ${e}`);
  process.exit(1);
}
console.log(`\nCapturas escritas en ${SALIDA}`);
