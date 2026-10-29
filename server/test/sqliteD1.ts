// Base de datos de pruebas: la interfaz de D1 (server/src/db.ts) sobre el SQLite
// integrado en Node (node:sqlite). D1 es SQLite, así que las migraciones, las
// restricciones y las consultas se comprueban con el mismo motor, en memoria.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Db, SqlValue, Statement } from '../src/db';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

/** Archivos de migración en el orden en que los aplica Wrangler (por número). */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

class SqliteStatement implements Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    readonly sql: string,
    readonly values: SqlValue[] = [],
  ) {}

  bind(...values: SqlValue[]): Statement {
    return new SqliteStatement(this.sqlite, this.sql, values);
  }

  private stmt() {
    return this.sqlite.prepare(this.sql);
  }

  async first<T>(): Promise<T | null> {
    return ((this.stmt().get(...(this.values as SQLInputValue[])) as T | undefined) ?? null);
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.stmt().all(...(this.values as SQLInputValue[])) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const r = this.stmt().run(...(this.values as SQLInputValue[]));
    return { meta: { changes: Number(r.changes) } };
  }

  /** Ejecución síncrona para batch(), con la forma de resultado de D1. */
  exec(): { results: unknown[]; meta: { changes: number } } {
    const stmt = this.stmt();
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)) {
      return { results: stmt.all(...(this.values as SQLInputValue[])), meta: { changes: 0 } };
    }
    const r = stmt.run(...(this.values as SQLInputValue[]));
    return { results: [], meta: { changes: Number(r.changes) } };
  }
}

export class SqliteD1 implements Db {
  readonly sqlite: DatabaseSync;

  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    // D1 aplica las claves foráneas siempre.
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }

  prepare(query: string): Statement {
    return new SqliteStatement(this.sqlite, query);
  }

  /** Como en D1: todas las sentencias en una transacción; si una falla, ninguna queda. */
  async batch(statements: Statement[]): Promise<{ results?: unknown[]; meta: { changes: number } }[]> {
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => (s as SqliteStatement).exec());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }

  /** Aplica todas las migraciones, cada una en su transacción, y las registra. */
  migrate(): string[] {
    const applied = migrationFiles();
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)');
    for (const file of applied) {
      const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
      this.sqlite.exec('BEGIN');
      try {
        this.sqlite.exec(sql);
        this.sqlite.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
        this.sqlite.exec('COMMIT');
      } catch (e) {
        this.sqlite.exec('ROLLBACK');
        throw new Error(`Migración ${file}: ${String(e)}`, { cause: e });
      }
    }
    return applied;
  }

  /** Ejecución directa para preparar datos en las pruebas. */
  run(sql: string, ...values: SqlValue[]): void {
    this.sqlite.prepare(sql).run(...(values as SQLInputValue[]));
  }
}

export function migratedDb(): SqliteD1 {
  const db = new SqliteD1();
  db.migrate();
  return db;
}
