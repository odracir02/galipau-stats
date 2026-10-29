// Subconjunto de la API de D1 que usa el servidor. El binding real de D1 lo
// cumple tal cual; en las pruebas lo implementa un adaptador sobre SQLite local
// (server/test/sqliteD1.ts). Así el código no depende de tipos externos.

export type SqlValue = string | number | null;

export interface Statement {
  bind(...values: SqlValue[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface Db {
  prepare(query: string): Statement;
  /**
   * Ejecuta varias sentencias en una sola transacción: o todas o ninguna. Las
   * consultas devuelven sus filas en `results` (lectura coherente de varias tablas).
   */
  batch(statements: Statement[]): Promise<{ results?: unknown[]; meta: { changes: number } }[]>;
}
