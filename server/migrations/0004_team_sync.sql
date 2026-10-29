-- GalipauStats · sincronización de jugadores, partidos y sanciones adicionales.
-- Migración solo aditiva: no modifica ni borra datos existentes.

-- Sanción adicional antes de reanudar (inferioridad de 4 minutos). Solo en
-- exclusiones y rojas de un jugador, como en la aplicación (addsToPrevious).
-- Las acciones existentes quedan con 0: ninguna lo tenía.
ALTER TABLE events ADD COLUMN adds_to_previous INTEGER NOT NULL DEFAULT 0
  CHECK (adds_to_previous = 0
    OR (adds_to_previous = 1 AND kind IN ('exclusion', 'red') AND player_id IS NOT NULL));

-- Dispositivo que hizo el último cambio de un jugador o un partido, como ya
-- ocurre con las acciones. Permite confirmar dentro de la misma transacción que
-- la escritura es la propia y no la de otro dispositivo simultáneo.
ALTER TABLE players ADD COLUMN updated_by_device_id TEXT REFERENCES devices (id) ON DELETE SET NULL;
ALTER TABLE matches ADD COLUMN updated_by_device_id TEXT REFERENCES devices (id) ON DELETE SET NULL;
