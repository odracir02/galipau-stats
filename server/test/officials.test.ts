// Cuerpo técnico (role: 'official', migración 0006) en el servidor y protección
// frente a versiones de la PWA que no lo conocen. Por HTTP contra el Worker en
// memoria; datos y códigos sintéticos.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Match, Player } from '../../src/domain/types';
import { ev, goal, makeMatch } from '../../src/test/fixtures';
import { NO_FEATURES } from '../src/compat';
import worker, { type Env } from '../src/index';
import { applyEventOp, type EventOp } from '../src/sync';
import { applyMatchOp, applyPlayerOp, type PlayerOp } from '../src/teamsync';
import { addClub, addDevice, addTeam, CODE_KEY, NOW, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const APP = 'https://develop.galipau-stats.pages.dev';
const T = 'equipo-a';
const T2 = 'equipo-b';
let db: SqliteD1;
let env: Env;
let coach: string;
let viewer: string;
let both: string;
let n = 0;

beforeEach(async () => {
  db = migratedDb();
  addClub(db, 'C');
  addTeam(db, T, 'C', 'SMA2627');
  addTeam(db, T2, 'C', 'SFA2627');
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: APP };
  coach = (await addDevice(db, 'entrenador', [{ clubId: 'C', teamId: T, role: 'coach' }])).token;
  viewer = (await addDevice(db, 'familia', [{ clubId: 'C', teamId: T, role: 'viewer' }])).token;
  both = (await addDevice(db, 'ambos', [
    { clubId: 'C', teamId: T, role: 'coach' },
    { clubId: 'C', teamId: T2, role: 'coach' },
  ])).token;
});

