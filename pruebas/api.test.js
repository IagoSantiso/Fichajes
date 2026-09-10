/**
 * Prueba de extremo a extremo del Worker.
 *
 * Recorre el camino completo: alta de empresa desde la gestoría, alta de
 * trabajador, entrada con código y PIN, fichaje, corrección, informe y
 * exportación. Es la prueba que detecta los fallos de cableado que ninguna
 * prueba de unidad ve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { entornoDePrueba } from './ayudas/d1.js';
import { crearSesion } from '../src/lib/auth.js';

const BASE = 'https://fichajes.ejemplo.es';

function prepararEntorno() {
  const { db, env } = entornoDePrueba();
  env.ASSETS = { fetch: async () => new Response('pwa', { status: 200 }) };
  return { db, env };
}

/** Llama al Worker como lo haría el navegador. */
async function llamar(env, metodo, ruta, { cuerpo = null, cookie = null } = {}) {
  const cabeceras = {};
  if (cuerpo) cabeceras['content-type'] = 'application/json';
  if (cookie) cabeceras.cookie = cookie;

  const respuesta = await worker.fetch(
    new Request(`${BASE}${ruta}`, {
      method: metodo,
      headers: cabeceras,
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    }),
    env,
    { waitUntil: () => {} },
  );

  const tipo = respuesta.headers.get('content-type') ?? '';
  return {
    estado: respuesta.status,
    cabeceras: respuesta.headers,
    datos: tipo.includes('json') ? await respuesta.json() : null,
    respuesta,
  };
}

function extraerCookie(cabeceras) {
  const bruto = cabeceras.get('set-cookie');
  return bruto ? bruto.split(';')[0] : null;
}

async function sesionDeGestoria(env, db) {
  db.exec(`INSERT INTO gestorias (id, nombre) VALUES ('ges_1','Gestoría Ejemplo')`);
  db.exec(`INSERT INTO usuarios (id, email, nombre, rol, gestoria_id)
           VALUES ('usu_g','gestor@ejemplo.es','Gestor','gestoria','ges_1')`);
  const cookie = await crearSesion(env, {
    actorTipo: 'gestoria', actorId: 'usu_g', gestoriaId: 'ges_1',
  });
  return cookie.split(';')[0];
}

test('sin sesión, la API responde 401 y no filtra nada', async () => {
  const { env } = prepararEntorno();
  const { estado } = await llamar(env, 'GET', '/api/empleados');
  assert.equal(estado, 401);
});

test('la ruta de salud no exige sesión', async () => {
  const { env } = prepararEntorno();
  const { estado, datos } = await llamar(env, 'GET', '/api/salud');
  assert.equal(estado, 200);
  assert.equal(datos.ok, true);
});

test('lo que no es /api/ lo sirven los assets de la PWA', async () => {
  const { env } = prepararEntorno();
  const respuesta = await worker.fetch(new Request(`${BASE}/empresa/`), env, {});
  assert.equal(await respuesta.text(), 'pwa');
});

