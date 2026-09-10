# Decisiones pendientes

Del brief técnico. Ninguna bloquea el desarrollo, pero todas hay que cerrarlas
antes de la conversación comercial con la gestoría. Se anota aquí lo que el
código deja preparado para cada una, para que cerrarla sea un cambio pequeño.

## 1. Nombre y dominio del producto

Y si sale con marca propia o con la marca de la gestoría.

**Estado en el código**: no hay nombre comercial en ninguna parte. La PWA se
titula «Registro de jornada» y el manifest usa «Fichaje» como nombre corto.
Cambiarlo son tres ficheros: `public/manifest.json`, los `<title>` de las
páginas y el `marca` de las cabeceras. Si sale con la marca de la gestoría, el
sitio natural para el logotipo es la barra superior, y convendría moverlo a un
ajuste por gestoría antes de tener la segunda.

## 2. Residencia física de los datos en D1

Qué se responde por escrito cuando lo pregunten. **Es la pendiente más urgente**:
la gestoría la va a trasladar y hay que responder con precisión.

Qué hay que verificar concretamente:

- En qué región queda la base D1 al crearla, y si se puede fijar.
- Dónde se replica y dónde se guardan las copias de seguridad.
- Qué dice el acuerdo de encargo de tratamiento de Cloudflare y qué cláusulas
  contractuales tipo aplican.

Hasta tener la respuesta verificada, no se afirma nada sobre residencia de
datos.

## 3. Canal de avisos

Correo solo, o correo y WhatsApp.

**Estado en el código**: `src/lib/correo.js` está detrás de una interfaz mínima
con proveedor configurable (`consola` en desarrollo, `resend` en producción).
Añadir WhatsApp es un proveedor más en ese módulo y un campo en `empresas`; el
motor de incidencias no se entera. La decisión real no es técnica sino de coste
y de soporte: un canal más es un canal más que se cae.

## 4. Quién usa el panel de empresa

Si lo usa el propio empresario o sólo la gestoría. Cambia bastante el nivel de
pulido que necesita esa parte.

**Estado en el código**: el panel está construido para que lo abra alguien que
entra una vez al mes —cada pantalla dice qué hace, nada de iconos sin etiqueta—
y la gestoría lo reutiliza tal cual entrando en una empresa. Si la respuesta es
«sólo la gestoría», sobra la mitad del pulido y falta densidad: la gestoría
querría ver más filas por pantalla y menos explicaciones. Si es «el empresario»,
lo que hoy se resuelve con `prompt()` —corregir un fichaje, editar un horario—
necesita formularios de verdad.

Lo que hoy se apoya en `prompt()` y habría que sustituir en ese caso:

- Corrección y anulación de un fichaje desde la rejilla.
- Alta manual de un fichaje.
- Edición del horario teórico semanal.
- Resolución de una solicitud de corrección.

## 5. Suelo de precio por empresa

Por debajo del cual el volumen no compensa el compromiso de cuatro años de
conservación. La gestoría fija el precio final, pero conviene tener el número
claro antes de la conversación.

**Lo que aporta el código**: el coste de infraestructura por empresa es
marginal —decenas de empresas y unos pocos miles de filas al año— así que el
suelo no lo marca el alojamiento, sino el soporte y el compromiso de
conservación. El número que hay que estimar es cuántas horas de atención al año
consume una empresa de tres personas, no cuántos megabytes ocupa.

---

# Deuda técnica conocida

Cosas que están bien para arrancar y que habrá que revisar. Se anotan para que
no se descubran por sorpresa.

- **`MODO_DEMO_ENLACE` debe apagarse antes de dar de alta datos reales.**
  Con esta variable a `"1"` (ver `wrangler.toml`), el enlace mágico de acceso
  de empresa y gestoría vuelve en la respuesta de la API y la pantalla de
  entrada lo enseña con un botón, para poder enseñar la plataforma a alguien
  sin tener un correo real conectado. Es exactamente lo que hace inseguro el
  mecanismo el resto del tiempo: cualquiera que sepa el correo de una empresa
  —no que tenga acceso a su buzón— puede entrar. Antes de cargar el primer
  cliente real, poner `MODO_DEMO_ENLACE = "0"` y, si aún no está, configurar un
  proveedor de correo de verdad (`CORREO_PROVEEDOR = "resend"`).

- **Verificación de la cadena completa**: `verificarCadenaEmpresa()` carga todos
  los fichajes de la empresa en memoria. A tres o cuatro fichajes por trabajador
  y día son unos pocos miles de filas al año, así que aguanta de sobra el
  horizonte de cuatro años de una empresa de quince personas. Si alguna vez hay
  una empresa mucho mayor, habrá que verificar por tramos y guardar puntos de
  control.

- **Fichaje del listado por código de empresa**: `GET /api/auth/empresa/:codigo`
  devuelve los nombres de la plantilla a quien conozca el código. Es el patrón
  de quiosco y es lo que hace que se pueda fichar sin recordar un usuario, pero
  conviene tenerlo presente: el código de empresa es, de facto, un secreto
  compartido. Cada consulta queda en el log de accesos.

- **Sin limitación de intentos de PIN**: seis dígitos y sin bloqueo por
  reintentos. Antes de salir a producción conviene añadir un contador por
  empleado —o por IP— con espera creciente. El log de accesos ya registra los
  intentos fallidos, así que la información para hacerlo está.

- **Correcciones en cadena**: un fichaje sólo admite una rectificación; para
  volver a corregirlo hay que corregir la última. Es lo correcto para no
  bifurcar la traza, pero la interfaz todavía no lo explica bien.

- **Exportación masiva**: devuelve un único fichero consolidado con una línea
  por trabajador y el nombre de la empresa por delante. Si la gestoría prefiere
  un fichero por empresa, hará falta comprimir en el Worker, que es justo lo que
  se quiso evitar.
