-- Empresas adicionales para la demo, todas bajo la misma gestoría de
-- desarrollo.sql (ges_dev). Sirve para enseñar el panel transversal de
-- gestoría con varias empresas reales, no sólo una.
--
-- Se aplica DESPUÉS de desarrollo.sql:
--   npx wrangler d1 execute fichajes --local --file=./semillas/desarrollo.sql
--   npx wrangler d1 execute fichajes --local --file=./semillas/multiempresa.sql
--
-- Todas las contraseñas de panel son 'fichajes2026' y todos los PIN de
-- fichaje son '482915', igual que en desarrollo.sql: es el mismo hash, ya
-- publicado en el README, para que la demo sea fácil de enseñar.

-- ---------------------------------------------------------------------
-- Empresa 2: peluquería (comercio con horario partido, casi todo mujeres)
-- ---------------------------------------------------------------------
INSERT INTO empresas (
  id, gestoria_id, numero, nombre, codigo, cif, direccion, zona_horaria,
  tolerancia_minutos, jornada_maxima_alerta_horas,
  geolocalizacion_activa, avisos_modo, avisos_email, activa, fecha_alta
) VALUES (
  'emc_peluqueria', 'ges_dev', 2, 'Peluquería Ana Estilistas S.L.', 'PELUANA', 'B23456789',
  'Calle Mayor 14, local', 'Europe/Madrid',
  15, 10, 0, 'resumen_diario', 'ana@peluqueria.ejemplo', 1, '2026-02-01'
);

INSERT INTO usuarios (id, email, nombre, rol, gestoria_id, empresa_id, activo,
                      password_hash, debe_cambiar_password)
VALUES
  ('usu_peluqueria', 'ana@peluqueria.ejemplo', 'Peluquería Ana', 'empresa', NULL, 'emc_peluqueria', 1,
   'pbkdf2$100000$4aada116425efe7857378328bd84dcce$8373a00f316b4c2ff842b5c04fa1fbd69432f95b01f2596603bbf2d334e5d5f6', 0);

INSERT INTO empleados (
  id, empresa_id, numero, nombre, apellidos, documento_identidad, email, pin_hash,
  tipo_jornada, rol, dias_vacaciones_anuales, fecha_alta, fecha_baja, activo
) VALUES
  ('emp_ana_p', 'emc_peluqueria', 1, 'Ana', 'Gómez Ferreiro', '20112233A', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'responsable', 23, '2026-02-01', NULL, 1),
  ('emp_clara_p', 'emc_peluqueria', 2, 'Clara', 'Núñez Vidal', '20223344B', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'empleado', 22, '2026-02-01', NULL, 1),
  ('emp_sonia_p', 'emc_peluqueria', 3, 'Sonia', 'Reyes Campo', '20334455C', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'parcial', 'empleado', 22, '2026-04-01', NULL, 1);

