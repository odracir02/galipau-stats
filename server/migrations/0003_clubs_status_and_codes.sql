-- GalipauStats · estado de los clubes y códigos de invitación recuperables.
-- Migración solo aditiva: no modifica ni borra datos existentes.

-- Estado del club. Un club suspendido no permite el acceso operativo a sus
-- equipos (dispositivos ni administración por equipo) y puede reactivarse.
-- Distinto del borrado lógico (deleted_at).
ALTER TABLE clubs ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'suspended'));

-- Copia cifrada del código de invitación (AES-GCM con una clave del servidor,
-- INVITE_CODE_KEY), para poder volver a mostrarlo sin regenerarlo. El canje
-- sigue usando code_hash. Las invitaciones anteriores quedan con NULL: no se
-- pueden mostrar y habrá que regenerarlas.
ALTER TABLE invites ADD COLUMN code_enc TEXT;
