/**
 * Panel de empresa.
 *
 * Lo abre gente que entra aquí una vez al mes, así que cada pantalla dice qué
 * hace y ninguna acción destructiva ocurre sin motivo escrito. La misma
 * pantalla la usa la gestoría cuando entra en una de sus empresas: por eso
 * todo pasa por la empresa activa de api.js.
 */
import {
  api, horasYMinutos, fechaLegible, NOMBRE_TIPO, NOMBRE_ESTADO,
  escapar, avisar, descargar, fijarEmpresaActiva, obtenerEmpresaActiva,
} from './api.js';

const $ = (id) => document.getElementById(id);
const estado = { yo: null, empresa: null, vista: 'presentes' };

arrancar();

async function arrancar() {
  // La gestoría llega con ?empresa=... desde su panel; la empresa, sin nada.
  const url = new URL(location.href);
  if (url.searchParams.get('empresa')) {
    fijarEmpresaActiva(url.searchParams.get('empresa'));
    history.replaceState(null, '', location.pathname);
  }

  estado.yo = await api('/api/auth/yo', { destinoEntrada: '/entrar/' });
  if (estado.yo.actor_tipo === 'empleado') { location.href = '/'; return; }
  if (estado.yo.actor_tipo === 'empresa') fijarEmpresaActiva(estado.yo.empresa.id);
  if (estado.yo.actor_tipo === 'gestoria' && !obtenerEmpresaActiva()) {
    location.href = '/gestoria/';
    return;
  }

  const resumen = await api('/api/empresa/resumen');
  estado.empresa = resumen.empresa;
  $('marca').textContent = estado.yo.actor_tipo === 'gestoria'
    ? `${estado.empresa.nombre} · vista de gestoría`
    : estado.empresa.nombre;

  const ahora = new Date();
  $('r-mes').value = ahora.toISOString().slice(0, 7);
  $('c-anio').value = ahora.getUTCFullYear();
  $('p-anio').value = ahora.getUTCFullYear();
  $('p-indice').value = ahora.getUTCMonth() + 1;

  pintarResumen(resumen);
  cargarPresentes();
}

for (const boton of document.querySelectorAll('.barra nav button')) {
  boton.addEventListener('click', () => cambiarVista(boton.dataset.vista));
}

$('salir').addEventListener('click', async () => {
  await api('/api/auth/salir', { metodo: 'POST', silencioso: true }).catch(() => {});
  fijarEmpresaActiva(null);
  location.href = '/entrar/';
});

function cambiarVista(vista) {
  estado.vista = vista;
  for (const boton of document.querySelectorAll('.barra nav button')) {
    if (boton.dataset.vista === vista) boton.setAttribute('aria-current', 'page');
    else boton.removeAttribute('aria-current');
  }
  for (const nombre of ['presentes', 'plantilla', 'calendario', 'rejilla',
    'bandeja', 'incidencias', 'informes', 'ajustes']) {
    $(`vista-${nombre}`).hidden = nombre !== vista;
  }
  ({
    presentes: cargarPresentes,
    plantilla: cargarPlantilla,
    calendario: cargarCalendario,
    rejilla: cargarRejilla,
    bandeja: cargarBandeja,
    incidencias: cargarIncidencias,
    informes: () => {},
    ajustes: cargarAjustes,
  })[vista]?.();
}

// --- Ahora mismo ----------------------------------------------------------

function pintarResumen(resumen) {
  $('tarjetas-resumen').innerHTML = [
    ['Plantilla', resumen.plantilla, ''],
    ['Incidencias abiertas', resumen.incidencias_abiertas, resumen.incidencias_abiertas ? 'ambar' : 'verde'],
    ['Ausencias por resolver', resumen.ausencias_pendientes, resumen.ausencias_pendientes ? 'rojo' : 'verde'],
    ['Correcciones por resolver', resumen.correcciones_pendientes, resumen.correcciones_pendientes ? 'rojo' : 'verde'],
  ].map(([titulo, valor, clase]) => `
    <div class="tarjeta">
      <p class="ayuda" style="margin:0">${titulo}</p>
      <p style="font-size:2rem;font-weight:700;margin:.2rem 0 0" class="${clase ? `texto-${clase}` : ''}">${valor}</p>
    </div>`).join('');

  const pendientes = resumen.ausencias_pendientes + resumen.correcciones_pendientes;
  marcarContador('contador-bandeja', pendientes);
  marcarContador('contador-incidencias', resumen.incidencias_abiertas);
}

