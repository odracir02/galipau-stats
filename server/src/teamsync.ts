// Sincronización de jugadores y partidos (con su convocatoria) y descarga del
// equipo completo. Ver docs/SINCRONIZACION.md.
//
// Mismas garantías que las acciones (sync.ts):
//   * Idempotencia por opId: repetir una operación devuelve el mismo resultado.
//   * Sin sobrescrituras silenciosas: cada cambio indica la versión sobre la que
//     se hizo (baseVersion); si el servidor tiene otra, responde conflicto con su
//     copia y no toca nada.
//   * Un partido lo modifica solo el dispositivo que lo registra.
//   * Los identificadores son los del dispositivo: el mismo UUID es el mismo
//     registro, así que subir dos veces no duplica nada.
import type { ClockState, Id, Match, Player } from '../../src/domain/types';
import { assertValidPlayerFields, ValidationError } from '../../src/domain/validation';
import { authorize } from './auth';
import type { Db, SqlValue, Statement } from './db';
import { HttpError, notFound } from './errors';
import {
  insertSql,
  matchToRows,
  playerToRow,
  rowsToMatch,
  rowToEvent,
  rowToPlayer,
  rowToTeam,
  type EventRow,
  type MatchRow,
  type PlayerRow,
  type SquadRow,
  type TeamRow,
} from './mapping';
import type { AuthContext } from './model';
import type { OpResult } from './sync';

export interface PlayerOp {
  opId: Id;
  teamId: Id;
  /** Versión del servidor sobre la que se editó; null = jugador nuevo. */
  baseVersion: number | null;
  player: Player;
}

export interface MatchOp {
  opId: Id;
  teamId: Id;
  /** Versión del servidor sobre la que se editó; null = partido nuevo. */
  baseVersion: number | null;
  /** Partido completo, con su convocatoria, cronómetro y corrección de marcador. */
  match: Match;
}

type Entity = 'player' | 'match';
type Versioned<T> = T & { version: number; updated_by_device_id: string | null };

const invalid = (message: string) => new HttpError(422, 'invalid_data', message);

function requireDevice(auth: AuthContext): Id {
  if (!auth.deviceId) throw new HttpError(403, 'device_required', 'Los datos se suben desde un dispositivo autorizado.');
  return auth.deviceId;
}

/** Resultado ya registrado de una operación, o null si es nueva. */
async function previousResult(db: Db, opId: Id, deviceId: Id, entityId: Id): Promise<OpResult | null> {
  const done = await db
    .prepare('SELECT device_id, entity_id, result_json FROM sync_ops WHERE op_id = ?')
    .bind(opId)
    .first<{ device_id: string; entity_id: string; result_json: string }>();
  if (!done) return null;
  if (done.device_id !== deviceId || done.entity_id !== entityId) {
    throw new HttpError(409, 'op_id_reused', 'Identificador de operación ya usado para otro registro.');
  }
  return JSON.parse(done.result_json) as OpResult;
}

function conflict(entity: Entity, server: unknown, reason: string): HttpError {
  return new HttpError(409, 'conflict', reason, { server: server === null ? null : { entity, ...(server as object) } });
}

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isIsoOrNull = (v: unknown) => v === null || isIso(v);
const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/**
 * Escritura con versión. Si es un alta y el registro no existe, se inserta en la
 * versión 1; si es una edición sobre la versión actual, se actualiza. El
 * registro de cambios, el de la operación y las sentencias dependientes (la
 * convocatoria) solo se aplican si, dentro de la transacción, el registro quedó
 * en la versión esperada y escrito por este dispositivo.
 */
