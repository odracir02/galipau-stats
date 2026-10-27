/** Error con código HTTP y código estable para el cliente. */
export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string = code,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unauthorized = () => new HttpError(401, 'unauthorized', 'Credencial ausente, caducada o revocada.');
/** Mismo error para «no existe» y «no autorizado»: no revela qué equipos existen. */
export const notFound = () => new HttpError(404, 'not_found', 'No encontrado.');
export const forbidden = () => new HttpError(403, 'forbidden', 'Este dispositivo no tiene permiso para esta operación.');