function marcarContador(id, valor) {
  const elemento = $(id);
  elemento.textContent = valor;
  elemento.classList.toggle('oculto', !valor);
}

async function cargarPresentes() {
  const datos = await api('/api/fichajes/presentes');
  const dentro = datos.empleados.filter((e) => e.estado !== 'fuera');
  $('tabla-presentes').innerHTML = datos.empleados.length ? `
    <p class="ayuda">${dentro.length} de ${datos.empleados.length} en jornada · ${escapar(fechaLegible(datos.fecha))}</p>
    <div class="tabla-envoltorio"><table>
      <thead><tr><th></th><th>Trabajador</th><th>Estado</th><th>Desde</th><th class="numero">Hoy</th></tr></thead>
      <tbody>${datos.empleados.map((e) => `
        <tr>
          <td><span class="punto ${e.estado === 'dentro' ? 'verde' : e.estado === 'en_pausa' ? 'ambar' : ''}"
              style="${e.estado === 'fuera' ? 'background:var(--borde)' : ''}"></span></td>
          <td>${escapar(`${e.nombre} ${e.apellidos}`.trim())}</td>
          <td>${NOMBRE_ESTADO[e.estado]}</td>
          <td>${e.desde ? escapar(e.desde) : '—'}</td>
          <td class="numero">${horasYMinutos(e.minutos_hoy)}</td>
        </tr>`).join('')}</tbody>
    </table></div>`
    : '<p class="vacio">Todavía no hay trabajadores dados de alta.</p>';
}

// --- Plantilla ------------------------------------------------------------

async function cargarPlantilla() {
  const datos = await api('/api/empleados?incluir_bajas=1');
  $('tabla-empleados').innerHTML = datos.empleados.length ? `
    <div class="tabla-envoltorio"><table>
      <thead><tr><th>Trabajador</th><th>Identificador</th><th>Documento</th><th>Jornada</th><th class="numero">Vacaciones</th><th>Estado</th><th></th></tr></thead>
      <tbody>${datos.empleados.map((e) => `
        <tr>
          <td>${escapar(`${e.nombre} ${e.apellidos}`.trim())}</td>
          <td><code>${escapar(e.identificador)}</code>${e.tiene_pin ? '' : ' <span class="etiqueta ambar">sin PIN</span>'}</td>
          <td>${escapar(e.documento_identidad ?? '—')}</td>
          <td>${escapar(e.tipo_jornada)}</td>
          <td class="numero">${e.dias_vacaciones_anuales}</td>
          <td>${e.activo
            ? '<span class="etiqueta verde">activo</span>'
            : `<span class="etiqueta">baja ${escapar(e.fecha_baja ?? '')}</span>`}</td>
          <td style="white-space:nowrap">
            <button class="secundario pequeno" data-horario="${escapar(e.id)}">Horario</button>
            <button class="secundario pequeno" data-pin="${escapar(e.id)}">Reponer PIN</button>
            ${e.activo ? `<button class="secundario pequeno" data-baja="${escapar(e.id)}">Baja</button>` : ''}
          </td>
        </tr>`).join('')}</tbody>
    </table></div>`
    : '<p class="vacio">Sin trabajadores todavía.</p>';

  enlazar('[data-horario]', 'horario', editarHorario);
  enlazar('[data-pin]', 'pin', cambiarPin);
  enlazar('[data-baja]', 'baja', darDeBaja);
}

function enlazar(selector, atributo, accion) {
  for (const boton of document.querySelectorAll(selector)) {
    boton.addEventListener('click', () => accion(boton.dataset[atributo]));
  }
}

