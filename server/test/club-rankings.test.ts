// Rankings del club («Todo el club») en el servidor: mismo motor que los rankings
// de equipo, sobre todos los equipos del club en la temporada (sin activar nada),
// agregando por persona (nunca por nombre), con caché por huella y permisos en
// cada petición (entrenadores y consulta). Los datos entran por la sincronización
// real. Datos sintéticos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventPayload, Match, Player, Position, SquadEntry } from '../../src/domain/types';
import { ev, makeMatch } from '../../src/test/fixtures';
import { buildBootstrapSql } from '../scripts/bootstrap-superadmin.mjs';
import { clearJwksCache } from '../src/access';
import { countsForSeason } from '../../src/services/statsService';
import { computeSeasonStats } from '../../src/stats/engine';
import { RANKING_LIMIT, RANKING_THRESHOLDS, RANKINGS, rankPlayers, seasonCandidates } from '../../src/stats/rankings';
import { CLUB_GROUP, CLUB_RANKINGS, CLUB_RULES_VERSION, deviceClubRankings, type ClubRankingsResponse } from '../src/clubRankings';
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
// «Todo el club» de 2026/27: sma, smb (masculinos), sfa (femenino) y jm (juvenil), sin configurar nada.
const S2627 = { season: '2026/27', group: CLUB_GROUP } as const;

// --- Datos ---------------------------------------------------------------------------

type Roster = Record<string, [name: string, number: number, position?: Position]>;
const rosters = new Map<string, Roster>();

