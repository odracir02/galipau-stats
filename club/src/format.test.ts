import { describe, expect, it } from 'vitest';
import { clubHash, errorMessage, isCompleteCode, isValidEmail, needsNewCode, normalizeCode, parseRoute, seasonsOf, type TeamSummary } from './format';

describe('validaciones', () => {
  it('correo', () => {
    expect(isValidEmail(' Ana@Example.test ')).toBe(true);
    expect(isValidEmail('ana@example')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('a b@example.test')).toBe(false);
  });

  it('código de seis cifras: se limpia al pegarlo', () => {
    expect(normalizeCode('123 456')).toBe('123456');
    expect(normalizeCode('12-34-56-78')).toBe('123456');
    expect(normalizeCode('abc')).toBe('');
    expect(isCompleteCode('123456')).toBe(true);
    expect(isCompleteCode('12345')).toBe(false);
  });
});

describe('mensajes de error', () => {
  it('códigos de la biblioteca y del servidor', () => {
    expect(errorMessage(400, 'INVALID_OTP')).toMatch(/no es correcto/);
    expect(errorMessage(400, 'OTP_EXPIRED')).toMatch(/caducado/);
    expect(errorMessage(403, 'TOO_MANY_ATTEMPTS')).toMatch(/Demasiados intentos/);
    expect(errorMessage(0, 'network')).toMatch(/conexión/);
    expect(errorMessage(429, undefined)).toMatch(/Espera unos minutos/);
    expect(errorMessage(429, 'TOO_MANY_REQUESTS')).toMatch(/Espera unos minutos/);
    expect(errorMessage(403, 'signup_closed')).toMatch(/todavía no está abierta/);
    expect(errorMessage(401, 'unauthorized')).toMatch(/Vuelve a entrar/);
    expect(errorMessage(500, 'internal')).toMatch(/servidor/);
    expect(errorMessage(400, 'bad_request', 'Nombre de club no válido.')).toBe('Nombre de club no válido.');
  });

  it('administradores: se muestra el motivo que da el servidor; sin acceso, mensaje genérico', () => {
    expect(errorMessage(409, 'ya_es_admin', 'Esa cuenta ya administra el club.')).toBe('Esa cuenta ya administra el club.');
    expect(errorMessage(403, 'owner_required', 'Solo el propietario puede hacerlo.')).toBe('Solo el propietario puede hacerlo.');
    expect(errorMessage(409, 'propietario_activo', 'Antes hay que transferir la propiedad del club.')).toBe('Antes hay que transferir la propiedad del club.');
    expect(errorMessage(404, 'not_found', 'No encontrado.')).toBe('No encontrado o sin acceso.');
    expect(errorMessage(409, 'conflict')).toBe('No se ha podido completar la operación.');
  });

  it('cuándo hay que pedir otro código', () => {
    expect(needsNewCode('OTP_EXPIRED')).toBe(true);
    expect(needsNewCode('TOO_MANY_ATTEMPTS')).toBe(true);
    expect(needsNewCode('INVALID_OTP')).toBe(false);
  });
});

describe('navegación', () => {
  it('rutas', () => {
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/entrar')).toEqual({ name: 'login', then: 'home' });
    expect(parseRoute('#/entrar/crear')).toEqual({ name: 'login', then: 'create' });
    expect(parseRoute('#/crear')).toEqual({ name: 'create' });
    expect(parseRoute('#/club/abc')).toEqual({ name: 'club', clubId: 'abc', section: 'resumen' });
    expect(parseRoute('#/club/abc/equipos')).toEqual({ name: 'club', clubId: 'abc', section: 'equipos' });
    expect(parseRoute('#/club/abc/inventada')).toEqual({ name: 'club', clubId: 'abc', section: 'resumen' });
    expect(clubHash('a b', 'codigos')).toBe('#/club/a%20b/codigos');
    expect(parseRoute(clubHash('a b', 'codigos'))).toEqual({ name: 'club', clubId: 'a b', section: 'codigos' });
  });

  it('temporadas de los equipos, de la más reciente a la más antigua', () => {
    const t = (season: string) => ({ season }) as TeamSummary;
    expect(seasonsOf([t('2025/26'), t('2026/27'), t('2026/27')])).toEqual(['2026/27', '2025/26']);
  });
});