$('form-empleado').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  try {
    const datos = await api('/api/empleados', {
      metodo: 'POST',
      cuerpo: {
        nombre: $('e-nombre').value.trim(),
        apellidos: $('e-apellidos').value.trim(),
        documento_identidad: $('e-documento').value.trim() || null,
        pin: $('e-pin').value,
        tipo_jornada: $('e-jornada').value,
        dias_vacaciones_anuales: Number($('e-vacaciones').value),
      },
    });
    $('form-empleado').reset();
    $('e-vacaciones').value = 22;
    avisar($('aviso'),
      `Trabajador dado de alta con el identificador ${datos.empleado.identificador}. `
      + 'Déselo junto con su PIN; tendrá que cambiarlo al entrar.', 'exito');
    cargarPlantilla();
  } catch (error) {
    avisar($('aviso'), error.message, 'error');
  }
});

/**
 * El horario es semanal y fijo, con horas distintas por día si hace falta.
 * Al guardar no se reescribe el anterior: se le pone fecha de fin y entra uno
 * nuevo, para que los informes de meses pasados sigan cuadrando.
 */
async function editarHorario(empleadoId) {
  const actual = await api(`/api/empleados/${empleadoId}/horario`);
  const nombres = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const dias = [];

  for (let dia = 1; dia <= 7; dia++) {
    const vigente = actual.vigente.find((h) => h.dia_semana === dia);
    const valor = prompt(
      `Horario de ${nombres[dia - 1]} en formato "HH:MM-HH:MM".\n`
      + 'Deje vacío si ese día no se trabaja.',
      vigente ? `${vigente.hora_entrada}-${vigente.hora_salida}` : '',
    );
    if (valor === null) return;
    const limpio = valor.trim();
    if (!limpio) continue;
    const coincidencia = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(limpio);
    if (!coincidencia) { alert(`No entiendo «${limpio}». Use HH:MM-HH:MM.`); return; }
    dias.push({ dia_semana: dia, hora_entrada: coincidencia[1], hora_salida: coincidencia[2] });
  }

  const desde = prompt('¿Desde qué fecha rige este horario? (AAAA-MM-DD)',
    new Date().toISOString().slice(0, 10));
  if (!desde) return;

  await api(`/api/empleados/${empleadoId}/horario`, {
    metodo: 'PUT',
    cuerpo: { vigente_desde: desde, dias },
  });
  avisar($('aviso'), `Horario guardado con vigencia desde ${desde}.`, 'exito');
}

/**
 * Repone el PIN de un trabajador. Es la mitad de abajo de la cadena que
 * sustituye al «he olvidado mi contraseña» por correo: la gestoría repone la
 * contraseña de sus empresas, y la empresa el PIN de sus trabajadores.
 */
async function cambiarPin(empleadoId) {
  const sugerido = String(Math.floor(100000 + Math.random() * 900000));
  const pin = prompt(
    'PIN nuevo de seis cifras.\n\n'
    + 'Anótelo: no se puede volver a consultar. El trabajador tendrá que '
    + 'cambiarlo la primera vez que entre.',
    sugerido,
  );
  if (!pin) return;
  try {
    await api(`/api/empleados/${empleadoId}`, { metodo: 'PATCH', cuerpo: { pin } });
    avisar($('aviso'),
      `PIN repuesto: ${pin}. El trabajador deberá cambiarlo al entrar.`, 'exito');
    cargarPlantilla();
  } catch (error) {
    avisar($('aviso'), error.message, 'error');
  }
}

async function darDeBaja(empleadoId) {
  const fecha = prompt('Fecha de baja (AAAA-MM-DD)', new Date().toISOString().slice(0, 10));
  if (!fecha) return;
  await api(`/api/empleados/${empleadoId}/baja`, { metodo: 'POST', cuerpo: { fecha_baja: fecha } });
  avisar($('aviso'),
    'Trabajador dado de baja. Sus registros se conservan cuatro años, como exige la norma.',
    'exito');
  cargarPlantilla();
}

