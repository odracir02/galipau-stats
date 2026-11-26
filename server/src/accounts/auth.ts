// Configuración de la biblioteca de autenticación (better-auth 1.7.28, versión exacta).
// Todo lo que afecta a la seguridad se fija aquí de forma explícita; ningún valor
// depende de NODE_ENV ni de los valores por defecto de la biblioteca.
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { captcha, emailOTP } from 'better-auth/plugins';
import type { Db } from '../db';
import type { AccountsConfig } from './config';
import type { CodePurpose } from './mail';
import { isUserDisabled, mayCreateAccount } from './policy';

/** Prefijo de todas las rutas de la biblioteca. */
export const AUTH_BASE_PATH = '/api/account/auth';
/**
 * Cookie de todo el host (Path=/), sin Domain: la reciben las rutas de cuentas y las
 * administrativas del club del mismo origen, nunca otro host ni subdominio. Recibirla
 * no concede nada: cada ruta exige sesión válida, cuenta activa y su propio permiso.
 */
export const AUTH_COOKIE_PATH = '/';
/** Rutas de código protegidas por Turnstile y por el filtro previo. */
export const OTP_SEND_PATH = '/email-otp/send-verification-otp';
export const OTP_SIGN_IN_PATH = '/sign-in/email-otp';
export const OTP_VERIFY_EMAIL_PATH = '/email-otp/verify-email';

export const SESSION_SECONDS = 60 * 60 * 24 * 7;

/** Opciones completas. Se exportan para comprobar el esquema en las pruebas. */
export function authOptions(db: Db, cfg: AccountsConfig): BetterAuthOptions {
  return {
    appName: 'GalipauStats',
    // El binding de D1 tal cual: la biblioteca lo detecta y usa su dialecto de D1.
    database: db as unknown as BetterAuthOptions['database'],
    secret: cfg.secret,
    baseURL: cfg.origin, // fija: nunca se deduce de la cabecera Host
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [cfg.origin],
    telemetry: { enabled: false },
    emailAndPassword: { enabled: false },
    user: {
      modelName: 'auth_user',
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    account: { modelName: 'auth_account', accountLinking: { enabled: false } },
    verification: { modelName: 'auth_verification' },
    session: {
      modelName: 'auth_session',
      expiresIn: SESSION_SECONDS,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 10,
      // Sin caché en cookie: cada petición consulta D1 y la revocación es inmediata.
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'auth_rate_limit',
      window: 60,
      max: 60,
      customRules: {
        [OTP_SEND_PATH]: { window: 60, max: 3 },
        [OTP_SIGN_IN_PATH]: { window: 60, max: 5 },
        [OTP_VERIFY_EMAIL_PATH]: { window: 60, max: 5 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Sin registro libre, solo se crea la cuenta de un correo invitado.
          async before(user) {
            if (!(await mayCreateAccount(db, user.email, cfg.publicSignup))) {
              throw APIError.fromStatus('BAD_REQUEST', { message: 'Invalid OTP', code: 'INVALID_OTP' });
            }
          },
        },
      },
      session: {
        create: {
          // Una cuenta desactivada no abre sesiones nuevas.
          async before(session) {
            if (await isUserDisabled(db, session.userId)) {
              throw APIError.fromStatus('FORBIDDEN', { message: 'Account disabled', code: 'ACCOUNT_DISABLED' });
            }
          },
        },
      },
    },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: 'gs',
      defaultCookieAttributes: { sameSite: 'strict', httpOnly: true, secure: true, path: AUTH_COOKIE_PATH },
      crossSubDomainCookies: { enabled: false },
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        storeOTP: 'hashed',
        resendStrategy: 'rotate',
        // El alta la controla el hook de usuario (invitación o registro libre).
        disableSignUp: false,
        sendVerificationOnSignUp: false,
        overrideDefaultEmailVerification: true,
        rateLimit: { window: 60, max: 3 },
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== 'sign-in' && type !== 'email-verification') return; // otros tipos no están habilitados
          await cfg.mailer.sendCode({ to: email, code: otp, purpose: type as CodePurpose });
        },
      }),
      ...(cfg.turnstileSecret
        ? [
            captcha({
              provider: 'cloudflare-turnstile',
              secretKey: cfg.turnstileSecret,
              endpoints: [OTP_SEND_PATH, OTP_SIGN_IN_PATH, OTP_VERIFY_EMAIL_PATH],
            }),
          ]
        : []),
    ],
  };
}

export function makeAuth(db: Db, cfg: AccountsConfig) {
  return betterAuth(authOptions(db, cfg));
}

export type Auth = ReturnType<typeof makeAuth>;
