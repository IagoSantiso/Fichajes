/**
 * Imprime guia.html a PDF con Chromium.
 *
 * Se usa el motor del navegador en lugar de una librería de PDF porque la guía
 * es un documento maquetado con capturas: reglas @page, saltos controlados y
 * texto seleccionable salen gratis, y el resultado es el mismo que vería
 * cualquiera imprimiendo la página.
 *
 *   node guia/generar-pdf.mjs
 */
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const ORIGEN = join(AQUI, 'guia.html');
const DESTINO = join(AQUI, '..', 'docs', 'Guia-de-uso.pdf');

const navegador = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const pagina = await navegador.newPage();
await pagina.goto(`file://${ORIGEN}`, { waitUntil: 'load' });
// Da tiempo a que decodifiquen todas las capturas antes de paginar.
await pagina.waitForTimeout(1500);

await pagina.pdf({
  path: DESTINO,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: `
    <div style="width:100%;font-family:Segoe UI,system-ui,sans-serif;font-size:7.5pt;
                color:#8b95a1;padding:0 15mm;display:flex;justify-content:space-between">
      <span>Registro de jornada · Guía de uso</span>
      <span class="pageNumber"></span>
    </div>`,
  margin: { top: '16mm', bottom: '18mm', left: '15mm', right: '15mm' },
});

await navegador.close();
console.log(`PDF escrito en ${DESTINO}`);