// --- Calendario -----------------------------------------------------------

$('c-anio').addEventListener('change', cargarCalendario);

async function cargarCalendario() {
  const anio = $('c-anio').value || new Date().getUTCFullYear();
  const datos = await api(`/api/calendario?anio=${anio}`);
  $('tabla-calendario').innerHTML = datos.dias.length ? `
    <div class="tabla-envoltorio"><table>
      <thead><tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th></th></tr></thead>
      <tbody>${datos.dias.map((d) => `
        <tr>
          <td>${escapar(fechaLegible(d.fecha))}</td>
          <td>${escapar(d.tipo.replace(/_/g, ' '))}</td>
          <td>${escapar(d.descripcion ?? '')}</td>
          <td><button class="secundario pequeno" data-borrar="${escapar(d.fecha)}">Quitar</button></td>
        </tr>`).join('')}</tbody>
    </table></div>`
    : `<p class="vacio">Sin festivos marcados para ${anio}.</p>`;

  enlazar('[data-borrar]', 'borrar', async (fecha) => {
    await api(`/api/calendario/${fecha}`, { metodo: 'DELETE' });
    cargarCalendario();
  });
}

$('form-calendario').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  try {
    await api('/api/calendario', {
      metodo: 'POST',
      cuerpo: {
        fecha: $('c-fecha').value,
        tipo: $('c-tipo').value,
        descripcion: $('c-descripcion').value.trim() || null,
      },
    });
    $('c-descripcion').value = '';
    cargarCalendario();
  } catch (error) {
    avisar($('aviso'), error.message, 'error');
  }
});

// --- Rejilla de fichajes --------------------------------------------------

$('r-mes').addEventListener('change', cargarRejilla);
$('r-pdf').addEventListener('click', () => exportarMes('pdf'));
$('r-csv').addEventListener('click', () => exportarMes('csv'));
$('r-verificar').addEventListener('click', verificarIntegridad);

function mesSeleccionado() {
  const [anio, mes] = $('r-mes').value.split('-').map(Number);
  const desde = `${$('r-mes').value}-01`;
  const hasta = new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);
  return { anio, mes, desde, hasta };
}

function exportarMes(formato) {
  const { anio, mes } = mesSeleccionado();
  descargar(`/api/exportacion?formato=${formato}&periodo=mes&anio=${anio}&indice=${mes}`);
}

async function verificarIntegridad() {
  const resultado = await api('/api/fichajes/verificar-cadena');
  avisar($('aviso'), resultado.valida
    ? `Cadena verificada: ${resultado.verificados} fichajes encadenados sin alteraciones.`
    : `Cadena rota en el fichaje ${resultado.fichaje_id} (${resultado.motivo}).`,
    resultado.valida ? 'exito' : 'error');
}

async function cargarRejilla() {
  const { desde, hasta } = mesSeleccionado();
  const datos = await api(`/api/fichajes/rejilla?desde=${desde}&hasta=${hasta}`);

  $('contenido-rejilla').innerHTML = datos.empleados.map((e) => {
    const total = e.dias.reduce((suma, d) => suma + d.minutos, 0);
    return `
      <div class="tarjeta">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:.5rem">
          <h2 style="margin:0">${escapar(`${e.nombre} ${e.apellidos}`.trim())}</h2>
          <strong>${horasYMinutos(total)}</strong>
        </div>
        ${e.dias.length ? `
          <div class="tabla-envoltorio"><table>
            <thead><tr><th>Día</th><th>Fichajes</th><th class="numero">Total</th></tr></thead>
            <tbody>${e.dias.map((d) => `
              <tr>
                <td>${escapar(fechaLegible(d.fecha))}</td>
                <td>${d.fichajes.map((f) => `
                  <button class="secundario pequeno" data-fichaje="${escapar(f.id)}"
                          data-fecha="${escapar(d.fecha)}" data-tipo="${escapar(f.tipo)}"
                          data-hora="${escapar(f.hora)}">
                    ${escapar(f.hora)} ${NOMBRE_TIPO[f.tipo].toLowerCase()}${f.diferido ? ' ·dif' : ''}
                  </button>`).join(' ')}
                  <button class="secundario pequeno" data-anadir="${escapar(d.fecha)}"
                          data-empleado="${escapar(e.id)}">+</button>
                </td>
                <td class="numero">${horasYMinutos(d.minutos)}</td>
              </tr>`).join('')}</tbody>
          </table></div>`
        : '<p class="vacio">Sin fichajes este mes.</p>'}
      </div>`;
  }).join('') || '<div class="tarjeta"><p class="vacio">Sin plantilla.</p></div>';

  for (const boton of document.querySelectorAll('[data-fichaje]')) {
    boton.addEventListener('click', () => corregirFichaje(boton.dataset));
  }
  for (const boton of document.querySelectorAll('[data-anadir]')) {
    boton.addEventListener('click', () => altaManual(boton.dataset.empleado, boton.dataset.anadir));
  }
}

