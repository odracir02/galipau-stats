// Autenticación y autorización. Toda operación pasa por authorize(),
// authorizeClub() o authorizePlatform(): el permiso se comprueba aquí, nunca
// solo en la interfaz.
//
// Dos credenciales, que no se mezclan:
//   * token de dispositivo («Authorization: Bearer»): permisos de equipo
//     (entrenador, consulta). Nunca da roles administrativos.
//   * Cloudflare Access (cabecera Cf-Access-Jwt-Assertion): identifica a una
//     persona; sus roles (superadministrador, administrador de club) salen de
//     admin_identities/admin_roles. Pasar por Access no da ningún rol.
import type { Id } from '../../src/domain/types';
import { verifyAccessJwt, type AccessClaims, type AccessConfig } from './access';
import type { Db } from './db';
import { HttpError, forbidden, notFound, unauthorized } from './errors';
import type { AdminRoleGrant, AuthContext, Grant, Role } from './model';
import { clubRoleAllows, CRITICAL_ACTIONS, roleAllows, type Action, type ClubAction, type PlatformAction } from './permissions';
import { hashSecret } from './secrets';

/** Resuelve el token de un dispositivo y sus permisos de equipo vigentes. */
export async function authenticate(db: Db, token: string | null, pepper: string, now = new Date()): Promise<AuthContext> {
  if (!token) throw unauthorized();
  const row = await db
    .prepare(
      `SELECT d.id AS device_id FROM device_tokens t JOIN devices d ON d.id = t.device_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND d.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > ?)`,
    )
    .bind(await hashSecret(token, pepper), now.toISOString())
    .first<{ device_id: string }>();
  if (!row) throw unauthorized();
  const { results } = await db
    .prepare(
      `SELECT id, device_id AS deviceId, club_id AS clubId, team_id AS teamId, role
       FROM grants WHERE device_id = ? AND revoked_at IS NULL`,
    )
    .bind(row.device_id)
    .all<Grant>();
  return { deviceId: row.device_id, grants: results };
}

const notAdmin = () => new HttpError(403, 'not_admin', 'Esta cuenta no tiene permisos de administración.');

/**
 * Convierte una identidad ya verificada por Access en un contexto
 * administrativo. Exige una identidad activa con ese correo y al menos un rol
 * vigente. La primera vez fija el «sub» de Access; después debe coincidir.
 */
export async function adminContext(db: Db, claims: AccessClaims, now = new Date()): Promise<AuthContext> {
  const identity = await db
    .prepare('SELECT id, access_subject FROM admin_identities WHERE email = ? AND disabled_at IS NULL')
    .bind(claims.email)
    .first<{ id: string; access_subject: string | null }>();
  if (!identity) throw notAdmin();
  if (identity.access_subject !== null && identity.access_subject !== claims.sub) {
    throw new HttpError(403, 'identity_mismatch', 'La cuenta no coincide con la registrada para este correo.');
  }
  const { results: roles } = await db
    .prepare('SELECT role, club_id AS clubId FROM admin_roles WHERE identity_id = ? AND revoked_at IS NULL')
    .bind(identity.id)
    .all<AdminRoleGrant>();
  if (roles.length === 0) throw notAdmin();
  // Vinculación en el primer acceso (solo si sigue libre) y último acceso. Si
  // otra cuenta se vinculó a la vez, no se actualiza nada y se rechaza.
  const bound = await db
    .prepare(
      `UPDATE admin_identities SET access_subject = COALESCE(access_subject, ?), last_login_at = ?
       WHERE id = ? AND (access_subject IS NULL OR access_subject = ?)`,
    )
    .bind(claims.sub, now.toISOString(), identity.id, claims.sub)
    .run();
  if (bound.meta.changes !== 1) {
    throw new HttpError(403, 'identity_mismatch', 'La cuenta no coincide con la registrada para este correo.');
  }
  return { deviceId: null, grants: [], admin: { identityId: identity.id, email: claims.email, roles, critical: claims.critical } };
}

/**
 * Autenticación de una petición de administración. Sin configuración de Access
 * la administración está desactivada (503), en cualquier entorno.
 */
export async function authenticateAdmin(db: Db, request: Request, config: AccessConfig | null, now = new Date()): Promise<AuthContext> {
  if (!config) throw new HttpError(503, 'admin_disabled', 'La administración no está configurada en este entorno.');
  const claims = await verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), config, now);
  // Mientras las operaciones críticas no estén habilitadas, ningún token cuenta como crítico.
  return adminContext(db, { ...claims, critical: claims.critical && config.criticalEnabled }, now);
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

function requireCritical(auth: AuthContext, action: ClubAction | PlatformAction): void {
  if (CRITICAL_ACTIONS.includes(action) && !auth.admin?.critical) {
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
  // Un equipo solo es accesible si ni él ni su club están eliminados.
  const team = await db
    .prepare(
      `SELECT t.id, t.club_id AS clubId FROM teams t JOIN clubs c ON c.id = t.club_id
       WHERE t.id = ? AND t.deleted_at IS NULL AND c.deleted_at IS NULL`,
    )
    .bind(teamId)
    .first<{ id: string; clubId: string }>();
  if (!team) throw notFound();
  const role = effectiveRole(auth, team);
  if (!role) throw notFound();
  if (!roleAllows(role, action)) throw forbidden();
  return { ...team, role };
}

/** Operaciones sobre un club: superadministrador o administrador de ESE club. */
export async function authorizeClub(db: Db, auth: AuthContext, clubId: Id, action: ClubAction): Promise<{ id: Id; role: 'superadmin' | 'club_admin' }> {
  const club = await db.prepare('SELECT id FROM clubs WHERE id = ? AND deleted_at IS NULL').bind(clubId).first<{ id: string }>();
  if (!club) throw notFound();
  const role = isSuperadmin(auth) ? 'superadmin' : isClubAdmin(auth, clubId) ? 'club_admin' : null;
  if (!role) throw notFound();
  if (!clubRoleAllows(role, action)) throw forbidden();
  requireCritical(auth, action);
  return { id: club.id, role };
}

/** Operaciones de plataforma: solo superadministrador. */
export function authorizePlatform(auth: AuthContext, action: PlatformAction): void {
  if (!isSuperadmin(auth)) throw forbidden();
  requireCritical(auth, action);
}

/** Lee el token de dispositivo de la cabecera Authorization. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1]! : null;
}