-- Horario de martes a sábado, partido con pausa larga al mediodía. Lunes
-- cerrado, como casi todas las peluquerías.
INSERT INTO horarios_teoricos (id, empresa_id, empleado_id, dia_semana, hora_entrada, hora_salida, vigente_desde, vigente_hasta)
VALUES
  ('hor_ana_p_2','emc_peluqueria','emp_ana_p',2,'10:00','14:00','2026-02-01',NULL),
  ('hor_ana_p_2b','emc_peluqueria','emp_ana_p',2,'16:00','20:00','2026-02-01',NULL),
  ('hor_ana_p_3','emc_peluqueria','emp_ana_p',3,'10:00','14:00','2026-02-01',NULL),
  ('hor_ana_p_3b','emc_peluqueria','emp_ana_p',3,'16:00','20:00','2026-02-01',NULL),
  ('hor_ana_p_4','emc_peluqueria','emp_ana_p',4,'10:00','14:00','2026-02-01',NULL),
  ('hor_ana_p_4b','emc_peluqueria','emp_ana_p',4,'16:00','20:00','2026-02-01',NULL),
  ('hor_ana_p_5','emc_peluqueria','emp_ana_p',5,'10:00','14:00','2026-02-01',NULL),
  ('hor_ana_p_5b','emc_peluqueria','emp_ana_p',5,'16:00','20:00','2026-02-01',NULL),
  ('hor_ana_p_6','emc_peluqueria','emp_ana_p',6,'10:00','14:00','2026-02-01',NULL),
  ('hor_clara_p_2','emc_peluqueria','emp_clara_p',2,'10:00','14:00','2026-02-01',NULL),
  ('hor_clara_p_2b','emc_peluqueria','emp_clara_p',2,'16:00','20:00','2026-02-01',NULL),
  ('hor_clara_p_3','emc_peluqueria','emp_clara_p',3,'10:00','14:00','2026-02-01',NULL),
  ('hor_clara_p_3b','emc_peluqueria','emp_clara_p',3,'16:00','20:00','2026-02-01',NULL),
  ('hor_clara_p_4','emc_peluqueria','emp_clara_p',4,'10:00','14:00','2026-02-01',NULL),
  ('hor_clara_p_4b','emc_peluqueria','emp_clara_p',4,'16:00','20:00','2026-02-01',NULL),
  ('hor_clara_p_5','emc_peluqueria','emp_clara_p',5,'10:00','14:00','2026-02-01',NULL),
  ('hor_clara_p_5b','emc_peluqueria','emp_clara_p',5,'16:00','20:00','2026-02-01',NULL),
  ('hor_clara_p_6','emc_peluqueria','emp_clara_p',6,'10:00','14:00','2026-02-01',NULL),
  ('hor_sonia_p_3','emc_peluqueria','emp_sonia_p',3,'16:00','20:00','2026-04-01',NULL),
  ('hor_sonia_p_5','emc_peluqueria','emp_sonia_p',5,'16:00','20:00','2026-04-01',NULL),
  ('hor_sonia_p_6','emc_peluqueria','emp_sonia_p',6,'10:00','14:00','2026-04-01',NULL);

INSERT INTO calendario_laboral (id, empresa_id, fecha, tipo, descripcion)
VALUES
  ('cal_p_1','emc_peluqueria','2026-01-01','festivo_nacional','Año Nuevo'),
  ('cal_p_2','emc_peluqueria','2026-01-06','festivo_nacional','Epifanía del Señor'),
  ('cal_p_3','emc_peluqueria','2026-04-03','festivo_nacional','Viernes Santo'),
  ('cal_p_4','emc_peluqueria','2026-05-01','festivo_nacional','Fiesta del Trabajo'),
  ('cal_p_5','emc_peluqueria','2026-08-15','festivo_nacional','Asunción de la Virgen'),
  ('cal_p_6','emc_peluqueria','2026-10-12','festivo_nacional','Fiesta Nacional de España'),
  ('cal_p_7','emc_peluqueria','2026-11-02','festivo_nacional','Todos los Santos (trasladado)'),
  ('cal_p_8','emc_peluqueria','2026-12-08','festivo_nacional','Inmaculada Concepción'),
  ('cal_p_9','emc_peluqueria','2026-12-25','festivo_nacional','Natividad del Señor');

-- ---------------------------------------------------------------------
-- Empresa 3: hostelería (turnos partidos, fin de semana incluido)
-- ---------------------------------------------------------------------
INSERT INTO empresas (
  id, gestoria_id, numero, nombre, codigo, cif, direccion, zona_horaria,
  tolerancia_minutos, jornada_maxima_alerta_horas,
  geolocalizacion_activa, avisos_modo, avisos_email, activa, fecha_alta
) VALUES (
  'emc_taberna', 'ges_dev', 3, 'Taberna El Rincón S.L.', 'TABERINC', 'B34567890',
  'Plaza del Ayuntamiento 3', 'Europe/Madrid',
  15, 12, 0, 'inmediato', 'gerencia@tabernaelrincon.ejemplo', 1, '2026-01-15'
);

INSERT INTO usuarios (id, email, nombre, rol, gestoria_id, empresa_id, activo,
                      password_hash, debe_cambiar_password)
VALUES
  ('usu_taberna', 'gerencia@tabernaelrincon.ejemplo', 'Taberna El Rincón', 'empresa', NULL, 'emc_taberna', 1,
   'pbkdf2$100000$4aada116425efe7857378328bd84dcce$8373a00f316b4c2ff842b5c04fa1fbd69432f95b01f2596603bbf2d334e5d5f6', 0);

