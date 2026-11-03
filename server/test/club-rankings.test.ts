// Rankings del club en el servidor: mismo motor que los rankings de equipo,
// agregando por persona (nunca por nombre), con caché por huella y permisos en
// cada petición. Los datos entran por la sincronización real. Datos sintéticos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventPayload, Match, Player, Position, SquadEntry } from '../../src/domain/types';
import { ev, makeMatch } from '../../src/test/fixtures';
import { buildBootstrapSql } from '../scripts/bootstrap-superadmin.mjs';
import { clearJwksCache } from '../src/access';
import { CLUB_RANKINGS, deviceClubRankings, type ClubRankingsResponse } from '../src/clubRankings';
import worker, { type Env } from '../src/index';
import type { AuthContext } from '../src/model';
import { applyEventOp } from '../src/sync';
import { applyMatchOp, applyPlayerOp, teamSnapshot } from '../src/teamsync';
import { ACCESS_ENV, claimsFor, CONFIG, makeIssuer, serveJwks, type Issuer } from './accessKeys';
import { addClub, addDevice, addTeam, NOW, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

let db: SqliteD1;
let env: Env;
let issuer: Issuer;
let recorder: AuthContext;
let seq = 0;
const OWNER = 'propietario@example.com';
const ADMIN_A = 'admina@example.com';
const SENIOR_M = { season: '2026/27', gender: 'male', group: 'senior' } as const;

// --- Datos ---------------------------------------------------------------------------

type Roster = Record<string, [name: string, number: number, position?: Position]>;
const rosters = new Map<string, Roster>();

function team(id: string, code: string, { club = 'A', season = '2026/27', gender = 'male', group = 'senior' as string | null, participates = true } = {}) {
  addTeam(db, id, club, code);
  db.run('UPDATE teams SET season = ?, gender = ?, ranking_group = ?, club_rankings = ? WHERE id = ?', season, gender, group, participates ? 1 : 0, id);
}

async function roster(teamId: string, players: Roster) {
  rosters.set(teamId, { ...(rosters.get(teamId) ?? {}), ...players });
  for (const [id, [name, number, position = 'field']] of Object.entries(players)) {
    const p: Player = { id, teamId, name, number, position, active: true, createdAt: NOW, updatedAt: NOW };
    await applyPlayerOp(db, recorder, { opId: `op-${++seq}`, teamId, baseVersion: null, player: p });
  }
}

/** Partido finalizado de un equipo con sus acciones: [jugador, acción, veces]. */
async function match(teamId: string, id: string, actions: [string, EventPayload, number?][], { season = '2026/27', squadOf }: { season?: string; squadOf?: string[] } = {}) {
  const r = rosters.get(teamId)!;
  const ids = squadOf ?? Object.keys(r);
  const squad: SquadEntry[] = ids.map((pid) => ({ playerId: pid, name: r[pid]![0], number: r[pid]![1], position: r[pid]![2] ?? 'field' }));
  const m: Match = makeMatch({ id, teamId, season, status: 'finished', squad, finishedAt: NOW });
  await applyMatchOp(db, recorder, { opId: `op-${++seq}`, teamId, baseVersion: null, match: m });
  for (const [pid, payload, times = 1] of actions) {
    for (let i = 0; i < times; i++) await applyEventOp(db, recorder, { opId: `op-${++seq}`, teamId, baseVersion: null, event: ev(payload, pid, 1, { matchId: id }) });
  }
}

const GOAL: EventPayload = { kind: 'shot', shotType: 'nine_m', result: 'goal' };
const MISS: EventPayload = { kind: 'shot', shotType: 'nine_m', result: 'out' };
const SAVE: EventPayload = { kind: 'gk_shot', shotType: 'nine_m', result: 'save' };
const CONCEDED: EventPayload = { kind: 'gk_shot', shotType: 'nine_m', result: 'goal' };
const RECOVERY: EventPayload = { kind: 'recovery' };

function person(id: string, name: string, club = 'A') {
  db.run('INSERT INTO people (id, club_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, club, name, NOW, NOW);
}
const link = (player: string, p: string | null) => db.run('UPDATE players SET person_id = ? WHERE id = ?', p, player);

// --- Consulta --------------------------------------------------------------------------

async function call(path: string, { token, email, method = 'GET' }: { token?: string; email?: string; method?: string } = {}) {
  const h = new Headers({ 'Sec-Fetch-Site': 'same-origin', Origin: 'https://api.example' });
  if (token) h.set('Authorization', `Bearer ${token}`);
  if (email) h.set('Cf-Access-Jwt-Assertion', await issuer.sign(claimsFor(email, { aud: CONFIG.adminAud })));
  const res = await worker.fetch(new Request(`https://api.example${path}`, { method, headers: h }), env);
  return { status: res.status, body: (await res.json()) as ClubRankingsResponse & Record<string, unknown>, headers: res.headers };
}
const q = (g: { season: string; gender: string; group: string } = SENIOR_M, extra = '') =>
  `?season=${encodeURIComponent(g.season)}&gender=${g.gender}&group=${encodeURIComponent(g.group)}${extra}`;
const ranking = (r: ClubRankingsResponse, id: string) => r.rankings.find((x) => x.id === id)!;
const names = (r: ClubRankingsResponse, id: string) => ranking(r, id).entries.map((e) => `${e.position}:${e.name}`);

let coachToken: string;
let coachAuth: AuthContext;

beforeEach(async () => {
  db = migratedDb();
  rosters.clear();
  addClub(db, 'A');
  addClub(db, 'B');
  team('sma', 'SMA2627');
  team('smb', 'SMB2627');
  team('sfa', 'SFA2627', { gender: 'female' });
  team('jm', 'JM2627', { group: 'juvenil' });
  team('old', 'SMA2526', { season: '2025/26' });
  team('np', 'SMC2627', { participates: false });
  team('xb', 'XB2627', { club: 'B' });
  db.run("UPDATE clubs SET rankings_visibility = 'coaches' WHERE id = 'A'");
  const all = ['sma', 'smb', 'sfa', 'jm', 'old', 'np'].map((teamId) => ({ clubId: 'A', teamId, role: 'coach' as const }));
  recorder = (await addDevice(db, 'registrador', [...all, { clubId: 'B', teamId: 'xb', role: 'coach' }])).auth;
  const coach = await addDevice(db, 'entrenador-sma', [{ clubId: 'A', teamId: 'sma', role: 'coach' }]);
  coachToken = coach.token;
  coachAuth = coach.auth;
  db.sqlite.exec(buildBootstrapSql({ identityId: 'owner', email: OWNER }));
  db.run("INSERT INTO admin_identities (id, display_name, email, created_at) VALUES ('adminA', 'adminA', ?, ?)", ADMIN_A, NOW);
  db.run("INSERT INTO admin_roles (id, identity_id, role, club_id, created_at) VALUES ('adminA-r', 'adminA', 'club_admin', 'A', ?)", NOW);
  issuer = await makeIssuer();
  serveJwks(() => [issuer.jwk]);
  env = { DB: db, TOKEN_PEPPER: PEPPER, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://develop.galipau-stats.pages.dev', ...ACCESS_ENV };

  await roster('sma', { a7: ['Siete A', 7], a10: ['Ana García', 10], a11: ['Juan Pérez', 11], a1: ['Portero A', 1, 'goalkeeper'] });
  await roster('smb', { b9: ['Nueve B', 9], b10: ['Ana G.', 10], b11: ['Juan Pérez', 11] });
  await match('sma', 'ma1', [['a7', GOAL, 3], ['a10', GOAL, 3], ['a10', MISS, 3], ['a11', GOAL, 1], ['a1', SAVE, 15], ['a1', CONCEDED, 5]]);
  await match('smb', 'mb1', [['b9', GOAL, 2], ['b10', GOAL, 1], ['b10', MISS, 5], ['b11', GOAL, 1], ['b9', RECOVERY, 2]]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearJwksCache();
});

describe('cálculo', () => {
  it('fichas independientes y una persona vinculada a dos equipos: suma una vez, con sus dos equipos', async () => {
    person('ana', 'Ana García López');
    link('a10', 'ana');
    link('b10', 'ana');
    const r = await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, []);
    // Ana: 3 + 1 = 4 goles (una sola fila); Siete A: 3; Nueve B: 2; los dos Juan Pérez, por separado.
    expect(names(r, 'top_scorer')).toEqual(['1:Ana García López', '2:Siete A', '3:Nueve B', '4:Juan Pérez', '4:Juan Pérez']);
    const ana = ranking(r, 'top_scorer').entries[0]!;
    expect(ana).toMatchObject({ value: 4, matches: 2, teams: ['SMA2627', 'SMB2627'] });
    // Sin vínculo, cada ficha suma sola.
    link('a10', null);
    link('b10', null);
    const sep = await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, []);
    // Empates: mismo puesto, ordenados por dorsal como en los rankings de equipo.
    expect(names(sep, 'top_scorer')).toEqual(['1:Siete A', '1:Ana García', '3:Nueve B', '4:Ana G.', '4:Juan Pérez', '4:Juan Pérez']);
  });

  it('dos personas con el mismo nombre nunca se juntan', async () => {
    const r = await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, []);
    const juanes = ranking(r, 'top_scorer').entries.filter((e) => e.name === 'Juan Pérez');
    expect(juanes.map((e) => e.teams)).toEqual([['SMA2627'], ['SMB2627']]);
  });

  it('porcentajes sobre los totales y mínimos sobre los totales de la persona', async () => {
    // Por separado, ninguna ficha de Ana llega a 10 lanzamientos (6 y 6): fuera del francotirador.
    let r = await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, []);
    expect(ranking(r, 'sharpshooter').entries).toEqual([]);
    person('ana', 'Ana');
    link('a10', 'ana');
    link('b10', 'ana');
    r = await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, []);
    // Juntas: 4 goles de 12 lanzamientos = 33,3 % (no la media de 50 % y 16,7 %).
    expect(ranking(r, 'sharpshooter').entries).toEqual([expect.objectContaining({ name: 'Ana', value: 33.3, made: 4, of: 12 })]);
    // El muro: 15 paradas de 20 tiros a puerta (mínimo 20) = 75 %.
    expect(ranking(r, 'wall').entries).toEqual([expect.objectContaining({ name: 'Portero A', value: 75, made: 15, of: 20 })]);
    expect(ranking(r, 'thief').entries).toEqual([expect.objectContaining({ name: 'Nueve B', value: 2 })]);
    expect(ranking(r, 'shots').entries[0]).toMatchObject({ name: 'Ana', value: 12 });
  });

  it('Top 10 con empates: puestos compartidos, los que no caben se cuentan; solo clasificaciones positivas', async () => {
    const many: Roster = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c${i}`, [`Jugador ${i}`, 20 + i]]));
    await roster('smb', many);
    await match('smb', 'mb2', Object.keys(many).map((pid) => [pid, GOAL, 1] as [string, EventPayload, number]), { squadOf: Object.keys(many) });
    const r = await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, []);
    const top = ranking(r, 'top_scorer');
    expect(top.entries).toHaveLength(10);
    // 3 (Siete A, Ana García) · 2 (Nueve B) · 1: catorce jugadores empatados en el 4.º.
    expect(top.entries.map((e) => e.position)).toEqual([1, 1, 3, 4, 4, 4, 4, 4, 4, 4]);
    expect(top.ranked).toBe(18);
    expect(top.hiddenTies).toBe(8);
    expect(r.rankings.map((x) => x.id)).toEqual(CLUB_RANKINGS);
    expect(r.rankings.map((x) => x.id)).not.toContain('repeat_offender');
    expect(r.rankings.map((x) => x.id)).not.toContain('generous');
  });

  it('fichas y personas excluidas, y cuerpo técnico: fuera, y los demás suben', async () => {
    db.run("UPDATE players SET ranking_excluded = 1 WHERE id = 'a7'");
    person('ana', 'Ana');
    link('a10', 'ana');
    db.run("UPDATE people SET ranking_excluded = 1 WHERE id = 'ana'");
    const r = await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, ['a7', 'a10', 'a11']);
    expect(names(r, 'top_scorer')).toEqual(['1:Nueve B', '2:Ana G.', '2:Juan Pérez', '2:Juan Pérez']);
    expect(r.mine).toEqual(
      expect.arrayContaining([
        { playerId: 'a7', excluded: true, rankings: [] },
        { playerId: 'a10', excluded: true, rankings: [] },
        expect.objectContaining({ playerId: 'a11', rankings: expect.arrayContaining([expect.objectContaining({ id: 'top_scorer', position: 2, ranked: 4 })]) }),
      ]),
    );
    // Un oficial convocado y sancionado no aparece en ninguna clasificación.
    const officials = { officials: true };
    await applyPlayerOp(db, recorder, { opId: `op-${++seq}`, teamId: 'sma', baseVersion: null, player: { id: 'aof', teamId: 'sma', name: 'Entrenador', number: 0, position: 'field', active: true, role: 'official', createdAt: NOW, updatedAt: NOW } }, new Date(), officials);
    const squad: SquadEntry[] = [{ playerId: 'a11', name: 'Juan Pérez', number: 11, position: 'field' }, { playerId: 'aof', name: 'Entrenador', number: 0, position: 'field', role: 'official' }];
    await applyMatchOp(db, recorder, { opId: `op-${++seq}`, teamId: 'sma', baseVersion: null, match: makeMatch({ id: 'ma-of', teamId: 'sma', status: 'finished', squad, finishedAt: NOW }) }, new Date(), officials);
    await applyEventOp(db, recorder, { opId: `op-${++seq}`, teamId: 'sma', baseVersion: null, event: ev({ kind: 'yellow' }, 'aof', 1, { matchId: 'ma-of' }) }, new Date(), officials);
    await applyEventOp(db, recorder, { opId: `op-${++seq}`, teamId: 'sma', baseVersion: null, event: ev(RECOVERY, 'a11', 2, { matchId: 'ma-of' }) }, new Date(), officials);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE player_id = 'aof'").get()).toEqual({ n: 1 });
    const after = await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, []);
    expect(JSON.stringify(after)).not.toContain('Entrenador');
    expect(ranking(after, 'thief').entries.map((e) => e.name)).toEqual(['Nueve B', 'Juan Pérez']);
  });

  it('separación estricta por temporada, género y grupo; equipos que no participan, fuera', async () => {
    await roster('sfa', { f1: ['Femenina', 5] });
    await roster('jm', { j1: ['Juvenil', 5] });
    await roster('old', { o1: ['Antigua', 5] });
    await roster('np', { n1: ['No participa', 5] });
    for (const [t, p] of [['sfa', 'f1'], ['jm', 'j1'], ['old', 'o1'], ['np', 'n1']] as const) await match(t, `m-${t}`, [[p, GOAL, 9]], { season: t === 'old' ? '2025/26' : '2026/27' });
    const senior = JSON.stringify(await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, []));
    for (const n of ['Femenina', 'Juvenil', 'Antigua', 'No participa']) expect(senior).not.toContain(n);
    expect((await deviceClubRankings(db, recorder, 'A', { season: '2026/27', gender: 'female', group: 'senior' }, [])).rankings[0]!.entries.map((e) => e.name)).toEqual(['Femenina']);
    expect((await deviceClubRankings(db, recorder, 'A', { season: '2026/27', gender: 'male', group: 'juvenil' }, [])).rankings[0]!.entries.map((e) => e.name)).toEqual(['Juvenil']);
    expect((await deviceClubRankings(db, recorder, 'A', { season: '2025/26', gender: 'male', group: 'senior' }, [])).rankings[0]!.entries.map((e) => e.name)).toEqual(['Antigua']);
  });

  it('equipos sin partidos o sin participantes: clasificaciones vacías', async () => {
    team('vac', 'SMV2627', { group: 'vacio' });
    const r = await deviceClubRankings(db, (await addDevice(db, 'vacio', [{ clubId: 'A', teamId: 'vac', role: 'coach' }])).auth, 'A', { season: '2026/27', gender: 'male', group: 'vacio' }, []);
    expect(r.rankings.map((x) => [x.id, x.entries.length, x.ranked])).toEqual(CLUB_RANKINGS.map((id) => [id, 0, 0]));
    expect(r.teams).toEqual([{ code: 'SMV2627', name: 'Equipo vac' }]);
  });
});

describe('permisos', () => {
  it('entrenador de un equipo del grupo: Top 10 y su puesto; de las fichas ajenas pedidas, nada', async () => {
    const r = await call(`/api/clubs/A/rankings${q(SENIOR_M, '&players=a11,b11,b9')}`, { token: coachToken });
    expect(r.status).toBe(200);
    // Solo las fichas de SU equipo (sma).
    expect(r.body.mine.map((m) => m.playerId)).toEqual(['a11']);
    expect((await call('/api/clubs/A/rankings', { token: coachToken })).body).toEqual({ groups: [SENIOR_M] });
  });

  it('visibilidad «admins»: ningún dispositivo; la administración, la clasificación completa', async () => {
    db.run("UPDATE clubs SET rankings_visibility = 'admins' WHERE id = 'A'");
    expect(await call(`/api/clubs/A/rankings${q()}`, { token: coachToken })).toMatchObject({ status: 403, body: { error: 'club_rankings_unavailable' } });
    expect((await call('/api/clubs/A/rankings', { token: coachToken })).body).toEqual({ groups: [] });
    const admin = await call(`/api/admin/clubs/A/rankings${q()}`, { email: ADMIN_A });
    expect(admin.status).toBe(200);
    expect(ranking(admin.body, 'top_scorer').entries.length).toBe(ranking(admin.body, 'top_scorer').ranked);
    expect((await call(`/api/admin/clubs/A/rankings${q()}`, { email: OWNER })).status).toBe(200);
  });

  it('consulta (familias): nunca, ni siquiera con «members»; entrenador de un equipo que no participa: tampoco', async () => {
    const viewer = await addDevice(db, 'familia', [{ clubId: 'A', teamId: 'sma', role: 'viewer' }]);
    expect((await call(`/api/clubs/A/rankings${q()}`, { token: viewer.token })).status).toBe(403);
    db.run("UPDATE clubs SET rankings_visibility = 'members' WHERE id = 'A'");
    expect((await call(`/api/clubs/A/rankings${q()}`, { token: viewer.token })).status).toBe(403);
    expect((await call('/api/clubs/A/rankings', { token: viewer.token })).body).toEqual({ groups: [] });
    const other = await addDevice(db, 'np', [{ clubId: 'A', teamId: 'np', role: 'coach' }]);
    expect((await call(`/api/clubs/A/rankings${q()}`, { token: other.token })).status).toBe(403);
    // Entrenador de un equipo de otro grupo: no ve este.
    const fem = await addDevice(db, 'fem', [{ clubId: 'A', teamId: 'sfa', role: 'coach' }]);
    expect((await call(`/api/clubs/A/rankings${q()}`, { token: fem.token })).status).toBe(403);
  });

  it('otro club: 404 para dispositivos y administradores ajenos; sin credencial, 401', async () => {
    expect((await call(`/api/clubs/B/rankings${q()}`, { token: coachToken })).status).toBe(404);
    expect((await call('/api/clubs/B/rankings', { token: coachToken })).status).toBe(404);
    expect((await call(`/api/admin/clubs/B/rankings${q()}`, { email: ADMIN_A })).status).toBe(404);
    expect((await call(`/api/clubs/A/rankings${q()}`)).status).toBe(401);
    expect((await call(`/api/admin/clubs/A/rankings${q()}`)).status).toBe(401);
    db.run("UPDATE clubs SET status = 'suspended' WHERE id = 'A'");
    expect((await call(`/api/clubs/A/rankings${q()}`, { token: coachToken })).status).toBe(404);
  });

  it('parámetros no válidos: 400', async () => {
    for (const bad of ['?season=2026/27&gender=x&group=senior', '?season=&gender=male&group=senior', `?season=2026/27&gender=male&group=${'x'.repeat(31)}`]) {
      expect((await call(`/api/clubs/A/rankings${bad}`, { token: coachToken })).status).toBe(400);
    }
  });

  it('la respuesta no lleva partidos, convocatorias, acciones ni fichas completas', async () => {
    const r = await call(`/api/clubs/A/rankings${q(SENIOR_M, '&players=a11')}`, { token: coachToken });
    // Ninguna caché compartida (ni del navegador) puede guardar la respuesta.
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect((await call(`/api/admin/clubs/A/rankings${q()}`, { email: ADMIN_A })).headers.get('Cache-Control')).toBe('no-store');
    const text = JSON.stringify(r.body);
    for (const k of ['matchId', 'opponent', 'squad', 'events', 'kind', '"date"', 'person', 'playerId":"b', 'ma1', 'mb1', 'createdAt']) expect(text).not.toContain(k);
    const keys = new Set(r.body.rankings.flatMap((x) => x.entries.flatMap((e) => Object.keys(e))));
    expect([...keys].sort()).toEqual(['made', 'matches', 'name', 'of', 'position', 'teams', 'value'].filter((k) => keys.has(k)));
    expect(Object.keys(r.body).sort()).toEqual(['computedAt', 'gender', 'group', 'mine', 'rankings', 'season', 'teams']);
  });
});

describe('caché', () => {
  const cacheRow = () => db.sqlite.prepare("SELECT fingerprint, payload, computed_at FROM club_rankings_cache WHERE club_id = 'A' AND season = '2026/27' AND group_key = 'male:senior'").get() as { fingerprint: string; payload: string; computed_at: string } | undefined;
  const at = (min: number) => new Date(Date.UTC(2026, 10, 3, 12, min));

  it('se calcula una vez; misma huella, misma copia; cada cambio relevante la invalida', async () => {
    const first = await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, [], at(0));
    const row = cacheRow()!;
    // Lo guardado no lleva nombres.
    for (const n of ['Siete A', 'Ana', 'Juan', 'Nueve']) expect(row.payload).not.toContain(n);
    expect((await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, [], at(1))).computedAt).toBe(first.computedAt);

    const recomputed = async (what: string, change: () => unknown | Promise<unknown>, minute: number) => {
      const before = cacheRow()!.fingerprint;
      await change();
      const r = await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, [], at(minute));
      expect(r.computedAt, what).toBe(at(minute).toISOString());
      expect(cacheRow()!.fingerprint, what).not.toBe(before);
      return r;
    };
    // Nueva acción en un partido histórico (sincronización).
    let r = await recomputed('acción nueva', () => applyEventOp(db, recorder, { opId: `op-${++seq}`, teamId: 'smb', baseVersion: null, event: ev(GOAL, 'b9', 2, { matchId: 'mb1' }) }), 2);
    expect(ranking(r, 'top_scorer').entries.find((e) => e.name === 'Nueve B')).toMatchObject({ value: 3 });
    // Corrección de un partido histórico: anular una acción.
    const goal = db.sqlite.prepare("SELECT id, version FROM events WHERE player_id = 'a7' AND deleted_at IS NULL LIMIT 1").get() as { id: string; version: number };
    const row7 = db.sqlite.prepare('SELECT * FROM events WHERE id = ?').get(goal.id) as Record<string, unknown>;
    r = await recomputed('corrección', () => applyEventOp(db, recorder, { opId: `op-${++seq}`, teamId: 'sma', baseVersion: goal.version, event: { ...ev(GOAL, 'a7', 1, { matchId: 'ma1' }), id: goal.id, createdAt: row7.created_at as string, deletedAt: NOW } }), 3);
    expect(ranking(r, 'top_scorer').entries.find((e) => e.name === 'Siete A')).toMatchObject({ value: 2 });
    // Vincular, excluir, participación y grupo.
    person('ana', 'Ana');
    await recomputed('vincular', () => link('a10', 'ana'), 4);
    await recomputed('excluir', () => db.run("UPDATE players SET ranking_excluded = 1 WHERE id = 'b11'"), 5);
    await recomputed('participación', () => db.run("UPDATE teams SET club_rankings = 0 WHERE id = 'smb'"), 6);
    await recomputed('grupo', () => db.run("UPDATE teams SET club_rankings = 1, ranking_group = 'senior' WHERE id = 'np'"), 7);
    // La visibilidad no cambia el cálculo: no invalida.
    db.run("UPDATE clubs SET rankings_visibility = 'admins' WHERE id = 'A'");
    db.run("UPDATE clubs SET rankings_visibility = 'coaches' WHERE id = 'A'");
    expect((await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, [], at(8))).computedAt).toBe(at(7).toISOString());
    // Cambiar un equipo de otro grupo del club invalida igualmente (versión del club: de más, nunca de menos).
    await recomputed('equipo de otro grupo', () => db.run("UPDATE teams SET name = 'Otro nombre' WHERE id = 'sfa'"), 9);
  });

  it('una copia de un grupo o club nunca sirve para otro; los permisos se comprueban aunque haya copia', async () => {
    await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, []);
    const fem = await deviceClubRankings(db, recorder, 'A', { season: '2026/27', gender: 'female', group: 'senior' }, []);
    expect(fem.rankings.every((x) => x.entries.length === 0)).toBe(true);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM club_rankings_cache').get()).toEqual({ n: 2 });
    db.run("UPDATE clubs SET rankings_visibility = 'admins' WHERE id = 'A'");
    expect((await call(`/api/clubs/A/rankings${q()}`, { token: coachToken })).status).toBe(403);
  });
});

describe('compatibilidad y volumen', () => {
  it('la sincronización y la descarga del equipo no cambian por calcular rankings', async () => {
    const before = await teamSnapshot(db, coachAuth, 'sma');
    await deviceClubRankings(db, coachAuth, 'A', SENIOR_M, []);
    expect(await teamSnapshot(db, coachAuth, 'sma')).toEqual(before);
    expect(JSON.stringify(before)).not.toMatch(/ranking|person/i);
  });

  it('volumen mayor: un cálculo, un número fijo de consultas', async () => {
    // 4 equipos × 18 jugadores × 15 partidos × 40 acciones ≈ 2400 acciones más.
    for (const t of ['g1', 'g2', 'g3', 'g4']) {
      team(t, t.toUpperCase() + '2627', { group: 'grande' });
      db.run("INSERT INTO grants (id, device_id, club_id, team_id, role, created_at) VALUES (?, 'entrenador-sma', 'A', ?, 'coach', ?)", `gr-${t}`, t, NOW);
      const players = Array.from({ length: 18 }, (_, i) => `${t}-p${i}`);
      for (const [i, id] of players.entries()) db.run('INSERT INTO players (id, team_id, name, number, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, t, `J ${id}`, i + 1, 'field', NOW, NOW);
      for (let m = 0; m < 15; m++) {
        const mid = `${t}-m${m}`;
        db.run("INSERT INTO matches (id, team_id, opponent, date, venue, season, status, half_minutes, clock_json, created_at, updated_at) VALUES (?, ?, 'Rival', '2026-10-01', 'home', '2026/27', 'finished', 30, '{}', ?, ?)", mid, t, NOW, NOW);
        players.forEach((id, i) => db.run('INSERT INTO match_squad (match_id, player_id, team_id, name, number, position, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)', mid, id, t, `J ${id}`, i + 1, 'field', i));
        for (let e = 0; e < 40; e++) db.run("INSERT INTO events (id, match_id, team_id, player_id, kind, shot_type, result, period, match_time_ms, created_at, updated_at) VALUES (?, ?, ?, ?, 'shot', 'nine_m', ?, 1, ?, ?, ?)", `${mid}-e${e}`, mid, t, players[e % 18]!, e % 3 ? 'goal' : 'out', e * 1000, NOW, NOW);
      }
    }
    const me = (await addDevice(db, 'grande', ['g1', 'g2', 'g3', 'g4'].map((teamId) => ({ clubId: 'A', teamId, role: 'coach' as const })))).auth;
    let prepared = 0;
    const counting = new Proxy(db, { get: (t, k) => (k === 'prepare' ? (sql: string) => (prepared++, t.prepare(sql)) : Reflect.get(t, k, t)) });
    const t0 = performance.now();
    const r = await deviceClubRankings(counting, me, 'A', { season: '2026/27', gender: 'male', group: 'grande' }, []);
    const elapsed = performance.now() - t0;
    // Todos lanzan (72 en «Más lanzamientos»); seis por equipo no marcan (48 en «El pistolero»).
    expect(ranking(r, 'shots').ranked).toBe(72);
    expect(ranking(r, 'top_scorer').ranked).toBe(48);
    // Grupo y huella (2), copia (1), cálculo (4), guardado (1), nombres (2): sin consultas por jugador ni por partido.
    expect(prepared).toBeLessThanOrEqual(10);
    expect(elapsed).toBeLessThan(3000);
    prepared = 0;
    await deviceClubRankings(counting, me, 'A', { season: '2026/27', gender: 'male', group: 'grande' }, []);
    // Con copia: grupo y huella, copia y nombres.
    expect(prepared).toBeLessThanOrEqual(5);
  });
});
