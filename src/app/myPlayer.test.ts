// «Mi jugador»: preferencia local por equipo y su ciclo de vida con la sesión
// y la consulta reales (servidor simulado). Datos sintéticos.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteError, type Api, type RemoteTeam, type SessionInfo, type TeamSnapshot } from '../remote/api';
import { RemoteSession } from '../remote/session';
import { AccountStore } from '../remote/store';
import { ClubViewer, ViewerStore } from '../remote/viewer';
import { MyPlayerPreferences } from './myPlayer';

/** localStorage en memoria, con la misma interfaz. */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

const team = (id: string, status: RemoteTeam['status'] = 'active'): RemoteTeam => ({
  teamId: id,
  role: 'viewer',
  status,
  name: 'Infantil Masculino A',
  code: 'IMA2627',
  season: '2026/27',
  clubId: 'club-1',
  clubName: 'Club de prueba',
});
const snapshot = (id: string): TeamSnapshot => ({
  team: { id, name: 'Infantil Masculino A', code: 'IMA2627', season: '2026/27' },
  club: { id: 'club-1', name: 'Club de prueba' },
  seq: 1,
  players: [],
  matches: [],
  events: [],
});

let storage: MemoryStorage;
let prefs: MyPlayerPreferences;

beforeEach(() => {
  storage = new MemoryStorage();
  prefs = new MyPlayerPreferences(() => storage);
});

describe('preferencia «Mi jugador»', () => {
  it('elegir, cambiar y «Ahora no»: solo el identificador o la marca, nada más', () => {
    expect(prefs.get('t1')).toBeNull();
    expect(prefs.choose('t1', 'jugador-7')).toBe(true);
    expect(prefs.get('t1')).toEqual({ playerId: 'jugador-7' });
    prefs.choose('t1', 'jugador-9');
    expect(prefs.get('t1')).toEqual({ playerId: 'jugador-9' });
    prefs.skip('t1');
    expect(prefs.get('t1')).toEqual({ skipped: true });
    prefs.choose('t1', 'jugador-9');
    expect(storage.getItem('galipaustats.miJugador.t1')).toBe('{"playerId":"jugador-9"}');
    expect(storage.length).toBe(1);
    // Un identificador vacío no se guarda.
    expect(prefs.choose('t1', '')).toBe(false);
    expect(prefs.get('t1')).toEqual({ playerId: 'jugador-9' });
  });

  it('cada equipo, la suya; olvidar una no toca las demás ni otros datos del navegador', () => {
    storage.setItem('otra-cosa', 'intacta');
    prefs.choose('t1', 'a');
    prefs.choose('t2', 'b');
    prefs.skip('t3');
    prefs.forget('t2');
    expect(prefs.get('t1')).toEqual({ playerId: 'a' });
    expect(prefs.get('t2')).toBeNull();
    expect(prefs.get('t3')).toEqual({ skipped: true });
    expect(prefs.teams().sort()).toEqual(['t1', 't3']);
    expect(storage.getItem('otra-cosa')).toBe('intacta');
  });

  it('se conserva al cerrar y volver a abrir la aplicación', () => {
    prefs.choose('t1', 'jugador-7');
    const reopened = new MyPlayerPreferences(() => storage);
    expect(reopened.get('t1')).toEqual({ playerId: 'jugador-7' });
  });

  it('datos ausentes, antiguos o incorrectos: sin preferencia y sin errores', () => {
    for (const raw of ['', 'no-es-json', 'null', '7', '"jugador"', '[]', '{}', '{"playerId":7}', '{"playerId":""}', '{"skipped":"si"}', `{"playerId":"${'x'.repeat(201)}"}`]) {
      storage.setItem('galipaustats.miJugador.t1', raw);
      expect(prefs.get('t1')).toBeNull();
    }
    // Campos de más (nombre, dorsal…) no se devuelven.
    storage.setItem('galipaustats.miJugador.t1', '{"playerId":"p","name":"Ana","number":7}');
    expect(prefs.get('t1')).toEqual({ playerId: 'p' });
    // Elegir de nuevo sustituye lo que hubiera.
    prefs.choose('t1', 'jugador-7');
    expect(prefs.get('t1')).toEqual({ playerId: 'jugador-7' });
  });

  it('sin almacenamiento disponible (modo privado, bloqueado o lleno), la aplicación sigue', () => {
    const none = new MyPlayerPreferences(() => null);
    expect(none.get('t1')).toBeNull();
    expect(none.choose('t1', 'a')).toBe(false);
    expect(none.skip('t1')).toBe(false);
    expect(() => none.forget('t1')).not.toThrow();
    expect(none.teams()).toEqual([]);
    const broken = new MyPlayerPreferences(() => {
      throw new DOMException('bloqueado', 'SecurityError');
    });
    expect(broken.get('t1')).toBeNull();
    expect(broken.choose('t1', 'a')).toBe(false);
    const full = new MemoryStorage();
    full.setItem = () => {
      throw new DOMException('lleno', 'QuotaExceededError');
    };
    expect(new MyPlayerPreferences(() => full).choose('t1', 'a')).toBe(false);
  });

  it('avisa de los cambios (para las pantallas)', () => {
    const seen = vi.fn();
    const off = prefs.subscribe(seen);
    prefs.choose('t1', 'a');
    prefs.skip('t1');
    prefs.forget('t1');
    prefs.forget('t1');
    off();
    prefs.choose('t1', 'b');
    expect(seen).toHaveBeenCalledTimes(3);
  });
});