/** Equipo con sus columnas de configuración antiguas a cero (ya no se leen). */
function team(id: string, code: string, { club = 'A', season = '2026/27', gender = 'male', category = 'Senior' } = {}) {
  addTeam(db, id, club, code);
  db.run('UPDATE teams SET season = ?, gender = ?, category = ?, club_rankings = 0, ranking_group = NULL WHERE id = ?', season, gender, category, id);
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

async function call(path: string, { token, email, method = 'GET', body }: { token?: string; email?: string; method?: string; body?: unknown } = {}) {
  const h = new Headers({ 'Sec-Fetch-Site': 'same-origin', Origin: 'https://api.example' });
  if (token) h.set('Authorization', `Bearer ${token}`);
  if (email) h.set('Cf-Access-Jwt-Assertion', await issuer.sign(claimsFor(email, { aud: CONFIG.adminAud })));
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request(`https://api.example${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: (await res.json()) as ClubRankingsResponse & Record<string, unknown>, headers: res.headers };
}
const q = (g: { season: string; group: string } = S2627, extra = '') => `?season=${encodeURIComponent(g.season)}&group=${encodeURIComponent(g.group)}${extra}`;
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
  team('jm', 'JM2627', { category: 'Juvenil' });
  team('old', 'SMA2526', { season: '2025/26' });
  team('xb', 'XB2627', { club: 'B' });
  const all = ['sma', 'smb', 'sfa', 'jm', 'old'].map((teamId) => ({ clubId: 'A', teamId, role: 'coach' as const }));
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
    const r = await deviceClubRankings(db, coachAuth, 'A', S2627, []);
    // Ana: 3 + 1 = 4 goles (una sola fila); Siete A: 3; Nueve B: 2; los dos Juan Pérez, por separado.
    expect(names(r, 'top_scorer')).toEqual(['1:Ana García López', '2:Siete A', '3:Nueve B', '4:Juan Pérez', '4:Juan Pérez']);
    const ana = ranking(r, 'top_scorer').entries[0]!;
    expect(ana).toMatchObject({ value: 4, matches: 2, teams: ['SMA2627', 'SMB2627'] });
    // Sin vínculo, cada ficha suma sola.
    link('a10', null);
    link('b10', null);
    const sep = await deviceClubRankings(db, coachAuth, 'A', S2627, []);
    // Empates: mismo puesto, ordenados por dorsal como en los rankings de equipo.
    expect(names(sep, 'top_scorer')).toEqual(['1:Siete A', '1:Ana García', '3:Nueve B', '4:Ana G.', '4:Juan Pérez', '4:Juan Pérez']);
  });

  it('dos personas con el mismo nombre nunca se juntan', async () => {
    const r = await deviceClubRankings(db, coachAuth, 'A', S2627, []);
    const juanes = ranking(r, 'top_scorer').entries.filter((e) => e.name === 'Juan Pérez');
    expect(juanes.map((e) => e.teams)).toEqual([['SMA2627'], ['SMB2627']]);
  });

  it('porcentajes sobre los totales y mínimos sobre los totales de la persona', async () => {
    // Por separado, ninguna ficha de Ana llega a 10 lanzamientos (6 y 6): fuera del francotirador.
    let r = await deviceClubRankings(db, coachAuth, 'A', S2627, []);
    expect(ranking(r, 'sharpshooter').entries).toEqual([]);
    person('ana', 'Ana');
    link('a10', 'ana');
    link('b10', 'ana');
    r = await deviceClubRankings(db, coachAuth, 'A', S2627, []);
    // Juntas: 4 goles de 12 lanzamientos = 33,3 % (no la media de 50 % y 16,7 %).
    expect(ranking(r, 'sharpshooter').entries).toEqual([expect.objectContaining({ name: 'Ana', value: 33.3, made: 4, of: 12 })]);
    // El muro: 15 paradas de 20 tiros a puerta (mínimo 20) = 75 %.
    expect(ranking(r, 'wall').entries).toEqual([expect.objectContaining({ name: 'Portero A', value: 75, made: 15, of: 20 })]);
    expect(ranking(r, 'thief').entries).toEqual([expect.objectContaining({ name: 'Nueve B', value: 2 })]);
    expect(ranking(r, 'shots').entries[0]).toMatchObject({ name: 'Ana', value: 12 });
  });

  it('Top 10 con empates: puestos compartidos, los que no caben se cuentan; las diez clasificaciones del equipo', async () => {
    const many: Roster = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c${i}`, [`Jugador ${i}`, 20 + i]]));
    await roster('smb', many);
    await match('smb', 'mb2', Object.keys(many).map((pid) => [pid, GOAL, 1] as [string, EventPayload, number]), { squadOf: Object.keys(many) });
    const r = await deviceClubRankings(db, coachAuth, 'A', S2627, []);
    const top = ranking(r, 'top_scorer');
    expect(top.entries).toHaveLength(10);
    // 3 (Siete A, Ana García) · 2 (Nueve B) · 1: catorce jugadores empatados en el 4.º.
    expect(top.entries.map((e) => e.position)).toEqual([1, 1, 3, 4, 4, 4, 4, 4, 4, 4]);
    expect(top.ranked).toBe(18);
    expect(top.hiddenTies).toBe(8);
    expect(r.rankings.map((x) => x.id)).toEqual(CLUB_RANKINGS);
    expect(r.rankings.map((x) => x.id)).toEqual(RANKINGS.map((d) => d.id));
    expect(r.rankings).toHaveLength(10);
  });

  it('fichas y personas excluidas, y cuerpo técnico: fuera, y los demás suben', async () => {
    db.run("UPDATE players SET ranking_excluded = 1 WHERE id = 'a7'");
    person('ana', 'Ana');
    link('a10', 'ana');
    db.run("UPDATE people SET ranking_excluded = 1 WHERE id = 'ana'");
    const r = await deviceClubRankings(db, coachAuth, 'A', S2627, ['a7', 'a10', 'a11']);
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
    const after = await deviceClubRankings(db, coachAuth, 'A', S2627, []);
    expect(JSON.stringify(after)).not.toContain('Entrenador');
    expect(ranking(after, 'thief').entries.map((e) => e.name)).toEqual(['Nueve B', 'Juan Pérez']);
  });

  it('todo el club junto: equipos masculinos, femeninos y de otras categorías; solo la temporada separa', async () => {
    team('cvx', 'CVX2627', { gender: 'mixed', category: 'Cadete' });
    recorder = (await addDevice(db, 'registrador-cvx', ['sma', 'smb', 'sfa', 'cvx', 'jm', 'old'].map((teamId) => ({ clubId: 'A', teamId, role: 'coach' as const })))).auth;
    await roster('sfa', { f1: ['Femenina', 5] });
    await roster('cvx', { c1: ['Cadete Mixto', 4] });
    await roster('jm', { j1: ['Juvenil', 5] });
    await roster('old', { o1: ['Antigua', 5] });
    for (const [t, p] of [['sfa', 'f1'], ['cvx', 'c1'], ['jm', 'j1'], ['old', 'o1']] as const) await match(t, `m-${t}`, [[p, GOAL, 9]], { season: t === 'old' ? '2025/26' : '2026/27' });
    const club = await deviceClubRankings(db, coachAuth, 'A', S2627, []);
    // Un solo ranking: la femenina, el cadete y el juvenil compiten con los masculinos (9 goles cada uno: líderes empatados).
    expect(ranking(club, 'top_scorer').entries.filter((e) => e.position === 1).map((e) => `${e.name} ${e.teams}`).sort()).toEqual(['Cadete Mixto CVX2627', 'Femenina SFA2627', 'Juvenil JM2627']);
    expect(club.teams.map((t) => t.code)).toEqual(['CVX2627', 'JM2627', 'SFA2627', 'SMA2627', 'SMB2627']);
    expect(club.group).toBe(CLUB_GROUP);
    expect(JSON.stringify(club)).not.toContain('Antigua');
    // La otra temporada, aparte.
    expect((await deviceClubRankings(db, recorder, 'A', { season: '2025/26', group: CLUB_GROUP }, [])).rankings[0]!.entries.map((e) => e.name)).toEqual(['Antigua']);
    // El género, la categoría y la temporada de los equipos no se tocan.
    expect(db.sqlite.prepare("SELECT id, gender, category, season FROM teams WHERE id IN ('sfa', 'cvx', 'jm', 'old') ORDER BY id").all()).toEqual([
      { id: 'cvx', gender: 'mixed', category: 'Cadete', season: '2026/27' },
      { id: 'jm', gender: 'male', category: 'Juvenil', season: '2026/27' },
      { id: 'old', gender: 'male', category: 'Senior', season: '2025/26' },
      { id: 'sfa', gender: 'female', category: 'Senior', season: '2026/27' },
    ]);
  });

  it('equipo sin género ni categoría: participa igual', async () => {
    team('sin', 'SIN2627');
    db.run("UPDATE teams SET gender = NULL, category = NULL WHERE id = 'sin'");
    const r = await deviceClubRankings(db, coachAuth, 'A', S2627, []);
    expect(r.teams.map((t) => t.code)).toContain('SIN2627');
  });

  it('club nuevo con varios equipos sin partidos: funciona sin configurar nada, con clasificaciones vacías', async () => {
    addClub(db, 'C');
    team('c1', 'CMA2627', { club: 'C' });
    team('c2', 'CFA2627', { club: 'C', gender: 'female' });
    const coach = await addDevice(db, 'club-c', [{ clubId: 'C', teamId: 'c2', role: 'coach' }]);
    expect((await call('/api/clubs/C/rankings', { token: coach.token })).body).toEqual({ groups: [{ ...S2627, teamIds: ['c2'] }] });
    const r = await call(`/api/clubs/C/rankings${q()}`, { token: coach.token });
    expect(r.status).toBe(200);
    expect(r.body.rankings.map((x) => [x.id, x.entries.length, x.ranked])).toEqual(CLUB_RANKINGS.map((id) => [id, 0, 0]));
    expect(r.body.teams.map((t) => t.code)).toEqual(['CMA2627', 'CFA2627']);
  });
});

