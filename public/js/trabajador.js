/**
 * PWA del trabajador.
 *
 * La pantalla de fichaje es un botón grande que cambia de estado y de texto
 * según la situación. Sin menús, sin pasos intermedios, sin formación previa.
 * Todo lo demás de esta aplicación puede esperar; esto no.
 */
import {
  api, ErrorApi, horasYMinutos, fechaLegible, NOMBRE_TIPO, NOMBRE_ESTADO,
  escapar, avisar, descargar,
} from './api.js';
import { encolar, pendientes, sincronizar } from './cola.js';

const $ = (id) => document.getElementById(id);

const estado = {
  yo: null,
  identificador: '',
  pin: '',
  vista: 'fichar',
};

// --- Arranque -------------------------------------------------------------

arrancar();

async function arrancar() {
  registrarServiceWorker();

  try {
    estado.yo = await api('/api/auth/yo', { silencioso: true });
    if (estado.yo.debe_cambiar_pin) { mostrarPaso('paso-cambiar-pin'); return; }
    await entrarEnLaAplicacion();
  } catch {
    mostrarPaso('paso-acceso');
    // El identificador se recuerda; el PIN nunca.
    const recordado = localStorage.getItem('identificador');
    if (recordado) $('identificador').value = recordado;
    pintarPuntosPin();
  }
}

function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((error) => {
    // Sin service worker la aplicación sigue funcionando en línea. No se
    // interrumpe al usuario por esto.
    console.warn('Service worker no registrado:', error);
  });
}

function mostrarPaso(id) {
  for (const paso of ['paso-acceso', 'paso-cambiar-pin']) {
    $(paso).hidden = paso !== id;
  }
  $('app').hidden = true;
}

// --- Acceso ---------------------------------------------------------------

/**
 * Teclado numérico propio: en un móvil con guantes, el del sistema es pequeño
 * y se cierra solo. Éste no. Escribe en el campo que tenga el foco —el
 * identificador o el PIN— para que todo el acceso se haga sin tocar nada más.
 */
(function construirTeclado() {
  const teclado = $('teclado');
  for (const tecla of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '←']) {
    const boton = document.createElement('button');
    boton.textContent = tecla;
    boton.type = 'button';
    if (!tecla) { boton.style.visibility = 'hidden'; boton.disabled = true; }
    boton.addEventListener('click', () => pulsarTecla(tecla));
    teclado.appendChild(boton);
  }
})();

/** El teclado escribe en el identificador hasta completarlo, y luego en el PIN. */
function destinoDelTeclado() {
  return $('identificador').value.trim().length < 6 ? 'identificador' : 'pin';
}

function pulsarTecla(tecla) {
  const campo = $('identificador');
  if (destinoDelTeclado() === 'identificador') {
    if (tecla === '←') campo.value = campo.value.slice(0, -1);
    else if (/^\d$/.test(tecla)) campo.value = (campo.value + tecla).slice(0, 6);
    pintarPuntosPin();
    return;
  }

  if (tecla === '←') {
    // Con el PIN vacío, el borrado vuelve a corregir el identificador.
    if (estado.pin === '') { campo.value = campo.value.slice(0, -1); }
    else estado.pin = estado.pin.slice(0, -1);
  } else if (/^\d$/.test(tecla) && estado.pin.length < 6) {
    estado.pin += tecla;
  }
  pintarPuntosPin();
  if (estado.pin.length === 6) enviarAcceso();
}

function pintarPuntosPin() {
  $('puntos-pin').innerHTML = Array.from({ length: 6 },
    (_, i) => `<span class="${i < estado.pin.length ? 'lleno' : ''}"></span>`).join('');
}

// Teclear con un teclado físico también debe funcionar.
$('identificador').addEventListener('input', () => {
  $('identificador').value = $('identificador').value.replace(/\D/g, '').slice(0, 6);
  pintarPuntosPin();
});

async function enviarAcceso() {
  const identificador = $('identificador').value.trim();
  const pin = estado.pin;
  estado.pin = '';
  pintarPuntosPin();

  try {
    const datos = await api('/api/auth/trabajador', {
      metodo: 'POST',
      silencioso: true,
      cuerpo: { identificador, pin },
    });
    localStorage.setItem('identificador', identificador);
    estado.yo = await api('/api/auth/yo');

    if (datos.debe_cambiar_pin) {
      $('pin-actual').value = pin;
      mostrarPaso('paso-cambiar-pin');
      $('pin-nuevo').focus();
      return;
    }
    await entrarEnLaAplicacion();
  } catch (error) {
    avisar($('aviso-acceso'), error.message, 'error');
  }
}

