import { beforeEach, describe, expect, it } from 'vitest';
import type { MatchEvent } from '../../src/domain/types';
import { ev, goal } from '../../src/test/fixtures';
import { HttpError } from '../src/errors';
import type { AuthContext } from '../src/model';
import { applyEventOp, pullChanges, type EventOp } from '../src/sync';
import { addDevice, addMatch, NOW, twoClubs } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

let db: SqliteD1;
let coach: AuthContext;
let opSeq = 0;

const op = (event: MatchEvent, baseVersion: number | null = null, teamId = 'a1'): EventOp => ({
  opId: `op-${++opSeq}`,
  teamId,
  baseVersion,
  event,
});
/** Acción del partido m1 de a1 (jugadores con prefijo «a1-»). */
const action = (payload: Parameters<typeof ev>[0], player: string | null) =>
  ev(payload, player === null ? null : `a1-${player}`, 3, { matchId: 'm1' });

async function errorOf(p: Promise<unknown>): Promise<{ status: number; code: string; details?: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, code: e.code, details: e.details };
    throw e;
  }
  throw new Error('Se esperaba un error');
}

const eventRows = () => db.sqlite.prepare('SELECT id, version FROM events').all();

beforeEach(async () => {
  db = migratedDb();
  twoClubs(db);
  addMatch(db, 'a1', {}, 'a1-');
  coach = (await addDevice(db, 'coach', [{ clubId: 'A', teamId: 'a1', role: 'coach' }])).auth;
});

describe('subida de acciones', () => {
  it('aplica una acción nueva con versión 1', async () => {
    const e = action(goal(), 'p7');
    expect(await applyEventOp(db, coach, op(e))).toEqual({ status: 'applied', entityId: e.id, version: 1 });
    expect(eventRows()).toEqual([{ id: e.id, version: 1 }]);
  });

  it('repetir la misma operación no duplica (idempotencia)', async () => {
    const e = action(goal(), 'p7');
    const o = op(e);
    const first = await applyEventOp(db, coach, o);
    const again = await applyEventOp(db, coach, o);
    expect(again).toEqual(first);
    expect(eventRows()).toHaveLength(1);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM change_log').get()).toEqual({ n: 1 });
  });

  it('un alta repetida con otro opId pero igual contenido es un duplicado; con otro contenido, conflicto', async () => {
    const e = action(goal(), 'p7');
    await applyEventOp(db, coach, op(e));
    expect(await applyEventOp(db, coach, op(e))).toEqual({ status: 'duplicate', entityId: e.id, version: 1 });
    const err = await errorOf(applyEventOp(db, coach, op({ ...e, playerId: 'a1-p14' })));
    expect(err).toMatchObject({ status: 409, code: 'conflict' });
    expect(eventRows()).toHaveLength(1);
  });

  it('una edición sobre la versión actual sube la versión', async () => {
    const e = action(goal(), null);
    await applyEventOp(db, coach, op(e));
    const res = await applyEventOp(db, coach, op({ ...e, playerId: 'a1-p14', updatedAt: NOW }, 1));
    expect(res).toEqual({ status: 'applied', entityId: e.id, version: 2 });
    expect(db.sqlite.prepare('SELECT player_id FROM events').get()).toEqual({ player_id: 'a1-p14' });
  });

  it('una edición sobre una versión antigua no sobrescribe: conflicto con la copia del servidor', async () => {
    const e = action(goal(), 'p7');
    await applyEventOp(db, coach, op(e));
    await applyEventOp(db, coach, op({ ...e, playerId: 'a1-p14' }, 1));
    const err = await errorOf(applyEventOp(db, coach, op({ ...e, playerId: 'a1-p69' }, 1)));
    expect(err.status).toBe(409);
    expect(err.details).toMatchObject({ server: { version: 2, event: { playerId: 'a1-p14' } } });
    expect(db.sqlite.prepare('SELECT player_id, version FROM events').get()).toEqual({ player_id: 'a1-p14', version: 2 });
  });

  it('el borrado lógico se sincroniza como una edición', async () => {
    const e = action({ kind: 'recovery' }, 'p7');
    await applyEventOp(db, coach, op(e));
    await applyEventOp(db, coach, op({ ...e, deletedAt: NOW }, 1));
    expect(db.sqlite.prepare('SELECT deleted_at, version FROM events').get()).toEqual({ deleted_at: NOW, version: 2 });
  });

  it('aplica las reglas de la aplicación: un lanzamiento recibido solo a porteros', async () => {
    const e = action({ kind: 'gk_shot', shotType: 'nine_m', result: 'save' }, 'p7');
    expect(await errorOf(applyEventOp(db, coach, op(e)))).toMatchObject({ status: 422, code: 'invalid_event' });
    expect(await applyEventOp(db, coach, op(action({ kind: 'gk_shot', shotType: 'nine_m', result: 'save' }, 'g1')))).toMatchObject({
      status: 'applied',
    });
  });

  it('acepta golpes francos antiguos (categoría histórica)', async () => {
    expect(await applyEventOp(db, coach, op(action({ kind: 'free_throw' }, 'p7')))).toMatchObject({ status: 'applied' });
  });

  it('consulta no puede subir acciones', async () => {
    const viewer = (await addDevice(db, 'viewer', [{ clubId: 'A', teamId: 'a1', role: 'viewer' }])).auth;
    expect(await errorOf(applyEventOp(db, viewer, op(action(goal(), 'p7'))))).toMatchObject({ status: 403 });
    expect(eventRows()).toHaveLength(0);
  });

  it('no se pueden subir acciones a partidos de otro equipo o club', async () => {
    addMatch(db, 'b1', { id: 'mb' }, 'b1-');
    const foreign = ev(goal(), 'b1-p7', 3, { matchId: 'mb' });
    // Declarando su equipo real: el dispositivo no tiene permiso en b1.
    expect(await errorOf(applyEventOp(db, coach, op(foreign, null, 'b1')))).toMatchObject({ status: 404 });
    // Declarando su propio equipo: el partido no es de a1.
    expect(await errorOf(applyEventOp(db, coach, op(foreign, null, 'a1')))).toMatchObject({ status: 404 });
    expect(eventRows()).toHaveLength(0);
  });

  it('un partido lo registra un único dispositivo hasta que se transfiera', async () => {
    const other = (await addDevice(db, 'other', [{ clubId: 'A', teamId: 'a1', role: 'coach' }])).auth;
    await applyEventOp(db, coach, op(action(goal(), 'p7')));
    expect(db.sqlite.prepare('SELECT recorder_device_id FROM matches').get()).toEqual({ recorder_device_id: 'coach' });
    expect(await errorOf(applyEventOp(db, other, op(action(goal(), 'p14'))))).toMatchObject({
      status: 409,
      code: 'match_recorded_elsewhere',
    });
    db.run("UPDATE matches SET recorder_device_id = 'other'");
    expect(await applyEventOp(db, other, op(action(goal(), 'p14')))).toMatchObject({ status: 'applied' });
  });

  it('no se aceptan acciones de partidos eliminados', async () => {
    db.run('UPDATE matches SET deleted_at = ?', NOW);
    expect(await errorOf(applyEventOp(db, coach, op(action(goal(), 'p7'))))).toMatchObject({ code: 'match_deleted' });
  });

  it('si otro dispositivo cambia la acción entre la lectura y la escritura, no se marca como aplicada', async () => {
    await addDevice(db, 'other', [{ clubId: 'A', teamId: 'a1', role: 'coach' }]);
    const e = action(goal(), 'p7');
    await applyEventOp(db, coach, op(e));
    // Base de datos que, justo antes de la transacción, recibe el cambio de otro dispositivo.
    const racing = {
      prepare: (q: string) => db.prepare(q),
      batch: async (stmts: Parameters<typeof db.batch>[0]) => {
        db.run("UPDATE events SET player_id = 'a1-p69', version = 2, updated_by_device_id = 'other'");
        return db.batch(stmts);
      },
    };
    const o = op({ ...e, playerId: 'a1-p14' }, 1);
    expect(await errorOf(applyEventOp(racing, coach, o))).toMatchObject({ status: 409, code: 'conflict' });
    expect(db.sqlite.prepare('SELECT player_id, version FROM events').get()).toEqual({ player_id: 'a1-p69', version: 2 });
    // Ni registro de cambios ni operación registrada: se podrá reintentar.
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_ops WHERE op_id = ?').get(o.opId)).toEqual({ n: 0 });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM change_log').get()).toEqual({ n: 1 });
  });

  it('un opId no puede reutilizarse para otra acción', async () => {
    const o = op(action(goal(), 'p7'));
    await applyEventOp(db, coach, o);
    expect(await errorOf(applyEventOp(db, coach, { ...o, event: action(goal(), 'p14') }))).toMatchObject({
      code: 'op_id_reused',
    });
  });
});

