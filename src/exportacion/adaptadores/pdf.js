/**
 * Adaptador PDF.
 *
 * El PDF se genera a mano, sin librería. Suena excesivo hasta que se cuenta lo
 * que pesa una librería de PDF en un Worker: para un informe tabular con dos
 * tipos de letra estándar, esto son doscientas líneas y ninguna dependencia
 * que mantener durante cuatro años de conservación obligatoria.
 *
 * Se usan las fuentes base de PDF (Helvetica) con WinAnsiEncoding, que cubre
 * los acentos y la eñe sin incrustar ningún fichero de fuente.
 */
import { horasYMinutos } from '../../lib/informes.js';

const ANCHO = 595.28;   // A4 en puntos
const ALTO = 841.89;
const MARGEN = 40;
const INTERLINEA = 14;

/** Anchos aproximados de Helvetica, suficientes para truncar y alinear. */
const ANCHO_MEDIO = 0.5;

function anchoTexto(texto, tamano) {
  return texto.length * tamano * ANCHO_MEDIO;
}

/** Escapa para una cadena literal de PDF. */
function escapar(texto) {
  return String(texto)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** Recorta un texto para que quepa en el ancho dado. */
function recortar(texto, ancho, tamano) {
  const maximo = Math.floor(ancho / (tamano * ANCHO_MEDIO));
  const t = String(texto ?? '');
  return t.length <= maximo ? t : `${t.slice(0, Math.max(1, maximo - 1))}…`;
}

/** Lienzo de una página: acumula operadores de dibujo. */
class Pagina {
  constructor() {
    this.ops = [];
    this.y = ALTO - MARGEN;
  }

  texto(x, y, contenido, { tamano = 9, negrita = false, gris = 0 } = {}) {
    this.ops.push(
      'BT',
      `/${negrita ? 'F2' : 'F1'} ${tamano} Tf`,
      `${gris} g`,
      `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`,
      `(${escapar(contenido)}) Tj`,
      'ET',
    );
  }

  linea(x1, y1, x2, y2, { gris = 0.7, grosor = 0.5 } = {}) {
    this.ops.push(
      `${grosor} w`, `${gris} G`,
      `${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`,
    );
  }

  rectangulo(x, y, ancho, alto, gris = 0.93) {
    this.ops.push(`${gris} g`, `${x} ${y} ${ancho} ${alto} re f`, '0 g');
  }

  contenido() {
    return this.ops.join('\n');
  }
}

/** Documento: gestiona el salto de página y el ensamblado final. */
class Documento {
  constructor(pieDePagina) {
    this.paginas = [];
    this.pieDePagina = pieDePagina;
    this.nueva();
  }

  nueva() {
    this.actual = new Pagina();
    this.paginas.push(this.actual);
    return this.actual;
  }

  /** Reserva espacio; si no cabe, abre página y ejecuta el encabezado dado. */
  espacio(alto, repetirEncabezado = null) {
    if (this.actual.y - alto < MARGEN + 30) {
      this.nueva();
      if (repetirEncabezado) repetirEncabezado(this.actual);
    }
    return this.actual;
  }

  avanzar(n = 1) {
    this.actual.y -= INTERLINEA * n;
  }

  serializar() {
    // Numeración y pie en cada página, ya conocido el total.
    this.paginas.forEach((pagina, indice) => {
      pagina.linea(MARGEN, MARGEN + 18, ANCHO - MARGEN, MARGEN + 18, { gris: 0.8 });
      pagina.texto(MARGEN, MARGEN + 6, this.pieDePagina, { tamano: 7, gris: 0.45 });
      const numeracion = `Página ${indice + 1} de ${this.paginas.length}`;
      pagina.texto(ANCHO - MARGEN - anchoTexto(numeracion, 7), MARGEN + 6, numeracion,
        { tamano: 7, gris: 0.45 });
    });
    return ensamblar(this.paginas.map((p) => p.contenido()));
  }
}

/** Ensambla el fichero PDF con su tabla de referencias cruzadas. */
function ensamblar(contenidos) {
  const objetos = [];
  const totalPaginas = contenidos.length;
  const idPrimeraPagina = 4;
  const idsPagina = contenidos.map((_, i) => idPrimeraPagina + i * 2);

  objetos.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objetos.push(
    `2 0 obj\n<< /Type /Pages /Count ${totalPaginas} ` +
    `/Kids [${idsPagina.map((id) => `${id} 0 R`).join(' ')}] >>\nendobj\n`,
  );
  objetos.push(
    `3 0 obj\n<< /Font << ` +
    `/F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> ` +
    `/F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> ` +
    `>> >>\nendobj\n`,
  );

  contenidos.forEach((contenido, i) => {
    const idPagina = idsPagina[i];
    const idFlujo = idPagina + 1;
    objetos.push(
      `${idPagina} 0 obj\n<< /Type /Page /Parent 2 0 R /Resources 3 0 R ` +
      `/MediaBox [0 0 ${ANCHO} ${ALTO}] /Contents ${idFlujo} 0 R >>\nendobj\n`,
    );
    const bytes = longitudLatin1(contenido);
    objetos.push(`${idFlujo} 0 obj\n<< /Length ${bytes} >>\nstream\n${contenido}\nendstream\nendobj\n`);
  });

  let pdf = '%PDF-1.4\n';
  const desplazamientos = [];
  for (const objeto of objetos) {
    desplazamientos.push(longitudLatin1(pdf));
    pdf += objeto;
  }

  const inicioXref = longitudLatin1(pdf);
  const total = objetos.length + 1;
  pdf += `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (const d of desplazamientos) {
    pdf += `${String(d).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF`;

  return aLatin1(pdf);
}

/**
 * Los operadores de PDF y las fuentes base usan un byte por carácter
 * (WinAnsi ≈ Latin-1). Lo que no cabe se sustituye para no corromper el
 * fichero: es preferible una interrogación a un PDF que no abre.
 */
function aLatin1(texto) {
  const salida = new Uint8Array(texto.length);
  for (let i = 0; i < texto.length; i++) {
    const codigo = texto.charCodeAt(i);
    salida[i] = codigo < 256 ? codigo : caracterEspecial(codigo);
  }
  return salida;
}

function caracterEspecial(codigo) {
  switch (codigo) {
    case 0x2026: return 0x85;   // …
    case 0x2018: return 0x91;   // ‘
    case 0x2019: return 0x92;   // ’
    case 0x201c: return 0x93;   // “
    case 0x201d: return 0x94;   // ”
    case 0x2013: return 0x96;   // –
    case 0x2014: return 0x97;   // —
    case 0x20ac: return 0x80;   // €
    default: return 0x3f;       // ?
  }
}

function longitudLatin1(texto) {
  return texto.length;
}

// --- Composición del informe ---------------------------------------------

export const adaptadorPdf = {
  nombre: 'pdf',
  version: '1.0',
  tipoContenido: 'application/pdf',
  extension: 'pdf',
  descripcion: 'Informe del periodo por empleado, para entregar o archivar',

  generar(datos, opciones = {}) {
    return opciones.detalle === 'diario' && datos.dias
      ? generarDetalleDiario(datos)
      : generarResumen(datos);
  },
};

function generarResumen(datos) {
  const pie = `${datos.empresa.nombre} · Registro de jornada (art. 34.9 ET) · `
    + `Generado el ${new Date(datos.generado_en ?? Date.now()).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}`;
  const doc = new Documento(pie);

  const columnas = [
    { titulo: 'Empleado', ancho: 150, alinear: 'izquierda' },
    { titulo: 'Registradas', ancho: 70, alinear: 'derecha' },
    { titulo: 'Teóricas', ancho: 70, alinear: 'derecha' },
    { titulo: 'Exceso', ancho: 70, alinear: 'derecha' },
    { titulo: 'Días trab.', ancho: 55, alinear: 'derecha' },
    { titulo: 'Ausencias', ancho: 55, alinear: 'derecha' },
    { titulo: 'Incid.', ancho: 45, alinear: 'derecha' },
  ];

  cabeceraInforme(doc.actual, datos);
  doc.actual.y -= 12;
  const encabezadoTabla = (pagina) => {
    pagina.y = ALTO - MARGEN;
    dibujarCabeceraTabla(pagina, columnas);
  };
  dibujarCabeceraTabla(doc.actual, columnas);

  for (const e of datos.empleados) {
    doc.espacio(INTERLINEA, encabezadoTabla);
    dibujarFila(doc.actual, columnas, [
      e.nombre,
      horasYMinutos(e.minutos_registrados),
      horasYMinutos(e.minutos_teoricos),
      horasYMinutos(e.minutos_exceso),
      String(e.dias_trabajados),
      String(e.total_dias_ausencia),
      String(e.total_incidencias),
    ]);
  }

  const t = datos.totales;
  doc.espacio(INTERLINEA * 2, encabezadoTabla);
  doc.actual.linea(MARGEN, doc.actual.y + 3, ANCHO - MARGEN, doc.actual.y + 3, { gris: 0.4 });
  doc.actual.y -= 4;
  dibujarFila(doc.actual, columnas, [
    'TOTAL',
    horasYMinutos(t.minutos_registrados),
    horasYMinutos(t.minutos_teoricos),
    horasYMinutos(t.minutos_exceso),
    String(t.dias_trabajados),
    String(t.total_dias_ausencia),
    String(t.total_incidencias),
  ], { negrita: true });

  doc.espacio(INTERLINEA * 5, encabezadoTabla);
  doc.actual.y -= 16;
  doc.actual.texto(MARGEN, doc.actual.y, 'Sobre la columna «Exceso»', { tamano: 8, negrita: true });
  doc.actual.y -= 11;
  for (const parrafo of [
    'La diferencia entre horas registradas y horas teóricas se expresa como exceso sobre jornada teórica.',
    'Su calificación como hora extraordinaria, complementaria o compensación por flexibilidad depende del',
    'convenio y del contrato, y corresponde a la gestoría, no a esta plataforma.',
  ]) {
    doc.actual.texto(MARGEN, doc.actual.y, parrafo, { tamano: 7.5, gris: 0.3 });
    doc.actual.y -= 10;
  }

  return doc.serializar();
}

function generarDetalleDiario(datos) {
  const pie = `${datos.empresa.nombre} · ${datos.empleado.nombre} · Registro diario de jornada`;
  const doc = new Documento(pie);
  const pagina = doc.actual;

  pagina.texto(MARGEN, pagina.y, 'Registro diario de jornada', { tamano: 15, negrita: true });
  pagina.y -= 18;
  pagina.texto(MARGEN, pagina.y, `${datos.empresa.nombre}${datos.empresa.cif ? ` · ${datos.empresa.cif}` : ''}`, { tamano: 9, gris: 0.3 });
  pagina.y -= 12;
  pagina.texto(MARGEN, pagina.y, `${datos.empleado.nombre}${datos.empleado.documento_identidad ? ` · ${datos.empleado.documento_identidad}` : ''}`, { tamano: 9, gris: 0.3 });
  pagina.y -= 12;
  pagina.texto(MARGEN, pagina.y, `Periodo: ${datos.periodo.desde} a ${datos.periodo.hasta}`, { tamano: 9, gris: 0.3 });
  pagina.y -= 20;

  const columnas = [
    { titulo: 'Fecha', ancho: 75, alinear: 'izquierda' },
    { titulo: 'Entrada', ancho: 60, alinear: 'izquierda' },
    { titulo: 'Salida', ancho: 60, alinear: 'izquierda' },
    { titulo: 'Pausas', ancho: 130, alinear: 'izquierda' },
    { titulo: 'Total', ancho: 75, alinear: 'derecha' },
    { titulo: 'Notas', ancho: 115, alinear: 'izquierda' },
  ];
  const encabezado = (p) => { p.y = ALTO - MARGEN; dibujarCabeceraTabla(p, columnas); };
  dibujarCabeceraTabla(doc.actual, columnas);

  for (const dia of datos.dias) {
    doc.espacio(INTERLINEA, encabezado);
    const zona = datos.empresa.zona_horaria ?? 'Europe/Madrid';
    const hora = (f) => new Intl.DateTimeFormat('es-ES', {
      timeZone: zona, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(f.timestamp_utc));

    const entrada = dia.fichajes.find((f) => f.tipo === 'entrada');
    const salida = [...dia.fichajes].reverse().find((f) => f.tipo === 'salida');
    const pausas = dia.fichajes.filter((f) => f.tipo === 'inicio_pausa' || f.tipo === 'fin_pausa')
      .map(hora).join(' / ');
    const notas = [];
    if (dia.fichajes.some((f) => f.diferido)) notas.push('diferido');
    if (dia.traza.length) notas.push('corregido');
    if (!salida && entrada) notas.push('sin salida');

    dibujarFila(doc.actual, columnas, [
      dia.fecha,
      entrada ? hora(entrada) : '—',
      salida ? hora(salida) : '—',
      pausas || '—',
      horasYMinutos(dia.minutos),
      notas.join(', ') || '',
    ]);
  }

  return doc.serializar();
}

function cabeceraInforme(pagina, datos) {
  pagina.texto(MARGEN, pagina.y, 'Informe de registro de jornada', { tamano: 15, negrita: true });
  pagina.y -= 18;
  pagina.texto(MARGEN, pagina.y,
    `${datos.empresa.nombre}${datos.empresa.cif ? ` · ${datos.empresa.cif}` : ''}`,
    { tamano: 9, gris: 0.3 });
  pagina.y -= 12;
  pagina.texto(MARGEN, pagina.y,
    `Periodo: ${datos.periodo.desde} a ${datos.periodo.hasta} · Zona horaria: ${datos.empresa.zona_horaria}`,
    { tamano: 9, gris: 0.3 });
  pagina.y -= 12;
  pagina.texto(MARGEN, pagina.y,
    'Registro conforme al artículo 34.9 del Estatuto de los Trabajadores.',
    { tamano: 8, gris: 0.45 });
  pagina.y -= 12;
  if (datos.periodo.en_curso) {
    pagina.texto(MARGEN, pagina.y,
      `Periodo en curso: las horas teóricas están calculadas hasta el ${datos.periodo.teoricas_hasta}.`,
      { tamano: 8, gris: 0.45 });
    pagina.y -= 4;
  }
}

function dibujarCabeceraTabla(pagina, columnas) {
  pagina.rectangulo(MARGEN, pagina.y - 4, ANCHO - MARGEN * 2, 14, 0.92);
  let x = MARGEN + 3;
  for (const c of columnas) {
    const texto = c.titulo;
    const posicion = c.alinear === 'derecha'
      ? x + c.ancho - anchoTexto(texto, 8) - 6
      : x;
    pagina.texto(posicion, pagina.y, texto, { tamano: 8, negrita: true });
    x += c.ancho;
  }
  pagina.y -= INTERLINEA;
}

function dibujarFila(pagina, columnas, celdas, { negrita = false } = {}) {
  let x = MARGEN + 3;
  columnas.forEach((c, i) => {
    const texto = recortar(celdas[i] ?? '', c.ancho - 6, 8.5);
    const posicion = c.alinear === 'derecha'
      ? x + c.ancho - anchoTexto(texto, 8.5) - 6
      : x;
    pagina.texto(posicion, pagina.y, texto, { tamano: 8.5, negrita });
    x += c.ancho;
  });
  pagina.y -= INTERLINEA;
}
