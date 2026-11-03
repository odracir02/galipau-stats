// Migración 0007: identidad común entre equipos del club y base de los rankings
// de club. Aditiva y desactivada. Se comprueba sobre el equipo sintético con la
// misma estructura y volumen que el real, tras aplicar 0005 y 0006, y en una
// base con varios clubes para las reglas de vinculación.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Player } from '../../src/domain/types';
import type { AuthContext } from '../src/model';
import { applyPlayerOp, teamSnapshot, type PlayerOp } from '../src/teamsync';
import { addClub, addDevice, addRoster, addTeam, NOW } from './seed';
import { migratedDb, migrationFiles, SqliteD1 } from './sqliteD1';
import { before0005 } from './syntheticTeam';

const FILE = '0007_club_rankings.sql';
const read = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');

async function before0007() {
  const db = await before0005();
  db.sqlite.exec(read('0005_match_control.sql'));
  db.sqlite.exec(read('0006_team_officials.sql'));
  return db;
}

const tables = (db: SqliteD1) =>
  (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
const columns = (db: SqliteD1, t: string) => (db.sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
const dump = (db: SqliteD1, cols: Record<string, string[]>) =>
  Object.fromEntries(Object.entries(cols).map(([t, c]) => [t, db.sqlite.prepare(`SELECT ${c.join(', ')} FROM ${t} ORDER BY rowid`).all()]));
const one = <T>(db: SqliteD1, sql: string, ...v: (string | number)[]) => db.sqlite.prepare(sql).get(...v) as T;
const rankingsVersion = (db: SqliteD1, club = 'A') => one<{ v: number }>(db, 'SELECT rankings_version AS v FROM clubs WHERE id = ?', club).v;
const errorOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
};

describe('migración 0007: estructura y datos existentes', () => {
  it('es la siguiente; solo añade columnas, índices, triggers y la tabla de caché', () => {
    expect(migrationFiles().slice(0, 7).at(-1)).toBe(FILE);
    const sql = read(FILE)
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    // Ningún cambio de datos fuera de los triggers (que solo suben rankings_version).
    const outsideTriggers = sql.replace(/CREATE TRIGGER[\s\S]*?END;/g, '');
    expect(outsideTriggers).not.toMatch(/\b(DELETE FROM|INSERT INTO|UPDATE \w+ SET|DROP|RENAME)\b/i);
    expect(outsideTriggers.match(/CREATE TABLE (\w+)/g)).toEqual(['CREATE TABLE club_rankings_cache']);
    for (const body of sql.match(/BEGIN[\s\S]*?END;/g)!) expect(body).toMatch(/RAISE\(ABORT|UPDATE clubs SET rankings_version = rankings_version \+ 1/);
  });

  it('conserva intactas todas las filas, versiones, registros de cambios y resultados', async () => {
    const db = await before0007();
    const cols = Object.fromEntries(tables(db).map((t) => [t, columns(db, t)]));
    const before = dump(db, cols);
    expect((before.events as unknown[]).length).toBe(273);
    db.sqlite.exec(read(FILE));
    expect(dump(db, cols)).toEqual(before);
    expect(tables(db)).toEqual([...Object.keys(cols), 'club_rankings_cache'].sort());
    // Todo desactivado por defecto.
    expect(db.sqlite.prepare('SELECT DISTINCT rankings_visibility AS v, rankings_version AS n FROM clubs').all()).toEqual([{ v: 'admins', n: 0 }]);
    expect(db.sqlite.prepare('SELECT DISTINCT club_rankings AS c, ranking_group AS g FROM teams').all()).toEqual([{ c: 0, g: null }]);
    expect(db.sqlite.prepare('SELECT DISTINCT ranking_excluded AS e FROM players').all()).toEqual([{ e: 0 }]);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM club_rankings_cache').get()).toEqual({ n: 0 });
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('las respuestas del Worker no cambian: la descarga del equipo es idéntica', async () => {
    const db = await before0007();
    const iphone = { deviceId: 'iphone', grants: [{ id: 'g', deviceId: 'iphone', clubId: 'C', teamId: 'T', role: 'coach' as const }] };
    const snapBefore = await teamSnapshot(db, iphone, 'T');
    db.sqlite.exec(read(FILE));
    const snap = await teamSnapshot(db, iphone, 'T');
    expect(snap).toEqual(snapBefore);
    expect(JSON.stringify(snap)).not.toMatch(/person|ranking/i);
  });

  it('se aplica sobre una base vacía y queda registrada', () => {
    const db = new SqliteD1();
    expect(db.migrate()).toContain(FILE);
    expect(columns(db, 'clubs')).toEqual(expect.arrayContaining(['rankings_visibility', 'rankings_version']));
    expect(columns(db, 'teams')).toEqual(expect.arrayContaining(['club_rankings', 'ranking_group']));
    expect(columns(db, 'players')).toContain('ranking_excluded');
    expect(columns(db, 'people')).toContain('ranking_excluded');
  });

  it('se aplica sobre una base con datos de 0001 a 0006 (migraciones pendientes)', () => {
    const db = new SqliteD1();
    expect(db.migrate('0006_team_officials.sql')).not.toContain(FILE);
    addClub(db, 'A');
    addTeam(db, 'ta', 'A', 'SMA2627');
    addRoster(db, 'ta', 'a-');
    expect(db.migrate()).toEqual([FILE]);
    expect(one(db, "SELECT person_id, ranking_excluded FROM players WHERE id = 'a-p7'")).toEqual({ person_id: null, ranking_excluded: 0 });
  });
});

describe('migración 0007: vinculación de fichas', () => {
  let db: SqliteD1;
  const person = (id: string, club = 'A') =>
    db.run('INSERT INTO people (id, club_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, club, `Persona ${id}`, NOW, NOW);
  const link = (player: string, p: string | null) => db.run('UPDATE players SET person_id = ? WHERE id = ?', p, player);
  const insert = (id: string, team: string, p: string, role = 'player', number = 50) =>
    db.run(
      'INSERT INTO players (id, team_id, person_id, name, number, position, active, created_at, updated_at, role) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      id, team, p, 'Ficha nueva', number, 'field', NOW, NOW, role,
    );

  beforeEach(() => {
    db = migratedDb();
    addClub(db, 'A');
    addClub(db, 'B');
    addTeam(db, 'ta', 'A', 'SMA2627');
    addTeam(db, 'tb', 'A', 'SMB2627');
    addTeam(db, 'tx', 'B', 'XXX2627');
    addRoster(db, 'ta', 'a-');
    addRoster(db, 'tb', 'b-');
    addRoster(db, 'tx', 'x-');
    person('ana');
    person('bea');
    person('otra', 'B');
  });

  it('fichas de distintos equipos del mismo club: sí; de otro club: no', () => {
    expect(errorOf(() => link('a-p7', 'ana'))).toBeNull();
    expect(errorOf(() => link('b-p7', 'ana'))).toBeNull();
    expect(errorOf(() => link('x-p7', 'ana'))).toMatch(/person_other_club/);
    expect(errorOf(() => insert('n1', 'tx', 'ana'))).toMatch(/person_other_club/);
  });

  it('nunca un oficial ni una persona borrada o inexistente (al vincular y al dar de alta)', () => {
    db.run("UPDATE players SET role = 'official', number = 0, position = 'field' WHERE id = 'a-p69'");
    expect(errorOf(() => link('a-p69', 'bea'))).toMatch(/person_link_invalid/);
    expect(errorOf(() => insert('n1', 'tb', 'bea', 'official', 0))).toMatch(/person_link_invalid/);
    db.run("UPDATE people SET deleted_at = ? WHERE id = 'bea'", NOW);
    expect(errorOf(() => link('a-g1', 'bea'))).toMatch(/person_link_invalid/);
    expect(errorOf(() => insert('n2', 'tb', 'bea'))).toMatch(/person_link_invalid/);
    expect(errorOf(() => link('a-g1', 'nadie'))).toMatch(/person_link_invalid/);
  });

  it('como mucho una ficha por persona y equipo, también al dar de alta', () => {
    link('a-p7', 'ana');
    expect(errorOf(() => link('a-p14', 'ana'))).toMatch(/UNIQUE/);
    expect(errorOf(() => insert('n1', 'ta', 'ana'))).toMatch(/UNIQUE/);
    expect(errorOf(() => insert('n2', 'tb', 'ana'))).toBeNull();
  });

  it('un jugador vinculado no pasa a oficial; restaurar una ficha borrada nunca crea un duplicado', () => {
    link('a-p7', 'ana');
    expect(errorOf(() => db.run("UPDATE players SET role = 'official', number = 0 WHERE id = 'a-p7'"))).toMatch(/person_link_invalid/);
    db.run("UPDATE players SET deleted_at = ? WHERE id = 'a-p7'", NOW);
    expect(errorOf(() => link('a-p14', 'ana'))).toMatch(/UNIQUE/);
    // La sincronización actualiza con deleted_at vacío: «restaura» sin chocar con nada.
    expect(errorOf(() => db.run("UPDATE players SET deleted_at = NULL, version = version + 1 WHERE id = 'a-p7'"))).toBeNull();
  });

  it('desvincular no toca la ficha ni sus estadísticas; la persona no se borra con fichas ni cambia de club', () => {
    link('a-p7', 'ana');
    const before = one(db, "SELECT name, number, version, updated_at FROM players WHERE id = 'a-p7'");
    expect(errorOf(() => db.run("UPDATE people SET deleted_at = ? WHERE id = 'ana'", NOW))).toMatch(/person_still_linked/);
    expect(errorOf(() => db.run("UPDATE people SET club_id = 'B' WHERE id = 'ana'"))).toMatch(/person_club_fixed/);
    expect(errorOf(() => db.run("UPDATE teams SET club_id = 'B' WHERE id = 'ta'"))).toMatch(/team_has_linked_players/);
    link('a-p7', null);
    expect(one(db, "SELECT name, number, version, updated_at FROM players WHERE id = 'a-p7'")).toEqual(before);
    expect(errorOf(() => db.run("UPDATE people SET deleted_at = ? WHERE id = 'ana'", NOW))).toBeNull();
    // Borrado físico de una persona: sus fichas quedan sin vincular, enteras.
    link('b-p7', 'bea');
    db.run("DELETE FROM people WHERE id = 'bea'");
    expect(one(db, "SELECT person_id, name FROM players WHERE id = 'b-p7'")).toEqual({ person_id: null, name: 'Jugador Siete' });
  });

  it('operaciones simultáneas: de dos vínculos a la misma persona en un equipo entra uno; los lotes son atómicos', async () => {
    const op = (player: string) => db.prepare('UPDATE players SET person_id = ? WHERE id = ? AND person_id IS NULL').bind('ana', player);
    const done = await Promise.allSettled([db.batch([op('a-p7')]), db.batch([op('a-p14')])]);
    expect(done.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(one(db, "SELECT COUNT(*) AS n FROM players WHERE person_id = 'ana' AND team_id = 'ta'")).toEqual({ n: 1 });
    const audit = db.prepare("INSERT INTO admin_audit (identity_id, action, target_type, target_id, at) VALUES (NULL, 'person.link', 'player', 'a-p69', ?)").bind(NOW);
    await expect(db.batch([audit, db.prepare("UPDATE players SET person_id = 'otra' WHERE id = 'a-p69'")])).rejects.toThrow();
    expect(one(db, "SELECT COUNT(*) AS n FROM admin_audit WHERE target_id = 'a-p69'")).toEqual({ n: 0 });
  });

  it('rankings_version sube con todo lo que cambia los rankings, solo en su club', () => {
    let v = rankingsVersion(db);
    const bumped = (what: string) => {
      const now = rankingsVersion(db);
      expect(now, what).toBeGreaterThan(v);
      v = now;
    };
    link('a-p7', 'ana');
    bumped('vincular');
    link('a-p7', null);
    bumped('desvincular');
    insert('n1', 'tb', 'ana');
    bumped('alta ya vinculada');
    db.run("UPDATE players SET ranking_excluded = 1 WHERE id = 'a-p14'");
    bumped('excluir ficha');
    db.run("UPDATE people SET ranking_excluded = 1 WHERE id = 'ana'");
    bumped('excluir persona');
    db.run("UPDATE people SET display_name = 'Ana B.' WHERE id = 'ana'");
    bumped('nombre visible');
    for (const [col, value] of [['club_rankings', 1], ['ranking_group', 'senior'], ['gender', 'female'], ['name', 'Otro nombre'], ['season', '2027/28'], ['deleted_at', NOW]] as const) {
      db.run(`UPDATE teams SET ${col} = ? WHERE id = 'tb'`, value);
      bumped(`equipo: ${col}`);
    }
    db.run("UPDATE players SET person_id = NULL WHERE person_id = 'ana'");
    v = rankingsVersion(db);
    link('a-g1', 'bea');
    v = rankingsVersion(db);
    db.run("DELETE FROM people WHERE id = 'bea'");
    bumped('borrado físico de una persona vinculada');
    // Lo que no cambia el cálculo no invalida.
    db.run("UPDATE clubs SET rankings_visibility = 'members' WHERE id = 'A'");
    db.run("UPDATE teams SET category = 'Senior' WHERE id = 'ta'");
    db.run("UPDATE players SET ranking_excluded = 0 WHERE id = 'a-p69'");
    expect(rankingsVersion(db)).toBe(v);
    expect(rankingsVersion(db, 'B')).toBe(0);
  });
});

describe('migración 0007: compatibilidad con la sincronización', () => {
  const TEAM = 'ta';
  let db: SqliteD1;
  let coach: AuthContext;
  let seq = 0;
  const p7: Player = { id: 'local-p7', teamId: TEAM, name: 'Jugador Siete', number: 7, position: 'field', active: true, createdAt: NOW, updatedAt: NOW };
  const op = (player: Player, baseVersion: number | null = null): PlayerOp => ({ opId: `op-${++seq}`, teamId: TEAM, baseVersion, player });

  beforeEach(async () => {
    db = migratedDb();
    addClub(db, 'A');
    addTeam(db, TEAM, 'A', 'SMA2627');
    coach = (await addDevice(db, 'iphone', [{ clubId: 'A', teamId: TEAM, role: 'coach' }])).auth;
    db.run("INSERT INTO people (id, club_id, display_name, created_at, updated_at) VALUES ('ana', 'A', 'Ana', ?, ?)", NOW, NOW);
  });

  it('alta, repetición y cambios de una ficha vinculada: mismos resultados, el vínculo se conserva y no invalida', async () => {
    expect(await applyPlayerOp(db, coach, op(p7))).toEqual({ status: 'applied', entityId: 'local-p7', version: 1 });
    expect(one(db, "SELECT person_id FROM players WHERE id = 'local-p7'")).toEqual({ person_id: null });
    db.run("UPDATE players SET person_id = 'ana' WHERE id = 'local-p7'");
    const log = () => db.sqlite.prepare('SELECT entity, entity_id, version FROM change_log ORDER BY seq').all();
    const logAfterLink = log();
    const v = rankingsVersion(db);
    // El vínculo no cambia la versión de la ficha ni el registro de cambios.
    expect(one(db, "SELECT version FROM players WHERE id = 'local-p7'")).toEqual({ version: 1 });
    expect(logAfterLink).toHaveLength(1);
    // Repetir el alta: duplicado, como siempre.
    expect(await applyPlayerOp(db, coach, op(p7))).toEqual({ status: 'duplicate', entityId: 'local-p7', version: 1 });
    // Cambiar nombre y dorsal desde el dispositivo: aplicado, vínculo intacto, sin invalidar.
    expect(await applyPlayerOp(db, coach, op({ ...p7, name: 'Jugador 7', number: 17 }, 1))).toMatchObject({ status: 'applied', version: 2 });
    expect(one(db, "SELECT person_id, ranking_excluded, version FROM players WHERE id = 'local-p7'")).toEqual({ person_id: 'ana', ranking_excluded: 0, version: 2 });
    expect(rankingsVersion(db)).toBe(v);
    expect(log()).toHaveLength(2);
    // La descarga no muestra nada de la identidad.
    const snap = await teamSnapshot(db, coach, TEAM);
    expect(JSON.stringify(snap)).not.toMatch(/person|ranking|ana/i);
  });
});
