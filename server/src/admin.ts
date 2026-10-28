// Operaciones administrativas. Cada una comprueba el permiso con
// authorizeClub/authorizePlatform y queda en el registro de auditoría.
//
// No existe ninguna operación que conceda el rol de superadministrador: el
// primero se crea con el procedimiento de configuración del servidor
// (scripts/bootstrap-superadmin.mjs), que exige acceso a la cuenta de Cloudflare.
import type { Id } from '../../src/domain/types';
import { newId } from '../../src/domain/ids';
import { assertValidTeamCode, normalizeTeamCode, ValidationError } from '../../src/domain/validation';
import { authorizeClub, authorizePlatform, isSuperadmin } from './auth';
import type { Db, Statement } from './db';
import { HttpError, notFound } from './errors';
import { inviteStatements, seasonExpiry, type InviteSecrets } from './invites';
import type { AuthContext, Gender } from './model';
import { TEAM_ROLES } from './model';

function audit(db: Db, auth: AuthContext, action: string, targetType: string, targetId: Id, at: string): Statement {
  return db
    .prepare('INSERT INTO admin_audit (identity_id, action, target_type, target_id, at) VALUES (?, ?, ?, ?, ?)')
    .bind(auth.admin?.identityId ?? null, action, targetType, targetId, at);
}

function badRequest(e: unknown): never {
  if (e instanceof ValidationError) throw new HttpError(400, 'invalid', e.message);
  throw e;
}

/** Correo normalizado (minúsculas, sin espacios) o error 400. */
export function normalizeEmail(email: unknown): string {
  const value = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) {
    throw new HttpError(400, 'invalid_email', 'Correo electrónico no válido.');
  }
  return value;
}

// --- Consulta -------------------------------------------------------------------

export interface AdminProfile {
  identityId: Id;
  email: string;
  roles: { role: string; clubId: Id | null }[];
}

export function adminProfile(auth: AuthContext): AdminProfile {
  if (!auth.admin) throw new HttpError(403, 'not_admin', 'Esta cuenta no tiene permisos de administración.');
  return { identityId: auth.admin.identityId, email: auth.admin.email, roles: auth.admin.roles };
}

/** Clubes visibles: todos para el superadministrador; los suyos para un administrador de club. */
export interface ClubSummary {
  id: Id;
  name: string;
  shortName: string | null;
  status: 'active' | 'suspended';
}

const CLUB_COLUMNS = 'id, name, short_name AS shortName, status';

/**
 * Clubes visibles: todos (también suspendidos) para el superadministrador; los
 * suyos y activos para un administrador de club.
 */
export async function listClubs(db: Db, auth: AuthContext): Promise<ClubSummary[]> {
  if (!auth.admin) throw new HttpError(403, 'not_admin', 'Esta cuenta no tiene permisos de administración.');
  if (isSuperadmin(auth)) {
    return (await db.prepare(`SELECT ${CLUB_COLUMNS} FROM clubs WHERE deleted_at IS NULL ORDER BY name`).all<ClubSummary>()).results;
  }
  const ids = auth.admin.roles.filter((r) => r.role === 'club_admin' && r.clubId).map((r) => r.clubId!);
  if (ids.length === 0) return [];
  return (
    await db
      .prepare(`SELECT ${CLUB_COLUMNS} FROM clubs WHERE deleted_at IS NULL AND status = 'active' AND id IN (${ids.map(() => '?').join(', ')}) ORDER BY name`)
      .bind(...ids)
      .all<ClubSummary>()
  ).results;
}

export interface TeamSummary {
  id: Id;
  name: string;
  code: string;
  season: string;
  category: string | null;
  gender: Gender | null;
  /** Qué códigos de invitación están vigentes (sin el código: se consulta aparte). */
  codes: { coach: boolean; viewer: boolean };
}

/** Ficha de un club con sus equipos (de todas las temporadas, las más recientes primero). */
export async function getClub(db: Db, auth: AuthContext, clubId: Id, now = new Date()): Promise<ClubSummary & { teams: TeamSummary[] }> {
  await authorizeClub(db, auth, clubId, 'club.read');
  const club = await db.prepare(`SELECT ${CLUB_COLUMNS} FROM clubs WHERE id = ?`).bind(clubId).first<ClubSummary>();
  const { results: teams } = await db
    .prepare(
      `SELECT id, name, code, season, category, gender FROM teams WHERE club_id = ? AND deleted_at IS NULL
       ORDER BY season DESC, name`,
    )
    .bind(clubId)
    .all<Omit<TeamSummary, 'codes'>>();
  const { results: active } = await db
    .prepare(
      `SELECT team_id, role FROM invites WHERE club_id = ? AND revoked_at IS NULL AND expires_at > ?
         AND (max_uses IS NULL OR use_count < max_uses)`,
    )
    .bind(clubId, now.toISOString())
    .all<{ team_id: string; role: string }>();
  return {
    ...club!,
    teams: teams.map((t) => ({
      ...t,
      codes: {
        coach: active.some((a) => a.team_id === t.id && a.role === 'coach'),
        viewer: active.some((a) => a.team_id === t.id && a.role === 'viewer'),
      },
    })),
  };
}

