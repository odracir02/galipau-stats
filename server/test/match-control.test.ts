// Control de registro de los partidos entre entrenadores (control.ts): un
// partido activo lo escribe un solo dispositivo; cualquier entrenador del
// equipo puede tomar el control; los finalizados los corrige cualquiera con la
// versión correcta. Datos sintéticos.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Match, MatchEvent } from '../../src/domain/types';
import { ev, goal, makeMatch, SQUAD } from '../../src/test/fixtures';
import { authenticate } from '../src/auth';
import { takeControl, type ControlOp } from '../src/control';
import type { Db } from '../src/db';
import { HttpError } from '../src/errors';
import worker, { type Env } from '../src/index';
import type { AuthContext } from '../src/model';
import { leaveTeam, logout } from '../src/session';
import { applyEventOp, type EventOp } from '../src/sync';
import { applyMatchOp, teamSnapshot, type MatchOp } from '../src/teamsync';
import { addDevice, CODE_KEY, PEPPER, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

let db: SqliteD1;
let a: AuthContext;
let b: AuthContext;
let tokens: Record<string, string>;
let seq = 0;

const squad = SQUAD.map((s) => ({ ...s, playerId: `a1-${s.playerId}` }));
const match = (o: Partial<Match> = {}): Match => makeMatch({ id: 'm1', teamId: 'a1', squad, ...o });
const mOp = (m: Match, baseVersion: number | null = null, teamId = 'a1'): MatchOp => ({ opId: `op-${++seq}`, teamId, baseVersion, match: m });
const eOp = (e: MatchEvent, baseVersion: number | null = null, teamId = 'a1'): EventOp => ({ opId: `op-${++seq}`, teamId, baseVersion, event: e });
const action = (player = 'p7', o: Partial<MatchEvent> = {}) => ev(goal(), `a1-${player}`, 3, { matchId: 'm1', ...o });
const cOp = (expectedEpoch: number, o: Partial<ControlOp> = {}): ControlOp => ({ opId: `ctl-${++seq}`, teamId: 'a1', matchId: 'm1', expectedEpoch, ...o });

async function errorOf(p: Promise<unknown>): Promise<{ status: number; code: string; details?: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, code: e.code, details: e.details };
    throw e;
  }
  throw new Error('Se esperaba un error');
}

const row = () =>
  db.sqlite.prepare('SELECT status, version, control_device_id AS holder, control_epoch AS epoch FROM matches WHERE id = ?').get('m1') as {
    status: string;
    version: number;
    holder: string | null;
    epoch: number;
  };