INSERT INTO empleados (
  id, empresa_id, numero, nombre, apellidos, documento_identidad, email, pin_hash,
  tipo_jornada, rol, dias_vacaciones_anuales, fecha_alta, fecha_baja, activo
) VALUES
  ('emp_javier_t', 'emc_taberna', 1, 'Javier', 'Molina Serra', '21112233D', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'responsable', 22, '2026-01-15', NULL, 1),
  ('emp_noelia_t', 'emc_taberna', 2, 'Noelia', 'Prieto Cano', '21223344E', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'empleado', 22, '2026-01-15', NULL, 1),
  ('emp_ruben_t', 'emc_taberna', 3, 'Rubén', 'Carmona Díaz', '21334455F', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'empleado', 22, '2026-01-15', NULL, 1),
  ('emp_lucia_t', 'emc_taberna', 4, 'Lucía', 'Peña Rodrigo', '21445566G', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'parcial', 'empleado', 22, '2026-05-01', NULL, 1);

-- Turno partido: comidas y cenas, de miércoles a domingo (lunes y martes cierra).
INSERT INTO horarios_teoricos (id, empresa_id, empleado_id, dia_semana, hora_entrada, hora_salida, vigente_desde, vigente_hasta)
VALUES
  ('hor_javier_t_3','emc_taberna','emp_javier_t',3,'12:00','16:00','2026-01-15',NULL),
  ('hor_javier_t_3b','emc_taberna','emp_javier_t',3,'20:00','24:00','2026-01-15',NULL),
  ('hor_javier_t_4','emc_taberna','emp_javier_t',4,'12:00','16:00','2026-01-15',NULL),
  ('hor_javier_t_4b','emc_taberna','emp_javier_t',4,'20:00','24:00','2026-01-15',NULL),
  ('hor_javier_t_5','emc_taberna','emp_javier_t',5,'12:00','16:00','2026-01-15',NULL),
  ('hor_javier_t_5b','emc_taberna','emp_javier_t',5,'20:00','24:00','2026-01-15',NULL),
  ('hor_javier_t_6','emc_taberna','emp_javier_t',6,'12:00','16:00','2026-01-15',NULL),
  ('hor_javier_t_6b','emc_taberna','emp_javier_t',6,'20:00','24:00','2026-01-15',NULL),
  ('hor_javier_t_7','emc_taberna','emp_javier_t',7,'12:00','17:00','2026-01-15',NULL),
  ('hor_noelia_t_3','emc_taberna','emp_noelia_t',3,'12:00','16:00','2026-01-15',NULL),
  ('hor_noelia_t_4','emc_taberna','emp_noelia_t',4,'12:00','16:00','2026-01-15',NULL),
  ('hor_noelia_t_5','emc_taberna','emp_noelia_t',5,'12:00','16:00','2026-01-15',NULL),
  ('hor_noelia_t_6','emc_taberna','emp_noelia_t',6,'12:00','16:00','2026-01-15',NULL),
  ('hor_noelia_t_7','emc_taberna','emp_noelia_t',7,'12:00','17:00','2026-01-15',NULL),
  ('hor_ruben_t_5','emc_taberna','emp_ruben_t',5,'20:00','24:00','2026-01-15',NULL),
  ('hor_ruben_t_6','emc_taberna','emp_ruben_t',6,'20:00','24:00','2026-01-15',NULL),
  ('hor_ruben_t_7','emc_taberna','emp_ruben_t',7,'12:00','17:00','2026-01-15',NULL),
  ('hor_lucia_t_6','emc_taberna','emp_lucia_t',6,'20:00','24:00','2026-05-01',NULL),
  ('hor_lucia_t_7','emc_taberna','emp_lucia_t',7,'12:00','17:00','2026-05-01',NULL);

INSERT INTO calendario_laboral (id, empresa_id, fecha, tipo, descripcion)
VALUES
  ('cal_t_1','emc_taberna','2026-01-01','festivo_nacional','Año Nuevo'),
  ('cal_t_2','emc_taberna','2026-01-06','festivo_nacional','Epifanía del Señor'),
  ('cal_t_3','emc_taberna','2026-05-01','festivo_nacional','Fiesta del Trabajo'),
  ('cal_t_4','emc_taberna','2026-08-15','festivo_nacional','Asunción de la Virgen'),
  ('cal_t_5','emc_taberna','2026-10-12','festivo_nacional','Fiesta Nacional de España'),
  ('cal_t_6','emc_taberna','2026-12-25','festivo_nacional','Natividad del Señor'),
  ('cal_t_7','emc_taberna','2026-08-10','cierre_empresa','Cierre por vacaciones'),
  ('cal_t_8','emc_taberna','2026-08-11','cierre_empresa','Cierre por vacaciones');

