// Operaciones administrativas. Solo la lógica del servidor: los paneles y las
// rutas llegarán en una fase posterior. Cada operación comprueba el permiso con
// authorizeClub/authorizePlatform y queda en el registro de auditoría.
//
// No existe ninguna operación que conceda el rol de superadministrador: el
// primero se crea con el procedimiento de configuración del servidor
// (scripts/bootstrap-superadmin.mjs), que exige acceso a la cuenta de Cloudflare.
import type { Id } from '../../src/domain/types';
import { newId } from '../../src/domain/ids';
import { assertValidTeamCode, normalizeTeamCode, ValidationError } from '../../src/domain/validation';
import { authorizeClub, authorizePlatform } from './auth';
import type { Db, Statement } from './db';
import { HttpError, notFound } from './errors';
import type { AuthContext, Gender } from './model';
import { generateInviteCode, hashSecret, normalizeInviteCode } from './secrets';

/** Caducidad del enlace de alta de credencial de un administrador. */
export const ADMIN_ENROLLMENT_MINUTES = 30;

function audit(db: Db, auth: AuthContext, action: string, targetType: string, targetId: Id, at: string): Statement {
  return db
    .prepare('INSERT INTO admin_audit (identity_id, action, target_type, target_id, at) VALUES (?, ?, ?, ?, ?)')
    .bind(auth.admin?.identityId ?? null, action, targetType, targetId, at);
}

function badRequest(e: unknown): never {
  if (e instanceof ValidationError) throw new HttpError(400, 'invalid', e.message);
  throw e;
}

// --- Clubes (superadministrador) ---------------------------------------------

export async function createClub(db: Db, auth: AuthContext, args: { name: string; shortName?: string | null }, now = new Date()): Promise<Id> {
  authorizePlatform(auth, 'platform.clubs.manage', now);
  const name = args.name.trim();
  if (!name) throw new HttpError(400, 'invalid', 'El nombre del club es obligatorio.');
  const id = newId();
  const at = now.toISOString();
  await db.batch([
    db.prepare('INSERT INTO clubs (id, name, short_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, args.shortName ?? null, at, at),
    audit(db, auth, 'club.create', 'club', id, at),
  ]);
  return id;
}

/** Eliminación lógica: deja de ser accesible para todos salvo el superadministrador. */
export async function deleteClub(db: Db, auth: AuthContext, clubId: Id, now = new Date()): Promise<void> {
  authorizePlatform(auth, 'platform.clubs.manage', now);
  const at = now.toISOString();
  const [res] = await db.batch([
    db.prepare('UPDATE clubs SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL').bind(at, at, clubId),
    audit(db, auth, 'club.delete', 'club', clubId, at),
  ]);
  if (!res?.meta.changes) throw notFound();
}

// --- Equipos (superadministrador o administrador del club) --------------------

export async function createTeam(
  db: Db,
  auth: AuthContext,
  args: { clubId: Id; name: string; code: string; season: string; category?: string | null; gender?: Gender | null },
  now = new Date(),
): Promise<Id> {
  await authorizeClub(db, auth, args.clubId, 'club.teams.manage', now);
  const code = normalizeTeamCode(args.code);
  try {
    assertValidTeamCode(code);
  } catch (e) {
    badRequest(e);
  }
  const taken = await db.prepare('SELECT 1 AS x FROM teams WHERE club_id = ? AND code = ?').bind(args.clubId, code).first();
  if (taken) throw new HttpError(409, 'code_taken', `El club ya tiene un equipo con el código ${code}.`);
  const id = newId();
  const at = now.toISOString();
  await db.batch([
    db
      .prepare(
        'INSERT INTO teams (id, club_id, name, code, season, category, gender, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(id, args.clubId, args.name.trim(), code, args.season.trim(), args.category ?? null, args.gender ?? null, at, at),
    audit(db, auth, 'team.create', 'team', id, at),
  ]);
  return id;
}

// --- Administradores de club (superadministrador) -----------------------------

export interface ClubAdminInvite {
  identityId: Id;
  /** Código de alta de credencial, de un solo uso: se entrega en persona y no se guarda. */
  enrollmentCode: string;
  expiresAt: string;
}

/**
 * Nombra administrador de un club a una persona. Crea su identidad (o reutiliza
 * una existente), el rol y un código de alta de un solo uso con el que, en la
 * fase siguiente, registrará su llave de acceso. Solo el superadministrador,
 * con verificación reciente.
 */
export async function appointClubAdmin(
  db: Db,
  auth: AuthContext,
  args: { clubId: Id; identityId?: Id; displayName: string },
  pepper: string,
  now = new Date(),
): Promise<ClubAdminInvite> {
  await authorizeClub(db, auth, args.clubId, 'club.admins.manage', now);
  const at = now.toISOString();
  const identityId = args.identityId ?? newId();
  const statements: Statement[] = [];
  if (args.identityId) {
    const exists = await db.prepare('SELECT 1 AS x FROM admin_identities WHERE id = ? AND disabled_at IS NULL').bind(args.identityId).first();
    if (!exists) throw notFound();
  } else {
    statements.push(
      db.prepare('INSERT INTO admin_identities (id, display_name, created_at) VALUES (?, ?, ?)').bind(identityId, args.displayName.trim(), at),
    );
  }
  const code = generateInviteCode(16);
  const expiresAt = new Date(now.getTime() + ADMIN_ENROLLMENT_MINUTES * 60_000).toISOString();
  statements.push(
    db
      .prepare(
        "INSERT INTO admin_roles (id, identity_id, role, club_id, granted_by_identity_id, created_at) VALUES (?, ?, 'club_admin', ?, ?, ?)",
      )
      .bind(newId(), identityId, args.clubId, auth.admin!.identityId, at),
    db
      .prepare(
        'INSERT INTO admin_enrollments (id, identity_id, code_hash, created_by_identity_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(newId(), identityId, await hashSecret(`enroll:${normalizeInviteCode(code)}`, pepper), auth.admin!.identityId, at, expiresAt),
    audit(db, auth, 'club_admin.appoint', 'club', args.clubId, at),
  );
  await db.batch(statements);
  return { identityId, enrollmentCode: code, expiresAt };
}

/** Retira el rol de administrador de club y cierra sus sesiones abiertas si ya no le queda ningún rol. */
export async function revokeClubAdmin(db: Db, auth: AuthContext, args: { clubId: Id; identityId: Id }, now = new Date()): Promise<void> {
  await authorizeClub(db, auth, args.clubId, 'club.admins.manage', now);
  const at = now.toISOString();
  const [res] = await db.batch([
    db
      .prepare("UPDATE admin_roles SET revoked_at = ? WHERE identity_id = ? AND club_id = ? AND role = 'club_admin' AND revoked_at IS NULL")
      .bind(at, args.identityId, args.clubId),
    db
      .prepare(
        `UPDATE admin_sessions SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM admin_roles WHERE identity_id = ? AND revoked_at IS NULL)`,
      )
      .bind(at, args.identityId, args.identityId),
    audit(db, auth, 'club_admin.revoke', 'club', args.clubId, at),
  ]);
  if (!res?.meta.changes) throw notFound();
}
