/**
 * Panel de gestoría.
 *
 * Es el panel transversal: la lista de empresas con semáforo, la entrada a
 * cualquiera de ellas con las mismas capacidades que el panel de empresa, y el
 * cierre de periodo de varias a la vez. El criterio de éxito de esta pantalla
 * es que la gestoría cierre el mes de cinco empresas sin salir de aquí.
 */
import { api, escapar, avisar, descargar, fijarEmpresaActiva } from './api.js';

const $ = (id) => document.getElementById(id);
const estado = { empresas: [] };

arrancar();

async function arrancar() {
  // El panel de gestoría no trabaja dentro de ninguna empresa concreta.
  fijarEmpresaActiva(null);

  const yo = await api('/api/auth/yo', { destinoEntrada: '/entrar/' });
  if (yo.actor_tipo !== 'gestoria') { location.href = '/empresa/'; return; }
  $('marca').textContent = yo.gestoria?.nombre ?? 'Gestoría';

  const ahora = new Date();
  $('c-anio').value = ahora.getUTCFullYear();
  $('c-indice').value = ahora.getUTCMonth() + 1;

  await cargarEmpresas();
}

for (const boton of document.querySelectorAll('.barra nav button')) {
  boton.addEventListener('click', () => {
    for (const otro of document.querySelectorAll('.barra nav button')) {
      otro.removeAttribute('aria-current');
    }
    boton.setAttribute('aria-current', 'page');
    for (const nombre of ['empresas', 'cierre', 'alta']) {
      $(`vista-${nombre}`).hidden = nombre !== boton.dataset.vista;
    }
    if (boton.dataset.vista === 'cierre') pintarSeleccion();
  });
}

$('salir').addEventListener('click', async () => {
  await api('/api/auth/salir', { metodo: 'POST', silencioso: true }).catch(() => {});
  location.href = '/entrar/';
});

async function cargarEmpresas() {
  const datos = await api('/api/gestoria/empresas');
  estado.empresas = datos.empresas;

  $('rejilla-empresas').innerHTML = datos.empresas.length
    ? datos.empresas.map((e) => `
        <div class="tarjeta" data-empresa="${escapar(e.id)}" role="button" tabindex="0">
          <div style="display:flex;align-items:center;gap:.5rem">
            <span class="punto ${escapar(e.semaforo)}"></span>
            <strong style="flex:1">${escapar(e.nombre)}</strong>
          </div>
          <p class="ayuda" style="margin:.4rem 0 0">
            Empresa n.º <strong>${String(e.numero).padStart(3, '0')}</strong> ·
            ${e.plantilla} ${e.plantilla === 1 ? 'trabajador' : 'trabajadores'}
          </p>
          <p style="margin:.5rem 0 0">
            ${e.solicitudes_pendientes
              ? `<span class="etiqueta rojo">${e.solicitudes_pendientes} por resolver</span> ` : ''}
            ${e.incidencias_abiertas
              ? `<span class="etiqueta ambar">${e.incidencias_abiertas} incidencias</span> ` : ''}
            ${!e.solicitudes_pendientes && !e.incidencias_abiertas
              ? '<span class="etiqueta verde">al día</span>' : ''}
          </p>
          <p class="ayuda" style="margin:.5rem 0 0">
            Último fichaje: ${e.ultimo_fichaje ? escapar(e.ultimo_fichaje) : 'todavía ninguno'}
          </p>
          <p style="margin:.6rem 0 0">
            <button class="secundario pequeno" data-password="${escapar(e.id)}">
              Reponer contraseña
            </button>
          </p>
        </div>`).join('')
    : '<div class="tarjeta"><p class="vacio">Todavía no ha dado de alta ninguna empresa.</p></div>';

  for (const tarjeta of document.querySelectorAll('[data-empresa]')) {
    const abrir = () => entrarEnEmpresa(tarjeta.dataset.empresa);
    tarjeta.addEventListener('click', abrir);
    tarjeta.addEventListener('keydown', (evento) => {
      if (evento.key === 'Enter' || evento.key === ' ') { evento.preventDefault(); abrir(); }
    });
  }

  // El botón de reponer contraseña no debe abrir además el panel de la empresa.
  for (const boton of document.querySelectorAll('[data-password]')) {
    boton.addEventListener('click', (evento) => {
      evento.stopPropagation();
      reponerPassword(boton.dataset.password);
    });
  }
}

