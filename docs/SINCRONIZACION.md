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
   - **409 `match_recorded_elsewhere`**: el partido está en curso y lo registra otro dispositivo. Hay que tomar el control (ver más abajo).
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

## Control de los partidos entre entrenadores (005E.2H1)

Código: [`server/src/control.ts`](../server/src/control.ts) y migración `0005_match_control.sql`.

- **Un partido en curso o en el descanso lo registra un solo dispositivo:** el que tiene su control (`control_device_id`). Los demás reciben **409 `match_recorded_elsewhere`** al escribir en él (partido, convocatoria, cronómetro, acciones o borrado) y pueden consultarlo.
- **Los preparados y los finalizados no tienen dueño:** cualquier entrenador del equipo los corrige con la versión base correcta; dos correcciones sobre la misma versión dan conflicto y nunca se pisan.
- **Tomar el control sin pedirlo:** quien escribe en un partido activo que no tiene control (al iniciarlo, al reanudar uno finalizado o si el anterior ya no está autorizado) lo toma. Al finalizar o eliminar el partido se libera.
- **Tomar el control de otro:** `POST /api/sync/control` `{ opId, teamId, matchId, expectedEpoch }`, con permiso `match.transfer` (entrenador del equipo) y desde un dispositivo. `expectedEpoch` es el contador de control que ha visto el dispositivo (en la descarga: `matches[].control.epoch`).
  - Atómica: solo se aplica si el contador sigue siendo el esperado. Si dos piden a la vez, uno lo consigue y el otro recibe **409 `control_changed`** con el estado nuevo (sin identificar dispositivos).
  - Si el partido ya no está en curso: **409 `match_not_active`**.
  - Idempotente por `opId`: un reintento no hace una segunda transferencia.
  - El contenido del partido y su versión no cambian. Queda en `match_control_log` (auditoría interna) y en `change_log`, para que los demás dispositivos lo vean.
- **El dispositivo anterior pierde el permiso al instante:** la condición de control va dentro de cada sentencia que escribe, así que una escritura suya que llegue durante o después de la transferencia no se aplica. Sus cambios sin enviar siguen en su dispositivo; la versión actual de la aplicación detiene el envío automático con el aviso «Otro dispositivo registra este partido» y los conserva como pendientes.
- **Dispositivos revocados:** no retienen el control. Solo cuenta si el dispositivo sigue vigente y conserva el permiso de entrenador que tenía al tomarlo: si se le retira y vuelve a canjear un código, no lo recupera por ello. Cerrar la sesión o dejar el equipo lo libera en la misma transacción.
- **La descarga** indica por partido `control: { holder: 'here' | 'other' | null, epoch, seenAt }`, sin identificadores de dispositivos. `recordedHere` se mantiene por compatibilidad (quién lo subió).
- `recorder_device_id` se conserva como dato histórico; ya no bloquea nada.
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

## Sesión del dispositivo en la PWA (005E.2C)

- Código: `src/remote/` (`api.ts` cliente HTTP; `store.ts` almacén; `session.ts` lógica) y la instancia en `src/app/remote.ts`.
- **Almacén propio:** IndexedDB `galipaustats-cuenta` (versión 1, almacén `account` con `device` y `teams`). La base de equipos y partidos (`galipaustats`, versión 1) no cambia y ningún código de esta parte la abre.
- **Token:** se guarda solo en ese almacén y solo viaja en `Authorization`. No aparece en URLs, en el estado de la interfaz, en `localStorage`, en mensajes de error ni en registros. Las peticiones van sin cookies (`credentials: 'omit'`).
- **Canje:** el código se normaliza como en el servidor y se comprueba su longitud antes de enviarlo. No se reintenta solo (un canje repetido sin respuesta podría crear otro dispositivo). Si la credencial guardada ya no vale, se olvida y se canjea como dispositivo nuevo, una sola vez.
- **Comprobación** (`GET /api/session`): al abrir la app y al recuperar la conexión, con dos reintentos ante fallos de red o del servidor. Sin conexión se muestran los últimos equipos conocidos y su hora. Con **401** la credencial se olvida y se avisa («sesión no válida»); los datos locales no se tocan.
- Esta fase **no** sube ni descarga jugadores, partidos ni acciones, y no vincula equipos locales con equipos del club.

