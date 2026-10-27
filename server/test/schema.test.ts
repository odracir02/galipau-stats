import { beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, migrationFiles, type SqliteD1 } from './sqliteD1';
import { addClub, addDevice, addMatch, addRoster, addTeam, NOW, twoClubs } from './seed';

let db: SqliteD1;
beforeEach(() => {
  db = migratedDb();
});

const tables = (d: SqliteD1) =>
  d.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

const count = (table: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('migraciones', () => {
  it('se aplican en orden sobre una base de datos vacía y quedan registradas', () => {
    const files = migrationFiles();
    expect(files[0]).toBe('0001_initial.sql');
    // Numeración única y consecutiva.
    expect(files.map((f) => Number(f.slice(0, 4)))).toEqual(files.map((_, i) => i + 1));
    expect(tables(db)).toEqual([
      'admin_audit',
      'admin_credentials',
      'admin_enrollments',
      'admin_identities',
      'admin_roles',
      'admin_sessions',
      'auth_attempts',
      'change_log',
      'clubs',
      'd1_migrations',
      'device_tokens',
      'devices',
      'events',
      'grants',
      'invites',
      'match_squad',
      'matches',
      'people',
      'players',
      'sync_ops',
      'teams',
    ]);
    expect(count('d1_migrations')).toBe(files.length);
  });

  it('el esquema no tiene errores de claves foráneas', () => {
    twoClubs(db);
    addMatch(db, 'a1', {}, 'a1-');
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });
});

describe('clubes y equipos', () => {
  it('un equipo pertenece a un club existente', () => {
    expect(() => addTeam(db, 't1', 'NO-EXISTE')).toThrow(/FOREIGN KEY/);
  });

  it('el código corto es único dentro del club, no entre clubes', () => {
    addClub(db, 'A');
    addClub(db, 'B');
    addTeam(db, 'a1', 'A', 'SM2627');
    expect(() => addTeam(db, 'a2', 'A', 'SM2627')).toThrow(/UNIQUE/);
    expect(() => addTeam(db, 'b1', 'B', 'SM2627')).not.toThrow();
  });

  it('los identificadores son únicos', () => {
    addClub(db, 'A');
    expect(() => addClub(db, 'A')).toThrow(/UNIQUE|PRIMARY/);
    addTeam(db, 't1', 'A', 'AAA');
    expect(() => addTeam(db, 't1', 'A', 'BBB')).toThrow(/UNIQUE|PRIMARY/);
  });

  it('valida código, modalidad y nombre', () => {
    addClub(db, 'A');
    const team = (code: string, gender: string | null, name = 'Equipo') => () =>
      db.run(
        'INSERT INTO teams (id, club_id, name, code, season, gender, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        `t-${code}-${gender}`,
        'A',
        name,
        code,
        '2026/27',
        gender,
        NOW,
        NOW,
      );
    expect(team('sm2627', null)).toThrow(/CHECK/);
    expect(team('SM 27', null)).toThrow(/CHECK/);
    expect(team('AB', null)).toThrow(/CHECK/);
    expect(team('SM2627', 'otro')).toThrow(/CHECK/);
    expect(team('SM2627', 'female', '  ')).toThrow(/CHECK/);
    expect(team('SF2627', 'female')).not.toThrow();
    expect(team('MX2627', null)).not.toThrow();
  });

  it('eliminar un club elimina en cascada sus equipos, plantillas, partidos, acciones y permisos', async () => {
    twoClubs(db);
    addMatch(db, 'a1', {}, 'a1-');
    db.run(
      "INSERT INTO events (id, match_id, team_id, player_id, kind, period, match_time_ms, created_at, updated_at) VALUES ('e1', 'm1', 'a1', 'a1-p7', 'recovery', 1, 0, ?, ?)",
      NOW,
      NOW,
    );
    await addDevice(db, 'd1', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    db.run("DELETE FROM clubs WHERE id = 'A'");
    expect(count('teams')).toBe(1);
    expect(count('players')).toBe(5);
    expect(count('matches')).toBe(0);
    expect(count('events')).toBe(0);
    expect(count('grants')).toBe(0);
    // El dispositivo sigue existiendo (puede tener permisos en otros clubes).
    expect(count('devices')).toBe(1);
  });
});

describe('plantillas y personas', () => {
  beforeEach(() => twoClubs(db));

  it('dorsal único entre jugadores activos del equipo', () => {
    const add = (id: string, team: string, number: number, active = 1) => () =>
      db.run(
        "INSERT INTO players (id, team_id, name, number, position, active, created_at, updated_at) VALUES (?, ?, 'X', ?, 'field', ?, ?, ?)",
        id,
        team,
        number,
        active,
        NOW,
        NOW,
      );
    expect(add('n1', 'a1', 7)).toThrow(/UNIQUE/);
    expect(add('n2', 'a1', 7, 0)).not.toThrow();
    expect(add('n3', 'a2', 7)).toThrow(/UNIQUE/); // a2 ya tiene el 7 de la plantilla de prueba
    expect(add('n4', 'a1', 100)).toThrow(/CHECK/);
  });

  it('una persona puede jugar en dos equipos de su club, pero no en otro club', () => {
    db.run("INSERT INTO people (id, club_id, display_name, created_at, updated_at) VALUES ('per1', 'A', 'Jugadora', ?, ?)", NOW, NOW);
    db.run("UPDATE players SET person_id = 'per1' WHERE id IN ('a1-p7', 'a2-p7')");
    expect(() => db.run("UPDATE players SET person_id = 'per1' WHERE id = 'b1-p7'")).toThrow(/person_other_club/);
  });
});

describe('integridad entre equipos', () => {
  beforeEach(() => twoClubs(db));

  it('una convocatoria solo admite jugadores del equipo del partido', () => {
    addMatch(db, 'a1', {}, 'a1-');
    expect(() =>
      db.run(
        "INSERT INTO match_squad (match_id, player_id, team_id, name, number, position) VALUES ('m1', 'b1-p14', 'a1', 'X', 99, 'field')",
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it('una acción solo puede atribuirse a un jugador del equipo del partido', () => {
    addMatch(db, 'a1', {}, 'a1-');
    const ev = (id: string, team: string, player: string | null) => () =>
      db.run(
        "INSERT INTO events (id, match_id, team_id, player_id, kind, period, match_time_ms, created_at, updated_at) VALUES (?, 'm1', ?, ?, 'recovery', 1, 0, ?, ?)",
        id,
        team,
        player,
        NOW,
        NOW,
      );
    expect(ev('e1', 'a1', 'b1-p7')).toThrow(/FOREIGN KEY/);
    expect(ev('e2', 'b1', 'b1-p7')).toThrow(/FOREIGN KEY/); // el partido no es de b1
    expect(ev('e3', 'a1', null)).not.toThrow(); // pendiente de atribuir
    expect(ev('e4', 'a1', 'a1-p7')).not.toThrow();
  });

  it('cada tipo de acción lleva exactamente sus campos', () => {
    addMatch(db, 'a1', {}, 'a1-');
    const ev = (id: string, kind: string, shot: string | null, result: string | null, turnover: string | null) => () =>
      db.run(
        "INSERT INTO events (id, match_id, team_id, kind, shot_type, result, turnover_type, period, match_time_ms, created_at, updated_at) VALUES (?, 'm1', 'a1', ?, ?, ?, ?, 1, 0, ?, ?)",
        id,
        kind,
        shot,
        result,
        turnover,
        NOW,
        NOW,
      );
    expect(ev('ok1', 'shot', 'nine_m', 'goal', null)).not.toThrow();
    expect(ev('ok2', 'gk_shot', 'wing', 'save', null)).not.toThrow();
    expect(ev('ok3', 'turnover', null, null, 'steps')).not.toThrow();
    expect(ev('ok4', 'free_throw', null, null, null)).not.toThrow(); // categoría histórica
    expect(ev('bad1', 'shot', 'wing', 'goal', null)).toThrow(/CHECK/); // extremo solo existe en portería
    expect(ev('bad2', 'gk_shot', 'nine_m', 'saved', null)).toThrow(/CHECK/);
    expect(ev('bad3', 'recovery', 'nine_m', null, null)).toThrow(/CHECK/);
    expect(ev('bad4', 'turnover', null, null, null)).toThrow(/CHECK/);
    expect(ev('bad5', 'assist', null, null, null)).toThrow(/CHECK/);
  });

  it('un permiso de equipo debe indicar el club real del equipo', async () => {
    await expect(addDevice(db, 'd1', [{ clubId: 'B', teamId: 'a1', role: 'coach' }])).rejects.toThrow(/FOREIGN KEY/);
  });

  it('un permiso de dispositivo es siempre de un equipo y solo de entrenador o consulta', async () => {
    await expect(addDevice(db, 'd1', [{ clubId: 'A', teamId: null, role: 'coach' }])).rejects.toThrow(/NOT NULL/);
    await expect(addDevice(db, 'd2', [{ clubId: 'A', teamId: 'a1', role: 'admin' }])).rejects.toThrow(/CHECK/);
  });

  it('un dispositivo tiene como máximo un permiso vigente por equipo, y puede tener varios equipos', async () => {
    await expect(
      addDevice(db, 'd1', [
        { clubId: 'A', teamId: 'a1', role: 'viewer' },
        { clubId: 'A', teamId: 'a1', role: 'coach' },
      ]),
    ).rejects.toThrow(/UNIQUE/);
    await expect(
      addDevice(db, 'd2', [
        { clubId: 'A', teamId: 'a1', role: 'viewer' },
        { clubId: 'A', teamId: 'a2', role: 'coach' },
        { clubId: 'B', teamId: 'b1', role: 'viewer' },
      ]),
    ).resolves.toBeTruthy();
  });

  it('mover un equipo a otro club arrastra sus permisos e invitaciones', async () => {
    await addDevice(db, 'd1', [{ clubId: 'A', teamId: 'a2', role: 'coach' }]);
    // a1 no podría: B ya tiene un equipo SM2627.
    expect(() => db.run('UPDATE teams SET club_id = ? WHERE id = ?', 'B', 'a1')).toThrow(/UNIQUE/);
    db.run('UPDATE teams SET club_id = ? WHERE id = ?', 'B', 'a2');
    expect(db.sqlite.prepare("SELECT club_id FROM grants WHERE device_id = 'd1'").get()).toEqual({ club_id: 'B' });
  });
});

it('el registro de cambios nunca reutiliza números', () => {
  addClub(db, 'A');
  addTeam(db, 'a1', 'A');
  addRoster(db, 'a1');
  const log = () => db.run("INSERT INTO change_log (team_id, entity, entity_id, version, changed_at) VALUES ('a1', 'event', 'x', 1, ?)", NOW);
  log();
  log();
  db.run('DELETE FROM change_log WHERE seq = 2');
  log();
  expect(db.sqlite.prepare('SELECT seq FROM change_log ORDER BY seq').all().map((r) => r.seq)).toEqual([1, 3]);
});
