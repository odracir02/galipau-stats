// Pérdida del permiso de entrenador en una copia del club (src/remote/importer.ts y
// src/app/observableRepository.ts): ninguna acción registrada en el dispositivo se
// puede perder al retirar o bloquear la copia, tampoco con escrituras en curso,
// partidos activos, fallos de la base local o retiradas simultáneas. Contra el
// Worker real en memoria y una base local simulada. Datos sintéticos.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObservableRepository, ReadOnlyTeamError } from '../../src/app/observableRepository';
import { IndexedDbRepository } from '../../src/data/indexedDbRepository';
import { StorageError } from '../../src/data/repository';
import type { Match, MatchEvent, Team } from '../../src/domain/types';
import * as svc from '../../src/services/matchService';
import { createTeam, savePlayer } from '../../src/services/teamService';
import { createApi, type Api, type RemoteTeam } from '../../src/remote/api';
import { ClubSync } from '../../src/remote/clubsync';
import { ACCESS_LOST, accessChangeMessage, TeamImporter, type AccessChange } from '../../src/remote/importer';
import { TeamPuller } from '../../src/remote/pull';
import { AccountStore } from '../../src/remote/store';
import worker, { type Env } from '../src/index';
import { addClub, addDevice, addTeam, CODE_KEY, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const REMOTE = 'remoto-sma';
const OTHER_REMOTE = 'remoto-sfa';
let n = 0;
let db: SqliteD1;
let env: Env;
let tokens: Record<'a' | 'b', string>;
let A: Awaited<ReturnType<typeof device>>;
let teamA: Team;
let finished: Match;
let ids: string[];

const remoteTeam = (role: RemoteTeam['role'] = 'coach', teamId = REMOTE): RemoteTeam => ({
  teamId,
  role,
  status: 'active',
  name: teamId === REMOTE ? 'Senior Masculino A' : 'Senior Femenino A',
  code: teamId === REMOTE ? 'SMA2627' : 'SFA2627',
  season: '2026/27',
  clubId: 'A',
  clubName: 'Club A',
});
const count = (sql: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/**
 * Base local que puede DETENER una escritura de acción ya comprobada (después de la
 * comprobación de solo lectura del repositorio y antes de guardarla), para reproducir
 * de forma determinista una acción registrada justo cuando se retira el permiso.
 */
class GatedRepository extends IndexedDbRepository {
  gate: Promise<void> | null = null;
  entered: (() => void) | null = null;
  /** Fallo que tendrá la escritura detenida al continuar (fallo simulado de la base local). */
  failOnRelease: Error | null = null;
  override async saveEvent(event: MatchEvent): Promise<void> {
    if (this.gate) {
      this.entered?.();
      await this.gate;
      if (this.failOnRelease) {
        const e = this.failOnRelease;
        this.failOnRelease = null;
        throw e;
      }
    }
    return super.saveEvent(event);
  }
}

/** Detiene la próxima escritura de acción: `entered` se cumple al llegar; `release` la deja seguir. */
function holdNextEvent(local: GatedRepository) {
  let release!: () => void;
  local.gate = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (local.entered = r));
  return {
    entered,
    release: () => {
      local.gate = null;
      local.entered = null;
      release();
    },
  };
}

/** Un dispositivo completo, montado como en la aplicación (repositorio protegido por el importador). */
async function device(name: string, token: string, teams: RemoteTeam[] = [remoteTeam()]) {
  const local = new GatedRepository(`local-${n}-${name}`);
  const repo = new ObservableRepository(local);
  const store = new AccountStore(`cuenta-${n}-${name}`);
  await store.saveDevice({ deviceId: name, token, joinedAt: '2026-10-31T10:00:00.000Z' });
  const net = { down: false };
  const api: Api = createApi({
    baseUrl: 'https://api.example',
    fetch: async (input, init) => {
      if (net.down) throw new TypeError('Failed to fetch');
      return worker.fetch(new Request(input as string, init), env);
    },
  });
  // El importador coordina sus retiradas con las escrituras del repositorio.
  const importer = new TeamImporter(local, store, api, () => teams, undefined, repo);
  repo.protectReadOnly(importer);
  await importer.load();
  const sync = new ClubSync(repo, store, api, () => teams);
  const puller = new TeamPuller(local, store, api, () => teams, undefined, () => void importer.load());
  sync.receiveWith(puller);
  const localTeam = async (remote = REMOTE) => (await store.getLinkByRemote(remote))!.localTeamId;
  return { name, local, repo, store, net, api, teams, importer, sync, puller, localTeam };
}

beforeEach(async () => {
  n++;
  db = migratedDb();
  addClub(db, 'A');
  addTeam(db, REMOTE, 'A', 'SMA2627');
  addTeam(db, OTHER_REMOTE, 'A', 'SFA2627');
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://develop.galipau-stats.pages.dev' };
  tokens = {
    a: (await addDevice(db, 'iphone', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
    b: (await addDevice(db, 'entrenador-b', [
      { clubId: 'A', teamId: REMOTE, role: 'coach' },
      { clubId: 'A', teamId: OTHER_REMOTE, role: 'coach' },
    ])).token,
  };
  // A: el registrador original, con su equipo vinculado y enviado (un partido finalizado).
  A = await device('iphone', tokens.a);
  teamA = await createTeam(A.repo, { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', maxSquad: 16 });
  ids = [];
  for (const [num, pos] of [[7, 'field'], [9, 'field'], [14, 'field'], [22, 'field'], [1, 'goalkeeper']] as const) {
    ids.push((await savePlayer(A.repo, teamA.id, { name: `Jugador ${num}`, number: num, position: pos, active: true })).id);
  }
  finished = await svc.createMatch(A.repo, { teamId: teamA.id, opponent: 'CH Sintético', date: '2026-10-04', venue: 'away', season: '2026/27', playerIds: ids });
  for (let i = 0; i < 6; i++) {
    await svc.recordEvent(A.repo, finished, { kind: 'shot', shotType: 'nine_m', result: i % 3 ? 'goal' : 'saved' }, ids[i % 4]!, { period: 1, matchTimeMs: i * 60_000 });
  }
  finished = await svc.finishMatch(A.repo, finished);
  await A.sync.link(teamA.id, REMOTE);
  expect((await A.sync.upload(teamA.id)).status).toBe('verified');
});

/** B: entrenador que incorpora la copia del club al canjear su código. */
async function coachB(teams?: RemoteTeam[]) {
  const B = await device('entrenador-b', tokens.b, teams);
  await B.importer.incorporate();
  return B;
}

const revokeB = (teamId = REMOTE) =>
  db.sqlite.prepare("UPDATE grants SET revoked_at = '2026-10-31T12:00:00.000Z' WHERE device_id = 'entrenador-b' AND team_id = ? AND revoked_at IS NULL").run(teamId);
const regrantB = (role: 'coach' | 'viewer') =>
  db.sqlite
    .prepare("INSERT INTO grants (id, device_id, club_id, team_id, role, created_at) VALUES (?, 'entrenador-b', 'A', ?, ?, '2026-10-31T13:00:00.000Z')")
    .run(`g-${role}-${Date.now()}`, REMOTE, role);

/** Una acción en el partido finalizado de la copia de B (corrección posterior). */
const recordOn = (B: Awaited<ReturnType<typeof coachB>>, matchTimeMs: number) =>
  B.local.getMatch(finished.id).then((m) => svc.recordEvent(B.repo, m!, { kind: 'recovery' }, null, { period: 2, matchTimeMs }));

describe('acción registrada mientras se retira el permiso', () => {
  it('escritura ya empezada cuando llega la retirada: la retirada la espera y la copia se conserva con la acción', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    revokeB();
    // La acción pasa la comprobación de solo lectura y se detiene justo antes de guardarse.
    const hold = holdNextEvent(B.local);
    const writing = recordOn(B, 3_100_000);
    await hold.entered;
    // Llega la comprobación de la sesión sin el equipo: empieza la retirada.
    const retiring = B.importer.retireExcept([]);
    await tick(50);
    hold.release();
    const event = await writing;
    expect(await retiring).toEqual([]);
    // Nada se pierde: la acción está, el equipo también, y la copia queda bloqueada.
    expect(await B.local.getEvent(event.id)).toBeDefined();
    expect(await B.local.getTeam(idB)).toBeDefined();
    expect(await B.store.getLink(idB)).toMatchObject({ accessLost: true, readOnly: true, autoBlocked: ACCESS_LOST });
  });

  it('escritura que empieza durante la retirada: se rechaza sin guardar nada', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    revokeB();
    const hold = holdNextEvent(B.local);
    const first = recordOn(B, 3_100_000);
    await hold.entered;
    const retiring = B.importer.retireExcept([]);
    await tick(10);
    // Con la retirada en marcha, una acción nueva no entra (y lo dice).
    const before = (await B.local.readAll()).events.length;
    await expect(recordOn(B, 3_200_000)).rejects.toBeInstanceOf(ReadOnlyTeamError);
    hold.release();
    await first;
    await retiring;
    expect((await B.local.readAll()).events.length).toBe(before + 1);
    expect(await B.store.getLink(idB)).toMatchObject({ accessLost: true });
    // Ya bloqueada: tampoco después.
    await expect(recordOn(B, 3_300_000)).rejects.toBeInstanceOf(ReadOnlyTeamError);
  });

  it('acción guardada justo antes de la retirada: se conserva, bloqueada', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const e = await recordOn(B, 3_000_000);
    revokeB();
    expect(await B.importer.retireExcept([])).toEqual([]);
    expect(await B.local.getEvent(e.id)).toBeDefined();
    expect(await B.store.getLink(idB)).toMatchObject({ accessLost: true, readOnly: true });
  });

  it('otro equipo del dispositivo con permiso sigue escribiendo durante la retirada', async () => {
    const B = await coachB([remoteTeam('coach'), remoteTeam('coach', OTHER_REMOTE)]);
    const own = await createTeam(B.repo, { name: 'Equipo propio', code: 'PROPIO', season: '2026/27', maxSquad: 16 });
    revokeB();
    const hold = holdNextEvent(B.local);
    const writing = recordOn(B, 3_100_000);
    await hold.entered;
    const retiring = B.importer.retireExcept([OTHER_REMOTE]);
    await tick(10);
    // Un equipo propio no se congela por la retirada de la copia.
    const p = await savePlayer(B.repo, own.id, { name: 'Jugadora propia', number: 5, position: 'field', active: true });
    expect(await B.local.getPlayer(p.id)).toBeDefined();
    hold.release();
    await writing;
    await retiring;
  });
});

describe('partidos activos', () => {
  /** Partido en curso registrado por B en su copia (con el control) y enviado: sin nada pendiente. */
  async function liveMatch(B: Awaited<ReturnType<typeof coachB>>, status: 'in_progress' | 'halftime') {
    const idB = await B.localTeam();
    const players = await B.local.listPlayers(idB);
    let m = await svc.createMatch(B.repo, { teamId: idB, opponent: 'Rival en directo', date: '2026-10-31', venue: 'home', season: '2026/27', playerIds: players.map((p) => p.id) });
    m = await svc.toggleClock(B.repo, m);
    await svc.recordEvent(B.repo, m, { kind: 'shot', shotType: 'six_m', result: 'goal' }, players[0]!.id, { period: 1, matchTimeMs: 120_000 });
    if (status === 'halftime') m = await svc.startHalftime(B.repo, (await B.local.getMatch(m.id))!);
    expect((await B.sync.upload(idB)).status).toBe('verified');
    return (await B.local.getMatch(m.id))!;
  }

  for (const status of ['in_progress', 'halftime'] as const) {
    it(`${status === 'in_progress' ? 'en juego, con el cronómetro en marcha' : 'en el descanso'}: la copia no desaparece aunque no tenga nada pendiente, y el partido no cambia`, async () => {
      const B = await coachB();
      const idB = await B.localTeam();
      const m = await liveMatch(B, status);
      expect(m.status).toBe(status);
      const before = JSON.stringify({ match: await B.local.getMatch(m.id), events: await B.local.listEvents(m.id) });
      revokeB();
      expect(await B.importer.retireExcept([])).toEqual([]);
      expect(await B.local.getTeam(idB)).toBeDefined();
      expect(await B.store.getLink(idB)).toMatchObject({ accessLost: true, readOnly: true });
      // Ni el cronómetro ni el marcador se tocan al bloquear.
      expect(JSON.stringify({ match: await B.local.getMatch(m.id), events: await B.local.listEvents(m.id) })).toBe(before);
      // Y no se puede seguir registrando sin permiso.
      await expect(svc.recordEvent(B.repo, (await B.local.getMatch(m.id))!, { kind: 'recovery' }, null, { period: 1, matchTimeMs: 130_000 })).rejects.toBeInstanceOf(ReadOnlyTeamError);
    });
  }

  it('sin cambios y sin partido activo: la copia se retira (sin perder nada, porque todo está en el club)', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    revokeB();
    expect(await B.importer.retireExcept([])).toEqual([idB]);
    expect(await B.local.readAll()).toEqual({ teams: [], players: [], matches: [], events: [] });
    expect(await B.store.listLinks()).toEqual([]);
  });
});

describe('recuperación del permiso', () => {
  it('sin conexión no se retira nada; al volver sin permiso se bloquea; al recuperarlo se envía una sola vez', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const listeners = new Set<() => void>();
    let s = { ready: true, checking: false, linked: true, problem: null as null | string, checkedAt: '2026-10-31T10:00:00.000Z', teams: [remoteTeam('coach')] };
    B.importer.followSession({ getState: () => s as never, subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)) });
    await tick(30);
    // Sin conexión: registra y el club le retira el permiso, pero aquí no lo sabe todavía.
    B.net.down = true;
    const e1 = await recordOn(B, 3_000_000);
    const e2 = await recordOn(B, 3_010_000);
    revokeB();
    s = { ...s, problem: 'offline', checkedAt: '2026-10-31T12:30:00.000Z', teams: [] };
    listeners.forEach((l) => l());
    await tick(40);
    // Un problema de conexión no es una revocación: nada cambia.
    expect((await B.store.getLink(idB))?.accessLost).toBeUndefined();
    // Vuelve la conexión: la comprobación ya no incluye el equipo → bloqueada con todo.
    B.net.down = false;
    s = { ...s, problem: null, checkedAt: '2026-10-31T12:40:00.000Z', teams: [] };
    listeners.forEach((l) => l());
    await tick(60);
    expect(await B.store.getLink(idB)).toMatchObject({ accessLost: true, readOnly: true });
    expect(await B.local.getEvent(e1.id)).toBeDefined();
    expect(await B.local.getEvent(e2.id)).toBeDefined();
    await expect(B.sync.upload(idB)).rejects.toThrow(/solo lectura/);
    expect(count(`events WHERE id IN ('${e1.id}', '${e2.id}')`)).toBe(0);

    // Recupera un permiso de CONSULTA: sigue bloqueada (no puede escribir).
    regrantB('viewer');
    B.teams.splice(0, 1, remoteTeam('viewer'));
    s = { ...s, checkedAt: '2026-10-31T13:00:00.000Z', teams: [remoteTeam('viewer')] };
    listeners.forEach((l) => l());
    await tick(60);
    expect(await B.store.getLink(idB)).toMatchObject({ accessLost: true });
    await expect(recordOn(B, 3_020_000)).rejects.toBeInstanceOf(ReadOnlyTeamError);

    // Recupera el permiso de ENTRENADOR: se desbloquea y lo pendiente se envía una vez.
    db.sqlite.prepare("UPDATE grants SET revoked_at = '2026-10-31T13:30:00.000Z' WHERE device_id = 'entrenador-b' AND team_id = ? AND revoked_at IS NULL").run(REMOTE);
    regrantB('coach');
    B.teams.splice(0, 1, remoteTeam('coach'));
    s = { ...s, checkedAt: '2026-10-31T14:00:00.000Z', teams: [remoteTeam('coach')] };
    listeners.forEach((l) => l());
    await tick(80);
    expect((await B.store.getLink(idB))?.accessLost).toBeUndefined();
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(count(`events WHERE id = '${e1.id}'`)).toBe(1);
    expect(count(`events WHERE id = '${e2.id}'`)).toBe(1);
  });

  it('un partido activo que se registraba aquí: al recuperar el permiso se envía lo pendiente sin duplicar', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const players = await B.local.listPlayers(idB);
    let m = await svc.createMatch(B.repo, { teamId: idB, opponent: 'Rival en directo', date: '2026-10-31', venue: 'home', season: '2026/27', playerIds: players.map((p) => p.id) });
    m = await svc.toggleClock(B.repo, m);
    expect((await B.sync.upload(idB)).status).toBe('verified');
    // Sin conexión, registra dos acciones; mientras, pierde el permiso.
    const live = (await B.local.getMatch(m.id))!;
    const a1 = await svc.recordEvent(B.repo, live, { kind: 'shot', shotType: 'six_m', result: 'goal' }, players[0]!.id, { period: 1, matchTimeMs: 200_000 });
    const a2 = await svc.recordEvent(B.repo, live, { kind: 'shot', shotType: 'six_m', result: 'goal' }, players[1]!.id, { period: 1, matchTimeMs: 260_000 });
    revokeB();
    await B.importer.retireExcept([]);
    expect(await B.store.getLink(idB)).toMatchObject({ accessLost: true });
    expect(count(`events WHERE id IN ('${a1.id}', '${a2.id}')`)).toBe(0);
    // Recupera el permiso: el partido sigue libre (nadie más lo registra) y lo pendiente llega una vez.
    regrantB('coach');
    await B.importer.retireExcept([REMOTE]);
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(count(`events WHERE id IN ('${a1.id}', '${a2.id}')`)).toBe(2);
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(count(`events WHERE id IN ('${a1.id}', '${a2.id}')`)).toBe(2);
  });
});