describe('las diez clasificaciones', () => {
  const PEN_GOAL: EventPayload = { kind: 'shot', shotType: 'penalty', result: 'goal' };
  const PEN_OUT: EventPayload = { kind: 'shot', shotType: 'penalty', result: 'out' };
  const PEN_SAVED: EventPayload = { kind: 'shot', shotType: 'penalty', result: 'saved' };
  const FAST: EventPayload = { kind: 'shot', shotType: 'fast_break', result: 'goal' };
  const GK_PEN_SAVE: EventPayload = { kind: 'gk_shot', shotType: 'penalty', result: 'save' };
  const EXCLUSION: EventPayload = { kind: 'exclusion' };
  const TURNOVER: EventPayload = { kind: 'turnover', turnoverType: 'general' };
  const full = async () => (await call(`/api/admin/clubs/A/rankings${q()}`, { email: OWNER })).body;
  const teamRanked = async (teamId: string, def: (typeof RANKINGS)[number]) => {
    const snap = await teamSnapshot(db, recorder, teamId);
    const byMatch = snap.matches.map(({ match }) => ({ match, events: snap.events.map((e) => e.event).filter((e) => e.matchId === match.id) }));
    return rankPlayers(def, seasonCandidates(computeSeasonStats(byMatch.filter((m) => countsForSeason(m.match, m.events)))));
  };

  beforeEach(async () => {
    await match('sma', 'ma2', [['a10', PEN_GOAL, 2], ['a10', PEN_OUT], ['a7', FAST, 2], ['a1', GK_PEN_SAVE, 2], ['a11', EXCLUSION, 3]]);
    await match('smb', 'mb2', [['b10', PEN_GOAL], ['b10', PEN_SAVED, 2], ['b9', TURNOVER, 2], ['b11', FAST]]);
  });

  it('el club ofrece las diez y cada cifra coincide con la clasificación de su equipo', async () => {
    const r = await full();
    expect(r.rankings.map((x) => x.id)).toEqual(RANKINGS.map((d) => d.id));
    for (const def of RANKINGS) {
      const club = new Map(ranking(r, def.id).entries.map((e) => [`${e.name}|${e.teams.join()}`, [e.value, e.made, e.of, e.matches]]));
      let count = 0;
      for (const [teamId, code] of [['sma', 'SMA2627'], ['smb', 'SMB2627']] as const) {
        for (const e of await teamRanked(teamId, def)) {
          count++;
          expect(club.get(`${e.player.name}|${code}`), `${def.id} ${e.player.name}`).toEqual([e.value, e.made, e.of, e.player.matches]);
        }
      }
      // Sin vínculos, el club es exactamente la unión de los equipos.
      expect(ranking(r, def.id).ranked, def.id).toBe(count);
    }
  });

  it('cifras nuevas: 7 metros con mínimo, contraataque, penaltis parados, exclusiones (la roja no suma) y pérdidas', async () => {
    const r = await full();
    // Nadie llega a 5 lanzamientos de 7 metros por separado (3 y 3).
    expect(ranking(r, 'penalty_specialist').entries).toEqual([]);
    expect(names(r, 'speedster')).toEqual(['1:Siete A', '2:Juan Pérez']);
    expect(ranking(r, 'penalty_stopper').entries).toEqual([expect.objectContaining({ name: 'Portero A', value: 2 })]);
    // Tres exclusiones (la tercera trae la roja por acumulación): 3, no 4.
    expect(ranking(r, 'repeat_offender').entries).toEqual([expect.objectContaining({ name: 'Juan Pérez', value: 3, teams: ['SMA2627'] })]);
    expect(ranking(r, 'generous').entries).toEqual([expect.objectContaining({ name: 'Nueve B', value: 2 })]);
  });

  it('persona vinculada: suma sus fichas en todas, también para llegar al mínimo de 7 metros', async () => {
    person('ana', 'Ana García López');
    link('a10', 'ana');
    link('b10', 'ana');
    const r = await full();
    // 2 + 1 goles de 3 + 3 lanzamientos de 7 metros = 3 de 6 = 50 %.
    expect(ranking(r, 'penalty_specialist').entries).toEqual([
      expect.objectContaining({ name: 'Ana García López', value: 50, made: 3, of: 6, teams: ['SMA2627', 'SMB2627'] }),
    ]);
    for (const def of RANKINGS) expect(ranking(r, def.id).entries.filter((e) => e.name === 'Ana García López').length, def.id).toBeLessThanOrEqual(1);
    // Los dos «Juan Pérez» siguen separados.
    expect(ranking(r, 'speedster').entries.map((e) => `${e.name} ${e.teams}`)).toEqual(['Siete A SMA2627', 'Juan Pérez SMB2627']);
  });

  it('exclusión de ficha, ficha borrada y acción anulada: fuera también de las nuevas', async () => {
    db.run("UPDATE players SET ranking_excluded = 1 WHERE id = 'a1'");
    db.run("UPDATE players SET deleted_at = ? WHERE id = 'a11'", NOW);
    // Anular un contraataque de Siete A (corrección de un partido).
    const fast = db.sqlite.prepare("SELECT id, version, created_at FROM events WHERE player_id = 'a7' AND shot_type = 'fast_break' LIMIT 1").get() as { id: string; version: number; created_at: string };
    await applyEventOp(db, recorder, { opId: `op-${++seq}`, teamId: 'sma', baseVersion: fast.version, event: { ...ev(FAST, 'a7', 1, { matchId: 'ma2' }), id: fast.id, createdAt: fast.created_at, deletedAt: NOW } });
    const r = await full();
    expect(ranking(r, 'penalty_stopper').entries).toEqual([]);
    expect(ranking(r, 'repeat_offender').entries).toEqual([]);
    expect(names(r, 'speedster')).toEqual(['1:Siete A', '1:Juan Pérez']);
    expect(ranking(r, 'speedster').entries.map((e) => e.value)).toEqual([1, 1]);
  });

  it('un partido borrado no cuenta en ninguna', async () => {
    db.run("UPDATE matches SET deleted_at = ? WHERE id = 'ma2'", NOW);
    const r = await full();
    for (const id of ['speedster', 'penalty_stopper', 'repeat_offender'] as const) {
      expect(ranking(r, id).entries.every((e) => !e.teams.includes('SMA2627')), id).toBe(true);
    }
  });
});

