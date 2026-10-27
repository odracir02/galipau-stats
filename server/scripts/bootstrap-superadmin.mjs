// Alta del PRIMER superadministrador de GalipauStats.
//
// No existe ninguna ruta HTTP que cree superadministradores: este script genera
// el SQL que el propietario aplica con su propia cuenta de Cloudflare (que ya
// exige su inicio de sesión y su segundo factor). Quien no controla la cuenta
// no puede convertirse en superadministrador.
//
// Uso (ver docs/AUTENTICACION_ADMIN.md):
//   node scripts/bootstrap-superadmin.mjs propietario@example.com "Nombre visible" > bootstrap.local.sql
//   npx wrangler d1 execute DB --env production --remote --file bootstrap.local.sql
//   (después, borrar bootstrap.local.sql)
//
// El correo es el de la cuenta con la que el propietario entra en Cloudflare
// Access. El SQL no contiene secretos. Si ya existe un superadministrador
// vigente, no inserta nada.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Misma normalización que el servidor (admin.ts): minúsculas y sin espacios. */
export function normalizeEmail(email) {
  const value = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) throw new Error('Correo no válido');
  return value;
}

export function buildBootstrapSql({ identityId, email, displayName, now = new Date() }) {
  const mail = normalizeEmail(email);
  const name = String(displayName ?? '').trim() || mail;
  const at = now.toISOString();
  const id = sqlString(identityId);
  // Ninguna fila se inserta si ya hay otro superadministrador vigente.
  const guard = `WHERE NOT EXISTS (SELECT 1 FROM admin_roles WHERE role = 'superadmin' AND revoked_at IS NULL AND identity_id <> ${id})`;
  return [
    `INSERT INTO admin_identities (id, display_name, email, created_at) SELECT ${id}, ${sqlString(name)}, ${sqlString(mail)}, ${sqlString(at)} ${guard};`,
    `INSERT INTO admin_roles (id, identity_id, role, club_id, granted_by_identity_id, created_at) SELECT ${sqlString(randomUUID())}, ${id}, 'superadmin', NULL, NULL, ${sqlString(at)} ${guard};`,
    `INSERT INTO admin_audit (identity_id, action, target_type, target_id, at) SELECT ${id}, 'superadmin.bootstrap', 'platform', 'galipaustats', ${sqlString(at)} ${guard};`,
    '',
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [email, displayName] = process.argv.slice(2);
  if (!email) {
    console.error('Uso: node scripts/bootstrap-superadmin.mjs correo@example.com "Nombre visible" > bootstrap.local.sql');
    process.exit(1);
  }
  process.stdout.write(buildBootstrapSql({ identityId: randomUUID(), email, displayName }));
}
