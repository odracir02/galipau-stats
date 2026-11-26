// Clubes autogestionados: propietario, administradores, invitaciones, transferencias
// de propiedad y desactivación de cuentas.
//
// Reglas de integridad (ver migrations/0008_accounts.sql):
//   - Toda operación de varios pasos es un único batch de D1 (transacción) o una
//     sola sentencia cuyos triggers completan el resto. Nunca hay escrituras
//     parciales.
//   - Los resultados se confirman con RETURNING: en D1, meta.changes incluye las
//     filas que modifican los triggers y no sirve para saber si se aplicó.
//   - Los reintentos son idempotentes: repetir una operación ya hecha devuelve el
//     mismo resultado sin duplicar nada.
//   - Las invariantes (un propietario, nunca ninguno, cuentas activas…) las impone
//     la base de datos; el código solo traduce sus errores.
import type { Db, Statement } from '../db';
import { HttpError, notFound } from '../errors';
import { clubCreationGuard, tooManyClubs } from './limits';
import { normalizeEmail } from './policy';

export interface AccountUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export type ClubRole = 'owner' | 'admin';

export const INVITATION_DAYS = 7;
/** Máximo de invitaciones pendientes (vigentes, sin aceptar ni retirar) por club. */
export const MAX_PENDING_INVITATIONS = 20;
export const TRANSFER_DAYS = 7;

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Errores de los triggers → errores HTTP estables. */
const TRIGGER_ERRORS: Record<string, [number, string]> = {
  club_sin_propietario: [409, 'Un club autogestionado no puede quedarse sin propietario.'],
  propietario_no_valido: [409, 'La cuenta no puede ser propietaria.'],
  ya_es_propietario: [409, 'La cuenta ya es propietaria de este club.'],
  cuenta_desactivada: [409, 'La cuenta está desactivada.'],
  membresia_cerrada: [409, 'La membresía ya estaba cerrada.'],
  membresia_inmutable: [409, 'Una membresía no cambia de club, cuenta ni rol.'],
  invitacion_inmutable: [409, 'Una invitación no se puede redirigir.'],
  propietario_activo: [409, 'Antes hay que transferir la propiedad de los clubes.'],
  invitacion_cerrada: [409, 'La invitación ya no está pendiente.'],
  invitacion_caducada: [410, 'La invitación ha caducado.'],
  invitacion_de_otro_correo: [404, 'No encontrado.'],
  no_es_propietario: [403, 'Solo el propietario puede hacerlo.'],
  destino_no_admin: [409, 'La propiedad solo se transfiere a un administrador del club.'],
  transferencia_cerrada: [409, 'La transferencia ya no está pendiente.'],
  transferencia_caducada: [410, 'La transferencia ha caducado.'],
  propietario_cambiado: [409, 'El propietario del club ha cambiado.'],
};

export function translateDbError(e: unknown): never {
  const message = String((e as Error)?.message ?? e);
  for (const [code, [status, text]] of Object.entries(TRIGGER_ERRORS)) {
    if (message.includes(code)) throw new HttpError(status, code === 'invitacion_de_otro_correo' ? 'not_found' : code, text);
  }
  throw e;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return translateDbError(e);
  }
}

