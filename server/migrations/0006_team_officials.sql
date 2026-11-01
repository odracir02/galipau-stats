-- GalipauStats · cuerpo técnico (oficiales) en la plantilla y la convocatoria.
-- Migración aditiva: no reconstruye tablas ni modifica datos existentes. Todos
-- los registros actuales quedan como 'player', con el mismo significado.

-- Rol en la plantilla. Un oficial no tiene dorsal: se guarda el dorsal técnico 0
-- y la posición 'field', que la aplicación nunca muestra ni usa como dorsal.
ALTER TABLE players ADD COLUMN role TEXT NOT NULL DEFAULT 'player'
  CHECK (role = 'player' OR (role = 'official' AND number = 0 AND position = 'field'));

-- El mismo rol en la convocatoria de cada partido (lo fija el servidor a partir
-- de la plantilla, nunca la petición).
ALTER TABLE match_squad ADD COLUMN role TEXT NOT NULL DEFAULT 'player'
  CHECK (role = 'player' OR (role = 'official' AND number = 0 AND position = 'field'));

-- El dorsal único entre los activos solo se aplica a los jugadores: el 0 técnico
-- de los oficiales no ocupa el dorsal 0 ni choca entre oficiales. Solo se
-- recrea el índice (mismas filas que antes: todas son 'player').
DROP INDEX players_active_number;
CREATE UNIQUE INDEX players_active_number ON players (team_id, number)
  WHERE active = 1 AND deleted_at IS NULL AND role = 'player';

-- Saber si un equipo tiene oficiales (compatibilidad con versiones antiguas).
CREATE INDEX players_officials ON players (team_id) WHERE role = 'official';
