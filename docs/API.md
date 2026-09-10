# Referencia de la API

Todas las rutas cuelgan de `/api/`. Lo que no empieza por `/api/` lo sirven los
assets estáticos de la PWA.

## Autenticación y alcance

La sesión va en una cookie `httpOnly` firmada. Hay cuatro tipos de actor:

| Actor | Cómo entra | Alcance |
|-------|-----------|---------|
| `empleado` | Código de empresa + PIN | Sólo sus propios datos |
| `empresa` | Enlace mágico al correo | Su empresa |
| `gestoria` | Enlace mágico al correo | Cualquiera de sus empresas |
| `inspeccion` | Cabecera `Authorization: Inspeccion <token>` | Una empresa, sólo lectura |

La gestoría indica en qué empresa trabaja con el parámetro `?empresa=<id>` (o
`empresa_id` en el cuerpo). Los demás actores la llevan en la sesión.

### Rutas públicas

`POST /api/auth/enlace` · `GET /api/auth/entrar` · `GET /api/auth/empresa/:codigo`
· `POST /api/auth/pin` · `GET /api/salud`

### Errores

| Código | Significado |
|--------|-------------|
| 400 | Petición mal formada |
| 401 | Sin sesión válida |
| 403 | Sesión válida, pero sin permiso para eso |
| 404 | No existe, o no existe *para usted* |
| 409 | Conflicto de estado (transición de fichaje imposible, solicitud ya resuelta) |

Cuerpo: `{ "error": "…", "codigo": "…" }`. El `codigo` sólo aparece en los casos
que el frontend necesita distinguir, como `transicion_invalida`.

## Autenticación

| Método | Ruta | Qué hace |
|--------|------|----------|
| `POST` | `/api/auth/enlace` | Pide un enlace mágico. Responde igual exista o no la cuenta |
| `GET` | `/api/auth/entrar?token=` | Canjea el enlace y redirige al panel. De un solo uso |
| `GET` | `/api/auth/empresa/:codigo` | Empresa y nombres de su plantilla, para elegirse antes del PIN |
| `POST` | `/api/auth/pin` | Entrada del trabajador: `{ codigo, empleado_id, pin }` |
| `GET` | `/api/auth/yo` | Quién soy. Lo llama el frontend al arrancar |
| `POST` | `/api/auth/salir` | Revoca la sesión |

## Fichajes

| Método | Ruta | Qué hace |
|--------|------|----------|
| `GET` | `/api/fichajes/estado` | Estado actual, acciones disponibles y fichajes del día |
| `POST` | `/api/fichajes` | Ficha. `{ tipo, timestamp_declarado?, idempotencia?, latitud?, longitud? }` |
| `GET` | `/api/fichajes/empleado/:id` | Fichajes de un empleado en un periodo, con su traza |
| `GET` | `/api/fichajes/rejilla` | Rejilla de toda la plantilla |
| `GET` | `/api/fichajes/presentes` | Quién está dentro ahora mismo |
| `POST` | `/api/fichajes/:id/rectificar` | Corrige. Exige `motivo` |
| `POST` | `/api/fichajes/:id/anular` | Anula. Exige `motivo` |
| `POST` | `/api/fichajes/alta-manual` | Registra un fichaje que nunca llegó a existir |
| `GET` | `/api/fichajes/verificar-cadena` | Verifica la cadena de hashes de la empresa |

El campo `idempotencia` permite a la cola offline reenviar sin duplicar: si el
fichaje ya está, se devuelve el existente con `repetido: true`.

Los periodos se piden como `?desde=&hasta=` o como
`?periodo=mes|trimestre|semestre|anio&anio=&indice=`.

## Correcciones

| Método | Ruta | Qué hace |
|--------|------|----------|
| `POST` | `/api/correcciones` | El trabajador solicita. Con `fichaje_id` es rectificación; sin él, alta |
| `GET` | `/api/correcciones?estado=` | Bandeja de solicitudes |
| `POST` | `/api/correcciones/:id/resolver` | `{ decision: "aprobar"\|"denegar", hora, tipo, motivo }` |

## Plantilla, horarios y calendario

