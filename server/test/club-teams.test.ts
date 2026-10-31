// Un club con varios equipos (los cuatro sénior de referencia, solo en memoria):
// cada código da acceso únicamente a su equipo y nunca a la administración.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMatch } from '../../src/test/fixtures';
import { buildBootstrapSql } from '../scripts/bootstrap-superadmin.mjs';
import { clearJwksCache } from '../src/access';
import worker, { type Env } from '../src/index';
import { ACCESS_ENV, claimsFor, CONFIG, makeIssuer, serveJwks, type Issuer } from './accessKeys';
import { CODE_KEY, NOW, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const API = 'https://api.example';
const OWNER = 'propietario@example.com';
let db: SqliteD1;
let env: Env;
let issuer: Issuer;

beforeEach(async () => {
  db = migratedDb();
  db.sqlite.exec(buildBootstrapSql({ identityId: 'owner', email: OWNER }));
  issuer = await makeIssuer();
  serveJwks(() => [issuer.jwk]);
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://app.example', ...ACCESS_ENV };
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearJwksCache();
});

async function call(path: string, { method = 'GET', token, body, access }: { method?: string; token?: string; body?: unknown; access?: { email: string; critical?: boolean } } = {}) {
  const h = new Headers({ 'Sec-Fetch-Site': 'same-origin', Origin: API });
  if (token) h.set('Authorization', `Bearer ${token}`);
  if (access) h.set('Cf-Access-Jwt-Assertion', await issuer.sign(claimsFor(access.email, { aud: access.critical ? CONFIG.criticalAud : CONFIG.adminAud })));
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request(`${API}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* sin cuerpo JSON */
  }
  return { status: res.status, body: json, text };
}
const owner = (path: string, opts: { method?: string; body?: unknown; critical?: boolean } = {}) =>
  call(path, { ...opts, access: { email: OWNER, critical: opts.critical } });

const TEAMS = [
  { name: 'Senior Masculino A', code: 'SMA2627', gender: 'male' },
  { name: 'Senior Masculino B', code: 'SMB2627', gender: 'male' },
  { name: 'Senior Femenino A', code: 'SFA2627', gender: 'female' },
  { name: 'Senior Femenino B', code: 'SFB2627', gender: 'female' },
];

/** Club con el Senior Masculino A ya en uso y los otros tres dados de alta después. */
async function burjassot() {
  const club = await owner('/api/admin/critical/clubs', { critical: true, method: 'POST', body: { name: 'Club Balonmano Burjassot', shortName: 'BM Burjassot' } });
  const clubId = club.body.clubId as string;
  const teams: Record<string, { id: string; coach: string; viewer: string }> = {};
  const add = async (t: (typeof TEAMS)[number]) => {
    const res = await owner(`/api/admin/critical/clubs/${clubId}/teams`, { critical: true, method: 'POST', body: { ...t, season: '2026/27', category: 'Senior' } });
    expect(res.status, t.code).toBe(201);
    const codes = res.body.codes as Record<'coach' | 'viewer', { code: string }>;
    teams[t.code] = { id: res.body.teamId as string, coach: codes.coach.code, viewer: codes.viewer.code };
  };
  await add(TEAMS[0]!);
  // El primer equipo ya tiene plantilla y un partido.
  const sma = await redeem(teams.SMA2627!.coach);
  const player = { id: 'p7', teamId: teams.SMA2627!.id, name: 'Jugador 7', number: 7, position: 'field', active: true, createdAt: NOW, updatedAt: NOW };
  expect((await call('/api/sync/players', { method: 'POST', token: sma, body: { opId: 'sma-p', teamId: teams.SMA2627!.id, baseVersion: null, player } })).status).toBe(200);
  const match = makeMatch({ id: 'sma-m1', teamId: teams.SMA2627!.id, status: 'finished', squad: [{ playerId: 'p7', name: 'Jugador 7', number: 7, position: 'field' }] });
  expect((await call('/api/sync/matches', { method: 'POST', token: sma, body: { opId: 'sma-m', teamId: teams.SMA2627!.id, baseVersion: null, match } })).status).toBe(200);
  const before = snapshotOf(teams.SMA2627!.id);
  for (const t of TEAMS.slice(1)) await add(t);
  return { clubId, teams, smaBefore: before };
}

async function redeem(code: string) {
  const res = await call('/api/invites/redeem', { method: 'POST', body: { code } });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

const snapshotOf = (teamId: string) =>
  JSON.stringify({
    players: db.sqlite.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY id').all(teamId),
    matches: db.sqlite.prepare('SELECT * FROM matches WHERE team_id = ? ORDER BY id').all(teamId),
    team: db.sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(teamId),
  });

describe('club con cuatro equipos sénior', () => {
  it('altas: cuatro equipos, temporada y categoría correctas, ocho códigos distintos y ninguno igual al identificador', async () => {
    const { clubId, teams, smaBefore } = await burjassot();
    const detail = await owner(`/api/admin/clubs/${clubId}`);
    const listed = detail.body.teams as { code: string; season: string; category: string; codes: { coach: boolean; viewer: boolean } }[];
    expect(listed.map((t) => t.code).sort()).toEqual(['SFA2627', 'SFB2627', 'SMA2627', 'SMB2627']);
    expect(listed.every((t) => t.season === '2026/27' && t.category === 'Senior' && t.codes.coach && t.codes.viewer)).toBe(true);
    const all = Object.values(teams).flatMap((t) => [t.coach, t.viewer]);
    expect(new Set(all).size).toBe(8);
    for (const t of TEAMS) expect(all).not.toContain(t.code);
    // El identificador del equipo no es un código de invitación.
    for (const t of TEAMS) expect((await call('/api/invites/redeem', { method: 'POST', body: { code: t.code } })).status).toBe(404);
    // Dar de alta los otros tres no toca el primero; un identificador repetido no crea un duplicado.
    expect(snapshotOf(teams.SMA2627!.id)).toBe(smaBefore);
    expect((await owner(`/api/admin/critical/clubs/${clubId}/teams`, { critical: true, method: 'POST', body: { name: 'Otro', code: 'SMB2627', season: '2026/27' } })).status).toBe(409);
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM teams').get()).toEqual({ n: 4 });
    // Los nuevos empiezan vacíos.
    for (const code of ['SMB2627', 'SFA2627', 'SFB2627']) {
      const snap = await call(`/api/teams/${teams[code]!.id}/snapshot`, { token: await redeem(teams[code]!.viewer) });
      expect(snap.body, code).toMatchObject({ players: [], matches: [] });
    }
  });

  it('el entrenador gestiona solo su equipo; ningún código da acceso a otro equipo del mismo club', async () => {
    const { teams, smaBefore } = await burjassot();
    for (const own of TEAMS) {
      const team = teams[own.code]!;
      const coach = await redeem(team.coach);
      const session = await call('/api/session', { token: coach });
      expect((session.body.teams as { teamId: string; role: string }[]).map((t) => [t.teamId, t.role])).toEqual([[team.id, 'coach']]);
      // Su equipo: plantilla y partido nuevos.
      const player = { id: `${own.code}-p1`, teamId: team.id, name: 'Jugador 1', number: 1, position: 'goalkeeper', active: true, createdAt: NOW, updatedAt: NOW };
      expect((await call('/api/sync/players', { method: 'POST', token: coach, body: { opId: `${own.code}-op1`, teamId: team.id, baseVersion: null, player } })).status).toBe(200);
      const match = makeMatch({ id: `${own.code}-m1`, teamId: team.id, status: 'ready', squad: [{ playerId: player.id, name: 'Jugador 1', number: 1, position: 'goalkeeper' }] });
      expect((await call('/api/sync/matches', { method: 'POST', token: coach, body: { opId: `${own.code}-op2`, teamId: team.id, baseVersion: null, match } })).status).toBe(200);
      // Los otros tres equipos del club: ni leer ni escribir.
      for (const other of TEAMS.filter((t) => t.code !== own.code)) {
        const id = teams[other.code]!.id;
        for (const path of [`/api/teams/${id}`, `/api/teams/${id}/snapshot`, `/api/teams/${id}/codes`, `/api/teams/${id}/changes?since=0`]) {
          expect((await call(path, { token: coach })).status, `${own.code} → ${path}`).toBe(404);
        }
        const intruder = { ...player, id: `${own.code}-x-${other.code}`, teamId: id };
        expect((await call('/api/sync/players', { method: 'POST', token: coach, body: { opId: `${own.code}-x-${other.code}`, teamId: id, baseVersion: null, player: intruder } })).status).toBe(404);
        // Ni declarando su propio equipo con datos de otro.
        const mixed = await call('/api/sync/players', { method: 'POST', token: coach, body: { opId: `${own.code}-y-${other.code}`, teamId: team.id, baseVersion: null, player: intruder } });
        expect(mixed.status).toBeGreaterThanOrEqual(400);
      }
    }
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM players WHERE id LIKE '%-x-%' OR id LIKE '%-y-%'").get()).toEqual({ n: 0 });
    // El Senior Masculino A solo cambió por su propio entrenador.
    const sma = teams.SMA2627!.id;
    expect(db.sqlite.prepare('SELECT DISTINCT team_id AS t FROM players WHERE id LIKE ?').all('SMA2627-%')).toEqual([{ t: sma }]);
    expect(smaBefore).not.toBe(snapshotOf(sma));
  });

  it('el código de consulta lee su equipo y nunca modifica nada', async () => {
    const { teams } = await burjassot();
    for (const own of TEAMS) {
      const team = teams[own.code]!;
      const viewer = await redeem(team.viewer);
      expect((await call(`/api/teams/${team.id}/snapshot`, { token: viewer })).status).toBe(200);
      const codes = await call(`/api/teams/${team.id}/codes`, { token: viewer });
      expect(codes.body).not.toHaveProperty('coach');
      expect(codes.text).not.toContain(team.coach);
      const player = { id: `${own.code}-v`, teamId: team.id, name: 'Intento', number: 99, position: 'field', active: true, createdAt: NOW, updatedAt: NOW };
      expect((await call('/api/sync/players', { method: 'POST', token: viewer, body: { opId: `${own.code}-v1`, teamId: team.id, baseVersion: null, player } })).status).toBe(403);
      const match = makeMatch({ id: `${own.code}-vm`, teamId: team.id, squad: [] });
      expect((await call('/api/sync/matches', { method: 'POST', token: viewer, body: { opId: `${own.code}-v2`, teamId: team.id, baseVersion: null, match } })).status).toBe(403);
      for (const other of TEAMS.filter((t) => t.code !== own.code)) {
        expect((await call(`/api/teams/${teams[other.code]!.id}/snapshot`, { token: viewer })).status).toBe(404);
      }
    }
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM players WHERE id LIKE '%-v'").get()).toEqual({ n: 0 });
  });

  it('ningún código da privilegios administrativos; el superadministrador conserva los suyos', async () => {
    const { clubId, teams } = await burjassot();
    for (const own of TEAMS) {
      for (const code of [teams[own.code]!.coach, teams[own.code]!.viewer]) {
        const token = await redeem(code);
        // Un token de dispositivo no sirve en la administración, ni para leer ni para escribir.
        expect((await call('/api/admin/me', { token })).status).toBe(401);
        expect((await call(`/api/admin/clubs/${clubId}`, { token })).status).toBe(401);
        expect((await call(`/api/admin/critical/clubs/${clubId}/teams`, { token, method: 'POST', body: { name: 'X', code: 'X2627', season: '2026/27' } })).status).toBe(401);
        // Ni puede regenerar ni revocar códigos.
        expect((await call(`/api/admin/critical/teams/${teams[own.code]!.id}/codes/viewer/regenerate`, { token, method: 'POST', body: {} })).status).toBe(401);
      }
    }
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM admin_roles').get()).toEqual({ n: 1 });
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM teams').get()).toEqual({ n: 4 });
    // El superadministrador sigue viendo y gestionando todo.
    expect((await owner('/api/admin/me')).status).toBe(200);
    for (const own of TEAMS) {
      const codes = await owner(`/api/admin/teams/${teams[own.code]!.id}/codes`);
      expect(codes.body).toMatchObject({ teamCode: own.code, coach: { code: teams[own.code]!.coach }, viewer: { code: teams[own.code]!.viewer } });
    }
    expect((await owner(`/api/admin/critical/teams/${teams.SFB2627!.id}`, { critical: true, method: 'PATCH', body: { name: 'Senior Femenino B', category: 'Senior', gender: 'female' } })).status).toBe(200);
  });
});
