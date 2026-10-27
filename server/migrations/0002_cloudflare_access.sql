-- GalipauStats · autenticación administrativa con Cloudflare Access.
--
-- La identidad de superadministradores y administradores de club la verifica
-- Cloudflare Access (proveedor de identidad + segundo factor). El servidor
-- valida el JWT de Access y decide los roles con admin_identities/admin_roles.
-- Por eso desaparecen las tablas de credenciales y sesiones propias de 0001,
-- que nunca llegaron a usarse. Ver docs/AUTENTICACION_ADMIN.md.

DROP TABLE admin_sessions;
DROP TABLE admin_enrollments;
DROP TABLE admin_credentials;

-- Identificador de la cuenta en Access («sub» del JWT). Se fija en el primer
-- acceso y después debe coincidir: otra cuenta con el mismo correo no puede
-- ocupar la identidad.
ALTER TABLE admin_identities ADD COLUMN access_subject TEXT;
ALTER TABLE admin_identities ADD COLUMN last_login_at TEXT;

CREATE UNIQUE INDEX admin_identities_access_subject ON admin_identities (access_subject)
  WHERE access_subject IS NOT NULL;

-- El correo es la forma de vincular la identidad con Access: obligatorio y en
-- minúsculas, para que la unicidad no dependa de mayúsculas.
CREATE TRIGGER admin_identities_email_insert
BEFORE INSERT ON admin_identities
WHEN NEW.email IS NULL OR NEW.email <> lower(trim(NEW.email)) OR NEW.email NOT LIKE '_%@_%._%'
BEGIN
  SELECT RAISE(ABORT, 'admin_email_invalid');
END;

CREATE TRIGGER admin_identities_email_update
BEFORE UPDATE OF email ON admin_identities
WHEN NEW.email IS NULL OR NEW.email <> lower(trim(NEW.email)) OR NEW.email NOT LIKE '_%@_%._%'
BEGIN
  SELECT RAISE(ABORT, 'admin_email_invalid');
END;
