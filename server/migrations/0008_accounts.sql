-- 0008: cuentas de club (propietario y administradores) con inicio de sesión por
-- código de correo. Solo crea tablas, índices y triggers nuevos: no modifica ninguna
-- tabla ni fila existente. Los clubes actuales quedan sin propietario y siguen
-- gestionados desde la administración (Cloudflare Access).
--
-- Parte 1. Tablas de la biblioteca de autenticación (better-auth 1.7.28, versión
-- exacta). Es el SQL que genera la propia biblioteca con los nombres configurados
-- (server/src/accounts/auth.ts); test/accounts-schema.test.ts comprueba que sigue
-- coincidiendo. No editar a mano: si cambia la versión, regenerar y revisar.

create table "auth_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "auth_session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "auth_user" ("id") on delete cascade);

create table "auth_account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "auth_user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "auth_verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table "auth_rate_limit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "auth_session_userId_idx" on "auth_session" ("userId");

create index "auth_account_userId_idx" on "auth_account" ("userId");

create index "auth_verification_identifier_idx" on "auth_verification" ("identifier");

-- ---------------------------------------------------------------------------
-- Parte 2. Modelo propio de cuentas de club. Fechas en texto ISO 8601 (UTC, con
-- milisegundos), como el resto del esquema y como guarda la biblioteca.
-- Las cuentas no se borran: se desactivan (account_state). Por eso toda referencia a
-- auth_user es ON DELETE RESTRICT y la auditoría conserva siempre a su autor.
-- ---------------------------------------------------------------------------

-- Estado de la cuenta. Sin fila = activa.
CREATE TABLE account_state (
  user_id          TEXT PRIMARY KEY REFERENCES auth_user (id) ON DELETE RESTRICT,
  status           TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  disabled_at      TEXT,
  disabled_reason  TEXT CHECK (disabled_reason IS NULL OR disabled_reason IN ('self', 'superadmin')),
  updated_at       TEXT NOT NULL,
  CHECK ((status = 'active' AND disabled_at IS NULL) OR (status = 'disabled' AND disabled_at IS NOT NULL))
);