async function commit(
  db: Db,
  args: {
    op: { opId: Id; teamId: Id };
    entity: Entity;
    table: 'players' | 'matches';
    entityId: Id;
    deviceId: Id;
    result: OpResult;
    write: Statement | null;
    /** Sentencias que solo se ejecutan si la escritura propia se aplicó (usan el guardián). */
    dependent?: (guard: string, guardValues: SqlValue[]) => Statement[];
    now: Date;
  },
): Promise<void> {
  const { op, entity, table, entityId, deviceId, result, now } = args;
  const nowIso = now.toISOString();
  const writes: Statement[] = [];
  if (result.status === 'applied') {
    const guard = `(SELECT version FROM ${table} WHERE id = ?) = ? AND (SELECT updated_by_device_id FROM ${table} WHERE id = ?) = ?`;
    const guardValues: SqlValue[] = [entityId, result.version, entityId, deviceId];
    writes.push(args.write!);
    writes.push(...(args.dependent?.(guard, guardValues) ?? []));
    writes.push(
      db
        .prepare(`INSERT INTO change_log (team_id, entity, entity_id, version, changed_at) SELECT ?, ?, ?, ?, ? WHERE ${guard}`)
        .bind(op.teamId, entity, entityId, result.version, nowIso, ...guardValues),
      db
        .prepare(
          `INSERT INTO sync_ops (op_id, device_id, team_id, entity, entity_id, result_json, received_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        )
        .bind(op.opId, deviceId, op.teamId, entity, entityId, JSON.stringify(result), nowIso, ...guardValues),
    );
  } else {
    writes.push(
      db
        .prepare(
          'INSERT INTO sync_ops (op_id, device_id, team_id, entity, entity_id, result_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(op.opId, deviceId, op.teamId, entity, entityId, JSON.stringify(result), nowIso),
    );
  }
  await db.batch(writes);
}

async function wasRecorded(db: Db, opId: Id): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS ok FROM sync_ops WHERE op_id = ?').bind(opId).first()) !== null;
}

// --- Jugadores ----------------------------------------------------------------

function validatePlayer(p: Player, teamId: Id): void {
  if (p.teamId !== teamId) throw invalid('El jugador no es de este equipo.');
  if (typeof p.name !== 'string' || typeof p.active !== 'boolean' || !isIso(p.createdAt) || !isIso(p.updatedAt)) {
    throw invalid('Jugador incompleto.');
  }
  try {
    assertValidPlayerFields(p);
  } catch (e) {
    if (e instanceof ValidationError) throw invalid(e.message);
    throw e;
  }
}

const PLAYER_CONTENT: (keyof PlayerRow)[] = ['name', 'number', 'position', 'active', 'deleted_at'];
const samePlayer = (a: PlayerRow, b: PlayerRow) => PLAYER_CONTENT.every((k) => a[k] === b[k]);

export async function applyPlayerOp(db: Db, auth: AuthContext, op: PlayerOp, now = new Date()): Promise<OpResult> {
  await authorize(db, auth, op.teamId, 'roster.write');
  const deviceId = requireDevice(auth);
  const done = await previousResult(db, op.opId, deviceId, op.player.id);
  if (done) return done;
  validatePlayer(op.player, op.teamId);

  const incoming = playerToRow(op.player);
  const current = await db.prepare('SELECT * FROM players WHERE id = ?').bind(op.player.id).first<Versioned<PlayerRow>>();
  if (current && current.team_id !== op.teamId) throw notFound();
  const server = (row: Versioned<PlayerRow>) => ({ version: row.version, player: rowToPlayer(row) });

  let result: OpResult;
  let write: Statement | null = null;
  if (!current) {
    if (op.baseVersion !== null) throw conflict('player', null, 'El jugador ya no existe en el servidor.');
    const ins = insertSql('players', { ...incoming, version: 1, updated_by_device_id: deviceId });
    write = db.prepare(ins.sql).bind(...ins.values);
    result = { status: 'applied', entityId: op.player.id, version: 1 };
  } else if (op.baseVersion === null) {
    if (!samePlayer(current, incoming)) throw conflict('player', server(current), 'El jugador ya existe con otros datos.');
    result = { status: 'duplicate', entityId: op.player.id, version: current.version };
  } else if (op.baseVersion !== current.version) {
    throw conflict('player', server(current), 'El jugador ha cambiado en el servidor desde la última sincronización.');
  } else {
    const version = current.version + 1;
    write = db
      .prepare(
        `UPDATE players SET name = ?, number = ?, position = ?, active = ?, updated_at = ?, deleted_at = ?,
           version = ?, updated_by_device_id = ? WHERE id = ? AND version = ?`,
      )
      .bind(incoming.name, incoming.number, incoming.position, incoming.active, incoming.updated_at, incoming.deleted_at, version, deviceId, op.player.id, current.version);
    result = { status: 'applied', entityId: op.player.id, version };
  }

  try {
    await commit(db, { op, entity: 'player', table: 'players', entityId: op.player.id, deviceId, result, write, now });
  } catch (e) {
    const msg = String(e);
    // Dorsal ya usado por otro jugador activo del equipo (índice único de D1).
    if (/UNIQUE constraint failed: players\.team_id, players\.number/.test(msg)) {
      throw new HttpError(409, 'number_taken', `El dorsal ${op.player.number} ya lo tiene otro jugador activo del equipo.`);
    }
    if (!current && /UNIQUE constraint failed: players\.id/.test(msg)) {
      throw conflict('player', null, 'El jugador se ha creado a la vez desde otra petición.');
    }
    throw e;
  }
  if (!(await wasRecorded(db, op.opId))) {
    const now2 = await db.prepare('SELECT * FROM players WHERE id = ?').bind(op.player.id).first<Versioned<PlayerRow>>();
    throw conflict('player', now2 ? server(now2) : null, 'El jugador ha cambiado en el servidor durante la sincronización.');
  }
  return result;
}

// --- Partidos -----------------------------------------------------------------

/**
 * Cronómetro tal como lo guarda la aplicación. Se valida su forma y se guardan
 * solo sus campos conocidos (incluido firstHalfEndMs), sin reinterpretarlos.
 */
function cleanClock(c: unknown): ClockState {
  const clock = c as Partial<ClockState> | null;
  if (
    !clock ||
    typeof clock !== 'object' ||
    (clock.period !== 1 && clock.period !== 2) ||
    typeof clock.running !== 'boolean' ||
    !isInt(clock.baseMs, 0) ||
    !(clock.anchorWallMs === null || isInt(clock.anchorWallMs, 0)) ||
    !(clock.firstHalfEndMs === undefined || isInt(clock.firstHalfEndMs, 0))
  ) {
    throw invalid('Cronómetro no válido.');
  }
  return {
    period: clock.period,
    running: clock.running,
    baseMs: clock.baseMs,
    anchorWallMs: clock.anchorWallMs,
    ...(clock.firstHalfEndMs !== undefined && { firstHalfEndMs: clock.firstHalfEndMs }),
  };
}

function validateMatch(m: Match, teamId: Id): Match {
  if (m.teamId !== teamId) throw invalid('El partido no es de este equipo.');
  if (typeof m.opponent !== 'string' || !m.opponent.trim()) throw invalid('Falta el equipo contrario.');
  if (typeof m.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) throw invalid('Fecha no válida.');
  if (m.venue !== 'home' && m.venue !== 'away') throw invalid('Campo no válido.');
  if (typeof m.season !== 'string' || !m.season.trim()) throw invalid('Falta la temporada.');
  if (!['ready', 'in_progress', 'halftime', 'finished'].includes(m.status)) throw invalid('Estado no válido.');
  if (!isInt(m.halfMinutes, 5, 60)) throw invalid('Duración de parte no válida.');
  if (!m.scoreAdjustment || !isInt(m.scoreAdjustment.own, -999, 999) || !isInt(m.scoreAdjustment.opponent, -999, 999)) {
    throw invalid('Corrección de marcador no válida.');
  }
  if (!isIso(m.createdAt) || !isIso(m.updatedAt) || !isIsoOrNull(m.finishedAt) || !isIsoOrNull(m.deletedAt)) {
    throw invalid('Fechas del partido no válidas.');
  }
  if (!Array.isArray(m.squad) || m.squad.length === 0) throw invalid('Convocatoria vacía.');
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const s of m.squad) {
    if (typeof s?.playerId !== 'string' || typeof s.name !== 'string' || !s.name.trim()) throw invalid('Convocado incompleto.');
    if (!isInt(s.number, 0, 99) || (s.position !== 'field' && s.position !== 'goalkeeper')) throw invalid('Convocado no válido.');
    if (ids.has(s.playerId) || numbers.has(s.number)) throw invalid('Convocado o dorsal repetido.');
    ids.add(s.playerId);
    numbers.add(s.number);
  }
  return {
    ...m,
    clock: cleanClock(m.clock),
    squad: m.squad.map((s) => ({ playerId: s.playerId, name: s.name, number: s.number, position: s.position })),
  };
}

const MATCH_CONTENT: (keyof MatchRow)[] = [
  'opponent',
  'date',
  'venue',
  'season',
  'status',
  'half_minutes',
  'clock_json',
  'score_adj_own',
  'score_adj_opponent',
  'finished_at',
  'deleted_at',
];

function sameSquad(a: readonly SquadRow[], b: readonly SquadRow[]): boolean {
  const key = (s: SquadRow) => `${s.player_id}|${s.name}|${s.number}|${s.position}|${s.sort_order}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.length === sb.length && sa.every((k, i) => k === sb[i]);
}

async function readMatch(db: Db, id: Id): Promise<{ row: Versioned<MatchRow> & { recorder_device_id: string | null }; squad: SquadRow[] } | null> {
  const row = await db.prepare('SELECT * FROM matches WHERE id = ?').bind(id).first<Versioned<MatchRow> & { recorder_device_id: string | null }>();
  if (!row) return null;
  const squad = await db.prepare('SELECT * FROM match_squad WHERE match_id = ?').bind(id).all<SquadRow>();
  return { row, squad: squad.results };
}

const serverMatch = (m: NonNullable<Awaited<ReturnType<typeof readMatch>>>) => ({
  version: m.row.version,
  match: rowsToMatch(m.row, m.squad),
});

export async function applyMatchOp(db: Db, auth: AuthContext, op: MatchOp, now = new Date()): Promise<OpResult> {
  await authorize(db, auth, op.teamId, 'match.write');
  const deviceId = requireDevice(auth);
  const done = await previousResult(db, op.opId, deviceId, op.match.id);
  if (done) return done;
  const match = validateMatch(op.match, op.teamId);
  const rows = matchToRows(match);

  // Los convocados deben ser jugadores del equipo ya subidos.
  for (const s of rows.squad) {
    const p = await db.prepare('SELECT 1 AS ok FROM players WHERE id = ? AND team_id = ?').bind(s.player_id, op.teamId).first();
    if (!p) throw new HttpError(422, 'unknown_player', 'La convocatoria incluye un jugador que no está en el servidor. Sube antes la plantilla.');
  }

  const current = await readMatch(db, match.id);
  if (current && current.row.team_id !== op.teamId) throw notFound();
  if (current?.row.recorder_device_id && current.row.recorder_device_id !== deviceId) {
    throw new HttpError(409, 'match_recorded_elsewhere', 'Otro dispositivo registra este partido.');
  }

  let result: OpResult;
  let write: Statement | null = null;
  let squadChanged = false;
  if (!current) {
    if (op.baseVersion !== null) throw conflict('match', null, 'El partido ya no existe en el servidor.');
    // Quien lo sube es quien lo registra.
    const ins = insertSql('matches', { ...rows.match, recorder_device_id: deviceId, version: 1, updated_by_device_id: deviceId });
    write = db.prepare(ins.sql).bind(...ins.values);
    squadChanged = true;
    result = { status: 'applied', entityId: match.id, version: 1 };
  } else if (op.baseVersion === null) {
    const same = MATCH_CONTENT.every((k) => current.row[k] === rows.match[k]) && sameSquad(current.squad, rows.squad);
    if (!same) throw conflict('match', serverMatch(current), 'El partido ya existe con otros datos.');
    result = { status: 'duplicate', entityId: match.id, version: current.row.version };
  } else if (op.baseVersion !== current.row.version) {
    throw conflict('match', serverMatch(current), 'El partido ha cambiado en el servidor desde la última sincronización.');
  } else {
    const version = current.row.version + 1;
    const m = rows.match;
    write = db
      .prepare(
        `UPDATE matches SET opponent = ?, date = ?, venue = ?, season = ?, status = ?, half_minutes = ?, clock_json = ?,
           score_adj_own = ?, score_adj_opponent = ?, updated_at = ?, finished_at = ?, deleted_at = ?,
           recorder_device_id = COALESCE(recorder_device_id, ?), version = ?, updated_by_device_id = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(
        m.opponent,
        m.date,
        m.venue,
        m.season,
        m.status,
        m.half_minutes,
        m.clock_json,
        m.score_adj_own,
        m.score_adj_opponent,
        m.updated_at,
        m.finished_at,
        m.deleted_at,
        deviceId,
        version,
        deviceId,
        match.id,
        current.row.version,
      );
    squadChanged = !sameSquad(current.squad, rows.squad);
    result = { status: 'applied', entityId: match.id, version };
  }

  // Convocatoria: se sustituye entera, solo si la escritura del partido fue la propia.
  const dependent = squadChanged
    ? (guard: string, guardValues: SqlValue[]) => [
        db.prepare(`DELETE FROM match_squad WHERE match_id = ? AND ${guard}`).bind(match.id, ...guardValues),
        ...rows.squad.map((s) =>
          db
            .prepare(
              `INSERT INTO match_squad (match_id, player_id, team_id, name, number, position, sort_order)
               SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
            )
            .bind(s.match_id, s.player_id, s.team_id, s.name, s.number, s.position, s.sort_order, ...guardValues),
        ),
      ]
    : undefined;

  try {
    await commit(db, { op, entity: 'match', table: 'matches', entityId: match.id, deviceId, result, write, dependent, now });
  } catch (e) {
    if (!current && /UNIQUE constraint failed: matches\.id/.test(String(e))) {
      const winner = await readMatch(db, match.id);
      throw conflict('match', winner ? serverMatch(winner) : null, 'El partido se ha creado a la vez desde otra petición.');
    }
    throw e;
  }
  if (!(await wasRecorded(db, op.opId))) {
    const winner = await readMatch(db, match.id);
    throw conflict('match', winner ? serverMatch(winner) : null, 'El partido ha cambiado en el servidor durante la sincronización.');
  }
  return result;
}

// --- Descarga del equipo completo ---------------------------------------------

export interface TeamSnapshot {
  team: ReturnType<typeof rowToTeam>['team'];
  club: { id: Id; name: string };
  /** Último cambio incluido: continuar con GET /api/teams/:id/changes?since=seq. */
  seq: number;
  players: { version: number; player: Player }[];
  /** Incluye los eliminados (con deletedAt) para que el dispositivo los retire. */
  matches: { version: number; match: Match; recordedHere: boolean }[];
  /** Incluye las borradas (con deletedAt); las estadísticas ya las excluyen. */
  events: { version: number; event: ReturnType<typeof rowToEvent> }[];
}

/**
 * Todo el equipo en una lectura coherente (una sola transacción). Solo con
 * team.read. No incluye códigos, tokens ni identificadores de otros
 * dispositivos: de quién registra cada partido solo se dice si es este.
 */
export async function teamSnapshot(db: Db, auth: AuthContext, teamId: Id): Promise<TeamSnapshot> {
  await authorize(db, auth, teamId, 'team.read');
  const [teamRes, clubRes, seqRes, playersRes, matchesRes, squadRes, eventsRes] = await db.batch([
    db.prepare('SELECT * FROM teams WHERE id = ?').bind(teamId),
    db.prepare('SELECT c.id, c.name FROM clubs c JOIN teams t ON t.club_id = c.id WHERE t.id = ?').bind(teamId),
    db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log WHERE team_id = ?').bind(teamId),
    db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY number, id').bind(teamId),
    db.prepare('SELECT * FROM matches WHERE team_id = ? ORDER BY date, created_at, id').bind(teamId),
    db.prepare('SELECT * FROM match_squad WHERE team_id = ?').bind(teamId),
    db
      .prepare(
        `SELECT id, match_id, team_id, player_id, kind, shot_type, result, turnover_type, period, match_time_ms,
                created_at, updated_at, deleted_at, adds_to_previous, version
         FROM events WHERE team_id = ? ORDER BY match_id, period, match_time_ms, created_at, id`,
      )
      .bind(teamId),
  ]);
  const rows = <T>(r: { results?: unknown[] } | undefined) => (r?.results ?? []) as T[];
  const team = rows<TeamRow>(teamRes)[0];
  const club = rows<{ id: string; name: string }>(clubRes)[0];
  if (!team || !club) throw notFound();
  const squads = new Map<string, SquadRow[]>();
  for (const s of rows<SquadRow>(squadRes)) squads.set(s.match_id, [...(squads.get(s.match_id) ?? []), s]);
  return {
    team: rowToTeam(team).team,
    club,
    seq: rows<{ seq: number }>(seqRes)[0]?.seq ?? 0,
    players: rows<Versioned<PlayerRow>>(playersRes).map((p) => ({ version: p.version, player: rowToPlayer(p) })),
    matches: rows<Versioned<MatchRow> & { recorder_device_id: string | null }>(matchesRes).map((m) => ({
      version: m.version,
      match: rowsToMatch(m, squads.get(m.id) ?? []),
      recordedHere: auth.deviceId !== null && m.recorder_device_id === auth.deviceId,
    })),
    events: rows<EventRow & { version: number }>(eventsRes).map((e) => ({ version: e.version, event: rowToEvent(e) })),
  };
}
