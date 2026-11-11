import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createApi, RemoteError, type Api, type ClubRankingGroup } from './api';
import { ClubRankingsClient, groupLabel, initialGroup, isAccessLost, uniqueGroups } from './clubRankings';
import { AccountStore } from './store';

const BASE = 'https://api.example';
const TOKEN = 'token-de-prueba-no-real';
const SENIOR: ClubRankingGroup = { season: '2026/27', gender: 'male', group: 'senior' };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

let n = 0;
async function storeWithDevice(): Promise<AccountStore> {
  const store = new AccountStore(`rankings-club-${++n}`);
  await store.saveDevice({ deviceId: 'dev-1', token: TOKEN, joinedAt: '2026-11-01T10:00:00.000Z' });
  return store;
}

describe('cliente de los rankings del club', () => {
  it('pide los grupos y las clasificaciones sin caché, sin cookies y con el token solo en la cabecera', async () => {
    const fetch = fakeFetch(200, { groups: [] });
    const api = createApi({ baseUrl: BASE, fetch });
    await api.clubRankingGroups(TOKEN, 'club/1');
    await api.clubRankings(TOKEN, 'club/1', { ...SENIOR, group: 'senior & B' }, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    await api.clubRankings(TOKEN, 'club/1', SENIOR, []);
    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toBe(`${BASE}/api/clubs/club%2F1/rankings`);
    const q = new URL(urls[1]!).searchParams;
    expect([q.get('season'), q.get('gender'), q.get('group'), q.get('players')]).toEqual(['2026/27', 'male', 'senior & B', 'p1,p2,p3,p4,p5']);
    expect(new URL(urls[2]!).searchParams.has('players')).toBe(false);
    for (const [url, init] of fetch.mock.calls) {
      expect(init?.method).toBe('GET');
      expect(init?.cache).toBe('no-store');
      expect(init?.credentials).toBe('omit');
      expect(String(url)).not.toContain(TOKEN);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('401, 403 y 404 llegan como errores distinguibles; solo 403 y 404 significan acceso perdido', async () => {
    const kinds: string[] = [];
    for (const status of [401, 403, 404]) {
      const api = createApi({ baseUrl: BASE, fetch: fakeFetch(status, { error: 'x' }) });
      const e = await api.clubRankings(TOKEN, 'c', SENIOR, []).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RemoteError);
      kinds.push((e as RemoteError).kind);
    }
    expect(kinds).toEqual(['unauthorized', 'forbidden', 'not_found']);
    expect([401, 403, 404].map((_, i) => isAccessLost(new RemoteError(kinds[i] as RemoteError['kind'], '')))).toEqual([false, true, true]);
    expect(isAccessLost(new RemoteError('offline', ''))).toBe(false);
  });

  it('usa la credencial del dispositivo; sin credencial no pregunta al servidor', async () => {
    const api = { clubRankingGroups: vi.fn<Api['clubRankingGroups']>(async () => ({ groups: [SENIOR, SENIOR] })), clubRankings: vi.fn() } as unknown as Api;
    const client = new ClubRankingsClient(api, await storeWithDevice());
    expect(await client.groups('c')).toEqual([SENIOR]);
    expect(api.clubRankingGroups).toHaveBeenCalledWith(TOKEN, 'c');

    const empty = new ClubRankingsClient(api, new AccountStore(`rankings-club-${++n}`));
    await expect(empty.groups('c')).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(api.clubRankingGroups).toHaveBeenCalledTimes(1);
  });

  it('una credencial rechazada pide comprobar la sesión; un 403 no', async () => {
    const onUnauthorized = vi.fn();
    const api = {
      clubRankingGroups: vi.fn(async () => Promise.reject(new RemoteError('unauthorized', 'x'))),
      clubRankings: vi.fn(async () => Promise.reject(new RemoteError('forbidden', 'x'))),
    } as unknown as Api;
    const client = new ClubRankingsClient(api, await storeWithDevice(), onUnauthorized);
    await expect(client.groups('c')).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(client.rankings('c', SENIOR)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('no guarda nada en la cuenta del dispositivo (el navegador se comprueba en la prueba de extremo a extremo)', async () => {
    const store = await storeWithDevice();
    const save = vi.spyOn(store, 'saveDevice');
    const data = { season: '2026/27', gender: 'male', group: 'senior', computedAt: '', teams: [], rankings: [], mine: [] };
    const api = { clubRankingGroups: vi.fn(async () => ({ groups: [SENIOR] })), clubRankings: vi.fn(async () => data) } as unknown as Api;
    const client = new ClubRankingsClient(api, store);
    await client.groups('c');
    expect(await client.rankings('c', SENIOR, ['p1'])).toBe(data);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('grupos', () => {
  it('sin repetidos, en el orden del servidor, con un nombre legible', () => {
    const female: ClubRankingGroup = { season: '2026/27', gender: 'female', group: 'senior' };
    expect(uniqueGroups([SENIOR, female, { ...SENIOR }])).toEqual([SENIOR, female]);
    expect(groupLabel(SENIOR)).toBe('senior · Masculino · 2026/27');
    expect(groupLabel({ season: '2025/26', gender: 'mixed', group: 'alevín' })).toBe('alevín · Mixto · 2025/26');
  });
});

describe('grupo inicial', () => {
  const FEM: ClubRankingGroup = { season: '2026/27', gender: 'female', group: 'senior', teamIds: ['sfa'] };
  const MASC: ClubRankingGroup = { season: '2026/27', gender: 'male', group: 'senior', teamIds: ['sma', 'smb'] };
  const JUV: ClubRankingGroup = { season: '2026/27', gender: 'male', group: 'juvenil', teamIds: ['jm'] };

  it('el único grupo que, según el servidor, incluye el equipo abierto (aunque no sea el primero)', () => {
    expect(initialGroup([FEM, JUV, MASC], 'smb')).toBe(MASC);
    expect(initialGroup([FEM, JUV, MASC], 'sfa')).toBe(FEM);
    expect(initialGroup([FEM, JUV, MASC], 'jm')).toBe(JUV);
  });

  it('equipo sin grupo, sin equipo o lista vacía: el primero (o ninguno)', () => {
    expect(initialGroup([FEM, MASC], 'np')).toBe(FEM);
    expect(initialGroup([FEM, MASC], null)).toBe(FEM);
    expect(initialGroup([FEM, MASC], undefined)).toBe(FEM);
    expect(initialGroup([], 'sma')).toBeUndefined();
  });

  it('servidor anterior (sin teamIds) o dato no válido: el primero', () => {
    const old = [{ season: '2026/27', gender: 'female', group: 'senior' }, { season: '2026/27', gender: 'male', group: 'senior' }] as ClubRankingGroup[];
    expect(initialGroup(old, 'sma')).toBe(old[0]);
    const odd = [FEM, { ...MASC, teamIds: 'sma' as unknown as string[] }];
    expect(initialGroup(odd, 'sma')).toBe(FEM);
  });

  it('coincidencias ambiguas: el primero, sin elegir entre ellas', () => {
    const otra: ClubRankingGroup = { season: '2025/26', gender: 'male', group: 'senior', teamIds: ['sma'] };
    expect(initialGroup([FEM, MASC, otra], 'sma')).toBe(FEM);
  });

  it('el campo nuevo llega tal cual del servidor y no cambia el orden', async () => {
    const fetch = fakeFetch(200, { groups: [FEM, MASC] });
    const groups = (await createApi({ baseUrl: BASE, fetch }).clubRankingGroups(TOKEN, 'A')).groups;
    expect(groups).toEqual([FEM, MASC]);
    expect(uniqueGroups(groups)).toEqual([FEM, MASC]);
  });
});
