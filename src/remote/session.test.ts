import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbRepository } from '../data/indexedDbRepository';
import { createTeam } from '../services/teamService';
import { RemoteError, type Api, type RedeemResult, type RemoteTeam, type SessionInfo } from './api';
import { deviceLabel, RemoteSession } from './session';
import { AccountStore } from './store';

const CODE = 'ABCD-2345-EFGH';
const team = (id: string, role: RemoteTeam['role'] = 'coach'): RemoteTeam => ({
  teamId: id,
  role,
  status: 'active',
  name: 'Senior Masculino A',
  code: 'SMA2627',
  season: '2026/27',
  clubId: 'club-1',
  clubName: 'Club de prueba',
});
const redeemed = (id: string, role: RemoteTeam['role'], token?: string): RedeemResult => ({
  deviceId: 'dev-1',
  role,
  team: { id, name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', clubId: 'club-1', clubName: 'Club de prueba' },
  ...(token ? { token } : {}),
});

/** Servidor simulado (mocks tipados con la interfaz real). */
function fakeApi() {
  return {
    redeem: vi.fn<Api['redeem']>(async () => redeemed('t1', 'coach', 'token-1')),
    getSession: vi.fn<Api['getSession']>(async (): Promise<SessionInfo> => ({ deviceId: 'dev-1', teams: [team('t1')] })),
    leaveTeam: vi.fn<Api['leaveTeam']>(async () => undefined),
    logout: vi.fn<Api['logout']>(async () => undefined),
    // La sesión nunca sube ni descarga datos.
    syncPlayer: vi.fn<Api['syncPlayer']>(),
    syncMatch: vi.fn<Api['syncMatch']>(),
    syncEvent: vi.fn<Api['syncEvent']>(),
    snapshot: vi.fn<Api['snapshot']>(),
  };
}
const failing = (e: RemoteError) => async () => Promise.reject(e);

let n = 0;
let dbName: string;
const noSleep = vi.fn(async () => undefined);
const make = (api: Api, name = dbName) => new RemoteSession(api, new AccountStore(name), { sleep: noSleep, retryDelays: [1, 1], label: () => 'iPhone' });

beforeEach(() => {
  dbName = `cuenta-${++n}`;
  noSleep.mockClear();
});

describe('unirse con código', () => {
  it('el rol lo decide el servidor; guarda la credencial y muestra el equipo', async () => {
    const api = fakeApi();
    api.redeem.mockImplementation(async () => redeemed('t1', 'viewer', 'token-1'));
    api.getSession.mockImplementation(async () => ({ deviceId: 'dev-1', teams: [team('t1', 'viewer')] }));
    const s = make(api);
    const result = await s.join(CODE);
    expect(result).toEqual({ teamId: 't1', role: 'viewer', teamName: 'Senior Masculino A', clubName: 'Club de prueba', season: '2026/27' });
    expect(api.redeem).toHaveBeenCalledWith('ABCD2345EFGH', null, 'iPhone');
    expect(s.getState()).toMatchObject({ linked: true, teams: [{ teamId: 't1', role: 'viewer' }], problem: null });
    // El estado observable nunca contiene el token.
    expect(JSON.stringify(s.getState())).not.toContain('token-1');
  });

  it('un código con formato incorrecto no llega al servidor', async () => {
    const api = fakeApi();
    await expect(make(api).join('abc')).rejects.toMatchObject({ kind: 'invalid_code' });
    expect(api.redeem).not.toHaveBeenCalled();
  });

  it('código no válido o caducado: error claro y nada guardado', async () => {
    const api = fakeApi();
    api.redeem.mockImplementation(failing(new RemoteError('invalid_code', 'Código no válido o caducado.', 404)));
    const s = make(api);
    await expect(s.join(CODE)).rejects.toMatchObject({ kind: 'invalid_code', message: 'Código no válido o caducado.' });
    expect(s.getState()).toMatchObject({ linked: false, teams: [] });
    expect(await new AccountStore(dbName).getDevice()).toBeNull();
  });

  it('un segundo código se añade a la misma sesión (envía la credencial guardada)', async () => {
    const api = fakeApi();
    const s = make(api);
    await s.join(CODE);
    api.redeem.mockResolvedValueOnce(redeemed('t2', 'viewer'));
    api.getSession.mockResolvedValueOnce({ deviceId: 'dev-1', teams: [team('t1'), team('t2', 'viewer')] });
    await s.join('ZZZZ-2345-EFGH');
    expect(api.redeem.mock.calls[1]![1]).toBe('token-1');
    expect(s.getState().teams.map((t) => [t.teamId, t.role])).toEqual([
      ['t1', 'coach'],
      ['t2', 'viewer'],
    ]);
  });

  it('si la credencial guardada ya no vale, se canjea como dispositivo nuevo (una sola vez)', async () => {
    const api = fakeApi();
    const s = make(api);
    await s.join(CODE);
    api.redeem.mockRejectedValueOnce(new RemoteError('unauthorized', 'x', 401)).mockResolvedValueOnce(redeemed('t1', 'coach', 'token-2'));
    await s.join(CODE);
    expect(api.redeem.mock.calls.slice(1).map((c) => c[1])).toEqual(['token-1', null]);
    expect((await new AccountStore(dbName).getDevice())?.token).toBe('token-2');
  });

  it('sin conexión al canjear: no se reintenta solo (podría crear otro dispositivo)', async () => {
    const api = fakeApi();
    api.redeem.mockImplementation(failing(new RemoteError('offline', 'Sin conexión')));
    await expect(make(api).join(CODE)).rejects.toMatchObject({ kind: 'offline' });
    expect(api.redeem).toHaveBeenCalledTimes(1);
  });
});

describe('sesión guardada', () => {
  it('se conserva al cerrar y reabrir la app', async () => {
    await make(fakeApi()).join(CODE);
    const api = fakeApi();
    const reopened = make(api);
    await reopened.whenReady();
    expect(reopened.getState()).toMatchObject({ ready: true, linked: true, teams: [{ teamId: 't1' }] });
    await reopened.refresh();
    expect(api.getSession).toHaveBeenCalledWith('token-1');
  });

  it('sin conexión se muestran los últimos equipos conocidos, tras reintentar', async () => {
    await make(fakeApi()).join(CODE);
    const api = fakeApi();
    api.getSession.mockImplementation(failing(new RemoteError('offline', 'x')));
    const s = make(api);
    await s.refresh();
    expect(api.getSession).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
    expect(s.getState()).toMatchObject({ linked: true, problem: 'offline', teams: [{ teamId: 't1' }], checking: false });
  });

  it('un fallo pasajero del servidor se supera reintentando', async () => {
    await make(fakeApi()).join(CODE);
    const api = fakeApi();
    api.getSession.mockRejectedValueOnce(new RemoteError('server', 'x', 503));
    const s = make(api);
    await s.refresh();
    expect(api.getSession).toHaveBeenCalledTimes(2);
    expect(s.getState().problem).toBeNull();
  });

  it('sesión revocada en el servidor: se olvida la credencial y se avisa', async () => {
    await make(fakeApi()).join(CODE);
    const api = fakeApi();
    api.getSession.mockImplementation(failing(new RemoteError('unauthorized', 'x', 401)));
    const s = make(api);
    await s.refresh();
    expect(api.getSession).toHaveBeenCalledTimes(1);
    expect(s.getState()).toMatchObject({ linked: false, revoked: true, teams: [] });
    expect(await new AccountStore(dbName).getDevice()).toBeNull();
    s.dismissRevoked();
    expect(s.getState().revoked).toBe(false);
  });

  it('el permiso cambiado en el servidor se refleja al comprobar', async () => {
    const s = make(fakeApi());
    await s.join(CODE);
    const api = fakeApi();
    api.getSession.mockImplementation(async () => ({ deviceId: 'dev-1', teams: [{ ...team('t1', 'viewer'), status: 'unavailable' as const }] }));
    const reopened = make(api);
    await reopened.refresh();
    expect(reopened.getState().teams).toEqual([{ ...team('t1', 'viewer'), status: 'unavailable' }]);
  });

  it('comprobaciones simultáneas se agrupan en una sola petición', async () => {
    await make(fakeApi()).join(CODE);
    const api = fakeApi();
    const s = make(api);
    await Promise.all([s.refresh(), s.refresh(), s.refresh()]);
    expect(api.getSession).toHaveBeenCalledTimes(1);
  });
});

describe('salir y cerrar sesión', () => {
  it('salir de un equipo lo quita de la lista', async () => {
    const api = fakeApi();
    const s = make(api);
    await s.join(CODE);
    api.getSession.mockResolvedValueOnce({ deviceId: 'dev-1', teams: [] });
    await s.leave('t1');
    expect(api.leaveTeam).toHaveBeenCalledWith('token-1', 't1');
    expect(s.getState().teams).toEqual([]);
  });

  it('cerrar sesión revoca en el servidor y olvida la credencial; sin conexión no se olvida nada', async () => {
    const api = fakeApi();
    const s = make(api);
    await s.join(CODE);
    api.logout.mockRejectedValueOnce(new RemoteError('offline', 'Sin conexión'));
    await expect(s.logout()).rejects.toMatchObject({ kind: 'offline' });
    expect(s.getState().linked).toBe(true);
    await s.logout();
    expect(api.logout).toHaveBeenLastCalledWith('token-1');
    expect(s.getState()).toMatchObject({ linked: false, teams: [] });
    expect(await new AccountStore(dbName).getDevice()).toBeNull();
  });
});

describe('protección de los datos locales', () => {
  it('unirse, comprobar, salir y cerrar sesión no tocan los equipos ni los partidos del dispositivo', async () => {
    const local = new IndexedDbRepository(`local-${n}`);
    await createTeam(local, { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', maxSquad: 16 });
    const before = await local.readAll();
    const s = make(fakeApi(), `local-${n}-cuenta`);
    await s.join(CODE);
    await s.refresh();
    await s.leave('t1');
    await s.logout();
    expect(await local.readAll()).toEqual(before);
  });

  it('la sesión vive en su propia base de datos, no en la de equipos y partidos', async () => {
    const { ACCOUNT_DB_NAME } = await import('./store');
    const { DB_NAME } = await import('../data/indexedDbRepository');
    expect(ACCOUNT_DB_NAME).not.toBe(DB_NAME);
  });

  it('el nombre del dispositivo es genérico', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 15)')).toBe('Android');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0)')).toBe('Ordenador');
  });
});