-- Propietario vigente de los clubes autogestionados. La clave primaria garantiza
-- como mucho uno por club; los triggers, que nunca quede ninguno.
CREATE TABLE club_owners (
  club_id  TEXT PRIMARY KEY REFERENCES clubs (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES auth_user (id) ON DELETE RESTRICT,
  since    TEXT NOT NULL
);
CREATE INDEX club_owners_user ON club_owners (user_id);

-- Administradores del club (el propietario no figura aquí).
CREATE TABLE club_memberships (
  id                  TEXT PRIMARY KEY,
  club_id             TEXT NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES auth_user (id) ON DELETE RESTRICT,
  role                TEXT NOT NULL CHECK (role IN ('admin')),
  source              TEXT NOT NULL CHECK (source IN ('invitation', 'ownership_transfer')),
  granted_by_user_id  TEXT REFERENCES auth_user (id) ON DELETE RESTRICT,
  created_at          TEXT NOT NULL,
  revoked_at          TEXT,
  revoked_by_user_id  TEXT REFERENCES auth_user (id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX club_memberships_active ON club_memberships (club_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX club_memberships_user ON club_memberships (user_id) WHERE revoked_at IS NULL;

-- Invitaciones de administrador por correo. No llevan enlace ni token: se aceptan
-- entrando con el código enviado a ese mismo correo (cuenta verificada).
CREATE TABLE club_invitations (
  id                   TEXT PRIMARY KEY,
  club_id              TEXT NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  email                TEXT NOT NULL CHECK (email = lower(trim(email)) AND instr(email, '@') > 1 AND length(email) <= 254),
  role                 TEXT NOT NULL CHECK (role IN ('admin')),
  invited_by_user_id   TEXT REFERENCES auth_user (id) ON DELETE RESTRICT,
  created_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  accepted_at          TEXT,
  accepted_by_user_id  TEXT REFERENCES auth_user (id) ON DELETE RESTRICT,
  revoked_at           TEXT,
  CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL))
);
CREATE UNIQUE INDEX club_invitations_pending ON club_invitations (club_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX club_invitations_email ON club_invitations (email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Transferencias de propiedad: solo cuentan si las acepta quien la recibe.
CREATE TABLE club_owner_transfers (
  id            TEXT PRIMARY KEY,
  club_id       TEXT NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  from_user_id  TEXT NOT NULL REFERENCES auth_user (id) ON DELETE RESTRICT,
  to_user_id    TEXT NOT NULL REFERENCES auth_user (id) ON DELETE RESTRICT,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  decided_at    TEXT,
  CHECK (from_user_id <> to_user_id),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX club_owner_transfers_pending ON club_owner_transfers (club_id) WHERE status = 'pending';
CREATE INDEX club_owner_transfers_to ON club_owner_transfers (to_user_id) WHERE status = 'pending';

-- Auditoría de las cuentas de club (la de Access sigue en admin_audit).
CREATE TABLE account_audit (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id  TEXT REFERENCES auth_user (id) ON DELETE RESTRICT,
  club_id        TEXT REFERENCES clubs (id) ON DELETE SET NULL,
  action         TEXT NOT NULL,
  target_type    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  at             TEXT NOT NULL
);
CREATE INDEX account_audit_club ON account_audit (club_id, seq);

-- ---------------------------------------------------------------------------
-- Invariantes en la base: valen aunque falle o se salte el código de la API.
-- ---------------------------------------------------------------------------

-- Un club autogestionado nunca se queda sin propietario: la fila solo desaparece
-- al borrar el club (cascada).
CREATE TRIGGER club_owners_no_delete BEFORE DELETE ON club_owners
WHEN EXISTS (SELECT 1 FROM clubs WHERE id = OLD.club_id)
BEGIN
  SELECT RAISE(ABORT, 'club_sin_propietario');
END;

-- El propietario es siempre una cuenta existente, activa y con el correo verificado.
CREATE TRIGGER club_owners_valid_insert BEFORE INSERT ON club_owners
WHEN EXISTS (SELECT 1 FROM account_state WHERE user_id = NEW.user_id AND status = 'disabled')
  OR NOT EXISTS (SELECT 1 FROM auth_user WHERE id = NEW.user_id AND emailVerified = 1)
BEGIN
  SELECT RAISE(ABORT, 'propietario_no_valido');
END;
CREATE TRIGGER club_owners_valid_update BEFORE UPDATE OF user_id ON club_owners
WHEN EXISTS (SELECT 1 FROM account_state WHERE user_id = NEW.user_id AND status = 'disabled')
  OR NOT EXISTS (SELECT 1 FROM auth_user WHERE id = NEW.user_id AND emailVerified = 1)
BEGIN
  SELECT RAISE(ABORT, 'propietario_no_valido');
END;
CREATE TRIGGER club_owners_same_club BEFORE UPDATE OF club_id ON club_owners
BEGIN
  SELECT RAISE(ABORT, 'propietario_no_valido');
END;

-- Quien es propietario no es además administrador del mismo club, y una cuenta
-- desactivada no recibe membresías.
CREATE TRIGGER club_memberships_valid BEFORE INSERT ON club_memberships
BEGIN
  SELECT RAISE(ABORT, 'ya_es_propietario') WHERE EXISTS (
    SELECT 1 FROM club_owners WHERE club_id = NEW.club_id AND user_id = NEW.user_id);
  SELECT RAISE(ABORT, 'cuenta_desactivada') WHERE EXISTS (
    SELECT 1 FROM account_state WHERE user_id = NEW.user_id AND status = 'disabled');
END;
-- Una membresía revocada no se reactiva (se crea otra).
CREATE TRIGGER club_memberships_no_reactivate BEFORE UPDATE OF revoked_at ON club_memberships
WHEN OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'membresia_cerrada');
END;
-- Una membresía no cambia de club, de cuenta ni de rol.
CREATE TRIGGER club_memberships_immutable BEFORE UPDATE OF id, club_id, user_id, role, source ON club_memberships
BEGIN
  SELECT RAISE(ABORT, 'membresia_inmutable');
END;

-- No se desactiva a quien posee un club: antes hay que transferirlo.
CREATE TRIGGER account_state_owner_insert BEFORE INSERT ON account_state
WHEN NEW.status = 'disabled' AND EXISTS (SELECT 1 FROM club_owners WHERE user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'propietario_activo');
END;
CREATE TRIGGER account_state_owner_update BEFORE UPDATE OF status ON account_state
WHEN NEW.status = 'disabled' AND EXISTS (SELECT 1 FROM club_owners WHERE user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'propietario_activo');
END;

-- Una invitación aceptada o revocada no se reabre ni se modifica.
CREATE TRIGGER club_invitations_closed BEFORE UPDATE ON club_invitations
WHEN OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invitacion_cerrada');
END;

-- Una invitación no cambia de club, de correo ni de rol (no se puede redirigir).
CREATE TRIGGER club_invitations_immutable BEFORE UPDATE OF id, club_id, email, role, invited_by_user_id ON club_invitations
BEGIN
  SELECT RAISE(ABORT, 'invitacion_inmutable');
END;

-- Aceptar = alta del administrador y auditoría, en la misma sentencia.
CREATE TRIGGER club_invitations_accept AFTER UPDATE OF accepted_at ON club_invitations
WHEN OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invitacion_caducada') WHERE NEW.accepted_at > NEW.expires_at;
  SELECT RAISE(ABORT, 'invitacion_de_otro_correo') WHERE NOT EXISTS (
    SELECT 1 FROM auth_user WHERE id = NEW.accepted_by_user_id AND email = NEW.email AND emailVerified = 1);
  INSERT INTO club_memberships (id, club_id, user_id, role, source, granted_by_user_id, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.club_id, NEW.accepted_by_user_id, NEW.role, 'invitation', NEW.invited_by_user_id, NEW.accepted_at);
  INSERT INTO account_audit (actor_user_id, club_id, action, target_type, target_id, at)
  VALUES (NEW.accepted_by_user_id, NEW.club_id, 'invitation.accept', 'invitation', NEW.id, NEW.accepted_at);
END;

-- Solicitar una transferencia: solo el propietario vigente, a un administrador activo.
CREATE TRIGGER club_owner_transfers_request BEFORE INSERT ON club_owner_transfers
BEGIN
  SELECT RAISE(ABORT, 'no_es_propietario') WHERE NOT EXISTS (
    SELECT 1 FROM club_owners WHERE club_id = NEW.club_id AND user_id = NEW.from_user_id);
  SELECT RAISE(ABORT, 'destino_no_admin') WHERE NOT EXISTS (
    SELECT 1 FROM club_memberships WHERE club_id = NEW.club_id AND user_id = NEW.to_user_id AND revoked_at IS NULL);
END;

-- Una transferencia solo se decide una vez, y solo cambia su estado.
CREATE TRIGGER club_owner_transfers_once BEFORE UPDATE ON club_owner_transfers
WHEN OLD.status <> 'pending'
  OR NEW.club_id <> OLD.club_id OR NEW.from_user_id <> OLD.from_user_id OR NEW.to_user_id <> OLD.to_user_id
BEGIN
  SELECT RAISE(ABORT, 'transferencia_cerrada');
END;

-- Aceptar: cambia el propietario, el anterior pasa a administrador y el nuevo deja
-- de serlo, con auditoría, todo en una sentencia.
CREATE TRIGGER club_owner_transfers_accept AFTER UPDATE OF status ON club_owner_transfers
WHEN OLD.status = 'pending' AND NEW.status = 'accepted'
BEGIN
  SELECT RAISE(ABORT, 'transferencia_caducada') WHERE NEW.decided_at > NEW.expires_at;
  SELECT RAISE(ABORT, 'propietario_cambiado') WHERE NOT EXISTS (
    SELECT 1 FROM club_owners WHERE club_id = NEW.club_id AND user_id = NEW.from_user_id);
  SELECT RAISE(ABORT, 'destino_no_admin') WHERE NOT EXISTS (
    SELECT 1 FROM club_memberships WHERE club_id = NEW.club_id AND user_id = NEW.to_user_id AND revoked_at IS NULL);
  UPDATE club_owners SET user_id = NEW.to_user_id, since = NEW.decided_at WHERE club_id = NEW.club_id;
  UPDATE club_memberships SET revoked_at = NEW.decided_at, revoked_by_user_id = NEW.to_user_id
    WHERE club_id = NEW.club_id AND user_id = NEW.to_user_id AND revoked_at IS NULL;
  INSERT INTO club_memberships (id, club_id, user_id, role, source, granted_by_user_id, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.club_id, NEW.from_user_id, 'admin', 'ownership_transfer', NEW.to_user_id, NEW.decided_at);
  INSERT INTO account_audit (actor_user_id, club_id, action, target_type, target_id, at)
  VALUES (NEW.to_user_id, NEW.club_id, 'ownership.accept', 'transfer', NEW.id, NEW.decided_at);
END;

-- Al revocar a un administrador se cancela la transferencia pendiente hacia él.
CREATE TRIGGER club_memberships_revoke AFTER UPDATE OF revoked_at ON club_memberships
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE club_owner_transfers SET status = 'cancelled', decided_at = NEW.revoked_at
    WHERE club_id = NEW.club_id AND to_user_id = NEW.user_id AND status = 'pending';
END;
