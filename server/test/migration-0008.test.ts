// Migración 0008: cuentas de club. Exclusivamente aditiva: sobre una copia local con
// datos sintéticos como los reales (cuatro equipos del club, plantillas, partidos,
// acciones, códigos, permisos, personas y rankings), ninguna fila existente cambia.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { representativeBefore0008, tableCounts } from './representativeDb';
import { migrationFiles, type SqliteD1 } from './sqliteD1';

const FILE = '0008_accounts.sql';
const read = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');

const NEW_TABLES = [
  'account_audit',
  'account_state',
  'auth_account',
  'auth_rate_limit',
  'auth_session',
  'auth_user',
  'auth_verification',
  'club_invitations',
  'club_memberships',
  'club_owner_transfers',
  'club_owners',
];

const tables = (db: SqliteD1) =>
  (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
const schemaOf = (db: SqliteD1) =>
  db.sqlite.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as { type: string; name: string; sql: string | null }[];
const dumpAll = (db: SqliteD1, names: string[]) => Object.fromEntries(names.map((t) => [t, db.sqlite.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));

/** Base hasta 0007 con un club como el real (ver representativeDb.ts). */
const before0008 = representativeBefore0008;

describe('migración 0008', () => {
  it('es la siguiente y, fuera de los triggers, solo crea tablas e índices', () => {
    expect(migrationFiles().at(-1)).toBe(FILE);
    const sql = read(FILE)
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    const outsideTriggers = sql.replace(/CREATE TRIGGER[\s\S]*?\nEND;/g, '');
    expect(outsideTriggers).not.toMatch(/\b(DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+"?\w+"?\s+SET|DROP|RENAME|ALTER)\b/i);
    const created = [...outsideTriggers.matchAll(/create table "?(\w+)"?/gi)].map((m) => m[1]).sort();
    expect(created).toEqual(NEW_TABLES);
    // Los triggers solo actúan sobre las tablas nuevas.
    const triggerTargets = [...sql.matchAll(/CREATE TRIGGER \w+ [^\n]*? ON (\w+)/g)].map((m) => m[1]);
    expect(triggerTargets).toHaveLength(16);
    for (const t of triggerTargets) expect(NEW_TABLES).toContain(t);
    // Y dentro de su cuerpo solo escriben en las tablas nuevas.
    const bodies = [...sql.matchAll(/\nBEGIN\n([\s\S]*?)\nEND;/g)].map((m) => m[1]).join('\n');
    const writes = [...bodies.matchAll(/(?:UPDATE|INSERT INTO|DELETE FROM)\s+(\w+)/g)].map((m) => m[1]);
    expect(writes.length).toBeGreaterThan(0);
    for (const t of writes) expect(NEW_TABLES).toContain(t);
  });

  it('no cambia ninguna fila ni ningún objeto existente', async () => {
    const db = await before0008();
    const oldTables = tables(db);
    const oldSchema = schemaOf(db);
    const before = dumpAll(db, oldTables);
    expect(before.teams).toHaveLength(5);
    // La base es representativa: todas las tablas de datos tienen filas.
    const counts = tableCounts(db);
    for (const t of ['clubs', 'teams', 'players', 'matches', 'match_squad', 'events', 'invites', 'devices', 'device_tokens', 'grants', 'people', 'club_rankings_cache', 'admin_identities', 'admin_roles', 'change_log']) {
      expect(counts[t], t).toBeGreaterThan(0);
    }
    expect((before.events as unknown[]).length).toBeGreaterThan(200);

    db.sqlite.exec(read(FILE));

    expect(dumpAll(db, oldTables)).toEqual(before);
    const newSchema = schemaOf(db);
    for (const obj of oldSchema) expect(newSchema).toContainEqual(obj);
    expect(tables(db).filter((t) => !oldTables.includes(t))).toEqual(NEW_TABLES);
    for (const t of NEW_TABLES) expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get()).toEqual({ n: 0 });
  });

  it('los clubes existentes quedan sin propietario y siguen funcionando igual', async () => {
    const db = await before0008();
    db.sqlite.exec(read(FILE));
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM club_owners').get()).toEqual({ n: 0 });
    // Escrituras normales sobre los datos existentes siguen siendo posibles.
    db.run("UPDATE players SET name = 'Cambio sintético' WHERE id = 'SFA-p7'");
    db.run("UPDATE clubs SET name = 'Club sintético 2' WHERE id = 'C'");
    db.run("DELETE FROM device_tokens WHERE device_id = 'tablet'");
    expect(db.sqlite.prepare("SELECT name FROM clubs WHERE id = 'C'").get()).toEqual({ name: 'Club sintético 2' });
  });

  it('se aplica igual con el mecanismo de migraciones (una vez)', async () => {
    const { migratedDb } = await import('./sqliteD1');
    const db = migratedDb();
    expect(db.migrate()).toEqual([]);
    expect(tables(db)).toEqual(expect.arrayContaining(NEW_TABLES));
  });
});