/** La corrección exige motivo. El original no se toca: se inserta una rectificación. */
async function corregirFichaje({ fichaje, fecha, tipo, hora }) {
  const accion = prompt(
    `Fichaje del ${fecha} a las ${hora} (${NOMBRE_TIPO[tipo].toLowerCase()}).\n\n`
    + 'Escriba la hora corregida (HH:MM), o la palabra ANULAR para dejarlo sin efecto.',
    hora,
  );
  if (!accion) return;
  const motivo = prompt('Motivo de la corrección (obligatorio, queda registrado)');
  if (!motivo?.trim()) { alert('Sin motivo no se puede corregir.'); return; }

  try {
    if (accion.trim().toUpperCase() === 'ANULAR') {
      await api(`/api/fichajes/${fichaje}/anular`, { metodo: 'POST', cuerpo: { motivo } });
    } else {
      await api(`/api/fichajes/${fichaje}/rectificar`, {
        metodo: 'POST',
        cuerpo: { fecha_local: fecha, hora: accion.trim(), tipo, motivo },
      });
    }
    avisar($('aviso'), 'Corrección registrada. El fichaje original sigue en la traza.', 'exito');
    cargarRejilla();
  } catch (error) {
    avisar($('aviso'), error.message, 'error');
  }
}

async function altaManual(empleadoId, fecha) {
  const tipo = prompt('Tipo: entrada, salida, inicio_pausa o fin_pausa');
  if (!tipo) return;
  const hora = prompt('Hora (HH:MM)');
  if (!hora) return;
  const motivo = prompt('Motivo del alta manual (obligatorio)');
  if (!motivo?.trim()) return;

  try {
    await api('/api/fichajes/alta-manual', {
      metodo: 'POST',
      cuerpo: { empleado_id: empleadoId, fecha_local: fecha, hora, tipo, motivo },
    });
    cargarRejilla();
  } catch (error) {
    avisar($('aviso'), error.message, 'error');
  }
}

// --- Bandeja de solicitudes ----------------------------------------------

