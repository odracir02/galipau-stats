// Límites propios, además del límite por IP de la biblioteca. Usan la tabla
// auth_attempts (ventanas fijas) igual que el canje de códigos de equipo, con otro
// prefijo de clave. El correo y la cuenta se guardan como HMAC, nunca en claro.
// Cada comprobación es una única sentencia: atómica también con peticiones simultáneas.
import type { Db } from '../db';
import { HttpError } from '../errors';
import { hashSecret } from '../secrets';
import { normalizeEmail } from './policy';

export const EMAIL_CODE_LIMIT = { attempts: 5, windowSeconds: 60 * 60 };
export const CLUB_CREATION_LIMIT = { attempts: 3, windowSeconds: 24 * 60 * 60 };

/** Cuenta un uso y devuelve false si ya se ha alcanzado el máximo de la ventana. */
async function consume(db: Db, key: string, limit: { attempts: number; windowSeconds: number }, pepper: string, now: Date) {
  const bucket = await hashSecret(key, pepper);
  const windowStart = Math.floor(now.getTime() / 1000 / limit.windowSeconds) * limit.windowSeconds;
  const row = await db
    .prepare(
      `INSERT INTO auth_attempts (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    )
    .bind(bucket, windowStart, limit.attempts)
    .first<{ count: number }>();
  return row !== null;
}

/** Solicitudes de código por dirección de correo, sea cual sea la IP. */
export async function allowCodeRequest(db: Db, email: string, pepper: string, now = new Date()): Promise<boolean> {
  return consume(db, `account-code:${normalizeEmail(email)}`, EMAIL_CODE_LIMIT, pepper, now);
}

export const tooManyClubs = () => new HttpError(429, 'too_many_attempts', 'Has creado demasiados clubes hoy. Inténtalo mañana.');

/**
 * Límite de altas de club por cuenta (registro libre), para usar dentro del mismo
 * batch que crea el club: `increment` cuenta el alta y `withinLimit` es la condición
 * (SQL y valores) que debe cumplirse para insertar el club. Así el límite es estricto
 * también con peticiones simultáneas, y un reintento del mismo club (que aborta el
 * batch por clave duplicada) no consume nada.
 */
export async function clubCreationGuard(db: Db, userId: string, pepper: string, now = new Date()) {
  const bucket = await hashSecret(`account-club:${userId}`, pepper);
  const windowStart = Math.floor(now.getTime() / 1000 / CLUB_CREATION_LIMIT.windowSeconds) * CLUB_CREATION_LIMIT.windowSeconds;
  return {
    increment: db
      .prepare('INSERT INTO auth_attempts (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1')
      .bind(bucket, windowStart),
    withinLimit: {
      sql: '(SELECT count FROM auth_attempts WHERE bucket = ? AND window_start = ?) <= ?',
      values: [bucket, windowStart, CLUB_CREATION_LIMIT.attempts] as (string | number)[],
    },
  };
}
