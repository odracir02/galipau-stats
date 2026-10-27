// Autenticación y autorización. Toda operación pasa por authorize(),
// authorizeClub() o authorizePlatform(): el permiso se comprueba aquí, nunca
// solo en la interfaz.
//
// Dos tipos de credencial, ambas en «Authorization: Bearer»:
//   * token de dispositivo: permisos de equipo (entrenador, consulta);
//   * sesión administrativa: emitida solo tras una verificación fuerte; añade
//     los roles de superadministrador o administrador de club de una identidad
//     a los permisos del dispositivo donde se inició.
import type { Id } from '../../src/domain/types';
import type { Db } from './db';
import { HttpError, forbidden, notFound, unauthorized } from './errors';
import type { AdminRoleGrant, AuthContext, Grant, Role } from './model';
import {
  clubRoleAllows,
  RECENT_AUTH_ACTIONS,
  RECENT_AUTH_MINUTES,
  roleAllows,
  type Action,
  type ClubAction,
  type PlatformAction,
} from './permissions';
import { hashSecret } from './secrets';

async function deviceGrants(db: Db, deviceId: Id): Promise<Grant[]> {
  const { results } = await db
    .prepare(
      `SELECT id, device_id AS deviceId, club_id AS clubId, team_id AS teamId, role
       FROM grants WHERE device_id = ? AND revoked_at IS NULL`,
    )
    .bind(deviceId)
    .all<Grant>();
  return results;
}

/** Resuelve el token del dispositivo o de la sesión administrativa. */
export async function authenticate(db: Db, token: string | null, pepper: string, now = new Date()): Promise<AuthContext> {
  if (!token) throw unauthorized();
  const hash = await hashSecret(token, pepper);
  const nowIso = now.toISOString();

  const device = await db
    .prepare(
      `SELECT d.id AS device_id FROM device_tokens t JOIN devices d ON d.id = t.device_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND d.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > ?)`,
    )
    .bind(hash, nowIso)
    .first<{ device_id: string }>();
  if (device) return { deviceId: device.device_id, grants: await deviceGrants(db, device.device_id) };

  const session = await db
    .prepare(
      `SELECT s.identity_id, s.device_id, s.mfa_verified_at FROM admin_sessions s
       JOIN admin_identities i ON i.id = s.identity_id
       JOIN devices d ON d.id = s.device_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
         AND i.disabled_at IS NULL AND d.revoked_at IS NULL`,
    )
    .bind(hash, nowIso)
    .first<{ identity_id: string; device_id: string; mfa_verified_at: string }>();
  if (!session) throw unauthorized();
  const { results: roles } = await db
    .prepare('SELECT role, club_id AS clubId FROM admin_roles WHERE identity_id = ? AND revoked_at IS NULL')
    .bind(session.identity_id)
    .all<AdminRoleGrant>();
  return {
    deviceId: session.device_id,
    grants: await deviceGrants(db, session.device_id),
    admin: { identityId: session.identity_id, roles, verifiedAt: session.mfa_verified_at },
  };
}

const RANK: Record<Role, number> = { viewer: 1, coach: 2, club_admin: 3, superadmin: 4 };

export function isSuperadmin(auth: AuthContext): boolean {
  return auth.admin?.roles.some((r) => r.role === 'superadmin') ?? false;
}

function isClubAdmin(auth: AuthContext, clubId: Id): boolean {
  return auth.admin?.roles.some((r) => r.role === 'club_admin' && r.clubId === clubId) ?? false;
}

/** Rol efectivo en un equipo: el mayor entre superadmin, administrador de su club y el permiso del equipo. */
export function effectiveRole(auth: AuthContext, team: { id: Id; clubId: Id }): Role | null {
  if (isSuperadmin(auth)) return 'superadmin';
  if (isClubAdmin(auth, team.clubId)) return 'club_admin';
  let best: Role | null = null;
  for (const g of auth.grants) {
    // Un permiso de equipo solo vale si el equipo sigue en el mismo club.
    if (g.teamId !== team.id || g.clubId !== team.clubId) continue;
    if (!best || RANK[g.role] > RANK[best]) best = g.role;
  }
  return best;
}

function requireRecentAuth(auth: AuthContext, action: ClubAction | PlatformAction, now: Date): void {
  if (!RECENT_AUTH_ACTIONS.includes(action)) return;
  const verified = auth.admin ? Date.parse(auth.admin.verifiedAt) : NaN;
  if (!(now.getTime() - verified <= RECENT_AUTH_MINUTES * 60_000)) {
    throw new HttpError(401, 'reauth_required', 'Vuelve a verificar tu identidad para esta operación.');
  }
}

export interface AuthorizedTeam {
  id: Id;
  clubId: Id;
  role: Role;
}

/**
 * Comprueba que se puede hacer `action` en el equipo. Sin ningún permiso sobre
 * él responde 404 (no revela que exista); con permiso insuficiente, 403.
 */
export async function authorize(db: Db, auth: AuthContext, teamId: Id, action: Action): Promise<AuthorizedTeam> {
  const team = await db
    .prepare('SELECT id, club_id AS clubId FROM teams WHERE id = ? AND deleted_at IS NULL')
    .bind(teamId)
    .first<{ id: string; clubId: string }>();
  if (!team) throw notFound();
  const role = effectiveRole(auth, team);
  if (!role) throw notFound();
  if (!roleAllows(role, action)) throw forbidden();
  return { ...team, role };
}

/** Operaciones sobre un club: superadministrador o administrador de ESE club. */
export async function authorizeClub(
  db: Db,
  auth: AuthContext,
  clubId: Id,
  action: ClubAction,
  now = new Date(),
): Promise<{ id: Id; role: 'superadmin' | 'club_admin' }> {
  const club = await db.prepare('SELECT id FROM clubs WHERE id = ? AND deleted_at IS NULL').bind(clubId).first<{ id: string }>();
  if (!club) throw notFound();
  const role = isSuperadmin(auth) ? 'superadmin' : isClubAdmin(auth, clubId) ? 'club_admin' : null;
  if (!role) throw notFound();
  if (!clubRoleAllows(role, action)) throw forbidden();
  requireRecentAuth(auth, action, now);
  return { id: club.id, role };
}

/** Operaciones de plataforma: solo superadministrador. */
export function authorizePlatform(auth: AuthContext, action: PlatformAction, now = new Date()): void {
  if (!auth.admin) throw forbidden();
  if (!isSuperadmin(auth)) throw forbidden();
  requireRecentAuth(auth, action, now);
}

/** Lee el token de la cabecera Authorization. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1]! : null;
}
