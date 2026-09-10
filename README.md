# Plataforma de registro de jornada

Herramienta de fichaje para pequeñas empresas, distribuida a través de una
gestoría laboral. El cliente final típico es un autónomo con entre uno y quince
trabajadores, obligado a llevar registro horario por el artículo 34.9 del
Estatuto de los Trabajadores, y para el que las plataformas de recursos humanos
del mercado son caras y desproporcionadas.

Es un producto multiempresa con un único canal comercial, no un SaaS de venta
directa: la gestoría aporta los clientes y fija el precio; nosotros aportamos la
plataforma, el alojamiento y el mantenimiento.

## Qué hay construido

| Fase | Contenido | Estado |
|------|-----------|--------|
| 1. Núcleo | Esquema con cadena de hashes, autenticación, PWA de fichaje, panel de empresa, exportación en PDF y CSV | Completa |
| 2. Calendario | Calendario laboral, horarios teóricos versionados, ausencias con solicitud y aprobación | Completa |
| 3. Incidencias | Motor estructural y de expectativa, cron, avisos, vistas en los tres roles | Completa |
| 4. Gestoría | Panel transversal, semáforo por empresa, exportación masiva, informes por periodo | Completa |
| 5. Inspección | Adaptador contra la orden ministerial | **Bloqueada**: la orden no existe. Ver [`docs/NORMATIVA.md`](docs/NORMATIVA.md) |

## Puesta en marcha

```bash
npm install

# Base de datos
npx wrangler d1 create fichajes          # copie el database_id a wrangler.toml
npm run db:local                          # aplica las migraciones en local
npm run semilla                           # datos de ejemplo (sólo desarrollo)
node semillas/generar-mes.mjs             # un mes de fichajes realistas
node semillas/pasar-motor.mjs             # y sus incidencias

# Secreto de sesión para desarrollo
cp .dev.vars.ejemplo .dev.vars            # y ponga una cadena larga y aleatoria

npm run dev
```

Con la semilla cargada:

- **Trabajador**: <http://localhost:8787/> — identificador `001001` (Ana),
  `001002` (Luis) o `001003` (Marta), y PIN `482915`.
- **Empresa y gestoría**: <http://localhost:8787/entrar/> —
  `jefe@soldaduras.ejemplo` o `gestor@ejemplo.es`, contraseña `fichajes2026`.

### Dar un enlace de previsualización a un cliente

Para que alguien pueda probar la plataforma en una URL pública, sin instalar
nada y sin depender de `wrangler dev`, se despliega igual que a producción:

```bash
npx wrangler login
npx wrangler secret put SECRETO_SESION
npx wrangler d1 create fichajes           # si aún no existe; copie el database_id
npm run db:remoto
npm run deploy
```

Eso deja la plataforma en pie, pero con la base vacía: todas las rejillas
saldrían a cero, que es una mala demostración. Para llevar al otro lado el mes
de fichajes de ejemplo, se genera en local y se vuelca a un fichero de SQL:

```bash
npm run db:local && npm run semilla       # base local de partida
node semillas/generar-mes.mjs             # un mes de fichajes realistas
node semillas/pasar-motor.mjs             # y sus incidencias
node semillas/volcar-demo.mjs             # -> semillas/demo-completa.sql

npx wrangler d1 execute fichajes --remote --file=./semillas/demo-completa.sql
```

El volcado es autocontenido —trae gestoría, empresa, plantilla, horarios,
calendario, fichajes e incidencias— y se puede reaplicar sin duplicar nada.
La cadena de integridad de los fichajes viaja intacta; hay pruebas que lo
comprueban.

La URL que da `npm run deploy`
(`https://fichajes.<su-subdominio>.workers.dev`) ya sirve para que el cliente
entre como trabajador (identificador `001001`, PIN `482915`) o como
empresa/gestoría desde `/entrar/` con `gestor@ejemplo.es` y `fichajes2026`.

**Antes de dar de alta el primer cliente real**, cambie las contraseñas y los
PIN de la semilla: están escritos en este repositorio y por tanto no son
secretos.

### Producción