describe('fichas borradas', () => {
  // Hoy ninguna ruta de la aplicación borra fichas (la sincronización las desactiva);
  // se marcan aquí directamente, como haría una corrección de datos.
  const remove = (...ids: string[]) => db.run(`UPDATE players SET deleted_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`, NOW, ...ids);
  const admin = async () => (await call(`/api/admin/clubs/A/rankings${q()}`, { email: OWNER })).body;
  const keys = (r: ClubRankingsResponse) => r.rankings.flatMap((x) => x.entries.map((e) => `${x.id}:${e.name}`));

  it('ficha borrada con estadísticas: fuera de todas las clasificaciones, sin nombre, y los demás suben', async () => {
    remove('a7');
    const r = await deviceClubRankings(db, coachAuth, 'A', S2627, ['a7', 'a11']);
    expect(names(r, 'top_scorer')).toEqual(['1:Ana García', '2:Nueve B', '3:Ana G.', '3:Juan Pérez', '3:Juan Pérez']);
    expect(JSON.stringify(r)).not.toContain('Siete A');
    // Su puesto propio tampoco se puede pedir; el de las demás fichas, sí.
    expect(r.mine.map((m) => m.playerId)).toEqual(['a11']);
    // La administración (clasificación completa) tampoco la ve.
    const full = await admin();
    expect(JSON.stringify(full)).not.toContain('Siete A');
    expect(ranking(full, 'top_scorer').ranked).toBe(5);
  });

  it('ficha borrada sin estadísticas: el resultado no cambia', async () => {
    await roster('sma', { a20: ['Sin Datos', 20] });
    const strip = (r: ClubRankingsResponse) => ({ ...r, computedAt: '' });
    const before = strip(await admin());
    remove('a20');
    expect(strip(await admin())).toEqual(before);
    expect(JSON.stringify(before)).not.toContain('Sin Datos');
  });

  it('persona con una ficha borrada: conserva solo la ficha viva, con su equipo, partidos y mínimos', async () => {
    person('ana', 'Ana García López');
    link('a10', 'ana');
    link('b10', 'ana');
    const both = await admin();
    // Juntas: 3 + 1 goles; 4 de 12 lanzamientos (llega al mínimo de 10).
    expect(ranking(both, 'top_scorer').entries[0]).toMatchObject({ name: 'Ana García López', value: 4, matches: 2, teams: ['SMA2627', 'SMB2627'] });
    expect(ranking(both, 'sharpshooter').entries.find((e) => e.name === 'Ana García López')).toMatchObject({ made: 4, of: 12 });
    remove('b10');
    const r = await admin();
    const ana = ranking(r, 'top_scorer').entries.filter((e) => e.name === 'Ana García López');
    expect(ana).toEqual([expect.objectContaining({ value: 3, matches: 1, teams: ['SMA2627'] })]);
    // Sola: 3 de 6 lanzamientos, por debajo del mínimo sobre su total.
    expect(ranking(r, 'sharpshooter').entries.some((e) => e.name === 'Ana García López')).toBe(false);
    // Ni duplicada ni la ficha borrada suelta.
    expect(keys(r).filter((k) => k === 'top_scorer:Ana García López')).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('Ana G.');
  });

  it('persona con todas sus fichas borradas: desaparece', async () => {
    person('ana', 'Ana García López');
    link('a10', 'ana');
    link('b10', 'ana');
    remove('a10', 'b10');
    const r = await admin();
    for (const n of ['Ana García López', 'Ana García', 'Ana G.']) expect(JSON.stringify(r)).not.toContain(n);
    expect(names(r, 'top_scorer')).toEqual(['1:Siete A', '2:Nueve B', '3:Juan Pérez', '3:Juan Pérez']);
  });

  it('exclusiones: siguen igual con fichas borradas al lado', async () => {
    person('ana', 'Ana');
    link('a10', 'ana');
    link('b10', 'ana');
    db.run("UPDATE people SET ranking_excluded = 1 WHERE id = 'ana'");
    db.run("UPDATE players SET ranking_excluded = 1 WHERE id = 'b9'");
    remove('b10', 'a11');
    const r = await deviceClubRankings(db, coachAuth, 'A', S2627, ['a10', 'a11', 'a7']);
    expect(names(r, 'top_scorer')).toEqual(['1:Siete A', '2:Juan Pérez']);
    // Persona excluida: se indica como siempre; ficha borrada: no se devuelve.
    expect(r.mine).toEqual(expect.arrayContaining([{ playerId: 'a10', excluded: true, rankings: [] }, expect.objectContaining({ playerId: 'a7', rankings: expect.any(Array) })]));
    expect(r.mine.map((m) => m.playerId).sort()).toEqual(['a10', 'a7']);
  });

  it('el equipo no cambia: su descarga y su «Temporada» siguen contando a la ficha borrada', async () => {
    const stats = async () => {
      const snap = await teamSnapshot(db, coachAuth, 'sma');
      const byMatch = snap.matches.map(({ match }) => ({ match, events: snap.events.map((e) => e.event).filter((e) => e.matchId === match.id) }));
      return { snap, season: computeSeasonStats(byMatch.filter((m) => countsForSeason(m.match, m.events))) };
    };
    const before = await stats();
    remove('a7');
    const after = await stats();
    expect(after.snap).toEqual(before.snap);
    expect(after.season.players.get('a7')!.counters.shots.goals).toBe(3);
  });
});

