// Base representativa hasta la migración 0007, con datos sintéticos que reproducen la
// estructura y el volumen del club real: cuatro equipos de la temporada con plantilla
// (uno con 23 jugadores, 3 partidos finalizados y 273 acciones con correcciones,
// borrados y sanciones, más partidos en curso y en el descanso), códigos de
// entrenador y de consulta, dispositivos activos y revocados, personas vinculadas
// entre equipos, rankings del club calculados y un superadministrador. Nunca contiene
// datos reales.
import { readFileSync } from 'node:fs';
import { deviceClubRankings } from '../src/clubRankings';
import { inviteStatements } from '../src/invites';
import { addAdmin, addDevice, addRoster, addTeam, NOW, secrets } from './seed';
import type { SqliteD1 } from './sqliteD1';
import { before0005 } from './syntheticTeam';

const read = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');
const MIGRATIONS_BEFORE_0008 = ['0005_match_control.sql', '0006_team_officials.sql', '0007_club_rankings.sql'];

export async function representativeBefore0008(): Promise<SqliteD1> {
  const db = await before0005();
  for (const f of MIGRATIONS_BEFORE_0008) db.sqlite.exec(read(f));
  // Registro de migraciones como lo deja Wrangler, para poder aplicar 0008 con su mecanismo.
  db.sqlite.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)');
  for (const f of ['0001_initial.sql', '0002_cloudflare_access.sql', '0003_clubs_status_and_codes.sql', '0004_team_sync.sql', ...MIGRATIONS_BEFORE_0008]) {
    db.run('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)', f, NOW);
  }

  // Cuatro equipos de la temporada (el sintético «T» hace de SMA2627) con su plantilla.
  for (const [id, code] of [
    ['SFA', 'SFA2627'],
    ['SFB', 'SFB2627'],
    ['SMB', 'SMB2627'],
  ] as const) {
    addTeam(db, id, 'C', code);
    addRoster(db, id, `${id}-`);
  }
  // Códigos de entrenador y consulta de cada equipo (con su copia cifrada).
  const s = await secrets();
  for (const teamId of ['T', 'SFA', 'SFB', 'SMB']) {
    for (const role of ['coach', 'viewer'] as const) {
      const { statements } = await inviteStatements(db, { clubId: 'C', teamId, role, expiresAt: '2027-08-01T00:00:00.000Z', createdByDeviceId: null }, s, new Date(NOW));
      await db.batch(statements);
    }
  }
  const viewer = await addDevice(db, 'tablet', [
    { clubId: 'C', teamId: 'SFB', role: 'viewer' },
    { clubId: 'C', teamId: 'T', role: 'viewer' },
  ]);
  await addAdmin(db, 'super', [{ role: 'superadmin', clubId: null }]);
  // Personas vinculadas: la misma persona con ficha en dos equipos, y otra excluida.
  db.run("INSERT INTO people (id, club_id, display_name, created_at, updated_at) VALUES ('per1', 'C', 'Persona sintética 1', ?, ?)", NOW, NOW);
  db.run("INSERT INTO people (id, club_id, display_name, created_at, updated_at) VALUES ('per2', 'C', 'Persona sintética 2', ?, ?)", NOW, NOW);
  db.run("UPDATE players SET person_id = 'per1' WHERE id IN ('p7', 'SFA-p7')");
  db.run("UPDATE players SET person_id = 'per2', ranking_excluded = 1 WHERE id = 'SFB-p9'");
  db.run("INSERT INTO auth_attempts (bucket, window_start, count) VALUES ('hash-sintetico', 1, 2)");
  // Rankings del club calculados y guardados en caché, como tras consultarlos.
  await deviceClubRankings(db, viewer.auth, 'C', { season: '2026/27', group: 'Todo el club' }, ['p7']);
  return db;
}

/** Tablas existentes antes de 0008 con su número de filas (para los informes). */
export function tableCounts(db: SqliteD1): Record<string, number> {
  const names = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return Object.fromEntries(names.map((t) => [t, (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));
}
