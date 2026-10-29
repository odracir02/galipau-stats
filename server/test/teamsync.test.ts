// Subida de jugadores y partidos y descarga del equipo completo (teamsync.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import type { Match, MatchEvent, Player, SquadEntry } from '../../src/domain/types';
import { computeSeasonStats } from '../../src/stats/engine';
import { activeReductions } from '../../src/stats/exclusions';
import { ev, goal, makeMatch } from '../../src/test/fixtures';
import { HttpError } from '../src/errors';
import { inviteStatements } from '../src/invites';
import type { AuthContext } from '../src/model';
import { applyEventOp, type EventOp } from '../src/sync';
import { applyMatchOp, applyPlayerOp, teamSnapshot, type MatchOp, type PlayerOp } from '../src/teamsync';
import { addClub, addDevice, addTeam, NOW, secrets } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

let db: SqliteD1;
let coach: AuthContext;
let otherCoach: AuthContext;
let viewer: AuthContext;
let seq = 0;
const TEAM = 'up';

/** Plantilla tal como la tendría el iPhone (ids propios del dispositivo). */
const roster: Player[] = [
  { n: 7, pos: 'field' },
  { n: 9, pos: 'field' },
  { n: 14, pos: 'field' },
  { n: 1, pos: 'goalkeeper' },
].map(({ n, pos }) => ({
  id: `local-p${n}`,
  teamId: TEAM,
  name: `Jugador ${n}`,
  number: n,
  position: pos as Player['position'],
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
}));
const squad: SquadEntry[] = roster.map((p) => ({ playerId: p.id, name: p.name, number: p.number, position: p.position }));

/** Partido finalizado con el fin real de la 1.ª parte en el cronómetro. */
const localMatch = (overrides: Partial<Match> = {}): Match =>
  makeMatch({
    id: 'local-m1',
    teamId: TEAM,
    opponent: 'BM Rival',
    status: 'finished',
    squad,
    clock: { period: 2, running: false, baseMs: 3_620_000, anchorWallMs: null, firstHalfEndMs: 1_820_000 },
    scoreAdjustment: { own: 1, opponent: 0 },
    finishedAt: NOW,
    ...overrides,
  });

const pOp = (player: Player, baseVersion: number | null = null): PlayerOp => ({ opId: `op-${++seq}`, teamId: TEAM, baseVersion, player });
const mOp = (match: Match, baseVersion: number | null = null): MatchOp => ({ opId: `op-${++seq}`, teamId: TEAM, baseVersion, match });
const eOp = (event: MatchEvent, baseVersion: number | null = null): EventOp => ({ opId: `op-${++seq}`, teamId: TEAM, baseVersion, event });

async function errorOf(p: Promise<unknown>): Promise<{ status: number; code: string; details?: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, code: e.code, details: e.details };
    throw e;
  }
  throw new Error('Se esperaba un error');
}

