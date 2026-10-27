import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessConfig, clearJwksCache, verifyAccessJwt } from '../src/access';
import { HttpError } from '../src/errors';
import { claimsFor, CONFIG, makeIssuer, serveJwks, TEAM, type Issuer } from './accessKeys';

let issuer: Issuer;
let jwks: { calls: () => number };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof HttpError) return `${e.status} ${e.code}`;
    throw e;
  }
}

beforeEach(async () => {
  issuer = await makeIssuer();
  jwks = serveJwks(() => [issuer.jwk]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearJwksCache();
});

describe('configuración de Access', () => {
  it('sin configuración completa y válida, la administración queda desactivada', () => {
    const ok = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD_ADMIN: CONFIG.adminAud, ACCESS_AUD_CRITICAL: CONFIG.criticalAud };
    // Las operaciones críticas solo se habilitan con el valor exacto «enabled».
    expect(accessConfig(ok)).toEqual({ ...CONFIG, criticalEnabled: false });
    expect(accessConfig({ ...ok, ADMIN_CRITICAL_OPS: 'true' })?.criticalEnabled).toBe(false);
    expect(accessConfig({ ...ok, ADMIN_CRITICAL_OPS: 'enabled' })).toEqual(CONFIG);
    expect(accessConfig({ ...ok, ACCESS_TEAM_DOMAIN: TEAM + '/', ADMIN_CRITICAL_OPS: 'enabled' })).toEqual(CONFIG);
    expect(accessConfig({})).toBeNull();
    expect(accessConfig({ ...ok, ACCESS_TEAM_DOMAIN: '' })).toBeNull();
    expect(accessConfig({ ...ok, ACCESS_TEAM_DOMAIN: 'http://galipau-pruebas.cloudflareaccess.com' })).toBeNull();
    expect(accessConfig({ ...ok, ACCESS_TEAM_DOMAIN: 'https://atacante.example.com' })).toBeNull();
    expect(accessConfig({ ...ok, ACCESS_TEAM_DOMAIN: 'https://x.cloudflareaccess.com.atacante.com' })).toBeNull();
    expect(accessConfig({ ...ok, ACCESS_AUD_ADMIN: '' })).toBeNull();
    expect(accessConfig({ ...ok, ACCESS_AUD_CRITICAL: CONFIG.adminAud })).toBeNull();
  });
});

