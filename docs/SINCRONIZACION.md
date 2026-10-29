# Protocolo de sincronización (diseño)

Estado: **diseño**. El servidor ya implementa la subida de acciones y la descarga de cambios ([`server/src/sync.ts`](../server/src/sync.ts)). La aplicación no sincroniza todavía: el cliente es de la Tarea 005C.

## Principios

1. **IndexedDB sigue siendo la fuente inmediata.** Registrar una acción nunca espera a la red; sin conexión todo funciona como hoy.
2. **El servidor es la copia compartida.** Recibe las operaciones y las reparte a los demás dispositivos del equipo.
3. **Ningún cambio se sobrescribe en silencio.** Si dos dispositivos editan lo mismo, el segundo recibe un conflicto con la copia del servidor.
4. **Repetir es seguro.** Cualquier petición se puede reintentar sin duplicar nada.

## Cola local de operaciones (cliente, 005C)

Cada cambio local (alta, edición o borrado lógico de una acción, de un partido o de un jugador) añade una entrada a un almacén nuevo de IndexedDB, `outbox`:

```
{ opId, entity, entityId, teamId, baseVersion, createdAt, attempts }
```

- `opId`: UUID generado al encolar. Es lo que hace idempotente la operación.
- `baseVersion`: versión del servidor sobre la que se hizo el cambio (`null` si el registro es nuevo). Se guarda en otro almacén nuevo, `syncMeta { entity, entityId, version }`, para **no modificar** los registros actuales de `teams`, `players`, `matches` y `events`.
- La operación no copia el registro: al enviarla se lee su estado actual. Varias ediciones seguidas de la misma acción se pueden fusionar en una sola.
- Añadir `outbox` y `syncMeta` será la versión 2 de la base local: una migración solo aditiva, que no toca ni borra datos.

## Subida

Al recuperar la conexión, al volver a la app y periódicamente mientras hay pendientes:

1. Se envían las operaciones en orden de creación: equipo y jugadores → partido → acciones.
2. Respuestas:
   - `applied` o `duplicate`: se guarda la nueva versión en `syncMeta` y se borra la operación de `outbox`.
   - **409 `conflict`**: llega la copia del servidor. La operación queda marcada y la app muestra «cambio en conflicto», con las dos versiones. El usuario elige; por defecto se conserva la del servidor. Nunca se pisa sola.
   - **409 `match_recorded_elsewhere`**: otro dispositivo registra el partido. Hay que transferirlo (ver más abajo).
   - **401 o 403**: credencial revocada o permiso insuficiente. Se detiene la subida y se avisa. Los datos locales se conservan.
   - **422**: acción no válida. Error de programa: se registra y se deja aparte.
   - **Error de red o 5xx**: reintento con espera creciente. La operación sigue en `outbox`.
3. Si la conexión se corta a mitad, nada se pierde. Lo enviado y confirmado sale de la cola. Lo enviado sin respuesta se reenvía con el mismo `opId`, y el servidor devuelve el resultado que ya tenía.

En el servidor ([`applyEventOp`](../server/src/sync.ts)):

- Se valida el permiso, la pertenencia del partido al equipo y las reglas de la aplicación (`assertValidEvent`: catálogo, convocatoria, solo porteros en portería).
- La escritura, el registro de cambios y el registro de la operación van en **una transacción**. Si otro dispositivo cambió la acción entre la lectura y la escritura, la operación no se marca como aplicada y se responde conflicto (cubierto por pruebas).

## Descarga

- Cada dispositivo guarda, por equipo, el último `seq` recibido.
- `GET /api/teams/:id/changes?since=seq` devuelve los cambios posteriores, en orden y paginados (`hasMore`). De cada registro cambiado se envía su estado actual, una sola vez.
- El dispositivo aplica cada registro en IndexedDB con `put` por id (idempotente):
  - si tiene una operación pendiente sobre ese mismo registro, no lo pisa y lo resuelve como conflicto;
  - si no, guarda el registro y su versión en `syncMeta`.
- Los borrados llegan como registros con `deletedAt`: las estadísticas, que ya excluyen lo borrado, se recalculan solas.
- Los dispositivos de consulta solo descargan.

## Un partido, un dispositivo