async function cargarBandeja() {
  const [correcciones, ausencias, empleados] = await Promise.all([
    api('/api/correcciones?estado=solicitada'),
    api('/api/ausencias?estado=solicitada'),
    api('/api/empleados?incluir_bajas=1'),
  ]);
  const nombre = (id) => {
    const e = empleados.empleados.find((x) => x.id === id);
    return e ? `${e.nombre} ${e.apellidos}`.trim() : id;
  };

  $('tabla-correcciones').innerHTML = correcciones.solicitudes.length ? `
    <div class="tabla-envoltorio"><table>
      <thead><tr><th>Trabajador</th><th>Día</th><th>Propuesta</th><th>Motivo</th><th></th></tr></thead>
      <tbody>${correcciones.solicitudes.map((s) => `
        <tr>
          <td>${escapar(nombre(s.empleado_id))}</td>
          <td>${escapar(fechaLegible(s.fecha_local))}</td>
          <td>${escapar(s.hora_propuesta ?? '—')} ${escapar(s.tipo_propuesto ?? '')}</td>
          <td>${escapar(s.motivo)}</td>
          <td style="white-space:nowrap">
            <button class="pequeno" data-aprobar-c="${escapar(s.id)}">Aprobar</button>
            <button class="secundario pequeno" data-denegar-c="${escapar(s.id)}">Denegar</button>
          </td>
        </tr>`).join('')}</tbody>
    </table></div>`
    : '<p class="vacio">Ninguna corrección pendiente.</p>';

  $('tabla-ausencias').innerHTML = ausencias.ausencias.length ? `
    <div class="tabla-envoltorio"><table>
      <thead><tr><th>Trabajador</th><th>Tipo</th><th>Desde</th><th>Hasta</th><th></th></tr></thead>
      <tbody>${ausencias.ausencias.map((a) => `
        <tr>
          <td>${escapar(nombre(a.empleado_id))}</td>
          <td>${escapar(a.tipo.replace(/_/g, ' '))}</td>
          <td>${escapar(a.fecha_inicio)}</td>
          <td>${escapar(a.fecha_fin)}</td>
          <td style="white-space:nowrap">
            <button class="pequeno" data-aprobar-a="${escapar(a.id)}">Aprobar</button>
            <button class="secundario pequeno" data-denegar-a="${escapar(a.id)}">Denegar</button>
          </td>
        </tr>`).join('')}</tbody>
    </table></div>`
    : '<p class="vacio">Ninguna ausencia pendiente.</p>';

  enlazar('[data-aprobar-c]', 'aprobarC', (id) => resolverCorreccion(id, 'aprobar'));
  enlazar('[data-denegar-c]', 'denegarC', (id) => resolverCorreccion(id, 'denegar'));
  enlazar('[data-aprobar-a]', 'aprobarA', (id) => resolverAusencia(id, 'aprobar'));
  enlazar('[data-denegar-a]', 'denegarA', (id) => resolverAusencia(id, 'denegar'));
}

async function resolverCorreccion(id, decision) {
  const cuerpo = { decision };
  if (decision === 'aprobar') {
    const hora = prompt('Hora que queda registrada (HH:MM)');
    if (!hora) return;
    const tipo = prompt('Tipo: entrada, salida, inicio_pausa o fin_pausa');
    if (!tipo) return;
    cuerpo.hora = hora;
    cuerpo.tipo = tipo;
    cuerpo.motivo = prompt('Motivo que queda en la traza') ?? 'Corrección aprobada';
  }
  try {
    await api(`/api/correcciones/${id}/resolver`, { metodo: 'POST', cuerpo });
    cargarBandeja();
  } catch (error) {
    avisar($('aviso'), error.message, 'error');
  }
}

async function resolverAusencia(id, decision) {
  await api(`/api/ausencias/${id}/resolver`, { metodo: 'POST', cuerpo: { decision } });
  cargarBandeja();
}

// --- Incidencias ----------------------------------------------------------

$('i-estado').addEventListener('change', cargarIncidencias);
$('i-revisar').addEventListener('click', async () => {
  const fecha = prompt('¿Qué día quiere revisar? (AAAA-MM-DD)',
    new Date().toISOString().slice(0, 10));
  if (!fecha) return;
  const resultado = await api('/api/incidencias/revisar', { metodo: 'POST', cuerpo: { fecha } });
  avisar($('aviso'), `Revisión del ${fecha}: ${resultado.nuevas} incidencias nuevas.`, 'exito');
  cargarIncidencias();
});