describe('permisos', () => {
  it('entrenador de un equipo del club: Top 10 y su puesto; de las fichas ajenas pedidas, nada', async () => {
    const r = await call(`/api/clubs/A/rankings${q(S2627, '&players=a11,b11,b9')}`, { token: coachToken });
    expect(r.status).toBe(200);
    // Solo las fichas de SU equipo (sma).
    expect(r.body.mine.map((m) => m.playerId)).toEqual(['a11']);
    expect((await call('/api/clubs/A/rankings', { token: coachToken })).body).toEqual({ groups: [{ ...S2627, teamIds: ['sma'] }] });
  });

  it('consulta (familias) de cualquier equipo del club, también sin partidos: el Top 10 de todo el club', async () => {
    for (const teamId of ['sfa', 'jm', 'smb']) {
      const viewer = await addDevice(db, `familia-${teamId}`, [{ clubId: 'A', teamId, role: 'viewer' }]);
      expect((await call('/api/clubs/A/rankings', { token: viewer.token })).body).toEqual({ groups: [{ ...S2627, teamIds: [teamId] }] });
      const r = await call(`/api/clubs/A/rankings${q()}`, { token: viewer.token });
      expect(r.status, teamId).toBe(200);
      expect(r.body.teams.map((t) => t.code)).toEqual(['JM2627', 'SFA2627', 'SMA2627', 'SMB2627']);
      // Top 10, no la clasificación completa.
      expect(ranking(r.body, 'top_scorer').entries.length).toBeLessThanOrEqual(10);
      expect(ranking(r.body, 'top_scorer').entries[0]).toMatchObject({ position: 1 });
    }
  });

  it('temporadas: una por cada temporada de sus equipos, con sus equipos de esa temporada; la más reciente primero', async () => {
    const { token } = await addDevice(db, 'varios', [
      { clubId: 'A', teamId: 'sma', role: 'coach' },
      { clubId: 'A', teamId: 'smb', role: 'viewer' },
      { clubId: 'A', teamId: 'jm', role: 'coach' },
      { clubId: 'A', teamId: 'old', role: 'viewer' },
      { clubId: 'B', teamId: 'xb', role: 'coach' },
    ]);
    const r = await call('/api/clubs/A/rankings', { token });
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    // sfa es del club y la temporada, pero este dispositivo no tiene permiso en él: no se nombra.
    expect(r.body).toEqual({
      groups: [
        { season: '2026/27', group: CLUB_GROUP, teamIds: ['jm', 'sma', 'smb'] },
        { season: '2025/26', group: CLUB_GROUP, teamIds: ['old'] },
      ],
    });
    for (const g of r.body.groups as Record<string, unknown>[]) expect(Object.keys(g).sort()).toEqual(['group', 'season', 'teamIds']);
    // Desde el otro club: solo su equipo.
    expect((await call('/api/clubs/B/rankings', { token })).body).toEqual({ groups: [{ ...S2627, teamIds: ['xb'] }] });
  });

  it('equipo borrado: fuera de teamIds y, sin equipos, fuera la temporada (y sin acceso)', async () => {
    const { token } = await addDevice(db, 'dos', [
      { clubId: 'A', teamId: 'sma', role: 'coach' },
      { clubId: 'A', teamId: 'smb', role: 'viewer' },
    ]);
    db.run("UPDATE teams SET deleted_at = ? WHERE id = 'smb'", NOW);
    expect((await call('/api/clubs/A/rankings', { token })).body).toEqual({ groups: [{ ...S2627, teamIds: ['sma'] }] });
    db.run("UPDATE teams SET deleted_at = ? WHERE id = 'sma'", NOW);
    expect((await call('/api/clubs/A/rankings', { token })).body).toEqual({ groups: [] });
    expect(await call(`/api/clubs/A/rankings${q()}`, { token })).toMatchObject({ status: 403, body: { error: 'club_rankings_unavailable' } });
  });

  it('la configuración antigua (visibilidad, participación y grupos) ya no cuenta', async () => {
    const viewer = await addDevice(db, 'familia', [{ clubId: 'A', teamId: 'sfa', role: 'viewer' }]);
    const before = await call(`/api/clubs/A/rankings${q()}`, { token: viewer.token });
    for (const sql of [
      "UPDATE clubs SET rankings_visibility = 'admins' WHERE id = 'A'",
      "UPDATE teams SET club_rankings = 0, ranking_group = NULL WHERE club_id = 'A'",
      "UPDATE teams SET club_rankings = 1, ranking_group = 'otro grupo' WHERE id = 'smb'",
    ]) {
      db.run(sql);
      for (const token of [viewer.token, coachToken]) {
        const r = await call(`/api/clubs/A/rankings${q()}`, { token });
        expect(r.status, sql).toBe(200);
        expect(r.body.teams).toEqual(before.body.teams);
        expect(r.body.rankings).toEqual(before.body.rankings);
      }
      expect((await call('/api/clubs/A/rankings', { token: viewer.token })).body).toEqual({ groups: [{ ...S2627, teamIds: ['sfa'] }] });
    }
    // La administración sigue viendo la clasificación completa.
    const admin = await call(`/api/admin/clubs/A/rankings${q()}`, { email: ADMIN_A });
    expect(admin.status).toBe(200);
    expect(ranking(admin.body, 'top_scorer').entries.length).toBe(ranking(admin.body, 'top_scorer').ranked);
    expect((await call(`/api/admin/clubs/A/rankings${q()}`, { email: OWNER })).status).toBe(200);
  });

  it('consulta: puesto propio solo de fichas de su equipo; nunca de otros equipos ni clubes', async () => {
    const viewer = await addDevice(db, 'familia', [{ clubId: 'A', teamId: 'sma', role: 'viewer' }]);
    // Pide su ficha, una de otro equipo del club, una de otro club y una inventada.
    const r = await call(`/api/clubs/A/rankings${q(S2627, '&players=a11,b9,x7,nadie')}`, { token: viewer.token });
    expect(r.body.mine.map((m) => m.playerId)).toEqual(['a11']);
    // Más de cinco fichas pedidas: solo se miran las cinco primeras.
    await roster('sma', { a2: ['Dos', 2], a3: ['Tres', 3], a4: ['Cuatro', 4], a5: ['Cinco', 5] });
    const many = await call(`/api/clubs/A/rankings${q(S2627, '&players=a2,a3,a4,a5,a7,a11')}`, { token: viewer.token });
    expect(many.body.mine.map((m) => m.playerId).sort()).toEqual(['a2', 'a3', 'a4', 'a5', 'a7']);
    // El Top 10 no da identificadores de ficha ni de persona.
    expect(JSON.stringify(r.body.rankings)).not.toMatch(/"(playerId|personId|id)":"(a|b)\d/);
    // Otro club: 404.
    expect((await call(`/api/clubs/B/rankings${q()}`, { token: viewer.token })).status).toBe(404);
    expect((await call('/api/clubs/B/rankings', { token: viewer.token })).status).toBe(404);
  });

  it('código revocado (permiso retirado): sin acceso en la siguiente petición', async () => {
    const viewer = await addDevice(db, 'familia', [{ clubId: 'A', teamId: 'sma', role: 'viewer' }]);
    expect((await call(`/api/clubs/A/rankings${q()}`, { token: viewer.token })).status).toBe(200);
    db.run("UPDATE grants SET revoked_at = ? WHERE device_id = 'familia'", NOW);
    expect((await call(`/api/clubs/A/rankings${q()}`, { token: viewer.token })).status).toBe(404);
    expect((await call('/api/clubs/A/rankings', { token: viewer.token })).status).toBe(404);
    // Con un permiso que sigue vigente en otro equipo del club, conserva el acceso por ese equipo.
    const both = await addDevice(db, 'dos-equipos', [
      { clubId: 'A', teamId: 'sma', role: 'viewer' },
      { clubId: 'A', teamId: 'sfa', role: 'viewer' },
    ]);
    db.run("UPDATE grants SET revoked_at = ? WHERE device_id = 'dos-equipos' AND team_id = 'sma'", NOW);
    expect((await call('/api/clubs/A/rankings', { token: both.token })).body).toEqual({ groups: [{ ...S2627, teamIds: ['sfa'] }] });
    expect((await call(`/api/clubs/A/rankings${q(S2627, '&players=a11')}`, { token: both.token })).body.mine).toEqual([]);
  });

  it('sin acceso: otro club (404 para dispositivos y administradores ajenos), sin credencial (401), club suspendido (404)', async () => {
    expect((await call(`/api/clubs/B/rankings${q()}`, { token: coachToken })).status).toBe(404);
    expect((await call('/api/clubs/B/rankings', { token: coachToken })).status).toBe(404);
    expect((await call(`/api/admin/clubs/B/rankings${q()}`, { email: ADMIN_A })).status).toBe(404);
    expect((await call(`/api/clubs/A/rankings${q()}`)).status).toBe(401);
    expect((await call('/api/clubs/A/rankings')).status).toBe(401);
    expect((await call(`/api/admin/clubs/A/rankings${q()}`)).status).toBe(401);
    db.run("UPDATE clubs SET status = 'suspended' WHERE id = 'A'");
    expect((await call(`/api/clubs/A/rankings${q()}`, { token: coachToken })).status).toBe(404);
    expect((await call('/api/clubs/A/rankings', { token: coachToken })).status).toBe(404);
  });

  it('parámetros: la temporada es obligatoria; «group» y «gender» de versiones anteriores se ignoran', async () => {
    for (const bad of ['?season=', `?season=${'x'.repeat(8)}`, '?season=&group=senior']) {
      expect((await call(`/api/clubs/A/rankings${bad}`, { token: coachToken })).status, bad).toBe(400);
    }
    const now = await call(`/api/clubs/A/rankings?season=2026%2F27`, { token: coachToken });
    expect(now.status).toBe(200);
    expect(now.body.group).toBe(CLUB_GROUP);
    for (const extra of ['&group=senior', '&group=juvenil', `&group=${'x'.repeat(40)}`, '&gender=male', '&group=senior&gender=female']) {
      const old = await call(`/api/clubs/A/rankings?season=2026%2F27${extra}`, { token: coachToken });
      expect(old.status, extra).toBe(200);
      expect(old.body.rankings).toEqual(now.body.rankings);
    }
  });

  it('la respuesta no lleva partidos, convocatorias, acciones ni fichas completas', async () => {
    const r = await call(`/api/clubs/A/rankings${q(S2627, '&players=a11')}`, { token: coachToken });
    // Ninguna caché compartida (ni del navegador) puede guardar la respuesta.
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect((await call(`/api/admin/clubs/A/rankings${q()}`, { email: ADMIN_A })).headers.get('Cache-Control')).toBe('no-store');
    const text = JSON.stringify(r.body);
    for (const k of ['matchId', 'opponent', 'squad', 'events', 'kind', '"date"', 'person', 'playerId":"b', 'ma1', 'mb1', 'createdAt']) expect(text).not.toContain(k);
    const keys = new Set(r.body.rankings.flatMap((x) => x.entries.flatMap((e) => Object.keys(e))));
    expect([...keys].sort()).toEqual(['made', 'matches', 'name', 'of', 'position', 'teams', 'value'].filter((k) => keys.has(k)));
    expect(Object.keys(r.body).sort()).toEqual(['computedAt', 'group', 'mine', 'rankings', 'season', 'teams']);
  });
});

describe('caché', () => {
  const cacheRow = () => db.sqlite.prepare("SELECT fingerprint, payload, computed_at FROM club_rankings_cache WHERE club_id = 'A' AND season = '2026/27' AND group_key = 'club'").get() as { fingerprint: string; payload: string; computed_at: string } | undefined;
  const at = (min: number) => new Date(Date.UTC(2026, 10, 3, 12, min));

  it('se calcula una vez; misma huella, misma copia; cada cambio relevante la invalida', async () => {
    const first = await deviceClubRankings(db, coachAuth, 'A', S2627, [], at(0));
    const row = cacheRow()!;
    // Lo guardado no lleva nombres.
    for (const n of ['Siete A', 'Ana', 'Juan', 'Nueve']) expect(row.payload).not.toContain(n);
    expect((await deviceClubRankings(db, coachAuth, 'A', S2627, [], at(1))).computedAt).toBe(first.computedAt);

    const recomputed = async (what: string, change: () => unknown | Promise<unknown>, minute: number) => {
      const before = cacheRow()!.fingerprint;
      await change();
      const r = await deviceClubRankings(db, coachAuth, 'A', S2627, [], at(minute));
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
    // Vincular y excluir.
    person('ana', 'Ana');
    await recomputed('vincular', () => link('a10', 'ana'), 4);
    await recomputed('excluir', () => db.run("UPDATE players SET ranking_excluded = 1 WHERE id = 'b11'"), 5);
    // Equipo nuevo en la temporada: entra solo.
    r = await recomputed('equipo nuevo', () => team('nuevo', 'NUE2627', { gender: 'female', category: 'Infantil' }), 6);
    expect(r.teams.map((t) => t.code)).toContain('NUE2627');
    // Equipo borrado: sale con sus jugadores.
    r = await recomputed('equipo borrado', () => db.run("UPDATE teams SET deleted_at = ? WHERE id = 'smb'", NOW), 7);
    expect(r.teams.map((t) => t.code)).not.toContain('SMB2627');
    expect(JSON.stringify(r)).not.toContain('Nueve B');
    // La configuración antigua ya no se lee: cambiarla puede invalidar (de más, nunca de menos), pero no cambia el resultado.
    const same = await recomputed('ajuste antiguo', () => db.run("UPDATE teams SET club_rankings = 1, ranking_group = 'x' WHERE id = 'sma'"), 8);
    expect(same.rankings).toEqual(r.rankings);
    // La visibilidad antigua no invalida nada.
    db.run("UPDATE clubs SET rankings_visibility = 'members' WHERE id = 'A'");
    expect((await deviceClubRankings(db, coachAuth, 'A', S2627, [], at(9))).computedAt).toBe(at(8).toISOString());
    // Cambiar un equipo de otra temporada del club invalida igualmente (versión del club: de más, nunca de menos).
    await recomputed('equipo de otra temporada', () => db.run("UPDATE teams SET name = 'Otro nombre' WHERE id = 'old'"), 10);
    // Cambiar el género de un equipo no lo saca del club (y no cambia nada más que la huella).
    r = await recomputed('género', () => db.run("UPDATE teams SET gender = 'female' WHERE id = 'sma'"), 11);
    expect(r.teams.map((t) => t.code)).toContain('SMA2627');
  });

  it('una copia de una temporada o club nunca sirve para otro; los permisos se comprueban aunque haya copia', async () => {
    await deviceClubRankings(db, coachAuth, 'A', S2627, []);
    const old = await deviceClubRankings(db, recorder, 'A', { season: '2025/26', group: CLUB_GROUP }, []);
    expect(old.teams.map((t) => t.code)).toEqual(['SMA2526']);
    expect(old.rankings.every((x) => x.entries.length === 0)).toBe(true);
    const other = await deviceClubRankings(db, recorder, 'B', S2627, []);
    expect(other.teams.map((t) => t.code)).toEqual(['XB2627']);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM club_rankings_cache').get()).toEqual({ n: 3 });
    db.run("UPDATE grants SET revoked_at = ? WHERE device_id = 'entrenador-sma'", NOW);
    expect((await call(`/api/clubs/A/rankings${q()}`, { token: coachToken })).status).toBe(404);
  });

  it('borrar o recuperar una ficha invalida la copia, aunque no pase por el registro de cambios', async () => {
    await deviceClubRankings(db, coachAuth, 'A', S2627, [], at(0));
    const seq = () => db.sqlite.prepare('SELECT MAX(seq) AS s FROM change_log').get();
    const log = seq();
    const before = cacheRow()!.fingerprint;
    db.run("UPDATE players SET deleted_at = ? WHERE id = 'a7'", NOW);
    expect(seq()).toEqual(log);
    const r = await deviceClubRankings(db, coachAuth, 'A', S2627, [], at(1));
    expect(r.computedAt).toBe(at(1).toISOString());
    expect(JSON.stringify(r)).not.toContain('Siete A');
    expect(cacheRow()!.fingerprint).not.toBe(before);
    db.run("UPDATE players SET deleted_at = NULL WHERE id = 'a7'");
    const back = await deviceClubRankings(db, coachAuth, 'A', S2627, [], at(2));
    expect(back.computedAt).toBe(at(2).toISOString());
    expect(names(back, 'top_scorer')[0]).toBe('1:Siete A');
    // Calcular no escribe nada fuera de la copia.
    expect(seq()).toEqual(log);
  });

  it('una copia de reglas anteriores con la misma clave (club-v4, cinco clasificaciones) nunca se reutiliza', async () => {
    const sha = async (v: unknown) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(v))))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const teams = () =>
      db.sqlite
        .prepare(
          `SELECT t.id, COALESCE((SELECT MAX(c.seq) FROM change_log c WHERE c.team_id = t.id), 0) AS seq,
                  (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id AND p.deleted_at IS NOT NULL) AS deleted
             FROM teams t WHERE t.club_id = 'A' AND t.season = '2026/27' AND t.deleted_at IS NULL ORDER BY t.id`,
        )
        .all() as { id: string; seq: number; deleted: number }[];
    const version = () => (db.sqlite.prepare("SELECT rankings_version AS v FROM clubs WHERE id = 'A'").get() as { v: number }).v;
    const print = (rules: string) => sha([rules, CLUB_RANKINGS, RANKING_THRESHOLDS, RANKING_LIMIT, S2627, version(), teams().map((t) => [t.id, t.seq, t.deleted])]);
    db.run("UPDATE players SET deleted_at = ? WHERE id = 'a7'", NOW);
    await deviceClubRankings(db, coachAuth, 'A', S2627, [], at(0));
    // La huella de la prueba es la del servidor (club-v5).
    expect(CLUB_RULES_VERSION).toBe('club-v5');
    expect(cacheRow()!.fingerprint).toBe(await print('club-v5'));
    // Copia de club-v4 para el mismo club y estado (cinco clasificaciones), con una ficha borrada en cabeza.
    const stale = { candidates: { 'f:a7': { players: ['a7'], teams: ['sma'], matches: 1 } }, rankings: { ...Object.fromEntries(CLUB_RANKINGS.map((id) => [id, []])), top_scorer: [{ k: 'f:a7', p: 1, v: 3 }] } };
    db.run("UPDATE club_rankings_cache SET fingerprint = ?, payload = ?, computed_at = ? WHERE club_id = 'A' AND group_key = 'club'", await print('club-v4'), JSON.stringify(stale), NOW);
    const r = await deviceClubRankings(db, coachAuth, 'A', S2627, [], at(1));
    expect(r.computedAt).toBe(at(1).toISOString());
    expect(JSON.stringify(r)).not.toContain('Siete A');
    expect(r.rankings).toHaveLength(10);
    expect(cacheRow()!.fingerprint).toBe(await print('club-v5'));
  });

  it('las copias de reglas anteriores (por género o por grupo) nunca se reutilizan y no estorban', async () => {
    const fake = JSON.stringify({ candidates: {}, rankings: {} });
    for (const key of ['male:senior', 'g:Todo el club', 'g:senior']) {
      db.run("INSERT INTO club_rankings_cache (club_id, season, group_key, fingerprint, payload, computed_at) VALUES ('A', '2026/27', ?, 'huella-antigua', ?, ?)", key, fake, NOW);
    }
    const r = await deviceClubRankings(db, coachAuth, 'A', S2627, [], new Date(Date.UTC(2026, 10, 4)));
    expect(r.computedAt).toBe(new Date(Date.UTC(2026, 10, 4)).toISOString());
    expect(ranking(r, 'top_scorer').entries.length).toBeGreaterThan(0);
    expect(cacheRow()).toBeDefined();
  });
});

