/**
 * Adaptador CSV.
 *
 * Pensado para abrirse en la hoja de cálculo de la gestoría sin pelearse con
 * ella: separador punto y coma, coma decimal y BOM UTF-8, que es lo que Excel
 * en español espera. Un CSV que se abre mal es un CSV que acaban pidiendo en
 * PDF y transcribiendo a mano.
 */
import { horasDecimales, horasYMinutos } from '../../lib/informes.js';

const BOM = '\uFEFF';

function campo(valor) {
  const texto = valor === null || valor === undefined ? '' : String(valor);
  return /[";\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

const linea = (celdas) => celdas.map(campo).join(';');

export const adaptadorCsv = {
  nombre: 'csv',
  version: '1.0',
  tipoContenido: 'text/csv; charset=utf-8',
  extension: 'csv',
  descripcion: 'Resumen por empleado del periodo, para hoja de cálculo',

  generar(datos, opciones = {}) {
    const filas = [];
    filas.push(linea([
      `Registro de jornada — ${datos.empresa.nombre}`,
      `Periodo: ${datos.periodo.desde} a ${datos.periodo.hasta}`,
    ]));
    if (datos.periodo.en_curso) {
      filas.push(linea([
        `Periodo en curso: las horas teóricas están calculadas hasta el ${datos.periodo.teoricas_hasta}.`,
      ]));
    }
    filas.push('');

    if (opciones.detalle === 'diario' && datos.dias) {
      return BOM + generarDetalleDiario(datos, filas);
    }

    filas.push(linea([
      'Empleado', 'Documento', 'Jornada',
      'Horas registradas', 'Horas (h:min)',
      'Horas teóricas', 'Teóricas (h:min)',
      datos.etiqueta_diferencia, 'Exceso (h:min)',
      'Días trabajados', 'Días de ausencia', 'Incidencias',
    ]));

    for (const e of datos.empleados) {
      filas.push(linea([
        e.nombre, e.documento_identidad ?? '', e.tipo_jornada,
        horasDecimales(e.minutos_registrados), horasYMinutos(e.minutos_registrados),
        horasDecimales(e.minutos_teoricos), horasYMinutos(e.minutos_teoricos),
        horasDecimales(e.minutos_exceso), horasYMinutos(e.minutos_exceso),
        e.dias_trabajados, e.total_dias_ausencia, e.total_incidencias,
      ]));
    }

    const t = datos.totales;
    filas.push('');
    filas.push(linea([
      'TOTAL', '', '',
      horasDecimales(t.minutos_registrados), horasYMinutos(t.minutos_registrados),
      horasDecimales(t.minutos_teoricos), horasYMinutos(t.minutos_teoricos),
      horasDecimales(t.minutos_exceso), horasYMinutos(t.minutos_exceso),
      t.dias_trabajados, t.total_dias_ausencia, t.total_incidencias,
    ]));

    // Desglose de ausencias por tipo: la gestoría lo necesita separado.
    const tipos = [...new Set(datos.empleados.flatMap((e) => Object.keys(e.dias_ausencia)))];
    if (tipos.length) {
      filas.push('');
      filas.push(linea(['Ausencias por tipo (días)']));
      filas.push(linea(['Empleado', ...tipos]));
      for (const e of datos.empleados) {
        filas.push(linea([e.nombre, ...tipos.map((t2) => e.dias_ausencia[t2] ?? 0)]));
      }
    }

    filas.push('');
    filas.push(linea([
      'La diferencia de horas se expresa como exceso sobre jornada teórica.',
      'Su calificación como hora extraordinaria, complementaria o compensada corresponde a la gestoría.',
    ]));

    return BOM + filas.join('\r\n');
  },
};

/** Detalle diario: una línea por fichaje, con la traza de correcciones. */
function generarDetalleDiario(datos, filas) {
  filas.push(linea([
    'Fecha', 'Empleado', 'Tipo', 'Hora', 'Origen', 'Diferido',
    'Registro', 'Referencia', 'Motivo', 'Hash',
  ]));
  for (const dia of datos.dias) {
    for (const f of dia.traza.length ? [...dia.fichajes, ...dia.traza] : dia.fichajes) {
      filas.push(linea([
        dia.fecha,
        datos.empleado.nombre,
        f.tipo,
        f.timestamp_utc,
        f.origen,
        f.diferido ? 'sí' : 'no',
        f.tipo_registro,
        f.fichaje_referenciado_id ?? '',
        f.motivo ?? '',
        f.hash,
      ]));
    }
  }
  return filas.join('\r\n');
}
