# Fórmulas estadísticas

Implementación: [`src/stats/engine.ts`](../src/stats/engine.ts). Pruebas: `src/stats/engine.test.ts`.

Todas las cifras se calculan a partir de los eventos **no borrados**. Un porcentaje sin denominador se muestra como «—» (sin datos), nunca como 0 %.

## Lanzamientos propios y equipo (ataque)

Se aplican a cualquier autor de un lanzamiento, también a un portero que marca (p. ej. a portería vacía).

| Métrica            | Fórmula                                       |
| ------------------ | --------------------------------------------- |
| Lanzamientos       | goles + fuera + parados                       |
| Fallos             | fuera + parados                               |
| Eficacia           | goles / lanzamientos × 100                    |
| Pérdidas (total)   | pérdida general + pasos + dobles + pase fallado |
| Sanciones          | amarillas + exclusiones + rojas               |

**Golpes francos en contra** (`freeThrows`) = número de acciones `free_throw` vivas del partido, o su suma en la temporada. Solo se muestran en el total del equipo («Disciplina y defensa»), nunca en fichas de jugador. No cambian marcador, goles, lanzamientos, pérdidas ni sanciones, y no cuentan como acciones pendientes de atribuir. Los **penaltis cometidos** también se muestran.

## Inferioridades del equipo

La **sanción individual** (evento `exclusion` o `red`, que cuenta en las estadísticas) es distinta del **periodo de inferioridad del equipo**, que se muestra bajo el cronómetro (`src/stats/exclusions.ts`). No se guarda ningún contador: se deriva de los eventos y del cronómetro.

| Sanción | Inferioridad |
| ------- | ------------ |
| Exclusión (también la 3.ª) | 2 min |
| 3.ª exclusión | La misma de 2 min, identificada como «Roja»: la roja por acumulación no abre otra |
| Roja directa | 2 min, identificada como «Roja» |
| Roja a un jugador ya descalificado | Ninguna propia (no suma otra roja) |
| Sanción marcada como **adicional antes de reanudar** (`addsToPrevious`) | No abre otra: suma 2 min a la inferioridad anterior del mismo jugador (4 min). Si la adicional es roja, la inferioridad se identifica como «Roja» |

- La marca de sanción adicional la pone el registrador, como opción secundaria, tocando la tarjeta de la inferioridad. Nunca se pregunta al registrar ni se deduce sola: dos exclusiones seguidas del mismo jugador, sin marcar, son dos inferioridades de 2 min en paralelo. Las sanciones sin jugador no se pueden sumar.
- Cumplido = tiempo del reloj − minuto de la sanción que abre la inferioridad, si son de la misma parte. Si es de la 1.ª parte y el reloj ya está en la 2.ª: (fin real de la 1.ª parte − minuto) + (reloj − inicio de la 2.ª). El fin real es `clock.firstHalfEndMs`; en partidos anteriores a este dato, el final nominal (30:00).
- Activa si 0 ≤ cumplido < duración. Al llegar a cero solo desaparece la tarjeta; las sanciones siguen en la cronología y en las estadísticas.
- Se cuenta desde el minuto registrado de la sanción, que coincide con la reanudación si el reloj se detiene en la interrupción (lo habitual). Si el reloj sigue en marcha durante la interrupción, la cuenta empieza unos segundos antes.
- Solo con el partido en juego o en el descanso (congelada); en un partido preparado o finalizado no hay cuenta atrás.
- Deshacer, eliminar o corregir una sanción actualiza la inferioridad al instante. Corregir el minuto conserva la marca; asignarla a otro jugador la quita.

## Tarjetas rojas y descalificación

Implementación: [`src/stats/discipline.ts`](../src/stats/discipline.ts). Las rojas **no** se cuentan evento a evento: se derivan recorriendo las acciones en orden de tiempo de partido.

- **Roja directa**: un evento `red`.
- **Roja por acumulación**: la **tercera** exclusión de un jugador en el partido. No existe como evento: es una consecuencia derivada.
- **Una sola descalificación por jugador y partido**: cuenta la que ocurre primero. Una roja registrada cuando el jugador ya estaba descalificado (p. ej. tras su 3.ª exclusión) no suma otra; una 4.ª exclusión tampoco.
- Rojas = rojas directas + rojas por acumulación (las dos cuentan como una tarjeta roja y se muestran desglosadas).
- Las rojas sin jugador asignado cuentan, cada una, en el equipo. Las exclusiones sin jugador no acumulan para nadie.
- La roja por acumulación cuenta en el intervalo de 5 minutos de la exclusión que la provoca.
- Corregir o borrar una exclusión recalcula todo: si el jugador deja de tener tres, pierde la roja y vuelve a estar disponible.
- Se aplica igual a jugadores de campo y porteros.

Por tipo de lanzamiento (9 m, 6 m, penalti, contraataque) se aplican las mismas fórmulas.