describe('concurrencia y fallos de la base local', () => {
  it('dos retiradas a la vez: una sola decisión, sin errores ni pérdidas', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const e = await recordOn(B, 3_000_000);
    revokeB();
    const [r1, r2] = await Promise.all([B.importer.retireExcept([]), B.importer.retireExcept([])]);
    expect([...r1, ...r2]).toEqual([]);
    expect(await B.local.getEvent(e.id)).toBeDefined();
    expect(await B.store.getLink(idB)).toMatchObject({ accessLost: true });
  });

  it('una recarga de los vínculos durante la retirada no desbloquea la copia', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    revokeB();
    const hold = holdNextEvent(B.local);
    const writing = recordOn(B, 3_100_000);
    await hold.entered;
    const retiring = B.importer.retireExcept([]);
    await tick(10);
    await B.importer.load(); // p. ej. tras una recepción
    await expect(recordOn(B, 3_200_000)).rejects.toBeInstanceOf(ReadOnlyTeamError);
    hold.release();
    await writing;
    await retiring;
    expect(await B.store.getLink(idB)).toMatchObject({ accessLost: true });
  });

  it('si no se puede guardar el bloqueo: los datos siguen ahí, bloqueados, y se reintenta en la siguiente comprobación', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const e = await recordOn(B, 3_000_000);
    revokeB();
    const real = B.store.saveSyncState.bind(B.store);
    B.store.saveSyncState = async () => {
      throw new StorageError('fallo simulado de la base de la cuenta');
    };
    expect(await B.importer.retireExcept([])).toEqual([]);
    expect(await B.local.getEvent(e.id)).toBeDefined();
    // Sin poder guardarlo, igualmente bloqueada en este dispositivo.
    await expect(recordOn(B, 3_100_000)).rejects.toBeInstanceOf(ReadOnlyTeamError);
    B.store.saveSyncState = real;
    await B.importer.retireExcept([]);
    expect(await B.store.getLink(idB)).toMatchObject({ accessLost: true, readOnly: true });
  });

  it('si falla el borrado de una copia sin cambios: no se borra nada y queda bloqueada hasta reintentarlo', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    revokeB();
    const real = B.local.removeTeamData.bind(B.local);
    B.local.removeTeamData = async () => {
      throw new StorageError('fallo simulado de la base local');
    };
    expect(await B.importer.retireExcept([])).toEqual([]);
    expect(await B.local.getTeam(idB)).toBeDefined();
    expect((await B.local.listEvents(finished.id)).length).toBe(6);
    await expect(recordOn(B, 3_100_000)).rejects.toBeInstanceOf(ReadOnlyTeamError);
    B.local.removeTeamData = real;
    expect(await B.importer.retireExcept([])).toEqual([idB]);
    expect(await B.local.readAll()).toEqual({ teams: [], players: [], matches: [], events: [] });
  });

  it('con el permiso vigente, la copia sigue funcionando con normalidad', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    expect(await B.importer.retireExcept([REMOTE])).toEqual([]);
    const e = await recordOn(B, 3_000_000);
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(count(`events WHERE id = '${e.id}'`)).toBe(1);
    expect((await B.store.getLink(idB))?.accessLost).toBeUndefined();
  });
});

