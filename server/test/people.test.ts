// Gestión administrativa de personas (identidad común) y exclusiones de los
// rankings del club, por HTTP y con tokens reales de Cloudflare Access de prueba. Datos sintéticos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Player } from '../../src/domain/types';
import { buildBootstrapSql } from '../scripts/bootstrap-superadmin.mjs';
import { clearJwksCache } from '../src/access';
import { adminContext } from '../src/auth';
import type { Db, Statement } from '../src/db';
import { createPersonWithCards, type CardView, type ClubPeople } from '../src/people';
import worker, { type Env } from '../src/index';
import { applyPlayerOp, teamSnapshot } from '../src/teamsync';
import { ACCESS_ENV, claimsFor, CONFIG, makeIssuer, serveJwks, type Issuer } from './accessKeys';
import { addDevice, NOW, PEPPER, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

let db: SqliteD1;
let env: Env;
let issuer: Issuer;
const OWNER = 'propietario@example.com';
const ADMIN_A = 'admina@example.com';
const ADMIN_B = 'adminb@example.com';

beforeEach(async () => {
  db = migratedDb();
  twoClubs(db); // club A (a1, a2) y club B (b1), con 5 jugadores cada equipo
  db.sqlite.exec(buildBootstrapSql({ identityId: 'owner', email: OWNER }));
  // Administradores de club sin entrar todavía (su «sub» de Access se fija al primer acceso).
  for (const [id, club] of [['adminA', 'A'], ['adminB', 'B']] as const) {
    db.run('INSERT INTO admin_identities (id, display_name, email, created_at) VALUES (?, ?, ?, ?)', id, id, `${id.toLowerCase()}@example.com`, NOW);
    db.run("INSERT INTO admin_roles (id, identity_id, role, club_id, created_at) VALUES (?, ?, 'club_admin', ?, ?)", `${id}-r`, id, club, NOW);
  }
  issuer = await makeIssuer();
  serveJwks(() => [issuer.jwk]);
  env = { DB: db, TOKEN_PEPPER: PEPPER, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://develop.galipau-stats.pages.dev', ...ACCESS_ENV };
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearJwksCache();
});

async function call(
  path: string,
  { email = ADMIN_A, method = 'GET', body, headers = {}, critical = false }: { email?: string | null; method?: string; body?: unknown; headers?: Record<string, string>; critical?: boolean } = {},
) {
  const h = new Headers({ 'Sec-Fetch-Site': 'same-origin', Origin: 'https://api.example', ...headers });
  // `critical`: token de la aplicación de Access de operaciones críticas (verificación reforzada).
  if (email) h.set('Cf-Access-Jwt-Assertion', await issuer.sign(claimsFor(email, { aud: critical ? CONFIG.criticalAud : CONFIG.adminAud })));
  if (body !== undefined && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request(`https://api.example${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const get = <T>(sql: string, ...v: (string | number)[]) => db.sqlite.prepare(sql).get(...v) as T;
const all = <T>(sql: string, ...v: (string | number)[]) => db.sqlite.prepare(sql).all(...v) as T[];
// Sin el alta inicial del superadministrador (procedimiento de configuración).
const audit = () =>
  all<{ action: string; target_type: string; target_id: string }>("SELECT action, target_type, target_id FROM admin_audit WHERE action <> 'superadmin.bootstrap' ORDER BY seq");
const version = (club = 'A') => get<{ v: number }>('SELECT rankings_version AS v FROM clubs WHERE id = ?', club).v;
const player = (id: string) => get<Record<string, unknown>>('SELECT person_id, name, number, version, updated_at, ranking_excluded FROM players WHERE id = ?', id);
async function newPerson(name = 'Ana García', club = 'A', email = ADMIN_A) {
  const r = await call(`/api/admin/clubs/${club}/people`, { method: 'POST', body: { displayName: name }, email });
  expect(r.status).toBe(201);
  return r.body.personId as string;
}
const link = (playerId: string, personId: string | null, expectedPersonId: string | null, email = ADMIN_A) =>
  call(`/api/admin/players/${playerId}/person`, { method: 'PUT', body: { personId, expectedPersonId }, email });

describe('personas del club', () => {
  it('sin nada creado: ninguna persona, todas las fichas de jugadores sin vincular y los equipos del club', async () => {
    db.run("UPDATE players SET role = 'official', number = 0, position = 'field' WHERE id = 'a1-p69'");
    const r = await call('/api/admin/clubs/A/people');
    expect(r.status).toBe(200);
    const list = r.body as unknown as ClubPeople;
    expect(list.people).toEqual([]);
    // 5 + 5 fichas del club A, sin el oficial ni las del club B.
    expect(list.unlinked.map((c: CardView) => c.playerId).sort()).toEqual(['a1-g1', 'a1-g12', 'a1-p14', 'a1-p7', 'a2-g1', 'a2-g12', 'a2-p14', 'a2-p69', 'a2-p7']);
    expect(list.unlinked[0]).toMatchObject({ teamCode: expect.any(String), number: expect.any(Number), season: '2026/27', rankingExcluded: false });
    // Solo los equipos (todos forman el ranking del club de su temporada): sin visibilidad, participación ni grupos.
    expect(list.rankings.teams.map((t) => t.teamId).sort()).toEqual(['a1', 'a2']);
    expect(Object.keys(list.rankings)).toEqual(['teams']);
    expect(Object.keys(list.rankings.teams[0]!).sort()).toEqual(['code', 'gender', 'name', 'season', 'teamId']);
    expect(JSON.stringify(r.body)).not.toMatch(/b1-/);
  });

  it('crear, renombrar (con versión esperada), excluir y borrar; todo auditado', async () => {
    const id = await newPerson('  Ana   García ');
    expect(get('SELECT display_name, version FROM people WHERE id = ?', id)).toEqual({ display_name: 'Ana García', version: 1 });
    expect(await call(`/api/admin/people/${id}`, { method: 'PATCH', body: { displayName: 'Ana G.', expectedVersion: 1 } })).toMatchObject({ status: 200, body: { version: 2 } });
    // Cambio perdido: otra versión esperada.
    expect(await call(`/api/admin/people/${id}`, { method: 'PATCH', body: { displayName: 'Otra', expectedVersion: 1 } })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await call(`/api/admin/people/${id}`, { method: 'PATCH', body: { rankingExcluded: true, expectedVersion: 2 } })).toMatchObject({ status: 200, body: { version: 3 } });
    expect(get('SELECT display_name, ranking_excluded FROM people WHERE id = ?', id)).toEqual({ display_name: 'Ana G.', ranking_excluded: 1 });
    expect(await call(`/api/admin/people/${id}/delete`, { method: 'POST', body: { expectedVersion: 2 } })).toMatchObject({ status: 409 });
    expect(await call(`/api/admin/people/${id}/delete`, { method: 'POST', body: { expectedVersion: 3 } })).toMatchObject({ status: 200, body: { unlinked: 0 } });
    expect(get('SELECT deleted_at IS NOT NULL AS gone FROM people WHERE id = ?', id)).toEqual({ gone: 1 });
    expect(((await call('/api/admin/clubs/A/people')).body as unknown as ClubPeople).people).toEqual([]);
    expect(await call(`/api/admin/people/${id}`, { method: 'PATCH', body: { displayName: 'X', expectedVersion: 4 } })).toMatchObject({ status: 404 });
    expect(audit().map((a) => a.action)).toEqual(['person.create', 'person.update', 'person.ranking_exclude', 'person.delete']);
  });

  it('valida las entradas sin revelar datos', async () => {
    for (const displayName of ['', '   ', 'x'.repeat(81), 'Ana\nGarcía', 42, null]) {
      expect((await call('/api/admin/clubs/A/people', { method: 'POST', body: { displayName } })).status).toBe(400);
    }
    const id = await newPerson();
    expect((await call(`/api/admin/people/${id}`, { method: 'PATCH', body: { displayName: 'Ana' } })).status).toBe(400); // sin versión
    expect((await call(`/api/admin/people/${id}`, { method: 'PATCH', body: { expectedVersion: 1 } })).status).toBe(400); // nada que cambiar
    expect((await call(`/api/admin/people/${id}`, { method: 'PATCH', body: { rankingExcluded: 'sí', expectedVersion: 1 } })).status).toBe(400);
    const missing = await call('/api/admin/people/no-existe', { method: 'PATCH', body: { displayName: 'Ana', expectedVersion: 1 } });
    expect(missing).toMatchObject({ status: 404, body: { error: 'not_found', message: 'No encontrado.' } });
    expect(JSON.stringify(missing.body)).not.toContain('no-existe');
  });
});

describe('vincular fichas', () => {
  it('fichas de dos equipos del club a la misma persona; desvincular no toca la ficha ni sus estadísticas', async () => {
    const ana = await newPerson();
    const before = player('a1-p7');
    const v0 = version();
    expect(await link('a1-p7', ana, null)).toMatchObject({ status: 200 });
    expect(await link('a2-p7', ana, null)).toMatchObject({ status: 200 });
    expect(version()).toBe(v0 + 2);
    // La ficha no cambia (ni versión ni fecha) y nada pasa por el registro de cambios.
    expect(player('a1-p7')).toEqual({ ...before, person_id: ana });
    expect(get('SELECT COUNT(*) AS n FROM change_log')).toEqual({ n: 0 });
    const list = (await call('/api/admin/clubs/A/people')).body as unknown as ClubPeople;
    expect(list.people).toEqual([expect.objectContaining({ id: ana, displayName: 'Ana García', cards: expect.arrayContaining([expect.objectContaining({ playerId: 'a1-p7', teamCode: 'SM2627' }), expect.objectContaining({ playerId: 'a2-p7', teamCode: 'JF2627' })]) })]);
    expect(list.people[0]!.cards).toHaveLength(2);
    expect(list.unlinked.map((c: CardView) => c.playerId)).not.toContain('a1-p7');
    // Desvincular (con la persona esperada).
    expect(await link('a1-p7', null, ana)).toMatchObject({ status: 200 });
    expect(player('a1-p7')).toEqual(before);
    expect(audit().map((a) => `${a.action}:${a.target_type}`)).toEqual([
      'person.create:person',
      'person.link:player',
      'person.link:person',
      'person.link:player',
      'person.link:person',
      'person.unlink:player',
      'person.unlink:person',
    ]);
  });

  it('rechaza: otro club, cuerpo técnico, persona o ficha inexistente o borrada, segunda ficha del mismo equipo', async () => {
    const ana = await newPerson();
    const deBe = await newPerson('Bea', 'B', ADMIN_B);
    expect(await link('a1-p7', deBe, null)).toMatchObject({ status: 404 }); // persona de otro club: «no encontrada»
    expect(await link('a1-p7', deBe, null, OWNER)).toMatchObject({ status: 404 }); // ni siquiera el superadministrador cruza clubes
    db.run("UPDATE players SET role = 'official', number = 0, position = 'field' WHERE id = 'a1-p69'");
    expect(await link('a1-p69', ana, null)).toMatchObject({ status: 409 });
    expect(await link('a1-nadie', ana, null)).toMatchObject({ status: 404 });
    expect(await link('a1-p7', 'nadie', null)).toMatchObject({ status: 404 });
    await link('a1-p7', ana, null);
    expect(await link('a1-p14', ana, null)).toMatchObject({ status: 409, body: { message: 'Esa persona ya tiene una ficha en este equipo.' } });
    const borrada = await newPerson('Borrada');
    await call(`/api/admin/people/${borrada}/delete`, { method: 'POST', body: { expectedVersion: 1 } });
    expect(await link('a1-p14', borrada, null)).toMatchObject({ status: 404 });
    db.run("UPDATE players SET deleted_at = ? WHERE id = 'a1-g1'", NOW);
    expect(await link('a1-g1', ana, null)).toMatchObject({ status: 404 });
    expect(get("SELECT COUNT(*) AS n FROM players WHERE person_id IS NOT NULL")).toEqual({ n: 1 });
  });

  it('cambios perdidos: con una persona esperada que ya no es la actual, 409 y nada cambia', async () => {
    const ana = await newPerson();
    const bea = await newPerson('Bea');
    await link('a1-p7', ana, null);
    expect(await link('a1-p7', bea, null)).toMatchObject({ status: 409 });
    expect(await link('a1-p7', null, bea)).toMatchObject({ status: 409 });
    expect(player('a1-p7')).toMatchObject({ person_id: ana });
    // Cambiar de persona a sabiendas: desvincula y vincula en el mismo lote.
    expect(await link('a1-p7', bea, ana)).toMatchObject({ status: 200 });
    expect(player('a1-p7')).toMatchObject({ person_id: bea });
    expect(audit().slice(-3).map((a) => a.action)).toEqual(['person.unlink', 'person.link', 'person.link']);
  });

  it('simultáneas: dos vínculos de la misma persona en un equipo a la vez, entra uno', async () => {
    const ana = await newPerson();
    const [one, two] = await Promise.all([link('a1-p7', ana, null), link('a1-p14', ana, null)]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(get("SELECT COUNT(*) AS n FROM players WHERE person_id = ? AND team_id = 'a1'", ana)).toEqual({ n: 1 });
    expect(audit().filter((a) => a.action === 'person.link' && a.target_type === 'player')).toHaveLength(1);
  });

  it('borrar una persona desvincula antes todas sus fichas, en un solo lote; fichas y acciones intactas', async () => {
    const ana = await newPerson();
    await link('a1-p7', ana, null);
    await link('a2-p7', ana, null);
    db.run("INSERT INTO matches (id, team_id, opponent, date, venue, season, status, half_minutes, clock_json, created_at, updated_at) VALUES ('m1', 'a1', 'Rival', '2026-10-25', 'home', '2026/27', 'finished', 30, '{}', ?, ?)", NOW, NOW);
    db.run("INSERT INTO events (id, match_id, team_id, player_id, kind, shot_type, result, period, match_time_ms, created_at, updated_at) VALUES ('e1', 'm1', 'a1', 'a1-p7', 'shot', 'nine_m', 'goal', 1, 1000, ?, ?)", NOW, NOW);
    const before = [player('a1-p7'), player('a2-p7')];
    expect(await call(`/api/admin/people/${ana}/delete`, { method: 'POST', body: { expectedVersion: 1 } })).toMatchObject({ status: 200, body: { unlinked: 2 } });
    expect([player('a1-p7'), player('a2-p7')]).toEqual(before.map((p) => ({ ...p, person_id: null })));
    expect(get("SELECT player_id, deleted_at FROM events WHERE id = 'e1'")).toEqual({ player_id: 'a1-p7', deleted_at: null });
    expect(audit().slice(-3).map((a) => `${a.action}:${a.target_type}`)).toEqual(['person.unlink:player', 'person.unlink:player', 'person.delete:person']);
  });
});

describe('exclusiones de los rankings del club', () => {
  it('excluir e incluir una ficha: auditado e invalida los rankings del club', async () => {
    const v0 = version();
    expect(await call('/api/admin/players/a1-p14/ranking', { method: 'PUT', body: { excluded: true } })).toMatchObject({ status: 200 });
    expect(player('a1-p14')).toMatchObject({ ranking_excluded: 1 });
    expect(version()).toBeGreaterThan(v0);
    // Repetir lo mismo no cambia nada ni deja auditoría.
    await call('/api/admin/players/a1-p14/ranking', { method: 'PUT', body: { excluded: true } });
    expect(await call('/api/admin/players/a1-p14/ranking', { method: 'PUT', body: { excluded: false } })).toMatchObject({ status: 200 });
    expect(audit().map((a) => a.action)).toEqual(['player.ranking_exclude', 'player.ranking_include']);
    expect(get("SELECT rankings_version FROM clubs WHERE id = 'B'")).toEqual({ rankings_version: 0 });
  });

  it('valida las entradas', async () => {
    expect((await call('/api/admin/players/a1-p7/ranking', { method: 'PUT', body: { excluded: 'no' } })).status).toBe(400);
    db.run("UPDATE players SET role = 'official', number = 0, position = 'field' WHERE id = 'a1-p69'");
    expect((await call('/api/admin/players/a1-p69/ranking', { method: 'PUT', body: { excluded: true } })).status).toBe(409);
  });
});

describe('rankings del club sin configuración', () => {
  it('las rutas antiguas de participación, grupos y visibilidad ya no existen: 404 sin cambios ni auditoría', async () => {
    const teams = () => all('SELECT id, club_rankings, ranking_group FROM teams ORDER BY id');
    const clubs = () => all('SELECT id, rankings_visibility, rankings_version FROM clubs ORDER BY id');
    const before = { teams: teams(), clubs: clubs() };
    const attempts: [string, string, unknown, boolean][] = [
      ['PATCH', '/api/admin/teams/a1/rankings', { participates: true, group: 'senior' }, false],
      ['PUT', '/api/admin/clubs/A/rankings', { visibility: 'admins' }, false],
      ['PUT', '/api/admin/critical/clubs/A/rankings', { visibility: 'members' }, true],
    ];
    for (const [method, path, body, critical] of attempts) {
      for (const email of [ADMIN_A, OWNER]) expect((await call(path, { method, body, email, critical })).status, `${method} ${path}`).toBe(404);
    }
    expect({ teams: teams(), clubs: clubs() }).toEqual(before);
    expect(audit()).toEqual([]);
  });

  it('las operaciones críticas existentes no cambian: siguen exigiendo el token reforzado', async () => {
    expect(await call('/api/admin/critical/clubs/A', { method: 'PATCH', body: { name: 'Club A' } })).toMatchObject({ status: 401, body: { error: 'reauth_required' } });
    expect(await call('/api/admin/critical/clubs/A', { method: 'PATCH', body: { name: 'Club A2' }, critical: true })).toMatchObject({ status: 200 });
    expect(await call('/api/admin/critical/clubs/A/status', { method: 'POST', body: { status: 'suspended' }, critical: true })).toMatchObject({ status: 403 });
  });
});

describe('autorización y aislamiento', () => {
  it('el administrador de un club no ve ni toca otro club (404); el superadministrador, ambos', async () => {
    const bea = await newPerson('Bea', 'B', ADMIN_B);
    expect((await call('/api/admin/clubs/B/people')).status).toBe(404);
    expect((await call('/api/admin/clubs/B/people', { method: 'POST', body: { displayName: 'X' } })).status).toBe(404);
    expect((await call(`/api/admin/people/${bea}`, { method: 'PATCH', body: { displayName: 'X', expectedVersion: 1 } })).status).toBe(404);
    expect((await call(`/api/admin/people/${bea}/delete`, { method: 'POST', body: { expectedVersion: 1 } })).status).toBe(404);
    expect((await link('b1-p7', bea, null)).status).toBe(404);
    expect((await call('/api/admin/players/b1-p7/ranking', { method: 'PUT', body: { excluded: true } })).status).toBe(404);
    expect((await call('/api/admin/clubs/B/rankings?season=2026%2F27')).status).toBe(404);
    expect(get("SELECT rankings_version FROM clubs WHERE id = 'B'")).toEqual({ rankings_version: 0 });
    expect(((await call('/api/admin/clubs/B/people', { email: OWNER })).body as unknown as ClubPeople).people).toHaveLength(1);
    expect((await link('b1-p7', bea, null, OWNER)).status).toBe(200);
  });

  it('sin Access, con un token de dispositivo o sin rol: rechazado', async () => {
    expect((await call('/api/admin/clubs/A/people', { email: null })).status).toBe(401);
    const { token } = await addDevice(db, 'coach', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    expect((await call('/api/admin/clubs/A/people', { email: null, headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect(await call('/api/admin/clubs/A/people', { email: 'desconocido@example.com' })).toMatchObject({ status: 403, body: { error: 'not_admin' } });
    // Por la API de dispositivos no existe ninguna ruta de personas.
    const res = await worker.fetch(new Request('https://api.example/api/clubs/A/people', { headers: { Authorization: `Bearer ${token}` } }), env);
    expect(res.status).toBe(404);
  });

  it('un club suspendido solo lo gestiona el superadministrador', async () => {
    db.run("UPDATE clubs SET status = 'suspended' WHERE id = 'A'");
    expect((await call('/api/admin/clubs/A/people')).status).toBe(404);
    expect((await call('/api/admin/clubs/A/people', { email: OWNER })).status).toBe(200);
  });

  it('escrituras solo desde el propio origen y en JSON (las mismas protecciones que el resto)', async () => {
    expect((await call('/api/admin/clubs/A/people', { method: 'POST', body: { displayName: 'X' }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await call('/api/admin/clubs/A/people', { method: 'POST', body: { displayName: 'X' }, headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect(get('SELECT COUNT(*) AS n FROM people')).toEqual({ n: 0 });
  });

  it('no son operaciones críticas; las críticas siguen exigiendo su verificación', async () => {
    expect((await call('/api/admin/clubs/A/people', { method: 'POST', body: { displayName: 'Ana' } })).status).toBe(201);
    expect(await call('/api/admin/critical/teams/a1', { method: 'PATCH', body: { name: 'Otro' } })).toMatchObject({ status: 401, body: { error: 'reauth_required' } });
  });
});

describe('crear persona con dos fichas (todo o nada)', () => {
  const pair = (playerIds: unknown, displayName: unknown = 'Ana García', email = ADMIN_A) =>
    call('/api/admin/clubs/A/people/pair', { method: 'POST', body: { displayName, playerIds }, email });
  const nothing = (auditBefore: number) => {
    expect(get('SELECT COUNT(*) AS n FROM people')).toEqual({ n: 0 });
    expect(get('SELECT COUNT(*) AS n FROM players WHERE person_id IS NOT NULL')).toEqual({ n: 0 });
    expect(audit()).toHaveLength(auditBefore);
  };
  const adminA = () => adminContext(db, { email: ADMIN_A, sub: `sub-${ADMIN_A}`, iat: 0, exp: 0, critical: false });

  it('crea la persona con las dos fichas: auditoría completa, fichas sin cambio de versión ni registro de cambios', async () => {
    const before = [player('a1-p7'), player('a2-p7')];
    const v0 = version();
    const r = await pair(['a1-p7', 'a2-p7'], '  Ana   García ');
    expect(r).toMatchObject({ status: 201, body: { personId: expect.any(String), version: 1 } });
    const id = r.body.personId as string;
    expect(get('SELECT display_name, version FROM people WHERE id = ?', id)).toEqual({ display_name: 'Ana García', version: 1 });
    expect([player('a1-p7'), player('a2-p7')]).toEqual(before.map((p) => ({ ...p, person_id: id })));
    expect(get('SELECT COUNT(*) AS n FROM change_log')).toEqual({ n: 0 });
    expect(version()).toBeGreaterThan(v0);
    expect(audit().map((x) => `${x.action}:${x.target_type}:${x.target_id === id ? 'persona' : x.target_id}`)).toEqual([
      'person.create:person:persona',
      'person.link:player:a1-p7',
      'person.link:person:persona',
      'person.link:player:a2-p7',
      'person.link:person:persona',
    ]);
  });

  it('rechaza sin dejar nada: mismo equipo, otro club, cuerpo técnico, borrada, ya vinculada, datos no válidos', async () => {
    expect(await pair(['a1-p7', 'a1-p14'])).toMatchObject({ status: 409, body: { message: expect.stringMatching(/mismo equipo/) } });
    expect(await pair(['a1-p7', 'b1-p7'])).toMatchObject({ status: 404 });
    expect(await pair(['a1-p7', 'b1-p7'], 'Ana', OWNER)).toMatchObject({ status: 404 });
    expect(await call('/api/admin/clubs/B/people/pair', { method: 'POST', body: { displayName: 'Ana', playerIds: ['b1-p7', 'b1-p14'] } })).toMatchObject({ status: 404 });
    db.run("UPDATE players SET role = 'official', number = 0, position = 'field' WHERE id = 'a2-p69'");
    expect(await pair(['a1-p7', 'a2-p69'])).toMatchObject({ status: 409 });
    db.run("UPDATE players SET deleted_at = ? WHERE id = 'a2-g1'", NOW);
    expect(await pair(['a1-p7', 'a2-g1'])).toMatchObject({ status: 404 });
    for (const ids of [['a1-p7'], ['a1-p7', 'a1-p7'], ['a1-p7', 7], 'a1-p7', ['a1-p7', 'a2-p7', 'a2-p14']]) expect((await pair(ids)).status).toBe(400);
    expect((await pair(['a1-p7', 'a2-p7'], '')).status).toBe(400);
    nothing(0);
    // Ya vinculada (con el vínculo de una ficha suelta): tampoco.
    const otra = await newPerson('Otra');
    await link('a2-p7', otra, null);
    const n = audit().length;
    expect(await pair(['a1-p7', 'a2-p7'])).toMatchObject({ status: 409 });
    expect(get('SELECT COUNT(*) AS n FROM people')).toEqual({ n: 1 });
    expect(player('a1-p7')).toMatchObject({ person_id: null });
    expect(audit()).toHaveLength(n);
  });

  it('una ficha vinculada entretanto (entre la comprobación y el lote): nada se crea ni se vincula', async () => {
    db.run("INSERT INTO people (id, club_id, display_name, created_at, updated_at) VALUES ('otra', 'A', 'Otra', ?, ?)", NOW, NOW);
    const racing = new Proxy(db, {
      get: (t, k) =>
        k === 'batch'
          ? async (statements: Statement[]) => {
              t.run("UPDATE players SET person_id = 'otra' WHERE id = 'a2-p7'");
              return t.batch(statements);
            }
          : Reflect.get(t, k, t),
    }) as unknown as Db;
    await expect(createPersonWithCards(racing, await adminA(), 'A', { displayName: 'Ana', playerIds: ['a1-p7', 'a2-p7'] })).rejects.toMatchObject({ status: 409 });
    expect(get('SELECT COUNT(*) AS n FROM people')).toEqual({ n: 1 });
    expect(player('a1-p7')).toMatchObject({ person_id: null });
    expect(player('a2-p7')).toMatchObject({ person_id: 'otra' });
    expect(audit()).toHaveLength(0);
  });

  it('si falla cualquier paso del lote, no queda ningún efecto (ni persona, ni vínculos, ni auditoría)', async () => {
    const auth = await adminA();
    // Ocho escrituras: persona, su auditoría y, por ficha, dos auditorías y el vínculo.
    for (let broken = 0; broken < 8; broken++) {
      const failing = new Proxy(db, {
        get: (t, k) =>
          k === 'batch'
            ? async (statements: Statement[]) => {
                expect(statements).toHaveLength(8);
                return t.batch(statements.map((s, i) => (i === broken ? t.prepare('INSERT INTO tabla_que_no_existe VALUES (1)') : s)));
              }
            : Reflect.get(t, k, t),
      }) as unknown as Db;
      await expect(createPersonWithCards(failing, auth, 'A', { displayName: 'Ana', playerIds: ['a1-p7', 'a2-p7'] }), `paso ${broken}`).rejects.toThrow();
      nothing(0);
    }
  });

  it('dos creaciones a la vez con la misma ficha: solo una persona', async () => {
    const [one, two] = await Promise.all([pair(['a1-p7', 'a2-p7'], 'Ana'), pair(['a1-p7', 'a2-p14'], 'Ana bis')]);
    expect([one.status, two.status].sort()).toEqual([201, 409]);
    expect(get('SELECT COUNT(*) AS n FROM people')).toEqual({ n: 1 });
    expect(get('SELECT COUNT(*) AS n FROM players WHERE person_id IS NOT NULL')).toEqual({ n: 2 });
  });

  it('las operaciones de siempre siguen igual sobre la persona creada; la sincronización también', async () => {
    const { auth: coach } = await addDevice(db, 'coach', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    const id = (await pair(['a1-p7', 'a2-p7'])).body.personId as string;
    // Quitar una ficha y añadir otra con los endpoints individuales.
    expect(await link('a2-p7', null, id)).toMatchObject({ status: 200 });
    expect(await link('a2-p14', id, null)).toMatchObject({ status: 200 });
    expect(await call(`/api/admin/people/${id}`, { method: 'PATCH', body: { displayName: 'Ana G.', expectedVersion: 1 } })).toMatchObject({ status: 200 });
    // Crear una persona sola sigue funcionando.
    expect((await call('/api/admin/clubs/A/people', { method: 'POST', body: { displayName: 'Sola' } })).status).toBe(201);
    const current = get<{ version: number }>("SELECT version FROM players WHERE id = 'a1-p7'");
    const p: Player = { id: 'a1-p7', teamId: 'a1', name: 'Siete renombrado', number: 7, position: 'field', active: true, createdAt: NOW, updatedAt: NOW };
    expect(await applyPlayerOp(db, coach, { opId: 'op-pair', teamId: 'a1', baseVersion: current.version, player: p })).toMatchObject({ status: 'applied' });
    expect(player('a1-p7')).toMatchObject({ person_id: id, name: 'Siete renombrado' });
    expect(JSON.stringify(await teamSnapshot(db, coach, 'a1'))).not.toMatch(/person|Ana G/);
  });
});

describe('compatibilidad con la sincronización', () => {
  it('una ficha vinculada se sincroniza igual; el vínculo se conserva y no aparece en la descarga', async () => {
    const { auth: coach } = await addDevice(db, 'coach', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    const ana = await newPerson();
    await link('a1-p7', ana, null);
    const v = version();
    const current = get<{ version: number }>("SELECT version FROM players WHERE id = 'a1-p7'");
    const p: Player = { id: 'a1-p7', teamId: 'a1', name: 'Siete renombrado', number: 7, position: 'field', active: true, createdAt: NOW, updatedAt: NOW };
    expect(await applyPlayerOp(db, coach, { opId: 'op-1', teamId: 'a1', baseVersion: current.version, player: p })).toMatchObject({ status: 'applied', version: current.version + 1 });
    expect(player('a1-p7')).toMatchObject({ person_id: ana, name: 'Siete renombrado' });
    expect(version()).toBe(v);
    const snap = await teamSnapshot(db, coach, 'a1');
    expect(JSON.stringify(snap)).not.toMatch(/person|ranking|Ana/);
    // Ni el entrenador ni la consulta ganan permisos sobre el otro equipo por el vínculo.
    await expect(teamSnapshot(db, coach, 'a2')).rejects.toMatchObject({ status: 404 });
  });
});
