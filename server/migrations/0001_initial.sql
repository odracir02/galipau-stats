-- GalipauStats · esquema inicial del servidor (Cloudflare D1 / SQLite).
--
-- Convenciones:
--   * Identificadores TEXT: los registros que vienen del dispositivo conservan
--     el identificador que ya tienen en IndexedDB (UUID), así reintentar una
--     subida nunca crea un duplicado.
--   * Fechas TEXT en ISO 8601 UTC, como en la aplicación.
--   * deleted_at: borrado lógico, necesario para propagar borrados al resto de
--     dispositivos. La eliminación definitiva (privacidad) borra la fila y
--     arrastra a sus dependientes con ON DELETE CASCADE.
--   * version: entero que sube en cada cambio aceptado. El dispositivo envía la
--     versión sobre la que editó; si no coincide hay conflicto (nunca se
--     sobrescribe en silencio).
--   * Las claves foráneas compuestas (id, club_id / team_id) garantizan que un
--     registro no pueda apuntar a otro de un equipo o club distinto.

-- ---------------------------------------------------------------------------
-- Clubes, equipos y personas
-- ---------------------------------------------------------------------------

CREATE TABLE clubs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- Nombre corto opcional para cabeceras («CB Galipau»).
  short_name  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  club_id     TEXT NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- Identificador corto (p. ej. SM2627). No es una credencial.
  code        TEXT NOT NULL CHECK (code NOT GLOB '*[^A-Z0-9]*' AND length(code) BETWEEN 3 AND 12),
  season      TEXT NOT NULL,
  category    TEXT,
  gender      TEXT CHECK (gender IN ('male', 'female', 'mixed')),
  max_squad   INTEGER NOT NULL DEFAULT 16 CHECK (max_squad BETWEEN 1 AND 40),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (club_id, code),
  -- Destino de las claves foráneas compuestas.
  UNIQUE (id, club_id)
);

-- Persona del club que puede jugar en varios equipos (p. ej. un juvenil que
-- también juega en el senior). Permite sumarla una sola vez en los rankings de
-- club. Solo guarda el nombre visible: minimización de datos.
CREATE TABLE people (
  id            TEXT PRIMARY KEY,
  club_id       TEXT NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX people_by_club ON people (club_id);

-- Jugador de la plantilla de un equipo (equivale a Player en IndexedDB).
CREATE TABLE players (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  person_id   TEXT REFERENCES people (id) ON DELETE SET NULL,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  number      INTEGER NOT NULL CHECK (number BETWEEN 0 AND 99),
  position    TEXT NOT NULL CHECK (position IN ('field', 'goalkeeper')),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (id, team_id)
);

CREATE INDEX players_by_team ON players (team_id);
CREATE INDEX players_by_person ON players (person_id) WHERE person_id IS NOT NULL;
-- Dorsal único entre los jugadores activos del equipo (como en la aplicación).
CREATE UNIQUE INDEX players_active_number ON players (team_id, number) WHERE active = 1 AND deleted_at IS NULL;

-- Una persona solo puede vincularse a jugadores de equipos de su mismo club.
CREATE TRIGGER players_person_same_club_insert
BEFORE INSERT ON players
WHEN NEW.person_id IS NOT NULL
  AND (SELECT club_id FROM people WHERE id = NEW.person_id)
      IS NOT (SELECT club_id FROM teams WHERE id = NEW.team_id)
BEGIN
  SELECT RAISE(ABORT, 'person_other_club');
END;

CREATE TRIGGER players_person_same_club_update
BEFORE UPDATE OF person_id, team_id ON players
WHEN NEW.person_id IS NOT NULL
  AND (SELECT club_id FROM people WHERE id = NEW.person_id)
      IS NOT (SELECT club_id FROM teams WHERE id = NEW.team_id)
BEGIN
  SELECT RAISE(ABORT, 'person_other_club');
END;

-- ---------------------------------------------------------------------------
-- Dispositivos, permisos e invitaciones
-- ---------------------------------------------------------------------------

-- Un dispositivo (navegador o PWA instalada). No es una persona ni una cuenta.
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  label         TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  revoked_at    TEXT
);

-- Credenciales del dispositivo. Solo se guarda el hash del token; el token en
-- claro solo lo conoce el dispositivo. Varias filas permiten rotar.
CREATE TABLE device_tokens (
  token_hash  TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  revoked_at  TEXT
);

CREATE INDEX device_tokens_by_device ON device_tokens (device_id);

