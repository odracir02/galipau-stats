// Generación y hash de códigos y tokens con Web Crypto (disponible en Workers y
// en Node). Los secretos nunca se guardan en claro: solo su HMAC con una clave
// del servidor (TOKEN_PEPPER, configurada como secret de Cloudflare).

/** Alfabeto sin caracteres confundibles (sin 0/O, 1/I/L, U). 30 símbolos. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Longitud de los códigos de invitación: 12 símbolos ≈ 59 bits. */
export const INVITE_CODE_LENGTH = 12;

/** Código de invitación legible, p. ej. «K7QM-4XRP-TB9H». Sin sesgo de módulo. */
export function generateInviteCode(length = INVITE_CODE_LENGTH): string {
  const n = CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit && out.length < length) out += CODE_ALPHABET[b % n];
    }
  }
  return out.replace(/(.{4})(?=.)/g, '$1-');
}

/** Normaliza lo que teclea el usuario: mayúsculas, sin guiones ni espacios. */
export function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Token de dispositivo: 32 bytes aleatorios en base64url. */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * HMAC-SHA-256 en hexadecimal. Los códigos y tokens son aleatorios y largos, así
 * que no hace falta un hash lento; la clave impide comprobar códigos con una
 * copia robada de la base de datos.
 */
export async function hashSecret(secret: string, pepper: string): Promise<string> {
  if (!pepper) throw new Error('Falta TOKEN_PEPPER');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(secret));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