-- ---------------------------------------------------------------------
-- Empresa 4: reformas / construcción (horario de obra, madrugador)
-- ---------------------------------------------------------------------
INSERT INTO empresas (
  id, gestoria_id, numero, nombre, codigo, cif, direccion, zona_horaria,
  tolerancia_minutos, jornada_maxima_alerta_horas,
  geolocalizacion_activa, geolocalizacion_motivo, avisos_modo, avisos_email, activa, fecha_alta
) VALUES (
  'emc_reformas', 'ges_dev', 4, 'Reformas Hermanos García S.L.', 'REFORGARCIA', 'B45678901',
  'Camino de las Canteras s/n, nave 3', 'Europe/Madrid',
  10, 10, 1,
  'El personal trabaja en obra fuera del centro fijo; la geolocalización sólo '
  || 'se registra al fichar entrada y salida, para acreditar el centro de trabajo.',
  'resumen_diario', 'oficina@reformasgarcia.ejemplo', 1, '2026-01-02'
);

INSERT INTO usuarios (id, email, nombre, rol, gestoria_id, empresa_id, activo,
                      password_hash, debe_cambiar_password)
VALUES
  ('usu_reformas', 'oficina@reformasgarcia.ejemplo', 'Reformas Hermanos García', 'empresa', NULL, 'emc_reformas', 1,
   'pbkdf2$100000$4aada116425efe7857378328bd84dcce$8373a00f316b4c2ff842b5c04fa1fbd69432f95b01f2596603bbf2d334e5d5f6', 0);

INSERT INTO empleados (
  id, empresa_id, numero, nombre, apellidos, documento_identidad, email, pin_hash,
  tipo_jornada, rol, dias_vacaciones_anuales, fecha_alta, fecha_baja, activo
) VALUES
  ('emp_pedro_r', 'emc_reformas', 1, 'Pedro', 'García Otero', '22112233H', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'responsable', 22, '2026-01-02', NULL, 1),
  ('emp_manuel_r', 'emc_reformas', 2, 'Manuel', 'García Otero', '22223344I', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'empleado', 22, '2026-01-02', NULL, 1),
  ('emp_alex_r', 'emc_reformas', 3, 'Alexandru', 'Pop Ionescu', '22334455J', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'empleado', 22, '2026-01-02', NULL, 1),
  ('emp_karim_r', 'emc_reformas', 4, 'Karim', 'El Amrani', '22445566K', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'empleado', 22, '2026-03-15', NULL, 1),
  ('emp_diego_r', 'emc_reformas', 5, 'Diego', 'Vázquez Lima', '22556677L', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'empleado', 22, '2026-06-01', NULL, 1);