describe('verificación del JWT de Access', () => {
  it('acepta un token auténtico y distingue la aplicación crítica', async () => {
    const normal = await verifyAccessJwt(await issuer.sign(claimsFor('Owner@Example.com')), CONFIG);
    expect(normal).toMatchObject({ email: 'owner@example.com', sub: 'sub-Owner@Example.com', critical: false });
    const critical = await verifyAccessJwt(await issuer.sign(claimsFor('owner@example.com', { aud: CONFIG.criticalAud })), CONFIG);
    expect(critical.critical).toBe(true);
    // La audiencia también puede venir como cadena.
    const single = { ...claimsFor('owner@example.com'), aud: CONFIG.adminAud };
    expect(await codeOf(verifyAccessJwt(await issuer.sign(single), CONFIG))).toBe('ok');
  });

  it('sin token: 401', async () => {
    expect(await codeOf(verifyAccessJwt(null, CONFIG))).toBe('401 access_required');
    expect(await codeOf(verifyAccessJwt('', CONFIG))).toBe('401 access_required');
  });

  it('rechaza tokens mal formados', async () => {
    for (const t of ['abc', 'a.b', 'a.b.c', '...', `${btoa('{}')}.${btoa('{}')}.x`]) {
      expect(await codeOf(verifyAccessJwt(t, CONFIG)), t).toBe('401 access_invalid');
    }
  });

  it('rechaza algoritmos distintos de RS256 (alg none, HS256)', async () => {
    const [, p] = (await issuer.sign(claimsFor('owner@example.com'))).split('.');
    const none = `${btoa(JSON.stringify({ alg: 'none', kid: issuer.kid })).replace(/=+$/, '')}.${p}.`;
    expect(await codeOf(verifyAccessJwt(none, CONFIG))).toBe('401 access_invalid');
    const hs = await issuer.sign(claimsFor('owner@example.com'), { alg: 'HS256' });
    expect(await codeOf(verifyAccessJwt(hs, CONFIG))).toBe('401 access_invalid');
  });

  it('rechaza firmas de otra clave, aunque usen el mismo identificador de clave', async () => {
    const impostor = await makeIssuer(issuer.kid);
    expect(await codeOf(verifyAccessJwt(await impostor.sign(claimsFor('owner@example.com')), CONFIG))).toBe('401 access_invalid');
  });

  it('rechaza tokens manipulados después de firmar', async () => {
    const [h, , s] = (await issuer.sign(claimsFor('alguien@example.com'))).split('.');
    const forged = btoa(JSON.stringify(claimsFor('owner@example.com'))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await codeOf(verifyAccessJwt(`${h}.${forged}.${s}`, CONFIG))).toBe('401 access_invalid');
  });

  it('rechaza emisor, audiencia, caducidad, fechas futuras, tokens de servicio y sin correo', async () => {
    const now = Date.now();
    const cases: Record<string, Record<string, unknown>> = {
      emisor: claimsFor('o@example.com', { iss: 'https://otro.cloudflareaccess.com' }),
      audiencia: claimsFor('o@example.com', { aud: 'aud-de-otra-aplicacion-000000' }),
      caducado: claimsFor('o@example.com', { exp: Math.floor(now / 1000) - 120 }),
      futuro_nbf: claimsFor('o@example.com', { nbf: Math.floor(now / 1000) + 600 }),
      futuro_iat: claimsFor('o@example.com', { iat: Math.floor(now / 1000) + 600 }),
      servicio: claimsFor('o@example.com', { type: 'service', email: undefined }),
      sin_correo: claimsFor('o@example.com', { email: undefined }),
      sin_sub: claimsFor('o@example.com', { sub: '' }),
    };
    for (const [name, payload] of Object.entries(cases)) {
      expect(await codeOf(verifyAccessJwt(await issuer.sign(payload), CONFIG)), name).toBe('401 access_invalid');
    }
  });

  it('admite un pequeño desfase de reloj', async () => {
    const t = Math.floor(Date.now() / 1000);
    const payload = claimsFor('o@example.com', { exp: t - 30, iat: t + 30, nbf: t + 30 });
    expect(await codeOf(verifyAccessJwt(await issuer.sign(payload), CONFIG))).toBe('ok');
  });
});

describe('claves públicas de Access', () => {
  it('se guardan en caché y solo se piden a la URL del equipo', async () => {
    for (let i = 0; i < 5; i++) await verifyAccessJwt(await issuer.sign(claimsFor('o@example.com')), CONFIG);
    expect(jwks.calls()).toBe(1);
  });

  it('identificadores de clave inventados no provocan una petición por token', async () => {
    const t0 = new Date('2026-10-27T10:00:00Z');
    await verifyAccessJwt(await issuer.sign(claimsFor('o@example.com', { now: t0.getTime() })), CONFIG, t0);
    for (let i = 0; i < 20; i++) {
      const fake = await issuer.sign(claimsFor('o@example.com', { now: t0.getTime() }), { kid: `inventada-${i}` });
      expect(await codeOf(verifyAccessJwt(fake, CONFIG, new Date(t0.getTime() + 1000)))).toBe('401 access_invalid');
    }
    expect(jwks.calls()).toBe(1);
  });

  it('tras una rotación, la clave nueva se obtiene sola', async () => {
    const t0 = new Date('2026-10-27T10:00:00Z');
    await verifyAccessJwt(await issuer.sign(claimsFor('o@example.com', { now: t0.getTime() })), CONFIG, t0);
    const rotated = await makeIssuer('clave-2');
    // La caché sigue llena con la clave antigua: debe recargarse sola.
    jwks = serveJwks(() => [issuer.jwk, rotated.jwk], { clear: false });
    const later = new Date(t0.getTime() + 2 * 60_000);
    const token = await rotated.sign(claimsFor('o@example.com', { now: later.getTime() }));
    expect(await codeOf(verifyAccessJwt(token, CONFIG, later))).toBe('ok');
    expect(jwks.calls()).toBe(1);
  });

  it('si no se pueden obtener las claves, no se deja pasar a nadie', async () => {
    clearJwksCache();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('fallo', { status: 500 })));
    expect(await codeOf(verifyAccessJwt(await issuer.sign(claimsFor('o@example.com')), CONFIG))).toBe('503 access_unavailable');
  });
});