const count = (sql: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n;
const fresh = (id: string) => authenticate(db, tokens[id]!, PEPPER);

/** Partido en curso registrado por A, con una acción. */
async function startedByA(): Promise<MatchEvent> {
  await applyMatchOp(db, a, mOp(match()));
  const e = action();
  await applyEventOp(db, a, eOp(e));
  return e;
}

/** Base que, justo antes de la siguiente transacción, deja que otra petición cambie el control. */
function racing(cut: () => void): Db {
  let done = false;
  return {
    prepare: (q) => db.prepare(q),
    batch: async (statements) => {
      if (!done) {
        done = true;
        cut();
      }
      return db.batch(statements);
    },
  };
}

beforeEach(async () => {
  db = migratedDb();
  twoClubs(db);
  tokens = {};
  const add = async (id: string, grants: { clubId: string; teamId: string; role: string }[]) => {
    const d = await addDevice(db, id, grants);
    tokens[id] = d.token;
    return d.auth;
  };
  a = await add('entrenador-a', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
  b = await add('entrenador-b', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
  await add('familia', [{ clubId: 'A', teamId: 'a1', role: 'viewer' }]);
  await add('otro-equipo', [{ clubId: 'A', teamId: 'a2', role: 'coach' }]);
  await add('otro-club', [{ clubId: 'B', teamId: 'b1', role: 'coach' }]);
});

describe('control de un partido', () => {
  it('iniciar da el control; finalizar lo libera; preparado y finalizado no tienen dueño', async () => {
    await applyMatchOp(db, a, mOp(match({ status: 'ready' })));
    expect(row()).toMatchObject({ holder: null, epoch: 0 });
    // Un partido preparado lo puede editar cualquier entrenador.
    await applyMatchOp(db, b, mOp(match({ status: 'ready', opponent: 'Cambio de B' }), 1));
    // Quien lo inicia toma el control.
    await applyMatchOp(db, a, mOp(match({ status: 'in_progress', opponent: 'Cambio de B' }), 2));
    expect(row()).toMatchObject({ status: 'in_progress', holder: 'entrenador-a', epoch: 1 });
    expect(await errorOf(applyEventOp(db, b, eOp(action())))).toMatchObject({ status: 409, code: 'match_recorded_elsewhere' });
    // El descanso mantiene el control.
    await applyMatchOp(db, a, mOp(match({ status: 'halftime', opponent: 'Cambio de B' }), 3));
    expect(row()).toMatchObject({ holder: 'entrenador-a', epoch: 1 });
    await applyMatchOp(db, a, mOp(match({ status: 'finished', opponent: 'Cambio de B', finishedAt: '2026-10-31T20:00:00.000Z' }), 4));
    expect(row()).toMatchObject({ status: 'finished', holder: null, epoch: 2 });
    // Finalizado: B lo corrige con la versión correcta.
    expect(await applyEventOp(db, b, eOp(action('p69')))).toMatchObject({ status: 'applied' });
    expect(row().holder).toBeNull();
  });

  it('el bloqueo es por partido: otro partido del mismo equipo lo registra otro entrenador a la vez', async () => {
    await startedByA();
    await applyMatchOp(db, b, mOp(match({ id: 'm2' })));
    expect(await applyEventOp(db, b, eOp(action('p7', { matchId: 'm2' })))).toMatchObject({ status: 'applied' });
    expect(await errorOf(applyEventOp(db, a, eOp(action('p69', { matchId: 'm2' }))))).toMatchObject({ code: 'match_recorded_elsewhere' });
  });
});

describe('tomar el control', () => {
  it('B lo toma con confirmación; A pierde al instante el permiso de escritura', async () => {
    const e = await startedByA();
    const r = await takeControl(db, b, cOp(1));
    expect(r).toEqual({ status: 'applied', entityId: 'm1', epoch: 2 });
    expect(row()).toMatchObject({ holder: 'entrenador-b', epoch: 2, version: 1 }); // el contenido no cambia
    // A intenta enviar acciones nuevas, editar una antigua y finalizar: todo rechazado.
    expect(await errorOf(applyEventOp(db, a, eOp(action('p69'))))).toMatchObject({ code: 'match_recorded_elsewhere' });
    expect(await errorOf(applyEventOp(db, a, eOp({ ...e, matchTimeMs: 1 }, 1)))).toMatchObject({ code: 'match_recorded_elsewhere' });
    expect(await errorOf(applyMatchOp(db, a, mOp(match({ status: 'finished', finishedAt: '2026-10-31T20:00:00.000Z' }), 1)))).toMatchObject({
      code: 'match_recorded_elsewhere',
    });
    expect(count('events')).toBe(1);
    expect(row()).toMatchObject({ status: 'in_progress', holder: 'entrenador-b' });
    // B sigue registrando.
    expect(await applyEventOp(db, b, eOp(action('p69')))).toMatchObject({ status: 'applied' });
    // Se registra para auditoría y los demás lo ven en sus cambios.
    expect(db.sqlite.prepare('SELECT from_device_id, to_device_id, epoch FROM match_control_log').all()).toEqual([
      { from_device_id: 'entrenador-a', to_device_id: 'entrenador-b', epoch: 2 },
    ]);
  });

  it('A y B piden el control a la vez: solo uno lo consigue y el otro recibe el estado nuevo', async () => {
    await startedByA();
    const c = (await addDevice(db, 'entrenador-c', [{ clubId: 'A', teamId: 'a1', role: 'coach' }])).auth;
    const results = await Promise.allSettled([takeControl(db, b, cOp(1)), takeControl(db, c, cOp(1))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409, code: 'control_changed', details: { control: { holder: 'other', epoch: 2 } } });
    expect(row().epoch).toBe(2);
    expect(count('match_control_log')).toBe(1);
  });

  it('el cambio de control entre la lectura y la escritura nunca deja pasar la transferencia antigua', async () => {
    await startedByA();
    const c = (await addDevice(db, 'entrenador-c', [{ clubId: 'A', teamId: 'a1', role: 'coach' }])).auth;
    const cut = () => db.run("UPDATE matches SET control_device_id = 'entrenador-c', control_epoch = 2, control_since = ? WHERE id = 'm1'", new Date().toISOString());
    expect(await errorOf(takeControl(racing(cut), b, cOp(1)))).toMatchObject({ code: 'control_changed' });
    expect(row()).toMatchObject({ holder: 'entrenador-c', epoch: 2 });
    expect(count('match_control_log')).toBe(0);
    expect(c.deviceId).toBe('entrenador-c');
  });

  it('una acción de A que llega justo cuando B toma el control no se escribe', async () => {
    await startedByA();
    const cut = () => db.run("UPDATE matches SET control_device_id = 'entrenador-b', control_epoch = 2, control_since = ? WHERE id = 'm1'", new Date().toISOString());
    expect(await errorOf(applyEventOp(racing(cut), a, eOp(action('p69'))))).toMatchObject({ code: 'match_recorded_elsewhere' });
    expect(count('events')).toBe(1);
    expect(count("sync_ops WHERE entity = 'event'")).toBe(1);
  });

  it('un cambio del partido de A que llega justo cuando B toma el control no se escribe', async () => {
    await startedByA();
    const cut = () => db.run("UPDATE matches SET control_device_id = 'entrenador-b', control_epoch = 2, control_since = ? WHERE id = 'm1'", new Date().toISOString());
    expect(await errorOf(applyMatchOp(racing(cut), a, mOp(match({ opponent: 'Tarde' }), 1)))).toMatchObject({ code: 'match_recorded_elsewhere' });
    expect(row()).toMatchObject({ version: 1, holder: 'entrenador-b' });
    expect(count("matches WHERE opponent = 'Tarde'")).toBe(0);
  });

  it('A sin conexión: B toma el control y registra; al reconectar, lo pendiente de A se rechaza sin tocar nada', async () => {
    const e = await startedByA();
    await takeControl(db, b, cOp(1));
    const fromB = action('p69');
    await applyEventOp(db, b, eOp(fromB));
    const before = db.sqlite.prepare('SELECT * FROM events ORDER BY id').all();
    // Cola de A al volver: varias acciones, una corrección y el cronómetro.
    for (const op of [eOp(action('p14')), eOp(action('p7')), eOp({ ...e, playerId: 'a1-p69' }, 1)]) {
      expect(await errorOf(applyEventOp(db, a, op))).toMatchObject({ code: 'match_recorded_elsewhere' });
    }
    expect(await errorOf(applyMatchOp(db, a, mOp(match({ status: 'halftime' }), 1)))).toMatchObject({ code: 'match_recorded_elsewhere' });
    expect(db.sqlite.prepare('SELECT * FROM events ORDER BY id').all()).toEqual(before);
    expect(row()).toMatchObject({ status: 'in_progress', version: 1 });
  });

  it('finalizado antes de la transferencia: no hay control que tomar', async () => {
    await startedByA();
    await applyMatchOp(db, a, mOp(match({ status: 'finished', finishedAt: '2026-10-31T20:00:00.000Z' }), 1));
    expect(row()).toMatchObject({ holder: null, epoch: 2 });
    expect(await errorOf(takeControl(db, b, cOp(1)))).toMatchObject({ status: 409, code: 'match_not_active' });
    expect(await errorOf(takeControl(db, b, cOp(2)))).toMatchObject({ code: 'match_not_active' });
  });

  it('finalizado justo durante la transferencia: la transferencia no se aplica', async () => {
    await startedByA();
    const cut = () =>
      db.run(
        "UPDATE matches SET status = 'finished', finished_at = '2026-10-31T20:00:00.000Z', control_device_id = NULL, control_epoch = 2 WHERE id = 'm1'",
      );
    expect(await errorOf(takeControl(racing(cut), b, cOp(1)))).toMatchObject({ code: 'match_not_active' });
    expect(row()).toMatchObject({ status: 'finished', holder: null });
  });

  it('transferido antes de finalizar: A no puede finalizarlo; B sí', async () => {
    await startedByA();
    await takeControl(db, b, cOp(1));
    const done = match({ status: 'finished', finishedAt: '2026-10-31T20:00:00.000Z' });
    expect(await errorOf(applyMatchOp(db, a, mOp(done, 1)))).toMatchObject({ code: 'match_recorded_elsewhere' });
    expect(await applyMatchOp(db, b, mOp(done, 1))).toMatchObject({ status: 'applied' });
    expect(row()).toMatchObject({ status: 'finished', holder: null });
  });

  it('reintento de la misma transferencia: una sola transferencia', async () => {
    await startedByA();
    const op = cOp(1);
    const first = await takeControl(db, b, op);
    const again = await takeControl(db, b, op);
    expect(again).toEqual(first);
    expect(row().epoch).toBe(2);
    expect(count('match_control_log')).toBe(1);
    expect(count("change_log WHERE entity = 'match'")).toBe(2); // alta del partido + transferencia
    // El mismo identificador desde otro dispositivo no vale.
    expect(await errorOf(takeControl(db, a, op))).toMatchObject({ code: 'op_id_reused' });
    // Quien ya lo tiene: sin cambios.
    expect(await takeControl(db, b, cOp(2))).toMatchObject({ status: 'duplicate', epoch: 2 });
  });

  it('sin control (p. ej. tras una retirada): el primero que escribe lo toma', async () => {
    await startedByA();
    db.run("UPDATE grants SET revoked_at = '2026-10-31T19:00:00.000Z' WHERE device_id = 'entrenador-a'");
    expect(await applyEventOp(db, b, eOp(action('p69')))).toMatchObject({ status: 'applied' });
    expect(row()).toMatchObject({ holder: 'entrenador-b', epoch: 2 });
  });
});

describe('dispositivos revocados', () => {
  it('permiso retirado: no retiene el control, ni lo recupera al volver a canjear un código', async () => {
    await startedByA();
    db.run("UPDATE grants SET revoked_at = '2026-10-31T19:00:00.000Z' WHERE device_id = 'entrenador-a'");
    expect((await teamSnapshot(db, b, 'a1')).matches[0]!.control).toMatchObject({ holder: null });
    // Vuelve a tener permiso (nuevo canje), pero no por eso recupera el control.
    db.run(
      "INSERT INTO grants (id, device_id, club_id, team_id, role, created_at) VALUES ('nuevo', 'entrenador-a', 'A', 'a1', 'coach', ?)",
      new Date(Date.now() + 1000).toISOString(),
    );
    const again = await fresh('entrenador-a');
    expect((await teamSnapshot(db, again, 'a1')).matches[0]!.control).toMatchObject({ holder: null });
    // Otro entrenador puede seguir registrando (toma el control al escribir).
    expect(await applyEventOp(db, b, eOp(action('p14')))).toMatchObject({ status: 'applied' });
    expect(row()).toMatchObject({ holder: 'entrenador-b' });
    expect(await errorOf(applyEventOp(db, again, eOp(action('p69'))))).toMatchObject({ code: 'match_recorded_elsewhere' });
  });

  it('cerrar sesión libera el control; el dispositivo ya no puede volver a tomarlo', async () => {
    await startedByA();
    await logout(db, a);
    expect(row()).toMatchObject({ holder: null, epoch: 2 });
    await expect(fresh('entrenador-a')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await takeControl(db, b, cOp(2))).toMatchObject({ status: 'applied' });
  });

  it('dejar el equipo libera el control de sus partidos', async () => {
    await startedByA();
    await leaveTeam(db, a, 'a1');
    expect(row()).toMatchObject({ holder: null });
    // Cada petición vuelve a leer los permisos: ya no tiene ninguno sobre el equipo.
    expect(await errorOf(takeControl(db, await fresh('entrenador-a'), cOp(2)))).toMatchObject({ status: 404 });
  });

  it('dispositivo revocado en el servidor sin cerrar sesión: no retiene el control', async () => {
    await startedByA();
    db.run("UPDATE devices SET revoked_at = '2026-10-31T19:00:00.000Z' WHERE id = 'entrenador-a'");
    expect((await teamSnapshot(db, b, 'a1')).matches[0]!.control).toMatchObject({ holder: null });
    expect(await takeControl(db, b, cOp(1))).toMatchObject({ status: 'applied' });
  });
});

describe('correcciones históricas', () => {
  it('dos dispositivos corrigen la misma acción: la segunda con versión antigua es conflicto', async () => {
    const e = await startedByA();
    await applyMatchOp(db, a, mOp(match({ status: 'finished', finishedAt: '2026-10-31T20:00:00.000Z' }), 1));
    expect(await applyEventOp(db, a, eOp({ ...e, playerId: 'a1-p69' }, 1))).toMatchObject({ status: 'applied', version: 2 });
    const err = await errorOf(applyEventOp(db, b, eOp({ ...e, playerId: 'a1-p14' }, 1)));
    expect(err).toMatchObject({ status: 409, code: 'conflict' });
    expect(db.sqlite.prepare('SELECT player_id, version FROM events').get()).toEqual({ player_id: 'a1-p69', version: 2 });
    // Con la versión del servidor, B sí puede.
    expect(await applyEventOp(db, b, eOp({ ...e, playerId: 'a1-p14' }, 2))).toMatchObject({ status: 'applied', version: 3 });
  });

  it('dos dispositivos corrigen el mismo partido finalizado: nunca se pisa una versión posterior', async () => {
    await applyMatchOp(db, a, mOp(match({ status: 'finished', finishedAt: '2026-10-31T20:00:00.000Z' })));
    await applyMatchOp(db, a, mOp(match({ status: 'finished', finishedAt: '2026-10-31T20:00:00.000Z', opponent: 'De A' }), 1));
    expect(await errorOf(applyMatchOp(db, b, mOp(match({ status: 'finished', finishedAt: '2026-10-31T20:00:00.000Z', opponent: 'De B' }), 1)))).toMatchObject({
      code: 'conflict',
    });
    expect(count("matches WHERE opponent = 'De A'")).toBe(1);
  });
});

describe('aislamiento y permisos', () => {
  it('otro equipo, otro club, consulta y administración sin dispositivo no pueden tomar el control', async () => {
    await startedByA();
    expect(await errorOf(takeControl(db, await fresh('otro-equipo'), cOp(1)))).toMatchObject({ status: 404 });
    expect(await errorOf(takeControl(db, await fresh('otro-club'), cOp(1)))).toMatchObject({ status: 404 });
    expect(await errorOf(takeControl(db, await fresh('familia'), cOp(1)))).toMatchObject({ status: 403 });
    // Pide un partido de a1 diciendo que es de a2 (equipo propio).
    expect(await errorOf(takeControl(db, await fresh('otro-equipo'), cOp(1, { teamId: 'a2' })))).toMatchObject({ status: 404 });
    const admin: AuthContext = { deviceId: null, grants: [], admin: { identityId: 'x', email: 'x@example.com', roles: [{ role: 'superadmin', clubId: null }], critical: true } };
    expect(await errorOf(takeControl(db, admin, cOp(1)))).toMatchObject({ status: 403, code: 'device_required' });
    expect(row()).toMatchObject({ holder: 'entrenador-a', epoch: 1 });
    expect(count('match_control_log')).toBe(0);
  });

  it('la descarga dice si el control es de este dispositivo, de otro o de nadie, sin identificar dispositivos', async () => {
    await startedByA();
    expect((await teamSnapshot(db, a, 'a1')).matches[0]!.control).toMatchObject({ holder: 'here', epoch: 1 });
    expect((await teamSnapshot(db, b, 'a1')).matches[0]!.control).toMatchObject({ holder: 'other', epoch: 1 });
    const text = JSON.stringify(await teamSnapshot(db, await fresh('familia'), 'a1'));
    expect(text).not.toMatch(/entrenador-a|entrenador-b|control_device_id|recorder_device_id/);
  });

  it('ruta HTTP: valida la petición y responde con códigos estables', async () => {
    await startedByA();
    const env: Env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: '' };
    const post = (token: string, body: unknown) =>
      worker.fetch(
        new Request('https://api.example/api/sync/control', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        env,
      );
    expect((await post(tokens['entrenador-b']!, { opId: 'x', teamId: 'a1', matchId: 'm1' })).status).toBe(400);
    expect((await post(tokens['entrenador-b']!, { opId: 'x', teamId: 'a1', matchId: 'm1', expectedEpoch: -1 })).status).toBe(400);
    const stale = await post(tokens['entrenador-b']!, { opId: 'x1', teamId: 'a1', matchId: 'm1', expectedEpoch: 0 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'control_changed' });
    const ok = await post(tokens['entrenador-b']!, { opId: 'x2', teamId: 'a1', matchId: 'm1', expectedEpoch: 1 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'applied', entityId: 'm1', epoch: 2 });
    expect((await post(tokens['familia']!, { opId: 'x3', teamId: 'a1', matchId: 'm1', expectedEpoch: 2 })).status).toBe(403);
  });
});