describe('avisos a quien usa el dispositivo', () => {
  it('bloqueada: un aviso (una vez) que no dice que se haya enviado nada; retirada: que no se ha perdido nada', async () => {
    const B = await coachB();
    const changes: AccessChange[] = [];
    B.importer.onAccessChange((c) => changes.push(c));
    await recordOn(B, 3_000_000);
    revokeB();
    await B.importer.retireExcept([]);
    await B.importer.retireExcept([]);
    expect(changes).toEqual([{ kind: 'blocked', teamName: 'Equipo remoto-sma' }]);
    const blocked = accessChangeMessage(changes[0]!);
    expect(blocked).toMatch(/se conserva/);
    expect(blocked).toMatch(/no se puede enviar/);
    expect(blocked).not.toMatch(/enviad|se ha perdido|se perder/i);

    // Otro dispositivo con el mismo permiso (devuelto) y una copia sin nada pendiente.
    regrantB('coach');
    const C = await device('entrenador-c', tokens.b);
    await C.importer.incorporate();
    expect((await C.store.listLinks()).length).toBe(1);
    const retiredChanges: AccessChange[] = [];
    C.importer.onAccessChange((c) => retiredChanges.push(c));
    await C.importer.retireExcept([]);
    expect(retiredChanges).toEqual([{ kind: 'retired', teamName: 'Equipo remoto-sma' }]);
    expect(accessChangeMessage(retiredChanges[0]!)).toMatch(/No se ha perdido nada/);
  });
});