```bash
npx wrangler secret put SECRETO_SESION    # obligatorio: firma las cookies de sesión
npx wrangler secret put RESEND_API_KEY    # sólo si CORREO_PROVEEDOR = "resend"
npm run db:remoto
npm run deploy
```

Y en `wrangler.toml`, `CORREO_PROVEEDOR = "resend"`: el correo ya no
interviene en el acceso, pero sí en los avisos de incidencias.

### Cómo se entra

| Quién | Con qué | Si la olvida |
|---|---|---|
| Trabajador | Identificador de seis cifras (tres de su empresa, tres suyas) y PIN | Se la repone su empresa |
| Empresa | Su correo y una contraseña | Se la repone su gestoría |
| Gestoría | Su correo y una contraseña | Se repone a mano en la base de datos |

No hay enlaces mágicos ni correos de recuperación: obligaban a mantener un
proveedor de correo con dominio verificado y a que el mensaje llegase, para un
producto que se vende a empresas de tres personas. Toda clave repartida por
otro obliga a cambiarla en el primer acceso.

Cinco intentos fallidos bloquean un identificador diez minutos; veinte desde
una misma IP la bloquean a ella, que es lo que frena el barrido de
identificadores.

## Pruebas

```bash
npm test
```

Las pruebas corren contra el esquema real, sobre SQLite en memoria, incluidos
los disparadores de inmutabilidad y los índices únicos. Cubren la cadena de
hashes, el aislamiento por empresa, el motor de incidencias, los cambios de hora
de marzo y octubre, la autenticación y un recorrido de extremo a extremo por la
API.

## Cómo está organizado

```
src/
  index.js                  Enrutador: resuelve sesión, empresa y alcance de datos
  lib/
    fichajes.js             Registro, rectificación, anulación y estado del botón
    hash.js                 Cadena SHA-256 y verificación
    datos.js                Capa de acceso con filtro de empresa obligatorio
    auth.js                 Claves, sesiones y límite de intentos
    tiempo.js               Zonas horarias, periodos y aritmética de fechas
    informes.js             Cálculo de informes
    correo.js, log.js, router.js, ids.js, respuestas.js
  rutas/                    Endpoints por área
  incidencias/
    motor.js                Detección estructural y de expectativa
    cron.js                 Reparto de los disparadores programados
  exportacion/
    index.js                Punto único de salida de datos
    adaptadores/            csv.js, pdf.js — versionados
public/                     PWA del trabajador y paneles de empresa y gestoría
migraciones/                Esquema de la base de datos
semillas/                   Datos de ejemplo y generador de un mes de fichajes
pruebas/                    Suite de pruebas
guia/                       Fuente de la guía de uso: capturas y maquetación
docs/                       Arquitectura, normativa, RGPD y la guía en PDF
```

## Lo que este sistema no hace

La lista es tan importante como la de funcionalidades, y se dice en la venta, no
cuando el primer cliente lo pida:

- Cuadrantes y turnos rotativos.
- Nóminas y cualquier cálculo salarial.
- Biometría, reconocimiento facial y geovallado continuo.
- Aplicación nativa en tiendas.
- Control de acceso físico, gestión documental, evaluación del desempeño y el
  resto de la suite de recursos humanos.
- Cálculo automático de saldos de vacaciones según convenio.

## Documentación

- [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) — las seis decisiones no
  negociables y por qué lo son.
- [`docs/NORMATIVA.md`](docs/NORMATIVA.md) — situación legal a día de hoy y qué
  se puede afirmar comercialmente.
- [`docs/RGPD.md`](docs/RGPD.md) — roles, conservación y datos que no se guardan.
- [`docs/API.md`](docs/API.md) — referencia de los endpoints.
- [`docs/DECISIONES-PENDIENTES.md`](docs/DECISIONES-PENDIENTES.md) — lo que falta
  por cerrar antes de vender.
- [`docs/Guia-de-uso.pdf`](docs/Guia-de-uso.pdf) — guía ilustrada, rol por rol,
  con capturas de la aplicación en funcionamiento. Se regenera entera desde
  [`guia/`](guia/README.md).
