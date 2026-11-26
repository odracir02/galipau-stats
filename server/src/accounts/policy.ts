// Quién puede crear una cuenta y qué cuentas están bloqueadas. Lo consultan tanto
// el filtro previo de las rutas de código (para no enviar correos inútiles) como los
// hooks de la biblioteca (la garantía real: sin ellos no se crea cuenta ni sesión).
import type { Db } from '../db';

/** Normalización única del correo en todo el módulo (la biblioteca solo pasa a minúsculas). */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Una cuenta nueva solo se crea con el registro libre habilitado o si el correo
 * tiene una invitación pendiente y vigente. El alta pasa siempre por el flujo
 * público de la biblioteca (código por correo), nunca por escrituras directas.
 */
export async function mayCreateAccount(db: Db, email: string, publicSignup: boolean, now = new Date()): Promise<boolean> {
  if (publicSignup) return true;
  const row = await db
    .prepare('SELECT 1 AS ok FROM club_invitations WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? LIMIT 1')
    .bind(normalizeEmail(email), now.toISOString())
    .first();
  return row !== null;
}

export async function isUserDisabled(db: Db, userId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS off FROM account_state WHERE user_id = ? AND status = 'disabled'").bind(userId).first();
  return row !== null;
}

/** Estado de la cuenta asociada a un correo: inexistente, activa o desactivada. */
export async function emailAccountState(db: Db, email: string): Promise<'none' | 'active' | 'disabled'> {
  const row = await db
    .prepare('SELECT s.status AS status FROM auth_user u LEFT JOIN account_state s ON s.user_id = u.id WHERE u.email = ?')
    .bind(normalizeEmail(email))
    .first<{ status: string | null }>();
  if (!row) return 'none';
  return row.status === 'disabled' ? 'disabled' : 'active';
}
