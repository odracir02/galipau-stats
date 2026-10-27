// Alta del PRIMER superadministrador de GalipauStats.
//
// No existe ninguna ruta HTTP que cree superadministradores: este script genera
// el SQL que el propietario aplica con su propia cuenta de Cloudflare (que ya
// exige su inicio de sesión y su segundo factor). Así, quien no controla la
// cuenta no puede convertirse en superadministrador.
//
// Uso (ver docs/SEGURIDAD.md):
//   TOKEN_PEPPER=<el mismo valor configurado en el entorno> \
//     node scripts/bootstrap-superadmin.mjs "Nombre visible" > bootstrap.local.sql
//   npx wrangler d1 execute DB --env production --remote --file bootstrap.local.sql
//   (después, borrar bootstrap.local.sql)
//
// El SQL solo contiene hashes. El código de alta se muestra una vez por la
// salida de error, caduca en 30 minutos y sirve para registrar la llave de
// acceso (passkey) del superadministrador. Si ya existe un superadministrador
// vigente, el SQL no inserta nada.
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Mismo alfabeto y normalización que server/src/secrets.ts.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ENROLLMENT_MINUTES = 30;

export function generateCode(length = 16) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out.replace(/(.{4})(?=.)/g, '$1-');
}

const normalize = (code) => code.toUpperCase().replace(/[^0-9A-Z]/g, '');
const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Mismo cálculo que hashSecret(`enroll:${código}`, pepper) en el servidor. */
export function enrollmentHash(code, pepper) {
  if (!pepper) throw new Error('Falta TOKEN_PEPPER');
  return createHmac('sha256', pepper).update(`enroll:${normalize(code)}`).digest('hex');
}

export function buildBootstrapSql({ identityId, displayName, code, pepper, now = new Date() }) {
  const name = displayName.trim();
  if (!name) throw new Error('Falta el nombre visible');
  const at = now.toISOString();
  const expires = new Date(now.getTime() + ENROLLMENT_MINUTES * 60_000).toISOString();
  const id = sqlString(identityId);
  // Ninguna fila se inserta si ya hay otro superadministrador vigente.
  const guard = `WHERE NOT EXISTS (SELECT 1 FROM admin_roles WHERE role = 'superadmin' AND revoked_at IS NULL AND identity_id <> ${id})`;
  return [
    `INSERT INTO admin_identities (id, display_name, created_at) SELECT ${id}, ${sqlString(name)}, ${sqlString(at)} ${guard};`,
    `INSERT INTO admin_roles (id, identity_id, role, club_id, granted_by_identity_id, created_at) SELECT ${sqlString(randomUUID())}, ${id}, 'superadmin', NULL, NULL, ${sqlString(at)} ${guard};`,
    `INSERT INTO admin_enrollments (id, identity_id, code_hash, created_by_identity_id, created_at, expires_at) SELECT ${sqlString(randomUUID())}, ${id}, ${sqlString(enrollmentHash(code, pepper))}, NULL, ${sqlString(at)}, ${sqlString(expires)} ${guard};`,
    `INSERT INTO admin_audit (identity_id, action, target_type, target_id, at) SELECT ${id}, 'superadmin.bootstrap', 'platform', 'galipaustats', ${sqlString(at)} ${guard};`,
    '',
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const displayName = process.argv[2];
  const pepper = process.env.TOKEN_PEPPER;
  if (!displayName || !pepper) {
    console.error('Uso: TOKEN_PEPPER=… node scripts/bootstrap-superadmin.mjs "Nombre visible" > bootstrap.local.sql');
    process.exit(1);
  }
  const code = generateCode();
  process.stdout.write(buildBootstrapSql({ identityId: randomUUID(), displayName, code, pepper }));
  console.error(`Código de alta (válido ${ENROLLMENT_MINUTES} min, un solo uso, no se guarda): ${code}`);
}
