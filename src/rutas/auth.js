/**
 * Rutas de autenticación.
 *
 * Dos caminos distintos porque son dos poblaciones distintas: la gestoría y el
 * empresario tienen correo y entran por enlace mágico; el trabajador teclea el
 * código de su empresa y un PIN de seis dígitos.
 */
import { json, malaPeticion, noAutenticado, noEncontrado } from '../lib/respuestas.js';
import {
  crearSesion, cookieDeCierre, crearEnlaceMagico, canjearEnlaceMagico,
  verificarPin, revocarSesion,
} from '../lib/auth.js';
import { enviarCorreo, plantillaEnlaceMagico } from '../lib/correo.js';
import { registrarAcceso } from '../lib/log.js';

export function registrarRutasAuth(router) {
  /**
   * Pide un enlace mágico. Responde siempre lo mismo exista o no la cuenta:
   * si no, cualquiera podría averiguar qué correos están dados de alta.
   */
  router.post('/api/auth/enlace', async ({ env, cuerpo, url }) => {
    const email = String(cuerpo.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) throw malaPeticion('Correo no válido');

    const usuario = await env.DB.prepare(
      `SELECT * FROM usuarios WHERE lower(email) = ? AND activo = 1`,
    ).bind(email).first();

    if (usuario) {
      const { token, minutos } = await crearEnlaceMagico(env, usuario.id);
      const enlace = `${url.origin}/api/auth/entrar?token=${encodeURIComponent(token)}`;
      const { asunto, texto } = plantillaEnlaceMagico(enlace, minutos);
      await enviarCorreo(env, { para: usuario.email, asunto, texto });
    }

    return json({ ok: true, mensaje: 'Si el correo está dado de alta, recibirá un enlace' });
  });

  /** Canjea el enlace y deja la sesión puesta. Redirige al panel que toque. */
  router.get('/api/auth/entrar', async ({ env, url, peticion }) => {
    const token = url.searchParams.get('token');
    if (!token) throw malaPeticion('Falta el token');

    const usuario = await canjearEnlaceMagico(env, token);
    if (!usuario) throw noAutenticado('La cuenta ya no está activa');

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
      recurso: 'enlace_magico',
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    const destino = usuario.rol === 'gestoria' ? '/gestoria/' : '/empresa/';
    return new Response(null, {
      status: 302,
      headers: { location: destino, 'set-cookie': cookie },
    });
  });

  /**
   * Trabajadores de una empresa, por su código. Es lo que permite elegirse en
   * la lista sin tener que recordar un identificador: con plantillas de tres
   * personas, pedir usuario y contraseña es garantía de que no se ficha.
   * Sólo devuelve nombre e identificador, nunca datos personales.
   */
  router.get('/api/auth/empresa/:codigo', async ({ env, parametros, peticion }) => {
    const empresa = await env.DB.prepare(
      `SELECT id, nombre, codigo FROM empresas WHERE upper(codigo) = ? AND activa = 1`,
    ).bind(parametros.codigo.toUpperCase()).first();
    if (!empresa) throw noEncontrado('No hay ninguna empresa con ese código');

    const { results } = await env.DB.prepare(
      `SELECT id, nombre, apellidos FROM empleados
        WHERE empresa_id = ? AND activo = 1 AND pin_hash IS NOT NULL
        ORDER BY apellidos, nombre`,
    ).bind(empresa.id).all();

    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: 'empleado',
      accion: 'consulta',
      recurso: 'listado_acceso',
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    return json({
      empresa: { id: empresa.id, nombre: empresa.nombre, codigo: empresa.codigo },
      empleados: results ?? [],
    });
  });

  /** Entrada del trabajador: empresa + empleado + PIN. */
  router.post('/api/auth/pin', async ({ env, cuerpo, peticion }) => {
    const codigo = String(cuerpo.codigo ?? '').trim().toUpperCase();
    const empleadoId = String(cuerpo.empleado_id ?? '');
    const pin = String(cuerpo.pin ?? '');

    const empresa = await env.DB.prepare(
      `SELECT id FROM empresas WHERE upper(codigo) = ? AND activa = 1`,
    ).bind(codigo).first();

    const empleado = empresa
      ? await env.DB.prepare(
          `SELECT * FROM empleados WHERE id = ? AND empresa_id = ? AND activo = 1`,
        ).bind(empleadoId, empresa.id).first()
      : null;

    // Se verifica el PIN aunque no exista el empleado, para que el tiempo de
    // respuesta no distinga «no existe» de «PIN incorrecto».
    const correcto = await verificarPin(pin, empleado?.pin_hash ?? null);
    if (!empleado || !correcto) {
      await registrarAcceso(env.DB, {
        empresaId: empresa?.id ?? null,
        actorTipo: 'empleado',
        actorId: empleadoId || null,
        accion: 'inicio_sesion_fallido',
        ip: peticion.headers.get('cf-connecting-ip'),
      });
      throw noAutenticado('Código o PIN incorrectos');
    }

    const cookie = await crearSesion(env, {
      actorTipo: 'empleado',
      actorId: empleado.id,
      empresaId: empresa.id,
    });
    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: 'empleado',
      actorId: empleado.id,
      accion: 'inicio_sesion',
      ip: peticion.headers.get('cf-connecting-ip'),
    });

    return json(
      { ok: true, empleado: { id: empleado.id, nombre: empleado.nombre, apellidos: empleado.apellidos } },
      200,
      { 'set-cookie': cookie },
    );
  });

  /** Quién soy. Lo llama el frontend al arrancar para saber qué pintar. */
  router.get('/api/auth/yo', async ({ env, sesion }) => {
    if (!sesion) throw noAutenticado();

    const base = { actor_tipo: sesion.actorTipo, actor_id: sesion.actorId };

    if (sesion.actorTipo === 'empleado') {
      const empleado = await env.DB.prepare(
        `SELECT e.id, e.nombre, e.apellidos, e.rol, e.dias_vacaciones_anuales,
                em.id AS empresa_id, em.nombre AS empresa_nombre,
                em.zona_horaria, em.geolocalizacion_activa
           FROM empleados e JOIN empresas em ON em.id = e.empresa_id
          WHERE e.id = ?`,
      ).bind(sesion.actorId).first();
      return json({ ...base, ...empleado });
    }

    if (sesion.actorTipo === 'gestoria') {
      const gestoria = await env.DB.prepare(
        `SELECT g.id, g.nombre FROM gestorias g
           JOIN usuarios u ON u.gestoria_id = g.id WHERE u.id = ?`,
      ).bind(sesion.actorId).first();
      return json({ ...base, gestoria });
    }

    const empresa = await env.DB.prepare(
      `SELECT id, nombre, codigo, zona_horaria, tolerancia_minutos,
              jornada_maxima_alerta_horas, geolocalizacion_activa, avisos_modo
         FROM empresas WHERE id = ?`,
    ).bind(sesion.empresaId).first();
    return json({ ...base, empresa });
  });

  router.post('/api/auth/salir', async ({ env, sesion }) => {
    if (sesion) await revocarSesion(env, sesion.id);
    return json({ ok: true }, 200, { 'set-cookie': cookieDeCierre(env) });
  });
}