/** Entrar en una empresa es abrir su panel con la empresa activa fijada. */
function entrarEnEmpresa(id) {
  fijarEmpresaActiva(id);
  location.href = `/empresa/?empresa=${encodeURIComponent(id)}`;
}

/**
 * Repone la contraseña del panel de una empresa. Es lo que sustituye al «he
 * olvidado mi contraseña» por correo: sin correo en el acceso, quien repone es
 * quien está por encima en la cadena.
 */
async function reponerPassword(empresaId) {
  if (!confirm(
    '¿Reponer la contraseña de acceso al panel de esta empresa?\n\n'
    + 'La anterior dejará de valer y se cerrarán sus sesiones abiertas.',
  )) return;

  try {
    const datos = await api(`/api/gestoria/empresas/${empresaId}/password`, { metodo: 'POST' });
    avisar($('aviso'),
      `Contraseña repuesta para ${datos.email}: ${datos.password} — ${datos.aviso}`,
      'pendiente');
  } catch (error) {
    avisar($('aviso'), error.message, 'error');
  }
}

// --- Cierre de periodo ----------------------------------------------------

function pintarSeleccion() {
  $('seleccion-empresas').innerHTML = estado.empresas.length
    ? `<ul class="lista">${estado.empresas.map((e) => `
        <li>
          <input type="checkbox" style="width:auto" value="${escapar(e.id)}" checked
                 id="sel-${escapar(e.id)}">
          <label for="sel-${escapar(e.id)}" class="crece" style="font-weight:400;margin:0">
            ${escapar(e.nombre)}
          </label>
          <span class="punto ${escapar(e.semaforo)}"></span>
        </li>`).join('')}</ul>`
    : '<p class="vacio">Ninguna empresa que exportar.</p>';
}

$('exportar-masivo').addEventListener('click', () => {
  const marcadas = [...document.querySelectorAll('#seleccion-empresas input:checked')]
    .map((c) => c.value);
  if (!marcadas.length) {
    avisar($('aviso'), 'Seleccione al menos una empresa.', 'error');
    return;
  }
  descargar('/api/gestoria/exportacion'
    + `?formato=${$('c-formato').value}`
    + `&periodo=${$('c-periodo').value}`
    + `&anio=${$('c-anio').value}`
    + `&indice=${$('c-indice').value}`
    + `&empresas=${marcadas.join(',')}`);
});

// --- Alta de empresa ------------------------------------------------------

$('form-empresa').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  try {
    const datos = await api('/api/gestoria/empresas', {
      metodo: 'POST',
      cuerpo: {
        nombre: $('n-nombre').value.trim(),
        cif: $('n-cif').value.trim() || null,
        direccion: $('n-direccion').value.trim() || null,
        codigo: $('n-codigo').value.trim() || undefined,
        email_empresa: $('n-email').value.trim() || null,
        tolerancia_minutos: Number($('n-tolerancia').value),
        jornada_maxima_alerta_horas: Number($('n-jornada').value),
        avisos_email: $('n-avisos').value.trim() || null,
      },
    });
    const numero = String(datos.empresa.numero).padStart(3, '0');
    avisar($('aviso'),
      `Empresa dada de alta con el número ${numero}. Sus trabajadores fichan con `
      + `un identificador que empieza por ${numero}.`
      + (datos.password_inicial
        ? ` Contraseña del panel: ${datos.password_inicial} — ${datos.aviso}`
        : ''),
      datos.password_inicial ? 'pendiente' : 'exito');
    $('form-empresa').reset();
    $('n-tolerancia').value = 20;
    $('n-jornada').value = 12;
    await cargarEmpresas();
  } catch (error) {
    avisar($('aviso'), error.message, 'error');
  }
});