test('recorrido completo: alta, fichaje, corrección, informe y exportación', async () => {
  const { db, env } = prepararEntorno();
  const cookieGestoria = await sesionDeGestoria(env, db);

  // 1. La gestoría da de alta una empresa.
  const alta = await llamar(env, 'POST', '/api/gestoria/empresas', {
    cookie: cookieGestoria,
    cuerpo: {
      nombre: 'Soldaduras Pérez S.L.', cif: 'B12345678',
      codigo: 'SOLDPER', tolerancia_minutos: 20,
    },
  });
  assert.equal(alta.estado, 201);
  const empresaId = alta.datos.empresa.id;

  // 2. Y un trabajador con su PIN.
  const trabajador = await llamar(env, 'POST', `/api/empleados?empresa=${empresaId}`, {
    cookie: cookieGestoria,
    cuerpo: { nombre: 'Ana', apellidos: 'Ruiz Gómez', pin: '482915', dias_vacaciones_anuales: 22 },
  });
  assert.equal(trabajador.estado, 201);
  const empleadoId = trabajador.datos.empleado.id;
  assert.equal(trabajador.datos.empleado.pin_hash, undefined, 'el PIN no puede volver en la respuesta');

  // 3. El trabajador ve su empresa por el código y entra con su PIN.
  const listado = await llamar(env, 'GET', '/api/auth/empresa/SOLDPER');
  assert.equal(listado.estado, 200);
  assert.equal(listado.datos.empleados.length, 1);

  const malPin = await llamar(env, 'POST', '/api/auth/pin', {
    cuerpo: { codigo: 'SOLDPER', empleado_id: empleadoId, pin: '000000' },
  });
  assert.equal(malPin.estado, 401);

  const entrada = await llamar(env, 'POST', '/api/auth/pin', {
    cuerpo: { codigo: 'SOLDPER', empleado_id: empleadoId, pin: '482915' },
  });
  assert.equal(entrada.estado, 200);
  const cookieTrabajador = extraerCookie(entrada.cabeceras);
  assert.ok(cookieTrabajador);

  // 4. Ficha entrada y salida.
  const estadoInicial = await llamar(env, 'GET', '/api/fichajes/estado', { cookie: cookieTrabajador });
  assert.equal(estadoInicial.datos.estado, 'fuera');
  assert.equal(estadoInicial.datos.acciones[0].tipo, 'entrada');

  const fichado = await llamar(env, 'POST', '/api/fichajes', {
    cookie: cookieTrabajador, cuerpo: { tipo: 'entrada' },
  });
  assert.equal(fichado.estado, 201);
  assert.equal(fichado.datos.estado, 'dentro');

  // Un segundo «entrada» seguido no procede: el botón ya ofrece otra cosa.
  const repetido = await llamar(env, 'POST', '/api/fichajes', {
    cookie: cookieTrabajador, cuerpo: { tipo: 'entrada' },
  });
  assert.equal(repetido.estado, 409);
  assert.equal(repetido.datos.codigo, 'transicion_invalida');

  const salida = await llamar(env, 'POST', '/api/fichajes', {
    cookie: cookieTrabajador, cuerpo: { tipo: 'salida' },
  });
  assert.equal(salida.estado, 201);

  // 5. El trabajador pide la corrección de un fichaje concreto; no puede
  //    aplicarla él.
  const hoy = fichado.datos.fichaje.fecha;
  const solicitud = await llamar(env, 'POST', '/api/correcciones', {
    cookie: cookieTrabajador,
    cuerpo: {
      fichaje_id: fichado.datos.fichaje.id,
      fecha_local: hoy,
      motivo: 'Fiché al llegar a la oficina, no a la obra',
      hora_propuesta: '07:30',
      tipo_propuesto: 'entrada',
    },
  });
  assert.equal(solicitud.estado, 201);

  const intento = await llamar(env, 'POST', `/api/fichajes/${fichado.datos.fichaje.id}/rectificar`, {
    cookie: cookieTrabajador,
    cuerpo: { fecha_local: hoy, hora: '07:30', motivo: 'yo mismo' },
  });
  assert.equal(intento.estado, 403, 'el trabajador solicita, no corrige');

  // 6. La gestoría la resuelve, y eso inserta una rectificación.
  const resolucion = await llamar(env,
    'POST', `/api/correcciones/${solicitud.datos.solicitud.id}/resolver?empresa=${empresaId}`, {
      cookie: cookieGestoria,
      cuerpo: { decision: 'aprobar', hora: '07:30', tipo: 'entrada', motivo: 'Corregido según parte' },
    });
  assert.equal(resolucion.estado, 200);
  assert.equal(resolucion.datos.fichaje.tipo_registro, 'rectificacion');

  // 7. La cadena sigue íntegra después de la corrección.
  const cadena = await llamar(env, 'GET', `/api/fichajes/verificar-cadena?empresa=${empresaId}`, {
    cookie: cookieGestoria,
  });
  assert.equal(cadena.datos.valida, true);
  assert.equal(cadena.datos.verificados, 3, 'entrada, salida y rectificación');

  // 8. Informe y exportación en los dos formatos.
  const informe = await llamar(env, 'GET', `/api/informes?empresa=${empresaId}`, {
    cookie: cookieGestoria,
  });
  assert.equal(informe.estado, 200);
  assert.equal(informe.datos.etiqueta_diferencia, 'Exceso sobre jornada teórica');

  for (const formato of ['pdf', 'csv']) {
    const exportacion = await llamar(env,
      'GET', `/api/exportacion?empresa=${empresaId}&formato=${formato}`, { cookie: cookieGestoria });
    assert.equal(exportacion.estado, 200);
    assert.match(exportacion.cabeceras.get('content-disposition'), /attachment; filename=/);
    assert.equal(exportacion.cabeceras.get('x-adaptador-exportacion'), `${formato}@1.0`);
  }

  // 9. Y todo ha quedado en el log de accesos.
  const accesos = await llamar(env, 'GET', `/api/informes/accesos?empresa=${empresaId}`, {
    cookie: cookieGestoria,
  });
  const acciones = accesos.datos.accesos.map((a) => a.accion);
  assert.ok(acciones.includes('exportacion'));
  assert.ok(acciones.includes('correccion'));
  assert.ok(acciones.includes('inicio_sesion'));
});

