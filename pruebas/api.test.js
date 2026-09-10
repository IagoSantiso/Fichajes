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
import { entornoDePrueba, sembrar } from './ayudas/d1.js';
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

  // 3. El alta le da su identificador de acceso, y con él entra.
  const identificador = trabajador.datos.empleado.identificador;
  assert.match(identificador, /^\d{6}$/);

  const malPin = await llamar(env, 'POST', '/api/auth/trabajador', {
    cuerpo: { identificador, pin: '000000' },
  });
  assert.equal(malPin.estado, 401);

  const entrada = await llamar(env, 'POST', '/api/auth/trabajador', {
    cuerpo: { identificador, pin: '482915' },
  });
  assert.equal(entrada.estado, 200);
  // El PIN lo repartió la empresa, así que hay que cambiarlo al entrar.
  assert.equal(entrada.datos.debe_cambiar_pin, true);
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

  const sesion = await llamar(env, 'POST', '/api/auth/trabajador', {
    cuerpo: { identificador: trabajador.datos.empleado.identificador, pin: '111111' },
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

  const sesion = await llamar(env, 'POST', '/api/auth/trabajador', {
    cuerpo: { identificador: uno.datos.empleado.identificador, pin: '111111' },
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

// --- Acceso ----------------------------------------------------------------

/** Da de alta un usuario de panel con contraseña conocida. */
async function sembrarUsuarioPanel(db, { email, password, debeCambiar = 0 }) {
  const { hashearPassword } = await import('../src/lib/auth.js');
  db.prepare(
    `INSERT INTO usuarios (id, email, nombre, rol, gestoria_id, activo,
                           password_hash, debe_cambiar_password)
     VALUES ('usu_g',?,'Gestor','gestoria','ges_1',1,?,?)`,
  ).run(email, await hashearPassword(password), debeCambiar);
}

/** Da de alta el PIN del empleado de la semilla de pruebas. */
async function sembrarPin(db, pin, debeCambiar = 0) {
  const { hashearPin } = await import('../src/lib/auth.js');
  db.prepare(`UPDATE empleados SET pin_hash = ?, pin_debe_cambiarse = ? WHERE id = 'emp_1'`)
    .run(await hashearPin(pin), debeCambiar);
}

test('el trabajador entra con su identificador y su PIN', async () => {
  const { db, env } = prepararEntorno();
  const { empleado } = sembrar(db);
  await sembrarPin(db, '482915');

  const { estado, datos, cabeceras } = await llamar(env, 'POST', '/api/auth/trabajador', {
    cuerpo: { identificador: empleado.identificador, pin: '482915' },
  });

  assert.equal(estado, 200);
  assert.equal(datos.debe_cambiar_pin, false);
  assert.ok(extraerCookie(cabeceras), 'debe dejar la sesión puesta');
});

test('la respuesta no distingue un identificador inexistente de un PIN incorrecto', async () => {
  const { db, env } = prepararEntorno();
  sembrar(db);
  await sembrarPin(db, '482915');

  const malPin = await llamar(env, 'POST', '/api/auth/trabajador', {
    cuerpo: { identificador: '001001', pin: '000000' },
  });
  const noExiste = await llamar(env, 'POST', '/api/auth/trabajador', {
    cuerpo: { identificador: '999999', pin: '000000' },
  });

  assert.equal(malPin.estado, 401);
  assert.equal(noExiste.estado, 401);
  assert.deepEqual(malPin.datos, noExiste.datos,
    'con identificadores enumerables, distinguirlos sería decir cuáles existen');
});

test('el identificador tiene que ser de seis cifras', async () => {
  const { db, env } = prepararEntorno();
  sembrar(db);

  for (const identificador of ['1001', '00100a', '0010011', '']) {
    const { estado } = await llamar(env, 'POST', '/api/auth/trabajador', {
      cuerpo: { identificador, pin: '482915' },
    });
    assert.equal(estado, 400, `«${identificador}» debería rechazarse`);
  }
});

test('la empresa y la gestoría entran con correo y contraseña', async () => {
  const { db, env } = prepararEntorno();
  db.exec(`INSERT INTO gestorias (id, nombre) VALUES ('ges_1','G')`);
  await sembrarUsuarioPanel(db, { email: 'gestor@ejemplo.es', password: 'fichajes2026' });

  const bien = await llamar(env, 'POST', '/api/auth/panel', {
    cuerpo: { email: 'gestor@ejemplo.es', password: 'fichajes2026' },
  });
  assert.equal(bien.estado, 200);
  assert.equal(bien.datos.rol, 'gestoria');
  assert.equal(bien.datos.destino, '/gestoria/');
  assert.ok(extraerCookie(bien.cabeceras));

  const mal = await llamar(env, 'POST', '/api/auth/panel', {
    cuerpo: { email: 'gestor@ejemplo.es', password: 'otra-cosa' },
  });
  assert.equal(mal.estado, 401);
  assert.equal(extraerCookie(mal.cabeceras), null);
});

test('una clave puesta por otro obliga a cambiarla en el primer acceso', async () => {
  const { db, env } = prepararEntorno();
  sembrar(db);
  await sembrarPin(db, '482915', 1);

  const entrada = await llamar(env, 'POST', '/api/auth/trabajador', {
    cuerpo: { identificador: '001001', pin: '482915' },
  });
  assert.equal(entrada.datos.debe_cambiar_pin, true);

  const cookie = extraerCookie(entrada.cabeceras);
  const cambio = await llamar(env, 'POST', '/api/auth/cambiar-pin', {
    cookie, cuerpo: { pin_actual: '482915', pin_nuevo: '135791' },
  });
  assert.equal(cambio.estado, 200);

  // Ya no lo vuelve a pedir, y el PIN viejo deja de valer.
  const despues = await llamar(env, 'POST', '/api/auth/trabajador', {
    cuerpo: { identificador: '001001', pin: '135791' },
  });
  assert.equal(despues.datos.debe_cambiar_pin, false);

  const viejo = await llamar(env, 'POST', '/api/auth/trabajador', {
    cuerpo: { identificador: '001001', pin: '482915' },
  });
  assert.equal(viejo.estado, 401);
});

test('cambiar la clave exige la actual y que la nueva sea distinta', async () => {
  const { db, env } = prepararEntorno();
  sembrar(db);
  await sembrarPin(db, '482915');

  const entrada = await llamar(env, 'POST', '/api/auth/trabajador', {
    cuerpo: { identificador: '001001', pin: '482915' },
  });
  const cookie = extraerCookie(entrada.cabeceras);

  const sinLaActual = await llamar(env, 'POST', '/api/auth/cambiar-pin', {
    cookie, cuerpo: { pin_actual: '000000', pin_nuevo: '135791' },
  });
  assert.equal(sinLaActual.estado, 401);

  const repetida = await llamar(env, 'POST', '/api/auth/cambiar-pin', {
    cookie, cuerpo: { pin_actual: '482915', pin_nuevo: '482915' },
  });
  assert.equal(repetida.estado, 400);
});

// --- Límite de intentos ----------------------------------------------------

/** Llama pasando una IP concreta, que es lo que usa el cerrojo por IP. */
async function intentar(env, cuerpo, ip) {
  const respuesta = await worker.fetch(
    new Request(`${BASE}/api/auth/trabajador`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify(cuerpo),
    }), env, { waitUntil: () => {} });
  return { estado: respuesta.status, datos: await respuesta.json() };
}

test('cinco fallos bloquean ese identificador diez minutos', async () => {
  const { db, env } = prepararEntorno();
  sembrar(db);
  await sembrarPin(db, '482915');

  for (let i = 0; i < 5; i++) {
    const { estado } = await intentar(env, { identificador: '001001', pin: '000000' }, '203.0.113.1');
    assert.equal(estado, 401, `el intento ${i + 1} debe poder hacerse`);
  }

  const sexto = await intentar(env, { identificador: '001001', pin: '000000' }, '203.0.113.1');
  assert.equal(sexto.estado, 429);
  assert.equal(sexto.datos.codigo, 'demasiados_intentos');

  // Ni siquiera con el PIN bueno: si no, el cerrojo sería un oráculo que
  // distingue el PIN correcto del incorrecto.
  const conElBueno = await intentar(env, { identificador: '001001', pin: '482915' }, '203.0.113.1');
  assert.equal(conElBueno.estado, 429);
});

test('el bloqueo es por identificador, no para toda la empresa', async () => {
  const { db, env } = prepararEntorno();
  sembrar(db);
  await sembrarPin(db, '482915');
  const { hashearPin } = await import('../src/lib/auth.js');
  db.prepare(
    `INSERT INTO empleados (id, empresa_id, numero, nombre, apellidos, pin_hash, activo)
     VALUES ('emp_2','emc_1',2,'Luis','Soto',?,1)`,
  ).run(await hashearPin('112233'));

  for (let i = 0; i < 6; i++) {
    await intentar(env, { identificador: '001001', pin: '000000' }, '203.0.113.2');
  }

  const otro = await intentar(env, { identificador: '001002', pin: '112233' }, '203.0.113.2');
  assert.equal(otro.estado, 200, 'un compañero no debe quedar bloqueado por los fallos de otro');
});

test('el cerrojo por IP frena el barrido de identificadores', async () => {
  const { db, env } = prepararEntorno();
  sembrar(db);
  await sembrarPin(db, '482915');

  // Un mismo PIN contra identificadores distintos: el cerrojo por identificador
  // no lo ve, porque cada uno falla una sola vez.
  let bloqueadoTras = null;
  for (let n = 100; n < 130 && bloqueadoTras === null; n++) {
    const identificador = `001${String(n).padStart(3, '0')}`;
    const { estado } = await intentar(env, { identificador, pin: '123456' }, '198.51.100.1');
    if (estado === 429) bloqueadoTras = n - 100;
  }

  assert.equal(bloqueadoTras, 20, 'debe cortar al vigésimo intento desde la misma IP');

  // Y el corte alcanza también a quien tenga la clave buena desde esa IP.
  const legitimo = await intentar(env, { identificador: '001001', pin: '482915' }, '198.51.100.1');
  assert.equal(legitimo.estado, 429);
});

test('un acceso correcto borra la cuenta de fallos de ese identificador', async () => {
  const { db, env } = prepararEntorno();
  sembrar(db);
  await sembrarPin(db, '482915');

  for (let i = 0; i < 4; i++) {
    await intentar(env, { identificador: '001001', pin: '000000' }, '203.0.113.3');
  }
  const bien = await intentar(env, { identificador: '001001', pin: '482915' }, '203.0.113.3');
  assert.equal(bien.estado, 200);

  // Con la cuenta a cero, vuelve a haber cinco intentos disponibles.
  for (let i = 0; i < 5; i++) {
    const { estado } = await intentar(env, { identificador: '001001', pin: '000000' }, '203.0.113.3');
    assert.equal(estado, 401, `tras acertar debe volver a haber cinco intentos (fallo ${i + 1})`);
  }
});
