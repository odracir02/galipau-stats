// Migración 0006: cuerpo técnico (role). Aditiva. Se comprueba sobre el equipo
// sintético con la misma estructura y volumen que el real (23 jugadores, 3
// partidos finalizados, 273 acciones), tras aplicar 0005.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { eventContent, matchContent, playerContent, stableJson } from '../../src/remote/upload';
import { computeMatchStats } from '../../src/stats/engine';
import { rowsToMatch, rowToEvent, type EventRow, type MatchRow, type SquadRow } from '../src/mapping';
import { teamSnapshot } from '../src/teamsync';
import { NOW } from './seed';
import { migrationFiles, SqliteD1 } from './sqliteD1';
import { before0005 } from './syntheticTeam';

const FILE = '0006_team_officials.sql';
const read = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');

async function before0006() {
  const db = await before0005();
  db.sqlite.exec(read('0005_match_control.sql'));
  return db;
}

function tables(db: SqliteD1): string[] {
  return (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
}
const columns = (db: SqliteD1, t: string) => (db.sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

/** Todas las filas de todas las tablas, con las columnas que ya existían. */
function dump(db: SqliteD1, cols: Record<string, string[]>): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(cols).map(([t, c]) => [t, db.sqlite.prepare(`SELECT ${c.join(', ')} FROM ${t} ORDER BY rowid`).all()]));
}

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

const insertPlayer = (db: SqliteD1, id: string, number: number, extra: Record<string, string> = {}) => {
  const cols = { id, team_id: 'T', name: `P ${id}`, number, position: 'field', active: 1, created_at: NOW, updated_at: NOW, ...extra };
  db.run(`INSERT INTO players (${Object.keys(cols).join(', ')}) VALUES (${Object.keys(cols).map(() => '?').join(', ')})`, ...Object.values(cols));
};

describe('migración 0006', () => {
  it('es la siguiente; solo añade dos columnas, recrea un índice y crea otro', () => {
    expect(migrationFiles().slice(0, 6).at(-1)).toBe(FILE);
    const sql = read(FILE)
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(sql).not.toMatch(/\b(DELETE|INSERT|UPDATE|DROP TABLE|CREATE TABLE|RENAME)\b/i);
    expect(sql.match(/ALTER TABLE (\w+) ADD COLUMN role/g)).toEqual(['ALTER TABLE players ADD COLUMN role', 'ALTER TABLE match_squad ADD COLUMN role']);
    expect(sql.match(/DROP INDEX \w+/g)).toEqual(['DROP INDEX players_active_number']);
  });

  it('conserva intactos jugadores, partidos, convocatorias, acciones, versiones, registros y resultados', async () => {
    const db = await before0006();
    const cols = Object.fromEntries(tables(db).map((t) => [t, columns(db, t)]));
    const before = dump(db, cols);
    const resultsBefore = results(db);
    expect((before.events as unknown[]).length).toBe(273);

    db.sqlite.exec(read(FILE));

    expect(dump(db, cols)).toEqual(before);
    expect(results(db)).toEqual(resultsBefore);
    expect(tables(db)).toEqual(Object.keys(cols).sort());
    expect(db.sqlite.prepare('SELECT DISTINCT role FROM players').all()).toEqual([{ role: 'player' }]);
    expect(db.sqlite.prepare('SELECT DISTINCT role FROM match_squad').all()).toEqual([{ role: 'player' }]);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('la descarga tras migrar da los mismos datos y huellas (sin rol en ningún jugador)', async () => {
    const db = await before0006();
    const resultsBefore = results(db);
    const iphone = { deviceId: 'iphone', grants: [{ id: 'g', deviceId: 'iphone', clubId: 'C', teamId: 'T', role: 'coach' as const }] };
    const snapBefore = await teamSnapshot(db, iphone, 'T');
    db.sqlite.exec(read(FILE));
    const snap = await teamSnapshot(db, iphone, 'T');
    expect(snap).toEqual(snapBefore);
    expect(JSON.stringify(snap)).not.toContain('"role"');
    expect(snap.events).toHaveLength(273);
    for (const r of resultsBefore) {
      expect(stableJson(matchContent(snap.matches.find((x) => x.match.id === r.id)!.match))).toBe(r.hash);
    }
    expect(snap.players.map((p) => stableJson(playerContent(p.player)))).toEqual(snapBefore.players.map((p) => stableJson(playerContent(p.player))));
  });

  it('dorsales: únicos entre jugadores activos; el 0 técnico de los oficiales no choca', async () => {
    const db = await before0006();
    db.sqlite.exec(read(FILE));
    // p0 tiene el 1: otro jugador activo con el 1 sigue sin poder entrar.
    expect(() => insertPlayer(db, 'dup', 1)).toThrow(/UNIQUE/);
    // Un jugador con el 0 y dos oficiales con el 0 técnico conviven.
    insertPlayer(db, 'cero', 0);
    insertPlayer(db, 'of1', 0, { role: 'official' });
    insertPlayer(db, 'of2', 0, { role: 'official' });
    // Un oficial con dorsal o como portero, o un rol desconocido: no.
    expect(() => insertPlayer(db, 'of3', 5, { role: 'official' })).toThrow(/CHECK/);
    expect(() => insertPlayer(db, 'of4', 0, { role: 'official', position: 'goalkeeper' })).toThrow(/CHECK/);
    expect(() => insertPlayer(db, 'raro', 44, { role: 'staff' })).toThrow(/CHECK/);
  });

  it('se aplica sobre una base vacía y queda registrada', () => {
    const db = new SqliteD1();
    expect(db.migrate()).toContain(FILE);
    expect(columns(db, 'players')).toContain('role');
    expect(columns(db, 'match_squad')).toContain('role');
  });
});