const count = (table: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/**
 * Acciones del partido, incluidas las especiales que deben conservar su
 * significado. Siempre las mismas (mismos identificadores), como en el iPhone.
 */
let cachedEvents: MatchEvent[] | null = null;
const localEvents = (): MatchEvent[] => (cachedEvents ??= buildEvents());
function buildEvents(): MatchEvent[] {
  const at = (minute: number, seconds = 0) => minute * 60_000 + seconds * 1000;
  const e = (payload: Parameters<typeof ev>[0], player: string | null, ms: number, period: 1 | 2 = 1) => ({
    ...ev(payload, player, 1, { matchId: 'local-m1', period }),
    matchTimeMs: ms,
  });
  return [
    // Partido histórico registrado sin reloj: acciones a 00:00.
    e(goal(), 'local-p7', 0),
    e(goal('six_m'), 'local-p9', 0),
    e({ kind: 'gk_shot', shotType: 'nine_m', result: 'save' }, 'local-p1', 0),
    e({ kind: 'gk_shot', shotType: 'six_m', result: 'goal' }, 'local-p1', at(10)),
    // Golpe franco de equipo, sin jugador.
    e({ kind: 'free_throw' }, null, at(12)),
    // Exclusión y roja adicional antes de reanudar (4 min).
    e({ kind: 'exclusion' }, 'local-p14', at(29, 30)),
    { ...e({ kind: 'red' }, 'local-p14', at(29, 30)), addsToPrevious: true },
    // Acción pendiente de atribuir y otra borrada.
    e({ kind: 'recovery' }, null, at(40), 2),
    { ...e(goal(), 'local-p7', at(41), 2), deletedAt: NOW },
  ];
}

async function uploadAll(auth = coach): Promise<void> {
  for (const p of roster) await applyPlayerOp(db, auth, pOp(p));
  await applyMatchOp(db, auth, mOp(localMatch()));
  for (const e of localEvents()) await applyEventOp(db, auth, eOp(e));
}

beforeEach(async () => {
  db = migratedDb();
  addClub(db, 'A');
  addClub(db, 'B');
  addTeam(db, TEAM, 'A', 'SMA2627');
  addTeam(db, 'b1', 'B', 'SMA2627');
  coach = (await addDevice(db, 'iphone', [{ clubId: 'A', teamId: TEAM, role: 'coach' }])).auth;
  otherCoach = (await addDevice(db, 'otro', [{ clubId: 'A', teamId: TEAM, role: 'coach' }])).auth;
  viewer = (await addDevice(db, 'familia', [{ clubId: 'A', teamId: TEAM, role: 'viewer' }])).auth;
});

describe('jugadores', () => {
  it('alta con versión 1; repetir la misma operación o los mismos datos no duplica', async () => {
    const op = pOp(roster[0]!);
    expect(await applyPlayerOp(db, coach, op)).toEqual({ status: 'applied', entityId: 'local-p7', version: 1 });
    expect(await applyPlayerOp(db, coach, op)).toEqual({ status: 'applied', entityId: 'local-p7', version: 1 });
    expect(await applyPlayerOp(db, coach, pOp(roster[0]!))).toEqual({ status: 'duplicate', entityId: 'local-p7', version: 1 });
    expect(count('players')).toBe(1);
    expect(count("change_log WHERE entity = 'player'")).toBe(1);
  });

  it('edición sobre la versión actual; sobre una antigua, conflicto con la copia del servidor y sin cambios', async () => {
    await applyPlayerOp(db, coach, pOp(roster[0]!));
    const renamed = { ...roster[0]!, name: 'Nombre nuevo', updatedAt: NOW };
    expect(await applyPlayerOp(db, coach, pOp(renamed, 1))).toMatchObject({ status: 'applied', version: 2 });
    const err = await errorOf(applyPlayerOp(db, otherCoach, pOp({ ...roster[0]!, name: 'Otro nombre' }, 1)));
    expect(err).toMatchObject({ status: 409, code: 'conflict' });
    expect(err.details).toMatchObject({ server: { entity: 'player', version: 2, player: { name: 'Nombre nuevo' } } });
    expect(db.sqlite.prepare('SELECT name, version FROM players').get()).toEqual({ name: 'Nombre nuevo', version: 2 });
    // Alta repetida con otros datos: conflicto, nunca sobrescritura.
    expect(await errorOf(applyPlayerOp(db, coach, pOp({ ...roster[0]!, number: 70 })))).toMatchObject({ status: 409, code: 'conflict' });
  });

  it('consulta no puede escribir (403); otro equipo no existe (404)', async () => {
    expect(await errorOf(applyPlayerOp(db, viewer, pOp(roster[0]!)))).toMatchObject({ status: 403 });
    expect(await errorOf(applyPlayerOp(db, coach, { ...pOp(roster[0]!), teamId: 'b1' }))).toMatchObject({ status: 404 });
    expect(count('players')).toBe(0);
  });

  it('valida los datos y el equipo declarado; dorsal activo repetido: 409 claro', async () => {
    expect(await errorOf(applyPlayerOp(db, coach, pOp({ ...roster[0]!, teamId: 'b1' })))).toMatchObject({ status: 422 });
    expect(await errorOf(applyPlayerOp(db, coach, pOp({ ...roster[0]!, number: 120 })))).toMatchObject({ status: 422 });
    await applyPlayerOp(db, coach, pOp(roster[0]!));
    const dup = { ...roster[1]!, id: 'local-otro', number: 7 };
    expect(await errorOf(applyPlayerOp(db, coach, pOp(dup)))).toMatchObject({ status: 409, code: 'number_taken' });
    expect(count('players')).toBe(1);
  });
});

describe('partidos y convocatoria', () => {
  beforeEach(async () => {
    for (const p of roster) await applyPlayerOp(db, coach, pOp(p));
  });

  it('alta con su convocatoria; quien lo sube queda como registrador; repetir no duplica', async () => {
    const op = mOp(localMatch());
    expect(await applyMatchOp(db, coach, op)).toEqual({ status: 'applied', entityId: 'local-m1', version: 1 });
    expect(await applyMatchOp(db, coach, op)).toMatchObject({ status: 'applied', version: 1 });
    expect(await applyMatchOp(db, coach, mOp(localMatch()))).toMatchObject({ status: 'duplicate', version: 1 });
    expect(count('matches')).toBe(1);
    expect(count('match_squad')).toBe(4);
    expect(db.sqlite.prepare('SELECT recorder_device_id FROM matches').get()).toEqual({ recorder_device_id: 'iphone' });
  });

  it('el cronómetro conserva firstHalfEndMs y la corrección de marcador', async () => {
    await applyMatchOp(db, coach, mOp(localMatch()));
    const row = db.sqlite.prepare('SELECT clock_json, score_adj_own FROM matches').get() as { clock_json: string; score_adj_own: number };
    expect(JSON.parse(row.clock_json)).toEqual({ period: 2, running: false, baseMs: 3_620_000, anchorWallMs: null, firstHalfEndMs: 1_820_000 });
    expect(row.score_adj_own).toBe(1);
    // Campos desconocidos del cronómetro no se guardan.
    const extra = localMatch({ id: 'local-m2', clock: { ...localMatch().clock, ajeno: 'x' } as Match['clock'] });
    await applyMatchOp(db, coach, mOp(extra));
    const row2 = db.sqlite.prepare("SELECT clock_json FROM matches WHERE id = 'local-m2'").get() as { clock_json: string };
    expect(JSON.parse(row2.clock_json)).not.toHaveProperty('ajeno');
  });

  it('otro dispositivo no puede modificar el partido (409) y nada cambia', async () => {
    await applyMatchOp(db, coach, mOp(localMatch()));
    const err = await errorOf(applyMatchOp(db, otherCoach, mOp(localMatch({ opponent: 'Cambiado' }), 1)));
    expect(err).toMatchObject({ status: 409, code: 'match_recorded_elsewhere' });
    expect(db.sqlite.prepare('SELECT opponent, version FROM matches').get()).toEqual({ opponent: 'BM Rival', version: 1 });
    // Tampoco sus acciones.
    expect(await errorOf(applyEventOp(db, otherCoach, eOp(localEvents()[0]!)))).toMatchObject({ code: 'match_recorded_elsewhere' });
  });

  it('edición del registrador sobre su versión; versión antigua: conflicto con su copia', async () => {
    await applyMatchOp(db, coach, mOp(localMatch()));
    const edited = localMatch({ scoreAdjustment: { own: 0, opponent: 0 }, updatedAt: '2026-10-27T11:00:00.000Z' });
    expect(await applyMatchOp(db, coach, mOp(edited, 1))).toMatchObject({ status: 'applied', version: 2 });
    const err = await errorOf(applyMatchOp(db, coach, mOp(localMatch({ opponent: 'Viejo' }), 1)));
    expect(err).toMatchObject({ status: 409, code: 'conflict' });
    expect(err.details).toMatchObject({ server: { entity: 'match', version: 2, match: { opponent: 'BM Rival' } } });
  });

  it('la convocatoria se sustituye entera en una edición y el borrado lógico se sincroniza', async () => {
    await applyMatchOp(db, coach, mOp(localMatch()));
    const shorter = localMatch({ squad: squad.slice(0, 2) });
    await applyMatchOp(db, coach, mOp(shorter, 1));
    expect(count('match_squad')).toBe(2);
    await applyMatchOp(db, coach, mOp({ ...shorter, deletedAt: NOW }, 2));
    expect(db.sqlite.prepare('SELECT deleted_at, version FROM matches').get()).toEqual({ deleted_at: NOW, version: 3 });
  });

  it('si otro dispositivo escribe entre la lectura y la transacción, no se marca como aplicada ni toca la convocatoria', async () => {
    await applyMatchOp(db, coach, mOp(localMatch()));
    const racing = {
      prepare: (q: string) => db.prepare(q),
      batch: async (stmts: Parameters<typeof db.batch>[0]) => {
        db.run("UPDATE matches SET opponent = 'Ajeno', version = 2, updated_by_device_id = 'otro'");
        return db.batch(stmts);
      },
    };
    const op = mOp(localMatch({ squad: squad.slice(0, 1), opponent: 'Mío' }), 1);
    expect(await errorOf(applyMatchOp(racing, coach, op))).toMatchObject({ status: 409, code: 'conflict' });
    expect(db.sqlite.prepare('SELECT opponent, version FROM matches').get()).toEqual({ opponent: 'Ajeno', version: 2 });
    expect(count('match_squad')).toBe(4);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_ops WHERE op_id = ?').get(op.opId)).toEqual({ n: 0 });
  });

  it('convocados que no están en el servidor: 422 claro; consulta: 403', async () => {
    const unknown = localMatch({ squad: [...squad, { playerId: 'no-subido', name: 'X', number: 99, position: 'field' }] });
    expect(await errorOf(applyMatchOp(db, coach, mOp(unknown)))).toMatchObject({ status: 422, code: 'unknown_player' });
    expect(await errorOf(applyMatchOp(db, viewer, mOp(localMatch())))).toMatchObject({ status: 403 });
    expect(await errorOf(applyMatchOp(db, coach, mOp(localMatch({ halfMinutes: 0 }))))).toMatchObject({ status: 422 });
    expect(count('matches')).toBe(0);
  });
});

describe('acciones con datos nuevos', () => {
  beforeEach(async () => {
    for (const p of roster) await applyPlayerOp(db, coach, pOp(p));
    await applyMatchOp(db, coach, mOp(localMatch()));
  });

  it('la sanción adicional (addsToPrevious) se guarda y vuelve igual; no se descarta en silencio', async () => {
    const [exclusion, red] = localEvents().slice(5, 7) as [MatchEvent, MatchEvent];
    await applyEventOp(db, coach, eOp(exclusion));
    await applyEventOp(db, coach, eOp(red));
    expect(db.sqlite.prepare('SELECT adds_to_previous FROM events WHERE id = ?').get(red.id)).toEqual({ adds_to_previous: 1 });
    const snap = await teamSnapshot(db, viewer, TEAM);
    expect(snap.events.find((x) => x.event.id === red.id)!.event).toEqual(red);
    expect(snap.events.find((x) => x.event.id === exclusion.id)!.event).not.toHaveProperty('addsToPrevious');
    // Cambiar solo la marca es un cambio de contenido: conflicto si no se indica versión.
    expect(await errorOf(applyEventOp(db, coach, eOp({ ...red, addsToPrevious: undefined } as MatchEvent)))).toMatchObject({ status: 409 });
    const plain = { ...red } as MatchEvent;
    delete plain.addsToPrevious;
    expect(await applyEventOp(db, coach, eOp(plain, 1))).toMatchObject({ status: 'applied', version: 2 });
    expect(db.sqlite.prepare('SELECT adds_to_previous FROM events WHERE id = ?').get(red.id)).toEqual({ adds_to_previous: 0 });
  });

  it('la marca solo vale en exclusiones o rojas de un jugador', async () => {
    const bad = { ...ev({ kind: 'yellow' }, 'local-p7', 5, { matchId: 'local-m1' }), addsToPrevious: true } as MatchEvent;
    expect(await errorOf(applyEventOp(db, coach, eOp(bad)))).toMatchObject({ status: 422 });
    const noPlayer = { ...ev({ kind: 'exclusion' }, null, 5, { matchId: 'local-m1' }), addsToPrevious: true } as MatchEvent;
    expect(await errorOf(applyEventOp(db, coach, eOp(noPlayer)))).toMatchObject({ status: 422 });
    expect(count('events')).toBe(0);
  });

  it('golpes francos sin jugador y acciones a 00:00 se guardan tal cual', async () => {
    for (const e of localEvents()) await applyEventOp(db, coach, eOp(e));
    expect(db.sqlite.prepare("SELECT player_id FROM events WHERE kind = 'free_throw'").get()).toEqual({ player_id: null });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE match_time_ms = 0').get()).toEqual({ n: 3 });
  });
});

describe('descarga del equipo completo', () => {
  it('permite reconstruir exactamente las mismas estadísticas', async () => {
    await uploadAll();
    const snap = await teamSnapshot(db, viewer, TEAM);
    expect(snap.players.map((p) => p.player)).toEqual([...roster].sort((a, b) => a.number - b.number));
    expect(snap.matches).toHaveLength(1);
    expect(snap.matches[0]!.match).toEqual(localMatch());
    expect(snap.events).toHaveLength(localEvents().length);
    const local = computeSeasonStats([{ match: localMatch(), events: localEvents() }]);
    const remote = computeSeasonStats(
      snap.matches.filter((m) => m.match.deletedAt === null).map(({ match }) => ({ match, events: snap.events.map((e) => e.event).filter((e) => e.matchId === match.id) })),
    );
    expect(remote).toEqual(local);
    expect(remote.team.freeThrows).toBe(1);
    expect(remote.goalsFor).toBe(3); // 2 goles + corrección de 1; el borrado no cuenta
  });

  it('los datos nuevos conservan su significado: 4 minutos y fin real de la 1.ª parte', async () => {
    await uploadAll();
    const snap = await teamSnapshot(db, viewer, TEAM);
    const match = { ...snap.matches[0]!.match, status: 'in_progress' as const, clock: { ...snap.matches[0]!.match.clock, baseMs: 1_800_000 + 60_000 } };
    // Sanción a 29:30, 1.ª parte terminada en 30:20 (50 s cumplidos) y 1:00 de la 2.ª: quedan 4:00 − 1:50 = 2:10.
    const reductions = activeReductions(match, snap.events.map((e) => e.event), 0);
    expect(reductions.map((r) => [r.kind, r.durationMs, r.remainingMs])).toEqual([['red', 240_000, 130_000]]);
  });

  it('consulta y entrenador pueden descargar; sin permiso o de otro club: 404', async () => {
    await uploadAll();
    expect((await teamSnapshot(db, coach, TEAM)).matches[0]!.recordedHere).toBe(true);
    expect((await teamSnapshot(db, viewer, TEAM)).matches[0]!.recordedHere).toBe(false);
    const outsider = (await addDevice(db, 'fuera', [{ clubId: 'B', teamId: 'b1', role: 'coach' }])).auth;
    expect(await errorOf(teamSnapshot(db, outsider, TEAM))).toMatchObject({ status: 404 });
  });

  it('no incluye códigos de invitación, tokens ni identificadores de otros dispositivos', async () => {
    const { statements, invite } = await inviteStatements(
      db,
      { clubId: 'A', teamId: TEAM, role: 'viewer', expiresAt: '2027-08-01T00:00:00.000Z', createdByDeviceId: null },
      await secrets(),
      new Date(NOW),
    );
    await db.batch(statements);
    await uploadAll();
    const text = JSON.stringify(await teamSnapshot(db, viewer, TEAM));
    expect(text).not.toContain(invite.code);
    expect(text).not.toMatch(/code_hash|code_enc|token|recorder_device_id|updated_by_device_id|iphone/);
  });

  it('incluye el cursor para seguir con la descarga de cambios', async () => {
    await uploadAll();
    const snap = await teamSnapshot(db, viewer, TEAM);
    expect(snap.seq).toBe(count('change_log'));
    expect(snap.club).toEqual({ id: 'A', name: 'Club A' });
  });
});

describe('subida completa del iPhone', () => {
  it('repetir toda la subida (otros opId) no duplica nada', async () => {
    await uploadAll();
    const before = ['players', 'matches', 'match_squad', 'events', 'change_log'].map(count);
    await uploadAll();
    expect(['players', 'matches', 'match_squad', 'events', 'change_log'].map(count)).toEqual(before);
  });

  it('las tablas existentes siguen aceptando los datos de antes (sin columnas nuevas informadas)', () => {
    db.run(
      `INSERT INTO players (id, team_id, name, number, position, created_at, updated_at) VALUES ('antiguo', ?, 'Antiguo', 33, 'field', ?, ?)`,
      TEAM,
      NOW,
      NOW,
    );
    expect(db.sqlite.prepare("SELECT version, updated_by_device_id FROM players WHERE id = 'antiguo'").get()).toEqual({
      version: 1,
      updated_by_device_id: null,
    });
  });
});
