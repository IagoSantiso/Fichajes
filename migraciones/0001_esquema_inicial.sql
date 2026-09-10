-- Esquema inicial de la plataforma de registro de jornada.
--
-- Decisiones no negociables que este esquema materializa (ver docs/ARQUITECTURA.md):
--   1. La tabla `fichajes` es append-only. Hay disparadores que abortan
--      cualquier UPDATE o DELETE, incluso si alguien los escribiera por error.
--   2. Cada fichaje encadena el hash del anterior *de su empresa*.
--   3. El sello temporal es de servidor, en UTC, con la zona horaria aparte.
--   4. Los campos del borrador del RD (modalidad, naturaleza_hora, tipo_evento)
--      existen desde el día uno, nullable y sin usar todavía.
--   5. Toda tabla de datos lleva empresa_id.
--   6. La exportación no vive aquí: pasa por src/exportacion/.

-- ---------------------------------------------------------------------------
-- Gestorías y empresas
-- ---------------------------------------------------------------------------

CREATE TABLE gestorias (
  id          TEXT PRIMARY KEY,
  nombre      TEXT NOT NULL,
  contacto    TEXT,
  activa      INTEGER NOT NULL DEFAULT 1,
  creada_en   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE empresas (
  id                          TEXT PRIMARY KEY,
  gestoria_id                 TEXT NOT NULL REFERENCES gestorias(id),
  nombre                      TEXT NOT NULL,
  -- Código corto que el trabajador teclea en la PWA junto con su PIN.
  codigo                      TEXT NOT NULL UNIQUE,
  cif                         TEXT,
  direccion                   TEXT,
  zona_horaria                TEXT NOT NULL DEFAULT 'Europe/Madrid',
  tolerancia_minutos          INTEGER NOT NULL DEFAULT 20,
  jornada_maxima_alerta_horas REAL NOT NULL DEFAULT 12,
  -- Geolocalización: opcional, desactivada por defecto, con justificación (RGPD).
  geolocalizacion_activa      INTEGER NOT NULL DEFAULT 0,
  geolocalizacion_motivo      TEXT,
  -- Avisos de incidencias: 'resumen_diario' (por defecto) o 'inmediato'.
  avisos_modo                 TEXT NOT NULL DEFAULT 'resumen_diario',
  avisos_email                TEXT,
  activa                      INTEGER NOT NULL DEFAULT 1,
  fecha_alta                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now')),
  CHECK (avisos_modo IN ('resumen_diario','inmediato'))
);
CREATE INDEX idx_empresas_gestoria ON empresas(gestoria_id);

-- ---------------------------------------------------------------------------
-- Empleados
-- ---------------------------------------------------------------------------

CREATE TABLE empleados (
  id                    TEXT PRIMARY KEY,
  empresa_id            TEXT NOT NULL REFERENCES empresas(id),
  nombre                TEXT NOT NULL,
  apellidos             TEXT NOT NULL DEFAULT '',
  documento_identidad   TEXT,
  email                 TEXT,
  pin_hash              TEXT,
  tipo_jornada          TEXT NOT NULL DEFAULT 'completa',
  rol                   TEXT NOT NULL DEFAULT 'empleado',
  dias_vacaciones_anuales INTEGER NOT NULL DEFAULT 22,
  fecha_alta            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now')),
  fecha_baja            TEXT,
  activo                INTEGER NOT NULL DEFAULT 1,
  CHECK (tipo_jornada IN ('completa','parcial')),
  CHECK (rol IN ('empleado','responsable'))
);
CREATE INDEX idx_empleados_empresa ON empleados(empresa_id, activo);

-- ---------------------------------------------------------------------------
-- Horario teórico, versionado por fechas de vigencia
-- ---------------------------------------------------------------------------

CREATE TABLE horarios_teoricos (
  id             TEXT PRIMARY KEY,
  empresa_id     TEXT NOT NULL REFERENCES empresas(id),
  empleado_id    TEXT NOT NULL REFERENCES empleados(id),
  dia_semana     INTEGER NOT NULL,          -- 1 = lunes ... 7 = domingo (ISO-8601)
  hora_entrada   TEXT NOT NULL,             -- 'HH:MM' hora local de la empresa
  hora_salida    TEXT NOT NULL,
  vigente_desde  TEXT NOT NULL,             -- 'YYYY-MM-DD'
  vigente_hasta  TEXT,                      -- NULL = vigente indefinidamente
  CHECK (dia_semana BETWEEN 1 AND 7)
);
CREATE INDEX idx_horarios_empleado ON horarios_teoricos(empleado_id, dia_semana, vigente_desde);

-- ---------------------------------------------------------------------------
-- Calendario laboral (lo rellena la gestoría, empresa a empresa y año a año)
-- ---------------------------------------------------------------------------

CREATE TABLE calendario_laboral (
  id          TEXT PRIMARY KEY,
  empresa_id  TEXT NOT NULL REFERENCES empresas(id),
  fecha       TEXT NOT NULL,                -- 'YYYY-MM-DD'
  tipo        TEXT NOT NULL,
  descripcion TEXT,
  CHECK (tipo IN ('festivo_nacional','festivo_autonomico','festivo_local','cierre_empresa')),
  UNIQUE (empresa_id, fecha)
);
CREATE INDEX idx_calendario_empresa_fecha ON calendario_laboral(empresa_id, fecha);

-- ---------------------------------------------------------------------------
-- Fichajes: append-only y encadenados por hash
-- ---------------------------------------------------------------------------

CREATE TABLE fichajes (
  id                      TEXT PRIMARY KEY,
  empresa_id              TEXT NOT NULL REFERENCES empresas(id),
  empleado_id             TEXT NOT NULL REFERENCES empleados(id),
  tipo                    TEXT NOT NULL,
  timestamp_utc           TEXT NOT NULL,    -- sello de servidor, ISO-8601 con Z
  zona_horaria            TEXT NOT NULL,
  fecha_local             TEXT NOT NULL,    -- 'YYYY-MM-DD' en la zona de la empresa
  timestamp_declarado     TEXT,             -- sólo en diferidos: lo que dijo el cliente
  diferido                INTEGER NOT NULL DEFAULT 0,
  origen                  TEXT NOT NULL,    -- 'pwa' | 'panel'
  ip                      TEXT,
  user_agent              TEXT,
  latitud                 REAL,
  longitud                REAL,
  -- Campos del borrador del RD: nullable y sin uso en la interfaz todavía.
  tipo_evento             TEXT,
  modalidad               TEXT,             -- 'presencial' | 'distancia'
  naturaleza_hora         TEXT,             -- 'ordinaria' | 'complementaria' | ...
  -- Trazabilidad de correcciones
  autor_id                TEXT NOT NULL,
  autor_tipo              TEXT NOT NULL,    -- 'empleado' | 'empresa' | 'gestoria'
  tipo_registro           TEXT NOT NULL DEFAULT 'original',
  fichaje_referenciado_id TEXT REFERENCES fichajes(id),
  motivo                  TEXT,
  -- Cadena de integridad, por empresa
  hash_anterior           TEXT NOT NULL,    -- 'GENESIS' en el primero de cada empresa
  hash                    TEXT NOT NULL,
  CHECK (tipo IN ('entrada','salida','inicio_pausa','fin_pausa')),
  CHECK (origen IN ('pwa','panel')),
  CHECK (tipo_registro IN ('original','rectificacion','anulacion')),
  CHECK (modalidad IS NULL OR modalidad IN ('presencial','distancia')),
  -- Serializa la cadena: dos fichajes de la misma empresa no pueden apuntar al
  -- mismo antecesor. Una inserción concurrente falla y se reintenta.
  UNIQUE (empresa_id, hash_anterior),
  UNIQUE (empresa_id, hash)
);
CREATE INDEX idx_fichajes_empleado_fecha ON fichajes(empleado_id, fecha_local);
CREATE INDEX idx_fichajes_empresa_fecha ON fichajes(empresa_id, fecha_local);
CREATE INDEX idx_fichajes_referenciado ON fichajes(fichaje_referenciado_id);

-- Inmutabilidad a nivel de motor, no sólo de disciplina en el código.
CREATE TRIGGER fichajes_sin_update
BEFORE UPDATE ON fichajes
BEGIN
  SELECT RAISE(ABORT, 'Los fichajes son inmutables: inserte una rectificacion');
END;

CREATE TRIGGER fichajes_sin_delete
BEFORE DELETE ON fichajes
BEGIN
  SELECT RAISE(ABORT, 'Los fichajes son inmutables: inserte una anulacion');
END;

-- ---------------------------------------------------------------------------
-- Ausencias (tabla genérica; nunca el motivo médico de una baja)
-- ---------------------------------------------------------------------------

CREATE TABLE ausencias (
  id            TEXT PRIMARY KEY,
  empresa_id    TEXT NOT NULL REFERENCES empresas(id),
  empleado_id   TEXT NOT NULL REFERENCES empleados(id),
  tipo          TEXT NOT NULL,
  fecha_inicio  TEXT NOT NULL,
  fecha_fin     TEXT NOT NULL,
  medio_dia     INTEGER NOT NULL DEFAULT 0,
  estado        TEXT NOT NULL DEFAULT 'solicitada',
  solicitada_por TEXT,
  solicitada_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  resuelta_por  TEXT,
  resuelta_en   TEXT,
  comentario    TEXT,
  CHECK (tipo IN ('vacaciones','baja','permiso_retribuido','asuntos_propios','otro')),
  CHECK (estado IN ('solicitada','aprobada','denegada','cancelada')),
  CHECK (fecha_fin >= fecha_inicio)
);
CREATE INDEX idx_ausencias_empleado ON ausencias(empleado_id, fecha_inicio, fecha_fin);
CREATE INDEX idx_ausencias_empresa_estado ON ausencias(empresa_id, estado);

-- ---------------------------------------------------------------------------
-- Solicitudes de corrección de fichaje (el trabajador solicita, no corrige)
-- ---------------------------------------------------------------------------

CREATE TABLE solicitudes_correccion (
  id                 TEXT PRIMARY KEY,
  empresa_id         TEXT NOT NULL REFERENCES empresas(id),
  empleado_id        TEXT NOT NULL REFERENCES empleados(id),
  fichaje_id         TEXT REFERENCES fichajes(id),  -- NULL si falta el fichaje
  fecha_local        TEXT NOT NULL,
  tipo_propuesto     TEXT,
  hora_propuesta     TEXT,                          -- 'HH:MM' local
  motivo             TEXT NOT NULL,
  estado             TEXT NOT NULL DEFAULT 'solicitada',
  solicitada_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  resuelta_por       TEXT,
  resuelta_en        TEXT,
  comentario_resolucion TEXT,
  fichaje_resultante_id TEXT REFERENCES fichajes(id),
  CHECK (estado IN ('solicitada','aprobada','denegada'))
);
CREATE INDEX idx_correcciones_empresa_estado ON solicitudes_correccion(empresa_id, estado);
CREATE INDEX idx_correcciones_empleado ON solicitudes_correccion(empleado_id, fecha_local);

-- ---------------------------------------------------------------------------
-- Incidencias (persistidas, no calculadas al vuelo; generación idempotente)
-- ---------------------------------------------------------------------------

CREATE TABLE incidencias (
  id            TEXT PRIMARY KEY,
  empresa_id    TEXT NOT NULL REFERENCES empresas(id),
  empleado_id   TEXT NOT NULL REFERENCES empleados(id),
  fecha         TEXT NOT NULL,             -- fecha local a la que se refiere
  tipo          TEXT NOT NULL,
  detalle       TEXT,
  estado        TEXT NOT NULL DEFAULT 'abierta',
  detectada_en  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  avisada_en    TEXT,
  resuelta_por  TEXT,
  resuelta_en   TEXT,
  CHECK (estado IN ('abierta','resuelta','ignorada')),
  -- Idempotencia por (empleado, fecha, tipo): el cron puede correr mil veces.
  UNIQUE (empleado_id, fecha, tipo)
);
CREATE INDEX idx_incidencias_empresa_estado ON incidencias(empresa_id, estado, fecha);

-- ---------------------------------------------------------------------------
-- Log de accesos
-- ---------------------------------------------------------------------------

CREATE TABLE log_accesos (
  id                   TEXT PRIMARY KEY,
  empresa_id           TEXT,               -- NULL en acciones de ámbito gestoría
  actor_tipo           TEXT NOT NULL,      -- 'empleado'|'empresa'|'gestoria'|'inspeccion'|'sistema'
  actor_id             TEXT,
  accion               TEXT NOT NULL,      -- 'consulta'|'exportacion'|'correccion'|'aprobacion'|...
  recurso              TEXT,
  empleado_afectado_id TEXT,
  timestamp_utc        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  ip                   TEXT
);
CREATE INDEX idx_log_empresa_fecha ON log_accesos(empresa_id, timestamp_utc);

-- ---------------------------------------------------------------------------
-- Infraestructura de autenticación (no forma parte del modelo de datos de
-- negocio, por eso no lleva empresa_id en todos los casos)
-- ---------------------------------------------------------------------------

CREATE TABLE usuarios (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  nombre       TEXT,
  rol          TEXT NOT NULL,              -- 'gestoria' | 'empresa'
  gestoria_id  TEXT REFERENCES gestorias(id),
  empresa_id   TEXT REFERENCES empresas(id),
  activo       INTEGER NOT NULL DEFAULT 1,
  creado_en    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (rol IN ('gestoria','empresa'))
);

CREATE TABLE enlaces_magicos (
  token_hash  TEXT PRIMARY KEY,
  usuario_id  TEXT NOT NULL REFERENCES usuarios(id),
  expira_en   TEXT NOT NULL,
  usado_en    TEXT,
  creado_en   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE sesiones (
  id          TEXT PRIMARY KEY,            -- hash del identificador de sesión
  actor_tipo  TEXT NOT NULL,               -- 'empleado'|'empresa'|'gestoria'|'inspeccion'
  actor_id    TEXT NOT NULL,
  empresa_id  TEXT,                        -- ámbito, si lo tiene
  gestoria_id TEXT,
  expira_en   TEXT NOT NULL,
  creada_en   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revocada_en TEXT
);
CREATE INDEX idx_sesiones_actor ON sesiones(actor_tipo, actor_id);

-- Cuenta de sólo lectura, con alcance a una empresa y con caducidad, para que
-- un inspector pueda acceder en remoto sin ver el resto de la plataforma.
-- No implementa la orden ministerial (que no existe): deja el hueco hecho.
CREATE TABLE accesos_inspeccion (
  id           TEXT PRIMARY KEY,
  empresa_id   TEXT NOT NULL REFERENCES empresas(id),
  token_hash   TEXT NOT NULL UNIQUE,
  referencia   TEXT,                       -- expediente / actuación inspectora
  creado_por   TEXT,
  creado_en    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expira_en    TEXT NOT NULL,
  revocado_en  TEXT
);
CREATE INDEX idx_inspeccion_empresa ON accesos_inspeccion(empresa_id);
