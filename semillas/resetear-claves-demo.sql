-- Repone las claves de la demostración a sus valores conocidos, sin tocar
-- fichajes ni ningún otro dato.
--
-- Existe porque un INSERT OR IGNORE (que es lo que usa demo-completa.sql) no
-- corrige una fila que ya existe: sólo evita duplicarla. Si alguna vez las
-- claves de la demo quedan en un estado raro —una contraseña vacía, un PIN que
-- no es el documentado—, esto las devuelve a lo que dicen el README y la guía,
-- sin necesidad de volver a cargar todo el volcado.
--
-- Aplíquelo con:
--   npx wrangler d1 execute fichajes --remote --file=./semillas/resetear-claves-demo.sql
--
-- Después de ejecutarlo, las claves vuelven a ser:
--   gestor@ejemplo.es / fichajes2026
--   jefe@soldaduras.ejemplo / fichajes2026 (y el resto de empresas de la demo
--   multiempresa: ana@peluqueria.ejemplo, gerencia@tabernaelrincon.ejemplo,
--   oficina@reformasgarcia.ejemplo, verde@fruteria.ejemplo)
--   001001, 001002, 001003 (Ana, Luis, Marta) / 482915, y el resto de
--   empleados de la demo multiempresa

UPDATE usuarios
   SET password_hash = 'pbkdf2$100000$4aada116425efe7857378328bd84dcce$8373a00f316b4c2ff842b5c04fa1fbd69432f95b01f2596603bbf2d334e5d5f6',
       debe_cambiar_password = 0
 WHERE email IN ('gestor@ejemplo.es', 'jefe@soldaduras.ejemplo',
                  'ana@peluqueria.ejemplo', 'gerencia@tabernaelrincon.ejemplo',
                  'oficina@reformasgarcia.ejemplo', 'verde@fruteria.ejemplo');

UPDATE empleados
   SET pin_hash = 'pbkdf2$100000$a08473c9321b0d54fd84dc8e9fea4887$3a38c259ff739f40e4cd02955470f031b99b1389d132d99ab8b1d6e8ec53b02d',
       pin_debe_cambiarse = 0
 WHERE id IN ('emp_ana', 'emp_luis', 'emp_marta',
              'emp_ana_p', 'emp_clara_p', 'emp_sonia_p',
              'emp_javier_t', 'emp_noelia_t', 'emp_ruben_t', 'emp_lucia_t',
              'emp_pedro_r', 'emp_manuel_r', 'emp_alex_r', 'emp_karim_r', 'emp_diego_r',
              'emp_isabel_f', 'emp_marcos_f');
