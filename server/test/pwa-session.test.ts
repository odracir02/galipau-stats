// El cliente de la PWA (src/remote/api.ts) contra el Worker real, en memoria:
// comprueba que ambos lados hablan el mismo contrato. Códigos generados en la
// prueba; nunca los reales ni la base de datos de Preview.
import { beforeEach, describe, expect, it } from 'vitest';
import { ev, goal } from '../../src/test/fixtures';
import { createApi, RemoteError, type Api } from '../../src/remote/api';
import worker, { type Env } from '../src/index';
import { inviteStatements } from '../src/invites';
import { addMatch, CODE_KEY, PEPPER, secrets, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const APP = 'https://develop.galipau-stats.pages.dev';
let db: SqliteD1;
let env: Env;
let api: Api;
let codes: { coach: string; viewer: string };

async function issue(teamId: string, role: 'coach' | 'viewer'): Promise<string> {
  const { statements, invite } = await inviteStatements(
    db,
    { clubId: 'A', teamId, role, expiresAt: '2027-08-01T00:00:00.000Z', createdByDeviceId: null },
    await secrets(),
    new Date(),
  );
  await db.batch(statements);
  return invite.code;
}

async function errorKind(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RemoteError) return e.kind;
    throw e;
  }
  return 'sin error';
}

const count = (sql: string) => (db.sqlite.prepare(sql).get() as { n: number }).n;

beforeEach(async () => {
  db = migratedDb();
  twoClubs(db);
  addMatch(db, 'a1', {}, 'a1-');
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: APP };
  // fetch de la PWA → Worker, con la cabecera Origin del navegador.
  api = createApi({
    baseUrl: 'https://api.example',
    fetch: async (input, init) => {
      const req = new Request(input as string, init);
      req.headers.set('Origin', APP);
      return worker.fetch(req, env);
    },
  });
  codes = { coach: await issue('a1', 'coach'), viewer: await issue('a1', 'viewer') };
});

describe('PWA ↔ Worker: códigos y sesión', () => {
  it('canjear el código de entrenador crea el dispositivo y el servidor decide el rol', async () => {
    const r = await api.redeem(codes.coach, null, 'iPhone');
    expect(r).toMatchObject({ role: 'coach', team: { id: 'a1', code: 'SM2627', clubName: 'Club A' } });
    expect(typeof r.token).toBe('string');
    const session = await api.getSession(r.token!);
    expect(session.teams).toEqual([
      { teamId: 'a1', role: 'coach', status: 'active', name: 'Equipo a1', code: 'SM2627', season: '2026/27', clubId: 'A', clubName: 'Club A' },
    ]);
    expect(db.sqlite.prepare('SELECT label FROM devices').get()).toEqual({ label: 'iPhone' });
  });

  it('el código de consulta da acceso de solo lectura: el servidor rechaza escribir', async () => {
    const r = await api.redeem(codes.viewer, null, null);
    expect(r.role).toBe('viewer');
    const write = await worker.fetch(
      new Request('https://api.example/api/sync/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ opId: 'op-1', teamId: 'a1', baseVersion: null, event: ev(goal(), 'a1-p7', 3, { matchId: 'm1' }) }),
      }),
      env,
    );
    expect(write.status).toBe(403);
    expect(count('SELECT COUNT(*) AS n FROM events')).toBe(0);
  });

  it('con la credencial guardada, otro código se añade al mismo dispositivo y nunca rebaja el rol', async () => {
    const coach = await api.redeem(codes.coach, null, null);
    const again = await api.redeem(codes.viewer, coach.token!, null);
    expect(again).toMatchObject({ deviceId: coach.deviceId, role: 'coach' });
    expect(again.token).toBeUndefined();
    expect(count('SELECT COUNT(*) AS n FROM devices')).toBe(1);
  });

  it('código inventado, caducado o revocado: el mismo error, sin detalles', async () => {
    expect(await errorKind(api.redeem('ZZZZ-ZZZZ-ZZZZ', null, null))).toBe('invalid_code');
    db.run("UPDATE invites SET revoked_at = '2026-01-01T00:00:00.000Z' WHERE role = 'viewer'");
    expect(await errorKind(api.redeem(codes.viewer, null, null))).toBe('invalid_code');
    db.run("UPDATE invites SET expires_at = '2026-01-01T00:00:00.000Z' WHERE role = 'coach'");
    expect(await errorKind(api.redeem(codes.coach, null, null))).toBe('invalid_code');
    expect(count('SELECT COUNT(*) AS n FROM devices')).toBe(0);
  });

  it('salir del equipo y cerrar sesión: después la credencial ya no vale', async () => {
    const r = await api.redeem(codes.coach, null, null);
    await api.leaveTeam(r.token!, 'a1');
    expect((await api.getSession(r.token!)).teams).toEqual([]);
    await api.logout(r.token!);
    expect(await errorKind(api.getSession(r.token!))).toBe('unauthorized');
    expect(await errorKind(api.getSession('inventado'))).toBe('unauthorized');
  });

  it('demasiados intentos: rate_limited', async () => {
    for (let i = 0; i < 10; i++) await errorKind(api.redeem('ZZZZ-ZZZZ-ZZZZ', null, null));
    expect(await errorKind(api.redeem(codes.coach, null, null))).toBe('rate_limited');
  });

  it('el canje no crea ni modifica jugadores, partidos ni acciones', async () => {
    const before = ['players', 'matches', 'match_squad', 'events'].map((t) => count(`SELECT COUNT(*) AS n FROM ${t}`));
    const r = await api.redeem(codes.coach, null, null);
    await api.getSession(r.token!);
    expect(['players', 'matches', 'match_squad', 'events'].map((t) => count(`SELECT COUNT(*) AS n FROM ${t}`))).toEqual(before);
  });
});