const text = (value: unknown, field: string, max = 120): string => {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v || v.length > max) throw new HttpError(400, 'invalid', `${field} no válido.`);
  return v;
};
const optionalText = (value: unknown, max = 60): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) throw new HttpError(400, 'invalid', 'Dato no válido.');
  return value.trim() || null;
};
const GENDERS: readonly Gender[] = ['male', 'female', 'mixed'];
const gender = (value: unknown): Gender | null => {
  if (value === undefined || value === null || value === '') return null;
  if (!GENDERS.includes(value as Gender)) throw new HttpError(400, 'invalid', 'Modalidad no válida.');
  return value as Gender;
};

/** Edita nombre y nombre corto del club (superadministrador o su administrador). */
export async function updateClub(db: Db, auth: AuthContext, clubId: Id, args: { name?: unknown; shortName?: unknown }, now = new Date()): Promise<void> {
  await authorizeClub(db, auth, clubId, 'club.manage');
  const at = now.toISOString();
  await db.batch([
    db
      .prepare('UPDATE clubs SET name = ?, short_name = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .bind(text(args.name, 'Nombre del club'), optionalText(args.shortName), at, clubId),
    audit(db, auth, 'club.update', 'club', clubId, at),
  ]);
}

/** Suspende o reactiva un club (solo superadministrador). Reversible; no borra nada. */
export async function setClubStatus(db: Db, auth: AuthContext, clubId: Id, status: unknown, now = new Date()): Promise<void> {
  if (status !== 'active' && status !== 'suspended') throw new HttpError(400, 'invalid', 'Estado no válido.');
  await authorizeClub(db, auth, clubId, 'club.status.manage');
  const at = now.toISOString();
  await db.batch([
    db.prepare('UPDATE clubs SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?').bind(status, at, clubId),
    audit(db, auth, status === 'active' ? 'club.reactivate' : 'club.suspend', 'club', clubId, at),
  ]);
}

// --- Clubes (superadministrador, operación crítica) ---------------------------

export async function createClub(db: Db, auth: AuthContext, args: { name?: unknown; shortName?: unknown }, now = new Date()): Promise<Id> {
  authorizePlatform(auth, 'platform.clubs.manage');
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name || name.length > 120) throw new HttpError(400, 'invalid', 'El nombre del club es obligatorio.');
  const shortName = typeof args.shortName === 'string' && args.shortName.trim() ? args.shortName.trim() : null;
  const id = newId();
  const at = now.toISOString();
  await db.batch([
    db.prepare('INSERT INTO clubs (id, name, short_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, shortName, at, at),
    audit(db, auth, 'club.create', 'club', id, at),
  ]);
  return id;
}

/** Eliminación lógica: deja de ser accesible para sus administradores, entrenadores y familias. */
export async function deleteClub(db: Db, auth: AuthContext, clubId: Id, now = new Date()): Promise<void> {
  authorizePlatform(auth, 'platform.clubs.manage');
  const club = await db.prepare('SELECT 1 AS x FROM clubs WHERE id = ? AND deleted_at IS NULL').bind(clubId).first();
  if (!club) throw notFound();
  const at = now.toISOString();
  await db.batch([
    db.prepare('UPDATE clubs SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL').bind(at, at, clubId),
    audit(db, auth, 'club.delete', 'club', clubId, at),
  ]);
}

// --- Equipos (superadministrador o administrador del club) --------------------

/**
 * Crea un equipo con sus dos códigos de invitación (entrenador y consulta), en
 * una sola transacción: nunca queda un equipo sin códigos. El identificador
 * (p. ej. SMA2627) es único en el club y no da acceso.
 */
export async function createTeam(
  db: Db,
  auth: AuthContext,
  args: { clubId: Id; name: unknown; code: unknown; season: unknown; category?: unknown; gender?: unknown },
  secrets: InviteSecrets,
  now = new Date(),
): Promise<{ teamId: Id; codes: Record<'coach' | 'viewer', { code: string; expiresAt: string }> }> {
  await authorizeClub(db, auth, args.clubId, 'club.teams.manage');
  const code = normalizeTeamCode(typeof args.code === 'string' ? args.code : '');
  try {
    assertValidTeamCode(code);
  } catch (e) {
    badRequest(e);
  }
  const season = text(args.season, 'Temporada', 7);
  const expiresAt = seasonExpiry(season);
  const name = text(args.name, 'Nombre del equipo');
  const taken = await db.prepare('SELECT 1 AS x FROM teams WHERE club_id = ? AND code = ?').bind(args.clubId, code).first();
  if (taken) throw new HttpError(409, 'code_taken', `El club ya tiene un equipo con el código ${code}.`);
  const id = newId();
  const at = now.toISOString();
  const statements: Statement[] = [
    db
      .prepare(
        'INSERT INTO teams (id, club_id, name, code, season, category, gender, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(id, args.clubId, name, code, season, optionalText(args.category), gender(args.gender), at, at),
  ];
  const codes = {} as Record<'coach' | 'viewer', { code: string; expiresAt: string }>;
  for (const role of TEAM_ROLES) {
    const created = await inviteStatements(db, { clubId: args.clubId, teamId: id, role, expiresAt, createdByDeviceId: null }, secrets, now);
    statements.push(...created.statements);
    codes[role] = { code: created.invite.code, expiresAt: created.invite.expiresAt };
  }
  statements.push(audit(db, auth, 'team.create', 'team', id, at));
  await db.batch(statements);
  return { teamId: id, codes };
}

/** Edita nombre, categoría y modalidad de un equipo. El identificador y la temporada no cambian. */
export async function updateTeam(
  db: Db,
  auth: AuthContext,
  teamId: Id,
  args: { name?: unknown; category?: unknown; gender?: unknown },
  now = new Date(),
): Promise<void> {
  const team = await db.prepare('SELECT club_id AS clubId FROM teams WHERE id = ? AND deleted_at IS NULL').bind(teamId).first<{ clubId: string }>();
  if (!team) throw notFound();
  await authorizeClub(db, auth, team.clubId, 'club.teams.manage');
  const at = now.toISOString();
  await db.batch([
    db
      .prepare('UPDATE teams SET name = ?, category = ?, gender = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .bind(text(args.name, 'Nombre del equipo'), optionalText(args.category), gender(args.gender), at, teamId),
    audit(db, auth, 'team.update', 'team', teamId, at),
  ]);
}

// --- Administradores de club (superadministrador, operación crítica) ----------

/**
 * Nombra administrador de un club a la persona con ese correo. Crea su
 * identidad si no existe. La persona entrará con Cloudflare Access usando ese
 * correo (su política debe permitirlo); el rol lo da esta tabla, no Access.
 */
export async function appointClubAdmin(
  db: Db,
  auth: AuthContext,
  args: { clubId: Id; email: unknown; displayName?: unknown },
  now = new Date(),
): Promise<{ identityId: Id }> {
  await authorizeClub(db, auth, args.clubId, 'club.admins.manage');
  const email = normalizeEmail(args.email);
  const at = now.toISOString();
  const existing = await db
    .prepare('SELECT id, disabled_at FROM admin_identities WHERE email = ?')
    .bind(email)
    .first<{ id: string; disabled_at: string | null }>();
  if (existing?.disabled_at) throw new HttpError(409, 'identity_disabled', 'Esa identidad está desactivada.');
  const active = existing
    ? await db
        .prepare("SELECT 1 AS x FROM admin_roles WHERE identity_id = ? AND club_id = ? AND role = 'club_admin' AND revoked_at IS NULL")
        .bind(existing.id, args.clubId)
        .first()
    : null;
  if (active) throw new HttpError(409, 'already_admin', 'Ya es administrador de este club.');

  const identityId = existing?.id ?? newId();
  const statements: Statement[] = [];
  if (!existing) {
    const displayName = typeof args.displayName === 'string' && args.displayName.trim() ? args.displayName.trim() : email;
    statements.push(
      db.prepare('INSERT INTO admin_identities (id, display_name, email, created_at) VALUES (?, ?, ?, ?)').bind(identityId, displayName, email, at),
    );
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO admin_roles (id, identity_id, role, club_id, granted_by_identity_id, created_at) VALUES (?, ?, 'club_admin', ?, ?, ?)",
      )
      .bind(newId(), identityId, args.clubId, auth.admin!.identityId, at),
    audit(db, auth, 'club_admin.appoint', 'club', args.clubId, at),
  );
  await db.batch(statements);
  return { identityId };
}

/** Retira el rol de administrador de club. Efecto inmediato: los roles se leen en cada petición. */
export async function revokeClubAdmin(db: Db, auth: AuthContext, args: { clubId: Id; identityId: Id }, now = new Date()): Promise<void> {
  await authorizeClub(db, auth, args.clubId, 'club.admins.manage');
  const role = await db
    .prepare("SELECT id FROM admin_roles WHERE identity_id = ? AND club_id = ? AND role = 'club_admin' AND revoked_at IS NULL")
    .bind(args.identityId, args.clubId)
    .first<{ id: string }>();
  if (!role) throw notFound();
  const at = now.toISOString();
  await db.batch([
    db.prepare('UPDATE admin_roles SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(at, role.id),
    audit(db, auth, 'club_admin.revoke', 'club', args.clubId, at),
  ]);
}
