-- GalipauStats · control de registro de los partidos entre entrenadores.
-- Migración solo aditiva: no modifica ni borra jugadores, partidos, acciones,
-- versiones ni el registro de cambios. Solo rellena las columnas nuevas.
--
-- Un partido en curso o en el descanso lo registra un único dispositivo (el que
-- tiene el control). Los partidos preparados y los finalizados no tienen
-- control: cualquier entrenador del equipo puede corregirlos respetando las
-- versiones. recorder_device_id se conserva como dato histórico (quién lo subió).

-- Dispositivo con el control. Si se borrara el dispositivo, el partido queda
-- sin control (nunca bloqueado).
ALTER TABLE matches ADD COLUMN control_device_id TEXT REFERENCES devices (id) ON DELETE SET NULL;
-- Contador de cambios de control: la transferencia exige el valor visto, así
-- dos peticiones simultáneas no pueden tomar el control a la vez.
ALTER TABLE matches ADD COLUMN control_epoch INTEGER NOT NULL DEFAULT 0 CHECK (control_epoch >= 0);
-- Desde cuándo lo tiene (hora del servidor) y su última escritura (para mostrar
-- la actividad). Solo cuenta el permiso de entrenador que ya existía entonces.
ALTER TABLE matches ADD COLUMN control_since TEXT;
ALTER TABLE matches ADD COLUMN control_seen_at TEXT;

-- Control inicial: solo los partidos en curso o en el descanso, para el
-- dispositivo que los registraba, si sigue vigente.
UPDATE matches
SET control_device_id = recorder_device_id,
    control_epoch = 1,
    control_since = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    control_seen_at = updated_at
WHERE status IN ('in_progress', 'halftime')
  AND deleted_at IS NULL
  AND recorder_device_id IS NOT NULL
  AND recorder_device_id IN (SELECT id FROM devices WHERE revoked_at IS NULL);

CREATE INDEX matches_by_control ON matches (control_device_id) WHERE control_device_id IS NOT NULL;

-- Registro de transferencias de control (auditoría interna; nunca se muestra
-- en las pantallas públicas).
CREATE TABLE match_control_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id         TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  match_id        TEXT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  from_device_id  TEXT REFERENCES devices (id) ON DELETE SET NULL,
  to_device_id    TEXT REFERENCES devices (id) ON DELETE SET NULL,
  epoch           INTEGER NOT NULL,
  op_id           TEXT NOT NULL UNIQUE,
  at              TEXT NOT NULL
);

CREATE INDEX match_control_log_by_match ON match_control_log (match_id, id);
