-- GalipauStats · identidad común entre equipos del club y base de los rankings
-- de club. Migración aditiva: no reconstruye tablas ni modifica datos existentes.
-- Todo queda desactivado: ningún equipo participa y solo los administradores
-- podrían ver los rankings. La identidad (people, players.person_id) es de 0001;
-- nunca se envía a los dispositivos ni pasa por la sincronización.

-- Quién ve los rankings del club (al principio, solo administradores).
ALTER TABLE clubs ADD COLUMN rankings_visibility TEXT NOT NULL DEFAULT 'admins'
  CHECK (rankings_visibility IN ('admins', 'coaches', 'members'));
-- Sube con todo lo que cambia los rankings sin pasar por change_log
-- (vínculos, exclusiones, personas, equipos). Lo mantienen los triggers.
ALTER TABLE clubs ADD COLUMN rankings_version INTEGER NOT NULL DEFAULT 0;

-- Participación explícita de cada equipo (ninguno participa por defecto).
ALTER TABLE teams ADD COLUMN club_rankings INTEGER NOT NULL DEFAULT 0
  CHECK (club_rankings IN (0, 1));
-- Grupo de categorías compatibles que define el administrador («senior»).
ALTER TABLE teams ADD COLUMN ranking_group TEXT
  CHECK (ranking_group IS NULL OR length(trim(ranking_group)) BETWEEN 1 AND 30);

-- Exclusión de los rankings del club, por persona o por ficha.
ALTER TABLE people ADD COLUMN ranking_excluded INTEGER NOT NULL DEFAULT 0
  CHECK (ranking_excluded IN (0, 1));
ALTER TABLE players ADD COLUMN ranking_excluded INTEGER NOT NULL DEFAULT 0
  CHECK (ranking_excluded IN (0, 1));

-- Una persona, como mucho una ficha por equipo (también contando las borradas:
-- restaurar una ficha nunca puede crear un duplicado).
CREATE UNIQUE INDEX players_person_per_team ON players (person_id, team_id)
  WHERE person_id IS NOT NULL;

-- Solo se vinculan jugadores (nunca cuerpo técnico) a personas no borradas.
CREATE TRIGGER players_person_valid_insert
BEFORE INSERT ON players
WHEN NEW.person_id IS NOT NULL
  AND (NEW.role IS NOT 'player'
       OR NOT EXISTS (SELECT 1 FROM people WHERE id = NEW.person_id AND deleted_at IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'person_link_invalid');
END;

CREATE TRIGGER players_person_valid_update
BEFORE UPDATE OF person_id, role ON players
WHEN NEW.person_id IS NOT NULL
  AND (NEW.role IS NOT 'player'
       OR (NEW.person_id IS NOT OLD.person_id
           AND NOT EXISTS (SELECT 1 FROM people WHERE id = NEW.person_id AND deleted_at IS NULL)))
BEGIN
  SELECT RAISE(ABORT, 'person_link_invalid');
END;

-- Una persona con fichas no se borra (primero se desvincula) ni cambia de club.
CREATE TRIGGER people_delete_linked
BEFORE UPDATE OF deleted_at ON people
WHEN NEW.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM players WHERE person_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'person_still_linked');
END;

CREATE TRIGGER people_club_fixed
BEFORE UPDATE OF club_id ON people
WHEN NEW.club_id IS NOT OLD.club_id
BEGIN
  SELECT RAISE(ABORT, 'person_club_fixed');
END;

-- Un equipo con fichas vinculadas no cambia de club.
CREATE TRIGGER teams_club_linked
BEFORE UPDATE OF club_id ON teams
WHEN NEW.club_id IS NOT OLD.club_id
  AND EXISTS (SELECT 1 FROM players WHERE team_id = NEW.id AND person_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'team_has_linked_players');
END;

-- Invalidación de los rankings del club por lo que no pasa por change_log.
CREATE TRIGGER rankings_player_link_insert
AFTER INSERT ON players
WHEN NEW.person_id IS NOT NULL OR NEW.ranking_excluded = 1
BEGIN
  UPDATE clubs SET rankings_version = rankings_version + 1
   WHERE id = (SELECT club_id FROM teams WHERE id = NEW.team_id);
END;

CREATE TRIGGER rankings_player_link_update
AFTER UPDATE OF person_id, ranking_excluded ON players
WHEN NEW.person_id IS NOT OLD.person_id OR NEW.ranking_excluded IS NOT OLD.ranking_excluded
BEGIN
  UPDATE clubs SET rankings_version = rankings_version + 1
   WHERE id = (SELECT club_id FROM teams WHERE id = NEW.team_id);
END;

CREATE TRIGGER rankings_person_update
AFTER UPDATE OF display_name, ranking_excluded, deleted_at ON people
WHEN NEW.display_name IS NOT OLD.display_name
  OR NEW.ranking_excluded IS NOT OLD.ranking_excluded
  OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  UPDATE clubs SET rankings_version = rankings_version + 1 WHERE id = NEW.club_id;
END;

CREATE TRIGGER rankings_team_update
AFTER UPDATE OF name, code, season, gender, club_rankings, ranking_group, deleted_at ON teams
WHEN NEW.name IS NOT OLD.name OR NEW.code IS NOT OLD.code OR NEW.season IS NOT OLD.season
  OR NEW.gender IS NOT OLD.gender OR NEW.club_rankings IS NOT OLD.club_rankings
  OR NEW.ranking_group IS NOT OLD.ranking_group OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  UPDATE clubs SET rankings_version = rankings_version + 1 WHERE id = NEW.club_id;
END;

-- El cálculo de club lee las acciones por equipo.
CREATE INDEX events_by_team ON events (team_id);

-- Rankings calculados (solo en el servidor): identificadores y cifras, sin
-- nombres; los nombres del Top 10 se leen al responder.
CREATE TABLE club_rankings_cache (
  club_id      TEXT NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  season       TEXT NOT NULL,
  group_key    TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  payload      TEXT NOT NULL,
  computed_at  TEXT NOT NULL,
  PRIMARY KEY (club_id, season, group_key)
);