describe('compatibilidad y volumen', () => {
  it('la sincronización y la descarga del equipo no cambian por calcular rankings', async () => {
    const before = await teamSnapshot(db, coachAuth, 'sma');
    await deviceClubRankings(db, coachAuth, 'A', S2627, []);
    expect(await teamSnapshot(db, coachAuth, 'sma')).toEqual(before);
    expect(JSON.stringify(before)).not.toMatch(/ranking|person/i);
  });

  it('volumen mayor: un cálculo, un número fijo de consultas', async () => {
    // Club con 4 equipos × 18 jugadores × 15 partidos × 40 acciones ≈ 2400 acciones.
    addClub(db, 'G');
    for (const t of ['g1', 'g2', 'g3', 'g4']) {
      team(t, t.toUpperCase() + '2627', { club: 'G' });
      const players = Array.from({ length: 18 }, (_, i) => `${t}-p${i}`);
      for (const [i, id] of players.entries()) db.run('INSERT INTO players (id, team_id, name, number, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, t, `J ${id}`, i + 1, 'field', NOW, NOW);
      for (let m = 0; m < 15; m++) {
        const mid = `${t}-m${m}`;
        db.run("INSERT INTO matches (id, team_id, opponent, date, venue, season, status, half_minutes, clock_json, created_at, updated_at) VALUES (?, ?, 'Rival', '2026-10-01', 'home', '2026/27', 'finished', 30, '{}', ?, ?)", mid, t, NOW, NOW);
        players.forEach((id, i) => db.run('INSERT INTO match_squad (match_id, player_id, team_id, name, number, position, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)', mid, id, t, `J ${id}`, i + 1, 'field', i));
        for (let e = 0; e < 40; e++) db.run("INSERT INTO events (id, match_id, team_id, player_id, kind, shot_type, result, period, match_time_ms, created_at, updated_at) VALUES (?, ?, ?, ?, 'shot', 'nine_m', ?, 1, ?, ?, ?)", `${mid}-e${e}`, mid, t, players[e % 18]!, e % 3 ? 'goal' : 'out', e * 1000, NOW, NOW);
      }
    }
    const me = (await addDevice(db, 'grande', [{ clubId: 'G', teamId: 'g1', role: 'viewer' as const }])).auth;
    let prepared = 0;
    const counting = new Proxy(db, { get: (t, k) => (k === 'prepare' ? (sql: string) => (prepared++, t.prepare(sql)) : Reflect.get(t, k, t)) });
    const t0 = performance.now();
    const r = await deviceClubRankings(counting, me, 'G', S2627, []);
    const elapsed = performance.now() - t0;
    // Todos lanzan (72 en «Más lanzamientos»); seis por equipo no marcan (48 en «El pistolero»).
    expect(ranking(r, 'shots').ranked).toBe(72);
    expect(ranking(r, 'top_scorer').ranked).toBe(48);
    // Grupo y huella (2), copia (1), cálculo (4), guardado (1), nombres (2): sin consultas por jugador ni por partido.
    expect(prepared).toBeLessThanOrEqual(10);
    expect(elapsed).toBeLessThan(3000);
    prepared = 0;
    await deviceClubRankings(counting, me, 'G', S2627, []);
    // Con copia: grupo y huella, copia y nombres.
    expect(prepared).toBeLessThanOrEqual(5);
  });
});
