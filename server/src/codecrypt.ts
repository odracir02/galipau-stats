// Cifrado de los códigos de invitación para poder volver a mostrarlos.
//
// AES-256-GCM con una clave del servidor (secret INVITE_CODE_KEY, 32 bytes en
// base64url), distinta de TOKEN_PEPPER. Cada código lleva como datos asociados
// la invitación, el equipo y el rol: un texto cifrado copiado a otra fila (por
// ejemplo, el del código de entrenador a la fila de consulta) no se descifra.
// El formato lleva versión («v1.») para poder rotar la clave en el futuro.
import { HttpError } from './errors';

const VERSION = 'v1';
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const unavailable = () => new HttpError(503, 'codes_unavailable', 'Los códigos no están disponibles en este entorno.');

/** Importa la clave; sin clave válida, los códigos no se pueden crear ni mostrar (503). */
export async function codeKey(secret: string | undefined): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromB64url((secret ?? '').trim());
  } catch {
    throw unavailable();
  }
  if (raw.length !== 32) throw unavailable();
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface CodeContext {
  inviteId: string;
  teamId: string;
  role: string;
}

const aad = (c: CodeContext) => enc.encode(`galipaustats:invite:${c.inviteId}:${c.teamId}:${c.role}`);

export async function encryptCode(key: CryptoKey, code: string, context: CodeContext): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(context) }, key, enc.encode(code)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `${VERSION}.${b64url(out)}`;
}

/** Descifra; null si no hay copia cifrada. Un texto manipulado o de otra fila produce error (nunca un código). */
export async function decryptCode(key: CryptoKey, stored: string | null, context: CodeContext): Promise<string | null> {
  if (!stored) return null;
  const [version, data] = stored.split('.');
  if (version !== VERSION || !data) throw new HttpError(500, 'code_corrupt', 'Código almacenado no válido.');
  const bytes = fromB64url(data);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: aad(context) }, key, bytes.slice(12));
    return new TextDecoder().decode(plain);
  } catch {
    throw new HttpError(500, 'code_corrupt', 'Código almacenado no válido.');
  }
}
