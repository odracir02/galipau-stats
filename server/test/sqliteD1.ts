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

/**
 * Valores como los acepta D1: los booleanos se guardan como 1/0; undefined no se
 * admite (D1 también lo rechaza).
 */
function d1Values(values: unknown[]): SQLInputValue[] {
  return values.map((v) => {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined no es un valor válido');
    return v as SQLInputValue;
  });
}

type D1Meta = { changes: number; last_row_id: number };

class SqliteStatement implements Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    readonly sql: string,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: SqlValue[]): Statement {
    return new SqliteStatement(this.sqlite, this.sql, values);
  }

  private stmt() {
    return this.sqlite.prepare(this.sql);
  }

  async first<T>(): Promise<T | null> {
    return ((this.stmt().get(...d1Values(this.values)) as T | undefined) ?? null);
  }

  /** Como en D1: all() también ejecuta escrituras y devuelve sus metadatos. */
  async all<T>(): Promise<{ results: T[]; meta: D1Meta }> {
    const r = this.exec();
    return { results: r.results as T[], meta: r.meta };
  }

  async run(): Promise<{ meta: D1Meta }> {
    const r = this.stmt().run(...d1Values(this.values));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  /** Ejecución síncrona para batch() y all(), con la forma de resultado de D1. */
  exec(): { results: unknown[]; meta: D1Meta } {
    const stmt = this.stmt();
    // Devuelve filas toda sentencia con columnas de resultado (SELECT, PRAGMA, RETURNING).
    if (stmt.columns().length > 0) {
      const rows = stmt.all(...d1Values(this.values));
      const reads = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(this.sql);
      return { results: rows, meta: { changes: reads ? 0 : rows.length, last_row_id: 0 } };
    }
    const r = stmt.run(...d1Values(this.values));
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
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

  /** Como en D1: SQL sin parámetros, con varias sentencias. */
  async exec(query: string): Promise<{ count: number; duration: number }> {
    this.sqlite.exec(query);
    return { count: query.split(';').filter((q) => q.trim()).length, duration: 0 };
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

  /**
   * Aplica las migraciones pendientes, cada una en su transacción, y las
   * registra. Con `until`, solo hasta esa (para probar una migración sobre
   * datos de las anteriores).
   */
  migrate(until?: string): string[] {
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)');
    const done = new Set((this.sqlite.prepare('SELECT name FROM d1_migrations').all() as { name: string }[]).map((r) => r.name));
    const applied = migrationFiles().filter((f) => !done.has(f) && (until === undefined || f <= until));
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
