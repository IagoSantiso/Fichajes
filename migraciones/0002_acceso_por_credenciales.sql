-- Acceso por credenciales propias, sin correo de por medio.
--
-- Sustituye el enlace mágico por credenciales que cada uno guarda:
--
--   · Trabajador: un identificador numérico de seis cifras que compone el
--     número de su empresa (tres) con el suyo dentro de ella (tres) —empresa 2,
--     empleado 3 son 002003— más su PIN. Se teclea entero en el teclado
--     numérico de la propia aplicación, que es lo que se puede usar con
--     guantes puestos.
--   · Empresa y gestoría: su correo y una contraseña.
--
-- El motivo del cambio es operativo: el enlace mágico obliga a mantener un
-- proveedor de correo con dominio verificado y entregabilidad, y a que el
-- correo llegue, para un producto que se vende a empresas de tres personas.
-- Sin correo en el acceso, las claves olvidadas se resuelven por jerarquía:
-- la empresa resetea el PIN de sus trabajadores, la gestoría la contraseña de
-- sus empresas, y la de la gestoría se repone a mano.
--
-- Contrapartida asumida: un identificador secuencial es enumerable. Por eso
-- esta misma migración trae la tabla de intentos, que deja de ser opcional.

-- ---------------------------------------------------------------------------
-- Números legibles
-- ---------------------------------------------------------------------------

ALTER TABLE empresas ADD COLUMN numero INTEGER;
ALTER TABLE empleados ADD COLUMN numero INTEGER;

-- Relleno de lo que ya existe, en el orden en que se dio de alta.
UPDATE empresas
   SET numero = (SELECT COUNT(*) FROM empresas otras WHERE otras.rowid <= empresas.rowid);

UPDATE empleados
   SET numero = (SELECT COUNT(*) FROM empleados otros
                  WHERE otros.empresa_id = empleados.empresa_id
                    AND otros.rowid <= empleados.rowid);

-- El número de empresa es único en toda la plataforma; el de empleado, dentro
-- de su empresa. Juntos forman el identificador de acceso, así que la unicidad
-- de la pareja es lo que impide que dos personas compartan credencial.
CREATE UNIQUE INDEX idx_empresas_numero ON empresas(numero);
CREATE UNIQUE INDEX idx_empleados_numero ON empleados(empresa_id, numero);

-- ---------------------------------------------------------------------------
-- Cambio obligatorio de clave en el primer acceso
-- ---------------------------------------------------------------------------

-- El PIN lo reparte la empresa, así que hasta que el trabajador lo cambia lo
-- conoce alguien más. Lo mismo con la contraseña que fija la gestoría.
ALTER TABLE empleados ADD COLUMN pin_debe_cambiarse INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN password_hash TEXT;
ALTER TABLE usuarios ADD COLUMN debe_cambiar_password INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Límite de intentos
-- ---------------------------------------------------------------------------

-- Dos cerrojos, porque frenan ataques distintos:
--
--   · Por identificador: cinco fallos y diez minutos de espera. Impide probar
--     el millón de PIN posibles contra una persona concreta.
--   · Por IP, más holgado: impide lo contrario, probar un mismo PIN contra
--     muchos identificadores, que el cerrojo anterior no ve. El umbral es alto
--     a propósito para que varios trabajadores tras la misma conexión de la
--     nave no se bloqueen entre ellos.
CREATE TABLE intentos_acceso (
  clave           TEXT PRIMARY KEY,   -- 'id:002003' o 'ip:203.0.113.4'
  fallidos        INTEGER NOT NULL DEFAULT 0,
  primer_fallo    TEXT NOT NULL,
  ultimo_fallo    TEXT NOT NULL,
  bloqueado_hasta TEXT
);
CREATE INDEX idx_intentos_bloqueo ON intentos_acceso(bloqueado_hasta);
