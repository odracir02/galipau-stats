// Control de registro de los partidos entre entrenadores. Ver docs/SINCRONIZACION.md.
//
// * Un partido en curso o en el descanso lo modifica solo el dispositivo que
//   tiene su control. Los preparados y los finalizados no tienen control:
//   cualquier entrenador del equipo los corrige, con la versión base correcta.
// * El control se toma al escribir en un partido activo que no lo tiene (p. ej.
//   al iniciarlo) y se libera al finalizarlo o eliminarlo.
// * Un dispositivo revocado, o sin permiso de entrenador vigente en el equipo,
//   no retiene el control: su partido queda libre para otro entrenador.
// * Cualquier entrenador puede tomar el control de un partido activo con
//   POST /api/sync/control, indicando el contador de control que ha visto: si
//   otro lo ha cambiado entretanto, responde conflicto y no cambia nada.
// * Todas las condiciones se comprueban DENTRO de la sentencia que escribe: un
//   cambio de control entre la lectura y la escritura nunca deja pasar la
//   escritura de quien lo ha perdido.
import type { Id } from '../../src/domain/types';
import { authorize } from './auth';
import type { Db, SqlValue } from './db';
import { HttpError, notFound } from './errors';
import type { AuthContext } from './model';

/** Estados en los que un partido tiene control exclusivo. */
export const ACTIVE_SQL = "('in_progress', 'halftime')";

/**
 * El dispositivo con el control de la fila `m` sigue autorizado como entrenador
 * del equipo, con el MISMO permiso que tenía al tomarlo: si se le retiró y
 * después volvió a canjear un código, no recupera el control por ello.
 */
function validController(m: string): string {
  return `EXISTS (
    SELECT 1 FROM devices d JOIN grants g ON g.device_id = d.id
    WHERE d.id = ${m}.control_device_id AND d.revoked_at IS NULL
      AND g.team_id = ${m}.team_id AND g.revoked_at IS NULL AND g.role = 'coach'
      AND g.created_at <= ${m}.control_since
  )`;
}

/**
 * La fila `m` está bloqueada para el dispositivo del parámetro: activa y con el
 * control vigente de OTRO dispositivo. Un parámetro: el dispositivo que escribe.
 */
export function blockedSql(m: string): string {
  return `(${m}.status IN ${ACTIVE_SQL} AND ${m}.deleted_at IS NULL AND ${m}.control_device_id IS NOT NULL
    AND ${m}.control_device_id <> ? AND ${validController(m)})`;
}

/** Estado del control de un partido, tal como lo ve un dispositivo (sin identificadores). */
export interface ControlView {
  /** «here»: este dispositivo; «other»: otro dispositivo vigente; null: sin control. */
  holder: 'here' | 'other' | null;
  epoch: number;
  /** Última escritura del dispositivo con el control. */
  seenAt: string | null;
}

export interface ControlRow {
  status: string;
  deleted_at: string | null;
  control_device_id: string | null;
  control_epoch: number;
  control_seen_at: string | null;
  /** 1 si el dispositivo con el control sigue autorizado. */
  control_valid: number;
}

/** Columna `control_valid` de la fila `m` (añadir a un SELECT que ya lea `m.*`). */
export function controlValidColumn(m: string): string {
  return `CASE WHEN ${m}.control_device_id IS NOT NULL AND ${validController(m)} THEN 1 ELSE 0 END AS control_valid`;
}

/** Columnas para leer el control de la fila `m` (añadir a un SELECT). */
export function controlColumns(m: string): string {
  return `${m}.control_device_id, ${m}.control_epoch, ${m}.control_seen_at, ${controlValidColumn(m)}`;
}

export function isActive(row: Pick<ControlRow, 'status' | 'deleted_at'>): boolean {
  return (row.status === 'in_progress' || row.status === 'halftime') && row.deleted_at === null;
}