## Vinculación y envío manual (005E.2D)

Código: `src/remote/plan.ts` (qué se envía y validación previa), `upload.ts` (envío y comprobación), `clubsync.ts` (vínculos y permisos) y la tarjeta «Servidor del club» de la pantalla del equipo.

- **Vínculo explícito:** un equipo local se vincula con un equipo del club elegido por el usuario y confirmado en un segundo paso. Nunca automáticamente, aunque coincidan nombre o código. Solo con permiso de entrenador vigente. Un equipo local tiene como mucho un vínculo y un equipo del club, como mucho un equipo local (índice único). Se puede deshacer solo mientras no se haya enviado nada.
- **Dónde se guarda:** en `galipaustats-cuenta` (versión 2, solo añade los almacenes `links`, `syncMeta` y `uploads`). La base `galipaustats` no cambia: los registros se envían como copias con el identificador del equipo del club; los ids de jugadores, partidos y acciones son los mismos.
- **Previsualización:** origen y destino, jugadores (e inactivos), partidos, convocatorias, acciones (borradas, pendientes, golpes francos, sanciones adicionales) y correcciones de marcador. Se comprueban antes las mismas reglas que el servidor; si alguna falla, se muestra la lista y no se ofrece enviar. Nada se transforma.
- **Partidos eliminados en el dispositivo:** no se envían (el servidor no admite acciones de un partido eliminado). Se indican en la previsualización y siguen guardados en el dispositivo.
- **Envío:** solo con el botón «Enviar al servidor»; el primero pide confirmación. Orden: jugadores → partidos con convocatoria → acciones (también las borradas, con su marca).
  - Cada operación lleva un `opId` derivado del dispositivo, el registro, la versión base y el contenido: un reintento es la misma operación. Lo confirmado se anota en `syncMeta` (versión y huella); lo que no ha cambiado no se vuelve a enviar.
  - Fallos de red: dos reintentos por operación; si persiste, el envío se detiene («interrumpido») y el siguiente continúa donde se quedó.
  - 401, 403, 409 (conflicto, otro dispositivo, dorsal) y 422: el envío se **detiene** con el motivo. Nunca se sobrescribe ni se fuerza nada.
  - Un solo envío a la vez por equipo del club (bloqueo en memoria y, si el navegador lo permite, también entre pestañas).
- **Comprobación:** al terminar se descarga el equipo completo y se compara con lo enviado: jugadores, partidos (con convocatoria y cronómetro), acciones por partido (también las borradas), resultados, estadísticas acumuladas y versiones. Solo si todo coincide se muestra «Sincronización completada»; si no, se listan las diferencias. El historial (`uploads`) guarda el resultado sin tokens ni datos personales.
- **No se descarga nada** sobre la base del dispositivo que registra. Los envíos siguen siendo manuales: la estructura (`syncMeta`) ya permite envíos incrementales futuros.

## Envío automático (005E.2F)

Código: `src/remote/autosync.ts`, `src/app/observableRepository.ts` y el indicador `src/ui/match/SyncIndicator.tsx`.

