# Modelo de dominio y eventos

Definición exacta en [`src/domain/types.ts`](../src/domain/types.ts).

## Entidades

**Team**: `id`, `name`, `code` (código corto, p. ej. `SM2627`; identifica, no es contraseña), `season` (temporada vigente), `maxSquad` (límite de convocados, 16 por defecto).

**Player**: `id` estable (UUID, nunca el dorsal), `teamId`, `name`, `number`, `position` (`field` | `goalkeeper`), `active`. El dorsal es único entre los jugadores **activos** del equipo.

**Match**: `id`, `teamId`, `opponent`, `date`, `venue` (`home` | `away`), `season`, `status` (`ready` → `in_progress` ⇄ `halftime` → `finished`), `halfMinutes` (30), `squad`, `clock`, `scoreAdjustment`, `finishedAt`, `deletedAt`.

- `squad` es una **copia** (`playerId`, `name`, `number`, `position`) de cada convocado en el momento de crear el partido. Si después cambia el nombre, el dorsal o la posición del jugador, el partido histórico no cambia.
- `clock` = `{ period, running, baseMs, anchorWallMs }`. Tiempo = `baseMs + (Date.now() − anchorWallMs)` si está en marcha; `baseMs` si está parado.
- `scoreAdjustment` = `{ own, opponent }`: corrección manual del marcador, separada de los eventos.

## Eventos (fuente de verdad)

Campos comunes: `id`, `matchId`, `playerId` (null = **pendiente de atribución**), `period`, `matchTimeMs` (tiempo de partido al registrar), `createdAt`, `updatedAt`, `deletedAt`.

| `kind`              | Campos extra                                                 | Quién              |
| ------------------- | ------------------------------------------------------------ | ------------------ |
| `shot`              | `shotType`: `nine_m` `six_m` `penalty` `fast_break`; `result`: `goal` `out` `saved` | Cualquier convocado (porteros incluidos, p. ej. portería vacía) |
| `gk_shot`           | `shotType`: `nine_m` `six_m` `wing` `fast_break` `penalty`; `result`: `goal` `save` `out` | Portero |
| `turnover`          | `turnoverType`: `general` `steps` `double` `bad_pass`        | Cualquier convocado |
| `recovery`          | —                                                            | Cualquier convocado |
| `yellow`            | —                                                            | Cualquier convocado |
| `exclusion`         | — (2 minutos)                                                | Cualquier convocado |
| `red`               | — (roja **directa**; la roja por acumulación no es un evento, se deriva de la 3.ª exclusión) | Cualquier convocado |
| `free_throw`        | — (golpe franco cometido)                                    | Cualquier convocado |
| `penalty_committed` | — (penalti cometido en defensa)                              | Cualquier convocado |

Los tres «penaltis» son conceptos distintos y no se mezclan: `shot` + `penalty` (lanzado en ataque), `penalty_committed` (cometido en defensa) y `gk_shot` + `penalty` (recibido por nuestro portero).

Un evento de pasos/dobles/pase fallado es **un único evento** (`turnover` con su subtipo); el motor cuenta además la pérdida. No se guardan contadores.

## Operaciones sobre eventos

- **Registrar**: `recordEvent` (idempotente por id).
- **Corregir**: `updateEvent` sustituye el evento completo, conservando `id` y `createdAt`. Al cambiar de tipo de acción se eliminan los campos del tipo anterior.
- **Eliminar**: `deleteEvent` marca `deletedAt` (borrado lógico). Un evento borrado no cuenta en nada.
- **Deshacer**: anula la última acción **registrada** (mayor `createdAt`, no mayor minuto). Las marcas `createdAt` son estrictamente crecientes en la sesión para evitar empates.
- **Ajustar el reloj** no modifica `matchTimeMs` de los eventos ya registrados.
- **Descalificación**: se deriva de los eventos (`redCards`, `disqualifications`). El jugador descalificado no aparece en la selección rápida del registro, pero sigue en la convocatoria, la cronología y las estadísticas, y el editor permite atribuirle acciones olvidadas (marcado «descalificado»).

## Validación

- La acción debe pertenecer al catálogo (`assertValidPayload`).
- El jugador debe estar convocado. `gk_shot` (lanzamiento recibido) solo a porteros. `shot` (lanzamiento propio) a cualquier convocado: un gol de portero cuenta como lanzamiento ofensivo suyo y suma al marcador propio, nunca como lanzamiento recibido. Si al corregir se cambia a un tipo incompatible con el jugador, el editor deja la acción **sin asignar** (nunca se reasigna a otro jugador).