// --- Cambio obligatorio de PIN --------------------------------------------

$('form-cambiar-pin').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const nuevo = $('pin-nuevo').value.trim();

  if (nuevo !== $('pin-repetido').value.trim()) {
    avisar($('aviso-cambio'), 'Los dos PIN nuevos no coinciden.', 'error');
    return;
  }
  if (!/^\d{6}$/.test(nuevo)) {
    avisar($('aviso-cambio'), 'El PIN son seis cifras.', 'error');
    return;
  }

  try {
    await api('/api/auth/cambiar-pin', {
      metodo: 'POST',
      silencioso: true,
      cuerpo: { pin_actual: $('pin-actual').value.trim(), pin_nuevo: nuevo },
    });
    $('form-cambiar-pin').reset();
    estado.yo = await api('/api/auth/yo');
    await entrarEnLaAplicacion();
  } catch (error) {
    avisar($('aviso-cambio'), error.message, 'error');
  }
});

$('salir').addEventListener('click', async () => {
  await api('/api/auth/salir', { metodo: 'POST', silencioso: true }).catch(() => {});
  location.reload();
});

// --- Aplicación -----------------------------------------------------------

async function entrarEnLaAplicacion() {
  mostrarPaso(null);
  $('app').hidden = false;
  $('marca').textContent = `${estado.yo.nombre} · ${estado.yo.empresa_nombre}`;
  $('mes-fichajes').value = new Date().toISOString().slice(0, 7);

  window.addEventListener('online', () => sincronizarYRefrescar());
  window.addEventListener('cola-sincronizada', () => cargarEstado());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sincronizarYRefrescar();
  });

  await sincronizarYRefrescar();
}

for (const boton of document.querySelectorAll('.barra nav button')) {
  boton.addEventListener('click', () => cambiarVista(boton.dataset.vista));
}

function cambiarVista(vista) {
  estado.vista = vista;
  for (const boton of document.querySelectorAll('.barra nav button')) {
    if (boton.dataset.vista === vista) boton.setAttribute('aria-current', 'page');
    else boton.removeAttribute('aria-current');
  }
  for (const nombre of ['fichar', 'fichajes', 'ausencias', 'incidencias']) {
    $(`vista-${nombre}`).hidden = nombre !== vista;
  }
  if (vista === 'fichajes') cargarMisFichajes();
  if (vista === 'ausencias') cargarAusencias();
  if (vista === 'incidencias') cargarIncidencias();
}

async function sincronizarYRefrescar() {
  if (navigator.onLine) await sincronizar({ silencioso: true }).catch(() => {});
  await cargarEstado();
}

// --- Pantalla de fichaje --------------------------------------------------

async function cargarEstado() {
  await pintarCola();
  try {
    const datos = await api('/api/fichajes/estado', { silencioso: true });
    pintarBoton(datos);
    pintarFichajesDeHoy(datos);
    cargarDiasAnteriores();
  } catch (error) {
    if (error.estado === 401) { location.reload(); return; }
    // Sin red: la aplicación sigue permitiendo fichar contra la cola.
    pintarBotonSinConexion();
  }
}

function pintarBoton(datos) {
  const principal = datos.acciones[0];
  const boton = $('boton-principal');
  const secundario = $('boton-secundario');

  $('estado-actual').innerHTML = `Ahora mismo está <strong>${NOMBRE_ESTADO[datos.estado]}</strong>`
    + (datos.minutos_trabajados ? ` · ${horasYMinutos(datos.minutos_trabajados)} hoy` : '');

  if (!principal) {
    boton.disabled = true;
    $('texto-principal').textContent = 'Jornada cerrada';
    secundario.classList.add('oculto');
    return;
  }

  boton.disabled = false;
  boton.dataset.accion = principal.tipo;
  $('texto-principal').textContent = principal.texto;
  boton.onclick = () => fichar(principal.tipo);

  const otra = datos.acciones[1];
  if (otra) {
    secundario.classList.remove('oculto');
    secundario.textContent = otra.texto;
    secundario.onclick = () => fichar(otra.tipo);
  } else {
    secundario.classList.add('oculto');
  }
}