- **Cuándo:** solo en equipos vinculados en los que se ha activado expresamente «Envío automático de los cambios» en la tarjeta «Servidor del club», con sesión y permiso de entrenador vigente, y sin un aviso pendiente. El envío manual sigue disponible siempre.
- **Desactivado por defecto**, también en los equipos vinculados antes de esta versión. La preferencia es de cada equipo en cada dispositivo (campo `auto` del vínculo en `galipaustats-cuenta`) y se recuerda al cerrar y reabrir. Al activarlo, la app cuenta lo pendiente sin hacer ninguna petición: si hay algo, muestra el resumen (jugadores, partidos, acciones y partidos eliminados) y pide confirmar con «Activar y enviar»; si no hay nada, se activa sin más. Una vez activado no vuelve a preguntar.
- **Desactivar** detiene los envíos automáticos nuevos; un envío ya en curso termina, y lo pendiente se conserva para «Enviar al servidor» o para cuando se vuelva a activar.
- **Qué lo dispara:** el repositorio de la app avisa DESPUÉS de guardar cualquier jugador, partido o acción (registrar, corregir, deshacer, borrar, cronómetro, convocatoria, corrección de marcador). El registro no espera por el envío.
- **Agrupación:** se envía cuando pasan 3 s sin cambios, y como mucho 15 s después del primero pendiente. Cada tanda envía solo lo que ha cambiado (huellas en `syncMeta`): lo ya enviado, como los partidos históricos, no se repite y comprobar pendientes no hace ninguna petición. No descarga el equipo en cada tanda; la comprobación completa sigue en el envío manual.
- **Cronómetro:** se guarda como estado con referencia de reloj, no como contador; solo hay envío cuando cambia ese estado (iniciar, pausar, ajustar, descanso, 2.ª parte), nunca por el paso del tiempo.
- **Partidos eliminados** que ya estaban en el servidor: antes de borrar, la confirmación avisa de que el partido dejará de aparecer en los móviles de consulta cuando actualicen, y de si se enviará solo o con «Enviar al servidor». Cancelar no borra nada. Al confirmar, el partido se elimina de forma lógica en el dispositivo y se envía su marca de borrado (sin tocar sus acciones, ni aquí ni en el servidor). Si el envío falla, el borrado queda pendiente y no se da por hecho en el club. Los partidos nunca enviados se eliminan como siempre y no se envía nada.
- **Sin conexión:** los cambios siguen en el dispositivo; se reintenta con esperas crecientes (15 s → 5 min), al recuperar la conexión y al volver a la app. Con la app cerrada no se envía nada: al volver a abrirla se mira si quedaba algo pendiente.
- **Conflictos, rechazos o falta de permiso:** se detiene el envío automático de ese equipo («Requiere atención») y se guarda el motivo; no se reanuda solo, ni tras reabrir. Un envío manual que termine con «Sincronización completada» lo reanuda. Nunca se sobrescribe nada.
- **Exclusión mutua:** el envío automático y el manual comparten el mismo bloqueo; si coinciden, el automático espera y vuelve a intentarlo.
- **Estado:** un icono en la cabecera del partido (sin botón) y una línea en el menú del partido y en la ficha del equipo: «Sincronizado», «Pendiente», «Sin conexión» o «Requiere atención».

## Copia de un equipo del club en otro dispositivo (005E.2H2A)

Código: [`src/remote/importer.ts`](../src/remote/importer.ts); interfaz en «Equipos del club» y en la ficha del equipo.

- **Quién:** solo un dispositivo con permiso de entrenador vigente en el equipo (y club activo). Con código de consulta no se ofrece y se rechaza.
- **«Trabajar con este equipo aquí»** descarga el equipo completo y crea un equipo local con **los mismos identificadores** de jugadores, partidos y acciones (también los partidos eliminados, las acciones anuladas y las sanciones adicionales). Las estadísticas se calculan con las funciones de siempre.
- **Sin pendientes ni reenvíos:** se anotan en `syncMeta` la versión y la huella de cada registro (las mismas funciones que el envío), y el vínculo guarda el cursor (`seq`) para descargas futuras. El envío automático queda desactivado.
- **Nunca se duplica ni se fusiona:**
  - si el equipo del club ya está vinculado con un equipo del dispositivo (p. ej. el del registrador original), se muestra «Vinculado con un equipo de este dispositivo» y no se importa;
  - si el dispositivo tiene un equipo sin vincular con el mismo código, o registros con los mismos identificadores (p. ej. una copia de seguridad restaurada), se detiene sin escribir nada y se explica;
  - repetir la importación no hace nada (ni siquiera vuelve a descargar).
