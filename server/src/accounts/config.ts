// Configuración de las cuentas de club. Dos interruptores independientes:
//
//   ACCOUNTS_ENABLED        «true» = la función está publicada en este entorno.
//                           Cualquier otro valor (o ausente) = no existe: el Worker
//                           se comporta exactamente como antes y ninguna ruta nueva
//                           responde.
//   ACCOUNTS_PUBLIC_SIGNUP  «true» = registro libre: cualquiera puede crear su cuenta,
//                           verificar su correo y crear su club como propietario.
//                           Cualquier otro valor = solo pueden crear cuenta quienes
//                           tienen una invitación pendiente.
//
// Nada depende de NODE_ENV ni de valores por defecto que cambien entre entornos:
// si falta algo imprescindible, las rutas de cuentas responden 503 y no se arrancan.
import type { Db } from '../db';
import { HttpError } from '../errors';
import type { AccountMailer } from './mail';

export interface AccountsEnv {
  DB: Db;
  ENVIRONMENT: string;
  TOKEN_PEPPER?: string;
  ACCOUNTS_ENABLED?: string;
  ACCOUNTS_PUBLIC_SIGNUP?: string;
  /** Origen exacto del panel de cuentas (mismo origen que la API de cuentas). */
  ACCOUNTS_ORIGIN?: string;
  /** Clave de firma de las sesiones. Secret, al menos 32 caracteres. */
  BETTER_AUTH_SECRET?: string;
  /** Clave secreta de Turnstile. Secret. Obligatoria fuera de local y pruebas. */
  TURNSTILE_SECRET_KEY?: string;
  /** Clave de sitio de Turnstile (pública, para el panel). Va siempre junto a la secreta. */
  TURNSTILE_SITE_KEY?: string;
  /** Orígenes de la PWA deportiva; el primero es el enlace «Ya tengo código» del panel. */
  ALLOWED_ORIGINS?: string;
  /** Envío de correo inyectado (pruebas). En otros entornos se configurará el proveedor. */
  ACCOUNTS_MAILER?: AccountMailer;
}

export interface AccountsConfig {
  origin: string;
  secret: string;
  pepper: string;
  turnstileSecret: string | null;
  turnstileSiteKey: string | null;
  publicSignup: boolean;
  /** Dirección de la PWA deportiva (o null si no hay ninguna configurada). */
  appUrl: string | null;
  mailer: AccountMailer;
}

const MIN_SECRET_LENGTH = 32;
/** Entornos sin servicios externos: Turnstile puede faltar y el correo puede ser simulado. */
const OFFLINE_ENVIRONMENTS = new Set(['local', 'test']);

export const accountsEnabled = (env: { ACCOUNTS_ENABLED?: string }) => env.ACCOUNTS_ENABLED === 'true';
export const publicSignupEnabled = (env: { ACCOUNTS_PUBLIC_SIGNUP?: string }) => env.ACCOUNTS_PUBLIC_SIGNUP === 'true';

const notConfigured = (what: string) =>
  new HttpError(503, 'accounts_not_configured', 'Las cuentas no están configuradas en este entorno.', { missing: what });

/** Valida la configuración. Lanza 503 si falta algo; nunca sigue con valores inseguros. */
export function accountsConfig(env: AccountsEnv): AccountsConfig {
  const offline = OFFLINE_ENVIRONMENTS.has(env.ENVIRONMENT);
  const origin = env.ACCOUNTS_ORIGIN ?? '';
  let parsed: URL | null;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = null;
  }
  const localHost = parsed?.hostname === 'localhost' || parsed?.hostname === '127.0.0.1';
  if (!parsed || parsed.origin !== origin || !(parsed.protocol === 'https:' || (offline && localHost && parsed.protocol === 'http:'))) {
    throw notConfigured('ACCOUNTS_ORIGIN');
  }
  const secret = env.BETTER_AUTH_SECRET ?? '';
  if (secret.length < MIN_SECRET_LENGTH) throw notConfigured('BETTER_AUTH_SECRET');
  const pepper = env.TOKEN_PEPPER ?? '';
  if (pepper.length < MIN_SECRET_LENGTH) throw notConfigured('TOKEN_PEPPER');
  const turnstileSecret = env.TURNSTILE_SECRET_KEY || null;
  if (!turnstileSecret && !offline) throw notConfigured('TURNSTILE_SECRET_KEY');
  // La clave de sitio y la secreta van juntas: con una sola, el panel no podría
  // obtener el token que el servidor exige (o lo pediría sin comprobarlo).
  const turnstileSiteKey = env.TURNSTILE_SITE_KEY || null;
  if (!turnstileSecret !== !turnstileSiteKey) throw notConfigured(turnstileSecret ? 'TURNSTILE_SITE_KEY' : 'TURNSTILE_SECRET_KEY');
  const mailer = env.ACCOUNTS_MAILER ?? (env.ENVIRONMENT === 'local' ? consoleMailer : null);
  if (!mailer) throw notConfigured('correo');
  const firstApp = (env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).find(Boolean) ?? null;
  return {
    origin,
    secret,
    pepper,
    turnstileSecret,
    turnstileSiteKey,
    publicSignup: publicSignupEnabled(env),
    appUrl: firstApp && /^https?:\/\/[^/]+$/.test(firstApp) ? `${firstApp}/` : null,
    mailer,
  };
}

/**
 * Datos públicos para el panel antes de entrar: si el alta de clubes está abierta,
 * la clave de sitio de Turnstile y el enlace a la PWA. Nada privado.
 */
export function publicAccountsInfo(cfg: AccountsConfig) {
  return { publicSignup: cfg.publicSignup, turnstileSiteKey: cfg.turnstileSiteKey, appUrl: cfg.appUrl };
}

/**
 * Política de seguridad del panel de clubes: solo archivos propios y la propia API;
 * con Turnstile configurado, además su script y su marco.
 */
export function clubPanelCsp(cfg: AccountsConfig): string {
  const turnstile = cfg.turnstileSiteKey ? ' https://challenges.cloudflare.com' : '';
  return [
    "default-src 'self'",
    `script-src 'self'${turnstile}`,
    `frame-src ${cfg.turnstileSiteKey ? 'https://challenges.cloudflare.com' : "'none'"}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** Solo `wrangler dev` local: el código se ve en la consola en lugar de enviarse. */
const consoleMailer: AccountMailer = {
  async sendCode({ to, code, purpose }) {
    console.log(`[cuentas · local] código ${purpose} para ${to}: ${code}`);
  },
};