-- Invitación de un equipo: código de entrenador (edición) o de jugador/familia
-- (consulta). El código se guarda solo como hash.
CREATE TABLE invites (
  id                    TEXT PRIMARY KEY,
  club_id               TEXT NOT NULL,
  team_id               TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('coach', 'viewer')),
  code_hash             TEXT NOT NULL UNIQUE,
  created_by_device_id  TEXT REFERENCES devices (id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  revoked_at            TEXT,
  max_uses              INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  use_count             INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (team_id, club_id) REFERENCES teams (id, club_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- Como máximo una invitación vigente por equipo y tipo: rotar = revocar + crear.
CREATE UNIQUE INDEX invites_one_active ON invites (team_id, role) WHERE revoked_at IS NULL;

-- Permiso de un dispositivo sobre un equipo: solo entrenador o consulta. Los
-- roles administrativos no pueden estar aquí (van en admin_roles).
CREATE TABLE grants (
  id          TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  club_id     TEXT NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  team_id     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('coach', 'viewer')),
  invite_id   TEXT REFERENCES invites (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT,
  FOREIGN KEY (team_id, club_id) REFERENCES teams (id, club_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX grants_one_per_team ON grants (device_id, team_id) WHERE revoked_at IS NULL;
CREATE INDEX grants_by_team ON grants (team_id);

-- ---------------------------------------------------------------------------
-- Identidades administrativas (superadministrador y administrador de club)
-- ---------------------------------------------------------------------------
-- Son personas con autenticación fuerte (llave de acceso / passkey, con
-- segundo factor opcional), no dispositivos con un código compartido. Ninguna
-- invitación ordinaria puede crear filas en estas tablas.

CREATE TABLE admin_identities (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  -- Contacto opcional para recuperación; no se usa como credencial.
  email         TEXT UNIQUE,
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);

-- Credenciales de autenticación. WebAuthn: solo la clave pública. TOTP: el
-- secreto cifrado con una clave del servidor (nunca en claro).
CREATE TABLE admin_credentials (
  id             TEXT PRIMARY KEY,
  identity_id    TEXT NOT NULL REFERENCES admin_identities (id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('webauthn', 'totp')),
  credential_id  TEXT UNIQUE,
  public_key     TEXT,
  sign_count     INTEGER NOT NULL DEFAULT 0,
  secret_enc     TEXT,
  created_at     TEXT NOT NULL,
  last_used_at   TEXT,
  revoked_at     TEXT,
  CHECK (
    (kind = 'webauthn' AND credential_id IS NOT NULL AND public_key IS NOT NULL AND secret_enc IS NULL)
    OR (kind = 'totp' AND secret_enc IS NOT NULL AND credential_id IS NULL AND public_key IS NULL)
  )
);

CREATE INDEX admin_credentials_by_identity ON admin_credentials (identity_id);

-- Alta de una credencial: enlace personal de un solo uso y corta duración,
-- emitido por el procedimiento inicial (primer superadministrador) o por un
-- superadministrador (administradores de club). Solo el hash.
CREATE TABLE admin_enrollments (
  id                      TEXT PRIMARY KEY,
  identity_id             TEXT NOT NULL REFERENCES admin_identities (id) ON DELETE CASCADE,
  code_hash               TEXT NOT NULL UNIQUE,
  created_by_identity_id  TEXT REFERENCES admin_identities (id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL,
  expires_at              TEXT NOT NULL,
  used_at                 TEXT
);

-- Roles administrativos. superadmin: toda la plataforma (sin club).
-- club_admin: un club concreto.
CREATE TABLE admin_roles (
  id                      TEXT PRIMARY KEY,
  identity_id             TEXT NOT NULL REFERENCES admin_identities (id) ON DELETE CASCADE,
  role                    TEXT NOT NULL CHECK (role IN ('superadmin', 'club_admin')),
  club_id                 TEXT REFERENCES clubs (id) ON DELETE CASCADE,
  granted_by_identity_id  TEXT REFERENCES admin_identities (id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL,
  revoked_at              TEXT,
  CHECK ((role = 'superadmin' AND club_id IS NULL) OR (role = 'club_admin' AND club_id IS NOT NULL))
);

CREATE UNIQUE INDEX admin_roles_one_superadmin ON admin_roles (identity_id)
  WHERE role = 'superadmin' AND revoked_at IS NULL;
CREATE UNIQUE INDEX admin_roles_one_per_club ON admin_roles (identity_id, club_id)
  WHERE role = 'club_admin' AND revoked_at IS NULL;
CREATE INDEX admin_roles_by_club ON admin_roles (club_id);

-- Sesión administrativa: solo se emite tras verificar una credencial fuerte
-- (mfa_verified_at). Va ligada al dispositivo (navegador) donde se inició, que
-- conserva además sus permisos de equipo. Duración corta; solo el hash.
CREATE TABLE admin_sessions (
  token_hash       TEXT PRIMARY KEY,
  identity_id      TEXT NOT NULL REFERENCES admin_identities (id) ON DELETE CASCADE,
  device_id        TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  mfa_verified_at  TEXT NOT NULL,
  revoked_at       TEXT
);

CREATE INDEX admin_sessions_by_identity ON admin_sessions (identity_id);

-- Registro de auditoría de operaciones administrativas.
CREATE TABLE admin_audit (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id  TEXT REFERENCES admin_identities (id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  at           TEXT NOT NULL
);

-- Contador de intentos para frenar la adivinación de códigos (ventanas fijas).
-- La clave es un hash (de la IP, por ejemplo), nunca el dato en claro.
CREATE TABLE auth_attempts (
  bucket        TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- ---------------------------------------------------------------------------
-- Partidos y eventos
-- ---------------------------------------------------------------------------

CREATE TABLE matches (
  id                  TEXT PRIMARY KEY,
  team_id             TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  opponent            TEXT NOT NULL,
  date                TEXT NOT NULL,
  venue               TEXT NOT NULL CHECK (venue IN ('home', 'away')),
  season              TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('ready', 'in_progress', 'halftime', 'finished')),
  half_minutes        INTEGER NOT NULL CHECK (half_minutes > 0),
  -- Estado del cronómetro tal cual lo guarda el dispositivo (JSON). Sirve para
  -- consultar y para transferir el partido; el servidor no lo interpreta.
  clock_json          TEXT NOT NULL,
  score_adj_own       INTEGER NOT NULL DEFAULT 0,
  score_adj_opponent  INTEGER NOT NULL DEFAULT 0,
  -- Dispositivo que registra el partido. Solo él puede enviar acciones hasta
  -- que se transfiera.
  recorder_device_id  TEXT REFERENCES devices (id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  finished_at         TEXT,
  deleted_at          TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  UNIQUE (id, team_id)
);

CREATE INDEX matches_by_team ON matches (team_id, season);

-- Convocatoria: copia de nombre, dorsal y posición en el momento del partido.
CREATE TABLE match_squad (
  match_id   TEXT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  player_id  TEXT NOT NULL,
  team_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  number     INTEGER NOT NULL CHECK (number BETWEEN 0 AND 99),
  position   TEXT NOT NULL CHECK (position IN ('field', 'goalkeeper')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, player_id),
  FOREIGN KEY (player_id, team_id) REFERENCES players (id, team_id) ON DELETE CASCADE,
  FOREIGN KEY (match_id, team_id) REFERENCES matches (id, team_id) ON DELETE CASCADE
);

-- Acción estadística. player_id NULL = pendiente de atribuir.
CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  match_id       TEXT NOT NULL,
  team_id        TEXT NOT NULL,
  player_id      TEXT,
  kind           TEXT NOT NULL CHECK (kind IN (
                   'shot', 'gk_shot', 'turnover', 'recovery', 'yellow', 'exclusion', 'red',
                   'free_throw', 'penalty_committed')),
  shot_type      TEXT,
  result         TEXT,
  turnover_type  TEXT,
  period         INTEGER NOT NULL CHECK (period IN (1, 2)),
  match_time_ms  INTEGER NOT NULL CHECK (match_time_ms >= 0),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  updated_by_device_id TEXT REFERENCES devices (id) ON DELETE SET NULL,
  FOREIGN KEY (match_id, team_id) REFERENCES matches (id, team_id) ON DELETE CASCADE,
  FOREIGN KEY (player_id, team_id) REFERENCES players (id, team_id),
  -- Cada tipo lleva exactamente sus campos (catálogo de src/domain/catalog.ts).
  -- COALESCE: en SQLite «NULL IN (...)» es NULL y no haría fallar el CHECK.
  CHECK (COALESCE(
    (kind = 'shot'
      AND shot_type IN ('nine_m', 'six_m', 'penalty', 'fast_break')
      AND result IN ('goal', 'out', 'saved') AND turnover_type IS NULL)
    OR (kind = 'gk_shot'
      AND shot_type IN ('nine_m', 'six_m', 'wing', 'fast_break', 'penalty')
      AND result IN ('goal', 'save', 'out') AND turnover_type IS NULL)
    OR (kind = 'turnover'
      AND turnover_type IN ('general', 'steps', 'double', 'bad_pass')
      AND shot_type IS NULL AND result IS NULL)
    OR (kind IN ('recovery', 'yellow', 'exclusion', 'red', 'free_throw', 'penalty_committed')
      AND shot_type IS NULL AND result IS NULL AND turnover_type IS NULL)
  , 0))
);

CREATE INDEX events_by_match ON events (match_id);
CREATE INDEX events_by_player ON events (player_id) WHERE player_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Sincronización
-- ---------------------------------------------------------------------------

-- Operaciones ya aplicadas: repetir una petición devuelve el mismo resultado
-- sin volver a aplicarla (idempotencia).
CREATE TABLE sync_ops (
  op_id        TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  team_id      TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  entity       TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  result_json  TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

-- Registro de cambios por equipo: un dispositivo descarga «lo posterior a mi
-- último seq». AUTOINCREMENT garantiza que seq nunca se reutiliza.
CREATE TABLE change_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  entity      TEXT NOT NULL CHECK (entity IN ('team', 'player', 'match', 'event')),
  entity_id   TEXT NOT NULL,
  version     INTEGER NOT NULL,
  changed_at  TEXT NOT NULL
);

CREATE INDEX change_log_by_team ON change_log (team_id, seq);