test('una solicitud que no apunta a ningún fichaje se resuelve como alta, no como rectificación', async () => {
  const { db, env } = prepararEntorno();
  const cookieGestoria = await sesionDeGestoria(env, db);

  const alta = await llamar(env, 'POST', '/api/gestoria/empresas', {
    cookie: cookieGestoria, cuerpo: { nombre: 'Empresa', codigo: 'EMPRESA1' },
  });
  const empresaId = alta.datos.empresa.id;
  const trabajador = await llamar(env, 'POST', `/api/empleados?empresa=${empresaId}`, {
    cookie: cookieGestoria, cuerpo: { nombre: 'Ana', pin: '111111' },
  });

  const sesion = await llamar(env, 'POST', '/api/auth/pin', {
    cuerpo: { codigo: 'EMPRESA1', empleado_id: trabajador.datos.empleado.id, pin: '111111' },
  });
  const cookie = extraerCookie(sesion.cabeceras);

  // El trabajador olvidó fichar: no hay original al que referenciar.
  const solicitud = await llamar(env, 'POST', '/api/correcciones', {
    cookie,
    cuerpo: { fecha_local: '2026-09-09', motivo: 'Olvidé fichar la entrada',
      hora_propuesta: '08:00', tipo_propuesto: 'entrada' },
  });

  const resolucion = await llamar(env,
    'POST', `/api/correcciones/${solicitud.datos.solicitud.id}/resolver?empresa=${empresaId}`, {
      cookie: cookieGestoria,
      cuerpo: { decision: 'aprobar', hora: '08:00', tipo: 'entrada', motivo: 'Confirmado con el encargado' },
    });

  assert.equal(resolucion.datos.fichaje.tipo_registro, 'original');
  assert.equal(resolucion.datos.fichaje.origen, 'panel');
  assert.ok(resolucion.datos.fichaje.motivo, 'un alta manual sin motivo no debe existir');
});

test('una gestoría no puede entrar en una empresa que no es suya', async () => {
  const { db, env } = prepararEntorno();
  const cookieGestoria = await sesionDeGestoria(env, db);

  db.exec(`INSERT INTO gestorias (id, nombre) VALUES ('ges_2','Otra gestoría')`);
  db.exec(`INSERT INTO empresas (id, gestoria_id, nombre, codigo, zona_horaria)
           VALUES ('emc_ajena','ges_2','Ajena S.L.','AJENA','Europe/Madrid')`);

  const { estado } = await llamar(env, 'GET', '/api/empleados?empresa=emc_ajena', {
    cookie: cookieGestoria,
  });
  assert.equal(estado, 403);
});

