/**
 * Rutas de acceso.
 *
 * Dos caminos, porque son dos poblaciones distintas, pero el mismo mecanismo:
 * un identificador y una clave que la persona guarda.
 *
 *  - El trabajador teclea su identificador de seis cifras —el número de su
 *    empresa y el suyo dentro de ella: empresa 2, empleado 3 son `002003`— y
 *    su PIN. Todo numérico, porque se teclea en el teclado de la propia
 *    aplicación, con guantes puestos y a una mano.
 *  - La empresa y la gestoría, con su correo y una contraseña.
 *
 * Sin correo en el acceso, una clave olvidada se repone por jerarquía:
 *
 *    gestoría  →  repone la contraseña de sus empresas
 *    empresa   →  repone el PIN de sus trabajadores
 *    gestoría  →  la suya se repone a mano; sólo hay una
 *
 * Quien reparte una clave la conoce, así que toda clave puesta por otro nace
 * marcada para cambio obligatorio en el primer acceso.
 */
import { json, malaPeticion, noAutenticado } from '../lib/respuestas.js';
import {
  crearSesion, cookieDeCierre, revocarSesion, verificarSecreto,
  hashearPin, hashearPassword, exigirSinBloqueo, anotarFallo, limpiarFallos,
  MINIMO_PASSWORD,
} from '../lib/auth.js';
import { registrarAcceso } from '../lib/log.js';

/** 'EEEPPP': tres cifras de empresa y tres de empleado. */
const IDENTIFICADOR = /^\d{6}$/;

/** Descompone el identificador del trabajador en sus dos números. */
export function partirIdentificador(identificador) {
  const texto = String(identificador ?? '').trim();
  if (!IDENTIFICADOR.test(texto)) return null;
  return {
    empresa: Number(texto.slice(0, 3)),
    empleado: Number(texto.slice(3)),
  };
}

/** Compone el identificador a partir de los dos números. */
export function componerIdentificador(numeroEmpresa, numeroEmpleado) {
  return String(numeroEmpresa).padStart(3, '0') + String(numeroEmpleado).padStart(3, '0');
}