function pintarBotonSinConexion() {
  const boton = $('boton-principal');
  boton.disabled = false;
  boton.dataset.accion = 'entrada';
  $('estado-actual').textContent = 'Sin conexión. Su fichaje se guardará y se enviará solo.';
  $('texto-principal').textContent = 'Fichar';
  boton.onclick = () => fichar(null);
  $('boton-secundario').classList.add('oculto');
}

/**
 * Ficha. Si hay red, va directo; si no, a la cola. En ambos casos la respuesta
 * en pantalla es inmediata: el trabajador tiene que ver que ha quedado
 * registrado sin esperar a nada.
 */
async function fichar(tipo) {
  const boton = $('boton-principal');
  boton.disabled = true;

  const posicion = estado.yo.geolocalizacion_activa ? await obtenerPosicion() : null;
  const cuerpo = {
    tipo,
    timestamp_declarado: new Date().toISOString(),
    idempotencia: crypto.randomUUID(),
    latitud: posicion?.latitud ?? null,
    longitud: posicion?.longitud ?? null,
  };

  try {
    if (!navigator.onLine) throw new Error('sin conexión');
    const datos = await api('/api/fichajes', { metodo: 'POST', cuerpo, silencioso: true });
    // Respuesta inmediata con lo que devuelve el propio POST; el refresco
    // completo llega detrás sin que el trabajador tenga que esperarlo.
    pintarBoton(datos);
    await cargarEstado();
  } catch (error) {
    if (error instanceof ErrorApi && error.estado >= 400 && error.estado < 500) {
      avisar($('aviso-cola'), error.message, 'error');
      boton.disabled = false;
      await cargarEstado();
      return;
    }
    // Falló la red: a la cola, y se avisa de que está pendiente.
    await encolar({ tipo: tipo ?? 'entrada', latitud: cuerpo.latitud, longitud: cuerpo.longitud });
    await pintarCola();
    boton.disabled = false;
  }
}

function obtenerPosicion() {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolver) => {
    // Una sola lectura, en el instante del fichaje, y nunca en continuo.
    navigator.geolocation.getCurrentPosition(
      (p) => resolver({ latitud: p.coords.latitude, longitud: p.coords.longitude }),
      () => resolver(null),
      { timeout: 5000, maximumAge: 0 },
    );
  });
}

async function pintarCola() {
  const cola = await pendientes().catch(() => []);
  const aviso = $('aviso-cola');
  if (!cola.length) { aviso.hidden = true; return; }
  const plural = cola.length === 1 ? 'fichaje pendiente' : 'fichajes pendientes';
  avisar(aviso, `${cola.length} ${plural} de sincronizar. Se enviarán solos en cuanto haya cobertura.`,
    'pendiente');
}

function pintarFichajesDeHoy(datos) {
  const lista = $('fichajes-hoy');
  if (!datos.fichajes.length) {
    lista.innerHTML = '<li class="vacio">Todavía no ha fichado hoy.</li>';
    return;
  }
  lista.innerHTML = datos.fichajes.map((f) => `
    <li>
      <span class="hora">${escapar(f.hora)}</span>
      <span class="crece">${NOMBRE_TIPO[f.tipo]}</span>
      ${f.diferido ? '<span class="etiqueta ambar">diferido</span>' : ''}
    </li>`).join('');
}

async function cargarDiasAnteriores() {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - 6 * 86400000);
  try {
    const datos = await api(
      `/api/fichajes/empleado/${estado.yo.id}?desde=${desde.toISOString().slice(0, 10)}`
      + `&hasta=${hasta.toISOString().slice(0, 10)}`, { silencioso: true });
    const hoyLocal = new Date().toISOString().slice(0, 10);
    const anteriores = datos.dias.filter((d) => d.fecha !== hoyLocal);
    $('dias-anteriores').innerHTML = anteriores.length
      ? anteriores.reverse().map(pintarDia).join('')
      : '<p class="vacio">Nada registrado en los últimos días.</p>';
  } catch {
    $('dias-anteriores').innerHTML = '<p class="vacio">No se ha podido cargar sin conexión.</p>';
  }
}

function pintarDia(dia) {
  return `
    <div style="padding:.6rem 0;border-bottom:1px solid var(--borde)">
      <div style="display:flex;justify-content:space-between;font-weight:600">
        <span>${escapar(fechaLegible(dia.fecha))}</span>
        <span>${horasYMinutos(dia.minutos)}</span>
      </div>
      <div class="ayuda">${dia.fichajes.map((f) => `${escapar(f.hora)} ${NOMBRE_TIPO[f.tipo].toLowerCase()}`).join(' · ')}</div>
    </div>`;
}

