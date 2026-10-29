import { describe, expect, it, vi } from 'vitest';
import { createApi, isTransient, normalizeCode, RemoteError } from './api';

const BASE = 'https://api.example';
const TOKEN = 'token-de-prueba-no-real';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RemoteError) return e.kind;
    throw e;
  }
  return 'sin error';
}

describe('cliente del servidor', () => {
  it('canje: POST con el código en el cuerpo; sin token no envía Authorization', async () => {
    const fetch = fakeFetch(201, { deviceId: 'd1', role: 'coach', team: { id: 't1' }, token: 'nuevo' });
    const api = createApi({ baseUrl: `${BASE}/`, fetch });
    await api.redeem('ABCD2345EFGH', null, 'iPhone');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/invites/redeem`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ code: 'ABCD2345EFGH', deviceLabel: 'iPhone' });
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(init?.credentials).toBe('omit');
  });

  it('el token solo viaja en la cabecera Authorization, nunca en la URL', async () => {
    const fetch = fakeFetch(200, { deviceId: 'd1', teams: [] });
    const api = createApi({ baseUrl: BASE, fetch });
    await api.getSession(TOKEN);
    await api.leaveTeam(TOKEN, 'equipo/raro');
    await api.logout(TOKEN);
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).not.toContain(TOKEN);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    }
    expect(fetch.mock.calls[1]![0]).toBe(`${BASE}/api/session/teams/equipo%2Fraro/leave`);
  });

  it('traduce los errores del servidor sin revelar detalles', async () => {
    const cases: [number, unknown, string][] = [
      [404, { error: 'invalid_code' }, 'invalid_code'],
      [404, { error: 'not_found' }, 'not_found'],
      [401, { error: 'unauthorized' }, 'unauthorized'],
      [429, { error: 'too_many_attempts' }, 'rate_limited'],
      [409, { error: 'redeem_conflict' }, 'conflict'],
      [400, { error: 'bad_request' }, 'bad_request'],
      [500, { error: 'internal' }, 'server'],
      [502, 'no es JSON', 'server'],
    ];
    for (const [status, body, kind] of cases) {
      const api = createApi({ baseUrl: BASE, fetch: fakeFetch(status, body) });
      expect(await kindOf(api.redeem('X', null, null)), `${status}`).toBe(kind);
    }
    const err = (await createApi({ baseUrl: BASE, fetch: fakeFetch(404, { error: 'invalid_code', message: 'detalle' }) })
      .redeem('X', null, null)
      .catch((e: unknown) => e)) as RemoteError;
    expect(err.message).toBe('Código no válido o caducado.');
  });

  it('sin red: «offline»; sin respuesta a tiempo: «timeout»; ambos se pueden reintentar', async () => {
    const down = createApi({ baseUrl: BASE, fetch: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))) });
    expect(await kindOf(down.getSession(TOKEN))).toBe('offline');
    const slow = createApi({
      baseUrl: BASE,
      timeoutMs: 10,
      fetch: vi.fn(
        (_u: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('abort', 'AbortError')))),
      ),
    });
    expect(await kindOf(slow.getSession(TOKEN))).toBe('timeout');
    expect(isTransient(new RemoteError('offline', ''))).toBe(true);
    expect(isTransient(new RemoteError('server', ''))).toBe(true);
    expect(isTransient(new RemoteError('unauthorized', ''))).toBe(false);
  });

  it('normaliza el código como el servidor', () => {
    expect(normalizeCode(' abcd-2345 efgh ')).toBe('ABCD2345EFGH');
  });
});
