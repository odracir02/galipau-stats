// Emisor de pruebas que imita a Cloudflare Access: claves RSA reales generadas
// en cada prueba y un servidor de claves (JWKS) simulado. Nada de esto existe
// fuera de las pruebas.
import { vi } from 'vitest';
import { clearJwksCache, type AccessConfig } from '../src/access';

export const TEAM = 'https://galipau-pruebas.cloudflareaccess.com';
export const CONFIG: AccessConfig = {
  teamDomain: TEAM,
  adminAud: 'aud-admin-0123456789abcdef',
  criticalAud: 'aud-critical-0123456789abcdef',
  // En las pruebas se habilitan explícitamente; en wrangler.jsonc están desactivadas.
  criticalEnabled: true,
};
export const ACCESS_ENV = {
  ACCESS_TEAM_DOMAIN: CONFIG.teamDomain,
  ACCESS_AUD_ADMIN: CONFIG.adminAud,
  ACCESS_AUD_CRITICAL: CONFIG.criticalAud,
  ADMIN_CRITICAL_OPS: 'enabled',
};

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

export interface Issuer {
  kid: string;
  jwk: JsonWebKey & { kid: string };
  sign(payload: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

export async function makeIssuer(kid = 'clave-1'): Promise<Issuer> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey), kid };
  return {
    kid,
    jwk,
    async sign(payload, header = {}) {
      const h = enc({ alg: 'RS256', kid, typ: 'JWT', ...header });
      const p = enc(payload);
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`)));
      return `${h}.${p}.${b64url(sig)}`;
    },
  };
}

/** Token como los de Access para una persona, válido 10 minutos desde `now`. */
export function claimsFor(email: string, { aud = CONFIG.adminAud, now = Date.now(), sub = `sub-${email}`, ...extra }: Record<string, unknown> = {}) {
  const t = Math.floor((now as number) / 1000);
  return { aud: [aud], email, sub, iat: t, nbf: t, exp: t + 600, iss: TEAM, type: 'app', identity_nonce: 'n', country: 'ES', ...extra };
}

/** Sirve las claves públicas en la URL de certificados de Access; cuenta las peticiones. */
export function serveJwks(keys: () => (JsonWebKey & { kid: string })[], { clear = true } = {}): { calls: () => number } {
  if (clear) clearJwksCache();
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== `${TEAM}/cdn-cgi/access/certs`) throw new Error(`Petición inesperada: ${url}`);
      calls++;
      return new Response(JSON.stringify({ keys: keys(), public_certs: [] }), { headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return { calls: () => calls };
}
