# Guía de uso

Documento de uso interno que explica la aplicación rol por rol, con capturas
tomadas de la aplicación en funcionamiento. El resultado es
[`docs/Guia-de-uso.pdf`](../docs/Guia-de-uso.pdf).

La guía se regenera entera, así que cuando la interfaz cambie no hay que
retocar capturas a mano: se vuelve a pasar el proceso.

## Cómo regenerarla

```bash
npm install
npm install --no-save playwright        # sólo hace falta para la guía

# 1. Base local con datos de ejemplo y un mes de fichajes realistas
npm run db:local
npm run semilla
node semillas/generar-mes.mjs
node semillas/pasar-motor.mjs

# 2. Arrancar la aplicación (en otra terminal)
npm run dev

# 3. Pedir el enlace mágico de la gestoría; aparece en la salida de wrangler
curl -X POST localhost:8787/api/auth/enlace \
     -H 'content-type: application/json' \
     -d '{"email":"gestor@ejemplo.es"}'

# 4. Capturar y componer
node guia/capturar.mjs "<el-enlace-que-salió-en-los-logs>"
node guia/generar-pdf.mjs
```

Si Chromium no está en la ruta que Playwright espera, indíquelo con
`CHROMIUM_PATH=/ruta/a/chrome`.

## Qué hay aquí

| Fichero | Qué es |
|---|---|
| `guia.html` | El documento: texto, maquetación y reglas de impresión |
| `capturar.mjs` | Recorre la aplicación y escribe las 22 capturas |
| `generar-pdf.mjs` | Imprime `guia.html` a PDF con Chromium |
| `capturas/` | Las capturas, versionadas para poder recomponer el PDF sin levantar la aplicación |

## Al actualizar la guía

Dos cosas que conviene no perder de vista, porque son decisiones del proyecto y
no detalles de redacción:

- **Nunca se rotula una cifra como «horas extra».** La etiqueta es *exceso sobre
  jornada teórica*. Hay una prueba que falla si eso cambia en el código; en este
  documento hay que cuidarlo a mano.
- **No se afirma que el sistema cumple el Real Decreto pendiente.** Revise
  [`../docs/NORMATIVA.md`](../docs/NORMATIVA.md) antes de tocar el apartado de
  Inspección: si la norma se ha publicado, ese apartado se queda obsoleto y hay
  que reescribirlo.
