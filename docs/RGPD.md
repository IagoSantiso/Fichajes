# Protección de datos

## Roles

- **Responsable del tratamiento**: cada empresa cliente.
- **Encargado**: la gestoría.
- **Subencargado**: nosotros.

Hace falta **contrato de encargo con la gestoría**, y que ella tenga
**autorización de sus clientes para subcontratar**. Sin eso, la cadena de
encargo no se sostiene, por muy bien que funcione el software.

## Conservación

Cuatro años desde cada registro, según el artículo 34.9 del Estatuto de los
Trabajadores.

**No se borra nada dentro de ese plazo**, ni siquiera al dar de baja a un
trabajador o a una empresa. La baja de un trabajador marca `activo = 0` y pone
`fecha_baja`; sus fichajes siguen donde estaban. Cualquier rutina de borrado que
se escriba en el futuro debe respetar ese plazo y no puede tocar la tabla
`fichajes`, que es inmutable por diseño.

## Datos que sí se guardan

| Dato | Por qué |
|------|---------|
| Nombre, apellidos y documento de identidad | Identificación en el registro y en los informes |
| Marcas horarias de entrada, salida y pausas | Es el objeto del tratamiento |
| IP y user-agent del fichaje | Trazabilidad del registro. No entran en el hash |
| Tipo y fechas de las ausencias | Cálculo de jornada teórica y supresión de incidencias |
| Quién consulta qué y cuándo | Log de accesos, para poder acreditarlo |

## Datos que no se guardan, y por qué

**Motivo médico de una baja.** Se guardan tipo y fechas, nunca el diagnóstico ni
ningún dato de salud. Es categoría especial del artículo 9 del RGPD y no debe
entrar en la base de datos bajo ningún concepto. El código lo impone: en una
ausencia de tipo `baja`, el campo de comentario se descarta aunque el cliente lo
envíe, tanto al crearla como al resolverla. Hay una prueba que lo verifica.

**Biometría y reconocimiento facial.** Nada. La Agencia Española de Protección de
Datos es muy restrictiva con el control de presencia biométrico y no compensa el
riesgo. Está fuera de alcance de forma explícita.

**Geolocalización continua.** No existe. La captura de posición es:

- Opcional y **desactivada por defecto**.
- Se activa **por empresa** y exige dejar por escrito la justificación del
  tratamiento (mínimo veinte caracteres); el código rechaza activarla sin ella.
- Se captura **sólo en el instante del fichaje** y nunca de forma continua.
- Si la empresa no la tiene activada, el servidor descarta las coordenadas
  aunque el cliente las mande.

## Seguridad

- **PIN y contraseñas con hash**: PBKDF2-SHA256 con 100.000 iteraciones y sal
  por registro. El PIN nunca vuelve en una respuesta de la API, ni siquiera
  hasheado.
- **Tokens con hash**: de los enlaces mágicos, de las sesiones y de los accesos
  de inspección sólo se guarda el SHA-256. Un volcado de la base de datos no
  permite suplantar a nadie.
- **Cookies de sesión** `httpOnly`, firmadas con HMAC, `SameSite=Lax` y `Secure`
  fuera de desarrollo. Revocables desde la tabla `sesiones`.
- **Log de accesos activo desde el primer día**, en consultas, exportaciones,
  correcciones y aprobaciones. Parece prescindible y no lo es: el borrador
  reconoce derecho de acceso al trabajador, a la representación legal y a la
  Inspección, y llegado el caso hay que poder acreditar quién consultó qué.
- **Aislamiento por empresa** en la capa de datos, no en cada endpoint. Ver
  [`ARQUITECTURA.md`](ARQUITECTURA.md).
- **La respuesta de acceso no distingue** «ese correo no existe» de «ese correo
  existe», ni «ese trabajador no existe» de «PIN incorrecto».

## Derechos de los interesados

- **Acceso**: el trabajador ve sus fichajes en la PWA y puede descargarse su
  propio registro diario en PDF sin pasar por la empresa. Hacer que un derecho
  dependa de pedírselo al jefe lo convierte en un favor.
- **Rectificación**: el trabajador solicita; la empresa o la gestoría resuelve.
  La corrección no borra el original, y tanto la solicitud como la resolución
  quedan registradas con autor y motivo.
- **Supresión**: limitada por la obligación legal de conservación de cuatro
  años, que prevalece. Pasado el plazo, la supresión de datos accesorios (IP,
  user-agent) es posible sin romper la cadena de hashes, porque esos campos no
  entran en el cálculo.

## Residencia de los datos

**Pendiente de verificar y documentar por escrito.** Es una pregunta que la
gestoría va a trasladar y hay que poder responderla con precisión, no con una
aproximación. Ver [`DECISIONES-PENDIENTES.md`](DECISIONES-PENDIENTES.md).