describe('exclusión de escrituras del repositorio', () => {
  it('una escritura que falla mientras la retirada la espera no la deja colgada ni guarda nada', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    revokeB();
    const hold = holdNextEvent(B.local);
    const writing = recordOn(B, 3_100_000);
    await hold.entered;
    // La escritura detenida fallará al continuar (fallo de la base local).
    B.local.failOnRelease = new StorageError('fallo simulado al guardar la acción');
    const retiring = B.importer.retireExcept([]);
    await tick(10);
    hold.release();
    await expect(writing).rejects.toBeInstanceOf(StorageError);
    // Sin cambios guardados y sin partido activo: se retira, sin perder nada (la acción no llegó a guardarse y se avisó del error).
    expect(await retiring).toEqual([idB]);
  });

  it('las escrituras de un equipo sin copias del club no se ven afectadas ni se ralentizan', async () => {
    const local = new IndexedDbRepository(`local-${n}-solo`);
    const repo = new ObservableRepository(local);
    const team = await createTeam(repo, { name: 'Solo local', code: 'SOLO', season: '2026/27', maxSquad: 16 });
    const p = await savePlayer(repo, team.id, { name: 'Jugadora', number: 4, position: 'field', active: true });
    expect(await local.getPlayer(p.id)).toBeDefined();
    // Una exclusión sobre otro equipo no afecta.
    await repo.exclusive('otro-equipo', async () => {
      const q = await savePlayer(repo, team.id, { name: 'Otra', number: 5, position: 'field', active: true });
      expect(await local.getPlayer(q.id)).toBeDefined();
    });
  });
});