export function controlView(row: ControlRow, deviceId: Id | null): ControlView {
  const held = isActive(row) && row.control_device_id !== null && row.control_valid === 1;
  return {
    holder: !held ? null : row.control_device_id === deviceId ? 'here' : 'other',
    epoch: row.control_epoch,
    seenAt: held ? row.control_seen_at : null,
  };
}

/** ¿Puede este dispositivo escribir ahora en el partido? (comprobación previa; la definitiva va en la sentencia). */
export function assertMayWrite(row: ControlRow, deviceId: Id): void {
  if (controlView(row, deviceId).holder === 'other') throw recordedElsewhere();
}

export const recordedElsewhere = () => new HttpError(409, 'match_recorded_elsewhere', 'Otro dispositivo registra este partido.');

/**
 * Sentencias que acompañan a una escritura propia ya aplicada en el partido
 * `matchId` (el guardián confirma que la escritura es la de este dispositivo):
 *   * toma el control si el partido está activo y no lo tiene (o lo tenía un
 *     dispositivo ya no autorizado);
 *   * anota la actividad de quien lo tiene;
 *   * lo libera si el partido ya no está activo (finalizado, preparado o eliminado).
 */
export function controlFollowUp(
  db: Db,
  matchId: Id,
  deviceId: Id,
  nowIso: string,
  guard: string,
  guardValues: SqlValue[],
) {
  return [
    db
      .prepare(
        `UPDATE matches SET control_device_id = ?, control_epoch = control_epoch + 1, control_since = ?, control_seen_at = ?
         WHERE id = ? AND status IN ${ACTIVE_SQL} AND deleted_at IS NULL
           AND (control_device_id IS NULL OR control_device_id <> ?) AND ${guard}`,
      )
      .bind(deviceId, nowIso, nowIso, matchId, deviceId, ...guardValues),
    db.prepare(`UPDATE matches SET control_seen_at = ? WHERE id = ? AND control_device_id = ? AND ${guard}`).bind(nowIso, matchId, deviceId, ...guardValues),
    db
      .prepare(
        `UPDATE matches SET control_device_id = NULL, control_epoch = control_epoch + 1, control_since = NULL, control_seen_at = NULL
         WHERE id = ? AND control_device_id IS NOT NULL AND (status NOT IN ${ACTIVE_SQL} OR deleted_at IS NOT NULL) AND ${guard}`,
      )
      .bind(matchId, ...guardValues),
  ];
}

// --- Tomar el control ------------------------------------------------------------

export interface ControlOp {
  /** Identificador de la operación: repetirla (reintento) no hace una segunda transferencia. */
  opId: Id;
  teamId: Id;
  matchId: Id;
  /** Contador de control que ha visto el dispositivo (ControlView.epoch). */
  expectedEpoch: number;
}

export interface ControlResult {
  status: 'applied' | 'duplicate';
  entityId: Id;
  /** Contador de control tras la operación. */
  epoch: number;
}

async function readControl(db: Db, matchId: Id, teamId: Id) {
  return db
    .prepare(`SELECT m.team_id, m.status, m.deleted_at, m.version, ${controlColumns('m')} FROM matches m WHERE m.id = ? AND m.team_id = ?`)
    .bind(matchId, teamId)
    .first<ControlRow & { team_id: string; version: number }>();
}

function controlChanged(row: ControlRow, deviceId: Id): HttpError {
  return new HttpError(409, 'control_changed', 'El control del partido ha cambiado. Revisa quién lo tiene antes de volver a intentarlo.', {
    control: controlView(row, deviceId),
  });
}

const notActive = () => new HttpError(409, 'match_not_active', 'El partido no está en curso: no hay control que tomar.');

/**
 * Toma el control de un partido activo para el dispositivo que lo pide. Exige
 * permiso match.transfer en el equipo. Atómica: solo cambia si el contador de
 * control sigue siendo el esperado.
 */