// --- Ciclo de vida con la sesión y la consulta --------------------------------------

function fakeApi() {
  return {
    redeem: vi.fn<Api['redeem']>(),
    getSession: vi.fn<Api['getSession']>(async (): Promise<SessionInfo> => ({ deviceId: 'dev-1', teams: [team('t1'), team('t2')] })),
    leaveTeam: vi.fn<Api['leaveTeam']>(async () => undefined),
    logout: vi.fn<Api['logout']>(async () => undefined),
    syncPlayer: vi.fn<Api['syncPlayer']>(),
    syncMatch: vi.fn<Api['syncMatch']>(),
    syncEvent: vi.fn<Api['syncEvent']>(),
    snapshot: vi.fn<Api['snapshot']>(async (_token, id) => snapshot(id)),
    changes: vi.fn<Api['changes']>(),
    takeControl: vi.fn<Api['takeControl']>(),
  };
}

let n = 0;
async function setup() {
  n++;
  const api = fakeApi();
  const account = new AccountStore(`cuenta-mi-jugador-${n}`);
  await account.saveDevice({ deviceId: 'dev-1', token: 'token-de-prueba', joinedAt: '2026-10-29T09:00:00.000Z' });
  const session = new RemoteSession(api as unknown as Api, account, { sleep: async () => undefined, retryDelays: [1, 1], label: () => 'iPhone' });
  const viewer = new ClubViewer(api as unknown as Api, account, new ViewerStore(`consulta-mi-jugador-${n}`));
  await session.refresh();
  prefs.followSession(session);
  prefs.followViewer(viewer);
  prefs.choose('t1', 'jugador-7');
  prefs.choose('t2', 'jugador-4');
  return { api, session, viewer };
}

describe('ciclo de vida de «Mi jugador»', () => {
  it('sin conexión, servidor caído o versión que hay que actualizar (503): se conserva', async () => {
    const { api, session, viewer } = await setup();
    for (const e of [
      new RemoteError('offline', 'sin conexión'),
      new RemoteError('timeout', 'tarda'),
      new RemoteError('server', 'caído', 500),
      new RemoteError('server', 'actualiza', 503, 'update_required'),
    ]) {
      api.getSession.mockRejectedValueOnce(e).mockRejectedValueOnce(e).mockRejectedValueOnce(e);
      await session.refresh();
      api.snapshot.mockRejectedValueOnce(e);
      await viewer.refresh(team('t1'));
    }
    expect(session.getState().problem).not.toBeNull();
    expect(prefs.get('t1')).toEqual({ playerId: 'jugador-7' });
    expect(prefs.get('t2')).toEqual({ playerId: 'jugador-4' });
  });

  it('club inactivo: el equipo sigue en la sesión y la preferencia se conserva', async () => {
    const { api, session } = await setup();
    api.getSession.mockResolvedValue({ deviceId: 'dev-1', teams: [team('t1', 'unavailable'), team('t2')] });
    await session.refresh();
    expect(prefs.get('t1')).toEqual({ playerId: 'jugador-7' });
  });

  it('salir del equipo: se olvida solo la de ese equipo', async () => {
    const { api, session } = await setup();
    api.getSession.mockResolvedValue({ deviceId: 'dev-1', teams: [team('t2')] });
    await session.leave('t1');
    expect(prefs.get('t1')).toBeNull();
    expect(prefs.get('t2')).toEqual({ playerId: 'jugador-4' });
  });

  it('el servidor confirma que ya no hay permiso para un equipo: se olvida (sesión o consulta)', async () => {
    const { api, session, viewer } = await setup();
    // La consulta recibe 403: sin acceso a t1.
    api.snapshot.mockRejectedValueOnce(new RemoteError('forbidden', 'sin permiso', 403));
    await viewer.refresh(team('t1'));
    expect(prefs.get('t1')).toBeNull();
    expect(prefs.get('t2')).toEqual({ playerId: 'jugador-4' });
    // La comprobación de la sesión ya no incluye t2.
    api.getSession.mockResolvedValue({ deviceId: 'dev-1', teams: [] });
    await session.refresh();
    expect(prefs.get('t2')).toBeNull();
  });

  it('credencial retirada (401) o sesión cerrada: se olvidan todas', async () => {
    const { api, session } = await setup();
    storage.setItem('otra-cosa', 'intacta');
    api.getSession.mockRejectedValue(new RemoteError('unauthorized', 'retirada', 401));
    await session.refresh();
    expect(session.getState().linked).toBe(false);
    expect(prefs.teams()).toEqual([]);
    expect(storage.getItem('otra-cosa')).toBe('intacta');
    const again = await setup();
    await again.session.logout();
    expect(prefs.teams()).toEqual([]);
  });

  it('un jugador que cambia de nombre o dorsal, o queda inactivo: la elección no se toca', async () => {
    const { api, session, viewer } = await setup();
    api.snapshot.mockResolvedValueOnce({
      ...snapshot('t1'),
      players: [{ version: 2, player: { id: 'jugador-7', teamId: 't1', name: 'Otro nombre', number: 11, position: 'field', active: false, createdAt: 'a', updatedAt: 'b' } }],
    });
    await viewer.refresh(team('t1'));
    await session.refresh();
    expect(prefs.get('t1')).toEqual({ playerId: 'jugador-7' });
  });
});
