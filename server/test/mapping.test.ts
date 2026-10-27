import { beforeEach, describe, expect, it } from 'vitest';
import type { Match, MatchEvent, Player, Team } from '../../src/domain/types';
import { computeMatchStats, savePct } from '../../src/stats/engine';
import { ev, goal, makeMatch, SQUAD } from '../../src/test/fixtures';
import {
  eventToRow,
  insertSql,
  matchToRows,
  playerToRow,
  rowsToMatch,
  rowToEvent,
  rowToPlayer,
  rowToTeam,
  teamToRow,
  type EventRow,
  type MatchRow,
  type PlayerRow,
  type SquadRow,
  type TeamRow,
} from '../src/mapping';
import { addClub, NOW } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

let db: SqliteD1;
beforeEach(() => {
  db = migratedDb();
  addClub(db, 'A');
});

function insert(table: string, row: object) {
  const { sql, values } = insertSql(table, row);
  db.run(sql, ...values);
}

const team: Team = { id: 't1', name: 'Senior Masculino', code: 'SM2627', season: '2026/27', maxSquad: 16, createdAt: NOW, updatedAt: NOW };

function storeTeamAndRoster() {
  insert('teams', teamToRow(team, { clubId: 'A', category: 'Senior', gender: 'male' }));
  for (const s of SQUAD) {
    const p: Player = { id: s.playerId, teamId: 't1', name: s.name, number: s.number, position: s.position, active: true, createdAt: NOW, updatedAt: NOW };
    insert('players', playerToRow(p));
  }
}

function storeMatch(m: Match) {
  const rows = matchToRows(m);
  insert('matches', rows.match);
  for (const s of rows.squad) insert('match_squad', s);
}

function readMatch(id: string): Match {
  const row = db.sqlite.prepare('SELECT * FROM matches WHERE id = ?').get(id) as unknown as MatchRow;
  const squad = db.sqlite.prepare('SELECT * FROM match_squad WHERE match_id = ?').all(id) as unknown as SquadRow[];
  return rowsToMatch(row, squad);
}

function readEvents(matchId: string): MatchEvent[] {
  return (db.sqlite.prepare('SELECT * FROM events WHERE match_id = ?').all(matchId) as unknown as EventRow[]).map(rowToEvent);
}

describe('ida y vuelta por la base de datos', () => {
  beforeEach(storeTeamAndRoster);

  it('equipo y jugador conservan todos sus campos e identificadores', () => {
    const row = db.sqlite.prepare('SELECT * FROM teams').get() as unknown as TeamRow;
    expect(rowToTeam(row)).toEqual({ team, remote: { clubId: 'A', category: 'Senior', gender: 'male' } });
    const p = db.sqlite.prepare("SELECT * FROM players WHERE id = 'g1'").get() as unknown as PlayerRow;
    expect(rowToPlayer(p)).toEqual({ id: 'g1', teamId: 't1', name: 'Portero Uno', number: 1, position: 'goalkeeper', active: true, createdAt: NOW, updatedAt: NOW });
  });

  it('partido, convocatoria (en su orden), cronómetro y corrección del marcador', () => {
    const m = makeMatch({
      teamId: 't1',
      status: 'halftime',
      clock: { period: 2, running: false, baseMs: 1_800_000, anchorWallMs: null },
      scoreAdjustment: { own: 2, opponent: -1 },
      squad: [...SQUAD].reverse(),
      deletedAt: NOW,
      finishedAt: null,
    });
    storeMatch(m);
    expect(readMatch('m1')).toEqual(m);
  });

  it('todas las clases de acción, pendientes, borradas y golpes francos antiguos', () => {
    storeMatch(makeMatch({ teamId: 't1' }));
    const events: MatchEvent[] = [
      ev(goal('fast_break'), 'p7', 2),
      ev({ kind: 'shot', shotType: 'six_m', result: 'saved' }, 'p14', 3),
      ev({ kind: 'gk_shot', shotType: 'wing', result: 'out' }, 'g1', 4),
      ev({ kind: 'turnover', turnoverType: 'bad_pass' }, null, 5),
      ev({ kind: 'recovery' }, 'p69', 6, { deleted: true }),
      ev({ kind: 'free_throw' }, 'p7', 7),
      ev({ kind: 'penalty_committed' }, 'p14', 40, { period: 2 }),
    ];
    for (const e of events) insert('events', eventToRow(e, 't1'));
    const back = readEvents('m1').sort((a, b) => a.id.localeCompare(b.id));
    expect(back).toEqual([...events].sort((a, b) => a.id.localeCompare(b.id)));
    // La serialización JSON (la que viaja por la red) tampoco cambia nada.
    expect(JSON.parse(JSON.stringify(back))).toEqual(back);
  });
});

describe('las estadísticas no cambian al pasar por el servidor', () => {
  beforeEach(storeTeamAndRoster);

  it('tercera exclusión, % de paradas, pendientes y acciones borradas', () => {
    const match = makeMatch({ teamId: 't1', scoreAdjustment: { own: 1, opponent: 0 } });
    const events: MatchEvent[] = [
      ev({ kind: 'exclusion' }, 'p7', 5),
      ev({ kind: 'exclusion' }, 'p7', 15),
      ev({ kind: 'exclusion' }, 'p7', 35, { period: 2 }),
      ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'save' }, 'g1', 6),
      ev({ kind: 'gk_shot', shotType: 'six_m', result: 'goal' }, 'g1', 7),
      ev({ kind: 'gk_shot', shotType: 'wing', result: 'out' }, 'g1', 8),
      ev(goal(), 'p14', 9),
      ev(goal(), null, 10),
      ev(goal(), 'p69', 11, { deleted: true }),
    ];
    storeMatch(match);
    for (const e of events) insert('events', eventToRow(e, 't1'));

    const local = computeMatchStats(match, events);
    const remote = computeMatchStats(readMatch('m1'), readEvents('m1'));
    expect(remote).toEqual(local);
    expect(remote.players.get('p7')).toMatchObject({ exclusions: 3, reds: 1, redsAccumulated: 1 });
    expect(savePct(remote.players.get('g1')!.gk)).toBe(50);
    expect(remote.score).toMatchObject({ own: 3, opponent: 1 });
    expect(remote.pendingCount).toBe(1);
  });
});
