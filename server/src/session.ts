// Sesión del dispositivo: qué equipos tiene, salir de uno y cerrar la sesión.
// Solo actúa sobre el propio dispositivo (el del token); nunca sobre otros.
import type { Id } from '../../src/domain/types';
import type { Db } from './db';
import { HttpError, notFound } from './errors';
import type { AuthContext, TeamRole } from './model';

export interface SessionTeam {
  teamId: Id;
  role: TeamRole;
  /** «unavailable»: el equipo o su club están eliminados, o el club está suspendido. */
  status: 'active' | 'unavailable';
  name: string;
  code: string;
  season: string;
  clubId: Id;
  clubName: string;
}

export interface TeamSummary {
  id: Id;
  name: string;
  code: string;
  season: string;
  clubId: Id;
  clubName: string;
}

function requireDevice(auth: AuthContext): Id {
  if (!auth.deviceId) throw new HttpError(400, 'device_required', 'Esta operación es de un dispositivo.');
  return auth.deviceId;
}

/** Datos públicos de un equipo para mostrar tras el canje (sin códigos). */
export async function teamSummary(db: Db, teamId: Id): Promise<TeamSummary> {
  const row = await db
    .prepare(
      `SELECT t.id, t.name, t.code, t.season, t.club_id AS clubId, c.name AS clubName
       FROM teams t JOIN clubs c ON c.id = t.club_id WHERE t.id = ?`,
    )
    .bind(teamId)
    .first<TeamSummary>();
  if (!row) throw notFound();
  return row;
}

/**
 * Equipos del dispositivo con su rol. Los no disponibles (suspendidos o
 * eliminados) se listan como tales para que la app avise sin borrar nada; sus
 * datos siguen sin ser accesibles por la API.
 */
export async function getSession(db: Db, auth: AuthContext, now = new Date()): Promise<{ deviceId: Id; teams: SessionTeam[] }> {
  const deviceId = requireDevice(auth);
  const { results } = await db
    .prepare(
      `SELECT g.team_id AS teamId, g.role, t.name, t.code, t.season, t.club_id AS clubId, c.name AS clubName,
              CASE WHEN t.deleted_at IS NULL AND c.deleted_at IS NULL AND c.status = 'active' THEN 'active' ELSE 'unavailable' END AS status
       FROM grants g JOIN teams t ON t.id = g.team_id JOIN clubs c ON c.id = t.club_id
       WHERE g.device_id = ? AND g.revoked_at IS NULL
       ORDER BY t.season DESC, c.name, t.name`,
    )
    .bind(deviceId)
    .all<SessionTeam>();
  await db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now.toISOString(), deviceId).run();
  return { deviceId, teams: results };
}

/** El dispositivo deja un equipo: retira su propio permiso. Siempre posible, aunque el club esté suspendido. */
export async function leaveTeam(db: Db, auth: AuthContext, teamId: Id, now = new Date()): Promise<void> {
  const deviceId = requireDevice(auth);
  const res = await db
    .prepare('UPDATE grants SET revoked_at = ? WHERE device_id = ? AND team_id = ? AND revoked_at IS NULL')
    .bind(now.toISOString(), deviceId, teamId)
    .run();
  if (res.meta.changes === 0) throw notFound();
}

/**
 * Cierra la sesión del dispositivo: revoca el dispositivo, todos sus tokens y
 * todos sus permisos, en una transacción. Para volver hará falta canjear un
 * código de nuevo.
 */
export async function logout(db: Db, auth: AuthContext, now = new Date()): Promise<void> {
  const deviceId = requireDevice(auth);
  const at = now.toISOString();
  await db.batch([
    db.prepare('UPDATE grants SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').bind(at, deviceId),
    db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').bind(at, deviceId),
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(at, deviceId),
  ]);
}