async function cargarIncidencias() {
  const datos = await api(`/api/incidencias?estado=${$('i-estado').value}`);
  $('tabla-incidencias').innerHTML = datos.incidencias.length ? `
    <div class="tarjeta"><div class="tabla-envoltorio"><table>
      <thead><tr><th>Día</th><th>Trabajador</th><th>Incidencia</th><th>Familia</th><th></th></tr></thead>
      <tbody>${datos.incidencias.map((i) => `
        <tr>
          <td>${escapar(fechaLegible(i.fecha))}</td>
          <td>${escapar(i.empleado ?? '')}</td>
          <td>${escapar(i.descripcion)}${i.detalle ? `<br><span class="ayuda">${escapar(i.detalle)}</span>` : ''}</td>
          <td><span class="etiqueta ${i.familia === 'estructural' ? 'rojo' : 'ambar'}">${escapar(i.familia)}</span></td>
          <td style="white-space:nowrap">
            ${i.estado === 'abierta' ? `
              <button class="pequeno" data-resolver="${escapar(i.id)}">Resuelta</button>
              <button class="secundario pequeno" data-ignorar="${escapar(i.id)}">Ignorar</button>`
              : `<span class="etiqueta">${escapar(i.estado)}</span>`}
          </td>
        </tr>`).join('')}</tbody>
    </table></div></div>`
    : '<div class="tarjeta"><p class="vacio">Ninguna incidencia con ese filtro.</p></div>';

  enlazar('[data-resolver]', 'resolver', (id) => marcarIncidencia(id, 'resuelta'));
  enlazar('[data-ignorar]', 'ignorar', (id) => marcarIncidencia(id, 'ignorada'));
}

async function marcarIncidencia(id, nuevoEstado) {
  await api(`/api/incidencias/${id}/estado`, { metodo: 'POST', cuerpo: { estado: nuevoEstado } });
  cargarIncidencias();
}

// --- Informes -------------------------------------------------------------

$('p-ver').addEventListener('click', verInforme);
$('p-pdf').addEventListener('click', () => descargar(`/api/exportacion?formato=pdf&${parametrosPeriodo()}`));
$('p-csv').addEventListener('click', () => descargar(`/api/exportacion?formato=csv&${parametrosPeriodo()}`));

function parametrosPeriodo() {
  return `periodo=${$('p-periodo').value}&anio=${$('p-anio').value}&indice=${$('p-indice').value}`;
}

async function verInforme() {
  const informe = await api(`/api/informes?${parametrosPeriodo()}`);
  $('contenido-informe').innerHTML = `
    <div class="tarjeta">
      <h2>${escapar(informe.etiqueta_periodo)}</h2>
      ${informe.periodo.en_curso ? `<p class="ayuda">
        Periodo en curso: las horas teóricas están calculadas hasta el
        ${escapar(informe.periodo.teoricas_hasta)}, no hasta el final del periodo.
      </p>` : ''}
      <div class="tabla-envoltorio"><table>
        <thead><tr>
          <th>Trabajador</th><th class="numero">Registradas</th><th class="numero">Teóricas</th>
          <th class="numero">${escapar(informe.etiqueta_diferencia)}</th>
          <th class="numero">Días</th><th class="numero">Ausencias</th><th class="numero">Incid.</th>
        </tr></thead>
        <tbody>
          ${informe.empleados.map((e) => `
            <tr>
              <td>${escapar(e.nombre)}</td>
              <td class="numero">${horasYMinutos(e.minutos_registrados)}</td>
              <td class="numero">${horasYMinutos(e.minutos_teoricos)}</td>
              <td class="numero">${horasYMinutos(e.minutos_exceso)}</td>
              <td class="numero">${e.dias_trabajados}</td>
              <td class="numero">${e.total_dias_ausencia}</td>
              <td class="numero">${e.total_incidencias}</td>
            </tr>`).join('')}
          <tr class="total">
            <td>Total</td>
            <td class="numero">${horasYMinutos(informe.totales.minutos_registrados)}</td>
            <td class="numero">${horasYMinutos(informe.totales.minutos_teoricos)}</td>
            <td class="numero">${horasYMinutos(informe.totales.minutos_exceso)}</td>
            <td class="numero">${informe.totales.dias_trabajados}</td>
            <td class="numero">${informe.totales.total_dias_ausencia}</td>
            <td class="numero">${informe.totales.total_incidencias}</td>
          </tr>
        </tbody>
      </table></div>
      <p class="ayuda">
        La diferencia entre horas registradas y teóricas se expresa como
        <strong>exceso sobre jornada teórica</strong>. Si esas horas son extraordinarias,
        complementarias o compensación por flexibilidad depende del convenio y del
        contrato, y lo califica la gestoría.
      </p>
    </div>`;
}

