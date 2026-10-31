// Sincronización de acciones (subida) y descarga de cambios. Ver docs/SINCRONIZACION.md.
//
// Garantías:
//   * Idempotencia: cada operación lleva un opId generado por el dispositivo. Si
//     llega dos veces (reintento tras un corte), la segunda devuelve el mismo
//     resultado sin aplicar nada.
//   * Sin sobrescrituras silenciosas: el dispositivo indica la versión sobre la
//     que editó (baseVersion). Si el servidor tiene otra, responde conflicto con
//     su copia y el dispositivo decide.
//   * Un partido en curso o en el descanso lo registra un solo dispositivo (el
//     que tiene su control, ver control.ts); los demás reciben conflicto hasta
//     que tomen el control. Los preparados y finalizados los corrige cualquier
//     entrenador del equipo con la versión base correcta.
import type { Id, MatchEvent } from '../../src/domain/types';
import { assertValidEvent, ValidationError } from '../../src/domain/validation';
import { authorize } from './auth';
import { assertMayWrite, blockedSql, controlFollowUp, controlValidColumn, controlView, recordedElsewhere, type ControlRow } from './control';
import type { Db, Statement } from './db';
import { HttpError, notFound } from './errors';
import {
  eventToRow,
  insertSql,
  rowsToMatch,
  rowToEvent,
  sameEventContent,
  type EventRow,
  type MatchRow,
  type SquadRow,
} from './mapping';
import type { AuthContext } from './model';

export interface EventOp {
  /** Identificador único de la operación (UUID del dispositivo). */
  opId: Id;
  teamId: Id;
  /** Versión del servidor sobre la que se editó; null = acción nueva. */
  baseVersion: number | null;
  event: MatchEvent;
}

export interface OpResult {
  status: 'applied' | 'duplicate';
  entityId: Id;
  version: number;
}

const EVENT_COLUMNS =
  'id, match_id, team_id, player_id, kind, shot_type, result, turnover_type, period, match_time_ms, created_at, updated_at, deleted_at, adds_to_previous';

function conflict(server: (EventRow & { version: number }) | null, reason: string): HttpError {
  return new HttpError(409, 'conflict', reason, {
    server: server ? { version: server.version, event: rowToEvent(server) } : null,
  });
}