const audit = (db: Db, actor: string | null, clubId: string | null, action: string, targetType: string, targetId: string, at: string) =>
  db
    .prepare('INSERT INTO account_audit (actor_user_id, club_id, action, target_type, target_id, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(actor, clubId, action, targetType, targetId, at);

/** Auditoría solo si se cumple la condición (dentro del mismo batch que la operación). */
const auditIf = (db: Db, condition: string, conditionValues: (string | null)[], actor: string | null, clubId: string | null, action: string, targetType: string, targetId: string, at: string): Statement =>
  db
    .prepare(
      `INSERT INTO account_audit (actor_user_id, club_id, action, target_type, target_id, at)
       SELECT ?, ?, ?, ?, ?, ? WHERE ${condition}`,
    )
    .bind(actor, clubId, action, targetType, targetId, at, ...conditionValues);

const returned = (result: { results?: unknown[] } | undefined) => (result?.results?.length ?? 0) > 0;

/** Rol de la cuenta en el club (null si no tiene ninguno o el club no existe). */
export async function clubRole(db: Db, userId: string, clubId: string): Promise<{ role: ClubRole; status: string } | null> {
  const row = await db
    .prepare(
      `SELECT c.status AS status,
              CASE WHEN EXISTS (SELECT 1 FROM club_owners WHERE club_id = c.id AND user_id = ?2) THEN 'owner'
                   WHEN EXISTS (SELECT 1 FROM club_memberships WHERE club_id = c.id AND user_id = ?2 AND revoked_at IS NULL) THEN 'admin'
              END AS role
       FROM clubs c WHERE c.id = ?1 AND c.deleted_at IS NULL`,
    )
    .bind(clubId, userId)
    .first<{ status: string; role: ClubRole | null }>();
  return row?.role ? { role: row.role, status: row.status } : null;
}

/** Exige un rol; quien no lo tiene recibe 404 (no se revela si el club existe). */
async function requireRole(db: Db, user: AccountUser, clubId: string, needed: 'owner' | 'any', write: boolean): Promise<ClubRole> {
  const r = await clubRole(db, user.id, clubId);
  if (!r) throw notFound();
  if (needed === 'owner' && r.role !== 'owner') throw new HttpError(403, 'owner_required', 'Solo el propietario puede hacerlo.');
  if (write && r.status !== 'active') throw new HttpError(403, 'club_suspended', 'El club está suspendido.');
  return r.role;
}

/**
 * Guardián de las rutas administrativas del club (/api/club/:clubId/*): rol de la
 * cuenta en ese club o 404. No concede nada por tener sesión.
 */
export async function requireClubAccess(db: Db, user: AccountUser, clubId: string): Promise<{ role: ClubRole; status: string }> {
  const r = await clubRole(db, user.id, clubId);
  if (!r) throw notFound();
  return r;
}

// ---------------------------------------------------------------------------
// Cuenta
// ---------------------------------------------------------------------------

export async function accountSummary(db: Db, user: AccountUser, now = new Date()) {
  const { results: clubs } = await db
    .prepare(
      `SELECT c.id, c.name, c.short_name AS shortName, 'owner' AS role FROM clubs c JOIN club_owners o ON o.club_id = c.id
         WHERE o.user_id = ?1 AND c.deleted_at IS NULL
       UNION ALL
       SELECT c.id, c.name, c.short_name AS shortName, 'admin' AS role FROM clubs c JOIN club_memberships m ON m.club_id = c.id
         WHERE m.user_id = ?1 AND m.revoked_at IS NULL AND c.deleted_at IS NULL
       ORDER BY 2`,
    )
    .bind(user.id)
    .all<{ id: string; name: string; shortName: string | null; role: ClubRole }>();
  const { results: invitations } = user.emailVerified
    ? await db
        .prepare(
          `SELECT i.id, i.club_id AS clubId, c.name AS clubName, i.expires_at AS expiresAt
           FROM club_invitations i JOIN clubs c ON c.id = i.club_id
           WHERE i.email = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? AND c.deleted_at IS NULL
           ORDER BY i.created_at`,
        )
        .bind(normalizeEmail(user.email), now.toISOString())
        .all()
    : { results: [] };
  const { results: transfers } = await db
    .prepare(
      `SELECT t.id, t.club_id AS clubId, c.name AS clubName, t.expires_at AS expiresAt
       FROM club_owner_transfers t JOIN clubs c ON c.id = t.club_id
       WHERE t.to_user_id = ? AND t.status = 'pending' AND t.expires_at > ?`,
    )
    .bind(user.id, now.toISOString())
    .all();
  return { user: { id: user.id, email: user.email }, clubs, invitations, transfers };
}

/**
 * Desactivación de la propia cuenta: estado, membresías, transferencias pendientes,
 * invitaciones a su correo y todas sus sesiones, en un solo batch. Si la cuenta es
 * propietaria de algún club, el trigger aborta todo y no cambia nada.
 */
export async function deactivateAccount(db: Db, userId: string, actor: string | null, reason: 'self' | 'superadmin', now = new Date()) {
  const t = now.toISOString();
  return guarded(async () => {
    const res = await db.batch([
      db
        .prepare(
          `INSERT INTO account_state (user_id, status, disabled_at, disabled_reason, updated_at) VALUES (?1, 'disabled', ?2, ?3, ?2)
           ON CONFLICT (user_id) DO UPDATE SET status = 'disabled', disabled_at = ?2, disabled_reason = ?3, updated_at = ?2
           WHERE account_state.status <> 'disabled'`,
        )
        .bind(userId, t, reason),
      db.prepare('UPDATE club_memberships SET revoked_at = ?, revoked_by_user_id = ? WHERE user_id = ? AND revoked_at IS NULL RETURNING id').bind(t, actor, userId),
      db
        .prepare("UPDATE club_owner_transfers SET status = 'cancelled', decided_at = ?1 WHERE status = 'pending' AND (to_user_id = ?2 OR from_user_id = ?2)")
        .bind(t, userId),
      db
        .prepare('UPDATE club_invitations SET revoked_at = ? WHERE email = (SELECT email FROM auth_user WHERE id = ?) AND accepted_at IS NULL AND revoked_at IS NULL')
        .bind(t, userId),
      db.prepare('DELETE FROM auth_session WHERE "userId" = ? RETURNING id').bind(userId),
      audit(db, actor, null, 'account.disable', 'user', userId, t),
    ]);
    return { disabled: true, membershipsRevoked: res[1]?.results?.length ?? 0, sessionsClosed: res[4]?.results?.length ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Alta de club (registro libre)
// ---------------------------------------------------------------------------

/** Texto visible sin caracteres de control y sin espacios sobrantes. */
const printable = (value: string) => [...value].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join('').trim();

function clubName(value: unknown): string {
  const name = typeof value === 'string' ? printable(value) : '';
  if (!name || name.length > 80) throw new HttpError(400, 'bad_request', 'Nombre de club no válido.');
  return name;
}

export const SHORT_NAME_MAX = 24;

/** Nombre corto opcional (cabeceras): vacío = sin nombre corto. */
function clubShortName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'bad_request', 'Nombre corto no válido.');
  const short = printable(value);
  if (short.length > SHORT_NAME_MAX) throw new HttpError(400, 'bad_request', `El nombre corto admite hasta ${SHORT_NAME_MAX} caracteres.`);
  return short || null;
}

/**
 * Crea un club con la cuenta como propietaria inicial, en un solo batch. El
 * identificador lo propone el cliente (UUID): si la petición se repite, devuelve el
 * mismo club en lugar de crear otro.
 */
export async function createOwnedClub(db: Db, user: AccountUser, input: { id?: unknown; name?: unknown; shortName?: unknown }, pepper: string, now = new Date()) {
  const id = typeof input.id === 'string' ? input.id.toLowerCase() : '';
  if (!UUID.test(id)) throw new HttpError(400, 'bad_request', 'Identificador de club no válido.');
  const name = clubName(input.name);
  const shortName = clubShortName(input.shortName);
  if (!user.emailVerified) throw new HttpError(403, 'email_unverified', 'Verifica antes tu correo.');

  const existing = async () => {
    const row = await db
      .prepare('SELECT c.id, c.name, c.short_name AS shortName, o.user_id AS owner FROM clubs c LEFT JOIN club_owners o ON o.club_id = c.id WHERE c.id = ?')
      .bind(id)
      .first<{ id: string; name: string; shortName: string | null; owner: string | null }>();
    if (!row) return null;
    if (row.owner !== user.id) throw new HttpError(409, 'conflict', 'Ese identificador ya está en uso.');
    return { club: { id: row.id, name: row.name, shortName: row.shortName }, created: false };
  };
  const before = await existing();
  if (before) return before;

  // Un único batch: contador del límite, club (solo si no se supera), propietario y
  // auditoría (solo si se ha creado el club). Si el propietario no es válido, el
  // trigger aborta todo y no queda club; si el identificador ya existe, también.
  const t = now.toISOString();
  const guard = await clubCreationGuard(db, user.id, pepper, now);
  let res: Awaited<ReturnType<Db['batch']>>;
  try {
    res = await db.batch([
      guard.increment,
      db
        .prepare(`INSERT INTO clubs (id, name, short_name, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${guard.withinLimit.sql} RETURNING id`)
        .bind(id, name, shortName, t, t, ...guard.withinLimit.values),
      db.prepare('INSERT INTO club_owners (club_id, user_id, since) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM clubs WHERE id = ?)').bind(id, user.id, t, id),
      auditIf(db, 'EXISTS (SELECT 1 FROM club_owners WHERE club_id = ? AND user_id = ?)', [id, user.id], user.id, id, 'club.create', 'club', id, t),
    ]);
  } catch (e) {
    // Dos peticiones iguales a la vez: la segunda encuentra el club de la primera.
    const after = await existing();
    if (after) return after;
    return translateDbError(e);
  }
  if (returned(res[1])) return { club: { id, name, shortName }, created: true };
  const after = await existing();
  if (after) return after;
  throw tooManyClubs();
}

// ---------------------------------------------------------------------------
// Ficha del club
// ---------------------------------------------------------------------------

export async function clubDetail(db: Db, user: AccountUser, clubId: string, now = new Date()) {
  const role = await requireRole(db, user, clubId, 'any', false);
  const [club, owner, admins, invitations, transfer] = await db.batch([
    db.prepare('SELECT id, name, short_name AS shortName, status FROM clubs WHERE id = ?').bind(clubId),
    db.prepare('SELECT u.id AS userId, u.email, o.since FROM club_owners o JOIN auth_user u ON u.id = o.user_id WHERE o.club_id = ?').bind(clubId),
    db
      .prepare('SELECT u.id AS userId, u.email, m.created_at AS since FROM club_memberships m JOIN auth_user u ON u.id = m.user_id WHERE m.club_id = ? AND m.revoked_at IS NULL ORDER BY m.created_at')
      .bind(clubId),
    db
      .prepare('SELECT id, email, expires_at AS expiresAt FROM club_invitations WHERE club_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at')
      .bind(clubId, now.toISOString()),
    db
      .prepare("SELECT id, to_user_id AS toUserId, expires_at AS expiresAt FROM club_owner_transfers WHERE club_id = ? AND status = 'pending' AND expires_at > ?")
      .bind(clubId, now.toISOString()),
  ]);
  const pendingTransfer = (transfer?.results?.[0] as { toUserId: string } | undefined) ?? null;
  return {
    club: club?.results?.[0],
    role,
    owner: owner?.results?.[0] ?? null,
    admins: admins?.results ?? [],
    // Lo pendiente solo lo ve el propietario (y la transferencia, también quien la recibe).
    invitations: role === 'owner' ? invitations?.results ?? [] : [],
    transfer: role === 'owner' || pendingTransfer?.toUserId === user.id ? pendingTransfer : null,
  };
}

/**
 * Resumen de los equipos del club para su panel: solo con rol en ese club, sin
 * códigos de invitación ni datos de jugadores.
 */
export async function clubTeams(db: Db, user: AccountUser, clubId: string) {
  await requireClubAccess(db, user, clubId);
  const { results } = await db
    .prepare(
      `SELECT id, name, code, season, category, gender FROM teams
       WHERE club_id = ? AND deleted_at IS NULL ORDER BY season DESC, name`,
    )
    .bind(clubId)
    .all<{ id: string; name: string; code: string; season: string; category: string | null; gender: string | null }>();
  return { teams: results };
}

// ---------------------------------------------------------------------------
// Invitaciones
// ---------------------------------------------------------------------------

export async function inviteAdmin(db: Db, user: AccountUser, clubId: string, rawEmail: unknown, now = new Date()) {
  await requireRole(db, user, clubId, 'owner', true);
  const email = typeof rawEmail === 'string' ? normalizeEmail(rawEmail) : '';
  if (!EMAIL.test(email) || email.length > 254) throw new HttpError(400, 'bad_request', 'Correo no válido.');
  const taken = await db
    .prepare(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM club_owners o JOIN auth_user u ON u.id = o.user_id WHERE o.club_id = ?1 AND u.email = ?2) THEN 'owner'
                   WHEN EXISTS (SELECT 1 FROM club_memberships m JOIN auth_user u ON u.id = m.user_id WHERE m.club_id = ?1 AND u.email = ?2 AND m.revoked_at IS NULL) THEN 'admin'
              END AS taken`,
    )
    .bind(clubId, email)
    .first<{ taken: string | null }>();
  if (taken?.taken === 'owner') throw new HttpError(409, 'ya_es_propietario', 'Esa cuenta ya es la propietaria del club.');
  if (taken?.taken === 'admin') throw new HttpError(409, 'ya_es_admin', 'Esa cuenta ya administra el club.');

  const t = now.toISOString();
  const id = crypto.randomUUID();
  await guarded(() =>
    db.batch([
      // Una invitación pendiente pero caducada no bloquea la nueva.
      db
        .prepare('UPDATE club_invitations SET revoked_at = ? WHERE club_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= ?')
        .bind(t, clubId, email, t),
      // Solo se inserta si el club no ha llegado al máximo de pendientes vigentes. La
      // cuenta y la inserción son la misma sentencia dentro del batch (D1 ejecuta las
      // escrituras una a una), así que ni con peticiones simultáneas se supera.
      db
        .prepare(
          `INSERT INTO club_invitations (id, club_id, email, role, invited_by_user_id, created_at, expires_at)
           SELECT ?1, ?2, ?3, 'admin', ?4, ?5, ?6
           WHERE (SELECT COUNT(*) FROM club_invitations
                  WHERE club_id = ?2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?5) < ?7
           ON CONFLICT DO NOTHING`,
        )
        .bind(id, clubId, email, user.id, t, new Date(now.getTime() + INVITATION_DAYS * DAY_MS).toISOString(), MAX_PENDING_INVITATIONS),
      auditIf(db, 'EXISTS (SELECT 1 FROM club_invitations WHERE id = ?)', [id], user.id, clubId, 'invitation.create', 'invitation', id, t),
    ]),
  );
  const row = await db
    .prepare('SELECT id, email, expires_at AS expiresAt FROM club_invitations WHERE club_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL')
    .bind(clubId, email)
    .first<{ id: string; email: string; expiresAt: string }>();
  // Sin invitación pendiente para ese correo: el club ha llegado al máximo.
  if (!row) throw tooManyInvitations();
  return { invitation: row, created: row.id === id };
}

export const tooManyInvitations = () =>
  new HttpError(
    409,
    'limite_invitaciones',
    `El club ya tiene ${MAX_PENDING_INVITATIONS} invitaciones pendientes. Retira alguna o espera a que caduquen para invitar a otra persona.`,
  );

export async function revokeInvitation(db: Db, user: AccountUser, clubId: string, invitationId: string, now = new Date()) {
  await requireRole(db, user, clubId, 'owner', true);
  const t = now.toISOString();
  const [res] = await guarded(() =>
    db.batch([
      db
        .prepare('UPDATE club_invitations SET revoked_at = ? WHERE id = ? AND club_id = ? AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id')
        .bind(t, invitationId, clubId),
      auditIf(db, 'EXISTS (SELECT 1 FROM club_invitations WHERE id = ? AND revoked_at = ?)', [invitationId, t], user.id, clubId, 'invitation.revoke', 'invitation', invitationId, t),
    ]),
  );
  if (returned(res)) return { revoked: true };
  const row = await db.prepare('SELECT revoked_at FROM club_invitations WHERE id = ? AND club_id = ?').bind(invitationId, clubId).first<{ revoked_at: string | null }>();
  if (row?.revoked_at) return { revoked: false };
  throw notFound();
}

/** Aceptar: una sola sentencia; el trigger crea la membresía y la auditoría o aborta todo. */
export async function acceptInvitation(db: Db, user: AccountUser, invitationId: string, now = new Date()) {
  if (!user.emailVerified) throw notFound();
  const email = normalizeEmail(user.email);
  const row = await guarded(() =>
    db
      .prepare(
        `UPDATE club_invitations SET accepted_at = ?, accepted_by_user_id = ?
         WHERE id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL RETURNING club_id AS clubId`,
      )
      .bind(now.toISOString(), user.id, invitationId, email)
      .first<{ clubId: string }>(),
  );
  if (row) return { clubId: row.clubId, accepted: true };
  const done = await db
    .prepare('SELECT club_id AS clubId FROM club_invitations WHERE id = ? AND email = ? AND accepted_by_user_id = ?')
    .bind(invitationId, email, user.id)
    .first<{ clubId: string }>();
  if (done) return { clubId: done.clubId, accepted: false };
  throw notFound();
}

export async function declineInvitation(db: Db, user: AccountUser, invitationId: string, now = new Date()) {
  const email = normalizeEmail(user.email);
  const t = now.toISOString();
  const target = await db.prepare('SELECT club_id AS clubId FROM club_invitations WHERE id = ? AND email = ?').bind(invitationId, email).first<{ clubId: string }>();
  if (!target) throw notFound();
  const [res] = await guarded(() =>
    db.batch([
      db
        .prepare('UPDATE club_invitations SET revoked_at = ? WHERE id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL RETURNING club_id')
        .bind(t, invitationId, email),
      auditIf(
        db,
        'EXISTS (SELECT 1 FROM club_invitations WHERE id = ? AND revoked_at = ?)',
        [invitationId, t],
        user.id,
        target.clubId,
        'invitation.decline',
        'invitation',
        invitationId,
        t,
      ),
    ]),
  );
  if (returned(res)) return { declined: true };
  throw notFound();
}

// ---------------------------------------------------------------------------
// Administradores
// ---------------------------------------------------------------------------

async function closeMembership(db: Db, actor: AccountUser, clubId: string, userId: string, action: string, now: Date) {
  const t = now.toISOString();
  const [res] = await guarded(() =>
    db.batch([
      db
        .prepare('UPDATE club_memberships SET revoked_at = ?, revoked_by_user_id = ? WHERE club_id = ? AND user_id = ? AND revoked_at IS NULL RETURNING id')
        .bind(t, actor.id, clubId, userId),
      auditIf(
        db,
        'EXISTS (SELECT 1 FROM club_memberships WHERE club_id = ? AND user_id = ? AND revoked_at = ? AND revoked_by_user_id = ?)',
        [clubId, userId, t, actor.id],
        actor.id,
        clubId,
        action,
        'user',
        userId,
        t,
      ),
    ]),
  );
  return { revoked: returned(res) };
}

export async function revokeAdmin(db: Db, user: AccountUser, clubId: string, userId: string, now = new Date()) {
  await requireRole(db, user, clubId, 'owner', true);
  if (userId === user.id) throw new HttpError(409, 'propietario_activo', 'Antes hay que transferir la propiedad del club.');
  return closeMembership(db, user, clubId, userId, 'member.revoke', now);
}

export async function leaveClub(db: Db, user: AccountUser, clubId: string, now = new Date()) {
  const role = await requireRole(db, user, clubId, 'any', false);
  if (role === 'owner') throw new HttpError(409, 'propietario_activo', 'Antes hay que transferir la propiedad del club.');
  return closeMembership(db, user, clubId, user.id, 'member.leave', now);
}

// ---------------------------------------------------------------------------
// Transferencia de propiedad
// ---------------------------------------------------------------------------

export async function requestTransfer(db: Db, user: AccountUser, clubId: string, toUserId: unknown, now = new Date()) {
  await requireRole(db, user, clubId, 'owner', true);
  if (typeof toUserId !== 'string' || !toUserId || toUserId.length > 100) throw new HttpError(400, 'bad_request', 'Destinatario no válido.');
  const t = now.toISOString();
  const id = crypto.randomUUID();
  await guarded(() =>
    db.batch([
      db
        .prepare("UPDATE club_owner_transfers SET status = 'cancelled', decided_at = ?1 WHERE club_id = ?2 AND status = 'pending' AND expires_at <= ?1")
        .bind(t, clubId),
      db
        .prepare(
          `INSERT INTO club_owner_transfers (id, club_id, from_user_id, to_user_id, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(id, clubId, user.id, toUserId, t, new Date(now.getTime() + TRANSFER_DAYS * DAY_MS).toISOString()),
      auditIf(db, 'EXISTS (SELECT 1 FROM club_owner_transfers WHERE id = ?)', [id], user.id, clubId, 'transfer.request', 'transfer', id, t),
    ]),
  );
  const row = await db
    .prepare("SELECT id, to_user_id AS toUserId, expires_at AS expiresAt FROM club_owner_transfers WHERE club_id = ? AND status = 'pending'")
    .bind(clubId)
    .first<{ id: string; toUserId: string; expiresAt: string }>();
  if (!row) throw new HttpError(409, 'conflict', 'No se ha podido crear la transferencia. Inténtalo de nuevo.');
  if (row.toUserId !== toUserId) throw new HttpError(409, 'transferencia_pendiente', 'Ya hay otra transferencia pendiente en este club.');
  return { transfer: row, created: row.id === id };
}

export type TransferDecision = 'accept' | 'decline' | 'cancel';

const DECISION: Record<TransferDecision, { status: string; actorColumn: 'to_user_id' | 'from_user_id'; action: string | null }> = {
  // La aceptación la audita el trigger, en la misma sentencia.
  accept: { status: 'accepted', actorColumn: 'to_user_id', action: null },
  decline: { status: 'declined', actorColumn: 'to_user_id', action: 'transfer.decline' },
  cancel: { status: 'cancelled', actorColumn: 'from_user_id', action: 'transfer.cancel' },
};

export async function decideTransfer(db: Db, user: AccountUser, transferId: string, decision: TransferDecision, now = new Date()) {
  const d = DECISION[decision];
  const t = now.toISOString();
  const target = await db
    .prepare(`SELECT club_id AS clubId FROM club_owner_transfers WHERE id = ? AND ${d.actorColumn} = ?`)
    .bind(transferId, user.id)
    .first<{ clubId: string }>();
  if (!target) throw notFound();
  const update = db
    .prepare(
      `UPDATE club_owner_transfers SET status = ?, decided_at = ?
       WHERE id = ? AND status = 'pending' AND ${d.actorColumn} = ? RETURNING club_id AS clubId`,
    )
    .bind(d.status, t, transferId, user.id);
  const statements = d.action
    ? [
        update,
        auditIf(
          db,
          'EXISTS (SELECT 1 FROM club_owner_transfers WHERE id = ? AND status = ? AND decided_at = ?)',
          [transferId, d.status, t],
          user.id,
          target.clubId,
          d.action,
          'transfer',
          transferId,
          t,
        ),
      ]
    : [update];
  const [res] = await guarded(() => db.batch(statements));
  const changed = res?.results?.[0] as { clubId: string } | undefined;
  if (changed) return { clubId: changed.clubId, status: d.status, changed: true };
  // Reintento de una decisión ya tomada por la misma cuenta: mismo resultado.
  const row = await db
    .prepare(`SELECT club_id AS clubId, status FROM club_owner_transfers WHERE id = ? AND ${d.actorColumn} = ?`)
    .bind(transferId, user.id)
    .first<{ clubId: string; status: string }>();
  if (!row) throw notFound();
  if (row.status === d.status) return { clubId: row.clubId, status: d.status, changed: false };
  throw new HttpError(409, 'transferencia_cerrada', 'La transferencia ya no está pendiente.');
}