export function registrarRutasAuth(router) {
  /**
   * Entrada del trabajador: identificador numérico y PIN.
   *
   * La respuesta no distingue «ese identificador no existe» de «PIN
   * incorrecto», y se verifica la clave aunque el empleado no exista, para que
   * tampoco lo distinga el tiempo de respuesta. Con identificadores
   * secuenciales eso importa más que antes: son enumerables.
   */
  router.post('/api/auth/trabajador', async ({ env, cuerpo, peticion }) => {
    const identificador = String(cuerpo.identificador ?? '').trim();
    const pin = String(cuerpo.pin ?? '');
    const ip = peticion.headers.get('cf-connecting-ip');

    const numeros = partirIdentificador(identificador);
    if (!numeros) throw malaPeticion('El identificador son seis cifras');

    await exigirSinBloqueo(env, identificador, ip);

    const empleado = await env.DB.prepare(
      `SELECT e.*, em.id AS emp_id, em.activa AS emp_activa
         FROM empleados e
         JOIN empresas em ON em.id = e.empresa_id
        WHERE em.numero = ? AND e.numero = ? AND e.activo = 1`,
    ).bind(numeros.empresa, numeros.empleado).first();

    const correcto = await verificarSecreto(pin, empleado?.pin_hash ?? null);

    if (!empleado || !empleado.emp_activa || !correcto) {
      await anotarFallo(env, identificador, ip);
      await registrarAcceso(env.DB, {
        empresaId: empleado?.emp_id ?? null,
        actorTipo: 'empleado',
        actorId: empleado?.id ?? null,
        accion: 'inicio_sesion_fallido',
        recurso: identificador,
        ip,
      });
      throw noAutenticado('Identificador o PIN incorrectos');
    }

    await limpiarFallos(env, identificador, ip);
    const cookie = await crearSesion(env, {
      actorTipo: 'empleado',
      actorId: empleado.id,
      empresaId: empleado.empresa_id,
    });
    await registrarAcceso(env.DB, {
      empresaId: empleado.empresa_id,
      actorTipo: 'empleado',
      actorId: empleado.id,
      accion: 'inicio_sesion',
      ip,
    });

    return json({
      ok: true,
      debe_cambiar_pin: Boolean(empleado.pin_debe_cambiarse),
      empleado: {
        id: empleado.id,
        nombre: empleado.nombre,
        apellidos: empleado.apellidos,
      },
    }, 200, { 'set-cookie': cookie });
  });

  /** Entrada de empresa y gestoría: correo y contraseña. */
  router.post('/api/auth/panel', async ({ env, cuerpo, peticion }) => {
    const email = String(cuerpo.email ?? '').trim().toLowerCase();
    const password = String(cuerpo.password ?? '');
    const ip = peticion.headers.get('cf-connecting-ip');
    if (!email.includes('@')) throw malaPeticion('Correo no válido');

    await exigirSinBloqueo(env, email, ip);

    const usuario = await env.DB.prepare(
      `SELECT * FROM usuarios WHERE lower(email) = ? AND activo = 1`,
    ).bind(email).first();

    const correcto = await verificarSecreto(password, usuario?.password_hash ?? null);

    if (!usuario || !correcto) {
      await anotarFallo(env, email, ip);
      await registrarAcceso(env.DB, {
        empresaId: usuario?.empresa_id ?? null,
        actorTipo: usuario?.rol ?? 'empresa',
        actorId: usuario?.id ?? null,
        accion: 'inicio_sesion_fallido',
        recurso: email,
        ip,
      });
      throw noAutenticado('Correo o contraseña incorrectos');
    }

    await limpiarFallos(env, email, ip);
    const cookie = await crearSesion(env, {
      actorTipo: usuario.rol,
      actorId: usuario.id,
      empresaId: usuario.empresa_id,
      gestoriaId: usuario.gestoria_id,
    });
    await registrarAcceso(env.DB, {
      empresaId: usuario.empresa_id,
      actorTipo: usuario.rol,
      actorId: usuario.id,
      accion: 'inicio_sesion',
      ip,
    });

    return json({
      ok: true,
      rol: usuario.rol,
      debe_cambiar_password: Boolean(usuario.debe_cambiar_password),
      destino: usuario.rol === 'gestoria' ? '/gestoria/' : '/empresa/',
    }, 200, { 'set-cookie': cookie });
  });

  // --- Cambio de clave por su dueño ---------------------------------------

  /** El trabajador cambia su PIN. Exige el actual, también en el primer acceso. */
  router.post('/api/auth/cambiar-pin', async ({ env, sesion, cuerpo, peticion }) => {
    if (sesion?.actorTipo !== 'empleado') throw noAutenticado();

    const actual = String(cuerpo.pin_actual ?? '');
    const nuevo = String(cuerpo.pin_nuevo ?? '');

    const empleado = await env.DB.prepare(
      `SELECT id, empresa_id, pin_hash FROM empleados WHERE id = ?`,
    ).bind(sesion.actorId).first();

    if (!await verificarSecreto(actual, empleado?.pin_hash ?? null)) {
      throw noAutenticado('El PIN actual no es correcto');
    }
    if (nuevo === actual) throw malaPeticion('El PIN nuevo tiene que ser distinto del actual');

    await env.DB.prepare(
      `UPDATE empleados SET pin_hash = ?, pin_debe_cambiarse = 0 WHERE id = ?`,
    ).bind(await hashearPin(nuevo), empleado.id).run();

    await registrarAcceso(env.DB, {
      empresaId: empleado.empresa_id,
      actorTipo: 'empleado',
      actorId: empleado.id,
      accion: 'cambio_clave',
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    return json({ ok: true });
  });

  /** La empresa o la gestoría cambian su contraseña. */
  router.post('/api/auth/cambiar-password', async ({ env, sesion, cuerpo, peticion }) => {
    if (sesion?.actorTipo !== 'empresa' && sesion?.actorTipo !== 'gestoria') {
      throw noAutenticado();
    }

    const actual = String(cuerpo.password_actual ?? '');
    const nueva = String(cuerpo.password_nueva ?? '');

    const usuario = await env.DB.prepare(
      `SELECT id, empresa_id, password_hash FROM usuarios WHERE id = ?`,
    ).bind(sesion.actorId).first();

    if (!await verificarSecreto(actual, usuario?.password_hash ?? null)) {
      throw noAutenticado('La contraseña actual no es correcta');
    }
    if (nueva === actual) throw malaPeticion('La contraseña nueva tiene que ser distinta de la actual');

    await env.DB.prepare(
      `UPDATE usuarios SET password_hash = ?, debe_cambiar_password = 0 WHERE id = ?`,
    ).bind(await hashearPassword(nueva), usuario.id).run();

    await registrarAcceso(env.DB, {
      empresaId: usuario.empresa_id,
      actorTipo: sesion.actorTipo,
      actorId: usuario.id,
      accion: 'cambio_clave',
      ip: peticion.headers.get('cf-connecting-ip'),
    });
    return json({ ok: true });
  });

  // --- Quién soy y salir --------------------------------------------------

  /** Lo llama el frontend al arrancar para saber qué pintar. */
  router.get('/api/auth/yo', async ({ env, sesion }) => {
    if (!sesion) throw noAutenticado();

    const base = { actor_tipo: sesion.actorTipo, actor_id: sesion.actorId };

    if (sesion.actorTipo === 'empleado') {
      const empleado = await env.DB.prepare(
        `SELECT e.id, e.nombre, e.apellidos, e.rol, e.numero, e.dias_vacaciones_anuales,
                e.pin_debe_cambiarse,
                em.id AS empresa_id, em.nombre AS empresa_nombre, em.numero AS empresa_numero,
                em.zona_horaria, em.geolocalizacion_activa
           FROM empleados e JOIN empresas em ON em.id = e.empresa_id
          WHERE e.id = ?`,
      ).bind(sesion.actorId).first();
      return json({
        ...base,
        ...empleado,
        identificador: componerIdentificador(empleado.empresa_numero, empleado.numero),
        debe_cambiar_pin: Boolean(empleado.pin_debe_cambiarse),
      });
    }

    const usuario = await env.DB.prepare(
      `SELECT debe_cambiar_password FROM usuarios WHERE id = ?`,
    ).bind(sesion.actorId).first();
    const debeCambiar = Boolean(usuario?.debe_cambiar_password);

    if (sesion.actorTipo === 'gestoria') {
      const gestoria = await env.DB.prepare(
        `SELECT g.id, g.nombre FROM gestorias g
           JOIN usuarios u ON u.gestoria_id = g.id WHERE u.id = ?`,
      ).bind(sesion.actorId).first();
      return json({ ...base, gestoria, debe_cambiar_password: debeCambiar });
    }

    const empresa = await env.DB.prepare(
      `SELECT id, nombre, numero, codigo, zona_horaria, tolerancia_minutos,
              jornada_maxima_alerta_horas, geolocalizacion_activa, avisos_modo
         FROM empresas WHERE id = ?`,
    ).bind(sesion.empresaId).first();
    return json({ ...base, empresa, debe_cambiar_password: debeCambiar });
  });

  router.post('/api/auth/salir', async ({ env, sesion }) => {
    if (sesion) await revocarSesion(env, sesion.id);
    return json({ ok: true }, 200, { 'set-cookie': cookieDeCierre(env) });
  });

  /** Requisitos de clave, para que el frontend no los repita a mano. */
  router.get('/api/auth/requisitos', async () => json({
    pin_digitos: 6,
    password_minimo: MINIMO_PASSWORD,
  }));
}