export async function applyEventOp(db: Db, auth: AuthContext, op: EventOp, now = new Date()): Promise<OpResult> {
  await authorize(db, auth, op.teamId, 'match.write');
  // Las acciones las registra un dispositivo (el que lleva el partido), no una
  // sesión de administración.
  const deviceId = auth.deviceId;
  if (!deviceId) throw new HttpError(403, 'device_required', 'Las acciones se registran desde un dispositivo autorizado.');

  // 1. ¿Ya se aplicó esta operación?
  const done = await db
    .prepare('SELECT device_id, entity_id, result_json FROM sync_ops WHERE op_id = ?')
    .bind(op.opId)
    .first<{ device_id: string; entity_id: string; result_json: string }>();
  if (done) {
    if (done.device_id !== deviceId || done.entity_id !== op.event.id) {
      throw new HttpError(409, 'op_id_reused', 'Identificador de operación ya usado para otro registro.');
    }
    return JSON.parse(done.result_json) as OpResult;
  }

  // 2. El partido debe ser de ese equipo y no estar eliminado.
  const readMatch = () =>
    db
      .prepare(`SELECT m.*, ${controlValidColumn('m')} FROM matches m WHERE m.id = ? AND m.team_id = ?`)
      .bind(op.event.matchId, op.teamId)
      .first<MatchRow & ControlRow & { recorder_device_id: string | null }>();
  const match = await readMatch();
  if (!match) throw notFound();
  if (match.deleted_at) throw new HttpError(409, 'match_deleted', 'El partido está eliminado.');
  // Partido activo con el control de otro dispositivo (se vuelve a comprobar dentro de la escritura).
  assertMayWrite(match, deviceId);
  /** La escritura solo se aplica si, en ese momento, el partido no está bloqueado para este dispositivo. */
  const allowed = `NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = ? AND ${blockedSql('m')})`;

  // 3. Mismas reglas que la aplicación (catálogo, convocatoria, porteros).
  const squad = await db.prepare('SELECT * FROM match_squad WHERE match_id = ?').bind(match.id).all<SquadRow>();
  try {
    assertValidEvent(rowsToMatch(match, squad.results), op.event);
  } catch (e) {
    if (e instanceof ValidationError) throw new HttpError(422, 'invalid_event', e.message);
    throw e;
  }
  // La marca de sanción adicional se guarda tal cual; nunca se descarta en silencio.
  const adds = (op.event as { addsToPrevious?: unknown }).addsToPrevious;
  if (adds !== undefined && adds !== true && adds !== false) {
    throw new HttpError(422, 'invalid_event', 'Marca de sanción adicional no válida.');
  }
  if (adds === true && ((op.event.kind !== 'exclusion' && op.event.kind !== 'red') || op.event.playerId === null)) {
    throw new HttpError(422, 'invalid_event', 'Solo una exclusión o roja de un jugador puede sumarse a una inferioridad anterior.');
  }

  // 4. Versión.
  const incoming = eventToRow(op.event, op.teamId);
  const current = await readEvent(db, op.event.id);
  if (current && current.team_id !== op.teamId) throw notFound();

  const nowIso = now.toISOString();
  const writes: Statement[] = [];
  let result: OpResult;
  if (!current) {
    if (op.baseVersion !== null) throw conflict(null, 'La acción ya no existe en el servidor.');
    const ins = insertSql('events', { ...incoming, version: 1, updated_by_device_id: deviceId });
    const conditional = ins.sql.replace(/ VALUES \((.*)\)$/, ' SELECT $1') + ` WHERE ${allowed}`;
    writes.push(db.prepare(conditional).bind(...ins.values, match.id, deviceId));
    result = { status: 'applied', entityId: op.event.id, version: 1 };
  } else if (op.baseVersion === null) {
    // Alta repetida sin registro de la operación (p. ej. opId regenerado):
    // si el contenido coincide no hay nada que hacer; si no, es un conflicto.
    if (!sameEventContent(current, incoming)) throw conflict(current, 'La acción ya existe con otro contenido.');
    result = { status: 'duplicate', entityId: op.event.id, version: current.version };
  } else if (op.baseVersion !== current.version) {
    throw conflict(current, 'La acción ha cambiado en el servidor desde la última sincronización.');
  } else {
    const version = current.version + 1;
    writes.push(
      db
        .prepare(
          `UPDATE events SET player_id = ?, kind = ?, shot_type = ?, result = ?, turnover_type = ?, period = ?,
             match_time_ms = ?, updated_at = ?, deleted_at = ?, adds_to_previous = ?, version = ?, updated_by_device_id = ?
           WHERE id = ? AND version = ? AND ${allowed}`,
        )
        .bind(
          incoming.player_id,
          incoming.kind,
          incoming.shot_type,
          incoming.result,
          incoming.turnover_type,
          incoming.period,
          incoming.match_time_ms,
          incoming.updated_at,
          incoming.deleted_at,
          incoming.adds_to_previous,
          version,
          deviceId,
          op.event.id,
          current.version,
          match.id,
          deviceId,
        ),
    );
    result = { status: 'applied', entityId: op.event.id, version };
  }

  // 5. Todo en una transacción. El registro de cambios y el de la operación
  //    solo se escriben si la acción quedó exactamente en la versión esperada y
  //    por este dispositivo: si otro la cambió entre la lectura y la escritura,
  //    no se marca como aplicada y se responde conflicto.
  const condition = '(SELECT version FROM events WHERE id = ?) = ? AND (SELECT updated_by_device_id FROM events WHERE id = ?) = ?';
  const guard = `WHERE ${condition}`;
  const guardValues = [op.event.id, result.version, op.event.id, deviceId];
  if (result.status === 'applied') {
    writes.push(
      db
        .prepare('UPDATE matches SET recorder_device_id = ? WHERE id = ? AND recorder_device_id IS NULL')
        .bind(deviceId, match.id),
      // Toma el control si el partido está activo y libre; anota la actividad.
      ...controlFollowUp(db, match.id, deviceId, nowIso, condition, guardValues),
      db
        .prepare(`INSERT INTO change_log (team_id, entity, entity_id, version, changed_at) SELECT ?, ?, ?, ?, ? ${guard}`)
        .bind(op.teamId, 'event', op.event.id, result.version, nowIso, ...guardValues),
      db
        .prepare(
          `INSERT INTO sync_ops (op_id, device_id, team_id, entity, entity_id, result_json, received_at)
           SELECT ?, ?, ?, ?, ?, ?, ? ${guard}`,
        )
        .bind(op.opId, deviceId, op.teamId, 'event', op.event.id, JSON.stringify(result), nowIso, ...guardValues),
    );
  } else {
    writes.push(
      db
        .prepare(
          'INSERT INTO sync_ops (op_id, device_id, team_id, entity, entity_id, result_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(op.opId, deviceId, op.teamId, 'event', op.event.id, JSON.stringify(result), nowIso),
    );
  }
  try {
    await db.batch(writes);
  } catch (e) {
    // Alta simultánea del mismo identificador desde otra petición.
    if (!current && /UNIQUE constraint failed: events\.id/.test(String(e))) {
      throw conflict(await readEvent(db, op.event.id), 'La acción se ha creado a la vez desde otra petición.');
    }
    throw e;
  }
  const recorded = await db.prepare('SELECT 1 AS ok FROM sync_ops WHERE op_id = ?').bind(op.opId).first();
  if (!recorded) {
    // Otro dispositivo tomó el control entre la lectura y la escritura.
    const now2 = await readMatch();
    if (now2 && controlView(now2, deviceId).holder === 'other') throw recordedElsewhere();
    throw conflict(await readEvent(db, op.event.id), 'La acción ha cambiado en el servidor durante la sincronización.');
  }
  return result;
}

function readEvent(db: Db, id: Id): Promise<(EventRow & { version: number }) | null> {
  return db.prepare(`SELECT ${EVENT_COLUMNS}, version FROM events WHERE id = ?`).bind(id).first<EventRow & { version: number }>();
}

export interface ChangesPage {
  /** Cursor para la siguiente petición. */
  nextSeq: number;
  hasMore: boolean;
  events: { version: number; event: MatchEvent }[];
  /** Otros registros cambiados (partidos, jugadores…), solo identificados. */
  others: { entity: string; entityId: Id; version: number }[];
}

/** Cambios de un equipo posteriores a `sinceSeq`, en orden. Solo lectura. */
export async function pullChanges(db: Db, auth: AuthContext, teamId: Id, sinceSeq: number, limit = 500): Promise<ChangesPage> {
  await authorize(db, auth, teamId, 'team.read');
  const { results } = await db
    .prepare(
      `SELECT seq, entity, entity_id, version FROM change_log
       WHERE team_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    )
    .bind(teamId, sinceSeq, limit + 1)
    .all<{ seq: number; entity: string; entity_id: string; version: number }>();
  const page = results.slice(0, limit);
  // Si un registro cambió varias veces en la página, basta su estado actual.
  const eventIds = [...new Set(page.filter((c) => c.entity === 'event').map((c) => c.entity_id))];
  const events: ChangesPage['events'] = [];
  for (const id of eventIds) {
    const row = await db
      .prepare(`SELECT ${EVENT_COLUMNS}, version FROM events WHERE id = ? AND team_id = ?`)
      .bind(id, teamId)
      .first<EventRow & { version: number }>();
    if (row) events.push({ version: row.version, event: rowToEvent(row) });
  }
  return {
    nextSeq: page.at(-1)?.seq ?? sinceSeq,
    hasMore: results.length > limit,
    events,
    others: page.filter((c) => c.entity !== 'event').map((c) => ({ entity: c.entity, entityId: c.entity_id, version: c.version })),
  };
}
