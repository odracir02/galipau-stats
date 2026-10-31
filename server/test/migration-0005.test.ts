// Migración 0005: control de registro de los partidos. Aditiva. Se comprueba
// sobre un equipo sintético con la misma estructura y volumen que el real
// (23 jugadores, 3 partidos finalizados, 273 acciones), más partidos en curso.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { eventContent, matchContent, playerContent, stableJson } from '../../src/remote/upload';
import { computeMatchStats } from '../../src/stats/engine';
import { rowsToMatch, rowToEvent, type EventRow, type MatchRow, type SquadRow } from '../src/mapping';
import { teamSnapshot } from '../src/teamsync';
import { migrationFiles, SqliteD1 } from './sqliteD1';
import { before0005 } from './syntheticTeam';

const FILE = '0005_match_control.sql';
const read = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');


/** Todas las filas de todas las tablas, solo con las columnas anteriores a 0005. */
function dump(db: SqliteD1, columns?: Record<string, string[]>): Record<string, unknown[]> {
  const tables = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    if (columns && !columns[t]) continue; // tabla nueva: se comprueba aparte
    const cols = columns?.[t] ?? (db.sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    if (cols.length === 0) continue;
    out[t] = db.sqlite.prepare(`SELECT ${cols.join(', ')} FROM ${t} ORDER BY rowid`).all();
  }
  return out;
}

function columnsOf(db: SqliteD1): Record<string, string[]> {
  const tables = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
  return Object.fromEntries(tables.map((t) => [t, (db.sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)]));
}

/** Resultados y huellas tal como los calcula la aplicación, leyendo las filas. */
function results(db: SqliteD1) {
  const matches = db.sqlite.prepare("SELECT * FROM matches WHERE team_id = 'T' ORDER BY id").all() as unknown as MatchRow[];
  const events = (db.sqlite.prepare("SELECT * FROM events WHERE team_id = 'T' ORDER BY id").all() as unknown as EventRow[]).map(rowToEvent);
  return matches.map((row) => {
    const squad = db.sqlite.prepare('SELECT * FROM match_squad WHERE match_id = ?').all(row.id) as unknown as SquadRow[];
    const match = rowsToMatch(row, squad);
    const own = events.filter((e) => e.matchId === match.id);
    return { id: match.id, stats: stableJson(computeMatchStats(match, own)), hash: stableJson(matchContent(match)), events: own.map((e) => stableJson(eventContent(e))) };
  });
}

describe('migración 0005', () => {
  it('es la siguiente y solo añade columnas, un índice, una tabla y rellena las columnas nuevas', () => {
    expect(migrationFiles().slice(0, 5)).toEqual([
      '0001_initial.sql',
      '0002_cloudflare_access.sql',
      '0003_clubs_status_and_codes.sql',
      '0004_team_sync.sql',
      FILE,
    ]);
    const sql = read(FILE)
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .replace(/ON DELETE (SET NULL|CASCADE)/g, '');
    expect(sql).not.toMatch(/\b(DROP|DELETE|INSERT)\b/i);
    expect(sql.match(/ALTER TABLE matches ADD COLUMN/g)).toHaveLength(4);
    // La única actualización solo escribe columnas nuevas.
    const updates = [...sql.matchAll(/UPDATE (\w+)\s+SET([\s\S]*?)WHERE/g)];
    expect(updates).toHaveLength(1);
    expect(updates[0]![1]).toBe('matches');
    const assigned = [...updates[0]![2]!.matchAll(/(\w+)\s*=/g)].map((x) => x[1]);
    expect(assigned).toEqual(['control_device_id', 'control_epoch', 'control_since', 'control_seen_at']);
  });

  it('conserva intactos jugadores, partidos, acciones, versiones, registros y resultados', async () => {
    const db = await before0005();
    const columns = columnsOf(db);
    const before = dump(db, columns);
    const resultsBefore = results(db);
    expect(before.players).toHaveLength(23 + 4);
    expect((before.events as unknown[]).length).toBe(273);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM matches WHERE team_id = 'T'").get()).toEqual({ n: 3 });

    db.sqlite.exec(read(FILE));

    // Mismas filas y mismos valores en todas las columnas que ya existían.
    expect(dump(db, columns)).toEqual(before);
    expect(results(db)).toEqual(resultsBefore);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });

    // Los finalizados quedan sin control (los puede corregir cualquier entrenador).
    expect(db.sqlite.prepare("SELECT DISTINCT control_device_id, control_epoch FROM matches WHERE team_id = 'T'").all()).toEqual([
      { control_device_id: null, control_epoch: 0 },
    ]);
    // En curso o en el descanso: su registrador, si sigue vigente.
    expect(db.sqlite.prepare("SELECT id, control_device_id, control_epoch FROM matches WHERE team_id = 'T2' ORDER BY id").all()).toEqual([
      { id: 'v1', control_device_id: 'iphone', control_epoch: 1 },
      { id: 'v2', control_device_id: 'iphone', control_epoch: 1 },
      { id: 'v3', control_device_id: null, control_epoch: 0 },
      { id: 'v4', control_device_id: null, control_epoch: 0 },
    ]);
  });

  it('la descarga del equipo tras migrar da los mismos datos y huellas que antes', async () => {
    const db = await before0005();
    const resultsBefore = results(db);
    const playersBefore = (db.sqlite.prepare("SELECT * FROM players WHERE team_id = 'T' ORDER BY id").all() as unknown[]).length;
    db.sqlite.exec(read(FILE));
    const iphone = { deviceId: 'iphone', grants: [{ id: 'g', deviceId: 'iphone', clubId: 'C', teamId: 'T', role: 'coach' as const }] };
    const snap = await teamSnapshot(db, iphone, 'T');
    expect(snap.players).toHaveLength(playersBefore);
    expect(snap.matches).toHaveLength(3);
    expect(snap.events).toHaveLength(273);
    expect(snap.matches.every((m) => m.control.holder === null)).toBe(true);
    // Mismas huellas que tiene guardadas el iPhone: no hay nada que reenviar.
    for (const r of resultsBefore) {
      const m = snap.matches.find((x) => x.match.id === r.id)!.match;
      expect(stableJson(matchContent(m))).toBe(r.hash);
      const own = snap.events.map((e) => e.event).filter((e) => e.matchId === r.id);
      expect(own.map((e) => stableJson(eventContent(e))).sort()).toEqual([...r.events].sort());
      expect(stableJson(computeMatchStats(m, own))).toBe(r.stats);
    }
    expect(snap.players.every((p) => typeof stableJson(playerContent(p.player)) === 'string')).toBe(true);
  });

  it('se aplica sobre una base vacía y queda registrada', () => {
    const db = new SqliteD1();
    expect(db.migrate()).toContain(FILE);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM match_control_log').get()).toEqual({ n: 0 });
  });
});
