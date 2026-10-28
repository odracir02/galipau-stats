// Un club eliminado (borrado lógico) deja inaccesibles todos sus equipos, por
// cualquier vía: dispositivos, administradores, sincronización e invitaciones.
import { beforeEach, describe, expect, it } from 'vitest';
import { ev, goal } from '../../src/test/fixtures';
import { authorize } from '../src/auth';
import { HttpError } from '../src/errors';
import worker from '../src/index';
import { createInvite, redeemInvite, revokeTeamAccess } from '../src/invites';
import type { AuthContext } from '../src/model';
import { applyEventOp, pullChanges } from '../src/sync';
import { addAdmin, addDevice, addMatch, NOW, PEPPER, twoClubs, secrets } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

let db: SqliteD1;
let coachA: { token: string; auth: AuthContext };
let viewerB: { token: string; auth: AuthContext };
let n = 0;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof HttpError) return `${e.status} ${e.code}`;
    throw e;
  }
}

const deleteClub = (id: string) => db.run('UPDATE clubs SET deleted_at = ? WHERE id = ?', NOW, id);

beforeEach(async () => {
  db = migratedDb();
  twoClubs(db);
  addMatch(db, 'a1', {}, 'a1-');
  coachA = await addDevice(db, 'coach-a', [
    { clubId: 'A', teamId: 'a1', role: 'coach' },
    { clubId: 'A', teamId: 'a2', role: 'viewer' },
  ]);
  viewerB = await addDevice(db, 'viewer-b', [{ clubId: 'B', teamId: 'b1', role: 'viewer' }]);
});

describe('club activo', () => {
  it('sus equipos son accesibles con normalidad', async () => {
    expect(await codeOf(authorize(db, coachA.auth, 'a1', 'match.write'))).toBe('ok');
    expect(await codeOf(authorize(db, viewerB.auth, 'b1', 'team.read'))).toBe('ok');
  });
});

describe('club eliminado', () => {
  it('ningún rol accede a sus equipos (404, como si no existieran)', async () => {
    const ca = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    const sa = await addAdmin(db, 'sa', [{ role: 'superadmin', clubId: null }]);
    deleteClub('A');
    for (const auth of [coachA.auth, ca.auth, sa.auth]) {
      for (const team of ['a1', 'a2']) {
        expect(await codeOf(authorize(db, auth, team, 'team.read'))).toBe('404 not_found');
        expect(await codeOf(authorize(db, auth, team, 'match.write'))).toBe('404 not_found');
      }
    }
  });

  it('no afecta a otros clubes', async () => {
    deleteClub('A');
    expect(await codeOf(authorize(db, viewerB.auth, 'b1', 'team.read'))).toBe('ok');
  });

  it('se cortan la sincronización y la descarga de cambios', async () => {
    deleteClub('A');
    const op = { opId: `op-${++n}`, teamId: 'a1', baseVersion: null, event: ev(goal(), 'a1-p7', 3, { matchId: 'm1' }) };
    expect(await codeOf(applyEventOp(db, coachA.auth, op))).toBe('404 not_found');
    expect(await codeOf(pullChanges(db, coachA.auth, 'a1', 0))).toBe('404 not_found');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
  });

  it('se cortan las rutas HTTP de dispositivos', async () => {
    deleteClub('A');
    const env = { DB: db, TOKEN_PEPPER: PEPPER, ENVIRONMENT: 'test', ALLOWED_ORIGINS: '' };
    const res = await worker.fetch(new Request('https://api.example/api/teams/a1', { headers: { Authorization: `Bearer ${coachA.token}` } }), env);
    expect(res.status).toBe(404);
  });

  it('las invitaciones de sus equipos dejan de canjearse y no se pueden crear ni gestionar', async () => {
    const ca = await addAdmin(db, 'ca', [{ role: 'club_admin', clubId: 'A' }]);
    const inv = await createInvite(db, ca.auth, { teamId: 'a1', role: 'viewer' }, await secrets());
    deleteClub('A');
    expect(await codeOf(redeemInvite(db, { code: inv.code, clientKey: `198.51.100.${++n}` }, PEPPER))).toBe('404 invalid_code');
    expect(await codeOf(createInvite(db, ca.auth, { teamId: 'a1', role: 'viewer' }, await secrets()))).toBe('404 not_found');
    expect(await codeOf(revokeTeamAccess(db, ca.auth, 'a1', 'coach-a'))).toBe('404 not_found');
  });

  it('los datos se conservan (borrado lógico): no se elimina nada', async () => {
    deleteClub('A');
    const count = (t: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect([count('teams'), count('players'), count('matches'), count('grants')]).toEqual([3, 15, 1, 3]);
  });
});

describe('equipo eliminado en un club activo', () => {
  it('ese equipo no es accesible; los demás del club sí', async () => {
    db.run("UPDATE teams SET deleted_at = ? WHERE id = 'a1'", NOW);
    expect(await codeOf(authorize(db, coachA.auth, 'a1', 'team.read'))).toBe('404 not_found');
    expect(await codeOf(authorize(db, coachA.auth, 'a2', 'team.read'))).toBe('ok');
  });
});