-- Horario de obra: entrada temprana, jornada intensiva con una pausa corta.
INSERT INTO horarios_teoricos (id, empresa_id, empleado_id, dia_semana, hora_entrada, hora_salida, vigente_desde, vigente_hasta)
VALUES
  ('hor_pedro_r_1','emc_reformas','emp_pedro_r',1,'07:00','15:00','2026-01-02',NULL),
  ('hor_pedro_r_2','emc_reformas','emp_pedro_r',2,'07:00','15:00','2026-01-02',NULL),
  ('hor_pedro_r_3','emc_reformas','emp_pedro_r',3,'07:00','15:00','2026-01-02',NULL),
  ('hor_pedro_r_4','emc_reformas','emp_pedro_r',4,'07:00','15:00','2026-01-02',NULL),
  ('hor_pedro_r_5','emc_reformas','emp_pedro_r',5,'07:00','14:00','2026-01-02',NULL),
  ('hor_manuel_r_1','emc_reformas','emp_manuel_r',1,'07:00','15:00','2026-01-02',NULL),
  ('hor_manuel_r_2','emc_reformas','emp_manuel_r',2,'07:00','15:00','2026-01-02',NULL),
  ('hor_manuel_r_3','emc_reformas','emp_manuel_r',3,'07:00','15:00','2026-01-02',NULL),
  ('hor_manuel_r_4','emc_reformas','emp_manuel_r',4,'07:00','15:00','2026-01-02',NULL),
  ('hor_manuel_r_5','emc_reformas','emp_manuel_r',5,'07:00','14:00','2026-01-02',NULL),
  ('hor_alex_r_1','emc_reformas','emp_alex_r',1,'07:00','15:00','2026-01-02',NULL),
  ('hor_alex_r_2','emc_reformas','emp_alex_r',2,'07:00','15:00','2026-01-02',NULL),
  ('hor_alex_r_3','emc_reformas','emp_alex_r',3,'07:00','15:00','2026-01-02',NULL),
  ('hor_alex_r_4','emc_reformas','emp_alex_r',4,'07:00','15:00','2026-01-02',NULL),
  ('hor_alex_r_5','emc_reformas','emp_alex_r',5,'07:00','14:00','2026-01-02',NULL),
  ('hor_karim_r_1','emc_reformas','emp_karim_r',1,'07:00','15:00','2026-03-15',NULL),
  ('hor_karim_r_2','emc_reformas','emp_karim_r',2,'07:00','15:00','2026-03-15',NULL),
  ('hor_karim_r_3','emc_reformas','emp_karim_r',3,'07:00','15:00','2026-03-15',NULL),
  ('hor_karim_r_4','emc_reformas','emp_karim_r',4,'07:00','15:00','2026-03-15',NULL),
  ('hor_karim_r_5','emc_reformas','emp_karim_r',5,'07:00','14:00','2026-03-15',NULL),
  ('hor_diego_r_1','emc_reformas','emp_diego_r',1,'07:00','15:00','2026-06-01',NULL),
  ('hor_diego_r_2','emc_reformas','emp_diego_r',2,'07:00','15:00','2026-06-01',NULL),
  ('hor_diego_r_3','emc_reformas','emp_diego_r',3,'07:00','15:00','2026-06-01',NULL),
  ('hor_diego_r_4','emc_reformas','emp_diego_r',4,'07:00','15:00','2026-06-01',NULL),
  ('hor_diego_r_5','emc_reformas','emp_diego_r',5,'07:00','14:00','2026-06-01',NULL);

INSERT INTO calendario_laboral (id, empresa_id, fecha, tipo, descripcion)
VALUES
  ('cal_r_1','emc_reformas','2026-01-01','festivo_nacional','Año Nuevo'),
  ('cal_r_2','emc_reformas','2026-01-06','festivo_nacional','Epifanía del Señor'),
  ('cal_r_3','emc_reformas','2026-04-03','festivo_nacional','Viernes Santo'),
  ('cal_r_4','emc_reformas','2026-05-01','festivo_nacional','Fiesta del Trabajo'),
  ('cal_r_5','emc_reformas','2026-08-15','festivo_nacional','Asunción de la Virgen'),
  ('cal_r_6','emc_reformas','2026-10-12','festivo_nacional','Fiesta Nacional de España'),
  ('cal_r_7','emc_reformas','2026-11-02','festivo_nacional','Todos los Santos (trasladado)'),
  ('cal_r_8','emc_reformas','2026-12-08','festivo_nacional','Inmaculada Concepción'),
  ('cal_r_9','emc_reformas','2026-12-25','festivo_nacional','Natividad del Señor'),
  ('cal_r_10','emc_reformas','2026-08-17','cierre_empresa','Cierre por vacaciones'),
  ('cal_r_11','emc_reformas','2026-08-18','cierre_empresa','Cierre por vacaciones'),
  ('cal_r_12','emc_reformas','2026-08-19','cierre_empresa','Cierre por vacaciones'),
  ('cal_r_13','emc_reformas','2026-08-20','cierre_empresa','Cierre por vacaciones'),
  ('cal_r_14','emc_reformas','2026-08-21','cierre_empresa','Cierre por vacaciones');

-- ---------------------------------------------------------------------
-- Empresa 5: comercio pequeño (tienda de barrio, dos personas)
-- ---------------------------------------------------------------------
INSERT INTO empresas (
  id, gestoria_id, numero, nombre, codigo, cif, direccion, zona_horaria,
  tolerancia_minutos, jornada_maxima_alerta_horas,
  geolocalizacion_activa, avisos_modo, avisos_email, activa, fecha_alta
) VALUES (
  'emc_fruteria', 'ges_dev', 5, 'Frutería Ecológica Verde S.L.', 'FRUTVERDE', 'B56789012',
  'Calle San Isidro 8', 'Europe/Madrid',
  20, 9, 0, 'resumen_diario', 'verde@fruteria.ejemplo', 1, '2026-04-01'
);

