import type { Id } from './types';

/** Identificador único y estable (UUID v4), generado en el dispositivo. */
export function newId(): Id {
  return crypto.randomUUID();
}

let lastIssuedMs = 0;

/**
 * Marca de tiempo ISO estrictamente creciente dentro de la sesión, para que el
 * orden de registro (y por tanto «Deshacer») nunca dependa de empates de milisegundo.
 */
export function monotonicIsoNow(now: number = Date.now()): string {
  lastIssuedMs = Math.max(now, lastIssuedMs + 1);
  return new Date(lastIssuedMs).toISOString();
}