test('un trabajador no puede ver los fichajes de un compañero', async () => {
  const { db, env } = prepararEntorno();
  const cookieGestoria = await sesionDeGestoria(env, db);

  const alta = await llamar(env, 'POST', '/api/gestoria/empresas', {
    cookie: cookieGestoria, cuerpo: { nombre: 'Empresa', codigo: 'EMPRESA1' },
  });
  const empresaId = alta.datos.empresa.id;

  const uno = await llamar(env, 'POST', `/api/empleados?empresa=${empresaId}`, {
    cookie: cookieGestoria, cuerpo: { nombre: 'Ana', pin: '111111' },
  });
  const otro = await llamar(env, 'POST', `/api/empleados?empresa=${empresaId}`, {
    cookie: cookieGestoria, cuerpo: { nombre: 'Luis', pin: '222222' },
  });

  const sesion = await llamar(env, 'POST', '/api/auth/pin', {
    cuerpo: { codigo: 'EMPRESA1', empleado_id: uno.datos.empleado.id, pin: '111111' },
  });
  const cookie = extraerCookie(sesion.cabeceras);

  const propio = await llamar(env, 'GET', `/api/fichajes/empleado/${uno.datos.empleado.id}`, { cookie });
  assert.equal(propio.estado, 200);

  const ajeno = await llamar(env, 'GET', `/api/fichajes/empleado/${otro.datos.empleado.id}`, { cookie });
  assert.equal(ajeno.estado, 403);

  // Tampoco la rejilla de toda la plantilla, que es vista de panel.
  const rejilla = await llamar(env, 'GET', '/api/fichajes/rejilla', { cookie });
  assert.equal(rejilla.estado, 403);
});

test('el acceso de inspección es de sólo lectura y alcanza sólo a su empresa', async () => {
  const { db, env } = prepararEntorno();
  const cookieGestoria = await sesionDeGestoria(env, db);

  const alta = await llamar(env, 'POST', '/api/gestoria/empresas', {
    cookie: cookieGestoria, cuerpo: { nombre: 'Empresa', codigo: 'EMPRESA1' },
  });
  const empresaId = alta.datos.empresa.id;

  const acceso = await llamar(env, 'POST', `/api/inspeccion/acceso?empresa=${empresaId}`, {
    cookie: cookieGestoria, cuerpo: { referencia: 'ITSS-2026-0001', dias: 30 },
  });
  assert.equal(acceso.estado, 201);
  const token = acceso.datos.token;

  const conToken = async (metodo, ruta, cuerpo = null) => {
    const cabeceras = { authorization: `Inspeccion ${token}` };
    if (cuerpo) cabeceras['content-type'] = 'application/json';
    const respuesta = await worker.fetch(
      new Request(`${BASE}${ruta}`, {
        method: metodo, headers: cabeceras,
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      }), env, { waitUntil: () => {} });
    return { estado: respuesta.status };
  };

  assert.equal((await conToken('GET', '/api/inspeccion/empresa')).estado, 200);
  assert.equal((await conToken('GET', '/api/empleados')).estado, 200);
  assert.equal((await conToken('GET', '/api/informes/integridad')).estado, 200);

  // Escribir, no.
  assert.equal((await conToken('POST', '/api/empleados', { nombre: 'Intruso', pin: '999999' })).estado, 403);
  assert.equal((await conToken('PATCH', '/api/empresa', { nombre: 'Cambiada' })).estado, 403);

  // Y una vez revocado, ni leer.
  db.prepare(`UPDATE accesos_inspeccion SET revocado_en = '2026-01-01T00:00:00Z'`).run();
  assert.equal((await conToken('GET', '/api/inspeccion/empresa')).estado, 401);
});

test('sin secreto de sesión configurado, el servicio se declara mal configurado', async () => {
  const { env } = prepararEntorno();
  delete env.SECRETO_SESION;
  const { estado } = await llamar(env, 'GET', '/api/salud');
  assert.equal(estado, 503);
});