- **Atomicidad:** primero se registra el vínculo como pendiente con sus versiones (una transacción en `galipaustats-cuenta`); después se escriben todos los datos del equipo (una transacción en `galipaustats`, con `add`: si algún registro ya existe, no se escribe nada); al final se marca terminado. Si falla el guardado, se retira el vínculo. Si la aplicación se cierra a mitad, queda «Importación sin terminar», de solo lectura, para reanudar o descartar: nunca un equipo a medias a la vista ni un equipo sin vincular.
- **Solo lectura (hasta la sincronización en los dos sentidos, H2B):** el repositorio rechaza cualquier escritura en la copia (`ReadOnlyTeamError`), venga de la pantalla que venga; el envío manual y el automático se niegan. La interfaz oculta crear partidos, editar el equipo y la plantilla, y los partidos se abren solo con sus estadísticas.
- **«Actualizar copia»** descarga de nuevo el equipo y lo pone al día, solo si la copia no tiene cambios propios (cada registro coincide con lo anotado o con lo que hay en el club); si los tuviera, no se sobrescribe nada. Al abrir la ficha se comprueba con una consulta ligera (`/changes`) si hay cambios en el club.
- **Acceso retirado:** tras una comprobación correcta de la sesión sin permiso de entrenador en ese equipo (o sin sesión), la copia se retira del dispositivo, igual que lo descargado para consulta. Sin conexión no se retira nada. Nunca se retira un equipo propio del dispositivo.
- **«Quitar la copia de este dispositivo»** la borra (primero los datos, después el vínculo y sus versiones). En el club no cambia nada.
- **Regla para cuando la copia sea editable (H2B, aún no implementada):** una retirada del acceso **nunca** podrá destruir automáticamente cambios locales pendientes de enviar. El servidor ya rechaza cualquier operación sin permiso (H1); en el dispositivo, la copia con cambios pendientes se conservará bloqueada (sin edición ni envío) y marcada como sin acceso, para recuperarla con autorización (volver a tener permiso, exportar una copia de seguridad o descartarla expresamente). El diseño actual lo permite sin cambios estructurales: el único borrado automático es la retirada por sesión (`TeamImporter.retireExcept`), que solo actúa sobre copias importadas y hoy solo existen de solo lectura; en H2B bastará con que no retire las copias editables con pendientes y las marque como sin acceso.

## Consulta desde otros móviles (005E.2E)

Código: `src/remote/viewer.ts` y las pantallas `RemoteTeamScreen` y `RemoteViews` (partido y rankings).