export async function takeControl(db: Db, auth: AuthContext, op: ControlOp, now = new Date()): Promise<ControlResult> {
  await authorize(db, auth, op.teamId, 'match.transfer');
  const deviceId = auth.deviceId;
  if (!deviceId) throw new HttpError(403, 'device_required', 'El control lo toma un dispositivo autorizado.');

  // Reintento de una operación ya hecha: mismo resultado, sin otra transferencia.
  const done = await db
    .prepare('SELECT device_id, entity_id, result_json FROM sync_ops WHERE op_id = ?')
    .bind(op.opId)
    .first<{ device_id: string; entity_id: string; result_json: string }>();
  if (done) {
    if (done.device_id !== deviceId || done.entity_id !== op.matchId) {
      throw new HttpError(409, 'op_id_reused', 'Identificador de operación ya usado para otro registro.');
    }
    return JSON.parse(done.result_json) as ControlResult;
  }

  const row = await readControl(db, op.matchId, op.teamId);
  if (!row) throw notFound();
  if (!isActive(row)) throw notActive();
  const view = controlView(row, deviceId);
  if (view.holder === 'here') return { status: 'duplicate', entityId: op.matchId, epoch: row.control_epoch };
  if (row.control_epoch !== op.expectedEpoch) throw controlChanged(row, deviceId);

  const epoch = op.expectedEpoch + 1;
  const result: ControlResult = { status: 'applied', entityId: op.matchId, epoch };
  const at = now.toISOString();
  const guard = '(SELECT control_device_id FROM matches WHERE id = ?) = ? AND (SELECT control_epoch FROM matches WHERE id = ?) = ?';
  const guardValues: SqlValue[] = [op.matchId, deviceId, op.matchId, epoch];
  await db.batch([
    db
      .prepare(
        `UPDATE matches SET control_device_id = ?, control_epoch = ?, control_since = ?, control_seen_at = ?
         WHERE id = ? AND team_id = ? AND control_epoch = ? AND status IN ${ACTIVE_SQL} AND deleted_at IS NULL`,
      )
      .bind(deviceId, epoch, at, at, op.matchId, op.teamId, op.expectedEpoch),
    // Los demás dispositivos lo ven en su siguiente consulta de cambios.
    db
      .prepare(`INSERT INTO change_log (team_id, entity, entity_id, version, changed_at) SELECT ?, 'match', ?, ?, ? WHERE ${guard}`)
      .bind(op.teamId, op.matchId, row.version, at, ...guardValues),
    db
      .prepare(
        `INSERT INTO match_control_log (team_id, match_id, from_device_id, to_device_id, epoch, op_id, at)
         SELECT ?, ?, (SELECT id FROM devices WHERE id = ?), ?, ?, ?, ? WHERE ${guard}`,
      )
      .bind(op.teamId, op.matchId, row.control_device_id, deviceId, epoch, op.opId, at, ...guardValues),
    db
      .prepare(
        `INSERT INTO sync_ops (op_id, device_id, team_id, entity, entity_id, result_json, received_at)
         SELECT ?, ?, ?, 'match_control', ?, ?, ? WHERE ${guard}`,
      )
      .bind(op.opId, deviceId, op.teamId, op.matchId, JSON.stringify(result), at, ...guardValues),
  ]);
  const recorded = await db.prepare('SELECT 1 AS ok FROM sync_ops WHERE op_id = ?').bind(op.opId).first();
  if (!recorded) {
    // Otra petición cambió el control (o el partido) entre la lectura y la escritura.
    const now2 = await readControl(db, op.matchId, op.teamId);
    if (!now2) throw notFound();
    if (!isActive(now2)) throw notActive();
    throw controlChanged(now2, deviceId);
  }
  return result;
}

/** Sentencia que retira el control que tenga un dispositivo (al cerrar sesión o dejar un equipo). */
export function releaseDeviceControl(db: Db, deviceId: Id, teamId: Id | null = null) {
  return db
    .prepare(
      `UPDATE matches SET control_device_id = NULL, control_epoch = control_epoch + 1, control_since = NULL, control_seen_at = NULL
       WHERE control_device_id = ?${teamId ? ' AND team_id = ?' : ''}`,
    )
    .bind(...(teamId ? [deviceId, teamId] : [deviceId]));
}