// --- Mis fichajes ---------------------------------------------------------

$('mes-fichajes').addEventListener('change', cargarMisFichajes);
$('descargar-fichajes').addEventListener('click', () => {
  const [anio, mes] = $('mes-fichajes').value.split('-');
  descargar(`/api/exportacion/empleado/${estado.yo.id}?formato=pdf&periodo=mes&anio=${anio}&indice=${Number(mes)}`);
});

async function cargarMisFichajes() {
  const valor = $('mes-fichajes').value;
  if (!valor) return;
  const [anio, mes] = valor.split('-').map(Number);
  const desde = `${valor}-01`;
  const hasta = new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);

  const datos = await api(`/api/fichajes/empleado/${estado.yo.id}?desde=${desde}&hasta=${hasta}`);
  const contenedor = $('detalle-fichajes');

  if (!datos.dias.length) {
    contenedor.innerHTML = '<div class="tarjeta"><p class="vacio">Sin fichajes en este mes.</p></div>';
    return;
  }

  const total = datos.dias.reduce((suma, d) => suma + d.minutos, 0);
  contenedor.innerHTML = `
    <div class="tarjeta">
      <h2>Total del mes: ${horasYMinutos(total)}</h2>
      <div class="tabla-envoltorio">
        <table class="dias">
          <thead><tr><th>Día</th><th>Fichajes</th><th class="numero">Total</th><th></th></tr></thead>
          <tbody>
            ${datos.dias.map((d) => `
              <tr>
                <td class="dia">
                  <span class="fecha">${escapar(fechaLegible(d.fecha))}</span>
                  <span class="total-dia">${horasYMinutos(d.minutos)}</span>
                </td>
                <td class="marcas">${d.fichajes.map((f) => `
                  <button class="secundario pequeno" data-corregir-fichaje="${escapar(f.id)}"
                          data-fecha="${escapar(d.fecha)}" data-hora="${escapar(f.hora)}"
                          data-tipo="${escapar(f.tipo)}"
                          title="Pedir corrección de este fichaje">
                    ${escapar(f.hora)} ${NOMBRE_TIPO[f.tipo].toLowerCase()}
                  </button>`).join(' ') || '<span class="ayuda">sin fichajes</span>'}</td>
                <td class="numero total">${horasYMinutos(d.minutos)}</td>
                <td class="accion"><button class="secundario pequeno" data-falta="${escapar(d.fecha)}">Falta un fichaje</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="ayuda">
        Toque un fichaje para pedir que se corrija, o «falta un fichaje» si ese día
        se dejó alguno sin registrar. Usted solicita la corrección; quien la aplica es
        la empresa o la gestoría, y el fichaje original nunca se borra: queda la traza
        del cambio.
      </p>
    </div>`;

  for (const boton of contenedor.querySelectorAll('[data-corregir-fichaje]')) {
    boton.addEventListener('click', () => corregirFichaje(boton.dataset));
  }
  for (const boton of contenedor.querySelectorAll('[data-falta]')) {
    boton.addEventListener('click', () => pedirFichajeQueFalta(boton.dataset.falta));
  }
}

/**
 * Corrección de un fichaje concreto. Señalar cuál es lo que permite que la
 * empresa lo resuelva como rectificación y no como un alta suelta: así el
 * original y su corrección quedan enlazados en la traza.
 */
async function corregirFichaje({ corregirFichaje: fichajeId, fecha, hora, tipo }) {
  const nueva = prompt(
    `Fichaje del ${fecha} a las ${hora} (${NOMBRE_TIPO[tipo].toLowerCase()}).\n\n`
    + '¿Cuál era la hora correcta? (HH:MM)', hora);
  if (!nueva?.trim()) return;
  const motivo = prompt('¿Qué pasó? Esto lo leerá quien apruebe la corrección.');
  if (!motivo?.trim()) return;

  await enviarSolicitud({
    fichaje_id: fichajeId,
    fecha_local: fecha,
    tipo_propuesto: tipo,
    hora_propuesta: /^\d{2}:\d{2}$/.test(nueva.trim()) ? nueva.trim() : null,
    motivo: motivo.trim(),
  });
}

/** Un fichaje que nunca llegó a registrarse: no hay original al que apuntar. */
async function pedirFichajeQueFalta(fecha) {
  const tipo = prompt(
    `¿Qué fichaje falta el ${fecha}?\n`
    + 'Escriba: entrada, salida, inicio_pausa o fin_pausa');
  if (!tipo?.trim()) return;
  const hora = prompt('¿A qué hora fue? (HH:MM)');
  if (!hora?.trim()) return;
  const motivo = prompt('¿Qué pasó?') ?? 'Fichaje olvidado';

  await enviarSolicitud({
    fichaje_id: null,
    fecha_local: fecha,
    tipo_propuesto: tipo.trim(),
    hora_propuesta: /^\d{2}:\d{2}$/.test(hora.trim()) ? hora.trim() : null,
    motivo: motivo.trim(),
  });
}

async function enviarSolicitud(cuerpo) {
  try {
    await api('/api/correcciones', { metodo: 'POST', cuerpo });
    alert('Solicitud enviada. La empresa la revisará.');
  } catch (error) {
    alert(error.message);
  }
}

// --- Ausencias ------------------------------------------------------------

async function cargarAusencias() {
  const [saldo, historial] = await Promise.all([
    api('/api/ausencias/saldo'),
    api('/api/ausencias?estado=todas'),
  ]);

  $('saldo-vacaciones').innerHTML = `
    <h2>Vacaciones ${escapar(saldo.anio)}</h2>
    <p style="font-size:2rem;font-weight:700;margin:.25rem 0">
      ${saldo.pendientes} <span style="font-size:1rem;font-weight:400;color:var(--tinta-suave)">
      de ${saldo.dias_anuales} días</span>
    </p>
    <p class="ayuda">${escapar(saldo.nota)}</p>`;

  $('historial-ausencias').innerHTML = historial.ausencias.length
    ? `<div class="tabla-envoltorio"><table>
        <thead><tr><th>Tipo</th><th>Desde</th><th>Hasta</th><th>Estado</th><th></th></tr></thead>
        <tbody>${historial.ausencias.map((a) => `
          <tr>
            <td>${escapar(a.tipo.replace('_', ' '))}</td>
            <td>${escapar(a.fecha_inicio)}</td>
            <td>${escapar(a.fecha_fin)}</td>
            <td><span class="etiqueta ${claseEstado(a.estado)}">${escapar(a.estado)}</span></td>
            <td>${a.estado === 'solicitada'
              ? `<button class="secundario pequeno" data-cancelar="${escapar(a.id)}">Cancelar</button>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>`
    : '<p class="vacio">Sin ausencias registradas.</p>';

  for (const boton of $('historial-ausencias').querySelectorAll('[data-cancelar]')) {
    boton.addEventListener('click', async () => {
      await api(`/api/ausencias/${boton.dataset.cancelar}/cancelar`, { metodo: 'POST' });
      cargarAusencias();
    });
  }
}

function claseEstado(estadoAusencia) {
  return { aprobada: 'verde', denegada: 'rojo', solicitada: 'ambar' }[estadoAusencia] ?? '';
}

$('form-ausencia').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  try {
    await api('/api/ausencias', {
      metodo: 'POST',
      cuerpo: {
        tipo: $('tipo-ausencia').value,
        fecha_inicio: $('desde-ausencia').value,
        fecha_fin: $('hasta-ausencia').value,
        comentario: $('comentario-ausencia').value || null,
      },
    });
    avisar($('aviso-ausencia'), 'Solicitud enviada.', 'exito');
    $('form-ausencia').reset();
    cargarAusencias();
  } catch (error) {
    avisar($('aviso-ausencia'), error.message, 'error');
  }
});

// --- Incidencias ----------------------------------------------------------

async function cargarIncidencias() {
  const datos = await api('/api/incidencias?estado=abierta');
  $('lista-incidencias').innerHTML = datos.incidencias.length
    ? datos.incidencias.map((i) => `
        <div class="tarjeta">
          <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap">
            <strong>${escapar(fechaLegible(i.fecha))}</strong>
            <span class="etiqueta ambar">${escapar(i.familia)}</span>
          </div>
          <p style="margin:.4rem 0 0">${escapar(i.descripcion)}</p>
          ${i.detalle ? `<p class="ayuda">${escapar(i.detalle)}</p>` : ''}
        </div>`).join('')
    : '<div class="tarjeta"><p class="vacio">Ninguna incidencia abierta. Todo en orden.</p></div>';
}