## Porteros

| Métrica                 | Fórmula                                      |
| ----------------------- | -------------------------------------------- |
| Lanzamientos recibidos  | goles + paradas + fuera                      |
| Entre los tres palos    | paradas + goles                              |
| % paradas               | paradas / (paradas + goles) × 100            |

Los lanzamientos **fuera** cuentan como recibidos pero **no** entran en el % de paradas. Mismo cálculo por procedencia (9 m, 6 m, extremo, contraataque, penalti).

**Eficacia de portería** (indicador circular del equipo, junto a la eficacia ofensiva) = el mismo % de paradas, calculado sobre todos los lanzamientos recibidos por el equipo (incluidos los pendientes de atribución), una sola vez por acción. En la temporada se suman paradas y goles de todos los partidos y se calcula al final. Sin tiros a puerta registrados se muestra «—», no 0 %.

## Marcador

- Propio = goles de `shot` (incluidos los pendientes de atribución) + `scoreAdjustment.own`.
- Rival = goles de `gk_shot` (incluidos pendientes) + `scoreAdjustment.opponent`.
- Nunca inferior a 0.
- **Resultado** de un partido finalizado: victoria si propio > rival, derrota si propio < rival y empate si son iguales, con el marcador ya corregido. Propio y rival son siempre nuestros goles y los del rival, juguemos de local o de visitante; no se compara el lado izquierdo con el derecho del marcador.
- La corrección manual solo cambia el marcador. **No** cambia goles, lanzamientos ni eficacias de nadie, y la pantalla muestra siempre cuánto viene de acciones y cuánto de corrección.

## Acciones pendientes de atribución

Cuentan en los totales del equipo, en el marcador y en los intervalos, pero en ningún jugador.

## Intervalos de 5 minutos

Con partes de 30 min hay 12 tramos (5', 10', … 60'). Un evento se asigna según su parte y su tiempo: `floor((t − inicioParte) / 5 min)`. El tiempo añadido de una parte (p. ej. 31:00 en la 1.ª) cae en su **último** tramo, nunca en la parte siguiente. GF/GC por tramo son goles con acción (sin correcciones manuales).

## Temporada

- Se suman los **contadores** de todos los partidos de la temporada y los porcentajes se calculan después sobre los totales. Ejemplo: 1/1 en un partido y 1/3 en otro = 2/4 = **50 %** (no la media 66,7 %).
- «Partidos» de un jugador = partidos en cuya convocatoria figura (no minutos jugados, que no se registran).
- Goles a favor/en contra de la temporada sí incluyen las correcciones manuales del marcador.
- Cuentan los partidos que se han iniciado o tienen acciones (un partido creado pero nunca empezado no cuenta). Filtro opcional «Solo finalizados».
- Medias por partido = total / partidos.

## Rankings

Cada ranking lee una cifra del acumulado de temporada (mismos partidos que la pestaña Temporada, sin el filtro «Solo finalizados»). No hay fórmulas nuevas. Código: `src/stats/rankings.ts`.

| Ranking | Cifra | Entra quien… |
| ------- | ----- | ------------ |
| El pistolero | goles | tiene al menos 1 gol |
| El francotirador | eficacia = goles / lanzamientos | tiene al menos **10 lanzamientos** |
| El muro | % paradas = paradas / (paradas + goles encajados); los fuera no cuentan | tiene al menos **20 tiros a puerta** (paradas + goles encajados) |
| El ladrón | recuperaciones | tiene al menos 1 |
| El reincidente | exclusiones de 2 minutos (la 3.ª cuenta; la roja por acumulación no suma otra) | tiene al menos 1 |
| El generoso | pérdidas totales (incluye pasos, dobles y pases fallados) | tiene al menos 1 |
| Más lanzamientos | goles + fuera + parados | tiene al menos 1 |

- Orden de mayor a menor. Los empatados comparten puesto y el siguiente salta (1, 1, 3). Dentro de un empate se presentan por dorsal.
- Los porcentajes se comparan redondeados a un decimal, como se muestran: dos «66,7 %» empatan.
- Se muestran como máximo 10 jugadores, contando al líder. El líder (o los empatados en el primer puesto) aparece solo en la tarjeta destacada; la lista empieza por el siguiente clasificado con su puesto real. Si en el último puesto visible hay más empatados de los que caben, se indica cuántos quedan fuera.
- Los mínimos están en `RANKING_THRESHOLDS` y se muestran en la pantalla.
- Solo cuentan acciones atribuidas a un jugador. Los partidos eliminados y las acciones borradas no cuentan.
- Nombre y dorsal: los de la convocatoria más reciente del jugador en esa temporada.

## Lo que NO se calcula

Minutos jugados, tiempo en pista, +/−, ni ninguna métrica que no se pueda derivar de los eventos registrados.