- El primer dispositivo que sube una acción de un partido queda como `recorder_device_id`. Hoy el servidor lo asigna con la primera acción; en 005C se asignará al subir el partido.
- Los demás dispositivos reciben `409 match_recorded_elsewhere` si intentan escribir en ese partido. Pueden consultarlo.
- **Transferencia controlada** (005C), para cuando se agota la batería o hay un cambio de responsable:
  1. Un entrenador o administrador pide la transferencia (permiso `match.transfer`).
  2. El servidor cambia `recorder_device_id`.
  3. El dispositivo anterior, al sincronizar, ve que ya no registra ese partido. Sus operaciones pendientes de ese partido se muestran como conflicto para decidir, no se descartan.
- El cronómetro (`clock_json`) se sube con el partido para que el nuevo dispositivo continúe desde el mismo punto. El servidor no lo interpreta.

## Jugadores, partidos y descarga completa (005E.2A)

Mismo esquema que las acciones: `{ opId, teamId, baseVersion, player | match }`.

- **Orden de subida:** jugadores → partidos (con su convocatoria) → acciones. Un partido cuya convocatoria incluye un jugador que no está en el servidor responde **422 `unknown_player`**.
- **Idempotencia:** repetir la misma operación devuelve el mismo resultado; un alta repetida con otro `opId` y los mismos datos es `duplicate`. Los identificadores son los del dispositivo, así que subir dos veces no duplica nada.
- **Conflictos:** alta repetida con otros datos, o edición sobre una versión que ya no es la actual → **409 `conflict`** con la copia del servidor (`details.server`). Nada se sobrescribe.
- **Partido de un solo dispositivo:** quien sube el partido queda como registrador. Cualquier otro dispositivo recibe **409 `match_recorded_elsewhere`** al modificar el partido o sus acciones.
- **Escrituras simultáneas:** la escritura, la convocatoria, el registro de cambios y el de la operación van en una transacción, y solo se confirman si el registro quedó en la versión esperada y escrito por este dispositivo (`updated_by_device_id`, migración 0004).
- **Permisos:** la plantilla exige `roster.write` y el partido `match.write`; un dispositivo de consulta recibe **403**. El equipo declarado en el registro debe coincidir con el de la operación (422).
- **Datos que se conservan tal cual:** acciones a 00:00 (partidos registrados sin reloj), golpes francos sin jugador, `clock.firstHalfEndMs` (dentro de `clock_json`, del que solo se guardan los campos conocidos del cronómetro) y la marca `addsToPrevious` (columna `adds_to_previous`, migración 0004; solo en exclusiones y rojas de un jugador, si no **422**).
- **Descarga completa:** `GET /api/teams/:id/snapshot` (`team.read`) devuelve en una sola transacción el equipo, el club, los jugadores, los partidos con convocatoria y las acciones, con sus versiones, más `seq` para continuar con `changes`. Incluye partidos y acciones borrados (con `deletedAt`) para que el dispositivo los retire. De quién registra cada partido solo indica `recordedHere` para el propio dispositivo.

## Primera subida de datos existentes

No se fuerza. Cuando el usuario vincule un equipo local a un club (005C), la app subirá equipo, plantilla, partidos y acciones con sus identificadores actuales, como operaciones normales. Repetirla no duplica nada.

## Qué queda para 005C

- Cliente: `outbox`, `syncMeta`, subida, descarga e interfaz de conflictos.
- Servidor: datos del equipo (nombre, `publicName`) y transferencia de partido. Las operaciones de jugadores, partidos y convocatoria ya existen (005E.2A).
- Cambios simultáneos de un partido en el propio dispositivo: hoy cada cambio (cronómetro, marcador, finalizar…) guarda el partido completo a partir de la última copia en memoria, de modo que dos cambios casi simultáneos podrían pisarse. Al añadir la cola de operaciones, los cambios del partido deben aplicarse en orden sobre la versión guardada.
- Nombre en el marcador (`publicName` del equipo): hoy es solo local. Habrá que transportarlo o derivarlo del nombre del club, sin usarlo nunca como identificador.
- Golpes francos (005F): viajan como eventos `free_throw` con `player_id` nulo, que D1 ya admite; el servidor los valida con las mismas reglas compartidas, que siguen aceptando los antiguos asignados a un jugador. `clock.firstHalfEndMs` viaja dentro de `clock_json`. Ninguno de los dos requiere cambios en el servidor ni en D1.
- La marca `addsToPrevious` de exclusiones y rojas viaja en la columna `adds_to_previous` (migración 0004, pendiente de aplicar en D1). Hasta aplicarla no debe desplegarse el código que la usa.