| Método | Ruta | Qué hace |
|--------|------|----------|
| `GET` | `/api/empleados` | Plantilla. `?incluir_bajas=1` para ver también las bajas |
| `GET` | `/api/empleados/:id` | Ficha de un trabajador |
| `POST` | `/api/empleados` | Alta |
| `PATCH` | `/api/empleados/:id` | Edición. `pin` cambia el PIN |
| `POST` | `/api/empleados/:id/baja` | Baja. No borra nada |
| `GET` | `/api/empleados/:id/horario` | Horario teórico, con el vigente aparte |
| `PUT` | `/api/empleados/:id/horario` | Fija el horario. Cierra la vigencia del anterior |
| `GET` | `/api/calendario?anio=` | Calendario laboral |
| `POST` | `/api/calendario` | Marca un festivo o un cierre. Idempotente por fecha |
| `DELETE` | `/api/calendario/:fecha` | Quita un día marcado |

## Ausencias

| Método | Ruta | Qué hace |
|--------|------|----------|
| `GET` | `/api/ausencias?estado=` | Ausencias. El trabajador ve las suyas |
| `GET` | `/api/ausencias/saldo?anio=` | Saldo de vacaciones, sin devengo ni arrastres |
| `POST` | `/api/ausencias` | Solicita. Desde el panel entra ya aprobada |
| `POST` | `/api/ausencias/:id/resolver` | `{ decision: "aprobar"\|"denegar" }` |
| `POST` | `/api/ausencias/:id/cancelar` | Cancela |

En una ausencia de tipo `baja` el campo `comentario` se descarta siempre.

## Incidencias

| Método | Ruta | Qué hace |
|--------|------|----------|
| `GET` | `/api/incidencias?estado=` | Incidencias. El trabajador ve las suyas |
| `POST` | `/api/incidencias/:id/estado` | `{ estado: "resuelta"\|"ignorada"\|"abierta" }` |
| `POST` | `/api/incidencias/revisar` | Pasada manual del motor sobre una fecha. Idempotente |
| `GET` | `/api/incidencias/tipos` | Catálogo de tipos por familia |

## Informes y exportación

| Método | Ruta | Qué hace |
|--------|------|----------|
| `GET` | `/api/informes` | Informe del periodo en JSON |
| `GET` | `/api/informes/integridad` | Verificación de la cadena, con hash de cierre |
| `GET` | `/api/informes/accesos` | Log de accesos de la empresa |
| `GET` | `/api/exportacion?formato=` | Exporta el periodo. `pdf`, `csv` o `nombre@version` |
| `GET` | `/api/exportacion/empleado/:id` | Registro diario de un trabajador |
| `GET` | `/api/exportacion/formatos` | Adaptadores disponibles y sus versiones |

La respuesta de exportación lleva la cabecera `X-Adaptador-Exportacion` con el
adaptador y la versión con que se generó, para poder reproducirla igual más
adelante.

## Gestoría

| Método | Ruta | Qué hace |
|--------|------|----------|
| `GET` | `/api/gestoria/empresas` | Empresas con semáforo (`rojo`, `ambar`, `verde`) |
| `POST` | `/api/gestoria/empresas` | Alta de empresa nueva |
| `GET` | `/api/gestoria/exportacion` | Exportación masiva. `?empresas=id1,id2` |

## Empresa e Inspección

| Método | Ruta | Qué hace |
|--------|------|----------|
| `GET` | `/api/empresa/resumen` | Portada del panel |
| `PATCH` | `/api/empresa` | Ajustes. Activar la geolocalización exige justificación escrita |
| `POST` | `/api/inspeccion/acceso` | Genera un token de sólo lectura con caducidad. Se muestra una sola vez |
| `GET` | `/api/inspeccion/accesos` | Accesos generados y su vigencia |
| `POST` | `/api/inspeccion/accesos/:id/revocar` | Revoca uno |
| `GET` | `/api/inspeccion/empresa` | Ficha de empresa, con el token de inspección |

Un token de inspección sólo puede recorrer las rutas de lectura enumeradas en
`RUTAS_INSPECCION` (`src/rutas/inspeccion.js`). Cualquier otra devuelve 403.
