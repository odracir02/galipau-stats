// Invitaciones: código de entrenador (edición) y de jugador/familia (consulta).
// Solo la lógica del servidor; las pantallas y rutas llegarán en la Tarea 005C.
//
// Un código no identifica a una persona: quien lo canjea obtiene un permiso
// para su dispositivo, nada más. El código de consulta se puede compartir.
import type { Id } from '../../src/domain/types';
import { newId } from '../../src/domain/ids';
import { authorize } from './auth';
import type { Db } from './db';
import { HttpError } from './errors';
import { TEAM_ROLES, type AuthContext, type TeamRole } from './model';
import { generateInviteCode, generateToken, hashSecret, normalizeInviteCode } from './secrets';

/** Caducidad por defecto de una invitación. */
export const INVITE_TTL_DAYS = { coach: 7, viewer: 90 } as const;

/** Intentos de canje permitidos por cliente y ventana. */
export const REDEEM_LIMIT = { attempts: 10, windowSeconds: 15 * 60 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreatedInvite {
  inviteId: Id;
  /** Código en claro: se muestra una sola vez y no se guarda. */
  code: string;
  expiresAt: string;
}

/**
 * Crea (o rota) la invitación de un equipo. La anterior del mismo tipo queda
 * revocada en la misma transacción: los dispositivos que ya la canjearon
 * conservan su permiso, pero el código antiguo deja de valer.
 */
export async function createInvite(
  db: Db,
  auth: AuthContext,
  args: { teamId: Id; role: TeamRole; ttlDays?: number; maxUses?: number | null },
  pepper: string,
  now = new Date(),
): Promise<CreatedInvite> {
  // Un código solo puede dar acceso de entrenador o de consulta, nunca
  // administrativo (también lo impide la base de datos).
  if (!TEAM_ROLES.includes(args.role)) throw new HttpError(400, 'invalid_role', 'Rol no válido para una invitación.');
  const team = await authorize(db, auth, args.teamId, 'invites.manage');
  const code = generateInviteCode();
  const inviteId = newId();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + (args.ttlDays ?? INVITE_TTL_DAYS[args.role]) * DAY_MS).toISOString();
  await db.batch([
    db
      .prepare('UPDATE invites SET revoked_at = ? WHERE team_id = ? AND role = ? AND revoked_at IS NULL')
      .bind(nowIso, args.teamId, args.role),
    db
      .prepare(
        `INSERT INTO invites (id, club_id, team_id, role, code_hash, created_by_device_id, created_at, expires_at, max_uses)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        inviteId,
        team.clubId,
        args.teamId,
        args.role,
        await hashSecret(normalizeInviteCode(code), pepper),
        auth.deviceId,
        nowIso,
        expiresAt,
        args.maxUses ?? null,
      ),
  ]);
  return { inviteId, code, expiresAt };
}

/**
 * Revoca un código. Por defecto, quien ya lo canjeó conserva el acceso (útil al
 * rotar). Con `revokeAccess`, además se retira el permiso a todos los
 * dispositivos que entraron con ese código (código filtrado).
 */
export async function revokeInvite(
  db: Db,
  auth: AuthContext,
  teamId: Id,
  inviteId: Id,
  { revokeAccess = false } = {},
  now = new Date(),
): Promise<{ revokedGrants: number }> {
  await authorize(db, auth, teamId, 'invites.manage');
  const nowIso = now.toISOString();
  const statements = [
    db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND team_id = ? AND revoked_at IS NULL').bind(nowIso, inviteId, teamId),
  ];
  if (revokeAccess) {
    statements.push(
      db.prepare('UPDATE grants SET revoked_at = ? WHERE invite_id = ? AND team_id = ? AND revoked_at IS NULL').bind(nowIso, inviteId, teamId),
    );
  }
  const results = await db.batch(statements);
  return { revokedGrants: results[1]?.meta.changes ?? 0 };
}

/**
 * Clave de cliente para el límite de intentos. Solo se usa CF-Connecting-IP,
 * que pone el borde de Cloudflare y el cliente no puede falsificar (Cloudflare
 * la sobrescribe). Nunca X-Forwarded-For ni nada que envíe el cliente. Las IPv6
 * se agrupan por su /64 (lo que suele tener un mismo usuario). Sin cabecera
 * (petición que no pasa por Cloudflare, p. ej. en local) todas comparten un
 * mismo contador: el límite se endurece, no desaparece.
 */
export function clientKeyFromRequest(request: Request): string {
  const ip = request.headers.get('CF-Connecting-IP')?.trim();
  if (!ip) return 'sin-ip';
  if (ip.includes(':')) {
    const groups = expandIpv6(ip);
    return groups ? `v6:${groups.slice(0, 4).join(':')}::/64` : 'v6:no-valida';
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? `v4:${ip}` : 'ip-no-valida';
}

function expandIpv6(ip: string): string[] | null {
  const [head = '', tail, extra] = ip.toLowerCase().split('::');
  if (extra !== undefined) return null;
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const missing = 8 - a.length - b.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  const all = [...a, ...Array(Math.max(0, missing)).fill('0'), ...b];
  return all.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? all.map((g) => g.padStart(4, '0')) : null;
}

/**
 * Cuenta un intento y rechaza si se supera el límite de la ventana. La clave
 * del cliente (IP) se guarda como hash.
 */
export async function checkRateLimit(db: Db, clientKey: string, pepper: string, now = new Date()): Promise<void> {
  const bucket = await hashSecret(`redeem:${clientKey}`, pepper);
  const windowStart = Math.floor(now.getTime() / 1000 / REDEEM_LIMIT.windowSeconds) * REDEEM_LIMIT.windowSeconds;
  const row = await db
    .prepare(
      `INSERT INTO auth_attempts (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > REDEEM_LIMIT.attempts) {
    throw new HttpError(429, 'too_many_attempts', 'Demasiados intentos. Espera unos minutos.');
  }
}

export interface Redeemed {
  deviceId: Id;
  /** Token del dispositivo en claro, solo si se ha creado un dispositivo nuevo. */
  token: string | null;
  teamId: Id;
  role: TeamRole;
}

const RANK: Record<TeamRole, number> = { viewer: 1, coach: 2 };

/**
 * Canjea un código. Si el dispositivo ya está autenticado (`auth`), se le añade
 * el permiso; si no, se crea un dispositivo con su token. Un mismo dispositivo
 * puede acumular permisos de varios equipos. Nunca rebaja un permiso mayor.
 */
export async function redeemInvite(
  db: Db,
  args: { code: string; clientKey: string; deviceLabel?: string | null; auth?: AuthContext },
  pepper: string,
  now = new Date(),
): Promise<Redeemed> {
  if (args.auth && !args.auth.deviceId) throw new HttpError(400, 'device_required', 'Los códigos se canjean desde un dispositivo.');
  await checkRateLimit(db, args.clientKey, pepper, now);
  const nowIso = now.toISOString();
  const invite = await db
    .prepare(
      `SELECT i.id, i.club_id, i.team_id, i.role FROM invites i JOIN teams t ON t.id = i.team_id
       JOIN clubs c ON c.id = t.club_id
       WHERE i.code_hash = ? AND i.revoked_at IS NULL AND i.expires_at > ? AND t.deleted_at IS NULL AND c.deleted_at IS NULL
         AND (i.max_uses IS NULL OR i.use_count < i.max_uses)`,
    )
    .bind(await hashSecret(normalizeInviteCode(args.code), pepper), nowIso)
    .first<{ id: string; club_id: string; team_id: string; role: TeamRole }>();
  // Mismo error para código inexistente, caducado o revocado.
  if (!invite) throw new HttpError(404, 'invalid_code', 'Código no válido o caducado.');

  const deviceId = args.auth?.deviceId ?? newId();
  const token = args.auth ? null : generateToken();
  const statements = [];
  if (!args.auth) {
    statements.push(
      db.prepare('INSERT INTO devices (id, label, created_at, last_seen_at) VALUES (?, ?, ?, ?)').bind(
        deviceId,
        args.deviceLabel ?? null,
        nowIso,
        nowIso,
      ),
      db
        .prepare('INSERT INTO device_tokens (token_hash, device_id, created_at) VALUES (?, ?, ?)')
        .bind(await hashSecret(token!, pepper), deviceId, nowIso),
    );
  }

  const existing = args.auth?.grants.find((g) => g.teamId === invite.team_id);
  let role: TeamRole = invite.role;
  if (existing && RANK[existing.role] >= RANK[invite.role]) {
    role = existing.role;
  } else {
    if (existing) {
      statements.push(db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').bind(nowIso, existing.id));
    }
    statements.push(
      db
        .prepare(
          'INSERT INTO grants (id, device_id, club_id, team_id, role, invite_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(newId(), deviceId, invite.club_id, invite.team_id, invite.role, invite.id, nowIso),
    );
  }
  statements.push(db.prepare('UPDATE invites SET use_count = use_count + 1 WHERE id = ?').bind(invite.id));
  await db.batch(statements);
  return { deviceId, token, teamId: invite.team_id, role };
}

/** Retira el acceso de un dispositivo a un equipo (p. ej. móvil perdido). */
export async function revokeTeamAccess(db: Db, auth: AuthContext, teamId: Id, deviceId: Id, now = new Date()): Promise<number> {
  await authorize(db, auth, teamId, 'grants.manage');
  const res = await db
    .prepare('UPDATE grants SET revoked_at = ? WHERE device_id = ? AND team_id = ? AND revoked_at IS NULL')
    .bind(now.toISOString(), deviceId, teamId)
    .run();
  return res.meta.changes;
}