describe('descarga de cambios', () => {
  it('devuelve los cambios posteriores al cursor, una vez por acción y en su estado actual', async () => {
    const viewer = (await addDevice(db, 'viewer', [{ clubId: 'A', teamId: 'a1', role: 'viewer' }])).auth;
    const e1 = action(goal(), 'p7');
    const e2 = action({ kind: 'recovery' }, 'p14');
    await applyEventOp(db, coach, op(e1));
    await applyEventOp(db, coach, op(e2));
    await applyEventOp(db, coach, op({ ...e1, deletedAt: NOW }, 1));

    const all = await pullChanges(db, viewer, 'a1', 0);
    expect(all.nextSeq).toBe(3);
    expect(all.hasMore).toBe(false);
    expect(all.events.map((x) => [x.event.id, x.version, x.event.deletedAt])).toEqual([
      [e1.id, 2, NOW],
      [e2.id, 1, null],
    ]);

    const since = await pullChanges(db, viewer, 'a1', 2);
    expect(since.events.map((x) => x.event.id)).toEqual([e1.id]);
    expect(await pullChanges(db, viewer, 'a1', 3)).toMatchObject({ nextSeq: 3, events: [] });
  });

  it('pagina y no mezcla equipos', async () => {
    for (let i = 0; i < 3; i++) await applyEventOp(db, coach, op(action({ kind: 'recovery' }, 'p7')));
    const page = await pullChanges(db, coach, 'a1', 0, 2);
    expect(page).toMatchObject({ nextSeq: 2, hasMore: true });
    const outsider = (await addDevice(db, 'b', [{ clubId: 'B', teamId: 'b1', role: 'coach' }])).auth;
    expect(await errorOf(pullChanges(db, outsider, 'a1', 0))).toMatchObject({ status: 404 });
    expect((await pullChanges(db, outsider, 'b1', 0)).events).toEqual([]);
  });
});
