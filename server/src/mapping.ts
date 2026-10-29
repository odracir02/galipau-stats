// Correspondencia entre los modelos de la aplicación (src/domain/types.ts, lo que
// guarda IndexedDB) y las filas de D1. Los identificadores se conservan tal cual:
// el mismo UUID identifica el registro en el dispositivo y en el servidor.
// Los campos solo del servidor (club, categoría, versión…) van aparte.
import type {
  ClockState,
  Match,
  MatchEvent,
  Player,
  SquadEntry,
  Team,
} from '../../src/domain/types';
import type { TeamRemoteFields } from './model';

export interface TeamRow {
  id: string;
  club_id: string;
  name: string;
  code: string;
  season: string;
  category: string | null;
  gender: string | null;
  max_squad: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PlayerRow {
  id: string;
  team_id: string;
  person_id: string | null;
  name: string;
  number: number;
  position: string;
  active: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MatchRow {
  id: string;
  team_id: string;
  opponent: string;
  date: string;
  venue: string;
  season: string;
  status: string;
  half_minutes: number;
  clock_json: string;
  score_adj_own: number;
  score_adj_opponent: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  deleted_at: string | null;
}

export interface SquadRow {
  match_id: string;
  player_id: string;
  team_id: string;
  name: string;
  number: number;
  position: string;
  sort_order: number;
}

export interface EventRow {
  id: string;
  match_id: string;
  team_id: string;
  player_id: string | null;
  kind: string;
  shot_type: string | null;
  result: string | null;
  turnover_type: string | null;
  period: number;
  match_time_ms: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** Sanción adicional antes de reanudar (0/1; migración 0004). */
  adds_to_previous: number;
}

// --- Equipo -------------------------------------------------------------------

export function teamToRow(team: Team, remote: TeamRemoteFields): TeamRow {
  return {
    id: team.id,
    club_id: remote.clubId,
    name: team.name,
    code: team.code,
    season: team.season,
    category: remote.category,
    gender: remote.gender,
    max_squad: team.maxSquad,
    created_at: team.createdAt,
    updated_at: team.updatedAt,
    deleted_at: null,
  };
}

export function rowToTeam(row: TeamRow): { team: Team; remote: TeamRemoteFields } {
  return {
    team: {
      id: row.id,
      name: row.name,
      code: row.code,
      season: row.season,
      maxSquad: row.max_squad,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    remote: { clubId: row.club_id, category: row.category, gender: row.gender as TeamRemoteFields['gender'] },
  };
}

// --- Jugador ------------------------------------------------------------------

export function playerToRow(p: Player, personId: string | null = null): PlayerRow {
  return {
    id: p.id,
    team_id: p.teamId,
    person_id: personId,
    name: p.name,
    number: p.number,
    position: p.position,
    active: p.active ? 1 : 0,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    deleted_at: null,
  };
}

export function rowToPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    number: row.number,
    position: row.position as Player['position'],
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Partido y convocatoria ---------------------------------------------------

export function matchToRows(m: Match): { match: MatchRow; squad: SquadRow[] } {
  return {
    match: {
      id: m.id,
      team_id: m.teamId,
      opponent: m.opponent,
      date: m.date,
      venue: m.venue,
      season: m.season,
      status: m.status,
      half_minutes: m.halfMinutes,
      clock_json: JSON.stringify(m.clock),
      score_adj_own: m.scoreAdjustment.own,
      score_adj_opponent: m.scoreAdjustment.opponent,
      created_at: m.createdAt,
      updated_at: m.updatedAt,
      finished_at: m.finishedAt,
      deleted_at: m.deletedAt,
    },
    squad: m.squad.map((s, i) => ({
      match_id: m.id,
      player_id: s.playerId,
      team_id: m.teamId,
      name: s.name,
      number: s.number,
      position: s.position,
      sort_order: i,
    })),
  };
}

export function rowsToMatch(row: MatchRow, squad: readonly SquadRow[]): Match {
  return {
    id: row.id,
    teamId: row.team_id,
    opponent: row.opponent,
    date: row.date,
    venue: row.venue as Match['venue'],
    season: row.season,
    status: row.status as Match['status'],
    halfMinutes: row.half_minutes,
    squad: [...squad]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(
        (s): SquadEntry => ({
          playerId: s.player_id,
          name: s.name,
          number: s.number,
          position: s.position as SquadEntry['position'],
        }),
      ),
    clock: JSON.parse(row.clock_json) as ClockState,
    scoreAdjustment: { own: row.score_adj_own, opponent: row.score_adj_opponent },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    deletedAt: row.deleted_at,
  };
}

// --- Evento -------------------------------------------------------------------

export function eventToRow(e: MatchEvent, teamId: string): EventRow {
  return {
    id: e.id,
    match_id: e.matchId,
    team_id: teamId,
    player_id: e.playerId,
    kind: e.kind,
    shot_type: e.kind === 'shot' || e.kind === 'gk_shot' ? e.shotType : null,
    result: e.kind === 'shot' || e.kind === 'gk_shot' ? e.result : null,
    turnover_type: e.kind === 'turnover' ? e.turnoverType : null,
    period: e.period,
    match_time_ms: e.matchTimeMs,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    deleted_at: e.deletedAt,
    adds_to_previous: e.addsToPrevious === true ? 1 : 0,
  };
}

export function rowToEvent(row: EventRow): MatchEvent {
  const base = {
    id: row.id,
    matchId: row.match_id,
    playerId: row.player_id,
    period: row.period as MatchEvent['period'],
    matchTimeMs: row.match_time_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    // Solo presente cuando vale: igual que en la aplicación.
    ...(row.adds_to_previous === 1 && { addsToPrevious: true as const }),
  };
  switch (row.kind) {
    case 'shot':
    case 'gk_shot':
      return { ...base, kind: row.kind, shotType: row.shot_type, result: row.result } as MatchEvent;
    case 'turnover':
      return { ...base, kind: 'turnover', turnoverType: row.turnover_type } as MatchEvent;
    default:
      return { ...base, kind: row.kind } as MatchEvent;
  }
}

/** Contenido comparable de un evento (sin metadatos de sincronización). */
export function sameEventContent(a: EventRow, b: EventRow): boolean {
  const keys: (keyof EventRow)[] = [
    'match_id',
    'player_id',
    'kind',
    'shot_type',
    'result',
    'turnover_type',
    'period',
    'match_time_ms',
    'deleted_at',
    'adds_to_previous',
  ];
  return keys.every((k) => a[k] === b[k]);
}

/** Sentencia INSERT parametrizada a partir de una fila. */
export function insertSql(table: string, row: object): { sql: string; values: (string | number | null)[] } {
  const cols = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    values: Object.values(row) as (string | number | null)[],
  };
}
