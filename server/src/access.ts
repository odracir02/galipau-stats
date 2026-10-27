// Verificación del JWT de Cloudflare Access (cabecera Cf-Access-Jwt-Assertion).
//
// Access autentica a la persona (proveedor de identidad + segundo factor) y
// firma un JWT RS256. Aquí solo se comprueba criptográficamente que el token es
// auténtico y vigente. Quién es administrador lo decide la base de datos
// (auth.ts), nunca el simple hecho de haber pasado por Access.
import { HttpError } from './errors';

export interface AccessConfig {
  /** https://<equipo>.cloudflareaccess.com */
  teamDomain: string;
  /** AUD de la aplicación de Access de administración. */
  adminAud: string;
  /** AUD de la aplicación de Access de operaciones críticas. */
  criticalAud: string;
  /**
   * Operaciones críticas habilitadas. El JWT de Access no indica qué factor se
   * usó ni cuándo, así que el Worker no puede comprobar el segundo factor
   * reciente: solo que el token es de la aplicación crítica. Por eso estas
   * operaciones están desactivadas hasta verificar a mano que Cloudflare pide
   * de verdad el segundo factor (docs/AUTENTICACION_ADMIN.md).
   */
  criticalEnabled: boolean;
}

export interface AccessClaims {
  email: string;
  sub: string;
  iat: number;
  exp: number;
  /** El token pertenece a la aplicación de operaciones críticas (no prueba por sí solo el segundo factor). */
  critical: boolean;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

const TEAM_DOMAIN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
/** Margen para diferencias de reloj. */
const LEEWAY_S = 60;
const JWKS_TTL_MS = 10 * 60_000;

/**
 * Configuración válida o null. Sin configuración completa, la administración
 * queda desactivada (nunca abierta): no hay modo de desarrollo que la salte.
 */
export function accessConfig(env: {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD_ADMIN?: string;
  ACCESS_AUD_CRITICAL?: string;
  ADMIN_CRITICAL_OPS?: string;
}): AccessConfig | null {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? '').trim().replace(/\/+$/, '');
  const adminAud = (env.ACCESS_AUD_ADMIN ?? '').trim();
  const criticalAud = (env.ACCESS_AUD_CRITICAL ?? '').trim();
  if (!TEAM_DOMAIN.test(teamDomain) || adminAud.length < 16 || criticalAud.length < 16 || adminAud === criticalAud) return null;
  return { teamDomain, adminAud, criticalAud, criticalEnabled: env.ADMIN_CRITICAL_OPS === 'enabled' };
}

// --- Claves públicas (JWKS) ----------------------------------------------------

let cache: { url: string; keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

/** Solo para pruebas. */
export function clearJwksCache(): void {
  cache = null;
}

async function loadKeys(url: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new HttpError(503, 'access_unavailable', 'No se pueden obtener las claves de Access.');
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
        'verify',
      ]),
    );
  }
  return keys;
}

async function keyFor(config: AccessConfig, kid: string, now: number): Promise<CryptoKey | undefined> {
  const url = `${config.teamDomain}/cdn-cgi/access/certs`;
  const fresh = cache && cache.url === url && now - cache.fetchedAt < JWKS_TTL_MS;
  if (!fresh || !cache!.keys.has(kid)) {
    // Clave desconocida: Access puede haber rotado. Se vuelve a pedir, como
    // mucho una vez por minuto, para no amplificar peticiones con kid inventados.
    if (!cache || cache.url !== url || now - cache.fetchedAt > 60_000) {
      cache = { url, keys: await loadKeys(url), fetchedAt: now };
    }
  }
  return cache!.keys.get(kid);
}

// --- Verificación ----------------------------------------------------------------

function b64urlDecode(part: string): Uint8Array<ArrayBuffer> {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(part))) as Record<string, unknown>;
}

const invalid = () => new HttpError(401, 'access_invalid', 'Credencial de administración no válida o caducada.');

/**
 * Verifica el token: algoritmo RS256 (ningún otro), firma con una clave del
 * equipo de Access, emisor, audiencia (admin o crítica), vigencia y correo.
 */
export async function verifyAccessJwt(token: string | null, config: AccessConfig, now = new Date()): Promise<AccessClaims> {
  if (!token) throw new HttpError(401, 'access_required', 'Se necesita iniciar sesión de administración.');
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid();
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(h);
    payload = decodeJson(p);
  } catch {
    throw invalid();
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw invalid();

  const nowMs = now.getTime();
  const key = await keyFor(config, header.kid, nowMs);
  if (!key) throw invalid();
  const ok = await crypto.subtle
    .verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`))
    .catch(() => false);
  if (!ok) throw invalid();

  const nowS = nowMs / 1000;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const critical = aud.includes(config.criticalAud);
  const admin = aud.includes(config.adminAud);
  if (payload.iss !== config.teamDomain || (!critical && !admin)) throw invalid();
  if (typeof payload.exp !== 'number' || payload.exp + LEEWAY_S < nowS) throw invalid();
  if (typeof payload.nbf === 'number' && payload.nbf - LEEWAY_S > nowS) throw invalid();
  if (typeof payload.iat !== 'number' || payload.iat - LEEWAY_S > nowS) throw invalid();
  // Solo tokens de personas: los de servicio no llevan correo.
  if (payload.type !== 'app' || typeof payload.email !== 'string' || typeof payload.sub !== 'string' || !payload.sub) throw invalid();

  return { email: payload.email.trim().toLowerCase(), sub: payload.sub, iat: payload.iat, exp: payload.exp, critical };
}
