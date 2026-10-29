import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbRepository, DB_NAME } from '../data/indexedDbRepository';
import { createTeam } from '../services/teamService';
import { ev, goal, makeMatch } from '../test/fixtures';
import { RemoteError, type Api, type RemoteTeam, type TeamSnapshot } from './api';
import type { RemoteState } from './session';
import { ACCOUNT_DB_NAME, AccountStore } from './store';
import { ClubViewer, seasonItems, VIEWER_DB_NAME, ViewerStore } from './viewer';

const TEAM: RemoteTeam = {
  teamId: 'remoto-1',
  role: 'viewer',
  status: 'active',
  name: 'Senior Masculino A',
  code: 'SMA2627',
  season: '2026/27',
  clubId: 'club',
  clubName: 'Club de prueba',
};

function snapshot(extra = 0): TeamSnapshot {
  const match = makeMatch({ id: 'm1', status: 'finished', clock: { period: 2, running: false, baseMs: 3_600_000, anchorWallMs: null, firstHalfEndMs: 1_820_000 } });
  const events = [ev(goal(), 'p7', 1), { ...ev({ kind: 'red' }, 'p14', 10), addsToPrevious: true as const }, { ...ev(goal(), 'p7', 12), deletedAt: '2026-10-25T10:00:00.000Z' }];
  for (let i = 0; i < extra; i++) events.push(ev(goal(), 'p14', 20 + i));
  return {
    team: { id: 'remoto-1', name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27' },
    club: { id: 'club', name: 'Club de prueba' },
    seq: 3 + extra,
    players: [],
    matches: [{ version: 1, match, recordedHere: false }],
    events: events.map((event) => ({ version: 1, event })),
  };
}

let n = 0;
let account: AccountStore;
let store: ViewerStore;
let api: { snapshot: ReturnType<typeof vi.fn<Api['snapshot']>> } & Api;

function fakeApi() {
  const fail = vi.fn(async () => Promise.reject(new Error('la consulta no debe escribir')));
  return {
    redeem: fail,
    getSession: fail,
    leaveTeam: fail,
    logout: fail,
    syncPlayer: fail,
    syncMatch: fail,
    syncEvent: fail,
    snapshot: vi.fn<Api['snapshot']>(async () => snapshot()),
  } as unknown as typeof api;
}

beforeEach(async () => {
  n++;
  account = new AccountStore(`cuenta-consulta-${n}`);
  await account.saveDevice({ deviceId: 'd1', token: 'token-de-prueba', joinedAt: '2026-10-29T09:00:00.000Z' });
  store = new ViewerStore(`consulta-${n}`);
  api = fakeApi();
});

const viewer = (onUnauthorized = () => undefined) => new ClubViewer(api, account, store, () => new Date('2026-10-30T18:00:00.000Z'), onUnauthorized);

describe('consulta de un equipo del club', () => {
  it('descarga, guarda y muestra el equipo con su fecha; solo hace GET del equipo', async () => {
    const v = viewer();
    await v.refresh(TEAM);
    expect(api.snapshot).toHaveBeenCalledWith('token-de-prueba', 'remoto-1');
    expect(v.view('remoto-1')).toMatchObject({ loading: false, problem: null, cached: { fetchedAt: '2026-10-30T18:00:00.000Z' } });
    for (const k of ['redeem', 'getSession', 'leaveTeam', 'logout', 'syncPlayer', 'syncMatch', 'syncEvent'] as const) {
      expect(api[k]).not.toHaveBeenCalled();
    }
  });

  it('conserva addsToPrevious, firstHalfEndMs y las acciones borradas tal cual', async () => {
    const sent = snapshot();
    api.snapshot.mockResolvedValue(sent);
    await viewer().refresh(TEAM);
    const cached = await new ViewerStore(`consulta-${n}`).get('remoto-1');
    expect(cached!.snapshot).toEqual(sent);
    const items = seasonItems(cached!.snapshot);
    expect(items[0]!.match.clock.firstHalfEndMs).toBe(1_820_000);
    expect(items[0]!.events.some((e) => e.addsToPrevious === true)).toBe(true);
    expect(items[0]!.events.filter((e) => e.deletedAt !== null)).toHaveLength(1);
  });

  it('sin conexión: conserva lo último descargado, con su fecha, y avisa', async () => {
    const v = viewer();
    await v.refresh(TEAM);
    api.snapshot.mockRejectedValue(new RemoteError('offline', 'x'));
    await v.refresh(TEAM);
    expect(v.view('remoto-1')).toMatchObject({ problem: 'offline', cached: { fetchedAt: '2026-10-30T18:00:00.000Z' } });
    // Tras cerrar y reabrir la app, sin red, sigue disponible.
    const reopened = new ClubViewer(api, account, new ViewerStore(`consulta-${n}`));
    await reopened.load('remoto-1');
    expect(reopened.view('remoto-1').cached?.snapshot.seq).toBe(3);
  });

  it('«Actualizar» trae los datos nuevos', async () => {
    const v = viewer();
    await v.refresh(TEAM);
    api.snapshot.mockResolvedValue(snapshot(2));
    await v.refresh(TEAM);
    expect(v.view('remoto-1').cached!.snapshot.events).toHaveLength(5);
  });

  it('acceso retirado (403/404): se borra lo descargado de ese equipo', async () => {
    for (const kind of ['forbidden', 'not_found'] as const) {
      const v = viewer();
      api.snapshot.mockResolvedValueOnce(snapshot());
      await v.refresh(TEAM);
      api.snapshot.mockRejectedValueOnce(new RemoteError(kind, 'x'));
      await v.refresh(TEAM);
      expect(v.view('remoto-1')).toMatchObject({ cached: null, problem: 'no_access' });
      expect(await store.get('remoto-1')).toBeNull();
    }
  });

  it('credencial revocada (401): se borra lo descargado y se pide comprobar la sesión', async () => {
    const onUnauthorized = vi.fn();
    const v = viewer(onUnauthorized);
    await v.refresh(TEAM);
    api.snapshot.mockRejectedValueOnce(new RemoteError('unauthorized', 'x'));
    await v.refresh(TEAM);
    expect(v.view('remoto-1')).toMatchObject({ cached: null, problem: 'revoked' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('sigue a la sesión: sin sesión o sin acceso verificado se retira; sin conexión no', async () => {
    const v = viewer();
    await v.refresh(TEAM);
    await v.refresh({ ...TEAM, teamId: 'remoto-2' });
    let state: RemoteState = { ready: true, linked: true, revoked: false, teams: [TEAM, { ...TEAM, teamId: 'remoto-2' }], checkedAt: 'a', checking: false, problem: null };
    const listeners = new Set<() => void>();
    const session = { getState: () => state, subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) };
    v.followSession(session);
    const emit = async (next: Partial<RemoteState>) => {
      state = { ...state, ...next };
      for (const l of listeners) l();
      await new Promise((r) => setTimeout(r, 10));
    };
    await emit({});
    expect((await store.keys()).sort()).toEqual(['remoto-1', 'remoto-2']);
    // Sin conexión no se verifica nada: no se borra aunque la lista guardada cambie.
    await emit({ problem: 'offline', checkedAt: 'b', teams: [TEAM] });
    expect(await store.keys()).toHaveLength(2);
    // Comprobación correcta sin el equipo 2: se retira.
    await emit({ problem: null, checkedAt: 'c', teams: [TEAM] });
    expect(await store.keys()).toEqual(['remoto-1']);
    // Sesión cerrada o revocada: se retira todo.
    await emit({ linked: false, teams: [], checkedAt: null });
    expect(await store.keys()).toEqual([]);
  });

  it('usa su propia base de datos y no toca la de equipos del dispositivo', async () => {
    expect(new Set([VIEWER_DB_NAME, ACCOUNT_DB_NAME, DB_NAME]).size).toBe(3);
    const local = new IndexedDbRepository(`local-consulta-${n}`);
    await createTeam(local, { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', maxSquad: 16 });
    const before = await local.readAll();
    const v = viewer();
    await v.refresh(TEAM);
    await v.forget('remoto-1');
    expect(await local.readAll()).toEqual(before);
  });
});
