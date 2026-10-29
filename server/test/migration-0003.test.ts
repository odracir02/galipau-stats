// Migración 0003: estado de los clubes y copia cifrada de los códigos. Aditiva.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addClub, NOW } from './seed';
import { migratedDb, migrationFiles, SqliteD1 } from './sqliteD1';

describe('migración 0003', () => {
  it('está en orden tras 0001 y 0002 y solo añade columnas', () => {
    expect(migrationFiles().slice(0, 3)).toEqual(['0001_initial.sql', '0002_cloudflare_access.sql', '0003_clubs_status_and_codes.sql']);
    const sql = readFileSync(new URL('../migrations/0003_clubs_status_and_codes.sql', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE)\b/i);
    expect(sql.match(/ALTER TABLE \w+ ADD COLUMN/g)).toHaveLength(2);
  });

  it('los clubes existentes quedan activos y el estado solo admite active o suspended', () => {
    // Base de datos con datos anteriores a 0003.
    const db = new SqliteD1();
    for (const f of migrationFiles().slice(0, 2)) db.sqlite.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
    addClub(db, 'A');
    db.sqlite.exec(readFileSync(new URL('../migrations/0003_clubs_status_and_codes.sql', import.meta.url), 'utf8'));
    expect(db.sqlite.prepare("SELECT status FROM clubs WHERE id = 'A'").get()).toEqual({ status: 'active' });
    expect(() => db.run("UPDATE clubs SET status = 'borrado' WHERE id = 'A'")).toThrow(/CHECK/);
    expect(() => db.run("UPDATE clubs SET status = NULL WHERE id = 'A'")).toThrow(/NOT NULL/);
    db.run("UPDATE clubs SET status = 'suspended' WHERE id = 'A'");
  });

  it('las invitaciones tienen copia cifrada opcional', () => {
    const db = migratedDb();
    const cols = db.sqlite.prepare('PRAGMA table_info(invites)').all().map((c) => c.name);
    expect(cols).toContain('code_enc');
    expect(cols).toContain('code_hash');
    addClub(db, 'A');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM clubs WHERE created_at = ?').get(NOW)).toEqual({ n: 1 });
  });
});