INSERT INTO usuarios (id, email, nombre, rol, gestoria_id, empresa_id, activo,
                      password_hash, debe_cambiar_password)
VALUES
  ('usu_fruteria', 'verde@fruteria.ejemplo', 'Frutería Ecológica Verde', 'empresa', NULL, 'emc_fruteria', 1,
   'pbkdf2$100000$4aada116425efe7857378328bd84dcce$8373a00f316b4c2ff842b5c04fa1fbd69432f95b01f2596603bbf2d334e5d5f6', 0);

INSERT INTO empleados (
  id, empresa_id, numero, nombre, apellidos, documento_identidad, email, pin_hash,
  tipo_jornada, rol, dias_vacaciones_anuales, fecha_alta, fecha_baja, activo
) VALUES
  ('emp_isabel_f', 'emc_fruteria', 1, 'Isabel', 'Torres Blanco', '23112233M', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'completa', 'responsable', 23, '2026-04-01', NULL, 1),
  ('emp_marcos_f', 'emc_fruteria', 2, 'Marcos', 'Iglesias Pardo', '23223344N', NULL,
   'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
   'parcial', 'empleado', 22, '2026-04-01', NULL, 1);

-- Tienda de barrio: de lunes a sábado, mañana y tarde con pausa de comida.
INSERT INTO horarios_teoricos (id, empresa_id, empleado_id, dia_semana, hora_entrada, hora_salida, vigente_desde, vigente_hasta)
VALUES
  ('hor_isabel_f_1','emc_fruteria','emp_isabel_f',1,'09:00','14:00','2026-04-01',NULL),
  ('hor_isabel_f_1b','emc_fruteria','emp_isabel_f',1,'17:00','20:30','2026-04-01',NULL),
  ('hor_isabel_f_2','emc_fruteria','emp_isabel_f',2,'09:00','14:00','2026-04-01',NULL),
  ('hor_isabel_f_2b','emc_fruteria','emp_isabel_f',2,'17:00','20:30','2026-04-01',NULL),
  ('hor_isabel_f_3','emc_fruteria','emp_isabel_f',3,'09:00','14:00','2026-04-01',NULL),
  ('hor_isabel_f_3b','emc_fruteria','emp_isabel_f',3,'17:00','20:30','2026-04-01',NULL),
  ('hor_isabel_f_4','emc_fruteria','emp_isabel_f',4,'09:00','14:00','2026-04-01',NULL),
  ('hor_isabel_f_4b','emc_fruteria','emp_isabel_f',4,'17:00','20:30','2026-04-01',NULL),
  ('hor_isabel_f_5','emc_fruteria','emp_isabel_f',5,'09:00','14:00','2026-04-01',NULL),
  ('hor_isabel_f_5b','emc_fruteria','emp_isabel_f',5,'17:00','20:30','2026-04-01',NULL),
  ('hor_isabel_f_6','emc_fruteria','emp_isabel_f',6,'09:00','14:30','2026-04-01',NULL),
  ('hor_marcos_f_1','emc_fruteria','emp_marcos_f',1,'17:00','20:30','2026-04-01',NULL),
  ('hor_marcos_f_3','emc_fruteria','emp_marcos_f',3,'17:00','20:30','2026-04-01',NULL),
  ('hor_marcos_f_5','emc_fruteria','emp_marcos_f',5,'17:00','20:30','2026-04-01',NULL),
  ('hor_marcos_f_6','emc_fruteria','emp_marcos_f',6,'09:00','14:30','2026-04-01',NULL);

INSERT INTO calendario_laboral (id, empresa_id, fecha, tipo, descripcion)
VALUES
  ('cal_f_1','emc_fruteria','2026-01-01','festivo_nacional','Año Nuevo'),
  ('cal_f_2','emc_fruteria','2026-01-06','festivo_nacional','Epifanía del Señor'),
  ('cal_f_3','emc_fruteria','2026-05-01','festivo_nacional','Fiesta del Trabajo'),
  ('cal_f_4','emc_fruteria','2026-08-15','festivo_nacional','Asunción de la Virgen'),
  ('cal_f_5','emc_fruteria','2026-10-12','festivo_nacional','Fiesta Nacional de España'),
  ('cal_f_6','emc_fruteria','2026-12-25','festivo_nacional','Natividad del Señor');
