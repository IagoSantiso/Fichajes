/**
 * Plataforma de registro de jornada — punto de entrada del Worker.
 *
 * Aquí se resuelve, en este orden: sesión, empresa de la petición y alcance de
 * datos. Las rutas reciben el alcance ya atado a una empresa y no tienen forma
 * de salirse de él: es donde vive la decisión no negociable de aislamiento.
 */
import { Router } from './lib/router.js';
import { sesionDe } from './lib/auth.js';
import { alcanceEmpresa } from './lib/datos.js';
import { json, respuestaDeError, noAutenticado, prohibido, noEncontrado, malaPeticion } from './lib/respuestas.js';
import { ejecutarCron } from './incidencias/cron.js';

import { registrarRutasAuth } from './rutas/auth.js';
import { registrarRutasFichajes } from './rutas/fichajes.js';
import { registrarRutasEmpleados } from './rutas/empleados.js';
import { registrarRutasAusencias } from './rutas/ausencias.js';
import { registrarRutasIncidencias } from './rutas/incidencias.js';
import { registrarRutasInformes } from './rutas/informes.js';
import { registrarRutasGestoria } from './rutas/gestoria.js';
import { registrarRutasInspeccion, sesionDeInspeccion, RUTAS_INSPECCION } from './rutas/inspeccion.js';

/** Rutas que no exigen sesión. Todo lo demás sí. */
const PUBLICAS = new Set([
  'POST /api/auth/enlace',
  'GET /api/auth/entrar',
  // El trabajador consulta la lista de su empresa antes de tener sesión: es
  // el paso previo a teclear el PIN. Sólo devuelve nombres, y queda en el log.
  'GET /api/auth/empresa/:codigo',
  'POST /api/auth/pin',
  // Sólo dice si el modo demostración está activo; no revela nada de la
  // instalación. Ver MODO_DEMO_ENLACE en src/rutas/auth.js.
  'GET /api/auth/modo',
  'GET /api/salud',
]);

/** Rutas que no necesitan empresa resuelta (ámbito gestoría o global). */
const SIN_EMPRESA = new Set([
  'GET /api/auth/yo',
  'POST /api/auth/salir',
  'GET /api/gestoria/empresas',
  'POST /api/gestoria/empresas',
  'GET /api/gestoria/exportacion',
  'GET /api/exportacion/formatos',
  'GET /api/incidencias/tipos',
]);

const router = new Router();
router.get('/api/salud', async ({ env }) => json({
  ok: true,
  entorno: env.ENTORNO ?? 'desconocido',
  ahora: new Date().toISOString(),
}));
registrarRutasAuth(router);
registrarRutasFichajes(router);
registrarRutasEmpleados(router);
registrarRutasAusencias(router);
registrarRutasIncidencias(router);
registrarRutasInformes(router);
registrarRutasGestoria(router);
registrarRutasInspeccion(router);

export default {
  async fetch(peticion, env, ctx) {
    const url = new URL(peticion.url);

    // Todo lo que no sea /api/ es la PWA: la sirven los assets estáticos.
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(peticion);
    }

    try {
      return await atenderApi(peticion, env, ctx, url);
    } catch (error) {
      return respuestaDeError(error, env.ENTORNO);
    }
  },

  /**
   * Cron Triggers del motor de incidencias. Ver src/incidencias/cron.js para
   * por qué hay tres expresiones y cómo se reparten.
   */
  async scheduled(evento, env, ctx) {
    ctx.waitUntil((async () => {
      const resumen = await ejecutarCron(env, evento);
      console.log('Motor de incidencias:', JSON.stringify(resumen));
    })());
  },
};

async function atenderApi(peticion, env, ctx, url) {
  if (!env.SECRETO_SESION) {
    console.error('Falta SECRETO_SESION: no se pueden firmar sesiones');
    return json({ error: 'Servicio mal configurado' }, 503);
  }

  const encontrada = router.resolver(peticion.method, url.pathname);
  if (!encontrada) {
    if (peticion.method === 'OPTIONS') return new Response(null, { status: 204 });
    throw noEncontrado(`Ruta no encontrada: ${peticion.method} ${url.pathname}`);
  }

  const { clave } = encontrada;
  const publica = PUBLICAS.has(clave);

  // Un token de inspección vale como sesión, pero sólo para rutas de lectura.
  const sesion = await sesionDe(peticion, env) ?? await sesionDeInspeccion(peticion, env);
  if (!publica && !sesion) throw noAutenticado();
  if (sesion?.actorTipo === 'inspeccion' && !RUTAS_INSPECCION.includes(clave)) {
    throw prohibido('El acceso de inspección es de sólo lectura y de alcance limitado');
  }

  const cuerpo = await leerCuerpo(peticion);

  // Resolución de empresa y alcance de datos. La gestoría indica en qué
  // empresa está trabajando; los demás actores la llevan en la sesión.
  let empresa = null;
  let datos = null;
  if (!publica && !SIN_EMPRESA.has(clave)) {
    const empresaId = sesion.actorTipo === 'gestoria'
      ? (url.searchParams.get('empresa') ?? cuerpo.empresa_id ?? null)
      : sesion.empresaId;
    if (!empresaId) {
      throw malaPeticion('Indique en qué empresa está trabajando (parámetro «empresa»)');
    }
    empresa = await cargarEmpresa(env, sesion, empresaId);
    datos = alcanceEmpresa(env.DB, empresa.id);
  }

  const respuesta = await encontrada.manejador({
    peticion, env, ctx, url,
    parametros: encontrada.parametros,
    cuerpo, sesion, empresa, datos,
  });
  return respuesta ?? json({ ok: true });
}

/**
 * Carga la empresa comprobando que el actor puede verla. Es el único sitio
 * donde se resuelve una empresa a partir de la petición: si mañana aparece un
 * rol nuevo, se añade aquí y no en veinte endpoints.
 */
async function cargarEmpresa(env, sesion, empresaId) {
  const empresa = await env.DB.prepare(`SELECT * FROM empresas WHERE id = ?`)
    .bind(empresaId).first();
  if (!empresa) throw noEncontrado('Empresa no encontrada');

  if (sesion.actorTipo === 'gestoria') {
    if (empresa.gestoria_id !== sesion.gestoriaId) {
      throw prohibido('Esa empresa no pertenece a su gestoría');
    }
  } else if (sesion.empresaId !== empresa.id) {
    throw prohibido();
  }

  if (!empresa.activa && sesion.actorTipo === 'empleado') {
    throw prohibido('Esta empresa ya no está activa');
  }
  return empresa;
}

async function leerCuerpo(peticion) {
  if (peticion.method === 'GET' || peticion.method === 'DELETE') return {};
  const tipo = peticion.headers.get('content-type') ?? '';
  if (!tipo.includes('application/json')) return {};
  try {
    return (await peticion.json()) ?? {};
  } catch {
    throw malaPeticion('El cuerpo de la petición no es JSON válido');
  }
}
