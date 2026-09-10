/**
 * Disparadores programados.
 *
 *  - Cada quince minutos: incidencias de expectativa del día en curso, para
 *    que la falta de entrada se vea a media mañana y no al día siguiente.
 *  - A las 23:50 hora local de cada empresa: cierre diario con las
 *    estructurales, más el exceso acumulado del mes.
 *
 * El cron de Cloudflare corre en UTC, así que las dos ejecuciones nocturnas
 * (21:50 y 22:50 UTC) cubren horario de verano e invierno; cada empresa
 * atiende sólo la que cae a las 23:50 en su propia zona.
 */
import { ejecutarParaEmpresa, ejecutarExcesoMensual, DESCRIPCIONES } from './motor.js';
import { fechaLocal, horaLocal, ahoraUtc } from '../lib/tiempo.js';
import { enviarCorreo, plantillaResumenIncidencias } from '../lib/correo.js';
import { registrarAcceso } from '../lib/log.js';

/** Minuto local en el que se hace el cierre diario. */
const HORA_CIERRE = '23:50';
/** Holgura para no perder el cierre si el cron se retrasa unos minutos. */
const MARGEN_CIERRE_MIN = 20;

export async function ejecutarCron(env, evento) {
  const ahora = evento?.scheduledTime ? new Date(evento.scheduledTime).toISOString() : ahoraUtc();
  const { results: empresas } = await env.DB.prepare(
    `SELECT * FROM empresas WHERE activa = 1`,
  ).all();

  const resumen = [];
  for (const empresa of empresas ?? []) {
    try {
      resumen.push(await procesarEmpresa(env, empresa, ahora));
    } catch (error) {
      // Una empresa con datos raros no puede tumbar el cron de las demás.
      console.error(`Motor de incidencias, empresa ${empresa.id}:`, error?.stack ?? error);
      resumen.push({ empresa: empresa.id, error: String(error?.message ?? error) });
    }
  }
  return resumen;
}

async function procesarEmpresa(env, empresa, ahora) {
  const zona = empresa.zona_horaria;
  const hoy = fechaLocal(ahora, zona);
  const local = horaLocal(ahora, zona);
  const esCierre = dentroDeVentana(local, HORA_CIERRE, MARGEN_CIERRE_MIN);

  let nuevas = [];

  if (esCierre) {
    const { nuevas: estructurales } = await ejecutarParaEmpresa(env, empresa, hoy, { jornadaCerrada: true });
    nuevas = [...estructurales, ...await ejecutarExcesoMensual(env, empresa, hoy)];
    await registrarAcceso(env.DB, {
      empresaId: empresa.id,
      actorTipo: 'sistema',
      accion: 'cierre_diario',
      recurso: hoy,
    });
  } else {
    const { nuevas: expectativa } = await ejecutarParaEmpresa(env, empresa, hoy, { jornadaCerrada: false });
    nuevas = expectativa;
  }

  if (nuevas.length) await avisar(env, empresa, nuevas, { esCierre });
  return { empresa: empresa.id, fecha: hoy, hora_local: local, cierre: esCierre, nuevas: nuevas.length };
}

/** ¿Estamos dentro de los `margen` minutos posteriores a `objetivo`? */
export function dentroDeVentana(horaLocalActual, objetivo, margen) {
  const aMinutos = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  let diferencia = aMinutos(horaLocalActual) - aMinutos(objetivo);
  // La ventana puede cruzar la medianoche: 23:50 + 20 min cae en el día siguiente.
  if (diferencia < 0) diferencia += 24 * 60;
  return diferencia <= margen;
}

/**
 * Aviso por correo. Por defecto, resumen diario: se manda en el cierre y no en
 * cada pasada, para que el empresario no reciba cuatro correos por mañana.
 * Quien lo quiera inmediato lo configura por empresa.
 */
async function avisar(env, empresa, nuevas, { esCierre }) {
  const inmediato = empresa.avisos_modo === 'inmediato';
  if (!inmediato && !esCierre) return;

  const destino = empresa.avisos_email;
  if (!destino) return;

  const urlPanel = `${env.URL_PUBLICA ?? ''}/empresa/#incidencias`;
  const { asunto, texto } = plantillaResumenIncidencias(
    empresa,
    nuevas.map((n) => ({
      fecha: n.fecha,
      empleado: n.empleado,
      descripcion: n.descripcion ?? DESCRIPCIONES[n.tipo] ?? n.tipo,
    })),
    urlPanel,
  );
  await enviarCorreo(env, { para: destino, asunto, texto });

  const ahora = ahoraUtc();
  for (const n of nuevas) {
    await env.DB.prepare(
      `UPDATE incidencias SET avisada_en = ?
        WHERE empresa_id = ? AND empleado_id = ? AND fecha = ? AND tipo = ? AND avisada_en IS NULL`,
    ).bind(ahora, empresa.id, n.empleado_id, n.fecha, n.tipo).run();
  }
}
