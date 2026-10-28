// Protección contra peticiones falsificadas desde otra web (CSRF) en las rutas
// de administración que escriben.
//
// La cookie de Cloudflare Access se envía también en peticiones iniciadas por
// otras webs (SameSite=None por defecto), así que el Worker no puede fiarse de
// que una petición autenticada la haya querido hacer el administrador. Antes de
// cualquier escritura exige:
//
//   1. Origen propio, según el navegador:
//      - Sec-Fetch-Site, si viene, debe ser «same-origin» (ni «same-site», ni
//        «cross-site», ni «none»);
//      - Origin, si viene, debe ser exactamente el origen de la propia API;
//      - si no viene ninguna de las dos, se rechaza. Los navegadores actuales
//        envían siempre al menos una en estas peticiones; un cliente que no es
//        un navegador (scripts) no lleva la cookie de la víctima y puede añadir
//        «Origin» sin problema.
//   2. Cuerpo JSON declarado: Content-Type application/json en POST, PUT y
//      PATCH. Un formulario HTML no puede enviarlo sin una consulta previa del
//      navegador, que la API de administración no autoriza (no hay CORS).
import { HttpError } from './errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const rejected = (reason: string) => new HttpError(403, 'csrf_rejected', 'Petición rechazada: no procede de la propia administración.', { reason });

/** Lanza un error si una petición de escritura no procede del propio origen o no declara JSON. */
export function assertSafeAdminWrite(request: Request): void {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return;

  const fetchSite = request.headers.get('Sec-Fetch-Site');
  const origin = request.headers.get('Origin');
  const self = new URL(request.url).origin;

  if (fetchSite !== null && fetchSite.trim().toLowerCase() !== 'same-origin') throw rejected('fetch_site');
  // «null» (contextos opacos, redirecciones, iframes con sandbox) tampoco vale.
  if (origin !== null && origin !== self) throw rejected('origin');
  if (fetchSite === null && origin === null) throw rejected('missing_headers');

  if (BODY_METHODS.has(method)) {
    const type = (request.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') {
      throw new HttpError(415, 'unsupported_media_type', 'Las operaciones de administración solo aceptan application/json.');
    }
  }
}
