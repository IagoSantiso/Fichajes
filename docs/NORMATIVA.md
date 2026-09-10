# Situación normativa

Estado a **10 de septiembre de 2026**. Este documento se revisa cada vez que se
mueve algo en el BOE, y de él depende lo que se puede afirmar comercialmente.

## Lo que está vigente

**Real Decreto-ley 8/2019, artículo 34.9 del Estatuto de los Trabajadores**, en
vigor desde mayo de 2019. Toda empresa debe:

- Registrar diariamente la jornada de cada trabajador, con hora concreta de
  inicio y de finalización.
- Conservar los registros **cuatro años**.
- Ponerlos a disposición del trabajador, de la representación legal y de la
  Inspección de Trabajo.

El formato puede ser papel, hoja de cálculo o software. **Hoy no es obligatorio
que sea digital.**

## Lo que está pendiente

El Real Decreto que obligaría a formato exclusivamente digital **no está
publicado en el BOE**:

- Dictamen desfavorable del Consejo de Estado el 23 de marzo de 2026.
- Aplazamiento en julio de 2026.
- El Consejo de Ministros del 1 de septiembre de 2026 no lo aprobó.

Las especificaciones técnicas concretas —entre ellas el acceso remoto de la
Inspección— irán en una **orden ministerial posterior que sigue en fase previa**.

**No existe hoy ninguna certificación oficial de sistemas de fichaje.**

## Consecuencia para el diseño

No se puede implementar la integración con la Inspección porque no hay
especificación que implementar. Sí se puede, y se debe, construir la base de
datos y la capa de integridad de forma que esa integración sea después un módulo
añadido y no una migración de todo el histórico.

Lo que queda hecho a la espera de la orden ministerial:

| Preparado | Dónde |
|-----------|-------|
| Cadena de hashes e inmutabilidad, previsiblemente el núcleo de lo que exija la orden sobre integridad y no manipulación | `src/lib/hash.js`, disparadores del esquema |
| Campos del borrador ya modelados: hora y minuto exactos de inicio y fin de jornada, inicio y fin de cada pausa no computable, modalidad presencial o a distancia, naturaleza de la hora, totalización diaria y mensual | Tabla `fichajes`, informes |
| Log de accesos, para poder acreditar consultas | Tabla `log_accesos` |
| Módulo de exportación con adaptadores versionados, de modo que un envío periódico a un endpoint externo o una consulta remota sean un adaptador nuevo | `src/exportacion/` |
| Cuenta de sólo lectura con alcance limitado a una empresa y con caducidad, para que un inspector pueda acceder en remoto sin ver el resto de la plataforma | Tabla `accesos_inspeccion`, `src/rutas/inspeccion.js` |

## Cómo se cuenta esto comercialmente

La adaptación normativa va **incluida en la cuota de mantenimiento**.

**Nunca se afirma que el sistema ya cumple el nuevo decreto**, porque las
especificaciones técnicas no existen y cualquiera que lo afirme hoy no está
siendo preciso.

Formulación segura, que además es un argumento de venta y no una excusa:

> El sistema cumple lo que está vigente hoy: registro diario, conservación de
> cuatro años y puesta a disposición. Para lo que venga, la base de datos ya
> guarda los campos del borrador y los registros van encadenados por hash, así
> que la adaptación será un módulo añadido y no una migración. Va incluida en el
> mantenimiento.

Lo que **no** se dice:

- «Ya cumplimos el nuevo Real Decreto.» No está publicado.
- «Estamos certificados.» No existe ninguna certificación oficial.
- «Conectamos con la Inspección.» No hay especificación con la que conectar.

## Qué mirar cuando se publique

Cuando salga el Real Decreto y, sobre todo, la orden ministerial:

1. **Formato del registro**: si impone estructura de campos concreta, se traduce
   en un adaptador de exportación nuevo, no en un cambio de esquema.
2. **Acceso remoto de la Inspección**: si es consulta bajo demanda, se apoya en
   `accesos_inspeccion` y en las rutas de sólo lectura ya existentes. Si es
   envío periódico, es un adaptador más disparado por un cron.
3. **Requisitos de integridad**: comprobar si el encadenamiento SHA-256 basta o
   si exigen firma electrónica o sellado de tiempo de un tercero. En ese caso, la
   cadena que ya existe es el punto sobre el que se firma, no algo que sustituir.
4. **Campos obligatorios**: comprobar si los ya modelados
   (`tipo_evento`, `modalidad`, `naturaleza_hora`) coinciden con los definitivos,
   y empezar a rellenarlos desde la interfaz.