// --- Ajustes --------------------------------------------------------------

async function cargarAjustes() {
  const resumen = await api('/api/empresa/resumen');
  estado.empresa = resumen.empresa;
  $('a-tolerancia').value = estado.empresa.tolerancia_minutos;
  $('a-jornada').value = estado.empresa.jornada_maxima_alerta_horas;
  $('a-avisos').value = estado.empresa.avisos_modo;
  $('a-email').value = estado.empresa.avisos_email ?? '';
  $('g-activa').checked = Boolean(estado.empresa.geolocalizacion_activa);
  cargarAccesosInspeccion();
}

$('form-ajustes').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  try {
    await api('/api/empresa', {
      metodo: 'PATCH',
      cuerpo: {
        tolerancia_minutos: Number($('a-tolerancia').value),
        jornada_maxima_alerta_horas: Number($('a-jornada').value),
        avisos_modo: $('a-avisos').value,
        avisos_email: $('a-email').value.trim() || null,
      },
    });
    avisar($('aviso'), 'Ajustes guardados.', 'exito');
  } catch (error) {
    avisar($('aviso'), error.message, 'error');
  }
});

$('form-geo').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  try {
    await api('/api/empresa', {
      metodo: 'PATCH',
      cuerpo: {
        geolocalizacion_activa: $('g-activa').checked,
        geolocalizacion_motivo: $('g-motivo').value.trim(),
      },
    });
    avisar($('aviso'), 'Guardado.', 'exito');
  } catch (error) {
    avisar($('aviso'), error.message, 'error');
  }
});

$('form-inspeccion').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const datos = await api('/api/inspeccion/acceso', {
    metodo: 'POST',
    cuerpo: { referencia: $('in-referencia').value.trim() || null, dias: Number($('in-dias').value) },
  });
  $('token-inspeccion').innerHTML = `
    <div class="aviso pendiente" style="margin-top:1rem">
      <p style="margin:0 0 .5rem"><strong>${escapar(datos.aviso)}</strong></p>
      <code style="word-break:break-all;font-size:.875rem">${escapar(datos.token)}</code>
      <p class="ayuda" style="margin:.5rem 0 0">Caduca el ${escapar(datos.caduca_en.slice(0, 10))}.</p>
    </div>`;
  cargarAccesosInspeccion();
});

async function cargarAccesosInspeccion() {
  const datos = await api('/api/inspeccion/accesos');
  $('tabla-inspeccion').innerHTML = datos.accesos.length ? `
    <div class="tabla-envoltorio"><table>
      <thead><tr><th>Referencia</th><th>Creado</th><th>Caduca</th><th>Estado</th><th></th></tr></thead>
      <tbody>${datos.accesos.map((a) => `
        <tr>
          <td>${escapar(a.referencia ?? '—')}</td>
          <td>${escapar(a.creado_en.slice(0, 10))}</td>
          <td>${escapar(a.expira_en.slice(0, 10))}</td>
          <td>${a.vigente ? '<span class="etiqueta verde">vigente</span>' : '<span class="etiqueta">caducado</span>'}</td>
          <td>${a.vigente ? `<button class="secundario pequeno" data-revocar="${escapar(a.id)}">Revocar</button>` : ''}</td>
        </tr>`).join('')}</tbody>
    </table></div>`
    : '<p class="vacio">Ningún acceso de inspección generado.</p>';

  enlazar('[data-revocar]', 'revocar', async (id) => {
    await api(`/api/inspeccion/accesos/${id}/revocar`, { metodo: 'POST' });
    cargarAccesosInspeccion();
  });
}
