// Equipo sintético con la misma estructura y volumen que el real (23 jugadores,
// 3 partidos finalizados, 273 acciones con correcciones, borrados y sanciones),
// más partidos en curso, en el descanso y de un dispositivo revocado en otro
// equipo. Sobre el esquema anterior a la migración 0005. Para las pruebas de
// migración; nunca contiene datos reales.
import { readFileSync } from 'node:fs';
import type { MatchEvent, Player } from '../../src/domain/types';
import { ev, goal, makeMatch } from '../../src/test/fixtures';
import { eventToRow, insertSql, matchToRows, playerToRow } from '../src/mapping';
import { addClub, addDevice, addTeam, NOW } from './seed';
import { migrationFiles, SqliteD1 } from './sqliteD1';

const read = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');

function insert(db: SqliteD1, table: string, row: object): void {
  const { sql, values } = insertSql(table, row);
  db.run(sql, ...values);
}

/** Base con todas las migraciones anteriores a 0005 y un club como el real. */
export async function before0005() {
  const db = new SqliteD1();
  for (const f of migrationFiles().filter((f) => f < '0005')) db.sqlite.exec(read(f));
  addClub(db, 'C', 'Club sintético');
  addTeam(db, 'T', 'C', 'SMA2627');
  addTeam(db, 'T2', 'C', 'JF2627');
  await addDevice(db, 'iphone', [
    { clubId: 'C', teamId: 'T', role: 'coach' },
    { clubId: 'C', teamId: 'T2', role: 'coach' },
  ]);
  await addDevice(db, 'viejo', [{ clubId: 'C', teamId: 'T2', role: 'coach' }]);
  db.run("UPDATE devices SET revoked_at = ? WHERE id = 'viejo'", NOW);

  // 23 jugadores (3 porteros), algunos ya editados (versión 2).
  const players: Player[] = Array.from({ length: 23 }, (_, i) => ({
    id: `p${i}`,
    teamId: 'T',
    name: `Jugador ${i + 1}`,
    number: i + 1,
    position: i < 3 ? 'goalkeeper' : 'field',
    active: i !== 22,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  for (const [i, p] of players.entries()) insert(db, 'players', { ...playerToRow(p), version: i % 4 === 0 ? 2 : 1, updated_by_device_id: 'iphone' });
  const squad = players.slice(0, 16).map((p) => ({ playerId: p.id, name: p.name, number: p.number, position: p.position }));

  // 3 partidos finalizados con 91 acciones cada uno (273), con correcciones,
  // borrados y sanciones adicionales.
  let n = 0;
  for (let m = 0; m < 3; m++) {
    const match = makeMatch({
      id: `m${m}`,
      teamId: 'T',
      opponent: `Rival ${m}`,
      date: `2026-10-0${m + 4}`,
      status: 'finished',
      squad,
      scoreAdjustment: { own: m, opponent: 0 },
      finishedAt: NOW,
      clock: { period: 2, running: false, baseMs: 3_600_000, anchorWallMs: null, firstHalfEndMs: 1_800_000 },
    });
    const rows = matchToRows(match);
    insert(db, 'matches', { ...rows.match, recorder_device_id: 'iphone', version: m + 1, updated_by_device_id: 'iphone' });
    for (const s of rows.squad) insert(db, 'match_squad', s);
    for (let i = 0; i < 91; i++) {
      const field = players[3 + (i % 13)]!.id;
      let e: MatchEvent =
        i % 7 === 0
          ? ev({ kind: 'gk_shot', shotType: 'nine_m', result: i % 2 ? 'goal' : 'save' }, players[0]!.id, i % 59, { matchId: match.id })
          : i % 11 === 0
            ? ev({ kind: 'exclusion' }, field, i % 59, { matchId: match.id })
            : ev(i % 3 ? goal() : { kind: 'shot', shotType: 'six_m', result: 'saved' }, field, i % 59, { matchId: match.id });
      if (i % 17 === 0) e = { ...e, deletedAt: NOW };
      insert(db, 'events', { ...eventToRow(e, 'T'), version: i % 5 === 0 ? 2 : 1, updated_by_device_id: 'iphone' });
      n++;
      insert(db, 'change_log', { team_id: 'T', entity: 'event', entity_id: e.id, version: 1, changed_at: NOW });
      insert(db, 'sync_ops', { op_id: `op-${n}`, device_id: 'iphone', team_id: 'T', entity: 'event', entity_id: e.id, result_json: '{}', received_at: NOW });
    }
  }

  // Partidos en curso en otro equipo: uno del iPhone, uno en el descanso y uno
  // de un dispositivo ya revocado.
  for (const [i, [id, status, recorder]] of ([
    ['v1', 'in_progress', 'iphone'],
    ['v2', 'halftime', 'iphone'],
    ['v3', 'in_progress', 'viejo'],
    ['v4', 'ready', 'iphone'],
  ] as const).entries()) {
    const p = { ...players[3]!, id: `t2-${id}`, teamId: 'T2', number: 90 + i };
    insert(db, 'players', { ...playerToRow(p), version: 1 });
    const match = makeMatch({ id, teamId: 'T2', status, squad: [{ playerId: p.id, name: p.name, number: p.number, position: 'field' }] });
    const rows = matchToRows(match);
    insert(db, 'matches', { ...rows.match, recorder_device_id: recorder, version: 1 });
    for (const s of rows.squad) insert(db, 'match_squad', s);
  }
  return db;
}