test('una ruta inexistente devuelve 404 con mensaje claro', async () => {
  const { env } = prepararEntorno();
  const { estado, datos } = await llamar(env, 'GET', '/api/no-existe');
  assert.equal(estado, 404);
  assert.match(datos.error, /Ruta no encontrada/);
});

// --- Modo demostración -----------------------------------------------------

/**
 * El modo demo es el atajo para dar a alguien una URL pública sin tener un
 * correo real conectado: el enlace mágico vuelve en la propia respuesta. Por
 * defecto debe estar apagado, porque anula la comprobación de que quien pide
 * el enlace es el dueño del correo.
 */
test('el modo demo está apagado por defecto', async () => {
  const { env } = prepararEntorno();
  const { datos } = await llamar(env, 'GET', '/api/auth/modo');
  assert.equal(datos.demo, false);
});

test('sin modo demo, pedir el enlace no lo revela y responde igual exista o no la cuenta', async () => {
  const { db, env } = prepararEntorno();
  db.exec(`INSERT INTO gestorias (id, nombre) VALUES ('ges_1','Gestoría Ejemplo')`);
  db.exec(`INSERT INTO usuarios (id, email, nombre, rol, gestoria_id)
           VALUES ('usu_g','gestor@ejemplo.es','Gestor','gestoria','ges_1')`);

  const conCuenta = await llamar(env, 'POST', '/api/auth/enlace', {
    cuerpo: { email: 'gestor@ejemplo.es' },
  });
  const sinCuenta = await llamar(env, 'POST', '/api/auth/enlace', {
    cuerpo: { email: 'no-existe@nada.es' },
  });

  assert.equal(conCuenta.estado, 200);
  assert.equal(sinCuenta.estado, 200);
  assert.deepEqual(conCuenta.datos, sinCuenta.datos, 'la respuesta no debe distinguir si la cuenta existe');
  assert.equal(conCuenta.datos.enlace, undefined, 'el enlace nunca debe salir por la API fuera del modo demo');
});

test('con modo demo, el enlace vuelve en la respuesta y se puede canjear', async () => {
  const { db, env } = prepararEntorno();
  env.MODO_DEMO_ENLACE = '1';
  db.exec(`INSERT INTO gestorias (id, nombre) VALUES ('ges_1','Gestoría Ejemplo')`);
  db.exec(`INSERT INTO usuarios (id, email, nombre, rol, gestoria_id)
           VALUES ('usu_g','gestor@ejemplo.es','Gestor','gestoria','ges_1')`);

  const modo = await llamar(env, 'GET', '/api/auth/modo');
  assert.equal(modo.datos.demo, true);

  const { estado, datos } = await llamar(env, 'POST', '/api/auth/enlace', {
    cuerpo: { email: 'gestor@ejemplo.es' },
  });
  assert.equal(estado, 200);
  assert.equal(datos.demo, true);
  assert.match(datos.enlace, /\/api\/auth\/entrar\?token=/);

  // El enlace generado funciona de verdad: canjearlo deja la sesión puesta.
  const url = new URL(datos.enlace);
  const canje = await llamar(env, 'GET', `${url.pathname}${url.search}`);
  assert.equal(canje.estado, 302);
  assert.equal(canje.respuesta.headers.get('location'), '/gestoria/');
  assert.ok(canje.respuesta.headers.get('set-cookie'));
});

test('con modo demo, un correo no dado de alta se rechaza con un mensaje claro', async () => {
  const { env } = prepararEntorno();
  env.MODO_DEMO_ENLACE = '1';

  const { estado, datos } = await llamar(env, 'POST', '/api/auth/enlace', {
    cuerpo: { email: 'no-existe@nada.es' },
  });
  assert.equal(estado, 404);
  assert.match(datos.error, /no está dado de alta/);
  assert.equal(datos.enlace, undefined);
});
