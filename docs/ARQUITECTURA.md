# Arquitectura

Seis decisiones que cuestan poco hoy y son carísimas de introducir con dos años
de datos acumulados. Ninguna debe simplificarse por rapidez. Este documento dice
dónde vive cada una en el código, para que quien venga después sepa qué está
tocando.

## 1. Fichajes inmutables

La tabla `fichajes` es append-only. No existe `UPDATE` ni `DELETE` sobre ella en
ninguna ruta del código, y además la base de datos lo impide con disparadores:

```sql
CREATE TRIGGER fichajes_sin_update BEFORE UPDATE ON fichajes
BEGIN SELECT RAISE(ABORT, 'Los fichajes son inmutables: inserte una rectificacion'); END;
```

Corregir un fichaje significa insertar un registro nuevo de tipo
`rectificacion` que referencia al original y guarda autor, motivo y momento del
cambio. Anularlo, uno de tipo `anulacion`. El original permanece siempre visible
en la traza.

`fichajesEfectivos()` en `src/lib/fichajes.js` es la vista de cálculo: descarta
los registros sustituidos y las anulaciones. No borra nada; sólo decide qué
cuenta a efectos de jornada.

**Dónde**: `migraciones/0001_esquema_inicial.sql`, `src/lib/fichajes.js`, y la
guarda de `src/lib/datos.js` que rechaza cualquier `actualizar('fichajes', …)`.

## 2. Encadenamiento por hash

Cada fichaje guarda el hash del anterior *de su empresa* y su propio SHA-256,
calculado sobre el hash anterior más sus campos sustantivos. La cadena es por
empresa, no global, para que una empresa no dependa de otra: si mañana hay que
extraer, migrar o dar de baja a un cliente, su cadena se lleva entera.

Los campos que entran en el hash están en `CAMPOS_SUSTANTIVOS`, en orden fijo.
**Reordenarlos o quitar uno rompe toda la cadena histórica.** La IP y el
user-agent quedan fuera a propósito: si algún día hubiera que depurarlos por una
petición de supresión, la cadena seguiría verificando.

La serialización usa `\x1f` como separador, que no puede aparecer en los datos,
para que dos combinaciones distintas de campos no puedan producir la misma
cadena de entrada.

### Concurrencia

El índice único `(empresa_id, hash_anterior)` serializa la cadena: si dos
fichajes simultáneos de la misma empresa leen el mismo extremo, sólo uno puede
insertar y el otro reintenta con el hash ya actualizado. Sin ese índice, dos
fichajes podrían apuntar al mismo antecesor y la cadena se bifurcaría en
silencio.

**Dónde**: `src/lib/hash.js`, `insertarEnCadena()` en `src/lib/fichajes.js`.
Verificación bajo demanda en `GET /api/fichajes/verificar-cadena`.

## 3. Sello temporal de servidor en UTC

El `timestamp_utc` lo pone el servidor. La zona horaria de la empresa se guarda
aparte, en el propio fichaje, y sólo se usa para presentar y para decidir a qué
día local pertenece el registro. Nunca se confía en el reloj del dispositivo.

Si un fichaje llega diferido desde la cola offline, se guardan las dos marcas
—la declarada por el cliente y la de recepción en servidor— y el registro queda
marcado como `diferido`. Ésa es la razón de que pueda existir una cola sin
comprometer la integridad del registro: lo que dice el móvil se conserva como
declaración, no como hecho.

La fecha local de un diferido es la de la hora declarada: un fichaje de las
22:00 sincronizado a las 00:10 pertenece al día de las 22:00.

**Dónde**: `src/lib/tiempo.js`, `registrarFichaje()` en `src/lib/fichajes.js`,
`public/js/cola.js`.

## 4. Campos del borrador presentes desde el día uno

`tipo_evento`, `modalidad` (presencial o a distancia) y `naturaleza_hora`
existen en la tabla desde la primera migración. Se crean nullable y se dejan
vacíos: la interfaz todavía no los usa.

Añadirlos más tarde sobre una cadena de hashes de cuatro años es exactamente el
escenario que hay que evitar, porque entrarían en `CAMPOS_SUSTANTIVOS` y
obligarían a recalcular todo el histórico o a mantener dos algoritmos de hash en
paralelo.

## 5. Aislamiento por empresa

Todas las tablas de datos llevan `empresa_id` y ninguna consulta se ejecuta sin
filtrar por él. El filtro se aplica en una capa de acceso a datos común, no
repetido a mano en cada endpoint.

Las rutas no reciben la base de datos: reciben un alcance ya atado a una
empresa (`alcanceEmpresa(db, empresaId)`) y no tienen forma de salirse de él.

