/**
 * Envío de correo, detrás de una interfaz mínima.
 *
 * En desarrollo se vuelca a los logs, para no depender de nada externo y para
 * poder copiar el enlace mágico desde `wrangler dev`. En producción se usa el
 * proveedor configurado. El canal de avisos (sólo correo, o correo y WhatsApp)
 * es una decisión pendiente del brief: cuando se cierre, se añade aquí otro
 * proveedor y no se toca nada más.
 */

export async function enviarCorreo(env, { para, asunto, texto, html = null }) {
  const remitente = env.CORREO_REMITENTE ?? 'fichajes@example.com';
  const nombre = env.CORREO_NOMBRE_REMITENTE ?? 'Registro de jornada';

  if ((env.CORREO_PROVEEDOR ?? 'consola') === 'consola') {
    console.log('--- CORREO (proveedor: consola) ---');
    console.log(`Para: ${para}`);
    console.log(`Asunto: ${asunto}`);
    console.log(texto);
    console.log('-----------------------------------');
    return { enviado: false, proveedor: 'consola' };
  }

  if (env.CORREO_PROVEEDOR === 'resend') {
    const respuesta = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: `${nombre} <${remitente}>`,
        to: [para],
        subject: asunto,
        text: texto,
        ...(html ? { html } : {}),
      }),
    });
    if (!respuesta.ok) {
      const detalle = await respuesta.text();
      console.error('Fallo al enviar correo:', respuesta.status, detalle);
      return { enviado: false, proveedor: 'resend', estado: respuesta.status };
    }
    return { enviado: true, proveedor: 'resend' };
  }

  console.error(`Proveedor de correo no reconocido: ${env.CORREO_PROVEEDOR}`);
  return { enviado: false, proveedor: env.CORREO_PROVEEDOR };
}

export function plantillaEnlaceMagico(url, minutos) {
  const texto = [
    'Para entrar en la plataforma de registro de jornada, abra este enlace:',
    '',
    url,
    '',
    `El enlace caduca en ${minutos} minutos y sólo puede usarse una vez.`,
    'Si no ha pedido entrar, ignore este mensaje.',
  ].join('\n');
  return { asunto: 'Su enlace de acceso', texto };
}

export function plantillaResumenIncidencias(empresa, incidencias, urlPanel) {
  const lineas = incidencias.map(
    (i) => `  · ${i.fecha}  ${i.empleado}  —  ${i.descripcion}`,
  );
  const texto = [
    `Incidencias de registro de jornada en ${empresa.nombre}:`,
    '',
    ...lineas,
    '',
    'Puede revisarlas y resolverlas en el panel:',
    urlPanel,
    '',
    'Este aviso es automático. No es necesario responder.',
  ].join('\n');
  const plural = incidencias.length === 1 ? 'incidencia' : 'incidencias';
  return {
    asunto: `${incidencias.length} ${plural} de fichaje en ${empresa.nombre}`,
    texto,
  };
}
