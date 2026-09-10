/**
 * Módulo de exportación.
 *
 * Decisión no negociable número 6: toda salida de datos pasa por aquí. Hoy hay
 * dos adaptadores, PDF y CSV. Cuando se publique la orden ministerial con las
 * especificaciones técnicas, la integración con la Inspección será un tercer
 * adaptador registrado en esta misma tabla, no una reescritura.
 *
 * Los adaptadores están versionados a propósito: si la orden ministerial
 * cambia el formato dentro de dos años, el adaptador nuevo convive con el
 * viejo y los informes ya emitidos se siguen pudiendo reproducir tal cual
 * salieron.
 */
import { adaptadorCsv } from './adaptadores/csv.js';
import { adaptadorPdf } from './adaptadores/pdf.js';
import { malaPeticion } from '../lib/respuestas.js';

/**
 * Registro de adaptadores. Clave: `nombre` o `nombre@version`.
 * Cada adaptador expone { nombre, version, tipoContenido, extension, generar }.
 */
const ADAPTADORES = new Map();

export function registrarAdaptador(adaptador) {
  ADAPTADORES.set(`${adaptador.nombre}@${adaptador.version}`, adaptador);
  const actual = ADAPTADORES.get(adaptador.nombre);
  // El alias sin versión apunta siempre a la más alta registrada.
  if (!actual || compararVersiones(adaptador.version, actual.version) > 0) {
    ADAPTADORES.set(adaptador.nombre, adaptador);
  }
}

function compararVersiones(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

registrarAdaptador(adaptadorCsv);
registrarAdaptador(adaptadorPdf);

export function listarAdaptadores() {
  const vistos = new Set();
  const salida = [];
  for (const [clave, a] of ADAPTADORES) {
    if (!clave.includes('@') || vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push({
      nombre: a.nombre,
      version: a.version,
      tipo_contenido: a.tipoContenido,
      extension: a.extension,
      descripcion: a.descripcion,
    });
  }
  return salida;
}

/**
 * Punto único de salida.
 *
 * @param formato  'pdf', 'csv' o 'nombre@version'.
 * @param datos    Informe ya calculado (ver src/lib/informes.js).
 * @param opciones Se pasan tal cual al adaptador.
 */
export function exportar(formato, datos, opciones = {}) {
  const adaptador = ADAPTADORES.get(formato);
  if (!adaptador) {
    throw malaPeticion(
      `Formato de exportación no disponible: ${formato}. ` +
      `Disponibles: ${listarAdaptadores().map((a) => `${a.nombre}@${a.version}`).join(', ')}`,
    );
  }
  const contenido = adaptador.generar(datos, opciones);
  return {
    contenido,
    tipoContenido: adaptador.tipoContenido,
    extension: adaptador.extension,
    adaptador: `${adaptador.nombre}@${adaptador.version}`,
  };
}

/** Nombre de fichero estable y legible: empresa, periodo y formato. */
export function nombreFichero(datos, extension) {
  const empresa = (datos.empresa?.nombre ?? 'empresa')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  const { desde, hasta } = datos.periodo ?? {};
  return `registro-jornada-${empresa}-${desde}_${hasta}.${extension}`;
}