/** Petición como la PWA: `nueva` declara que conoce el cuerpo técnico. */
async function call(path: string, { token = coach, body, nueva = false }: { token?: string; body?: unknown; nueva?: boolean } = {}) {
  const headers = new Headers({ Authorization: `Bearer ${token}`, Origin: APP });
  if (nueva) headers.set('X-GalipauStats-Features', 'officials');
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await worker.fetch(
    new Request(`https://api.example${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

const player = (id: string, number: number, extra: Omit<Partial<Player>, 'role'> & { role?: string } = {}, teamId = T) => ({
  id,
  teamId,
  name: `Persona ${id}`,
  number,
  position: 'field' as const,
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});
const official = (id: string, extra: Partial<Player> = {}, teamId = T) => player(id, 0, { role: 'official', ...extra }, teamId);

const putPlayer = (p: object, opts: { baseVersion?: number | null; nueva?: boolean; token?: string; teamId?: string } = {}) =>
  call('/api/sync/players', {
    token: opts.token,
    nueva: opts.nueva,
    body: { opId: `op-${++n}`, teamId: opts.teamId ?? T, baseVersion: opts.baseVersion ?? null, player: p },
  });
const putMatch = (m: Match, opts: { baseVersion?: number | null; nueva?: boolean; token?: string } = {}) =>
  call('/api/sync/matches', { token: opts.token, nueva: opts.nueva, body: { opId: `op-${++n}`, teamId: m.teamId, baseVersion: opts.baseVersion ?? null, match: m } });
const putEvent = (e: object, opts: { baseVersion?: number | null; nueva?: boolean } = {}) =>
  call('/api/sync/events', { nueva: opts.nueva, body: { opId: `op-${++n}`, teamId: T, baseVersion: opts.baseVersion ?? null, event: e } });

/** Plantilla con dos jugadores (uno con el dorsal 0) y, si se pide, dos oficiales. */
async function roster({ officials = true } = {}) {
  expect((await putPlayer(player('p7', 7))).status).toBe(200);
  expect((await putPlayer(player('p0', 0))).status).toBe(200);
  if (officials) {
    expect((await putPlayer(official('o1'), { nueva: true })).status).toBe(200);
    expect((await putPlayer(official('o2'), { nueva: true })).status).toBe(200);
  }
}
const squadOf = (officials: boolean) => [
  { playerId: 'p7', name: 'Persona p7', number: 7, position: 'field' as const },
  { playerId: 'p0', name: 'Persona p0', number: 0, position: 'field' as const },
  ...(officials
    ? [
        { playerId: 'o1', name: 'Persona o1', number: 0, position: 'field' as const },
        { playerId: 'o2', name: 'Persona o2', number: 0, position: 'field' as const },
      ]
    : []),
];
const roleRow = (table: string, where: string) => db.sqlite.prepare(`SELECT role, number, position FROM ${table} WHERE ${where}`).get();

const OLD_CLIENT_ROUTES = (m: Match): [string, unknown?][] => [
  [`/api/teams/${T}/snapshot`],
  [`/api/teams/${T}/changes?since=0`],
  ['/api/sync/players', { opId: 'x1', teamId: T, baseVersion: null, player: player('p99', 99) }],
  ['/api/sync/matches', { opId: 'x2', teamId: T, baseVersion: null, match: { ...m, id: 'nuevo' } }],
  ['/api/sync/events', { opId: 'x3', teamId: T, baseVersion: null, event: ev(goal(), 'p7', 3, { matchId: m.id }) }],
  ['/api/sync/control', { opId: 'x4', teamId: T, matchId: m.id, expectedEpoch: 0 }],
];

describe('equipo sin oficiales: todo igual que antes', () => {
  it('con la versión antigua y con la nueva: mismas respuestas, sin rol en ningún dato', async () => {
    await roster({ officials: false });
    const m = makeMatch({ id: 'm1', teamId: T, status: 'finished', squad: squadOf(false) });
    expect((await putMatch(m)).status).toBe(200);
    expect((await putEvent(ev(goal(), 'p7', 3, { matchId: 'm1' }))).status).toBe(200);
    const old = await call(`/api/teams/${T}/snapshot`);
    const nueva = await call(`/api/teams/${T}/snapshot`, { nueva: true });
    expect(old.status).toBe(200);
    expect(nueva.body).toEqual(old.body);
    expect(JSON.stringify(old.body)).not.toContain('role');
    expect((await call(`/api/teams/${T}/changes?since=0`)).status).toBe(200);
    expect(db.sqlite.prepare("SELECT DISTINCT role FROM players UNION SELECT DISTINCT role FROM match_squad").all()).toEqual([{ role: 'player' }]);
  });

  it('el dorsal de los jugadores sigue siendo único entre los activos', async () => {
    await roster({ officials: false });
    expect((await putPlayer(player('p7b', 7))).body).toMatchObject({ error: 'number_taken' });
  });
});

describe('alta y edición de oficiales', () => {
  it('la versión nueva los da de alta con el dorsal técnico 0; no ocupan dorsal ni chocan entre sí', async () => {
    await roster();
    expect(roleRow('players', "id = 'o1'")).toEqual({ role: 'official', number: 0, position: 'field' });
    expect(roleRow('players', "id = 'p0'")).toEqual({ role: 'player', number: 0, position: 'field' });
    // Se descargan con su rol; los jugadores, sin él.
    const snap = (await call(`/api/teams/${T}/snapshot`, { nueva: true })).body as { players: { player: Record<string, unknown> }[] };
    const byId = Object.fromEntries(snap.players.map((p) => [p.player.id, p.player]));
    expect(byId.o1).toMatchObject({ role: 'official', number: 0 });
    expect(byId.p0).not.toHaveProperty('role');
    // Repetir la misma alta (reintento) no duplica.
    const again = await call('/api/sync/players', { nueva: true, body: { opId: 'repetida', teamId: T, baseVersion: null, player: official('o3') } });
    const retry = await call('/api/sync/players', { nueva: true, body: { opId: 'repetida', teamId: T, baseVersion: null, player: official('o3') } });
    expect(retry.body).toEqual(again.body);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM players WHERE id = 'o3'").get()).toEqual({ n: 1 });
  });

  it('un oficial no puede tener dorsal ni posición de portero; el rol no admite otros valores', async () => {
    expect((await putPlayer(official('o1', { number: 5 }), { nueva: true })).status).toBe(422);
    expect((await putPlayer(official('o1', { position: 'goalkeeper' }), { nueva: true })).status).toBe(422);
    expect((await putPlayer(player('x', 3, { role: 'admin' }), { nueva: true })).status).toBe(422);
    // Una versión que no los conoce no puede crearlos aunque mande el campo.
    expect((await putPlayer(official('o1'))).status).toBe(422);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM players').get()).toEqual({ n: 0 });
  });

  it('el rol no cambia nunca: ni jugador → oficial ni oficial → jugador', async () => {
    await roster();
    // Jugador que pide pasar a oficial.
    expect((await putPlayer(official('p0'), { baseVersion: 1, nueva: true })).status).toBe(422);
    // Oficial editado sin rol (en la versión nueva, eso es un jugador).
    expect((await putPlayer(player('o1', 0, { name: 'Otro' }), { baseVersion: 1, nueva: true })).status).toBe(422);
    // Editar el nombre de un oficial manteniendo el rol sí se puede; el rol se conserva.
    expect((await putPlayer(official('o1', { name: 'Segundo entrenador' }), { baseVersion: 1, nueva: true })).status).toBe(200);
    expect(db.sqlite.prepare("SELECT name, role, version FROM players WHERE id = 'o1'").get()).toEqual({ name: 'Segundo entrenador', role: 'official', version: 2 });
    // Eliminarlo (borrado lógico) desde la versión nueva.
    expect((await putPlayer(official('o1', { name: 'Segundo entrenador', active: false }), { baseVersion: 2, nueva: true })).status).toBe(200);
    expect(roleRow('players', "id = 'p0'")).toEqual({ role: 'player', number: 0, position: 'field' });
  });

  it('aunque una versión antigua llegara al servidor, no puede tocar un oficial (defensa propia de cada operación)', async () => {
    await roster();
    const { auth } = await addDevice(db, 'antiguo', [{ clubId: 'C', teamId: T, role: 'coach' }]);
    const edit: PlayerOp = { opId: 'v1', teamId: T, baseVersion: 1, player: { ...player('o1', 0), name: 'Cambiado', role: undefined } };
    await expect(applyPlayerOp(db, auth, edit, new Date(), NO_FEATURES)).rejects.toMatchObject({ status: 503, code: 'update_required' });
    expect(db.sqlite.prepare("SELECT name, role FROM players WHERE id = 'o1'").get()).toEqual({ name: 'Persona o1', role: 'official' });
  });
});

describe('convocatorias con oficiales', () => {
  it('el rol de cada convocado lo fija la plantilla del servidor, con el dorsal técnico 0', async () => {
    await roster();
    // El cliente manda el oficial con otro dorsal y un jugador marcado como oficial: el servidor no se fía.
    const squad = squadOf(true).map((s) => (s.playerId === 'o1' ? { ...s, number: 33 } : s.playerId === 'p7' ? { ...s, role: 'official' as const } : s));
    const m = makeMatch({ id: 'm1', teamId: T, status: 'ready', squad });
    expect((await putMatch(m, { nueva: true })).status).toBe(200);
    expect(db.sqlite.prepare("SELECT player_id, number, role FROM match_squad WHERE match_id = 'm1' ORDER BY sort_order").all()).toEqual([
      { player_id: 'p7', number: 7, role: 'player' },
      { player_id: 'p0', number: 0, role: 'player' },
      { player_id: 'o1', number: 0, role: 'official' },
      { player_id: 'o2', number: 0, role: 'official' },
    ]);
    const snap = (await call(`/api/teams/${T}/snapshot`, { nueva: true })).body as { matches: { match: Match }[] };
    expect(snap.matches[0]!.match.squad.map((s) => (s as { role?: string }).role ?? 'player')).toEqual(['player', 'player', 'official', 'official']);
  });

  it('el dorsal repetido entre jugadores se sigue rechazando; los oficiales no cuentan', async () => {
    await roster();
    const dup = makeMatch({ id: 'm2', teamId: T, squad: [...squadOf(true), { playerId: 'p7', name: 'x', number: 7, position: 'field' }] });
    expect((await putMatch(dup, { nueva: true })).status).toBe(422);
    await putPlayer(player('p8', 8), { nueva: true });
    const twoSeven = makeMatch({ id: 'm3', teamId: T, squad: [squadOf(false)[0]!, { playerId: 'p8', name: 'Persona p8', number: 7, position: 'field' }] });
    expect((await putMatch(twoSeven, { nueva: true })).body).toMatchObject({ error: 'invalid_data' });
  });

  it('una versión antigua no puede sustituir una convocatoria que tiene oficiales (defensa propia)', async () => {
    await roster();
    const m = makeMatch({ id: 'm1', teamId: T, status: 'finished', squad: squadOf(true) });
    expect((await putMatch(m, { nueva: true })).status).toBe(200);
    const { auth } = await addDevice(db, 'antiguo', [{ clubId: 'C', teamId: T, role: 'coach' }]);
    const without = { opId: 'v2', teamId: T, baseVersion: 1, match: { ...m, squad: squadOf(false) } };
    await expect(applyMatchOp(db, auth, without, new Date(), NO_FEATURES)).rejects.toMatchObject({ status: 503, code: 'update_required' });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM match_squad WHERE match_id = 'm1' AND role = 'official'").get()).toEqual({ n: 2 });
  });
});

describe('acciones de oficiales', () => {
  async function liveMatch() {
    await roster();
    const m = makeMatch({ id: 'm1', teamId: T, status: 'finished', squad: squadOf(true) });
    expect((await putMatch(m, { nueva: true })).status).toBe(200);
    return m;
  }

  it('solo amarilla, exclusión o roja; nunca goles, lanzamientos, paradas, pérdidas ni recuperaciones', async () => {
    await liveMatch();
    for (const payload of [goal(), { kind: 'shot', shotType: 'six_m', result: 'saved' }, { kind: 'gk_shot', shotType: 'nine_m', result: 'save' }, { kind: 'turnover', turnoverType: 'steps' }, { kind: 'recovery' }, { kind: 'penalty_committed' }] as const) {
      const r = await putEvent(ev(payload, 'o1', 10, { matchId: 'm1' }), { nueva: true });
      expect(r.status, payload.kind).toBe(422);
      expect(r.body).toMatchObject({ error: 'invalid_event' });
    }
    for (const kind of ['yellow', 'exclusion', 'red'] as const) {
      expect((await putEvent(ev({ kind }, 'o2', 20, { matchId: 'm1' }), { nueva: true })).status, kind).toBe(200);
    }
    // El mismo jugador con dorsal 0 sí puede marcar.
    expect((await putEvent(ev(goal(), 'p0', 21, { matchId: 'm1' }), { nueva: true })).status).toBe(200);
  });

  it('una exclusión de un oficial no se puede cambiar a gol; reasignar un gol a un oficial tampoco', async () => {
    await liveMatch();
    const excl = ev({ kind: 'exclusion' }, 'o1', 12, { matchId: 'm1' });
    expect((await putEvent(excl, { nueva: true })).status).toBe(200);
    expect((await putEvent({ ...excl, kind: 'shot', shotType: 'nine_m', result: 'goal' }, { baseVersion: 1, nueva: true })).status).toBe(422);
    const g = ev(goal(), 'p7', 13, { matchId: 'm1' });
    expect((await putEvent(g, { nueva: true })).status).toBe(200);
    expect((await putEvent({ ...g, playerId: 'o1' }, { baseVersion: 1, nueva: true })).status).toBe(422);
    expect(db.sqlite.prepare("SELECT kind, player_id FROM events WHERE id IN (?, ?) ORDER BY match_time_ms").all(excl.id, g.id)).toEqual([
      { kind: 'exclusion', player_id: 'o1' },
      { kind: 'shot', player_id: 'p7' },
    ]);
  });

  it('una versión antigua no puede cambiar la sanción de un oficial (defensa propia)', async () => {
    await liveMatch();
    const excl = ev({ kind: 'exclusion' }, 'o1', 12, { matchId: 'm1' });
    expect((await putEvent(excl, { nueva: true })).status).toBe(200);
    const { auth } = await addDevice(db, 'antiguo', [{ clubId: 'C', teamId: T, role: 'coach' }]);
    const op: EventOp = { opId: 'v3', teamId: T, baseVersion: 1, event: { ...excl, playerId: 'p7' } };
    await expect(applyEventOp(db, auth, op, new Date(), NO_FEATURES)).rejects.toMatchObject({ status: 503 });
  });
});

describe('versiones antiguas en un equipo con oficiales', () => {
  async function teamWithOfficials() {
    await roster();
    const m = makeMatch({ id: 'm1', teamId: T, status: 'in_progress', squad: squadOf(true) });
    expect((await putMatch(m, { nueva: true })).status).toBe(200);
    return m;
  }

  it('todas las lecturas y escrituras de datos del equipo: 503 update_required, sin cambiar nada', async () => {
    const m = await teamWithOfficials();
    const before = db.sqlite.prepare('SELECT (SELECT COUNT(*) FROM players) p, (SELECT COUNT(*) FROM matches) m, (SELECT COUNT(*) FROM events) e, (SELECT COUNT(*) FROM change_log) c, (SELECT COUNT(*) FROM sync_ops) o').get();
    for (const [path, body] of OLD_CLIENT_ROUTES(m)) {
      const r = await call(path, { body });
      expect(r.status, path).toBe(503);
      expect(r.body, path).toMatchObject({ error: 'update_required' });
      // Con CORS para la PWA: el navegador deja leer el motivo.
      expect(r.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    }
    expect(db.sqlite.prepare('SELECT (SELECT COUNT(*) FROM players) p, (SELECT COUNT(*) FROM matches) m, (SELECT COUNT(*) FROM events) e, (SELECT COUNT(*) FROM change_log) c, (SELECT COUNT(*) FROM sync_ops) o').get()).toEqual(before);
    // También la consulta (familias) con una versión antigua.
    expect((await call(`/api/teams/${T}/snapshot`, { token: viewer })).status).toBe(503);
    // La versión nueva sí.
    expect((await call(`/api/teams/${T}/snapshot`, { nueva: true })).status).toBe(200);
  });

  it('la sesión, la ficha del equipo y sus códigos siguen funcionando: se puede actualizar sin perder nada', async () => {
    await teamWithOfficials();
    const session = await call('/api/session');
    expect(session.status).toBe(200);
    expect(session.body.teams).toEqual([expect.objectContaining({ teamId: T, role: 'coach', status: 'active' })]);
    expect((await call(`/api/teams/${T}`)).status).toBe(200);
    expect((await call(`/api/teams/${T}/codes`)).status).not.toBe(503);
  });

  it('el bloqueo no revela nada a quien no tiene acceso y no sustituye a los permisos', async () => {
    await teamWithOfficials();
    const ajeno = (await addDevice(db, 'ajeno', [{ clubId: 'C', teamId: T2, role: 'coach' }])).token;
    expect((await call(`/api/teams/${T}/snapshot`, { token: ajeno })).status).toBe(404);
    expect((await call(`/api/teams/${T}/snapshot`, { token: ajeno, nueva: true })).status).toBe(404);
    // La cabecera no da permiso de escritura a la consulta.
    expect((await putPlayer(player('p50', 50), { token: viewer, nueva: true })).status).toBe(403);
    // Permiso retirado: 404, nunca 503 (con o sin la cabecera).
    db.run("UPDATE grants SET revoked_at = ? WHERE device_id = 'entrenador'", NOW);
    expect((await call(`/api/teams/${T}/snapshot`)).status).toBe(404);
    expect((await call(`/api/teams/${T}/snapshot`, { nueva: true })).status).toBe(404);
  });

  it('dos equipos independientes: el que no tiene oficiales sigue funcionando con la versión antigua', async () => {
    await teamWithOfficials();
    expect((await call(`/api/teams/${T}/snapshot`, { token: both })).status).toBe(503);
    expect((await putPlayer(player('q9', 9, {}, T2), { token: both, teamId: T2 })).status).toBe(200);
    expect((await call(`/api/teams/${T2}/snapshot`, { token: both })).status).toBe(200);
  });

  it('un oficial eliminado mantiene el bloqueo (sus datos siguen en la descarga)', async () => {
    await teamWithOfficials();
    for (const id of ['o1', 'o2']) {
      expect((await putPlayer({ ...official(id), active: false }, { baseVersion: 1, nueva: true })).status).toBe(200);
    }
    expect((await call(`/api/teams/${T}/snapshot`)).status).toBe(503);
  });
});

describe('CORS', () => {
  it('la consulta previa admite la cabecera de capacidades, solo para la PWA', async () => {
    const pre = await worker.fetch(new Request('https://api.example/api/sync/players', { method: 'OPTIONS', headers: { Origin: APP } }), env);
    expect(pre.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type, X-GalipauStats-Features');
    const other = await worker.fetch(new Request('https://api.example/api/sync/players', { method: 'OPTIONS', headers: { Origin: 'https://otra.example' } }), env);
    expect(other.headers.get('Access-Control-Allow-Headers')).toBeNull();
  });
});
