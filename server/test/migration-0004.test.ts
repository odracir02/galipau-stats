// Migración 0004: sanción adicional en acciones y autor del último cambio de
// jugadores y partidos. Aditiva.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addClub, addMatch, addRoster, addTeam, NOW } from './seed';
import { migrationFiles, SqliteD1 } from './sqliteD1';

const FILE = '0004_team_sync.sql';
const read = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');

/** Base de datos con datos reales anteriores a 0004. */
function before0004(): SqliteD1 {
  const db = new SqliteD1();
  for (const f of migrationFiles().slice(0, 3)) db.sqlite.exec(read(f));
  addClub(db, 'A');
  addTeam(db, 'a1', 'A', 'SM2627');
  addRoster(db, 'a1', 'a1-');
  addMatch(db, 'a1', {}, 'a1-');
  db.run(
    `INSERT INTO events (id, match_id, team_id, player_id, kind, period, match_time_ms, created_at, updated_at)
     VALUES ('e1', 'm1', 'a1', 'a1-p7', 'exclusion', 1, 60000, ?, ?)`,
    NOW,
    NOW,
  );
  return db;
}

describe('migración 0004', () => {
  it('va tras 0003 y solo añade columnas', () => {
    expect(migrationFiles().slice(0, 4)).toEqual([
      '0001_initial.sql',
      '0002_cloudflare_access.sql',
      '0003_clubs_status_and_codes.sql',
      FILE,
    ]);
    const sql = read(FILE)
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      // «ON DELETE SET NULL» es parte de una clave foránea, no un borrado.
      .replace(/ON DELETE SET NULL/g, '');
    expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT)\b/i);
    expect(sql.match(/ALTER TABLE \w+ ADD COLUMN/g)).toHaveLength(3);
  });

  it('conserva los datos existentes: acciones sin marca y jugadores/partidos sin autor', () => {
    const db = before0004();
    db.sqlite.exec(read(FILE));
    expect(db.sqlite.prepare("SELECT kind, adds_to_previous FROM events WHERE id = 'e1'").get()).toEqual({ kind: 'exclusion', adds_to_previous: 0 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM players WHERE team_id = 'a1' AND updated_by_device_id IS NULL").get()).toEqual({ n: 5 });
    expect(db.sqlite.prepare("SELECT updated_by_device_id FROM matches WHERE id = 'm1'").get()).toEqual({ updated_by_device_id: null });
  });

  it('la marca solo es válida en exclusiones o rojas con jugador', () => {
    const db = before0004();
    db.sqlite.exec(read(FILE));
    db.run("UPDATE events SET adds_to_previous = 1 WHERE id = 'e1'");
    const insert = (id: string, kind: string, player: string | null) =>
      db.run(
        `INSERT INTO events (id, match_id, team_id, player_id, kind, period, match_time_ms, created_at, updated_at, adds_to_previous)
         VALUES (?, 'm1', 'a1', ?, ?, 1, 0, ?, ?, 1)`,
        id,
        player,
        kind,
        NOW,
        NOW,
      );
    insert('e2', 'red', 'a1-p7');
    expect(() => insert('e3', 'yellow', 'a1-p7')).toThrow(/CHECK/);
    expect(() => insert('e4', 'exclusion', null)).toThrow(/CHECK/);
    expect(() => db.run("UPDATE events SET adds_to_previous = 2 WHERE id = 'e1'")).toThrow(/CHECK/);
  });
});