- **Solo lectura para cualquier rol**, también entrenador: la consulta únicamente hace `GET /api/teams/:id/snapshot`. No hay registro, cronología editable, corrección, finalización ni eliminación. La escritura sigue siendo del dispositivo registrador con su flujo de envío.
- **Base propia:** lo descargado se guarda en IndexedDB `galipaustats-consulta` (almacén `teams`, un registro por equipo con el equipo completo y la fecha de descarga). No se mezcla con `galipaustats` ni con `galipaustats-cuenta`, y la copia de seguridad JSON no lo incluye.
- **Mismas pantallas y cálculos** que los equipos del dispositivo: lista de partidos con resultado oficial (con correcciones), estadísticas del partido (equipo, jugadores, porteros), temporada y los siete rankings. `SeasonView` y `RankingsView` son compartidos; solo cambia de dónde salen los datos.
- **Actualización en directo (005E.2G):** cada consulta pide solo los cambios posteriores a lo descargado (`GET /api/teams/:id/changes?since=seq`; código en `src/remote/live.ts` y `ClubViewer.poll`). Sin cambios, la respuesta está vacía y no se descarga nada. Si solo han cambiado acciones, se aplican sobre lo descargado; si ha cambiado un partido o un jugador (cronómetro, corrección de marcador, finalización, borrado…) o hay más de 500 cambios, se descarga el equipo completo. La primera vez (sin datos guardados) se descarga el equipo completo.
- **Cuándo se consulta:** una vez al abrir una pantalla de consulta (equipo, partido, rankings) y al volver a la app o recuperar la conexión. Solo si el equipo tiene un partido en curso o en el descanso se sigue consultando cada 5 s, mientras la pantalla esté abierta y la app visible. Sin partidos en curso no queda ningún temporizador: un partido nuevo se descubre al volver a entrar o con «Actualizar» (no hay consultas permanentes para buscarlo).
- **Fin del partido:** cuando una consulta trae la finalización del último partido en curso, se muestran sus datos definitivos y se hacen 3 consultas de cierre (unos 15 s), porque el registrador envía el partido antes que sus acciones y las últimas pueden llegar justo después; después se para. Las correcciones posteriores se ven al volver a entrar o con «Actualizar».
- **Límite de 2 h** de seguimiento continuo (desde que empieza a seguirse un partido; los goles, las actualizaciones y los cambios de pantalla no lo reinician): se pausa con el aviso «Actualización automática pausada» y el botón «Reanudar directo». Volver a la app no lo reanuda. Al reanudar se comprueba el estado y solo se sigue si hay un partido en curso. Evita que un partido olvidado en curso consulte toda la noche.
- **Se conserva la navegación:** los datos nuevos sustituyen a los mostrados sin recargar la pantalla; la pestaña, el partido, el ranking y la ficha de jugador abiertos siguen igual, y la ficha muestra los valores nuevos.
- **Una consulta a la vez** por equipo y dispositivo: «Actualizar» espera a que termine la que esté en curso. Una respuesta anterior a los datos ya mostrados se descarta. Una petición hecha antes de retirar los datos de un equipo (acceso revocado, «Salir de este equipo» o sesión cerrada) puede terminar, pero nunca vuelve a guardarlos ni a mostrarlos, aunque su respuesta llegue tarde o estuviera en cola; al cerrar la sesión también se retiran los equipos que solo estaban en memoria o con una descarga en curso.
- **Estado:** «En directo · actualizado a las HH:MM:SS» solo con un partido en curso y si la última consulta confirmó con el servidor que los datos están al día; sin partidos en curso, solo la hora de los últimos datos; «Actualizando…» al abrir o al volver a la app; «Actualización automática pausada» tras el límite de 2 h (distinto de los errores de conexión); «Sin conexión» y «Datos desactualizados» (más de 30 s sin poder actualizar) con la hora de los últimos datos recibidos. Tras un error, mientras se sigue un partido, esperas crecientes (5 s → 1 min), sin ráfagas de reintentos; sin partido en curso no se reintenta solo. Una respuesta que llega después de cerrar la pantalla o de pausar no vuelve a programar consultas.
- **«Actualizar»** descarga el equipo completo en cualquier momento (y, si hay un partido en curso, empieza a seguirlo). No reanuda una pausa por tiempo.
- **El registrador no cambia:** el envío automático (005E.2F) sigue enviando la finalización, lo pendiente tras perder la conexión y las correcciones posteriores al partido, y no hace peticiones si no hay cambios.
- **Sin conexión o con el servidor caído:** se siguen mostrando los últimos datos descargados con su fecha y el aviso de que pueden estar desactualizados.
- **Acceso retirado:** si el servidor responde 403 o 404 al descargar o consultar cambios, o si una comprobación correcta de la sesión ya no incluye el equipo, se borran sus datos descargados. Con 401, o sin sesión (cerrada o revocada), se borran todos y se comprueba la sesión. Sin conexión no se borra nada: la retirada aún no se ha podido verificar. Tras una retirada confirmada se deja de consultar.

## Primera subida de datos existentes

No se fuerza. Cuando el usuario vincule un equipo local a un club (005C), la app subirá equipo, plantilla, partidos y acciones con sus identificadores actuales, como operaciones normales. Repetirla no duplica nada.

## Qué queda para 005C

- Cliente: `outbox`, `syncMeta`, subida, descarga e interfaz de conflictos.
- Servidor: datos del equipo (nombre, `publicName`) y transferencia de partido. Las operaciones de jugadores, partidos y convocatoria ya existen (005E.2A).
- Cambios simultáneos de un partido en el propio dispositivo: hoy cada cambio (cronómetro, marcador, finalizar…) guarda el partido completo a partir de la última copia en memoria, de modo que dos cambios casi simultáneos podrían pisarse. Al añadir la cola de operaciones, los cambios del partido deben aplicarse en orden sobre la versión guardada.
- Nombre en el marcador (`publicName` del equipo): hoy es solo local. Habrá que transportarlo o derivarlo del nombre del club, sin usarlo nunca como identificador.
- Golpes francos (005F): viajan como eventos `free_throw` con `player_id` nulo, que D1 ya admite; el servidor los valida con las mismas reglas compartidas, que siguen aceptando los antiguos asignados a un jugador. `clock.firstHalfEndMs` viaja dentro de `clock_json`. Ninguno de los dos requiere cambios en el servidor ni en D1.
- La marca `addsToPrevious` de exclusiones y rojas viaja en la columna `adds_to_previous` (migración 0004, pendiente de aplicar en D1). Hasta aplicarla no debe desplegarse el código que la usa.
