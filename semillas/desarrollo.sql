-- Datos de ejemplo para desarrollo. NO ejecutar en producción.
--
-- Vive fuera de migraciones/ a propósito: wrangler aplica todos los .sql de
-- ese directorio, y la semilla no es una migración.
--
-- Reproduce el cliente de referencia del brief: un soldador con tres
-- empleados, dado de alta por una gestoría.
--
--   Gestoría:     gestor@ejemplo.es       / fichajes2026
--   Empresa:      jefe@soldaduras.ejemplo / fichajes2026
--   Trabajadores: identificador 001001 (Ana), 001002 (Luis), 001003 (Marta)
--                 PIN 482915 para los tres
--
-- El PIN 482915 corresponde al hash de más abajo, generado con PBKDF2-SHA256
-- y 100.000 iteraciones. Sirve sólo para desarrollo.

INSERT INTO gestorias (id, nombre, contacto, activa)
VALUES ('ges_dev', 'Gestoría Ejemplo S.L.', 'gestor@ejemplo.es', 1);

INSERT INTO empresas (
  id, gestoria_id, numero, nombre, codigo, cif, direccion, zona_horaria,
  tolerancia_minutos, jornada_maxima_alerta_horas,
  geolocalizacion_activa, avisos_modo, avisos_email, activa, fecha_alta
) VALUES (
  'emc_dev', 'ges_dev', 1, 'Soldaduras Pérez S.L.', 'SOLDPER', 'B12345678',
  'Polígono Industrial Las Fraguas, nave 12', 'Europe/Madrid',
  20, 12, 0, 'resumen_diario', 'jefe@soldaduras.ejemplo', 1, '2026-01-02'
);

-- Las dos contraseñas son 'fichajes2026'. Nacen ya cambiadas
-- (debe_cambiar_password = 0) para que la demostración no obligue a pasar por
-- la pantalla de cambio antes de ver nada.
INSERT INTO usuarios (id, email, nombre, rol, gestoria_id, empresa_id, activo,
                      password_hash, debe_cambiar_password)
VALUES
  ('usu_gestor', 'gestor@ejemplo.es', 'Gestoría Ejemplo', 'gestoria', 'ges_dev', NULL, 1,
   'pbkdf2$100000$4aada116425efe7857378328bd84dcce$8373a00f316b4c2ff842b5c04fa1fbd69432f95b01f2596603bbf2d334e5d5f6', 0),
  ('usu_jefe', 'jefe@soldaduras.ejemplo', 'Soldaduras Pérez', 'empresa', NULL, 'emc_dev', 1,
   'pbkdf2$100000$4aada116425efe7857378328bd84dcce$8373a00f316b4c2ff842b5c04fa1fbd69432f95b01f2596603bbf2d334e5d5f6', 0);

INSERT INTO empleados (
  id, empresa_id, numero, nombre, apellidos, documento_identidad, email, pin_hash,
  tipo_jornada, rol, dias_vacaciones_anuales, fecha_alta, fecha_baja, activo
) VALUES
  ('emp_ana', 'emc_dev', 1, 'Ana', 'Ruiz Gómez', '12345678Z', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'responsable', 22, '2026-01-02', NULL, 1),
  ('emp_luis', 'emc_dev', 2, 'Luis', 'Soto Marín', '87654321X', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'empleado', 22, '2026-01-02', NULL, 1),
  ('emp_marta', 'emc_dev', 3, 'Marta', 'Ibáñez Cruz', '11223344W', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'parcial', 'empleado', 22, '2026-03-01', NULL, 1);

-- Horario teórico: de lunes a viernes, de 08:00 a 17:00 con pausa por medio.
INSERT INTO horarios_teoricos (id, empresa_id, empleado_id, dia_semana, hora_entrada, hora_salida, vigente_desde, vigente_hasta)
VALUES
  ('hor_ana_1','emc_dev','emp_ana',1,'08:00','17:00','2026-01-02',NULL),
  ('hor_ana_2','emc_dev','emp_ana',2,'08:00','17:00','2026-01-02',NULL),
  ('hor_ana_3','emc_dev','emp_ana',3,'08:00','17:00','2026-01-02',NULL),
  ('hor_ana_4','emc_dev','emp_ana',4,'08:00','17:00','2026-01-02',NULL),
  ('hor_ana_5','emc_dev','emp_ana',5,'08:00','15:00','2026-01-02',NULL),
  ('hor_luis_1','emc_dev','emp_luis',1,'08:00','17:00','2026-01-02',NULL),
  ('hor_luis_2','emc_dev','emp_luis',2,'08:00','17:00','2026-01-02',NULL),
  ('hor_luis_3','emc_dev','emp_luis',3,'08:00','17:00','2026-01-02',NULL),
  ('hor_luis_4','emc_dev','emp_luis',4,'08:00','17:00','2026-01-02',NULL),
  ('hor_luis_5','emc_dev','emp_luis',5,'08:00','15:00','2026-01-02',NULL),
  ('hor_marta_1','emc_dev','emp_marta',1,'09:00','13:00','2026-03-01',NULL),
  ('hor_marta_3','emc_dev','emp_marta',3,'09:00','13:00','2026-03-01',NULL),
  ('hor_marta_5','emc_dev','emp_marta',5,'09:00','13:00','2026-03-01',NULL);

-- Calendario laboral de 2026, a modo de ejemplo. Los festivos reales los pone
-- la gestoría empresa por empresa.
INSERT INTO calendario_laboral (id, empresa_id, fecha, tipo, descripcion)
VALUES
  ('cal_1','emc_dev','2026-01-01','festivo_nacional','Año Nuevo'),
  ('cal_2','emc_dev','2026-01-06','festivo_nacional','Epifanía del Señor'),
  ('cal_3','emc_dev','2026-04-03','festivo_nacional','Viernes Santo'),
  ('cal_4','emc_dev','2026-05-01','festivo_nacional','Fiesta del Trabajo'),
  ('cal_5','emc_dev','2026-08-15','festivo_nacional','Asunción de la Virgen'),
  ('cal_6','emc_dev','2026-10-12','festivo_nacional','Fiesta Nacional de España'),
  ('cal_7','emc_dev','2026-11-02','festivo_nacional','Todos los Santos (trasladado)'),
  ('cal_8','emc_dev','2026-12-08','festivo_nacional','Inmaculada Concepción'),
  ('cal_9','emc_dev','2026-12-25','festivo_nacional','Natividad del Señor'),
  ('cal_10','emc_dev','2026-08-03','cierre_empresa','Cierre por vacaciones'),
  ('cal_11','emc_dev','2026-08-04','cierre_empresa','Cierre por vacaciones'),
  ('cal_12','emc_dev','2026-08-05','cierre_empresa','Cierre por vacaciones');