- Un `INSERT` fuerza el `empresa_id` del alcance, aunque el cuerpo de la
  petición traiga otro.
- Un `UPDATE` o `DELETE` sin condiciones se rechaza.
- Las consultas a medida deben incluir el marcador `:empresa`; si no aparece, se
  rechazan antes de llegar a la base de datos.
- Sólo se admiten las tablas declaradas en `TABLAS_CON_EMPRESA`.

**Dónde**: `src/lib/datos.js`. La resolución de qué empresa corresponde a cada
petición está en un único sitio, `cargarEmpresa()` en `src/index.js`: si mañana
aparece un rol nuevo, se añade ahí y no en veinte endpoints.

## 6. Exportación desacoplada

Toda salida de datos pasa por `src/exportacion/index.js`. Hoy hay dos
adaptadores, `csv@1.0` y `pdf@1.0`. Cuando se publique la orden ministerial, la
integración con la Inspección será un tercer adaptador registrado en la misma
tabla, no una reescritura.

Los adaptadores están versionados a propósito: si el formato cambia dentro de
dos años, el adaptador nuevo convive con el viejo y los informes ya emitidos se
pueden reproducir tal como salieron. Se piden como `pdf` (última versión) o como
`pdf@1.0` (esa versión exacta).

El PDF se genera a mano, sin librería. Para un informe tabular con las fuentes
base de PDF son doscientas líneas, y evita arrastrar una dependencia durante los
cuatro años de conservación obligatoria.

---

## Stack

- **Cloudflare Workers y D1** para backend y base de datos. El volumen previsto
  —decenas de empresas, tres o cuatro fichajes por trabajador y día— cabe
  holgadamente y el coste de infraestructura es marginal.
- **Cron Triggers** para el motor de incidencias.
- **PWA sin framework**: HTML, CSS y JavaScript propios. Manifest, service
  worker y cola offline en IndexedDB.
- **Autenticación**: enlace mágico al correo para gestoría y empresa; código de
  empresa más PIN de seis dígitos para el trabajador, porque muchos no tienen
  correo de trabajo. Sesión en cookie `httpOnly`, de larga duración en el
  dispositivo del trabajador.

### Por qué no se precalcula nada en los informes

Un año completo de una empresa de diez personas son unos pocos miles de filas.
Una tabla de agregados sería una fuente de verdad duplicada que puede
desincronizarse de los fichajes, que son la prueba. Consulta directa.

## El motor de incidencias

Dos familias con coste muy distinto y dos reglas que deciden si el módulo se usa
o se silencia. Ver `src/incidencias/motor.js`.

**Estructurales** (sólo miran los fichajes): salida sin entrada, jornada no
cerrada, pausa no cerrada, jornada excesiva, fichaje duplicado.

**De expectativa** (requieren horario teórico y calendario): falta de entrada
pasada la tolerancia, salida anticipada, exceso sobre jornada teórica diario y
mensual.

1. **Ventana de tolerancia configurable por empresa**, veinte minutos por
   defecto. Una alerta que salta porque alguien llega tres minutos tarde se
   ignora en una semana y arrastra consigo a todas las demás.
2. **Supresión**: no se genera ninguna incidencia de expectativa si ese día hay
   ausencia aprobada, es festivo del calendario de la empresa, o el trabajador
   está de baja o dado de baja.

La generación es idempotente por `(empleado, fecha, tipo)`, garantizada por un
índice único. El cron puede correr mil veces sin duplicar nada, sin reenviar
avisos y sin reabrir lo que alguien marcó como ignorado.

El exceso mensual se ancla al día 1 del mes para que el índice único lo levante
una sola vez por mes en lugar de repetirlo cada día desde que se cruza el
umbral.

### Reparto de los crons

| Expresión | Qué hace |
|-----------|----------|
| `*/15 * * * *` | Expectativa del día en curso |
| `50 21 * * *` y `50 22 * * *` | Cierre diario a las 23:50 locales |

Cloudflare dispara los crons en UTC. Las dos ejecuciones nocturnas cubren
horario de verano e invierno; cada empresa atiende sólo la que cae a las 23:50
en su propia zona, comprobado en `dentroDeVentana()`.

## Cómo se etiqueta la diferencia de horas

Nunca «horas extra». En el momento en que el sistema emite un número etiquetado
como horas extraordinarias está emitiendo una cifra que puede acabar en una
papeleta de conciliación, y si son extraordinarias, complementarias o
compensación por flexibilidad depende del convenio y del contrato, que el
sistema no conoce.

La etiqueta es **exceso sobre jornada teórica**. La calificación la hace la
gestoría. Hay una prueba que falla si esa etiqueta se cambia o si aparece la
expresión «horas extra» en cualquier exportación.
