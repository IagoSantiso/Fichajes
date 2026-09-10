/**
 * Zonas horarias y fechas.
 *
 * Regla del proyecto: el sello temporal es siempre UTC y de servidor. La zona
 * horaria de la empresa se guarda aparte y sólo se usa para *presentar* y para
 * decidir a qué día local pertenece un fichaje. Nunca se confía en el reloj
 * del dispositivo: lo que manda el cliente entra como `timestamp_declarado`.
 */

/** Instante actual del servidor, ISO-8601 con Z y sin milisegundos. */
export function ahoraUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function partesEnZona(fecha, zona) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(fecha).map((x) => [x.type, x.value]));
  // Intl devuelve '24' para medianoche en algunas plataformas.
  if (p.hour === '24') p.hour = '00';
  return p;
}

/** 'YYYY-MM-DD' del instante en la zona indicada. */
export function fechaLocal(iso, zona) {
  const p = partesEnZona(new Date(iso), zona);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 'HH:MM' del instante en la zona indicada. */
export function horaLocal(iso, zona) {
  const p = partesEnZona(new Date(iso), zona);
  return `${p.hour}:${p.minute}`;
}

/** 'YYYY-MM-DD HH:MM' del instante en la zona indicada. */
export function fechaHoraLocal(iso, zona) {
  return `${fechaLocal(iso, zona)} ${horaLocal(iso, zona)}`;
}

/**
 * Desplazamiento de la zona respecto a UTC, en minutos, en ese instante.
 * Positivo al este de Greenwich (Europe/Madrid en verano: +120).
 */
export function desfaseMinutos(iso, zona) {
  const fecha = new Date(iso);
  const p = partesEnZona(fecha, zona);
  const comoUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((comoUtc - fecha.getTime()) / 60000);
}

/**
 * Convierte una fecha y hora locales ('YYYY-MM-DD', 'HH:MM') de una zona al
 * instante UTC correspondiente. Se resuelve en dos pasos porque el desfase
 * depende de la propia fecha (cambio de hora).
 */
export function localAUtc(fecha, hora, zona) {
  const [a, m, d] = fecha.split('-').map(Number);
  const [hh, mm] = hora.split(':').map(Number);
  const tentativo = Date.UTC(a, m - 1, d, hh, mm, 0);
  let desfase = desfaseMinutos(new Date(tentativo).toISOString(), zona);
  let resultado = tentativo - desfase * 60000;
  // Segunda pasada: si el desfase cambia justo ese día, corrige.
  const desfase2 = desfaseMinutos(new Date(resultado).toISOString(), zona);
  if (desfase2 !== desfase) resultado = tentativo - desfase2 * 60000;
  return new Date(resultado).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Día de la semana ISO (1 = lunes ... 7 = domingo) de una fecha 'YYYY-MM-DD'. */
export function diaSemanaIso(fecha) {
  const [a, m, d] = fecha.split('-').map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  return dia === 0 ? 7 : dia;
}

/** Suma días a una fecha 'YYYY-MM-DD' (aritmética de calendario, sin zonas). */
export function sumarDias(fecha, dias) {
  const [a, m, d] = fecha.split('-').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d));
  t.setUTCDate(t.getUTCDate() + dias);
  return t.toISOString().slice(0, 10);
}

/** Lista de fechas 'YYYY-MM-DD' entre dos, ambas incluidas. */
export function rangoFechas(desde, hasta) {
  const dias = [];
  let f = desde;
  let guarda = 0;
  while (f <= hasta && guarda++ < 3700) {
    dias.push(f);
    f = sumarDias(f, 1);
  }
  return dias;
}

/** Diferencia en minutos entre dos instantes ISO. */
export function minutosEntre(desdeIso, hastaIso) {
  return Math.round((new Date(hastaIso) - new Date(desdeIso)) / 60000);
}

/** Minutos desde medianoche de una hora 'HH:MM'. */
export function minutosDeHora(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Resuelve el periodo de un informe.
 * clase: 'mes' | 'trimestre' | 'semestre' | 'anio'
 */
export function resolverPeriodo(clase, anio, indice) {
  const ultimoDia = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();
  const p2 = (n) => String(n).padStart(2, '0');
  switch (clase) {
    case 'mes': {
      const m = Number(indice);
      return { desde: `${anio}-${p2(m)}-01`, hasta: `${anio}-${p2(m)}-${p2(ultimoDia(anio, m))}` };
    }
    case 'trimestre': {
      const t = Number(indice);
      const mi = (t - 1) * 3 + 1;
      const mf = mi + 2;
      return { desde: `${anio}-${p2(mi)}-01`, hasta: `${anio}-${p2(mf)}-${p2(ultimoDia(anio, mf))}` };
    }
    case 'semestre': {
      const s = Number(indice);
      const mi = (s - 1) * 6 + 1;
      const mf = mi + 5;
      return { desde: `${anio}-${p2(mi)}-01`, hasta: `${anio}-${p2(mf)}-${p2(ultimoDia(anio, mf))}` };
    }
    case 'anio':
      return { desde: `${anio}-01-01`, hasta: `${anio}-12-31` };
    default:
      throw new Error(`Periodo no reconocido: ${clase}`);
  }
}

/** Etiqueta legible del periodo, para cabeceras de informes. */
export function etiquetaPeriodo(clase, anio, indice) {
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio',
    'agosto','septiembre','octubre','noviembre','diciembre'];
  switch (clase) {
    case 'mes': return `${meses[Number(indice) - 1]} de ${anio}`;
    case 'trimestre': return `${indice}.º trimestre de ${anio}`;
    case 'semestre': return `${indice}.º semestre de ${anio}`;
    case 'anio': return `año ${anio}`;
    default: return `${clase} ${indice} ${anio}`;
  }
}
